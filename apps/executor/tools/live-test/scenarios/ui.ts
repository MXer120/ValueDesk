/**
 * ValueDesk's own pages with real money: what a person clicks, checked against SoDEX.
 * The browser target only (`needs: ['ui']`): the runner works the page in Edge with
 * the steps of apps/web/e2e/ui/uiSteps.ts - the order ticket and its review, the
 * account tables' Cancel and Close, the copy window, Manage copies, the "Copy this
 * trade?" prompt, the algo ticket and the Algos table - and the checks read SoDEX.
 *
 * The same steps run offline against the fake SoDEX account in the UI specs
 * (apps/web/e2e/ui/uiSteps.spec.ts): what passes there is the code that clicks here.
 *
 * Sizes are U ($12: SoDEX's $10 minimum plus 20%). Every scenario ends flat with
 * nothing resting - its own close, and the runner's cleanup after it - and takes
 * under 3 minutes. A dry run's page holds a throwaway wallet with no SoDEX account:
 * the ticket scenarios are skipped there (their steps are the UI specs'), the copy
 * and algo ones run their UI on paper (a paper copy, a practice bracket).
 */
import type { OrderInfo } from '../exchange.ts';
import { CheckFailed, Inconclusive, Unavailable, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/ui.ts';
const MIN = 60_000;
const LIVE_ONLY = 'the order ticket trades on the follower\'s SoDEX account, which a dry run\'s throwaway wallet does not have: the UI specs run these steps against the fake SoDEX (apps/web/e2e/ui/uiSteps.spec.ts)';

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-12;
const stepOf = (t: T) => Number(t.main.stepSize);
const tickOf = (t: T) => Number(t.main.tickSize);

function ticketScenario(id: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run'>): Scenario {
  return { id, section: 'ticket', kind: 'ticket', title, confirms, deps: ['ui'], source: SOURCE, dry: 'live', needs: ['ui'], timeoutMs: 3 * MIN, ...o };
}

/** The follower's stops on the market as SoDEX holds them. */
async function stops(t: T): Promise<OrderInfo[]> {
  return (await t.account.openOrders(t.main.name)).filter((o) => o.stop);
}

/** Wait until the follower's position on the main market satisfies `pred`; returns it. */
async function positionWhen(t: T, what: string, pred: (p: number) => boolean, timeoutMs = 30_000): Promise<number> {
  return t.waitFor(what, async () => {
    const p = await t.account.position(t.main.name);
    return pred(p) ? { p } : null;
  }, { timeoutMs }).then((x) => x.p);
}

/* ---------------------------------------------------------------- copies ----- */

async function copyStatus(t: T, id: string, want: string, timeoutMs = 30_000): Promise<void> {
  await t.waitFor(`the copy is ${want}`, async () => ((await t.exec.copy(id)).subscription.status === want ? true : null), { timeoutMs });
}

/**
 * A copy of the leader started through the copy window ($ per trade U, 2x, the main market,
 * isolated, this browser), or - when the window cannot start it (a step of the place not done) -
 * through the test bridge with the same rules, noted. Paper in a dry run.
 */
async function startCopyInWindow(t: T, o: { ask?: boolean } = {}): Promise<string> {
  const rules = { sizingMode: 'fixedNotional', fixedNotionalUsd: t.U, maxLeverage: 2, approval: o.ask ? 'confirm' : 'auto' };
  let id: string;
  try {
    ({ id } = await t.ui<{ id: string }>('copy.start', {
      leader: t.env.leaderAddress,
      venue: t.env.leaderVenue,
      perTradeUsd: t.U,
      maxLeverage: 2,
      coins: [t.main.base],
      ask: o.ask === true,
      paper: t.dry,
      isolated: true,
      // Within the follower's deposit (about $70, --budget): the window weighs the amount against the account.
      allocationUsd: 50,
    }));
    t.note(`copy ${id} started through the copy window`);
  } catch (e) {
    if (e instanceof Unavailable) throw e;
    t.note(`the copy window did not start it (${String((e as Error)?.message ?? e).slice(0, 300)}): started through the test bridge with the same rules`);
    const v = await t.subscribe(rules);
    return v.subscription.id;
  }
  t.copies.push(id);
  const s = (await t.exec.copy(id)).subscription;
  const set = s.settings;
  t.check(set.leader.address.toLowerCase() === t.env.leaderAddress.toLowerCase() && set.leader.venue === t.env.leaderVenue, `the window copies the leader ${t.env.leaderAddress} on ${t.env.leaderVenue}`, set.leader);
  t.check(set.sizingMode === 'fixedNotional' && near(set.fixedNotionalUsd, t.U, 0.01), `$${t.U} per trade, as typed`, { sizingMode: set.sizingMode, usd: set.fixedNotionalUsd });
  t.check(set.maxLeverage === 2 && set.marginMode === 'isolated', '2x isolated, as set', { maxLeverage: set.maxLeverage, marginMode: set.marginMode });
  t.check(set.approval === (o.ask ? 'confirm' : 'auto'), o.ask ? '"Ask before each trade" is on' : 'it copies without asking', set.approval);
  t.check(set.paper === t.dry, t.dry ? 'paper (a dry run)' : 'live, not paper');
  return id;
}

/** The copy is active and its leader seeded (a moment for the stream), before the leader trades. */
async function copyReady(t: T, id: string): Promise<void> {
  await copyStatus(t, id, 'active');
  await t.sleep(5_000);
}

/** The copy's orders on SoDEX (client ids vdc-), from SoDEX's history since the scenario began. */
async function copyOrders(t: T): Promise<OrderInfo[]> {
  return (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith('vdc-'));
}

export const UI_TICKET_SCENARIOS: Scenario[] = [
  ticketScenario('ticket.limit-cancel', 'Order ticket: a limit buy 2% under the bid, then Cancel in the open orders', 'SoDEX accepts the limit the ticket and its review sign and rests it at the price and size typed; the open orders table\'s Cancel takes it off SoDEX; nothing fills', {
    cost: (U) => ({ takerUsd: 0, makerUsd: 0, peakUsd: U }),
    async run(t) {
      if (t.dry) throw new Unavailable(LIVE_ONLY);
      const sym = t.main.name;
      const q = await t.quote();
      const price = t.tick(q.bid * 0.98, sym, 'down');
      const quantity = Number(await t.qty(t.U));
      const r = await t.ui<{ review: string; placed: string }>('ticket.limit', { symbol: sym, side: 'buy', price, quantity });
      t.note(`the ticket: "${r.placed}"`);
      t.check(/BUY \/ LONG/.test(r.review) && /limit @/.test(r.review), 'the review showed a limit buy', r.review.slice(0, 160));
      const o = await t.waitFor(`the limit rests on SoDEX at ${price} for ${quantity}`, async () => (await t.account.openOrders(sym)).find((x) => !x.stop && x.side === 'buy' && near(x.price, price, tickOf(t) / 2) && near(x.qty, quantity, stepOf(t) / 2)) ?? null, { timeoutMs: 30_000 });
      t.check(!o.reduceOnly && /^(GTC|1)$/i.test(o.tif), `a plain GTC limit (${o.tif}${o.reduceOnly ? ', reduce-only' : ''})`);
      t.check(o.filled === 0, 'nothing of it filled (2% under the bid)');
      await t.ui('orders.cancel', { symbol: sym, price });
      await t.waitFor('the order is gone from SoDEX', async () => ((await t.account.openOrders(sym)).some((x) => x.orderId === o.orderId) ? null : true), { timeoutMs: 30_000 });
      const h = (await t.account.history(sym)).find((x) => x.orderId === o.orderId);
      if (h) t.check(/CANCEL/i.test(h.status) && h.filled === 0, `SoDEX's history has it cancelled, unfilled (${h.status}, filled ${h.filled})`);
      else t.note('SoDEX\'s order history does not list it yet; its open orders no longer do');
      t.check((await t.account.position(sym)) === 0, 'the follower holds nothing');
    },
  }),

  ticketScenario('ticket.market-close', 'Order ticket: a market buy of U, then Close in the positions table', 'SoDEX fills the market order the ticket signs into a position of the size typed, with the builder fee on its fills; the positions table\'s Close (and its confirm) is one reduce-only market sell that leaves the account flat', {
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      if (t.dry) throw new Unavailable(LIVE_ONLY);
      const sym = t.main.name;
      const quantity = Number(await t.qty(t.U));
      const r = await t.ui<{ review: string; placed: string }>('ticket.market', { symbol: sym, side: 'buy', quantity });
      t.note(`the ticket: "${r.placed}"`);
      t.check(/market · fills at the book/.test(r.review), 'the review said it fills at the book', r.review.slice(0, 160));
      const p = await positionWhen(t, 'the position is on SoDEX', (x) => x > 0);
      t.check(near(p, quantity, stepOf(t) / 2), `SoDEX holds ${p}: the ${quantity} the ticket bought`);
      const buys = (await t.account.fills(sym)).filter((f) => f.side === 'buy');
      t.check(near(buys.reduce((a, f) => a + f.qty, 0), quantity, stepOf(t) / 2), `its fills add up to ${quantity}`);
      await t.checkBuilderFee(buys, null);
      await t.ui('positions.close', { symbol: sym });
      await positionWhen(t, 'Close left the follower flat on SoDEX', (x) => x === 0);
      const sells = (await t.account.history(sym)).filter((x) => x.side === 'sell' && x.filled > 0);
      t.check(sells.length > 0 && sells.every((x) => x.reduceOnly), `the close was reduce-only (${sells.map((x) => `${x.type} ${x.filled}${x.reduceOnly ? ' RO' : ''}`).join(', ')})`);
      t.check((await t.account.openOrders(sym)).length === 0, 'nothing rests');
    },
  }),

  ticketScenario('ticket.tpsl', 'Order ticket: a market buy with TP and SL, then Close', 'the entry\'s take-profit and stop-loss the ticket shows rest on SoDEX as reduce-only stops of the position\'s size at exactly those prices; Close leaves the account flat and no stop behind', {
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      if (t.dry) throw new Unavailable(LIVE_ONLY);
      const sym = t.main.name;
      const quantity = Number(await t.qty(t.U));
      // 1% from the entry each way: Gain and Loss typed in % (return on margin), so 1% x the ticket's leverage.
      const r = await t.ui<{ review: string; placed: string; tp: number; sl: number; leverage: number }>('ticket.market', { symbol: sym, side: 'buy', quantity, exits: { movePct: 1 } });
      t.note(`the ticket at ${r.leverage}x showed TP ${r.tp}, SL ${r.sl}: "${r.placed}"`);
      t.check(/Exits/.test(r.review) && /Take profit/.test(r.review) && /Stop loss/.test(r.review), 'the review listed both exits');
      t.check(r.tp > r.sl, `the take-profit ${r.tp} is above the stop-loss ${r.sl} (a long)`);
      const p = await positionWhen(t, 'the position is on SoDEX', (x) => x > 0);
      const both = await t.waitFor('SoDEX holds a take-profit and a stop-loss', async () => {
        const s = await stops(t);
        const tp = s.find((x) => x.stop!.kind === 'tp');
        const sl = s.find((x) => x.stop!.kind === 'sl');
        return tp && sl ? { tp, sl, all: s } : null;
      }, { timeoutMs: 30_000 });
      t.check(both.all.length === 2, `exactly two stops (${both.all.length})`);
      for (const [x, want, what] of [[both.tp, r.tp, 'take-profit'], [both.sl, r.sl, 'stop-loss']] as const) {
        t.check(near(x.stop!.trigger, want, tickOf(t) / 2), `the ${what} triggers at ${x.stop!.trigger}, the ${want} the ticket showed`);
        t.check(x.side === 'sell' && x.reduceOnly, `the ${what} is a reduce-only sell`);
        t.check(x.qty === 0 || near(x.qty, p, stepOf(t) / 2), `the ${what} is for the position's ${p} (${x.qty})`);
      }
      await t.ui('positions.close', { symbol: sym });
      await positionWhen(t, 'Close left the follower flat on SoDEX', (x) => x === 0);
      const left = await t.waitFor('no stop is left on SoDEX', async () => ((await stops(t)).length === 0 ? true : null), { timeoutMs: 30_000 }).catch(async () => stops(t));
      if (left !== true) throw new CheckFailed(`SoDEX kept ${left.length} stop(s) of the position after Close (${left.map((x) => `${x.stop!.kind} @ ${x.stop!.trigger}`).join(', ')}): the positions table's Close does not cancel them (the cleanup does)`);
    },
  }),

  ticketScenario('ticket.leverage', 'Order ticket: the leverage changed in its popover, then set back', 'SoDEX shows the market\'s leverage (and margin mode) the ticket\'s popover sends, within the EEA\'s 2x; the old setting is put back the same way', {
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0 }),
    async run(t) {
      if (t.dry) throw new Unavailable(LIVE_ONLY);
      const sym = t.main.name;
      const read = () => t.env.reads.leverage(t.env.followerAddress, sym);
      const before = await read();
      t.note(`SoDEX has ${before ? `${before.leverage}x ${before.marginMode}` : 'no leverage set'} on ${sym}`);
      const cap = Math.min(2, t.env.regionMaxLeverage ?? 2, t.main.maxLeverage);
      const want = before?.leverage === cap ? Math.max(1, cap - 1) : cap;
      if (want === before?.leverage) throw new Unavailable(`no leverage at or under ${cap}x differs from the ${before.leverage}x SoDEX has`);
      const mode = before?.marginMode ?? 'cross';
      try {
        const r = await t.ui<{ shown: string; mode: string }>('ticket.leverage', { symbol: sym, leverage: want, marginMode: mode });
        t.check(r.shown === `${want}x` && r.mode === mode, `the ticket shows ${want}x ${mode} (${r.shown} ${r.mode})`);
        await t.waitFor(`SoDEX shows ${want}x ${mode}`, async () => {
          const x = await read();
          return x && x.leverage === want && x.marginMode === mode ? true : null;
        }, { timeoutMs: 30_000 });
      } finally {
        if (before && !t.dry) {
          await t.ui('ticket.leverage', { symbol: sym, leverage: before.leverage, marginMode: before.marginMode }).catch((e) => t.note(`! setting it back through the ticket failed: ${String((e as Error)?.message ?? e)}`));
          const back = await t.waitFor(`SoDEX shows ${before.leverage}x ${before.marginMode} again`, async () => {
            const x = await read();
            return x && x.leverage === before.leverage && x.marginMode === before.marginMode ? true : null;
          }, { timeoutMs: 30_000 }).catch(() => null);
          if (!back) {
            await t.onFollower('leverage set back straight on SoDEX', (w) => w.setLeverage(sym, before.leverage, before.marginMode));
            t.note(`set back to ${before.leverage}x ${before.marginMode} with the harness's key`);
          }
        } else if (!before) t.note(`SoDEX had no leverage set on ${sym}: it stays at ${want}x (at or under the region's cap)`);
      }
    },
  }),
];

export const UI_ALGO_SCENARIOS: Scenario[] = [
  {
    id: 'algo.ui-cancel-exits',
    section: 'algo',
    kind: 'bracket',
    title: 'A bracket from the algo ticket; its exits pulled with the Algos table\'s Cancel exits',
    confirms: 'the algo ticket starts a real bracket in this browser; after its entry fills, its take-profit and stop-loss rest on SoDEX; the Algos table\'s Cancel exits (Cancel while it runs) takes both off SoDEX and leaves the position as it is',
    deps: ['algo', 'ui'],
    source: SOURCE,
    dry: 'full',
    needs: ['ui'],
    timeoutMs: 3 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const quantity = Number(await t.qty(t.U));
      let id: string;
      try {
        ({ id } = await t.ui<{ id: string }>('algo.bracket', { symbol: t.main.name, quantity, tpPct: 2, slPct: 2, practice: t.dry }));
      } catch (e) {
        if (/Real algo orders are off/.test(String((e as Error)?.message ?? e))) throw new Inconclusive('the dev web starts no real algo for this wallet: add the follower\'s address to VITE_LIVE_ALGOS_WALLETS in apps/web/.env.local and restart the dev web (README.md); it runs again next time');
        throw e;
      }
      t.algos.push(id);
      const v0 = await t.view(id);
      t.check(v0.algo.spec.kind === 'bracket' && v0.algo.spec.paper === t.dry, `a ${t.dry ? 'practice' : 'real'} bracket (${v0.algo.spec.kind})`);
      t.note(`bracket ${id} started from the algo ticket`);
      const v = await t.waitAlgo(id, 'the entry filled', (x) => x.algo.filled > 0, { timeoutMs: 60_000 });
      await t.waitFor(`its take-profit and stop-loss rest on ${t.where}`, async () => {
        const s = (await t.algoOrders(id)).filter((o) => o.stop);
        return s.length === 2 && s.every((o) => o.reduceOnly && o.side === 'sell') ? true : null;
      }, { timeoutMs: 45_000 });
      type Clicked = { button: string; next: string | null; status: string };
      let r = await t.ui<Clicked>('algo.cancelExits', { id });
      t.note(`the Algos table's row offered "${r.button}", then ${r.next ? `"${r.next}"` : 'nothing'} (${r.status})`);
      if (r.button === 'Cancel') {
        // Cancelled while it runs, it ends and leaves its exits guarding what filled; the row says so and offers Cancel exits.
        await t.waitAlgo(id, 'the bracket ended (cancelled)', (x) => ['done', 'cancelled', 'expired', 'failed'].includes(x.algo.status), { timeoutMs: 20_000 });
        await t.live('its exits still rest on SoDEX after Cancel', async () => {
          t.check((await t.algoOrders(id)).filter((o) => o.stop).length === 2, 'both exits still rest');
        });
        t.check(r.next === 'Cancel exits' && r.status === 'Exits live', `the row says "${r.status}" and offers "${r.next}"`);
        r = await t.ui<Clicked>('algo.cancelExits', { id });
      }
      t.check(r.button === 'Cancel exits' && r.next === null, `"Cancel exits" was clicked and the row offers nothing more (${r.button} -> ${r.next})`);
      await t.waitFor(`nothing of ${id} rests on ${t.where}`, async () => ((await t.algoOrders(id)).length === 0 ? true : null), { timeoutMs: 30_000 });
      const after = await t.waitAlgo(id, 'the bracket ended', (x) => ['done', 'cancelled', 'expired', 'failed'].includes(x.algo.status), { timeoutMs: 20_000 });
      t.check(!(after.exits ?? []).some((x) => x.live), 'no exit of it is live any more');
      await t.live('the position stays as it was (the exits only were pulled)', async () => {
        const p = await t.account.position(t.main.name);
        t.check(near(p, v.algo.filled, stepOf(t) / 2), `the follower still holds ${p} (filled ${v.algo.filled})`);
      });
    },
  },
];

function copyScenario(id: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run'>): Scenario {
  return { id, section: 'copy', kind: 'copy', title, confirms, deps: ['copy', 'leader', 'ui'], source: SOURCE, dry: 'lifecycle', leader: true, needs: ['ui'], timeoutMs: 3 * MIN, ...o };
}

export const UI_COPY_SCENARIOS: Scenario[] = [
  copyScenario('copy.ui-close', 'A copy started in the copy window, closed from Manage copies', 'the copy window starts the copy with the rules typed; the leader\'s open is copied on SoDEX; Manage copies\' Close ("Stop and close positions") stops the copy and closes its position with a reduce-only order: the follower is flat and copies nothing more', {
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 2 * U, leaderPeakUsd: U }),
    async run(t) {
      const id = await startCopyInWindow(t);
      await copyReady(t, id);
      await t.leader({ buyUsd: t.U });
      await t.expectFollowerUsd(t.U, 'the follower opened with the leader');
      if (t.dry) {
        // A paper copy holds nothing without a leader trade: Manage copies offers Stop, not Close.
        await t.ui('copy.manage', { id, close: false });
      } else {
        await t.ui('copy.manage', { id, close: true });
      }
      await copyStatus(t, id, 'stopped');
      await t.expectFollowerUsd(0, 'Close left the follower flat');
      await t.live('the close was the copy\'s own reduce-only order', async () => {
        const sells = (await copyOrders(t)).filter((o) => o.side === 'sell' && o.filled > 0);
        t.check(sells.length > 0 && sells.every((o) => o.reduceOnly), `${sells.length} copy sell(s), all reduce-only`);
      });
      await t.leader({ close: true });
      await t.live('a stopped copy copies nothing more', async () => {
        await t.sleep(10_000);
        t.check((await t.account.position(t.main.name)) === 0, 'the follower is still flat after the leader closed');
      });
    },
  }),

  copyScenario('copy.ui-confirm', '"Ask me each time" answered in the page\'s prompt: Copy it, then Skip', 'the copy window\'s "Ask before each trade" holds every copied order for the page\'s prompt: Copy it sends it to SoDEX, Skip sends nothing (declined); the leader\'s close, answered Copy it, closes the follower', {
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U, leaderTakerUsd: 4 * U, leaderPeakUsd: 2 * U }),
    async run(t) {
      const id = await startCopyInWindow(t, { ask: true });
      await copyReady(t, id);
      if (t.dry) return;
      await t.leader({ buyUsd: t.U });
      await t.sleep(2_000);
      t.check((await t.account.position(t.main.name)) === 0, 'nothing is sent before the answer');
      const yes = await t.ui<{ asked: string }>('copy.answer', { yes: true });
      t.note(`the prompt: "${yes.asked.slice(0, 160)}"`);
      await t.expectFollowerUsd(t.U, 'Copy it: the follower opened');
      await t.leader({ buyUsd: t.U });
      await t.ui('copy.answer', { yes: false });
      await t.waitFor('Skip: a declined line in the copy\'s activity', async () => ((await t.exec.activity(id)).some((e) => e.kind === 'skip' && e.reason === 'declined') ? true : null), { timeoutMs: 45_000 });
      await t.sleep(5_000);
      await t.expectFollowerUsd(t.U, 'Skip: the leader\'s add is not copied (the follower still holds one U)', { timeoutMs: 10_000 });
      await t.leader({ close: true });
      await t.ui('copy.answer', { yes: true });
      await t.expectFollowerUsd(0, 'the leader\'s close, answered Copy it, closed the follower');
      const os = await copyOrders(t);
      const filled = os.filter((o) => o.filled > 0);
      t.check(filled.filter((o) => o.side === 'buy').length === 1, `one copy buy reached SoDEX (the declined add did not): ${filled.map((o) => `${o.side} ${o.filled}`).join(', ')}`);
      t.check(filled.filter((o) => o.side === 'sell').every((o) => o.reduceOnly), 'the close was reduce-only');
    },
  }),
];
