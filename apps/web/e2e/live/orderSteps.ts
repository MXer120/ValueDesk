/**
 * The order steps: every order type the app can place, on the configured spot
 * and perps markets, at the smallest size SoDEX takes - each one an assertion
 * of its own (checks.ts), each fill's fees judged (orders.ts judgeFills).
 *
 * A scenario that fails leaves its market clean again (no open orders, no
 * position) and the step goes on with the next one; only something whose
 * outcome is unknown stops the run.
 */
import { canonicalDecimal } from '@sodex-core';
import { setTradingConfig, tradingConfig } from '../../src/trading/config';
import { balancesOf, unitsDown, type CoinConfig } from '../../src/trading/funds';
import { app, appAssumes, appRecreates, changeLimitOrder, changeStopOrder } from './app';
import { CheckFailure, SafetyStop, armed, isDefiniteRefusal, scenario, type Ctx } from './context';
import type { Engine } from './fees';
import type { Expectation } from './guard';
import {
  clearLeftovers,
  cancel,
  cancelExpect,
  crossingBuyPrice,
  defaultFee,
  ensurePerpsCollateral,
  expectGone,
  expectOpen,
  expectPosition,
  flatten,
  idText,
  isOurs,
  judgeFills,
  marketSellQty,
  minQtyAt,
  mustPlace,
  openOn,
  orderExpect,
  orderMs,
  place,
  positionOf,
  putInOrder,
  refusedLocally,
  releasePerpsCollateral,
  rememberMarket,
  restsAfter,
  sameBuilder,
  seen,
  settleFills,
  settleMs,
  streamMs,
  symbolConfig,
  ticksFrom,
  tradingAccount,
  triggerPrice,
  waitFor,
  waitMaybe,
  awaitFills,
  type OrderSpec,
  type Placed,
} from './orders';
import { builderRef, type BuilderRef } from './ledger';
import { marketQty, readMarket, restingBuy, type Market } from './plan';
import { engineState, type OpenOrder } from './reads';
import { ensureTrading } from './trading';
import { FOK_REFUSED } from '../../src/trading/orderParams';

/**
 * A fill-or-kill order: SoDEX answers it with "timeInForce is invalid" on both engines (live, 2026-10-03), so the
 * app refuses it before anything is signed - and says to use IOC. Nothing is sent.
 */
async function fokRefused(ctx: Ctx, id: string, what: string, fn: () => Promise<unknown>): Promise<void> {
  await scenario(ctx, id, async () => {
    const r = await refusedLocally(ctx, fn);
    if (!r.refused) throw new CheckFailure(`${what}: ${r.why}`);
    if (!r.reason.includes(FOK_REFUSED)) throw new CheckFailure(`${what}: refused, but for another reason: "${r.reason}"`);
    ctx.checks.pass(id, `${what}: the app refused it before signing ("${r.reason}") - SoDEX rejects FOK ("timeInForce is invalid"); nothing was sent`, { refusal: r.reason });
  });
}
import { approx, cut, dAdd, dCmp, dMul, dSub, dur, paced, sleep, toStep } from './util';

const canon = (v: string | number | undefined | null): string => {
  try {
    return canonicalDecimal(String(v ?? '0'));
  } catch {
    return String(v);
  }
};
const notRun = (ctx: Ctx, ids: readonly string[], why: string): void => {
  for (const id of ids) if (!ctx.checks.get(id)) ctx.checks.set(id, 'not-run', why);
};

/** The coin a spot market's fills arrive in. */
function baseCoinOf(ctx: Ctx, m: Market): CoinConfig {
  const c = ctx.pre.coins.find((x) => x.assetId === m.sym.baseCoinID);
  if (!c) throw new SafetyStop(`SoDEX's asset config has no coin for the base of ${m.sym.name}`);
  return c;
}

/** What a fill would change: the perps position's signed size, or the spot base coin's free balance. */
async function exposure(ctx: Ctx, m: Market): Promise<string> {
  if (m.engine === 'perps') return canon((await positionOf(ctx, m.sym.name))?.size ?? '0');
  return canon((await balancesOf(ctx.owner, baseCoinOf(ctx, m))).spot);
}

/** Wait until the exposure differs from `before`; null when it never did. */
async function exposureChange(ctx: Ctx, m: Market, before: string, timeoutMs: number): Promise<string | null> {
  const r = await waitMaybe({ timeoutMs, intervalMs: 1500, probe: () => exposure(ctx, m), done: (v) => v !== before });
  return r.ok ? r.value! : null;
}

// --- changing an order ---------------------------------------------------------------------------------------

/** Expect ONE replace request for exactly this order and exactly this change. */
function replaceExpect(m: Market, id: Placed, change: { price?: string; quantity?: string }, label: string, tag: string): Expectation {
  return {
    kind: 'order-replace',
    label,
    tag,
    check: (r) => {
      const b = r.body ?? {};
      if (r.engine !== m.engine) return `sent to ${r.engine}, expected ${m.engine}`;
      const acct = tradingAccount();
      if (acct && b.accountID !== acct) return `account ${String(b.accountID)}, expected ${acct}`;
      const list = (Array.isArray(b.orders) ? b.orders : []) as Array<Record<string, unknown>>;
      if (list.length !== 1) return `${list.length} replacement(s) in the request, expected 1`;
      const x = list[0]!;
      const extra = Object.keys(x).filter((k) => !['symbolID', 'clOrdID', 'origOrderID', 'origClOrdID', 'price', 'quantity'].includes(k));
      if (extra.length) return `carries field(s) a replacement must not have: ${extra.join(', ')}`;
      if (x.symbolID !== m.sym.id) return `symbol ${String(x.symbolID)}, expected ${m.sym.id}`;
      if (id.orderID !== null ? x.origOrderID !== id.orderID : x.origClOrdID !== id.clOrdID) return `replaces ${String(x.origOrderID ?? x.origClOrdID)}, expected ${idText(id)}`;
      if (x.price !== change.price) return `price ${String(x.price)}, expected ${change.price ?? 'unchanged (absent)'}`;
      if (x.quantity !== change.quantity) return `quantity ${String(x.quantity)}, expected ${change.quantity ?? 'unchanged (absent)'}`;
      return null;
    },
  };
}

/** Expect ONE modify request (perps, a TP/SL order) for exactly this order and this new trigger price. */
function modifyExpect(m: Market, id: Placed, stopPrice: string, label: string, tag: string): Expectation {
  return {
    kind: 'order-modify',
    label,
    tag,
    check: (r) => {
      const b = (r.body ?? {}) as Record<string, unknown>;
      const acct = tradingAccount();
      if (acct && b.accountID !== acct) return `account ${String(b.accountID)}, expected ${acct}`;
      const extra = Object.keys(b).filter((k) => !['accountID', 'symbolID', 'orderID', 'clOrdID', 'price', 'quantity', 'stopPrice'].includes(k));
      if (extra.length) return `carries field(s) a modification must not have: ${extra.join(', ')}`;
      if (b.symbolID !== m.sym.id) return `symbol ${String(b.symbolID)}, expected ${m.sym.id}`;
      if (id.orderID !== null ? b.orderID !== id.orderID : b.clOrdID !== id.clOrdID) return `modifies ${String(b.orderID ?? b.clOrdID)}, expected ${idText(id)}`;
      if (b.stopPrice !== stopPrice) return `stopPrice ${String(b.stopPrice)}, expected ${stopPrice}`;
      if (b.price !== undefined || b.quantity !== undefined) return 'changes the price or the size too; only the trigger was to change';
      return null;
    },
  };
}

/**
 * What a change did to the order's builder (docs/BUILDER-TIERS.md G6): a finding
 * with the constant to flip, never a failure. Several observations (spot and
 * perps) are kept side by side.
 */
function noteKeepsBuilder(ctx: Ctx, kind: 'replace' | 'modify', where: string, carried: BuilderRef | null, after: BuilderRef | null): void {
  const id = kind === 'replace' ? 'builder-replace-keeps-builder' : 'builder-modify-keeps-builder';
  const constant = kind === 'replace' ? 'REPLACE_KEEPS_BUILDER' : 'MODIFY_KEEPS_BUILDER';
  if (!carried) return;
  const kept = sameBuilder(carried, after);
  const prev = (ctx.checks.get(id)?.evidence.observations ?? []) as Array<{ where: string; kept: boolean; before: BuilderRef; after: BuilderRef | null }>;
  const observations = [...prev.filter((o) => o.where !== where), { where, kept, before: carried, after }];
  const all = observations.every((o) => o.kept);
  const none = observations.every((o) => !o.kept);
  const assumes = kind === 'replace' ? appAssumes.replaceKeepsBuilder() : appAssumes.modifyKeepsBuilder();
  const seenText = observations.map((o) => `${o.where}: ${o.kept ? 'kept' : o.after ? `changed to #${o.after.id} at ${o.after.fee}` : 'DROPPED'}`).join('; ');
  const verdict = all ? true : none ? false : null;
  if (verdict !== null && assumes === verdict) {
    ctx.checks.pass(id, `${seenText} - as the app assumes (${constant} = ${String(assumes)})`, { observations, constant, appAssumes: assumes });
  } else {
    ctx.checks.finding(
      id,
      verdict === null
        ? `${seenText} - the engines differ; ${constant} must be false (cancel + new order with the builder)`
        : `${seenText} - ${assumes === null ? `the app states no ${constant}` : `the app assumes ${constant} = ${String(assumes)}`}; set ${constant} = ${String(verdict)}${verdict ? ' (the request can be used as it is)' : ' (change orders as cancel + new order with the builder)'}`,
      { observations, constant, appAssumes: assumes, setTo: verdict ?? false },
    );
  }
}

/**
 * G6: the app changes an order as cancel + new order wherever SoDEX's own change
 * request is not known to keep the builder - so in a build that requires the
 * builder, SoDEX's request is never seen. To learn what it does, ONE change is
 * made with the app's builder set to optional for exactly that call (said so in
 * the report): the app then sends SoDEX's request, through the same code, and the
 * guard lets out exactly that request.
 */
async function withOptionalBuilder<T>(ctx: Ctx, why: string, fn: () => Promise<T>): Promise<T> {
  const was = tradingConfig().builder;
  if (!was || !was.required) return fn();
  ctx.rec.note(`G6: for this one change the app's builder is set to OPTIONAL (${why}); it is required again right after`);
  setTradingConfig({ builder: { ...was, required: false } });
  try {
    return await fn();
  } finally {
    setTradingConfig({ builder: was });
  }
}

// --- shared scenarios: limit rest / change / cancel -------------------------------------------------------------

async function restChangeCancel(ctx: Ctx, engine: Engine, ref: string, offsetPct: number): Promise<void> {
  const p = engine;
  let m = await readMarket(engine, ref);
  rememberMarket(m);
  const rb = restingBuy(m, offsetPct);
  const name = `${engine} ${m.sym.name}`;
  // Assigned inside the scenarios below: declared with their full type so reads after a scenario are not narrowed to null.
  let id = null as Placed | null;
  let carried = null as BuilderRef | null;
  let price = rb.price;
  let qty = rb.qty;

  await scenario(
    ctx,
    `${p}-limit-rest`,
    async () => {
      if (engine === 'spot') {
        const dp = ctx.pre.usdc.valuechain.decimals;
        const free = unitsDown((await balancesOf(ctx.owner, ctx.pre.usdc)).spot, dp);
        if (free < unitsDown(dMul(rb.lock, '1.02'), dp)) throw new SafetyStop(`Spot USDC does not cover the resting order (~${cut(rb.lock, 4)} USDC)`);
      }
      const r = await mustPlace(ctx, { market: m, side: 'buy', type: 'limit', tif: 'gtc', price: rb.price, quantity: rb.qty, tag: `${p}-limit-rest`, label: `${name} resting limit buy` });
      const row = await expectOpen(ctx, m, r.id, `${name} resting order`);
      id = { orderID: row.orderID ?? r.id.orderID, clOrdID: row.clOrdID ?? r.id.clOrdID };
      carried = r.order?.builder ?? null;
      if (canon(row.price) !== rb.price || canon(row.origQty) !== rb.qty) throw new CheckFailure(`the open order reads ${row.origQty} @ ${row.price}, not ${rb.qty} @ ${rb.price}`, { row });
      ctx.checks.pass(`${p}-limit-rest`, `BUY ${rb.qty} @ ${rb.price} (${rb.offsetPct} % below the bid ${m.bid}) rests as ${idText(id)}`, { orderID: id.orderID, clOrdID: id.clOrdID, price: rb.price, quantity: rb.qty, status: row.status ?? null, builderOnRecord: builderRef(row.builder) });
    },
    () => putInOrder(ctx, m, `${p}-limit-rest`),
  );
  if (!id) return notRun(ctx, [`${p}-limit-change-price`, `${p}-limit-change-size`, `${p}-limit-cancel`], 'the resting order was not placed');

  /** After a change: the order as the book lists it now (its id may be a new one). */
  const changed = async (wantPrice: string, wantQty: string, what: string): Promise<OpenOrder> => {
    const list = await waitFor(ctx, what, {
      timeoutMs: orderMs(ctx),
      intervalMs: 2000,
      probe: () => openOn(ctx, m),
      done: (l) => l.some((o) => canon(o.price) === wantPrice && canon(o.origQty) === wantQty),
      show: (l) => (l ?? []).map((o) => `#${o.orderID} ${o.origQty}@${o.price}`).join(', ') || 'no open order',
    });
    const row = list.find((o) => canon(o.price) === wantPrice && canon(o.origQty) === wantQty)!;
    ctx.ledger.noteRecord(engine, row as Record<string, unknown>, 'open-orders');
    return row;
  };

  /**
   * The app's change of the resting order, with exactly its requests armed: SoDEX's
   * replace where the app uses it, else (G6) a cancel of this order and ONE new
   * order with the changed price / size and the builder owed now.
   */
  const recreates = appRecreates.limit(engine);
  const appChange = async (was: Placed, change: { price?: string; quantity?: string }, label: string, tag: string): Promise<string> => {
    const expect = recreates
      ? [
          cancelExpect(engine, [was], `${label}: cancel (the app changes it as cancel + new order)`, tag),
          orderExpect(ctx, { market: m, side: 'buy', type: 'limit', tif: 'gtc', price: change.price ?? price, quantity: change.quantity ?? qty, tag, label: `${label}: the new order` }),
        ]
      : [replaceExpect(m, was, change, label, tag)];
    await armed(ctx, { expect }, () => changeLimitOrder(engine, { symbol: m.sym.name, orderID: was.orderID!, ...change }));
    return recreates ? "as cancel + new order (the app does not use SoDEX's replace: REPLACE_KEEPS_BUILDER is false)" : "with SoDEX's replace request";
  };
  /** After the app's change: the new order must carry the builder (cancel + new), or what SoDEX's record of the replacement says is noted (G6). */
  const afterChange = (was: Placed, row: OpenOrder, what: string): string => {
    const now: Placed = { orderID: row.orderID ?? null, clOrdID: row.clOrdID ?? null };
    const onRecord = builderRef(row.builder);
    if (!recreates) {
      noteKeepsBuilder(ctx, 'replace', `${engine} ${what} (the app's replace)`, carried, onRecord);
      return '';
    }
    const fresh = ctx.ledger.find(engine, now);
    if (ctx.cfg.builder && defaultFee(ctx, engine) > 0 && !sameBuilder(onRecord, fresh?.builder ?? null)) {
      throw new CheckFailure(`the new order ${idText(now)} carried ${fresh?.builder ? `builder #${fresh.builder.id} at ${fresh.builder.fee}` : 'no builder'}, its record names ${onRecord ? `#${onRecord.id} at ${onRecord.fee}` : 'none'}`, { was, now });
    }
    carried = fresh?.builder ?? carried;
    return `; the new order's record names ${onRecord ? `builder #${onRecord.id} at ${onRecord.fee}` : 'no builder'}, as it carried`;
  };

  await scenario(
    ctx,
    `${p}-limit-change-price`,
    async () => {
      const was = id!;
      const next = ticksFrom(m, price, -1);
      const how = await appChange(was, { price: next }, `${name}: price ${price} -> ${next}`, `${p}-limit-change-price`);
      const row = await changed(next, qty, `${name}: the order at ${next}`);
      price = next;
      id = { orderID: row.orderID ?? null, clOrdID: row.clOrdID ?? null };
      const extra = afterChange(was, row, 'price change');
      ctx.checks.pass(`${p}-limit-change-price`, `price changed to ${next} ${how}; the order is ${idText(id)}${id.orderID === was.orderID ? ' (the same id)' : ` (was ${idText(was)})`}${extra}`, { before: was, after: id, price: next, sameOrderId: id.orderID === was.orderID, recreated: recreates });
    },
    () => putInOrder(ctx, m, `${p}-limit-change-price`),
  );
  await scenario(
    ctx,
    `${p}-limit-change-size`,
    async () => {
      const still = (await openOn(ctx, m)).find((o) => isOurs(o, id!));
      if (!still) {
        ctx.checks.set(`${p}-limit-change-size`, 'not-run', 'the resting order is no longer open (the price change failed)');
        return;
      }
      const was = id!;
      const next = dAdd(qty, m.sym.stepSize && dCmp(m.sym.stepSize, '0') > 0 ? m.sym.stepSize : '1');
      const how = await appChange(was, { quantity: next }, `${name}: size ${qty} -> ${next}`, `${p}-limit-change-size`);
      const row = await changed(price, next, `${name}: the order with size ${next}`);
      qty = next;
      id = { orderID: row.orderID ?? null, clOrdID: row.clOrdID ?? null };
      const extra = afterChange(was, row, 'size change');
      ctx.checks.pass(`${p}-limit-change-size`, `size changed to ${next} ${how}; the order is ${idText(id)}${extra}`, { before: was, after: id, quantity: next, sameOrderId: id.orderID === was.orderID, recreated: recreates });
    },
    () => putInOrder(ctx, m, `${p}-limit-change-size`),
  );

  // G6 - the app does not send SoDEX's replace here (it changes the order as cancel + new). Whether a replaced order
  // keeps its builder is what decides REPLACE_KEEPS_BUILDER: ONE replace, made by the app with its builder optional
  // for that call, on this order far below the market.
  if (recreates && ctx.cfg.builder && defaultFee(ctx, engine) > 0) {
    await scenario(
      ctx,
      'builder-replace-keeps-builder',
      async () => {
        const was = id;
        if (!was || !(await openOn(ctx, m)).some((o) => isOurs(o, was))) {
          if (!ctx.checks.get('builder-replace-keeps-builder')) ctx.checks.set('builder-replace-keeps-builder', 'not-run', `the resting ${engine} order is no longer open`);
          return;
        }
        if (was.orderID === null) throw new SafetyStop('the order has no id');
        const next = ticksFrom(m, price, -1);
        const before = ctx.ledger.find(engine, was)?.builder ?? carried;
        let route = '';
        try {
          route = await withOptionalBuilder(ctx, `to see what SoDEX's replace does to the builder of a ${engine} order`, async () => {
            const r = await armed(ctx, { expect: [replaceExpect(m, was, { price: next }, `${name}: replace ${idText(was)}, price ${price} -> ${next} (G6)`, 'builder-replace-keeps-builder')] }, () => changeLimitOrder(engine, { symbol: m.sym.name, orderID: was.orderID!, price: next }));
            return r.route;
          });
        } catch (e) {
          if (!isDefiniteRefusal(e)) throw e;
          const prev = ctx.checks.get('builder-replace-keeps-builder');
          const why = e instanceof Error ? e.message : String(e);
          ctx.checks.finding('builder-replace-keeps-builder', `${prev && prev.status !== 'not-run' ? `${prev.detail}; ` : ''}${engine}: SoDEX REJECTED a replace of a resting order ("${why}") - the request cannot be used; REPLACE_KEEPS_BUILDER stays false`, { [`${engine}Rejection`]: why });
          return;
        }
        if (route !== 'replace') throw new CheckFailure(`with the builder optional the app still changed the order by "${route}", not by SoDEX's replace`);
        const row = await changed(next, qty, `${name}: the replaced order at ${next}`);
        price = next;
        id = { orderID: row.orderID ?? null, clOrdID: row.clOrdID ?? null };
        noteKeepsBuilder(ctx, 'replace', `${engine} (SoDEX's replace, the builder optional for that call)`, before, builderRef(row.builder));
      },
      () => putInOrder(ctx, m, 'builder-replace-keeps-builder'),
    );
  }
  await scenario(
    ctx,
    `${p}-limit-cancel`,
    async () => {
      const still = (await openOn(ctx, m)).find((o) => isOurs(o, id!));
      if (!still) {
        ctx.checks.set(`${p}-limit-cancel`, 'not-run', 'the resting order is no longer open');
        return;
      }
      await cancel(ctx, m, id!, `${name} cancel`, `${p}-limit-cancel`);
      await expectGone(ctx, m, id!, `${name} order`);
      await awaitFills(ctx, engine, id!);
      const s = seen(ctx, engine, id!);
      if (s.fills.length) throw new CheckFailure(`${s.filledQty} of the resting order FILLED before the cancel`, { fills: s.fills });
      if (engine === 'spot') {
        const st = await engineState('spot', ctx.owner);
        const locked = st?.B?.find((r) => r.i === ctx.pre.usdc.assetId)?.l ?? '0';
        if (approx(locked) > 0 && (await openOn(ctx, m)).length === 0) throw new CheckFailure(`${locked} USDC is still locked although no order is open on ${m.sym.name}`);
      }
      ctx.checks.pass(`${p}-limit-cancel`, `cancelled; it left the open orders${s.status ? ` (SoDEX: ${s.status})` : ''}, nothing filled`, { orderID: id!.orderID, status: s.status });
    },
    () => putInOrder(ctx, m, `${p}-limit-cancel`),
  );
  m = await readMarket(engine, ref);
  rememberMarket(m);
}

// --- shared scenarios: post-only, IOC, FOK ---------------------------------------------------------------------

/** An order that must REST (post-only below the market), then is cancelled. */
async function restsThenCancel(ctx: Ctx, m: Market, id: string, spec: Omit<OrderSpec, 'tag' | 'label'>, what: string): Promise<void> {
  await scenario(
    ctx,
    id,
    async () => {
      const r = await mustPlace(ctx, { ...spec, tag: id, label: what });
      const row = await expectOpen(ctx, m, r.id, what);
      await cancel(ctx, m, r.id, `${what}: cancel`, id);
      await expectGone(ctx, m, r.id, what);
      ctx.checks.pass(id, `${spec.quantity} @ ${spec.price} rests (${row.timeInForce ?? 'time in force not listed'}, ${row.status ?? 'open'}); cancelled again`, { orderID: r.id.orderID, timeInForce: row.timeInForce ?? null });
    },
    () => putInOrder(ctx, m, id),
  );
}

/**
 * An order that must NOT fill. A rejection by SoDEX and an acceptance that
 * expires at once are both fine and both recorded; a fill fails the check.
 * `rests`: what it means if the order sits on the book afterwards.
 * `rejection`: 'finding' when a rejection is itself the news (FOK).
 */
async function mustNotFill(ctx: Ctx, m: Market, id: string, spec: Omit<OrderSpec, 'tag' | 'label'>, what: string, o: { rests: 'fail' | 'finding'; rejection: 'pass' | 'finding' }): Promise<void> {
  await scenario(
    ctx,
    id,
    async () => {
      const before = await exposure(ctx, m);
      const r = await place(ctx, { ...spec, tag: id, label: what });
      if (!r.ok) {
        if (!r.sent) throw new CheckFailure(`the app refused it before sending: ${r.reason}`);
        ctx.checks.set(id, o.rejection, `SoDEX rejected it: ${r.reason}`, { outcome: 'rejected', reason: r.reason });
        return;
      }
      const s = await awaitFills(ctx, m.engine, r.id);
      const resting = await restsAfter(ctx, m, r.id);
      const after = await exposure(ctx, m);
      if (after !== before || s.fills.length) {
        throw new CheckFailure(`it FILLED: ${m.engine === 'perps' ? 'position' : 'balance'} ${before} -> ${after}`, { orderID: r.id.orderID, fills: s.fills, before, after });
      }
      if (resting) {
        await cancel(ctx, m, r.id, `${what}: cancel`, id);
        await expectGone(ctx, m, r.id, what);
        const text = `SoDEX accepted it and it RESTED on the book (${resting.status ?? 'open'}); cancelled`;
        if (o.rests === 'fail') throw new CheckFailure(text, { orderID: r.id.orderID });
        ctx.checks.finding(id, `${text} - the book had moved above ${spec.price}, so it did not cross: nothing learned about crossing`, { outcome: 'rested', orderID: r.id.orderID });
        return;
      }
      ctx.checks.pass(id, `accepted as ${idText(r.id)}, then gone with no fill${s.status ? ` (SoDEX: ${s.status})` : ''}`, { outcome: 'expired', orderID: r.id.orderID, status: s.status });
    },
    () => putInOrder(ctx, m, id),
  );
}

/**
 * An order that should FILL `spec.quantity` at once. Returns the filled quantity
 * ('0' when it did not). `rejection`: 'fail', or 'finding' when a rejection is
 * the news (FOK is documented as not supported).
 */
async function mustFill(ctx: Ctx, m: Market, id: string, spec: Omit<OrderSpec, 'tag' | 'label'>, what: string, o: { rejection: 'fail' | 'finding' }): Promise<string> {
  let filled = '0';
  await scenario(
    ctx,
    id,
    async () => {
      const before = await exposure(ctx, m);
      const r = await place(ctx, { ...spec, tag: id, label: what });
      if (!r.ok) {
        if (!r.sent) throw new CheckFailure(`the app refused it before sending: ${r.reason}`);
        if (o.rejection === 'fail') throw new CheckFailure(`SoDEX rejected it: ${r.reason}`);
        ctx.checks.finding(id, `SoDEX rejected it: ${r.reason}`, { outcome: 'rejected', reason: r.reason });
        return;
      }
      const after = await exposureChange(ctx, m, before, orderMs(ctx));
      if (after === null) {
        const resting = await restsAfter(ctx, m, r.id, 0);
        if (resting) {
          await cancel(ctx, m, r.id, `${what}: cancel`, id);
          await expectGone(ctx, m, r.id, what);
          throw new CheckFailure('it did not fill and RESTED on the book instead; cancelled', { orderID: r.id.orderID });
        }
        throw new CheckFailure(`accepted as ${idText(r.id)} but nothing filled (the book moved away from ${spec.price ?? 'the market'}?)`, { orderID: r.id.orderID });
      }
      const s = await settleFills(ctx, m, r.id, spec.quantity);
      const delta = dSub(after, before);
      if (m.engine === 'perps' && spec.quantity && canon(delta) !== canon(spec.quantity)) throw new CheckFailure(`the position moved by ${delta}, not by ${spec.quantity}`, { orderID: r.id.orderID, before, after });
      filled = m.engine === 'perps' ? canon(delta) : spec.quantity ?? s.filledQty;
      ctx.checks.pass(id, `filled as ${idText(r.id)}: ${m.engine === 'perps' ? 'position' : `${m.sym.baseCoin} in Spot`} ${before} -> ${after}; ${s.note}`, { orderID: r.id.orderID, before, after }, s.costUsd);
    },
    () => putInOrder(ctx, m, id),
  );
  return filled;
}

// --- spot --------------------------------------------------------------------------------------------------------

export async function stepOrdersSpot(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const usdc = ctx.pre.usdc;
  const udp = usdc.valuechain.decimals;
  await ensureTrading(ctx);
  const ref = cfg.orders.spotSymbol;

  const first = await readMarket('spot', ref);
  rememberMarket(first);
  await clearLeftovers(ctx, first, 'orders-spot');
  const base = baseCoinOf(ctx, first);
  const bdp = base.valuechain.decimals;

  // 1. Rest, change the price, change the size, cancel.
  await restChangeCancel(ctx, 'spot', ref, cfg.orders.spotLimitOffsetPct);

  // 2. Market buy by FUNDS: spend this much of the quote coin.
  await scenario(ctx, 'spot-market-buy-by-funds', async () => {
    const m = await readMarket('spot', ref);
    rememberMarket(m);
    const funds = toStep(dMul(m.sym.minNotional && dCmp(m.sym.minNotional, '0') > 0 ? m.sym.minNotional : '1', '1.2'), '0.000001', 'ceil');
    const u0 = await balancesOf(owner, usdc);
    if (unitsDown(u0.spot, udp) < unitsDown(dMul(funds, '1.05'), udp)) throw new SafetyStop(`Spot holds ${u0.spot} USDC; the buy needs ${funds}`);
    const c0 = await balancesOf(owner, base);
    const r = await mustPlace(ctx, { market: m, side: 'buy', type: 'market', funds, tag: 'spot-market-buy-by-funds', label: `spot market buy for ${funds} USDC` });
    const c1 = await waitFor(ctx, `${base.coin} in Spot`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => balancesOf(owner, base), done: (b) => unitsDown(b.spot, bdp) > unitsDown(c0.spot, bdp), show: (b) => `Spot ${base.coin} ${b?.spot ?? '?'}` });
    const u1 = await balancesOf(owner, usdc);
    const paid = dSub(u0.spot, u1.spot);
    const got = dSub(c1.spot, c0.spot);
    if (dCmp(paid, dMul(funds, '1.001')) > 0) throw new CheckFailure(`it spent ${paid} USDC, more than the ${funds} it was given`, { paid, funds });
    const s = await settleFills(ctx, m, r.id);
    ctx.checks.pass('spot-market-buy-by-funds', `spent ${cut(paid, 6)} of ${funds} USDC for ${cut(got, 8)} ${base.coin}; ${s.note}`, { orderID: r.id.orderID, funds, paid, bought: got }, s.costUsd);
  });

  // 3. Market buy by QUANTITY.
  await scenario(ctx, 'spot-market-buy-by-quantity', async () => {
    const m = await readMarket('spot', ref);
    rememberMarket(m);
    const qty = cfg.orders.sosoBuyQuantity === 'auto' ? marketQty(m, 20) : toStep(cfg.orders.sosoBuyQuantity, m.sym.stepSize || '0', 'floor');
    const notional = dMul(qty, m.ask);
    if (approx(notional) < approx(m.sym.minNotional)) throw new SafetyStop(`a market buy of ${qty} (~${cut(notional, 4)} USDC) is below the market's minimum notional ${m.sym.minNotional}`);
    const u0 = await balancesOf(owner, usdc);
    if (unitsDown(u0.spot, udp) < unitsDown(dMul(notional, '1.05'), udp)) throw new SafetyStop(`Spot holds ${u0.spot} USDC; the market buy needs ~${cut(dMul(notional, '1.05'), 4)}`);
    const c0 = await balancesOf(owner, base);
    const r = await mustPlace(ctx, { market: m, side: 'buy', type: 'market', quantity: qty, tag: 'spot-market-buy-by-quantity', label: `spot market buy ${qty} ${base.coin}` });
    const c1 = await waitFor(ctx, `${base.coin} in Spot`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => balancesOf(owner, base), done: (b) => unitsDown(b.spot, bdp) > unitsDown(c0.spot, bdp), show: (b) => `Spot ${base.coin} ${b?.spot ?? '?'}` });
    const u1 = await balancesOf(owner, usdc);
    const s = await settleFills(ctx, m, r.id, qty);
    const got = dSub(c1.spot, c0.spot);
    rec.amount('spot market buy', `${got} ${base.coin} for ${dSub(u0.spot, u1.spot)} USDC`);
    ctx.checks.pass('spot-market-buy-by-quantity', `bought ${cut(got, 8)} ${base.coin} (ordered ${qty}; the fee is taken in ${base.coin}) for ${cut(dSub(u0.spot, u1.spot), 6)} USDC; ${s.note}`, { orderID: r.id.orderID, quantity: qty, received: got }, s.costUsd);
  });

  // 4. Market SELL (the side SoDEX charges the builder fee on).
  await scenario(ctx, 'spot-market-sell', async () => {
    const m = await readMarket('spot', ref);
    rememberMarket(m);
    const qty = marketSellQty(m, 10);
    const c0 = await balancesOf(owner, base);
    if (unitsDown(c0.spot, bdp) < unitsDown(qty, bdp)) throw new SafetyStop(`Spot holds ${c0.spot} ${base.coin}; the smallest sell is ${qty} (the buys before it did not happen?)`);
    const u0 = await balancesOf(owner, usdc);
    const r = await mustPlace(ctx, { market: m, side: 'sell', type: 'market', quantity: qty, tag: 'spot-market-sell', label: `spot market sell ${qty} ${base.coin}` });
    const u1 = await waitFor(ctx, 'USDC from the sell in Spot', { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => balancesOf(owner, usdc), done: (b) => unitsDown(b.spot, udp) > unitsDown(u0.spot, udp), show: (b) => `Spot USDC ${b?.spot ?? '?'}` });
    const s = await settleFills(ctx, m, r.id, qty);
    ctx.checks.pass('spot-market-sell', `sold ${qty} ${base.coin} for ${cut(dSub(u1.spot, u0.spot), 6)} USDC; ${s.note}`, { orderID: r.id.orderID, quantity: qty, received: dSub(u1.spot, u0.spot) }, s.costUsd);
  });

  // 5. Post-only, IOC, FOK.
  {
    const m = await readMarket('spot', ref);
    rememberMarket(m);
    const rb = restingBuy(m, cfg.orders.spotLimitOffsetPct);
    const px = crossingBuyPrice(m);
    const q = minQtyAt(m, px, 5);
    await restsThenCancel(ctx, m, 'spot-gtx-rest', { market: m, side: 'buy', type: 'limit', tif: 'gtx', price: rb.price, quantity: rb.qty }, `spot post-only buy ${rb.qty} @ ${rb.price}`);
    await mustNotFill(ctx, m, 'spot-gtx-cross', { market: m, side: 'buy', type: 'limit', tif: 'gtx', price: px, quantity: q }, `spot post-only buy ${q} @ ${px} (above the ask ${m.ask})`, { rests: 'finding', rejection: 'pass' });
    await mustNotFill(ctx, m, 'spot-ioc-no-cross', { market: m, side: 'buy', type: 'limit', tif: 'ioc', price: rb.price, quantity: rb.qty }, `spot IOC buy ${rb.qty} @ ${rb.price} (far below the market)`, { rests: 'fail', rejection: 'pass' });
    await mustFill(ctx, m, 'spot-ioc-cross', { market: m, side: 'buy', type: 'limit', tif: 'ioc', price: px, quantity: q }, `spot IOC buy ${q} @ ${px} (crosses the ask ${m.ask})`, { rejection: 'fail' });
    await fokRefused(ctx, 'spot-fok-not-fillable', `spot FOK buy ${rb.qty} @ ${rb.price} (far below the market)`, () => app.placeOrder('spot', { symbol: m.sym.name, side: 'buy', type: 'limit', tif: 'fok', price: rb.price, quantity: rb.qty }));
    await fokRefused(ctx, 'spot-fok-fillable', `spot FOK buy ${q} @ ${px} (crosses the ask ${m.ask})`, () => app.placeOrder('spot', { symbol: m.sym.name, side: 'buy', type: 'limit', tif: 'fok', price: px, quantity: q }));
  }

  // 6. The dead-man switch on spot: scheduled a minute out, cleared at once (the perps step lets one fire).
  await scenario(ctx, 'spot-schedule-cancel', async () => {
    await scheduleAndClear(ctx, 'spot', 60_000);
    ctx.checks.pass('spot-schedule-cancel', 'a cancel-all was scheduled one minute out and cleared again; SoDEX accepted both', {});
  });

  // 7. What the spot fills say about the builder fee.
  await judgeFills(ctx);
  const spotFills = [...ctx.fillChecks.values()].filter((c) => c.fill.engine === 'spot');
  if (!ctx.cfg.builder || defaultFee(ctx, 'spot') === 0) ctx.checks.skip('builder-spot-buy-not-charged', 'no builder fee on spot in this run');
  else if (!spotFills.length) ctx.checks.set('builder-spot-buy-not-charged', 'not-run', 'the account stream reported no spot fills - judged in the final cross-check');
  else recordSpotBuyRule(ctx);

  // 8. Clean.
  await scenario(ctx, 'spot-end-clean', async () => {
    const m = await readMarket('spot', ref);
    const open = await openOn(ctx, m);
    const st = await engineState('spot', owner);
    const locked = st?.B?.find((r) => r.i === usdc.assetId)?.l ?? '0';
    if (open.length) throw new CheckFailure(`${open.length} spot order(s) still open on ${m.sym.name}`, { open });
    if (approx(locked) > 0) throw new CheckFailure(`${locked} USDC is still locked with no open order`);
    ctx.checks.pass('spot-end-clean', `no open order on ${m.sym.name}, nothing locked`, {});
  }, async () => {
    await putInOrder(ctx, await readMarket('spot', ref), 'spot-end-clean');
  });
  for (const id of ['spot-fees-commission', 'spot-fees-builder']) notRun(ctx, [id], 'the account stream reported no spot fills - they are judged in the final cross-check');
  const b = await balancesOf(owner, usdc);
  const c = await balancesOf(owner, base);
  rec.note(`Spot now: ${b.spot} USDC, ${c.spot} ${base.coin}`);
}

/** Spot buys name the builder and pay no builder fee; spot sells pay it - judged over every spot fill seen. */
export function recordSpotBuyRule(ctx: Ctx): void {
  const all = [...ctx.fillChecks.values()].filter((c) => c.fill.engine === 'spot');
  const buys = all.filter((c) => c.fill.side === 'BUY');
  const sells = all.filter((c) => c.fill.side === 'SELL');
  const buysWithBuilder = buys.filter((c) => c.builderRate !== null && c.builderRate > 0);
  const chargedBuys = buys.filter((c) => c.fill.builderFee !== '0');
  const unpaidSells = sells.filter((c) => c.builderRate !== null && c.builderRate > 0 && c.fill.builderFee === '0');
  const ev = { buys: buys.length, buysNamingTheBuilder: buysWithBuilder.length, buysCharged: chargedBuys.length, sells: sells.length, sellsNotCharged: unpaidSells.length };
  if (chargedBuys.length) ctx.checks.fail('builder-spot-buy-not-charged', `${chargedBuys.length} spot BUY fill(s) paid a builder fee (${chargedBuys[0]!.fill.builderFee})`, ev);
  else if (unpaidSells.length) ctx.checks.fail('builder-spot-buy-not-charged', `${unpaidSells.length} spot SELL fill(s) named the builder and paid no builder fee`, ev);
  else if (!buysWithBuilder.length || !sells.length) ctx.checks.set('builder-spot-buy-not-charged', 'not-run', `needs a spot buy naming the builder and a spot sell; seen: ${buysWithBuilder.length} such buy(s), ${sells.length} sell(s)`, ev);
  else ctx.checks.pass('builder-spot-buy-not-charged', `${buysWithBuilder.length} spot buy fill(s) named the builder and paid none; ${sells.length} sell fill(s) paid it`, ev);
}

// --- the dead-man switch -------------------------------------------------------------------------------------------

function scheduleExpect(engine: Engine, at: { from: number; to: number } | null, label: string, tag: string): Expectation {
  return {
    kind: 'schedule-cancel',
    label,
    tag,
    check: (r) => {
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (r.engine !== engine) return `sent to ${r.engine}, expected ${engine}`;
      const acct = tradingAccount();
      if (acct && b.accountID !== acct) return `account ${String(b.accountID)}, expected ${acct}`;
      const extra = Object.keys(b).filter((k) => k !== 'accountID' && k !== 'scheduledTimestamp');
      if (extra.length) return `carries field(s) it must not have: ${extra.join(', ')}`;
      if (at === null) return b.scheduledTimestamp === undefined ? null : 'names a time; this request was to CLEAR the schedule';
      const t = b.scheduledTimestamp;
      if (typeof t !== 'number' || !Number.isSafeInteger(t)) return `scheduledTimestamp ${String(t)} is not a time`;
      return t >= at.from && t <= at.to ? null : `scheduled for ${new Date(t).toISOString()}, expected between ${new Date(at.from).toISOString()} and ${new Date(at.to).toISOString()}`;
    },
  };
}

async function schedule(ctx: Ctx, engine: Engine, afterMs: number, tag: string): Promise<number> {
  const t0 = Date.now();
  // The app adds `afterMs` to its own clock when the request is built: a second of slack before, five after.
  const r = await armed(ctx, { expect: [scheduleExpect(engine, { from: t0 + afterMs - 1000, to: t0 + afterMs + 5000 }, `${engine}: cancel everything in ${dur(afterMs)}`, tag)] }, () => app.scheduleCancel(engine, afterMs));
  return r.scheduledTimestamp ?? t0 + afterMs;
}
async function clearSchedule(ctx: Ctx, engine: Engine, tag: string): Promise<void> {
  await armed(ctx, { expect: [scheduleExpect(engine, null, `${engine}: clear the scheduled cancel`, tag)] }, () => app.scheduleCancel(engine));
}
async function scheduleAndClear(ctx: Ctx, engine: Engine, afterMs: number): Promise<void> {
  await schedule(ctx, engine, afterMs, `${engine}-schedule-cancel`);
  await clearSchedule(ctx, engine, `${engine}-schedule-cancel`);
}

// --- perps --------------------------------------------------------------------------------------------------------

/** The isolated margin of the open position on `symbol`, or null. */
async function isolatedMargin(ctx: Ctx, symbol: string): Promise<string | null> {
  const st = await engineState('perps', ctx.owner);
  const p = st?.P?.find((x) => x.s === symbol);
  if (p?.iw !== undefined && p.iw !== null) return canon(p.iw);
  const pos = await positionOf(ctx, symbol);
  return pos?.initialMargin !== undefined ? canon(pos.initialMargin) : null;
}

function leverageExpect(m: Market, leverage: number, mode: 'cross' | 'isolated', tag: string): Expectation {
  return {
    kind: 'leverage',
    label: `${m.sym.name}: ${leverage}x ${mode}`,
    tag,
    check: (r) => {
      const b = (r.body ?? {}) as Record<string, unknown>;
      const acct = tradingAccount();
      if (Object.keys(b).join(',') !== 'accountID,symbolID,leverage,marginMode') return `body keys ${Object.keys(b).join(',')}, expected accountID,symbolID,leverage,marginMode`;
      if (acct && b.accountID !== acct) return `account ${String(b.accountID)}, expected ${acct}`;
      if (b.symbolID !== m.sym.id) return `symbol ${String(b.symbolID)}, expected ${m.sym.id}`;
      if (b.leverage !== leverage) return `leverage ${String(b.leverage)}, expected ${leverage}`;
      const want = mode === 'isolated' ? 1 : 2;
      return b.marginMode === want ? null : `marginMode ${String(b.marginMode)}, expected ${want} (${mode})`;
    },
  };
}

function marginExpect(m: Market, amount: string, tag: string): Expectation {
  return {
    kind: 'margin',
    label: `${m.sym.name}: isolated margin ${amount}`,
    tag,
    check: (r) => {
      const b = (r.body ?? {}) as Record<string, unknown>;
      const acct = tradingAccount();
      if (Object.keys(b).join(',') !== 'accountID,symbolID,amount') return `body keys ${Object.keys(b).join(',')}, expected accountID,symbolID,amount`;
      if (acct && b.accountID !== acct) return `account ${String(b.accountID)}, expected ${acct}`;
      if (b.symbolID !== m.sym.id) return `symbol ${String(b.symbolID)}, expected ${m.sym.id}`;
      return b.amount === amount ? null : `amount ${String(b.amount)}, expected ${amount}`;
    },
  };
}

async function setLeverage(ctx: Ctx, m: Market, leverage: number, mode: 'cross' | 'isolated', tag: string): Promise<void> {
  await armed(ctx, { expect: [leverageExpect(m, leverage, mode, tag)] }, () => app.setLeverage(m.sym.name, leverage, mode));
  await waitFor(ctx, `${m.sym.name} at ${leverage}x ${mode} in the account state`, {
    timeoutMs: orderMs(ctx),
    intervalMs: 2000,
    probe: () => symbolConfig(ctx, m),
    done: (c) => c.leverage === leverage && c.mode === (mode === 'isolated' ? 'ISOLATED' : 'CROSS'),
    show: (c) => (c ? `${c.leverage}x ${c.mode}` : '-'),
  });
}

export async function stepOrdersPerps(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  await ensureTrading(ctx);
  const ref = cfg.orders.perpsSymbol;
  const fresh = async (): Promise<Market> => {
    const x = await readMarket('perps', ref);
    rememberMarket(x);
    return x;
  };
  let m = await fresh();
  const name = `perps ${m.sym.name}`;
  await clearLeftovers(ctx, m, 'orders-perps');
  const start = await symbolConfig(ctx, m);
  const L0 = start.leverage;
  const maxLev = m.sym.maxLeverage ?? L0;
  const L1 = L0 > 2 ? L0 - 1 : Math.min(maxLev, L0 + 1);
  const unit = marketQty(m, 10);
  const notional = approx(unit) * approx(m.ask);
  // Two units of position at the lower leverage, three resting orders, one unit of added margin, fees - with room.
  const need = String(Math.max(approx(cfg.orders.perpsCollateral), Math.ceil((6 * notional) / Math.max(1, Math.min(L0, L1)) + 3)));
  await ensurePerpsCollateral(ctx, need);
  rec.note(`${name}: one order is ${unit} (~${notional.toFixed(2)} USD); the market stands at ${L0}x ${start.mode}${start.touched ? '' : ' (its default - the account has not set it)'}`);

  // --- 1. leverage and margin mode -----------------------------------------------------------------------------
  await scenario(ctx, 'perps-leverage-cross', async () => {
    if (L1 === L0) {
      ctx.checks.skip('perps-leverage-cross', `the market allows no other leverage than ${L0}x`);
      return;
    }
    await setLeverage(ctx, m, L1, 'cross', 'perps-leverage-cross');
    ctx.checks.pass('perps-leverage-cross', `${L0}x -> ${L1}x in cross margin; the account state shows it`, { before: L0, after: L1 });
  });
  let isolated = false as boolean;
  await scenario(ctx, 'perps-leverage-isolated', async () => {
    await setLeverage(ctx, m, L1, 'isolated', 'perps-leverage-isolated');
    isolated = true;
    ctx.checks.pass('perps-leverage-isolated', `${m.sym.name} is isolated at ${L1}x; the account state shows it`, { leverage: L1 });
  });

  // --- 2. market by quantity (an isolated position), its margin, the reduce-only close --------------------------
  m = await fresh();
  const q1 = marketQty(m, 10);
  const opened = await mustFill(ctx, m, 'perps-market-by-quantity', { market: m, side: 'buy', type: 'market', quantity: q1 }, `${name} market buy ${q1}`, { rejection: 'fail' });
  ctx.checks.skip('perps-market-by-funds', 'the app\'s order ticket sizes a perps order by quantity only - there is no funds-sized perps order to test');
  if (opened === '0' || !isolated) notRun(ctx, ['perps-margin-add', 'perps-margin-remove'], opened === '0' ? 'no position was opened' : 'the market could not be switched to isolated margin');
  else {
    await scenario(ctx, 'perps-margin-add', async () => {
      const before = await isolatedMargin(ctx, m.sym.name);
      if (before === null) throw new CheckFailure('the position\'s isolated margin cannot be read');
      await armed(ctx, { expect: [marginExpect(m, '1', 'perps-margin-add')] }, () => app.adjustMargin(m.sym.name, '1'));
      const after = await waitFor(ctx, 'the added margin on the position', { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => isolatedMargin(ctx, m.sym.name), done: (v) => v !== null && dCmp(v, dAdd(before, '0.99')) >= 0, show: (v) => `isolated margin ${v ?? '?'} (was ${before})` });
      ctx.checks.pass('perps-margin-add', `isolated margin ${before} -> ${after} (+1 USDC)`, { before, after });
    });
    await scenario(ctx, 'perps-margin-remove', async () => {
      const before = await isolatedMargin(ctx, m.sym.name);
      if (before === null) throw new CheckFailure('the position\'s isolated margin cannot be read');
      await armed(ctx, { expect: [marginExpect(m, '-0.5', 'perps-margin-remove')] }, () => app.adjustMargin(m.sym.name, '-0.5'));
      const after = await waitFor(ctx, 'the removed margin on the position', { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => isolatedMargin(ctx, m.sym.name), done: (v) => v !== null && dCmp(v, dSub(before, '0.49')) <= 0, show: (v) => `isolated margin ${v ?? '?'} (was ${before})` });
      ctx.checks.pass('perps-margin-remove', `isolated margin ${before} -> ${after} (-0.5 USDC)`, { before, after });
    });
  }
  await scenario(
    ctx,
    'perps-reduce-only-close',
    async () => {
      const pos = await positionOf(ctx, m.sym.name);
      if (!pos) {
        ctx.checks.set('perps-reduce-only-close', 'not-run', 'no position was open');
        return;
      }
      const r = await flatten(ctx, m, 'perps-reduce-only-close', `${name} reduce-only close`);
      ctx.checks.pass('perps-reduce-only-close', `the position of ${r.closed} is closed (${idText(r.id!)}); flat; ${r.note}`, { closed: r.closed, orderID: r.id?.orderID });
    },
    () => putInOrder(ctx, m, 'perps-reduce-only-close'),
  );
  // Back to where the market stood (a margin mode can only change with no order and no position on it).
  await rec.sub(`${name}: back to ${L0}x cross`, () => setLeverage(ctx, m, L0, 'cross', 'perps-end-flat'));

  // --- 3. limit: rest, change, cancel ------------------------------------------------------------------------------
  await restChangeCancel(ctx, 'perps', ref, cfg.orders.perpsLimitOffsetPct);

  // --- 4. post-only and IOC ---------------------------------------------------------------------------------------
  m = await fresh();
  let rb = restingBuy(m, cfg.orders.perpsLimitOffsetPct);
  let px = crossingBuyPrice(m);
  let q = minQtyAt(m, px, 5);
  await restsThenCancel(ctx, m, 'perps-gtx-rest', { market: m, side: 'buy', type: 'limit', tif: 'gtx', price: rb.price, quantity: rb.qty }, `${name} post-only buy ${rb.qty} @ ${rb.price}`);
  await mustNotFill(ctx, m, 'perps-gtx-cross', { market: m, side: 'buy', type: 'limit', tif: 'gtx', price: px, quantity: q }, `${name} post-only buy ${q} @ ${px} (above the ask ${m.ask})`, { rests: 'finding', rejection: 'pass' });
  await mustNotFill(ctx, m, 'perps-ioc-no-cross', { market: m, side: 'buy', type: 'limit', tif: 'ioc', price: rb.price, quantity: rb.qty }, `${name} IOC buy ${rb.qty} @ ${rb.price} (far below the market)`, { rests: 'fail', rejection: 'pass' });
  m = await fresh();
  px = crossingBuyPrice(m);
  q = minQtyAt(m, px, 5);
  await mustFill(ctx, m, 'perps-ioc-cross', { market: m, side: 'buy', type: 'limit', tif: 'ioc', price: px, quantity: q }, `${name} IOC buy ${q} @ ${px} (crosses the ask ${m.ask})`, { rejection: 'fail' });

  // --- 5. stop-loss and take-profit on the open position --------------------------------------------------------------
  const pos = await positionOf(ctx, m.sym.name);
  if (!pos || approx(pos.size) <= 0) {
    notRun(ctx, ['perps-position-stop-loss', 'perps-position-take-profit', 'perps-trigger-observed', 'builder-modify-keeps-builder'], 'no long position is open (the IOC order did not fill)');
  } else {
    const size = canon(pos.size);
    for (const kind of ['sl', 'tp'] as const) {
      const id = kind === 'sl' ? 'perps-position-stop-loss' : 'perps-position-take-profit';
      const word = kind === 'sl' ? 'stop-loss' : 'take-profit';
      await scenario(
        ctx,
        id,
        async () => {
          m = await fresh();
          const at = triggerPrice(m, kind === 'sl' ? 'below' : 'above', 4);
          // What the Positions table sends: a reduce-only market order for the whole position, with a trigger on the mark price.
          const r = await mustPlace(ctx, { market: m, side: 'sell', type: 'market', quantity: size, reduceOnly: true, stop: { price: at, kind }, tag: id, label: `${name} ${word} at ${at}` });
          const row = await expectOpen(ctx, m, r.id, `the ${word}`);
          if (canon(row.stopPrice) !== at) throw new CheckFailure(`the ${word} is listed with trigger ${row.stopPrice}, not ${at}`, { row });
          const next = ticksFrom(m, at, kind === 'sl' ? -1 : 1);
          const recreate = appRecreates.stop();
          const expect = recreate
            ? [
                cancelExpect('perps', [r.id], `${word}: cancel (the app changes it as cancel + new order)`, id),
                orderExpect(ctx, { market: m, side: 'sell', type: 'market', quantity: size, reduceOnly: true, stop: { price: next, kind }, tag: id, label: `${name} ${word} at ${next} (the new order)` }),
              ]
            : [modifyExpect(m, r.id, next, `${word}: trigger ${at} -> ${next}`, id)];
          await armed(ctx, { expect }, () => changeStopOrder({ symbol: m.sym.name, orderID: r.id.orderID!, stopPrice: next }));
          const atTrigger = async (price: string): Promise<OpenOrder> => {
            const list = await waitFor(ctx, `the ${word} at ${price}`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => openOn(ctx, m), done: (l) => l.some((o) => canon(o.stopPrice) === price), show: (l) => (l ?? []).map((o) => `#${o.orderID} stop ${o.stopPrice}`).join(', ') || 'no open order' });
            const row = list.find((o) => canon(o.stopPrice) === price)!;
            ctx.ledger.noteRecord('perps', row as Record<string, unknown>, 'open-orders');
            return row;
          };
          let moved = await atTrigger(next);
          let now: Placed = { orderID: moved.orderID ?? r.id.orderID, clOrdID: moved.clOrdID ?? r.id.clOrdID };
          if (!recreate) noteKeepsBuilder(ctx, 'modify', `${word} trigger change (the app's modify)`, r.order?.builder ?? null, builderRef(moved.builder));
          else if (ctx.cfg.builder && defaultFee(ctx, 'perps') > 0 && now.orderID !== null) {
            // G6: the app does not send SoDEX's modify here; ONE modify, made by the app with its builder optional for that call.
            const third = ticksFrom(m, next, kind === 'sl' ? -1 : 1);
            const before = ctx.ledger.find('perps', now)?.builder ?? null;
            const target = now;
            try {
              await withOptionalBuilder(ctx, `to see what SoDEX's modify does to the builder of a ${word}`, () =>
                armed(ctx, { expect: [modifyExpect(m, target, third, `${word} ${idText(target)}: trigger ${next} -> ${third} (G6)`, 'builder-modify-keeps-builder')] }, () => changeStopOrder({ symbol: m.sym.name, orderID: target.orderID!, stopPrice: third })),
              );
              moved = await atTrigger(third);
              now = { orderID: moved.orderID ?? now.orderID, clOrdID: moved.clOrdID ?? now.clOrdID };
              noteKeepsBuilder(ctx, 'modify', `${word} trigger change (SoDEX's modify, the builder optional for that call)`, before, builderRef(moved.builder));
            } catch (e) {
              if (!isDefiniteRefusal(e)) throw e;
              ctx.checks.finding('builder-modify-keeps-builder', `SoDEX REJECTED a modify of a stand-alone ${word} ("${e instanceof Error ? e.message : String(e)}") - the request cannot be used; MODIFY_KEEPS_BUILDER must be false`, {});
            }
          }
          await cancel(ctx, m, now, `${word}: cancel`, id);
          await expectGone(ctx, m, now, `the ${word}`);
          if (!(await positionOf(ctx, m.sym.name))) throw new CheckFailure(`the position is gone - the ${word} fired although the market never reached ${next}`);
          ctx.checks.pass(id, `listed as ${idText(r.id)} with trigger ${at}; trigger changed to ${next} ${recreate ? 'as cancel + new order (MODIFY_KEEPS_BUILDER is false)' : "with SoDEX's modify"}${now.orderID === r.id.orderID ? ' (the same order id)' : ` (now ${idText(now)})`}; cancelled; the position is untouched`, { orderID: r.id.orderID, trigger: at, changedTo: next, modifier: r.order?.modifier ?? null, recreated: recreate });
        },
        async () => {
          await putInOrderKeepingPosition(ctx, m);
        },
      );
    }
    if (!ctx.cfg.builder) ctx.checks.skip('builder-modify-keeps-builder', 'no builder in this run');
    if (!ctx.cfg.builder) ctx.checks.skip('builder-replace-keeps-builder', 'no builder in this run');

    // A take-profit placed just above the market: watch it fire. Not firing is not a failure.
    await scenario(
      ctx,
      'perps-trigger-observed',
      async () => {
        const wait = cfg.orders.triggerWaitSeconds * 1000;
        if (wait <= 0) {
          ctx.checks.skip('perps-trigger-observed', 'orders.triggerWaitSeconds is 0: no real trigger is waited for');
          return;
        }
        if (!(await positionOf(ctx, m.sym.name))) {
          ctx.checks.set('perps-trigger-observed', 'not-run', 'no position is open');
          return;
        }
        m = await fresh();
        const at = toStep(dMul(m.ask, '1.0002'), m.sym.tickSize || '0', 'ceil');
        const r = await mustPlace(ctx, { market: m, side: 'sell', type: 'market', quantity: size, reduceOnly: true, stop: { price: at, kind: 'tp' }, tag: 'perps-trigger-observed', label: `${name} take-profit at ${at} (just above the ask ${m.ask})` });
        const fired = await waitMaybe({ timeoutMs: wait, intervalMs: 3000, probe: () => positionOf(ctx, m.sym.name), done: (p) => p === null });
        if (fired.ok) {
          const s = await settleFills(ctx, m, r.id, size);
          ctx.checks.pass('perps-trigger-observed', `the take-profit at ${at} fired and closed the position of ${size}; ${s.note}`, { orderID: r.id.orderID, trigger: at }, s.costUsd);
          return;
        }
        const still = (await openOn(ctx, m)).find((o) => isOurs(o, r.id));
        if (still) {
          await cancel(ctx, m, r.id, 'take-profit: cancel', 'perps-trigger-observed');
          await expectGone(ctx, m, r.id, 'the take-profit');
        }
        ctx.checks.skip('perps-trigger-observed', `trigger not observed: the mark price did not reach ${at} within ${dur(wait)}; the take-profit was cancelled`, { orderID: r.id.orderID, trigger: at, waitedMs: wait });
      },
      async () => {
        await putInOrderKeepingPosition(ctx, m);
      },
    );
  }

  // --- 6. FOK: SoDEX rejects it ("timeInForce is invalid", live 2026-10-03) - the app refuses it before signing -------
  m = await fresh();
  rb = restingBuy(m, cfg.orders.perpsLimitOffsetPct);
  await fokRefused(ctx, 'perps-fok-not-fillable', `${name} FOK buy ${rb.qty} @ ${rb.price} (far below the market)`, () => app.placeOrder('perps', { symbol: m.sym.name, side: 'buy', type: 'limit', tif: 'fok', price: rb.price, quantity: rb.qty }));
  px = crossingBuyPrice(m);
  q = minQtyAt(m, px, 5);
  await fokRefused(ctx, 'perps-fok-fillable', `${name} FOK buy ${q} @ ${px} (crosses the ask ${m.ask})`, () => app.placeOrder('perps', { symbol: m.sym.name, side: 'buy', type: 'limit', tif: 'fok', price: px, quantity: q }));

  // Flat again before the entry with exits.
  await rec.sub(`${name}: close whatever is open`, async () => {
    await cancelAllQuietly(ctx, m);
    return flatten(ctx, m, 'perps-end-flat', `${name} close before the next scenario`);
  }, (r) => r.note);

  // --- 7. entry with attached take-profit and stop-loss --------------------------------------------------------------
  await scenario(
    ctx,
    'perps-entry-with-tp-sl',
    async () => {
      m = await fresh();
      const qe = marketQty(m, 10);
      const tp = triggerPrice(m, 'above', 4);
      const sl = triggerPrice(m, 'below', 4);
      const r = await mustPlace(ctx, { market: m, side: 'buy', type: 'market', quantity: qe, takeProfit: tp, stopLoss: sl, tag: 'perps-entry-with-tp-sl', label: `${name} market buy ${qe} with take-profit ${tp} and stop-loss ${sl}` });
      await expectPosition(ctx, m.sym.name, qe, `the ${m.sym.name} position of ${qe}`);
      const s = await settleFills(ctx, m, r.id, qe);
      const open = await waitFor(ctx, 'both exits in the open orders', { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => openOn(ctx, m), done: (l) => l.some((o) => canon(o.stopPrice) === tp) && l.some((o) => canon(o.stopPrice) === sl), show: (l) => (l ?? []).map((o) => `#${o.orderID} stop ${o.stopPrice}`).join(', ') || 'no open order' });
      for (const o of open) ctx.ledger.noteRecord('perps', o as Record<string, unknown>, 'open-orders');
      const exits = open.filter((o) => canon(o.stopPrice) === tp || canon(o.stopPrice) === sl);
      const loose = exits.filter((o) => o.reduceOnly === false);
      if (loose.length) throw new CheckFailure('an exit is not reduce-only', { exits });
      // Close the position; the exits must not outlive it.
      const closed = await flatten(ctx, m, 'perps-entry-with-tp-sl', `${name} close the position with exits`);
      const left = await waitMaybe({ timeoutMs: Math.min(orderMs(ctx), 15_000), intervalMs: 2000, probe: () => openOn(ctx, m), done: (l) => l.length === 0 });
      let exitsNote = 'SoDEX removed both exits when the position closed';
      if (!left.ok) {
        const n = await cancelAllQuietly(ctx, m);
        exitsNote = `the ${n} exit order(s) STAYED OPEN after the position closed - cancelled by the run (the app's Positions table would show them as orphans)`;
      }
      ctx.checks.set('perps-entry-with-tp-sl', left.ok ? 'pass' : 'finding', `entry ${idText(r.id)} filled ${qe} (${s.note}); take-profit ${tp} and stop-loss ${sl} are listed, reduce-only; position closed (${closed.note}); ${exitsNote}`, {
        entry: r.id.orderID,
        exits: exits.map((o) => ({ orderID: o.orderID, stopPrice: o.stopPrice, stopType: o.stopType ?? null, primaryOrderID: o.primaryOrderID ?? null })),
        modifiers: { entry: r.order?.modifier ?? null },
        exitsRemovedBySodex: left.ok,
      }, s.costUsd);
    },
    () => putInOrder(ctx, m, 'perps-entry-with-tp-sl'),
  );

  // --- 8. cancel-all ---------------------------------------------------------------------------------------------------
  await scenario(
    ctx,
    'perps-cancel-all',
    async () => {
      m = await fresh();
      const base = restingBuy(m, cfg.orders.perpsLimitOffsetPct);
      const ids: Placed[] = [];
      for (const i of [0, 1, 2]) {
        const price = ticksFrom(m, base.price, -i);
        const qty = minQtyAt(m, price, 5);
        const r = await mustPlace(ctx, { market: m, side: 'buy', type: 'limit', tif: 'gtc', price, quantity: qty, tag: 'perps-cancel-all', label: `${name} resting buy ${i + 1} of 3 (${qty} @ ${price})` });
        ids.push(r.id);
      }
      await waitFor(ctx, 'three resting orders', { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => openOn(ctx, m), done: (l) => ids.every((id) => l.some((o) => isOurs(o, id))), show: (l) => `${l?.length ?? 0} open` });
      const res = await armed(ctx, { expect: [cancelExpect('perps', ids, `cancel all 3 on ${m.sym.name}`, 'perps-cancel-all')] }, () => app.cancelAll('perps', m.sym.name));
      await waitFor(ctx, 'the three orders to leave the book', { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => openOn(ctx, m), done: (l) => l.length === 0, show: (l) => `${l?.length ?? '?'} still open` });
      ctx.checks.pass('perps-cancel-all', `three resting orders (${ids.map(idText).join(', ')}) were cancelled by ONE request; the app reports ${res.cancelled} cancelled`, { orders: ids.map((i) => i.orderID), reported: res.cancelled });
    },
    () => putInOrder(ctx, m, 'perps-cancel-all'),
  );

  // --- 9. the dead-man switch -------------------------------------------------------------------------------------------
  let guardOrder = null as Placed | null;
  await scenario(
    ctx,
    'perps-schedule-cancel-clear',
    async () => {
      m = await fresh();
      const b = restingBuy(m, cfg.orders.perpsLimitOffsetPct);
      const r = await mustPlace(ctx, { market: m, side: 'buy', type: 'limit', tif: 'gtc', price: b.price, quantity: b.qty, tag: 'perps-schedule-cancel-clear', label: `${name} resting buy for the dead-man switch` });
      await expectOpen(ctx, m, r.id, 'the resting order');
      guardOrder = r.id;
      const at = await schedule(ctx, 'perps', scheduleMs(), 'perps-schedule-cancel-clear');
      await clearSchedule(ctx, 'perps', 'perps-schedule-cancel-clear');
      const grace = scheduleGraceMs();
      await sleep(Math.max(0, at - Date.now()) + grace);
      if (!(await openOn(ctx, m)).some((o) => isOurs(o, r.id))) throw new CheckFailure(`the order was cancelled at the scheduled time although the schedule had been cleared`, { orderID: r.id.orderID, scheduledFor: at });
      ctx.checks.pass('perps-schedule-cancel-clear', `a cancel-all scheduled for ${new Date(at).toISOString()} was cleared; ${dur(grace)} past that time the order is still open`, { orderID: r.id.orderID, scheduledFor: at });
    },
    () => putInOrder(ctx, m, 'perps-schedule-cancel-clear'),
  );
  await scenario(
    ctx,
    'perps-schedule-cancel-fires',
    async () => {
      if (!guardOrder || !(await openOn(ctx, m)).some((o) => isOurs(o, guardOrder!))) {
        ctx.checks.set('perps-schedule-cancel-fires', 'not-run', 'no resting order is open');
        return;
      }
      const at = await schedule(ctx, 'perps', scheduleMs(), 'perps-schedule-cancel-fires');
      const gone = await waitMaybe({ timeoutMs: Math.max(0, at - Date.now()) + orderMs(ctx), intervalMs: 1500, probe: () => openOn(ctx, m), done: (l) => !l.some((o) => isOurs(o, guardOrder!)) });
      const seenAt = Date.now();
      // Clearing afterwards must not be an error the app surfaces; SoDEX may say there is nothing scheduled.
      const cleared = await clearSchedule(ctx, 'perps', 'perps-schedule-cancel-fires').then(() => 'cleared afterwards', (e: unknown) => `clearing afterwards answered: ${e instanceof Error ? e.message : String(e)}`);
      if (!gone.ok) throw new CheckFailure(`SoDEX did not cancel the order: ${dur(seenAt - at)} after the scheduled time it is still open`, { orderID: guardOrder.orderID, scheduledFor: at });
      if (seenAt < at - 1500) throw new CheckFailure(`the order left the book ${dur(at - seenAt)} BEFORE the scheduled time`, { scheduledFor: at, seenAt });
      await awaitFills(ctx, 'perps', guardOrder);
      ctx.checks.pass('perps-schedule-cancel-fires', `scheduled for ${new Date(at).toISOString()}; the order was gone ${dur(Math.max(0, seenAt - at))} after that time${seen(ctx, 'perps', guardOrder).status ? ` (SoDEX: ${seen(ctx, 'perps', guardOrder).status})` : ''}; ${cleared}`, { orderID: guardOrder.orderID, scheduledFor: at, goneBy: seenAt });
    },
    () => putInOrder(ctx, m, 'perps-schedule-cancel-fires'),
  );

  // --- 10. the end ------------------------------------------------------------------------------------------------------
  await judgeFills(ctx);
  await scenario(
    ctx,
    'perps-end-flat',
    async () => {
      m = await fresh();
      const open = await openOn(ctx, m);
      const p = await positionOf(ctx, m.sym.name);
      const c = await symbolConfig(ctx, m);
      const wrong: string[] = [];
      if (open.length) wrong.push(`${open.length} order(s) still open`);
      if (p) wrong.push(`a position of ${p.size} is open`);
      if (c.leverage !== L0 || c.mode !== 'CROSS') wrong.push(`the market stands at ${c.leverage}x ${c.mode}, not ${L0}x CROSS`);
      if (wrong.length) throw new CheckFailure(wrong.join('; '), { open, position: p, config: c });
      ctx.checks.pass('perps-end-flat', `flat, no open orders, ${m.sym.name} back at ${L0}x cross`, { leverage: c.leverage, mode: c.mode });
    },
    async () => {
      await putInOrder(ctx, m, 'perps-end-flat');
      await setLeverage(ctx, m, L0, 'cross', 'perps-end-flat');
    },
  );
  for (const id of ['perps-fees-commission', 'perps-fees-builder']) notRun(ctx, [id], 'the account stream reported no perps fills - they are judged in the final cross-check');
  await releasePerpsCollateral(ctx);
  const b = await balancesOf(owner, ctx.pre.usdc);
  rec.note(`Spot USDC now ${b.spot}, Perps ${b.perps}`);
}

/** How far ahead the dead-man switch is set (SoDEX wants at least 5 s), and how long past it the run looks. */
const scheduleMs = (): number => paced(8_000);
const scheduleGraceMs = (): number => paced(4_000);

/** Cancel every open order on the market, leaving a position alone. */
async function cancelAllQuietly(ctx: Ctx, m: Market): Promise<number> {
  const open = await openOn(ctx, m);
  if (!open.length) return 0;
  const ids = open.map((o) => ({ orderID: o.orderID ?? null, clOrdID: o.clOrdID ?? null }));
  await armed(ctx, { expect: [cancelExpect(m.engine, ids, `cancel ${ids.length} order(s) on ${m.sym.name}`)] }, () => app.cancelAll(m.engine, m.sym.name));
  await waitFor(ctx, `the open orders on ${m.sym.name} to clear`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => openOn(ctx, m), done: (l) => l.length === 0, show: (l) => `${l?.length ?? '?'} still open` });
  return ids.length;
}
const putInOrderKeepingPosition = cancelAllQuietly;

