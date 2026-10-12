# `apps/filmcraft-web-ui`

Minimal React + Vite + TypeScript front end for the headless
[`filmcraft-server`](https://github.com/storytold/filmcraft). This is the
browser UI used by the M1.x / M2.x milestones — it is **not** the WASM
desktop-in-browser build (that's [`apps/filmcraft-web`](../filmcraft-web);
see [`docs/web.md`](../../docs/web.md)).

| What | Where |
|---|---|
| List projects, create project, upload media, play media, export | `src/pages/`, `src/components/` (M1.7) |
| WebSocket bridge to the engine (`/api/v1/ws?project_id=...`) | `src/ws.ts` (M2.2) |
| Zustand store wrapping one `WsClient` per project | `src/store.ts` (M2.2) |
| Per-project "inspect / save / list commands / fetch raw .fcproj" panel | `src/components/EngineConsole.tsx` (M2.2) |
| Raw `.fcproj` fetch (no `Content-Disposition`) | `fetchFcproj` in `src/api.ts` (M2.2) |
| `WsClient` state-machine unit tests | `src/ws.test.ts` (M2.2) |

## Prerequisites

* Node ≥ 20 (Vite 5 requires it; the repo already runs on Node 22).
* A running `filmcraft-server` reachable from the browser. Either:
  * **Production** — `filmcraft-server` serves this app's `dist/` as a
    SPA fallback at `/`, with the API on the same origin under
    `/api/v1/*`. Nothing else is needed.
  * **Dev (recommended)** — run the server on `127.0.0.1:8080`
    (default `FILMCRAFT_LISTEN_ADDR`) and the Vite dev server on
    `:5173`; Vite proxies `/api` (HTTP and WS) to the server.

## Develop

```bash
# 1. start the backend (in a separate terminal, or via docker-compose)
cargo run -p filmcraft-server                 # listens on 127.0.0.1:8080
# — or —
docker compose up -d filmcraft-server         # binds 127.0.0.1:9081:8080

# 2. install dependencies once
npm install --no-audit --no-fund

# 3. start the dev server
npm run dev                                   # http://127.0.0.1:5173/
```

Vite forwards every `/api/*` request (including the WS upgrade) to the
backend, so cookies, auth headers and the WS `Origin` header all line up.
No CORS dance.

If your backend is on a different host/port, edit the `proxy` block in
[`vite.config.ts`](./vite.config.ts).

## Build

```bash
npm run build      # tsc -b && vite build → dist/
```

`dist/` is a static SPA. Drop it into
`apps/filmcraft-server/dist/` (the server's SPA fallback looks there)
and rebuild / restart the server to ship a new web bundle.

## Test

```bash
npm test           # vitest run — exercises src/ws.test.ts
```

The test file ships a minimal `WebSocket` mock (`FakeWS`) so the
`WsClient` state machine can be exercised under happy-dom without a real
network. Coverage:

* reaches `open` state and resolves `connect()`
* `call()` resolves with the matching reply's `result`
* `call()` rejects when the server replies `ok: false`
* two concurrent `call()`s get matched replies independently
* `id: null, ok: false` reply transitions to `fatal` (auto-load path)
* a normal server close rejects pending calls and does not reconnect
* junk lines (`""`, non-JSON) are skipped, not failed
* `disconnect()` is a no-reconnect intentional close

## Use

### Routes

| Path | Page | What you can do |
|---|---|---|
| `/` | `ProjectList` | List, create, delete projects. |
| `/project/:id` | `ProjectDetail` | Upload media, browse the media grid, play a clip, hit **Export** to download the saved `.fcproj`. From M2.2 on, also hosts the **Engine Console** panel. |

### The Engine Console (M2.2)

When you open `/project/:id`, the bottom of the page renders
`<EngineConsole projectId />`, which:

1. Opens a WebSocket to `ws(s)://<host>/api/v1/ws?project_id=<id>`.
2. Waits for the server's automatic `file.open` of the project's
   `current.fcproj`. The badge in the header reflects the state:

   | Badge | Meaning |
   |---|---|
   | `idle` | Component not yet started (transient). |
   | `connecting…` | WS opening. |
   | `connected` | Open and ready for commands. |
   | `disconnected` | Normal close; the client tried 3 reconnects (500 ms apart) before giving up. |
   | `load failed` | **Fatal.** The server sent an `id: null, ok: false` reply during auto-load, then Close 1008. Reconnecting won't fix this; save a `.fcproj` for the project first. |

3. Surfaces five actions, all of which are WS round-trips or HTTP
   fetches you can drive from `curl` / `wscat`:

   | Button | What it does | Wire call |
   |---|---|---|
   | **Inspect sequence** | Runs `engine.execute` → `sequence.inspect`. | `{"id":N,"method":"engine.execute","params":{"command":"sequence.inspect"}}` |
   | **Save project** | Runs `engine.execute` → `file.save` (writes the current in-memory session to OSS). | `{"id":N,"method":"engine.execute","params":{"command":"file.save"}}` |
   | **List commands** | Calls `engine.commands` (top-level, not under `engine.execute`). | `{"id":N,"method":"engine.commands"}` |
   | **Fetch raw .fcproj** | HTTP `GET /api/v1/projects/{id}/fcproj` — bytes, no `Content-Disposition`. | See [`fetchFcproj`](./src/api.ts). |
   | **Set / Get pref** | `engine.execute` → `prefs.set` / `prefs.get`. Useful for proving per-project isolation: open two tabs on different project ids and `Set` the same key — values must not cross over. | `{"id":N,"method":"engine.execute","params":{"command":"prefs.set","params":{"key":"...","value":"..."}}}` |

4. Shows the first **64 bytes** of the raw `.fcproj` as both hex pairs
   and printable-text (`.` for non-printable) so you can confirm the
   endpoint really did return the project bytes (and not a JSON error
   envelope).

### Project isolation

Two browser tabs (or two users) opening a WS to the same server with
different `?project_id=` query parameters get **independent** engine
sessions. The server keys `SessionManager` by `ProjectKey(UserId,
ProjectId)` (M2.1); the client just sends the id as the query string.

A quick proof: open `…/project/alpha` and `…/project/beta` in two
tabs, **Set** `ui.user.label` to `tab-A` / `tab-B`, **Get** it back in
each — neither tab should see the other's value.

### Per-call timeout

The `WsClient` rejects any `call()` that does not see its reply within
10 seconds (default `REPLY_TIMEOUT_MS`). The engine's synchronous
commands all return well under that; long-running engine jobs (export,
proxy render) go through their own async jobs and should not be issued
through this console.

## API doc on the server

The backend exposes a live JSON manifest of every endpoint at:

```
GET /api/v1          ← 200 application/json  (this is the one you want)
GET /api/v1/         ← 200 text/html         (M1.7 SPA fallback catches the trailing slash)
```

Trailing-slash form returns the React app's `index.html` because the
static-fallback middleware treats it as a directory and falls through to
the SPA. Always hit `/api/v1` without the trailing slash.

That's the canonical "API doc" for M2.x — the same payload the server
bakes into a `OnceLock` at startup. It is **not** the same as the
WebSocket protocol, which is documented in
[`apps/filmcraft-server/src/ws.rs`](../../apps/filmcraft-server/src/ws.rs).

On the current dev box (server running in docker on the Tailscale IP):

```sh
curl -s http://100.117.145.94:9081/api/v1 | jq .
# → { "status": "ok", "version": "0.2.1", "uptime_secs": …,
#     "endpoints": { … every method/path/description … } }

# Bad (returns the SPA's index.html — copy-paste trap):
curl -s http://100.117.145.94:9081/api/v1/ | head
# → <!DOCTYPE html><html lang="en"> …
```

In production replace the host/port with whatever the deployment exposes
(`FILMCRAFT_LISTEN_ADDR` or the docker-compose port mapping).

The full deployment guide is in
[`docs/filmcraft-server.md`](../../docs/filmcraft-server.md).