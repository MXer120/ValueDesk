/**
 * The catalogues in parts (tools/i18n-parts.mjs, store.ts): what is fetched when, for which language.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootLanguage, currentLanguage, i18nEnv, i18nRouteChanged, i18nWarmPath, resetI18nForTest, setLanguage } from './store';
import { browserLang } from './browserLang';

/* An English browser: a visitor without a stored choice reads the browser's language (browserLang.ts), and Node's
   navigator follows this machine's locale. */
browserLang.languages = () => ['en-US'];

const g = globalThis as unknown as Record<string, unknown>;
const mem = new Map<string, string>();
g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
g.document = { documentElement: { lang: 'en' } };
g.window = globalThis;
const at = (path: string) => { g.location = { pathname: path }; };

/** The files on the "server": a part per id per language, and the whole catalogues. */
const files: Record<string, Record<string, string> | null> = {
  '/i18n/de/core.json': { Trade: 'Handeln' },
  '/i18n/de/trade.json': { 'Order Book': 'Orderbuch' },
  '/i18n/de/explore.json': { Cohorts: 'Kohorten' },
  '/i18n/de/dialog.json': { Close: 'Schließen' },
  '/i18n/de.json': { Trade: 'Handeln', 'Order Book': 'Orderbuch', Cohorts: 'Kohorten', Close: 'Schließen' },
  '/i18n/fr/core.json': { Trade: 'Trader' },
  '/i18n/fr/trade.json': { 'Order Book': "Carnet d'ordres" },
};
let asked: string[] = [];
let shown: Record<string, string> | null = null;
i18nEnv.fetchJson = async (url) => { asked.push(url); return files[url] ?? null; };
i18nEnv.apply = async (c) => { shown = c ? { ...c } : null; };
i18nEnv.split = true;
const settle = () => new Promise((r) => setTimeout(r, 60));
const push = (id: string) => (g.__vsI18n as { push: (id: string) => void }).push(id);

function fresh(lang: string | null, path = '/trade') {
  resetI18nForTest();
  asked = [];
  shown = null;
  mem.clear();
  if (lang) mem.set('vs.lang', lang);
  at(path);
  g.__vsI18nPages = { '': ['trade'], trade: ['trade'], explore: ['explore'] };
  delete g.__vsI18n;
}

test('English reads nothing at all', async () => {
  fresh(null);
  g.__vsI18n = ['core'];
  bootLanguage();
  push('trade');
  await settle();
  assert.deepEqual(asked, []);
  assert.equal(shown, null);
});

test('a part is read when its chunk runs: the shell and this page, not the pages fetched ahead', async () => {
  fresh('de');
  g.__vsI18n = ['core']; // named by the entry before the store was ready
  bootLanguage();
  assert.equal(currentLanguage(), 'de');
  push('trade');
  push('explore'); // App.tsx fetched the Explore page's code ahead of a visit
  push('dialog'); // a chunk no page lists: a dialog opened
  await settle();
  assert.deepEqual(asked.sort(), ['/i18n/de/core.json', '/i18n/de/dialog.json', '/i18n/de/trade.json']);
  assert.deepEqual(shown, { Trade: 'Handeln', 'Order Book': 'Orderbuch', Close: 'Schließen' });
  at('/explore');
  i18nRouteChanged();
  await settle();
  assert.ok(asked.includes('/i18n/de/explore.json'), 'its text arrives when the page opens');
  assert.equal((shown as Record<string, string> | null)?.Cohorts, 'Kohorten');
});

test('a part that is not there reads the whole catalogue once, and nothing more after', async () => {
  fresh('de');
  bootLanguage();
  push('core');
  push('gone');
  await settle();
  assert.ok(asked.includes('/i18n/de.json'));
  assert.equal((shown as Record<string, string> | null)?.Cohorts, 'Kohorten');
  const before = asked.length;
  push('dialog');
  await settle();
  assert.equal(asked.length, before, 'the whole catalogue holds every part already');
});

test('switching language reads the parts named so far, in the new language', async () => {
  fresh('de');
  bootLanguage();
  push('core');
  push('trade');
  await settle();
  asked = [];
  assert.equal(await setLanguage('fr'), true);
  assert.deepEqual(asked.sort(), ['/i18n/fr/core.json', '/i18n/fr/trade.json']);
  assert.deepEqual(shown, { Trade: 'Trader', 'Order Book': "Carnet d'ordres" });
  assert.equal(currentLanguage(), 'fr');
  assert.equal(mem.get('vs.lang'), 'fr');
  assert.equal(await setLanguage('en'), true);
  assert.equal(shown, null);
});

test('without the page map every part is read when named', async () => {
  fresh('de');
  delete g.__vsI18nPages;
  bootLanguage();
  push('explore');
  await settle();
  assert.deepEqual(asked, ['/i18n/de/explore.json']);
});

test('the dev server has no parts: the whole catalogue, as before', async () => {
  fresh('de');
  i18nEnv.split = false;
  try {
    bootLanguage();
    await settle();
    assert.deepEqual(asked, ['/i18n/de.json']);
    assert.equal((shown as Record<string, string> | null)?.['Order Book'], 'Orderbuch');
  } finally {
    i18nEnv.split = true;
  }
});

test('touching a link to a page reads its held part before the page opens', async () => {
  fresh('de');
  bootLanguage();
  push('core');
  push('explore');
  await settle();
  assert.ok(!asked.includes('/i18n/de/explore.json'));
  i18nWarmPath('/explore');
  await settle();
  assert.ok(asked.includes('/i18n/de/explore.json'));
  assert.equal((shown as Record<string, string> | null)?.Cohorts, 'Kohorten');
});

test('the landing page reads its text in one file; the chunks that come with it ask for nothing more', async () => {
  fresh('de');
  files['/i18n/de/p-first.json'] = { Trade: 'Handeln', 'Order Book': 'Orderbuch' };
  g.__vsI18nFirst = { f: 'p-first', ids: ['core', 'trade'] };
  try {
    bootLanguage();
    push('core');
    push('trade');
    push('dialog');
    await settle();
    assert.deepEqual(asked.sort(), ['/i18n/de/dialog.json', '/i18n/de/p-first.json']);
    assert.equal((shown as Record<string, string> | null)?.['Order Book'], 'Orderbuch');
  } finally {
    delete g.__vsI18nFirst;
  }
});

test("the shell's text is one file every page shares, read beside the page's own; nothing is asked twice", async () => {
  fresh('de');
  files['/i18n/de/p-page.json'] = { 'Order Book': 'Orderbuch' };
  g.__vsI18nShell = { f: 'core', ids: ['core'] }; // a single part is its own file
  g.__vsI18nFirst = { f: 'p-page', ids: ['trade'] };
  try {
    bootLanguage();
    push('core');
    push('trade');
    await settle();
    assert.deepEqual(asked.sort(), ['/i18n/de/core.json', '/i18n/de/p-page.json']);
    assert.deepEqual(shown, { Trade: 'Handeln', 'Order Book': 'Orderbuch' });
  } finally {
    delete g.__vsI18nShell;
    delete g.__vsI18nFirst;
  }
});

test('a landing file that cannot be read: its parts are read one by one', async () => {
  fresh('de');
  g.__vsI18nFirst = { f: 'p-gone', ids: ['core', 'trade'] };
  try {
    bootLanguage();
    push('core');
    push('trade');
    await settle();
    assert.ok(asked.includes('/i18n/de/p-gone.json'));
    assert.ok(asked.includes('/i18n/de/core.json') && asked.includes('/i18n/de/trade.json'));
    assert.equal((shown as Record<string, string> | null)?.['Order Book'], 'Orderbuch');
  } finally {
    delete g.__vsI18nFirst;
  }
});
