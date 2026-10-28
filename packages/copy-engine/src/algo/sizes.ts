/**
 * Every child an algo plans must be an order SoDEX takes: at least its
 * smallest order (minNotional, minQuantity) and at most its largest
 * (maxNotional, maxQuantity). Pure; the ticket (planAlgo) and the runtime's
 * start (AlgoRuntime.add, the executor's authority) read the same function,
 * so both say the same thing.
 *
 * NO SILENT RESHAPING (owner, 2026-10-28). A plan with a child under the
 * minimum or over the maximum is an ERROR that says why and what fixes it;
 * nothing is merged into fewer orders or split into more. Each child of a DCA,
 * a ladder, a grid, a bracket or a basket has its own price, time and meaning.
 *
 * What stays, because the algo itself decides each child as it runs (and the
 * ticket says so in `notes`, the runtime in the algo's activity):
 *   POV       each order is what the market's volume makes due: what is due
 *             waits until it reaches SoDEX's minimum; none is over its largest.
 *   schedules (TWAP, VWAP) a slice that could not go out when it was due
 *             (held, not filled while resting, max participation) goes with the
 *             next one: the schedule catches up, it is never re-cut up front.
 *             A DCA never does: each of its orders stays an order of its own
 *             (runtime stepDca), as each level of a ladder does.
 *   iceberg   what is left after a clip, when it is under SoDEX's minimum,
 *             goes out with that clip.
 *   closes    a position over SoDEX's largest order (a trailing stop or a
 *             conditional close of the whole position) closes in several orders.
 */
import type { MarketInfo } from '../types.ts';
import { allocateSteps, floorStep, ladderPrices, maxOrderQty, minChildQty, snapNearest, type VolumeProfile } from './math.ts';
import { scaleLadder, sliceBounds, swarmClips, twapSchedule, vwapSchedule } from './plan.ts';
import { ALGO_LIMITS } from './spec.ts';
import type { AlgoSpec } from './types.ts';

export interface SizeCheck {
  /** The plan cannot start: a child SoDEX would refuse, with the fix in words. */
  errors: string[];
  /** Child sizes the algo decides as it runs, said before the start (info, not a warning). */
  notes: string[];
}

export interface SizeContext {
  /** The reference price of the algo's market (null: not known; only priced children are checked). */
  price: number | null;
  seed: number;
  /** When it starts (VWAP's profile slots). */
  now?: number;
  /** The trader's signed position on the market (a time-sliced close, a close of the position). */
  positionSize?: number | null;
  /** VWAP's volume profile, once read. */
  profile?: VolumeProfile | null;
  /** Other markets (a basket's legs, a conditional's algo); absent: only `m`. */
  market?: (symbol: string) => MarketInfo | null | undefined;
  /** Other markets' prices; absent: only `price` for `m`. */
  prices?: (symbol: string) => number | null | undefined;
}

/** USD in a few characters: $6.20, $120, $12,300, $4.02M, $52.3M, $1.3B. */
export function money(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  // Two decimals under 10 (so $4.02M is not said as the $4M limit it is over), one above.
  const short = (x: number, unit: string) => `${sign}$${(x < 10 ? Math.round(x * 100) / 100 : Math.round(x * 10) / 10).toString()}${unit}`;
  if (a >= 1e9) return short(a / 1e9, 'B');
  if (a >= 1e6) return short(a / 1e6, 'M');
  if (a >= 100) return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
  // Whole dollars without cents ($10), the rest to the cent ($6.20).
  if (Math.abs(a - Math.round(a)) < 0.005) return `${sign}$${Math.round(a)}`;
  return `${sign}$${a.toFixed(2)}`;
}

/** `n` rounded UP to what money() shows, so "raise it to $X" is always enough. */
export function moneyUp(n: number): string {
  if (n >= 1e9) return money(Math.ceil(n / (n < 1e10 ? 1e7 : 1e8)) * (n < 1e10 ? 1e7 : 1e8));
  if (n >= 1e6) return money(Math.ceil(n / (n < 1e7 ? 1e4 : 1e5)) * (n < 1e7 ? 1e4 : 1e5));
  if (n >= 100) return money(Math.ceil(n - 1e-9));
  return money(Math.ceil(n * 100 - 1e-9) / 100);
}

/** `n` rounded DOWN to what money() shows, so "at most $X" never overshoots. */
export function moneyDown(n: number): string {
  if (n >= 1e9) return money(Math.floor(n / (n < 1e10 ? 1e7 : 1e8)) * (n < 1e10 ? 1e7 : 1e8));
  if (n >= 1e6) return money(Math.floor(n / (n < 1e7 ? 1e4 : 1e5)) * (n < 1e7 ? 1e4 : 1e5));
  if (n >= 100) return money(Math.floor(n + 1e-9));
  return money(Math.floor(n * 100 + 1e-9) / 100);
}

/** A coin amount in a few characters: 612, 6.67, 0.0042. */
export function coins(q: number): string {
  const a = Math.abs(q);
  if (a >= 100) return Math.round(q).toLocaleString('en-US');
  if (a >= 1) return Number(q.toFixed(2)).toString();
  if (a === 0) return '0';
  return Number(q.toPrecision(3)).toString();
}

const qtyText = (q: number): string => Number(q.toPrecision(12)).toString();

/** "SoDEX's $10 minimum" - or its smallest quantity, where that is what binds at `price`. */
export function minWords(m: MarketInfo, price: number): string {
  const minQ = Number(m.minQuantity) || 0;
  if (minQ * price > m.minNotional + 1e-9) return `SoDEX's smallest order of ${qtyText(minQ)} ${m.base} (about ${money(minQ * price)})`;
  return `SoDEX's ${money(m.minNotional)} minimum`;
}

/** "SoDEX's $4M per order on BTC-USD" - or its largest quantity, where that is what binds at `price`. */
export function maxWords(m: MarketInfo, price: number): string {
  const byQty = Number(m.maxQuantity) > 0 ? Number(m.maxQuantity) : Infinity;
  if (m.maxNotional && byQty * price >= m.maxNotional - 1e-9) return `SoDEX's ${money(m.maxNotional)} per order on ${m.name}`;
  return `SoDEX's largest order of ${qtyText(byQty)} ${m.base} (about ${money(byQty * price)}) on ${m.name}`;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/**
 * A schedule of `count` children (slices, clips, levels), each checked
 * against SoDEX's smallest and largest order. `sizes(k)` is the schedule with
 * k children (quantities and their prices); the fix is searched from it.
 */
function scheduleCheck(o: {
  unit: string;
  count: number;
  counts: { min: number; max: number };
  sizes: (k: number) => Array<{ qty: number; price: number }>;
  total: number;
  m: MarketInfo;
  /** The count is not the trader's to change (a ladder of typed prices): only the size is offered. */
  fixedCount?: boolean;
}): string[] {
  const { unit, count, m } = o;
  const kids = o.sizes(count).filter((c) => c.qty > 0);
  if (!kids.length) return [];
  const under = (c: { qty: number; price: number }) => c.qty < minChildQty(m, c.price) - 1e-12;
  const over = (c: { qty: number; price: number }) => c.qty > maxOrderQty(m, c.price) + 1e-12;
  const fits = (k: number, test: (c: { qty: number; price: number }) => boolean) => !o.sizes(k).filter((c) => c.qty > 0).some(test);
  const out: string[] = [];
  const usdOf = (c: { qty: number; price: number }) => c.qty * c.price;
  // Even: the children differ by no more than SoDEX's step (the rounding), so "each" is said with their average.
  const vals = kids.map(usdOf);
  const even = Math.max(...vals) - Math.min(...vals) <= Number(m.stepSize) * Math.max(...kids.map((c) => c.price)) * 1.01 + 0.01;
  const avgUsd = vals.reduce((x, y) => x + y, 0) / vals.length;
  const small = kids.filter(under);
  if (small.length) {
    const smallest = small.reduce((a, b) => (usdOf(a) <= usdOf(b) ? a : b));
    const avgPx = kids.reduce((x, c) => x + usdOf(c), 0) / kids.reduce((x, c) => x + c.qty, 0);
    const what = even && small.length === kids.length
      ? `Each of the ${kids.length} ${plural(kids.length, unit)} would be about ${money(avgUsd)}, under ${minWords(m, smallest.price)}.`
      : `${small.length === kids.length ? `All ${kids.length}` : `${small.length} of the ${kids.length}`} ${plural(kids.length, unit)} would be under ${minWords(m, smallest.price)} (the smallest about ${money(usdOf(smallest))}).`;
    // The size that lifts every child to the minimum: even, each at it; else the smallest lifted to it (children scale with the size).
    const needUsd = even ? kids.length * minChildQty(m, avgPx) * avgPx : (o.total * minChildQty(m, smallest.price) / smallest.qty) * avgPx;
    let most: number | null = null;
    if (!o.fixedCount) {
      // Estimated from the smallest child, then checked against the real schedule (jitter, urgency, a profile).
      const est = Math.floor(count * (smallest.qty / minChildQty(m, smallest.price)));
      for (let k = Math.min(count - 1, est + 2); k >= o.counts.min && k >= est - 40; k--) {
        if (fits(k, under)) {
          most = k;
          break;
        }
      }
    }
    const fix = most !== null
      ? `Use at most ${most} ${plural(most, unit)}, or raise the size to ${moneyUp(needUsd)}.`
      : o.fixedCount ? `Raise the size to ${moneyUp(needUsd)}, or use fewer ${unit}s.` : `Raise the size to ${moneyUp(needUsd)}.`;
    out.push(`${what} ${fix}`);
  }
  const big = kids.filter(over);
  if (big.length) {
    const largest = big.reduce((a, b) => (usdOf(a) >= usdOf(b) ? a : b));
    const what = even && big.length === kids.length
      ? `Each ${unit} would be about ${money(avgUsd)}, over ${maxWords(m, largest.price)}.`
      : `${big.length === kids.length ? `All ${kids.length}` : `${big.length} of the ${kids.length}`} ${plural(kids.length, unit)} would be over ${maxWords(m, largest.price)} (the largest about ${money(usdOf(largest))}).`;
    let least: number | null = null;
    if (!o.fixedCount) {
      const est = Math.ceil(count * (largest.qty / maxOrderQty(m, largest.price)));
      for (let k = Math.max(count + 1, est - 2); k <= o.counts.max && k <= est + 40; k++) {
        if (fits(k, over)) {
          least = k;
          break;
        }
      }
    }
    const fix = least !== null ? `Use at least ${least} ${plural(least, unit)}.` : o.fixedCount ? `Use a smaller size, or more ${unit}s.` : `Use a smaller size${count < o.counts.max ? ` (more than ${o.counts.max} ${unit}s would be needed)` : ''}.`;
    out.push(`${what} ${fix}`);
  }
  return out;
}

/** One order: at least SoDEX's smallest, at most its largest. */
function oneOrder(qty: number, price: number, m: MarketInfo, what = 'The order'): string[] {
  if (!(qty > 0) || !(price > 0)) return [];
  const minQ = minChildQty(m, price);
  const maxQ = maxOrderQty(m, price);
  if (qty < minQ - 1e-12) return [`${what} would be about ${money(qty * price)}, under ${minWords(m, price)}. Raise the size to at least ${qtyText(minQ)} ${m.base} (about ${moneyUp(minQ * price)}).`];
  if (qty > maxQ + 1e-12) return [`${what} would be about ${money(qty * price)}, over ${maxWords(m, price)}. Use at most ${qtyText(maxQ)} ${m.base}, or a TWAP or Swarm to spread it over several orders.`];
  return [];
}

/** Whether the children of `s` on `m` are all orders SoDEX takes (see the head of this file). */
export function checkSizes(s: AlgoSpec, m: MarketInfo, ctx: SizeContext): SizeCheck {
  const out: SizeCheck = { errors: [], notes: [] };
  const px = ctx.price !== null && ctx.price > 0 ? ctx.price : null;
  const step = Number(m.stepSize);
  const start = Math.max(ctx.now ?? 0, s.startAt ?? ctx.now ?? 0);
  const minUsdWords = px ? minWords(m, px) : `SoDEX's ${money(m.minNotional)} minimum`;
  switch (s.kind) {
    case 'twap': {
      const pos = ctx.positionSize ?? null;
      const total = s.closeShare !== null ? (pos ? floorStep(Math.abs(pos) * s.closeShare, m) : null) : Number(s.quantity);
      if (!px || !total) break;
      const minSlice = s.minSliceQty !== null ? Number(s.minSliceQty) : 0;
      const maxSlice = s.maxSliceQty !== null ? Number(s.maxSliceQty) : Infinity;
      if (s.maxSliceQty !== null && maxSlice > maxOrderQty(m, px) + 1e-12) out.errors.push(`Your largest slice (${s.maxSliceQty} ${m.base}, about ${money(maxSlice * px)}) is over ${maxWords(m, px)}. Lower it to ${qtyText(maxOrderQty(m, px))} ${m.base} or less.`);
      const most = Math.floor(s.durationMs / ALGO_LIMITS.twap.minIntervalMs);
      const sizes = (k: number) => {
        const { weights } = twapSchedule({ ...s, slices: k }, start, ctx.seed);
        const raw = allocateSteps(total, weights, step);
        // The trader's own smallest / largest slice: what is due waits for the smallest, the largest holds the rest back for the end (planAlgo's 'finish').
        if (!minSlice && !Number.isFinite(maxSlice)) return raw.map((qty) => ({ qty, price: px }));
        const kept = sliceBounds(raw, minSlice, maxSlice, step);
        const carry = raw.reduce((a, b) => a + b, 0) - kept.reduce((a, b) => a + b, 0);
        return [...kept, ...(carry > step * 1.5 ? [carry] : [])].map((qty) => ({ qty, price: px }));
      };
      if (s.maxSliceQty !== null && maxSlice < minChildQty(m, px) - 1e-12) out.errors.push(`Your largest slice (${s.maxSliceQty} ${m.base}, about ${money(maxSlice * px)}) is under ${minUsdWords}. Raise it to at least ${qtyText(minChildQty(m, px))} ${m.base}.`);
      else if (total < minChildQty(m, px) - 1e-12) out.errors.push(`The whole order is about ${money(total * px)}, under ${minUsdWords}. Raise the size to at least ${moneyUp(minChildQty(m, px) * px)}.`);
      else out.errors.push(...scheduleCheck({ unit: 'slice', count: s.slices, counts: { min: 1, max: Math.min(ALGO_LIMITS.twap.slices.max, most) }, sizes, total, m }));
      scheduleNotes(s, out);
      break;
    }
    case 'vwap': {
      const total = Number(s.quantity);
      if (!px || !total) break;
      const most = Math.floor(s.durationMs / ALGO_LIMITS.vwap.minIntervalMs);
      const sizes = (k: number) => {
        const { weights } = vwapSchedule({ ...s, slices: k }, start, ctx.seed, k === s.slices ? (ctx.profile ?? null) : null);
        return allocateSteps(total, weights, step).map((qty) => ({ qty, price: px }));
      };
      if (total < minChildQty(m, px) - 1e-12) out.errors.push(`The whole order is about ${money(total * px)}, under ${minUsdWords}. Raise the size to at least ${moneyUp(minChildQty(m, px) * px)}.`);
      else out.errors.push(...scheduleCheck({ unit: 'slice', count: s.slices, counts: { min: ALGO_LIMITS.vwap.slices.min, max: Math.min(ALGO_LIMITS.vwap.slices.max, most) }, sizes, total, m }));
      scheduleNotes(s, out);
      break;
    }
    case 'swarm': {
      const total = Number(s.quantity);
      if (!px || !total) break;
      const sizes = (k: number) => swarmClips({ ...s, clips: k }, m, ctx.seed).map((qty) => ({ qty, price: px }));
      if (total < minChildQty(m, px) - 1e-12) out.errors.push(`The whole order is about ${money(total * px)}, under ${minUsdWords}. Raise the size to at least ${moneyUp(minChildQty(m, px) * px)}.`);
      else out.errors.push(...scheduleCheck({ unit: 'clip', count: s.clips, counts: ALGO_LIMITS.swarm.clips, sizes, total, m }));
      break;
    }
    case 'pov': {
      const total = Number(s.quantity);
      if (!px || !total) break;
      const minQ = minChildQty(m, px);
      const maxQ = maxOrderQty(m, px);
      if (total < minQ - 1e-12) out.errors.push(`The whole order is about ${money(total * px)}, under ${minUsdWords}. Raise the size to at least ${moneyUp(minQ * px)}.`);
      const cap = s.maxChildQty !== null ? Number(s.maxChildQty) : null;
      if (cap !== null && cap < minQ - 1e-12) out.errors.push(`Your largest child (${s.maxChildQty} ${m.base}, about ${money(cap * px)}) is under ${minUsdWords}. Raise it to at least ${qtyText(minQ)} ${m.base}.`);
      if (cap !== null && cap > maxQ + 1e-12) out.errors.push(`Your largest child (${s.maxChildQty} ${m.base}, about ${money(cap * px)}) is over ${maxWords(m, px)}. Lower it to ${qtyText(maxQ)} ${m.base} or less.`);
      const largest = cap !== null ? `your largest child (${s.maxChildQty} ${m.base})` : Number.isFinite(maxQ) ? maxWords(m, px) : null;
      out.notes.push(`POV sizes each order from the market's volume as it runs: what is due waits until it reaches ${minUsdWords}${largest ? `, and no order is over ${largest}` : ''}.`);
      break;
    }
    case 'iceberg': {
      const total = Number(s.quantity);
      const price = s.price ?? px;
      if (!price || !total) break;
      const minQ = minChildQty(m, price);
      const maxQ = maxOrderQty(m, price);
      const show = Number(s.displayQty);
      const j = s.displayJitter;
      const lo = floorStep(show * (1 - j), m);
      const hi = floorStep(show * (1 + j), m);
      const moves = j > 0 ? ` (with clips changing up to ${Math.round(j * 100)}% either way)` : '';
      if (total < minQ - 1e-12) out.errors.push(`The whole order is about ${money(total * price)}, under ${minWords(m, price)}. Raise the size to at least ${moneyUp(minQ * price)}.`);
      else if (lo < minQ - 1e-12 && show < total) out.errors.push(`The smallest visible clip${moves} would be about ${money(lo * price)}, under ${minWords(m, price)}. Show at least ${qtyText(Math.ceil(minQ / (1 - j) / step - 1e-9) * step)} ${m.base}${j > 0 ? ', or let the clips change less' : ''}.`);
      if (Math.min(hi, total) > maxQ + 1e-12) out.errors.push(`The largest visible clip${moves} would be about ${money(Math.min(hi, total) * price)}, over ${maxWords(m, price)}. Show at most ${qtyText(floorStep(maxQ / (1 + j), m))} ${m.base}${j > 0 ? ', or let the clips change less' : ''}.`);
      if (show < total) out.notes.push(`When what is left after a clip is under ${minWords(m, price)}, it goes out with that clip.`);
      break;
    }
    case 'chase':
    case 'sweep': {
      if (px) out.errors.push(...oneOrder(Number(s.quantity), px, m));
      break;
    }
    case 'bracket': {
      const price = s.entry === 'limit' ? s.price : px;
      if (price) out.errors.push(...oneOrder(Number(s.quantity), price, m, 'The entry'));
      break;
    }
    case 'trailing': {
      if (s.quantity !== null && px) out.errors.push(...oneOrder(Number(s.quantity), px, m));
      else if (s.quantity === null && px) closeNote(ctx.positionSize ?? null, 1, m, px, out);
      break;
    }
    case 'conditional': {
      const t = s.then;
      if (t.type === 'market' && px) out.errors.push(...oneOrder(Number(t.quantity), px, m));
      else if (t.type === 'limit') out.errors.push(...oneOrder(Number(t.quantity), t.price, m));
      else if (t.type === 'close' && px) closeNote(ctx.positionSize ?? null, t.share, m, px, out);
      else if (t.type === 'algo') {
        const sym = t.algo.symbol;
        const am = sym === m.name ? m : ctx.market?.(sym) ?? null;
        const ap = sym === m.name ? px : (ctx.prices?.(sym) ?? null);
        if (am) {
          const inner = checkSizes(t.algo, am, { ...ctx, price: ap, positionSize: sym === m.name ? ctx.positionSize : null });
          out.errors.push(...inner.errors.map((e) => `When it fires: ${e}`));
          out.notes.push(...inner.notes);
        }
      }
      break;
    }
    case 'scale': {
      const ladder = scaleLadder(s, m, ctx.seed);
      const total = Number(s.quantity);
      // Two prices on one tick would be one order: the ladder would not be what was signed.
      if (s.prices?.length) {
        const seen = new Map<number, number>();
        for (const [i, p] of s.prices.entries()) {
          const x = snapNearest(p, m.tickSize);
          const first = seen.get(x);
          if (first !== undefined) {
            out.errors.push(`Orders ${first + 1} and ${i + 1} both land on ${x} (SoDEX's price step on ${m.name} is ${m.tickSize}). Move them apart, or use fewer orders.`);
            break;
          }
          seen.set(x, i);
        }
      } else if (ladder.length < s.orders) {
        out.errors.push(`Only ${ladder.length} different prices fit between ${s.from} and ${s.to} at SoDEX's price step of ${m.tickSize}. Use at most ${ladder.length} orders, or a wider range.`);
      }
      if (out.errors.length || !total) break;
      const sizes = (k: number) => (k === s.orders ? ladder : s.prices?.length ? [] : scaleLadder({ ...s, orders: k }, m, ctx.seed)).map((l) => ({ qty: l.qty, price: l.price }));
      // A range too narrow for more orders: those counts are not offered.
      const counts = { min: ALGO_LIMITS.scale.orders.min, max: s.prices?.length ? s.orders : Math.min(ALGO_LIMITS.scale.orders.max, maxLevels(s, m)) };
      out.errors.push(...scheduleCheck({ unit: 'order', count: s.orders, counts, sizes, total, m, fixedCount: !!s.prices?.length }));
      break;
    }
    case 'dca': {
      const per = s.perOrderUsd;
      const minQty = Number(m.minQuantity) || 0;
      const minUsd = Math.max(m.minNotional, px ? minQty * px : 0);
      if (per < minUsd - 1e-9) out.errors.push(`Each order would be ${money(per)}, under ${px ? minWords(m, px) : `SoDEX's ${money(m.minNotional)} minimum`}. Raise it to at least ${moneyUp(minUsd)}.`);
      const boost = s.dipPct !== null ? s.dipMultiplier : 1;
      // In USD, as it is sized: SoDEX's largest order value, or its largest quantity at the price.
      const maxUsd = Math.min(m.maxNotional ?? Infinity, px && Number(m.maxQuantity) > 0 ? Number(m.maxQuantity) * px : Infinity);
      const words = px ? maxWords(m, px) : `SoDEX's ${money(m.maxNotional ?? Infinity)} per order on ${m.name}`;
      if (per > maxUsd + 1e-6) out.errors.push(`Each order would be ${money(per)}, over ${words}. Use at most ${moneyDown(maxUsd)} per order.`);
      else if (per * boost > maxUsd + 1e-6) out.errors.push(`With the dip boost (${boost}x), an order would be ${money(per * boost)}, over ${words}. Use at most ${moneyDown(maxUsd / boost)} per order, or a smaller boost.`);
      if (s.maxTotalUsd !== null && s.maxTotalUsd < per * s.orders * boost - 1e-6) {
        if (s.dipPct === null) {
          const full = Math.floor(s.maxTotalUsd / per + 1e-9);
          const rest = s.maxTotalUsd - full * per;
          if (rest > 1e-6 && rest < minUsd - 1e-9) out.errors.push(`Your budget of ${money(s.maxTotalUsd)} leaves a last order of ${money(rest)}, under SoDEX's ${money(m.minNotional)} minimum. Use a budget of ${money(full * per)} or ${money((full + 1) * per)}.`);
        } else out.notes.push(`With the dip boost, the last order is what is left of your budget; if that is under SoDEX's ${money(m.minNotional)} minimum, it is not sent.`);
      }
      break;
    }
    case 'basket': {
      const each = s.style === 'swarm' ? Math.max(1, s.clips) : Math.max(1, s.slices);
      const unit = s.style === 'swarm' ? 'clip' : 'slice';
      s.legs.forEach((l, i) => {
        const lm = l.symbol === m.name ? m : ctx.market?.(l.symbol) ?? null;
        const lp = l.symbol === m.name ? px : (ctx.prices?.(l.symbol) ?? null);
        if (lm && lp) {
          // Each market's own algo, as the runtime starts it (stepBasket): its size at the mark, its jitter, its seed.
          const qty = floorStep(l.usd / lp, lm);
          const seed = (ctx.seed + i + 1) >>> 0;
          if (qty < minChildQty(lm, lp) - 1e-12) {
            out.errors.push(`${l.symbol}: ${money(l.usd)} is under ${minWords(lm, lp)}. Raise it to at least ${moneyUp(minChildQty(lm, lp) * lp)}.`);
            return;
          }
          const sizes = s.style === 'swarm'
            ? (k: number) => swarmClips({ quantity: qtyText(qty), clips: k, sizeJitter: 0.2 }, lm, seed).map((q) => ({ qty: q, price: lp }))
            : (k: number) => allocateSteps(qty, twapSchedule({ slices: k, urgency: 0, sizeJitter: 0.15, timeJitter: 0.2, durationMs: s.durationMs }, start, seed).weights, Number(lm.stepSize)).map((q) => ({ qty: q, price: lp }));
          const counts = s.style === 'swarm' ? ALGO_LIMITS.swarm.clips : { min: 1, max: Math.min(ALGO_LIMITS.twap.slices.max, Math.floor(s.durationMs / ALGO_LIMITS.twap.minIntervalMs)) };
          out.errors.push(...scheduleCheck({ unit, count: each, counts, sizes, total: qty, m: lm }).map((e) => `${l.symbol}: ${e}`));
          return;
        }
        // No price for this market here: by its USD alone (the executor checks it in full when it starts).
        const lmm = lm ?? m;
        // The runtime's jitter on each market's slices (0.15) or clips (0.2): the smallest is that much under the average.
        const j = s.style === 'swarm' ? 0.2 : 0.15;
        const one = l.usd / each;
        if (one * (1 - j) < lmm.minNotional - 1e-9) {
          const most = Math.max(1, Math.floor((l.usd * (1 - j)) / lmm.minNotional));
          out.errors.push(`${l.symbol}: each ${unit} would be about ${money(one)}, and the smallest under SoDEX's ${money(lmm.minNotional)} minimum. Use at most ${most} ${plural(most, unit)}, or raise it to ${moneyUp((lmm.minNotional * each) / (1 - j))}.`);
        } else if (lmm.maxNotional && one * (1 + j) > lmm.maxNotional + 1e-6) {
          out.errors.push(`${l.symbol}: each ${unit} would be about ${money(one)}, and the largest over SoDEX's ${money(lmm.maxNotional)} per order on ${l.symbol}. Use at least ${Math.ceil((l.usd * (1 + j)) / lmm.maxNotional)} ${unit}s.`);
        }
      });
      break;
    }
  }
  return out;
}

/** How many distinct prices a scale's range holds at the tick (at most the spec's limit). */
function maxLevels(s: Extract<AlgoSpec, { kind: 'scale' }>, m: MarketInfo): number {
  const n = Math.min(ALGO_LIMITS.scale.orders.max, Math.floor(Math.abs(s.to - s.from) / Number(m.tickSize)) + 1);
  return ladderPrices(s.from, s.to, n, s.spacing, m.tickSize).length;
}

/** TWAP and VWAP: what the runtime decides as it runs, said up front. */
function scheduleNotes(s: Extract<AlgoSpec, { kind: 'twap' | 'vwap' }>, out: SizeCheck): void {
  if (s.exec.style !== 'taker') out.notes.push('A slice that has not filled when the next one is due rests together with it as one order.');
  if (s.maxParticipation !== null) out.notes.push(`With max participation, what the market's volume does not allow yet waits and goes out with a later slice.`);
}

/** A close of the whole (or a share of the) position: over SoDEX's largest order, it closes in several orders. */
function closeNote(pos: number | null, share: number, m: MarketInfo, px: number, out: SizeCheck): void {
  if (!pos) return;
  const take = floorStep(Math.abs(pos) * share, m);
  const maxQ = maxOrderQty(m, px);
  if (take > maxQ + 1e-12) out.notes.push(`Closing about ${money(take * px)} is over ${maxWords(m, px)}: it closes in ${Math.ceil(take / maxQ - 1e-9)} orders, one after the other.`);
}
