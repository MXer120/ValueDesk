/**
 * Display names at the API edge: none. The user decided (2026-09-29) that no
 * username is shown anywhere - Hyperliquid's leaderboard `displayName`
 * included - so every row leaves the server with `label: null`, and no
 * search matches a name. The stored column is kept as is.
 *
 * One place for the rule, applied in both threads wherever a row leaves the
 * server (read.ts, routes, the screener, the providers' own searches).
 */

/** The name to send for an address: never one. */
export function shownLabel(_address: string, _label: string | null | undefined): string | null {
  return null;
}

/** Rows with their names removed (in place; returns the same array). */
export function scrubLabels<T extends { address: string; label?: string | null }>(rows: T[]): T[] {
  for (const r of rows) if (r.label != null) r.label = null;
  return rows;
}

/** A name search: never matches (addresses and account ids are searched elsewhere). */
export function labelMatches(_address: string, _label: string | null | undefined, _q: string): boolean {
  return false;
}

/** Every trader-like object ({ address, label }) in a response, however nested, without its name. */
export function scrubDeep<T>(v: T, depth = 0): T {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    for (const x of v) scrubDeep(x, depth + 1);
    return v;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.address === 'string' && 'label' in o) o.label = null;
  for (const x of Object.values(o)) if (x !== null && typeof x === 'object') scrubDeep(x, depth + 1);
  return v;
}
