/**
 * Proof of a wallet for the feedback chat (routes/reports.ts POST
 * /api/vs/feedback/session). A chat kept on a wallet is read and written only
 * with that wallet's proof: the wallet signs a FeedbackSignIn once
 * (ops/feedbackSignIn.ts - free typed data, never a transaction), and this
 * server hands back a session token for FEEDBACK_SESSION_TTL_MS.
 *
 * THE SIGN-IN is checked as the knowledge folders' is (folders/auth.ts): the
 * fixed statement, the owner, the time window, and that the owner's key signed
 * exactly those fields. Its nonce is accepted once (feedbackThreads.ts nonces).
 *
 * THE TOKEN is the folders' token (folders/auth.ts SessionTokens,
 * `<owner>.<expiresAt>.<epoch>.<HMAC>`) under a key of its own:
 * `feedback-auth/session.key` beside feedback.db (0600; never logged). A folders
 * token is no feedback token and the other way round - the keys differ. Losing
 * the key only means people sign once more.
 */
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
import { SessionTokens } from '../folders/auth.js';
import {
  FEEDBACK_SIGN_IN_DOMAIN, FEEDBACK_SIGN_IN_STATEMENTS, FEEDBACK_SIGN_IN_TTL_MS, FEEDBACK_SIGN_IN_TYPE, ZERO_ADDRESS, type FeedbackSignIn,
} from './feedbackSignIn.js';

export const FEEDBACK_SESSION_TTL_MS = 30 * 86_400_000;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{13}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TYPEHASH = keccak_256(utf8(FEEDBACK_SIGN_IN_TYPE));

function addressWord(a: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(a), 12);
  return out;
}

/** The EIP-712 digest of a feedback sign-in: what the wallet signed. */
export function feedbackSignInDigest(s: Omit<FeedbackSignIn, 'signature'>): Uint8Array {
  const struct = keccak_256(
    concat(TYPEHASH, addressWord(s.owner.toLowerCase()), keccak_256(utf8(s.statement)), keccak_256(utf8(s.nonce)), word(BigInt(s.issuedAt)), word(BigInt(s.expiresAt))),
  );
  const domain = domainSeparator({ name: FEEDBACK_SIGN_IN_DOMAIN.name, version: FEEDBACK_SIGN_IN_DOMAIN.version, chainId: s.chainId, verifyingContract: ZERO_ADDRESS });
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

export type FeedbackSignInCheck = { ok: true; owner: string; nonce: string; expiresAt: number } | { ok: false; error: string };

/** A sign-in's shape, statement, window and signature. Whether its nonce was used is the store's to say. */
export function checkFeedbackSignIn(raw: unknown, now = Date.now()): FeedbackSignInCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing sign-in' };
  const q = raw as Record<string, unknown>;
  const owner = typeof q.owner === 'string' ? q.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { ok: false, error: 'owner must be a 0x address' };
  if (typeof q.statement !== 'string' || !FEEDBACK_SIGN_IN_STATEMENTS.includes(q.statement)) return { ok: false, error: 'this is not the feedback sign-in; reload the page and sign again' };
  if (typeof q.nonce !== 'string' || !NONCE.test(q.nonce)) return { ok: false, error: 'nonce must be 32 hex characters' };
  if (typeof q.issuedAt !== 'string' || !STAMP.test(q.issuedAt)) return { ok: false, error: 'issuedAt must be a time in ms' };
  if (typeof q.expiresAt !== 'string' || !STAMP.test(q.expiresAt)) return { ok: false, error: 'expiresAt must be a time in ms' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !SIGNATURE.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const issuedAt = Number(q.issuedAt);
  const expiresAt = Number(q.expiresAt);
  if (expiresAt <= now) return { ok: false, error: 'this sign-in has expired; sign again' };
  if (expiresAt - issuedAt > FEEDBACK_SIGN_IN_TTL_MS || expiresAt <= issuedAt) return { ok: false, error: 'this sign-in is valid for longer than allowed' };
  if (issuedAt - now > 5 * 60_000) return { ok: false, error: 'the sign-in time is too far ahead; check your clock' };
  let signer: string;
  try {
    const digest = feedbackSignInDigest({ owner, statement: q.statement, nonce: q.nonce, issuedAt: q.issuedAt, expiresAt: q.expiresAt, chainId });
    signer = recoverAddress(digest, hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== owner) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, owner, nonce: q.nonce, expiresAt };
}

/** The session tokens, under their own key in `dir` (default: feedback-auth/ beside feedback.db). */
export class FeedbackSessions {
  private readonly tokens: SessionTokens;

  constructor(dir: string) {
    this.tokens = new SessionTokens(dir);
  }

  static beside(dbPath: string): FeedbackSessions {
    return new FeedbackSessions(join(dirname(dbPath), 'feedback-auth'));
  }

  issue(owner: string, now = Date.now()): { token: string; expiresAt: number } {
    return this.tokens.issue(owner, 0, now, FEEDBACK_SESSION_TTL_MS);
  }

  /** The wallet a token proves, or null (forged, expired, malformed, another key's). */
  read(token: string | null | undefined, now = Date.now()): string | null {
    const s = this.tokens.read(token, now);
    return s && s.epoch === 0 ? s.owner : null;
  }
}

/** The session token from an `Authorization: Bearer <token>` header, by its shape (not checked). */
export function sessionBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer (0x[0-9a-f]{40}\.\d{13}\.\d{1,9}\.[A-Za-z0-9_-]{43})$/.exec(header.trim());
  return m ? m[1]! : null;
}
