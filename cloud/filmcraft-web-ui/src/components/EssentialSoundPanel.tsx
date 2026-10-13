/**
 * Essential Sound panel (M3.7).
 *
 * Reads `essentialSound.inspect` for the current selection and lets
 * the user tag each audio clip with a kind (Dialogue / Music / SFX /
 * Ambient / Atmosphere) via `essentialSound.setType`.
 *
 * Auto-match (loudness detection) routes to
 * `essentialSound.autoMatch`; while the call is in flight we show a
 * spinner. Until the engine returns `essentialSound.inspect` data
 * the panel renders an empty-state.
 */

import { useEffect, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./EssentialSoundPanel.css";

interface SoundEntry {
  id: string;
  name: string;
  kind: "dialogue" | "music" | "sfx" | "ambience" | "atmosphere" | "";
  loudness?: number;
}

const KINDS: SoundEntry["kind"][] = [
  "dialogue",
  "music",
  "sfx",
  "ambience",
  "atmosphere",
];

export default function EssentialSoundPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [items, setItems] = useState<SoundEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingAuto, setPendingAuto] = useState(false);

  const reload = async () => {
    if (activeProject === null) return;
    setLoading(true);
    try {
      const r = await runCommand("essentialSound.inspect");
      setItems(normalise(r));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [activeProject]);

  async function setType(id: string, kind: SoundEntry["kind"]) {
    try {
      await runCommand("essentialSound.setType", {
        clips: [Number.parseInt(id, 10)],
        type: kind === "" ? "" : kind,
      });
      await reload();
    } catch {
      /* surfaced via store.lastError */
    }
  }

  async function autoMatch() {
    setPendingAuto(true);
    try {
      await runCommand("essentialSound.autoMatch");
      await reload();
    } catch {
      /* surfaced via store.lastError */
    } finally {
      setPendingAuto(false);
    }
  }

  return (
    <PanelFrame
      title="Essential Sound"
      automationId="panel.essentialSound"
      actions={
        <button
          type="button"
          className="panel-mini-btn"
          onClick={() => void autoMatch()}
          disabled={pendingAuto}
          data-automation-id="panel.essentialSound.detect"
        >
          {pendingAuto ? "Detecting…" : "Detect"}
        </button>
      }
    >
      {loading ? (
        <div className="essential-sound-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="essential-sound-empty">No audio clips</div>
      ) : (
        <ul className="essential-sound-list" role="list">
          {items.map((it) => (
            <li
              key={it.id}
              className="essential-sound-row"
              data-automation-id={`panel.essentialSound.row.${it.id}`}
            >
              <span className="essential-sound-name">{it.name}</span>
              <select
                className="essential-sound-tag"
                value={it.kind}
                onChange={(e) =>
                  void setType(
                    it.id,
                    e.target.value as SoundEntry["kind"],
                  )
                }
                data-automation-id={`panel.essentialSound.tag.${it.id}`}
              >
                <option value="">— None —</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {labelFor(k)}
                  </option>
                ))}
              </select>
              <span
                className={
                  "essential-sound-pill " +
                  (it.kind === "" ? "is-empty" : `is-${it.kind}`)
                }
              >
                {it.kind === "" ? "untagged" : labelFor(it.kind)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

function labelFor(k: SoundEntry["kind"]): string {
  switch (k) {
    case "dialogue":
      return "Dialogue";
    case "music":
      return "Music";
    case "sfx":
      return "SFX";
    case "ambience":
      return "Ambient";
    case "atmosphere":
      return "Atmosphere";
    case "":
      return "Untagged";
    default:
      return k;
  }
}

function normalise(v: unknown): SoundEntry[] {
  if (!Array.isArray(v)) return [];
  const out: SoundEntry[] = [];
  for (const c of v) {
    if (c === null || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const idVal = o.id ?? o.clip;
    const id =
      typeof idVal === "number"
        ? String(idVal)
        : typeof idVal === "string"
          ? idVal
          : null;
    if (id === null) continue;
    const raw = o.type ?? o.kind;
    const kind = typeof raw === "string" && KINDS.includes(raw as SoundEntry["kind"])
      ? (raw as SoundEntry["kind"])
      : "";
    const name = typeof o.name === "string" ? o.name : `Audio ${id}`;
    const ldn = o.loudness ?? o.loudnessLufs;
    const loudness = typeof ldn === "number" ? ldn : undefined;
    out.push({ id, name, kind, loudness });
  }
  return out;
}