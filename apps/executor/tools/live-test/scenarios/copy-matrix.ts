/**
 * The copy options matrix on a real exchange (docs/COVERAGE-COPY.md): every copy setting value
 * and every leader and follower event a user can meet, once each, live, beyond what
 * scenarios/copy.ts runs. Copy existing on and off, max position, a growth under SoDEX's
 * minimum, two markets under one leverage cap, the coin filters changed mid-position, cross
 * margin, the slippage cap on SoDEX's own order record, the copy's SoDEX stops following a
 * change of its rules, stop keeping the positions, stop all over two leaders, a paper and a
 * live copy of one leader, the follower's own position, a copied position made smaller or
 * closed by hand, too little free margin, paused while the leader opens, "ask me each time",
 * the builder approval lowered under the fee, the leader closing while the executor (or the
 * browser tab) is down, a counter-trade flip, the drawdown stop (slow) and, with a Hyperliquid
 * leader, a coin whose SoDEX market of the same name is another asset.
 *
 * Every id starts `copym.` (`--only copym.*`). Sizes are U ($12) for the leader; the follower's
 * exposure is at most 4U at once. Every scenario runs with either leader (the Hyperliquid-only
 * one is skipped with a SoDEX leader, with why). A dry run cannot trade the leader: it runs each
 * copy's lifecycle on paper (start, the status each step leads to, updates, pause, resume, stop)
 * and counts what only a leader's trade or SoDEX shows as "live only".
 */
import { MarketBook, coinOf, uncopyable, type ActivityEntry, type SkipReason } from '../../../../../packages/copy-engine/src/index.ts';
import { Inconclusive, Unavailable, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/copy-matrix.ts';
const MIN = 60_000;
/** A second leader for "several leaders": an address that holds and trades nothing (copied, it never sends an order). */
export const IDLE_LEADER = '0x000000000000000000000000000000000000dead';

function cm(id: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run' | 'timeoutMs'>): Scenario {
  return { id, section: 'copy', kind: 'copy', title, confirms, deps: ['copy', 'leader'], source: SOURCE, dry: 'lifecycle', leader: true, ...o };
}

/** Wait until the copy is in `want` (active by default) and its leader is seeded. */
async function ready(t: T, id: string, want = 'active'): Promise<void> {
  await t.waitFor(`the copy is ${want} and its leader seeded`, async () => ((await t.exec.copy(id)).subscription.status === want ? true : null), { timeoutMs: 30_000 });
  await t.sleep(5_000);
}

async function status(t: T, id: string, want: string, timeoutMs = 30_000): Promise<string | null> {
  return t.waitFor(`the copy is ${want}`, async () => {
    const s = (await t.exec.copy(id)).subscription;
    return s.status === want ? { why: s.statusReason } : null;
  }, { timeoutMs }).then((x) => x.why);
}

/** Live: wait for a skip of `reason` in the copy's activity (on `symbol`, when given). */
async function skipped(t: T, id: string, reason: SkipReason, o: { symbol?: string; timeoutMs?: number } = {}): Promise<void> {
  await t.live(`the copy skips it as ${reason}`, async () => {
    await t.waitFor(`a ${reason} skip in the activity`, async () => ((await t.exec.activity(id)).some((e) => e.kind === 'skip' && e.reason === reason && (!o.symbol || e.symbol === o.symbol)) ? true : null), { timeoutMs: o.timeoutMs ?? 45_000 });
  });
}

/** Live: a status line of `reason` (closed-outside, reduced-outside) in the copy's activity. */
async function statusLine(t: T, id: string, reason: string, timeoutMs: number): Promise<ActivityEntry> {
  return t.waitFor(`a "${reason}" line in the copy's activity`, async () => (await t.exec.activity(id)).find((e) => e.kind === 'status' && e.reason === reason) ?? null, { timeoutMs, everyMs: 5_000 });
}

/** Live: the follower holds nothing on `symbol` (after `ms`, so an order the copier would send has had its chance). */
async function stillFlat(t: T, what: string, symbol = t.main.name, ms = 15_000): Promise<void> {
  await t.live(what, async () => {
    await t.sleep(ms);
    t.check((await t.account.position(symbol)) === 0, `${what}: the follower holds nothing on ${symbol}`);
  });
}

/** The copy's own orders on SoDEX (client ids vdc-), from SoDEX's history since the scenario began. */
async function copyOrders(t: T, symbol = t.main.name) {
  return (await t.account.history(symbol)).filter((o) => o.clOrdID?.startsWith('vdc-'));
}

/** The copy's position stops resting on SoDEX (client ids vds-). */
async function copyStops(t: T, symbol = t.main.name) {
  return (await t.account.openOrders(symbol)).filter((o) => o.clOrdID?.startsWith('vds-') && o.stop);
}

/** Wait until the copy's SoDEX stops are exactly `kinds` (sl / tp). */
async function stopsAre(t: T, kinds: Array<'sl' | 'tp'>, what: string): Promise<void> {
  await t.waitFor(what, async () => {
    const s = await copyStops(t);
    const got = s.map((x) => x.stop!.kind).sort();
    return got.length === kinds.length && got.every((k, i) => k === [...kinds].sort()[i]) ? s : null;
  }, { timeoutMs: 60_000 });
}

/** The wallet's notices of this copy (self and hosted; a browser's are its bell, not read here). */
async function noticeOf(t: T, id: string, kind: string, grade: string): Promise<void> {
  const read = t.exec.notices?.bind(t.exec);
  if (!read) {
    t.note(`the ${t.env.target.name} target keeps its notices in the bell: the ${kind} notice is not read here`);
    return;
  }
  await t.waitFor(`a ${grade} "${kind}" notice for the copy`, async () => ((await read(100)).some((n) => n.ref.startsWith(id) && n.kind === kind && n.grade === grade) ? true : null), { timeoutMs: 30_000 });
}

/** The follower's copy as the executor books it, signed USD at the mark (paper copies too). */
async function bookedUsd(t: T, id: string, symbol = t.main.name): Promise<number> {
  const v = await t.exec.copy(id);
  return v.positions.filter((p) => p.symbol === symbol).reduce((a, p) => a + p.size * (p.mark ?? p.entry), 0);
}

const legs = async (t: T, id: string): Promise<string[]> => (await t.exec.activity(id)).filter((e) => e.kind === 'order').reverse().map((e) => e.reason);
const executor = (t: T) => t.env.target.name !== 'browser';

export const COPY_MATRIX_SCENARIOS: Scenario[] = [
  /* ----------------------------------------------------------- the start ----- */
  cm('copym.copy-existing', '"Copy existing" on: the leader\'s open position is joined at the start', 'a copy started with copyExisting joins the leader\'s open position at once on SoDEX; a coin off its list (the second market) is skipped as asset-not-allowed; it closes with the leader', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      await t.leader({ buyUsd: t.U });
      await t.leader({ buyUsd: t.U }, t.second.name);
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, copyExisting: true });
      t.check(c.subscription.settings.copyExisting === true && c.subscription.settings.assetAllow.join() === t.main.base, `copy existing, ${t.main.base} only`);
      await ready(t, c.subscription.id);
      await t.expectFollowerUsd(t.U, 'the follower joined the leader\'s position at the start');
      await skipped(t, c.subscription.id, 'asset-not-allowed', { symbol: t.second.name });
      await stillFlat(t, `the leader's ${t.second.base} is not joined (not on the list)`, t.second.name, 0);
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
      await t.leader({ close: true }, t.second.name);
    },
  }),
  cm('copym.pre-existing', '"Copy existing" off: the leader\'s open position waits until the leader is flat', 'nothing is joined at the start, the leader\'s add to that position is skipped as pre-existing-position, and the leader\'s next open after it was flat is copied', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 6 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      await t.leader({ buyUsd: t.U });
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, copyExisting: false });
      const id = c.subscription.id;
      await ready(t, id);
      await stillFlat(t, 'nothing joined at the start', t.main.name, 0);
      await t.leader({ buyUsd: t.U });
      await skipped(t, id, 'pre-existing-position');
      await stillFlat(t, 'the add to a position held before the start is not copied', t.main.name, 0);
      await t.leader({ close: true });
      await t.sleep(5_000);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the leader\'s next open is copied');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),

  /* ------------------------------------------------------------- sizing ----- */
  cm('copym.max-position', 'Max position: an open clamped to it, the next add skipped at it', 'a fixed ratio of 2x is clamped to the $U max position (the activity names max-position), the leader\'s add is skipped as max-position, SoDEX holds about $U', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedRatio', ratio: 2, maxPositionUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower is clamped to $U (not 2x the leader)', { tol: 0.15 });
      await t.live('the open says which cap made it smaller', async () => {
        const o = (await t.exec.activity(id)).find((e) => e.kind === 'order' && e.reason === 'open');
        t.check(!!o && /max-position/.test(o.detail ?? ''), `open: ${o?.detail}`);
      });
      await t.leader({ buyUsd: t.U });
      await skipped(t, id, 'max-position');
      await t.live('the follower still holds about $U', async () => {
        const p = (await t.account.position(t.main.name)) * (await t.quote()).mark;
        t.check(p <= t.U * 1.05, `$${p.toFixed(2)}`);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  cm('copym.below-min-open', 'An open below SoDEX\'s minimum order value, caught up by the next add', 'half the leader\'s $U is under SoDEX\'s minimum: skipped as min-notional, nothing sent; the leader\'s next add takes the copy to its whole target in one order', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedRatio', ratio: 0.5, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await skipped(t, id, 'min-notional');
      await stillFlat(t, 'nothing under the minimum was sent', t.main.name, 0);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd((await t.leaderUsd()) * 0.5, 'the next add caught the copy up to half the leader', { tol: 0.25 });
      await t.live('one opening order, at the add', async () => {
        const opens = (await copyOrders(t)).filter((o) => !o.reduceOnly);
        t.check(opens.length === 1, `${opens.length} opening order(s)`);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  cm('copym.two-markets', 'Two markets under one leverage cap (1x of 1.5U)', 'the leader\'s second market is skipped at the copy\'s gross leverage cap while the first is held (max-leverage), and copied once the first is closed', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: U, leverage: 1, leaderTakerUsd: 6 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, allocationUsd: Math.round(t.U * 1.5 * 100) / 100, maxLeverage: 1, assetAllow: [t.main.base, t.second.base] });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, `the follower holds $U of ${t.main.name}`);
      await t.leader({ buyUsd: t.U }, t.second.name);
      await skipped(t, id, 'max-leverage', { symbol: t.second.name });
      await stillFlat(t, `no room for ${t.second.name} under 1x of 1.5U`, t.second.name, 0);
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, `the follower closed ${t.main.name} with the leader`);
      await t.leader({ buyUsd: t.U }, t.second.name);
      await t.expectFollowerUsd(t.U, `with ${t.main.name} closed, the leader's add on ${t.second.name} is copied`, { symbol: t.second.name });
      await t.leader({ close: true }, t.second.name);
      await t.expectFollowerUsd(0, `the follower closed ${t.second.name} with the leader`, { symbol: t.second.name });
    },
  }),
  cm('copym.counter-flip', 'Counter-trade at a fixed ratio: the leader flips', 'the leader\'s long is a short on the follower, their flip to short flips the follower long (flip-close and flip-open), their close closes it', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedRatio', ratio: 1, maxLeverage: 2, direction: 'counter' });
      t.check(c.subscription.settings.direction === 'counter', 'a counter-trade');
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(-(await t.leaderUsd()), 'the follower is short the leader\'s notional');
      await t.leader({ sellUsd: 2 * t.U });
      await t.expectFollowerUsd(-(await t.leaderUsd()), 'the leader flipped short: the follower flipped long', { tol: 0.3 });
      await t.live('the flip went out as flip-close and flip-open', async () => {
        const l = await legs(t, c.subscription.id);
        t.check(l.includes('flip-close') && l.includes('flip-open'), `legs: ${l.join(', ')}`);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),

  /* -------------------------------------------------- filters and rules ----- */
  cm('copym.asset-filters', 'The coin filters, changed while the copy holds a position', 'a denied coin is not opened (asset-denied); after the rules change mid-position the newly denied coin is still closed with the leader (a reduction is never filtered) and not opened again, and the newly allowed one is copied at the leader\'s next open', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 8 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const rules = (deny: string) => ({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, assetAllow: [], assetDeny: [deny] });
      const c = await t.subscribe(rules(t.second.base));
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.leader({ buyUsd: t.U }, t.second.name);
      await t.expectFollowerUsd(t.U, `the follower holds ${t.main.name}`);
      await skipped(t, id, 'asset-denied', { symbol: t.second.name });
      await stillFlat(t, `${t.second.name} is denied`, t.second.name, 0);
      await t.leader({ close: true }, t.second.name);
      // The rules change while the copy holds the main market: now that one is denied, the second allowed.
      const [u] = await t.exec.copyAct('update', { id, settings: t.settings(rules(t.main.base)) });
      t.check(u?.subscription.settings.assetDeny.join() === t.main.base, `now ${t.main.base} is denied, ${t.second.base} allowed`);
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, `the now denied ${t.main.name} is still closed with the leader (a reduction is never filtered)`);
      await t.leader({ buyUsd: t.U }, t.second.name);
      await t.expectFollowerUsd(t.U, `${t.second.name}, now allowed, is copied at the leader's next open`, { symbol: t.second.name });
      await t.leader({ buyUsd: t.U });
      await t.live(`the leader's open on the now denied ${t.main.name} is not copied`, async () => {
        await t.waitFor('an asset-denied skip on the main market', async () => ((await t.exec.activity(id)).some((e) => e.kind === 'skip' && e.reason === 'asset-denied' && e.symbol === t.main.name) ? true : null), { timeoutMs: 45_000 });
        t.check((await t.account.position(t.main.name)) === 0, `nothing on ${t.main.name}`);
      });
      await t.leader({ close: true }, t.second.name);
      await t.expectFollowerUsd(0, `the follower closed ${t.second.name} with the leader`, { symbol: t.second.name });
      await t.leader({ close: true });
    },
  }),
  cm('copym.margin-cross', 'Cross margin', 'SoDEX holds the copied position in cross margin at the copy\'s leverage', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, marginMode: 'cross' });
      t.check(c.subscription.settings.marginMode === 'cross', 'the copy runs in cross margin');
      await ready(t, c.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.live(`SoDEX holds it cross at ${t.expectedLeverage(2)}x`, async () => {
        const l = await t.env.reads.leverage(t.env.followerAddress, t.main.name);
        t.check(l?.marginMode === 'cross' && l.leverage === t.expectedLeverage(2), 'cross margin and the copy\'s leverage', l);
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  cm('copym.slippage', 'The slippage cap (10 bp) on SoDEX\'s order record', 'every copied IOC is limited at most 10 bp from its reference price, on the tick, and SoDEX records the price the copier sent', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, slippageBps: 10 });
      t.check(c.subscription.settings.slippageBps === 10, 'a 10 bp cap');
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
      await t.live('each order\'s limit is within 10 bp of its reference, and SoDEX has it at that price', async () => {
        const orders = (await t.exec.activity(id)).filter((e) => e.kind === 'order' && e.price && e.size && e.notionalUsd);
        const tick = Number(t.main.tickSize);
        t.check(orders.length >= 2, `${orders.length} orders`);
        for (const o of orders) {
          const ref = o.notionalUsd! / o.size!;
          const ok = o.side === 'buy' ? o.price! >= ref - tick && o.price! <= ref * 1.001 + tick : o.price! <= ref + tick && o.price! >= ref * 0.999 - tick;
          t.check(ok, `${o.side} limit ${o.price} against ${ref.toFixed(4)}`);
        }
        const sent = new Set(orders.map((o) => o.price));
        const os = await copyOrders(t);
        t.check(os.length >= 2 && os.every((o) => o.tif === 'IOC' && sent.has(o.price)), 'SoDEX records each at the price sent, IOC', os.map((o) => `${o.side} ${o.price} ${o.tif}`));
      });
    },
  }),
  cm('copym.stops-follow-rules', 'The copy\'s SoDEX stops follow a change of its rules', 'a stop-loss only rests as one SoDEX stop; changed to a take-profit only, the stop-loss is cancelled and a take-profit rests; both turned off, nothing rests', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const rules = (sl: number | null, tp: number | null) => ({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, stopLossPct: sl, takeProfitPct: tp });
      const c = await t.subscribe(rules(0.5, null));
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.live('a stop-loss only: one SoDEX stop, below the mark', async () => {
        await stopsAre(t, ['sl'], 'one stop-loss and no take-profit rest on SoDEX');
        const s = (await copyStops(t))[0]!;
        t.check(s.stop!.trigger < (await t.quote()).mark && s.reduceOnly, `stop-loss at ${s.stop!.trigger}, reduce-only`);
      });
      let [u] = await t.exec.copyAct('update', { id, settings: t.settings(rules(null, 1)) });
      t.check(u?.subscription.settings.stopLossPct === null && u.subscription.settings.takeProfitPct === 1, 'now a take-profit only');
      await t.live('the stop-loss is cancelled and a take-profit rests above the mark', async () => {
        await stopsAre(t, ['tp'], 'one take-profit and no stop-loss rest on SoDEX');
        const s = (await copyStops(t))[0]!;
        t.check(s.stop!.trigger > (await t.quote()).mark, `take-profit at ${s.stop!.trigger}`);
      });
      [u] = await t.exec.copyAct('update', { id, settings: t.settings(rules(null, null)) });
      t.check(u?.subscription.settings.takeProfitPct === null, 'both off');
      await t.live('nothing rests on SoDEX that could still close the position', () => stopsAre(t, [], 'no copy stop rests on SoDEX'));
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),

  /* ------------------------------------------------------ the lifecycle ----- */
  cm('copym.pause-open', 'Paused while the leader opens', 'nothing is copied while paused (paused), a resume does not open what the leader opened meanwhile, and the leader\'s next add takes the copy to its whole target', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.exec.copyAct('pause', { id });
      await status(t, id, 'paused');
      await t.leader({ buyUsd: t.U });
      await skipped(t, id, 'paused');
      await stillFlat(t, 'nothing copied while paused', t.main.name, 0);
      await t.exec.copyAct('resume', { id });
      await status(t, id, 'active');
      await stillFlat(t, 'a resume opens nothing by itself');
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the leader\'s next add is copied in full');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  cm('copym.stop-keep', 'Stop keeping the positions', 'stopped without closing, the follower keeps the copied position and its SoDEX stop-loss, and the leader\'s close is not followed any more', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, stopLossPct: 0.5 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.live('its stop-loss rests on SoDEX', () => stopsAre(t, ['sl'], 'a copy stop-loss rests'));
      await t.exec.copyAct('stop', { id, close: false });
      const why = await status(t, id, 'stopped');
      t.check(/kept/.test(why ?? ''), `"${why}"`);
      await t.leader({ close: true });
      await t.live('the stopped copy keeps its position and its stop-loss', async () => {
        await t.sleep(20_000);
        const p = (await t.account.position(t.main.name)) * (await t.quote()).mark;
        t.check(p > t.U * 0.7, `the follower still holds $${p.toFixed(2)} (the leader is flat)`);
        t.check((await copyStops(t)).some((s) => s.stop!.kind === 'sl'), 'the stop-loss is still on SoDEX');
      });
      // The cleanup closes the kept position and cancels its stop.
    },
  }),
  cm('copym.stop-all-leaders', 'Copies of two leaders, then "stop all" with close', 'two copies run at once (the leader and a second, idle one); stop all stops both and flattens the follower on SoDEX; the leader\'s next trade is not copied', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: U }),
    async run(t) {
      const a = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const b = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, leader: { venue: t.env.leaderVenue, address: IDLE_LEADER } });
      t.check(b.subscription.settings.leader.address === IDLE_LEADER, 'a second copy of another leader');
      await ready(t, a.subscription.id);
      await status(t, b.subscription.id, 'active');
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower holds the first copy');
      const out = await t.exec.copyAct('stop-all', { close: true });
      t.check([a, b].every((c) => out.some((v) => v.subscription.id === c.subscription.id && v.subscription.status === 'stopped')), 'both copies stopped', out.map((v) => `${v.subscription.id} ${v.subscription.status}`));
      await t.expectFollowerUsd(0, 'the follower is flat after stop all', { timeoutMs: 45_000 });
      await t.leader({ buyUsd: t.U });
      await stillFlat(t, 'nothing copied after stop all');
      await t.leader({ close: true });
    },
  }),
  cm('copym.paper-and-live', 'A paper and a live copy of one leader side by side', 'the live copy trades on SoDEX and the paper copy only in its books, each about $U (SoDEX holds $U, not $2U); an executor refuses a second copy of the trader of the same kind', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const rules = { sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 };
      const first = await t.subscribe(rules);
      // A dry run has paper copies only: its second copy is of the same kind.
      const second = async (paper: boolean) => {
        const v = await t.exec.subscribe({ ...t.settings(rules), paper });
        t.copies.push(v.subscription.id);
        return v;
      };
      if (executor(t)) {
        const dup = await second(t.dry).then(() => null, (e: unknown) => String(e));
        t.check(dup !== null && /already copy this trader|duplicate|409/i.test(dup), `a second ${t.dry ? 'paper' : 'live'} copy of the trader is refused`, dup);
      } else t.note('the browser copier takes a second copy of one trader (no duplicate check; the engine keeps one copy per market)');
      if (t.dry) return;
      const paper = await second(true);
      t.check(paper.subscription.settings.paper === true, 'a paper copy next to the live one');
      await ready(t, first.subscription.id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'SoDEX holds the live copy only ($U, not $2U)');
      await t.waitFor('the paper copy holds about $U in its books', async () => {
        const v = await bookedUsd(t, paper.subscription.id);
        return Math.abs(v - t.U) <= t.U * 0.25 ? true : null;
      }, { timeoutMs: 60_000 });
      t.check((await t.exec.activity(paper.subscription.id)).some((e) => e.kind === 'fill' && e.paper), 'the paper copy\'s fills are paper');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the live copy closed with the leader');
      await t.waitFor('the paper copy closed with the leader', async () => ((await bookedUsd(t, paper.subscription.id)) === 0 ? true : null), { timeoutMs: 60_000 });
    },
  }),
  cm('copym.confirm', '"Ask me each time"', 'an executor holds a copy that asks (nobody there to ask) and copies nothing; the browser asks before every copied order: yes is sent, no is not (declined), no answer is not (confirm-timeout, a close too); switched to automatic, the copy follows the leader again without asking', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const rules = (approval: string) => ({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, approval });
      const c = await t.subscribe(rules('confirm'));
      const id = c.subscription.id;
      const auto = async () => {
        const [u] = await t.exec.copyAct('update', { id, settings: t.settings(rules('auto')) });
        t.check(u?.subscription.settings.approval === 'auto', 'automatic approval');
        await status(t, id, 'active');
      };
      if (executor(t)) {
        const why = await status(t, id, 'blocked');
        t.check(/Ask me each time/.test(why ?? ''), `held: "${why}"`);
        await t.sleep(5_000);
        await t.leader({ buyUsd: t.U });
        await skipped(t, id, 'blocked');
        await stillFlat(t, 'a held copy copies nothing', t.main.name, 0);
        await auto();
        await t.leader({ buyUsd: t.U });
        await t.expectFollowerUsd(t.U, 'the leader\'s next add is copied');
        await t.leader({ close: true });
        await t.expectFollowerUsd(0, 'the follower closed with the leader');
        return;
      }
      await ready(t, id);
      /** The prompt for this copy's next trade (live: the leader traded). */
      const prompt = () => t.waitFor('the page asks whether to copy the trade', async () => (await t.exec.copyConfirms!()).find((q) => q.subId === id) ?? null, { timeoutMs: 45_000, everyMs: 500 });
      await t.leader({ buyUsd: t.U });
      await t.live('yes: the trade is copied', async () => {
        await stillFlat(t, 'nothing is sent before the answer', t.main.name, 3_000);
        await t.exec.answerCopyConfirm!((await prompt()).id, true);
      });
      await t.expectFollowerUsd(t.U, 'answered yes, the follower opened');
      await t.leader({ buyUsd: t.U });
      await t.live('no: the add is not copied (declined)', async () => {
        await t.exec.answerCopyConfirm!((await prompt()).id, false);
        await skipped(t, id, 'declined');
      });
      await t.leader({ close: true });
      await t.live('no answer: not even the close is sent (confirm-timeout)', async () => {
        await prompt();
        await skipped(t, id, 'confirm-timeout', { timeoutMs: 90_000 });
        t.check((await t.account.position(t.main.name)) > 0, 'the follower still holds the copy');
      });
      await auto();
      await t.expectFollowerUsd(0, 'automatic again, the copy closes what the leader closed (at the next reconcile)', { timeoutMs: 120_000 });
    },
  }),

  /* ------------------------------------------------- the follower's side ----- */
  cm('copym.own-position', 'The follower\'s own position on the market', 'the leader\'s open on a market the follower holds by hand is skipped (own-position) and that position is never touched; the leader\'s other market is copied', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const own = await t.openPosition('buy', t.U);
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, assetAllow: [t.main.base, t.second.base] });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await skipped(t, id, 'own-position', { symbol: t.main.name });
      await t.leader({ buyUsd: t.U }, t.second.name);
      await t.expectFollowerUsd(t.U, `the leader's ${t.second.name} is copied`, { symbol: t.second.name });
      await t.leader({ close: true });
      await t.leader({ close: true }, t.second.name);
      await t.expectFollowerUsd(0, `the copy of ${t.second.name} closed with the leader`, { symbol: t.second.name });
      await t.live('the follower\'s own position is as it was', async () => {
        await t.sleep(10_000);
        t.check(Math.abs((await t.account.position(t.main.name)) - own) < 1e-12, `still ${own}`);
        t.check(!(await copyOrders(t)).length, `no copy order on ${t.main.name}`);
      });
    },
  }),
  cm('copym.manual-reduce', 'A copied position made smaller by hand', 'the follower sells half of the copy on SoDEX: the copy books what is left and says so (reduced-outside, a warning notice), and closes the rest with the leader', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: 2 * t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(2 * t.U, 'the follower holds $2U');
      const pos = await t.account.position(t.main.name);
      await t.onFollower('the follower sells half of it by hand', (w) => w.ioc(t.main.name, 'sell', pos / 2, { reduceOnly: true, tag: 'hand' }));
      await t.live('the copy books what is left and says it was made smaller outside it', async () => {
        await statusLine(t, id, 'reduced-outside', 150_000);
        const left = await t.account.position(t.main.name);
        await t.waitFor('the copy\'s books hold what SoDEX holds', async () => {
          const v = await t.exec.copy(id);
          const p = v.positions.find((x) => x.symbol === t.main.name)?.size ?? 0;
          return Math.abs(p - left) < 1e-9 ? true : null;
        }, { timeoutMs: 30_000 });
        await noticeOf(t, id, 'reduced', 'warn');
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the copy closed the rest with the leader');
    },
  }),
  cm('copym.manual-close', 'A copied position closed by hand', 'the follower closes the copy on SoDEX: the copy says so (closed-outside, an error notice), never opens it again by itself (the leader\'s add is skipped as own-position), and copies the leader again once the leader was flat', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 6 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      const pos = await t.account.position(t.main.name);
      await t.onFollower('the follower closes it by hand', (w) => w.close(t.main.name, pos));
      await t.live('the copy says it was closed outside it', async () => {
        await statusLine(t, id, 'closed-outside', 150_000);
        await noticeOf(t, id, 'closed', 'error');
      });
      await t.leader({ buyUsd: t.U });
      await skipped(t, id, 'own-position');
      await stillFlat(t, 'not opened again by itself', t.main.name, 0);
      await t.leader({ close: true });
      await t.sleep(5_000);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the leader\'s next open after it was flat is copied');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),
  cm('copym.manual-add', 'A copied position added to by hand', 'the follower buys more of the copied market on SoDEX: the copy takes the larger position into its books (SoDEX says what it holds) and closes all of it with the leader', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.onFollower('the follower buys $U more by hand', (w) => w.iocUsd(t.main.name, 'buy', t.U, { tag: 'hand' }));
      await t.live('the copy books what SoDEX holds', async () => {
        const held = await t.waitFor('SoDEX holds about $2U', async () => {
          const p = await t.account.position(t.main.name);
          return p * (await t.quote()).mark > 1.6 * t.U ? p : null;
        }, { timeoutMs: 20_000 });
        await t.waitFor('the copy\'s books hold it too', async () => {
          const p = (await t.exec.copy(id)).positions.find((x) => x.symbol === t.main.name)?.size ?? 0;
          return Math.abs(p - held) < 1e-9 ? true : null;
        }, { timeoutMs: 120_000, everyMs: 5_000 });
      });
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the copy closed all of it with the leader');
    },
  }),
  cm('copym.free-margin', 'Too little free margin on SoDEX for the copy', 'a copy of $1,000,000 per trade is skipped as free-margin against the follower\'s real SoDEX account: no order is sent to be refused', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: 1_000_000, allocationUsd: 1_000_000, maxPositionUsd: 1_000_000, maxLeverage: 1 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await skipped(t, id, 'free-margin');
      await t.live('no copy order was sent', async () => {
        t.check(!(await t.exec.activity(id)).some((e) => e.kind === 'order' || e.kind === 'error'), 'no order, no refusal');
        t.check((await t.account.position(t.main.name)) === 0, 'the follower holds nothing');
      });
      await t.leader({ close: true });
    },
  }),
  cm('copym.builder-low', 'The builder approval lowered under the copy fee', 'with SoDEX\'s approval at 1 bp the copy is held naming the fee and copies nothing; approved again, it resumes and copies the leader\'s next add', {
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U, walletSignatures: 2 }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      const low = 10;
      try {
        const seen = await t.onFollower(`the follower lowers its builder approval to ${low / 10} bp`, (w) => w.approveBuilder(t.env.builderId, low));
        if (!t.dry && (seen === null || seen > low)) throw new Inconclusive(`SoDEX still lists an approval of ${seen} after lowering it to ${low}`);
        // The readiness check runs every 10 minutes, and at every resume: a pause and resume asks now.
        await t.exec.copyAct('pause', { id });
        await t.exec.copyAct('resume', { id });
        if (t.dry) await status(t, id, 'active');
        else {
          const why = await status(t, id, 'blocked');
          t.check(/copy fee/.test(why ?? ''), `held: "${why}"`);
        }
        await t.leader({ buyUsd: t.U });
        await skipped(t, id, 'blocked');
        await stillFlat(t, 'a held copy opens nothing', t.main.name, 0);
      } finally {
        // Whatever happened: every scenario after this one needs the approval (not through t.onFollower, which a timed-out scenario may no longer use).
        if (!t.dry && t.env.follower) {
          const back = await t.env.follower.approveBuilder(t.env.builderId, t.env.builderFee);
          t.note(`builder approval set back to ${back}`);
        }
      }
      await t.exec.copyAct('resume', { id });
      await status(t, id, 'active', 45_000);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'approved again, the leader\'s next add is copied');
      await t.leader({ close: true });
      await t.expectFollowerUsd(0, 'the follower closed with the leader');
    },
  }),

  /* ---------------------------------------------------- restarts, tabs ----- */
  cm('copym.restart-close', 'The leader closes while the executor is down', 'after the restart the copy closes what the leader closed while no copier ran (catch-up), once', {
    needs: ['restart'],
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await t.restart({ whileDown: () => t.leader({ close: true }), downMs: 3_000 });
      await status(t, id, 'active');
      await t.expectFollowerUsd(0, 'after the restart the copy closed what the leader closed meanwhile', { timeoutMs: 150_000 });
      await t.live('one close, reduce-only; no copy order twice', async () => {
        const os = await copyOrders(t);
        const ids = os.map((o) => o.clOrdID);
        t.check(new Set(ids).size === ids.length, `${ids.length} copy orders, all distinct`);
        t.check(os.filter((o) => o.side === 'sell' && o.filled > 0).every((o) => o.reduceOnly), 'the close was reduce-only');
      });
    },
  }),
  cm('copym.tab-close', 'The browser tab closed while the leader closes', 'the browser copier runs only while a tab is open; opened again 30 s later, the copy is still running and closes what the leader closed meanwhile', {
    needs: ['tabClose'],
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2 });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened');
      await Promise.all([t.closeTab({ downMs: 30_000 }), t.sleep(5_000).then(() => t.leader({ close: true }))]);
      await status(t, id, 'active');
      await t.expectFollowerUsd(0, 'opened again, the copy closed what the leader closed while no tab ran', { timeoutMs: 150_000 });
    },
  }),

  /* -------------------------------------------------------------- slow ----- */
  cm('copym.drawdown', 'The drawdown stop fires on SoDEX prices (1% of a $10 copy)', 'the copy\'s equity falls 1% under its peak: it closes its position (drawdown-stop, reduce-only) and halts with an error notice; a halted copy copies no add; resumed it runs again', {
    slow: true,
    // What takes time is the market: the copy holds up to 4U on $10, so 1% of it is a move of 0.2-0.5% against it.
    // So it trades the market that moved most when the run started (t.volatile): 20 quiet BTC minutes did not do it (2026-10-30).
    timeoutMs: 24 * MIN,
    cost: (U) => ({ takerUsd: 8 * U, makerUsd: 0, peakUsd: 4 * U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const lev = t.expectedLeverage(5);
      const amount = Math.floor(Math.min(4 * t.U, lev * 10 * 0.95));
      const sym = t.volatile.name;
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: amount, allocationUsd: 10, maxLeverage: lev, drawdownStopPct: 0.01, assetAllow: [t.volatile.base] });
      const id = c.subscription.id;
      t.note(`$${amount} at ${lev}x on a $10 copy: 1% of it is a ${((0.1 / amount) * 100).toFixed(2)}% move against it, less its fees; on ${sym}`);
      await ready(t, id);
      await t.leader({ buyUsd: t.U }, sym);
      await t.expectFollowerUsd(amount, `the follower holds $${amount}`, { symbol: sym });
      await t.live('the drawdown stop halts the copy and closes it', async () => {
        await t.waitFor('the copy is halted by its drawdown stop', async () => ((await t.exec.copy(id)).subscription.status === 'halted' ? true : null), { timeoutMs: 20 * MIN, everyMs: 5_000, inconclusive: true });
        await t.expectFollowerUsd(0, 'the halted copy is flat', { timeoutMs: 45_000, symbol: sym });
        t.check((await legs(t, id)).includes('drawdown-stop'), 'closed by a drawdown-stop order');
        await noticeOf(t, id, 'halted', 'error');
        await t.leader({ buyUsd: t.U }, sym);
        await skipped(t, id, 'halted');
        await stillFlat(t, 'a halted copy copies no add', sym, 0);
      });
      await t.exec.copyAct('resume', { id });
      await status(t, id, 'active');
      await t.leader({ close: true }, sym);
    },
  }),

  /* --------------------------------------------- a Hyperliquid leader only ----- */
  cm('copym.hl-different-asset', 'A Hyperliquid leader trades a coin whose SoDEX market of that name is another asset', 'the copy skips it as different-asset and sends nothing, and tells the follower (the coin: one whose two prices are over 5% apart at run time; skipped if there is none)', {
    leaderVenue: 'hyperliquid',
    timeoutMs: 5 * MIN,
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const coin = await differentAsset(t);
      if (!coin) throw new Unavailable('no Hyperliquid coin is priced over 5% away from SoDEX\'s market of its name now');
      t.note(`${coin.name}: Hyperliquid ${coin.leaderPrice}, SoDEX's ${coin.market} ${coin.sodexPrice}`);
      const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, assetAllow: [coinOf('hyperliquid', coin.name)] });
      const id = c.subscription.id;
      await ready(t, id);
      await t.leaderTrade({ buyUsd: t.U }, coin.name);
      await skipped(t, id, 'different-asset');
      await t.live(`nothing is sent to ${coin.market}`, async () => {
        t.check(!(await t.exec.activity(id)).some((e) => e.kind === 'order' || e.kind === 'error'), 'no copy order, no error');
        await noticeOf(t, id, 'different-asset', 'warn');
      });
      await t.leaderTrade({ close: true }, coin.name);
    },
  }),
];

/**
 * A Hyperliquid coin (main dex) that SoDEX lists a market of the same name for, priced over 5%
 * apart from it now (MarketBook.sameAsset, as the copier decides), with one step of its size
 * worth at most a quarter of U. Null: there is none now.
 */
async function differentAsset(t: T): Promise<{ name: string; market: string; leaderPrice: number; sodexPrice: number } | null> {
  const hl = t.env.hl;
  if (!hl) throw new Unavailable('no Hyperliquid reads (the leader is not on Hyperliquid)');
  const book = new MarketBook();
  book.load(await t.env.reads.markets());
  const now = Date.now();
  for (const m of await t.env.reads.client.markPrices()) if (m.price > 0) book.setMark(m.symbol, m.price, now);
  const assets = (await hl.volumes()).filter((a) => a.name && !a.isDelisted && a.markPx > 0 && 10 ** -a.szDecimals * a.markPx <= t.U / 4 && !a.name.includes(':'));
  for (const a of assets) book.observeLeaderPrice('hyperliquid', a.name, a.markPx, now);
  const hit = uncopyable('hyperliquid', assets.sort((x, y) => y.dayNtlVlm - x.dayNtlVlm).map((a) => a.name), book, now).find((u) => u.reason === 'different-asset');
  return hit?.verdict ? { name: hit.symbol, market: hit.verdict.market, leaderPrice: hit.verdict.leaderPrice, sodexPrice: hit.verdict.sodexPrice } : null;
}
