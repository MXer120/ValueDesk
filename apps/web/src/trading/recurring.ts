/**
 * Recurring Buy, exactly as sodex.com offers it (owner 2026-11-27: "thats basicaly just doing exactly what their ui
 * does nothing else pls"). SoDEX's AutomaticInvestment contracts on ValueChain (docs.sodex.com/for-developers, Recurring
 * Buys; the plan contract's ABI verified on main-scan.valuechain.xyz 2026-11-27, which also has the edit call the docs
 * leave out, updateInvestmentPlanByIndex, behind sodex.com's "edit the amount and frequency"):
 *
 *   one shared prefunded USDC balance (AutomaticInvestmentDeposit: deposit / redeem), named by the plan contract's deposit()
 *   plans: createInvestmentPlan, then by plan index updateInvestmentPlanByIndex, pause / resume / cancelInvestmentPlanByIndex
 *   (the docs say one plan per target; the contract takes several, so every change names the plan's index)
 *   SoDEX's operator buys from local midnight to 09:30: China targets at UTC+8, US targets at a fixed UTC-4
 *
 * The targets are the contract's own allowlist (getVaultByRange, getTargetConfig for the minimum), shown when SoDEX
 * lists the fund. Every call is the wallet's own transaction (SOSO gas). SoDEX's operator executes the buys, so these
 * carry no ValueDesk fee or code. Reads of plans and executions: the Wealth API.
 */
import { WalletError, type Eip1193Provider } from '../wallet';
import { VALUECHAIN_RPC, balanceOfCall, hexUnits, nativeBalanceCall, rpcBatch, rpcCall } from './rpc';
import { promptCounter, type StepSink } from './funds';
import { readGateway } from './gateway';
import { addrWord, allowanceOf, approveData, ensureChain, preflight, send, uintWord, type WealthFund } from './wealth';
import { logger } from '../log';

const log = logger('recurring');
const BASE = '/api/v1/wealth';
const enc = encodeURIComponent;

/** AutomaticInvestment (docs, Wealth Contracts; the Wealth API's dcaAddress for every plan). */
export const AUTO_INVEST = '0x76f8064b1B0f091D8f86D2EB203631D44B685146';

export const RECURRING_SELECTOR = {
  getNumVaults: '0x03aaee11',
  getVaultByRange: '0xb0115970', // getVaultByRange(uint256,uint256)
  getTargetConfig: '0xc29db77b', // getTargetConfig(address)
  depositContract: '0xd0e30db0', // deposit() on the plan contract: the prefund ledger's address
  createInvestmentPlan: '0xf1cac027', // createInvestmentPlan(address,uint256,uint8,uint8)
  updateInvestmentPlanByIndex: '0x4918e826', // updateInvestmentPlanByIndex(uint256,uint256,uint8,uint8)
  // By index: a wallet can hold several plans on one target (simulated 2026-11-27: a second CXMT plan is accepted,
  // getNumUserPlansByVault 2), so the vault-keyed calls the docs show cannot say which plan is meant.
  pauseInvestmentPlanByIndex: '0xa0178413', // pauseInvestmentPlanByIndex(uint256)
  resumeInvestmentPlanByIndex: '0x25be93e9', // resumeInvestmentPlanByIndex(uint256)
  cancelInvestmentPlanByIndex: '0xda11b347', // cancelInvestmentPlanByIndex(uint256)
  asset: '0x38d52e0f', // asset() on the prefund ledger
  balanceOfAssets: '0x9159b206',
  balanceOfShares: '0x7bf89c85',
  deposit: '0xb6b55f25', // deposit(uint256)
  redeem: '0xdb006a75', // redeem(uint256)
} as const;

// --- the schedule ---------------------------------------------------------------------------------

export type PlanType = 'DAILY' | 'WEEKLY' | 'BI_WEEKLY' | 'MONTHLY';
export const PLAN_TYPES: readonly PlanType[] = ['DAILY', 'WEEKLY', 'BI_WEEKLY', 'MONTHLY'];
export const PLAN_CODE: Readonly<Record<PlanType, number>> = { DAILY: 0, WEEKLY: 1, BI_WEEKLY: 2, MONTHLY: 3 };
/** sodex.com's choices: "Buy every trading day, weekly or every 2 weeks on Monday-Friday, or monthly on days 1-30." */
export const PLAN_LABEL: Readonly<Record<PlanType, string>> = { DAILY: 'Every trading day', WEEKLY: 'Weekly', BI_WEEKLY: 'Every 2 weeks', MONTHLY: 'Monthly' };
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;

/** 0 = a China vault (UTC+8), 1 = a US book target (UTC-4, no daylight saving). */
export type Market = 0 | 1;
export const MARKET_LABEL: Readonly<Record<Market, string>> = { 0: 'China market · UTC+8', 1: 'US market · fixed UTC−4' };
const OFFSET_H: Readonly<Record<Market, number>> = { 0: 8, 1: -4 };

/** The day a plan takes for its type: 0 daily; 1-5 Monday-Friday; 1-30 monthly. Null when sodex.com would not offer it. */
export function dayProblem(type: PlanType, day: number): string | null {
  if (!Number.isInteger(day)) return 'Pick a day.';
  if (type === 'DAILY') return day === 0 ? null : 'A daily plan has no day.';
  if (type === 'MONTHLY') return day >= 1 && day <= 30 ? null : 'Pick a day from 1 to 30.';
  return day >= 1 && day <= 5 ? null : 'Pick a weekday, Monday to Friday.';
}

/** "every day", "every Monday", "every second Monday", "on day 15 of every month". */
export function scheduleWords(type: PlanType, day: number): string {
  if (type === 'DAILY') return 'every trading day';
  if (type === 'MONTHLY') return `on day ${day} of every month`;
  const name = WEEKDAYS[day - 1] ?? `day ${day}`;
  return type === 'WEEKLY' ? `every ${name}` : `every second ${name}`;
}

/**
 * The first local date a new plan buys, weekends skipped as SoDEX skips non-trading days (it does not shift them;
 * holidays are not known here, so the plan's own nextScheduledAt from SoDEX replaces this once it exists): the next
 * weekday for a daily plan, the next such weekday, that weekday in this week for every 2 weeks (or two weeks on when it
 * has passed), day `day` of this month or the next. Today counts while the market's window (to 09:30 local) is open.
 * Returns the local date as YYYY-MM-DD.
 */
export function firstRunDate(type: PlanType, day: number, market: Market, now = Date.now()): string {
  const local = new Date(now + OFFSET_H[market] * 3_600_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const first = minutes < 9 * 60 + 30 ? today : today + 86_400_000;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const dow = (t: number) => ((new Date(t).getUTCDay() + 6) % 7) + 1; // 1 Monday .. 7 Sunday
  if (type === 'DAILY') {
    let t = first;
    while (dow(t) > 5) t += 86_400_000;
    return iso(t);
  }
  if (type === 'MONTHLY') {
    const d0 = new Date(first);
    for (let m = 0; m < 14; m++) {
      const y = d0.getUTCFullYear() + Math.floor((d0.getUTCMonth() + m) / 12);
      const mo = (d0.getUTCMonth() + m) % 12;
      const t = Date.UTC(y, mo, day);
      // A day that does not exist that month, or falls on a weekend, is skipped, not moved (sodex.com's rules).
      if (new Date(t).getUTCMonth() === mo && t >= first && dow(t) <= 5) return iso(t);
    }
    return iso(first);
  }
  if (type === 'WEEKLY') {
    let t = first;
    while (dow(t) !== day) t += 86_400_000;
    return iso(t);
  }
  // Every 2 weeks: that weekday in the creation week, then every second week (docs).
  const monday = today - (dow(today) - 1) * 86_400_000;
  let t = monday + (day - 1) * 86_400_000;
  while (t < first) t += 14 * 86_400_000;
  return iso(t);
}

// --- what the API returns -------------------------------------------------------------------------

export interface RecurringPlan {
  planIndex: string;
  dcaAddress?: string;
  fundId?: string;
  target: string;
  amount: string;
  planType: PlanType;
  dayOfPeriod: number;
  createdAt?: string;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' | string;
  successfulExecutionCount: number;
  nextScheduledAt?: string;
  share?: { coin: string; address: string; decimals: number };
  totalBuyAmount?: string;
  totalBuyShares?: string;
  avgCost?: string;
  processingAmount?: string;
  anomalyCount?: number;
}

export interface RecurringRead { availableAssets: string | null; plans: RecurringPlan[] }

export interface PlanExecution {
  scheduledLocalDate: string;
  scheduledAt?: string;
  status: string;
  reasonCode?: string;
  message?: string;
  amount: string;
  attemptedAt?: string;
  executedAt?: string;
  txHash?: string;
  finalSharesRaw?: string;
}

export const readRecurring = (a: string, status: 'active' | 'history') =>
  readGateway<{ availableAssets?: string; plans?: RecurringPlan[] }>(`${BASE}/users/${enc(a)}/recurring-buys?status=${status}`)
    .then((d): RecurringRead => ({ availableAssets: d?.availableAssets ?? null, plans: d?.plans ?? [] }));

export const readExecutions = (a: string, plan: Pick<RecurringPlan, 'planIndex' | 'dcaAddress'>) =>
  readGateway<{ executions?: PlanExecution[] }>(`${BASE}/users/${enc(a)}/recurring-buys/${enc(plan.planIndex)}/executions${plan.dcaAddress ? `?dcaAddress=${enc(plan.dcaAddress)}` : ''}`)
    .then((d) => d?.executions ?? []);

/** SoDEX's public weekly equal-contribution simulation (not any wallet's plan): its return over the range, as a fraction. */
export const readDcaReturn = (fundId: string) =>
  readGateway<{ returnRate?: string; points?: Array<{ tradeDate: string; returnRate: string }> }>(`${BASE}/funds/${enc(fundId)}/dca-history?range=1Y`)
    .then((d) => ({ returnRate: d?.returnRate !== undefined && Number.isFinite(Number(d.returnRate)) ? Number(d.returnRate) : null, from: d?.points?.[0]?.tradeDate ?? null }));

// --- the allowlist --------------------------------------------------------------------------------

export interface RecurringTarget {
  fund: WealthFund;
  /** The plan's target address (the fund's share token). */
  vault: string;
  market: Market;
  /** Base units of USDC. */
  minAmount: bigint;
}

const strip = (h: string) => (h.startsWith('0x') ? h.slice(2) : h);

/** (address[] vaults, uint8[] types): two dynamic arrays. */
export function decodeVaultRange(hex: string): Array<{ vault: string; market: number }> {
  const d = strip(hex);
  const at = (i: number) => Number(BigInt(`0x${d.slice(i * 64, i * 64 + 64)}`));
  const arr = (offset: number): bigint[] => {
    const w = offset / 32;
    const n = at(w);
    return Array.from({ length: n }, (_, k) => BigInt(`0x${d.slice((w + 1 + k) * 64, (w + 2 + k) * 64)}`));
  };
  const vaults = arr(at(0));
  const types = arr(at(1));
  return vaults.map((v, i) => ({ vault: `0x${v.toString(16).padStart(40, '0')}`, market: Number(types[i] ?? 0n) }));
}

const call = (to: string, data: string) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });

/** The funds SoDEX lists that its recurring-buy contract allows, with their minimums. */
export async function readTargets(funds: readonly WealthFund[]): Promise<RecurringTarget[]> {
  const n = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ to: AUTO_INVEST, data: RECURRING_SELECTOR.getNumVaults }, 'latest']);
  const count = hexUnits(n.result);
  if (count === null) throw new WalletError('Could not read SoDEX\'s recurring-buy list from ValueChain.');
  if (count === 0n) return [];
  const range = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ to: AUTO_INVEST, data: `${RECURRING_SELECTOR.getVaultByRange}${uintWord(0n)}${uintWord(count)}` }, 'latest']);
  if (range.error || !range.result) throw new WalletError('Could not read SoDEX\'s recurring-buy list from ValueChain.');
  const listed = decodeVaultRange(range.result);
  const cfg = await rpcBatch(VALUECHAIN_RPC, listed.map((l) => call(AUTO_INVEST, `${RECURRING_SELECTOR.getTargetConfig}${addrWord(l.vault)}`)));
  const byShare = new Map(funds.map((f) => [f.share.address.toLowerCase(), f]));
  const out: RecurringTarget[] = [];
  listed.forEach((l, i) => {
    const fund = byShare.get(l.vault.toLowerCase());
    const raw = strip(cfg.get(i) ?? '');
    if (!fund || raw.length < 128) return;
    const market = Number(BigInt(`0x${raw.slice(0, 64)}`));
    const minAmount = BigInt(`0x${raw.slice(64, 128)}`);
    if (minAmount === 0n || (market !== 0 && market !== 1)) return; // a zero minimum is not allowlisted (docs)
    out.push({ fund, vault: l.vault, market: market as Market, minAmount });
  });
  return out;
}

// --- the prefunded balance ------------------------------------------------------------------------

export interface PrefundFacts {
  deposit: string;
  usdc: string;
  usdcDecimals: number;
  /** Base units. */
  available: bigint;
  shares: bigint;
  walletUsdc: bigint;
  gasBalance: bigint;
}

const addressOf = (hex: string | undefined): string | null => {
  const v = hexUnits(hex);
  return v === null || v === 0n ? null : `0x${v.toString(16).padStart(40, '0')}`;
};

export async function readPrefund(owner: string): Promise<PrefundFacts> {
  const a = await rpcBatch(VALUECHAIN_RPC, [call(AUTO_INVEST, RECURRING_SELECTOR.depositContract)]);
  const deposit = addressOf(a.get(0));
  if (!deposit) throw new WalletError('Could not read SoDEX\'s recurring-buy balance contract.');
  const b = await rpcBatch(VALUECHAIN_RPC, [
    call(deposit, RECURRING_SELECTOR.asset),
    call(deposit, `${RECURRING_SELECTOR.balanceOfAssets}${addrWord(owner)}`),
    call(deposit, `${RECURRING_SELECTOR.balanceOfShares}${addrWord(owner)}`),
    nativeBalanceCall(owner),
  ]);
  const usdc = addressOf(b.get(0));
  if (!usdc) throw new WalletError('Could not read the recurring-buy balance\'s token.');
  const c = await rpcBatch(VALUECHAIN_RPC, [balanceOfCall(usdc, owner)]);
  return {
    deposit,
    usdc,
    usdcDecimals: 6, // USDC on ValueChain (asset/config: vUSDC, 6 decimals); plan amounts are raw USDC units (docs)
    available: hexUnits(b.get(1)) ?? 0n,
    shares: hexUnits(b.get(2)) ?? 0n,
    walletUsdc: hexUnits(c.get(0)) ?? 0n,
    gasBalance: hexUnits(b.get(3)) ?? 0n,
  };
}

/** Shares that pay out at most `assets` (the ledger rounds a debit up; a withdrawal asks for no more than it holds). */
export function sharesFor(assets: bigint, f: Pick<PrefundFacts, 'available' | 'shares'>): bigint {
  if (f.available <= 0n || assets <= 0n) return 0n;
  if (assets >= f.available) return f.shares;
  return (assets * f.shares) / f.available;
}

export function fundsProblem(side: 'add' | 'withdraw', amount: bigint, f: PrefundFacts): string | null {
  if (amount <= 0n) return 'Enter an amount.';
  if (side === 'add' && amount > f.walletUsdc) return 'Not enough USDC in your wallet on ValueChain.';
  if (side === 'withdraw' && amount > f.available) return 'More than the balance.';
  if (f.gasBalance === 0n) return 'This wallet has no SOSO for gas on ValueChain.';
  return null;
}

// --- calldata ------------------------------------------------------------------------------------

export const depositData = (assets: bigint) => `${RECURRING_SELECTOR.deposit}${uintWord(assets)}`;
export const redeemData = (shares: bigint) => `${RECURRING_SELECTOR.redeem}${uintWord(shares)}`;
export const createPlanData = (vault: string, amount: bigint, type: PlanType, day: number) =>
  `${RECURRING_SELECTOR.createInvestmentPlan}${addrWord(vault)}${uintWord(amount)}${uintWord(BigInt(PLAN_CODE[type]))}${uintWord(BigInt(day))}`;
export const updatePlanData = (planIndex: bigint, amount: bigint, type: PlanType, day: number) =>
  `${RECURRING_SELECTOR.updateInvestmentPlanByIndex}${uintWord(planIndex)}${uintWord(amount)}${uintWord(BigInt(PLAN_CODE[type]))}${uintWord(BigInt(day))}`;
export const planActionData = (action: 'pause' | 'resume' | 'cancel', planIndex: bigint) =>
  `${action === 'pause' ? RECURRING_SELECTOR.pauseInvestmentPlanByIndex : action === 'resume' ? RECURRING_SELECTOR.resumeInvestmentPlanByIndex : RECURRING_SELECTOR.cancelInvestmentPlanByIndex}${uintWord(planIndex)}`;

// --- sending --------------------------------------------------------------------------------------

async function gasCheck(owner: string): Promise<void> {
  const r = await rpcBatch(VALUECHAIN_RPC, [nativeBalanceCall(owner)]);
  if ((hexUnits(r.get(0)) ?? 0n) === 0n) throw new RangeError('This wallet has no SOSO for gas on ValueChain.');
}

/** Move USDC from the wallet into the shared balance: approve it if needed, then deposit. */
export async function addFunds(o: { provider: Eip1193Provider; owner: string; amount: bigint; onStep?: StepSink }): Promise<string> {
  await preflight(o.owner, 'buy');
  const f = await readPrefund(o.owner);
  const problem = fundsProblem('add', o.amount, f);
  if (problem) throw new RangeError(problem);
  const { chainId, switched } = await ensureChain(o.provider);
  const needApprove = (await allowanceOf(f.usdc, o.owner, f.deposit)) < o.amount;
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + (needApprove ? 1 : 0) + 1);
  if (switched) ask('approve');
  if (needApprove) {
    ask('approve');
    await send(o.provider, o.owner, chainId, f.usdc, approveData(f.deposit, o.amount), 'approval');
  }
  ask('confirm');
  const hash = await send(o.provider, o.owner, chainId, f.deposit, depositData(o.amount), 'deposit into the recurring balance');
  log.info('recurring funds added');
  return hash;
}

/** Take unused USDC back to the wallet. `amount` at or above the balance takes all of it. */
export async function withdrawPrefund(o: { provider: Eip1193Provider; owner: string; amount: bigint; onStep?: StepSink }): Promise<string> {
  const f = await readPrefund(o.owner);
  const problem = fundsProblem('withdraw', o.amount, f);
  if (problem) throw new RangeError(problem);
  const shares = sharesFor(o.amount, f);
  if (shares <= 0n) throw new RangeError('That amount is too small to withdraw.');
  const { chainId, switched } = await ensureChain(o.provider);
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + 1);
  if (switched) ask('approve');
  ask('confirm');
  return send(o.provider, o.owner, chainId, f.deposit, redeemData(shares), 'withdrawal from the recurring balance');
}

export function planProblem(target: Pick<RecurringTarget, 'minAmount'>, amount: bigint, type: PlanType, day: number): string | null {
  if (amount <= 0n) return 'Enter an amount.';
  if (amount < target.minAmount) return 'Below this asset\'s minimum per purchase.';
  return dayProblem(type, day);
}

export async function createPlan(o: { provider: Eip1193Provider; owner: string; target: RecurringTarget; amount: bigint; type: PlanType; day: number; onStep?: StepSink }): Promise<string> {
  await preflight(o.owner, 'buy');
  const problem = planProblem(o.target, o.amount, o.type, o.day);
  if (problem) throw new RangeError(problem);
  await gasCheck(o.owner);
  const { chainId, switched } = await ensureChain(o.provider);
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + 1);
  if (switched) ask('approve');
  ask('confirm');
  const hash = await send(o.provider, o.owner, chainId, AUTO_INVEST, createPlanData(o.target.vault, o.amount, o.type, o.day), 'recurring plan');
  log.info('recurring plan created', { fundId: o.target.fund.fundId, type: o.type });
  return hash;
}

export async function updatePlan(o: { provider: Eip1193Provider; owner: string; plan: RecurringPlan; target: RecurringTarget; amount: bigint; type: PlanType; day: number; onStep?: StepSink }): Promise<string> {
  await preflight(o.owner, 'buy');
  const problem = planProblem(o.target, o.amount, o.type, o.day);
  if (problem) throw new RangeError(problem);
  if (!/^\d+$/.test(o.plan.planIndex)) throw new RangeError('This plan has no index SoDEX can act on.');
  await gasCheck(o.owner);
  const { chainId, switched } = await ensureChain(o.provider);
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + 1);
  if (switched) ask('approve');
  ask('confirm');
  return send(o.provider, o.owner, chainId, AUTO_INVEST, updatePlanData(BigInt(o.plan.planIndex), o.amount, o.type, o.day), 'plan change');
}

/** Pause, resume or end one of the wallet's plans. Ending keeps the holdings and the balance. */
export async function planAction(o: { provider: Eip1193Provider; owner: string; plan: Pick<RecurringPlan, 'planIndex'>; action: 'pause' | 'resume' | 'cancel'; onStep?: StepSink }): Promise<string> {
  if (!/^\d+$/.test(o.plan.planIndex)) throw new RangeError('This plan has no index SoDEX can act on.');
  if (o.action === 'resume') await preflight(o.owner, 'buy');
  await gasCheck(o.owner);
  const { chainId, switched } = await ensureChain(o.provider);
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + 1);
  if (switched) ask('approve');
  ask('confirm');
  const what = o.action === 'pause' ? 'pause' : o.action === 'resume' ? 'resume' : 'end of the plan';
  return send(o.provider, o.owner, chainId, AUTO_INVEST, planActionData(o.action, BigInt(o.plan.planIndex)), what);
}
