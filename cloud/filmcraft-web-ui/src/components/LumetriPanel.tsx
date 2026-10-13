/**
 * Lumetri panel (M3.5).
 *
 * The engine exposes Lumetri as `lumetri.*` commands (color.rs) plus
 * per-clip "lumetri_color" / "lumetri_curves" effect params in
 * `sequence.inspect`. The cloud panel renders the Basic Correction
 * group and a preset dropdown (Lumetri presets from
 * `lumetri.presets`).
 *
 * Section toggles (Basic / Creative / Curves / Wheels / HSL /
 * Vignette) map to `lumetri.setSection { section, on }`.
 *
 * Preset apply comes from `lumetri.applyPreset { name }`. Per-param
 * mutations are routed through `effects.setParam` (the same surface
 * the Effect Controls panel uses), keeping the engine contract
 * uniform.
 */

import { useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./LumetriPanel.css";

interface Section {
  id: "basic" | "creative" | "curves" | "wheels" | "hsl" | "vignette";
  label: string;
}

const SECTIONS: Section[] = [
  { id: "basic", label: "Basic Correction" },
  { id: "creative", label: "Creative" },
  { id: "curves", label: "Curves" },
  { id: "wheels", label: "Color Wheels" },
  { id: "hsl", label: "HSL Secondary" },
  { id: "vignette", label: "Vignette" },
];

const BASIC_PARAMS = [
  { id: "exposure", label: "Exposure", min: -2, max: 2, step: 0.01 },
  { id: "contrast", label: "Contrast", min: -1, max: 1, step: 0.01 },
  { id: "highlights", label: "Highlights", min: -1, max: 1, step: 0.01 },
  { id: "shadows", label: "Shadows", min: -1, max: 1, step: 0.01 },
  { id: "whites", label: "Whites", min: -1, max: 1, step: 0.01 },
  { id: "blacks", label: "Blacks", min: -1, max: 1, step: 0.01 },
  { id: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01 },
  { id: "tint", label: "Tint", min: -1, max: 1, step: 0.01 },
  { id: "vibrance", label: "Vibrance", min: -1, max: 1, step: 0.01 },
  { id: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01 },
];

interface BasicState {
  values: Record<string, number>;
}

function readBasic(seq: unknown): BasicState {
  if (seq === null || typeof seq !== "object") return { values: {} };
  const r = seq as Record<string, unknown>;
  const tracks = [
    ...(Array.isArray(r.video) ? (r.video as unknown[]) : []),
    ...(Array.isArray(r.audio) ? (r.audio as unknown[]) : []),
  ];
  for (const t of tracks) {
    if (t === null || typeof t !== "object") continue;
    const items = (t as { items?: unknown }).items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (it === null || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const effs = Array.isArray(o.effects) ? o.effects : [];
      for (const e of effs) {
        if (e === null || typeof e !== "object") continue;
        const eo = e as Record<string, unknown>;
        if (eo.effect !== "lumetri_color") continue;
        const pm = eo.params;
        if (pm === null || typeof pm !== "object") continue;
        const values: Record<string, number> = {};
        for (const [k, v] of Object.entries(pm as Record<string, unknown>)) {
          const raw = (v as { value?: unknown })?.value;
          const n =
            typeof raw === "number"
              ? raw
              : typeof raw === "string"
                ? Number.parseFloat(raw)
                : NaN;
          if (Number.isFinite(n)) values[k] = n;
        }
        return { values };
      }
    }
  }
  return { values: {} };
}

function readSelectedId(seq: unknown): string | null {
  if (seq === null || typeof seq !== "object") return null;
  const r = seq as Record<string, unknown>;
  const sel = Array.isArray(r.selection) ? r.selection : [];
  if (sel.length === 0) return null;
  const v = sel[0];
  return typeof v === "number" ? String(v) : typeof v === "string" ? v : null;
}

export default function LumetriPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [seq, setSeq] = useState<unknown>(null);
  const [presets, setPresets] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeProject === null) return;
    setLoading(true);
    Promise.all([
      runCommand("sequence.inspect").catch(() => null),
      runCommand("lumetri.presets").catch(() => null),
    ])
      .then(([s, p]) => {
        setSeq(s);
        setPresets(extractPresets(p));
      })
      .finally(() => setLoading(false));
  }, [activeProject, runCommand]);

  const basic = useMemo(() => readBasic(seq), [seq]);
  const selectedId = useMemo(() => readSelectedId(seq), [seq]);

  function setBasic(param: string, value: number) {
    if (selectedId === null) return;
    void runCommand("effects.setParam", {
      clip: Number.parseInt(selectedId, 10),
      effect: "lumetri_color",
      param,
      value,
    }).catch(() => undefined);
  }

  function toggleSection(section: Section["id"], on: boolean) {
    void runCommand("lumetri.setSection", {
      ...(selectedId !== null ? { clip: Number.parseInt(selectedId, 10) } : {}),
      section,
      on,
    }).catch(() => undefined);
  }

  function applyPreset(name: string) {
    void runCommand("lumetri.applyPreset", {
      name,
      ...(selectedId !== null ? { clips: [Number.parseInt(selectedId, 10)] } : {}),
    }).catch(() => undefined);
  }

  return (
    <PanelFrame title="Lumetri Color" automationId="panel.lumetri">
      {loading ? (
        <div className="lumetri-empty">Loading…</div>
      ) : selectedId === null ? (
        <div className="lumetri-empty">Select a clip</div>
      ) : (
        <div className="lumetri-root">
          <div className="lumetri-presets">
            <label className="lumetri-presets-label">Preset</label>
            <select
              className="lumetri-presets-select"
              defaultValue=""
              data-automation-id="panel.lumetri.preset"
              onChange={(e) => {
                const v = e.target.value;
                if (v !== "") applyPreset(v);
              }}
            >
              <option value="">— Select —</option>
              {presets.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <ul className="lumetri-sections" role="list">
            {SECTIONS.map((s) => (
              <li
                key={s.id}
                className="lumetri-section-toggle"
                data-automation-id={`panel.lumetri.section.${s.id}`}
              >
                <button
                  type="button"
                  className="lumetri-section-btn"
                  onClick={() => toggleSection(s.id, true)}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
          <fieldset className="lumetri-basic">
            <legend className="lumetri-basic-title">Basic Correction</legend>
            <ul className="lumetri-basic-params" role="list">
              {BASIC_PARAMS.map((p) => {
                const v = basic.values[p.id];
                return (
                  <li
                    key={p.id}
                    className="lumetri-basic-param"
                    data-automation-id={`panel.lumetri.basic.${p.id}`}
                  >
                    <label className="lumetri-basic-label">{p.label}</label>
                    <input
                      type="range"
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      value={typeof v === "number" ? v : 0}
                      onChange={(e) =>
                        setBasic(p.id, Number.parseFloat(e.target.value))
                      }
                      className="lumetri-basic-slider"
                    />
                    <span className="lumetri-basic-value">
                      {typeof v === "number" ? v.toFixed(2) : "0.00"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </div>
      )}
    </PanelFrame>
  );
}

function extractPresets(p: unknown): string[] {
  if (p === null || typeof p !== "object") return [];
  const r = p as Record<string, unknown>;
  const candidates = [
    Array.isArray(r.presets) ? r.presets : null,
    Array.isArray(r.items) ? r.items : null,
  ];
  for (const c of candidates) {
    if (c === null) continue;
    const out: string[] = [];
    for (const x of c) {
      if (typeof x === "string") out.push(x);
      else if (x !== null && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const n = typeof o.name === "string" ? o.name : null;
        if (n !== null) out.push(n);
      }
    }
    return out;
  }
  return [];
}