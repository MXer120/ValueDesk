/**
 * Who may read and change a wallet's folders: the wallet itself, proven once
 * per browser with a signed FoldersSignIn (types.ts) - free typed data, never a
 * transaction - for which this server hands out a session token.
 *
 * THE SIGN-IN is checked here: the fixed statement, the owner, a nonce of the
 * browser's (accepted once: the store keeps it until the sign-in expires), its
 * time window (made within the last SIGN_IN_TTL_MS, valid no longer than that),
 * and that the owner's key signed exactly those fields.
 *
 * THE TOKEN is `<owner>.<expiresAt>.<epoch>.<HMAC-SHA256>` under a secret file
 * of its own (`session.key`, 0600, in the folders' directory; never logged,
 * never in a backup). `epoch` is the wallet's: deleting everything raises it,
 * which ends every token handed out before - on every device.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
import { SIGN_IN_DOMAIN, SIGN_IN_STATEMENT, SIGN_IN_TTL_MS, SIGN_IN_TYPE, ZERO_ADDRESS, type SignIn } from './types.js';

export const SESSION_TTL_MS = 7 * 86_400_000;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{13}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

const TYPEHASH = keccak_256(utf8(SIGN_IN_TYPE));

function addressWord(a: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(a), 12);
  return out;
}

/** The EIP-712 digest of a sign-in: what the wallet signed. */
export function signInDigest(s: Omit<SignIn, 'signature'>): Uint8Array {
  const struct = keccak_256(
    concat(
      TYPEHASH,
      addressWord(s.owner.toLowerCase()),
      keccak_256(utf8(s.statement)),
      keccak_256(utf8(s.nonce)),
      word(BigInt(s.issuedAt)),
      word(BigInt(s.expiresAt)),
    ),
  );
  const domain = domainSeparator({ name: SIGN_IN_DOMAIN.name, version: SIGN_IN_DOMAIN.version, chainId: s.chainId, verifyingContract: ZERO_ADDRESS });
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

export type SignInCheck = { ok: true; owner: string; nonce: string; expiresAt: number } | { ok: false; error: string };

/**
 * Check a sign-in's shape, statement, window and signature. Whether its nonce
 * was used before is the store's to say (it keeps them).
 */
export function checkSignIn(raw: unknown, now = Date.now()): SignInCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing sign-in' };
  const q = raw as Record<string, unknown>;
  const owner = typeof q.owner === 'string' ? q.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { ok: false, error: 'owner must be a 0x address' };
  if (q.statement !== SIGN_IN_STATEMENT) return { ok: false, error: 'this is not the folders sign-in; reload the page and sign again' };
  if (typeof q.nonce !== 'string' || !NONCE.test(q.nonce)) return { ok: false, error: 'nonce must be 32 hex characters' };
  if (typeof q.issuedAt !== 'string' || !STAMP.test(q.issuedAt)) return { ok: false, error: 'issuedAt must be a time in ms' };
  if (typeof q.expiresAt !== 'string' || !STAMP.test(q.expiresAt)) return { ok: false, error: 'expiresAt must be a time in ms' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !SIGNATURE.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const issuedAt = Number(q.issuedAt);
  const expiresAt = Number(q.expiresAt);
  if (expiresAt <= now) return { ok: false, error: 'this sign-in has expired; sign again' };
  if (expiresAt - issuedAt > SIGN_IN_TTL_MS || expiresAt <= issuedAt) return { ok: false, error: 'this sign-in is valid for longer than allowed' };
  if (issuedAt - now > 5 * 60_000) return { ok: false, error: 'the sign-in time is too far ahead; check your clock' };
  let signer: string;
  try {
    const digest = signInDigest({ owner, statement: SIGN_IN_STATEMENT, nonce: q.nonce, issuedAt: q.issuedAt, expiresAt: q.expiresAt, chainId });
    signer = recoverAddress(digest, hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== owner) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, owner, nonce: q.nonce, expiresAt };
}

/* ------------------------------------------------------------- tokens ----- */

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

export class SessionTokens {
  private readonly key: Buffer;

  constructor(dir: string) {
    this.key = secretFile(dir, 'session.key');
  }

  issue(owner: string, epoch: number, now = Date.now(), ttlMs = SESSION_TTL_MS): { token: string; expiresAt: number } {
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

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(`vd-folders:v1:${body}`).digest('base64url');
  }
}
