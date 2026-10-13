/**
 * Quick Export popup (M3.10).
 *
 * Anchored to the Header's "Quick Export" button when active. Calls
 * `export.quick` with the chosen output filename. The popup is
 * closed by clicking outside, by Escape, or by clicking its own
 * Close button.
 */

import { useEffect, useRef, useState } from "react";
import { useEngineStore } from "../store";
import "./QuickExportPopup.css";

interface QuickExportPopupProps {
  /** Element the popup anchors to (the Quick Export button). */
  anchor: HTMLElement | null;
  /** Called when the popup requests closure. */
  onClose: () => void;
}

export default function QuickExportPopup({ anchor, onClose }: QuickExportPopupProps) {
  const runCommand = useEngineStore((s) => s.runCommand);
  const ref = useRef<HTMLDivElement | null>(null);
  const [filename, setFilename] = useState("render.mp4");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onDown(e: MouseEvent): void {
      const t = e.target as Node | null;
      if (t === null) return;
      if (ref.current?.contains(t) === true) return;
      if (anchor?.contains(t) === true) return;
      onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  async function go(): Promise<void> {
    setBusy(true);
    try {
      await runCommand("export.quick", { path: filename });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className="quick-export" data-automation-id="quick.export.popup">
      <header className="quick-export-header">
        <span className="quick-export-title">Quick Export</span>
        <button
          type="button"
          className="quick-export-close"
          onClick={onClose}
          data-automation-id="quick.export.close"
        >
          Close
        </button>
      </header>
      <label className="quick-export-field">
        <span>Output filename</span>
        <input
          type="text"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          data-automation-id="quick.export.filename"
        />
      </label>
      <div className="quick-export-actions">
        <button
          type="button"
          className="quick-export-go"
          disabled={busy}
          onClick={() => void go()}
          data-automation-id="quick.export.go"
        >
          Export
        </button>
      </div>
    </div>
  );
}
