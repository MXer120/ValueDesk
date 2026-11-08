/**
 * Hyperliquid inputs for the index.
 *
 * Window PnL and volume for 1d / 7d / 30d / all come from HL's own
 * leaderboard file (every ranked account, hourly; hyperliquid/leaderboard.ts
 * already keeps it). 90d and ytd are not published: they come from daily
 * snapshots of all-time PnL once those reach back far enough, and from each
 * candidate's portfolio chart until then.
 *
 * Fills come from `userFillsByTime` (2,000 per page, ascending). HL only
 * serves an address's 10,000 most recent fills; when a window reaches past
 * that, the held range starts at the oldest reachable fill and is marked
 * capped, so its trade count reads as "at least".
 */
import { mark, resumed } from './busy.js';
import type { LbSnapshot } from '../valuedesk/hyperliquid/leaderboard.js';
import { hlInfo } from '../valuedesk/hyperliquid/index.js';
import { equitySeries, portfolioWindow } from '../valuedesk/hyperliquid/mappers.js';
import type { HlFillRaw, HlPortfolio } from '../valuedesk/hyperliquid/raw.js';
import type { Window } from '../valuedesk/types.js';
import type { Candidate } from './boards.js';
import type { FillRow, IndexStore } from './store.js';
import type { Side } from './windows.js';

export const HL_FILL_PAGE = 2_000;

/** Hand the event loop back (streams, timers) between slices of a long write. */
const yieldLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(() => { resumed(); r(); }));
export const HL_REACHABLE_FILLS = 10_000;

/** One REST fill as a row. */
export function hlFillRow(address: string, f: HlFillRaw): FillRow | null {
  const px = Number(f.px);
  const sz = Number(f.sz);
  if (typeof f.time !== 'number' || typeof f.tid !== 'number' || !(px > 0) || !(sz > 0)) return null;
  const pnl = Number(f.closedPnl);
  const fee = Number(f.fee);
  return {
    venue: 'hyperliquid',
    address,
    id: String(f.tid),
    t: f.time,
    symbol: f.coin,
    side: f.side === 'B' ? 1 : -1,
    px,
    sz,
    fee: Number.isFinite(fee) ? fee : null,
    closedPnl: Number.isFinite(pnl) ? pnl : null,
    oid: typeof f.oid === 'number' ? String(f.oid) : null,
    src: 1,
  };
}

export interface SyncResult {
  rows: number;
  pages: number;
  reachedNow: boolean;
}

/** Below this many held fills an address cannot have hit HL's 10k cap. */
const CAP_NEAR = HL_REACHABLE_FILLS - 100;

/**
 * Bring an address's fills up to date and reach back to `fromT`, in at most
 * `maxPages` requests. Two phases, like the SoDEX pager:
 *   1. catch up: forward from the newest held fill to now;
 *   2. reach back: forward from `fromT` until it meets what is held.
 * A first read takes the NEWEST page first (`userFills`, the latest 2,000):
 * one request gives a new board row its recent trades, closes and a range
 * that reaches now; the remaining pages reach back. (Reading forward from the
 * window start first left an active trader with a range that ended weeks ago.)
 * Six pages always suffice for any address (5 x 2,000 = the cap).
 *
 * `streamSince`: when the trade stream's current connection began. A catch-up whose held range ends before it reads only
 * the gap, to BRIDGE_PAST_MS past that start: the stream holds the rest (it stores every tracked wallet's prints), and the
 * engine's advanceCoverage moves the range up to now once it reaches into the connection. Read to now instead, every
 * restart had each wallet re-read up to 2,000 fills the index already held (2026-11-07: 87% of the board wallets' held
 * fills over an hour old, median 19 h, the copy setup's replay walking the rest from Hyperliquid in the browser).
 */
export const BRIDGE_PAST_MS = 60_000;

export async function hlSyncFills(store: IndexStore, address: string, fromT: number, o: { maxPages: number; now: number; streamSince?: number | null }): Promise<SyncResult> {
  let pages = 0;
  let rows = 0;
  const run = async (lower: number, stopAt: number | null, endT: number | null = null) => {
    let start = lower;
    let firstT: number | null = null;
    let lastT = lower;
    for (;;) {
      const page = await hlInfo.post<HlFillRaw[]>(
        endT === null
          ? { type: 'userFillsByTime', user: address, startTime: start, aggregateByTime: true }
          : { type: 'userFillsByTime', user: address, startTime: start, endTime: endT, aggregateByTime: true },
        { background: true, timeoutMs: 25_000 },
      );
      pages++;
      mark('hl:fills');
      const list = Array.isArray(page) ? page : [];
      const got = list.flatMap((f) => hlFillRow(address, f) ?? []);
      await store.putFillsSliced(got, yieldLoop);
      rows += list.length;
      for (const r of got) {
        if (firstT === null || r.t < firstT) firstT = r.t;
        if (r.t > lastT) lastT = r.t;
      }
      // REST now holds [start, lastT] (or to now): the stream's copies of those fills go.
      await store.dropStreamRowsAsync('hyperliquid', address, start, list.length < HL_FILL_PAGE ? (endT ?? o.now) : lastT, yieldLoop);
      if (list.length < HL_FILL_PAGE) return { end: 'now' as const, firstT, lastT };
      if (stopAt !== null && lastT >= stopAt) return { end: 'met' as const, firstT, lastT };
      if (pages >= o.maxPages) return { end: 'partial' as const, firstT, lastT };
      start = lastT > start ? lastT : start + 1;
    }
  };

  const held = store.coverage('hyperliquid', address, 'fills');
  if (!held) {
    const page = await hlInfo.post<HlFillRaw[]>(
      { type: 'userFills', user: address, aggregateByTime: true },
      { background: true, timeoutMs: 25_000 },
    );
    pages++;
    mark('hl:fills');
    const list = Array.isArray(page) ? page : [];
    const got = list.flatMap((f) => hlFillRow(address, f) ?? []);
    await store.putFillsSliced(got, yieldLoop);
    rows += list.length;
    const minT = got.reduce((m, r) => Math.min(m, r.t), o.now);
    await store.dropStreamRowsAsync('hyperliquid', address, minT, o.now, yieldLoop);
    // Fewer than a page: that is the whole history.
    const whole = list.length < HL_FILL_PAGE;
    store.addCoverage('hyperliquid', address, 'fills', whole ? { fromT: Math.min(fromT, minT), toT: o.now, exhausted: true } : { fromT: minT, toT: o.now }, o.now);
  }
  {
    if (held && held.toT < o.now) {
      const since = o.streamSince ?? null;
      const bridgeTo = since !== null && since > held.toT ? since + BRIDGE_PAST_MS : null;
      if (since !== null && since <= held.toT) {
        // THE STREAM COVERS IT (2026-11-08): the held range reaches into the stream's current connection, which has every
        // print since (the engine's advanceCoverage keeps it within 30 s of now). The REST page here asked [toT, now] and
        // came back empty, 20 weight each: with the two-hourly resyncs that was about the whole board budget, ~6 reads a
        // minute with 1,500 waiting. Nothing is asked; the page budget goes to the reach-back below.
        store.touchRest('hyperliquid', address, 'fills', o.now);
      } else if (bridgeTo !== null && bridgeTo < o.now) {
        // Only the gap before the stream's connection; the stream's rows after it stay.
        const r = await run(held.toT, null, bridgeTo);
        store.addCoverage('hyperliquid', address, 'fills', { fromT: held.toT, toT: r.end === 'now' ? bridgeTo : r.lastT }, o.now);
      } else {
        const r = await run(held.toT, null);
        store.addCoverage('hyperliquid', address, 'fills', { fromT: held.toT, toT: r.end === 'now' ? o.now : r.lastT }, o.now);
      }
    }
    const cur = store.coverage('hyperliquid', address, 'fills')!;
    if (cur.fromT > fromT && !cur.exhausted && pages < o.maxPages) {
      const r = await run(fromT, cur.fromT);
      // Only a pass that met the held range (or reached now) closes the gap.
      if (r.end !== 'partial') {
        store.addCoverage('hyperliquid', address, 'fills', { fromT, toT: r.end === 'now' ? o.now : Math.max(r.lastT, cur.fromT), exhausted: fromT === 0 }, o.now);
      }
    }
  }
  // HL serves only the newest 10k fills: once that many are held, nothing
  // older than the oldest held one can be known.
  const ext = store.fillExtent('hyperliquid', address);
  const cov = store.coverage('hyperliquid', address, 'fills');
  if (cov && ext.count >= CAP_NEAR && ext.minT !== null && ext.minT > cov.fromT) {
    store.setCoverage('hyperliquid', address, 'fills', { ...cov, fromT: ext.minT, exhausted: true, capped: true });
  }
  return { rows, pages, reachedNow: true };
}

/**
 * The cheapest read that answers "more than one trade since `fromT`?" for a
 * wallet not held yet: the last ten minutes first (an active trader answers
 * there, with few rows), then the whole window (an inactive one returns few
 * rows there). Returns the weight spent.
 */
export async function hlQuickCheck(store: IndexStore, address: string, fromT: number, now: number, streamSince: number | null = null): Promise<number> {
  if (store.coverage('hyperliquid', address, 'fills')) {
    const r = await hlSyncFills(store, address, fromT, { maxPages: 1, now, streamSince });
    return r.pages * 20 + Math.ceil(r.rows / 20);
  }
  const sliceFrom = Math.max(fromT, now - 10 * 60_000);
  const page = await hlInfo.post<HlFillRaw[]>(
    { type: 'userFillsByTime', user: address, startTime: sliceFrom, aggregateByTime: true },
    { background: true, timeoutMs: 25_000 },
  );
  const list = Array.isArray(page) ? page : [];
  const rows = list.flatMap((f) => hlFillRow(address, f) ?? []);
  store.putFills(rows);
  const lastT = rows.reduce((m, r) => Math.max(m, r.t), sliceFrom);
  store.addCoverage(
    'hyperliquid',
    address,
    'fills',
    { fromT: sliceFrom, toT: list.length < HL_FILL_PAGE ? now : lastT, exhausted: sliceFrom === 0 },
    now,
  );
  let cost = 20 + Math.ceil(list.length / 20);
  if (store.orderCount('hyperliquid', address, fromT) >= 2) return cost;
  if (sliceFrom > fromT) {
    const r = await hlSyncFills(store, address, fromT, { maxPages: 1, now, streamSince });
    cost += r.pages * 20 + Math.ceil(r.rows / 20);
    if (store.orderCount('hyperliquid', address, fromT) >= 2) return cost;
  }
  // No trades of its own: it may trade through sub-accounts.
  if (store.orderCount('hyperliquid', address, fromT) === 0) cost += await hlSubAccountFills(store, address, fromT, now);
  return cost;
}

/** Candidates for a published window, best first, from the leaderboard file. */
export function* hlCandidates(snap: LbSnapshot, window: Window, side: Side): Generator<Candidate> {
  const order = snap.order('pnl', window);
  const pnl = snap.data.cols[`pnl:${window}`];
  const vol = snap.data.cols[`volume:${window}`];
  const at = (i: number): Candidate => {
    const v = vol[i]!;
    return { address: snap.data.addresses[i]!, pnl: pnl[i]!, volume: Number.isNaN(v) ? null : v };
  };
  if (side === 'top') {
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      if (Number.isNaN(pnl[i]!)) return;
      yield at(i);
    }
  } else {
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k]!;
      if (Number.isNaN(pnl[i]!)) continue;
      yield at(i);
    }
  }
}

/** PnL change since `fromMs` on a cumulative series (oldest first). Starts at the first point if the series is younger. */
export function pnlSince(points: ReadonlyArray<{ t: number; pnl: number | null }>, fromMs: number): number | null {
  const pts = points.filter((p): p is { t: number; pnl: number } => typeof p.pnl === 'number' && Number.isFinite(p.pnl)).sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  let base = pts[0]!;
  for (const p of pts) {
    if (p.t <= fromMs) base = p;
    else break;
  }
  return pts[pts.length - 1]!.pnl - base.pnl;
}

/** 90d / ytd PnL and account value from one portfolio read (20 weight). */
export async function hlChartWindows(address: string, starts: { d90: number; ytd: number }): Promise<{ d90: number | null; ytd: number | null; accountValue: number | null }> {
  const p = await hlInfo.post<HlPortfolio>({ type: 'portfolio', user: address }, { background: true, ttlMs: 30 * 60_000, timeoutMs: 20_000 });
  const series = equitySeries(portfolioWindow(p, 'allTime'));
  const av = [...series].reverse().find((pt) => pt.accountValue !== null)?.accountValue ?? null;
  return { d90: pnlSince(series, starts.d90), ytd: pnlSince(series, starts.ytd), accountValue: av };
}

/**
 * A master account whose own fills are empty but whose leaderboard row shows
 * volume trades through sub-accounts: Hyperliquid's leaderboard adds the subs
 * into the master's row. Their fills since `fromT` are filed under the master
 * (one page each, up to 10 subs), so its trade count matches its PnL. Returns
 * the weight spent.
 */
export async function hlSubAccountFills(store: IndexStore, master: string, fromT: number, now: number): Promise<number> {
  const subs = await hlInfo.post<Array<{ subAccountUser?: string }>>({ type: 'subAccounts', user: master }, { background: true, ttlMs: 60 * 60_000, timeoutMs: 20_000 });
  const list = (Array.isArray(subs) ? subs : []).flatMap((s) => (s?.subAccountUser ? [s.subAccountUser.toLowerCase()] : [])).slice(0, 10);
  let cost = 20;
  for (const sub of list) {
    const page = await hlInfo.post<HlFillRaw[]>(
      { type: 'userFillsByTime', user: sub, startTime: fromT, aggregateByTime: true },
      { background: true, timeoutMs: 25_000 },
    );
    const got = (Array.isArray(page) ? page : []).flatMap((f) => hlFillRow(master, f) ?? []);
    store.putFills(got);
    cost += 20 + Math.ceil(got.length / 20);
    if (store.orderCount('hyperliquid', master, fromT) >= 2) break;
  }
  void now;
  return cost;
}
