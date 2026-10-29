// node --test deploy/ci/run-tests.test.mjs
//
// The CI runner's discovery on this checkout, and how it reads node:test's output.
// It only lists suites - it runs none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, failedNames, parseTotals } from './run-tests.mjs';

test('every workspace is found - the executor too, which no npm workspace and no guide stage lists', () => {
  const ids = discover().map((s) => s.id);
  for (const id of ['server-typecheck', 'server-tests', 'executor-typecheck', 'executor-tests', 'copy-engine-tests', 'sodex-core-tests', 'web-typecheck', 'web-unit', 'deploy-tests']) {
    assert.ok(ids.includes(id), `${id} is missing: ${ids.join(', ')}`);
  }
});

test('nothing that trades or needs a wallet or a browser is ever run: the live tests, the native e2e and the UI specs stay out', () => {
  for (const s of discover()) {
    for (const f of s.files ?? []) {
      const p = `${s.cwd}/${f}`;
      assert.doesNotMatch(p, /tools\/live-test\/|e2e\/live\/native\/|e2e\/ui\//, p);
    }
    for (const p of s.projects ?? []) assert.ok(!String(p ?? '').includes('e2e/ui'), `${s.id} type-checks e2e/ui`);
  }
  const deploy = discover().find((s) => s.id === 'deploy-tests');
  assert.ok(deploy.files.includes('deploy/server/bin/healthcheck.test.mjs'));
  assert.ok(deploy.files.includes('deploy/ci/run-tests.test.mjs'), 'this file runs itself in CI');
});

test('node:test totals and failed names are read from the spec output', () => {
  const out = [
    '✔ one (1.2ms)',
    '✖ two breaks (3ms)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    'ℹ skipped 0',
    '✖ failing tests:',
    '✖ two breaks (3ms)',
  ].join('\n');
  assert.deepEqual(parseTotals(out), { tests: 2, pass: 1, fail: 1, skipped: 0 });
  assert.deepEqual(failedNames(out), ['two breaks']);
});
