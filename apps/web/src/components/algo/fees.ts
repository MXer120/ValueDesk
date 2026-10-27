/**
 * What an algo pays SoDEX, from how each of its orders meets the book: one that rests pays the
 * maker rate, one that crosses pays the taker rate, and one whose way depends on the market (a
 * hybrid slice, a chase that takes at its end) is counted apart as "either", so the Summary shows
 * one exact figure where the spec decides it and a range only where the market does.
 */
import type { AlgoPlan, AlgoSpec } from '@copy-engine';

export interface FeeSplit {
  /** USD that rests (maker). */
  maker: number;
  /** USD that takes (taker). */
  taker: number;
  /** USD that rests or takes, as the market goes. */
  either: number;
  /** USD of post-only levels at or through the book: refused, so never filled and never charged. */
  refused: number;
}

export interface Book {
  bid: number | null;
  ask: number | null;
  /** The reference the plan priced at (mid, else mark). */
  px: number | null;
}

const none = (): FeeSplit => ({ maker: 0, taker: 0, either: 0, refused: 0 });

/** At or through the far side of the book: a buy at or above the ask, a sell at or below the bid. */
export function crosses(side: 'buy' | 'sell', price: number, b: Book): boolean {
  const far = side === 'buy' ? (b.ask ?? b.px) : (b.bid ?? b.px);
  if (!far) return false;
  return side === 'buy' ? price >= far : price <= far;
}

/** A limit at `price` for `usd`: rests, takes, or (post-only through the book) is refused. */
function limitAt(out: FeeSplit, side: 'buy' | 'sell', price: number | null, usd: number, postOnly: boolean, b: Book): void {
  if (price === null || !crosses(side, price, b)) out.maker += usd;
  else if (postOnly) out.refused += usd;
  else out.taker += usd;
}

export function feeSplit(s: AlgoSpec, plan: AlgoPlan, b: Book): FeeSplit {
  const out = none();
  const total = plan.notional ?? 0;
  if (!(total > 0) && s.kind !== 'scale') return out;
  switch (s.kind) {
    case 'scale':
      for (const c of plan.children) if (c.qty > 0 && c.price !== null) limitAt(out, s.side, c.price, c.qty * c.price, s.postOnly, b);
      return out;
    case 'twap':
    case 'vwap':
    case 'pov':
    case 'dca': {
      const style = s.exec.style;
      // A maker leg that takes what is left at the end ('finish: take') may take some of it.
      const finish = s.kind === 'dca' ? 'leave' : s.finish;
      if (style === 'taker') out.taker = total;
      else if (style === 'maker' && finish === 'leave') out.maker = total;
      else out.either = total;
      return out;
    }
    case 'iceberg':
      // Pegged clips rest behind the best price; a fixed price rests unless it crosses.
      limitAt(out, s.side, s.price, total, s.postOnly, b);
      return out;
    case 'chase':
      if (s.onEnd === 'take' && (s.timeoutMs !== null || s.maxChaseBps !== null)) out.either = total;
      else out.maker = total;
      return out;
    case 'bracket':
      if (s.entry === 'market') out.taker = total;
      else limitAt(out, s.side, s.price, total, false, b);
      return out;
    case 'conditional': {
      const t = s.then;
      if (t.type === 'limit') limitAt(out, s.side, t.price, total, t.postOnly, b);
      else if (t.type === 'algo') out.either = total;
      else out.taker = total;
      return out;
    }
    case 'trailing':
      if (s.exit === 'market') out.taker = total;
      else out.either = total;
      return out;
    case 'swarm':
    case 'sweep':
    case 'basket':
      out.taker = total;
      return out;
  }
  return out;
}

/** The fee in USD at the lowest and highest it can come to. */
export function feeRange(f: FeeSplit, r: { maker: number; taker: number }): { lo: number; hi: number } {
  const base = f.maker * r.maker + f.taker * r.taker;
  return { lo: base + f.either * Math.min(r.maker, r.taker), hi: base + f.either * Math.max(r.maker, r.taker) };
}

/** A short line under the fee: how the orders meet the book. */
export function feeWords(f: FeeSplit): string {
  const parts: string[] = [];
  const all = f.maker + f.taker + f.either;
  if (!(all > 0)) return f.refused > 0 ? 'nothing fills' : '';
  if (f.maker === all) parts.push('all resting · maker');
  else if (f.taker === all) parts.push('all taking · taker');
  else if (f.either === all) parts.push('resting or taking, as the market goes');
  else {
    if (f.maker > 0) parts.push(`${Math.round((f.maker / all) * 100)}% resting`);
    if (f.taker > 0) parts.push(`${Math.round((f.taker / all) * 100)}% taking`);
    if (f.either > 0) parts.push(`${Math.round((f.either / all) * 100)}% either`);
  }
  // Refused levels are said by the plan's own warning; they cost nothing.
  return parts.join(', ');
}
