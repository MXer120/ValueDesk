/**
 * "As of" for answers built from the indexer's cohort load (the cohorts pages, the heatmap's
 * wallet list): when the data was taken, and how long ago once that is more than a moment.
 * The server never serves a load older than two minutes (indexer/read.ts STALE_MAX_MS); a line
 * saying so lets a viewer see it, and see it if it ever is not.
 */
export function asOfText(asOf: number | null | undefined, now: number = Date.now()): string | null {
  if (!asOf || !Number.isFinite(asOf) || asOf <= 0) return null;
  const d = new Date(asOf);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const age = Math.max(0, now - asOf);
  const ago = age < 60_000 ? '' : age < 3_600_000 ? ` · ${Math.floor(age / 60_000)} min ago` : ` · ${Math.floor(age / 3_600_000)} h ${Math.floor((age % 3_600_000) / 60_000)} min ago`;
  return `As of ${hh}:${mm}:${ss}${ago}`;
}
