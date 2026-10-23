/**
 * What an algo will do, before it does it: its children over time (or its
 * ladder), what each one is worth, and every reason SoDEX would refuse part
 * of it. The order ticket draws this; the runtime derives its schedule from
 * the same functions with the same seed.
 */
import type { MarketInfo } from '../types.ts';
import {
  allocateSteps,
  curveWeights,
  ladderPrices,
  ladderWeights,
  makeRng,
  minChildQty,
  normalise,
  sliceTimes,
  type VolumeProfile,
} from './math.ts';
import { ALGO_NAMES, algoQuantity } from './spec.ts';
import type { AlgoSpec, SwarmSpec, TwapSpec, VwapSpec } from './types.ts';

export interface PlannedChild {
  /** When it is due (null: at once / when triggered). */
  at: number | null;
  qty: number;
  /** Its price, for a ladder (null: priced at the touch when it is sent). */
  price: number | null;
  tag: string;
}

export interface AlgoPlan {
  title: string;
  total: number | null;
  /** USD at the reference price. */
  notional: number | null;
  children: PlannedChild[];
  startsAt: number;
  endsAt: number | null;
  intervalMs: number | null;
  avgChildQty: number | null;
  minChildUsd: number | null;
  maxChildUsd: number | null;
  /** Ladder: the size-weighted average price if every level fills. */
  avgPrice: number | null;
  /** Where its exits would sit (against the expected average fill). */
  exits: { tp: number | null; sl: number | null } | null;
  warnings: string[];
  errors: string[];
}

export interface AlgoPlanContext {
  now: number;
  /** The reference price (mid, else mark). null when there is none yet. */
  price: number | null;
  seed: number;
  /** VWAP's volume profile, once read. */
  profile?: VolumeProfile | null;
  /** Base units traded on the market in the last hour (POV's pace estimate). */
  hourVolume?: number | null;
  /** The trader's signed position on the market now (a time-sliced close is sized from it). */
  positionSize?: number | null;
  /** Prices of other markets (a basket's legs), where known. */
  prices?: (symbol: string) => number | null;
}

/** Where an entry's exits would sit for an average fill of `avg` (prices win over distances). */
export function exitLevels(side: 'buy' | 'sell', x: { tpPrice: number | null; slPrice: number | null; tpPct: number | null; slPct: number | null }, avg: number): { tp: number | null; sl: number | null } {
  const sign = side === 'buy' ? 1 : -1;
  return {
    tp: x.tpPrice ?? (x.tpPct !== null ? avg * (1 + sign * x.tpPct) : null),
    sl: x.slPrice ?? (x.slPct !== null ? avg * (1 - sign * x.slPct) : null),
  };
}

/** TWAP: the slices' times and weights. Weights first, then times, from one generator. */
export function twapSchedule(s: Pick<TwapSpec, 'slices' | 'urgency' | 'sizeJitter' | 'timeJitter' | 'durationMs'>, start: number, seed: number): { times: number[]; weights: number[] } {
  const rand = makeRng(seed);
  const weights = curveWeights(s.slices, s.urgency, s.sizeJitter, rand);
  const times = sliceTimes(start, s.durationMs, s.slices, s.timeJitter, rand);
  return { times, weights };
}

/** VWAP: the profile's weights, jittered; slices evenly spaced. Flat until a profile is known. */
export function vwapSchedule(s: Pick<VwapSpec, 'slices' | 'sizeJitter' | 'durationMs'>, start: number, seed: number, profile: VolumeProfile | null): { times: number[]; weights: number[] } {
  const rand = makeRng(seed);
  const base = profile && profile.weights.length === s.slices ? profile.weights : new Array<number>(s.slices).fill(1 / s.slices);
  const weights = normalise(base.map((w) => (s.sizeJitter > 0 ? w * (1 + (rand() * 2 - 1) * s.sizeJitter) : w)));
  const times = sliceTimes(start, s.durationMs, s.slices, 0, rand);
  return { times, weights };
}

/** Swarm: each clip's size, in whole steps. */
export function swarmClips(s: Pick<SwarmSpec, 'quantity' | 'clips' | 'sizeJitter'>, m: Pick<MarketInfo, 'stepSize'>, seed: number): number[] {
  const rand = makeRng(seed);
  const w = new Array<number>(s.clips).fill(1).map((x) => (s.sizeJitter > 0 ? x * (1 + (rand() * 2 - 1) * s.sizeJitter) : x));
  return allocateSteps(Number(s.quantity), w, Number(m.stepSize)).filter((q) => q > 0);
}

/** A ladder's levels, first to last: price and size (whole steps). */
export function scaleLadder(s: Extract<AlgoSpec, { kind: 'scale' }>, m: Pick<MarketInfo, 'tickSize' | 'stepSize'>, seed: number): Array<{ price: number; qty: number }> {
  const prices = ladderPrices(s.from, s.to, s.orders, s.spacing, m.tickSize);
  const w = ladderWeights(prices.length, s.distribution, s.skew, s.sizeJitter, makeRng(seed));
  const sizes = allocateSteps(Number(s.quantity), w, Number(m.stepSize));
  return prices.map((price, i) => ({ price, qty: sizes[i] ?? 0 }));
}

const usd = (n: number): string => (n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);

/**
 * Slices as they go out under a smallest and a largest slice: what is due
 * waits until it reaches the smallest, and no child is above the largest (the
 * excess stays due and goes with a later slice, or at the end). Whole steps.
 */
export function sliceBounds(sizes: readonly number[], min: number, max: number, step: number): number[] {
  const out: number[] = [];
  let due = 0;
  for (const q of sizes) {
    due += q;
    let send = due >= min - 1e-12 ? Math.min(due, max) : 0;
    send = Math.floor(send / step + 1e-9) * step;
    out.push(send);
    due -= send;
  }
  return out;
}

/** The plan of `s` on `m`. Pure. */
export function planAlgo(s: AlgoSpec, m: MarketInfo, ctx: AlgoPlanContext): AlgoPlan {
  const start = Math.max(ctx.now, s.startAt ?? ctx.now);
  const px = ctx.price;
  const pos = ctx.positionSize ?? null;
  // A time-sliced close is sized from the position (floored to the step); everything else from its spec.
  const total = s.kind === 'twap' && s.closeShare !== null ? (pos ? Math.floor((Math.abs(pos) * s.closeShare) / Number(m.stepSize) + 1e-9) * Number(m.stepSize) : null) : algoQuantity(s);
  const out: AlgoPlan = {
    title: ALGO_NAMES[s.kind],
    total,
    notional: total !== null && px ? total * px : null,
    children: [],
    startsAt: start,
    endsAt: null,
    intervalMs: null,
    avgChildQty: null,
    minChildUsd: null,
    maxChildUsd: null,
    avgPrice: null,
    exits: null,
    warnings: [],
    errors: [],
  };
  const minQty = (p: number) => minChildQty(m, p);
  const step = Number(m.stepSize);
  const summarise = () => {
    const qs = out.children.map((c) => c.qty).filter((q) => q > 0);
    if (!qs.length) return;
    out.avgChildQty = qs.reduce((a, b) => a + b, 0) / qs.length;
    const prices = out.children.map((c) => c.price ?? px ?? 0);
    const vals = out.children.map((c, i) => c.qty * (prices[i] ?? 0)).filter((v) => v > 0);
    if (vals.length) {
      out.minChildUsd = Math.min(...vals);
      out.maxChildUsd = Math.max(...vals);
    }
  };
  const checkSchedule = (unit: string) => {
    if (!px || out.avgChildQty === null) return;
    const avgUsd = out.avgChildQty * px;
    if (out.avgChildQty < step) out.errors.push(`Each ${unit} would be smaller than one step of ${m.stepSize} ${m.base}. Use fewer ${unit}s or a larger size.`);
    else if (avgUsd < m.minNotional) {
      const most = total ? Math.max(1, Math.floor((total * px) / m.minNotional)) : 1;
      out.errors.push(`Each ${unit} is about ${usd(avgUsd)}, under SoDEX's minimum of ${usd(m.minNotional)} per order: use at most ${most} ${unit}s, or a larger size.`);
    } else if (out.minChildUsd !== null && out.minChildUsd < m.minNotional) out.warnings.push(`Some ${unit}s fall under SoDEX's ${usd(m.minNotional)} minimum; they wait and go out together with the next one.`);
    if (m.maxNotional && out.maxChildUsd !== null && out.maxChildUsd > m.maxNotional) out.errors.push(`The largest ${unit} is ${usd(out.maxChildUsd)}, over SoDEX's ${usd(m.maxNotional)} per order. Use more ${unit}s.`);
  };
  const limitWarn = () => {
    if (!px || s.limitPrice === null) return;
    const away = s.side === 'buy' ? (px - s.limitPrice) / px : (s.limitPrice - px) / px;
    if (away > 0.001) out.warnings.push(`Your limit is ${(away * 100).toFixed(2)}% ${s.side === 'buy' ? 'under' : 'over'} the price: nothing is taken until the price ${s.side === 'buy' ? 'comes down to' : 'rises to'} it.`);
  };

  switch (s.kind) {
    case 'twap': {
      const { times, weights } = twapSchedule(s, start, ctx.seed);
      if (s.closeShare !== null) {
        if (pos === null) out.warnings.push('Sized from your position when it starts.');
        else if (pos === 0) out.errors.push(`You hold no position on ${m.name} to close.`);
        else {
          const closing = pos > 0 ? 'sell' : 'buy';
          if (closing !== s.side) out.warnings.push(`It closes your ${pos > 0 ? 'long' : 'short'}: it ${closing === 'sell' ? 'sells' : 'buys'}, reduce-only, whatever side the ticket shows.`);
        }
      }
      const raw = total ? allocateSteps(total, weights, step) : weights.map(() => 0);
      const sizes = sliceBounds(raw, s.minSliceQty !== null ? Number(s.minSliceQty) : 0, s.maxSliceQty !== null ? Number(s.maxSliceQty) : Infinity, step);
      out.children = times.map((at, i) => ({ at, qty: sizes[i] ?? 0, price: null, tag: `slice ${i + 1}/${times.length}` }));
      const carry = raw.reduce((a, b) => a + b, 0) - sizes.reduce((a, b) => a + b, 0);
      if (carry > step / 2) {
        out.children.push({ at: start + s.durationMs, qty: carry, price: null, tag: 'finish' });
        if (s.maxSliceQty !== null) out.warnings.push(`The largest slice (${s.maxSliceQty} ${m.base}) holds back ${carry.toPrecision(4).replace(/\.?0+$/, '')} ${m.base} for the end${s.finish === 'leave' ? ', where it is left' : ''}.`);
      }
      out.endsAt = start + s.durationMs;
      out.intervalMs = s.durationMs / s.slices;
      summarise();
      checkSchedule('slice');
      limitWarn();
      if (s.minSliceQty !== null && total && out.children.filter((c) => c.qty > 0).length < times.length) out.warnings.push(`Slices under ${s.minSliceQty} ${m.base} wait and go out together.`);
      if (s.exec.style !== 'taker' && s.finish === 'leave') out.warnings.push('Resting slices that have not filled when the time is up are left unfilled.');
      break;
    }
    case 'vwap': {
      const { times, weights } = vwapSchedule(s, start, ctx.seed, ctx.profile ?? null);
      const sizes = allocateSteps(total!, weights, step);
      out.children = times.map((at, i) => ({ at, qty: sizes[i] ?? 0, price: null, tag: `slice ${i + 1}/${times.length}` }));
      out.endsAt = start + s.durationMs;
      out.intervalMs = s.durationMs / s.slices;
      summarise();
      checkSchedule('slice');
      limitWarn();
      if (!ctx.profile) out.warnings.push('The volume profile is read when it starts; until then the preview is even.');
      else if (ctx.profile.days < Math.min(7, s.lookbackDays)) out.warnings.push(`Only ${ctx.profile.days} day${ctx.profile.days === 1 ? '' : 's'} of history: the profile is rough.`);
      break;
    }
    case 'pov': {
      if (ctx.hourVolume && ctx.hourVolume > 0 && total) {
        const perHour = ctx.hourVolume * s.rate;
        const hours = total / perHour;
        out.endsAt = start + Math.round(hours * 3_600_000);
        if (s.endAt !== null && out.endsAt > s.endAt) out.warnings.push(`At the last hour's pace it fills about ${Math.round((((s.endAt - start) / 3_600_000) * perHour * 100) / total)}% by the end time.`);
      }
      if (s.endAt !== null) out.endsAt = out.endsAt === null ? s.endAt : Math.min(out.endsAt, s.endAt);
      if (s.maxChildQty !== null && px && Number(s.maxChildQty) * px < m.minNotional) out.errors.push(`The largest child is under SoDEX's ${usd(m.minNotional)} minimum.`);
      limitWarn();
      break;
    }
    case 'iceberg': {
      const clip = Number(s.displayQty);
      const n = total && clip > 0 ? Math.ceil(total / clip - 1e-9) : 0;
      out.children = Array.from({ length: Math.min(n, 400) }, (_, i) => ({ at: null, qty: Math.min(clip, total! - i * clip), price: s.price, tag: `clip ${i + 1}` }));
      summarise();
      if (px && clip * px < m.minNotional) out.errors.push(`Each visible clip is about ${usd(clip * px)}, under SoDEX's ${usd(m.minNotional)} minimum.`);
      if (total && clip / total > 0.25) out.warnings.push('The visible size is over a quarter of the order: it hides little.');
      if (px && s.price !== null && Math.abs(s.price - px) / px > 0.05) out.warnings.push(`The price is ${((Math.abs(s.price - px) / px) * 100).toFixed(1)}% from the market.`);
      if (s.price !== null && !s.postOnly && px && (s.side === 'buy' ? s.price >= px : s.price <= px)) out.warnings.push('At this price the clips take at once (not post-only).');
      break;
    }
    case 'chase': {
      out.children = [{ at: null, qty: total!, price: null, tag: 'chase' }];
      if (s.timeoutMs) out.endsAt = start + s.timeoutMs;
      summarise();
      if (px && total! * px < m.minNotional) out.errors.push(`The order is about ${usd(total! * px)}, under SoDEX's ${usd(m.minNotional)} minimum.`);
      break;
    }
    case 'scale': {
      const ladder = scaleLadder(s, m, ctx.seed);
      out.children = ladder.map((l, i) => ({ at: null, qty: l.qty, price: l.price, tag: `level ${i + 1}/${ladder.length}` }));
      const filledValue = ladder.reduce((a, l) => a + l.qty * l.price, 0);
      const q = ladder.reduce((a, l) => a + l.qty, 0);
      out.avgPrice = q > 0 ? filledValue / q : null;
      out.notional = filledValue || out.notional;
      summarise();
      if (ladder.length < s.orders) out.warnings.push(`The tick of ${m.tickSize} fits only ${ladder.length} distinct prices in this range.`);
      const small = ladder.filter((l) => l.qty < minQty(l.price));
      if (small.length) out.errors.push(`${small.length} level${small.length === 1 ? '' : 's'} would be under SoDEX's ${usd(m.minNotional)} minimum. Use fewer orders, a larger size, or less skew.`);
      if (px) {
        const crossing = ladder.filter((l) => (s.side === 'buy' ? l.price >= px : l.price <= px)).length;
        if (crossing) out.warnings.push(s.postOnly ? `${crossing} level${crossing === 1 ? '' : 's'} at or through the market would be refused as post-only.` : `${crossing} level${crossing === 1 ? '' : 's'} at or through the market fill at once.`);
      }
      break;
    }
    case 'dca': {
      for (let i = 0; i < s.orders && i < 400; i++) out.children.push({ at: start + i * s.intervalMs, qty: px ? s.perOrderUsd / px : 0, price: null, tag: `order ${i + 1}/${s.orders}` });
      out.endsAt = start + (s.orders - 1) * s.intervalMs;
      out.intervalMs = s.intervalMs;
      out.notional = s.maxTotalUsd ?? s.perOrderUsd * s.orders;
      summarise();
      if (s.perOrderUsd < m.minNotional) out.errors.push(`Each order must be at least SoDEX's ${usd(m.minNotional)} minimum.`);
      limitWarn();
      if (s.dipPct !== null && s.dipMultiplier > 1 && s.maxTotalUsd === null) out.warnings.push(`Dip boosts can spend up to ${usd(s.perOrderUsd * s.orders * s.dipMultiplier)} in all: set a total budget to cap it.`);
      break;
    }
    case 'swarm': {
      const clips = swarmClips(s, m, ctx.seed);
      out.children = clips.map((qty, i) => ({ at: start + Math.floor(i / s.inFlight) * s.waveMs, qty, price: null, tag: `clip ${i + 1}/${clips.length}` }));
      out.endsAt = start + Math.max(0, Math.ceil(clips.length / s.inFlight) - 1) * s.waveMs;
      out.intervalMs = s.waveMs;
      summarise();
      checkSchedule('clip');
      limitWarn();
      break;
    }
    case 'conditional': {
      if (s.expiresAt !== null) out.endsAt = s.expiresAt;
      if (s.then.type === 'algo') out.warnings.push(`When it fires it starts a ${ALGO_NAMES[s.then.algo.kind]} on ${s.then.algo.symbol}.`);
      if (s.then.type === 'market' && px && Number(s.then.quantity) * px < m.minNotional) out.errors.push(`The order is under SoDEX's ${usd(m.minNotional)} minimum.`);
      break;
    }
    case 'trailing': {
      if (s.quantity === null) out.warnings.push('It closes the whole position on this market when it fires.');
      else if (px && Number(s.quantity) * px < m.minNotional) out.errors.push(`The order is under SoDEX's ${usd(m.minNotional)} minimum.`);
      break;
    }
    case 'basket': {
      const each = s.style === 'swarm' ? Math.max(1, s.clips) : Math.max(1, s.slices);
      out.children = s.legs.map((l) => {
        const p = ctx.prices?.(l.symbol) ?? (l.symbol === m.name ? px : null);
        return { at: start, qty: p ? l.usd / p : 0, price: p, tag: `${l.side === 'buy' ? 'buy' : 'sell'} ${l.symbol}` };
      });
      out.notional = s.legs.reduce((a, l) => a + l.usd, 0);
      if (s.style === 'twap') {
        out.endsAt = start + s.durationMs;
        out.intervalMs = s.durationMs / s.slices;
      } else {
        out.endsAt = start + Math.max(0, Math.ceil(s.clips / Math.max(1, s.inFlight)) - 1) * s.waveMs;
        out.intervalMs = s.waveMs;
      }
      const small = s.legs.filter((l) => l.usd / each < m.minNotional);
      if (small.length) out.errors.push(`${small.map((l) => l.symbol).join(', ')}: each ${s.style === 'swarm' ? 'clip' : 'slice'} would be under SoDEX's ${usd(m.minNotional)} minimum. Use fewer ${s.style === 'swarm' ? 'clips' : 'slices'} or more per market.`);
      break;
    }
    case 'bracket': {
      const entryPx = s.entry === 'limit' ? s.price : px;
      out.children = [{ at: null, qty: total!, price: s.entry === 'limit' ? s.price : null, tag: 'entry' }];
      summarise();
      if (entryPx && total! * entryPx < m.minNotional) out.errors.push(`The entry is under SoDEX's ${usd(m.minNotional)} minimum.`);
      if (s.entry === 'limit' && px && s.price !== null && (s.side === 'buy' ? s.price >= px : s.price <= px)) out.warnings.push('The entry price is at or through the market: it fills at once.');
      break;
    }
  }
  // Exits: where they sit against the average fill this plan expects, and never on the wrong side of the price now.
  if (s.exits && px) {
    const ref = out.avgPrice ?? (s.kind === 'bracket' && s.entry === 'limit' && s.price ? s.price : px);
    const lv = exitLevels(s.side, s.exits, ref);
    out.exits = lv;
    const long = s.side === 'buy';
    if (s.exits.tpPrice !== null && (long ? s.exits.tpPrice <= px : s.exits.tpPrice >= px)) out.errors.push(`The take-profit ${s.exits.tpPrice} is on the wrong side of the price now: it would fire at once.`);
    if (s.exits.slPrice !== null && (long ? s.exits.slPrice >= px : s.exits.slPrice <= px)) out.errors.push(`The stop-loss ${s.exits.slPrice} is on the wrong side of the price now: it would fire at once.`);
  }
  return out;
}
