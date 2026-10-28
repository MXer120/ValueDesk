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
import { classify, partsOf, reach, resolve, specifiers } from './parts.mjs';

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
  ], graphs);
  assert.deepEqual(parts.api, ['apps/server/src/routes/a.ts', 'apps/server/src/shared.ts', 'apps/server/src/orphan.ts', 'package-lock.json']);
  assert.deepEqual(parts.indexer, ['apps/server/src/indexer/engine.ts', 'apps/server/src/shared.ts', 'apps/server/src/orphan.ts', 'package-lock.json']);
  assert.deepEqual(parts.executor, ['packages/copy-engine/src/index.ts', 'package-lock.json']);
  assert.deepEqual(parts.web, ['apps/web/src/App.tsx', 'apps/web/index.html', 'package-lock.json']);
  assert.deepEqual(parts.bin, ['deploy/server/bin/release.sh']);
  assert.deepEqual(parts.infra, ['deploy/server/units/valuescan-api.service']);
  assert.deepEqual(ignored.sort(), ['ROADMAP.md', 'apps/server/test/a.test.ts', 'deploy/release/ship.sh', 'deploy/server/bin/release.test.mjs', 'docs/x.md'].sort());
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
