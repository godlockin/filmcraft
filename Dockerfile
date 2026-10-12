# syntax=docker/dockerfile:1.7
#
# FilmCraft server image. Two stages:
#   1. `builder`  — rust:${RUST_VERSION}-slim-bookworm (defaults to 1.95, the
#                   MSRV declared in workspace Cargo.toml). Compiles
#                   filmcraft-server with sccache for incremental rebuilds and
#                   BuildKit cache mounts so the registry/crate/git layers
#                   survive between builds.
#   2. `runtime`  — debian:bookworm-slim. Only the binary, libssl3, tini and
#                   wget (the latter is used by the HEALTHCHECK).
#
# Build:    docker build -t filmcraft-server:dev .
# Run:      docker run --rm -p 127.0.0.1:9081:8080 --env-file .env filmcraft-server:dev
# Compose:  docker compose up --build
#
# RUST_VERSION note: the workspace requires rust-version = "1.95" (MSRV). If
# the `rust:1.95-slim-bookworm` tag is not yet published on Docker Hub, override
# at build time:
#     docker build --build-arg RUST_VERSION=<known-good-tag> .
# or temporarily relax MSRV in your local Cargo.toml.
#
# Notes (AGENTS.md §0):
#   - We never link or ship ffmpeg. ffmpeg may be installed in this image for
#     development convenience only (e.g. inside `builder`); it is not in the
#     runtime image and is not in any artifact we publish.

ARG RUST_VERSION=1.95
ARG SCCACHE_VERSION=0.8

# ---------- builder ----------
FROM rust:${RUST_VERSION}-slim-bookworm AS builder
ARG SCCACHE_VERSION

# sccache lets us share Cargo build artifacts across Docker layer rebuilds and,
# if mounted, across host+container. The cache mount on /root/.cargo and
# /usr/local/cargo/registry is what makes the second build fast.
ENV RUSTC_WRAPPER=/usr/local/bin/sccache \
    SCCACHE_DIR=/sccache \
    CARGO_TERM_COLOR=always

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install sccache. We pin to a known-good release; bumping requires testing.
RUN curl -fsSL "https://github.com/mozilla/sccache/releases/download/v${SCCACHE_VERSION}/sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin --strip-components=1 sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl/sccache \
    && chmod +x /usr/local/bin/sccache \
    && sccache --version

WORKDIR /usr/src/filmcraft

# Copy the manifests first so dependency resolution is cached separately
# from the source tree. Workspace Cargo.toml and every crate's Cargo.toml.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps ./apps
COPY cloud ./cloud
COPY xtask ./xtask

# Build only the server binary. This pulls in filmcraft-engine transitively,
# which is the heavy part; everything else in the workspace is skipped.
# `--locked` keeps us honest against the committed Cargo.lock.
# The cache mount for target/ is the big win: incremental builds re-use it.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/usr/src/filmcraft/target,sharing=locked \
    --mount=type=cache,target=/sccache,sharing=locked \
    cargo build --release --locked --bin filmcraft-server

# ---------- runtime ----------
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libssl3 ca-certificates tini wget \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1000 filmcraft \
    && useradd  --system --uid 1000 --gid filmcraft --home /var/lib/filmcraft --shell /usr/sbin/nologin filmcraft \
    && install -d -o filmcraft -g filmcraft -m 0750 /var/lib/filmcraft

COPY --from=builder /usr/src/filmcraft/target/release/filmcraft-server /usr/local/bin/filmcraft-server

USER filmcraft
WORKDIR /var/lib/filmcraft

# Loopback by default — the dev-friendly and AGENTS.md §0-friendly choice
# (never expose to the public internet by default). Container orchestrators
# that publish 8080 externally MUST override this to "0.0.0.0:8080" (or the
# container-specific equivalent) at runtime via `-e` / `environment:`. The
# bundled `docker-compose.yml` does this automatically.
ENV FILMCRAFT_LISTEN_ADDR=127.0.0.1:8080 \
    RUST_LOG=filmcraft_server=info,tower_http=info

EXPOSE 8080

# tini reaps zombies and forwards signals so axum's graceful_shutdown works.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/filmcraft-server"]

# HEALTHCHECK is in exec form (JSON array). wget returns 0 on HTTP 2xx, which
# Docker treats as healthy; non-zero (e.g. server still starting) is unhealthy.
# `start_period: 20s` gives the hello-world binary time to bind; M1.3+ will
# need to raise this to 60-90s once the engine is wired up.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD ["/usr/bin/wget", "--quiet", "--spider", "http://127.0.0.1:8080/api/v1/health"]
