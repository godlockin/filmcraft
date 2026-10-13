/**
 * QuickExportPopup tests (M3.10).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            runCommand: mocks.runCommand,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import QuickExportPopup from "./QuickExportPopup";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderPopup(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  // The popup expects an `anchor` element to detect outside-clicks.
  const anchor = document.createElement("button");
  anchor.textContent = "Quick Export";
  document.body.appendChild(anchor);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QuickExportPopup anchor={anchor} onClose={vi.fn()} />);
    await Promise.resolve();
  });
  return {
    container,
    root,
    unmount() {
      act(() => root.unmount());
      anchor.remove();
      container.remove();
    },
  };
}

let host: Harness | null = null;
let onClose: Mock;

beforeEach(() => {
  (mocks.runCommand as Mock).mockReset();
  (mocks.runCommand as Mock).mockImplementation(async () => null);
  onClose = vi.fn();
});

afterEach(() => {
  host?.unmount();
  host = null;
});

async function renderPopupWith(onCloseFn: Mock): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const anchor = document.createElement("button");
  anchor.textContent = "Quick Export";
  document.body.appendChild(anchor);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QuickExportPopup anchor={anchor} onClose={onCloseFn} />);
    await Promise.resolve();
  });
  return {
    container,
    root,
    unmount() {
      act(() => root.unmount());
      anchor.remove();
      container.remove();
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("<QuickExportPopup />", () => {
  it("renders with the default filename", async () => {
    host = await renderPopup();
    const input = host.container.querySelector(
      '[data-automation-id="quick.export.filename"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("render.mp4");
  });

  it("calls export.quick when Export is clicked", async () => {
    host = await renderPopup();
    const input = host.container.querySelector(
      '[data-automation-id="quick.export.filename"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "render-720.mp4");
    });
    const btn = host.container.querySelector(
      '[data-automation-id="quick.export.go"]',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "export.quick",
      expect.objectContaining({ path: "render-720.mp4" }),
    );
  });

  it("invokes onClose when the Close button is clicked", async () => {
    host = await renderPopupWith(onClose);
    const closeBtn = host.container.querySelector(
      '[data-automation-id="quick.export.close"]',
    ) as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose when Escape is pressed", async () => {
    host = await renderPopupWith(onClose);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
