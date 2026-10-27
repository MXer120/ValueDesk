/**
 * Account detail for Scan's band (open orders, order history, funding,
 * balances) on the venues other than SoDEX, from each venue's public reads:
 *
 *   Hyperliquid / trade.xyz  frontendOpenOrders (per dex), historicalOrders,
 *                            userFunding, spotClearinghouseState; trade.xyz is
 *                            the `xyz:` slice of each
 *   Arcus                    /v1/openOrders, /v1/orders, /v1/funding, /v1/account
 *   Lighter                  balances only (/api/v1/account assets); its orders
 *                            and funding need the account's own key
 *
 * Also the spot-name lookup: Hyperliquid names a spot market `@107` in fills,
 * orders and balances; the market list gives it its pair name.
 */
import type { VsBalance, VsFunding, VsOrder } from '../types.js';
import { hlInfo } from '../hyperliquid/client.js';
import { arcusPacer, arcusRead, ARCUS_API } from './arcus.js';
import { lighterAccounts, lighterPacer, LIGHTER_API } from './lighter.js';
import { num } from './http.js';

// --- Hyperliquid ----------------------------------------------------------------------

interface HlSpotMeta {
  universe?: Array<{ name?: string; index?: number; tokens?: number[] }>;
  tokens?: Array<{ name?: string; index?: number }>;
}

let spot: { at: number; names: Map<string, string> } | null = null;

/** `@107` -> `HYPE/USDC` (and `PURR/USDC` stays). Cached for an hour. */
export async function hlSpotNames(): Promise<Map<string, string>> {
  if (spot && Date.now() - spot.at < 60 * 60_000) return spot.names;
  const m = await hlInfo.post<HlSpotMeta>({ type: 'spotMeta' }, { ttlMs: 60 * 60_000 });
  const token = new Map((m.tokens ?? []).map((t) => [t.index, t.name ?? '']));
  const names = new Map<string, string>();
  for (const u of m.universe ?? []) {
    if (!u.name) continue;
    const [b, q] = u.tokens ?? [];
    const pair = b !== undefined && q !== undefined ? `${token.get(b) ?? b}/${token.get(q) ?? q}` : u.name;
    names.set(u.name, u.name.startsWith('@') ? pair : u.name);
  }
  spot = { at: Date.now(), names };
  return names;
}

/** A Hyperliquid coin as shown: spot `@N` gets its pair name. */
export async function hlCoinName(): Promise<(coin: string) => string> {
  const names = await hlSpotNames().catch(() => new Map<string, string>());
  return (coin) => (coin.startsWith('@') ? (names.get(coin) ?? coin) : coin);
}

interface HlOrderRaw {
  coin: string;
  side: 'B' | 'A';
  limitPx?: string;
  sz?: string;
  origSz?: string;
  oid: number;
  timestamp: number;
  orderType?: string;
  reduceOnly?: boolean;
  triggerPx?: string;
  isTrigger?: boolean;
  tif?: string | null;
}

function hlOrder(o: HlOrderRaw, status: string, time: number, name: (c: string) => string): VsOrder {
  const orig = num(o.origSz) ?? num(o.sz) ?? 0;
  const left = num(o.sz) ?? 0;
  return {
    id: String(o.oid),
    time,
    symbol: name(o.coin),
    side: o.side === 'B' ? 'buy' : 'sell',
    type: (o.orderType ?? 'limit').toLowerCase(),
    price: num(o.limitPx),
    trigger: o.isTrigger ? num(o.triggerPx) : null,
    size: orig,
    filled: status === 'open' ? orig - left : status === 'filled' ? orig : Math.max(0, orig - left),
    status,
    reduceOnly: !!o.reduceOnly,
    tif: o.tif ?? null,
  };
}

const XYZ = 'xyz:';
type Slice = 'hl' | 'xyz';
const inSlice = (slice: Slice, coin: string) => (slice === 'xyz' ? coin.startsWith(XYZ) : !coin.startsWith(XYZ));

export async function hlOpenOrders(address: string, slice: Slice): Promise<VsOrder[]> {
  const name = await hlCoinName();
  const body = slice === 'xyz' ? { type: 'frontendOpenOrders', user: address, dex: 'xyz' } : { type: 'frontendOpenOrders', user: address };
  const list = await hlInfo.post<HlOrderRaw[]>(body, { ttlMs: 10_000 });
  return (Array.isArray(list) ? list : []).filter((o) => inSlice(slice, o.coin)).map((o) => hlOrder(o, 'open', o.timestamp, name));
}

export async function hlOrderHistory(address: string, slice: Slice, limit = 500): Promise<VsOrder[]> {
  const name = await hlCoinName();
  const list = await hlInfo.post<Array<{ order: HlOrderRaw; status: string; statusTimestamp: number }>>(
    { type: 'historicalOrders', user: address },
    { ttlMs: 30_000, timeoutMs: 25_000 },
  );
  return (Array.isArray(list) ? list : [])
    .filter((r) => r?.order && inSlice(slice, r.order.coin))
    .map((r) => hlOrder(r.order, String(r.status).toLowerCase(), r.statusTimestamp, name))
    .sort((a, b) => b.time - a.time)
    .slice(0, limit);
}

export async function hlFunding(address: string, slice: Slice, o: { from?: number; limit?: number }): Promise<VsFunding[]> {
  const list = await hlInfo.post<Array<{ time: number; delta?: { type?: string; coin?: string; usdc?: string; szi?: string; fundingRate?: string } }>>(
    { type: 'userFunding', user: address, startTime: o.from ?? Date.now() - 30 * 86_400_000 },
    { ttlMs: 60_000, timeoutMs: 25_000 },
  );
  return (Array.isArray(list) ? list : [])
    .flatMap((r): VsFunding[] => {
      const d = r.delta;
      if (!d || d.type !== 'funding' || !d.coin || !inSlice(slice, d.coin)) return [];
      return [{ time: r.time, symbol: d.coin, amount: num(d.usdc) ?? 0, rate: num(d.fundingRate), size: num(d.szi) }];
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, o.limit ?? 500);
}

const STABLE = /^(USDC|USDT|USDE|USDH|USDG|USD)$/i;

/** A spot token's USD price: the mid of its `TOKEN/USDC` pair. */
async function hlSpotPrices(): Promise<Map<string, number>> {
  const [names, mids] = await Promise.all([
    hlSpotNames(),
    hlInfo.post<Record<string, string>>({ type: 'allMids' }, { ttlMs: 15_000 }),
  ]);
  const out = new Map<string, number>();
  for (const [market, pair] of names) {
    const [base, quote] = pair.split('/');
    const mid = num(mids[market]);
    if (base && quote === 'USDC' && mid !== null && !out.has(base)) out.set(base, mid);
  }
  return out;
}

export async function hlBalances(address: string): Promise<VsBalance[]> {
  const [st, prices] = await Promise.all([
    hlInfo.post<{ balances?: Array<{ coin?: string; total?: string; hold?: string }> }>({ type: 'spotClearinghouseState', user: address }, { ttlMs: 10_000 }),
    hlSpotPrices().catch(() => new Map<string, number>()),
  ]);
  return (st.balances ?? [])
    .flatMap((b): VsBalance[] => {
      const total = num(b.total) ?? 0;
      if (!b.coin || !total) return [];
      const hold = num(b.hold) ?? 0;
      const px = STABLE.test(b.coin) ? 1 : prices.get(b.coin);
      return [{ coin: b.coin, total, available: total - hold, usd: px === undefined ? null : total * px }];
    })
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
}

// --- Arcus ------------------------------------------------------------------------------

function arcusOrder(o: Record<string, unknown>): VsOrder {
  const orig = num(o.originalSize) ?? 0;
  return {
    id: String(o.orderId),
    time: Math.floor((num(o.updatedAt) ?? num(o.createdAt) ?? 0) / 1000),
    symbol: String(o.marketDisplayName ?? o.marketId),
    side: o.side === 'SELL' ? 'sell' : 'buy',
    type: String(o.type ?? 'limit').toLowerCase().replace(/_/g, ' '),
    price: num(o.price),
    trigger: num(o.triggerPrice),
    size: orig,
    filled: num(o.filledSize),
    status: String(o.status ?? '').toLowerCase(),
    reduceOnly: o.reduceOnly === true,
    tif: typeof o.timeInForce === 'string' ? o.timeInForce : null,
  };
}

export async function arcusOpenOrders(address: string): Promise<VsOrder[]> {
  const j = await arcusRead<{ orders?: Array<Record<string, unknown>> }>(arcusPacer, `${ARCUS_API}/v1/openOrders?address=${address}`, 20, {});
  return (j.orders ?? []).map(arcusOrder);
}

export async function arcusOrderHistory(address: string, limit = 500): Promise<VsOrder[]> {
  const j = await arcusRead<{ orders?: Array<Record<string, unknown>> }>(arcusPacer, `${ARCUS_API}/v1/orders?address=${address}&limit=${Math.min(1000, limit)}`, 20, {});
  return (j.orders ?? []).map(arcusOrder).sort((a, b) => b.time - a.time);
}

export async function arcusFunding(address: string, o: { from?: number; limit?: number }): Promise<VsFunding[]> {
  const qs = new URLSearchParams({ address, limit: String(Math.min(1000, o.limit ?? 500)) });
  if (o.from !== undefined) qs.set('from', String(o.from * 1000));
  const j = await arcusRead<{ fundingPayments?: Array<Record<string, unknown>> }>(arcusPacer, `${ARCUS_API}/v1/funding?${qs}`, 20, {});
  return (j.fundingPayments ?? []).map((f) => ({
    time: Math.floor((num(f.time) ?? 0) / 1000),
    symbol: String(f.marketDisplayName ?? f.marketId),
    amount: num(f.payment) ?? 0,
    rate: num(f.fundingRate),
    size: num(f.size),
  }));
}

export async function arcusBalances(address: string): Promise<VsBalance[]> {
  const j = await arcusRead<{ netQuoteBalance?: unknown; freeCollateral?: unknown; netDepositsByAsset?: Array<{ spotAssetDisplayName?: string }> }>(
    arcusPacer,
    `${ARCUS_API}/v1/account?address=${address}`,
    2,
    {},
  );
  const total = num(j.netQuoteBalance);
  if (total === null) return [];
  const coin = j.netDepositsByAsset?.[0]?.spotAssetDisplayName ?? 'USDG';
  return [{ coin, total, available: num(j.freeCollateral), usd: total }];
}

// --- Lighter ------------------------------------------------------------------------------

export async function lighterBalances(address: string): Promise<VsBalance[]> {
  const idx = await lighterAccounts(address);
  const out = new Map<string, VsBalance>();
  for (const i of idx) {
    const j = await lighterPacer.get<{ accounts?: Array<{ assets?: Array<{ symbol?: string; balance?: string; locked_balance?: string }> }> }>(
      `${LIGHTER_API}/api/v1/account?by=index&value=${i}`,
    );
    for (const a of j.accounts?.[0]?.assets ?? []) {
      const total = num(a.balance) ?? 0;
      if (!a.symbol || !total) continue;
      const cur = out.get(a.symbol) ?? { coin: a.symbol, total: 0, available: 0, usd: STABLE.test(a.symbol) ? 0 : null };
      cur.total += total;
      cur.available = (cur.available ?? 0) + total - (num(a.locked_balance) ?? 0);
      if (cur.usd !== null) cur.usd = cur.total;
      out.set(a.symbol, cur);
    }
  }
  return [...out.values()];
}
