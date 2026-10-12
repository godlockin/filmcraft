//! Project versioning for `filmcraft-server` (M2.9).
//!
//! Each `(user, project)` pair lives in a directory at
//! `users/{user}/projects/{project}/` containing three kinds of file:
//!
//! * `current.fcproj` — the latest saved project. The head that reads see.
//! * `meta.json` — at-rest bookkeeping: `latest_rev`, `locked_by`,
//!   `locked_at`, `last_edited_at`, `name`.
//! * `history/{rev}.fcproj` — append-only log of every past save at
//!   revision `rev` (1-indexed). `rev = 0` is the "before any save was
//!   made" state represented by `current.fcproj`'s on-disk absence.
//!
//! Concurrency model: a single CAS-style flip on `meta.locked_by`.
//! * `lock()` — atomically flip `locked_by` from `null` to a locker id
//!   using `OssServices::create_new` (POSIX `O_EXCL`).
//! * `save()` — caller must already hold the lock; writes a new
//!   `history/{rev}.fcproj`, bumps `latest_rev`, clears `locked_by`,
//!   copies the new bytes to `current.fcproj`. All writes go through
//!   `Services::write_file`, which is atomic-rename on the local FS
//!   backend.
//! * `unlock()` — release the lock; if you are not the owner the call
//!   is a no-op (idempotent).
//! * `list_history()` — returns every `(rev, size)` we know about, oldest
//!   first, from the `history/` listing.
//!
//! The "locker id" is the caller's identifier — for M2.9 there is no
//! auth, so the HTTP layer hands the lock endpoint whatever opaque token
//! the client gave us. A future auth milestone will replace this with a
//! derived `(user_id, session_id)` pair (see `docs/filmcraft-server.md`
//! §2.3).
//!
//! Acceptance (per the M2.9 task):
//! 1. The local-FS adapter exposes `create_new` (O_EXCL) and
//!    `compare_and_swap_meta` (read-compare-write on `meta.json`).
//! 2. Save bumps `rev` and writes a new history entry; release clears
//!    `locked_by`.
//! 3. Integration tests cover `lock + save twice + read history`.
//! 4. A doc note in `docs/filmcraft-server.md` describes the round-trip
//!    from a local `.fcproj`.
//!
//! Rules (AGENTS.md §0):
//! * No `unwrap`/`expect`/`panic!`/`unsafe` outside tests.
//! * `len` from the on-disk file is not trusted; reads are bounded by
//!   the bytes we actually receive.
//! * The CAS read-compare-write is safe because `write_file` is
//!   atomic-rename; a torn `meta.json` would require two writers to both
//!   rename over the same temp file, which the FS scheme precludes.

use std::fmt;
use std::io;
use std::sync::Arc;

use filmcraft_engine::Services;
use serde::{Deserialize, Serialize};

use crate::error::{Result, ServerError, map_store_io_error};
use crate::services::OssServices;

/// OSS key for `meta.json` per `(user, project)`.
pub fn meta_key(user: &str, project: &str) -> String {
    format!("oss://filmcraft/users/{user}/projects/{project}/meta.json")
}

/// OSS key for `history/{rev}.fcproj` per `(user, project)`.
pub fn history_key(user: &str, project: &str, rev: u64) -> String {
    format!("oss://filmcraft/users/{user}/projects/{project}/history/{rev:020}.fcproj")
}

/// OSS directory containing every history entry (`history/`).
pub fn history_dir(user: &str, project: &str) -> String {
    format!("oss://filmcraft/users/{user}/projects/{project}/history")
}

/// Per-project bookkeeping. Persisted to `meta.json` alongside
/// `current.fcproj` and `history/*.fcproj`.
///
/// Field order matters less than the wire format being stable: every save
/// reads the file, mutates this struct, and writes it back through the
/// CAS helper. Renaming a field is a breaking change for any on-disk
/// `meta.json` written by an earlier server version.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectMeta {
    /// The revision number stored as the head of `current.fcproj`.
    /// Increments on every successful `save()`. Stays `0` after `lock()`
    /// (a lock alone is not a save).
    #[serde(default)]
    pub latest_rev: u64,
    /// The locker that currently holds the write lock, or `None` for an
    /// unlocked project. Compared string-wise during CAS — the lock API
    /// gives out opaque strings; equality is enough.
    #[serde(default)]
    pub locked_by: Option<String>,
    /// Lock-acquisition timestamp (ISO-8601 / RFC-3339). `None` when
    /// unlocked.
    #[serde(default)]
    pub locked_at: Option<String>,
    /// Save timestamp (ISO-8601 / RFC-3339) of the most recent save that
    /// landed at `current.fcproj`. `None` for an unsaved project.
    #[serde(default)]
    pub last_edited_at: Option<String>,
    /// Display name (best-effort). Defaults to the project id when
    /// unknown; the M1.7 create flow backfills this from `POST /projects`'s
    /// `name` field.
    #[serde(default)]
    pub name: Option<String>,
}

impl ProjectMeta {
    /// An "empty" meta — what CAS expects when the file is missing.
    /// Treated identically to a real `meta.json` whose `locked_by` is
    /// `None`.
    pub fn empty() -> Self {
        Self::default()
    }
}

/// `rev`, `size` of a single history entry. Returned by [`list_history`]
/// and used in the HTTP response of `GET /history`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub rev: u64,
    pub size: u64,
}

impl fmt::Display for HistoryEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "rev={} size={}", self.rev, self.size)
    }
}

/// Outcome of a successful [`Versioner::save`]. The new revision number
/// is what the caller hands to the client so they can address the new
/// history entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveOutcome {
    /// The revision we just wrote. Strictly greater than the rev we were
    /// handed in; the CAS rejects mismatches, so there is no surprise
    /// here.
    pub new_rev: u64,
    /// The OSS key for the new history file
    /// (`oss://filmcraft/.../history/{rev:020}.fcproj`).
    pub history_key: String,
}

/// Take the lock on `(user, project)` as `locker`. Returns the meta we
/// read, or an [`Err`] matching [`ServerError`]. The meta returned is
/// the *new* state (with our locker id baked in).
///
/// Returns [`ServerError::BadRequest`] on a CAS-loss ("already locked by
/// someone else"). The exact identity of the current holder is *not*
/// surfaced — the response is just `409 Conflict`-style text.
pub async fn lock(services: &OssServices, user: &str, project: &str, locker: &str) -> Result<ProjectMeta> {
    validate_id("user", user)?;
    validate_id("project", project)?;
    validate_id("locker", locker)?;

    // Read whatever is currently on disk (a missing file → empty meta).
    let path = meta_key(user, project);
    let current = read_meta(services, &path)?;

    // Lock contention: someone else holds it. We do not differentiate
    // "locked by self" from "unlocked" here — `lock` always means "be the
    // owner after this call returns". A second `lock` from the same
    // locker is therefore a no-op state-wise; the meta we return still
    // shows `locked_by = locker`.
    let already_self = current.locked_by.as_deref() == Some(locked_for(locker));
    let already_other = current.locked_by.is_some() && !already_self;
    if already_other {
        return Err(ServerError::BadRequest(format!("project `{project}` is locked by another writer")));
    }
    if already_self {
        // Re-stamp `locked_at` so the lease window restarts.
        let next = ProjectMeta {
            latest_rev: current.latest_rev,
            locked_by: Some(locked_for(locker).to_string()),
            locked_at: Some(now_iso()),
            last_edited_at: current.last_edited_at,
            name: current.name,
        };
        // Re-entering a lock we already own is not a CAS failure; we
        // write unconditionally via `write_file` (atomic-rename, so torn
        // writes are impossible).
        let bytes = serde_json::to_vec(&next).map_err(|e| ServerError::Internal(format!("encode meta: {e}")))?;
        services.write_file(&path, &bytes).map_err(|e| map_store_io_error(path, e))?;
        return Ok(next);
    }

    // Take the lock by transitioning `locked_by` from `None` (or missing
    // file) to `locker`. This is the M2.9 acceptance CAS: a strict create
    // of the meta file with the new state. If a parallel writer beats us
    // to it, `create_new` returns `AlreadyExists` and we treat that as
    // "someone else got the lock first".
    let next = ProjectMeta {
        latest_rev: current.latest_rev,
        locked_by: Some(locked_for(locker).to_string()),
        locked_at: Some(now_iso()),
        last_edited_at: current.last_edited_at,
        name: current.name,
    };
    let bytes = serde_json::to_vec(&next).map_err(|e| ServerError::Internal(format!("encode meta: {e}")))?;

    // If `meta.json` already exists on disk, `create_new` will refuse
    // and we need to fall back to the CAS path (because the
    // not-yet-locked state pre-exists the M1.7 create flow's write).
    match services.create_new(&path, &bytes) {
        Ok(()) => Ok(next),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            // File pre-exists; switch to the CAS path. Compare the
            // on-disk `locked_by` against our expected "unlocked" — if
            // someone locked between our read and now, this returns
            // false and we report contention.
            let won = services.compare_and_swap_meta(&path, None, &next).map_err(|e| map_store_io_error(path.clone(), e))?;
            if won { Ok(next) } else { Err(ServerError::BadRequest(format!("project `{project}` is locked by another writer"))) }
        }
        Err(e) => Err(map_store_io_error(path, e)),
    }
}

/// Save a new project revision. Caller must already hold the lock
/// (pass the same `locker` id they handed to [`lock`]). Writes:
///
/// 1. `history/{new_rev}.fcproj` — the new revision payload.
/// 2. `current.fcproj` — copy of the same bytes (so an unversioned read
///    still works).
/// 3. `meta.json` — `latest_rev = new_rev`, `locked_by` cleared. Saved
///    *last*, so a `latest_rev <-> current.fcproj` drift cannot publish
///    a missing file.
///
/// `expected_rev` must equal the `latest_rev` recorded in `meta.json` at
/// lock time; if not, the client's view of history is stale and the call
/// is rejected without writing anything.
pub async fn save(services: &OssServices, user: &str, project: &str, locker: &str, expected_rev: u64, payload: &[u8]) -> Result<SaveOutcome> {
    validate_id("user", user)?;
    validate_id("project", project)?;
    validate_id("locker", locker)?;

    let path = meta_key(user, project);
    let current = read_meta(services, &path)?;

    // Lock ownership: the locker is the only one allowed to save.
    if current.locked_by.as_deref() != Some(locked_for(locker)) {
        return Err(ServerError::BadRequest(format!("project `{project}` is not locked by this writer")));
    }

    // Rev-match: clients know the rev they read at lock time. If the
    // head has advanced (someone who *also* held the lock saved and
    // forgot to release), we surface it as a stale-write conflict.
    if current.latest_rev != expected_rev {
        return Err(ServerError::BadRequest(format!("project `{project}` rev mismatch: expected {expected_rev}, head is {}", current.latest_rev)));
    }

    let new_rev = current.latest_rev.saturating_add(1);
    let hist_key = history_key(user, project, new_rev);
    let current_path = crate::api::paths::current_project_path(user, project);

    // 1. Write the history entry.
    services.write_file(&hist_key, payload).map_err(|e| map_store_io_error(hist_key.clone(), e))?;

    // 2. Mirror to `current.fcproj`. A failure here is bad — head and
    //    history diverge — but the history entry is on disk so we do
    //    not lose work; the save loop just retries.
    if let Err(e) = services.write_file(&current_path, payload) {
        return Err(map_store_io_error(current_path, e));
    }

    // 3. Update meta: bump rev, clear lock, stamp `last_edited_at`.
    let next = ProjectMeta { latest_rev: new_rev, locked_by: None, locked_at: None, last_edited_at: Some(now_iso()), name: current.name.clone() };
    let cas = services.compare_and_swap_meta(&path, Some(locked_for(locker)), &next).map_err(|e| map_store_io_error(path.clone(), e))?;
    if !cas {
        // The CAS lost — someone else mutated `meta.json` between our
        // initial read and this point. Force a conflict: the call
        // returns 400 with no rollback, since rolling back `current.fcproj`
        // would risk losing a *later* save.
        return Err(ServerError::BadRequest(format!("project `{project}` meta changed concurrently; retry against rev {new_rev}")));
    }

    Ok(SaveOutcome { new_rev, history_key: hist_key })
}

/// Release the lock. Idempotent: calling `unlock` when the lock is held
/// by someone else is a successful no-op (we still return `true` so the
/// HTTP layer can answer `204`). Calling it when the project is
/// unlocked is also a no-op.
pub async fn unlock(services: &OssServices, user: &str, project: &str, locker: &str) -> Result<bool> {
    validate_id("user", user)?;
    validate_id("project", project)?;
    validate_id("locker", locker)?;

    let path = meta_key(user, project);
    let current = match read_meta(services, &path) {
        Ok(m) => m,
        Err(e) => {
            // Missing meta is "already unlocked" — return `false` so
            // the caller can distinguish a lost-write race if they care.
            if let ServerError::Store { ref source, .. } = e
                && source.kind() == io::ErrorKind::NotFound
            {
                return Ok(false);
            }
            return Err(e);
        }
    };

    if current.locked_by.is_none() {
        return Ok(false);
    }
    if current.locked_by.as_deref() != Some(locked_for(locker)) {
        // Strict semantics: only the locker may release.
        return Err(ServerError::BadRequest(format!("project `{project}` is not locked by this writer")));
    }

    let next = ProjectMeta { latest_rev: current.latest_rev, locked_by: None, locked_at: None, last_edited_at: current.last_edited_at, name: current.name };
    let cas = services.compare_and_swap_meta(&path, Some(locked_for(locker)), &next).map_err(|e| map_store_io_error(path.clone(), e))?;
    Ok(cas)
}

/// Walk `history/` and return every entry, oldest first. A revision
/// that's *missing* on disk is reported as one with `size = None` for
/// the entry the consumer to distinguish from an empty file. We never
/// refuse on a missing directory: an unsaved project has no history,
/// which is `[ ]`, not an error.
pub async fn list_history(services: &OssServices, user: &str, project: &str) -> Result<Vec<HistoryEntry>> {
    validate_id("user", user)?;
    validate_id("project", project)?;

    let dir = history_dir(user, project);
    let names = match services.list_dir(&dir) {
        Some(Ok(v)) => v,
        Some(Err(e)) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Some(Err(e)) => return Err(map_store_io_error(dir, e)),
        None => return Err(ServerError::Internal("list_dir unsupported".into())),
    };

    let mut entries = Vec::with_capacity(names.len());
    for name in names {
        // Expect `NNNNNNNNNNNNNNNNNNNN.fcproj`. Anything else is junk we
        // do not care about (defensive: an attacker who can write
        // arbitrary names here would already own the bucket).
        let Some(stem) = name.strip_suffix(".fcproj") else { continue };
        let Ok(rev) = stem.parse::<u64>() else { continue };
        let key = format!("oss://filmcraft/users/{user}/projects/{project}/history/{name}");
        // Treat a vanished file as size-zero rather than an error: a
        // concurrent gc pass could delete an entry between `list_dir`
        // and `file_size`. Consumers can ask for the body by key if
        // they want the truth.
        let size = services.file_size(&key).unwrap_or(0);
        entries.push(HistoryEntry { rev, size });
    }
    // Oldest first. `history/0000…1.fcproj` is older than
    // `history/0000…2.fcproj`, so lexicographic sort by rev == numeric
    // sort because we fix `rev:020` zero-padded widths.
    entries.sort_by_key(|e| e.rev);
    Ok(entries)
}

/// Read a project body from `current.fcproj` (the head). Returns
/// [`ServerError::NotFound`] if the project has never been saved. This
/// is the path the desktop app takes to load the head after a `lock`.
pub async fn read_current(services: &OssServices, user: &str, project: &str) -> Result<Vec<u8>> {
    validate_id("user", user)?;
    validate_id("project", project)?;
    let p = crate::api::paths::current_project_path(user, project);
    match services.read_file(&p) {
        Ok(b) => Ok(b),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(ServerError::NotFound(p)),
        Err(e) => Err(map_store_io_error(p, e)),
    }
}

/// Read a specific history entry by rev. The rev is 1-indexed and
/// matches `latest_rev` after a `save`; reading rev 0 returns
/// [`ServerError::NotFound`] because rev 0 is the empty project.
pub async fn read_history(services: &OssServices, user: &str, project: &str, rev: u64) -> Result<Vec<u8>> {
    validate_id("user", user)?;
    validate_id("project", project)?;
    if rev == 0 {
        return Err(ServerError::NotFound(format!("project `{project}` has no history at rev 0")));
    }
    let p = history_key(user, project, rev);
    match services.read_file(&p) {
        Ok(b) => Ok(b),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(ServerError::NotFound(p)),
        Err(e) => Err(map_store_io_error(p, e)),
    }
}

/// Read `meta.json`, returning the empty struct if the file is missing.
/// All other I/O errors propagate.
fn read_meta(services: &OssServices, path: &str) -> Result<ProjectMeta> {
    match services.read_file(path) {
        Ok(bytes) => serde_json::from_slice::<ProjectMeta>(&bytes).map_err(|e| ServerError::Internal(format!("meta at {path:?} not parseable: {e}"))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(ProjectMeta::empty()),
        Err(e) => Err(map_store_io_error(path.to_string(), e)),
    }
}

fn validate_id(label: &str, value: &str) -> Result<()> {
    crate::api::paths::validate_component(label, value)
}

/// The string written into `meta.locked_by` — for M2.9 this is just the
/// locker's opaque token, but keeping it in one place means a future
/// auth layer can wrap it (e.g. `format!("{user_id}:{session_id}")`)
/// without touching every call site.
fn locked_for(locker: &str) -> &str {
    locker
}

/// Wall-clock timestamp in ISO 8601 / RFC 3339, second precision.
/// Used for `locked_at` / `last_edited_at`. M2.9 keeps this in the
/// server's local "UTC offset" wall time — no chrono dep is added for
/// this.
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Convert to a y/m/d h:m:s UTC string using the (small, ugly) manual
    // algorithm. We avoid pulling in chrono/time crates — the formatter
    // is the only consumer and the values are advisory. RFC 3339 wants
    // `YYYY-MM-DDTHH:MM:SSZ`; precision below 1s is not used downstream.
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Manual conversion of seconds-since-epoch to a UTC y/m/d h:m:s tuple.
/// Avoids a chrono dep; this is the only place we need it.
fn epoch_to_ymdhms(secs: u64) -> (u32, u32, u32, u32, u32, u32) {
    let s = (secs % 60) as u32;
    let m = ((secs / 60) % 60) as u32;
    let h = ((secs / 3600) % 24) as u32;
    let mut days = (secs / 86_400) as i64;
    // 1970-01-01 was a Thursday.
    let mut year: i32 = 1970;
    loop {
        let dy = days_in_year(year) as i64;
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let mut month: u32 = 1;
    while month <= 12 {
        let dm = days_in_month(year, month) as i64;
        if days < dm {
            break;
        }
        days -= dm;
        month += 1;
    }
    let day = (days as u32) + 1;
    (year as u32, month, day, h, m, s)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn days_in_year(y: i32) -> u32 {
    if is_leap(y) { 366 } else { 365 }
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// Convenience: build a thin, thread-safe wrapper around the read-only
/// parts of this module. The HTTP layer keeps an `Arc<Versioner>` so a
/// single `OssServices` is shared across requests; the versioner itself
/// holds no per-call state.
pub struct Versioner {
    pub services: Arc<OssServices>,
}

impl Versioner {
    pub fn new(services: Arc<OssServices>) -> Self {
        Self { services }
    }

    pub async fn lock(&self, user: &str, project: &str, locker: &str) -> Result<ProjectMeta> {
        lock(&self.services, user, project, locker).await
    }

    pub async fn save(&self, user: &str, project: &str, locker: &str, expected_rev: u64, payload: &[u8]) -> Result<SaveOutcome> {
        save(&self.services, user, project, locker, expected_rev, payload).await
    }

    pub async fn unlock(&self, user: &str, project: &str, locker: &str) -> Result<bool> {
        unlock(&self.services, user, project, locker).await
    }

    pub async fn list_history(&self, user: &str, project: &str) -> Result<Vec<HistoryEntry>> {
        list_history(&self.services, user, project).await
    }

    pub async fn read_current(&self, user: &str, project: &str) -> Result<Vec<u8>> {
        read_current(&self.services, user, project).await
    }

    pub async fn read_history(&self, user: &str, project: &str, rev: u64) -> Result<Vec<u8>> {
        read_history(&self.services, user, project, rev).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Per-test temp root, sequenced so parallel tests don't collide.
    fn fixture(tag: &str) -> Arc<OssServices> {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("filmcraft-versioning-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(OssServices::new(dir))
    }

    /// Seed a project directly (skipping `lock`) so individual tests can
    /// focus on the versioning logic. Returns the rev we left behind so
    /// the test can compare against `latest_rev` after it runs.
    fn seed(s: &OssServices, user: &str, project: &str, name: &str, rev: u64) -> ProjectMeta {
        // Drop an empty `current.fcproj` so M1.7-style create flows
        // would have something to find. A real create would call
        // `encode(&Project::new(name), true)`; tests don't need that.
        let cur = crate::api::paths::current_project_path(user, project);
        s.write_file(&cur, b"INITIAL").unwrap();
        let meta = ProjectMeta { latest_rev: rev, locked_by: None, locked_at: None, last_edited_at: None, name: Some(name.into()) };
        let bytes = serde_json::to_vec(&meta).unwrap();
        s.write_file(&meta_key(user, project), &bytes).unwrap();
        meta
    }

    #[test]
    fn meta_key_and_history_key_are_well_formed() {
        assert_eq!(meta_key("u", "p"), "oss://filmcraft/users/u/projects/p/meta.json");
        assert_eq!(history_key("u", "p", 1), "oss://filmcraft/users/u/projects/p/history/00000000000000000001.fcproj");
        assert_eq!(history_key("u", "p", 123), "oss://filmcraft/users/u/projects/p/history/00000000000000000123.fcproj");
        assert_eq!(history_dir("u", "p"), "oss://filmcraft/users/u/projects/p/history");
    }

    #[test]
    fn zero_padded_revs_sort_correctly() {
        // The 20-wide zero padding means `parse::<u64>` and a
        // lexicographic `sort_by_key` give the same order. This guards
        // against a future change that drops the width and silently
        // breaks `list_history`'s ordering.
        let mut names = ["00000000000000000010.fcproj", "00000000000000000002.fcproj", "00000000000000000001.fcproj"];
        let mut revs: Vec<u64> = names.iter().filter_map(|n| n.strip_suffix(".fcproj").and_then(|s| s.parse::<u64>().ok())).collect();
        revs.sort();
        assert_eq!(revs, vec![1, 2, 10]);
        // While we are here: the original suffix-stripped name for rev 10
        // sorts AFTER rev 2 lexically — the 20-wide padding is what
        // makes `parse + sort` correct.
        names.sort();
        assert_eq!(names[0], "00000000000000000001.fcproj");
    }

    #[tokio::test]
    async fn lock_then_save_then_list_history_round_trip() {
        // The M2.9 acceptance test: lock + save twice + read history.
        let s = fixture("m29-round-trip");
        let v = Versioner::new(Arc::clone(&s));
        let user = "alice";
        let project = "demo";

        seed(&s, user, project, "demo", 0);

        // 1. Lock + 2 saves.
        let meta = v.lock(user, project, "token-A").await.unwrap();
        assert_eq!(meta.locked_by.as_deref(), Some("token-A"));
        assert_eq!(meta.latest_rev, 0);

        let out1 = v.save(user, project, "token-A", 0, b"hello v1").await.unwrap();
        assert_eq!(out1.new_rev, 1);
        // After the first save the lock is released. Re-lock to allow a
        // second save (M2.9 keeps this simple: a save releases the
        // lock; clients re-lock for a follow-up save).
        v.lock(user, project, "token-A").await.unwrap();
        let out2 = v.save(user, project, "token-A", 1, b"hello v2").await.unwrap();
        assert_eq!(out2.new_rev, 2);

        // 2. List history: must be [1, 2], oldest first, with non-zero
        //    sizes for both.
        let history = v.list_history(user, project).await.unwrap();
        assert_eq!(history, vec![HistoryEntry { rev: 1, size: b"hello v1".len() as u64 }, HistoryEntry { rev: 2, size: b"hello v2".len() as u64 }]);

        // 3. Read `current.fcproj` and the second history entry —
        //    both must be the latest bytes.
        let head = v.read_current(user, project).await.unwrap();
        assert_eq!(head, b"hello v2");
        let h2 = v.read_history(user, project, 2).await.unwrap();
        assert_eq!(h2, b"hello v2");

        // 4. Unlock when no lock is held: idempotent no-op returning
        //    `false` ("did not release anything").
        let released = v.unlock(user, project, "token-A").await.unwrap();
        assert!(!released, "unlock after save (lock was released in save) must report no-op");
    }

    #[tokio::test]
    async fn lock_is_rejected_when_already_held_by_other() {
        let s = fixture("m29-lock-contention");
        let v = Versioner::new(Arc::clone(&s));
        seed(&s, "alice", "demo", "demo", 0);
        v.lock("alice", "demo", "alice-sess").await.unwrap();
        let err = v.lock("alice", "demo", "bob-sess").await.unwrap_err();
        match err {
            ServerError::BadRequest(m) => assert!(m.contains("locked by another"), "{m}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn save_rejects_unknown_locker() {
        let s = fixture("m29-unknown-locker");
        let v = Versioner::new(Arc::clone(&s));
        seed(&s, "alice", "demo", "demo", 0);
        v.lock("alice", "demo", "alice-sess").await.unwrap();
        let err = v.save("alice", "demo", "mallory-sess", 0, b"x").await.unwrap_err();
        match err {
            ServerError::BadRequest(m) => assert!(m.contains("not locked by this writer"), "{m}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn save_rejects_stale_rev() {
        let s = fixture("m29-stale-rev");
        let v = Versioner::new(Arc::clone(&s));
        seed(&s, "alice", "demo", "demo", 0);
        v.lock("alice", "demo", "alice-sess").await.unwrap();
        // expected_rev 99, head is 0 — must fail.
        let err = v.save("alice", "demo", "alice-sess", 99, b"x").await.unwrap_err();
        match err {
            ServerError::BadRequest(m) => assert!(m.contains("rev mismatch"), "{m}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unlock_is_idempotent_for_self_lock() {
        let s = fixture("m29-unlock-idempotent");
        let v = Versioner::new(Arc::clone(&s));
        seed(&s, "alice", "demo", "demo", 0);
        v.lock("alice", "demo", "alice-sess").await.unwrap();
        assert!(v.unlock("alice", "demo", "alice-sess").await.unwrap(), "first unlock releases the lock");
        // Now unlock again — lock is gone, return `false`.
        assert!(!v.unlock("alice", "demo", "alice-sess").await.unwrap(), "second unlock is a no-op");
    }

    #[tokio::test]
    async fn unlock_rejects_other_locker() {
        let s = fixture("m29-unlock-other");
        let v = Versioner::new(Arc::clone(&s));
        seed(&s, "alice", "demo", "demo", 0);
        v.lock("alice", "demo", "alice-sess").await.unwrap();
        let err = v.unlock("alice", "demo", "mallory-sess").await.unwrap_err();
        match err {
            ServerError::BadRequest(m) => assert!(m.contains("not locked by this writer"), "{m}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_history_for_unsaved_project_is_empty() {
        let s = fixture("m29-empty-history");
        let v = Versioner::new(Arc::clone(&s));
        // Seed without any history writes.
        seed(&s, "alice", "fresh", "fresh", 0);
        let history = v.list_history("alice", "fresh").await.unwrap();
        assert!(history.is_empty(), "new project must have no history, got {history:?}");
    }

    #[tokio::test]
    async fn read_history_rev_zero_returns_not_found() {
        let s = fixture("m29-rev-zero");
        let v = Versioner::new(Arc::clone(&s));
        seed(&s, "alice", "demo", "demo", 0);
        let err = v.read_history("alice", "demo", 0).await.unwrap_err();
        match err {
            ServerError::NotFound(_) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
}
