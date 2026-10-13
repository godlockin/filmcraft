/**
 * Trim overlay (M3.6).
 *
 * Double-click a clip on the timeline to enter trim mode; the overlay
 * shows two drag handles (in / out). Releasing dispatches
 * `timeline.trim` with the delta in ticks and the active tool
 * (regular / ripple).
 *
 * Engine command: `timeline.trim { clip, edge: "in"|"out", mode:
 * "regular"|"ripple", delta: ticks }` — see M3 plan §M3.6 Risks §5
 * (the plan called these `trim.setIn` / `trim.setOut`; the actual id
 * is `timeline.trim`).
 */

import { useState } from "react";
import { useEngineStore } from "../store";
import "./TrimOverlay.css";

interface TrimOverlayProps {
  clipId: string;
  inTicks: number;
  outTicks: number;
  duration: number;
  onClose: () => void;
}

type Edge = "in" | "out";

export default function TrimOverlay({
  clipId,
  inTicks,
  outTicks,
  duration,
  onClose,
}: TrimOverlayProps) {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeTool = useEngineStore((s) => s.ui.activeTool);
  const [draftIn, setDraftIn] = useState(inTicks);
  const [draftOut, setDraftOut] = useState(outTicks);

  const deltaIn = draftIn - inTicks;
  const deltaOut = draftOut - outTicks;

  function commit(edge: Edge, delta: number) {
    if (delta === 0) return;
    const mode = activeTool === "ripple" ? "ripple" : "regular";
    void runCommand("timeline.trim", {
      clip: Number.parseInt(clipId, 10),
      edge,
      mode,
      delta,
    }).catch(() => {
      /* surfaced via store.lastError */
    });
  }

  return (
    <div className="trim-overlay" data-automation-id="panel.timeline.trim">
      <div className="trim-overlay-row">
        <label className="trim-label">
          In
          <input
            type="number"
            className="trim-input"
            value={Math.round(draftIn)}
            onChange={(e) =>
              setDraftIn(Number.parseInt(e.target.value, 10) || 0)
            }
            data-automation-id="panel.timeline.trim.in"
          />
        </label>
        <label className="trim-label">
          Out
          <input
            type="number"
            className="trim-input"
            value={Math.round(draftOut)}
            onChange={(e) =>
              setDraftOut(Number.parseInt(e.target.value, 10) || 0)
            }
            data-automation-id="panel.timeline.trim.out"
          />
        </label>
        <button
          type="button"
          className="trim-btn"
          onClick={() => {
            commit("in", deltaIn);
            commit("out", deltaOut);
            onClose();
          }}
          data-automation-id="panel.timeline.trim.commit"
        >
          Apply
        </button>
        <button
          type="button"
          className="trim-btn"
          onClick={onClose}
          data-automation-id="panel.timeline.trim.cancel"
        >
          Cancel
        </button>
      </div>
      <div className="trim-overlay-bars">
        <div
          className="trim-handle trim-handle-in"
          style={{ left: `${(draftIn / duration) * 100}%` }}
          title={`In ${Math.round(draftIn)}`}
        />
        <div
          className="trim-handle trim-handle-out"
          style={{ left: `${(draftOut / duration) * 100}%` }}
          title={`Out ${Math.round(draftOut)}`}
        />
      </div>
    </div>
  );
}