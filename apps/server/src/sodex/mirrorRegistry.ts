/**
 * The mirror registry on ValueChain — the authoritative, on-chain source for
 * cross-chain deposits.
 *
 * WHY THIS EXISTS. The REST endpoint that hands out deposit addresses is
 * convenient but unverifiable: if it ever returned a wrong address, a user would
 * send funds to it and they would be gone. This contract exposes the same data
 * as `view` functions, so every address shown in the UI is cross-checked against
 * the chain before it is displayed, and a mismatch is treated as fatal.
 *
 * Found by brute force: of the 200 verified contracts on ValueChain, this is the
 * one whose `getDepositWallet(account, "ETH")` reproduces the address the REST
 * API returned for a known wallet.
 *
 *   getDepositWallet(address account, string chain) -> string
 *   listRemoteNativeTokens() -> RemoteNativeToken[]
 *
 *   struct RemoteNativeToken {
 *     string  chain;             // "ETH", "BASE_ETH", …
 *     string  coinAddr;          // token contract on the REMOTE chain
 *     string  bridgeAddr;
 *     bool    custodyDisabled;   // deposits are OFF for this route
 *     uint256 minDepositAmount;  // below this, a deposit may not be credited
 *     uint256 custodyAmount;
 *     uint256 bridgedAmount;
 *   }
 */
import { keccak256, utf8, bytesToHex } from '../signing/eip712.js';
import { CHAIN, rpc } from './chain.js';

export const MIRROR_REGISTRY =
  process.env.SODEX_MIRROR_REGISTRY?.trim() || '0xB37295d1ea21E65b76dCB2E85e035eE0dBFC70CB';

const sel = (s: string): string => bytesToHex(keccak256(utf8(s))).slice(0, 10);

export const MIRROR_SELECTORS = {
  getDepositWallet: sel('getDepositWallet(address,string)'),
  listRemoteNativeTokens: sel('listRemoteNativeTokens()'),
} as const;

const pad = (h: string): string => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const padRight = (h: string): string => h.padEnd(Math.ceil(h.length / 64) * 64 || 64, '0');
const word = (n: number | bigint): string => pad(n.toString(16));

// --- minimal ABI decoding ---------------------------------------------------

const at = (hex: string, wordIndex: number): string => hex.slice(wordIndex * 64, wordIndex * 64 + 64);
const toNum = (w: string): number => Number(BigInt('0x' + w));
const toBig = (w: string): bigint => BigInt('0x' + w);

/** Decode a dynamic `string` whose data begins at `byteOffset`. */
function readString(hex: string, byteOffset: number): string {
  const head = byteOffset / 32;
  const len = toNum(at(hex, head));
  const raw = hex.slice((head + 1) * 64, (head + 1) * 64 + len * 2);
  return Buffer.from(raw, 'hex').toString('utf8').replace(/\0+$/, '');
}

export interface RemoteNativeToken {
  chain: string;
  coinAddr: string;
  bridgeAddr: string;
  custodyDisabled: boolean;
  minDepositAmount: bigint;
  custodyAmount: bigint;
  bridgedAmount: bigint;
}

/**
 * Decode `RemoteNativeToken[]`.
 *
 * Layout: outer offset -> array length -> one offset per element (relative to
 * the start of the element region) -> each element is a 7-word head where the
 * three strings are themselves offsets relative to the element start.
 */
export function decodeRemoteNativeTokens(result: string): RemoteNativeToken[] {
  const hex = result.replace(/^0x/, '');
  if (hex.length < 128) return [];

  const arrayAt = toNum(at(hex, 0)) / 32;
  const count = toNum(at(hex, arrayAt));
  const out: RemoteNativeToken[] = [];

  for (let i = 0; i < count; i++) {
    const elemOffsetWord = arrayAt + 1 + i;
    const elemStart = arrayAt + 1 + toNum(at(hex, elemOffsetWord)) / 32;
    const rel = (w: number) => at(hex, elemStart + w);

    out.push({
      chain: readString(hex, elemStart * 32 + toNum(rel(0))),
      coinAddr: readString(hex, elemStart * 32 + toNum(rel(1))),
      bridgeAddr: readString(hex, elemStart * 32 + toNum(rel(2))),
      custodyDisabled: toNum(rel(3)) !== 0,
      minDepositAmount: toBig(rel(4)),
      custodyAmount: toBig(rel(5)),
      bridgedAmount: toBig(rel(6)),
    });
  }
  return out;
}

// --- calls ------------------------------------------------------------------

const call = (data: string): Promise<string> =>
  rpc<string>('eth_call', [{ to: MIRROR_REGISTRY, data }, 'latest']);

/** The on-chain deposit address for one wallet on one chain. */
export async function getDepositWallet(account: string, chain: string): Promise<string | null> {
  const hex = Buffer.from(chain, 'utf8').toString('hex');
  const data =
    MIRROR_SELECTORS.getDepositWallet +
    pad(account) +
    word(0x40) +
    word(chain.length) +
    padRight(hex);
  try {
    const res = await call(data);
    if (!res || res === '0x') return null;
    const body = res.replace(/^0x/, '');
    const len = toNum(at(body, 1));
    if (!len) return null;
    return Buffer.from(body.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0+$/, '');
  } catch {
    return null;
  }
}

let cache: { at: number; tokens: RemoteNativeToken[] } | null = null;
const TTL = 5 * 60_000;

export async function remoteNativeTokens(force = false): Promise<RemoteNativeToken[]> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.tokens;
  const res = await call(MIRROR_SELECTORS.listRemoteNativeTokens);
  const tokens = decodeRemoteNativeTokens(res);
  cache = { at: Date.now(), tokens };
  return tokens;
}

/** Everything the registry knows about one chain. */
export async function chainRules(chain: string): Promise<RemoteNativeToken | undefined> {
  const all = await remoteNativeTokens();
  return all.find((t) => t.chain.toUpperCase() === chain.toUpperCase());
}

export const registryInfo = () => ({ address: MIRROR_REGISTRY, chainId: CHAIN.chainId });
