/**
 * Modal wrapper around `<ProjectList>` (M3.3).
 *
 * The M3 plan demotes the project list from a top-level page to a
 * dialog that the header opens from a "Projects" button. This file
 * is the lightweight shell — styling lives in `projectDialog.css`
 * and the underlying `<ProjectList />` keeps its M2.2 implementation
 * unchanged.
 */

import type { ReactNode } from "react";
import "./projectDialog.css";

interface ProjectDialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export default function ProjectDialog({ open, onClose, children }: ProjectDialogProps) {
  if (!open) return null;
  return (
    <div className="project-dialog-backdrop" onClick={onClose}>
      <div
        className="project-dialog"
        role="dialog"
        aria-label="Project list"
        onClick={(e) => e.stopPropagation()}
        data-automation-id="dialog.projects"
      >
        <header className="project-dialog-title">
          <span>Projects</span>
          <button
            type="button"
            className="project-dialog-close"
            onClick={onClose}
            aria-label="Close"
            data-automation-id="dialog.projects.close"
          >
            ×
          </button>
        </header>
        <div className="project-dialog-body">{children}</div>
      </div>
    </div>
  );
}
