/**
 * Referrals end to end on the real fee path: the builder service that signs the site's fee and answers the executor's
 * read, with the invites' welcome and credits plugged in (invites/service.ts) and the routes the page calls.
 *
 *   a joined wallet's signed fee is 0 (the welcome), in short slices, and the executor gets it with its budget;
 *   once it traded $100k on SoDEX, it is back on its tier;
 *   a VIP wallet gets its $10 once - the sweep, the page, a restart: never twice - and the credit lowers its fee;
 *   /api/vs/invites/{check,me,join} answer as the page expects, and refuse what they must.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { testTiers } from '../src/builder/config.js';
import { BuilderService } from '../src/builder/service.js';
import { writeNewKeyFile } from '../src/builder/terms.js';
import { dayOf } from '../src/builder/counting.js';
import { VIP_PROGRAM_FEE } from '../src/builder/programs.js';
import type { FeeProgram } from '../src/admin/store.js';
import { builderRoutes } from '../src/routes/builder.js';
import { inviteRoutes } from '../src/routes/invites.js';
import { CREDIT_FEE, INVITE_STATEMENT, PERK_HORIZON_MS, VIP_CREDIT_USD, WELCOME_FEE, WELCOME_USD } from '../src/invites/claim.js';
import { inviteJoinDigest } from '../src/invites/check.js';
import { InviteService } from '../src/invites/service.js';
import { InviteStore } from '../src/invites/store.js';
import { BUILDER, CHAIN, Clock, FakeSodex, MemoryLog, addr, tempDir } from './builderFakes.js';

const T0 = 1_790_000_000_000;
const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
function wallet() {
  const pk = secp256k1.utils.randomPrivateKey();
  return { pk, address: hex(keccak_256(secp256k1.getPublicKey(pk, false).slice(1)).slice(12)) };
}
function signJoin(w: { pk: Uint8Array; address: string }, code: string, now: number) {
  const f = { wallet: w.address, code, statement: INVITE_STATEMENT, nonce: 'a'.repeat(32), issuedAt: String(now), expiresAt: String(now + 5 * 60_000), chainId: 286623 };
  const sig = secp256k1.sign(inviteJoinDigest(f), w.pk);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return { ...f, signature: hex(out) };
}

async function world(o: { programs?: FeeProgram[]; owners?: Record<string, string>; dbFile?: string } = {}) {
  const dir = tempDir('vs-invfee-');
  writeFileSync(join(dir, 'builder-tiers.json'), JSON.stringify(testTiers(BUILDER)));
  writeNewKeyFile(join(dir, 'builder-terms.key'));
  const clock = new Clock(T0);
  const programs = o.programs ?? [];
  const svc = new BuilderService({
    tiersPath: join(dir, 'builder-tiers.json'), keyPath: join(dir, 'builder-terms.key'), dbPath: join(dir, 'builder.db'), chainId: CHAIN,
    io: new FakeSodex(clock), log: new MemoryLog(), now: clock.now,
    programs: (a, at) => programs.filter((g) => g.address === a && g.from <= at && (g.until === null || g.until > at)),
    vipCandidates: () => programs.map((g) => g.address),
  });
  svc.load();
  const store = new InviteStore(o.dbFile ?? ':memory:');
  const inv = new InviteService(store, svc, { now: clock.now, ownerOf: async (c) => o.owners?.[c] ?? null });
  const app = Fastify();
  await app.register(builderRoutes, { service: svc, internalToken: TOKEN });
  await app.register(inviteRoutes, { service: inv, builder: svc, keep: false, now: clock.now });
  await app.ready();
  after(async () => { await app.close(); svc.stop(); store.close(); });
  const terms = (a: string) => {
    const t = svc.terms({ address: a, nonce: 'n'.repeat(22), hint: false, client: 'c' });
    if (!('fee' in t) || !t.fee) throw new Error('no terms');
    return t;
  };
  const volume = async (a: string) => (await app.inject({ method: 'GET', url: `/api/vs/builder/volume?address=${a}&builder=${BUILDER}&days=14`, headers: { 'x-internal-token': TOKEN } })).json();
  return { svc, inv, store, app, clock, terms, volume };
}

test('the welcome: a joined wallet signs 0 on site trading in short slices, the executor gets 0 with its budget, and $100k later it is back on its tier', async () => {
  const inviter = wallet();
  const fresh = wallet();
  const { svc, app, clock, terms, volume } = await world({ owners: { INVITER1: inviter.address } });
  const before = terms(fresh.address);
  assert.ok(before.fee.perps > 0 && before.fee.spot > 0, 'a wallet that has not joined pays its tier');
  // The page checks the code, the wallet signs, the server takes the join.
  const check = await app.inject({ method: 'GET', url: '/api/vs/invites/check?code=inviter1' });
  assert.deepEqual(check.json(), { ok: true, valid: true, welcome: true });
  const joined = await app.inject({ method: 'POST', url: '/api/vs/invites/join', payload: { join: signJoin(fresh, 'INVITER1', clock.now()) } });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().welcome, true);

  const t = terms(fresh.address);
  assert.deepEqual([t.fee.perps, t.fee.spot], [WELCOME_FEE, WELCOME_FEE], 'site trading: no ValueDesk fee');
  assert.ok(t.ttl >= 60_000 && t.ttl <= PERK_HORIZON_MS, `signed for minutes at a time, not 10: ${t.ttl}`);
  const v = await volume(fresh.address);
  assert.equal(v.fees.copy.fee, WELCOME_FEE);
  assert.equal(v.fees.bots.fee, WELCOME_FEE);
  assert.equal(v.fees.bots.budget.kind, 'welcome');
  assert.equal(v.fees.bots.budget.capUsd, WELCOME_USD);
  assert.deepEqual(v.fees.bots.budget.perUsd, { copy: 1, bots: 1 });

  // $60k traded on SoDEX (no fee paid, so only `traded` sees it): the budget shrinks.
  const add = svc.store!.db.prepare('INSERT INTO traded (builder, address, engine, day, micro) VALUES (?, ?, ?, ?, ?)');
  add.run(BUILDER, fresh.address, 'perps', dayOf(clock.now()), 60_000 * 1e6);
  assert.equal((await volume(fresh.address)).fees.bots.budget.capUsd, 40_000);
  // $40k more: used up - the signed fee and the executor's are the tier's again.
  add.run(BUILDER, fresh.address, 'spot', dayOf(clock.now()), 40_000 * 1e6);
  const back = terms(fresh.address);
  assert.deepEqual([back.fee.perps, back.fee.spot], [before.fee.perps, before.fee.spot]);
  const after100k = await volume(fresh.address);
  assert.deepEqual(after100k.fees, { copy: null, bots: null });
  const me = (await app.inject({ method: 'GET', url: `/api/vs/invites/me?address=${fresh.address}` })).json();
  assert.deepEqual(me.welcome, { active: false, usedUsd: WELCOME_USD, leftUsd: 0, limitUsd: WELCOME_USD });
  assert.equal(me.joined.code, 'INVITER1');
});

test('VIP: every VIP wallet gets $10 of credit once - sweep, page, restart - and the credit lowers its ValueDesk fee', async () => {
  const vip = wallet().address;
  const plain = wallet().address;
  const dbFile = join(tempDir('vs-invvip-'), 'invites.db');
  const program: FeeProgram = { id: 0, address: vip, products: ['perps', 'spot', 'copy', 'bots'], fee: VIP_PROGRAM_FEE, from: T0 - 1, until: T0 + 30 * 86_400_000, label: 'Beta VIP', addedAt: T0, addedBy: 'beta' };
  const w = await world({ programs: [program], dbFile });
  assert.equal(w.inv.isVip(vip), true);
  assert.equal(w.inv.isVip(plain), false);
  assert.deepEqual(w.svc.vipWallets(), [vip]);
  const tierBefore = w.terms(vip).fee.perps;

  assert.equal(w.inv.sweepVip(), 1, 'given');
  assert.equal(w.inv.sweepVip(), 0, 'never twice');
  w.inv.tick();
  const me = (await w.app.inject({ method: 'GET', url: `/api/vs/invites/me?address=${vip}` })).json();
  assert.equal(me.credits.balanceUsd, VIP_CREDIT_USD);
  assert.equal(me.credits.grantedUsd, VIP_CREDIT_USD);
  assert.equal(me.credits.earnedUsd, 0, 'not earned from referrals');
  assert.equal(me.credits.paying, true);
  assert.deepEqual(me.history.map((h: { kind: string; usd: number }) => [h.kind, h.usd]), [['grant', VIP_CREDIT_USD]]);
  // The credit pays the VIP's site fee: 0.1 bp signed instead of its tier, and the executor's copy fee with a budget.
  const t = w.terms(vip);
  assert.ok(tierBefore > CREDIT_FEE);
  assert.equal(t.fee.perps, CREDIT_FEE);
  const v = await w.volume(vip);
  assert.equal(v.fees.copy.fee, CREDIT_FEE);
  assert.equal(v.fees.copy.budget.kind, 'credits');
  assert.equal(v.fees.copy.budget.capUsd, VIP_CREDIT_USD);
  // A plain wallet opening the page gets nothing.
  const p = (await w.app.inject({ method: 'GET', url: `/api/vs/invites/me?address=${plain}` })).json();
  assert.equal(p.credits.balanceUsd, 0);
  assert.equal(p.history.length, 0);

  // A restart on the same file: the VIP is not given it again, by the sweep or by the page.
  const again = new InviteService(new InviteStore(dbFile), w.svc, { now: w.clock.now });
  assert.equal(again.sweepVip(), 0);
  assert.equal(again.me(vip).credits.grantedUsd, VIP_CREDIT_USD);
  assert.equal(again.store.history(vip).filter((h) => h.kind === 'grant').length, 1);
  again.store.close();
});

test('the routes refuse what they must: a bad signature, the own code, ValueDesk\'s code, an unknown code, a second join', async () => {
  const a = wallet();
  const b = wallet();
  const c = wallet();
  const { app, clock } = await world({ owners: { AAAA1111: a.address, BBBB1111: b.address } });
  const post = (join: unknown) => app.inject({ method: 'POST', url: '/api/vs/invites/join', payload: { join } });
  const forged = { ...signJoin(b, 'AAAA1111', clock.now()), wallet: c.address };
  assert.equal((await post(forged)).statusCode, 400, 'signed by another wallet');
  assert.equal((await post(signJoin(a, 'AAAA1111', clock.now()))).json().code, 'self');
  assert.equal((await post(signJoin(c, 'VALUEDESK', clock.now()))).json().code, 'ours');
  assert.equal((await post(signJoin(c, 'NOBODY12', clock.now()))).json().code, 'unknown-code');
  assert.equal((await post(signJoin(c, 'AAAA1111', clock.now()))).statusCode, 200);
  assert.equal((await post(signJoin(c, 'BBBB1111', clock.now()))).json().code, 'joined');
  // The code's owner now has a referral: it joins nobody.
  assert.equal((await post(signJoin(a, 'BBBB1111', clock.now()))).json().code, 'has-referrals');
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/vs/invites/check?code=VALUEDESK' })).json(), { ok: true, valid: false, welcome: false });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/vs/invites/check?code=no' })).json(), { ok: true, valid: false, welcome: false });
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/invites/me?address=nope' })).statusCode, 400);
});
