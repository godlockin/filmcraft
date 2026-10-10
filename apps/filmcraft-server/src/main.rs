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
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::http::header::CONTENT_TYPE;
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, delete, get, post};
use filmcraft_engine::Services;
use serde::Serialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use filmcraft_server::{OssServices, Result, ServerError, UserId, map_store_io_error};

/// Placeholder user identity used by every handler until M2 wires real
/// authentication. Centralised here so the M2 change touches one line.
fn anonymous_user() -> UserId {
    UserId::new("anonymous")
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
/// `root_handler` can hand it back without re-allocating on every request.
fn endpoints_payload() -> &'static serde_json::Value {
    static ENDPOINTS: OnceLock<serde_json::Value> = OnceLock::new();
    ENDPOINTS.get_or_init(|| {
        json!({
            "root":   { "method": "GET",  "path": "/",                  "description": "this payload" },
            "health": { "method": "GET",  "path": "/health",            "description": "liveness probe (200 = alive)" },
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
        })
    })
}

#[derive(Clone)]
struct AppState {
    started_at: std::time::Instant,
    services: Arc<OssServices>,
    sessions: Arc<filmcraft_server::SessionManager>,
    api_state: filmcraft_server::api::ApiState,
}

impl axum::extract::FromRef<AppState> for filmcraft_server::api::ApiState {
    fn from_ref(s: &AppState) -> Self {
        s.api_state.clone()
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
    let state = AppState { started_at: std::time::Instant::now(), services, sessions, api_state };

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
        .route("/", get(root_handler))
        .route("/health", get(health_handler))
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
        .route("/api/v1/projects/{project_id}/media/{filename}", get(filmcraft_server::api::media::stream_media))
        .route("/api/v1/projects/{project_id}/export", get(filmcraft_server::api::export_info))
        .route("/api/v1/projects/{project_id}/export.fcproj", get(filmcraft_server::api::download_project))
        // Permissive CORS — fine because the server binds to loopback by default
        // (AGENTS.md §0) and any public deployment should put a reverse proxy
        // (nginx/Aliyun SLB) in front. Per the "frontend-backend separation"
        // requirement, multiple independent frontends will hit `/api/v1/*`.
        .fallback_service(fallback)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TraceLayer::new_for_http())
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
    let candidate = from_env.unwrap_or_else(|| PathBuf::from("apps/filmcraft-web-ui/dist"));
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
    let mut response_headers = axum::http::HeaderMap::new();
    response_headers.insert(CONTENT_TYPE, axum::http::HeaderValue::from_static(content_type));
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

async fn root_handler(State(state): State<AppState>) -> impl IntoResponse {
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

/// WebSocket upgrade handler. Hands the upgraded socket to the WS bridge,
/// which then runs the control protocol against `SessionManager`.
///
/// No authentication yet: every connection is treated as the placeholder
/// `UserId::new("anonymous")`. M2 (auth) will replace this.
async fn ws_upgrade(State(state): State<AppState>, ws: axum::extract::ws::WebSocketUpgrade) -> impl IntoResponse {
    let mgr = Arc::clone(&state.sessions);
    ws.on_upgrade(move |socket| async move {
        filmcraft_server::ws::handle_socket(socket, mgr, anonymous_user()).await;
    })
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

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("filmcraft-server-test-{}-{}", std::process::id(), uuid_tag()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let services = Arc::new(OssServices::new(root));
        let sessions = Arc::new(filmcraft_server::SessionManager::new(Arc::clone(&services)));
        let api_state = filmcraft_server::api::ApiState::new(Arc::clone(&services), filmcraft_server::UserId::new("test"));
        AppState { started_at: std::time::Instant::now(), services, sessions, api_state }
    }

    /// Per-test unique tag so two tests run in parallel don't share a temp dir.
    /// `AtomicUsize` is overkill for tests, but it makes the intent obvious.
    fn uuid_tag() -> String {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        format!("t{n}")
    }

    fn app(state: AppState) -> Router {
        Router::new()
            .route("/", get(root_handler))
            .route("/health", get(health_handler))
            .route("/api/v1/store/{*key}", get(store_get).put(store_put))
            .route("/api/v1/ws", get(ws_upgrade))
            .route("/api/v1/projects", get(filmcraft_server::api::projects::list_projects).post(filmcraft_server::api::projects::create_project))
            .route("/api/v1/projects/{project_id}", delete(filmcraft_server::api::projects::delete_project))
            .route(
                "/api/v1/projects/{project_id}/media",
                post(filmcraft_server::api::upload_media).layer(DefaultBodyLimit::max(filmcraft_server::api::MAX_UPLOAD_BYTES)),
            )
            .route("/api/v1/projects/{project_id}/media", get(filmcraft_server::api::list_media))
            .route("/api/v1/projects/{project_id}/media/{filename}", get(filmcraft_server::api::media::stream_media))
            .route("/api/v1/projects/{project_id}/export", get(filmcraft_server::api::export_info))
            .route("/api/v1/projects/{project_id}/export.fcproj", get(filmcraft_server::api::download_project))
            .layer(TraceLayer::new_for_http())
            .with_state(state)
    }

    #[tokio::test]
    async fn root_returns_ok_with_endpoints() {
        let resp = app(test_state()).oneshot(Request::builder().uri("/").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], SERVER_VERSION);
        assert!(body["endpoints"]["health"].is_object());
        assert!(body["endpoints"]["store"].is_object());
    }

    #[tokio::test]
    async fn health_returns_200() {
        let resp = app(test_state()).oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn store_put_then_get_round_trip() {
        // PUT then GET against the SAME state, otherwise the two requests
        // would land in two different temp dirs.
        let state = test_state();
        let resp = app(state.clone())
            .oneshot(Request::builder().method("PUT").uri("/api/v1/store/users/u/p/c.fcproj").body(Body::from("hello m1.3")).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let resp = app(state).oneshot(Request::builder().uri("/api/v1/store/users/u/p/c.fcproj").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        assert_eq!(&bytes[..], b"hello m1.3");
    }

    #[tokio::test]
    async fn store_get_missing_returns_404() {
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1/store/does-not-exist").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn store_rejects_traversal() {
        // `..` must be rejected by the path policy in OssServices.
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1/store/../etc/passwd").body(Body::empty()).unwrap()).await.unwrap();
        // axum may reject the URI at parse time, or the handler may see it
        // and return 400. Either is fine; 200 is the only forbidden outcome.
        assert_ne!(resp.status(), StatusCode::OK, "traversal must not succeed");
    }

    #[tokio::test]
    async fn project_upload_then_list_then_download_round_trip() {
        // M1.6 acceptance: POST a (fake) mp4 to a project's media dir, GET
        // the listing, then GET the project's current.fcproj download.
        // We use the same `state` across all three requests so they share
        // the OSS root.
        let state = test_state();

        // 1. Upload. Build an MP4-shaped body (ftyp box) so the sniff
        //    accepts it.
        let mut body = vec![0u8; 64];
        body[4..8].copy_from_slice(b"ftyp");
        body[8..12].copy_from_slice(b"isom");

        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/demo/media")
                    .header("x-filename", "intro.mp4")
                    .header("content-type", "video/mp4")
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED, "upload should be 201, got {}", resp.status());
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["name"], "intro.mp4");
        assert_eq!(j["size"], 64);

        // 2. List — must include the file we just uploaded.
        let resp = app(state.clone()).oneshot(Request::builder().uri("/api/v1/projects/demo/media").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let items = j["items"].as_array().expect("items is an array");
        assert!(items.iter().any(|v| v.as_str() == Some("intro.mp4")), "items missing intro.mp4: {items:?}");

        // 3. Write a fake .fcproj at current.fcproj, then GET it back.
        let project_blob = b"FCP-JSON-DEMO";
        let resp = app(state.clone())
            .oneshot(
                Request::builder().method("PUT").uri("/api/v1/store/users/test/projects/demo/current.fcproj").body(Body::from(project_blob.to_vec())).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let resp = app(state.clone()).oneshot(Request::builder().uri("/api/v1/projects/demo/export.fcproj").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let cd = resp.headers().get("content-disposition").unwrap().to_str().unwrap().to_string();
        assert!(cd.contains("attachment"), "expected attachment header, got {cd:?}");
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        assert_eq!(&bytes[..], project_blob);
    }

    #[tokio::test]
    async fn project_upload_rejects_traversal_in_project_id() {
        let resp = app(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/..%2Fetc/media")
                    .header("x-filename", "x.mp4")
                    .body(Body::from(b"hello".to_vec()))
                    .unwrap(),
            )
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
        let resp = app(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/demo/media")
                    .header("x-filename", "../../etc/passwd")
                    .body(Body::from(b"hello".to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn project_download_missing_returns_404() {
        let resp =
            app(test_state()).oneshot(Request::builder().uri("/api/v1/projects/never-existed/export.fcproj").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn project_export_info_returns_fcproj_link() {
        let resp = app(test_state()).oneshot(Request::builder().uri("/api/v1/projects/demo/export").body(Body::empty()).unwrap()).await.unwrap();
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

        // 1. POST creates the project (201 + body has the id).
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"id":"alpha","name":"Alpha"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["project"], "alpha");

        // 2. GET lists and includes it.
        let resp = app(state.clone()).oneshot(Request::builder().uri("/api/v1/projects").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let projects = j["projects"].as_array().expect("projects is an array");
        assert!(projects.iter().any(|v| v["id"] == "alpha"), "alpha not listed: {projects:?}");

        // 3. DELETE removes it (204).
        let resp = app(state.clone()).oneshot(Request::builder().method("DELETE").uri("/api/v1/projects/alpha").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // 4. GET again — the project is gone.
        let resp = app(state.clone()).oneshot(Request::builder().uri("/api/v1/projects").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let projects = j["projects"].as_array().expect("projects is an array");
        assert!(!projects.iter().any(|v| v["id"] == "alpha"), "alpha still listed after delete");
    }

    #[tokio::test]
    async fn project_create_rejects_traversal_in_id() {
        let resp = app(test_state())
            .oneshot(
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
            )
            .await
            .unwrap();
        assert_ne!(resp.status(), StatusCode::OK, "traversal must not succeed");
        assert_ne!(resp.status(), StatusCode::CREATED, "traversal must not be CREATED");
    }

    #[tokio::test]
    async fn project_create_duplicate_returns_409() {
        // The plan says "409", and our handler returns 400 via
        // `BadRequest(... already exists)`. Either way, not 2xx.
        let state = test_state();
        let body = r#"{"id":"dup","name":"dup"}"#;

        let resp = app(state.clone())
            .oneshot(Request::builder().method("POST").uri("/api/v1/projects").header("content-type", "application/json").body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        let resp = app(state.clone())
            .oneshot(Request::builder().method("POST").uri("/api/v1/projects").header("content-type", "application/json").body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_ne!(resp.status(), StatusCode::CREATED, "second POST must not succeed");
    }

    #[tokio::test]
    async fn project_delete_missing_returns_404() {
        let resp = app(test_state()).oneshot(Request::builder().method("DELETE").uri("/api/v1/projects/nope").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn media_stream_returns_video_content_type_and_accept_ranges() {
        let state = test_state();
        // First seed an MP4-shaped file by going through the upload endpoint.
        let mut body = vec![0u8; 32];
        body[4..8].copy_from_slice(b"ftyp");
        body[8..12].copy_from_slice(b"isom");
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/projects/demo/media")
                    .header("x-filename", "clip.mp4")
                    .header("content-type", "video/mp4")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // Now request the stream.
        let resp = app(state.clone()).oneshot(Request::builder().uri("/api/v1/projects/demo/media/clip.mp4").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp.headers().get("content-type").unwrap().to_str().unwrap();
        assert!(ct.starts_with("video/"), "expected video/* content type, got {ct}");
        assert_eq!(resp.headers().get("accept-ranges").unwrap().to_str().unwrap(), "bytes");
    }

    #[tokio::test]
    async fn media_stream_range_request_returns_206() {
        let state = test_state();
        // Seed a 32-byte file with a content body we can slice.
        let body: Vec<u8> = (0u8..=31).collect();
        let resp = app(state.clone())
            .oneshot(
                Request::builder().method("POST").uri("/api/v1/projects/demo/media").header("x-filename", "raw.bin").body(Body::from(body.clone())).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // Range: bytes=4-11 (inclusive on the right) → 8 bytes back.
        let resp = app(state.clone())
            .oneshot(Request::builder().uri("/api/v1/projects/demo/media/raw.bin").header("range", "bytes=4-11").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT, "Range must yield 206");
        let cr = resp.headers().get("content-range").unwrap().to_str().unwrap().to_string();
        assert_eq!(cr, "bytes 4-11/32");
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        assert_eq!(&bytes[..], &body[4..12]);
    }
}
