/**
 * ExportModePanel tests (M3.10).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  setMode: vi.fn(),
  activeProject: "demo" as string | null,
  getExportInfo: vi.fn(async (_project: string) => ({
    ok: false as boolean,
    project: "demo",
  })),
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            runCommand: mocks.runCommand,
            setMode: mocks.setMode,
            activeProject: mocks.activeProject,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

vi.mock("../api", () => ({
  getExportInfo: mocks.getExportInfo,
}));

import ExportModePanel from "./ExportModePanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderPanel(fullScreen = false): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ExportModePanel fullScreen={fullScreen} />);
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
  mocks.setMode.mockReset();
  mocks.getExportInfo.mockReset();
  mocks.getExportInfo.mockResolvedValue({ ok: false, project: "demo" });
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

describe("<ExportModePanel />", () => {
  it("lists presets returned from export.presets.list", async () => {
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string, _params?: Record<string, unknown>) => {
        if (cmd === "export.presets.list") {
          return { presets: [{ name: "H.264 Match Source" }, { name: "ProRes HQ" }] };
        }
        return null;
      },
    );
    host = await renderPanel();
    const select = host.container.querySelector(
      '[data-automation-id="panel.exportMode.preset"]',
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const text = select?.textContent ?? "";
    expect(text).toContain("H.264 Match Source");
    expect(text).toContain("ProRes HQ");
  });

  it("calls file.exportMedia with the form values", async () => {
    (mocks.runCommand as Mock).mockImplementation(async () => null);
    host = await renderPanel();
    await act(async () => {
      const w = host!.container.querySelector(
        '[data-automation-id="panel.exportMode.width"]',
      ) as HTMLInputElement;
      setInputValue(w, "1280");
    });
    await act(async () => {
      const h = host!.container.querySelector(
        '[data-automation-id="panel.exportMode.height"]',
      ) as HTMLInputElement;
      setInputValue(h, "720");
    });
    await act(async () => {
      const f = host!.container.querySelector(
        '[data-automation-id="panel.exportMode.filename"]',
      ) as HTMLInputElement;
      setInputValue(f, "out.mp4");
    });
    const btn = host.container.querySelector(
      '[data-automation-id="panel.exportMode.export"]',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "file.exportMedia",
      expect.objectContaining({ width: 1280, height: 720, path: "out.mp4" }),
    );
  });

  it("calls export.quick when the quick button is clicked", async () => {
    host = await renderPanel();
    const btn = host.container.querySelector(
      '[data-automation-id="panel.exportMode.quick"]',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "export.quick",
      expect.objectContaining({ path: expect.any(String) }),
    );
  });

  it("renders the empty queue message when no jobs exist", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No jobs in queue");
  });

  it("closes back to edit mode from the full-screen Close button", async () => {
    host = await renderPanel(true);
    const btn = host.container.querySelector(
      '[data-automation-id="panel.exportMode.close"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
    });
    expect(mocks.setMode).toHaveBeenCalledWith("edit");
  });
});
