/**
 * Lighter (lighter.xyz) public reads. Verified live 2026-09-28, no keys:
 *
 *   /api/v1/pnlLeaderboard  time_window 24h|7d|30d|all, sort_by pnl|roi|volume|
 *                           account_value, sort_dir asc|desc, limit <=100, offset.
 *                           Every ranked L1 address (~97k), both ends.
 *   /api/v1/accountsByL1Address  an address's (sub)account indices
 *   /api/v1/account?by=index     balances, positions, total_asset_value
 *   /api/v1/trades?account_index newest first, cursor paged, 100 a page; each
 *                           row names BOTH accounts (ask/bid_account_id) and
 *                           the realised PnL of the side that closed
 *   /api/v1/orderBooks      market id -> symbol
 *
 * Budget: 60 requests / minute per IP unauthenticated (docs). The API thread
 * and the indexer worker each get a share.
 */
import type { Window } from '../types.js';
import { Pacer, lowerAddress, num } from './http.js';

export const LIGHTER_API = (process.env.VALUESCAN_LIGHTER_API?.trim() || 'https://mainnet.zklighter.elliot.ai').replace(/\/+$/, '');
/** Public trade stream (verified 2026-09-29): `trade/{market_id}` channels name both sub-accounts. */
export const LIGHTER_WS = process.env.VALUESCAN_LIGHTER_WS?.trim() || 'wss://mainnet.zklighter.elliot.ai/stream';

/** This thread's share of Lighter's 60/min (the worker sets its own in the env). */
export const lighterPacer = new Pacer('Lighter', Number(process.env.VALUESCAN_LIGHTER_PER_MIN) || 20, 8);

export const LIGHTER_WINDOW: Record<Window, string> = { '1d': '24h', '7d': '7d', '30d': '30d', all: 'all' };
export const LIGHTER_PAGE = 100;

export interface LighterLbRow {
  address: string;
  pnl: number;
  roi: number | null;
  volume: number | null;
  accountValue: number | null;
  rank: number;
}

export async function lighterLeaderboard(
  window: Window,
  o: { dir: 'asc' | 'desc'; offset: number; limit?: number; sortBy?: 'pnl' | 'roi' | 'volume' | 'account_value' },
  pacer = lighterPacer,
): Promise<{ rows: LighterLbRow[]; total: number; updatedAt: number }> {
  const qs = new URLSearchParams({
    time_window: LIGHTER_WINDOW[window],
    sort_by: o.sortBy ?? 'pnl',
    sort_dir: o.dir,
    limit: String(o.limit ?? LIGHTER_PAGE),
    offset: String(o.offset),
  });
  const j = await pacer.get<{ entries?: Array<Record<string, unknown>>; total?: number; updated_at?: number }>(`${LIGHTER_API}/api/v1/pnlLeaderboard?${qs}`);
  const rows = (j.entries ?? []).flatMap((e): LighterLbRow[] => {
    const address = lowerAddress(e.l1_address);
    const pnl = num(e.pnl);
    if (!address || pnl === null) return [];
    return [{ address, pnl, roi: num(e.roi), volume: num(e.volume), accountValue: num(e.account_value), rank: num(e.rank) ?? 0 }];
  });
  return { rows, total: j.total ?? rows.length, updatedAt: (j.updated_at ?? 0) * 1000 };
}

/** Sub-account indices of an L1 address; [] when it has no Lighter account. */
export async function lighterAccounts(address: string, pacer = lighterPacer): Promise<number[]> {
  try {
    const j = await pacer.get<{ sub_accounts?: Array<{ index?: number }> }>(
      `${LIGHTER_API}/api/v1/accountsByL1Address?l1_address=${encodeURIComponent(address)}`,
    );
    return (j.sub_accounts ?? []).flatMap((s) => (typeof s.index === 'number' ? [s.index] : []));
  } catch (e) {
    if ((e as { status?: number }).status === 400 || (e as { status?: number }).status === 404) return [];
    throw e;
  }
}

/**
 * One address's row on Lighter's ranking for a window (`search` by address).
 * Its account value includes spot and pool shares, which an account's
 * `total_asset_value` does not.
 */
export async function lighterRankRow(address: string, window: Window, pacer = lighterPacer): Promise<LighterLbRow | null> {
  const qs = new URLSearchParams({ time_window: LIGHTER_WINDOW[window], sort_by: 'pnl', sort_dir: 'desc', limit: '5', offset: '0', search: address });
  const j = await pacer.get<{ entries?: Array<Record<string, unknown>> }>(`${LIGHTER_API}/api/v1/pnlLeaderboard?${qs}`);
  const e = (j.entries ?? []).find((x) => lowerAddress(x.l1_address) === address.toLowerCase());
  const pnl = num(e?.pnl);
  if (!e || pnl === null) return null;
  return { address: address.toLowerCase(), pnl, roi: num(e.roi), volume: num(e.volume), accountValue: num(e.account_value), rank: num(e.rank) ?? 0 };
}

export interface LighterPosition {
  symbol: string;
  sign: number;
  position: number;
  entry: number | null;
  value: number | null;
  uPnl: number | null;
  liq: number | null;
  imf: number | null;
  isolated: boolean;
}

export async function lighterAccount(index: number, pacer = lighterPacer): Promise<{ totalValue: number | null; positions: LighterPosition[] } | null> {
  const j = await pacer.get<{ accounts?: Array<Record<string, unknown>> }>(`${LIGHTER_API}/api/v1/account?by=index&value=${index}`);
  const a = j.accounts?.[0];
  if (!a) return null;
  const positions = ((a.positions as Array<Record<string, unknown>> | undefined) ?? []).flatMap((p): LighterPosition[] => {
    const size = num(p.position) ?? 0;
    if (!size) return [];
    return [{
      symbol: String(p.symbol ?? p.market_id),
      sign: num(p.sign) ?? 1,
      position: Math.abs(size),
      entry: num(p.avg_entry_price),
      value: num(p.position_value),
      uPnl: num(p.unrealized_pnl),
      // "0" is Lighter's "no liquidation price".
      liq: num(p.liquidation_price) || null,
      imf: num(p.initial_margin_fraction),
      isolated: p.margin_mode === 1,
    }];
  });
  return { totalValue: num(a.total_asset_value) ?? num(a.collateral), positions };
}

export interface LighterTrade {
  id: string;
  t: number;
  marketId: number;
  price: number;
  size: number;
  usd: number;
  askAccount: number;
  bidAccount: number;
  askOrder: string;
  bidOrder: string;
  askPnl: number | null;
  bidPnl: number | null;
}

/** One page of an account's trades, newest first. */
export async function lighterTrades(
  accountIndex: number,
  o: { limit: number; cursor?: string },
  pacer = lighterPacer,
): Promise<{ trades: LighterTrade[]; next: string | null }> {
  const qs = new URLSearchParams({ account_index: String(accountIndex), sort_by: 'timestamp', limit: String(o.limit) });
  if (o.cursor) qs.set('cursor', o.cursor);
  const j = await pacer.get<{ trades?: Array<Record<string, unknown>>; next_cursor?: string }>(`${LIGHTER_API}/api/v1/trades?${qs}`);
  const trades = (j.trades ?? []).flatMap((r): LighterTrade[] => {
    const t = num(r.timestamp);
    const price = num(r.price);
    const size = num(r.size);
    if (t === null || price === null || size === null) return [];
    return [{
      id: String(r.trade_id_str ?? r.trade_id),
      t,
      marketId: num(r.market_id) ?? -1,
      price,
      size,
      usd: num(r.usd_amount) ?? price * size,
      askAccount: num(r.ask_account_id) ?? -1,
      bidAccount: num(r.bid_account_id) ?? -1,
      askOrder: String(r.ask_id_str ?? r.ask_id ?? ''),
      bidOrder: String(r.bid_id_str ?? r.bid_id ?? ''),
      askPnl: num(r.ask_account_pnl),
      bidPnl: num(r.bid_account_pnl),
    }];
  });
  return { trades, next: j.next_cursor && trades.length >= o.limit ? j.next_cursor : null };
}

/** Active markets only (id -> symbol): what the stream subscribes to. One request. */
export async function lighterActiveMarkets(pacer = lighterPacer): Promise<Map<number, string>> {
  const j = await pacer.get<{ order_books?: Array<{ market_id?: number; symbol?: string; status?: string }> }>(`${LIGHTER_API}/api/v1/orderBooks`);
  const map = new Map<number, string>();
  for (const m of j.order_books ?? []) if (typeof m.market_id === 'number' && m.symbol && m.status === 'active') map.set(m.market_id, m.symbol);
  return map;
}

let markets: { at: number; map: Map<number, string> } | null = null;

/** Market id -> symbol, cached for an hour. */
export async function lighterMarkets(pacer = lighterPacer): Promise<Map<number, string>> {
  if (markets && Date.now() - markets.at < 60 * 60_000) return markets.map;
  const j = await pacer.get<{ order_books?: Array<{ market_id?: number; symbol?: string }> }>(`${LIGHTER_API}/api/v1/orderBooks`);
  const map = new Map<number, string>();
  for (const m of j.order_books ?? []) if (typeof m.market_id === 'number' && m.symbol) map.set(m.market_id, m.symbol);
  markets = { at: Date.now(), map };
  return map;
}

const RESOLUTION: Record<Window, { res: string; span: number; count: number }> = {
  '1d': { res: '1h', span: 86_400, count: 25 },
  '7d': { res: '1h', span: 7 * 86_400, count: 169 },
  '30d': { res: '1d', span: 30 * 86_400, count: 31 },
  all: { res: '1d', span: 0, count: 1_000 },
};

/**
 * An account's PnL per window, rebased to 0 at the window start. Lighter's
 * series is cumulative trade (perps + spot), pool and staking PnL.
 */
export async function lighterPnlSeries(index: number, window: Window, pacer = lighterPacer): Promise<Array<{ t: number; pnl: number }>> {
  const r = RESOLUTION[window];
  const now = Math.floor(Date.now() / 1000);
  const qs = new URLSearchParams({
    by: 'index',
    value: String(index),
    resolution: r.res,
    start_timestamp: String(r.span ? now - r.span : 0),
    end_timestamp: String(now),
    count_back: String(r.count),
  });
  const j = await pacer.get<{ pnl?: Array<Record<string, unknown>> }>(`${LIGHTER_API}/api/v1/pnl?${qs}`);
  const pts = (j.pnl ?? []).flatMap((p) => {
    const t = num(p.timestamp);
    if (t === null) return [];
    const total = (num(p.trade_pnl) ?? 0) + (num(p.trade_spot_pnl) ?? 0) + (num(p.pool_pnl) ?? 0) + (num(p.staking_pnl) ?? 0);
    return [{ t: t * 1000, pnl: total }];
  }).sort((a, b) => a.t - b.t);
  const base = pts[0]?.pnl ?? 0;
  return pts.map((p) => ({ t: p.t, pnl: p.pnl - base }));
}
