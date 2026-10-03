/**
 * The app's data client. Exchange data - markets and accounts - is read
 * STRAIGHT from SoDEX in this browser (exchange/*); only Valuescan's own
 * index and status come from the Valuescan server.
 */
import { SodexApiError } from '@sodex-core';
import { CHAINS } from '@sign/sodex/chainParams.js';
import { logger } from './log';
import { account } from './exchange/sodexAccount';
import { market, MarketRequestError } from './exchange/sodexMarket';
import { BudgetWaitError } from './exchange/ledger';
import { RateLimitedError, UnreachableError } from './exchange/errors';
import { network } from './exchange/hosts';
import { DepositAddressRequestError, deposits } from './exchange/deposits';
import { rpcCall } from './trading/rpc';
import { formatUnits } from './trading/onboard';
import { getTradingState, sessionInfoOf } from './trading/session';

const apiLog = logger('api');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
    readonly code?: number,
    readonly source?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * No call from this client had a timeout - none, anywhere, ever. That is what
 * turned a genuine but ordinary condition (the backend's weight budget, shared
 * across every open tab, temporarily exhausted - `take()` in
 * server/src/sodex/rest.ts "never rejects; just delays") into what looked like
 * a broken app: the chart stuck on "Loading…" forever, positions and account
 * panels never resolving, with zero signal to the user that anything was
 * happening at all. The budget queue is CORRECT to wait rather than drop a
 * request; the bug was entirely on this side, in never giving up.
 *
 * 20s is generous next to the budget window (60s) and every normal request
 * (tens to low hundreds of ms) - it is sized to catch "this is genuinely
 * stuck", not to second-guess a slightly slow one.
 */
const REQUEST_TIMEOUT_MS = 20_000;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const timeoutCtl = new AbortController();
  // A caller-supplied signal (there are none today, but the type allows it)
  // must still be able to cancel the request; only ONE of the two abort
  // reasons should ever fire, so the timeout is cleared the moment either does.
  const timer = setTimeout(() => timeoutCtl.abort(), REQUEST_TIMEOUT_MS);
  const onCallerAbort = () => timeoutCtl.abort();
  init?.signal?.addEventListener('abort', onCallerAbort);

  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      signal: timeoutCtl.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      // The detail is for the console; what a trader sees is only "<what>
      // couldn't load." (components/LoadFailed.tsx) or an action's own message.
      apiLog.warn('request timed out', { path, timeoutMs: REQUEST_TIMEOUT_MS });
      throw new ApiError('The request timed out.', 0);
    }
    apiLog.warn('backend unreachable', { path, error: (e as Error).message });
    throw new ApiError('The Valuescan server could not be reached.', 0);
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener('abort', onCallerAbort);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    apiLog.warn('malformed response', { path, status: res.status, body: text.slice(0, 200) });
    throw new ApiError('The server sent an unreadable answer.', res.status);
  }
  if (!res.ok) {
    throw new ApiError(body?.error ?? `HTTP ${res.status}`, res.status, body?.hint, body?.code, body?.source);
  }
  return body as T;
}

const get = <T>(path: string): Promise<T> => call<T>(path);
const post = <T>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const del = <T>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'DELETE', body: JSON.stringify(body ?? {}) });

const qs = (o: Record<string, string | number | undefined>): string =>
  '?' + new URLSearchParams(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
  );

// --- shared shapes -----------------------------------------------------------

export type Engine = 'spot' | 'perps';

/** One band of the tiered maintenance-margin schedule. All values are decimal strings. */
export interface MarginTier {
  maxNotionalValue: string;
  maintenanceMarginRate: string;
  maxLeverage: number;
  maintenanceDeduction: string;
}

export interface Symbol {
  id: number;
  name: string;
  displayName: string;
  baseCoin: string;
  baseCoinID?: number;
  quoteCoin: string;
  quoteCoinID: number;
  pricePrecision: number;
  tickSize: string;
  quantityPrecision: number;
  stepSize: string;
  minQuantity: string;
  minNotional: string;
  makerFee: string;
  takerFee: string;
  status: string;
  maxLeverage?: number;
  initLeverage?: number;
  /**
   * Notional-banded maintenance margin schedule, returned live by the gateway.
   * `maintenanceDeduction` is the continuity constant that keeps the
   * maintenance-margin curve unbroken across tier boundaries - see risk.ts.
   */
  marginTiers?: MarginTier[];
  fundingInterval?: number;
  // --- the rest of what the gateway sends and the server already fetches -
  // undeclared here until now, so it existed on the wire but nowhere a
  // component could read it with type safety. All optional: a "0" ceiling is
  // this venue's own sentinel for "no maximum" (see server's
  // normaliseOrder), not a real bound, and every field below is genuinely
  // absent on some symbol shape (spot has no leverage/funding concept at
  // all) rather than merely unfetched.
  minPrice?: string;
  maxPrice?: string;
  maxQuantity?: string;
  marketMinQuantity?: string;
  marketMaxQuantity?: string;
  maxNotional?: string;
  maxFundingRate?: string;
  minFundingRate?: string;
  /** Price bands, as a ratio of the reference price - how far a LIMIT order
   *  may sit above it before the venue rejects it outright. */
  buyLimitUpRatio?: string;
  /** Same band, downward. */
  sellLimitDownRatio?: string;
  /** How far a MARKET order may slip from the reference price before the
   *  venue rejects it - a different, usually tighter, band than the limit
   *  one above. */
  marketDeviationRatio?: string;
  /** Perps only: the venue-wide cap on one symbol's total open interest. */
  openInterestCap?: string;
  openInterestCapUSD?: string;
  /** Spot only: the hourly rate margin-eligible spot balances accrue. */
  interestRate?: string;
}

export interface Ticker {
  symbol: string;
  lastPx: string;
  openPx: string;
  highPx: string;
  lowPx: string;
  volume: string;
  quoteVolume: string;
  change: string;
  changePct: number;
  askPx: string;
  bidPx: string;
  markPrice?: string;
  indexPrice?: string;
  fundingRate?: string;
  nextFundingTime?: number;
  openInterest?: string;
}

export interface OrderBook {
  bids: [string, string][];
  asks: [string, string][];
  updateID: number;
  blockTime: number;
}

export interface Kline {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  q: string;
  n: number;
}

export interface PublicTrade {
  t: number;
  T: number;
  s: string;
  /**
   * Aggressor side. Verified rather than assumed: 82 of 84 sampled prints
   * traded exactly at the touch in the direction this implies, so maker/taker
   * role per print is deterministic, not a heuristic.
   */
  S: 'BUY' | 'SELL';
  p: string;
  q: string;
  /**
   * Buyer / seller account ids. Present ONLY on WebSocket pushes - the REST
   * seed (`/api/md/{engine}/trades`) omits them entirely, so the first page of
   * a freshly-loaded tape is unattributable and cannot be filtered. Optional
   * for exactly that reason; never assume they exist.
   */
  bi?: number;
  si?: number;
}

export interface SessionInfo {
  network: string;
  chainId: number;
  unlocked: boolean;
  session: {
    apiKeyName: string;
    accountId: number;
    address: string;
    keyAddress: string;
    permissions: number;
  } | null;
  permissionNames: string[];
  /** Always 'memory' now: no key is ever written to disk. */
  protection: 'memory' | null;
  autoUnlock: boolean;
  /**
   * Only non-null when a keystore file written by an OLDER version is still
   * present. Nothing creates one; it is surfaced so it can be cleared.
   */
  legacyKeystore: {
    path: string;
    accounts: Array<{
      address: string;
      apiKeyName: string;
      permissions: number;
      permissionNames: string[];
      protection: string;
      canMoveFunds: boolean;
    }>;
  } | null;
}

// --- all-time stats (server/src/statsCore.ts builds this shape) --------------

export interface StatsCoinTotal {
  /** null when the venue did not label which coin the amount is in. */
  coin: string | null;
  amount: string;
  count: number;
}

export interface StatsSymbolTotal {
  symbol: string;
  count: number;
  volume: string | null;
  volumeCoin: string | null;
}

export interface StatsTradeStats {
  count: number;
  firstTime: number | null;
  lastTime: number | null;
  fees: StatsCoinTotal[];
  volume: StatsCoinTotal[];
  volumeSource: { reported: number; derived: number; unavailable: number };
  liquidity: { maker: number; taker: number; unknown: number };
  bySymbol: StatsSymbolTotal[];
  feeCoinUnlabelled: number;
  unreadable: { fee: number; volume: number };
  provenance: string;
}

export interface StatsFundingStats {
  count: number;
  firstTime: number | null;
  lastTime: number | null;
  totals: StatsCoinTotal[];
  feeCoinUnlabelled: number;
  bySymbol: StatsSymbolTotal[];
  provenance: string;
}

export interface StatsHeadline {
  available: boolean;
  reason: string | null;
  accountId: number | null;
  asOf: number | null;
  cumulativePnl: string | null;
  unrealizedPnl: string | null;
  cumulativeQuoteVolume: string | null;
  firstTradeAt: number | null;
  curve: Array<{ t: number; pnl: string }>;
  provenance: string;
}

export interface StatsSyncProgress {
  kind: string;
  status: 'never' | 'running' | 'done' | 'error';
  pages: number;
  fetched: number;
  cached: number;
  oldest: number | null;
  newest: number | null;
  complete: boolean;
  truncated: string | null;
  error: string | null;
}

export interface StatsResponse {
  address: string;
  trades: { spot: StatsTradeStats; perps: StatsTradeStats };
  funding: StatsFundingStats;
  headline: StatsHeadline;
  spotRealizedPnl: { value: null; reason: string };
  sync: {
    running: boolean;
    scopes: Record<string, StatsSyncProgress>;
    cache: { path: string; ok: boolean; error: string | null };
  };
}

export interface WalletAccount {
  address: string;
  accountId: number;
  exists: boolean;
  network: string;
  apiKeys: Array<{ name: string; type: string; publicKey: string; expiresAt: number; permissions?: number }>;
  spotState: any;
  perpsState: any;
}

export interface PrepareKeyResult {
  keyAddress: string;
  name: string;
  accountId: number;
  permissions: number;
  permissionNames: string[];
  expiresAt: number;
  nonce: string;
  canWithdraw: boolean;
  canTransfer: boolean;
  typedData: Record<string, unknown>;
}

export interface OnboardingStep {
  id: string;
  title: string;
  done: boolean;
  blocked: boolean;
  detail: string;
  externalUrl?: string;
  action?: string;
}

export interface OnboardingState {
  network: string;
  address: string | null;
  accountId: number | null;
  registered: boolean;
  unlocked: boolean;
  permissions: number;
  permissionNames: string[];
  canTrade: boolean;
  canTransfer: boolean;
  canWithdraw: boolean;
  funded: boolean;
  gasBalance: string;
  steps: OnboardingStep[];
  nextStep: string | null;
  ready: boolean;
}

/** The exact operation an elevation authorises. Mirrors ElevationIntent server-side. */
export interface ElevateInput {
  address: string;
  scope: 'transfer' | 'withdraw';
  engine: Engine;
  coinId: number;
  amount: string;
  toAccountId?: number | null;
  direction?: string | null;
  signatureChainId?: number;
}

export interface PermissionPreset {
  id: string;
  label: string;
  permissions: number;
  description: string;
  recommended?: boolean;
  dangerous?: boolean;
}

export interface DepositAsset {
  coinId: number;
  symbol: string;
  address: string;
  decimals: number;
  isNative: boolean;
  verified: boolean;
  walletBalance: string | null;
}

export interface MirrorRoute {
  chain: string;
  label: string;
  address: string;
  custodian: string;
  /** The backend re-derived this address from the on-chain registry. */
  verified: boolean;
  /** SoDEX flagged this chain's deposit address: `address` is empty until the user asks for a new one. */
  flagged?: boolean;
  isEvm: boolean;
  needsMemo: boolean;
  contractWarning: boolean;
  depositMinutes: number | null;
  minDeposit: string | null;
  explorerUrl: string | null;
}

export interface MirrorAsset {
  symbol: string;
  routes: MirrorRoute[];
}

export interface DepositChain {
  chainId: number;
  chainIdHex: string;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  exchange: string;
}

export interface PreparedDeposit {
  asset: DepositAsset;
  amount: string;
  amountBaseUnits: string;
  walletBalance: string;
  sufficient: boolean;
  /** Non-null means the transaction would revert - do not send it. */
  blocker: string | null;
  chainId: number;
  chainIdHex: string;
  exchange: string;
  transactions: Array<{ kind: 'approve' | 'deposit'; to: string; data: string; value: string; description: string }>;
  note?: string;
}

export interface PlaceOrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  type?: 'limit' | 'market';
  price?: string;
  quantity?: string;
  funds?: string;
  tif?: 'gtc' | 'fok' | 'ioc' | 'gtx';
  postOnly?: boolean;
  reduceOnly?: boolean;
  stopPrice?: string;
  stopType?: 'sl' | 'tp';
  triggerType?: 'last' | 'mark' | 'index';
  takeProfit?: { price: string };
  stopLoss?: { price: string };
}

// --- endpoints ---------------------------------------------------------------

/**
 * Exchange reads go STRAIGHT from this browser to SoDEX (exchange/*): the
 * user's own IP and budget, and nothing about their account passes through a
 * Valuescan server. Errors keep the shape the server used to answer with
 * (ApiError: message, status, hint, code, source), so every panel's error text
 * is unchanged.
 */
function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof SodexApiError) {
    return new ApiError(e.message, e.httpStatus >= 400 ? e.httpStatus : 400, e.hint, e.code, 'sodex');
  }
  if (e instanceof MarketRequestError) return new ApiError(e.message, e.status, undefined, undefined, 'validation');
  if (e instanceof DepositAddressRequestError) return new ApiError(e.message, e.statusCode);
  if (e instanceof RateLimitedError || e instanceof BudgetWaitError) {
    return new ApiError(e.message, 429, 'Rate limited - backing off.', 429, 'sodex');
  }
  if (e instanceof UnreachableError) {
    apiLog.warn('exchange unreachable', { host: e.host, timedOut: e.timedOut });
    return new ApiError(e.timedOut ? 'The request timed out.' : 'SoDEX could not be reached.', 0);
  }
  return new ApiError((e as Error)?.message ?? String(e), 0);
}

/**
 * One exchange read with the deadline every api call had (REQUEST_TIMEOUT_MS):
 * a read stuck behind a full budget ends as an honest "timed out" instead of a
 * spinner. History pages may queue longer for their drip slot (sodexGateway.ts).
 */
async function direct<T>(what: string, fn: () => Promise<T>, deadlineMs = REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      apiLog.warn('request timed out', { what, timeoutMs: deadlineMs });
      reject(new ApiError('The request timed out.', 0));
    }, deadlineMs);
  });
  try {
    return await Promise.race([fn(), late]);
  } catch (e) {
    throw toApiError(e);
  } finally {
    clearTimeout(timer);
  }
}

/** History reads can wait for their slot: at most 2 per minute per IP on /trades and /orders/history together. */
const HISTORY_DEADLINE_MS = 130_000;

/** The browser-trading module, loaded on first use (see placeOrder below). */
const trading = () => import('./trading/actions');

/** The /api/health read in flight, if any (see api.health). */
let healthRead: Promise<any> | null = null;

export const api = {
  /**
   * The Valuescan server itself: its network and status (not exchange data).
   * One request at a time: callers that overlap - the shell's poll and the
   * portfolio chart both ask as a page loads - share it.
   */
  health: (): Promise<any> => (healthRead ??= get<any>('/api/health').finally(() => { healthRead = null; })),
  onboarding: (address?: string) => direct('onboarding', () => onboardingState(address)),
  /**
   * All-time statistics, walked and totalled in this browser (exchange/allTime.ts,
   * loaded on first use): the same answer the server's /api/stats/all-time gave.
   */
  statsAllTime: (address: string, rebuild = false): Promise<StatsResponse> =>
    direct('stats/all-time', async () => (await import('./exchange/allTime')).allTimeStats(address, rebuild)),

  // market data - straight from the gateway
  symbols: (e: Engine) => direct('symbols', () => market.symbols(e)),
  tickers: (e: Engine) => direct('tickers', () => market.tickers(e)),
  markPrices: () => direct('mark-prices', () => market.markPrices()),
  orderbook: (e: Engine, symbol: string, limit = 20) => direct('orderbook', () => market.orderbook(e, symbol, limit)),
  klines: (e: Engine, symbol: string, interval: string, limit = 300) =>
    direct('klines', () => market.klines(e, symbol, interval, limit)),
  publicTrades: (e: Engine, symbol: string, limit = 50) => direct('trades', () => market.trades(e, symbol, limit)),

  // account - straight from the gateway (public reads: an address, no signature)
  state: (e: Engine, address: string) => direct('state', () => account.state(e, address)),
  balances: (e: Engine, address: string) => direct('balances', () => account.balances(e, address)),
  openOrders: (e: Engine, address: string, symbol?: string) =>
    direct('orders', () => account.openOrders(e, address, symbol)),
  positions: (address: string) => direct('positions', () => account.positions(address)),
  orderHistory: (e: Engine, address: string, limit = 100) =>
    direct('orders/history', () => account.orderHistory(e, address, { limit }), HISTORY_DEADLINE_MS),
  userTrades: (e: Engine, address: string, limit = 100) =>
    direct('trades', () => account.trades(e, address, { limit }), HISTORY_DEADLINE_MS),
  fundingHistory: (address: string, limit = 100) =>
    direct('fundings', () => account.fundingHistory(address, { limit }), HISTORY_DEADLINE_MS),
  feeRate: (e: Engine, address: string) => direct('fee-rate', () => account.feeRate(e, address)),

  // keys: read-only. Trading keys are created, kept and used in the browser
  // (trading/session.ts) - no Valuescan server holds or sees one.
  walletAccount: (address: string) => direct('wallet account', () => walletAccount(address)),

  // trading: signed in this browser and sent straight to SoDEX (trading/actions.ts).
  // Loaded on first use, so the signing code only downloads for people who trade.
  placeOrder: (e: Engine, b: PlaceOrderInput) => trading().then((m) => m.placeOrder(e, b)),
  cancelOrder: (e: Engine, b: { symbol: string; orderID?: number; clOrdID?: string }) =>
    trading().then((m) => m.cancelOrder(e, b)),
  cancelAll: (e: Engine, symbol?: string) => trading().then((m) => m.cancelAll(e, symbol)),
  modifyOrder: (b: { symbol: string; orderID?: number; clOrdID?: string; price?: string; quantity?: string; stopPrice?: string }) =>
    trading().then((m) => m.modifyOrder(b)),
  replaceOrder: (e: Engine, b: { symbol: string; origOrderID?: number; origClOrdID?: string; price?: string; quantity?: string }) =>
    trading().then((m) => m.replaceOrder(e, b)),
  /** Change a resting order: modify (TP/SL), replace (plain limit), or cancel + new with the builder - trading/actions.ts changeOrder. */
  changeOrder: (e: Engine, ref: { symbol: string; orderID?: number; clOrdID?: string }, change: { price?: string; quantity?: string; stopPrice?: string }) =>
    trading().then((m) => m.changeOrder(e, ref, change)),
  setLeverage: (symbol: string, leverage: number, marginMode: 'isolated' | 'cross') =>
    trading().then((m) => m.setLeverage(symbol, leverage, marginMode)),
  adjustMargin: (symbol: string, amount: string) => trading().then((m) => m.adjustMargin(symbol, amount)),
  scheduleCancel: (e: Engine, afterMs?: number) => trading().then((m) => m.scheduleCancel(e, afterMs)),

  // money
  moneyOverview: (address: string) => direct<any>('money overview', () => moneyOverview(address)),
  coins: () => direct('coins', () => market.coins()),
  /** Spot <-> perps between your own accounts; signed here with the trading key. */
  transferCross: (direction: string, coinId: number, amount: string) =>
    trading().then((m) => m.transferCross(direction, coinId, amount)),
  /** To your own wallet on ValueChain - the only destination SoDEX pays out to. */
  withdraw: (b: { engine?: Engine; coinId: number; amount: string }) => trading().then((m) => m.withdraw(b)),
  resolveDestination: (id: number) =>
    get<{
      accountId: number;
      verified: boolean;
      address: string | null;
      isYourOwnAddress: boolean | null;
      advisory: string;
    }>(`/api/money/resolve-destination${qs({ id: String(id) })}`),
  // deposits (on-chain, via ValueChain)
  /** ValueChain's parameters for the wallet (static per network; no request). */
  depositChain: () => direct('deposit chain', async () => depositChainParams()),
  depositAssets: (address: string) =>
    get<{
      assets: DepositAsset[];
      warnings: string[];
      exchange: string;
      registered: boolean;
      accountId: number | null;
      registrationNote: string | null;
    }>(`/api/deposit/assets${qs({ address })}`),
  prepareDeposit: (address: string, coinId: number, amount: string) =>
    post<PreparedDeposit>('/api/deposit/prepare', { address, coinId, amount }),
  depositTx: (hash: string) =>
    get<{ hash: string; status: string; explorerUrl: string | null }>(`/api/deposit/tx/${hash}`),
  depositStatus: (address: string) => get<any>(`/api/deposit/status${qs({ address })}`),
  /**
   * Cross-chain deposit addresses, cross-checked against ValueChain's registries -
   * built in this browser (exchange/deposits.ts) with the server's own rules.
   * SoDEX's issuer may CREATE a new wallet's addresses on this read, as before.
   */
  depositOptions: (address: string) =>
    direct('deposit options', () => deposits.options(address) as Promise<{
      address: string;
      assets: MirrorAsset[];
      rejected: Array<{ chain: string; reason: string }>;
      allVerified: boolean;
      registry: { address: string; chainId: number };
    }>, 60_000),
  /** sodex.com's "Confirm & Update Address" - only for an address SoDEX flagged. */
  replaceDepositAddress: (address: string, chain: string) =>
    direct('replace deposit address', async () => {
      await deposits.replace(address, chain);
      return { ok: true as const };
    }, 30_000),
};

// --- browser-side answers to what used to be server routes ---------------------------------

/** Balances on both engines, side by side (what /api/money/overview answered). */
async function moneyOverview(address: string) {
  const [spot, perps, coinList] = await Promise.all([
    account.balances('spot', address).then((r) => r.balances).catch(() => [] as any[]),
    account.balances('perps', address).then((r) => r.balances).catch(() => [] as any[]),
    market.coins().then((r) => r.coins).catch(() => [] as Array<{ id: number; name: string; precision: number }>),
  ]);
  return { address, spot, perps, coins: coinList };
}

/** What /api/wallet/account answered: both engines' state and the registered API keys. */
async function walletAccount(address: string): Promise<WalletAccount> {
  const [spot, perps, keys] = await Promise.all([
    account.state('spot', address).then((r) => r.state).catch(() => null),
    account.state('perps', address).then((r) => r.state).catch(() => null),
    account.apiKeys('spot', address).then((r) => (Array.isArray(r.apiKeys) ? r.apiKeys : [])).catch(() => []),
  ]);
  const accountId = spot?.aid || perps?.aid || 0;
  return {
    address,
    accountId,
    exists: accountId !== 0,
    network: network(),
    apiKeys: (keys as any[]).map((k) => ({ name: k.name, type: k.type, publicKey: k.publicKey, expiresAt: k.expiresAt, permissions: k.permissions })),
    spotState: spot,
    perpsState: perps,
  };
}

/** ValueChain for this network, in /api/deposit/chain's shape. */
function depositChainParams(): DepositChain {
  const c = CHAINS[network()];
  return {
    chainId: c.chainId,
    chainIdHex: '0x' + c.chainId.toString(16),
    name: c.name,
    rpcUrl: c.rpcUrl,
    explorerUrl: c.explorerUrl,
    nativeCurrency: c.nativeCurrency,
    exchange: c.exchange,
  };
}

const num = (v: unknown): number => {
  const n = Number.parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

/**
 * "Where is this user, and what is the next step?" - /api/onboarding, answered
 * here from the gateway (whose `aid` agrees exactly with the exchange
 * contract's getUserId) and ValueChain's RPC, with the trading key this
 * browser holds (trading/session.ts).
 */
async function onboardingState(address?: string): Promise<OnboardingState> {
  const hasWallet = Boolean(address && /^0x[0-9a-fA-F]{40}$/.test(address));
  const chain = CHAINS[network()];
  const [spot, perps, gasWei] = hasWallet
    ? await Promise.all([
        account.state('spot', address!).then((r) => r.state).catch(() => null),
        account.state('perps', address!).then((r) => r.state).catch(() => null),
        rpcCall<string>(chain.rpcUrl, 'eth_getBalance', [address!, 'latest']).then((r) => (r.result ? BigInt(r.result) : 0n)).catch(() => 0n),
      ])
    : [null, null, 0n];
  const accountId = Number(spot?.aid || perps?.aid || 0) || null;
  const registered = accountId !== null;
  const funded =
    (spot?.B ?? []).some((b: any) => num(b?.t ?? b?.total) > 0) ||
    (perps?.B ?? []).some((b: any) => num(b?.t ?? b?.total) > 0) ||
    num(perps?.av) > 0;
  const { session } = sessionInfoOf(getTradingState()) as { session: SessionInfo['session'] };
  const unlocked = Boolean(session);
  const perms = session?.permissions ?? 0;
  const names = unlocked ? (sessionInfoOf(getTradingState()) as SessionInfo).permissionNames : [];
  const gas = formatUnits(gasWei, chain.nativeCurrency.decimals);
  const steps: OnboardingStep[] = [
    {
      id: 'wallet', title: 'Connect a wallet', done: hasWallet, blocked: false,
      detail: hasWallet ? `Connected as ${address}` : 'Use a browser extension or pair a phone wallet with WalletConnect.',
      action: hasWallet ? undefined : 'connect',
    },
    {
      id: 'account', title: 'SoDEX account', done: registered, blocked: false,
      detail: registered
        ? `Registered on-chain as account #${accountId}`
        : hasWallet
          ? 'This wallet has no SoDEX account yet. Its first deposit of USDC or SOSO creates it (SoDEX keeps 1 USDC / 1 SOSO as a one-time activation fee) - from another network or from ValueChain, right here.'
          : 'Connect a wallet first.',
      action: hasWallet && !registered ? 'create-account' : undefined,
    },
    {
      id: 'key', title: 'Enable trading', done: unlocked, blocked: false,
      detail: unlocked
        ? `Enabled — you can ${names.join(', ')}`
        : registered
          ? 'One click and one wallet signature. The trading key stays in this browser; your wallet key is never read.'
          : 'Available once the account exists.',
      action: registered && !unlocked ? 'enable' : undefined,
    },
    {
      id: 'funds', title: 'Fund the account', done: funded, blocked: false,
      detail: funded
        ? 'Balance available to trade.'
        : registered
          ? `Deposit on ${chain.name}. Your wallet holds ${gas} ${chain.nativeCurrency.symbol} for gas.`
          : 'Available once the account exists.',
      action: registered && !funded ? 'deposit' : undefined,
    },
  ];
  const next = steps.find((s) => !s.done);
  return {
    network: network(),
    address: hasWallet ? address! : null,
    accountId,
    registered,
    unlocked,
    permissions: perms,
    permissionNames: names,
    canTrade: unlocked,
    canTransfer: unlocked,
    canWithdraw: unlocked,
    funded,
    gasBalance: gas,
    steps,
    nextStep: next?.id ?? null,
    ready: steps.every((s) => s.done),
  };
}
