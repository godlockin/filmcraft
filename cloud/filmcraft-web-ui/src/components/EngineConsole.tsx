/**
 * `EngineConsole` (M2.2 + M2.8).
 *
 * Per-project panel that exercises the WS bridge end-to-end:
 *
 *   - Shows the WS connection state as a coloured badge so the user
 *     can see auto-load succeed/fail at a glance.
 *   - Round-trips a handful of engine commands that are stable in
 *     M2.2: `sequence.inspect`, `prefs.get`/`prefs.set`,
 *     `engine.commands` (command discovery), and `file.save`.
 *   - Surfaces the raw `/api/v1/projects/{id}/fcproj` endpoint via
 *     a "fetch raw .fcproj" button that calls `fetchFcproj` and
 *     renders the first 64 bytes as hex + text so the user can
 *     confirm the bytes come back without `Content-Disposition`.
 *
 *   - M2.8: hosts the `CommandPalette` (filterable, fuzzy-by-prefix,
 *     capped to 12 visible rows) and a "Recent" row of clickable
 *     chips that runs the same engine commands; both flow into
 *     `runCommand` so they get recorded in the MRU list.
 *
 * The component is intentionally minimal — the M2.2 deliverable is
 * "all M2.1 backend features are demonstrably usable from a browser",
 * not "ship a Premiere-class editor". M2.3+ adds the timeline.
 */

import { useEffect, useState } from "react";
import { useEngineStore } from "../store";
import CommandPalette from "./CommandPalette";
import { clearRecent } from "../lib/history";

function stateLabel(state: ReturnType<typeof useEngineStore.getState>["connectionState"]): string {
  switch (state) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting…";
    case "open":
      return "connected";
    case "closed":
      return "disconnected";
    case "fatal":
      return "load failed";
  }
}

function stateClass(state: ReturnType<typeof useEngineStore.getState>["connectionState"]): string {
  return `conn-badge conn-${state}`;
}

export default function EngineConsole({ projectId }: { projectId: string }) {
  const connectionState = useEngineStore((s) => s.connectionState);
  const fatalError = useEngineStore((s) => s.fatalError);
  const lastError = useEngineStore((s) => s.lastError);
  const lastOkAt = useEngineStore((s) => s.lastOkAt);
  const sequenceInfo = useEngineStore((s) => s.sequenceInfo);
  const prefs = useEngineStore((s) => s.prefs);
  const commands = useEngineStore((s) => s.commands);
  const rawFcproj = useEngineStore((s) => s.rawFcproj);
  const recentCommands = useEngineStore((s) => s.recentCommands);

  const connect = useEngineStore((s) => s.connect);
  const disconnect = useEngineStore((s) => s.disconnect);
  const inspectSequence = useEngineStore((s) => s.inspectSequence);
  const setPreference = useEngineStore((s) => s.setPreference);
  const getPreference = useEngineStore((s) => s.getPreference);
  const saveProject = useEngineStore((s) => s.saveProject);
  const listCommands = useEngineStore((s) => s.listCommands);
  const fetchRawFcproj = useEngineStore((s) => s.fetchRawFcproj);
  const runCommand = useEngineStore((s) => s.runCommand);
  const reloadRecentCommands = useEngineStore((s) => s.reloadRecentCommands);
  // Local handle: clicking a recent chip runs the command and quietly
  // swallows the returned value. The store records `lastOkAt` /
  // `lastError` so the footer + error banners update.
  const handleRun = (id: string): void => {
    void runCommand(id);
  };
  const handleClearRecent = (): void => {
    clearRecent();
    reloadRecentCommands();
  };

  // Local form state for the prefs round-trip — the engine prefs map
  // is generic, so the user picks a key + a string value.
  const [prefKey, setPrefKey] = useState("ui.user.label");
  const [prefValue, setPrefValue] = useState("");

  // Connect on mount, disconnect on unmount. The store is idempotent
  // if `projectId` doesn't change, so it's safe to call on every
  // project-detail render.
  useEffect(() => {
    let cancelled = false;
    connect(projectId).catch((e: unknown) => {
      if (cancelled) return;
      // The store already recorded the error; nothing else to do.
      void e;
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [projectId, connect, disconnect]);

  return (
    <section className="engine-console">
      <header className="engine-header">
        <h3>Engine console</h3>
        <span className={stateClass(connectionState)}>{stateLabel(connectionState)}</span>
      </header>

      {fatalError && (
        <div className="error">
          <strong>Auto-load failed:</strong> {fatalError}
          <div className="hint">
            Save a `.fcproj` to this project (or click <em>Save</em> below) and reopen this page.
          </div>
        </div>
      )}
      {lastError && !fatalError && <div className="error">{lastError}</div>}

      <div className="engine-actions">
        <button onClick={inspectSequence} disabled={connectionState !== "open"}>
          Inspect sequence
        </button>
        <button onClick={saveProject} disabled={connectionState !== "open"}>
          Save project
        </button>
        <button onClick={listCommands} disabled={connectionState !== "open"}>
          List commands
        </button>
        <button onClick={fetchRawFcproj} disabled={!projectId}>
          Fetch raw .fcproj
        </button>
      </div>

      {sequenceInfo !== null && (
        <details className="engine-result" open>
          <summary>sequence.inspect → {labelFor(sequenceInfo)}</summary>
          <pre>{JSON.stringify(sequenceInfo, null, 2)}</pre>
        </details>
      )}

      <div className="prefs-row">
        <h4>Preferences (engine round-trip)</h4>
        <input
          type="text"
          value={prefKey}
          onChange={(e) => setPrefKey(e.target.value)}
          placeholder="key"
          aria-label="preference key"
        />
        <input
          type="text"
          value={prefValue}
          onChange={(e) => setPrefValue(e.target.value)}
          placeholder="value (string)"
          aria-label="preference value"
        />
        <button
          onClick={() => void setPreference(prefKey, prefValue)}
          disabled={connectionState !== "open" || prefKey === ""}
        >
          Set
        </button>
        <button
          onClick={() => void getPreference(prefKey)}
          disabled={connectionState !== "open" || prefKey === ""}
        >
          Get
        </button>
      </div>

      {Object.keys(prefs).length > 0 && (
        <details className="engine-result">
          <summary>prefs → {Object.keys(prefs).length} entries</summary>
          <pre>{JSON.stringify(prefs, null, 2)}</pre>
        </details>
      )}

      {commands !== null && (
        <details className="engine-result">
          <summary>engine.commands → {commands.length} commands</summary>
          <ul className="command-list">
            {commands.slice(0, 50).map((c) => (
              <li key={c.id}>
                <code>{c.id}</code>
                {c.label ? ` — ${c.label}` : ""}
              </li>
            ))}
            {commands.length > 50 && <li>… ({commands.length - 50} more)</li>}
          </ul>
        </details>
      )}

      <CommandPalette
        commands={commands ?? []}
        disabled={connectionState !== "open"}
        onRun={handleRun}
      />

      {recentCommands.length > 0 && (
        <div className="recent-row">
          <h4>
            Recent
            <button
              type="button"
              className="recent-clear"
              onClick={handleClearRecent}
              aria-label="clear recent commands"
            >
              clear
            </button>
          </h4>
          <ul className="recent-list" aria-label="recent commands">
            {recentCommands.map((id) => (
              <li key={id}>
                <button type="button" onClick={() => handleRun(id)} disabled={connectionState !== "open"}>
                  <code>{id}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rawFcproj !== null && (
        <details className="engine-result" open>
          <summary>
            {rawFcproj.ok
              ? `raw /fcproj → ${rawFcproj.size} bytes, ${rawFcproj.contentType}`
              : `raw /fcproj → ${rawFcproj.error}`}
          </summary>
          {rawFcproj.ok ? (
            <>
              <div className="hint">hex preview (first 64 bytes):</div>
              <pre className="hex">{rawFcproj.hexPreview}</pre>
              <div className="hint">text preview (non-printable → `.`):</div>
              <pre className="text-preview">{rawFcproj.textPreview}</pre>
            </>
          ) : (
            <div className="hint">{rawFcproj.kind === "no-save" ? "Save the project first (see Save button above)." : "Server returned an error."}</div>
          )}
        </details>
      )}

      <footer className="engine-footer">
        {lastOkAt !== null ? (
          <span>last reply {new Date(lastOkAt).toLocaleTimeString()}</span>
        ) : (
          <span>no replies yet</span>
        )}
      </footer>
    </section>
  );
}

function labelFor(seq: unknown): string {
  if (seq && typeof seq === "object" && "name" in seq && typeof (seq as { name: unknown }).name === "string") {
    return (seq as { name: string }).name;
  }
  return "(sequence)";
}