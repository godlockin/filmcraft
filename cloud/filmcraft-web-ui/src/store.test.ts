/**
 * Vitest unit tests for the auth slice of `useEngineStore` (M2.7b).
 *
 * The M2.2 / M2.8 engine surface is already covered indirectly through
 * the component tests (`CommandPalette.test.tsx`, the WS path) and the
 * unit tests for the lib helpers it uses. This file focuses on the
 * three new actions — `hydrateAuth`, `login`, `logout` — and how they
 * move the `auth` / `authError` state in the store.
 *
 * `fetch` is stubbed; the store's network code is exercised through
 * the public action surface so we don't have to re-implement the
 * request shape here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEngineStore } from "./store";
import { AUTH_STORAGE_KEY, clearAuth, getAuth } from "./lib/auth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useEngineStore auth slice (M2.7b)", () => {
  beforeEach(() => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    useEngineStore.setState({ auth: null, authError: null });
  });

  afterEach(() => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts with auth === null and an empty persisted slice", () => {
    expect(useEngineStore.getState().auth).toBeNull();
    expect(getAuth()).toBeNull();
  });

  it("hydrateAuth reads the persisted slice into the store", () => {
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ token: "tok-1", userId: "admin", role: "admin" }),
    );
    useEngineStore.getState().hydrateAuth();
    expect(useEngineStore.getState().auth).toEqual({
      token: "tok-1",
      userId: "admin",
      role: "admin",
    });
  });

  it("hydrateAuth recovers from a corrupted slice by leaving auth === null", () => {
    window.localStorage.setItem(AUTH_STORAGE_KEY, "not-json");
    useEngineStore.getState().hydrateAuth();
    expect(useEngineStore.getState().auth).toBeNull();
  });

  it("login: on success, sets the auth slice in the store and persists it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          token: "new-tok",
          user: { id: "admin", role: "admin" },
        }),
      ),
    );
    await useEngineStore.getState().login("admin", "123456");
    const state = useEngineStore.getState();
    expect(state.auth).toEqual({ token: "new-tok", userId: "admin", role: "admin" });
    expect(state.authError).toBeNull();
    // Persisted slice matches the in-memory one.
    expect(getAuth()).toEqual({ token: "new-tok", userId: "admin", role: "admin" });
  });

  it("login: on bad credentials, sets authError and rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ok: false, error: "invalid username or password" }, 401),
      ),
    );
    await expect(useEngineStore.getState().login("admin", "wrong")).rejects.toThrow(
      /invalid username or password/,
    );
    const state = useEngineStore.getState();
    expect(state.auth).toBeNull();
    expect(state.authError).toMatch(/invalid username or password/);
  });

  it("logout: revokes the token, clears the store, and clears localStorage", async () => {
    // Seed an auth slice so logout has something to revoke.
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ token: "tok-1", userId: "admin", role: "admin" }),
    );
    useEngineStore.getState().hydrateAuth();
    expect(useEngineStore.getState().auth).not.toBeNull();

    const logoutFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", logoutFetch);

    await useEngineStore.getState().logout();
    const state = useEngineStore.getState();
    expect(state.auth).toBeNull();
    expect(state.authError).toBeNull();
    expect(getAuth()).toBeNull();
    // The logout request must have carried the bearer token so the
    // server can revoke it. We don't assert on the URL — that is
    // covered by `api.test.ts`.
    expect(logoutFetch).toHaveBeenCalledTimes(1);
  });

  it("logout: a network failure still clears the local slice and surfaces the error", async () => {
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ token: "tok-1", userId: "admin", role: "admin" }),
    );
    useEngineStore.getState().hydrateAuth();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    // logout() always resolves — it must not leave the user stuck on
    // the gate with no way to clear state. The error is surfaced via
    // `authError` for the next render of <LoginGate /> to display.
    await useEngineStore.getState().logout();
    const state = useEngineStore.getState();
    expect(state.auth).toBeNull();
    expect(state.authError).toMatch(/network down/);
    expect(getAuth()).toBeNull();
  });

  it("clearAuth removes the persisted slice (re-export sanity check)", () => {
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ token: "x", userId: "admin", role: "admin" }),
    );
    expect(getAuth()).not.toBeNull();
    clearAuth();
    expect(getAuth()).toBeNull();
  });
});
