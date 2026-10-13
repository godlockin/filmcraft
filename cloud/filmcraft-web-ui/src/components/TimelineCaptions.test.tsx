/**
 * TimelineCaptions tests (M3.6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  // Default returns an empty caption list. Tests reset as needed.
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
            ui: { activeMode: "edit", quickExportOpen: false },
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

import TimelineCaptions from "./TimelineCaptions";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderCaptions(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TimelineCaptions />);
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
    async (cmd?: string) => {
      if (cmd === "sequence.inspect") return { duration: 100 };
      return null;
    },
  );
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<TimelineCaptions />", () => {
  it("renders the empty-state when captions.list returns []", async () => {
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string) => {
        if (cmd === "captions.list") return [];
        if (cmd === "sequence.inspect") return { duration: 100 };
        return null;
      },
    );
    host = await renderCaptions();
    expect(host.container.textContent ?? "").toContain("No captions");
  });

  it("renders caption blocks returned by captions.list", async () => {
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string) => {
        if (cmd === "captions.list") {
          return [
            { id: "c1", start: 0, duration: 10, text: "Hi" },
            { id: "c2", start: 12, duration: 8, text: "World" },
          ];
        }
        if (cmd === "sequence.inspect") return { duration: 100 };
        return null;
      },
    );
    host = await renderCaptions();
    const blocks = host.container.querySelectorAll(".timeline-caption-block");
    expect(blocks.length).toBe(2);
  });
});