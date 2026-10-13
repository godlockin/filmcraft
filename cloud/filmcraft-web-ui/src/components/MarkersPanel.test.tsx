/**
 * MarkersPanel tests (M3.4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  // Default to a resolved promise so the panel's mount effect chain
  // doesn't throw before individual tests reset the mock.
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

import MarkersPanel from "./MarkersPanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderPanel(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // MarkersPanel fires `markers.list` on mount; async `act` lets
  // React 18 drain the resulting promise chain before we exit.
  await act(async () => {
    root.render(<MarkersPanel />);
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
  // Restore the default resolved-promise implementation that
  // `mockReset` just cleared.
  (mocks.runCommand as Mock).mockImplementation(
    async (_cmd?: string, _params?: unknown) => [],
  );
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<MarkersPanel />", () => {
  it("renders the empty-state when markers.list returns []", async () => {
    (mocks.runCommand as Mock).mockResolvedValue([]);
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No markers");
  });

  it("renders markers returned by markers.list", async () => {
    (mocks.runCommand as Mock).mockResolvedValue([
      { id: "m1", name: "Intro", in: 0, out: 5 },
      { id: "m2", name: "Demo", in: 6, out: 12 },
    ]);
    host = await renderPanel();
    const names = host.container.querySelectorAll(".markers-row-name");
    expect(names.length).toBe(2);
  });

  it("clicking + calls markers.add and refreshes", async () => {
    (mocks.runCommand as Mock)
      .mockResolvedValueOnce([]) // initial list
      .mockResolvedValueOnce({ ticks: 0 }) // playback.position
      .mockResolvedValueOnce({ ok: true }) // markers.add
      .mockResolvedValueOnce([{ id: "m1", name: "Marker 1", in: 0 }]); // refresh
    host = await renderPanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const addBtn = host.container.querySelector(
      '[data-automation-id="panel.markers.add"]',
    ) as HTMLButtonElement;
    expect(addBtn).not.toBeNull();
    await act(async () => {
      addBtn.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const calls = (mocks.runCommand as Mock).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(calls).toContain("markers.add");
    expect(calls).toContain("markers.list");
  });
});
