/**
 * The final cross-check: SoDEX's own records against the run's book.
 *
 * Throughout the run, order states and fills came from the account stream
 * (stream.ts) and from what the guard saw leave (ledger.ts) - not from SoDEX's
 * order history and fill history, because those two routes take about four
 * requests a minute per IP (history.ts). Here, once, they are read: the order
 * history and the fills of each engine, FOUR requests in all, 35 s apart, and
 * only when the server's fee verifier is not reading the same routes.
 *
 * Then, read-only:
 *   - every order the run sent is looked up in SoDEX's history: side, type,
 *     executed quantity, final state;
 *   - every fill of the history is matched to an order of the run, and to the
 *     stream's report of it (same price, quantity, fee, builder fee);
 *   - every fill's fees are judged again, now with the fee coin the history names;
 *   - every order record must name the builder the order carried - or none;
 *   - the builder account's balances, read by its public address, must have
 *     risen by the builder fees the run's fills paid;
 *   - nothing is left open.
 * This step signs nothing and sends nothing.
 */
import { canonicalDecimal } from '@sodex-core';
import { holdsAll } from '../../src/exchange/historyTables';
import { CheckFailure, SafetyStop, scenario, type Ctx } from './context';
import { builderFeeSum, fillFromHistory, fillKey, fillRow, type Engine, type Fill } from './fees';
import type { LedgerOrder } from './ledger';
import { defaultFee, judgeFills, sameBuilder, waitMaybe } from './orders';
import { recordSpotBuyRule } from './orderSteps';
import { accountUsdc, historyFills, historyOrders, openOrders, positions, type HistoryOrder } from './reads';
import { requestTerms } from './terms';
import { judgeFeeScenario } from './tierSteps';
import { approx, cut, dAdd, dCmp, dSub, dur, errText, pollUntil } from './util';

const ENGINES: readonly Engine[] = ['perps', 'spot'];
/** SoDEX's final order states (types/rest.ts) - TRIGGERED: a take-profit / stop-loss that fired and handed over to its child order. */
const FINAL = new Set(['FILLED', 'CANCELED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'REPLACED', 'TRIGGERED']);
/** What the stream's report of a fill and the history's row of it must agree on. */
const FILL_FIELDS = ['side', 'price', 'quantity', 'fee', 'builderFee'] as const;
const canon = (v: unknown): string => {
  try {
    return canonicalDecimal(String(v ?? '0'));
  } catch {
    return String(v);
  }
};
const some = <T>(list: readonly T[], n = 5): T[] => list.slice(0, n);
const ref = (o: Pick<LedgerOrder, 'orderID' | 'clOrdID' | 'label'>): string => `${o.label} (${o.orderID !== null ? `#${o.orderID}` : `clOrdID ${o.clOrdID}`})`;

/** The orders of this run on one engine: sent by the app or by the runner itself. */
const sentOn = (ctx: Ctx, engine: Engine): LedgerOrder[] => ctx.ledger.orders.filter((o) => o.engine === engine && o.origin !== 'sodex');

function compareOrders(ctx: Ctx, engine: Engine, rows: readonly HistoryOrder[]): void {
  const id = `cross-orders-${engine}`;
  const mine = sentOn(ctx, engine);
  const byId = new Map(rows.filter((r) => typeof r.orderID === 'number').map((r) => [r.orderID!, r]));
  const byCl = new Map(rows.filter((r) => typeof r.clOrdID === 'string' && r.clOrdID).map((r) => [r.clOrdID!, r]));
  const rowOf = (o: LedgerOrder): HistoryOrder | undefined => (o.orderID !== null ? byId.get(o.orderID) : undefined) ?? (o.clOrdID ? byCl.get(o.clOrdID) : undefined);
  const wrong: string[] = [];
  const missingFilled: string[] = [];
  const missingQuiet: string[] = [];
  let found = 0;
  for (const o of mine) {
    const row = rowOf(o);
    const fills = ctx.ledger.fillsOf(engine, o);
    const filled = fills.reduce((s, f) => dAdd(s, f.quantity), '0');
    if (o.accepted === false) {
      // SoDEX said no. A rejected order may or may not be listed; it must not have executed.
      if (row && dCmp(canon(row.executedQty), '0') > 0) wrong.push(`${ref(o)} was REJECTED when sent, yet the history shows ${row.executedQty} executed`);
      if (fills.length) wrong.push(`${ref(o)} was REJECTED when sent, yet ${fills.length} fill(s) name it`);
      if (row) found += 1;
      continue;
    }
    if (!row) {
      (fills.length ? missingFilled : missingQuiet).push(ref(o));
      continue;
    }
    found += 1;
    const side = String(row.side ?? '').toUpperCase();
    const type = String(row.type ?? '').toUpperCase();
    const status = String(row.status ?? '').toUpperCase();
    if (side && side !== o.side) wrong.push(`${ref(o)}: the history says ${side}, it was sent as ${o.side}`);
    if (type && type !== o.type) wrong.push(`${ref(o)}: the history says ${type}, it was sent as ${o.type}`);
    if (status && !FINAL.has(status)) wrong.push(`${ref(o)}: the history says ${status} - not a final state`);
    if (row.executedQty !== undefined && canon(row.executedQty) !== canon(filled)) wrong.push(`${ref(o)}: the history says ${row.executedQty} executed, the fills add up to ${filled}`);
    if (status === 'FILLED' && o.quantity && row.executedQty !== undefined && canon(row.executedQty) !== canon(o.quantity)) wrong.push(`${ref(o)}: FILLED with ${row.executedQty}, ordered ${o.quantity}`);
  }
  const evidence = { sent: mine.length, inHistory: found, historyRows: rows.length, problems: some(wrong, 10), notListedWithFills: some(missingFilled, 10), notListedWithoutFills: some(missingQuiet, 20) };
  if (!mine.length) ctx.checks.set(id, 'not-run', `this run sent no ${engine} order`, evidence);
  else if (wrong.length || missingFilled.length) {
    ctx.checks.fail(id, [...(missingFilled.length ? [`${missingFilled.length} order(s) that FILLED are not in SoDEX's ${engine} order history: ${some(missingFilled, 3).join('; ')}`] : []), ...some(wrong, 3)].join(' | '), evidence);
  } else if (missingQuiet.length) {
    ctx.checks.finding(
      id,
      `${found} of ${mine.length} order(s) are in SoDEX's ${engine} order history as the run recorded them; ${missingQuiet.length} that never executed are NOT listed there (${some(missingQuiet, 3).join('; ')}${missingQuiet.length > 3 ? '; ...' : ''}) - SoDEX's history leaves out some orders that expired or were refused without a fill`,
      evidence,
    );
  } else ctx.checks.pass(id, `all ${mine.length} ${engine} order(s) the run sent are in SoDEX's order history: same side, type and executed quantity, each in a final state`, evidence);
}

function compareFills(ctx: Ctx, engine: Engine, fromHistory: readonly Fill[]): void {
  const id = `cross-fills-${engine}`;
  const wrong: string[] = [];
  const strangers: string[] = [];
  const h = new Map(fromHistory.map((f) => [fillKey(f), f]));
  for (const f of fromHistory) {
    const o = ctx.ledger.orderOf(f);
    if (!o || o.origin === 'sodex') strangers.push(`${f.side} ${f.quantity} ${f.symbol} @ ${f.price} (order #${f.orderID ?? '?'}, trade ${f.tradeID ?? '?'})`);
    const s = ctx.ledger.streamFills.get(fillKey(f));
    if (!s) continue;
    const diff = FILL_FIELDS.filter((k) => (k === 'side' ? s.side !== f.side : canon(s[k] ?? '0') !== canon(f[k] ?? '0')));
    if (diff.length) wrong.push(`trade ${f.tradeID} of order #${f.orderID}: the stream and the history differ in ${diff.join(', ')} (stream ${diff.map((k) => String(s[k])).join(' / ')}, history ${diff.map((k) => String(f[k])).join(' / ')})`);
  }
  // A fill the stream reported that the history does not hold.
  const onlyStream = [...ctx.ledger.streamFills.values()].filter((f) => f.engine === engine && !h.has(fillKey(f)));
  for (const f of onlyStream) wrong.push(`the stream reported trade ${f.tradeID} of order #${f.orderID} (${f.side} ${f.quantity} @ ${f.price}); SoDEX's fill history does not list it`);
  const evidence = { historyFills: fromHistory.length, streamFills: [...ctx.ledger.streamFills.values()].filter((f) => f.engine === engine).length, problems: some(wrong, 10), fillsOfOrdersTheRunDidNotSend: some(strangers, 10), builderFees: builderFeeSum(fromHistory) };
  if (!fromHistory.length && !sentOn(ctx, engine).length) ctx.checks.set(id, 'not-run', `this run sent no ${engine} order`, evidence);
  else if (wrong.length) ctx.checks.fail(id, some(wrong, 3).join(' | '), evidence);
  else if (strangers.length) {
    ctx.checks.finding(
      id,
      `${fromHistory.length - strangers.length} fill(s) belong to orders of the run and match what it recorded; ${strangers.length} more belong to orders the run did not send (${some(strangers, 2).join('; ')}) - an order SoDEX created itself (a triggered exit), or other activity on this account during the run`,
      evidence,
    );
  } else ctx.checks.pass(id, `${fromHistory.length} ${engine} fill(s) in SoDEX's history, each of an order the run sent${evidence.streamFills ? ', each as the stream reported it (price, quantity, fee, builder fee)' : ''}`, evidence);
}

export async function stepCrossCheck(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const limiter = ctx.history;
  if (!limiter) throw new SafetyStop('the history limiter is not set up (plan mode never reads the history)');
  const b = ctx.cfg.builder;
  const sent = ctx.ledger.orders.filter((o) => o.origin !== 'sodex');

  // --- 1. the end state (a plain read, before anything else) ------------------------------------------------------------
  await scenario(ctx, 'cross-end-state', async () => {
    const [so, po, pos] = await Promise.all([openOrders('spot', owner), openOrders('perps', owner), positions(owner)]);
    const open = pos.filter((p) => approx(p.size) !== 0);
    const wrong: string[] = [];
    if (so.length) wrong.push(`${so.length} spot order(s) open (${some(so, 3).map((o) => `${o.symbol} #${o.orderID}`).join(', ')})`);
    if (po.length) wrong.push(`${po.length} perps order(s) open (${some(po, 3).map((o) => `${o.symbol} #${o.orderID}`).join(', ')})`);
    if (open.length) wrong.push(`position(s) open: ${open.map((p) => `${p.symbol} ${p.size}`).join(', ')}`);
    if (ctx.inFlight.length) wrong.push(`${ctx.inFlight.length} transfer(s) in flight: ${ctx.inFlight.map((f) => f.what).join('; ')}`);
    if (wrong.length) throw new CheckFailure(`${wrong.join('; ')} - close them in the app (Orders / Positions tabs)`, { spotOrders: some(so), perpsOrders: some(po), positions: open });
    ctx.checks.pass('cross-end-state', 'no open order on either engine, no position, nothing in flight', {});
  });

  const needOrders = ['cross-orders-perps', 'cross-orders-spot', 'cross-fills-perps', 'cross-fills-spot', 'cross-stream-vs-rest', 'builder-order-records'];
  if (!sent.length) {
    for (const id of needOrders) ctx.checks.set(id, 'not-run', 'this process sent no order: there is nothing to reconcile (run the order steps and this one in the same run)');
    if (!ctx.checks.get('builder-income-matches')) ctx.checks.set('builder-income-matches', b ? 'not-run' : 'skipped', b ? 'this process sent no order' : 'no builder in this run');
    return;
  }

  // --- 2. not while the server's verifier reads the same routes ---------------------------------------------------------
  if (ctx.terms) {
    const watch = ctx.terms;
    // At most two minutes: "pending" also covers orders waiting for explorer lookups (which use no history budget),
    // and the run's reads, 35 s apart, plus the verifier's one a minute stay under SoDEX's four a minute anyway.
    const r = await pollUntil({
      timeoutMs: Math.min(ctx.cfg.timeouts.verifierMinutes, 2) * 60_000,
      intervalMs: 10_000,
      probe: async () => (await requestTerms(watch, owner)).verdict,
      done: (v) => v.off || !v.answer.volume || !v.answer.volume.pending,
      progressEveryMs: 30_000,
      progress: (_v, ms) => rec.line(`... ${dur(ms)} waiting: the server's fee verifier is reading this wallet's order history (it shares SoDEX's four-a-minute limit)`, 7),
    });
    const at = r.ok ? r.value.answer.volume?.verifiedAt ?? null : null;
    if (!r.ok) rec.warn('history', `the server still reports a verification pending after ${dur(r.ms)} - the history is read all the same, 35 s apart`);
    // What the verifier read last came out of the same budget.
    if (at && at <= Date.now()) limiter.touch(at);
  }

  // --- 3. the four reads --------------------------------------------------------------------------------------------------
  // A minute of slack before the start: SoDEX's clock and this one's need not agree to the second.
  const since = ctx.startedAtMs - 60_000;
  rec.line(`reading SoDEX's order history and fills since ${new Date(since).toISOString()}: four requests, one every ${Math.round(limiter.minGapMs / 1000)} s (the two routes take about four a minute per IP)`, 5);
  const orders: Record<Engine, HistoryOrder[]> = { perps: [], spot: [] };
  const fills: Record<Engine, Fill[]> = { perps: [], spot: [] };
  const unread: string[] = [];
  for (const engine of ENGINES) {
    if (!sentOn(ctx, engine).length) continue;
    try {
      orders[engine] = await rec.sub(`${engine}: order history`, () => historyOrders(limiter, engine, owner, { startTime: since, limit: 1000 }), (l) => `${l.length} order(s)`);
      for (const row of orders[engine]) ctx.ledger.noteRecord(engine, row as Record<string, unknown>, 'history');
    } catch (e) {
      unread.push(`${engine} order history: ${errText(e)}`);
    }
    try {
      const rows = await rec.sub(`${engine}: fills`, () => historyFills(limiter, engine, owner, { startTime: since, limit: 1000 }), (l) => `${l.length} fill(s)`);
      fills[engine] = rows.map((r) => fillFromHistory(engine, r)).filter((f): f is Fill => f !== null);
      for (const f of fills[engine]) ctx.ledger.noteFill(f);
    } catch (e) {
      unread.push(`${engine} fills: ${errText(e)}`);
    }
  }
  if (unread.length) rec.warn('history', unread.join(' | '));
  const readOk = (what: string): boolean => !unread.some((u) => u.startsWith(what));

  // --- 4. orders and fills against the run's book ----------------------------------------------------------------------------
  for (const engine of ENGINES) {
    if (!sentOn(ctx, engine).length) {
      ctx.checks.set(`cross-orders-${engine}`, 'not-run', `this run sent no ${engine} order`);
      ctx.checks.set(`cross-fills-${engine}`, 'not-run', `this run sent no ${engine} order`);
      continue;
    }
    if (readOk(`${engine} order history`)) compareOrders(ctx, engine, orders[engine]);
    else ctx.checks.fail(`cross-orders-${engine}`, `SoDEX's ${engine} order history could not be read: ${unread.find((u) => u.startsWith(`${engine} order history`))}`);
    if (readOk(`${engine} fills`)) compareFills(ctx, engine, fills[engine]);
    else ctx.checks.fail(`cross-fills-${engine}`, `SoDEX's ${engine} fills could not be read: ${unread.find((u) => u.startsWith(`${engine} fills`))}`);
  }

  // --- 5. the fees, judged again from the history rows (they name the fee coin) ------------------------------------------------
  await judgeFills(ctx);
  for (const [id, fee] of [['builder-fee-default', ctx.tiers.defaultFee], ['builder-fee-lowered', ctx.tiers.loweredFee]] as const) {
    const now = ctx.checks.statusOf(id);
    if (fee !== undefined && (now === 'not-run' || now === 'pass')) judgeFeeScenario(ctx, id, fee);
  }
  {
    const now = ctx.checks.statusOf('builder-spot-buy-not-charged');
    if (b && defaultFee(ctx, 'spot') > 0 && (now === null || now === 'not-run' || now === 'pass') && [...ctx.fillChecks.values()].some((c) => c.fill.engine === 'spot')) recordSpotBuyRule(ctx);
  }

  // --- 6. the stream against the history: the app's own question -----------------------------------------------------------------
  await scenario(ctx, 'cross-stream-vs-rest', async () => {
    const stream = ctx.stream;
    if (!stream) {
      ctx.checks.skip('cross-stream-vs-rest', 'the account stream was not connected in this run: order states and fills came from polling and from this history read');
      return;
    }
    if (ENGINES.every((e) => stream.readySince[e] === null)) {
      ctx.checks.skip('cross-stream-vs-rest', `the account stream never had its subscriptions accepted in this run (${JSON.stringify(stream.describe())}): there is nothing to compare`);
      return;
    }
    const lines: string[] = [];
    const wrong: string[] = [];
    const news: string[] = [];
    for (const engine of ENGINES) {
      if (!sentOn(ctx, engine).length || !readOk(`${engine} fills`) || !readOk(`${engine} order history`)) continue;
      const w = stream.wants[engine];
      // The app's own test (exchange/historyTables.ts): does the history hold everything the stream reported?
      const rawFills = fills[engine].map((f) => ({ symbol: f.symbol, tradeID: f.tradeID, orderID: f.orderID }));
      if (!holdsAll('trades', w, rawFills, (r: { symbol: string; tradeID: number | null; orderID: number | null }) => `${r.symbol}:${r.tradeID}:${r.orderID}`)) wrong.push(`${engine}: the fill history lacks a fill the stream reported`);
      if (!holdsAll('orders', w, orders[engine], (r: HistoryOrder) => String(r.orderID))) {
        // Which ones: an order the history does not list, or lists in another state. The app's history
        // table asks exactly this before it spends one of its two reads a minute - so it is worth knowing.
        const byId = new Map(orders[engine].map((r) => [String(r.orderID), String(r.status ?? '').toUpperCase()]));
        const off = [...w.orders].filter(([id, status]) => byId.get(id) !== status).map(([id, status]) => `#${id}: the stream said ${status}, the history ${byId.has(id) ? `says ${byId.get(id)}` : 'does not list it'}`);
        news.push(`${engine}: ${off.length} order(s) the stream reported final are not in the order history in that state (${some(off, 3).join('; ')}) - the app's order-history table would read again after each of them`);
      }
      // And the other way round: every fill of the history was pushed - from the moment SoDEX accepted the
      // subscription (a brand-new wallet's account did not exist before its first deposit: nothing earlier was pushed).
      const since = stream.readySince[engine];
      const before = fills[engine].filter((f) => !ctx.ledger.streamFills.has(fillKey(f)) && (since === null || (f.time !== null && f.time < since)));
      if (before.length) news.push(`${engine}: ${before.length} fill(s) happened before the stream's subscription was accepted${since ? ` (${new Date(since).toISOString()})` : ' (it never was)'} - not pushed, as expected`);
      const unseen = fills[engine].filter((f) => !ctx.ledger.streamFills.has(fillKey(f)) && !before.includes(f));
      if (unseen.length) {
        const text = `${engine}: ${unseen.length} fill(s) of the history were never pushed on the stream (${some(unseen, 2).map((f) => `trade ${f.tradeID}`).join(', ')})`;
        if (stream.gaps[engine] > 0) news.push(`${text} - the stream reconnected ${stream.gaps[engine]} time(s), pushes in between are lost`);
        else wrong.push(text);
      }
      lines.push(`${engine}: ${fills[engine].length} fill(s), ${w.orders.size} order(s) the stream reported final`);
    }
    const evidence = { ...stream.describe(), compared: lines, findings: news, problems: wrong };
    if (wrong.length) throw new CheckFailure(wrong.join(' | '), evidence);
    if (news.length) ctx.checks.finding('cross-stream-vs-rest', news.join(' | '), evidence);
    else ctx.checks.pass('cross-stream-vs-rest', `the history holds everything the stream reported, and the stream reported every fill the history lists (${lines.join('; ')})`, evidence);
  });

  // --- 7. every order record names the builder the order carried ------------------------------------------------------------------
  await scenario(ctx, 'builder-order-records', async () => {
    // A replacement has no builder of its own to compare: what SoDEX records for it is the G6 finding.
    const mine = sent.filter((o) => o.accepted === true && !o.replaces);
    const seen = mine.filter((o) => o.recordBuilder !== undefined);
    const bad = seen.filter((o) => !sameBuilder(o.recordBuilder, o.builder));
    const text = (v: LedgerOrder['recordBuilder']): string => (v ? `#${v.id} at ${v.fee}` : 'none');
    const evidence = {
      orders: mine.length,
      recordsSeen: seen.length,
      withBuilder: seen.filter((o) => o.recordBuilder).length,
      mismatches: some(bad, 10).map((o) => ({ order: ref(o), carried: o.builder, record: o.recordBuilder })),
      noRecord: some(mine.filter((o) => o.recordBuilder === undefined).map(ref), 10),
    };
    if (bad.length) throw new CheckFailure(`${bad.length} of ${seen.length} order record(s) do not name what the order carried: ${some(bad, 3).map((o) => `${ref(o)} carried ${text(o.builder)}, the record says ${text(o.recordBuilder)}`).join('; ')}`, evidence);
    if (!seen.length) {
      ctx.checks.set('builder-order-records', 'not-run', "no open-order row and no order update on the stream was seen for the run's orders (a finished order in SoDEX's order history names no builder)", evidence);
      return;
    }
    if (!b) ctx.checks.pass('builder-order-records', `no builder in this run: none of the ${seen.length} order record(s) names one`, evidence);
    else ctx.checks.pass('builder-order-records', `${seen.length} order record(s): ${evidence.withBuilder} name builder #${b.id} with exactly the fee the order carried, ${seen.length - evidence.withBuilder} carried none and name none`, evidence);
  });

  // --- 8. the builder account's income ------------------------------------------------------------------------------------------
  await scenario(ctx, 'builder-income-matches', async () => {
    if (!b) {
      ctx.checks.skip('builder-income-matches', 'no builder in this run');
      return;
    }
    if (!b.address) {
      ctx.checks.skip('builder-income-matches', 'builder.address is not set in the config: the builder account\'s balances cannot be read (it is the account\'s public address, never a key)');
      return;
    }
    const base = ctx.builderBaseline;
    if (!base || base.spot === null || base.perps === null) {
      ctx.checks.set('builder-income-matches', 'not-run', base ? 'the builder account\'s balances could not be read before the run\'s first order' : 'no order was placed in this process: there is no balance from before to compare with');
      return;
    }
    if (!readOk('perps fills') || !readOk('spot fills')) {
      ctx.checks.set('builder-income-matches', 'not-run', 'the fill history could not be read: the builder fees of the run are not known in full');
      return;
    }
    // What the run's fills say they paid the builder, per engine (perps: every fill; spot: sells), in vUSDC.
    const paid = { perps: builderFeeSum(fills.perps), spot: builderFeeSum(fills.spot) };
    const read = async (): Promise<{ perps: string | null; spot: string | null }> => ({ perps: await accountUsdc('perps', b.address!, b.id), spot: await accountUsdc('spot', b.address!, b.id) });
    const income = (now: { perps: string | null; spot: string | null }): { perps: string; spot: string } | null =>
      now.perps === null || now.spot === null ? null : { perps: dSub(now.perps, base.perps!), spot: dSub(now.spot, base.spot!) };
    const tol = '0.000002';
    const enough = (got: string, want: string): boolean => dCmp(dAdd(got, tol), want) >= 0;
    // The credit may trail the fill by a moment.
    const r = await waitMaybe({ timeoutMs: 60_000, intervalMs: 5000, probe: read, done: (n) => { const i = income(n); return !!i && enough(i.perps, paid.perps) && enough(i.spot, paid.spot); } });
    const now = r.value ?? (await read());
    const inc = income(now);
    if (!inc) throw new CheckFailure('the builder account\'s balances cannot be read now', { now });
    const evidence = { builder: b.id, address: b.address, before: { perps: base.perps, spot: base.spot }, after: now, income: inc, paidByTheRunsFills: paid, fills: { perps: fills.perps.length, spot: fills.spot.length } };
    const short = (['perps', 'spot'] as const).filter((e) => !enough(inc[e], paid[e]));
    if (short.length) {
      throw new CheckFailure(`the builder account received LESS than the run's fills say they paid: ${short.map((e) => `${e} +${cut(inc[e], 8)} vUSDC, the fills paid ${cut(paid[e], 8)}`).join('; ')}`, evidence);
    }
    const more = (['perps', 'spot'] as const).filter((e) => dCmp(inc[e], dAdd(paid[e], tol)) > 0);
    const total = dAdd(paid.perps, paid.spot);
    if (more.length) {
      ctx.checks.finding(
        'builder-income-matches',
        `the builder account received everything the run's fills paid (${cut(total, 8)} vUSDC) and MORE: ${more.map((e) => `${e} +${cut(inc[e], 8)} against ${cut(paid[e], 8)}`).join('; ')} - other accounts traded through builder #${b.id} during the run, or the account was funded`,
        evidence,
      );
    } else {
      ctx.checks.pass('builder-income-matches', `builder account #${b.id} rose by exactly what the run's fills paid: perps +${cut(inc.perps, 8)} vUSDC (${fills.perps.length} fill(s)), spot +${cut(inc.spot, 8)} vUSDC (${fills.spot.length} fill(s))`, evidence);
    }
  });

  const rows = [...ctx.fillChecks.values()].map(fillRow);
  rec.note(`${rows.length} fill(s) judged; history reads made: ${limiter.reads.map((x) => x.what).join(', ') || 'none'}`);
}
