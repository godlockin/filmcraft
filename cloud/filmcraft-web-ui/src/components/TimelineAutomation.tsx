/**
 * Automation lane overlay (M3.6).
 *
 * The engine has no dedicated `automation.read` command in this
 * milestone (see M3 plan §M3.6 Risks §5). Keyframe data is returned
 * inline in `sequence.inspect` (per `effects[i].params[k].keyframes`),
 * so we render an envelope from those keyframes for the selected
 * clip's first param (volume/pan as a 0..1 line). If no keyframes are
 * present we render a flat centre line.
 */

import { useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import "./TimelineAutomation.css";

interface Keyframe {
  time: number;
  value: number;
}

interface ParamData {
  values: number[];
  keyframes: Keyframe[];
}

interface ClipData {
  id: string;
  effect: string;
  param: string;
  data: ParamData;
}

const AUTOMATION_ROW_HEIGHT = 36;

export default function TimelineAutomation() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [clips, setClips] = useState<ClipData[]>();
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (activeProject === null) return;
    runCommand("sequence.inspect")
      .then((seq) => {
        const { clips, duration } = extract(seq);
        setClips(clips);
        setDuration(duration);
      })
      .catch(() => {
        setClips([]);
        setDuration(0);
      });
  }, [activeProject, runCommand]);

  const lines = useMemo(() => buildLines(clips, duration), [clips, duration]);

  return (
    <div
      className="timeline-automation"
      data-automation-id="panel.timeline.automation"
      aria-label="Automation lane"
      style={{ height: `${AUTOMATION_ROW_HEIGHT}px` }}
    >
      {lines.length === 0 ? (
        <div className="timeline-automation-empty">
          No automation keyframes on selected clip
        </div>
      ) : (
        <svg
          className="timeline-automation-svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {lines.map((l, i) => (
            <polyline
              key={i}
              className="timeline-automation-line"
              points={l}
              fill="none"
            />
          ))}
        </svg>
      )}
    </div>
  );
}

function extract(seq: unknown): { clips: ClipData[]; duration: number } {
  if (seq === null || typeof seq !== "object") return { clips: [], duration: 0 };
  const r = seq as Record<string, unknown>;
  const dur =
    typeof r.duration === "number"
      ? r.duration
      : typeof r.length === "number"
        ? r.length
        : 0;
  const sel = Array.isArray(r.selection) ? r.selection : [];
  const targetId =
    sel.length > 0
      ? typeof sel[0] === "number"
        ? String(sel[0])
        : typeof sel[0] === "string"
          ? sel[0]
          : null
      : null;
  const tracks = Array.isArray(r.video)
    ? (r.video as unknown[])
    : Array.isArray(r.audio)
      ? (r.audio as unknown[])
      : [];
  for (const t of tracks) {
    if (t === null || typeof t !== "object") continue;
    const items = (t as { items?: unknown }).items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (it === null || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const idVal = o.clip;
      const id =
        typeof idVal === "number"
          ? String(idVal)
          : typeof idVal === "string"
            ? idVal
            : null;
      if (id === null) continue;
      if (targetId !== null && id !== targetId) continue;
      const effs = Array.isArray(o.effects) ? o.effects : [];
      const out: ClipData[] = [];
      for (const e of effs) {
        if (e === null || typeof e !== "object") continue;
        const eo = e as Record<string, unknown>;
        const params = eo.params;
        if (params === null || typeof params !== "object") continue;
        for (const [pname, pv] of Object.entries(params as Record<string, unknown>)) {
          const pd = parseParam(pv);
          if (pd === null) continue;
          out.push({
            id,
            effect: typeof eo.effect === "string" ? eo.effect : "effect",
            param: pname,
            data: pd,
          });
        }
      }
      return { clips: out, duration: dur };
    }
  }
  return { clips: [], duration: dur };
}

function parseParam(v: unknown): ParamData | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const rawVal = o.value;
  const numeric =
    typeof rawVal === "number"
      ? rawVal
      : typeof rawVal === "string" && rawVal !== ""
        ? Number.parseFloat(rawVal)
        : NaN;
  const values: number[] = Number.isFinite(numeric) ? [numeric] : [];
  const kfs: Keyframe[] = [];
  if (Array.isArray(o.keyframes)) {
    for (const k of o.keyframes) {
      if (k === null || typeof k !== "object") continue;
      const ko = k as Record<string, unknown>;
      const t = typeof ko.time === "number" ? ko.time : 0;
      const vv =
        typeof ko.value === "number"
          ? ko.value
          : typeof ko.value === "string"
            ? Number.parseFloat(ko.value)
            : NaN;
      if (!Number.isFinite(vv)) continue;
      kfs.push({ time: t, value: vv });
    }
  }
  return { values, keyframes: kfs };
}

function buildLines(clips: ClipData[] | undefined, duration: number): string[] {
  if (clips === undefined || duration <= 0) return [];
  const lines: string[] = [];
  for (const c of clips) {
    const points: [number, number][] = [];
    if (c.data.keyframes.length > 0) {
      for (const kf of c.data.keyframes) {
        points.push([(kf.time / duration) * 100, normalise(kf.value) * 100]);
      }
    } else {
      const v = c.data.values[0];
      if (typeof v === "number") points.push([0, normalise(v) * 100]);
      points.push([100, normalise(v) * 100]);
    }
    lines.push(points.map(([x, y]) => `${x},${y}`).join(" "));
  }
  return lines;
}

/**
 * Map a parameter value into 0..1. Many parameters live in -1..1
 * (volume in dB, pan, etc.). We map -1 → 0, 0 → 0.5, 1 → 1, then
 * clamp.
 */
function normalise(v: number): number {
  const x = (v + 1) / 2;
  return Math.max(0, Math.min(1, x));
}