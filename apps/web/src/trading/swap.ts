/**
 * USDT -> USDC, the way sodex.com does it.
 *
 * SoDEX's own Swap dialog is not a separate venue or a contract: it is a MARKET IOC SELL on
 * the spot pair vUSDT_vUSDC with a floor price of 0.99, in the Spot account (read from its
 * bundle on 2026-11-05). This module keeps its numbers:
 *
 *   floor 0.99     the order cannot fill below it, and the quote only walks bids at or above it
 *   5 to 100,000   USDT per swap (5 is also the market's minNotional)
 *   2 decimals     both ways, rounded down (the market's step size is 0.01)
 *   one way        USDT to USDC. SoDEX's dialog has no way back.
 *
 * The market itself charges no fee (makerFee and takerFee are 0 in /spot/markets/symbols).
 * Like every order this app sends, it carries the builder fee the wallet owes, so the quote
 * takes that off and the sheet shows it: the fee guard refuses an order without it in a
 * build that requires it, and there is no exception for one market.
 *
 * IOC can fill part of the amount. The rest stays USDT, and the result says how much.
 */

export const SWAP_SYMBOL = 'vUSDT_vUSDC';
export const SWAP_FROM_COIN = 'vUSDT';
export const SWAP_FLOOR_PRICE = '0.99';
export const SWAP_MIN = 5;
export const SWAP_MAX = 100_000;
export const SWAP_DECIMALS = 2;
/** How long the result is waited for, as on sodex.com. */
export const SWAP_WAIT_MS = 30_000;

const FLOOR = Number(SWAP_FLOOR_PRICE);

/** Rounded down to the market's two decimals, in text so no float reaches an order. */
export function swapAmount(input: string | number): string {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n) || n <= 0) return '0.00';
  return (Math.floor(n * 100 + 1e-9) / 100).toFixed(SWAP_DECIMALS);
}

export interface BookLevel { price: number; quantity: number }

export interface SwapQuote {
  filled: number;
  /** USDC received, fee taken off. */
  receive: number;
  avgPrice: number;
  fee: number;
  /** USDT the book can take at or above the floor. */
  depth: number;
  exceedsDepth: boolean;
}

/** Walk the bids at or above the floor. `feeFraction` is the builder fee as a fraction of the value. */
export function swapQuote(bids: readonly BookLevel[], amount: string | number, feeFraction = 0): SwapQuote {
  const want = Number(swapAmount(amount));
  const usable = bids.filter((b) => b.price >= FLOOR && b.quantity > 0);
  const depth = usable.reduce((s, b) => s + b.quantity, 0);
  let left = want;
  let value = 0;
  let filled = 0;
  for (const b of usable) {
    if (left <= 0) break;
    const take = Math.min(left, b.quantity);
    value += take * b.price;
    filled += take;
    left -= take;
  }
  const fee = value * feeFraction;
  return {
    filled,
    receive: Math.floor((value - fee) * 100 + 1e-9) / 100,
    avgPrice: filled > 0 ? value / filled : FLOOR,
    fee,
    depth,
    exceedsDepth: want > depth,
  };
}

export type SwapButton = 'enter' | 'quoting' | 'below-min' | 'above-max' | 'no-balance' | 'no-depth' | 'swap';

/** `balance` null: not read yet (or no wallet), so no balance can be claimed short. */
export function swapButton(o: { amount: string; balance: number | null; quote: SwapQuote | null }): SwapButton {
  const n = Number(o.amount);
  if (!o.amount || !Number.isFinite(n) || n <= 0) return 'enter';
  if (!o.quote) return 'quoting';
  if (n > SWAP_MAX) return 'above-max';
  if (n < SWAP_MIN) return 'below-min';
  if (o.balance !== null && n > o.balance) return 'no-balance';
  if (o.quote.exceedsDepth) return 'no-depth';
  return 'swap';
}

export const SWAP_BUTTON_TEXT: Record<SwapButton, string> = {
  enter: 'Enter an amount',
  quoting: 'Getting quote…',
  'below-min': `Min ${SWAP_MIN} USDT per swap`,
  'above-max': `Max ${SWAP_MAX.toLocaleString('en-US')} USDT per swap`,
  'no-balance': 'Not enough USDT in Spot',
  'no-depth': 'Not enough liquidity at this price',
  swap: 'Swap',
};

export interface SwapResult {
  status: 'filled' | 'partial' | 'failed' | 'unknown';
  usdt: number;
  usdc: number;
  /** The client order id, to find it in Order History. */
  clOrdID: string;
}

export interface SwapDeps {
  place: (ticket: {
    symbol: string; side: 'sell'; type: 'market'; tif: 'ioc'; price: string; quantity: string; clOrdID: string;
  }) => Promise<unknown>;
  /** The Spot account's recent orders, newest first. */
  history: () => Promise<ReadonlyArray<Record<string, unknown>>>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DONE = new Set(['FILLED', 'CANCELED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'PARTIALLY_CANCELED']);

/**
 * Place the order and read what happened. A failed send throws (OutcomeUnknownError means it
 * may have gone through). Never re-sends: a swap whose result does not arrive in time comes
 * back as 'unknown', and the caller points at Order History.
 */
export async function runSwap(amount: string, deps: SwapDeps): Promise<SwapResult> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const quantity = swapAmount(amount);
  const clOrdID = `vd_swap_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await deps.place({ symbol: SWAP_SYMBOL, side: 'sell', type: 'market', tif: 'ioc', price: SWAP_FLOOR_PRICE, quantity, clOrdID });

  const until = now() + SWAP_WAIT_MS;
  for (;;) {
    const rows = await deps.history().catch(() => []);
    const row = rows.find((r) => r.clOrdID === clOrdID);
    const status = String(row?.status ?? '').toUpperCase();
    if (row && DONE.has(status)) {
      const usdt = Number(row.executedQty ?? 0);
      const usdc = Number(row.executedValue ?? 0);
      if (!(usdt > 0)) return { status: 'failed', usdt: 0, usdc: 0, clOrdID };
      return { status: usdt >= Number(quantity) ? 'filled' : 'partial', usdt, usdc, clOrdID };
    }
    if (now() >= until) return { status: 'unknown', usdt: 0, usdc: 0, clOrdID };
    await wait(1000);
  }
}
