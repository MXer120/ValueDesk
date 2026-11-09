// node --test deploy/vercel/ignore-build.test.mjs
//
// Vercel's Ignored Build Step (deploy/vercel/ignore-build.sh) for ship.sh's early web (deploy/release/vercel-web.mjs):
// the main project builds the branch `ship` (the staged build), the beta project never does; main is skipped only at
// the very commit `ship-live` names (already built and promoted), and built otherwise. Against a local "origin" (a
// bare repository): no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STEP = join(HERE, 'ignore-build.sh');
const SKIP = spawnSync('git', ['--version']).status === 0 && spawnSync('bash', ['-c', 'true']).status === 0 ? false : 'needs git and bash';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ignore-build-'));
  const work = join(dir, 'work');
  const bare = join(dir, 'origin.git');
  const g = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g(dir, 'init', '-q', '--bare', bare);
  g(dir, 'init', '-q', work);
  g(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  const one = g(work, 'rev-parse', 'HEAD');
  g(work, 'commit', '-q', '--allow-empty', '-m', 'two');
  const two = g(work, 'rev-parse', 'HEAD');
  g(work, 'remote', 'add', 'origin', bare);
  g(work, 'push', '-q', 'origin', `${one}:refs/heads/ship-live`);
  return { work, one, two };
}

function step(cwd, env) {
  const r = spawnSync('bash', [STEP], { cwd, encoding: 'utf8', env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: '', VS_ALWAYS_BUILD: '', ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

test('the branch ship: built in the main project, never in the beta project', { skip: SKIP }, () => {
  const { work, two } = repo();
  assert.equal(step(work, { VERCEL_URL: 'valuedesk-abc123.vercel.app', VERCEL_GIT_COMMIT_REF: 'ship', VERCEL_GIT_COMMIT_SHA: two }).code, 1);
  const beta = step(work, { VERCEL_URL: 'valuedesk-beta-abc123.vercel.app', VERCEL_GIT_COMMIT_REF: 'ship', VERCEL_GIT_COMMIT_SHA: two });
  assert.equal(beta.code, 0);
  assert.match(beta.out, /serves only 'beta'/);
  // Any other branch stays skipped.
  assert.equal(step(work, { VERCEL_URL: 'valuedesk-abc123.vercel.app', VERCEL_GIT_COMMIT_REF: 'copy-trading', VERCEL_GIT_COMMIT_SHA: two }).code, 0);
});

test('main at the commit ship-live names is skipped; any other commit of main builds', { skip: SKIP }, () => {
  const { work, one, two } = repo();
  const live = step(work, { VERCEL_URL: 'valuedesk-abc123.vercel.app', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: one });
  assert.equal(live.code, 0);
  assert.match(live.out, /already built .* and made it live/);
  assert.equal(step(work, { VERCEL_URL: 'valuedesk-abc123.vercel.app', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: two }).code, 1);
  // VS_ALWAYS_BUILD builds it anyway.
  assert.equal(step(work, { VERCEL_URL: 'valuedesk-abc123.vercel.app', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: one, VS_ALWAYS_BUILD: '1' }).code, 1);
});
