// node --test deploy/release/ci-flake.test.mjs
//
// The test gate's one second run (deploy/release/ci-flake.mjs): only when nothing but a known network flake failed; a
// type error, another failing test, a timed-out suite, an install error or a cut output is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedSuites, judgeLog } from './ci-flake.mjs';

const FLAKE = 'the live registry decodes into usable routes';
// run-tests.mjs's output as GitHub's job log shows it: a timestamp in front of every line.
const log = (lines) => lines.map((l, i) => `2026-11-09T10:0${i % 10}:00.1234567Z ${l}`).join('\n');
const head = ['Run node deploy/ci/run-tests.mjs --jobs=2 --json=deploy/.out/ci-summary.json', 'run-tests: 18 suites, 2 at a time; logs in deploy/.out/ci/', 'PASS  server-typecheck             41.2 s  no type errors'];
const serverFail = (failed, names, detail) => [
  `FAIL  server-tests            3 min 12 s  ${detail ?? `1201 passed, ${failed} failed (exit 1)`}`,
  ...names.map((n) => `        x ${n}`),
  '        --- the last lines of deploy/.out/ci/server-tests.log ---',
  `        ✖ ${names[0] ?? 'x'} (20012.5ms)`,
];
const tail = (failed = 'server-tests') => [`run-tests: FAILED - 17 of 18 suites passed in 7 min 40 s; failed: ${failed}`, '##[error]Process completed with exit code 1.'];

test('only the known flake failed: rerun', () => {
  const v = judgeLog(log([...head, ...serverFail(1, [FLAKE]), 'PASS  executor-tests            1 min 2 s  300 passed, 0 failed (27 files)', ...tail()]));
  assert.equal(v.flake, true);
  assert.match(v.why, /server-tests: the live registry/);
});

test('anything else: no rerun', () => {
  // Another test failed beside it.
  assert.equal(judgeLog(log([...head, ...serverFail(2, [FLAKE, 'the copy ladder rounds down']), ...tail()])).flake, false);
  // More failed than are named (a nested failure the summary did not list).
  assert.equal(judgeLog(log([...head, ...serverFail(2, [FLAKE]), ...tail()])).flake, false);
  // The same name in another suite is not the known flake.
  const other = log([...head, `FAIL  web-unit                 2 min 1 s  900 passed, 1 failed (exit 1)`, `        x ${FLAKE}`, ...tail('web-unit')]);
  assert.equal(judgeLog(other).flake, false);
  // A type error, a timed-out or cancelled suite.
  assert.equal(judgeLog(log([...head, 'FAIL  web-typecheck            50.1 s  3 type errors', '        x src/a.ts(1,1): error TS2304: x', ...tail('web-typecheck')])).flake, false);
  assert.equal(judgeLog(log([...head, ...serverFail(0, [], 'timed out after 15 min'), ...tail()])).flake, false);
  assert.equal(judgeLog(log([...head, ...serverFail(1, [FLAKE], '1200 passed, 1 failed, 1 cancelled (exit 1)'), ...tail()])).flake, false);
  // The install step failed: no summary of the tests at all.
  assert.equal(judgeLog(log(['Run npm ci --no-audit --no-fund', 'npm error code ECONNRESET', '##[error]Process completed with exit code 1.'])).flake, false);
  // A log cut before the summary.
  assert.equal(judgeLog(log([...head, ...serverFail(1, [FLAKE])])).flake, false);
  assert.equal(judgeLog('').flake, false);
});

test('the parser reads the suites and their failing tests', () => {
  const { suites, finished } = failedSuites(log([...head, ...serverFail(1, [FLAKE]), ...tail()]));
  assert.equal(finished, true);
  assert.deepEqual(suites, [{ id: 'server-tests', detail: '1201 passed, 1 failed (exit 1)', tests: [FLAKE] }]);
});
