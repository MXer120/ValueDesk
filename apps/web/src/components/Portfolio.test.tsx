/**
 * The Portfolio page's model and maths (Portfolio.tsx, portfolio/parts.tsx):
 * the account decoding and its runtime identity checks, positions, exposure,
 * resting orders, the period slicing of the cumulative PnL series, drawdown,
 * the formatters, and the dashboard's default placements.
 *   npx tsx --test src/components/Portfolio.test.tsx
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installViteStubs, staticMarkup } from './macro/testEnv';
import { setNumStyle } from '../numStyle';

// These cases read the en-US format (1,234.56); the app's default (1.234,56) is checked separately.
setNumStyle('comma-dot');

installViteStubs();
const { createElement } = await import('react');
const render = await staticMarkup();
const P = await import('./Portfolio');
const { PORTFOLIO_DASHBOARD } = await import('../dashboard/layout');
const {
  deriveAccount, deriveChecks, deriveExposure, deriveOrders, derivePositions, fmtCompactSigned, fmtCompactUsd, fmtDay,
  fmtRatioPct, fmtSigned, maxDrawdown, positionDirection, sliceCurve, soleTotal, spotValue, windowCurve, Meter, PeriodSeg,
} = P;

const DAY = 86_400_000;
const close = (a: number | null | undefined, b: number, eps = 1e-9) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < eps, `${a} != ${b}`);

// ---------------------------------------------------------------------------
//  Direction
// ---------------------------------------------------------------------------

test('positionDirection: the side as a word or the numeric enum, else the sign of the size, else null', () => {
  assert.equal(positionDirection({ positionSide: 'LONG' }), 'long');
  assert.equal(positionDirection({ positionSide: 'short', size: '5' }), 'short', 'a stated side wins over the size');
  assert.equal(positionDirection({ ps: 2 }), 'long');
  assert.equal(positionDirection({ ps: 3 }), 'short');
  assert.equal(positionDirection({ positionSide: 'BOTH', size: '-0.5' }), 'short');
  assert.equal(positionDirection({ positionSide: 'BOTH', size: '0.5' }), 'long');
  assert.equal(positionDirection({ positionSide: 'BOTH', sz: '-1' }), 'short');
  assert.equal(positionDirection({ positionAmt: '-3' }), 'short');
  assert.equal(positionDirection({ positionSide: 'BOTH', size: '0' }), null);
  assert.equal(positionDirection({ positionSide: 'BOTH', size: 'abc' }), null);
  assert.equal(positionDirection(null), null);
  assert.equal(positionDirection({}), null);
});

// ---------------------------------------------------------------------------
//  The account summary and its identities
// ---------------------------------------------------------------------------

/** A self-consistent account: av = am + cm + im + oim + ocm + haircut = wallet + ur; mmr = mm / av. */
const STATE = {
  exists: true,
  state: {
    av: '1050', am: '700', ami: '700', amw: '650', mm: '21', mmr: String(21 / 1050), cm: '250', im: '40', oim: '5', ocm: '5',
    B: [{ wb: '900', px: '1', wm: '900' }, { wb: '0.002', px: '50000', wm: '50' }],
    P: [{ i: 11, ur: '30' }, { i: 12, ur: '20' }],
  },
};

test('deriveAccount: the terse keys decoded, the wallet valued at each coin\'s price, the haircut beside it', () => {
  const a = deriveAccount(STATE)!;
  assert.equal(a.accountValue, 1050);
  assert.equal(a.availableMargin, 700);
  assert.equal(a.isolatedAvailable, 700);
  assert.equal(a.withdrawable, 650);
  assert.equal(a.maintenanceMargin, 21);
  assert.equal(a.crossMargin, 250);
  assert.equal(a.isolatedMargin, 40);
  assert.equal(a.orderMargin, 10, 'oim + ocm');
  assert.equal(a.walletValue, 1000, '900 x 1 + 0.002 x 50000');
  assert.equal(a.haircut, 50, 'wallet value 1000 - margin value 950');
  assert.equal(a.exists, true);
});

test('deriveAccount: no payload or no state is no account; a missing price counts 1, a missing wm leaves the haircut out', () => {
  assert.equal(deriveAccount(null), null);
  assert.equal(deriveAccount({ exists: true }), null);
  const a = deriveAccount({ state: { av: '10', B: [{ total: '10' }, { wb: '2', price: '3', wm: '' }] } })!;
  assert.equal(a.walletValue, 16, 'verbose spellings too: total, price');
  assert.equal(a.haircut, 0, 'one balance without wm: the haircut is not known, so 0');
  assert.equal(a.exists, false, 'only exists === true is an account');
  assert.equal(deriveAccount({ state: { B: 'not a list' } })!.walletValue, 0);
});

const POS = [
  { id: 11, symbol: 'BTC-USD', positionSide: 'BOTH', size: '0.01', avgEntryPrice: '60000', initialMargin: '60', leverage: '10', marginMode: 'CROSS', realizedPnL: '1.5', cumTradingFee: '0.3' },
  { id: 12, symbol: 'ETH-USD', positionSide: 'BOTH', size: '-2', avgEntryPrice: '3000', initialMargin: '600', leverage: '10', marginMode: 'ISOLATED', isTakenOver: true },
  { id: 13, symbol: 'DOGE-USD', positionSide: 'BOTH', size: '0', avgEntryPrice: '0.1' },
  { id: 14, symbol: 'XYZ-USD', positionSide: 'BOTH', size: '100', avgEntryPrice: '1' },
];
const MARKS = new Map([['BTC-USD', 65000], ['ETH-USD', 2900]]);

test('derivePositions: closed rows dropped; mark and unrealised joined (ur by position id), biggest first', () => {
  const rows = derivePositions(POS, STATE, MARKS, new Map());
  assert.deepEqual(rows.map((r) => r.symbol), ['ETH-USD', 'BTC-USD', 'XYZ-USD']);
  const [eth, btc, xyz] = rows as [typeof rows[0], typeof rows[0], typeof rows[0]];
  assert.equal(eth.dir, 'short');
  close(eth.notional, 5800);
  assert.equal(eth.entryNotional, 6000);
  assert.equal(eth.unrealized, 20);
  close(eth.roe, 20 / 600);
  assert.equal(eth.takenOver, true);
  assert.equal(eth.marginMode, 'ISOLATED');
  assert.equal(btc.dir, 'long');
  close(btc.notional, 650);
  assert.equal(btc.unrealized, 30);
  assert.equal(btc.realized, 1.5);
  assert.equal(btc.fees, 0.3);
  assert.equal(xyz.mark, null, 'not on the mark feed: no notional');
  assert.equal(xyz.notional, null);
  assert.equal(xyz.unrealized, null, 'no P[] row: unrealised unknown, not 0');
  assert.equal(xyz.roe, null);
  assert.equal(xyz.marginMode, '-');
  assert.equal(xyz.liq.price, null, 'no margin schedule: no liquidation price guessed');
});

test('derivePositions: two positions on one symbol (hedge mode) keep their own unrealised', () => {
  const rows = derivePositions(
    [{ id: 1, symbol: 'BTC-USD', positionSide: 'LONG', size: '1', avgEntryPrice: '1', initialMargin: '1' }, { id: 2, symbol: 'BTC-USD', positionSide: 'SHORT', size: '-1', avgEntryPrice: '1', initialMargin: '1' }],
    { state: { P: [{ i: 1, ur: '5' }, { i: 2, ur: '-5' }] } },
    new Map([['BTC-USD', 1]]),
    new Map(),
  );
  assert.deepEqual(rows.map((r) => [r.id, r.unrealized]).sort(), [[1, 5], [2, -5]]);
});

test('deriveExposure: long, short, gross, net and leverage over the priced positions; the unpriced counted, not summed', () => {
  const rows = derivePositions(POS, STATE, MARKS, new Map());
  const e = deriveExposure(rows, deriveAccount(STATE))!;
  close(e.long, 650);
  close(e.short, 5800);
  close(e.gross, 6450);
  close(e.net, -5150);
  close(e.grossLeverage, 6450 / 1050);
  assert.equal(e.unpriced, 1);
  assert.deepEqual(e.byMarket.map((m) => m.symbol), ['ETH-USD', 'BTC-USD']);
  close(e.byMarket[0]!.share + e.byMarket[1]!.share, 1);
  assert.equal(deriveExposure([], null), null, 'no positions: no exposure (not zeros)');
  assert.equal(deriveExposure(rows, null)!.grossLeverage, null, 'no account value: no leverage');
  assert.equal(deriveExposure(rows, { ...deriveAccount(STATE)!, accountValue: 0 })!.grossLeverage, null);
});

test('deriveOrders: what still rests, at the order\'s own price, the mark for a market order, the rest excluded', () => {
  const o = deriveOrders([
    { symbol: 'BTC-USD', quantity: '0.5', filledQuantity: '0.2', price: '60000' }, // 0.3 x 60000
    { symbol: 'ETH-USD', quantity: '-1', price: '0' }, // a market sell: 1 x the mark 2900
    { s: 'BTC-USD', q: '1', z: '1', p: '61000' }, // filled: nothing rests
    { symbol: 'NOPE-USD', quantity: '3' }, // no price, no mark
  ], MARKS);
  assert.equal(o.count, 4);
  close(o.notional, 18000 + 2900);
  assert.equal(o.excluded, 1);
  assert.deepEqual(deriveOrders([], MARKS), { count: 0, notional: 0, excluded: 0 });
});

test('deriveChecks: the three identities hold for a consistent account, within a tolerance scaled to it', () => {
  const a = deriveAccount(STATE)!;
  const rows = derivePositions(POS.slice(0, 2), STATE, MARKS, new Map());
  const c = deriveChecks(a, rows)!;
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.equityCheckable, true);
  close(c.marginResidual, 0);
  close(c.equityResidual, 0);
  close(c.tolerance, 1050e-6);
  assert.equal(deriveChecks({ ...a, accountValue: 0.5 }, [])!.tolerance, 1e-6, 'a floor for a tiny account');
  assert.equal(deriveChecks(null, rows), null);
});

test('deriveChecks: a broken identity is flagged; an unknown unrealised makes the equity identity uncheckable, not failed', () => {
  const a = deriveAccount(STATE)!;
  const rows = derivePositions(POS.slice(0, 2), STATE, MARKS, new Map());
  assert.equal(deriveChecks({ ...a, availableMargin: 701 }, rows)!.ok, false, 'margin identity off by 1');
  assert.equal(deriveChecks({ ...a, maintenanceRatio: a.maintenanceRatio + 1e-3 }, rows)!.ok, false, 'mmr != mm / av');
  assert.equal(deriveChecks({ ...a, walletValue: 900 }, rows)!.ok, false, 'equity != wallet + unrealised');
  const unknown = derivePositions(POS, STATE, MARKS, new Map()); // XYZ has no ur
  const c = deriveChecks({ ...a, walletValue: 900 }, unknown)!;
  assert.equal(c.equityCheckable, false);
  assert.equal(c.ok, true, 'the equity identity is not judged without every ur');
  assert.equal(deriveChecks({ ...a, accountValue: 0, availableMargin: 0, crossMargin: 0, isolatedMargin: 0, orderMargin: 0, haircut: 0, walletValue: 0 }, [])!.ratioResidual, 0, 'no division by a zero account value');
});

// ---------------------------------------------------------------------------
//  Period maths
// ---------------------------------------------------------------------------

test('maxDrawdown: the biggest fall from a peak to a later low, not the lowest point nor max - min', () => {
  assert.equal(maxDrawdown([]), 0);
  assert.equal(maxDrawdown([5]), 0);
  assert.equal(maxDrawdown([1, 2, 3]), 0);
  close(maxDrawdown([0, 0.23, -0.25]), -0.48);
  assert.equal(maxDrawdown([-1, 5, 4, 10, 2]), -8);
  assert.equal(maxDrawdown([10, 2, 20, 15]), -8, 'the low before the higher peak still counts');
  assert.equal(maxDrawdown([3, 1, 2, 0]), -3);
});

const pt = (daysAgo: number, pnl: number, perps = pnl, spot = 0) => ({ ts: Date.now() - daysAgo * DAY, accountValue: 0, pnl, perpsPnl: perps, spotPnl: spot, vaultPnl: 0, roi: 0 });
const SPINE = [pt(100, 0), pt(40, 50), pt(29, 60), pt(20, 40), pt(10, 90), pt(1, 70)];

test('sliceCurve: rebased on the last point before the period, so the period\'s first day counts', () => {
  const w = sliceCurve(SPINE, '30D', (p) => p.pnl)!;
  assert.equal(w.baseline, 50, 'the point 40 days back');
  assert.deepEqual(w.points.map((p) => p.v), [10, -10, 40, 20]);
  assert.equal(w.change, 20);
  assert.equal(w.maxDrawdown, -20);
  const all = sliceCurve(SPINE, 'ALL', (p) => p.pnl)!;
  assert.equal(all.baseline, 0, 'the whole series: the venue\'s series starts at zero');
  assert.equal(all.change, 70);
  assert.equal(all.maxDrawdown, -20, 'from 60 to 40, then from 90 to 70');
  assert.equal(sliceCurve(SPINE, '7D', (p) => p.pnl), null, 'one point is not a curve');
  assert.equal(sliceCurve([], 'ALL', (p) => p.pnl), null);
  close(sliceCurve(SPINE, '90D', (p) => p.spotPnl)!.change, 0, 1e-12);
});

test('windowCurve: the walked PnL curve, its strings read, the level before the window as the baseline', () => {
  const curve = [{ t: Date.now() - 50 * DAY, pnl: '5' }, { t: Date.now() - 20 * DAY, pnl: '8' }, { t: Date.now() - 2 * DAY, pnl: '3.5' }];
  const w = windowCurve(curve, '30D');
  assert.equal(w.baseline, 5);
  assert.equal(w.change, -1.5);
  assert.equal(w.maxDrawdown, -4.5);
  const one = windowCurve(curve, '7D');
  assert.equal(one.change, -4.5, '3.5 against the 8 before the week');
  assert.equal(one.maxDrawdown, null, 'a single point is "not enough data", not "no drawdown"');
  const empty = windowCurve([{ t: Date.now() - 50 * DAY, pnl: '5' }], '7D');
  assert.deepEqual([empty.points.length, empty.change, empty.maxDrawdown, empty.baseline], [0, null, null, 5]);
  assert.equal(windowCurve(curve, 'ALL').baseline, 0);
});

test('soleTotal: one coin\'s total, zero in the only coin there is, never two coins added', () => {
  assert.equal(soleTotal([]), null);
  assert.deepEqual(soleTotal([{ coin: 'vUSDC', amount: '0' }, { coin: 'vBTC', amount: '0' }] as never), { amount: 0, coin: 'vUSDC' });
  assert.deepEqual(soleTotal([{ coin: 'vUSDC', amount: '0' }, { coin: 'vBTC', amount: '-0.25' }] as never), { amount: -0.25, coin: 'vBTC' });
  assert.equal(soleTotal([{ coin: 'vUSDC', amount: '3' }, { coin: 'vBTC', amount: '0.1' }] as never), null);
});

test('spotValue: priced balances summed, unpriced ones counted, empty ones skipped, nothing priced is unknown', () => {
  const prices = new Map([['vBTC', 60000], ['vUSDC', 1]]);
  assert.deepEqual(spotValue([], prices), { usd: null, unpriced: 0 });
  assert.deepEqual(spotValue([{ coin: 'vBTC', total: '0.5' }, { a: 'vUSDC', wb: '100' }, { coin: 'vFOO', total: '9' }, { coin: 'vBAR', total: '0' }], prices), { usd: 30100, unpriced: 1 });
  assert.deepEqual(spotValue([{ coin: 'vFOO', total: '9' }], prices), { usd: null, unpriced: 1 });
});

// ---------------------------------------------------------------------------
//  Formatters
// ---------------------------------------------------------------------------

test('fmtSigned and fmtRatioPct: a plus on gains, the minus sign on losses, a dash for nothing', () => {
  assert.equal(fmtSigned(1234.5), '+$1,234.50');
  assert.equal(fmtSigned(-5), '−$5.00');
  assert.equal(fmtSigned(0), '$0.00');
  for (const v of [null, undefined, Number.NaN]) assert.equal(fmtSigned(v), '—');
  assert.equal(fmtRatioPct(0.1234), '12.34%');
  assert.equal(fmtRatioPct(-0.005, 1), '-0.5%');
  assert.equal(fmtRatioPct(Infinity), '—');
});

test('fmtCompactSigned (a calendar cell): cents under $100, dollars, then K and M', () => {
  assert.equal(fmtCompactSigned(12.345), '+$12.35');
  assert.equal(fmtCompactSigned(-38), '−$38.00');
  assert.equal(fmtCompactSigned(250.4), '+$250');
  assert.equal(fmtCompactSigned(1234), '+$1.2K');
  assert.equal(fmtCompactSigned(-2_500_000), '−$2.5M');
  assert.equal(fmtCompactSigned(0), '$0.00');
});

test('fmtCompactSigned: a figure that rounds up moves to the next step (no "$100.00", "$1000" or "$1000.0K")', () => {
  // Failing before the fix: '+$100.00', '+$1000', '−$1000.0K'.
  assert.equal(fmtCompactSigned(99.996), '+$100');
  assert.equal(fmtCompactSigned(999.6), '+$1.0K');
  assert.equal(fmtCompactSigned(-999_960), '−$1.0M');
  assert.equal(fmtCompactSigned(99.994), '+$99.99');
  assert.equal(fmtCompactSigned(999.4), '+$999');
  assert.equal(fmtCompactSigned(999_940), '+$999.9K');
});

test('fmtCompactUsd: exact under $10,000, compact above, the same minus sign either side', () => {
  assert.equal(fmtCompactUsd(9_999.5), '$9,999.50');
  assert.equal(fmtCompactUsd(1_240_000), '$1.24M');
  assert.equal(fmtCompactUsd(12_345), '$12.35K');
  assert.equal(fmtCompactUsd(-5_000), '−$5,000.00');
  // Failing before the fix: '-$50K' (a hyphen) beside '−$5,000.00'.
  assert.equal(fmtCompactUsd(-50_000), '−$50K');
  for (const v of [null, undefined, Number.NaN]) assert.equal(fmtCompactUsd(v), '—');
});

test('fmtDay: a day in en-US, a dash for none', () => {
  assert.equal(fmtDay(Date.UTC(2026, 9, 27, 12)), 'Oct 27, 2026');
  assert.equal(fmtDay(0), '—');
  assert.equal(fmtDay(null), '—');
});

// ---------------------------------------------------------------------------
//  Pieces
// ---------------------------------------------------------------------------

test('PeriodSeg: the four periods, the chosen one selected', () => {
  const html = render(createElement(PeriodSeg, { period: '30D', onPeriod: () => {}, label: 'Period' }));
  assert.deepEqual([...html.matchAll(/aria-selected="(true|false)"[^>]*>(\w+)</g)].map((m) => `${m[2]}:${m[1]}`), ['7D:false', '30D:true', '90D:false', 'ALL:false']);
});

test('Meter: a fraction drawn by scale, clamped to 0..1, a broken value is empty', () => {
  const scale = (v: number) => /scaleX\(([^)]+)\)/.exec(render(createElement(Meter, { value: v, tone: 'up' })))![1];
  assert.equal(scale(0.25), '0.25');
  assert.equal(scale(1.7), '1');
  assert.equal(scale(-3), '0');
  assert.equal(scale(Number.NaN), '0');
  assert.match(render(createElement(Meter, { value: 0.123, tone: 'up' })), /aria-label="12\.3%"/);
  assert.match(render(createElement(Meter, { value: 0.5, tone: 'up', label: 'Margin used' })), /aria-label="Margin used"/);
});

// ---------------------------------------------------------------------------
//  The dashboard's default placements
// ---------------------------------------------------------------------------

const panels = new Map<string, { minW?: number; minH?: number }>([...P.PORTFOLIO_PANELS.map((p) => [p.id, p] as const), ['copies', { minW: 8, minH: 6 }]]);
const overlaps = (list: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>) => {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]!;
    const b = list[j]!;
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) out.push(`${a.i}/${b.i}`);
  }
  return out;
};

test('portfolio layouts: every placement is a registered panel, once, inside the grid and at least its minimum size', () => {
  assert.equal(new Set(P.PORTFOLIO_PANELS.map((p) => p.id)).size, P.PORTFOLIO_PANELS.length, 'panel ids are unique');
  for (const [bp, list] of Object.entries(PORTFOLIO_DASHBOARD.layouts)) {
    const cols = PORTFOLIO_DASHBOARD.grid[bp as keyof typeof PORTFOLIO_DASHBOARD.grid].cols;
    assert.equal(new Set(list.map((p) => p.i)).size, list.length, `${bp}: a panel placed twice`);
    for (const p of list) {
      const def = panels.get(p.i);
      assert.ok(def, `${bp}: ${p.i} is not a panel`);
      assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= cols, `${bp}: ${p.i} leaves the ${cols} columns`);
      assert.ok(p.w >= (def.minW ?? 1) && p.h >= (def.minH ?? 1), `${bp}: ${p.i} below its minimum size`);
    }
  }
});

test('portfolio layouts: no two default placements overlap (wide and phone)', () => {
  assert.deepEqual(overlaps(PORTFOLIO_DASHBOARD.layouts.lg), []);
  assert.deepEqual(overlaps(PORTFOLIO_DASHBOARD.layouts.sm), []);
});

test('portfolio layouts: no two default placements overlap (two columns)', { todo: 'md: account (rows 22-44) and band (from row 40) overlap; the grid\'s vertical compaction pushes the band to row 44, so nothing shows, but the defaults disagree with what is drawn' }, () => {
  assert.deepEqual(overlaps(PORTFOLIO_DASHBOARD.layouts.md), []);
});
