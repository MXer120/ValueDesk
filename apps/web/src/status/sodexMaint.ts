/**
 * Whether SoDEX's own maintenance is in progress (owner 2026-11-11), for any part of the app
 * that sends to SoDEX: the order ticket says "SoDEX maintenance" on its button instead of
 * letting an order run into SoDEX's HTTP 503. Fed by the shell from /api/health (App.tsx):
 * the server's SoDEX watch (apps/server/src/ops/sodexWatch.ts) posts the notice from SoDEX's
 * own maintenance flag. No request of its own.
 */
import { useSyncExternalStore } from 'react';
import { healthNoticesOf } from './statusData';

let on = false;
const subs = new Set<() => void>();

/** SoDEX's maintenance is in progress on this /api/health answer. No answer: unchanged. */
export function sodexMaintOf(health: unknown): boolean | null {
  if (!Array.isArray((health as { notices?: unknown } | null | undefined)?.notices)) return null;
  return healthNoticesOf(health).some((n) => n.source === 'sodex' && n.kind === 'maintenance' && n.phase === 'in_progress');
}

/** The shell, on each /api/health answer. */
export function setSodexMaintFrom(health: unknown): void {
  const next = sodexMaintOf(health);
  if (next === null || next === on) return;
  on = next;
  for (const f of subs) f();
}

export function useSodexMaint(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => on,
    () => false,
  );
}
