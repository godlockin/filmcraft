//! Server-wide error type. Every fallible path in `filmcraft-server` produces
//! a `Result<T, ServerError>`; the HTTP layer maps it to a status code.

use std::io;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Errors that can occur in the server. `Display` is what gets logged; what
/// reaches the client is a sanitised JSON body.
#[derive(Debug)]
pub enum ServerError {
    /// An object-store operation failed. We log the path; the client sees a
    /// generic message and a status code derived from the underlying io error.
    Store { path: String, source: io::Error },
    /// A request path or parameter was malformed.
    BadRequest(String),
    /// The client asked for something that does not exist (user, project, media).
    NotFound(String),
    /// Something the engine refused.
    Engine(String),
    /// An internal error we did not expect. Logged at `error!`, never exposed
    /// verbatim to the client.
    Internal(String),
    /// M2.6: the caller is not authenticated, or their credentials are
    /// invalid. `auth_layer` builds its 401 response directly (it has to
    /// short-circuit before any handler runs), so this variant is here
    /// for future handlers that want to use `?` chaining instead of
    /// returning `Response` by hand.
    Unauthorized(String),
}

impl std::fmt::Display for ServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store { path, source } => write!(f, "store error on {path:?}: {source}"),
            Self::BadRequest(s) => write!(f, "bad request: {s}"),
            Self::NotFound(s) => write!(f, "not found: {s}"),
            Self::Engine(s) => write!(f, "engine: {s}"),
            Self::Internal(s) => write!(f, "internal error: {s}"),
            Self::Unauthorized(s) => write!(f, "unauthorized: {s}"),
        }
    }
}

impl std::error::Error for ServerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Store { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl ServerError {
    fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Store { source, .. } => match source.kind() {
                io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                io::ErrorKind::InvalidInput | io::ErrorKind::PermissionDenied => StatusCode::BAD_REQUEST,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
            Self::Engine(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
        }
    }
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        // Log everything; only the safe fields reach the wire.
        tracing::error!(error = %self, "request failed");
        let status = self.status();
        let body = match &self {
            Self::Internal(_) => json!({ "ok": false, "error": "internal server error" }),
            Self::Store { .. } => json!({ "ok": false, "error": self.to_string() }),
            other => json!({ "ok": false, "error": other.to_string() }),
        };
        (status, Json(body)).into_response()
    }
}

pub type Result<T> = std::result::Result<T, ServerError>;

/// Map an `io::Error` from the object store to the right HTTP-facing
/// `ServerError`. Used by every HTTP handler that touches the store so the
/// `ErrorKind`-based policy lives in exactly one place.
///
/// Policy: `NotFound` → `NotFound(path)`; `InvalidInput` / `PermissionDenied`
/// (e.g. illegal filename characters slipping past validation) → `BadRequest`;
/// everything else → `Store { path, source }` (500 by default).
pub fn map_store_io_error(path: String, e: io::Error) -> ServerError {
    match e.kind() {
        io::ErrorKind::NotFound => ServerError::NotFound(path),
        io::ErrorKind::InvalidInput | io::ErrorKind::PermissionDenied => ServerError::BadRequest(format!("{path}: {e}")),
        _ => ServerError::Store { path, source: e },
    }
}
