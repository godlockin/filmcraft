/**
 * Markers panel (M3.4).
 *
 * Markers are 1-D timecode anchors attached to a sequence. The
 * cloud panel reads via `markers.list` (currently folded into the
 * engine's `markers.*` namespace — see `crates/engine/src/commands.rs`
 * Risks §2). When `markers.list` is absent we fall back to
 * `sequence.inspect` and pull `markers` out of that result.
 *
 * Refetch strategy: the server keeps a `markers.list` snapshot in
 * the cloud mirror, but the cloud is offline-tolerant and the user
 * can add / delete without us knowing in real time. So we refetch
 * the list after every successful mutation (M3 plan §M3.4).
 */

import { useEffect, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./MarkersPanel.css";

interface Marker {
  id: string;
  name: string;
  in?: number;
  out?: number;
  kind?: string;
}

const FALLBACK_LIST_CMD = "markers.list";

export default function MarkersPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = async () => {
    if (activeProject === null) return;
    setLoading(true);
    try {
      const direct = await runCommand(FALLBACK_LIST_CMD);
      setMarkers(normalise(direct));
    } catch {
      try {
        const seq = await runCommand("sequence.inspect");
        setMarkers(extractMarkersFromSequence(seq));
      } catch {
        setMarkers([]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [activeProject]);

  async function add() {
    try {
      const cursor = await runCommand("playback.position").catch(() => ({
        ticks: 0,
      }));
      const ticks =
        typeof cursor === "object" &&
        cursor !== null &&
        "ticks" in cursor &&
        typeof (cursor as { ticks: unknown }).ticks === "number"
          ? (cursor as { ticks: number }).ticks
          : 0;
      await runCommand("markers.add", { time: ticks, name: `Marker ${markers.length + 1}` });
      await reload();
    } catch {
      /* surfaced via store.lastError */
    }
  }

  async function remove(id: string) {
    try {
      await runCommand("markers.delete", { id });
      await reload();
    } catch {
      /* surfaced via store.lastError */
    }
  }

  function goto(id: string) {
    void runCommand("markers.goto", { id }).catch(() => {
      /* surfaced via store.lastError */
    });
  }

  return (
    <PanelFrame
      title="Markers"
      automationId="panel.markers"
      actions={
        <button
          type="button"
          className="panel-mini-btn"
          onClick={() => void add()}
          aria-label="Add marker"
          data-automation-id="panel.markers.add"
        >
          +
        </button>
      }
    >
      {loading ? (
        <div className="markers-empty">Loading…</div>
      ) : markers.length === 0 ? (
        <div className="markers-empty">No markers</div>
      ) : (
        <ul className="markers-list" role="list">
          {markers.map((m) => (
            <li
              key={m.id}
              className="markers-row"
              data-automation-id={`panel.markers.row.${m.id}`}
            >
              <button
                type="button"
                className="markers-row-name"
                onClick={() => goto(m.id)}
                title="Jump to marker"
              >
                {m.name}
              </button>
              <span className="markers-row-time">
                {fmtTime(m.in)} → {fmtTime(m.out ?? m.in)}
              </span>
              <span className="markers-row-kind">{m.kind ?? ""}</span>
              <button
                type="button"
                className="markers-row-del"
                onClick={() => void remove(m.id)}
                aria-label={`Delete ${m.name}`}
                data-automation-id={`panel.markers.delete.${m.id}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

function fmtTime(v: number | undefined): string {
  if (v === undefined) return "—";
  const total = Math.max(0, Math.floor(v));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

function normalise(v: unknown): Marker[] {
  if (Array.isArray(v)) {
    return v.filter((m): m is Marker =>
      m !== null && typeof m === "object" &&
      typeof (m as { id?: unknown }).id === "string",
    ) as Marker[];
  }
  if (
    v !== null &&
    typeof v === "object" &&
    Array.isArray((v as { markers?: unknown[] }).markers)
  ) {
    return (v as { markers: unknown[] }).markers.filter((m): m is Marker =>
      m !== null && typeof m === "object",
    ) as Marker[];
  }
  return [];
}

function extractMarkersFromSequence(seq: unknown): Marker[] {
  if (seq === null || typeof seq !== "object") return [];
  const r = seq as Record<string, unknown>;
  if (!Array.isArray(r.markers)) return [];
  return r.markers.filter(
    (m): m is Marker =>
      m !== null && typeof m === "object" && typeof (m as { id?: unknown }).id === "string",
  ) as Marker[];
}
