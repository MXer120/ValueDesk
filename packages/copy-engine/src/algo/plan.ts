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
  normalise,
  povDue,
  sliceTimes,
  snapNearest,
  type VolumeProfile,
} from './math.ts';
import { checkLimits, limitLeverage, type LimitCheck } from './limits.ts';
import { checkSizes } from './sizes.ts';
import { ALGO_NAMES, algoQuantity, opensPosition } from './spec.ts';
import { sweepBand } from './sweep.ts';
import type { AlgoSpec, SwarmSpec, TwapSpec, VwapSpec } from './types.ts';

export interface PlannedChild {
  /** When it is due (null: at once / when triggered). */
  at: number | null;
  qty: number;
  /** Its price, for a ladder (null: priced at the touch when it is sent). */
  price: number | null;
  tag: string;
  /** Its value in USD where that is fixed rather than size x price (a basket leg's share). */
  usd?: number;
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
  /**
   * The child orders over time where `children` is something else: a
   * basket's slices or clips per market (children: one per market), POV's
   * pace (children: none, it follows the volume). For drawing.
   */
  schedule?: PlannedChild[] | null;
  /** The schedule is an estimate (POV at the last hour's volume), not what is fixed to go out. */
  estimated?: boolean;
  /** SoDEX's open-interest cap: the order would reach it, or take most of what is left (the ticket colours it). */
  oi?: LimitCheck['oi'];
  warnings: string[];
  errors: string[];
  /**
   * Child sizes the algo decides as it runs (POV's pace, a schedule catching
   * up, an iceberg's last clip), said before the start: information, not a
   * warning (sizes.ts). Nothing is ever merged or split up front.
   */
  notes?: string[];
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
  /** The market's open interest now, in the coin (SoDEX's `openInterest`), for its cap. */
  oi?: number | null;
  /** Other markets' rules (a basket's legs, a conditional's algo), where known. */
  market?: (symbol: string) => MarketInfo | null | undefined;
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
  // Explicit levels (a DCA ladder): each on the tick, a level the tick merges into the one before dropped with its size.
  if (s.prices?.length) {
    const prices: number[] = [];
    const ws: number[] = [];
    s.prices.forEach((p, i) => {
      const x = snapNearest(p, m.tickSize);
      if (prices.includes(x)) return;
      prices.push(x);
      ws.push(s.weights?.[i] ?? 1);
    });
    const w = s.weights?.length === s.prices.length ? normalise(ws) : ladderWeights(prices.length, s.distribution, s.skew, s.sizeJitter, makeRng(seed));
    const sizes = allocateSteps(Number(s.quantity), w, Number(m.stepSize));
    return prices.map((price, i) => ({ price, qty: sizes[i] ?? 0 }));
  }
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
      limitWarn();
      if (!ctx.profile) out.warnings.push('The volume profile is read when it starts; until then the preview is even.');
      else if (ctx.profile.days < Math.min(7, s.lookbackDays)) out.warnings.push(`Only ${ctx.profile.days} day${ctx.profile.days === 1 ? '' : 's'} of history: the profile is rough.`);
      break;
    }
    case 'pov': {
      if (ctx.hourVolume && ctx.hourVolume > 0 && total) {
        // Its share of the total: at the last hour's volume of everyone else, it trades others x rate / (1 - rate) an hour.
        const perHour = povDue(s.rate, ctx.hourVolume);
        const hours = total / perHour;
        out.endsAt = start + Math.round(hours * 3_600_000);
        if (s.endAt !== null && out.endsAt > s.endAt) out.warnings.push(`At the last hour's pace it fills about ${Math.round((((s.endAt - start) / 3_600_000) * perHour * 100) / total)}% by the end time.`);
      }
      if (s.endAt !== null) out.endsAt = out.endsAt === null ? s.endAt : Math.min(out.endsAt, s.endAt);
      // The pace drawn: what it would take in each 5 minutes at the last hour's volume (at most 400 steps).
      if (ctx.hourVolume && ctx.hourVolume > 0 && total && out.endsAt !== null) {
        const span = Math.max(1, out.endsAt - start);
        const bucket = Math.max(300_000, Math.ceil(span / 400));
        const per = (povDue(s.rate, ctx.hourVolume) * bucket) / 3_600_000;
        const cap = s.maxChildQty !== null ? Number(s.maxChildQty) : Infinity;
        const sched: PlannedChild[] = [];
        let left = total;
        for (let t = start + bucket; left > 1e-12 && t <= out.endsAt + bucket - 1 && sched.length < 400; t += bucket) {
          const q = Math.min(left, per);
          sched.push({ at: Math.min(t, out.endsAt), qty: q, price: null, tag: `about ${q <= cap ? 'one' : Math.ceil(q / cap)} child${q <= cap ? '' : 'ren'}` });
          left -= q;
        }
        out.schedule = sched;
        out.estimated = true;
      }
      limitWarn();
      break;
    }
    case 'iceberg': {
      const clip = Number(s.displayQty);
      const n = total && clip > 0 ? Math.ceil(total / clip - 1e-9) : 0;
      out.children = Array.from({ length: Math.min(n, 400) }, (_, i) => ({ at: null, qty: Math.min(clip, total! - i * clip), price: s.price, tag: `clip ${i + 1}` }));
      summarise();
      if (total && clip / total > 0.25) out.warnings.push('The visible size is over a quarter of the order: it hides little.');
      if (px && s.price !== null && Math.abs(s.price - px) / px > 0.05) out.warnings.push(`The price is ${((Math.abs(s.price - px) / px) * 100).toFixed(1)}% from the market.`);
      if (s.price !== null && !s.postOnly && px && (s.side === 'buy' ? s.price >= px : s.price <= px)) out.warnings.push('At this price the clips take at once (not post-only).');
      break;
    }
    case 'chase': {
      out.children = [{ at: null, qty: total!, price: null, tag: 'chase' }];
      if (s.timeoutMs) out.endsAt = start + s.timeoutMs;
      summarise();
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
      limitWarn();
      break;
    }
    case 'conditional': {
      if (s.expiresAt !== null) out.endsAt = s.expiresAt;
      if (s.then.type === 'algo') out.warnings.push(`When it fires it starts a ${ALGO_NAMES[s.then.algo.kind]} on ${s.then.algo.symbol}.`);
      break;
    }
    case 'trailing': {
      if (s.quantity === null) out.warnings.push('It closes the whole position on this market when it fires.');
      break;
    }
    case 'basket': {
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
      // Each market's own algo, as the runtime starts it (stepBasket): a TWAP with its jitter, or a swarm in waves.
      const sched: PlannedChild[] = [];
      s.legs.forEach((l, i) => {
        const p = ctx.prices?.(l.symbol) ?? (l.symbol === m.name ? px : null);
        const q = p ? l.usd / p : 0;
        const seed = (ctx.seed + i + 1) >>> 0;
        if (s.style === 'twap') {
          const { times, weights } = twapSchedule({ slices: s.slices, urgency: 0, sizeJitter: 0.15, timeJitter: 0.2, durationMs: s.durationMs }, start, seed);
          times.forEach((at, k) => sched.push({ at, qty: q * (weights[k] ?? 0), price: null, usd: l.usd * (weights[k] ?? 0), tag: `${l.side} ${l.symbol} ${k + 1}/${times.length}` }));
        } else {
          const rand = makeRng(seed);
          const w = normalise(new Array<number>(s.clips).fill(1).map((x) => x * (1 + (rand() * 2 - 1) * 0.2)));
          w.forEach((x, k) => sched.push({ at: start + Math.floor(k / Math.max(1, s.inFlight)) * s.waveMs, qty: q * x, price: null, usd: l.usd * x, tag: `${l.side} ${l.symbol} ${k + 1}/${w.length}` }));
        }
      });
      out.schedule = sched.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      break;
    }
    case 'sweep': {
      // One IOC round for the whole amount at the band edge; later rounds for what is left, re-priced from the reference.
      const band = px ? sweepBand(s.side, px, s.slippageBps, m.tickSize) : null;
      out.children = [{ at: null, qty: total!, price: band, tag: 'round 1' }];
      if (s.timeoutMs) out.endsAt = start + s.timeoutMs;
      out.intervalMs = s.roundMs;
      summarise();
      break;
    }
    case 'bracket': {
      out.children = [{ at: null, qty: total!, price: s.entry === 'limit' ? s.price : null, tag: 'entry' }];
      summarise();
      if (s.entry === 'limit' && px && s.price !== null && (s.side === 'buy' ? s.price >= px : s.price <= px)) out.warnings.push('The entry price is at or through the market: it fills at once.');
      break;
    }
  }
  // Exits: where they sit against the average fill this plan expects, and never on the wrong side of THAT
  // fill - they are placed once the entry has filled, so the entry, not the price now, is what they guard
  // (a buy-limit bracket at 79,000 under a 80,000 market: a stop at 79,500 would fire on the fill, a
  // take-profit at 79,500 is fine - the check against the price now had both the wrong way round).
  if (s.exits && px) {
    const ref = out.avgPrice ?? (s.kind === 'bracket' && s.entry === 'limit' && s.price ? s.price : px);
    const lv = exitLevels(s.side, s.exits, ref);
    out.exits = lv;
    const long = s.side === 'buy';
    const at = ref === px ? 'the price now' : 'the expected entry';
    if (s.exits.tpPrice !== null && (long ? s.exits.tpPrice <= ref : s.exits.tpPrice >= ref)) out.errors.push(`The take-profit ${s.exits.tpPrice} is on the wrong side of ${at} (${ref}): it would fire at once.`);
    if (s.exits.slPrice !== null && (long ? s.exits.slPrice >= ref : s.exits.slPrice <= ref)) out.errors.push(`The stop-loss ${s.exits.slPrice} is on the wrong side of ${at} (${ref}): it would fire at once.`);
  }
  // Every child an order SoDEX takes: under its smallest or over its largest is an error with the fix (sizes.ts).
  const sizes = checkSizes(s, m, { price: px, seed: ctx.seed, now: ctx.now, positionSize: pos, profile: ctx.profile ?? null, market: ctx.market, prices: ctx.prices });
  out.errors.push(...sizes.errors);
  out.notes = sizes.notes;
  if (px) {
    // A resting price SoDEX refuses: a buy more than buyLimitUpRatio over the price, a sell more than sellLimitDownRatio under it.
    const off = bandRefused(s.side, out.children, m, px);
    if (off) out.errors.unshift(`${off} order${off === 1 ? ' is' : 's are'} priced more than ${Math.round((s.side === 'buy' ? m.buyLimitUpRatio : m.sellLimitDownRatio) * 100)}% ${s.side === 'buy' ? 'over' : 'under'} the price: SoDEX refuses a limit ${s.side} that far from the mark.`);
    // SoDEX's position limit at its leverage and the market's open-interest cap, for what it opens. First: they matter most.
    const qty = out.total ?? (out.notional !== null ? out.notional / px : null);
    if (opensPosition(s) && qty) {
      // A practice run trades a paper book that starts empty (the runtime counts it so): the real position is not its.
      const lim = checkLimits(m, { side: s.side, quantity: qty, price: out.avgPrice ?? px, position: s.paper ? 0 : (ctx.positionSize ?? null), leverage: limitLeverage(m, s.leverage, null), oi: ctx.oi ?? null });
      out.errors.unshift(...lim.errors);
      out.warnings.unshift(...lim.warnings);
      out.oi = lim.oi;
    }
  }
  return out;
}

/** How many priced children sit outside SoDEX's limit band around `ref` (where it refuses a limit order). */
export function bandRefused(side: 'buy' | 'sell', children: readonly Pick<PlannedChild, 'price'>[], m: Pick<MarketInfo, 'buyLimitUpRatio' | 'sellLimitDownRatio'>, ref: number): number {
  return children.filter((c) => c.price !== null && (side === 'buy' ? c.price > ref * (1 + m.buyLimitUpRatio) + 1e-9 : c.price < ref * (1 - m.sellLimitDownRatio) - 1e-9)).length;
}
