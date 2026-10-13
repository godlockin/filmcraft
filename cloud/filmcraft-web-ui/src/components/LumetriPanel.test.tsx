/**
 * LumetriPanel tests (M3.5).
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

import LumetriPanel from "./LumetriPanel";

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
    root.render(<LumetriPanel />);
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
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<LumetriPanel />", () => {
  it("renders 'Select a clip' when selection is empty", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("Select a clip");
  });

  it("renders the Basic Correction sliders when a clip with lumetri_color is selected", async () => {
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string) => {
        if (cmd === "sequence.inspect") {
          return {
            selection: [7],
            video: [
              {
                id: "V1",
                items: [
                  {
                    clip: 7,
                    name: "Footage",
                    effects: [
                      {
                        effect: "lumetri_color",
                        enabled: true,
                        params: {
                          exposure: { value: 0.2 },
                          contrast: { value: 0.1 },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
            audio: [],
          };
        }
        if (cmd === "lumetri.presets") return { presets: ["Punch", "Cool"] };
        return null;
      },
    );
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("Basic Correction");
    expect(host.container.textContent ?? "").toContain("Exposure");
    const sliders = host.container.querySelectorAll(".lumetri-basic-slider");
    expect(sliders.length).toBeGreaterThanOrEqual(2);
  });

  it("lists presets in the dropdown", async () => {
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string) => {
        if (cmd === "sequence.inspect") {
          return {
            selection: [1],
            video: [
              { id: "V1", items: [{ clip: 1, effects: [] }] },
            ],
            audio: [],
          };
        }
        if (cmd === "lumetri.presets") {
          return { presets: ["Punch", "Cool", "Warm"] };
        }
        return null;
      },
    );
    host = await renderPanel();
    const opts = host.container.querySelectorAll("option");
    // 1 placeholder + 3 presets
    expect(opts.length).toBe(4);
  });

  it("dispatches lumetri.applyPreset when a preset is chosen", async () => {
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string) => {
        if (cmd === "sequence.inspect") {
          return {
            selection: [3],
            video: [
              { id: "V1", items: [{ clip: 3, effects: [] }] },
            ],
            audio: [],
          };
        }
        if (cmd === "lumetri.presets") return { presets: ["Punch"] };
        return null;
      },
    );
    host = await renderPanel();
    const select = host.container.querySelector(
      '[data-automation-id="panel.lumetri.preset"]',
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    await act(async () => {
      select.value = "Punch";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const calls = (mocks.runCommand as Mock).mock.calls;
    const apply = calls.find((c: unknown[]) => c[0] === "lumetri.applyPreset");
    expect(apply).toBeDefined();
  });
});