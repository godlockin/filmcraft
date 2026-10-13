/**
 * Source / Program monitor panel (M3.3 placeholder, M3.5 adds frames).
 *
 * Right now the monitor is two stacked black rectangles with a
 * timecode overlay. The real frame delivery engine (M5.x) will swap
 * the `<canvas>` placeholder for one whose `2d.putImageData()` is
 * driven by a `render.frame` reply (see Risks §3 of the M3 plan).
 *
 * The Source / Program labels in the title bar are independent
 * buttons that flip a small piece of UI state in the store so other
 * panels (e.g. playback routing) can read which monitor is in focus.
 */

import { useState } from "react";
import PanelFrame from "./PanelFrame";
import "./MonitorPanel.css";

type MonitorKind = "source" | "program";

interface MonitorProps {
  /** What this monitor is showing. */
  kind: MonitorKind;
  /** Timecode string for the overlay. `null` hides the overlay. */
  timecode?: string | null;
  /** Whether this monitor is currently focused. */
  focused?: boolean;
}

function Monitor({ kind, timecode, focused }: MonitorProps) {
  return (
    <section
      className={"monitor" + (focused === true ? " is-focused" : "")}
      data-automation-id={`panel.monitor.${kind}`}
      aria-label={`${kind} monitor`}
    >
      <canvas
        className="monitor-canvas"
        width={640}
        height={360}
        aria-hidden="true"
      />
      <div className="monitor-timecode">
        {timecode ?? "--:--:--:--"}
      </div>
      <div className="monitor-kind">{kind === "source" ? "Source" : "Program"}</div>
    </section>
  );
}

interface MonitorPanelProps {
  /** Optional override for the timecode shown on both monitors. */
  timecode?: string;
}

export default function MonitorPanel({ timecode }: MonitorPanelProps) {
  const [focused, setFocused] = useState<MonitorKind>("program");
  return (
    <PanelFrame
      title="Monitors"
      automationId="panel.monitors"
      actions={
        <div className="monitor-tabs">
          <button
            type="button"
            className={"monitor-tab" + (focused === "source" ? " is-active" : "")}
            onClick={() => setFocused("source")}
            data-automation-id="panel.monitors.source"
          >
            Source
          </button>
          <button
            type="button"
            className={"monitor-tab" + (focused === "program" ? " is-active" : "")}
            onClick={() => setFocused("program")}
            data-automation-id="panel.monitors.program"
          >
            Program
          </button>
        </div>
      }
    >
      <div className="monitor-stack">
        <Monitor kind="source" timecode={timecode} focused={focused === "source"} />
        <Monitor kind="program" timecode={timecode} focused={focused === "program"} />
      </div>
    </PanelFrame>
  );
}
