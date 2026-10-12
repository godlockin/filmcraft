/**
 * Zustand store for the per-project WebSocket session (M2.2).
 *
 * One store, one active project at a time. `connect(projectId)` opens
 * the WS to `/api/v1/ws?project_id=<id>`; the server runs `file.open`
 * on the project's `.fcproj` and either:
 *
 *   - succeeds → first user-visible call returns populated engine state.
 *   - fails   → the server sends one error reply (id=null) then Close
 *               1008; we surface that as `state === "fatal"` and stop
 *               the reconnect loop. The store records the error so
 *               the UI can render it.
 *
 * The store is intentionally small. It is not a generic engine cache
 * (M2.3+ will add proper timeline/track/clip caches). For M2.2 we just
 * need to:
 *
 *   - prove the WS bridge is reachable and isolated per project;
 *   - round-trip a few representative engine commands so the user can
 *     see the protocol actually works from a browser;
 *   - show that the raw `/fcproj` endpoint is usable from JS.
 */

import { create } from "zustand";
import { WsClient, wsUrl } from "./ws";
import { fetchFcproj } from "./api";
import { loadRecent, pushRecent } from "./lib/history";
import type { ConnectionState, CommandInfo } from "./types";

/** Result of an engine command (typed loosely on purpose; the server is schemaless). */
export type EngineResult = unknown;

/** Result of the last `fetchFcproj` call. `null` until the first fetch. */
export type RawFcproj =
  | {
      ok: true;
      status: number;
      contentType: string | null;
      size: number;
      hexPreview: string;
      textPreview: string;
    }
  | {
      ok: false;
      status: number;
      kind: "no-save" | "http";
      error: string;
    }
  | null;

export interface EngineState {
  // ----- session lifecycle -----
  /** Project id we're currently bound to. `null` until `connect` resolves. */
  activeProject: string | null;
  connectionState: ConnectionState;
  /** Last fatal error (auto-load failure). `null` otherwise. */
  fatalError: string | null;
  /** Last transient error (timeout, server error on a single call). */
  lastError: string | null;
  /** Time of the last successful reply — null until first success. */
  lastOkAt: number | null;

  // ----- engine surface (small M2.2 subset; M2.3+ will add timeline ops) -----
  /** Last `sequence.inspect` result. */
  sequenceInfo: EngineResult;
  /** All keys/values seen so far via `prefs.get`. Map keyed by pref name. */
  prefs: Record<string, unknown>;
  /** Result of the last `engine.commands` call. */
  commands: CommandInfo[] | null;
  /** Result of the last `fetchRawFcproj` call. `null` until the user triggers one. */
  rawFcproj: RawFcproj;
  /** Most-recently-used command ids (MRU first), persisted across reloads. */
  recentCommands: string[];

  // ----- actions -----
  connect: (projectId: string) => Promise<void>;
  disconnect: () => void;
  inspectSequence: () => Promise<void>;
  setPreference: (key: string, value: unknown) => Promise<void>;
  getPreference: (key: string) => Promise<void>;
  saveProject: () => Promise<void>;
  listCommands: () => Promise<void>;
  fetchRawFcproj: () => Promise<void>;
  clearRawFcproj: () => void;
  /**
   * Generic command invocation used by the M2.8 command palette.
   * Runs `command` with no params; pushes the id onto the recent-history
   * list (localStorage) only on success so the MRU reflects commands
   * that actually worked.
   */
  runCommand: (command: string) => Promise<EngineResult>;
  /** Force-refresh the recent list (e.g. after the user clears it). */
  reloadRecentCommands: () => void;
}

/** Internal helper that gets / sets `client` outside React render. */
let client: WsClient | null = null;
let unsubState: (() => void) | null = null;

export const useEngineStore = create<EngineState>((set, get) => ({
  activeProject: null,
  connectionState: "idle",
  fatalError: null,
  lastError: null,
  lastOkAt: null,
  sequenceInfo: null,
  prefs: {},
  commands: null,
  rawFcproj: null,
  // Bootstrap the MRU list from localStorage at store creation. The lib
  // helper gracefully returns `[]` when localStorage is unavailable (SSR,
  // unit tests, denied-storage browsers), so this is safe to call
  // unconditionally.
  recentCommands: loadRecent(),

  async connect(projectId: string): Promise<void> {
    if (get().activeProject === projectId && get().connectionState === "open") {
      return;
    }
    // Tear down the previous client (if any) before opening a new one.
    if (client !== null) {
      unsubState?.();
      unsubState = null;
      client.disconnect();
      client = null;
    }
    set({
      activeProject: projectId,
      connectionState: "connecting",
      fatalError: null,
      lastError: null,
      lastOkAt: null,
      sequenceInfo: null,
      prefs: {},
      commands: null,
      rawFcproj: null,
    });
    const next = new WsClient(wsUrl(projectId));
    client = next;
    unsubState = next.onState((state, detail) => {
      set({ connectionState: state });
      if (state === "fatal" && detail?.error) {
        set({ fatalError: detail.error });
      }
    });
    try {
      await next.connect();
    } catch (e) {
      set({
        connectionState: "closed",
        lastError: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  disconnect(): void {
    if (client !== null) {
      unsubState?.();
      unsubState = null;
      client.disconnect();
      client = null;
    }
    set({ activeProject: null, connectionState: "idle", fatalError: null });
  },

  async inspectSequence(): Promise<void> {
    if (client === null) return;
    try {
      const result = await client.call("engine.execute", {
        command: "sequence.inspect",
        params: {},
      });
      set({ sequenceInfo: result, lastOkAt: Date.now(), lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async setPreference(key: string, value: unknown): Promise<void> {
    if (client === null) return;
    try {
      await client.call("engine.execute", {
        command: "prefs.set",
        params: { key, value },
      });
      set({ prefs: { ...get().prefs, [key]: value }, lastOkAt: Date.now(), lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async getPreference(key: string): Promise<void> {
    if (client === null) return;
    try {
      const result = await client.call("engine.execute", {
        command: "prefs.get",
        params: { key },
      });
      set({ prefs: { ...get().prefs, [key]: result }, lastOkAt: Date.now(), lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async saveProject(): Promise<void> {
    if (client === null) return;
    try {
      await client.call("engine.execute", { command: "file.save", params: {} });
      set({ lastOkAt: Date.now(), lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async listCommands(): Promise<void> {
    if (client === null) return;
    try {
      const result = (await client.call("engine.commands")) as { commands?: CommandInfo[] };
      set({ commands: result?.commands ?? [], lastOkAt: Date.now(), lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async fetchRawFcproj(): Promise<void> {
    const projectId = get().activeProject;
    if (projectId === null) return;
    try {
      const result = await fetchFcproj(projectId);
      if (result.ok) {
        set({
          rawFcproj: {
            ok: true,
            status: result.status,
            contentType: result.contentType,
            size: result.bytes.byteLength,
            hexPreview: hexPreview(result.bytes, 64),
            textPreview: textPreview(result.bytes, 64),
          },
          lastError: null,
        });
      } else {
        set({
          rawFcproj: {
            ok: false,
            status: result.status,
            kind: result.kind ?? "http",
            error: result.error ?? "fetch failed",
          },
          lastError: result.error ?? "fetch failed",
        });
      }
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  clearRawFcproj(): void {
    set({ rawFcproj: null });
  },

  async runCommand(command: string): Promise<EngineResult> {
    // No-op when the WS isn't ready — the palette disables its buttons
    // while the connection is closed, but a programmatic caller might
    // still slip through. Guard at the boundary instead of trusting the UI.
    if (client === null) {
      const err = new Error("WebSocket not connected");
      set({ lastError: err.message });
      throw err;
    }
    if (typeof command !== "string" || command.length === 0) {
      const err = new Error("command id is empty");
      set({ lastError: err.message });
      throw err;
    }
    try {
      const result = await client.call("engine.execute", {
        command,
        params: {},
      });
      pushRecent(command);
      set({
        recentCommands: loadRecent(),
        lastOkAt: Date.now(),
        lastError: null,
      });
      return result;
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  reloadRecentCommands(): void {
    set({ recentCommands: loadRecent() });
  },
}));

/** First `n` bytes rendered as hex pairs separated by spaces. */
function hexPreview(bytes: Uint8Array, n: number): string {
  const len = Math.min(n, bytes.byteLength);
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    out.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return out.join(" ");
}

/** First `n` bytes rendered as UTF-8 text with non-printables replaced. */
function textPreview(bytes: Uint8Array, n: number): string {
  const len = Math.min(n, bytes.byteLength);
  const slice = bytes.subarray(0, len);
  try {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    return Array.from(decoded)
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code === 0x09 || code === 0x0a || code === 0x0d) return c;
        if (code < 0x20 || code === 0x7f) return ".";
        return c;
      })
      .join("");
  } catch {
    return "";
  }
}