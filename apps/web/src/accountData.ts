/**
 * The account's history, read straight from SoDEX - and the one account-state
 * figure the portfolio derives (margin usage).
 *
 * WHERE EACH HISTORY COMES FROM (all reads, no signature, verified live on
 * mainnet 2026-09-26 against a public address before a column was written)
 * --------------------------------------------------------------------------
 *   Order history     GET gateway /api/v1/{spot|perps}/accounts/{addr}/orders/history
 *   Trade history     GET gateway /api/v1/{spot|perps}/accounts/{addr}/trades
 *   Funding payments  GET gateway /api/v1/perps/accounts/{addr}/fundings
 *   Position history  GET gateway /api/v1/perps/accounts/{addr}/positions/history
 *   Deposits and withdrawals
 *                     POST alpha-biz /biz/mirror/account_flow
 *   EVM <-> Spot transfers, native SOSO moves, stakes, airdrops
 *                     POST alpha-biz /biz/mirror/v2/combined_transfers
 * The two alpha-biz calls are POSTs but reads: sodex.com's own history page
 * issues exactly these bodies (features bundle, `fetchAccountFlow` and
 * `fetchCombinedTransfers`), and CORS reflects our origin.
 *
 * WHY THE GATEWAY AND NOT THE BACKEND. The backend's /api/acct/* history routes
 * spend its SHARED upstream weight budget - the one whose exhaustion once took
 * the app down (server/src/sodex/rest.ts) - and the web client cannot page
 * them (api.ts passes only `limit`). The gateway serves these reads with open
 * CORS, from the user's own IP and budget, the same way trading/actions.ts and
 * trading/funds.ts already read account state. Paging is by `endTime`.
 *
 * PAGING. Every gateway history answers newest first and filters `endTime`
 * INCLUSIVELY on the row's creation time (measured: an order page with
 * endTime = the 2nd row's createdAt starts again at that row). So the next
 * page's cursor is the OLDEST creation time on this page, and the overlap row
 * it brings back is dropped by id. A page shorter than the limit is the end.
 *
 * WHAT HAS NO SOURCE. Transfers between Spot and Perps: neither the gateway,
 * alpha-biz nor SoDEX's data API publishes them, and sodex.com's own history
 * does not list them either. Nothing here reconstructs them.
 *
 * Everything below `// --- readers` is pure and covered by accountData.test.ts.
 */
import { localize } from './numStyle';
import { tradingConfig } from './trading/config';
import { account } from './exchange/sodexAccount';
import type { HistoryPriority } from './exchange/historyQueue';

export type HistoryEngine = 'spot' | 'perps';

// --- paging ------------------------------------------------------------------

/** One page of a history, and where the next one starts (null: this was the last). */
export interface HistoryPage<T> {
  rows: T[];
  next: number | null;
  /**
   * Set when SoDEX refused or failed and the backend answered with the last
   * good copy of this page instead (ms epoch of when that copy was read).
   */
  staleAt?: number | null;
}

/** Rows per gateway page. Weight is 20 + limit/20 upstream, so 100 costs 25. */
export const HISTORY_PAGE = 100;

/** A number from a JSON field that may be a string, or NaN. */
const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const field = (obj: unknown, ...names: string[]): unknown => {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const name of names) {
    const v = o[name];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/**
 * The next page's `endTime`: the oldest creation time on this page. null when
 * the page was short (the history ends here) or carries no usable time.
 */
export function nextCursor<T>(rows: T[], timeOf: (r: T) => number, limit: number): number | null {
  if (rows.length < limit) return null;
  let min = Infinity;
  for (const r of rows) {
    const t = timeOf(r);
    if (Number.isFinite(t) && t > 0 && t < min) min = t;
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * Two lists of the same history, merged: one row per id (the INCOMING copy wins
 * - it is the fresher read of e.g. an order that has since filled), newest
 * first. Ties keep a stable order by id so rows do not swap on every refresh.
 */
export function mergeRows<T>(existing: T[], incoming: T[], idOf: (r: T) => string, timeOf: (r: T) => number): T[] {
  const byId = new Map<string, T>();
  for (const r of existing) byId.set(idOf(r), r);
  for (const r of incoming) byId.set(idOf(r), r);
  return [...byId.values()].sort((a, b) => {
    const d = (timeOf(b) || 0) - (timeOf(a) || 0);
    return d !== 0 ? d : idOf(a) < idOf(b) ? 1 : idOf(a) > idOf(b) ? -1 : 0;
  });
}

/** How many of `incoming` are not already in `existing` - zero means paging has stopped moving. */
export function countNew<T>(existing: T[], incoming: T[], idOf: (r: T) => string): number {
  const have = new Set(existing.map(idOf));
  return incoming.filter((r) => !have.has(idOf(r))).length;
}

// --- gateway histories -------------------------------------------------------

/**
 * The four gateway histories: path, row id, and the time the gateway filters
 * `endTime` on. Field names are the gateway's own, as observed:
 *   order     symbol orderID clOrdID side type timeInForce price origQty status
 *             executedQty executedValue createdAt updatedAt [positionSide reduceOnly]
 *   trade     symbol tradeID orderID clOrdID side price quantity fee feeCoin time isMaker
 *   funding   symbol positionID positionSide fundingFee feeCoin timestamp
 *   position  id symbol marginMode positionSide size initialMargin avgEntryPrice
 *             cumTradingFee cumClosedSize avgClosePrice maxSize realizedPnL
 *             leverage active createdAt updatedAt ...
 */
export type HistoryKind = 'orders' | 'trades' | 'funding' | 'positions';

export interface HistorySpec {
  /** Gateway-relative path without the query string. */
  path: (engine: HistoryEngine, address: string) => string;
  idOf: (r: any) => string;
  /** The creation time `endTime` filters on - also the cursor. */
  timeOf: (r: any) => number;
  /** Spot has no funding and no positions. */
  perpsOnly: boolean;
}

export const HISTORY: Record<HistoryKind, HistorySpec> = {
  orders: {
    path: (e, a) => `/api/v1/${e}/accounts/${a}/orders/history`,
    idOf: (r) => String(r?.orderID ?? r?.orderId ?? `${r?.clOrdID}:${r?.createdAt}`),
    timeOf: (r) => n(r?.createdAt),
    perpsOnly: false,
  },
  trades: {
    path: (e, a) => `/api/v1/${e}/accounts/${a}/trades`,
    // NOT `tradeID` alone: it is unique per market, not per account (measured -
    // server historyRows.ts found 1000 fills on one page under 989 tradeIDs), so
    // two fills on two markets can share one, and one of them would vanish from
    // the table. With the order too: both sides of a trade against oneself are two rows.
    idOf: (r) =>
      r?.tradeID !== undefined && r?.tradeID !== null
        ? `${r?.symbol}:${r.tradeID}:${r?.orderID}`
        : `${r?.orderID}:${r?.time}:${r?.quantity}`,
    timeOf: (r) => n(r?.time),
    perpsOnly: false,
  },
  funding: {
    path: (_e, a) => `/api/v1/perps/accounts/${a}/fundings`,
    // A funding record has no id of its own; one position is charged once per
    // funding timestamp, so the pair is unique.
    idOf: (r) => `${r?.positionID}:${r?.timestamp}:${r?.symbol}`,
    timeOf: (r) => n(r?.timestamp),
    perpsOnly: true,
  },
  positions: {
    path: (_e, a) => `/api/v1/perps/accounts/${a}/positions/history`,
    idOf: (r) => String(r?.id),
    timeOf: (r) => n(r?.createdAt),
    perpsOnly: true,
  },
};

/** The query string for one page. */
export function historyQuery(limit: number, endTime: number | null): string {
  const p = new URLSearchParams({ limit: String(limit) });
  if (endTime !== null) p.set('endTime', String(endTime));
  return `?${p.toString()}`;
}

/** The gateway answers a bare array; tolerate `{ <kind>: [...] }` too rather than render nothing. */
function asList(data: unknown, key: string): any[] {
  if (Array.isArray(data)) return data;
  const inner = (data as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? inner : [];
}

// --- account ledger (deposits, withdrawals, transfers) -----------------------

export type LedgerKind = 'deposit' | 'withdraw' | 'evm-to-spot' | 'spot-to-evm' | 'stake' | 'sent' | 'received' | 'reward';
export type LedgerState = 'pending' | 'completed' | 'failed' | 'refunded' | 'review';

export interface LedgerRow {
  id: string;
  /** ms. */
  time: number;
  kind: LedgerKind;
  label: string;
  coin: string;
  /** Decimal string in whole coins; null when the raw amount was unreadable. */
  amount: string | null;
  /** What SoDEX kept as its withdrawal fee, in whole coins. */
  fee: string | null;
  /** SoDEX chain key (BASE_ETH, BSC_BNB, VALUECHAIN, ...). */
  chain: string;
  state: LedgerState;
  /** Requested / Sending / Completed / Failed ... - sodex.com's own steps, in words. */
  status: string;
  /** SoDEX's own status word before we rename it: Depositing, Reporting, Success, Suspicious, ... */
  rawStatus?: string;
  /**
   * The transaction worth linking: for a withdrawal the payout on the
   * DESTINATION chain (null until SoDEX has sent it), for a deposit the
   * transfer on the source chain, for a ValueChain move its ValueChain tx.
   */
  tx: string | null;
  txChain: string;
  /** The ValueChain transaction that started it, where that is a different tx. */
  valueChainTx: string | null;
}

/**
 * An integer amount in base units as a decimal string of whole coins, exact
 * (no float): "82386414" at 6 decimals -> "82.386414". null for anything that
 * is not a non-negative integer string.
 */
export function fromUnits(raw: unknown, decimals: number): string | null {
  const s = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(s) || !Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals === 0) return s.replace(/^0+(?=\d)/, '');
  const padded = s.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '');
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Seconds or ms -> ms (alpha-biz mixes both). */
export const toMs = (t: unknown): number => {
  const v = n(t);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v < 1e12 ? v * 1000 : v;
};

/**
 * account_flow status words -> our label. sodex.com's own step map
 * (`xNe`): Depositing 1/2, Reporting 2/2; Requesting 1/3, Withdrawing 2/3,
 * Settling 3/3; Success; Failed; Refunding/Refunded; Suspicious. Named as the
 * withdraw sheet already names a withdrawal's progress (trading/relay.ts):
 * Requested -> Sending -> Completed | Failed.
 */
export function flowStatus(kind: 'deposit' | 'withdraw', raw: unknown): { state: LedgerState; status: string } {
  const s = String(raw ?? '');
  switch (s) {
    case 'Success':
    case 'Completed':
      return { state: 'completed', status: 'Completed' };
    case 'Failed':
      return { state: 'failed', status: 'Failed' };
    case 'Refunding':
      return { state: 'pending', status: 'Refunding' };
    case 'Refunded':
      return { state: 'refunded', status: 'Refunded' };
    case 'Suspicious':
      return { state: 'review', status: 'Under review' };
    case 'Requesting':
      return { state: 'pending', status: 'Requested' };
    case 'Withdrawing':
    case 'Settling':
      return { state: 'pending', status: 'Sending' };
    case 'Depositing':
    case 'Reporting':
    case 'Pending':
    case 'Processing':
      return { state: 'pending', status: kind === 'withdraw' ? 'Sending' : 'Pending' };
    default:
      return { state: 'pending', status: s || 'Pending' };
  }
}

/** One `account_flow` row (a deposit into or a withdrawal out of SoDEX), or null if unreadable. */
export function mapAccountFlow(r: any): LedgerRow | null {
  if (!r || typeof r !== 'object') return null;
  const type = String(r.type ?? '');
  const kind: 'deposit' | 'withdraw' | null = /withdraw/i.test(type) ? 'withdraw' : /deposit/i.test(type) ? 'deposit' : null;
  if (!kind) return null;
  const decimals = Number.isInteger(r.decimals) ? r.decimals : Number.parseInt(String(r.decimals ?? ''), 10);
  const dec = Number.isFinite(decimals) ? decimals : 18;
  const chain = String(r.chain || 'VALUECHAIN');
  const { state, status } = flowStatus(kind, r.status);
  const origin = typeof r.originTxHash === 'string' && r.originTxHash ? r.originTxHash : null;
  const vc = typeof r.txHash === 'string' && r.txHash ? r.txHash : null;
  return {
    id: `flow:${kind}:${r.withdrawId ?? vc ?? origin ?? `${r.stmp}:${r.amount}`}`,
    // stmp is when it was created; statusTime when it last moved.
    time: toMs(r.stmp) || toMs(r.statusTime),
    kind,
    label: kind === 'withdraw' ? 'Withdrawal' : 'Deposit',
    coin: String(r.displaySymbol || r.coin || r.token || '?'),
    amount: fromUnits(r.amount, dec),
    fee: kind === 'withdraw' && r.withdrawFee ? fromUnits(r.withdrawFee, dec) : null,
    chain,
    state,
    status,
    rawStatus: String(r.status ?? ''),
    // Withdrawal: originTxHash is the payout on the destination chain, txHash the
    // ValueChain transaction that asked for it. Deposit: originTxHash is the
    // transfer on the source chain.
    tx: kind === 'withdraw' ? origin : origin ?? vc,
    txChain: chain,
    valueChainTx: kind === 'withdraw' ? vc : null,
  };
}

/** ValueChain token (lower-case address) -> what it is. */
export type TokenBook = Map<string, { symbol: string; decimals: number }>;

/** Native SOSO, under both spellings combined_transfers uses for it. */
const NATIVE_SOSO: Record<string, { symbol: string; decimals: number }> = {
  '0x0000000000000000000000000000000000000000': { symbol: 'SOSO', decimals: 18 },
  '0x5050505050505050505050505050505050505050': { symbol: 'SOSO', decimals: 18 },
};

const REWARD_LABEL: Record<string, string> = {
  airdrop: 'Airdrop',
  referral_reward: 'Referral reward',
  vote_reward: 'Vote reward',
};

/**
 * One `combined_transfers` row: a ValueChain-side move. Labels follow sodex.com
 * (`bNe`): a fund transfer is EVM -> Spot unless transferType is 2, or a reward
 * when actionType says so; a native transfer is a stake, or SOSO sent/received.
 */
export function mapFundTransfer(r: any, account: string, tokens: TokenBook): LedgerRow | null {
  if (!r || typeof r !== 'object' || !r.txHash) return null;
  const asset = String(r.assetAddress ?? '').toLowerCase();
  const tok = tokens.get(asset) ?? NATIVE_SOSO[asset];
  const action = String(r.actionType ?? '');
  const me = account.toLowerCase();
  let kind: LedgerKind;
  let label: string;
  if (r.source === 'native_transfer') {
    if (action === 'stake') { kind = 'stake'; label = 'Stake'; }
    else if (action === 'deposit') { kind = 'evm-to-spot'; label = 'EVM → Spot'; }
    else if (action === 'withdraw') { kind = 'spot-to-evm'; label = 'Spot → EVM'; }
    else if (String(r.sender ?? '').toLowerCase() === me) { kind = 'sent'; label = 'Sent'; }
    else { kind = 'received'; label = 'Received'; }
  } else if (REWARD_LABEL[action]) {
    kind = 'reward';
    label = REWARD_LABEL[action];
  } else if (Number(r.transferType) === 2) {
    kind = 'spot-to-evm';
    label = 'Spot → EVM';
  } else {
    kind = 'evm-to-spot';
    label = 'EVM → Spot';
  }
  return {
    id: `vc:${r.txHash}:${asset}:${r.amount}`,
    time: toMs(r.blockTimestamp),
    kind,
    label,
    // An unlisted token keeps its address rather than a guessed name.
    coin: tok?.symbol ?? (asset ? `${asset.slice(0, 6)}…${asset.slice(-4)}` : '?'),
    amount: fromUnits(r.amount, tok?.decimals ?? 18),
    fee: null,
    chain: 'VALUECHAIN',
    state: 'completed',
    status: 'Completed',
    tx: String(r.txHash),
    txChain: 'VALUECHAIN',
    valueChainTx: null,
  };
}

/**
 * Two paged sources on one timeline.
 *
 * Deposits/withdrawals and ValueChain transfers come from two separately paged
 * lists. Showing everything loaded would let a later page of one list drop rows
 * ABOVE rows already on screen from the other - history that rewrites itself
 * as you scroll. So a row is shown only once it is certainly in place: newer
 * than or equal to the FRONTIER, the oldest point every unfinished source has
 * reached. `pull` names the source(s) holding the frontier back - the ones
 * "Load more" should fetch next.
 */
export interface TimelineSource<T> {
  rows: T[];
  done: boolean;
}

export function timeline<T>(
  sources: TimelineSource<T>[],
  timeOf: (r: T) => number,
): { rows: T[]; pull: number[]; more: boolean } {
  let frontier = -Infinity;
  const oldest = sources.map((s) => (s.rows.length ? Math.min(...s.rows.map(timeOf)) : Infinity));
  sources.forEach((s, i) => {
    if (!s.done) frontier = Math.max(frontier, oldest[i]!);
  });
  const rows = sources
    .flatMap((s) => s.rows)
    .filter((r) => timeOf(r) >= frontier)
    .sort((a, b) => timeOf(b) - timeOf(a));
  const pull = sources.map((s, i) => (!s.done && oldest[i] === frontier ? i : -1)).filter((i) => i >= 0);
  return { rows, pull, more: sources.some((s) => !s.done) };
}

/** Where a transaction on a SoDEX chain key can be looked at, or null. */
const EXPLORERS: Record<string, string> = {
  VALUECHAIN: 'https://main-scan.valuechain.xyz',
  ETH: 'https://etherscan.io',
  BASE_ETH: 'https://basescan.org',
  ARBITRUM_ETH: 'https://arbiscan.io',
  BSC_BNB: 'https://bscscan.com',
  MATIC: 'https://polygonscan.com',
  AVAXC: 'https://snowtrace.io',
  SOL: 'https://solscan.io',
};

export function txUrl(chain: string, hash: string | null): string | null {
  if (!hash) return null;
  const base = EXPLORERS[chain];
  // Solana signatures are base58; everything else here is a 0x hash.
  if (!base || (chain !== 'SOL' && !/^0x[0-9a-fA-F]{64}$/.test(hash))) return null;
  return `${base}/tx/${hash}`;
}

// --- margin usage ------------------------------------------------------------

export interface MarginUsage {
  /** av - account value (collateral plus unrealised PnL). */
  accountValue: number;
  /** av - am: everything that is not available margin. */
  inUse: number;
  /** inUse / av; null when there is no account value to divide by. */
  ratio: number | null;
  /** cm + im: held by open positions (cross and isolated). */
  positions: number;
  /** oim + ocm: held by resting orders. */
  orders: number;
  /** am. `ami` is the isolated view of this same available margin, not a second pile. */
  available: number;
  /** Full collateral value minus haircut value (sum of wb×px − sum of wm). Equity that is not margin. */
  haircut: number;
}

/**
 * Margin usage from the perps account state.
 *
 * `av = am + cm + im + oim + ocm + haircut`. `ami` is not added: on a USDC
 * account it equals `am`, and on a multi-asset account it is the USDC slice
 * already inside `am`. Adding it made the identity fail by about −ami
 * (measured −81 on a scanned account, and −am on live leaderboard accounts).
 * The haircut is the part of collateral SoDEX does not count as margin
 * (a QQQ row at 80% leaves av − am equal to that 20%).
 *
 * Can exceed 100%: an account whose losses have eaten into its margin has a
 * negative `am`, and saying "100%" there would hide exactly the state that
 * matters.
 */
const USDC_NAME = /^(v)?usdc$/i;

/** SoDEX spells the margin coin `vUSDC`. Both names are that one dollar. */
export const isUsdcCoin = (coin: string | undefined | null): boolean => USDC_NAME.test(coin ?? '');

/**
 * A balance row's margin contribution, in USD.
 *
 * SoDEX's own field is `wm` ("wallet balance corresponding margin"): the
 * balance already multiplied by the index price and the collateral ratio.
 * USDC's ratio is 100%, so `wm` equals the balance. Every other coin is
 * `balance × index price × collateral ratio`. Live accounts send `mr` as a
 * fraction (`"1"` is 100% on USDC, not 1%). A value above 1 is the schema's
 * percentage form. Without
 * `wm` and without a ratio, a non-USDC row is not guessed at — a haircut we
 * invent would overstate the margin.
 */
export function rowMarginUsd(row: unknown): number | null {
  if (!row || typeof row !== 'object') return null;
  const wm = field(row, 'wm');
  if (wm !== undefined && wm !== null && wm !== '') {
    const v = n(wm);
    return Number.isFinite(v) ? v : null;
  }
  const coin = String(field(row, 'a', 'coin', 'name') ?? '');
  const bal = n(field(row, 'wb', 't', 'total'));
  if (!Number.isFinite(bal)) return null;
  if (isUsdcCoin(coin)) return bal;
  const px = n(field(row, 'px', 'price'));
  const ratio = collateralRatio(field(row, 'mr', 'marginRatio'));
  if (!(px > 0) || ratio === null) return null;
  return bal * px * ratio;
}

/**
 * `mr` on a balance is a percentage (90 = 90%). The coins metadata publishes
 * the same ratio as a fraction (0.9). Above 1 it is a percentage.
 */
export function collateralRatio(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = n(raw);
  if (!Number.isFinite(v) || v < 0) return null;
  return v > 1 ? v / 100 : v;
}

/**
 * The collateral ratio as a percent label ("90%"). Coins metadata publishes a
 * fraction (0.9); a value above 1 is the percentage form. USDC with nothing
 * published is 100%. Any other coin with no ratio stays blank — a haircut we
 * invent would be wrong.
 */
export function formatCollateralRatio(raw: unknown, coin?: string): string | null {
  const missing = raw === undefined || raw === null || raw === '';
  const parsed = missing ? null : collateralRatio(raw);
  const frac = parsed !== null && parsed > 0 ? parsed : coin && isUsdcCoin(coin) ? 1 : null;
  if (frac === null) return null;
  const pct = Math.round(frac * 10000) / 100;
  const text = Math.abs(pct - Math.round(pct)) < 1e-9
    ? String(Math.round(pct))
    : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${localize(text)}%`;
}

export interface CollateralSplit {
  /** USDC contribution + every other coin's haircut contribution. */
  marginBalance: number | null;
  usdc: number | null;
  /** Non-USDC collateral after SoDEX's collateral ratio. Null if a coin could not be valued. */
  multi: number | null;
}

/**
 * Margin balance split the way SoDEX defines multi-asset margin: USDC at
 * 100%, every other coin at `balance × index × collateral ratio`, and only
 * for balances sitting in the perps account. A coin we cannot value makes
 * `multi` and the total null rather than a partial sum presented as the whole.
 */
export function collateralSplit(balances: unknown): CollateralSplit {
  const rows = Array.isArray(balances) ? balances : [];
  let usdc = 0;
  let multi = 0;
  let sawUsdc = false;
  let sawOther = false;
  let gap = false;
  for (const row of rows) {
    const coin = String(field(row, 'a', 'coin', 'name') ?? '');
    const bal = n(field(row, 'wb', 't', 'total'));
    if (!(bal > 0) && !field(row, 'wm')) continue;
    const contrib = rowMarginUsd(row);
    if (contrib === null) {
      if (!isUsdcCoin(coin)) gap = true;
      continue;
    }
    if (isUsdcCoin(coin)) {
      usdc += contrib;
      sawUsdc = true;
    } else {
      multi += contrib;
      sawOther = true;
    }
  }
  if (!sawUsdc && !sawOther && !gap) return { marginBalance: null, usdc: null, multi: null };
  return {
    usdc: sawUsdc ? usdc : 0,
    multi: gap ? null : multi,
    marginBalance: gap ? null : usdc + multi,
  };
}

/**
 * Cross margin ratio: maintenance margin / cross account value.
 * The gateway's `mmr` is that fraction (Portfolio.tsx checks `mmr ≈ mm/av`).
 */
export function crossMarginRatio(state: unknown): number | null {
  const s = state as Record<string, unknown> | null | undefined;
  if (!s) return null;
  const given = field(s, 'mmr');
  if (given !== undefined && given !== null && given !== '') {
    const n = collateralRatio(given);
    if (n !== null) return n;
  }
  const mm = n(s.mm);
  const av = n(s.av);
  if (!(av > 0) || !Number.isFinite(mm)) return null;
  return mm / av;
}

/**
 * Cross account leverage: notional of CROSS positions / cross account value.
 * Isolated positions are not in the cross pool. Null when a cross position
 * has no mark — leaving it out would print a leverage smaller than the real one.
 */
export function crossAccountLeverage(
  state: unknown,
  markOf: (symbol: string) => number | null,
): number | null {
  const s = state as { av?: unknown; P?: unknown } | null | undefined;
  if (!s) return null;
  const av = n(s.av);
  if (!(av > 0)) return av === 0 ? null : null;
  const rows = Array.isArray(s.P) ? s.P : [];
  let notional = 0;
  let any = false;
  for (const p of rows) {
    const mode = String(field(p, 'm', 'marginMode') ?? 'CROSS').toUpperCase();
    if (mode === 'ISOLATED' || mode === '1') continue;
    const sz = Math.abs(n(field(p, 'sz', 'size', 'q')));
    if (!(sz > 0)) continue;
    const symbol = String(field(p, 's', 'symbol') ?? '');
    const mark = markOf(symbol);
    if (mark === null || !(mark > 0)) return null;
    notional += sz * mark;
    any = true;
  }
  if (!any) return 0;
  return notional / av;
}

export function marginUsage(state: unknown): MarginUsage | null {
  const s = state as Record<string, unknown> | null | undefined;
  if (!s || typeof s !== 'object') return null;
  const av = n(s.av);
  const am = n(s.am);
  if (!Number.isFinite(av) || !Number.isFinite(am)) return null;
  const z = (v: unknown) => (Number.isFinite(n(v)) ? n(v) : 0);
  const haircut = z(s.haircut);
  const positions = z(s.cm) + z(s.im);
  const orders = z(s.oim) + z(s.ocm);
  const inUse = av - am - haircut;
  return {
    accountValue: av,
    inUse,
    ratio: av > 0 ? inUse / av : null,
    positions,
    orders,
    available: am,
    haircut,
  };
}

// --- readers -----------------------------------------------------------------

/** One page of a gateway history. */
export async function fetchHistoryPage(
  kind: HistoryKind,
  engine: HistoryEngine,
  address: string,
  endTime: number | null,
  limit = HISTORY_PAGE,
  /**
   * `priority`: who the read is for - 'visible' for a table on screen; the
   * default 'background' waits behind every visible read (exchange/historyQueue.ts).
   * `since`: only rows at or after this time (a table catching up).
   * `signal`: aborts when the reader leaves - a read still waiting for its
   * slot is dropped; one already sent completes.
   * `onSent`: called when the request leaves for SoDEX. `fresh`: never an
   * answer kept from a moment ago.
   */
  opts: { priority?: HistoryPriority; since?: number; signal?: AbortSignal; onSent?: () => void; fresh?: boolean } = {},
): Promise<HistoryPage<any>> {
  const spec = HISTORY[kind];
  // Straight from the gateway, in this browser - through the exchange layer,
  // which keeps what the backend used to: one request budget shared by every
  // tab of this browser (it is the user's own IP now), a few seconds of
  // sharing between panels, SoDEX's rate-limit cooldown, the last good copy of
  // a page when SoDEX refuses, and - the part that matters - the drip that keeps
  // /trades and /orders/history under Cloudflare's 1015 threshold
  // (exchange/sodexGateway.ts). A busy history page can no longer get the IP
  // rate-limited: past two such reads in a minute the next one waits its turn,
  // the table on screen first (exchange/historyQueue.ts).
  const q = { limit, endTime, startTime: opts.since, priority: opts.priority ?? 'background', signal: opts.signal, onSent: opts.onSent, fresh: opts.fresh };
  const r =
    kind === 'orders' ? await account.orderHistory(engine, address, q).then((x) => ({ rows: x.orders as unknown, staleAt: x.staleAt }))
    : kind === 'trades' ? await account.trades(engine, address, q).then((x) => ({ rows: x.trades as unknown, staleAt: x.staleAt }))
    : kind === 'funding' ? await account.fundingHistory(address, q).then((x) => ({ rows: x.funding as unknown, staleAt: x.staleAt }))
    : await account.positionHistory(address, q).then((x) => ({ rows: x.positions as unknown, staleAt: x.staleAt }));
  const rows = asList(r.rows, kind);
  return { rows, next: nextCursor(rows, spec.timeOf, limit), staleAt: r.staleAt };
}

/** sodex.com's history host. Mainnet only - it has no testnet twin. */
export const BIZ_HISTORY_ORIGIN = 'https://alpha-biz.sodex.dev';
const BIZ_TIMEOUT_MS = 12_000;

/** alpha-biz answers on the network sodex.com runs on; only read it there. */
export const ledgerAvailable = (): boolean => tradingConfig().network === 'mainnet';

async function bizRead<T>(path: string, body: unknown): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BIZ_TIMEOUT_MS);
  try {
    const res = await fetch(`${BIZ_HISTORY_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* reported below */ }
    // `code` is "0" on account_flow and 0 on combined_transfers.
    if (!res.ok || !json || String(json.code) !== '0') {
      throw new Error(`${path}: HTTP ${res.status}${json?.message ? ` ${json.message}` : ''}`);
    }
    return json.data as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Rows per alpha-biz page (sodex.com asks for 100). */
export const LEDGER_PAGE = 50;

/** Deposits and withdrawals from `offset`, newest first. */
export async function fetchAccountFlows(account: string, offset: number, limit = LEDGER_PAGE): Promise<{ rows: LedgerRow[]; raw: number; done: boolean }> {
  const data = await bizRead<{ accountFlows?: unknown[]; total?: unknown }>('/biz/mirror/account_flow', {
    account, start: offset, end: 0, limit,
  });
  const list = Array.isArray(data?.accountFlows) ? data.accountFlows : [];
  const total = n(data?.total);
  const rows = list.map(mapAccountFlow).filter((r): r is LedgerRow => r !== null);
  return { rows, raw: list.length, done: list.length < limit || (Number.isFinite(total) && offset + list.length >= total) };
}

/** Oldest ledger time, the first deposit or withdrawal SoDEX has for this wallet. */
export async function earliestFlowTime(account: string): Promise<number | null> {
  const head = await bizRead<{ accountFlows?: unknown[]; total?: unknown }>('/biz/mirror/account_flow', {
    account, start: 0, end: 0, limit: 1,
  });
  const total = n(head?.total);
  const newest = Array.isArray(head?.accountFlows) ? head.accountFlows : [];
  if (!newest.length || !Number.isFinite(total) || total < 1) return null;
  const offset = total > 1 ? Math.floor(total) - 1 : 0;
  const page = offset === 0 ? head : await bizRead<{ accountFlows?: unknown[] }>('/biz/mirror/account_flow', {
    account, start: offset, end: 0, limit: 1,
  });
  const raw = Array.isArray(page?.accountFlows) ? page.accountFlows : [];
  const times = raw.map(mapAccountFlow).filter((r): r is LedgerRow => r !== null).map((r) => r.time).filter((t) => t > 0);
  return times.length ? Math.min(...times) : null;
}

/** ValueChain-side transfers, page `page` (1-based), newest first. */
export async function fetchFundTransfers(
  account: string,
  page: number,
  tokens: TokenBook,
  size = LEDGER_PAGE,
): Promise<{ rows: LedgerRow[]; done: boolean }> {
  const data = await bizRead<{ fundTransfers?: unknown[]; total?: unknown }>('/biz/mirror/v2/combined_transfers', {
    walletAddress: account, page, size,
  });
  const list = Array.isArray(data?.fundTransfers) ? data.fundTransfers : [];
  const total = n(data?.total);
  const rows = list.map((r) => mapFundTransfer(r, account, tokens)).filter((r): r is LedgerRow => r !== null);
  return { rows, done: list.length < size || (Number.isFinite(total) && page * size >= total) };
}
