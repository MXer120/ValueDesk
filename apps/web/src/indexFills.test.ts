/**
 * vsApi.fills through the index (indexFills.ts): the index's fills where it holds the window, the venue's
 * own read exactly as before where it does not, and the venue only for the tail after `heldTo`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VsFill } from '@sign/valuedesk/types.js';
import { TAIL_SLACK_MS, fillsWithIndex, indexFillsPath, indexPositions, type FillsQuery, type IndexFillsAnswer } from './indexFills';

const NOW = 1_800_000_000_000;
const A = '0x' + 'a'.repeat(40);
const f = (id: string, time: number, symbol = 'BTC'): VsFill => ({
  id, time, symbol, side: 'buy', px: 1, sz: 1, notional: 1, fee: null, closedPnl: null, dir: null, oid: null,
});

function io(answer: IndexFillsAnswer | null | Error, venueFills: VsFill[] = []) {
  const paths: string[] = [];
  const asked: FillsQuery[] = [];
  return {
    paths,
    asked,
    io: {
      index: async (p: string) => {
        paths.push(p);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      direct: async (o: FillsQuery) => {
        asked.push(o);
        return venueFills.filter((x) => (o.from === undefined || x.time >= o.from) && (o.to === undefined || x.time <= o.to)).slice(0, o.limit ?? 2000);
      },
      now: () => NOW,
    },
  };
}

test('the path: venue and address in the query (the server log keeps the path only), the limit always', () => {
  assert.equal(indexFillsPath('sodex', A.toUpperCase().replace('0X', '0x'), { from: 1_794_000_123_456.7, limit: 5000 }), `/api/vs/wallet/fills?venue=sodex&address=${A}&from=1794000120000&limit=5000`);
  assert.equal(indexFillsPath('hyperliquid', A, {}), `/api/vs/wallet/fills?venue=hyperliquid&address=${A}&limit=2000`);
});

test('held up to now: the index\'s fills, and no venue read at all', async () => {
  const held = [f('3', NOW - 1_000), f('2', NOW - 5_000)];
  const t = io({ ok: true, covered: true, heldTo: NOW - 30_000, fills: held });
  const got = await fillsWithIndex('sodex', A, { from: NOW - 30 * 86_400_000, limit: 5000 }, t.io);
  assert.deepEqual(got, held);
  assert.equal(t.asked.length, 0);
  assert.equal(t.paths.length, 1);
});

test('not covered, an error, no answer, a malformed answer: the venue\'s own read with the caller\'s query, unchanged', async () => {
  const venue = [f('9', NOW - 1)];
  const q = { from: NOW - 7 * 86_400_000, limit: 5000 };
  for (const answer of [
    { ok: true, covered: false } as IndexFillsAnswer,
    new Error('network'),
    null,
    { ok: false } as IndexFillsAnswer,
    { ok: true, covered: true, fills: [] } as IndexFillsAnswer, // no heldTo
  ]) {
    const t = io(answer, venue);
    assert.deepEqual(await fillsWithIndex('hyperliquid', A, q, t.io), venue);
    assert.deepEqual(t.asked, [q]);
  }
});

test('held up to an earlier time: the venue reads only the tail after it, merged newest first, cut to the limit', async () => {
  const heldTo = NOW - 3_600_000;
  const t = io(
    { ok: true, covered: true, heldTo, fills: [f('h2', heldTo), f('h1', heldTo - 10)] },
    // The venue's read also has fills the index holds: only those after heldTo are taken from it.
    [f('v3', NOW - 100), f('v2', heldTo + 1), f('h2', heldTo)],
  );
  const got = await fillsWithIndex('hyperliquid', A, { from: NOW - 86_400_000, limit: 3 }, t.io);
  assert.deepEqual(got.map((x) => x.id), ['v3', 'v2', 'h2']);
  assert.deepEqual(t.asked, [{ from: heldTo + 1, limit: 3 }]);
});

test('a span that ends within the slack counts as reaching the end; one that ends just before does not', async () => {
  const inside = io({ ok: true, covered: true, heldTo: NOW - TAIL_SLACK_MS, fills: [] });
  await fillsWithIndex('sodex', A, {}, inside.io);
  assert.equal(inside.asked.length, 0);
  const outside = io({ ok: true, covered: true, heldTo: NOW - TAIL_SLACK_MS - 1, fills: [] });
  await fillsWithIndex('sodex', A, {}, outside.io);
  assert.deepEqual(outside.asked, [{ from: NOW - TAIL_SLACK_MS, limit: 2000 }]);
  // A window that ends before heldTo needs no tail whatever the clock says.
  const ended = io({ ok: true, covered: true, heldTo: NOW - 86_400_000, fills: [] });
  await fillsWithIndex('sodex', A, { to: NOW - 2 * 86_400_000 }, ended.io);
  assert.equal(ended.asked.length, 0);
});

test('the index\'s fills get what the venue read does to its own (Hyperliquid spot names); the venue\'s tail is already named', async () => {
  const t = io({ ok: true, covered: true, heldTo: NOW, fills: [f('1', NOW - 1, '@107')] });
  const got = await fillsWithIndex('hyperliquid', A, {}, { ...t.io, name: async (xs) => xs.map((x) => (x.symbol === '@107' ? { ...x, symbol: 'HYPE/USDC' } : x)) });
  assert.equal(got[0]!.symbol, 'HYPE/USDC');
});

test('a failing venue tail fails the read, as the venue read did before', async () => {
  const t = io({ ok: true, covered: true, heldTo: NOW - 86_400_000, fills: [] });
  await assert.rejects(fillsWithIndex('sodex', A, {}, { ...t.io, direct: async () => { throw new Error('rate limited'); } }), /rate limited/);
});

test('a venue the route does not answer (Arcus, Lighter, trade.xyz) is not asked of the index at all', async () => {
  for (const venue of ['arcus', 'lighter', 'tradexyz'] as const) {
    const t = io({ ok: true, covered: true, heldTo: NOW, fills: [f('x', NOW - 1)] }, [f('v', NOW - 2)]);
    assert.deepEqual((await fillsWithIndex(venue, A, { limit: 10 }, t.io)).map((x) => x.id), ['v']);
    assert.equal(t.paths.length, 0);
    assert.deepEqual(t.asked, [{ limit: 10 }]);
  }
});

test('the index\'s positions come with its fills: as sent when it reaches the end, moved on by the venue\'s tail otherwise', async () => {
  const at = { ok: true, covered: true, fills: [f('h1', NOW - 200)], positions: [{ symbol: 'BTC', side: 'long' as const, size: 2 }, { symbol: 'ETH', side: 'short' as const, size: 1 }] };
  const whole = await fillsWithIndex('hyperliquid', A, { limit: 10 }, io({ ...at, heldTo: NOW - 60_000 }).io);
  assert.deepEqual(indexPositions(whole), at.positions);
  // A tail after heldTo: a buy of 1 ETH closes the short, a sell of 3 BTC turns it short 1.
  const heldTo = NOW - 3_600_000;
  const sellBtc = { ...f('v1', NOW - 100), side: 'sell' as const, sz: 3 };
  const tailed = await fillsWithIndex('hyperliquid', A, { limit: 10 }, io({ ...at, heldTo }, [sellBtc, f('v2', NOW - 50, 'ETH')]).io);
  assert.deepEqual(indexPositions(tailed), [{ symbol: 'BTC', side: 'short', size: 1 }]);
  // An answer without them, or the venue's own read: none - the replay waits for the profile.
  assert.equal(indexPositions(await fillsWithIndex('hyperliquid', A, { limit: 10 }, io({ ok: true, covered: true, heldTo: NOW, fills: [] }).io)), null);
  assert.equal(indexPositions(await fillsWithIndex('hyperliquid', A, { limit: 10 }, io({ ok: true, covered: false }).io)), null);
});
