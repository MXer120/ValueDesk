/**
 * The deposit-wallet registry on ValueChain - where sodex.com itself reads a
 * wallet's deposit addresses from, for every coin but SOSO/sSOSO:
 *
 *   getDepositWalletList(address account, string coinSymbol)
 *     -> (string[] chains, string[][] wallets)       sodex.com uses wallets[i][0]
 *
 * The ABI and the reads are depositWalletsCore.ts (shared with the browser);
 * this binds them to the server's RPC. The selector and the decoding are
 * pinned by test/depositWallets.test.ts against a live answer.
 */
import { rpc } from './chain.js';
import { DEPOSIT_WALLET_REGISTRY, decodeDepositWalletList, depositWalletReads, encodeDepositWalletList } from './depositWalletsCore.js';

export { DEPOSIT_WALLET_REGISTRY, decodeDepositWalletList, encodeDepositWalletList };

const reads = depositWalletReads((to, data) => rpc<string>('eth_call', [{ to, data }, 'latest']));

/**
 * chain -> the wallet's deposit address for `coinSymbol` (the first listed,
 * as sodex.com uses it). Empty chains are left out.
 */
export const depositWallets = reads.depositWallets;

/**
 * chain -> EVERY address the registry lists for `coinSymbol` (oldest first),
 * empty lists included: an empty list means SoDEX has issued nothing for this
 * coin on that chain.
 */
export const depositWalletLists = reads.depositWalletLists;

export const _forgetDepositWalletLists = (account: string): void => reads.forgetLists(account);
