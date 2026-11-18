import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFill, guardTrigger, planGuards, planLeaderEvent, type PlanContext } from '../src/index.ts';
import { BTC, ETH, ev, marks, state, sub } from './helpers.ts';

const NO_REGION = { maxLeverage: null };
const ctx = (o: Partial<PlanContext> & Pick<PlanContext, 'event'>): PlanContext => ({
  sub: sub(),
  state: state(),
  market: BTC,
  markOf: marks({ 'BTC-USD': 80_000, 'ETH-USD': 2_000 }),
  policy: NO_REGION,
  heldBy: 'nobody',
  follower: null,
  ...o,
});

test('proportional open: leader notional x allocation / leader equity, IOC limit at mark + slippage', () => {
  // Leader opens 1 BTC at 80,000 on 100,000 equity: 80% -> 800 of a 1,000 allocation = 0.01 BTC.
  const p = planLeaderEvent(ctx({ event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(p.intents.length, 1);
  const i = p.intents[0]!;
  assert.equal(i.side, 'buy');
  assert.equal(i.quantity, '0.01');
  assert.equal(i.limitPrice, '80400'); // 80,000 x 1.005
  assert.equal(i.reduceOnly, false);
  assert.equal(i.leg, 'open');
  assert.equal(i.clampedBy, null);
  assert.match(i.clOrdID, /^vdc-[0-9a-f]{24}$/);
  assert.equal(p.leaderAfter, 1);
});

test('increase follows the target; decrease takes the leader fraction; close is exact', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  const inc = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 1, 2, 80_000) }));
  assert.equal(inc.intents[0]!.quantity, '0.01');
  assert.equal(inc.intents[0]!.leg, 'increase');

  const st2 = state({ owned: { 'BTC-USD': { size: 0.02, entry: 80_000, openedAt: 1 } } });
  const dec = planLeaderEvent(ctx({ state: st2, event: ev('BTC-USD', 2, 0.5, 80_000) }));
  // Leader keeps a quarter: 0.02 -> 0.005, sell 0.015 reduce-only.
  assert.equal(dec.intents[0]!.side, 'sell');
  assert.equal(dec.intents[0]!.quantity, '0.015');
  assert.equal(dec.intents[0]!.reduceOnly, true);
  assert.equal(dec.intents[0]!.limitPrice, '79600');

  const close = planLeaderEvent(ctx({ state: st2, event: ev('BTC-USD', 2, 0, 80_000) }));
  assert.equal(close.intents[0]!.quantity, '0.02');
  assert.equal(close.intents[0]!.leg, 'close');
});

test('an increase that does not move the target past the copy is at target', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.05, entry: 80_000, openedAt: 1 } } });
  const p = planLeaderEvent(ctx({ sub: sub({ maxPositionUsd: 100_000, maxLeverage: 50 }), state: st, event: ev('BTC-USD', 1, 2, 80_000) }));
  assert.equal(p.intents.length, 0);
  assert.equal(p.skip, 'at-target');
});

test('flip: close ours, then open the new side fresh, in one plan', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 1, -1, 80_000) }));
  assert.deepEqual(
    p.intents.map((i) => [i.leg, i.side, i.quantity, i.reduceOnly]),
    [
      ['flip-close', 'sell', '0.01', true],
      ['flip-open', 'sell', '0.01', false],
    ],
  );
  assert.notEqual(p.intents[0]!.clOrdID, p.intents[1]!.clOrdID);
});

test('caps: max position, then leverage; the region cap is named when it is the one that binds', () => {
  const big = ev('BTC-USD', 0, 10, 80_000); // 800k leader notional on 100k = 8x -> 8,000 target
  const pos = planLeaderEvent(ctx({ event: big }));
  assert.equal(pos.intents[0]!.quantity, '0.03125'); // 2,500 max position / 80,000
  assert.equal(pos.intents[0]!.clampedBy, 'max-position');

  const eu = planLeaderEvent(ctx({ event: ev('BTC-USD', 0, 10, 80_000), policy: { maxLeverage: 2 } }));
  assert.equal(eu.intents[0]!.quantity, '0.025'); // 2x on a 1,000 copy = 2,000 / 80,000
  assert.equal(eu.intents[0]!.clampedBy, 'region-leverage');

  const lev = planLeaderEvent(ctx({ sub: sub({ maxLeverage: 1 }), event: ev('BTC-USD', 0, 10, 80_000) }));
  assert.equal(lev.intents[0]!.quantity, '0.0125');
  assert.equal(lev.intents[0]!.clampedBy, 'max-leverage');
});

test('gross leverage counts the copy positions on other markets', () => {
  // 4,000 of ETH already open on a 1,000 copy at 5x: room is 1,000 -> 0.0125 BTC.
  const st = state({ owned: { 'ETH-USD': { size: 2, entry: 2_000, openedAt: 1 } } });
  const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 0, 10, 80_000) }));
  assert.equal(p.intents[0]!.quantity, '0.0125');
  assert.equal(p.intents[0]!.clampedBy, 'max-leverage');
  const full = state({ owned: { 'ETH-USD': { size: 2.5, entry: 2_000, openedAt: 1 } } });
  const none = planLeaderEvent(ctx({ state: full, event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(none.intents.length, 0);
  assert.equal(none.skip, 'max-leverage');
});

test('below the minimum order value is skipped; reductions are exempt', () => {
  const tiny = planLeaderEvent(ctx({ event: ev('BTC-USD', 0, 0.001, 80_000) })); // 0.8 USD target
  assert.equal(tiny.intents.length, 0);
  assert.equal(tiny.skip, 'min-notional');
  const st = state({ owned: { 'BTC-USD': { size: 0.0001, entry: 80_000, openedAt: 1 } } }); // 8 USD
  const close = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.equal(close.intents[0]!.quantity, '0.0001');
});

test('pre-existing positions: a reduction waits, the leader flat attaches; then the next open is copied', () => {
  const st = state({ detached: { 'BTC-USD': 'pre-existing' } });
  const red = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 2, 1, 80_000) }));
  assert.equal(red.skip, 'pre-existing-position');
  const flat = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.equal(flat.attach, true);
  delete st.detached['BTC-USD'];
  const open = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(open.intents[0]!.leg, 'open');
});

test('an add on a pre-existing position: the copy follows the added part only, through later adds and reductions (owner 2026-11-18)', () => {
  const st = state({ detached: { 'BTC-USD': 'pre-existing' } });
  const full = (l: number) => Number(planLeaderEvent(ctx({ state: state(), event: ev('BTC-USD', 0, l, 80_000) })).intents[0]!.quantity);
  const book = (p: { intents: Array<{ quantity: string; side: string }> }) => {
    for (const i of p.intents) {
      const q = Number(i.quantity) * (i.side === 'buy' ? 1 : -1);
      const cur = st.owned['BTC-USD']?.size ?? 0;
      st.owned['BTC-USD'] = { size: cur + q, entry: 80_000, openedAt: 1 };
    }
  };
  // Leader held 2 before the copy watched; adds 1 -> the copy opens what a fresh 1 would be.
  const add = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 2, 3, 80_000) }));
  assert.equal(add.attach, true);
  assert.equal(Number(add.intents[0]!.quantity), full(1));
  delete st.detached['BTC-USD'];
  book(add);
  assert.equal(st.partial?.['BTC-USD'], 2);
  // Another add of 1: the copy grows to the size of the 2 added.
  const add2 = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 3, 4, 80_000) }));
  book(add2);
  assert.ok(Math.abs(st.owned['BTC-USD']!.size - full(2)) < 1e-9, `two adds copied: ${st.owned['BTC-USD']!.size}`);
  // The leader halves: the copy halves, the part held before halves with it.
  const half = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 4, 2, 80_000) }));
  book(half);
  assert.ok(Math.abs(st.owned['BTC-USD']!.size - full(1)) < 1e-9, `halved: ${st.owned['BTC-USD']!.size}`);
  assert.equal(st.partial?.['BTC-USD'], 1);
  // Flat: closed, and the book-keeping forgotten.
  const close = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 2, 0, 80_000) }));
  assert.equal(close.intents[0]!.leg, 'close');
  assert.equal(st.partial?.['BTC-USD'], undefined);
});

test('a flip on a detached market opens the new side fresh', () => {
  const st = state({ detached: { 'BTC-USD': 'pre-existing' } });
  const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 1, -1, 80_000) }));
  assert.equal(p.attach, true);
  assert.deepEqual(p.intents.map((i) => [i.leg, i.side]), [['open', 'sell']]);
});

test('filters stop new exposure, never a reduction of what the copy holds', () => {
  const deny = sub({ assetDeny: ['BTC'] });
  assert.equal(planLeaderEvent(ctx({ sub: deny, event: ev('BTC-USD', 0, 1, 80_000) })).skip, 'asset-denied');
  const allow = sub({ assetAllow: ['ETH'] });
  assert.equal(planLeaderEvent(ctx({ sub: allow, event: ev('BTC-USD', 0, 1, 80_000) })).skip, 'asset-not-allowed');
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  const close = planLeaderEvent(ctx({ sub: deny, state: st, event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.equal(close.intents[0]!.leg, 'close');
});

test("the follower's own position, or another copy's, is left alone", () => {
  assert.equal(planLeaderEvent(ctx({ heldBy: 'follower', event: ev('BTC-USD', 0, 1, 80_000) })).skip, 'own-position');
  assert.equal(planLeaderEvent(ctx({ heldBy: 'other-copy', event: ev('BTC-USD', 0, 1, 80_000) })).skip, 'owned-by-other-copy');
});

test('paused and halted copies place nothing; duplicates are dropped', () => {
  assert.equal(planLeaderEvent(ctx({ sub: sub({}, { status: 'paused' }), event: ev('BTC-USD', 0, 1, 80_000) })).skip, 'paused');
  assert.equal(planLeaderEvent(ctx({ sub: sub({}, { status: 'halted' }), event: ev('BTC-USD', 0, 1, 80_000) })).skip, 'halted');
  const e = ev('BTC-USD', 0, 1, 80_000);
  assert.equal(planLeaderEvent(ctx({ state: state({ seen: [e.id] }), event: e })).skip, 'duplicate');
});

test('unlisted and spot markets are not copied; proportional needs the leader equity', () => {
  assert.equal(planLeaderEvent(ctx({ market: null, event: ev('XYZ-USD', 0, 1, 1) })).skip, 'not-on-sodex');
  assert.equal(planLeaderEvent(ctx({ market: null, event: ev('vBTC_vUSDC', 0, 1, 1) })).skip, 'spot-not-copied');
  assert.equal(planLeaderEvent(ctx({ state: state({ leaderEquity: null }), event: ev('BTC-USD', 0, 1, 80_000) })).skip, 'no-leader-equity');
});

test('a Hyperliquid leader is sized by notional and converted at the SoDEX mark', () => {
  // HL price 80,500 vs SoDEX mark 80,000: 1 BTC on HL = 80,500 notional -> 805 -> 0.01006 BTC on SoDEX.
  const s = sub({ leader: { venue: 'hyperliquid', address: '0x1111111111111111111111111111111111111111' } });
  const p = planLeaderEvent(ctx({ sub: s, event: ev('BTC', 0, 1, 80_500, 'hyperliquid') }));
  assert.equal(p.intents[0]!.quantity, '0.01006');
});

test('fixed ratio and fixed amount', () => {
  const r = planLeaderEvent(ctx({ sub: sub({ sizingMode: 'fixedRatio', ratio: 0.01 }), event: ev('BTC-USD', 0, 2, 80_000) }));
  assert.equal(r.intents[0]!.quantity, '0.02'); // 1% of 160,000 = 1,600
  const f = planLeaderEvent(ctx({ sub: sub({ sizingMode: 'fixedNotional', fixedNotionalUsd: 100 }), event: ev('BTC-USD', 0, 5, 80_000) }));
  assert.equal(f.intents[0]!.quantity, '0.00125');
  const st = state({ owned: { 'BTC-USD': { size: 0.00125, entry: 80_000, openedAt: 1 } } });
  const add = planLeaderEvent(ctx({ sub: sub({ sizingMode: 'fixedNotional', fixedNotionalUsd: 100 }), state: st, event: ev('BTC-USD', 5, 10, 80_000) }));
  assert.equal(add.intents[0]!.quantity, '0.00125'); // doubles with the leader
});

test('buy limits stay inside SoDEX price band', () => {
  const p = planLeaderEvent(ctx({ sub: sub({ slippageBps: 500 }), event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.ok(Number(p.intents[0]!.limitPrice) < 80_000 * 1.05);
});

test('ETH tick snapping: buy rounds down, sell rounds up', () => {
  const m = { 'ETH-USD': 2_000.03 };
  const buy = planLeaderEvent(ctx({ market: ETH, markOf: marks(m), event: ev('ETH-USD', 0, 10, 2_000) }));
  assert.equal(buy.intents[0]!.limitPrice, '2010'); // 2010.03 floored to 0.1 -> 2010.0
  const st = state({ owned: { 'ETH-USD': { size: 0.4, entry: 2_000, openedAt: 1 } } });
  const sell = planLeaderEvent(ctx({ market: ETH, markOf: marks(m), state: st, event: ev('ETH-USD', 10, 0, 2_000) }));
  assert.equal(sell.intents[0]!.limitPrice, '1990.1'); // 1990.0298... ceiled to 0.1
});

test('guards: stop-loss on the margin at the copy leverage, then the drawdown stop halts', () => {
  const s = sub({ stopLossPct: 0.5, takeProfitPct: 1, maxLeverage: 5 });
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 7 } } });
  // -10% price at 5x = -50% of margin.
  const sl = planGuards({ sub: s, state: st, markets: () => BTC, markOf: marks({ 'BTC-USD': 72_000 }), policy: NO_REGION, now: 0 });
  assert.equal(sl.intents[0]!.leg, 'stop-loss');
  assert.equal(sl.closed['BTC-USD'], 'stop-loss');
  const tp = planGuards({ sub: s, state: st, markets: () => BTC, markOf: marks({ 'BTC-USD': 96_000 }), policy: NO_REGION, now: 0 });
  assert.equal(tp.intents[0]!.leg, 'take-profit');
  assert.equal(guardTrigger('stop-loss', { size: 0.01, entry: 80_000 }, s.settings, 5), 72_000);
  assert.equal(guardTrigger('take-profit', { size: -1, entry: 100 }, s.settings, 5), 80);

  const dd = sub({ drawdownStopPct: 0.3, stopLossPct: null });
  const big = state({ owned: { 'BTC-USD': { size: 0.1, entry: 80_000, openedAt: 7 } }, peakEquity: 1_000 });
  // 0.1 BTC down 3,500 a coin: -350 on a 1,000 copy -> equity 650, 35% below the peak.
  const g = planGuards({ sub: dd, state: big, markets: () => BTC, markOf: marks({ 'BTC-USD': 76_500 }), policy: NO_REGION, now: 0 });
  assert.equal(g.halt, 'drawdown-stop');
  assert.equal(g.intents[0]!.leg, 'drawdown-stop');
});

test('the books: entry averages on adds, realised PnL on reductions, flips reopen at the fill', () => {
  const st = state();
  applyFill(st, 'BTC-USD', 'buy', 0.01, 80_000, 0.32, 1);
  applyFill(st, 'BTC-USD', 'buy', 0.01, 82_000, 0.33, 2);
  assert.equal(st.owned['BTC-USD']!.size, 0.02);
  assert.equal(st.owned['BTC-USD']!.entry, 81_000);
  applyFill(st, 'BTC-USD', 'sell', 0.01, 83_000, 0.33, 3);
  assert.ok(Math.abs(st.realizedPnl - 20) < 1e-9);
  applyFill(st, 'BTC-USD', 'sell', 0.02, 80_000, 0.6, 4);
  assert.ok(Math.abs(st.realizedPnl - 10) < 1e-9); // + 0.01 x (80,000 - 81,000) = -10
  assert.equal(st.owned['BTC-USD']!.size, -0.01);
  assert.equal(st.owned['BTC-USD']!.entry, 80_000);
  assert.ok(Math.abs(st.fees - 1.58) < 1e-9);
});

/* ------------------------------------------------- the follower's free margin ----- */

const account = (available: number, marginKnown = true) => ({ accountId: 42, equity: available, available, marginKnown, positions: {}, at: 0 });

test('free margin: an open the SoDEX account cannot carry is skipped, one it can is placed', () => {
  // 1 BTC of a 100k leader on a 1,000 copy: 0.01 BTC = 800 USD at 5x = 160 margin + 0.32 taker fee.
  const short = planLeaderEvent(ctx({ follower: account(160), event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(short.intents.length, 0);
  assert.equal(short.skip, 'free-margin');
  const enough = planLeaderEvent(ctx({ follower: account(161), event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.equal(enough.intents[0]!.quantity, '0.01');
  // An increase is gated the same way.
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  assert.equal(planLeaderEvent(ctx({ state: st, follower: account(50), event: ev('BTC-USD', 1, 2, 80_000) })).skip, 'free-margin');
});

test('free margin: the region leverage sets the margin an order needs (EEA 2x)', () => {
  // 800 USD at 2x = 400 margin: 300 free is not enough, 401 is.
  assert.equal(planLeaderEvent(ctx({ policy: { maxLeverage: 2 }, follower: account(300), event: ev('BTC-USD', 0, 1, 80_000) })).skip, 'free-margin');
  assert.equal(planLeaderEvent(ctx({ policy: { maxLeverage: 2 }, follower: account(401), event: ev('BTC-USD', 0, 1, 80_000) })).intents.length, 1);
});

test('free margin: reductions are never gated; a flip counts the margin its close gives back', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  const close = planLeaderEvent(ctx({ state: st, follower: account(0), event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.equal(close.intents[0]!.leg, 'close');
  const dec = planLeaderEvent(ctx({ state: state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } }), follower: account(0), event: ev('BTC-USD', 1, 0.5, 80_000) }));
  assert.equal(dec.intents[0]!.leg, 'decrease');
  // No free margin, but closing 0.01 BTC (800 at 5x) frees 160: the 0.005 BTC short (80 + fee) fits.
  const flip = planLeaderEvent(ctx({ state: state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } }), follower: account(0), event: ev('BTC-USD', 1, -0.5, 80_000) }));
  assert.deepEqual(flip.intents.map((i) => i.leg), ['flip-close', 'flip-open']);
});

test('free margin: a margin SoDEX did not report gates nothing; paper copies (no account) are not gated', () => {
  assert.equal(planLeaderEvent(ctx({ follower: account(0, false), event: ev('BTC-USD', 0, 1, 80_000) })).intents.length, 1);
  assert.equal(planLeaderEvent(ctx({ follower: null, event: ev('BTC-USD', 0, 1, 80_000) })).intents.length, 1);
});
