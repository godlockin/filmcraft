/**
 * PresetsPanel tests (M3.11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  setPreference: vi.fn(async () => undefined),
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            runCommand: mocks.runCommand,
            setPreference: mocks.setPreference,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import PresetsPanel from "./PresetsPanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderPanel(presets: unknown): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  (mocks.runCommand as Mock).mockImplementation(async (cmd?: string) => {
    if (cmd === "export.presets.list") return presets;
    return null;
  });
  await act(async () => {
    root.render(<PresetsPanel />);
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
  (mocks.setPreference as Mock).mockReset();
  (mocks.setPreference as Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<PresetsPanel />", () => {
  it("shows the empty state when the engine returns no presets", async () => {
    host = await renderPanel({ presets: [] });
    expect(host.container.textContent ?? "").toContain("No presets");
  });

  it("renders one row per preset", async () => {
    host = await renderPanel({
      presets: [{ name: "Match Source", format: "h264" }, { name: "ProRes HQ", format: "prores" }],
    });
    expect(
      host.container.querySelector('[data-automation-id="panel.presets.row.Match Source"]'),
    ).not.toBeNull();
    expect(
      host.container.querySelector('[data-automation-id="panel.presets.row.ProRes HQ"]'),
    ).not.toBeNull();
  });

  it("applies a preset on Apply click (sets preference + calls get)", async () => {
    host = await renderPanel({
      presets: [{ name: "Match Source", format: "h264" }],
    });
    const btn = host.container.querySelector(
      '[data-automation-id="panel.presets.apply.Match Source"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(mocks.setPreference).toHaveBeenCalledWith("ui.lastExportPreset", "Match Source");
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "export.presets.get",
      expect.objectContaining({ name: "Match Source" }),
    );
  });
});
