/**
 * Arcus (arcus.xyz) public reads. Verified live 2026-09-28, no keys:
 *
 *   /v1/leaderboard   top 100 by pnl|volume|fees over 24h|30d|all (no paging,
 *                     no ascending order); `address=` returns one trader's row.
 *                     Integers in 1e9 units; pnl is REALISED only.
 *   /v1/portfolio     per address: equity and PnL series for day / week /
 *                     month / all (decimal strings, timestamps in µs)
 *   /v1/fills         per address, newest first, <=1000, from/to in µs; carries
 *                     closedPnl, fee, orderId
 *   /v1/account       balances and positions
 *   /v1/trades        recent public trades per market; each row names the maker
 *                     AND the taker address (so does the `trades` WS channel)
 *   /v1/markets       market list
 *
 * Budget: 1,500 weight / minute per IP; account 2, the rest 20 (docs).
 */
import type { EquityPoint, Window } from '../types.js';
import { HttpError, Pacer, lowerAddress, num } from './http.js';

export const ARCUS_API = (process.env.VALUESCAN_ARCUS_API?.trim() || 'https://api.arcus.xyz').replace(/\/+$/, '');
export const ARCUS_WS = process.env.VALUESCAN_ARCUS_WS?.trim() || 'wss://api.arcus.xyz/v1/ws';

/** This thread's share of Arcus's 1,500 weight/min. */
export const arcusPacer = new Pacer('Arcus', Number(process.env.VALUESCAN_ARCUS_WEIGHT) || 300);

const E9 = 1e9;

/**
 * Arcus is invite-gated: an address with no Arcus account is answered
 * `403 {"error":"address not on access whitelist"}` on every per-address read
 * (verified live 2026-09-28). That is "no account", not a failed read.
 */
export function arcusNoAccount(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 404 || (e.status === 403 && /whitelist/i.test(e.message)));
}

/** A per-address read; `empty` when the address has no Arcus account. */
export async function arcusRead<T>(pacer: Pacer, url: string, weight: number, empty: T): Promise<T> {
  try {
    return await pacer.get<T>(url, weight);
  } catch (e) {
    if (arcusNoAccount(e)) return empty;
    throw e;
  }
}

export type ArcusLbWindow = '24h' | '30d' | 'all';
export const ARCUS_LB_WINDOW: Partial<Record<Window, ArcusLbWindow>> = { '1d': '24h', '30d': '30d', all: 'all' };

export interface ArcusLbRow {
  address: string;
  realizedPnl: number;
  volume: number;
  fees: number;
  rank: number;
}

export async function arcusLeaderboard(window: ArcusLbWindow, sortBy: 'pnl' | 'volume' | 'fees', pacer = arcusPacer): Promise<ArcusLbRow[]> {
  const j = await pacer.get<{ entries?: Array<Record<string, unknown>> }>(
    `${ARCUS_API}/v1/leaderboard?sortBy=${sortBy}&window=${window}&limit=100`,
    20,
  );
  return (j.entries ?? []).flatMap((e): ArcusLbRow[] => {
    const address = lowerAddress(e.address);
    const pnl = num(e.pnl);
    if (!address || pnl === null) return [];
    return [{ address, realizedPnl: pnl / E9, volume: (num(e.volume) ?? 0) / E9, fees: (num(e.feesPaid) ?? 0) / E9, rank: num(e.rank) ?? 0 }];
  });
}

const RANGE: Record<string, Window> = { totalDay: '1d', totalWeek: '7d', totalMonth: '30d', totalAll: 'all' };

export interface ArcusPortfolio {
  /** Total PnL per window (realised + open), from the last point of each series. */
  pnl: Partial<Record<Window, number>>;
  equity: Partial<Record<Window, EquityPoint[]>>;
  accountValue: number | null;
  lifetimeVolume: number | null;
}

export async function arcusPortfolio(address: string, pacer = arcusPacer): Promise<ArcusPortfolio> {
  const j = await arcusRead<{ data?: Array<[string, { accountEquityHistory?: Array<[number, string]>; pnlHistory?: Array<[number, string]> }]>; lifetimeVolume?: unknown }>(
    pacer,
    `${ARCUS_API}/v1/portfolio?address=${address}`,
    20,
    {},
  );
  const out: ArcusPortfolio = { pnl: {}, equity: {}, accountValue: null, lifetimeVolume: num(j.lifetimeVolume) };
  for (const [name, s] of j.data ?? []) {
    const w = RANGE[name];
    if (!w) continue;
    const eq = new Map<number, EquityPoint>();
    const at = (us: number) => {
      const t = Math.floor(us / 1000);
      let p = eq.get(t);
      if (!p) eq.set(t, (p = { t, accountValue: null, pnl: null }));
      return p;
    };
    for (const [us, v] of s.accountEquityHistory ?? []) at(us).accountValue = num(v);
    for (const [us, v] of s.pnlHistory ?? []) at(us).pnl = num(v);
    const pts = [...eq.values()].sort((a, b) => a.t - b.t);
    out.equity[w] = pts;
    const last = [...pts].reverse().find((p) => p.pnl !== null);
    if (last?.pnl != null) out.pnl[w] = last.pnl;
    const av = [...pts].reverse().find((p) => p.accountValue !== null)?.accountValue ?? null;
    if (av !== null && (out.accountValue === null || w === '1d')) out.accountValue = av;
  }
  return out;
}

/** closedPnl without the fee; 0 on an opening fill. */
export function grossPnl(closed: number | null, fee: number | null, effect: string): number | null {
  if (closed === null) return null;
  if (/^OPEN/i.test(effect)) return 0;
  return closed + (fee ?? 0);
}

export interface ArcusFill {
  id: string;
  t: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  fee: number | null;
  closedPnl: number | null;
  orderId: string | null;
}

/** Fills newest first; `from`/`to` in ms. */
export async function arcusFills(address: string, o: { from?: number; to?: number; limit?: number }, pacer = arcusPacer): Promise<ArcusFill[]> {
  const qs = new URLSearchParams({ address, limit: String(o.limit ?? 1000) });
  if (o.from !== undefined) qs.set('from', String(Math.floor(o.from * 1000)));
  if (o.to !== undefined) qs.set('to', String(Math.floor(o.to * 1000)));
  const j = await arcusRead<{ fills?: Array<Record<string, unknown>> }>(pacer, `${ARCUS_API}/v1/fills?${qs}`, 20, {});
  return (j.fills ?? []).flatMap((f): ArcusFill[] => {
    const created = num(f.createdAt);
    const price = num(f.price);
    const size = num(f.size);
    if (created === null || price === null || size === null) return [];
    return [{
      id: String(f.tradeId),
      t: Math.floor(created / 1000),
      symbol: String(f.marketDisplayName ?? f.marketId),
      side: f.side === 'SELL' ? 'SELL' : 'BUY',
      price,
      size,
      fee: num(f.fee),
      // Arcus books the fee into closedPnl (a taker open shows -fee). Stored gross,
      // as Hyperliquid reports it, so an open is not a losing close and PnL - fee is net.
      closedPnl: grossPnl(num(f.closedPnl), num(f.fee), String(f.positionEffect ?? '')),
      orderId: typeof f.orderId === 'string' ? f.orderId : null,
    }];
  });
}

export interface ArcusPosition {
  symbol: string;
  size: number;
  entry: number | null;
  mark: number | null;
  uPnl: number | null;
  liq: number | null;
  leverage: number | null;
}

/** Balances and open positions (verified shape: `positions` keyed by market id, signed `size`). */
export async function arcusAccount(address: string, pacer = arcusPacer): Promise<{ positions: ArcusPosition[]; equity: number | null } | null> {
  const j = await arcusRead<{ equity?: unknown; positions?: Record<string, Record<string, unknown>> | null }>(
    pacer,
    `${ARCUS_API}/v1/account?address=${address}`,
    2,
    {},
  );
  const positions = Object.values(j.positions ?? {}).flatMap((p): ArcusPosition[] => {
    const size = num(p.size);
    if (!size) return [];
    return [{
      symbol: String(p.marketDisplayName ?? p.marketId),
      size,
      entry: num(p.averageEntryPrice),
      mark: num(p.markPx),
      uPnl: num(p.unrealizedPnl),
      liq: null,
      leverage: num(p.leverage),
    }];
  });
  return { positions, equity: num(j.equity) };
}

let markets: { at: number; list: string[] } | null = null;

export async function arcusMarkets(pacer = arcusPacer): Promise<string[]> {
  if (markets && Date.now() - markets.at < 60 * 60_000) return markets.list;
  const j = await pacer.get<unknown>(`${ARCUS_API}/v1/markets`, 20);
  const raw = Array.isArray(j) ? j : ((j as { markets?: unknown[] }).markets ?? Object.values(j as object));
  const list = (raw as Array<{ marketDisplayName?: string; status?: string }>).flatMap((m) =>
    m?.marketDisplayName && (m.status ?? 'ONLINE') === 'ONLINE' ? [m.marketDisplayName] : [],
  );
  markets = { at: Date.now(), list };
  return list;
}
