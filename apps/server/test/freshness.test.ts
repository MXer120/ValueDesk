// node --import tsx --test apps/server/test/freshness.test.ts
//
// The indexer's freshness targets (ops/statusModel.ts FRESH_TARGETS): the figures the health projection makes
// (hosted.ts indexerHealth `fresh`), the judge's `fresh:<id>` codes and early warnings (ops/indexerJudge.ts),
// what the prober records and the page gets (ops/status.ts), and the write queue's oldest wait (slicedWork.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { StatusStore, probeAll, startStatusProber, type ProbeTargets, type Sample } from '../src/ops/status.js';
import { FRESH_TARGETS, FRESH_WARN_SHARE, freshItems, parseFreshness, fmtAge, type FreshId } from '../src/ops/statusModel.js';
import { IndexerJudge, LANE_STALL_MS, freshnessOf, whyText } from '../src/ops/indexerJudge.js';
import { indexerHealth } from '../src/hosted.js';
import { SlicedWork } from '../src/indexer/slicedWork.js';
import { tempDir } from './builderFakes.js';

const DIR = tempDir('vs-fresh-');
let caseNo = 0;
const store = () => new StatusStore(join(DIR, `status-${caseNo++}.db`));
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const MIN = 60_000;
const TARGETS: ProbeTargets = { site: 'https://site.test', executor: 'https://site.test', executorSecret: null };
const BUDGET = Object.fromEntries(FRESH_TARGETS.map((t) => [t.id, t.budgetMs])) as Record<FreshId, number>;

function okFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/')) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/**
 * An indexer status published 5 s before `t`, every stream up, a lane idle, with each dataset as old as asked
 * (ms past its target's reference; see hosted.ts freshHealth). Undefined: the field is not published (an older indexer).
 */
function status(t: number, o: { liqNow?: number; liqStep?: number; flow?: number; writes?: number; cohorts?: number; boards?: number; hl?: { queued: number; done: number } } = {}) {
  const at = t - 5_000;
  const liq: Record<string, unknown> = { live: { ready: true, pending: 0 }, since: at - 3_600_000 };
  if (o.liqNow !== undefined) liq.nowAt = at - 2 * MIN - o.liqNow;
  if (o.liqStep !== undefined) liq.stepT = at - 17 * MIN - o.liqStep;
  const cohorts: Record<string, unknown> = { liq };
  if (o.cohorts !== undefined) cohorts.lastSeriesT = at - 15 * MIN - o.cohorts;
  return {
    at,
    sockets: { sodex: 1, hyperliquid: 1 },
    lanes: o.hl ? { hl: o.hl } : {},
    loopLagMs: { lastMinute: 200, sinceStart: 9_000 },
    lastBuildAt: at - (o.boards ?? 5 * MIN),
    flushBacklog: 3,
    ...(o.writes !== undefined ? { flushOldestMs: o.writes } : {}),
    ...(o.flow !== undefined ? { flow: { newestT: at - o.flow } } : {}),
    cohorts,
  };
}

async function probe(s: unknown, t = T0, judge = new IndexerJudge()): Promise<Sample> {
  return (await probeAll({ targets: TARGETS, fetch: okFetch(), now: () => t, indexerRecheckMs: 0, indexerJudge: judge, indexerStatus: () => s })).find((x) => x.service === 'indexer')!;
}

test('projection: each figure from the status, as of its publish time', () => {
  const h = indexerHealth(status(T0, { liqNow: 4_000, liqStep: 30_000, flow: 2_000, writes: 800, cohorts: 0, boards: 6 * MIN }))!;
  assert.deepEqual(h.fresh, { liqNow: 4_000, liqStep: 30_000, flow: 2_000, writes: 800, cohorts: 0, boards: 6 * MIN });
  assert.equal(h.flushBacklog, 3);
  // Not due yet is 0, never negative: a heatmap written a minute ago, a series 5 min into its step.
  const early = indexerHealth({ ...status(T0), cohorts: { liq: { nowAt: T0 - 5_000 - MIN, stepT: T0 - 5_000 - 5 * MIN }, lastSeriesT: T0 - 5_000 - 5 * MIN } })!;
  assert.equal(early.fresh.liqNow, 0);
  assert.equal(early.fresh.liqStep, 0);
  assert.equal(early.fresh.cohorts, 0);
});

test('judge: past its target is a fresh code, past half only a warning, at most its target is fine', () => {
  for (const { id, budgetMs } of FRESH_TARGETS) {
    if (id === 'hl') continue;
    const h = (v: number) => ({ ...indexerHealth(status(T0))!, fresh: { liqNow: null, liqStep: null, flow: null, writes: null, cohorts: null, boards: null, [id]: v } });
    assert.deepEqual(freshnessOf(h(budgetMs + 1), null).over, [id], `${id} over`);
    assert.deepEqual(freshnessOf(h(budgetMs), null).over, [], `${id} at its target is within it`);
    assert.deepEqual(freshnessOf(h(budgetMs), null).warn, [id], `${id} at its target is past half`);
    assert.deepEqual(freshnessOf(h(budgetMs * FRESH_WARN_SHARE + 1), null).warn, [id]);
    assert.deepEqual(freshnessOf(h(budgetMs * FRESH_WARN_SHARE), null).warn, [], `${id} at half is no warning`);
  }
});

test('probes: each dataset past its target makes the indexer degraded with its words; within, up', async () => {
  const late = { liqNow: BUDGET.liqNow + 1_000, liqStep: BUDGET.liqStep + 1_000, flow: BUDGET.flow + 1_000, writes: BUDGET.writes + 1_000, cohorts: BUDGET.cohorts + 1_000, boards: BUDGET.boards + 1_000 };
  for (const [id, v] of Object.entries(late)) {
    const s = await probe(status(T0, { [id]: v }));
    assert.equal(s.state, 'degraded', id);
    assert.deepEqual(s.why, [`fresh:${id}`], id);
    const words = whyText(`fresh:${id}`);
    assert.ok(words && !words.includes('fresh'), `${id}: ${words}`);
  }
  const fine = await probe(status(T0, { liqNow: 0, liqStep: 0, flow: 3_000, writes: 200, cohorts: 0, boards: 6 * MIN }));
  assert.equal(fine.state, 'up');
  assert.equal(fine.why, undefined);
  assert.deepEqual(fine.fresh!.over, []);
  // Past half: still up, no code; the warning rides with the sample only.
  const half = await probe(status(T0, { writes: 6_000, boards: 9 * MIN }));
  assert.equal(half.state, 'up');
  assert.deepEqual(half.fresh!.warn.sort(), ['boards', 'writes']);
});

test('probes: an indexer that publishes none of the new figures is judged as before - no false alarm', async () => {
  // As v0.2.198 publishes it: no flushOldestMs, no flow.newestT, no liq.stepT (a stream-only status, boards fresh).
  const old = { at: T0 - 5_000, sockets: { sodex: 1, hyperliquid: 1 }, lastBuildAt: T0 - 10 * MIN, flushBacklog: 120_000, loopLagMs: { lastMinute: 300 }, flow: { prints: 9, hourThrough: T0 - 2 * 3_600_000 }, cohorts: { liq: { live: { ready: false } } } };
  const s = await probe(old);
  assert.equal(s.state, 'up');
  const v = s.fresh!.values;
  assert.deepEqual([v.liqNow, v.liqStep, v.flow, v.writes, v.cohorts], [null, null, null, null, null]);
  assert.equal(v.boards, 10 * MIN - 5_000);
});

test('probes: boards over an hour are said once (the hard `boards`), between 15 min and an hour as fresh:boards', async () => {
  assert.deepEqual((await probe(status(T0, { boards: 2 * 3_600_000 }))).why, ['boards']);
  assert.deepEqual((await probe(status(T0, { boards: 20 * MIN }))).why, ['fresh:boards']);
});

test('judge: the Hyperliquid lane without progress is a figure; lane:hl says it, fresh:hl never doubles it', async () => {
  const judge = new IndexerJudge();
  let last: Sample | null = null;
  for (let i = 0; i <= 20; i++) last = await probe(status(T0 + i * MIN, { hl: { queued: 2_500, done: 900 } }), T0 + i * MIN, judge);
  assert.equal(last!.fresh!.values.hl, 20 * MIN);
  assert.ok(last!.fresh!.warn.includes('hl'), 'past 15 of its 30 min');
  assert.ok(last!.why!.includes('lane:hl') && !last!.why!.some((c) => c.startsWith('fresh:')), last!.why!.join());
  assert.ok(LANE_STALL_MS.hl! < BUDGET.hl);
  // A lane that moves, or has nothing queued, is at 0.
  const moving = new IndexerJudge();
  for (let i = 0; i < 5; i++) last = await probe(status(T0 + i * MIN, { hl: { queued: 2_500, done: 900 + i } }), T0 + i * MIN, moving);
  assert.equal(last!.fresh!.values.hl, 0);
  assert.equal((await probe(status(T0, { hl: { queued: 0, done: 4 } }))).fresh!.values.hl, 0);
  assert.equal((await probe(status(T0))).fresh!.values.hl, null, 'no lane: no figure');
});

test('record: the page gets the last round\'s figures while recent; the day counts warning and over minutes once each', () => {
  const st = store();
  const fresh = freshnessOf({ ...indexerHealth(status(T0))!, fresh: { liqNow: 0, liqStep: null, flow: 40_000, writes: 12_000, cohorts: 0, boards: 6 * MIN } }, null);
  const round = (t: number) => st.record([{ service: 'indexer', state: 'degraded', ms: null, why: ['fresh:writes'], fresh }], t);
  round(T0);
  round(T0 + 10_000); // the same minute again: not counted twice
  round(T0 + MIN);
  const r = st.report(T0 + MIN + 5_000);
  assert.ok(r.freshness);
  const byId = Object.fromEntries(r.freshness!.items.map((i) => [i.id, i]));
  assert.deepEqual(byId.writes, { id: 'writes', ms: 12_000, budgetMs: BUDGET.writes, state: 'behind' });
  assert.deepEqual(byId.flow, { id: 'flow', ms: 40_000, budgetMs: BUDGET.flow, state: 'ok' });
  assert.equal(byId.liqStep!.state, 'unknown');
  assert.deepEqual(parseFreshness(JSON.parse(JSON.stringify(r.freshness))), r.freshness);
  const [day] = st.freshDays(7, T0 + MIN);
  assert.deepEqual(day!.items.writes, { warnMin: 0, overMin: 2, worstMs: 12_000 });
  assert.deepEqual(day!.items.flow, { warnMin: 2, overMin: 0, worstMs: 40_000 });
  assert.deepEqual(day!.items.liqNow, { warnMin: 0, overMin: 0, worstMs: 0 });
  assert.equal(day!.items.liqStep, undefined, 'no figure, no tally');
  // A stale round is not shown; a round whose indexer could not be judged clears it.
  assert.equal(st.report(T0 + 10 * MIN).freshness, undefined);
  st.record([{ service: 'indexer', state: 'down', ms: null }], T0 + 2 * MIN);
  assert.equal(st.report(T0 + 2 * MIN).freshness, undefined);
  st.close();
});

test('prober: past half a target is logged once as it starts, not every minute', async () => {
  const warns: Array<{ o: object; msg: string }> = [];
  const p = startStatusProber({
    store: store(), targets: TARGETS, fetch: okFetch(), historyFile: null, firstAfterMs: 3_600_000, everyMs: 3_600_000,
    indexerStatus: () => status(Date.now(), { writes: 7_000 }),
    log: { warn: (o, msg) => warns.push({ o, msg }) },
  });
  await p.tick();
  await p.tick();
  p.stop();
  const fresh = warns.filter((w) => w.msg.includes('freshness'));
  assert.equal(fresh.length, 1, JSON.stringify(warns));
  assert.match(fresh[0]!.msg, /writes past half its freshness target/);
  assert.deepEqual(fresh[0]!.o, { dataset: 'writes', ms: 7_000, targetMs: BUDGET.writes, over: false });
  p.store.close();
});

test('model: items in target order, figures as the page writes them', () => {
  assert.deepEqual(freshItems({ writes: 3_400.6 }).map((i) => [i.id, i.ms, i.state]), FRESH_TARGETS.map((t) => [t.id, t.id === 'writes' ? 3_401 : null, t.id === 'writes' ? 'ok' : 'unknown']));
  assert.deepEqual([fmtAge(8_400), fmtAge(2 * MIN), fmtAge(65 * MIN), fmtAge(120 * MIN)], ['8 s', '2 min', '1 h 5 min', '2 h']);
  assert.equal(parseFreshness({ at: 1, items: [{ id: 'nope', ms: 1, budgetMs: 1, state: 'ok' }] }), null);
});

test('write queue: how long the oldest step not run yet has waited', () => {
  let now = 1_000;
  const w = new SlicedWork({ budgetMs: 0, onError: () => {}, now: () => now });
  assert.equal(w.oldestWaitMs, 0, 'nothing queued');
  // Queued without running (a stop's enqueue), then more: the oldest counts.
  w.enqueue([() => {}, () => {}]);
  now = 4_000;
  w.enqueue([() => {}]);
  now = 9_000;
  assert.equal(w.oldestWaitMs, 8_000);
  w.drain();
  assert.equal(w.oldestWaitMs, 0, 'all written');
  // A step that throws still counts as run.
  w.add([() => { throw new Error('x'); }]);
  assert.equal(w.oldestWaitMs, 0);
});
