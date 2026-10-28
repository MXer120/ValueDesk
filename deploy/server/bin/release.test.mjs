// node --disable-warning=ExperimentalWarning --test deploy/server/bin/release.test.mjs
//
// Which units a release restarts: release-restarts.test.sh cuts the decision out of
// release.sh and runs it against fake release trees (nothing is installed, no unit
// is touched). Needs bash and GNU diff (Git Bash on Windows has both).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// A build machine without bash or GNU diff (Vercel's, perhaps) skips this and says so.
const SKIP = spawnSync("bash", ["-c", "command -v diff >/dev/null"]).status === 0 ? false : "needs bash and GNU diff";

test('a release restarts only the units whose code changed: web and tests change nothing, the copy engine only the executor; VS_UNITS and --units', { skip: SKIP }, () => {
  const r = spawnSync('bash', [join(HERE, 'release-restarts.test.sh'), join(HERE, 'release.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /pass 16 fail 0/);
});
