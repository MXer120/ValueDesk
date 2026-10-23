/**
 * The executor's secrets and the followers' copy keys.
 *
 * KEY ENCRYPTION. Every follower key is sealed with AES-256-GCM under a
 * key-encryption key that lives in one file of its own (`kek`, 0600, created
 * on first start, never logged or sent anywhere). The sealed record binds the
 * network, the follower and the key's address as additional data, so a sealed
 * key cannot be moved onto another follower. A database copy without the kek
 * file holds nothing usable.
 *
 * SESSIONS. A follower reads their own copies with a token the executor
 * issues after one signed 'session' request: HMAC-SHA256 over the wallet and
 * the expiry, under a second secret file (`session.key`).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateTradingKey, privateKeyToAddress, signingKeyFrom, type SigningKeyRef } from '../../../packages/sodex-core/src/index.ts';

function secretFile(dir: string, name: string): Buffer {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not on every file system (Windows) */
  }
  const b = readFileSync(path);
  if (b.length !== 32) throw new Error(`${path} must hold exactly 32 bytes`);
  return b;
}

export class Secrets {
  private readonly kek: Buffer;
  private readonly sessionKey: Buffer;

  constructor(dir: string) {
    this.kek = secretFile(dir, 'kek');
    this.sessionKey = secretFile(dir, 'session.key');
  }

  /* ---------------------------------------------------------- keys ----- */

  /** A fresh secp256k1 key: its address, and its private key sealed. The plain key is wiped. */
  newKey(network: string, owner: string): { address: string; sealed: string } {
    const k = generateTradingKey((n) => new Uint8Array(randomBytes(n)));
    try {
      const address = k.address.toLowerCase();
      return { address, sealed: this.seal(network, owner, address, k.privateKey) };
    } finally {
      k.privateKey.fill(0);
    }
  }

  seal(network: string, owner: string, address: string, privateKey: Uint8Array): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.kek, iv);
    c.setAAD(aad(network, owner, address));
    const ct = Buffer.concat([c.update(privateKey), c.final()]);
    return ['v1', iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
  }

  /** The signing key for a sealed record. Throws when it does not open, or opens to another address. */
  open(network: string, owner: string, address: string, sealed: string, registration: { name: string; expiresAt: number | null }): SigningKeyRef {
    const [v, iv, ct, tag] = sealed.split('.');
    if (v !== 'v1' || !iv || !ct || !tag) throw new Error('sealed key: unknown format');
    const d = createDecipheriv('aes-256-gcm', this.kek, Buffer.from(iv, 'base64url'));
    d.setAAD(aad(network, owner, address));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const pk = new Uint8Array(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]));
    if (privateKeyToAddress(pk).toLowerCase() !== address.toLowerCase()) {
      pk.fill(0);
      throw new Error('sealed key: opens to another address');
    }
    return signingKeyFrom({ privateKey: pk, address }, { name: registration.name, expiresAt: registration.expiresAt ?? 0 });
  }

  /* ------------------------------------------------------ sessions ----- */

  issueSession(owner: string, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
    const expiresAt = now + ttlMs;
    const body = `${owner.toLowerCase()}.${expiresAt}`;
    return { token: `${body}.${this.mac(body)}`, expiresAt };
  }

  /** The wallet a token belongs to, or null (forged, expired, malformed). */
  readSession(token: string | undefined | null, now = Date.now()): string | null {
    if (!token) return null;
    const m = /^(0x[0-9a-f]{40})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token.trim());
    if (!m) return null;
    const body = `${m[1]}.${m[2]}`;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(m[3]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (Number(m[2]) <= now) return null;
    return m[1]!;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.sessionKey).update(body).digest('base64url');
  }
}

const aad = (network: string, owner: string, address: string): Buffer =>
  Buffer.from(`vd-copy-key:v1:${network}:${owner.toLowerCase()}:${address.toLowerCase()}`);
