/**
 * Signed action payload builders.
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
 *   common/types/{replace_order,transfer_asset,schedule_cancel,revoke_api_key}_request.go
 *
 * Optional (`omitempty`) fields are represented as `undefined` and dropped by
 * goJSONStringify, mirroring Go's nil-pointer omission.
 */
import { canonicalDecimal } from '../decimal.js';

// --- enums (common/enums/*.go) ---------------------------------------------

export const OrderSide = { BUY: 1, SELL: 2 } as const;
export const OrderType = { LIMIT: 1, MARKET: 2 } as const;
export const TimeInForce = { GTC: 1, FOK: 2, IOC: 3, GTX: 4 } as const;
export const MarginMode = { ISOLATED: 1, CROSS: 2 } as const;
/** Only BOTH is accepted on order placement - perps is one-way/netted, no hedge mode. */
export const PositionSide = { BOTH: 1, LONG: 2, SHORT: 3 } as const;
export const OrderModifier = { NORMAL: 1 } as const;
export const StopType = { STOP_LOSS: 1, TAKE_PROFIT: 2 } as const;
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

/**
 * API key permission bits (common/enums/api_key_permission.go). Mask = 1 << bit.
 *
 * A SET BIT DISABLES THE PERMISSION. That is SoDEX's wire semantics, stated in
 * three independent places: the Go SDK enum ("A set bit disables the
 * corresponding permission."), the Python SDK enum ("Disabled-permission bits")
 * and the REST schema (APIKeyPermissionEnum: "A bit value of 1 means the
 * permission is disabled. If permissions is omitted, all permissions are
 * enabled."). So an ordinary key - one with no `permissions` field - is mask 0
 * and can do everything, including withdraw.
 *
 * This file used to read the bits as grants and minted mask 3 as "trade-only".
 * Per the docs, mask 3 is the opposite: TRADE and CANCEL disabled, WITHDRAW and
 * TRANSFER enabled. See docs/PERMISSION-MASK.md.
 *
 * Never compose masks by hand. Use `disableAllBut` to build one and `permits`
 * to read one.
 */
export const APIKeyPermission = { TRADE: 1, CANCEL: 2, WITHDRAW: 4, TRANSFER: 8 } as const;
export const ALL_PERMISSION_BITS =
  APIKeyPermission.TRADE | APIKeyPermission.CANCEL | APIKeyPermission.WITHDRAW | APIKeyPermission.TRANSFER;

/** The wire mask for a key that may do exactly `enabled` and nothing else. */
export const disableAllBut = (enabled: number): number => ALL_PERMISSION_BITS & ~enabled;

/** Whether a key with wire mask `mask` has permission `bit`. Absent mask = 0 = everything. */
export const permits = (mask: number, bit: number): boolean => (mask & bit) === 0;

/** Whether a key with wire mask `mask` can move funds by any route SoDEX documents. */
export const canMoveFunds = (mask: number): boolean =>
  permits(mask, APIKeyPermission.WITHDRAW) || permits(mask, APIKeyPermission.TRANSFER);

/** Lower-case names of the permissions a wire mask leaves ENABLED. */
export const enabledPermissionNames = (mask: number): string[] =>
  Object.entries(APIKeyPermission)
    .filter(([, bit]) => permits(mask, bit))
    .map(([name]) => name.toLowerCase());

/**
 * AddPermissionedAPIKey accepts only masks that disable TRADE, CANCEL or both:
 * "enabling both TRADE and CANCEL is not supported" (REST schema). A mask of 0
 * is therefore not a valid permissioned key - that is what AddAPIKey is for.
 */
export const isPermissionedKeyMask = (mask: number): boolean =>
  Number.isInteger(mask) &&
  (mask & ~ALL_PERMISSION_BITS) === 0 &&
  (mask & (APIKeyPermission.TRADE | APIKeyPermission.CANCEL)) !== 0;

/**
 * The masks this app mints. Each one leaves exactly one permission enabled.
 *
 * TRADE_ONLY relies on the schema's description of TRADE - "Place, replace,
 * modify, and cancel orders; schedule cancels; update perps leverage, margin,
 * and collateral" - to cover cancels with the CANCEL bit disabled. That, and
 * the gateway refusing withdraw/transfer for these masks, is documented but NOT
 * yet observed; docs/PERMISSION-MASK.md has the testnet plan that settles it.
 * Until it passes, config.PERMISSIONS_VERIFIED keeps mainnet minting off.
 */
export const PERMISSION_MASK = {
  /** 14. The resting session key: trade, and nothing that moves funds. */
  TRADE_ONLY: disableAllBut(APIKeyPermission.TRADE),
  /** 11. Elevation for EVM withdrawal and for spot<->perps moves - both need WITHDRAW. */
  WITHDRAW_ONLY: disableAllBut(APIKeyPermission.WITHDRAW),
  /** 7. Elevation for sub-account / internal transfers. */
  TRANSFER_ONLY: disableAllBut(APIKeyPermission.TRANSFER),
} as const;

/** `^[0-9a-zA-Z_-]{1,36}$` - enforced by the gateway. */
export const CL_ORD_ID_RE = /^[0-9a-zA-Z_-]{1,36}$/;

export function assertClOrdID(id: string): string {
  if (!CL_ORD_ID_RE.test(id)) {
    throw new Error(`clOrdID must match ${CL_ORD_ID_RE} (got ${JSON.stringify(id)})`);
  }
  return id;
}

/** Optional decimal: canonicalise if present, else undefined so the key is dropped. */
const dec = (v: string | number | undefined | null): string | undefined =>
  v === undefined || v === null || v === '' ? undefined : canonicalDecimal(v);

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
});

/** perps/types.NewOrderRequest -> POST /api/v1/perps/trade/orders (action "newOrder") */
export const perpsNewOrder = (accountID: number, symbolID: number, orders: RawOrderInput[]) => ({
  accountID,
  symbolID,
  orders: orders.map(buildRawOrder),
});

/** perps/types.CancelOrderRequest -> DELETE /api/v1/perps/trade/orders (action "cancelOrder") */
export const perpsCancelOrder = (
  accountID: number,
  cancels: Array<{ symbolID: number; orderID?: number; clOrdID?: string }>,
) => ({
  accountID,
  cancels: cancels.map((c) => ({
    symbolID: c.symbolID,
    orderID: c.orderID,
    clOrdID: c.clOrdID,
  })),
});

/** perps/types.ModifyOrderRequest -> POST /api/v1/perps/trade/orders/modify (action "modifyOrder") */
export const perpsModifyOrder = (i: {
  accountID: number;
  symbolID: number;
  orderID?: number;
  clOrdID?: string;
  price?: string;
  quantity?: string;
  stopPrice?: string;
}) => ({
  accountID: i.accountID,
  symbolID: i.symbolID,
  orderID: i.orderID,
  clOrdID: i.clOrdID,
  price: dec(i.price),
  quantity: dec(i.quantity),
  stopPrice: dec(i.stopPrice),
});

/** perps/types.UpdateLeverageRequest -> POST /api/v1/perps/trade/leverage (action "updateLeverage") */
export const perpsUpdateLeverage = (
  accountID: number,
  symbolID: number,
  leverage: number,
  marginMode: number,
) => ({ accountID, symbolID, leverage, marginMode });

/** perps/types.UpdateMarginRequest -> POST /api/v1/perps/trade/margin (action "updateMargin") */
export const perpsUpdateMargin = (accountID: number, symbolID: number, amount: string) => ({
  accountID,
  symbolID,
  amount: canonicalDecimal(amount),
});

// --- spot: batch actions ----------------------------------------------------

/** spot/types.BatchNewOrderItem */
export interface SpotOrderInput {
  symbolID: number;
  clOrdID: string;
  side: number;
  type: number;
  timeInForce: number;
  price?: string;
  quantity?: string;
  funds?: string;
}

/** spot/types.BatchNewOrderRequest -> POST /api/v1/spot/trade/orders/batch (action "batchNewOrder") */
export const spotBatchNewOrder = (accountID: number, orders: SpotOrderInput[]) => ({
  accountID,
  orders: orders.map((o) => ({
    symbolID: o.symbolID,
    clOrdID: assertClOrdID(o.clOrdID),
    side: o.side,
    type: o.type,
    timeInForce: o.timeInForce,
    price: dec(o.price),
    quantity: dec(o.quantity),
    funds: dec(o.funds),
  })),
});

/** spot/types.BatchCancelOrderRequest -> DELETE /api/v1/spot/trade/orders/batch */
export const spotBatchCancelOrder = (
  accountID: number,
  cancels: Array<{ symbolID: number; clOrdID: string; orderID?: number; origClOrdID?: string }>,
) => ({
  accountID,
  cancels: cancels.map((c) => ({
    symbolID: c.symbolID,
    clOrdID: assertClOrdID(c.clOrdID),
    orderID: c.orderID,
    origClOrdID: c.origClOrdID,
  })),
});

// --- shared actions ---------------------------------------------------------

/** common/types.ReplaceOrderRequest -> POST /trade/orders/replace (action "replaceOrder") */
export const replaceOrder = (
  accountID: number,
  orders: Array<{
    symbolID: number;
    clOrdID: string;
    origOrderID?: number;
    origClOrdID?: string;
    price?: string;
    quantity?: string;
  }>,
) => ({
  accountID,
  orders: orders.map((o) => ({
    symbolID: o.symbolID,
    clOrdID: assertClOrdID(o.clOrdID),
    origOrderID: o.origOrderID,
    origClOrdID: o.origClOrdID,
    price: dec(o.price),
    quantity: dec(o.quantity),
  })),
});

/** common/types.TransferAssetRequest -> POST /accounts/transfers (action "transferAsset") */
export const transferAsset = (i: {
  id: number;
  fromAccountID: number;
  toAccountID: number;
  coinID: number;
  amount: string;
  type: number;
}) => ({
  id: i.id,
  fromAccountID: i.fromAccountID,
  toAccountID: i.toAccountID,
  coinID: i.coinID,
  amount: canonicalDecimal(i.amount),
  type: i.type,
});

/** Magic account ID for cross-engine (spot <-> perps) transfers. */
export const CROSS_ENGINE_ACCOUNT_ID = 999;

/** common/types.ScheduleCancelRequest -> POST /trade/orders/schedule-cancel */
export const scheduleCancel = (accountID: number, scheduledTimestamp?: number) => ({
  accountID,
  scheduledTimestamp,
});

/** common/types.RevokeAPIKeyRequest (action "revokeAPIKey") */
export const revokeAPIKey = (accountID: number, name: string) => ({ accountID, name });

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
} as const;
