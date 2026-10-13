/**
 * Premiere-style dark header (M3.2).
 *
 * 38px tall, three regions: left (brand + workspace pill), centre
 * (mode tabs), right (transport controls + connection badge). Each
 * surface is wired to the matching slice / store action:
 *
 *   - Brand + workspace pill — informational.
 *   - Mode tabs — `uiSlice.activeMode` + `uiSlice.setMode`.
 *   - Transport — see `TransportControls`.
 *   - Connection badge — `connectionState` from the engine store.
 *
 * The mode tabs reflect the M3 plan's three top-level workspaces;
 * later milestones route the app body off `activeMode`.
 */

import { useRef } from "react";
import { useEngineStore } from "../store";
import TransportControls from "./TransportControls";
import QuickExportPopup from "./QuickExportPopup";
import ShortcutsDialog from "./ShortcutsDialog";
import "./Header.css";

type Mode = "import" | "edit" | "export";

interface ModeDef {
  id: Mode;
  label: string;
  automationId: string;
}

const MODES: ModeDef[] = [
  { id: "import", label: "Import", automationId: "header.mode.import" },
  { id: "edit", label: "Edit", automationId: "header.mode.edit" },
  { id: "export", label: "Export", automationId: "header.mode.export" },
];

interface HeaderProps {
  /** Called when the user clicks the "Projects" button (M3.3). */
  onOpenProjects?: () => void;
}

export default function Header({ onOpenProjects }: HeaderProps = {}) {
  const activeMode = useEngineStore((s) => s.ui.activeMode);
  const setMode = useEngineStore((s) => s.setMode);
  const activeProject = useEngineStore((s) => s.activeProject);
  const connectionState = useEngineStore((s) => s.connectionState);
  const auth = useEngineStore((s) => s.auth);
  const quickExportOpen = useEngineStore((s) => s.ui.quickExportOpen);
  const setQuickExportOpen = useEngineStore((s) => s.setQuickExportOpen);
  const shortcutsOpen = useEngineStore((s) => s.ui.shortcutsOpen);
  const setShortcutsOpen = useEngineStore((s) => s.setShortcutsOpen);
  const quickExportBtn = useRef<HTMLButtonElement | null>(null);

  return (
    <header className="app-header" role="banner">
      <div className="app-header-left">
        <span className="app-brand">FilmCraft</span>
        <button
          type="button"
          className="app-workspace app-workspace-button"
          onClick={() => onOpenProjects?.()}
          data-automation-id="header.projects"
          title="Open project list"
        >
          {activeProject ?? "no project"}
        </button>
      </div>
      <nav className="app-header-modes" role="tablist">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            className={
              "app-mode-tab" + (m.id === activeMode ? " is-active" : "")
            }
            aria-selected={m.id === activeMode}
            onClick={() => setMode(m.id)}
            data-automation-id={m.automationId}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <div className="app-header-right">
        <TransportControls />
        <button
          ref={quickExportBtn}
          type="button"
          className="app-quick-export"
          onClick={() => setQuickExportOpen(!quickExportOpen)}
          data-automation-id="header.quickExport"
          title="Quick Export"
        >
          Quick Export
        </button>
        {quickExportOpen ? (
          <QuickExportPopup
            anchor={quickExportBtn.current}
            onClose={() => setQuickExportOpen(false)}
          />
        ) : null}
        <button
          type="button"
          className="app-window-menu"
          onClick={() => setShortcutsOpen(true)}
          data-automation-id="header.shortcuts"
          title="Keyboard Shortcuts"
        >
          Window
        </button>
        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <span
          className={`conn-badge conn-${connectionState}`}
          data-automation-id="header.connection"
          aria-label={`Connection: ${connectionState}`}
        >
          {connectionState}
        </span>
        {auth !== null ? (
          <span
            className="app-user"
            aria-label={`Signed in as ${auth.userId}`}
            title={auth.role}
          >
            {auth.userId}
          </span>
        ) : null}
      </div>
    </header>
  );
}
