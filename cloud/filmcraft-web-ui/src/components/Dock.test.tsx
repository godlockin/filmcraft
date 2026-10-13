/**
 * Dock layout tests (M3.3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  // Default to a resolved promise so nested panels' mount effects
  // (markers.list / effects.list / …) don't throw before the test
  // gets a chance to drive the DOM. Dock itself only checks layout
  // — we don't introspect which commands fired.
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            activeProject: "demo",
            connectionState: "open",
            ui: {
              activeMode: "edit",
              quickExportOpen: false,
              activeTool: "selection",
            },
            runCommand: mocks.runCommand,
            setSelectedMedia: vi.fn(),
            setActiveTool: vi.fn(),
            clearEventLog: vi.fn(),
            timeline: null,
            selectedMedia: null,
            projectInspect: null,
            lastError: null,
            eventLog: [],
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listMedia: vi.fn(async () => ({ ok: true, project: "demo", items: [] })),
  };
});

vi.mock("./ProjectPanel", () => ({
  default: () => null,
}));
vi.mock("./TimelinePanel", () => ({
  default: () => null,
}));
vi.mock("./MonitorPanel", () => ({
  default: (props: { timecode?: string }) => (
    <div data-automation-id="panel.monitors" data-timecode={props.timecode ?? ""}>
      MonitorPanel(tc:{props.timecode ?? "(none)"})
    </div>
  ),
}));

import Dock from "./Dock";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderDock(props: { timecode?: string } = {}): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // Dock renders Markers/Effects panels in the right region, which
  // fire engine commands on mount. Async `act` drains their initial
  // promise chain so the test doesn't hit "Should not already be
  // working".
  await act(async () => {
    root.render(<Dock {...props} />);
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
  (mocks.runCommand as Mock).mockClear();
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<Dock />", () => {
  it("mounts the four labelled regions", async () => {
    host = await renderDock();
    expect(host.container.querySelector('[data-automation-id="dock.root"]')).not.toBeNull();
    expect(host.container.querySelector('[aria-label="Project"]')).not.toBeNull();
    expect(host.container.querySelector('[aria-label="Monitors"]')).not.toBeNull();
    expect(host.container.querySelector('[aria-label="Right panels"]')).not.toBeNull();
    expect(host.container.querySelector('[aria-label="Timeline"]')).not.toBeNull();
  });

  it("forwards the timecode prop to the monitor panel", async () => {
    host = await renderDock({ timecode: "00:00:42:12" });
    const monitors = host.container.querySelector('[data-automation-id="panel.monitors"]');
    expect(monitors).not.toBeNull();
    expect(monitors?.textContent ?? "").toContain("00:00:42");
  });
});
