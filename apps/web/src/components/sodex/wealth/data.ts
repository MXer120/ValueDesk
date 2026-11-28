/**
 * The Wealth versions' shared model and reads (WealthPage.tsx's localhost switch). Every figure is SoDEX's own: the
 * funds, quotes and trading status come through trading/wealth.ts and portfolio/useWealth.ts, exactly as the Original
 * reads them, and each fund's daily closes from SoDEX's price-history route. A figure SoDEX does not send is a dash or
 * is left out, never filled in.
 */
import { useEffect, useMemo, useState } from 'react';
import { readGateway } from '../../../trading/gateway';
import { readSsiCloses, ssiSpotOf } from '../../../trading/ssiSpot';

/** USDC Earn's daily unit price and its APY (server routes/wealthInfo.ts, from the Morpho vault behind it), read once an hour. */
let earnCache: { at: number; p: Promise<{ points: PricePoint[]; apy: PricePoint[] }> } | null = null;
export function readEarnSeries(): Promise<{ points: PricePoint[]; apy: PricePoint[] }> {
  if (earnCache && Date.now() - earnCache.at < 3_600_000) return earnCache.p;
  const p = fetch('/api/vs/wealth/history?fund=Morpho-Earn', { signal: AbortSignal.timeout(15_000) })
    .then(async (r) => {
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; points?: Array<[number, number]>; apy?: Array<[number, number]>; error?: string };
      if (!r.ok || !b.ok) throw new Error(b.error || `USDC Earn's history answered ${r.status}.`);
      const pts = (rows: Array<[number, number]> | undefined) => (rows ?? []).map(([t, v]) => ({ t, v })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v));
      return { points: pts(b.points).filter((x) => x.v > 0), apy: pts(b.apy) };
    });
  earnCache = { at: Date.now(), p };
  p.catch(() => { earnCache = null; });
  return p;
}
const readEarnHistory = (): Promise<PricePoint[]> => readEarnSeries().then((s) => s.points);
import {
  fundAction, fundLabel,
  type FundAction, type FundShelf, type JoinedHolding, type TradingStatus, type WealthEntry, type WealthFund, type WealthQuote,
} from '../../../trading/wealth';
import { DASH, MINUS } from '../../../format';
import { fmtNum } from '../../../numStyle';
import { logLoadFailure } from '../../LoadFailed';
import { useTradingStatuses, type WealthState } from '../../portfolio/useWealth';
import type { Tone } from '../../bots/kit/kit';

/** What /markets sends beside trading/wealth.ts's type, read as sent. */
export type Quote = WealthQuote & {
  apy24h?: string;
  apy1M?: string;
  roi3Y?: string;
  roiYtd?: string;
  prevClose?: string;
  dayHigh?: string;
  dayLow?: string;
};

export const SHELVES: readonly FundShelf[] = ['Stable Earn', 'Curated ETF', 'Specialty'];

/** A number SoDEX sent, or null. */
export function val(s: string | number | undefined | null): number | null {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface Headline { label: string; short: string; value: number | null; kind: 'apy' | 'roi' }

/**
 * The one figure a fund leads with. A yield product leads with its 7-day APY; an ETF or a vault with its return, the
 * longest SoDEX sends of one year and one month. An APY on an ETF (a week's move annualised) is never shown.
 */
export function headline(isYield: boolean, q: Quote | null): Headline {
  if (isYield) return { label: '7-day APY', short: 'APY', value: val(q?.apy7d), kind: 'apy' };
  const y = val(q?.roi1Y);
  if (y !== null) return { label: '1-year return', short: '1Y', value: y, kind: 'roi' };
  return { label: '1-month return', short: '1M', value: val(q?.roi1M), kind: 'roi' };
}

/** USDC Earn's share has no logo of its own; it is USDC in a vault (the Original's rule). */
export const fundIcon = (coin: string): string => (/^v?soUSDC$/i.test(coin) ? 'USDC' : coin);

export interface FundView {
  id: string;
  fund: WealthFund;
  name: string;
  shelf: FundShelf;
  isYield: boolean;
  /** The token the wallet holds (vQQQ, aCXMT, vsoUSDC). */
  ticker: string;
  icon: string;
  quote: Quote | null;
  status: TradingStatus | null;
  action: FundAction | null;
  head: Headline;
  holding: JoinedHolding | null;
}

/** The board: every fund SoDEX lists, by shelf, with its quote, what it allows now and the wallet's holding in it. */
export function useFundViews(w: WealthState): FundView[] | null {
  const statuses = useTradingStatuses(w.funds);
  return useMemo(() => {
    if (!w.funds) return null;
    const held = new Map((w.holdings ?? []).map((h) => [h.fundId, h]));
    const views = w.funds.map((f): FundView => {
      const label = fundLabel(f);
      const quote = (w.quotes.get(f.fundId) ?? null) as Quote | null;
      const status = statuses.get(f.fundId) ?? null;
      return {
        id: f.fundId,
        fund: f,
        name: label.name,
        shelf: label.shelf,
        isYield: label.yield,
        ticker: f.share.coin,
        icon: fundIcon(quote?.symbol ?? f.share.coin),
        quote,
        status,
        action: fundAction(f, status),
        head: headline(label.yield, quote),
        holding: held.get(f.fundId) ?? null,
      };
    });
    return views.sort((a, b) => SHELVES.indexOf(a.shelf) - SHELVES.indexOf(b.shelf));
  }, [w.funds, w.quotes, w.holdings, statuses]);
}

// --- price history ---------------------------------------------------------------------

export type HistRange = '1W' | '1M' | '1Y' | 'All';
export const HIST_RANGES: ReadonlyArray<{ value: HistRange; label: string }> = [
  { value: '1W', label: '7d' }, { value: '1M', label: '30d' }, { value: '1Y', label: '1y' }, { value: 'All', label: 'All' },
];
export interface PricePoint { t: number; v: number }

/** SoDEX sends no price history for a bridged vault (USDC Earn: empty, and an error for All). */
export const hasHistory = (f: Pick<WealthFund, 'fundType'>): boolean => f.fundType !== 'bridged_vault';

const TTL = 10 * 60_000;
const pending = new Map<string, Promise<PricePoint[]>>();
const done = new Map<string, { at: number; points: PricePoint[] }>();

/** Daily closes, oldest first. Public and slow-moving: kept ten minutes, and one read per fund and range at a time. */
export function readPriceHistory(fundId: string, range: HistRange): Promise<PricePoint[]> {
  const key = `${fundId}:${range}`;
  const hit = done.get(key);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.points);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  // An SSI token on the spot book: SoDEX's daily candles. USDC Earn: its vault's daily share price through ValueDesk's
  // relay (SoDEX sends none for it). Both cut to the range here.
  const special = ssiSpotOf(fundId) ? readSsiCloses(fundId) : fundId === 'Morpho-Earn' ? readEarnHistory() : null;
  if (special) {
    const days = range === '1W' ? 7 : range === '1M' ? 30 : range === '1Y' ? 365 : null;
    const sp = special.then((all) => {
      const from = days === null ? -Infinity : Date.now() - days * 86_400_000;
      const points = all.filter((x) => x.t >= from);
      done.set(key, { at: Date.now(), points });
      return points;
    }).finally(() => pending.delete(key));
    pending.set(key, sp);
    return sp;
  }
  const p = readGateway<{ points?: Array<{ ts: string | number; close?: string }> }>(
    `/api/v1/wealth/funds/${encodeURIComponent(fundId)}/price-history?range=${range}`,
  ).then((d) => {
    const points = (d?.points ?? [])
      .map((x) => ({ t: typeof x.ts === 'number' ? (x.ts < 1e12 ? x.ts * 1000 : x.ts) : Date.parse(x.ts), v: Number(x.close) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v) && x.v > 0);
    done.set(key, { at: Date.now(), points });
    return points;
  }).finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

export function usePriceHistory(fundId: string | null, range: HistRange): { points: PricePoint[] | null; error: string | null } {
  const key = fundId ? `${fundId}:${range}` : '';
  const [s, setS] = useState<{ key: string; points: PricePoint[] | null; error: string | null }>(() => ({ key, points: done.get(key)?.points ?? null, error: null }));
  useEffect(() => {
    if (!fundId) return;
    let off = false;
    readPriceHistory(fundId, range)
      .then((points) => { if (!off) setS({ key, points, error: null }); })
      .catch((e) => {
        if (off) return;
        setS({ key, points: null, error: (e as Error).message });
        logLoadFailure('Fund price history', e);
      });
    return () => { off = true; };
  }, [fundId, range, key]);
  if (s.key === key) return { points: s.points, error: s.error };
  return { points: done.get(key)?.points ?? null, error: null };
}

/** The change over a series, in percent of its first close. */
export function seriesChange(points: readonly PricePoint[] | null): number | null {
  if (!points || points.length < 2) return null;
  const a = points[0]!.v;
  return a > 0 ? ((points[points.length - 1]!.v - a) / a) * 100 : null;
}

// --- words and numbers -----------------------------------------------------------------

/** A percent in the app's number style: grouped, two places, a true minus. `signed` puts + on a gain. */
export function pctText(v: number | null, signed = true, dp = 2): string {
  if (v === null) return DASH;
  const body = fmtNum(Math.abs(v), { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const sign = v < 0 ? MINUS : signed && v > 0 ? '+' : '';
  return `${sign}${body}%`;
}

/** Compact dollars for a fund's size ($215.8K). */
export function usdCompact(v: number | null): string {
  if (v === null) return DASH;
  const a = Math.abs(v);
  const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  return `${v < 0 ? MINUS : ''}$${fmtNum(a / d, { minimumFractionDigits: s ? 1 : 2, maximumFractionDigits: s ? 1 : 2 })}${s}`;
}

const MARKET: Readonly<Record<string, [string, Tone]>> = {
  OPEN: ['Market open', 'positive'],
  REGULAR: ['Market open', 'positive'],
  TRADING: ['Market open', 'positive'],
  PRE_MARKET: ['Pre-market', 'neutral'],
  PREMARKET: ['Pre-market', 'neutral'],
  AFTER_HOURS: ['After hours', 'neutral'],
  POST_MARKET: ['After hours', 'neutral'],
  CLOSED: ['Market closed', 'neutral'],
  HOLIDAY: ['Market holiday', 'neutral'],
};

/** The underlying market's session, as SoDEX reports it. Null when it sends none (USDC Earn). */
export function marketState(q: Quote | null): { label: string; tone: Tone } | null {
  const s = q?.marketStatus;
  if (!s) return null;
  const hit = MARKET[s.toUpperCase()];
  if (hit) return { label: hit[0], tone: hit[1] };
  const words = s.toLowerCase().replace(/_/g, ' ');
  return { label: words.charAt(0).toUpperCase() + words.slice(1), tone: 'neutral' };
}

/** "27m", "5h 12m", "2d 4h": how long until a moment, for a pill. */
export function leftShort(atMs: number, now: number): string {
  const s = Math.max(0, Math.floor((atMs - now) / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export interface Channel { label: string; tone: Tone; /** A cutoff or reopening, ms. */ at: number | null; atLabel: string | null }

/** How the fund trades right now, in the reader's words (the Original's channel table). */
export function channelOf(v: Pick<FundView, 'action' | 'fund'>): Channel {
  if (v.fund.comingSoon) return { label: 'Coming soon', tone: 'brand', at: null, atLabel: null };
  const a = v.action;
  if (!a) return { label: v.fund.fundType === 'clob' ? 'Order book' : 'Reading', tone: 'neutral', at: null, atLabel: null };
  switch (a.kind) {
    case 'trade': return { label: 'Order book', tone: 'positive', at: null, atLabel: null };
    case 'batch': return { label: 'Batch', tone: 'brand', at: a.cutoffAt ? a.cutoffAt * 1000 : null, atLabel: 'Cutoff' };
    case 'rfq': return { label: 'Maker quote', tone: 'brand', at: null, atLabel: null };
    // USDC Earn: ValueDesk sends the bridge order itself (trading/wealthEarn.ts, 2026-11-28); measured 0.8-1.3 min.
    case 'external': return v.fund.fundType === 'bridged_vault'
      ? { label: 'Bridge, about a minute', tone: 'positive', at: null, atLabel: null }
      : { label: 'On sodex.com', tone: 'neutral', at: null, atLabel: null };
    // sodex.com's words: "Trading temporarily unavailable", the countdown beside it; SoDEX's reason in the title.
    case 'closed': return { label: 'Trading temporarily unavailable', tone: 'warning', at: a.nextAt ? a.nextAt * 1000 : null, atLabel: 'Opens' };
  }
}

/** Where a holding's shares sit (the Original's words). */
export const heldIn = (h: JoinedHolding): string[] => [
  ...(h.spotShares > 0 ? ['Spot'] : []),
  ...(h.perpShares > 0 ? ['Perps margin'] : []),
  ...(h.evmShares > 0 ? ['Wallet'] : []),
  ...(h.source === 'bridge' ? ['Bridged'] : []),
];

/** A holding's PnL: unrealised plus realised, only when SoDEX priced it. */
export const holdingPnl = (h: JoinedHolding): number | null => (h.pnl?.priced ? (val(h.pnl.unrealizedPnl) ?? 0) + (val(h.pnl.realizedPnl) ?? 0) : null);
export const holding24h = (h: JoinedHolding): number | null => (h.pnl?.pnl24h !== undefined ? val(h.pnl.pnl24h) : null);

/** SoDEX's timestamps come as ISO text or seconds. */
export function whenMs(at: string | number | undefined): number | null {
  if (at === undefined) return null;
  const d = new Date(typeof at === 'number' && at < 1e12 ? at * 1000 : at);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
export const dayTime = (at: string | number | undefined): string => {
  const ms = whenMs(at);
  return ms === null ? DASH : new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
export const dayOnly = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export const KIND: Readonly<Record<string, string>> = {
  subscribe: 'Subscribe', airdrop: 'Airdrop', deposit: 'Deposit', redeem: 'Redeem', liquidation: 'Liquidation', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
};
export const statusTone = (s: string): Tone => (s === 'completed' ? 'positive' : s === 'failed' || s === 'rejected' ? 'negative' : s === 'processing' ? 'brand' : 'neutral');
export const statusWord = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** An entry still on its way: processing, claimable or delayed (the Original's In progress rule). */
export const isMoving = (e: WealthEntry): boolean => e.status === 'processing' || e.claimable === true || e.delayedPending === true;

/**
 * When SoDEX expects a batch request delivered: only for a request sent inside the fund's current batch window
 * (opens <= requested < cutoff), whose delivery time trading-status gives. Anything else: null, never a guess.
 */
export function expectedDelivery(e: WealthEntry, status: TradingStatus | null): number | null {
  const b = status?.batch;
  const at = whenMs(e.requestedAt ?? e.at);
  if (!b || at === null || !b.opensAt || !b.cutoffAt || !b.expectedDeliveryAt) return null;
  return at >= b.opensAt * 1000 && at < b.cutoffAt * 1000 ? b.expectedDeliveryAt * 1000 : null;
}
