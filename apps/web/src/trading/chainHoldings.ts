/**
 * What a wallet holds on chain, every chain, for the Portfolio's On-chain tab (owner 2026-11-27: "Evm needs to
 * obviously include balances, but make valuedesk support non evm chains too, a lot of them while keeping it highly
 * efficient. Also, users need to be able to see their nfts on valuechain (or other chains if thats easy to support).").
 *
 * ONE READ PER SOURCE, FROM THE BROWSER. Nothing goes through a ValueDesk server (no load, no egress, no key), each
 * source is asked once per address and minute, and every answer lands the moment it arrives:
 *
 *   EVM address    LI.FI's wallet balances: every EVM chain it supports (64 on 2026-11-28: Ethereum, Base, Arbitrum,
 *                  BNB Chain, HyperEVM, Lighter, Robinhood Chain, Monad, Polygon, Avalanche, ...), ONE request, with each token's
 *                  USD price and a verified flag. Plus ValueChain's own explorer (Blockscout): its tokens and SOSO.
 *   Bitcoin        mempool.space         Litecoin   litecoinspace.org     Dogecoin  BlockCypher
 *   Solana         a public Solana node (SOL and every SPL token account, one batched request)
 *   Tron           TronGrid (TRX and the TRC-20s, one request)
 *   TON            toncenter (TON) and TON API (jettons, with prices and a whitelist flag)
 *   Sui            Sui's GraphQL (every coin, one request)      Aptos     Aptos Labs' node (APT)
 *   Cosmos         cosmos.directory's REST proxy: one reader for every Cosmos chain, picked by the address prefix
 *                  (Cosmos Hub, Osmosis, Celestia, Injective, dYdX, Sei, Akash, Noble, Stride, ...)
 *   XRP Ledger     xrplcluster.com       Stellar    Horizon               NEAR      FastNEAR
 *   NFTs           Blockscout's NFT read: ValueChain first; Ethereum, Optimism and nine more EVM chains when asked.
 *
 * Every endpoint was checked from a browser origin on 2026-11-27 (status, CORS). A source that fails leaves its chain
 * out with a note, never a zero.
 *
 * PRICES ARE SOURCED, NEVER ASSUMED. EVM tokens carry LI.FI's price for that exact contract. ValueChain tokens and the
 * native coins of the other chains take SoDEX's price (trading/prices.ts), then Hyperliquid's mid; TON jettons take TON
 * API's. A token no source prices is listed with its amount and left out of the total, and the page says so. Tokens a
 * source does not verify (spam airdrops) are hidden and never counted.
 *
 * Read-only: nothing here signs or sends. The extra addresses a user adds stay in their browser (PortfolioOnchain).
 */
import { HL_INFO_URL } from '../exchange/hosts';
import { coinPrices, priceOf } from './prices';

// --- chains ------------------------------------------------------------------------------------------------------

export interface ChainInfo {
  /** Our key: also the icon key (CoinIcon chain=...). */
  key: string;
  label: string;
  /** The icon: a chain logo key, else the native coin's. */
  icon: string;
}

/** LI.FI chain ids we name (others are shown as "Chain <id>"). Keys match the SoDEX chain keys where one exists. */
const EVM_CHAINS: Record<number, ChainInfo> = {
  1: { key: 'ETH', label: 'Ethereum', icon: 'ETH' },
  10: { key: 'OPTIMISM', label: 'Optimism', icon: 'OP' },
  25: { key: 'CRONOS', label: 'Cronos', icon: 'CRO' },
  56: { key: 'BSC_BNB', label: 'BNB Chain', icon: 'BSC_BNB' },
  100: { key: 'GNOSIS', label: 'Gnosis', icon: 'GNO' },
  130: { key: 'UNICHAIN', label: 'Unichain', icon: 'UNI' },
  137: { key: 'POLYGON', label: 'Polygon', icon: 'POLYGON' },
  146: { key: 'SONIC', label: 'Sonic', icon: 'S' },
  250: { key: 'FANTOM', label: 'Fantom', icon: 'FTM' },
  252: { key: 'FRAXTAL', label: 'Fraxtal', icon: 'FRAX' },
  324: { key: 'ZKSYNC', label: 'zkSync', icon: 'ZK' },
  480: { key: 'WORLDCHAIN', label: 'World Chain', icon: 'WLD' },
  999: { key: 'HYPEREVM_HYPE', label: 'HyperEVM', icon: 'HYPEREVM_HYPE' },
  1088: { key: 'METIS', label: 'Metis', icon: 'METIS' },
  1135: { key: 'LISK', label: 'Lisk', icon: 'LSK' },
  1284: { key: 'MOONBEAM', label: 'Moonbeam', icon: 'GLMR' },
  1868: { key: 'SONEIUM', label: 'Soneium', icon: 'ETH' },
  2741: { key: 'ABSTRACT', label: 'Abstract', icon: 'ETH' },
  5000: { key: 'MANTLE', label: 'Mantle', icon: 'MNT' },
  8453: { key: 'BASE_ETH', label: 'Base', icon: 'BASE_ETH' },
  34443: { key: 'MODE', label: 'Mode', icon: 'MODE' },
  42161: { key: 'ARBITRUM_ETH', label: 'Arbitrum', icon: 'ARBITRUM_ETH' },
  42220: { key: 'CELO', label: 'Celo', icon: 'CELO' },
  43114: { key: 'AVAXC', label: 'Avalanche', icon: 'AVAXC' },
  57073: { key: 'INK', label: 'Ink', icon: 'ETH' },
  59144: { key: 'LINEA', label: 'Linea', icon: 'LINEA' },
  80094: { key: 'BERACHAIN', label: 'Berachain', icon: 'BERA' },
  81457: { key: 'BLAST', label: 'Blast', icon: 'BLAST' },
  167000: { key: 'TAIKO', label: 'Taiko', icon: 'TAIKO' },
  534352: { key: 'SCROLL', label: 'Scroll', icon: 'SCR' },
  // The rest of LI.FI's EVM chains (li.quest/v1/chains, 2026-11-28): its one balance read covers them all.
  1337: { key: 'HYPERCORE', label: 'Hyperliquid', icon: 'HYPEREVM_HYPE' },
  3586256: { key: 'LIGHTER', label: 'Lighter', icon: 'LIT' },
  4663: { key: 'ROBINHOOD_ETH', label: 'Robinhood Chain', icon: 'ROBINHOOD_ETH' },
  143: { key: 'MONAD', label: 'Monad', icon: 'MON' },
  4326: { key: 'MEGAETH', label: 'MegaETH', icon: 'ETH' },
  747474: { key: 'KATANA', label: 'Katana', icon: 'ETH' },
  9745: { key: 'PLASMA', label: 'Plasma', icon: 'XPL' },
  988: { key: 'STABLE', label: 'Stable', icon: 'USDT' },
  33139: { key: 'APECHAIN', label: 'ApeChain', icon: 'APE' },
  42170: { key: 'ARBITRUM_NOVA', label: 'Arbitrum Nova', icon: 'ARBITRUM_ETH' },
  5042: { key: 'ARC', label: 'Arc', icon: 'ARC' },
  16661: { key: 'ZEROG', label: '0G', icon: '0G' },
  42793: { key: 'ETHERLINK', label: 'Etherlink', icon: 'XTZ' },
  122: { key: 'FUSE', label: 'Fuse', icon: 'FUSE' },
  14: { key: 'FLARE', label: 'Flare', icon: 'FLR' },
  747: { key: 'FLOW', label: 'Flow', icon: 'FLOW' },
  43111: { key: 'HEMI', label: 'Hemi', icon: 'ETH' },
  13371: { key: 'IMX', label: 'Immutable zkEVM', icon: 'IMX' },
  1776: { key: 'INJECTIVE_EVM', label: 'Injective', icon: 'INJ' },
  8217: { key: 'KAIA', label: 'Kaia', icon: 'KAIA' },
  2818: { key: 'MORPH', label: 'Morph', icon: 'ETH' },
  1672: { key: 'PHAROS', label: 'Pharos', icon: 'ETH' },
  98866: { key: 'PLUME', label: 'Plume', icon: 'PLUME' },
  2020: { key: 'RONIN', label: 'Ronin', icon: 'RON' },
  30: { key: 'ROOTSTOCK', label: 'Rootstock', icon: 'RBTC' },
  1329: { key: 'SEI_EVM', label: 'Sei', icon: 'SEI' },
  5031: { key: 'SOMNIA', label: 'Somnia', icon: 'SOMI' },
  40: { key: 'TELOS', label: 'Telos', icon: 'TLOS' },
  4217: { key: 'TEMPO', label: 'Tempo', icon: 'ETH' },
  1480: { key: 'VANA', label: 'Vana', icon: 'VANA' },
  88: { key: 'VICTION', label: 'Viction', icon: 'VIC' },
  50: { key: 'XDC', label: 'XDC', icon: 'XDC' },
  196: { key: 'XLAYER', label: 'X Layer', icon: 'OKB' },
  99901: { key: 'ELYSIUM', label: 'Elysium', icon: 'ETH' },
};
export const evmChain = (id: number): ChainInfo => EVM_CHAINS[id] ?? { key: `EVM_${id}`, label: `Chain ${id}`, icon: 'ETH' };
export const VALUECHAIN: ChainInfo = { key: 'VALUECHAIN', label: 'ValueChain', icon: 'VALUECHAIN' };

/** A Cosmos chain: its bech32 prefix, cosmos.directory name, native denom. */
interface CosmosChain extends ChainInfo { prefix: string; dir: string; denom: string; symbol: string; decimals: number }
const COSMOS: CosmosChain[] = [
  { prefix: 'cosmos', dir: 'cosmoshub', denom: 'uatom', symbol: 'ATOM', decimals: 6, key: 'COSMOSHUB', label: 'Cosmos Hub', icon: 'ATOM' },
  { prefix: 'osmo', dir: 'osmosis', denom: 'uosmo', symbol: 'OSMO', decimals: 6, key: 'OSMOSIS', label: 'Osmosis', icon: 'OSMO' },
  { prefix: 'celestia', dir: 'celestia', denom: 'utia', symbol: 'TIA', decimals: 6, key: 'CELESTIA', label: 'Celestia', icon: 'TIA' },
  { prefix: 'inj', dir: 'injective', denom: 'inj', symbol: 'INJ', decimals: 18, key: 'INJECTIVE', label: 'Injective', icon: 'INJ' },
  { prefix: 'dydx', dir: 'dydx', denom: 'adydx', symbol: 'DYDX', decimals: 18, key: 'DYDX', label: 'dYdX Chain', icon: 'DYDX' },
  { prefix: 'sei', dir: 'sei', denom: 'usei', symbol: 'SEI', decimals: 6, key: 'SEI', label: 'Sei', icon: 'SEI' },
  { prefix: 'akash', dir: 'akash', denom: 'uakt', symbol: 'AKT', decimals: 6, key: 'AKASH', label: 'Akash', icon: 'AKT' },
  { prefix: 'noble', dir: 'noble', denom: 'uusdc', symbol: 'USDC', decimals: 6, key: 'NOBLE', label: 'Noble', icon: 'USDC' },
  { prefix: 'stride', dir: 'stride', denom: 'ustrd', symbol: 'STRD', decimals: 6, key: 'STRIDE', label: 'Stride', icon: 'STRD' },
  { prefix: 'neutron', dir: 'neutron', denom: 'untrn', symbol: 'NTRN', decimals: 6, key: 'NEUTRON', label: 'Neutron', icon: 'NTRN' },
  { prefix: 'axelar', dir: 'axelar', denom: 'uaxl', symbol: 'AXL', decimals: 6, key: 'AXELAR', label: 'Axelar', icon: 'AXL' },
  { prefix: 'kava', dir: 'kava', denom: 'ukava', symbol: 'KAVA', decimals: 6, key: 'KAVA', label: 'Kava', icon: 'KAVA' },
  { prefix: 'juno', dir: 'juno', denom: 'ujuno', symbol: 'JUNO', decimals: 6, key: 'JUNO', label: 'Juno', icon: 'JUNO' },
  { prefix: 'stars', dir: 'stargaze', denom: 'ustars', symbol: 'STARS', decimals: 6, key: 'STARGAZE', label: 'Stargaze', icon: 'STARS' },
  { prefix: 'dym', dir: 'dymension', denom: 'adym', symbol: 'DYM', decimals: 18, key: 'DYMENSION', label: 'Dymension', icon: 'DYM' },
  { prefix: 'saga', dir: 'saga', denom: 'usaga', symbol: 'SAGA', decimals: 6, key: 'SAGA', label: 'Saga', icon: 'SAGA' },
  { prefix: 'persistence', dir: 'persistence', denom: 'uxprt', symbol: 'XPRT', decimals: 6, key: 'PERSISTENCE', label: 'Persistence', icon: 'XPRT' },
  { prefix: 'secret', dir: 'secretnetwork', denom: 'uscrt', symbol: 'SCRT', decimals: 6, key: 'SECRET', label: 'Secret', icon: 'SCRT' },
  { prefix: 'terra', dir: 'terra2', denom: 'uluna', symbol: 'LUNA', decimals: 6, key: 'TERRA', label: 'Terra', icon: 'LUNA' },
  { prefix: 'archway', dir: 'archway', denom: 'aarch', symbol: 'ARCH', decimals: 18, key: 'ARCHWAY', label: 'Archway', icon: 'ARCH' },
];

/** The other chains an address can be added for, by family. */
export type Family = 'evm' | 'btc' | 'ltc' | 'doge' | 'sol' | 'trx' | 'ton' | 'sui' | 'apt' | 'cosmos' | 'xrp' | 'xlm' | 'near';
const NATIVE: Record<Exclude<Family, 'evm' | 'cosmos'>, ChainInfo & { symbol: string; decimals: number }> = {
  btc: { key: 'BTC', label: 'Bitcoin', icon: 'BTC', symbol: 'BTC', decimals: 8 },
  ltc: { key: 'LTC', label: 'Litecoin', icon: 'LTC', symbol: 'LTC', decimals: 8 },
  doge: { key: 'DOGE', label: 'Dogecoin', icon: 'DOGE', symbol: 'DOGE', decimals: 8 },
  sol: { key: 'SOL', label: 'Solana', icon: 'SOL', symbol: 'SOL', decimals: 9 },
  trx: { key: 'TRX', label: 'Tron', icon: 'TRX', symbol: 'TRX', decimals: 6 },
  ton: { key: 'TON', label: 'TON', icon: 'TON', symbol: 'TON', decimals: 9 },
  sui: { key: 'SUI', label: 'Sui', icon: 'SUI', symbol: 'SUI', decimals: 9 },
  apt: { key: 'APTOS', label: 'Aptos', icon: 'APT', symbol: 'APT', decimals: 8 },
  xrp: { key: 'XRP', label: 'XRP Ledger', icon: 'XRP', symbol: 'XRP', decimals: 6 },
  xlm: { key: 'XLM', label: 'Stellar', icon: 'XLM', symbol: 'XLM', decimals: 7 },
  near: { key: 'NEAR', label: 'NEAR', icon: 'NEAR', symbol: 'NEAR', decimals: 24 },
};

/** Every chain the tab reads, for the "Supported" list: ValueChain, the named EVM chains, then the others. */
export function supportedChains(): ChainInfo[] {
  return [VALUECHAIN, ...Object.values(EVM_CHAINS), ...Object.values(NATIVE), ...COSMOS];
}

// --- addresses ---------------------------------------------------------------------------------------------------

/** One address the tab reads: the connected wallet (EVM) or one the user added. */
export interface Watched { family: Family; address: string; label?: string }

export interface Detected { family: Family; label: string }

const B58 = '1-9A-HJ-NP-Za-km-z';
const BECH = '02-9ac-hj-np-z';

/**
 * Which chain an address belongs to, from its shape alone. Most shapes are one chain; a 0x + 64 hex address is Sui or
 * Aptos (both offered), a base58 address of 32-44 characters is Solana unless it is one of the shapes before it.
 */
export function detectAddress(raw: string): Detected[] {
  const a = raw.trim();
  if (!a) return [];
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return [{ family: 'evm', label: 'EVM chains' }];
  if (/^0x[0-9a-fA-F]{64}$/.test(a)) return [{ family: 'sui', label: 'Sui' }, { family: 'apt', label: 'Aptos' }];
  if (new RegExp(`^(bc1[${BECH}]{11,71}|[13][${B58}]{25,34})$`).test(a)) return [{ family: 'btc', label: 'Bitcoin' }];
  if (new RegExp(`^(ltc1[${BECH}]{11,71}|[LM][${B58}]{26,33})$`).test(a)) return [{ family: 'ltc', label: 'Litecoin' }];
  if (new RegExp(`^D[5-9A-HJ-NP-U][${B58}]{32}$`).test(a)) return [{ family: 'doge', label: 'Dogecoin' }];
  if (new RegExp(`^T[${B58}]{33}$`).test(a)) return [{ family: 'trx', label: 'Tron' }];
  if (new RegExp(`^r[${B58}]{24,34}$`).test(a)) return [{ family: 'xrp', label: 'XRP Ledger' }];
  if (/^G[A-Z2-7]{55}$/.test(a)) return [{ family: 'xlm', label: 'Stellar' }];
  if (/^(EQ|UQ|Ef|Uf|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(a) || /^-?[01]:[0-9a-fA-F]{64}$/.test(a)) return [{ family: 'ton', label: 'TON' }];
  if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|tg)$/.test(a) || /^[0-9a-f]{64}$/.test(a)) return [{ family: 'near', label: 'NEAR' }];
  const bech = new RegExp(`^([a-z]+)1[${BECH}]{38,58}$`).exec(a);
  if (bech) {
    const c = COSMOS.find((x) => x.prefix === bech[1]);
    if (c) return [{ family: 'cosmos', label: c.label }];
  }
  if (new RegExp(`^[${B58}]{32,44}$`).test(a)) return [{ family: 'sol', label: 'Solana' }];
  return [];
}

/** The chain an added (non-EVM) address shows under. */
export function chainOf(w: Watched): ChainInfo {
  if (w.family === 'evm') return { key: 'EVM', label: 'EVM chains', icon: 'ETH' };
  if (w.family === 'cosmos') {
    const p = /^([a-z]+)1/.exec(w.address)?.[1];
    return COSMOS.find((c) => c.prefix === p) ?? { key: 'COSMOS', label: 'Cosmos', icon: 'ATOM' };
  }
  return NATIVE[w.family];
}

// --- holdings ----------------------------------------------------------------------------------------------------

export type PriceSource = 'LI.FI' | 'SoDEX' | 'Hyperliquid' | 'TON API';

export interface ChainHolding {
  chain: string;
  chainLabel: string;
  chainIcon: string;
  /** The address it was read for (an added address, or the wallet). */
  owner: string;
  symbol: string;
  name: string;
  /** Contract, mint, denom or coin type; '' for the native coin. */
  token: string;
  amount: number;
  /** null when no source prices it (then it is not counted). */
  price: number | null;
  priceSource: PriceSource | null;
  usd: number | null;
  /** The source vouches for the token. Unverified tokens are hidden and never counted. */
  verified: boolean;
}

/** An amount in base units (a decimal string, often past 2^53) as a number. */
export function units(raw: string | number | null | undefined, decimals: number): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n / 10 ** decimals : 0;
  }
  if (decimals <= 0) return Number(s);
  const whole = s.length > decimals ? s.slice(0, s.length - decimals) : '0';
  const frac = s.length > decimals ? s.slice(s.length - decimals) : s.padStart(decimals, '0');
  return Number(`${whole}.${frac.slice(0, 18)}`);
}

type Base = Omit<ChainHolding, 'price' | 'priceSource' | 'usd'>;
const native = (c: ChainInfo & { symbol: string; decimals: number }, owner: string, raw: string | number): Base => ({
  chain: c.key, chainLabel: c.label, chainIcon: c.icon, owner, symbol: c.symbol, name: c.label, token: '', amount: units(raw, c.decimals), verified: true,
});

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return (await r.json()) as T;
}
const post = <T>(url: string, body: unknown) => json<T>(url, { method: 'POST', body: JSON.stringify(body) });

interface LifiToken { address?: string; symbol?: string; name?: string; decimals?: number; amount?: string; priceUSD?: string | null; verificationStatus?: string }

/** LI.FI's answer as holdings: every chain, each token once (Celo lists its native coin twice), priced by LI.FI. */
export function parseLifi(owner: string, body: { balances?: Record<string, LifiToken[]> }): ChainHolding[] {
  const out: ChainHolding[] = [];
  for (const [id, toks] of Object.entries(body.balances ?? {})) {
    const c = evmChain(Number(id));
    const seen = new Set<string>();
    for (const t of toks ?? []) {
      const amount = units(t.amount, Number(t.decimals ?? 18));
      const token = (t.address ?? '').toLowerCase();
      const symbol = String(t.symbol ?? '').trim();
      if (!(amount > 0) || !symbol || seen.has(`${token}|${symbol}`)) continue;
      seen.add(`${token}|${symbol}`);
      const p = Number(t.priceUSD);
      const price = Number.isFinite(p) && p > 0 ? p : null;
      out.push({
        chain: c.key, chainLabel: c.label, chainIcon: c.icon, owner, symbol, name: String(t.name ?? symbol), token: /^0x0{40}$/.test(token) ? '' : token, amount,
        price, priceSource: price === null ? null : 'LI.FI', usd: price === null ? null : amount * price, verified: t.verificationStatus === 'verified',
      });
    }
  }
  return out;
}

const VALUECHAIN_EXPLORER = 'https://main-scan.valuechain.xyz';

/** ValueChain: SOSO and every token, from its explorer (two requests). Priced later, by SoDEX's prices. */
async function readValueChain(owner: string): Promise<Base[]> {
  const [addr, toks] = await Promise.all([
    json<{ coin_balance?: string | null }>(`${VALUECHAIN_EXPLORER}/api/v2/addresses/${owner}`).catch(() => null),
    json<unknown>(`${VALUECHAIN_EXPLORER}/api/v2/addresses/${owner}/token-balances`),
  ]);
  const list = (Array.isArray(toks) ? toks : ((toks as { items?: unknown[] })?.items ?? [])) as Array<{ value?: string; token?: { address_hash?: string; address?: string; symbol?: string; name?: string; decimals?: string; type?: string } }>;
  const out: Base[] = [];
  const soso = units(addr?.coin_balance ?? '0', 18);
  if (soso > 0) out.push({ chain: VALUECHAIN.key, chainLabel: VALUECHAIN.label, chainIcon: VALUECHAIN.icon, owner, symbol: 'SOSO', name: 'SOSO', token: '', amount: soso, verified: true });
  for (const b of list) {
    const t = b.token;
    if (!t || (t.type && t.type !== 'ERC-20')) continue;
    const amount = units(b.value, Number(t.decimals ?? 18));
    if (!(amount > 0) || !t.symbol) continue;
    out.push({ chain: VALUECHAIN.key, chainLabel: VALUECHAIN.label, chainIcon: VALUECHAIN.icon, owner, symbol: t.symbol, name: t.name ?? t.symbol, token: String(t.address_hash ?? t.address ?? '').toLowerCase(), amount, verified: true });
  }
  return out;
}

/** Solana mints we can name (others are listed as unverified). */
const SPL: Record<string, { symbol: string; name: string }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether USD' },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: 'JUP', name: 'Jupiter' },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: 'BONK', name: 'Bonk' },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: 'WIF', name: 'dogwifhat' },
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: { symbol: 'PYTH', name: 'Pyth Network' },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: { symbol: 'JTO', name: 'Jito' },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY', name: 'Raydium' },
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: { symbol: 'RENDER', name: 'Render' },
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux: { symbol: 'HNT', name: 'Helium' },
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ': { symbol: 'W', name: 'Wormhole' },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: 'JITOSOL', name: 'Jito Staked SOL' },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'MSOL', name: 'Marinade staked SOL' },
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN': { symbol: 'TRUMP', name: 'Official Trump' },
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', name: 'PayPal USD' },
};

const SOLANA_RPC = 'https://solana-rpc.publicnode.com';

/** SOL, then the token accounts: two requests, so an address with thousands of token accounts still shows its SOL. */
async function readSolana(owner: string): Promise<Base[]> {
  const prog = (id: string) => ({ jsonrpc: '2.0', id, method: 'getTokenAccountsByOwner', params: [owner, { programId: id }, { encoding: 'jsonParsed' }] });
  const balance = await post<{ result?: { value?: number }; error?: { message?: string } }>(SOLANA_RPC, { jsonrpc: '2.0', id: 'bal', method: 'getBalance', params: [owner] });
  if (balance.error) throw new Error(balance.error.message ?? 'solana');
  const res = await post<Array<{ id: string | number; result?: { value?: unknown } }>>(SOLANA_RPC, [
    prog('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    prog('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  ]).catch(() => []);
  const sol = NATIVE.sol;
  const out: Base[] = [];
  const bal = balance.result?.value;
  if (typeof bal === 'number' && bal > 0) out.push(native(sol, owner, bal));
  const byMint = new Map<string, number>();
  for (const r of Array.isArray(res) ? res : []) {
    if (!Array.isArray(r.result?.value)) continue;
    for (const acc of r.result!.value as Array<{ account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null; uiAmountString?: string } } } } } }>) {
      const info = acc.account?.data?.parsed?.info;
      const amt = Number(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount ?? 0);
      if (info?.mint && amt > 0) byMint.set(info.mint, (byMint.get(info.mint) ?? 0) + amt);
    }
  }
  for (const [mint, amount] of byMint) {
    const known = SPL[mint];
    out.push({ chain: sol.key, chainLabel: sol.label, chainIcon: sol.icon, owner, symbol: known?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`, name: known?.name ?? 'Unknown token', token: mint, amount, verified: !!known });
  }
  return out;
}

/** TRC-20 contracts we can name. */
const TRC20: Record<string, { symbol: string; decimals: number }> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: { symbol: 'USDT', decimals: 6 },
  TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: { symbol: 'USDC', decimals: 6 },
  TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: { symbol: 'JST', decimals: 18 },
  TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S: { symbol: 'SUN', decimals: 18 },
  TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn: { symbol: 'USDD', decimals: 18 },
};

async function readTron(owner: string): Promise<Base[]> {
  const j = await json<{ data?: Array<{ balance?: number; trc20?: Array<Record<string, string>> }> }>(`https://api.trongrid.io/v1/accounts/${owner}`);
  const acc = j.data?.[0];
  const trx = NATIVE.trx;
  const out: Base[] = [];
  if (acc?.balance) out.push(native(trx, owner, acc.balance));
  for (const row of acc?.trc20 ?? []) {
    for (const [contract, raw] of Object.entries(row)) {
      const known = TRC20[contract];
      const amount = units(raw, known?.decimals ?? 6);
      if (amount > 0) out.push({ chain: trx.key, chainLabel: trx.label, chainIcon: trx.icon, owner, symbol: known?.symbol ?? `${contract.slice(0, 4)}…${contract.slice(-4)}`, name: known?.symbol ?? 'Unknown token', token: contract, amount, verified: !!known });
    }
  }
  return out;
}

/** TON and its jettons. Jettons carry TON API's price and whitelist flag, so they are returned already priced. */
async function readTon(owner: string): Promise<{ base: Base[]; priced: ChainHolding[] }> {
  const ton = NATIVE.ton;
  const [w, j] = await Promise.all([
    json<{ balance?: string }>(`https://toncenter.com/api/v3/walletInformation?address=${encodeURIComponent(owner)}&use_v2=false`),
    json<{ balances?: Array<{ balance?: string; price?: { prices?: { USD?: number } }; jetton?: { address?: string; symbol?: string; name?: string; decimals?: number; verification?: string } }> }>(`https://tonapi.io/v2/accounts/${encodeURIComponent(owner)}/jettons?currencies=usd`).catch(() => ({ balances: [] })),
  ]);
  const base: Base[] = [];
  if (w.balance && w.balance !== '0') base.push(native(ton, owner, w.balance));
  const priced: ChainHolding[] = [];
  for (const b of j.balances ?? []) {
    const jt = b.jetton;
    const amount = units(b.balance, Number(jt?.decimals ?? 9));
    if (!jt?.symbol || !(amount > 0)) continue;
    const p = Number(b.price?.prices?.USD);
    const price = Number.isFinite(p) && p > 0 ? p : null;
    priced.push({ chain: ton.key, chainLabel: ton.label, chainIcon: ton.icon, owner, symbol: jt.symbol, name: jt.name ?? jt.symbol, token: jt.address ?? '', amount, price, priceSource: price === null ? null : 'TON API', usd: price === null ? null : amount * price, verified: jt.verification === 'whitelist' });
  }
  return { base, priced };
}

/** Sui coin types we can name, with their decimals. */
const SUI_COINS: Record<string, { symbol: string; decimals: number }> = {
  '0x2::sui::SUI': { symbol: 'SUI', decimals: 9 },
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': { symbol: 'USDC', decimals: 6 },
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': { symbol: 'USDT', decimals: 6 },
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL': { symbol: 'WAL', decimals: 9 },
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': { symbol: 'DEEP', decimals: 6 },
};
/** 0x000…02::sui::SUI and 0x2::sui::SUI are the same type. */
const suiType = (t: string) => t.replace(/^0x0*([0-9a-f]+)::/i, (_m, h: string) => `0x${h}::`);

async function readSui(owner: string): Promise<Base[]> {
  const j = await post<{ data?: { address?: { balances?: { nodes?: Array<{ coinType?: { repr?: string }; totalBalance?: string }> } } } }>('https://graphql.mainnet.sui.io/graphql', {
    query: `{ address(address: "${owner}") { balances(first: 50) { nodes { coinType { repr } totalBalance } } } }`,
  });
  const sui = NATIVE.sui;
  const out: Base[] = [];
  for (const n of j.data?.address?.balances?.nodes ?? []) {
    const type = suiType(n.coinType?.repr ?? '');
    const known = SUI_COINS[type];
    const amount = units(n.totalBalance, known?.decimals ?? 9);
    if (!(amount > 0)) continue;
    const sym = known?.symbol ?? (type.split('::').pop() ?? '?').toUpperCase();
    out.push({ chain: sui.key, chainLabel: sui.label, chainIcon: sui.icon, owner, symbol: sym, name: sym, token: type === '0x2::sui::SUI' ? '' : type, amount, verified: !!known });
  }
  return out;
}

async function readCosmos(owner: string): Promise<Base[]> {
  const p = /^([a-z]+)1/.exec(owner)?.[1];
  const c = COSMOS.find((x) => x.prefix === p);
  if (!c) return [];
  const j = await json<{ balances?: Array<{ denom?: string; amount?: string }> }>(`https://rest.cosmos.directory/${c.dir}/cosmos/bank/v1beta1/balances/${owner}?pagination.limit=200`);
  const out: Base[] = [];
  for (const b of j.balances ?? []) {
    const ours = b.denom === c.denom;
    const amount = units(b.amount, ours ? c.decimals : 6);
    if (!(amount > 0)) continue;
    // Only the chain's own coin is named; IBC and factory denoms carry no symbol here, so they are left unverified.
    out.push({ chain: c.key, chainLabel: c.label, chainIcon: c.icon, owner, symbol: ours ? c.symbol : (b.denom ?? '?').split('/').pop()!.slice(0, 10).toUpperCase(), name: ours ? c.label : String(b.denom), token: ours ? '' : String(b.denom), amount, verified: ours });
  }
  return out;
}

async function readUtxo(family: 'btc' | 'ltc', owner: string): Promise<Base[]> {
  const host = family === 'btc' ? 'https://mempool.space' : 'https://litecoinspace.org';
  const j = await json<{ chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number }; mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number } }>(`${host}/api/address/${owner}`);
  const sats = (j.chain_stats?.funded_txo_sum ?? 0) - (j.chain_stats?.spent_txo_sum ?? 0) + (j.mempool_stats?.funded_txo_sum ?? 0) - (j.mempool_stats?.spent_txo_sum ?? 0);
  return sats > 0 ? [native(NATIVE[family], owner, sats)] : [];
}

async function readDoge(owner: string): Promise<Base[]> {
  const j = await json<{ final_balance?: number }>(`https://api.blockcypher.com/v1/doge/main/addrs/${owner}/balance`);
  return j.final_balance ? [native(NATIVE.doge, owner, j.final_balance)] : [];
}

async function readAptos(owner: string): Promise<Base[]> {
  const v = await json<number | string>(`https://api.mainnet.aptoslabs.com/v1/accounts/${owner}/balance/0x1::aptos_coin::AptosCoin`);
  return Number(v) > 0 ? [native(NATIVE.apt, owner, String(v))] : [];
}

async function readXrp(owner: string): Promise<Base[]> {
  const j = await post<{ result?: { account_data?: { Balance?: string } } }>('https://xrplcluster.com', { method: 'account_info', params: [{ account: owner, ledger_index: 'validated' }] });
  const b = j.result?.account_data?.Balance;
  return b && b !== '0' ? [native(NATIVE.xrp, owner, b)] : [];
}

async function readStellar(owner: string): Promise<Base[]> {
  const j = await json<{ balances?: Array<{ balance?: string; asset_type?: string; asset_code?: string; asset_issuer?: string }> }>(`https://horizon.stellar.org/accounts/${owner}`);
  const x = NATIVE.xlm;
  const out: Base[] = [];
  for (const b of j.balances ?? []) {
    const amount = Number(b.balance);
    if (!(amount > 0)) continue;
    if (b.asset_type === 'native') out.push({ ...native(x, owner, 0), amount });
    // Stellar assets are named by their issuer; only the coin itself is vouched for here.
    else out.push({ chain: x.key, chainLabel: x.label, chainIcon: x.icon, owner, symbol: b.asset_code ?? '?', name: b.asset_code ?? '?', token: `${b.asset_code}:${b.asset_issuer}`, amount, verified: false });
  }
  return out;
}

async function readNear(owner: string): Promise<Base[]> {
  const j = await post<{ result?: { amount?: string } }>('https://free.rpc.fastnear.com', { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: owner } });
  const a = j.result?.amount;
  return a && a !== '0' ? [native(NATIVE.near, owner, a)] : [];
}

// --- prices for what the readers leave unpriced ------------------------------------------------------------------

let hlMids: { at: number; map: Promise<Map<string, number>> } | null = null;
/** Hyperliquid's mid for every coin it lists (one request, a minute's cache). */
export function hyperliquidMids(): Promise<Map<string, number>> {
  if (hlMids && Date.now() - hlMids.at < 60_000) return hlMids.map;
  const map = post<Record<string, string>>(HL_INFO_URL, { type: 'allMids' }).then((j) => {
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(j)) {
      const p = Number(v);
      if (!k.startsWith('@') && Number.isFinite(p) && p > 0) m.set(k.toUpperCase(), p);
    }
    return m;
  });
  hlMids = { at: Date.now(), map };
  map.catch(() => { if (hlMids?.map === map) hlMids = null; });
  return map;
}

/** SoDEX's price, then Hyperliquid's mid, by symbol: only for ValueChain tokens and the other chains' own coins. */
export function priceBase(rows: Base[], sodex: Map<string, number> | null, hl: Map<string, number> | null): ChainHolding[] {
  return rows.map((r) => {
    if (!r.verified) return { ...r, price: null, priceSource: null, usd: null };
    const s = sodex ? priceOf(sodex, r.symbol) : undefined;
    const h = s === undefined ? hl?.get(r.symbol.toUpperCase()) : undefined;
    const price = s ?? h ?? null;
    return { ...r, price, priceSource: s !== undefined ? 'SoDEX' : h !== undefined ? 'Hyperliquid' : null, usd: price === null ? null : r.amount * price };
  });
}

async function priced(rows: Base[]): Promise<ChainHolding[]> {
  if (!rows.length) return [];
  const [s, h] = await Promise.all([coinPrices().catch(() => null), hyperliquidMids().catch(() => null)]);
  return priceBase(rows, s, h);
}

// --- one read, per source ----------------------------------------------------------------------------------------

/** One source's part of the tab: its rows, or why it has none. */
export interface SourceRead {
  id: string;
  label: string;
  owner: string;
  status: 'loading' | 'ok' | 'failed';
  rows: ChainHolding[];
  error?: string;
}

function sources(w: Watched): Array<{ id: string; label: string; run: () => Promise<ChainHolding[]> }> {
  const a = w.address.trim();
  const base = (f: () => Promise<Base[]>) => () => f().then(priced);
  switch (w.family) {
    case 'evm':
      return [
        { id: `vc:${a.toLowerCase()}`, label: 'ValueChain', run: base(() => readValueChain(a)) },
        { id: `lifi:${a.toLowerCase()}`, label: 'EVM chains', run: () => json<{ balances?: Record<string, LifiToken[]> }>(`https://li.quest/v1/wallets/${a}/balances?extended=true`).then((j) => parseLifi(a, j)) },
      ];
    case 'btc': case 'ltc': return [{ id: `${w.family}:${a}`, label: chainOf(w).label, run: base(() => readUtxo(w.family as 'btc' | 'ltc', a)) }];
    case 'doge': return [{ id: `doge:${a}`, label: 'Dogecoin', run: base(() => readDoge(a)) }];
    case 'sol': return [{ id: `sol:${a}`, label: 'Solana', run: base(() => readSolana(a)) }];
    case 'trx': return [{ id: `trx:${a}`, label: 'Tron', run: base(() => readTron(a)) }];
    case 'ton': return [{ id: `ton:${a}`, label: 'TON', run: () => readTon(a).then(async (x) => [...(await priced(x.base)), ...x.priced]) }];
    case 'sui': return [{ id: `sui:${a.toLowerCase()}`, label: 'Sui', run: base(() => readSui(a)) }];
    case 'apt': return [{ id: `apt:${a.toLowerCase()}`, label: 'Aptos', run: base(() => readAptos(a)) }];
    case 'cosmos': return [{ id: `cosmos:${a}`, label: chainOf(w).label, run: base(() => readCosmos(a)) }];
    case 'xrp': return [{ id: `xrp:${a}`, label: 'XRP Ledger', run: base(() => readXrp(a)) }];
    case 'xlm': return [{ id: `xlm:${a}`, label: 'Stellar', run: base(() => readStellar(a)) }];
    case 'near': return [{ id: `near:${a}`, label: 'NEAR', run: base(() => readNear(a)) }];
  }
}

const TTL_MS = 60_000;
const reads = new Map<string, { at: number; read: SourceRead }>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach((f) => f()); };

export function subscribeChains(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
export const chainsVersion = (): number => version;

/** Start (or refresh, past the TTL) every source of these addresses. The last answer stays on screen meanwhile. */
export function refreshChains(list: readonly Watched[], force = false): void {
  for (const w of list) {
    for (const s of sources(w)) {
      const had = reads.get(s.id);
      if (had && !force && (had.read.status === 'loading' || Date.now() - had.at < TTL_MS)) continue;
      reads.set(s.id, { at: Date.now(), read: had?.read.status === 'ok' ? { ...had.read } : { id: s.id, label: s.label, owner: w.address, status: 'loading', rows: [] } });
      if (!had) emit();
      s.run()
        .then((rows) => { reads.set(s.id, { at: Date.now(), read: { id: s.id, label: s.label, owner: w.address, status: 'ok', rows } }); })
        .catch((e: unknown) => {
          // A failed source keeps its last rows (if any); otherwise it is named as failed, never shown as 0.
          const prev = reads.get(s.id)?.read;
          reads.set(s.id, { at: Date.now() - TTL_MS + 15_000, read: prev?.status === 'ok' ? prev : { id: s.id, label: s.label, owner: w.address, status: 'failed', rows: [], error: e instanceof Error ? e.message : String(e) } });
        })
        .finally(emit);
    }
  }
}

/** What is known for these addresses, source by source. */
export function chainReads(list: readonly Watched[]): SourceRead[] {
  const out: SourceRead[] = [];
  for (const w of list) for (const s of sources(w)) {
    const r = reads.get(s.id);
    out.push(r ? r.read : { id: s.id, label: s.label, owner: w.address, status: 'loading', rows: [] });
  }
  return out;
}

// --- NFTs --------------------------------------------------------------------------------------------------------

export interface Nft {
  chain: string;
  chainLabel: string;
  chainIcon: string;
  contract: string;
  collection: string;
  id: string;
  name: string;
  /** A small picture when the explorer made one, else the original. null when the token has none. */
  image: string | null;
  standard: string;
  /** ERC-1155: how many of it. */
  count: number;
  link: string;
}

/** EVM chains whose Blockscout answers a browser (checked 2026-11-27); ValueChain first. */
export const NFT_CHAINS: ReadonlyArray<ChainInfo & { host: string }> = [
  { ...VALUECHAIN, host: VALUECHAIN_EXPLORER },
  { ...evmChain(1), host: 'https://eth.blockscout.com' },
  { ...evmChain(10), host: 'https://explorer.optimism.io' },
  { ...evmChain(324), host: 'https://zksync.blockscout.com' },
  { ...evmChain(130), host: 'https://unichain.blockscout.com' },
  { ...evmChain(480), host: 'https://worldchain-mainnet.explorer.alchemy.com' },
  { ...evmChain(1868), host: 'https://soneium.blockscout.com' },
  { ...evmChain(57073), host: 'https://explorer.inkonchain.com' },
  { ...evmChain(42220), host: 'https://celo.blockscout.com' },
  { ...evmChain(34443), host: 'https://explorer.mode.network' },
  { ...evmChain(1135), host: 'https://blockscout.lisk.com' },
  { key: 'ROOTSTOCK', label: 'Rootstock', icon: 'RBTC', host: 'https://rootstock.blockscout.com' },
];

interface RawNft {
  id?: string; image_url?: string | null; media_url?: string | null; media_type?: string | null; value?: string; token_type?: string;
  thumbnails?: Record<string, string> | null; metadata?: { name?: string; image?: string } | null;
  token?: { address_hash?: string; name?: string | null; symbol?: string | null; type?: string; reputation?: string | null } | null;
}

/** The one IPFS gateway pictures load through (ValueChain's NFTs already point at it). */
const IPFS_GATEWAY = 'https://ipfs.filebase.io/ipfs/';
const CID = '(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})';

/**
 * A picture from the only two places the page loads them from (index.html img-src): Blockscout's image cache, and
 * IPFS through one gateway (ipfs://, a /ipfs/ path or a CID subdomain on any gateway is rewritten to it). A picture
 * stored anywhere else is not loaded: that server would learn the viewer's IP address and what they own.
 */
export function nftPicture(n: Pick<RawNft, 'thumbnails' | 'image_url' | 'media_url' | 'media_type' | 'metadata'>): string | null {
  for (const t of [n.thumbnails?.['250x250'], n.thumbnails?.['500x500']]) if (t && t.startsWith('https://nft-prod.blockscout.com/')) return t;
  const cands = [n.image_url, n.media_type && !n.media_type.startsWith('image') ? null : n.media_url, n.metadata?.image];
  for (const c of cands) {
    if (!c) continue;
    const m = new RegExp(`^ipfs://(?:ipfs/)?${CID}(/[^?#]*)?`).exec(c)
      ?? new RegExp(`^https?://[^/]+/ipfs/${CID}(/[^?#]*)?`).exec(c)
      ?? new RegExp(`^https?://${CID}\\.ipfs\\.[^/]+(/[^?#]*)?`).exec(c);
    if (m) return `${IPFS_GATEWAY}${m[1]}${m[2] && m[2] !== '/' ? m[2] : ''}`;
  }
  return null;
}
const picture = nftPicture;

export function parseNfts(chain: ChainInfo & { host: string }, body: { items?: RawNft[] }): Nft[] {
  const out: Nft[] = [];
  for (const n of body.items ?? []) {
    const t = n.token;
    if (!t?.address_hash || t.reputation === 'scam') continue;
    const id = String(n.id ?? '');
    const collection = t.name || t.symbol || `${t.address_hash.slice(0, 6)}…${t.address_hash.slice(-4)}`;
    out.push({
      chain: chain.key, chainLabel: chain.label, chainIcon: chain.icon, contract: t.address_hash, collection, id,
      name: n.metadata?.name || `${collection} #${id.length > 10 ? `${id.slice(0, 6)}…` : id}`,
      image: picture(n), standard: n.token_type ?? t.type ?? 'ERC-721', count: Math.max(1, Number(n.value) || 1),
      link: `${chain.host}/token/${t.address_hash}/instance/${id}`,
    });
  }
  return out;
}

const nftCache = new Map<string, { at: number; p: Promise<Nft[]> }>();
/** One chain's NFTs of one address (the explorer's first page: 50), cached for five minutes. */
export function readNfts(chainKey: string, owner: string): Promise<Nft[]> {
  const c = NFT_CHAINS.find((x) => x.key === chainKey);
  if (!c) return Promise.resolve([]);
  const k = `${chainKey}:${owner.toLowerCase()}`;
  const had = nftCache.get(k);
  if (had && Date.now() - had.at < 300_000) return had.p;
  const p = json<{ items?: RawNft[] }>(`${c.host}/api/v2/addresses/${owner}/nft?type=ERC-721%2CERC-1155`).then((j) => parseNfts(c, j));
  nftCache.set(k, { at: Date.now(), p });
  p.catch(() => nftCache.delete(k));
  return p;
}
