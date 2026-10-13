/**
 * TimelinePanel tests (M3.3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  // Default returns a resolved promise so nested child panels
  // (TimelineCaptions / TimelineAutomation) don't throw on their
  // mount-effect chains before individual tests reset the mock.
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  setConnState(v: "open" | "closed" | "connecting") {
    mocks.connState = v;
  },
  connState: "open" as "open" | "closed" | "connecting",
  activeProject: "demo",
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            activeProject: mocks.activeProject,
            connectionState: mocks.connState,
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

import TimelinePanel from "./TimelinePanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function renderTimeline(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TimelinePanel />);
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
  // Restore the no-op resolved-promise implementation that `mockReset`
  // just cleared, so child panels' mount effects don't crash before
  // individual tests reset the mock.
  (mocks.runCommand as Mock).mockImplementation(
    async (_cmd?: string, _params?: unknown) => null,
  );
  mocks.connState = "open";
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<TimelinePanel />", () => {
  it("calls sequence.inspect on mount", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      duration: 1000,
      playhead: 0,
      tracks: [{ id: "V1", kind: "video" }],
      clips: [],
    });
    host = renderTimeline();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.runCommand).toHaveBeenCalledWith("sequence.inspect");
  });

  it("renders clips at positions matching (in, out)", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      duration: 1000,
      playhead: 0,
      tracks: [{ id: "V1", kind: "video" }],
      clips: [
        { id: "c1", track: "V1", in: 100, out: 300, label: "intro" },
        { id: "c2", track: "V1", in: 500, out: 700, label: "main" },
      ],
    });
    host = renderTimeline();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const clips = host.container.querySelectorAll(".timeline-clip");
    expect(clips.length).toBe(2);
    const lefts = Array.from(clips).map((c) =>
      parseFloat((c as HTMLElement).style.left.replace("%", "")),
    );
    expect(lefts[0]!).toBeGreaterThan(0);
    expect(lefts[0]!).toBeLessThan(lefts[1]!);
  });

  it("clicking the timeline area fires timeline.move", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      duration: 100,
      playhead: 0,
      tracks: [{ id: "V1", kind: "video" }],
      clips: [],
    });
    host = renderTimeline();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const scroll = host.container.querySelector(".timeline-scroll") as HTMLElement;
    expect(scroll).not.toBeNull();
    await act(async () => {
      scroll.dispatchEvent(
        new MouseEvent("click", {
          clientX: 100,
          clientY: 20,
          bubbles: true,
        }),
      );
    });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "timeline.move",
      expect.any(Object),
    );
  });

  it("renders an empty timeline without crashing when the WS is closed", async () => {
    mocks.connState = "closed";
    host = renderTimeline();
    await act(async () => {
      await Promise.resolve();
    });
    const trackHeaders = host.container.querySelectorAll(".timeline-track-header");
    expect(trackHeaders.length).toBeGreaterThan(0);
  });
});
