/**
 * The terminal's widgets in chunks of their own (lazyWidgets.tsx), and which of them the trade page waits for
 * before its first commit (firstWidgets.ts): a fresh visitor waits for none, a stored layout for exactly the
 * widgets it puts on screen.
 *   npx tsx --test src/dashboard/lazyWidgets.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerTestLoader } from '../testRender';

registerTestLoader();

/** An in-memory localStorage (the stored layout, the chart's open tab). */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
}
const g = globalThis as { localStorage?: Storage };
beforeEach(() => { g.localStorage = memoryStorage(); });

const { WIDGET_CODE, widgetCodeOf, preloadWidgets, LiqHeatmap, NewsFeed } = await import('./lazyWidgets');
const { firstRenderWidgetIds, bandTabIds, CHART_TAB_KEY, BAND_TABS_KEY } = await import('./firstWidgets');
const { TRADE_DASHBOARD } = await import('./layout');
const { EXTRA_WIDGET_IDS } = await import('./widgetCatalog');
const { activateSlot, saveDashboard, seedTerminals } = await import('./storage');

/* TRADE_PANELS' ids and default visibility (registry.tsx): the hand-built panels, the opt-in ones, the catalog's. */
const PANELS = [
  ...['markets', 'ticker', 'chart', 'book', 'exec', 'positions', 'account'].map((id) => ({ id })),
  ...['leaderboard', 'feetier', 'venue', ...EXTRA_WIDGET_IDS].map((id) => ({ id, defaultHidden: true })),
];
const lazyIn = (ids: string[]) => ids.filter((id) => widgetCodeOf(id)).sort();

test('a widget id, a duplicate and a tab key name the same chunk; the page\'s own panels name none', () => {
  assert.equal(widgetCodeOf('news#2'), NewsFeed);
  assert.equal(widgetCodeOf('x:liqmap'), LiqHeatmap);
  for (const id of ['chart', 'book', 'tape', 'trades', 'markets', 'asset:SOL-USD', 'positions']) assert.equal(widgetCodeOf(id), null, id);
});

test('preloadWidgets skips what it does not know and never rejects', async () => {
  await preloadWidgets(['chart', 'nope', 'asset:BTC-USD']);
});

test('every widget widgetBodies.tsx and registry.tsx draw lazily has a chunk here, and nothing else does', () => {
  const bodies = readFileSync(new URL('./widgetBodies.tsx', import.meta.url), 'utf8');
  const registry = readFileSync(new URL('./registry.tsx', import.meta.url), 'utf8');
  const fromBodies = [...bodies.matchAll(/case '([a-z]+)': return (?:lazy\(|body\(<div[^>]*><LazyWidget>)/g)].map((m) => m[1]!);
  const fromRegistry = [...registry.matchAll(/id: '([a-z]+)',[\s\S]{0,200}?render: \(c\) => <LazyWidget>/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set([...fromBodies, ...fromRegistry])].sort(), Object.keys(WIDGET_CODE).sort());
});

test('the stored keys are the ones the chart card and the account band write', () => {
  const tabs = readFileSync(new URL('./tradeTabs.tsx', import.meta.url), 'utf8');
  assert.ok(tabs.includes(`useStored<string>('${CHART_TAB_KEY}', 'main')`));
  assert.ok(tabs.includes("useExtraTabs('band', TAB_MAX)"));
  const extras = readFileSync(new URL('./tabExtras.tsx', import.meta.url), 'utf8');
  assert.ok(extras.includes('useStored<string[]>(`vs.tabs.${panel}`, [])') && BAND_TABS_KEY === 'vs.tabs.band');
});

test('a first visit waits for no widget chunk', () => {
  const ids = firstRenderWidgetIds(TRADE_DASHBOARD, PANELS);
  assert.ok(ids.includes('chart') && ids.includes('book'), 'the page\'s own panels');
  assert.deepEqual(lazyIn(ids), []);
});

test('a widget switched on, on the canvas on screen: its chunk is waited for', () => {
  const s = seedTerminals({ v: TRADE_DASHBOARD.version, layouts: {}, locked: true, shown: ['news', 'cohorts'], hidden: [] }, TRADE_DASHBOARD.terminals ?? []);
  saveDashboard(TRADE_DASHBOARD, s);
  assert.deepEqual(lazyIn(firstRenderWidgetIds(TRADE_DASHBOARD, PANELS)), ['cohorts', 'news']);
});

test('the News terminal on screen: its live feed and news', () => {
  const s = activateSlot(seedTerminals({ v: TRADE_DASHBOARD.version, layouts: {}, locked: true }, TRADE_DASHBOARD.terminals ?? []), 'news');
  saveDashboard(TRADE_DASHBOARD, s);
  assert.deepEqual(lazyIn(firstRenderWidgetIds(TRADE_DASHBOARD, PANELS)), ['livefeed', 'news']);
});

test('the chart card opens on the liquidation map: that chunk too; on the market itself, none', () => {
  localStorage.setItem(CHART_TAB_KEY, JSON.stringify('liqmap'));
  assert.deepEqual(lazyIn(firstRenderWidgetIds(TRADE_DASHBOARD, PANELS)), ['liqmap']);
  localStorage.setItem(CHART_TAB_KEY, JSON.stringify('main'));
  assert.deepEqual(lazyIn(firstRenderWidgetIds(TRADE_DASHBOARD, PANELS)), []);
});

test('a broken record waits for nothing (the defaults render)', () => {
  localStorage.setItem(`ot.dashboard.${TRADE_DASHBOARD.id}`, '{not json');
  localStorage.setItem(CHART_TAB_KEY, '{');
  assert.deepEqual(lazyIn(firstRenderWidgetIds(TRADE_DASHBOARD, PANELS)), []);
});

test('the account band\'s added tabs are what a phone prefetches', () => {
  assert.deepEqual(bandTabIds(), []);
  localStorage.setItem(BAND_TABS_KEY, JSON.stringify(['news', 'fedlive#2', 7]));
  assert.deepEqual(bandTabIds(), ['news', 'fedlive#2']);
});
