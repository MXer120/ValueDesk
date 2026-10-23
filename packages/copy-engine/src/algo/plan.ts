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

/** The plan of `s` on `m`. Pure. */
export function planAlgo(s: AlgoSpec, m: MarketInfo, ctx: AlgoPlanContext): AlgoPlan {
  const start = Math.max(ctx.now, s.startAt ?? ctx.now);
  const px = ctx.price;
  const total = algoQuantity(s);
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
      const sizes = allocateSteps(total!, weights, step);
      out.children = times.map((at, i) => ({ at, qty: sizes[i] ?? 0, price: null, tag: `slice ${i + 1}/${times.length}` }));
      out.endsAt = start + s.durationMs;
      out.intervalMs = s.durationMs / s.slices;
      summarise();
      checkSchedule('slice');
      limitWarn();
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
  }
  return out;
}
