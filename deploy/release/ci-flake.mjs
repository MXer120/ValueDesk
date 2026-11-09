#!/usr/bin/env node
// deploy/release/ci-flake.mjs - did the tag's CI fail ONLY in a known network flake? Then run the failed job once more.
// For the test gate (deploy/release/test-gate.sh), which calls it once per ship at most.
//
//   node deploy/release/ci-flake.mjs retry <owner/repo> <check-run url>...   exit 0: rerun asked for; 1: not a flake (or no rerun)
//   node deploy/release/ci-flake.mjs judge <job log file>                    exit 0: only known flakes failed; 1: anything else
//
// WHY (2026-11-09): "the live registry decodes into usable routes" (apps/server/test/mirror.test.ts) reads SoDEX's
// on-chain registry over the network with a 20 s limit and fails CI on a slow answer. That day it stopped a ship;
// the owner reran the job by hand (POST .../actions/runs/<id>/rerun-failed-jobs) and ran ship.sh again: ~10 min
// of CI plus the time until someone noticed. Now the gate does that rerun itself - ONCE, and only when the job's
// log shows the test step failed in nothing but tests listed in KNOWN_FLAKES. A type error, an install error, a
// timed-out or cancelled suite, any other failing test, or a log that cannot be read: no rerun, the gate stops as
// before. A rerun that fails again stops it too (test-gate.sh asks for one rerun per ship).
//
// Reads with the gate's token (GITHUB_TOKEN): the job's log needs "Actions: read", the rerun "Actions: write".
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

/** Run and job of a check run's page: https://github.com/<o>/<r>/actions/runs/<run>/job/<job>. */
export function runAndJob(url) {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(String(url ?? ''));
  return m ? { run: m[1], job: m[2] } : null;
}

/** For each failed check run: its job's log judged; when every one is a known flake, one rerun of each run's failed jobs. */
export async function retry(repo, urls, { token, fetchImpl = fetch } = {}) {
  const gh = (path, init = {}) => fetchImpl(`https://api.github.com/repos/${repo}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'valuedesk-ship' },
  });
  const ids = urls.map(runAndJob);
  if (!ids.length || ids.some((x) => !x)) return { rerun: false, why: `not a job's page: ${urls.join(' ')}` };
  const whys = [];
  for (const { job } of ids) {
    // A redirect to the log's file; fetch follows it (and drops the token on the other host).
    const r = await gh(`actions/jobs/${job}/logs`).catch(() => null);
    if (!r?.ok) return { rerun: false, why: `the log of job ${job} could not be read (${r ? r.status : 'network'})` };
    const v = judgeLog(await r.text());
    if (!v.flake) return { rerun: false, why: v.why };
    whys.push(v.why);
  }
  for (const run of [...new Set(ids.map((x) => x.run))]) {
    const r = await gh(`actions/runs/${run}/rerun-failed-jobs`, { method: 'POST' }).catch(() => null);
    if (!r || r.status !== 201) return { rerun: false, why: `GitHub refused the rerun of run ${run} (${r ? r.status : 'network'})` };
  }
  return { rerun: true, why: whys.join(', ') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'judge' && rest[0]) {
    const v = judgeLog(readFileSync(rest[0], 'utf8'));
    console.log(`${v.flake ? 'flake' : 'not a flake'}: ${v.why}`);
    process.exit(v.flake ? 0 : 1);
  } else if (cmd === 'retry' && rest.length >= 2) {
    const v = await retry(rest[0], rest.slice(1), { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
    console.log(`${v.rerun ? 'rerun' : 'no rerun'}: ${v.why}`);
    process.exit(v.rerun ? 0 : 1);
  } else {
    console.error('usage: node deploy/release/ci-flake.mjs retry <owner/repo> <check-run url>... | judge <log file>');
    process.exit(2);
  }
}
