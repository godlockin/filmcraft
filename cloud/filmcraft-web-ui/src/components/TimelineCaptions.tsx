/**
 * Caption track overlay (M3.6).
 *
 * Reads `captions.list` and renders coloured caption blocks over the
 * timeline caption row. Caption clip ranges are in ticks (matching
 * `sequence.inspect.duration`).
 */

import { useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import "./TimelineCaptions.css";

interface Caption {
  id: string;
  start: number;
  duration: number;
  text?: string;
  kind?: string;
  color?: string;
}

const CAPTION_ROW_HEIGHT = 22;

export default function TimelineCaptions() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeProject === null) return;
    setLoading(true);
    Promise.all([
      runCommand("captions.list").catch(() => null),
      runCommand("sequence.inspect").catch(() => null),
    ])
      .then(([c, s]) => {
        setCaptions(normalise(c));
        setDuration(extractDuration(s));
      })
      .finally(() => setLoading(false));
  }, [activeProject, runCommand]);

  const blocks = useMemo(() => captions, [captions]);

  return (
    <div
      className="timeline-captions"
      data-automation-id="panel.timeline.captions"
      aria-label="Caption track"
      style={{ height: `${CAPTION_ROW_HEIGHT}px` }}
    >
      {loading ? (
        <div className="timeline-captions-empty">Loading captions…</div>
      ) : duration <= 0 ? (
        <div className="timeline-captions-empty">No sequence</div>
      ) : blocks.length === 0 ? (
        <div className="timeline-captions-empty">No captions</div>
      ) : (
        blocks.map((c) => (
          <div
            key={c.id}
            className="timeline-caption-block"
            style={{
              left: `${(c.start / duration) * 100}%`,
              width: `${Math.max(1, (c.duration / duration) * 100)}%`,
              background: colorFor(c),
            }}
            title={c.text ?? c.id}
            data-automation-id={`panel.timeline.caption.${c.id}`}
          >
            <span className="timeline-caption-text">{c.text ?? c.id}</span>
          </div>
        ))
      )}
    </div>
  );
}

function normalise(v: unknown): Caption[] {
  if (!Array.isArray(v)) return [];
  const out: Caption[] = [];
  for (const c of v) {
    if (c === null || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const idVal = o.id ?? o.caption;
    const id =
      typeof idVal === "number"
        ? String(idVal)
        : typeof idVal === "string"
          ? idVal
          : null;
    if (id === null) continue;
    const start = numberOr(o.start ?? o.in ?? o.time, 0);
    const duration = numberOr(o.duration ?? o.length ?? o.out, 0);
    out.push({
      id,
      start,
      duration,
      text: typeof o.text === "string" ? o.text : undefined,
      kind: typeof o.kind === "string" ? o.kind : undefined,
      color: typeof o.color === "string" ? o.color : undefined,
    });
  }
  return out;
}

function extractDuration(seq: unknown): number {
  if (seq === null || typeof seq !== "object") return 0;
  const r = seq as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(r.duration) || n(r.length) || 0;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function colorFor(c: Caption): string {
  if (c.color !== undefined && c.color !== "") return c.color;
  // Engine-style default: dim translucent block.
  return "rgba(255, 224, 102, 0.55)";
}