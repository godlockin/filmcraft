/**
 * Workspaces panel (M3.11).
 *
 * UI-level workspace presets (which panels are shown, their order,
 * etc.) backed by `safeStorage`. The engine has no `workspaces.list`
 * command in M3.11 (verified against `crates/engine/src/commands.rs`
 * Risks §7) so the cloud UI uses localStorage directly, with the
 * same `safeStorage` helper the rest of the app already uses.
 *
 * The default workspace simply records the current open-panel list;
 * the user can save / restore named presets.
 */

import { useEffect, useState } from "react";
import PanelFrame from "./PanelFrame";
import { safeStorage } from "../lib/storage";
import "./WorkspacesPanel.css";

interface Workspace {
  name: string;
  panels: string[];
  savedAt: number;
}

const STORAGE_KEY = "filmcraft.workspaces.v1";

function loadAll(): Workspace[] {
  const store = safeStorage();
  if (store === null) return [];
  const raw = store.getItem(STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (w): w is Workspace =>
        w !== null &&
        typeof w === "object" &&
        typeof (w as Workspace).name === "string" &&
        Array.isArray((w as Workspace).panels),
    );
  } catch {
    return [];
  }
}

function saveAll(list: Workspace[]): void {
  const store = safeStorage();
  if (store === null) return;
  store.setItem(STORAGE_KEY, JSON.stringify(list));
}

interface WorkspacesPanelProps {
  /** List of currently-open panel ids (the active workspace's contents). */
  currentPanels: string[];
}

export default function WorkspacesPanel({ currentPanels }: WorkspacesPanelProps) {
  const [list, setList] = useState<Workspace[]>(() => loadAll());
  const [name, setName] = useState("");

  useEffect(() => {
    saveAll(list);
  }, [list]);

  function save(): void {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setList((prev) => [
      ...prev.filter((w) => w.name !== trimmed),
      { name: trimmed, panels: currentPanels, savedAt: Date.now() },
    ]);
    setName("");
  }

  function remove(n: string): void {
    setList((prev) => prev.filter((w) => w.name !== n));
  }

  return (
    <PanelFrame title="Workspaces" automationId="panel.workspaces">
      <div className="workspaces-root">
        <div className="workspaces-save">
          <input
            type="text"
            className="workspaces-input"
            placeholder="Workspace name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-automation-id="panel.workspaces.name"
          />
          <button
            type="button"
            className="workspaces-save-btn"
            onClick={save}
            disabled={name.trim() === ""}
            data-automation-id="panel.workspaces.save"
          >
            Save
          </button>
        </div>
        {list.length === 0 ? (
          <div className="workspaces-empty">No saved workspaces</div>
        ) : (
          <ul className="workspaces-list" role="list">
            {list.map((w) => (
              <li
                key={w.name}
                className="workspaces-row"
                data-automation-id={`panel.workspaces.row.${w.name}`}
              >
                <span className="workspaces-name">{w.name}</span>
                <span className="workspaces-count">{w.panels.length} panels</span>
                <button
                  type="button"
                  className="workspaces-del"
                  onClick={() => remove(w.name)}
                  data-automation-id={`panel.workspaces.delete.${w.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PanelFrame>
  );
}
