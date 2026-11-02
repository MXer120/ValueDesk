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
import { connectWalletConnect, releaseWallet, signAction, signIn, type Connected, type WalletConnectModule } from './wallet';
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

/** A fake ../walletconnect.ts: a session AppKit may have restored, and a pairing that lands when the QR is scanned. */
function fakeWalletConnect(restored: string | null, scan = true) {
  const log: string[] = [];
  const provider = { request: async () => null };
  let snap = restored ? { status: 'connected', provider, address: restored, walletName: 'Old' } : { status: 'idle', provider: null, address: null, walletName: '' };
  const subs = new Set<() => void>();
  const modal = new Set<(s: { open: boolean }) => void>();
  const mod: WalletConnectModule = {
    initWallet: async () => (log.push('init'), { subscribeState: (cb: (s: { open: boolean }) => void) => (modal.add(cb), () => modal.delete(cb)) }),
    getWalletSnapshot: () => snap as ReturnType<WalletConnectModule['getWalletSnapshot']>,
    subscribeWallet: (cb) => (subs.add(cb), () => subs.delete(cb)),
    disconnectWallet: async () => {
      log.push('disconnect');
      snap = { status: 'disconnected', provider: null, address: null, walletName: '' };
      for (const cb of subs) cb();
    },
    connectVia: async (choice) => {
      log.push(`open ${choice}`);
      if (scan === false) {
        // The owner closes the QR instead.
        setTimeout(() => { for (const cb of modal) cb({ open: true }); for (const cb of modal) cb({ open: false }); }, 5);
        return;
      }
      // The phone scans the QR a moment later.
      setTimeout(() => {
        snap = { status: 'connected', provider, address: '0x' + 'AB'.repeat(20), walletName: 'SafePal' };
        for (const cb of subs) cb();
      }, 5);
    },
  };
  return { mod, log };
}

test('WalletConnect: a restored session is ended and the QR opens - never taken silently (owner 2026-11-02: "didnt pop up a qr")', async () => {
  const { mod, log } = fakeWalletConnect('0x' + 'cd'.repeat(20));
  const c = await connectWalletConnect(async () => mod);
  assert.deepEqual(log, ['init', 'disconnect', 'open walletconnect']);
  assert.equal(c.address, '0x' + 'ab'.repeat(20), 'the newly paired wallet, not the restored one');
  assert.equal(c.via, 'walletconnect');
});

test('WalletConnect: with nothing restored the QR opens straight away; "Change wallet" ends only a WalletConnect pairing', async () => {
  const { mod, log } = fakeWalletConnect(null);
  const c = await connectWalletConnect(async () => mod);
  assert.deepEqual(log, ['init', 'open walletconnect']);
  await releaseWallet({ ...c, via: 'extension' }, async () => mod);
  assert.equal(log.includes('disconnect'), false, 'a browser wallet has no pairing to end');
  await releaseWallet(c, async () => mod);
  assert.equal(log.at(-1), 'disconnect');
});

test('WalletConnect: closing the QR without a wallet gives the button back (an error), not a 5-minute wait', async () => {
  const { mod } = fakeWalletConnect(null, false);
  const t0 = Date.now();
  await assert.rejects(connectWalletConnect(async () => mod), /closed before a wallet connected/);
  assert.ok(Date.now() - t0 < 5_000);
});
