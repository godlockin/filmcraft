/**
 * ShortcutsDialog tests (M3.11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  commands: [
    { id: "file.save", label: "Save", shortcut: "Cmd+S" },
    { id: "edit.undo", label: "Undo", shortcut: "Cmd+Z" },
  ] as { id: string; label: string; shortcut: string }[] | null,
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            runCommand: mocks.runCommand,
            commands: mocks.commands,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import ShortcutsDialog from "./ShortcutsDialog";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderDialog(open: boolean, onClose = vi.fn()): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ShortcutsDialog open={open} onClose={onClose} />);
    await Promise.resolve();
  });
  return {
    container,
    root,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

let host: Harness | null = null;

beforeEach(() => {
  (mocks.runCommand as Mock).mockReset();
  (mocks.runCommand as Mock).mockImplementation(async () => null);
});

afterEach(() => {
  host?.unmount();
  host = null;
});

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("<ShortcutsDialog />", () => {
  it("renders nothing when closed", async () => {
    host = await renderDialog(false);
    expect(host.container.querySelector('[data-automation-id="panel.shortcuts"]')).toBeNull();
  });

  it("renders the table when open", async () => {
    host = await renderDialog(true);
    const dialog = host.container.querySelector('[data-automation-id="panel.shortcuts"]');
    expect(dialog).not.toBeNull();
    expect(host.container.querySelector('[data-automation-id="panel.shortcuts.row.file.save"]')).not.toBeNull();
    expect(host.container.querySelector('[data-automation-id="panel.shortcuts.row.edit.undo"]')).not.toBeNull();
  });

  it("filters the rows by the search input", async () => {
    host = await renderDialog(true);
    const input = host.container.querySelector(
      '[data-automation-id="panel.shortcuts.search"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, "save");
    });
    expect(
      host.container.querySelector('[data-automation-id="panel.shortcuts.row.file.save"]'),
    ).not.toBeNull();
    expect(
      host.container.querySelector('[data-automation-id="panel.shortcuts.row.edit.undo"]'),
    ).toBeNull();
  });

  it("invokes onClose when the Close button is clicked", async () => {
    const onClose = vi.fn();
    host = await renderDialog(true, onClose);
    const btn = host.container.querySelector(
      '[data-automation-id="panel.shortcuts.close"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("invokes onClose on Escape", async () => {
    const onClose = vi.fn();
    host = await renderDialog(true, onClose);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("fetches engine.commands when opened with no data", async () => {
    mocks.commands = null;
    (mocks.runCommand as Mock).mockImplementation(async (cmd?: string) => {
      if (cmd === "engine.commands") return { commands: [{ id: "file.save", label: "Save", shortcut: "Cmd+S" }] };
      return null;
    });
    host = await renderDialog(true);
    // Wait for the effect to run.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.runCommand).toHaveBeenCalledWith("engine.commands");
    mocks.commands = [
      { id: "file.save", label: "Save", shortcut: "Cmd+S" },
      { id: "edit.undo", label: "Undo", shortcut: "Cmd+Z" },
    ];
  });
});
