/**
 * StatusBar tests (M3.8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  activeProject: "demo" as string | null,
  connectionState: "open" as "open" | "closed" | "connecting" | "idle" | "fatal",
  lastError: null as string | null,
  timeline: null as { duration: number; playhead: number; tracks: unknown[]; clips: unknown[] } | null,
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            activeProject: mocks.activeProject,
            connectionState: mocks.connectionState,
            lastError: mocks.lastError,
            timeline: mocks.timeline,
            runCommand: mocks.runCommand,
            ui: {
              activeMode: "edit",
              quickExportOpen: false,
              activeTool: "selection",
            },
            setSelectedMedia: () => undefined,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import StatusBar from "./StatusBar";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderBar(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StatusBar />);
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
  mocks.connectionState = "open";
  mocks.lastError = null;
  mocks.timeline = null;
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<StatusBar />", () => {
  it("renders the project id", async () => {
    host = await renderBar();
    expect(host.container.textContent ?? "").toContain("demo");
  });

  it("shows the render-state pill when state.inspect returns rendering", async () => {
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string) => {
        if (cmd === "state.inspect") return { rendering: true, job: "shadow" };
        if (cmd === "perf.stats") return { memoryMb: 120, cpuPct: 30 };
        return null;
      },
    );
    host = await renderBar();
    expect(host.container.textContent ?? "").toContain("Rendering");
    expect(host.container.textContent ?? "").toContain("120 MB");
  });

  it("renders an error pill when lastError is set", async () => {
    mocks.lastError = "connection lost";
    host = await renderBar();
    expect(host.container.textContent ?? "").toContain("connection lost");
  });
});