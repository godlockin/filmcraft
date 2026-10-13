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
import { clearAuth, getAuth, setAuth, type AuthState } from "./lib/auth";
import type { ConnectionState, CommandInfo } from "./types";

/** One entry in the event log ring buffer (M3.8). */
export interface EventLogEntry {
  /** Engine command id (e.g. `timeline.move`). */
  command: string;
  /** Wall-clock ms when the call returned. */
  timestamp: number;
  /** Call duration in milliseconds. */
  durationMs: number;
  /** True if the call returned without throwing. */
  ok: boolean;
  /** Optional error message when `ok === false`. */
  error?: string;
}

/** Body of `POST /api/v1/auth/login` and its 200-response shape. */
interface LoginResponse {
  ok: boolean;
  token?: string;
  user?: { id: string; role: string };
  error?: string;
}

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

  // ----- timeline slice (M3.3) -----
  /**
   * Last `sequence.inspect` result, narrowed into the small shape the
   * cloud timeline panel cares about. `null` until the first successful
   * call. The M3 plan uses `sequence.inspect` as the canonical
   * timeline query when no dedicated `timeline.read` exists.
   */
  timeline: {
    /** Last computed sequence length in ticks. */
    duration: number;
    /** Last playhead position in ticks. */
    playhead: number;
    /** Tracks currently shown by the timeline panel. */
    tracks: { id: string; kind: "video" | "audio" }[];
    /** Clips currently shown by the timeline panel. */
    clips: { id: string; track: string; in: number; out: number; label?: string }[];
  } | null;

  // ----- project slice (M3.3) -----
  /** Last `project.inspect` result, kept verbatim. `null` until loaded. */
  projectInspect: unknown;
  /** Selected media item from the project panel. `null` until picked. */
  selectedMedia:
    | { name: string; url: string }
    | null;

  // ----- ui slice (M3.2) -----
  /**
   * Top-level UI state for the cloud app shell. Independent of the
   * engine session: it survives project switches and reloads.
   *
   *   - `activeMode` — which of the Import / Edit / Export shells is
   *     currently shown. The dock is mounted only when the mode is
   *     "edit"; the other two are full-screen overlays (M3.9, M3.10).
   *   - `quickExportOpen` — M3.10 popup anchored to the Header.
   */
  ui: {
    activeMode: "import" | "edit" | "export";
    quickExportOpen: boolean;
    /**
     * M3.11: `shortcutsOpen` controls the Header's "Window > Keyboard
     * Shortcuts" dialog. Lives in the UI slice because every Header /
     * dialog render goes through the singleton store.
     */
    shortcutsOpen: boolean;
    /**
     * Active timeline edit tool. Lives in the UI slice (M3.6) — the
     * engine has no `tool.*` command yet, so the toolbar is local UI
     * state that other panels (shortcut map, future overlay) can read.
     */
    activeTool: "selection" | "ripple" | "razor" | "hand";
  };

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
  /**
   * Ring buffer of the last 50 engine operations for the Event Log
   * panel (M3.8). Newest entry is at index 0. Each entry records the
   * command id, the wall-clock timestamp, the call duration, and
   * whether the call succeeded.
   */
  eventLog: EventLogEntry[];

  // ----- auth (M2.7b) -----
  /**
   * Current bearer-token slice, or `null` when the user isn't logged in.
   * `null` until `hydrateAuth()` runs on the client (see App.tsx), since
   * `localStorage` is only available in the browser. The HTTP and WS
   * transports re-read the token from storage on every call, so a
   * `logout()` outside React still takes effect for the next request.
   */
  auth: AuthState | null;
  /** Last login error message (rendered by `<LoginGate />`). `null` on success / before first attempt. */
  authError: string | null;

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
  runCommand: (command: string, params?: Record<string, unknown>) => Promise<EngineResult>;
  /** Force-refresh the recent list (e.g. after the user clears it). */
  reloadRecentCommands: () => void;
  /** Push a single entry onto the event-log ring (M3.8). */
  logEvent: (entry: EventLogEntry) => void;
  /** Drop every entry from the event log (M3.8). */
  clearEventLog: () => void;
  /** Load any persisted auth slice from localStorage into the store. Idempotent. */
  hydrateAuth: () => void;
  /**
   * Exchange username + password for a session token. On success the
   * store records the new auth slice and persists it to localStorage;
   * on failure `authError` is set and the promise rejects. Clears any
   * prior `authError` at the start of the call.
   */
  login: (username: string, password: string) => Promise<void>;
  /**
   * Revoke the current session (idempotent 204), then clear the in-memory
   * and persisted auth slice. Always resolves — a network failure is
   * reported through `authError` but the local state is still cleared so
   * the UI returns to the login gate.
   */
  logout: () => Promise<void>;

  // ----- ui slice actions (M3.2) -----
  /** Switch the top-level mode (Import / Edit / Export). */
  setMode: (mode: "import" | "edit" | "export") => void;
  /** Toggle the Header's Quick Export popup (M3.10). */
  setQuickExportOpen: (open: boolean) => void;
  /** Toggle the Header's Keyboard Shortcuts dialog (M3.11). */
  setShortcutsOpen: (open: boolean) => void;
  /** Pick a timeline edit tool (M3.6). */
  setActiveTool: (tool: "selection" | "ripple" | "razor" | "hand") => void;

  // ----- project slice actions (M3.3) -----
  /** Set / clear the currently selected media item from the project panel. */
  setSelectedMedia: (media: { name: string; url: string } | null) => void;
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
  // M3.8: event-log ring buffer. Empty until `runCommand` records.
  eventLog: [],
  // Auth is NOT eagerly hydrated here — the store is also constructed on
  // the server side (Vite SSR, unit tests in node) and on a fresh client
  // mount. The actual `getAuth()` call lives in `hydrateAuth()` which
  // `App.tsx` runs from a `useEffect` so localStorage is guaranteed to
  // be reachable. M2.7b keeps `auth: null` until then, so the gate
  // shows briefly on first paint and then snaps to the real state.
  auth: null,
  authError: null,
  // M3.2: ui slice. `activeMode` defaults to "edit" so the docked layout
  // is the first thing the user sees after auth. The other two are
  // full-screen overlays mounted in M3.9 / M3.10.
  ui: {
    activeMode: "edit" as const,
    quickExportOpen: false,
    shortcutsOpen: false,
    activeTool: "selection" as const,
  },
  // M3.3: timeline / project slices. Both `null` until the panels call
  // their respective engine commands.
  timeline: null,
  projectInspect: null,
  selectedMedia: null,

  setMode(mode) {
    set((s) => ({ ui: { ...s.ui, activeMode: mode } }));
  },

  setQuickExportOpen(open) {
    set((s) => ({ ui: { ...s.ui, quickExportOpen: open } }));
  },

  setShortcutsOpen(open) {
    set((s) => ({ ui: { ...s.ui, shortcutsOpen: open } }));
  },

  setActiveTool(tool) {
    set((s) => ({ ui: { ...s.ui, activeTool: tool } }));
  },

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
    // Pass a thunk so the WS re-derives `?token=…` on every (re)connect
    // attempt. After a `logout()` clears the slice the next reconnect
    // opens without the token and the server 401s the handshake, which
    // is the desired signal that the session is over.
    const next = new WsClient(() => wsUrl(projectId));
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
      // M3.3: keep populating the small timeline slice in addition to
      // the raw `sequenceInfo` so the dock's Timeline panel doesn't
      // have to re-parse the result itself.
      set({
        sequenceInfo: result,
        timeline: extractTimeline(result),
        lastOkAt: Date.now(),
        lastError: null,
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  /** Project slice (M3.3). */
  setSelectedMedia(media: { name: string; url: string } | null): void {
    set({ selectedMedia: media });
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

  async runCommand(command: string, params?: Record<string, unknown>): Promise<EngineResult> {
    // No-op when the WS isn't ready — the palette disables its buttons
    // while the connection is closed, but a programmatic caller might
    // still slip through. Guard at the boundary instead of trusting the UI.
    if (client === null) {
      const err = new Error("WebSocket not connected");
      const entry: EventLogEntry = {
        command,
        timestamp: Date.now(),
        durationMs: 0,
        ok: false,
        error: err.message,
      };
      set({
        lastError: err.message,
        eventLog: [entry, ...get().eventLog].slice(0, 50),
      });
      throw err;
    }
    if (typeof command !== "string" || command.length === 0) {
      const err = new Error("command id is empty");
      const entry: EventLogEntry = {
        command,
        timestamp: Date.now(),
        durationMs: 0,
        ok: false,
        error: err.message,
      };
      set({
        lastError: err.message,
        eventLog: [entry, ...get().eventLog].slice(0, 50),
      });
      throw err;
    }
    const t0 =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    try {
      const result = await client.call("engine.execute", {
        command,
        params: params ?? {},
      });
      pushRecent(command);
      const t1 =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      const entry: EventLogEntry = {
        command,
        timestamp: Date.now(),
        durationMs: Math.max(0, t1 - t0),
        ok: true,
      };
      set({
        recentCommands: loadRecent(),
        lastOkAt: Date.now(),
        lastError: null,
        eventLog: [entry, ...get().eventLog].slice(0, 50),
      });
      return result;
    } catch (e) {
      const t1 =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      const msg = e instanceof Error ? e.message : String(e);
      const entry: EventLogEntry = {
        command,
        timestamp: Date.now(),
        durationMs: Math.max(0, t1 - t0),
        ok: false,
        error: msg,
      };
      set({
        lastError: msg,
        eventLog: [entry, ...get().eventLog].slice(0, 50),
      });
      throw e;
    }
  },

  reloadRecentCommands(): void {
    set({ recentCommands: loadRecent() });
  },

  logEvent(entry) {
    set({
      eventLog: [entry, ...get().eventLog].slice(0, 50),
    });
  },

  clearEventLog() {
    set({ eventLog: [] });
  },

  hydrateAuth(): void {
    // Idempotent: App.tsx calls this from a `useEffect` and React
    // strict-mode double-invokes effects in dev. Re-reads the slice on
    // every call so a `setAuth()` from another tab is picked up the
    // next time the user navigates.
    set({ auth: getAuth() });
  },

  async login(username: string, password: string): Promise<void> {
    set({ authError: null });
    let resp: Response;
    try {
      resp = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ authError: `network error: ${msg}` });
      throw e instanceof Error ? e : new Error(msg);
    }
    let body: LoginResponse;
    try {
      body = (await resp.json()) as LoginResponse;
    } catch (e) {
      const msg = `login: bad response (status ${resp.status})`;
      set({ authError: msg });
      throw e instanceof Error ? e : new Error(msg);
    }
    if (!resp.ok || !body.ok || typeof body.token !== "string" || body.user === undefined) {
      const msg = body.error ?? `login failed (status ${resp.status})`;
      set({ authError: msg });
      throw new Error(msg);
    }
    const next: AuthState = { token: body.token, userId: body.user.id, role: body.user.role };
    setAuth(next);
    set({ auth: next, authError: null });
  },

  async logout(): Promise<void> {
    // The logout endpoint is idempotent (204 either way), and the local
    // slice must be cleared even when the request fails so the UI
    // returns to the gate. Capture any error first, then reset state
    // so the message survives the final `set` rather than being
    // overwritten by `authError: null`.
    const current = get().auth;
    let netError: string | null = null;
    if (current !== null) {
      try {
        await fetch("/api/v1/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${current.token}` },
        });
      } catch (e) {
        netError = e instanceof Error ? e.message : String(e);
      }
    }
    clearAuth();
    set({ auth: null, authError: netError });
  },
}));

/**
 * Narrow a raw `sequence.inspect` reply into the small shape the
 * cloud timeline panel cares about. The function is shared between
 * the store (M3.3 keeps the slice in sync) and the TimelinePanel
 * itself (when called outside React). Unknown structures yield an
 * empty timeline rather than throwing — the panel keeps its last
 * data and renders a placeholder row.
 */
function extractTimeline(
  result: unknown,
):
  | {
      duration: number;
      playhead: number;
      tracks: { id: string; kind: "video" | "audio" }[];
      clips: { id: string; track: string; in: number; out: number; label?: string }[];
    }
  | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const duration = readNum(r.duration) ?? readNum(r.length) ?? 0;
  const playhead = readNum(r.playhead) ?? readNum(r.cursor) ?? 0;
  const tracks: { id: string; kind: "video" | "audio" }[] = [];
  for (const key of ["tracks", "videoTracks", "audioTracks"]) {
    const list = r[key];
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (typeof t === "string") tracks.push({ id: t, kind: "video" });
      else if (t !== null && typeof t === "object") {
        const o = t as Record<string, unknown>;
        const id =
          typeof o.id === "string"
            ? o.id
            : typeof o.name === "string"
              ? o.name
              : null;
        if (id === null) continue;
        const kind: "video" | "audio" =
          o.kind === "audio" || o.type === "audio" ? "audio" : "video";
        tracks.push({ id, kind });
      }
    }
  }
  const clips: {
    id: string;
    track: string;
    in: number;
    out: number;
    label?: string;
  }[] = [];
  for (const key of ["clips", "items", "segments"]) {
    const list = r[key];
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (c === null || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const id =
        typeof o.id === "string"
          ? o.id
          : typeof o.uuid === "string"
            ? o.uuid
            : null;
      if (id === null) continue;
      const track =
        typeof o.track === "string"
          ? o.track
          : typeof o.trackId === "string"
            ? o.trackId
            : "V1";
      const inT = readNum(o.in) ?? readNum(o.start) ?? 0;
      const outT = readNum(o.out) ?? readNum(o.end) ?? inT;
      clips.push({
        id,
        track,
        in: inT,
        out: outT,
        label:
          typeof o.label === "string"
            ? o.label
            : typeof o.name === "string"
              ? o.name
              : undefined,
      });
    }
  }
  return { duration, playhead, tracks, clips };
}

function readNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

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