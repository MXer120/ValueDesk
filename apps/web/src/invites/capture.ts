/**
 * The referral code a visitor came with, kept the moment the page's script runs (main.tsx), before anything can change
 * the address: until 2026-11-25 the app read it only after its first render, and by then the router had turned
 * `/?ref=CODE` into `/trade` - every referral link lost its code, and not one join was ever recorded.
 *
 * Kept without asking anyone: whether the code is someone's is asked afterwards (invites.ts captureInvite), and a code
 * that could not be asked about (a slow phone, a closed tab, SoDEX silent) stays until it is. No wallet code in here.
 */
import { CODE_RE, INVITE_PARAM, OURS_CODE, normCode } from '@sign/invites/claim';

export const INVITE_KEY = 'vd.invite';
/** SoDEX codes of the wallets this browser connected: a link of one of them is never offered here (own link). */
export const OWN_KEY = 'vd.ref.own';
/** A kept invite older than this is let go (the visitor never connected a wallet). */
export const KEEP_MS = 30 * 86_400_000;

export interface Pending { code: string; at: number; welcome: boolean; vipDays?: number; /** Asked about and someone's. */ checked: boolean }

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const mem = new Map<string, string>();
const tried = <T,>(f: () => T, or: T): T => { try { return f(); } catch { return or; } };
/**
 * Kept in three places, so one that is blocked, full or emptied costs nothing: this page's memory, the tab's storage, the
 * browser's. Read from the first that has it; written and let go in all.
 */
const kept: Store = {
  getItem: (k) => mem.get(k) ?? tried(() => localStorage.getItem(k), null) ?? tried(() => sessionStorage.getItem(k), null),
  setItem: (k, v) => {
    mem.set(k, v);
    tried(() => localStorage.setItem(k, v), undefined);
    tried(() => sessionStorage.setItem(k, v), undefined);
  },
  removeItem: (k) => {
    mem.delete(k);
    tried(() => localStorage.removeItem(k), undefined);
    tried(() => sessionStorage.removeItem(k), undefined);
  },
};
const local = (): Store => kept;
export const dropKept = (): void => kept.removeItem(INVITE_KEY);

export function readOwn(s: Store | null = null): string[] {
  try {
    const v = JSON.parse((s ? s.getItem(OWN_KEY) : localStorage.getItem(OWN_KEY)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The code in an address's query, or null. Pure. */
export function inviteParam(search: string): string | null {
  const c = normCode(new URLSearchParams(search).get(INVITE_PARAM) ?? '');
  return CODE_RE.test(c) && c !== OURS_CODE ? c : null;
}

/** The referral this browser came with, if any (not older than KEEP_MS, not one of its own wallets' codes). */
export function pendingInvite(now = Date.now(), s: Store | null = local()): Pending | null {
  try {
    const v = JSON.parse(s?.getItem(INVITE_KEY) ?? 'null') as Partial<Pending> | null;
    if (!v?.code || !CODE_RE.test(v.code) || now - Number(v.at ?? 0) >= KEEP_MS) return null;
    if (readOwn(s).includes(v.code)) return null;
    // Kept before 2026-11-25: only ever after the check.
    return { code: v.code, at: Number(v.at), welcome: v.welcome !== false, vipDays: Number(v.vipDays) || 0, checked: v.checked !== false };
  } catch {
    return null;
  }
}

export function writeInvite(p: Pending, s: Store | null = local()): void {
  try { s?.setItem(INVITE_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

/** Keep the address's code (a first one only: a checked referral this browser holds already stands). */
export function keepInvite(search: string, now = Date.now(), s: Store | null = local()): string | null {
  const code = inviteParam(search);
  if (!code || readOwn(s).includes(code)) return null;
  const have = pendingInvite(now, s);
  if (have && (have.checked || have.code === code)) return have.code;
  writeInvite({ code, at: now, welcome: true, vipDays: 0, checked: false }, s);
  return code;
}
