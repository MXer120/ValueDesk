/** Typed client for the local backend. */
import { logger } from './log';

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

// --- all-time stats (mirrors server/src/routes/stats.ts) --------------------

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

/** The browser-trading module, loaded on first use (see placeOrder below). */
const trading = () => import('./trading/actions');

export const api = {
  health: () => get<any>('/api/health'),
  onboarding: (address?: string) => get<OnboardingState>(`/api/onboarding${qs({ address })}`),
  statsAllTime: (address: string, rebuild = false) =>
    get<StatsResponse>(`/api/stats/all-time${qs({ address, rebuild: rebuild ? 1 : undefined })}`),

  // market data
  symbols: (e: Engine) => get<{ symbols: Symbol[] }>(`/api/md/${e}/symbols`),
  tickers: (e: Engine) => get<{ tickers: Ticker[] }>(`/api/md/${e}/tickers`),
  markPrices: () => get<{ markPrices: any[] }>('/api/md/perps/mark-prices'),
  orderbook: (e: Engine, symbol: string, limit = 20) =>
    get<{ book: OrderBook }>(`/api/md/${e}/orderbook${qs({ symbol, limit })}`),
  klines: (e: Engine, symbol: string, interval: string, limit = 300) =>
    get<{ klines: Kline[] }>(`/api/md/${e}/klines${qs({ symbol, interval, limit })}`),
  publicTrades: (e: Engine, symbol: string, limit = 50) =>
    get<{ trades: PublicTrade[] }>(`/api/md/${e}/trades${qs({ symbol, limit })}`),

  // account
  state: (e: Engine, address: string) => get<any>(`/api/acct/${e}/state${qs({ address })}`),
  balances: (e: Engine, address: string) => get<any>(`/api/acct/${e}/balances${qs({ address })}`),
  openOrders: (e: Engine, address: string, symbol?: string) =>
    get<{ orders: any[] }>(`/api/acct/${e}/orders${qs({ address, symbol })}`),
  positions: (address: string) => get<{ positions: any[] }>(`/api/acct/perps/positions${qs({ address })}`),
  orderHistory: (e: Engine, address: string, limit = 100) =>
    get<{ orders: any[] }>(`/api/acct/${e}/orders/history${qs({ address, limit })}`),
  userTrades: (e: Engine, address: string, limit = 100) =>
    get<{ trades: any[] }>(`/api/acct/${e}/trades${qs({ address, limit })}`),
  fundingHistory: (address: string, limit = 100) =>
    get<{ funding: any[] }>(`/api/acct/perps/funding-history${qs({ address, limit })}`),
  feeRate: (e: Engine, address: string) => get<any>(`/api/acct/${e}/fee-rate${qs({ address })}`),

  // keys: read-only. Trading keys are created, kept and used in the browser
  // (trading/session.ts) - no Valuescan server holds or sees one.
  walletAccount: (address: string) => get<WalletAccount>(`/api/wallet/account${qs({ address })}`),

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
  setLeverage: (symbol: string, leverage: number, marginMode: 'isolated' | 'cross') =>
    trading().then((m) => m.setLeverage(symbol, leverage, marginMode)),
  adjustMargin: (symbol: string, amount: string) => trading().then((m) => m.adjustMargin(symbol, amount)),
  scheduleCancel: (e: Engine, afterMs?: number) => trading().then((m) => m.scheduleCancel(e, afterMs)),

  // money
  moneyOverview: (address: string) => get<any>(`/api/money/overview${qs({ address })}`),
  coins: () => get<{ coins: Array<{ id: number; name: string; precision: number }> }>('/api/money/coins'),
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
  depositChain: () => get<DepositChain>('/api/deposit/chain'),
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
  depositOptions: (address: string) =>
    get<{
      address: string;
      assets: MirrorAsset[];
      rejected: Array<{ chain: string; reason: string }>;
      allVerified: boolean;
      registry: { address: string; chainId: number };
    }>(`/api/mirror/deposit-options${qs({ address })}`),
  /** sodex.com's "Confirm & Update Address" - only for an address SoDEX flagged. */
  replaceDepositAddress: (address: string, chain: string) => post<{ ok: true }>('/api/mirror/replace-deposit-address', { address, chain }),
};
