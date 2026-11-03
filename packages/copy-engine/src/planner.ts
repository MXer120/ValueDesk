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
 *                     (fixed amount: r x |L_after|)
 *   decrease          r x |L_after|   (the same fraction as the leader)
 *   close             0
 *   flip              close F, then T(L_after) as a fresh open
 *
 * where F is the position THIS COPY holds on the market (never the follower's
 * own trades), its orders in flight included; r is the copy's size per unit
 * of the leader's position, set when the copy is sized (open, increase, flip)
 * and kept through decreases, so a step too small to trade (below one lot or
 * the minimum order value) is caught up by the next one; a decrease or an
 * increase while the copy is on the other side (a missed flip) is a flip. T
 * sizes by notional:
 *
 *   proportional      L x price x copyEquity / leaderEquity
 *   fixedRatio        L x price x ratio
 *   fixedNotional     sign(L) x fixedNotionalUsd
 *
 * each times settings.multiplier (1 mirrors), before the caps.
 *
 * A counter-trade (settings.direction 'counter') runs the same table on the
 * leader's position mirrored, -L: their long opens your short, their close
 * closes it, their flip flips you the other way.
 *
 * converted to SoDEX units at the SoDEX reference price (the mark). Opens and
 * increases are TARGET-based, so a growth too small to trade accumulates and
 * the next change picks it up; reductions are reduce-only and exempt from the
 * minimum order value, as on SoDEX.
 *
 * Growth is clamped, in order, by: the per-position cap, the copy's leverage
 * cap (gross copied exposure, orders in flight included, <= leverage x copy
 * equity, where the leverage is the lowest of the follower's cap, the
 * region's cap and the market's), the market's order limits. Then it is
 * floored to the step; below the minimum order value it is skipped, and so is
 * an order the follower's free margin on SoDEX does not cover.
 *
 * A halted or blocked copy only reduces: closes, decreases and the close half
 * of a flip still go out, nothing that opens or adds.
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
  /** The follower's SoDEX account (live copies; null for paper): its free margin gates opening orders. */
  follower: FollowerSnapshot | null;
  /**
   * SoDEX symbol -> signed size of this copy's orders that were sent but whose fills are not
   * booked yet. They count as held: F and the gross exposure include them, so a second leader
   * change before the first order is booked is not copied again on top of it.
   */
  inFlight?: Record<string, number>;
  /**
   * Whether the leader's market is the same asset as `market` (MarketBook.sameAsset): false
   * when the two venues price it far apart, null when that could not be checked on fresh
   * prices yet. Either way nothing new is opened there ('different-asset' / 'no-price'):
   * the copy only follows the leader's reductions and closes. Absent (a SoDEX leader, whose
   * market is SoDEX's own): no check.
   */
  sameAsset?: boolean | null;
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

const noPlan = (leaderAfter: number, skip: SkipReason | null, extra: Partial<Plan> = {}): Plan => ({
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
  s: Pick<CopySettings, 'sizingMode' | 'ratio' | 'fixedNotionalUsd'> & { multiplier?: number },
  lSize: number,
  lPrice: number,
  equity: number,
  leaderEquity: number | null,
): number | null {
  if (isFlat(lSize)) return 0;
  const lNotional = lSize * lPrice;
  // The multiple of the mode's size (1x mirrors it); the caps apply after it (planLeaderEvent grow).
  const k = Number.isFinite(s.multiplier) && s.multiplier! > 0 ? s.multiplier! : 1;
  if (s.sizingMode === 'proportional') {
    if (leaderEquity === null || !(leaderEquity > 0)) return null;
    return (k * lNotional * equity) / leaderEquity;
  }
  if (s.sizingMode === 'fixedRatio') return k * lNotional * s.ratio;
  return k * sign(lSize) * s.fixedNotionalUsd;
}

/** +1 to take the trader's side, -1 to take the other side (a counter-trade). */
export const directionSign = (s: Pick<CopySettings, 'direction'>): 1 | -1 => (s.direction === 'counter' ? -1 : 1);

/** Signed size per SoDEX market: the copy's booked positions plus its orders in flight. */
function exposures(state: Pick<SubState, 'owned'>, inFlight: Record<string, number> | undefined): Map<string, { size: number; entry: number }> {
  const out = new Map<string, { size: number; entry: number }>();
  for (const [sym, p] of Object.entries(state.owned)) out.set(sym, { size: p.size, entry: p.entry });
  for (const [sym, q] of Object.entries(inFlight ?? {})) {
    if (!Number.isFinite(q) || q === 0) continue;
    const cur = out.get(sym);
    out.set(sym, { size: (cur?.size ?? 0) + q, entry: cur?.entry ?? 0 });
  }
  return out;
}

/**
 * Plan one leader change. Pure but for one piece of book-keeping: the copy's size per
 * unit of the leader's position (`state.ratios`), which the planner keeps itself, so a
 * caller that only books fills still follows scale-outs and adds too small to trade.
 */
export function planLeaderEvent(ctx: PlanContext): Plan {
  const { sub, state, event, market } = ctx;
  const s = sub.settings;
  const lSym = event.symbol;
  // A size that is not a number (a malformed source) says nothing: it is never read as flat,
  // which would close the copy, and the leader's position in the books stays as it was.
  if (!Number.isFinite(event.after) || (event.before !== null && !Number.isFinite(event.before))) {
    return noPlan(state.leaderPos[lSym] ?? 0, 'bad-leader-size');
  }
  // The trader's real position, before and after: what the runtime keeps in its books.
  const realAfter = isFlat(event.after) ? 0 : event.after;
  // What this copy follows: the real position, or its mirror for a counter-trade. Every
  // decision below (open, increase, decrease, close, flip, detach) reads the mirror, so a
  // counter-trade is the same machine on the opposite side; sizes and caps are unchanged.
  const dir = directionSign(s);
  const lBefore = dir * (event.before ?? state.leaderPos[lSym] ?? 0);
  const lAfter = dir * realAfter;
  const none = (skip: SkipReason | null, extra: Partial<Plan> = {}): Plan => noPlan(realAfter, skip, extra);

  if (state.seen.includes(event.id)) return none('duplicate');
  if (isSpotSymbol(s.leader.venue, lSym)) return none('spot-not-copied');
  if (!market) return none('not-on-sodex');
  if (sub.status === 'paused') return none('paused');
  if (sub.status !== 'active' && sub.status !== 'halted' && sub.status !== 'blocked') return none('halted');
  if (market.status !== 'TRADING') return none('market-halted');
  // A halted or blocked copy places nothing new, but still follows the leader's reductions
  // and closes (reduce-only): it must never be left holding a position the leader has left.
  const reduceOnly = sub.status !== 'active';
  const stopSkip: SkipReason = sub.status === 'blocked' ? 'blocked' : 'halted';

  const held = exposures(state, ctx.inFlight);
  const F0 = held.get(market.name)?.size ?? 0;
  const F = isFlat(F0) ? 0 : F0;

  // A detached market waits for the leader to be flat. A flip opens the new side fresh: the old side was never ours.
  // What the copy still holds there (a stop-loss close that filled only in part) is closed when the leader closes or flips.
  const detached = state.detached[lSym];
  let attach = false;
  let before = lBefore;
  if (detached) {
    if (lAfter === 0) {
      if (isFlat(F)) return none(DETACH_SKIP[detached], { attach: true });
      attach = true;
    } else if (sign(lBefore) * sign(lAfter) < 0) {
      attach = true;
      if (isFlat(F)) before = 0;
    } else {
      return none(DETACH_SKIP[detached]);
    }
  }
  if (reduceOnly && isFlat(F)) return none(lAfter === 0 ? 'no-follower-position' : stopSkip, { attach });

  const coin = coinOf(s.leader.venue, lSym);
  const filtered: SkipReason | null =
    s.assetAllow.length > 0 && !s.assetAllow.includes(coin) ? 'asset-not-allowed' : s.assetDeny.includes(coin) ? 'asset-denied' : null;
  // Never on a market that may be another asset; a reduction or close is never held by it.
  const unlike: SkipReason | null = ctx.sameAsset === false ? 'different-asset' : ctx.sameAsset === null ? 'no-price' : null;

  const ref = ctx.markOf(market.name) ?? (s.leader.venue === 'sodex' && event.price > 0 ? event.price : null);
  if (ref === null) return none('no-price', { attach });

  const equity = copyEquity(s, state, ctx.markOf);
  const lev = effectiveLeverage(s.maxLeverage, ctx.policy, market.maxLeverage);
  const levNoRegion = effectiveLeverage(s.maxLeverage, { maxLeverage: null }, market.maxLeverage);
  // Gross exposure on the other markets, orders in flight included.
  let grossOthers = 0;
  for (const [sym, p] of held) if (sym !== market.name) grossOthers += Math.abs(p.size) * (ctx.markOf(sym) ?? p.entry);
  const intents: Intent[] = [];
  let skip: SkipReason | null = null;
  /** Margin a flip's close gives back before its open (SoDEX runs one batch in order). */
  let freed = 0;
  /** The copy's size per leader unit after this plan: undefined = unchanged, null = forgotten. */
  let nextRatio: number | null | undefined;
  const known = state.ratios?.[lSym];
  /** The copy's size per leader unit: as kept, or (first time, or a state saved before it was kept) from what it holds. */
  const ratioFrom = (leaderSize: number): number => (known !== undefined && known > 0 ? known : Math.abs(F) / Math.abs(leaderSize));

  const reduce = (to: number, leg: OrderLeg) => {
    // `to` has the same sign as F (or is 0), |to| < |F|.
    const exact = isFlat(to);
    // (1 + 1e-9): F - to is a float; a difference of exactly one step must not floor to nothing.
    const q = floorQuantity(exact ? F : (F - to) * (1 + 1e-9), market);
    if (q === '0') {
      skip = 'lot-size';
      return;
    }
    const side = F > 0 ? 'sell' : 'buy';
    if (leg === 'flip-close') freed += (Number(q) * ref) / lev;
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

  /** Grow the copy from `from` towards `desired`: its size after the order, or null when nothing is placed. */
  const grow = (from: number, desired: number, leg: OrderLeg): number | null => {
    // |desired| > |from|, same sign (from may be 0).
    if (reduceOnly) {
      skip = stopSkip;
      return null;
    }
    if (unlike) {
      skip = unlike;
      return null;
    }
    if (filtered) {
      skip = filtered;
      return null;
    }
    if (isFlat(from) && ctx.heldBy !== 'nobody') {
      skip = ctx.heldBy === 'other-copy' ? 'owned-by-other-copy' : 'own-position';
      return null;
    }
    let target = Math.abs(desired);
    let clampedBy: Intent['clampedBy'] = null;
    const capPos = s.maxPositionUsd / ref;
    if (target > capPos) {
      target = capPos;
      clampedBy = 'max-position';
    }
    const room = (lev * equity - grossOthers) / ref;
    const roomNoRegion = (levNoRegion * equity - grossOthers) / ref;
    if (target > room) {
      clampedBy = room < roomNoRegion && target <= roomNoRegion ? 'region-leverage' : 'max-leverage';
      target = Math.max(0, room);
    }
    let delta = target - Math.abs(from);
    if (!(delta > 0)) {
      skip = clampedBy ?? 'at-target';
      return null;
    }
    if (market.maxNotional !== null && delta * ref > market.maxNotional) delta = market.maxNotional / ref;
    const maxQ = Number(market.maxQuantity);
    if (maxQ > 0 && delta > maxQ) delta = maxQ;
    const q = floorQuantity(delta, market);
    if (!quantityOk(q, market)) {
      skip = clampedBy ?? 'lot-size';
      return null;
    }
    const notional = Number(q) * ref;
    if (notional < market.minNotional) {
      skip = clampedBy ?? 'min-notional';
      return null;
    }
    // Never more than the follower's SoDEX account can carry: an order its free margin does
    // not cover (at the copy's leverage, plus the taker fee) would only be refused by SoDEX.
    // A margin SoDEX did not report gates nothing.
    const f = ctx.follower;
    if (f && f.marginKnown !== false) {
      const need = notional / lev + notional * market.takerFee;
      if (f.available + freed < need) {
        skip = 'free-margin';
        return null;
      }
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
    return Math.abs(from) + Number(q);
  };

  const T = (l: number): number | null => {
    const n = targetNotional(s, l, event.price > 0 ? event.price : ref, equity, state.leaderEquity);
    return n === null ? null : n / ref;
  };

  /** Close ours (if any), then open the leader's side fresh. */
  const flip = () => {
    if (!isFlat(F)) reduce(0, 'flip-close');
    nextRatio = null;
    const t = T(lAfter);
    if (t === null) {
      skip = skip ?? 'no-leader-equity';
      return;
    }
    const sized = grow(0, t, 'flip-open');
    if (sized !== null) nextRatio = sized / Math.abs(lAfter);
  };

  if (lAfter === 0) {
    // Close.
    nextRatio = null;
    if (isFlat(F)) {
      if (state.ratios) delete state.ratios[lSym];
      return none('no-follower-position', { attach });
    }
    reduce(0, 'close');
  } else if (sign(before) * sign(lAfter) < 0) {
    // Flip.
    flip();
  } else if (isFlat(before)) {
    // Open.
    const t = T(lAfter);
    if (t === null) return none('no-leader-equity', { attach });
    if (!isFlat(F) && sign(F) !== sign(t)) {
      // Our copy is on the other side (missed a flip): close it first.
      flip();
    } else {
      const sized = grow(F, t, 'open');
      if (sized !== null) nextRatio = sized / Math.abs(lAfter);
    }
  } else if (Math.abs(lAfter) > Math.abs(before)) {
    // Increase. A fixed amount grows with the leader by the copy's size per leader unit (kept
    // across adds too small to trade, so they add up); the other modes by their target.
    if (!isFlat(F) && sign(F) !== sign(lAfter)) flip();
    else if (s.sizingMode === 'fixedNotional' && !isFlat(F)) {
      const r = ratioFrom(before);
      nextRatio = r;
      const t = sign(lAfter) * r * Math.abs(lAfter);
      if (Math.abs(t) <= Math.abs(F)) skip = 'at-target';
      else grow(F, t, 'increase');
    } else {
      const t = T(lAfter);
      if (t === null) return none('no-leader-equity', { attach });
      if (Math.abs(t) <= Math.abs(F)) skip = 'at-target';
      else {
        const sized = grow(F, t, 'increase');
        if (sized !== null) nextRatio = sized / Math.abs(lAfter);
      }
    }
  } else if (Math.abs(lAfter) < Math.abs(before)) {
    // Decrease.
    if (isFlat(F)) return none('no-follower-position', { attach });
    if (sign(F) !== sign(lAfter)) {
      // Our copy is on the other side (missed a flip): close it and take the leader's side, as an open does.
      flip();
    } else {
      // The leader's fraction, as a target: the copy's size per leader unit x the leader's
      // size after. A step too small to trade leaves the target where it is, so the next
      // step catches it up (never a fraction of whatever the copy happens to hold).
      const r = ratioFrom(before);
      nextRatio = r;
      const to = r * Math.abs(lAfter);
      if (to >= Math.abs(F)) skip = 'at-target';
      else reduce(sign(F) * to, 'decrease');
    }
  } else {
    skip = 'at-target';
  }

  if (nextRatio === null) {
    if (state.ratios) delete state.ratios[lSym];
  } else if (nextRatio !== undefined && Number.isFinite(nextRatio) && nextRatio > 0) (state.ratios ??= {})[lSym] = nextRatio;

  return { intents, skip: intents.length ? (skip as SkipReason | null) : (skip ?? 'at-target'), leaderAfter: realAfter, detach: null, attach };
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
  // Every copy that may still hold positions is guarded: a halted or blocked one too (its closes are reduce-only).
  if (ctx.sub.status === 'stopped') return { intents, closed, halt: null, equity, peak };

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
    ratios: {},
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
