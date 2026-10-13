/**
 * ImportMode overlay tests (M3.9).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  setMode: vi.fn(),
  activeMode: "import" as "import" | "edit" | "export",
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            ui: { activeMode: mocks.activeMode },
            setMode: mocks.setMode,
            activeProject: "demo",
            runCommand: mocks.runCommand,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

vi.mock("../api", () => ({
  listMedia: vi.fn(async () => ({ ok: true, project: "demo", items: [] })),
}));

vi.mock("./MediaBrowserPanel", () => ({
  default: ({ fullScreen }: { fullScreen?: boolean }) => (
    <div data-automation-id="panel.mediaBrowser" data-fullscreen={fullScreen ? "1" : "0"}>
      MediaBrowserPanel
    </div>
  ),
}));

import ImportMode from "./ImportMode";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderMode(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ImportMode />);
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
  (mocks.setMode as Mock).mockReset();
  mocks.activeMode = "import";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<ImportMode />", () => {
  it("renders the full-screen overlay chrome", async () => {
    host = await renderMode();
    expect(host.container.querySelector('[data-automation-id="import.mode"]')).not.toBeNull();
    expect(host.container.querySelector('[data-automation-id="import.mode.close"]')).not.toBeNull();
  });

  it("mounts the media browser in full-screen mode", async () => {
    host = await renderMode();
    const browser = host.container.querySelector('[data-automation-id="panel.mediaBrowser"]');
    expect(browser).not.toBeNull();
    expect(browser?.getAttribute("data-fullscreen")).toBe("1");
  });

  it("closes to the edit dock when the close button is clicked", async () => {
    host = await renderMode();
    const btn = host.container.querySelector(
      '[data-automation-id="import.mode.close"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn?.click();
    });
    expect(mocks.setMode).toHaveBeenCalledWith("edit");
  });
});
