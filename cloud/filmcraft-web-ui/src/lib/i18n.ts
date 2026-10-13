/**
 * Indirection point for every visible string (M3.1).
 *
 * For now this is the identity function with a `printf`-style
 * placeholder format. Components call `t("Save", fileName)`; a
 * later PR swaps the body for a translation table and every caller
 * stays unchanged. Two placeholder shapes are supported so English
 * prose reads naturally:
 *
 *   - `%s` — coerced to string.
 *   - `%d` — coerced to integer.
 *   - `%{name}` — named argument via `args[name]`.
 *
 * Unknown placeholders are left intact (no throwing) so a typo
 * doesn't take the page down.
 */

/** Format `key`, substituting any `%` placeholders. */
export function t(key: string, ...args: unknown[]): string {
  const first = args[0];
  // First argument is a plain array → positional; first argument is
  // a plain object → named; otherwise treat all args as positional.
  let positional: unknown[] | null;
  let named: Record<string, unknown> | null;
  if (Array.isArray(first)) {
    positional = first as unknown[];
    named = null;
  } else if (first !== null && typeof first === "object") {
    positional = null;
    named = first as Record<string, unknown>;
  } else {
    positional = args;
    named = null;
  }
  return format(key, positional, named);
}

function format(
  key: string,
  positional: ReadonlyArray<unknown> | null,
  named: Record<string, unknown> | null,
): string {
  let out = "";
  let i = 0;
  let pos = 0;
  while (i < key.length) {
    const c = key[i];
    if (c !== "%") {
      out += c;
      i++;
      continue;
    }
    const next = key[i + 1];
    // Literal "%%" — collapse to a single percent.
    if (next === "%") {
      out += "%";
      i += 2;
      continue;
    }
    // `%{name}` / `%{name}s` / `%{name}d` — named form.
    if (next === "{") {
      const close = key.indexOf("}", i + 2);
      if (close > 0) {
        const name = key.slice(i + 2, close);
        const after = key[close + 1];
        let conv: string | undefined;
        let consumed = close + 1;
        if (after === "s" || after === "d") {
          conv = after;
          consumed = close + 2;
        }
        if (named !== null && Object.prototype.hasOwnProperty.call(named, name)) {
          out += renderValue(named[name], conv);
        } else {
          out += `%{${name}${conv ?? ""}}`;
        }
        i = consumed;
        continue;
      }
      // Unterminated `%{` — fall through and emit literally.
    }
    if (next === "s" || next === "d") {
      if (positional !== null && pos < positional.length) {
        out += renderValue(positional[pos], next);
        pos++;
      } else {
        out += `%${next}`;
      }
      i += 2;
      continue;
    }
    // Unknown placeholder: emit the percent literally, advance.
    out += c;
    i++;
  }
  return out;
}

function renderValue(value: unknown, conv: string | undefined): string {
  if (conv === "d") {
    const n = typeof value === "number" ? Math.trunc(value) : Number(value);
    return Number.isFinite(n) ? String(n) : "0";
  }
  if (value === null || value === undefined) return "";
  return String(value);
}
