/**
 * Referrals and fee credits in the browser (the rules: @sign/invites/claim, the server: routes/invites.ts).
 *
 *   the code    a wallet's own SoDEX referral code, read from SoDEX itself (every SoDEX account has one): no server of
 *               ours is asked, so every wallet with a SoDEX account has its link at once. valuedesk.so/?ref=<CODE>.
 *   ?ref=CODE   a visitor who came on a referral link: the code is checked with the server, kept in this browser and
 *               taken off the address bar; once the wallet accepted the site's terms it is offered to join
 *               (InviteHost) - one signature for ValueDesk, and the same code on SoDEX.
 *   me          a wallet's join, welcome, credits, referrals and history (the Referrals page).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { CODE_RE, INVITE_PARAM, INVITE_STATEMENT, INVITE_TTL_MS, OURS_CODE, inviteTypedData, normCode, type InviteJoin, type InviteMe } from '@sign/invites/claim';
import { getChainId, signTypedData, type Eip1193Provider } from '../wallet';

export const SITE = 'https://valuedesk.so';
const KEY = 'vd.invite';
/** SoDEX codes of the wallets this browser connected: a link of one of them is never offered here (own link). */
const OWN_KEY = 'vd.ref.own';
const BIZ = 'https://alpha-biz.sodex.dev';
const TIMEOUT_MS = 15_000;
/** A kept invite older than this is let go (the visitor never connected a wallet). */
const KEEP_MS = 30 * 86_400_000;

export class InviteError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  const body = (await r.json().catch(() => ({}))) as T;
  return { status: r.status, body };
}

/** A link with a referral code on it (?ref=CODE), its other parameters kept: a share card's. */
export function withInvite(link: string, code: string): string {
  const u = new URL(link);
  u.searchParams.set(INVITE_PARAM, code);
  return u.toString();
}

export const inviteLink = (code: string, path = '/'): string => `${SITE}${path}${path.includes('?') ? '&' : '?'}${INVITE_PARAM}=${code}`;
/** The link as shown: no scheme. */
export const inviteLinkShown = (code: string): string => `valuedesk.so/?${INVITE_PARAM}=${code}`;

/* ------------------------------------------------------------- the code it came with ----- */

export interface Pending { code: string; at: number; welcome: boolean; vipDays?: number }

function readOwn(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(OWN_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember a code as one of this browser's own wallets'. */
function noteOwn(code: string): void {
  const have = readOwn();
  if (have.includes(code)) return;
  try { localStorage.setItem(OWN_KEY, JSON.stringify([...have, code].slice(-20))); } catch { /* private mode */ }
}

/** The referral this browser came with, if any (not older than KEEP_MS, not one of its own wallets' codes). */
export function pendingInvite(now = Date.now()): Pending | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Pending> | null;
    if (!v?.code || !CODE_RE.test(v.code) || now - Number(v.at ?? 0) >= KEEP_MS) return null;
    if (readOwn().includes(v.code)) return null;
    return { code: v.code, at: Number(v.at), welcome: v.welcome !== false, vipDays: Number(v.vipDays) || 0 };
  } catch {
    return null;
  }
}

export function dropInvite(): void {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  changed();
}

/** The code in an address's query, or null. Pure. */
export function inviteParam(search: string): string | null {
  const c = normCode(new URLSearchParams(search).get(INVITE_PARAM) ?? '');
  return CODE_RE.test(c) && c !== OURS_CODE ? c : null;
}

/**
 * On load: a code in the address bar is checked, kept (a first one only: a referral this browser holds already
 * stands) and taken off the address, so a shared link is never passed on with someone else's code in it.
 */
export async function captureInvite(): Promise<void> {
  if (!new URLSearchParams(location.search).has(INVITE_PARAM)) return;
  const code = inviteParam(location.search);
  const url = new URL(location.href);
  url.searchParams.delete(INVITE_PARAM);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  if (!code || pendingInvite() || readOwn().includes(code)) return;
  try {
    const { status, body } = await json<{ valid?: boolean; welcome?: boolean; vipDays?: number; unknown?: boolean }>(`/api/vs/invites/check?code=${code}`);
    // SoDEX did not answer the server: kept, and the join asks again.
    if (status === 200 && (body.valid || body.unknown)) {
      localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now(), welcome: body.welcome !== false, vipDays: body.vipDays ?? 0 }));
      changed();
    }
  } catch {
    /* no referral then */
  }
}

/* -------------------------------------------------------------------- per wallet ----- */

/** A wallet's own code: loading, its code, none (no SoDEX account yet), or SoDEX did not answer. */
export type OwnCode = { state: 'loading' } | { state: 'ok'; code: string } | { state: 'none' } | { state: 'error' };

const own = new Map<string, OwnCode>();
const mes = new Map<string, { me: InviteMe | null; error: boolean; absent?: boolean }>();
const asked = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let rev = 0;
function changed(): void { rev += 1; for (const l of [...listeners]) l(); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The wallet's SoDEX referral code, from SoDEX (public, no login). */
export function loadOwnCode(address: string): Promise<OwnCode> {
  const a = address.toLowerCase();
  const have = own.get(a);
  if (have && have.state !== 'loading' && have.state !== 'error') return Promise.resolve(have);
  const k = `c:${a}`;
  let p = asked.get(k) as Promise<OwnCode> | undefined;
  if (!p) {
    if (!have) own.set(a, { state: 'loading' });
    p = json<{ code?: number; data?: { referralCode?: unknown } }>(`${BIZ}/biz/referral/public/referralCode?walletAddress=${a}`).then(
      ({ status, body }) => {
        const c = typeof body.data?.referralCode === 'string' ? normCode(body.data.referralCode) : '';
        const out: OwnCode = status === 200 && body.code === 0 ? (CODE_RE.test(c) ? { state: 'ok', code: c } : { state: 'none' }) : { state: 'error' };
        if (out.state === 'ok') noteOwn(out.code);
        own.set(a, out);
        asked.delete(k);
        changed();
        return out;
      },
      () => { const out: OwnCode = { state: 'error' }; own.set(a, out); asked.delete(k); changed(); return out; },
    );
    asked.set(k, p);
  }
  return p;
}

export function useOwnCode(address: string | null): OwnCode {
  const a = address?.toLowerCase() ?? '';
  useSyncExternalStore(subscribe, () => rev, () => 0);
  useEffect(() => { if (a) void loadOwnCode(a); }, [a]);
  return a ? own.get(a) ?? { state: 'loading' } : { state: 'none' };
}

/** The code known already, asking nothing (a share card's link). */
export const knownCode = (address: string | null): string | null => {
  const c = address ? own.get(address.toLowerCase()) : undefined;
  return c?.state === 'ok' ? c.code : null;
};

/** The wallet's referrals and credits, read again on every call (the page asks on open and after a join). */
export async function loadMe(address: string): Promise<InviteMe | null> {
  const a = address.toLowerCase();
  try {
    const { status, body } = await json<InviteMe>(`/api/vs/invites/me?address=${a}`);
    // A server without referrals yet (a release behind): nothing is wrong, there is just nothing to read there.
    if (status === 404) {
      mes.set(a, { me: null, error: false, absent: true });
      changed();
      return null;
    }
    if (status !== 200 || !body.ok) throw new Error(String(status));
    mes.set(a, { me: body, error: false });
    changed();
    return body;
  } catch {
    mes.set(a, { me: mes.get(a)?.me ?? null, error: true });
    changed();
    return null;
  }
}

/**
 * The wallet's referrals and credits, whether the last read failed (no endless "reading"), and whether this server has
 * no referrals at all (`absent`: one a release behind).
 */
export function useInviteMeState(address: string | null): { me: InviteMe | null; error: boolean; loading: boolean; absent: boolean } {
  const a = address?.toLowerCase() ?? '';
  useSyncExternalStore(subscribe, () => rev, () => 0);
  useEffect(() => { if (a) void loadMe(a); }, [a]);
  const v = a ? mes.get(a) : undefined;
  return { me: v?.me ?? null, error: v?.error ?? false, loading: !!a && !v, absent: v?.absent ?? false };
}

export const useInviteMe = (address: string | null): InviteMe | null => useInviteMeState(address).me;

/** What is known of a wallet's join, asking nothing. */
export const knownJoin = (address: string | null): InviteMe['joined'] | undefined => (address ? mes.get(address.toLowerCase())?.me?.joined : undefined);

const nonce = (): string => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

/** Join with a code: the wallet's one free signature. */
export async function joinInvite(provider: Eip1193Provider, address: string, code: string): Promise<{ welcome: boolean; vipUntil: number | null }> {
  const chainId = await getChainId(provider).catch(() => 1);
  const t = Date.now();
  const fields: Omit<InviteJoin, 'signature'> = {
    wallet: address.toLowerCase(), code: normCode(code), statement: INVITE_STATEMENT, nonce: nonce(), issuedAt: String(t), expiresAt: String(t + INVITE_TTL_MS - 30_000), chainId,
  };
  const signature = await signTypedData(provider, address, inviteTypedData(fields));
  const { status, body } = await json<{ ok?: boolean; code?: string; error?: string; welcome?: boolean; vipUntil?: number | null }>('/api/vs/invites/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ join: { ...fields, signature } }),
  });
  if (status === 200 && body.ok) {
    void loadMe(address);
    return { welcome: body.welcome !== false, vipUntil: body.vipUntil ?? null };
  }
  throw new InviteError(body.error || `The link was not taken (${status}).`, body.code);
}

/** The pending invite's subscription (InviteHost re-reads it when it changes). */
export const useInviteRevision = (): number => useSyncExternalStore(subscribe, () => rev, () => 0);

/**
 * The SoDEX code a wallet is offered: the code of the referral link it came with (kept, or the one it joined with),
 * else ValueDesk's own. `ready`: the wallet's join is known (a VALUEDESK offer waits for it, so it never jumps ahead of
 * an inviter's code).
 */
export function useSodexCode(address: string | null): { code: string; theirs: boolean; ready: boolean } {
  const st = useInviteMeState(address);
  const c = pendingInvite()?.code ?? st.me?.joined?.code ?? null;
  return c ? { code: c, theirs: true, ready: true } : { code: OURS_CODE, theirs: false, ready: !st.loading };
}
