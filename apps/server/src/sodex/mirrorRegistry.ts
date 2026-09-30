/**
 * The mirror registry on ValueChain - the authoritative, on-chain source for
 * cross-chain deposits. The ABI, the decoders and the reads are mirrorCore.ts
 * (shared with the browser); this binds them to the server's RPC.
 *
 *   getDepositWallet(address account, string chain) -> string
 *   listRemoteNativeTokens() -> RemoteNativeToken[]
 */
import { CHAIN, rpc } from './chain.js';
import { MIRROR_REGISTRY, MIRROR_SELECTORS, decodeRemoteNativeTokens, mirrorReads, type RemoteNativeToken } from './mirrorCore.js';

export { MIRROR_REGISTRY, MIRROR_SELECTORS, decodeRemoteNativeTokens, type RemoteNativeToken };

const reads = mirrorReads((to, data) => rpc<string>('eth_call', [{ to, data }, 'latest']));

/** The on-chain deposit address for one wallet on one chain. */
export const getDepositWallet = reads.getDepositWallet;

export const remoteNativeTokens = reads.remoteNativeTokens;

/** Everything the registry knows about one chain. */
export const chainRules = reads.chainRules;

export const registryInfo = () => ({ address: MIRROR_REGISTRY, chainId: CHAIN.chainId });
