/**
 * ReferenceMonitorPanel tests (M3.11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  selectedMedia: null as { name: string; url: string } | null,
  projectInspect: null as unknown,
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            selectedMedia: mocks.selectedMedia,
            projectInspect: mocks.projectInspect,
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

import ReferenceMonitorPanel from "./ReferenceMonitorPanel";

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
    root.render(<ReferenceMonitorPanel />);
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
  mocks.selectedMedia = null;
  mocks.projectInspect = null;
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<ReferenceMonitorPanel />", () => {
  it("renders the no-selection state when nothing is picked", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No selection");
  });

  it("renders the metadata block when a media is selected", async () => {
    mocks.selectedMedia = { name: "intro.mp4", url: "/projects/demo/media/intro.mp4" };
    mocks.projectInspect = { name: "demo" };
    host = await renderPanel();
    expect(
      host.container.querySelector('[data-automation-id="panel.reference.meta"]'),
    ).not.toBeNull();
    expect(host.container.textContent ?? "").toContain("intro.mp4");
  });
});
