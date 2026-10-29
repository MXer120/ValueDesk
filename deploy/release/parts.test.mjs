// node --test deploy/release/parts.test.mjs
//
// ship.sh's parts (parts.mjs): which services run a changed file - by the import graph of
// each entry point, type-only imports left out - and what ships nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classify, dependencyParts, importsOf, lockClosure, packageOf, partsOf, reach, resolve, specifiers } from './parts.mjs';

test('the imports that ship code: values, side effects, dynamic and worker URLs - not type-only ones', () => {
  const text = [
    "import { a } from './a.js';",
    "import type { T } from './types.js';",
    "export type { U } from './u.js';",
    "import { type V, type W as X } from './v.js';",
    "import { type Y, z } from './mixed.js';",
    "export * from './all.js';",
    "import './side.js';",
    "const m = await import('./lazy.js');",
    "new Worker(new URL('./worker.ts', import.meta.url));",
    "import fastify from 'fastify';",
  ].join('\n');
  assert.deepEqual(specifiers(text).sort(), ['./a.js', './all.js', './lazy.js', './mixed.js', './side.js', './worker.ts', 'fastify'].sort());
});

test('resolving: .js to .ts, index files, the web aliases; a package from node_modules is none of ours', () => {
  const files = new Set(['apps/server/src/a.ts', 'apps/server/src/ops/index.ts', 'apps/web/src/App.tsx', 'packages/sodex-core/src/index.ts']);
  assert.equal(resolve('apps/server/src/index.ts', './a.js', files), 'apps/server/src/a.ts');
  assert.equal(resolve('apps/server/src/index.ts', './ops', files), 'apps/server/src/ops/index.ts');
  assert.equal(resolve('apps/web/src/main.tsx', './App', files), 'apps/web/src/App.tsx');
  assert.equal(resolve('apps/web/src/x.ts', '@sign/a.js', files), 'apps/server/src/a.ts');
  assert.equal(resolve('apps/web/src/x.ts', '@sodex-core', files), 'packages/sodex-core/src/index.ts');
  assert.equal(resolve('apps/server/src/index.ts', 'fastify', files), null);
});

test('the API does not take the indexer worker it only starts when it runs alone', () => {
  const src = {
    'apps/server/src/index.ts': "import './read.js';\nconst h = await import('./indexer/host.js');",
    'apps/server/src/read.ts': "import { RATE } from './indexer/shared.js';",
    'apps/server/src/indexer/host.ts': "import './engine.js';",
    'apps/server/src/indexer/engine.ts': '',
    'apps/server/src/indexer/shared.ts': '',
  };
  const files = new Set(Object.keys(src));
  const api = reach(['apps/server/src/index.ts'], files, (f) => src[f]);
  assert.ok(api.has('apps/server/src/indexer/shared.ts'), 'a value it imports');
  assert.ok(!api.has('apps/server/src/indexer/engine.ts'), 'not through host.ts');
});

test('by part: graphs first, then the folder; dependencies every service; bin and infra apart; tests and docs nothing', () => {
  const graphs = {
    api: new Set(['apps/server/src/routes/a.ts', 'apps/server/src/shared.ts']),
    indexer: new Set(['apps/server/src/indexer/engine.ts', 'apps/server/src/shared.ts']),
    executor: new Set(['apps/executor/src/main.ts', 'packages/copy-engine/src/index.ts']),
    web: new Set(['apps/web/src/App.tsx']),
  };
  const { parts, ignored } = classify([
    'apps/server/src/routes/a.ts', 'apps/server/src/indexer/engine.ts', 'apps/server/src/shared.ts', 'apps/server/src/orphan.ts',
    'packages/copy-engine/src/index.ts', 'apps/web/src/App.tsx', 'apps/web/index.html', 'package-lock.json',
    'deploy/server/bin/release.sh', 'deploy/server/bin/release.test.mjs', 'deploy/server/units/valuescan-api.service',
    'apps/server/test/a.test.ts', 'docs/x.md', 'ROADMAP.md', 'deploy/release/ship.sh',
    'deploy/vercel/api-proxy.cjs', 'deploy/vercel/vercel.test.mjs',
  ], graphs);
  assert.deepEqual(parts.api, ['apps/server/src/routes/a.ts', 'apps/server/src/shared.ts', 'apps/server/src/orphan.ts', 'package-lock.json']);
  assert.deepEqual(parts.indexer, ['apps/server/src/indexer/engine.ts', 'apps/server/src/shared.ts', 'apps/server/src/orphan.ts', 'package-lock.json']);
  assert.deepEqual(parts.executor, ['packages/copy-engine/src/index.ts', 'package-lock.json']);
  assert.deepEqual(parts.web, ['apps/web/src/App.tsx', 'apps/web/index.html', 'package-lock.json', 'deploy/vercel/api-proxy.cjs'], 'the Vercel function ships with the web');
  assert.deepEqual(parts.bin, ['deploy/server/bin/release.sh']);
  assert.deepEqual(parts.infra, ['deploy/server/units/valuescan-api.service']);
  assert.deepEqual(ignored.sort(), ['ROADMAP.md', 'apps/server/test/a.test.ts', 'deploy/release/ship.sh', 'deploy/server/bin/release.test.mjs', 'deploy/vercel/vercel.test.mjs', 'docs/x.md'].sort());
});

const GIT = spawnSync('git', ['--version']).status === 0 ? false : 'needs git';

test('from two commits of a repository: an indexer-only change is the indexer only', { skip: GIT }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'parts-'));
  const run = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const put = (f, t) => { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), t); };
  try {
    run('init', '-q');
    put('apps/server/src/index.ts', "import './routes.js';\nimport type { S } from './indexer/plan.js';");
    put('apps/server/src/routes.ts', '');
    put('apps/server/src/indexer/main.ts', "import './plan.js';");
    put('apps/server/src/indexer/plan.ts', 'export const A = 1;');
    put('apps/web/src/main.tsx', "import type { S } from '@sign/indexer/plan.js';");
    run('add', '.');
    run('commit', '-q', '-m', 'one');
    put('apps/server/src/indexer/plan.ts', 'export const A = 2;');
    run('commit', '-q', '-am', 'two');
    const cwd = process.cwd();
    process.chdir(dir);
    let r;
    try { r = partsOf('HEAD~1', 'HEAD'); } finally { process.chdir(cwd); }
    assert.equal(r.changed, 1);
    assert.deepEqual(r.parts.indexer, ['apps/server/src/indexer/plan.ts']);
    assert.deepEqual(r.parts.api, [], 'a type-only import ships nothing');
    assert.deepEqual(r.parts.web, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- dependencies: a part only when what it runs on changed ----------------------------------

const LOCK = (o = {}) => ({
  name: 'valuescan', lockfileVersion: 3,
  packages: {
    '': { workspaces: ['apps/server', 'apps/web'], devDependencies: { concurrently: '^9.1.0' } },
    'apps/server': { dependencies: { fastify: '^5.0.0', '@noble/hashes': '^2.0.0' }, devDependencies: { tsx: '^4.19.0' } },
    'apps/web': { dependencies: { react: '^18.3.1' }, devDependencies: { vite: '^6.0.0' } },
    'node_modules/fastify': { version: '5.0.0', dependencies: { avvio: '^9.0.0' } },
    'node_modules/avvio': { version: '9.0.0' },
    'node_modules/react': { version: '18.3.1' },
    'node_modules/vite': { version: '6.0.0' },
    'node_modules/tsx': { version: '4.19.0' },
    'node_modules/ws': { version: '8.18.0' },
    'node_modules/concurrently': { version: '9.1.0' },
    'node_modules/@noble/hashes': { version: '1.6.1' },
    'apps/server/node_modules/@noble/hashes': { version: '2.0.0' },
    'node_modules/@valuescan/server': { resolved: 'apps/server', link: true },
    ...o,
  },
});
const CTX = {
  graphs: {
    api: new Set(['apps/server/src/index.ts']),
    indexer: new Set(['apps/server/src/indexer/main.ts']),
    executor: new Set(['apps/executor/src/main.ts']),
    web: new Set(['apps/web/src/main.tsx', 'apps/server/src/ops/statusModel.ts']),
  },
  imports: {
    api: [['apps/server/src', 'fastify'], ['apps/server/src', '@noble/hashes']],
    indexer: [['apps/server/src/indexer', '@noble/hashes']],
    executor: [['apps/executor/src', 'ws'], ['apps/executor/src', '@noble/hashes']],
    web: [['apps/web/src', 'react']],
  },
  webDevRoots: [['', 'concurrently'], ['apps/web', 'vite'], ['apps/web', 'playwright-core']],
  lockChanged: true,
};
const J = (v) => JSON.stringify(v);
const lockParts = (to) => dependencyParts('package-lock.json', J(LOCK()), J(to), CTX);

test('the lockfile: only the parts that resolve a changed entry - a web devDependency is the web alone', () => {
  assert.deepEqual(lockParts(LOCK({ 'node_modules/playwright-core': { version: '1.64.1', dev: true } })), ['web'], 'playwright-core: never the indexer or the executor');
  assert.deepEqual(lockParts(LOCK({ 'node_modules/avvio': { version: '9.0.1' } })), ['api'], 'a server dependency, through fastify: the part that imports it');
  assert.deepEqual(lockParts(LOCK({ 'node_modules/tsx': { version: '4.20.0' } })), ['api', 'indexer', 'executor'], 'tsx: every process that runs through it');
  assert.deepEqual(lockParts(LOCK({ 'apps/server/node_modules/@noble/hashes': { version: '2.0.1' } })), ['api', 'indexer'], "the server's own nested copy, not the executor's hoisted one");
  assert.deepEqual(lockParts(LOCK({ 'node_modules/@noble/hashes': { version: '1.6.2' } })), ['executor']);
  assert.deepEqual(lockParts(LOCK({ 'node_modules/vite': { version: '6.0.1' } })), ['web'], 'the web builds with its devDependencies');
  assert.deepEqual(lockParts(LOCK({ 'node_modules/left-pad': { version: '1.3.0' } })), [], 'a package nothing runs on');
  assert.deepEqual(dependencyParts('package-lock.json', '{not json', J(LOCK()), CTX), ['web', 'api', 'indexer', 'executor'], 'unreadable: every service');
  // The closure itself: a root, its dependencies, a link followed to a workspace's own entry.
  assert.deepEqual([...lockClosure(LOCK(), [['apps/server/src', 'fastify']])].sort(), ['node_modules/avvio', 'node_modules/fastify']);
  assert.deepEqual([...lockClosure(LOCK(), [['apps/web/src', '@valuescan/server']])].sort(), ['apps/server', 'apps/server/node_modules/@noble/hashes', 'node_modules/@valuescan/server', 'node_modules/avvio', 'node_modules/fastify'].sort());
});

test("a package.json: scripts change nothing; module fields its folder's parts; dependencies as the lockfile says", () => {
  const root = { name: 'valuescan', workspaces: ['apps/server', 'apps/web'], scripts: { dev: 'x' }, devDependencies: { concurrently: '^9.1.0' } };
  const at = (f, a, b, ctx = CTX) => dependencyParts(f, J(a), J(b), ctx);
  assert.deepEqual(at('package.json', root, { ...root, scripts: { dev: 'x', 'live-tests': 'node all.ts' } }), [], 'a scripts-only change restarts nothing');
  assert.deepEqual(at('package.json', root, { ...root, overrides: { axios: '^1.20.0' } }), ['web', 'api', 'indexer', 'executor']);
  const server = { name: '@valuescan/server', type: 'module', dependencies: { fastify: '^5.0.0' }, devDependencies: { tsx: '^4.19.0' } };
  assert.deepEqual(at('apps/server/package.json', server, { ...server, type: 'commonjs' }), ['web', 'api', 'indexer'], 'every part that runs files of apps/server (the web through @sign)');
  assert.deepEqual(at('apps/server/package.json', server, { ...server, dependencies: { fastify: '^5.1.0' } }), [], "what is installed is the lockfile's to say");
  assert.deepEqual(at('apps/server/package.json', server, { ...server, dependencies: { fastify: '^5.1.0' } }, { ...CTX, lockChanged: false }), ['web', 'api', 'indexer'], 'no lockfile change with it (out of step): its parts');
  const web = { name: '@valuescan/web', devDependencies: { vite: '^6.0.0' } };
  assert.deepEqual(at('apps/web/package.json', web, { ...web, devDependencies: { vite: '^6.0.0', 'playwright-core': '1.64.1' } }, { ...CTX, lockChanged: false }), ['web'], "devDependencies: the web's only");
  assert.deepEqual(at('apps/server/package.json', server, { ...server, devDependencies: { tsx: '^4.20.0' } }, { ...CTX, lockChanged: false }), [], "another workspace's devDependencies: the lockfile decides");
  assert.deepEqual(dependencyParts('apps/web/package.json', null, J(web), CTX), ['web', 'api', 'indexer', 'executor'], 'added or removed: every service');
  // classify keeps a dependency file no part needs among what ships nothing; one it was not told about is every service's.
  const c = classify(['package.json', 'package-lock.json'], CTX.graphs, { 'package.json': [], 'package-lock.json': ['web'] });
  assert.deepEqual([c.parts.web, c.parts.api, c.ignored], [['package-lock.json'], [], ['package.json']]);
  assert.deepEqual(classify(['package-lock.json'], CTX.graphs).parts.indexer, ['package-lock.json']);
});

test('the npm packages a part imports: bare specifiers of its files, with their folder; builtins and our own files are none', () => {
  const src = {
    'apps/server/src/index.ts': [
      "import Fastify from 'fastify';", "import { x } from './a.js';", "import { readFileSync } from 'node:fs';", "import path from 'path';",
      "import { h } from '@noble/hashes/sha2';", "import type { T } from 'zod';", "import { s } from '@sodex-core';",
    ].join('\n'),
    'apps/server/src/a.ts': '',
    'packages/sodex-core/src/index.ts': '',
  };
  const files = new Set(Object.keys(src));
  assert.deepEqual(importsOf(files, files, (f) => src[f]).map(([d, n]) => `${d} ${n}`).sort(), ['apps/server/src @noble/hashes', 'apps/server/src fastify']);
  assert.equal(packageOf('@scope/name/deep/x'), '@scope/name');
  assert.equal(packageOf('react-dom/client'), 'react-dom');
  assert.equal(packageOf('node:crypto'), null);
  assert.equal(packageOf('fs/promises'), null);
});

test('from commits: a scripts-only change, a web devDependency and a server dependency', { skip: GIT }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'parts-deps-'));
  const run = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const put = (f, t) => { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), typeof t === 'string' ? t : JSON.stringify(t, null, 2)); };
  const parts = (from) => {
    const cwd = process.cwd();
    process.chdir(dir);
    try { return partsOf(from, 'HEAD'); } finally { process.chdir(cwd); }
  };
  const names = (r) => Object.fromEntries(['web', 'api', 'indexer', 'executor'].map((p) => [p, r.parts[p]]));
  try {
    run('init', '-q');
    const root = { name: 'v', private: true, workspaces: ['apps/server', 'apps/web'], scripts: { dev: 'x' } };
    const server = { name: '@v/server', type: 'module', dependencies: { fastify: '^5.0.0' }, devDependencies: { tsx: '^4.19.0' } };
    const web = { name: '@v/web', dependencies: { react: '^18.3.1' }, devDependencies: { vite: '^6.0.0' } };
    put('package.json', root);
    put('apps/server/package.json', server);
    put('apps/web/package.json', web);
    put('package-lock.json', LOCK());
    put('apps/server/src/index.ts', "import Fastify from 'fastify';");
    put('apps/server/src/indexer/main.ts', "import { readFileSync } from 'node:fs';");
    put('apps/web/src/main.tsx', "import React from 'react';");
    put('apps/executor/src/main.ts', "import WebSocket from 'ws';");
    run('add', '.');
    run('commit', '-q', '-m', 'one');

    put('package.json', { ...root, scripts: { dev: 'x', 'live-tests': 'node --import tsx all.ts' } });
    run('commit', '-q', '-am', 'scripts');
    const a = parts('HEAD~1');
    assert.deepEqual(names(a), { web: [], api: [], indexer: [], executor: [] }, 'a scripts-only change restarts nothing');
    assert.deepEqual(a.ignored, ['package.json']);

    put('apps/web/package.json', { ...web, devDependencies: { vite: '^6.0.0', 'playwright-core': '1.64.1' } });
    put('package-lock.json', LOCK({ 'node_modules/playwright-core': { version: '1.64.1', dev: true } }));
    run('commit', '-q', '-am', 'web dev dependency');
    assert.deepEqual(names(parts('HEAD~1')), { web: ['package-lock.json'], api: [], indexer: [], executor: [] }, 'a web devDependency: the web alone');

    put('apps/server/package.json', { ...server, dependencies: { fastify: '^5.1.0' } });
    put('package-lock.json', LOCK({ 'node_modules/playwright-core': { version: '1.64.1', dev: true }, 'node_modules/fastify': { version: '5.1.0', dependencies: { avvio: '^9.0.0' } } }));
    run('commit', '-q', '-am', 'server dependency');
    assert.deepEqual(names(parts('HEAD~1')), { web: [], api: ['package-lock.json'], indexer: [], executor: [] }, 'fastify: the API, which imports it - not the indexer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
