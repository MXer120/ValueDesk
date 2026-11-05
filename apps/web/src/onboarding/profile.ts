/**
 * A wallet's username from the server (apps/server/src/routes/profiles.ts), the claim the wallet
 * signs for one, and a small shared store so the flow and the address menu read the same answer.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { USERNAME_CLAIM_TTL_MS, USERNAME_STATEMENT, usernameTypedData, type UsernameClaim } from '@sign/profiles/claim';
import { getChainId, signTypedData, type Eip1193Provider } from '../wallet';

export interface ProfileAnswer {
  username: string | null;
  /** The server has seen this wallet trade through ValueDesk: a returning user. */
  known: boolean;
}

export class ProfileError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  const body = (await r.json().catch(() => ({}))) as T;
  return { status: r.status, body };
}

export async function fetchProfile(address: string): Promise<ProfileAnswer> {
  const { status, body } = await json<{ username?: string | null; known?: boolean; error?: string }>(`/api/vs/profile?address=${address}`);
  if (status !== 200) throw new ProfileError(body.error || `The profile service answered ${status}.`);
  return { username: body.username ?? null, known: body.known === true };
}

export interface NameCheck {
  available: boolean;
  reason: string | null;
}

export async function checkName(name: string, signal?: AbortSignal): Promise<NameCheck> {
  const { status, body } = await json<{ available?: boolean; reason?: string | null; error?: string }>(
    `/api/vs/username/check?name=${encodeURIComponent(name)}`,
    signal ? { signal } : undefined,
  );
  if (status !== 200) throw new ProfileError(body.error || `The check answered ${status}.`);
  return { available: body.available === true, reason: body.reason ?? null };
}

const nonce = (): string => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

/** One free signature (never a transaction), then the server takes the name for this wallet for good. */
export async function claimUsername(provider: Eip1193Provider, address: string, username: string): Promise<string> {
  const chainId = await getChainId(provider).catch(() => 1);
  const t = Date.now();
  const owner = address.toLowerCase();
  const fields: Omit<UsernameClaim, 'signature'> = {
    owner, username, statement: USERNAME_STATEMENT, nonce: nonce(), issuedAt: String(t), expiresAt: String(t + USERNAME_CLAIM_TTL_MS - 30_000), chainId,
  };
  const signature = await signTypedData(provider, address, usernameTypedData(fields));
  const { status, body } = await json<{ ok?: boolean; username?: string; code?: string; error?: string }>('/api/vs/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claim: { ...fields, signature } }),
  });
  if (status === 200 && body.username) {
    setKnownUsername(address, body.username);
    return body.username;
  }
  // This wallet took a name in another tab or browser: that one stands.
  if (body.code === 'has-name' && body.username) setKnownUsername(address, body.username);
  throw new ProfileError(body.error || `The username was not saved (${status}).`, body.code);
}

/* ------------------------------------------------- the shared answer, per wallet ----- */

const cache = new Map<string, string | null>();
const asked = new Map<string, Promise<ProfileAnswer>>();
const listeners = new Set<() => void>();
const changed = () => { for (const l of [...listeners]) l(); };

export function setKnownUsername(address: string, username: string): void {
  cache.set(address.toLowerCase(), username);
  changed();
}

/** The server's answer for this wallet; one request per wallet per page load. A failure is asked again later. */
export function loadProfile(address: string): Promise<ProfileAnswer> {
  const k = address.toLowerCase();
  let p = asked.get(k);
  if (!p) {
    p = fetchProfile(k).then(
      (a) => {
        cache.set(k, a.username);
        changed();
        return a;
      },
      (e) => {
        asked.delete(k);
        throw e;
      },
    );
    asked.set(k, p);
  }
  return p;
}

/** The wallet's username; undefined until the server has answered. */
export function useUsername(address: string | null): string | null | undefined {
  const k = address?.toLowerCase() ?? '';
  const v = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => (k ? cache.get(k) : null),
    () => null,
  );
  useEffect(() => {
    if (k) void loadProfile(k).catch(() => { /* the menu says nothing rather than guess */ });
  }, [k]);
  return v;
}
