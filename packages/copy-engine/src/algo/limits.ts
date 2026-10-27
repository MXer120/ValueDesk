/**
 * SoDEX's limits beyond one order's size: how large a position may grow, and
 * how much open interest a market may still take. Pure; the planner (the
 * ticket's warnings), the runtime's start check (the executor's authority)
 * and its pre-send guard all read the same functions.
 *
 * WHAT SODEX LISTS (GET /api/v1/perps/markets/symbols, 2026-10-27):
 *   marginTiers[]      { maxNotionalValue, maxLeverage, ... }: a position may be
 *                      worth up to maxNotionalValue at up to maxLeverage. The
 *                      largest position at a leverage is the largest band that
 *                      still allows it (BTC-USD: $4M at 40x, $100M at 25x).
 *   openInterestCap    the market's open-interest cap in the coin
 *   openInterestCapUSD the same cap in USD (DOGE-USD: $5M, while its coin cap is 1e12)
 *   openInterest       on the tickers and mark prices (REST and markPrice socket), in the coin
 * SoDEX lists no cap on the number of open orders or of positions.
 *
 * WHAT IT SAYS WHEN ONE IS HIT is not documented: limitRefusal reads its
 * refusal text loosely, so a hit holds the algo instead of re-sending.
 */
import type { MarketInfo } from '../types.ts';
import type { Side } from './types.ts';

/** At or over this share of the open interest still allowed, the ticket warns (amber). */
export const OI_NEAR_SHARE = 0.8;

const usd = (n: number): string => (n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);

/**
 * The largest position SoDEX allows on `m` at `leverage`, in USD: the largest
 * tier whose leverage is at least it. null: no tiers listed. Leverage unknown:
 * the largest tier (the cap at any leverage).
 */
export function positionCapUsd(m: Pick<MarketInfo, 'marginTiers'>, leverage: number | null): number | null {
  const tiers = m.marginTiers;
  if (!tiers?.length) return null;
  if (leverage === null || !(leverage > 0)) return Math.max(...tiers.map((t) => t.maxNotionalValue));
  const fit = tiers.filter((t) => t.maxLeverage >= leverage - 1e-9);
  // Over every tier's leverage: SoDEX would not set it; the smallest tier is what such a position could be.
  return fit.length ? Math.max(...fit.map((t) => t.maxNotionalValue)) : Math.min(...tiers.map((t) => t.maxNotionalValue));
}

/**
 * The open interest `m` may still take, in the coin: its cap (the smaller of
 * the coin cap and the USD cap at `price`) less what is open now. null: no cap
 * listed, or the open interest or price is not known.
 */
export function oiHeadroom(m: Pick<MarketInfo, 'openInterestCap' | 'openInterestCapUSD'>, oi: number | null | undefined, price: number | null): { cap: number; open: number; room: number } | null {
  if (oi === null || oi === undefined || !Number.isFinite(oi) || oi < 0) return null;
  const byQty = m.openInterestCap && m.openInterestCap > 0 ? m.openInterestCap : Infinity;
  const byUsd = m.openInterestCapUSD && m.openInterestCapUSD > 0 && price && price > 0 ? m.openInterestCapUSD / price : Infinity;
  const cap = Math.min(byQty, byUsd);
  if (!Number.isFinite(cap)) return null;
  return { cap, open: oi, room: Math.max(0, cap - oi) };
}

export interface LimitInput {
  side: Side;
  /** What the order adds on its side, in the coin (the whole algo, or one child). */
  quantity: number;
  price: number;
  /** The trader's signed position now (null: not known, counted as none). */
  position: number | null;
  /** The leverage it trades at (null: not known). */
  leverage: number | null;
  /** The market's open interest now, in the coin (null: not known). */
  oi: number | null;
}

export interface LimitCheck {
  errors: string[];
  warnings: string[];
  /** The open-interest cap: the order would reach it ('over') or take most of what is left ('near'). */
  oi: { level: 'over' | 'near'; share: number; roomUsd: number } | null;
  /** The most this order may be under the position limit, in the coin (Infinity: no limit listed). */
  maxByPosition: number;
  /** The most this order may be under the open-interest cap, in the coin (Infinity: no cap known). */
  maxByOi: number;
}

/**
 * Whether an opening order fits SoDEX's position limit at its leverage
 * (an error: SoDEX refuses it) and the market's open-interest cap (a warning:
 * the open interest moves, and a long algo may still find room).
 */
export function checkLimits(m: MarketInfo, x: LimitInput): LimitCheck {
  const out: LimitCheck = { errors: [], warnings: [], oi: null, maxByPosition: Infinity, maxByOi: Infinity };
  if (!(x.quantity > 0) || !(x.price > 0)) return out;
  const pos = x.position ?? 0;
  const after = pos + (x.side === 'buy' ? x.quantity : -x.quantity);
  // Only what makes the position larger counts: a sell against a long reduces it first.
  const grows = Math.max(0, Math.abs(after) - Math.abs(pos));
  // What it closes first, before anything it opens (a sell against a long).
  const closes = (x.side === 'buy' ? pos < 0 : pos > 0) ? Math.abs(pos) : 0;
  const cap = positionCapUsd(m, x.leverage);
  if (cap !== null) {
    const capQty = cap / x.price;
    out.maxByPosition = closes > 0 ? closes + capQty : Math.max(0, capQty - Math.abs(pos));
    if (grows > 0 && Math.abs(after) * x.price > cap + 1e-6) {
      const most = positionCapUsd(m, null) ?? cap;
      const lev = x.leverage !== null ? ` at ${x.leverage}x` : '';
      out.errors.push(`Your ${m.name} position would be about ${usd(Math.abs(after) * x.price)}, over SoDEX's limit of ${usd(cap)}${lev}. ${most > cap + 1e-6 ? 'Use a smaller size or lower leverage.' : 'Use a smaller size.'}`);
    }
  }
  const head = oiHeadroom(m, x.oi, x.price);
  if (head) out.maxByOi = closes + head.room;
  if (head && grows > 0) {
    const roomUsd = head.room * x.price;
    const share = head.room > 0 ? grows / head.room : Infinity;
    if (head.room <= 0) {
      out.oi = { level: 'over', share, roomUsd: 0 };
      out.warnings.push(`Open interest on ${m.name} is at SoDEX's cap: SoDEX refuses orders that open more until it drops.`);
    } else if (share >= 1 - 1e-9) {
      out.oi = { level: 'over', share, roomUsd };
      out.warnings.push(`This order would hit SoDEX's open-interest cap on ${m.name}: about ${usd(roomUsd)} is left and it adds ${usd(grows * x.price)}. SoDEX refuses what goes over the cap.`);
    } else if (share >= OI_NEAR_SHARE) {
      out.oi = { level: 'near', share, roomUsd };
      out.warnings.push(`This order would use ${Math.round(share * 100)}% of the open interest still allowed on ${m.name} (about ${usd(roomUsd)} left). Once the cap is reached, SoDEX refuses new orders there.`);
    }
  }
  return out;
}

/** A refusal by one of SoDEX's limits (not one order's own size or price): which one, in words. */
export interface LimitRefusal {
  kind: 'oi' | 'position' | 'orders';
  text: string;
}

/**
 * Whether SoDEX's refusal text names the open-interest cap, the position
 * limit, or a cap on open orders. SoDEX does not document the wording, so the
 * match is loose; anything else is an ordinary refusal.
 */
export function limitRefusal(error: string | null | undefined, symbol: string): LimitRefusal | null {
  const e = String(error ?? '');
  if (!e) return null;
  if (/open[\s_-]?interest|\boi\b[^.]*\b(cap|limit|exceed)/i.test(e)) return { kind: 'oi', text: `SoDEX's open-interest cap on ${symbol} is reached.` };
  if (/position[^.]*\b(limit|exceed|too (large|big)|max)|max(imum)?[\s_-]?position|risk[\s_-]?limit/i.test(e) && !/not found|no position/i.test(e)) return { kind: 'position', text: `SoDEX's position limit on ${symbol} is reached.` };
  if (/(too many|max(imum)?( number of)?|limit (of|on)) (open |active |pending )?orders|open[\s_-]?orders?[^.]*\b(limit|exceed|max)/i.test(e)) return { kind: 'orders', text: 'SoDEX\'s limit on open orders is reached.' };
  return null;
}
