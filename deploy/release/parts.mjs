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
// Tests, docs and notes ship nothing.
//
// DEPENDENCIES are a part's only when what it runs on changed (owner, 2026-10-29: no restart
// for a package nothing of it uses):
//  - package-lock.json: an entry the part resolves changed - the packages its files import
//    (bare specifiers of every file its entry reaches, type-only imports left out), tsx for
//    the server's processes (they run through it), the web's own devDependencies (it builds
//    with them), and everything those need, followed through the lockfile in both commits.
//    So a devDependency of the web (playwright-core) plans the web alone.
//  - a package.json: its MODULE_FIELDS (type, exports, main, imports, workspaces, overrides)
//    for every part that runs files of its folder (the root's: every part). Its dependency
//    fields (and devDependencies, the web's only: of the root or apps/web) are what the
//    lockfile installs: they go by the lockfile above when it changed too, else - a lockfile
//    out of step, which npm ci refuses - to those parts. Scripts and the rest: none.
// Anything it cannot read (a file added or removed, not JSON) is every service's.
//
// Exit code: 0, or 2 when git cannot answer (a ref that does not exist).
import { execFileSync, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
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
const SERVICES = ['web', 'api', 'indexer', 'executor'];

// --- dependencies (the header: DEPENDENCIES) ---------------------------------------------------

/** The package.json fields that change how a folder's own files load or how the tree is laid out. */
export const MODULE_FIELDS = ['workspaces', 'overrides', 'type', 'main', 'module', 'exports', 'imports', 'browser'];
/** ...and those the lockfile installs (devDependencies: the web's, DEV_FOR_WEB). */
export const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
/** The package.json files whose devDependencies the web builds with. */
const DEV_FOR_WEB = new Set(['package.json', 'apps/web/package.json']);
/** The tools a part's processes run through (apps/server and apps/executor start with --import tsx). */
const TOOLS = { api: [['apps/server', 'tsx']], indexer: [['apps/server', 'tsx']], executor: [['apps/executor', 'tsx']], web: [] };

const BUILTIN = new Set(builtinModules);
/** A specifier's npm package ('@scope/name/x' -> '@scope/name', 'name/x' -> 'name'); null for a builtin. */
export function packageOf(spec) {
  if (spec.startsWith('node:') || BUILTIN.has(spec) || BUILTIN.has(spec.split('/')[0])) return null;
  const [a, b] = spec.split('/');
  return spec.startsWith('@') ? (b ? `${a}/${b}` : null) : a || null;
}

/** The npm packages a part's files import, each with the folder it is imported from: [[dir, name]]. */
export function importsOf(graph, files, read) {
  const out = new Map();
  for (const f of graph) {
    if (!SOURCE.test(f)) continue;
    for (const s of specifiers(read(f))) {
      if (s.startsWith('.') || resolve(f, s, files) !== null || ALIASES.some(([a]) => s === a.replace(/\/$/, '') || s.startsWith(a))) continue;
      const name = packageOf(s);
      if (name) out.set(`${path.dirname(f)}|${name}`, [path.dirname(f), name]);
    }
  }
  return [...out.values()];
}

const parent = (d) => (d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '');

/**
 * The lockfile entries (`packages` keys) that `roots` ([[dir, name]]) resolve to, as Node finds
 * them (the nearest node_modules up from the folder), with everything they depend on; a
 * workspace link followed to its folder's own entry.
 */
export function lockClosure(lock, roots) {
  const pk = lock?.packages ?? {};
  const find = (dir, name) => {
    for (let d = dir; ; d = parent(d)) {
      const k = d ? `${d}/node_modules/${name}` : `node_modules/${name}`;
      if (pk[k]) return k;
      if (!d) return null;
    }
  };
  const out = new Set();
  const todo = roots.map(([dir, name]) => find(dir, name));
  while (todo.length) {
    const k = todo.pop();
    if (!k || out.has(k)) continue;
    out.add(k);
    const e = pk[k];
    if (e.link && typeof e.resolved === 'string') { if (pk[e.resolved]) todo.push(e.resolved); continue; }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const n of Object.keys(e[field] ?? {})) todo.push(find(k, n));
    }
  }
  return out;
}

/** The lockfile entries that differ between two lockfiles: added, removed or changed. */
export function lockChanges(a, b) {
  const pa = a?.packages ?? {}, pb = b?.packages ?? {};
  const out = new Set();
  for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) out.add(k);
  return out;
}

const json = (t) => { try { return t === null ? null : JSON.parse(t); } catch { return undefined; } };
const differ = (a, b, fields) => fields.filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));

/**
 * The parts a changed dependency file is for (DEPENDENCIES above). `from` / `to`: the file's
 * text in each commit (null: not there). `ctx`: the TO commit's graphs, the npm packages each
 * part imports (importsOf), the web's devDependencies ([[dir, name]]) and whether the lockfile
 * changed in the same range.
 */
export function dependencyParts(file, from, to, ctx) {
  const a = json(from), b = json(to);
  if (a === undefined || b === undefined || a === null || b === null) return [...SERVICES];
  if (file === 'package-lock.json') {
    const changed = lockChanges(a, b);
    return SERVICES.filter((p) => {
      const roots = [...(ctx.imports[p] ?? []), ...TOOLS[p], ...(p === 'web' ? ctx.webDevRoots ?? [] : [])];
      return [lockClosure(a, roots), lockClosure(b, roots)].some((c) => [...c].some((k) => changed.has(k)));
    });
  }
  const dir = file === 'package.json' ? '' : file.slice(0, -'/package.json'.length);
  const users = dir === '' ? [...SERVICES] : SERVICES.filter((p) => [...(ctx.graphs[p] ?? [])].some((f) => f.startsWith(`${dir}/`)));
  const out = new Set(differ(a, b, MODULE_FIELDS).length || (!ctx.lockChanged && differ(a, b, DEP_FIELDS).length) ? users : []);
  if (DEV_FOR_WEB.has(file) && !ctx.lockChanged && differ(a, b, ['devDependencies']).length) out.add('web');
  return SERVICES.filter((p) => out.has(p));
}

/**
 * The parts each changed path belongs to. `graphs` maps a service to the Set of files its
 * entry reaches; `ignored` collects what ships nothing. `deps` (dependencyParts): the parts
 * of each changed dependency file; one it does not name is every service's.
 */
export function classify(changed, graphs, deps = {}) {
  const parts = { web: [], api: [], indexer: [], executor: [], bin: [], infra: [] };
  const ignored = [];
  const add = (p, f) => parts[p].push(f);
  for (const f of changed) {
    if (DEPS.test(f)) {
      const ps = deps[f] ?? SERVICES;
      for (const p of ps) add(p, f);
      if (!ps.length) ignored.push(f);
      continue;
    }
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

/** A file's text in a commit; null when it is not there. */
function show(ref, f) {
  const r = spawnSync('git', ['show', `${ref}:${f}`], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

export function partsOf(from, to = 'HEAD') {
  const changed = git(['diff', '--name-only', '-z', `${from}..${to}`]).split('\0').filter(Boolean);
  const { files, read } = treeOf(to);
  const graphs = Object.fromEntries(Object.entries(ENTRIES).map(([p, e]) => [p, reach(e, files, read)]));
  const deps = {};
  const depFiles = changed.filter((f) => DEPS.test(f));
  if (depFiles.length) {
    const imports = Object.fromEntries(SERVICES.map((p) => [p, importsOf(graphs[p], files, read)]));
    const devOf = (f, dir) => Object.keys(json(show(to, f))?.devDependencies ?? {}).map((n) => [dir, n]);
    const ctx = { graphs, imports, lockChanged: changed.includes('package-lock.json'), webDevRoots: [...devOf('package.json', ''), ...devOf('apps/web/package.json', 'apps/web')] };
    for (const f of depFiles) deps[f] = dependencyParts(f, show(from, f), show(to, f), ctx);
  }
  return { from, to, changed: changed.length, ...classify(changed, graphs, deps) };
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
