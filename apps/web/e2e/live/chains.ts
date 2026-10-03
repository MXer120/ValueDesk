/**
 * Every EVM chain the runner can read and sign on: the ones the APP sends from
 * (trading/onboard.ts EVM_CHAINS - its deposits come from these), and the
 * ones SoDEX pays out to that the app only knows by name (status-only in the
 * Withdraw sheet). For those the runner carries its own chain id and public
 * RPC, taken from each chain's official documentation (2026-10-03):
 *
 *   Arc               5042   https://rpc.mainnet.arc.io                 docs.arc.io  (native gas coin: USDC, 18 decimals)
 *   Avalanche C-Chain 43114  https://api.avax.network/ext/bc/C/rpc      build.avax.network
 *   HyperEVM          999    https://rpc.hyperliquid.xyz/evm            hyperliquid docs (HYPE, 18 decimals)
 *   Robinhood Chain   4663   https://rpc.mainnet.chain.robinhood.com    docs.robinhood.com/chain (ETH; public RPC is rate-limited)
 *
 * With them the runner can read a withdrawal's arrival there and send a
 * native-coin deposit back (evmTour.ts). The app itself does not change: it
 * still offers these chains as withdrawal destinations only.
 */
import { CANONICAL_USDC, EVM_CHAINS } from '../../src/trading/onboard';

export interface EvmSpec {
  /** SoDEX's chain key. */
  key: string;
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  native: { name: string; symbol: string; decimals: number };
  /** 'app': the app sends from it (USDC deposits); 'runner': only the runner reads and signs there. */
  source: 'app' | 'runner';
}

/** The chains the app does not send from, with what the runner needs to read and sign there. */
export const RUNNER_CHAINS: Readonly<Record<string, EvmSpec>> = {
  ARC: { key: 'ARC', chainId: 5042, name: 'Arc', rpcUrl: 'https://rpc.mainnet.arc.io', explorer: 'https://explorer.arc.io', native: { name: 'USDC', symbol: 'USDC', decimals: 18 }, source: 'runner' },
  AVAXC: { key: 'AVAXC', chainId: 43114, name: 'Avalanche C-Chain', rpcUrl: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io', native: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 }, source: 'runner' },
  HYPEREVM_HYPE: { key: 'HYPEREVM_HYPE', chainId: 999, name: 'HyperEVM', rpcUrl: 'https://rpc.hyperliquid.xyz/evm', explorer: 'https://hyperevmscan.io', native: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, source: 'runner' },
  ROBINHOOD_ETH: { key: 'ROBINHOOD_ETH', chainId: 4663, name: 'Robinhood Chain', rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com', native: { name: 'Ether', symbol: 'ETH', decimals: 18 }, source: 'runner' },
};

/** Every EVM chain the runner reads and signs on, app chains first. */
export const ALL_EVM: Readonly<Record<string, EvmSpec>> = {
  ...Object.fromEntries(Object.values(EVM_CHAINS).map((c) => [c.key, { key: c.key, chainId: c.chainId, name: c.name, rpcUrl: c.rpcUrl, explorer: c.explorer, native: c.native, source: 'app' as const }])),
  ...RUNNER_CHAINS,
};

export const evmChain = (key: string): EvmSpec | undefined => ALL_EVM[key];

/** The app sends USDC deposits from this chain (its canonical USDC and sendUsdcDeposit). */
export const appSendsUsdc = (key: string): boolean => !!EVM_CHAINS[key] && !!CANONICAL_USDC[key];

/** The order chains are listed and toured in: the app's (cheap first), then the runner's. */
export const CHAIN_ORDER: readonly string[] = ['ARBITRUM_ETH', 'BASE_ETH', 'ETH', 'ROBINHOOD_ETH', 'BSC_BNB', 'MATIC', 'ARC', 'AVAXC', 'HYPEREVM_HYPE'];

export const chainRank = (key: string): number => {
  const i = CHAIN_ORDER.indexOf(key);
  return i < 0 ? CHAIN_ORDER.length : i;
};

/**
 * Native coin to keep for gas on a chain, at least: what a transfer or two
 * cost there with a wide margin. Whatever is not spent stays in the wallet.
 */
export const GAS_FLOOR: Readonly<Record<string, number>> = {
  ARBITRUM_ETH: 0.0002,
  BASE_ETH: 0.0002,
  ETH: 0.001,
  BSC_BNB: 0.0005,
  MATIC: 0.2,
  ARC: 0.05,
  AVAXC: 0.01,
  HYPEREVM_HYPE: 0.005,
  ROBINHOOD_ETH: 0.0002,
};
