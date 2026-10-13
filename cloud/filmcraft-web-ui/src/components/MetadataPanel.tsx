/**
 * Metadata panel (M3.7).
 *
 * Reads `project.inspect` and renders the active project's
 * metadata as a key/value list (name, format, resolution, frame
 * rate, duration, file size, creation date, etc.). When a media
 * item is selected (`s.selectedMedia`) the panel switches to that
 * item's metadata via the existing `/projects/{id}/media` API
 * (`listMedia`) and the same key/value shape.
 */

import { useEffect, useMemo, useState } from "react";
import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./MetadataPanel.css";

interface Field {
  key: string;
  value: string;
}

interface MetadataSource {
  title: string;
  fields: Field[];
}

export default function MetadataPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const activeProject = useEngineStore((s) => s.activeProject);
  const selectedMedia = useEngineStore((s) => s.selectedMedia);
  const [data, setData] = useState<MetadataSource | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeProject === null) return;
    setLoading(true);
    runCommand("project.inspect")
      .then((r) => setData(extractProject(r)))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [activeProject, runCommand]);

  const mediaFields = useMemo(() => {
    if (selectedMedia === null) return null;
    return [
      { key: "Name", value: selectedMedia.name },
      { key: "Source", value: "Project media" },
      { key: "Stream URL", value: selectedMedia.url },
    ];
  }, [selectedMedia]);

  return (
    <PanelFrame title="Metadata" automationId="panel.metadata">
      {loading ? (
        <div className="metadata-empty">Loading…</div>
      ) : data === null && mediaFields === null ? (
        <div className="metadata-empty">No metadata</div>
      ) : (
        <div className="metadata-sections">
          {data !== null ? (
            <section className="metadata-section">
              <header className="metadata-section-title">{data.title}</header>
              <FieldList fields={data.fields} />
            </section>
          ) : null}
          {mediaFields !== null ? (
            <section className="metadata-section">
              <header className="metadata-section-title">Selected Media</header>
              <FieldList fields={mediaFields} />
            </section>
          ) : null}
        </div>
      )}
    </PanelFrame>
  );
}

function FieldList({ fields }: { fields: Field[] }) {
  return (
    <ul className="metadata-list" role="list">
      {fields.map((f) => (
        <li
          key={f.key}
          className="metadata-row"
          data-automation-id={`panel.metadata.row.${slug(f.key)}`}
        >
          <span className="metadata-key">{f.key}</span>
          <span className="metadata-value">{f.value}</span>
        </li>
      ))}
    </ul>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function extractProject(r: unknown): MetadataSource | null {
  if (r === null || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const name =
    typeof o.name === "string"
      ? o.name
      : typeof o.title === "string"
        ? o.title
        : "Project";
  const fields: Field[] = [];
  if (typeof o.name === "string") fields.push({ key: "Name", value: o.name });
  if (typeof o.format === "string") fields.push({ key: "Format", value: o.format });
  if (typeof o.width === "number" && typeof o.height === "number")
    fields.push({
      key: "Resolution",
      value: `${o.width}×${o.height}`,
    });
  if (typeof o.frameRate === "number" || typeof o.fps === "number") {
    fields.push({
      key: "Frame rate",
      value: String(o.frameRate ?? o.fps),
    });
  }
  if (typeof o.duration === "number")
    fields.push({ key: "Duration", value: formatDuration(o.duration) });
  if (typeof o.path === "string")
    fields.push({ key: "Path", value: o.path });
  if (typeof o.createdAt === "string")
    fields.push({ key: "Created", value: o.createdAt });
  if (typeof o.modifiedAt === "string")
    fields.push({ key: "Modified", value: o.modifiedAt });
  if (typeof o.schema === "number")
    fields.push({ key: "Schema", value: `v${o.schema}` });
  return { title: name, fields };
}

function formatDuration(ticks: number): string {
  // Cloud uses seconds for the metadata panel; the engine typically
  // exposes duration in ticks (filmcraft_time::TICK = 254_016_000_000/s)
  // but `project.inspect` already returns seconds in some shapes.
  // We treat the value as seconds if it is reasonable (< 1e6) and as
  // ticks otherwise.
  const seconds =
    ticks > 1e6 ? Math.round(ticks / 254_016_000_000) : Math.round(ticks);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}