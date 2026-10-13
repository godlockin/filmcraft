//! Project management HTTP handlers (M1.7).
//!
//! Each per-user "project" lives at:
//!   `oss://filmcraft/users/{user}/projects/{project_id}/`
//! with three artefacts under it:
//!   * `current.fcproj` — the project file (FilmCraft format via
//!     `filmcraft_format::encode`).
//!   * `meta.json` — lightweight bookkeeping (name, latest_rev, lock state).
//!   * `media/` — uploaded source clips.
//!
//! Endpoints:
//!   GET    /api/v1/projects                  — list (id, name, updatedAt, size)
//!   POST   /api/v1/projects                  — create
//!   DELETE /api/v1/projects/{project_id}     — remove
//!
//! All path components are validated at the boundary (`validate_component`)
//! and again by the OSS resolver, so `..` cannot escape the bucket.

use std::fs;
use std::path::Path;

use axum::Json;
use axum::extract::Path as AxumPath;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use filmcraft_engine::Services;
use filmcraft_format::encode;
use filmcraft_project::Project;
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use crate::error::{Result, ServerError, map_store_io_error};

use super::paths::{current_project_path, meta_path, project_dir_path, user_projects_dir, validate_component};

/// Light bookkeeping persisted alongside the `.fcproj`. Failures to read or
/// parse this are treated as "the field is missing" rather than as errors —
/// a corrupt `meta.json` must not stop us from showing the project in the
/// list (it's recoverable from the `.fcproj` itself).
#[derive(Deserialize)]
struct MetaJson {
    name: Option<String>,
    #[serde(rename = "lastEditedAt", alias = "last_edited_at")]
    last_edited_at: Option<String>,
}

/// Body for `POST /api/v1/projects`.
#[derive(Deserialize)]
pub struct CreateProjectBody {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// GET /api/v1/projects
///
/// Lists every project for the user. Each entry has the project id, the
/// display name (best-effort), the directory size on disk (in bytes), and
/// the most recent `last_edited_at` recorded in `meta.json`.
///
/// `NotFound` from the OSS layer maps to an empty project (a user who has
/// never created a project). Anything else propagates as a 500.
pub async fn list_projects(api: super::ApiState) -> Result<Response> {
    let dir = user_projects_dir(&api.user_id.0);
    let names = match api.services.list_dir(&dir) {
        Some(Ok(v)) => v,
        Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Some(Err(e)) => return Err(map_store_io_error(dir, e)),
        None => return Err(ServerError::Internal("list_dir unsupported".into())),
    };

    let mut projects = Vec::with_capacity(names.len());
    for name in names {
        // Reject anything that wouldn't survive `validate_component`; in
        // practice the resolver's `..` check already guards this, but a
        // stray dotfile from a buggy client shouldn't crash the list.
        if validate_component("project", &name).is_err() {
            continue;
        }
        let project_path = current_project_path(&api.user_id.0, &name);
        let meta = meta_path(&api.user_id.0, &name);

        // One read + one parse per project. A missing or malformed
        // `meta.json` collapses both fields to `null` (the project still
        // opens from `.fcproj`).
        let (display_name, updated_at) = api
            .services
            .read_file(&meta)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<MetaJson>(&bytes).ok())
            .map(|m| (m.name, m.last_edited_at))
            .unwrap_or((None, None));

        let size = api.services.file_size(&project_path).ok();

        projects.push(json!({
            "id": name,
            "name": display_name,
            "updatedAt": updated_at,
            "size": size,
        }));
    }

    Ok((StatusCode::OK, Json(json!({ "ok": true, "projects": projects }))).into_response())
}

/// POST /api/v1/projects
///
/// Creates an empty project on disk. Steps:
/// 1. Validate `id` and (optional) `name`.
/// 2. Reject if the project directory already exists (`409`).
/// 3. Write `current.fcproj` (serialised empty `Project`).
/// 4. Write `meta.json` (name + zeroed bookkeeping).
/// 5. Return `201 Created` with the project id.
pub async fn create_project(api: super::ApiState, Json(body): Json<CreateProjectBody>) -> Result<Response> {
    validate_component("id", &body.id)?;
    if let Some(name) = &body.name {
        validate_component("name", name)?;
    }

    // Pre-flight: refuse to clobber. We probe `current.fcproj` because the
    // directory itself may not exist yet (`write_file` will `create_dir_all`
    // it); a probe of the project file tells us whether someone beat us to
    // it without paying for a directory `list_dir`.
    let proj_file = current_project_path(&api.user_id.0, &body.id);
    match api.services.file_size(&proj_file) {
        Ok(_) => return Err(ServerError::BadRequest(format!("project `{0}` already exists", body.id))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(map_store_io_error(proj_file, e)),
    }

    // 1. Write the empty `.fcproj`.
    let name = body.name.as_deref().unwrap_or(&body.id);
    let bytes = encode(&Project::new(name), true);
    api.services.write_file(&proj_file, &bytes).map_err(|e| map_store_io_error(proj_file.clone(), e))?;

    // 2. Write `meta.json`. A failure here is unfortunate but not fatal;
    //    the project still opens from `.fcproj`. Log and continue.
    let meta = json!({
        "latest_rev": 0,
        "locked_by": serde_json::Value::Null,
        "locked_at": serde_json::Value::Null,
        "last_edited_at": serde_json::Value::Null,
        "name": name,
    });
    let meta_bytes = serde_json::to_vec(&meta).unwrap_or_default();
    let meta_path_str = meta_path(&api.user_id.0, &body.id);
    if let Err(e) = api.services.write_file(&meta_path_str, &meta_bytes) {
        warn!(user = %api.user_id.0, project = %body.id, error = %e, "failed to write meta.json (project still created)");
    }

    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "project": body.id }))).into_response())
}

/// DELETE /api/v1/projects/{project_id}
///
/// Removes the whole project directory. We translate from OSS key to local
/// path via the resolver's accessor so the same `..`/`ParentDir` guard
/// rejects traversal, then walk the local tree to delete. Returns `204`
/// on success, `404` if nothing was there to begin with.
pub async fn delete_project(api: super::ApiState, AxumPath(project_id): AxumPath<String>) -> Result<Response> {
    validate_component("id", &project_id)?;

    // Resolve the OSS directory back to a local path through the services'
    // own root accessor (which is fixed at startup and not user-controlled),
    // so traversal is impossible.
    let oss = project_dir_path(&api.user_id.0, &project_id);
    let rel =
        oss.strip_prefix("oss://filmcraft/").ok_or_else(|| ServerError::Internal("internal: project_dir_path did not have the expected prefix".into()))?;
    let project_root = api.services.root().join(rel);

    if !project_root.exists() {
        return Err(ServerError::NotFound(format!("project `{project_id}`")));
    }

    delete_recursive(&project_root)?;

    Ok((StatusCode::NO_CONTENT, ()).into_response())
}

/// Remove the project directory and every file under it. Local-only: it
/// operates on a `Path` already translated from an OSS key by the
/// resolver, so it never sees user input directly.
///
/// We delegate to `std::fs::remove_dir_all`, which handles the
/// cross-platform ordering for non-empty directory removal (Windows in
/// particular refuses to delete a directory whose children still exist).
fn delete_recursive(root: &Path) -> Result<()> {
    fs::remove_dir_all(root).map_err(|e| ServerError::Internal(format!("remove {}: {e}", root.display())))
}
