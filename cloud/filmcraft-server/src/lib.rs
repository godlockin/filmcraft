//! FilmCraft server — headless HTTP entry point.
//!
//! See `docs/filmcraft-server.md` for the full plan. M1.3 wires the engine to
//! an object-store abstraction (`OssServices`) so that swapping the local
//! filesystem for Aliyun OSS in M1.3b is a one-line change.

pub mod api;
pub mod error;
pub mod services;
pub mod session;
pub mod versioning;
pub mod ws;

pub use error::{Result, ServerError, map_store_io_error};
pub use services::OssServices;
pub use session::{ProjectKey, SessionHandle, SessionManager, UserId};
pub use versioning::{HistoryEntry, ProjectMeta, SaveOutcome, Versioner};
