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
import { VIP_PROGRAM_FEE, botLadderFee } from '../src/builder/programs.js';
import { copyLadderFee } from '../src/builder/tiers.js';
import type { FeeProgram } from '../src/admin/store.js';
import { builderRoutes } from '../src/routes/builder.js';
import { inviteRoutes } from '../src/routes/invites.js';
import { CREDIT_FEE, INVITE_STATEMENT, REFERRED_START_USD, PERK_HORIZON_MS, WELCOME_FEE, WELCOME_USD } from '../src/invites/claim.js';
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
  assert.deepEqual(check.json(), { ok: true, valid: true, welcome: true, vipDays: 0 });
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
  // Back on a tier - the one of REFERRED_START_USD, not the first (owner 2026-11-15: referred traders start at tier 1).
  const back = terms(fresh.address);
  assert.deepEqual([before.fee.perps, before.fee.spot], [20, 20], 'not joined: the first tier');
  assert.deepEqual([back.fee.perps, back.fee.spot], [15, 20], 'joined: the tier of $100k');
  const after100k = await volume(fresh.address);
  assert.deepEqual(after100k.fees, { copy: null, bots: null });
  assert.ok(after100k.usd >= REFERRED_START_USD, `the executor's ladder reads at least $100k: ${after100k.usd}`);
  assert.equal(svc.standardFee(fresh.address, 'copy'), copyLadderFee(REFERRED_START_USD));
  assert.equal(svc.standardFee(fresh.address, 'bots'), botLadderFee(REFERRED_START_USD));
  assert.equal(svc.standardFee(inviter.address, 'bots'), botLadderFee(0), 'a wallet that joined no one: its own volume');
  const me = (await app.inject({ method: 'GET', url: `/api/vs/invites/me?address=${fresh.address}` })).json();
  assert.deepEqual(me.welcome, { active: false, usedUsd: WELCOME_USD, leftUsd: 0, limitUsd: WELCOME_USD });
  assert.equal(me.joined.code, 'INVITER1');
});

test('VIP credit removed: nobody is given any, and what is left of one already given is gone without a debt', async () => {
  const vip = wallet().address;
  const used = wallet().address;
  const dbFile = join(tempDir('vs-invvip-'), 'invites.db');
  const before = new InviteStore(dbFile, T0, Number.MAX_SAFE_INTEGER);
  before.grant(vip, 'vip', 5e6, T0 - 2000);
  before.grant(used, 'vip', 5e6, T0 - 2000);
  before.take(`s:${used}`, 'o1', 1, [{ address: used, kind: 'spend', micro: 2e6, source: null, tier: null }], T0 - 1000);
  // Later credits and spends of its own stay its own.
  before.take(`e:x`, 'o2', 1, [{ address: used, kind: 'earn', micro: 9e6, source: 'x', tier: 1 }], T0 + 3_600_000);
  before.take(`s:${used}`, 'o3', 1, [{ address: used, kind: 'spend', micro: 4e6, source: null, tier: null }], T0 + 3_700_000);
  before.close();
  const program: FeeProgram = { id: 0, address: vip, products: ['perps', 'spot', 'copy', 'bots'], fee: VIP_PROGRAM_FEE, from: T0 - 1, until: T0 + 30 * 86_400_000, label: 'Beta VIP', addedAt: T0, addedBy: 'beta' };
  const w = await world({ programs: [program], dbFile });
  w.inv.tick();
  const me = (a: string) => w.inv.me(a);
  assert.equal(me(vip).credits.balanceUsd, 0);
  assert.equal(me(vip).credits.grantedUsd, 0);
  assert.equal(me(vip).credits.paying, false);
  assert.equal(me(vip).history.length, 0);
  assert.equal(me(used).credits.balanceUsd, 5, '9 earned - 4 of its own spent; the 2 spent of the credit stay paid');
  assert.equal(me(used).credits.grantedUsd, 2);
});

test('VIP codes: who joins a VIP\'s code, or one upgraded on the dev page, pays the VIP fee for 7 days - and is no VIP', async () => {
  const vip = wallet();
  const plain = wallet();
  const [a, b, c, d] = [wallet(), wallet(), wallet(), wallet()];
  const program: FeeProgram = { id: 0, address: vip.address, products: ['perps', 'spot', 'copy', 'bots'], fee: VIP_PROGRAM_FEE, from: T0 - 1, until: T0 + 30 * 86_400_000, label: 'Beta VIP', addedAt: T0, addedBy: 'beta' };
  const w = await world({ programs: [program], owners: { VIPVIP11: vip.address, PLAIN111: plain.address, JOINED11: a.address } });
  const check = async (code: string) => (await w.app.inject({ method: 'GET', url: `/api/vs/invites/check?code=${code}` })).json().vipDays;
  const post = async (x: ReturnType<typeof wallet>, code: string) => (await w.app.inject({ method: 'POST', url: '/api/vs/invites/join', payload: { join: signJoin(x, code, w.clock.now()) } })).json();
  const progs = (x: string) => w.svc.loweredFor(x, w.clock.now()).fees;
  assert.equal(await check('VIPVIP11'), 7);
  assert.equal(await check('PLAIN111'), 0);
  const r = await post(a, 'VIPVIP11');
  assert.equal(r.vipUntil, w.clock.now() + 7 * 86_400_000);
  assert.equal((await post(b, 'PLAIN111')).vipUntil, null);
  assert.equal(w.inv.giftsFor(a.address, w.clock.now())[0]!.fee, VIP_PROGRAM_FEE);
  assert.deepEqual(w.inv.giftsFor(b.address, w.clock.now()), []);
  // Its own code gives no VIP days on: the days are a fee, not VIP.
  assert.equal(w.inv.isVip(a.address), false);
  assert.equal(w.svc.vipProgramOf(a.address), null);
  assert.equal(await check('JOINED11'), 0);
  // The welcome is lower while it lasts; after it the VIP fee holds (standardFee: without welcome and credits).
  assert.equal(progs(a.address).bots!.fee, 0);
  assert.equal(w.svc.standardFee(a.address, 'bots'), 1);
  assert.equal(w.svc.standardFee(b.address, 'bots'), 2);
  // Upgraded on the dev page.
  assert.equal(w.inv.store.addVipCode('PLAIN111', vip.address, w.clock.now()), true);
  assert.equal(await check('PLAIN111'), 7);
  assert.ok((await post(c, 'PLAIN111')).vipUntil);
  assert.deepEqual(w.inv.store.joinsOfCode('PLAIN111', w.clock.now()), { joins: 2, vipNow: 1 });
  assert.equal(w.inv.me(plain.address).vipCode, true);
  // Downgraded: new joins get none, those made keep theirs.
  w.inv.store.removeVipCode('PLAIN111');
  assert.equal((await post(d, 'PLAIN111')).vipUntil, null);
  assert.equal(w.inv.giftsFor(c.address, w.clock.now()).length, 1);
  assert.deepEqual(w.inv.giftsFor(c.address, w.clock.now() + 7 * 86_400_000), []);
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
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/vs/invites/check?code=VALUEDESK' })).json(), { ok: true, valid: false, welcome: false, vipDays: 0 });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/vs/invites/check?code=no' })).json(), { ok: true, valid: false, welcome: false, vipDays: 0 });
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/invites/me?address=nope' })).statusCode, 400);
});
