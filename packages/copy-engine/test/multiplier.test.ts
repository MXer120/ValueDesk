/**
 * The size multiplier (settings.multiplier, owner 2026-11-03: "Copies a multiple of
 * the trader's positions. 1x mirrors them.") and "only new positions"
 * (copyExisting false) in the planner and the rules every copier shares.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSettings, checkSettings, describeSettings, planLeaderEvent, type PlanContext } from '../src/index.ts';
import { BTC, ev, marks, state, sub } from './helpers.ts';

const ctx = (o: Partial<PlanContext> & Pick<PlanContext, 'event'>): PlanContext => ({
  sub: sub(),
  state: state(),
  market: BTC,
  markOf: marks({ 'BTC-USD': 80_000 }),
  policy: { maxLeverage: null },
  heldBy: 'nobody',
  follower: null,
  ...o,
});
const LEADER = { venue: 'sodex', address: '0x' + 'ab'.repeat(20) };

test('rules: the multiplier defaults to 1, is checked against its limits, and an absent one (older rules) is 1', () => {
  assert.equal(checkSettings({ leader: LEADER }).settings!.multiplier, 1);
  assert.equal(checkSettings({ leader: LEADER, multiplier: null }).settings!.multiplier, 1);
  assert.equal(checkSettings({ leader: LEADER, multiplier: 2.5 }).settings!.multiplier, 2.5);
  assert.match(checkSettings({ leader: LEADER, multiplier: 0 }).errors.multiplier!, /between 0.1 and 10/);
  assert.match(checkSettings({ leader: LEADER, multiplier: 11 }).errors.multiplier!, /between 0.1 and 10/);
  assert.match(checkSettings({ leader: LEADER, multiplier: 'x' }).errors.multiplier!, /number/);
});

test('canonical form: 1x writes nothing (rules signed before the multiplier stay byte for byte the same); 2x is written at the end', () => {
  const one = checkSettings({ leader: LEADER }).settings!;
  assert.equal('multiplier' in canonicalSettings(one), false);
  const two = canonicalSettings({ ...one, multiplier: 2 });
  assert.equal(two.multiplier, 2);
  assert.equal(Object.keys(two).at(-1), 'multiplier');
  assert.match(describeSettings({ ...one, multiplier: 2 }), /2x the trader's size/);
  assert.doesNotMatch(describeSettings(one), /trader's size/);
});

test('planner: 2x doubles the open of every sizing mode; 0.5x halves it', () => {
  // Proportional: 1 BTC at 80k on 100k equity -> 800 of 1,000 = 0.01 BTC; 2x = 0.02.
  const big = { maxPositionUsd: 100_000, maxLeverage: 50 };
  const p = (over: Parameters<typeof sub>[0]) => planLeaderEvent(ctx({ sub: sub({ ...big, ...over }), event: ev('BTC-USD', 0, 1, 80_000) })).intents[0]!;
  assert.equal(p({ multiplier: 1 }).quantity, '0.01');
  assert.equal(p({ multiplier: 2 }).quantity, '0.02');
  assert.equal(p({ multiplier: 0.5 }).quantity, '0.005');
  // Fixed ratio 10% of 1 BTC = 0.1; 2x = 0.2 (16,000 on a 1,000 copy needs 16x: inside 50x).
  assert.equal(p({ sizingMode: 'fixedRatio', ratio: 0.1, multiplier: 2 }).quantity, '0.2');
  // Fixed $800 per open = 0.01 BTC; 3x = 0.03.
  assert.equal(p({ sizingMode: 'fixedNotional', fixedNotionalUsd: 800, multiplier: 3 }).quantity, '0.03');
});

test('planner: the caps apply after the multiplier: max position, max leverage, and the EEA 2x region cap', () => {
  const open = (over: Parameters<typeof sub>[0], policy = { maxLeverage: null as number | null }) =>
    planLeaderEvent(ctx({ sub: sub(over), policy, event: ev('BTC-USD', 0, 1, 80_000) })).intents[0]!;
  // 10x of 800 = 8,000: max position 2,500 binds.
  const pos = open({ multiplier: 10 });
  assert.equal(pos.quantity, '0.03125');
  assert.equal(pos.clampedBy, 'max-position');
  // Max position out of the way: 5x leverage on 1,000 = 5,000.
  const lev = open({ multiplier: 10, maxPositionUsd: 100_000 });
  assert.equal(lev.quantity, '0.0625');
  assert.equal(lev.clampedBy, 'max-leverage');
  // EEA: 5x of 800 = 4,000 fits the 5x cap but not 2x on 1,000 = 2,000, so the region's cap is named.
  const eea = open({ multiplier: 5, maxPositionUsd: 100_000 }, { maxLeverage: 2 });
  assert.equal(eea.quantity, '0.025');
  assert.equal(eea.clampedBy, 'region-leverage');
});

test('planner: a decrease keeps the multiplied size per leader unit', () => {
  const s = sub({ multiplier: 2, maxPositionUsd: 100_000, maxLeverage: 50 });
  const st = state();
  const open = planLeaderEvent(ctx({ sub: s, state: st, event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(open.intents[0]!.quantity, '0.02');
  st.owned['BTC-USD'] = { size: 0.02, entry: 80_000, openedAt: 1 };
  // The leader halves: the copy halves (0.02 -> 0.01), not back to the 1x size.
  const dec = planLeaderEvent(ctx({ sub: s, state: st, event: ev('BTC-USD', 1, 0.5, 80_000) }));
  assert.equal(dec.intents[0]!.quantity, '0.01');
  assert.equal(dec.intents[0]!.reduceOnly, true);
});

test('only new positions: a position held before the start is not joined, its add is copied with the add share and the multiplier; the next open after flat is copied in full', () => {
  const s = sub({ copyExisting: false, multiplier: 2, maxPositionUsd: 100_000, maxLeverage: 50 });
  const st = state({ detached: { 'BTC-USD': 'pre-existing' } });
  const add = planLeaderEvent(ctx({ sub: s, state: st, event: ev('BTC-USD', 1, 2, 80_000) }));
  assert.equal(add.attach, true);
  const fresh1 = planLeaderEvent(ctx({ sub: s, state: state(), event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(add.intents[0]!.quantity, fresh1.intents[0]!.quantity, 'the add of 1 is sized as a fresh open of 1');
  delete st.detached['BTC-USD'];
  st.owned['BTC-USD'] = { size: Number(add.intents[0]!.quantity), entry: 80_000, openedAt: 1 };
  const flat = planLeaderEvent(ctx({ sub: s, state: st, event: ev('BTC-USD', 2, 0, 80_000) }));
  assert.equal(flat.intents[0]!.leg, 'close');
  delete st.owned['BTC-USD'];
  const fresh = planLeaderEvent(ctx({ sub: s, state: st, event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(fresh.intents[0]!.quantity, '0.02');
});
