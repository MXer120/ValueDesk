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
import type { Venue } from '../valuescan/types.js';
import { hlInfo } from '../valuescan/hyperliquid/index.js';
import type { HlClearinghouseState, HlPortfolio } from '../valuescan/hyperliquid/raw.js';
import { portfolioWindow } from '../valuescan/hyperliquid/mappers.js';
import type { CohortPnlRow } from './store.js';
import { perpsState } from '../valuescan/sodex/gateway.js';
import { arcusAccount } from '../valuescan/extra/arcus.js';
import { LIGHTER_API } from '../valuescan/extra/lighter.js';
import { num, type Pacer } from '../valuescan/extra/http.js';
import type { Position } from '../valuescan/cohorts/model.js';

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
}

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
  for (const { position: p } of st.assetPositions ?? []) {
    const szi = num(p.szi) ?? 0;
    if (!szi) continue;
    positions.push({ symbol: p.coin, szi, entry: num(p.entryPx) });
    const value = Math.abs(num(p.positionValue) ?? 0);
    if (value > 0) marks.push([p.coin, value / Math.abs(szi)]);
  }
  const out: PositionRead = { equity: num(st.marginSummary?.accountValue), positions, marks };
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
 * A Hyperliquid wallet's PnL from its portfolio chart, for a holder the
 * leaderboard file does not rank: all-time and the day / week / month windows.
 * The whole account, spot included - the leaderboard's own measure (checked
 * 2026-10-24: its all-time figure matches the portfolio's `allTime`, not
 * `perpAllTime`). Null when Hyperliquid has no chart for it.
 */
export async function hlPortfolioPnl(address: string): Promise<CohortPnlRow | null> {
  const p = await hlInfo.post<HlPortfolio | null>({ type: 'portfolio', user: address }, { ttlMs: 0 });
  if (!Array.isArray(p)) return null;
  return {
    address,
    pnl: portfolioPnl(p, 'allTime'),
    pnl1d: portfolioPnl(p, 'day'),
    pnl7d: portfolioPnl(p, 'week'),
    pnl30d: portfolioPnl(p, 'month'),
  };
}

export async function sodexPositions(address: string): Promise<PositionRead> {
  const st = await perpsState(address);
  if (!st || !st.aid) return EMPTY;
  const positions: Position[] = [];
  const marks: Array<[string, number]> = [];
  for (const p of st.P ?? []) {
    const szi = num(p?.sz);
    if (!p?.s || !szi) continue;
    const entry = num(p.ep);
    positions.push({ symbol: p.s, szi, entry });
    const ur = num(p.ur);
    if (entry !== null && ur !== null) marks.push([p.s, entry + ur / szi]);
  }
  return { equity: num(st.av), positions, marks };
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
  for (const a of j.accounts ?? []) {
    const idx = num(a.index) ?? num(a.account_index);
    if (idx !== null) indices.push(idx);
    const v = num(a.total_asset_value) ?? num(a.collateral);
    if (v !== null) equity = (equity ?? 0) + v;
    for (const p of (a.positions as Array<Record<string, unknown>> | undefined) ?? []) {
      const size = Math.abs(num(p.position) ?? 0);
      if (!size) continue;
      const symbol = String(p.symbol ?? p.market_id);
      const szi = (num(p.sign) ?? 1) < 0 ? -size : size;
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
  }
  const positions = [...by.values()].filter((p) => p.szi !== 0);
  return { equity, positions, marks, indices };
}

export async function arcusPositions(address: string, pacer: Pacer): Promise<PositionRead> {
  const a = await arcusAccount(address, pacer);
  if (!a) return EMPTY;
  const positions: Position[] = [];
  const marks: Array<[string, number]> = [];
  for (const p of a.positions) {
    if (!p.size) continue;
    positions.push({ symbol: p.symbol, szi: p.size, entry: p.entry });
    if (p.mark !== null && p.mark > 0) marks.push([p.symbol, p.mark]);
  }
  return { equity: a.equity, positions, marks };
}

/** What one read costs in its lane's unit. */
export const READ_COST: Record<Venue, number> = { hyperliquid: 2, tradexyz: 2, sodex: 1, lighter: 1, arcus: 2 };
