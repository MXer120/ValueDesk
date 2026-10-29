/**
 * The harness's own Hyperliquid client, for a leader wallet on Hyperliquid
 * (LIVE_LEADER_VENUE=hyperliquid, leader.ts): the few reads the checks and the
 * cleanup need, and the few writes the harness makes with the leader's own
 * master key - an IOC (reduce-only for a close), a cancel, a leverage change.
 * Nothing else can be signed here: `guardAction` refuses every other action
 * before it is signed (no withdrawal, no transfer, no agent, no vault).
 *
 * SIGNING (Hyperliquid's "L1 action" scheme, as the official Python SDK builds
 * it, hyperliquid/utils/signing.py):
 *
 *   connectionId = keccak256(msgpack(action) || nonce as 8 bytes big-endian || 0x00)
 *                  (0x00: no vault address; nothing follows: no expiresAfter)
 *   digest       = EIP-712 Agent(string source, bytes32 connectionId), source 'a' (mainnet),
 *                  domain { name 'Exchange', version '1', chainId 1337, verifyingContract 0x0 }
 *
 * and the nonce is the time in ms. The server rebuilds the msgpack bytes from
 * the action it receives, in its own field order, so every action here is
 * built with its keys in exactly the order the Python SDK builds them; JSON
 * and msgpack then carry the same object. Prices and sizes are strings (the
 * SDK's float_to_wire: no trailing zeros), never floats.
 *
 * RULES (Hyperliquid's docs, "Tick and lot size"): a perps asset is its index
 * in meta.universe; a size has at most szDecimals decimals (floored here); a
 * price at most 5 significant figures and at most 6 - szDecimals decimals
 * (integers are always allowed). The minimum order value is $10.
 */
import { EIP712_DOMAIN_FIELDS, ZERO_ADDRESS, bytesToHex, concat, hashTypedData, keccak256, privateKeyToAddress, utf8, type TypedData } from '../../../../packages/sodex-core/src/index.ts';
import { HL_INFO_URL, type FetchLike } from '../../../../packages/copy-engine/src/index.ts';
import { walletSign, type FillInfo } from './exchange.ts';
import type { VenueOrder } from './cleanup.ts';

export const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
/** Hyperliquid's perps taker fee at its base tier (0.045%), what a fresh leader wallet pays. */
export const HL_TAKER_FEE = 0.00045;
/** Hyperliquid's minimum order value, USD. */
export const HL_MIN_ORDER_USD = 10;
/** Perps prices: at most this many decimals, less the coin's szDecimals. */
const PERP_MAX_DECIMALS = 6;

/** The Hyperliquid coin of a SoDEX market: 'BTC-USD' -> 'BTC'. */
export const hlCoinOf = (sodexSymbol: string): string => sodexSymbol.replace(/-USD$/i, '');
/** The SoDEX market of a Hyperliquid coin: 'BTC' -> 'BTC-USD'. */
export const sodexSymbolOf = (coin: string): string => `${coin}-USD`;

/* ---------------------------------------------------------------- msgpack ----- */

/**
 * MessagePack of the values a Hyperliquid action holds, byte for byte what
 * Python's msgpack.packb gives for the same dict: maps with string keys in
 * insertion order, strings (fixstr / str8 / str16 / str32), integers in the
 * smallest format (fixint, uint8..uint64, negative fixint, int8..int64),
 * booleans, arrays and null. A float is refused: an action carries prices and
 * sizes as strings, and a number with a fraction here is a bug.
 */
export function msgpack(value: unknown): Uint8Array {
  const out: number[] = [];
  const be = (v: bigint, bytes: number) => {
    for (let i = bytes - 1; i >= 0; i--) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  };
  const int = (v: bigint, where: string) => {
    if (v >= 0n) {
      if (v < 0x80n) out.push(Number(v));
      else if (v <= 0xffn) out.push(0xcc, Number(v));
      else if (v <= 0xffffn) (out.push(0xcd), be(v, 2));
      else if (v <= 0xffffffffn) (out.push(0xce), be(v, 4));
      else if (v <= 0xffffffffffffffffn) (out.push(0xcf), be(v, 8));
      else throw new Error(`${where}: ${v} does not fit in 64 bits`);
    } else {
      if (v >= -32n) out.push(Number(v + 256n));
      else if (v >= -0x80n) out.push(0xd0, Number(v + 256n));
      else if (v >= -0x8000n) (out.push(0xd1), be(BigInt.asUintN(16, v), 2));
      else if (v >= -0x80000000n) (out.push(0xd2), be(BigInt.asUintN(32, v), 4));
      else if (v >= -0x8000000000000000n) (out.push(0xd3), be(BigInt.asUintN(64, v), 8));
      else throw new Error(`${where}: ${v} does not fit in 64 bits`);
    }
  };
  const len = (n: number, fix: number, fixMax: number, f16: number, f32: number, f8?: number) => {
    if (n <= fixMax) out.push(fix | n);
    else if (f8 !== undefined && n <= 0xff) out.push(f8, n);
    else if (n <= 0xffff) (out.push(f16), be(BigInt(n), 2));
    else (out.push(f32), be(BigInt(n), 4));
  };
  const put = (v: unknown, where: string): void => {
    if (v === null) return void out.push(0xc0);
    if (v === false) return void out.push(0xc2);
    if (v === true) return void out.push(0xc3);
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new Error(`${where}: ${v} is not a whole number (prices and sizes go as strings)`);
      return int(BigInt(v), where);
    }
    if (typeof v === 'bigint') return int(v, where);
    if (typeof v === 'string') {
      const b = utf8(v);
      len(b.length, 0xa0, 31, 0xda, 0xdb, 0xd9);
      for (const x of b) out.push(x);
      return;
    }
    if (Array.isArray(v)) {
      len(v.length, 0x90, 15, 0xdc, 0xdd);
      v.forEach((x, i) => put(x, `${where}[${i}]`));
      return;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      len(entries.length, 0x80, 15, 0xde, 0xdf);
      for (const [k, x] of entries) {
        // A JS object puts integer-like keys first, whatever order they were added in: the bytes would not be the SDK's.
        if (/^(0|[1-9]\d*)$/.test(k)) throw new Error(`${where}: the key "${k}" would lose its place in a JS object`);
        if (x === undefined) throw new Error(`${where}.${k} is undefined (JSON would drop it, msgpack would not)`);
        put(k, where);
        put(x, `${where}.${k}`);
      }
      return;
    }
    throw new Error(`${where}: cannot encode a ${typeof v}`);
  };
  put(value, 'action');
  return Uint8Array.from(out);
}

/* ---------------------------------------------------------------- signing ----- */

/** The 8 bytes of a nonce, big-endian. */
function u64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`a nonce must be a whole number of ms, got ${n}`);
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** connectionId of an L1 action: keccak256(msgpack(action) || nonce || 0x00). No vault, no expiresAfter. */
export function actionHash(action: unknown, nonce: number): Uint8Array {
  return keccak256(concat(msgpack(action), u64(nonce), Uint8Array.of(0)));
}

/** The typed data the leader's key signs: Agent(source, connectionId) in Hyperliquid's 'Exchange' domain. */
export function agentTypedData(connectionId: Uint8Array, source: 'a' | 'b' = 'a'): TypedData {
  return {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_ADDRESS },
    types: {
      EIP712Domain: EIP712_DOMAIN_FIELDS,
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source, connectionId: bytesToHex(connectionId) },
  };
}

/** The EIP-712 digest of an L1 action on mainnet (source 'a'; 'b' is testnet's). */
export const l1Digest = (action: unknown, nonce: number, source: 'a' | 'b' = 'a'): Uint8Array => hashTypedData(agentTypedData(actionHash(action, nonce), source));

export interface HlSignature {
  r: string;
  s: string;
  v: number;
}

/** The signature Hyperliquid takes: r and s as 0x-hex, v 27 or 28 (exchange.ts walletSign, split). */
export function signL1Action(action: unknown, nonce: number, pk: Uint8Array): HlSignature {
  const rsv = walletSign(bytesToHex(l1Digest(action, nonce)), pk).slice(2);
  return { r: `0x${rsv.slice(0, 64)}`, s: `0x${rsv.slice(64, 128)}`, v: Number.parseInt(rsv.slice(128, 130), 16) };
}

/* ------------------------------------------------------------------ guard ----- */

export type HlOrderWire = { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: 'Ioc' } } };
export type HlAction =
  | { type: 'order'; orders: HlOrderWire[]; grouping: 'na' }
  | { type: 'cancel'; cancels: Array<{ a: number; o: number }> }
  | { type: 'updateLeverage'; asset: number; isCross: boolean; leverage: number };

/** What the leader's master key may sign here: an IOC, a cancel, a leverage change. Nothing else. */
export const HL_ALLOWED_ACTIONS: readonly string[] = ['order', 'cancel', 'updateLeverage'];

const DECIMAL = /^(0|[1-9]\d*)(\.\d*[1-9])?$/;
/** A perps asset of Hyperliquid's own dex: spot assets are 10000 and up, other dexes' far higher. */
const perpAsset = (a: unknown): boolean => Number.isSafeInteger(a) && (a as number) >= 0 && (a as number) < 10_000;
const keysAre = (o: unknown, keys: readonly string[]): boolean =>
  !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).join(',') === keys.join(',');

/**
 * Refuses (throws) anything but the three actions this harness sends, in
 * exactly the shape it builds them: an order is IOC limits only (no trigger, no
 * builder, no other grouping), on perps of Hyperliquid's own dex, with decimal
 * strings for price and size; a cancel names assets and order ids; a leverage
 * change one asset. It runs before every signature.
 */
export function guardAction(action: unknown): asserts action is HlAction {
  const type = (action as { type?: unknown } | null)?.type;
  const no = (why: string): never => {
    throw new Error(`refusing to sign a Hyperliquid ${typeof type === 'string' ? `"${type}"` : 'action'}: ${why}`);
  };
  if (typeof type !== 'string' || !HL_ALLOWED_ACTIONS.includes(type)) no(`only ${HL_ALLOWED_ACTIONS.join(', ')} are signed here`);
  if (type === 'order') {
    const a = action as Record<string, unknown>;
    if (!keysAre(a, ['type', 'orders', 'grouping']) || a.grouping !== 'na') no('an order action is { type, orders, grouping: "na" } and nothing else');
    const orders = a.orders;
    if (!Array.isArray(orders) || !orders.length || orders.length > 10) no('one to ten orders');
    for (const o of orders as unknown[]) {
      const w = o as Record<string, unknown>;
      if (!keysAre(w, ['a', 'b', 'p', 's', 'r', 't'])) no('an order is { a, b, p, s, r, t }');
      if (!perpAsset(w.a) || typeof w.b !== 'boolean' || typeof w.r !== 'boolean') no('a perps asset, a side and reduce-only');
      if (typeof w.p !== 'string' || !DECIMAL.test(w.p) || typeof w.s !== 'string' || !DECIMAL.test(w.s) || Number(w.s) <= 0 || Number(w.p) <= 0) no('a price and a size as decimal strings');
      const t = w.t as { limit?: unknown } | undefined;
      if (!keysAre(t, ['limit']) || !keysAre(t!.limit, ['tif']) || (t!.limit as { tif: unknown }).tif !== 'Ioc') no('IOC limit orders only');
    }
    return;
  }
  if (type === 'cancel') {
    const a = action as Record<string, unknown>;
    if (!keysAre(a, ['type', 'cancels']) || !Array.isArray(a.cancels) || !a.cancels.length) no('a cancel action is { type, cancels }');
    for (const c of a.cancels as unknown[]) {
      const x = c as Record<string, unknown>;
      if (!keysAre(x, ['a', 'o']) || !perpAsset(x.a) || !Number.isSafeInteger(x.o) || (x.o as number) < 0) no('a cancel is { a, o } of a perps order');
    }
    return;
  }
  const a = action as Record<string, unknown>;
  if (!keysAre(a, ['type', 'asset', 'isCross', 'leverage']) || !perpAsset(a.asset) || typeof a.isCross !== 'boolean' || !Number.isSafeInteger(a.leverage) || (a.leverage as number) < 1 || (a.leverage as number) > 50) {
    no('a leverage change is { type, asset, isCross, leverage } of one perps asset, 1x to 50x');
  }
}

/* ---------------------------------------------------------------- rounding ----- */

const trimZeros = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

/** A size on the coin's grid: floored to szDecimals, as a string without trailing zeros ('0' when under one step). */
export function hlSize(size: number, szDecimals: number): string {
  if (!Number.isFinite(size) || size < 0) throw new Error(`not a size: ${size}`);
  // Through 12 significant digits first, so binary noise (0.00015 * 1e5 = 14.999...) cannot drop a step.
  const steps = Math.floor(Number((size * 10 ** szDecimals).toPrecision(12)));
  return trimZeros((steps / 10 ** szDecimals).toFixed(szDecimals));
}

/** A perps price: 5 significant figures, at most 6 - szDecimals decimals, without trailing zeros (the SDK's rounding). */
export function hlPrice(price: number, szDecimals: number): string {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`not a price: ${price}`);
  const decimals = Math.max(0, PERP_MAX_DECIMALS - szDecimals);
  return trimZeros(Number(price.toPrecision(5)).toFixed(decimals));
}

/* ------------------------------------------------------------------ reads ----- */

export interface HlAsset {
  name: string;
  /** Its index in meta.universe: the `a` of an order. */
  index: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  isDelisted: boolean;
}

export interface HlState {
  /** The perps account value, USD (marginSummary.accountValue). */
  accountValue: number;
  /** Coin -> signed size. */
  positions: Record<string, number>;
}

const num = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};

/** Hyperliquid's public info endpoint: no key. */
export class HyperliquidInfo {
  private metaCache: HlAsset[] | null = null;

  constructor(
    private readonly fetch: FetchLike,
    readonly url: string = HL_INFO_URL,
  ) {}

  async post<T>(body: Record<string, unknown>): Promise<T> {
    for (let i = 0; ; i++) {
      let res: Response;
      try {
        res = (await this.fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })) as Response;
      } catch (e) {
        if (i >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1_000 * (i + 1)));
        continue;
      }
      // A busy or limiting Hyperliquid waits and tries again; anything else is the answer.
      if ((res.status === 429 || res.status >= 500) && i < 3) {
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** i));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`Hyperliquid info ${String(body.type)}: HTTP ${res.status} ${text.slice(0, 160)}`);
      return JSON.parse(text) as T;
    }
  }

  /** The perps universe (meta), read once. */
  async assets(): Promise<HlAsset[]> {
    if (!this.metaCache) {
      const m = await this.post<{ universe?: Array<Record<string, unknown>> }>({ type: 'meta' });
      this.metaCache = (m.universe ?? []).map((u, index) => ({
        name: String(u.name ?? ''),
        index,
        szDecimals: num(u.szDecimals),
        maxLeverage: Math.max(1, num(u.maxLeverage)),
        onlyIsolated: u.onlyIsolated === true,
        isDelisted: u.isDelisted === true,
      }));
    }
    return this.metaCache;
  }

  async asset(coin: string): Promise<HlAsset> {
    const a = (await this.assets()).find((x) => x.name === coin);
    if (!a) throw new Error(`Hyperliquid lists no perps coin ${coin}`);
    return a;
  }

  /** The universe with each coin's 24 h volume (metaAndAssetCtxs), for picking a liquid coin. */
  async volumes(): Promise<Array<HlAsset & { dayNtlVlm: number; markPx: number }>> {
    const [meta, ctxs] = await this.post<[{ universe?: Array<Record<string, unknown>> }, Array<Record<string, unknown>>]>({ type: 'metaAndAssetCtxs' });
    return (meta?.universe ?? []).map((u, index) => ({
      name: String(u.name ?? ''),
      index,
      szDecimals: num(u.szDecimals),
      maxLeverage: Math.max(1, num(u.maxLeverage)),
      onlyIsolated: u.onlyIsolated === true,
      isDelisted: u.isDelisted === true,
      dayNtlVlm: num(ctxs?.[index]?.dayNtlVlm),
      markPx: num(ctxs?.[index]?.markPx),
    }));
  }

  /** The account value and the positions of a perps account (clearinghouseState). */
  async state(user: string): Promise<HlState> {
    const st = await this.post<{ marginSummary?: { accountValue?: string }; assetPositions?: Array<{ position?: { coin?: string; szi?: string } }> }>({ type: 'clearinghouseState', user: user.toLowerCase() });
    if (!st || typeof st !== 'object') throw new Error('Hyperliquid returned no account state');
    const positions: Record<string, number> = {};
    for (const ap of st.assetPositions ?? []) {
      const c = ap.position?.coin;
      const sz = num(ap.position?.szi);
      if (c && sz !== 0) positions[c] = (positions[c] ?? 0) + sz;
    }
    return { accountValue: num(st.marginSummary?.accountValue), positions };
  }

  /** The account's fills since `since` (userFillsByTime), on Hyperliquid's clock. */
  async fills(user: string, since: number): Promise<Array<FillInfo & { coin: string }>> {
    const rows = await this.post<Array<Record<string, unknown>>>({ type: 'userFillsByTime', user: user.toLowerCase(), startTime: Math.max(0, Math.floor(since - 1_000)) });
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      coin: String(r.coin ?? ''),
      clOrdID: typeof r.cloid === 'string' && r.cloid ? r.cloid : null,
      orderId: String(r.oid ?? ''),
      side: r.side === 'A' ? ('sell' as const) : ('buy' as const),
      price: num(r.px),
      qty: num(r.sz),
      fee: num(r.fee),
      builderFee: num(r.builderFee),
      // `crossed`: the order took liquidity.
      maker: r.crossed === false,
      time: num(r.time),
    }));
  }

  /** The account's open orders, triggers included (frontendOpenOrders). */
  async openOrders(user: string): Promise<Array<VenueOrder & { coin: string }>> {
    const rows = await this.post<Array<Record<string, unknown>>>({ type: 'frontendOpenOrders', user: user.toLowerCase() });
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      coin: String(r.coin ?? ''),
      orderId: String(r.oid ?? ''),
      clOrdID: typeof r.cloid === 'string' && r.cloid ? r.cloid : null,
      stop: r.isTrigger === true,
    }));
  }

  /** The best bid and ask of a coin (l2Book), and their mid. */
  async book(coin: string): Promise<{ bid: number; ask: number; mid: number }> {
    const b = await this.post<{ levels?: Array<Array<{ px?: string }>> }>({ type: 'l2Book', coin });
    const bid = num(b?.levels?.[0]?.[0]?.px);
    const ask = num(b?.levels?.[1]?.[0]?.px);
    if (!(bid > 0 && ask > 0)) throw new Error(`Hyperliquid has no two-sided book for ${coin}`);
    return { bid, ask, mid: (bid + ask) / 2 };
  }

  /** Every coin's mid (allMids). */
  async mids(): Promise<Record<string, number>> {
    const m = await this.post<Record<string, string>>({ type: 'allMids' });
    return Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, num(v)]));
  }
}

/* ------------------------------------------------------------------ writes ----- */

/** One order's answer: filled (with the order id), or Hyperliquid's refusal (thrown). */
export interface HlFill {
  oid: number;
  totalSz: number;
  avgPx: number;
}

/**
 * The leader wallet's writes, signed with its own master key. Every action is
 * guarded before it is signed; nothing is retried (a lost answer to an IOC
 * might have filled: the caller reads the position).
 */
export class HyperliquidExchange {
  readonly address: string;
  private last = 0;

  constructor(
    private readonly master: Uint8Array,
    readonly info: HyperliquidInfo,
    private readonly fetch: FetchLike,
    readonly url: string = HL_EXCHANGE_URL,
  ) {
    this.address = privateKeyToAddress(master).toLowerCase();
  }

  /** The time in ms, and never the same twice. */
  private nonce(): number {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }

  /** Guard, sign and send one action; Hyperliquid's answer, or its refusal thrown. */
  async send(action: HlAction): Promise<unknown> {
    guardAction(action);
    const nonce = this.nonce();
    const signature = signL1Action(action, nonce, this.master);
    // The body the Python SDK posts: no vault, no expiry.
    const res = (await this.fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter: null }),
      signal: AbortSignal.timeout(15_000),
    })) as Response;
    const text = await res.text();
    let body: { status?: string; response?: unknown } | null = null;
    try {
      body = JSON.parse(text) as { status?: string; response?: unknown };
    } catch {
      body = null;
    }
    if (!res.ok || body?.status !== 'ok') throw new Error(`Hyperliquid refused the ${action.type}: ${res.status} ${typeof body?.response === 'string' ? body.response : text.slice(0, 200)}`);
    return body.response;
  }

  /** One IOC limit on `coin`: `size` base units at `price` (both rounded to the coin's rules). Throws when Hyperliquid fills nothing. */
  async ioc(coin: string, isBuy: boolean, size: number, price: number, reduceOnly: boolean): Promise<HlFill> {
    const a = await this.info.asset(coin);
    const s = hlSize(size, a.szDecimals);
    if (Number(s) <= 0) throw new Error(`${size} ${coin} is below one step on Hyperliquid`);
    const order: HlOrderWire = { a: a.index, b: isBuy, p: hlPrice(price, a.szDecimals), s, r: reduceOnly, t: { limit: { tif: 'Ioc' } } };
    const r = (await this.send({ type: 'order', orders: [order], grouping: 'na' })) as { data?: { statuses?: Array<Record<string, unknown>> } } | null;
    const st = r?.data?.statuses?.[0] ?? {};
    const filled = st.filled as { oid?: number; totalSz?: string; avgPx?: string } | undefined;
    if (!filled) throw new Error(`Hyperliquid did not fill the ${isBuy ? 'buy' : 'sell'} of ${s} ${coin}: ${typeof st.error === 'string' ? st.error : JSON.stringify(st)}`);
    return { oid: num(filled.oid), totalSz: num(filled.totalSz), avgPx: num(filled.avgPx) };
  }

  async cancel(coin: string, oids: readonly number[]): Promise<void> {
    if (!oids.length) return;
    const a = await this.info.asset(coin);
    await this.send({ type: 'cancel', cancels: oids.map((o) => ({ a: a.index, o })) });
  }

  async updateLeverage(coin: string, leverage: number, isCross: boolean): Promise<void> {
    const a = await this.info.asset(coin);
    await this.send({ type: 'updateLeverage', asset: a.index, isCross, leverage: Math.max(1, Math.min(Math.floor(leverage), a.maxLeverage)) });
  }
}
