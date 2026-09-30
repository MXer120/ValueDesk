/**
 * Signed action payload builders, ported from Opentrade/server/src/signing/actions.ts.
 *
 * EVERY builder here emits object keys in the exact order of the corresponding Go
 * struct in the reference SDK. This is load-bearing, not cosmetic: the gateway
 * verifies signatures by re-marshalling the body with Go's `encoding/json`, which
 * emits fields in struct-declaration order. A reordered key produces a different
 * payloadHash and an opaque 401.
 *
 * Struct sources (sodex-go-sdk-public):
 *   perps/types/{new,cancel,modify,update_leverage,update_margin}_order_request.go
 *   spot/types/batch_{new,cancel}_order_request.go
 *   common/types/{replace_order,transfer_asset,schedule_cancel,revoke_api_key,twap_order}_request.go
 *   common/types/builder.go (BuilderParams {id, fee})
 *
 * Optional (`omitempty`) fields are represented as `undefined` and dropped by
 * goJSONStringify, mirroring Go's nil-pointer omission.
 *
 * API-key PERMISSIONS live in permissions.ts, not here: Opentrade's first version
 * of this file read the mask as grants ("mask 3 = TRADE|CANCEL"), which is
 * inverted. See permissions.ts for the documented disable-mask.
 */
import { canonicalDecimal } from './decimal.ts';
import type { Engine } from './network.ts';

// --- enums (common/enums/*.go) ---------------------------------------------

export const OrderSide = { BUY: 1, SELL: 2 } as const;
export const OrderType = { LIMIT: 1, MARKET: 2 } as const;
/** FOK exists in the enum but the gateway documents it as NOT supported. */
export const TimeInForce = { GTC: 1, FOK: 2, IOC: 3, GTX: 4 } as const;
export const MarginMode = { ISOLATED: 1, CROSS: 2 } as const;
/** Only BOTH is accepted on order placement - perps is one-way/netted, no hedge mode. */
export const PositionSide = { BOTH: 1, LONG: 2, SHORT: 3 } as const;
/** NORMAL, STOP (position/standalone TP/SL), BRACKET + ATTACHED_STOP (entry with TP/SL). */
export const OrderModifier = { NORMAL: 1, STOP: 2, BRACKET: 3, ATTACHED_STOP: 4 } as const;
export const StopType = { STOP_LOSS: 1, TAKE_PROFIT: 2 } as const;
/** Only MARK_PRICE is accepted on order placement today (schema, 2026-09). */
export const TriggerType = { LAST_PRICE: 1, MARK_PRICE: 2, INDEX_PRICE: 3 } as const;
export const TransferType = {
  EVM_DEPOSIT: 0,
  PERPS_DEPOSIT: 1,
  EVM_WITHDRAW: 2,
  PERPS_WITHDRAW: 3,
  INTERNAL: 4,
  SPOT_WITHDRAW: 5,
  SPOT_DEPOSIT: 6,
} as const;

export const OrderStatus: Record<number, string> = {
  0: 'UNKNOWN', 1: 'NEW', 2: 'PARTIALLY_FILLED', 3: 'FILLED', 4: 'CANCELED',
  5: 'REJECTED', 6: 'EXPIRED', 7: 'PENDING_NEW', 8: 'PENDING_CANCEL',
  9: 'PENDING_MODIFY', 10: 'TRIGGERED', 11: 'REPLACED', 12: 'PENDING_REPLACE',
};

export const ExecType: Record<number, string> = {
  0: 'UNKNOWN', 1: 'NEW', 2: 'PARTIALLY_FILLED', 3: 'FILLED', 4: 'CANCELED',
  5: 'REJECTED', 6: 'MODIFIED', 7: 'EXPIRED', 8: 'REPLACED',
};

/** `^[0-9a-zA-Z_-]{1,36}$` - enforced by the gateway. */
export const CL_ORD_ID_RE = /^[0-9a-zA-Z_-]{1,36}$/;

export function assertClOrdID(id: string): string {
  if (!CL_ORD_ID_RE.test(id)) {
    throw new Error(`clOrdID must match ${CL_ORD_ID_RE} (got ${JSON.stringify(id)})`);
  }
  return id;
}

/** Documented batch ceiling for both engines. */
export const MAX_ORDERS_PER_BATCH = 100;

const MAX_UINT64 = (1n << 64n) - 1n;

/** A uint64 carried as a JS number (must be a safe integer) or a bigint. */
export type U64 = number | bigint;

function u64(v: U64, what: string): U64 {
  if (typeof v === 'bigint') {
    if (v < 0n || v > MAX_UINT64) throw new RangeError(`${what} is out of uint64 range`);
    return v;
  }
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer (got ${v})`);
  }
  return v;
}

const optU64 = (v: U64 | undefined, what: string): U64 | undefined =>
  v === undefined ? undefined : u64(v, what);

function batch<T>(list: readonly T[], what: string): readonly T[] {
  if (!Array.isArray(list) || list.length === 0) throw new RangeError(`${what} cannot be empty`);
  if (list.length > MAX_ORDERS_PER_BATCH) {
    throw new RangeError(`${what} has ${list.length} entries; the gateway allows at most ${MAX_ORDERS_PER_BATCH}`);
  }
  return list;
}

/** Optional decimal: canonicalise if present, else undefined so the key is dropped. */
const dec = (v: string | number | undefined | null): string | undefined =>
  v === undefined || v === null || v === '' ? undefined : canonicalDecimal(v);

// --- builder codes ---------------------------------------------------------

/**
 * common/types.BuilderParams: `{ "id": <builder account id>, "fee": <tenths of a bp> }`.
 * `id` BEFORE `fee`, and the fragment is the LAST key of its containing struct.
 */
export interface BuilderParams {
  /** The builder's SoDEX account id (non-zero). */
  id: U64;
  /** Fee in tenths of a basis point: 10 = 1 bp = 0.01 %. */
  fee: number;
}

/** Per-order engine caps (builder-codes doc): spot 2 %, perps 0.2 %. */
export const BUILDER_FEE_CAP: Readonly<Record<Engine, number>> = { spot: 2000, perps: 200 };
/** `maxFeeRate` accepted by ApproveBuilderFee / AddAPIKeyWithBuilder: 0..2000 inclusive. */
export const MAX_BUILDER_APPROVAL_RATE = 2000;

/** Validate and emit the `{id, fee}` fragment in Go field order. */
export function builderFragment(b: BuilderParams, engine: Engine): { id: U64; fee: number } {
  const id = u64(b.id, 'builder.id');
  if (id === 0 || id === 0n) throw new RangeError('builder.id must be non-zero');
  const cap = BUILDER_FEE_CAP[engine];
  if (!Number.isInteger(b.fee) || b.fee < 0 || b.fee > cap) {
    throw new RangeError(`builder.fee must be an integer 0..${cap} for ${engine} (got ${b.fee})`);
  }
  return { id, fee: b.fee };
}

// --- perps: newOrder --------------------------------------------------------

export interface RawOrderInput {
  clOrdID: string;
  side: number;
  type: number;
  timeInForce: number;
  price?: string;
  quantity?: string;
  funds?: string;
  stopPrice?: string;
  stopType?: number;
  triggerType?: number;
  reduceOnly?: boolean;
  positionSide?: number;
  modifier?: number;
  /**
   * PER-ORDER builder override (perps only). UNVERIFIED at the gateway: the Go
   * SDK (2026-07-21) has no such field; the layout (last key, after
   * positionSide) comes from the Python SDK (2026-09-08) and the builder-codes
   * doc ("Perps supports a batch default and per-order overrides"). Pinned
   * only by the `perps_new_order_builder_per_order` vector, whose bytes are Go
   * encoding/json over a struct mirroring that layout. Prefer the batch-level
   * `builder` argument of `perpsNewOrder`, which the Go SDK does carry.
   */
  builder?: BuilderParams;
}

/** perps/types.RawOrder - field order is fixed. */
export const buildRawOrder = (o: RawOrderInput) => ({
  clOrdID: assertClOrdID(o.clOrdID),
  modifier: o.modifier ?? OrderModifier.NORMAL,
  side: o.side,
  type: o.type,
  timeInForce: o.timeInForce,
  price: dec(o.price),
  quantity: dec(o.quantity),
  funds: dec(o.funds),
  stopPrice: dec(o.stopPrice),
  stopType: o.stopType,
  triggerType: o.triggerType,
  reduceOnly: o.reduceOnly ?? false,
  positionSide: o.positionSide ?? PositionSide.BOTH,
  builder: o.builder ? builderFragment(o.builder, 'perps') : undefined,
});

/**
 * perps/types.NewOrderRequest -> POST /api/v1/perps/trade/orders (action "newOrder").
 * `builder` (optional) is the batch default, emitted LAST, after `orders`.
 */
export const perpsNewOrder = (
  accountID: U64,
  symbolID: U64,
  orders: readonly RawOrderInput[],
  builder?: BuilderParams,
) => ({
  accountID: u64(accountID, 'accountID'),
  symbolID: u64(symbolID, 'symbolID'),
  orders: batch(orders, 'orders').map(buildRawOrder),
  builder: builder ? builderFragment(builder, 'perps') : undefined,
});

/** perps/types.CancelOrderRequest -> DELETE /api/v1/perps/trade/orders (action "cancelOrder") */
export const perpsCancelOrder = (
  accountID: U64,
  cancels: ReadonlyArray<{ symbolID: U64; orderID?: U64; clOrdID?: string }>,
) => ({
  accountID: u64(accountID, 'accountID'),
  cancels: batch(cancels, 'cancels').map((c) => {
    if (c.orderID === undefined && c.clOrdID === undefined) {
      throw new Error('each cancel needs an orderID or a clOrdID');
    }
    return {
      symbolID: u64(c.symbolID, 'symbolID'),
      orderID: optU64(c.orderID, 'orderID'),
      clOrdID: c.clOrdID === undefined ? undefined : assertClOrdID(c.clOrdID),
    };
  }),
});

/** perps/types.ModifyOrderRequest -> POST /api/v1/perps/trade/orders/modify (action "modifyOrder") */
export const perpsModifyOrder = (i: {
  accountID: U64;
  symbolID: U64;
  orderID?: U64;
  clOrdID?: string;
  price?: string;
  quantity?: string;
  stopPrice?: string;
}) => ({
  accountID: u64(i.accountID, 'accountID'),
  symbolID: u64(i.symbolID, 'symbolID'),
  orderID: optU64(i.orderID, 'orderID'),
  clOrdID: i.clOrdID === undefined ? undefined : assertClOrdID(i.clOrdID),
  price: dec(i.price),
  quantity: dec(i.quantity),
  stopPrice: dec(i.stopPrice),
});

/** perps/types.UpdateLeverageRequest -> POST /api/v1/perps/trade/leverage (action "updateLeverage") */
export const perpsUpdateLeverage = (
  accountID: U64,
  symbolID: U64,
  leverage: number,
  marginMode: number,
) => ({
  accountID: u64(accountID, 'accountID'),
  symbolID: u64(symbolID, 'symbolID'),
  leverage: u64(leverage, 'leverage'),
  marginMode,
});

/** perps/types.UpdateMarginRequest -> POST /api/v1/perps/trade/margin (action "updateMargin") */
export const perpsUpdateMargin = (accountID: U64, symbolID: U64, amount: string) => ({
  accountID: u64(accountID, 'accountID'),
  symbolID: u64(symbolID, 'symbolID'),
  amount: canonicalDecimal(amount),
});

// --- spot: batch actions ----------------------------------------------------

/** spot/types.BatchNewOrderItem */
export interface SpotOrderInput {
  symbolID: U64;
  clOrdID: string;
  side: number;
  type: number;
  timeInForce: number;
  price?: string;
  quantity?: string;
  funds?: string;
}

/**
 * spot/types.BatchNewOrderRequest -> POST /api/v1/spot/trade/orders/batch (action "batchNewOrder").
 * `builder` (optional) is batch-level only on spot, emitted after `orders`.
 */
export const spotBatchNewOrder = (
  accountID: U64,
  orders: readonly SpotOrderInput[],
  builder?: BuilderParams,
) => ({
  accountID: u64(accountID, 'accountID'),
  orders: batch(orders, 'orders').map((o) => ({
    symbolID: u64(o.symbolID, 'symbolID'),
    clOrdID: assertClOrdID(o.clOrdID),
    side: o.side,
    type: o.type,
    timeInForce: o.timeInForce,
    price: dec(o.price),
    quantity: dec(o.quantity),
    funds: dec(o.funds),
  })),
  builder: builder ? builderFragment(builder, 'spot') : undefined,
});

/** spot/types.BatchCancelOrderRequest -> DELETE /api/v1/spot/trade/orders/batch */
export const spotBatchCancelOrder = (
  accountID: U64,
  cancels: ReadonlyArray<{ symbolID: U64; clOrdID: string; orderID?: U64; origClOrdID?: string }>,
) => ({
  accountID: u64(accountID, 'accountID'),
  cancels: batch(cancels, 'cancels').map((c) => ({
    symbolID: u64(c.symbolID, 'symbolID'),
    clOrdID: assertClOrdID(c.clOrdID),
    orderID: optU64(c.orderID, 'orderID'),
    origClOrdID: c.origClOrdID === undefined ? undefined : assertClOrdID(c.origClOrdID),
  })),
});

// --- shared actions ---------------------------------------------------------

/** common/types.ReplaceOrderRequest -> POST /trade/orders/replace (action "replaceOrder") */
export const replaceOrder = (
  accountID: U64,
  orders: ReadonlyArray<{
    symbolID: U64;
    clOrdID: string;
    origOrderID?: U64;
    origClOrdID?: string;
    price?: string;
    quantity?: string;
  }>,
) => ({
  accountID: u64(accountID, 'accountID'),
  orders: batch(orders, 'orders').map((o) => ({
    symbolID: u64(o.symbolID, 'symbolID'),
    clOrdID: assertClOrdID(o.clOrdID),
    origOrderID: optU64(o.origOrderID, 'origOrderID'),
    origClOrdID: o.origClOrdID === undefined ? undefined : assertClOrdID(o.origClOrdID),
    price: dec(o.price),
    quantity: dec(o.quantity),
  })),
});

/** common/types.TransferAssetRequest -> POST /accounts/transfers (action "transferAsset") */
export const transferAsset = (i: {
  id: U64;
  fromAccountID: U64;
  toAccountID: U64;
  coinID: U64;
  amount: string;
  type: number;
}) => ({
  id: u64(i.id, 'id'),
  fromAccountID: u64(i.fromAccountID, 'fromAccountID'),
  toAccountID: u64(i.toAccountID, 'toAccountID'),
  coinID: u64(i.coinID, 'coinID'),
  amount: canonicalDecimal(i.amount),
  type: i.type,
});

/** Magic account ID for cross-engine (spot <-> perps) transfers. */
export const CROSS_ENGINE_ACCOUNT_ID = 999;

/** common/types.ScheduleCancelRequest -> POST /trade/orders/schedule-cancel */
export const scheduleCancel = (accountID: U64, scheduledTimestamp?: U64) => ({
  accountID: u64(accountID, 'accountID'),
  scheduledTimestamp: optU64(scheduledTimestamp, 'scheduledTimestamp'),
});

/** common/types.RevokeAPIKeyRequest (action "revokeAPIKey"). Signed by the MASTER wallet. */
export const revokeAPIKey = (accountID: U64, name: string) => ({
  accountID: u64(accountID, 'accountID'),
  name,
});

/**
 * common/types.NewTwapOrderRequest -> POST /trade/twaps (action "newTwapOrder").
 * `reduceOnly` is a Go *bool with omitempty: undefined drops the key, false keeps it.
 * The schema lists reduceOnly for perps only; leave it undefined on spot.
 */
export const newTwapOrder = (i: {
  accountID: U64;
  symbolID: U64;
  side: number;
  quantity: string;
  minutes: number;
  randomize: boolean;
  reduceOnly?: boolean;
}) => {
  if (!Number.isInteger(i.minutes) || i.minutes < 5 || i.minutes > 1440) {
    throw new RangeError(`TWAP minutes must be 5..1440 (got ${i.minutes})`);
  }
  return {
    accountID: u64(i.accountID, 'accountID'),
    symbolID: u64(i.symbolID, 'symbolID'),
    side: i.side,
    quantity: canonicalDecimal(i.quantity),
    minutes: i.minutes,
    randomize: i.randomize,
    reduceOnly: i.reduceOnly,
  };
};

/** common/types.CancelTwapOrderRequest -> DELETE /trade/twaps (action "cancelTwapOrder") */
export const cancelTwapOrder = (accountID: U64, symbolID: U64, orderID: U64) => ({
  accountID: u64(accountID, 'accountID'),
  symbolID: u64(symbolID, 'symbolID'),
  orderID: u64(orderID, 'orderID'),
});

export const ACTION = {
  newOrder: 'newOrder',
  batchNewOrder: 'batchNewOrder',
  cancelOrder: 'cancelOrder',
  batchCancelOrder: 'batchCancelOrder',
  modifyOrder: 'modifyOrder',
  replaceOrder: 'replaceOrder',
  scheduleCancel: 'scheduleCancel',
  transferAsset: 'transferAsset',
  updateLeverage: 'updateLeverage',
  updateMargin: 'updateMargin',
  revokeAPIKey: 'revokeAPIKey',
  newTwapOrder: 'newTwapOrder',
  cancelTwapOrder: 'cancelTwapOrder',
} as const;
export type ActionType = (typeof ACTION)[keyof typeof ACTION];

// --- endpoints ----------------------------------------------------------------

export interface Endpoint {
  method: 'POST' | 'DELETE';
  /** Relative to /api/v1/{engine}. */
  path: string;
}

/**
 * Where each signed action goes, per engine (SoDEX REST v1 docs, 2026-09; the
 * order/leverage/margin/transfer routes are the ones Opentrade's routes/trade.ts
 * and routes/money.ts use). An action missing for an engine does not exist there.
 *
 * revokeAPIKey is the DOCUMENTED route (DELETE, master-wallet engine-domain
 * signature). It and the TWAP routes have not been exercised live by this
 * codebase - see registration.ts for the alternatives.
 */
export const ENDPOINTS: Readonly<Record<Engine, Readonly<Partial<Record<ActionType, Endpoint>>>>> = {
  perps: {
    newOrder: { method: 'POST', path: '/trade/orders' },
    cancelOrder: { method: 'DELETE', path: '/trade/orders' },
    modifyOrder: { method: 'POST', path: '/trade/orders/modify' },
    replaceOrder: { method: 'POST', path: '/trade/orders/replace' },
    scheduleCancel: { method: 'POST', path: '/trade/orders/schedule-cancel' },
    updateLeverage: { method: 'POST', path: '/trade/leverage' },
    updateMargin: { method: 'POST', path: '/trade/margin' },
    transferAsset: { method: 'POST', path: '/accounts/transfers' },
    newTwapOrder: { method: 'POST', path: '/trade/twaps' },
    cancelTwapOrder: { method: 'DELETE', path: '/trade/twaps' },
    revokeAPIKey: { method: 'DELETE', path: '/accounts/api-keys' },
  },
  spot: {
    batchNewOrder: { method: 'POST', path: '/trade/orders/batch' },
    batchCancelOrder: { method: 'DELETE', path: '/trade/orders/batch' },
    replaceOrder: { method: 'POST', path: '/trade/orders/replace' },
    scheduleCancel: { method: 'POST', path: '/trade/orders/schedule-cancel' },
    transferAsset: { method: 'POST', path: '/accounts/transfers' },
    newTwapOrder: { method: 'POST', path: '/trade/twaps' },
    cancelTwapOrder: { method: 'DELETE', path: '/trade/twaps' },
    revokeAPIKey: { method: 'DELETE', path: '/accounts/api-keys' },
  },
};

export function endpointFor(engine: Engine, type: ActionType): Endpoint {
  const ep = ENDPOINTS[engine][type];
  if (!ep) throw new Error(`action ${type} does not exist on the ${engine} engine`);
  return ep;
}

// --- signable actions -----------------------------------------------------------

/** A fully built exchange action: which engine, which action type, Go-ordered params. */
export interface SignableAction<T extends ActionType = ActionType> {
  readonly engine: Engine;
  readonly type: T;
  readonly params: object;
}

const act = <T extends ActionType>(engine: Engine, type: T, params: object): SignableAction<T> => {
  endpointFor(engine, type); // fail at build time, not at send time
  return { engine, type, params };
};

/** Perps actions, ready for `signAndBuild`. */
export const perpsActions = {
  newOrder: (accountID: U64, symbolID: U64, orders: readonly RawOrderInput[], builder?: BuilderParams) =>
    act('perps', 'newOrder', perpsNewOrder(accountID, symbolID, orders, builder)),
  cancelOrder: (accountID: U64, cancels: Parameters<typeof perpsCancelOrder>[1]) =>
    act('perps', 'cancelOrder', perpsCancelOrder(accountID, cancels)),
  modifyOrder: (i: Parameters<typeof perpsModifyOrder>[0]) => act('perps', 'modifyOrder', perpsModifyOrder(i)),
  replaceOrder: (accountID: U64, orders: Parameters<typeof replaceOrder>[1]) =>
    act('perps', 'replaceOrder', replaceOrder(accountID, orders)),
  scheduleCancel: (accountID: U64, scheduledTimestamp?: U64) =>
    act('perps', 'scheduleCancel', scheduleCancel(accountID, scheduledTimestamp)),
  updateLeverage: (accountID: U64, symbolID: U64, leverage: number, marginMode: number) =>
    act('perps', 'updateLeverage', perpsUpdateLeverage(accountID, symbolID, leverage, marginMode)),
  updateMargin: (accountID: U64, symbolID: U64, amount: string) =>
    act('perps', 'updateMargin', perpsUpdateMargin(accountID, symbolID, amount)),
  transferAsset: (i: Parameters<typeof transferAsset>[0]) => act('perps', 'transferAsset', transferAsset(i)),
  newTwapOrder: (i: Parameters<typeof newTwapOrder>[0]) => act('perps', 'newTwapOrder', newTwapOrder(i)),
  cancelTwapOrder: (accountID: U64, symbolID: U64, orderID: U64) =>
    act('perps', 'cancelTwapOrder', cancelTwapOrder(accountID, symbolID, orderID)),
} as const;

/** Spot actions, ready for `signAndBuild`. */
export const spotActions = {
  batchNewOrder: (accountID: U64, orders: readonly SpotOrderInput[], builder?: BuilderParams) =>
    act('spot', 'batchNewOrder', spotBatchNewOrder(accountID, orders, builder)),
  batchCancelOrder: (accountID: U64, cancels: Parameters<typeof spotBatchCancelOrder>[1]) =>
    act('spot', 'batchCancelOrder', spotBatchCancelOrder(accountID, cancels)),
  replaceOrder: (accountID: U64, orders: Parameters<typeof replaceOrder>[1]) =>
    act('spot', 'replaceOrder', replaceOrder(accountID, orders)),
  scheduleCancel: (accountID: U64, scheduledTimestamp?: U64) =>
    act('spot', 'scheduleCancel', scheduleCancel(accountID, scheduledTimestamp)),
  transferAsset: (i: Parameters<typeof transferAsset>[0]) => act('spot', 'transferAsset', transferAsset(i)),
  newTwapOrder: (i: Omit<Parameters<typeof newTwapOrder>[0], 'reduceOnly'>) =>
    act('spot', 'newTwapOrder', newTwapOrder(i)),
  cancelTwapOrder: (accountID: U64, symbolID: U64, orderID: U64) =>
    act('spot', 'cancelTwapOrder', cancelTwapOrder(accountID, symbolID, orderID)),
} as const;
