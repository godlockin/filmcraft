/**
 * EssentialSoundPanel tests (M3.7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => []),
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

import EssentialSoundPanel from "./EssentialSoundPanel";

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
    root.render(<EssentialSoundPanel />);
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
    async (_cmd?: string, _params?: unknown) => [],
  );
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<EssentialSoundPanel />", () => {
  it("renders the empty-state when essentialSound.inspect returns []", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No audio clips");
  });

  it("renders rows with kind tag dropdowns", async () => {
    (mocks.runCommand as Mock).mockResolvedValue([
      { id: "1", name: "Voice", type: "dialogue" },
      { id: "2", name: "Music", type: "music" },
    ]);
    host = await renderPanel();
    const rows = host.container.querySelectorAll(".essential-sound-row");
    expect(rows.length).toBe(2);
    const selects = host.container.querySelectorAll(".essential-sound-tag");
    expect(selects.length).toBe(2);
  });

  it("Detect button calls essentialSound.autoMatch", async () => {
    host = await renderPanel();
    const btn = host.container.querySelector(
      '[data-automation-id="panel.essentialSound.detect"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn.click();
    });
    const calls = (mocks.runCommand as Mock).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(calls).toContain("essentialSound.autoMatch");
  });
});