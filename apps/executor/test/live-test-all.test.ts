/**
 * The driver that runs every live-test target one after another
 * (apps/executor/tools/live-test/all.ts, its logic in allParts.ts): the plan,
 * why a part is skipped, what it reads of the runner's output, when a crashed
 * part is started again, the progress file, the summary and the report; and
 * the per-leader result key and the hash rule it relies on. No network, no
 * browser: the runner is played by in-process fakes and by a tiny node child.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ATTEMPTS,
  PartProgress,
  Screen,
  applyPreflight,
  attemptEnd,
  childStarter,
  crashLine,
  defaultLeaders,
  envStates,
  formatSummary,
  noFacts,
  parseDriverArgs,
  parseRunnerLine,
  planParts,
  progressOf,
  readEnvText,
  reportMarkdown,
  retryAfter,
  runFailed,
  runPart,
  showEvent,
  statusText,
  summaryRows,
  type CatalogueEntry,
  type DriverArgs,
  type Part,
  type PartEvent,
  type StartChild,
} from '../tools/live-test/allParts.ts';
import { CATALOGUE } from '../tools/live-test/catalogue.ts';
import { CodeHashes, DRIVER_FILES } from '../tools/live-test/hash.ts';
import { decide, emptyState, markDone, markRunning, resultKey } from '../tools/live-test/state.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'vd-live-all-'));

/** A small catalogue: the bootstrap, two algos (one slow), two copies. */
const CAT: CatalogueEntry[] = [
  { id: 'setup.terms', kind: 'key', section: 'setup', always: true },
  { id: 'setup.key-import', kind: 'key', section: 'setup' },
  { id: 'twap.taker-buy', kind: 'twap', section: 'algo' },
  { id: 'vwap.full', kind: 'vwap', section: 'algo', slow: true },
  { id: 'copy.fixed-notional', kind: 'copy', section: 'copy', leader: true },
  { id: 'copy.hl-notional', kind: 'copy', section: 'copy', leader: true },
];

const part = (x: Partial<Part> = {}): Part => ({ id: 'self', target: 'self', leader: 'sodex', copyOnly: false, only: null, scope: null, skip: null, ...x });

/* ---------------------------------------------------------------- options ----- */

test('options: the passed-through ones, lists, --no-pause (the .cmd\'s) ignored; an unknown one refused', () => {
  const a = parseDriverArgs(['--dry', '--targets', 'self,browser', '--leaders', 'hyperliquid,sodex', '--only', 'twap, copy', '--slow', '--force', '--env', 'x.env', '--web', 'http://127.0.0.1:5181', '--headed', '--yes', '--no-pause']) as DriverArgs;
  assert.equal(a.dry, true);
  assert.deepEqual(a.targets, ['self', 'browser']);
  assert.deepEqual(a.leaders, ['hyperliquid', 'sodex']);
  assert.deepEqual(a.only, ['twap', 'copy']);
  assert.equal(a.slow && a.force && a.headed && a.yes, true);
  assert.equal(a.envFile, 'x.env');
  assert.equal(a.web, 'http://127.0.0.1:5181');
  assert.equal(parseDriverArgs(['--help']), 'help');
  assert.equal((parseDriverArgs(['--status']) as DriverArgs).status, true);
  assert.throws(() => parseDriverArgs(['--target', 'self']), /unknown option --target/);
  assert.throws(() => parseDriverArgs(['--targets', 'tokyo']), /--target must be/);
  assert.throws(() => parseDriverArgs(['--leaders', 'binance']), /LIVE_LEADER_VENUE must be/);
  assert.equal((parseDriverArgs(['--only', ' , ']) as DriverArgs).only, null);
});

/* -------------------------------------------------------------------- env ----- */

test('env: names are set, empty or missing - never a value; the environment counts over the file', () => {
  const file = readEnvText('# comment\nLIVE_FOLLOWER_KEY="0xabc123"\nLIVE_LEADER_KEY=\nLIVE_COUNTRY = de \n');
  assert.equal(file.LIVE_FOLLOWER_KEY, '0xabc123');
  assert.equal(file.LIVE_COUNTRY, 'de');
  const states = envStates(file, { LIVE_LEADER_KEY: 'from-env', LIVE_ACCEPT_TERMS: '' });
  const by = Object.fromEntries(states.map((s) => [s.name, s]));
  assert.deepEqual(by.LIVE_FOLLOWER_KEY, { name: 'LIVE_FOLLOWER_KEY', state: 'set', from: 'file' });
  assert.deepEqual(by.LIVE_LEADER_KEY, { name: 'LIVE_LEADER_KEY', state: 'set', from: 'environment' });
  assert.deepEqual(by.LIVE_ACCEPT_TERMS, { name: 'LIVE_ACCEPT_TERMS', state: 'empty', from: 'environment' });
  assert.deepEqual(by.LIVE_HL_LEADER_KEY, { name: 'LIVE_HL_LEADER_KEY', state: 'missing', from: null });
  const text = JSON.stringify(states);
  for (const secret of ['0xabc123', 'from-env', 'de']) assert.ok(!text.includes(`"${secret}"`), `the states never carry ${secret}`);
  assert.equal(envStates(null, {}).every((s) => s.state === 'missing'), true);
});

test('leaders: the ones with a key, LIVE_LEADER_VENUE\'s first; none set: SoDEX', () => {
  assert.deepEqual(defaultLeaders({ sodex: true, hyperliquid: true }), ['sodex', 'hyperliquid']);
  assert.deepEqual(defaultLeaders({ sodex: true, hyperliquid: true }, 'hyperliquid'), ['hyperliquid', 'sodex']);
  assert.deepEqual(defaultLeaders({ sodex: false, hyperliquid: true }), ['hyperliquid']);
  assert.deepEqual(defaultLeaders({ sodex: false, hyperliquid: false }, 'hyperliquid'), ['sodex']);
});

/* ------------------------------------------------------------------- plan ----- */

test('plan: self, self with a further leader (copy scenarios only), hosted, browser; scopes as run.ts selects', () => {
  const parts = planParts({ targets: null, leaders: ['sodex', 'hyperliquid'], only: null, slow: false, catalogue: CAT });
  assert.deepEqual(parts.map((p) => [p.id, p.target, p.leader, p.copyOnly]), [
    ['self', 'self', 'sodex', false],
    ['self-hl', 'self', 'hyperliquid', true],
    ['hosted', 'hosted', 'sodex', false],
    ['browser', 'browser', 'sodex', false],
  ]);
  assert.equal(parts[0]!.only, null);
  assert.deepEqual(parts[0]!.scope, ['setup.terms', 'setup.key-import', 'twap.taker-buy', 'copy.fixed-notional', 'copy.hl-notional']);
  // The further leader: the copy scenarios by id, and the bootstrap the runner always adds.
  assert.deepEqual(parts[1]!.only, ['copy.fixed-notional', 'copy.hl-notional']);
  assert.deepEqual(parts[1]!.scope, ['setup.terms', 'copy.fixed-notional', 'copy.hl-notional']);
  assert.ok(parts.every((p) => !p.skip));
  // --slow adds the slow ones; --targets keeps the order self, hosted, browser.
  assert.ok(planParts({ targets: null, leaders: ['sodex'], only: null, slow: true, catalogue: CAT })[0]!.scope!.includes('vwap.full'));
  assert.deepEqual(planParts({ targets: ['browser', 'self'], leaders: ['sodex'], only: null, slow: false, catalogue: CAT }).map((p) => p.id), ['self', 'browser']);
  // A Hyperliquid first leader leads everywhere.
  assert.deepEqual(planParts({ targets: null, leaders: ['hyperliquid'], only: null, slow: false, catalogue: CAT }).map((p) => p.id), ['self-hl', 'hosted-hl', 'browser-hl']);
});

test('plan: --only narrows the further leader to its copy scenarios; none selected skips it; no catalogue: the copy section', () => {
  const narrowed = planParts({ targets: ['self'], leaders: ['sodex', 'hyperliquid'], only: ['twap', 'copy.fixed-notional'], slow: false, catalogue: CAT });
  assert.deepEqual(narrowed[0]!.only, ['twap', 'copy.fixed-notional']);
  assert.deepEqual(narrowed[1]!.only, ['copy.fixed-notional']);
  const none = planParts({ targets: ['self'], leaders: ['sodex', 'hyperliquid'], only: ['twap'], slow: false, catalogue: CAT })[1]!;
  assert.match(none.skip ?? '', /nothing selected involves the leader/);
  assert.deepEqual(none.scope, [], 'nothing in scope (an empty --only would select everything)');
  const blind = planParts({ targets: ['self'], leaders: ['sodex', 'hyperliquid'], only: null, slow: false, catalogue: null });
  assert.deepEqual(blind[1]!.only, ['copy']);
  assert.equal(blind[0]!.scope, null);
  assert.match(planParts({ targets: ['self'], leaders: ['sodex', 'hyperliquid'], only: ['twap'], slow: false, catalogue: null, catalogueError: 'boom' })[1]!.skip ?? '', /catalogue could not be read \(boom\)/);
});

test('plan: with the real catalogue the further leader runs exactly the copy section (nothing else involves the leader)', () => {
  const p = planParts({ targets: ['self'], leaders: ['sodex', 'hyperliquid'], only: null, slow: true, catalogue: CATALOGUE })[1]!;
  assert.deepEqual(p.only, CATALOGUE.filter((s) => s.section === 'copy').map((s) => s.id));
  assert.ok(CATALOGUE.filter((s) => s.leader).every((s) => s.section === 'copy'));
});

/* -------------------------------------------------------------- preflight ----- */

test('preflight: what fails takes only the parts that need it; the rest run', () => {
  const plan = planParts({ targets: null, leaders: ['sodex', 'hyperliquid'], only: null, slow: false, catalogue: CAT });
  const ids = (ps: Part[]) => ps.filter((p) => !p.skip).map((p) => p.id);

  const hostedDown = { ...noFacts(), target: { hosted: 'ValueDesk\'s executor does not answer' } };
  assert.deepEqual(ids(applyPreflight(plan, hostedDown, 'live')), ['self', 'self-hl', 'browser']);
  const noWeb = { ...noFacts(), target: { browser: 'no dev web answers' } };
  const r = applyPreflight(plan, noWeb, 'dry');
  assert.equal(r.find((p) => p.id === 'browser')!.skip, 'no dev web answers');
  assert.deepEqual(ids(r), ['self', 'self-hl', 'hosted']);

  // Live, no follower key / terms / region: nothing runs.
  assert.deepEqual(ids(applyPreflight(plan, { ...noFacts(), all: 'LIVE_ACCEPT_TERMS is not 2026-10-28' }, 'live')), []);

  // A leader without a key: the parts it leads run (the runner skips their copies), its copy-only part does not.
  const noHlKey = { ...noFacts(), leader: { sodex: { keySet: false, problem: null }, hyperliquid: { keySet: false, problem: null } } };
  const k = applyPreflight(plan, noHlKey, 'live');
  assert.deepEqual(ids(k), ['self', 'hosted', 'browser']);
  assert.match(k.find((p) => p.id === 'self-hl')!.skip!, /LIVE_HL_LEADER_KEY is empty/);
  assert.deepEqual(ids(applyPreflight(plan, noHlKey, 'dry')), ['self', 'self-hl', 'hosted', 'browser'], 'a dry run needs no key');

  // A leader whose key is set but cannot lead (no account): the runner would refuse its parts.
  const broke = { ...noFacts(), leader: { hyperliquid: { keySet: true, problem: 'the leader could not be read' } } };
  assert.deepEqual(ids(applyPreflight(plan, broke, 'live')), ['self', 'hosted', 'browser']);

  // Too little for one part.
  const short = { ...noFacts(), funds: { 'self-hl': 'the leader holds $3.00 on Hyperliquid and this part needs about $28.00' } };
  assert.deepEqual(ids(applyPreflight(plan, short, 'live')), ['self', 'hosted', 'browser']);

  // A reason from the plan stands.
  assert.equal(applyPreflight([part({ skip: 'from the plan' })], { ...noFacts(), all: 'later' }, 'live')[0]!.skip, 'from the plan');
});

test('preflight: a target whose last run may have left orders or positions goes first; one that does not run now blocks the others', () => {
  const plan = planParts({ targets: null, leaders: ['sodex'], only: null, slow: false, catalogue: CAT });
  const first = applyPreflight(plan, { ...noFacts(), exposed: { hosted: 'it recorded orders or positions that may still be out' } }, 'live');
  assert.deepEqual(first.map((p) => p.id), ['hosted', 'self', 'browser']);
  assert.ok(first.every((p) => !p.skip));
  const blocked = applyPreflight(plan, { ...noFacts(), exposed: { hosted: 'twap.exits was left running by a crash' }, target: { hosted: 'it does not answer' } }, 'live');
  assert.ok(blocked.every((p) => p.skip));
  assert.match(blocked.find((p) => p.id === 'self')!.skip!, /the last hosted run twap\.exits was left running by a crash: run --targets hosted first/);
});

/* ------------------------------------------------------- the runner's lines ----- */

test('runner lines: start, end with checks, fees and error, skips (nested parens), RESULTS, STOPPED, warnings', () => {
  assert.deepEqual(parseRunnerLine('  64 scenarios selected (slow ones left out; --slow adds them), target self, leader on SoDEX'), { kind: 'selected', n: 64 });
  assert.deepEqual(parseRunnerLine('> twap.exits: Exits placed after the first fill [last failed: boom]'), { kind: 'start', id: 'twap.exits', title: 'Exits placed after the first fill', why: 'last failed: boom' });
  assert.deepEqual(parseRunnerLine('< twap.exits: PASSED (12 checks, fees $0.0123)'), { kind: 'end', id: 'twap.exits', status: 'passed', checks: '12 checks, fees $0.0123', feesUsd: 0.0123, error: null });
  assert.deepEqual(parseRunnerLine('< copy.tp-fires: INCONCLUSIVE (3 checks, 2 live-only not checked): the market did not move: 20 min'), { kind: 'end', id: 'copy.tp-fires', status: 'inconclusive', checks: '3 checks, 2 live-only not checked', feesUsd: null, error: 'the market did not move: 20 min' });
  assert.equal((parseRunnerLine('< x.y: FAILED (0 checks): Error: a (b) c') as { error: string }).error, 'Error: a (b) c');
  assert.deepEqual(parseRunnerLine('- twap.taker-buy: skip (passed on this code (2026-10-29T10:00:00.000Z))'), { kind: 'skip', id: 'twap.taker-buy', status: 'passed', earlier: true, why: 'passed on this code (2026-10-29T10:00:00.000Z)' });
  assert.deepEqual(parseRunnerLine('- fee.tier-0: skip (skipped on this code: the hosted target cannot ...)'), { kind: 'skip', id: 'fee.tier-0', status: 'skipped', earlier: false, why: 'skipped on this code: the hosted target cannot ...' });
  assert.deepEqual(parseRunnerLine('- copy.hl-notional: skipped (it needs a leader on Hyperliquid (LIVE_LEADER_VENUE=hyperliquid))'), { kind: 'skip', id: 'copy.hl-notional', status: 'skipped', earlier: false, why: 'it needs a leader on Hyperliquid (LIVE_LEADER_VENUE=hyperliquid)' });
  assert.deepEqual(parseRunnerLine('RESULTS'), { kind: 'results' });
  assert.deepEqual(parseRunnerLine('STOPPED: a cleanup did not leave the accounts flat'), { kind: 'stopped', why: 'a cleanup did not leave the accounts flat' });
  assert.deepEqual(parseRunnerLine('Ctrl+C: stopping after the cleanup of this scenario (Ctrl+C again to exit at once).'), { kind: 'ctrl-c' });
  assert.deepEqual(parseRunnerLine('  ! CLEANUP COULD NOT FLATTEN: {}'), { kind: 'warning', text: 'CLEANUP COULD NOT FLATTEN: {}' });
  // What is not the runner's progress: the budget's skip list, the checks, the RESULTS table.
  for (const l of ['  - twap.tab-close is skipped on this target: the self target cannot ...', '    ok the order filled', '  passed       twap.exits                     12 checks', '']) assert.equal(parseRunnerLine(l), null, l);
});

test('runner lines: run.ts still writes them as the driver reads them', () => {
  const src = readFileSync(new URL('../tools/live-test/run.ts', import.meta.url), 'utf8');
  for (const template of [
    'log(`\\n> ${s.id}: ${s.title} [${d.why}]`)',
    'log(`< ${s.id}: ${status.toUpperCase()} (${t.checks.passed} checks',
    'log(`- ${s.id}: skip (${d.why})`)',
    'log(`- ${s.id}: skipped (',
    "log('\\nRESULTS')",
    'log(`STOPPED: ${stopRun}`)',
    'scenarios selected',
    "log('\\nCtrl+C: stopping after the cleanup",
  ]) assert.ok(src.includes(template), `run.ts writes ${template}`);
});

test('crash line: an Error line over the location, Node\'s warnings left out; else the first line', () => {
  assert.equal(crashLine(['file:///x/run.ts:12', '    throw new Error("boom");', '          ^', '', 'TypeError: boom', '    at main (x)', '', 'Node.js v24.22.1']), 'TypeError: boom');
  assert.equal(crashLine(['(node:123) ExperimentalWarning: SQLite is experimental', '(Use `node --trace-warnings ...` to show where)', '', 'The browser target runs in the local dev web, and none answers.']), 'The browser target runs in the local dev web, and none answers.');
  assert.equal(crashLine([]), null);
});

/* ------------------------------------------------------------------ retry ----- */

test('attempts: RESULTS is finished whatever the exit code; no RESULTS is a crash; Ctrl+C or exit 130 is interrupted', () => {
  const base = { signal: null, error: null, startedAny: true, stopping: false };
  assert.deepEqual(attemptEnd({ ...base, code: 1, sawResults: true }), { kind: 'finished', code: 1 });
  assert.equal(attemptEnd({ ...base, code: 1, sawResults: false }).kind, 'crashed');
  assert.match((attemptEnd({ ...base, code: 0, sawResults: false }) as { error: string }).error, /without its results/);
  assert.match((attemptEnd({ ...base, code: null, signal: 'SIGKILL', sawResults: false }) as { error: string }).error, /SIGKILL/);
  assert.equal(attemptEnd({ ...base, code: 130, sawResults: false }).kind, 'interrupted');
  assert.equal(attemptEnd({ ...base, code: 1, sawResults: true, stopping: true }).kind, 'interrupted');
});

test('retry: a crash runs again up to three attempts; not a finished or stopped part, nor the same refusal before any scenario twice', () => {
  const crash = (error: string, startedAny: boolean) => ({ kind: 'crashed' as const, code: 1, signal: null, error, startedAny });
  assert.equal(retryAfter(1, { kind: 'finished', code: 1 }, null).retry, false);
  assert.equal(retryAfter(1, { kind: 'interrupted', code: 130 }, null).retry, false);
  assert.deepEqual(retryAfter(1, crash('boom', true), null), { retry: true, why: 'attempt 2 of 3' });
  assert.equal(retryAfter(2, crash('boom', true), crash('boom', true)).retry, true, 'a crash mid-run, again: still a crash');
  assert.equal(retryAfter(MAX_ATTEMPTS, crash('boom', true), crash('boom', true)).retry, false);
  assert.equal(retryAfter(1, crash('holds $3; needs $60', false), null).retry, true, 'the first one may be a hiccup');
  assert.match(retryAfter(2, crash('holds $3; needs $60', false), crash('holds $3; needs $60', false)).why, /refusal/);
  assert.equal(retryAfter(2, crash('ECONNRESET', false), crash('ETIMEDOUT', false)).retry, true);
});

/** A fake runner: each attempt is a list of stdout lines (and stderr lines after '!err '), then an exit code. A multi-line entry comes as its lines, as a child's output does. */
function fakeRunner(attempts: Array<{ lines: string[]; code: number | null }>): { start: StartChild; started: number[] } {
  const started: number[] = [];
  const start: StartChild = async (attempt, onLine) => {
    started.push(attempt);
    const a = attempts[attempt - 1]!;
    for (const entry of a.lines) for (const l of entry.split('\n')) l.startsWith('!err ') ? onLine(l.slice(5), 'err') : onLine(l, 'out');
    return { code: a.code, signal: null };
  };
  return { start, started };
}

test('a part: crashed mid-scenario, started again, resumes - what passed stays, the broken-off one runs again', async () => {
  const p = new PartProgress(part({ scope: ['setup.terms', 'twap.a', 'twap.b'] }));
  const events: PartEvent[] = [];
  const waits: number[] = [];
  let clock = 1_000;
  const { start, started } = fakeRunner([
    { lines: ['  3 scenarios selected', '> setup.terms: Terms [runs every time (bootstrap)]', '< setup.terms: PASSED (3 checks)', '> twap.a: A [never run]', '< twap.a: PASSED (5 checks)', '> twap.b: B [never run]', '!err TypeError: socket hang up'], code: 1 },
    { lines: ['  3 scenarios selected', '> setup.terms: Terms [runs every time (bootstrap)]', '< setup.terms: PASSED (3 checks)', '- twap.a: skip (passed on this code (x))', '> twap.b: B [last failed: interrupted]', '< twap.b: FAILED (1 checks): the order never filled\n  at x', 'RESULTS'], code: 1 },
  ]);
  await runPart(p, { start, stopping: () => false, onEvent: (e) => events.push(e), sleep: async (ms) => void waits.push(ms), now: () => (clock += 1_000) });
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(waits, [5_000]);
  assert.equal(p.status, 'finished');
  assert.equal(p.attempts, 2);
  assert.equal(p.exit, 1);
  assert.equal(p.results.get('twap.a')!.earlier, false, 'it passed in this run: not "earlier"');
  assert.ok(p.results.get('twap.a')!.durationMs! > 0);
  assert.equal(p.results.get('twap.b')!.status, 'failed');
  const t = p.tally();
  assert.deepEqual([t.total, t.done, t.passed, t.failed, t.notRun], [3, 3, 2, 1, 0]);
  assert.deepEqual(p.failures(), [{ id: 'twap.b', status: 'failed', error: 'the order never filled' }]);
  const retry = events.find((e) => e.kind === 'retry') as Extract<PartEvent, { kind: 'retry' }>;
  assert.equal(retry.end.kind === 'crashed' && retry.end.error, 'TypeError: socket hang up');
});

test('a part: three crashes and the driver moves on - recorded crashed, the broken-off scenario failed, the rest not run', async () => {
  const p = new PartProgress(part({ scope: ['setup.terms', 'twap.a', 'twap.b'] }));
  const crash = { lines: ['> setup.terms: Terms [x]', '< setup.terms: PASSED (1 checks)', '> twap.a: A [x]', '!err Error: out of memory'], code: 134 };
  const { start, started } = fakeRunner([crash, crash, crash]);
  await runPart(p, { start, stopping: () => false, onEvent: () => undefined, sleep: async () => undefined });
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(p.status, 'crashed');
  assert.equal(p.reason, 'Error: out of memory');
  assert.match(p.results.get('twap.a')!.error!, /^the runner crashed while it ran: Error: out of memory/);
  assert.equal(p.tally().notRun, 1);
  assert.equal(runFailed([p]), true);
});

test('a part: the same refusal at the start twice is not tried a third time; Ctrl+C during the wait starts nothing more', async () => {
  const refused = { lines: ['!err ', '!err follower holds $3.00 on SoDEX; the suite needs about $60.00. Deposit more (see --budget).'], code: 1 };
  const a = new PartProgress(part());
  const r1 = fakeRunner([refused, refused, refused]);
  await runPart(a, { start: r1.start, stopping: () => false, onEvent: () => undefined, sleep: async () => undefined });
  assert.deepEqual(r1.started, [1, 2]);
  assert.equal(a.status, 'crashed');
  assert.match(a.reason!, /holds \$3\.00/);

  let stop = false;
  const b = new PartProgress(part());
  const r2 = fakeRunner([{ lines: ['> twap.a: A [x]'], code: 1 }, refused]);
  await runPart(b, { start: r2.start, stopping: () => stop, onEvent: () => undefined, sleep: async () => void (stop = true) });
  assert.deepEqual(r2.started, [1]);
  assert.equal(b.status, 'interrupted');
});

test('a part: a screen that throws never stops it; a child that cannot be started is a crash', async () => {
  const p = new PartProgress(part());
  const { start } = fakeRunner([{ lines: ['> twap.a: A [x]', '< twap.a: PASSED (1 checks)', 'RESULTS'], code: 0 }]);
  await runPart(p, { start, stopping: () => false, onEvent: () => { throw new Error('the console went away'); } });
  assert.equal(p.status, 'finished');
  const q = new PartProgress(part());
  await runPart(q, { start: async () => { throw new Error('spawn ENOENT'); }, stopping: () => false, onEvent: () => undefined, sleep: async () => undefined });
  assert.equal(q.status, 'crashed');
  assert.match(q.reason!, /could not be started: spawn ENOENT/);
});

test('a child process: its lines as they come, its whole output in the log, its exit; no RESULTS is a crash', async () => {
  const d = tmp();
  const log = join(d, 'self.log');
  const script = "console.log('> twap.a: A [x]'); console.log('< twap.a: PASSED (2 checks, fees $0.5000)'); console.error('Error: boom'); process.exit(3)";
  const p = new PartProgress(part({ scope: ['twap.a', 'twap.b'] }));
  await runPart(p, { start: childStarter({ command: process.execPath, args: ['-e', script], cwd: d, env: process.env, logFile: log, label: 'self' }), stopping: () => false, onEvent: () => undefined, sleep: async () => undefined });
  assert.equal(p.status, 'crashed');
  assert.equal(p.attempts, MAX_ATTEMPTS, 'it crashed after a scenario each time: tried three times');
  assert.equal(p.exit, 3);
  assert.equal(p.results.get('twap.a')!.feesUsd, 0.5);
  const text = readFileSync(log, 'utf8');
  assert.equal(text.match(/===== self, attempt \d/g)!.length, 3);
  assert.ok(text.includes('< twap.a: PASSED (2 checks, fees $0.5000)') && text.includes('Error: boom'));
  rmSync(d, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- screen ----- */

test('screen: a scenario\'s start writes half a line that its end completes; anything in between closes it first', () => {
  let s = '';
  const screen = new Screen((x) => (s += x));
  screen.begin('a', '[self] twap.a ...');
  screen.end('a', ' passed 41 s', '[self] twap.a ... passed 41 s');
  screen.begin('b', '[self] twap.b ...');
  screen.line('[self] ! the brake is on');
  screen.end('b', ' failed 3 s', '[self] twap.b ... failed 3 s');
  assert.equal(s, '[self] twap.a ... passed 41 s\n[self] twap.b ...\n[self] ! the brake is on\n[self] twap.b ... failed 3 s\n');
});

test('screen: a resumed part\'s skips are one line; an end line carries the time and the part\'s tally, a failure its first error line', () => {
  let s = '';
  const screen = new Screen((x) => (s += x));
  const p = new PartProgress(part({ scope: ['twap.a', 'twap.b', 'twap.c'] }));
  const skipped = { passed: 0, skipped: 0 };
  let now = 0;
  const feed = (line: string) => {
    now += 41_000;
    for (const l of line.split('\n')) {
      const e = p.line(l, 'out', now);
      if (e) showEvent(screen, p, { kind: 'line', line: e }, { logPath: 'x.log', skipped, now });
    }
  };
  feed('- twap.a: skip (passed on this code (t))');
  feed('- twap.c: skipped (the hosted target cannot kill the executor hard from here)');
  feed('> twap.b: B [never run]');
  feed('< twap.b: FAILED (1 checks, fees $0.0100): the order never filled\n stack');
  assert.equal(s, [
    '[self] 1 passed on this code earlier, not run again; 1 skipped here (why: in the report)',
    '[self] twap.b ... failed 41 s   (3/3: 1 passed (1 earlier), 1 failed, 0 inconclusive, 1 skipped; fees $0.0100)',
    '       the order never filled',
    '',
  ].join('\n'));
});

/* --------------------------------------------------- progress and summary ----- */

function finishedParts(): PartProgress[] {
  const a = new PartProgress(part({ scope: ['setup.terms', 'twap.a', 'twap.b', 'copy.x'] }));
  a.beginAttempt(1, 0);
  for (const l of ['> setup.terms: T [x]', '< setup.terms: PASSED (1 checks)', '- twap.a: skip (passed on this code (t))', '> twap.b: B [x]', '< twap.b: INCONCLUSIVE (2 checks, fees $0.2500): the take-profit was not reached in 20 min', '> copy.x: C [x]', '< copy.x: FAILED (0 checks, fees $0.1000): Error: no copy\n    at y', 'RESULTS']) for (const x of l.split('\n')) a.line(x, 'out', 60_000);
  a.endAttempt({ kind: 'finished', code: 1 }, true, 3_600_000);
  const b = new PartProgress(part({ id: 'hosted', target: 'hosted', scope: ['setup.terms', 'twap.a'], skip: 'ValueDesk\'s executor does not answer' }));
  return [a, b];
}

test('summary: per part passed (earlier), failed, inconclusive, skipped, not run, the result; the failing ids with their first error line', () => {
  const parts = finishedParts();
  const rows = summaryRows(parts);
  assert.deepEqual(rows.map((r) => [r.id, r.passed, r.earlier, r.failed, r.inconclusive, r.skipped, r.notRun]), [
    ['self', 2, 1, 1, 1, 0, 0],
    ['hosted', 0, 0, 0, 0, 0, 2],
  ]);
  assert.match(rows[0]!.result, /^finished, exit 1, 1 h 0 min$/);
  assert.equal(rows[1]!.result, 'skipped: ValueDesk\'s executor does not answer');
  const text = formatSummary(parts, { mode: 'live', feesUsd: 0.35 });
  assert.match(text, /FAILED {7}\[self\] copy\.x: Error: no copy$/m);
  assert.match(text, /inconclusive \[self\] twap\.b: the take-profit was not reached in 20 min/);
  assert.match(text, /fees SoDEX charged the follower this run: \$0\.3500/);
  assert.equal(runFailed(parts), true);
});

test('report: the table, the failures, the preflight and the files, in markdown', () => {
  const parts = finishedParts();
  parts[0]!.log = '.state/self-t.log';
  const md = reportMarkdown(parts, { mode: 'dry', startedAt: Date.UTC(2026, 9, 29, 12, 0), endedAt: Date.UTC(2026, 9, 29, 13, 0), feesUsd: null, preflight: ['  [ok] country DE: eea, 2x cap'], stateFiles: ['.state/dry-self.json'], interrupted: false });
  assert.match(md, /^# Live tests 2026-10-29 12:00 UTC \(dry run, paper\)/);
  assert.match(md, /\| self \| self \/ SoDEX \| 2 \(1 earlier\) \| 1 \| 1 \| 0 \| 0 \| finished, exit 1, 1 h 0 min \|/);
  assert.match(md, /\| hosted \| hosted \/ SoDEX \| 0 \| 0 \| 0 \| 0 \| 2 \| skipped: ValueDesk's executor does not answer \|/);
  assert.match(md, /- \*\*failed\*\* \[self\] `copy\.x`: Error: no copy/);
  assert.ok(md.includes('[ok] country DE: eea, 2x cap') && md.includes('.state/self-t.log') && md.includes('.state/dry-self.json'));
});

test('progress file: every part\'s status, tally, what runs now and the fees; --status reads it back', () => {
  const parts = finishedParts();
  const running = new PartProgress(part({ id: 'browser', target: 'browser', scope: ['setup.terms', 'twap.a'] }));
  running.beginAttempt(2, 0);
  running.line('> setup.terms: Terms [x]', 'out', 1_000);
  const f = progressOf({ pid: 4242, mode: 'live', startedAt: 0, now: 5_000, state: 'running', report: null, parts: [...parts, running] });
  assert.ok(Math.abs(f.feesUsd! - 0.35) < 1e-9);
  assert.deepEqual(f.parts.map((p) => p.status), ['finished', 'skipped', 'running']);
  assert.deepEqual(f.parts[2]!.current, { id: 'setup.terms', title: 'Terms', startedAt: 1_000 });
  const back = JSON.parse(JSON.stringify(f)) as typeof f;
  const text = statusText(back, 65_000, false);
  assert.match(text, /LIVE, real money.*running - but its driver no longer runs/);
  assert.match(text, /browser\s+running\s+0\/2: .*attempt 2; now setup\.terms \(1 min 4 s\)/);
  assert.match(text, /failed copy\.x: Error: no copy/);
});

/* ------------------------------------------------- what the driver relies on ----- */

test('result key: a copy scenario with a Hyperliquid leader is kept apart, so a run with each leader resumes on its own', () => {
  assert.equal(resultKey({ id: 'copy.fixed-notional', leader: true }, 'hyperliquid'), 'copy.fixed-notional@hyperliquid');
  assert.equal(resultKey({ id: 'copy.fixed-notional', leader: true }, 'sodex'), 'copy.fixed-notional');
  assert.equal(resultKey({ id: 'twap.exits' }, 'hyperliquid'), 'twap.exits', 'what does not involve the leader is kept once');
  const s = emptyState('live');
  const sc = { id: 'copy.hl-notional', kind: 'copy', section: 'copy' };
  // Passed with the Hyperliquid leader; then a SoDEX-leader run records it skipped (it needs the other leader) under its own key.
  markRunning(s, resultKey({ ...sc, leader: true }, 'hyperliquid'), 'h-hl');
  markDone(s, resultKey({ ...sc, leader: true }, 'hyperliquid'), 'passed');
  markDone(s, resultKey({ ...sc, leader: true }, 'sodex'), 'skipped', { error: 'it needs a leader on Hyperliquid' });
  assert.equal(decide(s, sc, 'h-hl', { only: null, force: false, key: resultKey({ ...sc, leader: true }, 'hyperliquid') }).run, false, 'the Hyperliquid pass stands');
  assert.equal(decide(s, sc, 'h-hl', { only: null, force: false }).run, true, 'without the key: the skipped record of the other leader');
});

test('hash: the driver\'s files are not code a scenario runs - changing them re-runs nothing; the harness still counts', () => {
  const repo = tmp();
  const dir = join(repo, 'apps', 'executor', 'tools', 'live-test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'harness.ts'), 'export const a = 1;\n');
  for (const f of DRIVER_FILES) writeFileSync(join(repo, f), 'export const v = 1;\n');
  const before = new CodeHashes(repo).group('harness');
  for (const f of DRIVER_FILES) writeFileSync(join(repo, f), 'export const v = 2;\n');
  assert.equal(new CodeHashes(repo).group('harness'), before);
  writeFileSync(join(dir, 'harness.ts'), 'export const a = 2;\n');
  assert.notEqual(new CodeHashes(repo).group('harness'), before);
  rmSync(repo, { recursive: true, force: true });
});
