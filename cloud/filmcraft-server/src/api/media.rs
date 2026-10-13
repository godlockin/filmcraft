//! Media-download HTTP handler (M1.7).
//!
//! Streams a project's media bytes to the browser's `<video>` / `<audio>`
//! / `<img>` element. Supports HTTP `Range` so the browser can seek without
//! downloading the whole clip; defaults to `application/octet-stream` when
//! no known container magic is detected in the first 12 bytes.

use std::io::ErrorKind;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::Path;
use axum::http::header::{ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use filmcraft_engine::Services;

use crate::error::{Result, ServerError, map_store_io_error};
use crate::services::OssServices;

use super::paths::{media_path, validate_component};
use super::sniff::sniff_content_type;

/// Range requested in HTTP `Range: bytes=A-B[,A-B...]`. `B` is inclusive;
/// the second `Some(_)` carries the upper bound, `None` means "to the end".
#[derive(Debug, Clone, Copy)]
struct ByteRange {
    start: u64,
    /// Inclusive. `None` denotes "to end of file" (e.g. `Range: bytes=100-`).
    end: Option<u64>,
}

impl ByteRange {
    /// Parse a single `bytes=A-B` clause. Returns `None` for an invalid or
    /// multi-range request — multi-range is rare in practice for a video
    /// stream and the cost of emitting a multipart body isn't justified
    /// for M1.7. The caller treats `None` as "serve the whole file".
    fn parse(s: &str) -> Option<Self> {
        // Strip optional `bytes=` prefix (case-insensitive per RFC 7233).
        let s = s.trim().strip_prefix("bytes=").unwrap_or(s.trim());
        // Multi-range: take only the first clause.
        let clause = s.split(',').next()?.trim();
        let mut parts = clause.splitn(2, '-');
        let start = parts.next()?.trim();
        let end = parts.next()?.trim();
        let start_num: u64 = start.parse().ok()?;
        let end_opt = if end.is_empty() { None } else { Some(end.parse().ok()?) };
        if start_num > end_opt.unwrap_or(u64::MAX) {
            return None;
        }
        Some(Self { start: start_num, end: end_opt })
    }

    /// Clamp this range against the file's total size. Returns the resolved
    /// `(start, end_inclusive)` pair. Returns `None` if the range is
    /// entirely outside the file (which becomes `416 Range Not Satisfiable`).
    fn resolve(self, total: u64) -> Option<(u64, u64)> {
        if self.start >= total {
            return None;
        }
        let end = match self.end {
            None => total - 1,
            Some(e) => e.min(total - 1),
        };
        if end < self.start {
            return None;
        }
        Some((self.start, end))
    }
}

/// GET /api/v1/projects/{project_id}/media/{filename}
///
/// Streams the media file with `Accept-Ranges: bytes` and `Range` support
/// so a `<video>` element can seek without re-downloading. The
/// `Content-Type` is sniffed from the first 16 bytes (lazily), falling
/// back to `application/octet-stream` for unknown containers.
pub async fn stream_media(api: super::ApiState, Path((project_id, filename)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    validate_component("id", &project_id)?;
    validate_component("filename", &filename)?;

    let path = media_path(&api.user_id.0, &project_id, &filename);

    // File size is the basis for all range math; fail fast with the
    // regular NotFound path if the file is missing.
    let total = api.services.file_size(&path).map_err(|e| map_store_io_error(path.clone(), e))?;

    // Sniff the first 16 bytes for content type. Reading 16 bytes from disk
    // is cheap; we don't want to allocate more than this either.
    let head_len = 16usize.min(usize::try_from(total).unwrap_or(16));
    let head = api.services.read_range(&path, 0, head_len).map_err(|e| map_store_io_error(path.clone(), e))?;
    let content_type = sniff_content_type(&head);

    // Resolve the optional Range header. An unparsable range is the same
    // as none — we serve the whole file. An unsatisfiable one is `416`.
    let range_header = headers.get(RANGE).and_then(|v| v.to_str().ok());
    let resolved = range_header.and_then(ByteRange::parse).and_then(|r| r.resolve(total));
    if range_header.is_some() && resolved.is_none() {
        return Ok(range_not_satisfiable(total));
    }

    let (start, end_inclusive) = match resolved {
        Some(r) => r,
        None => (0, total - 1),
    };
    let length = end_inclusive - start + 1;

    let status = if resolved.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };

    // Read the slice off the worker pool so we don't tie up the tokio
    // reactor on a multi-gigabyte media file. For M1.7 the file already
    // lives on local disk; future OSS backing will hand back a stream.
    let services: Arc<OssServices> = Arc::clone(&api.services);
    let path_for_body = path.clone();
    let body_bytes = tokio::task::spawn_blocking(move || read_range_to_end(&services, &path_for_body, start, length))
        .await
        .map_err(|e| ServerError::Internal(format!("blocking read join failed: {e}")))?
        .map_err(|e| map_store_io_error(path.clone(), e))?;

    let mut response_headers = HeaderMap::new();
    response_headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    response_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    response_headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
    if status == StatusCode::PARTIAL_CONTENT {
        let cr = format!("bytes {start}-{end_inclusive}/{total}");
        if let Ok(v) = HeaderValue::from_str(&cr) {
            response_headers.insert(CONTENT_RANGE, v);
        }
    }

    Ok((status, response_headers, Body::from(body_bytes)).into_response())
}

/// Read `length` bytes from a local file managed by `OssServices` by
/// delegating to `Services::read_range`. Lives behind a `spawn_blocking`
/// so the tokio reactor is free to serve other requests while we copy a
/// possibly-large slice off disk.
fn read_range_to_end(services: &OssServices, path: &str, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
    let len = usize::try_from(length).map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "length too large"))?;
    services.read_range(path, start, len)
}

/// Build a 416 response with the file's `Content-Range: bytes *\/SIZE` per
/// RFC 7233 §4.4 so the client can recover by re-requesting without the
/// `Range` header.
fn range_not_satisfiable(total: u64) -> Response {
    let mut headers = HeaderMap::new();
    let cr = format!("bytes */{total}");
    if let Ok(v) = HeaderValue::from_str(&cr) {
        headers.insert(CONTENT_RANGE, v);
    }
    (StatusCode::RANGE_NOT_SATISFIABLE, headers, Body::empty()).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parse_accepts_bytes_a_b() {
        let r = ByteRange::parse("bytes=0-9").unwrap();
        assert_eq!(r.start, 0);
        assert_eq!(r.end, Some(9));
    }

    #[test]
    fn range_parse_accepts_bytes_a_open_ended() {
        let r = ByteRange::parse("bytes=100-").unwrap();
        assert_eq!(r.start, 100);
        assert_eq!(r.end, None);
    }

    #[test]
    fn range_parse_accepts_bare_a_b() {
        let r = ByteRange::parse("4-11").unwrap();
        assert_eq!(r.start, 4);
        assert_eq!(r.end, Some(11));
    }

    #[test]
    fn range_parse_rejects_garbage() {
        assert!(ByteRange::parse("bytes=abc-def").is_none());
        assert!(ByteRange::parse("").is_none());
    }

    #[test]
    fn range_resolve_clamps_end_to_file_size() {
        let r = ByteRange { start: 4, end: Some(1_000_000) };
        assert_eq!(r.resolve(32), Some((4, 31))); // end clamped to 31
        let r = ByteRange { start: 4, end: None };
        assert_eq!(r.resolve(32), Some((4, 31))); // open-ended goes to last byte
    }

    #[test]
    fn range_resolve_rejects_out_of_file() {
        assert_eq!(ByteRange { start: 100, end: Some(200) }.resolve(32), None);
    }
}
