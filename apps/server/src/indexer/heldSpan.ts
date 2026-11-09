/**
 * Which span of a wallet's fills the index holds completely (walletFills.ts). On its own so the 'fills' read thread
 * (liqReadThread.ts) runs it without importing walletFills.ts, which imports that thread's module.
 */
import type { Venue } from '../valuedesk/types.js';
import type { HistoryKind, IndexStore } from './store.js';

const DAY_MS = 86_400_000;

/**
 * The venues answered, and the history kinds that together make one's fill list (the browser's read
 * merges SoDEX's two engines). Only the two a copy follows, compared fill by fill with the venues'
 * own reads (2026-11-07). Not Arcus: its held span still carries stream prints beside the REST fill
 * of the same order (both counted, 11 of 566 in a month); Lighter and trade.xyz were not compared.
 */
export const FILL_KINDS: Partial<Record<Venue, readonly HistoryKind[]>> = {
  sodex: ['perps', 'spot'],
  hyperliquid: ['fills'],
};

/** [lo, hi]: the span whose fills the index holds completely (lo 0: from the wallet's first fill), or null when not indexed. */
export function heldSpan(store: Pick<IndexStore, 'rawFromDay' | 'coverage'>, venue: Venue, address: string): { lo: number; hi: number } | null {
  const kinds = FILL_KINDS[venue];
  if (!kinds) return null;
  const rawFrom = store.rawFromDay(venue, address) * DAY_MS;
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  for (const kind of kinds) {
    const c = store.coverage(venue, address, kind);
    if (!c) return null;
    const start = c.exhausted && !c.capped && c.fromT >= rawFrom ? 0 : Math.max(c.fromT, rawFrom);
    lo = Math.max(lo, start);
    hi = Math.min(hi, c.toT);
  }
  return { lo, hi };
}
