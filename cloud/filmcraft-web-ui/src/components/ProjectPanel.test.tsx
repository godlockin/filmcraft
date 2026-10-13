/**
 * ProjectPanel tests (M3.3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  setSelectedMedia: vi.fn(),
  // Default returns a resolved promise so the panel's mount effect
  // doesn't throw on `.then()` before individual tests reset.
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  activeProject: "demo",
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listMedia: vi.fn(async () => ({
      ok: true,
      project: "demo",
      items: ["clip1.mp4", "clip2.mp4"],
    })),
  };
});

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            activeProject: mocks.activeProject,
            connectionState: "open",
            ui: {
              activeMode: "edit",
              quickExportOpen: false,
              activeTool: "selection",
            },
            runCommand: mocks.runCommand,
            setSelectedMedia: mocks.setSelectedMedia,
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

import ProjectPanel from "./ProjectPanel";

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
    root.render(<ProjectPanel />);
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
  (mocks.setSelectedMedia as Mock).mockReset();
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<ProjectPanel />", () => {
  it("lists every media item returned by listMedia", async () => {
    host = await renderPanel();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
    const cards = host.container.querySelectorAll(".project-media-card");
    expect(cards.length).toBe(2);
    const labels = Array.from(cards).map(
      (c) => c.querySelector(".project-media-label")?.textContent ?? "",
    );
    expect(labels).toEqual(["clip1.mp4", "clip2.mp4"]);
  });

  it("clicking a media card calls setSelectedMedia", async () => {
    host = await renderPanel();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
    const card = host.container.querySelector(
      '[data-automation-id="panel.project.media.clip2.mp4"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.setSelectedMedia).toHaveBeenCalledTimes(1);
    const arg = mocks.setSelectedMedia.mock.calls[0]?.[0] as { name: string };
    expect(arg.name).toBe("clip2.mp4");
  });

  it("calls project.inspect once on mount to read the bin tree", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({ bins: [] });
    host = await renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    const inspectCalls = (mocks.runCommand as Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === "project.inspect",
    );
    expect(inspectCalls.length).toBeGreaterThanOrEqual(1);
  });
});
