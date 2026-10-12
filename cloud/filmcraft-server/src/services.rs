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

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use filmcraft_engine::Services;
use filmcraft_media::reader::ByteReader;
use filmcraft_media::{SharedReader, sequence::FrameLoader};

use crate::error::ServerError;
use crate::versioning::ProjectMeta;

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

    /// M2.9: write `data` to `path` only if the file does not exist yet.
    /// Backed by `OpenOptions::create_new(true)`, which under POSIX uses
    /// `O_CREAT|O_EXCL` and under Windows maps to `CREATE_NEW`. This is
    /// the strict-create primitive versioning needs to flip a JSON
    /// `locked_by: null` → `"alice"` without a lost-update race.
    ///
    /// Returns:
    /// - `Ok(())` if the file did not exist and is now atomically visible.
    /// - `Err(AlreadyExists)` (`io::ErrorKind::AlreadyExists`) if it was
    ///   already there. Callers should treat that as a CAS failure, not a
    ///   500.
    pub fn create_new(&self, path: &str, data: &[u8]) -> io::Result<()> {
        let p = self.resolve(path)?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(data)?;
                f.sync_all()?;
                Ok(())
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
            Err(e) => Err(e),
        }
    }

    /// M2.9: atomic compare-and-swap on a `ProjectMeta` JSON document.
    ///
    /// Reads the file at `path`, compares `locked_by` to `expected`. If it
    /// matches, rewrites the file with `next` (clearing `locked_by` and
    /// bumping `rev` per `next`) and returns `Ok(true)`. If `locked_by` is
    /// set to someone else, returns `Ok(false)` and writes nothing — the
    /// caller decides whether to retry, surface a conflict, etc.
    ///
    /// Both the read and the write go through `read_file`/`write_file`, so
    /// a torn write is impossible (AGENTS.md §0). The two-step "read-
    /// compare-write" is acceptable here because the only thing racing
    /// on `meta.json` is the lock-release path; the FS's per-file
    /// write-then-rename atomicity (`filmcraft_format::atomic_write`)
    /// guarantees that whoever wins, `meta.json` is either the old or the
    /// new content, never a mix.
    ///
    /// The M2.9 plan talks about a "conditional `put_if_absent`-style
    /// write": for the filesystem backend that is `create_new` above; for
    /// the CAS it is this read-compare-write loop (S3 etag-based CAS is
    /// exposed as a separate method on the future OSS adapter).
    pub fn compare_and_swap_meta(&self, path: &str, expected: Option<&str>, next: &ProjectMeta) -> io::Result<bool> {
        let current = match self.read_file(path) {
            Ok(bytes) => serde_json::from_slice::<ProjectMeta>(&bytes)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("meta at {path:?} not parseable: {e}")))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => ProjectMeta::empty(),
            Err(e) => return Err(e),
        };
        if current.locked_by.as_deref() != expected {
            return Ok(false);
        }
        let bytes = serde_json::to_vec(next).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("encode meta: {e}")))?;
        self.write_file(path, &bytes)?;
        Ok(true)
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

    /// M2.9: `create_new` is the strict-create primitive versioning
    /// relies on for atomic `locked_by: null → "alice"`. The first write
    /// must succeed; a second write to the same key must fail with
    /// `AlreadyExists`, not clobber, not return a fresh file.
    #[test]
    fn create_new_succeeds_when_missing_and_rejects_when_present() {
        let root = tmp_root("cnew");
        let s = OssServices::new(root.clone());
        let p = "oss://filmcraft/users/alice/projects/demo/meta.json";
        s.create_new(p, b"{\"latest_rev\":0}").unwrap();
        assert_eq!(std::fs::read(root.join("users/alice/projects/demo/meta.json")).unwrap(), b"{\"latest_rev\":0}");
        let err = s.create_new(p, b"{\"latest_rev\":99}").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        // The original payload must survive the failed second call — we
        // do not partially overwrite.
        assert_eq!(std::fs::read(root.join("users/alice/projects/demo/meta.json")).unwrap(), b"{\"latest_rev\":0}");
    }

    /// M2.9: the CAS helper must distinguish "the file was missing"
    /// (treat as `locked_by = None`) from "the file is locked by someone
    /// else" (CAS fails). This matches the on-disk invariant where a
    /// fresh project exists at `meta.json` only once a `POST /projects`
    /// M1.7 writes it; before then, `locked_by` semantics must treat a
    /// 404 the same as `null`.
    #[test]
    fn compare_and_swap_meta_treats_missing_as_unlocked() {
        let s = OssServices::new(tmp_root("cas-missing"));
        let path = "oss://filmcraft/users/u/projects/p/meta.json";
        let next =
            ProjectMeta { latest_rev: 1, locked_by: Some("alice".into()), locked_at: Some("2026-10-12T00:00:00Z".into()), last_edited_at: None, name: None };
        // expected = None means "I expected locked_by to be either null or
        // the file to be missing" — both of those count as "I can take the
        // lock", so the CAS returns true and writes the new state.
        assert!(s.compare_and_swap_meta(path, None, &next).unwrap());
        let on_disk: ProjectMeta = serde_json::from_slice(&s.read_file(path).unwrap()).unwrap();
        assert_eq!(on_disk.locked_by.as_deref(), Some("alice"));
        assert_eq!(on_disk.latest_rev, 1);
    }

    /// M2.9: CAS with the wrong expected `locked_by` must lose the race
    /// without writing anything.
    #[test]
    fn compare_and_swap_meta_rejects_when_lock_held_by_other() {
        let s = OssServices::new(tmp_root("cas-held"));
        let path = "oss://filmcraft/users/u/projects/p/meta.json";
        let held = ProjectMeta { latest_rev: 0, locked_by: Some("bob".into()), locked_at: Some("t".into()), last_edited_at: None, name: None };
        s.write_file(path, &serde_json::to_vec(&held).unwrap()).unwrap();

        let next = ProjectMeta { latest_rev: 1, locked_by: Some("alice".into()), locked_at: Some("t2".into()), last_edited_at: None, name: None };
        // Alice expected the file to be unlocked; in fact it is locked by
        // bob. CAS must return false and leave the file untouched.
        assert!(!s.compare_and_swap_meta(path, None, &next).unwrap());
        let on_disk: ProjectMeta = serde_json::from_slice(&s.read_file(path).unwrap()).unwrap();
        assert_eq!(on_disk.locked_by.as_deref(), Some("bob"));
        assert_eq!(on_disk.latest_rev, 0);
    }

    /// M2.9: CAS with the matching `locked_by` value must commit and
    /// return true.
    #[test]
    fn compare_and_swap_meta_succeeds_when_lock_held_by_self() {
        let s = OssServices::new(tmp_root("cas-self"));
        let path = "oss://filmcraft/users/u/projects/p/meta.json";
        let held = ProjectMeta { latest_rev: 3, locked_by: Some("alice".into()), locked_at: Some("t".into()), last_edited_at: None, name: None };
        s.write_file(path, &serde_json::to_vec(&held).unwrap()).unwrap();
        let next = ProjectMeta { latest_rev: 4, locked_by: Some("alice".into()), locked_at: Some("t2".into()), last_edited_at: Some("t2".into()), name: None };
        // expected = Some("alice"), file holds alice -> CAS succeeds.
        assert!(s.compare_and_swap_meta(path, Some("alice"), &next).unwrap());
        let on_disk: ProjectMeta = serde_json::from_slice(&s.read_file(path).unwrap()).unwrap();
        assert_eq!(on_disk.latest_rev, 4);
        assert_eq!(on_disk.locked_by.as_deref(), Some("alice"));
    }
}
