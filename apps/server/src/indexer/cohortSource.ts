/**
 * One wallet's open positions and equity, per venue - the cohorts' snapshot.
 *
 * A wallet is read ONCE; after that its own trades on the live streams keep
 * the positions current (cohortTracker.ts). Each read is the venue's cheapest
 * public answer for "what does this wallet hold right now":
 *
 *   hyperliquid  POST /info clearinghouseState            weight 2
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
import type { HlClearinghouseState } from '../valuescan/hyperliquid/raw.js';
import { perpsState } from '../valuescan/sodex/gateway.js';
import { arcusAccount } from '../valuescan/extra/arcus.js';
import { LIGHTER_API } from '../valuescan/extra/lighter.js';
import { num, type Pacer } from '../valuescan/extra/http.js';
import type { Position } from '../valuescan/cohorts/model.js';

export interface PositionRead {
  equity: number | null;
  positions: Position[];
  /** Prices seen in the read (symbol -> mark), to value positions before the stream prints them. */
  marks: Array<[string, number]>;
  /** Lighter: every sub-account index of the wallet (the stream names parties by index). */
  indices?: number[];
}

const EMPTY: PositionRead = { equity: null, positions: [], marks: [] };

/** Hyperliquid's default dex, or a HIP-3 dex (`xyz` = trade.xyz). */
export async function hlPositions(address: string, dex?: string): Promise<PositionRead> {
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
  return { equity: num(st.marginSummary?.accountValue), positions, marks };
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
