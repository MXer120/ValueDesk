/**
 * SoDEX inputs for the index.
 *
 * WINDOW PNL. mainnet-data.sodex.dev ranks ~135k wallets per window (24H /
 * 7D / 30D / ALL_TIME, hourly) but only SERVES the top 1,000, and
 * `sort_order=asc` is those 1,000 reversed (verified 2026-09-28: the "lowest"
 * row was +$11). So:
 *   - top boards read the PnL list (top 1,000 by PnL);
 *   - the volume list (top 1,000 by volume) carries PnL too, for free;
 *   - every other wallet's PnL is one `leaderboard/rank` lookup. The index
 *     looks up the accounts the trade stream saw trading, most volume first,
 *     which is where the losers are.
 * 90d and ytd come from each candidate's portfolio chart (90D and 1Y).
 *
 * FILLS. SoDEX's Cloudflare answers `/accounts/{a}/trades` with 1015 after
 * a handful of requests a minute from one IP (verified 2026-09-28: the fifth
 * in ~30 s, while the gateway's own header still showed 5,900 of 6,000 left).
 * So fills come from the public trade stream (every trade of every tracked
 * account, as it happens), and `/trades` is only a slow drip that reaches
 * back over the window. `/positions/history` (closed positions: win rate, and
 * proof of trades before the stream covers a window) is not limited that way.
 * All through the shared gateway client (sodex/rest.ts), so its budget and
 * cooldowns apply.
 */
import { enginePath } from '../config.js';
import { unwrapList, weightFor } from '../sodex/rest.js';
import { lbPage, lbRank, LB_PAGE_SIZE, portfolioChart } from '../valuedesk/sodex/data.js';
import { gwGet, tradesPage } from '../valuedesk/sodex/gateway.js';
import { chartSuspect, chartToEquity, LB_WINDOW, summariseChart, type ClosedPosition, type LbItem, type RawTrade } from '../valuedesk/sodex/mappers.js';
import type { Window } from '../valuedesk/types.js';
import { pnlSince, type SyncResult } from './hlSource.js';
import type { CloseRow, FillRow, HistoryKind, IndexStore } from './store.js';

/** The data host serves 20 pages of 50. */
export const LIST_PAGES = 1_000 / LB_PAGE_SIZE;
export const TRADES_PAGE = 1_000;
export const CLOSES_PAGE = 500;
/** Our own ceiling per engine: 40,000 fills. Past it the count reads "at least". */
export const MAX_FILLS_PER_ENGINE = 40_000;

const lower = (a: unknown): string | null => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null);

function itemRow(it: LbItem): { address: string; accountId: number | null; pnl: number; volume: number | null } | null {
  const address = lower(it.wallet_address);
  const pnl = Number(it.pnl_usd);
  if (!address || !Number.isFinite(pnl)) return null;
  const vol = Number(it.volume_usd);
  return { address, accountId: Number.isInteger(it.account_id) ? it.account_id : null, pnl, volume: Number.isFinite(vol) ? vol : null };
}

/**
 * Read both published lists for a window when the hourly snapshot moved.
 * Returns the snapshot time, or null when it had not moved.
 */
export async function syncLists(store: IndexStore, window: Window, lastSnapshot: number | null, now: number): Promise<number | null> {
  const lw = LB_WINDOW[window];
  const first = await lbPage(lw, 'pnl', 1, 'low');
  const snap = first.snapshot_ts;
  if (lastSnapshot !== null && snap === lastSnapshot) return null;
  const rows = new Map<string, { address: string; accountId: number | null; pnl: number; volume: number | null }>();
  const take = (items: LbItem[] | null | undefined) => {
    for (const it of items ?? []) {
      const r = itemRow(it);
      if (r && !rows.has(r.address)) rows.set(r.address, r);
    }
  };
  take(first.items);
  for (let p = 2; p <= LIST_PAGES; p++) {
    const pg = await lbPage(lw, 'pnl', p, 'low');
    if (!pg.items?.length) break;
    take(pg.items);
  }
  for (let p = 1; p <= LIST_PAGES; p++) {
    const pg = await lbPage(lw, 'volume', p, 'low');
    if (!pg.items?.length) break;
    take(pg.items);
  }
  const list = [...rows.values()];
  store.tx(() => {
    for (const r of list) store.upsertAccount('sodex', r.address, { accountId: r.accountId });
    store.putPnl('sodex', window, list, snap, now);
  });
  return snap;
}

/** One wallet's PnL for a window. False when the venue does not rank it. */
export async function lookupPnl(store: IndexStore, window: Window, address: string, now: number): Promise<boolean> {
  const r = await lbRank(LB_WINDOW[window], 'pnl', address, 'low');
  const row = r.found && r.item ? itemRow(r.item) : null;
  if (!row) return false;
  store.upsertAccount('sodex', row.address, { accountId: row.accountId });
  store.putPnl('sodex', window, [row], r.snapshot_ts || now, now);
  return true;
}

/** 90d / ytd PnL and account value from the account's charts (two data-host reads). */
export async function chartWindows(accountId: number, starts: { ytd: number }): Promise<{ d90: number | null; ytd: number | null; accountValue: number | null; suspect: string | null }> {
  const [c90, c1y] = await Promise.all([portfolioChart(accountId, '90D', 'low'), portfolioChart(accountId, '1Y', 'low').catch(() => null)]);
  // Analytics that booked a balance as profit rank nobody (sodex/mappers.ts chartSuspect).
  const suspect = chartSuspect(c1y) ?? chartSuspect(c90);
  if (suspect) return { d90: null, ytd: null, accountValue: null, suspect };
  const s90 = summariseChart(c90);
  return { d90: s90.pnl, ytd: c1y ? pnlSince(chartToEquity(c1y), starts.ytd) : null, accountValue: s90.accountValue, suspect: null };
}

/** Account value from the 24H chart (one data-host read). */
export async function accountValue(accountId: number): Promise<number | null> {
  return summariseChart(await portfolioChart(accountId, '24H', 'low')).accountValue;
}

// --- fills and closes -------------------------------------------------------------

export function sodexFillRow(address: string, t: RawTrade): FillRow | null {
  const px = Number(t.price);
  const sz = Number(t.quantity);
  const time = Number(t.time);
  if (!t.symbol || t.tradeID == null || !(px > 0) || !(sz > 0) || !Number.isFinite(time)) return null;
  const side = String(t.side).toUpperCase();
  const fee = Number(t.fee);
  return {
    venue: 'sodex',
    address,
    id: `${t.symbol}:${t.tradeID}`,
    t: time,
    symbol: t.symbol,
    side: side === 'BUY' || side === '1' ? 1 : -1,
    px,
    sz,
    // Fees are per coin (base coin on spot buys); only a quote-coin fee is a dollar amount.
    fee: Number.isFinite(fee) && (!t.feeCoin || /USD/i.test(t.feeCoin)) ? fee : null,
    closedPnl: null,
    oid: t.orderID != null ? String(t.orderID) : null,
    src: 1,
  };
}

export function sodexCloseRow(address: string, p: ClosedPosition & { id?: number | string }): CloseRow | null {
  const pnl = Number(p.realizedPnL);
  const t = Number(p.updatedAt ?? p.createdAt);
  if (p.id == null || !p.symbol || !Number.isFinite(pnl) || !Number.isFinite(t)) return null;
  const opened = Number(p.createdAt);
  return { venue: 'sodex', address, id: String(p.id), t, openedT: Number.isFinite(opened) ? opened : null, symbol: p.symbol, pnl };
}

type PageFn = (q: { startTime: number; endTime?: number }) => Promise<Array<{ t: number; put: () => void }>>;

/**
 * Newest-first pager over one history kind. Two phases, both bounded by
 * `maxPages` together:
 *   1. catch up: from now down to what is held (or to `fromT` on a first read);
 *   2. reach back: from the oldest held row down to `fromT`.
 * `endTime` is inclusive upstream, so the boundary rows come back again; the
 * primary key absorbs them.
 */
async function pageNewestFirst(
  store: IndexStore,
  address: string,
  kind: HistoryKind,
  pageSize: number,
  fetchPage: PageFn,
  fromT: number,
  o: { maxPages: number; now: number; rowCap: number },
): Promise<SyncResult> {
  let pages = 0;
  let rows = 0;
  const run = async (lower: number, upper: number | undefined): Promise<{ reached: boolean; minT: number }> => {
    let cursor = upper;
    let minT = upper ?? o.now;
    for (;;) {
      const page = await fetchPage({ startTime: lower, endTime: cursor });
      pages++;
      rows += page.length;
      for (const r of page) {
        r.put();
        if (r.t < minT) minT = r.t;
      }
      if (page.length < pageSize) return { reached: true, minT: lower };
      if (pages >= o.maxPages) return { reached: false, minT };
      const next = cursor !== undefined && minT >= cursor ? cursor - 1 : minT;
      if (next < lower) return { reached: true, minT: lower };
      cursor = next;
    }
  };

  const held = store.coverage('sodex', address, kind);
  if (!held) {
    const r = await run(fromT, undefined);
    store.addCoverage('sodex', address, kind, { fromT: r.minT, toT: o.now, exhausted: r.reached && fromT === 0 }, o.now);
    return { rows, pages, reachedNow: true };
  }
  // 1. catch up
  if (held.toT < o.now) {
    const r = await run(held.toT, undefined);
    if (!r.reached) {
      // A gap between what is held and the new rows: keep the newer range.
      store.addCoverage('sodex', address, kind, { fromT: r.minT, toT: o.now }, o.now);
      return { rows, pages, reachedNow: true };
    }
    store.addCoverage('sodex', address, kind, { fromT: held.toT, toT: o.now }, o.now);
  }
  // 2. reach back
  const now = store.coverage('sodex', address, kind)!;
  if (now.fromT > fromT && !now.exhausted && pages < o.maxPages) {
    const r = await run(fromT, now.fromT);
    const tooMany = store.fillExtent('sodex', address).count >= o.rowCap;
    store.addCoverage(
      'sodex',
      address,
      kind,
      { fromT: r.minT, toT: now.fromT, exhausted: (r.reached && fromT === 0) || tooMany, capped: tooMany },
      o.now,
    );
  }
  return { rows, pages, reachedNow: true };
}

export function syncTrades(
  store: IndexStore,
  address: string,
  engine: 'perps' | 'spot',
  fromT: number,
  o: { maxPages: number; now: number },
): Promise<SyncResult> {
  return pageNewestFirst(
    store,
    address,
    engine,
    TRADES_PAGE,
    async (q) => {
      const list = await tradesPage(engine, address, { limit: TRADES_PAGE, startTime: q.startTime, endTime: q.endTime });
      const rows = list.flatMap((t) => sodexFillRow(address, t) ?? []);
      store.putFills(rows);
      return rows.map((r) => ({ t: r.t, put: () => {} }));
    },
    fromT,
    { ...o, rowCap: MAX_FILLS_PER_ENGINE },
  );
}

/** Cheap first look: the newest `limit` fills since `fromT` on one engine (weight 20 + limit/20). */
export async function peekTrades(store: IndexStore, address: string, engine: 'perps' | 'spot', fromT: number, now: number, limit = 20): Promise<void> {
  const list = await tradesPage(engine, address, { limit, startTime: fromT });
  const rows = list.flatMap((t) => sodexFillRow(address, t) ?? []);
  store.putFills(rows);
  // A short page is the whole window: nothing else happened since `fromT`.
  if (list.length < limit) store.addCoverage('sodex', address, engine, { fromT, toT: now, exhausted: fromT === 0 }, now);
}

export function syncCloses(store: IndexStore, address: string, fromT: number, o: { maxPages: number; now: number }): Promise<SyncResult> {
  return pageNewestFirst(
    store,
    address,
    'closes',
    CLOSES_PAGE,
    async (q) => {
      const p = new URLSearchParams();
      p.set('startTime', String(q.startTime));
      if (q.endTime !== undefined) p.set('endTime', String(q.endTime));
      p.set('limit', String(CLOSES_PAGE));
      const path = `${enginePath('perps')}/accounts/${address}/positions/history?${p}`;
      const list = unwrapList<ClosedPosition & { id?: number }>(await gwGet<unknown>(path, weightFor(path, CLOSES_PAGE)), 'positions');
      const rows = list.flatMap((c) => sodexCloseRow(address, c) ?? []);
      store.putCloses(rows);
      return rows.map((r) => ({ t: r.t, put: () => {} }));
    },
    fromT,
    { ...o, rowCap: Number.MAX_SAFE_INTEGER },
  );
}

/** Gateway weight of one request of each kind, for the indexer's own pacing. */
export const WEIGHT = {
  peek: 21,
  tradesPage: 20 + TRADES_PAGE / 20,
  closesPage: 20 + CLOSES_PAGE / 20,
};
