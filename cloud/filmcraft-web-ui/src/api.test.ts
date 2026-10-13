/**
 * Vitest unit tests for the auth-aware paths in `api.ts` (M2.7b).
 *
 * The server's strict policy (M2.6 + M2.7) 401s every HTTP request
 * that lacks a valid `Authorization: Bearer <token>`. The two
 * affected call sites are `jsonRequest` (used by every typed helper)
 * and `fetchFcproj` (raw bytes — `fetch` direct). We stub `fetch`
 * and `XMLHttpRequest`, drive each call site, and assert the headers
 * the SPA actually sends.
 *
 * `uploadMedia` uses XHR; the same token-stamping logic runs there
 * but is exercised through `XMLHttpRequest.open` / `setRequestHeader`
 * — covered by inspecting the recorded headers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFcproj, listProjects, streamUrl, uploadMedia } from "./api";
import { clearAuth, setAuth } from "./lib/auth";

const TOKEN = "test-token-abc-123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api auth headers (M2.7b)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearAuth();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuth();
  });

  it("listProjects attaches Authorization when a token is set", async () => {
    setAuth({ token: TOKEN, userId: "admin", role: "admin" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, projects: [] }));
    await listProjects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("listProjects omits Authorization when no token is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, projects: [] }));
    await listProjects();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("fetchFcproj attaches Authorization when a token is set", async () => {
    setAuth({ token: TOKEN, userId: "admin", role: "admin" });
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "application/octet-stream" } }),
    );
    await fetchFcproj("demo");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("fetchFcproj omits Authorization when no token is set", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "application/octet-stream" } }),
    );
    await fetchFcproj("demo");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("uploadMedia stamps Authorization via XHR when a token is set", async () => {
    setAuth({ token: TOKEN, userId: "admin", role: "admin" });
    // The XHR stub records `open()` / `setRequestHeader()` calls so
    // we can assert against them. `api.ts`'s `uploadMedia` uses the
    // legacy `xhr.onload` property, so the mock has to fire that.
    const sent: { method: string; url: string; headers: Record<string, string> } = {
      method: "",
      url: "",
      headers: {},
    };
    class FakeXHR {
      upload = { onprogress: null as ((ev: ProgressEvent) => void) | null };
      status = 200;
      responseText = JSON.stringify({ ok: true });
      onload: (() => void) | null = null;
      open(method: string, url: string): void {
        sent.method = method;
        sent.url = url;
      }
      setRequestHeader(name: string, value: string): void {
        sent.headers[name] = value;
      }
      send(): void {
        // Fire onload on the next microtask so the upload's promise
        // resolves and the assertion can run synchronously.
        queueMicrotask(() => {
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    // `File` is available in happy-dom; the body is irrelevant for the
    // header assertion.
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
    await uploadMedia("demo", file);
    expect(sent.method).toBe("POST");
    expect(sent.url).toMatch(/\/api\/v1\/projects\/demo\/media$/);
    expect(sent.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});

/**
 * M2.7c: `<video src>` can't stamp an `Authorization` header, so the
 * browser hits the media-stream URL with the bearer token in the
 * `?token=` query param. `streamUrl()` mirrors `wsUrl()`'s pattern
 * (M2.7) line-for-line — when a token is in localStorage it appends
 * `?token=<encoded>`, otherwise it returns the bare URL. Mirrors the
 * `wsUrl` tests in `ws.test.ts:272-292`.
 */
describe("streamUrl auth (M2.7c)", () => {
  beforeEach(() => {
    clearAuth();
  });

  afterEach(() => {
    clearAuth();
  });

  it("returns the bare URL with no query string when no token is set", () => {
    expect(streamUrl("demo", "clip.mp4")).toBe("/api/v1/projects/demo/media/clip.mp4");
  });

  it("appends ?token=<token> when a token is in localStorage", () => {
    setAuth({ token: "tok-1", userId: "admin", role: "admin" });
    expect(streamUrl("demo", "clip.mp4")).toBe("/api/v1/projects/demo/media/clip.mp4?token=tok-1");
  });

  it("URL-encodes a project id that contains special characters", () => {
    expect(streamUrl("a/b c", "clip.mp4")).toBe("/api/v1/projects/a%2Fb%20c/media/clip.mp4");
  });

  it("URL-encodes a filename that contains special characters", () => {
    expect(streamUrl("demo", "a/b c.mp4")).toBe("/api/v1/projects/demo/media/a%2Fb%20c.mp4");
  });

  it("URL-encodes a token that contains special characters", () => {
    setAuth({ token: "a/b c", userId: "admin", role: "admin" });
    expect(streamUrl("demo", "clip.mp4")).toBe("/api/v1/projects/demo/media/clip.mp4?token=a%2Fb%20c");
  });
});
