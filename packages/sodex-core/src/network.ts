/**
 * Network constants: SoDEX chain ids, gateway hosts, engine paths and domains.
 *
 * Everything here is data. Nothing in this package opens a connection: callers
 * fetch the requests `signAndBuild` assembles, through the '/sodex' relay (the
 * Vite dev proxy rewrites '/sodex/api/v1/...' to https://mainnet-gw.sodex.dev/api/v1/...).
 */

export type Network = 'mainnet' | 'testnet';

/** SoDEX trading engines. Spot is "Spark", perps is "Bolt" in SDK prose. */
export type Engine = 'spot' | 'perps';

export const ENGINES: readonly Engine[] = ['spot', 'perps'];

/**
 * SoDEX network ids. Used as the EIP-712 domain chainId for exchange actions
 * (0x01), as the `X-API-Chain` header on signed trading writes, and as the
 * MESSAGE-level `chainID` of universal actions (0x02) - whose DOMAIN chainId is
 * the wallet's chain instead. See userSigned.ts.
 */
export const SODEX_CHAIN_ID: Readonly<Record<Network, number>> = {
  mainnet: 286623,
  testnet: 138565,
};

/** Direct gateway origins. The browser reaches them through the relay. */
export const GATEWAY_ORIGIN: Readonly<Record<Network, string>> = {
  mainnet: 'https://mainnet-gw.sodex.dev',
  testnet: 'https://testnet-gw.sodex.dev',
};

/** WebSocket origins (`/ws/{engine}` is appended). */
export const GATEWAY_WS_ORIGIN: Readonly<Record<Network, string>> = {
  mainnet: 'wss://mainnet-gw.sodex.dev',
  testnet: 'wss://testnet-gw.sodex.dev',
};

/** The same-origin relay prefix the web app fetches through ('/sodex/api/v1/...'). */
export const DEFAULT_RELAY_BASE = '/sodex';

export const enginePath = (engine: Engine): string => `/api/v1/${engine}`;
export const userPath = (userAddress: string): string => `/api/v1/user/${userAddress}`;
export const wsPath = (engine: Engine): string => `/ws/${engine}`;

/** types.SpotDomainName / PerpsDomainName / UniversalDomainName (Go SDK common/types/eip712.go). */
export const DomainName = { spot: 'spot', perps: 'futures', universal: 'universal' } as const;
export type DomainNameValue = (typeof DomainName)[keyof typeof DomainName];

/** The EIP-712 domain NAME for an engine's exchange actions: 'spot' or 'futures' (NOT 'perps'). */
export const engineDomainName = (engine: Engine): 'spot' | 'futures' =>
  engine === 'spot' ? DomainName.spot : DomainName.perps;

/** The network a SoDEX chain id belongs to, or null for anything else. */
export function networkForChainId(chainId: number): Network | null {
  if (chainId === SODEX_CHAIN_ID.mainnet) return 'mainnet';
  if (chainId === SODEX_CHAIN_ID.testnet) return 'testnet';
  return null;
}

/** Throws unless `chainId` is one of the two SoDEX network ids. */
export function assertSodexChainId(chainId: number): number {
  if (networkForChainId(chainId) === null) {
    throw new RangeError(
      `not a SoDEX chain id: ${chainId} (mainnet ${SODEX_CHAIN_ID.mainnet}, testnet ${SODEX_CHAIN_ID.testnet})`,
    );
  }
  return chainId;
}
