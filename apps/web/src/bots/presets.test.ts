/**
 * The Bots page's strategies and presets (presets.ts): every preset makes a spec the engine accepts, a running
 * bot reads back as the draft it was made from, an edit sends only what changed, and the cost per $1M is
 * SoDEX's maker fee plus the 0.5 bp bot fee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlgoSpec, parseAlgoSpec, type MarketInfo } from '@copy-engine';
import { PRESETS, PRESET_VALUES, STRATEGIES, cheapestMakerMarkets, costPerMillion, draftFor, draftOfSpec, gridRange, patchOf, presetOf, specOf, strategyOf } from './presets';

const BTC = { tickSize: '1', makerFee: 0.00012 } as Pick<MarketInfo, 'tickSize' | 'makerFee'>;
const MARK = 78_000;

test('every strategy and preset makes a spec the engine accepts, as a bot, in practice by default', () => {
  for (const s of STRATEGIES) {
    for (const p of PRESETS) {
      const d = draftFor(s, p);
      const r = checkAlgoSpec(specOf(d, MARK));
      assert.ok(r.spec, `${s} ${p}: ${JSON.stringify(r.errors)}`);
      assert.equal(r.spec!.bot, true, `${s} ${p} is a bot`);
      assert.equal(r.spec!.paper, true, `${s} ${p} starts as practice`);
      assert.equal(strategyOf(r.spec!), s);
      assert.equal(presetOf(d), p);
    }
  }
});

test('a grid takes its range from the price, or its own prices; no price, no grid', () => {
  const d = draftFor('grid', 'balanced');
  assert.deepEqual(gridRange(d, 100), { low: 98, high: 102 });
  assert.equal(gridRange(d, null), null);
  assert.deepEqual(gridRange({ ...d, low: 90, high: 110 }, 100), { low: 90, high: 110 });
});

test('a running bot reads back as its draft; an edit sends only what changed', () => {
  const d = { ...draftFor('maker', 'balanced'), label: 'night' };
  const spec = parseAlgoSpec(specOf(d, MARK));
  const back = draftOfSpec(spec);
  for (const k of ['orderUsd', 'maxInventoryUsd', 'skewTicks', 'chaseTicks', 'minRepriceMs', 'maxLossUsd', 'onStop', 'label'] as const) assert.equal(back[k], d[k], k);
  assert.deepEqual(patchOf(back, { ...back, orderUsd: 80, label: ' ' }), { orderUsd: 80, label: null });
  assert.deepEqual(patchOf(back, back), {});
  // A grid's range and levels are what it is: never in a patch.
  const g = draftOfSpec(parseAlgoSpec(specOf(draftFor('grid'), MARK)));
  assert.deepEqual(Object.keys(patchOf(g, { ...g, levels: 30, low: 1, orderUsd: 40 })), ['orderUsd']);
});

test('cost per $1M: 1.2 bp maker + 0.5 bp bot fee = $170; the maker gets one tick a round trip back, a grid half a step per $1M', () => {
  const m = costPerMillion(draftFor('maker'), BTC, MARK);
  assert.equal(Math.round(m.trade), 120);
  assert.equal(Math.round(m.builder), 50);
  assert.equal(Math.round(m.fees), 170);
  // At the touch the spread gives one tick a round trip: BTC's $1 at $78,000 is 0.13 bp, $6.41 per $1M.
  assert.ok(Math.abs(m.edge! - 6.41) < 0.01, String(m.edge));
  assert.equal(costPerMillion({ ...draftFor('maker'), edgeBps: 2 }, BTC, MARK).edge, null, 'away from the touch: not counted');
  assert.equal(costPerMillion(draftFor('maker'), BTC, null).edge, null, 'no price: not counted');
  const g = costPerMillion(draftFor('grid', 'balanced'), BTC, MARK);
  assert.ok(g.edge !== null && g.edge > 0);
  // ±2% over 16 levels: steps of about 0.27%, half of it per $1M = about $1,330, net about -$1,160 (it earns).
  assert.ok(g.edge! > 1_200 && g.edge! < 1_450, String(g.edge));
  assert.ok(Math.abs(g.net - (170 - g.edge!)) < 1e-6);
  // Unknown market: SoDEX's tier-0 maker fee.
  assert.equal(Math.round(costPerMillion(draftFor('maker'), null, null).fees), 170);
});

test('the Bots page runs the volume maker and the grid only; a DCA is an algo order', () => {
  assert.deepEqual([...STRATEGIES], ['maker', 'grid']);
  assert.ok(checkAlgoSpec({ kind: 'dca', symbol: 'BTC-USD', side: 'buy', perOrderUsd: 20, orders: 3, intervalMs: 3_600_000, bot: true, exec: { style: 'maker' } }).errors.bot);
});

test('presets differ: each strategy\'s three are not the same', () => {
  for (const s of STRATEGIES) {
    const all = PRESETS.map((p) => JSON.stringify(PRESET_VALUES[s][p]));
    assert.equal(new Set(all).size, PRESETS.length, s);
  }
});

test('cheapest maker markets: a wide spread earns most of itself a round trip; thin or crazy markets left out', () => {
  const tick = (s: string) => ({ 'MCD-USD': 0.01, 'BTC-USD': 1, 'THIN-USD': 0.01, 'WILD-USD': 0.01 } as Record<string, number>)[s] ?? null;
  const r = cheapestMakerMarkets([
    { symbol: 'BTC-USD', bidPx: '78000', askPx: '78001', quoteVolume: '100000000' },
    { symbol: 'MCD-USD', bidPx: '263.00', askPx: '263.36', quoteVolume: '5000000' },
    { symbol: 'THIN-USD', bidPx: '10.00', askPx: '10.05', quoteVolume: '2000' },
    { symbol: 'WILD-USD', bidPx: '10.00', askPx: '10.20', quoteVolume: '9000000' },
  ], tick);
  assert.deepEqual(r.map((x) => x.symbol), ['MCD-USD', 'BTC-USD']);
  // MCD: 36 ticks of 0.38 bp = 13.7 bp; inside both sides it keeps 34 ticks, 12.9 bp a round trip: $170 - $646 = it earns.
  assert.ok(r[0]!.costPerMillion < -400 && r[0]!.costPerMillion > -520, String(r[0]!.costPerMillion));
  assert.ok(Math.abs(r[1]!.costPerMillion - 163.6) < 0.2, String(r[1]!.costPerMillion));
});
