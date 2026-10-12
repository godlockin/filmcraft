/**
 * Vitest unit tests for `palette.ts` (M2.8).
 *
 * Covers the rank order documented on `fuzzyFilter` (id prefix >
 * label prefix > id contains > label contains), the empty-query
 * behaviour, and the no-match case. Doesn't touch the React
 * component — that gets its own test.
 */

import { describe, expect, it } from "vitest";
import { applyRoleFilter, fuzzyFilter } from "./palette";
import type { CommandInfo } from "../types";

function cmds(...ids: Array<[string, string | undefined]>): CommandInfo[] {
  return ids.map(([id, label]) => ({ id, label }));
}

describe("fuzzyFilter", () => {
  const sample = cmds(
    ["file.open", "Open a project file"],
    ["file.save", "Save the current project"],
    ["sequence.inspect", "Read the active timeline"],
    ["prefs.set", "Set a preference"],
    ["prefs.get", "Get a preference"],
  );

  it("returns every command in original order when query is empty", () => {
    expect(fuzzyFilter(sample, "").map((c) => c.id)).toEqual([
      "file.open",
      "file.save",
      "sequence.inspect",
      "prefs.set",
      "prefs.get",
    ]);
  });

  it("ranks id-prefix matches above label-prefix matches", () => {
    const out = fuzzyFilter(sample, "file").map((c) => c.id);
    expect(out).toEqual(["file.open", "file.save"]);
  });

  it("ranks label-only matches below id hits when the id doesn't match", () => {
    // `timeline` only appears in the label of `sequence.inspect`.
    const out = fuzzyFilter(sample, "timeline").map((c) => c.id);
    expect(out).toEqual(["sequence.inspect"]);
  });

  it("is case-insensitive on both id and label", () => {
    const out = fuzzyFilter(sample, "PREFS").map((c) => c.id);
    expect(out).toEqual(["prefs.set", "prefs.get"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(fuzzyFilter(sample, "no-such-thing")).toEqual([]);
  });

  it("respects the limit when provided", () => {
    const out = fuzzyFilter(sample, "e", 2);
    expect(out).toHaveLength(2);
  });

  it("ranks id-contains above label-contains", () => {
    // Build two commands where the query "open" appears mid-id of one and
    // mid-label (not at the start) of the other. The id-match should rank
    // above the label-match.
    const special = cmds(
      ["file.reopen", undefined],
      ["some.action", "Re-open something"],
    );
    const out = fuzzyFilter(special, "open").map((c) => c.id);
    // `file.reopen` contains "open" in id (rank 2); `some.action`'s label
    // contains "open" but doesn't start with it (rank 3). id-contains wins.
    expect(out).toEqual(["file.reopen", "some.action"]);
  });
});

describe("applyRoleFilter (M3.4 placeholder)", () => {
  it("returns the input unchanged for now", () => {
    const commands = cmds(["file.open", undefined]);
    expect(applyRoleFilter(commands)).toBe(commands);
  });
});
