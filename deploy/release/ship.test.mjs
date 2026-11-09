// node --test deploy/release/ship.test.mjs
//
// ship.sh's side-by-side work (the header: WHAT RUNS SIDE BY SIDE), cut out of ship.sh and run in bash with fakes for
// everything that would reach a server: the plan's flow lines; the executor's step beside server 1 (lane_start /
// lane_join) handing back its notes, its notice calls and the brake as it was, and switching nothing once server 1
// stopped the ship; the time of each phase. Then the order of the guards in ship_executor itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIP = join(HERE, 'ship.sh');
const SRC = readFileSync(SHIP, 'utf8');
const SKIP = spawnSync('bash', ['-c', 'command -v sed >/dev/null']).status === 0 ? false : 'needs bash and sed';

/** The lines of ship.sh from the one starting with `from` up to (not including) the one starting with `to`. */
function cut(from, to) {
  const lines = SRC.split('\n');
  const a = lines.findIndex((l) => l.startsWith(from));
  const b = lines.findIndex((l, i) => i > a && l.startsWith(to));
  assert.ok(a >= 0 && b > a, `ship.sh has no section ${from} .. ${to}`);
  return lines.slice(a, b).join('\n');
}

/** Runs `body` in bash after the cut-out functions and the fakes; returns stdout + stderr. */
function bash(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-test-'));
  const script = [
    'set -euo pipefail',
    `OUT_DIR=${JSON.stringify(dir.replace(/\\/g, '/'))}; TAG=v9.9.9`,
    'note() { echo "$*" >&2; }; say() { printf "\\n== %s\\n" "$*" >&2; }',
    'LAST_ERROR=""; die() { LAST_ERROR="$*"; echo "error: $*" >&2; exit 1; }',
    'want() { local p; for p in ${PARTS[@]+"${PARTS[@]}"}; do [ "$p" = "$1" ] && return 0; done; return 1; }',
    'DONE_NOTES=() NOTICE_OK=1 WARNED=0 BRAKE0="" CALLS=()',
    'done_note() { DONE_NOTES+=("$*"); }',
    'notice_done() { CALLS+=("done $*"); }; notice_affected() { CALLS+=("affected $*"); }; notice_note() { CALLS+=("note $*"); }',
    cut('# --- the time each phase took', '# --- arguments'),
    cut('# THE FLOW', '# END FLOW'),
    cut('# --- server 2 beside server 1', '# The site answers'),
    body,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const flow = (vars) => bash(`${vars}\nprint_flow`).out;
const BASE = 'BIN=0 STA=0 FEED=0 WEB=1 MOVE_MAIN=1 SITE_CHANGED=1 EARLY_INSTALL=1 PARALLEL=1 EARLY_WEB=1 EARLY_WEB_WHY=""';

test('the plan shows what runs beside what', { skip: SKIP }, () => {
  const out = flow(`${BASE}; U1=(api) U2=(executor) PARTS=(api executor web)`);
  assert.match(out, /1\. tag, CI - meanwhile: tarball to the servers, installed beside the running release \(nothing switched\); the web built on Vercel, not live/);
  assert.match(out, /2\. scripts, maintenance window/);
  assert.match(out, /3\. server 1: api \+ its gates \| beside it, server 2: executor \(its own guards\)/);
  assert.match(out, /4\. the web live: Vercel's promote of the early build \(seconds\), main -> v9\.9\.9/);

  const ix = flow(`${BASE}; U1=(indexer api) U2=() PARTS=(indexer api)`);
  assert.match(ix, /server 1: indexer, api \+ its gates$/m);

  const one = flow(`${BASE}; PARALLEL=0; U1=(indexer api) U2=(executor) PARTS=(indexer api executor web)`);
  assert.match(one, /server 1: indexer, api \+ its gates, then server 2: executor/);
  const both = flow(`${BASE}; U1=(indexer api) U2=(executor) PARTS=(indexer api executor web)`);
  assert.match(both, /\(indexer gate 20 min\) \| beside it, server 2: executor/);

  const late = flow(`${BASE}; EARLY_WEB=0 EARLY_WEB_WHY="no Vercel token"; EARLY_INSTALL=0; U1=(api) U2=() PARTS=(api web)`);
  assert.match(late, /1\. tag, CI - meanwhile: tarball to the servers$/m);
  assert.match(late, /main -> v9\.9\.9, Vercel builds the web \(8-10 min\) - not early: no Vercel token/);

  const webOnly = flow(`${BASE}; EARLY_WEB=0 SITE_CHANGED=0; U1=() U2=() PARTS=(web)`);
  assert.match(webOnly, /1\. tag, CI\n/);
  assert.match(webOnly, /2\. main -> v9\.9\.9 \(no web build\)/);
});

test('the executor beside server 1: its notes and the brake come back; its notice updates went out at once', { skip: SKIP }, () => {
  const { code, out } = bash(`
    notice_note() { echo "LIVE note $*" >&2; }
    exec_part() { note "executor step"; done_note "executor: 3 copies as before"; notice_note "copies resume"; BRAKE0='{"on":["copies"]}'; EXEC_SWITCHED=1; }
    done_note "api back"
    lane_start
    lane_join
    printf 'RC=%s SWITCHED=%s BRAKE0=%s NOTICE_OK=%s\\n' "$LANE_RC" "$LANE_SWITCHED" "$BRAKE0" "$NOTICE_OK"
    printf 'NOTE=%s\\n' "\${DONE_NOTES[@]}"
    printf 'CALL=%s\\n' "\${CALLS[@]}"
    printf 'PHASES=%s\\n' "$(phase_summary)"
    rolled_back_words
  `);
  assert.equal(code, 0, out);
  assert.match(out, /\[server 2\] executor step/);
  assert.match(out, /RC=0 SWITCHED=1 BRAKE0=\{"on":\["copies"\]\} NOTICE_OK=1/);
  assert.match(out, /NOTE=api back\nNOTE=executor: 3 copies as before/);
  assert.match(out, /\[server 2\] LIVE note copies resume/);
  assert.doesNotMatch(out, /CALL=note/);
  assert.match(out, /PHASES=server 2 beside server 1 0:0\d/);
  assert.match(out, /rolled back; the copy executor runs the update \(it passed its own checks\), everything else runs as before\./);
});

test('a failed executor step: its rollback notice is replayed here, the ship stops with its words', { skip: SKIP }, () => {
  const { code, out } = bash(`
    exec_part() { notice_done rolled_back "The copy executor's update was rolled back; copies and algo orders run as before."; NOTICE_OK=0; die "executor: v9.9.9 rolled back"; }
    lane_start
    lane_join
    printf 'RC=%s ERR=%s NOTICE_OK=%s SWITCHED=%s\\n' "$LANE_RC" "$LANE_ERROR" "$NOTICE_OK" "$LANE_SWITCHED"
    printf 'CALL=%s\\n' "\${CALLS[@]}"
  `);
  assert.equal(code, 0, out);
  assert.match(out, /RC=1 ERR=executor: v9\.9\.9 rolled back NOTICE_OK=0 SWITCHED=0/);
  assert.match(out, /CALL=done rolled_back The copy executor's update was rolled back; copies and algo orders run as before\./);
});

test('server 1 stops the ship: the executor switches nothing more', { skip: SKIP }, () => {
  // The fake step waits, as ship_executor's install and preflight would, then looks before its brake.
  const { code, out } = bash(`
    exec_part() {
      for i in $(seq 1 100); do [ -e "$LANE_ABORT" ] && break; sleep 0.1; done
      if [ -n "\${LANE_ABORT:-}" ] && [ -e "$LANE_ABORT" ]; then die "executor: not switched - server 1 stopped this ship first"; fi
      EXEC_SWITCHED=1
    }
    lane_start
    lane_stop
    printf 'RC=%s ERR=%s SWITCHED=%s PID=[%s]\\n' "$LANE_RC" "$LANE_ERROR" "$LANE_SWITCHED" "$LANE_PID"
    [ ! -e "$OUT_DIR/ship-abort-$TAG" ] && echo "abort file removed"
    rolled_back_words
  `);
  assert.equal(code, 0, out);
  assert.match(out, /RC=1 ERR=executor: not switched - server 1 stopped this ship first SWITCHED=0 PID=\[\]/);
  assert.match(out, /abort file removed/);
  assert.match(out, /The update was rolled back; everything runs as before\./);
});

test('a lane that leaves no result counts as not healthy', { skip: SKIP }, () => {
  const { out } = bash(`
    exec_part() { kill -9 $BASHPID; }
    lane_start
    lane_join
    printf 'RC=%s NOTICE_OK=%s WARNED=%s\\n' "$LANE_RC" "$NOTICE_OK" "$WARNED"
    echo "$LANE_ERROR"
  `);
  assert.match(out, /RC=1 NOTICE_OK=0 WARNED=1/);
  assert.match(out, /ended without a result/);
});

test('phases: each ended by the next, the side ones added', { skip: SKIP }, () => {
  const { out } = bash(`
    date() { if [ "$*" = "-u +%s" ]; then echo $(( T )); else command date "$@"; fi; }
    T=1000; phase tag; T=1030; phase "ci + beside it"; phase_add "beside CI: uploads + installs" 95; T=1600; phase web; T=1625; phase ""
    phase_summary
  `);
  assert.match(out, /tag 0:30, ci \+ beside it 9:30, beside CI: uploads \+ installs 1:35, web 0:25|tag 0:30, beside CI: uploads \+ installs 1:35, ci \+ beside it 9:30, web 0:25/);
});

test('ship_executor: the stop from server 1 is looked at after the preflight and quiet moment, before the brake and switch', () => {
  const body = cut('ship_executor() {', 'exec_part() {');
  const at = (s) => { const i = body.indexOf(s); assert.ok(i >= 0, `ship_executor has no ${s}`); return i; };
  assert.ok(at('tools/preflight.ts') < at('LANE_ABORT'));
  assert.ok(at('a quiet moment') < at('LANE_ABORT'));
  assert.ok(at('LANE_ABORT') < at('brake.sh on --maintenance'));
  assert.ok(at('brake.sh on --maintenance') < at('--units=executor'));
});

test('the early install uses the server\'s release.sh only when it is the tag\'s', () => {
  const body = cut('early_install() {', 'NEED1=0');
  assert.match(body, /tar -xzOf \$tb --wildcards '\*\/deploy\/server\/bin\/release\.sh' \| sha256sum/);
  assert.match(body, /\[ "\$same" != same \]; then note .*; return 0; fi/);
  assert.match(body, /--install-only --from=\$tb/);
  // Nothing switched before CI: sync_bin and every release without --install-only come after the gate.
  const gate = SRC.indexOf('\ntest_gate "$TAG"');
  assert.ok(gate > 0 && SRC.indexOf('\nphase "ci + beside it"') < gate);
  assert.ok(SRC.indexOf('sync_bin "$S1" >&2') > gate);
  assert.ok(SRC.indexOf('\nlane_start\n') === -1 && SRC.indexOf('[ "$LANE" = 0 ] || lane_start') > gate);
});
