/**
 * The SoDEX catch-up: what the stream lost goes back in once, never twice, also after a restart; and a restart does not
 * cost a who-traded slot what it already held.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowStore } from '../src/flow/store.js';
import { FlowRecorder } from '../src/flow/recorder.js';
import { chunkPrints, decodeChunk, CHUNK_MS } from '../src/flow/codec.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RestReader, SodexCatchup, CATCHUP_LIMIT } from '../src/indexer/sodexCatchup.js';
import { SodexStream, sodexPrint, type Print, type SodexWsTrade } from '../src/indexer/streams.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-catchup-'));
// Windows keeps a store's file until the process ends.
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the temp folder's own cleanup */ } });
let n = 0;
const T0 = Math.floor(1_800_000_000_000 / CHUNK_MS) * CHUNK_MS;
const row = (t: number, T: number, px = '100', q = '1', bi = 1, si = 2): SodexWsTrade => ({ t, T, s: 'BTC-USD', S: 'BUY', p: px, q, bi, si });
const rig = (now: { t: number }) => {
  const path = join(dir, `flow-${n++}.db`);
  const open = () => new FlowRecorder(new FlowStore(path), () => null, () => now.t);
  return { open };
};
const stored = (rec: FlowRecorder, t: number): number => {
  const mid = rec.store.marketId('sodex', 'BTC-USD', 'BTC', t);
  const blob = rec.store.chunk(mid, Math.floor(t / CHUNK_MS) * CHUNK_MS);
  return blob ? chunkPrints(decodeChunk(blob)).length : 0;
};

test('missing: exact on every field, and counted', () => {
  const now = { t: T0 + 10_000 };
  const rec = rig(now).open();
  const a = sodexPrint(row(1, T0 + 1_000))!;
  const twin = sodexPrint(row(2, T0 + 1_000))!;
  const other = sodexPrint(row(3, T0 + 1_000, '101'))!;
  rec.add(a);
  assert.deepEqual(rec.missing([a]), []);
  assert.deepEqual(rec.missing([a, twin]), [twin], 'one held, its identical twin is not');
  assert.deepEqual(rec.missing([other]), [other]);
  rec.add(twin);
  assert.deepEqual(rec.missing([a, twin]), []);
  rec.stop();
});

test('a slot begun before a restart keeps what the last run held', () => {
  const now = { t: T0 + 10_000 };
  const { open } = rig(now);
  let rec = open();
  rec.add(sodexPrint(row(1, T0 + 1_000))!);
  rec.add(sodexPrint(row(2, T0 + 2_000))!);
  rec.stop();
  rec.store.close();
  now.t += 5_000;
  rec = open();
  rec.add(sodexPrint(row(3, T0 + 14_000))!);
  rec.flush(now.t, Infinity);
  assert.equal(stored(rec, T0), 3);
  rec.stop();
});

const catchup = (rec: FlowRecorder, now: { t: number }, read: () => SodexWsTrade[]) => {
  const prints: Print[] = [];
  const stream = new SodexStream((p) => { rec.add(p); prints.push(p); });
  const lines: string[] = [];
  const c = new SodexCatchup(
    (rows) => stream.catchUp(rows, (ps) => rec.missing(ps)),
    (l) => lines.push(l),
    async () => ({ rows: read() }),
    async (e) => (e === 'perps' ? ['BTC-USD'] : []),
    () => now.t,
  );
  return { c, stream, prints, lines };
};

test('what the stream lost goes in once; what it delivered, and what it delivers later, do not', async () => {
  const now = { t: T0 + 60_000 };
  const rec = rig(now).open();
  const seen = row(1, T0 + 1_000);
  const lost = row(2, T0 + 2_000);
  const justNow = row(3, now.t - 1_000);
  const { c, stream, prints } = catchup(rec, now, () => [justNow, lost, seen]);
  stream.handle({ channel: 'trade', data: [seen] });
  await c.tick();
  assert.deepEqual(prints.map((p) => p.id), ['BTC-USD:1', 'BTC-USD:2'], 'the newest is left to the stream');
  // The stream delivers the lost one after all: the id is known.
  stream.handle({ channel: 'trade', data: [lost, justNow] });
  assert.deepEqual(prints.map((p) => p.id), ['BTC-USD:1', 'BTC-USD:2', 'BTC-USD:3']);
  now.t += 3 * 60_000;
  await c.tick();
  assert.equal(prints.length, 3, 'read again: nothing new');
  assert.equal(c.status().added, 1);
  rec.stop();
});

test('after a restart nothing already held is added again', async () => {
  const now = { t: T0 + 60_000 };
  const { open } = rig(now);
  let rec = open();
  const a = row(1, T0 + 1_000);
  const b = row(2, T0 + 2_000);
  rec.add(sodexPrint(a)!);
  rec.stop();
  rec.store.close();
  now.t += 10_000;
  rec = open();
  const { c, prints } = catchup(rec, now, () => [a, b]);
  await c.tick();
  assert.deepEqual(prints.map((p) => p.id), ['BTC-USD:2'], 'only the one the restart cost');
  rec.stop();
});

test('a market is read at half its reach, what fell out of reach is counted, 429 waits', async () => {
  const now = { t: T0 + 3_600_000 };
  const rec = rig(now).open();
  let rows: SodexWsTrade[] = Array.from({ length: CATCHUP_LIMIT }, (_, i) => row(1000 + i, now.t - 40 * 60_000 + i));
  let reads = 0;
  const stream = new SodexStream(() => {});
  const lines: string[] = [];
  let limited = false;
  const c = new SodexCatchup(
    (r) => stream.catchUp(r, () => []),
    (l) => lines.push(l),
    async () => { reads++; return limited ? { rows: [], limited: true } : { rows }; },
    async (e) => (e === 'perps' ? ['BTC-USD'] : []),
    () => now.t,
  );
  await c.tick();
  assert.equal(reads, 1);
  now.t += 2 * 60_000;
  await c.tick();
  assert.equal(reads, 1, 'not due: a reach under 6 min gives the 3 min floor');
  now.t += 60_000 + 1;
  rows = Array.from({ length: CATCHUP_LIMIT }, (_, i) => row(2000 + i, now.t - 40 * 60_000 + i));
  await c.tick();
  assert.equal(c.status().beyondReach, 2000 - 1499 - 1);
  assert.match(lines.at(-1)!, /went out of SoDEX's reach/);
  limited = true;
  now.t += 3 * 60_000 + 1;
  await c.tick();
  assert.equal(c.status().lastError, 'SoDEX said 429');
  const r = reads;
  now.t += 60_000;
  await c.tick();
  assert.equal(reads, r, 'waits out the limit');
  rec.stop();
});

test('the reader thread brings back rows, market lists and a 429', async () => {
  const server = createServer((req, res) => {
    if (req.url!.includes('/symbols')) { res.end(JSON.stringify({ data: [{ symbol: 'BTC-USD' }, { name: 'vX_vUSDC' }] })); return; }
    if (req.url!.includes('LIMITED')) { res.statusCode = 429; res.end('{}'); return; }
    res.end(JSON.stringify({ data: [row(7, T0)] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const reader = new RestReader(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    assert.deepEqual(await reader.symbols('perps'), ['BTC-USD', 'vX_vUSDC']);
    assert.deepEqual(await reader.readTrades('perps', 'LIMITED'), { rows: [], limited: true });
    const rows = await reader.readTrades('perps', 'BTC-USD');
    assert.equal(rows.rows[0]!.t, 7);
  } finally {
    reader.stop();
    server.closeAllConnections();
    server.close();
  }
});

test('a read that fails is tried again in 30 s, and the others go on', async () => {
  const now = { t: T0 + 3_600_000 };
  const asked: string[] = [];
  const stream = new SodexStream(() => {});
  const c = new SodexCatchup(
    (r) => stream.catchUp(r, () => []),
    () => {},
    async (_e, s) => { asked.push(s); if (s === 'A-USD') throw new Error('timeout'); return { rows: [] }; },
    async (e) => (e === 'perps' ? ['A-USD', 'B-USD'] : []),
    () => now.t,
  );
  await c.tick();
  now.t += 2_000;
  await c.tick();
  assert.deepEqual(asked, ['A-USD', 'B-USD']);
  assert.equal(c.status().errors, 1);
  now.t += 28_000;
  await c.tick();
  assert.deepEqual(asked, ['A-USD', 'B-USD', 'A-USD']);
});
