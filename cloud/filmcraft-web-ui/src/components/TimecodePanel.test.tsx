/**
 * TimecodePanel tests (M3.11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  timeline: null as { duration: number; playhead: number; tracks: unknown[]; clips: unknown[] } | null,
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            runCommand: mocks.runCommand,
            timeline: mocks.timeline,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import TimecodePanel from "./TimecodePanel";

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
    root.render(<TimecodePanel />);
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
  (mocks.runCommand as Mock).mockImplementation(async () => null);
  mocks.timeline = null;
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<TimecodePanel />", () => {
  it("renders the no-signal state when no reading is available", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No signal");
  });

  it("renders the formatted timecode when state.inspect returns data", async () => {
    (mocks.runCommand as Mock).mockImplementation(async (cmd?: string) => {
      if (cmd === "state.inspect") return { playhead: 254_016_000_000, fps: 30 };
      return null;
    });
    host = await renderPanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const primary = host.container.querySelector(
      '[data-automation-id="panel.timecode.primary"]',
    );
    expect(primary?.textContent ?? "").toMatch(/00:00:01:\d{2}/);
    expect(host.container.textContent ?? "").toContain("30 fps");
  });

  it("falls back to timeline state when state.inspect returns nothing useful", async () => {
    mocks.timeline = {
      duration: 1_000_000_000_000,
      playhead: 254_016_000_000, // 1 sec at 30 fps
      tracks: [{ id: "V1", kind: "video" }],
      clips: [],
    };
    host = await renderPanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.container.textContent ?? "").toContain("fps");
  });
});
