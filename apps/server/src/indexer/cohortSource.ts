/**
 * One wallet's open positions and equity, per venue - the cohorts' snapshot.
 *
 * A wallet is read ONCE; after that its own trades on the live streams keep
 * the positions current (cohortTracker.ts). Each read is the venue's cheapest
 * public answer for "what does this wallet hold right now":
 *
 *   hyperliquid  POST /info clearinghouseState            weight 2
 *                (+ spotClearinghouseState, weight 2, when asked: hlCollateral)
 *   tradexyz     POST /info clearinghouseState dex "xyz"  weight 2 (its own margin book)
 *   sodex        GET perps /accounts/{address}/state      weight 5 (one request)
 *   lighter      GET /api/v1/account?by=l1_address        1 request, every sub-account with positions
 *   arcus        GET /v1/account                          weight 2
 *
 * No venue publishes a bulk read (Hyperliquid's `batchClearinghouseStates`
 * answers 500, checked 2026-09-29).
 *
 * Symbols are kept exactly as the venue's trade stream names them, so a print
 * can be applied to the position it moves.
 */
import type { Venue } from '../valuedesk/types.js';
import { hlInfo } from '../valuedesk/hyperliquid/index.js';
import type { HlClearinghouseState, HlPortfolio } from '../valuedesk/hyperliquid/raw.js';
import { portfolioWindow } from '../valuedesk/hyperliquid/mappers.js';
import type { CohortPnlRow } from './store.js';
import type { FundingRow } from './cohortRebuild.js';
import { perpsState } from '../valuedesk/sodex/gateway.js';
import type { PerpsState } from '../valuedesk/sodex/mappers.js';
import { arcusAccount } from '../valuedesk/extra/arcus.js';
import { LIGHTER_API } from '../valuedesk/extra/lighter.js';
import { num, type Pacer } from '../valuedesk/extra/http.js';
import type { Position } from '../valuedesk/cohorts/model.js';
import type { ReadPos } from '../valuedesk/liquidations/math.js';

/** The cross cash an account value implies: its value with every cross position at 0. */
const cashOf = (value: number | null, ps: readonly ReadPos[]): number | null => {
  if (value === null) return null;
  let c = value;
  for (const p of ps) {
    if (p.isolated) c -= p.isoValue ?? 0;
    else if (p.mark !== null) c -= p.szi * p.mark;
    else return null;
  }
  return c;
};

export interface PositionRead {
  /** The perps account value (model.ts perpEquity says per venue what it is). */
  equity: number | null;
  positions: Position[];
  /** Prices seen in the read (symbol -> mark), to value positions before the stream prints them. */
  marks: Array<[string, number]>;
  /** Lighter: every sub-account index of the wallet (the stream names parties by index). */
  indices?: number[];
  /** Hyperliquid, when the spot state was read: a unified / portfolio-margin account's collateral, null for a standard one. */
  collateral?: number | null;
  /** Hyperliquid: when the spot state was read (absent = it was not). */
  spotAt?: number;
  /** What the read spent beyond READ_COST (the spot state). */
  extraCost?: number;
  /**
   * What the liquidation math needs (valuedesk/liquidations/math.ts calibrate):
   * each position's mark, the venue's liquidation price where it gives one, its
   * margin mode, and the cross cash the account value implies (`cash0`).
   */
  liq?: { cash0: number | null; positions: ReadPos[]; split?: boolean };
  /** SoDEX, read on the reader thread: what says which prints the read holds (cohortTracker.ts printInRead). */
  read?: BookRead;
}

/**
 * When a read was asked and answered, and each position's `ut`: its last change on SoDEX's clock, the same millisecond as
 * the print that made it (measured 2026-11-06: 12:27:00.407 on both). A print up to `ut` is in the read, a later one is not.
 */
export interface BookRead { sent: number; got: number; ut: ReadonlyMap<string, number> }

const EMPTY: PositionRead = { equity: null, positions: [], marks: [] };

interface HlSpotState {
  balances?: Array<{ coin?: string; token?: number; total?: string }>;
  /** Present only on a unified or portfolio-margin account: the tokens its perps run on. */
  tokenToAvailableAfterMaintenance?: Array<[number, string]>;
}

/** Stablecoins counted at $1 as perps collateral. */
const STABLE_COLLATERAL = /^(USDC|USDT0?|USDE|USDH|USDG)$/i;

/**
 * A unified / portfolio-margin account's perp equity from its spot state: what
 * its spot holds, every token at its spot price (stablecoins at $1). Null for a
 * standard account - its spot is spot, not perps.
 *
 * As Hyperdash's "perp equity" reads (checked 2026-10-24 on its Apex list):
 * 0x8af7...fa05 $33.2M against our spot total $33.6M, where its stablecoins
 * alone were $22.8M; RTB 2 $11.7M against $11.7M. Staked HYPE is not in it (RTB
 * 2 has $2M staked). The rule before (2026-10-03, from 0x7737...bf66, then all
 * USDC) counted the stablecoins only, which put accounts holding HYPE or other
 * tokens as margin a size cohort too low. Without prices (`px` missing) the
 * stablecoins alone are counted, as before.
 */
export function spotCollateral(st: HlSpotState | null | undefined, px?: ReadonlyMap<string, number> | null): number | null {
  const pool = st?.tokenToAvailableAfterMaintenance;
  if (!Array.isArray(pool)) return null;
  const tokens = new Set(pool.map((e) => Number(e?.[0])));
  let sum = 0;
  for (const b of st?.balances ?? []) {
    const coin = String(b.coin ?? '');
    const total = num(b.total) ?? 0;
    if (STABLE_COLLATERAL.test(coin)) {
      if (px || tokens.has(Number(b.token))) sum += total;
    } else if (px) {
      sum += total * (px.get(coin) ?? 0);
    }
  }
  return sum;
}

type HlSpotMetaCtxs = [
  { tokens?: Array<{ name?: string; index?: number }>; universe?: Array<{ tokens?: [number, number]; index?: number }> },
  Array<{ markPx?: string | null; midPx?: string | null }>,
];

/** Spot tokens' prices in USDC (token name -> mark), from spotMetaAndAssetCtxs: the pairs quoted in USDC (token 0). */
export function spotPrices(raw: HlSpotMetaCtxs | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  const [meta, ctxs] = raw;
  const name = new Map((meta?.tokens ?? []).map((t) => [Number(t.index), String(t.name ?? '')]));
  for (const u of meta?.universe ?? []) {
    const [base, quote] = u.tokens ?? [];
    if (quote !== 0 || base === undefined) continue;
    const c = ctxs?.[Number(u.index)];
    const p = num(c?.markPx ?? c?.midPx ?? null);
    const n = name.get(Number(base));
    if (n && p && p > 0 && !out.has(n)) out.set(n, p);
  }
  return out;
}

/** HL's spot prices, cached by the client for five minutes (weight 20 a read). Null when they cannot be read. */
export async function hlSpotPrices(): Promise<Map<string, number> | null> {
  const raw = await hlInfo.post<HlSpotMetaCtxs | null>({ type: 'spotMetaAndAssetCtxs' }, { ttlMs: 5 * 60_000 }).catch(() => null);
  const px = spotPrices(raw);
  return px.size ? px : null;
}

/** Hyperliquid's default dex, or a HIP-3 dex (`xyz` = trade.xyz); `spot` decides whether the default dex's read also reads the spot state. */
export async function hlPositions(address: string, dex?: string, spot?: (r: PositionRead) => boolean): Promise<PositionRead> {
  const st = await hlInfo.post<HlClearinghouseState | null>(
    dex ? { type: 'clearinghouseState', user: address, dex } : { type: 'clearinghouseState', user: address },
    // Not `background`: that waits for spare room in the shared bucket, which the
    // fill backfill (charged per item) rarely leaves - the reads starved. The
    // cohort lane (hlc) already paces them at its own share.
    { ttlMs: 0 },
  );
  if (!st) return EMPTY;
  const positions: Position[] = [];
  const marks: Array<[string, number]> = [];
  const lp: ReadPos[] = [];
  for (const { position: p } of st.assetPositions ?? []) {
    const szi = num(p.szi) ?? 0;
    if (!szi) continue;
    positions.push({ symbol: p.coin, szi, entry: num(p.entryPx) });
    const value = Math.abs(num(p.positionValue) ?? 0);
    const mark = value > 0 ? value / Math.abs(szi) : null;
    if (mark !== null) marks.push([p.coin, mark]);
    const isolated = p.leverage?.type === 'isolated';
    // An isolated position's rawUsd is its margin less s x mark: its value at the mark is that plus s x mark.
    const raw = num(p.leverage?.rawUsd ?? null);
    lp.push({
      symbol: p.coin, szi, mark, vliq: num(p.liquidationPx) || null, isolated, lev: p.leverage?.value ?? null,
      isoValue: isolated ? (raw !== null && mark !== null ? raw + szi * mark : num(p.marginUsed)) : undefined,
    });
  }
  const out: PositionRead = {
    equity: num(st.marginSummary?.accountValue), positions, marks,
    // The cross summary leaves the isolated positions out; the whole account's has them in.
    liq: {
      cash0: st.crossMarginSummary
        ? cashOf(num(st.crossMarginSummary.accountValue), lp.filter((p) => !p.isolated))
        : cashOf(num(st.marginSummary?.accountValue), lp),
      positions: lp,
    },
  };
  if (!dex && spot?.(out)) {
    const [sp, px] = await Promise.all([
      hlInfo.post<HlSpotState | null>({ type: 'spotClearinghouseState', user: address }, { ttlMs: 0 }),
      hlSpotPrices(),
    ]);
    out.collateral = spotCollateral(sp, px);
    out.spotAt = Date.now();
    out.extraCost = 2;
  }
  return out;
}

/** A Hyperliquid portfolio read (POST /info portfolio): HL's weight for it. */
export const PNL_READ_COST = 20;

/** The last point of a portfolio window's cumulative PnL (null when the window is missing). */
export function portfolioPnl(p: HlPortfolio | null | undefined, window: string): number | null {
  const h = portfolioWindow(p, window)?.pnlHistory;
  if (!Array.isArray(h) || !h.length) return null;
  return num(h[h.length - 1]?.[1]);
}

/**
 * A Hyperliquid wallet's PERP PnL from its portfolio chart: all-time and the day / week /
 * month windows (`perpAllTime`, `perpDay`, ...). The PnL cohorts are by perp PnL, as
 * Hyperdash's are: on the whole account's (`allTime`, the leaderboard's own figure, spot
 * included) 45% of 80 sampled "extremely profitable" holders were there on spot gains alone
 * (2026-10-28) - 582 against Hyperdash's 322. Null when Hyperliquid has no chart for it.
 */
export async function hlPortfolioPnl(address: string): Promise<CohortPnlRow | null> {
  const p = await hlInfo.post<HlPortfolio | null>({ type: 'portfolio', user: address }, { ttlMs: 0 });
  if (!Array.isArray(p)) return null;
  return {
    address,
    pnl: portfolioPnl(p, 'perpAllTime'),
    pnl1d: portfolioPnl(p, 'perpDay'),
    pnl7d: portfolioPnl(p, 'perpWeek'),
    pnl30d: portfolioPnl(p, 'perpMonth'),
  };
}

// --- history reads (cohortRebuild.ts) ----------------------------------------------------

/** userFunding rows per response. */
const FUNDING_PAGE = 500;
/** Pages read for one wallet at most: 200k rows, a vault holding every market for six weeks. */
const FUNDING_PAGES_MAX = 400;

/**
 * The history reads' own weight bucket (info.ts WeightBudget): every request
 * takes its weight from it first. A wallet is many requests - one of 132 coins
 * over a week is 42 pages, ~1,900 weight - and counted only once its read was
 * done, four of those at once drained the indexer's whole Hyperliquid budget
 * for a minute (2026-10-24), stalling every other lane.
 */
export interface HistPace {
  reserve(w: number): number;
  charge(w: number): void;
}

async function paced(pace: HistPace | undefined, w: number): Promise<void> {
  const ms = pace?.reserve(w) ?? 0;
  if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * A Hyperliquid wallet's funding over [from, to]: one row per hour and coin it
 * held (trade.xyz's `xyz:` coins included), with the position's size then -
 * POST /info userFunding, weight 20 + 1 per 20 rows, paged by time. Returns the
 * rows and the weight spent. Throws past FUNDING_PAGES_MAX rather than return a
 * history cut short.
 */
export async function hlFundingRows(address: string, from: number, to: number, pace?: HistPace): Promise<{ rows: FundingRow[]; cost: number }> {
  const rows: FundingRow[] = [];
  let cost = 0;
  let start = from;
  for (let page = 0; ; page++) {
    if (page >= FUNDING_PAGES_MAX) throw new Error(`userFunding ${address}: over ${FUNDING_PAGES_MAX} pages`);
    await paced(pace, 20);
    const r = await hlInfo.post<Array<{ time?: number; delta?: { coin?: string; szi?: string } }> | null>(
      { type: 'userFunding', user: address, startTime: start, endTime: to },
      { ttlMs: 0, timeoutMs: 25_000 },
    );
    const list = Array.isArray(r) ? r : [];
    pace?.charge(Math.ceil(list.length / 20));
    cost += 20 + Math.ceil(list.length / 20);
    for (const x of list) rows.push({ time: Number(x.time), coin: String(x.delta?.coin ?? ''), szi: Number(x.delta?.szi) });
    if (list.length < FUNDING_PAGE) break;
    // A full page can end inside an hour's rows (one per coin): ask from that hour again.
    const last = Number(list[list.length - 1]?.time);
    start = last > start ? last : last + 1;
  }
  return { rows, cost };
}

/** A symbol's hourly prices over [from, to] (1h candles' opens): POST /info candleSnapshot, weight 20 + 1 per 60. */
export async function hlHourlyPrices(symbol: string, from: number, to: number, pace?: HistPace): Promise<{ px: Array<[number, number]>; cost: number }> {
  await paced(pace, 20);
  const k = await hlInfo.post<Array<{ t?: number; o?: string }> | null>(
    { type: 'candleSnapshot', req: { coin: symbol, interval: '1h', startTime: from, endTime: to } },
    { ttlMs: 0, timeoutMs: 25_000 },
  ).catch(() => null);
  const list = Array.isArray(k) ? k : [];
  pace?.charge(Math.ceil(list.length / 60));
  const px: Array<[number, number]> = [];
  for (const c of list) {
    const o = num(c.o ?? null);
    if (typeof c.t === 'number' && o && o > 0) px.push([c.t, o]);
  }
  return { px, cost: 20 + Math.ceil(list.length / 60) };
}

/** A Hyperliquid wallet's account value over the last month: its portfolio's month (daily), week (4-hourly) and day points. */
export async function hlEquityHistory(address: string, pace?: HistPace): Promise<Array<[number, number]> | null> {
  await paced(pace, 20);
  const p = await hlInfo.post<HlPortfolio | null>({ type: 'portfolio', user: address }, { ttlMs: 0 });
  if (!Array.isArray(p)) return null;
  const at = new Map<number, number>();
  for (const w of ['month', 'week', 'day']) {
    for (const [t, v] of portfolioWindow(p, w)?.accountValueHistory ?? []) {
      const x = num(v);
      if (typeof t === 'number' && x !== null) at.set(t, x);
    }
  }
  return at.size ? [...at].sort((a, b) => a[0] - b[0]) : null;
}

export async function sodexPositions(address: string): Promise<PositionRead> {
  return sodexPositionsOf(await perpsState(address));
}

/** One perps state as a read. `at`: when the reader thread asked and heard, for printInRead. */
export function sodexPositionsOf(st: PerpsState | null | undefined, at?: { sent: number; got: number }): PositionRead {
  if (!st || !st.aid) return at ? { ...EMPTY, read: { ...at, ut: new Map() } } : EMPTY;
  const ut = new Map<string, number>();
  const positions: Position[] = [];
  const marks: Array<[string, number]> = [];
  const lp: ReadPos[] = [];
  for (const p of st.P ?? []) {
    const szi = num(p?.sz);
    if (!p?.s || !szi) continue;
    const entry = num(p.ep);
    positions.push({ symbol: p.s, szi, entry });
    if (typeof p.ut === 'number' && p.ut > 0) ut.set(p.s, p.ut);
    const ur = num(p.ur);
    const mark = entry !== null && ur !== null ? entry + ur / szi : null;
    if (mark !== null) marks.push([p.s, mark]);
    // "0" is SoDEX's "no liquidation price" (sodex/mappers.ts).
    lp.push({ symbol: p.s, szi, mark, vliq: num(p.lp) || null, isolated: p.m === 'ISOLATED', lev: p.l ?? null });
  }
  const equity = num(st.av);
  return { equity, positions, marks, liq: { cash0: cashOf(equity, lp), positions: lp }, ...(at ? { read: { ...at, ut } } : {}) };
}

/** Every sub-account of an L1 address, positions included, in one request. */
export async function lighterPositions(address: string, pacer: Pacer): Promise<PositionRead> {
  const j = await pacer.get<{ accounts?: Array<Record<string, unknown>> }>(
    `${LIGHTER_API}/api/v1/account?by=l1_address&value=${encodeURIComponent(address)}`,
  ).catch((e: unknown) => {
    const s = (e as { status?: number }).status;
    if (s === 400 || s === 404) return { accounts: [] };
    throw e;
  });
  let equity: number | null = null;
  // Sub-accounts can hold the same market: one position per market, sizes summed,
  // entries size-weighted (a book keys positions by market).
  const by = new Map<string, Position>();
  const marks: Array<[string, number]> = [];
  const indices: number[] = [];
  // Each sub-account is its own margin account: the liquidation math follows one, and keeps
  // the venue's figures as read when positions sit in several (math.ts calibrate `split`).
  const lp: ReadPos[] = [];
  let holding = 0;
  let cash0: number | null = null;
  for (const a of j.accounts ?? []) {
    const idx = num(a.index) ?? num(a.account_index);
    if (idx !== null) indices.push(idx);
    const v = num(a.total_asset_value) ?? num(a.collateral);
    if (v !== null) equity = (equity ?? 0) + v;
    const mine: ReadPos[] = [];
    for (const p of (a.positions as Array<Record<string, unknown>> | undefined) ?? []) {
      const size = Math.abs(num(p.position) ?? 0);
      if (!size) continue;
      const symbol = String(p.symbol ?? p.market_id);
      const szi = (num(p.sign) ?? 1) < 0 ? -size : size;
      const pv = Math.abs(num(p.position_value) ?? 0);
      const isolated = num(p.margin_mode) === 1;
      mine.push({
        symbol, szi, mark: pv > 0 ? pv / size : null,
        // "0" is Lighter's "no liquidation price".
        vliq: num(p.liquidation_price) || null,
        isolated,
        isoValue: isolated ? (num(p.allocated_margin) ?? 0) + (num(p.unrealized_pnl) ?? 0) : undefined,
        lev: isolated && (num(p.initial_margin_fraction) ?? 0) > 0 ? 100 / num(p.initial_margin_fraction)! : null,
      });
      const entry = num(p.avg_entry_price);
      const cur = by.get(symbol);
      if (!cur) by.set(symbol, { symbol, szi, entry });
      else {
        const n = cur.szi + szi;
        const same = Math.sign(cur.szi) === Math.sign(szi);
        cur.entry = same && cur.entry !== null && entry !== null && n !== 0 ? (Math.abs(cur.szi) * cur.entry + Math.abs(szi) * entry) / Math.abs(n) : Math.abs(szi) > Math.abs(cur.szi) ? entry : cur.entry;
        cur.szi = n;
      }
      const value = Math.abs(num(p.position_value) ?? 0);
      if (value > 0) marks.push([symbol, value / size]);
    }
    if (mine.length) {
      holding++;
      cash0 = cashOf(v, mine);
      for (const p of mine) {
        // Several sub-accounts in one market: the larger part's figure stands for the book's position.
        const i = lp.findIndex((x) => x.symbol === p.symbol);
        if (i < 0) lp.push(p);
        else if (Math.abs(p.szi) > Math.abs(lp[i]!.szi)) lp[i] = p;
      }
    }
  }
  const positions = [...by.values()].filter((p) => p.szi !== 0);
  return { equity, positions, marks, indices, liq: { cash0: holding > 1 ? null : cash0, positions: lp, split: holding > 1 } };
}

export async function arcusPositions(address: string, pacer: Pacer): Promise<PositionRead> {
  const a = await arcusAccount(address, pacer);
  if (!a) return EMPTY;
  const positions: Position[] = [];
  const marks: Array<[string, number]> = [];
  const lp: ReadPos[] = [];
  for (const p of a.positions) {
    if (!p.size) continue;
    positions.push({ symbol: p.symbol, szi: p.size, entry: p.entry });
    const mark = p.mark !== null && p.mark > 0 ? p.mark : null;
    if (mark !== null) marks.push([p.symbol, mark]);
    // Arcus's account read gives no liquidation price (`vliq` absent): the math works it out.
    lp.push({
      symbol: p.symbol, szi: p.size, mark, isolated: p.isolated, lev: p.leverage,
      isoValue: p.isolated && p.marginUsed !== null ? p.marginUsed + (p.uPnl ?? 0) : undefined,
    });
  }
  return { equity: a.equity, positions, marks, liq: { cash0: cashOf(a.equity, lp), positions: lp } };
}

/** What one read costs in its lane's unit. */
export const READ_COST: Record<Venue, number> = { hyperliquid: 2, tradexyz: 2, sodex: 1, lighter: 1, arcus: 2 };
