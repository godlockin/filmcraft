/**
 * Effects panel (M3.4).
 *
 * Two columns: a folder tree on the left (Video / Audio /
 * Transitions) and an effect list on the right. Search filters
 * substring match the visible items.
 *
 * Source of truth is `runCommand("effects.list", { kind })`. The
 * engine shape isn't stable across milestones so we read each
 * candidate key (`items`, `effects`, `categories`) defensively.
 */

import { useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./EffectsPanel.css";

type Kind = "Video" | "Audio" | "Transitions";

interface EffectRow {
  id: string;
  label: string;
  kind: Kind;
}

const KIND_DEFS: { id: Kind; label: string }[] = [
  { id: "Video", label: "Video" },
  { id: "Audio", label: "Audio" },
  { id: "Transitions", label: "Transitions" },
];

export default function EffectsPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);

  const [activeKind, setActiveKind] = useState<Kind>("Video");
  const [effects, setEffects] = useState<EffectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (activeProject === null) return;
    setLoading(true);
    runCommand("effects.list", { kind: activeKind })
      .then((result) => {
        setEffects(normalise(result, activeKind));
      })
      .catch(() => setEffects([]))
      .finally(() => setLoading(false));
  }, [activeKind, activeProject, runCommand]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return effects;
    return effects.filter(
      (e) => e.label.toLowerCase().includes(q) || e.id.toLowerCase().includes(q),
    );
  }, [effects, query]);

  return (
    <PanelFrame title="Effects" automationId="panel.effects">
      <div className="effects-root">
        <ul className="effects-folders" role="tablist">
          {KIND_DEFS.map((k) => (
            <li
              key={k.id}
              className={
                "effects-folder" + (activeKind === k.id ? " is-active" : "")
              }
              onClick={() => setActiveKind(k.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveKind(k.id);
              }}
              role="tab"
              tabIndex={0}
              data-automation-id={`panel.effects.folder.${k.id}`}
            >
              {k.label}
            </li>
          ))}
        </ul>
        <div className="effects-list-col">
          <input
            type="text"
            className="effects-search"
            placeholder={`Search ${activeKind}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-automation-id="panel.effects.search"
          />
          {loading ? (
            <div className="effects-empty">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="effects-empty">(no {activeKind.toLowerCase()} effects)</div>
          ) : (
            <ul className="effects-items">
              {visible.map((e) => (
                <li
                  key={e.id}
                  className="effects-item"
                  data-automation-id={`panel.effects.item.${e.id}`}
                >
                  {e.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

function normalise(result: unknown, kind: Kind): EffectRow[] {
  if (result === null || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const candidates = (
    Array.isArray(r.items)
      ? r.items
      : Array.isArray(r.effects)
        ? r.effects
        : []
  ) as unknown[];
  const out: EffectRow[] = [];
  for (const c of candidates) {
    if (typeof c === "string") {
      out.push({ id: c, label: c, kind });
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
      const label =
        typeof o.label === "string"
          ? o.label
          : typeof o.name === "string"
            ? o.name
            : id;
      out.push({ id, label, kind });
    }
  }
  return out;
}
