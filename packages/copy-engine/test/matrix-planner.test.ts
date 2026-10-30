/**
 * The copy options, every value and their pairs, on the pure parts (docs/COVERAGE-COPY.md):
 * the rules' validation (every field, its bounds and its wrong types), the canonical form
 * and the summary; the planner over every sizing mode x direction x leader venue for every
 * leader event (open, add, reduce, flip, close); the caps (max position, the follower's
 * leverage, the region's) per mode and direction; every copy status, coin filter, detach
 * reason, holder, same-asset verdict and slippage cap against every event; every skip
 * reason the planner can give; and the guards (stop-loss, take-profit, drawdown) per side,
 * leverage and status. The runtime's half (lifecycle, readiness, stops on SoDEX, approval)
 * is matrix-runtime.test.ts.
 *
 * The numbers are chosen so all three sizing modes give the same copy: the leader trades
 * BTC at 80,000 on 100,000 equity, the copy has 1,000 (proportional: 1%), a ratio of 1%
 * (fixed ratio) or $800 per open (fixed amount: 1% of one BTC). Fills are booked at the
 * mark without fees, so the copy's equity stays at its allocation and every size is exact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  SKIP_REASONS,
  applyFill,
  canonicalSettings,
  checkSettings,
  describeSettings,
  guardTrigger,
  noteSeen,
  planGuards,
  planLeaderEvent,
  regionPolicy,
  type CopyDirection,
  type CopySettings,
  type DetachReason,
  type LeaderVenue,
  type PlanContext,
  type SizingMode,
  type SkipReason,
  type SubState,
  type SubscriptionStatus,
} from '../src/index.ts';
import { BTC, ETH, LEADER, ev, marks, settings, state, sub } from './helpers.ts';

const PRICE = 80_000;
const MARKS = marks({ 'BTC-USD': PRICE, 'ETH-USD': 2_000 });
const MODES: SizingMode[] = ['proportional', 'fixedRatio', 'fixedNotional'];
const DIRECTIONS: CopyDirection[] = ['copy', 'counter'];
const VENUES: LeaderVenue[] = ['sodex', 'hyperliquid'];
/** The three modes sized alike: 1% of the leader's notional (see the header). */
const SAME_SIZE: Record<SizingMode, Partial<CopySettings>> = {
  proportional: { sizingMode: 'proportional', allocationUsd: 1_000 },
  fixedRatio: { sizingMode: 'fixedRatio', ratio: 0.01 },
  fixedNotional: { sizingMode: 'fixedNotional', fixedNotionalUsd: 800 },
};
const symOf = (venue: LeaderVenue) => (venue === 'sodex' ? 'BTC-USD' : 'BTC');

function rules(mode: SizingMode, direction: CopyDirection, venue: LeaderVenue, over: Partial<CopySettings> = {}): Partial<CopySettings> {
  return { ...SAME_SIZE[mode], direction, leader: { venue, address: LEADER }, maxPositionUsd: 1_000_000, maxLeverage: 5, stopLossPct: null, drawdownStopPct: null, ...over };
}

function ctxFor(o: { rules: Partial<CopySettings>; state?: SubState; status?: SubscriptionStatus; event: PlanContext['event'] } & Partial<PlanContext>): PlanContext {
  const venue = o.rules.leader?.venue ?? 'sodex';
  return {
    sub: sub(o.rules, { status: o.status ?? 'active' }),
    state: o.state ?? state(),
    market: BTC,
    markOf: MARKS,
    policy: { maxLeverage: null },
    heldBy: 'nobody',
    follower: null,
    ...(venue === 'hyperliquid' ? { sameAsset: true } : {}),
    ...o,
  };
}

/**
 * A copy as the runtime runs it, without the runtime: each leader position in turn is
 * planned, its orders are booked as filled at the mark, and the leader's books move.
 * Returns, per step, the plan and the copy's position after it.
 */
function walk(r: Partial<CopySettings>, steps: number[], o: Partial<PlanContext> & { status?: SubscriptionStatus } = {}) {
  const venue = r.leader?.venue ?? 'sodex';
  const sym = symOf(venue);
  const st = o.state ?? state();
  let before = 0;
  return steps.map((after) => {
    const plan = planLeaderEvent(ctxFor({ rules: r, state: st, event: ev(sym, before, after, PRICE, venue), ...o }));
    for (const i of plan.intents) applyFill(st, i.symbol, i.side, Number(i.quantity), PRICE, 0, 1);
    st.leaderPos[sym] = plan.leaderAfter;
    if (plan.attach) delete st.detached[sym];
    noteSeen(st, `step-${before}-${after}-${Math.random()}`);
    before = after;
    return { plan, size: Number((st.owned['BTC-USD']?.size ?? 0).toFixed(8)), legs: plan.intents.map((i) => i.leg) };
  });
}

/* ================================================================ settings ===== */

const VALID = { leader: { venue: 'sodex', address: LEADER } };
const errorsOf = (over: Record<string, unknown>) => checkSettings({ ...VALID, ...over }).errors;

test('settings: every number field takes its bounds and refuses just past them, a word, NaN and Infinity; a number in a string is read', () => {
  const fields: Array<[keyof typeof LIMITS, keyof CopySettings]> = [
    ['allocationUsd', 'allocationUsd'],
    ['ratio', 'ratio'],
    ['fixedNotionalUsd', 'fixedNotionalUsd'],
    ['maxLeverage', 'maxLeverage'],
    ['maxPositionUsd', 'maxPositionUsd'],
    ['stopLossPct', 'stopLossPct'],
    ['takeProfitPct', 'takeProfitPct'],
    ['drawdownStopPct', 'drawdownStopPct'],
    ['slippageBps', 'slippageBps'],
  ];
  for (const [lim, field] of fields) {
    const { min, max } = LIMITS[lim] as { min: number; max: number };
    for (const ok of [min, max, String(max)]) {
      const r = checkSettings({ ...VALID, [field]: ok });
      assert.ok(r.settings, `${field} = ${ok} is accepted (${JSON.stringify(r.errors)})`);
      assert.equal(r.settings![field], field === 'maxLeverage' ? Math.floor(Number(ok)) : Number(ok));
    }
    for (const bad of [min - min / 2 || -1, max * 1.01, 'lots', NaN, Infinity, -Infinity, {}, true]) {
      assert.ok(errorsOf({ [field]: bad })[field], `${field} = ${String(bad)} is refused`);
    }
  }
});

test('settings: stop-loss, take-profit and drawdown stop are off when null, empty or absent; required numbers fall back to the defaults', () => {
  for (const off of [null, '', undefined, 'absent']) {
    const s = checkSettings(off === 'absent' ? VALID : { ...VALID, stopLossPct: off, takeProfitPct: off, drawdownStopPct: off }).settings!;
    if (off === 'absent') {
      // Absent: the defaults (stop-loss 50%, no take-profit, drawdown 30%).
      assert.deepEqual([s.stopLossPct, s.takeProfitPct, s.drawdownStopPct], [0.5, null, 0.3]);
    } else assert.deepEqual([s.stopLossPct, s.takeProfitPct, s.drawdownStopPct], [null, null, null]);
  }
  const d = checkSettings(VALID).settings!;
  assert.deepEqual(
    [d.direction, d.sizingMode, d.allocationUsd, d.ratio, d.fixedNotionalUsd, d.maxLeverage, d.maxPositionUsd, d.slippageBps, d.marginMode, d.approval, d.copyExisting, d.paper],
    ['copy', 'proportional', 1000, 0.1, 100, 5, 2500, 50, 'isolated', 'auto', false, false],
  );
  // Required numbers given as null are refused, not defaulted.
  for (const f of ['allocationUsd', 'ratio', 'fixedNotionalUsd', 'maxLeverage', 'maxPositionUsd', 'slippageBps']) assert.ok(errorsOf({ [f]: null })[f as keyof CopySettings], `${f} = null`);
});

test('settings: a leverage that is not whole is floored; every choice field takes its values and refuses anything else', () => {
  assert.equal(checkSettings({ ...VALID, maxLeverage: 2.9 }).settings!.maxLeverage, 2);
  assert.equal(checkSettings({ ...VALID, maxLeverage: 1.5 }).settings!.maxLeverage, 1);
  const choices: Array<[keyof CopySettings, unknown[], unknown[]]> = [
    ['direction', ['copy', 'counter', null], ['mirror', 'COPY', 1]],
    ['sizingMode', ['proportional', 'fixedRatio', 'fixedNotional'], ['fixed', 'ratio', null]],
    ['marginMode', ['isolated', 'cross'], ['ISOLATED', 'portfolio', null]],
    ['approval', ['auto', 'confirm'], ['ask', true, null]],
    ['copyExisting', [true, false], ['yes', 1, null]],
    ['paper', [true, false], ['no', 0, null]],
  ];
  for (const [field, good, bad] of choices) {
    for (const v of good) {
      const r = checkSettings({ ...VALID, [field]: v });
      assert.ok(r.settings, `${field} = ${String(v)}`);
      assert.equal(r.settings![field], field === 'direction' && v === null ? 'copy' : v);
    }
    for (const v of bad) assert.ok(errorsOf({ [field]: v })[field], `${field} = ${String(v)} is refused`);
  }
});

test('settings: the leader is a 0x address (lower-cased) on SoDEX or Hyperliquid; anything else is refused, naming the field', () => {
  const up = checkSettings({ leader: { venue: 'hyperliquid', address: ` ${LEADER.toUpperCase().replace('0X', '0x')} ` } }).settings!;
  assert.equal(up.leader.address, LEADER);
  assert.equal(up.leader.venue, 'hyperliquid');
  for (const address of ['0x123', LEADER.slice(2), `${LEADER}00`, 42, null]) assert.ok(checkSettings({ leader: { venue: 'sodex', address } }).errors['leader.address'], String(address));
  for (const venue of ['binance', 'SODEX', null]) assert.ok(checkSettings({ leader: { venue, address: LEADER } }).errors['leader.venue'], String(venue));
  assert.ok(checkSettings(null).errors['leader.address'] && checkSettings('x').errors['leader.venue']);
});

test('settings: coin lists from a list or "btc, eth;sol" are upper-cased, de-duplicated and sorted; a bad symbol, a non-list, more than 100 coins or a coin on both lists are refused', () => {
  const s = checkSettings({ ...VALID, assetAllow: 'eth, btc;sol  btc', assetDeny: ['doge', 'DOGE'] }).settings!;
  assert.deepEqual(s.assetAllow, ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(s.assetDeny, ['DOGE']);
  assert.deepEqual(checkSettings({ ...VALID, assetAllow: null }).settings!.assetAllow, []);
  assert.ok(errorsOf({ assetAllow: ['BT-C'] }).assetAllow);
  assert.ok(errorsOf({ assetDeny: 7 }).assetDeny);
  assert.ok(errorsOf({ assetAllow: Array.from({ length: 101 }, (_, i) => `C${i}`) }).assetAllow);
  assert.ok(checkSettings({ ...VALID, assetAllow: Array.from({ length: 100 }, (_, i) => `C${i}`) }).settings, '100 coins are fine');
  assert.match(errorsOf({ assetAllow: ['BTC', 'ETH'], assetDeny: ['eth'] }).assetDeny ?? '', /ETH is on both lists/);
});

test('settings: the canonical form keeps one key order, writes direction only for a counter-trade, and survives a round trip', () => {
  const keys = ['leader', 'sizingMode', 'allocationUsd', 'ratio', 'fixedNotionalUsd', 'maxLeverage', 'maxPositionUsd', 'stopLossPct', 'takeProfitPct', 'drawdownStopPct', 'assetAllow', 'assetDeny', 'copyExisting', 'slippageBps', 'marginMode', 'approval', 'paper'];
  for (const direction of DIRECTIONS) {
    for (const mode of MODES) {
      const s = checkSettings({ ...VALID, sizingMode: mode, direction, assetAllow: ['eth', 'btc'], paper: true, approval: 'confirm', marginMode: 'cross' }).settings!;
      const c = canonicalSettings(s);
      assert.deepEqual(Object.keys(c), direction === 'counter' ? [...keys, 'direction'] : keys);
      assert.deepEqual(c.assetAllow, ['BTC', 'ETH']);
      assert.deepEqual(checkSettings(JSON.parse(JSON.stringify(c))).settings, s, 'the signed form reads back as the same rules');
    }
  }
});

test('settings: the summary names the mode, the direction, the caps, every guard that is on, and paper', () => {
  const d = (o: Partial<CopySettings>) => describeSettings(settings(o));
  assert.match(d({ sizingMode: 'proportional', allocationUsd: 1000 }), /^Proportional on \$1,000, max 5x, max \$2,500 per position, stop loss 50%, drawdown stop 30%$/);
  assert.match(d({ sizingMode: 'fixedRatio', ratio: 0.25 }), /^25% of the leader's size/);
  assert.match(d({ sizingMode: 'fixedNotional', fixedNotionalUsd: 12 }), /^\$12 per trade/);
  assert.match(d({ direction: 'counter', sizingMode: 'fixedNotional', fixedNotionalUsd: 12 }), /^Counter-trade: \$12 per trade/);
  assert.match(d({ stopLossPct: null, takeProfitPct: 1.5, drawdownStopPct: null, paper: true }), /max \$2,500 per position, take profit 150%, paper$/);
  assert.doesNotMatch(d({ stopLossPct: null, drawdownStopPct: null }), /stop loss|drawdown/);
});

/* ============================================================ the planner ===== */

test('every sizing mode x direction x leader venue follows open, add, reduce, flip and close to the same exact sizes, reductions reduce-only', () => {
  const L = [1, 2, 1, -1, 0];
  const legs = [['open'], ['increase'], ['decrease'], ['flip-close', 'flip-open'], ['close']];
  for (const mode of MODES) {
    for (const direction of DIRECTIONS) {
      for (const venue of VENUES) {
        const what = `${mode} ${direction} ${venue}`;
        const dir = direction === 'counter' ? -1 : 1;
        const out = walk(rules(mode, direction, venue), L);
        assert.deepEqual(out.map((x) => x.size), L.map((l) => (l === 0 ? 0 : dir * 0.01 * l)), `${what}: sizes`);
        assert.deepEqual(out.map((x) => x.legs), legs, `${what}: legs`);
        for (const { plan } of out) {
          for (const i of plan.intents) {
            assert.equal(i.reduceOnly, ['decrease', 'close', 'flip-close'].includes(i.leg), `${what}: ${i.leg} reduce-only`);
            assert.equal(i.symbol, 'BTC-USD');
            assert.equal(i.clampedBy, null);
          }
          // The books keep the trader's real position, whatever the direction.
          assert.equal(plan.leaderAfter, L[out.findIndex((x) => x.plan === plan)]);
        }
        // Sides: what grows a long or cuts a short is a buy.
        assert.deepEqual(out[0]!.plan.intents.map((i) => i.side), [dir > 0 ? 'buy' : 'sell']);
        assert.deepEqual(out[3]!.plan.intents.map((i) => i.side), dir > 0 ? ['sell', 'sell'] : ['buy', 'buy']);
      }
    }
  }
});

test('the copy\'s position is never on the leader\'s side in a counter-trade, nor on the other side in a copy, at any step of a long walk', () => {
  const L = [0.5, 1.5, 3, 2, -0.5, -2, -1, 1, 0, 2, 0];
  for (const mode of MODES) {
    for (const direction of DIRECTIONS) {
      const out = walk(rules(mode, direction, 'sodex'), L);
      out.forEach((x, k) => {
        const want = Math.sign(L[k]!) * (direction === 'counter' ? -1 : 1) || 0;
        assert.equal(Math.sign(x.size) || 0, want, `${mode} ${direction} step ${k} (leader ${L[k]}, copy ${x.size})`);
      });
    }
  }
});

test('caps per mode and direction: max position clamps an add (named) and the next add is skipped at it; a fixed amount keeps its per-unit size through the cap', () => {
  for (const mode of MODES) {
    for (const direction of DIRECTIONS) {
      const dir = direction === 'counter' ? -1 : 1;
      const out = walk(rules(mode, direction, 'sodex', { maxPositionUsd: 1_000 }), [1, 2, 3, 1]);
      assert.equal(out[0]!.size, dir * 0.01, `${mode} ${direction}: open under the cap`);
      assert.equal(out[1]!.size, dir * 0.0125, `${mode} ${direction}: clamped to $1,000`);
      assert.equal(out[1]!.plan.intents[0]!.clampedBy, 'max-position');
      assert.equal(out[2]!.plan.intents.length, 0);
      assert.equal(out[2]!.plan.skip, 'max-position');
      // The leader goes from 3 to 1: the copy follows its size per leader unit. Proportional and fixed
      // ratio re-size it at a clamped add (0.0125 / 2); a fixed amount keeps the one its open set
      // (0.01 per BTC) - owner question in docs/COVERAGE-COPY.md ("Findings").
      assert.equal(out[3]!.size, dir * (mode === 'fixedNotional' ? 0.01 : 0.00625), `${mode} ${direction}: after the reduction`);
      assert.equal(out[3]!.plan.intents[0]!.reduceOnly, true);
    }
  }
});

test('caps per mode, direction and region: the follower\'s leverage is named max-leverage, the EEA 2x region-leverage, the lower one binds', () => {
  const cases: Array<{ maxLeverage: number; region: number | null; cap: number; name: string }> = [
    { maxLeverage: 1, region: null, cap: 1_000, name: 'max-leverage' },
    { maxLeverage: 5, region: 2, cap: 2_000, name: 'region-leverage' },
    { maxLeverage: 1, region: 2, cap: 1_000, name: 'max-leverage' },
    { maxLeverage: 3, region: null, cap: 3_000, name: 'max-leverage' },
  ];
  for (const c of cases) {
    for (const mode of MODES) {
      for (const direction of DIRECTIONS) {
        const what = `${mode} ${direction} own ${c.maxLeverage}x region ${c.region ?? '-'}`;
        const dir = direction === 'counter' ? -1 : 1;
        // A leader of 5 BTC wants $4,000 (a fixed amount: $4,000 per open): over every cap here.
        const out = walk(rules(mode, direction, 'sodex', { maxLeverage: c.maxLeverage, ...(mode === 'fixedNotional' ? { fixedNotionalUsd: 4_000 } : {}) }), [5], { policy: { maxLeverage: c.region } });
        assert.equal(out[0]!.size, dir * (c.cap / PRICE), what);
        assert.equal(out[0]!.plan.intents[0]!.clampedBy, c.name, what);
      }
    }
  }
  // The same through regionPolicy: a German follower is capped at 2x, a Singaporean one is not.
  assert.equal(regionPolicy('DE').maxLeverage, 2);
  assert.equal(regionPolicy('SG').maxLeverage, null);
});

test('every copy status against every leader event: paused and stopped place nothing; halted and blocked only reduce, close and close the old side of a flip', () => {
  const statuses: SubscriptionStatus[] = ['active', 'paused', 'stopped', 'halted', 'blocked'];
  // [before, after, held]: what the copy holds before (0.01 = one leader BTC copied).
  const events: Array<{ name: string; before: number; after: number; held: number }> = [
    { name: 'open', before: 0, after: 1, held: 0 },
    { name: 'add', before: 1, after: 2, held: 0.01 },
    { name: 'reduce', before: 2, after: 1, held: 0.02 },
    { name: 'close', before: 1, after: 0, held: 0.01 },
    { name: 'flip', before: 1, after: -1, held: 0.01 },
  ];
  for (const status of statuses) {
    for (const e of events) {
      for (const direction of DIRECTIONS) {
        const dir = direction === 'counter' ? -1 : 1;
        const st = state(e.held ? { owned: { 'BTC-USD': { size: dir * e.held, entry: PRICE, openedAt: 1 } }, ratios: { 'BTC-USD': 0.01 } } : {});
        const p = planLeaderEvent(ctxFor({ rules: rules('fixedNotional', direction, 'sodex'), state: st, status, event: ev('BTC-USD', e.before, e.after, PRICE) }));
        const what = `${status} ${direction} ${e.name}`;
        const legs = p.intents.map((i) => i.leg);
        if (status === 'active') {
          assert.ok(legs.length > 0, what);
          continue;
        }
        if (status === 'paused' || status === 'stopped') {
          assert.deepEqual(legs, [], what);
          assert.equal(p.skip, status === 'paused' ? 'paused' : 'halted', what);
          continue;
        }
        // halted / blocked
        const want = { open: [], add: [], reduce: ['decrease'], close: ['close'], flip: ['flip-close'] }[e.name as 'open'];
        assert.deepEqual(legs, want, what);
        assert.ok(p.intents.every((i) => i.reduceOnly), `${what}: reduce-only`);
        if (e.name === 'open' || e.name === 'add' || e.name === 'flip') assert.equal(p.skip, status, `${what}: says why nothing (more) was opened`);
      }
    }
  }
});

test('coin filters x direction x event: a coin not allowed or denied opens and adds nothing, and its reductions, close and the close half of a flip still go', () => {
  const filters: Array<{ f: Partial<CopySettings>; skip: SkipReason }> = [
    { f: { assetAllow: ['ETH'] }, skip: 'asset-not-allowed' },
    { f: { assetDeny: ['BTC'] }, skip: 'asset-denied' },
    { f: { assetAllow: ['BTC', 'ETH'], assetDeny: ['ETH'] }, skip: 'at-target' },
  ];
  for (const { f, skip } of filters) {
    for (const direction of DIRECTIONS) {
      for (const venue of VENUES) {
        const dir = direction === 'counter' ? -1 : 1;
        const held = (n: number) => state({ owned: { 'BTC-USD': { size: dir * n, entry: PRICE, openedAt: 1 } }, ratios: { [symOf(venue)]: 0.01 } });
        const r = rules('fixedNotional', direction, venue, f);
        const s = symOf(venue);
        const what = `${JSON.stringify(f)} ${direction} ${venue}`;
        const open = planLeaderEvent(ctxFor({ rules: r, event: ev(s, 0, 1, PRICE, venue) }));
        const add = planLeaderEvent(ctxFor({ rules: r, state: held(0.01), event: ev(s, 1, 2, PRICE, venue) }));
        const red = planLeaderEvent(ctxFor({ rules: r, state: held(0.02), event: ev(s, 2, 1, PRICE, venue) }));
        const close = planLeaderEvent(ctxFor({ rules: r, state: held(0.01), event: ev(s, 1, 0, PRICE, venue) }));
        const flip = planLeaderEvent(ctxFor({ rules: r, state: held(0.01), event: ev(s, 1, -1, PRICE, venue) }));
        if (skip === 'at-target') {
          // BTC is allowed and not denied: everything goes.
          assert.deepEqual([open, add, red, close].map((p) => p.intents.length), [1, 1, 1, 1], what);
          assert.deepEqual(flip.intents.map((i) => i.leg), ['flip-close', 'flip-open'], what);
          continue;
        }
        assert.deepEqual([open.skip, add.skip], [skip, skip], `${what}: no new exposure`);
        assert.deepEqual([open.intents.length, add.intents.length], [0, 0], what);
        assert.deepEqual(red.intents.map((i) => [i.leg, i.reduceOnly]), [['decrease', true]], what);
        assert.deepEqual(close.intents.map((i) => [i.leg, i.reduceOnly]), [['close', true]], what);
        assert.deepEqual(flip.intents.map((i) => i.leg), ['flip-close'], `${what}: the old side closes, the new one is not opened`);
        assert.equal(flip.skip, skip, what);
      }
    }
  }
});

test('every detach reason x event: the market waits until the leader is flat (a close attaches it), a flip opens the new side fresh, what the copy still holds there is closed with the leader', () => {
  const reasons: DetachReason[] = ['pre-existing', 'stop-loss', 'take-profit', 'own-position'];
  const skipOf: Record<DetachReason, SkipReason> = { 'pre-existing': 'pre-existing-position', 'stop-loss': 'after-stop-loss', 'take-profit': 'after-take-profit', 'own-position': 'own-position' };
  for (const why of reasons) {
    for (const direction of DIRECTIONS) {
      const dir = direction === 'counter' ? -1 : 1;
      const r = rules('fixedNotional', direction, 'sodex');
      const det = (owned = 0) => state({ detached: { 'BTC-USD': why }, ...(owned ? { owned: { 'BTC-USD': { size: dir * owned, entry: PRICE, openedAt: 1 } } } : {}) });
      const what = `${why} ${direction}`;
      const add = planLeaderEvent(ctxFor({ rules: r, state: det(), event: ev('BTC-USD', 1, 2, PRICE) }));
      assert.deepEqual([add.intents.length, add.skip, add.attach], [0, skipOf[why], false], `${what}: add`);
      const red = planLeaderEvent(ctxFor({ rules: r, state: det(), event: ev('BTC-USD', 2, 1, PRICE) }));
      assert.deepEqual([red.intents.length, red.skip, red.attach], [0, skipOf[why], false], `${what}: reduce`);
      const close = planLeaderEvent(ctxFor({ rules: r, state: det(), event: ev('BTC-USD', 1, 0, PRICE) }));
      assert.deepEqual([close.intents.length, close.attach], [0, true], `${what}: the leader flat attaches it`);
      const flip = planLeaderEvent(ctxFor({ rules: r, state: det(), event: ev('BTC-USD', 1, -1, PRICE) }));
      assert.deepEqual(flip.intents.map((i) => [i.leg, i.side]), [['open', dir > 0 ? 'sell' : 'buy']], `${what}: a flip opens the new side fresh`);
      assert.equal(flip.attach, true);
      // A remainder the copy still holds (a stop-loss close that filled in part) is closed with the leader, never added to.
      const rest = planLeaderEvent(ctxFor({ rules: r, state: det(0.004), event: ev('BTC-USD', 1, 0, PRICE) }));
      assert.deepEqual(rest.intents.map((i) => [i.leg, i.quantity, i.reduceOnly]), [['close', '0.004', true]], `${what}: the rest is closed`);
      const restAdd = planLeaderEvent(ctxFor({ rules: r, state: det(0.004), event: ev('BTC-USD', 1, 2, PRICE) }));
      assert.equal(restAdd.intents.length, 0, `${what}: the rest is not added to`);
    }
  }
});

test('who holds the market x event: the follower\'s own position or another copy\'s is never opened on; once the copy holds the market the holder does not matter', () => {
  for (const heldBy of ['follower', 'other-copy'] as const) {
    for (const direction of DIRECTIONS) {
      const r = rules('proportional', direction, 'sodex');
      const open = planLeaderEvent(ctxFor({ rules: r, heldBy, event: ev('BTC-USD', 0, 1, PRICE) }));
      assert.equal(open.skip, heldBy === 'follower' ? 'own-position' : 'owned-by-other-copy');
      assert.equal(open.intents.length, 0);
      // A flip with nothing held is an open of the new side: also left alone.
      const flip = planLeaderEvent(ctxFor({ rules: r, heldBy, event: ev('BTC-USD', 1, -1, PRICE) }));
      assert.equal(flip.intents.length, 0);
      const dir = direction === 'counter' ? -1 : 1;
      const own = state({ owned: { 'BTC-USD': { size: dir * 0.01, entry: PRICE, openedAt: 1 } } });
      const add = planLeaderEvent(ctxFor({ rules: r, heldBy, state: own, event: ev('BTC-USD', 1, 2, PRICE) }));
      assert.deepEqual(add.intents.map((i) => i.leg), ['increase'], `${heldBy} ${direction}: the copy adds to its own position`);
    }
  }
});

test('a Hyperliquid leader x same-asset verdict x event: a different asset or one not checked yet opens and adds nothing; reductions and closes go; a SoDEX leader is never checked', () => {
  for (const sameAsset of [true, false, null] as const) {
    for (const direction of DIRECTIONS) {
      const dir = direction === 'counter' ? -1 : 1;
      const r = rules('fixedRatio', direction, 'hyperliquid');
      const held = state({ owned: { 'BTC-USD': { size: dir * 0.02, entry: PRICE, openedAt: 1 } }, ratios: { BTC: 0.01 } });
      const open = planLeaderEvent(ctxFor({ rules: r, sameAsset, event: ev('BTC', 0, 1, PRICE, 'hyperliquid') }));
      const red = planLeaderEvent(ctxFor({ rules: r, sameAsset, state: held, event: ev('BTC', 2, 1, PRICE, 'hyperliquid') }));
      const what = `same ${sameAsset} ${direction}`;
      if (sameAsset) assert.equal(open.intents.length, 1, what);
      else {
        assert.equal(open.intents.length, 0, what);
        assert.equal(open.skip, sameAsset === false ? 'different-asset' : 'no-price', what);
      }
      assert.deepEqual(red.intents.map((i) => [i.leg, i.reduceOnly]), [['decrease', true]], `${what}: the reduction goes`);
    }
  }
  // A SoDEX leader trades SoDEX's own market: no verdict is asked for, and none stops it.
  assert.equal(planLeaderEvent(ctxFor({ rules: rules('fixedRatio', 'copy', 'sodex'), event: ev('BTC-USD', 0, 1, PRICE) })).intents.length, 1);
});

test('slippage cap x side x market band: a buy is never limited above ref x (1 + cap), a sell never below ref x (1 - cap), both inside SoDEX\'s band, on the tick', () => {
  for (const bps of [1, 10, 50, 200, 500]) {
    for (const direction of DIRECTIONS) {
      for (const market of [BTC, ETH]) {
        const ref = market === BTC ? PRICE : 2_000;
        const s = market === BTC ? 'BTC-USD' : 'ETH-USD';
        const p = planLeaderEvent(ctxFor({ rules: rules('fixedNotional', direction, 'sodex', { slippageBps: bps, fixedNotionalUsd: 100 }), market, event: ev(s, 0, 1, ref) }));
        const i = p.intents[0]!;
        const lim = Number(i.limitPrice);
        const tick = Number(market.tickSize);
        const band = ref * market.buyLimitUpRatio * 0.98;
        const what = `${bps} bp ${direction} ${s}`;
        assert.ok(Math.abs(lim / tick - Math.round(lim / tick)) < 1e-6, `${what}: on the tick (${lim})`);
        if (i.side === 'buy') {
          assert.ok(lim >= ref - tick && lim <= ref * (1 + bps / 10_000) + 1e-9 && lim <= ref + band + 1e-9, `${what}: buy at ${lim}`);
        } else {
          assert.ok(lim <= ref + tick && lim >= ref * (1 - bps / 10_000) - 1e-9 && lim >= ref - band - 1e-9, `${what}: sell at ${lim}`);
        }
      }
    }
  }
});

test('every skip reason the planner gives is reachable, and each has words for the follower', () => {
  const held = (n = 0.01) => state({ owned: { 'BTC-USD': { size: n, entry: PRICE, openedAt: 1 } }, ratios: { 'BTC-USD': 0.01 } });
  const base = rules('proportional', 'copy', 'sodex');
  const cases: Array<[SkipReason, PlanContext]> = [
    ['duplicate', (() => { const st = state(); const e = ev('BTC-USD', 0, 1, PRICE); noteSeen(st, e.id); return ctxFor({ rules: base, state: st, event: e }); })()],
    ['spot-not-copied', ctxFor({ rules: base, event: ev('vBTC_vUSDC', 0, 1, PRICE) })],
    ['not-on-sodex', ctxFor({ rules: base, market: null, event: ev('PURR-USD', 0, 1, 1) })],
    ['paused', ctxFor({ rules: base, status: 'paused', event: ev('BTC-USD', 0, 1, PRICE) })],
    ['halted', ctxFor({ rules: base, status: 'halted', event: ev('BTC-USD', 0, 1, PRICE) })],
    ['blocked', ctxFor({ rules: base, status: 'blocked', state: held(), event: ev('BTC-USD', 1, 2, PRICE) })],
    ['market-halted', ctxFor({ rules: base, market: { ...BTC, status: 'HALT' }, event: ev('BTC-USD', 0, 1, PRICE) })],
    ['different-asset', ctxFor({ rules: rules('proportional', 'copy', 'hyperliquid'), sameAsset: false, event: ev('BTC', 0, 1, PRICE, 'hyperliquid') })],
    ['asset-not-allowed', ctxFor({ rules: { ...base, assetAllow: ['ETH'] }, event: ev('BTC-USD', 0, 1, PRICE) })],
    ['asset-denied', ctxFor({ rules: { ...base, assetDeny: ['BTC'] }, event: ev('BTC-USD', 0, 1, PRICE) })],
    ['pre-existing-position', ctxFor({ rules: base, state: state({ detached: { 'BTC-USD': 'pre-existing' } }), event: ev('BTC-USD', 1, 2, PRICE) })],
    ['after-stop-loss', ctxFor({ rules: base, state: state({ detached: { 'BTC-USD': 'stop-loss' } }), event: ev('BTC-USD', 1, 2, PRICE) })],
    ['after-take-profit', ctxFor({ rules: base, state: state({ detached: { 'BTC-USD': 'take-profit' } }), event: ev('BTC-USD', 1, 2, PRICE) })],
    ['own-position', ctxFor({ rules: base, heldBy: 'follower', event: ev('BTC-USD', 0, 1, PRICE) })],
    ['owned-by-other-copy', ctxFor({ rules: base, heldBy: 'other-copy', event: ev('BTC-USD', 0, 1, PRICE) })],
    ['no-leader-equity', ctxFor({ rules: base, state: state({ leaderEquity: null }), event: ev('BTC-USD', 0, 1, PRICE) })],
    ['at-target', ctxFor({ rules: base, state: held(0.02), event: ev('BTC-USD', 1, 2, PRICE) })],
    ['no-follower-position', ctxFor({ rules: base, event: ev('BTC-USD', 1, 0, PRICE) })],
    ['max-position', ctxFor({ rules: { ...base, maxPositionUsd: 800 }, state: held(), event: ev('BTC-USD', 1, 2, PRICE) })],
    ['max-leverage', ctxFor({ rules: { ...base, maxLeverage: 1 }, state: held(0.0125), event: ev('BTC-USD', 1, 2, PRICE) })],
    ['region-leverage', ctxFor({ rules: base, policy: { maxLeverage: 2 }, state: held(0.025), event: ev('BTC-USD', 2.5, 3, PRICE) })],
    ['min-notional', ctxFor({ rules: base, event: ev('BTC-USD', 0, 0.01, PRICE) })],
    ['lot-size', ctxFor({ rules: base, market: { ...BTC, minNotional: 0 }, event: ev('BTC-USD', 0, 0.0001, PRICE) })],
    ['no-price', ctxFor({ rules: rules('proportional', 'copy', 'hyperliquid'), markOf: () => null, event: ev('BTC', 0, 1, PRICE, 'hyperliquid') })],
    ['free-margin', ctxFor({ rules: base, follower: { accountId: 42, equity: 50, available: 50, positions: {}, at: 0 }, event: ev('BTC-USD', 0, 1, PRICE) })],
    ['bad-leader-size', ctxFor({ rules: base, event: ev('BTC-USD', 0, Number.NaN, PRICE) })],
  ];
  const seen = new Set<SkipReason>();
  for (const [want, c] of cases) {
    const p = planLeaderEvent(c);
    assert.equal(p.skip, want, `${want}: got ${p.skip}`);
    assert.equal(p.intents.length, 0, `${want}: nothing sent`);
    assert.ok(SKIP_REASONS[want].length > 10, `${want} has words`);
    seen.add(want);
  }
  // Two more come from the runtime (matrix-runtime.test.ts): the follower declined, or did not answer in time.
  const runtimeOnly: SkipReason[] = ['declined', 'confirm-timeout'];
  assert.deepEqual(Object.keys(SKIP_REASONS).filter((k) => !seen.has(k as SkipReason)).sort(), [...runtimeOnly].sort());
});

test('a growth too small to trade is not lost: below the minimum order value it is skipped, and the next add takes the copy to its whole target (proportional, fixed ratio, either direction)', () => {
  for (const mode of ['proportional', 'fixedRatio'] as const) {
    for (const direction of DIRECTIONS) {
      const dir = direction === 'counter' ? -1 : 1;
      // 0.01 BTC of the leader is $8 of copy: under SoDEX's $10.
      const out = walk(rules(mode, direction, 'sodex'), [0.01, 0.02, 0]);
      assert.equal(out[0]!.plan.skip, 'min-notional');
      assert.equal(out[0]!.size, 0);
      assert.equal(out[1]!.size, dir * 0.0002, `${mode} ${direction}: $16 at the next add`);
      assert.deepEqual(out[1]!.legs, ['increase']);
      assert.equal(out[2]!.size, 0);
    }
  }
});

/* ================================================================ guards ===== */

test('guards x side x leverage x status: stop-loss and take-profit trigger at their share of the margin, the drawdown stop closes everything; a stopped copy is never guarded', () => {
  for (const side of [1, -1]) {
    for (const lev of [1, 2, 5, 50]) {
      for (const [sl, tp] of [[0.5, null], [null, 1], [0.2, 0.4], [null, null]] as Array<[number | null, number | null]>) {
        const r = { maxLeverage: lev, stopLossPct: sl, takeProfitPct: tp };
        const p = { size: side * 0.01, entry: PRICE };
        const what = `${side > 0 ? 'long' : 'short'} ${lev}x SL ${sl} TP ${tp}`;
        const slAt = guardTrigger('stop-loss', p, r, lev);
        const tpAt = guardTrigger('take-profit', p, r, lev);
        assert.equal(slAt === null, sl === null, what);
        // A short's take-profit at 100% of the margin or more is a price of 0 or under: never reached, so none.
        assert.equal(tpAt === null, tp === null || (side < 0 && tp / lev >= 1), what);
        if (sl !== null) assert.ok(Math.abs(slAt! - PRICE * (1 - (side * sl) / lev)) < 1e-6, `${what}: stop at ${slAt}`);
        if (tp !== null) assert.ok(Math.abs(tpAt! - PRICE * (1 + (side * tp) / lev)) < 1e-6, `${what}: take-profit at ${tpAt}`);
        for (const status of ['active', 'halted', 'blocked', 'paused', 'stopped'] as SubscriptionStatus[]) {
          for (const [at, want] of [[slAt, 'stop-loss'], [tpAt, 'take-profit']] as Array<[number | null, string]>) {
            if (at === null) continue;
            // Just past the trigger.
            const mark = at + (want === 'stop-loss' ? -side : side) * 1;
            const g = planGuards({
              sub: sub({ ...r, drawdownStopPct: null }, { status }),
              state: state({ owned: { 'BTC-USD': { ...p, openedAt: 1 } } }),
              markets: (m) => (m === 'BTC-USD' ? BTC : null),
              markOf: marks({ 'BTC-USD': mark }),
              policy: { maxLeverage: null },
              now: 0,
            });
            if (status === 'stopped') assert.equal(g.intents.length, 0, `${what} ${status}`);
            else {
              assert.deepEqual(g.intents.map((i) => [i.leg, i.reduceOnly, i.side, i.quantity]), [[want, true, side > 0 ? 'sell' : 'buy', '0.01']], `${what} ${status} ${want}`);
              assert.equal(g.closed['BTC-USD'], want);
            }
          }
        }
      }
    }
  }
});

test('the drawdown stop: off never halts, on halts at its share below the peak and closes every market reduce-only; the region\'s leverage moves the stop-loss trigger', () => {
  const st = () => state({ owned: { 'BTC-USD': { size: 0.01, entry: PRICE, openedAt: 1 }, 'ETH-USD': { size: -0.1, entry: 2_000, openedAt: 1 } }, peakEquity: 1_000 });
  const markets = (m: string) => (m === 'BTC-USD' ? BTC : m === 'ETH-USD' ? ETH : null);
  // BTC falls 4,000 (-$40), ETH rises 100 (-$10): equity 950, 5% under its peak.
  const at = marks({ 'BTC-USD': 76_000, 'ETH-USD': 2_100 });
  for (const [dd, halts] of [[null, false], [0.1, false], [0.05, true], [0.01, true]] as Array<[number | null, boolean]>) {
    const g = planGuards({ sub: sub({ drawdownStopPct: dd, stopLossPct: null }), state: st(), markets, markOf: at, policy: { maxLeverage: null }, now: 0 });
    assert.equal(g.halt, halts ? 'drawdown-stop' : null, `drawdown ${dd}`);
    assert.ok(Math.abs(g.equity - 950) < 1e-6);
    if (halts) assert.deepEqual(g.intents.map((i) => [i.symbol, i.leg, i.reduceOnly]).sort(), [['BTC-USD', 'drawdown-stop', true], ['ETH-USD', 'drawdown-stop', true]]);
  }
  // A 50% stop-loss at 5x is 10% of the price; under the EEA's 2x it is 25%.
  const p = { size: 0.01, entry: PRICE };
  assert.equal(guardTrigger('stop-loss', p, { maxLeverage: 5, stopLossPct: 0.5, takeProfitPct: null }, 5), 72_000);
  assert.equal(guardTrigger('stop-loss', p, { maxLeverage: 5, stopLossPct: 0.5, takeProfitPct: null }, 2), 60_000);
  const eea = planGuards({ sub: sub({ maxLeverage: 5, stopLossPct: 0.5, drawdownStopPct: null }), state: state({ owned: { 'BTC-USD': { ...p, openedAt: 1 } } }), markets, markOf: marks({ 'BTC-USD': 70_000 }), policy: { maxLeverage: 2 }, now: 0 });
  assert.equal(eea.intents.length, 0, 'at 2x a 12.5% fall is 25% of the margin: under the 50% stop');
});
