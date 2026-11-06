/**
 * The other venues' own figures (flow/venueCheck.ts): nothing is final without a check, and what is off says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY_MS, HOUR_MS } from '../src/flow/codec.js';
import { FlowRecorder, CLOSE_MS, FLUSH_MS } from '../src/flow/recorder.js';
import { FlowStore, closeFlowReader } from '../src/flow/store.js';
import { clearFlowCaches, closeLedgerReader, flowWalletFills, flowWindow } from '../src/flow/read.js';
import { clearVenueChecks, compareSlots, setCandleRead, slotsFor, type CandleRead } from '../src/flow/venueCheck.js';
import { provenSpans } from '../src/flow/ledger.js';
import type { Print } from '../src/indexer/streams.js';
import type { Venue } from '../src/valuedesk/types.js';

const S = 5 * 60_000;
const T = 20_400 * DAY_MS + HOUR_MS;
const rows = (...r: Array<[number, number]>) => r.map(([t, v]) => ({ t, v, final: true }));

test('prints must be equal, more than the count is off and said to be, and the slots join', () => {
  const c = compareSlots({ venue: 'hyperliquid', unit: 'prints', slotMs: S, from: T, to: T + 4 * S, venueRows: rows([T, 5], [T + S, 5258], [T + 2 * S, 7], [T + 3 * S, 3]), held: new Map([[T, 5], [T + S, 4061], [T + 2 * S, 12], [T + 3 * S, 3]]) });
  assert.equal(c.holeSlots, 2);
  assert.equal(c.overSlots, 1);
  assert.equal(c.held, 4081);
  assert.equal(c.expected, 5273);
  assert.deepEqual(c.holes, [{ from: T + S, to: T + 3 * S, held: 4073, venue: 5265 }]);
  assert.deepEqual(provenSpans(c), [[T, T + S], [T + 3 * S, T + 4 * S]]);
});

test('volume has a margin of 0.05 %, as whole slots measured; 0.81 is a hole', () => {
  const c = compareSlots({ venue: 'lighter', unit: 'volume', slotMs: S, from: T, to: T + 3 * S, venueRows: rows([T, 100], [T + S, 100], [T + 2 * S, 100]), held: new Map([[T, 100.005], [T + S, 81.2], [T + 2 * S, 99.96]]) });
  assert.equal(c.holeSlots, 1);
  assert.equal(c.holes[0]!.from, T + S);
});

test('before a venue\'s first row or after its last, prints held are unchecked, not a hole; between them a missing row counted nothing', () => {
  const c = compareSlots({ venue: 'hyperliquid', unit: 'prints', slotMs: S, from: T, to: T + 5 * S, venueRows: rows([T + S, 1], [T + 3 * S, 1]), held: new Map([[T, 9], [T + S, 1], [T + 2 * S, 4], [T + 3 * S, 1], [T + 4 * S, 2]]) });
  assert.deepEqual(c.unchecked, [[T, T + S], [T + 4 * S, T + 5 * S]]);
  assert.deepEqual(c.holes, [{ from: T + 2 * S, to: T + 3 * S, held: 4, venue: 0 }]);
  const none = compareSlots({ venue: 'hyperliquid', unit: 'prints', slotMs: S, from: T, to: T + S, venueRows: [], held: new Map() });
  assert.deepEqual(none.unchecked, []);
  assert.equal(none.holeSlots, 0);
});

test('a row the venue says is not final is unchecked', () => {
  const c = compareSlots({ venue: 'arcus', unit: 'prints', slotMs: S, from: T, to: T + S, venueRows: [{ t: T, v: 3, final: false }], held: new Map([[T, 3]]) });
  assert.deepEqual(c.unchecked, [[T, T + S]]);
});

test('slots follow the window, and what is too long says so', () => {
  assert.equal(slotsFor('hyperliquid', HOUR_MS), '5m');
  assert.equal(slotsFor('hyperliquid', 3 * DAY_MS), '1h');
  assert.equal(slotsFor('hyperliquid', 31 * DAY_MS), '1d');
  assert.equal(slotsFor('hyperliquid', 90 * DAY_MS), null);
  assert.equal(slotsFor('lighter', 3 * DAY_MS), null);
});

// --- through the flow's reads ----------------------------------------------------------------------------

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'venues-'));
  const flowPath = join(dir, 'flow.db');
  process.env.VALUESCAN_FLOW_DB = flowPath;
  closeFlowReader();
  closeLedgerReader();
  clearFlowCaches();
  clearVenueChecks();
  const clock = { now: T };
  const flow = new FlowStore(flowPath);
  const rec = new FlowRecorder(flow, () => null, () => clock.now);
  const hl = (t: number, id: string): Print => ({ venue: 'hyperliquid', id, t, symbol: 'BTC', px: 100, sz: 1, buyer: '0xa', seller: '0xb', taker: 'buyer' });
  rec.add(hl(T + 1, '1'));
  rec.add(hl(T + 2, '2'));
  rec.add(hl(T + S + 1, '3'));
  rec.add({ venue: 'lighter', id: 'l', t: T + 1, symbol: 'BTC', px: 100, sz: 2.5, buyer: '1', seller: '2', taker: 'buyer' });
  clock.now = T + 2 * S + CLOSE_MS + FLUSH_MS + 1_000;
  rec.tick();
  rec.tick();
  rec.stop();
  const later = T + DAY_MS;
  flow.setMeta('since', String(T - 1));
  flow.setMeta('runs', JSON.stringify([[T - 1, later]]));
  return {
    later,
    end: () => {
      setCandleRead(async () => null);
      closeFlowReader();
      clearFlowCaches();
      flow.close();
      delete process.env.VALUESCAN_FLOW_DB;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const ask = (venues: Venue[]) => ({ coin: 'BTC', venues, kind: 'perp' as const, from: T, to: T + 2 * S, role: 'all' as const, side: 'all' as const, sort: 'volume' as const, limit: 10 });

test('Hyperliquid short of its count: gaps, held n of m, not final; asked again when it matches, final', async () => {
  const w = world();
  let n = 3;
  const seen: string[] = [];
  const read: CandleRead = async (v, s, tf) => { seen.push(`${v} ${s} ${tf}`); return { unit: 'prints', rows: rows([T, n], [T + S, 1]) }; };
  setCandleRead(read);
  const short = await flowWindow(ask(['hyperliquid']), w.later);
  assert.equal(short!.final, false);
  assert.deepEqual(short!.gaps, [[T, T + S]]);
  assert.equal(short!.checks[0]!.venue, 'hyperliquid');
  assert.equal(short!.checks[0]!.held, 3);
  assert.equal(short!.checks[0]!.expected, 4);
  assert.deepEqual(seen, ['hyperliquid BTC 5m']);
  const fills = await flowWalletFills({ coin: 'BTC', venues: ['hyperliquid'], kind: 'perp', from: T, to: T + 2 * S, wallet: '0xa' }, w.later);
  assert.equal(fills!.final, false);
  assert.equal(fills!.gaps.length, 1);
  assert.equal(seen.length, 1, 'candles that cannot change are read once');
  n = 2;
  clearVenueChecks();
  const whole = await flowWindow(ask(['hyperliquid']), w.later + 6_000);
  assert.equal(whole!.final, true);
  assert.deepEqual(whole!.gaps, []);
  w.end();
});

test('a failed read or a venue that cannot say is unchecked, never final', async () => {
  const w = world();
  setCandleRead(async () => { throw new Error('429'); });
  const failed = await flowWindow(ask(['hyperliquid']), w.later);
  assert.equal(failed!.final, false);
  assert.ok(failed!.checks[0]!.unchecked.length > 0);
  assert.deepEqual(failed!.gaps, []);
  w.end();
});

test('over its share of reads, or read too slowly, a window stays checking: not final, and the panel asks again', async () => {
  const w = world();
  let calls = 0;
  setCandleRead(() => { calls++; return new Promise(() => {}); });
  // One unanswered read, waited for briefly...
  const slow = await flowWindow({ ...ask(['arcus']), coin: 'BTC' }, w.later);
  assert.deepEqual(slow!.checks, [], 'no Arcus market here');
  clearVenueChecks();
  const pending = await flowWindow(ask(['hyperliquid']), w.later + 6_000);
  assert.equal(pending!.final, false);
  assert.equal(pending!.checks[0]!.pending, true);
  assert.equal(calls, 1);
  // ...and many windows do not become many reads past the share.
  for (let i = 1; i <= 12; i++) await flowWindow({ ...ask(['hyperliquid']), to: T + 2 * S + i * S }, w.later + 6_000);
  assert.ok(calls <= 6, `${calls} reads`);
  w.end();
});

test('Lighter is compared by volume, from the chunks', async () => {
  const w = world();
  setCandleRead(async () => ({ unit: 'volume', rows: rows([T, 2.5]) }));
  const whole = await flowWindow(ask(['lighter']), w.later);
  assert.equal(whole!.checks[0]!.unit, 'volume');
  assert.equal(whole!.checks[0]!.held, 2.5);
  assert.equal(whole!.final, true);
  clearVenueChecks();
  clearFlowCaches();
  setCandleRead(async () => ({ unit: 'volume', rows: rows([T, 4]) }));
  const short = await flowWindow(ask(['lighter']), w.later);
  assert.equal(short!.checks[0]!.holeSlots, 1);
  assert.equal(short!.final, false);
  w.end();
});

test('the whole window is proved by all the venues asked, or the recorder\'s gap stands', async () => {
  const w = world();
  setCandleRead(async (v) => (v === 'hyperliquid' ? { unit: 'prints', rows: rows([T, 2], [T + S, 1]) } : null));
  const flow = new FlowStore(process.env.VALUESCAN_FLOW_DB!);
  flow.setMeta('runs', JSON.stringify([[T - 1, T + 30_000], [T + 2 * S, w.later]]));
  flow.close();
  const proved = await flowWindow(ask(['hyperliquid']), w.later);
  assert.deepEqual(proved!.down, [], 'its count shows nothing was lost');
  assert.equal(proved!.final, true);
  clearFlowCaches();
  const mixed = await flowWindow(ask(['hyperliquid', 'lighter']), w.later + 6_000);
  assert.ok(mixed!.down.length > 0, 'Lighter could not be compared');
  assert.equal(mixed!.final, false);
  w.end();
});
