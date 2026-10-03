/**
 * Money in and out of SoDEX from the browser - the same requests, to the same
 * places, as sodex.com (researched from its bundle and SoDEX's verified
 * contracts, 2026-09-26; trading/relay.ts has the endpoints).
 *
 * IN
 *   - From the connected wallet (EVM -> Spot, ValueChain coins):
 *       ERC-20       no gas: the token's permit + a CallForPermit
 *                    (DepositERC20WithPermit), two signatures, relayed by SoDEX;
 *       native SOSO  one wallet transaction to the exchange gateway.
 *   - "Transfer crypto": the wallet's own SoDEX custody address per chain,
 *     re-derived from the ValueChain registry by the backend (routes/mirror.ts).
 *
 * OUT (the Withdraw modal)
 *   - To the wallet on ValueChain: perps -> spot (if needed) -> wallet, signed by
 *     the trading key (actions.withdraw), no wallet prompt.
 *   - To another chain: the amount must sit in the ValueChain wallet ("EVM
 *     funding"); whatever is missing is moved there from Spot/Perps first, then
 *     the wallet signs ONE WithdrawToken permit and SoDEX relays it, paying the gas.
 *
 * STRICTER THAN SODEX.COM, NEVER LAXER. Before anything moves: SoDEX's
 * maintenance switch, its address risk check, the on-chain fee (must be the one
 * shown), custody liquidity and the receiver blacklist - and never to the
 * owner's own SoDEX deposit address, nor to any SoDEX deposit address that would
 * receive less than SoDEX's deposit minimum (components/funds/depositGuard.ts:
 * it would never be credited). Before anything is sent:
 * the signed request is run on-chain as SoDEX's relayer will run it (eth_call) -
 * a request the contract would refuse is never sent. After: the receipt, and
 * for a withdrawal the Withdrawer's own record of it.
 *
 * EXACT AMOUNTS. Every balance, plan and wait is in integer base units of the
 * coin (bigint), parsed from SoDEX's decimal strings and truncated DOWN - a
 * float or a round-up would ask for more than the account holds.
 *
 * NEVER TWICE. A permit whose answer was unclear is remembered (with its
 * nonce). Before the next one the contract's nonce is read: if the remembered
 * permit was used, nothing moves and the user is told; if not, the new permit
 * takes the SAME nonce, so at most one of the two can execute.
 */
import {
  CALL_FOR_PERMIT_CONTRACT,
  CLOB_GATEWAY,
  DEPOSIT_NONCE_KEY,
  WITHDRAW_NONCE_KEY,
  WithdrawalStatus as WithdrawalState,
  assembleCallForPermit,
  decodeString,
  decodeUint,
  nameCallData,
  nativeDepositCallData,
  permitNonceCall,
  prepareDepositPermit,
  prepareTokenPermit,
  prepareWithdrawPermit,
  tokenNoncesCallData,
  withdrawAsCallForPermit,
  type CallForPermitRequest,
  type Engine,
} from '@sodex-core';
import { api, type DepositChain } from '../api';
import { addOrSwitchChain, getChainId, sendTransaction, signTypedData, WalletError, type Eip1193Provider } from '../wallet';
import { ADDRESS_KIND_LABEL, addressProblem, toChecksumAddress, type AddressKind } from './addresses';
import { OutcomeUnknownError, readGateway } from './gateway';
import { erc20TransferData, formatUnits, parseUnits } from './onboard';
import {
  RelayRefused,
  WITHDRAWAL_STATUS_LABEL,
  analyseAddress,
  maintenanceFor,
  maintenanceNote,
  receiverBlacklisted,
  simulateCallForPermit,
  submitCallForPermit,
  valueChainCall,
  waitForReceipt,
  withdrawRequirements,
  withdrawalDone,
  withdrawalFromReceipt,
  withdrawalRecord,
} from './relay';
import { VALUECHAIN_RPC, balanceOfCall, hexUnits, nativeBalanceCall, rpcBatch } from './rpc';
import { openingWalletStep } from '../components/funds/openingStep';
import { _clearReceiverCache, arrivalCheck, receiverAccount } from '../components/funds/depositGuard';
import { logger } from '../log';

const log = logger('trade');

// --- the catalogue ----------------------------------------------------------------

export interface ChainRoute {
  /** SoDEX's chain key, e.g. "ARBITRUM_ETH". */
  key: string;
  label: string;
  /** Receiver address format this chain uses ('other': not offered here). */
  addressKind: AddressKind | 'other';
  /**
   * 'numeric': a withdrawal may carry a numeric memo (XRP destination tag,
   * Stellar memo id) - exchanges need it, so it is asked for unless the user
   * says the address takes none (as sodex.com does).
   */
  memo: 'numeric' | null;
  /**
   * How SoDEX pays a withdrawal out: 0 its custodian, 1 its bridge ("flash") -
   * sodex.com's own fixed list of bridged coins (FLASH_COINS).
   */
  withdrawType: 0 | 1;
  tokenAddress: string | null;
  isNativeToken: boolean;
  deposit: { allowed: boolean; min: string | null; etaSeconds: number | null };
  withdraw: { allowed: boolean; min: string | null; fee: string | null };
}

export interface CoinConfig {
  /** SoDEX's external coin name, e.g. "USDC" (the permit's coinSymbol). */
  coin: string;
  /** The engine coin, e.g. "vUSDC", and its id. */
  asset: string;
  assetId: number | null;
  /** The ValueChain token (what the wallet holds and what a permit moves). */
  valuechain: { token: string; symbol: string; decimals: number; native: boolean };
  chains: ChainRoute[];
  /** Perps collateral haircut (0 = Perps does not take it); null when SoDEX did not say. */
  marginRatio?: number | null;
}

const CHAIN_LABELS: Record<string, string> = {
  ETH: 'Ethereum',
  BASE_ETH: 'Base',
  ARBITRUM_ETH: 'Arbitrum One',
  MATIC: 'Polygon',
  BSC_BNB: 'BNB Smart Chain',
  AVAXC: 'Avalanche C-Chain',
  HYPEREVM_HYPE: 'HyperEVM',
  ROBINHOOD_ETH: 'Robinhood Chain',
  SOL: 'Solana',
  ARC: 'Arc',
  BTC: 'Bitcoin',
  LTC: 'Litecoin',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
  SUI: 'Sui',
  TON: 'TON',
  XLM: 'Stellar',
  XRP: 'XRP Ledger',
  ZEC: 'Zcash',
};
/** The address each SoDEX chain pays out to (trading/addresses.ts). A chain not listed is not offered. */
export const CHAIN_ADDRESS: Record<string, AddressKind> = {
  ETH: 'evm', BASE_ETH: 'evm', ARBITRUM_ETH: 'evm', MATIC: 'evm', BSC_BNB: 'evm', AVAXC: 'evm', HYPEREVM_HYPE: 'evm', ARC: 'evm', ROBINHOOD_ETH: 'evm',
  SOL: 'solana', BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin', ADA: 'cardano', SUI: 'sui', TON: 'ton', XLM: 'stellar', XRP: 'xrp',
};
/** Chains whose withdrawals take a numeric memo (sodex.com: "Memo", digits only). */
const MEMO_CHAINS = new Set(['XRP', 'XLM']);
/**
 * The coins SoDEX pays out through its bridge (withdrawType 1) - sodex.com's
 * own list, exactly. Their custodian is switched off (the asset config says
 * withdrawals are closed, and a custody withdrawal reverts CustodyDisabled);
 * the bridge is configured on-chain (getWithdrawRequirements type 1, 2026-09-26).
 */
export const FLASH_COINS: ReadonlySet<string> = new Set(['MAG7.ssi', 'sMAG7.ssi', 'MEME.ssi', 'DEFI.ssi', 'USSI']);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/**
 * What a wallet keeps of the gas coin (native SOSO) for fees: never offered as
 * movable. sodex.com keeps 0.001 SOSO back the same way.
 */
export const GAS_RESERVE_WEI = 10n ** 15n;
export const chainLabel = (key: string): string => CHAIN_LABELS[key] ?? key.replace(/_/g, ' ');

interface RawAsset {
  assetName?: string;
  valueChainMetadata?: { tokenSymbol?: string; tokenDecimals?: number; evmAddress?: string; isNativeToken?: boolean };
  sodexMetadata?: { id?: number; name?: string; marginRatio?: string } | null;
  chains?: Array<{
    chainName?: string;
    isNativeToken?: boolean;
    tokenAddress?: string;
    custody?: {
      minDepositAmount?: string;
      minWithdrawAmount?: string;
      withdrawFee?: string;
      allowDeposit?: boolean;
      allowWithdraw?: boolean;
      estimatedDepositSeconds?: number;
    };
  }>;
}

const dec = (v: unknown): string | null => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : null);

const CONFIG_TTL_MS = 5 * 60_000;
let configCache: { at: number; value: Promise<CoinConfig[]> } | null = null;

/**
 * assetConfigs(), shared for five minutes: the sheets and the wallet read open
 * on it, and SoDEX's coin list changes rarely. A failed read is not kept.
 */
export function cachedAssetConfigs(): Promise<CoinConfig[]> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  const value = assetConfigs();
  const entry = { at: Date.now(), value };
  configCache = entry;
  value.catch(() => {
    if (configCache === entry) configCache = null;
  });
  return value;
}

/** For tests. */
export const _clearConfigCache = (): void => {
  configCache = null;
};

/** SoDEX's live asset config, as coins with the chains each can move on. */
export async function assetConfigs(): Promise<CoinConfig[]> {
  const rows = await readGateway<RawAsset[]>('/api/v1/asset/config');
  const out: CoinConfig[] = [];
  for (const r of rows ?? []) {
    const vc = r.valueChainMetadata;
    // Native SOSO has no token contract (the engine holds it as WSOSO, id 4):
    // it moves as plain value, so its "token" is the zero address.
    if (!r.assetName || !vc || typeof vc.tokenDecimals !== 'number' || (!vc.evmAddress && !vc.isNativeToken)) continue;
    const flash = FLASH_COINS.has(r.assetName);
    out.push({
      coin: r.assetName,
      asset: r.sodexMetadata?.name ?? vc.tokenSymbol ?? r.assetName,
      assetId: typeof r.sodexMetadata?.id === 'number' ? r.sodexMetadata.id : null,
      marginRatio: dec(r.sodexMetadata?.marginRatio) !== null ? Number(r.sodexMetadata!.marginRatio) : null,
      valuechain: { token: vc.evmAddress ?? ZERO_ADDRESS, symbol: vc.tokenSymbol ?? r.assetName, decimals: vc.tokenDecimals, native: !!vc.isNativeToken },
      chains: (r.chains ?? [])
        .filter((c) => c.chainName && c.custody)
        .map((c) => ({
          key: c.chainName!,
          label: chainLabel(c.chainName!),
          addressKind: CHAIN_ADDRESS[c.chainName!] ?? 'other',
          memo: MEMO_CHAINS.has(c.chainName!) ? 'numeric' : null,
          withdrawType: flash ? 1 : 0,
          tokenAddress: c.tokenAddress ?? null,
          isNativeToken: !!c.isNativeToken,
          deposit: { allowed: !!c.custody!.allowDeposit, min: dec(c.custody!.minDepositAmount), etaSeconds: c.custody!.estimatedDepositSeconds ?? null },
          // A bridged coin's custody switch says nothing about its bridge: sodex.com
          // offers it, and its fee and minimum come from the chain (withdrawQuote).
          withdraw: flash
            ? { allowed: true, min: null, fee: null }
            : { allowed: !!c.custody!.allowWithdraw, min: dec(c.custody!.minWithdrawAmount), fee: dec(c.custody!.withdrawFee) },
        })),
    });
  }
  return out;
}

// --- receivers ------------------------------------------------------------------------

export { toChecksumAddress } from './addresses';

/**
 * Is `addr` a valid receiver on this chain? Checksums included (a withdrawal
 * to a mistyped address is gone), plus what sodex.com itself insists on:
 * lower-case bech32 for Bitcoin/Litecoin, EQ/UQ for a user-friendly TON address.
 */
export function receiverProblem(route: ChainRoute | 'VALUECHAIN', addr: string): string | null {
  const a = addr.trim();
  if (!a) return 'Enter the destination address.';
  const label = route === 'VALUECHAIN' ? 'ValueChain' : route.label;
  const kind = route === 'VALUECHAIN' ? 'evm' : route.addressKind;
  if (kind === 'other') return 'This network is not supported here.';
  const invalid = `Enter a valid ${label} address.`;
  const p = addressProblem(kind, a);
  if (p === 'zero') return 'That is the zero address - funds sent there are gone.';
  if (p === 'checksum') return 'This address fails its checksum - it was probably mistyped.';
  if (p) return invalid;
  if ((kind === 'bitcoin' || kind === 'litecoin') && /^(bc1|ltc1)/i.test(a) && a !== a.toLowerCase()) return `${invalid} Write it in lower case.`;
  if (kind === 'ton' && !/^(EQ|UQ)|^-?[01]:/.test(a)) return invalid;
  return null;
}

/** Why this memo will not do (null = fine). `none`: the user said the address takes no memo. */
export function memoProblem(route: ChainRoute | 'VALUECHAIN', memo: string, none: boolean): string | null {
  if (route === 'VALUECHAIN' || route.memo !== 'numeric' || none) return null;
  const m = memo.trim();
  if (!m) return `Enter the memo (tag) for this address, or tick that it has none. Exchanges need it to credit your ${route.label} deposit.`;
  if (!/^\d{1,20}$/.test(m)) return 'The memo is a number (digits only).';
  if (route.key === 'XRP' && BigInt(m) > 4294967295n) return 'An XRP destination tag is at most 4294967295.';
  return null;
}

export { ADDRESS_KIND_LABEL };

// --- balances (exact, in base units) ------------------------------------------------------

/** "84.0949996" -> base units at `dp`, TRUNCATED (never rounds up; negatives -> 0). */
export function unitsDown(v: string | number | null | undefined, dp: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v ?? '').trim());
  if (!m) return 0n;
  return BigInt(m[1]!) * 10n ** BigInt(dp) + BigInt(((m[2] ?? '') + '0'.repeat(dp)).slice(0, dp) || '0');
}

export interface Balances {
  /** Exact decimal strings (truncated to the coin's decimals). */
  spot: string;
  perps: string;
  /** In the ValueChain wallet. */
  evm: string;
}

interface StateRow {
  i?: number;
  a?: string;
  /** Spot: total and locked. */
  t?: string;
  l?: string;
  /** Perps: wallet balance, and what of it can leave the perps account (sodex.com: availableForWithdraw). */
  wb?: string;
  at?: string;
}

/**
 * sodex.com keeps 2% back when it offers the perps balance for a transfer
 * (`availableForTransfer x 0.98`): with positions or orders open that figure
 * moves with every tick, and a transfer sized to the last snapshot is rejected
 * the moment the price moves against it. With nothing open it cannot move, so
 * the whole amount is offered.
 */
const PERPS_HEADROOM_PCT = 98n;

/** Spot, Perps (withdrawable) and ValueChain-wallet balances of `coin` for `owner`. */
export async function balancesOf(owner: string, coin: CoinConfig): Promise<Balances> {
  const dp = coin.valuechain.decimals;
  const match = (r: StateRow) => r.i === coin.assetId || (r.a ?? '').toUpperCase() === coin.asset.toUpperCase();
  const [spot, perps, evm] = await Promise.all([
    readGateway<{ B?: StateRow[] } | null>(`/api/v1/spot/accounts/${owner}/state`).catch(() => null),
    readGateway<{ B?: StateRow[]; amw?: string; P?: unknown[]; O?: unknown[] } | null>(`/api/v1/perps/accounts/${owner}/state`).catch(() => null),
    walletUnits(owner, coin),
  ]);
  const freeOf = (row: StateRow | undefined): bigint => {
    if (!row) return 0n;
    const f = unitsDown(row.t ?? row.wb, dp) - unitsDown(row.l, dp);
    return f > 0n ? f : 0n;
  };
  // Per coin `at` (available for withdraw) is what the engine lets leave perps -
  // NOT the wallet balance (margin in use cannot move) and not the account-wide
  // `amw` (a USD figure across all collateral; one live account reads amw 60,768
  // with 0 USDC withdrawable). The older fields are only a fallback for a state
  // without `at`.
  const perpsRow = perps?.B?.find(match);
  let perpsFree = unitsDown(perpsRow?.at ?? (coin.asset.toUpperCase() === 'VUSDC' ? perps?.amw : perpsRow?.wb), dp);
  if ((perps?.P?.length ?? 0) > 0 || (perps?.O?.length ?? 0) > 0) perpsFree = (perpsFree * PERPS_HEADROOM_PCT) / 100n;
  // The gas coin: what the wallet needs for fees is never offered as movable.
  const evmFree = coin.valuechain.native ? (evm > GAS_RESERVE_WEI ? evm - GAS_RESERVE_WEI : 0n) : evm;
  return {
    spot: formatUnits(freeOf(spot?.B?.find(match)), dp),
    perps: formatUnits(perpsFree, dp),
    evm: formatUnits(evmFree, dp),
  };
}

/**
 * What the wallet holds of `coin` on ValueChain, in base units: one call
 * straight to ValueChain (about 0.1-0.3 s). ValueChain's explorer answers the
 * same from its own index, exact to the base unit, so it is the fallback when
 * the RPC does not answer - both straight from this browser.
 */
async function walletUnits(owner: string, coin: CoinConfig): Promise<bigint> {
  try {
    const call = coin.valuechain.native ? nativeBalanceCall(owner) : balanceOfCall(coin.valuechain.token, owner);
    const units = hexUnits((await rpcBatch(VALUECHAIN_RPC, [call])).get(0));
    if (units !== null) return units;
  } catch {
    /* the explorer below */
  }
  return explorerUnits(owner, coin).catch(() => 0n);
}

/** ValueChain's explorer (Blockscout): the wallet's balance of `coin`, exact, in base units. */
const VALUECHAIN_EXPLORER_API = 'https://main-scan.valuechain.xyz/api/v2';
async function explorerUnits(owner: string, coin: CoinConfig): Promise<bigint> {
  const base = `${VALUECHAIN_EXPLORER_API}/addresses/${owner}`;
  const get = async (url: string): Promise<unknown> => {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error(`explorer HTTP ${r.status}`);
    return r.json();
  };
  const int = (v: unknown): bigint => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : 0n);
  if (coin.valuechain.native) return int(((await get(base)) as { coin_balance?: unknown } | null)?.coin_balance);
  const j = await get(`${base}/token-balances`);
  const rows = (Array.isArray(j) ? j : ((j as { items?: unknown[] } | null)?.items ?? [])) as Array<{ value?: unknown; token?: { address?: string; address_hash?: string } }>;
  const want = coin.valuechain.token.toLowerCase();
  return int(rows.find((b) => (b.token?.address ?? b.token?.address_hash ?? '').toLowerCase() === want)?.value);
}

// --- deposit from the connected wallet (ValueChain -> Spot) ---------------------------

export async function valueChain(): Promise<DepositChain> {
  return api.depositChain();
}

/**
 * Where a funds flow stands - the sheets put it on their button instead of a
 * running commentary. `wallet` is set while the wallet is asking the user: the
 * `n`-th of this flow's `of` prompts, 'approve' for a network switch or an
 * allowance, 'confirm' for the one that moves the funds. `wallet: null` is SoDEX
 * or the chain at work, with nothing for the user to do.
 */
export type FundsStep = { wallet: 'approve' | 'confirm'; n: number; of: number } | { wallet: null };
export type StepSink = (step: FundsStep) => void;
const WORKING: FundsStep = { wallet: null };

/** Numbers one flow's wallet prompts ("1/2", "2/2"); never reports n above of. */
export function promptCounter(onStep: StepSink | undefined, of: number): (wallet: 'approve' | 'confirm') => void {
  let n = 0;
  return (wallet) => {
    n += 1;
    onStep?.({ wallet, n, of: Math.max(of, n) });
  };
}

/** Whether pointing the wallet at ValueChain will ask the user (it is on another chain). */
const needsSwitch = async (provider: Eip1193Provider, chain: DepositChain): Promise<boolean> =>
  (await getChainId(provider)) !== chain.chainId;

const onValueChain = async (provider: Eip1193Provider, chain: DepositChain) =>
  addOrSwitchChain(provider, {
    chainId: chain.chainIdHex,
    chainName: chain.name,
    rpcUrls: [chain.rpcUrl],
    blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : [],
    nativeCurrency: chain.nativeCurrency,
  });

/** The CallForPermit nonce of `owner` on one lane (0 withdrawals, 2 deposits), key-packed as the contract returns it. */
const relayNonce = async (owner: string, lane: bigint): Promise<bigint> => decodeUint(await valueChainCall(CALL_FOR_PERMIT_CONTRACT, permitNonceCall(owner, lane)));

/**
 * A permit whose answer never came may still execute: check the lane first.
 * Its nonce was used -> it went through (the user is told, nothing new is
 * signed). Not used -> the lane's nonce IS the remembered one, so the new
 * permit takes the same nonce and at most one of the two can ever execute.
 */
async function settleUnclear(kind: PermitKind, owner: string): Promise<bigint> {
  const lane = kind === 'deposit' ? DEPOSIT_NONCE_KEY : WITHDRAW_NONCE_KEY;
  const pending = loadPending(kind, owner);
  const onchain = await relayNonce(owner, lane);
  if (pending && onchain > BigInt(pending.nonce)) {
    clearPending(kind, owner);
    throw new WalletError(
      kind === 'deposit'
        ? `Your previous deposit of ${pending.amount} ${pending.coin} went through. Check your Spot balance before depositing again.`
        : `Your previous withdrawal of ${pending.amount} ${pending.coin} to ${chainLabel(pending.chain)} went through. Check your balances before sending another.`,
    );
  }
  return onchain;
}

/**
 * Whether the permit of this kind the app still remembers (an answer without a
 * transaction, or a receipt it did not see in time) has executed on-chain: its
 * nonce is used. null: none is remembered.
 */
export async function permitExecuted(kind: PermitKind, owner: string): Promise<boolean | null> {
  const pending = loadPending(kind, owner.toLowerCase());
  if (!pending) return null;
  const lane = kind === 'deposit' ? DEPOSIT_NONCE_KEY : WITHDRAW_NONCE_KEY;
  return (await relayNonce(owner.toLowerCase(), lane)) > BigInt(pending.nonce);
}

/**
 * The caller has followed a remembered permit to its end (its withdrawal record
 * is final, the coins arrived, Spot was credited): forget it, so the next permit
 * is not stopped to say "your previous one went through". Only once the chain
 * shows its nonce used - an unexecuted permit stays guarded. Returns whether it
 * was forgotten.
 */
export async function forgetSettledPermit(kind: PermitKind, owner: string): Promise<boolean> {
  if ((await permitExecuted(kind, owner)) !== true) return false;
  clearPending(kind, owner.toLowerCase());
  return true;
}

/**
 * Send a signed call-for-permit request the way sodex.com does, safer: run it
 * on-chain first (a request the contract refuses is never sent), remember it
 * before it leaves, relay it, and wait for its transaction. Returns the
 * receipt, or null when SoDEX accepted it but the transaction is not final yet
 * (the request stays remembered: the next permit checks the nonce first).
 */
async function relay(
  kind: PermitKind,
  req: CallForPermitRequest,
  memo: Omit<PendingPermit, 'nonce' | 'deadline'>,
): Promise<{ txHash: string | null; receipt: Awaited<ReturnType<typeof waitForReceipt>> }> {
  await simulateCallForPermit(req);
  savePending(kind, { ...memo, nonce: req.nonce, deadline: Number(req.deadline) });
  let txHash: string | null;
  try {
    txHash = await submitCallForPermit(req);
  } catch (e) {
    if (e instanceof OutcomeUnknownError) throw e;
    clearPending(kind, memo.owner); // a definite "no": the permit was not used
    throw e;
  }
  if (!txHash) return { txHash: null, receipt: null };
  const receipt = await waitForReceipt(txHash, 120_000);
  if (receipt) clearPending(kind, memo.owner); // final either way: the nonce is settled
  return { txHash, receipt };
}

/**
 * Funding -> Spot: the wallet's own ValueChain `coin` into SoDEX Spot, exactly
 * as sodex.com does it:
 *   ERC-20       TWO signatures and no gas - the token's ERC-2612 permit (to
 *                SoDEX's CallForPermit contract), then a CallForPermit wrapping
 *                DepositERC20WithPermit; relayed by SoDEX (call_for_permit).
 *   native SOSO  ONE wallet transaction, `depositERC20(address(0), amount)` sent
 *                to the exchange gateway with the amount as value; the wallet
 *                keeps 0.001 SOSO for its gas.
 * The first deposit opens the SoDEX account.
 */
export async function depositFromWallet(o: {
  provider: Eip1193Provider;
  owner: string;
  coin: CoinConfig;
  amount: string;
  onStep?: StepSink;
}): Promise<{ hash: string }> {
  const { coin } = o;
  const owner = o.owner.toLowerCase();
  const dp = coin.valuechain.decimals;
  const units = parseUnits(o.amount, dp); // refuses more precision than the token has
  if (units <= 0n) throw new RangeError('Enter an amount.');
  const native = coin.valuechain.native;
  // Before the balance, chain and nonce reads. The button would otherwise sit
  // on "Confirming…" until the first real prompt (openingStep.ts).
  o.onStep?.(openingWalletStep(native));
  const have = await walletUnits(owner, coin);
  if (units + (native ? GAS_RESERVE_WEI : 0n) > have) {
    const free = native ? (have > GAS_RESERVE_WEI ? have - GAS_RESERVE_WEI : 0n) : have;
    throw new RangeError(`Your wallet can move ${formatUnits(free, dp)} ${coin.coin}${native ? ' (0.001 stays for gas)' : ''}.`);
  }
  const chain = await valueChain();
  const switching = await needsSwitch(o.provider, chain);

  if (native) {
    const ask = promptCounter(o.onStep, switching ? 2 : 1);
    if (switching) ask('approve');
    await onValueChain(o.provider, chain);
    ask('confirm');
    const hash = await sendTransaction(o.provider, { from: owner, to: CLOB_GATEWAY, data: nativeDepositCallData(units), value: `0x${units.toString(16)}`, chainId: chain.chainId });
    o.onStep?.(WORKING);
    const receipt = await waitForReceipt(hash, 180_000);
    if (!receipt) throw new WalletError(`The deposit was sent (${hash}) but is not confirmed yet. Check your Spot balance before depositing again.`);
    if (receipt.status !== 'success') throw new WalletError(`The deposit ${hash} reverted on ValueChain - nothing was deposited.`);
    log.info('native deposit confirmed', { coin: coin.coin, amount: o.amount, hash });
    return { hash };
  }

  const token = coin.valuechain.token;
  const nonce = await settleUnclear('deposit', owner);
  // The token's EIP-712 name is read from the token, never assumed.
  const [nameHex, tokenNonceHex] = await Promise.all([valueChainCall(token, nameCallData()), valueChainCall(token, tokenNoncesCallData(owner))]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // one deadline for both signatures
  const signer = toChecksumAddress(owner);
  const permit = prepareTokenPermit({ owner: signer, token, tokenName: decodeString(nameHex), amount: units, nonce: decodeUint(tokenNonceHex), deadline, chainId: chain.chainId });
  const ask = promptCounter(o.onStep, (switching ? 1 : 0) + 2);
  if (switching) ask('approve');
  await onValueChain(o.provider, chain);
  ask('approve');
  const permitSignature = await signTypedData(o.provider, signer, permit.typedData);
  const prepared = prepareDepositPermit({ owner: signer, token, amount: units, deadline, tokenPermit: { digest: permit.digest, signature: permitSignature }, nonce, chainId: chain.chainId });
  ask('confirm');
  const req = assembleCallForPermit(prepared, await signTypedData(o.provider, signer, prepared.typedData));
  o.onStep?.(WORKING);
  let sent: Awaited<ReturnType<typeof relay>>;
  try {
    sent = await relay('deposit', req, { owner, amount: o.amount, coin: coin.coin, chain: 'VALUECHAIN', receiver: owner });
  } catch (e) {
    if (e instanceof OutcomeUnknownError) {
      throw new WalletError('SoDEX did not confirm the deposit. It may still land in Spot - your next deposit checks first and cannot send this one twice.');
    }
    throw new WalletError(e instanceof RelayRefused ? `${e.message} Nothing left your wallet.` : e instanceof Error ? e.message : String(e));
  }
  if (!sent.txHash) {
    // Accepted without a transaction hash: watch the wallet instead.
    if (await waitFor(async () => (await walletUnits(owner, coin)) + units <= have, 120_000)) {
      clearPending('deposit', owner);
      log.info('gasless deposit landed', { coin: coin.coin, amount: o.amount });
      return { hash: '' };
    }
    throw new WalletError('SoDEX accepted the deposit, but it has not landed yet. Check your Spot balance in a minute - your next deposit checks first and cannot send this one twice.');
  }
  if (!sent.receipt) throw new WalletError(`SoDEX sent the deposit (${sent.txHash}) but it is not final yet. Check your Spot balance in a minute before depositing again.`);
  if (sent.receipt.status !== 'success') throw new WalletError(`The deposit ${sent.txHash} reverted on ValueChain - nothing left your wallet.`);
  log.info('gasless deposit confirmed', { coin: coin.coin, amount: o.amount, hash: sent.txHash });
  return { hash: sent.txHash };
}

// --- send from the wallet on ValueChain ---------------------------------------------------

/**
 * Send `units` of `coin` from the owner's ValueChain wallet to `to`: an ERC-20
 * `transfer` (SOSO, the gas coin: a plain value transfer). One wallet
 * transaction on ValueChain, waited for until it is final.
 */
export async function sendOnValueChain(o: {
  provider: Eip1193Provider;
  owner: string;
  coin: CoinConfig;
  to: string;
  units: bigint;
  onStep?: StepSink;
}): Promise<string> {
  const bad = receiverProblem('VALUECHAIN', o.to);
  if (bad) throw new RangeError(bad);
  if (o.units <= 0n) throw new RangeError('Enter an amount.');
  const chain = await valueChain();
  const switching = await needsSwitch(o.provider, chain);
  const ask = promptCounter(o.onStep, switching ? 2 : 1);
  if (switching) ask('approve');
  await onValueChain(o.provider, chain);
  ask('confirm');
  const hash = await sendTransaction(
    o.provider,
    o.coin.valuechain.native
      ? { from: o.owner, to: o.to, data: '0x', value: `0x${o.units.toString(16)}`, chainId: chain.chainId }
      : { from: o.owner, to: o.coin.valuechain.token, data: erc20TransferData(o.to, o.units), value: '0x0', chainId: chain.chainId },
  );
  o.onStep?.(WORKING);
  const receipt = await waitForReceipt(hash, 180_000);
  if (!receipt) throw new WalletError(`The transfer was sent (${hash}) but is not confirmed yet. Check it on the ValueChain explorer before sending again.`);
  if (receipt.status !== 'success') throw new WalletError(`The transfer ${hash} reverted on ValueChain - nothing was sent.`);
  return hash;
}

// --- withdraw ----------------------------------------------------------------------------


async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (const wait of [700, 1000, 1500, 2000, 2500, 3000]) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, wait));
  }
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return check();
}

/** Plan which balances pay for `amount` (ValueChain wallet first, then Spot, then Perps), in base units. */
export function planWithdraw(
  amount: bigint,
  to: 'VALUECHAIN' | 'EXTERNAL',
  sources: { spot: boolean; perps: boolean; evm: boolean },
  b: { spot: bigint; perps: bigint; evm: bigint },
): { fromEvm: bigint; fromSpot: bigint; fromPerps: bigint } | { problem: string } {
  const min = (x: bigint, y: bigint) => (x < y ? x : y);
  let left = amount;
  const fromEvm = to === 'EXTERNAL' && sources.evm ? min(left, b.evm) : 0n;
  left -= fromEvm;
  const fromSpot = sources.spot ? min(left, b.spot) : 0n;
  left -= fromSpot;
  const fromPerps = sources.perps ? min(left, b.perps) : 0n;
  left -= fromPerps;
  if (left > 0n) return { problem: 'Not enough in the selected balances.' };
  return { fromEvm, fromSpot, fromPerps };
}

// --- a permit whose answer was unclear ------------------------------------------------------

export type PermitKind = 'withdraw' | 'deposit';

interface PendingPermit {
  owner: string;
  /** The request's nonce (key-packed, decimal). */
  nonce: string;
  /** Unix seconds. */
  deadline: number;
  amount: string;
  coin: string;
  chain: string;
  receiver: string;
}

const PENDING_KEY: Record<PermitKind, string> = { withdraw: 'vs-withdraw-pending:', deposit: 'vs-deposit-pending:' };
const pendingMemory = new Map<string, PendingPermit>();

function loadPending(kind: PermitKind, owner: string): PendingPermit | null {
  const key = PENDING_KEY[kind] + owner;
  let p = pendingMemory.get(key) ?? null;
  if (!p) {
    try {
      const raw = globalThis.sessionStorage?.getItem(key);
      p = raw ? (JSON.parse(raw) as PendingPermit) : null;
    } catch {
      p = null;
    }
  }
  if (p && p.deadline * 1000 < Date.now()) {
    clearPending(kind, owner); // expired: it can no longer execute
    return null;
  }
  return p;
}

function savePending(kind: PermitKind, p: PendingPermit): void {
  const key = PENDING_KEY[kind] + p.owner;
  pendingMemory.set(key, p);
  try {
    globalThis.sessionStorage?.setItem(key, JSON.stringify(p));
  } catch {
    /* memory only */
  }
}

function clearPending(kind: PermitKind, owner: string): void {
  const key = PENDING_KEY[kind] + owner;
  pendingMemory.delete(key);
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}

// --- the on-chain quote for a withdrawal to another chain ---------------------------------------

export interface WithdrawQuote {
  /** SoDEX's fee in base units of the coin (taken out of the amount). */
  fee: bigint;
  /** What SoDEX's custodian (or bridge) holds on that chain right now, in base units. */
  available: bigint;
}

/**
 * The fee and liquidity for `coin` to `route`, from SoDEX's registry on
 * ValueChain - where sodex.com reads its fee. Cached briefly per coin/chain.
 */
const quoteCache = new Map<string, { at: number; value: Promise<WithdrawQuote> }>();
export function withdrawQuote(coin: CoinConfig, route: ChainRoute, owner: string): Promise<WithdrawQuote> {
  const key = `${coin.coin}|${route.key}|${route.withdrawType}`;
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const value = withdrawRequirements(coin.coin, route.key, owner, route.withdrawType);
  quoteCache.set(key, { at: Date.now(), value });
  value.catch(() => quoteCache.delete(key));
  return value;
}

/**
 * Withdraw.
 *   - 'VALUECHAIN' to the owner's own wallet: engine transfers only (trading key).
 *   - 'VALUECHAIN' to anyone else: the engines pay the owner's wallet first, then
 *     the wallet sends one ordinary token transfer (SOSO: a plain value
 *     transfer) - the wallet's own ValueChain funds ("EVM") can pay too.
 *   - any other route: `receiver` on that chain through SoDEX's WithdrawToken
 *     permit, relayed by SoDEX (sodex.com's call_for_permit).
 * Returns what to track: nothing for the own wallet, the ValueChain transfer's
 * hash, or for another chain the relayed transaction and the withdrawal's id
 * in SoDEX's Withdrawer (withdrawalProgress follows it to the end).
 */
export async function withdrawFunds(o: {
  owner: string;
  provider: Eip1193Provider | null;
  coin: CoinConfig;
  route: ChainRoute | 'VALUECHAIN';
  receiver: string;
  amount: string;
  sources: { spot: boolean; perps: boolean; evm: boolean };
  /** XRP / Stellar: the numeric memo ('' = the address takes none). */
  memo?: string;
  /**
   * The fee the user was shown, in base units: the withdrawal stops, before
   * anything moves, if SoDEX's on-chain fee is not exactly this.
   */
  expectedFee?: bigint;
  onStep?: StepSink;
}): Promise<{ route: 'VALUECHAIN'; txHash?: string } | { route: string; txHash: string; withdrawId: string | null }> {
  const { coin } = o;
  const owner = o.owner.toLowerCase();
  const dp = coin.valuechain.decimals;
  const units = parseUnits(o.amount, dp); // refuses more precision than the token has
  if (units <= 0n) throw new RangeError('Enter an amount.');
  const external = o.route !== 'VALUECHAIN';
  /** ValueChain, but not to the owner's own wallet: the wallet sends it on. */
  const toOther = !external && o.receiver.trim().toLowerCase() !== owner;
  const fmt = (u: bigint) => formatUnits(u, dp);
  let chain: DepositChain | null = null;
  let ask: ((wallet: 'approve' | 'confirm') => void) | null = null;
  /** ValueChain in the wallet, counted as a prompt only when the wallet actually asks. */
  const toValueChain = async (provider: Eip1193Provider, c: DepositChain) => {
    if (await needsSwitch(provider, c)) ask?.('approve');
    await onValueChain(provider, c);
    o.onStep?.(WORKING);
  };
  if (toOther) {
    const bad = receiverProblem('VALUECHAIN', o.receiver);
    if (bad) throw new RangeError(bad);
    if (!o.provider) throw new WalletError('Reconnect your wallet: sending to another address is a wallet transaction.');
  }

  // As sodex.com sends them: a memo rides in BOTH the receiver ("address:memo")
  // and the memo field; the bridged coins go through the bridge (type 1).
  const route = external ? (o.route as ChainRoute) : null;
  const address = o.receiver.trim();
  const memo = route?.memo === 'numeric' ? (o.memo ?? '').trim() : '';
  const receiver = route?.addressKind === 'evm' ? toChecksumAddress(address) : memo ? `${address}:${memo}` : address;
  if (route) {
    if (!route.withdraw.allowed) throw new RangeError(`${route.label} withdrawals are closed right now.`);
    if (route.withdraw.min && units < unitsDown(route.withdraw.min, dp)) throw new RangeError(`The minimum on ${route.label} is ${route.withdraw.min} ${coin.coin}.`);
    const bad = receiverProblem(route, address) ?? memoProblem(route, o.memo ?? '', !o.memo?.trim());
    if (bad) throw new RangeError(bad);
    if (!o.provider) throw new WalletError('Reconnect your wallet: a withdrawal to another chain needs one signature.');
  }
  if (toOther) {
    // Never to the owner's own SoDEX deposit address (the registry says so; an unanswered read leaves it to the sheet).
    const reg = await receiverAccount(owner, coin, 'VALUECHAIN', address).catch(() => null);
    const arrival = arrivalCheck({ owner, coin, route: 'VALUECHAIN', receiver: address, amount: units, fee: 0n, registry: reg });
    if (arrival.verdict === 'refuse') throw new RangeError(arrival.text);
  }

  const bal = await balancesOf(owner, coin);
  const b = { spot: unitsDown(bal.spot, dp), perps: unitsDown(bal.perps, dp), evm: unitsDown(bal.evm, dp) };
  // Anywhere but the own wallet, the wallet's own funds can pay as well.
  const plan = planWithdraw(units, external || toOther ? 'EXTERNAL' : 'VALUECHAIN', o.sources, b);
  if ('problem' in plan) throw new RangeError(plan.problem);
  if (coin.assetId === null && plan.fromSpot + plan.fromPerps > 0n) throw new RangeError(`${coin.coin} cannot move out of the trading engines here.`);

  if (route && o.provider) {
    // Everything SoDEX would refuse, refused BEFORE anything moves:
    // its maintenance switch (sodex.com disables the route the same way),
    const m = await maintenanceFor(coin.coin, owner);
    const down = maintenanceNote(m, route.key, 'withdraw');
    if (down?.severity === 'unavailable') throw new RangeError(`${coin.coin} withdrawals to ${route.label} are paused by SoDEX: ${down.message}`);
    // a permit from before whose answer never came,
    await settleUnclear('withdraw', owner);
    // the address risk check sodex.com runs for every custody withdrawal,
    if (route.withdrawType === 0) await analyseAddress(address);
    // and the chain's own rules: the fee must be the one shown, the amount above
    // it, SoDEX's reserve on that chain able to pay, the receiver not blacklisted;
    // and what arrives creditable when the receiver is a SoDEX deposit address
    // (an unanswered registry read leaves that to the sheet's confirmation).
    const [quote, blacklisted, reg] = await Promise.all([
      withdrawRequirements(coin.coin, route.key, owner, route.withdrawType),
      receiverBlacklisted(route.key, receiver),
      receiverAccount(owner, coin, route, address).catch(() => null),
    ]);
    if (o.expectedFee !== undefined && quote.fee !== o.expectedFee) {
      throw new RangeError(`SoDEX's ${route.label} fee is now ${fmt(quote.fee)} ${coin.coin} - check the amount you receive and try again.`);
    }
    if (units <= quote.fee) throw new RangeError(`The amount must be more than the ${fmt(quote.fee)} ${coin.coin} fee.`);
    if (units > quote.available) {
      throw new RangeError(`SoDEX can pay out ${fmt(quote.available)} ${coin.coin} on ${route.label} right now - withdraw less, or try again later.`);
    }
    if (blacklisted) throw new RangeError(`SoDEX does not pay out to this address on ${route.label}.`);
    const arrival = arrivalCheck({ owner, coin, route, receiver: address, amount: units, fee: quote.fee, registry: reg });
    if (arrival.verdict === 'refuse') throw new RangeError(arrival.text);
    chain = await valueChain();
    ask = promptCounter(o.onStep, (await needsSwitch(o.provider, chain)) ? 2 : 1);
  }
  const trading = await import('./actions');

  // 1. Engines -> ValueChain wallet (signed by the trading key, no prompt).
  const fromEngines = plan.fromSpot + plan.fromPerps;
  if (fromEngines > 0n) {
    if (plan.fromPerps > 0n) {
      await trading.transferCross('perps-to-spot', coin.assetId!, fmt(plan.fromPerps));
      const want = b.spot + plan.fromPerps;
      if (!(await waitFor(async () => unitsDown((await balancesOf(owner, coin)).spot, dp) >= want, 30_000))) {
        throw new WalletError(`Moved ${fmt(plan.fromPerps)} ${coin.coin} to Spot, but SoDEX has not credited it yet. Your funds are safe in Spot - try again in a moment.`);
      }
    }
    await trading.withdraw({ engine: 'spot', coinId: coin.assetId!, amount: fmt(fromEngines) });
    if (!external && !toOther) {
      log.info('withdrawn to own ValueChain wallet', { coin: coin.coin, amount: o.amount });
      return { route: 'VALUECHAIN' };
    }
    const want = b.evm + fromEngines;
    if (!(await waitFor(async () => unitsDown((await balancesOf(owner, coin)).evm, dp) >= want, 90_000))) {
      throw new WalletError(`Your ${coin.coin} left Spot but has not arrived in your ValueChain wallet yet. It is safe - withdraw from "EVM" in a minute.`);
    }
  } else if (!external && !toOther) {
    throw new RangeError('Choose Spot as the source - EVM is already this wallet.');
  }
  /** Where the funds are if the last step stops: said in every error after the move. */
  const parked = fromEngines > 0n ? ` The ${fmt(fromEngines)} ${coin.coin} moved out of Spot is safe in your ValueChain wallet (EVM).` : '';

  // 2a. ValueChain wallet -> another ValueChain address: one wallet transfer.
  if (toOther) {
    const txHash = await sendOnValueChain({ provider: o.provider!, owner, coin, to: address, units, onStep: o.onStep });
    log.info('sent on ValueChain', { coin: coin.coin, amount: o.amount, txHash });
    return { route: 'VALUECHAIN', txHash };
  }

  // 2b. ValueChain wallet -> destination chain: one permit, SoDEX relays it and pays the gas.
  const r = route!;
  const provider = o.provider!;
  chain ??= await valueChain();
  await toValueChain(provider, chain);
  let nonce: bigint;
  try {
    nonce = await settleUnclear('withdraw', owner); // an earlier permit may have executed meanwhile
  } catch (e) {
    throw new WalletError(`${e instanceof Error ? e.message : String(e)}${parked}`);
  }
  const prepared = prepareWithdrawPermit({
    owner: toChecksumAddress(owner),
    coinSymbol: coin.coin,
    chain: r.key,
    receiver,
    amount: units,
    withdrawType: r.withdrawType,
    memo,
    // A withdrawal that fails returns to Spot when Spot paid for it (sodex.com:
    // source === Spot); from the wallet alone it returns to the wallet.
    failedBackToClob: fromEngines > 0n,
    nonce,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    chainId: chain.chainId,
  });
  ask?.('confirm');
  const signature = await signTypedData(provider, toChecksumAddress(owner), prepared.typedData);
  o.onStep?.(WORKING);
  const req = assembleCallForPermit(withdrawAsCallForPermit(prepared), signature);
  let sent: Awaited<ReturnType<typeof relay>>;
  try {
    sent = await relay('withdraw', req, { owner, amount: o.amount, coin: coin.coin, chain: r.key, receiver });
  } catch (e) {
    if (e instanceof OutcomeUnknownError) {
      throw new WalletError(`SoDEX did not confirm the withdrawal. It may still go through - your next try checks first and cannot send it twice.${parked}`);
    }
    throw new WalletError(`${e instanceof Error ? e.message : String(e)} Nothing was sent.${parked}`);
  }
  if (!sent.txHash) {
    log.info('withdrawal accepted without a transaction hash', { coin: coin.coin, chain: r.key, amount: o.amount });
    return { route: r.key, txHash: '', withdrawId: null };
  }
  if (sent.receipt?.status === 'reverted') throw new WalletError(`SoDEX's transaction ${sent.txHash} reverted - nothing left your wallet.${parked}`);
  const w = sent.receipt ? withdrawalFromReceipt(sent.receipt) : null;
  if (w && (w.account.toLowerCase() !== owner || w.chain !== r.key || w.coinSymbol !== coin.coin || w.amount > units)) {
    log.error('withdrawal record does not match the request', { expected: { owner, chain: r.key, coin: coin.coin, units: units.toString() }, got: { ...w, withdrawId: w.withdrawId.toString(), amount: w.amount.toString() } });
  }
  log.info('withdrawal to another chain created', { coin: coin.coin, chain: r.key, amount: o.amount, txHash: sent.txHash, withdrawId: w?.withdrawId.toString() });
  return { route: r.key, txHash: sent.txHash, withdrawId: w ? w.withdrawId.toString() : null };
}

export interface WithdrawalProgress {
  /** Human status: Requested, Sending, Completed, Failed/Rejected - returned to your account. */
  status: string;
  done: boolean;
  ok: boolean;
  /** The withdrawal's id in SoDEX's Withdrawer, once known. */
  withdrawId: string | null;
  /** The payout transaction on the destination chain, once SoDEX has sent it. */
  destinationTx: string | null;
  /** What SoDEX took as its fee, in the coin's decimals. */
  fee: bigint | null;
}

/**
 * Where a withdrawal to another chain is - read from SoDEX's own Withdrawer on
 * ValueChain (the record the relayed transaction created), not from a status
 * API. With only the relayed transaction's hash, its receipt names the id.
 */
export async function withdrawalProgress(ref: { withdrawId?: string | null; txHash?: string | null }): Promise<WithdrawalProgress | null> {
  let id = ref.withdrawId ? BigInt(ref.withdrawId) : null;
  if (id === null && ref.txHash) {
    const receipt = await waitForReceipt(ref.txHash, 0);
    if (receipt?.status === 'reverted') return { status: 'Reverted - nothing left your wallet', done: true, ok: false, withdrawId: null, destinationTx: null, fee: null };
    id = receipt ? withdrawalFromReceipt(receipt)?.withdrawId ?? null : null;
  }
  if (id === null) return null;
  const w = await withdrawalRecord(id);
  if (!w) return null;
  return {
    status: WITHDRAWAL_STATUS_LABEL[w.status] ?? `Status ${w.status}`,
    done: withdrawalDone(w),
    ok: w.status === WithdrawalState.SUCCESS,
    withdrawId: w.withdrawId.toString(),
    destinationTx: w.txHash || null,
    fee: w.withdrawFee,
  };
}

// --- transfer between the owner's own accounts ---------------------------------------------

/**
 * The owner's three places for funds - sodex.com's own transfer model, where
 * "Funding" is the ValueChain wallet (here: EVM, as on the Withdraw sheet and the address menu).
 */
export type FundsAccount = 'spot' | 'perps' | 'evm';

export const ACCOUNT_LABEL: Record<FundsAccount, string> = { spot: 'Spot', perps: 'Futures', evm: 'EVM' };

/** Perps takes USDC and the coins it counts as collateral (a margin ratio above 0). */
export const perpsCollateral = (coin: CoinConfig): boolean => coin.coin.toUpperCase() === 'USDC' || (coin.marginRatio ?? 0) > 0;

/** A chain SoDEX will currently accept a deposit on. */
export const canDepositCoin = (coin: CoinConfig): boolean => coin.chains.some((c) => c.deposit.allowed);
/** A chain SoDEX will currently pay a withdrawal out on. */
export const canWithdrawCoin = (coin: CoinConfig): boolean => coin.chains.some((c) => c.withdraw.allowed);

/** Why `coin` cannot move from `from` to `to`, or null. */
export function transferProblem(coin: CoinConfig, from: FundsAccount, to: FundsAccount): string | null {
  if (from === to) return 'Pick two different accounts.';
  if (coin.assetId === null) return `${coin.coin} is not held on SoDEX.`;
  if ((from === 'perps' || to === 'perps') && !perpsCollateral(coin)) return `Futures does not take ${coin.coin} as collateral - only USDC and collateral coins.`;
  return null;
}

/**
 * Who signs. Anything leaving Spot or Perps, and the Spot -> Perps leg of a
 * wallet -> Perps move, is signed in this browser by the trading key; anything
 * leaving the ValueChain wallet is a wallet transaction.
 */
export const transferNeedsKey = (from: FundsAccount, to: FundsAccount): boolean => from !== 'evm' || to === 'perps';
export const transferNeedsWallet = (from: FundsAccount): boolean => from === 'evm';

/**
 * Move `amount` of `coin` between the owner's own accounts:
 *   Spot <-> Perps            one engine transfer (trading key)
 *   Spot / Perps -> wallet    EVM_WITHDRAW to the owner's own ValueChain address
 *                             (Perps goes through Spot first - withdrawFunds)
 *   wallet -> Spot            a ValueChain deposit the wallet sends
 *   wallet -> Perps           the deposit, then Spot -> Perps once SoDEX credits it
 * Checks the source can cover it first, in exact base units. Nothing leaves the
 * owner's accounts: every destination is the owner's own.
 */
export async function transferFunds(o: {
  owner: string;
  provider: Eip1193Provider | null;
  coin: CoinConfig;
  from: FundsAccount;
  to: FundsAccount;
  amount: string;
  onStep?: StepSink;
}): Promise<void> {
  const { coin, from, to } = o;
  const owner = o.owner.toLowerCase();
  const dp = coin.valuechain.decimals;
  const units = parseUnits(o.amount, dp);
  if (units <= 0n) throw new RangeError('Enter an amount.');
  const bad = transferProblem(coin, from, to);
  if (bad) throw new RangeError(bad);
  if (transferNeedsWallet(from) && !o.provider) throw new WalletError('Reconnect your wallet - moving funds out of it needs your wallet.');
  // Spot ↔ Futures has no wallet prompt. Out of the wallet: the first numbered
  // step now, before the balance read, not after it.
  if (from === 'evm') o.onStep?.(openingWalletStep(coin.valuechain.native));

  const bal = await balancesOf(owner, coin);
  const have = unitsDown(bal[from], dp);
  if (units > have) throw new RangeError(`${ACCOUNT_LABEL[from]} has ${formatUnits(have, dp)} ${coin.coin} that can move.`);
  const amount = formatUnits(units, dp); // canonical: SoDEX refuses trailing zeros
  const trading = await import('./actions');
  const spotToPerps = async () => {
    await trading.transferCross('spot-to-perps', coin.assetId!, amount);
  };

  if (from === 'spot' && to === 'perps') return spotToPerps();
  if (from === 'perps' && to === 'spot') {
    await trading.transferCross('perps-to-spot', coin.assetId!, amount);
    return;
  }
  if (to === 'evm') {
    await withdrawFunds({ owner, provider: o.provider, coin, route: 'VALUECHAIN', receiver: owner, amount, sources: { spot: from === 'spot', perps: from === 'perps', evm: false }, onStep: o.onStep });
    return;
  }

  // Out of the ValueChain wallet: a deposit into Spot.
  const spotBefore = unitsDown(bal.spot, dp);
  await depositFromWallet({ provider: o.provider!, owner, coin, amount, onStep: o.onStep });
  if (to === 'spot') return;
  if (!(await waitFor(async () => unitsDown((await balancesOf(owner, coin)).spot, dp) >= spotBefore + units, 90_000))) {
    throw new WalletError(`Your deposit went through, but SoDEX has not credited Spot yet. The ${coin.coin} is safe - move it from Spot to Futures in a minute.`);
  }
  await spotToPerps();
}

/** For tests. */
export const _clearPendingWithdrawals = (): void => {
  for (const k of [...pendingMemory.keys()]) {
    const kind = (Object.keys(PENDING_KEY) as PermitKind[]).find((x) => k.startsWith(PENDING_KEY[x]))!;
    clearPending(kind, k.slice(PENDING_KEY[kind].length));
  }
  quoteCache.clear();
  _clearReceiverCache();
};

export type { Engine };
