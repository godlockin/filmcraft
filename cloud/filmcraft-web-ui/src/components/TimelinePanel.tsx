/**
 * Timeline panel (M3.3; M3.6 extends with captions/automation/trim).
 *
 * Reads the active sequence from the engine via `sequence.inspect`
 * (M3 plan §Risks §1 picks this as the canonical timeline query
 * when no dedicated `timeline.read` exists). Refreshes every
 * second — fast enough to follow the playhead during playback,
 * slow enough not to hammer the WS bridge.
 *
 * Layout:
 *
 *   - Toolbar (top) — Selection/Ripple/Razor/Hand (M3.6).
 *   - Track header column (left, fixed 96px) — V1/V2/A1/A2 labels.
 *   - Ruler strip (top of timeline area) — second ticks.
 *   - Track rows (one per track) — clip rectangles + playhead.
 *   - Caption track (below the tracks) — caption blocks (M3.6).
 *   - Automation lane (bottom) — keyframe polylines (M3.6).
 *
 * Double-click a clip to enter trim mode (M3.6). Clip rectangles
 * are positioned absolutely per `(in, out)` so the container can be
 * tiny (M3 plan §6 will add `react-window` virtualisation when > 50
 * visible clips). Click on the ruler seeks via `timeline.move`
 * (the engine has no `playback.seek`; `timeline.move` moves the
 * playhead).
 */

import { useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import TimelineToolbar from "./TimelineToolbar";
import TimelineCaptions from "./TimelineCaptions";
import TimelineAutomation from "./TimelineAutomation";
import TrimOverlay from "./TrimOverlay";
import "./TimelinePanel.css";

interface TimelineClip {
  id: string;
  track: string;
  in: number;
  out: number;
  label?: string;
}

interface TimelineTrack {
  id: string;
  kind: "video" | "audio";
}

interface TimelineState {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  /** Sequence length in ticks. */
  duration: number;
  /** Current playhead in ticks. */
  playhead: number;
}

const PLAYHEAD_POLL_MS = 1000;
const FALLBACK_DURATION = 1000;

function extractTimeline(result: unknown): TimelineState {
  if (result === null || typeof result !== "object") {
    return emptyTimeline();
  }
  const r = result as Record<string, unknown>;
  const tracks = extractTracks(r);
  const clips = extractClips(r);
  const duration = readNumber(r.duration) ?? readNumber(r.length) ?? FALLBACK_DURATION;
  const playhead = readNumber(r.playhead) ?? readNumber(r.cursor) ?? 0;
  return { tracks, clips, duration, playhead };
}

function readNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function extractTracks(r: Record<string, unknown>): TimelineTrack[] {
  const candidates: unknown[] = [];
  for (const key of ["tracks", "videoTracks", "audioTracks"]) {
    if (Array.isArray(r[key])) candidates.push(...(r[key] as unknown[]));
  }
  const out: TimelineTrack[] = [];
  for (const c of candidates) {
    if (typeof c === "string") {
      out.push({ id: c, kind: "video" });
      continue;
    }
    if (c !== null && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const id =
        typeof o.id === "string"
          ? o.id
          : typeof o.name === "string"
            ? o.name
            : null;
      if (id === null) continue;
      const kind: TimelineTrack["kind"] =
        o.kind === "audio" || o.type === "audio" ? "audio" : "video";
      out.push({ id, kind });
    }
  }
  if (out.length === 0) {
    return [
      { id: "V1", kind: "video" },
      { id: "V2", kind: "video" },
      { id: "A1", kind: "audio" },
      { id: "A2", kind: "audio" },
    ];
  }
  return out;
}

function extractClips(r: Record<string, unknown>): TimelineClip[] {
  const candidates: unknown[] = [];
  for (const key of ["clips", "items", "segments"]) {
    if (Array.isArray(r[key])) candidates.push(...(r[key] as unknown[]));
  }
  const out: TimelineClip[] = [];
  for (const c of candidates) {
    if (c === null || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const id =
      typeof o.id === "string"
        ? o.id
        : typeof o.uuid === "string"
          ? o.uuid
          : null;
    if (id === null) continue;
    const track =
      typeof o.track === "string"
        ? o.track
        : typeof o.trackId === "string"
          ? o.trackId
          : "V1";
    const inT = readNumber(o.in) ?? readNumber(o.start) ?? 0;
    const outT = readNumber(o.out) ?? readNumber(o.end) ?? inT;
    out.push({
      id,
      track,
      in: inT,
      out: outT,
      label: typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : undefined,
    });
  }
  return out;
}

function emptyTimeline(): TimelineState {
  return {
    tracks: [
      { id: "V1", kind: "video" },
      { id: "V2", kind: "video" },
      { id: "A1", kind: "audio" },
      { id: "A2", kind: "audio" },
    ],
    clips: [],
    duration: FALLBACK_DURATION,
    playhead: 0,
  };
}

export default function TimelinePanel() {
  const activeProject = useEngineStore((s) => s.activeProject);
  const connectionState = useEngineStore((s) => s.connectionState);
  const runCommand = useEngineStore((s) => s.runCommand);

  const [timeline, setTimeline] = useState<TimelineState>(emptyTimeline);
  const [trimClipId, setTrimClipId] = useState<string | null>(null);

  const reload = async () => {
    if (activeProject === null) return;
    try {
      const result = await runCommand("sequence.inspect");
      setTimeline(extractTimeline(result));
    } catch {
      // Surface via store.lastError; panel just keeps last data.
    }
  };

  // Refresh whenever the user lands on the dock.
  useEffect(() => {
    void reload();
  }, [activeProject]);

  // Polled refresh while the WS is alive; gated on connectionState.
  useEffect(() => {
    if (connectionState !== "open") return;
    const timer = setInterval(() => void reload(), PLAYHEAD_POLL_MS);
    return () => clearInterval(timer);
  }, [connectionState]);

  const playheadPct = useMemo(() => {
    if (timeline.duration <= 0) return 0;
    return Math.min(100, (timeline.playhead / timeline.duration) * 100);
  }, [timeline]);

  function seekByPercent(pct: number) {
    const t = Math.max(0, Math.min(100, pct));
    const ticks = Math.round((timeline.duration * t) / 100);
    void runCommand("timeline.move", { ticks }).catch(() => {
      /* surfaced via store.lastError */
    });
  }

  return (
    <PanelFrame title="Timeline" automationId="panel.timeline">
      <div className="timeline-wrapper">
        <TimelineToolbar />
        <div className="timeline-root" data-automation-id="panel.timeline.root">
          <div className="timeline-track-headers" aria-hidden="true">
            {timeline.tracks.map((tr) => (
              <div key={tr.id} className={`timeline-track-header tl-${tr.kind}`}>
                <span className="timeline-track-id">{tr.id}</span>
                <span className="timeline-track-tools">
                  <button type="button" title="Mute" data-automation-id={`timeline.mute.${tr.id}`}>M</button>
                  <button type="button" title="Solo" data-automation-id={`timeline.solo.${tr.id}`}>S</button>
                  <button type="button" title="Lock" data-automation-id={`timeline.lock.${tr.id}`}>L</button>
                </span>
              </div>
            ))}
          </div>
          <div
            className="timeline-scroll"
            onClick={(ev) => {
              const root = ev.currentTarget;
              const rect = root.getBoundingClientRect();
              const x = ev.clientX - rect.left + root.scrollLeft;
              seekByPercent((x / rect.width) * 100);
            }}
          >
            <div className="timeline-ruler">
              {ticksForTimeline(timeline.duration).map((t, idx) => (
                <div
                  key={idx}
                  className="timeline-tick"
                  style={{ left: `${(t / timeline.duration) * 100}%` }}
                >
                  <span>{formatSeconds(t)}</span>
                </div>
              ))}
            </div>
            <div className="timeline-tracks">
              {timeline.tracks.map((tr) => (
                <div key={tr.id} className={`timeline-track tl-${tr.kind}`}>
                  {timeline.clips
                    .filter((c) => c.track === tr.id)
                    .map((c) => (
                      <div
                        key={c.id}
                        className="timeline-clip"
                        style={{
                          left: `${(c.in / timeline.duration) * 100}%`,
                          width: `${Math.max(1, ((c.out - c.in) / timeline.duration) * 100)}%`,
                        }}
                        title={c.label ?? c.id}
                        onDoubleClick={(ev) => {
                          ev.stopPropagation();
                          setTrimClipId(c.id);
                        }}
                        data-automation-id={`timeline.clip.${c.id}`}
                      >
                        {c.label ?? c.id}
                      </div>
                    ))}
                </div>
              ))}
            </div>
            <div
              className="timeline-playhead"
              style={{ left: `${playheadPct}%` }}
              data-automation-id="timeline.playhead"
            />
            {trimClipId !== null
              ? (() => {
                  const target = timeline.clips.find((c) => c.id === trimClipId);
                  if (target === undefined) return null;
                  return (
                    <TrimOverlay
                      clipId={trimClipId}
                      inTicks={target.in}
                      outTicks={target.out}
                      duration={timeline.duration}
                      onClose={() => setTrimClipId(null)}
                    />
                  );
                })()
              : null}
          </div>
        </div>
        <TimelineCaptions />
        <TimelineAutomation />
      </div>
    </PanelFrame>
  );
}

function ticksForTimeline(duration: number): number[] {
  const seconds = Math.max(1, Math.round(duration));
  const step = seconds <= 10 ? 1 : seconds <= 60 ? 5 : seconds <= 300 ? 30 : 60;
  const out: number[] = [];
  for (let t = 0; t <= seconds; t += step) out.push(t);
  return out;
}

function formatSeconds(t: number): string {
  const total = Math.max(0, Math.floor(t));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}
