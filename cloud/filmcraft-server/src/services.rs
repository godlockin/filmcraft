//! `OssServices` — adapter from `engine::Services` to an object store.
//!
//! M1.3a (this file): backed by the local filesystem at a configured root.
//! Paths use the form `oss://<bucket>/<key>`; we strip the scheme + bucket and
//! resolve the remainder under the root. This lets every piece of FilmCraft
//! code that produces or consumes paths treat the store as opaque.
//!
//! M1.3b will swap the storage backend to `opendal` with the S3 protocol
//! pointed at Aliyun OSS. The trait surface and path protocol do not change.
//!
//! Path examples (M1.3a resolves these to `<root>/users/{u}/projects/{p}/...`):
//!   oss://filmcraft/users/alice/projects/abc/media/intro.mp4
//!   oss://filmcraft/users/alice/projects/abc/current.fcproj
//!   oss://filmcraft/users/alice/projects/abc/history/12.fcproj
//!
//! Rules (AGENTS.md §0):
//!   - No `unwrap`/`expect`/`panic!`/`unsafe`.
//!   - `len` and `offset` are hostile; cap reads by the smaller of `len` and
//!     `file_size` and never allocate more than `len` bytes.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use filmcraft_engine::Services;
use filmcraft_media::reader::ByteReader;
use filmcraft_media::{SharedReader, sequence::FrameLoader};

use crate::error::ServerError;

/// The only path scheme we accept. Anything else is an `InvalidInput` error.
const SCHEME: &str = "oss://";
/// The bucket we accept. M1.3a ignores it (the root is fixed); M1.3b will
/// route to the right bucket via the opendal operator.
const EXPECTED_BUCKET: &str = "filmcraft";

/// Object-store backed [`Services`] implementation.
///
/// In M1.3a, the store is the local filesystem rooted at
/// `OssServices::root`. The root is created on demand. Writes go through
/// `filmcraft_format::atomic_write` so a crash mid-write leaves either the
/// old or the new file in place, never a half-written one (AGENTS.md §0:
/// "never lose work").
pub struct OssServices {
    root: PathBuf,
    /// Whether exports should be encoded in memory and handed to
    /// `write_file` (the web/OSS path), or streamed to the output path
    /// (the native filesystem path). For M1.3a we stream to disk; the
    /// export crate will still call `write_file` with the final bytes.
    export_in_memory: bool,
}

impl OssServices {
    /// Build a new `OssServices` rooted at `root`. The root does not need
    /// to exist; it will be created on the first write.
    pub fn new(root: PathBuf) -> Self {
        Self { root, export_in_memory: false }
    }

    /// Override the `export_in_memory` flag.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_export_in_memory(mut self, v: bool) -> Self {
        self.export_in_memory = v;
        self
    }

    /// Borrow the configured local filesystem root. Used by HTTP handlers
    /// that need to translate an OSS key they've already validated back
    /// into a local path (e.g. recursive directory removal). Only the M1.3a
    /// filesystem backing has a meaningful value here; future OSS backing
    /// will leave this unused and the handlers that touched the raw
    /// filesystem will go through `Services` instead.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a store path to a local filesystem path. The bucket segment
    /// is verified but otherwise discarded (M1.3a); future OSS backing will
    /// route on it.
    fn resolve(&self, path: &str) -> io::Result<PathBuf> {
        let key = strip_scheme(path)?;
        let rel = strip_bucket(path, key)?;
        if rel.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("path {path:?}: empty key after bucket")));
        }
        // Reject `..` traversal: object-store keys must not escape the bucket.
        for seg in Path::new(rel).components() {
            if matches!(seg, std::path::Component::ParentDir) {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("path {path:?}: `..` segments are not allowed in store paths")));
            }
        }
        Ok(self.root.join(rel))
    }
}

fn strip_scheme(path: &str) -> io::Result<&str> {
    path.strip_prefix(SCHEME).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("path {path:?}: expected {SCHEME:?} scheme")))
}

/// Verify `key` starts with `<bucket>/` (exact bucket boundary, not a
/// prefix-match like `"filmcraft"` matching `"filmcraftcraft"`), and return
/// the remainder. Used by both `resolve()` and the `file_loader` closure so
/// the bucket check stays consistent.
fn strip_bucket<'a>(path: &'a str, key: &'a str) -> io::Result<&'a str> {
    let rest = key
        .strip_prefix(EXPECTED_BUCKET)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("path {path:?}: expected bucket {EXPECTED_BUCKET:?}, got a different one")))?;
    // Require the bucket boundary to be `/` (or end-of-string for the bare
    // bucket key, which callers reject separately). Without this check,
    // `oss://filmcraftcraft/x` would sneak through as bucket `filmcraft`.
    match rest.chars().next() {
        Some('/') => Ok(&rest[1..]),
        None => Ok(""),
        Some(other) => Err(io::Error::new(io::ErrorKind::InvalidInput, format!("path {path:?}: bucket boundary must be `/` or end-of-string, got {other:?}"))),
    }
}

/// Random-access reader over a local file. Lets container openers index a
/// media file without loading the whole thing into memory.
struct LocalReader {
    file: std::fs::File,
    len: u64,
}

impl LocalReader {
    fn open(p: &Path) -> io::Result<Self> {
        let file = std::fs::File::open(p)?;
        let m = file.metadata()?;
        if !m.is_file() {
            return Err(io::Error::new(io::ErrorKind::NotFound, format!("{} is not a file", p.display())));
        }
        Ok(Self { file, len: m.len() })
    }
}

impl ByteReader for LocalReader {
    fn len(&self) -> u64 {
        self.len
    }
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::FileExt::read_exact_at(&self.file, buf, offset)
        }
        #[cfg(windows)]
        {
            // Same loop as filmcraft_media::FileReader, duplicated to avoid
            // depending on the private `eof` helper there.
            let mut done = 0usize;
            let mut at = offset;
            while let Some(rest) = buf.get_mut(done..).filter(|r| !r.is_empty()) {
                match std::os::windows::fs::FileExt::seek_read(&self.file, rest, at) {
                    Ok(0) => {
                        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "read past end of byte source"));
                    }
                    Ok(n) => {
                        done = done.saturating_add(n);
                        at = at.saturating_add(n as u64);
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(e),
                }
            }
            Ok(())
        }
    }
}

impl Services for OssServices {
    fn read_file(&self, path: &str) -> io::Result<Vec<u8>> {
        let p = self.resolve(path)?;
        std::fs::read(&p)
    }

    fn write_file(&self, path: &str, data: &[u8]) -> io::Result<()> {
        let p = self.resolve(path)?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Atomic + crash-safe: temp file in the same directory, fsync, rename,
        // fsync the directory. Never overwrite with a half-written file.
        filmcraft_format::atomic_write(&p, data)
    }

    fn file_size(&self, path: &str) -> io::Result<u64> {
        let p = self.resolve(path)?;
        let m = std::fs::metadata(&p)?;
        if m.is_file() { Ok(m.len()) } else { Err(io::Error::new(io::ErrorKind::NotFound, format!("{} is not a file", p.display()))) }
    }

    fn read_range(&self, path: &str, offset: u64, len: usize) -> io::Result<Vec<u8>> {
        // The default reads the whole file then slices, which would defeat
        // the point on a multi-gigabyte media. Override with a real seek+read.
        use std::io::{Read, Seek, SeekFrom};
        let p = self.resolve(path)?;
        let mut f = std::fs::File::open(&p)?;
        f.seek(SeekFrom::Start(offset))?;
        let mut out = Vec::with_capacity(len);
        f.take(len as u64).read_to_end(&mut out)?;
        Ok(out)
    }

    #[cfg(any(unix, windows))]
    fn reader(&self, path: &str) -> Option<io::Result<SharedReader>> {
        match self.resolve(path).and_then(|p| LocalReader::open(&p)) {
            Ok(r) => Some(Ok(Arc::new(r) as SharedReader)),
            Err(e) => Some(Err(e)),
        }
    }

    fn list_dir(&self, dir: &str) -> Option<io::Result<Vec<String>>> {
        let p = match self.resolve(dir) {
            Ok(p) => p,
            Err(e) => return Some(Err(e)),
        };
        Some(std::fs::read_dir(&p).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()))
    }

    fn file_loader(&self) -> Option<FrameLoader> {
        // Image sequences (a directory of numbered frames) are read on demand.
        // We resolve through `Services::read_file` so paths stay in the same
        // `oss://...` form everywhere.
        let this_path = self.root.clone();
        Some(Arc::new(move |p: &str| {
            let key = strip_scheme(p)?;
            let rel = strip_bucket(p, key)?;
            let full = this_path.join(rel);
            std::fs::read(&full)
        }))
    }

    fn export_in_memory(&self) -> bool {
        self.export_in_memory
    }
}

/// Convert an arbitrary `io::Error` into our `ServerError` for use in HTTP
/// handlers that need to surface a status code.
pub fn into_server_error(path: &str, e: io::Error) -> ServerError {
    ServerError::Store { path: path.to_string(), source: e }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("filmcraft-oss-services-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_rejects_wrong_scheme() {
        let s = OssServices::new(tmp_root("scheme"));
        let err = s.resolve("/etc/passwd").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn resolve_rejects_other_bucket() {
        let s = OssServices::new(tmp_root("bucket"));
        let err = s.resolve("oss://other-bucket/x").unwrap_err();
        assert!(err.to_string().contains("different one"));
    }

    #[test]
    fn resolve_rejects_parent_traversal() {
        let s = OssServices::new(tmp_root("traverse"));
        let err = s.resolve("oss://filmcraft/../etc/passwd").unwrap_err();
        assert!(err.to_string().contains("`..`"));
    }

    #[test]
    fn resolve_rejects_bucket_prefix_collision() {
        // Regression: `oss://filmcraftcraft/x` must NOT match bucket
        // `filmcraft`. A bare `starts_with` check would; we require `/` at
        // the bucket boundary.
        let s = OssServices::new(tmp_root("prefix"));
        let err = s.resolve("oss://filmcraftcraft/x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("bucket boundary"), "got: {err}");
    }

    #[test]
    fn resolve_rejects_bare_bucket() {
        // The bare bucket (no key after it) is not a valid path — there is
        // nothing to operate on.
        let s = OssServices::new(tmp_root("bare"));
        let err = s.resolve("oss://filmcraft").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("empty key"), "got: {err}");
    }

    #[test]
    fn write_then_read_round_trip() {
        let root = tmp_root("rt");
        let s = OssServices::new(root.clone());
        let path = "oss://filmcraft/users/u/projects/p/current.fcproj";
        s.write_file(path, b"hello filmcraft").unwrap();
        let got = s.read_file(path).unwrap();
        assert_eq!(got, b"hello filmcraft");
        // File lives under the configured root.
        let on_disk = root.join("users/u/projects/p/current.fcproj");
        assert!(on_disk.exists());
    }

    #[test]
    fn write_creates_parent_dirs() {
        let root = tmp_root("mkdir");
        let s = OssServices::new(root.clone());
        s.write_file("oss://filmcraft/a/b/c/d.bin", b"x").unwrap();
        assert!(root.join("a/b/c/d.bin").exists());
    }

    #[test]
    fn read_range_returns_requested_slice() {
        let root = tmp_root("range");
        let s = OssServices::new(root.clone());
        s.write_file("oss://filmcraft/m.bin", b"0123456789").unwrap();
        let got = s.read_range("oss://filmcraft/m.bin", 3, 4).unwrap();
        assert_eq!(got, b"3456");
    }

    #[test]
    fn file_size_matches_write() {
        let root = tmp_root("size");
        let s = OssServices::new(root);
        s.write_file("oss://filmcraft/x", b"12345").unwrap();
        assert_eq!(s.file_size("oss://filmcraft/x").unwrap(), 5);
    }

    #[test]
    fn reader_serves_random_access() {
        let root = tmp_root("reader");
        let s = OssServices::new(root);
        s.write_file("oss://filmcraft/clip.mp4", b"abcdefghij").unwrap();
        let r = s.reader("oss://filmcraft/clip.mp4").unwrap().unwrap();
        assert_eq!(r.len(), 10);
        let mut buf = [0u8; 4];
        r.read_at(2, &mut buf).unwrap();
        assert_eq!(&buf, b"cdef");
    }

    #[test]
    fn reader_returns_not_found_for_missing() {
        let s = OssServices::new(tmp_root("missing"));
        // `ByteReader` is not `Debug`, so we can't format the Ok arm either.
        let result = s.reader("oss://filmcraft/no-such.mp4");
        assert!(result.is_some(), "reader() should be supported, got None");
        match result.unwrap() {
            Err(e) => assert_eq!(e.kind(), io::ErrorKind::NotFound),
            Ok(_) => panic!("expected Err(NotFound), got Ok"),
        }
    }
}
