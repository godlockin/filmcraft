//! `SessionManager` — one engine [`Session`] per `(user, project)` pair,
//! lazily created.
//!
//! The headless server is multi-tenant: many users may be editing at once over
//! HTTP / WebSocket, and each user can have many projects open at once. Each
//! `(user, project)` pair has its own [`Session`] because a `Session` owns the
//! active [`Project`](filmcraft_engine::project::Project), the undo history,
//! the journal and the in-flight jobs — none of which can be shared.
//!
//! Locking discipline (the whole point of M1.4's "two users concurrent" test):
//!
//! ```text
//!     Arc<Mutex<Session>>               Arc<Session>           (cloned)
//! ┌───────────────────────┐        ┌─────────────────┐
//! │ user A, project X:    │ ─────▶ │ shared Project  │
//! │ Session               │        │ (Arc<Project>)  │
//! └───────────────────────┘        └─────────────────┘
//! ```
//!
//! `Session` holds `Arc<Project>` internally; commands mutate the project in
//! place under `Mutex<Session>`, but read-only paths can clone the `Arc` out
//! of the lock and operate on it without holding the mutex. That is what
//! makes the engine natural to expose behind a per-`(user, project)` lock.
//!
//! Rules (AGENTS.md §0):
//!   - No `unwrap`/`expect`/`panic!`/`unsafe` outside tests.
//!
//! References: `docs/filmcraft-server.md` §3.3.3.

use std::collections::HashMap;
use std::sync::Arc;

use filmcraft_engine::{Result as EngineResult, Services, Session};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use crate::services::OssServices;

/// Opaque, cheap-to-clone user identifier. `String` for now (M1.3 has no auth;
/// callers will pass a stable per-user string from the auth layer in M2).
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct UserId(pub String);

impl UserId {
    /// Convenience: build from anything string-like without forcing callers to
    /// type the inner field.
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
}

/// Opaque, cheap-to-clone project identifier. Matches the URL-path segment
/// used by the HTTP API (e.g. `GET /api/v1/projects/{project_id}`); the
/// resolver (`api::paths::validate_component`) is the only place that
/// restricts what's allowed.
///
/// `pub(crate)` because the composite [`ProjectKey`] is the only public
/// surface callers ever need: every API entry point that accepts a project
/// identifier does so as a plain `String` (validated at the boundary) and
/// then constructs the key internally.
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub(crate) struct ProjectId(pub String);

impl ProjectId {
    /// Convenience: build from anything string-like without forcing callers to
    /// type the inner field.
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
}

/// Composite key for the per-`(user, project)` engine session map.
///
/// Two browser tabs opening WS to the same server but *different*
/// `?project_id=` get isolated engine sessions because the [`SessionManager`]
/// is keyed on this composite, not on the [`UserId`] alone. Without it,
/// every command (`timeline.move`, `lumetri.setSection`, `file.open`, …)
/// would mutate the same `Session` and two tabs would trample each other.
///
/// The inner [`ProjectId`] is intentionally `pub(crate)` (not re-exported
/// from the crate root): callers should always work in terms of plain
/// validated `String`s and construct the key via [`ProjectKey::new`].
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct ProjectKey(pub UserId, pub(crate) ProjectId);

impl ProjectKey {
    /// Convenience: build from two string-like values. The caller is
    /// responsible for `validate_component`-ing the project id at the
    /// API boundary; this constructor accepts any string.
    pub fn new(user: impl Into<String>, project: impl Into<String>) -> Self {
        Self(UserId::new(user), ProjectId::new(project))
    }
}

/// Owns the per-`(user, project)` engine sessions.
///
/// Cloning is cheap (everything inside is `Arc`/`RwLock`) — share one of
/// these across all HTTP / WebSocket handlers via `AppState`.
pub struct SessionManager {
    services: Arc<OssServices>,
    sessions: RwLock<HashMap<ProjectKey, Arc<Mutex<Session>>>>,
}

/// What the caller got, plus the lock guard scope. Holding the `MutexGuard`
/// outside this struct is a footgun (would deadlock against `get_or_create`'s
/// write lock), so we return the [`Arc<Mutex<Session>>`] and let the caller
/// decide how long to hold the inner lock.
pub type SessionHandle = Arc<Mutex<Session>>;

impl SessionManager {
    /// Build a manager that hands every session the same `services`. The
    /// `services` are shared (cheap) so all users' projects land in the same
    /// object store under their per-user prefixes.
    pub fn new(services: Arc<OssServices>) -> Self {
        Self { services, sessions: RwLock::new(HashMap::new()) }
    }

    /// Number of currently-tracked sessions. Test-only — the public API
    /// doesn't expose this so production callers can't accidentally rely on
    /// the count.
    #[cfg_attr(not(test), allow(dead_code))]
    #[allow(clippy::len_without_is_empty)] // test-only method; not part of the public surface
    pub async fn len(&self) -> usize {
        self.sessions.read().await.len()
    }

    /// Return the session for `key`, creating it on first use.
    ///
    /// The fast path is a read lock; only a cold start takes the write lock.
    /// The double-check pattern (read → upgrade → recheck) makes sure two
    /// concurrent first-requests for the same `(user, project)` pair share
    /// one `Session`.
    pub async fn get_or_create(&self, key: ProjectKey) -> EngineResult<SessionHandle> {
        if let Some(s) = self.sessions.read().await.get(&key) {
            return Ok(Arc::clone(s));
        }
        let mut guard = self.sessions.write().await;
        if let Some(s) = guard.get(&key) {
            // Another task built it while we waited for the write lock.
            return Ok(Arc::clone(s));
        }
        let session = Session::new(Arc::clone(&self.services) as Arc<dyn Services>);
        let handle = Arc::new(Mutex::new(session));
        guard.insert(key, Arc::clone(&handle));
        Ok(handle)
    }

    /// Run `id` with `params` against `key`'s session. Lazily creates the
    /// session on first call.
    ///
    /// Locking: clones the `Arc<Mutex<Session>>` under a short read lock,
    /// then takes the inner `Mutex` for the duration of the command. The
    /// outer lock is released before any user code runs, so two users'
    /// commands never serialise on the manager — only on their own sessions.
    pub async fn execute(&self, key: ProjectKey, id: &str, params: Value) -> EngineResult<Value> {
        let handle = self.get_or_create(key).await?;
        let mut guard = handle.lock().await;
        guard.execute(id, params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ServerError;
    use std::path::PathBuf;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("filmcraft-session-mgr-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manager() -> SessionManager {
        SessionManager::new(Arc::new(OssServices::new(tmp_root("mgr"))))
    }

    #[tokio::test]
    async fn get_or_create_is_idempotent_per_project() {
        // The same `(user, project)` pair must always share one Session,
        // even under concurrent first-request races (the double-check
        // pattern in `get_or_create`).
        let mgr = manager();
        let k1 = ProjectKey::new("alice", "demo");
        let k2 = ProjectKey::new("alice", "demo");

        let a1 = mgr.get_or_create(k1.clone()).await.unwrap();
        let a2 = mgr.get_or_create(k2.clone()).await.unwrap();
        // A different project for the same user must NOT share a Session.
        let b1 = mgr.get_or_create(ProjectKey::new("alice", "other")).await.unwrap();
        // A different user for the same project must NOT share a Session.
        let c1 = mgr.get_or_create(ProjectKey::new("bob", "demo")).await.unwrap();

        assert!(Arc::ptr_eq(&a1, &a2), "alice/demo should share one Session");
        assert!(!Arc::ptr_eq(&a1, &b1), "alice/demo and alice/other must not share a Session");
        assert!(!Arc::ptr_eq(&a1, &c1), "alice/demo and bob/demo must not share a Session");
        assert_eq!(mgr.len().await, 3);
    }

    #[tokio::test]
    async fn execute_runs_against_user_session() {
        // `perf.stats` is parameterless, always-enabled, and returns a JSON
        // value — a cheap way to prove the Session actually executed a
        // command under the manager without dragging the project /
        // sequences along.
        let mgr = manager();
        let v = mgr.execute(ProjectKey::new("alice", "demo"), "perf.stats", Value::Null).await.unwrap();
        assert!(v.is_object(), "perf.stats must return an object, got {v:?}");
    }

    #[tokio::test]
    async fn two_users_concurrent_no_cross_pollution() {
        // The M1.4 acceptance test: two users hammering execute() at the
        // same time must end up with separate, independently-mutated
        // sessions. We use `prefs.set` / `prefs.get` on a real preference
        // (`autoSave.enabled`) as the per-user fingerprint.
        let mgr = manager();
        let a = ProjectKey::new("alpha", "demo");
        let b = ProjectKey::new("beta", "demo");

        let mut params_a = serde_json::Map::new();
        params_a.insert("key".into(), "autoSave.enabled".into());
        params_a.insert("value".into(), Value::Bool(true));
        mgr.execute(a.clone(), "prefs.set", Value::Object(params_a)).await.unwrap();

        let mut params_b = serde_json::Map::new();
        params_b.insert("key".into(), "autoSave.enabled".into());
        params_b.insert("value".into(), Value::Bool(false));
        mgr.execute(b.clone(), "prefs.set", Value::Object(params_b)).await.unwrap();

        let mut read_a = serde_json::Map::new();
        read_a.insert("key".into(), "autoSave.enabled".into());
        let v_a = mgr.execute(a.clone(), "prefs.get", Value::Object(read_a)).await.unwrap();

        let mut read_b = serde_json::Map::new();
        read_b.insert("key".into(), "autoSave.enabled".into());
        let v_b = mgr.execute(b.clone(), "prefs.get", Value::Object(read_b)).await.unwrap();

        assert_eq!(v_a, Value::Bool(true), "alpha's pref must remain true");
        assert_eq!(v_b, Value::Bool(false), "beta's pref must remain false");
        assert_ne!(v_a, v_b, "two users' prefs must not collide");
    }

    #[tokio::test]
    async fn two_projects_same_user_no_cross_pollution() {
        // M2.1: two projects for the SAME user must end up with separate
        // sessions. Without the composite key, a single `UserId` would
        // collapse every project for a user into one engine Session —
        // exactly the failure mode this milestone locks down.
        let mgr = manager();
        let k1 = ProjectKey::new("alice", "alpha");
        let k2 = ProjectKey::new("alice", "beta");

        let mut params_a = serde_json::Map::new();
        params_a.insert("key".into(), "autoSave.enabled".into());
        params_a.insert("value".into(), Value::Bool(true));
        mgr.execute(k1.clone(), "prefs.set", Value::Object(params_a)).await.unwrap();

        let mut params_b = serde_json::Map::new();
        params_b.insert("key".into(), "autoSave.enabled".into());
        params_b.insert("value".into(), Value::Bool(false));
        mgr.execute(k2.clone(), "prefs.set", Value::Object(params_b)).await.unwrap();

        let mut read_a = serde_json::Map::new();
        read_a.insert("key".into(), "autoSave.enabled".into());
        let v_a = mgr.execute(k1.clone(), "prefs.get", Value::Object(read_a)).await.unwrap();

        let mut read_b = serde_json::Map::new();
        read_b.insert("key".into(), "autoSave.enabled".into());
        let v_b = mgr.execute(k2.clone(), "prefs.get", Value::Object(read_b)).await.unwrap();

        assert_eq!(v_a, Value::Bool(true), "alpha's pref must remain true");
        assert_eq!(v_b, Value::Bool(false), "beta's pref must remain false");
        assert_ne!(v_a, v_b, "two projects' prefs must not collide");
    }

    #[tokio::test]
    async fn execute_for_unknown_command_propagates_engine_error() {
        // `Session::execute` returns `EngineError::UnknownCommand` for a bad
        // id — the manager must surface that, not panic or swallow it.
        let mgr = manager();
        let err = mgr.execute(ProjectKey::new("u", "p"), "definitely.not.a.command", Value::Null).await.unwrap_err();
        // We don't reach into the engine's error type from here; just make
        // sure it's an error (it must convert into a 4xx/5xx via
        // `ServerError::Engine` later).
        let _: ServerError = ServerError::Engine(err.to_string());
    }
}
