/**
 * What copy setup asks the follower's wallet to sign ON SODEX: the builder
 * fee ceiling the copy fee needs, and the registration (or revocation) of a
 * copy key. Same primitives as enabling trading (trading/session.ts), with
 * three differences:
 *
 *   - the key is registered on the PERPS engine only: copies are perps, so a
 *     copy key cannot trade spot or move spot funds;
 *   - the key may be one this browser never holds: an executor generated it
 *     and sent only its ADDRESS; the wallet registers that address;
 *   - its lifetime is the follower's choice up to 180 days (7 for a browser key).
 *
 * The key name is fixed per mode (vd-copy-browser / -tokyo / -self): SoDEX
 * REPLACES a key registered under an existing name, so re-approving never
 * adds a key and an account never runs into the per-account key limit.
 */
import {
  DAY_MS,
  assembleExchangeRequests,
  nonceKey,
  prepareApiKeyRegistrationExchange,
  prepareApiKeyRevocationExchange,
  type Engine,
} from '@sodex-core';
import { COPY_FEE_MAX } from '@copy-engine';
import { api } from '../api';
import { pollBuilderRates, readBuilderRates, submitBuilderApproval } from '../trading/builderApproval';
import { tradingConfig, writesOffMessage } from '../trading/config';
import { OutcomeUnknownError, readGateway, sendSigned } from '../trading/gateway';
import { nonces, sodexAccountId } from '../trading/session';
import { addOrSwitchChain, getChainId, signTypedData, type Eip1193Provider } from '../wallet';
import { logger } from '../log';

const log = logger('copy');

export const COPY_ENGINES: readonly Engine[] = ['perps'];
export const MAX_COPY_KEY_DAYS = 180;
export const MAX_BROWSER_KEY_DAYS = 7;

/** The perps builder-fee ceiling SoDEX lists for the configured builder (null: none or no builder). */
export async function copyFeeApproval(owner: string): Promise<{ builderId: number | null; perps: number | null; covers: boolean }> {
  const b = tradingConfig().builder;
  if (!b) return { builderId: null, perps: null, covers: true };
  const rates = await readBuilderRates(owner.toLowerCase(), b.id);
  return { builderId: b.id, perps: rates.perps, covers: rates.perps !== null && rates.perps >= COPY_FEE_MAX };
}

/** Approve the copy fee ceiling (one signature). Resolves once SoDEX lists it, or throws. */
export async function approveCopyFee(o: { owner: string; provider: Eip1193Provider }): Promise<void> {
  const cfg = tradingConfig();
  const b = cfg.builder;
  if (!b) return;
  const owner = o.owner.toLowerCase();
  const accountId = await sodexAccountId(owner);
  if (!accountId) throw new Error('This wallet has no SoDEX account yet. Deposit first; the first deposit opens it.');
  const maxFeeRate = Math.max(b.maxFeeRate, COPY_FEE_MAX);
  let unanswered = false;
  try {
    await submitBuilderApproval({
      owner,
      provider: o.provider,
      accountId,
      builderId: b.id,
      maxFeeRate,
      nonce: () => nonces().next(nonceKey(owner, cfg.chainId)),
    });
  } catch (e) {
    if (!(e instanceof OutcomeUnknownError)) throw e;
    unanswered = true;
  }
  const seen = await pollBuilderRates(owner, b.id, (r) => r.perps !== null && r.perps >= COPY_FEE_MAX);
  if (!seen || seen.perps === null || seen.perps < COPY_FEE_MAX) {
    throw new Error(unanswered ? 'SoDEX did not confirm the approval. Check your connection and try again.' : 'SoDEX does not list the approval yet. Try again in a moment.');
  }
  log.info('copy fee approved', { builderId: b.id, maxFeeRate });
}

interface KeyRow {
  name: string;
  publicKey: string;
  expiresAt?: number;
}

/** Whether SoDEX lists `address` under `name` on perps, unexpired. */
export async function copyKeyRegistered(owner: string, name: string, address: string, now = Date.now()): Promise<{ ok: boolean; expiresAt: number | null }> {
  const rows = await readGateway<KeyRow[] | { apiKeys?: KeyRow[] } | null>(`/api/v1/perps/accounts/${owner.toLowerCase()}/api-keys`);
  const list = Array.isArray(rows) ? rows : rows?.apiKeys ?? [];
  const row = list.find((r) => r.name === name);
  if (!row || row.publicKey.toLowerCase() !== address.toLowerCase()) return { ok: false, expiresAt: null };
  if (row.expiresAt && row.expiresAt <= now) return { ok: false, expiresAt: row.expiresAt };
  return { ok: true, expiresAt: row.expiresAt || null };
}

/**
 * Register `address` as the copy key `name` on the follower's perps account,
 * valid for `days`: ONE wallet signature, in the wallet's current chain.
 */
export async function registerCopyKey(o: { owner: string; provider: Eip1193Provider; address: string; name: string; days: number }): Promise<{ expiresAt: number; accountId: number }> {
  const cfg = tradingConfig();
  if (cfg.disabled) throw new Error('Trading is switched off in this build of ValueDesk.');
  if (!cfg.writesAllowed) throw new Error(writesOffMessage(cfg));
  const owner = o.owner.toLowerCase();
  const accountId = await sodexAccountId(owner);
  if (!accountId) throw new Error('This wallet has no SoDEX account yet. Deposit first; the first deposit opens it.');
  const days = Math.max(1, Math.min(MAX_COPY_KEY_DAYS, Math.floor(o.days)));
  const expiresAt = Date.now() + days * DAY_MS - 60_000;
  const prepared = prepareApiKeyRegistrationExchange({
    userAddress: owner,
    accountID: accountId,
    name: o.name,
    publicKey: o.address,
    expiresAt,
    nonce: await nonces().next(nonceKey(owner, cfg.chainId)),
    sodexChainId: cfg.chainId,
    signatureChainId: await getChainId(o.provider),
    engines: COPY_ENGINES,
    expiryPolicy: { maxTtlMs: MAX_COPY_KEY_DAYS * DAY_MS },
  });
  const signature = await signTypedData(o.provider, owner, prepared.typedData);
  const [req] = assembleExchangeRequests(prepared, signature, { base: '' });
  try {
    await sendSigned(req!, 'copy key registration');
  } catch (e) {
    if (!(e instanceof OutcomeUnknownError)) throw e;
    // No answer is not a no: ask SoDEX whether it landed.
    const landed = await copyKeyRegistered(owner, o.name, o.address).catch(() => ({ ok: false }));
    if (!landed.ok) throw new Error('SoDEX did not confirm the copy key. Check your connection and approve again.');
  }
  log.info('copy key registered', { name: o.name, key: o.address, expiresAt });
  return { expiresAt, accountId };
}

/**
 * Revoke the copy key `name` on SoDEX: the hard stop - nothing can trade with
 * it any more, whoever holds it. One signature on ValueChain (SoDEX's domain).
 */
export async function revokeCopyKey(o: { owner: string; provider: Eip1193Provider; name: string }): Promise<void> {
  const cfg = tradingConfig();
  const owner = o.owner.toLowerCase();
  const accountId = await sodexAccountId(owner);
  if (!accountId) return;
  if ((await getChainId(o.provider)) !== cfg.chainId) {
    const p = await api.depositChain();
    await addOrSwitchChain(o.provider, {
      chainId: p.chainIdHex,
      chainName: p.name,
      rpcUrls: [p.rpcUrl],
      nativeCurrency: p.nativeCurrency,
      blockExplorerUrls: p.explorerUrl ? [p.explorerUrl] : [],
    });
  }
  const prepared = prepareApiKeyRevocationExchange({
    userAddress: owner,
    engine: 'perps',
    accountID: accountId,
    name: o.name,
    nonce: await nonces().next(nonceKey(owner, cfg.chainId)),
    sodexChainId: cfg.chainId,
  });
  const signature = await signTypedData(o.provider, owner, prepared.typedData);
  for (const req of assembleExchangeRequests(prepared, signature, { base: '' })) await sendSigned(req, 'copy key revocation');
  log.info('copy key revoked', { name: o.name });
}
