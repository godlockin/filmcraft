/**
 * Shortcuts dialog (M3.11).
 *
 * Lists every engine command alongside its keyboard binding(s), as
 * reported by `engine.commands`. The dialog is read-only — the
 * desktop supports per-binding customisation (`shortcuts.set`)
 * which is not exposed as an engine command in M3.11.
 *
 * Triggered by the Header's "Window" menu (or by calling
 * `setShortcutsOpen(true)`). The map is computed on mount and
 * cached locally for the life of the dialog.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useEngineStore } from "../store";
import { buildShortcutMap } from "../lib/shortcuts";
import type { CommandInfo } from "../types";
import "./ShortcutsDialog.css";

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const commands = useEngineStore((s) => s.commands);
  const runCommand = useEngineStore((s) => s.runCommand);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (commands === null) {
      void runCommand("engine.commands");
    }
  }, [open, commands, runCommand]);

  // Click-outside + Escape to close.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      const t = e.target as Node | null;
      if (t === null || ref.current?.contains(t) === true) return;
      onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="shortcuts-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      data-automation-id="panel.shortcuts"
    >
      <header className="shortcuts-dialog-header">
        <span className="shortcuts-dialog-title">Keyboard Shortcuts</span>
        <button
          type="button"
          className="shortcuts-dialog-close"
          onClick={onClose}
          data-automation-id="panel.shortcuts.close"
        >
          Close
        </button>
      </header>
      <div className="shortcuts-dialog-toolbar">
        <input
          type="text"
          className="shortcuts-dialog-search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-automation-id="panel.shortcuts.search"
        />
      </div>
      <table className="shortcuts-dialog-table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Shortcut</th>
            <th>Command</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={3} className="shortcuts-dialog-empty">
                {commands === null ? "Loading…" : "No matches"}
              </td>
            </tr>
          ) : (
            filtered.map((row) => (
              <tr key={row.id} data-automation-id={`panel.shortcuts.row.${row.id}`}>
                <td>{row.label ?? row.id}</td>
                <td className="shortcuts-dialog-key">{row.binding ?? "—"}</td>
                <td className="shortcuts-dialog-id">{row.id}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface DisplayRow {
  id: string;
  label: string;
  binding: string;
}

/** Flatten `engine.commands` (with shortcuts) into display rows filtered by `query`. */
function filterCommands(commands: CommandInfo[] | null, query: string): DisplayRow[] {
  if (commands === null) return [];
  const map = buildShortcutMap(commands);
  const q = query.trim().toLowerCase();
  const out: DisplayRow[] = [];
  for (const c of commands) {
    const binding = (map.byCommand.get(c.id) ?? [])[0] ?? "";
    const label = c.label ?? c.id;
    if (q !== "") {
      const hay = `${label}\n${c.id}\n${binding}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push({ id: c.id, label, binding });
  }
  return out;
}
