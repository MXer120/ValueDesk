/**
 * The news and macro widgets' first paint (rendered on the server, no DOM):
 * which list and filters show, the settings each copy keeps, and what shows
 * before the data arrives or when every source is switched off.
 *   npx tsx --test src/components/news/widgets.test.tsx
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installViteStubs, staticMarkup } from '../macro/testEnv';

installViteStubs({
  stored: {
    // Every news source switched off in Settings (shared by every copy of the widget).
    'vs.news.sources': { sosovalue: false, whitehouse: false },
    'vs.news.feed.cal': 'calendar',
    'vs.news.feed.hot': 'hot',
    'vs.news.feed.bad': 'no-such-feed',
    'vs.news.cal.minor.all': true,
    'vs.etf.asset.e': 'ETH',
    'vs.etf.range.e': '1y',
    'vs.indicator.id.i': 'cpi_yy',
  },
});
const { createElement } = await import('react');
const render = await staticMarkup();
const { NewsFeed } = await import('./NewsFeed');
const { EconCalendar } = await import('./EconCalendar');
const { FedWatch, outcomeColor } = await import('../macro/FedWatch');
const { EtfFlows } = await import('../macro/EtfFlows');
const { IndicatorWidget } = await import('../macro/IndicatorView');

/** The radio buttons of a group, as "label:checked". */
function radios(html: string, group: string): string[] {
  const at = html.indexOf(`aria-label="${group}"`);
  assert.ok(at >= 0, `no ${group} group`);
  const next = html.indexOf('role="radiogroup"', at);
  const end = next >= 0 ? next : html.length;
  const part = html.slice(at, end);
  return [...part.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => `${m[2]!.replace(/<[^>]+>/g, '')}:${m[1]}`);
}

test('News: the four lists, Latest by default; a stored list that no longer exists falls back to Latest', () => {
  assert.deepEqual(radios(render(createElement(NewsFeed, {})), 'Which news'), ['Latest:true', 'Hot:false', 'Featured:false', 'Calendar:false']);
  assert.deepEqual(radios(render(createElement(NewsFeed, { instance: 'bad' })), 'Which news'), ['Latest:true', 'Hot:false', 'Featured:false', 'Calendar:false']);
  assert.deepEqual(radios(render(createElement(NewsFeed, { instance: 'hot' })), 'Which news'), ['Latest:false', 'Hot:true', 'Featured:false', 'Calendar:false']);
});

test('News: every source switched off says so instead of loading forever', () => {
  const html = render(createElement(NewsFeed, {}));
  assert.match(html, /Every news source is off/);
  assert.match(html, /Switch one on in Settings, under News\./);
  assert.doesNotMatch(html, /Loading…/);
});

test('News: the type filter shows on Latest only; Hot names its order and credits SoSoValue', () => {
  assert.match(render(createElement(NewsFeed, {})), /Every type/);
  const hot = render(createElement(NewsFeed, { instance: 'hot' }));
  assert.doesNotMatch(hot, /Every type/);
  assert.match(hot, /SoSoValue&#x27;s hottest stories right now, hottest first\.|SoSoValue's hottest stories right now, hottest first\./);
  assert.match(hot, /Powered by/);
  assert.match(hot, /Search all news/, 'the search is on every list');
});

test('News: the Calendar list is the calendar - its own switch, no story filters', () => {
  const html = render(createElement(NewsFeed, { instance: 'cal' }));
  assert.deepEqual(radios(html, 'Which news'), ['Latest:false', 'Hot:false', 'Featured:false', 'Calendar:true']);
  assert.deepEqual(radios(html, 'Which releases'), ['Key releases:true', 'All:false']);
  assert.doesNotMatch(html, /Search all news|Every type|Every news source is off/);
  assert.match(html, /Loading…/);
});

test('Calendar: key releases by default; a copy that chose All keeps it', () => {
  assert.deepEqual(radios(render(createElement(EconCalendar, {})), 'Which releases'), ['Key releases:true', 'All:false']);
  assert.deepEqual(radios(render(createElement(EconCalendar, { instance: 'all' })), 'Which releases'), ['Key releases:false', 'All:true']);
});

test('Rate odds: off until the markets license their prices; cuts green, hold grey, hikes red, deeper moves stronger', () => {
  assert.match(render(createElement(FedWatch, {})), /FOMC rate odds are off/);
  assert.equal(outcomeColor(0), '#9aa0a6');
  assert.equal(outcomeColor(-25), '#00b481');
  assert.equal(outcomeColor(-50), '#0a8f68');
  assert.equal(outcomeColor(-75), '#0a8f68');
  assert.equal(outcomeColor(25), '#ef4a3c');
  assert.equal(outcomeColor(50), '#b5271b');
  assert.equal(outcomeColor(100), '#b5271b');
});

test('ETF flows: BTC, ETH, SOL before the list arrives, the asset and range each copy chose, credited', () => {
  const plain = render(createElement(EtfFlows, {}));
  assert.deepEqual(radios(plain, 'Asset'), ['BTC:true', 'ETH:false', 'SOL:false']);
  assert.deepEqual(radios(plain, 'Range'), ['1M:false', '3M:true', '1Y:false', 'All:false']);
  assert.match(plain, /Loading…/);
  assert.match(plain, /Powered by/);
  const mine = render(createElement(EtfFlows, { instance: 'e' }));
  assert.deepEqual(radios(mine, 'Asset'), ['BTC:false', 'ETH:true', 'SOL:false']);
  assert.deepEqual(radios(mine, 'Range'), ['1M:false', '3M:false', '1Y:true', 'All:false']);
});

test('Indicator: core PCE by default, the copy\'s own pick kept, listed before the catalogue arrives', () => {
  assert.match(render(createElement(IndicatorWidget, {})), /<option value="core_pce_yy"[^>]*>core_pce_yy<\/option>/);
  const mine = render(createElement(IndicatorWidget, { instance: 'i' }));
  assert.match(mine, /<option value="cpi_yy"[^>]*>cpi_yy<\/option>/);
  assert.match(mine, /Loading…/);
});
