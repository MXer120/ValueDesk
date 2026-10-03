/**
 * What a fill was charged, checked against what it should have been charged.
 * Pure: SoDEX's rows in, verdicts out - no network, no state.
 *
 * What SoDEX reports on a fill (docs/BUILDER-CODES.md section 6; REST
 * `/accounts/{a}/trades` and the WebSocket `accountTrade` push):
 *   fee / f          the TOTAL charged, the builder's share INCLUDED
 *   builderFee / bf  that share - present only on fills that were charged one
 *   feeCoin          (REST only) the quote / collateral coin for a sell and for
 *                    every perps fill; the BASE coin for a spot buy
 * So:  commission  = fee - builderFee
 *      commission ~= (notional, or the quantity when the fee is in the base coin)
 *                    x the account's maker or taker rate
 *      builderFee  ~= notional x the ORDER's builder fee / 100 000
 *                     on perps (both sides) and on spot SELLS; none on spot buys
 *
 * "Within rounding": a coin's precision may cut a tiny fee, so a figure passes
 * when it is within 2 % of the expected one (or 0.00000002 of the coin,
 * whichever is larger). A wrong rate is nowhere near that: maker vs taker, a fee
 * tier off, 2 bp against 1.5 bp, or a builder fee charged at the approved
 * maximum instead of the order's fee all differ by 20 % or more.
 */
import { builderFeeAmount, builderFeeCharged, fillFeeParts } from '@sodex-core';
import { approx, cut, dAdd, dCmp, dDiv, dIsZero, dMul, dSub } from './util';

export type Engine = 'spot' | 'perps';

/** One fill, from either source, in one shape. */
export interface Fill {
  engine: Engine;
  symbol: string;
  tradeID: number | null;
  orderID: number | null;
  clOrdID: string | null;
  side: 'BUY' | 'SELL';
  price: string;
  quantity: string;
  /** Everything the fill was charged; null when the row carries no fee. */
  fee: string | null;
  /** The builder's share of `fee` ('0' when none was charged). */
  builderFee: string;
  /** REST names it; the stream does not. */
  feeCoin: string | null;
  isMaker: boolean | null;
  time: number | null;
  source: 'stream' | 'history';
}

const decOrNull = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null;
};
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const sideOf = (v: unknown): 'BUY' | 'SELL' | null => {
  const s = String(v ?? '').toUpperCase();
  return s === 'BUY' || s === '1' ? 'BUY' : s === 'SELL' || s === '2' ? 'SELL' : null;
};

/** A row of GET /api/v1/{engine}/accounts/{address}/trades; null when it is not a fill. */
export function fillFromHistory(engine: Engine, row: Record<string, unknown> | null | undefined): Fill | null {
  if (!row || typeof row !== 'object') return null;
  const side = sideOf(row.side);
  const price = decOrNull(row.price);
  const quantity = decOrNull(row.quantity);
  if (!side || !price || !quantity || typeof row.symbol !== 'string') return null;
  const parts = fillFeeParts(row);
  return {
    engine,
    symbol: row.symbol,
    tradeID: intOrNull(row.tradeID),
    orderID: intOrNull(row.orderID),
    clOrdID: typeof row.clOrdID === 'string' && row.clOrdID ? row.clOrdID : null,
    side,
    price,
    quantity,
    fee: parts.total,
    builderFee: parts.builder,
    feeCoin: typeof row.feeCoin === 'string' && row.feeCoin ? row.feeCoin : null,
    isMaker: typeof row.isMaker === 'boolean' ? row.isMaker : null,
    time: intOrNull(row.time),
    source: 'history',
  };
}

/** An entry of the stream's `accountTrade` push (schema WsSpotUserTrade / WsPerpsUserTrade); null when it is not a fill. */
export function fillFromStream(engine: Engine, e: Record<string, unknown> | null | undefined): Fill | null {
  if (!e || typeof e !== 'object') return null;
  const side = sideOf(e.S);
  const price = decOrNull(e.p);
  const quantity = decOrNull(e.q);
  if (!side || !price || !quantity || typeof e.s !== 'string') return null;
  const parts = fillFeeParts(e);
  return {
    engine,
    symbol: e.s,
    tradeID: intOrNull(e.t),
    orderID: intOrNull(e.i),
    clOrdID: typeof e.c === 'string' && e.c ? e.c : null,
    side,
    price,
    quantity,
    fee: parts.total,
    builderFee: parts.builder,
    feeCoin: null,
    isMaker: typeof e.m === 'boolean' ? e.m : null,
    time: intOrNull(e.T) ?? intOrNull(e.E),
    source: 'stream',
  };
}

/** The key two reports of the same fill share. */
export const fillKey = (f: Pick<Fill, 'engine' | 'symbol' | 'tradeID' | 'orderID'>): string => `${f.engine}:${f.symbol}:${f.tradeID ?? '?'}:${f.orderID ?? '?'}`;

/** Maker / taker rates as decimal fractions ("0.0004" = 4 bp). A negative maker rate is a rebate. */
export interface FeeRates {
  taker: string;
  maker: string;
}

/** `GET .../fee-rate` -> rates, or null when SoDEX reports none. */
export function feeRatesFrom(r: unknown): FeeRates | null {
  const o = (r ?? {}) as { makerFeeRate?: unknown; takerFeeRate?: unknown };
  const taker = decOrNull(o.takerFeeRate);
  const maker = decOrNull(o.makerFeeRate);
  return taker !== null && maker !== null ? { taker, maker } : null;
}

export interface FillExpectation {
  /** The builder fee the ORDER carried (tenths of a bp), as the runner's guard saw it leave; null = it named no builder. */
  builderRate: number | null;
  /** Rates this fill may have been charged at, most specific first (the account's own, the account's for this market, the market's published ones). */
  rates: Array<{ source: string; rates: FeeRates }>;
  /** The market's quote coin (vUSDC) and base coin. */
  quoteCoin: string;
  baseCoin: string;
  /** What the step calls the order this fill belongs to. */
  label: string;
}

export interface FillCheck {
  fill: Fill;
  label: string;
  /** price x quantity, in the quote coin. */
  notional: string;
  /** The coin the fee is in (REST's, or inferred: base for a spot buy, quote otherwise). */
  feeCoin: string;
  /** fee - builderFee: SoDEX's own commission. */
  commission: string;
  /** commission over the notional (over the quantity when the fee is in the base coin), a decimal fraction. */
  commissionRate: string;
  /** The rate it matched (or, when it matched none, the first candidate). */
  expectedRate: string;
  rateSource: string | null;
  /** What the order carried, tenths of a bp; null = no builder on the order. */
  builderRate: number | null;
  /** notional x builderRate / 100 000 where SoDEX charges it; '0' otherwise. */
  expectedBuilderFee: string;
  commissionProblems: string[];
  builderProblems: string[];
}

const TOLERANCE_ABS = '0.00000002';
const TOLERANCE_REL = '0.02';
const dAbs = (v: string): string => (v.startsWith('-') ? v.slice(1) : v);

/** `actual` is `expected` within rounding (see the header). */
export function near(actual: string, expected: string): boolean {
  const diff = dAbs(dSub(actual, expected));
  const rel = dMul(dAbs(expected), TOLERANCE_REL);
  return dCmp(diff, dCmp(rel, TOLERANCE_ABS) > 0 ? rel : TOLERANCE_ABS) <= 0;
}

const sameCoin = (a: string, b: string): boolean => a.replace(/^v/i, '').toUpperCase() === b.replace(/^v/i, '').toUpperCase();

/** A decimal fraction as basis points for people: "0.0004" -> "4 bp", "0.00135" -> "13.5 bp". */
export function bps(fraction: string): string {
  return `${Number((approx(fraction) * 10_000).toFixed(3))} bp`;
}

/** Tenths of a basis point for people: 20 -> "2 bp", 15 -> "1.5 bp". */
export const rateBp = (tenths: number): string => `${Number((tenths / 10).toFixed(1))} bp`;

/** Check one fill. Never throws: what is wrong with it is a problem in the result. */
export function checkFill(fill: Fill, x: FillExpectation): FillCheck {
  const commissionProblems: string[] = [];
  const builderProblems: string[] = [];
  const notional = dMul(fill.price, fill.quantity);
  const spotBuy = fill.engine === 'spot' && fill.side === 'BUY';
  const expectedCoin = spotBuy ? x.baseCoin : x.quoteCoin;
  const feeCoin = fill.feeCoin ?? expectedCoin;
  const first = x.rates[0]?.rates ?? { taker: '0', maker: '0' };
  const pick = (r: FeeRates): string => (fill.isMaker === true ? r.maker : r.taker);
  const out: FillCheck = {
    fill,
    label: x.label,
    notional,
    feeCoin,
    commission: '0',
    commissionRate: '0',
    expectedRate: pick(first),
    rateSource: null,
    builderRate: x.builderRate,
    expectedBuilderFee: '0',
    commissionProblems,
    builderProblems,
  };
  if (fill.fee === null) {
    commissionProblems.push('the fill carries no fee figure');
    return out;
  }
  if (fill.feeCoin !== null && !sameCoin(fill.feeCoin, expectedCoin)) {
    commissionProblems.push(`the fee is in ${fill.feeCoin}, expected ${expectedCoin} (${spotBuy ? 'a spot buy pays in the base coin' : fill.engine === 'perps' ? 'every perps fill pays in the collateral coin' : 'a spot sell pays in the quote coin'})`);
  }
  const inQuote = !spotBuy;
  const base = inQuote ? notional : fill.quantity;

  // --- SoDEX's own commission -------------------------------------------------------------------
  if (dCmp(fill.builderFee, fill.fee) > 0 && dCmp(fill.fee, '0') > 0) {
    commissionProblems.push(`the builder's share ${fill.builderFee} is larger than the whole fee ${fill.fee}`);
  } else {
    out.commission = dSub(fill.fee, fill.builderFee);
    out.commissionRate = dIsZero(base) ? '0' : dDiv(out.commission, base);
    const candidates = fill.isMaker === null ? x.rates.flatMap((r) => [{ source: `${r.source} taker`, rate: r.rates.taker }, { source: `${r.source} maker`, rate: r.rates.maker }]) : x.rates.map((r) => ({ source: `${r.source} ${fill.isMaker ? 'maker' : 'taker'}`, rate: pick(r.rates) }));
    const hit = candidates.find((c) => near(out.commission, dMul(base, c.rate)));
    if (hit) {
      out.rateSource = hit.source;
      out.expectedRate = hit.rate;
    } else {
      commissionProblems.push(
        `commission ${cut(out.commission, 12)} ${feeCoin} is ${bps(out.commissionRate)} of ${inQuote ? 'the notional' : 'the quantity'}; expected ${candidates.map((c) => `${bps(c.rate)} (${c.source})`).join(' or ') || 'a known rate'}`,
      );
    }
  }

  // --- the builder's share: the ORDER's fee on the notional, where SoDEX charges one --------------------
  const due = x.builderRate !== null && x.builderRate > 0 && builderFeeCharged(fill.engine, fill.side);
  out.expectedBuilderFee = due ? builderFeeAmount(notional, x.builderRate!) : '0';
  if (due) {
    if (dIsZero(fill.builderFee)) builderProblems.push(`no builderFee on the fill; expected ${cut(out.expectedBuilderFee, 12)} ${x.quoteCoin} (${rateBp(x.builderRate!)} of ${cut(notional, 8)})`);
    else if (!near(fill.builderFee, out.expectedBuilderFee)) {
      builderProblems.push(`builderFee ${fill.builderFee} is ${bps(dDiv(fill.builderFee, notional))} of the notional, not the order's ${rateBp(x.builderRate!)} (expected ${cut(out.expectedBuilderFee, 12)})`);
    }
  } else if (!dIsZero(fill.builderFee)) {
    builderProblems.push(`builderFee ${fill.builderFee} was charged although none is due (${x.builderRate === null || x.builderRate === 0 ? 'the order named no builder' : 'SoDEX charges none on a spot buy'})`);
  }
  return out;
}

export const fillOk = (c: FillCheck): boolean => c.commissionProblems.length === 0 && c.builderProblems.length === 0;

/** The fill's whole fee in USD (the base coin priced at the fill's own price). */
export function fillFeeUsd(c: FillCheck): number {
  const fee = approx(c.fill.fee ?? '0');
  return c.fill.engine === 'spot' && c.fill.side === 'BUY' ? fee * approx(c.fill.price) : fee;
}

/** Sum of the builder fees on these fills (decimal string, quote coin). */
export const builderFeeSum = (fills: readonly Fill[]): string => fills.reduce((s, f) => dAdd(s, f.builderFee), '0');

/** One fill's check as a report row. */
export function fillRow(c: FillCheck): Record<string, string | number | boolean | null> {
  const f = c.fill;
  return {
    order: c.label,
    engine: f.engine,
    symbol: f.symbol,
    side: f.side,
    liquidity: f.isMaker === null ? '?' : f.isMaker ? 'maker' : 'taker',
    quantity: f.quantity,
    price: f.price,
    notional: cut(c.notional, 8),
    commission: `${cut(c.commission, 10)} ${c.feeCoin}`,
    commissionRate: bps(c.commissionRate),
    expectedCommissionRate: `${bps(c.expectedRate)}${c.rateSource ? ` (${c.rateSource})` : ''}`,
    builderFee: dIsZero(f.builderFee) ? '0' : f.builderFee,
    builderFeeRate: dIsZero(f.builderFee) ? '-' : bps(dDiv(f.builderFee, c.notional)),
    orderBuilderFee: c.builderRate === null ? 'none' : rateBp(c.builderRate),
    expectedBuilderFee: cut(c.expectedBuilderFee, 10),
    orderID: f.orderID,
    tradeID: f.tradeID,
    source: f.source,
    verdict: fillOk(c) ? 'ok' : [...c.commissionProblems, ...c.builderProblems].join('; '),
  };
}

const COLS = ['order', 'symbol', 'side', 'liquidity', 'quantity', 'price', 'notional', 'commission', 'commissionRate', 'builderFee', 'builderFeeRate', 'orderBuilderFee', 'verdict'] as const;
const HEAD: Record<(typeof COLS)[number], string> = {
  order: 'order', symbol: 'market', side: 'side', liquidity: 'role', quantity: 'qty', price: 'price', notional: 'notional', commission: 'commission', commissionRate: 'rate',
  builderFee: 'builder fee', builderFeeRate: 'rate', orderBuilderFee: 'order carried', verdict: 'check',
};

/** The per-fill fee table as Markdown. */
export function fillTableMarkdown(rows: ReadonlyArray<Record<string, string | number | boolean | null>>): string[] {
  if (!rows.length) return ['No fills were recorded.'];
  const esc = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|');
  return [`| ${COLS.map((c) => HEAD[c]).join(' | ')} |`, `|${COLS.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${COLS.map((c) => esc(r[c])).join(' | ')} |`)];
}
