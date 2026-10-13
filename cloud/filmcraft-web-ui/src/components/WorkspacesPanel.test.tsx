/**
 * WorkspacesPanel tests (M3.11).
 */

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import WorkspacesPanel from "./WorkspacesPanel";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function renderPanel(currentPanels: string[]): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<WorkspacesPanel currentPanels={currentPanels} />);
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

afterEach(() => {
  host?.unmount();
  host = null;
  localStorage.clear();
});

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("<WorkspacesPanel />", () => {
  it("renders the empty state when no workspaces are saved", async () => {
    host = await renderPanel([]);
    expect(host.container.textContent ?? "").toContain("No saved workspaces");
  });

  it("saves a workspace from the current panel list", async () => {
    host = await renderPanel(["panel.markers", "panel.effects"]);
    const input = host.container.querySelector(
      '[data-automation-id="panel.workspaces.name"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, "my-ws");
    });
    const save = host.container.querySelector(
      '[data-automation-id="panel.workspaces.save"]',
    ) as HTMLButtonElement;
    await act(async () => {
      save.click();
    });
    expect(
      host.container.querySelector('[data-automation-id="panel.workspaces.row.my-ws"]'),
    ).not.toBeNull();
    const stored = localStorage.getItem("filmcraft.workspaces.v1");
    expect(stored).toContain("my-ws");
  });

  it("removes a workspace when × is clicked", async () => {
    host = await renderPanel(["x"]);
    const input = host.container.querySelector(
      '[data-automation-id="panel.workspaces.name"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "to-remove");
    });
    const save = host.container.querySelector(
      '[data-automation-id="panel.workspaces.save"]',
    ) as HTMLButtonElement;
    await act(async () => {
      save.click();
    });
    const del = host.container.querySelector(
      '[data-automation-id="panel.workspaces.delete.to-remove"]',
    ) as HTMLButtonElement | null;
    expect(del).not.toBeNull();
    await act(async () => {
      del!.click();
    });
    expect(
      host.container.querySelector('[data-automation-id="panel.workspaces.row.to-remove"]'),
    ).toBeNull();
  });
});
