/**
 * Copy trading on a real exchange: a LEADER wallet the owner controls, traded
 * by the harness itself (real IOCs with its own key), and the follower's copy
 * on the executor. What only SoDEX shows: the leader's fill reaching the copier
 * over SoDEX's public trade stream, the copy's own fills and fees, reduce-only
 * reductions (also below the minimum order value), the copy's stop-loss and
 * take-profit held by SoDEX as position stops, the leverage set, and a copier
 * that was down catching up without doubling an order.
 *
 * A dry run cannot trade the leader (it has no funds): it runs each copy's
 * lifecycle on paper - start, pause, resume, change, restart, stop - and
 * counts the follower's expected positions as "live only".
 */
import { SKIP_REASONS } from '../../../../../packages/copy-engine/src/index.ts';
import { Inconclusive, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/copy.ts';
const MIN = 60_000;

function copy(id: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run' | 'timeoutMs'>): Scenario {
  return { id, section: 'copy', kind: 'copy', title, confirms, deps: ['copy'], source: SOURCE, dry: 'lifecycle', leader: true, ...o };
}

/** The copier needs a moment to seed the leader from SoDEX before a trade counts. */
async function ready(t: T, id: string): Promise<void> {
  await t.waitFor('the copy is active and its leader seeded', async () => {
    const c = await t.exec.copy(id);
    return c.subscription.status === 'active' ? c : null;
  }, { timeoutMs: 30_000 });
  await t.sleep(5_000);
}

async function status(t: T, id: string, want: string): Promise<void> {
  await t.waitFor(`the copy is ${want}`, async () => ((await t.exec.copy(id)).subscription.status === want ? true : null), { timeoutMs: 20_000 });
}

/** The copy's own orders on SoDEX (client ids vdc-), from SoDEX's history since the scenario began. */
async function copyOrders(t: T) {
  return (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith('vdc-'));
}

/** The copy's position stops on SoDEX (client ids vds-). */
async function copyStops(t: T) {
  return (await t.account.openOrders(t.main.name)).filter((o) => o.clOrdID?.startsWith('vds-') && o.stop);
}

async function legs(t: T, id: string): Promise<string[]> {
  return (await t.exec.activity(id)).filter((e) => e.kind === 'order').reverse().map((e) => e.reason);
}

export const COPY_SCENARIOS: Scenario[] = [
  copy('copy.fixed-notional', 'Fixed amount: the leader opens, adds, reduces, closes', 'each leader fill is copied within seconds; reductions are reduce-only; the builder fee is charged on every copied fill', {
    timeoutMs: 8 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened about one U');
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(2 * t.U, 'the follower added with the leader');
      await t.leader({ sellUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower reduced with the leader');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
      await t.live('SoDEX: opens are not reduce-only, reductions are; every copy order was an IOC with the builder', async () => {
        const os = await copyOrders(t);
        t.check(os.length >= 4, `${os.length} copy orders on SoDEX`);
        t.check(os.every((o) => o.tif === 'IOC'), 'every copy order is an IOC');
        const sells = os.filter((o) => o.side === 'sell');
        t.check(sells.length >= 2 && sells.every((o) => o.reduceOnly), 'every reduction was reduce-only');
        t.check(os.filter((o) => o.side === 'buy').every((o) => !o.reduceOnly), 'opens and adds were not');
        t.check(os.every((o) => o.builderFee === 25), 'every copy order carries the 2.5 bp builder fee', os.map((o) => o.builderFee));
      });
      await t.checkBuilderFee((await t.account.fills(t.main.name)).filter((f) => f.clOrdID?.startsWith('vdc-')));
      await t.live('the activity log names the legs in order', async () => {
        const l = await legs(t, c.subscription.id);
        t.check(['open', 'increase', 'decrease', 'close'].every((x) => l.includes(x)), `legs: ${l.join(', ')}`);
      });
    },
  }),
  copy('copy.fixed-ratio-flip', 'Fixed ratio 1x: the leader flips from long to short', 'a flip is copied as a reduce-only close and a fresh open in one batch: the follower ends short, never doubled', {
    timeoutMs: 6 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedRatio', ratio: 1, maxLeverage: 2 });
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower is long with the leader');
      await t.leader({ sellUsd: 2 * t.U });
      await t.expectFollowerUsd(-t.U, 'the follower flipped short with the leader');
      await t.live('the flip went out as flip-close and flip-open', async () => {
        const l = await legs(t, c.subscription.id);
        t.check(l.includes('flip-close') && l.includes('flip-open'), `legs: ${l.join(', ')}`);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  copy('copy.proportional', 'Proportional to the leader\'s equity', 'the leader\'s real account value on SoDEX sizes the copy', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2.4 * U, makerUsd: 0, peakUsd: 1.2 * U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const eq = t.env.leader ? (await t.env.reads.equity(t.env.leaderAddress)).equity : 100;
      if (!(eq > 0)) throw new Inconclusive('the leader\'s account value could not be read');
      const alloc = Math.max(10, Math.round(eq * 1.2 * 100) / 100);
      const c = await t.subscribe({ sizingMode: 'proportional', allocationUsd: alloc, maxLeverage: 2 });
      t.note(`leader equity $${eq.toFixed(2)}, allocation $${alloc}: the copy should be 1.2x the leader`);
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      const lead = await t.leaderUsd();
      await t.expectFollowerUsd(lead * 1.2, 'the follower holds about 1.2x the leader\'s notional', { tol: 0.3 });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  copy('copy.max-leverage', 'The copy\'s leverage cap (1x on $U) clamps and then skips', 'the open is clamped to the cap, a further add is skipped, and SoDEX holds the copy at 1x', {
    timeoutMs: 6 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leverage: 1, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedRatio', ratio: 3, allocationUsd: t.U, maxLeverage: 1 });
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the copy is clamped to 1x its $U (not 3x the leader)', { tol: 0.2 });
      await t.live('SoDEX holds the copy at 1x', async () => {
        const l = await t.env.reads.leverage(t.env.followerAddress, t.main.name);
        t.check(l?.leverage === 1, 'leverage 1', l);
      });
      await t.leader({ buyUsd: t.U });
      await t.live('the add is skipped at the leverage cap', async () => {
        await t.waitFor('a max-leverage skip in the activity', async () => ((await t.exec.activity(c.subscription.id)).some((e) => e.kind === 'skip' && e.reason === 'max-leverage') ? true : null), { timeoutMs: 45_000 });
        const p = (await t.account.position(t.main.name)) * (await t.quote()).mark;
        t.check(p <= t.U * 1.05, `the follower still holds at most $U ($${p.toFixed(2)})`);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  copy('copy.sl-tp-orders', 'The copy\'s stop-loss and take-profit as SoDEX stops', 'SoDEX holds a reduce-only STOP_LOSS and TAKE_PROFIT for the copied position, resized when the leader adds, cancelled when the copy closes', {
    timeoutMs: 7 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, stopLossPct: 0.5, takeProfitPct: 1 });
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.live('stops placed, resized, cancelled on SoDEX', async () => {
        const first = await t.waitFor('a stop-loss and a take-profit rest on SoDEX for the copy', async () => {
          const s = await copyStops(t);
          return s.length === 2 ? s : null;
        }, { timeoutMs: 60_000 });
        const pos = await t.account.position(t.main.name);
        const mark = (await t.quote()).mark;
        const sl = first.find((s) => s.stop!.kind === 'sl')!;
        const tp = first.find((s) => s.stop!.kind === 'tp')!;
        t.check(sl && tp && sl.reduceOnly && tp.reduceOnly && sl.side === 'sell' && tp.side === 'sell', 'both reduce-only sells');
        t.check(Math.abs(sl.qty - pos) < 1e-9 && Math.abs(tp.qty - pos) < 1e-9, `both sized to the position (${pos})`, first.map((s) => s.qty));
        t.check(sl.stop!.trigger < mark && tp.stop!.trigger > mark, `stop-loss below (${sl.stop!.trigger}), take-profit above (${tp.stop!.trigger}) the mark ${mark}`);
        await t.leader({ buyUsd: t.U });
        await t.expectFollowerUsd(2 * t.U, 'the follower added');
        const p2 = await t.account.position(t.main.name);
        await t.waitFor('the stops are resized to the new position', async () => {
          const s = await copyStops(t);
          return s.length === 2 && s.every((x) => Math.abs(x.qty - p2) < 1e-9) ? true : null;
        }, { timeoutMs: 60_000 });
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed');
      await t.live('the stops are gone with the position', async () => {
        await t.waitFor('no copy stop rests on SoDEX', async () => ((await copyStops(t)).length === 0 ? true : null), { timeoutMs: 60_000 });
      });
    },
  }),
  copy('copy.tp-fires', 'The copy\'s take-profit or stop-loss fires on SoDEX', 'SoDEX fires the copy\'s stop by itself; the copy then leaves the market alone until the leader is flat', {
    slow: true,
    timeoutMs: 35 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const lev = t.expectedLeverage(10);
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: lev, stopLossPct: 0.01, takeProfitPct: 0.01 });
      t.note(`at ${lev}x a 1% move of the margin is ${(1 / lev).toFixed(2)}% of the price`);
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.live('a stop fires and the copy is flat while the leader is not', async () => {
        await t.waitFor('the follower is flat (its stop fired)', async () => ((await t.account.position(t.main.name)) === 0 ? true : null), { timeoutMs: 30 * MIN, everyMs: 5_000, inconclusive: true });
        t.check((await t.leaderUsd()) > 0, 'the leader still holds');
        await t.leader({ buyUsd: t.U });
        await t.waitFor('the add is skipped after the stop', async () => ((await t.exec.activity(c.subscription.id)).some((e) => e.kind === 'skip' && (e.reason === 'after-take-profit' || e.reason === 'after-stop-loss')) ? true : null), { timeoutMs: 45_000 });
      });
      await t.leader({ close: true });
    },
  }),
  copy('copy.pause-resume-close', 'Paused while the leader closes, then resumed', 'a paused copy keeps its position while the leader closes; on resume the stray position is closed', {
    timeoutMs: 6 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.exec.copyAct('pause', { id });
      await status(t, id, 'paused');
      await t.leader({ close: true });
      await t.sleep(20_000);
      await t.live('the paused copy kept its position', async () => t.check((await t.account.position(t.main.name)) > 0, 'still long while paused'));
      await t.exec.copyAct('resume', { id });
      await status(t, id, 'active');
      await t.expectFollowerUsd(0, 'resumed, it closes what the leader closed meanwhile');
    },
  }),
  copy('copy.stop-close', 'Stop and close while the leader is still long', 'stop with close flattens the follower at once; later leader trades are not copied', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.exec.copyAct('stop', { id, close: true });
      await status(t, id, 'stopped');
      await t.expectFollowerUsd(0, 'the follower is flat after stop-and-close', { timeoutMs: 30_000 });
      await t.leader({ buyUsd: t.U });
      await t.sleep(15_000);
      await t.live('a stopped copy copies nothing', async () => t.check((await t.account.position(t.main.name)) === 0, 'still flat'));
      await t.leader({ close: true });
    },
  }),
  copy('copy.restart', 'Executor killed while copying; the leader adds while it is down', 'after the restart the copy catches up to the leader from SoDEX (reconcile) with no order sent twice', {
    timeoutMs: 7 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.restart({ whileDown: () => t.leader({ buyUsd: t.U }), downMs: 3_000 });
      await t.waitFor('the copy is listed again after the restart', async () => ((await t.exec.copy(id)).subscription.status === 'active' ? true : null), { timeoutMs: 30_000 });
      await t.expectFollowerUsd(2 * t.U, 'the follower caught up with the add it missed', { timeoutMs: 150_000 });
      await t.live('no copy order went out twice', async () => {
        const os = await copyOrders(t);
        const ids = os.map((o) => o.clOrdID);
        t.check(new Set(ids).size === ids.length, `${ids.length} copy orders, all distinct`);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  copy('copy.counter', 'Counter-trade', 'the leader\'s long opens a real short on the follower; their close closes it', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, direction: 'counter' });
      t.check(c.subscription.settings.direction === 'counter', 'the executor runs it as a counter-trade');
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(-t.U, 'the follower is short against the leader\'s long');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  copy('copy.reduce-below-min', 'A reduction below SoDEX\'s minimum order value', 'SoDEX accepts the reduce-only copy order under minNotional; the follower follows the leader\'s fraction', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 5 * U, leaderPeakUsd: 2.5 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: 2.5 * t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened its fixed amount');
      await t.leader({ sellUsd: t.U });
      await t.expectFollowerUsd(t.U * 0.6, 'the follower reduced by the leader\'s fraction (an order under the minimum)', { tol: 0.3 });
      await t.live('SoDEX filled a reduce-only copy order under minNotional', async () => {
        const q = await t.quote();
        const small = (await copyOrders(t)).filter((o) => o.reduceOnly && o.filled > 0 && o.filled * q.mark < t.main.minNotional);
        t.check(small.length >= 1, `${small.length} filled reduce-only order(s) under $${t.main.minNotional}`);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  copy('copy.size-change', 'The copy\'s amount changed between two leader trades', 'an update of the signed rules sizes the next copied open by the new amount', {
    timeoutMs: 7 * MIN,
    cost: (U) => ({ takerUsd: 5 * U, makerUsd: 0, peakUsd: 1.5 * U, leaderTakerUsd: 4 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened $U');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'and closed');
      const bigger = Math.round(t.U * 1.5 * 100) / 100;
      const [u] = await t.exec.copyAct('update', { id, settings: t.settings({ sizingMode: 'fixedNotional', fixedNotionalUsd: bigger, maxLeverage: 2 }) });
      t.check(u?.subscription.settings.fixedNotionalUsd === bigger, `the executor holds the new amount ($${bigger})`);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(bigger, 'the next open uses the new amount');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
];

/** Keep the import: SKIP_REASONS names what the activity checks look for. */
export const COPY_SKIPS_CHECKED: ReadonlyArray<keyof typeof SKIP_REASONS> = ['max-leverage', 'after-take-profit', 'after-stop-loss'];
