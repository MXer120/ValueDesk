/**
 * The live test runner's own rules (apps/executor/tools/live-test): what is
 * resumed and what is skipped, the code hash a pass is tied to, the crash
 * repair of the state file, the cleanup that must leave the accounts flat
 * before anything else happens, the start-up decision, the budget, the
 * catalogue, and the targets (what each can do, what is skipped where, the
 * hosted pacing and refusals, one target at a time per wallet), the leader's
 * venue (what is skipped with which leader, what the leader trades, its hash,
 * its cost), and the fee ladder's stub and scenarios. None of it touches SoDEX,
 * Hyperliquid or ValueDesk's executor (the Hyperliquid client's own tests:
 * live-test-hyperliquid.test.ts).
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
import { ALGO_KINDS, COPY_FEE_LADDER, copyFeeFor, type AlgoView, type FetchLike, type MarketInfo, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { ExecutorService } from '../src/service.ts';
import { computeBudget, formatBudget, pickLiquidation, pickMarket, pickVolatile } from '../tools/live-test/budget.ts';
import { CATALOGUE } from '../tools/live-test/catalogue.ts';
import { flatten, startDecision, type FlattenVenue, type VenueOrder } from '../tools/live-test/cleanup.ts';
import { SodexReads, type FillInfo, type OrderInfo } from '../tools/live-test/exchange.ts';
import { CopyWallet, ExecutorError, assertPaper, type ExecutorProcess } from '../tools/live-test/executor.ts';
import { DEFAULT_VOLUME, VOLUME_PATH, VolumeStub } from '../tools/live-test/feeStub.ts';
import { CheckFailed, Inconclusive, T, Unavailable, type Env } from '../tools/live-test/harness.ts';
import { CodeHashes, filesOf, hashFiles } from '../tools/live-test/hash.ts';
import { HL_MIN_ORDER_USD, HL_TAKER_FEE } from '../tools/live-test/hyperliquid.ts';
import type { LeaderTrade, LeaderVenue } from '../tools/live-test/leader.ts';
import { leaderSkip, type Scenario } from '../tools/live-test/scenario.ts';
import { LIQ_MAX_MARGIN } from '../tools/live-test/scenarios/liquidation.ts';
import { decide, emptyState, exposedOn, loadState, markDone, markRunning, noteRun, saveState, selected, stateFileOf } from '../tools/live-test/state.ts';
import { BrowserTarget, CAPABILITIES, HostedTarget, capabilitiesOf, Pacer, SelfTarget, TARGETS, cannotRun, hostedRefusal, targetName, type BrowserDriver, type ExecutorTarget } from '../tools/live-test/target.ts';

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

test('the take-profit market: the one whose one-minute ranges average highest, among those trading with a tight spread', () => {
  const k = (rangeFrac: number, n = 10) => Array.from({ length: n }, () => ({ h: 100 * (1 + rangeFrac), l: 100, c: 100 }));
  const v = pickVolatile([
    { m: MKT('SOL-USD', { tickSize: '0.01' }), book: { bid: 100, ask: 100.01 }, candles: k(0.002) },
    { m: MKT('DOGE-USD', { tickSize: '0.01' }), book: { bid: 100, ask: 100.01 }, candles: k(0.004) },
    { m: MKT('PUMP-USD', { tickSize: '0.01' }), book: { bid: 100, ask: 100.1 }, candles: k(0.02) }, // 10 bp wide: left out
    { m: MKT('HYPE-USD', { status: 'HALT', tickSize: '0.01' }), book: { bid: 100, ask: 100.01 }, candles: k(0.05) }, // not trading
    { m: MKT('SUI-USD', { tickSize: '0.01' }), book: { bid: 100, ask: 100.01 }, candles: k(0.05, 3) }, // too few candles
    { m: MKT('1000PEPE-USD', { tickSize: '0.2' }), book: { bid: 100, ask: 100.01 }, candles: k(0.05) }, // a tick of 20 bp: left out
  ]);
  assert.equal(v?.m.name, 'DOGE-USD');
  assert.ok(Math.abs(v!.rangeBps - 40) < 1e-6, `${v?.rangeBps}`);
  assert.equal(pickVolatile([]), null, 'none: the run falls back to the main market');
});

test('the liquidation market: the highest max leverage x one-minute range (the distance to liquidation is about 1 / max leverage)', () => {
  const k = (rangeFrac: number) => Array.from({ length: 10 }, () => ({ h: 100 * (1 + rangeFrac), l: 100, c: 100 }));
  const book = { bid: 100, ask: 100.01 };
  const v = pickLiquidation([
    { m: MKT('BTC-USD', { tickSize: '0.01', maxLeverage: 40 }), book, candles: k(0.0003) }, // 40 x 3 bp = 120
    { m: MKT('SOL-USD', { tickSize: '0.01', maxLeverage: 20 }), book, candles: k(0.001) }, // 20 x 10 bp = 200
    { m: MKT('HYPE-USD', { tickSize: '0.01', maxLeverage: 10 }), book, candles: k(0.0018) }, // 10 x 18 bp = 180
  ]);
  assert.equal(v?.m.name, 'SOL-USD');
  assert.ok(Math.abs(v!.score - 200) < 1e-6, `${v?.score}`);
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

test('targets: --target takes self, hosted or browser; self can do all but close a tab, hosted no restart, browser a reload but no hard kill', () => {
  assert.deepEqual([...TARGETS], ['self', 'hosted', 'browser']);
  assert.equal(targetName('hosted'), 'hosted');
  assert.throws(() => targetName('cloud'), /--target must be self, hosted, browser/);
  assert.deepEqual(CAPABILITIES.self, { restart: true, kill: true, localFeeStub: true, keyImport: true, tabClose: false, ui: false });
  assert.deepEqual([CAPABILITIES.hosted.restart, CAPABILITIES.hosted.kill, CAPABILITIES.hosted.localFeeStub, CAPABILITIES.hosted.paperOnly ?? false, CAPABILITIES.hosted.keyImport], [false, false, false, false, true]);
  assert.deepEqual(CAPABILITIES.browser, { restart: true, kill: false, localFeeStub: false, keyImport: false, tabClose: true, ui: true }, 'live too: real algos as the dev web lets them (VITE_LIVE_ALGOS_WALLETS)');
});

test('targets: a scenario that restarts the executor declares it, and is skipped (with why) exactly where the target cannot', () => {
  const restarts = CATALOGUE.filter((s) => s.run.toString().includes('t.restart('));
  const fees = CATALOGUE.filter((s) => s.section === 'fee').map((s) => s.id);
  assert.deepEqual(restarts.map((s) => s.id).sort(), ['bot.restart', 'copy.restart', 'copym.restart-close', 'iceberg.restart', 'scale.restart', 'twap.restart', ...fees].sort(), 'the fee scenarios restart it so it forgets the volume it holds');
  for (const s of CATALOGUE) assert.equal(s.needs?.includes('restart') ?? false, restarts.includes(s), `${s.id} declares needs: ['restart'] exactly when it restarts`);
  const tabs = CATALOGUE.filter((s) => s.run.toString().includes('t.closeTab('));
  assert.deepEqual(tabs.map((s) => s.id).sort(), ['copym.tab-close', 'twap.tab-close']);
  for (const s of CATALOGUE) assert.equal(s.needs?.includes('tabClose') ?? false, tabs.includes(s), `${s.id} declares needs: ['tabClose'] exactly when it closes the tab`);
  const imports = CATALOGUE.filter((s) => s.run.toString().includes('importKey('));
  assert.deepEqual(imports.map((s) => s.id), ['setup.key-import']);
  for (const s of CATALOGUE) assert.equal(s.needs?.includes('keyImport') ?? false, imports.includes(s), `${s.id} declares needs: ['keyImport'] exactly when it imports a key`);
  // The page's own controls (scenarios/ui.ts): every scenario that works the page declares it, and only the browser can.
  const pages = CATALOGUE.filter((s) => /\bt\.ui\(|startCopyInWindow\(/.test(s.run.toString()));
  assert.deepEqual(pages.map((s) => s.id).sort(), ['algo.ui-cancel-exits', 'copy.ui-close', 'copy.ui-confirm', 'copy.ui-notices', 'position.isolated-margin', 'position.tpsl-sheet', 'spot.order', 'ticket.cancel-all', 'ticket.leverage', 'ticket.limit-cancel', 'ticket.market-close', 'ticket.modify', 'ticket.stop', 'ticket.tpsl']);
  for (const s of CATALOGUE) assert.equal(s.needs?.includes('ui') ?? false, pages.includes(s), `${s.id} declares needs: ['ui'] exactly when it works the page`);
  for (const t of ['self', 'hosted'] as const) {
    assert.deepEqual(CATALOGUE.filter((s) => cannotRun(s, t) && !tabs.includes(s) && !pages.includes(s)).map((s) => s.id).sort(), t === 'self' ? [] : restarts.map((s) => s.id).sort());
    for (const tab of tabs) assert.match(cannotRun(tab, t) ?? '', new RegExp(`the ${t} target cannot close the browser tab that runs the algos`));
    for (const p of pages) assert.match(cannotRun(p, t) ?? '', new RegExp(`the ${t} target cannot work ValueDesk's own pages`));
  }
  assert.match(cannotRun({ needs: ['restart'] }, 'hosted') ?? '', /the hosted target cannot kill the executor and start it again on the same data/);
  // LIVE_HOSTED_CRASH=1: ValueDesk's executor is crashed on server 2 (hostedOps.ts), so its restart scenarios run; nothing else changes.
  const crashOn = { LIVE_HOSTED_CRASH: '1' };
  assert.deepEqual(capabilitiesOf('hosted', crashOn), { ...CAPABILITIES.hosted, restart: true, kill: true });
  assert.deepEqual(capabilitiesOf('self', crashOn), CAPABILITIES.self);
  assert.deepEqual(capabilitiesOf('hosted', {}), CAPABILITIES.hosted);
  for (const s of restarts.filter((x) => !x.needs?.includes('localFeeStub'))) assert.equal(cannotRun(s, 'hosted', capabilitiesOf('hosted', crashOn)), null, `${s.id} runs on hosted with LIVE_HOSTED_CRASH=1`);
  // The browser reloads for a restart: it skips only what needs the runner's fee stub, and the key import.
  assert.deepEqual(CATALOGUE.filter((s) => cannotRun(s, 'browser')).map((s) => s.id).sort(), [...fees, 'setup.key-import'].sort());
  assert.match(cannotRun(imports[0]!, 'browser') ?? '', /the browser target cannot be given a SoDEX key the follower made \(key import\)/);
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
  // SoDEX's order history names no builder (2026-10-29): nothing to check there, the fills carry it.
  const unnamed = mk(null);
  assert.equal(unnamed.checkOrderFees([order(null), order(null)]), null);
  assert.equal(unnamed.feeRate, null, 'no step taken from orders that name none');
  assert.match(unnamed.notes.join('\n'), /names no builder on these 2 orders/);
  assert.equal(mk(25).checkOrderFees([order(null)]), 25, 'the known fee stays the one the fills are checked by');
  assert.throws(() => mk(25).checkOrderFees([order(null), order(20)]), CheckFailed, 'an order that names one is still held to it');
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

/* ----------------------------------------------------------- the leader ----- */

test('leader venue: every copy scenario runs with either leader; the Hyperliquid-only ones are skipped with a SoDEX leader, with why', () => {
  const hlOnly = CATALOGUE.filter((s) => s.leaderVenue === 'hyperliquid').map((s) => s.id).sort();
  assert.deepEqual(hlOnly, ['copy.hl-follow', 'copy.hl-k-prefix', 'copy.hl-not-on-sodex', 'copy.hl-slices', 'copym.hl-different-asset']);
  for (const s of CATALOGUE) {
    assert.equal(leaderSkip(s, 'hyperliquid'), null, `${s.id} runs with a Hyperliquid leader`);
    assert.equal(leaderSkip(s, 'sodex') !== null, hlOnly.includes(s.id), `${s.id} with a SoDEX leader`);
  }
  assert.match(leaderSkip({ leaderVenue: 'hyperliquid' }, 'sodex') ?? '', /it needs a leader on Hyperliquid \(LIVE_LEADER_VENUE=hyperliquid\)/);
  for (const s of CATALOGUE.filter((x) => x.section === 'copy')) {
    assert.ok(s.leader && s.deps.includes('leader'), `${s.id} needs the leader and hashes its driver`);
    assert.ok((s.cost(12).leaderTakerUsd ?? 0) > 0, `${s.id} costs the leader's trades`);
  }
});

/** A leader that records what it is asked to do; its positions in USD at a mark of 1. */
class FakeLeader implements LeaderVenue {
  readonly venue = 'hyperliquid' as const;
  readonly name = 'leader';
  readonly where = 'Hyperliquid';
  readonly address = '0x' + 'ab'.repeat(20);
  pos: Record<string, number> = {};
  calls: string[] = [];
  symbolFor(s: string) {
    return s.replace(/-USD$/, '');
  }
  async preflight() {
    return { account: 'Hyperliquid perps', equity: 50 };
  }
  async prepare() {}
  async equity() {
    return 50;
  }
  async mark() {
    return 1;
  }
  private trade(sym: string, usd: number): LeaderTrade {
    this.calls.push(`${usd > 0 ? 'buy' : 'sell'} ${sym} ${Math.abs(usd)}`);
    this.pos[sym] = (this.pos[sym] ?? 0) + usd;
    return { ref: String(this.calls.length), sentAt: 1, answeredAt: 2 };
  }
  async buyUsd(sym: string, usd: number) {
    return this.trade(sym, usd);
  }
  async sellUsd(sym: string, usd: number) {
    return this.trade(sym, -usd);
  }
  async fills() {
    return [];
  }
  async openOrders() {
    return [];
  }
  async position(s: string) {
    return this.pos[s] ?? 0;
  }
  async cancel() {}
  async close(s: string, size: number) {
    this.calls.push(`close ${s} ${size}`);
    this.pos[s] = 0;
  }
}

test('leader: T trades the leader\'s own market of a SoDEX market (or one only its venue has), names its venue in the copy settings, keeps its trades for the clocks', async () => {
  const L = new FakeLeader();
  const env = { mode: 'live', leader: L, leaderVenue: 'hyperliquid', leaderAddress: L.address, main: MKT('BTC-USD'), second: MKT('ETH-USD'), timeScale: 0, log: () => undefined, target: { gone: () => null } } as unknown as Env;
  const t = new T(env, 'x');
  await t.leader({ buyUsd: 12 });
  await t.leaderSlices('buy', 12, 3);
  assert.equal(await t.leaderUsd(), 48);
  await t.leader({ sellUsd: 12 });
  await t.leaderTrade({ buyUsd: 12 }, 'kPEPE');
  assert.equal(await t.leaderUsdOf('kPEPE'), 12);
  await t.leader({ close: true });
  await t.leaderTrade({ close: true }, 'kPEPE');
  assert.deepEqual(L.calls, ['buy BTC 12', 'buy BTC 12', 'buy BTC 12', 'buy BTC 12', 'sell BTC 12', 'buy kPEPE 12', 'close BTC 36', 'close kPEPE 12']);
  assert.equal(t.leaderTrades.length, 6, 'every IOC the leader sent, closes aside');
  assert.deepEqual(t.settings({}).leader, { venue: 'hyperliquid', address: L.address });
  assert.equal(t.leaderSymbol('ETH-USD'), 'ETH');
  // A dry run has no leader to trade: nothing is sent, the venue's names still apply.
  const dry = new T({ ...env, mode: 'dry', leader: null } as unknown as Env, 'y');
  await dry.leaderSlices('buy', 12, 3);
  await dry.leaderTrade({ buyUsd: 12 }, 'kPEPE');
  assert.equal(dry.checks.liveOnly, 2);
  assert.equal(dry.leaderSymbol(), 'BTC');
  assert.equal(new T({ ...env, mode: 'dry', leader: null, leaderVenue: 'sodex' } as unknown as Env, 'z').leaderSymbol(), 'BTC-USD');
});

test('hash: the leader\'s driver re-runs the copy scenarios only; a pass with a Hyperliquid leader never stands for a SoDEX one', () => {
  const d = tmp();
  const put = (rel: string, text: string) => {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), text);
  };
  put('apps/executor/src/service.ts', 'exec v1');
  put('apps/executor/tools/live-test/harness.ts', 'harness v1');
  put('apps/executor/tools/live-test/leader.ts', 'leader v1');
  put('apps/executor/tools/live-test/hyperliquid.ts', 'hl v1');
  put('apps/executor/tools/live-test/scenarios/algos.ts', 'algos v1');
  put('apps/executor/tools/live-test/scenarios/copy.ts', 'copy v1');
  const algoS = { id: 'twap.a', deps: ['algo' as const], source: 'apps/executor/tools/live-test/scenarios/algos.ts' };
  const copyS = { id: 'copy.a', deps: ['copy' as const, 'leader' as const], source: 'apps/executor/tools/live-test/scenarios/copy.ts', leader: true };
  const h = (leader?: 'sodex' | 'hyperliquid') => {
    const c = new CodeHashes(d, { name: 'self', leader });
    return { a: c.scenario(algoS), c: c.scenario(copyS) };
  };
  const base = h();
  assert.deepEqual(h('sodex'), base, 'a SoDEX leader hashes as before venues');
  const hl = h('hyperliquid');
  assert.equal(hl.a, base.a, 'the algo scenarios do not care where the leader is');
  assert.notEqual(hl.c, base.c);
  put('apps/executor/tools/live-test/hyperliquid.ts', 'hl v2');
  const afterHl = h();
  assert.equal(afterHl.a, base.a, 'the Hyperliquid client is not the algo scenarios\' code');
  assert.notEqual(afterHl.c, base.c);
  put('apps/executor/tools/live-test/leader.ts', 'leader v2');
  const afterLeader = h();
  assert.equal(afterLeader.a, base.a);
  assert.notEqual(afterLeader.c, afterHl.c);
  put('apps/executor/tools/live-test/harness.ts', 'harness v2');
  const afterHarness = h();
  assert.notEqual(afterHarness.a, base.a, 'the harness still re-runs everything');
  assert.notEqual(afterHarness.c, afterLeader.c);
  rmSync(d, { recursive: true, force: true });
});

test('cleanup: an account that names its own markets is flattened on them (a Hyperliquid leader\'s coins); one whose markets cannot be read is not flat', async () => {
  const f = new FakeVenue('follower', { 'BTC-USD': 0.001 }, {});
  const l = Object.assign(new FakeVenue('leader', { BTC: 0.002, kPEPE: -5 }, {}), { markets: async (s: readonly string[]) => [...s.map((x) => x.replace(/-USD$/, '')), 'kPEPE'] });
  const r = await flatten([f, l], ['BTC-USD'], { sleep: noSleep });
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls, ['close BTC-USD 0.001']);
  assert.deepEqual(l.calls, ['close BTC 0.002', 'close kPEPE -5']);
  let down = 2;
  const blind = Object.assign(new FakeVenue('leader', { BTC: 0.002 }, {}), {
    markets: async (s: readonly string[]) => (down-- > 0 ? Promise.reject(new Error('Hyperliquid did not answer')) : s.map((x) => x.replace(/-USD$/, ''))),
  });
  const r2 = await flatten([blind], ['BTC-USD'], { attempts: 2, sleep: noSleep });
  assert.equal(r2.ok, false, 'unknown is never flat');
  assert.deepEqual(r2.left, [{ venue: 'leader', symbol: '(its markets)', position: NaN, orders: NaN }]);
  assert.match(r2.lines.join('\n'), /its markets could not be read \(Hyperliquid did not answer\)/);
  const r3 = await flatten([blind], ['BTC-USD'], { sleep: noSleep });
  assert.equal(r3.ok, true, 'read again, it is cleared');
  assert.deepEqual(blind.calls, ['close BTC 0.002']);
});

test('budget: a Hyperliquid leader is costed at its 4.5 bp and its own spread, its deposit named on Hyperliquid, its $10 minimum stated', () => {
  const sc: Scenario = { id: 'copy.x', section: 'copy', kind: 'copy', title: '', confirms: '', deps: [], source: '', dry: 'lifecycle', timeoutMs: 1, leader: true, cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }), run: async () => undefined };
  const input = { main: MKT('BTC-USD'), book: { bid: 99.99, ask: 100.01 }, U: 12, builderRate: 0.00025, leverage: 2, buffer: 1 };
  const sodex = computeBudget([sc], input);
  assert.ok(Math.abs(sodex.rows[0]!.leaderUsd - 24 * (0.0004 + 0.0001)) < 1e-12, 'a SoDEX leader as before');
  assert.equal(sodex.leaderWhere, 'SoDEX');
  const hl = computeBudget([sc], { ...input, leader: { venue: 'hyperliquid', market: 'BTC', takerFee: HL_TAKER_FEE, halfSpread: 0.00002, minOrderUsd: HL_MIN_ORDER_USD } });
  assert.ok(Math.abs(hl.rows[0]!.leaderUsd - 24 * (0.00045 + 0.00002)) < 1e-12);
  assert.equal(hl.rows[0]!.feesUsd, sodex.rows[0]!.feesUsd, 'the follower pays the same');
  assert.equal(hl.total.leaderTraded, 24);
  assert.equal(hl.leaderWhere, 'Hyperliquid');
  assert.match(hl.assumptions.join('\n'), /the leader trades on Hyperliquid \(BTC\): taker 4\.50 bp \(its base tier\), half spread 0\.200 bp on its book now, no builder; its minimum order \$10, every leader order is at least U \(\$12\)/);
  assert.match(formatBudget(hl), /deposit at least: follower \$\d+\.\d+ on SoDEX, leader \$\d+\.\d+ on Hyperliquid/);
  const small = computeBudget([sc], { ...input, U: 8, leader: { venue: 'hyperliquid', market: 'BTC', takerFee: HL_TAKER_FEE, halfSpread: null, minOrderUsd: HL_MIN_ORDER_USD } });
  assert.match(small.assumptions.join('\n'), /its book not read: SoDEX's half spread used.*every leader order is raised to it \(U is \$8\)/);
});

/* --------------------------------------------------------- the fee ladder ----- */

const FOLLOWER = '0x' + 'ab'.repeat(20);
const volumeUrl = (q: Record<string, string>) => `${VOLUME_PATH}?${new URLSearchParams(q).toString()}`;

test('fee stub: it answers what it is set to, asked as the API server is asked; any other ask is answered as the server would and recorded as a problem', () => {
  const stub = new VolumeStub(FOLLOWER);
  stub.builder = 234812;
  const ask = { address: '0x' + 'AB'.repeat(20), builder: '234812', days: '14' };
  const ok = stub.judge(volumeUrl(ask), stub.token);
  assert.deepEqual([ok.status, ok.body, ok.read.problem], [200, { ok: true, usd: 0, days: 14 }, null], '$0 by default, the address in any case');
  stub.answer = { usd: 600_000 };
  assert.deepEqual(stub.judge(volumeUrl(ask), stub.token).body, { ok: true, usd: 600_000, days: 14 });
  stub.answer = { status: 500 };
  const failed = stub.judge(volumeUrl(ask), stub.token);
  assert.deepEqual([failed.status, failed.read.problem], [500, null], 'a failure it was told to give is not a problem');
  const problems: Array<[string, ReturnType<VolumeStub['judge']>, number, RegExp]> = [
    ['no token', stub.judge(volumeUrl(ask), undefined), 404, /without the internal token/],
    ['another token', stub.judge(volumeUrl(ask), 'x'), 404, /without the internal token/],
    ['another wallet', stub.judge(volumeUrl({ ...ask, address: '0x' + 'cd'.repeat(20) }), stub.token), 400, /not the follower/],
    ['another builder', stub.judge(volumeUrl({ ...ask, builder: '1' }), stub.token), 400, /for builder 1, not 234812/],
    ['another window', stub.judge(volumeUrl({ ...ask, days: '30' }), stub.token), 400, /over 30 days, not the ladder's 14/],
    ['no window', stub.judge(volumeUrl({ address: ask.address, builder: ask.builder }), stub.token), 400, /over null days/],
    ['another path', stub.judge('/api/vs/builder/terms', stub.token), 404, /asked \/api\/vs\/builder\/terms/],
  ];
  for (const [what, r, status, why] of problems) {
    assert.equal(r.status, status, what);
    assert.match(r.read.problem ?? '', why, what);
  }
  assert.equal(stub.reset(), true, 'it was not the default');
  assert.deepEqual(stub.answer, DEFAULT_VOLUME);
  assert.equal(stub.reset(), false, 'already the default: no restart needed');
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

test('fee stub: the executor\'s own volume read passes every check, over loopback http (a self executor takes the URL), and a failure keeps the last answer', async () => {
  const stub = new VolumeStub(FOLLOWER);
  stub.builder = 234812;
  await stub.start();
  const dir = mkdtempSync(join(tmpdir(), 'vd-live-stub-'));
  const db = new ExecutorDb(':memory:');
  try {
    const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'self', EXECUTOR_OWNER: FOLLOWER, EXECUTOR_BUILDER_ID: '234812', EXECUTOR_BUILDER_URL: stub.url, EXECUTOR_BUILDER_TOKEN: stub.token });
    const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fetch as unknown as FetchLike, factory: noWs, log: silent });
    const fresh = (o: string) => (svc as unknown as { freshVolume(o: string): Promise<number | null> }).freshVolume(o);
    stub.answer = { usd: 2_000_000 };
    assert.equal(await fresh(FOLLOWER), 2_000_000);
    assert.equal(copyFeeFor(2_000_000), 12, 'the fourth step');
    assert.deepEqual(stub.problems(), []);
    assert.equal(stub.reads.length, 1);
    stub.answer = { status: 500 };
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      assert.equal(await fresh(FOLLOWER), 2_000_000, 'asked again after 10 minutes, failed, kept');
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(stub.reads.map((r) => r.status), [200, 500]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    await stub.stop();
  }
});

test('fee scenarios: one per step of the ladder, on the self target only (the stub and a restart), after everything else; keep-last is slow', () => {
  const fees = CATALOGUE.filter((s) => s.section === 'fee');
  assert.deepEqual(fees.filter((s) => s.id.startsWith('fee.tier-')).map((s) => s.id), ['fee.tier-0', 'fee.tier-100k', 'fee.tier-500k', 'fee.tier-2m', 'fee.tier-10m']);
  assert.equal(COPY_FEE_LADDER.length, 5);
  assert.deepEqual(fees.filter((s) => s.slow).map((s) => s.id), ['fee.keep-last']);
  for (const s of fees) {
    assert.deepEqual([...(s.needs ?? [])].sort(), ['localFeeStub', 'restart'], s.id);
    assert.equal(cannotRun(s, 'self'), null);
    for (const t of ['hosted', 'browser'] as const) assert.match(cannotRun(s, t) ?? '', /answer the executor's reads of the follower's volume \(the copy fee step\) itself/);
    assert.ok(!s.leader && s.dry === 'full' && s.kind === 'fee', s.id);
    assert.ok(s.cost(12).takerUsd > 0 && s.cost(12).peakUsd === 12, `${s.id} costs one U at a time`);
  }
  assert.ok(CATALOGUE.findIndex((s) => s.section === 'fee') > CATALOGUE.map((s) => s.section).lastIndexOf('copy'), 'the ladder comes last');
});

/**
 * An executor as far as the fee scenarios use it: on a new session it reads the follower's volume
 * from the stub (as service.ts: held until a restart, a failure keeps the last answer), and a
 * paper algo fills at once at 100, charged SoDEX's taker fee and the step of that volume.
 */
function feeExecutor(stub: VolumeStub, takerFee: number) {
  let held: number | null = null;
  const reads: Array<number | null> = [];
  const algos = new Map<string, AlgoView>();
  const exec = {
    name: 'self',
    capabilities: CAPABILITIES.self,
    gone: () => null,
    async kill() {
      held = null;
    },
    async start() {},
    async info() {
      return { builder: { id: 234812, ladder: COPY_FEE_LADDER.map((s) => ({ ...s })), windowDays: 14 } };
    },
    async signIn() {
      const r = stub.judge(volumeUrl({ address: FOLLOWER, builder: '234812', days: '14' }), stub.token);
      stub.reads.push(r.read);
      if (r.status === 200) held = (r.body as { usd: number }).usd;
      reads.push(held);
    },
    async algoStart(spec: Record<string, unknown>) {
      const qty = Number((spec.then as { quantity: string }).quantity);
      const id = `a${String(algos.size + 1).padStart(12, '0')}`;
      const v = { algo: { id, spec, status: 'done', filled: qty, filledValue: qty * 100, fees: qty * 100 * (takerFee + copyFeeFor(held) / 100_000), createdAt: Date.now(), children: [] }, exits: [] } as unknown as AlgoView;
      algos.set(id, v);
      return v;
    },
    async algo(id: string) {
      return algos.get(id)!;
    },
  };
  return { exec: exec as unknown as ExecutorTarget, reads, algos };
}

test('fee scenarios on paper: each step\'s boundary is read just under (the step below) and at it, after a restart; a ledger failing from the start is the first step', async () => {
  const stub = new VolumeStub(FOLLOWER);
  const main = MKT('BTC-USD');
  const fx = feeExecutor(stub, main.takerFee);
  const lines: string[] = [];
  const env = { mode: 'dry', main, second: MKT('ETH-USD'), childUsd: 12, timeScale: 0, log: (l: string) => lines.push(l), target: fx.exec, feeStub: stub, reads: { quote: async () => ({ bid: 100, ask: 100.1, mid: 100.05, mark: 100 }) } } as unknown as Env;
  const run = async (id: string, e: Env = env) => {
    const t = new T(e, id);
    await CATALOGUE.find((x) => x.id === id)!.run(t);
    return t;
  };
  const t0 = await run('fee.tier-0');
  assert.deepEqual(fx.reads, [0]);
  assert.match(lines.join('\n'), /ok the executor charged buy a\d+ builder fee 25 \(2\.5 bp\)/);
  assert.equal(t0.checks.liveOnly, 1, 'SoDEX\'s order history and fills are live only');
  await run('fee.tier-100k');
  await run('fee.tier-10m');
  assert.deepEqual(fx.reads, [0, 99_999, 100_000, 9_999_999, 10_000_000]);
  assert.match(lines.join('\n'), /builder fee 12 \(1\.2 bp\)[\s\S]*builder fee 10 \(1 bp\)/, 'just under $10M the step below, at it the last step');
  stub.answer = { usd: 600_000 };
  await run('fee.fail-first');
  assert.deepEqual(fx.reads.slice(-1), [null], 'nothing known after the restart');
  assert.deepEqual(stub.problems(), []);
  // A round: a market buy of U, then a market sell of what it filled (reduce-only only live).
  const specs = [...fx.algos.values()].map((v) => v.algo.spec as unknown as { side: string; reduceOnly?: boolean; paper: boolean; then: { type: string } });
  assert.ok(specs.every((s) => s.paper === true && s.then.type === 'market'));
  assert.deepEqual(specs.slice(0, 2).map((s) => [s.side, s.reduceOnly ?? false]), [['buy', false], ['sell', false]]);
  // An executor that charged another rate fails the check.
  const wrong = feeExecutor(stub, main.takerFee + 0.0001);
  await assert.rejects(run('fee.tier-0', { ...env, target: wrong.exec } as unknown as Env), /the executor charged buy .* builder fee 25/);
});

/* ---------------------------------------------------------- liquidations ----- */

test('liquidation scenarios: slow, live only (a dry run skips them, saying why), on every target, and costed with the margin a liquidation loses', async () => {
  const liq = CATALOGUE.filter((s) => s.kind === 'liq');
  assert.deepEqual(liq.map((s) => s.id), ['liq.algo-exits', 'liq.copy-follower']);
  assert.ok(liq.every((s) => s.slow && s.dry === 'live'), 'slow and live only');
  for (const t of TARGETS) for (const s of liq) assert.equal(cannotRun(s, t), null, `${s.id} runs on ${t}: only SoDEX-side actions are the harness's`);
  assert.ok(CATALOGUE.findIndex((s) => s.section === 'fee') > CATALOGUE.findIndex((s) => s.id === 'liq.copy-follower'), 'before the fee ladder');
  for (const s of liq) {
    const c = s.cost(12);
    assert.ok((c.lostUsd ?? 0) > 0 && (c.lostUsd ?? 0) <= 12 * LIQ_MAX_MARGIN, `${s.id} costs the margin it may lose, at most ${LIQ_MAX_MARGIN} of the position`);
    const env = { mode: 'dry', main: MKT('BTC-USD'), second: MKT('ETH-USD'), timeScale: 0, log: () => undefined, target: { gone: () => null } } as unknown as Env;
    await assert.rejects(s.run(new T(env, s.id)), (e: unknown) => e instanceof Unavailable && /live only/.test(e.message));
  }
  const b = computeBudget(liq, { main: MKT('BTC-USD'), book: { bid: 99.99, ask: 100.01 }, U: 12, builderRate: 0.00025, leverage: 2 });
  assert.ok(Math.abs(b.total.lostUsd - 2 * 12 * LIQ_MAX_MARGIN) < 1e-12);
  assert.ok(b.rows.every((r) => Math.abs(r.spentUsd - (r.feesUsd + r.spreadUsd + r.leaderUsd + r.lostUsd)) < 1e-12), 'spent counts the margin lost');
  assert.match(formatBudget(b), /margin lost to liquidations at most \$1\.20/);
  assert.match(formatBudget(b), /takeover fill itself was fee-free .* not documented: unknown, not costed/);
});

test('the harness\'s own writes: what a copier sends goes through the engine\'s client; a key registration, the builder approval and isolated margin straight to the gateway, which the engine\'s client refuses', async () => {
  const seen: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    const refuse = url.endsWith('/trade/margin') && (init?.body ?? '').includes('"-99"');
    return { status: 200, ok: true, text: async () => JSON.stringify(refuse ? { code: 1001, error: 'insufficient margin' } : { code: 0, data: { ok: 1 } }) };
  };
  const reads = new SodexReads(fetch);
  const req = (gatewayPath: string, amount = '-1') => ({ method: 'POST' as const, gatewayPath, headers: {}, body: JSON.stringify({ type: 'updateMargin', params: { accountID: 1, symbolID: 1, amount } }) });
  await assert.rejects(reads.client.send(req('/api/v1/perps/trade/margin')), /not an action this copier sends/, 'the engine\'s client never sends it');
  assert.deepEqual(await reads.write(req('/api/v1/perps/trade/margin')), { ok: 1 });
  assert.deepEqual(await reads.write(req('/api/v1/perps/accounts/api-keys')), { ok: 1 });
  await assert.rejects(reads.write(req('/api/v1/perps/trade/margin', '-99')), /insufficient margin/, 'SoDEX\'s refusal throws with its words');
  assert.deepEqual(seen, ['POST https://mainnet-gw.sodex.dev/api/v1/perps/trade/margin', 'POST https://mainnet-gw.sodex.dev/api/v1/perps/accounts/api-keys', 'POST https://mainnet-gw.sodex.dev/api/v1/perps/trade/margin']);
});

test('self target: the refusal alerts its executor logged since a scenario started are read back (an unknown refusal or a refused key fails the scenario)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-alerts-'));
  try {
    const logFile = join(dir, 'executor.log');
    const at = (iso: string, kind: string, text: string) => JSON.stringify({ t: iso, level: 'warn', msg: 'alert', kind, text });
    writeFileSync(logFile, [
      at('2026-10-30T10:00:00.000Z', 'order-rejected', 'Copy c0: before the scenario'),
      '--- start 2026-10-30T10:00:01.000Z ---',
      JSON.stringify({ t: '2026-10-30T10:00:02.000Z', level: 'info', msg: 'copy started' }),
      at('2026-10-30T10:00:03.000Z', 'order-rejected', 'Copy c1: SoDEX refused an order for a reason the executor does not know: code 77'),
      at('2026-10-30T10:00:04.000Z', 'crash-restart', 'Started again'),
      at('2026-10-30T10:00:05.000Z', 'key-refused', 'SoDEX refused the key of a wallet'),
    ].join('\n'));
    const proc = { o: { logFile, executorId: 'vd-livetest-live', dataDir: dir }, base: 'http://127.0.0.1:1' };
    const s = new SelfTarget(proc as unknown as ExecutorProcess, new CopyWallet(secp256k1.utils.randomPrivateKey()), 'live');
    const got = s.refusalAlertsSince(Date.parse('2026-10-30T10:00:01.000Z'));
    assert.deepEqual(got, ['order-rejected: Copy c1: SoDEX refused an order for a reason the executor does not know: code 77', 'key-refused: SoDEX refused the key of a wallet']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
