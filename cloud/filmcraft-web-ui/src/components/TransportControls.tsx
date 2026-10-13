/**
 * Transport controls (M3.2).
 *
 * Three buttons — Play / Pause / Stop — that fire the matching
 * engine command through `useEngineStore.runCommand`. The buttons
 * disable themselves when no project is bound so a stray click
 * before the WS handshake doesn't trigger an error.
 */

import { useEngineStore } from "../store";
import "./TransportControls.css";

export default function TransportControls() {
  const activeProject = useEngineStore((s) => s.activeProject);
  const runCommand = useEngineStore((s) => s.runCommand);
  const disabled = activeProject === null;

  const play = () => {
    void runCommand("playback.play").catch(() => {
      /* surfaced via store.lastError */
    });
  };
  const pause = () => {
    void runCommand("playback.pause").catch(() => {
      /* surfaced via store.lastError */
    });
  };
  const stop = () => {
    void runCommand("playback.stop").catch(() => {
      /* surfaced via store.lastError */
    });
  };

  return (
    <div className="transport" role="group" aria-label="Transport controls">
      <button
        type="button"
        className="transport-btn"
        onClick={play}
        disabled={disabled}
        aria-label="Play"
        data-automation-id="transport.play"
      >
        ▶
      </button>
      <button
        type="button"
        className="transport-btn"
        onClick={pause}
        disabled={disabled}
        aria-label="Pause"
        data-automation-id="transport.pause"
      >
        ❚❚
      </button>
      <button
        type="button"
        className="transport-btn"
        onClick={stop}
        disabled={disabled}
        aria-label="Stop"
        data-automation-id="transport.stop"
      >
        ■
      </button>
    </div>
  );
}
