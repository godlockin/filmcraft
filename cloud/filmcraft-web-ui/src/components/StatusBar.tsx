/**
 * Status bar (M3.8).
 *
 * 24pt dark strip at the bottom of the dock. Reads:
 *
 *   - `state.inspect` (`runCommand("state.inspect")`) for the
 *     current render / job state, surfaces a coloured pill.
 *   - `perf.stats` (`runCommand("perf.stats")`) for memory / CPU
 *     (best-effort — the engine may not expose these in every
 *     shape).
 *   - the active selection's clip id (via `s.timeline` /
 *     `sequence.inspect`).
 *   - the playhead ticks for a small timecode display.
 */

import { useEffect, useState } from "react";
import { useEngineStore } from "../store";
import "./StatusBar.css";

interface PerfStats {
  memoryMb?: number;
  cpuPct?: number;
}

interface RenderState {
  status: "idle" | "rendering" | "done" | "error";
  job?: string;
}

export default function StatusBar() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const connectionState = useEngineStore((s) => s.connectionState);
  const lastError = useEngineStore((s) => s.lastError);
  const timeline = useEngineStore((s) => s.timeline);
  const activeProject = useEngineStore((s) => s.activeProject);

  const [perf, setPerf] = useState<PerfStats | null>(null);
  const [render, setRender] = useState<RenderState>({ status: "idle" });

  useEffect(() => {
    if (activeProject === null || connectionState !== "open") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [p, s] = await Promise.all([
          runCommand("perf.stats").catch(() => null),
          runCommand("state.inspect").catch(() => null),
        ]);
        if (cancelled) return;
        setPerf(extractPerf(p));
        setRender(extractRender(s));
      } catch {
        /* surfaced via store.lastError */
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activeProject, connectionState, runCommand]);

  const playhead = timeline?.playhead ?? 0;
  const duration = timeline?.duration ?? 0;
  const tc = formatTC(playhead);

  return (
    <footer className="status-bar" data-automation-id="status.bar">
      <div className="status-cluster">
        <RenderPill state={render} />
        <span className="status-text" aria-label="Project">
          {activeProject ?? "(no project)"}
        </span>
      </div>
      <div className="status-cluster status-center">
        <span className="status-text" data-automation-id="status.timecode">
          {tc} / {formatTC(duration)}
        </span>
      </div>
      <div className="status-cluster status-end">
        <span
          className={"status-dot " + connectionClass(connectionState)}
          title={`WS: ${connectionState}`}
          data-automation-id="status.connection"
        />
        {lastError !== null ? (
          <span className="status-error" title={lastError}>
            {truncate(lastError, 60)}
          </span>
        ) : null}
        {perf?.memoryMb !== undefined ? (
          <span className="status-text">
            {perf.memoryMb.toFixed(0)} MB
          </span>
        ) : null}
        {perf?.cpuPct !== undefined ? (
          <span className="status-text">
            {perf.cpuPct.toFixed(0)}% CPU
          </span>
        ) : null}
      </div>
    </footer>
  );
}

function RenderPill({ state }: { state: RenderState }) {
  const cls = `status-render-pill is-${state.status}`;
  const label =
    state.status === "rendering"
      ? `Rendering${state.job !== undefined ? ` (${state.job})` : ""}`
      : state.status === "done"
        ? "Rendered"
        : state.status === "error"
          ? "Render error"
          : "Idle";
  return (
    <span className={cls} data-automation-id="status.render">
      {label}
    </span>
  );
}

function connectionClass(s: string): string {
  if (s === "open") return "is-ok";
  if (s === "connecting") return "is-warn";
  if (s === "fatal") return "is-bad";
  return "is-off";
}

function extractPerf(v: unknown): PerfStats | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const mem =
    typeof o.memoryMb === "number"
      ? o.memoryMb
      : typeof o.memory_mb === "number"
        ? o.memory_mb
        : typeof o.rssMb === "number"
          ? o.rssMb
          : undefined;
  const cpu =
    typeof o.cpuPct === "number"
      ? o.cpuPct
      : typeof o.cpu_pct === "number"
        ? o.cpu_pct
        : typeof o.cpu === "number"
          ? o.cpu
          : undefined;
  return {
    memoryMb: mem,
    cpuPct: cpu,
  };
}

function extractRender(v: unknown): RenderState {
  if (v === null || typeof v !== "object") return { status: "idle" };
  const o = v as Record<string, unknown>;
  if (typeof o.rendering === "boolean") {
    return o.rendering
      ? { status: "rendering", job: typeof o.job === "string" ? o.job : undefined }
      : { status: "idle" };
  }
  const r = typeof o.render === "object" && o.render !== null ? (o.render as Record<string, unknown>) : null;
  if (r === null) return { status: "idle" };
  const status = r.status;
  if (status === "rendering" || status === "done" || status === "error") {
    return {
      status,
      job: typeof r.job === "string" ? r.job : undefined,
    };
  }
  return { status: "idle" };
}

function formatTC(ticks: number): string {
  const total = Math.max(0, Math.floor(ticks));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}