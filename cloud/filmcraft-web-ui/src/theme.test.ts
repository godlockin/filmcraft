/**
 * Verify the M3.1 token file mirrors `crates/ui-egui/src/theme.rs`.
 *
 * The expected token list lives in this file and matches the
 * `ThemeKind::Dark` arm of `Tokens::for_kind` in
 * `crates/ui-egui/src/theme.rs:104-148` plus the dimensions used by
 * the M3 panels. A diff in this file is intentional — the whole
 * point of the M3 plan is that `theme.css` and `theme.rs` stay in
 * lock-step.
 *
 * The CSS file is read with Node's `fs.readFileSync` via a
 * runtime-only `require` so the test stays compatible with both
 * vitest (Node) and the browser (where the file is imported as a
 * string at build time). The `require` is hidden behind a tiny
 * helper so TypeScript treats it as `unknown`.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
/* eslint-enable @typescript-eslint/no-require-imports */

import { describe, it, expect } from "vitest";

interface TokenExpectation {
  name: string;
  /** Hex value without leading `#`, e.g. `"1d1d1d"`. */
  hex: string;
}

const EXPECTED: TokenExpectation[] = [
  { name: "app-bg", hex: "000000" },
  { name: "header-bg", hex: "1d1d1d" },
  { name: "panel-bg", hex: "1d1d1d" },
  { name: "tab-bg", hex: "1d1d1d" },
  { name: "tab-text", hex: "b0b0b0" },
  { name: "tab-text-active", hex: "d1d1d1" },
  { name: "focus", hex: "5794ec" },
  { name: "accent", hex: "2f6bdf" },
  { name: "accent-hover", hex: "3f7ce8" },
  { name: "text", hex: "d1d1d1" },
  { name: "text-dim", hex: "b0b0b0" },
  { name: "text-faint", hex: "6e6e6e" },
  { name: "icon", hex: "b0b0b0" },
  { name: "icon-active", hex: "d1d1d1" },
  { name: "hover", hex: "2c2c2c" },
  { name: "pressed", hex: "4b4b4b" },
  { name: "field-bg", hex: "0e0e0e" },
  { name: "field-border", hex: "303030" },
  { name: "separator", hex: "303030" },
  { name: "row-alt", hex: "212121" },
  { name: "row-selected", hex: "333333" },
  { name: "hot-text", hex: "4096f3" },
  { name: "tl-bg", hex: "1d1d1d" },
  { name: "tl-track-bg", hex: "1d1d1d" },
  { name: "tl-track-bg-alt", hex: "1d1d1d" },
  { name: "tl-header-bg", hex: "1d1d1d" },
  { name: "tl-ruler-bg", hex: "1d1d1d" },
  { name: "tl-ruler-tick", hex: "8d8d8d" },
  { name: "tl-ruler-text", hex: "b0b0b0" },
  { name: "playhead", hex: "5895ec" },
  { name: "in-out-shade", hex: "3f3f3f" },
  { name: "clip-selected-border", hex: "ebebeb" },
  { name: "render-red", hex: "e34850" },
  { name: "render-yellow", hex: "f0f04f" },
  { name: "render-green", hex: "2d9d78" },
  { name: "monitor-bg", hex: "1d1d1d" },
  { name: "timecode", hex: "4096f3" },
  { name: "danger", hex: "dc513d" },
];

const DIMENSIONS: { name: string; value: string }[] = [
  { name: "radius-sm", value: "4px" },
  { name: "gap", value: "4px" },
  { name: "tab-h", value: "32px" },
  { name: "header-h", value: "38px" },
  { name: "status-h", value: "24px" },
  { name: "body-size", value: "12px" },
  { name: "small-size", value: "11px" },
  { name: "heading-size", value: "15px" },
];

function loadCss(): string {
  // `process.cwd()` inside `vitest run` is the package root, so we
  // resolve from there. The `theme.css` is colocated with this test.
  return fs.readFileSync(path.resolve(process.cwd(), "src/theme.css"), "utf-8");
}

describe("theme.css", () => {
  const css = loadCss();

  for (const t of EXPECTED) {
    it(`declares --${t.name} as #${t.hex}`, () => {
      const decl = new RegExp(`--${t.name}\\s*:\\s*#${t.hex}\\b`);
      expect(css).toMatch(decl);
    });
  }

  for (const d of DIMENSIONS) {
    it(`declares --${d.name} as ${d.value}`, () => {
      const decl = new RegExp(`--${d.name}\\s*:\\s*${d.value}\\b`);
      expect(css).toMatch(decl);
    });
  }

  it("uses dark-mode tokens only (no light rules)", () => {
    expect(css).not.toMatch(/#f5f6f8/i);
    expect(css).not.toMatch(/#2563eb/i);
  });
});
