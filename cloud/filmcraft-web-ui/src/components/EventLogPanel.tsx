/**
 * Event Log panel (M3.8).
 *
 * Renders the last 50 engine operations recorded by the store's
 * `runCommand`. Each row shows the command id, a relative
 * timestamp, the call duration in milliseconds, and a coloured
 * pill (green = ok, red = error).
 *
 * A "Clear" button invokes `clearEventLog` so the user can reset
 * the buffer.
 */

import { useEngineStore } from "../store";
import PanelFrame from "./PanelFrame";
import "./EventLogPanel.css";

export default function EventLogPanel() {
  const events = useEngineStore((s) => s.eventLog);
  const clear = useEngineStore((s) => s.clearEventLog);

  return (
    <PanelFrame
      title="Event Log"
      automationId="panel.eventLog"
      actions={
        <button
          type="button"
          className="panel-mini-btn"
          onClick={clear}
          data-automation-id="panel.eventLog.clear"
        >
          Clear
        </button>
      }
    >
      {events.length === 0 ? (
        <div className="event-log-empty">No events yet</div>
      ) : (
        <ul className="event-log-list" role="list">
          {events.map((e, i) => (
            <li
              key={i}
              className={"event-log-row" + (e.ok ? " is-ok" : " is-error")}
              data-automation-id={`panel.eventLog.row.${i}`}
            >
              <span className="event-log-status" aria-hidden="true">
                {e.ok ? "OK" : "ERR"}
              </span>
              <span className="event-log-cmd">{e.command}</span>
              <span className="event-log-time">{relative(e.timestamp)}</span>
              <span className="event-log-duration">
                {e.durationMs.toFixed(0)} ms
              </span>
              {e.error !== undefined ? (
                <span className="event-log-error" title={e.error}>
                  {e.error}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

function relative(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 1000) return "now";
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  return `${Math.floor(dt / 3_600_000)}h ago`;
}