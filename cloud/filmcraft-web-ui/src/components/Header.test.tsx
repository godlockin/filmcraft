/**
 * Header tests (M3.2).
 *
 * The header wires three subsystems together: the `uiSlice`, the
 * engine-store transport commands, and the connection-state badge.
 * We mock the store and assert the component reads / writes through
 * it correctly. The mock uses a small Zustand-style store so the
 * selectors in `Header.tsx` keep working without a real `WsClient`.
 *
 * No `@testing-library/react`: M3.2 stays zero-deps. The pattern
 * mirrors `CommandPalette.test.tsx` — render through `createRoot`,
 * drive the DOM directly, wrap interactions in `act()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const runCommand = vi.fn(async () => undefined);
const setMode = vi.fn();

interface UiSlice {
  activeMode: "import" | "edit" | "export";
  quickExportOpen: boolean;
  shortcutsOpen: boolean;
}

interface MockState {
  activeProject: string | null;
  connectionState: "idle" | "connecting" | "open" | "closed" | "fatal";
  auth: { token: string; userId: string; role: string } | null;
  ui: UiSlice;
  commands: unknown[];
  setMode: (mode: UiSlice["activeMode"]) => void;
  runCommand: (command: string) => Promise<unknown>;
  /** Force the state — set by tests for "no project" / "open" / etc. */
  __set: (next: Partial<MockState>) => void;
}

const listeners = new Set<() => void>();
const state: MockState = {
  activeProject: "demo",
  connectionState: "open",
  auth: null,
  ui: { activeMode: "edit", quickExportOpen: false, shortcutsOpen: false },
  commands: [],
  setMode,
  runCommand,
  __set(next) {
    Object.assign(state, next);
    for (const cb of listeners) cb();
  },
};

function makeSelector<T>(slice: T) {
  // Returns the same object reference until `__set` invalidates it.
  (slice as unknown as { __subs: Set<(s: MockState) => void> }).__subs =
    new Set();
  return slice;
}

vi.mock("../store", () => {
  // Tiny `useEngineStore` replacement — selector-aware like Zustand.
  const mockUse = <T,>(selector: (s: MockState) => T): T => {
    return selector(state);
  };
  (mockUse as unknown as { getState: () => MockState }).getState = () => state;
  (mockUse as unknown as {
    setState: (next: Partial<MockState>) => void;
  }).setState = (next) => {
    Object.assign(state, next);
    for (const cb of listeners) cb();
  };
  (mockUse as unknown as { subscribe: (cb: () => void) => () => void }).subscribe = (
    cb,
  ) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  return { useEngineStore: mockUse };
});

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function renderHeader(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    // render synchronously
    void (async () => {
      await import("react");
      const React = (await import("react")).default;
      await import("./Header");
      const Header = (await import("./Header")).default;
      root.render(React.createElement(Header));
    })();
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

// Avoid the dynamic import dance — Header is a static import for the test.
import Header from "./Header";

function renderHeaderStatic(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Header />);
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
  state.__set({
    activeProject: "demo",
    connectionState: "open",
    auth: null,
    ui: { activeMode: "edit", quickExportOpen: false, shortcutsOpen: false },
    commands: [],
  });
  setMode.mockClear();
  runCommand.mockClear();
});

afterEach(() => {
  host?.unmount();
  host = null;
});

describe("<Header />", () => {
  it("renders Import / Edit / Export tabs", () => {
    host = renderHeaderStatic();
    const tabs = host.container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(3);
    const labels = Array.from(tabs).map((t) => t.textContent?.trim() ?? "");
    expect(labels).toEqual(["Import", "Edit", "Export"]);
  });

  it("calls setMode with the new mode on tab click", () => {
    host = renderHeaderStatic();
    const importTab = host.container.querySelector(
      '[data-automation-id="header.mode.import"]',
    ) as HTMLButtonElement | null;
    expect(importTab).not.toBeNull();
    act(() => importTab!.click());
    expect(setMode).toHaveBeenCalledWith("import");
    setMode.mockClear();
    const exportTab = host.container.querySelector(
      '[data-automation-id="header.mode.export"]',
    ) as HTMLButtonElement | null;
    act(() => exportTab!.click());
    expect(setMode).toHaveBeenCalledWith("export");
  });

  it("marks the active mode tab as aria-selected", () => {
    state.__set({ ui: { activeMode: "import", quickExportOpen: false, shortcutsOpen: false } });
    host = renderHeaderStatic();
    const importTab = host.container.querySelector(
      '[data-automation-id="header.mode.import"]',
    )!;
    expect(importTab.getAttribute("aria-selected")).toBe("true");
    const editTab = host.container.querySelector(
      '[data-automation-id="header.mode.edit"]',
    )!;
    expect(editTab.getAttribute("aria-selected")).toBe("false");
  });

  it("dispatches playback.play on Play", () => {
    host = renderHeaderStatic();
    const btn = host.container.querySelector(
      '[data-automation-id="transport.play"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(runCommand).toHaveBeenCalledWith("playback.play");
  });

  it("dispatches playback.pause on Pause", () => {
    host = renderHeaderStatic();
    const btn = host.container.querySelector(
      '[data-automation-id="transport.pause"]',
    ) as HTMLButtonElement | null;
    act(() => btn!.click());
    expect(runCommand).toHaveBeenCalledWith("playback.pause");
  });

  it("dispatches playback.stop on Stop", () => {
    host = renderHeaderStatic();
    const btn = host.container.querySelector(
      '[data-automation-id="transport.stop"]',
    ) as HTMLButtonElement | null;
    act(() => btn!.click());
    expect(runCommand).toHaveBeenCalledWith("playback.stop");
  });

  it("disables transport when no project is active", () => {
    state.__set({ activeProject: null });
    host = renderHeaderStatic();
    const play = host.container.querySelector(
      '[data-automation-id="transport.play"]',
    ) as HTMLButtonElement | null;
    expect(play).not.toBeNull();
    expect(play!.disabled).toBe(true);
    act(() => play!.click());
    expect(runCommand).not.toHaveBeenCalled();
  });
});

// avoid TS unused-warning
void makeSelector;
void renderHeader;
