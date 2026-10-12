/**
 * Vitest unit tests for `history.ts` (M2.8).
 *
 * Covers the persistence shape (MRU order, dedupe, max-16 cap),
 * the corruption-recovery (anything that isn't a string[] of
 * strings falls back to `[]`), and the empty-storage path
 * (`loadRecent` returns `[]`, `pushRecent` writes through).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RECENT, clearRecent, loadRecent, pushRecent } from "./history";

const KEY = "filmcraft.recentCommands";

function setRaw(value: string): void {
  window.localStorage.setItem(KEY, value);
}

function getRaw(): string | null {
  return window.localStorage.getItem(KEY);
}

describe("history", () => {
  beforeEach(() => {
    window.localStorage.removeItem(KEY);
  });

  afterEach(() => {
    window.localStorage.removeItem(KEY);
  });

  it("returns [] when nothing has been written", () => {
    expect(loadRecent()).toEqual([]);
  });

  it("persists and reloads ids in MRU order", () => {
    pushRecent("file.open");
    pushRecent("sequence.inspect");
    pushRecent("file.save");
    expect(loadRecent()).toEqual(["file.save", "sequence.inspect", "file.open"]);
  });

  it("dedupes by moving an already-present id to the head", () => {
    pushRecent("a");
    pushRecent("b");
    pushRecent("c");
    pushRecent("a");
    expect(loadRecent()).toEqual(["a", "c", "b"]);
  });

  it("caps the list at MAX_RECENT", () => {
    for (let i = 0; i < MAX_RECENT + 5; i++) {
      pushRecent(`cmd.${i}`);
    }
    const all = loadRecent();
    expect(all).toHaveLength(MAX_RECENT);
    // Most recent is the last one we pushed.
    expect(all[0]).toBe(`cmd.${MAX_RECENT + 4}`);
  });

  it("ignores empty / non-string ids", () => {
    pushRecent("");
    pushRecent("valid.one");
    expect(loadRecent()).toEqual(["valid.one"]);
  });

  it("recovers from a corrupted storage value by returning []", () => {
    setRaw("not-json");
    expect(loadRecent()).toEqual([]);
    setRaw(JSON.stringify({ not: "an array" }));
    expect(loadRecent()).toEqual([]);
    setRaw(JSON.stringify(["ok", 42, "also-ok", null]));
    expect(loadRecent()).toEqual(["ok", "also-ok"]);
  });

  it("clearRecent removes the storage entry", () => {
    pushRecent("file.open");
    expect(getRaw()).not.toBeNull();
    clearRecent();
    expect(getRaw()).toBeNull();
    expect(loadRecent()).toEqual([]);
  });
});
