import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { HELPER_FIX, HELPER_LINE, TOUCH_QUERY, moveStylesheet, palettePreload, patchPreloadHelper, slimHtml } from './boot-shell.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs the palette addition against a fake page: the links it added. */
function run(src, { touch }) {
  const links = [];
  const window = { matchMedia: (q) => ({ matches: touch && q === TOUCH_QUERY }) };
  const document = { head: { appendChild: (e) => links.push(e) }, createElement: () => ({}) };
  runInNewContext(src, { window, document });
  return links.map((l) => `${l.rel} ${l.crossOrigin === '' ? 'cors ' : ''}${l.href}`);
}

test("the palette's chunks are announced on a device with a keyboard, not on a touch phone", () => {
  const src = palettePreload(['assets/CommandPalette-a.js', 'assets/model-b.js']);
  assert.deepEqual(run(src, { touch: false }), ['modulepreload cors /assets/CommandPalette-a.js', 'modulepreload cors /assets/model-b.js']);
  assert.deepEqual(run(src, { touch: true }), []);
});

test("App.tsx waits for the palette exactly where its chunks are announced", () => {
  const app = readFileSync(join(WEB, 'src', 'App.tsx'), 'utf8');
  assert.ok(app.includes(`matchMedia('${TOUCH_QUERY}')`), 'the same media query in App.tsx TOUCH_ONLY');
});

const built = `<!doctype html>
<html><head>
    <script src="/theme-boot.js"></script>
    <script type="module" crossorigin src="/assets/index-a.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-b.css">
  </head>
  <body>
    <div id="vs-boot" class="vsb"></div>
    <div id="root"></div>
  </body></html>`;

test('the stylesheet moves after the static shell and #root, the entry stays in <head>', () => {
  const out = moveStylesheet(built);
  const head = out.slice(0, out.indexOf('</head>'));
  assert.ok(!head.includes('stylesheet'), 'nothing in <head> holds the first paint back but theme-boot.js');
  assert.ok(head.includes('/assets/index-a.js'));
  assert.ok(out.indexOf('<link rel="stylesheet" crossorigin href="/assets/index-b.css" id="vs-css">') > out.indexOf('<div id="root"></div>'));
  assert.throws(() => moveStylesheet(built.replace('<div id="vs-boot" class="vsb"></div>', '')), /static shell/);
  assert.throws(() => moveStylesheet(built.replace(/<link rel="stylesheet"[^>]+>/, '')), /one stylesheet/);
});

test('the shipped page drops its notes and the shell\'s indentation, nothing else', () => {
  const page = `<head>
    <!-- a note
         over lines -->
    <meta http-equiv="Content-Security-Policy" content="
        default-src 'self';
      " />
    <style id="vs-boot-css">
      /* tokens */
      :root { --a: rgba(1, 2, 3, 0.5); }
      .vsb-x > b, .vsb-y { width: calc(100% - 8px); }
    </style>
  </head><body>
    <div id="vs-boot" class="vsb">
      <span class="a"><b></b></span>
      <span class="b">ValueDesk<span>Beta</span></span>
    </div>
    <div id="root"></div>
  </body>`;
  const out = slimHtml(page);
  assert.ok(!out.includes('<!--') && !out.includes('/* tokens */'));
  assert.ok(out.includes(`content="\n        default-src 'self';\n      "`), 'the CSP is left as it is');
  assert.ok(out.includes('<style id="vs-boot-css">:root{--a: rgba(1,2,3,0.5)}.vsb-x>b,.vsb-y{width: calc(100% - 8px)}</style>'));
  assert.ok(out.includes('<div id="vs-boot" class="vsb"><span class="a"><b></b></span><span class="b">ValueDesk<span>Beta</span></span></div>'));
  // The real page: still valid, with its shell, style and root.
  const real = slimHtml(readFileSync(join(WEB, 'index.html'), 'utf8'));
  for (const s of ['<div id="vs-boot"', '<style id="vs-boot-css">', '<div id="root"></div>', 'http-equiv="Content-Security-Policy"']) assert.ok(real.includes(s), s);
  assert.equal((real.match(/<style/g) ?? []).length, (real.match(/<\/style>/g) ?? []).length);
});

test("Vite's preload helper adds a lazy stylesheet after the main one, in <body>", () => {
  const sample = 'const isCss = dep.endsWith(".css");\n        document.head.appendChild(link);\n';
  assert.ok(patchPreloadHelper(sample).includes(HELPER_FIX));
  assert.throws(() => patchPreloadHelper('const isCss = 1; document.body.append(link);'), /preload helper changed/);
  // The installed Vite still has the line, once, in its helper's source.
  const chunks = join(WEB, 'node_modules', 'vite', 'dist', 'node', 'chunks');
  const src = readdirSync(chunks).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(chunks, f), 'utf8')).find((s) => s.includes('const preloadHelperId'));
  assert.ok(src, "Vite's import-analysis chunk");
  const helper = src.slice(src.indexOf('function preload(baseModule'), src.indexOf('function buildImportAnalysisPlugin'));
  assert.equal(helper.split(HELPER_LINE).length - 1, 1);
  assert.ok(helper.includes('const isCss = dep.endsWith(".css")'));
});
