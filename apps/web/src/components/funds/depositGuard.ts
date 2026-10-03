/**
 * The receiving end of a withdrawal: is it a SoDEX deposit address, and is
 * what ARRIVES enough for it to be credited?
 *
 * WHY. A withdrawal to another chain loses SoDEX's fee on the way (Base USDC:
 * 1 USDC). 5 USDC meets the 5 USDC withdrawal minimum, but only 4 arrives - and
 * when the receiver is the deposit address of a SoDEX account (or of any
 * exchange), 4 is below SoDEX's 5 USDC DEPOSIT minimum and is never credited.
 * That happened to the owner (2026-10).
 *
 * HOW A SODEX DEPOSIT ADDRESS IS RECOGNISED. SoDEX's custody contract on
 * ValueChain (SoDexTokenCustody behind MIRROR_REGISTRY, verified source) keeps
 * a PUBLIC reverse map of every deposit address it has issued:
 * `depositAccounts(string chain, string depositWallet) -> address account`.
 * The key is the exact string - EVM addresses are stored EIP-55 checksummed, a
 * lower-case query answers zero (read live 2026-10-03) - and an address replaced
 * later stays mapped. Its `deposit()` credits one external transfer only when
 * THAT transfer reaches the route's minDepositAmount; below it the credit
 * reverts ("deposit amount is less than min deposit amount"). Nothing adds
 * small transfers up. The deposit addresses themselves are plain accounts on
 * Base (no code), so nothing on Base tells them apart - only this map does.
 * One `view` call on ValueChain's RPC, already in the CSP.
 *
 * Other exchanges' deposit addresses cannot be recognised: below the minimum,
 * any address SoDEX does not know needs the user's word that it is a wallet.
 */
import { DEPOSIT_WALLET_REGISTRY, decodeDepositWalletList, encodeDepositWalletList } from '@sign/sodex/depositWalletsCore.js';
import { MIRROR_REGISTRY } from '@sign/sodex/mirrorCore.js';
import { toChecksumAddress } from '../../trading/addresses';
import { formatUnits } from '../../trading/onboard';
import { valueChainCall } from '../../trading/relay';
import type { ChainRoute, CoinConfig } from '../../trading/funds';

const DEPOSIT_ACCOUNTS_SELECTOR = '0x6f394ccb'; // depositAccounts(string,string)

const abiWord = (n: number): string => n.toString(16).padStart(64, '0');
const abiString = (s: string): string => {
  const hex = Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
  return abiWord(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
};

/** The call data for depositAccounts(chain, depositWallet). */
export function depositAccountsCallData(chain: string, wallet: string): string {
  const first = abiString(chain);
  return DEPOSIT_ACCOUNTS_SELECTOR + abiWord(64) + abiWord(64 + first.length / 2) + first + abiString(wallet);
}

/** The account a depositAccounts answer names (lower case), or null for none. */
function decodeAccount(hex: string): string | null {
  const body = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}/.test(body)) throw new RangeError('ValueChain answered the deposit-address lookup with no address');
  const a = body.slice(24, 64).toLowerCase();
  return /^0+$/.test(a) ? null : `0x${a}`;
}

/** "5" -> base units at `dp`, truncated; anything else -> 0. */
function units(v: string | null, dp: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v ?? '').trim());
  return m ? BigInt(m[1]!) * 10n ** BigInt(dp) + BigInt(((m[2] ?? '') + '0'.repeat(dp)).slice(0, dp) || '0') : 0n;
}

/** What SoDEX's registry says about a withdrawal's receiver. */
export interface ReceiverAccount {
  /** The SoDEX account this is a deposit address of on the route's chain (lower case); null: none. Always null on ValueChain. */
  depositOf: string | null;
  /** One of the owner's own SoDEX deposit addresses (any chain, any it was ever issued). */
  own: boolean;
}

const RECEIVER_TTL_MS = 60_000;
const receiverCache = new Map<string, { at: number; value: Promise<ReceiverAccount> }>();

/** For tests. */
export const _clearReceiverCache = (): void => receiverCache.clear();

/**
 * Is `receiver` a SoDEX deposit address - the owner's own, or any account's on
 * the route's chain? Read-only `view` calls on ValueChain: the custody
 * contract's reverse map for the route's chain, and the owner's own list for
 * this coin (registry getDepositWalletList, what the Deposit sheet shows).
 * Rejects when ValueChain cannot answer - the caller then knows nothing either
 * way. Cached a minute.
 */
export function receiverAccount(owner: string, coin: CoinConfig, route: ChainRoute | 'VALUECHAIN', receiver: string): Promise<ReceiverAccount> {
  const me = owner.toLowerCase();
  const addr = receiver.trim();
  const chainKey = route === 'VALUECHAIN' ? null : route.key;
  const key = `${me}|${coin.coin}|${chainKey ?? 'VALUECHAIN'}|${addr}`;
  const hit = receiverCache.get(key);
  if (hit && Date.now() - hit.at < RECEIVER_TTL_MS) return hit.value;
  const evm = route === 'VALUECHAIN' || route.addressKind === 'evm';
  const same = (a: string) => (evm ? a.trim().toLowerCase() === addr.toLowerCase() : a.trim() === addr);
  const value = (async (): Promise<ReceiverAccount> => {
    const ownList = valueChainCall(DEPOSIT_WALLET_REGISTRY, encodeDepositWalletList(me, coin.coin)).then((hex) => decodeDepositWalletList(hex).wallets.some((l) => l.some(same)));
    if (chainKey === null) return { depositOf: null, own: await ownList };
    // As typed, and the forms SoDEX may have stored it in (EIP-55 is what it stores).
    const forms = evm ? [...new Set([addr, toChecksumAddress(addr), addr.toLowerCase()])] : [addr];
    const [accounts, listed] = await Promise.all([
      Promise.all(forms.map(async (f) => decodeAccount(await valueChainCall(MIRROR_REGISTRY, depositAccountsCallData(chainKey, f))))),
      // The reverse map already names the owner on this chain; the list adds the owner's other chains.
      ownList.catch(() => false),
    ]);
    const depositOf = accounts.find((a) => a !== null) ?? null;
    return { depositOf, own: depositOf === me || listed };
  })();
  receiverCache.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (receiverCache.get(key)?.value === value) receiverCache.delete(key);
  });
  return value;
}

/**
 * Whether what ARRIVES can be credited, for a receiver that is not the owner's
 * own wallet:
 *   refuse   the owner's own SoDEX deposit address (any route, any amount);
 *            a SoDEX deposit address (the registry says so) that would get
 *            less than SoDEX's deposit minimum, or on a route SoDEX takes no
 *            deposits on - it would never be credited;
 *   confirm  any other address that would get less than SoDEX's deposit
 *            minimum: a plain wallet takes any amount, but a deposit address
 *            of a SoDEX account or of an exchange does not credit it - the
 *            user says it is a wallet before signing;
 *   ok       otherwise (also while nothing is entered).
 * `registry` is null while it is read or when it could not be: then only the
 * confirmation guards it.
 */
export type ArrivalCheck =
  | { verdict: 'ok' }
  | { verdict: 'refuse'; reason: 'own' | 'sodex-closed' | 'sodex-below'; text: string }
  | { verdict: 'confirm'; reason: 'below'; text: string; brief: string; enough: string };

export function arrivalCheck(o: {
  owner: string;
  coin: CoinConfig;
  route: ChainRoute | 'VALUECHAIN';
  receiver: string;
  /** What is sent, and SoDEX's fee taken out of it, in base units of the coin (amount 0: none yet). */
  amount: bigint;
  fee: bigint;
  registry: ReceiverAccount | null;
}): ArrivalCheck {
  const addr = o.receiver.trim();
  const route = o.route;
  const evm = route === 'VALUECHAIN' || route.addressKind === 'evm';
  if (!addr || (evm && addr.toLowerCase() === o.owner.toLowerCase())) return { verdict: 'ok' };
  const c = o.coin.coin;
  if (o.registry?.own) {
    const min = route !== 'VALUECHAIN' && route.deposit.min ? `${route.deposit.min} ${c} ` : '';
    return {
      verdict: 'refuse',
      reason: 'own',
      text:
        route === 'VALUECHAIN'
          ? 'That is your own SoDEX deposit address for other chains - a ValueChain transfer to it is not a deposit and would not be credited. Withdraw to a wallet instead.'
          : `That is your own SoDEX deposit address. A withdrawal to it at best comes back to this account minus the fee, and below SoDEX's ${min}deposit minimum it is lost. Withdraw to a wallet instead.`,
    };
  }
  if (route === 'VALUECHAIN' || o.amount <= 0n) return { verdict: 'ok' };
  const dp = o.coin.valuechain.decimals;
  const fmt = (u: bigint) => formatUnits(u, dp);
  if (o.registry?.depositOf && !route.deposit.allowed) {
    return { verdict: 'refuse', reason: 'sodex-closed', text: `That is a SoDEX deposit address, and SoDEX takes no ${c} deposits on ${route.label} right now - it would not be credited.` };
  }
  const min = units(route.deposit.min, dp);
  const arrives = o.amount > o.fee ? o.amount - o.fee : 0n;
  if (min === 0n || arrives >= min) return { verdict: 'ok' };
  const withdrawMin = units(route.withdraw.min, dp);
  const enough = fmt(min + o.fee > withdrawMin ? min + o.fee : withdrawMin);
  const short = `${fmt(arrives)} ${c} arrives after the ${fmt(o.fee)} ${c} fee - below SoDEX's ${route.deposit.min} ${c} deposit minimum on ${route.label}`;
  if (o.registry?.depositOf) {
    return { verdict: 'refuse', reason: 'sodex-below', text: `That is a SoDEX deposit address. Only ${short}, so it would never be credited. Withdraw at least ${enough} ${c}.` };
  }
  return {
    verdict: 'confirm',
    reason: 'below',
    text: `Only ${short}. If this is the deposit address of a SoDEX account (or of any exchange), it will not be credited. To be credited there, withdraw at least ${enough} ${c}.`,
    brief: `Only ${short}. You confirmed this address is a wallet, not a deposit address.`,
    enough,
  };
}
