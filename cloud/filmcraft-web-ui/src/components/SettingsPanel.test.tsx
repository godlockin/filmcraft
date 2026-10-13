/**
 * SettingsPanel tests (M3.11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  setPreference: vi.fn(async () => undefined),
  getPreference: vi.fn(async () => undefined),
  prefs: {} as Record<string, unknown>,
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            prefs: mocks.prefs,
            setPreference: mocks.setPreference,
            getPreference: mocks.getPreference,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import SettingsPanel from "./SettingsPanel";

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
    root.render(<SettingsPanel />);
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
  mocks.prefs = {};
  (mocks.setPreference as Mock).mockReset();
  (mocks.getPreference as Mock).mockReset();
  (mocks.setPreference as Mock).mockResolvedValue(undefined);
  (mocks.getPreference as Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  host?.unmount();
  host = null;
});

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("<SettingsPanel />", () => {
  it("hydrates prefs on mount", async () => {
    host = await renderPanel();
    expect(mocks.getPreference).toHaveBeenCalledWith("ui.snapSeconds");
    expect(mocks.getPreference).toHaveBeenCalledWith("ui.autosaveSeconds");
  });

  it("renders one row per pref key", async () => {
    host = await renderPanel();
    expect(
      host.container.querySelector('[data-automation-id="panel.settings.row.ui.snapSeconds"]'),
    ).not.toBeNull();
    expect(
      host.container.querySelector('[data-automation-id="panel.settings.row.ui.autosaveSeconds"]'),
    ).not.toBeNull();
  });

  it("commits the new value through setPreference", async () => {
    mocks.prefs = { "ui.snapSeconds": 5 };
    host = await renderPanel();
    const input = host.container.querySelector(
      '[data-automation-id="panel.settings.input.ui.snapSeconds"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("5");
    await act(async () => {
      setInputValue(input!, "12");
    });
    expect(mocks.setPreference).toHaveBeenCalledWith("ui.snapSeconds", 12);
  });
});
