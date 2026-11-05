/**
 * beta.valuedesk.so: the beta channel's API. A second API process (VALUESCAN_CHANNEL=beta) runs the
 * beta release on server 1; the beta site's Vercel function reaches it with `x-vs-channel: beta`
 * (Caddy picks the port). This file is its lock, and the lock is HERE, not in the page:
 *
 *   - every route but the health check, the beta sign-in and the live heatmap socket needs a beta
 *     token (header x-vs-beta, which the Vercel function takes from the site's vs_beta cookie);
 *   - a token is handed out only for a signed BetaSignIn (beta/signIn.ts) of a wallet on the beta
 *     list - the admin suite's Beta page (admin/store.ts beta_wallets) - and the list is read again
 *     on every request (cached BETA_LIST_TTL_MS), so a wallet taken off it is out within seconds,
 *     whatever token it still holds.
 *
 * THE TOKEN is `<owner>.<expiresAt>.<HMAC-SHA256>` under `beta-session.key` (32 bytes, 0600) in the
 * state directory - its own key, so a feedback token is never a beta one.
 *
 * On the main channel (no VALUESCAN_CHANNEL) none of this is installed.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
import { BETA_DOMAIN, BETA_SIGN_IN_STATEMENT, BETA_SIGN_IN_TTL_MS, BETA_SIGN_IN_TYPE, BETA_TOKEN_HEADER, BETA_ZERO_ADDRESS, type BetaSignIn } from './signIn.js';

export type Channel = 'main' | 'beta';
/** VALUESCAN_CHANNEL: `beta` for the beta API, anything else (or nothing) is the main one. */
export const channelFrom = (env: NodeJS.ProcessEnv): Channel => (env.VALUESCAN_CHANNEL?.trim().toLowerCase() === 'beta' ? 'beta' : 'main');

export const BETA_TOKEN_TTL_MS = 7 * 86_400_000;
export const BETA_LIST_TTL_MS = 10_000;
/** Paths the beta API answers without a token. */
export const BETA_OPEN_PATHS: ReadonlySet<string> = new Set(['/api/health', '/api/beta/session', '/api/beta/me', '/ws/liq']);

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{13}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TYPEHASH = keccak_256(utf8(BETA_SIGN_IN_TYPE));

function addressWord(a: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(a), 12);
  return out;
}

/** The EIP-712 digest of a beta sign-in: what the wallet signed. */
export function betaSignInDigest(s: Omit<BetaSignIn, 'signature'>): Uint8Array {
  const struct = keccak_256(concat(
    TYPEHASH,
    addressWord(s.owner.toLowerCase()),
    keccak_256(utf8(s.statement)),
    keccak_256(utf8(s.nonce)),
    word(BigInt(s.issuedAt)),
    word(BigInt(s.expiresAt)),
  ));
  const domain = domainSeparator({ name: BETA_DOMAIN.name, version: BETA_DOMAIN.version, chainId: s.chainId, verifyingContract: BETA_ZERO_ADDRESS });
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

export type BetaSignInCheck = { ok: true; owner: string; nonce: string; expiresAt: number } | { ok: false; error: string };

/** A sign-in's shape, statement, window and signature. Whether its nonce was used before is the caller's to say. */
export function checkBetaSignIn(raw: unknown, now = Date.now()): BetaSignInCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing sign-in' };
  const q = raw as Record<string, unknown>;
  const owner = typeof q.owner === 'string' ? q.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { ok: false, error: 'owner must be a 0x address' };
  if (q.statement !== BETA_SIGN_IN_STATEMENT) return { ok: false, error: 'this is not the beta sign-in; reload the page and sign again' };
  if (typeof q.nonce !== 'string' || !NONCE.test(q.nonce)) return { ok: false, error: 'nonce must be 32 hex characters' };
  if (typeof q.issuedAt !== 'string' || !STAMP.test(q.issuedAt)) return { ok: false, error: 'issuedAt must be a time in ms' };
  if (typeof q.expiresAt !== 'string' || !STAMP.test(q.expiresAt)) return { ok: false, error: 'expiresAt must be a time in ms' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !SIGNATURE.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const issuedAt = Number(q.issuedAt);
  const expiresAt = Number(q.expiresAt);
  if (expiresAt <= now) return { ok: false, error: 'this sign-in has expired; sign again' };
  if (expiresAt - issuedAt > BETA_SIGN_IN_TTL_MS || expiresAt <= issuedAt) return { ok: false, error: 'this sign-in is valid for longer than allowed' };
  if (issuedAt - now > 5 * 60_000) return { ok: false, error: 'the sign-in time is too far ahead; check your clock' };
  let signer: string;
  try {
    const digest = betaSignInDigest({ owner, statement: BETA_SIGN_IN_STATEMENT, nonce: q.nonce, issuedAt: q.issuedAt, expiresAt: q.expiresAt, chainId });
    signer = recoverAddress(digest, hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== owner) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, owner, nonce: q.nonce, expiresAt };
}

function keyFile(dir: string, name: string): Buffer {
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

export class BetaTokens {
  private readonly key: Buffer;

  constructor(dir: string) {
    this.key = keyFile(dir, 'beta-session.key');
  }

  issue(owner: string, now = Date.now(), ttlMs = BETA_TOKEN_TTL_MS): { token: string; expiresAt: number } {
    const expiresAt = now + ttlMs;
    const body = `${owner.toLowerCase()}.${expiresAt}`;
    return { token: `${body}.${this.mac(body)}`, expiresAt };
  }

  /** The wallet a token was issued for, or null (forged, expired, malformed). */
  read(token: string | string[] | null | undefined, now = Date.now()): string | null {
    const t = Array.isArray(token) ? token[0] : token;
    if (!t) return null;
    const m = /^(0x[0-9a-f]{40})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(t.trim());
    if (!m) return null;
    const want = Buffer.from(this.mac(`${m[1]}.${m[2]}`));
    const got = Buffer.from(m[3]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (Number(m[2]) <= now) return null;
    return m[1]!;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(`vd-beta:v1:${body}`).digest('base64url');
  }
}

/** The beta list, read at most every BETA_LIST_TTL_MS (a failed read keeps the last good one; none yet: nobody). */
export class BetaList {
  private cached: Set<string> = new Set();
  private at = -Infinity;

  constructor(private readonly read: () => readonly string[], private readonly ttlMs = BETA_LIST_TTL_MS) {}

  has(wallet: string, now = Date.now()): boolean {
    if (now - this.at >= this.ttlMs) {
      try {
        this.cached = new Set(this.read().map((a) => a.toLowerCase()));
      } catch {
        /* keep the last good list */
      }
      this.at = now;
    }
    return this.cached.has(wallet.toLowerCase());
  }
}

export interface BetaGateOptions {
  tokens: BetaTokens;
  list: BetaList;
  now?: () => number;
}

/** The beta API's lock: an onRequest hook after the hosted gate (index.ts installs it on the beta channel only). */
export function installBetaGate(app: FastifyInstance, o: BetaGateOptions): void {
  const now = o.now ?? Date.now;
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const path = req.routeOptions?.url ?? req.url.split('?')[0] ?? '';
    if (BETA_OPEN_PATHS.has(path)) return;
    const wallet = o.tokens.read(req.headers[BETA_TOKEN_HEADER], now());
    if (!wallet) return reply.code(401).send({ error: 'sign in to the beta first', code: 'beta', source: 'server' });
    if (!o.list.has(wallet, now())) return reply.code(403).send({ error: 'this wallet is not on the beta list', code: 'beta-list', source: 'server' });
  });
}
