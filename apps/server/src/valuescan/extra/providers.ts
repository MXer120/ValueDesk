/**
 * Venue providers for trade.xyz, Lighter and Arcus: what Scan and the
 * per-venue list endpoint need (a trader's profile, fills, and the venue's
 * own ranking where it publishes one). Whales and positioning are not
 * served for these venues yet (NotAvailable).
 *
 * The leaderboard page's ranked hundreds do NOT come from here; they come
 * from the indexer (src/indexer), which also nets these venues with the rest.
 */
import {
  NotAvailable,
  type LeaderboardPage,
  type LeaderboardQuery,
  type TraderProfile,
  type TraderRow,
  type Venue,
  type VenueProvider,
  type VsFill,
  type VsPosition,
} from '../types.js';
import { hlInfo } from '../hyperliquid/index.js';
import { mapFill, mapPositions } from '../hyperliquid/mappers.js';
import type { HlClearinghouseState, HlFillRaw } from '../hyperliquid/raw.js';
import { ARCUS_LB_WINDOW, arcusAccount, arcusFills, arcusLeaderboard, arcusPortfolio } from './arcus.js';
import { lighterAccount, lighterAccounts, lighterLeaderboard, lighterMarkets, lighterPnlSeries, lighterRankRow, lighterTrades } from './lighter.js';
import { num } from './http.js';

/** A small time-boxed memo: Scan re-polls every 30 s and Lighter's budget is 60 requests / minute per IP. */
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  if (memo.size > 2_000) memo.clear();
  return value;
}

const notYet = (what: string) => async (): Promise<never> => {
  throw new NotAvailable(what);
};

function baseRow(venue: Venue, address: string): TraderRow {
  return { venue, address, accountValue: null, pnl: {}, roi: {}, volume: {} };
}

// --- trade.xyz: Hyperliquid's HIP-3 dex "xyz" ------------------------------------------

export const XYZ_PREFIX = 'xyz:';

/** The newest fills (HL serves the latest 2,000 on `userFills`), xyz markets only, newest first. */
async function xyzFills(address: string): Promise<VsFill[]> {
  const raw = await hlInfo.post<HlFillRaw[]>({ type: 'userFills', user: address, aggregateByTime: true }, { ttlMs: 30_000, timeoutMs: 25_000 });
  return (Array.isArray(raw) ? raw : []).filter((f) => f.coin.startsWith(XYZ_PREFIX)).map(mapFill).sort((a, b) => b.time - a.time);
}

export const tradexyzProvider: VenueProvider = {
  venue: 'tradexyz',
  leaderboard: notYet('trade.xyz publishes no ranking; its hundreds come from the index'),
  async trader(address) {
    const [st, fills] = await Promise.all([
      hlInfo.post<HlClearinghouseState>({ type: 'clearinghouseState', user: address, dex: 'xyz' }, { ttlMs: 10_000 }),
      xyzFills(address).catch(() => [] as VsFill[]),
    ]);
    const positions = mapPositions(st, 'xyz');
    const av = num(st?.marginSummary?.accountValue);
    if (!positions.length && !av && !fills.length) return null;
    const summary = baseRow('tradexyz', address);
    summary.accountValue = av;
    // Realised PnL (closed trades, net of fees) per window from the xyz fills: the
    // same figure the trade.xyz board ranks by. HL publishes no per-dex curve.
    const now = Date.now();
    const equity: TraderProfile['equity'] = {};
    const span: Record<'1d' | '7d' | '30d' | 'all', number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: Infinity };
    const asc = [...fills].sort((a, b) => a.time - b.time);
    for (const w of ['1d', '7d', '30d', 'all'] as const) {
      const from = now - span[w];
      let run = 0;
      const pts = asc.filter((f) => f.time >= from).map((f) => ({ t: f.time, accountValue: null, pnl: (run += (f.closedPnl ?? 0) - (f.fee ?? 0)) }));
      if (pts.length > 1) equity[w] = pts;
      summary.pnl[w] = pts.length ? run : null;
    }
    return { summary, positions, equity, updatedAt: now, source: 'Hyperliquid, dex xyz (PnL realised from fills)' } satisfies TraderProfile;
  },
  async fills(address, o) {
    return (await xyzFills(address)).filter((f) => (o.from === undefined || f.time >= o.from) && (o.to === undefined || f.time <= o.to)).slice(0, o.limit ?? 2000);
  },
  whales: notYet('trade.xyz whale feed is not served yet'),
  positioning: notYet('trade.xyz positioning is not served yet'),
};

// --- Lighter ----------------------------------------------------------------------------

const LIGHTER_SORT = { pnl: 'pnl', roi: 'roi', volume: 'volume', accountValue: 'account_value' } as const;

export const lighterProvider: VenueProvider = {
  venue: 'lighter',
  async leaderboard(q: LeaderboardQuery): Promise<LeaderboardPage> {
    const page = await lighterLeaderboard(q.window, {
      dir: q.side === 'worst' ? 'asc' : 'desc',
      offset: q.offset,
      limit: Math.min(100, q.limit),
      sortBy: q.side === 'worst' ? 'pnl' : LIGHTER_SORT[q.sort],
    });
    const rows = page.rows.map((r, i): TraderRow => ({
      ...baseRow('lighter', r.address),
      accountValue: r.accountValue,
      pnl: { [q.window]: r.pnl },
      roi: { [q.window]: r.roi },
      volume: { [q.window]: r.volume },
      rank: q.offset + i + 1,
      rankChange: null,
    }));
    return { rows, total: page.total, updatedAt: page.updatedAt || Date.now(), source: 'Lighter leaderboard' };
  },
  async trader(address) {
    const idx = await cached(`subs:${address}`, 60 * 60_000, () => lighterAccounts(address));
    if (!idx.length) return null;
    const accounts = (await Promise.all(idx.map((i) => cached(`acct:${i}`, 20_000, () => lighterAccount(i))))).filter((a) => !!a);
    const positions = accounts.flatMap((a) => a.positions).map((p): VsPosition => ({
      symbol: p.symbol,
      side: p.sign < 0 ? 'short' : 'long',
      size: p.position,
      notional: Math.abs(p.value ?? 0),
      entryPx: p.entry,
      markPx: p.value && p.position ? Math.abs(p.value) / p.position : null,
      liqPx: p.liq,
      uPnl: p.uPnl,
      leverage: p.imf ? Math.round(100 / p.imf) : null,
      marginMode: p.isolated ? 'isolated' : 'cross',
    }));
    const summary = baseRow('lighter', address);
    summary.accountValue = accounts.reduce<number | null>((s, a) => (a.totalValue === null ? s : (s ?? 0) + a.totalValue), null);
    // The curves are the main account's (sub-account 0); the figures are Lighter's own
    // ranking row per window (every sub-account, spot and pools included), as the board shows.
    const equity: TraderProfile['equity'] = {};
    for (const w of ['1d', '7d', '30d', 'all'] as const) {
      const [pts, row] = await Promise.all([
        cached(`pnl:${idx[0]}:${w}`, 5 * 60_000, () => lighterPnlSeries(idx[0]!, w)).catch(() => []),
        cached(`rank:${address}:${w}`, 5 * 60_000, () => lighterRankRow(address, w)).catch(() => null),
      ]);
      if (pts.length > 1) equity[w] = pts.map((p) => ({ t: p.t, accountValue: null, pnl: p.pnl }));
      summary.pnl[w] = row ? row.pnl : (pts[pts.length - 1]?.pnl ?? null);
      summary.volume[w] = row?.volume ?? null;
      if (w === 'all' && row?.accountValue != null) summary.accountValue = row.accountValue;
    }
    // Last active: the newest trade over every sub-account (one row each, cached).
    const newest = await Promise.all(idx.map((i) => cached(`last:${i}`, 5 * 60_000, async () =>
      (await lighterTrades(i, { limit: 1 })).trades[0]?.t ?? null).catch(() => null)));
    const last = Math.max(0, ...newest.filter((t): t is number => typeof t === 'number'));
    if (last > 0) summary.lastActive = last;
    return { summary, positions, equity, updatedAt: Date.now(), source: 'Lighter account' };
  },
  async fills(address, o) {
    const idx = await cached(`subs:${address}`, 60 * 60_000, () => lighterAccounts(address));
    const own = new Set(idx);
    const symbols = await lighterMarkets().catch(() => new Map<number, string>());
    const out: VsFill[] = [];
    const limit = o.limit ?? 2000;
    for (const index of idx) {
      let cursor: string | undefined;
      for (let page = 0; page < 20 && out.length < limit; page++) {
        const r = await lighterTrades(index, { limit: 100, cursor });
        for (const t of r.trades) {
          if (o.to !== undefined && t.t > o.to) continue;
          if (o.from !== undefined && t.t < o.from) { r.next = null; break; }
          const sell = own.has(t.askAccount);
          out.push({
            id: t.id,
            time: t.t,
            symbol: symbols.get(t.marketId) ?? String(t.marketId),
            side: sell ? 'sell' : 'buy',
            px: t.price,
            sz: t.size,
            notional: t.usd,
            fee: null,
            closedPnl: sell ? t.askPnl : t.bidPnl,
          });
        }
        if (!r.next) break;
        cursor = r.next;
      }
    }
    return out.sort((a, b) => b.time - a.time).slice(0, limit);
  },
  whales: notYet('Lighter whale feed is not served yet'),
  positioning: notYet('Lighter positioning is not served yet'),
};

// --- Arcus --------------------------------------------------------------------------------

export const arcusProvider: VenueProvider = {
  venue: 'arcus',
  async leaderboard(q: LeaderboardQuery): Promise<LeaderboardPage> {
    const w = ARCUS_LB_WINDOW[q.window];
    if (!w || q.side === 'worst' || q.offset >= 100) throw new NotAvailable('Arcus publishes a top 100 for 24h, 30d and all time only');
    const list = await arcusLeaderboard(w, q.sort === 'volume' ? 'volume' : 'pnl');
    const rows = list.slice(q.offset, q.offset + q.limit).map((r, i): TraderRow => ({
      ...baseRow('arcus', r.address),
      pnl: { [q.window]: r.realizedPnl },
      volume: { [q.window]: r.volume },
      rank: q.offset + i + 1,
      rankChange: null,
    }));
    return { rows, total: list.length, updatedAt: Date.now(), source: 'Arcus leaderboard (realized PnL)' };
  },
  async trader(address) {
    const [acct, port] = await Promise.all([arcusAccount(address), arcusPortfolio(address).catch(() => null)]);
    if (!acct?.positions.length && !acct?.equity && !port?.lifetimeVolume) return null;
    const positions = (acct?.positions ?? []).map((p): VsPosition => ({
      symbol: p.symbol,
      side: p.size < 0 ? 'short' : 'long',
      size: Math.abs(p.size),
      notional: Math.abs(p.size) * (p.mark ?? p.entry ?? 0),
      entryPx: p.entry,
      markPx: p.mark,
      liqPx: p.liq,
      uPnl: p.uPnl,
      leverage: p.leverage,
      marginMode: 'cross',
    }));
    const summary = baseRow('arcus', address);
    summary.accountValue = acct?.equity ?? port?.accountValue ?? null;
    for (const [w, v] of Object.entries(port?.pnl ?? {})) summary.pnl[w as keyof typeof summary.pnl] = v;
    // Last active: the newest fill (one row).
    const last = await arcusFills(address, { limit: 1 }).then((l) => l[0]?.t ?? null, () => null);
    if (last) summary.lastActive = last;
    return { summary, positions, equity: port?.equity ?? {}, updatedAt: Date.now(), source: 'Arcus account and portfolio' };
  },
  async fills(address, o) {
    return (await arcusFills(address, { from: o.from, to: o.to, limit: Math.min(1000, o.limit ?? 1000) })).map((f): VsFill => ({
      id: f.id,
      time: f.t,
      symbol: f.symbol,
      side: f.side === 'SELL' ? 'sell' : 'buy',
      px: f.price,
      sz: f.size,
      notional: f.price * f.size,
      fee: f.fee,
      closedPnl: f.closedPnl,
    }));
  },
  whales: notYet('Arcus whale feed is not served yet'),
  positioning: notYet('Arcus positioning is not served yet'),
};

// --- account detail for Scan's band -----------------------------------------------------------

import {
  arcusBalances, arcusFunding, arcusOpenOrders, arcusOrderHistory, hlBalances, hlCoinName, hlFunding,
  hlOpenOrders, hlOrderHistory, lighterBalances,
} from './account.js';
import type { VsBalance, VsFunding, VsOrder } from '../types.js';

export interface AccountDetail {
  openOrders?(address: string): Promise<VsOrder[]>;
  orderHistory?(address: string, o: { limit?: number }): Promise<VsOrder[]>;
  funding?(address: string, o: { from?: number; limit?: number }): Promise<VsFunding[]>;
  balances?(address: string): Promise<VsBalance[]>;
}

/**
 * What each venue publishes about an account beyond positions and fills.
 * A missing method means the venue does not serve it without the account's
 * own key (Lighter's orders and funding) - the band leaves that tab out.
 * SoDEX is absent: Scan draws SoDEX with the portfolio's own band.
 */
export const ACCOUNT_DETAIL: Partial<Record<Venue, AccountDetail>> = {
  hyperliquid: {
    openOrders: (a) => hlOpenOrders(a, 'hl'),
    orderHistory: (a, o) => hlOrderHistory(a, 'hl', o.limit),
    funding: (a, o) => hlFunding(a, 'hl', o),
    balances: hlBalances,
  },
  tradexyz: {
    openOrders: (a) => hlOpenOrders(a, 'xyz'),
    orderHistory: (a, o) => hlOrderHistory(a, 'xyz', o.limit),
    funding: (a, o) => hlFunding(a, 'xyz', o),
  },
  arcus: {
    openOrders: arcusOpenOrders,
    orderHistory: (a, o) => arcusOrderHistory(a, o.limit),
    funding: arcusFunding,
    balances: arcusBalances,
  },
  lighter: {
    balances: lighterBalances,
  },
};

/** Hyperliquid spot fills carry `@107`; show the pair. */
export async function nameSpotFills(fills: VsFill[]): Promise<VsFill[]> {
  if (!fills.some((f) => f.symbol.startsWith('@'))) return fills;
  const name = await hlCoinName();
  return fills.map((f) => (f.symbol.startsWith('@') ? { ...f, symbol: name(f.symbol) } : f));
}
