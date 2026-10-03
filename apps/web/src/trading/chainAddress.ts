import type { AddressKind } from './addresses';

/**
 * The address each SoDEX chain pays out to (trading/addresses.ts). A chain not listed is not offered - not on the
 * Withdraw sheet, not on the Deposit sheet, and no deposit address is asked for on it.
 * TON is not: SoDEX lists TON deposits and withdrawals, but its only TON market (vTON_vUSDC) is halted -
 * a deposit could not be traded (owner's decision, 2026-10-03: "if sodex doesnt support ton we shouldnt either").
 */
export const CHAIN_ADDRESS: Record<string, AddressKind> = {
  ETH: 'evm', BASE_ETH: 'evm', ARBITRUM_ETH: 'evm', MATIC: 'evm', BSC_BNB: 'evm', AVAXC: 'evm', HYPEREVM_HYPE: 'evm', ARC: 'evm', ROBINHOOD_ETH: 'evm',
  SOL: 'solana', BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin', ADA: 'cardano', SUI: 'sui', XLM: 'stellar', XRP: 'xrp',
};

/** Does the app offer this SoDEX chain at all? */
export const offersChain = (chain: string): boolean => chain.toUpperCase() in CHAIN_ADDRESS;
