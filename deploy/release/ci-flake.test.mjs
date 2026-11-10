// node --test deploy/release/ci-flake.test.mjs
//
// The test gate's one automatic rerun (deploy/release/ci-flake.mjs): only a CI job whose test step failed in nothing
// but a known network flake is run again; a type error, another failing test, a timed-out suite, an install error or
// an unreadable log is not. Then the GitHub calls, against a fake fetch: the log read, the rerun asked once per run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedSuites, judgeLog, retry, runAndJob } from './ci-flake.mjs';

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

test('run and job from a check run page', () => {
  assert.deepEqual(runAndJob('https://github.com/MXer120/ValueDesk/actions/runs/19200000001/job/54800000002'), { run: '19200000001', job: '54800000002' });
  assert.equal(runAndJob('https://github.com/MXer120/ValueDesk/runs/1'), null);
});

/** A fake GitHub: job logs by job id, the rerun answering `rerunStatus`; records the calls. */
function fakeGitHub(logs, rerunStatus = 201) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url.replace('https://api.github.com/repos/o/r/', '')}`);
    const job = /actions\/jobs\/(\d+)\/logs$/.exec(url);
    if (job) return logs[job[1]] == null ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => logs[job[1]] };
    if (/rerun-failed-jobs$/.test(url)) return { ok: rerunStatus < 300, status: rerunStatus };
    return { ok: false, status: 404 };
  };
  return { calls, fetchImpl };
}
const URL1 = 'https://github.com/o/r/actions/runs/11/job/21';

test('retry: a flake is rerun once; anything else is not', async () => {
  const flaky = log([...head, ...serverFail(1, [FLAKE]), ...tail()]);
  let g = fakeGitHub({ 21: flaky });
  assert.equal((await retry('o/r', [URL1], { token: 't', fetchImpl: g.fetchImpl })).rerun, true);
  assert.deepEqual(g.calls, ['GET actions/jobs/21/logs', 'POST actions/runs/11/rerun-failed-jobs']);

  g = fakeGitHub({ 21: log([...head, ...serverFail(1, ['another test']), ...tail()]) });
  assert.equal((await retry('o/r', [URL1], { token: 't', fetchImpl: g.fetchImpl })).rerun, false);
  assert.deepEqual(g.calls, ['GET actions/jobs/21/logs']);

  // The log cannot be read (token without "Actions: read"): no rerun.
  g = fakeGitHub({});
  const v = await retry('o/r', [URL1], { token: 't', fetchImpl: g.fetchImpl });
  assert.equal(v.rerun, false);
  assert.match(v.why, /could not be read \(404\)/);

  // GitHub refuses the rerun (token without "Actions: write"): reported as no rerun.
  g = fakeGitHub({ 21: flaky }, 403);
  assert.match((await retry('o/r', [URL1], { token: 't', fetchImpl: g.fetchImpl })).why, /refused the rerun of run 11 \(403\)/);

  // Not a job's page.
  assert.equal((await retry('o/r', ['https://example.com/x'], { token: 't', fetchImpl: g.fetchImpl })).rerun, false);
});
