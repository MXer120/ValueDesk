/**
 * ECDSA helpers matching what the contract accepts.
 *
 * The contract checks a signature with OpenZeppelin `ECDSA.tryRecoverCalldata` first, which accepts ONLY:
 *   - exactly 65 bytes r ‖ s ‖ v,
 *   - v = 27 or 28 (ecrecover rejects 0/1),
 *   - s in the lower half of the curve order (no malleable high-s signatures).
 * Anything else falls through to ERC-1271 (and fails for an EOA). `normalizeSignature` turns the other shapes a
 * wallet or signer library may produce (v 0/1, high s, 64-byte EIP-2098 compact) into that exact form without
 * changing who signed, so the relayer can accept them.
 */
import { secp256k1 } from '@noble/curves/secp256k1';

import { type Address, type Hex, bytesToBigInt, bytesToHex, concatBytes, hexToBytes, keccak256, toChecksumAddress, uintToWord } from './bytes.ts';

/** secp256k1 group order n, and n/2 (OpenZeppelin's high-s bound). */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;

export class SignatureError extends Error {
  override name = 'SignatureError';
}

export interface SplitSignature {
  r: Hex;
  s: Hex;
  /** 27 or 28. */
  v: 27 | 28;
  yParity: 0 | 1;
}

/**
 * Canonical 65-byte signature (v 27/28, low s) from any of: 65 bytes with v 0/1/27/28 (high s is flipped to low s,
 * which the same key produced equally validly), or 64-byte EIP-2098 compact (r ‖ yParityAndS). Throws for other
 * lengths, r or s out of range, or an impossible v.
 */
export function normalizeSignature(signature: Hex | Uint8Array): Hex {
  const raw = signature instanceof Uint8Array ? signature : hexToBytes(signature);
  let r: bigint;
  let s: bigint;
  let parity: number;
  if (raw.length === 65) {
    r = bytesToBigInt(raw.subarray(0, 32));
    s = bytesToBigInt(raw.subarray(32, 64));
    const v = raw[64]!;
    if (v === 0 || v === 1) parity = v;
    else if (v === 27 || v === 28) parity = v - 27;
    else throw new SignatureError(`unexpected v ${v} (expected 0, 1, 27 or 28)`);
  } else if (raw.length === 64) {
    r = bytesToBigInt(raw.subarray(0, 32));
    const vs = bytesToBigInt(raw.subarray(32, 64));
    parity = Number(vs >> 255n);
    s = vs & ((1n << 255n) - 1n);
  } else {
    throw new SignatureError(`expected a 65-byte or 64-byte signature, got ${raw.length} bytes`);
  }
  if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) throw new SignatureError('r or s out of range');
  if (s > SECP256K1_HALF_N) {
    s = SECP256K1_N - s;
    parity ^= 1;
  }
  return bytesToHex(concatBytes(uintToWord(r), uintToWord(s), new Uint8Array([27 + parity])));
}

export function splitSignature(signature: Hex): SplitSignature {
  const n = hexToBytes(normalizeSignature(signature));
  const v = n[64] as 27 | 28;
  return { r: bytesToHex(n.subarray(0, 32)), s: bytesToHex(n.subarray(32, 64)), v, yParity: (v - 27) as 0 | 1 };
}

function recover(digest: Uint8Array, r: bigint, s: bigint, parity: number): Address {
  const sig = new secp256k1.Signature(r, s).addRecoveryBit(parity);
  const pub = sig.recoverPublicKey(digest).toRawBytes(false);
  return toChecksumAddress(bytesToHex(keccak256(pub.subarray(1)).subarray(12)));
}

/**
 * Exactly what the contract's ECDSA path returns: the recovered address, or null where OpenZeppelin's tryRecover
 * reports an error (length != 65, v not 27/28, high s, invalid point). No normalisation.
 */
export function ozTryRecover(digest: Hex, signature: Hex): Address | null {
  const d = hexToBytes(digest);
  const raw = hexToBytes(signature);
  if (d.length !== 32 || raw.length !== 65) return null;
  const r = bytesToBigInt(raw.subarray(0, 32));
  const s = bytesToBigInt(raw.subarray(32, 64));
  const v = raw[64]!;
  if (s > SECP256K1_HALF_N || (v !== 27 && v !== 28)) return null;
  if (r === 0n || r >= SECP256K1_N || s === 0n) return null;
  try {
    return recover(d, r, s, v - 27);
  } catch {
    return null;
  }
}

/** Signer of `digest` for any signature shape `normalizeSignature` accepts. */
export function recoverSigner(digest: Hex, signature: Hex): Address {
  const n = normalizeSignature(signature);
  const got = ozTryRecover(digest, n);
  if (!got) throw new SignatureError('signature does not recover');
  return got;
}

/**
 * Sign a digest with a raw private key: RFC 6979 deterministic, low s, v 27/28 (the same bytes Foundry's `vm.sign`
 * returns). FOR TESTS AND HEADLESS TOOLING ONLY: in the app, the follower's wallet signs; no private key of a user
 * ever reaches this code.
 */
export function signDigest(digest: Hex, privateKey: Hex | Uint8Array): Hex {
  const d = hexToBytes(digest);
  if (d.length !== 32) throw new SignatureError('digest must be 32 bytes');
  const pk = privateKey instanceof Uint8Array ? privateKey : hexToBytes(privateKey);
  const sig = secp256k1.sign(d, pk, { lowS: true, prehash: false });
  return bytesToHex(concatBytes(uintToWord(sig.r), uintToWord(sig.s), new Uint8Array([27 + sig.recovery])));
}

/** Address of a raw private key (tests and headless tooling). */
export const privateKeyToAddress = (privateKey: Hex | Uint8Array): Address => {
  const pk = privateKey instanceof Uint8Array ? privateKey : hexToBytes(privateKey);
  return toChecksumAddress(bytesToHex(keccak256(secp256k1.getPublicKey(pk, false).subarray(1)).subarray(12)));
};
