/**
 * ValueChain (the L1 SoDEX settles on) — RPC access, the exchange contract, and
 * the coin registry used for deposits.
 *
 * HOW THIS WAS DETERMINED. None of it is in the SoDEX docs or the Go SDK, so it
 * was reverse-engineered from the live chain and then verified by simulation:
 *
 *  - sodex.com's bundle references `main-scan.valuechain.xyz` -> the chain is
 *    ValueChain, and `eth_chainId` on rpc.valuechain.xyz returns 0x45f9f
 *    (286623), matching the SoDEX mainnet chain id.
 *  - The exchange is `0x0101…0101` ("ValueChainProxy" on the explorer). It holds
 *    the largest vUSDC balance on the chain and is the counterparty on every
 *    user deposit and withdrawal.
 *  - It exposes `depositERC20(address token, uint256 amount)` (selector
 *    0x97feb926), called directly by EOAs.
 *  - `eth_call` simulation established the two paths precisely:
 *      * token == address(0)  -> native SOSO, and msg.value MUST equal amount
 *        (a mismatch reverts with custom error 0xed39c7cb). Credited as WSOSO.
 *      * token != address(0)  -> ERC-20; with no allowance it reverts with
 *        0xfb8f41b2 = ERC20InsufficientAllowance(spender=0x0101…0101), i.e. the
 *        standard approve-then-transferFrom pattern.
 *
 * Nothing here spends funds: the backend only ever READS chain state and builds
 * unsigned calldata. Every transaction is signed and sent by the user's wallet.
 */
import { NETWORK, type Network } from '../config.js';
import { keccak256, utf8, bytesToHex, hexToBytes } from '../signing/eip712.js';
import { canonicalDecimal, decimalCompare } from '../decimal.js';
import { coins as gatewayCoins, type Coin } from './symbols.js';
import { CHAINS, type ChainConfig } from './chainParams.js';
import { fromBaseUnits, toBaseUnits } from './units.js';

// Pure and shared with the browser: the chain table (chainParams.ts) and the
// exact decimal <-> base-unit conversions (units.ts).
export { CHAINS, fromBaseUnits, toBaseUnits, type ChainConfig };

export const CHAIN: ChainConfig = CHAINS[NETWORK];

/** Native deposits use the zero address as the token sentinel. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

// --- ABI encoding -----------------------------------------------------------

const selector = (sig: string): string => bytesToHex(keccak256(utf8(sig))).slice(0, 10);

export const SELECTORS = {
  depositERC20: selector('depositERC20(address,uint256)'), // 0x97feb926
  // Returns the SoDEX account id for an address, and reverts with 0x40298ab1
  // when that address has never been registered. Verified to agree exactly with
  // the gateway's `aid` (both reported 9150 for the same wallet).
  getUserId: selector('getUserId(address)'), // 0x2b956ff7
  // Owner-only: only SoDEX can create accounts. Calling it from any normal
  // wallet reverts with OwnableUnauthorizedAccount (0x118cdaa7), which is why
  // Valuetrade cannot self-register a brand-new wallet.
  register: selector('register(address)'), // 0x4420e486
  approve: selector('approve(address,uint256)'),
  allowance: selector('allowance(address,address)'),
  balanceOf: selector('balanceOf(address)'),
  decimals: selector('decimals()'),
  symbol: selector('symbol()'),
} as const;

const padWord = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const encodeAddress = (a: string): string => padWord(a);
const encodeUint = (v: bigint): string => padWord(v.toString(16));

export const encodeCall = (sel: string, ...words: string[]): string => sel + words.join('');

// --- JSON-RPC ---------------------------------------------------------------

let rpcId = 0;

export class RpcError extends Error {
  constructor(message: string, readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export async function rpc<T = string>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(CHAIN.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new RpcError(`ValueChain RPC HTTP ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message: string; data?: unknown } };
  if (j.error) throw new RpcError(j.error.message, j.error.data);
  return j.result as T;
}

export const ethCall = (to: string, data: string, from?: string): Promise<string> =>
  rpc<string>('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);

const toBigInt = (hex: string): bigint => (hex && hex !== '0x' ? BigInt(hex) : 0n);

/** Decode a solidity `string` return value (offset, length, bytes). */
function decodeString(hex: string): string {
  const b = hex.replace(/^0x/, '');
  if (b.length < 128) return '';
  const len = Number.parseInt(b.slice(64, 128), 16);
  return Buffer.from(b.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0+$/, '');
}

// --- reads ------------------------------------------------------------------

export const nativeBalance = (address: string): Promise<bigint> =>
  rpc<string>('eth_getBalance', [address, 'latest']).then(toBigInt);

export const tokenBalance = (token: string, owner: string): Promise<bigint> =>
  ethCall(token, encodeCall(SELECTORS.balanceOf, encodeAddress(owner))).then(toBigInt);

export const tokenAllowance = (token: string, owner: string, spender: string): Promise<bigint> =>
  ethCall(token, encodeCall(SELECTORS.allowance, encodeAddress(owner), encodeAddress(spender))).then(toBigInt);

export const tokenDecimals = (token: string): Promise<number> =>
  ethCall(token, encodeCall(SELECTORS.decimals)).then((h) => Number(toBigInt(h)));

export const tokenSymbol = (token: string): Promise<string> =>
  ethCall(token, encodeCall(SELECTORS.symbol)).then(decodeString);

// --- calldata builders (never sent from here; the wallet signs them) --------

export const encodeApprove = (spender: string, amount: bigint): string =>
  encodeCall(SELECTORS.approve, encodeAddress(spender), encodeUint(amount));

export const encodeDeposit = (token: string, amount: bigint): string =>
  encodeCall(SELECTORS.depositERC20, encodeAddress(token), encodeUint(amount));

// --- coin registry ----------------------------------------------------------

export interface DepositAsset {
  coinId: number;
  symbol: string;
  /** Token contract, or the zero address for the native coin. */
  address: string;
  decimals: number;
  isNative: boolean;
  /** True once symbol+decimals were confirmed by an on-chain call. */
  verified: boolean;
}

interface Registry {
  at: number;
  assets: DepositAsset[];
  warnings: string[];
}

let registry: Registry | null = null;
const REGISTRY_TTL = 10 * 60_000;

/** Explorer token list (mainnet only), paginated. */
/**
 * SoDEX'S OWN address-bearing token list.
 *
 * THE BUG THIS FIXES ROUTES DEPOSITS TO THE WRONG CONTRACT.
 *
 * `depositRegistry()` used to resolve a coin to an ERC-20 by matching the
 * gateway's coin NAME against the explorer's token SYMBOL, through a
 * `new Map(tokens.map(t => [symbol, t]))` - where the last write wins. Two
 * ERC-20s on ValueChain share the symbol `vGRAM`, both with 9 decimals and both
 * named "SoDexToken: GRAM":
 *
 *     0x99b2d9978922f573A5313bB7301f61c3ea6bBb1A   <- the real one
 *     0xe2896008BEf7b9e35C446AA9be79448790767198
 *
 * The decimals guard below cannot catch it (both are 9) and neither can the
 * name check (both match), so a vGRAM deposit was addressed to whichever the
 * explorer happened to paginate last. A deposit sent to the wrong contract does
 * not fail - it succeeds, into a token the exchange does not credit.
 *
 * SoDEX publishes the answer at `/{net}/chain/tradable-tokens`: 38 entries, one
 * address per symbol, no duplicates. That is authoritative and the explorer is
 * not, so it is consulted FIRST and the explorer becomes corroboration.
 */
async function sodexTokenList(): Promise<Array<{ symbol: string; address: string; decimals: number }>> {
  const host = NETWORK === 'testnet' ? 'testnet' : 'mainnet';
  const res = await fetch(`https://sodex.dev/${host}/chain/tradable-tokens`, {
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`tradable-tokens ${res.status}`);
  const body = (await res.json()) as { code?: number; data?: unknown };
  if (body?.code !== 0 || !Array.isArray(body.data)) throw new Error('tradable-tokens: unexpected shape');
  return (body.data as Array<Record<string, unknown>>)
    .map((t) => ({
      symbol: String(t.symbol ?? ''),
      address: String(t.address ?? ''),
      decimals: Number(t.decimals ?? NaN),
    }))
    .filter((t) => t.symbol && /^0x[0-9a-fA-F]{40}$/.test(t.address) && Number.isFinite(t.decimals));
}

async function explorerTokens(): Promise<Array<{ symbol: string; address: string; decimals: number }>> {
  if (!CHAIN.explorerApi) return [];
  const out: Array<{ symbol: string; address: string; decimals: number }> = [];
  let next: Record<string, string> | null = null;
  for (let page = 0; page < 10; page++) {
    const q: string = next ? '&' + new URLSearchParams(next).toString() : '';
    const res = await fetch(`${CHAIN.explorerApi}/tokens?type=ERC-20${q}`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) break;
    const j = (await res.json()) as { items?: any[]; next_page_params?: Record<string, string> | null };
    for (const t of j.items ?? []) {
      if (t?.symbol && t?.address) {
        out.push({ symbol: String(t.symbol), address: String(t.address), decimals: Number(t.decimals) });
      }
    }
    next = j.next_page_params ?? null;
    if (!next) break;
  }
  return out;
}

/**
 * Build the coinID -> token-contract registry.
 *
 * The gateway publishes coin ids, names and precisions but no contract
 * addresses; the explorer publishes contracts but no coin ids. They are joined
 * on symbol, and the join is only accepted when the on-chain `decimals()`
 * agrees with the gateway's `precision` — a mismatch would silently scale a
 * deposit by orders of magnitude.
 */
export async function depositRegistry(force = false): Promise<Registry> {
  if (!force && registry && Date.now() - registry.at < REGISTRY_TTL) return registry;

  const warnings: string[] = [];
  const [coinList, tokens, official] = await Promise.all([
    gatewayCoins().catch((e) => {
      warnings.push(`gateway coin list unavailable: ${(e as Error).message}`);
      return [] as Coin[];
    }),
    explorerTokens().catch((e) => {
      warnings.push(`explorer token list unavailable: ${(e as Error).message}`);
      return [] as Array<{ symbol: string; address: string; decimals: number }>;
    }),
    sodexTokenList().catch((e) => {
      warnings.push(`SoDEX token list unavailable: ${(e as Error).message}`);
      return [] as Array<{ symbol: string; address: string; decimals: number }>;
    }),
  ]);

  /*
   * SODEX'S LIST WINS. The explorer's is built by symbol and symbols are not
   * unique on chain - see `sodexTokenList`. The explorer is still consulted for
   * anything SoDEX does not list, but never to override it.
   */
  const officialBySymbol = new Map(official.map((t) => [t.symbol.toLowerCase(), t]));

  /*
   * AMBIGUITY IS REPORTED, NOT SILENTLY RESOLVED. Building the explorer map with
   * "first write wins" and recording a warning when a second appears turns an
   * invisible wrong answer into a visible one.
   */
  const explorerBySymbol = new Map<string, { symbol: string; address: string; decimals: number }>();
  const ambiguous = new Set<string>();
  for (const t of tokens) {
    const k = t.symbol.toLowerCase();
    const seen = explorerBySymbol.get(k);
    if (!seen) { explorerBySymbol.set(k, t); continue; }
    if (seen.address.toLowerCase() !== t.address.toLowerCase()) ambiguous.add(k);
  }
  for (const k of ambiguous) {
    if (!officialBySymbol.has(k)) {
      warnings.push(
        `${k}: more than one ValueChain ERC-20 uses this symbol and SoDEX does not list it - not offered for deposit`,
      );
    }
  }

  const bySymbol = {
    get(k: string) {
      const off = officialBySymbol.get(k);
      if (off) return off;
      /* No authoritative answer AND more than one candidate: refuse rather than
         guess. A deposit to the wrong contract is not recoverable. */
      if (ambiguous.has(k)) return undefined;
      return explorerBySymbol.get(k);
    },
  };
  const assets: DepositAsset[] = [
    {
      coinId: -1,
      symbol: CHAIN.nativeCurrency.symbol,
      address: NATIVE_TOKEN,
      decimals: CHAIN.nativeCurrency.decimals,
      isNative: true,
      verified: true,
    },
  ];

  for (const c of coinList) {
    const t = bySymbol.get(String(c.name).toLowerCase());
    if (!t) {
      warnings.push(`no ValueChain ERC-20 found for ${c.name} (coinId ${c.id})`);
      continue;
    }
    if (Number(t.decimals) !== Number(c.precision)) {
      warnings.push(
        `decimals mismatch for ${c.name}: gateway says ${c.precision}, chain says ${t.decimals} - excluded`,
      );
      continue;
    }
    assets.push({
      coinId: c.id,
      symbol: c.name,
      address: t.address,
      decimals: Number(t.decimals),
      isNative: false,
      verified: false,
    });
  }

  // Native first, then by coin id - which puts vUSDC (id 0), the quote asset
  // for every market, at the top where a depositor most often wants it.
  assets.sort((a, b) => (a.isNative ? -1 : b.isNative ? 1 : a.coinId - b.coinId));

  registry = { at: Date.now(), assets, warnings };
  return registry;
}

export async function findAsset(coinId: number): Promise<DepositAsset | undefined> {
  const { assets } = await depositRegistry();
  return assets.find((a) => a.coinId === coinId);
}

/**
 * Confirm an asset's contract really is the token we think it is, by asking the
 * chain directly for its symbol and decimals.
 *
 * This runs immediately before a deposit is prepared. The registry join is
 * inference from two third-party lists; this is ground truth, and it is the
 * difference between "probably the right contract" and "the chain says so".
 */
export async function verifyAsset(asset: DepositAsset): Promise<DepositAsset> {
  if (asset.isNative) return asset;
  const [sym, dec] = await Promise.all([tokenSymbol(asset.address), tokenDecimals(asset.address)]);
  if (dec !== asset.decimals) {
    throw new Error(
      `refusing to build a deposit: ${asset.symbol} at ${asset.address} reports ${dec} decimals on-chain, registry expected ${asset.decimals}`,
    );
  }
  if (sym && sym.toLowerCase() !== asset.symbol.toLowerCase()) {
    throw new Error(
      `refusing to build a deposit: contract ${asset.address} reports symbol "${sym}", registry expected "${asset.symbol}"`,
    );
  }
  return { ...asset, verified: true };
}

/**
 * Custom errors the exchange contract returns, mapped to plain language.
 * Solidity custom errors are just 4-byte selectors on the wire, so these were
 * identified empirically by simulating each failure case.
 */
export const CONTRACT_ERRORS: Record<string, string> = {
  // Observed on every address whose SoDEX account id is 0, at any amount
  // (including 1 wei), and on no address that has one.
  // A wallet's FIRST deposit pays SoDEX's one-time activation fee (1 USDC / 1
  // SOSO) and creates its account; at or under the fee it reverts with this.
  // Simulated 2026-09-26 from a never-seen address: 1.0 SOSO reverts, 1.1 SOSO
  // succeeds (to spot and to perps).
  '0xe7178dd4':
    'This first deposit is too small. SoDEX keeps 1 USDC or 1 SOSO as a one-time account activation fee, so the first deposit must be larger than that.',
  // Observed when depositing native with msg.value != amount.
  '0xed39c7cb': 'Native deposit rejected: the transaction value must exactly equal the deposit amount.',
  // OpenZeppelin ERC20InsufficientAllowance(spender, allowance, needed).
  '0xfb8f41b2': 'The exchange is not approved to move this token yet - send the approve transaction first.',
  // getUserId / addAPIKey on an address the exchange has never registered.
  '0x40298ab1': 'This wallet is not registered with SoDEX.',
  // OpenZeppelin OwnableUnauthorizedAccount - register() is owner-only.
  '0x118cdaa7': 'Only SoDEX can register new accounts; a wallet cannot register itself.',
};

export const describeRevert = (data: unknown): string | undefined => {
  const hex = typeof data === 'string' ? data : (data as { data?: string })?.data;
  if (typeof hex !== 'string') return undefined;
  return CONTRACT_ERRORS[hex.slice(0, 10).toLowerCase()];
};

/**
 * Dry-run a deposit with eth_call before handing the user calldata.
 * Costs nothing, sends nothing, and turns an on-chain revert into an
 * explanation up front instead of a failed transaction and a wasted fee.
 */
export async function simulateDeposit(
  from: string,
  token: string,
  amount: bigint,
  value: bigint,
): Promise<{ ok: true } | { ok: false; selector: string; reason?: string }> {
  try {
    await rpc<string>('eth_call', [
      { from, to: CHAIN.exchange, data: encodeDeposit(token, amount), value: '0x' + value.toString(16) },
      'latest',
    ]);
    return { ok: true };
  } catch (e) {
    const err = e as RpcError;
    const hex = typeof err.data === 'string' ? err.data : '';
    return { ok: false, selector: hex.slice(0, 10), reason: describeRevert(hex) ?? err.message };
  }
}

/**
 * Is this wallet registered with the exchange, and what is its account id?
 *
 * Asks the contract directly rather than inferring from the gateway, because
 * the contract is what actually gates `depositERC20`. A deposit from an
 * unregistered address reverts no matter the amount.
 */
export async function registration(address: string): Promise<{ registered: boolean; accountId: number | null }> {
  try {
    const hex = await ethCall(CHAIN.exchange, encodeCall(SELECTORS.getUserId, padWord(address)), address);
    const id = Number(hex && hex !== '0x' ? BigInt(hex) : 0n);
    return { registered: id !== 0, accountId: id || null };
  } catch {
    // Reverts (0x40298ab1) for unregistered addresses.
    return { registered: false, accountId: null };
  }
}

export const explorerTxUrl = (hash: string): string | null =>
  CHAIN.explorerUrl ? `${CHAIN.explorerUrl}/tx/${hash}` : null;

// --- account id -> wallet address (on-chain) ---------------------------------

/**
 * Resolve an account id to the address that OWNS it.
 *
 * This used to scan `Deposit` logs for the account id and return whoever sent
 * the funding transaction. That is wrong, and measurably so: across four
 * sampled mainnet accounts the depositor differed from the owner in four cases
 * out of four (accounts are routinely funded from an exchange withdrawal, a
 * relay, or a second wallet). The result fed `isYourOwnAddress` on the transfer
 * confirmation, so it could tell a user that a destination was theirs when it
 * was not - on the one dialog in the app where that specific mistake is
 * expensive.
 *
 * The exchange answers the question directly. Selector `0x792713b8` takes a
 * uint256 account id and returns the owner address. Verified on mainnet:
 *   210818 -> 0x676e3ad1aa49a47e4b193d11f47fff272e6e0842
 *   221780 -> 0xbeac61097fec525a1010a2f2ec26021d229c07c6
 * both agreeing with `getUserId()` in the reverse direction.
 *
 * The result is cross-checked by round-tripping through `getUserId(owner)` and
 * requiring it to return the same id. Only then is `verified` true. There is no
 * "best effort" fallback any more: for a question whose wrong answer is a
 * misdirected transfer, no answer is better than a plausible one.
 */
const SELECTOR_OWNER_OF_ACCOUNT = '0x792713b8';
/** getAccountsByAddress(address) -> uint256[] : every account an address controls. */
const SELECTOR_ACCOUNTS_BY_ADDRESS = '0x380e78af';

/** Decode a solidity `uint256[]` return value. */
function decodeUintArray(hex: string): number[] {
  const b = (hex || '').replace(/^0x/, '');
  if (b.length < 128) return [];
  const n = Number(BigInt('0x' + b.slice(64, 128)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const word = b.slice(128 + i * 64, 128 + (i + 1) * 64);
    if (word.length < 64) break;
    out.push(Number(BigInt('0x' + word)));
  }
  return out;
}

export interface OnChainResolution {
  ok: boolean;
  accountId: number;
  /**
   * True only when the exchange returned an owner AND `getUserId(owner)` round-
   * tripped back to the same account id. Never a guess.
   */
  verified: boolean;
  address: string | null;
  /** Retained for response-shape compatibility; always empty now. */
  candidates: string[];
  /**
   * True when SoDEX's own public resolver independently returned the SAME
   * address. Absence is not a failure - the endpoint may simply be unreachable -
   * but a MISMATCH is, and is treated as one.
   */
  corroborated?: boolean;
  error?: string;
}

/**
 * SoDEX publishes its own id -> address resolver, CORS-open:
 *   https://sodex.dev/mainnet/chain/user/<id>/address
 *
 * It is the operator's answer rather than the chain's, so it is used to
 * CORROBORATE the on-chain read, never to replace it. Agreement across two
 * independent sources is what lets this resolver claim more than "one RPC said
 * so" - which matters because the selector we call is unnamed and the exchange's
 * implementation source is not published. Measured agreement at time of writing:
 * 3 of 3 sampled accounts, exact match.
 */
async function corroborateOwner(accountId: number): Promise<string | null> {
  const host = NETWORK === 'testnet' ? 'testnet' : 'mainnet';
  try {
    const res = await fetch(`https://sodex.dev/${host}/chain/user/${accountId}/address`, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { address?: string } };
    const a = body?.data?.address;
    return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
  } catch {
    return null; // unreachable is not a contradiction
  }
}

const onchainCache = new Map<number, { at: number; value: OnChainResolution }>();
const ONCHAIN_TTL = 60 * 60_000;
/** Bounded (security audit S-06): expired entries go first, then the oldest. */
const ONCHAIN_MAX = 5_000;

function pruneOnchain(now: number): void {
  if (onchainCache.size <= ONCHAIN_MAX) return;
  for (const [k, v] of onchainCache) if (now - v.at >= ONCHAIN_TTL) onchainCache.delete(k);
  for (const k of onchainCache.keys()) {
    if (onchainCache.size <= ONCHAIN_MAX) break;
    onchainCache.delete(k);
  }
}

/** Decode a 32-byte word returned as an address, or null if it is the zero word. */
function decodeAddress(hex: string): string | null {
  const b = (hex || '').replace(/^0x/, '');
  if (b.length < 64) return null;
  const addr = '0x' + b.slice(-40);
  return /^0x0{40}$/.test(addr) ? null : addr;
}

export async function resolveAccountOnChain(accountId: number): Promise<OnChainResolution> {
  const cached = onchainCache.get(accountId);
  if (cached && Date.now() - cached.at < ONCHAIN_TTL) return cached.value;

  const put = (v: OnChainResolution): OnChainResolution => {
    onchainCache.delete(accountId);
    onchainCache.set(accountId, { at: Date.now(), value: v });
    pruneOnchain(Date.now());
    return v;
  };

  if (!Number.isInteger(accountId) || accountId <= 0) {
    return put({
      ok: false, accountId, verified: false, address: null, candidates: [],
      error: 'account id must be a positive integer',
    });
  }

  try {
    const word = accountId.toString(16).padStart(64, '0');
    const raw = await ethCall(CHAIN.exchange, SELECTOR_OWNER_OF_ACCOUNT + word);
    const owner = decodeAddress(raw);
    if (!owner) {
      return put({
        ok: true, accountId, verified: false, address: null, candidates: [],
        error: 'the exchange reports no owner for this account id',
      });
    }

    /*
     * Round-trip: the account we asked about must appear among the accounts that
     * owner controls. Without this we would be trusting a single call to a
     * contract whose source is not published; with it, two independent accessors
     * have to agree.
     *
     * `getAccountsByAddress` and not `getUserId`: getUserId returns only the
     * address's PRIMARY account. Today account ids and user ids are one-to-one
     * so either works, but the moment SoDEX issues a sub-account, a getUserId
     * round-trip would fail for it and this resolver would report a perfectly
     * real account as unknown. Checking membership in the full list is correct
     * in both worlds. getUserId remains the fallback for the case where the
     * array accessor is unavailable.
     */
    let owns = false;
    let observed: string;
    try {
      const listRaw = await ethCall(
        CHAIN.exchange,
        SELECTOR_ACCOUNTS_BY_ADDRESS + padWord(owner).replace(/^0x/, ''),
      );
      const ids = decodeUintArray(listRaw);
      owns = ids.includes(accountId);
      observed = ids.length ? `accounts [${ids.join(', ')}]` : 'no accounts';
    } catch {
      const back = await registration(owner);
      owns = back.accountId === accountId;
      observed = `primary account ${back.accountId ?? 'none'}`;
    }

    if (!owns) {
      return put({
        ok: true, accountId, verified: false, address: null, candidates: [],
        error: `owner lookup did not round-trip: ${owner} reports ${observed}, which does not include ${accountId}`,
      });
    }

    // Second opinion. A disagreement between the chain and the operator's own
    // resolver is a genuine anomaly - one of them is wrong about who owns an
    // account - and this is a transfer confirmation, so it fails closed.
    const second = await corroborateOwner(accountId);
    if (second && second !== owner.toLowerCase()) {
      return put({
        ok: true, accountId, verified: false, address: null, candidates: [], corroborated: false,
        error:
          `sources disagree on the owner of account ${accountId}: chain says ${owner}, ` +
          `sodex.dev says ${second}. Refusing to guess.`,
      });
    }

    return put({
      ok: true, accountId, verified: true, address: owner, candidates: [],
      corroborated: second !== null,
    });
  } catch (e) {
    return put({
      ok: false, accountId, verified: false, address: null, candidates: [],
      error: `on-chain lookup failed: ${(e as Error).message}`,
    });
  }
}

export { decimalCompare, hexToBytes };
