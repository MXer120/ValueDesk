/**
 * Byte, hex, address and hashing helpers.
 *
 * Browser-safe: only @noble/hashes, Uint8Array and plain string handling. No Buffer, no node:*.
 * Deliberately a small copy of what @valuescan/sodex-core has, so this package stands on its own.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToUtf8, utf8ToBytes } from '@noble/hashes/utils';

/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`;
/** A 0x-prefixed 20-byte address. Any case is accepted as input; outputs say which case they use. */
export type Address = `0x${string}`;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
export const ZERO_BYTES32 = ('0x' + '00'.repeat(32)) as Hex;

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT64 = (1n << 64n) - 1n;

export class HexError extends Error {
  override name = 'HexError';
}

export const bytesToHex = (b: Uint8Array): Hex => {
  let s = '0x';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s as Hex;
};

const HEX_BODY_RE = /^[0-9a-fA-F]*$/;

/**
 * Hex string to bytes. The 0x prefix is required, the length must be even and every digit must be hex: a stray
 * character throws instead of silently becoming a 0 byte in a signed payload.
 */
export function hexToBytes(h: string): Uint8Array {
  if (typeof h !== 'string' || !(h.startsWith('0x') || h.startsWith('0X'))) {
    throw new HexError('expected a 0x-prefixed hex string');
  }
  const s = h.slice(2);
  if (s.length % 2 !== 0) throw new HexError(`odd-length hex string (${s.length} digits)`);
  if (!HEX_BODY_RE.test(s)) throw new HexError('not a hex string');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** True for a 0x-prefixed, even-length hex string; with `bytes`, also exactly that many bytes. */
export function isHex(value: unknown, bytes?: number): value is Hex {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) return false;
  return bytes === undefined || value.length === 2 + bytes * 2;
}

export const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** UTF-8 encode (TextEncoder semantics: lone surrogates become U+FFFD). */
export const utf8 = (s: string): Uint8Array => utf8ToBytes(s);
/** UTF-8 decode (invalid sequences become U+FFFD). */
export const fromUtf8 = (b: Uint8Array): string => bytesToUtf8(b);

export const keccak256 = (b: Uint8Array): Uint8Array => keccak_256(b);
export const keccak256Hex = (b: Uint8Array): Hex => bytesToHex(keccak_256(b));
/** keccak256 of the UTF-8 bytes of `s`, as hex. `keccakUtf8("")` is the EIP-712 hash of an empty string. */
export const keccakUtf8 = (s: string): Hex => bytesToHex(keccak_256(utf8(s)));

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Lexicographic byte comparison (what Solidity's bytes32 `<` does on equal-length values). */
export const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

/** Big-endian 32-byte word of an unsigned integer. */
export function uintToWord(v: bigint): Uint8Array {
  if (v < 0n || v > MAX_UINT256) throw new RangeError('value does not fit uint256');
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]!);
  return v;
}

export const bigIntToHex32 = (v: bigint): Hex => bytesToHex(uintToWord(v));

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Any-case 0x address. Checksums are not enforced on input (wallets and RPCs mix cases). */
export const isAddress = (a: unknown): a is Address => typeof a === 'string' && ADDRESS_RE.test(a);

export function assertAddress(a: unknown, what = 'address'): Address {
  if (!isAddress(a)) throw new TypeError(`${what} must be a 0x-prefixed 20-byte address`);
  return a;
}

/** EIP-55 checksum form. */
export function toChecksumAddress(address: string): Address {
  if (!isAddress(address)) throw new TypeError('not a 20-byte 0x address');
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8(lower))).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const c = lower[i]!;
    out += Number.parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out as Address;
}

/** Lower-case form, for map keys and comparisons. */
export const lowerAddress = (a: string): Address => assertAddress(a).toLowerCase() as Address;

export const sameAddress = (a: string, b: string): boolean =>
  isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();

export const isZeroAddress = (a: string): boolean => sameAddress(a, ZERO_ADDRESS);

// ---------------------------------------------------------------------------
// Integers
// ---------------------------------------------------------------------------

/**
 * Coerce an unsigned integer given as bigint, safe-integer number or decimal/0x string, and range-check it against
 * `bits`. Rejects fractions, negatives, unsafe numbers and anything that is not clearly an integer.
 */
export function toUint(value: unknown, bits: number, what = 'value'): bigint {
  let v: bigint;
  if (typeof value === 'bigint') v = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer (use a bigint)`);
    v = BigInt(value);
  } else if (typeof value === 'string' && (/^\d+$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value))) {
    v = BigInt(value);
  } else {
    throw new TypeError(`${what} must be an unsigned integer`);
  }
  if (v < 0n || v >= 1n << BigInt(bits)) throw new RangeError(`${what} does not fit uint${bits}`);
  return v;
}

/** As `toUint`, returned as a JS number; only for widths up to 48 bits. */
export function toUintNumber(value: unknown, bits: number, what = 'value'): number {
  if (bits > 48) throw new RangeError('toUintNumber is only for widths up to 48 bits');
  return Number(toUint(value, bits, what));
}
