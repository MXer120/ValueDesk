/**
 * The option matrix at run time: every kind with every value of every option
 * at least once, and the options that act on each other in pairs (execution x
 * side, bound x reaction, exits x side, condition x operator...), against one
 * faked SoDEX (matrix-rig.ts) whose invariants are checked after every tick:
 * prices on the tick, sizes on the step, no order under SoDEX's minimum or past
 * the limit price, reduce-only where it must be, no post-only order through
 * the book, one child at a time where the kind works one, never more filled
 * than the size, nothing sent on paper. Then every lifecycle action a trader
 * has (pause, resume, cancel, change, cancel all, a restart) on every kind,
 * and every start the runtime refuses. docs/COVERAGE-ALGOS.md maps each item
 * to these tests and to the live scenarios (scenarios/algo-matrix.ts).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ALGO_KINDS, BOT_KINDS, regionPolicy, type AlgoKind, type AlgoRecord } from '../src/index.ts';
import { ETH } from './helpers.ts';
import { add, clock, crashAndRestart, drive, near, rig, settle, sum, T0, type Rig } from './matrix-rig.ts';

const MIN = 60_000;
const realNow = Date.now;
beforeEach(() => {
  clock.now = T0;
  Date.now = () => clock.now;
});
afterEach(() => {
  Date.now = realNow;
});

const FINAL = new Set(['done', 'cancelled', 'expired', 'failed']);
const prefixOf = (a: AlgoRecord) => `va-${a.id.slice(1, 13)}-`;
const filledOk = (a: AlgoRecord, qty: number) => near(a.filled, qty, 1e-9);

/* ================================================================== TWAP ===== */

for (const style of ['taker', 'maker', 'hybrid'] as const) {
  for (const side of ['buy', 'sell'] as const) {
    test(`TWAP ${style} ${side}: works its size to the end, ${style === 'taker' ? 'IOCs only' : style === 'maker' ? 'post-only slices (the finish takes)' : 'resting first, then taking what falls behind'}`, async () => {
      const r = await rig();
      const a = await add(r, { kind: 'twap', side, quantity: '0.004', durationMs: 4 * MIN, slices: 4, exec: { style, slippageBps: 20, makerShare: 0.5, chaseTicks: 1 } });
      // The tape trades at the touch on every other tick: resting slices fill some of the time.
      const x = (await drive(r, a.id, { ticks: 400, everyMs: 2_000, before: (i, rr) => { if (i % 7 === 3) rr.ex.trade(); } }))!;
      assert.equal(x.status, 'done', x.statusReason ?? '');
      assert.ok(filledOk(x, 0.004), `filled ${x.filled}`);
      assert.ok(near(r.ex.pos('BTC-USD'), side === 'buy' ? 0.004 : -0.004), 'SoDEX holds exactly the size');
      const tifs = new Set(r.ex.of(a.id).map((c) => c.tif));
      if (style === 'taker') assert.deepEqual([...tifs], ['ioc']);
      else assert.ok(tifs.has('gtx'), `${style}: slices rest post-only first`);
      if (style === 'maker') assert.ok(r.ex.of(a.id).filter((c) => c.tif === 'ioc').every((c) => x.children.find((k) => k.clOrdID === c.clOrdID)?.tag === 'finish'), 'a maker TWAP takes only at the finish');
      assert.ok(r.ex.of(a.id).every((c) => c.side === side));
    });
  }
}

for (const [from, side] of [['touch', 'buy'], ['mid', 'buy'], ['mark', 'sell'], ['index', 'buy'], ['oracleMid', 'sell'], ['oracleFair', 'buy']] as const) {
  test(`TWAP slippage from ${from} (${side}): the IOC is priced from that reference, never further than the max slippage`, async () => {
    const r = await rig();
    r.market.set('BTC-USD', 60_000, 60_010, { mark: 60_020, index: 59_990 });
    r.oracleAt = 60_030;
    const a = await add(r, { kind: 'twap', side, quantity: '0.002', durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 10, slipFrom: from } });
    await drive(r, a.id, { ticks: 3, everyMs: 500 });
    const c = r.ex.of(a.id)[0];
    assert.ok(c, 'the first slice went out');
    const ref = { touch: side === 'buy' ? 60_010 : 60_000, mid: 60_005, mark: 60_020, index: 59_990, oracleMid: 60_030, oracleFair: 60_032 }[from];
    const cap = side === 'buy' ? ref * 1.001 : ref * 0.999;
    const px = Number(c.price);
    assert.ok(side === 'buy' ? px <= cap + 1e-9 && px > cap - 1 - 1e-9 : px >= cap - 1e-9 && px < cap + 1 + 1e-9, `${from}: ${px} within one tick inside ${cap}`);
  });
}

test('TWAP slippage from the oracle with no fresh oracle: held, saying so, nothing sent', async () => {
  const r = await rig();
  r.oracleAt = null;
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 10, slipFrom: 'oracleMid' } });
  const x = (await drive(r, a.id, { ticks: 5 }))!;
  assert.equal(r.ex.of(a.id).length, 0);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason ?? '', /no fresh oracle mid/);
});

test('TWAP urgency: +1 front-loads, -1 back-loads, 0 is even; the size is the same', async () => {
  const first: Record<string, number> = {};
  for (const urgency of [-1, 0, 1]) {
    clock.now = T0;
    const r = await rig();
    // Front- or back-loaded about 20x, the smallest slice must still reach SoDEX's minimum: a size of $3,000.
    const a = await add(r, { kind: 'twap', quantity: '0.05', durationMs: 10 * MIN, slices: 10, urgency, exec: { style: 'taker', slippageBps: 20 } });
    const x = (await drive(r, a.id, { ticks: 200, everyMs: 5_000 }))!;
    assert.equal(x.status, 'done');
    assert.ok(filledOk(x, 0.05));
    first[String(urgency)] = Number(r.ex.of(a.id)[0]!.quantity);
  }
  assert.ok(first['1']! > first['0']! && first['0']! > first['-1']!, JSON.stringify(first));
});

test('TWAP size and time jitter at their most (0.5): the total is exact, every slice inside the window', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.01', durationMs: 10 * MIN, slices: 10, sizeJitter: 0.5, timeJitter: 0.5, exec: { style: 'taker', slippageBps: 20 } });
  const times = (r.rt.get(a.id)!.k.times as number[] | undefined) ?? [];
  const x = (await drive(r, a.id, { ticks: 200, everyMs: 5_000 }))!;
  assert.equal(x.status, 'done');
  assert.ok(filledOk(x, 0.01));
  const sizes = r.ex.of(a.id).map((c) => Number(c.quantity));
  assert.ok(new Set(sizes).size > 2, `the slices differ (${sizes.join(', ')})`);
  for (const t of (x.k.times as number[]) ?? times) assert.ok(t >= x.startedAt! && t <= x.startedAt! + 10 * MIN, 'inside the window');
});

for (const finish of ['take', 'leave'] as const) {
  test(`TWAP maker with nothing filling, finish ${finish}: ${finish === 'take' ? 'the rest is taken at the end' : 'it expires with the rest left, nothing resting'}`, async () => {
    const r = await rig();
    const a = await add(r, { kind: 'twap', quantity: '0.003', durationMs: MIN, slices: 3, exec: { style: 'maker', chaseTicks: 1 }, finish });
    const x = (await drive(r, a.id, { ticks: 120, everyMs: 1_000 }))!;
    if (finish === 'take') {
      assert.equal(x.status, 'done');
      assert.ok(filledOk(x, 0.003));
      assert.ok(r.ex.of(a.id).some((c) => c.tif === 'ioc'));
    } else {
      assert.equal(x.status, 'expired');
      assert.equal(x.filled, 0);
      assert.equal(r.ex.of(a.id).filter((c) => c.tif === 'ioc').length, 0, 'nothing taken');
      assert.equal(r.ex.restingOf(a.id).length, 0, 'nothing left resting');
    }
  });
}

test('TWAP max participation: it fills no more per interval than its share of the market\'s volume; the finish takes the rest', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.01', durationMs: 10 * MIN, slices: 10, maxParticipation: 0.1, exec: { style: 'taker', slippageBps: 20 } });
  // Others print 0.002 BTC a tick (5 s): 0.024 a minute, so 10% is 0.0024 a minute, more than the 0.001 a slice wants.
  let x = (await drive(r, a.id, { ticks: 30, everyMs: 5_000, printQty: 0.0002 }))!;
  // 0.0002 x 12 ticks = 0.0024 a minute; 10%: 0.00024 a minute, under SoDEX's minimum (0.00017 at 60k is $10): it waits and grows.
  assert.ok(x.filled < 0.0025, `held back by the volume (${x.filled} after 2.5 min, the schedule wanted 0.0025)`);
  x = (await drive(r, a.id, { ticks: 200, everyMs: 5_000, printQty: 0.0002 }))!;
  assert.equal(x.status, 'done');
  assert.ok(filledOk(x, 0.01), 'what the volume held back is taken at the end');
});

test('TWAP smallest and largest slice: no slice over the largest, none under the smallest but the last', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.01', durationMs: 10 * MIN, slices: 20, minSliceQty: '0.0008', maxSliceQty: '0.0015', exec: { style: 'taker', slippageBps: 20 } });
  const x = (await drive(r, a.id, { ticks: 300, everyMs: 5_000 }))!;
  assert.equal(x.status, 'done');
  assert.ok(filledOk(x, 0.01));
  const sizes = r.ex.of(a.id).map((c) => Number(c.quantity));
  assert.ok(sizes.every((q) => q <= 0.0015 + 1e-12), `none over the largest (${sizes.join(', ')})`);
  assert.ok(sizes.slice(0, -1).every((q) => q >= 0.0008 - 1e-12), 'none under the smallest but the last');
});

for (const [pos, share] of [[0.01, 0.5], [-0.006, 1], [0, 1]] as const) {
  test(`TWAP close ${share * 100}% of a position of ${pos}: ${pos === 0 ? 'nothing to close, it expires' : 'reduce-only on the side that reduces it'}`, async () => {
    const r = await rig();
    r.ex.positions.set('BTC-USD', pos);
    // The ticket's side is ignored: the position says which way.
    const a = await add(r, { kind: 'twap', side: 'buy', closeShare: share, durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 30 } });
    const x = (await drive(r, a.id, { ticks: 120 }))!;
    if (pos === 0) {
      assert.equal(x.status, 'expired');
      assert.match(x.statusReason ?? '', /no position/);
      assert.equal(r.ex.of(a.id).length, 0);
      return;
    }
    assert.equal(x.status, 'done', x.statusReason ?? '');
    assert.ok(near(x.filled, Math.abs(pos) * share, 1e-9));
    assert.ok(r.ex.of(a.id).every((c) => c.reduceOnly && c.side === (pos > 0 ? 'sell' : 'buy')));
    assert.ok(near(r.ex.pos('BTC-USD'), pos * (1 - share), 1e-9));
  });
}

test('TWAP close while the position cannot be read: it waits and reads again (never "no position")', async () => {
  const r = await rig();
  r.ex.positions.set('BTC-USD', 0.004);
  r.positionsFail = true;
  const a = await add(r, { kind: 'twap', side: 'sell', closeShare: 1, durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 30 } });
  let x = (await drive(r, a.id, { ticks: 5 }))!;
  assert.ok(!FINAL.has(x.status), `still waiting (${x.status})`);
  assert.equal(r.ex.of(a.id).length, 0);
  r.positionsFail = false;
  x = (await drive(r, a.id, { ticks: 120 }))!;
  assert.equal(x.status, 'done');
  assert.ok(near(r.ex.pos('BTC-USD'), 0));
});

/* ---------------------------------------------- bounds x reaction (every kind that takes them) ----- */

for (const kind of ['twap', 'vwap', 'pov', 'iceberg', 'chase', 'dca', 'swarm', 'sweep'] as const) {
  for (const which of ['upper', 'lower'] as const) {
    for (const then of ['hold', 'stop', 'rush'] as const) {
      test(`bounds: ${kind}, the mark ${which === 'upper' ? 'at or above the upper' : 'at or below the lower'} bound, then ${then}`, async () => {
        const r = await rig();
        const spec: Record<string, unknown> = {
          twap: { kind, quantity: '0.004', durationMs: 4 * MIN, slices: 4, exec: { style: 'taker', slippageBps: 20 } },
          vwap: { kind, quantity: '0.004', durationMs: 20 * MIN, slices: 4, lookbackDays: 3, exec: { style: 'taker', slippageBps: 20 } },
          pov: { kind, quantity: '0.004', rate: 0.2, exec: { style: 'taker', slippageBps: 20 } },
          iceberg: { kind, quantity: '0.004', displayQty: '0.001', postOnly: true },
          chase: { kind, quantity: '0.004' },
          dca: { kind, perOrderUsd: 20, orders: 4, intervalMs: MIN, exec: { style: 'taker', slippageBps: 20 } },
          swarm: { kind, quantity: '0.004', clips: 4, inFlight: 1, waveMs: 30_000, slippageBps: 20 },
          sweep: { kind, quantity: '0.004', reference: 'oracleMid', slippageBps: 20, roundMs: 500 },
        }[kind] as Record<string, unknown>;
        const bound = { price: which === 'upper' ? 60_100 : 59_900, then };
        // A fill fast takes everything in its first round: here the oracle is far off, so nothing fills until the bound acts.
        if (kind === 'sweep') r.oracleAt = 59_000;
        const a = await add(r, { ...spec, [which]: bound });
        // One child goes out at the start (the first slice, clip, round...), then the mark leaves the band.
        await drive(r, a.id, { ticks: 3, everyMs: 1_000, printQty: 0.01 });
        const before = r.ex.of(a.id).length;
        const filledBefore = r.rt.get(a.id)!.filled;
        const out = which === 'upper' ? [60_200, 60_210] : [59_800, 59_810];
        r.market.set('BTC-USD', out[0]!, out[1]!);
        r.oracleAt = kind === 'sweep' ? 59_000 : (out[0]! + out[1]!) / 2;
        const x = (await drive(r, a.id, { ticks: 8, everyMs: 1_000, before: (_i, rr) => rr.market.set('BTC-USD', out[0]!, out[1]!), printQty: 0.01 }))!;
        if (then === 'stop') {
          assert.ok(['expired', 'done'].includes(x.status), `stopped (${x.status})`);
          assert.match(x.statusReason ?? '', /bound/);
          assert.equal(r.ex.restingOf(a.id).length, 0, 'nothing left resting');
        } else if (then === 'hold') {
          assert.equal(x.status, 'waiting', x.statusReason ?? '');
          assert.match(x.statusReason ?? '', /bound/);
          assert.equal(r.ex.restingOf(a.id).length, 0, 'resting children pulled');
          assert.equal(r.ex.of(a.id).filter((c) => c.tif === 'ioc').length, r.ex.of(a.id).slice(0, before).filter((c) => c.tif === 'ioc').length, 'nothing taken while held');
          // Back inside: it goes on.
          r.market.set('BTC-USD', 60_000, 60_010);
          if (kind !== 'sweep') r.oracleAt = 60_005;
          const y = (await drive(r, a.id, { ticks: 6, everyMs: 1_000, printQty: 0.01 }))!;
          assert.ok(['running', 'done'].includes(y.status), `running again (${y.status}: ${y.statusReason ?? ''})`);
        } else if (kind === 'dca') {
          // A DCA's rush takes what is due now instead of resting it; its later orders keep their times (a schedule of
          // separate orders, never merged: runtime stepDca). Taker already, it goes on as planned.
          assert.equal(x.status, 'running');
          assert.ok(x.filled >= filledBefore);
        } else if (kind === 'sweep') {
          // A fill fast already takes all it can inside its band: a rush changes nothing (the oracle is far: nothing fills).
          assert.ok(!FINAL.has(x.status) || x.status === 'expired', x.status);
        } else {
          assert.ok(x.filled > filledBefore || x.status === 'done', `${kind}: rushed (${x.status} ${x.filled})`);
          assert.ok(filledOk(x, 0.004) || x.status === 'done', `${kind}: everything taken at once (${x.filled})`);
        }
      });
    }
  }
}

test('bounds on a scale: any bound reached ends the ladder (a hold or a rush would only re-place it), its levels pulled', async () => {
  for (const then of ['hold', 'rush'] as const) {
    clock.now = T0;
    const r = await rig();
    const a = await add(r, { kind: 'scale', quantity: '0.004', from: 59_900, to: 59_500, orders: 4, postOnly: true, lower: { price: 59_000, then } });
    await drive(r, a.id, { ticks: 2 });
    assert.equal(r.ex.restingOf(a.id).length, 4);
    r.market.set('BTC-USD', 58_900, 58_910);
    const x = (await drive(r, a.id, { ticks: 4, before: (_i, rr) => rr.market.set('BTC-USD', 58_900, 58_910) }))!;
    assert.ok(FINAL.has(x.status), `${then}: ended (${x.status})`);
    assert.equal(r.ex.restingOf(a.id).length, 0);
  }
});

/* ---------------------------------------------------------- start: time, price ----- */

for (const fromSide of ['below', 'above'] as const) {
  test(`start price reached from ${fromSide}: nothing until the mark gets there, then it starts`, async () => {
    const r = await rig();
    const trig = fromSide === 'below' ? 60_100 : 59_900;
    const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: MIN, slices: 2, triggerPrice: trig, exec: { style: 'taker', slippageBps: 20 } });
    let x = (await drive(r, a.id, { ticks: 10 }))!;
    assert.equal(x.status, 'scheduled');
    assert.equal(r.ex.of(a.id).length, 0);
    const [b, k] = fromSide === 'below' ? [60_100, 60_110] : [59_890, 59_900];
    r.market.set('BTC-USD', b, k);
    x = (await drive(r, a.id, { ticks: 120, before: (_i, rr) => rr.market.set('BTC-USD', b, k) }))!;
    assert.equal(x.status, 'done');
    assert.ok(filledOk(x, 0.002));
  });
}

test('start time: nothing until then; a scheduled algo cancelled before it sends nothing', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'swarm', quantity: '0.002', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20, startAt: T0 + 5 * MIN });
  let x = (await drive(r, a.id, { ticks: 30, everyMs: 5_000 }))!;
  assert.equal(x.status, 'scheduled');
  assert.equal(r.ex.of(a.id).length, 0);
  x = (await drive(r, a.id, { ticks: 60, everyMs: 5_000 }))!;
  assert.equal(x.status, 'done');
  const b = await add(r, { kind: 'swarm', quantity: '0.002', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20, startAt: clock.now + 5 * MIN });
  await r.rt.cancel(b.id);
  await drive(r, b.id, { ticks: 80, everyMs: 5_000 });
  assert.equal(r.rt.get(b.id)!.status, 'cancelled');
  assert.equal(r.ex.of(b.id).length, 0);
});

/* ------------------------------------------------------------------ the spread guard, every kind ----- */

for (const kind of ['twap', 'vwap', 'pov', 'iceberg', 'chase', 'dca', 'swarm', 'basket'] as const) {
  test(`spread guard: a ${kind} sends nothing while the spread is wider than its max, and goes on once it narrows`, async () => {
    const r = await rig();
    const spec: Record<string, unknown> = {
      twap: { kind, quantity: '0.002', durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 50 } },
      vwap: { kind, quantity: '0.002', durationMs: 15 * MIN, slices: 2, lookbackDays: 1, exec: { style: 'hybrid', slippageBps: 50 } },
      pov: { kind, quantity: '0.002', rate: 0.5, exec: { style: 'maker' } },
      iceberg: { kind, quantity: '0.002', displayQty: '0.001' },
      chase: { kind, quantity: '0.002' },
      dca: { kind, perOrderUsd: 20, orders: 2, intervalMs: MIN, exec: { style: 'maker' } },
      swarm: { kind, quantity: '0.002', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 50 },
      basket: { kind, legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 30 }, { symbol: 'ETH-USD', side: 'sell', usd: 30 }], style: 'swarm', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 50 },
    }[kind] as Record<string, unknown>;
    // 20 bp wide; the guard is 5 bp.
    r.market.set('BTC-USD', 60_000, 60_120);
    r.market.set('ETH-USD', 3_000, 3_006);
    const a = await add(r, { ...spec, maxSpreadBps: 5 });
    const wide = (_i: number, rr: Rig) => {
      rr.market.set('BTC-USD', 60_000, 60_120);
      rr.market.set('ETH-USD', 3_000, 3_006);
    };
    await drive(r, a.id, { ticks: 15, before: wide, printQty: 0.01 });
    const sent = r.ex.sent.filter((c) => c.algoId === a.id || r.rt.get(c.algoId)?.parentId === a.id);
    assert.equal(sent.length, 0, `${kind}: nothing sent at a wide spread`);
    const held = [a.id, ...r.rt.list().filter((x) => x.parentId === a.id).map((x) => x.id)].map((id) => r.rt.get(id)!);
    assert.ok(held.some((x) => /spread/.test(x.statusReason ?? '')), `${kind}: held, saying why`);
    r.market.set('BTC-USD', 60_000, 60_010);
    r.market.set('ETH-USD', 3_000, 3_000.5);
    await drive(r, a.id, { ticks: 30, printQty: 0.01 });
    assert.ok(r.ex.sent.some((c) => c.algoId === a.id || r.rt.get(c.algoId)?.parentId === a.id), `${kind}: sends once it narrows`);
  });
}

/* ------------------------------------------------------------------ leverage, margin, region ----- */

const LEV: Array<{ what: string; leverage: number | null; marginMode: 'cross' | 'isolated' | null; policy: ReturnType<typeof regionPolicy> | null; reduceOnly?: boolean; want: { leverage: number; margin: string } | null }> = [
  { what: '3x isolated', leverage: 3, marginMode: 'isolated', policy: null, want: { leverage: 3, margin: 'isolated' } },
  { what: '5x cross', leverage: 5, marginMode: 'cross', policy: null, want: { leverage: 5, margin: 'cross' } },
  { what: '100x on a 50x market: the market\'s max', leverage: 100, marginMode: 'cross', policy: null, want: { leverage: 50, margin: 'cross' } },
  { what: '10x in the EEA: the 2x cap', leverage: 10, marginMode: 'isolated', policy: regionPolicy('DE'), want: { leverage: 2, margin: 'isolated' } },
  { what: 'no leverage in the EEA: set to the 2x cap', leverage: null, marginMode: null, policy: regionPolicy('FR'), want: { leverage: 2, margin: 'cross' } },
  { what: 'no leverage elsewhere: left as it is', leverage: null, marginMode: null, policy: regionPolicy('SG'), want: null },
  { what: 'reduce-only: nothing set (it opens nothing)', leverage: 5, marginMode: 'isolated', policy: null, reduceOnly: true, want: null },
];

for (const c of LEV) {
  test(`leverage: ${c.what}`, async () => {
    const r = await rig({ policy: c.policy });
    if (c.reduceOnly) r.ex.positions.set('BTC-USD', -0.01);
    const a = await add(r, { kind: 'swarm', quantity: '0.002', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20, leverage: c.leverage, marginMode: c.marginMode, reduceOnly: c.reduceOnly ?? false });
    await drive(r, a.id, { ticks: 10 });
    assert.equal(r.rt.get(a.id)!.status, 'done', r.rt.get(a.id)!.statusReason ?? '');
    if (c.want === null) assert.deepEqual(r.ex.leverage, []);
    else assert.deepEqual(r.ex.leverage, [{ symbol: 'BTC-USD', ...c.want }]);
  });
}

test('region: the EEA 2x cap on gross exposure shrinks a child to the room left, then holds; paper is not held', async () => {
  const r = await rig({ policy: regionPolicy('DE') });
  // $500 of equity, $900 already open: $100 of room at 2x.
  r.account = { equity: 500, gross: 900 };
  const a = await add(r, { kind: 'swarm', quantity: '0.005', clips: 1 + 1, inFlight: 2, waveMs: 0, slippageBps: 20 });
  const x = (await drive(r, a.id, { ticks: 10 }))!;
  const sentUsd = sum(r.ex.of(a.id).map((c) => Number(c.quantity) * Number(c.price)));
  assert.ok(sentUsd <= 100 + 60, `no more than the room left (about $100) went out ($${sentUsd.toFixed(2)})`);
  assert.ok(x.status === 'waiting' || x.status === 'running' || x.status === 'done', x.status);
  const p = await add(r, { kind: 'swarm', quantity: '0.005', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20, paper: true });
  const y = (await drive(r, p.id, { ticks: 10 }))!;
  assert.equal(y.status, 'done', 'a paper algo is not held by the cap');
});

for (const country of ['US', 'IR', 'GB'] as const) {
  test(`region: a live algo of a trader in ${country} is held${country === 'GB' ? ' unless it only closes (close-only)' : ''}`, async () => {
    const r = await rig({ policy: regionPolicy(country) });
    const a = await add(r, { kind: 'swarm', quantity: '0.002', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20 });
    const x = (await drive(r, a.id, { ticks: 6 }))!;
    assert.ok(['scheduled', 'waiting'].includes(x.status), x.status);
    assert.match(x.statusReason ?? '', /not available/);
    assert.equal(r.ex.of(a.id).length, 0);
    r.ex.positions.set('BTC-USD', 0.002);
    const c = await add(r, { kind: 'swarm', side: 'sell', reduceOnly: true, quantity: '0.002', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20 });
    const y = (await drive(r, c.id, { ticks: 6, until: (rr) => FINAL.has(rr.rt.get(c.id)!.status) }))!;
    const closeOnly = regionPolicy(country).closeOnly === true;
    if (closeOnly) assert.equal(y.status, 'done', `${country}: a reduce-only close runs`);
    else assert.ok(['scheduled', 'waiting'].includes(y.status) && r.ex.of(c.id).length === 0, `${country}: a reduce-only close is held too (${y.status})`);
  });
}

/* =================================================================== VWAP ===== */

for (const [adaptive, style, finish] of [[true, 'taker', 'take'], [false, 'maker', 'take'], [true, 'hybrid', 'leave'], [false, 'taker', 'leave']] as const) {
  test(`VWAP adaptive ${adaptive}, ${style}, finish ${finish}: without history the schedule is even; ${finish === 'take' ? 'it ends filled' : 'what did not fill is left'}`, async () => {
    const r = await rig();
    const a = await add(r, { kind: 'vwap', side: style === 'maker' ? 'sell' : 'buy', quantity: '0.004', durationMs: 15 * MIN, slices: 3, lookbackDays: 56, adaptive, exec: { style, slippageBps: 20, makerShare: 0.5 }, finish, maxParticipation: style === 'hybrid' ? 0.5 : null });
    const x = (await drive(r, a.id, { ticks: 300, everyMs: 10_000, printQty: 0.002, trade: style === 'maker' }))!;
    assert.ok(FINAL.has(x.status), x.status);
    if (finish === 'take' || (style as string) !== 'maker') assert.ok(x.filled > 0);
    if (finish === 'take') assert.ok(filledOk(x, 0.004), `filled ${x.filled}`);
    assert.equal(r.ex.restingOf(a.id).length, 0);
    assert.ok((await r.rt.events(a.id)).some((e) => /schedule is even/.test(e.text)), 'it says the schedule is even');
  });
}

/* ==================================================================== POV ===== */

for (const rate of [0.01, 0.1, 0.5]) {
  test(`POV at ${rate * 100}%: its fills are that share of everything printed, its own included`, async () => {
    const r = await rig();
    const a = await add(r, { kind: 'pov', quantity: '0.05', rate, exec: { style: 'taker', slippageBps: 20 } });
    const x = (await drive(r, a.id, { ticks: 60, everyMs: 1_000, printQty: 0.02, until: () => false }))!;
    const others = 60 * 0.02;
    const want = Math.min(0.05, (others * rate) / (1 - rate));
    // What is due waits until it reaches SoDEX's minimum: it lags by at most one minimum order.
    assert.ok(x.filled <= want + 1e-9 && x.filled >= want - 0.00034, `filled ${x.filled}, due ${want}`);
  });
}

test('POV largest child, maker and hybrid execution, and an end time with finish take / leave', async () => {
  for (const [style, finish] of [['maker', 'leave'], ['hybrid', 'take'], ['taker', 'take']] as const) {
    clock.now = T0;
    const r = await rig();
    const a = await add(r, { kind: 'pov', side: 'sell', quantity: '0.01', rate: 0.3, maxChildQty: '0.0005', endAt: T0 + 2 * MIN, exec: { style, slippageBps: 20, makerShare: 0.5 }, finish });
    const x = (await drive(r, a.id, { ticks: 200, everyMs: 1_000, printQty: 0.002, trade: style === 'maker' }))!;
    assert.ok(r.ex.of(a.id).filter((c) => !x.children.find((k) => k.clOrdID === c.clOrdID)?.tag.startsWith('finish')).every((c) => Number(c.quantity) <= 0.0005 + 1e-12), `${style}: no child over the largest`);
    assert.ok(FINAL.has(x.status), `${style}: ended at its end time (${x.status})`);
    if (finish === 'take') assert.ok(filledOk(x, 0.01), `${style} take: ${x.filled}`);
    else assert.equal(x.status, x.filled >= 0.01 - 1e-9 ? 'done' : 'expired');
  }
});

/* ================================================================ Iceberg ===== */

for (const [pegged, postOnly, side] of [[true, true, 'buy'], [true, false, 'sell'], [false, true, 'sell'], [false, false, 'buy']] as const) {
  test(`Iceberg ${pegged ? 'pegged' : 'at a fixed price'}, ${postOnly ? 'post-only (GTX)' : 'GTC'}, ${side}: one clip at a time until it is all filled`, async () => {
    const r = await rig();
    const price = side === 'buy' ? 59_990 : 60_020;
    const a = await add(r, { kind: 'iceberg', side, quantity: '0.003', displayQty: '0.001', displayJitter: 0.3, price: pegged ? null : price, postOnly, pegOffsetTicks: pegged ? 1 : 0, chaseTicks: 2, refillMs: 2_000, refillJitter: 1 });
    let most = 0;
    const x = (await drive(r, a.id, {
      ticks: 200,
      before: (i, rr) => {
        most = Math.max(most, rr.ex.restingOf(a.id).length);
        // The tape reaches the clip every few ticks.
        if (i % 4 === 3) for (const c of rr.ex.restingOf(a.id)) rr.ex.fill(c.clOrdID, Number(c.quantity) - c.filled);
      },
    }))!;
    assert.equal(x.status, 'done', x.statusReason ?? '');
    assert.ok(filledOk(x, 0.003));
    assert.ok(most <= 1, 'one clip shows at a time');
    const sent = r.ex.of(a.id);
    assert.ok(sent.every((c) => c.tif === (postOnly ? 'gtx' : 'gtc')));
    if (!pegged) assert.ok(sent.every((c) => Number(c.price) === price), 'every clip at the fixed price');
    else assert.ok(sent.every((c) => (side === 'buy' ? Number(c.price) <= c.bid - 1 : Number(c.price) >= c.ask + 1)), 'pegged one tick behind the touch');
  });
}

test('Iceberg pegged: re-priced once the touch is chaseTicks away; a fixed post-only price through the book waits', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.002', displayQty: '0.001', chaseTicks: 3 });
  await drive(r, a.id, { ticks: 2 });
  const first = r.ex.restingOf(a.id)[0]!;
  r.market.set('BTC-USD', 60_002, 60_012);
  await drive(r, a.id, { ticks: 3, before: (_i, rr) => rr.market.set('BTC-USD', 60_002, 60_012) });
  assert.equal(r.ex.restingOf(a.id)[0]!.clOrdID, first.clOrdID, '2 ticks: not re-priced');
  r.market.set('BTC-USD', 60_005, 60_015);
  await drive(r, a.id, { ticks: 4, before: (_i, rr) => rr.market.set('BTC-USD', 60_005, 60_015) });
  const now = r.ex.restingOf(a.id)[0]!;
  assert.notEqual(now.clOrdID, first.clOrdID, '5 ticks: re-priced');
  assert.equal(Number(now.price), 60_005);
  const b = await add(r, { kind: 'iceberg', quantity: '0.002', displayQty: '0.001', price: 60_020, postOnly: true });
  const y = (await drive(r, b.id, { ticks: 3 }))!;
  assert.equal(r.ex.of(b.id).length, 0);
  assert.match(y.statusReason ?? '', /through the book/);
});

/* ================================================================== Chase ===== */

for (const [offsetTicks, offsetBps, side] of [[0, null, 'buy'], [-1, null, 'sell'], [3, null, 'buy'], [0, 20, 'sell']] as const) {
  test(`Chase ${side}, offset ${offsetBps !== null ? `${offsetBps} bp` : `${offsetTicks} ticks`}: one post-only order at that distance from the touch`, async () => {
    const r = await rig();
    const a = await add(r, { kind: 'chase', side, quantity: '0.002', offsetTicks, offsetBps });
    await drive(r, a.id, { ticks: 2 });
    const c = r.ex.restingOf(a.id)[0]!;
    assert.equal(c.tif, 'gtx');
    const want = offsetBps !== null ? ((side as string) === 'buy' ? Math.floor(60_000 * (1 - offsetBps / 10_000)) : Math.ceil(60_010 * (1 + offsetBps / 10_000))) : side === 'buy' ? 60_000 - offsetTicks : 60_010 + offsetTicks;
    assert.equal(Number(c.price), want);
    r.ex.trade();
    if (offsetTicks === 0 && offsetBps === null) {
      const x = (await drive(r, a.id, { ticks: 3 }))!;
      assert.equal(x.status, 'done');
    }
  });
}

for (const onEnd of ['take', 'cancel', 'rest'] as const) {
  for (const by of ['time', 'cap'] as const) {
    test(`Chase ending by ${by === 'time' ? 'its time limit' : 'the price running past its max chase'}, onEnd ${onEnd}`, async () => {
      const r = await rig();
      const a = await add(r, { kind: 'chase', quantity: '0.002', chaseTicks: 1, minRepriceMs: 250, maxChaseBps: by === 'cap' ? 10 : null, timeoutMs: by === 'time' ? 10_000 : null, onEnd });
      await drive(r, a.id, { ticks: 2 });
      const x = (await drive(r, a.id, { ticks: 30, before: (i, rr) => { if (by === 'cap') rr.market.set('BTC-USD', 60_000 + 20 * (i + 1), 60_010 + 20 * (i + 1)); } }))!;
      assert.ok(FINAL.has(x.status), x.status);
      if (onEnd === 'take') {
        assert.equal(x.status, 'done');
        assert.ok(filledOk(x, 0.002));
        assert.ok(r.ex.of(a.id).some((c) => c.tif === 'ioc'), 'the rest taken');
      } else if (onEnd === 'cancel') {
        assert.equal(x.status, 'expired');
        assert.equal(r.ex.restingOf(a.id).length, 0);
      } else {
        assert.equal(x.status, 'expired');
        assert.equal(r.ex.restingOf(a.id).length, 1, 'left resting on SoDEX, as chosen');
        // A cancel of the ended chase pulls what it left.
        await r.rt.cancel(a.id);
        await settle();
        assert.equal(r.ex.restingOf(a.id).length, 0);
      }
      if (by === 'cap') assert.ok(r.ex.of(a.id).filter((c) => c.tif === 'gtx').every((c) => Number(c.price) <= 60_000 * 1.001 + 1e-9), 'never chased past 10 bp from where it began');
    });
  }
}

test('Chase: re-priced only once the touch is chaseTicks away, and no sooner than minRepriceMs', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', chaseTicks: 5, minRepriceMs: 10_000 });
  await drive(r, a.id, { ticks: 2 });
  const first = r.ex.restingOf(a.id)[0]!.clOrdID;
  r.market.set('BTC-USD', 60_003, 60_013);
  await drive(r, a.id, { ticks: 20, before: (_i, rr) => rr.market.set('BTC-USD', 60_003, 60_013) });
  assert.equal(r.ex.restingOf(a.id)[0]!.clOrdID, first, '3 ticks away: stays');
  r.market.set('BTC-USD', 60_008, 60_018);
  await drive(r, a.id, { ticks: 3, everyMs: 1_000, before: (_i, rr) => rr.market.set('BTC-USD', 60_008, 60_018) });
  assert.notEqual(r.ex.restingOf(a.id)[0]?.clOrdID ?? first, first, 'past the pause and 8 ticks away: re-priced');
});

/* ================================================================== Scale ===== */

for (const distribution of ['flat', 'linear', 'exponential', 'bell'] as const) {
  for (const spacing of ['linear', 'geometric', 'front', 'back'] as const) {
    test(`Scale ${distribution} sizes, ${spacing} spacing: every level inside the range, distinct, on the tick, adding up to the size`, async () => {
      const r = await rig();
      const side = spacing === 'back' ? 'sell' : 'buy';
      const [from, to] = side === 'buy' ? [59_900, 59_000] : [60_100, 61_000];
      const a = await add(r, { kind: 'scale', side, quantity: '0.01', from, to, orders: 6, distribution, skew: distribution === 'linear' ? 3 : distribution === 'exponential' ? 0.25 : 1, spacing, sizeJitter: distribution === 'bell' ? 0.3 : 0, postOnly: spacing !== 'front' });
      await drive(r, a.id, { ticks: 2 });
      const lv = r.ex.restingOf(a.id);
      assert.equal(lv.length, 6);
      const ps = lv.map((c) => Number(c.price));
      assert.equal(new Set(ps).size, 6, 'distinct prices');
      assert.ok(ps.every((p) => p <= Math.max(from, to) && p >= Math.min(from, to)), 'inside the range');
      assert.ok(near(sum(lv.map((c) => Number(c.quantity))), 0.01, 1e-9), 'the levels add up to the size');
      assert.ok(lv.every((c) => c.tif === (spacing !== 'front' ? 'gtx' : 'gtc')));
      const qs = [...lv].sort((x, y) => (side === 'buy' ? y.price.localeCompare(x.price, undefined, { numeric: true }) : Number(x.price) - Number(y.price))).map((c) => Number(c.quantity));
      if (distribution === 'linear') assert.ok(qs[5]! > qs[0]!, 'growing toward the last price (skew 3)');
      if (distribution === 'exponential') assert.ok(qs[5]! < qs[0]!, 'shrinking toward the last price (skew 0.25)');
      // Every level fills: done.
      r.market.set('BTC-USD', side === 'buy' ? 58_990 : 61_010, side === 'buy' ? 59_000 : 61_020);
      r.ex.trade();
      const x = (await drive(r, a.id, { ticks: 4, before: (_i, rr) => rr.market.set('BTC-USD', side === 'buy' ? 58_990 : 61_010, side === 'buy' ? 59_000 : 61_020) }))!;
      assert.equal(x.status, 'done');
      assert.ok(filledOk(x, 0.01));
    });
  }
}

test('Scale with explicit levels and sizes (the ticket\'s DCA): each level at its price and in its proportion', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.0065', from: 59_900, to: 59_300, orders: 3, prices: [59_900, 59_600, 59_300], weights: [0.001, 0.0015, 0.00225], postOnly: true });
  await drive(r, a.id, { ticks: 2 });
  const lv = r.ex.restingOf(a.id).sort((x, y) => Number(y.price) - Number(x.price));
  assert.deepEqual(lv.map((c) => Number(c.price)), [59_900, 59_600, 59_300]);
  const q = lv.map((c) => Number(c.quantity));
  assert.ok(q[1]! / q[0]! > 1.4 && q[2]! / q[1]! > 1.4, q.join(', '));
});

/* ==================================================================== DCA ===== */

for (const [style, side] of [['taker', 'buy'], ['maker', 'sell'], ['hybrid', 'buy']] as const) {
  test(`DCA (engine) ${style} ${side}: one order an interval, each its own size, never merged`, async () => {
    const r = await rig();
    const a = await add(r, { kind: 'dca', side, perOrderUsd: 30, orders: 3, intervalMs: MIN, exec: { style, slippageBps: 20, makerShare: 0.5 } });
    const x = (await drive(r, a.id, { ticks: 300, everyMs: 2_000, before: (i, rr) => { if (style === 'maker' && i % 10 === 9) rr.ex.trade(); } }))!;
    assert.equal(x.status, 'done', x.statusReason ?? '');
    assert.ok(near(x.filledValue, 90, 2), `about $90 (${x.filledValue})`);
    const tags = new Set(x.children.map((c) => c.tag));
    assert.ok(['order 1/3', 'order 2/3', 'order 3/3'].every((t) => tags.has(t)), [...tags].join(', '));
    if (style === 'maker') assert.ok(r.ex.of(a.id).every((c) => c.tif === 'gtx'), 'a maker DCA only rests');
  });
}

test('DCA outside the limit: skip drops the orders; wait holds and catches up once the price is back', async () => {
  for (const outOfBand of ['skip', 'wait'] as const) {
    clock.now = T0;
    const r = await rig();
    const a = await add(r, { kind: 'dca', perOrderUsd: 20, orders: 3, intervalMs: MIN, limitPrice: 59_000, outOfBand, exec: { style: 'taker', slippageBps: 20 } });
    let x = (await drive(r, a.id, { ticks: 150, everyMs: 1_000 }))!;
    assert.equal(r.ex.of(a.id).length, 0, `${outOfBand}: nothing sent above the limit`);
    if (outOfBand === 'skip') {
      assert.ok(FINAL.has(x.status), `${outOfBand}: ${x.status}`);
      assert.equal(x.k.skipped, 3);
      continue;
    }
    assert.equal(x.status, 'waiting');
    r.market.set('BTC-USD', 58_990, 59_000);
    x = (await drive(r, a.id, { ticks: 20, before: (_i, rr) => rr.market.set('BTC-USD', 58_990, 59_000) }))!;
    assert.equal(x.status, 'done');
    assert.equal(new Set(x.children.map((c) => c.tag)).size, 3, 'the orders that came due went out, each as its own');
  }
});

test('DCA dip boost and total budget: a dip below the average buys the multiple; the budget is never passed', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 20, orders: 5, intervalMs: MIN, dipPct: 0.02, dipMultiplier: 3, maxTotalUsd: 90, exec: { style: 'taker', slippageBps: 20 } });
  await drive(r, a.id, { ticks: 30, everyMs: 2_000 });
  r.market.set('BTC-USD', 58_000, 58_010);
  const x = (await drive(r, a.id, { ticks: 300, everyMs: 2_000, before: (_i, rr) => rr.market.set('BTC-USD', 58_000, 58_010) }))!;
  assert.ok(FINAL.has(x.status));
  assert.ok((await r.rt.events(a.id, { limit: 500 })).some((e) => /Dip boost: 3x/.test(e.text)), 'boosted');
  assert.ok(x.filledValue <= 90 + 1, `never over the $90 budget ($${x.filledValue.toFixed(2)})`);
});

/* ================================================================== Swarm ===== */

for (const [inFlight, waveMs, sizeJitter, side] of [[1, 0, 0, 'buy'], [3, 5_000, 0.5, 'sell'], [20, 60_000, 0.3, 'buy']] as const) {
  test(`Swarm ${side}, ${inFlight} per wave, ${waveMs / 1000} s apart, clips ±${sizeJitter * 100}%: all IOCs, waves of at most ${inFlight}, the exact size`, async () => {
    const r = await rig();
    const a = await add(r, { kind: 'swarm', side, quantity: '0.006', clips: 6, inFlight, waveMs, sizeJitter, slippageBps: 20 });
    const x = (await drive(r, a.id, { ticks: 400, everyMs: 1_000 }))!;
    assert.equal(x.status, 'done');
    assert.ok(filledOk(x, 0.006));
    assert.ok(r.ex.of(a.id).every((c) => c.tif === 'ioc' && c.side === side));
    const waves = new Map<number, number>();
    for (const c of r.ex.of(a.id)) waves.set(c.at, (waves.get(c.at) ?? 0) + 1);
    assert.ok([...waves.values()].every((n) => n <= inFlight), 'no wave over its size');
  });
}

test('Swarm retries: a clip SoDEX refuses is sent again up to `retries` times, then the swarm stops; 0 retries ends at once', async () => {
  for (const retries of [0, 2, 5]) {
    clock.now = T0;
    const r = await rig();
    r.ex.refuse = 'insufficient margin';
    const a = await add(r, { kind: 'swarm', quantity: '0.002', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20, retries });
    const x = (await drive(r, a.id, { ticks: 60, everyMs: 2_000 }))!;
    assert.ok(x.status !== 'done', `${retries}: not done (${x.status})`);
    assert.ok(r.ex.batches <= retries + 1 + 25, `${retries}: tried a bounded number of times (${r.ex.batches})`);
  }
});

/* ============================================================ Conditional ===== */

interface CondCase {
  what: string;
  cond: Record<string, unknown>;
  /** The market before (not holding) and after (holding). */
  before: (r: Rig) => void;
  after: (r: Rig) => void;
  match?: 'all' | 'any';
}

const setBtc = (bid: number, o: { mark?: number; index?: number; last?: number } = {}) => (r: Rig) => r.market.set('BTC-USD', bid, bid + 10, o);
const CONDS: CondCase[] = [
  ...(['mark', 'last', 'mid', 'index'] as const).flatMap((source) => [
    { what: `price (${source}) above`, cond: { type: 'price', symbol: 'BTC-USD', source, op: 'above', value: 60_500 }, before: setBtc(60_000), after: setBtc(60_600) },
    { what: `price (${source}) below`, cond: { type: 'price', symbol: 'BTC-USD', source, op: 'below', value: 59_500 }, before: setBtc(60_000), after: setBtc(59_400) },
  ]),
  { what: 'cross up (seen below first)', cond: { type: 'cross', symbol: 'BTC-USD', source: 'mark', dir: 'up', value: 60_200 }, before: setBtc(60_000), after: setBtc(60_300) },
  { what: 'cross down (seen above first)', cond: { type: 'cross', symbol: 'BTC-USD', source: 'mark', dir: 'down', value: 59_800 }, before: setBtc(60_000), after: setBtc(59_700) },
  { what: 'move up 1% in 5 min', cond: { type: 'move', symbol: 'BTC-USD', source: 'mark', dir: 'up', pct: 0.01, windowMs: 10_000 }, before: setBtc(60_000), after: setBtc(60_700) },
  { what: 'move down 1% in 5 min', cond: { type: 'move', symbol: 'BTC-USD', source: 'mid', dir: 'down', pct: 0.01, windowMs: 10_000 }, before: setBtc(60_000), after: setBtc(59_300) },
  { what: 'move either way 1%', cond: { type: 'move', symbol: 'BTC-USD', source: 'last', dir: 'either', pct: 0.01, windowMs: 10_000 }, before: setBtc(60_000), after: setBtc(59_300) },
  { what: 'funding above', cond: { type: 'funding', symbol: 'BTC-USD', op: 'above', value: 0.0005 }, before: (r) => { r.market.funding = 0.0001; setBtc(60_000)(r); }, after: (r) => { r.market.funding = 0.001; setBtc(60_000)(r); } },
  { what: 'funding below', cond: { type: 'funding', symbol: 'BTC-USD', op: 'below', value: -0.0005 }, before: (r) => { r.market.funding = 0.0001; setBtc(60_000)(r); }, after: (r) => { r.market.funding = -0.001; setBtc(60_000)(r); } },
  { what: 'open interest up 5%', cond: { type: 'oi', symbol: 'BTC-USD', dir: 'up', pct: 0.05, windowMs: 10_000 }, before: (r) => { r.market.oi.set('BTC-USD', 1000); setBtc(60_000)(r); }, after: (r) => { r.market.oi.set('BTC-USD', 1100); setBtc(60_000)(r); } },
  { what: 'open interest down 5%', cond: { type: 'oi', symbol: 'BTC-USD', dir: 'down', pct: 0.05, windowMs: 10_000 }, before: (r) => { r.market.oi.set('BTC-USD', 1000); setBtc(60_000)(r); }, after: (r) => { r.market.oi.set('BTC-USD', 900); setBtc(60_000)(r); } },
  { what: 'open interest either way', cond: { type: 'oi', symbol: 'BTC-USD', dir: 'either', pct: 0.05, windowMs: 10_000 }, before: (r) => { r.market.oi.set('BTC-USD', 1000); setBtc(60_000)(r); }, after: (r) => { r.market.oi.set('BTC-USD', 1100); setBtc(60_000)(r); } },
  { what: 'spread above', cond: { type: 'spread', symbol: 'BTC-USD', op: 'above', bps: 10 }, before: setBtc(60_000), after: (r) => r.market.set('BTC-USD', 60_000, 60_100) },
  { what: 'spread below', cond: { type: 'spread', symbol: 'BTC-USD', op: 'below', bps: 3 }, before: (r) => r.market.set('BTC-USD', 60_000, 60_100), after: setBtc(60_000) },
  { what: 'volume over $1000 in a minute', cond: { type: 'volume', symbol: 'BTC-USD', windowMs: MIN, aboveUsd: 1_000 }, before: setBtc(60_000), after: (r) => { setBtc(60_000)(r); r.market.print('BTC-USD', 0.01); } },
  { what: 'ratio ETH/BTC above', cond: { type: 'ratio', symbol: 'ETH-USD', other: 'BTC-USD', op: 'above', value: 0.06 }, before: (r) => r.market.set('ETH-USD', 3_000, 3_001), after: (r) => r.market.set('ETH-USD', 3_700, 3_701) },
  { what: 'ratio ETH/BTC below', cond: { type: 'ratio', symbol: 'ETH-USD', other: 'BTC-USD', op: 'below', value: 0.04 }, before: (r) => r.market.set('ETH-USD', 3_000, 3_001), after: (r) => r.market.set('ETH-USD', 2_000, 2_001) },
  { what: 'your position long', cond: { type: 'position', symbol: 'ETH-USD', op: 'long' }, before: (r) => r.ex.positions.set('ETH-USD', 0), after: (r) => r.ex.positions.set('ETH-USD', 0.1) },
  { what: 'your position short', cond: { type: 'position', symbol: 'ETH-USD', op: 'short' }, before: (r) => r.ex.positions.set('ETH-USD', 0), after: (r) => r.ex.positions.set('ETH-USD', -0.1) },
  { what: 'your position flat', cond: { type: 'position', symbol: 'ETH-USD', op: 'flat' }, before: (r) => r.ex.positions.set('ETH-USD', 0.1), after: (r) => r.ex.positions.set('ETH-USD', 0) },
  { what: 'your position size above', cond: { type: 'position', symbol: 'ETH-USD', op: 'sizeAbove', value: 0.5 }, before: (r) => r.ex.positions.set('ETH-USD', -0.1), after: (r) => r.ex.positions.set('ETH-USD', -0.6) },
  { what: 'your position size below', cond: { type: 'position', symbol: 'ETH-USD', op: 'sizeBelow', value: 0.5 }, before: (r) => r.ex.positions.set('ETH-USD', 0.6), after: (r) => r.ex.positions.set('ETH-USD', 0.1) },
  { what: 'time reached', cond: { type: 'time', at: T0 + 2 * MIN }, before: () => undefined, after: () => { clock.now = Math.max(clock.now, T0 + 2 * MIN); } },
];

for (const c of CONDS) {
  test(`Conditional on ${c.what}: it waits while it does not hold, fires once it does, and the market order fills`, async () => {
    const r = await rig();
    c.before(r);
    const a = await add(r, { kind: 'conditional', conditions: [c.cond], holdMs: 0, then: { type: 'market', quantity: '0.002', slippageBps: 30 } });
    // Long enough before for a move or an open-interest change to have a window behind it (10 s).
    let x = (await drive(r, a.id, { ticks: 14, everyMs: 1_000, before: (_i, rr) => c.before(rr) }))!;
    assert.equal(x.status, 'running', `${c.what}: waits (${x.status} ${x.statusReason ?? ''})`);
    assert.equal(r.ex.of(a.id).length, 0);
    x = (await drive(r, a.id, { ticks: 15, everyMs: 1_000, before: (_i, rr) => c.after(rr) }))!;
    assert.equal(x.status, 'done', `${c.what}: fired (${x.status} ${x.statusReason ?? ''})`);
    assert.ok(filledOk(x, 0.002));
  });
}

test('Conditional pnl above / below: the position\'s unrealised PnL at the mark, then a close of it', async () => {
  for (const [op, value, mark] of [['pnlAbove', 5, 60_600], ['pnlBelow', -5, 59_400]] as const) {
    clock.now = T0;
    const r = await rig();
    r.ex.positions.set('BTC-USD', 0.01);
    r.ex.entries.set('BTC-USD', 60_000);
    const a = await add(r, { kind: 'conditional', side: 'sell', conditions: [{ type: 'position', symbol: 'BTC-USD', op, value }], then: { type: 'close', share: 1, slippageBps: 50 } });
    let x = (await drive(r, a.id, { ticks: 6 }))!;
    assert.equal(r.ex.of(a.id).length, 0, `${op}: PnL about 0, it waits`);
    x = (await drive(r, a.id, { ticks: 12, before: (_i, rr) => rr.market.set('BTC-USD', mark - 5, mark + 5) }))!;
    assert.equal(x.status, 'done', `${op}: fired (${x.status} ${x.statusReason ?? ''})`);
    assert.ok(near(r.ex.pos('BTC-USD'), 0), 'closed');
  }
});

test('Conditional match all vs any, hold time and expiry', async () => {
  const conds = [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 60_500 }, { type: 'spread', symbol: 'BTC-USD', op: 'below', bps: 5 }];
  // all: the spread holds, the price does not: it waits.
  let r = await rig();
  let a = await add(r, { kind: 'conditional', match: 'all', conditions: conds, then: { type: 'market', quantity: '0.002', slippageBps: 30 } });
  let x = (await drive(r, a.id, { ticks: 6 }))!;
  assert.equal(x.status, 'running');
  assert.deepEqual(x.k.ok, [false, true], 'each condition\'s state is kept for the view');
  // any: one of them is enough.
  clock.now = T0;
  r = await rig();
  a = await add(r, { kind: 'conditional', match: 'any', conditions: conds, then: { type: 'market', quantity: '0.002', slippageBps: 30 } });
  x = (await drive(r, a.id, { ticks: 6 }))!;
  assert.equal(x.status, 'done');
  // hold: it must hold this long, without a break.
  clock.now = T0;
  r = await rig();
  a = await add(r, { kind: 'conditional', conditions: [conds[1]], holdMs: 10_000, then: { type: 'market', quantity: '0.002', slippageBps: 30 } });
  x = (await drive(r, a.id, { ticks: 5, before: (i, rr) => rr.market.set('BTC-USD', 60_000, i === 3 ? 60_100 : 60_010) }))!;
  x = (await drive(r, a.id, { ticks: 8 }))!;
  assert.equal(x.status, 'running', 'the wide spread at tick 3 restarted the hold');
  x = (await drive(r, a.id, { ticks: 6 }))!;
  assert.equal(x.status, 'done');
  // expiry: its window passes first.
  clock.now = T0;
  r = await rig();
  a = await add(r, { kind: 'conditional', conditions: [conds[0]], expiresAt: T0 + MIN, then: { type: 'market', quantity: '0.002', slippageBps: 30 } });
  x = (await drive(r, a.id, { ticks: 80 }))!;
  assert.equal(x.status, 'expired');
  assert.equal(r.ex.of(a.id).length, 0);
});

test('Conditional actions: a GTC limit and a post-only limit rest and are kept; a close of half; a TWAP and a chase it starts; a market with exits', async () => {
  const fire = [{ type: 'spread', symbol: 'BTC-USD', op: 'below', bps: 5 }];
  // Limit (GTC): placed, the conditional is done, the order kept on SoDEX.
  let r = await rig();
  let a = await add(r, { kind: 'conditional', conditions: fire, then: { type: 'limit', quantity: '0.002', price: 59_900, postOnly: false } });
  let x = (await drive(r, a.id, { ticks: 4 }))!;
  assert.equal(x.status, 'done');
  assert.equal(r.ex.restingOf(a.id)[0]?.tif, 'gtc');
  // Post-only limit through the book: SoDEX refuses it, the conditional fails.
  clock.now = T0;
  r = await rig();
  a = await add(r, { kind: 'conditional', conditions: fire, then: { type: 'limit', quantity: '0.002', price: 60_050, postOnly: true } });
  x = (await drive(r, a.id, { ticks: 4, allowCrossingPostOnly: true }))!;
  // SoDEX takes the order and cancels it at once: the conditional placed it (done), and then says SoDEX took it off.
  assert.ok(['done', 'failed'].includes(x.status), x.status);
  assert.equal(x.filled, 0);
  assert.equal(r.ex.restingOf(a.id).length, 0);
  assert.match(x.statusReason ?? '', /SoDEX then cancelled it.*nothing rests|refused/);
  assert.ok((await r.rt.events(a.id)).some((e) => /no longer rests/.test(e.text)), 'its activity says it no longer rests');
  // Close half of a short: a reduce-only buy of half.
  clock.now = T0;
  r = await rig();
  r.ex.positions.set('BTC-USD', -0.004);
  a = await add(r, { kind: 'conditional', side: 'sell', conditions: fire, then: { type: 'close', share: 0.5, slippageBps: 30 } });
  x = (await drive(r, a.id, { ticks: 6 }))!;
  assert.equal(x.status, 'done');
  assert.ok(r.ex.of(a.id).every((c) => c.reduceOnly && c.side === 'buy'));
  assert.ok(near(r.ex.pos('BTC-USD'), -0.002));
  // Starts a TWAP and a chase: each with this conditional as its parent, as paper when the conditional is paper.
  for (const inner of [{ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.002', durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 20 } }, { kind: 'chase', symbol: 'ETH-USD', side: 'sell', quantity: '0.01', exits: { slPct: 0.02 } }]) {
    for (const paper of [false, true]) {
      clock.now = T0;
      r = await rig();
      a = await add(r, { kind: 'conditional', paper, conditions: fire, then: { type: 'algo', algo: inner } });
      x = (await drive(r, a.id, { ticks: 4, until: (rr) => rr.rt.list().some((y) => y.parentId === a.id) }))!;
      const child = r.rt.list().find((y) => y.parentId === a.id);
      assert.ok(child, `started a ${inner.kind}`);
      assert.equal(child!.spec.kind, inner.kind);
      assert.equal(child!.spec.paper, paper, 'paper as its parent');
      await drive(r, a.id, { ticks: 2 });
      assert.equal(r.rt.get(a.id)!.status, 'done');
    }
  }
  // Market with exits: the conditional carries them.
  clock.now = T0;
  r = await rig();
  a = await add(r, { kind: 'conditional', conditions: fire, then: { type: 'market', quantity: '0.002', slippageBps: 30 }, exits: { tpPct: 0.01, slPct: 0.01 } });
  x = (await drive(r, a.id, { ticks: 15 }))!;
  assert.equal(x.status, 'done');
  assert.equal(r.ex.stopsOf(prefixOf(a)).length, 2, 'a take-profit and a stop-loss rest on SoDEX');
});

/* ================================================================ Trailing ===== */

for (const [mode, side, source, exit] of [['pct', 'sell', 'mark', 'market'], ['abs', 'sell', 'last', 'chase'], ['pct', 'buy', 'last', 'market'], ['abs', 'buy', 'mark', 'chase']] as const) {
  test(`Trailing stop ${side}, ${mode === 'pct' ? '1%' : '$300'} trail on the ${source}, exit ${exit}: trails the ${side === 'sell' ? 'high' : 'low'}, fires on the turn, closes reduce-only`, async () => {
    const r = await rig();
    r.ex.positions.set('BTC-USD', side === 'sell' ? 0.003 : -0.003);
    const a = await add(r, { kind: 'trailing', side, trailPct: mode === 'pct' ? 0.01 : null, trailAbs: mode === 'abs' ? 300 : null, source, exit, chaseMs: 5_000, slippageBps: 50 });
    const at = (p: number) => (_i: number, rr: Rig) => rr.market.set('BTC-USD', p - 5, p + 5, { mark: p, last: p });
    const dir = side === 'sell' ? 1 : -1;
    // The price runs 1000 the trader's way, then turns 1000 back.
    for (let i = 1; i <= 10; i++) await drive(r, a.id, { ticks: 1, before: at(60_000 + dir * 100 * i) });
    const peak = r.rt.view(a.id)!.triggerPrice!;
    const want = mode === 'pct' ? (60_000 + dir * 1000) * (1 - dir * 0.01) : 60_000 + dir * 1000 - dir * 300;
    assert.ok(near(peak, want, 1), `the stop trails at ${want} (${peak})`);
    assert.equal(r.ex.of(a.id).length, 0, 'nothing before the turn');
    const x = (await drive(r, a.id, { ticks: 40, before: at(60_000 - dir * 500) }))!;
    assert.equal(x.status, 'done', x.statusReason ?? '');
    assert.ok(near(r.ex.pos('BTC-USD'), 0), 'the whole position closed');
    assert.ok(r.ex.of(a.id).every((c) => c.reduceOnly && c.side === side));
    if (exit === 'chase') assert.ok(r.ex.of(a.id).some((c) => c.tif === 'gtx'), 'it rested first');
  });
}

test('Trailing stop: activation price, a fixed amount, and no position (expires)', async () => {
  const r = await rig();
  r.ex.positions.set('BTC-USD', 0.01);
  const a = await add(r, { kind: 'trailing', side: 'sell', quantity: '0.004', reduceOnly: true, trailPct: 0.005, activationPrice: 61_000 });
  // It falls without having reached the activation: nothing.
  let x = (await drive(r, a.id, { ticks: 5, before: (_i, rr) => rr.market.set('BTC-USD', 59_000, 59_010) }))!;
  assert.equal(r.ex.of(a.id).length, 0, 'not armed: no fire');
  for (const p of [61_000, 61_500, 61_000]) x = (await drive(r, a.id, { ticks: 3, before: (_i, rr) => rr.market.set('BTC-USD', p, p + 10) }))!;
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.004), 'the amount, not the position');
  assert.ok(near(r.ex.pos('BTC-USD'), 0.006));
  const b = await add(r, { kind: 'trailing', side: 'buy', trailPct: 0.001 });
  const y = (await drive(r, b.id, { ticks: 10, before: (i, rr) => rr.market.set('BTC-USD', 61_000 - (i < 5 ? 100 * i : 0), 61_010 - (i < 5 ? 100 * i : 0)) }))!;
  assert.equal(y.status, 'expired', 'a buy stop of the whole position with no short: nothing to close');
});

/* ================================================================== Basket ===== */

for (const [style, sides] of [['swarm', ['buy', 'sell']], ['twap', ['sell', 'sell']], ['swarm', ['buy', 'buy']], ['twap', ['buy', 'sell']]] as const) {
  test(`Basket of ${style} legs (${sides.join(' / ')}): one algo per market at its USD, done when every leg is`, async () => {
    const r = await rig();
    const a = await add(r, { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: sides[0], usd: 60 }, { symbol: 'ETH-USD', side: sides[1], usd: 60 }], style, durationMs: MIN, slices: 2, clips: 2, inFlight: 2, waveMs: 1_000, slippageBps: 30 });
    const x = (await drive(r, a.id, { ticks: 200 }))!;
    assert.equal(x.status, 'done', x.statusReason ?? '');
    const legs = r.rt.list().filter((y) => y.parentId === a.id);
    assert.deepEqual(legs.map((l) => [l.spec.kind, l.spec.symbol, l.spec.side]).sort(), [[style, 'BTC-USD', sides[0]], [style, 'ETH-USD', sides[1]]].sort());
    for (const l of legs) assert.ok(near(l.filledValue, 60, 6), `${l.spec.symbol}: about $60 ($${l.filledValue.toFixed(2)})`);
    assert.ok(Math.sign(r.ex.pos('BTC-USD')) === (sides[0] === 'buy' ? 1 : -1) && Math.sign(r.ex.pos('ETH-USD')) === (sides[1] === 'buy' ? 1 : -1));
  });
}

/* ================================================================= Bracket ===== */

for (const [entry, side, exits] of [['market', 'buy', { tpPct: 0.01, slPct: 0.01 }], ['market', 'sell', { tpPrice: 59_000, slPrice: 61_000 }], ['limit', 'buy', { tpPrice: 61_000, slPct: 0.01 }], ['limit', 'sell', { tpPct: 0.02 }]] as const) {
  test(`Bracket ${entry} ${side} with ${Object.keys(exits).join(' + ')}: the exits rest after the entry fills; when one fills the other is cancelled`, async () => {
    const r = await rig();
    const a = await add(r, { kind: 'bracket', side, quantity: '0.002', entry, price: entry === 'limit' ? (side === 'buy' ? 59_990 : 60_020) : null, slippageBps: 30, exits });
    await drive(r, a.id, { ticks: 3 });
    if (entry === 'limit') {
      assert.equal(r.ex.restingOf(a.id).length, 1);
      assert.equal(r.ex.stopsOf(prefixOf(r.rt.get(a.id)!)).length, 0, 'no exit before anything fills');
      for (const c of r.ex.restingOf(a.id)) r.ex.fill(c.clOrdID, Number(c.quantity));
    }
    await drive(r, a.id, { ticks: 10 });
    const x = r.rt.get(a.id)!;
    assert.equal(x.status, 'done');
    const stops = r.ex.stopsOf(prefixOf(x));
    assert.equal(stops.length, Object.keys(exits).length, 'one SoDEX stop per exit');
    const avg = x.filledValue / x.filled;
    for (const s of stops) {
      assert.equal(s.side, side === 'buy' ? 'sell' : 'buy');
      assert.ok(near(Number(s.quantity), 0.002));
      const e = exits as Record<string, number>;
      const want = s.kind === 'tp' ? (e.tpPrice ?? avg * (1 + (side === 'buy' ? 1 : -1) * e.tpPct!)) : (e.slPrice ?? avg * (1 - (side === 'buy' ? 1 : -1) * e.slPct!));
      assert.ok(near(Number(s.triggerPrice), want, 2), `${s.kind} at ${want} (${s.triggerPrice})`);
    }
    // The take-profit fills: the stop-loss goes (OCO).
    const tp = stops.find((s) => s.kind === 'tp')!;
    const p = Number(tp.triggerPrice);
    await drive(r, a.id, { ticks: 15, before: (_i, rr) => rr.market.set('BTC-USD', p - 5, p + 5, { mark: p }) });
    assert.ok(near(r.ex.pos('BTC-USD'), 0), 'the take-profit closed it');
    assert.equal(r.ex.stopsOf(prefixOf(x)).length, 0, 'and the other exit is gone');
  });
}

/* =============================================================== Fill fast ===== */

for (const [reference, side, venues] of [['oracleMid', 'buy', ['binanceFutures']], ['oracleFair', 'sell', null], ['mark', 'buy', null], ['index', 'sell', null]] as const) {
  test(`Fill fast from ${reference} (${side}${venues ? `, venues ${venues.join(', ')}` : ''}): IOC rounds at the band, filled`, async () => {
    const r = await rig();
    r.market.set('BTC-USD', 60_000, 60_010, { mark: 60_004, index: 60_006 });
    r.oracleAt = 60_005;
    const a = await add(r, { kind: 'sweep', side, quantity: '0.003', reference, ...(venues ? { venues } : {}), slippageBps: 10, roundMs: 500, timeoutMs: 30_000 });
    const x = (await drive(r, a.id, { ticks: 30, everyMs: 500, before: (_i, rr) => rr.market.set('BTC-USD', 60_000, 60_010, { mark: 60_004, index: 60_006 }) }))!;
    assert.equal(x.status, 'done', x.statusReason ?? '');
    assert.ok(filledOk(x, 0.003));
    const ref = { oracleMid: 60_005, oracleFair: 60_007, mark: 60_004, index: 60_006 }[reference];
    for (const c of r.ex.of(a.id)) {
      assert.equal(c.tif, 'ioc');
      assert.ok(side === 'buy' ? Number(c.price) <= ref * 1.001 + 1e-9 : Number(c.price) >= ref * 0.999 - 1e-9, `${c.price} inside 10 bp of ${ref}`);
    }
  });
}

test('Fill fast: the book outside the band waits, then it gives up at its time limit; no oracle falls back to SoDEX\'s mark', async () => {
  const r = await rig();
  r.oracleAt = 59_000;
  const a = await add(r, { kind: 'sweep', quantity: '0.002', slippageBps: 10, timeoutMs: 10_000 });
  const x = (await drive(r, a.id, { ticks: 30, everyMs: 500 }))!;
  assert.equal(x.status, 'expired');
  assert.equal(x.filled, 0);
  r.oracleAt = null;
  const b = await add(r, { kind: 'sweep', quantity: '0.002', slippageBps: 10, timeoutMs: 10_000 });
  const y = (await drive(r, b.id, { ticks: 30, everyMs: 500 }))!;
  assert.equal(y.status, 'done', 'priced from the mark with no fresh oracle');
  assert.ok(y.children.some((c) => /SoDEX mark/.test(c.tag)));
});

/* ================================================== exits on every kind that opens ===== */

for (const kind of ['twap', 'vwap', 'pov', 'iceberg', 'chase', 'scale', 'dca', 'swarm', 'sweep'] as const) {
  for (const side of ['buy', 'sell'] as const) {
    test(`exits: a ${kind} ${side} keeps a take-profit and a stop-loss on SoDEX sized to what it filled`, async () => {
      const r = await rig();
      const spec: Record<string, unknown> = {
        twap: { kind, quantity: '0.002', durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 20 } },
        vwap: { kind, quantity: '0.002', durationMs: 15 * MIN, slices: 2, lookbackDays: 1, exec: { style: 'taker', slippageBps: 20 } },
        pov: { kind, quantity: '0.002', rate: 0.5, exec: { style: 'taker', slippageBps: 20 } },
        iceberg: { kind, quantity: '0.002', displayQty: '0.001' },
        chase: { kind, quantity: '0.002' },
        scale: { kind, quantity: '0.002', from: side === 'buy' ? 60_020 : 59_990, to: side === 'buy' ? 60_030 : 59_980, orders: 2 },
        dca: { kind, perOrderUsd: 60, orders: 2, intervalMs: MIN, exec: { style: 'taker', slippageBps: 20 } },
        swarm: { kind, quantity: '0.002', clips: 2, inFlight: 1, waveMs: 1_000, slippageBps: 20 },
        sweep: { kind, quantity: '0.002', reference: 'mark', slippageBps: 20 },
      }[kind] as Record<string, unknown>;
      const a = await add(r, { ...spec, side, exits: { tpPct: 0.05, slPrice: side === 'buy' ? 50_000 : 70_000 } });
      const x = (await drive(r, a.id, { ticks: 400, everyMs: kind === 'vwap' ? 10_000 : 2_000, trade: true, printQty: 0.01, until: (rr) => FINAL.has(rr.rt.get(a.id)!.status) && rr.ex.stopsOf(prefixOf(a)).every((s) => near(Number(s.quantity), Math.abs(rr.ex.pos('BTC-USD')))) && rr.ex.stopsOf(prefixOf(a)).length === 2 }))!;
      assert.ok(x.filled > 0, `${kind}: filled ${x.filled} (${x.status})`);
      const stops = r.ex.stopsOf(prefixOf(x));
      assert.deepEqual(stops.map((s) => s.kind).sort(), ['sl', 'tp']);
      for (const s of stops) {
        assert.equal(s.side, side === 'buy' ? 'sell' : 'buy', 'the side that closes');
        assert.ok(near(Number(s.quantity), x.filled, 1e-9), `${s.kind} sized to the fill (${s.quantity} vs ${x.filled})`);
      }
      // A plain cancel of the ended algo... a kill switch pulls them.
      await r.rt.cancelAll(x.owner);
      await settle();
      assert.equal(r.ex.stopsOf(prefixOf(x)).length, 0, 'cancel all pulls the exits');
    });
  }
}

/* ============================================ lifecycle: every kind, every action ===== */

/** A spec per kind that works a while (resting or on a schedule), so a pause, a change or a cancel lands mid-way. */
const WORKING: Record<AlgoKind, Record<string, unknown>> = {
  twap: { kind: 'twap', quantity: '0.004', durationMs: 4 * MIN, slices: 4, exec: { style: 'hybrid', slippageBps: 20, makerShare: 0.5 } },
  vwap: { kind: 'vwap', quantity: '0.004', durationMs: 20 * MIN, slices: 4, lookbackDays: 2, exec: { style: 'hybrid', slippageBps: 20, makerShare: 0.5 } },
  pov: { kind: 'pov', quantity: '0.004', rate: 0.1, exec: { style: 'maker' } },
  iceberg: { kind: 'iceberg', quantity: '0.004', displayQty: '0.001' },
  chase: { kind: 'chase', quantity: '0.004' },
  scale: { kind: 'scale', quantity: '0.004', from: 59_900, to: 59_600, orders: 4, postOnly: true },
  dca: { kind: 'dca', perOrderUsd: 30, orders: 4, intervalMs: MIN, exec: { style: 'maker' } },
  swarm: { kind: 'swarm', quantity: '0.004', clips: 4, inFlight: 1, waveMs: 30_000, slippageBps: 20 },
  conditional: { kind: 'conditional', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 70_000 }], then: { type: 'market', quantity: '0.002', slippageBps: 20 } },
  trailing: { kind: 'trailing', side: 'sell', trailPct: 0.05 },
  basket: { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 60 }, { symbol: 'ETH-USD', side: 'buy', usd: 60 }], style: 'twap', durationMs: 4 * MIN, slices: 4, slippageBps: 20 },
  bracket: { kind: 'bracket', quantity: '0.002', entry: 'limit', price: 59_900, exits: { tpPct: 0.02, slPct: 0.02 } },
  // Under a limit far below the book: nothing fills while it works.
  sweep: { kind: 'sweep', quantity: '0.004', slippageBps: 10, roundMs: 500, reference: 'mark', limitPrice: 59_000 },
  // Bots: they quote until stopped; 'keep' so a cancel ends one at once, as every other kind's does.
  mm: { kind: 'mm', orderUsd: 30, maxInventoryUsd: 120, onStop: 'keep' },
  grid: { kind: 'grid', low: 59_000, high: 61_000, levels: 6, orderUsd: 30, onStop: 'keep' },
};

const family = (r: Rig, id: string) => [id, ...r.rt.list().filter((x) => x.parentId === id).map((x) => x.id)];
const sentBy = (r: Rig, id: string) => r.ex.sent.filter((c) => family(r, id).includes(c.algoId)).length;
const restingBy = (r: Rig, id: string) => family(r, id).reduce((n, x) => n + r.ex.restingOf(x).length, 0);

for (const kind of ALGO_KINDS) {
  test(`lifecycle ${kind}: pause sends nothing and pulls what rests; resume goes on; cancel leaves nothing resting and stays cancelled`, async () => {
    const r = await rig();
    r.ex.positions.set('BTC-USD', 0.01);
    const a = await add(r, WORKING[kind]);
    await drive(r, a.id, { ticks: 4, printQty: 0.002, until: () => false });
    await r.rt.pause(a.id);
    await settle();
    const before = sentBy(r, a.id);
    await drive(r, a.id, { ticks: 30, everyMs: 2_000, printQty: 0.002, until: () => false });
    for (const id of family(r, a.id)) assert.ok(['paused', ...FINAL].includes(r.rt.get(id)!.status), `${kind} ${id}: paused (${r.rt.get(id)!.status})`);
    assert.equal(sentBy(r, a.id), before, `${kind}: nothing sent while paused`);
    assert.equal(restingBy(r, a.id), 0, `${kind}: nothing resting while paused`);
    await r.rt.resume(a.id);
    await drive(r, a.id, { ticks: 6, printQty: 0.002, until: () => false });
    assert.ok(!['paused'].includes(r.rt.get(a.id)!.status), `${kind}: resumed (${r.rt.get(a.id)!.status})`);
    await r.rt.cancel(a.id);
    await drive(r, a.id, { ticks: 4, until: () => false });
    const x = r.rt.get(a.id)!;
    assert.ok(['cancelled', 'done'].includes(x.status), `${kind}: cancelled (${x.status})`);
    assert.equal(restingBy(r, a.id), 0, `${kind}: nothing resting after the cancel`);
    const after = sentBy(r, a.id);
    await drive(r, a.id, { ticks: 20, everyMs: 5_000, printQty: 0.002, until: () => false });
    assert.equal(sentBy(r, a.id), after, `${kind}: nothing sent after the cancel`);
    // Ended: nothing more can be changed, paused or resumed.
    if (x.status === 'cancelled') await assert.rejects(r.rt.update(a.id, { label: 'x' }), /ended/);
  });

  test(`lifecycle ${kind}: the label, limit price, bounds and spread guard can be changed while it runs; what it is cannot`, async () => {
    // A bot has no limit price and its own fields to change (algo-bots.test.ts).
    if (BOT_KINDS.includes(kind)) return;
    const r = await rig();
    r.ex.positions.set('BTC-USD', 0.01);
    const a = await add(r, WORKING[kind]);
    await drive(r, a.id, { ticks: 2, until: () => false });
    const okLimit = kind !== 'scale' && kind !== 'trailing' && kind !== 'basket' && kind !== 'sweep';
    const patch: Record<string, unknown> = { label: 'renamed', maxSpreadBps: 50, lower: kind === 'scale' ? null : { price: 1_000, then: 'stop' }, upper: kind === 'scale' ? null : { price: 1e6, then: 'hold' } };
    if (okLimit) patch.limitPrice = 100_000;
    const x = await r.rt.update(a.id, patch);
    assert.equal(x.spec.label, 'renamed');
    assert.equal(x.spec.maxSpreadBps, 50);
    if (okLimit) assert.equal(x.spec.limitPrice, 100_000);
    for (const bad of [{ side: 'sell' }, { kind: 'twap' }, { paper: true }, { symbol: 'ETH-USD' }, { reduceOnly: true }, { leverage: 9 }]) {
      await assert.rejects(r.rt.update(a.id, bad as never), /Only the limit price, bounds, spread guard, label and size/, `${kind}: ${Object.keys(bad)[0]} cannot change`);
    }
    await assert.rejects(r.rt.update(a.id, { upper: { price: 10, then: 'hold' }, lower: { price: 20, then: 'hold' } }), /upper bound must be above/, 'a change is checked as a start is');
  });

  test(`lifecycle ${kind}: a crash mid-way and a new runner on the same books - no client order id twice, never over the size`, async () => {
    const r = await rig();
    r.ex.positions.set('BTC-USD', 0.01);
    const a = await add(r, WORKING[kind]);
    await drive(r, a.id, { ticks: 6, printQty: 0.002, trade: true, until: () => false });
    await crashAndRestart(r);
    await drive(r, a.id, { ticks: 60, everyMs: 6_000, printQty: 0.002, trade: true, until: () => false });
    const ids = r.ex.sent.map((c) => c.clOrdID);
    assert.equal(new Set(ids).size, ids.length, `${kind}: every client order id once`);
    for (const id of family(r, a.id)) {
      const x = r.rt.get(id)!;
      const v = r.rt.view(id)!;
      if (v.target !== null) assert.ok(x.filled <= v.target + 1e-9, `${kind} ${id}: ${x.filled} of ${v.target}`);
    }
  });
}

const SIZED: AlgoKind[] = ['twap', 'vwap', 'pov', 'iceberg', 'chase', 'scale', 'swarm', 'bracket', 'sweep'];
for (const kind of SIZED) {
  test(`size change ${kind}: raised it works the new size; lowered under what may fill, what rests past it is pulled; never to or under what filled`, async () => {
    const r = await rig();
    const a = await add(r, WORKING[kind]);
    await drive(r, a.id, { ticks: 3, printQty: 0.002, until: () => false });
    const x = await r.rt.update(a.id, { quantity: '0.006' });
    assert.equal(r.rt.view(a.id)!.target, 0.006);
    assert.equal((x.spec as { quantity: string }).quantity, '0.006');
    // SoDEX confirms what the raise pulled (a ladder, an entry) before the next change: one in flight counts as filling.
    await drive(r, a.id, { ticks: 1, until: () => false });
    const low = kind === 'bracket' ? '0.001' : '0.002';
    await r.rt.update(a.id, { quantity: low });
    await drive(r, a.id, { ticks: 3, until: () => false });
    const resting = sum(r.ex.restingOf(a.id).map((c) => Number(c.quantity) - c.filled));
    assert.ok(r.rt.get(a.id)!.filled + resting <= Number(low) + 1e-9, `${kind}: no more working than the new size (${r.rt.get(a.id)!.filled} + ${resting})`);
    await assert.rejects(r.rt.update(a.id, { quantity: '0' }), /more than what has filled|positive amount|must be/);
  });
}

for (const kind of SIZED) {
  for (const to of ['0.006', '0.003']) {
    test(`size change ${kind}, ${to === '0.006' ? 'raised' : 'lowered'} while it works (to ${to}): it ends filled at exactly the new size`, async () => {
      const r = await rig();
      // Resting levels and entries as GTC (the book comes down to them below), a sweep under a limit until it is lifted.
      const spec = kind === 'scale' ? { ...WORKING.scale, postOnly: false } : kind === 'bracket' ? { ...WORKING.bracket, quantity: '0.004' } : WORKING[kind];
      const a = await add(r, spec);
      await drive(r, a.id, { ticks: 3, until: () => false });
      await r.rt.update(a.id, { quantity: to });
      if (kind === 'sweep') await r.rt.update(a.id, { limitPrice: 70_000 });
      const down = kind === 'scale' || kind === 'bracket';
      const x = (await drive(r, a.id, { ticks: 400, everyMs: kind === 'vwap' ? 10_000 : 3_000, trade: true, printQty: 0.01, allowCrossingPostOnly: down, before: (_i, rr) => { if (down) rr.market.set('BTC-USD', 59_500, 59_510); } }))!;
      // BUG (fixed): a ladder raised was never worked (its levels kept their old sizes: it ended expired short), and a
      // bracket's limit entry raised or lowered ended the bracket ("the entry order is no longer on SoDEX").
      assert.equal(x.status, 'done', `${kind}: ${x.statusReason ?? ''}`);
      assert.ok(filledOk(x, Number(to)), `${kind}: filled ${x.filled} = ${to}`);
    });
  }
}

for (const kind of ['dca', 'trailing', 'basket', 'conditional'] as const) {
  test(`size change ${kind}: refused (it is sized in USD, by the position, or by what it fires)`, async () => {
    const r = await rig();
    r.ex.positions.set('BTC-USD', 0.01);
    const a = await add(r, WORKING[kind]);
    await drive(r, a.id, { ticks: 2, until: () => false });
    await assert.rejects(r.rt.update(a.id, { quantity: '0.01' }));
  });
}

test('size change: a time-sliced close is sized from the position and cannot be changed', async () => {
  const r = await rig();
  r.ex.positions.set('BTC-USD', 0.01);
  const a = await add(r, { kind: 'twap', side: 'sell', closeShare: 1, durationMs: 4 * MIN, slices: 4, exec: { style: 'taker', slippageBps: 20 } });
  await drive(r, a.id, { ticks: 2, until: () => false });
  await assert.rejects(r.rt.update(a.id, { quantity: '0.02' }), /sized from the position/);
});

test('cancel all (the kill switch): every running algo of the wallet ended, every child and every exit pulled, other wallets untouched', async () => {
  const r = await rig();
  r.ex.positions.set('BTC-USD', 0.01);
  const ids: string[] = [];
  for (const k of ALGO_KINDS) ids.push((await add(r, WORKING[k])).id);
  const filler = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', exits: { tpPct: 0.02, slPct: 0.02 } });
  const other = await r.rt.add({ owner: '0x3333333333333333333333333333333333333333', accountId: 7, mode: 'hosted', spec: { symbol: 'BTC-USD', side: 'buy', ...WORKING.scale }, seed: 1 });
  await drive(r, null, { ticks: 8, printQty: 0.002, until: () => false });
  assert.ok(r.ex.stopsOf(prefixOf(r.rt.get(filler.id)!)).length === 2, 'the bracket\'s exits rest');
  await r.rt.cancelAll(r.rt.get(filler.id)!.owner);
  await drive(r, null, { ticks: 4, until: () => false });
  for (const id of [...ids, filler.id]) {
    for (const f of family(r, id)) {
      const x = r.rt.get(f)!;
      assert.ok(FINAL.has(x.status), `${x.spec.kind}: ended (${x.status})`);
      assert.equal(r.ex.restingOf(f).length, 0, `${x.spec.kind}: nothing resting`);
      assert.equal(r.ex.stopsOf(prefixOf(x)).length, 0, `${x.spec.kind}: no exit left`);
    }
  }
  assert.equal(r.rt.get(other.id)!.status !== 'cancelled', true, 'another wallet\'s algo runs on');
  assert.equal(r.ex.restingOf(other.id).length, 4);
});

/* ============================================================== start refusals ===== */

const TOO_SMALL: Array<[AlgoKind, Record<string, unknown>]> = [
  ['twap', { kind: 'twap', quantity: '0.0001', durationMs: MIN, slices: 1 }],
  ['twap', { kind: 'twap', quantity: '0.0003', durationMs: MIN, slices: 2 }],
  ['vwap', { kind: 'vwap', quantity: '0.0003', durationMs: 15 * MIN, slices: 2, lookbackDays: 1 }],
  ['pov', { kind: 'pov', quantity: '0.0001', rate: 0.1 }],
  ['iceberg', { kind: 'iceberg', quantity: '0.0001', displayQty: '0.0001' }],
  ['iceberg', { kind: 'iceberg', quantity: '0.002', displayQty: '0.0001' }],
  ['chase', { kind: 'chase', quantity: '0.0001' }],
  ['scale', { kind: 'scale', quantity: '0.0005', from: 59_900, to: 59_500, orders: 5 }],
  ['swarm', { kind: 'swarm', quantity: '0.0005', clips: 5, inFlight: 1, waveMs: 0, slippageBps: 20 }],
  ['conditional', { kind: 'conditional', conditions: [{ type: 'spread', symbol: 'BTC-USD', op: 'below', bps: 5 }], then: { type: 'market', quantity: '0.0001', slippageBps: 20 } }],
  ['trailing', { kind: 'trailing', side: 'sell', quantity: '0.0001', trailPct: 0.01 }],
  ['basket', { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 30 }, { symbol: 'ETH-USD', side: 'buy', usd: 30 }], style: 'swarm', clips: 5, inFlight: 1, waveMs: 0, slippageBps: 20 }],
  ['bracket', { kind: 'bracket', quantity: '0.0001', entry: 'market', exits: { tpPct: 0.02 } }],
  ['sweep', { kind: 'sweep', quantity: '0.0001', slippageBps: 10 }],
];

for (const [kind, spec] of TOO_SMALL) {
  test(`start refused: a ${kind} with a child under SoDEX's $10 minimum (${JSON.stringify(spec).slice(0, 80)}...) - nothing placed`, async () => {
    const r = await rig();
    await assert.rejects(add(r, spec), /under SoDEX|minimum/);
    assert.equal(r.rt.list().length, 0);
  });
}

test('start refused: a DCA ladder level, a dca order, a ladder level past SoDEX\'s 5% band, a market not listed or not trading', async () => {
  const r = await rig();
  // SoDEX refuses a buy more than 5% over the mark and a sell more than 5% under it (a buy far under is fine).
  await assert.rejects(add(r, { kind: 'scale', quantity: '0.004', from: 63_500, to: 64_000, orders: 4 }), /priced too far.*5% over the mark/);
  await assert.rejects(add(r, { kind: 'bracket', quantity: '0.002', entry: 'limit', price: 64_000, exits: { slPct: 0.02 } }), /priced too far/);
  await assert.rejects(add(r, { kind: 'iceberg', side: 'sell', quantity: '0.002', displayQty: '0.001', price: 56_000 }), /priced too far.*5% under the mark/);
  await add(r, { kind: 'scale', quantity: '0.004', from: 59_900, to: 50_000, orders: 4 });
  await assert.rejects(add(r, { kind: 'twap', symbol: 'DOGE-USD', quantity: '100', durationMs: MIN, slices: 1 }), /not listed|DOGE/);
  const halted = await rig({ markets: [{ ...ETH, name: 'BTC-USD', base: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', status: 'HALT' } as never, ETH] });
  await assert.rejects(add(halted, { kind: 'twap', quantity: '0.002', durationMs: MIN, slices: 1 }), /not trading/);
});

test('step and tick: a size off SoDEX\'s step is worked on the step (nothing off it is ever sent), a price off the tick is snapped', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.0040037', durationMs: MIN, slices: 3, exec: { style: 'taker', slippageBps: 17 } });
  const x = (await drive(r, a.id, { ticks: 120 }))!;
  assert.ok(FINAL.has(x.status));
  assert.ok(x.filled <= 0.0040037 + 1e-12 && x.filled >= 0.004 - 1e-12, `filled ${x.filled} on the step`);
  const b = await add(r, { kind: 'iceberg', quantity: '0.002', displayQty: '0.001', price: 59_990.4, postOnly: true });
  await drive(r, b.id, { ticks: 2, until: () => false });
  // checkInvariants (every tick) proved each price on the tick; the fixed price was snapped to it.
  assert.ok(r.ex.of(b.id).every((c) => Number.isInteger(Number(c.price))));
});

test('reduce-only bigger than the position: it fills only up to the position, never flips it, and ends', async () => {
  for (const kind of ['swarm', 'twap', 'sweep', 'chase'] as const) {
    clock.now = T0;
    const r = await rig();
    r.ex.positions.set('BTC-USD', 0.002);
    const spec = { swarm: { kind, quantity: '0.006', clips: 3, inFlight: 1, waveMs: 1_000, slippageBps: 20, retries: 0 }, twap: { kind, quantity: '0.006', durationMs: MIN, slices: 3, exec: { style: 'taker', slippageBps: 20 } }, sweep: { kind, quantity: '0.006', reference: 'mark', slippageBps: 20, timeoutMs: 20_000 }, chase: { kind, quantity: '0.006', timeoutMs: 20_000, onEnd: 'take' } }[kind];
    const a = await add(r, { ...spec, side: 'sell', reduceOnly: true });
    const x = (await drive(r, a.id, { ticks: 120, trade: true }))!;
    assert.ok(r.ex.pos('BTC-USD') >= -1e-12, `${kind}: never short (${r.ex.pos('BTC-USD')})`);
    assert.ok(near(r.ex.pos('BTC-USD'), 0), `${kind}: flat`);
    assert.ok(x.filled <= 0.002 + 1e-12, `${kind}: filled no more than the position (${x.filled})`);
    assert.ok(FINAL.has(x.status) || x.status === 'running' || x.status === 'waiting', `${kind}: ${x.status}`);
  }
});

test('paper, every kind: nothing reaches SoDEX (the invariant), and it still works on the live book', async () => {
  const r = await rig();
  r.ex.positions.set('BTC-USD', 0.01);
  for (const kind of ALGO_KINDS) {
    const spec = kind === 'conditional' ? { ...WORKING.conditional, conditions: [{ type: 'spread', symbol: 'BTC-USD', op: 'below', bps: 5 }] } : kind === 'trailing' ? { ...WORKING.trailing, quantity: '0.002', reduceOnly: false } : WORKING[kind];
    await add(r, { ...spec, paper: true });
  }
  await drive(r, null, { ticks: 60, everyMs: 5_000, printQty: 0.01, until: () => false });
  assert.equal(r.ex.sent.length, 0);
  assert.equal(r.ex.stopsSent.length, 0);
  assert.ok(r.rt.list().some((x) => x.filled > 0), 'paper fills were simulated');
});
