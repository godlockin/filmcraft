/**
 * Command palette helpers (M2.8).
 *
 * The M2.2 Engine Console lists every engine command returned by
 * `engine.commands`, but the editor has to scroll to find the one
 * they want. M2.8 adds a filterable palette: type a few characters,
 * the list narrows to commands whose id or label matches.
 *
 * The match is deliberately simple — no fuse.js, no fuzzysort —
 * because the M2.8 acceptance is "filter by substring, rank by
 * best prefix", not "edit-distance ranking". Editors learn the ids
 * they type anyway; this is a discoverability aid, not a search
 * engine.
 *
 * Rank order (lowest number = best):
 *   0. id starts with the query (case-insensitive)
 *   1. label starts with the query
 *   2. id contains the query
 *   3. label contains the query
 *   4. no match — excluded.
 *
 * Role filter (`applyRoleFilter`):
 *   Today every authenticated user can run every command. M3.4
 *   will tighten that to a per-role allow-list. This stub exists
 *   so the palette callsite doesn't have to special-case "filter
 *   to nothing" until M3.4 ships.
 */

import type { CommandInfo } from "../types";

export interface RankedCommand {
  command: CommandInfo;
  /** Lower rank = better. Used to sort ascending. */
  rank: number;
}

/**
 * Filter + rank `commands` against `query`. An empty / whitespace-only
 * query returns everything in their original order with rank 0 (so
 * the palette behaves the same as the M2.2 list when nothing has
 * been typed yet). Returned order: ascending rank, then original
 * input order within a tier.
 */
export function fuzzyFilter(
  commands: CommandInfo[],
  query: string,
  limit?: number,
): CommandInfo[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return typeof limit === "number" ? commands.slice(0, Math.max(0, limit)) : commands.slice();
  }
  const ranked: RankedCommand[] = [];
  for (const cmd of commands) {
    const id = cmd.id.toLowerCase();
    const label = (cmd.label ?? "").toLowerCase();
    let rank = -1;
    if (id.startsWith(q)) {
      rank = 0;
    } else if (label.startsWith(q)) {
      rank = 1;
    } else if (id.includes(q)) {
      rank = 2;
    } else if (label.includes(q)) {
      rank = 3;
    }
    if (rank !== -1) {
      ranked.push({ command: cmd, rank });
    }
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const sliced = ranked.map((r) => r.command);
  return typeof limit === "number" ? sliced.slice(0, Math.max(0, limit)) : sliced;
}

/**
 * Placeholder role filter. M3.4 will replace this with a lookup
 * keyed on `Role = "owner" | "editor" | "viewer"`; today every
 * authenticated user (including the placeholder `anonymous`) sees
 * every command.
 */
export function applyRoleFilter(commands: CommandInfo[]): CommandInfo[] {
  return commands;
}
