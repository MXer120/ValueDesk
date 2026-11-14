import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { BuilderService } from '../src/builder/service.js';
import { CREDIT_FEE, CREDIT_SHARE, CREDIT_WINDOW_MS, INVITE_STATEMENT, WELCOME_USD, CODE_RE } from '../src/invites/claim.js';
import { checkInviteJoin, inviteJoinDigest } from '../src/invites/check.js';
import { InviteService, payingNext, productOf } from '../src/invites/service.js';
import { InviteStore, newCode } from '../src/invites/store.js';

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
function wallet() {
  const pk = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(pk, false).slice(1);
  const address = hex(keccak_256(pub).slice(12));
  return { pk, address };
}
function signJoin(w: { pk: Uint8Array; address: string }, code: string, now = Date.now()) {
  const f = { wallet: w.address, code, statement: INVITE_STATEMENT, nonce: 'a'.repeat(32), issuedAt: String(now), expiresAt: String(now + 5 * 60_000), chainId: 286623 };
  const sig = secp256k1.sign(inviteJoinDigest(f), w.pk);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return { ...f, signature: hex(out) };
}

test('codes: 8 characters with no look-alikes; one per wallet, kept', () => {
  for (let i = 0; i < 50; i++) assert.match(newCode(), CODE_RE);
  const s = new InviteStore(':memory:');
  const a = wallet().address;
  const c = s.ensureCode(a);
  assert.equal(s.ensureCode(a), c);
  assert.equal(s.ownerOf(c), a);
});

test('a join is the invited wallet signing; never its own code, never a wallet with volume, the first one stands', () => {
  const s = new InviteStore(':memory:');
  const inviter = wallet();
  const other = wallet();
  const fresh = wallet();
  const code = s.ensureCode(inviter.address);
  const code2 = s.ensureCode(other.address);
  const ok = checkInviteJoin(signJoin(fresh, code));
  assert.ok(ok.ok);
  if (!ok.ok) return;
  const forged = checkInviteJoin({ ...signJoin(other, code), wallet: fresh.address });
  assert.equal(forged.ok, false, 'signed by another wallet');
  const self = checkInviteJoin(signJoin(inviter, code));
  assert.ok(self.ok && s.join(self.join, false).ok === false);
  const vol = checkInviteJoin(signJoin(wallet(), code));
  assert.deepEqual(vol.ok && s.join(vol.join, true), { ok: false, code: 'has-volume' });
  const r = s.join(ok.join, false);
  assert.ok(r.ok && r.fresh && r.join.inviter === inviter.address);
  const again = checkInviteJoin(signJoin(fresh, code2));
  assert.deepEqual(again.ok && s.join(again.join, false), { ok: false, code: 'joined' });
  const unknown = checkInviteJoin(signJoin(wallet(), 'zzzzzzzz'));
  assert.deepEqual(unknown.ok && s.join(unknown.join, false), { ok: false, code: 'unknown-code' });
});

test('an order is valued by what it was: copies, bots (algo children), site trading', () => {
  assert.equal(productOf('perps', 'vdc-1'), 'copy');
  assert.equal(productOf('perps', 'va-abc-1'), 'bots');
  assert.equal(productOf('spot', null), 'spot');
  assert.equal(productOf('perps', 'web-123'), 'perps');
});

test('credits switch on at the minimum and off at 0, not in between', () => {
  assert.equal(payingNext(50_000, false), true);
  assert.equal(payingNext(20_000, false), false);
  assert.equal(payingNext(20_000, true), true);
  assert.equal(payingNext(0, true), false);
  assert.equal(payingNext(-5, true), false);
});

/** A builder ledger in memory: wallets' lifetime volume and counted orders, a standard fee per product. */
function fakeLedger() {
  const wallets = new Map<string, number>();
  const orders = new Map<string, Array<{ key: string; engine: 'perps' | 'spot'; cl: string | null; t: number; rate: number; countedMicro: number }>>();
  let extra: ((a: string, n: number) => unknown[]) | null = null;
  const builder = {
    tiers: { current: () => ({ builderId: 7 }) },
    store: {
      wallet: (_b: number, a: string) => (wallets.has(a) ? { perpsMicro: wallets.get(a)!, spotMicro: 0 } : null),
      countedOrders: (_b: number, a: string, since: number) => (orders.get(a) ?? []).filter((o) => o.t >= since),
    },
    standardFee: (_a: string, p: string) => (p === 'perps' ? 15 : p === 'bots' ? 4 : 25),
    setExtraPrograms: (f: typeof extra) => { extra = f; },
  };
  return {
    builder: builder as unknown as BuilderService,
    extra: (a: string) => extra?.(a, Date.now()) ?? [],
    trade(a: string, key: string, t: number, rate: number, usd: number, cl: string | null = null) {
      const list = orders.get(a) ?? [];
      const have = list.find((o) => o.key === key);
      if (have) have.countedMicro += usd * 1e6;
      else list.push({ key, engine: 'perps', cl, t, rate, countedMicro: usd * 1e6 });
      orders.set(a, list);
      wallets.set(a, (wallets.get(a) ?? 0) + usd * 1e6);
    },
  };
}

test('the invitee gets the welcome until its first $10k counts; the inviter earns 25% of what it then pays, for 12 months', () => {
  const L = fakeLedger();
  const s = new InviteStore(':memory:');
  let now = 1_800_000_000_000;
  const svc = new InviteService(s, L.builder, { now: () => now });
  const inviter = wallet();
  const fresh = wallet();
  const code = s.ensureCode(inviter.address, now);
  const j = checkInviteJoin(signJoin(fresh, code, now), now);
  assert.ok(j.ok && s.join(j.join, false, now).ok);
  // Joined, no volume yet: the welcome lowers every product to CREDIT_FEE.
  assert.deepEqual((L.extra(fresh.address) as Array<{ fee: number; label: string }>).map((p) => [p.fee, p.label]), [[CREDIT_FEE, 'Invite welcome']]);
  // $10k at the welcome's 0.1 bp, then $100k at 1.5 bp.
  L.trade(fresh.address, 'o1', now + 1, CREDIT_FEE, WELCOME_USD);
  L.trade(fresh.address, 'o2', now + 2, 15, 100_000);
  svc.tick();
  assert.equal(svc.welcomeActive(fresh.address), false);
  const paid = 10_000 * 0.00001 + 100_000 * 0.00015; // $0.10 + $15
  const me = svc.me(inviter.address);
  assert.ok(Math.abs(me.credits.earnedUsd - paid * CREDIT_SHARE) < 1e-9, String(me.credits.earnedUsd));
  assert.equal(me.invitees.length, 1);
  assert.match(me.invitees[0]!.wallet, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  // The same order growing adds only its new part; ticking again adds nothing.
  L.trade(fresh.address, 'o2', now + 2, 15, 10_000);
  svc.tick();
  svc.tick();
  assert.ok(Math.abs(svc.me(inviter.address).credits.earnedUsd - (paid + 10_000 * 0.00015) * CREDIT_SHARE) < 1e-9);
  // Past 12 months: nothing more.
  L.trade(fresh.address, 'late', now + CREDIT_WINDOW_MS + 1, 15, 100_000);
  svc.tick();
  assert.ok(Math.abs(svc.me(inviter.address).credits.earnedUsd - (paid + 10_000 * 0.00015) * CREDIT_SHARE) < 1e-9);
  // Credits now pay the inviter's own fee: CREDIT_FEE on every product.
  assert.equal(svc.me(inviter.address).credits.paying, true);
  assert.deepEqual((L.extra(inviter.address) as Array<{ label: string }>).map((p) => p.label), ['Fee credits']);
  // The inviter trades $10k of perps at 0.1 bp: credits pay the 1.4 bp it would have paid ($1.40).
  now += 1_000;
  L.trade(inviter.address, 'i1', now, CREDIT_FEE, 10_000);
  svc.tick();
  const after = svc.me(inviter.address).credits;
  assert.ok(Math.abs(after.spentUsd - 1.4) < 1e-9, String(after.spentUsd));
  assert.ok(Math.abs(after.balanceUsd - (after.earnedUsd - 1.4)) < 1e-9);
});

test('credits run out: the balance reaching 0 turns them off, and what was traded past it is spent too (the overrun)', () => {
  const L = fakeLedger();
  const s = new InviteStore(':memory:');
  let now = 1_800_000_000_000;
  const svc = new InviteService(s, L.builder, { now: () => now });
  const inviter = wallet();
  const fresh = wallet();
  const code = s.ensureCode(inviter.address, now);
  const j = checkInviteJoin(signJoin(fresh, code, now), now);
  assert.ok(j.ok && s.join(j.join, false, now).ok);
  L.trade(fresh.address, 'w', now + 1, CREDIT_FEE, WELCOME_USD);
  L.trade(fresh.address, 'p', now + 2, 15, 2_000); // $0.30 fee -> $0.075 credit
  svc.tick();
  assert.equal(svc.me(inviter.address).credits.paying, true);
  now += 1_000;
  L.trade(inviter.address, 'big', now, CREDIT_FEE, 1_000); // worth $0.14 of fee: more than the balance
  svc.tick();
  const c = svc.me(inviter.address).credits;
  assert.equal(c.paying, false);
  assert.ok(c.balanceUsd < 0 && c.balanceUsd > -0.1, String(c.balanceUsd));
  assert.deepEqual(L.extra(inviter.address), []);
});
