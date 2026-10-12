/**
 * WebSocket client for the FilmCraft headless control protocol (M2.2).
 *
 * Mirrors `apps/filmcraft-server/src/ws.rs` on the wire:
 *
 *   - Request frame: `{ "id": <number|string|null>, "method": <str>,
 *     "params": <object> }`. `id` and `params` are optional. The
 *     `engine.execute` method carries the engine command under
 *     `params.command` (with optional `params.params` for inner args);
 *     `engine.commands` and `perf.stats` are top-level.
 *   - Reply frame: same shape as the request, with `id` echoed, `ok`,
 *     and either `result` or `error`. A reply can carry `id: null`
 *     when the server pre-emptively rejects the whole session (auto-
 *     load failure).
 *   - One text frame may carry one *or* many newline-separated requests
 *     and gets one reply frame per request.
 *   - Junk (HTTP line, non-object JSON, missing `method`) → one error
 *     reply that contains "closing the connection", then the server
 *     sends Close 1008. We surface that as the `fatal` state.
 *   - Binary frames → same: error reply + Close 1008.
 *
 * The client owns the auto-load contract: when the server sends the
 * first reply with `id === null` and `ok === false` (which only happens
 * when `file.open` failed inside `handle_socket`), we transition
 * straight to `fatal` and stop retrying. All other `closed` states go
 * through the bounded reconnect loop.
 *
 * The default URL builder is `${wsBase()}?project_id=${id}` where
 * `wsBase()` derives `ws://` / `wss://` from `window.location` and
 * uses the same `/api/v1/ws` path the server exposes. In dev (Vite
 * proxy on 5173) the WS upgrade is forwarded to `127.0.0.1:8080`.
 */

import type { ConnectionState, WsReply } from "./types";

/** Maximum time to wait for a single round-trip before rejecting. */
const REPLY_TIMEOUT_MS = 10_000;

/**
 * Cap on reconnect attempts before giving up. The server only closes
 * once per session; if the network died we still try a few times so a
 * flaky WiFi handoff doesn't lock the user out.
 */
const MAX_RECONNECT_ATTEMPTS = 3;

/** Delay between reconnect attempts (linear, not exponential — short cap). */
const RECONNECT_DELAY_MS = 500;

/** Identity of an in-flight request. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Identity of a single buffered line the caller asked us to send. */
interface QueuedSend {
  text: string;
}

export type ClientStateListener = (state: ConnectionState, detail?: { error?: string }) => void;

export class WsClient {
  private url: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private listeners = new Set<ClientStateListener>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  /** Last fatal error — kept so the UI can show it after the socket is gone. */
  private lastFatal: string | null = null;

  constructor(url: string) {
    this.url = url;
  }

  /** Current connection state — read-only; UI subscribes via `onState`. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Fatal auto-load error, if any. `null` otherwise. */
  getFatal(): string | null {
    return this.lastFatal;
  }

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onState(cb: ClientStateListener): () => void {
    this.listeners.add(cb);
    // Fire once with the current state so a late subscriber doesn't miss it.
    cb(this.state, { error: this.lastFatal ?? undefined });
    return () => this.listeners.delete(cb);
  }

  /**
   * Open the WebSocket. Returns when the socket has reached the `open`
   * state (or rejected with the underlying error). Auto-reconnects on
   * transient close, but not after `disconnect()` or a fatal close.
   */
  connect(): Promise<void> {
    if (this.ws !== null && this.state !== "closed" && this.state !== "fatal") {
      // Already connecting or open. Idempotent: return the in-flight promise.
      return Promise.resolve();
    }
    this.intentionalClose = false;
    return this.openOnce();
  }

  /**
   * Close the socket on purpose. After this, `connect()` will start
   * fresh (no reconnect loop).
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.failAllPending(new Error("client disconnected"));
    if (this.ws !== null) {
      try {
        this.ws.close(1000, "client disconnect");
      } catch {
        /* already closed — fine */
      }
    }
    this.setState("closed");
  }

  /**
   * Send one method call and resolve with its `result`. Rejects with
   * an `Error` carrying the server's `error` string verbatim on
   * `ok: false`, or a timeout / connection error.
   *
   * The returned promise resolves only after the matching reply is
   * received (matched by `id`).
   */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const req = { id, method, params: params ?? {} };
    const text = JSON.stringify(req);

    if (this.state !== "open" || this.ws === null) {
      return Promise.reject(new Error(`ws not open (state=${this.state})`));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ws reply timeout after ${REPLY_TIMEOUT_MS}ms for method \`${method}\``));
      }, REPLY_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      // Errors from `send` are surfaced by the WS `onerror` handler
      // (state transition) and also by rejecting the pending request.
      try {
        this.ws!.send(text);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Send a multi-line frame and get one reply per line back. */
  callBatch(lines: QueuedSend[]): Promise<WsReply[]> {
    if (this.state !== "open" || this.ws === null) {
      return Promise.reject(new Error(`ws not open (state=${this.state})`));
    }
    const text = lines.map((l) => l.text).join("\n");
    return new Promise<WsReply[]>((resolve, reject) => {
      const collect: WsReply[] = [];
      const onReply = (reply: WsReply) => {
        collect.push(reply);
        if (collect.length === lines.length) {
          this.off("__reply__", onReply);
          resolve(collect);
        }
      };
      // Internal one-shot subscription for this batch.
      this.once("__reply__", onReply);
      try {
        this.ws!.send(text);
      } catch (e) {
        this.off("__reply__", onReply);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // ----- internals -----

  private setState(next: ConnectionState, detail?: { error?: string }): void {
    if (this.state === next) return;
    this.state = next;
    for (const cb of this.listeners) cb(next, detail);
  }

  private openOnce(): Promise<void> {
    this.setState("connecting");
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.setState("closed", { error: err.message });
        reject(err);
        return;
      }
      this.ws = ws;

      const onOpen = () => {
        this.reconnectAttempts = 0;
        this.setState("open");
        // Note: do NOT call `cleanup()` here. The `message` and
        // `close` listeners must keep firing for the lifetime of
        // the connection; only the close handler removes them.
        resolve();
      };
      const onError = () => {
        // The actual close event follows; we set state there. Don't
        // reject here because the spec says errors fire before close.
      };
      const onClose = (ev: CloseEvent) => {
        cleanup();
        // If the server explicitly closed us with a fatal-style code
        // and we already know the auto-load error, stay in `fatal`
        // (which `onMessage` set). Otherwise treat as a normal close
        // and decide whether to reconnect.
        if (this.state === "fatal") return;
        // A normal close rejects any in-flight `call()` promises so
        // callers don't hang waiting for a reply that will never
        // come. The `fatal` path already drained pending in
        // `handleMessage`.
        this.failAllPending(new Error(`ws closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`));
        // Always drop to `closed` so the UI badge reflects reality
        // (no longer receiving messages). `openOnce()` flips it back
        // to `connecting` when the reconnect timer fires.
        if (this.intentionalClose) {
          this.setState("closed");
          return;
        }
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          this.setState("closed", {
            error: `connection closed after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts (code ${ev.code})`,
          });
          return;
        }
        this.setState("closed");
        this.reconnectAttempts++;
        setTimeout(() => {
          if (this.intentionalClose || this.state === "fatal") return;
          this.openOnce().catch(() => {
            /* swallowed: state already updated by the inner openOnce */
          });
        }, RECONNECT_DELAY_MS);
      };
      const onMessage = (ev: MessageEvent) => this.handleMessage(ev);
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("message", onMessage);
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      ws.addEventListener("message", onMessage);
    });
  }

  private handleMessage(ev: MessageEvent): void {
    // The server only sends text frames (binary → error reply + close).
    if (typeof ev.data !== "string") {
      this.failAllPending(new Error("ws received non-text frame"));
      return;
    }
    const lines = ev.data.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Should not happen — the server filters its own junk. If it
        // does, drop the line; do not fail the whole call.
        continue;
      }
      const reply = parsed as Partial<WsReply>;
      if (typeof reply !== "object" || reply === null) continue;
      const r: WsReply = {
        id: typeof reply.id === "number" || reply.id === null ? reply.id : null,
        ok: reply.ok === true,
        result: reply.result,
        error: typeof reply.error === "string" ? reply.error : undefined,
      };

      // Auto-load fatal error arrives as `id: null, ok: false`. The
      // server then sends Close 1008, which will be reflected by the
      // close handler. We surface it now so the UI can react before
      // the close frame is processed.
      if (r.id === null && !r.ok && r.error) {
        this.lastFatal = r.error;
        this.failAllPending(new Error(r.error));
        this.setState("fatal", { error: r.error });
        this.emit("__reply__", r);
        continue;
      }

      if (r.id === null) {
        // Unsolicited reply with no id — ignore.
        this.emit("__reply__", r);
        continue;
      }

      const pending = this.pending.get(r.id);
      if (pending === undefined) {
        // Late reply for a request we already timed out / rejected.
        this.emit("__reply__", r);
        continue;
      }
      this.pending.delete(r.id);
      clearTimeout(pending.timer);
      if (r.ok) {
        pending.resolve(r.result);
      } else {
        pending.reject(new Error(r.error ?? "ws reply error"));
      }
      this.emit("__reply__", r);
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  // ----- ultra-light internal event bus (for `callBatch` only) -----

  private bus = new Map<string, Set<(reply: WsReply) => void>>();

  private emit(name: string, reply: WsReply): void {
    const set = this.bus.get(name);
    if (set === undefined) return;
    for (const cb of set) cb(reply);
    // `once` semantics: callers clear the entry themselves; we don't
    // auto-delete so `callBatch` can collect across multiple replies.
  }

  private once(name: string, cb: (reply: WsReply) => void): void {
    let set = this.bus.get(name);
    if (set === undefined) {
      set = new Set();
      this.bus.set(name, set);
    }
    set.add(cb);
  }

  private off(name: string, cb: (reply: WsReply) => void): void {
    this.bus.get(name)?.delete(cb);
  }
}

/**
 * Derive the WebSocket URL for `/api/v1/ws?project_id=<id>` from the
 * current `window.location`. The browser-side `ws://` (or `wss://`)
 * scheme must match `http://`/`https://`; we let the URL class do that.
 */
export function wsUrl(projectId: string): string {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/api/v1/ws?project_id=${encodeURIComponent(projectId)}`;
}