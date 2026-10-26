/**
 * The order the ticket is about to send, as the book should draw it.
 * OrderEntry publishes; the order book subscribes. A module rather than
 * TradeContext because the take list changes on every keystroke and only
 * these two panels care.
 */
import { useSyncExternalStore } from 'react';

export interface RawTake {
  /** Raw book price, not a grouped bucket. */
  price: number;
  /** Base size this order would take from the level. */
  taken: number;
  /** Base size resting at the level. */
  qty: number;
}

/** A limit joining the book at one price. The book thickens that level only. */
export interface OrderRest {
  /** Raw limit price, not a grouped bucket. */
  price: number;
  /** Base size that would rest at that price. */
  qty: number;
}

export interface OrderImpact {
  symbol: string;
  side: 'buy' | 'sell';
  /** Market: levels this order would take. A limit leaves this empty. */
  takes: RawTake[];
  /** Limit: the single level this order would join. A market leaves this null. */
  rest: OrderRest | null;
}

/**
 * What a limit does on arrival, for the book to draw.
 *
 * A limit at or through the far touch (a buy at or above the best ask) is
 * marketable: whatever its TIF it is sent, and the venue fills it at once as a
 * taker through the levels up to its price - `walk`, the ticket's walk capped
 * at the limit. What is left then depends on the TIF: GTC rests it on its own
 * side at its price, IOC cancels it, post only (GTX) rejects the whole order.
 * A limit that does not cross takes nothing: GTC and GTX rest in full, IOC is
 * cancelled untouched. `touch` is the far side's best price (the best ask for a
 * buy); 0 when that side is empty, which nothing crosses.
 */
export function limitImpact(o: {
  side: 'buy' | 'sell';
  limit: number | null;
  qty: number;
  tif: 'gtc' | 'ioc' | 'gtx';
  touch: number;
  walk: RawTake[];
}): { takes: RawTake[]; rest: OrderRest | null } {
  if (o.limit === null || !(o.limit > 0) || !(o.qty > 0)) return { takes: [], rest: null };
  const crosses = o.touch > 0 && (o.side === 'buy' ? o.limit >= o.touch : o.limit <= o.touch);
  if (crosses && o.tif === 'gtx') return { takes: [], rest: null };
  const takes = crosses ? o.walk : [];
  const filled = takes.reduce((s, t) => s + t.taken, 0);
  const left = o.tif === 'ioc' ? 0 : Math.max(0, o.qty - filled);
  return { takes, rest: left > 1e-12 ? { price: o.limit, qty: left } : null };
}

let current: OrderImpact | null = null;
let key = '';
const listeners = new Set<() => void>();

const signature = (v: OrderImpact | null): string =>
  v === null
    ? ''
    : `${v.symbol}|${v.side}|${v.takes.map((t) => `${t.price}:${t.taken}`).join(',')}|${
        v.rest ? `${v.rest.price}:${v.rest.qty}` : ''
      }`;

export function publishOrderImpact(next: OrderImpact | null): void {
  const sig = signature(next);
  if (sig === key) return;
  key = sig;
  current = next;
  listeners.forEach((l) => l());
}

export function useOrderImpact(): OrderImpact | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
