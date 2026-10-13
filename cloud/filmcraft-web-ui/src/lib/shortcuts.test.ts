/**
 * `lib/shortcuts.ts` tests (M3.11).
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildShortcutMap,
  eventToShortcut,
  matchShortcut,
  parseShortcut,
  registerShortcuts,
  shortcutKey,
} from "./shortcuts";
import type { CommandInfo } from "../types";

function mkCommand(id: string, overrides: Partial<CommandInfo> = {}): CommandInfo {
  return { id, label: id, ...overrides };
}

describe("parseShortcut", () => {
  it("decodes Cmd+S", () => {
    expect(parseShortcut("Cmd+S")).toEqual([
      { mods: { cmdOrCtrl: true, shift: false, alt: false, meta: false }, key: "s" },
    ]);
  });

  it("decodes Ctrl+Shift+S", () => {
    expect(parseShortcut("Ctrl+Shift+S")).toEqual([
      { mods: { cmdOrCtrl: true, shift: true, alt: false, meta: false }, key: "s" },
    ]);
  });

  it("decodes Cmd+Option+ArrowLeft", () => {
    expect(parseShortcut("Cmd+Option+ArrowLeft")).toEqual([
      { mods: { cmdOrCtrl: true, shift: false, alt: true, meta: false }, key: "arrowleft" },
    ]);
  });

  it("returns [] for empty / invalid", () => {
    expect(parseShortcut("")).toEqual([]);
    expect(parseShortcut("Cmd+")).toEqual([]);
  });
});

describe("shortcutKey", () => {
  it("orders modifiers canonically", () => {
    expect(
      shortcutKey({
        mods: { cmdOrCtrl: true, shift: true, alt: true, meta: false },
        key: "s",
      }),
    ).toBe("Cmd+Shift+Alt+s");
  });

  it("emits just the key when no mods", () => {
    expect(
      shortcutKey({ mods: { cmdOrCtrl: false, shift: false, alt: false, meta: false }, key: "f5" }),
    ).toBe("f5");
  });
});

describe("eventToShortcut", () => {
  it("lowercases the key", () => {
    const e = new KeyboardEvent("keydown", { key: "S" });
    expect(eventToShortcut(e).key).toBe("s");
  });

  it("maps Space to space", () => {
    const e = new KeyboardEvent("keydown", { key: " " });
    expect(eventToShortcut(e).key).toBe("space");
  });

  it("captures ctrl as cmdOrCtrl (meta gets its own slot)", () => {
    const ctrlOnly = new KeyboardEvent("keydown", { key: "s", ctrlKey: true });
    expect(eventToShortcut(ctrlOnly).mods.cmdOrCtrl).toBe(true);
    expect(eventToShortcut(ctrlOnly).mods.meta).toBe(false);

    const metaOnly = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    expect(eventToShortcut(metaOnly).mods.meta).toBe(true);
    expect(eventToShortcut(metaOnly).mods.cmdOrCtrl).toBe(false);
  });
});

describe("buildShortcutMap + matchShortcut", () => {
  const cmds: CommandInfo[] = [
    mkCommand("file.save", { shortcut: "Cmd+S" }),
    mkCommand("file.saveAs", { shortcut: "Cmd+Shift+S" }),
    mkCommand("edit.undo", { shortcut: "Cmd+Z" }),
    mkCommand("playback.play", { shortcut: "Space" }),
    mkCommand("noop", {}),
  ];

  it("indexes every binding", () => {
    const map = buildShortcutMap(cmds);
    expect(map.entries.get("Cmd+s")).toEqual(["file.save"]);
    expect(map.entries.get("Cmd+Shift+s")).toEqual(["file.saveAs"]);
    expect(map.entries.get("Cmd+z")).toEqual(["edit.undo"]);
    expect(map.entries.get("space")).toEqual(["playback.play"]);
  });

  it("returns the binding string for a command", () => {
    const map = buildShortcutMap(cmds);
    expect(map.byCommand.get("file.save")).toEqual(["Cmd+S"]);
  });

  it("matches a synthetic Cmd+S event to file.save", () => {
    const map = buildShortcutMap(cmds);
    const ev = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    expect(matchShortcut(map, ev)).toEqual(["file.save"]);
  });

  it("matches Ctrl+S as well (Cmd/Ctrl are interchangeable)", () => {
    const map = buildShortcutMap(cmds);
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true });
    expect(matchShortcut(map, ev)).toEqual(["file.save"]);
  });

  it("does not match when target is an input", () => {
    const map = buildShortcutMap(cmds);
    const target = document.createElement("input");
    document.body.appendChild(target);
    const ev = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true });
    target.dispatchEvent(ev);
    // listener used directly; the event target is the input → should not match.
    // We can't reach the target through eventToShortcut's `target` lookup
    // because we're calling matchShortcut directly, not via a listener.
    document.body.removeChild(target);
    // Sanity: the lookup path does honour tgt.tagName.
    const ev2 = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    Object.defineProperty(ev2, "target", { value: target });
    expect(matchShortcut(map, ev2)).toEqual([]);
  });
});

describe("registerShortcuts", () => {
  it("invokes onMatch when a binding matches", () => {
    const map = buildShortcutMap([mkCommand("file.save", { shortcut: "Cmd+S" })]);
    const onMatch = vi.fn();
    const reg = registerShortcuts(map, onMatch);
    const ev = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    Object.defineProperty(ev, "target", { value: document.body });
    document.dispatchEvent(ev);
    expect(onMatch).toHaveBeenCalledWith(["file.save"], ev);
    reg.dispose();
  });

  it("dispose() removes the listener", () => {
    const map = buildShortcutMap([mkCommand("file.save", { shortcut: "Cmd+S" })]);
    const onMatch = vi.fn();
    const reg = registerShortcuts(map, onMatch);
    reg.dispose();
    const ev = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    Object.defineProperty(ev, "target", { value: document.body });
    document.dispatchEvent(ev);
    expect(onMatch).not.toHaveBeenCalled();
  });
});
