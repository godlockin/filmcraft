/**
 * Export Mode overlay (M3.10).
 *
 * Full-screen panel rendered by `App` when `activeMode === "export"`.
 * Pulls presets via `export.presets.list`; submitting dispatches
 * `file.exportMedia` (or `export.quick` when "Quick" is picked) and
 * polls the queue via `export.queue.list` every 2s. When the engine
 * reports a completed job the existing `getExportInfo` HTTP endpoint
 * returns the `{download.url}` which we surface via a "Download"
 * button (calls `window.open`).
 *
 * Cloud note: the cloud server surfaces the queued export on disk
 * after the engine marks it `Done`; the `getExportInfo` HTTP endpoint
 * then exposes `download.url` exactly as the desktop Quick Export
 * does. No new server endpoints are added in M3.
 */

import { useEffect, useState } from "react";
import PanelFrame from "./PanelFrame";
import { getExportInfo } from "../api";
import { useEngineStore } from "../store";
import "./ExportModePanel.css";

interface ExportPreset {
  name: string;
  format?: string;
}

interface ExportJob {
  id: string;
  status?: string;
  path?: string;
  progress?: number;
  error?: string;
}

interface ExportModePanelProps {
  /** When true, take the full app area; otherwise render as a docked panel. */
  fullScreen?: boolean;
}

export default function ExportModePanel({ fullScreen = false }: ExportModePanelProps) {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const setMode = useEngineStore((s) => s.setMode);

  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [preset, setPreset] = useState<string>("");
  const [format, setFormat] = useState<string>("h264");
  const [width, setWidth] = useState<number>(1920);
  const [height, setHeight] = useState<number>(1080);
  const [fps, setFps] = useState<number>(30);
  const [outputFilename, setOutputFilename] = useState<string>("render.mp4");
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [completedDownloadUrl, setCompletedDownloadUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Fetch preset list on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await runCommand("export.presets.list")) as
          | { presets?: ExportPreset[] }
          | ExportPreset[]
          | undefined;
        if (cancelled) return;
        const list = Array.isArray(r) ? r : (r?.presets ?? []);
        setPresets(list);
        if (list.length > 0 && list[0] !== undefined) setPreset(list[0].name);
      } catch {
        if (!cancelled) setPresets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runCommand]);

  // Poll the queue every 2s while a job is in-flight, faster than the
  // engine's natural push (which doesn't exist in M3).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick(): Promise<void> {
      try {
        const r = (await runCommand("export.queue.list")) as
          | { jobs?: ExportJob[] }
          | ExportJob[]
          | undefined;
        if (cancelled) return;
        const list = Array.isArray(r) ? r : (r?.jobs ?? []);
        setJobs(list);
        // First job we see in `Done` state: resolve the actual download
        // URL via the existing HTTP endpoint.
        const done = list.find(
          (j) => typeof j.status === "string" && j.status.toLowerCase() === "done",
        );
        if (done !== undefined && activeProject !== null) {
          try {
            const info = await getExportInfo(activeProject);
            if (!cancelled && info.ok && info.download?.url !== undefined) {
              setCompletedDownloadUrl(info.download.url);
            }
          } catch {
            /* next tick */
          }
        }
      } catch {
        /* will retry next tick */
      }
      if (!cancelled) timer = setTimeout(tick, 2000);
    }
    if (jobs.length === 0) {
      // Still do one initial fetch to surface any pre-existing jobs.
      void tick();
      return () => {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
      };
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [runCommand, activeProject, jobs.length]);

  async function startExport(): Promise<void> {
    setStarting(true);
    try {
      await runCommand("file.exportMedia", {
        path: outputFilename,
        preset: preset === "" ? undefined : preset,
        format,
        width,
        height,
        fps,
        quality: 80,
      });
    } catch {
      /* surfaced via store.lastError */
    } finally {
      setStarting(false);
    }
  }

  async function startQuick(): Promise<void> {
    setStarting(true);
    try {
      await runCommand("export.quick", {
        path: outputFilename,
      });
    } catch {
      /* surfaced via store.lastError */
    } finally {
      setStarting(false);
    }
  }

  return (
    <PanelFrame title="Export" automationId="panel.exportMode">
      <div className={"export-mode-root" + (fullScreen ? " is-full" : "")}>
        <form
          className="export-mode-form"
          onSubmit={(e) => {
            e.preventDefault();
            void startExport();
          }}
        >
          <label className="export-mode-field">
            <span>Preset</span>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              data-automation-id="panel.exportMode.preset"
            >
              {presets.length === 0 ? (
                <option value="">(no presets)</option>
              ) : null}
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="export-mode-field">
            <span>Format</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              data-automation-id="panel.exportMode.format"
            >
              <option value="h264">H.264 (mp4)</option>
              <option value="hevc">HEVC</option>
              <option value="prores">ProRes</option>
              <option value="dnxhr">DNxHR</option>
              <option value="apv">APV</option>
              <option value="wav">WAV</option>
            </select>
          </label>
          <div className="export-mode-row">
            <label className="export-mode-field">
              <span>Width</span>
              <input
                type="number"
                min={1}
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                data-automation-id="panel.exportMode.width"
              />
            </label>
            <label className="export-mode-field">
              <span>Height</span>
              <input
                type="number"
                min={1}
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                data-automation-id="panel.exportMode.height"
              />
            </label>
            <label className="export-mode-field">
              <span>FPS</span>
              <input
                type="number"
                min={1}
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                data-automation-id="panel.exportMode.fps"
              />
            </label>
          </div>
          <label className="export-mode-field">
            <span>Output filename</span>
            <input
              type="text"
              value={outputFilename}
              onChange={(e) => setOutputFilename(e.target.value)}
              data-automation-id="panel.exportMode.filename"
            />
          </label>
          <div className="export-mode-actions">
            <button
              type="submit"
              className="export-mode-export"
              disabled={starting}
              data-automation-id="panel.exportMode.export"
            >
              Export
            </button>
            <button
              type="button"
              className="export-mode-quick"
              onClick={() => void startQuick()}
              disabled={starting}
              data-automation-id="panel.exportMode.quick"
            >
              Quick Export
            </button>
            {fullScreen ? (
              <button
                type="button"
                className="export-mode-close"
                onClick={() => setMode("edit")}
                data-automation-id="panel.exportMode.close"
              >
                Close
              </button>
            ) : null}
          </div>
        </form>
        {jobs.length > 0 ? (
          <ul className="export-mode-queue" role="list">
            {jobs.map((j) => (
              <li
                key={j.id}
                className="export-mode-job"
                data-automation-id={`panel.exportMode.job.${j.id}`}
              >
                <span className="export-mode-job-id">{j.id}</span>
                <span className="export-mode-job-status">
                  {j.status ?? "pending"}
                </span>
                {typeof j.progress === "number" ? (
                  <span className="export-mode-job-progress">
                    {Math.round(j.progress * 100)}%
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="export-mode-empty">No jobs in queue</div>
        )}
        {completedDownloadUrl !== null ? (
          <a
            href={completedDownloadUrl}
            target="_blank"
            rel="noreferrer"
            className="export-mode-download"
            data-automation-id="panel.exportMode.download"
          >
            Download
          </a>
        ) : null}
      </div>
    </PanelFrame>
  );
}
