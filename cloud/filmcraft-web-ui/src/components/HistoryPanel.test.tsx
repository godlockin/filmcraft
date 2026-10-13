/**
 * HistoryPanel tests (M3.8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  activeProject: "demo",
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            activeProject: mocks.activeProject,
            connectionState: "open",
            ui: {
              activeMode: "edit",
              quickExportOpen: false,
              activeTool: "selection",
            },
            runCommand: mocks.runCommand,
            timeline: null,
            selectedMedia: null,
            projectInspect: null,
            lastError: null,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import HistoryPanel from "./HistoryPanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderPanel(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<HistoryPanel />);
    await Promise.resolve();
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
  (mocks.runCommand as Mock).mockImplementation(
    async (_cmd?: string, _params?: unknown) => null,
  );
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<HistoryPanel />", () => {
  it("disables Undo when the undo list is empty", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({ undo: [], redo: [] });
    host = await renderPanel();
    const undo = host.container.querySelector(
      '[data-automation-id="panel.history.undo"]',
    ) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    const redo = host.container.querySelector(
      '[data-automation-id="panel.history.redo"]',
    ) as HTMLButtonElement;
    expect(redo.disabled).toBe(true);
  });

  it("enables Undo when the undo list has entries", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      undo: ["Add Clip", "Trim"],
      redo: ["Apply LUT"],
    });
    host = await renderPanel();
    const undo = host.container.querySelector(
      '[data-automation-id="panel.history.undo"]',
    ) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    const undoItems = host.container.querySelectorAll(
      '[data-automation-id^="panel.history.undoList."]',
    );
    expect(undoItems.length).toBe(2);
  });

  it("clicking Undo dispatches edit.undo and refreshes", async () => {
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string) => {
        if (cmd === "history.list")
          return { undo: ["Add Clip"], redo: [] };
        return null;
      },
    );
    host = await renderPanel();
    const undo = host.container.querySelector(
      '[data-automation-id="panel.history.undo"]',
    ) as HTMLButtonElement;
    await act(async () => {
      undo.click();
    });
    const calls = (mocks.runCommand as Mock).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(calls).toContain("edit.undo");
  });
});