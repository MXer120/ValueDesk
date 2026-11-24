// node --test deploy/release/test-gate.test.mjs
//
// The test gate (deploy/release/test-gate.sh) with fake git and node: it passes only on exactly the tag, clean, with the
// lockfile's packages and every suite green; a known flake gets one second run; a pass is remembered for a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'test-gate.sh').replace(/\\/g, '/');
const SKIP = spawnSync('bash', ['-c', 'true']).status === 0 ? false : 'needs bash';
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** runs: each test run's exit code in order; head: HEAD's commit, and after a run; dirty: git status; deps, flake: exit codes; past: a pass that many seconds ago. */
function gate({ runs = [0], head = SHA, after = head, dirty = '', deps = 0, flake = 1, past = null, times = 1 } = {}) {
  const script = `
    set -euo pipefail
    note() { echo "$*" >&2; }
    die() { echo "DIED: $*"; exit 1; }
    T="$(mktemp -d)"; echo 0 > "$T/n"; OUT_DIR="$T/out"; mkdir -p "$OUT_DIR"
    trap 'echo "$(cat "$T/n") runs"; rm -rf "$T"' EXIT
    ${past == null ? '' : `echo "${SHA} $(( $(date -u +%s) - ${past} )) v9.9.9" > "$OUT_DIR/gate-passed.log"`}
    git() {
      case "$1" in
        rev-parse) if [ "$2" != HEAD ]; then echo ${SHA}; elif [ "$(cat "$T/n")" = 0 ]; then echo ${head}; else echo ${after}; fi ;;
        status) printf '%s' '${dirty}' ;;
      esac
    }
    RUNS=(${runs.join(' ')})
    node() {
      case "$1" in
        deploy/ci/deps-check.mjs) return ${deps} ;;
        deploy/release/ci-flake.mjs) ${flake === 0 ? "echo 'flake: server-tests: x'" : "echo 'not a flake: y'"}; return ${flake} ;;
      esac
      local n; n="$(cat "$T/n")"; echo $((n + 1)) > "$T/n"; echo "run-tests: run $n"; return "\${RUNS[$n]}"
    }
    env() { [ "$1 $2 $3 $4" = "-u GITHUB_TOKEN -u GH_TOKEN" ] || { echo "DIED: env $*"; exit 1; }; shift 4; "$@"; }
    . ${JSON.stringify(GATE)}
    for _ in $(seq ${times}); do test_gate v9.9.9; echo PASSED; done
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

test('every suite green on the tag passes, and a second call does not run them again', { skip: SKIP }, () => {
  assert.match(gate({ times: 2 }), /PASSED\nPASSED\n1 runs/);
  assert.match(gate({ past: 3600 }), /PASSED\n0 runs/);
  assert.match(gate({ past: 90_000 }), /PASSED\n1 runs/);
});

test('a failing suite stops the release', { skip: SKIP }, () => {
  const out = gate({ runs: [1] });
  assert.match(out, /DIED: test gate: tests FAILED for v9\.9\.9 - nothing was released \(not a flake: y;/);
  assert.doesNotMatch(out, /PASSED/);
});

test('a known flake: one second run; its failure stops the release', { skip: SKIP }, () => {
  assert.match(gate({ runs: [1, 0], flake: 0 }), /PASSED\n2 runs/);
  const out = gate({ runs: [1, 1, 0], flake: 0 });
  assert.match(out, /DIED: test gate: tests FAILED for v9\.9\.9 again/);
  assert.match(out, /^2 runs$/m);
});

test('another commit, changes, other packages, or a checkout that moved meanwhile: not the tag', { skip: SKIP }, () => {
  assert.match(gate({ head: 'f'.repeat(40) }), /DIED: test gate: HEAD is not v9\.9\.9[\s\S]*^0 runs$/m);
  assert.match(gate({ dirty: ' M apps/web/src/x.ts' }), /DIED: test gate: this checkout has changes[\s\S]*^0 runs$/m);
  assert.match(gate({ deps: 1 }), /DIED: test gate: the installed packages[\s\S]*^0 runs$/m);
  const out = gate({ after: 'f'.repeat(40) });
  assert.match(out, /DIED: test gate: this checkout changed while the tests ran/);
  assert.doesNotMatch(out, /PASSED/);
});

test('it asks GitHub nothing', () => {
  assert.doesNotMatch(readFileSync(join(HERE, 'test-gate.sh'), 'utf8'), /api\.github\.com|check-runs/);
});
