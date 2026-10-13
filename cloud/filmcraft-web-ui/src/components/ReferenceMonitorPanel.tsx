/**
 * Reference monitor panel (M3.11).
 *
 * Companion to the Source/Program monitors in M3.5. Shows the
 * selected media's full-resolution frame as a `<canvas>` if the
 * engine has a streaming preview (not available in M3 — the panel
 * is a placeholder showing the clip's filename + timecode range).
 *
 * Falls back to the metadata-only view when no media is selected.
 */

import PanelFrame from "./PanelFrame";
import { useEngineStore } from "../store";
import "./ReferenceMonitorPanel.css";

export default function ReferenceMonitorPanel() {
  const selectedMedia = useEngineStore((s) => s.selectedMedia);
  const projectInspect = useEngineStore((s) => s.projectInspect);

  // Project inspect may carry clip-level metadata; otherwise we just
  // echo whatever the user picked in the project panel.
  return (
    <PanelFrame title="Reference" automationId="panel.reference">
      <div className="reference-root">
        {selectedMedia === null ? (
          <div className="reference-empty">No selection</div>
        ) : (
          <>
            <div className="reference-canvas-placeholder" aria-hidden="true">
              <span>Reference</span>
            </div>
            <dl className="reference-meta" data-automation-id="panel.reference.meta">
              <dt>name</dt>
              <dd>{selectedMedia.name}</dd>
              <dt>source</dt>
              <dd className="reference-meta-url">{selectedMedia.url}</dd>
              <dt>project</dt>
              <dd>{projectNameFromInspect(projectInspect)}</dd>
            </dl>
          </>
        )}
      </div>
    </PanelFrame>
  );
}

function projectNameFromInspect(p: unknown): string {
  if (p === null || typeof p !== "object") return "—";
  const o = p as Record<string, unknown>;
  if (typeof o.name === "string") return o.name;
  if (typeof o.title === "string") return o.title;
  return "—";
}
