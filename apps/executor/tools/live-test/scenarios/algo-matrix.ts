/**
 * The algo option matrix on a real exchange: every value of every option of
 * every kind that scenarios/algos.ts does not already run live, at least once,
 * and the options that act on each other in pairs (docs/COVERAGE-ALGOS.md has
 * the inventory, and where each value runs: here, in algos.ts, or only in the
 * deterministic tests of packages/copy-engine/test/matrix-*.test.ts).
 *
 * What only SoDEX can show is what is checked: that its book takes each kind
 * of child the options make (IOC, GTX, GTC; prices off the mid, the mark, the
 * index and the oracle; reduce-only), that a ladder's curve and spacing rest at
 * the planned prices, that a bound, a start time and a size change act on real
 * orders, that SoDEX's stops follow a short's exits, that a practice run next
 * to a live one sends nothing, that the leverage and margin mode it sets are
 * SoDEX's.
 *
 * Sizes are in U (SoDEX's minimum order value plus 20%, about $12): every child
 * is about U, no scenario holds more than about 4U at once, each ends with the
 * runner's cleanup (flat, nothing resting). Every id starts with `mx.`, so
 * `--only mx.*` runs exactly these; each also matches its kind (`--only twap`).
 */
import type { AlgoView } from '../../../../../packages/copy-engine/src/index.ts';
import { Inconclusive, algoPrefix, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/algo-matrix.ts';
const MIN = 60_000;

const done = (v: AlgoView) => v.algo.status === 'done';
const ended = (v: AlgoView) => ['done', 'cancelled', 'expired', 'failed'].includes(v.algo.status);
const stepOf = (t: T) => Number(t.main.stepSize);
const tickOf = (t: T) => Number(t.main.tickSize);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-12;
const sign = (side: string) => (side === 'sell' ? -1 : 1);

function mx(id: string, kind: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run' | 'timeoutMs'>): Scenario {
  return { id: `mx.${id}`, section: 'algo', kind, title, confirms, deps: ['algo'], source: SOURCE, dry: 'full', ...o };
}

/** SoDEX's own fills of the algo add up to what the executor booked (read again while SoDEX's history lags). */
async function filledAsBooked(t: T, v: AlgoView, symbol = t.main.name): Promise<void> {
  const total = async () => (await t.algoFills(v.algo.id, symbol)).reduce((x, f) => x + f.qty, 0);
  const sum = await t
    .waitFor(`${t.where}'s fills catch up with what the executor booked`, async () => {
      const s = await total();
      return near(s, v.algo.filled, stepOf(t) / 2) ? s : null;
    }, { timeoutMs: 60_000, everyMs: 5_000 })
    .catch(() => total());
  t.check(near(sum, v.algo.filled, stepOf(t) / 2), `the fills ${t.where} reports (${sum}) add up to what the executor booked (${v.algo.filled})`);
  const fixedSize = v.algo.spec.kind !== 'dca' && v.algo.spec.kind !== 'basket';
  if (fixedSize && v.target !== null && v.algo.status === 'done') t.check(near(v.algo.filled, v.target, stepOf(t) / 2), `filled ${v.algo.filled} = the target ${v.target}`);
}

async function nothingResting(t: T, id: string, symbol = t.main.name): Promise<void> {
  await t.waitFor(`nothing of ${id} rests on ${t.where}`, async () => ((await t.algoOrders(id, symbol)).length === 0 ? true : null), { timeoutMs: 20_000 });
}

async function positionIs(t: T, want: number, what: string, symbol = t.main.name): Promise<void> {
  await t.waitFor(`${what}: the follower's position is ${want}`, async () => (near(await t.account.position(symbol), want, stepOf(t) / 2) ? true : null), { timeoutMs: 20_000 });
}

/** What rests of an algo, waited for until `n` of its orders do. */
async function resting(t: T, id: string, n: number, what: string, timeoutMs = 30_000, symbol = t.main.name) {
  return t.waitFor(what, async () => {
    const o = (await t.algoOrders(id, symbol)).filter((x) => !x.stop);
    return o.length === n ? o : null;
  }, { timeoutMs });
}

/**
 * Start an algo of about `usd` U whose smallest child depends on the market (a VWAP's volume profile): when the
 * engine refuses it as too small and names the size that fits, start it at that size if it is at most `most` U,
 * else the market is too uneven right now for a small one (inconclusive, run again later).
 */
async function startSized(t: T, usd: number, most: number, spec: (qty: string) => Record<string, unknown>): Promise<AlgoView> {
  try {
    return await t.start(spec(await t.qty(usd * t.U)));
  } catch (e) {
    // The engine's words (sizes.ts money): "$191", "$1,234", "$4.02M" - a size in millions is never small.
    const m = /Raise the size to \$([\d,]+(?:\.\d+)?)([kMB]?)/.exec(e instanceof Error ? e.message : String(e));
    const need = m ? Number(m[1]!.replace(/,/g, '')) * (m[2] ? 1e9 : 1) : NaN;
    if (!(need > 0)) throw e;
    if (need > most * t.U) throw new Inconclusive(`the volume profile is too uneven for a small order now (it needs $${need})`);
    t.note(`the profile needs $${need}: started at that size`);
    return t.start(spec(await t.qty(need * 1.05)));
  }
}

/** A practice run started next to the run's own specs: paper whatever the run is. */
async function startPaper(t: T, x: Record<string, unknown>): Promise<AlgoView> {
  const v = await t.exec.algoStart({ ...t.spec(x), paper: true });
  t.algos.push(v.algo.id);
  t.note(`started a practice ${v.algo.spec.kind} ${v.algo.id}`);
  return v;
}

export const ALGO_MATRIX_SCENARIOS: Scenario[] = [
  /* ================================================================ TWAP ===== */
  mx('twap.sell-shaped', 'twap', 'TWAP sell, front-loaded (urgency), sizes and times jittered, smallest and largest slice, slippage from the mid, a spread guard', 'IOC sells priced off SoDEX\'s mid within the cap, the slices as the curve and the bounds shape them, the exact size', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 8 * U, makerUsd: 0, peakUsd: 4 * U }),
    async run(t) {
      const qty = await t.qty(4 * t.U);
      const v0 = await t.start({ kind: 'twap', side: 'sell', quantity: qty, durationMs: MIN, slices: 2, urgency: 0.2, sizeJitter: 0.2, timeJitter: 0.3, minSliceQty: await t.qty(t.U), maxSliceQty: await t.qty(3.5 * t.U), maxSpreadBps: 100, exec: { style: 'taker', slippageBps: 20, slipFrom: 'mid' } });
      const v = await t.waitAlgo(v0.algo.id, 'the TWAP is done', done, { timeoutMs: 3 * MIN });
      await filledAsBooked(t, v);
      const kids = v.algo.children;
      t.check(kids.every((c) => c.tif === 'ioc' && c.side === 'sell'), 'every slice an IOC sell');
      // Each IOC's limit is the mid when it went out less 20 bp: within that (and the half spread) of where it filled.
      // (Not of the arrival price: the market moves over the minute.)
      const filled = kids.filter((c) => c.filled > 0);
      t.check(filled.every((c) => c.price >= (c.value / c.filled) * (1 - 0.0025)), `every slice priced within the cap under the mid it went out at (${filled.map((c) => `${c.price} filled at ${(c.value / c.filled).toFixed(1)}`).join(', ')})`);
      t.check(kids.filter((c) => c.tag !== 'finish').every((c) => c.quantity <= Number(field(v.algo.spec, 'maxSliceQty')) + stepOf(t) / 2), 'no slice over the largest');
      await positionIs(t, -v.algo.filled, 'after the TWAP');
    },
  }),
  mx('twap.slip-references', 'twap', 'TWAP slippage measured from SoDEX\'s mark, its index, the oracle mid and the oracle fair price (one slice each, buy, sell, buy, sell)', 'each reference prices a real IOC that SoDEX fills; the position nets out', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const refs = [['mark', 'buy'], ['index', 'sell'], ['oracleMid', 'buy'], ['oracleFair', 'sell']] as const;
      for (const [from, side] of refs) {
        const v0 = await t.start({ kind: 'twap', side, quantity: await t.qty(t.U), durationMs: MIN, slices: 1, exec: { style: 'taker', slippageBps: 25, slipFrom: from } });
        const v = await t.waitAlgo(v0.algo.id, `the ${from} TWAP is done`, done, { timeoutMs: 45_000, inconclusive: true });
        await filledAsBooked(t, v);
      }
      await positionIs(t, 0, 'buys and sells net out');
    },
  }),
  mx('twap.maker-leave', 'twap', 'TWAP maker under a limit price, finish leave', 'post-only slices rest under the limit, nothing is taken at the end, it expires with nothing left on SoDEX', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const limit = t.tick(q.bid * 0.997, t.main.name, 'down');
      const v0 = await t.start({ kind: 'twap', quantity: await t.qty(t.U), durationMs: MIN, slices: 1, limitPrice: limit, exec: { style: 'maker', chaseTicks: 1 }, finish: 'leave' });
      const rest = await resting(t, v0.algo.id, 1, 'the slice rests at the limit');
      t.check(rest[0]!.price <= limit, `at or under the limit ${limit} (${rest[0]!.price})`);
      await t.live('it rests post-only', async () => t.check(rest[0]!.tif === 'GTX', `GTX (${rest[0]!.tif})`));
      const v = await t.waitEnded(v0.algo.id, 2 * MIN);
      if (v.algo.filled > 0) throw new Inconclusive('the market fell 0.3% within a minute and the slice filled');
      t.check(v.algo.status === 'expired', `it expired (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      t.check(v.algo.children.every((c) => c.tif !== 'ioc'), 'nothing was taken at the end');
      await nothingResting(t, v0.algo.id);
    },
  }),
  mx('twap.participation-leverage', 'twap', 'TWAP capped at 50% of the market\'s volume, asking 100x cross margin', 'the participation cap holds real slices to the tape; SoDEX sets the market\'s (or the region\'s) largest leverage, cross', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'twap', quantity: await t.qty(2 * t.U), durationMs: MIN, slices: 2, maxParticipation: 0.5, leverage: 100, marginMode: 'cross', exec: { style: 'taker', slippageBps: 20 }, finish: 'take' });
      const v = await t.waitAlgo(v0.algo.id, 'the TWAP is done (the finish takes what the volume held back)', done, { timeoutMs: 3 * MIN });
      await filledAsBooked(t, v);
      const exp = t.expectedLeverage(100);
      await t.live(`SoDEX holds it at ${exp}x cross (asked 100x)`, async () => {
        const l = await t.env.reads.leverage(t.env.followerAddress, t.main.name);
        t.check(l !== null && l.leverage === exp && l.marginMode === 'cross', `leverage ${exp}x cross`, l);
      });
    },
  }),
  mx('twap.bound-hold', 'twap', 'TWAP held by an upper bound already reached, its label changed while held, then cancelled', 'nothing reaches SoDEX while the bound holds it (the signed change of a running algo takes its size, limit, spread guard and label: not its bounds); a cancel ends it clean', {
    timeoutMs: 2 * MIN,
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0 }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'twap', quantity: await t.qty(t.U), durationMs: MIN, slices: 1, upper: { price: t.tick(q.mark * 0.995, t.main.name, 'down'), then: 'hold' }, exec: { style: 'taker', slippageBps: 20 } });
      await t.waitAlgo(v0.algo.id, 'it is held by the bound', (v) => /bound/.test(v.algo.statusReason ?? ''), { timeoutMs: 30_000 });
      await t.exec.algoUpdate(v0.algo.id, { label: 'mx held' });
      await t.sleep(20_000);
      const v = await t.view(v0.algo.id);
      t.check(v.algo.childCount === 0 && v.algo.status === 'waiting', `nothing sent while held (${v.algo.status}, ${v.algo.childCount} children)`);
      t.check(v.algo.spec.label === 'mx held', 'the label changed while held');
      t.check((await t.algoOrders(v0.algo.id)).length === 0, `nothing on ${t.where}`);
      await t.exec.algoAct('cancel', v0.algo.id);
      const x = await t.waitEnded(v0.algo.id, 20_000);
      t.check(x.algo.status === 'cancelled', 'cancelled');
    },
  }),
  mx('twap.bound-stop-rush', 'twap', 'TWAP whose lower bound (stop) is reached at once; another whose upper bound (rush) is', 'stop ends it with nothing sent; rush takes the whole size at once instead of over two minutes', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const q = await t.quote();
      const a = await t.start({ kind: 'twap', quantity: await t.qty(t.U), durationMs: 2 * MIN, slices: 1, lower: { price: t.tick(q.mark * 1.005, t.main.name, 'up'), then: 'stop' }, exec: { style: 'taker', slippageBps: 20 } });
      const x = await t.waitEnded(a.algo.id, 30_000);
      t.check(x.algo.status === 'expired' && /bound/.test(x.algo.statusReason ?? ''), `stopped at the bound (${x.algo.status}: ${x.algo.statusReason ?? ''})`);
      t.check(x.algo.childCount === 0, 'nothing sent');
      const b = await t.start({ kind: 'twap', quantity: await t.qty(2 * t.U), durationMs: 2 * MIN, slices: 2, upper: { price: t.tick(q.mark * 0.995, t.main.name, 'down'), then: 'rush' }, exec: { style: 'taker', slippageBps: 20 } });
      const y = await t.waitAlgo(b.algo.id, 'the rush took everything at once', done, { timeoutMs: 40_000 });
      await filledAsBooked(t, y);
      await positionIs(t, y.algo.filled, 'after the rush');
    },
  }),
  mx('twap.start-later', 'twap', 'TWAP with a start time 40 s out, and one with a start price far away', 'nothing reaches SoDEX before the start time, then it fills; one waiting for a price sends nothing and cancels clean', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const far = await t.start({ kind: 'twap', quantity: await t.qty(t.U), durationMs: MIN, slices: 1, triggerPrice: t.tick(q.mark * 0.9, t.main.name, 'down'), exec: { style: 'taker', slippageBps: 20 } });
      const later = await t.start({ kind: 'twap', quantity: await t.qty(t.U), durationMs: MIN, slices: 1, startAt: Date.now() + 40_000, exec: { style: 'taker', slippageBps: 20 } });
      await t.sleep(20_000);
      for (const x of [far, later]) {
        const v = await t.view(x.algo.id);
        t.check(v.algo.status === 'scheduled' && v.algo.childCount === 0, `${x.algo.id} is scheduled, nothing sent (${v.algo.status})`);
        t.check((await t.algoOrders(x.algo.id)).length === 0, `nothing of ${x.algo.id} on ${t.where}`);
      }
      const v = await t.waitAlgo(later.algo.id, 'the later TWAP started and is done', done, { timeoutMs: 90_000 });
      t.check(v.algo.startedAt !== null && v.algo.startedAt >= later.algo.createdAt + 39_000 * (t.dry ? 0.5 : 1) - 5_000, 'it started at its time');
      await filledAsBooked(t, v);
      await t.exec.algoAct('cancel', far.algo.id);
      const f = await t.waitEnded(far.algo.id, 20_000);
      t.check(f.algo.status === 'cancelled' && f.algo.childCount === 0, 'the one waiting for its price was cancelled, never having sent anything');
    },
  }),
  mx('twap.close-half', 'twap', 'TWAP closing half of a long (time-sliced, reduce-only)', 'reduce-only sells of half the position SoDEX holds; the other half stays', {
    timeoutMs: 4 * MIN,
    dry: 'spec',
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const pos = await t.openPosition('buy', 2.2 * t.U);
      const v0 = await t.start({ kind: 'twap', side: 'sell', closeShare: 0.5, durationMs: MIN, slices: 1, exec: { style: 'taker', slippageBps: 30 } });
      const v = await t.waitEnded(v0.algo.id, 2 * MIN);
      if (t.dry) {
        t.check(ended(v), `on paper there is no position to close: it ended ${v.algo.status}`);
        return;
      }
      t.check(v.algo.status === 'done', `done (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      t.check(v.algo.children.every((c) => c.reduceOnly && c.side === 'sell'), 'reduce-only sells');
      const half = Math.floor(pos / 2 / stepOf(t)) * stepOf(t);
      t.check(near(v.algo.filled, half, stepOf(t)), `it sold half (${v.algo.filled} of ${pos})`);
      await positionIs(t, pos - v.algo.filled, 'half stays');
    },
  }),
  mx('twap.short-exits', 'twap', 'TWAP sell with exits as prices (a short\'s take-profit below, stop-loss above)', 'SoDEX holds buy-side reduce-only stops at exactly those prices, sized to the fill; a cancel pulls them', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const q = await t.quote();
      const tp = t.tick(q.bid * 0.97, t.main.name, 'down');
      const sl = t.tick(q.ask * 1.03, t.main.name, 'up');
      const v0 = await t.start({ kind: 'twap', side: 'sell', quantity: await t.qty(2 * t.U), durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 20 }, exits: { tpPrice: tp, slPrice: sl } });
      const v = await t.waitAlgo(v0.algo.id, 'the TWAP is done', done, { timeoutMs: 3 * MIN });
      const stops = await t.waitFor('two exits rest, sized to the whole fill', async () => {
        const s = (await t.algoOrders(v.algo.id)).filter((o) => o.stop);
        return s.length === 2 && s.every((x) => near(x.qty, v.algo.filled, stepOf(t) / 2)) ? s : null;
      }, { timeoutMs: 45_000 });
      t.check(stops.every((s) => s.side === 'buy' && s.reduceOnly), 'both are reduce-only buys');
      t.check(near(stops.find((s) => s.stop!.kind === 'tp')!.stop!.trigger, tp, tickOf(t)) && near(stops.find((s) => s.stop!.kind === 'sl')!.stop!.trigger, sl, tickOf(t)), 'at the prices given');
      await t.exec.algoAct('cancel', v.algo.id);
      await nothingResting(t, v.algo.id);
      await positionIs(t, -v.algo.filled, 'the short stays');
    },
  }),

  /* ================================================================ VWAP ===== */
  mx('vwap.maker-sell', 'vwap', 'VWAP sell, maker slices, not adaptive, 14 days of history, max participation, finish leave; cancelled', 'its first slice rests post-only at the ask on SoDEX; a cancel pulls it', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: U, makerUsd: U, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await startSized(t, 2.4, 4.5, (qty) => ({ kind: 'vwap', side: 'sell', quantity: qty, durationMs: 15 * MIN, slices: 2, lookbackDays: 14, adaptive: false, sizeJitter: 0.1, maxParticipation: 0.5, exec: { style: 'maker', chaseTicks: 2 }, finish: 'leave' }));
      const rest = await t.waitFor('a slice rests (or has filled)', async () => {
        const o = await t.algoOrders(v0.algo.id);
        const v = await t.view(v0.algo.id);
        return o.length === 1 || v.algo.filled > 0 ? { o, v } : null;
      }, { timeoutMs: 2 * MIN });
      const q = await t.quote();
      if (rest.o.length) t.check(rest.o[0]!.side === 'sell' && rest.o[0]!.price >= q.bid, `a sell resting at or above the bid (${rest.o[0]!.price} vs ${q.bid})`);
      await t.live('it rests post-only', async () => t.check(rest.o.every((o) => o.tif === 'GTX'), 'GTX', rest.o.map((o) => o.tif)));
      await t.exec.algoAct('cancel', v0.algo.id);
      const v = await t.waitEnded(v0.algo.id, 20_000);
      t.check(v.algo.status === 'cancelled', 'cancelled');
      await nothingResting(t, v0.algo.id);
      await filledAsBooked(t, v);
    },
  }),

  /* ================================================================= POV ===== */
  mx('pov.sell-maker-end', 'pov', 'POV sell at 50%, maker, a largest child, an end time 2 min out, finish leave', 'post-only children follow the real tape, none over the largest child; at its end time it stops with nothing left on SoDEX', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 2 * U, peakUsd: 2 * U }),
    async run(t) {
      const big = await t.qty(1.3 * t.U);
      const v0 = await t.start({ kind: 'pov', side: 'sell', quantity: await t.qty(2 * t.U), rate: 0.5, maxChildQty: big, endAt: Date.now() + 2 * MIN, exec: { style: 'maker', chaseTicks: 2 }, finish: 'leave' });
      const v = await t.waitEnded(v0.algo.id, 3 * MIN);
      t.check(['done', 'expired'].includes(v.algo.status), `it ended at its end time or filled (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      t.check(v.algo.children.every((c) => c.tif === 'gtx'), 'only post-only children');
      t.check(v.algo.children.every((c) => c.quantity <= Number(big) + stepOf(t) / 2), `none over the largest child ${big}`);
      await nothingResting(t, v0.algo.id);
      await filledAsBooked(t, v);
      t.note(`filled ${v.algo.filled} of the market's ${v.algo.marketQty}`);
    },
  }),
  mx('pov.hybrid-take', 'pov', 'POV buy at 20%, hybrid, an end time 90 s out, finish take', 'rests first, takes what falls behind; at the end the rest is taken: the exact size on SoDEX', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: U, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'pov', quantity: await t.qty(2 * t.U), rate: 0.2, endAt: Date.now() + 90_000, exec: { style: 'hybrid', slippageBps: 20, makerShare: 0.5 }, finish: 'take' });
      const v = await t.waitAlgo(v0.algo.id, 'the POV is done', done, { timeoutMs: 3 * MIN });
      await filledAsBooked(t, v);
      await positionIs(t, v.algo.filled, 'after the POV');
    },
  }),

  /* ============================================================= Iceberg ===== */
  mx('iceberg.gtc-sell-inside', 'iceberg', 'Iceberg sell, GTC clips pegged one tick inside the spread, clip sizes jittered, a refill delay', 'GTC clips (not post-only) one at a time, refilled after a pause, to the exact size', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 3 * U, makerUsd: 2 * U, peakUsd: 3 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'iceberg', side: 'sell', quantity: await t.qty(2.6 * t.U), displayQty: await t.qty(1.3 * t.U), displayJitter: 0.15, postOnly: false, pegOffsetTicks: -1, chaseTicks: 3, refillMs: 1_000, refillJitter: 0.5 });
      let most = 0;
      const v = await t.waitFor('the iceberg is done', async () => {
        most = Math.max(most, (await t.algoOrders(v0.algo.id)).length);
        const x = await t.view(v0.algo.id);
        return done(x) ? x : null;
      }, { timeoutMs: 4 * MIN, everyMs: 2_500, inconclusive: true });
      t.check(most <= 1, `one clip at a time (${most})`);
      t.check(v.algo.children.every((c) => c.tif === 'gtc'), 'every clip GTC');
      await filledAsBooked(t, v);
      await positionIs(t, -v.algo.filled, 'after the iceberg');
    },
  }),
  mx('iceberg.fixed-rush', 'iceberg', 'Iceberg buy at a fixed price under the market, whose upper bound (rush) is already reached', 'the rush pulls the resting clip and takes the whole size at once', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'iceberg', quantity: await t.qty(2 * t.U), displayQty: await t.qty(t.U), price: t.tick(q.bid * 0.995, t.main.name, 'down'), postOnly: true, upper: { price: t.tick(q.mark * 0.995, t.main.name, 'down'), then: 'rush' } });
      const v = await t.waitAlgo(v0.algo.id, 'the rush filled it all', done, { timeoutMs: 60_000 });
      t.check(v.algo.children.some((c) => c.tif === 'ioc'), 'taken by IOC');
      await nothingResting(t, v0.algo.id);
      await filledAsBooked(t, v);
    },
  }),

  /* =============================================================== Chase ===== */
  mx('chase.buy-rest', 'chase', 'Chase buy some ticks (about 20 bp) behind, re-priced every 2 ticks (2 s apart at most), 20 s, then left resting', 'onEnd rest leaves its order on SoDEX after it expires; a cancel of the ended chase pulls it', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: U, peakUsd: U }),
    async run(t) {
      // About 20 bp behind the bid, in ticks: far enough not to fill in 20 s.
      const behind = Math.max(2, Math.round(((await t.quote()).bid * 0.002) / tickOf(t)));
      const v0 = await t.start({ kind: 'chase', quantity: await t.qty(t.U), offsetTicks: behind, chaseTicks: 2, minRepriceMs: 2_000, timeoutMs: 20_000, onEnd: 'rest' });
      const v = await t.waitEnded(v0.algo.id, 60_000);
      if (v.algo.filled > 0) throw new Inconclusive('the chase filled before its time was up');
      t.check(v.algo.status === 'expired', `expired (${v.algo.status})`);
      await resting(t, v0.algo.id, 1, `its order is left resting on ${t.where}`, 15_000);
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
      t.check((await t.view(v0.algo.id)).algo.status === 'expired', 'it keeps its final status');
    },
  }),
  mx('chase.sell-inside-take', 'chase', 'Chase sell one tick inside the spread, max chase 5 bp, 45 s, then take', 'a post-only order inside the spread, chasing at most 5 bp; whatever is left is taken', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: U, peakUsd: U }),
    async run(t) {
      const v0 = await t.start({ kind: 'chase', side: 'sell', quantity: await t.qty(t.U), offsetTicks: -1, maxChaseBps: 5, timeoutMs: 45_000, onEnd: 'take' });
      const v = await t.waitAlgo(v0.algo.id, 'the chase is done', done, { timeoutMs: 90_000 });
      const start = v.algo.arrival!;
      t.check(v.algo.children.filter((c) => c.tif === 'gtx').every((c) => c.price >= start * (1 - 0.0005) - tickOf(t) * 2), 'never chased more than 5 bp down');
      await filledAsBooked(t, v);
    },
  }),

  /* =============================================================== Scale ===== */
  mx('scale.curve-geometric', 'scale', 'Scale buy ladder, linear size curve (skew 1.5), geometric spacing', 'three post-only levels rest on SoDEX at the planned prices, larger toward the last; a cancel pulls them', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 4 * U }),
    async run(t) {
      const q = await t.quote();
      const from = t.tick(q.bid * 0.995, t.main.name, 'down');
      const to = t.tick(q.bid * 0.985, t.main.name, 'down');
      const v0 = await t.start({ kind: 'scale', quantity: await t.qty(4 * t.U), from, to, orders: 3, distribution: 'linear', skew: 1.5, spacing: 'geometric', postOnly: true });
      const rest = await resting(t, v0.algo.id, 3, `3 levels rest on ${t.where}`);
      const v = await t.view(v0.algo.id);
      const planned = v.algo.children.filter((c) => c.state !== 'done').map((c) => c.price).sort((a, b) => a - b);
      t.check(JSON.stringify(planned) === JSON.stringify(rest.map((o) => o.price).sort((a, b) => a - b)), `${t.where} holds the planned prices`, { planned });
      const byPrice = [...rest].sort((a, b) => b.price - a.price);
      t.check(byPrice[2]!.qty > byPrice[0]!.qty, `larger toward the last price (${byPrice.map((o) => o.qty).join(', ')})`);
      await t.live('every level post-only', async () => t.check(rest.every((o) => o.tif === 'GTX'), 'GTX'));
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),
  mx('scale.sell-curves', 'scale', 'Scale sell ladders above the market: a bell with front spacing (GTC), an exponential curve (skew 2) with back spacing', 'GTC and post-only levels rest above the ask at the planned prices; cancels pull them', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 3.5 * U }),
    async run(t) {
      const q = await t.quote();
      const from = t.tick(q.ask * 1.006, t.main.name, 'up');
      const to = t.tick(q.ask * 1.012, t.main.name, 'up');
      for (const [distribution, spacing, postOnly, n, usd] of [['bell', 'front', false, 2, 2.2], ['exponential', 'back', true, 2, 3.4]] as const) {
        const v0 = await t.start({ kind: 'scale', side: 'sell', quantity: await t.qty(usd * t.U), from, to, orders: n, distribution, skew: distribution === 'exponential' ? 2 : 1, spacing, postOnly });
        const rest = await resting(t, v0.algo.id, n, `${distribution}: ${n} levels rest`);
        t.check(rest.every((o) => o.side === 'sell' && o.price >= q.ask), 'sells above the ask');
        await t.live(`${postOnly ? 'post-only' : 'GTC'} levels`, async () => t.check(rest.every((o) => o.tif === (postOnly ? 'GTX' : 'GTC')), rest.map((o) => o.tif).join(',')));
        if (distribution === 'exponential') {
          const by = [...rest].sort((a, b) => a.price - b.price);
          t.check(by[1]!.qty > by[0]!.qty * 1.5, `the last level about twice the first (${by.map((o) => o.qty).join(', ')})`);
        }
        await t.exec.algoAct('cancel', v0.algo.id);
        await nothingResting(t, v0.algo.id);
      }
    },
  }),
  mx('scale.size-change', 'scale', 'Scale ladder raised, then lowered, while it rests', 'each level is put back on SoDEX at its new size (a raise is worked, not ignored); what rests always adds up to the new size', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 3.5 * U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'scale', quantity: await t.qty(2.2 * t.U), from: t.tick(q.bid * 0.993, t.main.name, 'down'), to: t.tick(q.bid * 0.988, t.main.name, 'down'), orders: 2, postOnly: true });
      await resting(t, v0.algo.id, 2, '2 levels rest');
      for (const usd of [3.4, 2.2]) {
        const want = await t.qty(usd * t.U);
        await t.exec.algoUpdate(v0.algo.id, { quantity: want });
        await t.waitFor(`the levels rest again for ${want} in all`, async () => {
          const o = await t.algoOrders(v0.algo.id);
          return o.length === 2 && near(o.reduce((x, y) => x + y.qty - y.filled, 0), Number(want), 2 * stepOf(t)) ? o : null;
        }, { timeoutMs: 60_000 });
      }
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),

  /* ================================================================= DCA ===== */
  mx('dca.maker-wait', 'dca', 'DCA (by the API) of resting orders: outside the limit it waits, a dip boost and a total budget set', 'each order rests post-only at the bid on SoDEX, its own order; a cancel pulls them', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 2 * U, peakUsd: 2.5 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'dca', perOrderUsd: t.U, orders: 3, intervalMs: MIN, outOfBand: 'wait', limitPrice: t.tick((await t.quote()).ask * 1.02, t.main.name, 'up'), dipPct: 0.01, dipMultiplier: 1.5, maxTotalUsd: 2.5 * t.U, exec: { style: 'maker', chaseTicks: 3 } });
      const first = await t.waitFor('its first order rests (or filled)', async () => {
        const v = await t.view(v0.algo.id);
        const o = await t.algoOrders(v0.algo.id);
        return o.length >= 1 || v.algo.filled > 0 ? { v, o } : null;
      }, { timeoutMs: 30_000 });
      await t.live('a post-only buy', async () => t.check(first.o.every((o) => o.tif === 'GTX' && o.side === 'buy'), 'GTX buys'));
      const v1 = await t.view(v0.algo.id);
      t.check(v1.algo.children.every((c) => c.tif === 'gtx'), 'a maker DCA only rests');
      await t.exec.algoAct('cancel', v0.algo.id);
      await t.waitEnded(v0.algo.id, 20_000);
      await nothingResting(t, v0.algo.id);
      await filledAsBooked(t, await t.view(v0.algo.id));
    },
  }),
  mx('dca.sell-hybrid', 'dca', 'DCA (by the API) sell, two hybrid orders a minute apart', 'each order rests, then takes what is left: about its USD amount per order on SoDEX', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: U, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'dca', side: 'sell', perOrderUsd: t.U, orders: 2, intervalMs: MIN, exec: { style: 'hybrid', slippageBps: 20, makerShare: 0.3 } });
      const v = await t.waitAlgo(v0.algo.id, 'the DCA is done', done, { timeoutMs: 3 * MIN });
      t.check(near(v.algo.filledValue, 2 * t.U, 0.2 * 2 * t.U), `about $${2 * t.U} sold ($${v.algo.filledValue.toFixed(2)})`);
      await filledAsBooked(t, v);
      await positionIs(t, -v.algo.filled, 'after the DCA');
    },
  }),

  /* =============================================================== Swarm ===== */
  mx('swarm.buy-irregular', 'swarm', 'Swarm buy, irregular clips one at a time, no pause, one retry', 'IOC clips of different sizes fill the exact size on SoDEX', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 7.2 * U, makerUsd: 0, peakUsd: 3.6 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'swarm', quantity: await t.qty(3.6 * t.U), clips: 3, inFlight: 1, waveMs: 0, sizeJitter: 0.15, slippageBps: 30, retries: 1 });
      const v = await t.waitAlgo(v0.algo.id, 'the swarm is done', done, { timeoutMs: 90_000 });
      t.check(v.algo.children.every((c) => c.tif === 'ioc'), 'IOC clips');
      t.check(new Set(v.algo.children.map((c) => c.quantity)).size > 1, `irregular (${v.algo.children.map((c) => c.quantity).join(', ')})`);
      await filledAsBooked(t, v);
      await positionIs(t, v.algo.filled, 'after the swarm');
    },
  }),

  /* ========================================================= Conditional ===== */
  mx('conditional.any-sources', 'conditional', 'Conditional (any of: last price far below, mid above, index above; held 3 s, expiring in 10 min) then a market buy', 'SoDEX\'s live last, mid and index prices are evaluated; the one that holds fires it after the hold; the order fills', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const sym = t.main.name;
      const v0 = await t.start({
        kind: 'conditional',
        match: 'any',
        holdMs: 3_000,
        expiresAt: Date.now() + 10 * MIN,
        conditions: [
          { type: 'price', symbol: sym, source: 'last', op: 'below', value: t.tick(q.mark * 0.5) },
          { type: 'price', symbol: sym, source: 'mid', op: 'above', value: t.tick(q.mark * 0.99) },
          { type: 'price', symbol: sym, source: 'index', op: 'above', value: t.tick(q.mark * 0.99) },
          { type: 'cross', symbol: sym, source: 'mark', dir: 'down', value: t.tick(q.mark * 0.5) },
        ],
        then: { type: 'market', quantity: await t.qty(t.U), slippageBps: 30 },
      });
      const v = await t.waitAlgo(v0.algo.id, 'it fired and filled', done, { timeoutMs: 60_000 });
      t.check(v.conditions !== null && v.conditions.some((c) => c.ok) && !v.conditions[0]!.ok, 'the view says which held', v.conditions);
      await filledAsBooked(t, v);
    },
  }),
  mx('conditional.all-limit-kept', 'conditional', 'Conditional (all of: volume in the last minute, a ratio of two markets, funding, a time 15 s out) then a GTC limit under the market', 'it fires at the time; the limit rests on SoDEX after the conditional is done; a cancel of the ended conditional pulls it', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const at = Date.now() + 15_000;
      const v0 = await t.start({
        kind: 'conditional',
        conditions: [
          { type: 'volume', symbol: t.main.name, windowMs: MIN, aboveUsd: 1 },
          { type: 'ratio', symbol: t.main.name, other: t.second.name, op: 'above', value: 1e-9 },
          { type: 'funding', symbol: t.main.name, op: 'above', value: -1 },
          { type: 'time', at },
        ],
        then: { type: 'limit', quantity: await t.qty(t.U), price: t.tick(q.bid * 0.99, t.main.name, 'down'), postOnly: false },
      });
      const v = await t.waitAlgo(v0.algo.id, 'it fired and placed the limit', done, { timeoutMs: 90_000, inconclusive: true });
      t.check(Date.now() >= at - 1_000, 'not before its time');
      const rest = await resting(t, v0.algo.id, 1, 'the limit rests after the conditional is done', 20_000);
      await t.live('as GTC', async () => t.check(rest[0]!.tif === 'GTC', rest[0]!.tif));
      t.check(v.algo.status === 'done', 'done');
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),
  mx('conditional.any-twap-oco', 'conditional', 'Conditional (any of: a move, an open-interest change, your flat position, a time) that starts a TWAP with a stop-loss', 'the conditions are read from SoDEX\'s live data; the TWAP it starts fills and its stop-loss rests on SoDEX', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const v0 = await t.start({
        kind: 'conditional',
        match: 'any',
        conditions: [
          { type: 'move', symbol: t.main.name, source: 'mark', dir: 'either', pct: 0.5, windowMs: 10 * 1000 },
          { type: 'oi', symbol: t.main.name, dir: 'either', pct: 0.5, windowMs: 10 * 1000 },
          { type: 'position', symbol: t.second.name, op: 'flat' },
          { type: 'time', at: Date.now() + 20_000 },
        ],
        then: { type: 'algo', algo: { kind: 'twap', symbol: t.main.name, side: 'buy', quantity: await t.qty(t.U), durationMs: MIN, slices: 1, exec: { style: 'taker', slippageBps: 20 }, exits: { slPct: 0.03 } } },
      });
      await t.waitAlgo(v0.algo.id, 'the conditional started its TWAP', done, { timeoutMs: 60_000 });
      const child = await t.waitFor('the TWAP it started is listed', async () => (await t.exec.algos()).find((x) => x.algo.parentId === v0.algo.id) ?? null, { timeoutMs: 20_000 });
      t.algos.push(child.algo.id);
      const c = await t.waitAlgo(child.algo.id, 'the TWAP is done', done, { timeoutMs: 90_000 });
      await filledAsBooked(t, c);
      await t.waitFor(`its stop-loss rests on ${t.where}`, async () => ((await t.algoOrders(c.algo.id)).filter((o) => o.stop?.kind === 'sl').length === 1 ? true : null), { timeoutMs: 45_000 });
      await t.exec.algoAct('cancel', c.algo.id);
      await nothingResting(t, c.algo.id);
    },
  }),
  mx('conditional.close-half', 'conditional', 'Conditional on your position\'s size, then close half of it', 'the size SoDEX reports fires it; a reduce-only close of half leaves half', {
    timeoutMs: 2 * MIN,
    dry: 'spec',
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const pos = await t.openPosition('buy', 2.2 * t.U);
      const v0 = await t.start({ kind: 'conditional', side: 'sell', conditions: [{ type: 'position', symbol: t.main.name, op: 'sizeAbove', value: Math.max(pos * 0.5, stepOf(t)) }], then: { type: 'close', share: 0.5, slippageBps: 30 } });
      if (t.dry) {
        await t.sleep(10_000);
        t.check((await t.view(v0.algo.id)).algo.filled === 0, 'on paper the follower holds no position: it waits');
        await t.exec.algoAct('cancel', v0.algo.id);
        return;
      }
      const v = await t.waitEnded(v0.algo.id, 90_000);
      t.check(v.algo.status === 'done', `done (${v.algo.statusReason ?? ''})`);
      t.check(v.algo.children.every((c) => c.reduceOnly && c.side === 'sell'), 'reduce-only sells');
      await positionIs(t, pos - v.algo.filled, 'half stays');
      t.check(near(v.algo.filled, Math.floor(pos / 2 / stepOf(t)) * stepOf(t), stepOf(t)), `it closed half (${v.algo.filled} of ${pos})`);
    },
  }),
  mx('conditional.short-exits', 'conditional', 'Conditional then a market sell, with a take-profit (%) and a stop-loss (price)', 'the short\'s exits are buy-side reduce-only stops on SoDEX; a cancel pulls them, the short stays', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'conditional', side: 'sell', conditions: [{ type: 'spread', symbol: t.main.name, op: 'below', bps: 100 }], then: { type: 'market', quantity: await t.qty(t.U), slippageBps: 30 }, exits: { tpPct: 0.03, slPrice: t.tick(q.ask * 1.03, t.main.name, 'up') } });
      const v = await t.waitAlgo(v0.algo.id, 'it fired and filled', done, { timeoutMs: 60_000 });
      const stops = await t.waitFor('two exits rest', async () => {
        const s = (await t.algoOrders(v.algo.id)).filter((o) => o.stop);
        return s.length === 2 ? s : null;
      }, { timeoutMs: 45_000 });
      t.check(stops.every((s) => s.side === 'buy' && s.reduceOnly), 'reduce-only buys');
      const avg = v.algo.filledValue / v.algo.filled;
      t.check(near(stops.find((s) => s.stop!.kind === 'tp')!.stop!.trigger, avg * 0.97, avg * 0.001), 'the take-profit 3% under the average');
      await t.exec.algoAct('cancel', v.algo.id);
      await nothingResting(t, v.algo.id);
      await positionIs(t, -v.algo.filled, 'the short stays');
    },
  }),

  /* ============================================================ Trailing ===== */
  mx('trailing.short-abs-chase', 'trailing', 'Trailing stop (buy) on a short, a USD trail on the last price, exiting by a chase', 'it follows SoDEX\'s last price and, on the turn, rests first and then takes: the short is closed reduce-only', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: U, peakUsd: U }),
    async run(t) {
      await t.openPosition('sell', t.U);
      const q = await t.quote();
      const trailAbs = t.tick(Math.max(q.mark * 0.0006, 2 * tickOf(t)), t.main.name, 'up');
      const v0 = await t.start(t.dry ? { kind: 'trailing', side: 'buy', quantity: await t.qty(t.U), trailAbs, source: 'last', exit: 'chase', chaseMs: 5_000 } : { kind: 'trailing', side: 'buy', trailAbs, source: 'last', exit: 'chase', chaseMs: 5_000 });
      const v = await t.waitEnded(v0.algo.id, 4 * MIN, true);
      t.check(v.algo.status === 'done', `it fired (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      t.check(v.algo.children.some((c) => c.tif === 'gtx') || v.algo.children.every((c) => c.tif === 'ioc'), 'a chase exit (rested first, or taken at once when it came back)');
      if (!t.dry) {
        t.check(v.algo.children.every((c) => c.reduceOnly && c.side === 'buy'), 'reduce-only buys');
        await positionIs(t, 0, 'the short is closed');
      }
    },
  }),
  mx('trailing.amount-activation', 'trailing', 'Trailing stop of an amount (half of a long), armed at an activation price, 0.1% trail', 'it arms at the activation price, fires on the turn, and sells only its amount: the rest of the long stays on SoDEX', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2.2 * U }),
    async run(t) {
      const pos = await t.openPosition('buy', 2.2 * t.U);
      const q = await t.quote();
      const amount = await t.qty(t.U);
      const v0 = await t.start({ kind: 'trailing', side: 'sell', reduceOnly: true, quantity: amount, trailPct: 0.001, activationPrice: t.tick(q.mark * 0.9995, t.main.name, 'down'), source: 'mark', exit: 'market', slippageBps: 30 });
      const v = await t.waitEnded(v0.algo.id, 4 * MIN, true);
      t.check(v.algo.status === 'done', `it fired (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      t.check(near(v.algo.filled, Number(amount), stepOf(t) / 2), `it sold its amount (${v.algo.filled})`);
      if (!t.dry) await positionIs(t, pos - v.algo.filled, 'the rest of the long stays');
    },
  }),

  /* ============================================================= Bracket ===== */
  mx('bracket.sell-limit-filled', 'bracket', 'Bracket short: a limit entry through the book (fills at once), take-profit and stop-loss in %', 'SoDEX fills the limit entry; buy-side stops are placed for the short, sized to the fill; a cancel pulls them', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'bracket', side: 'sell', quantity: await t.qty(t.U), entry: 'limit', price: t.tick(q.bid * 0.9995, t.main.name, 'down'), exits: { tpPct: 0.02, slPct: 0.02 } });
      const v = await t.waitAlgo(v0.algo.id, 'the entry filled', (x) => x.algo.filled > 0 && done(x), { timeoutMs: 45_000 });
      const stops = await t.waitFor('two exits rest', async () => {
        const s = (await t.algoOrders(v.algo.id)).filter((o) => o.stop);
        return s.length === 2 && s.every((x) => near(x.qty, v.algo.filled, stepOf(t) / 2)) ? s : null;
      }, { timeoutMs: 45_000 });
      t.check(stops.every((s) => s.side === 'buy'), 'buy-side stops for a short');
      await t.exec.algoAct('cancel', v.algo.id);
      await nothingResting(t, v.algo.id);
      await positionIs(t, -v.algo.filled, 'the short stays (the cleanup closes it)');
    },
  }),
  mx('bracket.limit-resize', 'bracket', 'Bracket with a limit entry under the market, its size raised then lowered', 'the resting entry is put back on SoDEX at each new size (it used to end the bracket); no exit before a fill; a cancel pulls it', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 2.2 * U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'bracket', quantity: await t.qty(1.1 * t.U), entry: 'limit', price: t.tick(q.bid * 0.99, t.main.name, 'down'), exits: { tpPct: 0.01, slPct: 0.01 } });
      await resting(t, v0.algo.id, 1, 'the entry rests');
      for (const usd of [2.2, 1.1]) {
        const want = await t.qty(usd * t.U);
        await t.exec.algoUpdate(v0.algo.id, { quantity: want });
        await t.waitFor(`the entry rests again for ${want}`, async () => {
          const o = await t.algoOrders(v0.algo.id);
          return o.length === 1 && !o[0]!.stop && near(o[0]!.qty, Number(want), stepOf(t) / 2) ? o : null;
        }, { timeoutMs: 45_000 });
        const v = await t.view(v0.algo.id);
        t.check(!ended(v), `the bracket still works (${v.algo.status})`);
      }
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),

  /* ============================================================== Basket ===== */
  mx('basket.twap-pause', 'basket', 'Basket of two TWAP legs (a long and a short), paused after the first fills and resumed', 'pause stops both legs on both markets at once (nothing more sent); resume completes both', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 8.4 * U, makerUsd: 0, peakUsd: 4.2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'basket', legs: [{ symbol: t.main.name, side: 'buy', usd: 2.1 * t.U }, { symbol: t.second.name, side: 'sell', usd: 2.1 * t.U }], style: 'twap', durationMs: 80_000, slices: 2, slippageBps: 25 });
      const legsOf = async () => (await t.exec.algos()).filter((x) => x.algo.parentId === v0.algo.id);
      await t.waitFor('a leg filled', async () => ((await legsOf()).some((x) => x.algo.filled > 0) ? true : null), { timeoutMs: 60_000 });
      await t.exec.algoAct('pause', v0.algo.id);
      const paused = await t.waitFor('both legs are paused', async () => {
        const l = await legsOf();
        return l.length === 2 && l.every((x) => x.algo.status === 'paused' || done(x)) ? l : null;
      }, { timeoutMs: 20_000 });
      for (const l of paused) t.algos.push(l.algo.id);
      const before = new Map(paused.map((l) => [l.algo.id, l.algo.childCount]));
      // Longer than the 40 s between the legs' two slices: a running leg would have sent its second.
      await t.sleep(45_000);
      const still = await legsOf();
      t.check(still.every((l) => l.algo.childCount === before.get(l.algo.id)), 'nothing sent while paused', still.map((l) => l.algo.childCount));
      for (const l of still) await nothingResting(t, l.algo.id, l.algo.spec.symbol);
      await t.exec.algoAct('resume', v0.algo.id);
      await t.waitAlgo(v0.algo.id, 'the basket is done', done, { timeoutMs: 3 * MIN });
      for (const l of await legsOf()) await positionIs(t, sign(l.algo.spec.side) * l.algo.filled, `leg ${l.algo.spec.symbol}`, l.algo.spec.symbol);
    },
  }),

  /* =========================================================== Fill fast ===== */
  mx('sweep.references', 'sweep', 'Fill fast from the oracle fair price (all venues), SoDEX\'s mark, its index, and the oracle mid of two venues (buy, sell, buy, sell)', 'each reference prices real IOC rounds that fill on SoDEX inside the band; the position nets out', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const runs = [['oracleFair', 'buy', undefined], ['mark', 'sell', undefined], ['index', 'buy', undefined], ['oracleMid', 'sell', ['binanceFutures', 'okx']]] as const;
      let net = 0;
      for (const [reference, side, venues] of runs) {
        const v0 = await t.start({ kind: 'sweep', side, quantity: await t.qty(t.U), reference, ...(venues ? { venues } : {}), slippageBps: 20, roundMs: 1_000, timeoutMs: 20_000 });
        const v = await t.waitEnded(v0.algo.id, 45_000);
        if (v.algo.status !== 'done') throw new Inconclusive(`SoDEX's book was more than 20 bp from the ${reference} (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
        t.check(v.algo.children.every((c) => c.tif === 'ioc'), `${reference}: IOC rounds`);
        await filledAsBooked(t, v);
        net += sign(side) * v.algo.filled;
      }
      await positionIs(t, net, 'after the four');
    },
  }),

  /* ===================================================== lifecycle, practice ===== */
  mx('lifecycle.pause-resting', 'lifecycle', 'An iceberg at a fixed price and a chase stalking 30 bp behind, paused, changed, resumed, cancelled', 'pause pulls both from SoDEX, resume puts them back; a label and limit change land while paused; cancel leaves nothing', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const q = await t.quote();
      const ice = await t.start({ kind: 'iceberg', quantity: await t.qty(2 * t.U), displayQty: await t.qty(t.U), price: t.tick(q.bid * 0.993, t.main.name, 'down'), postOnly: true });
      const ch = await t.start({ kind: 'chase', quantity: await t.qty(t.U), offsetBps: 30 });
      for (const a of [ice, ch]) await resting(t, a.algo.id, 1, `${a.algo.spec.kind} rests`);
      for (const a of [ice, ch]) await t.exec.algoAct('pause', a.algo.id);
      for (const a of [ice, ch]) {
        await t.waitAlgo(a.algo.id, `${a.algo.spec.kind} is paused`, (v) => v.algo.status === 'paused', { timeoutMs: 15_000 });
        await nothingResting(t, a.algo.id);
      }
      await t.exec.algoUpdate(ice.algo.id, { label: 'mx paused', limitPrice: t.tick(q.ask * 1.01, t.main.name, 'up') });
      for (const a of [ice, ch]) await t.exec.algoAct('resume', a.algo.id);
      for (const a of [ice, ch]) await resting(t, a.algo.id, 1, `${a.algo.spec.kind} rests again`);
      t.check((await t.view(ice.algo.id)).algo.spec.label === 'mx paused', 'the change made while paused stays');
      for (const a of [ice, ch]) await t.exec.algoAct('cancel', a.algo.id);
      for (const a of [ice, ch]) await nothingResting(t, a.algo.id);
    },
  }),
  mx('lifecycle.limit-update', 'lifecycle', 'A TWAP held by its limit price, the limit raised while it runs', 'nothing past the old limit reaches SoDEX; the raised limit lets the same TWAP fill', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const low = t.tick(q.bid * 0.995, t.main.name, 'down');
      const v0 = await t.start({ kind: 'twap', quantity: await t.qty(t.U), durationMs: 2 * MIN, slices: 1, limitPrice: low, maxSpreadBps: 200, exec: { style: 'taker', slippageBps: 20 } });
      await t.waitAlgo(v0.algo.id, 'it waits under its limit', (v) => v.algo.status === 'waiting' || (v.algo.status === 'running' && v.algo.filled === 0), { timeoutMs: 30_000 });
      t.check((await t.view(v0.algo.id)).algo.children.every((c) => c.price <= low), 'nothing priced past the limit');
      const high = t.tick((await t.quote()).ask * 1.005, t.main.name, 'up');
      await t.exec.algoUpdate(v0.algo.id, { limitPrice: high, maxSpreadBps: 300 });
      const v = await t.waitAlgo(v0.algo.id, 'it fills under the raised limit', done, { timeoutMs: 90_000 });
      t.check(v.algo.children.every((c) => c.price <= high), 'under the new limit');
      await filledAsBooked(t, v);
    },
  }),
  mx('lifecycle.practice-beside-live', 'lifecycle', 'A practice (paper) TWAP and a live one side by side on the same market, then cancel all', 'the practice run sends nothing to SoDEX while the live one fills there; one cancel-all ends both', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const paper = await startPaper(t, { kind: 'twap', quantity: await t.qty(t.U), durationMs: MIN, slices: 1, exec: { style: 'taker', slippageBps: 20 } });
      const live = await t.start({ kind: 'twap', quantity: await t.qty(t.U), durationMs: MIN, slices: 1, exec: { style: 'taker', slippageBps: 20 } });
      t.check(paper.algo.spec.paper === true, 'the practice run is paper');
      const p = await t.waitAlgo(paper.algo.id, 'the practice TWAP is done on paper', done, { timeoutMs: 60_000 });
      const l = await t.waitAlgo(live.algo.id, 'the TWAP is done', done, { timeoutMs: 60_000 });
      await t.live('SoDEX holds no order and no fill of the practice run', async () => {
        const pre = algoPrefix(p.algo.id);
        t.check((await t.account.history(t.main.name)).every((o) => !o.clOrdID?.startsWith(pre)), 'no order of it in SoDEX\'s history');
        t.check((await t.account.fills(t.main.name)).every((f) => !f.clOrdID?.startsWith(pre)), 'no fill of it');
        await positionIs(t, l.algo.filled, 'the position is the live run\'s alone');
      });
      await t.exec.algoAct('cancel-all');
      for (const x of [p, l]) t.check(ended(await t.view(x.algo.id)), `${x.algo.id} ended`);
    },
  }),
];

/** A spec's field by name (the views' specs are a union). */
function field(spec: unknown, key: string): string {
  return String((spec as Record<string, unknown>)[key] ?? 'Infinity');
}
