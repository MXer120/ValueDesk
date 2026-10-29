import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithEsbuild } from 'vite';
import { TEST_BRIDGE_VERSION, createTestBridge, installTestBridge, type VsTestBridge } from './testBridge';

const SRC = dirname(fileURLToPath(import.meta.url));

/** main.tsx as a build compiles it: import.meta.env.DEV replaced by Vite's define, dead branches dropped. */
async function compiledMain(dev: boolean): Promise<string> {
  const file = join(SRC, 'main.tsx');
  const out = await transformWithEsbuild(readFileSync(file, 'utf8'), file, {
    define: { 'import.meta.env.DEV': String(dev) },
    minifySyntax: true,
    jsx: 'automatic',
  });
  return out.code;
}

test('a production build of main.tsx keeps no import of the test bridge', async () => {
  assert.match(await compiledMain(true), /testBridge/, 'the dev server loads it');
  assert.doesNotMatch(await compiledMain(false), /testBridge|__vsTest/, 'the production branch is dropped, and the module with it');
});

test('nothing but main.tsx imports the test bridge', () => {
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|mjs|js)$/.test(e.name) && !/^testBridge(\.test)?\.ts$/.test(e.name)) {
        if (/from\s+['"][./]+(?:[\w/]*\/)?testBridge['"]|import\(\s*['"][./]+(?:[\w/]*\/)?testBridge['"]\s*\)/.test(readFileSync(p, 'utf8'))) {
          importers.push(relative(SRC, p).split(sep).join('/'));
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(importers, ['main.tsx']);
});

test('the bridge installs only on the dev server', () => {
  const prod: { __vsTest?: VsTestBridge } = {};
  assert.equal(installTestBridge(prod, false), false);
  assert.equal(prod.__vsTest, undefined);
  const dev: { __vsTest?: VsTestBridge } = {};
  assert.equal(installTestBridge(dev, true), true);
  assert.equal(dev.__vsTest?.version, TEST_BRIDGE_VERSION);
  const first = dev.__vsTest;
  installTestBridge(dev, true);
  assert.equal(dev.__vsTest, first, 'installed once');
});

test('the seam keeps its shape (version 1): a change here is a new version for the live suite', () => {
  const b = createTestBridge();
  assert.equal(b.version, 1);
  assert.deepEqual(Object.keys(b.algos).sort(), ['cancel', 'cancelAll', 'check', 'events', 'follow', 'list', 'owner', 'pause', 'resume', 'role', 'start', 'update']);
  assert.deepEqual(Object.keys(b.copier).sort(), ['answer', 'confirms', 'events', 'key', 'list', 'owner', 'pause', 'resume', 'role', 'start', 'stop', 'stopAll']);
  for (const fn of [...Object.values(b.algos), ...Object.values(b.copier)]) assert.equal(typeof fn, 'function');
});
