/**
 * Real algos are off (liveAlgos.ts), but for the live test suite's wallets on a dev server
 * (VITE_LIVE_ALGOS_WALLETS in apps/web/.env.local): never in a build for a deployment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_ALGOS, LIVE_ALGOS_OFF, LIVE_ALGOS_WALLETS, liveAlgoWalletsFrom, liveAlgosFor, requirePaperAlgo } from './liveAlgos';

const A = '0x00000000000000000000000000000000000000Aa';
const B = '0x00000000000000000000000000000000000000bb';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('the variable is read on a dev server only: its addresses, lower-case, and nothing else in it', () => {
  assert.deepEqual([...liveAlgoWalletsFrom(` ${A}, ${B},,not-an-address, 0x12 `, true)], [A.toLowerCase(), B]);
  assert.equal(liveAlgoWalletsFrom(`${A},${B}`, false).size, 0, 'a build for a deployment lets no wallet');
  assert.equal(liveAlgoWalletsFrom('*', true).size, 0, 'no wildcard: every wallet would be the owner switching real algos on');
  assert.equal(liveAlgoWalletsFrom(undefined, true).size, 0);
  assert.equal(LIVE_ALGOS_WALLETS.size, 0, 'outside Vite (no import.meta.env) there are none');
});

test('a listed wallet may start a real algo; every other one only practice runs, while real algos are off', () => {
  assert.equal(LIVE_ALGOS, false);
  const listed = liveAlgoWalletsFrom(A, true);
  assert.equal(liveAlgosFor(A.toLowerCase(), listed), true);
  assert.equal(liveAlgosFor(B, listed), false);
  assert.equal(liveAlgosFor(null, listed), false);
  assert.doesNotThrow(() => requirePaperAlgo({ kind: 'twap', paper: false }, A, listed));
  assert.throws(() => requirePaperAlgo({ kind: 'twap', paper: false }, B, listed), new RegExp(LIVE_ALGOS_OFF.slice(0, 30)));
  assert.throws(() => requirePaperAlgo({ kind: 'twap' }, null, listed), /Real algo orders are off/);
  assert.doesNotThrow(() => requirePaperAlgo({ kind: 'twap', paper: true }, B, listed), 'a practice run needs no list');
  assert.throws(() => requirePaperAlgo({ kind: 'twap', paper: false }, A), /Real algo orders are off/, 'without a list (this build): refused');
});

test('no build for a deployment sets it: build-web.sh exports it empty and refuses a settings file that names it', () => {
  const build = readFileSync(join(REPO, 'deploy', 'release', 'build-web.sh'), 'utf8');
  assert.match(build, /DEV_ONLY_VARS=\([^)]*\bVITE_LIVE_ALGOS_WALLETS\b[^)]*\)/, 'build-web.sh knows it as a dev-only variable');
  for (const f of ['deploy/release/web.env.example', 'deploy/vercel/production.settings']) {
    assert.doesNotMatch(readFileSync(join(REPO, f), 'utf8'), /^\s*VITE_LIVE_ALGOS_WALLETS\s*=/m, `${f} does not set it`);
  }
});
