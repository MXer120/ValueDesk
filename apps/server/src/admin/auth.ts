/**
 * Who may open the admin suite, and how that is proven (routes/admin.ts).
 *
 * THE WALLET. Only the admin wallets (VALUESCAN_ADMIN_WALLETS, a comma list; by
 * default ValueDesk's SoDEX builder wallet, account 234812) - and each sign-in
 * is that wallet's own EIP-712 signature (admin/signIn.ts), checked here the way
 * the feedback chat's is (ops/feedbackAuth.ts): fixed statement, time window,
 * the recovered signer. Its nonce is accepted once (admin/store.ts).
 *
 * THE PASSWORD, as a second factor. Checked ONLY after a valid signature of an
 * admin wallet, so nobody without the builder key gets to guess it - or can
 * lock the owner out by guessing. Kept as a scrypt hash (node:crypto; N=2^17,
 * r=8, p=1, a 16-byte salt, 64 bytes) in one file the API's user alone may read
 * (`admin-auth/password` beside the other state, 0600). The owner sets it on
 * the server with tools/admin-password.ts, which reads it from the terminal
 * without echo: it is never in the repo, an argument, the environment, a URL or
 * a log. Without that file the whole suite answers 404 (routes/admin.ts).
 *
 * A WRITE needs a fresh AdminAction signed by the session's wallet, naming the
 * action and target the route expects and the hash of the exact payload.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
import { dataDir } from '../builder/paths.js';
import {
  ADMIN_ACTION_TYPE, ADMIN_DOMAIN, ADMIN_SIGNATURE_TTL_MS, ADMIN_SIGN_IN_STATEMENT, ADMIN_SIGN_IN_TYPE, ZERO_ADDRESS,
  adminPayloadHash, type AdminAction, type AdminActionName, type AdminSignIn,
} from './signIn.js';

/** ValueDesk's SoDEX builder wallet (account 234812, since 2026-10-28). */
export const BUILDER_WALLET = '0x1e4373480d82e1176342fa4a1a23a96211cf1dde';
/** A session lasts this long from its sign-in, however it is used (owner, 2026-10-31: "24h access after login"). */
export const ADMIN_SESSION_TTL_MS = 24 * 3_600_000;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{13}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const HASH = /^0x[0-9a-f]{64}$/;

/** VALUESCAN_ADMIN_WALLETS -> the admin wallets, lower case. Unset: the builder wallet. A malformed entry stops the boot. */
export function adminWalletsFrom(raw: string | undefined): string[] {
  const v = (raw ?? '').trim();
  if (!v) return [BUILDER_WALLET];
  const list = v.split(',').map((s) => s.trim().toLowerCase());
  for (const a of list) if (!ADDRESS.test(a)) throw new Error('VALUESCAN_ADMIN_WALLETS must be a comma list of 0x addresses');
  return [...new Set(list)];
}

/** VALUESCAN_ADMIN_ORIGINS -> the origins the suite is served from. Unset: https://dev.valuedesk.so. */
export function adminOriginsFrom(raw: string | undefined): string[] {
  const v = (raw ?? '').trim();
  const list = v ? v.split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()) : ['https://dev.valuedesk.so'];
  for (const o of list) if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(o)) throw new Error(`VALUESCAN_ADMIN_ORIGINS: "${o}" is not a bare origin`);
  return list;
}

// --- the signatures --------------------------------------------------------------------

function addressWord(a: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(a), 12);
  return out;
}
const str = (s: string): Uint8Array => keccak_256(utf8(s));
const domainOf = (chainId: number): Uint8Array =>
  domainSeparator({ name: ADMIN_DOMAIN.name, version: ADMIN_DOMAIN.version, chainId, verifyingContract: ZERO_ADDRESS });
const digestOf = (chainId: number, struct: Uint8Array): Uint8Array => keccak_256(concat(new Uint8Array([0x19, 0x01]), domainOf(chainId), struct));

export function adminSignInDigest(s: Omit<AdminSignIn, 'signature'>): Uint8Array {
  const struct = keccak_256(concat(
    keccak_256(utf8(ADMIN_SIGN_IN_TYPE)), addressWord(s.owner.toLowerCase()), str(s.statement), str(s.nonce), word(BigInt(s.issuedAt)), word(BigInt(s.expiresAt)),
  ));
  return digestOf(s.chainId, struct);
}

export function adminActionDigest(a: Omit<AdminAction, 'signature'>): Uint8Array {
  const struct = keccak_256(concat(
    keccak_256(utf8(ADMIN_ACTION_TYPE)), addressWord(a.owner.toLowerCase()), str(a.action), str(a.target), str(a.summary), hexToBytes(a.payload),
    str(a.nonce), word(BigInt(a.issuedAt)), word(BigInt(a.expiresAt)),
  ));
  return digestOf(a.chainId, struct);
}

type Window = { ok: true; issuedAt: number; expiresAt: number } | { ok: false; error: string };
type Fields = Record<string, unknown>;

/** The fields every signed message shares: nonce, time window, chain id, signature. */
function common(q: Fields, now: number): Window {
  if (typeof q.nonce !== 'string' || !NONCE.test(q.nonce)) return { ok: false, error: 'nonce must be 32 hex characters' };
  if (typeof q.issuedAt !== 'string' || !STAMP.test(q.issuedAt)) return { ok: false, error: 'issuedAt must be a time in ms' };
  if (typeof q.expiresAt !== 'string' || !STAMP.test(q.expiresAt)) return { ok: false, error: 'expiresAt must be a time in ms' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !SIGNATURE.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const issuedAt = Number(q.issuedAt);
  const expiresAt = Number(q.expiresAt);
  if (expiresAt <= now) return { ok: false, error: 'this signature has expired; sign again' };
  if (expiresAt <= issuedAt || expiresAt - issuedAt > ADMIN_SIGNATURE_TTL_MS) return { ok: false, error: 'this signature is valid for longer than allowed' };
  if (issuedAt - now > 60_000) return { ok: false, error: 'the signature time is ahead of the server; check your clock' };
  return { ok: true, issuedAt, expiresAt };
}

function signerOf(digest: () => Uint8Array, signature: string): string | null {
  try {
    return recoverAddress(digest(), hexToBytes(signature)).toLowerCase();
  } catch {
    return null;
  }
}

export type SignInCheck = { ok: true; owner: string; nonce: string; expiresAt: number } | { ok: false; error: string };

/** A sign-in's shape, statement, window and signer - which must be one of `admins`. The nonce is the store's. */
export function checkAdminSignIn(raw: unknown, admins: readonly string[], now = Date.now()): SignInCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing sign-in' };
  const q = raw as Fields;
  const owner = typeof q.owner === 'string' ? q.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { ok: false, error: 'owner must be a 0x address' };
  if (q.statement !== ADMIN_SIGN_IN_STATEMENT) return { ok: false, error: 'this is not the admin sign-in; reload the page and sign again' };
  const w = common(q, now);
  if (!w.ok) return w;
  const signer = signerOf(() => adminSignInDigest({
    owner, statement: ADMIN_SIGN_IN_STATEMENT, nonce: q.nonce as string, issuedAt: q.issuedAt as string, expiresAt: q.expiresAt as string, chainId: Number(q.chainId),
  }), q.signature as string);
  if (signer === null) return { ok: false, error: 'the signature cannot be read' };
  if (signer !== owner) return { ok: false, error: 'the signature is not from this wallet' };
  if (!admins.includes(owner)) return { ok: false, error: 'this wallet has no access' };
  return { ok: true, owner, nonce: q.nonce as string, expiresAt: w.expiresAt };
}

export type ActionCheck = { ok: true; nonce: string; expiresAt: number } | { ok: false; error: string };

/**
 * One write's signature: signed by `wallet` (the session's), for exactly `action`
 * on `target`, over exactly `payload`. Anything else - another wallet, action,
 * target or payload, a stale or long-lived signature - is refused.
 */
export function checkAdminAction(
  raw: unknown, want: { wallet: string; action: AdminActionName; target: string; payload: unknown }, now = Date.now(),
): ActionCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'this change needs your wallet signature' };
  const q = raw as Fields;
  if (typeof q.owner !== 'string' || q.owner.toLowerCase() !== want.wallet) return { ok: false, error: 'the signature must come from the signed-in wallet' };
  if (q.action !== want.action) return { ok: false, error: 'the signature is for another action' };
  if (q.target !== want.target) return { ok: false, error: 'the signature is for another target' };
  if (typeof q.summary !== 'string' || q.summary.length > 400) return { ok: false, error: 'summary must be a short text' };
  if (typeof q.payload !== 'string' || !HASH.test(q.payload)) return { ok: false, error: 'payload must be a 32-byte hash' };
  if (q.payload !== adminPayloadHash(want.payload)) return { ok: false, error: 'the signature does not cover this content; sign again' };
  const w = common(q, now);
  if (!w.ok) return w;
  const signer = signerOf(() => adminActionDigest({
    owner: want.wallet, action: want.action, target: want.target, summary: q.summary as string, payload: q.payload as string,
    nonce: q.nonce as string, issuedAt: q.issuedAt as string, expiresAt: q.expiresAt as string, chainId: Number(q.chainId),
  }), q.signature as string);
  if (signer !== want.wallet) return { ok: false, error: 'the signature is not from the signed-in wallet' };
  return { ok: true, nonce: q.nonce as string, expiresAt: w.expiresAt };
}

// --- the password -------------------------------------------------------------------------

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 } as const;
const FORMAT = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;

export const adminPasswordPath = (): string => process.env.VALUESCAN_ADMIN_PASSWORD_FILE?.trim() || join(dataDir(), 'admin-auth', 'password');

function derive(password: string, salt: Buffer, o: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, SCRYPT.keylen, { N: o.N, r: o.r, p: o.p, maxmem: SCRYPT.maxmem }, (e, key) => (e ? reject(e) : resolve(key)));
  });
}

/** The stored form: scrypt$log2N$r$p$salt$hash (base64url). */
export async function hashPassword(password: string, o: { logN?: number } = {}): Promise<string> {
  if (password.length < PASSWORD_MIN) throw new Error(`the password must be at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) throw new Error(`the password must be at most ${PASSWORD_MAX} characters`);
  const logN = o.logN ?? 17;
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N: 2 ** logN, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${logN}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Whether `password` is the one `stored` was made from. Constant-time on the hash; false for anything malformed. */
export async function verifyPassword(password: unknown, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || !password || password.length > PASSWORD_MAX) return false;
  const m = FORMAT.exec(stored.trim());
  if (!m) return false;
  const [logN, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (logN < 10 || logN > 20 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const want = Buffer.from(m[5]!, 'base64url');
  const got = await derive(password, Buffer.from(m[4]!, 'base64url'), { N: 2 ** logN, r, p });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The stored hash, or null when no password is set (the suite is then off). Read on every sign-in: a new one counts at once. */
export function readPasswordHash(path = adminPasswordPath()): string | null {
  try {
    const s = readFileSync(path, 'utf8').trim();
    return FORMAT.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** Whether a password is set - the suite is on. Cheap enough for every request (one stat). */
export function passwordIsSet(path = adminPasswordPath()): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** Write a new hash in place of the old one (0600, written beside and renamed). */
export function writePasswordHash(hash: string, path = adminPasswordPath()): void {
  if (!FORMAT.test(hash)) throw new Error('not a password hash');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.new`;
  writeFileSync(tmp, `${hash}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* not on every file system (Windows) */
  }
  renameSync(tmp, path);
}

// --- the session token -----------------------------------------------------------------------

/** A session token: "vda_" and 32 random bytes, base64url. Only its SHA-256 is kept (admin/store.ts). */
export const newSessionToken = (): string => `vda_${randomBytes(32).toString('base64url')}`;

/** The token from an `Authorization: Bearer vda_…` header, by its shape (not checked). */
export function adminBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer (vda_[A-Za-z0-9_-]{43})$/.exec(header.trim());
  return m ? m[1]! : null;
}
