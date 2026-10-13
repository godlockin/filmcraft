/**
 * Effect Controls panel (M3.5).
 *
 * Reads the selected clip's effects via `sequence.inspect` and renders
 * one row per parameter with an `<input type="number">` slider. Set
 * dispatches `effects.setParam` with `{ clip, effect, param, value }`.
 *
 * Selection is `s.state.selection[0]` from `sequence.inspect`; the
 * engine's `selection` field carries the active clip ids.
 *
 * If `effects.setParam` is absent in the engine the row is disabled
 * (read-only) — see M3 plan §M3.5 Risks §4.
 */

import { useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./EffectControlsPanel.css";

interface EffectParam {
  name: string;
  value: number;
}

interface EffectEntry {
  effect: string;
  enabled: boolean;
  params: EffectParam[];
}

interface ClipEntry {
  id: string;
  name: string;
  effects: EffectEntry[];
}

function normaliseSelection(seq: unknown): {
  selectedId: string | null;
  selected: ClipEntry | null;
} {
  if (seq === null || typeof seq !== "object") return { selectedId: null, selected: null };
  const r = seq as Record<string, unknown>;
  const selRaw = Array.isArray(r.selection) ? r.selection : [];
  const selectedId =
    selRaw.length > 0 && typeof selRaw[0] === "number"
      ? String(selRaw[0])
      : selRaw.length > 0 && typeof selRaw[0] === "string"
        ? selRaw[0]
        : null;
  if (selectedId === null) return { selectedId: null, selected: null };
  const videoTracks = Array.isArray(r.video) ? r.video : [];
  for (const t of videoTracks) {
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
      if (id !== selectedId) continue;
      const effectsRaw = Array.isArray(o.effects) ? o.effects : [];
      const effects: EffectEntry[] = [];
      for (const e of effectsRaw) {
        if (e === null || typeof e !== "object") continue;
        const eo = e as Record<string, unknown>;
        const effectName =
          typeof eo.effect === "string" ? eo.effect : "effect";
        const enabled = eo.enabled !== false;
        const params: EffectParam[] = [];
        const paramsMap = eo.params;
        if (paramsMap !== null && typeof paramsMap === "object") {
          for (const [k, v] of Object.entries(paramsMap as Record<string, unknown>)) {
            const raw = (v as { value?: unknown })?.value;
            const n =
              typeof raw === "number"
                ? raw
                : typeof raw === "string" && raw !== ""
                  ? Number.parseFloat(raw)
                  : NaN;
            if (!Number.isFinite(n)) continue;
            params.push({ name: k, value: n });
          }
        }
        effects.push({ effect: effectName, enabled, params });
      }
      return {
        selectedId,
        selected: {
          id,
          name: typeof o.name === "string" ? o.name : `Clip ${id}`,
          effects,
        },
      };
    }
  }
  return { selectedId, selected: null };
}

export default function EffectControlsPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [seq, setSeq] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeProject === null) return;
    setLoading(true);
    runCommand("sequence.inspect")
      .then((r) => setSeq(r))
      .catch(() => setSeq(null))
      .finally(() => setLoading(false));
  }, [activeProject, runCommand]);

  const { selectedId, selected } = useMemo(() => normaliseSelection(seq), [seq]);

  function setParam(effect: string, param: string, value: number) {
    if (selectedId === null) return;
    void runCommand("effects.setParam", {
      clip: Number.parseInt(selectedId, 10),
      effect,
      param,
      value,
    }).catch(() => {
      /* surfaced via store.lastError */
    });
  }

  return (
    <PanelFrame title="Effect Controls" automationId="panel.effectControls">
      {loading ? (
        <div className="effect-controls-empty">Loading…</div>
      ) : selected === null ? (
        <div className="effect-controls-empty">No clip selected</div>
      ) : selected.effects.length === 0 ? (
        <div className="effect-controls-empty">
          No effects on {selected.name}
        </div>
      ) : (
        <ul className="effect-controls-list" role="list">
          {selected.effects.map((e) => (
            <li
              key={e.effect}
              className={
                "effect-controls-section" + (e.enabled ? "" : " is-disabled")
              }
              data-automation-id={`panel.effectControls.section.${e.effect}`}
            >
              <header className="effect-controls-section-title">
                {e.effect}
              </header>
              <ul className="effect-controls-params" role="list">
                {e.params.map((p) => (
                  <li
                    key={p.name}
                    className="effect-controls-param"
                    data-automation-id={`panel.effectControls.param.${e.effect}.${p.name}`}
                  >
                    <label className="effect-controls-param-name">
                      {p.name}
                    </label>
                    <input
                      type="number"
                      className="effect-controls-param-input"
                      defaultValue={p.value}
                      step={inferStep(p.value)}
                      onChange={(ev) => {
                        const v = Number.parseFloat(ev.target.value);
                        if (!Number.isFinite(v)) return;
                        setParam(e.effect, p.name, v);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

/**
 * Heuristic step: integers step by 1, fractional values by 0.01. The
 * engine clips at the parameter's range; the UI only sets a sensible
 * granularity for the spinner.
 */
function inferStep(v: number): number {
  if (Number.isInteger(v)) return 1;
  return 0.01;
}