/**
 * The live test runner's own rules (apps/executor/tools/live-test): what is
 * resumed and what is skipped, the code hash a pass is tied to, the crash
 * repair of the state file, the cleanup that must leave the accounts flat
 * before anything else happens, the start-up decision, the budget, and the
 * catalogue. None of it touches SoDEX.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALGO_KINDS, type MarketInfo } from '../../../packages/copy-engine/src/index.ts';
import { computeBudget, pickMarket } from '../tools/live-test/budget.ts';
import { CATALOGUE } from '../tools/live-test/catalogue.ts';
import { flatten, startDecision, type FlattenVenue, type VenueOrder } from '../tools/live-test/cleanup.ts';
import { assertPaper } from '../tools/live-test/executor.ts';
import { T, type Env } from '../tools/live-test/harness.ts';
import { CodeHashes, filesOf, hashFiles } from '../tools/live-test/hash.ts';
import type { Scenario } from '../tools/live-test/scenario.ts';
import { decide, emptyState, loadState, markDone, markRunning, saveState, selected } from '../tools/live-test/state.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'vd-live-test-'));

const S = (id: string, x: Partial<Scenario> = {}) => ({ id, kind: id.split('.')[0]!, section: id.startsWith('copy') ? 'copy' : 'algo', ...x });

/* ---------------------------------------------------------------- state ----- */

test('state: a missing file is an empty state with no exposure', () => {
  const d = tmp();
  const { state, report } = loadState(join(d, 'live.json'), 'live');
  assert.deepEqual(state.scenarios, {});
  assert.equal(state.exposure, null);
  assert.deepEqual(report, { interrupted: [], corrupt: null });
  rmSync(d, { recursive: true, force: true });
});

test('state: saved and loaded again it is the same; the save leaves no temporary file', () => {
  const d = tmp();
  const f = join(d, 'sub', 'live.json');
  const s = emptyState('live');
  markRunning(s, 'twap.taker-buy', 'h1', 1_000);
  markDone(s, 'twap.taker-buy', 'passed', { checks: { passed: 7, liveOnly: 0 }, feesUsd: 0.05 }, 2_000);
  saveState(f, s);
  const back = loadState(f, 'live').state;
  assert.equal(back.scenarios['twap.taker-buy']!.status, 'passed');
  assert.equal(back.scenarios['twap.taker-buy']!.hash, 'h1');
  assert.equal(back.scenarios['twap.taker-buy']!.feesUsd, 0.05);
  assert.deepEqual(readdirSync(join(d, 'sub')), ['live.json']);
  rmSync(d, { recursive: true, force: true });
});

test('state: a scenario left running by a crash is failed (interrupted) and sets the exposure flag', () => {
  const d = tmp();
  const f = join(d, 'live.json');
  const s = emptyState('live');
  markRunning(s, 'scale.restart', 'h', 5_000);
  saveState(f, s);
  const { state, report } = loadState(f, 'live', 9_000);
  assert.deepEqual(report.interrupted, ['scale.restart']);
  assert.equal(state.scenarios['scale.restart']!.status, 'failed');
  assert.match(state.scenarios['scale.restart']!.error ?? '', /interrupted/);
  assert.deepEqual(state.exposure, { since: 5_000, by: 'scale.restart' });
  rmSync(d, { recursive: true, force: true });
});

test('state: an exposure flag already set is kept (a crash in the cleanup itself)', () => {
  const d = tmp();
  const f = join(d, 'live.json');
  const s = emptyState('live');
  s.exposure = { since: 1, by: 'twap.exits' };
  saveState(f, s);
  assert.deepEqual(loadState(f, 'live').state.exposure, { since: 1, by: 'twap.exits' });
  rmSync(d, { recursive: true, force: true });
});

test('state: an unreadable file (or another mode\'s) is kept aside and read as exposed - unknown is never flat', () => {
  const d = tmp();
  const f = join(d, 'live.json');
  writeFileSync(f, '{"version":1,"mode":"live","scen');
  const a = loadState(f, 'live', 42);
  assert.ok(a.report.corrupt);
  assert.deepEqual(a.state.exposure, { since: 42, by: 'unreadable state file' });
  assert.ok(existsSync(`${f}.corrupt-42`));
  saveState(f, { ...emptyState('dry') });
  const b = loadState(f, 'live', 43);
  assert.ok(b.report.corrupt, 'a dry state never stands in for a live one');
  assert.ok(b.state.exposure);
  rmSync(d, { recursive: true, force: true });
});

/* ------------------------------------------------------------- decisions ----- */

test('decide: passed on this hash is skipped; on another hash, failed, inconclusive, pending all run', () => {
  const s = emptyState('live');
  const o = { only: null, force: false };
  assert.equal(decide(s, S('twap.a'), 'h1', o).run, true, 'never run');
  markRunning(s, 'twap.a', 'h1');
  markDone(s, 'twap.a', 'passed');
  assert.equal(decide(s, S('twap.a'), 'h1', o).run, false);
  assert.equal(decide(s, S('twap.a'), 'h2', o).run, true, 'the code changed');
  markRunning(s, 'twap.a', 'h2');
  markDone(s, 'twap.a', 'failed', { error: 'x' });
  assert.equal(decide(s, S('twap.a'), 'h2', o).run, true);
  markRunning(s, 'twap.a', 'h2');
  markDone(s, 'twap.a', 'inconclusive');
  assert.equal(decide(s, S('twap.a'), 'h2', o).run, true);
});

test('decide: --force runs what passed; a skipped (unavailable) one is skipped on the same code only', () => {
  const s = emptyState('live');
  markRunning(s, 'twap.a', 'h1');
  markDone(s, 'twap.a', 'passed');
  assert.equal(decide(s, S('twap.a'), 'h1', { only: null, force: true }).run, true);
  markRunning(s, 'twap.b', 'h1');
  markDone(s, 'twap.b', 'skipped', { error: 'no update op' });
  assert.equal(decide(s, S('twap.b'), 'h1', { only: null, force: false }).run, false);
  assert.equal(decide(s, S('twap.b'), 'h2', { only: null, force: false }).run, true);
});

test('decide: --only selects by id, prefix, kind and section; the bootstrap runs whatever is selected', () => {
  const s = emptyState('live');
  assert.equal(selected(['twap.a'], S('twap.a')), true);
  assert.equal(selected(['twap.a'], S('twap.b')), false);
  assert.equal(selected(['twap.*'], S('twap.b')), true);
  assert.equal(selected(['twap'], S('twap.b')), true);
  assert.equal(selected(['copy'], S('copy.counter', { kind: 'copy' })), true);
  assert.equal(selected(['copy'], S('twap.a')), false);
  assert.equal(decide(s, S('vwap.x'), 'h', { only: ['twap'], force: false }).run, false);
  const boot = { id: 'setup.terms', kind: 'key', section: 'setup', always: true };
  markRunning(s, 'setup.terms', 'h');
  markDone(s, 'setup.terms', 'passed');
  assert.equal(decide(s, boot, 'h', { only: ['twap'], force: false }).run, true);
});

/* ----------------------------------------------------------------- hashes ----- */

test('hash: line endings do not matter, content does, the order files are given in does not', () => {
  const d = tmp();
  mkdirSync(join(d, 'a'));
  writeFileSync(join(d, 'a', 'x.ts'), 'one\ntwo\n');
  writeFileSync(join(d, 'a', 'y.ts'), 'three\n');
  const h1 = hashFiles(d, ['a/x.ts', 'a/y.ts']);
  writeFileSync(join(d, 'a', 'x.ts'), 'one\r\ntwo\r\n');
  assert.equal(hashFiles(d, ['a/y.ts', 'a/x.ts']), h1);
  writeFileSync(join(d, 'a', 'x.ts'), 'one\ntwo!\n');
  assert.notEqual(hashFiles(d, ['a/x.ts', 'a/y.ts']), h1);
  rmSync(d, { recursive: true, force: true });
});

test('hash: folders are walked for sources, tests and the state folder left out', () => {
  const d = tmp();
  mkdirSync(join(d, 'p', '.state'), { recursive: true });
  writeFileSync(join(d, 'p', 'a.ts'), 'a');
  writeFileSync(join(d, 'p', 'a.test.ts'), 't');
  writeFileSync(join(d, 'p', '.state', 'live.json'), '{}');
  writeFileSync(join(d, 'p', 'README.md'), 'r');
  assert.deepEqual(filesOf(d, 'p'), ['p/a.ts']);
  rmSync(d, { recursive: true, force: true });
});

test('hash: a scenario\'s hash follows the engine, the executor, the harness and its own file - and only its own scenario file', () => {
  const d = tmp();
  const put = (rel: string, text: string) => {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), text);
  };
  put('packages/copy-engine/src/algo/runtime.ts', 'algo v1');
  put('packages/copy-engine/src/runtime.ts', 'copy v1');
  put('apps/executor/src/service.ts', 'exec v1');
  put('apps/executor/tools/live-test/harness.ts', 'harness v1');
  put('apps/executor/tools/live-test/scenarios/algos.ts', 'algos v1');
  put('apps/executor/tools/live-test/scenarios/copy.ts', 'copy scenarios v1');
  const algoS = { id: 'twap.a', deps: ['algo' as const], source: 'apps/executor/tools/live-test/scenarios/algos.ts' };
  const copyS = { id: 'copy.a', deps: ['copy' as const], source: 'apps/executor/tools/live-test/scenarios/copy.ts' };
  const h = () => {
    const c = new CodeHashes(d);
    return { a: c.scenario(algoS), c: c.scenario(copyS) };
  };
  const base = h();
  put('packages/copy-engine/src/runtime.ts', 'copy v2');
  const afterCopy = h();
  assert.equal(afterCopy.a, base.a, 'a copy-runtime change leaves the algo scenarios passed');
  assert.notEqual(afterCopy.c, base.c);
  put('apps/executor/tools/live-test/scenarios/copy.ts', 'copy scenarios v2');
  const afterCopyFile = h();
  assert.equal(afterCopyFile.a, afterCopy.a, 'editing the copy scenarios does not re-run the algo ones');
  assert.notEqual(afterCopyFile.c, afterCopy.c);
  put('apps/executor/src/service.ts', 'exec v2');
  const afterExec = h();
  assert.notEqual(afterExec.a, afterCopyFile.a, 'an executor change re-runs everything');
  assert.notEqual(afterExec.c, afterCopyFile.c);
  put('apps/executor/tools/live-test/harness.ts', 'harness v2');
  assert.notEqual(h().a, afterExec.a, 'a harness change re-runs everything');
  assert.notEqual(new CodeHashes(d).scenario({ ...algoS, rev: 2 }), new CodeHashes(d).scenario(algoS), 'a revision bump re-runs it');
  rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- cleanup ----- */

class FakeVenue implements FlattenVenue {
  calls: string[] = [];
  failReads = 0;
  failCloses = 0;
  stickyOrders = 0;
  constructor(
    readonly name: string,
    public pos: Record<string, number>,
    public orders: Record<string, VenueOrder[]>,
  ) {}
  async openOrders(s: string) {
    return [...(this.orders[s] ?? [])];
  }
  async position(s: string) {
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error('read failed');
    }
    return this.pos[s] ?? 0;
  }
  async cancel(s: string, os: VenueOrder[]) {
    this.calls.push(`cancel ${s} ${os.length}`);
    if (this.stickyOrders > 0) {
      this.stickyOrders -= 1;
      return;
    }
    this.orders[s] = (this.orders[s] ?? []).filter((o) => !os.some((x) => x.orderId === o.orderId));
  }
  async close(s: string, size: number) {
    this.calls.push(`close ${s} ${size}`);
    if (this.failCloses > 0) {
      this.failCloses -= 1;
      throw new Error('refused');
    }
    this.pos[s] = 0;
  }
}

const noSleep = async () => undefined;

test('cleanup: cancels every order (stops too) and closes every position on every market of every account, then reads them flat', async () => {
  const f = new FakeVenue('follower', { 'BTC-USD': 0.001, 'ETH-USD': -0.01 }, { 'BTC-USD': [{ orderId: '1', clOrdID: 'va-x-1', stop: false }, { orderId: '2', clOrdID: 'va-x-2', stop: true }] });
  const l = new FakeVenue('leader', { 'BTC-USD': 0.0002 }, {});
  const r = await flatten([f, l], ['BTC-USD', 'ETH-USD'], { sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.rounds, 2, 'a second round reads everything flat');
  assert.deepEqual(f.calls, ['cancel BTC-USD 2', 'close BTC-USD 0.001', 'close ETH-USD -0.01']);
  assert.deepEqual(l.calls, ['close BTC-USD 0.0002']);
  assert.match(r.lines.join('\n'), /1 stop/);
});

test('cleanup: already flat is one round of reads and nothing sent', async () => {
  const f = new FakeVenue('follower', {}, {});
  const r = await flatten([f], ['BTC-USD'], { sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.rounds, 1);
  assert.deepEqual(f.calls, []);
});

test('cleanup: a read that fails is never taken for flat; it is read again next round', async () => {
  const f = new FakeVenue('follower', { 'BTC-USD': 0.001 }, {});
  f.failReads = 2;
  const r = await flatten([f], ['BTC-USD'], { sleep: noSleep });
  assert.equal(r.ok, true);
  assert.ok(r.rounds >= 3, `the position was read for real before it was called flat (rounds ${r.rounds})`);
  assert.deepEqual(f.calls, ['close BTC-USD 0.001']);
});

test('cleanup: a refused close and a cancel that did not take are tried again', async () => {
  const f = new FakeVenue('follower', { 'BTC-USD': 0.001 }, { 'BTC-USD': [{ orderId: '9', clOrdID: null, stop: true }] });
  f.failCloses = 1;
  f.stickyOrders = 1;
  const r = await flatten([f], ['BTC-USD'], { sleep: noSleep });
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls, ['cancel BTC-USD 1', 'close BTC-USD 0.001', 'cancel BTC-USD 1', 'close BTC-USD 0.001']);
});

test('cleanup: what cannot be cleared is reported and ok is false (the runner then stops with the exposure flag set)', async () => {
  const f = new FakeVenue('follower', { 'BTC-USD': 0.001 }, {});
  f.failCloses = 99;
  const r = await flatten([f], ['BTC-USD'], { attempts: 3, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.rounds, 3);
  assert.deepEqual(r.left, [{ venue: 'follower', symbol: 'BTC-USD', position: 0.001, orders: 0 }]);
});

test('cleanup: dust below the market\'s step counts as flat', async () => {
  const f = new FakeVenue('follower', { 'BTC-USD': 1e-12 }, {});
  const r = await flatten([f], ['BTC-USD'], { sleep: noSleep, dust: () => 1e-9 });
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls, []);
});

test('start-up: a recorded exposure flattens; unrecorded positions are refused unless adopted; nothing there goes on', () => {
  const exp = { since: 1, by: 'twap.exits' };
  assert.equal(startDecision(exp, { orders: 0, positions: 1 }, false), 'flatten');
  assert.equal(startDecision(exp, { orders: 0, positions: 0 }, false), 'flatten', 'an exposure flag is cleared only by a cleanup that reads flat');
  assert.equal(startDecision(null, { orders: 2, positions: 0 }, false), 'refuse');
  assert.equal(startDecision(null, { orders: 2, positions: 1 }, true), 'flatten');
  assert.equal(startDecision(null, { orders: 0, positions: 0 }, false), 'clean');
  assert.equal(startDecision(null, { orders: 0, positions: 0 }, true), 'clean');
});

/* ----------------------------------------------------------------- budget ----- */

const MKT = (name: string, x: Partial<MarketInfo> = {}): MarketInfo => ({ id: 1, name, base: name.split('-')[0]!, tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', marketMaxQuantity: null, minNotional: 10, maxNotional: null, maxLeverage: 40, buyLimitUpRatio: 0.05, sellLimitDownRatio: 0.05, takerFee: 0.0004, makerFee: 0.00012, status: 'TRADING', ...x });

test('budget: the cheapest market is the one with the lowest taker fee plus half spread', () => {
  const p = pickMarket([
    { m: MKT('ETH-USD'), book: { bid: 2343.3, ask: 2343.4 } },
    { m: MKT('BTC-USD'), book: { bid: 80449, ask: 80450 } },
  ]);
  assert.equal(p.m.name, 'BTC-USD');
  assert.throws(() => pickMarket([{ m: MKT('BTC-USD', { status: 'HALT' }), book: { bid: 1, ask: 2 } }]));
});

test('budget: spent is fees + builder + half spread (+ the leader\'s fee and spread); peak margin is the largest scenario, not the sum', () => {
  const sc = (id: string, cost: Scenario['cost']): Scenario => ({ id, section: 'algo', kind: 'x', title: id, confirms: '', deps: [], source: '', dry: 'full', timeoutMs: 1, cost, run: async () => undefined });
  const b = computeBudget(
    [sc('a', (U) => ({ takerUsd: 2 * U, makerUsd: U, peakUsd: 4 * U })), sc('b', (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 2 * U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }))],
    { main: MKT('BTC-USD'), book: { bid: 99.99, ask: 100.01 }, U: 10, builderRate: 0.00025, leverage: 2, buffer: 1 },
  );
  const hs = 0.0001;
  const a = b.rows[0]!;
  assert.ok(Math.abs(a.feesUsd - (20 * (0.0004 + 0.00025) + 10 * (0.00012 + 0.00025))) < 1e-12);
  assert.ok(Math.abs(a.spreadUsd - 20 * hs) < 1e-12);
  assert.ok(Math.abs(b.rows[1]!.leaderUsd - 20 * (0.0004 + hs)) < 1e-12);
  assert.equal(b.total.peakMarginUsd, 20, 'max(40, 20) / 2x, not the sum');
  assert.equal(b.total.leaderPeakMarginUsd, 5);
  assert.ok(Math.abs(b.total.spentUsd - (a.spentUsd + b.rows[1]!.spentUsd)) < 1e-12);
});

/* -------------------------------------------------------------- catalogue ----- */

test('catalogue: every algo kind has a scenario, ids are unique, every scenario has a timeout and a non-negative cost', () => {
  const kinds = new Set(CATALOGUE.filter((s) => s.section === 'algo').map((s) => s.kind));
  for (const k of ALGO_KINDS) assert.ok(kinds.has(k), `a scenario for ${k}`);
  assert.equal(new Set(CATALOGUE.map((s) => s.id)).size, CATALOGUE.length);
  for (const s of CATALOGUE) {
    assert.ok(s.timeoutMs > 0, s.id);
    const c = s.cost(12);
    assert.ok(c.takerUsd >= 0 && c.makerUsd >= 0 && c.peakUsd >= 0, s.id);
    assert.ok(s.source.startsWith('apps/executor/tools/live-test/scenarios/'), s.id);
  }
  assert.ok(CATALOGUE.filter((s) => s.section === 'copy').every((s) => s.leader), 'every copy scenario needs the leader');
  assert.ok(CATALOGUE.findIndex((s) => s.section === 'copy') > CATALOGUE.findIndex((s) => s.section === 'algo'), 'copies run after algos');
});

test('dry: every spec a dry run sends is paper, the inner algo of a conditional too; a live one is refused before it is signed', () => {
  const env = { mode: 'dry', main: MKT('BTC-USD'), second: MKT('ETH-USD') } as unknown as Env;
  const t = new T(env, 'x');
  const s = t.spec({ kind: 'conditional', then: { type: 'algo', algo: { kind: 'chase', paper: false } } });
  assert.equal(s.paper, true);
  assert.equal((s.then as { algo: { paper: boolean } }).algo.paper, true);
  assert.doesNotThrow(() => assertPaper(s));
  assert.throws(() => assertPaper({ kind: 'twap', paper: false }), /not paper/);
  assert.throws(() => assertPaper({ kind: 'twap' }), /not paper/);
  assert.throws(() => assertPaper({ kind: 'conditional', paper: true, then: { type: 'algo', algo: { kind: 'twap', paper: false } } }), /not paper/);
  const live = new T({ ...env, mode: 'live' } as Env, 'y');
  assert.equal(live.spec({ kind: 'twap', paper: true }).paper, false, 'a live run sends live specs (EXECUTOR_LIVE_ALGOS=1 on its own executor)');
  assert.equal(t.settings({ paper: false }).paper, true, 'and paper copies');
});

test('abandon: once the runner stops waiting for a scenario (timeout, Ctrl+C), its code can send nothing more', async () => {
  const env = { mode: 'dry', main: MKT('BTC-USD'), second: MKT('ETH-USD'), timeScale: 0, log: () => undefined, proc: { exited: null } } as unknown as Env;
  const t = new T(env, 'x');
  t.abandon('timed out');
  await assert.rejects(t.start({ kind: 'twap' }), /abandoned \(timed out\)/);
  await assert.rejects(t.subscribe({}), /abandoned/);
  await assert.rejects(t.leader({ close: true }), /abandoned/);
  await assert.rejects(t.openPosition('buy', 12), /abandoned/);
  await assert.rejects(t.sleep(0), /abandoned/);
  await assert.rejects(t.waitFor('x', async () => true, { timeoutMs: 10 }), /abandoned/);
});
