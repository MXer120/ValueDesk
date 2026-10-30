/**
 * Copy trading on a real exchange: a LEADER wallet the owner controls, traded
 * by the harness itself (real IOCs with its own key), and the follower's copy
 * on the executor. What only SoDEX shows: the leader's fill reaching the copier
 * over SoDEX's public trade stream (Hyperliquid's userFills stream for a
 * Hyperliquid leader), the copy's own fills and fees, reduce-only
 * reductions (also below the minimum order value), the copy's stop-loss and
 * take-profit held by SoDEX as position stops, the leverage set, and a copier
 * that was down catching up without doubling an order.
 *
 * A dry run cannot trade the leader (it has no funds): it runs each copy's
 * lifecycle on paper - start, pause, resume, change, restart, stop - and
 * counts the follower's expected positions as "live only".
 *
 * THE LEADER'S VENUE (LIVE_LEADER_VENUE, leader.ts). Every scenario here runs
 * with a SoDEX leader or a Hyperliquid one: the leader's trades go to its own
 * market of the SoDEX market ('BTC' for 'BTC-USD'), and the copy's settings
 * name its venue. A few run only with a Hyperliquid leader (`leaderVenue`):
 * what only a second venue shows - its coins mapped to SoDEX's markets by
 * notional (a thousand-unit kPEPE to SoDEX's 1000PEPE / KPEPE market), a coin
 * SoDEX does not list skipped, a leader working an order in slices.
 */
import { MarketBook, RECONCILE_MS, SKIP_REASONS, coinOf } from '../../../../../packages/copy-engine/src/index.ts';
import { Inconclusive, Unavailable, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/copy.ts';
const MIN = 60_000;

/** The thousand-unit coin of copy.hl-k-prefix: the cleanup flattens the follower on its SoDEX market too (run.ts). */
export const K_COIN = 'kPEPE';

function copy(id: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run' | 'timeoutMs'>): Scenario {
  return { id, section: 'copy', kind: 'copy', title, confirms, deps: ['copy', 'leader'], source: SOURCE, dry: 'lifecycle', leader: true, ...o };
}

/** A scenario only a Hyperliquid leader can show. */
function hlCopy(id: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run' | 'timeoutMs'>): Scenario {
  return copy(id, title, confirms, { leaderVenue: 'hyperliquid', ...o });
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

/**
 * How fast a copy must follow, leader fill to copy fill, by the venues' own
 * timestamps.
 *
 * A SoDEX leader is on SoDEX's clock like the copy (one clock): the copier sees
 * it on the public trade stream, merges prints for 150 ms, and the rest is the
 * order's way to SoDEX - median under 1 s, slowest under 3 s.
 *
 * A Hyperliquid leader's fill is on Hyperliquid's clock and the copy's on
 * SoDEX's, so every number also carries the offset between the two clocks
 * (Hyperliquid's against this machine's is measured on the leader's own orders
 * and logged; SoDEX's is not measured here), and the copier hears of the fill
 * from Hyperliquid's userFills stream, whose delay this suite does not measure
 * either. So twice the time, plus two seconds for the slowest: median under
 * 2 s, slowest under 5 s - still far under the reconcile every RECONCILE_MS
 * (60 s), so a copy that missed the stream and waited for the reconcile fails.
 * In the pairing a copy may also look up to `pairSlackMs` past its own time for
 * its leader fill (a Hyperliquid clock up to half a second ahead of SoDEX's).
 */
const LATENCY = {
  sodex: { medianMs: 1_000, slowestMs: 3_000, pairSlackMs: 0 },
  hyperliquid: { medianMs: 2_000, slowestMs: 5_000, pairSlackMs: 500 },
} as const;
/**
 * The limits are the hosted executor's, which runs next to SoDEX (Tokyo). A self-hosted copier or a browser
 * copies from wherever it runs: this machine's link to SoDEX's trade stream adds its own delay and jitter
 * (2026-10-29 from Germany: 0-0.7 s between the leader's fill and the order leaving, by the stream alone).
 */
const OFFSITE_SLACK_MS = 1_000;

/**
 * How long each copied order took: each copy order (its first fill: one order
 * can print as several) paired with the last leader fill before it.
 */
async function copyLatencies(t: T): Promise<number[]> {
  const leader = (await t.leaderFills()).map((f) => f.time).sort((a, b) => a - b);
  const mine = (await t.account.fills(t.main.name)).filter((f) => f.clOrdID?.startsWith('vdc-'));
  const slack = LATENCY[t.env.leaderVenue].pairSlackMs;
  const first = new Map<string, number>();
  for (const f of mine) first.set(f.orderId, Math.min(first.get(f.orderId) ?? Infinity, f.time));
  const out: number[] = [];
  for (const at of first.values()) {
    const before = leader.filter((x) => x <= at + slack);
    if (before.length) out.push(at - before[before.length - 1]!);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The leader venue's clock against this machine's, from the leader's own
 * orders of this scenario: each fill's time less the middle of the request
 * that placed it, within half that request's round trip. The median, or null.
 */
async function leaderClockOffset(t: T): Promise<{ ms: number; within: number } | null> {
  const fills = await t.leaderFills();
  const seen: Array<{ ms: number; within: number }> = [];
  for (const tr of t.leaderTrades) {
    const f = fills.find((x) => x.orderId === tr.ref || x.clOrdID === tr.ref);
    if (f) seen.push({ ms: f.time - (tr.sentAt + tr.answeredAt) / 2, within: (tr.answeredAt - tr.sentAt) / 2 });
  }
  if (!seen.length) return null;
  seen.sort((a, b) => a.ms - b.ms);
  return seen[Math.floor(seen.length / 2)]!;
}

/** Each copied order within the leader venue's limits (LATENCY); a Hyperliquid leader's clock offset logged with them. */
async function checkLatencies(t: T, atLeast: number): Promise<void> {
  const base = LATENCY[t.env.leaderVenue];
  const slack = t.env.target.name === 'hosted' ? 0 : OFFSITE_SLACK_MS;
  const lim = { ...base, medianMs: base.medianMs + slack, slowestMs: base.slowestMs + slack };
  const ms = await copyLatencies(t);
  if (t.env.leaderVenue === 'hyperliquid') {
    const off = await leaderClockOffset(t);
    t.note(`leader fill (Hyperliquid's clock) to copy fill (SoDEX's clock): ${ms.map((x) => `${x} ms`).join(', ')}; Hyperliquid's clock against this machine's: ${off ? `${off.ms >= 0 ? '+' : ''}${Math.round(off.ms)} ms (+/- ${Math.round(off.within)} ms)` : 'not measured'}`);
  } else t.note(`leader fill to copy fill: ${ms.map((x) => `${x} ms`).join(', ')}`);
  t.check(ms.length >= atLeast, `${ms.length} copied orders timed`);
  const median = ms[Math.floor(ms.length / 2)] ?? Infinity;
  t.check(median < lim.medianMs, `median ${median} ms (under ${lim.medianMs / 1000} s)`);
  t.check((ms[ms.length - 1] ?? Infinity) < lim.slowestMs, `slowest ${ms[ms.length - 1]} ms (under ${lim.slowestMs / 1000} s, the copier's reconcile is every ${RECONCILE_MS / 1000} s)`);
}

/** SoDEX's market list as the copier maps a leader's market to it. */
async function sodexBook(t: T): Promise<MarketBook> {
  const b = new MarketBook();
  b.load(await t.env.reads.markets());
  return b;
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
        t.checkOrderFees(os);
      });
      await t.checkBuilderFee((await t.account.fills(t.main.name)).filter((f) => f.clOrdID?.startsWith('vdc-')));
      await t.live('the activity log names the legs in order', async () => {
        const l = await legs(t, c.subscription.id);
        t.check(['open', 'increase', 'decrease', 'close'].every((x) => l.includes(x)), `legs: ${l.join(', ')}`);
      });
      await t.live(`each leader fill is copied in under ${LATENCY[t.env.leaderVenue].medianMs / 1000} s (median)`, () => checkLatencies(t, 4));
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
  copy('copy.proportional', 'Proportional to the leader\'s equity', 'the leader\'s real account value on its venue sizes the copy', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2.4 * U, makerUsd: 0, peakUsd: 1.2 * U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const eq = t.env.leader ? await t.env.leader.equity() : 100;
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
    // The stop is SoDEX's own order and fires the moment the mark crosses it; what takes time is the market reaching it.
    // At the highest leverage the region allows and the tightest stops (1% of the margin each way) that is a small move;
    // under the EEA's 2x it is 0.5% either way, which can take a while: inconclusive, not failed, if the market sits still.
    timeoutMs: 22 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const lev = t.expectedLeverage(50);
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: lev, stopLossPct: 0.01, takeProfitPct: 0.01 });
      t.note(`at ${lev}x a 1% move of the margin is ${(1 / lev).toFixed(2)}% of the price`);
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.live('a stop fires and the copy is flat while the leader is not', async () => {
        await t.waitFor('the follower is flat (its stop fired)', async () => ((await t.account.position(t.main.name)) === 0 ? true : null), { timeoutMs: 20 * MIN, everyMs: 2_000, inconclusive: true });
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
    needs: ['restart'],
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

  /* ---------------------------------------------- a Hyperliquid leader only ----- */
  hlCopy('copy.hl-follow', 'A Hyperliquid leader opens, adds, reduces and closes (fixed ratio 1x)', 'each Hyperliquid fill of the leader\'s BTC is copied on SoDEX\'s BTC-USD at the same notional (sized by notional, not by units); reductions reduce-only', {
    timeoutMs: 8 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedRatio', ratio: 1, maxLeverage: 2 });
      const id = c.subscription.id;
      t.check(c.subscription.settings.leader.venue === 'hyperliquid', 'the executor follows the leader on Hyperliquid');
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(await t.leaderUsd(), 'the follower opened the leader\'s notional', { tol: 0.25 });
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(await t.leaderUsd(), 'the follower added with the leader', { tol: 0.25 });
      await t.leader({ sellUsd: t.U });
      await t.expectFollowerUsd(await t.leaderUsd(), 'the follower reduced with the leader', { tol: 0.3 });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
      await t.live(`every copy order answers the leader's ${t.leaderSymbol()} and went to ${t.main.name}, the legs in order`, async () => {
        const orders = (await t.exec.activity(id)).filter((e) => e.kind === 'order').reverse();
        t.check(orders.length >= 4, `${orders.length} copy orders`);
        t.check(orders.every((e) => e.symbol === t.main.name && e.leader?.symbol === t.leaderSymbol()), 'each names the leader\'s coin and the SoDEX market', orders.map((e) => `${e.leader?.symbol}->${e.symbol}`));
        const l = orders.map((e) => e.reason);
        t.check(['open', 'increase', 'decrease', 'close'].every((x) => l.includes(x)), `legs: ${l.join(', ')}`);
      });
      await t.live('SoDEX: the reductions were reduce-only, the opens and adds not', async () => {
        const os = await copyOrders(t);
        t.check(os.filter((o) => o.side === 'sell').every((o) => o.reduceOnly) && os.filter((o) => o.side === 'buy').every((o) => !o.reduceOnly), 'sells reduce-only, buys not', os.map((o) => `${o.side}${o.reduceOnly ? ' ro' : ''}`));
      });
    },
  }),
  hlCopy('copy.hl-slices', 'A Hyperliquid leader buys in three slices sent back to back', 'slices close together are copied batched or one by one, but each exactly once: the follower ends at the leader\'s notional, no copy order twice', {
    timeoutMs: 7 * MIN,
    cost: (U) => ({ takerUsd: 6 * U, makerUsd: 0, peakUsd: 3 * U, leaderTakerUsd: 6 * U, leaderPeakUsd: 3 * U }),
    async run(t) {
      const slices = 3;
      const c = await t.subscribe({ sizingMode: 'fixedRatio', ratio: 1, maxLeverage: 2 });
      await ready(t, c.subscription.id);
      await t.leaderSlices('buy', t.U, slices);
      // The stream's merge window (150 ms) and the reconcile catch what came in between: give it one reconcile.
      await t.expectFollowerUsd(await t.leaderUsd(), `the follower caught up with all ${slices} slices`, { tol: 0.25, timeoutMs: RECONCILE_MS + 30_000 });
      await t.live('each slice was copied once: one to three copy orders, none twice', async () => {
        const buys = (await copyOrders(t)).filter((o) => o.side === 'buy');
        const ids = buys.map((o) => o.clOrdID);
        t.check(buys.length >= 1 && buys.length <= slices, `${buys.length} copy order(s) for ${slices} slices`);
        t.check(new Set(ids).size === ids.length, 'all distinct');
        t.note(`${slices} leader slices became ${buys.length} copy order(s)`);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  hlCopy('copy.hl-not-on-sodex', 'A Hyperliquid leader trades a coin SoDEX does not list', 'the copy skips it as not-on-sodex and sends nothing (the coin: the most traded one on Hyperliquid without a SoDEX market, at run time)', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const coin = await notOnSodex(t);
      if (!coin) throw new Unavailable('every coin Hyperliquid lists has a SoDEX market now');
      t.note(`${coin}: listed on Hyperliquid, no SoDEX market`);
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, assetAllow: [coinOf('hyperliquid', coin)] });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leaderTrade({ buyUsd: t.U }, coin);
      await t.live(`the copy skips ${coin} as not on SoDEX and places nothing`, async () => {
        await t.waitFor('a not-on-sodex skip in the activity', async () => ((await t.exec.activity(id)).some((e) => e.kind === 'skip' && e.reason === 'not-on-sodex') ? true : null), { timeoutMs: 45_000 });
        t.check(!(await t.exec.activity(id)).some((e) => e.kind === 'order' || e.kind === 'error'), 'no copy order, no error');
      });
      await t.leaderTrade({ close: true }, coin);
    },
  }),
  hlCopy('copy.hl-k-prefix', 'A Hyperliquid leader trades kPEPE (a thousand PEPE a unit)', 'kPEPE is copied on SoDEX\'s 1000PEPE-USD or KPEPE-USD at the leader\'s notional, and closed with it (only where SoDEX lists one at run time)', {
    timeoutMs: 6 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const hl = t.env.hl;
      if (!hl) throw new Unavailable('no Hyperliquid reads (the leader is not on Hyperliquid)');
      const k = (await hl.assets()).find((a) => a.name === K_COIN);
      if (!k || k.isDelisted) throw new Unavailable(`Hyperliquid lists no ${K_COIN} now`);
      const m = (await sodexBook(t)).sodexMarketFor('hyperliquid', K_COIN);
      if (!m) throw new Unavailable(`SoDEX lists neither 1000PEPE-USD nor KPEPE-USD now`);
      t.note(`${K_COIN} maps to SoDEX's ${m.name}`);
      const c = await t.subscribe({ sizingMode: 'fixedRatio', ratio: 1, maxLeverage: 2, assetAllow: [coinOf('hyperliquid', K_COIN)] });
      await ready(t, c.subscription.id);
      await t.leaderTrade({ buyUsd: t.U }, K_COIN);
      await t.expectFollowerUsd(await t.leaderUsdOf(K_COIN), `the follower holds the leader's notional on ${m.name}`, { symbol: m.name, tol: 0.3 });
      await t.leaderTrade({ close: true }, K_COIN);
      await t.expectFollowerUsd(0, `the follower closed ${m.name} with the leader`, { symbol: m.name });
    },
  }),
];

/**
 * The most traded Hyperliquid coin (24 h notional) that SoDEX lists no market
 * for, as the copier maps it; one step of its size worth at most a quarter of U,
 * so the leader's order stays near U. Null: there is none now.
 */
async function notOnSodex(t: T): Promise<string | null> {
  const hl = t.env.hl;
  if (!hl) throw new Unavailable('no Hyperliquid reads (the leader is not on Hyperliquid)');
  const book = await sodexBook(t);
  const cands = (await hl.volumes())
    .filter((a) => a.name && !a.isDelisted && a.markPx > 0 && 10 ** -a.szDecimals * a.markPx <= t.U / 4 && !book.sodexMarketFor('hyperliquid', a.name))
    .sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);
  return cands[0]?.name ?? null;
}

/** Keep the import: SKIP_REASONS names what the activity checks look for. */
export const COPY_SKIPS_CHECKED: ReadonlyArray<keyof typeof SKIP_REASONS> = ['max-leverage', 'after-take-profit', 'after-stop-loss', 'not-on-sodex'];
