/**
 * A SoDEX account for the throwaway wallet, answered inside the browser context:
 * so the order ticket's whole path - Enable trading, the review, Place - can be
 * walked without funds and WITHOUT ANYTHING REACHING SODEX'S WRITE ROUTES.
 *
 * THE RULE: every request to the trading gateway that is not a GET is answered
 * here (`route.fulfill`) and never forwarded. Reads about this wallet (its
 * account id, state, builder approvals, API keys) are answered from a small
 * in-memory account; every other read (markets, books, klines) goes to SoDEX as
 * usual. The wallet is a random key SoDEX has never seen besides, so even a write
 * that got past this would be refused there: there is no account to trade in.
 *
 * What it records is what the app would have sent: each write's path, headers
 * and body, decoded. `signer(w)` recovers who signed a write (the trading key the
 * wallet registered, for an order), from the same digest SoDEX checks
 * (packages/sodex-core: payloadHash = keccak(goJSON({type, params})), EIP-712
 * ExchangeAction under the engine's domain).
 *
 * STATEFUL (`stateful: true`, uiSteps.spec.ts). The account then moves with what the
 * app sends, as SoDEX would answer it: a limit order rests in the open orders until a
 * cancel; a market (or IOC) order fills at its own limit price into the position; a
 * stop (or an entry's attached TP/SL) rests as a stop; a reduce-only fill that leaves
 * the market flat takes that market's stops with it; a leverage change is listed in
 * the account state. Market data still comes from SoDEX.
 *
 * A FAKE LEADER (`leader`) AND THE STREAM. With a leader, the fake answers its reads too
 * (its account id, its positions), and the gateway's websockets opened in the page are
 * routed through here: SoDEX's frames pass both ways, and `leaderTrade` puts a print of
 * the leader's on the public `trade` stream, as SoDEX names both parties of every print
 * (`bi` / `si`) - what the browser copier follows (copy-engine feeds.ts). Fills of the
 * follower's own orders are printed there the same way, so the copier books them. The
 * app's own account stream runs in a SharedWorker, which is not routed.
 */
import type { BrowserContext, Request, Route } from 'playwright-core';
import {
  SODEX_CHAIN_ID,
  engineDomainName,
  eip712Digest,
  exchangeActionStructHash,
  keccak256,
  makeDomain,
  payloadJSONFromBody,
  recoverWireSigner,
  utf8,
} from '../../../../packages/sodex-core/src/index.ts';

/** The gateway hosts whose writes are never forwarded. */
const GATEWAY = /^(mainnet|testnet)-gw\.sodex\.dev$/;

export interface FakeWrite {
  method: string;
  /** Gateway-relative, e.g. /api/v1/perps/trade/orders. */
  path: string;
  engine: 'perps' | 'spot' | null;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
  at: number;
}

export interface FakeAccountOptions {
  /** USDC in the perps account (default 10,000). */
  balance?: number;
  /** The builder approvals SoDEX lists from the start (default none). */
  builders?: Array<{ builderID: number; feeRate: number }>;
  /** A perps position the account holds (one-way: a positive size is long). */
  position?: { symbol: string; size: string; entry: string; leverage: number };
  /** A resting perps limit order. */
  openOrder?: { symbol: string; side: 'BUY' | 'SELL'; price: string; quantity: string };
  /** The account moves with the writes (orders rest and fill, stops rest, leverage is kept): see the top. */
  stateful?: boolean;
  /** A leader wallet the fake answers reads for, whose trades `leaderTrade` prints on the routed stream. */
  leader?: { address: string };
}

/** A resting order of the stateful account, as SoDEX lists one. */
export interface FakeOrder {
  orderID: number;
  clOrdID: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  timeInForce: string;
  price: string;
  quantity: string;
  reduceOnly: boolean;
  stopType?: 'STOP_LOSS' | 'TAKE_PROFIT';
  stopPrice?: string;
  createdAt: number;
}

export interface FakeSodex {
  readonly accountId: number;
  /** Every write the app sent, in order. */
  readonly writes: FakeWrite[];
  /** The order writes only (POST /trade/orders and /trade/orders/batch). */
  orders(): FakeWrite[];
  /** The API keys registered (by the wallet's UserSignedAddAPIKeyAction). */
  readonly keys: Array<{ name: string; publicKey: string; expiresAt: number }>;
  readonly builders: Array<{ builderID: number; feeRate: number }>;
  /** Answer the next order with this per-order rejection (as SoDEX answers inside an accepted batch). */
  rejectNextOrder(error: string): void;
  /** Who signed this write: the key that produced X-API-Sign over its body. */
  signer(w: FakeWrite): string;
  mark(): number;
  since(mark: number): FakeWrite[];
  /** Stateful: the follower's signed position on a market (0: flat). */
  position(symbol: string): number;
  /** Stateful: what rests (limits and stops), of one market or all. */
  resting(symbol?: string): FakeOrder[];
  /** Stateful: the leverage and margin mode last set on a market (null: never). */
  leverage(symbol: string): { leverage: number; marginMode: 'cross' | 'isolated' } | null;
  /** The fake leader's account id and position, and one trade of it: its position moves and a print goes out on the stream. */
  readonly leaderAccountId: number;
  leaderPosition(symbol: string): number;
  leaderTrade(symbol: string, side: 'buy' | 'sell', qty: number, price: number): void;
  /** How many of the page's gateway websockets are routed through here now. */
  sockets(): number;
}

const ACTION_TYPE: Record<string, string> = {
  'POST /trade/orders': 'newOrder',
  'DELETE /trade/orders': 'cancelOrder',
  'POST /trade/orders/batch': 'batchNewOrder',
  'DELETE /trade/orders/batch': 'batchCancelOrder',
  'POST /trade/leverage': 'updateLeverage',
  'POST /trade/margin': 'updateMargin',
  'POST /trade/orders/modify': 'modifyOrder',
  'POST /trade/orders/replace': 'replaceOrder',
  'POST /trade/orders/schedule-cancel': 'scheduleCancel',
};

const ok = (data: unknown) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 0, data }) });

export async function fakeSodexAccount(ctx: BrowserContext, address: string, o: FakeAccountOptions = {}): Promise<FakeSodex> {
  const me = address.toLowerCase();
  const accountId = 900_000 + Math.floor(Math.random() * 90_000);
  const balance = String(o.balance ?? 10_000);
  const writes: FakeWrite[] = [];
  const keys: FakeSodex['keys'] = [];
  const builders: FakeSodex['builders'] = [...(o.builders ?? [])];
  let rejectNext: string | null = null;
  let orderId = 1_000;
  const stateful = o.stateful === true;
  const leader = o.leader ? o.leader.address.toLowerCase() : null;
  const leaderAccountId = accountId + 1;
  /** Stateful: positions (signed size, entry), resting orders, leverage settings; the leader's positions. */
  const pos = new Map<string, { size: number; entry: number }>();
  const book: FakeOrder[] = [];
  const lev = new Map<string, { leverage: number; marginMode: 'CROSS' | 'ISOLATED' }>();
  const leaderPos = new Map<string, number>();
  /** symbolID -> name, learnt from SoDEX's own market list as it passes. */
  const symbolNames = new Map<number, string>();
  /** The page's routed gateway sockets (the stream), for prints. */
  const streams = new Set<{ send: (m: string) => void }>();
  let printId = Date.now();
  if (stateful && o.position) pos.set(o.position.symbol, { size: Number(o.position.size), entry: Number(o.position.entry) });

  const perpsState = () => ({
    user: me, aid: accountId, uid: accountId,
    av: balance, mm: '0', mmr: '0', am: balance, ami: '0', amw: balance, im: '0', cm: '0', oim: '0', ocm: '0',
    B: [{ i: 0, a: 'vUSDC', wb: balance, co: '0', mr: '0', px: '1', aw: balance, at: balance, wm: '0', am: balance }],
    P: stateful ? [...pos.entries()].filter(([, p]) => p.size !== 0).map(([sym, p]) => ({ s: sym, sz: String(p.size), ep: String(p.entry), l: lev.get(sym)?.leverage ?? 10, m: lev.get(sym)?.marginMode ?? 'CROSS' })) : [],
    O: [], TO: [],
    S: stateful ? [...lev.entries()].map(([sym, x]) => ({ s: sym, l: x.leverage, m: x.marginMode })) : [],
  });
  const leaderState = () => ({
    user: leader, aid: leaderAccountId, uid: leaderAccountId, av: '50000', am: '50000',
    B: [], O: [], TO: [], S: [],
    P: [...leaderPos.entries()].filter(([, q]) => q !== 0).map(([sym, q]) => ({ s: sym, sz: String(q), ep: '0', l: 2, m: 'CROSS' })),
  });
  const spotState = () => ({ user: me, aid: accountId, uid: accountId, B: [{ i: 0, a: 'vUSDC', t: balance, l: '0' }], O: [], TO: [] });
  const keyRows = () => [
    { name: 'default', type: 'EVM', publicKey: me, expiresAt: 0 },
    ...keys.map((k) => ({ name: k.name, type: 'EVM', publicKey: k.publicKey, expiresAt: k.expiresAt })),
  ];
  /** Seeded rows, gone once a write closes or cancels them (a reduce-only order, a cancel). */
  let held = o.position ? { ...o.position } : null;
  let resting = o.openOrder ? { ...o.openOrder, orderID: 777_001, clOrdID: 'e2e-resting-1' } : null;
  const statefulPositions = () => [...pos.entries()].filter(([, p]) => p.size !== 0).map(([sym, p], i) => {
    const l = lev.get(sym) ?? { leverage: 10, marginMode: 'CROSS' as const };
    return {
      id: 555_100 + i, symbol: sym, positionSide: 'BOTH', size: String(p.size), avgEntryPrice: String(p.entry), leverage: l.leverage,
      marginMode: l.marginMode, initialMargin: String((Math.abs(p.size) * p.entry) / l.leverage), unrealizedProfit: '0', liquidationPrice: '0',
    };
  });
  const statefulOrders = () => book.map((b) => ({
    orderID: b.orderID, clOrdID: b.clOrdID, symbol: b.symbol, side: b.side, type: b.type, timeInForce: b.timeInForce,
    price: b.price, quantity: b.quantity, origQty: b.quantity, filledQuantity: '0', status: 'NEW', reduceOnly: b.reduceOnly, createdAt: b.createdAt,
    ...(b.stopType ? { stopType: b.stopType, stopPrice: b.stopPrice, triggerType: 'MARK_PRICE' } : {}),
  }));
  const positions = () => stateful ? statefulPositions() : (held ? [{
    id: 555_001, symbol: held.symbol, positionSide: 'BOTH', size: held.size, avgEntryPrice: held.entry, leverage: held.leverage,
    marginMode: 'CROSS', initialMargin: String((Number(held.size) * Number(held.entry)) / held.leverage), unrealizedProfit: '0', liquidationPrice: '0',
  }] : []);
  const orders = () => stateful ? statefulOrders() : (resting ? [{
    orderID: resting.orderID, clOrdID: resting.clOrdID, symbol: resting.symbol, side: resting.side, type: 'LIMIT', timeInForce: 'GTC',
    price: resting.price, quantity: resting.quantity, origQty: resting.quantity, filledQuantity: '0', status: 'NEW', reduceOnly: false, createdAt: Date.now() - 60_000,
  }] : []);
  const builderRows = () => builders.map((b) => ({ userID: accountId, builderID: b.builderID, feeRate: b.feeRate }));

  /** A read about this wallet: the fake account's answer, or null to let SoDEX answer. */
  function read(path: string): unknown {
    const p = path.toLowerCase();
    if (leader && p.includes(leader)) {
      if (p.endsWith(`/user/${leader}/subaccounts`)) return { userID: leaderAccountId, primaryAccountID: leaderAccountId, subaccounts: [] };
      if (p.endsWith(`/perps/accounts/${leader}/state`)) return leaderState();
      if (/\/perps\/accounts\/[^/]+\/(positions|orders|trades)$/.test(p)) return [];
      return null;
    }
    if (!p.includes(me)) return null;
    if (p.endsWith(`/user/${me}/subaccounts`)) return { userID: accountId, primaryAccountID: accountId, subaccounts: [] };
    if (p.endsWith(`/perps/accounts/${me}/state`)) return perpsState();
    if (p.endsWith(`/spot/accounts/${me}/state`)) return spotState();
    if (p.endsWith(`/user/${me}/builders`)) return { spot: builderRows(), perps: builderRows() };
    if (p.endsWith(`/user/${me}/api-keys`)) return { spot: keyRows(), perps: keyRows() };
    if (/\/(perps|spot)\/accounts\/[^/]+\/api-keys$/.test(p)) return keyRows();
    if (/\/perps\/accounts\/[^/]+\/positions$/.test(p)) return positions();
    if (/\/perps\/accounts\/[^/]+\/orders$/.test(p)) return orders();
    if (/\/spot\/accounts\/[^/]+\/(orders|positions)$/.test(p)) return [];
    if (/\/(perps|spot)\/accounts\/[^/]+\/balances$/.test(p)) return [];
    return null;
  }

  /** A write: recorded, and answered as SoDEX would accept it. */
  function write(req: Request, url: URL): ReturnType<typeof ok> {
    const raw = req.postData() ?? '';
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const engine = /\/api\/v1\/perps\//.test(url.pathname) ? 'perps' : /\/api\/v1\/spot\//.test(url.pathname) ? 'spot' : null;
    const w: FakeWrite = { method: req.method(), path: url.pathname, engine, headers: req.headers(), body, raw, at: Date.now() };
    writes.push(w);
    const b = (body ?? {}) as Record<string, unknown> & { params?: Record<string, unknown> };
    if (url.pathname.endsWith('/exchange') || /\/user\/[^/]+\/(builders|api-keys)$/i.test(url.pathname)) {
      // The wallet's own signed actions: a key registration (an /exchange envelope) or a
      // builder-fee approval (POST /user/{addr}/builders {accountID, builderID, maxFeeRate}).
      const p = (b.params && typeof b.params === 'object' ? b.params : b) as Record<string, unknown>;
      if (typeof p.publicKey === 'string' && !keys.some((k) => k.publicKey.toLowerCase() === String(p.publicKey).toLowerCase())) {
        keys.push({ name: String(p.name ?? ''), publicKey: String(p.publicKey).toLowerCase(), expiresAt: Number(p.expiresAt ?? 0) });
      }
      const builderID = Number(p.builderID ?? p.builderId);
      const fee = Number(p.maxFeeRate ?? p.feeRate);
      if (Number.isFinite(builderID) && builderID > 0 && Number.isFinite(fee)) {
        const i = builders.findIndex((x) => x.builderID === builderID);
        if (fee === 0) {
          if (i >= 0) builders.splice(i, 1);
        } else if (i >= 0) builders[i]!.feeRate = fee;
        else builders.push({ builderID, feeRate: fee });
      }
      return ok({});
    }
    if (stateful && engine === 'perps' && url.pathname.endsWith('/trade/leverage')) {
      const sym = symbolNames.get(Number(b.symbolID));
      if (sym) lev.set(sym, { leverage: Number(b.leverage), marginMode: Number(b.marginMode) === 1 ? 'ISOLATED' : 'CROSS' });
      return ok({});
    }
    if (stateful && engine === 'perps' && /\/trade\/orders$/.test(url.pathname) && req.method() === 'DELETE') {
      for (const c of ((b as { cancels?: Array<{ orderID?: number; clOrdID?: string }> }).cancels ?? [])) {
        const i = book.findIndex((x) => (c.orderID !== undefined && c.orderID !== null && x.orderID === Number(c.orderID)) || (!!c.clOrdID && x.clOrdID === c.clOrdID));
        if (i >= 0) book.splice(i, 1);
      }
      return ok({});
    }
    if (stateful && engine === 'perps' && /\/trade\/orders$/.test(url.pathname) && req.method() === 'POST') {
      const sym = symbolNames.get(Number(b.symbolID)) ?? `#${String(b.symbolID)}`;
      const legs = ((body as { orders?: Leg[] })?.orders ?? []) as Leg[];
      const err = rejectNext;
      rejectNext = null;
      if (err) return ok(legs.map((l, i) => (i === 0 ? { code: 1001, clOrdID: l.clOrdID, error: err } : { code: 0, clOrdID: l.clOrdID, orderID: ++orderId })));
      return ok(legs.map((l) => ({ code: 0, clOrdID: l.clOrdID, orderID: take(sym, l) })));
    }
    if (/\/trade\/orders(\/batch)?$/.test(url.pathname) && req.method() === 'DELETE') resting = null;
    if (/\/trade\/orders(\/batch)?$/.test(url.pathname) && req.method() === 'POST') {
      // A reduce-only market order closes the seeded position (as it would fill).
      if (((body as { orders?: Array<{ reduceOnly?: boolean; type?: number; modifier?: number }> })?.orders ?? []).some((l) => l.reduceOnly && l.type === 2 && l.modifier === 1)) held = null;
      const legs = ((body as { orders?: Array<{ clOrdID?: string }> })?.orders ?? []) as Array<{ clOrdID?: string }>;
      const err = rejectNext;
      rejectNext = null;
      return ok(legs.map((l, i) => (err && i === 0 ? { code: 1001, clOrdID: l.clOrdID, error: err } : { code: 0, clOrdID: l.clOrdID, orderID: ++orderId })));
    }
    return ok({});
  }

  /** symbolID -> name from SoDEX's public perps market list (a GET of public data; a failure leaves orders on "#<id>"). */
  async function learnSymbols(origin: string): Promise<void> {
    try {
      const r = await fetch(`${origin}/api/v1/perps/markets/symbols`, { signal: AbortSignal.timeout(10_000) });
      const parsed = (await r.json()) as { data?: unknown } | unknown[];
      const rows = (Array.isArray(parsed) ? parsed : Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : []) as Array<{ id?: number; name?: string }>;
      for (const x of rows) if (typeof x.id === 'number' && x.name) symbolNames.set(x.id, x.name);
    } catch {
      /* read again on the next write */
    }
  }

  /** A trade print on the routed public stream, as SoDEX names both parties (feeds.ts). */
  function print(symbol: string, buyer: number, seller: number, takerBuy: boolean, qty: number, price: number): void {
    const msg = JSON.stringify({ channel: 'trade', data: [{ e: 'trade', s: symbol, t: ++printId, T: Date.now(), p: String(price), q: String(qty), S: takerBuy ? 'BUY' : 'SELL', bi: buyer, si: seller }] });
    for (const w of streams) w.send(msg);
  }

  /** The follower's position moves by a fill (its reduce-only orders and stops go once the market is flat), printed on the stream. */
  function fill(symbol: string, side: 1 | 2, qty: number, price: number): void {
    const p = pos.get(symbol) ?? { size: 0, entry: 0 };
    const next = Number((p.size + (side === 1 ? qty : -qty)).toFixed(12));
    const grows = next !== 0 && (p.size === 0 || Math.sign(next) === Math.sign(p.size));
    const entry = next === 0 ? 0 : !grows ? price : Math.abs(next) > Math.abs(p.size) ? (p.entry * Math.abs(p.size) + price * qty) / Math.abs(next) : p.entry;
    pos.set(symbol, { size: next, entry });
    if (next === 0) for (let i = book.length - 1; i >= 0; i--) if (book[i]!.symbol === symbol && book[i]!.reduceOnly) book.splice(i, 1);
    // The follower takes (an IOC): the taker side is its side, the other party is the book.
    // SoDEX answers the order first and prints the fill a moment later: so does this.
    setTimeout(() => print(symbol, side === 1 ? accountId : 1, side === 1 ? 1 : accountId, side === 1, qty, price), 400);
  }

  /** One leg of a newOrder as SoDEX takes it: a stop rests, a GTC or post-only limit rests, a market or an IOC fills. Answers its order id. */
  function take(symbol: string, l: Leg): number {
    const id = ++orderId;
    const side = l.side === 1 ? 'BUY' : 'SELL';
    if (l.modifier === 2 || l.modifier === 4) {
      book.push({ orderID: id, clOrdID: l.clOrdID, symbol, side, type: l.type === 1 ? 'LIMIT' : 'MARKET', timeInForce: 'GTC', price: l.price ?? '0', quantity: l.quantity ?? '0', reduceOnly: l.reduceOnly === true, stopType: l.stopType === 2 ? 'TAKE_PROFIT' : 'STOP_LOSS', stopPrice: l.stopPrice, createdAt: Date.now() });
      return id;
    }
    if (l.type === 1 && l.timeInForce !== 3) {
      book.push({ orderID: id, clOrdID: l.clOrdID, symbol, side, type: 'LIMIT', timeInForce: l.timeInForce === 4 ? 'GTX' : 'GTC', price: l.price ?? '0', quantity: l.quantity ?? '0', reduceOnly: l.reduceOnly === true, createdAt: Date.now() });
      return id;
    }
    // A reduce-only order fills at most what it can reduce.
    const held = pos.get(symbol)?.size ?? 0;
    const reduces = Math.sign(held) === (l.side === 1 ? -1 : 1);
    const q = l.reduceOnly ? (reduces ? Math.min(Number(l.quantity ?? 0), Math.abs(held)) : 0) : Number(l.quantity ?? 0);
    if (q > 0) fill(symbol, l.side as 1 | 2, q, Number(l.price ?? 0));
    return id;
  }

  if (stateful || leader) {
    await ctx.routeWebSocket(
      (u) => GATEWAY.test(u.hostname),
      (ws) => {
        const server = ws.connectToServer();
        const w = { send: (m: string) => ws.send(m) };
        streams.add(w);
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => ws.send(m));
        ws.onClose(() => streams.delete(w));
        server.onClose(() => streams.delete(w));
      },
    );
  }

  await ctx.route(
    (u) => GATEWAY.test(u.hostname),
    async (route: Route, req: Request) => {
      const url = new URL(req.url());
      if (req.method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*',
          },
        });
      }
      // NEVER FORWARDED: whatever the path, a write is answered here.
      if (req.method() !== 'GET') {
        // An order names its market by id: SoDEX's public market list says which (read once, from here).
        if (stateful && symbolNames.size === 0) await learnSymbols(url.origin);
        return route.fulfill(write(req, url));
      }
      const data = read(url.pathname);
      if (data !== null) return route.fulfill(ok(data));
      return route.continue();
    },
  );

  return {
    accountId,
    writes,
    keys,
    builders,
    orders: () => writes.filter((w) => w.method === 'POST' && /\/trade\/orders(\/batch)?$/.test(w.path)),
    rejectNextOrder: (e) => {
      rejectNext = e;
    },
    signer(w) {
      const rel = w.path.replace(/^\/api\/v1\/(perps|spot)/, '');
      const type = ACTION_TYPE[`${w.method} ${rel}`];
      if (!type || !w.engine) throw new Error(`no action type for ${w.method} ${w.path}`);
      const chainId = Number(w.headers['x-api-chain']);
      if (chainId !== SODEX_CHAIN_ID.mainnet && chainId !== SODEX_CHAIN_ID.testnet) throw new Error(`unexpected X-API-Chain ${chainId}`);
      const digest = eip712Digest(
        makeDomain(engineDomainName(w.engine), chainId),
        exchangeActionStructHash(keccak256(utf8(payloadJSONFromBody(type, w.raw))), BigInt(w.headers['x-api-nonce'] ?? '0')),
      );
      return recoverWireSigner(digest, w.headers['x-api-sign'] ?? '').toLowerCase();
    },
    mark: () => writes.length,
    since: (m) => writes.slice(m),
    position: (symbol) => pos.get(symbol)?.size ?? 0,
    resting: (symbol) => book.filter((x) => !symbol || x.symbol === symbol).map((x) => ({ ...x })),
    leverage(symbol) {
      const x = lev.get(symbol);
      return x ? { leverage: x.leverage, marginMode: x.marginMode === 'ISOLATED' ? 'isolated' : 'cross' } : null;
    },
    leaderAccountId,
    leaderPosition: (symbol) => leaderPos.get(symbol) ?? 0,
    leaderTrade(symbol, side, qty, price) {
      if (!leader) throw new Error('this fake account has no leader');
      leaderPos.set(symbol, Number(((leaderPos.get(symbol) ?? 0) + (side === 'buy' ? qty : -qty)).toFixed(12)));
      print(symbol, side === 'buy' ? leaderAccountId : 2, side === 'buy' ? 2 : leaderAccountId, side === 'buy', qty, price);
    },
    sockets: () => streams.size,
  };
}

/** One leg of a perps newOrder body, as far as the stateful account reads it (trade.ts Leg). */
interface Leg {
  clOrdID: string;
  modifier: number;
  side: number;
  type: number;
  timeInForce: number;
  price?: string;
  quantity?: string;
  reduceOnly?: boolean;
  stopPrice?: string;
  stopType?: number;
}
