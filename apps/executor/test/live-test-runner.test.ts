/**
 * The live test runner's own rules (apps/executor/tools/live-test): what is
 * resumed and what is skipped, the code hash a pass is tied to, the crash
 * repair of the state file, the cleanup that must leave the accounts flat
 * before anything else happens, the start-up decision, the budget, the
 * catalogue, and the targets (what each can do, what is skipped where, the
 * hosted pacing and refusals, one target at a time per wallet). None of it
 * touches SoDEX or ValueDesk's executor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ALGO_KINDS, COPY_FEE_LADDER, type MarketInfo } from '../../../packages/copy-engine/src/index.ts';
import { computeBudget, pickMarket } from '../tools/live-test/budget.ts';
import { CATALOGUE } from '../tools/live-test/catalogue.ts';
import { flatten, startDecision, type FlattenVenue, type VenueOrder } from '../tools/live-test/cleanup.ts';
import type { FillInfo, OrderInfo } from '../tools/live-test/exchange.ts';
import { CopyWallet, ExecutorError, assertPaper, type ExecutorProcess } from '../tools/live-test/executor.ts';
import { CheckFailed, Inconclusive, T, Unavailable, type Env } from '../tools/live-test/harness.ts';
import { CodeHashes, filesOf, hashFiles } from '../tools/live-test/hash.ts';
import type { Scenario } from '../tools/live-test/scenario.ts';
import { decide, emptyState, exposedOn, loadState, markDone, markRunning, noteRun, saveState, selected, stateFileOf } from '../tools/live-test/state.ts';
import { BrowserTarget, CAPABILITIES, HostedTarget, Pacer, SelfTarget, TARGETS, cannotRun, hostedRefusal, targetName, type BrowserDriver, type ExecutorTarget } from '../tools/live-test/target.ts';

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
  const env = { mode: 'dry', main: MKT('BTC-USD'), second: MKT('ETH-USD'), timeScale: 0, log: () => undefined, target: { gone: () => null } } as unknown as Env;
  const t = new T(env, 'x');
  t.abandon('timed out');
  await assert.rejects(t.start({ kind: 'twap' }), /abandoned \(timed out\)/);
  await assert.rejects(t.subscribe({}), /abandoned/);
  await assert.rejects(t.leader({ close: true }), /abandoned/);
  await assert.rejects(t.openPosition('buy', 12), /abandoned/);
  await assert.rejects(t.sleep(0), /abandoned/);
  await assert.rejects(t.waitFor('x', async () => true, { timeoutMs: 10 }), /abandoned/);
});

/* ---------------------------------------------------------------- targets ----- */

test('targets: --target takes self, hosted or browser; self can do everything, hosted and browser no restart, browser paper only', () => {
  assert.deepEqual([...TARGETS], ['self', 'hosted', 'browser']);
  assert.equal(targetName('hosted'), 'hosted');
  assert.throws(() => targetName('cloud'), /--target must be self, hosted, browser/);
  assert.deepEqual(CAPABILITIES.self, { restart: true, kill: true, localFeeStub: true });
  assert.deepEqual([CAPABILITIES.hosted.restart, CAPABILITIES.hosted.kill, CAPABILITIES.hosted.localFeeStub, CAPABILITIES.hosted.paperOnly ?? false], [false, false, false, false]);
  assert.equal(CAPABILITIES.browser.paperOnly, true);
});

test('targets: a scenario that restarts the executor declares it, and is skipped (with why) exactly where the target cannot', () => {
  const restarts = CATALOGUE.filter((s) => s.run.toString().includes('t.restart('));
  assert.deepEqual(restarts.map((s) => s.id).sort(), ['copy.restart', 'iceberg.restart', 'scale.restart', 'twap.restart']);
  for (const s of CATALOGUE) assert.equal(s.needs?.includes('restart') ?? false, restarts.includes(s), `${s.id} declares needs: ['restart'] exactly when it restarts`);
  for (const s of CATALOGUE) assert.equal(cannotRun(s, 'self'), null, `${s.id} runs on self`);
  for (const t of ['hosted', 'browser'] as const) {
    assert.deepEqual(CATALOGUE.filter((s) => cannotRun(s, t)).map((s) => s.id).sort(), restarts.map((s) => s.id).sort());
    assert.match(cannotRun({ needs: ['restart'] }, t) ?? '', new RegExp(`the ${t} target cannot kill the executor and start it again on the same data`));
  }
});

test('restart: on a target that cannot, T.restart is skipped as unavailable and kills nothing; a crash of a local executor ends a wait at once', async () => {
  const kills: string[] = [];
  const hosted = { name: 'hosted', capabilities: CAPABILITIES.hosted, kill: async () => kills.push('kill'), start: async () => undefined, gone: () => null } as unknown as ExecutorTarget;
  const t = new T({ mode: 'dry', timeScale: 0, log: () => undefined, target: hosted } as unknown as Env, 'x');
  await assert.rejects(t.restart(), (e: unknown) => e instanceof Unavailable && /the hosted target cannot be restarted/.test(e.message));
  assert.deepEqual(kills, []);
  const crashed = new T({ mode: 'dry', timeScale: 0, log: () => undefined, target: { gone: () => 'the executor process exited (code 1)' } } as unknown as Env, 'y');
  await assert.rejects(crashed.waitFor('the TWAP is done', async () => null, { timeoutMs: 60_000 }), (e: unknown) => e instanceof CheckFailed && e.message === 'the executor process exited (code 1) while waiting for: the TWAP is done');
});

test('self target: its own kill (a restart scenario: the leader trades while it is down) is not "gone"; a crash is', async () => {
  const proc = {
    o: { executorId: 'vd-livetest-dry', dataDir: 'd', logFile: 'l' },
    exited: null as null | { code: number | null },
    running: true,
    async kill() {
      this.exited = { code: null };
      this.running = false;
    },
    async start() {
      this.exited = null;
      this.running = true;
    },
  };
  const s = new SelfTarget(proc as unknown as ExecutorProcess, new CopyWallet(secp256k1.utils.randomPrivateKey()), 'dry');
  assert.equal(s.executorId, 'vd-livetest-dry');
  await s.kill();
  assert.equal(s.gone(), null, 'killed on purpose: a wait while it is down goes on');
  assert.equal((await s.health()).ok, false);
  await s.start();
  proc.exited = { code: 3 };
  assert.equal(s.gone(), 'the executor process exited (code 3)');
});

test('hosted pacing: no minute ever holds more requests than the pace allows', async () => {
  let now = 0;
  const sent: number[] = [];
  const p = new Pacer(3, { now: () => now, sleep: async (ms) => void (now += ms) });
  for (let i = 0; i < 10; i++) {
    await p.take();
    sent.push(now);
  }
  assert.deepEqual(sent.slice(0, 3), [0, 0, 0], 'the first ones go at once');
  for (const a of sent) assert.ok(sent.filter((b) => b >= a && b < a + 60_000).length <= 3, `the minute from ${a} holds at most 3`);
});

test('hosted refusals: closed, the brake and real algos not let for this wallet are inconclusive; a region refusal is skipped; anything else is the error itself', () => {
  const e = (status: number, code: string) => new ExecutorError(status, code, `/x: ${status} ${code}`);
  assert.ok(hostedRefusal(e(503, 'closed')) instanceof Inconclusive);
  assert.ok(hostedRefusal(e(503, 'brake')) instanceof Inconclusive);
  const po = hostedRefusal(e(403, 'paper-only'));
  assert.ok(po instanceof Inconclusive && /EXECUTOR_LIVE_ALGOS_WALLETS/.test(po.message));
  assert.ok(hostedRefusal(e(451, 'region')) instanceof Unavailable);
  assert.ok(hostedRefusal(e(451, 'sanctioned')) instanceof Unavailable);
  for (const [s, c] of [[503, 'other'], [400, 'spec'], [403, 'owner'], [412, 'key'], [429, 'rate']] as const) assert.equal(hostedRefusal(e(s, c)), null, `${s} ${c}`);
});

test('hosted target: ids from its /info, requests signed for that id, a closed executor\'s refusal thrown as inconclusive, a self executor refused', async () => {
  let info: Record<string, unknown> = { kind: 'hosted', network: 'mainnet', executorId: 'valuedesk-mainnet-tokyo', keyName: 'vd-copy-tokyo', version: '1.1.0', viewerCountry: 'DE' };
  const signedFor: string[] = [];
  const srv = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/copy/v1/info') return void res.end(JSON.stringify(info));
    if (req.url === '/api/copy/v1/health') return void res.end(JSON.stringify({ ok: true }));
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      signedFor.push((JSON.parse(body) as { request: { executor: string } }).request.executor);
      res.statusCode = 503;
      res.end(JSON.stringify({ code: 'closed', error: 'The ValueDesk executor takes no new orders right now.' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/copy/v1`;
  try {
    const h = new HostedTarget(new CopyWallet(secp256k1.utils.randomPrivateKey()), 'dry', base);
    assert.equal(await h.observedCountry(), 'DE');
    await assert.rejects(h.algoStart({ kind: 'twap', paper: true }), /not known yet/, 'nothing is signed before /info named the id');
    await h.start();
    assert.deepEqual([h.executorId, h.keyName], ['valuedesk-mainnet-tokyo', 'vd-copy-tokyo']);
    assert.equal(h.release(info as never), '1.1.0');
    assert.equal(h.release({ ...info, commit: 'f222f14' } as never), '1.1.0+f222f14');
    await assert.rejects(h.algoStart({ kind: 'twap', paper: true }), (x: unknown) => x instanceof Inconclusive && /takes nothing new right now/.test(x.message));
    assert.deepEqual(signedFor, ['valuedesk-mainnet-tokyo']);
    await assert.rejects(h.algoStart({ kind: 'twap', paper: false }), /dry run: refusing a spec that is not paper/);
    assert.equal(signedFor.length, 1, 'a dry run on hosted sends paper only: refused before signing');
    await assert.rejects(h.kill(), Unavailable);
    info = { ...info, kind: 'self' };
    await assert.rejects(new HostedTarget(new CopyWallet(secp256k1.utils.randomPrivateKey()), 'dry', base).start(), /not ValueDesk's executor on mainnet/);
  } finally {
    srv.close();
  }
});

test('browser target: without the web test bridge it stops at the start, saying so; given a driver, every call goes to it', async () => {
  const b = new BrowserTarget('dry');
  await assert.rejects(b.start(), /the browser target needs the web test bridge \(apps\/web e2e\)/);
  await assert.rejects(b.info(), /web test bridge/);
  assert.equal((await b.health()).ok, false);
  await b.stop();
  await b.stopEverything();
  const calls: string[] = [];
  const driver = new Proxy({}, { get: (_, k) => async () => (calls.push(String(k)), k === 'ready' ? true : []) }) as unknown as BrowserDriver;
  const d = new BrowserTarget('dry', driver);
  await d.start();
  await d.algoAct('cancel-all');
  assert.equal((await d.health()).ok, true);
  await assert.rejects(d.algoStart({ kind: 'twap', paper: false }), /not paper/, 'a dry run sends the page paper only');
  await assert.rejects(d.subscribe({ paper: false }), /not paper/);
  assert.deepEqual(calls, ['open', 'algoAct', 'ready']);
});

test('fees: self checks the ladder\'s top step exactly; hosted accepts one step of the ladder, the same on every order, notes it and checks the fills by it', async () => {
  const order = (fee: number | null): OrderInfo => ({ orderId: '1', clOrdID: 'va-x-1', side: 'buy', price: 100, qty: 1, filled: 1, tif: 'IOC', type: 'LIMIT', status: 'FILLED', reduceOnly: false, stop: null, builderFee: fee, createdAt: 0 });
  const fill = (rate: number): FillInfo => ({ clOrdID: 'va-x-1', orderId: '1', side: 'buy', price: 100, qty: 1, fee: 0, builderFee: (100 * rate) / 100_000, maker: false, time: 0 });
  const ladder = COPY_FEE_LADDER.map((s) => s.fee);
  const mk = (orderFee: number | null) => new T({ mode: 'live', log: () => undefined, builderLadder: ladder, orderFee, target: { gone: () => null } } as unknown as Env, 'x');
  const self = mk(25);
  assert.equal(self.feeText, '2.5 bp');
  assert.equal(self.checkOrderFees([order(25), order(25)]), 25);
  assert.throws(() => mk(25).checkOrderFees([order(20)]), CheckFailed);
  await self.checkBuilderFee([fill(25)]);
  const hosted = mk(null);
  assert.equal(hosted.feeText, 'a step of its fee ladder');
  assert.equal(hosted.checkOrderFees([order(20), order(20)]), 20);
  assert.equal(hosted.feeRate, 20);
  assert.match(hosted.notes.join('\n'), /builder fee 20 \(2 bp\)/);
  await hosted.checkBuilderFee([fill(20), fill(20)]);
  await assert.rejects(hosted.checkBuilderFee([fill(25)]), CheckFailed, 'the fills are charged the orders\' step');
  assert.throws(() => mk(null).checkOrderFees([order(20), order(15)]), CheckFailed, 'not the same on every order');
  assert.throws(() => mk(null).checkOrderFees([order(22)]), CheckFailed, 'not a step of the ladder');
  assert.throws(() => mk(null).checkOrderFees([order(null)]), CheckFailed, 'no builder on the order');
  // No order check before: the step nearest the fills' own.
  const fresh = mk(null);
  await fresh.checkBuilderFee([fill(15), fill(15)]);
  assert.match(fresh.notes.join('\n'), /builder fee 15/);
});

test('state per target: <mode>-<target>.json; a self state from before targets is renamed to its new name and still counts', () => {
  const d = tmp();
  assert.equal(stateFileOf(d, 'live', 'hosted'), join(d, 'live-hosted.json'));
  const old = { version: 1, mode: 'live', scenarios: { 'twap.a': { status: 'passed', hash: 'h1', endedAt: 1 } }, exposure: null, executor: null, runs: [{ at: 1, codeHash: 'c', selected: 1, passed: 1, failed: 0, skipped: 0 }] };
  writeFileSync(join(d, 'live.json'), JSON.stringify(old));
  assert.equal(stateFileOf(d, 'live', 'hosted'), join(d, 'live-hosted.json'));
  assert.ok(existsSync(join(d, 'live.json')), 'only self takes the old file');
  const f = stateFileOf(d, 'live', 'self');
  assert.equal(f, join(d, 'live-self.json'));
  assert.ok(!existsSync(join(d, 'live.json')) && existsSync(f));
  const { state, report } = loadState(f, 'live', 5, 'self');
  assert.equal(report.corrupt, null);
  assert.equal(state.target, 'self');
  assert.equal(state.follower, null);
  assert.equal(state.runs[0]!.target, 'self');
  assert.equal(decide(state, S('twap.a'), 'h1', { only: null, force: false }).run, false, 'what passed before targets is still passed on the same code');
  assert.equal(stateFileOf(d, 'live', 'self'), f, 'once renamed, the new name is used');
  rmSync(d, { recursive: true, force: true });
});

test('state per target: another target\'s file is never read as this one\'s (kept aside, read as exposed); runs name their target', () => {
  const d = tmp();
  const f = join(d, 'live-self.json');
  saveState(f, emptyState('live', 'hosted'));
  const r = loadState(f, 'live', 7, 'self');
  assert.match(r.report.corrupt ?? '', /hosted target/);
  assert.deepEqual(r.state.exposure, { since: 7, by: 'unreadable state file' });
  const s = emptyState('dry', 'hosted');
  noteRun(s, { at: 1, target: 'hosted', codeHash: 'x', selected: 1, passed: 1, failed: 0, skipped: 0 });
  saveState(join(d, 'dry-hosted.json'), s);
  const back = loadState(join(d, 'dry-hosted.json'), 'dry', 1, 'hosted').state;
  assert.equal(back.target, 'hosted');
  assert.equal(back.runs[0]!.target, 'hosted');
  rmSync(d, { recursive: true, force: true });
});

test('one target at a time per wallet: another target\'s recorded exposure, a scenario a crash left running there, or its unreadable file stops a start; another wallet\'s or a clean one does not', () => {
  const d = tmp();
  const me = `0x${'a'.repeat(40)}`;
  const f = join(d, 'live-hosted.json');
  assert.equal(exposedOn(f, me), null, 'no file');
  const s = emptyState('live', 'hosted');
  s.follower = me;
  saveState(f, s);
  assert.equal(exposedOn(f, me), null, 'clean');
  s.exposure = { since: 0, by: 'twap.exits' };
  saveState(f, s);
  assert.match(exposedOn(f, me) ?? '', /may still be out.*twap\.exits/);
  assert.equal(exposedOn(f, `0x${'b'.repeat(40)}`), null, 'a state of another follower wallet');
  s.follower = null;
  saveState(f, s);
  assert.ok(exposedOn(f, `0x${'b'.repeat(40)}`), 'a state that names no wallet (from before targets) counts for any');
  s.exposure = null;
  s.follower = me;
  markRunning(s, 'scale.restart', 'h');
  saveState(f, s);
  assert.match(exposedOn(f, me) ?? '', /scale\.restart was left running by a crash/);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).scenarios['scale.restart'].status, 'running', 'read as it is: nothing repaired');
  writeFileSync(f, '{"version":1,');
  assert.match(exposedOn(f, me) ?? '', /cannot be read/);
  rmSync(d, { recursive: true, force: true });
});

test('hash per target: self\'s is what it was before targets; hosted adds the release /info names; browser adds the web runtime\'s files', () => {
  const d = tmp();
  const put = (rel: string, text: string) => {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), text);
  };
  put('packages/copy-engine/src/algo/runtime.ts', 'algo v1');
  put('apps/executor/src/service.ts', 'exec v1');
  put('apps/executor/tools/live-test/harness.ts', 'harness v1');
  put('apps/executor/tools/live-test/scenarios/algos.ts', 'algos v1');
  put('apps/web/src/algo/browserAlgos.ts', 'web v1');
  const s = { id: 'twap.a', deps: ['algo' as const], source: 'apps/executor/tools/live-test/scenarios/algos.ts' };
  const c = new CodeHashes(d);
  const before = createHash('sha256');
  for (const g of ['algo', 'core', 'harness'] as const) before.update(`${g}:${c.group(g)}\n`);
  before.update(`source:${hashFiles(d, [s.source])}\n`);
  before.update('twap.a#1');
  const self = c.scenario(s);
  assert.equal(self, before.digest('hex').slice(0, 16), 'self: the hash of before targets, so what passed there still counts');
  assert.equal(new CodeHashes(d, { name: 'self' }).scenario(s), self);
  const hosted = (release: string) => new CodeHashes(d, { name: 'hosted', release }).scenario(s);
  const h1 = hosted('1.1.0');
  assert.notEqual(h1, self, 'a pass on self never stands for hosted');
  assert.notEqual(hosted('1.2.0'), h1, 'another release of ValueDesk\'s executor runs it again');
  const browser = () => new CodeHashes(d, { name: 'browser' }).scenario(s);
  const b1 = browser();
  put('apps/web/src/algo/browserAlgos.ts', 'web v2');
  assert.notEqual(browser(), b1, 'a change to the web runtime runs it again on browser');
  assert.equal(new CodeHashes(d).scenario(s), self, 'but not on self');
  assert.equal(hosted('1.1.0'), h1, 'nor on hosted');
  assert.equal(new CodeHashes(d).all(), new CodeHashes(d, { name: 'self' }).all());
  assert.notEqual(new CodeHashes(d, { name: 'hosted', release: '1.1.0' }).all(), new CodeHashes(d).all());
  rmSync(d, { recursive: true, force: true });
});
