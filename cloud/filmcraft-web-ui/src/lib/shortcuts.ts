/**
 * Keyboard shortcut infrastructure (M3.11).
 *
 * Per the M3 plan, this is *infrastructure only* — it registers a
 * global `keydown` listener, captures the chord via `KeyboardEvent`,
 * looks up the matching engine command id (as reported by
 * `engine.commands`/`command.list`), and invokes the supplied
 * callback. Per-panel shortcut mapping is explicitly out of scope.
 *
 * The lookup table is built from `command.list`'s array of
 * `{"id","label","shortcut","shortcuts","defaultShortcut"}` entries.
 * We normalise the strings ("Cmd+Shift+S" / "Ctrl+Shift+S") into a
 * canonical `{ mods, key }` shape and match on equality. The first
 * match wins; the engine returns them in declaration order.
 */

import type { CommandInfo } from "../types";

/** A single shortcut binding in canonical form. */
export interface Shortcut {
  /** Modifier flags. Bitfield mirror of `KeyboardEvent` keys. */
  mods: {
    cmdOrCtrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  };
  /** Lower-cased character or named key (`"a"`, `"arrowleft"`, `"f5"`). */
  key: string;
}

/** Source of shortcut bindings — populated by `loadShortcuts`. */
export interface ShortcutMap {
  /** Map of canonical key string → engine command id. */
  entries: Map<string, string[]>;
  /** Reverse map: command id → list of binding strings (display form). */
  byCommand: Map<string, string[]>;
}

/**
 * Canonical key string for use as a Map key. Includes modifier bits so
 * `Cmd+S` and `S` don't collide.
 */
export function shortcutKey(s: Shortcut): string {
  const parts: string[] = [];
  if (s.mods.cmdOrCtrl) parts.push("Cmd");
  if (s.mods.shift) parts.push("Shift");
  if (s.mods.alt) parts.push("Alt");
  if (s.mods.meta) parts.push("Meta");
  parts.push(s.key);
  return parts.join("+");
}

/** A native `KeyboardEvent` → canonical `Shortcut`. */
export function eventToShortcut(e: KeyboardEvent): Shortcut {
  const cmdOrCtrl = e.ctrlKey;
  const meta = e.metaKey;
  let key = (e.key ?? "").toLowerCase();
  if (key === " ") key = "space";
  return {
    mods: { cmdOrCtrl, shift: e.shiftKey, alt: e.altKey, meta },
    key,
  };
}

/** A raw shortcut string ("Cmd+S", "Ctrl+Shift+S", "F5") → `Shortcut[]`. */
export function parseShortcut(spec: string): Shortcut[] {
  const raw = spec.trim();
  if (raw === "") return [];
  const parts = raw.split("+").map((p) => p.trim());
  const mods = {
    cmdOrCtrl: false,
    shift: false,
    alt: false,
    meta: false,
  };
  let key = "";
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "cmd" || l === "command" || l === "ctrl" || l === "control") {
      // Cmd/Ctrl are interchangeable: storing as `cmdOrCtrl` lets the
      // matcher accept either platform's modifier.
      mods.cmdOrCtrl = true;
    } else if (l === "shift") {
      mods.shift = true;
    } else if (l === "alt" || l === "option") {
      mods.alt = true;
    } else if (l === "meta" || l === "win" || l === "super") {
      mods.meta = true;
    } else if (key === "") {
      key = l.replace(/\s+/g, "");
    }
  }
  if (key === "") return [];
  return [{ mods, key }];
}

/**
 * Build a `ShortcutMap` from the `engine.commands` reply.
 *
 * The reply is an array of `CommandInfo`. Each entry may carry
 * `shortcut` (the primary binding string), `shortcuts` (a list — the
 * desktop also supports multiple bindings per command), and
 * `defaultShortcut`. We index all of them so lookup is O(1).
 */
export function buildShortcutMap(commands: CommandInfo[]): ShortcutMap {
  const entries = new Map<string, string[]>();
  const byCommand = new Map<string, string[]>();
  for (const c of commands) {
    const ids: string[] = [];
    const push = (raw: string | null | undefined): void => {
      if (typeof raw !== "string") return;
      for (const s of parseShortcut(raw)) {
        const k = shortcutKey(s);
        const list = entries.get(k) ?? [];
        if (!list.includes(c.id)) list.push(c.id);
        entries.set(k, list);
      }
      if (raw.trim() !== "") ids.push(raw);
    };
    push(c.shortcut ?? null);
    push(c.defaultShortcut ?? null);
    if (Array.isArray(c.shortcuts)) {
      for (const s of c.shortcuts) push(s);
    }
    if (ids.length > 0) byCommand.set(c.id, ids);
  }
  return { entries, byCommand };
}

/** Look up a `KeyboardEvent` against a built map. Returns the matched command ids, if any. */
export function matchShortcut(
  map: ShortcutMap,
  e: KeyboardEvent,
): string[] {
  // Ignore key events fired while the user is typing in an input/textarea
  // so the shortcut layer doesn't hijack text editing.
  const tgt = e.target as HTMLElement | null;
  if (tgt !== null) {
    const tag = tgt.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return [];
    if (tgt.isContentEditable === true) return [];
  }
  // Build the canonical key for the *event*. Because Cmd and Ctrl are
  // interchangeable in the registry but distinct on the wire, we try
  // both spellings and return whichever matches more commands.
  const ev = eventToShortcut(e);
  const candidates = [
    shortcutKey(ev),
    shortcutKey({ ...ev, mods: { ...ev.mods, cmdOrCtrl: ev.mods.cmdOrCtrl || ev.mods.meta, meta: false } }),
    shortcutKey({ ...ev, mods: { ...ev.mods, meta: ev.mods.meta || ev.mods.cmdOrCtrl, cmdOrCtrl: false } }),
  ];
  for (const k of candidates) {
    const ids = map.entries.get(k);
    if (ids !== undefined && ids.length > 0) return ids;
  }
  return [];
}

export interface RegisteredShortcut {
  /** Remove the listener. */
  dispose: () => void;
}

/**
 * Register a global `keydown` listener that matches against the given
 * map and invokes `onMatch` with the list of matching command ids.
 *
 * The map can be replaced later (e.g. once the engine returns the
 * complete `command.list`) by calling `dispose()` on the returned
 * handle and re-running.
 */
export function registerShortcuts(
  map: ShortcutMap,
  onMatch: (commandIds: string[], event: KeyboardEvent) => void,
): RegisteredShortcut {
  function handler(e: KeyboardEvent): void {
    const ids = matchShortcut(map, e);
    if (ids.length > 0) {
      e.preventDefault();
      onMatch(ids, e);
    }
  }
  document.addEventListener("keydown", handler);
  return {
    dispose(): void {
      document.removeEventListener("keydown", handler);
    },
  };
}
