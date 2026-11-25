/** The weekly claim of fee credits (claim.ts): its weeks, its window, what it gives once, what lapses, and who may sign it. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { BuilderService } from '../src/builder/service.js';
import { CLAIM_STATEMENT, WEEK_MS, claimWindow, weekOf, weekStart, type CreditClaim } from '../src/invites/claim.js';
import { checkCreditClaim, creditClaimDigest } from '../src/invites/check.js';
import { InviteService } from '../src/invites/service.js';
import { InviteStore } from '../src/invites/store.js';
import { inviteRoutes } from '../src/routes/invites.js';

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
function wallet() {
  const pk = secp256k1.utils.randomPrivateKey();
  return { pk, address: hex(keccak_256(secp256k1.getPublicKey(pk, false).slice(1)).slice(12)) };
}
function sign(w: { pk: Uint8Array; address: string }, week: number, now: number, over: Partial<CreditClaim> = {}): CreditClaim {
  const f = { wallet: w.address, week, statement: CLAIM_STATEMENT, nonce: 'b'.repeat(32), issuedAt: String(now), expiresAt: String(now + 5 * 60_000), chainId: 286623, ...over };
  const sig = secp256k1.sign(creditClaimDigest(f), w.pk);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return { ...f, signature: hex(out) };
}

/** Tuesday 2027-01-05 12:00 UTC. */
const TUE = Date.UTC(2027, 0, 5, 12);
const W = weekOf(TUE);
const HOUR = 3_600_000;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function setup(from = TUE) {
  const s = new InviteStore(':memory:', from);
  const clock = { now: from };
  const builder = {
    tiers: { current: () => ({ builderId: 7 }) },
    store: { wallet: () => null, countedOrders: () => [], tradedMicro: () => ({ perps: 0, spot: 0 }), readThrough: () => 0, oldestOpen: () => null },
    standardFee: () => 15, setExtraPrograms() {}, setPerkBudget() {}, vipNow: () => false, vipProgramOf: () => null,
  } as unknown as BuilderService;
  const svc = new InviteService(s, builder, { now: () => clock.now, isVip: () => false });
  let n = 0;
  const earn = (a: string, usd: number, at: number, tier = 1) => s.take(`e:${n}`, `o${n++}`, 1, [{ address: a, kind: 'earn', micro: usd * 1e6, source: '0x1111111111111111111111111111111111111111', tier }], at);
  const spend = (a: string, usd: number, at: number) => s.take(`s:${n}`, `o${n++}`, 1, [{ address: a, kind: 'spend', micro: usd * 1e6, source: null, tier: null }], at);
  return { s, svc, clock, earn, spend };
}

test("weeks run Tuesday 12:00 UTC to Tuesday 12:00 UTC, as SoDEX's own", () => {
  assert.equal(new Date(weekStart(W)).toISOString(), '2027-01-05T12:00:00.000Z');
  assert.equal(new Date(weekStart(W)).getUTCDay(), 2);
  assert.equal(weekOf(TUE - 1), W - 1);
  assert.equal(weekOf(TUE + WEEK_MS - 1), W);
  // SoDEX, live 2026-11-25: week 13 ends 1796126400 (nextWeekStartTime).
  assert.equal((1_796_126_400_000 - weekStart(0)) % WEEK_MS, 0);
  assert.deepEqual(claimWindow(TUE + HOUR), { week: W - 1, opensAt: TUE, closesAt: TUE + WEEK_MS });
  assert.deepEqual(claimWindow(TUE - 1), { week: W - 2, opensAt: TUE - WEEK_MS, closesAt: TUE });
});

test("a week is earned, then claimable for exactly the next 7 days, once, by the wallet's signature", () => {
  const { svc, clock, earn } = setup();
  const w = wallet();
  earn(w.address, 2, TUE + HOUR);
  earn(w.address, 1, TUE + WEEK_MS - 1, 2); // the week's last millisecond
  clock.now = TUE + 2 * HOUR;
  let c = svc.claimsOf(w.address);
  assert.deepEqual([c.usd, c.claimed, c.pendingUsd], [0, false, 3]);
  assert.equal(svc.me(w.address).credits.balanceUsd, 0, 'earned, not claimable yet: pays nothing');
  assert.equal(svc.me(w.address).credits.earnedUsd, 3);
  svc.tick();
  assert.equal(svc.me(w.address).credits.paying, false);
  assert.deepEqual(svc.claim(sign(w, W, clock.now)), { ok: false, code: 'closed' }, 'its own week is still running');
  // One millisecond before the Tuesday: still closed. At the Tuesday: open.
  clock.now = TUE + WEEK_MS - 1;
  assert.deepEqual(svc.claim(sign(w, W, clock.now)), { ok: false, code: 'closed' });
  clock.now = TUE + WEEK_MS;
  earn(w.address, 5, clock.now); // the next week's
  c = svc.claimsOf(w.address);
  assert.deepEqual([c.week, c.usd, c.claimed, c.pendingUsd, c.opensAt, c.closesAt], [W, 3, false, 5, TUE + WEEK_MS, TUE + 2 * WEEK_MS]);
  // The last moment of the window.
  clock.now = TUE + 2 * WEEK_MS - 1;
  assert.deepEqual(svc.claim(sign(w, W, clock.now)), { ok: true, usd: 3 });
  assert.deepEqual(svc.claim(sign(w, W, clock.now)), { ok: false, code: 'claimed' });
  const me = svc.me(w.address);
  assert.ok(near(me.credits.balanceUsd, 3) && near(me.credits.earnedUsd, 8));
  assert.deepEqual([me.claims!.claimed, me.claims!.usd, me.claims!.claimedUsd, me.claims!.lapsedUsd], [true, 3, 3, 0]);
  assert.equal(me.credits.paying, true, 'claimed credits pay at once');
  assert.equal(me.history[0]!.kind, 'claim');
});

test('not claimed in its 7 days: the week lapses, nothing else does; the record keeps every entry', () => {
  const { s, svc, clock, earn, spend } = setup();
  const w = wallet();
  earn(w.address, 2, TUE + HOUR);
  earn(w.address, 4, TUE + WEEK_MS + HOUR);
  clock.now = TUE + 2 * WEEK_MS; // week W's claim has just closed; W + 1's is open
  assert.deepEqual(svc.claim(sign(w, W, clock.now)), { ok: false, code: 'closed' });
  const c = svc.claimsOf(w.address);
  assert.deepEqual([c.week, c.usd, c.lapsedUsd, c.claimedUsd], [W + 1, 4, 2, 0]);
  assert.deepEqual(svc.claim(sign(w, W + 1, clock.now)), { ok: true, usd: 4 });
  assert.ok(near(svc.me(w.address).credits.balanceUsd, 4));
  // A claimed credit stays, however many weeks pass, and is spent like any other.
  clock.now = TUE + 30 * WEEK_MS;
  spend(w.address, 1.5, clock.now);
  const me = svc.me(w.address);
  assert.ok(near(me.credits.balanceUsd, 2.5));
  assert.deepEqual([me.claims!.lapsedUsd, me.claims!.claimedUsd], [2, 4]);
  assert.equal((s.db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n, 3, 'nothing deleted');
  // Earned = claimed + lapsed + open + running, always.
  assert.ok(near(me.credits.earnedUsd, me.claims!.claimedUsd + me.claims!.lapsedUsd + (me.claims!.claimed ? 0 : me.claims!.usd) + me.claims!.pendingUsd));
});

test('credits from before the claims began need none; the week they began in counts only from that moment', () => {
  const mid = TUE + 3 * 86_400_000;
  const { svc, clock, earn } = setup(mid);
  const w = wallet();
  earn(w.address, 10, mid - 1);
  earn(w.address, 1, mid + HOUR);
  clock.now = mid + 2 * HOUR;
  assert.ok(near(svc.me(w.address).credits.balanceUsd, 10));
  clock.now = TUE + WEEK_MS;
  assert.equal(svc.claimsOf(w.address).usd, 1);
  assert.deepEqual(svc.claim(sign(w, W, clock.now)), { ok: true, usd: 1 });
  assert.ok(near(svc.me(w.address).credits.balanceUsd, 11));
});

test("nothing to claim, another wallet's claim, a changed week, an old or edited signature: refused", () => {
  const { svc, clock, earn } = setup();
  const w = wallet();
  const other = wallet();
  earn(w.address, 2, TUE + HOUR);
  clock.now = TUE + WEEK_MS + HOUR;
  assert.deepEqual(svc.claim(sign(other, W, clock.now)), { ok: false, code: 'nothing' });
  const good = sign(w, W, clock.now);
  assert.equal(checkCreditClaim(good, clock.now).ok, true);
  for (const bad of [null, {}, { ...good, wallet: other.address }, { ...good, week: W + 1 }, { ...good, week: -1 }, { ...good, statement: 'x' }, { ...good, nonce: 'c'.repeat(32) }, { ...good, signature: '0x' }, { ...good, chainId: 0 }]) assert.equal(checkCreditClaim(bad, clock.now).ok, false);
  assert.equal(checkCreditClaim(good, clock.now + 6 * 60_000).ok, false, 'expired');
  assert.equal(checkCreditClaim(sign(w, W, clock.now, { expiresAt: String(clock.now + HOUR) }), clock.now).ok, false, 'valid too long');
});

test('by day: every day of the ledger summed, past what the history lists', () => {
  const { s, svc, clock, earn, spend } = setup();
  const w = wallet();
  for (let i = 0; i < 700; i++) earn(w.address, 0.01, TUE + i * 60_000, (i % 3) + 1);
  spend(w.address, 0.5, TUE + HOUR);
  clock.now = TUE + 86_400_000;
  const me = svc.me(w.address);
  assert.equal(me.history.length, 300);
  const sum = me.days!.filter((d) => d.kind === 'earn').reduce((x, d) => x + d.usd, 0);
  assert.ok(Math.abs(sum - 7) < 1e-6 && Math.abs(sum - me.credits.earnedUsd) < 1e-6);
  assert.deepEqual([...new Set(me.days!.filter((d) => d.kind === 'earn').map((d) => d.tier))].sort(), [1, 2, 3]);
  assert.ok(s.days(w.address).every((d, i, xs) => i === 0 || xs[i - 1]!.day <= d.day));
});

test('a file from before the claims opens with its credits given, and keeps its start over restarts', () => {
  const { s, svc, earn } = setup(TUE);
  const w = wallet();
  earn(w.address, 7, TUE - WEEK_MS);
  assert.equal(svc.me(w.address).credits.balanceUsd, 7);
  assert.equal(s.claimsFrom(), TUE);
  s.db.prepare("INSERT OR IGNORE INTO grants (address, reason, micro, at) VALUES ('*', 'claims-from', 0, ?)").run(TUE + WEEK_MS); // what a second start runs
  assert.equal(s.claimsFrom(), TUE);
});

test('the route: a signed claim, once; a forged or early one never', async () => {
  const { svc, clock, earn } = setup();
  const w = wallet();
  earn(w.address, 2, TUE + HOUR);
  const app = Fastify();
  await app.register(inviteRoutes, { service: svc, keep: false, now: () => clock.now });
  after(() => app.close());
  const post = (claim: unknown) => app.inject({ method: 'POST', url: '/api/vs/invites/claim', payload: { claim } as object });
  clock.now = TUE + 2 * HOUR;
  const early = await post(sign(w, W, clock.now));
  assert.deepEqual([early.statusCode, early.json().code], [409, 'closed']);
  clock.now = TUE + WEEK_MS + HOUR;
  assert.equal((await post({ ...sign(w, W, clock.now), wallet: wallet().address })).statusCode, 400);
  const ok = await post(sign(w, W, clock.now));
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true, usd: 2, week: W }]);
  const again = await post(sign(w, W, clock.now));
  assert.deepEqual([again.statusCode, again.json().code], [409, 'claimed']);
  const me = (await app.inject({ method: 'GET', url: `/api/vs/invites/me?address=${w.address}` })).json();
  assert.deepEqual([me.claims.claimed, me.claims.usd, me.credits.balanceUsd], [true, 2, 2]);
});
