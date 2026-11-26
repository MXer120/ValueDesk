/**
 * cssOrder.ts must list every stylesheet the app imports: a sheet missing from
 * it would be emitted with its lazily loaded page instead of in the one
 * up-front stylesheet, and land at the end of the cascade (see cssOrder.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const IMPORT_RE = /^\s*import\s+['"]([^'"]+\.css)['"]\s*;?/gm;

/** Stylesheets that are NOT meant to be in the list, and why. */
const EXEMPT = new Set([
  'styles.css', // main.tsx imports it last, after App
  'theme-light.css', // main.tsx, right after styles.css: its selectors outrank :root, whatever the order
  'chart/tv/tv.css', // the optional TradingView chart loads its own sheets on demand
  'chart/tv/tv-theme.css',
  // The landing pages (/home...): each loads its own sheets with its chunk, so the app's visitors never download them; every rule starts at the pages' own roots and classes.
  'components/landing/home.css',
  'components/landing/site/site.css',
  'components/landing/site/pages.css',
  'components/landing/v2/v2.css',
  'components/landing/v3/v3.css',
  'components/landing/site/appDesk.css',
  'components/landing/v4/v4.css',
  'legal/legal.css', // loads with the legal pages; only `.legal*` selectors (see below)
  // The trade page's and the layout editor's versions (localhost only): imported by dashboard/versions/devVersions.tsx
  // alone, which only a DEV server loads (dashboard/versions/dev.ts) - a build never emits them. Every rule is scoped to
  // a version's own class or state (`html[data-tv]`, `.tv-*`, `.ed-*`, `.is-edit-v`, `.pdk`, `.pls-*`, `.tvswitch`), so their late
  // place in the cascade can only ever reach what a version draws.
  'dashboard/versions/versionSwitch.css',
  'dashboard/versions/pages/slate.css',
  'dashboard/versions/pages/deck.css',
  'dashboard/versions/pages/pulse.css',
  'dashboard/versions/editors/editors.css',
  'dashboard/versions/editors/studio.css',
  'dashboard/versions/editors/board.css',
]);

test('legal.css only styles the legal pages, so it may load with them', () => {
  const css = readFileSync(join(SRC, 'legal', 'legal.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@[^{]+\{/g, ''); // at-rule preludes (@media ...): their rules are checked like any other
  const selectors = [...css.matchAll(/([^{}@]+)\{/g)]
    .map((m) => m[1]!.trim())
    .filter((s) => s && !/^(?:from|to|\d+%)$/.test(s));
  assert.ok(selectors.length > 5, 'the selectors were read');
  for (const group of selectors) {
    for (const sel of group.split(',')) {
      assert.match(sel.trim(), /^\.legal[\w-]*\b/, `"${sel.trim()}" must start at a .legal* class`);
    }
  }
});

/* Value imports only: `import type` / `export type` are erased and load nothing. */
const SPEC_RE = /(?:^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\s+from\s+)?|import\(\s*)['"](\.[^'"]+)['"]/gm;
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Every module the app can load (static and dynamic imports) from main.tsx. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(SPEC_RE)) {
      if (m[1]!.endsWith('.css')) continue;
      const base = resolve(dirname(f), m[1]!);
      const hit = EXTS.map((e) => base + e).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
      if (hit) stack.push(hit);
    }
  }
  return [...seen];
}

/** A CSS import as a src-relative path, or the bare package specifier. */
function key(fromFile: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  return relative(SRC, resolve(dirname(fromFile), spec)).replace(/\\/g, '/');
}

const orderFile = join(SRC, 'cssOrder.ts');
const listed = [...readFileSync(orderFile, 'utf8').matchAll(IMPORT_RE)].map((m) => key(orderFile, m[1]!));

test('cssOrder.ts lists each stylesheet once', () => {
  assert.ok(listed.length > 20, 'the list was read');
  assert.equal(new Set(listed).size, listed.length, `duplicates: ${listed.filter((k, i) => listed.indexOf(k) !== i).join(', ')}`);
});

test('every stylesheet the app imports is in cssOrder.ts', () => {
  const missing = new Set<string>();
  for (const file of reachable(join(SRC, 'main.tsx'))) {
    if (file === orderFile) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const k = key(file, m[1]!);
      if (k.startsWith('@fontsource/') || EXEMPT.has(k)) continue;
      if (!listed.includes(k)) missing.add(`${k} (imported by ${relative(SRC, file).replace(/\\/g, '/')})`);
    }
  }
  assert.deepEqual([...missing], [], 'add these to cssOrder.ts at the position of their first import');
});

test('every listed stylesheet exists', () => {
  for (const k of listed) {
    if (!k.includes('/') || k.startsWith('react-')) continue; // package sheets resolve through node_modules
    assert.ok(statSync(join(SRC, k)).isFile(), `${k} does not exist`);
  }
});
