/**
 * Presets panel (M3.11).
 *
 * Lists built-in + user export presets. The engine exposes
 * `export.presets.list` (and `export.presets.{get,save,delete,
 * favorite,import,export}` for the desktop UI). The cloud UI in M3.11
 * is read-only: list + apply (via `file.exportMedia`'s `preset`
 * parameter — see ExportModePanel).
 *
 * Applied presets are echoed to the active project's last-used-preset
 * preference key so the next `export.quick` reuses it.
 */

import { useEffect, useState } from "react";
import PanelFrame from "./PanelFrame";
import { useEngineStore } from "../store";
import "./PresetsPanel.css";

interface Preset {
  name: string;
  format?: string;
  favorite?: boolean;
}

const FAV_KEY = "ui.lastExportPreset";

export default function PresetsPanel() {
  const runCommand = useEngineStore((s) => s.runCommand);
  const setPreference = useEngineStore((s) => s.setPreference);
  const [presets, setPresets] = useState<Preset[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await runCommand("export.presets.list")) as
          | { presets?: Preset[] }
          | Preset[]
          | undefined;
        if (cancelled) return;
        const list = Array.isArray(r) ? r : (r?.presets ?? []);
        setPresets(list);
      } catch {
        if (!cancelled) setPresets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runCommand]);

  async function applyPreset(p: Preset): Promise<void> {
    await setPreference(FAV_KEY, p.name);
    try {
      await runCommand("export.presets.get", { name: p.name });
    } catch {
      /* pre-flight probe; the next actual export.start uses it */
    }
  }

  return (
    <PanelFrame title="Presets" automationId="panel.presets">
      <div className="presets-root">
        {presets.length === 0 ? (
          <div className="presets-empty">No presets</div>
        ) : (
          <ul className="presets-list" role="list">
            {presets.map((p) => (
              <li
                key={p.name}
                className="presets-row"
                data-automation-id={`panel.presets.row.${p.name}`}
              >
                <span className="presets-name">{p.name}</span>
                {p.format !== undefined ? (
                  <span className="presets-format">{p.format}</span>
                ) : null}
                <button
                  type="button"
                  className="presets-apply"
                  onClick={() => void applyPreset(p)}
                  data-automation-id={`panel.presets.apply.${p.name}`}
                >
                  Apply
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PanelFrame>
  );
}
