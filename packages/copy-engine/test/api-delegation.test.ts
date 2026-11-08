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
