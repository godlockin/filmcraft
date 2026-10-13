/**
 * CSS-Grid dock (M3.3 base; M3.4–M3.7 extend with more regions).
 *
 * Five regions:
 *
 *   - top-left  : Project panel (bin tree + media grid)
 *   - top-center: Monitor panel (Source + Program)
 *   - top-right : Markers + Effects (M3.4); Effect Controls +
 *                 Lumetri + Audio Meters (M3.5)
 *   - bottom    : Timeline panel
 *
 * The right column is a vertical flex stack so the panel set can
 * grow without a grid template refactor.
 */

import { useState } from "react";
import ProjectPanel from "./ProjectPanel";
import TimelinePanel from "./TimelinePanel";
import MonitorPanel from "./MonitorPanel";
import MarkersPanel from "./MarkersPanel";
import EffectsPanel from "./EffectsPanel";
import EffectControlsPanel from "./EffectControlsPanel";
import LumetriPanel from "./LumetriPanel";
import AudioMetersPanel from "./AudioMetersPanel";
import EssentialSoundPanel from "./EssentialSoundPanel";
import GraphicsPanel from "./GraphicsPanel";
import MetadataPanel from "./MetadataPanel";
import HistoryPanel from "./HistoryPanel";
import EventLogPanel from "./EventLogPanel";
import TimecodePanel from "./TimecodePanel";
import SettingsPanel from "./SettingsPanel";
import PresetsPanel from "./PresetsPanel";
import WorkspacesPanel from "./WorkspacesPanel";
import InfoPanel from "./InfoPanel";
import ReferenceMonitorPanel from "./ReferenceMonitorPanel";
import "./Dock.css";

interface DockProps {
  /** Optional timecode string passed through to the monitors. */
  timecode?: string;
}

type SidePanel =
  | "timecode"
  | "settings"
  | "presets"
  | "workspaces"
  | "info"
  | "reference";

const OPTIONAL_PANELS: { id: SidePanel; label: string; automationId: string }[] = [
  { id: "timecode", label: "Timecode", automationId: "panel.timecode" },
  { id: "settings", label: "Settings", automationId: "panel.settings" },
  { id: "presets", label: "Presets", automationId: "panel.presets" },
  { id: "workspaces", label: "Workspaces", automationId: "panel.workspaces" },
  { id: "info", label: "Info", automationId: "panel.info" },
  { id: "reference", label: "Reference", automationId: "panel.reference" },
];

export default function Dock({ timecode }: DockProps) {
  // M3.11: each "side" panel can be toggled into view from the dock's
  // own picker. The default selection is empty (the user opts in).
  const [open, setOpen] = useState<Set<SidePanel>>(new Set());

  function toggle(id: SidePanel): void {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="dock-root" data-automation-id="dock.root">
      <section className="dock-region dock-tl" aria-label="Project">
        <ProjectPanel />
      </section>
      <section className="dock-region dock-tc" aria-label="Monitors">
        <MonitorPanel timecode={timecode} />
      </section>
      <section className="dock-region dock-tr" aria-label="Right panels">
        <div className="dock-stack">
          <MarkersPanel />
          <EffectsPanel />
          <EffectControlsPanel />
          <LumetriPanel />
          <AudioMetersPanel />
          <EssentialSoundPanel />
          <GraphicsPanel />
          <MetadataPanel />
          <HistoryPanel />
          <EventLogPanel />
          {open.has("timecode") ? <TimecodePanel /> : null}
          {open.has("settings") ? <SettingsPanel /> : null}
          {open.has("presets") ? <PresetsPanel /> : null}
          {open.has("workspaces") ? <WorkspacesPanel currentPanels={[]} /> : null}
          {open.has("info") ? <InfoPanel /> : null}
          {open.has("reference") ? <ReferenceMonitorPanel /> : null}
        </div>
      </section>
      <section className="dock-region dock-extra" aria-label="Optional panels">
        <div className="dock-extra-bar">
          {OPTIONAL_PANELS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={
                "dock-extra-btn" + (open.has(p.id) ? " is-on" : "")
              }
              data-automation-id={`dock.toggle.${p.id}`}
              onClick={() => toggle(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>
      <section className="dock-region dock-b" aria-label="Timeline">
        <TimelinePanel />
      </section>
    </div>
  );
}
