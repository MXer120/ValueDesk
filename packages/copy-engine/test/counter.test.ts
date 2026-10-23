/**
 * Counter-trading: the same planner on the leader's mirrored position.
 * Run: npx tsx --test test/counter.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSettings, checkSettings, describeSettings, planLeaderEvent, type PlanContext } from '../src/index.ts';
import { BTC, ev, marks, settings, state, sub } from './helpers.ts';

const ctx = (o: Partial<PlanContext> & Pick<PlanContext, 'event'>): PlanContext => ({
  sub: sub({ direction: 'counter' }),
  state: state(),
  market: BTC,
  markOf: marks({ 'BTC-USD': 80_000 }),
  policy: { maxLeverage: null },
  heldBy: 'nobody',
  follower: null,
  ...o,
});

test('the leader opens long: a counter-trade opens the same size short, and the books keep the real position', () => {
  const p = planLeaderEvent(ctx({ event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(p.intents.length, 1);
  const i = p.intents[0]!;
  assert.equal(i.side, 'sell');
  assert.equal(i.quantity, '0.01');
  assert.equal(i.limitPrice, '79600'); // 80,000 x 0.995: a sell takes the bid side
  assert.equal(i.reduceOnly, false);
  assert.equal(i.leg, 'open');
  assert.equal(p.leaderAfter, 1, 'the leader is long 1 BTC; the mirror is only how the copy reads it');
});

test('the leader adds, trims and closes: the short grows, shrinks by the same fraction and closes exactly', () => {
  const short = (size: number) => state({ owned: { 'BTC-USD': { size: -size, entry: 80_000, openedAt: 1 } } });
  const inc = planLeaderEvent(ctx({ state: short(0.01), event: ev('BTC-USD', 1, 2, 80_000) }));
  assert.equal(inc.intents[0]!.side, 'sell');
  assert.equal(inc.intents[0]!.leg, 'increase');

  const dec = planLeaderEvent(ctx({ state: short(0.02), event: ev('BTC-USD', 2, 0.5, 80_000) }));
  assert.equal(dec.intents[0]!.side, 'buy');
  assert.equal(dec.intents[0]!.quantity, '0.015');
  assert.equal(dec.intents[0]!.reduceOnly, true);

  const close = planLeaderEvent(ctx({ state: short(0.02), event: ev('BTC-USD', 2, 0, 80_000) }));
  assert.equal(close.intents[0]!.side, 'buy');
  assert.equal(close.intents[0]!.quantity, '0.02');
  assert.equal(close.intents[0]!.leg, 'close');
  assert.equal(close.leaderAfter, 0);
});

test('the leader flips long to short: the counter-trade flips short to long', () => {
  const st = state({ owned: { 'BTC-USD': { size: -0.01, entry: 80_000, openedAt: 1 } } });
  const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 1, -1, 80_000) }));
  assert.deepEqual(p.intents.map((i) => [i.leg, i.side, i.reduceOnly]), [['flip-close', 'buy', true], ['flip-open', 'buy', false]]);
  assert.equal(p.leaderAfter, -1);
});

test('a short leader is countered long, under the same caps', () => {
  const p = planLeaderEvent(ctx({ sub: sub({ direction: 'counter', maxPositionUsd: 400 }), event: ev('BTC-USD', 0, -1, 80_000) }));
  assert.equal(p.intents[0]!.side, 'buy');
  assert.equal(p.intents[0]!.quantity, '0.005'); // 400 / 80,000
  assert.equal(p.intents[0]!.clampedBy, 'max-position');
});

test('the rules: direction is checked, defaults to copy, and is signed only when it is a counter-trade', () => {
  const plain = checkSettings({ ...settings(), direction: undefined });
  assert.equal(plain.settings?.direction, 'copy');
  assert.equal('direction' in canonicalSettings(plain.settings!), false, 'a copy signs exactly what it signed before counter-trading existed');

  const counter = checkSettings({ ...settings(), direction: 'counter' });
  assert.equal(counter.settings?.direction, 'counter');
  const canon = canonicalSettings(counter.settings!);
  assert.equal(canon.direction, 'counter');
  assert.equal(Object.keys(canon).at(-1), 'direction');
  assert.match(describeSettings(counter.settings!), /^Counter-trade: /);

  assert.ok(checkSettings({ ...settings(), direction: 'inverse' }).errors.direction);
});
