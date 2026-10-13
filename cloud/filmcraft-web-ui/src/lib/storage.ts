/**
 * SSR / unit-test friendly `localStorage` accessor.
 *
 * Returns `null` when `window.localStorage` isn't there (Node, a
 * `typeof window === "undefined"` env, or a browser that throws on
 * access like Safari private mode / denied cookies). Every lib
 * helper that touches persistence funnels through this so callers
 * don't have to repeat the guard.
 */
export function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
