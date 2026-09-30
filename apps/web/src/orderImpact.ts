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
