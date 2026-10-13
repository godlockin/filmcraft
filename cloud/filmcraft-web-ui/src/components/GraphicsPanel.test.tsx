/**
 * GraphicsPanel tests (M3.7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => []),
  activeProject: "demo",
}));

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

import GraphicsPanel from "./GraphicsPanel";

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
    root.render(<GraphicsPanel />);
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
    async (_cmd?: string, _params?: unknown) => [],
  );
  mocks.activeProject = "demo";
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<GraphicsPanel />", () => {
  it("renders the empty-state when graphics.template.list returns []", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No templates");
  });

  it("renders template cards returned by graphics.template.list", async () => {
    (mocks.runCommand as Mock).mockResolvedValue([
      { id: "lower-third", name: "Lower Third", category: "Titles" },
      { id: "callout", name: "Callout", category: "Overlays" },
    ]);
    host = await renderPanel();
    const cards = host.container.querySelectorAll(".graphics-card");
    expect(cards.length).toBe(2);
    expect(host.container.textContent ?? "").toContain("Lower Third");
  });

  it("Apply dispatches graphics.template.apply with the template id", async () => {
    (mocks.runCommand as Mock).mockResolvedValue([
      { id: "lower-third", name: "Lower Third" },
    ]);
    host = await renderPanel();
    const apply = host.container.querySelector(
      '[data-automation-id="panel.graphics.apply.lower-third"]',
    ) as HTMLButtonElement;
    expect(apply).not.toBeNull();
    await act(async () => {
      apply.click();
    });
    const applyCall = (mocks.runCommand as Mock).mock.calls.find(
      (c: unknown[]) => c[0] === "graphics.template.apply",
    );
    expect(applyCall).toBeDefined();
    expect((applyCall?.[1] as Record<string, unknown>).template).toBe(
      "lower-third",
    );
  });
});