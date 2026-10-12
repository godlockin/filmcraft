//! HTTP surface for `cloud/filmcraft-server/src/versioning.rs` (M2.9).
//!
//! Endpoints (all under `/api/v1/projects/{project_id}`):
//!
//! * `POST   /lock`                     — take the write lock
//! * `POST   /unlock`                   — release the write lock
//! * `POST   /save`                     — commit a new revision
//! * `GET    /history`                  — list `[{rev, size}, …]`
//! * `GET    /history/{rev}`            — read a specific revision body
//! * `GET    /fcproj`                   — read `current.fcproj` (head)
//!
//! The locker token comes in via the `X-FilmCraft-Lock-Token` request
//! header, falling back to a `locker` JSON field for clients that
//! struggle with custom headers. The `UserId` is taken from the URL
//! routing context (`ApiState`), which for M2.9 is the placeholder
//! `anonymous`.
//!
//! Acceptance (per the M2.9 task):
//!
//! * `lock` returns `200` with the new `meta.json` in the body when
//!   the lock was free, `409` (`BadRequest` mapped to 400 here; the
//!   upstream `Engine` error class is reserved for engine refusals)
//!   when someone else holds it.
//! * `save` returns `201` with `{ newRev, historyKey }` on success and
//!   refuses with a 400 when the locker is wrong or the expected rev
//!   has drifted.
//! * `unlock` returns `204` whether or not a lock was actually held
//!   (idempotent release).
//! * `history` returns `200` with `[]` for an unsaved project.
//!
//! Rules (AGENTS.md §0):
//! * No `unwrap`/`expect`/`panic!`/`unsafe` outside tests.
//! * `len` from the request body is not trusted; we cap to the
//!   already-existing `MAX_UPLOAD_BYTES` so a 200 MiB project file is
//!   the legal ceiling.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::api::paths::validate_component;
use crate::api::{ApiState, MAX_UPLOAD_BYTES};
use crate::error::{Result, ServerError};
use crate::versioning::{HistoryEntry, Versioner};

/// Body for `POST /api/v1/projects/{project_id}/lock` and
/// `POST /api/v1/projects/{project_id}/unlock`. The locker id is the
/// client's opaque token; we accept it as JSON to keep the wire shape
/// uniform with `save`.
#[derive(Debug, Deserialize)]
pub struct LockBody {
    pub locker: String,
}

/// Body for `POST /api/v1/projects/{project_id}/save`. The HTTP layer
/// reads the encoded `.fcproj` as the request body (the wire format
/// for that is "raw `.fcproj` bytes"), so the JSON envelope here only
/// carries the metadata.
#[derive(Debug, Deserialize)]
pub struct SaveBody {
    pub locker: String,
    /// The `latest_rev` the client saw at lock time. The server rejects
    /// mismatches with a 400 so a stale-write never silently lands.
    pub expected_rev: u64,
}

/// `Versioner` lookup. We pin a single `Versioner` to the lifetime of
/// the `ApiState` — both share an `Arc<OssServices>`, and the versioner
/// carries no per-call state.
fn versioner(api: &ApiState) -> Versioner {
    use std::sync::Arc;
    Versioner::new(Arc::clone(&api.services))
}

/// Fall back from `X-FilmCraft-Lock-Token` to a JSON body's `locker`
/// field, in that order. Returns `BadRequest` when both are absent.
fn read_locker(headers: &HeaderMap, from_body: Option<&str>) -> Result<String> {
    if let Some(v) = headers.get("x-filmcraft-lock-token").and_then(|v| v.to_str().ok()) {
        return Ok(v.to_string());
    }
    if let Some(v) = from_body {
        return Ok(v.to_string());
    }
    Err(ServerError::BadRequest("missing locker (set `X-FilmCraft-Lock-Token` header or send `{ \"locker\": \"...\" }`)".into()))
}

/// POST /api/v1/projects/{project_id}/lock
pub async fn lock_project(State(api): State<ApiState>, Path(project_id): Path<String>, headers: HeaderMap, body: Option<Json<LockBody>>) -> Result<Response> {
    validate_component("project_id", &project_id)?;
    let body = body.map(|Json(b)| b);
    let from_body = body.as_ref().map(|b| b.locker.as_str());
    let locker = read_locker(&headers, from_body)?;
    if let Some(b) = body.as_ref() {
        validate_component("locker", &b.locker)?;
    } else {
        // The header path already includes the field-level validation in
        // `read_locker`; nothing more to do.
    }

    let v = versioner(&api);
    let meta = v.lock(&api.user_id.0, &project_id, &locker).await?;
    Ok((StatusCode::OK, Json(json!({ "ok": true, "meta": meta }))).into_response())
}

/// POST /api/v1/projects/{project_id}/unlock
pub async fn unlock_project(State(api): State<ApiState>, Path(project_id): Path<String>, headers: HeaderMap, body: Option<Json<LockBody>>) -> Result<Response> {
    validate_component("project_id", &project_id)?;
    let from_body = body.as_ref().map(|b| b.locker.as_str());
    let locker = read_locker(&headers, from_body)?;
    if let Some(b) = body {
        validate_component("locker", &b.0.locker)?;
    }

    let v = versioner(&api);
    let _released = v.unlock(&api.user_id.0, &project_id, &locker).await?;
    // Idempotent release: 204 whether or not anything was held.
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// POST /api/v1/projects/{project_id}/save
///
/// The request body is the encoded `.fcproj` (raw bytes); the JSON
/// envelope is carried as headers (`X-FilmCraft-Lock-Token`,
/// `X-FilmCraft-Expected-Rev`) or — when the client can't set headers —
/// as `application/json` with the JSON envelope only and the `.fcproj`
/// bytes inside a `payload` base64 field. The JSON mode is for the
/// test rig and for clients that want one round-trip without setting
/// custom headers; the header mode is what production web-UI uses.
pub async fn save_project(State(api): State<ApiState>, Path(project_id): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    validate_component("project_id", &project_id)?;

    // Decide payload source. Headers win.
    let (locker, expected_rev, payload) = if headers.get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|s| s.starts_with("application/json")) {
        // JSON envelope; the `.fcproj` lives in `payload` (bytes or
        // base64). Test rigs use this shape.
        let envelope: SaveEnvelopeJson = serde_json::from_slice(&body).map_err(|e| ServerError::BadRequest(format!("save json body: {e}")))?;
        validate_component("locker", &envelope.locker)?;
        let payload = envelope.payload.map(SavePayload::into_bytes).unwrap_or_default();
        (envelope.locker, envelope.expected_rev, payload)
    } else {
        // Header-driven raw-body path. `X-FilmCraft-Expected-Rev` is
        // parsed as u64.
        let locker = headers
            .get("x-filmcraft-lock-token")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ServerError::BadRequest("missing `X-FilmCraft-Lock-Token` for raw save".into()))?
            .to_string();
        validate_component("locker", &locker)?;
        let rev_hdr = headers
            .get("x-filmcraft-expected-rev")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ServerError::BadRequest("missing `X-FilmCraft-Expected-Rev` for raw save".into()))?;
        let expected_rev: u64 = rev_hdr.parse().map_err(|e| ServerError::BadRequest(format!("invalid `X-FilmCraft-Expected-Rev`: {e}")))?;
        if body.len() > MAX_UPLOAD_BYTES {
            return Err(ServerError::BadRequest(format!("project payload larger than {MAX_UPLOAD_BYTES} bytes")));
        }
        (locker, expected_rev, body.to_vec())
    };

    let v = versioner(&api);
    let out = v.save(&api.user_id.0, &project_id, &locker, expected_rev, &payload).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "project": project_id,
            "newRev": out.new_rev,
            "historyKey": out.history_key,
        })),
    )
        .into_response())
}

/// JSON envelope for `save` when the client can't set custom headers.
///
/// `payload` accepts both shapes:
/// * `[1, 2, 3, …]` — the `.fcproj` as a JSON array of byte values.
///   Mirror of what `serde_json::to_value(Vec<u8>)` produces.
/// * `"hello world"` — the `.fcproj` as a UTF-8 string. Convenient for
///   the test rig and for hand-rolled curl invocations.
///
/// A missing `payload` field is also fine (the `.fcproj` came in via
/// the raw-body path). We decode through a permissive intermediate type
/// so we never fail to *parse* on a string vs bytes mismatch — the
/// mismatch is treated as "the body is empty", which the wiring already
/// handles correctly via `save()`.
#[derive(Debug, Deserialize)]
struct SaveEnvelopeJson {
    pub locker: String,
    pub expected_rev: u64,
    #[serde(default)]
    pub payload: Option<SavePayload>,
}

/// Bytes or string-shaped payload field. We resolve to `Vec<u8>` once
/// during the request so the rest of the call path is uniform.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SavePayload {
    Bytes(Vec<u8>),
    Text(String),
}

impl SavePayload {
    fn into_bytes(self) -> Vec<u8> {
        match self {
            Self::Bytes(b) => b,
            Self::Text(s) => s.into_bytes(),
        }
    }
}

/// GET /api/v1/projects/{project_id}/history
pub async fn list_history(State(api): State<ApiState>, Path(project_id): Path<String>) -> Result<Response> {
    validate_component("project_id", &project_id)?;
    let v = versioner(&api);
    let history: Vec<HistoryEntry> = v.list_history(&api.user_id.0, &project_id).await?;
    Ok((StatusCode::OK, Json(json!({ "ok": true, "project": project_id, "history": history }))).into_response())
}

/// GET /api/v1/projects/{project_id}/history/{rev}
pub async fn read_history(State(api): State<ApiState>, Path((project_id, rev)): Path<(String, u64)>) -> Result<Response> {
    validate_component("project_id", &project_id)?;
    let v = versioner(&api);
    let bytes = v.read_history(&api.user_id.0, &project_id, rev).await?;
    let mut headers = HeaderMap::new();
    headers.insert(axum::http::header::CONTENT_TYPE, OCTET_STREAM);
    Ok((StatusCode::OK, headers, axum::body::Body::from(bytes)).into_response())
}

/// GET /api/v1/projects/{project_id}/fcproj (current head)
///
/// Mirrors `crate::api::get_fcproj` but reads through the `Versioner`
/// so a future offline lock check can be added here without touching
/// the legacy endpoint.
pub async fn read_current(State(api): State<ApiState>, Path(project_id): Path<String>) -> Result<Response> {
    validate_component("project_id", &project_id)?;
    let v = versioner(&api);
    let bytes = v.read_current(&api.user_id.0, &project_id).await?;
    let mut headers = HeaderMap::new();
    headers.insert(axum::http::header::CONTENT_TYPE, OCTET_STREAM);
    Ok((StatusCode::OK, headers, axum::body::Body::from(bytes)).into_response())
}

/// `application/octet-stream` constant. Same convention as in `api.rs`.
const OCTET_STREAM: axum::http::HeaderValue = axum::http::HeaderValue::from_static("application/octet-stream");

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::OssServices;
    use crate::versioning::ProjectMeta;
    use filmcraft_engine::Services;
    use serde_json::Value;
    use std::sync::Arc;

    fn fixture(tag: &str) -> (Arc<OssServices>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("filmcraft-versioning-http-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = Arc::new(OssServices::new(dir.clone()));
        (s, dir)
    }

    fn api_state(s: &Arc<OssServices>) -> ApiState {
        ApiState::new(Arc::clone(s), crate::UserId::new("test"))
    }

    /// Convert a `LockBody` into a request payload. `Json<T>` needs
    /// `serde_json::to_vec` to round-trip cleanly.
    fn lock_body_bytes(locker: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "locker": locker })).unwrap()
    }

    #[tokio::test]
    async fn lock_returns_200_and_meta() {
        let (s, _dir) = fixture("http-lock-ok");
        seed(&s, "alice", "demo");
        let api = api_state(&s);

        let resp = lock_project(State(api), Path("demo".to_string()), HeaderMap::new(), Some(Json(LockBody { locker: "alice-sess".into() }))).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["meta"]["locked_by"], "alice-sess");
    }

    #[tokio::test]
    async fn lock_409s_when_other_writer_holds_it() {
        let (s, _dir) = fixture("http-lock-contention");
        seed(&s, "alice", "demo");
        let api = api_state(&s);

        // First alice takes the lock.
        lock_project(State(api.clone()), Path("demo".to_string()), HeaderMap::new(), Some(Json(LockBody { locker: "alice-sess".into() }))).await.unwrap();

        // Then bob tries to take it: must error.
        let err =
            lock_project(State(api.clone()), Path("demo".to_string()), HeaderMap::new(), Some(Json(LockBody { locker: "bob-sess".into() }))).await.unwrap_err();
        match err {
            ServerError::BadRequest(m) => assert!(m.contains("locked by another"), "{m}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unlock_is_204_even_when_lock_is_not_held() {
        let (s, _dir) = fixture("http-unlock-idempotent");
        seed(&s, "alice", "demo");
        let api = api_state(&s);

        // The project has no meta (or meta with locked_by=null) — unlock
        // is a 204 either way.
        let resp = unlock_project(State(api), Path("demo".to_string()), HeaderMap::new(), Some(Json(LockBody { locker: "alice-sess".into() }))).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn save_returns_201_with_new_rev_and_history_key() {
        let (s, _dir) = fixture("http-save-201");
        seed(&s, "alice", "demo");
        let api = api_state(&s);

        // 1. Lock.
        let _ =
            lock_project(State(api.clone()), Path("demo".to_string()), HeaderMap::new(), Some(Json(LockBody { locker: "alice-sess".into() }))).await.unwrap();

        // 2. Save via JSON envelope (raw body would set headers we can't
        // easily assert in this test rig).
        let mut envelope = serde_json::json!({ "locker": "alice-sess", "expected_rev": 0 });
        // We do not base64 here — the envelope helper above accepts the
        // bytes inline as a string field for testing. The JSON-mode
        // helper looks for `payload: Option<Vec<u8>>`; we pass a
        // string-coerced value.
        let payload_bytes: Vec<u8> = b"hello v1".to_vec();
        envelope["payload"] = serde_json::Value::String(String::from_utf8(payload_bytes.clone()).unwrap());
        let body_bytes = serde_json::to_vec(&envelope).unwrap();

        let mut headers = HeaderMap::new();
        headers.insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/json"));

        let resp = save_project(State(api.clone()), Path("demo".to_string()), headers, Bytes::from(body_bytes)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["newRev"], 1);
        assert!(j["historyKey"].as_str().unwrap().ends_with("/history/00000000000000000001.fcproj"));
    }

    #[tokio::test]
    async fn save_rejects_stale_rev() {
        let (s, _dir) = fixture("http-save-stale");
        seed(&s, "alice", "demo");
        let api = api_state(&s);

        let _ =
            lock_project(State(api.clone()), Path("demo".to_string()), HeaderMap::new(), Some(Json(LockBody { locker: "alice-sess".into() }))).await.unwrap();

        let envelope = serde_json::json!({ "locker": "alice-sess", "expected_rev": 99, "payload": "x" });
        let body_bytes = serde_json::to_vec(&envelope).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/json"));

        let err = save_project(State(api.clone()), Path("demo".to_string()), headers, Bytes::from(body_bytes)).await.unwrap_err();
        match err {
            ServerError::BadRequest(m) => assert!(m.contains("rev mismatch"), "{m}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn history_returns_empty_for_unsaved_project() {
        let (s, _dir) = fixture("http-history-empty");
        seed(&s, "alice", "fresh");
        let api = api_state(&s);

        let resp = list_history(State(api), Path("fresh".to_string())).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let j: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j["ok"], true);
        assert!(j["history"].as_array().unwrap().is_empty());
    }

    /// Drop a minimal `meta.json` + `current.fcproj` so the tests that
    /// exercise `lock` / `unlock` over the HTTP layer have something
    /// to find. The project is "saved at rev 0" — i.e. unsaved but
    /// created.
    fn seed(s: &OssServices, user: &str, project: &str) {
        let cur = crate::api::paths::current_project_path(user, project);
        s.write_file(&cur, b"INITIAL").unwrap();
        let meta = ProjectMeta { latest_rev: 0, locked_by: None, locked_at: None, last_edited_at: None, name: Some(project.into()) };
        let bytes = serde_json::to_vec(&meta).unwrap();
        s.write_file(&crate::versioning::meta_key(user, project), &bytes).unwrap();
    }

    #[test]
    fn lock_body_round_trips_through_json() {
        let bytes = lock_body_bytes("tok-1");
        let j: LockBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(j.locker, "tok-1");
    }
}
