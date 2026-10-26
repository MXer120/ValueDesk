/**
 * The prices of the order the ticket holds but has not placed yet, for the
 * chart to draw as faint, pulsing lines. OrderEntry (and the algo ticket
 * through it) publishes; the chart subscribes and draws only its own market.
 * A module rather than TradeContext, as orderImpact.ts: the lines change on
 * every keystroke and only these two panels care.
 */
import { useSyncExternalStore } from 'react';

/** limit: where it rests; trigger: where it starts; tp / sl: its exits. */
export type DraftLineKind = 'limit' | 'trigger' | 'tp' | 'sl';

export interface DraftLine {
  price: number;
  /** "Limit · 0.5 BTC", "TP", "DCA 3/5 · 0.01 BTC". */
  label: string;
  kind: DraftLineKind;
}

export interface DraftOrders {
  engine: string;
  symbol: string;
  side: 'buy' | 'sell';
  lines: DraftLine[];
}

let current: DraftOrders | null = null;
let key = '';
const listeners = new Set<() => void>();

const signature = (v: DraftOrders | null): string =>
  v === null || !v.lines.length ? '' : `${v.engine}|${v.symbol}|${v.side}|${v.lines.map((l) => `${l.kind}:${l.price}:${l.label}`).join(',')}`;

/** Usable lines only (a positive finite price); none at all is null. */
export function cleanDraft(next: DraftOrders | null): DraftOrders | null {
  if (!next) return null;
  const lines = next.lines.filter((l) => Number.isFinite(l.price) && l.price > 0).slice(0, 100);
  return lines.length ? { ...next, lines } : null;
}

export function publishDraftOrders(next: DraftOrders | null): void {
  const v = cleanDraft(next);
  const sig = signature(v);
  if (sig === key) return;
  key = sig;
  current = v;
  listeners.forEach((l) => l());
}

export function getDraftOrders(): DraftOrders | null {
  return current;
}

export function useDraftOrders(): DraftOrders | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
