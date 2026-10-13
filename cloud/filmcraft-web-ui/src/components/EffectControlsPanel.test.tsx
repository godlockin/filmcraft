/**
 * EffectControlsPanel tests (M3.5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  // Default returns an empty selection so the panel renders the
  // "No clip selected" placeholder before individual tests reset.
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => ({
    selection: [],
    video: [],
    audio: [],
  })),
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

import EffectControlsPanel from "./EffectControlsPanel";

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
    root.render(<EffectControlsPanel />);
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
    async (_cmd?: string, _params?: unknown) => ({
      selection: [],
      video: [],
      audio: [],
    }),
  );
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<EffectControlsPanel />", () => {
  it("renders 'No clip selected' when selection is empty", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No clip selected");
  });

  it("renders parameter inputs for each effect on the selected clip", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      selection: [42],
      video: [
        {
          id: "V1",
          items: [
            {
              clip: 42,
              name: "My Clip",
              effects: [
                {
                  effect: "gaussian_blur",
                  enabled: true,
                  params: {
                    radius: { value: 5 },
                    amount: { value: 0.5 },
                  },
                },
              ],
            },
          ],
        },
      ],
      audio: [],
    });
    host = await renderPanel();
    const inputs = host.container.querySelectorAll(".effect-controls-param-input");
    expect(inputs.length).toBe(2);
    expect(host.container.textContent ?? "").toContain("radius");
    expect(host.container.textContent ?? "").toContain("amount");
  });

  it("dispatches effects.setParam on input change", async () => {
    (mocks.runCommand as Mock)
      .mockResolvedValueOnce({
        selection: [42],
        video: [
          {
            id: "V1",
            items: [
              {
                clip: 42,
                name: "My Clip",
                effects: [
                  {
                    effect: "gaussian_blur",
                    enabled: true,
                    params: { radius: { value: 5 } },
                  },
                ],
              },
            ],
          },
        ],
        audio: [],
      });
    host = await renderPanel();
    const input = host.container.querySelector(
      ".effect-controls-param-input",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.defineProperty(input, "value", { value: "8", configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const calls = (mocks.runCommand as Mock).mock.calls;
    const setParam = calls.find(
      (c: unknown[]) => c[0] === "effects.setParam",
    );
    expect(setParam).toBeDefined();
    const params = setParam?.[1] as Record<string, unknown>;
    expect(params.param).toBe("radius");
    expect(params.value).toBe(8);
    expect(params.effect).toBe("gaussian_blur");
  });
});