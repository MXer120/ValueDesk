/**
 * Which trades ask first (components/TradeConfirm.tsx). Every kind asks by default; "Don't ask again" in the
 * window and the switches in Settings > Trading turn one off, in this browser.
 *
 * This is about the question only. Turning it off leaves the terms gate, the fee guards and the checks the ticket
 * makes before it gets here where they are: none of them read this file.
 *
 * Storage fails closed: a browser that refuses localStorage keeps asking.
 */
import { useSyncExternalStore } from 'react';

export const CONFIRM_KINDS = ['order', 'close', 'cancel', 'cancelAll', 'move', 'tpsl'] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

export const CONFIRM_LABELS: Record<ConfirmKind, { title: string; line: string }> = {
  order: { title: 'Placing an order', line: 'Market, limit and stop orders from the ticket' },
  close: { title: 'Closing a position', line: 'At market, from the Positions table or the chart' },
  cancel: { title: 'Cancelling an order', line: 'One order, from Open orders or the chart' },
  cancelAll: { title: 'Cancelling all orders', line: 'The Cancel all button' },
  move: { title: 'Changing an order', line: 'Dragging its line on the chart, or Modify in Open orders' },
  tpsl: { title: 'Take profit and stop loss', line: 'Setting, changing or removing a position’s exits' },
};

const KEY = 'vs.confirm';
/** `order` lives under the key its "don't show again" always used, so an earlier choice stands. */
const ORDER_KEY = 'opentrade.review.suppress';

export type ConfirmPrefs = Readonly<Record<ConfirmKind, boolean>>;
const ALL_ON: ConfirmPrefs = { order: true, close: true, cancel: true, cancelAll: true, move: true, tpsl: true };

function read(): ConfirmPrefs {
  const next: Record<ConfirmKind, boolean> = { ...ALL_ON };
  try {
    next.order = localStorage.getItem(ORDER_KEY) !== '1';
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Record<ConfirmKind, unknown>>) : null;
    // Only a stored `false` turns a kind off: anything else that could be in there still asks.
    for (const k of CONFIRM_KINDS) if (k !== 'order' && saved?.[k] === false) next[k] = false;
  } catch {
    // A broken or refused value is no choice: what could be read stands, the rest asks.
  }
  return next;
}

let cached: ConfirmPrefs | null = null;
const subs = new Set<() => void>();
const current = (): ConfirmPrefs => (cached ??= read());

/** Whether this kind of trade asks first. */
export const confirmOn = (kind: ConfirmKind): boolean => current()[kind];

export function setConfirmOn(kind: ConfirmKind, on: boolean): void {
  const next = { ...current(), [kind]: on };
  try {
    if (kind === 'order') {
      if (on) localStorage.removeItem(ORDER_KEY);
      else localStorage.setItem(ORDER_KEY, '1');
    } else {
      const { order: _order, ...rest } = next;
      localStorage.setItem(KEY, JSON.stringify(rest));
    }
    cached = next;
  } catch {
    // Not saved, so not changed: a setting that cannot be kept must not look kept.
  }
  for (const fn of subs) fn();
}

/** Every kind asks again. */
export function resetConfirms(): void {
  for (const k of CONFIRM_KINDS) setConfirmOn(k, true);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  const other = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== ORDER_KEY && e.key !== null) return;
    cached = null;
    fn();
  };
  window.addEventListener('storage', other);
  return () => {
    subs.delete(fn);
    window.removeEventListener('storage', other);
  };
}

/** The switches, live: the window's tick shows in Settings at once. */
export function useConfirmPrefs(): ConfirmPrefs {
  return useSyncExternalStore(subscribe, current, () => ALL_ON);
}

/** Tests start over. */
export function _forgetConfirmPrefs(): void {
  cached = null;
}
