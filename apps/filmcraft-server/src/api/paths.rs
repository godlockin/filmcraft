//! OSS key paths for project media and the project's `.fcproj` file.
//!
//! Centralised so every HTTP handler (upload, list, stream, create, delete)
//! resolves the same key for the same `(user, project)` pair. The OSS
//! resolver (`services::OssServices`) is the last line of defence against
//! traversal; this layer is just to keep the wire format consistent.

use crate::error::{Result, ServerError};

/// JSON object key for the per-project media directory.
pub fn media_dir_key(user: &str, project: &str) -> String {
    format!("users/{user}/projects/{project}/media")
}

/// JSON object key for the project's main file.
pub fn current_project_key(user: &str, project: &str) -> String {
    format!("users/{user}/projects/{project}/current.fcproj")
}

/// JSON object key for the project's metadata file.
pub fn meta_key(user: &str, project: &str) -> String {
    format!("users/{user}/projects/{project}/meta.json")
}

/// Build the OSS path from `(user, project, name)` for a media item.
pub fn media_path(user: &str, project: &str, name: &str) -> String {
    format!("oss://filmcraft/{}/{name}", media_dir_key(user, project))
}

/// OSS path to the project's `.fcproj`.
pub fn current_project_path(user: &str, project: &str) -> String {
    format!("oss://filmcraft/{}", current_project_key(user, project))
}

/// OSS path to the project's `meta.json`.
pub fn meta_path(user: &str, project: &str) -> String {
    format!("oss://filmcraft/{}", meta_key(user, project))
}

/// OSS directory of a project's files (used to list/delete the project).
pub fn project_dir_path(user: &str, project: &str) -> String {
    format!("oss://filmcraft/users/{user}/projects/{project}")
}

/// OSS directory containing every project for a user. Used by `GET /projects`.
pub fn user_projects_dir(user: &str) -> String {
    format!("oss://filmcraft/users/{user}/projects")
}

/// Reject `..`, `/`, `\\` and NUL in a single user-supplied path component
/// (a project id or a filename). This is the API-boundary check — the OSS
/// resolver runs the same defence again on the assembled key, so the two
/// checks layer rather than duplicate: the API one returns a friendly
/// 400 with a named field, the resolver one is the last line of defence
/// against a traversal that snuck through somehow.
pub fn validate_component(label: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.contains('/') || value.contains('\\') || value.contains("..") {
        return Err(ServerError::BadRequest(format!("{label} must not be empty or contain `/`, `\\`, or `..`")));
    }
    if value.contains('\0') {
        return Err(ServerError::BadRequest(format!("{label} must not contain NUL")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_component_rejects_path_traversal_and_empty() {
        assert!(validate_component("x", "").is_err());
        assert!(validate_component("x", "a/b").is_err());
        assert!(validate_component("x", "a\\b").is_err());
        assert!(validate_component("x", "..").is_err());
        assert!(validate_component("x", "a/..b").is_err()); // contains ".."
        assert!(validate_component("x", "abc\0def").is_err());
        assert!(validate_component("x", "clip.mp4").is_ok());
    }
}
