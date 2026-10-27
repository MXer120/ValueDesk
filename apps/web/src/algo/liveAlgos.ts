/**
 * Real algo orders are switched off for now: only practice runs start, in this browser or on an
 * executor. The ticket says so, and the browser runner and the executor client refuse one anyway.
 */
export const LIVE_ALGOS = false;

export const LIVE_ALGOS_OFF = 'Real algo orders are off for now. Turn on Practice run to try one against the live market.';

/** Throws unless the spec is a practice run (or real algos are on). */
export function requirePaperAlgo(spec: unknown): void {
  if (LIVE_ALGOS) return;
  if (!(typeof spec === 'object' && spec !== null && (spec as { paper?: unknown }).paper === true)) throw new Error(LIVE_ALGOS_OFF);
}
