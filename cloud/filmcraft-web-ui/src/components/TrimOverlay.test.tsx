/**
 * TrimOverlay tests (M3.6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  activeTool: "selection" as "selection" | "ripple" | "razor" | "hand",
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
            runCommand: mocks.runCommand,
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

import TrimOverlay from "./TrimOverlay";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function renderOverlay(props: {
  clipId: string;
  inTicks: number;
  outTicks: number;
  duration: number;
  onClose: () => void;
}): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TrimOverlay
        clipId={props.clipId}
        inTicks={props.inTicks}
        outTicks={props.outTicks}
        duration={props.duration}
        onClose={props.onClose}
      />,
    );
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
  (mocks.runCommand as Mock).mockReset();
  (mocks.runCommand as Mock).mockImplementation(
    async (_cmd?: string, _params?: unknown) => null,
  );
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<TrimOverlay />", () => {
  it("renders the in / out number inputs", () => {
    host = renderOverlay({
      clipId: "42",
      inTicks: 0,
      outTicks: 100,
      duration: 200,
      onClose: () => undefined,
    });
    expect(
      host.container.querySelector(
        '[data-automation-id="panel.timeline.trim.in"]',
      ),
    ).not.toBeNull();
    expect(
      host.container.querySelector(
        '[data-automation-id="panel.timeline.trim.out"]',
      ),
    ).not.toBeNull();
  });

  it("dispatches timeline.trim with the in/out deltas on Apply", () => {
    const onClose = vi.fn();
    host = renderOverlay({
      clipId: "42",
      inTicks: 10,
      outTicks: 90,
      duration: 200,
      onClose,
    });
    const inInput = host.container.querySelector(
      '[data-automation-id="panel.timeline.trim.in"]',
    ) as HTMLInputElement;
    const outInput = host.container.querySelector(
      '[data-automation-id="panel.timeline.trim.out"]',
    ) as HTMLInputElement;
    act(() => {
      Object.defineProperty(inInput, "value", { value: "15", configurable: true });
      inInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      Object.defineProperty(outInput, "value", { value: "85", configurable: true });
      outInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const apply = host.container.querySelector(
      '[data-automation-id="panel.timeline.trim.commit"]',
    ) as HTMLButtonElement;
    act(() => apply.click());
    const calls = (mocks.runCommand as Mock).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(calls).toContain("timeline.trim");
    expect(onClose).toHaveBeenCalled();
  });

  it("uses mode 'ripple' when the active tool is Ripple Edit", () => {
    mocks.activeTool = "ripple";
    host = renderOverlay({
      clipId: "5",
      inTicks: 0,
      outTicks: 100,
      duration: 200,
      onClose: () => undefined,
    });
    const outInput = host.container.querySelector(
      '[data-automation-id="panel.timeline.trim.out"]',
    ) as HTMLInputElement;
    act(() => {
      Object.defineProperty(outInput, "value", { value: "110", configurable: true });
      outInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const apply = host.container.querySelector(
      '[data-automation-id="panel.timeline.trim.commit"]',
    ) as HTMLButtonElement;
    act(() => apply.click());
    const trim = (mocks.runCommand as Mock).mock.calls.find(
      (c: unknown[]) => c[0] === "timeline.trim",
    );
    expect(trim).toBeDefined();
    expect((trim?.[1] as Record<string, unknown>).mode).toBe("ripple");
    expect((trim?.[1] as Record<string, unknown>).edge).toBe("out");
  });
});