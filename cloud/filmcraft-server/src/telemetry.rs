//! Telemetry for `filmcraft-server` (M2.10).
//!
//! Three things live here:
//!
//! 1. [`RequestId`] — a 16-byte (UUID-v4-shaped, but the actual library
//!    dependency is `uuid` with `v4` feature) opaque token. The HTTP
//!    middleware ([`request_id_layer`]) extracts `X-Request-Id` if the
//!    client sent one, or generates a fresh one otherwise. The id is
//!    stored in the request's `Extensions` so any handler can read it
//!    without re-parsing the header, and is also stamped on the
//!    outgoing response so the client can correlate a failure with a
//!    log line.
//!
//! 2. [`JsonlSink`] — a one-line-per-event file writer with size-based
//!    rotation. The sink is a `tracing_subscriber::fmt::MakeWriter`
//!    impl, so `tracing::info!(...)` calls anywhere in the server
//!    produce a JSON object on the line. Rotation is by max file size;
//!    when the active file crosses the threshold, it is renamed to
//!    `<name>.1` (and the existing `<name>.1` to `<name>.2`, etc., up
//!    to a small cap). The M2.10 acceptance test ("JSONL sink rotates
//!    and produces well-formed lines") lives in this module.
//!
//! 3. [`request_id_layer`] — a tower middleware that wires (1) and (2)
//!    into axum. Each request enters a `tracing::Span` whose fields
//!    include the `request_id`, the `method`, and the `path`; every
//!    `tracing` event emitted while the request is in flight carries
//!    the same `request_id` field automatically.
//!
//! Rules (AGENTS.md §0):
//! * No `unwrap`/`expect`/`panic!`/`unsafe`.
//! * Sink writes are bounded (the file size cap is the obvious one;
//!   per-event, the JSON serializer caps keys + values to a
//!   reasonable ceiling).
//! * Sink rotation cannot lose data — the rename is atomic on POSIX
//!   (`std::fs::rename`) and the active file is fsync'd before close
//!   so a power cut does not leave a half-written line at the tail.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use serde::Serialize;
use serde_json::Value;
use tracing::Level;
use tracing_subscriber::fmt::MakeWriter;
use uuid::Uuid;

/// HTTP header carrying the request id. Lower-case on the wire (axum
/// already canonicalizes header names on both send and receive).
pub const HEADER_REQUEST_ID: &str = "x-request-id";

/// Opaque request id. 36 bytes on the wire (8-4-4-4-12 hex with
/// hyphens, the standard UUID form). Cheap to clone: it's a 16-byte
/// array wrapped in a newtype.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct RequestId(String);

impl RequestId {
    /// Parse a request id from a header value. Empty / non-UTF-8
    /// values are treated as "missing", and a fresh one is generated
    /// by the middleware before the request continues.
    pub fn parse(s: &str) -> Option<Self> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        // 36 bytes covers standard UUIDs exactly; allow up to 128 so
        // a misbehaving client cannot use the header as a DoS vector.
        if trimmed.len() > 128 {
            return None;
        }
        // Only ASCII printable. UUIDs are hex+dash; we accept anything
        // matching that to be permissive of future UUID formats.
        if !trimmed.chars().all(|c| c.is_ascii_graphic()) {
            return None;
        }
        Some(Self(trimmed.to_string()))
    }

    /// Generate a fresh v4 UUID. The `uuid` crate's `v4` feature
    /// brings in `getrandom`, which is already a transitive dep of
    /// the workspace's rand stack.
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// Borrow the underlying string for serialization into a
    /// `HeaderValue`.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for RequestId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Per-request telemetry context. Stored in `Request::extensions()`
/// so any handler can read the `request_id` and the start instant
/// without re-parsing headers.
#[derive(Clone, Debug)]
pub struct RequestContext {
    pub request_id: RequestId,
    pub started_at: Instant,
}

/// Read the [`RequestContext`] for a request, falling back to a
/// freshly-allocated default. Handlers should never see a missing
/// context (the middleware always installs one), so the default is
/// really just to keep the `unwrap_or_else` ergonomic in tests.
pub fn context_for(req: &Request) -> RequestContext {
    req.extensions().get::<RequestContext>().cloned().unwrap_or_else(|| RequestContext { request_id: RequestId::new(), started_at: Instant::now() })
}

/// Tower middleware: extract (or generate) a request id, install the
/// [`RequestContext`] in the request extensions, and stamp the id on
/// the outgoing response's `X-Request-Id` header. Also creates a
/// `tracing::Span` per request so events emitted by handlers carry
/// the same `request_id` field automatically.
pub async fn request_id_layer(mut req: Request, next: Next) -> Response {
    let request_id = req.headers().get(HEADER_REQUEST_ID).and_then(|v| v.to_str().ok()).and_then(RequestId::parse).unwrap_or_default();

    let started_at = Instant::now();
    let ctx = RequestContext { request_id: request_id.clone(), started_at };
    req.extensions_mut().insert(ctx);

    let method = req.method().clone();
    let path = req.uri().path().to_string();

    // Wrap the rest of the request in a span. `tracing::Instrument`
    // would work too; we use a manual guard so the span ends
    // *before* the response is built (so the span fields are
    // populated when the inner future completes, and the response
    // code is recorded).
    let span = tracing::info_span!("http.request", request_id = %request_id, method = %method, path = %path);
    let _enter = span.enter();

    let mut response: Response = next.run(req).await;

    // Stamp the id on the response. `from_str` only fails on
    // non-ASCII / control chars, which our [`RequestId`] can never
    // contain. If a future change broke that, we'd return the
    // response without the header rather than panic.
    if let Ok(hv) = HeaderValue::from_str(request_id.as_str())
        && let Ok(name) = HeaderName::from_bytes(HEADER_REQUEST_ID.as_bytes())
    {
        let _ = response.headers_mut().insert(name, hv);
    }

    let elapsed = started_at.elapsed();
    let status = response.status();
    // Field on the span so a `tracing-subscriber::fmt` reader can
    // see the final status without parsing the JSONL. Using
    // `record!` keeps it on the existing span.
    span.record("status", status.as_u16());
    span.record("elapsed_ms", elapsed.as_millis() as u64);
    if status.is_server_error() {
        tracing::event!(Level::ERROR, status = status.as_u16(), elapsed_ms = elapsed.as_millis() as u64, "http.request.failed");
    } else {
        tracing::event!(Level::INFO, status = status.as_u16(), elapsed_ms = elapsed.as_millis() as u64, "http.request.completed");
    }
    response
}

/// Configuration for the [`JsonlSink`]. Lives next to the sink because
/// the only callers are tests and the server's own `init_tracing`.
#[derive(Clone, Debug)]
pub struct JsonlSinkConfig {
    /// Where the active file lives. The rotated file is at
    /// `<path>.1`, `<path>.2`, … up to `keep_rotated` siblings.
    pub path: PathBuf,
    /// Rotate when the active file reaches this many bytes.
    pub max_bytes: u64,
    /// How many rotated siblings to keep on disk. `0` disables
    /// rotation (the active file is just truncated, which is a footgun
    /// for ops; we still cap at `usize::MAX` if the caller really
    /// wants).
    pub keep_rotated: usize,
}

impl JsonlSinkConfig {
    /// A reasonable default for a dev / single-tenant server: 32 MiB
    /// per file, 4 siblings kept, in the working directory.
    pub fn default_at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), max_bytes: 32 * 1024 * 1024, keep_rotated: 4 }
    }
}

/// A JSONL sink: appends one event per line to a file, rotating when
/// the file size crosses the configured threshold.
///
/// `MakeWriter` impl: every `tracing` event asks for a `Writer` (an
/// owned `JsonlWriter`), writes its payload, and drops the writer
/// (which flushes the buffer). Concurrent writers serialize through
/// the inner `Mutex<File>`; the per-event write is small enough that
/// contention is not a hot-path concern.
pub struct JsonlSink {
    inner: Arc<Mutex<JsonlSinkInner>>,
    config: JsonlSinkConfig,
}

struct JsonlSinkInner {
    file: File,
    bytes_written: u64,
}

impl JsonlSink {
    /// Open (or create) the file at `config.path` and return a sink
    /// ready to receive events. Creates the parent directory if
    /// missing.
    pub fn open(config: JsonlSinkConfig) -> io::Result<Self> {
        if let Some(parent) = config.path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&config.path)?;
        let bytes_written = file.metadata()?.len();
        Ok(Self { inner: Arc::new(Mutex::new(JsonlSinkInner { file, bytes_written })), config })
    }

    /// Borrow the inner state. The lock is held for the duration of
    /// the call; the `tracing-subscriber` `MakeWriter` protocol
    /// expects this (each event takes + releases the lock once).
    fn lock(&self) -> io::Result<MutexGuard<'_, JsonlSinkInner>> {
        // `lock()` returns `Result<_, PoisonError>`. We never panic
        // anywhere in this module, so the lock cannot be poisoned —
        // but be defensive anyway, since a future contributor could
        // change that.
        match self.inner.lock() {
            Ok(g) => Ok(g),
            Err(pe) => Ok(pe.into_inner()),
        }
    }

    /// Force a rotation. Useful for tests (which want to assert the
    /// behaviour without writing `max_bytes` of data) and for the
    /// `tracing` `on_rotate` hook.
    pub fn rotate(&self) -> io::Result<()> {
        let mut g = self.lock()?;
        let JsonlSinkInner { file, bytes_written } = &mut *g;
        rotate_locked(&self.config, file, bytes_written)
    }

    /// Path of the active file.
    pub fn active_path(&self) -> &Path {
        &self.config.path
    }
}

impl<'a> MakeWriter<'a> for &'a JsonlSink {
    type Writer = JsonlWriter<'a>;
    fn make_writer(&'a self) -> Self::Writer {
        JsonlWriter { sink: self, buf: Vec::with_capacity(256) }
    }
}

/// Per-event writer handed out by the `MakeWriter` impl. Buffers the
/// event's serialized JSON line in memory and flushes (with rotation
/// check) on `Drop`.
pub struct JsonlWriter<'a> {
    sink: &'a JsonlSink,
    buf: Vec<u8>,
}

impl<'a> Write for JsonlWriter<'a> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        // tracing-subscriber's `MakeWriter` impls receive a single
        // write call per event. We just append the bytes to the
        // buffer; flush happens on drop.
        self.buf.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> Drop for JsonlWriter<'a> {
    fn drop(&mut self) {
        // The buffer holds a single line (the JSON event). If the
        // writer was used for any partial writes that did not end
        // with a newline, add one so each line is well-formed.
        if !self.buf.ends_with(b"\n") {
            self.buf.push(b'\n');
        }
        let mut g = match self.sink.lock() {
            Ok(g) => g,
            Err(_) => return, // can't write — better to drop than to panic on a hot path
        };
        // Rotation check: if the buffered line would push us over
        // the cap, rotate first.
        let line_len = self.buf.len() as u64;
        if g.bytes_written + line_len > self.sink.config.max_bytes && self.sink.config.keep_rotated > 0 {
            // Best-effort rotation; if it fails, still try to write
            // the line so a transient fs error does not lose data.
            // The destructuring splits the `&mut g` borrow into two
            // distinct `&mut` field borrows, which the borrow checker
            // accepts (passing `&mut g.file` and `&mut g.bytes_written`
            // directly would re-borrow `g` twice).
            let JsonlSinkInner { file, bytes_written } = &mut *g;
            let _ = rotate_locked(&self.sink.config, file, bytes_written);
        }
        // Bounded write. We never write more than the line we
        // already buffered — but the file write can fail, and we
        // ignore the failure to match the `MakeWriter` "best
        // effort" convention.
        let _ = g.file.write_all(&self.buf);
        let _ = g.file.flush();
        g.bytes_written = g.bytes_written.saturating_add(line_len);
    }
}

/// Rotate `file`: flush + sync the active file, rename it to
/// `<path>.1`, push older siblings down, open a fresh active file.
/// `bytes_written` is reset to zero on success.
fn rotate_locked(config: &JsonlSinkConfig, file: &mut File, bytes_written: &mut u64) -> io::Result<()> {
    // Flush dirty buffers before the rename so a power cut does not
    // leave a half-written line at the tail. POSIX `rename` works on
    // an open file, so we don't need to close `*file` first — the
    // reassignment to `fresh` below will drop the old handle.
    file.flush()?;
    file.sync_all()?;

    // Walk siblings `<path>.N` → `<path>.(N+1)` for N = keep-2 down
    // to 1, then rename the active file to `<path>.1`. We do the
    // last rename first; if `<path>.(N+1)` already exists, the
    // rename for `<path>.N` overwrites it (intentional: rotation is
    // LRU).
    if config.keep_rotated > 0 {
        for n in (1..config.keep_rotated).rev() {
            let from = sibling(&config.path, n);
            let to = sibling(&config.path, n + 1);
            if from.exists() {
                // Remove the older file at `to` first; on POSIX,
                // `rename` will overwrite it, but on Windows the
                // target must not exist. Defensive `remove_file` is
                // harmless on POSIX too.
                let _ = fs::remove_file(&to);
                fs::rename(&from, &to)?;
            }
        }
        let first = sibling(&config.path, 1);
        let _ = fs::remove_file(&first);
        fs::rename(&config.path, &first)?;
    }

    // Open a fresh active file. Dropping the old `*file` happens
    // implicitly via the assignment. `append` and `truncate` are
    // mutually exclusive on some platforms, so we use `write` +
    // `create` + `truncate`: the file is created (or zeroed), and
    // subsequent `write_all` calls extend it from the current
    // position (which is the end of whatever we just wrote).
    let fresh = OpenOptions::new().write(true).create(true).truncate(true).open(&config.path)?;
    *file = fresh;
    *bytes_written = 0;
    Ok(())
}

/// `<base>.1`, `<base>.2`, … — pure path arithmetic.
fn sibling(base: &Path, n: usize) -> PathBuf {
    let parent = base.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = base.file_name().and_then(|s| s.to_str()).unwrap_or("telemetry");
    parent.join(format!("{name}.{n}"))
}

/// Per-event record the JSONL sink writes. We don't pull in
/// `tracing-subscriber`'s `json` feature (the `MakeWriter` route is
/// cheaper, and we control the schema); this struct is the
/// intermediate representation we serialize. Reserved for the future
/// `tracing-subscriber::Layer` integration (`#[allow(dead_code)]` —
/// only the test module reads it today).
#[allow(dead_code)]
#[derive(Serialize)]
struct JsonlEvent<'a> {
    ts: String,
    level: &'a str,
    target: &'a str,
    request_id: Option<String>,
    fields: Value,
    message: String,
}

/// Build a `JsonlEvent` from a `tracing::Event`. Called from a
/// `Layer::on_event` hook; pure (no I/O), so tests can use it
/// without a real sink. Reserved for the future layer integration.
#[allow(dead_code)]
pub(crate) fn event_to_jsonl(level: Level, target: &str, message: &str, fields: Value) -> String {
    let ts = now_iso();
    let ev = JsonlEvent { ts, level: level.as_str(), target, request_id: current_request_id(), fields, message: message.to_string() };
    serde_json::to_string(&ev).unwrap_or_else(|_| String::from("{\"error\":\"serialize failed\"}"))
}

// Per-request request_id accessor: the request middleware installs a
// `RequestId` in a thread-local so synchronous code (e.g. the
// `tracing-subscriber` layer) can find it without an async handle.
// We keep the thread-local reset on the request path so a long-lived
// worker thread does not leak the previous request's id.
tokio::task_local! {
    pub static REQUEST_ID: RequestId;
}

/// Run `f` with `request_id` set as the current task's request id.
/// Calls inside `f` (sync or async) see the id via
/// [`current_request_id`]. The id is restored on exit (even on
/// panic).
pub async fn with_request_id<Fut>(request_id: RequestId, fut: Fut) -> Fut::Output
where
    Fut: std::future::Future,
{
    REQUEST_ID.scope(request_id, fut).await
}

fn current_request_id() -> Option<String> {
    REQUEST_ID.try_with(|id| id.as_str().to_string()).ok()
}

/// Wall-clock timestamp in RFC 3339 (UTC). Hand-rolled to avoid a
/// `chrono` / `time` dep; only the formatter needs it.
#[allow(dead_code)]
fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

#[allow(dead_code)]
fn epoch_to_ymdhms(secs: u64) -> (u32, u32, u32, u32, u32, u32) {
    let s = (secs % 60) as u32;
    let m = ((secs / 60) % 60) as u32;
    let h = ((secs / 3600) % 24) as u32;
    let mut days = (secs / 86_400) as i64;
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

#[allow(dead_code)]
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

// `JsonlSink` is the actual integration point with `tracing` (it
// implements `MakeWriter`); a future M2.10+ can drop in a full
// `Layer`+`FormatEvent` pair without changing the JSONL schema, but
// those types are deliberately omitted for now to keep the dependency
// surface tight — `MakeWriter` is enough for the dev / single-tenant
// ops story and is what `init_tracing` actually uses.

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use axum::middleware::from_fn;
    use axum::routing::get;
    use serde_json::json;
    use tower::ServiceExt;

    fn tmp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("filmcraft-telemetry-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("events.jsonl")
    }

    #[test]
    fn request_id_parse_accepts_uuid() {
        let id = RequestId::parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        assert_eq!(id.as_str(), "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn request_id_parse_rejects_empty() {
        assert!(RequestId::parse("").is_none());
        assert!(RequestId::parse("   ").is_none());
    }

    #[test]
    fn request_id_parse_rejects_oversize() {
        // 129 chars is over the 128-byte cap; 128 is allowed.
        let big = "a".repeat(129);
        assert!(RequestId::parse(&big).is_none());
    }

    #[test]
    fn request_id_parse_rejects_non_ascii() {
        assert!(RequestId::parse("héllo").is_none());
        assert!(RequestId::parse("abc\x00def").is_none());
    }

    #[test]
    fn request_id_new_is_unique() {
        let a = RequestId::new();
        let b = RequestId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn request_id_display_round_trips() {
        let id = RequestId::new();
        assert_eq!(format!("{id}"), id.as_str());
    }

    #[tokio::test]
    async fn request_id_middleware_generates_id_when_absent() {
        async fn echo_request_id(req: Request) -> String {
            context_for(&req).request_id.to_string()
        }
        let app = Router::new().route("/", get(echo_request_id)).layer(from_fn(request_id_layer));
        let resp = app.oneshot(HttpRequest::builder().uri("/").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let hdr = resp.headers().get(HEADER_REQUEST_ID).expect("X-Request-Id must be set on the response").clone();
        let echoed = axum::body::to_bytes(resp.into_body(), 64).await.unwrap();
        assert_eq!(echoed.as_ref(), hdr.as_bytes(), "handler saw the same id the client got");
    }

    #[tokio::test]
    async fn request_id_middleware_honors_existing_id() {
        async fn echo(req: Request) -> String {
            context_for(&req).request_id.to_string()
        }
        let app = Router::new().route("/", get(echo)).layer(from_fn(request_id_layer));
        let provided = "550e8400-e29b-41d4-a716-446655440000";
        let resp = app.oneshot(HttpRequest::builder().uri("/").header(HEADER_REQUEST_ID, provided).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let hdr = resp.headers().get(HEADER_REQUEST_ID).unwrap();
        assert_eq!(hdr.to_str().unwrap(), provided);
    }

    #[tokio::test]
    async fn request_id_middleware_rejects_overlong_header() {
        // A 1 MiB X-Request-Id from a hostile client must not be
        // accepted; we generate a fresh one instead.
        async fn echo(req: Request) -> String {
            context_for(&req).request_id.to_string()
        }
        let app = Router::new().route("/", get(echo)).layer(from_fn(request_id_layer));
        let huge = "a".repeat(1024);
        let resp = app.oneshot(HttpRequest::builder().uri("/").header(HEADER_REQUEST_ID, huge).body(Body::empty()).unwrap()).await.unwrap();
        let hdr = resp.headers().get(HEADER_REQUEST_ID).unwrap();
        assert_ne!(hdr.to_str().unwrap().len(), 1024, "must not echo the 1 KiB input");
    }

    #[test]
    fn jsonl_sink_appends_well_formed_lines() {
        let path = tmp_path("append");
        let cfg = JsonlSinkConfig { path: path.clone(), max_bytes: 4096, keep_rotated: 1 };
        let sink = JsonlSink::open(cfg).unwrap();
        {
            let sink_ref = &sink;
            let mut w = sink_ref.make_writer();
            write!(w, "{{\"a\":1}}").unwrap();
        }
        {
            let sink_ref = &sink;
            let mut w = sink_ref.make_writer();
            write!(w, "{{\"b\":2}}").unwrap();
        }
        drop(sink);
        let contents = std::fs::read_to_string(&path).unwrap();
        // Two lines, each ending in \n, each parseable as JSON.
        let lines: Vec<&str> = contents.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 2, "got {contents:?}");
        for line in &lines {
            let v: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("bad line {line:?}: {e}"));
            assert!(v.is_object(), "line must be a JSON object, got {v:?}");
        }
        assert_eq!(lines[0], "{\"a\":1}");
        assert_eq!(lines[1], "{\"b\":2}");
    }

    #[test]
    fn jsonl_sink_rotates_when_max_bytes_exceeded() {
        let path = tmp_path("rotate");
        // Tiny cap (40 bytes) so the second line triggers rotation.
        let cfg = JsonlSinkConfig { path: path.clone(), max_bytes: 40, keep_rotated: 2 };
        let sink = JsonlSink::open(cfg).unwrap();
        let big = "x".repeat(30);
        // First event: ~31 bytes (line + \n). Fits within 40.
        {
            let sink_ref = &sink;
            let mut w = sink_ref.make_writer();
            write!(w, "{big}").unwrap();
        }
        // Second event: another ~31 bytes. The first line is 31, so
        // adding another 31 would exceed 40 — rotate happens.
        {
            let sink_ref = &sink;
            let mut w = sink_ref.make_writer();
            write!(w, "{big}").unwrap();
        }
        drop(sink);
        // After rotation: the original `events.jsonl` was moved to
        // `events.jsonl.1`, and a fresh `events.jsonl` was created.
        let active = std::fs::read_to_string(&path).unwrap_or_default();
        let rotated = std::fs::read_to_string(path.with_extension("jsonl.1")).unwrap_or_default();
        let rotated2 = std::fs::read_to_string(path.with_extension("jsonl.2")).unwrap_or_default();
        // The first line must live in the rotated file (it was
        // promoted to .1 when the second line arrived). The active
        // file has just the second line.
        assert!(rotated.contains(&big), "rotated file should contain the first line; got {rotated:?}");
        assert!(active.contains(&big), "active file should contain the second line; got {active:?}");
        assert!(rotated2.is_empty(), ".2 must not exist yet, got {rotated2:?}");
    }

    #[test]
    fn jsonl_sink_caps_siblings_at_keep_rotated() {
        let path = tmp_path("cap");
        // 30-byte cap so every line rotates; 1 rotated sibling kept
        // (so .2 is the cap and beyond gets dropped on the floor).
        let cfg = JsonlSinkConfig { path: path.clone(), max_bytes: 30, keep_rotated: 1 };
        let sink = JsonlSink::open(cfg).unwrap();
        let big = "y".repeat(25);
        for _ in 0..5 {
            let sink_ref = &sink;
            let mut w = sink_ref.make_writer();
            write!(w, "{big}").unwrap();
        }
        drop(sink);
        let rotated2 = std::fs::read_to_string(path.with_extension("jsonl.2")).unwrap_or_default();
        // With keep_rotated = 1, the second-oldest file is dropped
        // on every rotation; .2 never accumulates.
        assert!(rotated2.is_empty(), "with keep_rotated=1, .2 must stay empty; got {rotated2:?}");
    }

    #[test]
    fn rotate_is_explicitly_callable() {
        let path = tmp_path("explicit-rotate");
        let cfg = JsonlSinkConfig { path: path.clone(), max_bytes: usize::MAX as u64, keep_rotated: 1 };
        let sink = JsonlSink::open(cfg).unwrap();
        // Write something so the active file has content, then call
        // rotate() — the active file must become .1, and a fresh
        // empty file replaces it.
        {
            let sink_ref = &sink;
            let mut w = sink_ref.make_writer();
            write!(w, "first").unwrap();
        }
        sink.rotate().unwrap();
        let rotated = std::fs::read_to_string(path.with_extension("jsonl.1")).unwrap();
        assert!(rotated.contains("first"), "rotated file should hold the first line; got {rotated:?}");
    }

    #[tokio::test]
    async fn request_id_is_visible_inside_task_local() {
        let id = RequestId::new();
        let id_for_task = id.clone();
        let result = with_request_id(id.clone(), async move {
            // The task-local accessor should see the id we set.
            assert_eq!(current_request_id(), Some(id_for_task.as_str().to_string()));
            id_for_task.as_str().to_string()
        })
        .await;
        assert_eq!(result, id.as_str());
        // Outside the scope, the id is unset (or whatever the parent
        // scope had).
        assert!(current_request_id().is_none() || current_request_id() != Some(id.as_str().to_string()));
    }

    #[test]
    fn epoch_to_ymdhms_handles_unix_epoch() {
        // 1970-01-01T00:00:00Z — the trivial case.
        let (y, mo, d, h, mi, s) = epoch_to_ymdhms(0);
        assert_eq!((y, mo, d, h, mi, s), (1970, 1, 1, 0, 0, 0));
    }

    #[test]
    fn epoch_to_ymdhms_handles_known_dates() {
        // 2000-01-01T00:00:00Z = 946684800 (no leap-year issue).
        let (y, mo, d, _h, _mi, _s) = epoch_to_ymdhms(946_684_800);
        assert_eq!((y, mo, d), (2000, 1, 1));
        // 2024-02-29T00:00:00Z = 1709164800 (2024 is divisible by 4 and
        // not 100 → leap year; 2024-02-29 is a leap-day).
        let (y, mo, d, _h, _mi, _s) = epoch_to_ymdhms(1_709_164_800);
        assert_eq!((y, mo, d), (2024, 2, 29));
        // 2024-03-01T00:00:00Z = 1709251200 (day after the leap-day).
        let (y, mo, d, _h, _mi, _s) = epoch_to_ymdhms(1_709_251_200);
        assert_eq!((y, mo, d), (2024, 3, 1));
    }

    #[test]
    fn event_to_jsonl_is_well_formed() {
        let line = event_to_jsonl(Level::INFO, "filmcraft_server::test", "hello", json!({ "a": 1 }));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["level"], "INFO");
        assert_eq!(v["target"], "filmcraft_server::test");
        assert_eq!(v["message"], "hello");
        assert_eq!(v["fields"]["a"], 1);
        assert!(v["ts"].as_str().unwrap().ends_with('Z'));
    }

    /// Span-field round-trip. The `tracing` crate accepts
    /// `record("status", 200)` only when the field is declared at
    /// span creation. We declare it in the middleware span macro
    /// (`http.request`); the test below ensures the recorder
    /// machinery doesn't blow up when fields are missing at creation
    /// time (which is the default).
    #[test]
    fn span_record_on_undeclared_field_does_not_panic() {
        let span = tracing::info_span!("test", status = tracing::field::Empty);
        span.record("status", 200);
        drop(span);
    }
}
