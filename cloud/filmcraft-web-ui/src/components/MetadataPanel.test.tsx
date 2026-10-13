/**
 * MetadataPanel tests (M3.7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  activeProject: "demo",
  selectedMedia: null as { name: string; url: string } | null,
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
            selectedMedia: mocks.selectedMedia,
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

import MetadataPanel from "./MetadataPanel";

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
    root.render(<MetadataPanel />);
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
  mocks.selectedMedia = null;
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<MetadataPanel />", () => {
  it("renders No metadata when project.inspect returns null and no media selected", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No metadata");
  });

  it("renders project fields from project.inspect", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      name: "Demo Project",
      width: 1920,
      height: 1080,
      frameRate: 23.976,
      duration: 600,
      schema: 7,
    });
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("Demo Project");
    expect(host.container.textContent ?? "").toContain("1920×1080");
    expect(host.container.textContent ?? "").toContain("23.976");
  });

  it("renders selected-media fields when present", async () => {
    (mocks.runCommand as Mock).mockResolvedValue({
      name: "Demo Project",
    });
    mocks.selectedMedia = {
      name: "intro.mp4",
      url: "/api/v1/projects/demo/media/intro.mp4",
    };
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("Selected Media");
    expect(host.container.textContent ?? "").toContain("intro.mp4");
  });
});