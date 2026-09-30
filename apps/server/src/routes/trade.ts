/**
 * Signed trading routes.
 *
 * Every handler here spends a signature and a nonce, so orders are validated
 * against the symbol's tick/step/notional rules FIRST - a local rejection is
 * instant and free, a gateway rejection costs a round trip.
 */
import type { FastifyInstance } from 'fastify';
import { sodex, unwrapList } from '../sodex/rest.js';
import { normaliseOrder, resolve, OrderValidationError } from '../sodex/symbols.js';
import { ALLOW_MAINNET_WRITES, NETWORK, type Engine } from '../config.js';
import * as A from '../signing/actions.js';

const asEngine = (v: unknown): Engine => (v === 'spot' ? 'spot' : 'perps');

/**
 * Mainnet writes are refused unless explicitly enabled, so a misconfigured
 * default can never place a real order with real money.
 */
function guardMainnet(): void {
  if (NETWORK === 'mainnet' && !ALLOW_MAINNET_WRITES) {
    throw Object.assign(
      new Error('Mainnet writes are disabled. Set VALUETRADE_ALLOW_MAINNET=1 to enable them.'),
      { statusCode: 403 },
    );
  }
}

/** Short, unique, and inside the gateway's `^[0-9a-zA-Z_-]{1,36}$`. */
const genClOrdID = (prefix = 'ot'): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const SIDE: Record<string, number> = { buy: A.OrderSide.BUY, sell: A.OrderSide.SELL };
const TIF: Record<string, number> = {
  gtc: A.TimeInForce.GTC, fok: A.TimeInForce.FOK,
  ioc: A.TimeInForce.IOC, gtx: A.TimeInForce.GTX,
};
const TRIGGER: Record<string, number> = {
  last: A.TriggerType.LAST_PRICE, mark: A.TriggerType.MARK_PRICE, index: A.TriggerType.INDEX_PRICE,
};

interface PlaceBody {
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
  /** Standalone trigger order (stop-loss / take-profit entry). */
  stopPrice?: string;
  stopType?: 'sl' | 'tp';
  triggerType?: 'last' | 'mark' | 'index';
  /** Attach reduce-only exits after the entry. */
  takeProfit?: { price: string; triggerType?: 'last' | 'mark' | 'index' };
  stopLoss?: { price: string; triggerType?: 'last' | 'mark' | 'index' };
}

export async function tradeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Place an order.
   *
   * `postOnly` maps to GTX. Note SoDEX GTX is NOT all-or-nothing: it may
   * partially fill and then reject the remainder, so the response is returned
   * verbatim for the UI to inspect rather than being reported as a clean accept.
   */
  app.post('/api/trade/:engine/order', async (req, reply) => {
    guardMainnet();
    const engine = asEngine((req.params as any).engine);
    const b = req.body as PlaceBody;
    const s = sodex.requireSession();

    if (!b?.symbol) return reply.code(400).send({ error: 'symbol is required' });
    const side = SIDE[String(b.side ?? '').toLowerCase()];
    if (!side) return reply.code(400).send({ error: "side must be 'buy' or 'sell'" });

    const sym = await resolve(engine, b.symbol);
    const type = b.type === 'market' ? A.OrderType.MARKET : A.OrderType.LIMIT;
    // A market order must not rest on the book; default it to IOC.
    const tifKey = b.postOnly ? 'gtx' : (b.tif ?? (type === A.OrderType.MARKET ? 'ioc' : 'gtc'));
    const timeInForce = TIF[tifKey];
    if (!timeInForce) return reply.code(400).send({ error: `unknown tif ${tifKey}` });
    if (type === A.OrderType.LIMIT && !b.price) {
      return reply.code(400).send({ error: 'limit orders require a price' });
    }

    let norm;
    try {
      norm = normaliseOrder(sym, { price: b.price, quantity: b.quantity, funds: b.funds, type });
    } catch (e) {
      if (e instanceof OrderValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    if (!norm.quantity && !norm.funds) {
      return reply.code(400).send({ error: 'quantity or funds is required' });
    }

    if (engine === 'spot') {
      /*
       * SPOT HAS NO TRIGGER ORDERS on this venue - `spotBatchNewOrder` carries
       * no stopPrice field - and it has no attached exits either. Silently
       * dropping them is what made a spot "stop loss" place an order that
       * executed immediately, so anything we cannot honour is refused here
       * rather than quietly becoming a different order.
       */
      if (b.stopPrice || b.takeProfit || b.stopLoss) {
        return reply.code(400).send({
          error: 'spot orders cannot carry a trigger or attached exits on this venue; place a plain limit or market order instead',
        });
      }
      const params = A.spotBatchNewOrder(s.accountId, [{
        symbolID: sym.id,
        clOrdID: b.clOrdID ?? genClOrdID(),
        side, type, timeInForce,
        price: norm.price, quantity: norm.quantity, funds: norm.funds,
      }]);
      return { engine, symbol: sym.name, result: await sodex.post(engine, '/trade/orders/batch', A.ACTION.batchNewOrder, params) };
    }

    // A trigger price is a price: it must be snapped to the symbol's tick grid
    // and canonicalised like any other, or the signed payload carries an
    // off-grid value with trailing zeros and is rejected.
    let stopPrice: string | undefined;
    if (b.stopPrice) {
      try {
        stopPrice = normaliseOrder(sym, { price: b.stopPrice, type: A.OrderType.LIMIT }).price;
      } catch (e) {
        if (e instanceof OrderValidationError) {
          return reply.code(400).send({ error: `trigger price: ${e.message}` });
        }
        throw e;
      }
    }

    // Perps: the entry, plus any attached reduce-only exits, in one signed request.
    const orders: A.RawOrderInput[] = [{
      clOrdID: b.clOrdID ?? genClOrdID(),
      side, type, timeInForce,
      price: norm.price, quantity: norm.quantity, funds: norm.funds,
      reduceOnly: b.reduceOnly ?? false,
      ...(stopPrice
        ? {
            stopPrice,
            stopType: b.stopType === 'tp' ? A.StopType.TAKE_PROFIT : A.StopType.STOP_LOSS,
            triggerType: TRIGGER[b.triggerType ?? 'mark'],
          }
        : {}),
    }];

    const wantsExits = Boolean(b.takeProfit || b.stopLoss);
    // Exits are sized from the entry's quantity. A funds-denominated entry has
    // no quantity, so an exit leg would be signed with no size at all - and
    // since entry and exits share ONE signed request, that poisons the entry
    // too. Refuse up front instead of emitting a malformed batch.
    if (wantsExits && !norm.quantity) {
      return reply.code(400).send({
        error:
          'take-profit / stop-loss require an explicit quantity, because the exit legs are sized from it. Specify quantity instead of funds, or place the exits separately after the entry fills.',
      });
    }

    const exitSide = side === A.OrderSide.BUY ? A.OrderSide.SELL : A.OrderSide.BUY;
    for (const [leg, stopType] of [
      [b.takeProfit, A.StopType.TAKE_PROFIT],
      [b.stopLoss, A.StopType.STOP_LOSS],
    ] as const) {
      if (!leg) continue;
      let legStop: string | undefined;
      try {
        legStop = normaliseOrder(sym, { price: leg.price, type: A.OrderType.LIMIT }).price;
      } catch (e) {
        if (e instanceof OrderValidationError) {
          const which = stopType === A.StopType.TAKE_PROFIT ? 'take-profit' : 'stop-loss';
          return reply.code(400).send({ error: `${which} price: ${e.message}` });
        }
        throw e;
      }
      orders.push({
        clOrdID: genClOrdID(stopType === A.StopType.TAKE_PROFIT ? 'tp' : 'sl'),
        side: exitSide,
        type: A.OrderType.MARKET,
        timeInForce: A.TimeInForce.IOC,
        quantity: norm.quantity,
        stopPrice: legStop,
        stopType,
        triggerType: TRIGGER[leg.triggerType ?? 'mark'],
        // Exits can only ever close, never flip the position.
        reduceOnly: true,
      });
    }

    const params = A.perpsNewOrder(s.accountId, sym.id, orders);
    return {
      engine, symbol: sym.name, orderCount: orders.length,
      result: await sodex.post(engine, '/trade/orders', A.ACTION.newOrder, params),
    };
  });

  /** Cancel by orderID or clOrdID. Omit both to cancel everything on the symbol. */
  app.delete('/api/trade/:engine/order', async (req, reply) => {
    guardMainnet();
    const engine = asEngine((req.params as any).engine);
    const b = req.body as { symbol: string; orderID?: number; clOrdID?: string };
    const s = sodex.requireSession();
    if (!b?.symbol) return reply.code(400).send({ error: 'symbol is required' });
    const sym = await resolve(engine, b.symbol);

    if (engine === 'spot') {
      const params = A.spotBatchCancelOrder(s.accountId, [{
        symbolID: sym.id,
        clOrdID: genClOrdID('cx'),
        orderID: b.orderID,
        origClOrdID: b.clOrdID,
      }]);
      return { result: await sodex.del(engine, '/trade/orders/batch', A.ACTION.batchCancelOrder, params) };
    }
    const params = A.perpsCancelOrder(s.accountId, [{
      symbolID: sym.id, orderID: b.orderID, clOrdID: b.clOrdID,
    }]);
    return { result: await sodex.del(engine, '/trade/orders', A.ACTION.cancelOrder, params) };
  });

  /** Cancel every open order, optionally scoped to one symbol. */
  app.delete('/api/trade/:engine/orders/all', async (req) => {
    guardMainnet();
    const engine = asEngine((req.params as any).engine);
    const { symbol } = (req.body ?? {}) as { symbol?: string };
    const s = sodex.requireSession();
    // The gateway wraps this one as {blockTime, blockHeight, orders: [...]}.
    // Treating it as a bare array silently yielded [] - so cancel-all reported
    // success having cancelled nothing.
    const open = await sodex.get(
      `/api/v1/${engine}/accounts/${s.address}/orders${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`,
    );
    const list = unwrapList<any>(open, 'orders');
    if (!list.length) return { cancelled: 0, result: null };

    if (engine === 'spot') {
      const params = A.spotBatchCancelOrder(
        s.accountId,
        list.map((o) => ({ symbolID: o.symbolID ?? o.si, clOrdID: genClOrdID('cx'), orderID: o.orderID ?? o.i })),
      );
      return { cancelled: list.length, result: await sodex.del(engine, '/trade/orders/batch', A.ACTION.batchCancelOrder, params) };
    }
    const params = A.perpsCancelOrder(
      s.accountId,
      list.map((o) => ({ symbolID: o.symbolID ?? o.si, orderID: o.orderID ?? o.i })),
    );
    return { cancelled: list.length, result: await sodex.del(engine, '/trade/orders', A.ACTION.cancelOrder, params) };
  });

  /** Modify a resting perps order in place (price / quantity / stopPrice). */
  app.post('/api/trade/perps/modify', async (req, reply) => {
    guardMainnet();
    const b = req.body as {
      symbol: string; orderID?: number; clOrdID?: string;
      price?: string; quantity?: string; stopPrice?: string;
    };
    const s = sodex.requireSession();
    if (!b?.symbol) return reply.code(400).send({ error: 'symbol is required' });
    if (!b.orderID && !b.clOrdID) return reply.code(400).send({ error: 'orderID or clOrdID is required' });
    const sym = await resolve('perps', b.symbol);

    let norm;
    try {
      norm = normaliseOrder(sym, { price: b.price, quantity: b.quantity, type: A.OrderType.LIMIT });
    } catch (e) {
      if (e instanceof OrderValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    let stopPrice: string | undefined;
    if (b.stopPrice) {
      try {
        stopPrice = normaliseOrder(sym, { price: b.stopPrice, type: A.OrderType.LIMIT }).price;
      } catch (e) {
        if (e instanceof OrderValidationError) {
          return reply.code(400).send({ error: `trigger price: ${e.message}` });
        }
        throw e;
      }
    }
    const params = A.perpsModifyOrder({
      accountID: s.accountId, symbolID: sym.id,
      orderID: b.orderID, clOrdID: b.clOrdID,
      price: norm.price, quantity: norm.quantity, stopPrice,
    });
    return { result: await sodex.post('perps', '/trade/orders/modify', A.ACTION.modifyOrder, params) };
  });

  /** Atomic cancel-and-replace. */
  app.post('/api/trade/:engine/replace', async (req, reply) => {
    guardMainnet();
    const engine = asEngine((req.params as any).engine);
    const b = req.body as {
      symbol: string; origOrderID?: number; origClOrdID?: string;
      price?: string; quantity?: string;
    };
    const s = sodex.requireSession();
    if (!b?.symbol) return reply.code(400).send({ error: 'symbol is required' });
    const sym = await resolve(engine, b.symbol);
    const norm = normaliseOrder(sym, { price: b.price, quantity: b.quantity, type: A.OrderType.LIMIT });
    const params = A.replaceOrder(s.accountId, [{
      symbolID: sym.id, clOrdID: genClOrdID('rp'),
      origOrderID: b.origOrderID, origClOrdID: b.origClOrdID,
      price: norm.price, quantity: norm.quantity,
    }]);
    return { result: await sodex.post(engine, '/trade/orders/replace', A.ACTION.replaceOrder, params) };
  });

  app.post('/api/trade/perps/leverage', async (req, reply) => {
    guardMainnet();
    const b = req.body as { symbol: string; leverage: number; marginMode?: 'isolated' | 'cross' };
    const s = sodex.requireSession();
    if (!b?.symbol) return reply.code(400).send({ error: 'symbol is required' });
    const sym = await resolve('perps', b.symbol);
    const lev = Number(b.leverage);
    if (!Number.isInteger(lev) || lev < 1) {
      return reply.code(400).send({ error: 'leverage must be a positive integer' });
    }
    if (sym.maxLeverage && lev > sym.maxLeverage) {
      return reply.code(400).send({ error: `${sym.displayName} allows at most ${sym.maxLeverage}x` });
    }
    const params = A.perpsUpdateLeverage(
      s.accountId, sym.id, lev,
      b.marginMode === 'isolated' ? A.MarginMode.ISOLATED : A.MarginMode.CROSS,
    );
    return { result: await sodex.post('perps', '/trade/leverage', A.ACTION.updateLeverage, params) };
  });

  /** Add (positive) or remove (negative) isolated margin on a position. */
  app.post('/api/trade/perps/margin', async (req, reply) => {
    guardMainnet();
    const b = req.body as { symbol: string; amount: string };
    const s = sodex.requireSession();
    if (!b?.symbol || !b.amount) return reply.code(400).send({ error: 'symbol and amount are required' });
    const sym = await resolve('perps', b.symbol);
    const params = A.perpsUpdateMargin(s.accountId, sym.id, b.amount);
    return { result: await sodex.post('perps', '/trade/margin', A.ACTION.updateMargin, params) };
  });

  /**
   * Dead-man's switch: the gateway cancels every open order after
   * `scheduledTimestamp` unless it is re-armed. Omit it to clear the schedule.
   */
  app.post('/api/trade/:engine/schedule-cancel', async (req) => {
    guardMainnet();
    const engine = asEngine((req.params as any).engine);
    const b = (req.body ?? {}) as { afterMs?: number; scheduledTimestamp?: number };
    const s = sodex.requireSession();
    const ts = b.scheduledTimestamp ?? (b.afterMs ? Date.now() + b.afterMs : undefined);
    const params = A.scheduleCancel(s.accountId, ts);
    return {
      scheduledTimestamp: ts ?? null,
      result: await sodex.post(engine, '/trade/orders/schedule-cancel', A.ACTION.scheduleCancel, params),
    };
  });

}
