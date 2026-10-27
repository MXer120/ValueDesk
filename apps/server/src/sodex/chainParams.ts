/**
 * ValueChain - the chain SoDEX custodies deposits on - per network. Pure data,
 * shared by the server (sodex/chain.ts) and the browser (which adds the chain
 * to the user's wallet and reads balances from its RPC itself).
 */
import { envOf } from '../valuedesk/env.js';

export type ChainNetwork = 'mainnet' | 'testnet';

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  /** Blockscout API root, when one exists for this network. */
  explorerApi: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** The SoDEX exchange contract that custodies deposits. */
  exchange: string;
}

export const CHAINS: Record<ChainNetwork, ChainConfig> = {
  mainnet: {
    chainId: 286623,
    name: 'ValueChain',
    rpcUrl: envOf('VALUECHAIN_RPC')?.trim() || 'https://rpc.valuechain.xyz',
    explorerUrl: 'https://main-scan.valuechain.xyz',
    explorerApi: 'https://main-scan.valuechain.xyz/api/v2',
    nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 },
    exchange: '0x0101010101010101010101010101010101010101',
  },
  testnet: {
    chainId: 138565,
    name: 'ValueChain Testnet',
    rpcUrl: envOf('VALUECHAIN_TESTNET_RPC')?.trim() || 'https://testnet-rpc.valuechain.xyz',
    explorerUrl: null,
    // No public Blockscout instance responded for testnet; the registry falls
    // back to on-chain probing there.
    explorerApi: null,
    nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 },
    exchange: '0x0101010101010101010101010101010101010101',
  },
};
