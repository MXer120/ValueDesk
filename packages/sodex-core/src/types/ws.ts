/**
 * SoDEX WebSocket v1 shapes (wss://mainnet-gw.sodex.dev/ws/{spot|perps}) and
 * the subscription-parameter rules Opentrade measured against the live gateway.
 *
 * Sources: the published schema (WebSocket Types), Opentrade
 * server/src/sodex/ws.ts (empirical channel matrix), and docs/research/01
 * (live observations of 2026-09-25). Keep-alive: send {"op":"ping"} at least
 * every 60 s - the server drops a silent connection after 60 s.
 *
 * Limits per IP (documented): 10 connections, 30 new connections/min, 1000
 * subscriptions, 10 unique users, 2000 msgs/min, 100 inflight. A `trade`
 * subscription with N symbols is acked (and counted) as N subscriptions.
 */
import type {
  Dec,
  MarginModeStr,
  OrderStatusStr,
  OrderTypeStr,
  PositionSideStr,
  SideStr,
  StateOrder,
  StatePerpsBalance,
  StatePosition,
  StateSpotBalance,
  StopTypeStr,
  TimeInForceStr,
  TriggerTypeStr,
} from './rest.ts';

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface WsPing {
  op: 'ping';
}
export interface WsPong {
  op: 'pong';
}
export interface WsErrorMessage {
  op: 'error';
  error: string;
  connID: string;
}

export interface WsSubscribeRequest {
  op: 'subscribe' | 'unsubscribe';
  id?: number | null;
  params: WsSubscriptionParams;
}

export interface WsSubscribeAck {
  op: 'subscribe' | 'unsubscribe';
  id: number | null;
  /**
   * NOTE [ot]: the gateway ECHOES a one-element `symbols:[X]` back as
   * `symbol:"X"`, which reads like confirmation of the singular form. It is not.
   */
  result: Record<string, unknown> | null;
  success: boolean;
  error: string | null;
  connID: string;
  time_in: number;
  time_out: number;
}

/** A data push. `type` is 'snapshot' for the first push of stateful channels, then 'update'. */
export interface WsPush<C extends string = string, D = unknown> {
  channel: C;
  type?: 'snapshot' | 'update' | (string & {});
  data: D;
}

// ---------------------------------------------------------------------------
// Subscription parameters
// ---------------------------------------------------------------------------

export type MarketChannel =
  | 'trade'
  | 'l2Book'
  | 'l4Book'
  | 'candle'
  | 'ticker'
  | 'allTicker'
  | 'miniTicker'
  | 'allMiniTicker'
  | 'bookTicker'
  | 'allBookTicker'
  | 'markPrice'
  | 'allMarkPrice'
  | 'coinPrice'
  | 'allCoinPrice';

/** Wallet-scoped channels. ANY address may be subscribed - no auth. [documented + live] */
export type AccountChannel = 'accountState' | 'accountUpdate' | 'accountOrderUpdate' | 'accountTrade' | 'accountEvent';

export type WsChannel = MarketChannel | AccountChannel;

export interface WsSubscriptionParams {
  channel: WsChannel | (string & {});
  symbol?: string;
  symbols?: string[];
  interval?: string;
  level?: number;
  user?: string;
  accountID?: number;
}

/**
 * How each channel wants its symbol(s) expressed.
 *
 * DETERMINED EMPIRICALLY against testnet-gw.sodex.dev (Opentrade), because the
 * published reference is wrong for two channels: it documents `trade` and
 * `markPrice` as taking `symbol`, but the gateway rejects that with "symbols
 * cannot be empty" and requires an array.
 *
 * Verified matrix (subscribe ack, one channel per connection):
 *   trade        symbol=ERR   symbols=OK    none=ERR
 *   l2Book       symbol=OK    symbols=ERR   none=ERR
 *   candle       symbol=OK    symbols=ERR   none=ERR
 *   ticker       symbol=ERR   symbols=OK    none=ERR
 *   bookTicker   symbol=ERR   symbols=OK    none=ERR
 *   markPrice    symbol=ERR   symbols=OK    none=ERR
 *   allTicker    symbol=OK    symbols=OK    none=OK
 *   allMarkPrice symbol=OK    symbols=OK    none=OK
 * (l4Book: `symbol`, per research 01 - it currently returns price levels only.)
 */
export const CHANNEL_PARAM_STYLE: Readonly<Record<string, 'symbol' | 'symbols' | 'none'>> = {
  trade: 'symbols',
  l2Book: 'symbol',
  l4Book: 'symbol',
  candle: 'symbol',
  ticker: 'symbols',
  miniTicker: 'symbols',
  bookTicker: 'symbols',
  markPrice: 'symbols',
  coinPrice: 'symbols',
  allTicker: 'none',
  allMiniTicker: 'none',
  allBookTicker: 'none',
  allMarkPrice: 'none',
  allCoinPrice: 'none',
};

export const ACCOUNT_CHANNELS: ReadonlySet<string> = new Set<AccountChannel>([
  'accountState',
  'accountUpdate',
  'accountOrderUpdate',
  'accountTrade',
  'accountEvent',
]);

/**
 * Rewrite caller-supplied params into the shape the gateway actually accepts,
 * so callers may pass either `symbol` or `symbols` for any channel.
 */
export function normaliseSubParams(p: WsSubscriptionParams): WsSubscriptionParams {
  if (ACCOUNT_CHANNELS.has(p.channel)) {
    const out: WsSubscriptionParams = { channel: p.channel, user: p.user };
    if (p.accountID !== undefined) out.accountID = p.accountID;
    return out;
  }
  const style = CHANNEL_PARAM_STYLE[p.channel] ?? 'symbol';
  const list = [p.symbol, ...(p.symbols ?? [])].filter((s): s is string => !!s);
  const out: WsSubscriptionParams = { channel: p.channel };
  if (style === 'symbols') out.symbols = [...new Set(list)];
  else if (style === 'symbol' && list[0]) out.symbol = list[0];
  if (p.interval) out.interval = p.interval;
  if (p.level !== undefined) out.level = p.level;
  return out;
}

/**
 * Stable identity for a subscription (refcounts, re-subscribes). Computed on the
 * NORMALISED params, so `{symbol:'X'}` and `{symbols:['X']}` share one key, and
 * address case never fragments an account subscription.
 */
export function subKey(raw: WsSubscriptionParams): string {
  const p = normaliseSubParams(raw);
  const parts: string[] = [p.channel];
  if (p.symbol) parts.push(`s=${p.symbol}`);
  if (p.symbols?.length) parts.push(`ss=${[...p.symbols].sort().join('|')}`);
  if (p.interval) parts.push(`i=${p.interval}`);
  if (p.level !== undefined) parts.push(`l=${p.level}`);
  if (p.user) parts.push(`u=${p.user.toLowerCase()}`);
  if (p.accountID !== undefined) parts.push(`a=${p.accountID}`);
  return parts.join(',');
}

// ---------------------------------------------------------------------------
// Market data payloads
// ---------------------------------------------------------------------------

/**
 * `trade` push entry. `bi`/`si` are the buyer/seller ACCOUNT IDS - the only
 * public source of fill attribution (REST prints omit them). `S` is the taker
 * side: 'BUY' means the buyer was the taker. `E - T` is the server push delay
 * (median 47 ms perps / 17 ms spot, measured). [schema][live]
 */
export interface WsTrade {
  E: number;
  T: number;
  t: number;
  s: string;
  S: SideStr;
  p: Dec;
  q: Dec;
  bi: number;
  si: number;
}

export interface WsTicker {
  s: string;
  c: Dec;
  Q: Dec;
  w: Dec;
  a: Dec;
  A: Dec;
  b: Dec;
  B: Dec;
  p: Dec;
  /** Percent. */
  P: number;
  o: Dec;
  h: Dec;
  l: Dec;
  v: Dec;
  q: Dec;
  O: number;
  C: number;
  E: number;
}

export interface WsMiniTicker {
  s: string;
  c: Dec;
  o: Dec;
  h: Dec;
  l: Dec;
  v: Dec;
  q: Dec;
  E: number;
}

export interface WsBookTicker {
  s: string;
  u: number;
  a: Dec;
  A: Dec;
  b: Dec;
  B: Dec;
  E: number;
}

/** Perps `markPrice`: mark `p`, index `i`, funding `r`, next funding `T`, OI `oi` (base). */
export interface WsMarkPrice {
  s: string;
  oi: Dec;
  p: Dec;
  i: Dec;
  r: Dec;
  T: string | number;
  E: number;
}

export interface WsCoinPrice {
  i: number;
  a: string;
  p: Dec;
  mr: Dec;
  E: number;
}

export interface WsDepthSnapshot {
  s: string;
  u: number;
  E: number;
  a: Array<[Dec, Dec]>;
  b: Array<[Dec, Dec]>;
}

export interface WsDepthUpdate {
  s: string;
  U: number;
  u: number;
  E: number;
  a: Array<[Dec, Dec]>;
  b: Array<[Dec, Dec]>;
}

export interface WsCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: Dec;
  c: Dec;
  h: Dec;
  l: Dec;
  v: Dec;
  q: Dec;
  n: number;
  x: boolean;
}

// ---------------------------------------------------------------------------
// Account payloads
// ---------------------------------------------------------------------------

export interface WsTwapOrder {
  s: string;
  i: number;
  S: SideStr;
  q: Dec;
  m: number;
  r: boolean;
  R: boolean;
  z: Dec;
  v: Dec;
  ct: number;
  nt: number;
  a: boolean;
}

/** `accountUpdate` (spot). Only CHANGED assets appear in `B`; values are new totals, not deltas. */
export interface WsSpotAccountUpdate {
  E: number;
  T: number;
  h: number;
  B: Array<{ i: number; a: string; t: Dec; l: Dec }>;
  TO: WsTwapOrder[];
}

/** `accountUpdate` (perps). Builder income shows here as `B[].wb` changes on the builder account. */
export interface WsPerpsAccountUpdate {
  E: number;
  T: number;
  h: number;
  B: Array<{ i: number; a: string; wb: Dec; co: Dec }>;
  P: Array<{ i: number; s: string; sz: Dec; ep: Dec; iw: Dec | null; ps: PositionSideStr }>;
  TO: WsTwapOrder[];
}

/** Order core shared by spot and perps order pushes. */
export interface WsOrder {
  s: string;
  c: string;
  i: number;
  S: SideStr;
  o: OrderTypeStr;
  f: TimeInForceStr;
  p: Dec;
  q: Dec;
  F: Dec | null;
  X: OrderStatusStr;
  z: Dec;
  v: Dec;
  M: Dec;
  /** Builder attached to this order: id `i`, fee `f` (tenths of a bp). */
  b?: { i: number; f: number };
  ct?: number;
  ut?: number;
}

export interface WsPerpsOrder extends WsOrder {
  ps: PositionSideStr;
  R: boolean;
  sp: Dec | null;
  st: StopTypeStr | null;
  tt: TriggerTypeStr | null;
  pid: number | null;
  poid: number | null;
  aoids: number[] | null;
}

interface WsExecution {
  E: number;
  T: number;
  t: number | null;
  l: Dec | null;
  L: Dec | null;
  n: Dec | null;
  m: boolean | null;
  /** Execution type: NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, MODIFIED, EXPIRED, REPLACED. */
  x: string;
  r: string | null;
}

/** `accountOrderUpdate` entries. Leader order ACCEPTANCE (x = NEW) is the earliest copy trigger. */
export type WsSpotOrderUpdate = WsOrder & WsExecution;
export type WsPerpsOrderUpdate = WsPerpsOrder & WsExecution;

/**
 * `accountTrade` (spot). `f` = fee, `bf` = builder fee on this fill (documented;
 * not yet observed on a live push). On REST the builder fee is PART of the fee
 * [live 2026-10-02]; `fillFeeParts` (builders.ts) reads either shape that way.
 */
export interface WsSpotUserTrade {
  E: number;
  T: number;
  t: number;
  s: string;
  i: number;
  c: string;
  S: SideStr;
  p: Dec;
  q: Dec;
  f: Dec;
  bf?: Dec;
  m: boolean;
}

/** `accountTrade` (perps). `d` is a display label: Long, Short, Close Long, Close Short, Long -> Short, Short -> Long. */
export interface WsPerpsUserTrade extends WsSpotUserTrade {
  d: string;
}

/** `accountState` (spot) - full frontend-state snapshot. */
export interface WsSpotState {
  user: string;
  aid: number;
  uid: number;
  B: StateSpotBalance[];
  O: StateOrder[];
  TO: WsTwapOrder[];
}

/** `accountState` (perps) - ~1 push per 1.2 s per user (measured). */
export interface WsPerpsState {
  user: string;
  aid: number;
  uid: number;
  av: Dec;
  am: Dec;
  ami: Dec;
  amw: Dec;
  im: Dec;
  cm: Dec;
  oim: Dec;
  ocm: Dec;
  B: StatePerpsBalance[];
  O: StateOrder[];
  P: StatePosition[];
  TO: WsTwapOrder[];
  S: Array<{ s: string; l: number; m: MarginModeStr }>;
}

/** `accountEvent` (perps only). Both the liquidator and the liquidated account receive it. */
export interface WsUserLiquidation {
  E: number;
  type: 'liquidation';
  lid: number;
  aid: number;
  av: Dec;
  mm: MarginModeStr;
  B: Array<{ i: number; a: string; wb: Dec; co: Dec }>;
  P: Array<{ s: string; ps: PositionSideStr; sz: Dec; mp: Dec; lp: Dec | null }>;
}
