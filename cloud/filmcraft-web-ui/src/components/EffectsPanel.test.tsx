/**
 * EffectsPanel tests (M3.4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  // Default to a resolved promise so the panel's `useEffect` chain
  // doesn't throw on render before individual tests reset the mock.
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => ({ items: [] })),
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

import EffectsPanel from "./EffectsPanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderPanel(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // EffectsPanel fires `effects.list` on mount; the resulting promise
  // chain schedules additional state updates. We need async `act` so
  // React 18 can drain them — sync `act` reports "Should not already
  // be working" because work is still pending when it returns.
  await act(async () => {
    root.render(<EffectsPanel />);
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
  // Restore the default implementation that returns a resolved
  // promise — `mockReset` clears the implementation but leaves
  // call history, so we set it back to its initial behaviour.
  (mocks.runCommand as Mock).mockImplementation(
    async (_cmd?: string, _params?: unknown) => ({ items: [] }),
  );
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<EffectsPanel />", () => {
  it("renders the three folders (Video / Audio / Transitions)", async () => {
    host = await renderPanel();
    expect(
      host.container.querySelector('[data-automation-id="panel.effects.folder.Video"]'),
    ).not.toBeNull();
    expect(
      host.container.querySelector('[data-automation-id="panel.effects.folder.Audio"]'),
    ).not.toBeNull();
    expect(
      host.container.querySelector(
        '[data-automation-id="panel.effects.folder.Transitions"]',
      ),
    ).not.toBeNull();
  });

  it("calls effects.list with kind on mount and renders items", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      items: [
        { id: "blur", label: "Gaussian Blur" },
        { id: "lumetri", label: "Lumetri Color" },
      ],
    });
    host = await renderPanel();
    const items = host.container.querySelectorAll(".effects-item");
    expect(items.length).toBe(2);
    expect((mocks.runCommand as Mock).mock.calls[0]?.[0]).toBe("effects.list");
  });

  it("filter input narrows the visible list", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      items: [
        { id: "blur", label: "Gaussian Blur" },
        { id: "lumetri", label: "Lumetri Color" },
        { id: "crop", label: "Crop" },
      ],
    });
    host = await renderPanel();
    const input = host.container.querySelector(
      '[data-automation-id="panel.effects.search"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const ev = new Event("input", { bubbles: true });
      Object.defineProperty(input, "value", { value: "lum", configurable: true });
      input.dispatchEvent(ev);
    });
    const items = host.container.querySelectorAll(".effects-item");
    expect(items.length).toBe(1);
  });
});
