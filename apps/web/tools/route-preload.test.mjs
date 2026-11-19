import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { partStatement } from './i18n-parts.mjs';
import { PERSONAL_SRC, READS_BUDGET, READS_MAX, partOf, preloadScript } from './route-preload.mjs';
import { FIRST_READS_BUDGET, FIRST_READS_MAX, PERSONAL, pickFirstReads } from '../src/serverFetch.ts';

/** Runs the emitted script against a fake page and returns the links it added, the reads it started and what it left. */
function run(src, { path = '/trade', search = '', lang = null, reads = null, visible = true, primed = false } = {}) {
  const links = [];
  const fetches = [];
  const win = primed ? { __vsPrimed: true } : {};
  const doc = { head: { appendChild: (e) => links.push(e) }, createElement: () => ({}), visibilityState: visible ? 'visible' : 'hidden' };
  const store = { 'vs.lang': lang, 'vs.firstReads': reads === null ? null : JSON.stringify(reads) };
  const fetch = (url, init) => { fetches.push({ url, init }); return Promise.resolve({ ok: true }); };
  const ctx = { document: doc, location: { pathname: path, search }, localStorage: { getItem: (k) => store[k] ?? null }, window: win, fetch, JSON, Object, Array, Number, RegExp };
  runInNewContext(src, ctx);
  return {
    links: links.map((l) => `${l.rel}${l.as ? `:${l.as}` : ''}${l.crossOrigin === '' ? ' (cors)' : ''} ${l.href}`),
    pages: win.__vsI18nPages,
    win,
    started: fetches.map((f) => f.url),
    fetches,
  };
}

const map = { '': ['assets/Trade-a.js', 'assets/shared-b.js'], trade: ['assets/Trade-a.js', 'assets/shared-b.js'], points: ['assets/Points-c.js'] };
const parts = { 'assets/Trade-a.js': 'TRADEPART0', 'assets/Points-c.js': 'POINTSPRT0' };

test("the landing page's chunks are preloaded as modules, nothing else", () => {
  const { links } = run(preloadScript(map, '/', parts), { path: '/trade', lang: 'pt' });
  assert.deepEqual(links, ['modulepreload (cors) /assets/Trade-a.js', 'modulepreload (cors) /assets/shared-b.js'], 'no catalogue part is preloaded, whatever the language');
  assert.deepEqual(run(preloadScript(map), { path: '/' }).links, ['modulepreload (cors) /assets/Trade-a.js', 'modulepreload (cors) /assets/shared-b.js']);
  assert.deepEqual(run(preloadScript(map), { path: '/unknown' }).links, []);
});

test('it leaves the store the parts of each page', () => {
  const { pages } = run(preloadScript(map, '/', parts), { path: '/unknown' });
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), { '': ['TRADEPART0'], trade: ['TRADEPART0'], points: ['POINTSPRT0'] });
});

test('a chunk\'s part statement is found again, minified or not', () => {
  assert.equal(partOf(`console.log(1);${partStatement('Ab_-9xYz01')}`), 'Ab_-9xYz01');
  assert.equal(partOf('(globalThis.__vsI18n||(globalThis.__vsI18n=[])).push("Ab_-9xYz01");'), 'Ab_-9xYz01');
  assert.equal(partOf('nothing here'), null);
});

test("with a language chosen, the shell's text file and the landing page's are preloaded, under the URLs the store reads", () => {
  const first = { trade: { f: 'TRADEPART0', ids: ['TRADEPART0'] }, '': { f: 'TRADEPART0', ids: ['TRADEPART0'] } };
  const shell = { f: 'CORE000000', ids: ['CORE000000'] };
  const pt = run(preloadScript(map, '/', parts, first, { shell }), { path: '/trade', lang: 'pt' });
  assert.deepEqual(pt.links, ['modulepreload (cors) /assets/Trade-a.js', 'modulepreload (cors) /assets/shared-b.js', 'preload:fetch (cors) /i18n/pt/CORE000000.json', 'preload:fetch (cors) /i18n/pt/TRADEPART0.json']);
  assert.deepEqual(JSON.parse(JSON.stringify(pt.win.__vsI18nShell)), shell);
  assert.deepEqual(JSON.parse(JSON.stringify(pt.win.__vsI18nFirst)), first.trade);
  assert.equal(run(preloadScript(map, '/', parts, first, { shell }), { path: '/trade', lang: 'en' }).links.length, 2, 'English reads no catalogue');
  assert.equal(run(preloadScript(map, '/', parts, first, { shell }), { path: '/trade', lang: 'x"y' }).links.length, 2, 'only a language code');
  assert.deepEqual(run(preloadScript(map, '/', parts, first, { shell }), { path: '/points', lang: 'pt' }).links, ['modulepreload (cors) /assets/Points-c.js', 'preload:fetch (cors) /i18n/pt/CORE000000.json'], 'a page without text of its own: the shell only');
});

test("a page's connection hints go out with its chunks, and only on that page", () => {
  const hints = { points: [['preconnect', 'https://alpha-biz.sodex.dev', 1]], explore: [['dns-prefetch', 'https://api.example', 0]] };
  assert.deepEqual(run(preloadScript(map, '/', parts, {}, { hints }), { path: '/points' }).links, ['modulepreload (cors) /assets/Points-c.js', 'preconnect (cors) https://alpha-biz.sodex.dev']);
  assert.deepEqual(run(preloadScript(map, '/', parts, {}, { hints }), { path: '/explore' }).links, ['dns-prefetch https://api.example']);
  assert.equal(run(preloadScript(map, '/', parts, {}, { hints }), { path: '/trade' }).links.length, 2);
});

/* --- first reads ---------------------------------------------------------------------------------- */

const reads = { '/leaderboard': ['/api/vs/leaderboard?d=1'], '/explore?view=cohorts': ['/api/vs/cohorts?v=all'] };

test("a first visit starts the build's defaults for the URL, at low priority, as serverFetch would ask them", () => {
  const r = run(preloadScript(map, '/', parts, {}, { reads }), { path: '/leaderboard' });
  assert.deepEqual(r.started, ['/api/vs/leaderboard?d=1']);
  assert.deepEqual(JSON.parse(JSON.stringify(r.fetches[0].init)), { headers: { Accept: 'application/json' }, credentials: 'same-origin', priority: 'low' });
  assert.deepEqual(Object.keys(r.win.__vsEarly), ['/api/vs/leaderboard?d=1'], 'left for serverFetch.ts to adopt');
  assert.deepEqual(JSON.parse(JSON.stringify(r.win.__vsReads)), reads, 'and the table, for a page primed on a touch');
  assert.deepEqual(run(preloadScript(map, '/', parts, {}, { reads }), { path: '/explore', search: '?view=cohorts' }).started, ['/api/vs/cohorts?v=all'], 'keyed by path and query');
});

test('what this browser remembers for the URL wins over the defaults, also an empty list', () => {
  const src = preloadScript(map, '/', parts, {}, { reads });
  assert.deepEqual(run(src, { path: '/leaderboard', reads: { '/leaderboard': [['/api/vs/leaderboard?mine=1', 900], '/api/vs/old-form'] } }).started, ['/api/vs/leaderboard?mine=1', '/api/vs/old-form']);
  const none = run(src, { path: '/leaderboard', reads: { '/leaderboard': [] } });
  assert.deepEqual(none.started, []);
  assert.deepEqual(JSON.parse(JSON.stringify(none.win.__vsEarly)), {}, 'it chose: serverFetch.ts sends nothing of its own');
  assert.deepEqual(run(src, { path: '/leaderboard', reads: { '/copy': [] } }).started, ['/api/vs/leaderboard?d=1'], "another URL's list is not this one's");
});

test("an empty default is the page's rule: nothing starts for it, whatever this browser remembers", () => {
  const src = preloadScript(map, '/', parts, {}, { reads: { '/explore': [], '/leaderboard': ['/api/vs/d'] } });
  const r = run(src, { path: '/explore', reads: { '/explore': [['/api/vs/screener?view=assets', 13_301]] } });
  assert.deepEqual(r.started, []);
  assert.deepEqual(JSON.parse(JSON.stringify(r.win.__vsEarly)), {});
  const ahead = { '/explore': ['/api/vs/screener?view=assets'] };
  const a = run(preloadScript(map, '/', parts, {}, { reads: { '/explore': [] }, ahead }), { path: '/explore' });
  assert.deepEqual(a.started, [], 'the reads on intent are not started on landing');
  assert.deepEqual(JSON.parse(JSON.stringify(a.win.__vsAhead)), ahead, 'only left for a page primed on a touch');
});

test('nothing starts for a wallet or a search in the URL, a background tab, or an app that already booted', () => {
  const src = preloadScript(map, '/', parts, {}, { reads: { '/scan?address=0x1': ['/api/vs/a'], '/leaderboard': ['/api/vs/a'] } });
  const personal = run(src, { path: '/scan', search: '?address=0x1' });
  assert.deepEqual(personal.started, []);
  assert.equal(personal.win.__vsEarly, undefined, 'left to serverFetch.ts, which starts nothing for it either');
  assert.deepEqual(run(src, { path: '/leaderboard', visible: false }).started, []);
  assert.deepEqual(run(src, { path: '/leaderboard', primed: true }).started, []);
  assert.deepEqual(run(src, { path: '/leaderboard', reads: { '/leaderboard': ['https://evil.example/x', '/api/acct/state', '/api/vs/lbrow?address=0x1', 7, '/api/vs/ok'] } }).started, ['/api/vs/ok']);
});

test('the script picks exactly as serverFetch.ts does: six at most, 64 KB on the wire, nothing personal', () => {
  assert.equal(READS_MAX, FIRST_READS_MAX);
  assert.equal(READS_BUDGET, FIRST_READS_BUDGET);
  assert.equal(new RegExp(PERSONAL_SRC, 'i').source, PERSONAL.source);
  const src = preloadScript(map, '/', parts, {}, {});
  const lists = [
    [['/api/vs/a', 40_000], ['/api/vs/b', 30_000], ['/api/vs/c', 20_000], ['/api/vs/d', 0]],
    Array.from({ length: 9 }, (_, i) => [`/api/vs/x${i}`, 100]),
    [['/api/vs/a', 1], ['/api/vs/a', 1], ['/api/vs/q?q=1', 1], ['/api/vs/z', 70_000], ['/api/vs/y', 65_536]],
    [['/api/vs/a', -5], ['/api/vs/b', 'x'], ['/api/vs/c', null]],
  ];
  for (const list of lists) {
    const want = pickFirstReads(list.map(([p, b]) => [p, Number(b) > 0 ? Number(b) : 0]));
    assert.deepEqual(run(src, { path: '/explore', reads: { '/explore': list } }).started, want, JSON.stringify(list));
  }
});

test("with no language chosen, the browser's own is the one preloaded (src/i18n/browserLang.ts)", () => {
  const first = { trade: { f: 'p-AAAAAAAAAA', ids: ['CORE000000', 'TRADEPART0'] } };
  const langs = ['en', 'pt', 'fr', 'zh-TW'];
  const at = (languages) => {
    const links = [];
    const doc = { head: { appendChild: (e) => links.push(e) }, createElement: () => ({}) };
    runInNewContext(preloadScript(map, '/', parts, first, { langs }), { document: doc, location: { pathname: '/trade' }, localStorage: { getItem: () => null }, window: { navigator: { languages } } });
    return links.filter((l) => l.as === 'fetch').map((l) => l.href);
  };
  assert.deepEqual(at(['pt-BR', 'en']), ['/i18n/pt/p-AAAAAAAAAA.json']);
  assert.deepEqual(at(['ar-MA', 'fr-MA']), ['/i18n/fr/p-AAAAAAAAAA.json']);
  assert.deepEqual(at(['zh-Hant-HK']), ['/i18n/zh-TW/p-AAAAAAAAAA.json']);
  assert.deepEqual(at(['en-US', 'pt-BR']), [], 'English first reads no catalogue');
  assert.deepEqual(at(['am-ET']), [], 'a language the app does not have');
  assert.equal(run(preloadScript(map, '/', parts, first, { langs }), { path: '/trade', lang: 'en' }).links.length, 2, 'a stored choice wins');
});
