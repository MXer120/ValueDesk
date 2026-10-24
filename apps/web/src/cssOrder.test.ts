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
  'chart/tv/tv.css', // the optional TradingView chart loads its own sheets on demand
  'chart/tv/tv-theme.css',
  'legal/legal.css', // loads with the legal pages; only `.legal*` selectors (see below)
  // The Knowledge page's: they load with its chunk, which is off unless the owner turns it on
  // (folders/access.ts); each styles only its own prefix (see below).
  'folders/folders.css',
  'knowledge/knowledge.css',
  'knowledge/doc/doc.css',
  'knowledge/sheet/sheet.css',
  'knowledge/board/board.css',
]);

/** Every selector in a stylesheet (at-rule preludes skipped, keyframe steps left out). */
function selectorsOf(file: string): string[] {
  const css = readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@[^{]+\{/g, '');
  return [...css.matchAll(/([^{}@]+)\{/g)]
    .map((m) => m[1]!.trim())
    .filter((s) => s && !/^(?:from|to|\d+%)$/.test(s))
    .flatMap((g) => g.split(',').map((s) => s.trim()));
}

test('the Knowledge page\'s sheets only style the Knowledge page, so they may load with it', () => {
  for (const [file, prefix] of [
    ['folders/folders.css', /^\.(kf|kq)[\w-]*\b/],
    ['knowledge/knowledge.css', /^\.(kn|kt)[\w-]*\b/],
    ['knowledge/doc/doc.css', /^\.kd[\w-]*\b/],
    ['knowledge/sheet/sheet.css', /^\.ks[\w-]*\b/],
    ['knowledge/board/board.css', /^\.kb[\w-]*\b/],
  ] as const) {
    const sels = selectorsOf(file);
    assert.ok(sels.length > 5, `${file}: the selectors were read`);
    for (const sel of sels) assert.match(sel, prefix, `${file}: "${sel}" must start at its own class`);
  }
});

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
