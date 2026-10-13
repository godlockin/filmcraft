/**
 * AudioMetersPanel tests (M3.5).
 *
 * The cloud server does not publish `state.inspect.audio_levels`, so
 * the panel renders a static placeholder. The test asserts the
 * placeholder shape (two L/R channels + explanatory note).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../store", () => ({
  useEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      typeof sel === "function"
        ? sel({
            activeProject: "demo",
            connectionState: "open",
            ui: { activeMode: "edit", quickExportOpen: false },
            runCommand: () => Promise.resolve(null),
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

import AudioMetersPanel from "./AudioMetersPanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function renderPanel(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AudioMetersPanel />);
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
  /* noop */
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<AudioMetersPanel />", () => {
  it("renders two meter channels labelled L and R", () => {
    host = renderPanel();
    expect(
      host.container.querySelector(
        '[data-automation-id="panel.audioMeters.channel.L"]',
      ),
    ).not.toBeNull();
    expect(
      host.container.querySelector(
        '[data-automation-id="panel.audioMeters.channel.R"]',
      ),
    ).not.toBeNull();
  });

  it("includes an explanatory note about audio_levels not yet being available", () => {
    host = renderPanel();
    expect(host.container.textContent ?? "").toContain("audio_levels");
  });
});