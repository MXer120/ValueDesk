/**
 * The admin suite's page against the server's checks: what the wallet signs here is
 * exactly what apps/server/src/admin/auth.ts accepts - for the sign-in and for a
 * write - and a changed text is refused. Plus the figures' formatting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, generateTradingKey, hashTypedData, hexToBytes, signTypedDataWithKey, type TypedData } from '@sodex-core';
import { ADMIN_SIGN_IN_STATEMENT, adminSignInTypedData } from '@sign/admin/signIn';
import { adminSignInDigest, checkAdminAction, checkAdminSignIn } from '@sign/admin/auth';
import { signAction, signIn, type Connected } from './wallet';
import { bp, duration, usd, usdShort } from './format';
import { niceCeil } from './BarChart';

function walletFor() {
  const key = generateTradingKey();
  const calls: string[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_signTypedData_v4') {
        const td = JSON.parse((params as [string, string])[1]);
        const raw = hexToBytes(signTypedDataWithKey(td, key.privateKey)).slice(1);
        raw[64] = raw[64]! + 27;
        return bytesToHex(raw);
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
  };
  const c: Connected = { provider, address: key.address.toLowerCase(), name: 'test' };
  return { c, calls };
}

test('the sign-in typed data hashes to the server\'s digest', () => {
  const m = { owner: '0x' + '11'.repeat(20), statement: ADMIN_SIGN_IN_STATEMENT, nonce: 'ab'.repeat(16), issuedAt: '1793480000000', expiresAt: '1793480240000', chainId: 1 };
  assert.equal(bytesToHex(hashTypedData(adminSignInTypedData(m) as unknown as TypedData)), bytesToHex(adminSignInDigest(m)));
});

test('sign-in: the wallet signs once, the password goes beside it, and the server\'s check accepts the signature', async () => {
  const { c, calls } = walletFor();
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, token: `vda_${'A'.repeat(43)}`, wallet: c.address, expiresAt: Date.now() + 86_400_000 }), { status: 200 });
  }) as typeof fetch;
  try {
    const s = await signIn(c, 'a password long enough');
    assert.equal(s.wallet, c.address);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, ['eth_chainId', 'eth_signTypedData_v4']);
  assert.equal(sent[0]!.url, '/api/admin/session');
  assert.equal(sent[0]!.body.password, 'a password long enough');
  assert.deepEqual(checkAdminSignIn(sent[0]!.body.signIn, [c.address]).ok, true);
  assert.equal(checkAdminSignIn(sent[0]!.body.signIn, ['0x' + '22'.repeat(20)]).ok, false, 'another admin list: refused');
});

test('a write: the signature covers this ticket and this exact text; anything else is refused', async () => {
  const { c } = walletFor();
  const payload = { id: 7, text: 'Thanks - fixed.' };
  const action = await signAction(c, 'ticket.reply', 'ticket 7', payload, `Reply: ${payload.text}`);
  assert.equal(checkAdminAction(action, { wallet: c.address, action: 'ticket.reply', target: 'ticket 7', payload }).ok, true);
  assert.equal(checkAdminAction(action, { wallet: c.address, action: 'ticket.reply', target: 'ticket 7', payload: { id: 7, text: 'Thanks - fixed!' } }).ok, false);
  assert.equal(checkAdminAction(action, { wallet: c.address, action: 'ticket.reply', target: 'ticket 8', payload }).ok, false);
  assert.equal(checkAdminAction(action, { wallet: c.address, action: 'ticket.status', target: 'ticket 7', payload }).ok, false);
  assert.equal(checkAdminAction(action, { wallet: '0x' + '33'.repeat(20), action: 'ticket.reply', target: 'ticket 7', payload }).ok, false);
});

test('figures: dollars from micro-USD, fees in basis points, durations', () => {
  assert.equal(usd(1_500_000), '$1.50');
  assert.equal(usd(123_456_789_000_000), '$123,456,789');
  assert.equal(usdShort(12_340_000_000_000), '$12.34M');
  assert.equal(usd(null), '–');
  assert.equal(bp(15), '1.5 bp');
  assert.equal(bp(10), '1 bp');
  assert.equal(duration(450), '450 ms');
  assert.equal(duration(4_200), '4.2s');
  assert.equal(duration(125_000), '2m 05s');
  assert.equal(duration(3 * 3_600_000 + 60_000), '3h 01m');
  assert.equal(niceCeil(7), 10);
  assert.equal(niceCeil(2.2e6), 2.5e6);
});
