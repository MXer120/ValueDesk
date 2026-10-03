/**
 * Order tickets -> signed-action payloads: the same orders the backend's
 * trading routes used to build.
 *   npx tsx --test src/trading/orderParams.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderModifier, OrderSide, OrderType, OrderValidationError, StopType, TimeInForce, TransferType, TriggerType } from '@sodex-core';
import {
  cancelManyActions,
  cancelOrderAction,
  crossTransferAction,
  genClOrdID,
  leverageAction,
  marginAction,
  signedMarginAmount,
  modifyOrderAction,
  placeOrderAction,
  triggerTypeFor,
  withdrawAction,
  type MarketSymbol, FOK_REFUSED } from './orderParams';

const BTC: MarketSymbol = {
  id: 7,
  name: 'BTC-USD',
  displayName: 'BTC-USD',
  tickSize: '0.5',
  stepSize: '0.001',
  minQuantity: '0.001',
  minNotional: '5',
  maxLeverage: 50,
};
let n = 0;
const id = (p = 'vs') => `${p}-t${n++}`;
const params = (a: { params: object }) => a.params as Record<string, any>;

test('a limit order: snapped to the tick and step grid, GTC, one leg', () => {
  const b = placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000.26', quantity: '0.01234' }, BTC, 42, undefined, id);
  const p = params(b.action);
  assert.equal(b.action.engine, 'perps');
  assert.equal(b.action.type, 'newOrder');
  assert.equal(p.accountID, 42);
  assert.equal(p.symbolID, 7);
  assert.equal(p.orders.length, 1);
  const o = p.orders[0];
  assert.equal(o.side, OrderSide.BUY);
  assert.equal(o.type, OrderType.LIMIT);
  assert.equal(o.timeInForce, TimeInForce.GTC);
  assert.equal(o.price, '84000.5', 'nearest tick');
  assert.equal(o.quantity, '0.012', 'step floor');
  assert.equal(o.reduceOnly, false);
  assert.equal(p.builder, undefined, 'no builder unless given');
});

test('market orders are IOC; post-only is GTX', () => {
  const m = params(placeOrderAction('perps', { symbol: 'BTC-USD', side: 'sell', type: 'market', quantity: '0.01' }, BTC, 1, undefined, id).action);
  assert.equal(m.orders[0].type, OrderType.MARKET);
  assert.equal(m.orders[0].timeInForce, TimeInForce.IOC);
  const po = params(placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', price: '1', quantity: '10', postOnly: true }, BTC, 1, undefined, id).action);
  assert.equal(po.orders[0].timeInForce, TimeInForce.GTX);
});

test('take-profit and stop-loss ride along as reduce-only market exits on the other side', () => {
  const b = placeOrderAction(
    'perps',
    { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01', takeProfit: { price: '90000.3' }, stopLoss: { price: '80000' } },
    BTC,
    1,
    undefined,
    id,
  );
  const [entry, tp, sl] = params(b.action).orders;
  assert.equal(b.orderCount, 3);
  // SoDEX: orders[0].modifier = BRACKET and not reduce-only; each exit ATTACHED_STOP and reduce-only.
  assert.equal(entry.modifier, OrderModifier.BRACKET);
  assert.equal(entry.reduceOnly, false);
  assert.equal(entry.stopPrice, undefined);
  for (const leg of [tp, sl]) {
    assert.equal(leg.modifier, OrderModifier.ATTACHED_STOP);
    assert.equal(leg.side, OrderSide.SELL);
    assert.equal(leg.type, OrderType.MARKET);
    assert.equal(leg.timeInForce, TimeInForce.IOC);
    assert.equal(leg.reduceOnly, true);
    assert.equal(leg.quantity, '0.01');
    assert.equal(leg.triggerType, TriggerType.MARK_PRICE);
  }
  assert.equal(tp.stopType, StopType.TAKE_PROFIT);
  assert.equal(tp.stopPrice, '90000.5', 'the trigger is snapped too');
  assert.equal(sl.stopType, StopType.STOP_LOSS);
});

test('every perps order says what it is: NORMAL, BRACKET + ATTACHED_STOP, or STOP (position or stand-alone)', () => {
  const one = (t: Partial<Parameters<typeof placeOrderAction>[1]>) =>
    params(placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', quantity: '0.01', ...t } as Parameters<typeof placeOrderAction>[1], BTC, 1, undefined, id).action).orders;
  // A plain order, and a plain reduce-only close.
  assert.equal(one({ price: '84000' })[0].modifier, OrderModifier.NORMAL);
  assert.deepEqual(one({ type: 'market', side: 'sell', reduceOnly: true }).map((o: any) => [o.modifier, o.reduceOnly]), [[OrderModifier.NORMAL, true]]);
  // A take-profit / stop-loss on a position: STOP, reduce-only, with its trigger (the positions table's TP/SL).
  const pos = one({ type: 'market', side: 'sell', reduceOnly: true, stopPrice: '90000', stopType: 'tp', triggerType: 'mark' });
  assert.equal(pos.length, 1);
  assert.deepEqual([pos[0].modifier, pos[0].reduceOnly, pos[0].stopPrice, pos[0].stopType, pos[0].triggerType], [OrderModifier.STOP, true, '90000', StopType.TAKE_PROFIT, TriggerType.MARK_PRICE]);
  // A stand-alone trigger order (the ticket's stop order, not reduce-only): STOP, not reduce-only.
  const st = one({ type: 'market', stopPrice: '86000', stopType: 'sl' });
  assert.deepEqual([st[0].modifier, st[0].reduceOnly, st[0].stopType, st[0].triggerType], [OrderModifier.STOP, false, StopType.STOP_LOSS, TriggerType.MARK_PRICE]);
  // A stop-limit is a STOP too.
  assert.equal(one({ price: '86500', stopPrice: '86000', stopType: 'sl' })[0].modifier, OrderModifier.STOP);
  // One exit only: a batch of 2, still BRACKET + ATTACHED_STOP.
  const half = one({ price: '84000', stopLoss: { price: '80000' } });
  assert.deepEqual(half.map((o: any) => [o.modifier, o.reduceOnly]), [[OrderModifier.BRACKET, false], [OrderModifier.ATTACHED_STOP, true]]);
  // Spot has no modifier field at all.
  const spot = params(placeOrderAction('spot', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01' }, BTC, 1, undefined, id).action).orders[0];
  assert.equal('modifier' in spot, false);
});

test('only the MARK price triggers orders: last and index are refused before signing, with a plain message', () => {
  assert.equal(triggerTypeFor(undefined), TriggerType.MARK_PRICE);
  assert.equal(triggerTypeFor('mark'), TriggerType.MARK_PRICE);
  for (const t of ['last', 'index'] as const) {
    assert.throws(() => triggerTypeFor(t), (e: unknown) => e instanceof OrderValidationError && /mark price only/.test(e.message) && /Choose Mark/.test(e.message));
    assert.throws(() => placeOrderAction('perps', { symbol: 'BTC-USD', side: 'sell', type: 'market', quantity: '0.01', reduceOnly: true, stopPrice: '80000', stopType: 'sl', triggerType: t }, BTC, 1, undefined, id), OrderValidationError);
    assert.throws(() => placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01', takeProfit: { price: '90000', triggerType: t } }, BTC, 1, undefined, id), (e: unknown) => e instanceof OrderValidationError && /take-profit/.test(e.message));
  }
});

test('an entry with exits is never a trigger order and never reduce-only (SoDEX: orders[0].reduceOnly = false)', () => {
  assert.throws(
    () => placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', type: 'market', quantity: '0.01', stopPrice: '86000', stopType: 'sl', takeProfit: { price: '90000' } }, BTC, 1, undefined, id),
    (e: unknown) => e instanceof OrderValidationError && /trigger order cannot carry its own take-profit or stop-loss/.test(e.message),
  );
  assert.throws(
    () => placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01', reduceOnly: true, stopLoss: { price: '80000' } }, BTC, 1, undefined, id),
    (e: unknown) => e instanceof OrderValidationError && /cannot be reduce-only/.test(e.message),
  );
});

test('the three TP/SL shapes are byte-identical to the official Go SDK\'s, builder included', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const core = await import('@sodex-core');
  const V = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../packages/sodex-core/test/vectors-sdk.json', import.meta.url)), 'utf8'));
  const pk = core.hexToBytes(V.privateKey);
  const sym = { id: 1, name: 'BTC-USD', displayName: 'BTC-USD', tickSize: '0.5', stepSize: '0.001', minQuantity: '0.001', minNotional: '5', maxLeverage: 50 };
  const builder = { id: 456, fee: 20 };
  const ids = (...list: string[]) => {
    const q = [...list];
    return () => q.shift()!;
  };
  const cases = [
    ['perps_bracket_tp_sl', placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', price: '70000.5', quantity: '0.01', tif: 'gtc', takeProfit: { price: '75000' }, stopLoss: { price: '68000' } }, sym, 43933, builder, ids('vs-entry-1', 'tp-entry-1', 'sl-entry-1'))],
    ['perps_position_tp', placeOrderAction('perps', { symbol: 'BTC-USD', side: 'sell', type: 'market', quantity: '0.01', reduceOnly: true, stopPrice: '75000', stopType: 'tp', triggerType: 'mark' }, sym, 43933, builder, ids('vs-pos-tp-1'))],
    ['perps_standalone_stop', placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', type: 'market', quantity: '0.01', stopPrice: '72000', stopType: 'sl' }, sym, 43933, builder, ids('vs-stop-1'))],
  ] as const;
  for (const [name, built] of cases) {
    const v = V.vectors.find((x: { name: string }) => x.name === name);
    assert.ok(v, `${name} is in vectors-sdk.json`);
    assert.equal(core.goJSONStringify(built.action.params), v.bodyJSON, `${name}: body bytes`);
    assert.equal(core.signExchangeAction(core.engineDomainName('perps'), V.chainID, 'newOrder', built.action.params, BigInt(v.nonce), pk), v.signature, `${name}: signature`);
  }
});

test('refusals happen before signing, with the backend\'s messages', () => {
  const bad = (t: Parameters<typeof placeOrderAction>[1], engine: 'perps' | 'spot' = 'perps') =>
    assert.throws(() => placeOrderAction(engine, t, BTC, 1, undefined, id), OrderValidationError);
  bad({ symbol: 'BTC-USD', side: 'buy', quantity: '0.01' }); // limit without price
  bad({ symbol: 'BTC-USD', side: 'buy', price: '84000' }); // no size
  bad({ symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.0001' }); // rounds to zero
  bad({ symbol: 'BTC-USD', side: 'buy', price: '1', quantity: '0.001' }); // under min notional
  bad({ symbol: 'BTC-USD', side: 'buy', type: 'market', funds: '100', takeProfit: { price: '9' } }); // exits need a quantity
  bad({ symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01', stopPrice: '83000' }, 'spot'); // spot has no triggers
  bad({ symbol: 'BTC-USD', side: 'hold' as 'buy', price: '84000', quantity: '0.01' });
});

test('the builder fee rides at batch level, on both engines', () => {
  const perps = params(placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01' }, BTC, 1, { id: 9, fee: 10 }, id).action);
  assert.deepEqual(perps.builder, { id: 9, fee: 10 });
  assert.deepEqual(Object.keys(perps).slice(-1), ['builder'], 'last key, after orders (Go field order)');
  const spot = params(placeOrderAction('spot', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01' }, BTC, 1, { id: 9, fee: 50 }, id).action);
  assert.equal(spot.orders[0].symbolID, 7);
  assert.deepEqual(spot.builder, { id: 9, fee: 50 });
  assert.throws(() => placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01' }, BTC, 1, { id: 9, fee: 201 }, id));
});

test('cancels, cancel-all in batches of 100, modify, leverage, margin', () => {
  const c = params(cancelOrderAction('perps', BTC, 1, { orderID: 5 }, id));
  assert.deepEqual(JSON.parse(JSON.stringify(c.cancels)), [{ symbolID: 7, orderID: 5 }], 'undefined keys are dropped on the wire');
  const cs = params(cancelOrderAction('spot', BTC, 1, { clOrdID: 'abc' }, id));
  assert.equal(cs.cancels[0].origClOrdID, 'abc');
  assert.throws(() => cancelOrderAction('perps', BTC, 1, {}, id), OrderValidationError);
  const many = cancelManyActions('perps', 1, Array.from({ length: 205 }, (_, i) => ({ si: 7, i: i + 1 })), id);
  assert.deepEqual(many.map((a) => params(a).cancels.length), [100, 100, 5]);
  assert.equal(cancelManyActions('perps', 1, [{ symbolID: 7 }], id).length, 0, 'an order with no id is skipped');
  const m = params(modifyOrderAction(BTC, 1, { orderID: 3, price: '84000.2' }));
  assert.equal(m.price, '84000');
  assert.equal(params(leverageAction(BTC, 1, 20, 'isolated')).leverage, 20);
  assert.throws(() => leverageAction(BTC, 1, 51, 'cross'), /at most 50x/);
  assert.throws(() => leverageAction(BTC, 1, 1.5, 'cross'));
  assert.equal(params(marginAction(BTC, 1, '-12.5')).amount, '-12.5');
  assert.throws(() => marginAction(BTC, 1, '0'));
});

test('isolated margin add and remove sign the updateMargin fields only', () => {
  const add = marginAction(BTC, 42, '10.50');
  assert.equal(add.engine, 'perps');
  assert.equal(add.type, 'updateMargin');
  const ap = params(add);
  assert.deepEqual(Object.keys(ap), ['accountID', 'symbolID', 'amount']);
  assert.equal(ap.accountID, 42);
  assert.equal(ap.symbolID, 7);
  assert.equal(ap.amount, '10.5', 'trailing zeros are stripped before signing');
  const rem = params(marginAction(BTC, 42, '-10.50'));
  assert.equal(rem.amount, '-10.5');
  assert.equal(rem.symbolID, 7);
  assert.throws(() => marginAction(BTC, 42, '0'));
  assert.throws(() => marginAction(BTC, 42, ''));
  assert.throws(() => marginAction(BTC, 42, '1e2'));
  assert.throws(() => marginAction(BTC, 42, '1.1234567'), /6 decimal places/);
  assert.equal(params(marginAction(BTC, 42, '1.500000')).amount, '1.5', 'trailing zeros do not count as extra places');
  assert.equal(signedMarginAmount('+10.50', true), '10.50');
  assert.equal(signedMarginAmount('+10.50', false), '-10.50', 'a typed plus must not become -+ on remove');
  assert.equal(signedMarginAmount('-10', true), '10', 'a typed minus is a magnitude, and Add stays positive');
  assert.equal(signedMarginAmount('10', false), '-10');
  assert.throws(() => signedMarginAmount('0', true));
  assert.throws(() => signedMarginAmount('', false));
  assert.throws(() => signedMarginAmount('1e2', true));
});

test('a take-profit edit signs only the trigger, snapped to the tick', () => {
  const tp = modifyOrderAction(BTC, 42, { orderID: 9, stopPrice: '90000.2' });
  assert.equal(tp.engine, 'perps');
  assert.equal(tp.type, 'modifyOrder');
  const p = params(tp);
  assert.equal(p.orderID, 9);
  assert.equal(p.symbolID, 7);
  assert.equal(p.stopPrice, '90000', 'tick 0.5: 90000.2 is nearer 90000 than 90000.5');
  assert.equal(p.price, undefined, 'a trigger edit must not invent a limit price');
  assert.equal(p.quantity, undefined);
  const sl = params(modifyOrderAction(BTC, 42, { orderID: 4, stopPrice: '80000.4' }));
  assert.equal(sl.stopPrice, '80000.5');
  assert.throws(() => modifyOrderAction(BTC, 42, { stopPrice: '1' }));
});

test('money: own-account transfers and withdrawals to the owner only', () => {
  const t = crossTransferAction('spot-to-perps', 42, 1, '100');
  assert.equal(t.engine, 'spot');
  const tp = params(t.action);
  assert.equal(tp.toAccountID, 999, 'the cross-engine account');
  assert.equal(tp.type, TransferType.PERPS_WITHDRAW);
  assert.equal(params(crossTransferAction('perps-to-spot', 42, 1, '1').action).type, TransferType.SPOT_WITHDRAW);
  // The official SDK's transfer_spot_to_evm: spot engine, EVM_WITHDRAW, to the
  // treasury account 999 (SoDEX pays the owner's own address).
  const wa = withdrawAction(42, 1, '5.5');
  assert.equal(wa.engine, 'spot', 'only spot pays out to the wallet');
  const w = params(wa);
  assert.equal(w.type, TransferType.EVM_WITHDRAW);
  assert.equal(w.toAccountID, 999, 'the treasury account, as the official SDK sends it');
  assert.equal(w.fromAccountID, 42);
  assert.throws(() => withdrawAction(42, 1, '-1'));
  assert.ok(params(withdrawAction(42, 1, '1')).id > w.id, 'transfer ids increase');
});

test('client order ids fit the gateway grammar', () => {
  for (let i = 0; i < 50; i++) assert.match(genClOrdID('tp'), /^[0-9a-zA-Z_-]{1,36}$/);
});

test("withdrawal bytes are exactly the official Go SDK's (spot -> own wallet)", async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const core = await import('@sodex-core');
  const V = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../packages/sodex-core/test/vectors-sdk.json', import.meta.url)), 'utf8'));
  const v = V.vectors.find((x: { name: string }) => x.name === 'spot_evm_withdraw');
  assert.ok(v, 'the Go SDK vector exists');
  const a = withdrawAction(43933, 0, '12.5');
  const p = { ...(a.params as Record<string, unknown>), id: v.params.id };
  assert.equal(core.goJSONStringify({ type: a.type, params: p }), v.payloadJSON, 'same payload bytes');
  const sig = core.signExchangeAction(core.engineDomainName(a.engine), V.chainID, a.type, p, BigInt(v.nonce), core.hexToBytes(V.privateKey));
  assert.equal(sig, v.signature, 'same signature');
});

test("an order from the ticket is byte-identical to the official Go SDK's (perps limit, spot limit)", async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const core = await import('@sodex-core');
  const V = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../packages/sodex-core/test/vectors.json', import.meta.url)), 'utf8'));
  const pk = core.hexToBytes(V.privateKey);
  const sym = (id: number, name: string) => ({ id, name, displayName: name, tickSize: '0.5', stepSize: '0.001', minQuantity: '0.001', minNotional: '5', maxLeverage: 50 });

  const pv = V.vectors.find((x: { name: string }) => x.name === 'perps_limit_order');
  const perps = placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', price: '70000.5', quantity: '0.01', tif: 'gtc' }, sym(1, 'BTC-USD'), 43933, undefined, () => 'opentrade-limit-1');
  assert.equal(core.goJSONStringify(perps.action.params), pv.bodyJSON, 'perps body bytes');
  assert.equal(core.signExchangeAction(core.engineDomainName('perps'), V.chainID, 'newOrder', perps.action.params, BigInt(pv.nonce), pk), pv.signature, 'perps signature');

  const sv = V.vectors.find((x: { name: string }) => x.name === 'spot_batch_new_order');
  const spot = placeOrderAction('spot', { symbol: 'BTC_USDC', side: 'buy', price: '95000', quantity: '0.406', tif: 'gtc' }, { ...sym(1, 'BTC_USDC'), tickSize: '1' }, 43933, undefined, () => 'opentrade-spot-1');
  assert.equal(core.goJSONStringify(spot.action.params), sv.bodyJSON, 'spot body bytes');
  assert.equal(core.signExchangeAction(core.engineDomainName('spot'), V.chainID, sv.actionType, spot.action.params, BigInt(sv.nonce), pk), sv.signature, 'spot signature');
});

test('fill-or-kill is refused before signing - SoDEX answers it with "timeInForce is invalid" on spot and perps', () => {
  for (const engine of ['perps', 'spot'] as const) {
    assert.throws(
      () => placeOrderAction(engine, { symbol: 'BTC-USD', side: 'buy', type: 'limit', price: '84000', quantity: '0.01', tif: 'fok' }, BTC, 1, undefined, id),
      (e: unknown) => e instanceof OrderValidationError && e.message === FOK_REFUSED && /IOC/.test(e.message),
    );
  }
  // IOC, GTC and post-only still go out.
  for (const tif of ['ioc', 'gtc', 'gtx'] as const) assert.doesNotThrow(() => placeOrderAction('perps', { symbol: 'BTC-USD', side: 'buy', type: 'limit', price: '84000', quantity: '0.01', tif }, BTC, 1, undefined, id));
});
