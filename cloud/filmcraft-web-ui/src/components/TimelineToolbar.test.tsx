/**
 * TimelineToolbar tests (M3.6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  activeTool: "selection" as "selection" | "ripple" | "razor" | "hand",
  setActiveTool: vi.fn(),
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            ui: {
              activeMode: "edit",
              quickExportOpen: false,
              activeTool: mocks.activeTool,
            },
            setActiveTool: mocks.setActiveTool,
            runCommand: () => Promise.resolve(null),
            activeProject: "demo",
            connectionState: "open",
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

import TimelineToolbar from "./TimelineToolbar";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function renderToolbar(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TimelineToolbar />);
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
  mocks.activeTool = "selection";
  mocks.setActiveTool.mockReset();
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<TimelineToolbar />", () => {
  it("renders four tool buttons (V / B / C / H)", () => {
    host = renderToolbar();
    for (const id of ["selection", "ripple", "razor", "hand"]) {
      expect(
        host.container.querySelector(
          `[data-automation-id="timeline.tool.${id}"]`,
        ),
      ).not.toBeNull();
    }
  });

  it("calls setActiveTool with the new tool on click", () => {
    host = renderToolbar();
    const razor = host.container.querySelector(
      '[data-automation-id="timeline.tool.razor"]',
    ) as HTMLButtonElement;
    act(() => razor.click());
    expect(mocks.setActiveTool).toHaveBeenCalledWith("razor");
  });
});