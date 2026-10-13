/**
 * Import mode overlay (M3.9).
 *
 * Full-screen overlay rendered by `App` when the user clicks the
 * Header's "Import" mode tab. Composes the existing media browser
 * panel + a close button that returns the user to the Edit dock.
 */

import { useEngineStore } from "../store";
import MediaBrowserPanel from "./MediaBrowserPanel";
import "./ImportMode.css";

export default function ImportMode() {
  const setMode = useEngineStore((s) => s.setMode);

  return (
    <div className="import-mode" data-automation-id="import.mode">
      <header className="import-mode-header">
        <span className="import-mode-title">Import</span>
        <button
          type="button"
          className="import-mode-close"
          onClick={() => setMode("edit")}
          data-automation-id="import.mode.close"
        >
          Close
        </button>
      </header>
      <MediaBrowserPanel fullScreen />
    </div>
  );
}