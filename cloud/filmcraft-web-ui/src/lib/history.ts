/**
 * Recent-commands history (M2.8).
 *
 * The Engine Console records which engine commands the editor ran,
 * newest first, capped at `MAX_RECENT` entries. Backed by
 * `localStorage` so a reload — even of the React tree, even of the
 * tab — keeps the list intact.
 *
 * SSR / unit-test friendly: every access goes through
 * `safeStorage()`, which returns `null` when `localStorage` isn't
 * there (Node, vitest's default environment is happy-dom so this
 * is rarely triggered, but the gate keeps callers honest).
 *
 * The storage shape is `string[]`: the command ids in MRU order.
 * Anything else would mean a schema migration; this module is
 * intentionally trivial to read at a glance.
 */

const STORAGE_KEY = "filmcraft.recentCommands";
export const MAX_RECENT = 16;

// Centralised in `lib/storage.ts` so `lib/auth.ts` shares the same
// guard. Re-imported here for proximity to its only consumer.
import { safeStorage } from "./storage";

/** Load the persisted recent-ids list. Returns `[]` on any error. */
export function loadRecent(): string[] {
  const store = safeStorage();
  if (store === null) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === "string" && v.length > 0) out.push(v);
    }
    return out.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/**
 * Push `id` onto the head of the recent list, deduping against any
 * earlier occurrence so the same id never appears twice, and
 * capping to `MAX_RECENT`. Silently no-ops when storage is unavailable.
 */
export function pushRecent(id: string): void {
  if (typeof id !== "string" || id.length === 0) return;
  const store = safeStorage();
  if (store === null) return;
  const cur = loadRecent();
  const filtered = cur.filter((existing) => existing !== id);
  filtered.unshift(id);
  const next = filtered.slice(0, MAX_RECENT);
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded, storage disabled, etc. — M2.8 acceptance doesn't
    // require us to surface a UI error; the in-memory store still
    // works for the current session.
  }
}

/** Clear the persisted list. */
export function clearRecent(): void {
  const store = safeStorage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    /* same as above */
  }
}
