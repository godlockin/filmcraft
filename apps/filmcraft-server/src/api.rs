//! Project-aware HTTP API for FilmCraft.
//!
//! Built on top of the lower-level `/api/v1/store/{key}` endpoint from M1.3:
//! this module adds:
//!
//!   - **Media upload** (`POST /api/v1/projects/{project_id}/media`) with a
//!     configurable body cap (200 MiB default), a content-type sniff, and a
//!     well-defined key namespace.
//!   - **Media listing** (`GET /api/v1/projects/{project_id}/media`).
//!   - **Media streaming** (`GET /api/v1/projects/{project_id}/media/{filename}`)
//!     with `Range` support for `<video>` seeking (M1.7).
//!   - **Project CRUD** (`GET/POST/DELETE /api/v1/projects[/...]`, M1.7).
//!   - **Project download** (`GET /api/v1/projects/{project_id}/export.fcproj`)
//!     which is the current project file. Real export-to-mp4 is deferred to
//!     M1.11.
//!
//! All paths are resolved through [`OssServices::resolve`], so `..` and other
//! traversal tricks are rejected the same way as the raw store endpoints.
//!
//! Rules (AGENTS.md §0):
//!   - No `unwrap`/`expect`/`panic!`/`unsafe`.
//!   - Hostile paths and inputs: validate, never trust.
//!
//! References: `docs/filmcraft-server.md` §3.3.4 (planned API), §5.1 (M1.6).

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use filmcraft_engine::Services;
use serde::Serialize;
use serde_json::json;
use tracing::warn;

use crate::error::{Result, ServerError, map_store_io_error};

pub mod media;
pub mod paths;
pub mod projects;
pub mod sniff;

pub use paths::{current_project_path, media_dir_key, media_path, validate_component};
pub use sniff::{looks_like_known_other, looks_like_mp4, sniff_content_type};

/// Maximum upload size in bytes (200 MiB). Plenty for typical source clips;
/// anything larger goes through the dedicated FC worker (M3). Sized so a
/// reasonably small chunk of a long video can be imported directly from the
/// web UI without crashing the server.
pub const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

#[derive(Clone)]
pub struct ApiState {
    pub services: std::sync::Arc<crate::services::OssServices>,
    pub user_id: crate::UserId,
}

impl ApiState {
    pub fn new(services: std::sync::Arc<crate::services::OssServices>, user_id: crate::UserId) -> Self {
        Self { services, user_id }
    }
}

/// POST /api/v1/projects/{project_id}/media
///
/// Accepts a raw request body (octet-stream). The media filename is
/// supplied via the `X-Filename` header (or `filename` query parameter).
/// The body is stored at
/// `oss://filmcraft/users/{user_id}/projects/{project_id}/media/{filename}`
/// after a minimal media-kind sniff.
pub async fn upload_media(State(api): State<ApiState>, Path(project_id): Path<String>, headers: HeaderMap, body: axum::body::Bytes) -> Result<Response> {
    validate_component("projects", &project_id)?;

    let filename = if let Some(v) = headers.get("x-filename").and_then(|v| v.to_str().ok()) {
        validate_component("filename", v)?;
        v.to_string()
    } else if let Some(v) = headers.get("content-disposition").and_then(|v| v.to_str().ok()).and_then(parse_content_disposition_filename) {
        validate_component("filename", &v)?;
        v
    } else {
        "unnamed.mp4".to_string()
    };

    if body.is_empty() {
        return Err(ServerError::BadRequest("empty body".into()));
    }
    if body.len() > MAX_UPLOAD_BYTES {
        return Err(ServerError::BadRequest(format!("upload larger than {MAX_UPLOAD_BYTES} bytes")));
    }
    if !looks_like_mp4(&body) && !looks_like_known_other(&body) {
        warn!(
            user = %api.user_id.0, project = %project_id, filename = %filename,
            size = body.len(), "upload did not match any known media container",
        );
        // Continue: the engine's import step is the source of truth for
        // format support; this endpoint is just a transport.
    }

    let oss_path = media_path(&api.user_id.0, &project_id, &filename);
    api.services.write_file(&oss_path, &body).map_err(|e| map_store_io_error(oss_path.clone(), e))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "key": media_dir_key(&api.user_id.0, &project_id),
            "name": filename,
            "size": body.len(),
            "url": format!("/api/v1/store/projects/{project_id}/media/{filename}"),
        })),
    )
        .into_response())
}

/// GET /api/v1/projects/{project_id}/media
pub async fn list_media(State(api): State<ApiState>, Path(project_id): Path<String>) -> Result<Response> {
    validate_component("projects", &project_id)?;
    let dir = format!("oss://filmcraft/{}", media_dir_key(&api.user_id.0, &project_id));
    let items = match api.services.list_dir(&dir) {
        Some(Ok(v)) => v,
        Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Some(Err(e)) => return Err(map_store_io_error(dir, e)),
        None => return Err(ServerError::Internal("list_dir unsupported".into())),
    };
    Ok((
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "project": project_id,
            "items": items,
        })),
    )
        .into_response())
}

/// GET /api/v1/projects/{project_id}/export.fcproj
///
/// Streams the current `.fcproj` project file as a download. This is what
/// the M1.6 acceptance test calls the "export": for M1.6 the export is the
/// project file itself (importable in the desktop app, see M1.8). A real
/// rendered video export is M1.11.
pub async fn download_project(State(api): State<ApiState>, Path(project_id): Path<String>) -> Result<Response> {
    validate_component("projects", &project_id)?;
    let path = current_project_path(&api.user_id.0, &project_id);
    match api.services.read_file(&path) {
        Ok(bytes) => {
            let disposition = format!("attachment; filename=\"{project_id}.fcproj\"");
            let mut headers = HeaderMap::new();
            headers.insert(axum::http::header::CONTENT_TYPE, OCTET_STREAM);
            match HeaderValue::from_str(&disposition) {
                Ok(v) => {
                    headers.insert(axum::http::header::CONTENT_DISPOSITION, v);
                    Ok((StatusCode::OK, headers, Body::from(bytes)).into_response())
                }
                Err(_) => Err(ServerError::Internal(format!("invalid content-disposition: {disposition:?}"))),
            }
        }
        Err(e) => Err(map_store_io_error(path, e)),
    }
}

/// Pre-computed `application/octet-stream` header. `HeaderValue::from_static`
/// is a `const fn`, so this is allocated at compile time and panics would be
/// caught by the build, not the runtime.
const OCTET_STREAM: HeaderValue = HeaderValue::from_static("application/octet-stream");

/// GET /api/v1/projects/{project_id}/fcproj
///
/// Returns the project's raw `.fcproj` bytes *without* a
/// `Content-Disposition: attachment` header so a future Zustand store (or
/// any in-process client) can `JSON.parse` the body straight from
/// `fetch().arrayBuffer()`.
///
/// `current.fcproj` is read through `OssServices::read_file` so we share the
/// same I/O path and the same `map_store_io_error` translation as
/// `download_project` (the attachment variant).
///
/// Distinct from the auto-load error in [`crate::ws`]: a freshly-created
/// project (M1.7's `POST /projects` writes the directory but not always
/// `current.fcproj`) yields a 404 with a clear JSON error rather than a
/// 500.
pub async fn get_fcproj(State(api): State<ApiState>, Path(project_id): Path<String>) -> Result<Response> {
    validate_component("projects", &project_id)?;
    let path = current_project_path(&api.user_id.0, &project_id);
    match api.services.read_file(&path) {
        Ok(bytes) => {
            let mut headers = HeaderMap::new();
            headers.insert(axum::http::header::CONTENT_TYPE, OCTET_STREAM);
            Ok((StatusCode::OK, headers, Body::from(bytes)).into_response())
        }
        // 404 on a missing `.fcproj` so a freshly-created project (M1.7's
        // `POST /projects` writes the dir but not the file in the no-save
        // case) gets a clear JSON error instead of a generic 5xx. Anything
        // else propagates through the standard mapper.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ServerError::NotFound(format!("project `{project_id}` has no saved fcproj yet"))),
        Err(e) => Err(map_store_io_error(path, e)),
    }
}

/// GET /api/v1/projects/{project_id}/export
#[derive(Serialize)]
struct ExportInfo {
    ok: bool,
    project: String,
    download: ExportDownload,
    metadata: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct ExportDownload {
    url: String,
    kind: &'static str,
}

pub async fn export_info(_: State<ApiState>, Path(project_id): Path<String>) -> Result<Response> {
    validate_component("projects", &project_id)?;
    let info = ExportInfo {
        ok: true,
        project: project_id.clone(),
        download: ExportDownload { url: format!("/api/v1/projects/{project_id}/export.fcproj"), kind: "fcproj" },
        metadata: None,
    };
    Ok((StatusCode::OK, Json(info)).into_response())
}

fn parse_content_disposition_filename(value: &str) -> Option<String> {
    for part in value.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename=") {
            let trimmed = rest.trim_matches('"');
            return Some(trimmed.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_path_is_well_formed() {
        assert_eq!(media_path("alice", "demo", "clip.mp4"), "oss://filmcraft/users/alice/projects/demo/media/clip.mp4");
        assert_eq!(current_project_path("alice", "demo"), "oss://filmcraft/users/alice/projects/demo/current.fcproj");
    }

    #[test]
    fn validate_component_delegates_to_paths_module() {
        assert!(validate_component("x", "").is_err());
        assert!(validate_component("x", "a/b").is_err());
        assert!(validate_component("x", "ok.mp4").is_ok());
    }

    #[test]
    fn sniff_helpers_are_exported() {
        let mut mp4 = vec![0u8; 32];
        mp4[4..8].copy_from_slice(b"ftyp");
        assert!(looks_like_mp4(&mp4));
        assert!(!looks_like_mp4(&[0u8; 8]));
    }
}
