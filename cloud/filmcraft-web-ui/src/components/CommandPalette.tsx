/**
 * `CommandPalette` (M2.8).
 *
 * A filterable list of engine commands for the M2.2 Engine Console.
 * The editor types a query in the input; the list narrows via
 * `fuzzyFilter`. Each entry is a button that fires `onRun(id)`,
 * which the parent (Engine Console) wires to `engine.execute`.
 *
 * The palette is dumb on purpose: it does not own the command list
 * (passed in as `commands`) or the WS state (passed as `disabled`).
 * That keeps it easy to drop into a different surface later (a
 * keyboard shortcut bar, an inspector popover, …).
 *
 * Accessibility:
 *   - The filter input gets the focus on mount so the editor can
 *     start typing immediately.
 *   - Buttons are `<button type="button">` so Enter on the input
 *     doesn't accidentally fire whichever command is highlighted.
 *   - The role-aware filter placeholder lives in `palette.ts`; we
 *     apply it here so it gets exercised in tests.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo } from "../types";
import { applyRoleFilter, fuzzyFilter } from "../lib/palette";

const DEFAULT_LIMIT = 12;

export interface CommandPaletteProps {
  commands: CommandInfo[];
  disabled: boolean;
  onRun: (id: string) => void;
  emptyHint?: string;
}

export default function CommandPalette({
  commands,
  disabled,
  onRun,
  emptyHint = "Type a command id or label to filter.",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the input on first mount; subsequent mounts (project
  // navigation re-renders) shouldn't steal focus.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const visible: CommandInfo[] = useMemo(() => {
    const visible = applyRoleFilter(commands);
    return fuzzyFilter(visible, query, DEFAULT_LIMIT);
  }, [commands, query]);

  return (
    <div className="command-palette">
      <input
        ref={inputRef}
        type="text"
        className="palette-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={emptyHint}
        aria-label="filter engine commands"
        disabled={disabled}
      />
      {commands.length === 0 ? (
        <p className="hint">
          {disabled
            ? "Open the WebSocket connection (badge in the header) to fetch the command list."
            : "No commands yet — click \"List commands\" above, or wait for the catalogue to load."}
        </p>
      ) : visible.length === 0 ? (
        <p className="hint">No command matches “{query}”.</p>
      ) : (
        <ul className="palette-list" role="listbox" aria-label="engine commands">
          {visible.map((c) => (
            <li key={c.id} role="option">
              <button
                type="button"
                onClick={() => onRun(c.id)}
                disabled={disabled}
                title={c.label ?? c.id}
              >
                <code>{c.id}</code>
                {c.label ? <span className="palette-label"> — {c.label}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
