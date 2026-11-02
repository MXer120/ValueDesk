/**
 * The Bots page's strategies and presets (presets.ts): every preset makes a spec the engine accepts, a running
 * bot reads back as the draft it was made from, an edit sends only what changed, and the cost per $1M is
 * SoDEX's maker fee plus the 0.5 bp bot fee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlgoSpec, parseAlgoSpec, type MarketInfo } from '@copy-engine';
import { PRESETS, PRESET_VALUES, STRATEGIES, costPerMillion, draftFor, draftOfSpec, gridRange, patchOf, presetOf, specOf, strategyOf } from './presets';

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

test('a DCA bot rests only (maker), never takes', () => {
  const s = parseAlgoSpec(specOf(draftFor('dca', 'active'), MARK));
  assert.ok(s.kind === 'dca' && s.exec.style === 'maker');
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
  // A DCA bot's schedule is what it is: only its name.
  const c = draftOfSpec(parseAlgoSpec(specOf(draftFor('dca'), MARK)));
  assert.deepEqual(patchOf(c, { ...c, perOrderUsd: 99, label: 'x' }), { label: 'x' });
});

test('cost per $1M: 1.2 bp maker + 0.5 bp bot fee = $170; a grid earns half a step per $1M', () => {
  const m = costPerMillion(draftFor('maker'), BTC, MARK);
  assert.equal(Math.round(m.trade), 120);
  assert.equal(Math.round(m.builder), 50);
  assert.equal(Math.round(m.fees), 170);
  assert.equal(m.edge, null);
  const g = costPerMillion(draftFor('grid', 'balanced'), BTC, MARK);
  assert.ok(g.edge !== null && g.edge > 0);
  // ±2% over 16 levels: steps of about 0.27%, half of it per $1M = about $1,330, net about -$1,160 (it earns).
  assert.ok(g.edge! > 1_200 && g.edge! < 1_450, String(g.edge));
  assert.ok(Math.abs(g.net - (170 - g.edge!)) < 1e-6);
  // Unknown market: SoDEX's tier-0 maker fee.
  assert.equal(Math.round(costPerMillion(draftFor('dca'), null, null).fees), 170);
});

test('presets differ: each strategy\'s three are not the same', () => {
  for (const s of STRATEGIES) {
    const all = PRESETS.map((p) => JSON.stringify(PRESET_VALUES[s][p]));
    assert.equal(new Set(all).size, PRESETS.length, s);
  }
});
