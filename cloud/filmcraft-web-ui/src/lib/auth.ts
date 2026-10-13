/**
 * Persisted auth state (M2.7b).
 *
 * The server's HTTP and WS layers both require a bearer token
 * (`Authorization: Bearer <token>` for HTTP, `?token=<token>` for the
 * WS upgrade). The SPA gets that token from `POST /api/v1/auth/login`
 * and stores it in `localStorage` so a reload — or a new tab — keeps
 * the session alive without re-prompting.
 *
 * Single slice, key `filmcraft.auth`, value
 * `{ token, userId, role }`. `role` is informational only for M2.6
 * (single-role admin) but stored so a future "Signed in as …" badge
 * doesn't need a separate `/auth/me` round-trip.
 *
 * SSR / unit-test friendly: every access goes through a `safeStorage`
 * helper, which returns `null` when `localStorage` isn't there.
 */

import { safeStorage } from "./storage";

/** localStorage key. Exported for tests so they don't have to keep the literal in sync. */
export const AUTH_STORAGE_KEY = "filmcraft.auth";

export interface AuthState {
  token: string;
  userId: string;
  role: string;
}

/**
 * Return just the bearer token, or `null` when no valid auth slice is
 * stored. Cheap path used on every HTTP / WS call.
 */
export function getAuthToken(): string | null {
  const state = getAuth();
  return state?.token ?? null;
}

/**
 * Return the full `{ token, userId, role }` slice, or `null` when
 * nothing is stored / the stored value is corrupt. The recovery
 * contract: any parse / shape failure → `null` (so the UI prompts for
 * login instead of crashing on a malformed slice).
 */
export function getAuth(): AuthState | null {
  const store = safeStorage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const j = parsed as Partial<AuthState>;
  if (typeof j.token !== "string" || j.token.length === 0) return null;
  if (typeof j.userId !== "string") return null;
  if (typeof j.role !== "string") return null;
  return { token: j.token, userId: j.userId, role: j.role };
}

/**
 * Persist a fresh auth slice. Silently no-ops when storage is
 * unavailable — the in-memory store still works for the current
 * session, and the next page load will prompt for login again.
 */
export function setAuth(state: AuthState): void {
  const store = safeStorage();
  if (store === null) return;
  try {
    store.setItem(AUTH_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / denied — same as history.ts: ignore */
  }
}

/** Remove the persisted slice. Safe to call when nothing is stored. */
export function clearAuth(): void {
  const store = safeStorage();
  if (store === null) return;
  try {
    store.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* same as above */
  }
}
