// node --test deploy/vercel/web-changed.test.mjs
//
// The Ignored Build Step's question (web-changed.mjs): does a range change what Vercel would build?
// Never "no" where ship.sh's own `web` part (parts.mjs) says yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, reach } from '../release/parts.mjs';
import { ALWAYS, PAGES, pageGraph, webInputs } from './web-changed.mjs';

// A small repository: the site's page imports a shared helper of the server through @sign (run time)
// and the indexer's store only for a type; the admin page imports a server file the site does not.
const TEXT = {
  'apps/web/src/main.tsx': "import { fmt } from '@sign/valuedesk/format.js';\nimport type { Row } from '@sign/indexer/store.js';\n",
  'apps/web/src/admin/main.tsx': "import { signIn } from '@sign/admin/signIn';\n",
  'apps/server/src/valuedesk/format.ts': 'export const fmt = 1;\n',
  'apps/server/src/indexer/store.ts': 'export type Row = { a: 1 };\nexport const x = 1;\n',
  'apps/server/src/admin/signIn.ts': 'export const signIn = 1;\n',
  'apps/server/src/indexer/main.ts': "import { x } from './store.js';\n",
};
const files = new Set(Object.keys(TEXT));
const read = (f) => TEXT[f] ?? '';

test('the graph starts from both pages and follows run-time imports only', () => {
  const g = pageGraph(files, read);
  assert.ok(g.has('apps/server/src/valuedesk/format.ts'), 'run-time import through @sign');
  assert.ok(g.has('apps/server/src/admin/signIn.ts'), 'the admin page is a page of the build too');
  assert.ok(!g.has('apps/server/src/indexer/store.ts'), 'a type-only import ships no code');
  assert.deepEqual(PAGES, ['apps/web/src/main.tsx', 'apps/web/src/admin/main.tsx']);
});

test('server-only, docs and ops changes skip; anything of the site builds', () => {
  const g = pageGraph(files, read);
  for (const f of ['apps/server/src/indexer/store.ts', 'apps/server/src/indexer/main.ts', 'apps/executor/src/service.ts', 'docs/BOTS.md',
    'deploy/server/units/valuescan-api.service', 'deploy/contabo/server1/health.env', 'deploy/release/ship.sh', 'marketing/video/src/Root.tsx']) {
    assert.deepEqual(webInputs([f], g), [], f);
  }
  for (const f of ['apps/web/src/App.tsx', 'apps/web/public/robots.txt', 'apps/web/index.html', 'apps/web/vite.config.ts', 'apps/web/tools/build-admin.mjs',
    'packages/sodex-core/src/index.ts', 'deploy/vercel/api-proxy.cjs', 'deploy/vercel/package.mjs', 'deploy/smoke/prod-headers.mjs',
    'deploy/release/build-web.sh', 'deploy/release/lib.sh', 'vercel.json', 'package-lock.json', 'package.json',
    'apps/server/src/valuedesk/format.ts', 'apps/server/src/admin/signIn.ts']) {
    assert.deepEqual(webInputs([f], g), [f], f);
  }
  assert.deepEqual(webInputs(['apps/web/e2e/ui/a.spec.ts'], g), [], 'the browser tests are not built');
});

test('never narrower than ship.sh: every file parts.mjs gives the web is an input here', () => {
  const graphs = { web: reach(['apps/web/src/main.tsx'], files, read), api: new Set(), indexer: reach(['apps/server/src/indexer/main.ts'], files, read) };
  const changed = [...files, 'apps/web/public/x.svg', 'deploy/vercel/routes.mjs', 'apps/web/src/a.test.ts'];
  const shipWeb = classify(changed, graphs).parts.web;
  const ours = new Set(webInputs(changed, pageGraph(files, read)));
  for (const f of shipWeb) assert.ok(ours.has(f), `${f}: ship.sh waits for a build of it`);
  assert.ok(ALWAYS.length > 0);
});
