import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, privateKeyToAddress } from '../../sodex-core/src/index.ts';
import { buildCopyRequest, copyRequestDigest, signCopyRequestWithKey, verifyCopyRequest, DELEGATION_TTL_MS } from '../src/index.ts';

const EXEC = 'valuedesk-test';
const wallet = secp256k1.utils.randomPrivateKey();
const owner = privateKeyToAddress(wallet).toLowerCase();
const sign = (r: Parameters<typeof signCopyRequestWithKey>[0], k: Uint8Array) => signCopyRequestWithKey(r, k);

test('day key (owner 2026-11-08): one wallet approval signs the everyday actions for a day, never the terms or a key; expired or foreign approvals fail', () => {
  const now = Date.now();
  const day = secp256k1.utils.randomPrivateKey();
  const dayAddr = privateKeyToAddress(day).toLowerCase();
  const approvalReq = buildCopyRequest({ action: 'delegate', owner, executor: EXEC, payload: { key: dayAddr, expiresAt: now + DELEGATION_TTL_MS - 60_000 }, chainId: 1, now, ttlMs: DELEGATION_TTL_MS - 60_000 });
  const approval = { ...approvalReq, signature: sign(approvalReq, wallet) };
  // Twenty hours later the key still signs a bot start.
  const later = now + 20 * 3_600_000;
  const start = buildCopyRequest({ action: 'algo-start', owner, executor: EXEC, payload: { spec: {} }, chainId: 1, now: later });
  const ok = verifyCopyRequest({ ...start, signature: sign(start, day), delegation: approval }, { executor: EXEC, now: later });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // Not the terms, not a key, not another delegation.
  for (const action of ['accept-terms', 'create-key', 'delegate'] as const) {
    const r = buildCopyRequest({ action, owner, executor: EXEC, payload: {}, chainId: 1, now: later });
    assert.equal(verifyCopyRequest({ ...r, signature: sign(r, day), delegation: approval }, { executor: EXEC, now: later }).ok, false, action);
  }
  // A day and more later: expired.
  const past = now + DELEGATION_TTL_MS + 5 * 60_000;
  const r2 = buildCopyRequest({ action: 'algo-action', owner, executor: EXEC, payload: {}, chainId: 1, now: past });
  assert.equal(verifyCopyRequest({ ...r2, signature: sign(r2, day), delegation: approval }, { executor: EXEC, now: past }).ok, false);
  // Another key than the one approved.
  const other = secp256k1.utils.randomPrivateKey();
  assert.equal(verifyCopyRequest({ ...start, signature: sign(start, other), delegation: approval }, { executor: EXEC, now: later }).ok, false);
  // The wallet itself still signs anything.
  assert.equal(verifyCopyRequest({ ...start, signature: sign(start, wallet) }, { executor: EXEC, now: later }).ok, true);
  assert.ok(bytesToHex(new Uint8Array([1])).startsWith('0x') && copyRequestDigest(start).startsWith('0x'));
});

test('day key on P-256 WebCrypto (security review 2026-11-09): non-extractable key signs, the executor verifies; revoked approvals and keys of another type fail', async () => {
  const now = Date.now();
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as { privateKey: Parameters<typeof crypto.subtle.sign>[1]; publicKey: Parameters<typeof crypto.subtle.sign>[1] };
  await assert.rejects(crypto.subtle.exportKey('pkcs8', pair.privateKey), 'the private key cannot be read out');
  const pub = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const ar = buildCopyRequest({ action: 'delegate', owner, executor: EXEC, payload: { alg: 'p256', key: pub, expiresAt: now + DELEGATION_TTL_MS - 60_000 }, chainId: 1, now, ttlMs: DELEGATION_TTL_MS - 60_000 });
  const approval = { ...ar, signature: sign(ar, wallet) };
  const req = buildCopyRequest({ action: 'algo-action', owner, executor: EXEC, payload: { op: 'pause', id: 'x' }, chainId: 1, now: now + 1000 });
  const hex = copyRequestDigest(req).slice(2);
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)));
  assert.equal(verifyCopyRequest({ ...req, signature: sig, delegation: approval }, { executor: EXEC, now: now + 1000 }).ok, true);
  // Revoked after the approval was signed: refused.
  assert.equal(verifyCopyRequest({ ...req, signature: sig, delegation: approval }, { executor: EXEC, now: now + 1000, revokedBefore: () => now + 500 }).ok, false);
  // A P-256 signature under an approval for a secp256k1 key: refused.
  const ar2 = buildCopyRequest({ action: 'delegate', owner, executor: EXEC, payload: { key: owner, expiresAt: now + 3_600_000 }, chainId: 1, now });
  assert.equal(verifyCopyRequest({ ...req, signature: sig, delegation: { ...ar2, signature: sign(ar2, wallet) } }, { executor: EXEC, now: now + 1000 }).ok, false);
});
