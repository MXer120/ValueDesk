/** SoDEX's referral rewards: its answers read as its own page reads them, what is claimable, the claim, the line over time. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3';
import { CLAIMED_SELECTOR, CLAIMED_TOPIC, SodexClaimError, claimAmount, claimRebates, claimedIn, claimableOf, claimedCall, fetchClaimed, floorCents, parseClaims, parseStats, parseTraders, settledPoint, timeMs, usdcLine } from './sodexRewards';
import { SodexError, type authedPost } from '../points';
import type { rpcCall } from '../trading/rpc';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const A = '0x07ad6e4570b312db5316e2567d7c516d7424fc3b';

/** The shape SoDEX's own page reads (its gbe, 2026-11-25). */
const STATS = {
  eligible: true, referrerState: { stage: 'ready', data: { code: 'SAMPLE', canModify: false, totalReferrals: 12 } },
  earnedRewardsOnChain: '46.5', totalFeesEarned: 51.25, pendingRewards: 4.75, cumVlm: 2500, vlmThreshold: 2000, vaultNetStake: 0, vaultNetStakeThreshold: 500,
  weeklyInviteCount: 3, maxInvitesPerWeek: 100, nextAvailableTime: 1_796_126_400_000, referredBy: { code: 'OTHER' }, bonusDistributions: [],
};

test('myStats: strings and numbers alike; unlocked by volume or by stake; nothing made up where SoDEX sends nothing', () => {
  const s = parseStats(STATS);
  assert.deepEqual([s.settledUsd, s.pendingUsd, s.totalUsd, s.unlocked, s.traders, s.weekInvites, s.weekInvitesMax, s.code, s.referredBy, s.nextAt], [46.5, 4.75, 51.25, true, 12, 3, 100, 'SAMPLE', 'OTHER', 1_796_126_400_000]);
  assert.equal(parseStats({ ...STATS, cumVlm: 1999 }).unlocked, false);
  assert.equal(parseStats({ ...STATS, cumVlm: 0, vaultNetStake: 500 }).unlocked, true);
  const none = parseStats({ cumVlm: 0, vlmThreshold: 2000, vaultNetStake: 0, vaultNetStakeThreshold: 500, referrerState: { stage: 'locked' } });
  assert.deepEqual([none.settledUsd, none.totalUsd, none.unlocked, none.code, none.weekInvitesMax, none.nextAt, none.referredBy], [0, 0, false, null, null, null, null]);
});

test('claims and traders: every field SoDEX lists, times in ms, seconds or text; a row without a time is left out', () => {
  assert.equal(timeMs(1_795_000_000), 1_795_000_000_000);
  assert.equal(timeMs(1_795_000_000_000), 1_795_000_000_000);
  assert.equal(timeMs('2026-11-25T12:00:00Z'), Date.UTC(2026, 10, 25, 12));
  assert.equal(timeMs('x'), null);
  // `fees` is not the claim's amount (it carried the running total, raw): the amount comes from the transaction.
  const c = parseClaims({ total: 2, list: [{ fees: '610228924', txHash: `0x${'AB'.repeat(32)}`, time: 1_795_000_000_000 }, { fees: 3, txHash: '', time: 1_795_000_100 }, { fees: 9 }] });
  assert.deepEqual(c, { total: 2, list: [{ usd: null, at: 1_795_000_000_000, tx: `0x${'ab'.repeat(32)}` }, { usd: null, at: 1_795_000_100_000, tx: null }] });
  assert.deepEqual(parseClaims(null), { total: 0, list: [] });
  const t = parseTraders({ total: 1, list: [{ inviteeWallet: '0xABC', volume: 1000, paidFees: 1, yourRewardedFees: '0.1', yourRewardedPoints: 7, referralTime: 1_795_000_000_000 }] });
  assert.deepEqual(t.list, [{ wallet: '0xabc', volumeUsd: 1000, rebateUsd: 0.1, points: 7, at: 1_795_000_000_000 }]);
});

test("claimable is SoDEX's own arithmetic, never a cent more", () => {
  assert.equal(claimableOf(46.5, 44.399382), 46.5 - 44.399382);
  assert.equal(claimableOf(46.5, 50), 0);
  assert.equal(claimableOf(46.5, null), null);
  assert.equal(floorCents(2.109), 2.1);
  assert.equal(floorCents(0.29), 0.29);
});

test('the claimed amount is read from the rewards contract: its selector, its three arguments, 6 decimals', async () => {
  assert.equal(CLAIMED_SELECTOR, `0x${hex(keccak_256(new TextEncoder().encode('getClaimedAmount(uint256,address,address)'))).slice(0, 8)}`);
  const d = claimedCall(A);
  assert.equal(d.length, 2 + 8 + 64 * 3);
  assert.equal(d.slice(10, 74), '2'.padStart(64, '0'));
  assert.equal(d.slice(74, 138), A.slice(2).padStart(64, '0'));
  assert.equal(d.slice(138), 'cb7f80dff2727c791fa491722c428e6657f7e2c6'.padStart(64, '0'));
  // What the chain answered for this claimer on 2026-11-25.
  const call = (async () => ({ result: '0x0000000000000000000000000000000000000000000000000000000002a57b16' })) as unknown as typeof rpcCall;
  assert.equal(await fetchClaimed(A, call), 44.399382);
  assert.equal(await fetchClaimed(A, (async () => ({ error: { message: 'x' } })) as unknown as typeof rpcCall), null);
  assert.equal(await fetchClaimed(A, (async () => { throw new Error('offline'); }) as unknown as typeof rpcCall), null);
});

/** A Claimed event as the contract writes it (tx 0x18f257d8…, 2026-11-25 23:18 UTC: 1.97242 USDC to 0xc5f7…b347). */
const U = '0xc5f733dbd2ec75c7720902ba4c5a1e0490dcb347';
const pad = (h: string) => `0x${h.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
const claimedLog = (user: string, micro: bigint) => ({
  address: '0x4e0ced3cb2775a82718f9a29c5f86a34169958ec',
  topics: [CLAIMED_TOPIC, pad('2'), pad(user), pad('0xcb7f80dff2727c791fa491722c428e6657f7e2c6')],
  data: `0x${micro.toString(16).padStart(64, '0')}${'1'.padStart(64, '0')}`,
});
const transfer = { address: '0xcb7f80dff2727c791fa491722c428e6657f7e2c6', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad('0x4e0ced3cb2775a82718f9a29c5f86a34169958ec'), pad('0x0101010101010101010101010101010101010101')], data: pad('1e18c4') };

test("a claim's amount: the contract's Claimed event for this wallet and USDC, 6 decimals; nothing else counts", async () => {
  assert.equal(CLAIMED_TOPIC, `0x${hex(keccak_256(new TextEncoder().encode('Claimed(uint256,address,address,uint256,bool)')))}`);
  assert.equal(claimedIn([transfer, claimedLog(U, 1_972_420n)], U), 1.97242);
  assert.equal(claimedIn([claimedLog(U, 1_972_420n)], A), null, "another wallet's claim");
  assert.equal(claimedIn([transfer], U), null);
  const receipt = (logs: unknown[], status = '0x1') => (async () => ({ result: { status, logs } })) as unknown as typeof rpcCall;
  assert.equal(await claimAmount(`0x${'18'.repeat(32)}`, U, receipt([transfer, claimedLog(U, 1_972_420n)])), 1.97242);
  assert.equal(await claimAmount(`0x${'19'.repeat(32)}`, U, receipt([claimedLog(U, 5n)], '0x0')), null, 'a failed transaction paid nothing');
  assert.equal(await claimAmount(`0x${'1a'.repeat(32)}`, U, (async () => { throw new Error('offline'); }) as unknown as typeof rpcCall), null);
});

test('the claim: paid, sent and confirmed, sent and failed, claimed already, busy, and no result; the amount from the chain', async () => {
  const post = (d: unknown) => (async () => d) as unknown as typeof authedPost;
  const fail = (code: number) => (async () => { throw new SodexError('x', code); }) as unknown as typeof authedPost;
  const none = (async () => ({ result: null })) as unknown as typeof rpcCall;
  const wait = async () => {};
  const paid = (async () => ({ result: { status: '0x1', logs: [claimedLog(A, 4_200_000n)] } })) as unknown as typeof rpcCall;
  // SoDEX's `amount` is not taken: the chain's is (here 4.2 where SoDEX said 610228924).
  assert.deepEqual(await claimRebates(A, { post: post({ results: [{ amount: '610228924', status: 2, txHash: '0x1' }] }), call: paid, wait }), { usd: 4.2, tx: '0x1' });
  assert.deepEqual(await claimRebates(A, { post: post({ results: [{ amount: '4.2', status: 2, txHash: '0x5' }] }), call: none, wait }), { usd: null, tx: '0x5' }, 'unread: no amount rather than a wrong one');
  let asked = 0;
  const later = (async () => ({ result: ++asked < 3 ? null : { status: '0x1', logs: [claimedLog(A, 1_500_000n)] } })) as unknown as typeof rpcCall;
  assert.deepEqual(await claimRebates(A, { post: post({ results: [{ amount: 1.5, status: 1, txHash: '0x2' }] }), call: later, wait }), { usd: 1.5, tx: '0x2' });
  assert.equal(asked, 3);
  const kind = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof SodexClaimError ? e.kind : 'other'));
  assert.equal(await kind(claimRebates(A, { post: post({ results: [{ amount: 1, status: 1, txHash: '0x3' }] }), call: (async () => ({ result: { status: '0x0' } })) as unknown as typeof rpcCall, wait })), 'failed');
  assert.equal(await kind(claimRebates(A, { post: post({ results: [{ amount: 1, status: 1, txHash: '0x3' }] }), call: none, wait })), 'slow');
  assert.equal(await kind(claimRebates(A, { post: fail(-3001111), wait })), 'claimed');
  assert.equal(await kind(claimRebates(A, { post: fail(-3000010), wait })), 'busy');
  assert.equal(await kind(claimRebates(A, { post: fail(-1), wait })), 'other');
  assert.equal(await kind(claimRebates(A, { post: post({ results: [] }), wait })), 'failed');
  assert.equal(await kind(claimRebates(A, { post: post({ results: [{ amount: 1, status: 3 }] }), wait })), 'failed');
});

test('the line: claims, totals seen and the total now; it never falls and never goes past what is known', () => {
  const now = 1_000_000;
  const claims = [{ usd: 3, at: 400, tx: null }, { usd: 2, at: 200, tx: null }];
  assert.deepEqual(usdcLine(claims, [], 7, now), [{ t: 200, v: 2 }, { t: 400, v: 5 }, { t: now, v: 7 }]);
  // A visit between the claims saw more than had been claimed by then; the next claim adds nothing to it.
  assert.deepEqual(usdcLine(claims, [{ t: 300, usd: 5.5 }], 7, now), [{ t: 200, v: 2 }, { t: 300, v: 5.5 }, { t: now, v: 7 }]);
  assert.deepEqual(usdcLine([], [], 0, now), [{ t: now, v: 0 }]);
  // SoDEX corrected a total down: the line ends at what it says now.
  const down = usdcLine([], [{ t: 100, usd: 9 }], 6, now);
  assert.equal(down[down.length - 1]!.v, 6);
  assert.ok(down.every((p, i) => i === 0 || p.v >= down[i - 1]!.v));
});

test('the last Tuesday: what is settled now has been since 12:00 UTC; never placed there while the next one may be in already', () => {
  const tue = Date.UTC(2026, 10, 24, 12);
  assert.deepEqual(settledPoint(12.82, tue + 1), { t: tue, v: 12.82 });
  assert.deepEqual(settledPoint(12.82, tue + 6 * 86_400_000), { t: tue, v: 12.82 });
  assert.equal(settledPoint(12.82, tue + 7 * 86_400_000 - 3 * 3_600_000), null, 'Tuesday 09:00: SoDEX may have settled the next week');
  assert.equal(settledPoint(0, tue + 1), null);
  const now = tue + 30 * 3_600_000;
  const claims = [{ usd: 3.18, at: tue - 11 * 86_400_000, tx: null }, { usd: 5.44, at: tue - 4 * 86_400_000, tx: null }];
  assert.deepEqual(usdcLine(claims, [], 14.3, now, settledPoint(12.82, now)).map((p) => [p.t, Number(p.v.toFixed(2))]), [[claims[0]!.at, 3.18], [claims[1]!.at, 8.62], [tue, 12.82], [now, 14.3]]);
});
