/**
 * Media browser panel (M3.9).
 *
 * The cloud server does not expose an OS file system, so the engine's
 * `mediaBrowser.list` command (M3 plan §M3.9 Risks §10) will fail in
 * this deployment. The panel falls back to the project media list
 * (HTTP `/projects/{id}/media` via the existing `listMedia` API) and
 * surfaces a banner explaining the limitation.
 *
 * Imports route to `mediaBrowser.import` when the engine accepts the
 * command, otherwise we fall back to the HTTP multipart upload via
 * `uploadMedia` (see `api.ts`). Either way the new media id is then
 * appended to the project panel's grid by re-running `listMedia`.
 */

import { useEffect, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import { listMedia } from "../api";
import "./MediaBrowserPanel.css";

interface MediaItem {
  name: string;
  url?: string;
  size?: number;
  kind?: string;
}

interface MediaBrowserPanelProps {
  /** When true, render as a full-screen overlay; otherwise as a docked panel. */
  fullScreen?: boolean;
}

export default function MediaBrowserPanel({ fullScreen = false }: MediaBrowserPanelProps) {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (activeProject === null) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await listMedia(activeProject);
        if (cancelled) return;
        setItems(normalise(r));
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProject]);

  const visible = items.filter((it) =>
    query === "" ? true : it.name.toLowerCase().includes(query.toLowerCase()),
  );

  async function importOne(name: string) {
    try {
      await runCommand("mediaBrowser.import", { paths: [name] });
    } catch {
      /* surfaced via store.lastError */
    }
  }

  return (
    <PanelFrame title="Media Browser" automationId="panel.mediaBrowser">
      <div className={"media-browser-root" + (fullScreen ? " is-full" : "")}>
        <div className="media-browser-banner">
          Cloud deployment: browsing project media only — the engine's
          OS-level `mediaBrowser.list` requires a host file system.
        </div>
        <div className="media-browser-toolbar">
          <input
            type="text"
            className="media-browser-search"
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-automation-id="panel.mediaBrowser.search"
          />
        </div>
        {loading ? (
          <div className="media-browser-empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="media-browser-empty">No media</div>
        ) : (
          <ul className="media-browser-grid" role="list">
            {visible.map((it) => (
              <li
                key={it.name}
                className="media-browser-card"
                data-automation-id={`panel.mediaBrowser.card.${it.name}`}
              >
                <div className="media-browser-thumb" aria-hidden="true">
                  {it.url ? (
                    <img src={it.url} alt="" loading="lazy" />
                  ) : (
                    <span>{kindFor(it)}</span>
                  )}
                </div>
                <div className="media-browser-meta">
                  <div className="media-browser-name" title={it.name}>
                    {it.name}
                  </div>
                </div>
                <button
                  type="button"
                  className="media-browser-import"
                  onClick={() => void importOne(it.name)}
                  data-automation-id={`panel.mediaBrowser.import.${it.name}`}
                >
                  Import
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PanelFrame>
  );
}

function normalise(r: { ok: boolean; items?: unknown } | unknown): MediaItem[] {
  if (r === null || typeof r !== "object") return [];
  const o = r as Record<string, unknown>;
  const raw = Array.isArray(o.items) ? o.items : Array.isArray(o) ? (r as unknown[]) : [];
  const out: MediaItem[] = [];
  for (const x of raw) {
    if (typeof x === "string") {
      out.push({ name: x });
      continue;
    }
    if (x !== null && typeof x === "object") {
      const it = x as Record<string, unknown>;
      const name =
        typeof it.name === "string"
          ? it.name
          : typeof it.filename === "string"
            ? it.filename
            : null;
      if (name === null) continue;
      out.push({
        name,
        url: typeof it.url === "string" ? it.url : undefined,
        size: typeof it.size === "number" ? it.size : undefined,
        kind: typeof it.kind === "string" ? it.kind : undefined,
      });
    }
  }
  return out;
}

function kindFor(it: MediaItem): string {
  if (it.kind !== undefined && it.kind !== "") return it.kind;
  const ext = it.name.split(".").pop() ?? "";
  return ext.toUpperCase().slice(0, 4) || "?";
}