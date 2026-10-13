/**
 * InfoPanel tests (M3.11).
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

import InfoPanel from "./InfoPanel";

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
    root.render(<InfoPanel />);
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
    async (cmd?: string) => {
      if (cmd === "project.inspect") return { name: "demo-project", width: 1920 };
      if (cmd === "state.inspect") return { rendering: false, job: null };
      return null;
    },
  );
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<InfoPanel />", () => {
  it("renders the panels even when no engine data is present", async () => {
    (mocks.runCommand as Mock).mockImplementation(async () => null);
    host = await renderPanel();
    expect(host.container.querySelector('[data-automation-id="panel.info"]')).not.toBeNull();
    expect(host.container.textContent ?? "").toContain("No data");
  });

  it("renders the project / state rows when the engine returns data", async () => {
    host = await renderPanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      host.container.querySelector('[data-automation-id="panel.info.project.name"]'),
    ).not.toBeNull();
    expect(
      host.container.querySelector('[data-automation-id="panel.info.state.rendering"]'),
    ).not.toBeNull();
  });
});
