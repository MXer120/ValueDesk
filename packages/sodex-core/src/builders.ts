/**
 * Builder codes - reading a user's approvals, and the fee arithmetic.
 *
 * Signing lives elsewhere: `builderFragment` (actions.ts) puts `{id, fee}` on an
 * order, `prepareBuilderFeeApproval` (registration.ts) builds the approval the
 * master wallet signs. This module is the READ side and the numbers.
 *
 * Spec: https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading
 *
 * UNITS. `fee` on an order and `maxFeeRate` / `feeRate` on an approval are
 * integers in TENTHS OF A BASIS POINT: 10 = 1 bp = 0.01 % of the fill's notional.
 *   fee = notional * rate / 100_000
 *
 * WHAT IS VERIFIED (read-only, SoDEX mainnet, 2026-10-02 - see docs/BUILDER-CODES.md):
 *   - `GET /api/v1/user/{addr}/builders` answers `{spot: [...], perps: [...]}`
 *     with rows `{userID, builderID, feeRate}`. One approval of 500 shows as
 *     spot 500 and perps 200: the engine stores its own cap, so an approval has
 *     to be judged PER ENGINE.
 *   - A fill's `fee` is the TOTAL charged, the builder's share INCLUDED;
 *     `builderFee` is that share, in the same `feeCoin`, and is present only on
 *     fills that were charged one (spot sells; never spot buys). Adding
 *     `builderFee` to `fee` would count it twice.
 *   - The rate charged is the ORDER's `fee`, not the approval's ceiling, and it
 *     is charged on maker fills too.
 * Not observed: a perps fill with a builder (documented: both sides), and the
 * WebSocket `bf` field (documented; assumed to mirror REST).
 */
import { BUILDER_FEE_CAP, MAX_BUILDER_APPROVAL_RATE, type U64 } from './actions.ts';
import { canonicalDecimal, decimalCompare } from './decimal.ts';
import { ENGINES, type Engine } from './network.ts';
import { mulDecimal } from './symbols.ts';

/** `fee = notional * rate / BUILDER_RATE_DENOMINATOR`. */
export const BUILDER_RATE_DENOMINATOR = 100_000;
/** A user may hold at most this many builder approvals; `maxFeeRate: 0` frees one. */
export const MAX_BUILDER_APPROVALS = 10;
/** A builder account must hold at least this much vUSDC in Spot AND in Perps. */
export const BUILDER_MIN_BALANCE_USDC = 100;

/** 10 -> 0.0001 (a fraction of notional, the unit `/fee-rate` reports in). */
export const builderRateToFraction = (rate: number): number => rate / BUILDER_RATE_DENOMINATOR;

function checkRate(rate: number, what: string): number {
  if (!Number.isInteger(rate) || rate < 0 || rate > MAX_BUILDER_APPROVAL_RATE) {
    throw new RangeError(`${what} must be an integer 0..${MAX_BUILDER_APPROVAL_RATE} tenths of a bp (got ${rate})`);
  }
  return rate;
}

/** A rate as an exact decimal fraction string: 50 -> "0.0005". */
export function builderRateDecimal(rate: number): string {
  const digits = String(checkRate(rate, 'rate')).padStart(6, '0');
  return canonicalDecimal(`${digits.slice(0, -5)}.${digits.slice(-5)}`);
}

/** A rate as a percentage string for people: 50 -> "0.05", 5 -> "0.005", 2000 -> "2". */
export function builderRatePercent(rate: number): string {
  const digits = String(checkRate(rate, 'rate')).padStart(4, '0');
  return canonicalDecimal(`${digits.slice(0, -3)}.${digits.slice(-3)}`);
}

/**
 * The builder fee on `notional` at `rate`, exact (decimal strings, no floats).
 * The engine's own rounding to the coin's precision is not reproduced, so treat
 * the last digit as an estimate.
 */
export const builderFeeAmount = (notional: string, rate: number): string => mulDecimal(notional, builderRateDecimal(rate));

/** What SoDEX reports as approved for ONE builder, per engine (tenths of a bp); null = not approved there. */
export interface BuilderEngineRates {
  spot: number | null;
  perps: number | null;
}

const asRate = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The approval `builderID` holds in the `data` of `GET /user/{addr}/builders`.
 * Tolerant of what it is given: a missing engine, a non-array, a row without a
 * rate all read as "not approved" - never as an approval. Ids are compared as
 * strings so a bigint id and a JSON number match.
 */
export function approvedBuilderRates(data: unknown, builderID: U64): BuilderEngineRates {
  const want = String(builderID);
  const out: BuilderEngineRates = { spot: null, perps: null };
  if (!data || typeof data !== 'object') return out;
  for (const engine of ENGINES) {
    const rows = (data as Record<string, unknown>)[engine];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (String(r['builderID']) !== want) continue;
      const rate = asRate(r['feeRate']);
      if (rate !== null && (out[engine] === null || rate > out[engine]!)) out[engine] = rate;
    }
  }
  return out;
}

/** How many builders hold an approval on each engine (the documented limit is MAX_BUILDER_APPROVALS). */
export function builderApprovalCount(data: unknown): Record<Engine, number> {
  const out: Record<Engine, number> = { spot: 0, perps: 0 };
  if (!data || typeof data !== 'object') return out;
  for (const engine of ENGINES) {
    const rows = (data as Record<string, unknown>)[engine];
    if (Array.isArray(rows)) out[engine] = new Set(rows.map((r) => String((r as { builderID?: unknown } | null)?.builderID))).size;
  }
  return out;
}

/**
 * The fee an order may carry on `engine` under an approval: null when the
 * builder is not approved there, the order fee is zero, exceeds what was
 * approved, or exceeds the engine's own cap (perps 200, spot 2000). An order
 * naming a builder beyond its approval is REJECTED by the engine, so "attach
 * only when this says so" is a correctness rule, not a nicety.
 */
export function attachableBuilderFee(engine: Engine, orderFee: number, approved: number | null | undefined): number | null {
  if (!Number.isInteger(orderFee) || orderFee <= 0) return null;
  if (orderFee > BUILDER_FEE_CAP[engine]) return null;
  if (approved === null || approved === undefined || !Number.isInteger(approved) || approved < orderFee) return null;
  return orderFee;
}

/**
 * Does SoDEX charge a builder fee on this fill side? Builder fees are taken
 * from the quote / collateral asset: both sides on perps, the SELL side on spot
 * (a spot buy pays its fee in the base coin, which builders do not receive).
 */
export const builderFeeCharged = (engine: Engine, side: 'buy' | 'sell' | 'BUY' | 'SELL'): boolean =>
  engine === 'perps' || String(side).toUpperCase() === 'SELL';

// --- fills -------------------------------------------------------------------

/** Exact a - b on decimal strings. */
function subDecimal(a: string, b: string): string {
  const [ca, cb] = [canonicalDecimal(a), canonicalDecimal(b)];
  const scale = Math.max((ca.split('.')[1] ?? '').length, (cb.split('.')[1] ?? '').length);
  const toInt = (c: string): bigint => {
    const neg = c.startsWith('-');
    const [i = '0', f = ''] = (neg ? c.slice(1) : c).split('.');
    const n = BigInt(i + f.padEnd(scale, '0'));
    return neg ? -n : n;
  };
  const d = toInt(ca) - toInt(cb);
  const neg = d < 0n;
  const s = (neg ? -d : d).toString().padStart(scale + 1, '0');
  return canonicalDecimal((neg ? '-' : '') + (scale === 0 ? s : `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`));
}

const decimalOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  try {
    return canonicalDecimal(v);
  } catch {
    return null;
  }
};

export interface FillFeeParts {
  /** Everything the fill was charged, in `feeCoin` - what the row's `fee` already is. Null when the row has no fee. */
  total: string | null;
  /** The builder's share of `total` ("0" when none was charged). */
  builder: string;
  /** `total - builder`: the venue's own commission (negative = a maker rebate). */
  venue: string | null;
}

/**
 * Split a fill's fee. Accepts a REST row (`fee`, `builderFee`) or a WebSocket
 * `accountTrade` entry (`f`, `bf`).
 *
 * `fee` is the TOTAL: use it as it is for a "fees paid" figure. `builder` is a
 * part of it, never something to add. If a row ever reports a builder share
 * larger than a positive total (it should not), the venue part is clamped at 0
 * rather than shown as an invented rebate.
 */
export function fillFeeParts(
  row: { fee?: unknown; builderFee?: unknown; f?: unknown; bf?: unknown; [field: string]: unknown } | null | undefined,
): FillFeeParts {
  const total = decimalOrNull(row?.fee ?? row?.f);
  const share = decimalOrNull(row?.builderFee ?? row?.bf);
  const builder = share !== null && decimalCompare(share, '0') > 0 ? share : '0';
  if (total === null) return { total: null, builder, venue: null };
  if (builder === '0') return { total, builder, venue: total };
  const venue = subDecimal(total, builder);
  return { total, builder, venue: decimalCompare(total, '0') > 0 && decimalCompare(venue, '0') < 0 ? '0' : venue };
}
