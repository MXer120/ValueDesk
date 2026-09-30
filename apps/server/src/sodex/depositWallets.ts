/**
 * The deposit-wallet registry on ValueChain - where sodex.com itself reads a
 * wallet's deposit addresses from, for every coin but SOSO/sSOSO:
 *
 *   getDepositWalletList(address account, string coinSymbol)
 *     -> (string[] chains, string[][] wallets)       sodex.com uses wallets[i][0]
 *
 * It covers every chain SoDEX deposits on - BTC, LTC, DOGE, ADA, SUI, TON, XLM,
 * XRP included - where the older registry (mirrorRegistry.ts, getDepositWallet
 * per chain) plus the REST issuer only ever gave us the EVM chains and Solana.
 * It is a `view` function on ValueChain, so an address read here is on-chain
 * data, not an unverifiable REST answer.
 *
 * Found in sodex.com's own bundle (the deposit panel's `getDepositWalletList`
 * call); the selector and the decoding are pinned by test/depositWallets.test.ts
 * against a live answer.
 */
import { keccak256, utf8, bytesToHex } from '../signing/eip712.js';
import { rpc } from './chain.js';

export const DEPOSIT_WALLET_REGISTRY =
  process.env.SODEX_DEPOSIT_WALLET_REGISTRY?.trim() || '0x07E28Aa1BB34A625c94870476b24213AB4d2E7C8';

const SELECTOR = bytesToHex(keccak256(utf8('getDepositWalletList(address,string)'))).slice(0, 10);

const pad = (h: string): string => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (n: number): string => n.toString(16).padStart(64, '0');

/** The call data for getDepositWalletList(account, coinSymbol). */
export function encodeDepositWalletList(account: string, coinSymbol: string): string {
  const hex = Buffer.from(coinSymbol, 'utf8').toString('hex');
  const body = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0');
  return SELECTOR + pad(account) + word(0x40) + word(Buffer.byteLength(coinSymbol, 'utf8')) + body;
}

/** (string[] chains, string[][] wallets) from the raw answer. Throws on a malformed one. */
export function decodeDepositWalletList(result: string): { chains: string[]; wallets: string[][] } {
  const hex = result.replace(/^0x/, '');
  const size = hex.length / 2;
  const num = (byteOffset: number): number => {
    if (byteOffset < 0 || byteOffset + 32 > size) throw new Error('deposit wallet list: out of range');
    const n = BigInt('0x' + hex.slice(byteOffset * 2, byteOffset * 2 + 64));
    if (n > 1_000_000n) throw new Error('deposit wallet list: implausible length/offset');
    return Number(n);
  };
  const str = (at: number): string => {
    const len = num(at);
    if (at + 32 + len > size) throw new Error('deposit wallet list: string out of range');
    return Buffer.from(hex.slice((at + 32) * 2, (at + 32 + len) * 2), 'hex').toString('utf8');
  };
  const strArray = (at: number): string[] => {
    const n = num(at);
    const base = at + 32;
    return Array.from({ length: n }, (_, i) => str(base + num(base + 32 * i)));
  };
  const chains = strArray(num(0));
  const walletsAt = num(32);
  const n = num(walletsAt);
  const base = walletsAt + 32;
  const wallets = Array.from({ length: n }, (_, i) => strArray(base + num(base + 32 * i)));
  if (wallets.length !== chains.length) throw new Error('deposit wallet list: chains and wallets differ in length');
  return { chains, wallets };
}

const cache = new Map<string, { at: number; value: Map<string, string> }>();
const TTL = 10 * 60_000;

/**
 * chain -> the wallet's deposit address for `coinSymbol` (the first listed,
 * as sodex.com uses it). Empty chains are left out. Settled answers are kept
 * ten minutes; an empty one is not (a new wallet's addresses appear shortly).
 */
export async function depositWallets(account: string, coinSymbol: string): Promise<Map<string, string>> {
  const key = `${account.toLowerCase()}:${coinSymbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const res = await rpc<string>('eth_call', [{ to: DEPOSIT_WALLET_REGISTRY, data: encodeDepositWalletList(account, coinSymbol) }, 'latest']);
  const { chains, wallets } = decodeDepositWalletList(res);
  const value = new Map<string, string>();
  chains.forEach((chain, i) => {
    const w = wallets[i]?.[0]?.trim();
    if (chain && w) value.set(chain.toUpperCase(), w);
  });
  if (value.size) cache.set(key, { at: Date.now(), value });
  return value;
}

const listCache = new Map<string, { at: number; value: Map<string, string[]> }>();

/**
 * chain -> EVERY address the registry lists for `coinSymbol` (oldest first -
 * the custody contract appends on a replacement), empty lists included: an
 * empty list means SoDEX has issued nothing for this coin on that chain.
 * Kept a minute, and only once something is issued.
 */
export async function depositWalletLists(account: string, coinSymbol: string): Promise<Map<string, string[]>> {
  const key = `${account.toLowerCase()}:${coinSymbol}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const res = await rpc<string>('eth_call', [{ to: DEPOSIT_WALLET_REGISTRY, data: encodeDepositWalletList(account, coinSymbol) }, 'latest']);
  const { chains, wallets } = decodeDepositWalletList(res);
  const value = new Map<string, string[]>();
  chains.forEach((chain, i) => {
    if (chain) value.set(chain.toUpperCase(), (wallets[i] ?? []).map((w) => w.trim()).filter(Boolean));
  });
  if ([...value.values()].some((l) => l.length)) listCache.set(key, { at: Date.now(), value });
  return value;
}

export const _forgetDepositWalletLists = (account: string): void => {
  const prefix = `${account.toLowerCase()}:`;
  for (const k of [...listCache.keys()]) if (k.startsWith(prefix)) listCache.delete(k);
};
