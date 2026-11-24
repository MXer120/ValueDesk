#!/usr/bin/env node
// deploy/release/ci-flake.mjs - did the tests fail ONLY in a known network flake? For the test gate
// (deploy/release/test-gate.sh), which then runs them once more.
//
//   node deploy/release/ci-flake.mjs judge <run-tests output>   exit 0: only known flakes failed; 1: anything else
//
// A type error, a timed-out or cancelled suite, any other failing test, or an output that is cut: not a flake.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Tests that fail on the network, not on the code: suite id (deploy/ci/run-tests.mjs) and the test's exact name. */
export const KNOWN_FLAKES = [
  // SoDEX's registry over the public RPC, 20 s limit; failed CI on 2026-11-09 with the code unchanged.
  { suite: 'server-tests', test: 'the live registry decodes into usable routes' },
];

/** A GitHub job log without its timestamps ("2026-11-09T10:00:00.1234567Z " in front of every line). */
export function stripTimestamps(text) {
  return String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
}

/**
 * The failed suites in run-tests.mjs's output: "FAIL  <id>  <time>  <detail>" and, under it, "        x <test>"
 * per failing test. `finished`: its last line ("run-tests: FAILED - ...") is there, so the failure is the test
 * step's and the list is whole.
 */
export function failedSuites(text) {
  const lines = stripTimestamps(text);
  const suites = [];
  let cur = null;
  let finished = false;
  for (const l of lines) {
    const m = /^FAIL\s{2}(\S+)\s+.*?\d+(?:\.\d+)? (?:s|min(?: \d+ s)?)\s{2}(.*)$/.exec(l);
    if (m) { cur = { id: m[1], detail: m[2].trim(), tests: [] }; suites.push(cur); continue; }
    const x = /^ {8}x (.+)$/.exec(l);
    if (x && cur) { cur.tests.push(x[1].trim()); continue; }
    cur = null;
    if (/^run-tests: FAILED\b/.test(l)) finished = true;
  }
  return { suites, finished };
}

/** Whether a job log shows only KNOWN_FLAKES failing: { flake, why }. */
export function judgeLog(text, known = KNOWN_FLAKES) {
  const { suites, finished } = failedSuites(text);
  if (!finished) return { flake: false, why: 'the log does not end in the test step\'s summary (install, checkout or a cut log)' };
  if (!suites.length) return { flake: false, why: 'no failed suite in the log' };
  for (const s of suites) {
    const n = /^(\d+) passed, (\d+) failed(?:, \d+ skipped)?(?:, \d+ todo)? \(exit \d+\)$/.exec(s.detail);
    if (!n) return { flake: false, why: `${s.id}: ${s.detail}` };
    if (Number(n[2]) !== s.tests.length || !s.tests.length) return { flake: false, why: `${s.id}: ${n[2]} failed, ${s.tests.length} named` };
    const other = s.tests.filter((t) => !known.some((k) => k.suite === s.id && k.test === t));
    if (other.length) return { flake: false, why: `${s.id}: ${other.join('; ')}` };
  }
  return { flake: true, why: suites.map((s) => `${s.id}: ${s.tests.join('; ')}`).join(', ') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'judge' && rest[0]) {
    const v = judgeLog(readFileSync(rest[0], 'utf8'));
    console.log(`${v.flake ? 'flake' : 'not a flake'}: ${v.why}`);
    process.exit(v.flake ? 0 : 1);
  } else {
    console.error('usage: node deploy/release/ci-flake.mjs judge <run-tests output>');
    process.exit(2);
  }
}
