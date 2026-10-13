/**
 * TimelineAutomation tests (M3.6).
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

import TimelineAutomation from "./TimelineAutomation";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderAutomation(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TimelineAutomation />);
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
    async () => null,
  );
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<TimelineAutomation />", () => {
  it("renders the empty-state when no keyframes are present", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      selection: [],
      duration: 100,
      video: [],
      audio: [],
    });
    host = await renderAutomation();
    expect(host.container.textContent ?? "").toContain("No automation");
  });

  it("renders an SVG polyline for the selected clip's keyframes", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      selection: [7],
      duration: 100,
      video: [
        {
          id: "V1",
          items: [
            {
              clip: 7,
              effects: [
                {
                  effect: "opacity",
                  params: {
                    opacity: {
                      value: 0,
                      keyframes: [
                        { time: 0, value: -1 },
                        { time: 50, value: 1 },
                        { time: 100, value: 0 },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    host = await renderAutomation();
    const polyline = host.container.querySelector(".timeline-automation-line");
    expect(polyline).not.toBeNull();
    const points = polyline?.getAttribute("points") ?? "";
    expect(points.split(" ").length).toBeGreaterThanOrEqual(3);
  });
});