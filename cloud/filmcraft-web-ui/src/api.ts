/**
 * Thin fetch / XHR wrapper for the FilmCraft headless server (M2.2).
 *
 * The browser app talks directly to `filmcraft-server` on the same origin
 * in production, and through Vite's `/api/*` proxy in dev. Either way,
 * every request hits `prefix + path`.
 *
 * Uploads use `XMLHttpRequest` rather than `fetch` so we can stream the
 * body and report progress with `xhr.upload.onprogress`.
 *
 * M2.2 addition: `fetchFcproj` reads the project's raw `.fcproj` bytes
 * via the new `/api/v1/projects/{id}/fcproj` endpoint (no
 * `Content-Disposition: attachment` so a future store can
 * `JSON.parse` the body).
 */

import type {
  CreateProjectBody,
  CreateProjectResponse,
  ExportInfoResponse,
  ListMediaResponse,
  ListProjectsResponse,
} from "./types";
import { getAuthToken } from "./lib/auth";

const prefix = "/api/v1";

/**
 * Build the headers for a request: `Authorization: Bearer <token>`
 * when a token is present in localStorage, otherwise an empty
 * object. Centralised so the HTTP / XHR / WS paths stay in lockstep —
 * if the server ever accepts a different scheme, this is the only
 * place that needs to change.
 */
function authHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  const token = getAuthToken();
  if (token !== null) {
    out["Authorization"] = `Bearer ${token}`;
  }
  return out;
}

async function jsonRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = authHeaders();
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const resp = await fetch(`${prefix}${path}`, {
    method,
    headers,
    body: payload,
  });
  if (!resp.ok) {
    throw await asApiError(resp, method, path);
  }
  // 204 has no body.
  if (resp.status === 204) {
    return undefined as unknown as T;
  }
  return (await resp.json()) as T;
}

async function asApiError(resp: Response, method: string, path: string): Promise<Error> {
  let detail = "";
  try {
    const data = (await resp.json()) as { error?: string };
    if (data?.error) detail = `: ${data.error}`;
  } catch {
    /* not JSON — ignore */
  }
  return new Error(`${method} ${path} -> ${resp.status}${detail}`);
}

export async function listProjects(): Promise<ListProjectsResponse> {
  return jsonRequest("GET", "/projects");
}

export async function createProject(body: CreateProjectBody): Promise<CreateProjectResponse> {
  return jsonRequest("POST", "/projects", body);
}

export async function deleteProject(projectId: string): Promise<void> {
  await jsonRequest<void>("DELETE", `/projects/${encodeURIComponent(projectId)}`);
}

export async function listMedia(projectId: string): Promise<ListMediaResponse> {
  return jsonRequest("GET", `/projects/${encodeURIComponent(projectId)}/media`);
}

/**
 * URL the browser passes into `<video src>`. We don't fetch — the browser
 * opens a single socket with `Range` semantics and seeks freely.
 */
export function streamUrl(projectId: string, filename: string): string {
  return `${prefix}/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(filename)}`;
}

/**
 * Upload a media file with progress reporting.
 *
 * `onProgress` receives a 0..1 number; pass `undefined` to skip the
 * progress update (the upload still completes). Returns the server's
 * `{ ok, ... }` JSON body on success.
 */
export function uploadMedia(
  projectId: string,
  file: File,
  onProgress?: (frac: number) => void,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${prefix}/projects/${encodeURIComponent(projectId)}/media`, true);
    xhr.setRequestHeader("X-Filename", file.name);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    // M2.7b: stamp the bearer token when present. XHR doesn't read from
    // `authHeaders()` directly because each header must be set via
    // `setRequestHeader`, but the lookup is the same.
    const token = getAuthToken();
    if (token !== null) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    xhr.upload.onprogress = (ev: ProgressEvent) => {
      if (onProgress && ev.lengthComputable) {
        onProgress(ev.loaded / ev.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as Record<string, unknown>);
        } catch {
          resolve({ ok: true });
        }
      } else {
        let detail = "";
        try {
          const data = JSON.parse(xhr.responseText) as { error?: string };
          if (data?.error) detail = `: ${data.error}`;
        } catch {
          /* not JSON — ignore */
        }
        reject(new Error(`upload -> ${xhr.status}${detail}`));
      }
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(file);
  });
}

export async function getExportInfo(projectId: string): Promise<ExportInfoResponse> {
  return jsonRequest("GET", `/projects/${encodeURIComponent(projectId)}/export`);
}

/**
 * Read the raw `.fcproj` bytes for a project via the M2.2 raw endpoint
 * (`GET /api/v1/projects/{id}/fcproj`). Returns the response body as a
 * `Uint8Array` and the server-reported content-type so callers can
 * distinguish a successful octet-stream response from a JSON error body.
 *
 * Distinguishes two failure modes so the UI can show a useful message:
 *   - 404: project has no saved `.fcproj` yet → `{ ok: false, status: 404, kind: "no-save" }`.
 *   - other HTTP error: `{ ok: false, status, kind: "http", error }`.
 *   - network failure: rejected with the underlying `Error`.
 */
export interface FetchFcprojResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
  /** Set when `ok === false`. */
  error?: string;
  /** Set when `ok === false && status === 404` — distinguishes "no save yet" from other failures. */
  kind?: "no-save" | "http";
}

export async function fetchFcproj(projectId: string): Promise<FetchFcprojResult> {
  const url = `${prefix}/projects/${encodeURIComponent(projectId)}/fcproj`;
  // M2.7b: the raw-bytes endpoint sits behind the auth layer just like
  // every other `/api/v1` route. `authHeaders({})` is the empty-extra
  // form — Content-Type isn't set because the body is bytes, not JSON.
  const resp = await fetch(url, { headers: authHeaders() });
  const contentType = resp.headers.get("content-type");
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (resp.ok) {
    return { ok: true, status: resp.status, contentType, bytes: buf };
  }
  if (resp.status === 404) {
    return {
      ok: false,
      status: 404,
      contentType,
      bytes: buf,
      kind: "no-save",
      error: "project has no saved fcproj yet",
    };
  }
  let detail = "";
  try {
    const data = JSON.parse(new TextDecoder().decode(buf)) as { error?: string };
    if (data?.error) detail = `: ${data.error}`;
  } catch {
    /* body wasn't JSON — keep the status-only detail */
  }
  return {
    ok: false,
    status: resp.status,
    contentType,
    bytes: buf,
    kind: "http",
    error: `${resp.status}${detail}`,
  };
}
