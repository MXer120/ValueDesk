/**
 * SoDEX's weeks on the Referrals page (claim.ts): its claim weeks, its weekly join quota for ValueDesk's codes too; fee
 * credits pay as they are earned (no claim, owner 2026-11-26); the ledger by day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { BuilderService } from '../src/builder/service.js';
import { INVITES_PER_WEEK, WEEK_MS, claimWindow, inviteWeekStart, weekOf, weekStart, type InviteJoin } from '../src/invites/claim.js';
import { InviteService } from '../src/invites/service.js';
import { InviteStore } from '../src/invites/store.js';

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
const wallet = () => hex(keccak_256(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), false).slice(1)).slice(12));

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

test('fee credits need no claim: earned, they count at once, whenever earned; spent, they go', () => {
  const { svc, clock, earn, spend } = setup();
  const w = wallet();
  earn(w, 2, TUE + HOUR);
  earn(w, 1, TUE + 3 * WEEK_MS + HOUR, 2);
  clock.now = TUE + 3 * WEEK_MS + 2 * HOUR;
  let me = svc.me(w);
  assert.ok(near(me.credits.balanceUsd, 3) && near(me.credits.earnedUsd, 3));
  assert.equal('claims' in me, false, 'nothing to claim');
  spend(w, 0.5, clock.now);
  me = svc.me(w);
  assert.ok(near(me.credits.balanceUsd, 2.5));
});

test("SoDEX's quota: 3 joins a code a week, from Monday 00:00 UTC; a join SoDEX made is counted, never refused", () => {
  assert.equal(INVITES_PER_WEEK, 3);
  const mon = Date.UTC(2027, 0, 4);
  assert.equal(new Date(mon).getUTCDay(), 1);
  assert.equal(inviteWeekStart(mon), mon);
  assert.equal(inviteWeekStart(mon + 6 * 86_400_000 + 86_399_999), mon);
  assert.equal(inviteWeekStart(mon - 1), mon - 7 * 86_400_000);
  const { s, svc, clock } = setup(mon);
  const owner = wallet();
  const join = (via: 'signed' | 'terms' | 'sodex', at: number) => {
    const j: InviteJoin = { wallet: wallet(), code: 'FRIEND01', statement: '', nonce: 'n', issuedAt: String(at), expiresAt: String(at), chainId: 286623, signature: '0x' };
    return s.join(j, owner, { hasVolume: false, welcome: true, via }, at);
  };
  for (let i = 0; i < 3; i++) assert.equal(join(i === 1 ? 'terms' : 'signed', mon + i * 86_400_000).ok, true);
  const full = join('signed', mon + 3 * 86_400_000);
  assert.deepEqual([full.ok, !full.ok && full.code], [false, 'limit']);
  assert.equal(join('terms', mon + 3 * 86_400_000).ok, false);
  assert.equal(join('sodex', mon + 3 * 86_400_000).ok, true, 'SoDEX bound it: its quota let it through');
  clock.now = mon + 3 * 86_400_000;
  assert.deepEqual(svc.fullOf(owner, clock.now), { full: { until: mon + 7 * 86_400_000 } });
  assert.deepEqual(svc.me(owner).invites, { week: 4, max: 3, resetsAt: mon + 7 * 86_400_000 });
  // Monday again: room for three more.
  assert.equal(join('signed', mon + 7 * 86_400_000).ok, true);
  assert.deepEqual(svc.fullOf(owner, mon + 7 * 86_400_000), {});
});

test('by day: every day of the ledger summed, past what the history lists', () => {
  const { s, svc, clock, earn, spend } = setup();
  const w = wallet();
  for (let i = 0; i < 700; i++) earn(w, 0.01, TUE + i * 60_000, (i % 3) + 1);
  spend(w, 0.5, TUE + HOUR);
  clock.now = TUE + 86_400_000;
  const me = svc.me(w);
  assert.equal(me.history.length, 300);
  const sum = me.days!.filter((d) => d.kind === 'earn').reduce((x, d) => x + d.usd, 0);
  assert.ok(Math.abs(sum - 7) < 1e-6 && Math.abs(sum - me.credits.earnedUsd) < 1e-6);
  assert.deepEqual([...new Set(me.days!.filter((d) => d.kind === 'earn').map((d) => d.tier))].sort(), [1, 2, 3]);
  assert.ok(s.days(w).every((d, i, xs) => i === 0 || xs[i - 1]!.day <= d.day));
});
