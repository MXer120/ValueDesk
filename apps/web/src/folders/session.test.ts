/**
 * The folders' sign-in from the browser's side: the typed data the wallet is
 * asked to sign hashes to the digest the server checks (one pinned vector,
 * computed here by @sodex-core's generic EIP-712 and in
 * apps/server/test/folders.test.ts by the server's own encoder), and a sign-in
 * made through the real path - one free signature, never a transaction - is
 * one the server accepts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, generateTradingKey, hashTypedData, hexToBytes, signTypedDataWithKey, type TypedData } from '@sodex-core';
import { SIGN_IN_STATEMENT, signInTypedData } from '@sign/folders/types.js';
import { checkSignIn } from '@sign/folders/auth.js';
import { signIn } from './api';

test('sign-in: the typed data the wallet signs hashes to the server\'s digest (pinned vector)', () => {
  const td = signInTypedData({ owner: '0x' + '11'.repeat(20), statement: SIGN_IN_STATEMENT, nonce: 'ab'.repeat(16), issuedAt: '1760000000000', expiresAt: '1760000300000', chainId: 1 });
  assert.equal(bytesToHex(hashTypedData(td as unknown as TypedData)), '0x73723a8d8d4868b167a3b8c3300e4091dd053259a9568e21ea75402dff16fd5f');
  assert.equal(td.domain.name, 'ValueDesk Folders');
  assert.match(td.message.statement, /never a transaction/);
});

test('sign-in: one signature through the real path, accepted by the server\'s check', async () => {
  const key = generateTradingKey();
  const owner = key.address.toLowerCase();
  const calls: string[] = [];
  const wallet = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      if (method === 'eth_chainId') return '0xa4b1';
      if (method === 'eth_signTypedData_v4') {
        const td = JSON.parse((params as [string, string])[1]);
        const raw = hexToBytes(signTypedDataWithKey(td, key.privateKey)).slice(1);
        raw[64] = raw[64]! + 27;
        return bytesToHex(raw);
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
  };
  const realFetch = globalThis.fetch;
  let posted: { url: string; body: { signIn: unknown } } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posted = { url, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ ok: true, owner, token: 'tok', expiresAt: Date.now() + 86_400_000 }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await signIn(wallet, owner), 'tok');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, ['eth_chainId', 'eth_signTypedData_v4'], 'a signature only - never eth_sendTransaction');
  assert.equal(posted!.url, '/api/folders/session');
  const v = checkSignIn(posted!.body.signIn);
  assert.ok(v.ok, v.ok ? '' : v.error);
  assert.equal(v.ok && v.owner, owner);
  assert.equal((posted!.body.signIn as { chainId: number }).chainId, 0xa4b1, "the wallet's own chain");
});
