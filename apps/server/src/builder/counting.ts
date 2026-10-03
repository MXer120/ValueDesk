/**
 * What counts as volume, pure (docs/BUILDER-TIERS.md §5). No I/O, no clock.
 *
 * TWO SOURCES, because neither says everything (both read on mainnet, 2026-10-02):
 *
 *  - A FILL (`GET /api/v1/{engine}/accounts/{address}/trades`) says what was
 *    paid: `price`, `quantity`, `side`, `orderID`, `time`, and `builderFee` -
 *    present only when SoDEX charged a builder fee on that fill, and then
 *    exactly notional x rate / 100 000. It does not say WHICH builder was paid.
 *  - THE ORDER'S SIGNED REQUEST, on SoDEX's public explorer, names the builder
 *    and the fee, carries the time the order was created, and the signature
 *    the key that sent it can be recovered from (explorer.ts).
 *
 * The gateway's order history cannot stand in for either: its rows for
 * finished orders carry no `builder` at all (only open orders do), whatever
 * the published schema says.
 *
 * So fills are added up per order, and an order's fills count once the
 * explorer has shown that the order
 *   1. names OUR builder,
 *   2. at a fee of at least the fee the wallet owed when the order was created,
 *   3. and SoDEX charged that fee: fills that carry `builderFee` - every perps
 *      fill, on spot only sells - on a pair quoted in a dollar coin.
 * Counted volume is the notional (price x quantity) of those fills. An order
 * that fills further later adds its new fills, each once.
 *
 * Nothing the browser sends takes part in any of this.
 */
import { canonicalDecimal } from '../decimal.js';
import type { Engine, Fee } from './config.js';
import { MICRO } from './tiers.js';
import { TERMS_TTL_MS } from './terms.js';

// --- the fee owed over time -------------------------------------------------------

/** A wallet's fee from `at` on: one row each time the fee the server signs for it changed. */
export interface FeeRow {
  at: number;
  perps: number;
  spot: number;
}

/**
 * How far SoDEX's clock (an order's time) and this server's (when a fee was
 * recorded) may differ, and how long an order may be on its way.
 */
export const CLOCK_SLACK_MS = 120_000;

/** Terms signed just before a change are valid for `ttl` more; then the slack. */
export const graceMs = (ttl: number = TERMS_TTL_MS): number => ttl + CLOCK_SLACK_MS;

/** The last row at or before `x`, or undefined. Rows are in time order. */
const rowAt = (rows: readonly FeeRow[], x: number): FeeRow | undefined => {
  let hit: FeeRow | undefined;
  for (const row of rows) {
    if (row.at <= x) hit = row;
    else break;
  }
  return hit;
};

/** A default fee as rows: one row for all time. */
export const defaultsOf = (dflt: Fee): FeeRow[] => [{ at: 0, perps: dflt.perps, spot: dflt.spot }];

/**
 * The fee a wallet owed on `engine` for an order created at `t`: the lowest
 * fee in force at any moment from `t - grace` to `t + slack`.
 *
 * What is in force at a moment is the wallet's own latest row; a wallet with
 * no row yet owes the default of that moment. `defaults` is the default fee
 * over time: one row each time the first tier changed, and before the first
 * row, that row. So raising the default in the file never turns an order that
 * was right when it was placed into an underpaid one.
 *
 * The window is what makes an honest app's order always pass: terms it got
 * just before the fee went up stay valid for their `ttl`, and SoDEX's clock
 * may run a little behind the one that recorded a fee going down.
 */
export function feeOwedAt(
  history: readonly FeeRow[],
  defaults: readonly FeeRow[],
  engine: Engine,
  t: number,
  grace: number = graceMs(),
  slack: number = CLOCK_SLACK_MS,
): number {
  if (!defaults.length) throw new RangeError('feeOwedAt: the default fee is not known');
  const from = t - grace;
  const to = t + slack;
  const inForce = (x: number): number => (rowAt(history, x) ?? rowAt(defaults, x) ?? defaults[0]!)[engine];
  let owed = inForce(from);
  for (const rows of [history, defaults]) {
    for (const row of rows) {
      if (row.at > from && row.at <= to) owed = Math.min(owed, inForce(row.at));
    }
  }
  return owed;
}

// --- exact decimals -----------------------------------------------------------------

/** A non-negative decimal as digits and a scale: "12.5" -> { digits: 125n, scale: 1 }. Null when it is not one. */
function decimalOf(v: unknown): { digits: bigint; scale: number } | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  let c: string;
  try {
    c = canonicalDecimal(v);
  } catch {
    return null;
  }
  if (c.startsWith('-')) return null;
  const [i = '0', f = ''] = c.split('.');
  // Longer than any real price or size: refuse rather than build a huge number.
  if (i.length > 30 || f.length > 30) return null;
  return { digits: BigInt(i + f), scale: f.length };
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const toSafe = (n: bigint): number => Number(n > MAX_SAFE ? MAX_SAFE : n);

/** Sums of micro-USD never leave the range a number holds exactly. */
export const addMicro = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);

// --- fills ----------------------------------------------------------------------------

/** Coins a notional in which is a dollar amount. */
const DOLLAR_COINS = new Set(['vUSDC', 'USDC', 'vUSDT', 'USDT', 'vUSD', 'USD']);

/** `vBTC_vUSDC` -> vUSDC. Perps symbols (`BTC-USD`) are dollar-quoted throughout. */
export function dollarQuoted(engine: Engine, symbol: string): boolean {
  if (engine === 'perps') return true;
  const cut = symbol.lastIndexOf('_');
  return cut > 0 && DOLLAR_COINS.has(symbol.slice(cut + 1));
}

export interface Fill {
  /** Unique per wallet and engine. Not `tradeID` alone: it is unique per market, and both sides of a trade against oneself share it. */
  key: string;
  orderKey: string;
  orderId: string;
  symbol: string;
  clOrdID: string | null;
  sell: boolean;
  time: number;
  /** price x quantity in micro-USD, rounded down; 0 on a pair that is not quoted in a dollar coin. */
  notionalMicro: number;
  /** A fill SoDEX charges a builder fee on when the order names a builder: every perps fill, spot sells. */
  charging: boolean;
  /** The row carries a builder fee, in whatever coin. */
  charged: boolean;
  /** ... and it is one that can be counted: a charging fill of a dollar-quoted pair, paid in a dollar coin. */
  paid: boolean;
  /** The rate that fee comes to, in tenths of a basis point (0 unless `paid`). */
  rate: number;
}

const sideOf = (v: unknown): 'BUY' | 'SELL' | null => {
  if (v === 1 || v === 2) return v === 1 ? 'BUY' : 'SELL';
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return s === 'BUY' || s === 'SELL' ? s : null;
};

const idOf = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return v;
  return null;
};

/** One row of `/trades` as the rules need it; null for a row that cannot be read. */
export function readFill(raw: unknown, engine: Engine): Fill | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const symbol = typeof r.symbol === 'string' && r.symbol.length <= 64 ? r.symbol : null;
  const orderId = idOf(r.orderID);
  const tradeId = idOf(r.tradeID);
  const side = sideOf(r.side);
  const time = typeof r.time === 'number' && Number.isSafeInteger(r.time) && r.time > 0 ? r.time : null;
  const price = decimalOf(r.price);
  const quantity = decimalOf(r.quantity);
  if (!symbol || !orderId || !tradeId || !side || time === null || !price || !quantity) return null;

  const usd = dollarQuoted(engine, symbol);
  const notional = price.digits * quantity.digits; // at scale price.scale + quantity.scale
  const scale = price.scale + quantity.scale;
  const notionalMicro = usd ? toSafe((notional * BigInt(MICRO)) / pow10(scale)) : 0;

  const fee = decimalOf(r.builderFee);
  const feeCoin = typeof r.feeCoin === 'string' ? r.feeCoin : null;
  const charging = engine === 'perps' || side === 'SELL';
  const charged = !!fee && fee.digits > 0n;
  // Charged in a coin that is not a dollar coin: not ours to count in dollars.
  const paid = charged && charging && usd && notional > 0n && (feeCoin === null || DOLLAR_COINS.has(feeCoin));
  let rate = 0;
  if (paid && fee) {
    // fee / notional x 100 000, rounded to the nearest whole rate.
    const num = fee.digits * pow10(scale) * 100_000n;
    const den = notional * pow10(fee.scale);
    rate = toSafe((2n * num + den) / (2n * den));
  }
  const clOrdID = typeof r.clOrdID === 'string' && r.clOrdID.length <= 64 ? r.clOrdID : null;
  return {
    key: `${symbol}:${tradeId}:${orderId}`,
    orderKey: `${symbol}:${orderId}`,
    orderId,
    symbol,
    clOrdID,
    sell: side === 'SELL',
    time,
    notionalMicro,
    charging,
    charged,
    paid,
    rate,
  };
}

// --- orders -----------------------------------------------------------------------------

export const OrderState = {
  /** Its fills paid a builder fee; whose builder, and at which fee, is not known yet. */
  pending: 0,
  /** The explorer showed our builder at the fee owed: its paid fills count, later ones too. */
  counted: 1,
  /** Another builder's order: nothing counts. */
  other: 2,
  /** Our builder, below the fee owed: nothing counts. */
  underpaid: 3,
  /** The explorer could not say: nothing counts. */
  unknown: 4,
  /** No builder fee was charged; waiting to be looked up for the key that signed it. */
  check: 5,
  /** Looked up. */
  checked: 6,
} as const;
export type OrderStateValue = (typeof OrderState)[keyof typeof OrderState];

/** States the explorer still has to look at. */
export const awaitsExplorer = (s: OrderStateValue): boolean => s === OrderState.pending || s === OrderState.check;

export interface OrderRow {
  /** `${symbol}:${orderID}` - order ids are only known to be unique per market. */
  key: string;
  orderId: string;
  symbol: string;
  clOrdID: string | null;
  /** When its first and its latest fill happened. */
  t: number;
  lastT: number;
  state: OrderStateValue;
  /** Notional of its fills that paid a builder fee, micro-USD. */
  paidMicro: number;
  /** Pending: the lowest rate those fills paid. Counted: the fee the order names. */
  rate: number;
  /** What it has added to the wallet's counted volume. */
  countedMicro: number;
  /** Explorer attempts so far, and the earliest time of the next. */
  tries: number;
  nextAt: number;
}

/** The app's client order ids (apps/web/src/trading/orderParams.ts genClOrdID). */
export const APP_ORDER_ID = /^(vs|tp|sl)-/;

/** Builder-less orders noted per batch of fills at most (rows are what keeps a flag from being raised twice). */
export const MAX_NOTED = 20;

export interface FillsInput {
  fills: readonly Fill[];
  /** The row held for an order, if any. Asked only for orders whose fills matter. */
  row: (orderKey: string) => OrderRow | null;
  /** The fee the wallet owed on this engine for an order created at `t`. */
  owedAt: (t: number) => number;
  /** How many builder-less orders may be put up for a look at who signed them. */
  checks: number;
}

export interface FillsResult {
  /** Micro-USD to add to the wallet's counted volume now. */
  addMicro: number;
  /** Rows to store: new ones and changed ones. */
  rows: OrderRow[];
  /** New rows the explorer has to look at. */
  queued: number;
  /** Orders with the app's client order id that paid no builder fee where one was owed. */
  noBuilder: { n: number; at: number };
}

/**
 * Add a batch of fills to the orders they belong to. The caller sees to it
 * that a fill of an order with a row arrives here once.
 *
 * Fills of an order already known to be ours count at once. Fills that paid a
 * builder fee on an order not looked up yet wait in a pending row. An order
 * whose fills paid none, where one was owed, is worth a look at who signed it:
 * the first `checks` are put up, those with the app's own client order id
 * first - and each of those is one for the `no-builder` flag, once.
 */
export function applyFills(input: FillsInput): FillsResult {
  const groups = new Map<string, Fill[]>();
  for (const f of input.fills) {
    const g = groups.get(f.orderKey);
    if (g) g.push(f);
    else groups.set(f.orderKey, [f]);
  }

  const out: FillsResult = { addMicro: 0, rows: [], queued: 0, noBuilder: { n: 0, at: 0 } };
  const unpaid: Array<{ first: Fill; last: number; app: boolean }> = [];

  for (const [orderKey, fills] of groups) {
    let first = fills[0]!;
    let last = first.time;
    let paidMicro = 0;
    let rate = Number.MAX_SAFE_INTEGER;
    let unpaidCharging = false;
    for (const f of fills) {
      if (f.time < first.time) first = f;
      if (f.time > last) last = f.time;
      if (f.paid) {
        paidMicro = addMicro(paidMicro, f.notionalMicro);
        rate = Math.min(rate, f.rate);
      } else if (f.charging && !f.charged) unpaidCharging = true;
    }

    if (paidMicro > 0) {
      const held = input.row(orderKey);
      if (!held) {
        out.rows.push({
          key: orderKey, orderId: first.orderId, symbol: first.symbol, clOrdID: first.clOrdID,
          t: first.time, lastT: last, state: OrderState.pending, paidMicro, rate, countedMicro: 0, tries: 0, nextAt: 0,
        });
        out.queued += 1;
        continue;
      }
      const row: OrderRow = { ...held, t: Math.min(held.t, first.time), lastT: Math.max(held.lastT, last), paidMicro: addMicro(held.paidMicro, paidMicro) };
      if (row.state === OrderState.counted) {
        // A known order of ours filling further. The fee is the order's, so its fills pay it; one that paid less is left out.
        let add = 0;
        for (const f of fills) if (f.paid && f.rate >= row.rate) add = addMicro(add, f.notionalMicro);
        row.countedMicro = addMicro(row.countedMicro, add);
        out.addMicro = addMicro(out.addMicro, add);
      } else if (row.state === OrderState.pending) row.rate = Math.min(row.rate, rate);
      out.rows.push(row);
      continue;
    }

    // No builder fee on a fill that carries one whenever the order names a builder.
    if (unpaidCharging && input.owedAt(first.time) > 0) {
      unpaid.push({ first, last, app: first.clOrdID !== null && APP_ORDER_ID.test(first.clOrdID) });
    }
  }

  // The app's own client order ids first, then the newest.
  unpaid.sort((a, b) => Number(b.app) - Number(a.app) || b.first.time - a.first.time);
  let checks = Math.max(0, input.checks);
  let noted = 0;
  for (const u of unpaid) {
    if (noted >= MAX_NOTED || (checks <= 0 && !u.app)) break;
    if (input.row(u.first.orderKey)) continue; // seen before: neither flagged nor looked up again
    const look = checks > 0;
    if (look) checks -= 1;
    out.rows.push({
      key: u.first.orderKey, orderId: u.first.orderId, symbol: u.first.symbol, clOrdID: u.first.clOrdID,
      t: u.first.time, lastT: u.last, state: look ? OrderState.check : OrderState.checked, paidMicro: 0, rate: 0, countedMicro: 0, tries: 0, nextAt: 0,
    });
    noted += 1;
    if (look) out.queued += 1;
    if (u.app) {
      out.noBuilder.n += 1;
      out.noBuilder.at = Math.max(out.noBuilder.at, u.first.time);
    }
  }
  return out;
}

// --- what the explorer says about an order -------------------------------------------------

/** An order's signed request as the explorer returns it (explorer.ts reads it). */
export interface OrderFacts {
  /** When the order was created (the request's time on SoDEX), ms. */
  createdAt: number;
  /** The builder the order names, if any. */
  builder: { id: string; fee: number } | null;
  /** The address of the key that signed the request; null when it could not be recovered. */
  signer: string | null;
  txHash: string | null;
}

export interface JudgeContext {
  builderId: number;
  /** The fee the wallet owed on this engine at `facts.createdAt`. */
  owed: number;
  /** Addresses of the keys our app registered for this wallet (lower case). */
  appKeys: ReadonlySet<string>;
  /** Orders created before this are never called tampered: the feature did not exist. */
  since: number;
}

export interface Judgement {
  state: OrderStateValue;
  /** Micro-USD to add to the wallet's counted volume. */
  addMicro: number;
  /** The fee the order names for our builder (the row's `rate` once counted). */
  rate: number;
  underpaid: boolean;
  tampered: boolean;
}

/**
 * Decide an order once its request has been read.
 *
 * `tampered` needs proof, and this is it: the request was signed by a key our
 * app registered, and it does not carry our builder at the fee owed - which
 * the unmodified app never sends. An order signed by any other key is the
 * user's own business and proves nothing.
 */
export function judgeOrder(row: OrderRow, facts: OrderFacts, ctx: JudgeContext): Judgement {
  const ours = facts.builder !== null && facts.builder.id === String(ctx.builderId);
  const fee = ours ? facts.builder!.fee : 0;
  const pays = ours && fee >= ctx.owed;
  const byApp = facts.signer !== null && ctx.appKeys.has(facts.signer);
  const tampered = byApp && !pays && ctx.owed > 0 && facts.createdAt >= ctx.since;

  if (row.state === OrderState.check) {
    return { state: OrderState.checked, addMicro: 0, rate: row.rate, underpaid: false, tampered };
  }
  if (pays) {
    // The fills are the order's: they paid its fee. A row that says otherwise was misread - count nothing.
    if (row.rate + 1 < fee) return { state: OrderState.unknown, addMicro: 0, rate: row.rate, underpaid: false, tampered: false };
    return { state: OrderState.counted, addMicro: row.paidMicro, rate: fee, underpaid: false, tampered: false };
  }
  if (ours) return { state: OrderState.underpaid, addMicro: 0, rate: row.rate, underpaid: true, tampered };
  return { state: OrderState.other, addMicro: 0, rate: row.rate, underpaid: false, tampered };
}
