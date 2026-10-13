/**
 * Timeline toolbar (M3.6).
 *
 * Selection (V) / Ripple (B) / Razor (C) / Hand (H) toggle. The
 * engine doesn't expose a `tool.*` command in this milestone (see M3
 * plan §M3.6 Risks §5) so the toolbar is local UI state only — it
 * sets `ui.activeTool` in the store so future panels (e.g. a
 * keyboard shortcut map) can read it.
 */

import { useEngineStore } from "../store";
import "./TimelineToolbar.css";

interface ToolDef {
  id: "selection" | "ripple" | "razor" | "hand";
  label: string;
  shortcut: string;
}

const TOOLS: ToolDef[] = [
  { id: "selection", label: "Selection", shortcut: "V" },
  { id: "ripple", label: "Ripple Edit", shortcut: "B" },
  { id: "razor", label: "Razor", shortcut: "C" },
  { id: "hand", label: "Hand", shortcut: "H" },
];

export default function TimelineToolbar() {
  const activeTool = useEngineStore((s) => s.ui.activeTool ?? "selection");
  const setActiveTool = useEngineStore((s) => s.setActiveTool);

  return (
    <div className="timeline-toolbar" role="toolbar" aria-label="Timeline tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={
            "timeline-tool" + (activeTool === t.id ? " is-active" : "")
          }
          onClick={() => setActiveTool(t.id)}
          title={`${t.label} (${t.shortcut})`}
          data-automation-id={`timeline.tool.${t.id}`}
        >
          <span className="timeline-tool-label">{t.label}</span>
          <span className="timeline-tool-shortcut">{t.shortcut}</span>
        </button>
      ))}
    </div>
  );
}