/**
 * Algo orders on a real exchange: every kind, and what SoDEX alone can show -
 * real fills and their fees, post-only orders resting (and refused through the
 * book), SoDEX's minimum order value, its position stops as exits (placed,
 * resized, one cancelled when the other fills), the leverage it sets,
 * reduce-only never flipping a position, cancels that leave nothing on the
 * book, and an executor killed mid-order that comes back with no duplicate
 * order and its resting orders still tracked.
 *
 * Sizes are in U: SoDEX's minimum order value plus headroom (about $12), so
 * every child is just big enough. Each scenario ends with the runner's
 * cleanup, which leaves the follower flat.
 */
import type { AlgoView } from '../../../../../packages/copy-engine/src/index.ts';
import { Inconclusive, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/algos.ts';
const MIN = 60_000;

const done = (v: AlgoView) => v.algo.status === 'done';
const ended = (v: AlgoView) => ['done', 'cancelled', 'expired', 'failed'].includes(v.algo.status);
const stepOf = (t: T) => Number(t.main.stepSize);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-12;

function algo(id: string, kind: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run' | 'timeoutMs'>): Scenario {
  return { id, section: 'algo', kind, title, confirms, deps: ['algo'], source: SOURCE, dry: 'full', ...o };
}

/** The algo ended done with its whole quantity, and SoDEX's own fills add up to what the executor booked. */
async function filledAsBooked(t: T, v: AlgoView, symbol = t.main.name): Promise<void> {
  const fills = await t.algoFills(v.algo.id, symbol);
  const sum = fills.reduce((x, f) => x + f.qty, 0);
  t.check(near(sum, v.algo.filled, stepOf(t) / 2), `the fills ${t.where} reports (${sum}) add up to what the executor booked (${v.algo.filled})`);
  // A DCA (and a basket) is sized in USD: its target in base units is only an estimate at today's price.
  const fixedSize = v.algo.spec.kind !== 'dca' && v.algo.spec.kind !== 'basket';
  if (fixedSize && v.target !== null && v.algo.status === 'done') t.check(near(v.algo.filled, v.target, stepOf(t) / 2), `filled ${v.algo.filled} = the target ${v.target}`);
}

/** Nothing of the algo is left resting on SoDEX (children and exits). */
async function nothingResting(t: T, id: string, symbol = t.main.name): Promise<void> {
  await t.waitFor(`nothing of ${id} rests on ${t.where}`, async () => ((await t.algoOrders(id, symbol)).length === 0 ? true : null), { timeoutMs: 20_000 });
}

/** The follower's position equals what the algo filled (signed). */
async function positionIs(t: T, want: number, what: string, symbol = t.main.name): Promise<void> {
  await t.waitFor(`${what}: the follower's position is ${want}`, async () => (near(await t.account.position(symbol), want, stepOf(t) / 2) ? true : null), { timeoutMs: 20_000 });
}

const sign = (side: string) => (side === 'sell' ? -1 : 1);

export const ALGO_SCENARIOS: Scenario[] = [
  /* ------------------------------------------------------------------ TWAP ----- */
  algo('twap.taker-buy', 'twap', 'TWAP buy, taker slices', 'real IOC fills slice by slice, the builder fee on every child and fill, the position SoDEX holds', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 6 * U, makerUsd: 0, peakUsd: 3 * U }),
    async run(t) {
      const qty = await t.qty(3 * t.U);
      const v0 = await t.start({ kind: 'twap', quantity: qty, durationMs: MIN, slices: 3, exec: { style: 'taker', slippageBps: 20 } });
      const v = await t.waitAlgo(v0.algo.id, 'the TWAP is done', done, { timeoutMs: 3 * MIN });
      await filledAsBooked(t, v);
      await nothingResting(t, v.algo.id);
      await positionIs(t, v.algo.filled, 'after the TWAP');
      t.check(v.algo.children.every((c) => c.tif === 'ioc'), 'every slice went out as an IOC');
      await t.live('every child order carried the builder at 2.5 bp', async () => {
        const mine = (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith(`va-${v.algo.id.slice(1, 13)}-`));
        t.check(mine.length >= 3, `SoDEX lists the ${mine.length} slices`);
        t.check(mine.every((o) => o.builderFee === 25), 'each order names the builder fee 25 (2.5 bp)', mine.map((o) => o.builderFee));
      });
      await t.checkBuilderFee(await t.algoFills(v.algo.id));
    },
  }),
  algo('twap.maker-sell', 'twap', 'TWAP sell, maker (post-only) slices, the rest taken at the end', 'GTX children rest and fill as maker (never take); only the finish takes', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 3 * U, makerUsd: 2 * U, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'twap', side: 'sell', quantity: await t.qty(2 * t.U), durationMs: MIN, slices: 2, exec: { style: 'maker', chaseTicks: 1 }, finish: 'take' });
      const v = await t.waitAlgo(v0.algo.id, 'the maker TWAP is done', done, { timeoutMs: 3 * MIN });
      await filledAsBooked(t, v);
      t.check(v.algo.children.filter((c) => c.tag !== 'finish').every((c) => c.tif === 'gtx'), 'every slice before the finish was post-only (GTX)');
      await t.live('every fill of a post-only child was a maker fill', async () => {
        const hist = await t.account.history(t.main.name);
        const gtx = new Set(hist.filter((o) => o.tif === 'GTX').map((o) => o.orderId));
        const fills = await t.algoFills(v.algo.id);
        const onGtx = fills.filter((f) => gtx.has(f.orderId));
        t.check(onGtx.every((f) => f.maker), `${onGtx.length} fill(s) on GTX orders, all maker`);
        t.note(`${onGtx.length} maker fill(s), ${fills.length - onGtx.length} taker fill(s) at the finish`);
      });
      await positionIs(t, -v.algo.filled, 'after the maker TWAP');
    },
  }),
  algo('twap.cancel-midway', 'twap', 'TWAP cancelled mid-way (hybrid slices resting)', 'a cancel pulls the resting child from SoDEX at once; what filled stays as the position', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: U, peakUsd: 4 * U }),
    async run(t) {
      const qty = await t.qty(4 * t.U);
      const v0 = await t.start({ kind: 'twap', quantity: qty, durationMs: 2 * MIN, slices: 4, exec: { style: 'hybrid', makerShare: 0.5, slippageBps: 20 } });
      await t.waitAlgo(v0.algo.id, 'the first slice filled', (v) => v.algo.filled > 0, { timeoutMs: 100_000 });
      await t.exec.algoAct('cancel', v0.algo.id);
      const v = await t.waitAlgo(v0.algo.id, 'the TWAP is cancelled', (x) => x.algo.status === 'cancelled', { timeoutMs: 20_000 });
      await nothingResting(t, v.algo.id);
      t.check(v.algo.filled < Number(qty), `it stopped short: ${v.algo.filled} of ${qty}`);
      await filledAsBooked(t, v);
      await positionIs(t, v.algo.filled, 'after the cancel');
    },
  }),
  algo('twap.pause-resume', 'twap', 'TWAP paused and resumed', 'nothing is sent while paused (resting children pulled); after resume it completes to the exact quantity', {
    timeoutMs: 6 * MIN,
    cost: (U) => ({ takerUsd: 6 * U, makerUsd: 0, peakUsd: 3 * U }),
    async run(t) {
      const qty = await t.qty(3 * t.U);
      const v0 = await t.start({ kind: 'twap', quantity: qty, durationMs: 90_000, slices: 3, exec: { style: 'taker', slippageBps: 20 } });
      await t.waitAlgo(v0.algo.id, 'the first slice filled', (v) => v.algo.filled > 0, { timeoutMs: 90_000 });
      await t.exec.algoAct('pause', v0.algo.id);
      const p = await t.waitAlgo(v0.algo.id, 'the TWAP is paused', (v) => v.algo.status === 'paused', { timeoutMs: 15_000 });
      await nothingResting(t, v0.algo.id);
      await t.sleep(40_000);
      const still = await t.view(v0.algo.id);
      t.check(near(still.algo.filled, p.algo.filled, 1e-12), `nothing filled while paused (${p.algo.filled} -> ${still.algo.filled})`);
      await t.exec.algoAct('resume', v0.algo.id);
      const v = await t.waitAlgo(v0.algo.id, 'the TWAP completes after resume', done, { timeoutMs: 3 * MIN });
      await filledAsBooked(t, v);
    },
  }),
  algo('twap.close-reduce-only', 'twap', 'TWAP close of a position (time-sliced, reduce-only)', 'reduce-only children close the position SoDEX holds and never flip it', {
    timeoutMs: 4 * MIN,
    dry: 'spec',
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const pos = await t.openPosition('buy', 2 * t.U);
      const v0 = await t.start({ kind: 'twap', side: 'sell', closeShare: 1, durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 30 } });
      const v = await t.waitEnded(v0.algo.id, 3 * MIN);
      if (t.dry) {
        t.check(ended(v), `on paper there is no position to close: it ended ${v.algo.status}`);
        return;
      }
      t.check(v.algo.status === 'done', `the close is done (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      t.check(near(v.algo.filled, pos, stepOf(t) / 2), `it sold exactly the position (${v.algo.filled} of ${pos})`);
      await positionIs(t, 0, 'after the close');
      t.check(v.algo.children.every((c) => c.reduceOnly), 'every child was reduce-only');
    },
  }),
  algo('twap.exits', 'twap', 'TWAP with take-profit and stop-loss exits', 'SoDEX position stops placed after the first fill, resized to the full fill, pulled by a cancel of the ended algo', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'twap', quantity: await t.qty(2 * t.U), durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 20 }, exits: { tpPct: 0.02, slPct: 0.02 } });
      const id = v0.algo.id;
      const first = await t.waitAlgo(id, 'the first slice filled', (v) => v.algo.filled > 0, { timeoutMs: 60_000 });
      await t.waitFor(`two exits rest on ${t.where}, sized to what filled`, async () => {
        const stops = (await t.algoOrders(id)).filter((o) => o.stop);
        return stops.length === 2 && stops.every((s) => near(s.qty, first.algo.filled, stepOf(t) / 2) || s.qty >= first.algo.filled) ? stops : null;
      }, { timeoutMs: 45_000 });
      const v = await t.waitAlgo(id, 'the TWAP is done', done, { timeoutMs: 2 * MIN });
      const stops = await t.waitFor('the exits are resized to the whole fill', async () => {
        const s = (await t.algoOrders(id)).filter((o) => o.stop);
        return s.length === 2 && s.every((x) => near(x.qty, v.algo.filled, stepOf(t) / 2)) ? s : null;
      }, { timeoutMs: 45_000 });
      const avg = v.algo.filledValue / v.algo.filled;
      const tp = stops.find((s) => s.stop!.kind === 'tp')!;
      const sl = stops.find((s) => s.stop!.kind === 'sl')!;
      t.check(near(tp.stop!.trigger, avg * 1.02, avg * 0.001), `the take-profit triggers at +2% of the average (${tp.stop!.trigger} vs ${avg})`);
      t.check(near(sl.stop!.trigger, avg * 0.98, avg * 0.001), `the stop-loss triggers at -2% (${sl.stop!.trigger})`);
      t.check(tp.reduceOnly && sl.reduceOnly && tp.side === 'sell' && sl.side === 'sell', 'both exits are reduce-only sells');
      await t.exec.algoAct('cancel', id);
      await nothingResting(t, id);
      await positionIs(t, v.algo.filled, 'cancelling the ended algo pulls its exits and leaves the position');
    },
  }),
  algo('twap.min-size', 'twap', 'TWAP at SoDEX\'s minimum order value, and one below it', 'children just over SoDEX\'s minNotional are accepted; an order too small ever to send ends failed with nothing sent', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 2 * 2 * 10.6, makerUsd: 0, peakUsd: 2 * 10.6 + 0 * U }),
    async run(t) {
      const q = await t.quote();
      const step = stepOf(t);
      const dec = (t.main.stepSize.split('.')[1] ?? '').length;
      const slice = Math.ceil((t.main.minNotional * 1.06) / q.bid / step) * step;
      const v0 = await t.start({ kind: 'twap', quantity: (2 * slice).toFixed(dec), durationMs: MIN, slices: 2, exec: { style: 'taker', slippageBps: 20 } });
      const v = await t.waitAlgo(v0.algo.id, 'the minimum-size TWAP is done', done, { timeoutMs: 3 * MIN });
      await filledAsBooked(t, v);
      t.check(v.algo.rejects === 0, `SoDEX refused none of its children (${v.algo.rejects})`);
      const tiny = await t.start({ kind: 'twap', quantity: (Math.ceil((t.main.minNotional * 0.6) / q.bid / step) * step).toFixed(dec), durationMs: MIN, slices: 1, exec: { style: 'taker', slippageBps: 20 } });
      const tv = await t.waitEnded(tiny.algo.id, 90_000);
      t.check(tv.algo.status === 'failed', `an order below the minimum ends failed (${tv.algo.status}: ${tv.algo.statusReason ?? ''})`);
      t.check(tv.algo.filled === 0 && tv.algo.childCount === 0, 'and nothing was sent for it');
    },
  }),
  algo('twap.limit-price', 'twap', 'TWAP with a limit price below the market', 'no child is sent past the limit while the real book is above it', {
    timeoutMs: 2 * MIN,
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0 }),
    async run(t) {
      const q = await t.quote();
      const limit = t.tick(q.bid * 0.995, t.main.name, 'down');
      const v0 = await t.start({ kind: 'twap', quantity: await t.qty(2 * t.U), durationMs: MIN, slices: 2, limitPrice: limit, exec: { style: 'taker', slippageBps: 20 }, finish: 'leave' });
      await t.sleep(35_000);
      const v = await t.view(v0.algo.id);
      t.check(v.algo.filled === 0, `nothing filled above the limit ${limit}`);
      t.check(v.algo.children.every((c) => c.price <= limit), 'no child was priced past the limit');
      t.check(v.algo.status === 'waiting' || v.algo.status === 'running', `it waits (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      await t.exec.algoAct('cancel', v0.algo.id);
      await t.waitEnded(v0.algo.id, 20_000);
      await nothingResting(t, v0.algo.id);
    },
  }),
  algo('twap.restart', 'twap', 'TWAP with the executor killed mid-schedule', 'after a hard kill and restart the schedule finishes to the exact quantity: no child sent twice, no overfill', {
    timeoutMs: 6 * MIN,
    cost: (U) => ({ takerUsd: 8 * U, makerUsd: 0, peakUsd: 4 * U }),
    async run(t) {
      const qty = await t.qty(4 * t.U);
      const v0 = await t.start({ kind: 'twap', quantity: qty, durationMs: 80_000, slices: 4, exec: { style: 'taker', slippageBps: 20 } });
      await t.waitAlgo(v0.algo.id, 'the first slice filled', (v) => v.algo.filled > 0, { timeoutMs: 60_000 });
      await t.restart({ downMs: 10_000 });
      const v = await t.waitAlgo(v0.algo.id, 'the TWAP is done after the restart', done, { timeoutMs: 4 * MIN });
      t.check(v.algo.filled <= Number(qty) + stepOf(t) / 2, `no overfill (${v.algo.filled} of ${qty})`);
      await filledAsBooked(t, v);
      await t.live('SoDEX saw every client order id once', async () => {
        const mine = (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith(`va-${v.algo.id.slice(1, 13)}-`));
        const ids = mine.map((o) => o.clOrdID);
        t.check(new Set(ids).size === ids.length, `${ids.length} orders, all distinct`);
      });
      await positionIs(t, v.algo.filled, 'after the restart');
    },
  }),
  algo('twap.size-change', 'twap', 'TWAP size lowered and raised while running', 'lowered under what rests, the resting child is pulled and sent again at the new size; raised mid-schedule, the rest is spread over the slices to come and it ends filled at the new size', {
    timeoutMs: 6 * MIN,
    cost: (U) => ({ takerUsd: 3 * U, makerUsd: 0, peakUsd: 3 * U }),
    async run(t) {
      // 1. Lowered: one post-only child rests far under the market (a limit 3% below), 3U; lowered to 2U it is pulled and sent again as 2U.
      const q = await t.quote();
      const limit = t.tick(q.bid * 0.97, t.main.name, 'down');
      const r0 = await t.start({ kind: 'twap', quantity: await t.qty(3 * t.U), durationMs: 10 * MIN, slices: 1, limitPrice: limit, exec: { style: 'maker' }, finish: 'leave' });
      const id = r0.algo.id;
      const first = await t.waitFor('one child rests on SoDEX', async () => {
        const o = await t.algoOrders(id);
        return o.length === 1 ? o[0]! : null;
      }, { timeoutMs: 60_000 });
      await t.live('lowered, the resting child is pulled and sent again at the new size', async () => {
        const lower = await t.qty(2 * t.U);
        await t.exec.algoUpdate(id, { quantity: lower });
        const again = await t.waitFor('a new child of the lower size rests', async () => {
          const o = await t.algoOrders(id);
          return o.length === 1 && o[0]!.orderId !== first.orderId ? o[0]! : null;
        }, { timeoutMs: 60_000 });
        t.check(near(again.qty, Number(lower), stepOf(t) / 2), `the child rests for ${again.qty} (${lower} asked)`);
        t.check(again.price <= limit, `still at or under the limit ${limit} (${again.price})`);
        const v = await t.exec.algo(id);
        t.check(v.target !== null && near(v.target, Number(lower), stepOf(t) / 2), `the executor's target is ${lower}`);
        // Raised under what filled is refused: nothing filled here, so a size of 0 is the one to try.
        const refused = await t.exec.algoUpdate(id, { quantity: '0' }).then(() => false, () => true);
        t.check(refused, 'a size of 0 is refused');
      });
      await t.exec.algoAct('cancel', id);
      await t.waitEnded(id, 20_000);
      await nothingResting(t, id);

      // 2. Raised: a taker TWAP of 2U in 2 slices, raised to 3U after its first fill, ends done with 3U.
      const v0 = await t.start({ kind: 'twap', quantity: await t.qty(2 * t.U), durationMs: 2 * MIN, slices: 2, exec: { style: 'taker', slippageBps: 20 } });
      await t.waitAlgo(v0.algo.id, 'the first slice filled', (v) => v.algo.filled > 0, { timeoutMs: 2 * MIN });
      const more = await t.qty(3 * t.U);
      await t.exec.algoUpdate(v0.algo.id, { quantity: more });
      const v = await t.waitAlgo(v0.algo.id, 'the TWAP is done', done, { timeoutMs: 3 * MIN });
      await t.live('raised, it fills the new size', async () => {
        t.check(near(v.algo.filled, Number(more), stepOf(t) / 2), `filled ${v.algo.filled} = the new size ${more}`);
        await filledAsBooked(t, v);
      });
      await positionIs(t, v.algo.filled, 'after the raise');
    },
  }),

  /* ------------------------------------------------------------------ VWAP ----- */
  algo('vwap.cancel-midway', 'vwap', 'VWAP (15 min) cancelled after its first fills', 'the volume profile from SoDEX\'s own candles schedules real children; a cancel leaves nothing', {
    timeoutMs: 12 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: 3 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'vwap', quantity: await t.qty(3 * t.U), durationMs: 15 * MIN, slices: 15, lookbackDays: 7, adaptive: true, exec: { style: 'taker', slippageBps: 20 } });
      await t.waitAlgo(v0.algo.id, 'the VWAP filled its first child', (v) => v.algo.filled > 0, { timeoutMs: 10 * MIN });
      await t.exec.algoAct('cancel', v0.algo.id);
      const v = await t.waitEnded(v0.algo.id, 20_000);
      t.check(v.algo.status === 'cancelled', 'cancelled');
      await nothingResting(t, v.algo.id);
      await filledAsBooked(t, v);
      await positionIs(t, v.algo.filled, 'after the VWAP');
    },
  }),
  algo('vwap.full', 'vwap', 'VWAP run to the end (15 min)', 'a whole VWAP schedule on the real market ends with the exact quantity', {
    slow: true,
    timeoutMs: 20 * MIN,
    cost: (U) => ({ takerUsd: 6 * U, makerUsd: 0, peakUsd: 3 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'vwap', quantity: await t.qty(3 * t.U), durationMs: 15 * MIN, slices: 15, lookbackDays: 7, exec: { style: 'taker', slippageBps: 20 } });
      const v = await t.waitAlgo(v0.algo.id, 'the VWAP is done', done, { timeoutMs: 18 * MIN });
      await filledAsBooked(t, v);
    },
  }),

  /* ------------------------------------------------------------------- POV ----- */
  algo('pov.buy', 'pov', 'POV 10% of the market\'s volume', 'children follow what the real tape prints, to the exact quantity', {
    timeoutMs: 12 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'pov', quantity: await t.qty(2 * t.U), rate: 0.1, exec: { style: 'taker', slippageBps: 20 } });
      const v = await t.waitAlgo(v0.algo.id, 'the POV is done', done, { timeoutMs: 10 * MIN, inconclusive: true });
      await filledAsBooked(t, v);
      t.check(v.algo.marketQty > 0, `it measured the market's own volume (${v.algo.marketQty})`);
    },
  }),

  /* --------------------------------------------------------------- Iceberg ----- */
  algo('iceberg.pegged-buy', 'iceberg', 'Iceberg, post-only clips pegged to the bid', 'one clip visible at a time, every clip GTX filled as maker', {
    timeoutMs: 17 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 2 * U, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'iceberg', quantity: await t.qty(2 * t.U), displayQty: await t.qty(t.U), postOnly: true, chaseTicks: 2 });
      let most = 0;
      const v = await t.waitFor('the iceberg is done', async () => {
        most = Math.max(most, (await t.algoOrders(v0.algo.id)).length);
        const x = await t.view(v0.algo.id);
        return done(x) ? x : null;
      }, { timeoutMs: 15 * MIN, everyMs: 2_500, inconclusive: true });
      t.check(most <= 1, `at most one clip rested at a time (${most})`);
      t.check(v.algo.children.every((c) => c.tif === 'gtx'), 'every clip was post-only');
      await filledAsBooked(t, v);
      await t.live('every clip filled as maker', async () => {
        const f = await t.algoFills(v.algo.id);
        t.check(f.every((x) => x.maker), `${f.length} fill(s), all maker`);
      });
    },
  }),
  algo('iceberg.restart', 'iceberg', 'Iceberg resting away from the market, executor killed and restarted', 'the clip resting on SoDEX through the restart is the same order afterwards, tracked, not placed twice; a cancel pulls it', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'iceberg', side: 'sell', quantity: await t.qty(2 * t.U), displayQty: await t.qty(t.U), price: t.tick(q.ask * 1.01, t.main.name, 'up'), postOnly: true });
      const before = await t.waitFor(`one clip rests on ${t.where}`, async () => {
        const o = await t.algoOrders(v0.algo.id);
        return o.length === 1 ? o : null;
      }, { timeoutMs: 30_000 });
      await t.restart({ downMs: 5_000 });
      await t.sleep(15_000);
      const after = await t.algoOrders(v0.algo.id);
      t.check(after.length === 1 && after[0]!.clOrdID === before[0]!.clOrdID, 'the same single clip rests after the restart', after.map((o) => o.clOrdID));
      const v = await t.view(v0.algo.id);
      t.check(v.algo.children.some((c) => c.clOrdID === before[0]!.clOrdID && (c.state === 'open' || c.state === 'unknown')), 'the executor still tracks it');
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),

  /* ----------------------------------------------------------------- Chase ----- */
  algo('chase.sell-take', 'chase', 'Chase sell, take at the end', 'a post-only order follows the real best price; whatever is left is taken when the cap or the time is reached', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: U, peakUsd: U }),
    async run(t) {
      const v0 = await t.start({ kind: 'chase', side: 'sell', quantity: await t.qty(t.U), maxChaseBps: 20, timeoutMs: MIN, onEnd: 'take' });
      const v = await t.waitAlgo(v0.algo.id, 'the chase is done', done, { timeoutMs: 2 * MIN });
      await filledAsBooked(t, v);
      t.check(v.algo.children.filter((c) => c.tif !== 'ioc').every((c) => c.tif === 'gtx'), 'every resting child was post-only');
      await positionIs(t, -v.algo.filled, 'after the chase');
    },
  }),
  algo('chase.cancel', 'chase', 'Chase stalking 50 bp behind, cancelled at the time limit', 'onEnd cancel leaves nothing on SoDEX and nothing filled', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const v0 = await t.start({ kind: 'chase', quantity: await t.qty(t.U), offsetBps: 50, timeoutMs: 20_000, onEnd: 'cancel' });
      const v = await t.waitEnded(v0.algo.id, 60_000);
      if (v.algo.filled > 0) throw new Inconclusive('the market fell 50 bp within 20 s and the stalking order filled');
      t.check(['cancelled', 'expired'].includes(v.algo.status), `it ended ${v.algo.status}`);
      await nothingResting(t, v.algo.id);
    },
  }),

  /* ----------------------------------------------------------------- Scale ----- */
  algo('scale.ladder-cancel', 'scale', 'Scale ladder of 4 post-only levels below the market, cancelled', 'every level rests on SoDEX at exactly the price planned (tick-snapped, inside the range); a cancel pulls them all', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 4 * U }),
    async run(t) {
      const q = await t.quote();
      const from = t.tick(q.bid * 0.995, t.main.name, 'down');
      const to = t.tick(q.bid * 0.985, t.main.name, 'down');
      const v0 = await t.start({ kind: 'scale', quantity: await t.qty(4.2 * t.U), from, to, orders: 4, distribution: 'flat', spacing: 'linear', postOnly: true });
      const rest = await t.waitFor(`4 levels rest on ${t.where}`, async () => {
        const o = await t.algoOrders(v0.algo.id);
        return o.length === 4 ? o : null;
      }, { timeoutMs: 30_000 });
      const v = await t.view(v0.algo.id);
      const planned = v.algo.children.filter((c) => c.state !== 'done').map((c) => c.price).sort((a, b) => a - b);
      const onBook = rest.map((o) => o.price).sort((a, b) => a - b);
      t.check(JSON.stringify(planned) === JSON.stringify(onBook), `${t.where} holds exactly the planned prices`, { planned, onBook });
      t.check(onBook.every((p) => p >= to - Number(t.main.tickSize) && p <= from + Number(t.main.tickSize)), `every level is inside ${to}..${from}`);
      await t.live('every level is post-only (GTX)', async () => t.check(rest.every((o) => o.tif === 'GTX'), 'GTX', rest.map((o) => o.tif)));
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),
  algo('scale.dca-ladder-pause', 'scale', 'The ticket\'s DCA ladder (explicit levels, growing sizes), paused and resumed', 'the ladder\'s sizes rest in proportion; pause pulls every level from SoDEX, resume puts each back', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 5 * U }),
    async run(t) {
      const q = await t.quote();
      const prices = [0.996, 0.992, 0.988].map((f) => t.tick(q.bid * f, t.main.name, 'down'));
      const weights = [1, 1.5, 2.25];
      const v0 = await t.start({ kind: 'scale', quantity: await t.qty(4.75 * t.U * 1.05), from: prices[0], to: prices[2], orders: 3, prices, weights, postOnly: true });
      const rest = await t.waitFor('3 levels rest', async () => {
        const o = await t.algoOrders(v0.algo.id);
        return o.length === 3 ? o : null;
      }, { timeoutMs: 30_000 });
      const by = [...rest].sort((a, b) => b.price - a.price);
      t.check(by[1]!.qty / by[0]!.qty > 1.3 && by[2]!.qty / by[1]!.qty > 1.3, 'each level is about 1.5x the one before', by.map((o) => o.qty));
      await t.exec.algoAct('pause', v0.algo.id);
      await nothingResting(t, v0.algo.id);
      await t.exec.algoAct('resume', v0.algo.id);
      const back = await t.waitFor('the 3 levels rest again after resume', async () => {
        const o = await t.algoOrders(v0.algo.id);
        return o.length === 3 ? o : null;
      }, { timeoutMs: 30_000 });
      t.check(JSON.stringify(back.map((o) => o.price).sort()) === JSON.stringify(rest.map((o) => o.price).sort()), 'at the same prices');
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),
  algo('scale.partial-fill', 'scale', 'Scale ladder with one level through the book: a partial fill', 'the crossing level fills at once, the other rests; filled is exactly the one level; a cancel keeps the position', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const q = await t.quote();
      const prices = [t.tick(q.ask * 1.0005, t.main.name, 'up'), t.tick(q.bid * 0.99, t.main.name, 'down')];
      const v0 = await t.start({ kind: 'scale', quantity: await t.qty(2.1 * t.U), from: prices[0], to: prices[1], orders: 2, prices, weights: [1, 1], postOnly: false });
      const part = await t.waitAlgo(v0.algo.id, 'the crossing level filled', (v) => v.algo.filled > 0, { timeoutMs: 30_000 });
      const rest = await t.waitFor('the other level rests', async () => {
        const o = await t.algoOrders(v0.algo.id);
        return o.length === 1 ? o : null;
      }, { timeoutMs: 20_000 });
      t.check(near(part.algo.filled + rest[0]!.qty, Number(part.algo.spec.kind === 'scale' ? part.algo.spec.quantity : 0), stepOf(t)), `filled ${part.algo.filled} + resting ${rest[0]!.qty} = the ladder`);
      t.check(part.algo.status !== 'done', `a part-filled ladder is still working (${part.algo.status})`);
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
      const v = await t.view(v0.algo.id);
      await filledAsBooked(t, v);
      await positionIs(t, v.algo.filled, 'the filled level stays as the position');
    },
  }),
  algo('scale.restart', 'scale', 'Scale ladder resting, executor killed and restarted', 'the resting levels survive the restart on SoDEX, the executor tracks them, and none is placed twice', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 3 * U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'scale', quantity: await t.qty(3.2 * t.U), from: t.tick(q.bid * 0.99, t.main.name, 'down'), to: t.tick(q.bid * 0.98, t.main.name, 'down'), orders: 3, postOnly: true });
      const before = await t.waitFor('3 levels rest', async () => {
        const o = await t.algoOrders(v0.algo.id);
        return o.length === 3 ? o : null;
      }, { timeoutMs: 30_000 });
      await t.restart({ downMs: 5_000 });
      await t.sleep(15_000);
      const after = await t.algoOrders(v0.algo.id);
      const ids = (x: typeof after) => x.map((o) => o.clOrdID).sort().join(',');
      t.check(ids(after) === ids(before), 'the same 3 orders rest after the restart, none added', { before: ids(before), after: ids(after) });
      const v = await t.view(v0.algo.id);
      t.check(v.algo.children.filter((c) => c.state === 'open' || c.state === 'unknown').length === 3, 'the executor tracks all 3');
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),

  /* ------------------------------------------------------------------- DCA ----- */
  algo('dca.taker', 'dca', 'DCA, 2 orders a minute apart', 'each order spends its USD amount on the real market', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'dca', perOrderUsd: t.U, orders: 2, intervalMs: MIN, exec: { style: 'taker', slippageBps: 20 } });
      const v = await t.waitAlgo(v0.algo.id, 'the DCA is done', done, { timeoutMs: 3 * MIN });
      t.check(near(v.algo.filledValue, 2 * t.U, 0.15 * 2 * t.U), `it spent about $${2 * t.U} ($${v.algo.filledValue.toFixed(2)})`);
      await filledAsBooked(t, v);
    },
  }),
  algo('dca.limit-skip', 'dca', 'DCA with a limit price below the market (outside: skip)', 'every order outside the limit is skipped: nothing is sent', {
    timeoutMs: 4 * MIN,
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0 }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'dca', perOrderUsd: t.U, orders: 2, intervalMs: MIN, limitPrice: t.tick(q.bid * 0.99, t.main.name, 'down'), outOfBand: 'skip', exec: { style: 'taker', slippageBps: 20 } });
      const v = await t.waitEnded(v0.algo.id, 3 * MIN);
      t.check(v.algo.filled === 0, 'nothing filled');
      t.check(v.algo.childCount === 0, `nothing was sent (${v.algo.childCount} children)`);
    },
  }),

  /* ----------------------------------------------------------------- Swarm ----- */
  algo('swarm.sell', 'swarm', 'Swarm sell, 3 clips in waves of 2', 'many small IOC takers fill the whole size', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 6 * U, makerUsd: 0, peakUsd: 3 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'swarm', side: 'sell', quantity: await t.qty(3 * t.U), clips: 3, inFlight: 2, waveMs: 2_000, slippageBps: 20 });
      const v = await t.waitAlgo(v0.algo.id, 'the swarm is done', done, { timeoutMs: 2 * MIN });
      await filledAsBooked(t, v);
      t.check(v.algo.childCount >= 3, `${v.algo.childCount} clips`);
      await positionIs(t, -v.algo.filled, 'after the swarm');
    },
  }),

  /* ----------------------------------------------------------- Conditional ----- */
  algo('conditional.market', 'conditional', 'Conditional (spread and funding) then a market order', 'conditions on SoDEX\'s live spread and funding hold, and the market order fills', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const sym = t.main.name;
      const v0 = await t.start({ kind: 'conditional', conditions: [{ type: 'spread', symbol: sym, op: 'below', bps: 50 }, { type: 'funding', symbol: sym, op: 'below', value: 1 }], holdMs: 2_000, then: { type: 'market', quantity: await t.qty(t.U), slippageBps: 20 } });
      const v = await t.waitAlgo(v0.algo.id, 'the conditional fired and filled', done, { timeoutMs: 90_000 });
      await filledAsBooked(t, v);
    },
  }),
  algo('conditional.postonly-refused', 'conditional', 'Conditional then a post-only limit through the book', 'SoDEX refuses (or at once cancels) a post-only order that would take: nothing fills, nothing rests', {
    timeoutMs: 2 * MIN,
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0 }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'conditional', conditions: [{ type: 'spread', symbol: t.main.name, op: 'below', bps: 50 }], then: { type: 'limit', quantity: await t.qty(t.U), price: t.tick(q.ask * 1.002, t.main.name, 'up'), postOnly: true } });
      const v = await t.waitEnded(v0.algo.id, 60_000);
      await t.sleep(5_000);
      await nothingResting(t, v.algo.id);
      await t.live('SoDEX did not fill the post-only order', async () => {
        t.check(v.algo.filled === 0, `nothing filled (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
        t.check(v.algo.status === 'failed' || v.algo.status === 'done', `it ended ${v.algo.status}`);
        const mine = (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith(`va-${v.algo.id.slice(1, 13)}-`));
        t.check(mine.every((o) => o.filled === 0), 'SoDEX\'s history shows no fill on it', mine.map((o) => o.status));
        t.note(`SoDEX: ${mine.map((o) => `${o.tif} ${o.status}`).join(', ') || 'refused in the batch answer'}`);
        await positionIs(t, 0, 'after the refused order');
      });
    },
  }),
  algo('conditional.close', 'conditional', 'Conditional on your own position, then close it', 'the position read from SoDEX triggers it, and a reduce-only close leaves it flat', {
    timeoutMs: 2 * MIN,
    dry: 'spec',
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U }),
    async run(t) {
      await t.openPosition('buy', 2 * t.U);
      const v0 = await t.start({ kind: 'conditional', side: 'sell', conditions: [{ type: 'position', symbol: t.main.name, op: 'long' }], then: { type: 'close', share: 1, slippageBps: 30 } });
      if (t.dry) {
        await t.sleep(10_000);
        t.check((await t.view(v0.algo.id)).algo.filled === 0, 'on paper the follower holds no position: it waits');
        await t.exec.algoAct('cancel', v0.algo.id);
        return;
      }
      const v = await t.waitEnded(v0.algo.id, 90_000);
      t.check(v.algo.status === 'done', `done (${v.algo.statusReason ?? ''})`);
      await positionIs(t, 0, 'after the conditional close');
    },
  }),
  algo('conditional.algo-bracket', 'conditional', 'Conditional that starts a Chase with exits', 'the started algo fills and its OCO exits rest on SoDEX as position stops', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: U, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({
        kind: 'conditional',
        conditions: [{ type: 'price', symbol: t.main.name, source: 'mark', op: 'above', value: t.tick(q.mark * 0.99) }],
        then: { type: 'algo', algo: { kind: 'chase', symbol: t.main.name, side: 'buy', quantity: await t.qty(t.U), maxChaseBps: 20, timeoutMs: MIN, onEnd: 'take', exits: { tpPct: 0.02, slPct: 0.02 } } },
      });
      await t.waitAlgo(v0.algo.id, 'the conditional started its chase', done, { timeoutMs: 60_000 });
      const child = await t.waitFor('the chase it started is listed', async () => (await t.exec.algos()).find((x) => x.algo.parentId === v0.algo.id) ?? null, { timeoutMs: 20_000 });
      t.algos.push(child.algo.id);
      const c = await t.waitAlgo(child.algo.id, 'the chase is done', done, { timeoutMs: 2 * MIN });
      await filledAsBooked(t, c);
      await t.waitFor(`its two exits rest on ${t.where}`, async () => ((await t.algoOrders(c.algo.id)).filter((o) => o.stop).length === 2 ? true : null), { timeoutMs: 45_000 });
      await t.exec.algoAct('cancel', c.algo.id);
      await nothingResting(t, c.algo.id);
    },
  }),

  /* -------------------------------------------------------------- Trailing ----- */
  algo('trailing.position', 'trailing', 'Trailing stop (0.1%) on the whole position', 'it follows the real mark and closes the position reduce-only when the price turns', {
    timeoutMs: 17 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      await t.openPosition('buy', t.U);
      const v0 = await t.start(t.dry ? { kind: 'trailing', side: 'sell', quantity: await t.qty(t.U), trailPct: 0.001 } : { kind: 'trailing', side: 'sell', trailPct: 0.001 });
      const v = await t.waitEnded(v0.algo.id, 15 * MIN, true);
      t.check(v.algo.status === 'done', `it fired (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      if (!t.dry) {
        await positionIs(t, 0, 'after the trailing stop');
        t.check(v.algo.children.every((c) => c.reduceOnly), 'its exit was reduce-only');
      }
    },
  }),

  /* --------------------------------------------------------------- Bracket ----- */
  algo('bracket.tp-fires', 'bracket', 'Bracket: market entry, a take-profit 4 bp away', 'SoDEX fires the take-profit stop and the engine cancels the stop-loss (OCO): flat, nothing left', {
    timeoutMs: 13 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'bracket', quantity: await t.qty(t.U), entry: 'market', slippageBps: 30, exits: { tpPrice: t.tick(q.ask * 1.0004, t.main.name, 'up'), slPrice: t.tick(q.bid * 0.996, t.main.name, 'down') } });
      const v = await t.waitAlgo(v0.algo.id, 'the entry filled', (x) => x.algo.filled > 0, { timeoutMs: 30_000 });
      await t.waitFor(`take-profit and stop-loss rest on ${t.where}`, async () => ((await t.algoOrders(v.algo.id)).filter((o) => o.stop).length === 2 ? true : null), { timeoutMs: 45_000 });
      await t.waitFor('the take-profit filled and the stop-loss is gone', async () => {
        const x = await t.view(v.algo.id);
        const tp = x.exits?.find((e) => e.kind === 'tp');
        return tp && tp.filled > 0 && (await t.algoOrders(v.algo.id)).length === 0 ? x : null;
      }, { timeoutMs: 10 * MIN, everyMs: 3_000, inconclusive: true });
      await positionIs(t, 0, 'after the take-profit');
      await t.live('SoDEX\'s history: the take-profit filled, the stop-loss was cancelled', async () => {
        const mine = (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith(`va-${v.algo.id.slice(1, 13)}-`) && o.stop);
        t.check(mine.some((o) => o.stop!.kind === 'tp' && o.filled > 0), 'a filled TAKE_PROFIT', mine.map((o) => `${o.stop!.kind} ${o.status}`));
        t.check(mine.filter((o) => o.stop!.kind === 'sl').every((o) => o.filled === 0), 'the STOP_LOSS never filled');
      });
    },
  }),
  algo('bracket.limit-cancel', 'bracket', 'Bracket with a limit entry below the market, cancelled', 'no exit is placed before anything fills; a cancel pulls the resting entry', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const q = await t.quote();
      const v0 = await t.start({ kind: 'bracket', quantity: await t.qty(t.U), entry: 'limit', price: t.tick(q.bid * 0.99, t.main.name, 'down'), exits: { tpPct: 0.01, slPct: 0.01 } });
      const rest = await t.waitFor('the entry rests', async () => {
        const o = await t.algoOrders(v0.algo.id);
        return o.length >= 1 ? o : null;
      }, { timeoutMs: 30_000 });
      t.check(rest.every((o) => !o.stop), 'no exit while nothing filled');
      await t.exec.algoAct('cancel', v0.algo.id);
      await nothingResting(t, v0.algo.id);
    },
  }),

  /* ---------------------------------------------------------------- Basket ----- */
  algo('basket.swarm', 'basket', 'Basket: long BTC, short ETH, each a swarm', 'two markets worked at once: a real long on one, a real short on the other', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 8 * U, makerUsd: 0, peakUsd: 4 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'basket', legs: [{ symbol: t.main.name, side: 'buy', usd: 2 * t.U }, { symbol: t.second.name, side: 'sell', usd: 2 * t.U }], style: 'swarm', clips: 2, inFlight: 2, waveMs: 1_000, slippageBps: 20 });
      await t.waitAlgo(v0.algo.id, 'the basket is done', done, { timeoutMs: 2 * MIN });
      const legs = (await t.exec.algos()).filter((x) => x.algo.parentId === v0.algo.id);
      t.check(legs.length === 2 && legs.every(done), 'both legs are done', legs.map((l) => l.algo.status));
      for (const l of legs) {
        t.algos.push(l.algo.id);
        await positionIs(t, sign(l.algo.spec.side) * l.algo.filled, `leg ${l.algo.spec.symbol}`, l.algo.spec.symbol);
      }
    },
  }),
  algo('basket.twap-cancel', 'basket', 'Basket of two TWAP legs, cancelled after the first fills', 'one cancel stops every leg on both markets; nothing rests anywhere', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 6 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'basket', legs: [{ symbol: t.main.name, side: 'buy', usd: 3 * t.U }, { symbol: t.second.name, side: 'buy', usd: 3 * t.U }], style: 'twap', durationMs: 90_000, slices: 3, slippageBps: 20 });
      await t.waitFor('a leg filled', async () => ((await t.exec.algos()).some((x) => x.algo.parentId === v0.algo.id && x.algo.filled > 0) ? true : null), { timeoutMs: 90_000 });
      await t.exec.algoAct('cancel', v0.algo.id);
      await t.waitFor('every leg ended', async () => {
        const legs = (await t.exec.algos()).filter((x) => x.algo.parentId === v0.algo.id);
        return legs.length === 2 && legs.every(ended) ? legs : null;
      }, { timeoutMs: 30_000 });
      for (const l of (await t.exec.algos()).filter((x) => x.algo.parentId === v0.algo.id)) await nothingResting(t, l.algo.id, l.algo.spec.symbol);
    },
  }),

  /* ----------------------------------------------------------- Fill fast ----- */
  algo('sweep.buy', 'sweep', 'Fill fast (sweep) against the outside reference', 'IOC rounds at a band around Binance & co fill on SoDEX', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const v0 = await t.start({ kind: 'sweep', quantity: await t.qty(t.U), reference: 'oracleMid', slippageBps: 15, roundMs: 500, timeoutMs: 30_000 });
      const v = await t.waitEnded(v0.algo.id, 60_000);
      if (v.algo.status !== 'done') throw new Inconclusive(`SoDEX was more than 15 bp from the outside reference (${v.algo.status}: ${v.algo.statusReason ?? ''})`);
      await filledAsBooked(t, v);
      t.check(v.algo.children.every((c) => c.tif === 'ioc'), 'every round was an IOC');
    },
  }),
  algo('sweep.limit-expire', 'sweep', 'Fill fast with a limit price below the market', 'no round is priced past the limit; it expires with nothing filled', {
    timeoutMs: MIN,
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0 }),
    async run(t) {
      const q = await t.quote();
      const limit = t.tick(q.bid * 0.99, t.main.name, 'down');
      const v0 = await t.start({ kind: 'sweep', quantity: await t.qty(t.U), slippageBps: 10, limitPrice: limit, timeoutMs: 10_000 });
      const v = await t.waitEnded(v0.algo.id, 40_000);
      t.check(v.algo.filled === 0, 'nothing filled');
      t.check(v.algo.children.every((c) => c.price <= limit), 'no round priced past the limit');
      t.check(v.algo.status === 'expired' || v.algo.status === 'failed', `it ended ${v.algo.status}`);
    },
  }),

  /* ---------------------------------------------------- Account rules ----- */
  algo('leverage.set', 'leverage', 'Leverage and isolated margin set by an algo (the region\'s cap applies)', 'SoDEX shows the leverage and margin mode the algo set, capped for the declared region', {
    timeoutMs: 2 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, leverage: 2 }),
    async run(t) {
      const want = t.env.regionMaxLeverage !== null ? 5 : 3;
      const v0 = await t.start({ kind: 'swarm', quantity: await t.qty(2 * t.U), clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20, leverage: want, marginMode: 'isolated' });
      const v = await t.waitAlgo(v0.algo.id, 'the swarm is done', done, { timeoutMs: 90_000 });
      await filledAsBooked(t, v);
      const exp = t.expectedLeverage(want);
      await t.live(`SoDEX holds the position at ${exp}x isolated`, async () => {
        const l = await t.env.reads.leverage(t.env.followerAddress, t.main.name);
        t.check(l !== null && l.leverage === exp && l.marginMode === 'isolated', `leverage ${exp}x isolated (asked ${want}x)`, l);
      });
    },
  }),
  algo('reduce-only.no-flip', 'reduce-only', 'Reduce-only swarm larger than the position', 'SoDEX fills a reduce-only order only up to the position: it ends flat, never short', {
    timeoutMs: 2 * MIN,
    dry: 'spec',
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const pos = await t.openPosition('buy', t.U);
      const v0 = await t.start({ kind: 'swarm', side: 'sell', reduceOnly: true, quantity: await t.qty(2.5 * t.U), clips: 2, inFlight: 1, waveMs: 1_000, slippageBps: 30, retries: 0 });
      const v = await t.waitEnded(v0.algo.id, 90_000);
      if (t.dry) {
        t.check(ended(v), `on paper it ended ${v.algo.status}`);
        return;
      }
      const p = await t.account.position(t.main.name);
      t.check(p >= 0 && near(p, 0, stepOf(t) / 2), `flat, not short (${p})`);
      t.check(v.algo.filled <= pos + stepOf(t) / 2, `it sold no more than the position (${v.algo.filled} of ${pos})`);
    },
  }),
  algo('kill.switch', 'kill', 'Kill switch with a ladder, an iceberg and a bracket working', 'one cancel-all leaves no order and no stop on SoDEX; the position it opened stays (the cleanup closes it)', {
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: 5 * U }),
    async run(t) {
      const q = await t.quote();
      const a = await t.start({ kind: 'scale', quantity: await t.qty(2.1 * t.U), from: t.tick(q.bid * 0.99, t.main.name, 'down'), to: t.tick(q.bid * 0.985, t.main.name, 'down'), orders: 2, postOnly: true });
      const b = await t.start({ kind: 'iceberg', side: 'sell', quantity: await t.qty(2 * t.U), displayQty: await t.qty(t.U), price: t.tick(q.ask * 1.01, t.main.name, 'up'), postOnly: true });
      const c = await t.start({ kind: 'bracket', quantity: await t.qty(t.U), entry: 'market', slippageBps: 30, exits: { tpPct: 0.02, slPct: 0.02 } });
      await t.waitFor(`ladder, clip and both exits rest on ${t.where}`, async () => {
        const [x, y, z] = await Promise.all([t.algoOrders(a.algo.id), t.algoOrders(b.algo.id), t.algoOrders(c.algo.id)]);
        return x.length === 2 && y.length === 1 && z.filter((o) => o.stop).length === 2 ? true : null;
      }, { timeoutMs: 60_000 });
      await t.exec.algoAct('cancel-all');
      await t.waitFor('every algo ended', async () => {
        const vs = await Promise.all([a, b, c].map((x) => t.view(x.algo.id)));
        return vs.every(ended) ? true : null;
      }, { timeoutMs: 20_000 });
      for (const x of [a, b, c]) await nothingResting(t, x.algo.id);
      await t.live('the bracket\'s position is still there (the kill switch cancels, it does not close)', async () => {
        t.check((await t.account.position(t.main.name)) > 0, 'a long remains');
      });
    },
  }),
];
