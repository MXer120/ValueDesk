/**
 * Signed terms: the bytes, the key, the signature (docs/BUILDER-TIERS.md §3).
 *
 * The app charges a fee below its build's default only on the strength of a
 * statement this server signed for that wallet, that request and a short time.
 * The statement is nine lines of text; the app rebuilds them from the values
 * it is about to use and verifies the signature with a public key pinned in
 * its build. So nothing a user rewrites in a response can lower a fee: a
 * changed fee, address, nonce or time is a different message.
 *
 * WHAT IS SIGNED, exactly (UTF-8, joined by "\n", no trailing newline):
 *
 *   valuescan-builder-terms/1
 *   chain:286623
 *   builder:123456
 *   address:0x<40 lower-case hex>
 *   perps:15
 *   spot:20
 *   nonce:<16-64 of A-Z a-z 0-9 _ ->
 *   issued:1790000000000
 *   ttl:600000
 *
 * Every value is checked before it goes into a line (termsMessage), so no
 * input can carry a newline or a second "key:value" into the message.
 *
 * THE KEY is Ed25519, a PKCS#8 PEM file outside the repository (paths.ts). The
 * private key never leaves this module: nothing logs it, prints it or returns
 * it. `keyId` is the first 8 hex characters of SHA-256 of the raw public key,
 * so a build can pin several keys while one is being replaced.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FEE_CAP, silentLog, type LogLike } from './config.js';

export const TERMS_VERSION = 'valuescan-builder-terms/1';
/** How long terms are valid. The app caps what it accepts at 15 minutes. */
export const TERMS_TTL_MS = 600_000;

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface TermsFields {
  chain: number;
  builderId: number;
  /** Lower-case wallet address. */
  address: string;
  perps: number;
  spot: number;
  nonce: string;
  /** ms since the epoch, this server's clock. */
  issued: number;
  ttl: number;
}

const whole = (v: number, what: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) throw new RangeError(`terms: ${what} must be a whole number from 0 to ${max}`);
  return v;
};

/** The exact text that is signed. Throws on any value that does not belong in it. */
export function termsMessage(t: TermsFields): string {
  if (!/^0x[0-9a-f]{40}$/.test(t.address)) throw new RangeError('terms: address must be 0x and 40 lower-case hex characters');
  if (!NONCE_RE.test(t.nonce)) throw new RangeError('terms: nonce must be 16 to 64 characters of A-Z a-z 0-9 _ -');
  return [
    TERMS_VERSION,
    `chain:${whole(t.chain, 'chain')}`,
    `builder:${whole(t.builderId, 'builder')}`,
    `address:${t.address}`,
    `perps:${whole(t.perps, 'perps', FEE_CAP.perps)}`,
    `spot:${whole(t.spot, 'spot', FEE_CAP.spot)}`,
    `nonce:${t.nonce}`,
    `issued:${whole(t.issued, 'issued')}`,
    `ttl:${whole(t.ttl, 'ttl')}`,
  ].join('\n');
}

/** A loaded signing key. Holds the private key; exposes only what may be public. */
export class TermsSigner {
  /** base64url of the raw 32-byte public key: what `VITE_BUILDER_TERMS_KEYS` pins. */
  readonly publicKey: string;
  /** First 8 hex characters of SHA-256 of the raw public key. */
  readonly keyId: string;
  readonly #key: KeyObject;

  constructor(key: KeyObject) {
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('the terms key must be an Ed25519 private key');
    const x = createPublicKey(key).export({ format: 'jwk' }).x;
    if (typeof x !== 'string') throw new Error('the terms key has no public part');
    this.#key = key;
    this.publicKey = x;
    this.keyId = createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex').slice(0, 8);
  }

  /** base64url of the 64-byte Ed25519 signature over the UTF-8 bytes of `message`. */
  sign(message: string): string {
    return edSign(null, Buffer.from(message, 'utf8'), this.#key).toString('base64url');
  }
}

export const signerFromPem = (pem: string): TermsSigner => new TermsSigner(createPrivateKey(pem));

/** PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410): this prefix, then the 32 bytes. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A signer from a raw 32-byte seed. For fixed test vectors; a real key comes from a file. */
export function signerFromSeed(seed: Uint8Array): TermsSigner {
  if (seed.length !== 32) throw new RangeError('an Ed25519 seed is 32 bytes');
  return new TermsSigner(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: 'der', type: 'pkcs8' }));
}

/**
 * Create the key file. Never replaces one (`wx`): a build pins the public key,
 * and a new key would leave every user on the default fee until the next
 * release. The file is readable by its owner only, where the platform has
 * such a thing. The PEM text exists only between these lines.
 */
export function writeNewKeyFile(path: string): TermsSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* no-op on Windows */
  }
  return new TermsSigner(privateKey);
}

export interface KeyStatus {
  path: string;
  exists: boolean;
  /** Why an existing file is not in use (never its content). */
  problem: string | null;
  publicKey: string | null;
  keyId: string | null;
}

/**
 * The signing key in force, kept current with the file - so the key the tool
 * creates is picked up without a restart. No file: terms go out unsigned
 * (`sig: null`) and every app with pinned keys charges its default fee.
 */
export class KeySource {
  private signer: TermsSigner | null = null;
  private seen = '';
  private exists = false;
  private problem: string | null = null;

  constructor(readonly path: string, private readonly log: LogLike = silentLog) {}

  current(): TermsSigner | null {
    return this.signer;
  }

  status(): KeyStatus {
    return { path: this.path, exists: this.exists, problem: this.problem, publicKey: this.signer?.publicKey ?? null, keyId: this.signer?.keyId ?? null };
  }

  loadSync(): void {
    let stamp: string;
    try {
      const st = statSync(this.path);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.gone();
      return;
    }
    if (stamp === this.seen) return;
    let pem: string | null = null;
    try {
      pem = readFileSync(this.path, 'utf8');
    } catch {
      /* reported below */
    }
    this.take(stamp, pem);
  }

  async refresh(): Promise<void> {
    let stamp: string;
    try {
      const st = await stat(this.path);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.gone();
      return;
    }
    if (stamp === this.seen) return;
    let pem: string | null = null;
    try {
      pem = await readFile(this.path, 'utf8');
    } catch {
      /* reported below */
    }
    this.take(stamp, pem);
  }

  private gone(): void {
    if (this.signer) this.log.warn({ path: this.path }, 'builder terms: the signing key file is gone - terms go out unsigned and every app charges its default fee');
    this.signer = null;
    this.seen = '';
    this.exists = false;
    this.problem = null;
  }

  private take(stamp: string, pem: string | null): void {
    this.seen = stamp;
    this.exists = true;
    try {
      if (pem === null) throw new Error('the file cannot be read');
      this.signer = signerFromPem(pem);
      this.problem = null;
      this.log.info({ path: this.path, keyId: this.signer.keyId, publicKey: this.signer.publicKey }, 'builder terms: signing key loaded');
    } catch (e) {
      // A damaged key file is not replaced by an older key: unsigned terms are the safe answer.
      this.signer = null;
      // The reason only, never the file's text: an OpenSSL message does not quote its input.
      this.problem = e instanceof Error ? e.message.slice(0, 160) : 'not a usable key';
      this.log.error({ path: this.path, problem: this.problem }, 'builder terms: the signing key file is not a usable Ed25519 PKCS#8 PEM - terms go out unsigned');
    }
  }
}
