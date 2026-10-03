/**
 * The non-EVM chains the runner signs on itself (types.ts), by SoDEX's chain key.
 * TON is not here: SoDEX lists it but has no market for it (vTON_vUSDC is halted),
 * so the app does not offer it either.
 */
import { bitcoin, dogecoin, litecoin } from './bitcoin';
import { cardano } from './cardano';
import { solana } from './solana';
import { stellar } from './stellar';
import { sui } from './sui';
import type { ChainRoute } from '../../../src/trading/funds';
import { NATIVE_DECIMALS, TOKEN_DECIMALS, type NativeChain, type NativeCoin, type NativeKeys } from './types';
import { xrp } from './xrp';

export const NATIVE_CHAINS: readonly NativeChain[] = [bitcoin, litecoin, dogecoin, xrp, stellar, solana, sui, cardano];

/** What a run uses: the chains (real, or the simulation's fakes) and the test key's view for them. */
export interface NativeRegistry {
  chains: readonly NativeChain[];
  keys: NativeKeys;
}

export const nativeChainFor = (reg: NativeRegistry | null, chainKey: string): NativeChain | null => reg?.chains.find((c) => c.chainKey === chainKey) ?? null;

/** SoDEX's coin on a route, as the chain module sees it (null: a token the runner does not know the decimals of). */
export function nativeCoinOf(chain: NativeChain, route: ChainRoute, coinName: string): NativeCoin | null {
  if (route.isNativeToken) return { symbol: coinName, native: true, token: null, decimals: NATIVE_DECIMALS[chain.kind] };
  const decimals = TOKEN_DECIMALS[coinName.toUpperCase()];
  if (decimals === undefined || !route.tokenAddress) return null;
  return { symbol: coinName, native: false, token: route.tokenAddress, decimals };
}

/** The chain's own coin (for the fee a token send needs). */
export const nativeCoinFor = (chain: NativeChain, symbol: string): NativeCoin => ({ symbol, native: true, token: null, decimals: NATIVE_DECIMALS[chain.kind] });
