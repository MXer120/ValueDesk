/**
 * SoDEX Wealth: the funds, a wallet's holdings, and the on-chain requests.
 *
 * Source: docs.sodex.com/for-developers (Wealth, Wealth API, RFQ, Vault Lifecycle), read
 * 2026-11-05, and the live API. Three products, and the fund's `fundType` plus its trading
 * channel decide what can be done (the Quickstart's table, `fundAction` below):
 *
 *   clob           a token on the Spot order book (vQQQ, vVOO, vBOXX...): an ordinary spot order
 *   escrow_vault   CXMT, UNITREE: asynchronous requests from the wallet on ValueChain, as a
 *                  batch (requestDeposit / requestRedeem) or at a maker's quote (RFQ)
 *   bridged_vault  USDC Earn (Morpho on Base): SoDEX documents reads only
 *
 * WHAT SODEX DOES NOT EXPOSE. There is no documented route to subscribe to or redeem from a
 * bridged vault, so USDC Earn opens sodex.com. Claiming a vault result needs the on-chain
 * request id, which the API does not return (and says not to take from `entryId`), so a
 * claimable entry also opens sodex.com; most results are delivered without a claim. Recurring
 * buys are read here and created there. There is no testnet Wealth API, so nothing on-chain
 * in this file has been run against the real contracts: the signatures were checked with
 * read-only eth_calls against ValueChain and the calldata against the documented ABI.
 *
 * Every amount from the API is a decimal string; money sent on-chain is integer base units.
 */
import { loadReferral } from '../onboarding/referral';
import { mayAttachCode } from '../onboarding/referralRules';
import { readGateway } from './gateway';
import { logger } from '../log';
import { TradingError } from './session';
import { tradingConfig } from './config';
import { addOrSwitchChain, getChainId, sendTransaction, WalletError, type Eip1193Provider } from '../wallet';
import { guardLegal } from './legalGate';
import { requireTermsOrThrow } from '../legal/acceptance';
import { waitForReceipt } from './relay';
import { VALUECHAIN_RPC, balanceOfCall, hexUnits, nativeBalanceCall, rpcBatch, rpcCall } from './rpc';
import { valueChain, promptCounter, type StepSink } from './funds';
import type { SignableAction } from '@sodex-core';

const log = logger('wealth');
const BASE = '/api/v1/wealth';

// --- what the API returns --------------------------------------------------------------

export type FundType = 'clob' | 'escrow_vault' | 'bridged_vault';
export type Channel = 'rfq' | 'batch' | 'closed' | 'subscription' | 'clob';

export interface WealthFund {
  fundId: string;
  name: string;
  fundType: FundType;
  fundStatus: 'subscription' | 'live';
  nav?: string;
  aum?: string;
  asOf?: string;
  share: { coin: string; address: string; decimals: number };
  spot?: { symbol: string; symbolId: number; displayName: string; quote: { coin: string; decimals: number } };
}

export interface WealthQuote {
  fundId: string;
  symbol?: string;
  price?: string;
  roi24h?: string;
  roi1M?: string;
  roi1Y?: string;
  roiInception?: string;
  apy7d?: string;
  dividendYield?: string;
  marketStatus?: string;
  /** e.g. net_excluding_rewards. Said next to the figure when SoDEX sends it. */
  yieldBasis?: string;
  asOf?: string;
}

export interface WealthPosition {
  fundId: string;
  name?: string;
  source: 'vault' | 'clob' | 'bridge';
  coin?: string;
  share?: { coin: string; address: string; decimals: number };
  spot?: { symbol: string; displayName: string };
  pendingRedeemShares?: string;
  pendingDepositShares?: string;
  processingCost?: string;
  pendingProceeds?: string;
  costBasis?: string;
  ledgerShares?: string;
  evmShares?: string;
  spotShares?: string;
  perpShares?: string;
  avgCost?: string;
}

export interface WealthPnlRow {
  fundId: string;
  source: string;
  shares?: string;
  price?: string;
  marketValue?: string;
  unrealizedPnl?: string;
  realizedPnl?: string;
  pnl24h?: string;
  priced: boolean;
}

export interface WealthPnl {
  settledValue?: string;
  totalCost?: string;
  totalPnl?: string;
  totalRealizedPnl?: string;
  totalUnrealizedPnl?: string;
  totalPnl24h?: string;
  inFlightValue?: string;
  totalValue?: string;
  complete?: boolean;
  incompleteFunds?: string[];
  positions: WealthPnlRow[];
}

export interface WealthEntry {
  fundId: string;
  kind: string;
  status: string;
  channel?: string;
  claimable?: boolean;
  delayedPending?: boolean;
  txHash?: string;
  requestedAt?: string;
  at: string;
  shares?: string;
  requestedShares?: string;
  proceeds?: string;
  cost?: string;
  costEstimated?: boolean;
}

export interface WealthPlan {
  planIndex: string;
  fundId?: string;
  target: string;
  amount: string;
  planType: string;
  status: string;
  successfulExecutionCount: number;
  nextScheduledAt?: string;
  share?: { coin: string };
  totalBuyAmount?: string;
}

export interface TradingStatus {
  fundId: string;
  vault: string;
  channel: Channel;
  closedReason: string | null;
  nextChannel: string | null;
  nextChannelAt: number | null;
  rfq: { address: string; quotable: boolean; pausedByMaker: boolean; minBuyAmount: string; minSellAmount: string; expectedDeliveryAt: number | null } | null;
  batch: { opensAt: number | null; cutoffAt: number | null; expectedDeliveryAt: number | null } | null;
  subscription: { subscribeDeadline: number; unsubscribeDeadline: number } | null;
}

export interface FundDetail extends WealthFund {
  contracts: { vault?: string; market?: string; asset?: string; subscription?: string };
  chainConfig: { assetDecimals: number; paused: boolean } | null;
}

export interface RfqQuote {
  quotable: boolean;
  reason?: { code: string };
  vault: string;
  side: 'buy' | 'sell';
  payAmount?: string;
  receiveAmount?: string;
  deadline: number;
  signature?: string;
  orderHash?: string;
  usdPrice?: string;
  expiresInMs: number;
}

// --- reads -----------------------------------------------------------------------------

const enc = encodeURIComponent;

/** A row without its share token cannot be shown or valued: it is left out, not allowed to take the page down. */
export const readFunds = () => readGateway<WealthFund[]>(`${BASE}/funds`).then((d) => (d ?? []).filter((f) => !!f?.share?.coin));
export const readMarkets = () => readGateway<{ quotes: WealthQuote[] }>(`${BASE}/markets`).then((d) => d?.quotes ?? []);
export const readFund = (fundId: string) => readGateway<FundDetail>(`${BASE}/funds/${enc(fundId)}`);
export const readTradingStatus = (fundId: string) => readGateway<TradingStatus>(`${BASE}/funds/${enc(fundId)}/trading-status`);
export const readPositions = (a: string) => readGateway<{ positions?: WealthPosition[]; summary?: { incomplete?: boolean } }>(`${BASE}/users/${enc(a)}/positions`).then((d) => d?.positions ?? []);
export const readPnl = (a: string) => readGateway<WealthPnl>(`${BASE}/users/${enc(a)}/pnl`);
export const readLedger = (a: string) => readGateway<{ entries?: WealthEntry[] }>(`${BASE}/users/${enc(a)}/fund-details`).then((d) => d?.entries ?? []);
export const readPlans = (a: string) => readGateway<{ plans?: WealthPlan[] }>(`${BASE}/users/${enc(a)}/recurring-buys`).then((d) => d?.plans ?? []);

export type PnlRange = '1W' | '1M' | '3M' | '1Y' | 'All';
export interface PnlPoint { ts: string | number; pnl?: string; totalValue?: string }
export const readPnlHistory = (a: string, range: PnlRange) =>
  readGateway<{ points?: PnlPoint[] }>(`${BASE}/users/${enc(a)}/pnl-history?interval=1d&range=${range}`).then((d) => d?.points ?? []);

// --- the join the portfolio reads ------------------------------------------------------

export interface JoinedHolding {
  fundId: string;
  coin: string;
  name: string;
  source: string;
  fund: WealthFund | null;
  position: WealthPosition | null;
  pnl: WealthPnlRow | null;
  marketValue: number | null;
  inFlight: number;
  shares: number;
  spotShares: number;
  perpShares: number;
  evmShares: number;
}

const n = (v: string | number | undefined | null): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * One row per fund the wallet touches, from /positions (where the shares sit) and /pnl (what
 * they are worth). A fund /pnl left out of its totals has no value here, so its coin stays
 * valued in Spot or EVM (summary.ts). In-flight comes per fund from /positions; if SoDEX's
 * own total is higher, the difference is kept, on the first row, so the total matches theirs.
 */
export function joinHoldings(funds: readonly WealthFund[] | null, positions: readonly WealthPosition[], pnl: WealthPnl | null): JoinedHolding[] {
  const fundById = new Map((funds ?? []).map((f) => [f.fundId, f]));
  const pnlById = new Map((pnl?.positions ?? []).map((p) => [p.fundId, p]));
  const incomplete = new Set(pnl?.incompleteFunds ?? []);
  const ids = [...new Set([...positions.map((p) => p.fundId), ...pnlById.keys()])];
  const rows = ids.map((fundId): JoinedHolding => {
    const position = positions.find((p) => p.fundId === fundId) ?? null;
    const row = pnlById.get(fundId) ?? null;
    const fund = fundById.get(fundId) ?? null;
    const spotShares = n(position?.spotShares);
    const perpShares = n(position?.perpShares);
    const evmShares = n(position?.evmShares);
    const located = spotShares + perpShares + evmShares;
    return {
      fundId,
      coin: position?.share?.coin ?? position?.coin ?? fund?.share.coin ?? fundId,
      name: fund ? fundLabel(fund).name : (position?.name ?? fundId),
      source: position?.source ?? row?.source ?? '',
      fund,
      position,
      pnl: row,
      marketValue: row?.priced && row.marketValue !== undefined && !incomplete.has(fundId) ? n(row.marketValue) : null,
      inFlight: n(position?.processingCost) + n(position?.pendingProceeds),
      shares: located > 0 ? located : n(row?.shares ?? position?.ledgerShares),
      spotShares,
      perpShares,
      evmShares,
    };
  }).filter((r) => r.shares > 0 || r.inFlight > 0 || (r.marketValue ?? 0) > 0);
  const official = n(pnl?.inFlightValue);
  const ours = rows.reduce((s, r) => s + r.inFlight, 0);
  if (official > ours && rows[0]) rows[0].inFlight += official - ours;
  return rows.sort((a, b) => (b.marketValue ?? 0) + b.inFlight - (a.marketValue ?? 0) - a.inFlight);
}

// --- what SoDEX calls them -------------------------------------------------------------

export type FundShelf = 'Stable Earn' | 'Curated ETF' | 'Specialty';

/** SoDEX's own product names and shelves. The API's `name` is an internal label ("QQQ Fund"). */
const CATALOG: Readonly<Record<string, { name: string; shelf: FundShelf; yield?: boolean }>> = {
  'Morpho-Earn': { name: 'USDC Earn', shelf: 'Stable Earn', yield: true },
  vBOXX: { name: 'US Cash Yield', shelf: 'Stable Earn', yield: true },
  vQQQ: { name: 'US Tech 100', shelf: 'Curated ETF' },
  vVOO: { name: 'US 500', shelf: 'Curated ETF' },
  vSCHD: { name: 'US Selected Dividend', shelf: 'Curated ETF' },
  vVYM: { name: 'US Broad Dividend', shelf: 'Curated ETF' },
  vVGT: { name: 'US Broad Tech', shelf: 'Curated ETF' },
  CXMT: { name: 'CXMT Vault', shelf: 'Specialty' },
  UNITREE: { name: 'Unitree Vault', shelf: 'Specialty' },
  vSMH: { name: 'US Semis 25', shelf: 'Specialty' },
  vSTRC: { name: 'Strategy Preferred Yield', shelf: 'Specialty' },
};

/** A fund listed tomorrow still shows, under its API name and a shelf by type. */
export function fundLabel(fund: Pick<WealthFund, 'fundId' | 'name' | 'fundType'>): { name: string; shelf: FundShelf; yield: boolean } {
  const c = CATALOG[fund.fundId];
  if (c) return { name: c.name, shelf: c.shelf, yield: !!c.yield };
  return { name: fund.name, shelf: fund.fundType === 'clob' ? 'Curated ETF' : 'Specialty', yield: false };
}

/** Where a fund's page lives on sodex.com. */
export function sodexFundUrl(fundId: string): string {
  if (fundId === 'Morpho-Earn') return 'https://sodex.com/wealth/usdc-earn';
  return `https://sodex.com/wealth/${enc(fundId.toLowerCase())}`;
}

// --- what can be done with a fund now --------------------------------------------------

export type FundAction =
  | { kind: 'trade'; symbol: string }
  | { kind: 'batch'; cutoffAt: number | null; deliveryAt: number | null }
  | { kind: 'rfq'; rfq: string; deliveryAt: number | null; minBuy: string; minSell: string }
  | { kind: 'external'; why: string }
  | { kind: 'closed'; why: string; nextAt: number | null };

const CLOSED_WHY: Readonly<Record<string, string>> = {
  pre_open: 'Opens soon',
  market_break: 'Market break',
  market_closed: 'Market closed',
  session_override: 'Paused by SoDEX',
  bridge_not_ready: 'Bridge not ready',
};

/**
 * The Quickstart's table. A bridged vault has no trading status (the route answers "not
 * found"), so `status` may be null for one; for any other fund null means not read yet.
 */
export function fundAction(fund: Pick<WealthFund, 'fundType' | 'fundStatus' | 'spot'>, status: TradingStatus | null): FundAction | null {
  if (fund.fundType === 'bridged_vault') return { kind: 'external', why: 'Subscribed on sodex.com: SoDEX documents no route for this vault.' };
  if (!status) return null;
  if (status.channel === 'closed') {
    return { kind: 'closed', why: CLOSED_WHY[status.closedReason ?? ''] ?? 'Closed', nextAt: status.nextChannelAt };
  }
  if (fund.fundType === 'clob') {
    if (status.channel === 'clob' && fund.spot) return { kind: 'trade', symbol: fund.spot.symbol };
    return { kind: 'closed', why: 'Not trading', nextAt: status.nextChannelAt };
  }
  if (status.channel === 'batch') return { kind: 'batch', cutoffAt: status.batch?.cutoffAt ?? null, deliveryAt: status.batch?.expectedDeliveryAt ?? null };
  if (status.channel === 'rfq' && status.rfq) {
    if (!status.rfq.quotable || status.rfq.pausedByMaker) return { kind: 'closed', why: 'Quotes paused', nextAt: status.nextChannelAt };
    return { kind: 'rfq', rfq: status.rfq.address, deliveryAt: status.rfq.expectedDeliveryAt, minBuy: status.rfq.minBuyAmount, minSell: status.rfq.minSellAmount };
  }
  if (status.channel === 'subscription') return { kind: 'external', why: 'In subscription: subscribed on sodex.com.' };
  return { kind: 'closed', why: 'Closed', nextAt: status.nextChannelAt };
}

// --- calldata --------------------------------------------------------------------------

/** Selectors checked against the keccak of these signatures in wealth.test.ts. */
export const SELECTOR = {
  approve: '0x095ea7b3',
  allowance: '0xdd62ed3e',
  requestDeposit: '0x08aebe98', // requestDeposit(uint256,address,bytes32,bytes32)
  requestRedeem: '0xe036a868', // requestRedeem(uint256,address,bytes32,bytes32)
  rfqBuy: '0x247d525e', // buy(address,uint256,uint256,uint256,bytes)
  rfqSell: '0x8bfc7764', // sell(address,uint256,uint256,uint256,bytes)
  getAsset: '0x5c222bad',
  minDeposit: '0xf4914d33',
  minRedeem: '0xa3731bad',
} as const;

const ZERO32 = '0'.repeat(64);

function addrWord(a: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new RangeError('bad address');
  return a.slice(2).toLowerCase().padStart(64, '0');
}
function uintWord(v: bigint): string {
  if (v < 0n) throw new RangeError('negative amount');
  return v.toString(16).padStart(64, '0');
}

export const approveData = (spender: string, amount: bigint): string =>
  `${SELECTOR.approve}${addrWord(spender)}${uintWord(amount)}`;
export const allowanceData = (owner: string, spender: string): string =>
  `${SELECTOR.allowance}${addrWord(owner)}${addrWord(spender)}`;

/**
 * The Wealth referral: ValueDesk's own SoDEX code (owner 2026-11-05). A text code is its UTF-8
 * bytes, right-padded to 32 (Wealth docs, Referrals). SoDEX checks nothing here and publishes no
 * payout terms; a code it does not know attributes nothing.
 */
export const WEALTH_REFERRAL_CODE = 'VALUEDESK';
export function referralWord(code: string): string {
  const bytes = new TextEncoder().encode(code);
  if (bytes.length > 32) throw new RangeError('referral code longer than 32 bytes');
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0');
}

/**
 * No builder fee (bytes32(0)). The referral is ValueDesk's only for a wallet SoDEX says has no other inviter, or is on
 * ours already (owner 2026-11-14: "ONLY if we verified that wallet doesnt already have a ref code"): `ours` is
 * referralRules.mayAttachCode(state). Otherwise bytes32(0). RFQ calls take no referral.
 */
export const requestDepositData = (assets: bigint, receiver: string, ours: boolean): string =>
  `${SELECTOR.requestDeposit}${uintWord(assets)}${addrWord(receiver)}${ZERO32}${ours ? referralWord(WEALTH_REFERRAL_CODE) : ZERO32}`;
export const requestRedeemData = (shares: bigint, receiver: string, ours: boolean): string =>
  `${SELECTOR.requestRedeem}${uintWord(shares)}${addrWord(receiver)}${ZERO32}${ours ? referralWord(WEALTH_REFERRAL_CODE) : ZERO32}`;

/** buy / sell(address vault, uint256 pay, uint256 receive, uint256 deadline, bytes signature). */
export function rfqData(side: 'buy' | 'sell', vault: string, pay: bigint, receive: bigint, deadline: bigint, signature: string): string {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(signature)) throw new RangeError('bad quote signature');
  const sig = signature.slice(2).toLowerCase();
  const len = BigInt(sig.length / 2);
  const padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, '0');
  const head = [addrWord(vault), uintWord(pay), uintWord(receive), uintWord(deadline), uintWord(5n * 32n)].join('');
  return `${side === 'buy' ? SELECTOR.rfqBuy : SELECTOR.rfqSell}${head}${uintWord(len)}${padded}`;
}

// --- the checks a request needs --------------------------------------------------------

export interface VaultFacts {
  asset: string;
  assetDecimals: number;
  shareDecimals: number;
  /** Base units. */
  minDeposit: bigint;
  minRedeem: bigint;
  /** The wallet on ValueChain, base units. */
  assetBalance: bigint;
  shareBalance: bigint;
  gasBalance: bigint;
  paused: boolean;
}

/** Everything off the chain and the API at the moment of asking; addresses are never hard-coded. */
export async function readVaultFacts(fundId: string, owner: string): Promise<VaultFacts> {
  const fund = await readFund(fundId);
  const vault = fund.contracts.vault;
  const asset = fund.contracts.asset;
  if (!vault || !asset) throw new WalletError('SoDEX lists no contract for this fund right now.');
  const calls = [
    balanceOfCall(asset, owner),
    balanceOfCall(vault, owner),
    nativeBalanceCall(owner),
    { method: 'eth_call', params: [{ to: vault, data: SELECTOR.minDeposit }, 'latest'] },
    { method: 'eth_call', params: [{ to: vault, data: SELECTOR.minRedeem }, 'latest'] },
  ];
  const r = await rpcBatch(VALUECHAIN_RPC, calls);
  const big = (i: number): bigint => hexUnits(r.get(i)) ?? 0n;
  return {
    asset,
    assetDecimals: fund.chainConfig?.assetDecimals ?? 6,
    shareDecimals: fund.share.decimals,
    minDeposit: big(3),
    minRedeem: big(4),
    assetBalance: big(0),
    shareBalance: big(1),
    gasBalance: big(2),
    paused: fund.chainConfig?.paused === true,
  };
}

/** Why a request cannot go, in words, or null. Amount in base units of what is being spent. */
export function requestProblem(side: 'buy' | 'sell', amount: bigint, f: VaultFacts): string | null {
  if (f.paused) return 'SoDEX has paused this vault.';
  if (amount <= 0n) return 'Enter an amount.';
  if (side === 'buy') {
    if (amount < f.minDeposit) return 'Below this vault\'s minimum.';
    if (amount > f.assetBalance) return 'Not enough USDC on ValueChain. Transfer from Spot first.';
  } else {
    if (amount < f.minRedeem) return 'Below this vault\'s minimum redemption.';
    if (amount > f.shareBalance) return 'More than the shares in your wallet.';
  }
  if (f.gasBalance === 0n) return 'This wallet has no SOSO for gas on ValueChain.';
  return null;
}

// --- sending ---------------------------------------------------------------------------

/** The checks every wallet-signed request passes. An exit (`sell`) is never refused by the terms. */
async function preflight(owner: string, side: 'buy' | 'sell'): Promise<void> {
  if (side === 'sell') return;
  if (!tradingConfig().writesAllowed) throw new TradingError('New positions are paused on ValueDesk right now. Nothing was sent.', 'writes-off');
  await requireTermsOrThrow({ owner, reason: 'invest in this fund' });
  // The same gate as an order that opens a position: blocked and close-only places stop here.
  guardLegal({ type: 'newTwapOrder', engine: 'spot', params: {} } as unknown as SignableAction, owner);
}

async function send(provider: Eip1193Provider, owner: string, chainId: number, to: string, data: string, what: string): Promise<string> {
  const hash = await sendTransaction(provider, { from: owner, to, data, value: '0x0', chainId });
  const receipt = await waitForReceipt(hash, 180_000);
  if (!receipt) throw new WalletError(`The ${what} was sent (${hash}) but is not confirmed yet. Check your wallet before sending again.`);
  if (receipt.status !== 'success') throw new WalletError(`The ${what} ${hash} reverted on ValueChain. Nothing was taken.`);
  return hash;
}

async function ensureChain(provider: Eip1193Provider): Promise<{ chainId: number; switched: boolean }> {
  const chain = await valueChain();
  const switched = (await getChainId(provider)) !== chain.chainId;
  if (switched) {
    await addOrSwitchChain(provider, {
      chainId: chain.chainIdHex, chainName: chain.name, rpcUrls: [chain.rpcUrl],
      blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : [], nativeCurrency: chain.nativeCurrency,
    });
  }
  return { chainId: chain.chainId, switched };
}

async function allowanceOf(token: string, owner: string, spender: string): Promise<bigint> {
  const r = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ to: token, data: allowanceData(owner, spender) }, 'latest']);
  if (r.error) throw new WalletError('Could not read the token allowance from ValueChain. Nothing was sent.');
  return hexUnits(r.result) ?? 0n;
}

/**
 * Batch: approve the asset if needed, then requestDeposit. A redemption spends shares the
 * wallet holds and needs no approval. Returns the request's hash: arrival is read later
 * from the fund's ledger, a successful transaction is not delivery.
 */
export async function requestVault(o: {
  provider: Eip1193Provider; owner: string; fundId: string; side: 'buy' | 'sell'; amount: bigint; onStep?: StepSink;
}): Promise<string> {
  await preflight(o.owner, o.side);
  const fund = await readFund(o.fundId);
  const facts = await readVaultFacts(o.fundId, o.owner);
  const problem = requestProblem(o.side, o.amount, facts);
  if (problem) throw new RangeError(problem);
  const vault = fund.contracts.vault!;
  const { chainId, switched } = await ensureChain(o.provider);
  const needApprove = o.side === 'buy' && (await allowanceOf(facts.asset, o.owner, vault)) < o.amount;
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + (needApprove ? 1 : 0) + 1);
  if (switched) ask('approve');
  if (needApprove) {
    ask('approve');
    await send(o.provider, o.owner, chainId, facts.asset, approveData(vault, o.amount), 'approval');
  }
  ask('confirm');
  // ValueDesk's code rides on the request only for a wallet SoDEX says has no other inviter (or is on ours already).
  const ours = mayAttachCode(await loadReferral(o.owner));
  const data = o.side === 'buy' ? requestDepositData(o.amount, o.owner, ours) : requestRedeemData(o.amount, o.owner, ours);
  const hash = await send(o.provider, o.owner, chainId, vault, data, o.side === 'buy' ? 'deposit request' : 'redemption request');
  log.info('vault request', { fundId: o.fundId, side: o.side });
  return hash;
}

/** A maker's quote. `quotable: false` is a refusal inside a good answer: read `reason.code`. */
export async function requestQuote(fundId: string, side: 'buy' | 'sell', owner: string, payAmount: bigint): Promise<RfqQuote> {
  const { gateway } = tradingConfig();
  const res = await fetch(`${gateway}${BASE}/funds/${enc(fundId)}/rfq/quote`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ side, owner, payAmount: payAmount.toString() }),
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
  const body = await res.json() as { code?: number; error?: string; data?: RfqQuote };
  if (body.code !== 0 || !body.data) throw new WalletError(body.error || 'SoDEX did not answer with a quote.');
  return body.data;
}

export const QUOTE_REASON: Readonly<Record<string, string>> = {
  not_in_session: 'The quote session is not open.',
  market_closed: 'The market is closed.',
  halted: 'Trading is halted.',
  stale_market_data: 'The maker\'s market data is stale. Try again shortly.',
  limit_up: 'The price is at its upper limit.',
  limit_down: 'The price is at its lower limit.',
  below_min_notional: 'Below the maker\'s minimum.',
  below_chain_minimum: 'Below the chain minimum.',
  over_quote_cap: 'Above the maker\'s limit for one quote.',
  daily_cap_reached: 'The maker\'s daily limit is reached.',
  small_quotes_paused: 'Small quotes are paused.',
  paused: 'Quoting is paused.',
  maker_rejected: 'The maker declined.',
  vault_not_supported: 'This vault has no quotes.',
};

/** Fill a quote the reader has seen: approve what it escrows if needed, then buy or sell on the RFQ contract. */
export async function fillQuote(o: {
  provider: Eip1193Provider; owner: string; fundId: string; rfq: string; quote: RfqQuote; onStep?: StepSink;
}): Promise<string> {
  const q = o.quote;
  if (!q.quotable || !q.payAmount || !q.receiveAmount || !q.signature) throw new WalletError('This quote cannot be filled.');
  if (Date.now() / 1000 >= q.deadline) throw new WalletError('The quote expired. Ask for a new one.');
  await preflight(o.owner, q.side);
  const pay = BigInt(q.payAmount);
  const fund = await readFund(o.fundId);
  const token = q.side === 'buy' ? fund.contracts.asset : q.vault;
  if (!token) throw new WalletError('SoDEX lists no contract for this fund right now.');
  const { chainId, switched } = await ensureChain(o.provider);
  const needApprove = (await allowanceOf(token, o.owner, o.rfq)) < pay;
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + (needApprove ? 1 : 0) + 1);
  if (switched) ask('approve');
  if (needApprove) {
    ask('approve');
    await send(o.provider, o.owner, chainId, token, approveData(o.rfq, pay), 'approval');
  }
  ask('confirm');
  return send(o.provider, o.owner, chainId, o.rfq, rfqData(q.side, q.vault, pay, BigInt(q.receiveAmount), BigInt(q.deadline), q.signature), q.side === 'buy' ? 'buy' : 'sell');
}
