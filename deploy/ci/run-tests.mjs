#!/usr/bin/env node
// Every type check and every offline test suite of the repository, one after another.
// The one gate in front of a deploy: GitHub Actions runs it on every push and pull
// request (.github/workflows/ci.yml), Vercel runs it before it builds production
// (deploy/vercel/build.sh), and deploy/release/release-server.sh runs it (or checks
// that CI passed for the tag) before a server release.
//
//   node deploy/ci/run-tests.mjs                 everything; exit 0 only when all passed
//   node deploy/ci/run-tests.mjs --list          the suites it found, run none
//   node deploy/ci/run-tests.mjs --only=server,executor   suites whose id contains a word
//   node deploy/ci/run-tests.mjs --skip=web-typecheck     leave suites out (same matching)
//   node deploy/ci/run-tests.mjs --no-typecheck  tests only
//   node deploy/ci/run-tests.mjs --jobs=2        run up to two suites at the same time
//   node deploy/ci/run-tests.mjs --json=<file>   also write the summary as JSON
//
// THE SUITES ARE FOUND, NOT LISTED (the same rule as the test guide's stage A,
// apps/web/e2e/guide/suites.ts, which does not know apps/executor): every
// *.test.ts in apps/server/test, apps/executor/test and packages/*/test, every web
// unit test under apps/web/src, apps/web/tools/*.test.mjs, the offline live-runner
// and guide tests (apps/web/e2e/live, apps/web/e2e/guide, top level only), and every
// deploy/**/*.test.mjs. A test file added tomorrow is run tomorrow.
//
// NEVER RUN HERE: apps/web/e2e/live/native (a browser and a wallet), apps/web/e2e/ui
// (the UI specs: Microsoft Edge driving the dev web, e2e/ui/run.ts), and
// apps/executor/tools/live-test (real money on SoDEX mainnet). None matches the
// patterns above, and all three are refused by name as well.
//
// Tests are node:test, TypeScript through tsx (not vitest). Each suite's full output
// goes to deploy/.out/ci/<suite>.log; a failed suite prints its failing tests and the
// tail of its log. Nothing here needs the network or a key.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'deploy', '.out', 'ci');
const MIN = 60_000;

// --- arguments ---------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
for (const a of argv) {
  if (!/^--(list|only|skip|no-typecheck|jobs|json|help)(=|$)/.test(a)) {
    console.error(`run-tests: unknown argument ${a} (--help lists them)`);
    process.exit(2);
  }
}
if (opt('help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const words = (v) => (typeof v === 'string' ? v.split(',').map((w) => w.trim()).filter(Boolean) : []);
const ONLY = words(opt('only'));
const SKIP = words(opt('skip'));
const JOBS = Math.max(1, Math.min(8, Number(opt('jobs')) || 1));

// --- discovery -----------------------------------------------------------------------------------
const posix = (p) => p.split(sep).join('/');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.out', '.vercel', 'coverage', '.git']);
function files(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name));
      } else out.push(posix(relative(abs, join(d, e.name))));
    }
  };
  walk(abs);
  return out.sort();
}
const has = (p) => existsSync(join(ROOT, p));
const TS_TEST = /\.test\.tsx?$/;
const MJS_TEST = /\.test\.mjs$/;
const topLevel = (f) => !f.includes('/');
// Refused whatever the patterns say: a browser (with a wallet, or driving the dev web), and real money.
const FORBIDDEN = [/^apps\/web\/e2e\/live\/native\//, /^apps\/web\/e2e\/ui\//, /^apps\/executor\/tools\/live-test\//];

export function discover() {
  const suites = [];
  const tsc = (id, cwd, projects) => suites.push({ id, kind: 'tsc', cwd, projects, timeoutMs: 15 * MIN });
  const nodeTest = (id, cwd, list, tsx, timeoutMs = 20 * MIN) => {
    if (list.length) suites.push({ id, kind: 'test', cwd, files: list, tsx, timeoutMs });
  };

  if (has('apps/server/tsconfig.json')) tsc('server-typecheck', 'apps/server', [null]);
  nodeTest('server-tests', 'apps/server', files('apps/server/test').filter((f) => TS_TEST.test(f) && topLevel(f)).map((f) => `test/${f}`), true);

  if (has('apps/executor/tsconfig.json')) tsc('executor-typecheck', 'apps/executor', [null]);
  nodeTest('executor-tests', 'apps/executor', files('apps/executor/test').filter((f) => TS_TEST.test(f) && topLevel(f)).map((f) => `test/${f}`), true);

  for (const name of readdirSync(join(ROOT, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const dir = `packages/${name}`;
    const projects = ['tsconfig.json', 'tsconfig.test.json'].filter((p) => has(`${dir}/${p}`));
    if (projects.length) tsc(`${name}-typecheck`, dir, projects);
    nodeTest(`${name}-tests`, dir, files(`${dir}/test`).filter((f) => TS_TEST.test(f) && topLevel(f)).map((f) => `test/${f}`), true, 15 * MIN);
  }

  if (has('apps/web/tsconfig.json')) tsc('web-typecheck', 'apps/web', [null]);
  nodeTest('web-unit', 'apps/web', files('apps/web/src').filter((f) => TS_TEST.test(f)).map((f) => `src/${f}`), true);
  nodeTest('web-tools', 'apps/web', files('apps/web/tools').filter((f) => MJS_TEST.test(f)).map((f) => `tools/${f}`), false, 5 * MIN);
  if (has('apps/web/e2e/live/tsconfig.json')) tsc('e2e-typecheck', 'apps/web', ['e2e/live']);
  nodeTest('e2e-offline', 'apps/web', files('apps/web/e2e/live').filter((f) => TS_TEST.test(f) && topLevel(f)).map((f) => `e2e/live/${f}`), true);
  if (has('apps/web/e2e/guide/tsconfig.json')) tsc('guide-typecheck', 'apps/web', ['e2e/guide']);
  nodeTest('guide-tests', 'apps/web', files('apps/web/e2e/guide').filter((f) => TS_TEST.test(f) && topLevel(f)).map((f) => `e2e/guide/${f}`), true, 10 * MIN);

  nodeTest('deploy-tests', '.', files('deploy').filter((f) => MJS_TEST.test(f)).map((f) => `deploy/${f}`), false, 15 * MIN);

  for (const s of suites) {
    for (const f of s.files ?? []) {
      const p = posix(join(s.cwd, f)).replace(/^\.\//, '');
      if (FORBIDDEN.some((re) => re.test(p))) throw new Error(`refusing to run ${p}: it is not an offline test`);
    }
  }
  return suites;
}

// --- running -------------------------------------------------------------------------------------
const requireFromRoot = createRequire(join(ROOT, 'package.json'));
function tscBin() {
  try {
    return requireFromRoot.resolve('typescript/bin/tsc');
  } catch {
    throw new Error('typescript is not installed: run npm ci in the repository first');
  }
}

/** Runs one command, its output into the log (and nothing on the screen). */
function exec(cmd, args, cwd, log, timeoutMs) {
  return new Promise((done) => {
    log.write(`$ ${[cmd, ...args].join(' ')}   (in ${cwd})\n`);
    const child = spawn(cmd, args, {
      cwd: join(ROOT, cwd),
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI || '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let tail = '';
    const take = (d) => {
      log.write(d);
      tail = (tail + d).slice(-60_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => take(`\n${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: timedOut ? null : code, timedOut, tail });
    });
  });
}

/** node:test's own totals at the end of the spec output: "ℹ tests 12", "ℹ fail 0". */
export function parseTotals(text) {
  const t = {};
  for (const m of text.matchAll(/^\S*\s*(tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) t[m[1]] = Number(m[2]);
  return t;
}

/** The names of failed tests in spec output ("✖ name (12ms)"), without the summary repeat. */
export function failedNames(text) {
  const names = [];
  for (const m of text.matchAll(/^\s*✖ (.+?)(?: \(\d[\d.]*m?s\))?\s*$/gm)) {
    if (!names.includes(m[1]) && !/^failing tests:?$/.test(m[1])) names.push(m[1]);
  }
  return names.slice(0, 20);
}

async function runSuite(s) {
  mkdirSync(OUT, { recursive: true });
  const logPath = join(OUT, `${s.id}.log`);
  const log = createWriteStream(logPath);
  const t0 = Date.now();
  let ok = true;
  let detail = '';
  let failures = [];
  let tail = '';
  try {
    if (s.kind === 'tsc') {
      for (const p of s.projects) {
        const r = await exec(process.execPath, [tscBin(), '--noEmit', ...(p ? ['-p', p] : [])], s.cwd, log, s.timeoutMs);
        const errors = (r.tail.match(/\berror TS\d+:/g) ?? []).length;
        if (r.code !== 0) {
          ok = false;
          tail = r.tail;
          detail = r.timedOut ? 'timed out' : `${errors || 'some'} type error${errors === 1 ? '' : 's'}${p ? ` in ${p}` : ''}`;
          failures = r.tail.split('\n').filter((l) => /\berror TS\d+:/.test(l)).slice(0, 10).map((l) => l.trim());
          break;
        }
      }
      if (ok) detail = 'no type errors';
    } else {
      const args = [
        ...(s.tsx ? ['--import', 'tsx'] : []),
        '--disable-warning=ExperimentalWarning',
        '--test',
        '--test-reporter=spec',
        ...s.files,
      ];
      const r = await exec(process.execPath, args, s.cwd, log, s.timeoutMs);
      const totals = parseTotals(r.tail);
      tail = r.tail;
      const count = `${totals.pass ?? 0} passed, ${totals.fail ?? 0} failed${totals.skipped ? `, ${totals.skipped} skipped` : ''}${totals.todo ? `, ${totals.todo} todo` : ''}`;
      if (r.timedOut) {
        ok = false;
        detail = `timed out after ${Math.round(s.timeoutMs / MIN)} min`;
      } else if (r.code !== 0 || (totals.fail ?? 0) > 0 || (totals.cancelled ?? 0) > 0) {
        ok = false;
        detail = `${count}${totals.cancelled ? `, ${totals.cancelled} cancelled` : ''} (exit ${r.code})`;
        failures = failedNames(r.tail);
      } else if (!totals.tests) {
        ok = false;
        detail = 'no test ran';
      } else detail = `${count} (${s.files.length} file${s.files.length === 1 ? '' : 's'})`;
    }
  } catch (e) {
    ok = false;
    detail = String(e?.message ?? e);
  }
  await new Promise((r) => log.end(r));
  return { id: s.id, ok, detail, failures, ms: Date.now() - t0, log: posix(relative(ROOT, logPath)), tail };
}

// --- main ----------------------------------------------------------------------------------------
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let suites = discover();
  const match = (s, list) => list.some((w) => s.id.includes(w));
  if (ONLY.length) suites = suites.filter((s) => match(s, ONLY));
  if (SKIP.length) suites = suites.filter((s) => !match(s, SKIP));
  if (opt('no-typecheck')) suites = suites.filter((s) => s.kind !== 'tsc');
  if (opt('list')) {
    for (const s of suites) console.log(`${s.id.padEnd(24)} ${s.kind === 'tsc' ? `tsc ${s.projects.map((p) => p ?? 'tsconfig.json').join(', ')}` : `${s.files.length} test files`}  (${s.cwd})`);
    process.exit(0);
  }
  if (!suites.length) {
    console.error('run-tests: no suite matched');
    process.exit(2);
  }
  const fmt = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
  console.log(`run-tests: ${suites.length} suites, ${JOBS} at a time; logs in deploy/.out/ci/`);
  const t0 = Date.now();
  const results = new Array(suites.length);
  let next = 0;
  const worker = async () => {
    while (next < suites.length) {
      const i = next++;
      const r = await runSuite(suites[i]);
      results[i] = r;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(24)} ${fmt(r.ms).padStart(10)}  ${r.detail}`);
      if (!r.ok) {
        for (const f of r.failures) console.log(`        x ${f}`);
        if (process.env.CI_PRINT_TAIL !== '0') {
          console.log(`        --- the last lines of ${r.log} ---`);
          for (const l of r.tail.split('\n').slice(-40)) console.log(`        ${l}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, suites.length) }, worker));
  const failed = results.filter((r) => !r.ok);
  const total = Date.now() - t0;
  console.log(`run-tests: ${failed.length ? 'FAILED' : 'all passed'} - ${results.length - failed.length} of ${results.length} suites passed in ${fmt(total)}${failed.length ? `; failed: ${failed.map((r) => r.id).join(', ')}` : ''}`);
  const json = opt('json');
  if (typeof json === 'string') {
    writeFileSync(json, JSON.stringify({ ok: !failed.length, ms: total, suites: results.map(({ tail, ...r }) => r) }, null, 2));
  }
  process.exitCode = failed.length ? 1 : 0;
}
