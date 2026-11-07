/**
 * The Arcus catch-up: what the stream lost goes back in once, never twice, although Arcus's REST stamps every row a few ms
 * before its stream does; older pages are walked; how far it got outlives a restart.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowStore } from '../src/flow/store.js';
import { FlowRecorder } from '../src/flow/recorder.js';
import { chunkPrints, decodeChunk, CHUNK_MS } from '../src/flow/codec.js';
import { compareSlots } from '../src/flow/venueCheck.js';
import { ARCUS_PAGE, ArcusCatchup, type ArcusRead } from '../src/indexer/arcusCatchup.js';
import { ArcusStream, arcusPrint, type ArcusWsTrade, type Print } from '../src/indexer/streams.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-arcus-'));
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the temp folder's own cleanup */ } });
let n = 0;
const T0 = Math.floor(1_800_000_000_000 / CHUNK_MS) * CHUNK_MS;
const MAKER = '0x00000000000000000000000000000000000000aa';
const TAKER = '0x00000000000000000000000000000000000000bb';
/** A trade as REST gives it; `at` in ms. */
const row = (id: number, at: number, size = '1', price = '100'): ArcusWsTrade => ({
  marketDisplayName: 'BTC-USD', side: 'BUY', price, size, tradeId: String(id), timestamp: at * 1000 + 123, makerAddress: MAKER, takerAddress: TAKER,
});
/** The same trade as the stream stamps it. */
const streamed = (r: ArcusWsTrade, lateMs = 5): ArcusWsTrade => ({ ...r, timestamp: r.timestamp! + lateMs * 1000 });
const NEAR = 2_000;

const rig = (now: { t: number }, path = join(dir, `flow-${n++}.db`)) => {
  const rec = new FlowRecorder(new FlowStore(path), () => null, () => now.t);
  const prints: Print[] = [];
  const stream = new ArcusStream((p) => { rec.add(p); prints.push(p); }, async () => [], 'ws://127.0.0.1:1');
  const heard = (m: ArcusWsTrade[]) => stream.handle({ type: 'channel_data', channel: 'trades', contents: m });
  return { rec, stream, prints, heard, path };
};
const held = (rec: FlowRecorder, t: number): number => {
  const mid = rec.store.marketId('arcus', 'BTC-USD', 'BTC', t);
  const ct = Math.floor(t / CHUNK_MS) * CHUNK_MS;
  const blob = rec.store.chunk(mid, ct);
  return blob ? chunkPrints(decodeChunk(blob)).length : 0;
};

test('missingNear: the same trade a few ms apart is held, exact on everything else', () => {
  const now = { t: T0 + 60_000 };
  const { rec, heard } = rig(now);
  const a = row(1, T0 + 1_000);
  heard([streamed(a)]);
  const rest = arcusPrint(a)!;
  assert.deepEqual(rec.missing([rest]), [rest], 'the exact match sees every row as missing: this is why it is not used');
  assert.deepEqual(rec.missingNear([rest], NEAR), []);
  const size = arcusPrint(row(2, T0 + 1_000, '2'))!;
  const price = arcusPrint(row(3, T0 + 1_000, '1', '101'))!;
  const far = arcusPrint(row(4, T0 + 1_000 + NEAR + 50))!;
  assert.deepEqual(rec.missingNear([size, price, far], NEAR), [size, price, far]);
  rec.stop();
});

test('missingNear: one held print answers for one row, like trades counted', () => {
  const now = { t: T0 + 60_000 };
  const { rec, heard } = rig(now);
  const a = row(1, T0 + 1_000);
  const b = row(2, T0 + 1_200);
  heard([streamed(a)]);
  const out = rec.missingNear([arcusPrint(b)!, arcusPrint(a)!], NEAR);
  assert.equal(out.length, 1, 'of two like trades with one held, one is missing');
  heard([streamed(b)]);
  assert.deepEqual(rec.missingNear([arcusPrint(a)!, arcusPrint(b)!], NEAR), []);
  rec.stop();
});

test('missingNear: a print stamped over a chunk edge is still held, closed chunks too', () => {
  const now = { t: T0 + 2 * CHUNK_MS };
  const { rec, heard } = rig(now);
  const edge = T0 + CHUNK_MS - 2;
  const a = row(1, edge);
  heard([streamed(a)]);
  rec.flush(now.t, Infinity);
  assert.equal(Math.floor((edge + 5) / CHUNK_MS) * CHUNK_MS, T0 + CHUNK_MS, 'held in the next chunk');
  assert.deepEqual(rec.missingNear([arcusPrint(a)!], NEAR), []);
  rec.stop();
});

/** A venue that answers as Arcus does: newest first, within [from, to], at most a page. */
const venue = (all: ArcusWsTrade[], calls: Array<{ from?: number; to?: number }> = []): ArcusRead => async (_m, w) => {
  calls.push(w);
  const rows = all
    .filter((r) => (w.from === undefined || r.timestamp! >= w.from * 1000) && (w.to === undefined || r.timestamp! <= w.to * 1000 + 999))
    .sort((x, y) => y.timestamp! - x.timestamp!);
  return { rows: rows.slice(0, ARCUS_PAGE) };
};
const catchup = (r: ReturnType<typeof rig>, now: { t: number }, read: ArcusRead, kept: { v: Record<string, number> } = { v: {} }) => {
  const lines: string[] = [];
  const c = new ArcusCatchup(
    (rows) => r.stream.catchUp(rows as ArcusWsTrade[], (ps) => r.rec.missingNear(ps, NEAR)),
    (l) => lines.push(l),
    { load: () => kept.v, save: (through) => { kept.v = through; } },
    { read, markets: async () => ['BTC-USD'], now: () => now.t },
  );
  return { c, lines, kept };
};

test('adds what the stream lost, and nothing it brought: all of a slot once', async () => {
  const now = { t: T0 + 10 * 60_000 };
  const r = rig(now);
  const rows = Array.from({ length: 100 }, (_, i) => row(i * 7 + 1, T0 + 100 + i * 2_000));
  // The stream brought all but ten, a run in the middle, each stamped late.
  const lost = rows.slice(40, 50);
  r.heard(rows.filter((x) => !lost.includes(x)).map((x) => streamed(x)));
  r.rec.flush(now.t, Infinity);
  assert.equal(held(r.rec, T0), 90);
  const { c } = catchup(r, now, venue(rows));
  await c.tick();
  assert.equal(c.status().added, 10);
  assert.equal(c.status().beyondReach, 0, 'ids shared over markets are not contiguous: no count is made of them');
  r.rec.flush(now.t, Infinity);
  assert.equal(held(r.rec, T0), 100);
  now.t += 40 * 60_000;
  await c.tick();
  r.rec.flush(now.t, Infinity);
  assert.equal(held(r.rec, T0), 100, 'read again, nothing twice');
  assert.equal(c.status().errors, 0);
  // The stream delivering one late is no second print either.
  r.heard([streamed(lost[0]!)]);
  r.rec.flush(now.t, Infinity);
  assert.equal(held(r.rec, T0), 100);
  r.rec.stop();
});

test('a new process, whose stream remembers no ids, adds nothing held', async () => {
  const now = { t: T0 + 10 * 60_000 };
  const a = rig(now);
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, T0 + 100 + i * 1_000));
  a.heard(rows.map((x) => streamed(x)));
  a.rec.stop();
  a.rec.store.close();
  now.t += 60_000;
  const b = rig(now, a.path);
  const { c } = catchup(b, now, venue(rows));
  await c.tick();
  assert.equal(c.status().added, 0);
  b.rec.flush(now.t, Infinity);
  assert.equal(held(b.rec, T0), 20);
  b.rec.stop();
});

test('rows newer than 20 s are left to the stream', async () => {
  const now = { t: T0 + 100_000 };
  const r = rig(now);
  const { c } = catchup(r, now, venue([row(1, now.t - 5_000), row(2, now.t - 25_000)]));
  await c.tick();
  assert.equal(c.status().added, 1);
  assert.deepEqual(r.prints.map((p) => p.id), ['2']);
  r.rec.stop();
});

test('an outage longer than a page is walked back, one page a tick, and every row goes in once', async () => {
  const now = { t: T0 + 12 * 3_600_000 };
  const r = rig(now);
  // 2,500 trades in the last hours, none held; 21 alike share a millisecond across a page's edge.
  const start = now.t - 3 * 3_600_000;
  const rows = Array.from({ length: 2_500 }, (_, i) => (i >= 1_490 && i <= 1_510 ? row(i + 1, start + 1_500 * 2_000) : row(i + 1, start + i * 2_000, String(i + 1))));
  const calls: Array<{ from?: number; to?: number }> = [];
  const { c, kept } = catchup(r, now, venue(rows, calls));
  await c.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to, undefined);
  assert.equal(c.status().added, 1_000);
  assert.deepEqual(kept.v, {}, 'not through until the walk is done');
  for (let i = 0; i < 5 && calls.length < 3; i++) await c.tick();
  assert.equal(calls.length, 3);
  assert.ok(calls[1]!.to! > calls[2]!.to!);
  assert.equal(new Set(r.prints.map((p) => p.id)).size, r.prints.length, 'no id went in twice');
  assert.equal(r.prints.length, 2_500);
  assert.equal(c.status().added, 2_500);
  assert.ok(kept.v['BTC-USD']! >= rows[2_499]!.timestamp! / 1000 - 1, 'through the newest row');
  r.rec.stop();
});

test('how far it got outlives a restart, and the next read asks only from there', async () => {
  const now = { t: T0 + 3_600_000 };
  const r = rig(now);
  const calls: Array<{ from?: number; to?: number }> = [];
  const { c, kept } = catchup(r, now, venue([row(1, now.t - 60_000)], calls));
  await c.tick();
  const through = kept.v['BTC-USD']!;
  assert.equal(through, now.t - 60_000);
  now.t += 3 * 3_600_000;
  const calls2: Array<{ from?: number; to?: number }> = [];
  const next = catchup(r, now, venue([row(1, through)], calls2), kept);
  await next.c.tick();
  assert.equal(calls2[0]!.from, through - 2 * 60_000, 'from where it got to, with the overlap');
  assert.ok(calls[0]!.from! <= now.t - 24 * 3_600_000 + 3 * 3_600_000, 'a market first seen starts a day back');
  r.rec.stop();
});

test('nothing is taken as read when what is held cannot be told, or Arcus says 429', async () => {
  const now = { t: T0 + 3_600_000 };
  const r = rig(now);
  let limited = true;
  const read: ArcusRead = async (m, w) => (limited ? { rows: [], limited: true } : venue([row(1, now.t - 60_000)])(m, w));
  const kept = { v: {} as Record<string, number> };
  const lines: string[] = [];
  let fail = false;
  const c = new ArcusCatchup(
    (rows) => { if (fail) throw new Error('missing: no chunk'); return r.stream.catchUp(rows as ArcusWsTrade[], (ps) => r.rec.missingNear(ps, NEAR)); },
    (l) => lines.push(l),
    { load: () => kept.v, save: (t) => { kept.v = t; } },
    { read, markets: async () => ['BTC-USD'], now: () => now.t },
  );
  await c.tick();
  assert.deepEqual(kept.v, {});
  assert.equal(c.status().lastError, 'Arcus said 429');
  now.t += 60_000;
  limited = false;
  await c.tick();
  assert.deepEqual(kept.v, {}, 'still waiting out the 429');
  now.t += 5 * 60_000;
  fail = true;
  await c.tick();
  assert.deepEqual(kept.v, {}, 'a read that could not compare moves nothing on');
  assert.equal(c.status().errors, 1);
  now.t += 3 * 60_000;
  fail = false;
  await c.tick();
  assert.equal(c.status().added, 1);
  assert.ok(kept.v['BTC-USD']);
  r.rec.stop();
});

// --- the count against what is held ---------------------------------------------------------------------

const S = 5 * 60_000;
const rows5 = (...v: Array<[number, number]>) => v.map(([t, n]) => ({ t, v: n, final: true }));

test('a print stamped into the next slot is neither a hole nor recorded twice', () => {
  const c = compareSlots({ venue: 'arcus', unit: 'prints', slotMs: S, from: T0, to: T0 + 2 * S, venueRows: rows5([T0, 45], [T0 + S, 44]), held: new Map([[T0, 44], [T0 + S, 45]]), lateStamps: true });
  assert.equal(c.holeSlots, 0);
  assert.equal(c.overSlots, 0);
  assert.equal(c.held, c.expected);
});

test('the same across the window\'s edge, with the slot beside it in view', () => {
  const short = compareSlots({ venue: 'arcus', unit: 'prints', slotMs: S, from: T0, to: T0 + S, venueRows: rows5([T0, 45]), edgeRows: rows5([T0 + S, 44]), held: new Map([[T0, 44], [T0 + S, 45]]), lateStamps: true });
  assert.equal(short.holeSlots, 0);
  const over = compareSlots({ venue: 'arcus', unit: 'prints', slotMs: S, from: T0 + S, to: T0 + 2 * S, venueRows: rows5([T0 + S, 44]), edgeRows: rows5([T0, 45]), held: new Map([[T0, 44], [T0 + S, 45]]), lateStamps: true });
  assert.equal(over.holeSlots, 0);
  assert.equal(over.overSlots, 0);
});

test('a real hole, a real double and the other direction stay what they are', () => {
  const hole = compareSlots({ venue: 'arcus', unit: 'prints', slotMs: S, from: T0, to: T0 + 2 * S, venueRows: rows5([T0, 45], [T0 + S, 44]), held: new Map([[T0, 40], [T0 + S, 44]]), lateStamps: true });
  assert.equal(hole.holeSlots, 1);
  assert.equal(hole.held, 84);
  const twice = compareSlots({ venue: 'arcus', unit: 'prints', slotMs: S, from: T0, to: T0 + 2 * S, venueRows: rows5([T0, 45], [T0 + S, 44]), held: new Map([[T0, 45], [T0 + S, 50]]), lateStamps: true });
  assert.equal(twice.overSlots, 1);
  const back = compareSlots({ venue: 'arcus', unit: 'prints', slotMs: S, from: T0, to: T0 + 2 * S, venueRows: rows5([T0, 45], [T0 + S, 44]), held: new Map([[T0, 46], [T0 + S, 43]]), lateStamps: true });
  assert.equal(back.holeSlots, 2, 'stamps only run late, so this is no edge');
  const part = compareSlots({ venue: 'arcus', unit: 'prints', slotMs: S, from: T0, to: T0 + 2 * S, venueRows: rows5([T0, 45], [T0 + S, 44]), held: new Map([[T0, 40], [T0 + S, 45]]), lateStamps: true });
  assert.equal(part.holeSlots, 1, 'one put back across the edge, four still short');
  assert.equal(part.overSlots, 0);
  const other = compareSlots({ venue: 'hyperliquid', unit: 'prints', slotMs: S, from: T0, to: T0 + 2 * S, venueRows: rows5([T0, 45], [T0 + S, 44]), held: new Map([[T0, 44], [T0 + S, 45]]) });
  assert.equal(other.holeSlots, 2, 'other venues are compared as they were');
});
