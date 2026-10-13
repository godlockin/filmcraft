/**
 * Title-bar wrapper every dock panel mounts inside (M3.3).
 *
 * Minimal: an `var(--tab-bg)` strip at the top holding the title and
 * optional right-aligned controls, and a body region below it. The
 * dock passes each panel as `<PanelFrame title="…" actions={…}>...
 * children ...</PanelFrame>` so the chrome stays consistent.
 */

import type { ReactNode } from "react";
import "./Panel.css";

interface PanelFrameProps {
  title: string;
  /** Optional slot of right-aligned header controls (e.g. refresh, "+"). */
  actions?: ReactNode;
  /** Optional automation id carried as a `data-` attribute. */
  automationId?: string;
  children: ReactNode;
}

export default function PanelFrame({
  title,
  actions,
  automationId,
  children,
}: PanelFrameProps) {
  return (
    <section
      className="panel-frame"
      data-automation-id={automationId}
      aria-label={title}
    >
      <header className="panel-frame-title">
        <span className="panel-frame-title-text">{title}</span>
        {actions !== undefined ? (
          <span className="panel-frame-title-actions">{actions}</span>
        ) : null}
      </header>
      <div className="panel-frame-body">{children}</div>
    </section>
  );
}
