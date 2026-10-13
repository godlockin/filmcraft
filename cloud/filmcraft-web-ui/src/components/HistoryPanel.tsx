/**
 * History panel (M3.8).
 *
 * Two lists: undo (current state is highlighted at the top) and
 * redo. The engine exposes `history.list` (returns `{ undo: [str],
 * redo: [str] }`) plus `edit.undo` / `edit.redo` step commands.
 * Since the plan's `history.undoTo` / `history.redoTo` do not exist
 * in this milestone (see M3 plan §M3.8 Risks §7), we expose Undo
 * and Redo as step buttons that pop one entry off the relevant list
 * and dispatch `edit.undo` / `edit.redo`.
 */

import { useEffect, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./HistoryPanel.css";

interface HistoryState {
  undo: string[];
  redo: string[];
}

export default function HistoryPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [history, setHistory] = useState<HistoryState>({ undo: [], redo: [] });
  const [loading, setLoading] = useState(false);

  const reload = async () => {
    if (activeProject === null) return;
    setLoading(true);
    try {
      const r = await runCommand("history.list");
      setHistory(normalise(r));
    } catch {
      setHistory({ undo: [], redo: [] });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [activeProject]);

  async function step(kind: "undo" | "redo") {
    await runCommand(kind === "undo" ? "edit.undo" : "edit.redo");
    await reload();
  }

  return (
    <PanelFrame title="History" automationId="panel.history">
      {loading ? (
        <div className="history-empty">Loading…</div>
      ) : (
        <div className="history-root">
          <div className="history-actions">
            <button
              type="button"
              className="history-btn"
              onClick={() => void step("undo")}
              disabled={history.undo.length === 0}
              data-automation-id="panel.history.undo"
            >
              Undo
            </button>
            <button
              type="button"
              className="history-btn"
              onClick={() => void step("redo")}
              disabled={history.redo.length === 0}
              data-automation-id="panel.history.redo"
            >
              Redo
            </button>
          </div>
          <div className="history-columns">
            <HistoryList
              kind="undo"
              items={history.undo}
              automationId="panel.history.undoList"
            />
            <HistoryList
              kind="redo"
              items={history.redo}
              automationId="panel.history.redoList"
            />
          </div>
        </div>
      )}
    </PanelFrame>
  );
}

function HistoryList({
  kind,
  items,
  automationId,
}: {
  kind: "undo" | "redo";
  items: string[];
  automationId: string;
}) {
  return (
    <section className="history-col" aria-label={`${kind} list`}>
      <header className="history-col-title">{kind === "undo" ? "Undo" : "Redo"}</header>
      {items.length === 0 ? (
        <div className="history-col-empty">—</div>
      ) : (
        <ul className="history-col-list" role="list">
          {items.map((label, i) => (
            <li
              key={i}
              className={
                "history-col-row" + (kind === "undo" && i === 0 ? " is-current" : "")
              }
              data-automation-id={`${automationId}.${i}`}
            >
              {label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function normalise(v: unknown): HistoryState {
  if (v === null || typeof v !== "object") return { undo: [], redo: [] };
  const o = v as Record<string, unknown>;
  const undo = Array.isArray(o.undo)
    ? o.undo.filter((s): s is string => typeof s === "string")
    : [];
  const redo = Array.isArray(o.redo)
    ? o.redo.filter((s): s is string => typeof s === "string")
    : [];
  return { undo, redo };
}