/**
 * The algo ticket's draft: the spec of an untouched form, slices that follow
 * the duration, old drafts loading, the Advanced pop-up's count and reset.
 * Run (from apps/web): npx tsx --test src/components/algo/draft.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlgoSpec } from '@copy-engine';
import {
  ADVANCED_KEYS, DEFAULT, DRAFT_KEY, INLINE_KEYS, SCALE_SKEW, advancedChanges, autoSlices, bpsToPct, cond, draftToSpec, errFor, hasRandomize, legs, loadDraft, pctToBps,
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
  return d;
}

test('an untouched TWAP is 30 slices over 30 minutes, as before', () => {
  const s = draftToSpec('twap', DEFAULT, shared, NOW);
  assert.equal(s.durationMs, 30 * 60_000);
  assert.equal(s.slices, 30);
  assert.equal(s.kind, 'twap');
  assert.equal(s.paper, false);
  assert.equal(s.exits, null);
  assert.deepEqual(s.exec, { style: 'hybrid', slippageBps: 30, offsetTicks: 0, chaseTicks: 2, makerShare: 0.6 });
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
  assert.deepEqual(advancedChanges('dca', { ...DEFAULT, dipMult: '3' }, false), []);
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
