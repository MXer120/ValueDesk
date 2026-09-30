/**
 * sodex.com's own money plumbing, used the way sodex.com uses it (researched
 * from its bundle and SoDEX's verified contracts, 2026-09-26):
 *
 *   alpha-biz  POST /biz/mirror/call_for_permit      every permit (deposit and
 *                                                     withdrawal) - SoDEX's relayer
 *                                                     executes it and pays the gas
 *              POST /biz/mirror/analyse_address      the address risk check before
 *                                                     every custody withdrawal
 *              GET  /biz/v1/ext-chain/maintenance    per coin/chain maintenance
 *   ValueChain CallForPermit.execute simulated with eth_call BEFORE a request
 *              is sent (anyone may call it, so the simulation runs exactly what the
 *              relayer will run), the relayed transaction's receipt, and the
 *              Withdrawer's own on-chain record of a withdrawal.
 *
 * Where sodex.com is laxer we are stricter, never the other way round: every
 * request is simulated first; a withdrawal is tracked by its on-chain record,
 * not by a status API; maintenance that cannot be read is reported (sodex.com
 * silently treats it as none).
 */
import {
  CALL_FOR_PERMIT_CONTRACT,
  CALL_FOR_PERMIT_PATH,
  WITHDRAWAL_CREATED_TOPIC,
  WITHDRAW_TOKEN_TARGET,
  WithdrawalStatus,
  decodeUint,
  decodeWithdrawal,
  describeRevert,
  executeCallData,
  getWithdrawalCallData,
  isBlacklistedCallData,
  withdrawRequirementsCallData,
  type CallForPermitRequest,
  type WithdrawalRecord,
} from '@sodex-core';
import { OutcomeUnknownError } from './gateway';
import { VALUECHAIN_RPC, rpcCall } from './rpc';

/** sodex.com's API host (its `Er` client). */
export const BIZ_ORIGIN = 'https://alpha-biz.sodex.dev';
/** The registry that answers withdraw requirements (fee, liquidity). */
export const QUERY_CONTRACT = '0xFcacAac4cD08F6664b1ddE698c9d5d29C3675E70';
const BIZ_TIMEOUT_MS = 15_000;

/** A definite "no" from SoDEX - nothing was done. */
export class RelayRefused extends Error {
  override name = 'RelayRefused';
}

async function bizFetch(path: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BIZ_TIMEOUT_MS);
  try {
    return await fetch(BIZ_ORIGIN + path, { ...init, signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST a signed call-for-permit request, exactly sodex.com's body. Returns the
 * relayed ValueChain transaction hash (null when SoDEX accepted it without
 * one - it may still land). Throws RelayRefused for a definite refusal, and
 * OutcomeUnknownError when the answer never came (the request may have been
 * executed: never re-send a NEW permit blindly - the caller checks the nonce).
 */
export async function submitCallForPermit(req: CallForPermitRequest): Promise<string | null> {
  let res: Response;
  try {
    res = await bizFetch(CALL_FOR_PERMIT_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(req) });
  } catch {
    throw new OutcomeUnknownError('SoDEX did not answer the request.');
  }
  const body = (await res.json().catch(() => null)) as { code?: unknown; msg?: string; message?: string; data?: { txHash?: string } } | null;
  if (res.status >= 500 || !body) throw new OutcomeUnknownError(`SoDEX answered HTTP ${res.status}.`);
  const code = Number(body.code);
  if (!res.ok || (code !== 0 && code !== 200)) throw new RelayRefused(body.msg || body.message || `SoDEX refused the request (${String(body.code ?? res.status)}).`);
  const hash = body.data?.txHash;
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null;
}

/**
 * SoDEX's address risk check (Chainalysis KYT) - sodex.com calls it before
 * every custody withdrawal and stops on any error. Its answer is not used by
 * sodex.com either; a high-risk address is refused later by SoDEX and the
 * withdrawal fails back to the account. We call it first, the same way.
 */
export async function analyseAddress(address: string): Promise<void> {
  let res: Response;
  try {
    res = await bizFetch('/biz/mirror/analyse_address', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
  } catch {
    throw new RelayRefused('SoDEX\'s address check did not answer - nothing was moved. Try again in a moment.');
  }
  if (!res.ok) throw new RelayRefused(`SoDEX's address check failed (HTTP ${res.status}) - nothing was moved.`);
}

// --- maintenance -------------------------------------------------------------------------

export interface MaintenanceNote {
  /** 'congested': works, slowly (a warning). 'unavailable': switched off. */
  severity: 'congested' | 'unavailable';
  message: string;
  duration: string;
}
type Affect = 'deposit' | 'withdraw';
type ByAffect = Partial<Record<Affect, MaintenanceNote>>;
export interface Maintenance {
  /** false: SoDEX's maintenance status could not be read (shown as a notice; nothing is blocked). */
  known: boolean;
  global: ByAffect;
  coinWide: ByAffect;
  byChain: Record<string, ByAffect>;
}

const NONE: Maintenance = { known: true, global: {}, coinWide: {}, byChain: {} };
const maintenanceCache = new Map<string, { at: number; value: Promise<Maintenance> }>();
const MAINTENANCE_TTL_MS = 60_000;

/** Unavailable beats congested; the first of equal severity stays. */
const merge = (into: ByAffect, affect: Affect, note: MaintenanceNote) => {
  const had = into[affect];
  if (!had || (had.severity === 'congested' && note.severity === 'unavailable')) into[affect] = note;
};

async function readMaintenance(coin: string, owner: string): Promise<{ known: boolean; rows: unknown[] }> {
  try {
    const q = new URLSearchParams({ coin, lang: 'en', address: owner, env: 'mainnet' });
    const res = await bizFetch(`/biz/v1/ext-chain/maintenance?${q}`, { method: 'GET', headers: { Accept: 'application/json' } });
    const body = (await res.json()) as { code?: unknown; data?: unknown };
    return res.ok && Number(body.code) === 0 ? { known: true, rows: Array.isArray(body.data) ? body.data : [] } : { known: false, rows: [] };
  } catch {
    return { known: false, rows: [] };
  }
}

/**
 * SoDEX's maintenance for `coin` (sodex.com: USDC first for the global notice,
 * then the coin itself for its chains). Cached a minute.
 */
export function maintenanceFor(coin: string, owner: string): Promise<Maintenance> {
  const key = `${coin.toUpperCase()}|${owner.toLowerCase()}`;
  const hit = maintenanceCache.get(key);
  if (hit && Date.now() - hit.at < MAINTENANCE_TTL_MS) return hit.value;
  const value = (async (): Promise<Maintenance> => {
    const upper = coin.toUpperCase();
    const reads = [readMaintenance('USDC', owner), ...(upper === 'USDC' ? [] : [readMaintenance(coin, owner)])];
    const [usdc, own = usdc] = await Promise.all(reads);
    const m: Maintenance = { known: usdc!.known && own!.known, global: {}, coinWide: {}, byChain: {} };
    for (const [rows, isOwnCoin] of [[usdc!.rows, upper === 'USDC'], [own!.rows, true]] as const) {
      for (const r of rows as Array<Record<string, unknown>>) {
        const message = typeof r.maintenanceInfo === 'string' ? r.maintenanceInfo.trim() : '';
        const affect = r.affectType;
        if (!message || (affect !== 'deposit' && affect !== 'withdraw') || typeof r.coin !== 'string' || typeof r.chain !== 'string' || !r.coin || !r.chain) continue;
        const note: MaintenanceNote = { severity: r.severity === 'congested' ? 'congested' : 'unavailable', message, duration: typeof r.estimatedDuration === 'string' ? r.estimatedDuration : '' };
        if (r.coin === '*' && r.chain === '*') {
          if (note.severity === 'unavailable') merge(m.global, affect, note);
          continue;
        }
        if (!isOwnCoin || r.coin.toUpperCase() !== upper) continue;
        if (r.chain === '*') merge(m.coinWide, affect, note);
        else merge((m.byChain[r.chain.toUpperCase()] ??= {}), affect, note);
      }
    }
    return m;
  })();
  maintenanceCache.set(key, { at: Date.now(), value });
  value.catch(() => maintenanceCache.delete(key));
  return value;
}

/** What applies to one chain for deposits or withdrawals: its own note, the coin's, or the global one. */
export function maintenanceNote(m: Maintenance | null | undefined, chainKey: string, affect: Affect): MaintenanceNote | null {
  if (!m) return null;
  return m.byChain[chainKey.toUpperCase()]?.[affect] ?? m.coinWide[affect] ?? m.global[affect] ?? null;
}

export const _noMaintenance = NONE;
/** For tests. */
export const _clearMaintenance = (): void => maintenanceCache.clear();

// --- ValueChain: views, simulation, receipts ------------------------------------------------

/** A view call on ValueChain; throws with the contract's own reason when it reverts. */
export async function valueChainCall(to: string, data: string): Promise<string> {
  const r = await rpcCall(VALUECHAIN_RPC, 'eth_call', [{ to, data }, 'latest']);
  if (r.error || typeof r.result !== 'string') {
    const why = describeRevert(r.error?.data);
    throw new RangeError(why ? why.text : r.error?.message ?? 'ValueChain did not answer');
  }
  return r.result;
}

/**
 * Run the request exactly as SoDEX's relayer will - `CallForPermit.execute`
 * via eth_call - and refuse to send it if the contract would revert. Checks the
 * signature, the nonce, the permit and every rule the contract enforces (min,
 * fee, blacklist, whitelist, custody switched off, pause, balance).
 */
export async function simulateCallForPermit(req: CallForPermitRequest): Promise<void> {
  const r = await rpcCall(VALUECHAIN_RPC, 'eth_call', [{ to: CALL_FOR_PERMIT_CONTRACT, data: executeCallData(req) }, 'latest']);
  if (!r.error) return;
  const why = describeRevert(r.error.data);
  if (!why && /timeout|fetch|network/i.test(r.error.message ?? '')) throw new OutcomeUnknownError('ValueChain did not answer the check.');
  throw new RelayRefused(`SoDEX would refuse this: ${why ? why.text : r.error.message ?? 'reverted'}.`);
}

export interface Receipt {
  status: 'success' | 'reverted';
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

/** The ValueChain receipt of `hash`, waited for up to `timeoutMs` (null: not mined yet). */
export async function waitForReceipt(hash: string, timeoutMs = 120_000): Promise<Receipt | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await rpcCall<{ status?: string; logs?: Receipt['logs'] } | null>(VALUECHAIN_RPC, 'eth_getTransactionReceipt', [hash]);
      if (r.result && typeof r.result.status === 'string') return { status: BigInt(r.result.status) === 1n ? 'success' : 'reverted', logs: r.result.logs ?? [] };
    } catch {
      /* a lookup failing is not the transaction failing: keep asking */
    }
    if (Date.now() > until) return null;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** The withdrawal a relayed WithdrawToken created (its `WithdrawalCreated` log), or null. */
export function withdrawalFromReceipt(receipt: Receipt): WithdrawalRecord | null {
  const log = receipt.logs.find((l) => l.address.toLowerCase() === WITHDRAW_TOKEN_TARGET.toLowerCase() && l.topics[0]?.toLowerCase() === WITHDRAWAL_CREATED_TOPIC);
  if (!log) return null;
  try {
    return decodeWithdrawal(log.data);
  } catch {
    return null;
  }
}

/** A withdrawal's current on-chain record (SoDEX's Withdrawer), or null when unreadable. */
export async function withdrawalRecord(id: bigint): Promise<WithdrawalRecord | null> {
  try {
    return decodeWithdrawal(await valueChainCall(WITHDRAW_TOKEN_TARGET, getWithdrawalCallData(id)));
  } catch {
    return null;
  }
}

export const withdrawalDone = (w: WithdrawalRecord): boolean =>
  w.status === WithdrawalStatus.SUCCESS || w.status === WithdrawalStatus.FAILED || w.status === WithdrawalStatus.REJECTED;
export const WITHDRAWAL_STATUS_LABEL: Record<number, string> = {
  [WithdrawalStatus.PENDING]: 'Requested',
  [WithdrawalStatus.APPROVED]: 'Sending',
  [WithdrawalStatus.SUCCESS]: 'Completed',
  [WithdrawalStatus.FAILED]: 'Failed - returned to your account',
  [WithdrawalStatus.REJECTED]: 'Rejected - returned to your account',
};

/** Withdraw requirements for this coin/chain (fee and custody liquidity, in token base units). */
export async function withdrawRequirements(coinSymbol: string, chain: string, account: string, withdrawType: number): Promise<{ fee: bigint; available: bigint }> {
  const hex = await valueChainCall(QUERY_CONTRACT, withdrawRequirementsCallData(coinSymbol, chain, account, withdrawType));
  return { fee: decodeUint(hex, 0), available: decodeUint(hex, 2) };
}

/** SoDEX's on-chain blacklist for withdrawal receivers. */
export async function receiverBlacklisted(chain: string, receiver: string): Promise<boolean> {
  return decodeUint(await valueChainCall(WITHDRAW_TOKEN_TARGET, isBlacklistedCallData(chain, receiver))) !== 0n;
}
