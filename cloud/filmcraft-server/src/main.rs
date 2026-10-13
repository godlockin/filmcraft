//! FilmCraft server — headless HTTP entry point.
//!
//! M1.3 wires the engine to an `OssServices` (an `engine::Services`
//! implementation) so that swapping the local filesystem for Aliyun OSS in
//! M1.3b is a single-field change. We also expose a tiny store-probe endpoint
//! (`GET /api/v1/store/{path}` and `PUT /api/v1/store/{path}`) so that the
//! engine path can be exercised end-to-end without dragging the rest of the
//! web UI in yet. See `docs/filmcraft-server.md` for the plan.
//!
//! M1.5 adds a WebSocket bridge (`GET /api/v1/ws`) that carries the headless
//! control protocol (engine.* / perf.*) over a JSON-lines channel.
//!
//! M1.6 adds project-aware media and project-file endpoints:
//!   - `POST/GET /api/v1/projects/{project_id}/media` — upload / list
//!   - `GET  /api/v1/projects/{project_id}/export` — export metadata
//!   - `GET  /api/v1/projects/{project_id}/export.fcproj` — current project
//!
//! M2.10 adds telemetry: an HTTP `X-Request-Id` middleware (the id is also
//! stamped on the response), and a `tracing`-compatible JSONL sink so
//! per-request events are written to a rotated file for ops. WebSocket
//! sessions get their own request id pinned to the task-local for the
//! whole socket lifetime.
//!
//! Rules (AGENTS.md §0):
//!   - No `unwrap`/`expect`/`panic!`/`todo!`/`unsafe` outside tests.
//!   - Bind to 127.0.0.1 by default; env override is parsed, not trusted.

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, OnceLock};

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::http::header::CONTENT_TYPE;
use axum::middleware::{Next, from_fn};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, delete, get, post};
use filmcraft_engine::Services;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use filmcraft_server::{OssServices, ProjectKey, Result, ServerError, UserId, map_store_io_error, request_id_layer};

/// Placeholder user identity used by every handler until M2 wires real
/// authentication. Centralised here so the M2 change touches one line.
const ANONYMOUS_USER_ID: &str = "anonymous";

fn anonymous_user() -> UserId {
    UserId::new(ANONYMOUS_USER_ID)
}

/// Default listen address when `FILMCRAFT_LISTEN_ADDR` is unset. Loopback only
/// matches `AGENTS.md` §0 ("never expose to the public internet by default").
const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:8080";

/// Default root for `OssServices` in M1.3a. The `OssServices` in M1.3b will
/// read `FILMCRAFT_OSS_*` env vars and use the OSS bucket instead.
const DEFAULT_STORE_ROOT: &str = "./data/store";

/// Build-version string baked into the root payload. We use the workspace
/// version (also the binary version); in a release build it matches the tag.
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Static description of the API surface, built once. Kept as a `Value` so
/// `api_doc_handler` can hand it back without re-allocating on every request.
///
/// Note: there is no entry for `/`. Since M1.7's SPA fallback, `/` is owned
/// by the React UI (`apps/filmcraft-web-ui/dist/index.html`); the API doc
/// itself lives at `/api/v1`.
fn endpoints_payload() -> &'static serde_json::Value {
    static ENDPOINTS: OnceLock<serde_json::Value> = OnceLock::new();
    ENDPOINTS.get_or_init(|| {
        json!({
            "root":   { "method": "GET",  "path": "/api/v1",            "description": "this payload" },
            "health": { "method": "GET",  "path": "/api/v1/health",     "description": "liveness probe (200 = alive)" },
            "store":  { "method": "GET",  "path": "/api/v1/store/{key}", "description": "read a key from the object store (proof that OssServices is wired)" },
            "store_put": { "method": "PUT", "path": "/api/v1/store/{key}", "description": "write a key to the object store" },
            "ws": { "method": "GET", "path": "/api/v1/ws", "description": "WebSocket upgrade carrying the headless control protocol" },
            "projects_list":   { "method": "GET",    "path": "/api/v1/projects", "description": "list the current user's projects (M1.7)" },
            "projects_create": { "method": "POST",   "path": "/api/v1/projects", "description": "create a new project (M1.7)" },
            "projects_delete": { "method": "DELETE", "path": "/api/v1/projects/{project_id}", "description": "remove a project and all of its media (M1.7)" },
            "media_stream":    { "method": "GET",    "path": "/api/v1/projects/{project_id}/media/{filename}", "description": "stream a project's media file with Range support (M1.7)" },
            "project_media_upload": { "method": "POST", "path": "/api/v1/projects/{project_id}/media", "description": "upload a media file (X-Filename header, up to 200 MiB)" },
            "project_media_list":   { "method": "GET",  "path": "/api/v1/projects/{project_id}/media", "description": "list media files in the project" },
            "project_export_info":  { "method": "GET",  "path": "/api/v1/projects/{project_id}/export", "description": "export metadata + download URL (M1.6 returns the .fcproj; M1.11 will return the rendered mp4)" },
            "project_export_file":  { "method": "GET",  "path": "/api/v1/projects/{project_id}/export.fcproj", "description": "download the current project file as an attachment" },
            "project_fcproj":       { "method": "GET",  "path": "/api/v1/projects/{project_id}/fcproj", "description": "raw `.fcproj` bytes without Content-Disposition (for in-process clients; M2.1)" },
            // Project versioning (M2.9). The lock/save/unlock triplet is
            // the round-trip from a local `.fcproj` described in
            // `docs/filmcraft-server.md` §2.3; `history` is the
            // append-only revision log.
            "project_lock":    { "method": "POST", "path": "/api/v1/projects/{project_id}/lock",              "description": "take the write lock; body / X-FilmCraft-Lock-Token: {locker}; returns 400 if another writer holds it" },
            "project_unlock":  { "method": "POST", "path": "/api/v1/projects/{project_id}/unlock",            "description": "release the write lock; 204 whether or not a lock was held" },
            "project_save":    { "method": "POST", "path": "/api/v1/projects/{project_id}/save",              "description": "commit a new revision; body is the raw .fcproj bytes, headers X-FilmCraft-Lock-Token + X-FilmCraft-Expected-Rev" },
            "project_history": { "method": "GET",  "path": "/api/v1/projects/{project_id}/history",           "description": "list every saved revision as [{rev, size}], oldest first" },
            "project_history_get": { "method": "GET",  "path": "/api/v1/projects/{project_id}/history/{rev}", "description": "read a specific revision body as raw .fcproj bytes" },
        })
    })
}

#[derive(Clone)]
struct AppState {
    started_at: std::time::Instant,
    services: Arc<OssServices>,
    sessions: Arc<filmcraft_server::SessionManager>,
    api_state: filmcraft_server::api::ApiState,
    /// M2.6: the auth backend. The HTTP layer resolves bearer tokens
    /// against it via `auth_layer`. Production wires up
    /// `HardcodedAuthStore`; tests wire up their own (so a "missing
    /// token" path is exercised independently of the admin password).
    auth: Arc<dyn filmcraft_server::auth::AuthStore>,
}

impl axum::extract::FromRef<AppState> for filmcraft_server::api::ApiState {
    fn from_ref(s: &AppState) -> Self {
        s.api_state.clone()
    }
}

// M2.6: bridge `Arc<dyn AuthStore>` out of `AppState` so the auth
// handlers can declare `State<Arc<dyn AuthStore>>` exactly the way they
// would when the router was parameterised on the auth store directly.
impl axum::extract::FromRef<AppState> for Arc<dyn filmcraft_server::auth::AuthStore> {
    fn from_ref(s: &AppState) -> Self {
        Arc::clone(&s.auth)
    }
}

#[derive(Serialize)]
struct RootPayload {
    status: &'static str,
    version: &'static str,
    /// Seconds since the process started (uptime).
    uptime_secs: u64,
    endpoints: serde_json::Value,
}

#[tokio::main]
async fn main() -> ExitCode {
    if let Err(code) = try_main().await {
        tracing::error!("server exited with error: {code}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

async fn try_main() -> Result<()> {
    init_tracing();

    let listen_addr = resolve_listen_addr()?;
    let store_root = resolve_store_root()?;
    let services = Arc::new(OssServices::new(store_root));
    let sessions = Arc::new(filmcraft_server::SessionManager::new(Arc::clone(&services)));
    let user_id = anonymous_user();
    let api_state = filmcraft_server::api::ApiState::new(Arc::clone(&services), user_id);
    // M2.6: hardcoded admin auth (admin / 123456 by default; override
    // with `FILMCRAFT_ADMIN_PASSWORD`). Upgrade path: swap
    // `HardcodedAuthStore::shared(...)` for `DbAuthStore::shared(...)`
    // (or similar) when a real user table lands — the trait object
    // here is the only line that changes.
    let auth = filmcraft_server::auth::HardcodedAuthStore::shared(filmcraft_server::auth::resolve_admin_password());
    let state = AppState { started_at: std::time::Instant::now(), services, sessions, api_state, auth };

    let web_ui_dir = resolve_web_ui_dir();

    // Static web UI (M1.7). Served as the router's `fallback_service` so it
    // only catches paths the API did not match. `FILMCRAFT_WEB_UI_DIR`
    // points at a built `apps/filmcraft-web-ui/dist`; when unset we reply
    // 404 with a hint so the developer knows to build the UI.
    //
    // We avoid `ServeDir` here because wiring it through `axum::routing`
    // requires extra ceremony in 0.8; instead we read the file off disk
    // ourselves with a small handler. The amount of code is comparable
    // and the behaviour is exactly what we need (no directory listings,
    // file extension drives the content type, missing files become the
    // `index.html` so React Router deep links still work).
    let fallback: MethodRouter = match web_ui_dir.and_then(load_web_ui) {
        Some(ui) => {
            let ui = Arc::clone(&ui);
            axum::routing::any(move |req: axum::extract::Request| {
                let ui = Arc::clone(&ui);
                async move { serve_static_fallback(ui, req).await }
            })
        }
        None => axum::routing::any(not_found_handler),
    };

    let app = Router::new()
        // `/` is intentionally un-routed: see `endpoints_payload()` for why
        // (SPA fallback serves `index.html` for the React UI).
        .route("/api/v1", get(api_doc_handler))
        .route("/api/v1/health", get(health_handler))
        // M2.6: auth surface. `/auth/login` is public (it's where you
        // GET the token); `/auth/me` and `/auth/logout` are protected.
        .route("/api/v1/auth/login", post(filmcraft_server::auth::login_handler))
        .route("/api/v1/auth/me", get(filmcraft_server::auth::me_handler))
        .route("/api/v1/auth/logout", post(filmcraft_server::auth::logout_handler))
        .route("/api/v1/store/{*key}", get(store_get).put(store_put))
        .route("/api/v1/ws", get(ws_upgrade))
        // Project CRUD (M1.7). `GET /api/v1/projects` and the `POST` variant
        // both want a JSON body, so we register them as a `.method_router`.
        .route("/api/v1/projects", get(filmcraft_server::api::projects::list_projects).post(filmcraft_server::api::projects::create_project))
        .route("/api/v1/projects/{project_id}", delete(filmcraft_server::api::projects::delete_project))
        // Project-aware media API (M1.6). The POST route gets a per-route
        // body-limit layer; the GET routes share the router-wide 2 MiB
        // default, which is plenty for a JSON listing.
        .route(
            "/api/v1/projects/{project_id}/media",
            post(filmcraft_server::api::upload_media).layer(DefaultBodyLimit::max(filmcraft_server::api::MAX_UPLOAD_BYTES)),
        )
        .route("/api/v1/projects/{project_id}/media", get(filmcraft_server::api::list_media))
        // Stream an individual media file with Range (M1.7). The upload
        // route is the same path; axum distinguishes methods.
        //
        // M2.7c: layered with `query_token_fallback` so a `<video src>`
        // carrying `?token=<token>` can play without an `Authorization`
        // header (browsers don't let `<video>` set custom headers). The
        // router-wide `auth_layer` still handles the bearer-header path;
        // this fallback only runs when `CurrentUser` is not already in
        // the request extensions, so authenticated users keep their
        // existing behaviour. The auth store is supplied through
        // `from_fn_with_state` so the middleware can `State`-extract it
        // (axum's plain `from_fn` doesn't support the `State` extractor).
        .route(
            "/api/v1/projects/{project_id}/media/{filename}",
            get(filmcraft_server::api::media::stream_media).layer({
                let auth = state.auth.clone();
                axum::middleware::from_fn_with_state(auth, query_token_fallback)
            }),
        )
        .route("/api/v1/projects/{project_id}/export", get(filmcraft_server::api::export_info))
        .route("/api/v1/projects/{project_id}/export.fcproj", get(filmcraft_server::api::download_project))
        // Raw `.fcproj` for in-process consumers (M2.1). Same payload as the
        // `/export.fcproj` attachment endpoint but without
        // `Content-Disposition: attachment`, so a Zustand store can
        // `JSON.parse(fetch(...).arrayBuffer())` straight off the wire.
        .route("/api/v1/projects/{project_id}/fcproj", get(filmcraft_server::api::get_fcproj))
        // Project versioning (M2.9). The three write endpoints share the
        // same 200 MiB body cap as the legacy media-upload route; the
        // GETs are well under the default 2 MiB cap.
        .route(
            "/api/v1/projects/{project_id}/save",
            post(filmcraft_server::api::versioning::save_project).layer(DefaultBodyLimit::max(filmcraft_server::api::MAX_UPLOAD_BYTES)),
        )
        .route("/api/v1/projects/{project_id}/lock", post(filmcraft_server::api::versioning::lock_project))
        .route("/api/v1/projects/{project_id}/unlock", post(filmcraft_server::api::versioning::unlock_project))
        .route("/api/v1/projects/{project_id}/history", get(filmcraft_server::api::versioning::list_history))
        .route("/api/v1/projects/{project_id}/history/{rev}", get(filmcraft_server::api::versioning::read_history))
        // Permissive CORS — fine because the server binds to loopback by default
        // (AGENTS.md §0) and any public deployment should put a reverse proxy
        // (nginx/Aliyun SLB) in front. Per the "frontend-backend separation"
        // requirement, multiple independent frontends will hit `/api/v1/*`.
        .fallback_service(fallback)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TraceLayer::new_for_http())
        // M2.10: telemetry — extract / generate a request id, install it
        // in `Request::extensions()`, and stamp `X-Request-Id` on the
        // outgoing response. Outer-most so every other layer / handler
        // sees the id (the layer order in axum is "last added is
        // outermost", so this must come after CORS / Trace to be
        // innermost; we want it innermost anyway — request_id_layer does
        // not produce an event of its own, so the TraceLayer HTTP access
        // log is the natural place to see the id).
        .layer(from_fn(request_id_layer))
        // M2.6: bearer-token auth. Inline `from_fn` capturing the auth
        // store — sidesteps axum's `from_fn_with_state` (which has
        // trouble with `Arc<dyn Trait>` as state because of auto-trait
        // bounds). Public routes (login + health + manifest + SPA + WS)
        // skip the check; everything else needs
        // `Authorization: Bearer <token>`.
        .layer(from_fn({
            let store = state.auth.clone();
            move |req, next| {
                let store = Arc::clone(&store);
                filmcraft_server::auth::run_auth_layer(store, req, next)
            }
        }))
        .with_state(state);

    let listener = TcpListener::bind(&listen_addr).await.map_err(|e| ServerError::Internal(format!("failed to bind {listen_addr}: {e}")))?;
    let bound = listener.local_addr().map_err(|e| ServerError::Internal(format!("local_addr: {e}")))?;
    info!(addr = %bound, "filmcraft-server listening");

    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await.map_err(|e| ServerError::Internal(format!("axum::serve: {e}")))?;

    info!("filmcraft-server stopped");
    Ok(())
}

/// Resolve `FILMCRAFT_WEB_UI_DIR` (default `apps/filmcraft-web-ui/dist`),
/// used as the root for static-file serving. Returns `None` to indicate
/// "no UI built" when the directory is missing.
fn resolve_web_ui_dir() -> Option<PathBuf> {
    let from_env = env::var("FILMCRAFT_WEB_UI_DIR").ok().map(PathBuf::from);
    let candidate = from_env.unwrap_or_else(|| PathBuf::from("cloud/filmcraft-web-ui/dist"));
    if candidate.is_dir() { Some(candidate) } else { None }
}

/// Handler for any path the API didn't match. When the static fallback is
/// in use this only fires for missing files; without a UI we want a JSON
/// hint rather than the default text/plain 404 body.
async fn not_found_handler() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "ok": false,
            "error": "web UI not built; run `npm run build` in apps/filmcraft-web-ui",
        })),
    )
        .into_response()
}

/// Per-directory SPA-fallback state. `index_html` is read once at
/// startup so we don't hit the disk on every client-side navigation
/// the router couldn't match.
struct WebUi {
    dir: PathBuf,
    index_html: Vec<u8>,
}

/// Load the web UI's directory + its `index.html` once. The fallback
/// path that fires on every unmatched request is the hot path for any
/// SPA, and reading the file on each call would be wasteful.
fn load_web_ui(dir: PathBuf) -> Option<Arc<WebUi>> {
    let index_path = dir.join("index.html");
    let bytes = std::fs::read(&index_path).ok()?;
    Some(Arc::new(WebUi { dir, index_html: bytes }))
}

/// Serve a static file from `ui`. Used as the router's fallback handler
/// when a built web UI is present. Maps the requested URL path to a file
/// under `ui.dir`, falling back to the cached `index.html` for unknown
/// paths so client-side routing still works. Maps the file extension to
/// a sensible `Content-Type` for Vite's output (`html`, `js`, `css`, `svg`,
/// `png`, …).
async fn serve_static_fallback(ui: Arc<WebUi>, req: axum::extract::Request) -> Response {
    use std::path::Component;

    let path = req.uri().path().trim_start_matches('/');
    // Strip out any `..` segments the same way `Path::components` would:
    // refuse them outright. The router has already matched an API route
    // before this fires, so an attacker-controlled path is a 404 either
    // way.
    for seg in std::path::Path::new(path).components() {
        if matches!(seg, Component::ParentDir) {
            return not_found_handler().await;
        }
    }
    let bytes = match std::fs::read(ui.dir.join(path)) {
        Ok(b) => b,
        // No such asset — serve `index.html` so React Router can take over.
        Err(_) => ui.index_html.clone(),
    };
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("");
    let content_type: &'static str = match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "" => "text/html; charset=utf-8", // default to HTML for `index.html`-like paths
        _ => "application/octet-stream",
    };
    // Cache policy: `index.html` (the entry point that references
    // content-hashed asset names) must always be revalidated so a
    // fresh build of the SPA reaches the browser without a manual
    // cache clear. The hashed assets themselves (`.js`, `.css`, etc.)
    // are content-addressable, so a year-long `max-age` is safe — if
    // the asset changes, the URL changes, and the new URL is what
    // the fresh `index.html` will request.
    //
    // Without this, a browser that cached an older `index.html`
    // (referencing `index-D3Czw_k5.js`) will keep requesting the old
    // asset name on every reload, get HTML back (the SPA fallback
    // when the file is missing), and fail to parse it as JS.
    let cache_control: &'static str = if content_type.starts_with("text/html") {
        "no-cache, must-revalidate"
    } else {
        "public, max-age=31536000, immutable"
    };
    let mut response_headers = axum::http::HeaderMap::new();
    response_headers.insert(CONTENT_TYPE, axum::http::HeaderValue::from_static(content_type));
    response_headers.insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static(cache_control));
    (StatusCode::OK, response_headers, Body::from(bytes)).into_response()
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("filmcraft_server=info,tower_http=info"));
    // `try_init` returns Err if a global subscriber is already set (typical
    // under `cargo test`, which runs every test in one process). Warn
    // instead of silently swallowing so debug logs aren't a mystery later.
    if let Err(e) = tracing_subscriber::fmt().with_env_filter(filter).with_target(false).try_init() {
        tracing::warn!(error = %e, "tracing subscriber already set; using the existing one");
    }
}

fn resolve_listen_addr() -> Result<SocketAddr> {
    let raw = env::var("FILMCRAFT_LISTEN_ADDR").unwrap_or_else(|_| DEFAULT_LISTEN_ADDR.to_string());
    raw.parse::<SocketAddr>().map_err(|e| ServerError::Internal(format!("invalid FILMCRAFT_LISTEN_ADDR={raw:?}: {e}")))
}

fn resolve_store_root() -> Result<PathBuf> {
    let raw = env::var("FILMCRAFT_STORE_ROOT").unwrap_or_else(|_| DEFAULT_STORE_ROOT.to_string());
    Ok(PathBuf::from(raw))
}

async fn api_doc_handler(State(state): State<AppState>) -> impl IntoResponse {
    let payload =
        RootPayload { status: "ok", version: SERVER_VERSION, uptime_secs: state.started_at.elapsed().as_secs(), endpoints: endpoints_payload().clone() };
    (StatusCode::OK, Json(payload))
}

async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

/// Read an object from the store. The path under the route is the OSS key
/// (with its `oss://bucket/` prefix reconstructed on the way in).
async fn store_get(State(state): State<AppState>, Path(key): Path<String>) -> impl IntoResponse {
    let full = format!("oss://filmcraft/{key}");
    match state.services.read_file(&full) {
        Ok(bytes) => (StatusCode::OK, Body::from(bytes)).into_response(),
        Err(e) => map_store_io_error(full, e).into_response(),
    }
}

/// Write an object to the store. The request body is the raw bytes; the
/// content type is whatever the client sets (we ignore it for M1.3a).
async fn store_put(State(state): State<AppState>, Path(key): Path<String>, body: axum::body::Bytes) -> impl IntoResponse {
    let full = format!("oss://filmcraft/{key}");
    match state.services.write_file(&full, &body) {
        Ok(()) => (StatusCode::NO_CONTENT).into_response(),
        Err(e) => map_store_io_error(full, e).into_response(),
    }
}

/// `?project_id=` query parameter for the WebSocket upgrade. The project id
/// is component-validated up front so a bad value is a 400, not a silent
/// session split.
#[derive(Debug, Deserialize)]
struct WsQuery {
    #[serde(default)]
    project_id: Option<String>,
    /// M2.7: session token carried in the URL query string. Browsers
    /// cannot attach `Authorization` headers to a WS handshake, so
    /// `?token=` is the equivalent channel. Strict policy: missing or
    /// invalid → 401.
    #[serde(default)]
    token: Option<String>,
}

/// M2.7c: `?token=` query parameter on the media-stream endpoint. Browsers
/// can't stamp an `Authorization` header on a `<video src>`, so we accept
/// the same query-token fallback the WS handshake already uses. The
/// `auth_layer` middleware still handles the bearer-header path; this
/// extractor only feeds the `query_token_fallback` middleware below.
#[derive(Debug, Deserialize)]
struct MediaQuery {
    #[serde(default)]
    token: Option<String>,
}

/// M2.7c: per-route middleware that accepts `?token=<token>` as an
/// alternative to `Authorization: Bearer <token>` for the media-stream
/// endpoint. Browsers attach custom headers to fetch / XHR but not to
/// `<video src>`, so the HTML video element can't carry the bearer token
/// any other way.
///
/// The route is whitelisted in `auth::is_public_path` so the
/// router-wide `auth_layer` skips it — auth for this endpoint is
/// handled entirely by `query_token_fallback`, which accepts either
/// an `Authorization: Bearer <token>` header or a `?token=<token>`
/// query parameter. Both paths run the same `AuthStore::resolve`
/// lookup; a missing or invalid token is a 401 with the same
/// `unauthorized()` body the layer would have produced, so clients
/// see no behaviour change for the authenticated path.
async fn query_token_fallback(
    State(store): State<Arc<dyn filmcraft_server::auth::AuthStore>>,
    Query(q): Query<MediaQuery>,
    req: Request,
    next: Next,
) -> Response {
    use axum::http::header::AUTHORIZATION;
    // If a previous middleware (e.g. the router-wide `auth_layer`, if
    // the route is ever re-classified as protected) already populated
    // `CurrentUser`, trust it. Cheaper than re-resolving the same
    // token, and future-proofs against layer-order changes.
    if req.extensions().get::<filmcraft_server::auth::CurrentUser>().is_some() {
        return next.run(req).await;
    }
    // Try the standard `Authorization: Bearer <token>` header first so
    // clients that *can* stamp it keep working with no change.
    if let Some(token) = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|t| filmcraft_server::auth::SessionToken(t.to_string()))
    {
        return authenticate_or_unauthorized(store, req, next, token, "invalid or expired token").await;
    }
    // Fall back to `?token=<token>` from the URL.
    let Some(raw) = q.token.as_deref() else {
        return filmcraft_server::auth::unauthorized("missing or invalid token");
    };
    let token = filmcraft_server::auth::SessionToken(raw.to_string());
    authenticate_or_unauthorized(store, req, next, token, "invalid or expired token").await
}

/// Resolve `token` against `store`; on success attach `CurrentUser` to
/// the request and forward to the next handler, otherwise return a
/// 401 with `unauthorized_msg`. Single shared body so the
/// header-path and the query-token path in `query_token_fallback`
/// don't repeat the `resolve` + `extensions_mut` dance.
async fn authenticate_or_unauthorized(
    store: Arc<dyn filmcraft_server::auth::AuthStore>,
    mut req: Request,
    next: Next,
    token: filmcraft_server::auth::SessionToken,
    unauthorized_msg: &'static str,
) -> Response {
    let Some(uid) = store.resolve(&token).await else {
        return filmcraft_server::auth::unauthorized(unauthorized_msg);
    };
    req.extensions_mut().insert(filmcraft_server::auth::CurrentUser { user_id: uid, token });
    next.run(req).await
}

/// WebSocket upgrade handler. Hands the upgraded socket to the WS bridge,
/// which then runs the control protocol against `SessionManager`.
///
/// The `?project_id=` query parameter picks which `(user, project)` session
/// the engine commands run against — two browser tabs opening WS with
/// different `project_id` values get fully isolated engine state. The
/// project id is validated at the HTTP boundary so a bad value is a 400
/// rather than a silently-rewritten key.
///
/// Auth (M2.7): `?token=...` carries a session token issued by
/// `POST /api/v1/auth/login`. Browsers cannot attach an `Authorization`
/// header to a WS handshake, so the token travels as a URL parameter.
/// Policy is strict: missing or invalid → 401, no fallback to the old
/// anonymous identity (one server, one auth policy).
async fn ws_upgrade(State(state): State<AppState>, Query(q): Query<WsQuery>, ws: axum::extract::ws::WebSocketUpgrade) -> Result<axum::response::Response> {
    let Some(project_id) = q.project_id else {
        return Err(ServerError::BadRequest("missing `project_id` query parameter".into()));
    };
    filmcraft_server::api::validate_component("project_id", &project_id)?;
    // M2.7: resolve `?token=...` against the auth store. `validate_ws_token`
    // wraps `AuthStore::resolve`; the strict policy lives here so the
    // function itself stays a pure lookup.
    let user_id = filmcraft_server::auth::validate_ws_token(&*state.auth, q.token.as_deref())
        .await
        .ok_or_else(|| ServerError::Unauthorized("invalid or missing `?token=`".into()))?;
    let key = ProjectKey::new(user_id.0, project_id);
    let mgr = Arc::clone(&state.sessions);
    Ok(ws.on_upgrade(move |socket| async move {
        filmcraft_server::ws::handle_socket(socket, mgr, key).await;
    }))
}

/// Wait for SIGINT (Ctrl-C) or SIGTERM. Returns when either arrives.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = signal::ctrl_c().await;
    };
    let terminate = async {
        #[cfg(unix)]
        {
            if let Ok(mut sig) = signal::unix::signal(signal::unix::SignalKind::terminate()) {
                sig.recv().await;
            }
        }
        #[cfg(not(unix))]
        {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        _ = ctrl_c => info!("received SIGINT"),
        _ = terminate => info!("received SIGTERM"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;
    // WS round-trip tests need `send` (Sink) and `next` (Stream) on the
    // `WebSocketStream` returned by `tokio_tungstenite::connect_async`.
    use futures_util::{SinkExt, StreamExt};

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("filmcraft-server-test-{}-{}", std::process::id(), uuid_tag()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let services = Arc::new(OssServices::new(root));
        let sessions = Arc::new(filmcraft_server::SessionManager::new(Arc::clone(&services)));
        let api_state = filmcraft_server::api::ApiState::new(Arc::clone(&services), filmcraft_server::UserId::new("test"));
        // M2.6: tests share a fresh `HardcodedAuthStore` per `test_state()`
        // call. The password is a known constant so the login tests can
        // pin `admin / test-pw`; production uses `FILMCRAFT_ADMIN_PASSWORD`.
        let auth = filmcraft_server::auth::HardcodedAuthStore::shared("test-pw".to_string());
        AppState { started_at: std::time::Instant::now(), services, sessions, api_state, auth }
    }

    /// Per-test unique tag so two tests run in parallel don't share a temp dir.
    /// `AtomicUsize` is overkill for tests, but it makes the intent obvious.
    fn uuid_tag() -> String {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        format!("t{n}")
    }

    /// M2.6 helper: log in as the test admin and return the issued
    /// session token. `Router` is `Clone` in axum 0.8, so callers can
    /// share a single router between login + the actual test request,
    /// or build a fresh one per request. Typical pattern:
    ///
    /// ```ignore
    /// let state = test_state();
    /// let token = login(app(state.clone())).await;
    /// let resp = app(state).oneshot(with_auth(req, &token)).await.unwrap();
    /// ```
    async fn login(router: Router) -> String {
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"test-pw"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "test login must succeed");
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        j["token"].as_str().unwrap().to_string()
    }

    /// M2.6 helper: stamp `Authorization: Bearer <token>` on a request
    /// before passing it through `oneshot`. The auth layer requires a
    /// valid token on every protected route, and retrofitting every
    /// existing test to manually add the header would be far noisier
    /// than this one-call wrapper.
    fn with_auth(req: Request<Body>, token: &str) -> Request<Body> {
        // `Request` doesn't expose a `headers_mut` getter that returns
        // `&mut HeaderMap` directly without going through a `Parts`
        // split. Do the split / merge dance.
        let (mut parts, body) = req.into_parts();
        parts.headers.insert(axum::http::header::AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
        Request::from_parts(parts, body)
    }

    fn app(state: AppState) -> Router {
        Router::new()
            .route("/api/v1", get(api_doc_handler))
            .route("/api/v1/health", get(health_handler))
            // M2.6: auth surface mirrors production (so per-test
            // integration hits the same wiring).
            .route("/api/v1/auth/login", post(filmcraft_server::auth::login_handler))
            .route("/api/v1/auth/me", get(filmcraft_server::auth::me_handler))
            .route("/api/v1/auth/logout", post(filmcraft_server::auth::logout_handler))
            .route("/api/v1/store/{*key}", get(store_get).put(store_put))
            .route("/api/v1/ws", get(ws_upgrade))
            .route("/api/v1/projects", get(filmcraft_server::api::projects::list_projects).post(filmcraft_server::api::projects::create_project))
            .route("/api/v1/projects/{project_id}", delete(filmcraft_server::api::projects::delete_project))
            .route(
                "/api/v1/projects/{project_id}/media",
                post(filmcraft_server::api::upload_media).layer(DefaultBodyLimit::max(filmcraft_server::api::MAX_UPLOAD_BYTES)),
            )
            .route("/api/v1/projects/{project_id}/media", get(filmcraft_server::api::list_media))
            // M2.7c: see the production router — the media-stream route
            // also accepts `?token=<token>` so the test for the
            // query-token path can hit the same handler the browser
            // `<video>` element will hit. The auth store is supplied
            // through `from_fn_with_state` (mirroring the production
            // wiring).
            .route(
                "/api/v1/projects/{project_id}/media/{filename}",
                get(filmcraft_server::api::media::stream_media).layer({
                    let auth = state.auth.clone();
                    axum::middleware::from_fn_with_state(auth, query_token_fallback)
                }),
            )
            .route("/api/v1/projects/{project_id}/export", get(filmcraft_server::api::export_info))
            .route("/api/v1/projects/{project_id}/export.fcproj", get(filmcraft_server::api::download_project))
            .route("/api/v1/projects/{project_id}/fcproj", get(filmcraft_server::api::get_fcproj))
            // Project versioning (M2.9). Same routes as the production
            // router above so per-test integration hits the same
            // wiring.
            .route(
                "/api/v1/projects/{project_id}/save",
                post(filmcraft_server::api::versioning::save_project).layer(DefaultBodyLimit::max(filmcraft_server::api::MAX_UPLOAD_BYTES)),
            )
            .route("/api/v1/projects/{project_id}/lock", post(filmcraft_server::api::versioning::lock_project))
            .route("/api/v1/projects/{project_id}/unlock", post(filmcraft_server::api::versioning::unlock_project))
            .route("/api/v1/projects/{project_id}/history", get(filmcraft_server::api::versioning::list_history))
            .route("/api/v1/projects/{project_id}/history/{rev}", get(filmcraft_server::api::versioning::read_history))
            .layer(TraceLayer::new_for_http())
            .layer(from_fn(request_id_layer))
            // M2.6: bearer-token auth, same as production. Tests can
            // bypass it by sending `Authorization: Bearer <login-token>`
            // — `test_state()` hands back a store that knows
            // `admin / test-pw`. Inline `from_fn` closure capturing
            // the store; matches the production wiring exactly.
            .layer(from_fn({
                let store = state.auth.clone();
                move |req, next| {
                    let store = Arc::clone(&store);
                    filmcraft_server::auth::run_auth_layer(store, req, next)
                }
            }))
            .with_state(state)
    }

    #[tokio::test]
    async fn api_doc_returns_endpoint_manifest() {
        // M1.7 follow-up: `/` is owned by the SPA fallback, so the API
        // manifest itself moved to `GET /api/v1`. `/api/v1` is public,
        // so no auth needed.
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 8192).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], SERVER_VERSION);
        // Manifest must agree with the live routes. Derive the expected
        // key set from `endpoints_payload()` (the single source of truth)
        // so adding a new endpoint here doesn't silently desync the test.
        let endpoints = body["endpoints"].as_object().expect("endpoints is an object");
        let expected_keys: std::collections::BTreeSet<&str> =
            endpoints_payload().as_object().expect("endpoints_payload is an object").keys().map(String::as_str).collect();
        let actual_keys: std::collections::BTreeSet<&str> = endpoints.keys().map(String::as_str).collect();
        assert_eq!(actual_keys, expected_keys, "manifest key set drifted from endpoints_payload()");
        // Spot-checks against the legacy `/` and `/health` paths that the
        // SPA fallback reshuffle retired.
        assert_eq!(endpoints["health"]["path"], "/api/v1/health");
        assert_eq!(endpoints["root"]["path"], "/api/v1");
    }

    #[tokio::test]
    async fn health_returns_200() {
        // M2.6: `/api/v1/health` is public — no auth required.
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1/health").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn store_put_then_get_round_trip() {
        // PUT then GET against the SAME state, otherwise the two requests
        // would land in two different temp dirs. M2.6: both calls
        // carry a bearer token now (the store route is protected).
        let state = test_state();
        // Two routers share the same `AppState`. Each `oneshot` consumes
        // its router, so we build one per request.
        let token = login(app(state.clone())).await;
        let resp = app(state.clone())
            .oneshot(with_auth(Request::builder().method("PUT").uri("/api/v1/store/users/u/p/c.fcproj").body(Body::from("hello m1.3")).unwrap(), &token))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let resp =
            app(state).oneshot(with_auth(Request::builder().uri("/api/v1/store/users/u/p/c.fcproj").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        assert_eq!(&bytes[..], b"hello m1.3");
    }

    #[tokio::test]
    async fn store_get_missing_returns_404() {
        // M2.6: store routes are protected — auth header required.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp = router.oneshot(with_auth(Request::builder().uri("/api/v1/store/does-not-exist").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn store_rejects_traversal() {
        // `..` must be rejected by the path policy in OssServices.
        // M2.6: protected route — send a token so the auth layer lets
        // the request reach the validator.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp = router.oneshot(with_auth(Request::builder().uri("/api/v1/store/../etc/passwd").body(Body::empty()).unwrap(), &token)).await.unwrap();
        // axum may reject the URI at parse time, or the handler may see it
        // and return 400. Either is fine; 200 is the only forbidden outcome.
        assert_ne!(resp.status(), StatusCode::OK, "traversal must not succeed");
    }

    #[tokio::test]
    async fn project_upload_then_list_then_download_round_trip() {
        // M1.6 acceptance: POST a (fake) mp4 to a project's media dir, GET
        // the listing, then GET the project's current.fcproj download.
        // We use the same `state` across all three requests so they share
        // the OSS root. M2.6: every call now carries a bearer token.
        let state = test_state();
        let token = login(app(state.clone())).await;

        // 1. Upload. Build an MP4-shaped body (ftyp box) so the sniff
        //    accepts it.
        let mut body = vec![0u8; 64];
        body[4..8].copy_from_slice(b"ftyp");
        body[8..12].copy_from_slice(b"isom");

        let resp = app(state.clone())
            .oneshot(with_auth(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/demo/media")
                    .header("x-filename", "intro.mp4")
                    .header("content-type", "video/mp4")
                    .body(Body::from(body.clone()))
                    .unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED, "upload should be 201, got {}", resp.status());
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["name"], "intro.mp4");
        assert_eq!(j["size"], 64);

        // 2. List — must include the file we just uploaded.
        let resp =
            app(state.clone()).oneshot(with_auth(Request::builder().uri("/api/v1/projects/demo/media").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let items = j["items"].as_array().expect("items is an array");
        assert!(items.iter().any(|v| v.as_str() == Some("intro.mp4")), "items missing intro.mp4: {items:?}");

        // 3. Write a fake .fcproj at current.fcproj, then GET it back.
        // M2.7: `download_project` reads under the *authenticated* user
        // (M2.7's `FromRequestParts` override), so the seed PUT must
        // use the same user the auth layer resolves to. `login` mints
        // against the hardcoded admin user, so the file goes under
        // `users/admin/projects/demo/...`.
        let project_blob = b"FCP-JSON-DEMO";
        let resp = app(state.clone())
            .oneshot(with_auth(
                Request::builder().method("PUT").uri("/api/v1/store/users/admin/projects/demo/current.fcproj").body(Body::from(project_blob.to_vec())).unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let resp =
            app(state).oneshot(with_auth(Request::builder().uri("/api/v1/projects/demo/export.fcproj").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let cd = resp.headers().get("content-disposition").unwrap().to_str().unwrap().to_string();
        assert!(cd.contains("attachment"), "expected attachment header, got {cd:?}");
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        assert_eq!(&bytes[..], project_blob);
    }

    #[tokio::test]
    async fn project_upload_rejects_traversal_in_project_id() {
        // M2.6: protected route — token required.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp = router
            .oneshot(with_auth(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/..%2Fetc/media")
                    .header("x-filename", "x.mp4")
                    .body(Body::from(b"hello".to_vec()))
                    .unwrap(),
                &token,
            ))
            .await
            .unwrap();
        // axum decodes %2F back to /, which would normally land on the
        // path; the path component must not match our route at all, so a
        // 404 is the right outcome here. Anything other than 2xx.
        assert_ne!(resp.status(), StatusCode::OK);
        assert_ne!(resp.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn project_upload_rejects_traversal_in_filename() {
        // M2.6: protected route — token required.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp = router
            .oneshot(with_auth(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/demo/media")
                    .header("x-filename", "../../etc/passwd")
                    .body(Body::from(b"hello".to_vec()))
                    .unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn project_download_missing_returns_404() {
        // M2.6: protected route — token required.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp = router
            .oneshot(with_auth(Request::builder().uri("/api/v1/projects/never-existed/export.fcproj").body(Body::empty()).unwrap(), &token))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn project_export_info_returns_fcproj_link() {
        // M2.6: protected route — token required.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp = router.oneshot(with_auth(Request::builder().uri("/api/v1/projects/demo/export").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["project"], "demo");
        assert_eq!(j["download"]["kind"], "fcproj");
        assert!(j["download"]["url"].as_str().unwrap().ends_with("/export.fcproj"));
    }

    #[test]
    fn default_listen_addr_is_loopback() {
        let addr: SocketAddr = DEFAULT_LISTEN_ADDR.parse().unwrap();
        assert!(addr.ip().is_loopback(), "default must be loopback, got {addr}");
    }

    /// M1.7 acceptance: POST → list → DELETE → list. Mirrors the user flow.
    #[tokio::test]
    async fn project_crud_round_trip() {
        let state = test_state();
        let token = login(app(state.clone())).await;

        // 1. POST creates the project (201 + body has the id).
        let resp = app(state.clone())
            .oneshot(with_auth(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"id":"alpha","name":"Alpha"}"#))
                    .unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["project"], "alpha");

        // 2. GET lists and includes it.
        let resp = app(state.clone()).oneshot(with_auth(Request::builder().uri("/api/v1/projects").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let projects = j["projects"].as_array().expect("projects is an array");
        assert!(projects.iter().any(|v| v["id"] == "alpha"), "alpha not listed: {projects:?}");

        // 3. DELETE removes it (204).
        let resp = app(state.clone())
            .oneshot(with_auth(Request::builder().method("DELETE").uri("/api/v1/projects/alpha").body(Body::empty()).unwrap(), &token))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // 4. GET again — the project is gone.
        let resp = app(state).oneshot(with_auth(Request::builder().uri("/api/v1/projects").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let projects = j["projects"].as_array().expect("projects is an array");
        assert!(!projects.iter().any(|v| v["id"] == "alpha"), "alpha still listed after delete");
    }

    #[tokio::test]
    async fn project_create_rejects_traversal_in_id() {
        // M2.6: protected route — token required.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp = router
            .oneshot(with_auth(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects")
                    .header("content-type", "application/json")
                    // `..%2Fetc` is rendered as `../etc` by axum's path
                    // extractor, which `validate_component` must reject.
                    // In practice `%2F` is decoded by the URI parser, so this
                    // becomes a route-mismatch (404). Either way: not 2xx.
                    .body(Body::from(r#"{"id":"..\\etc"}"#))
                    .unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_ne!(resp.status(), StatusCode::OK, "traversal must not succeed");
        assert_ne!(resp.status(), StatusCode::CREATED, "traversal must not be CREATED");
    }

    #[tokio::test]
    async fn project_create_duplicate_returns_409() {
        // The plan says "409", and our handler returns 400 via
        // `BadRequest(... already exists)`. Either way, not 2xx.
        // M2.6: protected route — token required.
        let state = test_state();
        let token = login(app(state.clone())).await;
        let body = r#"{"id":"dup","name":"dup"}"#;

        let resp = app(state.clone())
            .oneshot(with_auth(
                Request::builder().method("POST").uri("/api/v1/projects").header("content-type", "application/json").body(Body::from(body)).unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        let resp = app(state)
            .oneshot(with_auth(
                Request::builder().method("POST").uri("/api/v1/projects").header("content-type", "application/json").body(Body::from(body)).unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_ne!(resp.status(), StatusCode::CREATED, "second POST must not succeed");
    }

    #[tokio::test]
    async fn project_delete_missing_returns_404() {
        // M2.6: protected route — token required.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp =
            router.oneshot(with_auth(Request::builder().method("DELETE").uri("/api/v1/projects/nope").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn media_stream_returns_video_content_type_and_accept_ranges() {
        let state = test_state();
        let token = login(app(state.clone())).await;
        // First seed an MP4-shaped file by going through the upload endpoint.
        let mut body = vec![0u8; 32];
        body[4..8].copy_from_slice(b"ftyp");
        body[8..12].copy_from_slice(b"isom");
        let resp = app(state.clone())
            .oneshot(with_auth(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/demo/media")
                    .header("x-filename", "clip.mp4")
                    .header("content-type", "video/mp4")
                    .body(Body::from(body))
                    .unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // Now request the stream.
        let resp =
            app(state).oneshot(with_auth(Request::builder().uri("/api/v1/projects/demo/media/clip.mp4").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp.headers().get("content-type").unwrap().to_str().unwrap();
        assert!(ct.starts_with("video/"), "expected video/* content type, got {ct}");
        assert_eq!(resp.headers().get("accept-ranges").unwrap().to_str().unwrap(), "bytes");
    }

    #[tokio::test]
    async fn media_stream_range_request_returns_206() {
        let state = test_state();
        let token = login(app(state.clone())).await;
        // Seed a 32-byte file with a content body we can slice.
        let body: Vec<u8> = (0u8..=31).collect();
        let resp = app(state.clone())
            .oneshot(with_auth(
                Request::builder().method("POST").uri("/api/v1/projects/demo/media").header("x-filename", "raw.bin").body(Body::from(body.clone())).unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // Range: bytes=4-11 (inclusive on the right) → 8 bytes back.
        let resp = app(state)
            .oneshot(with_auth(
                Request::builder().uri("/api/v1/projects/demo/media/raw.bin").header("range", "bytes=4-11").body(Body::empty()).unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT, "Range must yield 206");
        let cr = resp.headers().get("content-range").unwrap().to_str().unwrap().to_string();
        assert_eq!(cr, "bytes 4-11/32");
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        assert_eq!(&bytes[..], &body[4..12]);
    }

    /// M2.7c: `?token=<valid>` on the media-stream URL lets `<video src>`
    /// play without an `Authorization` header (browsers can't stamp
    /// custom headers on media element requests). The response must be
    /// a normal 200 with `video/*` and `accept-ranges: bytes`, the
    /// same body the bearer-header path returns.
    #[tokio::test]
    async fn media_stream_accepts_query_token_when_header_missing() {
        let state = test_state();
        let token = login(app(state.clone())).await;
        // Seed an MP4-shaped file so the existing sniff path is happy
        // (mirrors `media_stream_returns_video_content_type_and_accept_ranges`).
        let mut body = vec![0u8; 32];
        body[4..8].copy_from_slice(b"ftyp");
        body[8..12].copy_from_slice(b"isom");
        let resp = app(state.clone())
            .oneshot(with_auth(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/demo/media")
                    .header("x-filename", "clip.mp4")
                    .header("content-type", "video/mp4")
                    .body(Body::from(body))
                    .unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // No `Authorization` header — only `?token=...`. URL-encode the
        // value so any future token chars don't accidentally break the
        // request. Same shape the SPA sends from `streamUrl()` in
        // M2.7c's client change.
        let resp = app(state)
            .oneshot(Request::builder().uri(format!("/api/v1/projects/demo/media/clip.mp4?token={token}")).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "valid ?token= must let media stream without Authorization");
        let ct = resp.headers().get("content-type").unwrap().to_str().unwrap();
        assert!(ct.starts_with("video/"), "expected video/* content type, got {ct}");
        assert_eq!(resp.headers().get("accept-ranges").unwrap().to_str().unwrap(), "bytes");
    }

    /// M2.7c: a request with neither `Authorization` nor `?token=`
    /// must still be rejected with 401 — no regression on the
    /// existing `auth_layer` policy.
    #[tokio::test]
    async fn media_stream_rejects_missing_query_token_and_header() {
        let router = app(test_state());
        let resp = router.oneshot(Request::builder().uri("/api/v1/projects/demo/media/clip.mp4").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "no auth at all must yield 401");
    }

    /// M2.7c: a `?token=` value the auth store has never issued must
    /// be rejected with 401 (mirrors `validate_ws_token`'s policy
    /// for the WS handshake).
    #[tokio::test]
    async fn media_stream_rejects_invalid_query_token() {
        let router = app(test_state());
        let resp = router
            .oneshot(Request::builder().uri("/api/v1/projects/demo/media/clip.mp4?token=deadbeef-dead-beef-dead-beefdeadbeef").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "garbage ?token= must yield 401");
    }

    /// M2.1: WS upgrade is rejected at the HTTP layer (400) when the
    /// `?project_id=` query parameter fails `validate_component`. The
    /// socket must never reach `handle_socket` in this case.
    /// M2.6: `/api/v1/ws` is still anonymous (the WS path is handled
    /// by `validate_ws_token`, which currently returns `None`).
    #[tokio::test]
    async fn ws_route_rejects_invalid_project_id() {
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1/ws?project_id=..%2Fetc").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "traversal in project_id must yield 400");
    }

    /// M2.1: WS upgrade is rejected at the HTTP layer (400) when the
    /// `?project_id=` query parameter is missing entirely.
    /// M2.6: WS path is still anonymous.
    #[tokio::test]
    async fn ws_route_rejects_missing_project_id() {
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1/ws").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "missing project_id must yield 400");
    }

    /// M2.1: `GET /api/v1/projects/{id}/fcproj` returns the raw bytes that
    /// the project's `current.fcproj` contains, with the correct
    /// `application/octet-stream` content type and *no*
    /// `Content-Disposition: attachment` header. A future Zustand store
    /// parses this body straight from `fetch().arrayBuffer()`.
    #[tokio::test]
    async fn fcproj_endpoint_returns_raw_blob() {
        let state = test_state();
        let token = login(app(state.clone())).await;
        // Seed the project by POSTing it (M1.7 writes `current.fcproj`).
        let resp = app(state.clone())
            .oneshot(with_auth(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"id":"raw","name":"Raw"}"#))
                    .unwrap(),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // Read the raw bytes back and compare.
        let resp = app(state).oneshot(with_auth(Request::builder().uri("/api/v1/projects/raw/fcproj").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp.headers().get("content-type").unwrap().to_str().unwrap();
        assert_eq!(ct, "application/octet-stream", "raw endpoint must use octet-stream, got {ct}");
        // No Content-Disposition: the whole point of this endpoint.
        assert!(resp.headers().get("content-disposition").is_none(), "raw endpoint must not set Content-Disposition");

        // The body must equal what the create wrote. Use the same path
        // the create used to seed the body so we don't have to hardcode
        // the engine's serialisation format.
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let expected_bytes = filmcraft_format::encode(&filmcraft_project::Project::new("Raw"), true);
        assert_eq!(body.as_ref(), expected_bytes.as_slice(), "raw body must equal the seeded `.fcproj`");
    }

    /// M2.1: `GET /api/v1/projects/{id}/fcproj` returns 404 for a project
    /// that has no `current.fcproj` on disk (distinct from "the project
    /// doesn't exist at all", which would be a different error path).
    #[tokio::test]
    async fn fcproj_endpoint_404_when_no_save() {
        // Note: M1.7's POST /projects *always* writes `current.fcproj`, so
        // a project that was created by other means (a real user could
        // construct the dir but not the file) is hard to set up through
        // the HTTP API alone. We test the path by pointing at a project
        // id that simply doesn't exist. M2.6: protected route — token
        // required.
        let router = app(test_state());
        let token = login(router.clone()).await;
        let resp = router.oneshot(with_auth(Request::builder().uri("/api/v1/projects/never-saved/fcproj").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "missing fcproj must yield 404");
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], false);
        // The 404 response wraps the descriptive string in
        // `ServerError::NotFound`'s JSON shape (`"not found: ..."`), so the
        // substring we're after sits inside that envelope.
        let err = j["error"].as_str().unwrap();
        assert!(err.contains("never-saved") && err.contains("no saved fcproj"), "error must mention the missing project and the no-save cause, got {err:?}");
    }

    // ----- WebSocket round-trip tests (M2.1 acceptance) ----------------
    //
    // These exercise the full upgrade path: an in-process
    // `tokio_tungstenite` client dials the bound port, sends JSON-lines
    // requests, and reads JSON-lines replies. They cover the cases the
    // plan §"Test plan" called out as manual smoke but that we now want
    // to lock down in CI:
    //
    //   - WS upgrade succeeds, auto-load runs, an engine command runs
    //     against the *project's* session (not "no sequence open").
    //   - WS upgrade succeeds, auto-load fails on a missing `.fcproj`,
    //     client gets one error frame + a clean close.
    //   - Two WS connections to *different* `?project_id=` stay
    //     isolated: a `prefs.set` on one must not be visible on the
    //     other.

    /// Bind a fresh router to a random localhost port and return the
    /// `ws://` URL the test should dial. The server task is spawned on
    /// the test's tokio handle and dropped when the test ends.
    async fn ws_server(state: AppState) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = app(state).into_make_service();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("ws://{addr}/api/v1/ws")
    }

    /// M2.7 helper: mint a fresh token for the admin user against the
    /// test's auth store and return its raw string. WS upgrade tests
    /// attach it as `?token=...`; the strict policy in `ws_upgrade`
    /// demands a real, currently-valid token (no fallback to anonymous).
    async fn mint_token(state: &AppState) -> String {
        filmcraft_server::auth::issue_token(&*state.auth, filmcraft_server::UserId::new(filmcraft_server::auth::ADMIN_USER_ID)).await.0
    }

    /// `ws://` upgrade for an unknown project: the `.fcproj` doesn't
    /// exist, so `handle_socket`'s auto-load fails and the client must
    /// see one `{"ok":false,"error":"project load failed: ..."}` frame
    /// followed by a clean close frame (Close code 1008).
    #[tokio::test]
    async fn ws_with_unknown_project_sends_error_and_closes() {
        let state = test_state();
        let token = mint_token(&state).await;
        let url = ws_server(state).await;
        let (mut sock, _upgrade) = tokio_tungstenite::connect_async(format!("{url}?project_id=ghost&token={token}")).await.unwrap();

        // Frame 1: the auto-load error.
        let frame = sock.next().await.unwrap().unwrap();
        match frame {
            tokio_tungstenite::tungstenite::Message::Text(s) => {
                let v: serde_json::Value = serde_json::from_str(&s).unwrap();
                assert_eq!(v["ok"], false, "auto-load must yield ok:false, got {v}");
                assert!(v["error"].as_str().unwrap().contains("project load failed"), "error must explain the load failure, got {v:?}");
            }
            other => panic!("expected a text frame with the auto-load error, got {other:?}"),
        }

        // Frame 2: a Close frame carrying the policy-violation code.
        let frame = sock.next().await.unwrap().unwrap();
        match frame {
            tokio_tungstenite::tungstenite::Message::Close(close) => {
                let code = close.expect("close frame must carry a CloseFrame").code;
                // 1008 = "policy violation" (axum's ws::close_code::POLICY).
                assert_eq!(u16::from(code), 1008, "close frame must carry POLICY (1008), got {code}");
            }
            other => panic!("expected a close frame after the auto-load error, got {other:?}"),
        }
    }

    /// `ws://` upgrade for a known project: after auto-load the engine
    /// session has the project's `.fcproj` loaded, so a
    /// `sequence.inspect` returns project state. Critically, *not*
    /// `"no sequence open"` — that's the failure mode M2.1 fixes.
    #[tokio::test]
    async fn ws_with_valid_project_loads_and_runs_command() {
        let state = test_state();
        let token = mint_token(&state).await;

        // Seed `current.fcproj` *directly* under the path the WS bridge
        // will read from. M2.7: `?token=...` resolves to the
        // authenticated user (the test's `mint_token` mints as the
        // admin user `ADMIN_USER_ID`), so the file must live under
        // that user tree — not under the pre-M2.6 `anonymous` tree.
        // The WS bridge now resolves the project key from the real
        // authenticated user; seeding under `anonymous` would leave
        // the auto-load to legitimately fail.
        let oss_path = filmcraft_server::api::current_project_path(filmcraft_server::auth::ADMIN_USER_ID, "smoke");
        let bytes = filmcraft_format::encode(&filmcraft_project::Project::new("Smoke"), true);
        state.services.write_file(&oss_path, &bytes).unwrap();

        let url = ws_server(state).await;
        let (mut sock, _upgrade) = tokio_tungstenite::connect_async(format!("{url}?project_id=smoke&token={token}")).await.unwrap();

        // Send `engine.execute("perf.stats")`. `perf.stats` is the
        // cheapest always-enabled command, so it acts as a smoke that
        // the engine session is alive and the WS bridge is wired.
        sock.send(tokio_tungstenite::tungstenite::Message::Text(r#"{"id":1,"method":"engine.execute","params":{"command":"perf.stats"}}"#.into()))
            .await
            .unwrap();

        let frame = sock.next().await.unwrap().unwrap();
        match frame {
            tokio_tungstenite::tungstenite::Message::Text(s) => {
                let v: serde_json::Value = serde_json::from_str(&s).unwrap();
                assert_eq!(v["id"], 1);
                assert_eq!(v["ok"], true, "perf.stats after auto-load must succeed, got {v}");
                assert!(v["result"].is_object(), "perf.stats returns an object, got {v:?}");
            }
            other => panic!("expected a text reply to perf.stats, got {other:?}"),
        }

        // Clean shutdown.
        sock.close(None).await.unwrap();
    }

    /// Two WS clients on the *same* server but different `?project_id=`
    /// must have isolated engine sessions: a `prefs.set` on socket A
    /// must not bleed into socket B's `prefs.get`. This is the exact
    /// regression M2.1 ships — without the composite key, both sockets
    /// would mutate one engine session and the test would fail.
    #[tokio::test]
    async fn two_ws_isolation_no_cross_pollution() {
        let state = test_state();
        let token = mint_token(&state).await;
        // Seed two distinct projects directly under the *authenticated*
        // user tree. M2.7: `ws_upgrade` now uses the UserId resolved
        // from `?token=...`, so the WS bridge reads/writes under that
        // user. Going through `POST /projects` would seed under the
        // `test` user that `ApiState` uses — fine for HTTP-only tests,
        // but the WS bridge runs as the authenticated user and would
        // not find the files.
        for id in ["alpha", "beta"] {
            let oss_path = filmcraft_server::api::current_project_path(filmcraft_server::auth::ADMIN_USER_ID, id);
            let bytes = filmcraft_format::encode(&filmcraft_project::Project::new(id), true);
            state.services.write_file(&oss_path, &bytes).unwrap();
        }

        let url = ws_server(state).await;

        // Open both sockets, each carrying the same admin token. The
        // test is about per-project keying, not multi-tenant auth
        // isolation — both sockets authenticate as the same user but
        // pick different projects.
        let (mut sock_a, _) = tokio_tungstenite::connect_async(format!("{url}?project_id=alpha&token={token}")).await.unwrap();
        let (mut sock_b, _) = tokio_tungstenite::connect_async(format!("{url}?project_id=beta&token={token}")).await.unwrap();

        // Socket A: set a unique preference key to "true".
        sock_a
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"id":1,"method":"engine.execute","params":{"command":"prefs.set","params":{"key":"autoSave.enabled","value":true}}}"#.into(),
            ))
            .await
            .unwrap();
        // Socket B: set the same key to "false".
        sock_b
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"id":1,"method":"engine.execute","params":{"command":"prefs.set","params":{"key":"autoSave.enabled","value":false}}}"#.into(),
            ))
            .await
            .unwrap();

        // Drain both replies — they should each be `ok:true`.
        async fn recv_one(sock: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) -> serde_json::Value {
            match sock.next().await.unwrap().unwrap() {
                tokio_tungstenite::tungstenite::Message::Text(t) => serde_json::from_str(&t).unwrap(),
                other => panic!("expected text reply, got {other:?}"),
            }
        }
        assert_eq!(recv_one(&mut sock_a).await["ok"], true, "A's prefs.set must succeed");
        assert_eq!(recv_one(&mut sock_b).await["ok"], true, "B's prefs.set must succeed");

        // Now read back the key on each side. A must see true, B must see
        // false. If the composite key were broken (i.e. both sockets
        // shared one engine session), whichever `prefs.set` ran last
        // would win both sides.
        sock_a
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"id":2,"method":"engine.execute","params":{"command":"prefs.get","params":{"key":"autoSave.enabled"}}}"#.into(),
            ))
            .await
            .unwrap();
        sock_b
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"id":2,"method":"engine.execute","params":{"command":"prefs.get","params":{"key":"autoSave.enabled"}}}"#.into(),
            ))
            .await
            .unwrap();

        let v_a = recv_one(&mut sock_a).await;
        let v_b = recv_one(&mut sock_b).await;
        assert_eq!(v_a["ok"], true, "A's prefs.get must succeed, got {v_a}");
        assert_eq!(v_b["ok"], true, "B's prefs.get must succeed, got {v_b}");
        assert_eq!(v_a["result"], serde_json::json!(true), "alpha must still see true");
        assert_eq!(v_b["result"], serde_json::json!(false), "beta must still see false");

        sock_a.close(None).await.unwrap();
        sock_b.close(None).await.unwrap();
    }

    // ----- M2.7 WS auth integration tests -------------------------------
    //
    // M2.7: WS upgrade must require a valid `?token=...`. The two
    // unhappy paths below cover the strict policy at the HTTP boundary:
    // missing token → 401, unknown token → 401. The happy-path token
    // round-trip is exercised by the retrofitted
    // `ws_with_valid_project_loads_and_runs_command` above.

    /// Handshake without `?token=` must 401. axum's WebSocket upgrade
    /// runs the handler as an HTTP request before the upgrade, so the
    /// usual HTTP status code path carries through — we read 401 here.
    #[tokio::test]
    async fn ws_without_token_rejects_with_401() {
        let url = ws_server(test_state()).await;
        let err =
            tokio_tungstenite::connect_async(format!("{url}?project_id=anything")).await.expect_err("WS upgrade without token must fail at the handshake");
        // `tungstenite::Error::Http(Box<Response>)` wraps the HTTP
        // response the server returned instead of upgrading. The boxed
        // `Response<Option<Vec<u8>>>` exposes `.status()` for the check.
        match err {
            tokio_tungstenite::tungstenite::Error::Http(resp) => {
                assert_eq!(resp.status().as_u16(), 401, "missing `?token=` must yield 401, got {}", resp.status())
            }
            other => panic!("handshake failure must be HTTP-shaped, got {other:?}"),
        }
    }

    /// Handshake with a `?token=` value the store doesn't recognise must
    /// 401. Same HTTP boundary as the missing-token case; the store
    /// lookup returns `None`, the strict policy turns that into 401.
    #[tokio::test]
    async fn ws_with_invalid_token_rejects_with_401() {
        let url = ws_server(test_state()).await;
        let err = tokio_tungstenite::connect_async(format!("{url}?project_id=anything&token=deadbeef-dead-beef-dead-beefdeadbeef"))
            .await
            .expect_err("WS upgrade with bogus token must fail at the handshake");
        match err {
            tokio_tungstenite::tungstenite::Error::Http(resp) => {
                assert_eq!(resp.status().as_u16(), 401, "invalid `?token=` must yield 401, got {}", resp.status())
            }
            other => panic!("handshake failure must be HTTP-shaped, got {other:?}"),
        }
    }

    // ----- M2.6 auth integration tests ---------------------------------
    //
    // The acceptance contract for the auth layer:
    //  - `/api/v1/auth/login` exchanges valid credentials for a bearer
    //    token; the response carries the user identity in `{id, role}`
    //    shape (matches what `/auth/me` returns later).
    //  - Invalid credentials yield 401 with `{ok:false, error:...}`.
    //  - Protected routes (anything not on the public list) require
    //    `Authorization: Bearer <token>`; missing → 401, bad token →
    //    401, valid token → 200.
    //  - `POST /api/v1/auth/logout` revokes the token; a subsequent
    //    `/auth/me` with the same token yields 401.

    /// Login + token + user envelope. The admin role is hardcoded for
    /// M2.6; once a real user table lands the role will come from the
    /// store, but the JSON shape is fixed.
    #[tokio::test]
    async fn auth_login_with_valid_credentials_returns_token() {
        let resp = app(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"test-pw"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "valid login must yield 200");
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert!(j["token"].as_str().is_some_and(|s| !s.is_empty()), "token must be a non-empty string, got {j}");
        assert_eq!(j["user"]["id"], "admin");
        assert_eq!(j["user"]["role"], "admin");
    }

    /// Wrong password (and wrong username) both yield 401 with a
    /// generic error — we don't leak which field is wrong.
    #[tokio::test]
    async fn auth_login_with_invalid_password_returns_401() {
        let resp = app(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"nope"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "wrong password must yield 401");
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], false);
        assert!(j["error"].as_str().is_some_and(|s| s.contains("invalid")), "error must mention invalid creds, got {j}");
    }

    /// `/auth/me` without a token is the canary for "is my session
    /// alive?" — it must 401 when no `Authorization` header is sent.
    #[tokio::test]
    async fn auth_me_without_token_returns_401() {
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1/auth/me").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], false);
        assert!(j["error"].as_str().unwrap().contains("Bearer"), "error must mention the missing Bearer header, got {j}");
    }

    /// `/auth/me` with a valid token returns the admin user. We exercise
    /// the `Extension<CurrentUser>` extractor end-to-end.
    #[tokio::test]
    async fn auth_me_with_valid_token_returns_admin() {
        let state = test_state();
        let token = login(app(state.clone())).await;
        let resp = app(state).oneshot(with_auth(Request::builder().uri("/api/v1/auth/me").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["user"]["id"], "admin");
        assert_eq!(j["user"]["role"], "admin");
    }

    /// `/auth/me` with a syntactically valid but unknown token → 401.
    /// The middleware calls `store.resolve(token)` which returns
    /// `None` for an unknown UUID.
    #[tokio::test]
    async fn auth_me_with_invalid_token_returns_401() {
        let bogus = "00000000-0000-0000-0000-000000000000";
        let resp = app(test_state()).oneshot(with_auth(Request::builder().uri("/api/v1/auth/me").body(Body::empty()).unwrap(), bogus)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// A protected route hit without a token must 401 (the route is
    /// never reached). `GET /api/v1/projects` is a representative
    /// protected route.
    #[tokio::test]
    async fn protected_route_without_token_returns_401() {
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1/projects").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// Same route, valid token → 200. Confirms the auth layer is the
    /// only thing standing between "no token" and "the actual handler",
    /// not a regression in the handler itself.
    #[tokio::test]
    async fn protected_route_with_valid_token_succeeds() {
        let state = test_state();
        let token = login(app(state.clone())).await;
        let resp = app(state).oneshot(with_auth(Request::builder().uri("/api/v1/projects").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "valid token must reach the handler");
    }

    /// `POST /auth/logout` returns 204 and revokes the bearer token. A
    /// subsequent `/auth/me` with the same token must 401.
    #[tokio::test]
    async fn logout_invalidates_token() {
        let state = test_state();
        let token = login(app(state.clone())).await;

        // Logout.
        let resp = app(state.clone())
            .oneshot(with_auth(Request::builder().method("POST").uri("/api/v1/auth/logout").body(Body::empty()).unwrap(), &token))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT, "logout must yield 204");

        // The revoked token must no longer reach `/auth/me`.
        let resp = app(state).oneshot(with_auth(Request::builder().uri("/api/v1/auth/me").body(Body::empty()).unwrap(), &token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "revoked token must yield 401");
    }
}
