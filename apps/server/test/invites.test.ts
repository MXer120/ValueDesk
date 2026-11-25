import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { BuilderService } from '../src/builder/service.js';
import { CODE_RE, CREDIT_FEE, INVITE_STATEMENT, OURS_CODE, TIER_SHARES, VIP_CODE_DAYS, VIP_TIER_SHARES, WELCOME_FEE, WELCOME_USD, normCode } from '../src/invites/claim.js';
import { checkInviteJoin, checkTermsJoin, inviteJoinDigest, termsDigest } from '../src/invites/check.js';
import { InviteService, payingNext, productOf } from '../src/invites/service.js';
import { InviteStore } from '../src/invites/store.js';

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

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;

test("codes are SoDEX referral codes, any case; ValueDesk's own is not a referral", () => {
  assert.equal(normCode(' wnqityue '), 'WNQITYUE');
  assert.match('WNQITYUE', CODE_RE);
  assert.match(OURS_CODE, CODE_RE);
  assert.doesNotMatch('ab', CODE_RE);
  assert.doesNotMatch('abc-def', CODE_RE);
});

type Budget = ReturnType<InviteService['perkBudget']>;

/** A builder ledger in memory: lifetime counted volume, counted orders, all traded volume by day, a fee per product. */
function fakeLedger() {
  const wallets = new Map<string, number>();
  const orders = new Map<string, Array<{ key: string; engine: 'perps' | 'spot'; cl: string | null; t: number; rate: number; countedMicro: number }>>();
  const traded = new Map<string, Array<{ day: number; engine: 'perps' | 'spot'; micro: number }>>();
  const read = new Map<string, number>();
  let extra: ((a: string, n: number) => unknown[]) | null = null;
  let budget: ((a: string, n: number) => Budget) | null = null;
  const builder = {
    tiers: { current: () => ({ builderId: 7 }) },
    store: {
      wallet: (_b: number, a: string) => (wallets.has(a) ? { perpsMicro: wallets.get(a)!, spotMicro: 0 } : null),
      countedOrders: (_b: number, a: string, since: number) => (orders.get(a) ?? []).filter((o) => o.t >= since),
      tradedMicro: (_b: number, a: string, fromDay: number) => {
        const out = { perps: 0, spot: 0 };
        for (const x of traded.get(a) ?? []) if (x.day >= fromDay) out[x.engine] += x.micro;
        return out;
      },
      readThrough: (_b: number, a: string) => read.get(a) ?? 0,
      oldestOpen: () => null,
    },
    standardFee: (_a: string, p: string) => (p === 'perps' || p === 'spot' ? 15 : p === 'bots' ? 4 : 25),
    setExtraPrograms: (f: typeof extra) => { extra = f; },
    setPerkBudget: (f: typeof budget) => { budget = f; },
  };
  const L = {
    builder: builder as unknown as BuilderService,
    extra: (a: string, now = T0) => (extra?.(a, now) ?? []) as Array<{ fee: number; label: string; until: number | null; products: string[] }>,
    budget: (a: string, now = T0): Budget => (budget ? budget(a, now) : null),
    /** Traded on SoDEX with no builder fee paid (the welcome's fee 0, or elsewhere): not a counted order. */
    traded(a: string, t: number, usd: number, engine: 'perps' | 'spot' = 'perps') {
      const list = traded.get(a) ?? [];
      list.push({ day: Math.floor(t / DAY), engine, micro: usd * 1e6 });
      traded.set(a, list);
    },
    /** A counted order (it paid `rate`), also traded. */
    trade(a: string, key: string, t: number, rate: number, usd: number, cl: string | null = null) {
      const list = orders.get(a) ?? [];
      const have = list.find((o) => o.key === key);
      if (have) have.countedMicro += usd * 1e6;
      else list.push({ key, engine: 'perps', cl, t, rate, countedMicro: usd * 1e6 });
      orders.set(a, list);
      wallets.set(a, (wallets.get(a) ?? 0) + usd * 1e6);
      L.traded(a, t, usd);
    },
    readTo(a: string, t: number) { read.set(a, t); },
  };
  return L;
}

function setup(owners: Record<string, string> = {}, inviters: Record<string, string> = {}, vips: ReadonlySet<string> = new Set(), claimsFrom = Number.MAX_SAFE_INTEGER) {
  const L = fakeLedger();
  const s = new InviteStore(':memory:', Date.now(), claimsFrom);
  const clock = { now: T0 };
  const asked: string[] = [];
  const svc = new InviteService(s, L.builder, {
    now: () => clock.now,
    isVip: (a) => vips.has(a),
    inviterOf: async (w) => (inviters[w] === 'SILENT' ? undefined : inviters[w] ?? null),
    ownerOf: async (code) => { asked.push(code); return code === 'SILENT' ? undefined : owners[code] ?? null; },
  });
  /** A wallet joins under `code` the way the route does it. */
  const join = async (w: { pk: Uint8Array; address: string }, code: string) => {
    const c = checkInviteJoin(signJoin(w, code, clock.now), clock.now);
    if (!c.ok) throw new Error(c.error);
    const owner = await svc.ownerOf(code);
    if (!owner) return { ok: false as const, code: owner === null ? 'unknown-code' : 'sodex-silent' };
    return s.join(c.join, owner, { hasVolume: svc.hasVolume(w.address), welcome: true }, clock.now);
  };
  return { L, s, svc, clock, asked, join };
}

test("a code's owner comes from SoDEX once and is kept; nobody's is asked again only later; a silent SoDEX is not 'no'", async () => {
  const a = wallet();
  const { svc, asked, clock } = setup({ AAAA1111: a.address });
  assert.equal(await svc.ownerOf('AAAA1111'), a.address);
  assert.equal(await svc.ownerOf('AAAA1111'), a.address);
  assert.equal(await svc.ownerOf('NOBODY12'), null);
  assert.equal(await svc.ownerOf('NOBODY12'), null);
  assert.deepEqual(asked, ['AAAA1111', 'NOBODY12']);
  clock.now += 11 * 60_000;
  await svc.ownerOf('NOBODY12');
  assert.equal(asked.length, 3);
  assert.equal(await svc.ownerOf('SILENT'), undefined);
  assert.deepEqual(await svc.check(OURS_CODE), { valid: false, welcome: false, vipDays: 0, silent: false });
  assert.deepEqual(await svc.check('AAAA1111'), { valid: true, welcome: true, vipDays: 0, silent: false });
  assert.deepEqual(await svc.check('SILENT'), { valid: false, welcome: false, vipDays: 0, silent: true });
});

test('joining: the wallet signs; never itself, never a wallet with volume or with referrals of its own; the first join stands', async () => {
  const inviter = wallet();
  const other = wallet();
  const fresh = wallet();
  const { L, s, join } = setup({ INVITER1: inviter.address, OTHER123: other.address });
  const forged = checkInviteJoin({ ...signJoin(other, 'INVITER1'), wallet: fresh.address });
  assert.equal(forged.ok, false, 'signed by another wallet');
  assert.deepEqual(await join(inviter, 'INVITER1'), { ok: false, code: 'self' });
  assert.deepEqual(await join(wallet(), 'NOBODY12'), { ok: false, code: 'unknown-code' });
  const traded = wallet();
  L.trade(traded.address, 'x', T0, 15, 10);
  assert.deepEqual(await join(traded, 'INVITER1'), { ok: false, code: 'has-volume' });
  const r = await join(fresh, 'INVITER1');
  assert.ok(r.ok && r.fresh && r.join.inviter === inviter.address && r.join.welcome);
  assert.deepEqual(await join(fresh, 'OTHER123'), { ok: false, code: 'joined' });
  const again = await join(fresh, 'INVITER1');
  assert.ok(again.ok && !again.fresh, 'a repeat of the same join is answered as done');
  // No loops: the inviter has a referral now, so it joins nobody - not even its own referral.
  s.noteCode('FRESH123', fresh.address, T0);
  assert.deepEqual(await join(inviter, 'FRESH123'), { ok: false, code: 'has-referrals' });
});

test("invites as SoDEX's: 3 a code a week, each with the welcome; the check says when it is full", async () => {
  const inviter = wallet();
  const vips = new Set([inviter.address]);
  const { s, svc, join, clock } = setup({ INVITER1: inviter.address }, {}, vips);
  for (let i = 0; i < 3; i++) { const r = await join(wallet(), 'INVITER1'); assert.ok(r.ok && r.join.welcome); }
  assert.deepEqual(await join(wallet(), 'INVITER1'), { ok: false, code: 'limit' });
  const full = await svc.check('INVITER1');
  assert.ok(full.valid && full.full && full.full.until > clock.now && full.full.until - clock.now <= 7 * 86_400_000);
  // The next week: three more, the welcome for each.
  clock.now += 7 * 86_400_000;
  assert.deepEqual(await svc.check('INVITER1'), { valid: true, welcome: true, vipDays: VIP_CODE_DAYS, silent: false });
  const late = wallet();
  assert.ok((await join(late, 'INVITER1')).ok);
  assert.equal(svc.welcomeActive(late.address), true);
  assert.equal(s.referralsOf(inviter.address).length, 4);
  assert.deepEqual(svc.me(inviter.address).stats.referred, [4, 0, 0]);
});

test('an order is valued by what it was: copies, bots (algo children), site trading', () => {
  assert.equal(productOf('perps', 'vdc-1'), 'copy');
  assert.equal(productOf('perps', 'va-abc-1'), 'bots');
  assert.equal(productOf('spot', null), 'spot');
  assert.equal(productOf('perps', 'web-123'), 'perps');
});

test("credits switch on only with enough to cover the wallet's pace, off at 0, not in between", () => {
  assert.equal(payingNext(50_000, false), true);
  assert.equal(payingNext(20_000, false), false);
  assert.equal(payingNext(20_000, true), true);
  assert.equal(payingNext(0, true), false);
  assert.equal(payingNext(-5, true), false);
  assert.equal(payingNext(50_000, false, 2_000_000), false, 'a trickle does not open the fee to a fast trader');
  assert.equal(payingNext(2_000_000, false, 2_000_000), true);
});

test('the welcome: fee 0 until the wallet traded $100k on SoDEX since its join - counted from its fills, not from fees', async () => {
  const inviter = wallet();
  const fresh = wallet();
  const { L, svc, join } = setup({ INVITER1: inviter.address });
  assert.ok((await join(fresh, 'INVITER1')).ok);
  const p = L.extra(fresh.address);
  assert.deepEqual(p.map((x) => [x.fee, x.label]), [[WELCOME_FEE, 'Invite welcome']]);
  assert.ok(p[0]!.until! > T0 && p[0]!.until! <= T0 + 10 * 60_000, 'handed out minutes at a time');
  L.traded(fresh.address, T0 + 1, 60_000);
  L.readTo(fresh.address, T0 + 1);
  const b = L.budget(fresh.address);
  assert.deepEqual(b && { kind: b.kind, cap: Math.round(b.capUsd), perUsd: b.perUsd, through: b.through }, { kind: 'welcome', cap: 40_000, perUsd: { copy: 1, bots: 1 }, through: T0 + 1 });
  L.traded(fresh.address, T0 + 2, 40_000, 'spot');
  assert.equal(svc.welcomeActive(fresh.address), false);
  assert.deepEqual(L.extra(fresh.address), []);
  assert.equal(L.budget(fresh.address), null);
  const me = svc.me(fresh.address);
  assert.deepEqual(me.welcome, { active: false, usedUsd: 100_000, leftUsd: 0, limitUsd: WELCOME_USD });
  assert.equal(me.joined?.code, 'INVITER1');
});

test("three tiers: 15% / 5% / 1% of the fees each referral pays, for as long as it trades; credits then pay the inviter's own fee", async () => {
  const [a, b, c, d] = [wallet(), wallet(), wallet(), wallet()];
  const { L, s, svc, join, clock } = setup({ AAAA1111: a.address, BBBB1111: b.address, CCCC1111: c.address });
  assert.ok((await join(b, 'AAAA1111')).ok);
  assert.ok((await join(c, 'BBBB1111')).ok);
  assert.ok((await join(d, 'CCCC1111')).ok);
  assert.deepEqual(s.chainOf(d.address), [c.address, b.address, a.address]);
  // d uses up its welcome, then pays 1.5 bp on $100k: $15 of fees.
  L.traded(d.address, T0 + 1, WELCOME_USD);
  L.trade(d.address, 'd1', T0 + 2, 15, 100_000);
  svc.tick();
  assert.ok(near(svc.me(c.address).credits.earnedUsd, 15 * TIER_SHARES[0]), 'c: tier 1');
  assert.ok(near(svc.me(b.address).credits.earnedUsd, 15 * TIER_SHARES[1]), 'b: tier 2');
  assert.ok(near(svc.me(a.address).credits.earnedUsd, 15 * TIER_SHARES[2]), 'a: tier 3');
  // Forever: two years on, still earning. An order that fills further adds only its new part.
  clock.now += 730 * DAY;
  L.trade(d.address, 'd2', clock.now, 15, 100_000);
  L.trade(d.address, 'd1', T0 + 2, 15, 10_000);
  svc.tick();
  svc.tick();
  assert.ok(near(svc.me(c.address).credits.earnedUsd, 31.5 * TIER_SHARES[0]));
  // a's page: three referrals, one per tier, shortened; history with the tier.
  const me = svc.me(a.address);
  assert.deepEqual(me.stats.referred, [1, 1, 1]);
  assert.deepEqual(me.referrals.map((r) => [r.tier, r.rate]), [[1, 0.15], [2, 0.05], [3, 0.01]]);
  assert.match(me.referrals[0]!.wallet, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  assert.ok(me.history.length > 0 && me.history.every((h) => h.kind === 'earn' && h.tier === 3));
  // c joined b, so c has its own welcome first: fee 0, nothing spent. Once it is used up, c's credits pay.
  assert.deepEqual(L.extra(c.address, clock.now).map((x) => [x.fee, x.label]), [[WELCOME_FEE, 'Invite welcome']]);
  L.traded(c.address, clock.now, WELCOME_USD);
  // c's credits pay its own fee: CREDIT_FEE everywhere, spent at the 1.4 bp it would have paid more.
  assert.deepEqual(L.extra(c.address, clock.now).map((x) => [x.fee, x.label]), [[CREDIT_FEE, 'Fee credits']]);
  // Every builder fee, not only bots (owner 2026-11-15): futures and spot on the site, copy trading and bots.
  assert.deepEqual([...L.extra(c.address, clock.now)[0]!.products].sort(), ['bots', 'copy', 'perps', 'spot']);
  clock.now += 1_000;
  L.trade(c.address, 'c1', clock.now, CREDIT_FEE, 10_000);
  svc.tick();
  const after = svc.me(c.address).credits;
  assert.ok(near(after.spentUsd, 1.4), String(after.spentUsd));
  const bud = L.budget(c.address, clock.now);
  assert.ok(bud && bud.kind === 'credits' && near(bud.capUsd, after.balanceUsd) && near(bud.perUsd.bots, 3 / 100_000) && near(bud.perUsd.copy, 24 / 100_000));
});

test('a VIP earns 20% / 7.5% / 2%, each earner of a chain at its own standing; losing VIP changes only what comes after', async () => {
  const [a, b, c, d] = [wallet(), wallet(), wallet(), wallet()];
  const vips = new Set([b.address]);
  const { L, svc, join } = setup({ AAAA1111: a.address, BBBB1111: b.address, CCCC1111: c.address }, {}, vips);
  for (const [w, code] of [[b, 'AAAA1111'], [c, 'BBBB1111'], [d, 'CCCC1111']] as const) assert.ok((await join(w, code)).ok);
  L.traded(d.address, T0 + 1, WELCOME_USD);
  L.trade(d.address, 'd1', T0 + 2, 15, 100_000); // $15 of fees
  svc.tick();
  assert.ok(near(svc.me(c.address).credits.earnedUsd, 15 * TIER_SHARES[0]), 'c is no VIP');
  assert.ok(near(svc.me(b.address).credits.earnedUsd, 15 * VIP_TIER_SHARES[1]), 'b is');
  assert.ok(near(svc.me(a.address).credits.earnedUsd, 15 * TIER_SHARES[2]), 'a is no VIP');
  assert.deepEqual([svc.me(b.address).vip, svc.me(b.address).credits.rates], [true, VIP_TIER_SHARES]);
  assert.deepEqual([svc.me(c.address).vip, svc.me(c.address).credits.rates], [false, TIER_SHARES]);
  vips.delete(b.address);
  L.trade(d.address, 'd2', T0 + 3, 15, 100_000);
  svc.tick();
  assert.ok(near(svc.me(b.address).credits.earnedUsd, 15 * VIP_TIER_SHARES[1] + 15 * TIER_SHARES[1]));
});

test('credits: a trickle does not switch them on for a fast trader; what runs past 0 is spent too (the balance goes below 0)', async () => {
  const inviter = wallet();
  const fresh = wallet();
  const { L, svc, join, clock } = setup({ INVITER1: inviter.address });
  assert.ok((await join(fresh, 'INVITER1')).ok);
  L.traded(fresh.address, T0 + 1, WELCOME_USD);
  // The inviter trades $1M an hour itself (at its own fee, before credits).
  L.trade(inviter.address, 'own', T0 + 10, 15, 1_000_000);
  L.trade(fresh.address, 'p', T0 + 2, 15, 2_000); // $0.30 fee -> $0.045 credit
  clock.now = T0 + 60_000;
  svc.tick();
  assert.equal(svc.me(inviter.address).credits.paying, false, '$0.045 does not cover 15 minutes of $1M an hour');

  // A slow trader with the same credit: on, and what it trades past 0 is spent too.
  const slow = wallet();
  const f2 = wallet();
  const two = setup({ SLOW1111: slow.address });
  assert.ok((await two.join(f2, 'SLOW1111')).ok);
  two.L.traded(f2.address, T0 + 1, WELCOME_USD);
  two.L.trade(f2.address, 'p', T0 + 2, 15, 3_000); // $0.0675 of credit
  two.clock.now = T0 + 60_000;
  two.svc.tick();
  assert.equal(two.svc.me(slow.address).credits.paying, true);
  two.clock.now += 1_000;
  two.L.trade(slow.address, 'big', two.clock.now, CREDIT_FEE, 1_000); // worth $0.14 of fee: more than the balance
  two.svc.tick();
  const c = two.svc.me(slow.address).credits;
  assert.equal(c.paying, false);
  assert.ok(c.balanceUsd < 0 && c.balanceUsd > -0.1, String(c.balanceUsd));
  assert.deepEqual(two.L.extra(slow.address, two.clock.now), []);
});

test('a lost referral put back on SoDEX\'s word: only the inviter SoDEX names, no loop, once; its fees count from the first visit', async () => {
  const [inv, w1, w2, w3, alt, silent] = Array.from({ length: 6 }, () => wallet().address) as [string, string, string, string, string, string];
  const inviters: Record<string, string> = { [w1]: inv, [w2]: alt, [inv]: alt, [alt]: w3, [w3]: inv, [silent]: 'SILENT' };
  const { L, s, svc } = setup({ EDDIE: inv, OTHER123: alt }, inviters);
  // It traded before it could join: that is what the lost link cost it.
  L.trade(w1, 'o1', T0 - HOUR, 15, 10_000);
  assert.deepEqual(await svc.restore(w1, inv, 'eddie', T0 - 2 * HOUR, true), { ok: true, welcome: true, vipUntil: null });
  assert.equal(s.joinOf(w1), null, 'a dry run writes nothing');
  assert.equal((await svc.restore(w1, inv, 'EDDIE', T0 - 2 * HOUR)).ok, true);
  assert.deepEqual({ ...s.joinOf(w1) }, { wallet: w1, inviter: inv, code: 'EDDIE', at: T0 - 2 * HOUR, welcome: true, vipUntil: null });
  assert.equal(svc.me(inv).stats.referred[0], 1);
  svc.tick();
  assert.ok(Math.abs(svc.me(inv).credits.earnedUsd - 10_000 * 0.00015 * TIER_SHARES[0]) < 1e-6, 'what it paid since its first visit counts');
  const no = async (w: string, by: string, code: string) => { const r = await svc.restore(w, by, code, T0); return r.ok ? 'ok' : r.why; };
  assert.equal(await no(w1, inv, 'EDDIE'), 'joined already');
  assert.match(await no(w2, inv, 'EDDIE'), /another inviter/);
  assert.match(await no(w2, inv, 'OTHER123'), /someone else's/);
  assert.match(await no(w2, inv, 'NOBODY12'), /nobody's/);
  assert.match(await no(silent, inv, 'EDDIE'), /did not answer/);
  assert.match(await no(wallet().address, inv, 'EDDIE'), /no inviter/);
  // inv -> alt -> w3 -> inv: the inviter's own other wallets.
  assert.match(await no(w3, inv, 'EDDIE'), /a loop/);
});

// Not by a literal path: the server's type check does not take the engine's own .ts imports.
const COPY_ENGINE: string = '../../../packages/copy-engine/src/api.js';
interface CopyEngine {
  SITE_TERMS_EXECUTOR: string;
  COPY_TERMS_EXECUTOR: string;
  buildCopyRequest(o: object): { action: string; owner: string; executor: string; payload: string; nonce: string; deadline: string; chainId: number };
  signCopyRequestWithKey(r: object, pk: Uint8Array): string;
  copyRequestDigest(r: object): string;
}
/** The terms as a wallet signs them in the browser (packages/copy-engine). */
async function signTerms(w: { pk: Uint8Array; address: string }, at: number, o: { action?: string; executor?: string } = {}) {
  const ce = (await import(COPY_ENGINE)) as CopyEngine;
  const req = ce.buildCopyRequest({ action: o.action ?? 'accept-site-terms', owner: w.address, executor: o.executor ?? ce.SITE_TERMS_EXECUTOR, payload: { termsVersion: '2026-11-23', agree: true }, chainId: 286623, now: at });
  return { ...req, signature: ce.signCopyRequestWithKey(req, w.pk) };
}

test('a join by the terms signature: exactly what the wallet signs, only its own, only an acceptance of the terms, only while it is fresh', async () => {
  const ce = (await import(COPY_ENGINE)) as CopyEngine;
  const w = wallet();
  const request = await signTerms(w, T0);
  assert.equal(hex(termsDigest(request)), ce.copyRequestDigest(request), 'the digest is that of the copy engine');
  const ok = checkTermsJoin({ code: 'EDDIE', request }, T0 + 1_000);
  assert.ok(ok.ok && ok.join.wallet === w.address && ok.join.code === 'EDDIE' && ok.join.nonce === `terms:${T0}`);
  assert.equal(checkTermsJoin({ code: 'EDDIE', request: await signTerms(w, T0, { action: 'accept-terms', executor: ce.COPY_TERMS_EXECUTOR }) }, T0).ok, true);
  const no = (r: ReturnType<typeof checkTermsJoin>) => (r.ok ? 'ok' : r.error);
  assert.match(no(checkTermsJoin({ code: 'EDDIE', request: { ...request, owner: wallet().address } }, T0)), /not from this wallet/);
  assert.match(no(checkTermsJoin({ code: 'EDDIE', request: { ...request, payload: '{}' } }, T0)), /not from this wallet/);
  assert.match(no(checkTermsJoin({ code: 'EDDIE', request: await signTerms(w, T0, { action: 'session', executor: 'x' }) }, T0)), /not an acceptance/);
  assert.match(no(checkTermsJoin({ code: 'EDDIE', request: await signTerms(w, T0, { executor: 'x' }) }, T0)), /not an acceptance/);
  assert.match(no(checkTermsJoin({ code: 'EDDIE', request }, T0 + 8 * DAY)), /too old/);
  assert.match(no(checkTermsJoin({ code: 'a b', request }, T0)), /not an invite code/);
  for (const bad of [null, {}, { code: 'EDDIE' }, { code: 'EDDIE', request: 'x' }, { code: 'EDDIE', request: { ...request, signature: '0x' } }]) assert.equal(checkTermsJoin(bad, T0).ok, false);
});

test('the SoDEX check: a new wallet SoDEX names an inviter for becomes its referral, whatever its browser lost; nobody else', async () => {
  const [inv, late, stranger, fresh, old, soon, traded] = Array.from({ length: 7 }, () => wallet().address) as [string, string, string, string, string, string, string];
  const inviters: Record<string, string> = { [fresh]: inv, [old]: inv, [soon]: inv, [traded]: stranger };
  const seen: Record<string, number> = { [inv]: T0 - 9 * DAY, [late]: T0 + 5 * HOUR, [fresh]: T0 + HOUR, [old]: T0 - DAY, [soon]: T0 + HOUR + 55 * 60_000, [traded]: T0 + HOUR };
  const L = fakeLedger();
  const s = new InviteStore(':memory:', T0);
  const clock = { now: T0 + 2 * HOUR };
  const asked: string[] = [];
  const svc = new InviteService(s, L.builder, {
    now: () => clock.now,
    ownerOf: async (c) => (c === 'EDDIE' ? inv : c === 'LATE1234' ? late : c === 'STRANGER' ? stranger : null),
    codeOf: async (w) => (w === inv ? 'EDDIE' : w === late ? 'LATE1234' : 'STRANGER'),
    inviterOf: async (w) => { asked.push(w); return inviters[w] === 'SILENT' ? undefined : inviters[w] ?? null; },
    people: { since: (t) => Object.entries(seen).filter(([, at]) => at >= t).map(([w, at]) => ({ wallet: w, at })), firstSeen: (w) => seen[w] ?? null },
  });
  assert.equal(await svc.autoTick(), 1);
  assert.equal(s.joinOf(fresh)?.inviter, inv);
  assert.equal(s.joinOf(fresh)?.at, T0 + HOUR, 'from its first visit');
  assert.equal(s.joinOf(old), null, 'known before the check began');
  assert.equal(s.joinOf(soon), null, 'the page has its ten minutes first');
  assert.equal(s.joinOf(traded), null, 'an inviter ValueDesk does not know');
  assert.equal(s.counted('sodex', 0), 1);
  clock.now += 10 * 60_000;
  assert.equal(await svc.autoTick(), 1);
  assert.equal(s.joinOf(soon)?.inviter, inv);
  // SoDEX silent: asked again, and it counts once it answers. An inviter that came after the wallet never does.
  const quiet = wallet().address;
  const after = wallet().address;
  seen[quiet] = clock.now; seen[after] = clock.now;
  inviters[quiet] = 'SILENT'; inviters[after] = late;
  clock.now += 11 * 60_000;
  assert.equal(await svc.autoTick(), 0);
  inviters[quiet] = inv;
  clock.now += 4 * 60_000;
  assert.equal(await svc.autoTick(), 1);
  assert.equal(s.joinOf(quiet)?.inviter, inv);
  assert.equal(s.joinOf(after), null);
  // Joined wallets are not asked about again.
  asked.length = 0;
  clock.now += 2 * HOUR;
  await svc.autoTick();
  assert.ok(!asked.includes(fresh) && !asked.includes(quiet));
});
