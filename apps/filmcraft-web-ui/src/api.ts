/**
 * Thin fetch / XHR wrapper for the FilmCraft headless server (M1.7).
 *
 * The browser app talks directly to `filmcraft-server` on the same origin
 * in production, and through Vite's `/api/*` proxy in dev. Either way,
 * every request hits `prefix + path`.
 *
 * Uploads use `XMLHttpRequest` rather than `fetch` so we can stream the
 * body and report progress with `xhr.upload.onprogress`.
 */

import type {
  CreateProjectBody,
  CreateProjectResponse,
  ExportInfoResponse,
  ListMediaResponse,
  ListProjectsResponse,
} from "./types";

const prefix = "/api/v1";

async function jsonRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const resp = await fetch(`${prefix}${path}`, { method, headers, body: payload });
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
