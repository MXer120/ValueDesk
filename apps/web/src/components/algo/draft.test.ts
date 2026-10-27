/**
 * The algo ticket's draft: the spec of an untouched form, slices that follow
 * the duration, old drafts loading, the Advanced pop-up's count and reset.
 * Run (from apps/web): npx tsx --test src/components/algo/draft.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORACLE_VENUES, checkAlgoSpec, planAlgo, type AlgoSpec, type MarketInfo } from '@copy-engine';
import {
  ADVANCED_KEYS, DEFAULT, dcaLadder, DRAFT_KEY, INLINE_KEYS, SCALE_SKEW, advancedChanges, autoSlices, bpsToPct, cond, draftToSpec, errFor, hasRandomize, legs, loadDraft, pctToBps,
  randomizeOn, resetAdvanced, saveDraft, scaleSize, setRandomize, setScaleSize, slicesOf,
  type Draft, type TicketShared,
} from './draft';
import { ALGO_MENU, type UiKind } from './menu';

const shared: TicketShared = { symbol: 'BTC-USD', side: 'buy', quantity: '0.5', reduceOnly: false, leverage: 5, marginMode: 'cross' };
const NOW = 1_800_000_000_000;

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

/** The form as the ticket fills it before the trader touches anything (prices from the book). */
function untouched(kind: UiKind): Draft {
  const d: Draft = { ...DEFAULT };
  if (kind === 'scale') Object.assign(d, { from: '99800', to: '98000' });
  if (kind === 'conditional') d.conds = [cond('BTC-USD', { value: '99000' })];
  if (kind === 'basket') d.legs = legs('BTC-USD', 'buy');
  if (kind === 'iceberg') d.display = '0.05';
  if (kind === 'dca') Object.assign(d, { dcaFirst: 'price', dcaStart: '100000' });
  return d;
}

test('an untouched TWAP is 30 slices over 30 minutes, as before', () => {
  const s = draftToSpec('twap', DEFAULT, shared, NOW);
  assert.equal(s.durationMs, 30 * 60_000);
  assert.equal(s.slices, 30);
  assert.equal(s.kind, 'twap');
  assert.equal(s.paper, false);
  assert.equal(s.exits, null);
  assert.deepEqual(s.exec, { style: 'taker', slippageBps: 10, offsetTicks: 0, chaseTicks: 2, makerShare: 0.6 });
  // Industry default: a TWAP's slices take; Chase TWAP is the one that rests first.
  assert.equal((draftToSpec('chasetwap', DEFAULT, shared, NOW).exec as { style: string }).style, 'hybrid');
  assert.equal(loadDraft(memStore({ [DRAFT_KEY]: JSON.stringify({ exec: 'hybrid' }) })).exec, 'taker');
  assert.equal(loadDraft(memStore({ [DRAFT_KEY]: JSON.stringify({ exec: 'maker' }) })).exec, 'maker');
});

test('every kind, untouched, is a spec the engine accepts', () => {
  for (const { id } of ALGO_MENU) {
    const s = draftToSpec(id, untouched(id), shared, NOW);
    const c = checkAlgoSpec(s);
    assert.deepEqual(c.errors, {}, `${id}: ${JSON.stringify(c.errors)}`);
    assert.ok(c.spec, id);
    assert.equal('place' in s, false, `${id}: where it runs is not part of the spec`);
  }
});

test('slices follow the duration, one a minute, until set', () => {
  assert.equal(autoSlices('30', 'm'), '30');
  assert.equal(autoSlices('4', 'h'), '240');
  assert.equal(autoSlices('1', 'm'), '2');
  assert.equal(autoSlices('7', 'd'), '2000');
  assert.equal(autoSlices('', 'm'), DEFAULT.slices);
  assert.equal(slicesOf({ ...DEFAULT, dur: '2', durUnit: 'h' }), '120');
  assert.equal(slicesOf({ ...DEFAULT, dur: '2', durUnit: 'h', slicesAuto: false, slices: '12' }), '12');
  assert.equal(draftToSpec('vwap', { ...DEFAULT, dur: '2', durUnit: 'h' }, shared, NOW).slices, 120);
});

test('a saved draft still loads; the old place is dropped from it', () => {
  const store = memStore({ [DRAFT_KEY]: JSON.stringify({ ...DEFAULT, slicesAuto: undefined, place: 'self', dur: '45', rate: '20' }) });
  const d = loadDraft(store);
  assert.equal(d.dur, '45');
  assert.equal(d.rate, '20');
  assert.equal('place' in d, false);
  assert.deepEqual(d.conds, []);
});

test('an old draft keeps its slice count unless it was the one the duration gives', () => {
  const old = (o: Partial<Draft>) => memStore({ [DRAFT_KEY]: JSON.stringify({ ...DEFAULT, slicesAuto: undefined, ...o }) });
  // 4 h with the old default of 30 slices: still 30.
  const kept = loadDraft(old({ dur: '4', durUnit: 'h', slices: '30' }));
  assert.equal(kept.slicesAuto, false);
  assert.equal(draftToSpec('twap', kept, shared, NOW).slices, 30);
  // 30 min with 30 slices: follows the duration from now on.
  assert.equal(loadDraft(old({})).slicesAuto, true);
});

test('an unreadable draft gives the defaults', () => {
  assert.deepEqual(loadDraft(memStore({ [DRAFT_KEY]: '{nope' })), DEFAULT);
  assert.deepEqual(loadDraft(null), DEFAULT);
});

test('the saved draft leaves out prices and lists', () => {
  const store = memStore();
  saveDraft({ ...DEFAULT, from: '1', limitPrice: '2', conds: [cond('BTC-USD')], dur: '10' }, store);
  const saved = JSON.parse(store.map.get(DRAFT_KEY)!) as Record<string, unknown>;
  assert.equal(saved.dur, '10');
  assert.equal('from' in saved, false);
  assert.equal('limitPrice' in saved, false);
  assert.equal('conds' in saved, false);
});

test('Advanced counts only what differs from the defaults', () => {
  assert.deepEqual(advancedChanges('twap', DEFAULT, true), []);
  assert.deepEqual(advancedChanges('twap', { ...DEFAULT, slicesAuto: false, slip: '50', limitPrice: '100' }, true), ['slices', 'max slippage', 'limit']);
  // The essentials are not advanced: a TWAP's duration, a chase's max distance, a trailing stop's start.
  assert.deepEqual(advancedChanges('twap', { ...DEFAULT, dur: '2' }, true), []);
  assert.deepEqual(advancedChanges('chase', { ...DEFAULT, maxChasePct: '0.2' }, true), []);
  assert.deepEqual(advancedChanges('trailing', { ...DEFAULT, activation: '100' }, false), []);
  // Exits and the shared rules count where the kind has them.
  assert.deepEqual(advancedChanges('iceberg', { ...DEFAULT, exitsOn: true, startMode: 'delay', maxSpread: '5' }, true), ['take-profit / stop-loss', 'starts later', 'max spread']);
  assert.deepEqual(advancedChanges('scale', { ...DEFAULT, limitPrice: '100', upper: '5' }, true), []);
  // A setting that only applies with another is not counted without it.
  assert.deepEqual(advancedChanges('dca', { ...DEFAULT, dcaLevels: 'list', dcaStepScale: '2' }, false), ['prices']);
});

test('Reset puts the advanced settings back and keeps the essentials', () => {
  const d: Draft = { ...DEFAULT, dur: '2', durUnit: 'h', slicesAuto: false, slices: '7', slip: '80', exitsOn: true, limitPrice: '1', startMode: 'price', paper: true };
  const r = resetAdvanced('twap', d);
  assert.deepEqual(advancedChanges('twap', r, true), []);
  assert.equal(r.dur, '2');
  assert.equal(r.durUnit, 'h');
  assert.equal(r.paper, true);
});

test('a field finds its own error, children included', () => {
  const e = { durationMs: 'Duration must be between 60000 and 2592000000.', 'exits.tpPct': 'Too far.' };
  assert.equal(errFor(e, 'durationMs'), e.durationMs);
  assert.equal(errFor(e, 'exits'), 'Too far.');
  assert.equal(errFor(e, 'slices'), undefined);
  assert.equal(errFor(e, 'exit'), undefined);
});

/* --------------------------------------- the inline sets (benchmark, 2026-10-26) ----- */

test('each kind shows on the ticket what the venues show, and nothing is both on the ticket and in Advanced', () => {
  for (const { id } of ALGO_MENU) {
    const inline = INLINE_KEYS[id];
    assert.ok(inline.length > 0, id);
    for (const k of ADVANCED_KEYS[id]) assert.equal(inline.includes(k), false, `${id}: ${k} is both inline and advanced`);
  }
  assert.deepEqual(INLINE_KEYS.twap, ['dur', 'durUnit', 'randomize', 'twapCloseShare']);
  assert.deepEqual(INLINE_KEYS.chase, ['maxChasePct']);
  assert.deepEqual(INLINE_KEYS.scale, ['from', 'to', 'orders', 'scaleSize']);
  assert.deepEqual(INLINE_KEYS.swarm, ['clips', 'randomize']);
  assert.ok(INLINE_KEYS.basket.includes('basketStyle'));
  assert.equal(hasRandomize('twap'), true);
  assert.equal(hasRandomize('swarm'), true);
  assert.equal(hasRandomize('chasetwap'), false);
});

test("a chase's max distance is typed in % and sent in bp", () => {
  assert.equal(pctToBps('0.15'), 15);
  assert.equal(pctToBps('1'), 100);
  assert.equal(pctToBps('0.07'), 7);
  assert.equal(pctToBps(''), null);
  assert.equal(pctToBps('0'), null);
  assert.equal(bpsToPct('25'), '0.25');
  assert.equal(bpsToPct('7'), '0.07');
  assert.equal(bpsToPct(''), '');
  assert.equal(draftToSpec('chase', { ...DEFAULT, maxChasePct: '0.3' }, shared, NOW).maxChaseBps, 30);
  assert.equal(draftToSpec('chase', DEFAULT, shared, NOW).maxChaseBps, null);
});

test("an old draft's max chase in bp loads as the same distance in %", () => {
  const raw = { ...DEFAULT, maxChasePct: undefined, maxChase: '25' };
  const d = loadDraft(memStore({ [DRAFT_KEY]: JSON.stringify(raw) }));
  assert.equal(d.maxChasePct, '0.25');
  assert.equal('maxChase' in d, false);
  assert.equal(draftToSpec('chase', d, shared, NOW).maxChaseBps, 25);
  // An old draft with no max chase stays without one.
  assert.equal(loadDraft(memStore({ [DRAFT_KEY]: JSON.stringify({ ...DEFAULT, maxChasePct: undefined, maxChase: '' }) })).maxChasePct, '');
});

test('Randomize: on by default, off is no jitter, and off is not an advanced change', () => {
  assert.equal(randomizeOn('twap', DEFAULT), true);
  assert.equal(randomizeOn('swarm', DEFAULT), true);
  const off: Draft = { ...DEFAULT, ...setRandomize('twap', false) };
  const s = draftToSpec('twap', off, shared, NOW);
  assert.equal(s.sizeJitter, 0);
  assert.equal(s.timeJitter, 0);
  assert.equal(randomizeOn('twap', off), false);
  assert.deepEqual(advancedChanges('twap', off, true), []);
  // Back on is the default jitter: the spec of an untouched form.
  assert.deepEqual(draftToSpec('twap', { ...off, ...setRandomize('twap', true) }, shared, NOW), draftToSpec('twap', DEFAULT, shared, NOW));
  // A tuned jitter still counts; Reset keeps Randomize off off.
  assert.deepEqual(advancedChanges('twap', { ...DEFAULT, sizeJitter: '30' }, true), ['size varies']);
  assert.equal(randomizeOn('twap', resetAdvanced('twap', { ...off, slip: '80' })), false);
  const swarmOff: Draft = { ...DEFAULT, ...setRandomize('swarm', false) };
  assert.equal(draftToSpec('swarm', swarmOff, shared, NOW).sizeJitter, 0);
  assert.deepEqual(advancedChanges('swarm', swarmOff, true), []);
});

test("Scale's size curve: flat, increasing, decreasing, bell, on the ticket", () => {
  assert.equal(scaleSize(DEFAULT), 'flat');
  // A linear curve with no skew is flat, and shows as flat.
  assert.equal(scaleSize({ distribution: 'linear', skew: '1' }), 'flat');
  const inc: Draft = { ...DEFAULT, ...setScaleSize(DEFAULT, 'increasing') };
  assert.equal(inc.distribution, 'linear');
  assert.equal(inc.skew, SCALE_SKEW.increasing);
  assert.equal(scaleSize(inc), 'increasing');
  assert.deepEqual(advancedChanges('scale', inc, true), [], 'the direction is not an advanced change');
  const dec: Draft = { ...inc, ...setScaleSize(inc, 'decreasing') };
  assert.equal(dec.skew, SCALE_SKEW.decreasing);
  // A tuned skew or the exponential curve count; their direction is kept.
  const tuned: Draft = { ...inc, distribution: 'exponential', skew: '4' };
  assert.deepEqual(advancedChanges('scale', tuned, true), ['size curve', 'skew']);
  assert.equal(setScaleSize(tuned, 'increasing').skew, '4');
  assert.equal(setScaleSize(tuned, 'increasing').distribution, 'exponential');
  const r = resetAdvanced('scale', tuned);
  assert.equal(scaleSize(r), 'increasing');
  assert.deepEqual(advancedChanges('scale', r, true), []);
  assert.deepEqual({ ...DEFAULT, ...setScaleSize(inc, 'flat') }.distribution, 'flat');
  // An untouched scale is the spec it always was.
  const s = draftToSpec('scale', { ...DEFAULT, from: '99800', to: '98000' }, shared, NOW);
  assert.equal(s.distribution, 'flat');
  assert.equal(s.skew, 1);
});

test("a basket's style and duration are on the ticket, not advanced", () => {
  assert.deepEqual(advancedChanges('basket', { ...DEFAULT, basketStyle: 'twap', dur: '2', durUnit: 'h' }, false), []);
  // What only the other style uses is not counted.
  assert.deepEqual(advancedChanges('basket', { ...DEFAULT, basketStyle: 'twap', clips: '40' }, false), []);
  assert.deepEqual(advancedChanges('basket', { ...DEFAULT, clips: '40' }, false), ['clips']);
});

test('POV speed presets: Medium is the old default, so an untouched form sends what it did', async () => {
  const { POV_PRESETS, povPreset, setPovPreset } = await import('./draft');
  assert.deepEqual(POV_PRESETS, { low: '5', medium: '10', high: '20' });
  assert.equal(povPreset(DEFAULT.rate), 'medium');
  assert.equal(povPreset('5'), 'low');
  assert.equal(povPreset('20.0'), 'high');
  assert.equal(povPreset('12'), 'custom');
  assert.equal(povPreset(''), 'custom');
  const spec = draftToSpec('pov', { ...DEFAULT, ...setPovPreset('medium') }, shared, NOW);
  assert.deepEqual(spec, draftToSpec('pov', { ...DEFAULT }, shared, NOW));
  assert.equal(spec.rate, 0.1);
  assert.equal(draftToSpec('pov', { ...DEFAULT, ...setPovPreset('high') }, shared, NOW).rate, 0.2);
});

/* ------------------------------------------- DCA at set prices (2026-10-26) ----- */

const BTC = { id: 1, name: 'BTC-USD', base: 'BTC', tickSize: '0.1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', marketMaxQuantity: null, minNotional: 10, maxNotional: 5_000_000, maxLeverage: 50, buyLimitUpRatio: 0.05, sellLimitDownRatio: 0.05, takerFee: 0.0004, makerFee: 0.0002 } as unknown as MarketInfo;

test('an untouched DCA buys at set prices: a first buy at the ask, then a limit every 2% lower, $50 each', () => {
  const s = draftToSpec('dca', DEFAULT, { ...shared, bid: 99_990, ask: 100_000 }, NOW);
  assert.equal(s.kind, 'scale');
  assert.equal(s.label, 'DCA');
  assert.equal(s.from, 100_000);
  assert.equal(s.orders, 10);
  const prices = s.prices as number[];
  assert.equal(prices.length, 10);
  for (let i = 0; i < 10; i++) assert.ok(Math.abs(prices[i]! - 100_000 * (1 - 0.02 * i)) < 1e-6, `level ${i}`);
  assert.ok(Math.abs((s.to as number) - 82_000) < 1e-6);
  // $50 at every level: more of the coin further down.
  (s.weights as number[]).forEach((w, i) => assert.ok(Math.abs(w * prices[i]! - 50) < 1e-9));
  assert.equal(s.postOnly, false);
  assert.equal('intervalMs' in s, false, 'nothing about time');
  const c = checkAlgoSpec(s);
  assert.deepEqual(c.errors, {});
});

test("the plan, the preview's table and the chart lines are the same prices", () => {
  const s = checkAlgoSpec(draftToSpec('dca', { ...DEFAULT, dcaOrders: '4', dcaStep: '1', dcaSizing: 'geometric', dcaMult: '2', perOrder: '100' }, { ...shared, bid: 99_990, ask: 100_000 }, NOW)).spec as Extract<AlgoSpec, { kind: 'scale' }>;
  const plan = planAlgo(s, BTC, { now: NOW, price: 99_995, seed: 1 });
  assert.deepEqual(plan.children.map((c) => c.price), [100_000, 99_000, 98_000, 97_000]);
  // $100, $200, $400, $800 at those prices, in whole steps.
  plan.children.forEach((c, i) => assert.ok(Math.abs(c.qty * c.price! - 100 * 2 ** i) < c.price! * 0.00001, `level ${i}: ${c.qty}`));
  assert.ok(plan.avgPrice! < 98_000 && plan.avgPrice! > 97_000);
});

test('a DCA sells upward, multiplies its USD per order, and waits for a price', () => {
  const l = dcaLadder({ ...DEFAULT, dcaOrders: '3', dcaSizing: 'geometric', dcaMult: '2', perOrder: '100' }, { side: 'sell', bid: 50, ask: 51 });
  assert.deepEqual(l.prices!.map((x) => Math.round(x * 1e9) / 1e9), [50, 51, 52]);
  assert.equal(l.skew, 4);
  assert.ok(Math.abs(Number(l.quantity) - (2 + 200 / 51 + 400 / 52)) < 1e-9);
  assert.equal(dcaLadder(DEFAULT, { side: 'buy', bid: null, ask: null }).prices, null);
});

test('a DCA is linear by default: every order the same, in the unit it was typed in', () => {
  const usd = dcaLadder({ ...DEFAULT, dcaOrders: '3', perOrder: '100' }, { side: 'buy', bid: 99, ask: 100 });
  usd.sizes.forEach((q, i) => assert.ok(Math.abs(q * usd.prices![i]! - 100) < 1e-9));
  assert.equal(usd.skew, 1);
  const coin = dcaLadder({ ...DEFAULT, dcaOrders: '3', perOrder: '0.5', dcaUnit: 'coin' }, { side: 'buy', bid: 99, ask: 100 });
  assert.deepEqual(coin.sizes, [0.5, 0.5, 0.5]);
  const w = dcaLadder({ ...DEFAULT, dcaOrders: '4', perOrder: '1', dcaUnit: 'coin', dcaSizing: 'weighted', dcaAdd: '50' }, { side: 'buy', bid: 99, ask: 100 });
  assert.deepEqual(w.sizes, [1, 1.5, 2, 2.5]);
  assert.equal(w.skew, 2.5);
  const g = dcaLadder({ ...DEFAULT, dcaOrders: '3', perOrder: '1', dcaUnit: 'coin', dcaSizing: 'geometric', dcaMult: '2' }, { side: 'buy', bid: 99, ask: 100 });
  assert.deepEqual(g.sizes, [1, 2, 4]);
});

test('a step scale widens each gap; typed prices are used as they are', () => {
  const l = dcaLadder({ ...DEFAULT, dcaOrders: '4', dcaStep: '2', dcaStepScale: '1.5' }, { side: 'buy', bid: 99, ask: 100 });
  // Deviations 2%, 2+3 = 5%, 5+4.5 = 9.5%.
  assert.deepEqual(l.prices!.map((x) => Math.round(x * 1e6) / 1e6), [100, 98, 95, 90.5]);
  const t = draftToSpec('dca', { ...DEFAULT, dcaLevels: 'list', dcaPrices: '95, 90 85', dcaFirst: 'price', dcaStart: '99' }, shared, NOW);
  assert.deepEqual(t.prices, [99, 95, 90, 85]);
  assert.equal(t.orders, 4);
  assert.deepEqual(checkAlgoSpec(t).errors, {});
});

test('a DCA saved on a schedule loads as the price ladder; nothing makes a schedule any more', () => {
  const st = memStore({ [DRAFT_KEY]: JSON.stringify({ perOrder: '20', dcaMode: 'time', every: '2', everyUnit: 'd', dip: '5', budget: '500', dcaStep: '7' }) });
  const d = loadDraft(st) as Draft & Record<string, unknown>;
  assert.equal(d.perOrder, '20');
  assert.equal(d.dcaStep, DEFAULT.dcaStep);
  for (const k of ['dcaMode', 'every', 'everyUnit', 'dip', 'budget']) assert.equal(k in d, false, k);
  const s = draftToSpec('dca', d, { ...shared, bid: 1, ask: 2 }, NOW);
  assert.equal(s.kind, 'scale');
  // A price-based draft keeps its steps.
  assert.equal(loadDraft(memStore({ [DRAFT_KEY]: JSON.stringify({ dcaMode: 'price', dcaStep: '3' }) })).dcaStep, '3');
  assert.deepEqual(INLINE_KEYS.dca.includes('every'), false);
});

/* ------------------------------------------------------- Fill fast ----- */

test('Fill fast: 0.1% from the oracle mid of every venue by default; the venues are kept, never none', () => {
  const s = draftToSpec('sweep', DEFAULT, shared, NOW);
  assert.equal(s.slippageBps, 10);
  assert.equal(s.reference, 'oracleMid');
  assert.deepEqual(s.venues, [...ORACLE_VENUES]);
  assert.deepEqual(checkAlgoSpec(s).errors, {});
  const two = draftToSpec('sweep', { ...DEFAULT, sweepRef: 'oracleFair', sweepVenues: ['bybit', 'okx'] }, shared, NOW);
  assert.equal(checkAlgoSpec(two).spec!.kind, 'sweep');
  assert.deepEqual(two.venues, ['bybit', 'okx']);
  assert.deepEqual(advancedChanges('sweep', { ...DEFAULT, sweepVenues: ['bybit'] }, false), ['venues']);
  assert.deepEqual(advancedChanges('sweep', { ...DEFAULT, sweepRef: 'mark', sweepVenues: ['bybit'] }, false), ['reference']);
  const st = memStore();
  saveDraft({ ...DEFAULT, sweepVenues: ['hyperliquid'] }, st);
  assert.deepEqual(loadDraft(st).sweepVenues, ['hyperliquid']);
  assert.deepEqual(loadDraft(memStore({ [DRAFT_KEY]: JSON.stringify({ sweepVenues: [] }) })).sweepVenues, [...ORACLE_VENUES]);
  assert.deepEqual(loadDraft(memStore({ [DRAFT_KEY]: JSON.stringify({ sweepVenues: ['moonex', 'okx'] }) })).sweepVenues, ['okx']);
  // All six of the old venues meant "all": all of today's.
  assert.deepEqual(loadDraft(memStore({ [DRAFT_KEY]: JSON.stringify({ sweepVenues: ['binanceFutures', 'binanceSpot', 'bitget', 'hyperliquid', 'okx', 'bybit'] }) })).sweepVenues, [...ORACLE_VENUES]);
  assert.ok(checkAlgoSpec({ ...s, venues: [] }).errors.venues);
});
