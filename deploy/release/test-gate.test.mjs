// node --test deploy/release/test-gate.test.mjs
//
// The test gate's CI verdict (deploy/release/test-gate.sh), with GitHub played by a fake `node` that answers the
// check-runs query from a script of states: green passes; a failure stops the release unless ci-flake.mjs finds only a
// known network flake - then exactly one rerun, whose stale verdict (the failed run, still listed for a few seconds)
// is waited out, and whose own failure stops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'test-gate.sh').replace(/\\/g, '/');
const SKIP = spawnSync('bash', ['-c', 'true']).status === 0 ? false : 'needs bash';
const U1 = 'https://github.com/o/r/actions/runs/11/job/21';
const U2 = 'https://github.com/o/r/actions/runs/11/job/22';

/** states: what each check-runs query answers, in order; flake: ci-flake.mjs's exit code. */
function gate(states, flake = 1) {
  const script = `
    set -euo pipefail
    note() { echo "$*" >&2; }
    die() { echo "DIED: $*"; exit 1; }
    sleep() { :; }
    git() { case "$1" in rev-parse) echo 0123456789abcdef0123456789abcdef01234567 ;; remote) echo https://github.com/o/r.git ;; esac; }
    STATES=(${states.map((s) => `'${s}'`).join(' ')})
    # The gate reads each answer through $(...), a subshell: the counts live in files.
    T="$(mktemp -d)"; echo 0 > "$T/n"; echo 0 > "$T/r"
    node() {
      if [ "$1" = deploy/release/ci-flake.mjs ]; then echo $(( $(cat "$T/r") + 1 )) > "$T/r"; echo "\${FLAKE_OUT}"; return ${flake}; fi
      local n; n="$(cat "$T/n")"; echo $((n + 1)) > "$T/n"; echo "\${STATES[$n]}"; return 0
    }
    FLAKE_OUT="${flake === 0 ? 'rerun: server-tests: the live registry decodes into usable routes' : 'no rerun: server-tests: another test'}"
    export GITHUB_TOKEN=t
    . ${JSON.stringify(GATE)}
    trap 'echo "$(cat "$T/r") rerun asks"' EXIT
    test_gate v9.9.9 && echo "PASSED after $(cat "$T/n") queries"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

test('green passes, pending is waited for', { skip: SKIP }, () => {
  const out = gate(['pending', 'pending', 'success']);
  assert.match(out, /PASSED after 3 queries\n0 rerun asks/);
});

test('a real failure stops the release, no rerun', { skip: SKIP }, () => {
  const out = gate([`failure 21 ${U1}`], 1);
  assert.match(out, /DIED: test gate: CI FAILED for v9\.9\.9 \(0123456789ab\): https:\/\/github\.com\/o\/r\/actions\/runs\/11\/job\/21 - fix it, tag again, release that \(no rerun: server-tests: another test\)/);
});

test('a known flake: one rerun, its stale verdict waited out, then green', { skip: SKIP }, () => {
  const out = gate([`failure 21,22 ${U1} ${U2}`, `failure 21,22 ${U1} ${U2}`, 'pending', 'success'], 0);
  assert.match(out, /failed only in a known network flake - server-tests: the live registry/);
  assert.match(out, /PASSED after 4 queries\n1 rerun asks/);
  assert.match(out, /CI passed for v9\.9\.9 .*on its one rerun/);
});

test('a flake whose rerun fails too: stopped, never a second rerun', { skip: SKIP }, () => {
  const out = gate([`failure 21 ${U1}`, 'pending', `failure 31 ${U1.replace('21', '31')}`], 0);
  assert.match(out, /DIED: test gate: CI FAILED for v9\.9\.9 \(0123456789ab\) again on its rerun/);
  assert.doesNotMatch(out, /PASSED/);
  assert.match(out, /^1 rerun asks$/m);
});
