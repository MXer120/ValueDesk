/**
 * The Bots page's strategies and presets (presets.ts): every preset makes a spec the engine accepts, a running
 * bot reads back as the draft it was made from, an edit sends only what changed, and the cost per $1M is
 * SoDEX's maker fee plus the 0.1 bp bot fee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlgoSpec, parseAlgoSpec, type AlgoSpec, type MarketInfo } from '@copy-engine';
import { PRESETS, PRESET_VALUES, STRATEGIES, botNeedUsd, chartHours, chartWindows, cheapestMakerMarkets, clampLeverage, costPerMillion, draftFor, draftOfSpec, gridRange, isChartWindow, leverageCap, minQuoteUsd, offWords, patchOf, planMarkets, presetOf, refusalOf, runHoursLeft, specOf, autoLeverage, strategyOf, type MarketPlan } from './presets';
import { draftOfRecipe, recipeOfDraft } from './recipes';

const BTC = { tickSize: '1', makerFee: 0.00012 } as Pick<MarketInfo, 'tickSize' | 'makerFee'>;
const MARK = 78_000;

test('every strategy and preset makes a spec the engine accepts, as a bot, in practice by default', () => {
  for (const s of STRATEGIES) {
    for (const p of PRESETS) {
      const d = draftFor(s, p);
      const r = checkAlgoSpec(specOf(d, MARK));
      assert.ok(r.spec, `${s} ${p}: ${JSON.stringify(r.errors)}`);
      assert.equal(r.spec!.bot, true, `${s} ${p} is a bot`);
      assert.equal(r.spec!.paper, false, `${s} ${p} starts as real (owner 2026-11-10)`);
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

test('cost per $1M: 1.2 bp maker + 0.1 bp bot fee = $130; the maker gets one tick a round trip back, a grid half a step per $1M', () => {
  const m = costPerMillion(draftFor('maker'), BTC, MARK);
  assert.equal(Math.round(m.trade), 120);
  assert.equal(Math.round(m.builder), 10);
  assert.equal(Math.round(m.fees), 130);
  // At the touch the spread gives one tick a round trip: BTC's $1 at $78,000 is 0.13 bp, $6.41 per $1M.
  assert.ok(Math.abs(m.edge! - 6.41) < 0.01, String(m.edge));
  assert.equal(costPerMillion({ ...draftFor('maker'), edgeBps: 2 }, BTC, MARK).edge, null, 'away from the touch: not counted');
  assert.equal(costPerMillion(draftFor('maker'), BTC, null).edge, null, 'no price: not counted');
  const g = costPerMillion(draftFor('grid', 'balanced'), BTC, MARK);
  assert.ok(g.edge !== null && g.edge > 0);
  // ±2% over 16 levels: steps of about 0.27%, half of it per $1M = about $1,330, net about -$1,160 (it earns).
  assert.ok(g.edge! > 1_200 && g.edge! < 1_450, String(g.edge));
  assert.ok(Math.abs(g.net - (130 - g.edge!)) < 1e-6);
  // Unknown market: SoDEX's tier-0 maker fee.
  assert.equal(Math.round(costPerMillion(draftFor('maker'), null, null).fees), 130);
});

test('a new bot is the market maker (R10) or the grid; a DCA is an algo order', () => {
  assert.deepEqual([...STRATEGIES], ['market', 'grid']);
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
  // MCD: 36 ticks of 0.38 bp = 13.7 bp; inside both sides it keeps 34 ticks, 12.9 bp a round trip: $130 - $646 = it earns.
  assert.ok(r[0]!.costPerMillion < -440 && r[0]!.costPerMillion > -560, String(r[0]!.costPerMillion));
  assert.ok(Math.abs(r[1]!.costPerMillion - 123.6) < 0.2, String(r[1]!.costPerMillion));
});

test('Binance-led maker: a volume maker with ref binance; its distances only above 0; reads back as itself', () => {
  const d = { ...draftFor('lead', 'balanced', 'ETH-USD'), paper: true };
  const spec = specOf(d, 2280);
  assert.equal(spec.kind, 'mm');
  assert.equal(spec.ref, 'binance');
  assert.equal(spec.pullBps, 0.5);
  assert.equal(spec.refBps, undefined, 'refBps 0 is left out');
  const parsed = parseAlgoSpec(spec);
  assert.equal(strategyOf(parsed), 'lead');
  const back = draftOfSpec(parsed);
  assert.equal(back.strategy, 'lead');
  assert.equal(back.pullBps, 0.5);
  assert.deepEqual(patchOf(back, { ...back, pullBps: 1, refBps: 2 }), { pullBps: 1, refBps: 2 });
  // A plain maker stays a plain maker.
  assert.equal(strategyOf(parseAlgoSpec(specOf(draftFor('maker'), 60_000))), 'maker');
});

test('market maker: R10 by default, the gate a switch, and a running one patches only what changed', () => {
  const d = draftFor('market', 'steady', 'ETH-USD');
  const spec = specOf(d, 3000) as Record<string, unknown>;
  assert.equal(spec.kind, 'mm');
  assert.equal(spec.ref, 'binance');
  assert.equal(spec.restMs, 10_000);
  assert.equal(spec.chaseTicks, 40);
  assert.equal(spec.offsetTicks, 0);
  assert.equal(spec.skewTicks, 0);
  assert.equal(spec.stillBps, undefined, 'gate off by default');
  const gated = specOf({ ...d, gate: true }, 3000) as Record<string, unknown>;
  assert.equal(gated.stillBps, 12);
  assert.equal(gated.stillMs, 60_000);
  const parsed = parseAlgoSpec(gated);
  assert.equal(strategyOf({ ...parsed, bot: true } as never), 'market');
  const back = draftOfSpec(parsed);
  assert.equal(back.strategy, 'market');
  assert.equal(back.gate, true);
  assert.deepEqual(patchOf(back, { ...back, gate: false }), { stillBps: 0 });
  assert.deepEqual(patchOf(back, { ...back, restS: 20 }), { restMs: 20_000 });
  assert.deepEqual(patchOf({ ...back, gate: false }, { ...back, gate: true }), { stillBps: 12, stillMs: 60_000 });
});

/* ---------------------------------------------------- launch audit A4 / B (2026-11-08) ----- */

const mkt = (o: Partial<MarketInfo> = {}): MarketInfo => ({
  id: 1, name: 'BTC-USD', base: 'BTC', tickSize: '1', stepSize: '0.0001', minQuantity: '0.0001', maxQuantity: '100', marketMaxQuantity: null,
  minNotional: 5, maxNotional: null, maxLeverage: 20, makerFee: 0.00012, ...o,
} as MarketInfo);

test('a grid carries its run time and spread limit; a restart reads the end time back as the hours left (rounded up)', () => {
  const now = 1_800_000_000_000;
  const d = { ...draftFor('grid', 'balanced'), runHours: 8, maxSpreadBps: 30 };
  const spec = specOf(d, MARK);
  assert.ok(typeof spec.endAt === 'number' && Math.abs((spec.endAt as number) - Date.now() - 8 * 3_600_000) < 5_000, String(spec.endAt));
  assert.equal(spec.maxSpreadBps, 30);
  assert.equal(spec.quiet, undefined, 'a grid never carries trading hours');
  const parsed = parseAlgoSpec(spec) as Extract<AlgoSpec, { kind: 'grid' }>;
  assert.equal(parsed.endAt, spec.endAt);
  assert.equal(parsed.maxSpreadBps, 30);
  const back = draftOfSpec({ ...parsed, endAt: now + 7.2 * 3_600_000 }, now);
  assert.equal(back.runHours, 8, '7.2 h left rounds up to 8');
  assert.equal(back.maxSpreadBps, 30);
  // No spread limit stays none on the way back (it used to come back as 20).
  assert.equal(draftOfSpec(parseAlgoSpec(specOf({ ...d, maxSpreadBps: null }, MARK)), now).maxSpreadBps, null);
  // An end already past: no run time.
  assert.equal(draftOfSpec({ ...parsed, endAt: now - 1 }, now).runHours, null);
  assert.equal(runHoursLeft(now + 1, now), 1);
});

test('the market maker and the book maker keep their end time and spread limit through a restart', () => {
  const now = 1_800_000_000_000;
  for (const r of ['r10', 'touch'] as const) {
    const d = { ...draftOfRecipe(r, 'ETH-USD'), runHours: 24, maxSpreadBps: 10 };
    const spec = specOf(d, 3000);
    assert.equal(spec.maxSpreadBps, 10, r);
    const back = draftOfSpec({ ...parseAlgoSpec(spec), endAt: now + 23.5 * 3_600_000 } as never, now);
    assert.equal(back.runHours, 24, r);
    assert.equal(back.maxSpreadBps, 10, r);
  }
});

test('a preset change keeps every setting that is not the preset\'s: leverage, news, hours (and trade-only), flow gate, target, on stop, loss limit, run time', () => {
  const mine = {
    ...draftOfRecipe('r10', 'ETH-USD'), leverage: 5, news: { beforeMin: 5, afterMin: 30, level: 'medium' as const },
    quiet: [{ from: '14:00', to: '16:00', zone: 'utc' as const, days: 'all' as const }], quietOnly: true,
    flowOn: true, flowMinUsd: 500_000, flowWindowMin: 30, flowAction: 'shrink' as const, flowShrink: 0.25,
    volumeTargetUsd: 250_000, onStop: 'keep' as const, maxLossUsd: 7, runHours: 8, orderUsd: 80, maxInventoryUsd: 240, maxSpreadBps: 50, label: 'night', paper: false,
  };
  for (const id of ['r10g', 's1', 'n5', 'n5g', 'touch'] as const) {
    const x = draftOfRecipe(id, 'ETH-USD', mine);
    for (const k of ['leverage', 'news', 'quiet', 'quietOnly', 'flowOn', 'flowMinUsd', 'flowWindowMin', 'flowAction', 'flowShrink', 'volumeTargetUsd', 'onStop', 'maxLossUsd', 'runHours', 'orderUsd', 'maxInventoryUsd', 'maxSpreadBps', 'label', 'paper'] as const) {
      assert.deepEqual(x[k], mine[k], `${id} ${k}`);
    }
    assert.equal(recipeOfDraft(x), id, `${id} is itself`);
  }
  // To a grid: its own sizes (per level), the rest kept.
  const g = draftOfRecipe('grid', 'ETH-USD', mine);
  assert.equal(g.orderUsd, draftFor('grid').orderUsd);
  assert.equal(g.leverage, 5);
  assert.equal(g.runHours, 8);
});

test('leverage: under the market\'s maximum and the region\'s ceiling; none before the maximum is known; its start only once the account answered', () => {
  assert.equal(leverageCap(null, null), null, 'unknown maximum: no slider');
  assert.equal(leverageCap(50, null), 50);
  assert.equal(leverageCap(50, 2), 2, 'EEA 2x');
  assert.equal(leverageCap(1, 2), 1);
  // Auto (owner 2026-11-08): the lowest leverage at which the margin fits the free account with a tenth to spare.
  assert.equal(autoLeverage(300, 1000, 20), 1, 'fits at 1x');
  assert.equal(autoLeverage(300, 100, 20), 4, '300 / 90 -> 4x');
  assert.equal(autoLeverage(300, 10, 20), 20, 'capped by the market');
  assert.equal(autoLeverage(300, null, 20), 1, 'practice or no wallet');
  assert.equal(autoLeverage(300, 100, null), null, 'market maximum unknown');
  assert.equal(clampLeverage(20, 5), 5);
  assert.equal(clampLeverage(null, 5), null);
});

test('several markets: each checked with its own price and rules before anything is signed; leverage per market; an order under the minimum refused; margin on the real quote', () => {
  const d = { ...draftOfRecipe('r10', 'BTC-USD'), orderUsd: 12, maxInventoryUsd: 300, leverage: 10, paper: false };
  const markets: Record<string, { market: MarketInfo; price: number; maxLeverage: number }> = {
    // BTC: minimum 0.0001 BTC ($5 minimum value) = $7.80: $12 goes out as it is.
    'BTC-USD': { market: mkt(), price: 78_000, maxLeverage: 20 },
    // A market whose smallest quote is $100: $12 goes out at $100, the margin counts $100.
    'BIG-USD': { market: mkt({ name: 'BIG-USD', base: 'BIG', tickSize: '0.01', stepSize: '1', minQuantity: '1', minNotional: 10 }), price: 100, maxLeverage: 5 },
  };
  const plans = planMarkets(d, ['BTC-USD', 'BIG-USD'], (s) => ({ ...markets[s]!, maxLeverage: markets[s]!.maxLeverage }), { paper: false, mark: 78_000 });
  assert.equal(plans.length, 2);
  const [btc, big] = plans as [MarketPlan, MarketPlan];
  assert.deepEqual(btc.errors, []);
  assert.deepEqual(btc.notes, []);
  assert.equal(btc.quoteUsd, 12);
  assert.equal(btc.spec!.leverage, 10);
  assert.equal(big.spec!.leverage, 5, 'clamped to that market\'s maximum');
  // An order under the market's minimum cannot be started (owner 2026-11-08): no silent raise.
  assert.ok(big.errors.some((e) => /under SoDEX's minimum order on BIG/.test(e)), JSON.stringify(big.errors));
  assert.equal(big.quoteUsd, 100);
  // BTC: (300 + 2 x 12) / 10 = 32.4; BIG at the real $100 quote: (300 + 2 x 100) / 5 = 100.
  assert.ok(Math.abs(btc.marginUsd - 32.4) < 1e-9, String(btc.marginUsd));
  assert.ok(Math.abs(big.marginUsd - 100) < 1e-9, String(big.marginUsd));
  // A max holding under one real quote is refused on that market (engine checkSizes), before anything is signed.
  const small = planMarkets({ ...d, maxInventoryUsd: 24 }, ['BTC-USD', 'BIG-USD'], (s) => markets[s]!, { paper: false, mark: 78_000 });
  assert.deepEqual(small[0]!.errors, []);
  assert.ok(small[1]!.errors.length > 0, 'BIG: $24 cap under a $100 quote');
  // A size SoDEX refuses on one market shows on that market.
  const huge = planMarkets({ ...d, orderUsd: 50_000, maxInventoryUsd: 100_000 }, ['BIG-USD'], (s) => ({ ...markets[s]!, market: mkt({ ...markets[s]!.market, maxQuantity: '100' }) }), { paper: false });
  assert.ok(huge[0]!.errors.length > 0, 'over the largest order');
});

test('the margin counted for a bot: botMarginUsd on the real quote, the leverage under the ceiling', () => {
  const spec = parseAlgoSpec(specOf({ ...draftOfRecipe('r10', 'BTC-USD'), orderUsd: 12, maxInventoryUsd: 24, leverage: 3 }, MARK));
  assert.ok(Math.abs(botNeedUsd(spec) - 16) < 1e-9);
  assert.ok(Math.abs(botNeedUsd(spec, 100) - 224 / 3) < 1e-9, '(24 + 2 x 100) / 3');
  assert.ok(Math.abs(botNeedUsd(spec, 0, 2) - 24) < 1e-9, 'EEA: counted at 2x');
  assert.ok(Math.abs(minQuoteUsd(mkt(), 78_000) - 7.8) < 1e-9, '0.0001 BTC at $78,000 (over the $5 minimum)');
  assert.ok(Math.abs(minQuoteUsd(mkt({ minNotional: 10 }), 78_000) - 15.6) < 1e-9, '$10 minimum: two steps');
});

test('an executor refusal reads as a sentence with the one thing to do', () => {
  assert.equal(refusalOf('key', 'x').action, 'setup');
  assert.equal(refusalOf('account', 'x').action, 'deposit');
  assert.equal(refusalOf('margin', 'x').label, 'Deposit');
  assert.equal(refusalOf('bot-market', 'x').label, 'Stop the other bot');
  assert.equal(refusalOf('paper-only', 'x').label, 'Ask on Discord');
  assert.equal(refusalOf('beta', 'x').label, 'Ask on Discord');
  assert.equal(refusalOf('live-cap', 'x').action, 'practice');
  assert.equal(refusalOf('bot-capacity', 'x').action, 'practice');
  assert.equal(refusalOf('vip-moving', 'x').action, null);
  assert.equal(refusalOf('limit', 'x').action, 'stop-other');
  assert.equal(refusalOf('move', 'x').action, null);
  assert.ok(!/beta\.valuedesk|algo order|copy/i.test(refusalOf('paper-only', 'Real bots run on beta.valuedesk.so').text));
  assert.deepEqual(refusalOf('weird', 'Something odd.'), { text: 'Something odd.', action: null, label: null });
});

test('trading hours chart: a half-hour zone (UTC+5:30) keeps its half hour; whole-hour zones unchanged', () => {
  // 14:00-16:00 in India (UTC+5:30) is 08:30-10:30 UTC.
  const w = chartWindows(new Set([14, 15]), 330);
  assert.deepEqual(w, [{ from: '08:30', to: '10:30', zone: 'utc', days: 'all' }]);
  assert.ok(isChartWindow(w[0]!, 330));
  assert.ok(!isChartWindow(w[0]!, 60), 'not on a UTC+1 hour');
  assert.deepEqual([...chartHours(w, 330)].sort((a, b) => a - b), [14, 15]);
  // UTC+1: 14-16 local is 13:00-15:00 UTC; across midnight joins.
  assert.deepEqual(chartWindows(new Set([14, 15]), 60), [{ from: '13:00', to: '15:00', zone: 'utc', days: 'all' }]);
  assert.deepEqual(chartWindows(new Set([23, 0]), 0), [{ from: '23:00', to: '01:00', zone: 'utc', days: 'all' }]);
  assert.equal(offWords(330), 'UTC+5:30');
  assert.equal(offWords(-240), 'UTC−4');
  assert.equal(offWords(0), 'UTC+0');
});

test('chart hours in the own zone of the viewer (owner 2026-11-08): stored as the clock of that zone, read back the same, UTC ones from before still read', () => {
  const w = chartWindows(new Set([9, 10, 11]), 60, 'Europe/Berlin');
  assert.deepEqual(w, [{ from: '09:00', to: '12:00', zone: 'Europe/Berlin', days: 'all' }]);
  assert.ok(isChartWindow(w[0]!, 60, 'Europe/Berlin'));
  assert.deepEqual([...chartHours(w, 120, 'Europe/Berlin')].sort((a, b) => a - b), [9, 10, 11], 'the same hours after the clock change');
  const old = chartWindows(new Set([9]), 60);
  assert.deepEqual([...chartHours(old, 60, 'Europe/Berlin')], [9], 'a UTC window from before still shows');
  assert.deepEqual(chartWindows(new Set(Array.from({ length: 24 }, (_, h) => h)), 60, 'Europe/Berlin'), [{ from: '00:00', to: '23:59', zone: 'Europe/Berlin', days: 'all' }]);
});
