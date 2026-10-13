/**
 * Vitest unit tests for `auth.ts` (M2.7b).
 *
 * Covers the round-trip (set → get → clear), the corruption-recovery
 * contract (any malformed slice falls back to `null` so the UI prompts
 * for login), and the missing-storage path. The `getAuthToken` path
 * is the one the WS / HTTP transports use on every call, so its
 * behaviour is exercised both directly and through `getAuth`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_STORAGE_KEY, clearAuth, getAuth, getAuthToken, setAuth } from "./auth";

function setRaw(value: string): void {
  window.localStorage.setItem(AUTH_STORAGE_KEY, value);
}

function getRaw(): string | null {
  return window.localStorage.getItem(AUTH_STORAGE_KEY);
}

describe("auth", () => {
  beforeEach(() => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  });

  afterEach(() => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  });

  it("returns null when nothing has been written", () => {
    expect(getAuth()).toBeNull();
    expect(getAuthToken()).toBeNull();
  });

  it("round-trips a valid slice through getAuth / setAuth / clearAuth", () => {
    setAuth({ token: "abc-123", userId: "admin", role: "admin" });
    expect(getRaw()).not.toBeNull();
    expect(getAuth()).toEqual({ token: "abc-123", userId: "admin", role: "admin" });
    expect(getAuthToken()).toBe("abc-123");
    clearAuth();
    expect(getRaw()).toBeNull();
    expect(getAuth()).toBeNull();
    expect(getAuthToken()).toBeNull();
  });

  it("recovers from a corrupted storage value by returning null", () => {
    setRaw("not-json");
    expect(getAuth()).toBeNull();
    expect(getAuthToken()).toBeNull();

    setRaw(JSON.stringify({ not: "an auth slice" }));
    expect(getAuth()).toBeNull();

    setRaw(JSON.stringify("a string, not an object"));
    expect(getAuth()).toBeNull();
  });

  it("returns null when the slice is missing any required string field", () => {
    setRaw(JSON.stringify({ token: "x" }));
    expect(getAuth()).toBeNull();
    setRaw(JSON.stringify({ token: "x", userId: "admin" }));
    expect(getAuth()).toBeNull();
    setRaw(JSON.stringify({ token: "x", userId: "admin", role: 42 }));
    expect(getAuth()).toBeNull();
    setRaw(JSON.stringify({ token: "", userId: "admin", role: "admin" }));
    expect(getAuth()).toBeNull();
  });
});
