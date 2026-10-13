/**
 * Settings panel (M3.11).
 *
 * Reads / writes `prefs.*` keys via `useEngineStore`. The plan defers
 * a richer settings UI (with sections + live search) to a future
 * milestone; for the cloud parity PR we surface a tiny list of common
 * prefs: editor snap, default transition duration, autosave interval
 * (where the engine actually exposes them).
 */

import { useEffect, useState } from "react";
import PanelFrame from "./PanelFrame";
import { useEngineStore } from "../store";
import "./SettingsPanel.css";

/** Common UI prefs round-tripped through `prefs.set` / `prefs.get`. */
const PREF_KEYS = ["ui.snapSeconds", "ui.autosaveSeconds"] as const;

export default function SettingsPanel() {
  const prefs = useEngineStore((s) => s.prefs);
  const setPreference = useEngineStore((s) => s.setPreference);
  const getPreference = useEngineStore((s) => s.getPreference);

  // Hydrate the pref rows on mount.
  useEffect(() => {
    for (const k of PREF_KEYS) {
      if (!(k in prefs)) {
        void getPreference(k);
      }
    }
  }, [prefs, getPreference]);

  return (
    <PanelFrame title="Settings" automationId="panel.settings">
      <div className="settings-root">
        <ul className="settings-list" role="list">
          {PREF_KEYS.map((key) => (
            <SettingRow
              key={key}
              prefKey={key}
              value={prefs[key]}
              onCommit={(v) => setPreference(key, v)}
            />
          ))}
        </ul>
      </div>
    </PanelFrame>
  );
}

interface SettingRowProps {
  prefKey: string;
  value: unknown;
  onCommit: (v: number) => void;
}

function SettingRow({ prefKey, value, onCommit }: SettingRowProps) {
  const [draft, setDraft] = useState<string>(() => (value !== undefined ? String(value) : ""));
  useEffect(() => {
    setDraft(value !== undefined ? String(value) : "");
  }, [value]);
  return (
    <li
      className="settings-row"
      data-automation-id={`panel.settings.row.${prefKey}`}
    >
      <label className="settings-row-label">{prefKey}</label>
      <input
        type="number"
        className="settings-row-input"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onCommit(n);
        }}
        data-automation-id={`panel.settings.input.${prefKey}`}
      />
    </li>
  );
}
