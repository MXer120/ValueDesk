/**
 * Cross-chain deposits — funding from a chain the user already holds assets on.
 *
 * SoDEX runs a custodial mirror (custodian: Cobo) that issues a dedicated
 * deposit address per wallet per chain. It works for wallets with no SoDEX
 * account and needs no gas on ValueChain, which is what lets a first-time user
 * fund without leaving the app.
 *
 * THE ASSEMBLY AND EVERY SAFETY RULE live in sodex/depositOptions.ts - the
 * current on-chain address, cross-checked against the per-coin registry and
 * SoDEX's issuer; flagged addresses withheld; PEPE never offered; only
 * whitelisted pairs with a verified address; memo/contract warnings and the
 * native-asset minimum attached. That core is what the browser runs itself
 * now (docs/ARCH-traffic.md §1.3): the web no longer calls these routes and
 * hosted mode does not serve them. They stay for the local server and answer
 * exactly what they answered before, with this process's own reads - the
 * ValueChain views through the server's RPC client (sodex/mirrorRegistry.ts,
 * depositWallets.ts, depositAddress.ts) and sodex.com's API from here.
 *
 * The registry address and ABI were recovered from ValueChain itself - see
 * sodex/mirrorRegistry.ts for how.
 */
import type { FastifyInstance } from 'fastify';
import { remoteNativeTokens, registryInfo } from '../sodex/mirrorRegistry.js';
import { _forgetDepositWalletLists, depositWalletLists } from '../sodex/depositWallets.js';
import { currentDepositWallet, forgetDepositReads, issuerDepositStatus, replaceDepositAddress, requestDepositAddress } from '../sodex/depositAddress.js';
import {
  DepositAddressRequestError,
  buildDepositOptions,
  issuedAddressesReader,
  newDepositAddressRequester,
  sodexConfigReader,
  type DepositOptionsIo,
} from '../sodex/depositOptions.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BIZ_API = process.env.SODEX_BIZ_API?.trim() || 'https://alpha-biz.sodex.dev';

/** sodex.com's deposit white list and explorers, kept ten minutes (the core's reader). */
const sodexConfig = sodexConfigReader(async (path, timeoutMs) => {
  const res = await fetch(`${BIZ_API}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`SoDEX config unavailable (HTTP ${res.status})`);
  return res.json();
});

/** The issuer's addresses for a wallet (its POST also CREATES a new wallet's); an unreadable body is null. */
const issued = issuedAddressesReader(async (path, body, timeoutMs) => {
  const res = await fetch(`${BIZ_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json().catch(() => null);
});

const io: DepositOptionsIo = {
  sodexConfig,
  issuedAddresses: (account) => issued.read(account),
  remoteNativeTokens,
  currentDepositWallet,
  issuerDepositStatus,
  depositWalletLists,
  registryInfo,
  requestDepositAddress,
};

/** Forget every cached read for a wallet: issuer rows, chain reads, registry lists. */
const forget = (account: string): void => {
  forgetDepositReads(account);
  issued.forget(account);
  _forgetDepositWalletLists(account);
};

/** "Confirm & Update Address": flagged addresses only, once per wallet and chain every 30 s. */
const requestNewDepositAddress = newDepositAddressRequester({ issuerDepositStatus, replaceDepositAddress, forget });

export async function mirrorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the deposit UI needs, already cross-checked.
   *
   * Scoped to the address the caller passes, which the UI binds to the
   * connected wallet - this never enumerates anyone else's.
   */
  app.get('/api/mirror/deposit-options', async (req, reply) => {
    const { address } = req.query as { address?: string };
    if (!address || !ADDRESS_RE.test(address)) {
      return reply.code(400).send({ error: 'a valid 0x wallet address is required' });
    }
    // Without SoDEX's config there is nothing to offer: that one failure is a
    // 502 (buildDepositOptions reads the same, now cached, config again).
    try {
      await sodexConfig();
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    return buildDepositOptions(io, address);
  });

  /**
   * sodex.com's "Confirm & Update Address": ask SoDEX for a new deposit address
   * on one chain. Only for an address SoDEX itself has flagged (read fresh) -
   * a healthy address is never replaced through here. The UI then re-reads
   * /deposit-options until the new address is confirmed on-chain.
   */
  app.post('/api/mirror/replace-deposit-address', async (req, reply) => {
    const { address, chain } = (req.body ?? {}) as { address?: string; chain?: string };
    try {
      await requestNewDepositAddress(address ?? '', chain ?? '');
    } catch (e) {
      if (e instanceof DepositAddressRequestError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
    req.log.info({ address, chain }, 'deposit address replacement requested');
    return { ok: true };
  });
}
