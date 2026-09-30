/**
 * From the Valuescan contract (`VsFill`, `VsPosition`) to engine input.
 *
 * Three things the replay needs that a `VsFill` does not carry:
 *
 *  1. THE VENUE. /api/vs/fills answers for one venue at a time, so it is added
 *     here from the request.
 *  2. THE COIN, for the allow and deny lists: 'BTC' for 'BTC-USD' (SoDEX perps),
 *     'BTC' for 'vBTC_vUSDC' (SoDEX spot), 'PURR' for 'PURR/USDC' (Hyperliquid spot).
 *  3. THE LEADER'S POSITION BEFORE EACH FILL. Without it the engine rebuilds
 *     positions forward from the first fill it sees, so anything opened before
 *     that fill is invisible and its close looks like a new open the other way.
 *     We DO know where the leader stands now (the trader's current positions),
 *     and the fills we have run up to now, so walking them BACKWARDS from the
 *     current position recovers the exact position before every fill - see
 *     `reconstructStartPositions`. The venue's own direction labels ("Open
 *     Long", "Close Short") are used to check the walk, and a market whose walk
 *     contradicts them is left to the forward rebuild instead.
 *
 * Pure, no I/O: safe in tests and in the worker.
 */
import type { Venue, VsFill, VsPosition } from '../../../vsApi';
import { isSpotSymbol } from './engine';
import type { SimFill } from './types';

/** The coin a symbol trades, upper-case, for allow/deny matching and display. */
export function coinOf(venue: Venue, symbol: string): string {
  const s = String(symbol ?? '').trim();
  if (!s) return '';
  if (venue === 'sodex') {
    // Perps 'BTC-USD'; spot 'vBTC_vUSDC' / 'WSOSO_vUSDC'. The venue's wrapped
    // ledger coins carry a lower-case 'v' prefix, which is not part of the name.
    const base = s.split(/[-_/]/)[0] ?? s;
    return (/^v[A-Z0-9]/.test(base) ? base.slice(1) : base).toUpperCase();
  }
  // Hyperliquid: perps are the bare coin ('BTC', 'kPEPE'), spot is 'PURR/USDC'
  // or an '@123' index that names no coin at all.
  return (s.split('/')[0] ?? s).toUpperCase();
}

/** Signed size of a position: long positive, short negative. */
export const signedSize = (p: Pick<VsPosition, 'side' | 'size'>): number =>
  (p.side === 'short' ? -1 : 1) * Math.abs(Number(p.size) || 0);

/**
 * What a venue direction label says about the position around a fill.
 *
 * Returns the sign the position must have BEFORE and AFTER the fill, where the
 * label pins it (+1 long, -1 short, 0 flat), or null for "unconstrained". An
 * unrecognised label constrains nothing.
 */
export function dirConstraint(dir: string | null | undefined): { before: -1 | 0 | 1 | null; after: -1 | 0 | 1 | null } | null {
  if (!dir) return null;
  const d = dir.trim().toLowerCase();
  if (d === 'open long') return { before: null, after: 1 };
  if (d === 'open short') return { before: null, after: -1 };
  if (d === 'close long') return { before: 1, after: null };
  if (d === 'close short') return { before: -1, after: null };
  if (d === 'long > short') return { before: 1, after: -1 };
  if (d === 'short > long') return { before: -1, after: 1 };
  return null;
}

const snap = (x: number, scale: number): number => (Math.abs(x) <= 1e-9 * Math.max(scale, 1e-12) ? 0 : x);

/** Numeric-aware id order ('9' < '10'), the same tie-break the engine sorts with. */
function cmpId(a: string, b: string): number {
  if (a === b) return 0;
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : 1;
}

export interface Reconstruction {
  fills: SimFill[];
  /** Markets whose position-before was filled in. */
  markets: string[];
  /** Markets whose backward walk contradicted the venue's direction labels, and were left alone. */
  rejected: string[];
}

/**
 * Fill in `startPosition` by walking each perp market's fills backwards from
 * the leader's CURRENT position.
 *
 * Exact when the fills are contiguous up to now - which a "most recent N fills"
 * answer always is, even when it is truncated at the old end. Spot markets are
 * left alone: a spot "position" is a wallet balance that deposits and transfers
 * move without a fill, so there is no current value to walk back from.
 *
 * Fills that already carry a startPosition are trusted and left as they are.
 * Returns new objects; the input is not mutated.
 */
export function reconstructStartPositions(
  venue: Venue,
  fills: SimFill[],
  positions: ReadonlyArray<Pick<VsPosition, 'symbol' | 'side' | 'size'>>,
): Reconstruction {
  const now = new Map<string, number>();
  for (const p of positions) now.set(p.symbol, (now.get(p.symbol) ?? 0) + signedSize(p));

  const bySymbol = new Map<string, number[]>();
  fills.forEach((f, i) => {
    if (f.startPosition !== null || isSpotSymbol(venue, f.symbol)) return;
    const list = bySymbol.get(f.symbol);
    if (list) list.push(i);
    else bySymbol.set(f.symbol, [i]);
  });

  const out = fills.slice();
  const markets: string[] = [];
  const rejected: string[] = [];

  for (const [symbol, idx] of bySymbol) {
    // Newest first, in exactly the reverse of the engine's own total order
    // (time, order id, fill id), so a position-before lines up with the fill
    // the engine will see it on even when several print in one millisecond.
    idx.sort((a, b) => {
      const fa = fills[a]!;
      const fb = fills[b]!;
      return fb.time - fa.time || cmpId(fb.orderId ?? '', fa.orderId ?? '') || cmpId(fb.id, fa.id) || b - a;
    });
    let after = now.get(symbol) ?? 0;
    const starts = new Map<number, number>();
    let labelled = 0;
    let contradictions = 0;
    for (const i of idx) {
      const f = fills[i]!;
      const signed = (f.side === 'buy' ? 1 : -1) * f.size;
      const before = snap(after - signed, Math.max(Math.abs(after), Math.abs(signed)));
      const c = dirConstraint(f.dir);
      if (c) {
        labelled++;
        const sb = Math.sign(before);
        const sa = Math.sign(after);
        if ((c.before !== null && sb !== c.before) || (c.after !== null && sa !== c.after)) contradictions++;
      }
      starts.set(i, before);
      after = before;
    }
    // A timing gap between the positions snapshot and the fills shifts every
    // position by the same amount, which the labels catch at the first zero
    // crossing. One stray label is noise; more is a walk that does not fit.
    if (contradictions > Math.max(1, labelled * 0.05)) {
      rejected.push(symbol);
      continue;
    }
    for (const [i, before] of starts) out[i] = { ...out[i]!, startPosition: before };
    markets.push(symbol);
  }
  return { fills: out, markets, rejected };
}

export interface ToSimOptions {
  /** The leader's current positions, to recover position-before (see the header). */
  positions?: ReadonlyArray<Pick<VsPosition, 'symbol' | 'side' | 'size'>> | null;
  /**
   * Group fills printed at the same millisecond, on the same market and side, as
   * one order. The contract carries no order id, and one order routinely prints
   * as many fills; without this a fixed-notional copy would open on the first
   * print and hit its cap on the rest. Default true.
   */
  groupSameTime?: boolean;
}

/** VsFill[] for one venue -> engine input. */
export function toSimFills(venue: Venue, fills: readonly VsFill[], o: ToSimOptions = {}): { fills: SimFill[]; reconstruction: Reconstruction | null } {
  const group = o.groupSameTime !== false;
  const mapped: SimFill[] = fills.map((f) => ({
    id: String(f.id),
    venue,
    symbol: f.symbol,
    coin: coinOf(venue, f.symbol),
    side: f.side,
    price: f.px,
    size: f.sz,
    notionalUsd: Number.isFinite(f.notional) ? f.notional : f.px * f.sz,
    fee: typeof f.fee === 'number' && Number.isFinite(f.fee) ? f.fee : null,
    feeAsset: null,
    realizedPnl: typeof f.closedPnl === 'number' && Number.isFinite(f.closedPnl) ? f.closedPnl : null,
    dir: f.dir ?? null,
    startPosition: null,
    orderId: group ? `${f.time}:${f.symbol}:${f.side}` : null,
    time: f.time,
  }));
  if (!o.positions) return { fills: mapped, reconstruction: null };
  const reconstruction = reconstructStartPositions(venue, mapped, o.positions);
  return { fills: reconstruction.fills, reconstruction };
}
