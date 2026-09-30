/**
 * Trading-key lifecycle helpers: generation, naming and expiry.
 *
 * The browser trading key is a fresh secp256k1 key generated in the tab, held
 * in memory only, registered as an ORDINARY SoDEX API key (see permissions.ts)
 * with a SHORT expiry, and never serialised. Nothing here touches storage.
 */
import { secp256k1 } from '@noble/curves/secp256k1';

import { bytesToHex, hexToBytes, privateKeyToAddress, type Hex } from './eip712.ts';

/**
 * A signing key held in memory. `privateKey` is NON-ENUMERABLE, so
 * JSON.stringify, object spread and structured logging of the object skip it.
 * It is still reachable by property access - this is a guard against
 * accidents, not an access control.
 */
export interface TradingKey {
  /** The EVM address registered as the API key's `publicKey`. Lower-case. */
  readonly address: Hex;
  /** 32 raw bytes. Non-enumerable. Call `destroyTradingKey` when done. */
  readonly privateKey: Uint8Array;
}

type RandomSource = (length: number) => Uint8Array;

function defaultRandom(length: number): Uint8Array {
  const c = (globalThis as unknown as { crypto?: { getRandomValues?: <T extends Uint8Array>(a: T) => T } }).crypto;
  if (!c?.getRandomValues) throw new Error('no CSPRNG available (globalThis.crypto.getRandomValues)');
  return c.getRandomValues(new Uint8Array(length));
}

function wrap(privateKey: Uint8Array): TradingKey {
  const key = { address: privateKeyToAddress(privateKey) } as { address: Hex; privateKey: Uint8Array };
  Object.defineProperty(key, 'privateKey', { value: privateKey, enumerable: false, writable: false });
  Object.defineProperty(key, 'toJSON', { value: () => ({ address: key.address }), enumerable: false });
  return Object.freeze(key);
}

/**
 * Generate a random secp256k1 key and its EVM address.
 *
 * Uses the platform CSPRNG (`crypto.getRandomValues`). `random` is injectable
 * for tests only. Retries the (astronomically unlikely) out-of-range scalar.
 */
export function generateTradingKey(random: RandomSource = defaultRandom): TradingKey {
  for (let attempt = 0; attempt < 16; attempt++) {
    const sk = random(32);
    if (sk.length !== 32) throw new Error('random source must return 32 bytes');
    if (secp256k1.utils.isValidPrivateKey(sk)) return wrap(sk);
    sk.fill(0);
  }
  throw new Error('random source produced no valid secp256k1 scalar in 16 attempts');
}

/**
 * Wrap an existing private key (hex, 0x optional). The error message never
 * echoes the input - it is a secret even when malformed.
 */
export function tradingKeyFromHex(hex: string): TradingKey {
  let sk: Uint8Array;
  try {
    sk = hexToBytes(hex.trim());
  } catch {
    throw new Error('private key must be 32 bytes of hex');
  }
  if (sk.length !== 32 || !secp256k1.utils.isValidPrivateKey(sk)) {
    sk.fill(0);
    throw new Error('private key is not a valid secp256k1 scalar');
  }
  return wrap(sk);
}

/** Best-effort zeroisation of the key bytes. The object is unusable afterwards. */
export function destroyTradingKey(key: TradingKey): void {
  key.privateKey.fill(0);
}

/** Hex of the private key - for an explicit, user-requested export only. */
export const exportPrivateKeyHex = (key: TradingKey): Hex => bytesToHex(key.privateKey);

// ---------------------------------------------------------------------------
// Key names
// ---------------------------------------------------------------------------

/** Documented: `^[0-9a-zA-Z_-]{1,36}$`, and `default` is reserved (it is the master key). */
export const API_KEY_NAME_RE = /^[0-9a-zA-Z_-]{1,36}$/;

export function apiKeyNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !API_KEY_NAME_RE.test(name)) {
    return `API key name must match ${API_KEY_NAME_RE}`;
  }
  if (name === 'default') return 'API key name "default" is reserved';
  return null;
}

export function assertApiKeyName(name: string): string {
  const p = apiKeyNameProblem(name);
  if (p) throw new Error(p);
  return name;
}

/**
 * A fresh, recognisable key name: `<prefix>-<base36 ms>-<4 random base36>`.
 * Key names are PUBLIC (any address's key list is readable without auth), so
 * never put anything identifying in the prefix.
 */
export function generateApiKeyName(prefix = 'vs', now: number = Date.now(), random: RandomSource = defaultRandom): string {
  const r = Array.from(random(4), (b) => (b % 36).toString(36)).join('');
  return assertApiKeyName(`${prefix}-${now.toString(36)}-${r}`);
}

// ---------------------------------------------------------------------------
// Expiry. THE UNIT IS MILLISECONDS.
// ---------------------------------------------------------------------------

/**
 * `expiresAt` on the SoDEX wire is a millisecond timestamp, not a Unix second.
 * Opentrade learned this the hard way ("expiresAt is invalid": 1.79e9 read as
 * milliseconds is three weeks after the epoch), and its browser signer still
 * compared the ms value against seconds, so a key never expired locally. The
 * venue's own keys on a live account read, e.g., webkey 1788193904811 (a ~24h
 * key) and default 0 (never). Every helper here takes and returns ms.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Default lifetime of the browser trading key: 24 h, like sodex.com's own web key. */
export const DEFAULT_TRADING_KEY_TTL_MS = DAY_MS;
/** Hard ceiling this package will register for a browser key without an explicit override. */
export const MAX_TRADING_KEY_TTL_MS = 7 * DAY_MS;
/** Anything shorter is almost certainly a unit mistake or a clock problem. */
export const MIN_TRADING_KEY_TTL_MS = 5 * 60_000;

/** An `expiresAt` (ms) `ttlMs` from `now`. */
export function expiryFromNow(ttlMs: number = DEFAULT_TRADING_KEY_TTL_MS, now: number = Date.now()): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive integer (ms)');
  return now + ttlMs;
}

/**
 * Refuse expiries that defeat the "short-lived" design: 0 ("never"), anything
 * that looks like SECONDS, anything already past, shorter than 5 minutes, or
 * further out than `maxTtlMs` (default 7 days).
 */
export function expiryProblem(
  expiresAt: number,
  opts: { now?: number; maxTtlMs?: number; allowNeverExpires?: boolean } = {},
): string | null {
  const now = opts.now ?? Date.now();
  const max = opts.maxTtlMs ?? MAX_TRADING_KEY_TTL_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) return 'expiresAt must be a non-negative integer (ms)';
  if (expiresAt === 0) {
    return opts.allowNeverExpires ? null : 'expiresAt 0 means "never expires"; a browser key must expire';
  }
  if (expiresAt < 1e11) return `expiresAt ${expiresAt} looks like SECONDS; SoDEX wants milliseconds`;
  if (expiresAt <= now) return 'expiresAt is in the past';
  if (expiresAt - now < MIN_TRADING_KEY_TTL_MS) return 'expiresAt is less than 5 minutes away';
  if (expiresAt - now > max) return `expiresAt is more than ${Math.round(max / DAY_MS)} days away`;
  return null;
}

export function assertShortExpiry(
  expiresAt: number,
  opts: { now?: number; maxTtlMs?: number; allowNeverExpires?: boolean } = {},
): number {
  const p = expiryProblem(expiresAt, opts);
  if (p) throw new RangeError(p);
  return expiresAt;
}

/** Expired at `now`? `0` = never expires. Both in MILLISECONDS. */
export const isKeyExpired = (expiresAt: number | undefined, now: number = Date.now()): boolean =>
  !!expiresAt && expiresAt <= now;

/** Whole seconds until expiry (>= 0), or null when it never expires. */
export const secondsUntilExpiry = (expiresAt: number | undefined, now: number = Date.now()): number | null =>
  expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : null;
