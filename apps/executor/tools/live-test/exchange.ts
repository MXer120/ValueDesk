/**
 * The harness's own view of SoDEX: what the account says (positions, open
 * orders and stops, order history, fills with their fees, leverage, keys,
 * builder approvals) and the few writes the harness makes itself with a key
 * of its own: the leader's trades, the position a reduce-only scenario starts
 * from, and the cleanup. The executor never sees this key; the two never share
 * a nonce sequence.
 *
 * Every check of a live scenario reads SoDEX through here, never the
 * executor's own idea of what happened: the point of the suite is that the
 * exchange agrees.
 *
 * The master wallet's private key (from the env file) signs only two kinds of
 * thing, both what the web app asks a wallet to sign: an API key registration
 * (the executor's key, the harness's own key) and the builder-fee approval.
 *
 * WRITES. The engine's SoDEX client sends only what a copier sends (orders,
 * cancels, leverage: copy-engine sodex.ts ALLOWED_WRITES) and refuses the rest
 * before signing reaches the wire. The harness also registers keys, approves the
 * builder and moves a position's isolated margin (the liquidation scenarios), as
 * the web app does for its user: those go straight to SoDEX's gateway
 * (SodexReads.write), everything else through the engine's client and its queue.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  DAY_MS,
  GATEWAY_ORIGIN,
  MarginMode,
  OrderSide,
  OrderType,
  SODEX_CHAIN_ID,
  SodexApiError,
  TimeInForce,
  assembleExchangeRequests,
  assembleWalletSignedRequest,
  bytesToHex,
  createMemoryNonceManager,
  generateTradingKey,
  hexToBytes,
  nonceKey,
  parseEnvelope,
  perpsActions,
  prepareApiKeyRegistrationExchange,
  prepareBuilderFeeApproval,
  privateKeyToAddress,
  signAndBuildWithNonceManager,
  signingKeyFrom,
  unwrapList,
  failedOrders,
  type BuiltRequest,
  type NonceManager,
  type OrderResult,
  type SignableAction,
  type SigningKeyRef,
} from '../../../../packages/sodex-core/src/index.ts';
import { ALLOWED_WRITES, SodexClient, WeightBudget, floorQuantity, limitPrice, type FetchLike, type MarketInfo } from '../../../../packages/copy-engine/src/index.ts';
import type { FlattenVenue, VenueOrder } from './cleanup.ts';

export const CHAIN_ID = SODEX_CHAIN_ID.mainnet;

/** 65-byte (r, s, v=27/28) signature of a 32-byte digest, as a wallet returns it. */
export function walletSign(digestHex: string, pk: Uint8Array): string {
  const sig = secp256k1.sign(hexToBytes(digestHex), pk);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return bytesToHex(out);
}

/** An order as the checks need it (open, or from history). */
export interface OrderInfo {
  orderId: string;
  clOrdID: string | null;
  side: 'buy' | 'sell';
  price: number;
  qty: number;
  filled: number;
  tif: string;
  type: string;
  status: string;
  reduceOnly: boolean;
  stop: { kind: 'tp' | 'sl'; trigger: number } | null;
  builderFee: number | null;
  createdAt: number;
}

/** One fill of the account. */
export interface FillInfo {
  clOrdID: string | null;
  orderId: string;
  side: 'buy' | 'sell';
  price: number;
  qty: number;
  /** Everything charged (venue + builder), USD. */
  fee: number;
  builderFee: number;
  maker: boolean;
  time: number;
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};

function orderOf(r: Record<string, unknown>): OrderInfo {
  const stopType = String(r.stopType ?? r.st ?? '');
  const stopPrice = n(r.stopPrice ?? r.sp);
  const b = (r.builder ?? r.b) as { feeRate?: number; f?: number } | undefined;
  return {
    orderId: String(r.orderID ?? r.i ?? ''),
    clOrdID: typeof (r.clOrdID ?? r.c) === 'string' && (r.clOrdID ?? r.c) !== '' ? String(r.clOrdID ?? r.c) : null,
    side: String(r.side ?? r.S).toUpperCase() === 'SELL' ? 'sell' : 'buy',
    price: n(r.price ?? r.p),
    qty: n(r.origQty ?? r.q),
    filled: n(r.executedQty ?? r.z),
    tif: String(r.timeInForce ?? r.f ?? ''),
    type: String(r.type ?? r.o ?? ''),
    status: String(r.status ?? r.X ?? ''),
    reduceOnly: (r.reduceOnly ?? r.R) === true,
    stop: stopPrice > 0 && (stopType === 'TAKE_PROFIT' || stopType === 'STOP_LOSS') ? { kind: stopType === 'TAKE_PROFIT' ? 'tp' : 'sl', trigger: stopPrice } : null,
    builderFee: b ? n(b.feeRate ?? b.f) : null,
    createdAt: n(r.createdAt ?? r.ct),
  };
}

/** The harness's SoDEX reads for any address (no key needed). */
export class SodexReads {
  readonly client: SodexClient;
  private marketsCache: MarketInfo[] | null = null;

  constructor(private readonly fetch: FetchLike) {
    // A small share of SoDEX's per-IP budget: the executor on this machine needs the rest.
    this.client = new SodexClient({ network: 'mainnet', fetch, budget: new WeightBudget(300, 0.9) });
  }

  /**
   * One signed write. What a copier sends (orders, cancels, leverage) goes through the engine's
   * client and its queue; what only a wallet's owner sends (a key registration, the builder
   * approval, isolated margin) straight to the gateway: the engine's client refuses those by design.
   * SoDEX's refusal (an error envelope) throws, with its words.
   */
  async write<V = unknown>(req: Pick<BuiltRequest, 'method' | 'gatewayPath' | 'headers' | 'body'>): Promise<V> {
    if (ALLOWED_WRITES.some((w) => w.method === req.method && w.path === req.gatewayPath)) return this.client.send<V>(req);
    const res = await this.fetch(`${GATEWAY_ORIGIN.mainnet}${req.gatewayPath}`, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(15_000) });
    return parseEnvelope<V>(res.status, await res.text(), req.gatewayPath);
  }

  /**
   * A history read (order history, fills): SoDEX drip-limits these per IP and this machine's
   * executor reads them too, so a 429 waits and tries again instead of failing a check.
   */
  private async historyGet(path: string): Promise<unknown> {
    for (let i = 0; ; i++) {
      try {
        return await this.client.get<unknown>(path);
      } catch (e) {
        const limited = e instanceof SodexApiError && (e.httpStatus === 429 || e.code === 429 || /rate|too many/i.test(e.message));
        if (!limited || i >= 5) throw e;
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** i));
      }
    }
  }

  async markets(): Promise<MarketInfo[]> {
    this.marketsCache ??= await this.client.markets();
    return this.marketsCache;
  }

  async market(symbol: string): Promise<MarketInfo> {
    const m = (await this.markets()).find((x) => x.name === symbol);
    if (!m) throw new Error(`SoDEX lists no perps market ${symbol}`);
    return m;
  }

  /** The last `limit` one-minute candles: high, low, close. */
  async candles(symbol: string, limit = 30): Promise<Array<{ h: number; l: number; c: number }>> {
    const rows = await this.client.get<Array<{ h: string; l: string; c: string }>>(`/api/v1/perps/markets/${symbol}/klines?interval=1m&limit=${limit}`);
    return (rows ?? []).map((r) => ({ h: n(r.h), l: n(r.l), c: n(r.c) })).filter((r) => r.c > 0 && r.h >= r.l);
  }

  /** Best bid and ask, the mid, and the mark. */
  async quote(symbol: string): Promise<{ bid: number; ask: number; mid: number; mark: number }> {
    const rows = await this.client.get<Array<{ symbol: string; bidPx: string; askPx: string }>>('/api/v1/perps/markets/bookTickers');
    const r = (rows ?? []).find((x) => x.symbol === symbol);
    const marks = await this.client.markPrices();
    const mark = marks.find((x) => x.symbol === symbol)?.price ?? 0;
    const bid = n(r?.bidPx);
    const ask = n(r?.askPx);
    if (!(bid > 0 && ask > 0 && mark > 0)) throw new Error(`no quote for ${symbol}`);
    return { bid, ask, mid: (bid + ask) / 2, mark };
  }

  async accountId(address: string): Promise<number> {
    return this.client.accountId(address);
  }

  async state(address: string) {
    return this.client.perpsState(address);
  }

  async equity(address: string): Promise<{ equity: number; available: number }> {
    const st = await this.state(address);
    return { equity: n(st?.av), available: n(st?.am) };
  }

  async position(address: string, symbol: string): Promise<number> {
    const st = await this.state(address);
    if (!st) throw new Error('SoDEX returned no account state');
    let size = 0;
    for (const p of st.P ?? []) if (p.s === symbol) size += n(p.sz);
    return size;
  }

  /** Leverage and margin mode SoDEX has for the market on this account (null: never set). */
  async leverage(address: string, symbol: string): Promise<{ leverage: number; marginMode: 'cross' | 'isolated' } | null> {
    const st = await this.state(address);
    const p = (st?.P ?? []).find((x) => x.s === symbol && n(x.sz) !== 0);
    if (p && typeof p.l === 'number') return { leverage: p.l, marginMode: p.m === 'ISOLATED' ? 'isolated' : 'cross' };
    const s = (st?.S ?? []).find((x) => x.s === symbol);
    return s ? { leverage: s.l, marginMode: s.m === 'ISOLATED' ? 'isolated' : 'cross' } : null;
  }

  /**
   * The open position on the market as SoDEX's account state has it (perps /state P[]): size,
   * margin mode and leverage, its isolated margin (`iw`) and SoDEX's own liquidation price (`lp`).
   * Null: no position. A field SoDEX did not send is null.
   */
  async risk(address: string, symbol: string): Promise<{ size: number; entry: number; leverage: number | null; marginMode: 'cross' | 'isolated'; margin: number | null; liqPrice: number | null } | null> {
    const st = await this.state(address);
    if (!st) throw new Error('SoDEX returned no account state');
    const p = ((st.P ?? []) as unknown as Array<Record<string, unknown>>).find((x) => x.s === symbol && n(x.sz) !== 0);
    if (!p) return null;
    const opt = (v: unknown) => (v === undefined || v === null || v === '' ? null : n(v));
    const marginMode = p.m === 'ISOLATED' ? 'isolated' : 'cross';
    let margin = marginMode === 'isolated' ? opt(p.iw) : null;
    if (marginMode === 'isolated' && margin === null) {
      // Older answers leave `iw` out: the open position's initialMargin is its isolated margin (as the web's live checks read it).
      const rows = unwrapList<Record<string, unknown>>(await this.client.get<unknown>(`/api/v1/perps/accounts/${address.toLowerCase()}/positions`).catch(() => null), 'positions');
      margin = opt(rows.find((r) => r.symbol === symbol && n(r.size) !== 0)?.initialMargin);
    }
    return { size: n(p.sz), entry: n(p.ep), leverage: typeof p.l === 'number' ? p.l : null, marginMode, margin, liqPrice: opt(p.lp) };
  }

  /** The account's latest closed positions (perps positions/history; drip-limited): a takeover is `isTakenOver`. */
  async closedPositions(address: string, limit = 10): Promise<Array<{ symbol: string; isTakenOver: boolean; takeOverPrice: number; realizedPnL: number; updatedAt: number }>> {
    const data = await this.historyGet(`/api/v1/perps/accounts/${address.toLowerCase()}/positions/history?limit=${limit}`);
    return unwrapList<Record<string, unknown>>(data, 'positions').map((r) => ({
      symbol: String(r.symbol ?? ''),
      isTakenOver: r.isTakenOver === true,
      takeOverPrice: n(r.takeOverPrice),
      realizedPnL: n(r.realizedPnL),
      updatedAt: n(r.updatedAt),
    }));
  }

  /** Open orders on the market, stops included: the /orders list and the state's O[], merged. */
  async openOrders(address: string, symbol: string): Promise<OrderInfo[]> {
    const a = address.toLowerCase();
    const [listed, st] = await Promise.all([
      this.client.get<unknown>(`/api/v1/perps/accounts/${a}/orders?symbol=${encodeURIComponent(symbol)}`),
      this.state(a),
    ]);
    const out = new Map<string, OrderInfo>();
    for (const r of unwrapList<Record<string, unknown>>(listed, 'orders')) {
      if (String(r.symbol ?? symbol) !== symbol) continue;
      const o = orderOf(r);
      out.set(o.orderId, o);
    }
    for (const r of ((st as { O?: Array<Record<string, unknown>> } | null)?.O ?? [])) {
      if (r.s !== symbol) continue;
      const o = orderOf(r);
      if (!out.has(o.orderId)) out.set(o.orderId, o);
    }
    return [...out.values()].filter((o) => !/FILLED$|CANCELED|REJECTED|EXPIRED/.test(o.status) || o.status === 'PARTIALLY_FILLED');
  }

  /** Orders of the market since `since` (SoDEX's history: drip-limited, read sparingly). */
  async history(address: string, symbol: string, since: number): Promise<OrderInfo[]> {
    const data = await this.historyGet(`/api/v1/perps/accounts/${address.toLowerCase()}/orders/history?symbol=${encodeURIComponent(symbol)}&startTime=${since}&limit=100`);
    return unwrapList<Record<string, unknown>>(data, 'orders').map(orderOf).filter((o) => !o.createdAt || o.createdAt >= since - 5_000);
  }

  /** Fills of the market since `since`, with what SoDEX charged (fee includes the builder's share). */
  async fills(address: string, symbol: string, since: number): Promise<FillInfo[]> {
    const data = await this.historyGet(`/api/v1/perps/accounts/${address.toLowerCase()}/trades?symbol=${encodeURIComponent(symbol)}&startTime=${since}&limit=100`);
    return unwrapList<Record<string, unknown>>(data, 'trades')
      .filter((r) => !r.symbol || r.symbol === symbol)
      .map((r) => ({
        clOrdID: typeof r.clOrdID === 'string' && r.clOrdID ? r.clOrdID : null,
        orderId: String(r.orderID ?? ''),
        side: String(r.side).toUpperCase() === 'SELL' ? ('sell' as const) : ('buy' as const),
        price: n(r.price),
        qty: n(r.quantity),
        fee: n(r.fee),
        builderFee: n(r.builderFee),
        maker: r.isMaker === true,
        time: n(r.time),
      }))
      .filter((f) => f.time >= since - 1_000);
  }

  async apiKeys(address: string) {
    return this.client.apiKeys(address, 'perps');
  }

  async builderApproval(address: string, builderId: number): Promise<number | null> {
    return this.client.builderApproval(address, builderId);
  }
}

/**
 * One wallet the harness acts for: its master key (registrations and the fee
 * approval only) and, once registered, the harness's own API key on it.
 */
export class SodexWallet implements FlattenVenue {
  readonly address: string;
  private key: SigningKeyRef | null = null;
  private readonly nonces: NonceManager = createMemoryNonceManager();
  accountId = 0;

  constructor(
    readonly name: string,
    private readonly master: Uint8Array,
    readonly reads: SodexReads,
  ) {
    this.address = privateKeyToAddress(master).toLowerCase();
  }

  /** The SoDEX account id (0: SoDEX has never seen a deposit from this wallet). */
  async load(): Promise<number> {
    this.accountId = await this.reads.accountId(this.address);
    return this.accountId;
  }

  private async masterNonce(): Promise<bigint> {
    return this.nonces.next(nonceKey(this.address, CHAIN_ID));
  }

  /**
   * Register `publicKey` under `name` on this account's PERPS engine, valid
   * for `days` (what the web app's copy setup sends: the exchange route, one
   * signature by the master wallet). Registering a name that exists replaces it.
   */
  async registerKey(name: string, publicKey: string, days: number): Promise<{ expiresAt: number }> {
    if (!this.accountId) throw new Error(`${this.name}: this wallet has no SoDEX account yet (deposit first)`);
    const expiresAt = Date.now() + days * DAY_MS - 60_000;
    const prepared = prepareApiKeyRegistrationExchange({
      userAddress: this.address,
      accountID: this.accountId,
      name,
      publicKey,
      expiresAt,
      nonce: await this.masterNonce(),
      sodexChainId: CHAIN_ID,
      signatureChainId: CHAIN_ID,
      engines: ['perps'],
      expiryPolicy: { maxTtlMs: Math.max(days, 1) * DAY_MS + DAY_MS },
    });
    const [req] = assembleExchangeRequests(prepared, walletSign(prepared.digest, this.master), { base: '' });
    await this.reads.write({ method: req!.method, gatewayPath: req!.gatewayPath, headers: req!.headers, body: req!.body });
    return { expiresAt };
  }

  /** Make and register the harness's own key on this account (one day), and use it from now on. */
  async ownKey(name: string): Promise<string> {
    const k = generateTradingKey();
    const { expiresAt } = await this.registerKey(name, k.address, 1);
    // SoDEX lists a new key within a moment; signing before that is refused.
    for (let i = 0; i < 20; i++) {
      const rows = await this.reads.apiKeys(this.address).catch(() => []);
      if (rows.some((r) => r.name === name && r.publicKey.toLowerCase() === k.address.toLowerCase())) break;
      await new Promise((r) => setTimeout(r, 750));
    }
    this.key = signingKeyFrom(k, { name, expiresAt });
    return k.address;
  }

  /** Approve the builder's fee ceiling (tenths of a bp) on this account, then wait until SoDEX lists it. */
  async approveBuilder(builderId: number, maxFeeRate: number): Promise<number | null> {
    const prepared = prepareBuilderFeeApproval({
      userAddress: this.address,
      accountID: this.accountId,
      builderID: builderId,
      maxFeeRate,
      nonce: await this.masterNonce(),
      sodexChainId: CHAIN_ID,
      signatureChainId: CHAIN_ID,
    });
    const req = assembleWalletSignedRequest(prepared, walletSign(prepared.digest, this.master), { base: '' });
    await this.reads.write({ method: req.method, gatewayPath: req.gatewayPath, headers: req.headers, body: req.body });
    let seen: number | null = null;
    for (const wait of [0, 500, 1_000, 2_000, 3_000, 5_000, 8_000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      seen = await this.reads.builderApproval(this.address, builderId).catch(() => null);
      if (seen !== null && seen >= maxFeeRate) break;
    }
    return seen;
  }

  private async send(action: SignableAction): Promise<unknown> {
    if (!this.key) throw new Error(`${this.name}: the harness key is not registered yet`);
    const req = await signAndBuildWithNonceManager(action, this.key, { chainId: CHAIN_ID, nonces: this.nonces, base: '' });
    return this.reads.write(req);
  }

  /**
   * The market's leverage and margin mode on this account (updateLeverage), as the trader sets it
   * on sodex.com - also on an open position, where SoDEX allows it (a margin mode never changes
   * under an open position). SoDEX's refusal throws.
   */
  async setLeverage(symbol: string, leverage: number, mode: 'cross' | 'isolated'): Promise<void> {
    const m = await this.reads.market(symbol);
    await this.send(perpsActions.updateLeverage(this.accountId, m.id, leverage, mode === 'isolated' ? MarginMode.ISOLATED : MarginMode.CROSS));
  }

  /** Add (positive) or take out (negative) isolated margin on the open position, USDC (updateMargin). SoDEX's refusal throws. */
  async moveMargin(symbol: string, amount: string): Promise<void> {
    const m = await this.reads.market(symbol);
    await this.send(perpsActions.updateMargin(this.accountId, m.id, amount));
  }

  /**
   * One IOC limit: `qty` (base units, signed by side) at the touch moved by
   * `slipBps` against us, inside SoDEX's band. Returns SoDEX's answer row
   * (an error row is thrown).
   */
  async ioc(symbol: string, side: 'buy' | 'sell', qty: number, o: { reduceOnly?: boolean; slipBps?: number; tag?: string } = {}): Promise<{ clOrdID: string; quantity: string }> {
    const m = await this.reads.market(symbol);
    const q = await this.reads.quote(symbol);
    const quantity = floorQuantity(qty, m);
    if (quantity === '0') throw new Error(`${this.name}: ${qty} ${symbol} is below one step`);
    const price = limitPrice(side, side === 'buy' ? q.ask : q.bid, o.slipBps ?? 30, m, q.mark);
    const clOrdID = `lt-${(o.tag ?? 'x').slice(0, 6)}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const data = await this.send(
      perpsActions.newOrder(this.accountId, m.id, [
        { clOrdID, side: side === 'buy' ? OrderSide.BUY : OrderSide.SELL, type: OrderType.LIMIT, timeInForce: TimeInForce.IOC, price, quantity, reduceOnly: o.reduceOnly ?? false },
      ]),
    );
    const rows = Array.isArray(data) ? (data as OrderResult[]) : unwrapList<OrderResult>(data, 'orders');
    const bad = failedOrders(rows)[0];
    if (bad) throw new Error(`${this.name}: SoDEX refused the ${side} of ${quantity} ${symbol}: ${bad.error || `code ${bad.code}`}`);
    return { clOrdID, quantity };
  }

  /** IOC worth `usd` at the touch (at least SoDEX's minimum order value). */
  async iocUsd(symbol: string, side: 'buy' | 'sell', usd: number, o: { tag?: string } = {}): Promise<{ clOrdID: string; quantity: string }> {
    const q = await this.reads.quote(symbol);
    const m = await this.reads.market(symbol);
    const px = side === 'buy' ? q.ask : q.bid;
    const step = Number(m.stepSize);
    const qty = Math.ceil(Math.max(usd, m.minNotional * 1.05) / px / step) * step;
    return this.ioc(symbol, side, qty, o);
  }

  /* --------------------------------------------- FlattenVenue (cleanup) ----- */

  async openOrders(symbol: string): Promise<VenueOrder[]> {
    return (await this.reads.openOrders(this.address, symbol)).map((o) => ({ orderId: o.orderId, clOrdID: o.clOrdID, stop: o.stop !== null }));
  }

  async position(symbol: string): Promise<number> {
    return this.reads.position(this.address, symbol);
  }

  async cancel(symbol: string, orders: VenueOrder[]): Promise<void> {
    const m = await this.reads.market(symbol);
    for (let i = 0; i < orders.length; i += 50) {
      const part = orders.slice(i, i + 50).filter((o) => /^\d+$/.test(o.orderId));
      if (!part.length) continue;
      await this.send(perpsActions.cancelOrder(this.accountId, part.map((o) => ({ symbolID: m.id, orderID: BigInt(o.orderId) })))).catch((e) => {
        // An order that filled or was cancelled meanwhile is not an error; the next read says.
        if (!/not found|unknown order|does not exist|already/i.test(String(e))) throw e;
      });
    }
  }

  async close(symbol: string, size: number): Promise<void> {
    if (!size) return;
    await this.ioc(symbol, size > 0 ? 'sell' : 'buy', Math.abs(size), { reduceOnly: true, slipBps: 100, tag: 'close' });
  }
}
