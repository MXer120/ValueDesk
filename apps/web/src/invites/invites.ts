/**
 * Invites and fee credits in the browser (the rules: @sign/invites/claim, the server: routes/invites.ts).
 *
 *   ?i=<code>   a visitor who came on an invite link: the code is checked with the server, kept in this browser and
 *               taken off the address bar; once the wallet has accepted the site's terms it is offered to join
 *               (InviteHost), one signature, and only while the server says the wallet may still join.
 *   the code    a wallet's own invite code (made by the server on first ask) and its link.
 *   me          a wallet's join, welcome, credits and invitees (the Savings page).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { CODE_RE, INVITE_PARAM, INVITE_STATEMENT, INVITE_TTL_MS, inviteTypedData, type InviteJoin, type InviteMe } from '@sign/invites/claim';
import { getChainId, signTypedData, type Eip1193Provider } from '../wallet';

export const SITE = 'https://valuedesk.so';
const KEY = 'vd.invite';
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

/** A link with an invite code on it (?i=<code>), its other parameters kept: a share card's. */
export function withInvite(link: string, code: string): string {
  const u = new URL(link);
  u.searchParams.set(INVITE_PARAM, code);
  return u.toString();
}

export const inviteLink = (code: string, path = '/'): string => `${SITE}${path}${path.includes('?') ? '&' : '?'}${INVITE_PARAM}=${code}`;

/** The invite this browser came with, if any (and not older than KEEP_MS). */
export function pendingInvite(now = Date.now()): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { code?: string; at?: number } | null;
    return v?.code && CODE_RE.test(v.code) && now - Number(v.at ?? 0) < KEEP_MS ? v.code : null;
  } catch {
    return null;
  }
}

export function dropInvite(): void {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** The code in an address's query, or null. Pure. */
export function inviteParam(search: string): string | null {
  const c = new URLSearchParams(search).get(INVITE_PARAM)?.trim().toLowerCase() ?? '';
  return CODE_RE.test(c) ? c : null;
}

/**
 * On load: a code in the address bar is checked, kept (a first one only: an invite this browser holds already
 * stands) and taken off the address, so a shared link is never passed on with someone else's code in it.
 */
export async function captureInvite(): Promise<void> {
  const code = inviteParam(location.search);
  if (!new URLSearchParams(location.search).has(INVITE_PARAM)) return;
  const url = new URL(location.href);
  url.searchParams.delete(INVITE_PARAM);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  if (!code || pendingInvite()) return;
  try {
    const { status, body } = await json<{ valid?: boolean }>(`/api/vs/invites/check?code=${code}`);
    if (status === 200 && body.valid) localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    /* no invite then */
  }
}

/* ----------------------------------------------------------------- per wallet ----- */

const codes = new Map<string, string>();
const mes = new Map<string, InviteMe>();
const asked = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let rev = 0;
const changed = () => { rev += 1; for (const l of [...listeners]) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The wallet's invite code (made by the server the first time). */
export function loadCode(address: string): Promise<string | null> {
  const a = address.toLowerCase();
  const have = codes.get(a);
  if (have) return Promise.resolve(have);
  const k = `c:${a}`;
  let p = asked.get(k) as Promise<string | null> | undefined;
  if (!p) {
    p = json<{ code?: string }>(`/api/vs/invites/code?address=${a}`).then(
      ({ status, body }) => {
        if (status === 200 && body.code) { codes.set(a, body.code); changed(); return body.code; }
        asked.delete(k);
        return null;
      },
      () => { asked.delete(k); return null; },
    );
    asked.set(k, p);
  }
  return p;
}

/** The wallet's invites and credits, read again on every call (the page asks on open and after a join). */
export async function loadMe(address: string): Promise<InviteMe | null> {
  const a = address.toLowerCase();
  try {
    const { status, body } = await json<InviteMe>(`/api/vs/invites/me?address=${a}`);
    if (status !== 200 || !body.ok) return null;
    mes.set(a, body);
    if (body.code) codes.set(a, body.code);
    changed();
    return body;
  } catch {
    return null;
  }
}

export function useInviteCode(address: string | null): string | null {
  const a = address?.toLowerCase() ?? '';
  useSyncExternalStore(subscribe, () => rev, () => 0);
  useEffect(() => { if (a) void loadCode(a); }, [a]);
  return a ? codes.get(a) ?? null : null;
}

/** The code known already, asking nothing (a share card's link). */
export const knownCode = (address: string | null): string | null => (address ? codes.get(address.toLowerCase()) ?? null : null);

export function useInviteMe(address: string | null): InviteMe | null {
  const a = address?.toLowerCase() ?? '';
  useSyncExternalStore(subscribe, () => rev, () => 0);
  useEffect(() => { if (a) void loadMe(a); }, [a]);
  return a ? mes.get(a) ?? null : null;
}

const nonce = (): string => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

/** Join with a code: the wallet's one free signature. */
export async function joinInvite(provider: Eip1193Provider, address: string, code: string): Promise<void> {
  const chainId = await getChainId(provider).catch(() => 1);
  const t = Date.now();
  const fields: Omit<InviteJoin, 'signature'> = {
    wallet: address.toLowerCase(), code, statement: INVITE_STATEMENT, nonce: nonce(), issuedAt: String(t), expiresAt: String(t + INVITE_TTL_MS - 30_000), chainId,
  };
  const signature = await signTypedData(provider, address, inviteTypedData(fields));
  const { status, body } = await json<{ ok?: boolean; code?: string; error?: string }>('/api/vs/invites/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ join: { ...fields, signature } }),
  });
  if (status === 200 && body.ok) {
    dropInvite();
    void loadMe(address);
    return;
  }
  throw new InviteError(body.error || `The invite was not taken (${status}).`, body.code);
}
