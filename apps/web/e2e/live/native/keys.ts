/**
 * The test key for the non-EVM chains (types.ts). The secp256k1 chains use it
 * as it is; each ed25519 chain gets a seed DERIVED from it - HKDF-SHA256 with
 * the info "valuedesk-test:<kind>" - so the same secret never serves two curves,
 * and the same key always gives the same addresses.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import type { NativeKeys, NativeKind } from './types';

export function deriveEd25519Seed(secp256k1Key: Uint8Array, kind: NativeKind): Uint8Array {
  if (secp256k1Key.length !== 32) throw new Error('the test key must be 32 bytes');
  return hkdf(sha256, secp256k1Key, new Uint8Array(), `valuedesk-test:${kind}`, 32);
}

/** Keys from the 32-byte test key. The bytes are copied: the caller may wipe its own. */
export function nativeKeys(secp256k1Key: Uint8Array): NativeKeys {
  if (secp256k1Key.length !== 32) throw new Error('the test key must be 32 bytes');
  const key = Uint8Array.from(secp256k1Key);
  return {
    secp256k1: key,
    ed25519: (kind) => deriveEd25519Seed(key, kind),
  };
}

/** From hex (0x + 64): for tests and the provider. */
export const nativeKeysFromHex = (hex: string): NativeKeys => {
  const h = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('the test key must be 0x + 64 hex characters');
  return nativeKeys(Uint8Array.from(Buffer.from(h, 'hex')));
};
