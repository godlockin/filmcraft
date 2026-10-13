/**
 * Timecode panel (M3.11).
 *
 * Shows the current playhead position in the four standard
 * non-drop-frame timecode formats (HH:MM:SS:FF, hours, minutes,
 * seconds, frames). Derives the playhead position from
 * `state.inspect`; if the engine reports `playhead` ticks, the panel
 * converts them using the sequence's frame rate (also from
 * `state.inspect`).
 *
 * The cloud server does not expose a dedicated `timecode.read`
 * command (verified against `crates/engine/src/commands.rs`), so
 * the panel falls back to `state.inspect` + `sequence.inspect`
 * exactly as the M3.11 risks allow.
 */

import { useEffect, useState } from "react";
import PanelFrame from "./PanelFrame";
import { useEngineStore } from "./../store";
import "./TimecodePanel.css";

interface TimecodeReading {
  /** Position in ticks (engine internal). */
  playhead: number;
  /** Sequence frame rate in fps, e.g. 30. */
  fps: number;
}

export default function TimecodePanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const timeline = useEngineStore((s) => s.timeline);
  const [reading, setReading] = useState<TimecodeReading | null>(null);

  // Poll `state.inspect` every 500 ms while the panel is mounted.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick(): Promise<void> {
      try {
        const r = (await runCommand("state.inspect")) as
          | { playhead?: number; fps?: number }
          | undefined;
        if (cancelled) return;
        // Prefer `state.inspect`'s own readings; fall back to whatever
        // the timeline slice last observed.
        const fps = readNum(r?.fps) ?? (timeline && timeline.tracks.length > 0 ? 30 : 0);
        const playhead = readNum(r?.playhead) ?? timeline?.playhead ?? 0;
        if (fps > 0 || playhead > 0) setReading({ playhead, fps });
      } catch {
        /* keep last reading */
      }
      if (!cancelled) timer = setTimeout(tick, 500);
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [runCommand, timeline]);

  const formatted = reading !== null ? renderTimecode(reading) : null;

  return (
    <PanelFrame title="Timecode" automationId="panel.timecode">
      <div className="timecode-root">
        {formatted === null ? (
          <div className="timecode-empty">No signal</div>
        ) : (
          <>
            <div className="timecode-primary" data-automation-id="panel.timecode.primary">
              {formatted.hhmmssff}
            </div>
            <div className="timecode-grid">
              <div className="timecode-cell">
                <span className="timecode-cell-label">hours</span>
                <span className="timecode-cell-value" data-automation-id="panel.timecode.hours">
                  {formatted.hours}
                </span>
              </div>
              <div className="timecode-cell">
                <span className="timecode-cell-label">minutes</span>
                <span className="timecode-cell-value">{formatted.minutes}</span>
              </div>
              <div className="timecode-cell">
                <span className="timecode-cell-label">seconds</span>
                <span className="timecode-cell-value">{formatted.seconds}</span>
              </div>
              <div className="timecode-cell">
                <span className="timecode-cell-label">frames</span>
                <span className="timecode-cell-value" data-automation-id="panel.timecode.frames">
                  {formatted.frames}
                </span>
              </div>
            </div>
            <div className="timecode-meta">{reading?.fps ?? 0} fps</div>
          </>
        )}
      </div>
    </PanelFrame>
  );
}

interface FormattedTimecode {
  hhmmssff: string;
  hours: string;
  minutes: string;
  seconds: string;
  frames: string;
}

function renderTimecode(reading: TimecodeReading): FormattedTimecode {
  const fps = reading.fps > 0 ? reading.fps : 30;
  const totalFrames = Math.max(0, Math.round(reading.playhead / (254_016_000_000 / fps)));
  const ff = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  return {
    hhmmssff: `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`,
    hours: pad2(hh),
    minutes: pad2(mm),
    seconds: pad2(ss),
    frames: pad2(ff),
  };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function readNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
