/**
 * The rest of the TradingView integration's pure parts: the save/load store,
 * the library probe, the flag, theme mapping, widget options (attribution!)
 * and the read-only order lines.
 *   npx tsx --test src/chart/tv/support.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OrderLine } from '../orderOverlays';
import { isTradingViewFlag, TV_ENABLED } from './flag';
import { diffShapes, horizontalLineOptions, lineShapes, shapeSig } from './lines';
import { LIBRARY_PATH, judgeProbe } from './loader';
import { ATTRIBUTION_FEATURES, FAVORITE_RESOLUTIONS, buildWidgetOptions, pickInterval } from './options';
import { createSaveLoadAdapter, memoryStorage, type StorageLike } from './saveLoad';
import {
  FALLBACK_PALETTE,
  chartOverrides,
  collectFontFaceCss,
  cssProperties,
  primaryFamily,
  readPalette,
  withAlpha,
} from './theme';
import type { IBasicDataFeed } from './types';

// --- flag ---------------------------------------------------------------------

test('only VITE_CHART=tradingview turns the TradingView chart on', () => {
  assert.equal(isTradingViewFlag('tradingview'), true);
  assert.equal(isTradingViewFlag(' TradingView '), true);
  for (const v of [undefined, '', 'klinecharts', 'true', '1', 'tv', null, 1]) assert.equal(isTradingViewFlag(v), false);
  // Under plain Node there is no import.meta.env: the default is OFF.
  assert.equal(TV_ENABLED, false);
});

// --- loader probe -------------------------------------------------------------

test('the probe treats the SPA fallback page as "not installed"', () => {
  assert.equal(judgeProbe(200, 'text/html').ok, false); // what Vite answers today
  assert.equal(judgeProbe(200, 'text/html; charset=utf-8').ok, false);
  assert.equal(judgeProbe(404, 'text/plain').ok, false);
  assert.equal(judgeProbe(500, null).ok, false);
  assert.equal(judgeProbe(200, 'application/json').ok, false);
  assert.equal(judgeProbe(200, 'application/javascript').ok, true);
  assert.equal(judgeProbe(200, 'text/javascript; charset=utf-8').ok, true);
  assert.equal(judgeProbe(200, null).ok, true); // no header: let the script tag decide
  assert.equal(LIBRARY_PATH, '/charting_library/');
});

// --- save / load --------------------------------------------------------------

test('charts save, list, load, overwrite by id and remove', async () => {
  let t = 1_700_000_000_000;
  const a = createSaveLoadAdapter(memoryStorage(), { now: () => t, newId: () => 'id1' });
  const id = await a.saveChart({ name: 'Valuescan', symbol: 'perps:BTC-USD', resolution: '1', content: '{"a":1}' });
  assert.equal(id, 'id1');
  t += 5_000;
  await a.saveChart({ id, name: 'Valuescan', symbol: 'perps:ETH-USD', resolution: '5', content: '{"a":2}' });
  const all = await a.getAllCharts();
  assert.deepEqual(all, [{ id: 'id1', name: 'Valuescan', symbol: 'perps:ETH-USD', resolution: '5', timestamp: 1_700_000_005 }]);
  assert.equal(await a.getChartContent('id1'), '{"a":2}');
  await a.removeChart('id1');
  assert.deepEqual(await a.getAllCharts(), []);
  await assert.rejects(a.getChartContent('id1'));
});

test('study, drawing and chart templates round-trip', async () => {
  const a = createSaveLoadAdapter(memoryStorage());
  await a.saveStudyTemplate({ name: 'ma', content: 'X' });
  await a.saveStudyTemplate({ name: 'ma', content: 'Y' });
  assert.deepEqual(await a.getAllStudyTemplates(), [{ name: 'ma' }]);
  assert.equal(await a.getStudyTemplateContent({ name: 'ma' }), 'Y');
  await a.removeStudyTemplate({ name: 'ma' });
  assert.deepEqual(await a.getAllStudyTemplates(), []);

  await a.saveDrawingTemplate('LineToolTrendLine', 'thin', 'T');
  assert.deepEqual(await a.getDrawingTemplates('LineToolTrendLine'), ['thin']);
  assert.deepEqual(await a.getDrawingTemplates('LineToolRay'), []);
  assert.equal(await a.loadDrawingTemplate('LineToolTrendLine', 'thin'), 'T');
  await a.removeDrawingTemplate('LineToolTrendLine', 'thin');
  assert.deepEqual(await a.getDrawingTemplates('LineToolTrendLine'), []);

  await a.saveChartTemplate('dark', { k: 1 });
  assert.deepEqual(await a.getAllChartTemplates(), ['dark']);
  assert.deepEqual(await a.getChartTemplateContent('dark'), { content: { k: 1 } });
  await a.removeChartTemplate('dark');
  assert.deepEqual(await a.getAllChartTemplates(), []);
});

test('storage that throws never throws into the chart', async () => {
  const hostile: StorageLike = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  };
  const a = createSaveLoadAdapter(hostile);
  assert.deepEqual(await a.getAllCharts(), []); // read failure = nothing saved
  assert.deepEqual(await a.getAllStudyTemplates(), []);
  await assert.rejects(a.saveChart({ name: 'x', symbol: 's', resolution: '1', content: '' }), /QuotaExceeded/);
});

test('corrupt stored JSON reads as empty', async () => {
  const s = memoryStorage();
  s.setItem('vs.tv.charts', '{not json');
  s.setItem('vs.tv.studyTemplates', '{"not":"an array"}');
  const a = createSaveLoadAdapter(s);
  assert.deepEqual(await a.getAllCharts(), []);
  assert.deepEqual(await a.getAllStudyTemplates(), []);
});

// --- theme --------------------------------------------------------------------

test('palette reads live tokens and falls back per token', () => {
  const p = readPalette((v) => (v === '--pos' ? ' #00ff00 ' : v === '--neg' ? '' : v === '--text' ? (() => { throw new Error('x'); })() : ''));
  assert.equal(p.pos, '#00ff00');
  assert.equal(p.neg, FALLBACK_PALETTE.neg);
  assert.equal(p.text, FALLBACK_PALETTE.text);
});

test('candles, pane and scales use the app colours', () => {
  const o = chartOverrides(FALLBACK_PALETTE);
  assert.equal(o['mainSeriesProperties.candleStyle.upColor'], '#00b481');
  assert.equal(o['mainSeriesProperties.candleStyle.downColor'], '#ef4a3c');
  assert.equal(o['mainSeriesProperties.candleStyle.wickDownColor'], '#ef4a3c');
  assert.equal(o['paneProperties.background'], '#151515');
  assert.equal(o['paneProperties.backgroundType'], 'solid');
  assert.equal(o['paneProperties.horzGridProperties.color'], FALLBACK_PALETTE.grid);
  assert.equal(o['scalesProperties.fontSize'], 12);
  const css = cssProperties(FALLBACK_PALETTE);
  assert.equal(css['--tv-color-platform-background'], '#151515');
  assert.equal(css['--tv-color-toolbar-button-text-active'], '#f7f7f7');
  for (const k of Object.keys(css)) assert.match(k, /^--tv-color-/);
});

test('withAlpha and primaryFamily', () => {
  assert.equal(withAlpha('#00b481', 0.5), 'rgba(0, 180, 129, 0.5)');
  assert.equal(withAlpha('#fff', 1), 'rgba(255, 255, 255, 1)');
  assert.equal(withAlpha('rgb(1,2,3)', 0.5), 'rgb(1,2,3)');
  assert.equal(primaryFamily('"Asap", "IBM Plex Sans", sans-serif'), 'Asap');
  assert.equal(primaryFamily('system-ui'), 'system-ui');
});

test('font faces are copied for the wanted families with absolute URLs', () => {
  const rule = (family: string, src: string) => ({
    cssText: `@font-face { font-family: ${family}; src: url(${src}) format("woff2"); }`,
    style: { getPropertyValue: (p: string) => (p === 'font-family' ? family : '') },
  });
  const sheets = [
    { href: 'http://h/assets/app.css', cssRules: [rule('"Asap"', 'asap.woff2'), rule('Other', 'o.woff2'), { cssText: '.x { color: red; }' }] },
    { href: null, cssRules: [rule('"IBM Plex Sans"', '/@fs/x/plex.woff2'), rule('"Asap"', 'data:font/woff2;base64,AA')] },
    {
      href: 'http://cdn/x.css',
      get cssRules(): never {
        throw new Error('cross-origin');
      },
    },
  ];
  const css = collectFontFaceCss(sheets, ['Asap', 'IBM Plex Sans'], 'http://h/trade');
  assert.match(css, /url\(http:\/\/h\/assets\/asap\.woff2\)/);
  assert.match(css, /url\(http:\/\/h\/@fs\/x\/plex\.woff2\)/);
  assert.match(css, /url\(data:font\/woff2;base64,AA\)/);
  assert.doesNotMatch(css, /Other|color: red/);
});

// --- widget options -----------------------------------------------------------

const optsInput = (over: Partial<Parameters<typeof buildWidgetOptions>[0]> = {}) => ({
  container: {} as HTMLElement,
  libraryPath: '/charting_library/',
  datafeed: {} as IBasicDataFeed,
  ticker: 'perps:BTC-USD',
  interval: '1',
  palette: FALLBACK_PALETTE,
  allowSymbolSearch: false,
  ...over,
});

test('LICENCE: the TradingView logo is never disabled', () => {
  assert.deepEqual([...ATTRIBUTION_FEATURES], ['widget_logo']);
  const o = buildWidgetOptions(optsInput({ extraDisabled: ['widget_logo', 'header_compare'] }));
  assert.ok(!o.disabled_features?.includes('widget_logo'));
  assert.ok(o.disabled_features?.includes('header_compare'));
});

test('the chart\'s own symbol search is off unless the host can follow it', () => {
  assert.ok(buildWidgetOptions(optsInput()).disabled_features?.includes('header_symbol_search'));
  assert.ok(!buildWidgetOptions(optsInput({ allowSymbolSearch: true })).disabled_features?.includes('header_symbol_search'));
});

test('widget options: UTC, dark, autosize, library path, persistence only with an adapter', () => {
  const o = buildWidgetOptions(optsInput());
  assert.equal(o.timezone, 'Etc/UTC');
  assert.equal(o.theme, 'dark');
  assert.equal(o.autosize, true);
  assert.equal(o.library_path, '/charting_library/');
  assert.equal(o.symbol, 'perps:BTC-USD');
  assert.equal(o.load_last_chart, undefined);
  const withStore = buildWidgetOptions(optsInput({ saveLoad: createSaveLoadAdapter(memoryStorage()) }));
  assert.equal(withStore.load_last_chart, true);
  assert.equal(withStore.auto_save_delay, 5);
  assert.deepEqual(FAVORITE_RESOLUTIONS, ['1', '5', '15', '60', '240', '1D']);
});

test('a stored interval is used only while it is still served', () => {
  assert.equal(pickInterval('240'), '240');
  assert.equal(pickInterval('10'), '1');
  assert.equal(pickInterval(null), '1');
});

// --- read-only order lines ----------------------------------------------------

const line = (over: Partial<OrderLine>): OrderLine => ({
  key: 'o1', kind: 'limit', side: 'buy', price: '100', quantity: '1', label: 'Buy 1 @ 100',
  symbol: 'BTC-USD', draggable: false, ...over,
});
const colors = { pos: 'G', neg: 'R', text: 'W', muted: 'M' };

test('order lines take side colours; the position entry does not', () => {
  const shapes = lineShapes(
    [
      line({}),
      line({ key: 'o2', side: 'sell', kind: 'trigger' }),
      line({ key: 'p', kind: 'position', side: null }),
      line({ key: 'bad', price: 'x' }),
    ],
    colors,
  );
  assert.deepEqual(shapes.map((s) => [s.key, s.color, s.dashed]), [
    ['o1', 'G', false],
    ['o2', 'R', true],
    ['p', 'W', true],
  ]);
});

test('shapes are locked, unselectable and never saved into a layout', () => {
  const o = horizontalLineOptions({ key: 'k', price: 1, text: 't', color: 'G', dashed: true });
  assert.equal(o.shape, 'horizontal_line');
  assert.equal(o.lock, true);
  assert.equal(o.disableSelection, true);
  assert.equal(o.disableSave, true);
  assert.equal(o.disableUndo, true);
  assert.equal(o.overrides?.linestyle, 2);
});

test('diff redraws only what changed', () => {
  const a = { key: 'a', price: 1, text: 'A', color: 'G', dashed: false };
  const b = { key: 'b', price: 2, text: 'B', color: 'R', dashed: false };
  const drawn = new Map([['a', shapeSig(a)], ['b', shapeSig(b)], ['gone', 'x']]);
  const moved = { ...b, price: 3 };
  const c = { key: 'c', price: 4, text: 'C', color: 'G', dashed: true };
  const d = diffShapes(drawn, [a, moved, c]);
  assert.deepEqual(d.remove.sort(), ['b', 'gone']);
  assert.deepEqual(d.add.map((s) => s.key), ['b', 'c']);
});
