# FilmCraft Server — cloud product surface & implementation plan

> **Goal.** Turn FilmCraft (pure-Rust NLE, Premiere-grade) from a desktop / CLI / MCP
> product into a "cloud multi-user web video editing platform". The cloud product
> should be deployable on any cloud (Aliyun, AWS, self-hosted) without code forks
> and without changes to the upstream desktop codebase.

**Document state.** M2.5 — surface definition + spec refresh.
**Last updated.** 2026-10-12 (post-M2.4 cloud/ subtree extraction).
**Prior version.** 2026-10-08 (M1 spec, Aliyun-oriented; superseded in vendor-neutrality, not in intent).

---

## 0. Summary

The M1.7 → M2.4 milestones already proved the architecture works: the headless server
wraps `filmcraft-engine` over HTTP and WebSocket, the React SPA lives on `/` of the
same origin, project state is keyed on `(user, project)` to keep tabs isolated, and
the engine path layer (`OssServices`) is pluggable enough that swapping local FS for
S3 / OSS / GCS is a backend implementation change.

What's missing is *product* definition: where the M1 spec talked about an Aliyun
stack (FC, SAE, 百炼), the cloud surface needs to be vendor-neutral so the same code
ships to Aliyun, AWS, GCP and on-prem. M2.5 closes that gap: it restates the
product surface (people, projects, media, sessions, exports, AI, observability,
deployment) in backend-agnostic terms and maps it to the milestones where each piece
will be built.

**M1 objective (unchanged from the 2026-10-08 spec):** browser upload → server
import → command execution → H.264 export, end-to-end. Six-week budget.

---

## 1. Codebase reality (post-M2.4)

The repo state on `cloud-bootstrap` (`bcd0cdad`) already delivers an M1.5-grade
vertical:

| Capability | Where | M-id |
|---|---|---|
| `filmcraft-server` crate (`axum` + `tokio`), per-`(user, project)` `SessionManager` | `cloud/filmcraft-server/src/{main,session,ws,services}.rs` | M1.7, M2.1 |
| `OssServices` — `engine::Services` adapter, **local FS in M1.3a**, OSS-shape path protocol (`oss://filmcraft/...`) | `cloud/filmcraft-server/src/services.rs` | M1.3a ✅, M1.3b pending |
| HTTP routes: `/api/v1/{root,health,store/...}`, projects CRUD, media upload + Range stream, project export, raw `/api/v1/projects/{id}/fcproj` | `cloud/filmcraft-server/src/{main,api}/*.rs` | M1.6 ✅ |
| WebSocket bridge: `/api/v1/ws?project_id=...`, headless control protocol, JSON-lines | `cloud/filmcraft-server/src/ws.rs` | M1.5 ✅ |
| SPA fallback: `cloud/filmcraft-web-ui/dist/` served at `/`, Vite dev proxy on `:5173` | `cloud/filmcraft-server/src/main.rs`, `cloud/filmcraft-web-ui/` | M1.7, M2.2 |
| React + Vite + TS UI: project list, project detail, media upload, **Engine Console** with WS state badge | `cloud/filmcraft-web-ui/src/` | M1.7, M2.2, M2.3 |
| `WsClient` state-machine unit tests (vitest, 9 passing) | `cloud/filmcraft-web-ui/src/ws.test.ts` | M2.2 ✅ |
| Auth placeholder (`UserId("anonymous")`), single-user default | `cloud/filmcraft-server/src/main.rs` `ANONYMOUS_USER_ID` | M1.10 placeholder, real auth M3.x |
| Loopback-only default; reverse-proxy expectation explicit | `cloud/filmcraft-server/src/main.rs` `DEFAULT_LISTEN_ADDR` | AGENTS.md §0 |
| `Dockerfile`, `docker-compose.yml` (filmcraft-server on `127.0.0.1:9081`) | repo root | M1.10 partial |
| Workspace layout: `cloud/filmcraft-{server,web-ui}/`, single workspace `Cargo.lock` | `Cargo.toml` | M2.4 ✅ |
| xtask LAYERS: `filmcraft-server`, `filmcraft-web-ui` at L6 (path-agnostic name lookup) | `xtask/src/main.rs` | M1.7 ✅ |

**Pre-M1.3a items still open** (and now better defined in §3):

- Object storage backend — local FS only; S3/OSS/GCS not wired.
- Authentication — placeholder anonymous user; no token, cookie, or OAuth flow.
- Project versioning — no history or pessimistic-lock; auto-save + crash-recovery exist for the desktop engine but aren't stitched into the server's project file persistence.
- Telemetry — none; `OssServices` doesn't emit traces for store I/O, `SessionManager` doesn't record command latency.
- Export pipeline — `POST /api/v1/projects/{id}/export` returns metadata only (M1.6); actual long-running encode is a separate worker surface.
- AI sidecar — chat box stub only; no `engine.execute` plumbing.

---

## 2. Product surface (vendor-neutral)

The cloud product has ten primitives. Each is expressed in terms *upstream already
guarantees* (`engine::Services`, `Session::execute`, `ControlRequest`) so backend
choices below are implementation, not surface.

### 2.1 People (users + identity)

- **Surface.** A `UserId` opaque string identifies a tenant. The server resolves a
  request's identity at the entry point (HTTP header, cookie, or WS handshake);
  handlers consume an already-authenticated `UserId`, never do auth themselves.
- **AuthN modes** (M3.x): single-user dev token (M3.1, env var),
  username + password + bcrypt (M3.2), OIDC / OAuth (M3.3). A single trait
  `AuthResolver` lets deployments pick one without forking the server.
- **AuthZ** (M3.x): per-`(user, project)` ACL with roles `owner | editor | viewer`.
  The server enforces at every handler; the engine doesn't see the difference.

### 2.2 Projects

- Surface: `POST /api/v1/projects`, `GET /api/v1/projects`, `GET /api/v1/projects/{id}`,
  `DELETE /api/v1/projects/{id}`.
- A project is `current.fcproj` (the open document) plus a history log
  (`history/{rev}.fcproj`, monotonically increasing) plus `meta.json`
  (`{latest_rev, locked_by, locked_at, last_edited_at}`).
- **Versioning model** (M1.9 candidate): pessimistic lock per `current.fcproj`,
  explicit save bumps `rev`. Not real-time CRDT.
- **Persistence backends** (M1.3b): `LocalFsServices` (today), `S3Services`
  (M1.3b-S3, AWS / MinIO / LocalStack), `OssServices` (M1.3b-OSS, Aliyun),
  `GcsServices` (later). All four speak `oss://filmcraft/...` paths.

### 2.3 Media

- **Surface.** Upload (`POST /api/v1/projects/{id}/media`, multipart, 1 GiB per file cap, total 100 GiB per user ceiling), list (`GET .../media`),
  stream (`GET .../media/{filename}` with HTTP Range, 206).
- **Storage keys.** `oss://filmcraft/users/{u}/projects/{p}/media/{media_id}.{ext}`.
- **Identity.** `media_id` is server-issued UUID; the original filename is preserved
  for download. MIME sniff goes through `services::api::sniff::sniff_bytes` so the
  engine can re-import the file locally on a different deployment without a
  re-upload.

### 2.4 Sessions

- Surface: `SessionManager<Auth, Services, Frame>`. Per-`(user, project)` engine
  session, lazily created, evicted by LRU + idle TTL (default 30 min), warmed by
  `POST /api/v1/projects/{id}/open` to reduce first-render latency.
- **State.** `Arc<Mutex<Session>>` keyed on `(UserId, ProjectId)`. Read-only paths
  clone `Arc<Project>` out of the lock; mutating paths hold the lock for the
  duration of a single command (current `Session::execute` semantics).
- **Locking vs concurrent commands.** Two users on the same project contend on
  `meta.json`'s `locked_by`. One user's tab can hold the editor lock; another
  sees "read-only"; a third can fork (M3.x).

### 2.5 Commands (the engine surface over WS)

- **Transport.** WebSocket at `/api/v1/ws?project_id=...` — one WS per tab,
  server auto-loads the project on connect (M2.1).
- **Protocol.** Headless `ControlRequest` JSON-lines, identical to the desktop
  app's `apps/filmcraft/src/control_server.rs`. A line is
  `{"id":N,"method":"engine.execute","params":{"command":"…","params":{…}}}`
  with a matching reply line.
- **What's excluded.** UI-only commands (`ui.screenshot`, `ui.click`, `ui.elements`)
  are *not* registered in the headless context; the engine already rejects them
  with `"disabled"`. Clients must not assume they're available.
- **Catalog.** Server returns the live `command_list` filtered by what the
  current role can run (viewer ⇒ only read-only commands); M3.x.

### 2.6 Exports

- **Surface.** Two phases:
  1. `POST /api/v1/projects/{id}/export { preset, start_tick, end_tick }` ⇒
     `202 Accepted { job_id, eta_seconds: null }`. The server enqueues to a job
     service (in-process for M1; pluggable for M2+).
  2. `GET /api/v1/jobs/{job_id}` ⇒ `{ status, progress, eta_seconds,
     output_url?, error? }`. `output_url` is a 15-minute signed URL.
- **Codepath.** The engine executes `file.exportMedia` with `wait: true` over
  the WS the request came in on; the server also publishes the job to a shared
  queue so a separate worker process can take ownership of long encodes.

### 2.7 Telemetry / observability

- **Engine traces.** Every `Session::execute` is wrapped in `TracingSession`,
  which records `{user_id, command, params_hash, latency_ms, success, error}`,
  batches to `{date}.jsonl`. `params_hash` not `params`: AGENTS.md §1 (no
  PII in logs without explicit consent; the spec's "params_hash" preserves
  debugging while honouring that).
- **HTTP traces.** `tower_http::trace::TraceLayer` already in `main.rs`;
  extend to include `request_id` (UUID) so logs can be stitched.
- **Health.** `GET /api/v1/health` ⇒ 200 if alive, 503 if any subsystem
  (OSS adapter, SessionManager) can't talk to its backing.

### 2.8 Deployment topology (pluggable)

The 2026-10-08 spec committed to SAE (Aliyun). Generalising that for M2.5:

| Role | Backend class | Concretely (alphabetical, not exhaustive) |
|---|---|---|
| **Front door** | reverse proxy with TLS, static `/api/*` routing | Aliyun SLB / AWS ALB / nginx / Caddy |
| **Server (stateful)** | long-lived container, ≥ 1 process, sticky sessions optional | Aliyun SAE / AWS Fargate / ECS / Kubernetes / bare-metal |
| **Storage (object)** | S3-protocol-compatible | Aliyun OSS / AWS S3 / MinIO / GCS (compat mode) |
| **Worker (stateless)** | per-job ephemeral capacity, *can* time out | Aliyun FC / AWS Lambda / Cloud Run / sidecar in the server |
| **Telemetry sink** | object store + JSON Lines, optional central logging | Aliyun SLS / AWS CloudWatch / Grafana Loki / file only |
| **AI sidecar** | optional per-request LLM with Function Calling | Aliyun Bailian / OpenAI / Anthropic / self-hosted vLLM |

The server is concrete; the topology is whatever wraps it. The server itself
never knows which cloud it's on. This is enforced by *all* vendor SDKs being
behind `opendal` (storage) or `reqwest` (HTTP), and the in-process worker being
its first implementation.

### 2.9 Engine coverage

The web UI does not, today, drive every engine command. Boundaries in M2.5:

| Web UI does today (M1.7 → M2.2) | Web UI does *not* do yet |
|---|---|
| List / create / open / delete projects | Drag timeline (M2 timeline-milestone) |
| Upload media + range-stream | Trim / ripple / slip / slide (M2) |
| Engine Console panel (run any engine command + see reply) | Lumetri colour (M3) |
| Play raw media via OSS-style signed URL | Audio mix (M3) |
| Trigger export, poll job status | Effects / transitions UI (M3) |

The Engine Console is the *escape hatch*: any feature the web UI doesn't
expose can be driven from a panel by command id. So M2.x's job is to *grow*
the UI, not invent new engine commands.

### 2.10 Local ↔ cloud round-trip

- **Surface.** `GET /api/v1/projects/{id}/fcproj` (raw; `Content-Type: application/json; charset=utf-8`, no `Content-Disposition`) and `GET /api/v1/projects/{id}/export.fcproj` (attachment). Symmetric `POST` is out of scope for M1.x; the round-trip is *download-only* until an interchange story is built (M3.x).
- **What it proves.** The file round-trips on its own; the *media* round-trips
  only when the consuming client has access to the same blob store. Documents
  ship; media follows by reference.

---

## 3. Vendor-specific guidance

The 2026-10-08 spec recommended Aliyun for the first deployment; that recommendation
stands, but the recommendations now live as concrete advice rather than architecture:

### 3.1 Aliyun (Alibaba Cloud)

- **Server.** SAE (Serverless App Engine). Cold start ≤ 60s; reserve one instance to
  eliminate first-request latency. Mount a RAM Role to the OSS bucket; do **not**
  embed AccessKey.
- **Storage.** OSS, private bucket, virtual-hosted–style addressing, internal
  endpoint from SAE.
- **Workers.** FC (Function Compute) for *short* jobs only (≤ 5 min, burst mode).
  Anything longer: same SAE instance (M1 fall-back), or FC Provisioned mode
  (expensive but relaxed time-out).
- **Telemetry.** SLS with a project per environment. Optional Aliyun ARMS for
  trace stitching.
- **AI.** Bailian (阿里云百炼) with Function Calling; round-trip via the
  sidecar described in §6 of the prior version. Defer to M3.x.

### 3.2 AWS-equivalent

- **Server.** ECS Fargate on Fargate Spot for dev, Fargate regular for staging.
- **Storage.** S3, Block Public Access on, VPC gateway endpoint from Fargate.
- **Workers.** Lambda up to 15 minutes; Step Functions for the long-tail.
- **Telemetry.** CloudWatch Logs + X-Ray; S3 cold-tier for archives.

### 3.3 Self-hosted / on-prem

- **Server.** systemd unit, bound to `127.0.0.1` behind nginx with TLS
  termination. Single binary; no service mesh.
- **Storage.** MinIO, single-node for dev, distributed for prod.
- **Workers.** Same node, separate process; supervisor(8) or just systemd.
- **Telemetry.** Loki + Prometheus via Promtail; Loki *or* a JSONL dump.

The M2.5 commitment: **no code change** to switch from Aliyun to AWS to on-prem.
Only `OssServices::new(...)` (or its successor) receives a different backend
builder, and any vendor SDK is feature-flagged so the dev build never pulls it.

---

## 4. Mapped to milestones (2026-10-12 baseline)

| M-id | Surface | Status |
|---|---|---|
| **M1.7** | `filmcraft-server` crate root + SPA fallback | ✅ done |
| **M2.1** | Per-project WebSocket sessions + auto-load on connect | ✅ done |
| **M2.2** | Web-UI WS bridge + Zustand store + raw `/fcproj` fetch | ✅ done |
| **M2.3** | Web-UI README (Engine Console, /api/v1 trap) | ✅ done |
| **M2.4** | `cloud/filmcraft-{server,web-ui}/` subtree extraction | ✅ done |
| **M2.5** | This document — product surface (vendor-neutral) | ✅ done |
| **M2.6** | `S3Services` (M1.3b-S3) behind feature flag; identical trait surface to `OssServices`; same tests | ⏭ next |
| **M2.7** | `OssServices` Aliyun-OSS variant (M1.3b-OSS) via `opendal`; reuse M2.6 test suite | ⏭ |
| **M2.8** | Engine Console: command palette, role-aware filtering, persistence of recent commands | ⏭ |
| **M2.9** | Project versioning: `meta.json` + `history/*.fcproj`; CLI verifier from local `.fcproj` round-trip | ⏭ |
| **M2.10** | Telemetry: `TracingSession` + HTTP `request_id`; JSONL sink with rotation | ⏭ |
| **M3.1** | Auth: dev single-user token; `AuthResolver` trait; default to "anonymous" until M3.2 | ⏭ |
| **M3.2** | Auth: username + bcrypt; `users/{u}/profile.json` in OSS | ⏭ |
| **M3.3** | Auth: OIDC; per-deployment config, server doesn't ship an OIDC client | ⏭ |
| **M3.4** | AuthZ: per-`(user, project)` ACL; `viewer | editor | owner`; server enforces | ⏭ |
| **M3.5** | Job service abstraction: same process queue for M1, pluggable for M2+; worker process can attach | ⏭ |
| **M3.6** | Export pipeline: `POST .../export` triggers worker; `GET .../jobs/{id}` polls; signed output URLs | ⏭ |
| **M3.7** | AI sidecar skeleton: chat endpoint + Function Calling schema; one LLM provider at a time | ⏭ |
| **M3.8** | Real-time preview proxies (M2 from old spec): `media → 720p H.264 → proxies/{media_id}.mp4`, Range-served from cloud; **deferred behind M3.x** | ⏭ |
| **M3.9** | Interchange: `FCPXML` / `AAF` import-export via existing `crates/interchange`; UI affordances | ⏭ |
| **M4.x** | Performance, scale, billing | (open) |

**Open M-ids below the line** (`gaps.md` G-styles for cloud):

- `gaps.md G-cloud-1` — no persistence for engine auto-save / journal; a server
  crash loses unsaved edits. Mitigated by M2.9 (history) + the engine's existing
  journal (when wired).
- `gaps.md G-cloud-2` — no rate limit on `/api/v1/ws`; a misbehaving client can
  flood commands. Mitigated by M3.5.
- `gaps.md G-cloud-3` — signed URLs are time-boxed; the same media cannot be
  shared across two browser tabs in different projects cheaply. Same.

These mirror the desktop gaps.md format (§G-cloud-N) so a single doc indexes both.

---

## 5. What is *out* of scope (updated)

Compared with the 2026-10-08 spec:

- **Real-time collaboration (CRDT / OT).** Still out. The web UI is single-user
  per project; multi-tab is multi-session, multi-user is sequential via the
  pessimistic lock. Removing this from the in-scope list earlier helps prioritise.
- **Plugin hosting (VST3 / Audio Units / OpenFX).** Out — desktop roadmap owns it.
- **Camera RAW, 10-bit / 4:2:2 decode.** Out — `crates/codecs` doesn't ship them
  yet; M2.7+ tracks upstream `crates/codecs`.
- **Billing / metering.** Out. Telemetry (M2.10) lays the event stream; billing
  is M4.x.
- **Upstream desktop maintenance.** Out. The 2026-10-08 spec left the desktop
  alone; M2.4 made that explicit by extracting the cloud subtree. The cloud
  branch does **not** merge upstream `main`; it cherry-picks selectively when
  `crates/engine` / `media` / `format` / `project` change in a way that matters
  to the cloud product.

---

## 6. Quality gates (per commit)

Inherits from `CLAUDE.md`:

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `cargo xtask layers` (cloud/ entries are name-based; the M2.4 move was path-agnostic)
- `cargo xtask assets` (cloud has no media; the .tsbuildinfo and node_modules are gitignored)
- `cargo xtask wasm` (cloud doesn't ship WASM; `apps/filmcraft-web` is the WASM app and is unaffected)

Plus cloud-specific:

- A WS smoke test (`scripts/smoke-ws.mjs`) runs end-to-end against a fresh container.
- `npm run build` in `cloud/filmcraft-web-ui/` regenerates `dist/` and the server's SPA fallback picks it up after restart.

---

## 7. Decisions (2026-10-12 update)

| Date | Decision | Rationale |
|---|---|---|
| 2026-10-08 | SAE as the primary server backend on Aliyun | FC's 5 min cap is below export budgets |
| 2026-10-08 | Pessimistic lock, not CRDT | Implementation simplicity; user scale is small |
| 2026-10-08 | No engine code changes | Risk reduction; `engine::Services` is the seam |
| 2026-10-12 | Extract `cloud/` subtree | Upstream `storytold/filmcraft` has 1110 desktop commits; cloud doesn't track them wholesale |
| 2026-10-12 | Vendor-neutral product surface | Same code ships to Aliyun, AWS, on-prem; vendor choices live in deployment docs, not in server code |

---

## 8. Open questions for the maintainer

1. **First deployment target.** Aliyun (per 2026-10-08 recommendation) or AWS or on-prem? The next M-id (M2.6) is identical for any of them; the choice only changes the credentials flow.
2. **Telemetry sink.** JSONL-on-OSS (M1-style) or SLS / CloudWatch / Loki (M2-style)? M2.10 is the same shape either way; the sink is one trait.
3. **Auth at launch.** Dev token (M3.1, week-one) vs full username+bcrypt (M3.2, two weeks)? Quick-win vs product-feel.
4. **Job service in M3.5.** Same-process queue (M1-simple) vs out-of-process worker (M2-ready)? Aliyun FC + SAE co-existence is non-trivial.
5. **First AI provider for M3.7.** Aliyun Bailian / OpenAI / Anthropic? Same LLM client surface (`reqwest`); provider is one trait.
6. **`gaps.md` format.** Should cloud gaps (G-cloud-N) be added to the existing `docs/gaps.md`, or a new `docs/gaps-cloud.md`? M2.10 audit depends.

---

## 9. References

- [`architecture.md`](architecture.md) — layering, command system, services trait
- [`control-protocol.md`](control-protocol.md) — JSON Lines protocol detail
- [`gaps.md`](gaps.md) — desktop gaps (G1–G12); cloud gaps (G-cloud-N) appended here
- [`testing.md`](testing.md) — testing strategy, including the cloud smoke scripts
- [AGENTS.md](../AGENTS.md) — no-unwrap, no-panic, asset allowlist, attribution
- [CLAUDE.md](../CLAUDE.md) — workspace gates, commit conventions
- [`ROADMAP.md`](../ROADMAP.md) — desktop parity (feature breadth, ready-for-real-work); cloud milestones tracked separately here
