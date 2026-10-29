#!/usr/bin/env node
// deploy/release/parts.mjs - which parts of ValueDesk a range of commits changes, for ship.sh.
//
//   node deploy/release/parts.mjs --from=v0.2.56 [--to=HEAD] [--json]
//
// The parts: web (Vercel), api and indexer (server 1), executor (server 2), bin (the
// operations scripts in /opt/valuescan/bin on both servers) and infra (units, Caddy, env
// templates, bootstrap: these need bootstrap-instance.sh, never a plain release).
//
// A changed source file belongs to a service when that service's entry point imports it,
// directly or through other files: the import graph is read from the TO commit (git, not
// the working tree), following relative imports, the web's aliases (@sign, @sodex-core,
// @copy-engine), dynamic import('...') with a plain string and new URL('...', import.meta.url).
// So a change to indexer/cohortTracker.ts restarts the indexer, not the API; a change to
// a file both import restarts both. Anything it cannot place is given to every service
// of its folder - restarting one too many is cheap, one too few ships code that does not run.
// Tests, docs and notes ship nothing. Dependencies (a package.json or the lockfile) are
// every service's.
//
// Exit code: 0, or 2 when git cannot answer (a ref that does not exist).
import { execFileSync, spawnSync } from 'node:child_process';
import { posix as path } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENTRIES = {
  api: ['apps/server/src/index.ts'],
  indexer: ['apps/server/src/indexer/main.ts'],
  executor: ['apps/executor/src/main.ts'],
  web: ['apps/web/src/main.tsx'],
};

// Edges production never takes. The API starts the indexer on a worker thread only when it
// runs alone (index.ts, VALUESCAN_INDEXER unset); the servers run the indexer as its own
// unit and set VALUESCAN_INDEXER=0 for the API (deploy/server/env/api.env.example).
// Without this every indexer file would restart the API too.
export const SKIP_EDGES = new Set(['apps/server/src/index.ts -> apps/server/src/indexer/host.ts']);

const ALIASES = [
  ['@sign/', 'apps/server/src/'],
  ['@sodex-core', 'packages/sodex-core/src/index.ts'],
  ['@copy-engine', 'packages/copy-engine/src/index.ts'],
];

const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const FROM = /\b(import|export)\s+([^'";]*?)\bfrom\s*['"]([^'"]+)['"]/g;
const SPEC = [
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

/** `import type ...`, `export type ...`, or braces of nothing but `type X`: erased by the compiler, it ships no code. */
const typeOnly = (clause) => /^type[\s{*]/.test(clause) || /^\{\s*(type\s+[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*)+\}$/.test(clause.trim());

/** The specifiers of the imports in one file's text that ship code (type-only imports leave none). */
export function specifiers(text) {
  const out = new Set();
  for (const m of text.matchAll(FROM)) if (!typeOnly(m[2])) out.add(m[3]);
  for (const re of SPEC) for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** The file a specifier names, among `files` (a Set of repository paths); null for a package from node_modules. */
export function resolve(from, spec, files) {
  let base = null;
  if (spec.startsWith('.')) base = path.normalize(path.join(path.dirname(from), spec));
  else {
    for (const [a, to] of ALIASES) {
      if (spec === a.replace(/\/$/, '') || spec.startsWith(a)) { base = a.endsWith('/') ? to + spec.slice(a.length) : to; break; }
    }
  }
  if (base === null) return null;
  const stem = base.replace(/\.(js|mjs|jsx)$/, '');
  const tries = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.json`, `${base}/index.ts`, `${base}/index.tsx`];
  return tries.find((t) => files.has(t)) ?? null;
}

/** Every file reachable from the entries. `read(path)` gives a file's text. */
export function reach(entries, files, read) {
  const seen = new Set();
  const todo = entries.filter((e) => files.has(e));
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!SOURCE.test(f)) continue;
    for (const s of specifiers(read(f))) {
      const r = resolve(f, s, files);
      if (r && !seen.has(r) && !SKIP_EDGES.has(`${f} -> ${r}`)) todo.push(r);
    }
  }
  return seen;
}

const IGNORED = [
  /\.md$/i, /^docs\//, /(^|\/)test\//, /\.test\.[a-z]+$/, /^\.github\//, /^\.claude\//, /^research_notes\//, /^reports\//,
  /^inspimages\//, /^contracts\//, /(^|\/)\.gitignore$/, /^apps\/web\/e2e\//, /^apps\/web\/tools\//, /^apps\/server\/tools\//,
  /^apps\/executor\/tools\//, /^deploy\/(release|ci|aws|\.out)\//,
];
const DEPS = /^(package-lock\.json|package\.json|apps\/[^/]+\/package\.json|packages\/[^/]+\/package\.json)$/;

/**
 * The parts each changed path belongs to. `graphs` maps a service to the Set of files its
 * entry reaches; `ignored` collects what ships nothing.
 */
export function classify(changed, graphs) {
  const parts = { web: [], api: [], indexer: [], executor: [], bin: [], infra: [] };
  const ignored = [];
  const add = (p, f) => parts[p].push(f);
  for (const f of changed) {
    if (DEPS.test(f)) { for (const p of ['web', 'api', 'indexer', 'executor']) add(p, f); continue; }
    if (/^deploy\/server\/bin\//.test(f)) { if (/\.test\.[a-z]+$/.test(f)) ignored.push(f); else add('bin', f); continue; }
    if (/^deploy\/server\//.test(f)) { add('infra', f); continue; }
    // The Vercel function and its config ship with every web deploy: the web's.
    if (/^deploy\/vercel\//.test(f) && !/\.test\.[a-z]+$/.test(f)) { add('web', f); continue; }
    if (IGNORED.some((re) => re.test(f))) { ignored.push(f); continue; }
    let placed = false;
    for (const p of ['api', 'indexer', 'executor', 'web']) if (graphs[p]?.has(f)) { add(p, f); placed = true; }
    if (placed) continue;
    // Not reached from any entry: by its folder, every service that could run it.
    if (/^apps\/web\//.test(f)) add('web', f);
    else if (/^apps\/server\//.test(f)) { add('api', f); add('indexer', f); }
    else if (/^(apps\/executor|packages\/(copy-engine|sodex-core))\//.test(f)) add('executor', f);
    else ignored.push(f);
  }
  return { parts, ignored };
}

function git(args, input) {
  const r = spawnSync('git', args, { encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The files of a commit and a reader for their text (one git cat-file for all of them). */
export function treeOf(ref) {
  const rows = git(['ls-tree', '-r', '-z', ref]).split('\0').filter(Boolean);
  const blob = new Map();
  for (const row of rows) {
    const tab = row.indexOf('\t');
    const [, type, sha] = row.slice(0, tab).split(' ');
    if (type === 'blob') blob.set(row.slice(tab + 1), sha);
  }
  const files = new Set(blob.keys());
  const wanted = [...files].filter((f) => SOURCE.test(f) && /^(apps|packages)\//.test(f));
  const text = new Map();
  if (wanted.length) {
    const out = execFileSync('git', ['cat-file', '--batch'], { input: wanted.map((f) => blob.get(f)).join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024 });
    let at = 0;
    for (const f of wanted) {
      const nl = out.indexOf(10, at);
      const size = Number(out.subarray(at, nl).toString('latin1').split(' ')[2]);
      text.set(f, out.subarray(nl + 1, nl + 1 + size).toString('utf8'));
      at = nl + 1 + size + 1;
    }
  }
  return { files, read: (f) => text.get(f) ?? '' };
}

export function partsOf(from, to = 'HEAD') {
  const changed = git(['diff', '--name-only', '-z', `${from}..${to}`]).split('\0').filter(Boolean);
  const { files, read } = treeOf(to);
  const graphs = Object.fromEntries(Object.entries(ENTRIES).map(([p, e]) => [p, reach(e, files, read)]));
  return { from, to, changed: changed.length, ...classify(changed, graphs) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const from = arg('from');
  if (!from) {
    console.error('usage: node deploy/release/parts.mjs --from=<ref> [--to=<ref>] [--json]');
    process.exit(2);
  }
  let r;
  try {
    r = partsOf(from, arg('to') ?? 'HEAD');
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(2);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(r));
  else {
    console.log(`${r.changed} files changed ${r.from}..${r.to}`);
    for (const [p, fs] of Object.entries(r.parts)) console.log(`${p.padEnd(8)} ${fs.length ? `${fs.length}: ${fs.slice(0, 6).join(', ')}${fs.length > 6 ? ', ...' : ''}` : '-'}`);
    if (r.ignored.length) console.log(`nothing  ${r.ignored.length} (tests, docs, tooling)`);
  }
}
