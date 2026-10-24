/**
 * Consent for Reown's usage reports (§ 25(1) TDDDG, Art. 6(1)(a) GDPR).
 *
 * Reown's wallet-connection software (AppKit, walletconnect.ts) reports to Reown
 * (pulse.walletconnect.org) that it started and that a wallet connected - with the
 * wallet's address, this site's address and technical details of the browser - and
 * sends error reports with the page address. It does so whatever its settings say
 * (its analytics stay off, so nothing beyond these mandatory reports goes out).
 * walletconnect.ts lets them through only while the visitor allows it: "Accept all"
 * in the terms popup (next to an equally visible "Only necessary", never
 * pre-selected, never a condition of the terms - LegalGate.tsx), or the switch on
 * the Cookies page, where it is withdrawn too. Asked again at every report, so a
 * withdrawal takes effect at once. Kept in this browser only.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'vd.consent.reown.v1';

const listeners = new Set<() => void>();
/** When the visitor allowed the reports (ms), or null; undefined: not read yet. */
let allowedAt: number | null | undefined;

function load(): number | null {
  if (allowedAt !== undefined) return allowedAt;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { allowedAt?: unknown } | null;
    allowedAt = typeof v?.allowedAt === 'number' && Number.isFinite(v.allowedAt) ? v.allowedAt : null;
  } catch {
    allowedAt = null;
  }
  return allowedAt;
}

function save(at: number | null): void {
  allowedAt = at;
  try {
    if (at === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ allowedAt: at }));
  } catch {
    /* private mode: for this page only */
  }
  for (const l of listeners) l();
}

/** When the reports were allowed, or null. */
export const reownReportsAllowedAt = (): number | null => load();
export const reownReportsAllowed = (): boolean => load() !== null;
export const allowReownReports = (now = Date.now()): void => save(load() ?? now);
export const revokeReownReports = (): void => save(null);

export function subscribeReownReports(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useReownReportsAllowedAt(): number | null {
  return useSyncExternalStore(subscribeReownReports, reownReportsAllowedAt, reownReportsAllowedAt);
}

/** For tests. */
export function _resetReownReportsForTests(): void {
  allowedAt = undefined;
}
