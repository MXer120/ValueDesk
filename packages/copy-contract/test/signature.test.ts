/**
 * ECDSA helpers against viem, and exactly the acceptance rules of OpenZeppelin's ECDSA.tryRecover that the contract
 * applies first (65 bytes, v 27/28, low s).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSignature, recoverAddress, serializeCompactSignature, serializeSignature, signatureToCompactSignature } from 'viem';
import { privateKeyToAddress as viemPrivateKeyToAddress, sign as viemSign } from 'viem/accounts';

import {
  type Hex,
  SECP256K1_HALF_N,
  SECP256K1_N,
  SignatureError,
  bigIntToHex32,
  bytesToHex,
  hexToBytes,
  normalizeSignature,
  ozTryRecover,
  privateKeyToAddress,
  recoverSigner,
  signDigest,
  splitSignature,
} from '../src/index.ts';
import { rng } from './helpers.ts';

/** TEST-ONLY keys from a seeded PRNG. */
const keys = (() => {
  const r = rng(0x7e57);
  return Array.from({ length: 12 }, () => {
    let k: bigint;
    do k = BigInt(bytesToHex(r.bytes(32))) % SECP256K1_N;
    while (k === 0n);
    return bigIntToHex32(k);
  });
})();
const digests = (() => {
  const r = rng(0xd16e);
  return Array.from({ length: 12 }, () => bytesToHex(r.bytes(32)));
})();

/** Flip s to n - s and v to the other parity: the same key's other valid signature (high s). */
function malleate(sig: Hex): Hex {
  const b = hexToBytes(sig);
  const s = BigInt(bytesToHex(b.subarray(32, 64)));
  const out = new Uint8Array(65);
  out.set(b.subarray(0, 32));
  out.set(hexToBytes(bigIntToHex32(SECP256K1_N - s)), 32);
  out[64] = b[64] === 27 ? 28 : 27;
  return bytesToHex(out);
}

test('signDigest equals viem’s sign (RFC 6979, low s, v 27/28) and recovers like viem', async () => {
  for (let i = 0; i < keys.length; i++) {
    const pk = keys[i]!;
    const d = digests[i]!;
    const ours = signDigest(d, pk);
    const theirs = serializeSignature(await viemSign({ hash: d, privateKey: pk }));
    assert.equal(ours, theirs, `key ${i}`);
    assert.equal(privateKeyToAddress(pk), viemPrivateKeyToAddress(pk));
    assert.equal(recoverSigner(d, ours), await recoverAddress({ hash: d, signature: ours }));
    assert.equal(ozTryRecover(d, ours), privateKeyToAddress(pk));
    const v = hexToBytes(ours)[64];
    assert.ok(v === 27 || v === 28);
    assert.ok(BigInt(splitSignature(ours).s) <= SECP256K1_HALF_N);
  }
});

test('normalizeSignature: v 0/1, high s and EIP-2098 compact all become the canonical 65 bytes', async () => {
  for (let i = 0; i < keys.length; i++) {
    const d = digests[i]!;
    const canonical = signDigest(d, keys[i]!);
    const b = hexToBytes(canonical);
    const v01 = bytesToHex(Uint8Array.from([...b.subarray(0, 64), b[64]! - 27]));
    assert.equal(normalizeSignature(v01), canonical, 'v 0/1');
    assert.equal(normalizeSignature(malleate(canonical)), canonical, 'high s');
    const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(canonical)));
    assert.equal(hexToBytes(compact).length, 64);
    assert.equal(normalizeSignature(compact), canonical, 'EIP-2098');
    assert.equal(normalizeSignature(hexToBytes(canonical)), canonical, 'bytes input');
  }
});

test('ozTryRecover refuses exactly what OpenZeppelin refuses', () => {
  const d = digests[0]!;
  const good = signDigest(d, keys[0]!);
  const b = hexToBytes(good);
  assert.equal(ozTryRecover(d, malleate(good)), null, 'high s');
  assert.equal(ozTryRecover(d, bytesToHex(Uint8Array.from([...b.subarray(0, 64), b[64]! - 27]))), null, 'v 0/1');
  assert.equal(ozTryRecover(d, bytesToHex(b.subarray(0, 64))), null, '64 bytes');
  assert.equal(ozTryRecover(d, bytesToHex(Uint8Array.from([...b, 0]))), null, '66 bytes');
  assert.equal(ozTryRecover(d, bytesToHex(new Uint8Array(65).fill(0).map((_, i) => (i === 64 ? 27 : 0)))), null, 'r = s = 0');
  assert.equal(ozTryRecover('0x1234', good), null, 'digest must be 32 bytes');
  // A different digest recovers to a different (valid-looking) address, never to the signer.
  assert.notEqual(ozTryRecover(digests[1]!, good), privateKeyToAddress(keys[0]!));
});

test('normalizeSignature rejects impossible inputs', () => {
  const good = signDigest(digests[0]!, keys[0]!);
  const b = hexToBytes(good);
  assert.throws(() => normalizeSignature(bytesToHex(Uint8Array.from([...b.subarray(0, 64), 29]))), /unexpected v/);
  assert.throws(() => normalizeSignature(bytesToHex(b.subarray(0, 63))), /65-byte or 64-byte/);
  const zeroR = new Uint8Array(b);
  zeroR.fill(0, 0, 32);
  assert.throws(() => normalizeSignature(zeroR), SignatureError);
  const bigS = new Uint8Array(b);
  bigS.set(hexToBytes(bigIntToHex32(SECP256K1_N)), 32);
  assert.throws(() => normalizeSignature(bigS), /out of range/);
  assert.throws(() => signDigest('0x1234', keys[0]!), /32 bytes/);
});
