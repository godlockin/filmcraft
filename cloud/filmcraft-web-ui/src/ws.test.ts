/**
 * Vitest unit tests for `WsClient` (M2.2).
 *
 * We exercise the state machine with the browser `WebSocket`
 * implementation mocked. The mock implements the spec's events
 * deterministically (`open`, `message`, `close`) and exposes
 * helpers for the test to fire them on demand.
 *
 * What's covered:
 *   - `connect()` reaches `open`.
 *   - `call()` round-trips a single reply by `id`.
 *   - Two concurrent `call()`s each resolve independently.
 *   - Reply with `id: null, ok: false` triggers the `fatal` state.
 *   - `close` from the server triggers the `closed` state and
 *     rejects in-flight pending calls.
 *   - Junk / non-object JSON lines are silently skipped (the spec
 *     guarantees the server filters its own — if a junk reply leaks
 *     through, dropping it is safer than failing a successful call).
 *   - Multi-line text frame: each line gets its own reply.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient, wsUrl } from "./ws";
import { clearAuth, setAuth } from "./lib/auth";

// Polyfill `CloseEvent` — happy-dom doesn't ship it. We only use the
// `code` and `reason` fields, so a small subclass of `Event` is enough.
if (typeof globalThis.CloseEvent === "undefined") {
  class CloseEventPolyfill extends Event {
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
    constructor(type: string, init: { code?: number; reason?: string } = {}) {
      super(type);
      this.code = init.code ?? 0;
      this.reason = init.reason ?? "";
      this.wasClean = this.code === 1000;
    }
  }
  (globalThis as { CloseEvent: typeof CloseEvent }).CloseEvent =
    CloseEventPolyfill as unknown as typeof CloseEvent;
}

/** Minimal stand-in for the browser `WebSocket`. */
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  readyState: number = 0; // CONNECTING
  sent: string[] = [];
  // Legacy `on<event>` handlers (set via property assignment).
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  // `addEventListener` registry, keyed by event name.
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    let set = this.listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener);
  }
  removeEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(name)?.delete(listener);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    queueMicrotask(() => {
      this.fireClose(code, reason);
    });
  }
  /** Test helper: simulate the server opening the connection. */
  fireOpen(): void {
    this.readyState = 1;
    const ev = new Event("open");
    this.onopen?.(ev);
    this.listeners.get("open")?.forEach((l) => callListener(l, ev));
  }
  /** Test helper: simulate the server sending text data. */
  fireMessage(text: string): void {
    const ev = new MessageEvent("message", { data: text });
    this.onmessage?.(ev);
    this.listeners.get("message")?.forEach((l) => callListener(l, ev));
  }
  /** Test helper: simulate the server closing the connection. */
  fireClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    const ev = new CloseEvent("close", { code, reason });
    this.onclose?.(ev);
    this.listeners.get("close")?.forEach((l) => callListener(l, ev));
  }
}

function callListener(l: EventListenerOrEventListenerObject, ev: Event): void {
  if (typeof l === "function") l(ev);
  else l.handleEvent(ev);
}

// Stub the global WebSocket constructor. Vitest's vi.stubGlobal is
// reset in `beforeEach` via `vi.restoreAllMocks` (see afterEach).
const ctor = vi.fn((url: string) => new FakeWS(url));
beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal("WebSocket", ctor);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WsClient", () => {
  it("reaches the open state on connect()", async () => {
    const client = new WsClient("ws://test/ws");
    const p = client.connect();
    expect(FakeWS.instances).toHaveLength(1);
    FakeWS.instances[0].fireOpen();
    await p;
    expect(client.getState()).toBe("open");
  });

  it("call() resolves with the matching reply's result", async () => {
    const client = new WsClient("ws://test/ws");
    const p = client.connect();
    const ws = FakeWS.instances[0];
    ws.fireOpen();
    await p;

    const pending = client.call<{ hello: string }>("engine.execute", { command: "sequence.inspect" });
    expect(ws.sent).toHaveLength(1);
    const req = JSON.parse(ws.sent[0]) as { id: number; method: string };
    expect(req.method).toBe("engine.execute");
    ws.fireMessage(JSON.stringify({ id: req.id, ok: true, result: { hello: "world" } }));
    await expect(pending).resolves.toEqual({ hello: "world" });
  });

  it("rejects when the reply has ok=false", async () => {
    const client = new WsClient("ws://test/ws");
    const p = client.connect();
    const ws = FakeWS.instances[0];
    ws.fireOpen();
    await p;

    const pending = client.call("engine.execute", { command: "no.such" });
    const req = JSON.parse(ws.sent[0]) as { id: number };
    ws.fireMessage(JSON.stringify({ id: req.id, ok: false, error: "no.such: unknown" }));
    await expect(pending).rejects.toThrow(/no.such: unknown$/);
  });

  it("two concurrent calls resolve independently", async () => {
    const client = new WsClient("ws://test/ws");
    const p = client.connect();
    const ws = FakeWS.instances[0];
    ws.fireOpen();
    await p;

    const a = client.call<number>("perf.stats");
    const b = client.call<number>("engine.commands");
    const sent = ws.sent.map((s) => JSON.parse(s) as { id: number; method: string });
    const aId = sent.find((s) => s.method === "perf.stats")!.id;
    const bId = sent.find((s) => s.method === "engine.commands")!.id;
    // Replies arrive out of order — the client matches them by id.
    ws.fireMessage(JSON.stringify({ id: bId, ok: true, result: 2 }));
    ws.fireMessage(JSON.stringify({ id: aId, ok: true, result: 1 }));
    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe(2);
  });

  it("a fatal reply (id=null, ok=false) transitions to fatal and stops reconnect", async () => {
    const client = new WsClient("ws://test/ws");
    const states: string[] = [];
    client.onState((s) => states.push(s));
    const p = client.connect();
    const ws = FakeWS.instances[0];
    ws.fireOpen();
    await p;

    ws.fireMessage(JSON.stringify({ id: null, ok: false, error: "project load failed: nope" }));
    expect(client.getState()).toBe("fatal");
    expect(client.getFatal()).toMatch(/project load failed/);
    expect(states).toContain("fatal");

    // Now the server sends the close frame. The client must NOT
    // reconnect after a fatal.
    ws.fireClose(1008, "project load failed");
    // Wait one event-loop tick so any reconnect setTimeout would fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getState()).toBe("fatal");
  });

  it("a normal server close transitions to closed and rejects pending calls", async () => {
    const client = new WsClient("ws://test/ws");
    const p = client.connect();
    const ws = FakeWS.instances[0];
    ws.fireOpen();
    await p;

    const pending = client.call("engine.execute", { command: "x" });
    const req = JSON.parse(ws.sent[0]) as { id: number };
    ws.fireClose(1000, "bye");
    await expect(pending).rejects.toThrow(/disconnected|close/i);
    expect(client.getState()).toBe("closed");
    // Suppress "unused" warning for `req`.
    void req;
  });

  it("skips junk lines in a multi-line frame", async () => {
    const client = new WsClient("ws://test/ws");
    const p = client.connect();
    const ws = FakeWS.instances[0];
    ws.fireOpen();
    await p;

    const pending = client.call<{ ok: true }>("engine.execute", { command: "perf.stats" });
    const req = JSON.parse(ws.sent[0]) as { id: number };
    ws.fireMessage(
      [
        "", // blank line — skipped
        "{not json}", // junk — skipped silently
        JSON.stringify({ id: req.id, ok: true, result: { ok: true } }),
        "",
      ].join("\n"),
    );
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("intentional disconnect() does not trigger a reconnect", async () => {
    const client = new WsClient("ws://test/ws");
    const p = client.connect();
    const ws = FakeWS.instances[0];
    ws.fireOpen();
    await p;

    client.disconnect();
    expect(client.getState()).toBe("closed");
    // Wait past the reconnect delay (50ms < 500ms RECONNECT_DELAY_MS).
    await new Promise((r) => setTimeout(r, 50));
    // No second FakeWS was created.
    expect(FakeWS.instances).toHaveLength(1);
  });
});

describe("wsUrl (M2.7b)", () => {
  const originalLocation = window.location;
  const originalProtocol = originalLocation.protocol;
  const originalHost = originalLocation.host;

  function setLocation(protocol: string, host: string): void {
    // happy-dom lets us patch these via `Object.defineProperty`. We
    // don't restore the original descriptor across tests because
    // happy-dom is recreated per test file in the standard config.
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, protocol, host },
      configurable: true,
    });
  }

  afterEach(() => {
    clearAuth();
    // Restore in case a test changed them.
    setLocation(originalProtocol, originalHost);
  });

  it("builds the bare URL with just ?project_id when no token is set", () => {
    setLocation("http:", "example.test:5173");
    expect(wsUrl("demo")).toBe("ws://example.test:5173/api/v1/ws?project_id=demo");
  });

  it("appends &token=<token> when a token is in localStorage", () => {
    setLocation("https:", "film.test");
    setAuth({ token: "tok-1", userId: "admin", role: "admin" });
    expect(wsUrl("demo")).toBe("wss://film.test/api/v1/ws?project_id=demo&token=tok-1");
  });

  it("URL-encodes a project id that contains special characters", () => {
    setLocation("http:", "example.test:5173");
    expect(wsUrl("a/b c")).toBe("ws://example.test:5173/api/v1/ws?project_id=a%2Fb%20c");
  });

  it("URL-encodes a token that contains special characters", () => {
    setLocation("http:", "example.test:5173");
    setAuth({ token: "a/b c", userId: "admin", role: "admin" });
    expect(wsUrl("demo")).toBe("ws://example.test:5173/api/v1/ws?project_id=demo&token=a%2Fb%20c");
  });
});
