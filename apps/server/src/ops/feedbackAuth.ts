/**
 * Proof of a wallet for the feedback chat (routes/reports.ts POST
 * /api/vs/feedback/session). A chat kept on a wallet is read and written only
 * with that wallet's proof: the wallet signs a FeedbackSignIn once
 * (ops/feedbackSignIn.ts - free typed data, never a transaction), and this
 * server hands back a session token for FEEDBACK_SESSION_TTL_MS.
 *
 * THE SIGN-IN is checked here: the fixed statement, the owner, the time window,
 * and that the owner's key signed exactly those fields. Its nonce is accepted
 * once (feedbackThreads.ts nonces).
 *
 * THE TOKEN is `<owner>.<expiresAt>.<epoch>.<HMAC-SHA256>` under a key of its
 * own: `feedback-auth/session.key` beside feedback.db (0600; never logged).
 * Losing the key only means people sign once more.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
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

function secretFile(dir: string, name: string): Buffer {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not on every file system (Windows) */
  }
  const b = readFileSync(path);
  if (b.length !== 32) throw new Error(`${path} must hold exactly 32 bytes`);
  return b;
}

class SessionTokens {
  private readonly key: Buffer;

  constructor(dir: string) {
    this.key = secretFile(dir, 'session.key');
  }

  issue(owner: string, epoch: number, now: number, ttlMs: number): { token: string; expiresAt: number } {
    const expiresAt = now + ttlMs;
    const body = `${owner.toLowerCase()}.${expiresAt}.${epoch}`;
    return { token: `${body}.${this.mac(body)}`, expiresAt };
  }

  /** The wallet and epoch a token was issued for, or null (forged, expired, malformed). */
  read(token: string | null | undefined, now = Date.now()): { owner: string; epoch: number } | null {
    if (!token) return null;
    const m = /^(0x[0-9a-f]{40})\.(\d{13})\.(\d{1,9})\.([A-Za-z0-9_-]{43})$/.exec(token.trim());
    if (!m) return null;
    const body = `${m[1]}.${m[2]}.${m[3]}`;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(m[4]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (Number(m[2]) <= now) return null;
    return { owner: m[1]!, epoch: Number(m[3]) };
  }

  /** The label is kept from where this token began: another one would end every session handed out. */
  private mac(body: string): string {
    return createHmac('sha256', this.key).update(`vd-folders:v1:${body}`).digest('base64url');
  }
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
