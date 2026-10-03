/**
 * Stage A's pure parts: which suites there are, how they are started, how
 * their output is read - and what the screen prints.
 *   npx tsx --test e2e/guide/suites.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReporterLine, countsText, discoverSuites, filterSuites, newCounts, nodeTestArgs, parseForgeOutput, parseTscOutput, testVerdict, type FsView, type Tools } from './suites';
import { diskView } from './stageA';
import { REPO_DIR } from './proc';
import { stageStatus, type Item } from './types';
import { Output, clip, fmtDur, fmtUsd, resultLines, table, toAscii, wrap } from './ui';

/** A made-up repository: the files that exist, by path. */
function fakeFs(files: string[]): FsView {
  const set = new Set(files);
  return {
    exists: (p) => set.has(p) || files.some((f) => f.startsWith(`${p}/`)),
    files: (dir) => files.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
    dirs: (dir) => [...new Set(files.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)).filter((f) => f.includes('/')).map((f) => f.split('/')[0]!))],
  };
}

const REPO = [
  'apps/web/tsconfig.json',
  'apps/web/src/a.test.ts',
  'apps/web/src/chart/b.test.ts',
  'apps/web/src/components/C.test.tsx',
  'apps/web/src/components/C.tsx',
  'apps/web/tools/logo-clean.test.mjs',
  'apps/web/e2e/live/tsconfig.json',
  'apps/web/e2e/live/safety.test.ts',
  'apps/web/e2e/live/simulate.test.ts',
  'apps/web/e2e/guide/tsconfig.json',
  'apps/web/e2e/guide/args.test.ts',
  'apps/server/tsconfig.json',
  'apps/server/test/x.test.ts',
  'apps/server/test/vectors.json',
  'packages/sodex-core/tsconfig.json',
  'packages/sodex-core/tsconfig.test.json',
  'packages/sodex-core/test/keys.test.ts',
  'packages/copy-contract/tsconfig.json',
  'packages/copy-contract/test/abi.test.ts',
  'packages/copy-contract/tools/extract-abi.ts',
  'packages/copy-contract/tools/gen-vectors.ts',
  'packages/new-thing/test/later.test.ts',
  'deploy/smoke/smoke.test.mjs',
  'deploy/server/bin/healthcheck.test.mjs',
  'deploy/aws/validate_offline.py',
  'contracts/foundry.toml',
  'contracts/tools/storage-layout.mjs',
  'contracts/out/ValuescanCopyTrading.sol/ValuescanCopyTrading.json',
];
const ALL_TOOLS: Tools = { forge: true, python: true, pyyaml: true };

test('discovery: every suite the brief names, found from the files - not from a list', () => {
  const suites = discoverSuites(fakeFs(REPO), ALL_TOOLS);
  assert.deepEqual(suites.map((s) => s.id), [
    'web-typecheck',
    'web-unit',
    'web-tools',
    'e2e-typecheck',
    'e2e-offline',
    'guide-typecheck',
    'guide-tests',
    'server-typecheck',
    'server-tests',
    'copy-contract-typecheck',
    'copy-contract-tests',
    'new-thing-tests',
    'sodex-core-typecheck',
    'sodex-core-tests',
    'copy-contract-checks',
    'deploy-tests',
    'deploy-templates',
    'contracts-layout',
    'contracts-forge',
  ]);
  const by = Object.fromEntries(suites.map((s) => [s.id, s]));
  assert.deepEqual(by['web-unit']!.files, ['src/a.test.ts', 'src/chart/b.test.ts', 'src/components/C.test.tsx']);
  assert.equal(by['web-unit']!.tsx, true);
  assert.deepEqual(by['e2e-offline']!.files, ['e2e/live/safety.test.ts', 'e2e/live/simulate.test.ts']);
  assert.deepEqual(by['server-tests']!.files, ['test/x.test.ts']);
  assert.deepEqual(by['sodex-core-typecheck']!.projects, ['tsconfig.json', 'tsconfig.test.json']);
  assert.deepEqual(by['deploy-tests']!.files, ['deploy/server/bin/healthcheck.test.mjs', 'deploy/smoke/smoke.test.mjs']);
  assert.equal(by['deploy-tests']!.tsx, false);
  assert.equal(by['e2e-typecheck']!.projects![0], 'e2e/live');
  assert.ok(suites.every((s) => !s.skip), 'nothing is skipped when every tool is there');
});

test('discovery: forge and Python are optional - their suites are SKIPPED with the reason, never failed', () => {
  const suites = discoverSuites(fakeFs(REPO), { forge: false, python: false, pyyaml: false });
  const by = Object.fromEntries(suites.map((s) => [s.id, s]));
  assert.match(by['contracts-forge']!.skip!, /forge \(Foundry\) is not installed/);
  assert.match(by['deploy-templates']!.skip!, /Python is not installed/);
  assert.match(discoverSuites(fakeFs(REPO), { forge: true, python: true, pyyaml: false }).find((s) => s.id === 'deploy-templates')!.skip!, /PyYAML/);
  // No contract build: the ABI check cannot compare anything.
  const noBuild = discoverSuites(fakeFs(REPO.filter((f) => !f.startsWith('contracts/out/'))), ALL_TOOLS);
  assert.match(noBuild.find((s) => s.id === 'copy-contract-checks')!.skip!, /forge build/);
});

test('discovery: an empty checkout gives no suites; a missing part gives none for that part', () => {
  assert.deepEqual(discoverSuites(fakeFs([]), ALL_TOOLS), []);
  const webOnly = discoverSuites(fakeFs(['apps/web/tsconfig.json']), ALL_TOOLS);
  assert.deepEqual(webOnly.map((s) => s.id), ['web-typecheck', 'web-unit']);
  assert.match(webOnly[1]!.skip!, /no test files/);
});

test('discovery on the real repository finds the suites the owner asked for', () => {
  const suites = discoverSuites(diskView(REPO_DIR), { forge: false, python: false, pyyaml: false });
  const ids = suites.map((s) => s.id);
  for (const want of ['web-typecheck', 'web-unit', 'e2e-offline', 'guide-tests', 'server-typecheck', 'server-tests', 'sodex-core-tests', 'copy-contract-tests', 'contracts-forge']) assert.ok(ids.includes(want), want);
  const e2e = suites.find((s) => s.id === 'e2e-offline')!.files!;
  for (const f of ['e2e/live/provider.test.ts', 'e2e/live/safety.test.ts', 'e2e/live/simulate.test.ts']) assert.ok(e2e.includes(f), f);
  assert.ok(suites.find((s) => s.id === 'web-unit')!.files!.length > 20);
  assert.ok(suites.find((s) => s.id === 'guide-tests')!.files!.includes('e2e/guide/suites.test.ts'));
  // Nothing from a dependency or a build folder.
  for (const s of suites) for (const f of s.files ?? []) assert.ok(!/node_modules|\/dist\/|\/\.out\//.test(f), f);
});

test('--suites filters by a word in the id', () => {
  const all = discoverSuites(fakeFs(REPO), ALL_TOOLS);
  assert.deepEqual(filterSuites(all, ['server']).map((s) => s.id), ['server-typecheck', 'server-tests']);
  assert.deepEqual(filterSuites(all, ['web-unit', 'forge']).map((s) => s.id), ['web-unit', 'contracts-forge']);
  assert.equal(filterSuites(all, null).length, all.length);
  assert.deepEqual(filterSuites(all, ['nothing-like-this']), []);
});

test('node:test is started with tsx, the JSON reporter on stdout and the readable one in the log', () => {
  assert.deepEqual(nodeTestArgs({ files: ['test/a.test.ts', 'test/b.test.ts'], tsx: true }, { reporterUrl: 'file:///r.mjs', logFile: 'C:\\logs\\A.log' }), [
    '--import', 'tsx', '--test',
    '--test-reporter', 'file:///r.mjs', '--test-reporter-destination', 'stdout',
    '--test-reporter', 'spec', '--test-reporter-destination', 'C:\\logs\\A.log',
    'test/a.test.ts', 'test/b.test.ts',
  ]);
  assert.equal(nodeTestArgs({ files: ['x.test.mjs'], tsx: false }, { reporterUrl: 'u', logFile: 'l' })[0], '--test');
});

// --- reading results --------------------------------------------------------------------------

const ev = (o: Record<string, unknown>): string => JSON.stringify(o);

test('reporter lines: a running count, then node\'s own totals', () => {
  const c = newCounts();
  assert.equal(applyReporterLine(c, ev({ t: 'pass', name: 'one', nesting: 0, kind: 'test', skip: false, todo: false })), true);
  assert.equal(applyReporterLine(c, ev({ t: 'pass', name: 'a suite', nesting: 0, kind: 'suite', skip: false, todo: false })), true);
  assert.equal(applyReporterLine(c, ev({ t: 'fail', name: 'two', nesting: 1, kind: 'test', skip: false, todo: false, file: 'x.test.ts', err: 'Expected values to be strictly equal\n+ 1\n- 2' })), true);
  assert.equal(applyReporterLine(c, ev({ t: 'pass', name: 'three', nesting: 0, kind: 'test', skip: true, todo: false })), true);
  assert.equal(applyReporterLine(c, ev({ t: 'pass', name: 'four', nesting: 0, kind: 'test', skip: false, todo: true })), true);
  assert.deepEqual({ tests: c.tests, pass: c.pass, fail: c.fail, skipped: c.skipped, todo: c.todo }, { tests: 4, pass: 1, fail: 1, skipped: 1, todo: 1 });
  assert.deepEqual(c.failures, [{ name: 'two', file: 'x.test.ts', error: 'Expected values to be strictly equal' }]);
  assert.equal(countsText(c), '1 passed, 1 failed, 1 skipped, 1 todo');
  // A test's own console output is not an event.
  assert.equal(applyReporterLine(c, 'some log line'), false);
  assert.equal(applyReporterLine(c, '{"t":broken'), false);
  // The totals at the end replace the running count.
  for (const m of ['tests 40', 'suites 3', 'pass 37', 'fail 1', 'cancelled 0', 'skipped 1', 'todo 1', 'duration_ms 1234.5']) assert.equal(applyReporterLine(c, ev({ t: 'diag', message: m, nesting: 0 })), true);
  assert.equal(c.final, true);
  assert.deepEqual({ tests: c.tests, pass: c.pass, fail: c.fail, skipped: c.skipped, todo: c.todo, cancelled: c.cancelled }, { tests: 40, pass: 37, fail: 1, skipped: 1, todo: 1, cancelled: 0 });
  // A late event does not change node's totals.
  applyReporterLine(c, ev({ t: 'pass', name: 'late', kind: 'test', skip: false, todo: false }));
  assert.equal(c.tests, 40);
});

test('a test file that cannot load: its "test failed" is replaced by the error it wrote to stderr', () => {
  const file = 'C:\\repo\\src\\trading\\termsVector.test.ts';
  const missing = "Error: ENOENT: no such file or directory, open 'C:\\repo\\apps\\server\\test\\builderTerms.vector.json'";
  // stderr first, then the failure (the usual order) ...
  const a = newCounts();
  assert.equal(applyReporterLine(a, ev({ t: 'stderr', file, error: missing })), true);
  applyReporterLine(a, ev({ t: 'fail', name: 'src\\trading\\termsVector.test.ts', nesting: 0, kind: 'test', skip: false, todo: false, file, err: 'test failed' }));
  assert.equal(a.failures[0]!.error, missing);
  // ... or the other way round; and a real assertion message is never replaced.
  const b = newCounts();
  applyReporterLine(b, ev({ t: 'fail', name: 'whole file', nesting: 0, kind: 'test', skip: false, todo: false, file, err: 'test failed' }));
  applyReporterLine(b, ev({ t: 'fail', name: 'a test', nesting: 0, kind: 'test', skip: false, todo: false, file, err: 'Expected values to be strictly equal' }));
  applyReporterLine(b, ev({ t: 'stderr', file, error: missing }));
  assert.deepEqual(b.failures.map((f) => f.error), [missing, 'Expected values to be strictly equal']);
});

test('a suite passes only when the process says so, something ran and nothing failed', () => {
  const c = newCounts();
  c.tests = c.pass = 12;
  assert.deepEqual(testVerdict(c, 0, false), { ok: true, detail: '12 passed, 0 failed' });
  assert.match(testVerdict(c, 1, false).detail, /exited with code 1/);
  assert.match(testVerdict(c, 0, true).detail, /timed out/);
  assert.deepEqual(testVerdict(newCounts(), 0, false), { ok: false, detail: 'no test ran' });
  const f = newCounts();
  f.tests = 3;
  f.pass = 2;
  f.fail = 1;
  f.failures.push({ name: 'the broken one', file: null, error: 'x' });
  assert.deepEqual(testVerdict(f, 1, false), { ok: false, detail: '2 passed, 1 failed - first: the broken one' });
  const cancelled = newCounts();
  cancelled.tests = 2;
  cancelled.pass = 1;
  cancelled.cancelled = 1;
  assert.equal(testVerdict(cancelled, 0, false).ok, false);
});

test('tsc and forge output', () => {
  const t = parseTscOutput(['src/a.ts(3,5): error TS2322: Type \'string\' is not assignable to type \'number\'.', 'src/a.ts(9,1): error TS2304: Cannot find name \'x\'.', 'src/b.tsx(1,1): error TS1005: \';\' expected.', '', 'Found 3 errors in 2 files.']);
  assert.equal(t.errors, 3);
  assert.equal(t.files, 2);
  assert.equal(t.first.length, 3);
  assert.deepEqual(parseTscOutput([]), { errors: 0, files: 0, first: [] });
  assert.deepEqual(parseForgeOutput(['Ran 12 test suites in 3.41s (9.2s CPU time): 310 tests passed, 0 failed, 2 skipped (312 total tests)']), { passed: 310, failed: 0, skipped: 2 });
  assert.equal(parseForgeOutput(['Compiling...']), null);
});

test('a stage fails on any failed row; nothing run is "skipped"; warnings, findings and planned rows do not fail it', () => {
  const row = (status: Item['status']): Item => ({ id: 'x', title: 'x', status });
  assert.equal(stageStatus([row('PASS'), row('WARN'), row('FINDING'), row('SKIPPED')]), 'PASS');
  assert.equal(stageStatus([row('PASS'), row('FAIL')]), 'FAIL');
  assert.equal(stageStatus([row('SKIPPED'), row('SKIPPED')]), 'SKIPPED');
  assert.equal(stageStatus([]), 'SKIPPED');
  assert.equal(stageStatus([row('PLANNED'), row('PASS')]), 'PASS');
});

// --- the screen -------------------------------------------------------------------------------

test('everything printed is plain ASCII: typographic characters get a plain spelling, colour codes go', () => {
  assert.equal(toAscii('\u2714 ok \u2013 \u201Cquoted\u201D \u2192 next\u2026 5\u00D7 \u2265 1'), 'ok ok - "quoted" -> next... 5x >= 1');
  assert.equal(toAscii('\u001b[32mgreen\u001b[0m'), 'green');
  assert.equal(toAscii('Steinf\u00E4rtz \u00FCber Stra\u00DFe'), 'Steinfaertz ueber Strasse');
  assert.equal(toAscii('emoji \u{1F600} and \u4E2D'), 'emoji ?? and ?');
  assert.equal(toAscii('tab\there\nnew line'), 'tab\there\nnew line');
  for (const s of ['\u2139 info', '\u2716 failed', 'a\u00A0b']) assert.ok(/^[\x20-\x7E]*$/.test(toAscii(s)), s);
});

test('durations, money, clipping, wrapping, tables', () => {
  assert.equal(fmtDur(450), '0.5 s');
  assert.equal(fmtDur(41_200), '41 s');
  assert.equal(fmtDur(185_000), '3m05s');
  assert.equal(fmtDur(undefined), '-');
  assert.equal(fmtUsd(3.356), '$3.36');
  assert.equal(fmtUsd(-1), '-$1.00');
  assert.equal(fmtUsd(null), '-');
  assert.equal(clip('abcdefghij', 6), 'abc...');
  assert.equal(clip('abc', 6), 'abc');
  assert.deepEqual(wrap('one two three four', 9, ' '), [' one two', ' three', ' four']);
  assert.deepEqual(table(['a', 'bb'], [['1', '2'], ['333', '4']], { right: [1] }), ['a    bb', '---  --', '1     2', '333   4']);
});

test('a result line: status, title, time, detail - and a long reason goes underneath, whole', () => {
  const one = resultLines('PASS', 'web typecheck', 'no type errors', 29_000);
  assert.equal(one.length, 1);
  assert.match(one[0]!, /^ {2}PASS {4}web typecheck \.+ {3}29 s {2}no type errors$/);
  // Titles line up: the time column starts at the same place whatever the title.
  assert.equal(one[0]!.indexOf('29 s'), resultLines('PASS', 'server tests', '', 29_000)[0]!.indexOf('29 s'));
  assert.deepEqual(resultLines('PASS', 'Node.js 24.14.1'), ['  PASS    Node.js 24.14.1']);
  const long = resultLines('FAIL', 'server tests', `412 passed, 2 failed - first: ${'a very long test name '.repeat(8)}`, 123_000);
  assert.equal(long.length > 1, true);
  assert.match(long[0]!, /^ {2}FAIL {4}server tests \.+ {2}2m03s$/);
  assert.ok(long.slice(1).every((l) => l.startsWith('          ') && l.length <= 100));
  assert.ok(long.join(' ').includes('a very long test name a very long test name'));
});

test('Output: every line is redacted and plain; the live line exists only on a console', () => {
  const written: string[] = [];
  const kept: string[] = [];
  const out = new Output((s) => written.push(s), { tty: false, transcript: (l) => kept.push(l) });
  out.redact = (s) => s.replace(/secret/g, '[redacted key]');
  out.line('a secret \u2192 here');
  out.live('progress that must not appear in a file');
  out.prompt('question? ');
  assert.deepEqual(written, ['a [redacted key] -> here\n', 'question? ']);
  assert.deepEqual(kept, ['a [redacted key] -> here', 'question? ']);

  const tty: string[] = [];
  const con = new Output((s) => tty.push(s), { tty: true, columns: 40 });
  con.live('first, a rather long progress line that is clipped');
  con.live('short');
  con.line('done');
  assert.equal(tty[0], '\rfirst, a rather long progress line t...');
  assert.equal(tty[1], `\rshort${' '.repeat(34)}`);
  assert.equal(tty[2], `\r${' '.repeat(5)}\r`); // the live line is wiped before a real one
  assert.equal(tty[3], 'done\n');
});
