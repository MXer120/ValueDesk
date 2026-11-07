/**
 * The books against the venues' own open interest (cohortTracker.ts checkOi).
 *
 * Open interest is one side of a market: every long has a short. The books can hold at most
 * that much on either side (less where wallets are not tracked). More is size that no longer
 * exists - a close or a liquidation the stream missed, a print applied twice, a book never read
 * again. Audit 2026-10-30, Lighter: ETH long 47,810 / short 48,267 against 30,865 open (155%),
 * SOL short 326,713 against 159,030 (205%), BTC short 2,560 against 2,089 (122%).
 *
 * Over OI_EXCESS it is logged, shown in the status (ratio per venue and coin) and the holders of
 * that coin on that venue are read again, the oldest read first: a read replaces the book whole,
 * so what the venue no longer reports is dropped.
 */
import type { Venue } from '../valuedesk/types.js';

/** Books above this share of the venue's open interest are reconciled. */
export const OI_EXCESS = 1.05;
/** A holder read within this long is not read again for the check. */
export const OI_REREAD_MIN_AGE_MS = 30 * 60_000;

export interface OiRow {
  venue: Venue;
  coin: string;
  /** Book sizes, in coins. */
  long: number;
  short: number;
  /** The venue's open interest, one side, in coins. */
  oi: number;
  /** The larger side over the open interest. */
  ratio: number;
}

/** Every coin and venue with both book totals and an open interest, largest ratio first. */
export function oiCheck(
  totals: ReadonlyMap<string, ReadonlyMap<Venue, readonly [number, number]>>,
  oiOf: (venue: Venue, coin: string) => number | null,
): OiRow[] {
  const out: OiRow[] = [];
  for (const [coin, per] of totals) {
    for (const [venue, [long, short]] of per) {
      const oi = oiOf(venue, coin);
      if (oi === null || !(oi > 0)) continue;
      out.push({ venue, coin, long, short, oi, ratio: Math.max(long, short) / oi });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

/** The rows over OI_EXCESS. */
export const oiOver = (rows: readonly OiRow[]): OiRow[] => rows.filter((r) => r.ratio > OI_EXCESS);

/** Which side of a coin's books is over its open interest (both when both are). */
export function overSides(r: Pick<OiRow, 'long' | 'short' | 'oi'>): { long: boolean; short: boolean } {
  const long = r.long > r.oi * OI_EXCESS;
  const short = r.short > r.oi * OI_EXCESS;
  // Over as a ratio but neither side past the line on its own cannot happen; read the larger side then.
  return long || short ? { long, short } : { long: r.long >= r.short, short: r.short > r.long };
}

/**
 * The holders of `coin` (by `coinOf` over their symbols) to read again, none read within
 * OI_REREAD_MIN_AGE_MS, at most `limit`. Size that is not there sits on the side that is over, in a
 * book read before the venue's last gap in the prints (a restart, an outage: the close it missed);
 * a book read since is the venue's own answer. So (2026-11-07, trade.xyz ORCL at 116%: the excess
 * was one 6,817 short, closed on the venue 3.8 days before, the coin's third-largest short of 751
 * holders - oldest first, a batch of 100 did not reach it):
 *   - only holders on an over side (`sides`; both when not given);
 *   - books read before `gapAt` first;
 *   - then the largest position first: one phantom of size clears most of an excess;
 *   - oldest read last of all.
 */
export function oiRereads(
  books: Iterable<[string, { at: number; pos: ReadonlyMap<string, { szi: number }> }]>,
  coin: string, coinOf: (symbol: string) => string, now: number, limit: number,
  o: { sides?: { long: boolean; short: boolean }; gapAt?: number } = {},
): string[] {
  const sides = o.sides ?? { long: true, short: true };
  const gapAt = o.gapAt ?? 0;
  const due: Array<{ address: string; before: boolean; size: number; at: number }> = [];
  for (const [address, b] of books) {
    if (now - b.at < OI_REREAD_MIN_AGE_MS) continue;
    let size = 0;
    for (const [symbol, p] of b.pos) {
      if (!p.szi || coinOf(symbol) !== coin) continue;
      if ((p.szi > 0 && sides.long) || (p.szi < 0 && sides.short)) size += Math.abs(p.szi);
    }
    if (size > 0) due.push({ address, before: b.at < gapAt, size, at: b.at });
  }
  due.sort((a, b) => (a.before !== b.before ? (a.before ? -1 : 1) : b.size - a.size || a.at - b.at));
  return due.slice(0, limit).map((d) => d.address);
}

/** The status's view: per venue, the worst ratio and the coins over, worst first (at most `max`). */
export function oiStatus(rows: readonly OiRow[], max = 10): Partial<Record<Venue, { worst: number; over: number; coins: Array<{ coin: string; ratio: number; long: number; short: number; oi: number }> }>> {
  const out: Partial<Record<Venue, { worst: number; over: number; coins: Array<{ coin: string; ratio: number; long: number; short: number; oi: number }> }>> = {};
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  for (const r of rows) {
    const v = out[r.venue] ?? (out[r.venue] = { worst: 0, over: 0, coins: [] });
    v.worst = Math.max(v.worst, r4(r.ratio));
    if (r.ratio > OI_EXCESS) {
      v.over++;
      if (v.coins.length < max) v.coins.push({ coin: r.coin, ratio: r4(r.ratio), long: +r.long.toPrecision(6), short: +r.short.toPrecision(6), oi: +r.oi.toPrecision(6) });
    }
  }
  return out;
}
