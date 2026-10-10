/**
 * Type definitions for the FilmCraft web UI (M1.7). These mirror the
 * shape of the JSON returned by the headless server's `/api/v1/...`
 * routes; keeping them in one place avoids drift between the two.
 */

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
