/**
 * The static shell (index.html, bootShell.ts): taken down once, faded or at once, with nothing of it left behind;
 * the theme-boot.js that tells it which page to draw; the tokens it draws with, kept equal to the app's.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { BOOT_ATTRS, BOOT_SHELL_CSS_ID, BOOT_SHELL_ID, dropBootShell, resetBootShell, sheetPending } from './bootShell';

const SRC = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(SRC, '..', 'index.html'), 'utf8');

function fakeDoc(opts: { shell?: boolean; hidden?: boolean } = {}) {
  const removed: string[] = [];
  const attrs = new Set<string>(BOOT_ATTRS);
  const classes = new Set<string>();
  const listeners = new Map<string, () => void>();
  const el = (id: string) => ({
    remove: () => removed.push(id),
    classList: { add: (c: string) => classes.add(c) },
    addEventListener: (t: string, f: () => void) => listeners.set(t, f),
  });
  const doc = {
    getElementById: (id: string) => (id === BOOT_SHELL_ID ? (opts.shell === false ? null : el(id)) : id === BOOT_SHELL_CSS_ID ? el(id) : null),
    documentElement: { removeAttribute: (a: string) => attrs.delete(a) },
    visibilityState: opts.hidden ? 'hidden' : 'visible',
  };
  return { doc, removed, attrs, classes, listeners };
}

beforeEach(() => resetBootShell());

test('without the fade, the shell, its stylesheet and the attributes go in this frame', () => {
  const f = fakeDoc();
  dropBootShell({ doc: f.doc, fade: false });
  assert.deepEqual(f.removed, [BOOT_SHELL_ID, BOOT_SHELL_CSS_ID]);
  assert.equal(f.attrs.size, 0, 'no data-boot* left on <html>');
});

test('with the fade, it goes when the fade has ended - or at the guard, whichever is first - and only once', () => {
  const f = fakeDoc();
  let guard: (() => void) | null = null;
  dropBootShell({ doc: f.doc, fade: true, later: (fn) => { guard = fn; } });
  assert.ok(f.classes.has('is-out'), 'fading');
  assert.deepEqual(f.removed, [], 'still there while it fades');
  f.listeners.get('transitionend')!();
  assert.deepEqual(f.removed, [BOOT_SHELL_ID, BOOT_SHELL_CSS_ID]);
  guard!();
  assert.equal(f.removed.length, 2, 'the guard after the fade removes nothing twice');
  dropBootShell({ doc: f.doc, fade: false });
  assert.equal(f.removed.length, 2, 'a second caller does nothing');
});

test('a hidden tab takes it down at once; a page without it only loses the stylesheet', () => {
  const hidden = fakeDoc({ hidden: true });
  dropBootShell({ doc: hidden.doc, fade: true });
  assert.equal(hidden.removed.length, 2);
  resetBootShell();
  const none = fakeDoc({ shell: false });
  dropBootShell({ doc: none.doc, fade: true });
  assert.deepEqual(none.removed, [BOOT_SHELL_CSS_ID]);
});

test('the first render waits for the stylesheet only while it is on its way', async () => {
  const link = (sheet: unknown) => {
    const on = new Map<string, () => void>();
    return { el: { sheet, href: '/assets/index-x.css', addEventListener: (t: string, f: () => void) => on.set(t, f) }, on };
  };
  const doc = (el: unknown) => ({ getElementById: (id: string) => (id === 'vs-css' ? el : null) }) as unknown as Document;
  assert.equal(sheetPending(doc(null)), null, 'no such link (dev server, admin page)');
  assert.equal(sheetPending(doc(link({}).el)), null, 'loaded');
  const pending = link(null);
  const p = sheetPending(doc(pending.el));
  assert.ok(p, 'still loading: a promise');
  pending.on.get('load')!();
  await p;
});

/* ------------------------------------------------------------ theme-boot.js ----- */

function boot(path: string, store: Record<string, string> = {}) {
  const attrs = new Map<string, string>();
  const metas = new Map<string, string>([['color-scheme', 'dark'], ['theme-color', '#0e0e0e']]);
  const links: { rel: string; href: string; crossOrigin: string | null }[] = [];
  const root = { setAttribute: (k: string, v: string) => attrs.set(k, v), style: {} as Record<string, string> };
  const document = {
    documentElement: root,
    querySelector: (sel: string) => {
      const name = /name="([^"]+)"/.exec(sel)?.[1] ?? '';
      return metas.has(name) ? { setAttribute: (_: string, v: string) => metas.set(name, v) } : null;
    },
    createElement: () => ({ rel: '', href: '', crossOrigin: null }),
    head: { appendChild: (l: (typeof links)[number]) => links.push(l) },
  };
  const localStorage = { getItem: (k: string) => store[k] ?? null };
  runInNewContext(readFileSync(join(SRC, '..', 'public', 'theme-boot.js'), 'utf8'), { document, localStorage, location: { pathname: path } });
  return { attrs, metas, links };
}

test('theme-boot.js names the page the shell draws and its tab', () => {
  const cases: [string, string, string][] = [
    ['/', 'trade', 'trade'], ['/trade', 'trade', 'trade'], ['/Trade', 'trade', 'trade'], ['/bots/new', 'bots', 'bots'],
    ['/points', 'points', 'points'], ['/portfolio', 'portfolio', 'portfolio'], ['/explore', 'explore', 'more'],
    ['/leaderboard', 'page', 'more'], ['/terms', 'page', 'more'],
  ];
  for (const [path, page, tab] of cases) {
    const b = boot(path);
    assert.equal(b.attrs.get('data-boot'), page, path);
    assert.equal(b.attrs.get('data-boot-tab'), tab, path);
  }
  assert.ok(boot('/', { 'ot.engine': '"spot"' }).attrs.has('data-boot-spot'));
  assert.ok(!boot('/', { 'ot.engine': '"perps"' }).attrs.has('data-boot-spot'));
});

test('theme-boot.js: the light theme before the first paint, the toolbar included', () => {
  const light = boot('/', { 'vs.theme': 'light' });
  assert.equal(light.attrs.get('data-theme'), 'light');
  assert.equal(light.metas.get('color-scheme'), 'light');
  assert.equal(light.metas.get('theme-color'), '#efefed');
  assert.equal(boot('/').metas.get('theme-color'), '#0e0e0e');
});

test('theme-boot.js connects to SoDEX\'s points host on /points only', () => {
  assert.deepEqual(boot('/points').links.map((l) => [l.rel, l.href, l.crossOrigin]), [['preconnect', 'https://alpha-biz.sodex.dev', '']]);
  assert.equal(boot('/trade').links.length, 0);
});

/* ------------------------------------------------------------- the tokens ----- */

const tokenIn = (css: string, name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  assert.ok(m, `--${name}`);
  return m![1]!.toLowerCase();
};

test('the shell draws with the app\'s own colours, dark and light', () => {
  const styles = readFileSync(join(SRC, 'styles.css'), 'utf8');
  const light = readFileSync(join(SRC, 'theme-light.css'), 'utf8');
  const shell = /<style id="vs-boot-css">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const dark = shell.slice(shell.indexOf(':root {'), shell.indexOf(':root[data-theme="light"]'));
  const lightShell = shell.slice(shell.indexOf(':root[data-theme="light"]'));
  for (const [vb, app] of [['bg', 'bg'], ['text', 'text'], ['muted', 'muted'], ['accent', 'accent']] as const) {
    assert.equal(tokenIn(dark, `vb-${vb}`), tokenIn(styles, app), `dark --${app}`);
    assert.equal(tokenIn(lightShell, `vb-${vb}`), tokenIn(light, app), `light --${app}`);
  }
  assert.equal(tokenIn(lightShell, 'vb-ink'), tokenIn(light, 'brand-ink'));
  assert.match(html, /<meta name="theme-color" content="#0e0e0e" \/>/);
});

test('the shell is first in <body>, hidden from assistive tech and from the translation layer', () => {
  const body = html.slice(html.indexOf('<body>'));
  assert.ok(body.indexOf('id="vs-boot"') < body.indexOf('id="root"'));
  assert.match(html, /<div id="vs-boot" class="vsb" aria-hidden="true" data-no-i18n="">/);
  assert.match(html, /<style id="vs-boot-css">/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});
