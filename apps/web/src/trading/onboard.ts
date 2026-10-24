/**
 * Creating a SoDEX account from this app.
 *
 * SoDEX has no "sign up": a wallet's FIRST deposit of USDC (or SOSO) opens its
 * account, and SoDEX keeps 1 USDC / 1 SOSO of it as a one-time activation fee
 * (documented; simulated on ValueChain 2026-09-26: 1.0 SOSO from a never-seen
 * wallet reverts, 1.1 SOSO creates the account). Two ways in, both done here:
 *
 *   - FROM ANOTHER NETWORK (most people): USDC on Arbitrum, Base, Ethereum, BNB
 *     Chain or Polygon, sent by the connected wallet to the wallet's own SoDEX
 *     custody deposit address. SoDEX credits Spot and opens the account. The
 *     address comes from our backend, which re-derives it from the ValueChain
 *     registry (routes/mirror.ts); the token contract must match both SoDEX's
 *     asset config AND the canonical USDC contract below, and its symbol and
 *     decimals are read on-chain before anything is sent.
 *   - FROM VALUECHAIN: a direct deposit to the exchange contract (the Deposit
 *     sheet's Wallet option, trading/funds.ts), for wallets holding USDC or SOSO there.
 *
 * The wallet signs and sends every transaction itself; this module only builds
 * calldata and asks.
 */
import { addOrSwitchChain, sendTransaction, WalletError, type Eip1193Provider } from '../wallet';
import { readGateway } from './gateway';
import { logger } from '../log';
import { requireTermsOrThrow } from '../legal/acceptance';

const log = logger('trade');

export interface EvmChain {
  /** SoDEX's chain key (asset config `chainName`). */
  key: string;
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  native: { name: string; symbol: string; decimals: number };
}

const ETH = { name: 'Ether', symbol: 'ETH', decimals: 18 };

/** The EVM networks a first deposit can come from, with what a wallet needs to switch to them. */
export const EVM_CHAINS: Record<string, EvmChain> = {
  ARBITRUM_ETH: { key: 'ARBITRUM_ETH', chainId: 42161, name: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', native: ETH },
  BASE_ETH: { key: 'BASE_ETH', chainId: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org', native: ETH },
  ETH: { key: 'ETH', chainId: 1, name: 'Ethereum', rpcUrl: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', native: ETH },
  BSC_BNB: { key: 'BSC_BNB', chainId: 56, name: 'BNB Smart Chain', rpcUrl: 'https://bsc-dataseed.bnbchain.org', explorer: 'https://bscscan.com', native: { name: 'BNB', symbol: 'BNB', decimals: 18 } },
  MATIC: { key: 'MATIC', chainId: 137, name: 'Polygon', rpcUrl: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com', native: { name: 'POL', symbol: 'POL', decimals: 18 } },
};

/**
 * USDC's canonical contracts (Circle's native USDC; Binance-Peg USDC on BNB
 * Chain, which has 18 decimals). A route whose token SoDEX lists differently is
 * not offered: a wrong token address is the one mistake here that loses funds.
 */
export const CANONICAL_USDC: Record<string, { address: string; decimals: number }> = {
  ARBITRUM_ETH: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
  BASE_ETH: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  ETH: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  BSC_BNB: { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
  MATIC: { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
};

/** Order the network picker shows (cheap and fast first). */
const ORDER = ['ARBITRUM_ETH', 'BASE_ETH', 'BSC_BNB', 'MATIC', 'ETH'];

export interface UsdcRoute {
  chain: EvmChain;
  /** The USDC contract on that chain (lower-case). */
  token: string;
  decimals: number;
  /** SoDEX's minimum for a custody deposit on that chain, in USDC. */
  minDeposit: string;
  /** SoDEX's estimate, seconds. */
  etaSeconds: number | null;
}

interface AssetConfigRow {
  assetName?: string;
  chains?: Array<{
    chainName?: string;
    isNativeToken?: boolean;
    tokenAddress?: string;
    custody?: { minDepositAmount?: string; allowDeposit?: boolean; estimatedDepositSeconds?: number };
  }>;
}

/** The USDC routes SoDEX accepts right now that we can send from an EVM wallet. */
export async function usdcRoutes(): Promise<UsdcRoute[]> {
  const rows = await readGateway<AssetConfigRow[]>('/api/v1/asset/config?name=USDC');
  const usdc = (rows ?? []).find((r) => (r.assetName ?? '').toUpperCase() === 'USDC');
  const out: UsdcRoute[] = [];
  for (const c of usdc?.chains ?? []) {
    const key = (c.chainName ?? '').toUpperCase();
    const chain = EVM_CHAINS[key];
    const canon = CANONICAL_USDC[key];
    if (!chain || !canon || c.isNativeToken || !c.custody?.allowDeposit) continue;
    if ((c.tokenAddress ?? '').toLowerCase() !== canon.address) {
      log.warn('USDC route withheld: SoDEX lists a non-canonical token', { chain: key, token: c.tokenAddress });
      continue;
    }
    out.push({
      chain,
      token: canon.address,
      decimals: canon.decimals,
      minDeposit: c.custody.minDepositAmount && /^\d+(\.\d+)?$/.test(c.custody.minDepositAmount) ? c.custody.minDepositAmount : '5',
      etaSeconds: typeof c.custody.estimatedDepositSeconds === 'number' ? c.custody.estimatedDepositSeconds : null,
    });
  }
  return out.sort((a, b) => ORDER.indexOf(a.chain.key) - ORDER.indexOf(b.chain.key));
}

// --- amounts and calldata -------------------------------------------------------

/** "12.5" -> 12_500_000n at 6 decimals. Refuses more precision than the token has. */
export function parseUnits(amount: string, decimals: number): bigint {
  const a = String(amount ?? '').trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(a);
  if (!m) throw new RangeError('Enter an amount like 10 or 12.5');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new RangeError(`At most ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** 12_500_000n at 6 decimals -> "12.5". */
export function formatUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const x = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = x / base;
  const frac = (x % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

const word = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** `transfer(address to, uint256 amount)` */
export function erc20TransferData(to: string, amount: bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('bad recipient address');
  if (amount <= 0n) throw new RangeError('amount must be positive');
  return `0xa9059cbb${word(to)}${word(amount.toString(16))}`;
}

// --- reading the token through the wallet ------------------------------------------

async function call(provider: Eip1193Provider, to: string, data: string): Promise<string> {
  const r = (await provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })) as unknown;
  if (typeof r !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r)) throw new WalletError('The wallet returned an unreadable answer for the token.');
  return r;
}

/** ABI-decode a `string` return (or a bytes32 one, for old tokens). */
export function decodeString(hex: string): string {
  const h = hex.replace(/^0x/, '');
  if (h.length >= 128) {
    const len = Number(BigInt(`0x${h.slice(64, 128)}`));
    const bytes = h.slice(128, 128 + len * 2);
    return decodeURIComponent(bytes.replace(/(..)/g, '%$1'));
  }
  return decodeURIComponent(h.replace(/(00)+$/, '').replace(/(..)/g, '%$1'));
}

export interface TokenOnChain {
  symbol: string;
  decimals: number;
  balance: bigint;
}

/** Symbol, decimals and `holder`'s balance of `token`, read on the wallet's current chain. */
export async function readToken(provider: Eip1193Provider, token: string, holder: string): Promise<TokenOnChain> {
  const [sym, dec, bal] = await Promise.all([
    call(provider, token, '0x95d89b41'),
    call(provider, token, '0x313ce567'),
    call(provider, token, `0x70a08231${word(holder)}`),
  ]);
  return { symbol: decodeString(sym), decimals: Number(BigInt(dec)), balance: BigInt(bal === '0x' ? '0x0' : bal) };
}

export interface SentDeposit {
  hash: string;
  explorerUrl: string;
  chain: EvmChain;
  amount: string;
}

/**
 * Send `amount` USDC from the connected wallet on `route`'s network to the
 * wallet's own SoDEX deposit address. Switches the wallet to that network,
 * checks the token on-chain, the minimum and the balance, then asks the
 * wallet to send ONE ERC-20 transfer.
 */
export async function sendUsdcDeposit(o: {
  provider: Eip1193Provider;
  owner: string;
  route: UsdcRoute;
  depositAddress: string;
  amount: string;
}): Promise<SentDeposit> {
  const { provider, owner, route } = o;
  const units = parseUnits(o.amount, route.decimals);
  const min = parseUnits(route.minDeposit, route.decimals);
  if (units < min) throw new RangeError(`The minimum deposit on ${route.chain.name} is ${route.minDeposit} USDC.`);
  // The first deposit opens a SoDEX account to trade through ValueDesk: the terms first (the popup, as a gate).
  await requireTermsOrThrow({ owner, reason: 'make this deposit' });

  await addOrSwitchChain(provider, {
    chainId: `0x${route.chain.chainId.toString(16)}`,
    chainName: route.chain.name,
    rpcUrls: [route.chain.rpcUrl],
    blockExplorerUrls: [route.chain.explorer],
    nativeCurrency: route.chain.native,
  });

  const t = await readToken(provider, route.token, owner);
  if (!/^USDC(\.e)?$/i.test(t.symbol) || t.decimals !== route.decimals) {
    throw new WalletError(`The token at ${route.token} on ${route.chain.name} is not USDC (${t.symbol}, ${t.decimals} decimals). Nothing was sent.`);
  }
  if (t.balance < units) {
    throw new WalletError(
      `Your wallet holds ${formatUnits(t.balance, t.decimals)} USDC on ${route.chain.name} - not enough for ${o.amount} USDC.`,
    );
  }

  log.info('first deposit: asking the wallet to send USDC to its SoDEX deposit address', {
    chain: route.chain.key,
    amount: o.amount,
  });
  const hash = await sendTransaction(provider, {
    from: owner,
    to: route.token,
    data: erc20TransferData(o.depositAddress, units),
    value: '0x0',
    chainId: route.chain.chainId, // re-checked right before sending
  });
  return { hash, explorerUrl: `${route.chain.explorer}/tx/${hash}`, chain: route.chain, amount: o.amount };
}
