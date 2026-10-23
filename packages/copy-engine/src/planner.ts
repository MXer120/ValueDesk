/**
 * The planner: one leader position change in, the follower's orders out.
 *
 * Pure and deterministic, so the browser copier, the hosted executor and a
 * self-hosted executor place the same orders for the same change - and so it
 * can be tested by hand. It is the live form of the backtest engine
 * (apps/web/src/components/copy/sim, research 03 section C):
 *
 *   leader event      desired follower position D
 *   open              T(L_after)
 *   increase          T(L_after), never smaller than what the copy holds
 *   decrease          F x |L_after| / |L_before|   (the same fraction as the leader)
 *   close             0
 *   flip              close F, then T(L_after) as a fresh open
 *
 * where F is the position THIS COPY holds on the market (never the follower's
 * own trades), and T sizes by notional:
 *
 *   proportional      L x price x copyEquity / leaderEquity
 *   fixedRatio        L x price x ratio
 *   fixedNotional     sign(L) x fixedNotionalUsd
 *
 * converted to SoDEX units at the SoDEX reference price (the mark). Opens and
 * increases are TARGET-based, so a growth too small to trade accumulates and
 * the next change picks it up; reductions are reduce-only and exempt from the
 * minimum order value, as on SoDEX.
 *
 * Growth is clamped, in order, by: the per-position cap, the copy's leverage
 * cap (gross copied exposure <= leverage x copy equity, where the leverage is
 * the lowest of the follower's cap, the region's cap and the market's), the
 * market's order limits. Then it is floored to the step; below the minimum
 * order value it is skipped.
 */
import { keccak256, utf8, bytesToHex } from '../../sodex-core/src/index.ts';
import { coinOf, floorQuantity, isSpotSymbol, limitPrice, quantityOk } from './markets.ts';
import { effectiveLeverage, type RegionPolicy } from './policy.ts';
import type {
  CopySettings,
  DetachReason,
  FollowerSnapshot,
  Intent,
  LeaderEvent,
  MarketInfo,
  OrderLeg,
  SkipReason,
  SubState,
  Subscription,
} from './types.ts';

/** Relative size below which a position counts as flat. */
const FLAT_EPS = 1e-9;
const isFlat = (x: number): boolean => !Number.isFinite(x) || Math.abs(x) < FLAT_EPS;
const sign = (x: number): number => (isFlat(x) ? 0 : x > 0 ? 1 : -1);

/** Deterministic client order id: `vdc-` + 24 hex of keccak(subId|eventId|leg). Fits `^[0-9a-zA-Z_-]{1,36}$`. */
export function clientOrderId(subId: string, eventId: string, leg: string): string {
  return `vdc-${bytesToHex(keccak256(utf8(`${subId}|${eventId}|${leg}`))).slice(2, 26)}`;
}

/** Whether a client order id was minted by a copier. */
export const isCopyOrderId = (id: string | null | undefined): boolean => typeof id === 'string' && /^vd[cs]-/.test(id);

/** Mark-to-market value of the copy's positions, USD (unrealised PnL only). */
export function unrealized(state: Pick<SubState, 'owned'>, markOf: (symbol: string) => number | null): number {
  let u = 0;
  for (const [sym, p] of Object.entries(state.owned)) {
    const m = markOf(sym);
    if (m !== null) u += p.size * (m - p.entry);
  }
  return u;
}

/** The copy's equity: allocation + realised - fees + unrealised. Never below 0. */
export function copyEquity(settings: Pick<CopySettings, 'allocationUsd'>, state: SubState, markOf: (symbol: string) => number | null): number {
  return Math.max(0, settings.allocationUsd + state.realizedPnl - state.fees + unrealized(state, markOf));
}

/** Gross notional of the copy's positions, optionally leaving one market out. */
export function grossNotional(state: Pick<SubState, 'owned'>, markOf: (symbol: string) => number | null, except?: string): number {
  let g = 0;
  for (const [sym, p] of Object.entries(state.owned)) {
    if (sym === except) continue;
    g += Math.abs(p.size) * (markOf(sym) ?? p.entry);
  }
  return g;
}

export interface PlanContext {
  sub: Pick<Subscription, 'id' | 'status' | 'settings'>;
  state: SubState;
  event: LeaderEvent;
  /** The SoDEX market the leader's market maps to (null: not listed). */
  market: MarketInfo | null;
  /** SoDEX mark of a market (null: not known). */
  markOf: (symbol: string) => number | null;
  policy: Pick<RegionPolicy, 'maxLeverage'>;
  /** Who holds the follower's position on the market when this copy does not: another copy, or the follower. */
  heldBy: 'nobody' | 'follower' | 'other-copy';
  follower: FollowerSnapshot | null;
}

export interface Plan {
  intents: Intent[];
  /** Why nothing (or less than the rule asked for) was placed. */
  skip: SkipReason | null;
  /** The leader's position after the event (the runtime stores it). */
  leaderAfter: number;
  /** Detach the leader market until the leader is flat on it. */
  detach: DetachReason | null;
  /** Re-attach a detached market. */
  attach: boolean;
}

const none = (leaderAfter: number, skip: SkipReason | null, extra: Partial<Plan> = {}): Plan => ({
  intents: [],
  skip,
  leaderAfter,
  detach: null,
  attach: false,
  ...extra,
});

const DETACH_SKIP: Record<DetachReason, SkipReason> = {
  'pre-existing': 'pre-existing-position',
  'stop-loss': 'after-stop-loss',
  'take-profit': 'after-take-profit',
  'own-position': 'own-position',
};

/** Target notional (signed, USD) for leader position `lSize` at leader price `lPrice`. */
export function targetNotional(
  s: Pick<CopySettings, 'sizingMode' | 'ratio' | 'fixedNotionalUsd'>,
  lSize: number,
  lPrice: number,
  equity: number,
  leaderEquity: number | null,
): number | null {
  if (isFlat(lSize)) return 0;
  const lNotional = lSize * lPrice;
  if (s.sizingMode === 'proportional') {
    if (leaderEquity === null || !(leaderEquity > 0)) return null;
    return (lNotional * equity) / leaderEquity;
  }
  if (s.sizingMode === 'fixedRatio') return lNotional * s.ratio;
  return sign(lSize) * s.fixedNotionalUsd;
}

export function planLeaderEvent(ctx: PlanContext): Plan {
  const { sub, state, event, market } = ctx;
  const s = sub.settings;
  const lSym = event.symbol;
  const lBefore = event.before ?? state.leaderPos[lSym] ?? 0;
  const lAfter = isFlat(event.after) ? 0 : event.after;

  if (state.seen.includes(event.id)) return none(lAfter, 'duplicate');
  if (isSpotSymbol(s.leader.venue, lSym)) return none(lAfter, 'spot-not-copied');
  if (!market) return none(lAfter, 'not-on-sodex');
  if (sub.status === 'paused') return none(lAfter, 'paused');
  if (sub.status !== 'active') return none(lAfter, 'halted');
  if (market.status !== 'TRADING') return none(lAfter, 'market-halted');

  const owned = state.owned[market.name];
  const F = owned?.size ?? 0;

  // A detached market waits for the leader to be flat. A flip opens the new side fresh: the old side was never ours.
  const detached = state.detached[lSym];
  let attach = false;
  let before = lBefore;
  if (detached) {
    if (lAfter === 0) return none(lAfter, DETACH_SKIP[detached], { attach: true });
    if (sign(lBefore) * sign(lAfter) < 0 && isFlat(F)) {
      attach = true;
      before = 0;
    } else {
      return none(lAfter, DETACH_SKIP[detached]);
    }
  }

  const coin = coinOf(s.leader.venue, lSym);
  const filtered: SkipReason | null =
    s.assetAllow.length > 0 && !s.assetAllow.includes(coin) ? 'asset-not-allowed' : s.assetDeny.includes(coin) ? 'asset-denied' : null;

  const ref = ctx.markOf(market.name) ?? (s.leader.venue === 'sodex' && event.price > 0 ? event.price : null);
  if (ref === null) return none(lAfter, 'no-price', { attach });

  const equity = copyEquity(s, state, ctx.markOf);
  const lev = effectiveLeverage(s.maxLeverage, ctx.policy, market.maxLeverage);
  const levNoRegion = effectiveLeverage(s.maxLeverage, { maxLeverage: null }, market.maxLeverage);
  const intents: Intent[] = [];
  let skip: SkipReason | null = null;

  const reduce = (to: number, leg: OrderLeg) => {
    // `to` has the same sign as F (or is 0), |to| < |F|.
    const exact = isFlat(to);
    const q = floorQuantity(exact ? F : F - to, market);
    if (q === '0') {
      skip = 'lot-size';
      return;
    }
    const side = F > 0 ? 'sell' : 'buy';
    intents.push({
      symbol: market.name,
      side,
      quantity: q,
      limitPrice: limitPrice(side, ref, s.slippageBps, market, ctx.markOf(market.name)),
      reduceOnly: true,
      leg,
      notionalUsd: Number(q) * ref,
      clampedBy: null,
      clOrdID: clientOrderId(sub.id, event.id, leg),
    });
  };

  const grow = (from: number, desired: number, leg: OrderLeg) => {
    // |desired| > |from|, same sign (from may be 0).
    if (filtered) {
      skip = filtered;
      return;
    }
    if (isFlat(from) && ctx.heldBy !== 'nobody') {
      skip = ctx.heldBy === 'other-copy' ? 'owned-by-other-copy' : 'own-position';
      return;
    }
    let target = Math.abs(desired);
    let clampedBy: Intent['clampedBy'] = null;
    const capPos = s.maxPositionUsd / ref;
    if (target > capPos) {
      target = capPos;
      clampedBy = 'max-position';
    }
    const room = (lev * equity - grossNotional(state, ctx.markOf, market.name)) / ref;
    const roomNoRegion = (levNoRegion * equity - grossNotional(state, ctx.markOf, market.name)) / ref;
    if (target > room) {
      clampedBy = room < roomNoRegion && target <= roomNoRegion ? 'region-leverage' : 'max-leverage';
      target = Math.max(0, room);
    }
    let delta = target - Math.abs(from);
    if (!(delta > 0)) {
      skip = clampedBy ?? 'at-target';
      return;
    }
    if (market.maxNotional !== null && delta * ref > market.maxNotional) delta = market.maxNotional / ref;
    const maxQ = Number(market.maxQuantity);
    if (maxQ > 0 && delta > maxQ) delta = maxQ;
    const q = floorQuantity(delta, market);
    if (!quantityOk(q, market)) {
      skip = clampedBy ?? 'lot-size';
      return;
    }
    const notional = Number(q) * ref;
    if (notional < market.minNotional) {
      skip = clampedBy ?? 'min-notional';
      return;
    }
    const side = desired > 0 ? 'buy' : 'sell';
    intents.push({
      symbol: market.name,
      side,
      quantity: q,
      limitPrice: limitPrice(side, ref, s.slippageBps, market, ctx.markOf(market.name)),
      reduceOnly: false,
      leg,
      notionalUsd: notional,
      clampedBy,
      clOrdID: clientOrderId(sub.id, event.id, leg),
    });
  };

  const T = (l: number): number | null => {
    const n = targetNotional(s, l, event.price > 0 ? event.price : ref, equity, state.leaderEquity);
    return n === null ? null : n / ref;
  };

  if (lAfter === 0) {
    // Close.
    if (isFlat(F)) return none(lAfter, 'no-follower-position', { attach });
    reduce(0, 'close');
  } else if (sign(before) * sign(lAfter) < 0) {
    // Flip: close ours, open the new side fresh.
    if (!isFlat(F)) reduce(0, 'flip-close');
    const t = T(lAfter);
    if (t === null) skip = skip ?? 'no-leader-equity';
    else grow(0, t, 'flip-open');
  } else if (isFlat(before)) {
    // Open.
    const t = T(lAfter);
    if (t === null) return none(lAfter, 'no-leader-equity', { attach });
    if (!isFlat(F) && sign(F) !== sign(t)) {
      // Our copy is on the other side (missed a flip): close it first.
      reduce(0, 'flip-close');
      grow(0, t, 'flip-open');
    } else grow(F, t, 'open');
  } else if (Math.abs(lAfter) > Math.abs(before)) {
    // Increase.
    let t: number | null;
    if (s.sizingMode === 'fixedNotional' && !isFlat(F)) t = (F * Math.abs(lAfter)) / Math.abs(before);
    else t = T(lAfter);
    if (t === null) return none(lAfter, 'no-leader-equity', { attach });
    if (isFlat(F) || sign(F) === sign(t)) {
      if (Math.abs(t) <= Math.abs(F)) skip = 'at-target';
      else grow(F, t, 'increase');
    } else {
      reduce(0, 'flip-close');
      grow(0, t, 'flip-open');
    }
  } else if (Math.abs(lAfter) < Math.abs(before)) {
    // Decrease by the leader's fraction.
    if (isFlat(F)) return none(lAfter, 'no-follower-position', { attach });
    const to = (F * Math.abs(lAfter)) / Math.abs(before);
    reduce(to, 'decrease');
  } else {
    skip = 'at-target';
  }

  return { intents, skip: intents.length ? (skip as SkipReason | null) : (skip ?? 'at-target'), leaderAfter: lAfter, detach: null, attach };
}

/* ----------------------------------------------------------------- guards ----- */

export interface GuardContext {
  sub: Pick<Subscription, 'id' | 'status' | 'settings'>;
  state: SubState;
  markets: (symbol: string) => MarketInfo | null;
  markOf: (symbol: string) => number | null;
  policy: Pick<RegionPolicy, 'maxLeverage'>;
  now: number;
}

export interface GuardPlan {
  intents: Intent[];
  /** Markets to detach (SoDEX symbol -> why), with their leader symbols resolved by the runtime. */
  closed: Record<string, DetachReason>;
  /** Close everything and halt: the drawdown stop fired. */
  halt: 'drawdown-stop' | null;
  equity: number;
  peak: number;
}

/**
 * The follower's protective rules, at the current marks: stop-loss and
 * take-profit per copied position (fraction of its margin at the position's
 * leverage), and the copy's drawdown stop. The copier also places SoDEX stop
 * orders for the stop-loss (runtime.ts), so a copy closes even while no copier
 * runs; this is the second line.
 */
export function planGuards(ctx: GuardContext): GuardPlan {
  const s = ctx.sub.settings;
  const equity = copyEquity(s, ctx.state, ctx.markOf);
  const peak = Math.max(ctx.state.peakEquity, equity);
  const intents: Intent[] = [];
  const closed: Record<string, DetachReason> = {};
  if (ctx.sub.status !== 'active' && ctx.sub.status !== 'paused') return { intents, closed, halt: null, equity, peak };

  const closeLeg = (sym: string, leg: OrderLeg, tag: string): boolean => {
    const p = ctx.state.owned[sym];
    const m = ctx.markets(sym);
    const mark = ctx.markOf(sym);
    if (!p || !m || mark === null || isFlat(p.size)) return false;
    const q = floorQuantity(p.size, m);
    if (q === '0') return false;
    const side = p.size > 0 ? 'sell' : 'buy';
    intents.push({
      symbol: sym,
      side,
      quantity: q,
      limitPrice: limitPrice(side, mark, Math.max(s.slippageBps, 100), m, mark),
      reduceOnly: true,
      leg,
      notionalUsd: Number(q) * mark,
      clampedBy: null,
      clOrdID: clientOrderId(ctx.sub.id, tag, leg),
    });
    return true;
  };

  if (s.drawdownStopPct !== null && peak > 0 && (peak - equity) / peak >= s.drawdownStopPct) {
    const tag = `dd:${Math.floor(ctx.now / 60_000)}`;
    for (const sym of Object.keys(ctx.state.owned)) closeLeg(sym, 'drawdown-stop', `${tag}:${sym}`);
    return { intents, closed, halt: 'drawdown-stop', equity, peak };
  }

  for (const [sym, p] of Object.entries(ctx.state.owned)) {
    const m = ctx.markets(sym);
    const mark = ctx.markOf(sym);
    if (!m || mark === null || isFlat(p.size)) continue;
    const lev = effectiveLeverage(s.maxLeverage, ctx.policy, m.maxLeverage);
    const move = (sign(p.size) * (mark - p.entry)) / p.entry; // fraction, + = in favour
    const onMargin = move * lev;
    const tag = `g:${sym}:${p.openedAt}`;
    if (s.stopLossPct !== null && onMargin <= -s.stopLossPct) {
      if (closeLeg(sym, 'stop-loss', tag)) closed[sym] = 'stop-loss';
    } else if (s.takeProfitPct !== null && onMargin >= s.takeProfitPct) {
      if (closeLeg(sym, 'take-profit', tag)) closed[sym] = 'take-profit';
    }
  }
  return { intents, closed, halt: null, equity, peak };
}

/** The trigger price of a copied position's stop-loss / take-profit, or null when off. */
export function guardTrigger(
  kind: 'stop-loss' | 'take-profit',
  p: { size: number; entry: number },
  settings: Pick<CopySettings, 'stopLossPct' | 'takeProfitPct' | 'maxLeverage'>,
  leverage: number,
): number | null {
  const pct = kind === 'stop-loss' ? settings.stopLossPct : settings.takeProfitPct;
  if (pct === null || isFlat(p.size) || !(p.entry > 0)) return null;
  const dir = kind === 'stop-loss' ? -1 : 1;
  const px = p.entry * (1 + (sign(p.size) * dir * pct) / Math.max(1, leverage));
  return px > 0 ? px : null;
}

/** A fresh runtime state for a subscription. */
export function freshState(subId: string, allocationUsd: number): SubState {
  return {
    subId,
    leaderPos: {},
    leaderEquity: null,
    leaderEquityAt: null,
    owned: {},
    detached: {},
    stops: {},
    realizedPnl: 0,
    fees: 0,
    peakEquity: allocationUsd,
    seen: [],
    lastEventAt: null,
    lastReconcileAt: null,
    orders: 0,
    skips: 0,
  };
}

/** Remember an event id (bounded, newest last). */
export function noteSeen(state: SubState, id: string, cap = 500): void {
  state.seen.push(id);
  if (state.seen.length > cap) state.seen.splice(0, state.seen.length - cap);
}

/**
 * Apply a fill of a copied order to the copy's books: position, average entry
 * and realised PnL (gross; fees are booked apart).
 */
export function applyFill(state: SubState, symbol: string, side: 'buy' | 'sell', qty: number, price: number, fee: number, at: number): void {
  if (!(qty > 0) || !(price > 0)) return;
  const d = side === 'buy' ? qty : -qty;
  const p = state.owned[symbol];
  const size = p?.size ?? 0;
  state.fees += Math.max(0, fee);
  if (isFlat(size) || sign(size) === sign(d)) {
    const next = size + d;
    const entry = isFlat(size) ? price : (p!.entry * Math.abs(size) + price * Math.abs(d)) / Math.abs(next);
    state.owned[symbol] = { size: next, entry, openedAt: p?.openedAt ?? at };
    return;
  }
  // Reducing (and possibly flipping).
  const closing = Math.min(Math.abs(d), Math.abs(size));
  state.realizedPnl += closing * (price - p!.entry) * sign(size);
  const next = size + d;
  if (isFlat(next) || Math.abs(next) < 1e-12) delete state.owned[symbol];
  else if (sign(next) === sign(size)) state.owned[symbol] = { size: next, entry: p!.entry, openedAt: p!.openedAt };
  else state.owned[symbol] = { size: next, entry: price, openedAt: at };
}
