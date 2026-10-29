/**
 * A follower's position liquidated by SoDEX, for real: what a stop firing does not show
 * (copy.tp-fires, bracket.tp-fires). Nothing is faked: the position is brought near its
 * liquidation as a trader on sodex.com could - the market's maximum leverage on it
 * (updateLeverage), then as much of its isolated margin taken out as SoDEX lets (updateMargin),
 * both signed with the harness's own key on the follower's account (exchange.ts) - SoDEX's own
 * liquidation price is read back and its distance logged, and the market has to move there.
 *
 * SoDEX liquidates by a takeover: the position goes to another account in a fill of SoDEX's
 * own, clOrdID "liquidation:<id>", fee 0 (docs/research/07-gaps-sodex-contract.md G7, one
 * verified historical case), with no order of the follower's. What these scenarios read is
 * that fill, the account flat, and then what the copier or the algo engine made of it.
 *
 * Slow (--slow): SoDEX gets LIQ_WAIT_MS to liquidate, and the position is about 1.25% from its
 * liquidation at 40x (BTC-USD and ETH-USD on 2026-10-29: 40x, maintenance 1.25%) - a move that
 * often takes longer: inconclusive, not failed, when it does not come. Where SoDEX keeps the
 * position further than LIQ_MAX_MARGIN (it refuses the leverage and the margin), "cannot get
 * near liquidation" is inconclusive at once. Live only: a paper book has no margin to liquidate.
 * Every target: only SoDEX-side actions are the harness's; the copier or the algo runs where
 * the target runs it. Each puts the market's leverage back as it found it once it is flat.
 */
import { RECONCILE_MS } from '../../../../../packages/copy-engine/src/index.ts';
import { CheckFailed, Inconclusive, Unavailable, algoPrefix, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/liquidation.ts';
const MIN = 60_000;
/** How long SoDEX gets to liquidate the position once it is near. */
export const LIQ_WAIT_MS = 60 * MIN;
/** The most isolated margin, of the position's value, a scenario waits with (else it cannot get near: inconclusive); its cost's bound. */
export const LIQ_MAX_MARGIN = 0.05;
/** While it waits, margin is taken out again this often (a move its way may free some, where SoDEX lets it). */
const TIGHTEN_EVERY_MS = 5 * MIN;
const LIVE_ONLY = 'a liquidation needs SoDEX\'s margin; a paper book has none to liquidate: live only';

type Risk = { size: number; entry: number; leverage: number | null; marginMode: 'cross' | 'isolated'; margin: number | null; liqPrice: number | null };

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** How far the mark is from SoDEX's liquidation price, a fraction of the mark (null: SoDEX reports none). */
function distance(r: Risk, mark: number): number | null {
  if (r.liqPrice === null || !(r.liqPrice > 0) || !(mark > 0)) return null;
  return r.size > 0 ? (mark - r.liqPrice) / mark : (r.liqPrice - mark) / mark;
}

function riskText(r: Risk, mark: number): string {
  const d = distance(r, mark);
  return `${r.size} at ${r.leverage ?? '?'}x ${r.marginMode}, isolated margin ${r.margin === null ? 'not reported' : `$${r.margin.toFixed(4)}`}, liquidation price ${r.liqPrice ?? 'not reported'} (mark ${mark}${d !== null ? `, ${pct(d)} away` : ''})`;
}

/** The follower's position on the main market as SoDEX's account state has it. */
async function risk(t: T): Promise<Risk> {
  const r = await t.env.reads.risk(t.env.followerAddress, t.main.name);
  if (!r) throw new CheckFailed(`the follower holds no position on ${t.main.name} any more`);
  return r;
}

/**
 * Take as much isolated margin out of the position as SoDEX lets: half of what it holds, halving
 * after each refusal, down to a cent, at most `tries` requests. Each step is read back from SoDEX
 * (an answer is no proof either way). Returns what was taken.
 */
async function takeMargin(t: T, tries: number): Promise<number> {
  let r = await risk(t);
  let amount = (r.margin ?? 0) / 2;
  let taken = 0;
  let refusal: string | null = null;
  for (let i = 0; i < tries && r.margin !== null && amount >= 0.01; i++) {
    const a = (Math.floor(amount * 100) / 100).toFixed(2);
    const before = r.margin;
    try {
      await t.onFollower(`take $${a} of isolated margin out`, (w) => w.moveMargin(t.main.name, `-${a}`));
    } catch (e) {
      refusal = (e instanceof Error ? e.message : String(e)).slice(0, 160);
    }
    r = await risk(t);
    if (r.margin !== null && r.margin < before - 0.005) {
      taken += before - r.margin;
      amount = r.margin / 2;
    } else amount /= 2;
  }
  if (refusal) t.note(`SoDEX's last refusal to take margin out: ${refusal}`);
  return taken;
}

/**
 * Bring the follower's open position near its liquidation: the market's maximum leverage on it,
 * then its isolated margin taken out as far as SoDEX lets; SoDEX's liquidation price read back.
 * Inconclusive ("cannot get near liquidation") when it is not isolated, SoDEX reports no
 * liquidation price, or it keeps more than LIQ_MAX_MARGIN of the position's value as margin.
 */
async function nearLiquidation(t: T): Promise<Risk> {
  let r = await risk(t);
  t.note(`before: ${riskText(r, (await t.quote()).mark)}`);
  if (r.marginMode !== 'isolated') throw new Inconclusive(`cannot get near liquidation: the position is on cross margin (the whole account backs it)`);
  const max = t.main.maxLeverage;
  try {
    await t.onFollower(`${t.main.name} at ${max}x isolated`, (w) => w.setLeverage(t.main.name, max, 'isolated'));
  } catch (e) {
    t.note(`SoDEX refused ${max}x on the open position: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
  r = await risk(t);
  t.note(`at the market's maximum leverage: ${riskText(r, (await t.quote()).mark)}`);
  const taken = await takeMargin(t, 12);
  const mark = (await t.quote()).mark;
  r = await risk(t);
  t.note(`$${taken.toFixed(4)} of margin taken out: ${riskText(r, mark)}`);
  const d = distance(r, mark);
  const value = Math.abs(r.size) * mark;
  if (d === null) throw new Inconclusive(`cannot get near liquidation: SoDEX reports no liquidation price for the position (${riskText(r, mark)})`);
  if (r.margin === null || r.margin > LIQ_MAX_MARGIN * value) {
    throw new Inconclusive(`cannot get near liquidation: SoDEX keeps ${r.margin === null ? 'an unreported margin' : `$${r.margin.toFixed(4)} of margin`} on $${value.toFixed(2)} (more than ${pct(LIQ_MAX_MARGIN)}), ${pct(d)} from its liquidation price`);
  }
  return r;
}

/**
 * Wait for SoDEX to liquidate the position, in whole or in part, taking margin out again every
 * TIGHTEN_EVERY_MS; inconclusive after LIQ_WAIT_MS. What the follower holds then, and when.
 */
async function liquidated(t: T, size0: number): Promise<{ left: number; at: number }> {
  const step = Number(t.main.stepSize);
  let tightenAt = Date.now() + TIGHTEN_EVERY_MS;
  return t.waitFor(`SoDEX liquidates the position (within ${LIQ_WAIT_MS / MIN} min)`, async () => {
    const p = await t.account.position(t.main.name);
    if (Math.abs(p) < Math.abs(size0) - step / 2) return { left: p, at: Date.now() };
    if (Date.now() >= tightenAt) {
      tightenAt = Date.now() + TIGHTEN_EVERY_MS;
      const taken = await takeMargin(t, 4);
      t.note(`still open${taken > 0 ? `, $${taken.toFixed(4)} more margin taken out` : ''}: ${riskText(await risk(t), (await t.quote()).mark)}`);
    }
    return null;
  }, { timeoutMs: LIQ_WAIT_MS, everyMs: 5_000, inconclusive: true });
}

/** SoDEX's own record of it: its fill "liquidation:<id>" (no order of ours) and the taken-over position. */
async function sodexRecord(t: T, left: number, size0: number): Promise<void> {
  const fills = await t.waitFor('SoDEX\'s fills show the liquidation (a fill "liquidation:<id>", no order of the follower\'s)', async () => {
    const f = (await t.account.fills(t.main.name)).filter((x) => x.clOrdID?.startsWith('liquidation:'));
    return f.length ? f : null;
  }, { timeoutMs: 60_000, everyMs: 5_000 });
  t.note(`liquidation fill(s): ${fills.map((f) => `${f.side} ${f.qty} @ ${f.price}, fee ${f.fee}`).join('; ')}; the follower holds ${left} of ${size0}`);
  const taken = (await t.env.reads.closedPositions(t.env.followerAddress).catch(() => [])).find((h) => h.symbol === t.main.name && h.isTakenOver);
  t.note(taken ? `positions/history: taken over at ${taken.takeOverPrice}, realized ${taken.realizedPnL}` : 'positions/history lists no taken-over position on the market (yet)');
}

/** The market's leverage and margin mode as the scenario found them, put back once the position is gone (later scenarios find SoDEX as they left it). */
async function restoreLeverage(t: T, before: { leverage: number; marginMode: 'cross' | 'isolated' } | null): Promise<void> {
  const w = t.env.follower;
  if (t.dry || !w) return;
  const want = before ?? { leverage: t.expectedLeverage(2), marginMode: 'isolated' as const };
  try {
    const p = await t.env.reads.position(t.env.followerAddress, t.main.name);
    // A margin mode never changes under an open position: closed first (reduce-only; the cleanup would close it next).
    if (p !== 0) await w.close(t.main.name, p);
    for (let i = 0; i < 10 && (await t.env.reads.position(t.env.followerAddress, t.main.name)) !== 0; i++) await new Promise((r) => setTimeout(r, 1_000));
    await w.setLeverage(t.main.name, want.leverage, want.marginMode);
    t.note(`${t.main.name} back at ${want.leverage}x ${want.marginMode}`);
  } catch (e) {
    t.note(`! ${t.main.name}'s leverage not put back to ${want.leverage}x ${want.marginMode}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
}

/** The copy's position stops on SoDEX (client ids vds-). */
async function copyStops(t: T) {
  return (await t.account.openOrders(t.main.name)).filter((o) => o.clOrdID?.startsWith('vds-') && o.stop);
}

/** An error notice for `ref` where the target's notices are read from here (an executor's GET /notices); the browser's are its bell. */
async function errorNotice(t: T, ref: string): Promise<void> {
  const read = t.exec.notices?.bind(t.exec);
  if (!read) {
    t.note(`the ${t.env.target.name} target keeps its notices in the page's bell: not read here (its activity is checked)`);
    return;
  }
  await t.waitFor(`an error notice for ${ref} in the wallet's notices`, async () => ((await read(50)).some((n) => n.ref === ref && n.kind === 'closed' && n.grade === 'error') ? true : null), { timeoutMs: 60_000 });
}

export const LIQ_SCENARIOS: Scenario[] = [
  {
    id: 'liq.algo-exits',
    section: 'algo',
    kind: 'liq',
    title: 'An algo\'s filled position with exits, liquidated by SoDEX',
    confirms: 'SoDEX\'s liquidation record (its "liquidation:" fill, the account flat); what SoDEX does with the position\'s stops then; no exit opens anything, and none is left resting for a position that is gone',
    deps: ['algo'],
    source: SOURCE,
    dry: 'live',
    slow: true,
    timeoutMs: 75 * MIN,
    // The entry, and the cleanup's close when no liquidation comes; the margin lost when it does.
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leverage: 2, lostUsd: U * LIQ_MAX_MARGIN }),
    async run(t) {
      if (t.dry) throw new Unavailable(LIVE_ONLY);
      const before = await t.env.reads.leverage(t.env.followerAddress, t.main.name);
      try {
        // Exits 20% away: both far past the liquidation once the position is at the market's maximum leverage.
        const v0 = await t.start({ kind: 'bracket', quantity: await t.qty(t.U), entry: 'market', slippageBps: 30, leverage: t.expectedLeverage(2), marginMode: 'isolated', exits: { tpPct: 0.2, slPct: 0.2 } });
        const id = v0.algo.id;
        await t.waitAlgo(id, 'the entry filled', (x) => x.algo.filled > 0, { timeoutMs: 30_000 });
        await t.waitFor(`take-profit and stop-loss rest on ${t.where}`, async () => ((await t.algoOrders(id)).filter((o) => o.stop).length === 2 ? true : null), { timeoutMs: 45_000 });
        const size0 = await t.account.position(t.main.name);
        await nearLiquidation(t);
        const { left, at } = await liquidated(t, size0);
        await sodexRecord(t, left, size0);
        // What SoDEX did with the position's stops, and what the algo says - once it had a minute to hear.
        await t.sleep(60_000);
        const hist = (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith(algoPrefix(id)) && o.stop);
        t.note(`SoDEX's history of the exits: ${hist.map((o) => `${o.stop!.kind} ${o.status} filled ${o.filled}`).join('; ') || 'none listed'}`);
        const v = await t.view(id);
        t.note(`the algo: ${v.algo.status}, exits ${(v.exits ?? []).map((e) => `${e.kind}${e.live ? ' live' : ' over'}`).join(', ') || 'none'}; last events: ${(await t.exec.events(id, 5)).map((e) => e.text).join(' | ')}`);
        const read = t.exec.notices?.bind(t.exec);
        if (read) t.note(`notices for it since the liquidation: ${(await read(50)).filter((n) => n.ref === id && n.at >= at - 60_000).map((n) => `${n.grade} ${n.title}`).join('; ') || 'none (FINDING liquidated, algo)'}`);
        if (left !== 0) {
          t.note(`a partial liquidation: ${left} left; the exits, sized to what the algo filled, are reduce-only and close no more than that`);
          return;
        }
        t.check((await t.account.position(t.main.name)) === 0, 'still flat: no exit opened anything (they are reduce-only)');
        const resting = (await t.algoOrders(id)).filter((o) => o.stop);
        t.check(resting.length === 0, 'no exit of the algo is left resting on SoDEX for the position that is gone (ce/edge-algo.test.ts "FINDING liquidated, algo" while it is)', resting.map((o) => `${o.stop!.kind} ${o.qty}`));
      } finally {
        await restoreLeverage(t, before);
      }
    },
  },
  {
    id: 'liq.copy-follower',
    section: 'copy',
    kind: 'liq',
    title: 'The follower\'s copied position liquidated by SoDEX',
    confirms: 'SoDEX liquidates a copied position (its "liquidation:" fill, the account flat); the copy calls it closed outside the copier with an error notice, pulls its SoDEX stops, opens nothing by itself, and copies the leader\'s next open at its own leverage again',
    deps: ['copy', 'leader'],
    source: SOURCE,
    dry: 'live',
    leader: true,
    slow: true,
    timeoutMs: 80 * MIN,
    // The copy opens twice and closes once; the leader opens, adds, closes, opens and closes.
    cost: (U) => ({ takerUsd: 3 * U, makerUsd: 0, peakUsd: U, leverage: 2, leaderTakerUsd: 6 * U, leaderPeakUsd: 2 * U, lostUsd: U * LIQ_MAX_MARGIN }),
    async run(t) {
      if (t.dry) throw new Unavailable(LIVE_ONLY);
      const before = await t.env.reads.leverage(t.env.followerAddress, t.main.name);
      const lev = t.expectedLeverage(2);
      try {
        // Its stops far out (90% of the margin, 100% of it as profit): SoDEX holds them, so the copier has stops to pull when the position goes.
        const c = await t.subscribe({ sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, marginMode: 'isolated', stopLossPct: 0.9, takeProfitPct: 1 });
        const id = c.subscription.id;
        await t.waitFor('the copy is active and its leader seeded', async () => ((await t.exec.copy(id)).subscription.status === 'active' ? true : null), { timeoutMs: 30_000 });
        await t.sleep(5_000);
        await t.leader({ buyUsd: t.U });
        await t.expectFollowerUsd(t.U, 'the follower copied the leader\'s long');
        const l0 = await t.env.reads.leverage(t.env.followerAddress, t.main.name);
        t.check(l0?.leverage === lev && l0.marginMode === 'isolated', `SoDEX holds the copy at ${lev}x isolated (its cap and the region's)`, l0);
        await t.waitFor('the copy\'s stop-loss and take-profit rest on SoDEX', async () => ((await copyStops(t)).length === 2 ? true : null), { timeoutMs: 60_000 });
        const size0 = await t.account.position(t.main.name);
        await nearLiquidation(t);
        const { left, at } = await liquidated(t, size0);
        await sodexRecord(t, left, size0);
        if (left !== 0) {
          // In part: the copy holds what SoDEX left and buys nothing back by itself (the rest is ce/edge-liquidation.test.ts).
          const step = Number(t.main.stepSize);
          await t.waitFor(`the copy holds what SoDEX left (${left})`, async () => {
            const p = (await t.exec.copy(id)).positions.find((x) => x.symbol === t.main.name)?.size ?? 0;
            return Math.abs(p - left) <= step / 2 || p === 0 ? true : null;
          }, { timeoutMs: 90_000 });
          await t.sleep(RECONCILE_MS + 15_000);
          const sent = (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith('vdc-') && o.createdAt > at);
          t.check(sent.length === 0, 'no copy order since the partial liquidation: nothing bought back by itself', sent.map((o) => o.clOrdID));
          await t.leader({ close: true });
          await t.expectFollowerUsd(0, 'the copy closes what is left with the leader');
          return;
        }
        // In full: the copier's view of it.
        await t.waitFor('the copy\'s activity says it was closed outside the copier', async () => ((await t.exec.activity(id)).some((e) => e.kind === 'status' && e.reason === 'closed-outside' && e.symbol === t.main.name) ? true : null), { timeoutMs: 90_000 });
        await errorNotice(t, `${id}:${t.main.name}`);
        await t.waitFor('no copy stop is left on SoDEX', async () => ((await copyStops(t)).length === 0 ? true : null), { timeoutMs: 60_000 });
        // Not opened again by itself: a reconcile goes by, and the leader adds meanwhile.
        await t.leader({ buyUsd: t.U });
        await t.sleep(RECONCILE_MS + 15_000);
        t.check((await t.account.position(t.main.name)) === 0, 'still flat: the copy opened nothing by itself, nor on the leader\'s add');
        const sent = (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith('vdc-') && o.createdAt > at);
        t.check(sent.length === 0, 'no copy order on SoDEX since the liquidation', sent.map((o) => o.clOrdID));
        t.check((await t.exec.activity(id)).some((e) => e.kind === 'skip' && e.reason === 'own-position' && e.at > at), 'the leader\'s add is skipped, and said: the market waits for the leader to be flat');
        // The leader closes and opens again: copied, at the copy's leverage again (not the one the harness set).
        await t.leader({ close: true });
        await t.leader({ buyUsd: t.U });
        await t.expectFollowerUsd(t.U, 'the copy follows the leader\'s next open');
        const l1 = await t.env.reads.leverage(t.env.followerAddress, t.main.name);
        t.check(l1?.leverage === lev && l1.marginMode === 'isolated', `SoDEX holds the new copy at ${lev}x isolated again`, l1);
        await t.leader({ close: true });
        await t.expectFollowerUsd(0, 'and closes it with the leader');
      } finally {
        await restoreLeverage(t, before);
      }
    },
  },
];
