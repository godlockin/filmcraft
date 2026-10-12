/**
 * Type definitions for the FilmCraft web UI (M2.2). The HTTP-side types
 * mirror M1.7's JSON; the engine-side types describe the shapes the
 * headless WebSocket bridge returns. Keeping them in one place avoids
 * drift between the two transports.
 *
 * Everything here is `unknown`-safe at the boundary: the WS bridge is
 * JSON, and command params/results are deliberately schemaless on the
 * server side (see `crates/engine/src/commands.rs`). The UI narrows
 * where it has to render.
 */

// ---------- HTTP (M1.7) ----------

export interface Project {
  /** Path-safe id used as the OSS key. */
  id: string;
  /** Display name. `null` when `meta.json` was missing or malformed. */
  name: string | null;
  /** ISO 8601 timestamp of the last edit, if recorded. */
  updatedAt: string | null;
  /** Bytes of `current.fcproj`, if it could be read. */
  size: number | null;
}

export interface ListProjectsResponse {
  ok: boolean;
  projects: Project[];
}

export interface CreateProjectBody {
  id: string;
  name?: string;
}

export interface CreateProjectResponse {
  ok: boolean;
  project: string;
}

/**
 * The media listing endpoint returns the raw `items` array of filenames;
 * each entry becomes a `MediaItem` once paired with its parent project
 * id. We compute a preview URL lazily via `streamUrl(projectId, name)`.
 */
export interface MediaItem {
  name: string;
  /** URL the browser can use in a `<video src>`. */
  url: string;
}

export interface ListMediaResponse {
  ok: boolean;
  project: string;
  items: string[];
}

export interface ExportInfoResponse {
  ok: boolean;
  project: string;
  download: {
    url: string;
    kind: string;
  };
  metadata: unknown;
}

// ---------- Engine WS (M2.2) ----------

/**
 * Connection states the WS client surfaces to the UI. The terminal
 * `fatal` state means the server sent a close after auto-load failed;
 * the only useful UX is to show the error and stop retrying.
 */
export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "fatal";

/**
 * A single reply from the WS bridge. Every reply has `id` (echo of the
 * request id, or `null` if the request omitted it), `ok`, and either
 * `result` or `error`. The auto-load failure is a special case: it
 * arrives as a reply with `id: null`, `ok: false`, `error: "project
 * load failed: ..."`, followed by a Close frame with code 1008 — we
 * surface that as the `fatal` connection state.
 */
export interface WsReply {
  id: number | null;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * `engine.commands` returns this shape: an array of `{id, label, ...}`
 * command descriptors. We only narrow the bits the UI needs.
 */
export interface CommandInfo {
  id: string;
  label?: string;
  menu?: string[];
  shortcut?: string | null;
}

export interface ListCommandsResult {
  commands: CommandInfo[];
}