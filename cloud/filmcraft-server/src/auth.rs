//! M2.6 — hardcoded admin auth with a clean upgrade path.
//!
//! Insertion points for future work:
//!  - `AuthStore` trait — swap the backing store (in-mem → DB / OAuth / etc.)
//!  - `UserId` is already a `String` newtype in `session.rs`; only the
//!    `HardcodedAuthStore::authenticate` body needs to change to issue
//!    real `UserId` values once we have a user table.
//!  - `auth_layer` (axum `from_fn_with_state` middleware) — pure,
//!    side-effect free on the request path; just decides "skip / 401 /
//!    insert CurrentUser".
//!
//! Rules (AGENTS.md §0):
//!   - No `unwrap`/`expect`/`panic!`/`unsafe` outside tests.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::session::UserId;

/// Username of the hardcoded admin. M2.6 ships one account; M2.7+ will
/// swap `HardcodedAuthStore` for a real `DbAuthStore` without changing
/// handler signatures.
pub const ADMIN_USER_ID: &str = "admin";

/// Role string returned to the SPA in `/auth/login` and `/auth/me`
/// responses. Kept alongside `ADMIN_USER_ID` so the two literals that
/// identify the admin user don't drift.
pub const ADMIN_ROLE: &str = "admin";

/// Default password when `FILMCRAFT_ADMIN_PASSWORD` is unset. Matches the
/// product brief ("admin / 123456"). Empty env vars fall back to this too
/// (a deliberately-empty password is almost certainly a mistake).
const DEFAULT_ADMIN_PASSWORD: &str = "123456";

/// Resolve the admin password from `FILMCRAFT_ADMIN_PASSWORD` (default
/// `123456`). Mirrors `resolve_listen_addr` / `resolve_store_root` style
/// in `main.rs`.
pub fn resolve_admin_password() -> String {
    std::env::var("FILMCRAFT_ADMIN_PASSWORD").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_ADMIN_PASSWORD.to_string())
}

/// Opaque session token. Stored in `AuthStore`; presented by clients in
/// `Authorization: Bearer <token>`.
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct SessionToken(pub String);

/// Identity resolved from a valid token. Handlers extract this via the
/// `Extension<CurrentUser>` extractor once `auth_layer` has run.
#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub user_id: UserId,
    pub token: SessionToken,
}

impl CurrentUser {
    /// Convenience: build the admin current user from a freshly-issued token.
    pub fn admin(token: SessionToken) -> Self {
        Self { user_id: UserId::new(ADMIN_USER_ID), token }
    }
}

/// AuthStore — the trait a real DB-backed implementation will satisfy.
/// `HardcodedAuthStore` is the M2.6 default; the upgrade path is to
/// provide a `DbAuthStore` that hits SQL and swap the `Arc<dyn AuthStore>`
/// field on `AppState`.
#[async_trait::async_trait]
pub trait AuthStore: Send + Sync + 'static {
    /// Validate `username` + `password`; return the matching `UserId`
    /// on success, `None` on failure.
    async fn authenticate(&self, username: &str, password: &str) -> Option<UserId>;

    /// Look up the user that owns `token`; return `None` if the token
    /// is unknown, revoked or expired.
    async fn resolve(&self, token: &SessionToken) -> Option<UserId>;

    /// Invalidate `token`; return `true` if it was previously valid.
    async fn revoke(&self, token: &SessionToken) -> bool;

    /// Mint a fresh token for `user_id` and record it. Default M2.6
    /// implementation lives on [`HardcodedAuthStore`]; a `DbAuthStore`
    /// will `INSERT INTO sessions(token, user_id) VALUES (...)`.
    async fn issue_token(&self, user_id: UserId) -> SessionToken;
}

/// Single-user in-memory store. Holds the admin password and an
/// active-token map. Restart drops all sessions — acceptable for M2.6.
pub struct HardcodedAuthStore {
    password: String,
    tokens: RwLock<HashMap<SessionToken, UserId>>,
}

impl HardcodedAuthStore {
    pub fn new(password: String) -> Self {
        Self { password, tokens: RwLock::new(HashMap::new()) }
    }

    pub fn shared(password: String) -> Arc<Self> {
        Arc::new(Self::new(password))
    }
}

#[async_trait::async_trait]
impl AuthStore for HardcodedAuthStore {
    async fn authenticate(&self, username: &str, password: &str) -> Option<UserId> {
        if username == ADMIN_USER_ID && password == self.password { Some(UserId::new(ADMIN_USER_ID)) } else { None }
    }

    async fn resolve(&self, token: &SessionToken) -> Option<UserId> {
        self.tokens.read().await.get(token).cloned()
    }

    async fn revoke(&self, token: &SessionToken) -> bool {
        self.tokens.write().await.remove(token).is_some()
    }

    async fn issue_token(&self, user_id: UserId) -> SessionToken {
        let token = SessionToken(Uuid::new_v4().to_string());
        self.tokens.write().await.insert(token.clone(), user_id);
        token
    }
}

/// Issue a new token via the [`AuthStore`] trait. Convenience wrapper
/// around [`AuthStore::issue_token`].
pub async fn issue_token(store: &dyn AuthStore, user_id: UserId) -> SessionToken {
    store.issue_token(user_id).await
}

/// Run the auth check using `store` as the backend. Public path so
/// `main.rs` can wrap it in a `from_fn` closure that captures
/// `Arc<dyn AuthStore>` from `AppState` — sidestepping axum's
/// `from_fn_with_state`, which has trouble with `Arc<dyn Trait>` as
/// state because `dyn AuthStore + 'static` doesn't always satisfy the
/// `L::Service: Service<Request> + Send + Sync + 'static` bound.
///
/// Skips for public paths (login + health + manifest + SPA fallback +
/// WS).
pub async fn run_auth_layer(store: Arc<dyn AuthStore>, mut req: Request, next: Next) -> Response {
    if is_public_path(req.uri().path()) {
        return next.run(req).await;
    }
    let token = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|s| s.strip_prefix("Bearer ")).map(|t| SessionToken(t.to_string()));
    let Some(token) = token else {
        return unauthorized("missing Authorization: Bearer <token>");
    };
    match store.resolve(&token).await {
        Some(uid) => {
            req.extensions_mut().insert(CurrentUser { user_id: uid, token });
            next.run(req).await
        }
        None => unauthorized("invalid or expired token"),
    }
}

/// Public paths that skip authentication: the API doc, health, login,
/// the WebSocket upgrade, and anything outside `/api/v1/...` (the SPA
/// fallback).
///
/// Note: `/api/v1/auth/me` is intentionally NOT public — it's the canary
/// for "is my token still valid?". `auth_layer` only inserts
/// `CurrentUser` when a valid token is presented; if no token is
/// presented, `me` returns 401.
///
/// `/api/v1/ws` is public for now because browsers can't easily attach
/// `Authorization` headers to a WebSocket handshake; M2.7's
/// `validate_ws_token` will read `?token=...` from the URL instead.
fn is_public_path(path: &str) -> bool {
    matches!(path, "/api/v1" | "/api/v1/health" | "/api/v1/auth/login" | "/api/v1/ws") || !path.starts_with("/api/v1/")
}

fn unauthorized(msg: &str) -> Response {
    // Mirror `ServerError::BadRequest` style: 401 + {"ok":false,"error":...}.
    // We return the JSON directly so the `auth_layer` middleware does not
    // need to depend on `ServerError`'s `IntoResponse`.
    (StatusCode::UNAUTHORIZED, Json(json!({ "ok": false, "error": msg }))).into_response()
}

// ---- handlers ----

#[derive(Deserialize)]
pub struct LoginBody {
    pub username: String,
    pub password: String,
}

/// `POST /api/v1/auth/login` — exchange username + password for a
/// session token. The response always uses the same JSON envelope the
/// rest of the API does (`{"ok": true/false, ...}`).
pub async fn login_handler(State(store): State<Arc<dyn AuthStore>>, Json(body): Json<LoginBody>) -> Response {
    match store.authenticate(&body.username, &body.password).await {
        Some(uid) => {
            let token = issue_token(&*store, uid.clone()).await;
            (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "token": token.0,
                    "user": { "id": uid.0, "role": ADMIN_ROLE }
                })),
            )
                .into_response()
        }
        None => (StatusCode::UNAUTHORIZED, Json(json!({ "ok": false, "error": "invalid username or password" }))).into_response(),
    }
}

/// `GET /api/v1/auth/me` — return the user that owns the bearer token.
/// Useful as a "is my session still alive?" probe from the SPA on page
/// load.
pub async fn me_handler(axum::Extension(user): axum::Extension<CurrentUser>) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "user": { "id": user.user_id.0, "role": ADMIN_ROLE }
    }))
}

/// `POST /api/v1/auth/logout` — revoke the bearer token. Returns 204
/// whether or not the token was previously valid (idempotent).
pub async fn logout_handler(State(store): State<Arc<dyn AuthStore>>, axum::Extension(user): axum::Extension<CurrentUser>) -> Response {
    store.revoke(&user.token).await;
    (StatusCode::NO_CONTENT,).into_response()
}

/// M2.6 placeholder: WebSocket upgrade is still anonymous. When M2.7
/// wires real auth, this function returns the `UserId` from
/// `?token=...` (or the `Sec-WebSocket-Protocol` header). The WS
/// handler itself is unchanged — only the `UserId` passed to
/// `ProjectKey` moves.
///
/// Returning `None` for now keeps the WS path anonymous (matches the
/// pre-M2.6 behaviour); the only call site is `ws_upgrade` in `main.rs`.
pub fn validate_ws_token(_headers: &HeaderMap, _query: Option<&str>) -> Option<UserId> {
    // M2.7: parse `query` for `token=...` (URL-decode), call
    // `store.resolve(...)`, return the resulting UserId.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(pw: &str) -> HardcodedAuthStore {
        HardcodedAuthStore::new(pw.to_string())
    }

    #[tokio::test]
    async fn authenticate_admin_with_correct_password_succeeds() {
        let s = store_with("123456");
        assert_eq!(s.authenticate("admin", "123456").await, Some(UserId::new("admin")));
    }

    #[tokio::test]
    async fn authenticate_admin_with_wrong_password_fails() {
        let s = store_with("123456");
        assert!(s.authenticate("admin", "nope").await.is_none());
        // Wrong username with the right password must also fail.
        assert!(s.authenticate("root", "123456").await.is_none());
    }

    #[tokio::test]
    async fn resolve_issued_token_returns_user_id() {
        let s = store_with("123456");
        let token = issue_token(&s, UserId::new("admin")).await;
        assert_eq!(s.resolve(&token).await, Some(UserId::new("admin")));
    }

    #[tokio::test]
    async fn revoke_invalidates_token() {
        let s = store_with("123456");
        let token = issue_token(&s, UserId::new("admin")).await;
        assert!(s.resolve(&token).await.is_some());
        assert!(s.revoke(&token).await, "revoke must report the token was present");
        assert!(s.resolve(&token).await.is_none(), "resolve must return None after revoke");
        // Revoking again is idempotent (returns false, no panic).
        assert!(!s.revoke(&token).await);
    }

    #[tokio::test]
    async fn resolve_after_restart_fails() {
        // A fresh store has no token map; a token issued against the old
        // store is unknown to the new one. Mirrors the "server restart
        // drops all sessions" contract.
        let s1 = store_with("123456");
        let token = issue_token(&s1, UserId::new("admin")).await;
        let s2 = store_with("123456");
        assert!(s2.resolve(&token).await.is_none());
    }

    #[test]
    fn default_password_is_123456() {
        // The default path is fully covered here; env-override behaviour
        // is exercised by the E2E harness (`FILMCRAFT_ADMIN_PASSWORD=…`
        // case in `scripts/dev/smoke.sh` style manual checks) and
        // smoke-tested in CI without touching `std::env` directly from
        // a test (which would be racy in `--test-threads=N` runs).
        // We deliberately don't call `set_var` / `remove_var` from a
        // unit test: the workspace forbids `unsafe`, and `std::env::*`
        // is now marked unsafe, so this would force a per-crate mutex
        // we don't want.
        assert_eq!(resolve_admin_password(), "123456");
    }
}
