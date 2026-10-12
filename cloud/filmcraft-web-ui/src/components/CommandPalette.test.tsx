/**
 * Vitest unit tests for the `CommandPalette` component (M2.8).
 *
 * The palette is dumb (props in, callbacks out), so these tests are
 * straightforward: render with a fixture command list, fire a change
 * event on the input, assert the visible rows narrow. We also verify
 * the disabled state greys out the buttons, and that clicking a
 * visible row fires the `onRun` callback with the correct id.
 *
 * We deliberately avoid `@testing-library/react`: it isn't in the
 * project's devDependencies, and `react-dom/client.createRoot` plus
 * DOM-level queries are sufficient for this component. The existing
 * `ws.test.ts` follows the same approach via direct DOM access.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import CommandPalette from "./CommandPalette";
import type { CommandInfo } from "../types";

function cmds(): CommandInfo[] {
  return [
    { id: "file.open", label: "Open a project file" },
    { id: "file.save", label: "Save the current project" },
    { id: "sequence.inspect", label: "Read the active timeline" },
    { id: "prefs.set", label: "Set a preference" },
  ];
}

interface Harness {
  container: HTMLDivElement;
  root: Root;
  rerender: (props: { commands: CommandInfo[]; disabled: boolean; onRun: (id: string) => void }) => void;
  unmount: () => void;
}

function renderPalette(initial: {
  commands: CommandInfo[];
  disabled: boolean;
  onRun: (id: string) => void;
}): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<CommandPalette {...initial} />);
  });
  return {
    container,
    root,
    rerender: (next) => {
      act(() => {
        root.render(<CommandPalette {...next} />);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function queryInput(host: ParentNode): HTMLInputElement | null {
  return host.querySelector(".palette-input");
}

describe("CommandPalette", () => {
  let host: Harness | null = null;

  beforeEach(() => {
    host = null;
  });

  afterEach(() => {
    host?.unmount();
    host = null;
  });

  it("shows every command when the query is empty", () => {
    host = renderPalette({ commands: cmds(), disabled: false, onRun: () => {} });
    const labels = host.container.querySelectorAll(".palette-label");
    expect(labels).toHaveLength(4);
  });

  it("narrows the visible list as the editor types", () => {
    host = renderPalette({ commands: cmds(), disabled: false, onRun: () => {} });
    const input = queryInput(host.container);
    expect(input).not.toBeNull();
    act(() => {
      const evt = new Event("change", { bubbles: true });
      Object.defineProperty(input, "value", { value: "file", configurable: true });
      input!.dispatchEvent(evt);
    });
    const items = host.container.querySelectorAll(".palette-list button");
    expect(items).toHaveLength(2);
    expect(items[0].textContent ?? "").toMatch(/file\.open/);
    expect(items[1].textContent ?? "").toMatch(/file\.save/);
  });

  it("shows a placeholder when nothing matches", () => {
    host = renderPalette({ commands: cmds(), disabled: false, onRun: () => {} });
    const input = queryInput(host.container)!;
    act(() => {
      const evt = new Event("change", { bubbles: true });
      Object.defineProperty(input, "value", { value: "no-such-thing", configurable: true });
      input.dispatchEvent(evt);
    });
    expect(host.container.querySelector(".palette-list")).toBeNull();
    expect(host.container.textContent ?? "").toMatch(/No command matches.*no-such-thing/);
  });

  it("shows a hint when the command list is empty", () => {
    host = renderPalette({ commands: [], disabled: false, onRun: () => {} });
    expect(host.container.textContent ?? "").toMatch(/No commands yet/);
  });

  it("invokes onRun with the chosen id", () => {
    const onRun = vi.fn();
    host = renderPalette({ commands: cmds(), disabled: false, onRun });
    const buttons = host.container.querySelectorAll(".palette-list button");
    act(() => {
      (buttons[0] as HTMLButtonElement).click();
    });
    expect(onRun).toHaveBeenCalledWith("file.open");
  });

  it("greys out the input and buttons when disabled", () => {
    host = renderPalette({ commands: cmds(), disabled: true, onRun: () => {} });
    const input = queryInput(host.container);
    expect(input?.disabled).toBe(true);
    const buttons = host.container.querySelectorAll(".palette-list button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of Array.from(buttons)) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
