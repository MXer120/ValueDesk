/**
 * Cross-chain deposit addresses, built and cross-checked in this browser.
 *
 * What GET /api/mirror/deposit-options answered, with the SAME assembly and
 * the same safety rules (apps/server/src/sodex/depositOptions.ts and
 * depositAddressCore.ts, imported through `@sign`): the address shown is the
 * chain's current one only when the per-coin registry lists it and SoDEX's
 * issuer names the same one. The sources are all public and answer any origin -
 * sodex.com's own API (config, issuer) and two `view` functions on ValueChain
 * (the mirror and deposit-wallet registries) - so no wallet's deposit addresses
 * pass through Valuescan, and the reads cost the user's own IP.
 *
 * The on-chain reads are batched: a deposit sheet asks about ~25 chain/coin
 * pairs at once, and they go to the ValueChain RPC as a handful of JSON-RPC
 * batches instead of 25 requests.
 */
import {
  DepositAddressRequestError,
  buildDepositOptions,
  issuedAddressesReader,
  newDepositAddressRequester,
  sodexConfigReader,
  type DepositOptions,
} from '@sign/sodex/depositOptions.js';
import { MIRROR_REGISTRY, mirrorReads } from '@sign/sodex/mirrorCore.js';
import { depositWalletReads } from '@sign/sodex/depositWalletsCore.js';
import { issuerReads } from '@sign/sodex/depositAddressCore.js';
import { CHAINS } from '@sign/sodex/chainParams.js';
import { rpcBatch } from '../trading/rpc';
import { BIZ_ORIGIN, network } from './hosts';

export { DepositAddressRequestError, type DepositOptions };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const rpcUrl = (): string => CHAINS[network()].rpcUrl;

// --- eth_call, batched per tick ----------------------------------------------------------------

const BATCH_WINDOW_MS = 10;
const BATCH_MAX = 40;
let pending: Array<{ to: string; data: string; resolve: (v: string) => void; reject: (e: Error) => void }> = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  flushTimer = undefined;
  const batch = pending.splice(0, BATCH_MAX);
  if (pending.length) flushTimer = setTimeout(flush, 0);
  if (!batch.length) return;
  rpcBatch(rpcUrl(), batch.map((c) => ({ method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] })))
    .then((answers) => {
      batch.forEach((c, i) => {
        const r = answers.get(i);
        if (typeof r === 'string' && /^0x[0-9a-fA-F]*$/.test(r)) c.resolve(r);
        else c.reject(new Error('ValueChain did not answer the registry read'));
      });
    })
    .catch((e: unknown) => {
      for (const c of batch) c.reject(e instanceof Error ? e : new Error(String(e)));
    });
}

/** One eth_call on ValueChain, joined with every other call made in the same few ms. */
function ethCall(to: string, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    pending.push({ to, data, resolve, reject });
    if (pending.length >= BATCH_MAX) {
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flush();
    } else if (flushTimer === undefined) {
      flushTimer = setTimeout(flush, BATCH_WINDOW_MS);
    }
  });
}

// --- sodex.com's API ---------------------------------------------------------------------------

async function bizFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(BIZ_ORIGIN + path, { ...init, signal: ctl.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } finally {
    clearTimeout(timer);
  }
}

async function bizPost(path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await bizFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }, timeoutMs);
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function bizGet(path: string, timeoutMs: number): Promise<unknown> {
  const res = await bizFetch(path, { headers: { Accept: 'application/json' } }, timeoutMs);
  if (!res.ok) throw new Error(`SoDEX config unavailable (HTTP ${res.status})`);
  return res.json();
}

// --- the shared readers, bound to this browser ------------------------------------------------

const mirror = mirrorReads(ethCall);
const lists = depositWalletReads(ethCall);
const issuer = issuerReads(mirror.getDepositWallet, bizPost);
const config = sodexConfigReader(bizGet);
const issued = issuedAddressesReader(async (path, body, ms) => (await bizPost(path, body, ms)).body);

const forget = (account: string): void => {
  issuer.forgetDepositReads(account);
  issued.forget(account);
  lists.forgetLists(account);
};

export const deposits = {
  /** Everything the Deposit sheet offers for this wallet, already cross-checked. */
  options(address: string): Promise<DepositOptions> {
    if (!ADDRESS_RE.test(address)) return Promise.reject(new DepositAddressRequestError('a valid 0x wallet address is required', 400));
    return buildDepositOptions(
      {
        sodexConfig: config,
        issuedAddresses: (a) => issued.read(a),
        remoteNativeTokens: () => mirror.remoteNativeTokens(),
        currentDepositWallet: (a, c) => issuer.currentDepositWallet(a, c),
        issuerDepositStatus: (a, c) => issuer.issuerDepositStatus(a, c),
        depositWalletLists: (a, coin) => lists.depositWalletLists(a, coin),
        registryInfo: () => ({ address: MIRROR_REGISTRY, chainId: CHAINS[network()].chainId }),
        requestDepositAddress: (a, c) => issuer.requestDepositAddress(a, c),
      },
      address,
    );
  },

  /** sodex.com's "Confirm & Update Address" - only for an address SoDEX flagged. */
  replace: newDepositAddressRequester({
    issuerDepositStatus: (a, c) => issuer.issuerDepositStatus(a, c),
    replaceDepositAddress: (a, c) => issuer.replaceDepositAddress(a, c),
    forget,
  }),
};
