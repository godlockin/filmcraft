/**
 * Essential Graphics panel (M3.7).
 *
 * Lists available motion graphics templates via `graphics.template.list`
 * (optionally filtered by `category` / `source`). Each template card
 * has a button that calls `graphics.template.apply { template }`.
 *
 * No thumbnails: the engine's `graphics.template.list` may return a
 * `thumb` field per template — if it does we use it as the card
 * background; otherwise we render a placeholder coloured block.
 */

import { useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./GraphicsPanel.css";

interface Template {
  id: string;
  name: string;
  category?: string;
  description?: string;
  thumb?: string;
  source?: "builtin" | "user";
}

export default function GraphicsPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);

  useEffect(() => {
    if (activeProject === null) return;
    setLoading(true);
    runCommand("graphics.template.list", {
      ...(query !== "" ? { query } : {}),
      ...(category !== "" ? { category } : {}),
    })
      .then((r) => setTemplates(normalise(r)))
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, [activeProject, runCommand, query, category]);

  const visible = useMemo(() => templates, [templates]);
  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const t of templates) {
      if (t.category !== undefined && t.category !== "") s.add(t.category);
    }
    return Array.from(s).sort();
  }, [templates]);

  async function apply(t: Template) {
    setApplying(t.id);
    try {
      await runCommand("graphics.template.apply", { template: t.id });
    } catch {
      /* surfaced via store.lastError */
    } finally {
      setApplying(null);
    }
  }

  return (
    <PanelFrame title="Essential Graphics" automationId="panel.graphics">
      <div className="graphics-root">
        <div className="graphics-toolbar">
          <input
            type="text"
            className="graphics-search"
            placeholder="Search templates…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-automation-id="panel.graphics.search"
          />
          <select
            className="graphics-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            data-automation-id="panel.graphics.category"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        {loading ? (
          <div className="graphics-empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="graphics-empty">No templates</div>
        ) : (
          <ul className="graphics-grid" role="list">
            {visible.map((t) => (
              <li
                key={t.id}
                className="graphics-card"
                data-automation-id={`panel.graphics.card.${t.id}`}
              >
                <div
                  className="graphics-thumb"
                  style={t.thumb !== undefined ? { backgroundImage: `url(${t.thumb})` } : undefined}
                  aria-label={t.name}
                />
                <div className="graphics-meta">
                  <div className="graphics-name">{t.name}</div>
                  {t.category !== undefined ? (
                    <div className="graphics-cat">{t.category}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="graphics-apply"
                  disabled={applying === t.id}
                  onClick={() => void apply(t)}
                  data-automation-id={`panel.graphics.apply.${t.id}`}
                >
                  {applying === t.id ? "Applying…" : "Apply"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PanelFrame>
  );
}

function normalise(v: unknown): Template[] {
  if (!Array.isArray(v)) {
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.templates)) return normalise(o.templates);
      if (Array.isArray(o.items)) return normalise(o.items);
    }
    return [];
  }
  const out: Template[] = [];
  for (const t of v) {
    if (t === null || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const idVal = o.id ?? o.key ?? o.name;
    const id =
      typeof idVal === "number"
        ? String(idVal)
        : typeof idVal === "string"
          ? idVal
          : null;
    if (id === null) continue;
    const name = typeof o.name === "string" ? o.name : id;
    const thumb =
      typeof o.thumb === "string"
        ? o.thumb
        : typeof o.thumbnail === "string"
          ? o.thumbnail
          : undefined;
    out.push({
      id,
      name,
      category: typeof o.category === "string" ? o.category : undefined,
      description: typeof o.description === "string" ? o.description : undefined,
      thumb,
      source: o.source === "user" || o.source === "builtin" ? o.source : undefined,
    });
  }
  return out;
}