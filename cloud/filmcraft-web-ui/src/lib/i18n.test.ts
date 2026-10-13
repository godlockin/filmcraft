/**
 * Round-trip tests for the M3.1 `t()` formatter.
 *
 * For now `t()` is the identity with placeholder substitution. The
 * contract we lock in here is what every component already depends
 * on:
 *
 *   - `t("Save")` returns "Save" unchanged.
 *   - `t("Saved %s", name)` interpolates positional args.
 *   - `t("Clips: %{count}", { count: 5 })` interpolates named args.
 *   - `%%` is a literal percent.
 *   - Unknown placeholders are passed through verbatim so a typo in
 *     a component doesn't take the page down (the M3 plan §
 *     Constraints §4 calls this out).
 */

import { describe, it, expect } from "vitest";
import { t } from "./i18n";

describe("t()", () => {
  it("returns the key when no args are given", () => {
    expect(t("Save")).toBe("Save");
  });

  it("interpolates a positional %s", () => {
    expect(t("Saved %s", "foo.fcproj")).toBe("Saved foo.fcproj");
  });

  it("interpolates two positional placeholders in order", () => {
    expect(t("%s: %d frames", "V1", 24)).toBe("V1: 24 frames");
  });

  it("interpolates named %{name} args from the first object", () => {
    expect(t("Project %{name} opened", { name: "demo" })).toBe(
      "Project demo opened",
    );
  });

  it("treats arrays as positional args, objects as named args", () => {
    expect(t("a %s c", ["b"])).toBe("a b c");
    expect(t("a %{x} c", { x: "b" })).toBe("a b c");
  });

  it("escapes %% as a literal percent", () => {
    expect(t("100%% complete")).toBe("100% complete");
  });

  it("leaves unknown placeholders intact", () => {
    // `TBD` typo shouldn't take the page down; backstop the message.
    expect(t("Clips: %TBD")).toBe("Clips: %TBD");
  });

  it("leaves missing named args intact", () => {
    expect(t("Clips: %{count}", {})).toBe("Clips: %{count}");
  });

  it("renders %d non-numeric values as 0", () => {
    expect(t("Frames: %d", "abc")).toBe("Frames: 0");
  });
});
