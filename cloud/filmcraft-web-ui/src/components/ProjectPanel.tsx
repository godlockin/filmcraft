/**
 * Project panel (M3.3).
 *
 * Two halves stacked vertically inside the dock's left column:
 *
 *   - Bin tree — top half. Built from `project.inspect`. We
 *     conservatively treat any item with a `kind` of `"bin"` or
 *     `"folder"` as a folder and everything else as a leaf. When
 *     the engine doesn't yet ship that distinction, the bin tree
 *     falls back to a flat "All media" entry.
 *   - Media grid — bottom half. Built from `listMedia(projectId)`
 *     (HTTP, M1.7) so thumbnails load even when the WS bridge isn't
 *     bound yet. Thumbnail URL goes through `streamUrl()` and is
 *     rendered as a `<video muted preload="metadata">` so a fresh
 *     frame from the clip shows immediately.
 *
 * The selected media item is kept in the engine store so other
 * panels (Timeline, Effect Controls) can read it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import { listMedia, streamUrl } from "../api";
import PanelFrame from "./PanelFrame";
import "./ProjectPanel.css";

interface MediaRow {
  name: string;
  url: string;
}

export default function ProjectPanel() {
  const activeProject = useEngineStore((s) => s.activeProject);
  const runCommand = useEngineStore((s) => s.runCommand);
  const lastError = useEngineStore((s) => s.lastError);
  const setSelectedMedia = useEngineStore((s) => s.setSelectedMedia);

  const [bins, setBins] = useState<string[]>([]);
  const [activeBin, setActiveBin] = useState<string>("all");
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const loadMedia = useCallback(async () => {
    if (activeProject === null) return;
    setLoading(true);
    try {
      const resp = await listMedia(activeProject);
      const rows = resp.items.map((name) => ({
        name,
        url: streamUrl(activeProject, name),
      }));
      setMedia(rows);
    } catch (e) {
      // Surface via store; UI text mentions the existing error pill.
      console.error("listMedia failed", e);
    } finally {
      setLoading(false);
    }
  }, [activeProject, setSelectedMedia]);

  // Refresh when the active project changes.
  useEffect(() => {
    setMedia([]);
    setSelectedName(null);
    setActiveBin("all");
    void loadMedia();
  }, [activeProject, loadMedia]);

  // Try to fetch bins from the engine. We treat any error as
  // "engine doesn't expose bins yet" and fall back to a flat list.
  const loadBins = useCallback(async () => {
    if (activeProject === null) {
      setBins([]);
      return;
    }
    try {
      const result = (await runCommand("project.inspect")) as unknown;
      const names = extractBinNames(result);
      setBins(names);
    } catch {
      setBins([]);
    }
  }, [activeProject, runCommand]);

  useEffect(() => {
    void loadBins();
  }, [loadBins]);

  const visibleMedia = useMemo(() => {
    if (activeBin === "all") return media;
    // The engine can't yet scope a media list to a bin, so for M3.3
    // the bin selector is informational. Filtering by a substring on
    // the filename keeps the UI honest about its limitation.
    return media.filter((m) => m.name.startsWith(activeBin));
  }, [media, activeBin]);

  function pick(m: MediaRow) {
    setSelectedName(m.name);
    setSelectedMedia(m);
  }

  return (
    <PanelFrame
      title="Project"
      automationId="panel.project"
      actions={
        <button
          type="button"
          className="panel-mini-btn"
          onClick={() => {
            void loadMedia();
            void loadBins();
          }}
          aria-label="Refresh media"
          data-automation-id="panel.project.refresh"
          disabled={activeProject === null}
        >
          ⟳
        </button>
      }
    >
      <div className="project-panel">
        <div className="project-bins" aria-label="Project bins">
          <div
            className={
              "project-bin-item" + (activeBin === "all" ? " is-active" : "")
            }
            onClick={() => setActiveBin("all")}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setActiveBin("all");
            }}
            role="button"
            tabIndex={0}
            data-automation-id="panel.project.bin.all"
          >
            All media
          </div>
          {bins.map((bin) => (
            <div
              key={bin}
              className={
                "project-bin-item" + (activeBin === bin ? " is-active" : "")
              }
              onClick={() => setActiveBin(bin)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveBin(bin);
              }}
              role="button"
              tabIndex={0}
              data-automation-id={`panel.project.bin.${bin}`}
            >
              {bin}
            </div>
          ))}
          {bins.length === 0 ? (
            <div className="project-bins-empty">(engine has no bin tree)</div>
          ) : null}
        </div>
        <div className="project-media">
          {loading ? (
            <div className="project-media-empty">Loading…</div>
          ) : visibleMedia.length === 0 ? (
            <div className="project-media-empty">
              No media in this bin
              {lastError !== null ? ` — ${lastError}` : ""}
            </div>
          ) : (
            <ul className="project-media-grid" role="listbox">
              {visibleMedia.map((m) => (
                <li
                  key={m.name}
                  role="option"
                  aria-selected={m.name === selectedName}
                  className={
                    "project-media-card" +
                    (m.name === selectedName ? " is-selected" : "")
                  }
                  onClick={() => pick(m)}
                  data-automation-id={`panel.project.media.${m.name}`}
                >
                  <video
                    src={m.url}
                    muted
                    playsInline
                    preload="metadata"
                    className="project-media-thumb"
                  />
                  <div className="project-media-label">{m.name}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

/**
 * Try to read bin names from a `project.inspect` result. The shape
 * isn't stable across milestones, so the function is defensive:
 * anything it doesn't recognise is silently skipped.
 */
function extractBinNames(result: unknown): string[] {
  if (result === null || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const candidates: unknown[] = [];
  for (const key of ["bins", "items", "children"]) {
    if (Array.isArray(r[key])) candidates.push(...(r[key] as unknown[]));
  }
  const out: string[] = [];
  for (const c of candidates) {
    if (typeof c === "string") {
      out.push(c);
      continue;
    }
    if (c !== null && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.name === "string" && (o.kind === "bin" || o.kind === "folder")) {
        out.push(o.name);
      }
    }
  }
  return out;
}
