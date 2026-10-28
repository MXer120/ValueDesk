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
 * KEY IMPORT. A follower may bring a SoDEX API key they made themselves (on
 * sodex.com) instead of registering one this executor made. Its private key
 * must not cross anything in between in the clear - the site's own proxy sees
 * every request body - so the browser encrypts it to this executor: ECDH on
 * P-256 with a one-time key of its own, HKDF-SHA256 bound to this executor and
 * the wallet, AES-256-GCM. The executor's half lives in `import.key` (0600).
 *
 * SESSIONS. A follower reads their own copies with a token the executor
 * issues after one signed 'session' request: HMAC-SHA256 over the wallet and
 * the expiry, under a second secret file (`session.key`).
 */
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';
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

/** The key-import key pair (P-256), made on first start. */
function importKeyFile(dir: string): KeyObject {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'import.key');
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not on every file system (Windows) */
  }
  return createPrivateKey(readFileSync(path));
}

/** What the browser sends: its one-time public key (SPKI, base64url), the IV and the ciphertext with its tag (base64url). */
export interface ImportEnvelope {
  epk: string;
  iv: string;
  ct: string;
}

export const KEY_IMPORT_ALG = 'ECDH-P256+HKDF-SHA256+A256GCM';

/** The HKDF info both sides use: this executor and this wallet, so an envelope cannot be replayed to another. */
export const importInfo = (executorId: string, owner: string): string => `vd-key-import:v1:${executorId}:${owner.toLowerCase()}`;

export class Secrets {
  private readonly kek: Buffer;
  private readonly sessionKey: Buffer;
  private readonly importKey: KeyObject;

  constructor(dir: string) {
    this.kek = secretFile(dir, 'kek');
    this.sessionKey = secretFile(dir, 'session.key');
    this.importKey = importKeyFile(dir);
  }

  /** The public half a browser encrypts an imported key to (SPKI DER, base64url). */
  importPublicKey(): string {
    return createPublicKey(this.importKey).export({ type: 'spki', format: 'der' }).toString('base64url');
  }

  /**
   * The private key inside an import envelope (32 bytes), or a throw: a wrong
   * executor or wallet, a tampered envelope, or not a key.
   */
  openImport(executorId: string, owner: string, e: ImportEnvelope): Uint8Array {
    const epk = createPublicKey({ key: Buffer.from(e.epk, 'base64url'), format: 'der', type: 'spki' });
    const shared = diffieHellman({ privateKey: this.importKey, publicKey: epk });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), importInfo(executorId, owner), 32));
    const raw = Buffer.from(e.ct, 'base64url');
    if (raw.length < 17) throw new Error('key import: the envelope is too short');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64url'));
    d.setAuthTag(raw.subarray(raw.length - 16));
    let pk: Uint8Array;
    try {
      pk = plainOf(d.update(raw.subarray(0, raw.length - 16)), () => d.final());
    } finally {
      shared.fill(0);
      key.fill(0);
    }
    if (pk.length !== 32) {
      pk.fill(0);
      throw new Error('key import: not a 32-byte private key');
    }
    return pk;
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
    return sealWith(this.kek, network, owner, address, privateKey);
  }

  /** The signing key for a sealed record. Throws when it does not open, or opens to another address. */
  open(network: string, owner: string, address: string, sealed: string, registration: { name: string; expiresAt: number | null }): SigningKeyRef {
    const pk = openWith(this.kek, network, owner, address, sealed);
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

/**
 * A decipher's output as one fresh array, every intermediate buffer zeroed:
 * Buffer.concat would leave the plain key in a pooled slab nobody wipes. A
 * failed authentication (`final` throws) wipes what `update` gave as well.
 */
function plainOf(head: Buffer, final: () => Buffer): Uint8Array {
  let tail: Buffer;
  try {
    tail = final();
  } catch (e) {
    head.fill(0);
    throw e;
  }
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  head.fill(0);
  tail.fill(0);
  return out;
}

const aad = (network: string, owner: string, address: string): Buffer =>
  Buffer.from(`vd-copy-key:v1:${network}:${owner.toLowerCase()}:${address.toLowerCase()}`);

/**
 * Seal a follower's private key under a kek (the `v1` record the keys table holds).
 * The class above and the kek rotation (tools/rotate-kek.ts) share it, so there is
 * one definition of the format.
 */
export function sealWith(kek: Buffer, network: string, owner: string, address: string, privateKey: Uint8Array): string {
  if (kek.length !== 32) throw new Error('a kek is 32 bytes');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(aad(network, owner, address));
  const ct = Buffer.concat([c.update(privateKey), c.final()]);
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
}

/**
 * The raw private key in a sealed record (the caller wipes it). Throws when it does not
 * open under this kek, or opens to another address.
 */
export function openWith(kek: Buffer, network: string, owner: string, address: string, sealed: string): Uint8Array {
  if (kek.length !== 32) throw new Error('a kek is 32 bytes');
  const [v, iv, ct, tag] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct || !tag) throw new Error('sealed key: unknown format');
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(iv, 'base64url'));
  d.setAAD(aad(network, owner, address));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  const pk = plainOf(d.update(Buffer.from(ct, 'base64url')), () => d.final());
  if (privateKeyToAddress(pk).toLowerCase() !== address.toLowerCase()) {
    pk.fill(0);
    throw new Error('sealed key: opens to another address');
  }
  return pk;
}
