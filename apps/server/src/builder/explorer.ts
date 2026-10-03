/**
 * An order's signed request, read from SoDEX's public explorer - pure parsing
 * and signer recovery; the request itself is made by the verifier.
 *
 *   GET https://clobscan-mainnet.sodex.dev/api/v1/{spot|perps}/transaction?account_id=<id>&order_id=<id>
 *   -> { code: 0, data: { tx_hash, ts_ms, account_id, cl_ord_ids, order_ids, action, status,
 *                         tx_json: "{ nonce, payload, signature, type }" } }
 *
 * `payload` is what the client sent as the request body: for an order, the
 * builder it names (`builder: { id, fee }`, on perps also per order) - which
 * the gateway's own order history does not return. `signature` is the API
 * key's signature over it (0x01 || r || s || v), so the key that sent the
 * order can be recovered and compared with the keys the wallet lists.
 *
 * RECOVERY. The key signed EIP-712 `ExchangeAction(payloadHash, nonce)` in the
 * engine's domain (`spot` / `futures`), where payloadHash is keccak256 of the
 * JSON `{type, params}` in the request structs' field order. The explorer
 * returns `payload` with its keys SORTED, so the order is rebuilt here from
 * the field names. Checked against real orders of both engines (test/
 * builderExplorer.fixture.json): each recovers a key its account lists.
 * A request with a field this file does not know hashes differently and
 * recovers a stranger - which matches no recorded key, so the only possible
 * error is a missed detection, never a wrong one.
 *
 * Read on mainnet 2026-10-02. A lookup for an account with millions of orders
 * (a market maker) answered 503 "Request Timeout" after 30 s.
 */
import { DomainName, actionPayloadHash, eip712Digest, exchangeActionStructHash, hexToBytes, makeDomain, recoverAddress } from '../signing/eip712.js';
import type { Engine } from './config.js';
import type { OrderFacts } from './counting.js';

export const EXPLORER_BASE: Readonly<Record<'mainnet' | 'testnet', string>> = {
  mainnet: 'https://clobscan-mainnet.sodex.dev',
  /** Not observed: named after the mainnet host. VALUESCAN_BUILDER_EXPLORER overrides both. */
  testnet: 'https://clobscan-testnet.sodex.dev',
};

/** The path of one order's request. Ids are digits only, so nothing needs escaping. */
export function explorerPath(engine: Engine, accountId: number, orderId: string): string {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new RangeError('explorer: account id must be a positive whole number');
  if (!/^\d{1,20}$/.test(orderId)) throw new RangeError('explorer: order id must be digits');
  return `/api/v1/${engine}/transaction?account_id=${accountId}&order_id=${orderId}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ExplorerTx {
  txHash: string | null;
  /** When SoDEX took the request: the time its orders were created. */
  tsMs: number;
  type: string;
  nonce: number;
  signature: string;
  payload: Record<string, unknown>;
  /** The orders the request created, in the order of `payload.orders`. */
  orderIds: string[];
}

/**
 * The body of an explorer answer as a transaction; null when it holds none
 * (an order the explorer does not know, or an answer of another shape).
 */
export function readExplorerTx(body: unknown): ExplorerTx | null {
  if (!isObject(body) || body.code !== 0 || !isObject(body.data)) return null;
  const d = body.data;
  if (typeof d.tx_json !== 'string' || d.tx_json.length > 262_144) return null;
  let tj: unknown;
  try {
    tj = JSON.parse(d.tx_json);
  } catch {
    return null;
  }
  if (!isObject(tj) || !isObject(tj.payload)) return null;
  const tsMs = typeof d.ts_ms === 'number' && Number.isSafeInteger(d.ts_ms) && d.ts_ms > 0 ? d.ts_ms : null;
  const nonce = typeof tj.nonce === 'number' && Number.isSafeInteger(tj.nonce) && tj.nonce >= 0 ? tj.nonce : null;
  const type = typeof tj.type === 'string' ? tj.type : typeof d.action === 'string' ? d.action : null;
  const signature = typeof tj.signature === 'string' && /^0x[0-9a-fA-F]{132}$/.test(tj.signature) ? tj.signature : null;
  if (tsMs === null || nonce === null || !type || !signature) return null;
  const orderIds = Array.isArray(d.order_ids) ? d.order_ids.map((v) => (typeof v === 'number' || typeof v === 'string' ? String(v) : '')) : [];
  return {
    txHash: typeof d.tx_hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(d.tx_hash) ? d.tx_hash.toLowerCase() : null,
    tsMs,
    type,
    nonce,
    signature,
    payload: tj.payload,
    orderIds,
  };
}

/** `{ id, fee }` as the request structs order it; undefined when the request names none. */
const builderOf = (v: unknown): { id: unknown; fee: unknown } | undefined => (isObject(v) ? { id: v.id, fee: v.fee } : undefined);

/** The action that creates orders on each engine. Others (replace, modify, TWAP) carry no builder. */
const NEW_ORDER: Readonly<Record<Engine, string>> = { perps: 'newOrder', spot: 'batchNewOrder' };

/**
 * The request body in the field order it was signed in (the reference SDK's
 * structs: signing/actions.ts). Null for an action this file cannot rebuild.
 */
export function signedParams(engine: Engine, type: string, p: Record<string, unknown>): unknown | null {
  if (type !== NEW_ORDER[engine] || !Array.isArray(p.orders)) return null;
  const orders = p.orders.filter(isObject);
  if (orders.length !== p.orders.length) return null;
  if (engine === 'perps') {
    return {
      accountID: p.accountID,
      symbolID: p.symbolID,
      orders: orders.map((o) => ({
        clOrdID: o.clOrdID,
        modifier: o.modifier,
        side: o.side,
        type: o.type,
        timeInForce: o.timeInForce,
        price: o.price,
        quantity: o.quantity,
        funds: o.funds,
        stopPrice: o.stopPrice,
        stopType: o.stopType,
        triggerType: o.triggerType,
        reduceOnly: o.reduceOnly,
        positionSide: o.positionSide,
        builder: builderOf(o.builder),
      })),
      builder: builderOf(p.builder),
    };
  }
  return {
    accountID: p.accountID,
    orders: orders.map((o) => ({
      symbolID: o.symbolID,
      clOrdID: o.clOrdID,
      side: o.side,
      type: o.type,
      timeInForce: o.timeInForce,
      price: o.price,
      quantity: o.quantity,
      funds: o.funds,
    })),
    builder: builderOf(p.builder),
  };
}

/** The address of the key that signed the request, lower case; null when it cannot be worked out. */
export function recoverSigner(tx: ExplorerTx, engine: Engine, chainId: number): string | null {
  try {
    const params = signedParams(engine, tx.type, tx.payload);
    if (params === null) return null;
    const sig = hexToBytes(tx.signature);
    // 0x01: an exchange action signed by an API key. Anything else is not an order of this kind.
    if (sig.length !== 66 || sig[0] !== 1) return null;
    const structHash = exchangeActionStructHash(actionPayloadHash(tx.type, params), BigInt(tx.nonce));
    const digest = eip712Digest(makeDomain(engine === 'spot' ? DomainName.spot : DomainName.perps, chainId), structHash);
    return recoverAddress(digest, sig.slice(1)).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The builder one order of the request names: its own (perps allows one per
 * order), else the request's. `null` = it names none; `undefined` = it cannot
 * be told, and then nothing is concluded from the request.
 */
function builderFor(tx: ExplorerTx, orderId: string): { id: string; fee: number } | null | undefined {
  const orders = Array.isArray(tx.payload.orders) ? tx.payload.orders.filter(isObject) : [];
  const at = tx.orderIds.indexOf(orderId);
  let own: { id: unknown; fee: unknown } | undefined;
  if (at >= 0 && tx.orderIds.length === orders.length) own = builderOf(orders[at]!.builder);
  else if (orders.length === 1) own = builderOf(orders[0]!.builder);
  // Several orders and no way to say which is this one: only a builder named for all of them is certain.
  else if (orders.some((o) => o.builder !== undefined)) return undefined;
  const b = own ?? builderOf(tx.payload.builder);
  if (!b) return tx.payload.builder === undefined || tx.payload.builder === null ? null : undefined;
  const id = typeof b.id === 'number' && Number.isSafeInteger(b.id) && b.id > 0 ? String(b.id) : typeof b.id === 'string' && /^\d{1,20}$/.test(b.id) ? b.id : null;
  const fee = typeof b.fee === 'number' && Number.isSafeInteger(b.fee) && b.fee >= 0 ? b.fee : null;
  return id !== null && fee !== null ? { id, fee } : undefined;
}

/**
 * What the request says about one order. Null when it says nothing certain:
 * it is not the request that created the order (a replace or a modify), it
 * names other orders, or its builder cannot be read.
 */
export function orderFacts(tx: ExplorerTx, engine: Engine, orderId: string, chainId: number): OrderFacts | null {
  if (tx.type !== NEW_ORDER[engine]) return null;
  if (tx.orderIds.length && !tx.orderIds.includes(orderId)) return null;
  const builder = builderFor(tx, orderId);
  if (builder === undefined) return null;
  return { createdAt: tx.tsMs, builder, signer: recoverSigner(tx, engine, chainId), txHash: tx.txHash };
}
