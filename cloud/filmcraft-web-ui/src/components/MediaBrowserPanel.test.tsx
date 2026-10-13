/**
 * MediaBrowserPanel tests (M3.9).
 *
 * The cloud deployment has no OS file system. The panel falls back to
 * the project media list and shows a banner explaining that. It still
 * routes imports through `mediaBrowser.import` when the engine accepts
 * the call (see the engine `media_browser.rs` module).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(async (_cmd?: string, _params?: unknown) => null),
  listMedia: vi.fn(async (_project: string) => ({
    ok: true as const,
    project: "demo",
    items: [] as unknown[],
  })),
}));

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            runCommand: mocks.runCommand,
            activeProject: "demo",
          })
        : null,
    {
      getState: () => ({}),
      setState: () => undefined,
    },
  ),
}));

vi.mock("../api", () => ({
  listMedia: mocks.listMedia,
}));

import MediaBrowserPanel from "./MediaBrowserPanel";

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
    root.render(<MediaBrowserPanel />);
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
  (mocks.listMedia as Mock).mockReset();
  (mocks.listMedia as Mock).mockImplementation(
    async (_project: string) => ({ ok: true as const, project: "demo", items: [] }),
  );
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<MediaBrowserPanel />", () => {
  it("shows the cloud-limitation banner", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("browsing project media only");
  });

  it("renders the no-media empty state when the project has no media", async () => {
    host = await renderPanel();
    expect(host.container.textContent ?? "").toContain("No media");
  });

  it("renders a card for each project media item", async () => {
    (mocks.listMedia as Mock).mockImplementation(async (_project: string) => ({
      ok: true as const,
      project: "demo",
      items: [
        { name: "clipA.mp4", url: "/projects/demo/media/clipA.mp4" },
        { name: "clipB.mp4" },
      ],
    }));
    host = await renderPanel();
    expect(
      host.container.querySelector('[data-automation-id="panel.mediaBrowser.card.clipA.mp4"]'),
    ).not.toBeNull();
    expect(
      host.container.querySelector('[data-automation-id="panel.mediaBrowser.card.clipB.mp4"]'),
    ).not.toBeNull();
  });

  it("filters the grid by the search input", async () => {
    (mocks.listMedia as Mock).mockImplementation(async (_project: string) => ({
      ok: true as const,
      project: "demo",
      items: [{ name: "intro.mp4" }, { name: "outro.mp4" }],
    }));
    host = await renderPanel();
    const input = host.container.querySelector(
      '[data-automation-id="panel.mediaBrowser.search"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      // Use the native React-friendly setter so React picks up the new
      // value through the synthetic event system.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input!, "INTR");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // intro.mp4 stays, outro.mp4 is filtered out.
    expect(
      host.container.querySelector('[data-automation-id="panel.mediaBrowser.card.intro.mp4"]'),
    ).not.toBeNull();
    expect(
      host.container.querySelector('[data-automation-id="panel.mediaBrowser.card.outro.mp4"]'),
    ).toBeNull();
  });

  it("dispatches mediaBrowser.import when an Import button is clicked", async () => {
    (mocks.listMedia as Mock).mockImplementation(async (_project: string) => ({
      ok: true as const,
      project: "demo",
      items: [{ name: "intro.mp4" }],
    }));
    (mocks.runCommand as Mock).mockImplementation(
      async (cmd?: string, params?: Record<string, unknown>) => {
        if (cmd === "mediaBrowser.import") return { ok: true, imported: (params as { paths?: string[] }).paths?.length ?? 0 };
        return null;
      },
    );
    host = await renderPanel();
    const btn = host.container.querySelector(
      '[data-automation-id="panel.mediaBrowser.import.intro.mp4"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "mediaBrowser.import",
      expect.objectContaining({ paths: ["intro.mp4"] }),
    );
  });
});
