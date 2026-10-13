/**
 * Audio meters panel (M3.5).
 *
 * The cloud server does not currently expose a per-tab peak meter
 * command (`audio_levels` is not in `crates/engine/src/commands.rs` —
 * see M3 plan §M3.5 Risks §3 / M3.5 commit text). Until the engine
 * gains a real meter, the panel renders a static pair of L/R bars at
 * zero with a small note explaining the placeholder.
 */

import PanelFrame from "./PanelFrame";
import "./AudioMetersPanel.css";

export default function AudioMetersPanel() {
  return (
    <PanelFrame title="Audio Meters" automationId="panel.audioMeters">
      <div className="audio-meters-root">
        <div className="audio-meters-bars" role="img" aria-label="Audio meter placeholder">
          <MeterChannel label="L" />
          <MeterChannel label="R" />
        </div>
        <p className="audio-meters-note">
          Live peak meters ride on `state.inspect.audio_levels`; the
          cloud server does not yet publish it.
        </p>
      </div>
    </PanelFrame>
  );
}

function MeterChannel({ label }: { label: string }) {
  return (
    <div
      className="audio-meter-channel"
      data-automation-id={`panel.audioMeters.channel.${label}`}
    >
      <div className="audio-meter-scale" aria-hidden="true">
        {[-6, -12, -24, -48].map((db) => (
          <span key={db} className="audio-meter-tick">
            {db}
          </span>
        ))}
      </div>
      <div className="audio-meter-bar" data-value="0">
        <div className="audio-meter-fill" style={{ height: "0%" }} />
      </div>
      <span className="audio-meter-label">{label}</span>
    </div>
  );
}