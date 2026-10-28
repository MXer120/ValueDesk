/**
 * The feedback chat kept on a wallet (apps/server ops/feedbackAuth.ts). The
 * connected wallet signs a FeedbackSignIn once - free typed data with a fixed
 * statement, never a transaction - and the server hands back a session token
 * for 30 days. Only with it does the wallet's one chat open - in any browser;
 * sending needs none. What this browser sent with no wallet connected (or kept
 * by token before 2026-10-28) joins the wallet's chat at the same time (`attach`).
 *
 * Kept in localStorage under the wallet's address with the replies already seen
 * and announced (the bell, FeedbackHost.tsx), like a thread (threads.ts).
 * Never in a URL; the server keeps only the key that checks it.
 */
import {
  FEEDBACK_SIGN_IN_STATEMENT,
  FEEDBACK_SIGN_IN_TTL_MS,
  feedbackSignInTypedData,
} from '@sign/ops/feedbackSignIn.js';
import { getChainId, isUserRejection, signTypedData, type Eip1193Provider } from '../wallet';
import { CHANGED_EVENT } from './threads';

const key = (owner: string) => `vs.feedback.session.v1:${owner.toLowerCase()}`;

export interface WalletSession {
  owner: string;
  token: string;
  expiresAt: number;
  seenOwner: number;
  notifiedOwner: number;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The session this browser holds for `owner`, while it has more than a minute left. */
export function heldSession(owner: string | null, now = Date.now()): WalletSession | null {
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return null;
  try {
    const raw = storage()?.getItem(key(owner));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<WalletSession>;
    if (typeof s.token !== 'string' || typeof s.expiresAt !== 'number' || s.expiresAt <= now + 60_000) return null;
    return { owner: owner.toLowerCase(), token: s.token, expiresAt: s.expiresAt, seenOwner: Number(s.seenOwner) || 0, notifiedOwner: Number(s.notifiedOwner) || 0 };
  } catch {
    return null;
  }
}

function save(s: WalletSession): void {
  try {
    storage()?.setItem(key(s.owner), JSON.stringify(s));
  } catch {
    /* private mode: a signature per page load */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

export function forgetSession(owner: string | null): void {
  if (!owner) return;
  try {
    storage()?.removeItem(key(owner));
  } catch {
    /* private mode */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

/** Keep a session the server handed out (exported for tests). */
export function keepSession(owner: string, token: string, expiresAt: number): WalletSession {
  const prev = heldSession(owner);
  const s = { owner: owner.toLowerCase(), token, expiresAt, seenOwner: prev?.seenOwner ?? 0, notifiedOwner: prev?.notifiedOwner ?? 0 };
  save(s);
  return s;
}

export function markSessionSeen(owner: string, count: number, o: { notifiedOnly?: boolean } = {}): void {
  const s = heldSession(owner);
  if (!s) return;
  save({ ...s, seenOwner: o.notifiedOnly ? s.seenOwner : Math.max(s.seenOwner, count), notifiedOwner: Math.max(s.notifiedOwner, count) });
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export type SignInResult =
  | { ok: true; session: WalletSession; attached: 'adopted' | 'merged' | 'same' | 'none' | 'other' }
  | { ok: false; error: string };

/**
 * One signature from the connected wallet for a session; `attach` (this
 * browser's thread token) keeps that chat on the wallet. Never throws.
 */
export async function signInFeedback(provider: Eip1193Provider, owner: string, attach: string | null, f: typeof fetch = fetch): Promise<SignInResult> {
  let signIn;
  try {
    const chainId = await getChainId(provider);
    const now = Date.now();
    const unsigned = {
      owner: owner.toLowerCase(),
      statement: FEEDBACK_SIGN_IN_STATEMENT,
      nonce: randomNonce(),
      issuedAt: String(now),
      expiresAt: String(now + FEEDBACK_SIGN_IN_TTL_MS),
      chainId,
    };
    signIn = { ...unsigned, signature: await signTypedData(provider, owner, feedbackSignInTypedData(unsigned)) };
  } catch (e) {
    if (isUserRejection(e)) return { ok: false, error: 'You did not sign - nothing changed.' };
    return { ok: false, error: e instanceof Error && e.message ? e.message : 'The wallet did not sign.' };
  }
  try {
    const res = await f('/api/vs/feedback/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ signIn, ...(attach ? { attach } : {}) }),
      credentials: 'omit',
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; token?: string; expiresAt?: number; attached?: string; error?: string } | null;
    if (!res.ok || !j?.ok || typeof j.token !== 'string' || typeof j.expiresAt !== 'number') {
      if (res.status === 429) return { ok: false, error: 'Too many sign-ins just now - please wait a few minutes.' };
      return { ok: false, error: j?.error ? `The sign-in was refused: ${j.error}.` : 'The sign-in did not work - please try again.' };
    }
    const attached = (['adopted', 'merged', 'same', 'none', 'other'] as const).find((a) => a === j.attached) ?? 'none';
    return { ok: true, session: keepSession(owner, j.token, j.expiresAt), attached };
  } catch {
    return { ok: false, error: 'The sign-in could not reach ValueDesk - check your connection.' };
  }
}
