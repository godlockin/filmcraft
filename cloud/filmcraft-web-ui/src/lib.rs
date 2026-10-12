//! FilmCraft web UI — Rust crate shell.
//!
//! The actual UI is a React + Vite + TypeScript app under `src/`. This
//! library is intentionally empty: it exists only so `cargo build` picks
//! up the workspace member and runs `build.rs`, which executes
//! `npm install && npm run build` and writes the bundle into `dist/`.
//!
//! `filmcraft-server` reads `dist/` (or whatever `FILMCRAFT_WEB_UI_DIR`
//! points at) to serve the UI from `:8080`.

// Empty placeholder; the crate carries no Rust source.
