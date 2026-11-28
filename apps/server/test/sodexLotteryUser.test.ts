/**
 * The signed-in Blind Box relay (routes/sodexLotteryUser.ts) and what boxes paid (valuedesk/boxRewards.ts).
 * Run (from apps/server): npx tsx --test test/sodexLotteryUser.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { claimBody, readPath, signedBody, sodexLotteryUserRoutes } from '../src/routes/sodexLotteryUser.js';
import { advance, buildRewards, openOf, paidOf, tally } from '../src/valuedesk/boxRewards.js';

const TOKEN = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIweGFiYyJ9.c2lnbmF0dXJlLXBhcnQ';
const SIG = `0x${'ab'.repeat(65)}`;

test('reads: only the listed paths and their query keys, values by shape', () => {
  assert.equal(readPath('boxes', { limit: '50', offset: '0', junk: 'x' }), '/boxes?limit=50&offset=0');
  assert.equal(readPath('box/sign-params', { action: 'merge' }), '/box/sign-params?action=merge');
  assert.equal(readPath('box/sign-params', {}), null, 'the action is required');
  assert.equal(readPath('box/sign-params', { action: 'transfer' }), null);
  assert.equal(readPath('job/abc-123', {}), '/job/abc-123');
  assert.equal(readPath('job/../meta', {}), null);
  assert.equal(readPath('admin', {}), null);
  assert.equal(readPath('ledger', { type: 'merge' }), '/ledger?type=merge');
  assert.equal(readPath('ledger', { type: 'x;y' }), null);
});

test('an open or a merge is rebuilt from its four fields; anything else is dropped or refused', () => {
  assert.deepEqual(signedBody({ tokenIds: [3, '1'], nonce: '7', deadline: 1795800000, signature: SIG, owner: '0xevil' }), { tokenIds: ['3', '1'], nonce: '7', deadline: '1795800000', signature: SIG });
  assert.equal(signedBody({ tokenIds: [], nonce: '1', deadline: '1', signature: SIG }), null);
  assert.equal(signedBody({ tokenIds: ['1'], nonce: '1', deadline: '1', signature: '0x12' }), null);
  assert.equal(signedBody({ tokenIds: ['-1'], nonce: '1', deadline: '1', signature: SIG }), null);
  assert.equal(signedBody({ tokenIds: Array.from({ length: 257 }, (_, i) => i), nonce: '1', deadline: '1', signature: SIG }), null);
  assert.deepEqual(claimBody({ count: 5, source: 'trade', extra: 1 }), { count: 5, source: 'trade' });
  assert.equal(claimBody({ count: 0 }), null);
});

test('the relay passes the user\'s token and the checked body, sets no other header, and turns "unauthorized" into a 401', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    if (url.endsWith('/boxes')) return new Response(JSON.stringify({ code: -1, msg: 'unauthorized: invalid token' }), { status: 200 });
    return new Response(JSON.stringify({ code: 0, data: { jobId: 'j1', kind: 'open', status: 'pending' } }), { status: 200 });
  }) as unknown as typeof fetch;
  const app = Fastify();
  await app.register(sodexLotteryUserRoutes({ fetchImpl: fake, base: 'https://lot.test/api' }));

  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/sodex/lottery/u/boxes' })).statusCode, 401, 'no token, nothing sent');
  assert.equal(seen.length, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/sodex/lottery/u/meta', headers: { authorization: TOKEN } })).statusCode, 404);

  const r = await app.inject({ method: 'GET', url: '/api/vs/sodex/lottery/u/boxes', headers: { authorization: TOKEN } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.headers['cache-control'], 'no-store');

  const o = await app.inject({ method: 'POST', url: '/api/vs/sodex/lottery/u/box/open', headers: { authorization: TOKEN, 'content-type': 'application/json' }, payload: { tokenIds: ['5'], nonce: '9', deadline: '99', signature: SIG, to: '0xbad' } });
  assert.equal(o.statusCode, 200);
  assert.equal(o.json().data.jobId, 'j1');
  const last = seen.at(-1)!;
  assert.equal(last.url, 'https://lot.test/api/box/open');
  assert.deepEqual(JSON.parse(String(last.init.body)), { tokenIds: ['5'], nonce: '9', deadline: '99', signature: SIG });
  assert.deepEqual(Object.keys(last.init.headers as Record<string, string>).sort(), ['Accept', 'Authorization', 'Content-Type']);
  assert.equal((last.init.headers as Record<string, string>).Authorization, TOKEN);
  assert.equal((await app.inject({ method: 'POST', url: '/api/vs/sodex/lottery/u/box/merge', headers: { authorization: TOKEN, 'content-type': 'application/json' }, payload: { tokenIds: ['5'] } })).statusCode, 400);
});

const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const topic = (n: number) => `0x${w(n)}`;
const openLog = (rid: number, ids: number[], block: number) => ({ topics: ['0xaca65089642eb3213ea21bd970b49c78f1000a823c5a5a65ae5c6433b76e4d8a', topic(rid), topic(1), topic(2)], data: `0x${w(32)}${w(ids.length)}${ids.map(w).join('')}`, blockNumber: `0x${block.toString(16)}` });
/** tokens at 0x60, rewards after it, amounts last: Solidity's layout for (address[], uint256[], uint256[]). */
const paidLog = (rid: number, usd: number[], block: number) => {
  const n = usd.length;
  const tokens = `${w(n)}${usd.map(() => w(0xdb)).join('')}`;
  const rewards = `${w(n)}${usd.map((u) => w(Math.round(u * 1e6))).join('')}`;
  const amounts = `${w(n)}${usd.map(() => w(1)).join('')}`;
  const o1 = 96; const o2 = o1 + 32 * (n + 1); const o3 = o2 + 32 * (n + 1);
  return { topics: ['0xab283dcfb79e5b773038ab108c0caa5afaaaa0a882ae47598fc62176df443dc6', topic(rid), topic(1)], data: `0x${w(o1)}${w(o2)}${w(o3)}${tokens}${rewards}${amounts}`, blockNumber: `0x${block.toString(16)}` };
};

test('logs: an open names its boxes, a payout each box\'s USD', () => {
  assert.deepEqual(openOf(openLog(26456, [197778, 5], 1)), { requestId: '26456', ids: ['197778', '5'] });
  assert.deepEqual(paidOf(paidLog(26456, [1, 1.65, 1], 1)), { requestId: '26456', rewards: [1_000_000, 1_650_000, 1_000_000] });
  // The one-token event, as logged for request 23233 (block 16,737,060): one box, $1 in vsoUSDC.
  const one = { topics: ['0xf52bf02fadcc9fd50899c4b99bc93c3ba801e2c4db2c25814efcfbc088493685', topic(0x5ac1), topic(7), topic(0xdb)], data: `0x${w(0x40)}${w(10n ** 18n)}${w(1)}${w(1_000_000)}` };
  assert.deepEqual(paidOf(one), { requestId: String(0x5ac1), rewards: [1_000_000] });
});

test('the history: payouts matched to their open, across reads, each box at its tier; tallies', async () => {
  const levels: Record<string, number> = { 10: 0, 11: 0, 12: 1, 13: 0 };
  let head = 16_400_000 + 30_000;
  const rpc = async (m: string, p: unknown[]): Promise<unknown> => {
    if (m === 'eth_blockNumber') return `0x${head.toString(16)}`;
    if (m === 'eth_call') {
      const data = (p[0] as { data: string }).data.slice(10);
      const ids = (data.match(/.{64}/g) ?? []).slice(2).map((x) => String(BigInt(`0x${x}`)));
      return `0x${w(32)}${w(ids.length)}${ids.map((id) => w(levels[id]!)).join('')}`;
    }
    const f = p[0] as { fromBlock: string; toBlock: string; topics: unknown[] };
    const from = Number(f.fromBlock); const to = Number(f.toBlock);
    const all = String(f.topics[0]).startsWith('0xaca6')
      ? [openLog(1, [10, 11], 16_400_010), openLog(2, [12], 16_420_000), openLog(3, [13], 16_425_000)]
      : [paidLog(1, [1, 2], 16_400_011), paidLog(2, [50], 16_420_001)];
    return all.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
  };
  const st = { v: 1 as const, cursor: 16_400_000, pending: {}, paid: [] as Array<[number, number, number]>, opens: 0, firstBlock: null as number | null };
  await advance(st, rpc);
  assert.equal(st.opens, 3);
  assert.deepEqual(st.paid.map((p) => [p[0], p[2]]), [[0, 1_000_000], [0, 2_000_000], [1, 50_000_000]]);
  assert.deepEqual(Object.keys(st.pending), ['3'], 'an open not paid yet waits');
  head += 1;
  await advance(st, rpc);
  const d = buildRewards(st, head, 16_410_000, 1);
  assert.equal(d.levels.Common?.n, 2);
  assert.equal(d.levels.Common?.avg, 1.5);
  assert.equal(d.levels.Uncommon?.median, 50);
  assert.equal(d.levels.Common?.recent, null, 'both Common boxes were paid before the last 30 days');
  assert.deepEqual(tally([1, 2, 3, 10]), { n: 4, avg: 4, median: 2.5, p25: 1.75, p75: 4.75, low: 1, high: 10, total: 16 });
});
