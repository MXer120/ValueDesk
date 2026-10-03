/**
 * What must be REFUSED. Nothing in this step may move anything.
 *
 * Two kinds of refusal:
 *   - by the app, before anything is signed or sent (a limit order below the
 *     minimum notional, a quantity that rounds to zero, a trigger SoDEX does not
 *     take, more than the balance, below the withdrawal minimum, a malformed
 *     receiver). The runner arms NOTHING for these: had the app tried to send,
 *     the guard would have stopped it and the check fails with "the app tried".
 *   - by SoDEX (a market order below the minimum notional, a reduce-only order
 *     with no position, an order naming a builder the wallet never approved or a
 *     fee above its approval). The request is allowed out - exactly that one -
 *     and SoDEX must say no; if it does not, the check fails and whatever
 *     resulted is closed again.
 * Off-grid inputs are not refused but SNAPPED by the app: the guard lets the
 * order out only with the snapped values, and the open order must show them.
 */
import { OrderSide, OrderType, TimeInForce, canonicalDecimal, perpsActions } from '@sodex-core';
import { balancesOf, receiverProblem, transferFunds, unitsDown, withdrawFunds, type ChainRoute, type CoinConfig } from '../../src/trading/funds';
import type { AddressKind } from '../../src/trading/addresses';
import { NO_CHECKSUM, SAMPLE_ADDRESS, malformedReceivers, receiverFormatProblems } from './receivers';
import { formatUnits } from '../../src/trading/onboard';
import { genClOrdID } from '../../src/trading/orderParams';
import { readBuilderRates } from '../../src/trading/builderApproval';
import { getTradingState } from '../../src/trading/session';
import { app } from './app';
import { CheckFailure, SafetyStop, scenario, type Ctx } from './context';
import {
  awaitFills,
  cancel,
  expectGone,
  expectOpen,
  idText,
  isOurs,
  marketSellQty,
  openOn,
  place,
  positionOf,
  putInOrder,
  refusedLocally,
  rememberMarket,
  restsAfter,
  sendDirect,
  ticketOf,
  type OrderSpec,
} from './orders';
import { marketQty, readMarket, restingBuy, type Market } from './plan';
import { ensureTrading } from './trading';
import { approx, dAdd, dCmp, dMul, toStep } from './util';

const canon = (v: string | number | undefined | null): string => {
  try {
    return canonicalDecimal(String(v ?? '0'));
  } catch {
    return String(v);
  }
};
const rule = (v: string | undefined | null): string => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : '0');

export { NO_CHECKSUM, SAMPLE_ADDRESS, malformedReceivers, receiverFormatProblems };

export async function stepRefusals(ctx: Ctx): Promise<void> {
  const { owner, cfg, rec } = ctx;
  await ensureTrading(ctx);
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const perps = await readMarket('perps', cfg.orders.perpsSymbol);
  const spot = await readMarket('spot', cfg.orders.spotSymbol);
  rememberMarket(perps);
  rememberMarket(spot);

  /** A local refusal: the app must refuse by itself; the detail is its own words. */
  const local = async (id: string, what: string, fn: () => Promise<unknown>, expectMessage?: RegExp): Promise<void> => {
    await scenario(ctx, id, async () => {
      const r = await refusedLocally(ctx, fn);
      if (!r.refused) throw new CheckFailure(`${what}: ${r.why}`);
      if (expectMessage && !expectMessage.test(r.reason)) throw new CheckFailure(`${what}: refused, but for another reason: "${r.reason}"`);
      ctx.checks.pass(id, `${what}: the app refused it before signing ("${r.reason}"); nothing was sent`, { refusal: r.reason });
    });
  };

  // --- limit orders below the minimum notional, a quantity below one step ----------------------------------------------
  for (const m of [perps, spot]) {
    const rb = restingBuy(m, m.engine === 'perps' ? cfg.orders.perpsLimitOffsetPct : cfg.orders.spotLimitOffsetPct);
    const tiny = dCmp(rule(m.sym.minQuantity), '0') > 0 ? rule(m.sym.minQuantity) : rule(m.sym.stepSize);
    const id = `refuse-${m.engine}-limit-below-min-notional`;
    if (dCmp(rule(m.sym.minNotional), '0') <= 0 || dCmp(dMul(rb.price, tiny), rule(m.sym.minNotional)) >= 0) {
      ctx.checks.skip(id, `${m.sym.name} has no order below its minimum notional that is still at least its minimum quantity`);
    } else {
      await local(id, `${m.engine} limit buy ${tiny} @ ${rb.price} (${dMul(rb.price, tiny)} < minimum notional ${m.sym.minNotional})`, () => app.placeOrder(m.engine, { symbol: m.sym.name, side: 'buy', type: 'limit', price: rb.price, quantity: tiny, tif: 'gtc' }), /notional|minimum/i);
    }
  }
  {
    const step = rule(perps.sym.stepSize);
    const rb = restingBuy(perps, cfg.orders.perpsLimitOffsetPct);
    if (dCmp(step, '0') <= 0) ctx.checks.skip('refuse-quantity-rounds-to-zero', `${perps.sym.name} has no quantity step`);
    else await local('refuse-quantity-rounds-to-zero', `perps limit buy of ${dMul(step, '0.4')} (less than one step of ${step})`, () => app.placeOrder('perps', { symbol: perps.sym.name, side: 'buy', type: 'limit', price: rb.price, quantity: dMul(step, '0.4'), tif: 'gtc' }), /zero|step|quantity/i);
  }

  // --- triggers SoDEX does not take; spot has none at all ------------------------------------------------------------------
  await scenario(ctx, 'refuse-trigger-type-not-mark', async () => {
    const q = marketQty(perps, 10);
    const at = toStep(dMul(perps.bid, '0.96'), rule(perps.sym.tickSize), 'floor');
    const seen: string[] = [];
    for (const trigger of ['last', 'index'] as const) {
      const r = await refusedLocally(ctx, () => app.placeOrder('perps', { symbol: perps.sym.name, side: 'sell', type: 'market', quantity: q, reduceOnly: true, stopPrice: at, stopType: 'sl', triggerType: trigger }));
      if (!r.refused) throw new CheckFailure(`a stop-loss triggered by the ${trigger} price: ${r.why}`);
      seen.push(`${trigger}: "${r.reason}"`);
    }
    ctx.checks.pass('refuse-trigger-type-not-mark', `a stop on the last price and one on the index price were both refused by the app before signing (${seen.join('; ')})`, { refusals: seen });
  });
  await local(
    'refuse-spot-trigger',
    'a spot order with a trigger price',
    () => app.placeOrder('spot', { symbol: spot.sym.name, side: 'sell', type: 'market', quantity: marketSellQty(spot, 10), stopPrice: toStep(dMul(spot.bid, '0.9'), rule(spot.sym.tickSize), 'floor'), stopType: 'sl' }),
    /spot|trigger/i,
  );

  // --- off-grid inputs: snapped, not refused ----------------------------------------------------------------------------------
  await scenario(
    ctx,
    'refuse-off-tick-price',
    async () => {
      const m = await readMarket('perps', cfg.orders.perpsSymbol);
      rememberMarket(m);
      const rb = restingBuy(m, cfg.orders.perpsLimitOffsetPct);
      const tick = rule(m.sym.tickSize);
      const step = rule(m.sym.stepSize);
      if (dCmp(tick, '0') <= 0 || dCmp(step, '0') <= 0) {
        ctx.checks.skip('refuse-off-tick-price', `${m.sym.name} has no tick / step grid`);
        ctx.checks.skip('refuse-off-step-quantity', `${m.sym.name} has no tick / step grid`);
        return;
      }
      // 30 % of a tick above the grid price rounds back to it; 70 % of a step above the grid size is cut off.
      const rawPrice = dAdd(rb.price, dMul(tick, '0.3'));
      const rawQty = dAdd(rb.qty, dMul(step, '0.7'));
      const spec: OrderSpec = { market: m, side: 'buy', type: 'limit', tif: 'gtc', price: rb.price, quantity: rb.qty, tag: 'refuse-off-tick-price', label: `perps limit buy typed as ${rawQty} @ ${rawPrice}` };
      const r = await place(ctx, spec, { ...ticketOf(spec), price: rawPrice, quantity: rawQty });
      if (!r.ok) throw new CheckFailure(`the order typed as ${rawQty} @ ${rawPrice} was ${r.sent ? 'rejected by SoDEX' : 'refused by the app'}: ${r.reason}`);
      const row = await expectOpen(ctx, m, r.id, 'the snapped order');
      await cancel(ctx, m, r.id, 'the snapped order: cancel', 'refuse-off-tick-price');
      await expectGone(ctx, m, r.id, 'the snapped order');
      if (canon(row.price) !== rb.price) throw new CheckFailure(`typed ${rawPrice}; the open order reads ${row.price}, expected ${rb.price}`, { row });
      ctx.checks.pass('refuse-off-tick-price', `typed ${rawPrice} (off the ${tick} tick): the order left - and rests - at ${rb.price}`, { typed: rawPrice, sent: rb.price, orderID: r.id.orderID });
      if (canon(row.origQty) !== rb.qty) ctx.checks.fail('refuse-off-step-quantity', `typed ${rawQty}; the open order reads ${row.origQty}, expected ${rb.qty}`, { row });
      else ctx.checks.pass('refuse-off-step-quantity', `typed ${rawQty} (off the ${step} step): the order left - and rests - with ${rb.qty} (cut down, never rounded up)`, { typed: rawQty, sent: rb.qty, orderID: r.id.orderID });
    },
    () => putInOrder(ctx, perps, 'refuse-off-tick-price'),
  );
  if (!ctx.checks.get('refuse-off-step-quantity')) ctx.checks.set('refuse-off-step-quantity', 'not-run', 'the off-grid order did not rest (refuse-off-tick-price)');

  // --- SoDEX must refuse: market orders below the minimum notional ---------------------------------------------------------------
  for (const m of [perps, spot]) {
    const id = `refuse-${m.engine}-market-below-min-notional`;
    await scenario(
      ctx,
      id,
      async () => {
        const now = await readMarket(m.engine, m.sym.name);
        rememberMarket(now);
        const q = dCmp(rule(now.sym.marketMinQuantity), '0') > 0 ? rule(now.sym.marketMinQuantity) : dCmp(rule(now.sym.minQuantity), '0') > 0 ? rule(now.sym.minQuantity) : rule(now.sym.stepSize);
        if (dCmp(rule(now.sym.minNotional), '0') <= 0 || dCmp(dMul(q, now.ask), dMul(rule(now.sym.minNotional), '0.9')) >= 0) {
          ctx.checks.skip(id, `${now.sym.name}: its smallest market order (${q}) is not below the minimum notional ${now.sym.minNotional}`);
          return;
        }
        await mustMoveNothing(ctx, now, id, { market: now, side: 'buy', type: 'market', quantity: q, tag: id, label: `${now.engine} market buy ${q} (~${dMul(q, now.ask)} USD, minimum notional ${now.sym.minNotional})` });
      },
      () => putInOrder(ctx, m, id),
    );
  }

  // --- SoDEX must refuse: reduce-only with nothing to reduce ----------------------------------------------------------------------
  await scenario(
    ctx,
    'refuse-reduce-only-without-position',
    async () => {
      const m = await readMarket('perps', cfg.orders.perpsSymbol);
      rememberMarket(m);
      if (await positionOf(ctx, m.sym.name)) throw new SafetyStop(`a position is open on ${m.sym.name}: this check needs the market flat`);
      const q = marketQty(m, 10);
      await mustMoveNothing(ctx, m, 'refuse-reduce-only-without-position', { market: m, side: 'sell', type: 'market', quantity: q, reduceOnly: true, tag: 'refuse-reduce-only-without-position', label: `perps reduce-only market sell ${q} with no position` });
    },
    () => putInOrder(ctx, perps, 'refuse-reduce-only-without-position'),
  );

  // --- more than the balance; below the minimum; malformed receivers ---------------------------------------------------------------
  await scenario(ctx, 'refuse-transfer-over-balance', async () => {
    const b = await balancesOf(owner, usdc);
    const over = (v: string): string => formatUnits(unitsDown(v, dp) + 1_000_000n, dp);
    const cases: Array<[string, () => Promise<unknown>]> = [
      [`Spot -> Perps ${over(b.spot)} USDC (Spot can move ${b.spot})`, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'spot', to: 'perps', amount: over(b.spot) })],
      [`Perps -> Spot ${over(b.perps)} USDC (Perps can move ${b.perps})`, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'perps', to: 'spot', amount: over(b.perps) })],
      [`Spot -> wallet ${over(b.spot)} USDC`, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'spot', to: 'evm', amount: over(b.spot) })],
      [`wallet -> Spot ${over(b.evm)} USDC (the wallet holds ${b.evm})`, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'evm', to: 'spot', amount: over(b.evm) })],
    ];
    const seen: string[] = [];
    for (const [what, fn] of cases) {
      const r = await refusedLocally(ctx, fn);
      if (!r.refused) throw new CheckFailure(`${what}: ${r.why}`);
      seen.push(`${what}: "${r.reason}"`);
    }
    const after = await balancesOf(owner, usdc);
    if (after.spot !== b.spot || after.perps !== b.perps || after.evm !== b.evm) throw new CheckFailure(`balances changed: Spot ${b.spot} -> ${after.spot}, Perps ${b.perps} -> ${after.perps}, wallet ${b.evm} -> ${after.evm}`);
    ctx.checks.pass('refuse-transfer-over-balance', `${cases.length} transfers of more than the balance were each refused by the app; the balances did not change`, { refusals: seen });
  });

  const w = cfg.withdrawExternal;
  const wCoin = ctx.pre.coins.find((c) => c.coin.toUpperCase() === w.coin.toUpperCase());
  const wRoute = wCoin?.chains.find((r) => r.key === w.chain);
  await scenario(ctx, 'refuse-withdraw-over-balance', async () => {
    if (!wCoin || !wRoute || !wRoute.withdraw.allowed || wRoute.addressKind !== 'evm') {
      ctx.checks.skip('refuse-withdraw-over-balance', `no open EVM withdrawal route for ${w.coin} on ${w.chain} to try it on`);
      return;
    }
    const b = await balancesOf(owner, wCoin);
    const cdp = wCoin.valuechain.decimals;
    const total = unitsDown(b.spot, cdp) + unitsDown(b.perps, cdp) + unitsDown(b.evm, cdp);
    const min = unitsDown(wRoute.withdraw.min ?? '0', cdp);
    const amount = formatUnits((total > min ? total : min) + 10n ** BigInt(cdp), cdp);
    const r = await refusedLocally(ctx, () => withdrawFunds({ owner, provider: ctx.provider, coin: wCoin, route: wRoute, receiver: owner, amount, sources: { spot: true, perps: true, evm: true } }));
    if (!r.refused) throw new CheckFailure(`withdrawing ${amount} ${wCoin.coin} (all accounts together hold ${formatUnits(total, cdp)}): ${r.why}`);
    ctx.checks.pass('refuse-withdraw-over-balance', `a withdrawal of ${amount} ${wCoin.coin} to ${wRoute.label} (the accounts hold ${formatUnits(total, cdp)}) was refused by the app ("${r.reason}"); nothing was sent`, { refusal: r.reason });
  });
  await scenario(ctx, 'refuse-withdraw-below-minimum', async () => {
    if (!wCoin || !wRoute || !wRoute.withdraw.allowed || !wRoute.withdraw.min || wRoute.addressKind !== 'evm') {
      ctx.checks.skip('refuse-withdraw-below-minimum', `no open EVM withdrawal route with a minimum for ${w.coin} on ${w.chain}`);
      return;
    }
    const cdp = wCoin.valuechain.decimals;
    const half = unitsDown(wRoute.withdraw.min, cdp) / 2n;
    if (half <= 0n) {
      ctx.checks.skip('refuse-withdraw-below-minimum', `the minimum ${wRoute.withdraw.min} ${wCoin.coin} has no smaller amount`);
      return;
    }
    const amount = formatUnits(half, cdp);
    const r = await refusedLocally(ctx, () => withdrawFunds({ owner, provider: ctx.provider, coin: wCoin, route: wRoute, receiver: owner, amount, sources: { spot: true, perps: false, evm: false } }));
    if (!r.refused) throw new CheckFailure(`withdrawing ${amount} ${wCoin.coin} (minimum ${wRoute.withdraw.min}): ${r.why}`);
    if (!/minimum/i.test(r.reason)) throw new CheckFailure(`refused, but not for the minimum: "${r.reason}"`);
    ctx.checks.pass('refuse-withdraw-below-minimum', `a withdrawal of ${amount} ${wCoin.coin} to ${wRoute.label} (minimum ${wRoute.withdraw.min}) was refused by the app ("${r.reason}"); nothing was sent`, { refusal: r.reason });
  });

  await scenario(ctx, 'refuse-malformed-receiver', async () => {
    // One open route per address format the app offers; each malformed receiver goes through withdrawFunds itself.
    const byKind = new Map<AddressKind, { coin: CoinConfig; route: ChainRoute }>();
    for (const c of ctx.pre.coins) {
      for (const r of c.chains) {
        if (r.addressKind === 'other' || !r.withdraw.allowed || !r.withdraw.min || byKind.has(r.addressKind)) continue;
        byKind.set(r.addressKind, { coin: c, route: r });
      }
    }
    const evidence: Record<string, string[]> = {};
    let n = 0;
    for (const [kind, { coin, route }] of byKind) {
      const fmt = receiverFormatProblems(route);
      if (fmt.length) throw new CheckFailure(`${route.label} (${kind}): ${fmt.join('; ')}`);
      const seen: string[] = [];
      for (const bad of malformedReceivers(kind)) {
        const r = await refusedLocally(ctx, () => withdrawFunds({ owner, provider: ctx.provider, coin, route, receiver: bad.address, amount: route.withdraw.min!, sources: { spot: true, perps: false, evm: false }, ...(route.memo === 'numeric' ? { memo: '' } : {}) }));
        if (!r.refused) throw new CheckFailure(`${coin.coin} -> ${route.label}, receiver ${bad.what} ("${bad.address}"): ${r.why}`);
        if (!/address|checksum|destination|network/i.test(r.reason)) throw new CheckFailure(`${coin.coin} -> ${route.label}, receiver ${bad.what}: refused, but not for the address: "${r.reason}"`);
        seen.push(`${bad.what}: "${r.reason}"`);
        n += 1;
      }
      evidence[`${kind} (${coin.coin} -> ${route.label})`] = seen;
    }
    if (!n) {
      ctx.checks.skip('refuse-malformed-receiver', 'no open withdrawal route to try a receiver on');
      return;
    }
    ctx.checks.pass('refuse-malformed-receiver', `${n} malformed receivers over ${byKind.size} address format(s) (${[...byKind.keys()].join(', ')}) were each refused by the app before anything moved; a well-formed sample of each format is accepted by its check`, evidence);
  });

  // --- SoDEX must refuse: a builder the wallet never approved, and a fee above the approval ------------------------------------------
  await builderRefusals(ctx, perps);
  rec.note('refusals done: nothing was moved');
}

/**
 * An order SoDEX must not execute: rejected, or accepted and gone with no fill.
 * A fill (or a position) fails the check; whatever resulted is closed by `recover`.
 */
async function mustMoveNothing(ctx: Ctx, m: Market, id: string, spec: OrderSpec): Promise<void> {
  const before = m.engine === 'perps' ? canon((await positionOf(ctx, m.sym.name))?.size ?? '0') : null;
  const r = await place(ctx, spec);
  if (!r.ok) {
    if (!r.sent) {
      ctx.checks.pass(id, `${spec.label}: the app refused it before sending ("${r.reason}")`, { refusedBy: 'app', reason: r.reason });
      return;
    }
    ctx.checks.pass(id, `${spec.label}: SoDEX rejected it ("${r.reason}"); nothing moved`, { refusedBy: 'SoDEX', reason: r.reason });
    return;
  }
  const s = await awaitFills(ctx, m.engine, r.id);
  const resting = await restsAfter(ctx, m, r.id);
  const after = m.engine === 'perps' ? canon((await positionOf(ctx, m.sym.name))?.size ?? '0') : null;
  if (s.fills.length || (before !== null && after !== before)) throw new CheckFailure(`${spec.label}: SoDEX EXECUTED it (${idText(r.id)})${before !== null ? `: position ${before} -> ${after}` : ''}`, { orderID: r.id.orderID, fills: s.fills });
  if (resting) {
    await cancel(ctx, m, r.id, `${spec.label}: cancel`, id);
    throw new CheckFailure(`${spec.label}: SoDEX accepted it and it rests on the book (${idText(r.id)}); cancelled`, { orderID: r.id.orderID });
  }
  ctx.checks.pass(id, `${spec.label}: SoDEX accepted the request and dropped the order with no fill${s.status ? ` (${s.status})` : ''}; nothing moved`, { refusedBy: 'SoDEX', orderID: r.id.orderID, status: s.status });
}

/**
 * Two orders the app itself can never send (it names only the build's builder,
 * and only where SoDEX lists an approval that covers the fee). The runner builds
 * and signs them itself - labelled DIRECT - to see SoDEX refuse them: a resting
 * buy far below the market, so that even an acceptance moves nothing.
 */
async function builderRefusals(ctx: Ctx, market: Market): Promise<void> {
  const accountId = getTradingState().accountId;
  const b = ctx.cfg.builder;
  const tryOrder = async (id: string, builder: { id: number; fee: number }, what: string): Promise<void> => {
    await scenario(
      ctx,
      id,
      async () => {
        if (!accountId) throw new SafetyStop('trading is not enabled');
        const m = await readMarket('perps', market.sym.name);
        rememberMarket(m);
        const rb = restingBuy(m, ctx.cfg.orders.perpsLimitOffsetPct);
        const action = perpsActions.newOrder(accountId, m.sym.id, [{ clOrdID: genClOrdID('vs'), side: OrderSide.BUY, type: OrderType.LIMIT, timeInForce: TimeInForce.GTC, price: rb.price, quantity: rb.qty, reduceOnly: false }], builder);
        const r = await sendDirect(ctx, 'perps', action, { tag: id, label: `resting buy ${rb.qty} @ ${rb.price} naming ${what}`, purpose: 'a client naming a builder the wallet has not approved for that fee' });
        if (!r.accepted) {
          ctx.checks.pass(id, `an order naming ${what} was rejected by SoDEX ("${r.rejection}")`, { rejection: r.rejection, builder });
          return;
        }
        // It was accepted: take it off the book again, then fail.
        const open = (await openOn(ctx, m)).find((o) => isOurs(o, r.id));
        if (open) {
          await cancel(ctx, m, r.id, 'cancel the order SoDEX should have refused', id);
          await expectGone(ctx, m, r.id, 'the order');
        }
        throw new CheckFailure(`SoDEX ACCEPTED an order naming ${what} (${idText(r.id)})${open ? '; it rested and was cancelled' : ''}`, { orderID: r.id.orderID, builder });
      },
      () => putInOrder(ctx, market, id),
    );
  };

  // (a) a builder this wallet has never approved: the wallet's own account id is one for certain.
  if (!accountId) ctx.checks.set('refuse-unapproved-builder', 'not-run', 'trading is not enabled');
  else if (b && accountId === b.id) ctx.checks.skip('refuse-unapproved-builder', 'the test wallet IS the builder account - it has no unapproved builder id to hand');
  else {
    const listed = await readBuilderRates(ctx.owner, accountId).catch(() => ({ spot: null, perps: null }));
    if (listed.perps !== null) ctx.checks.skip('refuse-unapproved-builder', `this wallet has approved its own account #${accountId} as a builder - no unapproved builder id to hand`);
    else await tryOrder('refuse-unapproved-builder', { id: accountId, fee: 1 }, `builder #${accountId} (this wallet's own account, never approved) at fee 1`);
  }

  // (b) the approved builder, one tenth of a basis point above what the wallet approved.
  if (!b) ctx.checks.skip('refuse-builder-fee-above-approval', 'no builder in this run');
  else {
    const approved = (await readBuilderRates(ctx.owner, b.id).catch(() => ({ spot: null, perps: null }))).perps;
    if (approved === null) ctx.checks.skip('refuse-builder-fee-above-approval', `SoDEX lists no perps approval of builder #${b.id} for this wallet`);
    else if (approved >= 200) ctx.checks.skip('refuse-builder-fee-above-approval', `the wallet approved ${approved}, SoDEX's own perps cap: there is no fee above the approval that the engine would take at all`);
    else await tryOrder('refuse-builder-fee-above-approval', { id: b.id, fee: approved + 1 }, `builder #${b.id} at fee ${approved + 1} (the wallet approved ${approved})`);
  }
  void approx;
}
