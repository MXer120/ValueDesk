/**
 * Pure-logic tests for the search / Cmd+K palette.
 *   npx tsx --test src/components/palette/model.test.ts
 *
 * What is pinned: every number the rows print (formatting, the Last active
 * rule), the query each tab sends the server, the Assets ordering and
 * positioning join, the venue interleave, the local lists, and that the
 * client's idea of each preset's sort is the server's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, type ScreenerRow } from '@sign/valuescan/screener/model.js';
import {
  DEFAULT_LIST_FILTERS,
  DEFAULT_SCREENER_FILTERS,
  PALETTE_TABS,
  PRESET_SORT,
  baseOf,
  cycleTab,
  effectiveSort,
  extractAddress,
  filterAssets,
  fmtAgo,
  fmtChangePct,
  fmtFracPct,
  fmtUsdCompact,
  fmtUsdSigned,
  fmtWinRate,
  hlAssetRow,
  identicon,
  interleaveVenues,
  isAddressPrefix,
  isTraderRef,
  lastActiveLabel,
  listQuery,
  positioningIndex,
  pushFront,
  readList,
  screenerQuery,
  shortAddress,
  sodexFirst,
  sortAssets,
  toSearch,
  toggleVenue,
  traderKey,
  venueParam,
  visibleViewportBox,
  withPositioning,
  writeList,
  type AssetRow,
} from './model';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const A = '0x082e843a431aef031264dc232693dd710aedca88';
const B = '0x30afce2f6842bf183c7e3fe7162e279ff0b6393e';

/* --- formatting ----------------------------------------------------------- */

test('fmtUsdCompact: the 4.png shapes, sign and unknown', () => {
  assert.equal(fmtUsdCompact(860_000), '$860k');
  assert.equal(fmtUsdCompact(1_200_000), '$1.2M');
  assert.equal(fmtUsdCompact(13_600_000), '$13.6M');
  assert.equal(fmtUsdCompact(4_900_000_000), '$4.9B');
  assert.equal(fmtUsdCompact(950), '$950');
  assert.equal(fmtUsdCompact(0), '$0');
  assert.equal(fmtUsdCompact(1_000_000), '$1M', 'a trailing .0 is dropped');
  assert.equal(fmtUsdCompact(-38_500), '−$38.5k');
  assert.equal(fmtUsdCompact(null), '—');
  assert.equal(fmtUsdCompact(Number.NaN), '—');
});

test('fmtUsdSigned / fmtFracPct / fmtWinRate / fmtChangePct', () => {
  assert.equal(fmtUsdSigned(80_900), '+$80.9k');
  assert.equal(fmtUsdSigned(-1_200_000), '−$1.2M');
  assert.equal(fmtUsdSigned(0), '$0');
  assert.equal(fmtFracPct(0.0816), '+8.16%');
  assert.equal(fmtFracPct(-0.2312), '−23.12%');
  assert.equal(fmtFracPct(2.113), '+211.3%', '>= 100% keeps one decimal');
  assert.equal(fmtFracPct(44875.27), '+4,487,527%', '>= 1000% keeps none');
  assert.equal(fmtFracPct(undefined), '—');
  assert.equal(fmtWinRate(0.8664), '87%');
  assert.equal(fmtWinRate(null), '—');
  assert.equal(fmtChangePct(1.5234), '+1.52%');
  assert.equal(fmtChangePct(-0.8), '−0.80%');
});

test('fmtAgo: minutes, hours, days, then a date', () => {
  assert.equal(fmtAgo(NOW - 20_000, NOW), 'now');
  assert.equal(fmtAgo(NOW - 5 * MIN, NOW), '5m ago');
  assert.equal(fmtAgo(NOW - 3 * HOUR, NOW), '3h ago');
  assert.equal(fmtAgo(NOW - 2 * DAY, NOW), '2d ago');
  assert.equal(fmtAgo(Date.UTC(2025, 11, 8, 12, 0), NOW), 'Dec 8, 2025');
  assert.equal(fmtAgo(null, NOW), '—');
  assert.equal(fmtAgo(0, NOW), '—');
});

test('lastActiveLabel: exact fill, volume bucket, and the more recent of the two wins', () => {
  assert.equal(lastActiveLabel({ lastActive: NOW - 3 * HOUR, activeWithin: '1d' }, NOW), '3h ago');
  assert.equal(lastActiveLabel({ lastActive: null, activeWithin: '1d' }, NOW), '< 24h');
  assert.equal(lastActiveLabel({ lastActive: null, activeWithin: '7d' }, NOW), '< 7d');
  assert.equal(lastActiveLabel({ lastActive: null, activeWithin: '30d' }, NOW), '< 30d');
  assert.equal(lastActiveLabel({ lastActive: null, activeWithin: null }, NOW), '—');
  // A sampled fill 20 days old next to volume inside the last 24h: the volume is the fresher proof.
  assert.equal(lastActiveLabel({ lastActive: NOW - 20 * DAY, activeWithin: '1d' }, NOW), '< 24h');
  // A fill older than 30 days with nothing tighter prints the date (the 0x082e case).
  assert.equal(lastActiveLabel({ lastActive: Date.UTC(2025, 11, 8, 12, 0), activeWithin: null }, NOW), 'Dec 8, 2025');
});

/* --- addresses and identicons ---------------------------------------------- */

test('extractAddress: a bare address, one inside a URL, never a 41-digit run', () => {
  assert.equal(extractAddress(A.toUpperCase().replace('0X', '0x')), A);
  assert.equal(extractAddress(`https://app.hyperliquid.xyz/explorer/address/${A}?x=1`), A);
  assert.equal(extractAddress(`${A}f`), null);
  assert.equal(extractAddress('0x1234'), null);
  assert.equal(isAddressPrefix('0x082e'), true);
  assert.equal(isAddressPrefix('0x08'), false);
  assert.equal(shortAddress(A), '0x082e…ca88');
});

test('identicon: deterministic, case-insensitive, mirrored, never empty', () => {
  const a = identicon(A);
  assert.deepEqual(identicon(A.toUpperCase()), a);
  assert.notDeepEqual(identicon(B), a);
  assert.equal(a.cells.length, 25);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) assert.equal(a.cells[y * 5 + x], a.cells[y * 5 + (4 - x)]);
  }
  assert.ok(a.hue >= 0 && a.hue < 360);
  assert.ok(identicon('0x0000000000000000000000000000000000000000').cells.some(Boolean));
});

/* --- tabs, venues, queries -------------------------------------------------- */

test('cycleTab wraps both ways', () => {
  assert.deepEqual(PALETTE_TABS, ['home', 'traders', 'screener', 'assets']);
  assert.equal(cycleTab('assets', 1), 'home');
  assert.equal(cycleTab('home', -1), 'assets');
  assert.equal(cycleTab('traders', 1), 'screener');
});

test('venue toggles never leave both off; venueParam', () => {
  const both = { sodex: true, hyperliquid: true };
  assert.equal(venueParam(both), 'all');
  const hlOnly = toggleVenue(both, 'sodex');
  assert.deepEqual(hlOnly, { sodex: false, hyperliquid: true });
  assert.equal(venueParam(hlOnly), 'hyperliquid');
  assert.deepEqual(toggleVenue(hlOnly, 'hyperliquid'), hlOnly, 'the last venue cannot be switched off');
  assert.equal(venueParam({ sodex: true, hyperliquid: false }), 'sodex');
});

test('listQuery: only what is set; the volume window rides along with a threshold', () => {
  const both = { sodex: true, hyperliquid: true };
  assert.deepEqual(listQuery(DEFAULT_LIST_FILTERS, both), { venue: 'all' });
  assert.deepEqual(
    listQuery({ minWinRate: 60, volWindow: '7d', minVolume: 1_000_000, strategy: 'swing', active: '24h' }, { sodex: true, hyperliquid: false }, {
      q: '  0x082e ',
      sort: 'pnl',
      window: '7d',
      limit: 8,
    }),
    { venue: 'sodex', q: '0x082e', minWinRate: '60', volWindow: '7d', minVolume: '1000000', strategy: 'swing', active: '24h', sort: 'pnl', window: '7d', limit: '8' },
  );
});

test('screenerQuery + effectiveSort: the preset owns the sort until one is chosen', () => {
  const both = { sodex: true, hyperliquid: true };
  assert.deepEqual(screenerQuery(DEFAULT_SCREENER_FILTERS, both), { venue: 'all', volWindow: '1d' });
  const rising = { ...DEFAULT_SCREENER_FILTERS, preset: 'rising' as const };
  assert.deepEqual(screenerQuery(rising, both), { venue: 'all', preset: 'rising', volWindow: '1d' });
  assert.deepEqual(effectiveSort(rising), { sort: 'pnl', window: '7d' });
  const chosen = { ...rising, sort: 'roi' as const, window: '30d' as const, dir: 'asc' as const, minRoi: 10, minAccountValue: 100_000 };
  assert.deepEqual(screenerQuery(chosen, both, { offset: 100, limit: 100 }), {
    venue: 'all', preset: 'rising', volWindow: '1d', minAccountValue: '100000', minRoi: '10',
    window: '30d', sort: 'roi', dir: 'asc', limit: '100', offset: '100',
  });
  assert.deepEqual(effectiveSort(chosen), { sort: 'roi', window: '30d' });
  assert.equal(toSearch({ b: '2', a: '1' }), '?a=1&b=2', 'stable key order = stable cache key');
  assert.equal(toSearch({}), '');
});

test('PRESET_SORT mirrors the server PRESETS', () => {
  for (const [id, def] of Object.entries(PRESETS)) {
    const mine = PRESET_SORT[id as keyof typeof PRESET_SORT];
    assert.ok(mine, `client knows preset ${id}`);
    assert.equal(mine.sort, def.sort, `${id} sort`);
    assert.equal(mine.window, def.window, `${id} window`);
  }
  assert.deepEqual(Object.keys(PRESET_SORT).sort(), Object.keys(PRESETS).sort());
});

/* --- venue ordering ---------------------------------------------------------- */

const t = (venue: 'sodex' | 'hyperliquid', n: number) => ({ venue, address: `${venue}-${n}` });

test('interleaveVenues: SoDEX first, alternating, each venue in its own order, capped', () => {
  const rows = [t('hyperliquid', 1), t('hyperliquid', 2), t('hyperliquid', 3), t('sodex', 1), t('sodex', 2)];
  assert.deepEqual(
    interleaveVenues(rows, 4).map((r) => r.address),
    ['sodex-1', 'hyperliquid-1', 'sodex-2', 'hyperliquid-2'],
  );
  assert.deepEqual(
    interleaveVenues(rows, 10).map((r) => r.address),
    ['sodex-1', 'hyperliquid-1', 'sodex-2', 'hyperliquid-2', 'hyperliquid-3'],
    'the longer venue fills in once the shorter runs out',
  );
  assert.deepEqual(interleaveVenues([t('hyperliquid', 1), t('hyperliquid', 2)], 1).map((r) => r.address), ['hyperliquid-1']);
  assert.deepEqual(interleaveVenues([], 8), []);
});

test('sodexFirst keeps each group in order', () => {
  const rows = [t('hyperliquid', 1), t('sodex', 1), t('hyperliquid', 2), t('sodex', 2)];
  assert.deepEqual(sodexFirst(rows).map((r) => r.address), ['sodex-1', 'sodex-2', 'hyperliquid-1', 'hyperliquid-2']);
});

/* --- assets ----------------------------------------------------------------- */

const asset = (o: Partial<AssetRow> & Pick<AssetRow, 'key' | 'venue' | 'symbol' | 'base' | 'kind'>): AssetRow => ({
  engine: o.venue === 'sodex' ? (o.kind === 'spot' ? 'spot' : 'perps') : null,
  display: o.symbol,
  maxLeverage: null,
  price: null,
  changePct: null,
  volume24h: null,
  longShare: null,
  netUsd: null,
  traders: null,
  ...o,
});

test('baseOf: every symbol shape the venues use', () => {
  assert.equal(baseOf('BTC-USD'), 'BTC');
  assert.equal(baseOf('SOSO_USDC'), 'SOSO');
  assert.equal(baseOf('SOSO/USDC'), 'SOSO');
  assert.equal(baseOf('xyz:GOLD'), 'GOLD');
  assert.equal(baseOf('eth'), 'ETH');
});

test('positioning joins per venue and coin; spot never gets a perp positioning', () => {
  const idx = positioningIndex([
    { venue: 'sodex', symbol: 'BTC-USD', longUsd: 160_000, shortUsd: 40_000, longTraders: 13, shortTraders: 4 },
    { venue: 'hyperliquid', symbol: 'BTC', longUsd: 0, shortUsd: 500_000, longTraders: 0, shortTraders: 11 },
    { venue: 'hyperliquid', symbol: 'xyz:GOLD', longUsd: 30, shortUsd: 70, longTraders: 1, shortTraders: 2 },
  ] as never);
  const sodexBtc = withPositioning(asset({ key: 'perps:BTC-USD', venue: 'sodex', symbol: 'BTC-USD', base: 'BTC', kind: 'perp' }), idx);
  assert.equal(sodexBtc.longShare, 0.8);
  assert.equal(sodexBtc.netUsd, 120_000);
  assert.equal(sodexBtc.traders, 17);
  const hlBtc = withPositioning(hlAssetRow({ venue: 'hyperliquid', symbol: 'BTC', dex: '', price: 1, changePct: 0, volume24h: 1, openInterestUsd: 1, funding: 0, maxLeverage: 40 }), idx);
  assert.equal(hlBtc.longShare, 0, 'venues are not mixed: HL BTC is its own tracked accounts');
  const gold = withPositioning(hlAssetRow({ venue: 'hyperliquid', symbol: 'xyz:GOLD', dex: 'xyz', price: 1, changePct: 0, volume24h: 1, openInterestUsd: 1, funding: 0, maxLeverage: 20 }), idx);
  assert.equal(gold.display, 'GOLD');
  assert.equal(gold.longShare, 0.3);
  const spot = withPositioning(asset({ key: 'spot:BTC_USDC', venue: 'sodex', symbol: 'BTC_USDC', base: 'BTC', kind: 'spot' }), idx);
  assert.equal(spot.longShare, null);
});

test('filterAssets + sortAssets: category, venue, text, favorites; unknowns last both ways', () => {
  const rows = [
    asset({ key: 'perps:BTC-USD', venue: 'sodex', symbol: 'BTC-USD', base: 'BTC', kind: 'perp', volume24h: 47e6, changePct: 0.1 }),
    asset({ key: 'spot:SOSO_USDC', venue: 'sodex', symbol: 'SOSO_USDC', base: 'SOSO', kind: 'spot', volume24h: null, changePct: -3 }),
    asset({ key: 'hyperliquid:BTC', venue: 'hyperliquid', symbol: 'BTC', base: 'BTC', kind: 'perp', volume24h: 3.5e9, changePct: 0.5 }),
    asset({ key: 'hyperliquid:xyz:GOLD', venue: 'hyperliquid', symbol: 'xyz:GOLD', base: 'GOLD', kind: 'perp', volume24h: 1e8 }),
    asset({ key: 'perps:NVDA-USD', venue: 'sodex', symbol: 'NVDA-USD', base: 'NVDA', kind: 'perp', volume24h: 1e5 }),
  ];
  const both = { sodex: true, hyperliquid: true };
  const f = (o: Partial<Parameters<typeof filterAssets>[1]>) =>
    filterAssets(rows, { category: 'all', venues: both, q: '', favorites: [], ...o }).map((r) => r.key);
  assert.deepEqual(f({ q: 'btc' }), ['perps:BTC-USD', 'hyperliquid:BTC']);
  assert.deepEqual(f({ category: 'spot' }), ['spot:SOSO_USDC']);
  assert.deepEqual(f({ category: 'commodities' }), ['hyperliquid:xyz:GOLD']);
  assert.deepEqual(f({ category: 'stocks' }), ['perps:NVDA-USD']);
  assert.deepEqual(f({ category: 'favorites', favorites: ['perps:NVDA-USD'] }), ['perps:NVDA-USD']);
  assert.deepEqual(f({ venues: { sodex: false, hyperliquid: true } }), ['hyperliquid:BTC', 'hyperliquid:xyz:GOLD']);

  const byVol = sortAssets(rows, 'volume', 'desc').map((r) => r.key);
  assert.deepEqual(byVol, ['hyperliquid:BTC', 'hyperliquid:xyz:GOLD', 'perps:BTC-USD', 'perps:NVDA-USD', 'spot:SOSO_USDC']);
  assert.equal(sortAssets(rows, 'volume', 'asc').at(-1)!.key, 'spot:SOSO_USDC', 'unknown volume is last ascending too');
  assert.deepEqual(
    sodexFirst(sortAssets(rows, 'volume', 'desc')).map((r) => r.key),
    ['perps:BTC-USD', 'perps:NVDA-USD', 'spot:SOSO_USDC', 'hyperliquid:BTC', 'hyperliquid:xyz:GOLD'],
    'the Assets tab: tradeable SoDEX markets first, each group by volume',
  );
});

/* --- local lists ------------------------------------------------------------ */

test('pushFront dedupes by key and caps', () => {
  const k = (s: string) => s.toLowerCase();
  assert.deepEqual(pushFront(['a', 'b', 'c'], 'B', k, 3), ['B', 'a', 'c']);
  assert.deepEqual(pushFront(['a', 'b', 'c'], 'd', k, 3), ['d', 'a', 'b']);
});

test('readList / writeList survive broken, foreign and throwing storage', () => {
  const store = new Map<string, string>();
  const ok = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, v: string) => void store.set(key, v) };
  writeList('k', [1, 2], ok);
  assert.deepEqual(readList<number>('k', ok), [1, 2]);
  store.set('k', '{not json');
  assert.deepEqual(readList('k', ok), []);
  store.set('k', '{"a":1}');
  assert.deepEqual(readList('k', ok), [], 'a non-array is dropped');
  const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(readList('k', boom), []);
  assert.doesNotThrow(() => writeList('k', [1], boom));
  assert.deepEqual(readList('k', null), []);
});

test('isTraderRef / traderKey', () => {
  assert.equal(isTraderRef({ venue: 'sodex', address: A, at: 1 }), true);
  assert.equal(isTraderRef({ venue: 'kalshi', address: A, at: 1 }), false);
  assert.equal(isTraderRef({ venue: 'hyperliquid', address: '0x1234', at: 1 }), false);
  assert.equal(isTraderRef(null), false);
  assert.equal(traderKey({ venue: 'hyperliquid', address: A.toUpperCase().replace('0X', '0x') }), `hyperliquid:${A}`);
});

/* --- the type the rows are built from --------------------------------------- */

test('a server ScreenerRow is accepted by lastActiveLabel as is', () => {
  const row = { lastActive: null, activeWithin: '7d' } as Pick<ScreenerRow, 'lastActive' | 'activeWithin'>;
  assert.equal(lastActiveLabel(row, NOW), '< 7d');
});

/* --- the visible box a phone sheet is sized to -------------------------------- */

test('visibleViewportBox: nothing to do when the layout viewport is what is visible', () => {
  // Desktop: both sides exclude scrollbars, so they agree.
  assert.equal(visibleViewportBox({ scale: 1, offsetTop: 0, offsetLeft: 0, width: 1505, height: 950 }, { width: 1505, height: 950 }), null);
  // Sub-pixel noise is not a keyboard.
  assert.equal(visibleViewportBox({ scale: 1, offsetTop: 0.4, offsetLeft: 0, width: 390, height: 843.6 }, { width: 390, height: 844 }), null);
});

test('visibleViewportBox: the on-screen keyboard shortens the sheet to what is left above it', () => {
  // Android: the layout viewport keeps its height, the visual one shrinks.
  assert.deepEqual(
    visibleViewportBox({ scale: 1, offsetTop: 0, offsetLeft: 0, width: 390, height: 507.6 }, { width: 390, height: 844 }),
    { top: 0, left: 0, width: 390, height: 508 },
  );
  // iOS: the visual viewport is also scrolled down inside the layout one.
  assert.deepEqual(
    visibleViewportBox({ scale: 1, offsetTop: 120, offsetLeft: 0, width: 390, height: 480 }, { width: 390, height: 844 }),
    { top: 120, left: 0, width: 390, height: 480 },
  );
});

test('visibleViewportBox: a page wider than the screen does not push the sheet off it', () => {
  // 844x390 landscape phone whose page is 1164px wide: fixed elements would fill 1164x538.
  assert.deepEqual(
    visibleViewportBox({ scale: 1, offsetTop: 0, offsetLeft: 0, width: 844, height: 390 }, { width: 1164, height: 538 }),
    { top: 0, left: 0, width: 844, height: 390 },
  );
  // ...and follows it when the page is scrolled sideways.
  assert.deepEqual(
    visibleViewportBox({ scale: 1, offsetTop: 0, offsetLeft: 320, width: 844, height: 390 }, { width: 1164, height: 538 })?.left,
    320,
  );
});

test('visibleViewportBox: pinch-zoom is left alone', () => {
  assert.equal(visibleViewportBox({ scale: 2, offsetTop: 100, offsetLeft: 50, width: 195, height: 422 }, { width: 390, height: 844 }), null);
  assert.equal(visibleViewportBox({ scale: 0.725, offsetTop: 0, offsetLeft: 0, width: 1164, height: 538 }, { width: 1164, height: 538 }), null);
});
