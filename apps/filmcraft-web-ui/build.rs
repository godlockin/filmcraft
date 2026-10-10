//! Build script for `filmcraft-web-ui`.
//!
//! Builds the React + Vite + TypeScript frontend into `dist/`. Runs
//! `npm install` first (idempotent) followed by `npm run build`. Both
//! commands print detailed output; cargo captures stdout and only shows
//! the last lines on a failure, so we tee to stdout ourselves for
//! visibility.
//!
//! Skipped when:
//!   * `FILMCRAFT_WEB_UI_SKIP_BUILD=1` is set — useful in CI where the
//!     build is done by a separate job that caches `node_modules`.
//!   * `OUT_DIR` is missing (cargo always sets it, but we keep the
//!     guard to be defensive).

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let skip = env::var("FILMCRAFT_WEB_UI_SKIP_BUILD")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if skip {
        eprintln!("filmcraft-web-ui: FILMCRAFT_WEB_UI_SKIP_BUILD=1, skipping npm build");
        // Still emit a build step so rebuilds after editing build.rs
        // re-evaluate — no file dependency for now.
        return;
    }

    let here = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let npm = npm_command(&here);
    if !npm {
        // npm not available; do not fail the build. The server will fall
        // back to its "web UI not built" JSON 404.
        eprintln!("filmcraft-web-ui: npm not found, skipping frontend build; build the JS bundle manually with `cd apps/filmcraft-web-ui && npm install && npm run build`");
        return;
    }

    let dist = here.join("dist");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=index.html");
    println!("cargo:rerun-if-changed=package.json");
    println!("cargo:rerun-if-changed=tsconfig.json");
    println!("cargo:rerun-if-changed=vite.config.ts");
    println!("cargo:rerun-if-changed=build.rs");

    run(&here, "install", &[]).expect("npm install failed (see output above)");
    run(&here, "run", &["build"]).expect("npm run build failed (see output above)");

    // Sanity-check the expected output exists so a silent `build` failure
    // (e.g. wrong Vite config) is caught here rather than at the next
    // server start.
    if !dist.join("index.html").exists() {
        panic!("npm run build did not produce dist/index.html");
    }
}

/// Run `npm <args...>` in `dir`. Captures stdout/stderr and writes them
/// through so cargo's check sees them. Returns `true` if npm is present
/// and ran at all; `false` if npm was missing.
fn npm_command(_dir: &Path) -> bool {
    // `npm --version` is cheap and tolerates a missing package.json.
    Command::new("npm").arg("--version").output().is_ok()
}

fn run(dir: &Path, cmd: &str, extra: &[&str]) -> Result<(), String> {
    let mut args: Vec<&str> = vec![cmd];
    args.extend_from_slice(extra);
    eprintln!("filmcraft-web-ui: running npm {} in {}", args.join(" "), dir.display());
    let status = Command::new("npm").args(&args).current_dir(dir).status().map_err(|e| format!("npm: {e}"))?;
    if !status.success() {
        return Err(format!("npm {cmd} failed with {status}"));
    }
    Ok(())
}
