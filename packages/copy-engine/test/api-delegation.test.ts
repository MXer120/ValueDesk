import { test } from 'node:test';
import type { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, privateKeyToAddress } from '../../sodex-core/src/index.ts';
import { buildCopyRequest, copyRequestDigest, signCopyRequestWithKey, verifyCopyRequest, COPY_TERMS_EXECUTOR, DELEGATION_TTL_MS } from '../src/index.ts';

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
  // Asking the executor for a trading key: yes (owner 2026-11-22; it trades nothing until the wallet registers it on SoDEX).
  const ck = buildCopyRequest({ action: 'create-key', owner, executor: EXEC, payload: { accountId: 1, days: 30 }, chainId: 1, now: later });
  assert.equal(verifyCopyRequest({ ...ck, signature: sign(ck, day), delegation: approval }, { executor: EXEC, now: later }).ok, true);
  // Not the terms, not a key's removal, not another delegation.
  for (const action of ['accept-terms', 'delete-key', 'delegate'] as const) {
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
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
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

test('terms-day-key (owner 2026-11-22, shorter setup): the terms acceptance approves a day key for one executor; another executor, an expired key or a key of no approval fail', async () => {
  const now = Date.now();
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const pub = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const terms = (dayKeyFor: string, expiresAt = now + DELEGATION_TTL_MS - 60_000) => {
    const r = buildCopyRequest({ action: 'accept-terms', owner, executor: COPY_TERMS_EXECUTOR, payload: { termsVersion: 'v', termsHash: '0x' + '1'.repeat(64), country: 'DE', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true, dayKey: { alg: 'p256', key: pub, expiresAt, executor: dayKeyFor } }, chainId: 1, now });
    return { ...r, signature: sign(r, wallet) };
  };
  const p256Sign = async (r: ReturnType<typeof buildCopyRequest>) => {
    const hex = copyRequestDigest(r).slice(2);
    return bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16))))));
  };
  const at = now + 2 * 3_600_000;
  for (const action of ['session', 'create-key', 'algo-start'] as const) {
    const r = buildCopyRequest({ action, owner, executor: EXEC, payload: {}, chainId: 1, now: at });
    const v = verifyCopyRequest({ ...r, signature: await p256Sign(r), delegation: terms(EXEC) }, { executor: EXEC, now: at });
    assert.equal(v.ok, true, `${action}: ${JSON.stringify(v)}`);
  }
  const s = buildCopyRequest({ action: 'session', owner, executor: EXEC, payload: {}, chainId: 1, now: at });
  const sig = await p256Sign(s);
  // Approved for another executor: refused here.
  assert.equal(verifyCopyRequest({ ...s, signature: sig, delegation: terms('other-exec') }, { executor: EXEC, now: at }).ok, false);
  // Longer than a day: refused.
  assert.equal(verifyCopyRequest({ ...s, signature: sig, delegation: terms(EXEC, now + DELEGATION_TTL_MS + 3_600_000) }, { executor: EXEC, now: at }).ok, false);
  // A day later: expired.
  const late = now + DELEGATION_TTL_MS + 5 * 60_000;
  const s2 = buildCopyRequest({ action: 'session', owner, executor: EXEC, payload: {}, chainId: 1, now: late });
  assert.equal(verifyCopyRequest({ ...s2, signature: await p256Sign(s2), delegation: terms(EXEC) }, { executor: EXEC, now: late }).ok, false);
  // A terms acceptance without a day key approves nothing.
  const plain = buildCopyRequest({ action: 'accept-terms', owner, executor: COPY_TERMS_EXECUTOR, payload: { termsVersion: 'v' }, chainId: 1, now });
  assert.equal(verifyCopyRequest({ ...s, signature: sig, delegation: { ...plain, signature: sign(plain, wallet) } }, { executor: EXEC, now: at }).ok, false);
  // Never the terms themselves, a key's removal, or a delegation.
  for (const action of ['accept-terms', 'delete-key', 'delegate'] as const) {
    const r = buildCopyRequest({ action, owner, executor: EXEC, payload: {}, chainId: 1, now: at });
    assert.equal(verifyCopyRequest({ ...r, signature: await p256Sign(r), delegation: terms(EXEC) }, { executor: EXEC, now: at }).ok, false, action);
  }
  // Revoked after the acceptance: refused.
  assert.equal(verifyCopyRequest({ ...s, signature: sig, delegation: terms(EXEC) }, { executor: EXEC, now: at, revokedBefore: () => now + 1 }).ok, false);
});
