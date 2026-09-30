/**
 * Order tickets -> signed-action payloads, pure.
 *
 * A port of the backend's former trading routes (server/src/routes/trade.ts)
 * onto @sodex-core, so the browser builds exactly the orders the backend used
 * to: validated against the symbol's tick/step/notional rules BEFORE signing (a
 * local rejection is instant and free; a gateway rejection costs a round trip
 * and a nonce), market orders IOC by default, spot refusing what this venue
 * cannot carry, perps take-profit / stop-loss exits as reduce-only legs of the
 * same signed request.
 *
 * The builder fee rides at batch level - the placement the official Go SDK
 * carries - and only when the key's own registration approved it: an order
 * naming a builder its account never approved is rejected by the engine.
 */
import {
  CROSS_ENGINE_ACCOUNT_ID,
  MAX_ORDERS_PER_BATCH,
  MarginMode,
  OrderSide,
  OrderType,
  OrderValidationError,
  StopType,
  TimeInForce,
  TransferType,
  TriggerType,
  normaliseOrder,
  perpsActions,
  spotActions,
  type BuilderParams,
  type Engine,
  type RawOrderInput,
  type SignableAction,
  type SymbolRules,
} from '@sodex-core';

/** What the order ticket sends (api.ts PlaceOrderInput). */
export interface OrderTicket {
  symbol: string;
  side: 'buy' | 'sell';
  type?: 'limit' | 'market';
  price?: string;
  quantity?: string;
  funds?: string;
  tif?: 'gtc' | 'fok' | 'ioc' | 'gtx';
  postOnly?: boolean;
  reduceOnly?: boolean;
  clOrdID?: string;
  stopPrice?: string;
  stopType?: 'sl' | 'tp';
  triggerType?: 'last' | 'mark' | 'index';
  takeProfit?: { price: string; triggerType?: 'last' | 'mark' | 'index' };
  stopLoss?: { price: string; triggerType?: 'last' | 'mark' | 'index' };
}

export type MarketSymbol = SymbolRules & { id: number; name: string; displayName: string; maxLeverage?: number };

/** Short, unique, inside the gateway's `^[0-9a-zA-Z_-]{1,36}$`. */
export function genClOrdID(prefix = 'vs', now = Date.now()): string {
  const r = crypto.getRandomValues(new Uint8Array(4));
  const tail = Array.from(r, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
  return `${prefix}-${now.toString(36)}-${tail}`;
}

const SIDE = { buy: OrderSide.BUY, sell: OrderSide.SELL } as const;
const TIF = { gtc: TimeInForce.GTC, fok: TimeInForce.FOK, ioc: TimeInForce.IOC, gtx: TimeInForce.GTX } as const;
const TRIGGER = { last: TriggerType.LAST_PRICE, mark: TriggerType.MARK_PRICE, index: TriggerType.INDEX_PRICE } as const;

/** A tick-snapped price, or a validation error naming the field. */
function snapPrice(sym: MarketSymbol, price: string, field: string): string {
  try {
    const p = normaliseOrder(sym, { price, type: OrderType.LIMIT }).price;
    if (!p) throw new OrderValidationError('price is required');
    return p;
  } catch (e) {
    if (e instanceof OrderValidationError) throw new OrderValidationError(`${field}: ${e.message}`);
    throw e;
  }
}

export interface BuiltOrder {
  action: SignableAction;
  symbol: string;
  orderCount: number;
}

/**
 * The signed action for one ticket. `builder` is the fee to attach for this
 * engine (already checked against the key's approval), or undefined.
 */
export function placeOrderAction(
  engine: Engine,
  t: OrderTicket,
  sym: MarketSymbol,
  accountId: number,
  builder?: BuilderParams,
  id: (prefix?: string) => string = genClOrdID,
): BuiltOrder {
  const side = SIDE[String(t.side ?? '').toLowerCase() as 'buy' | 'sell'];
  if (!side) throw new OrderValidationError("side must be 'buy' or 'sell'");
  const type = t.type === 'market' ? OrderType.MARKET : OrderType.LIMIT;
  // A market order must not rest on the book: IOC unless told otherwise.
  const tifKey = t.postOnly ? 'gtx' : (String(t.tif ?? (type === OrderType.MARKET ? 'ioc' : 'gtc')).toLowerCase() as 'gtc');
  const timeInForce = TIF[tifKey];
  if (!timeInForce) throw new OrderValidationError(`unknown time in force ${tifKey}`);
  if (type === OrderType.LIMIT && !t.price) throw new OrderValidationError('limit orders require a price');

  const norm = normaliseOrder(sym, { price: t.price, quantity: t.quantity, funds: t.funds, type });
  if (!norm.quantity && !norm.funds) throw new OrderValidationError('quantity or funds is required');

  if (engine === 'spot') {
    // SPOT HAS NO TRIGGER ORDERS on this venue and no attached exits: refuse
    // rather than quietly place a different order.
    if (t.stopPrice || t.takeProfit || t.stopLoss) {
      throw new OrderValidationError(
        'spot orders cannot carry a trigger or attached exits on this venue; place a plain limit or market order instead',
      );
    }
    const action = spotActions.batchNewOrder(
      accountId,
      [{ symbolID: sym.id, clOrdID: t.clOrdID ?? id(), side, type, timeInForce, price: norm.price, quantity: norm.quantity, funds: norm.funds }],
      builder,
    );
    return { action, symbol: sym.name, orderCount: 1 };
  }

  const stopPrice = t.stopPrice ? snapPrice(sym, t.stopPrice, 'trigger price') : undefined;
  const orders: RawOrderInput[] = [
    {
      clOrdID: t.clOrdID ?? id(),
      side,
      type,
      timeInForce,
      price: norm.price,
      quantity: norm.quantity,
      funds: norm.funds,
      reduceOnly: t.reduceOnly ?? false,
      ...(stopPrice
        ? {
            stopPrice,
            stopType: t.stopType === 'tp' ? StopType.TAKE_PROFIT : StopType.STOP_LOSS,
            triggerType: TRIGGER[t.triggerType ?? 'mark'],
          }
        : {}),
    },
  ];

  // Exits are sized from the entry's quantity and share its signed request:
  // a funds-sized entry would sign an exit with no size and poison the batch.
  if ((t.takeProfit || t.stopLoss) && !norm.quantity) {
    throw new OrderValidationError(
      'take-profit / stop-loss need an explicit quantity, because the exit legs are sized from it. Specify quantity instead of funds, or place the exits after the entry fills.',
    );
  }
  const exitSide = side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
  for (const [leg, stopType, label] of [
    [t.takeProfit, StopType.TAKE_PROFIT, 'take-profit'],
    [t.stopLoss, StopType.STOP_LOSS, 'stop-loss'],
  ] as const) {
    if (!leg) continue;
    orders.push({
      clOrdID: id(stopType === StopType.TAKE_PROFIT ? 'tp' : 'sl'),
      side: exitSide,
      type: OrderType.MARKET,
      timeInForce: TimeInForce.IOC,
      quantity: norm.quantity,
      stopPrice: snapPrice(sym, leg.price, `${label} price`),
      stopType,
      triggerType: TRIGGER[leg.triggerType ?? 'mark'],
      // Exits only ever close; they never flip the position.
      reduceOnly: true,
    });
  }
  return { action: perpsActions.newOrder(accountId, sym.id, orders, builder), symbol: sym.name, orderCount: orders.length };
}

/** Cancel one order by orderID or clOrdID. */
export function cancelOrderAction(
  engine: Engine,
  sym: MarketSymbol,
  accountId: number,
  ref: { orderID?: number; clOrdID?: string },
  id: (prefix?: string) => string = genClOrdID,
): SignableAction {
  if (ref.orderID === undefined && !ref.clOrdID) throw new OrderValidationError('orderID or clOrdID is required');
  if (engine === 'spot') {
    return spotActions.batchCancelOrder(accountId, [
      { symbolID: sym.id, clOrdID: id('cx'), orderID: ref.orderID, origClOrdID: ref.clOrdID },
    ]);
  }
  return perpsActions.cancelOrder(accountId, [{ symbolID: sym.id, orderID: ref.orderID, clOrdID: ref.clOrdID }]);
}

/** One open order as the gateway lists it (full or compact field names). */
export interface OpenOrderRef {
  symbolID?: number;
  si?: number;
  orderID?: number;
  i?: number;
}

/** Cancel every listed order: one signed request per 100. */
export function cancelManyActions(
  engine: Engine,
  accountId: number,
  open: readonly OpenOrderRef[],
  id: (prefix?: string) => string = genClOrdID,
): SignableAction[] {
  const refs = open
    .map((o) => ({ symbolID: o.symbolID ?? o.si, orderID: o.orderID ?? o.i }))
    .filter((r): r is { symbolID: number; orderID: number } => typeof r.symbolID === 'number' && typeof r.orderID === 'number');
  const out: SignableAction[] = [];
  for (let i = 0; i < refs.length; i += MAX_ORDERS_PER_BATCH) {
    const chunk = refs.slice(i, i + MAX_ORDERS_PER_BATCH);
    out.push(
      engine === 'spot'
        ? spotActions.batchCancelOrder(accountId, chunk.map((r) => ({ symbolID: r.symbolID, clOrdID: id('cx'), orderID: r.orderID })))
        : perpsActions.cancelOrder(accountId, chunk),
    );
  }
  return out;
}

/** Modify a resting perps order in place (price / quantity / trigger). */
export function modifyOrderAction(
  sym: MarketSymbol,
  accountId: number,
  m: { orderID?: number; clOrdID?: string; price?: string; quantity?: string; stopPrice?: string },
): SignableAction {
  if (m.orderID === undefined && !m.clOrdID) throw new OrderValidationError('orderID or clOrdID is required');
  const norm = normaliseOrder(sym, { price: m.price, quantity: m.quantity, type: OrderType.LIMIT });
  const stopPrice = m.stopPrice ? snapPrice(sym, m.stopPrice, 'trigger price') : undefined;
  return perpsActions.modifyOrder({
    accountID: accountId,
    symbolID: sym.id,
    orderID: m.orderID,
    clOrdID: m.clOrdID,
    price: norm.price,
    quantity: norm.quantity,
    stopPrice,
  });
}

/** Atomic cancel-and-replace. */
export function replaceOrderAction(
  engine: Engine,
  sym: MarketSymbol,
  accountId: number,
  r: { origOrderID?: number; origClOrdID?: string; price?: string; quantity?: string },
  id: (prefix?: string) => string = genClOrdID,
): SignableAction {
  if (r.origOrderID === undefined && !r.origClOrdID) throw new OrderValidationError('origOrderID or origClOrdID is required');
  const norm = normaliseOrder(sym, { price: r.price, quantity: r.quantity, type: OrderType.LIMIT });
  const orders = [
    { symbolID: sym.id, clOrdID: id('rp'), origOrderID: r.origOrderID, origClOrdID: r.origClOrdID, price: norm.price, quantity: norm.quantity },
  ];
  return engine === 'spot' ? spotActions.replaceOrder(accountId, orders) : perpsActions.replaceOrder(accountId, orders);
}

export function leverageAction(sym: MarketSymbol, accountId: number, leverage: number, marginMode: 'isolated' | 'cross'): SignableAction {
  if (!Number.isInteger(leverage) || leverage < 1) throw new OrderValidationError('leverage must be a positive integer');
  if (sym.maxLeverage && leverage > sym.maxLeverage) {
    throw new OrderValidationError(`${sym.displayName} allows at most ${sym.maxLeverage}x`);
  }
  return perpsActions.updateLeverage(accountId, sym.id, leverage, marginMode === 'isolated' ? MarginMode.ISOLATED : MarginMode.CROSS);
}

/**
 * The amount the user typed, signed the way UpdateMarginRequest requires.
 *
 * SoDEX's schema: a positive amount adds isolated margin, a negative amount
 * removes it, and zero is rejected. The field is a magnitude; Add and Remove
 * apply the sign, so a typed "+" or "-" does not become a second sign.
 */
export function signedMarginAmount(raw: string, add: boolean): string {
  const mag = String(raw ?? '').trim().replace(/^[+-]/, '');
  if (!/^\d+(\.\d+)?$/.test(mag) || Number(mag) === 0) {
    throw new OrderValidationError('Enter a positive amount.');
  }
  return add ? mag : `-${mag}`;
}

/**
 * Add (positive) or remove (negative) isolated margin.
 *
 * `precision` is vUSDC's coin precision (6 on mainnet). The gateway rejects an
 * amount with more decimal places than that. Trailing zeros are stripped
 * before the check, so "1.500000" is one place and is allowed.
 */
export function marginAction(sym: MarketSymbol, accountId: number, amount: string, precision = 6): SignableAction {
  if (!amount || !/^-?\d+(\.\d+)?$/.test(amount.trim()) || Number(amount) === 0) {
    throw new OrderValidationError('amount must be a non-zero number');
  }
  const action = perpsActions.updateMargin(accountId, sym.id, amount.trim());
  const canonical = (action.params as { amount: string }).amount;
  const places = canonical.split('.')[1]?.length ?? 0;
  if (places > precision) {
    throw new OrderValidationError(`USDC margin uses at most ${precision} decimal places`);
  }
  return action;
}

/** Dead-man's switch: cancel everything at `scheduledTimestamp` (omit to clear). */
export function scheduleCancelAction(engine: Engine, accountId: number, scheduledTimestamp?: number): SignableAction {
  return engine === 'spot'
    ? spotActions.scheduleCancel(accountId, scheduledTimestamp)
    : perpsActions.scheduleCancel(accountId, scheduledTimestamp);
}

/** A unique transfer id: ms clock, strictly increasing within this page. */
let lastTransferId = 0;
export function nextTransferId(now = Date.now()): number {
  lastTransferId = Math.max(now, lastTransferId + 1);
  return lastTransferId;
}

const positiveAmount = (amount: string): string => {
  const a = String(amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(a) || Number(a) <= 0) throw new OrderValidationError('amount must be a positive number');
  return a;
};

/** Spot <-> perps, within the same owner (the gateway's cross-engine account 999). */
export function crossTransferAction(
  direction: 'spot-to-perps' | 'perps-to-spot',
  accountId: number,
  coinId: number,
  amount: string,
): { engine: Engine; action: SignableAction } {
  const toPerps = direction === 'spot-to-perps';
  const engine: Engine = toPerps ? 'spot' : 'perps';
  const params = {
    id: nextTransferId(),
    fromAccountID: accountId,
    toAccountID: CROSS_ENGINE_ACCOUNT_ID,
    coinID: coinId,
    amount: positiveAmount(amount),
    type: toPerps ? TransferType.PERPS_WITHDRAW : TransferType.SPOT_WITHDRAW,
  };
  return { engine, action: engine === 'spot' ? spotActions.transferAsset(params) : perpsActions.transferAsset(params) };
}

/**
 * Withdraw from SPOT to the owner's own EVM address on ValueChain (the
 * destination is fixed on-chain). Exactly the official SDK's
 * `transfer_spot_to_evm`: the spot engine, EVM_WITHDRAW, toAccountID 999 (the
 * treasury account every engine transfer goes through). There is no perps ->
 * wallet route: perps funds go perps -> spot first (actions.withdraw does that).
 */
export function withdrawAction(accountId: number, coinId: number, amount: string): SignableAction {
  const params = {
    id: nextTransferId(),
    fromAccountID: accountId,
    toAccountID: CROSS_ENGINE_ACCOUNT_ID,
    coinID: coinId,
    amount: positiveAmount(amount),
    type: TransferType.EVM_WITHDRAW,
  };
  return spotActions.transferAsset(params);
}
