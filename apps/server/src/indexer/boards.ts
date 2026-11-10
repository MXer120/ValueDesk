/**
 * Choosing a board's hundred. Pure: candidates and a trade check go in, the
 * ranked picks and the wallets still to check come out.
 *
 * Candidates arrive best first (highest PnL for `top`, lowest for `worst`).
 * With the `active` filter each one needs more than one trade in the window:
 *   - a known window volume of 0 means no trade at all, so it is skipped
 *     without asking anyone;
 *   - otherwise the index answers yes, no, or not known yet.
 * A candidate whose answer is not known yet does not get a place, and it
 * holds the board open: a wallet ranked above the current picks could still
 * push them down. The walk stops once the board is full or enough wallets are
 * waiting, so a cold index never scans the whole venue in one pass.
 */
import { BOARD_SIZE, MIN_TRADES, type BoardFilter } from './windows.js';

export interface Candidate {
  address: string;
  pnl: number;
  /** Window volume from the venue, when it publishes one. 0 = no trade in the window. */
  volume: number | null;
}

export type TradeCheck = 'yes' | 'no' | 'unknown';

export interface Picked {
  picks: Candidate[];
  /** Wallets waiting for a trade check, best ranked first. */
  pending: string[];
  /** Candidates looked at. */
  scanned: number;
  /** True when no unchecked wallet outranks any pick. */
  complete: boolean;
}

type PickOpts = { filter: BoardFilter; side?: 'top' | 'worst'; size?: number; maxPending?: number; skipZeroVolume?: boolean };

export function pickBoard(candidates: Iterable<Candidate>, check: (c: Candidate) => TradeCheck, o: PickOpts): Picked {
  const steps = pickSteps(candidates, check, o);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * pickBoard giving the thread back every PICK_SLICE_MS (2026-11-08): each check is a few SQLite reads, and a worst/active
 * board can check thousands of candidates whose answer is "no" (they count toward no stop) - seconds of a cold disk in
 * one piece on the indexer's thread, its sockets unread meanwhile.
 */
export const PICK_SLICE_MS = 20;
export async function pickBoardAsync(candidates: Iterable<Candidate>, check: (c: Candidate) => TradeCheck, o: PickOpts): Promise<Picked> {
  const steps = pickSteps(candidates, check, o);
  let since = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - since >= PICK_SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      since = performance.now();
    }
  }
}

function* pickSteps(candidates: Iterable<Candidate>, check: (c: Candidate) => TradeCheck, o: PickOpts): Generator<void, Picked> {
  const size = o.size ?? BOARD_SIZE;
  const maxPending = o.maxPending ?? size;
  const picks: Candidate[] = [];
  const pending: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let exhausted = true;
  for (const c of candidates) {
    if (picks.length >= size || pending.length >= maxPending) {
      exhausted = false;
      break;
    }
    if (!Number.isFinite(c.pnl) || seen.has(c.address)) continue;
    // A top board holds gains and a worst board losses; the rest of a thin list is not a ranking.
    if (o.side && (o.side === 'top' ? c.pnl <= 0 : c.pnl >= 0)) {
      exhausted = true;
      break;
    }
    seen.add(c.address);
    scanned++;
    if (o.filter === 'any') {
      picks.push(c);
      continue;
    }
    if (c.volume === 0 && o.skipZeroVolume !== false) continue;
    const r = check(c);
    if (r === 'yes') picks.push(c);
    else if (r === 'unknown') pending.push(c.address);
    yield;
  }
  // Full with nothing waiting above the last pick, or every candidate seen and checked.
  const complete = pending.length === 0 && (picks.length >= size || exhausted);
  return { picks, pending, scanned, complete };
}

/**
 * The trade check from what the index holds.
 *   `orders`   distinct orders since the window start
 *   `covered`  every history kind is held from the window start (or from the
 *              start of what the venue keeps) up to now
 */
export function tradeCheck(orders: number, covered: boolean): TradeCheck {
  if (orders >= MIN_TRADES) return 'yes';
  return covered ? 'no' : 'unknown';
}

/** Whether a held range answers for [windowStart, now]. */
export function spanCovers(
  cov: { fromT: number; toT: number; exhausted: boolean } | null,
  windowStart: number,
  now: number,
  o: { staleMs: number; streamSince: number | null },
): boolean {
  if (!cov) return false;
  const reachesBack = cov.fromT <= windowStart || cov.exhausted;
  // The live stream has written every fill of a tracked wallet since it came up.
  const reachesNow = cov.toT >= now - o.staleMs || (o.streamSince !== null && o.streamSince <= cov.toT);
  return reachesBack && reachesNow;
}

/** Merge two venues' boards into one ranking (venue=all). */
export function mergeBoards<T extends { pnl: number }>(lists: readonly T[][], side: 'top' | 'worst', size = BOARD_SIZE): T[] {
  const all = lists.flat();
  all.sort((a, b) => (side === 'worst' ? a.pnl - b.pnl : b.pnl - a.pnl));
  return all.slice(0, size);
}
