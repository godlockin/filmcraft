/**
 * EventLogPanel tests (M3.8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface MockState {
  eventLog: { command: string; timestamp: number; durationMs: number; ok: boolean }[];
  clearEventLog: () => void;
}

const mockState: MockState = {
  eventLog: [],
  clearEventLog: vi.fn(),
};

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: MockState) => unknown) =>
      typeof sel === "function" ? sel(mockState) : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import EventLogPanel from "./EventLogPanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function renderPanel(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<EventLogPanel />);
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
  mockState.eventLog = [];
  (mockState.clearEventLog as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<EventLogPanel />", () => {
  it("renders the empty-state when there are no events", () => {
    host = renderPanel();
    expect(host.container.textContent ?? "").toContain("No events yet");
  });

  it("renders one row per entry", () => {
    mockState.eventLog = [
      { command: "timeline.move", timestamp: Date.now(), durationMs: 12, ok: true },
      { command: "edit.undo", timestamp: Date.now() - 1000, durationMs: 5, ok: false },
    ];
    host = renderPanel();
    const rows = host.container.querySelectorAll(".event-log-row");
    expect(rows.length).toBe(2);
  });

  it("clicking Clear calls clearEventLog", () => {
    mockState.eventLog = [
      { command: "x", timestamp: Date.now(), durationMs: 0, ok: true },
    ];
    host = renderPanel();
    const btn = host.container.querySelector(
      '[data-automation-id="panel.eventLog.clear"]',
    ) as HTMLButtonElement;
    act(() => btn.click());
    expect(mockState.clearEventLog).toHaveBeenCalled();
  });
});