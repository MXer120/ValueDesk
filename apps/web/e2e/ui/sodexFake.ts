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

  const perpsState = () => ({
    user: me, aid: accountId, uid: accountId,
    av: balance, mm: '0', mmr: '0', am: balance, ami: '0', amw: balance, im: '0', cm: '0', oim: '0', ocm: '0',
    B: [{ i: 0, a: 'vUSDC', wb: balance, co: '0', mr: '0', px: '1', aw: balance, at: balance, wm: '0', am: balance }],
    P: [], O: [], TO: [], S: [],
  });
  const spotState = () => ({ user: me, aid: accountId, uid: accountId, B: [{ i: 0, a: 'vUSDC', t: balance, l: '0' }], O: [], TO: [] });
  const keyRows = () => [
    { name: 'default', type: 'EVM', publicKey: me, expiresAt: 0 },
    ...keys.map((k) => ({ name: k.name, type: 'EVM', publicKey: k.publicKey, expiresAt: k.expiresAt })),
  ];
  /** Seeded rows, gone once a write closes or cancels them (a reduce-only order, a cancel). */
  let held = o.position ? { ...o.position } : null;
  let resting = o.openOrder ? { ...o.openOrder, orderID: 777_001, clOrdID: 'e2e-resting-1' } : null;
  const positions = () => (held ? [{
    id: 555_001, symbol: held.symbol, positionSide: 'BOTH', size: held.size, avgEntryPrice: held.entry, leverage: held.leverage,
    marginMode: 'CROSS', initialMargin: String((Number(held.size) * Number(held.entry)) / held.leverage), unrealizedProfit: '0', liquidationPrice: '0',
  }] : []);
  const orders = () => (resting ? [{
    orderID: resting.orderID, clOrdID: resting.clOrdID, symbol: resting.symbol, side: resting.side, type: 'LIMIT', timeInForce: 'GTC',
    price: resting.price, quantity: resting.quantity, origQty: resting.quantity, filledQuantity: '0', status: 'NEW', reduceOnly: false, createdAt: Date.now() - 60_000,
  }] : []);
  const builderRows = () => builders.map((b) => ({ userID: accountId, builderID: b.builderID, feeRate: b.feeRate }));

  /** A read about this wallet: the fake account's answer, or null to let SoDEX answer. */
  function read(path: string): unknown {
    const p = path.toLowerCase();
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
      if (req.method() !== 'GET') return route.fulfill(write(req, url));
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
  };
}
