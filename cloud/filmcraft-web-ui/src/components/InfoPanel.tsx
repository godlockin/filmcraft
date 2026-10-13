/**
 * Info panel (M3.11).
 *
 * Read-only diagnostic panel: project metadata (from
 * `project.inspect`) and the current engine session info (from
 * `state.inspect`). Useful for support / debugging.
 */

import { useEffect, useState } from "react";
import PanelFrame from "./PanelFrame";
import { useEngineStore } from "../store";
import "./InfoPanel.css";

type Row = [string, string];

export default function InfoPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const [project, setProject] = useState<unknown>(null);
  const [stateInspect, setStateInspect] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await runCommand("project.inspect");
        if (!cancelled) setProject(p);
      } catch {
        /* keep last value */
      }
    })();
    (async () => {
      try {
        const s = await runCommand("state.inspect");
        if (!cancelled) setStateInspect(s);
      } catch {
        /* keep last value */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runCommand]);

  const projectRows = pairsFromObject(project, 16);
  const stateRows = pairsFromObject(stateInspect, 16);

  return (
    <PanelFrame title="Info" automationId="panel.info">
      <div className="info-root">
        <section className="info-section" aria-label="Project">
          <header className="info-section-header">Project</header>
          <InfoRows rows={projectRows} automation="panel.info.project" />
        </section>
        <section className="info-section" aria-label="Engine state">
          <header className="info-section-header">Engine state</header>
          <InfoRows rows={stateRows} automation="panel.info.state" />
        </section>
      </div>
    </PanelFrame>
  );
}

interface InfoRowsProps {
  rows: Row[];
  automation: string;
}

function InfoRows({ rows, automation }: InfoRowsProps) {
  if (rows.length === 0) {
    return (
      <div className="info-empty" data-automation-id={`${automation}.empty`}>
        No data
      </div>
    );
  }
  return (
    <ul className="info-list" role="list">
      {rows.map(([k, v]) => (
        <li key={k} className="info-row" data-automation-id={`${automation}.${k}`}>
          <span className="info-row-key">{k}</span>
          <span className="info-row-value" title={v}>
            {v}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Flatten an unknown object into `[[key, value]]` pairs for display. */
function pairsFromObject(obj: unknown, maxRows: number): Row[] {
  if (obj === null || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const out: Row[] = [];
  for (const k of Object.keys(o).sort()) {
    if (out.length >= maxRows) break;
    out.push([k, prettyPrint(o[k])]);
  }
  return out;
}

function prettyPrint(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{…}";
  return String(v);
}
