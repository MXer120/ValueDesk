/**
 * Which deposit address to show for one coin on one chain - and when to show
 * none. The rules and the issuer reads are depositAddressCore.ts (shared with
 * the browser); this binds the reads to the server's fetch and RPC.
 */
import { getDepositWallet } from './mirrorRegistry.js';
import { issuerReads, issuerStatus, pickDepositAddress, sameDepositAddress, type IssuerStatus, type Pick } from './depositAddressCore.js';

export { issuerStatus, pickDepositAddress, sameDepositAddress, type IssuerStatus, type Pick };

const BIZ_API = process.env.SODEX_BIZ_API?.trim() || 'https://alpha-biz.sodex.dev';

const reads = issuerReads(getDepositWallet, async (path, body, timeoutMs) => {
  const res = await fetch(`${BIZ_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
});

/** The chain's current deposit address for `account` (custody `getDepositWallet`). */
export const currentDepositWallet = reads.currentDepositWallet;

/** sodex.com's per-chain status read; null when SoDEX did not answer. */
export const issuerDepositStatus = reads.issuerDepositStatus;

/** Ask SoDEX for a new deposit address on `chain` (only ever when the user asks). */
export const replaceDepositAddress = reads.replaceDepositAddress;

export const forgetDepositReads = reads.forgetDepositReads;

/** Ask SoDEX to issue an address on a chain where the wallet has none (sodex.com's Deposit sheet does the same). */
export const requestDepositAddress = reads.requestDepositAddress;
