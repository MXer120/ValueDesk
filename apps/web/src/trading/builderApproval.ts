/**
 * The builder-fee approval on the wire: read what SoDEX lists, ask the wallet
 * for ONE typed-data signature, send it from this browser, read again.
 *
 *   READ    GET  /api/v1/user/{owner}/builders            public, no signature
 *   WRITE   POST /api/v1/user/{owner}/builders            body {accountID, builderID, maxFeeRate}
 *           signed by the MASTER wallet: ApproveBuilderFeeAction, universal
 *           domain, domain chainId = the wallet's current chain = X-API-Chain,
 *           message chainID = the SoDEX network id; X-API-Sign = 0x02 || r || s || v.
 *           `maxFeeRate: 0` clears the approval.
 *
 * WHY A SEPARATE SIGNATURE and not the one-signature AddAPIKeyWithBuilder
 * (docs/BUILDER-CODES.md has the evidence): the key registration this app uses
 * is the one proven against SoDEX (`/exchange`, what sodex.com itself sends) and
 * stays untouched; a user must be able to decline the FEE without declining the
 * KEY; an approval SoDEX refuses must not take the key down with it; and the
 * approval outlives the key (it is per account), so it is asked for once, not
 * at every weekly key rotation.
 *
 * This file knows nothing about the trading session: session.ts decides when to
 * ask, and passes the nonce in.
 */
import {
  SodexApiError,
  approvedBuilderRates,
  assembleWalletSignedRequest,
  prepareBuilderFeeApproval,
  type BuilderEngineRates,
} from '@sodex-core';
import { tradingConfig } from './config';
import { readGateway, sendSigned } from './gateway';
import { getChainId, signTypedData, type Eip1193Provider } from '../wallet';
import { logger } from '../log';

const log = logger('trade');

/** The gateway bills this read 20 (measured), not the table's default. */
const BUILDERS_READ_WEIGHT = 20;

/**
 * What SoDEX lists as approved for `builderId` on `owner`'s account, per engine.
 * Throws when SoDEX could not be asked - "unknown" is never read as "not approved".
 * A wallet SoDEX has never seen has no approvals: that is an answer.
 */
export async function readBuilderRates(owner: string, builderId: number): Promise<BuilderEngineRates> {
  try {
    const data = await readGateway<unknown>(`/api/v1/user/${owner.toLowerCase()}/builders`, 2, BUILDERS_READ_WEIGHT);
    return approvedBuilderRates(data, builderId);
  } catch (e) {
    if (e instanceof SodexApiError && /user not found/i.test(e.message)) return { spot: null, perps: null };
    throw e;
  }
}

export interface BuilderApprovalRequest {
  /** The master wallet (SoDEX account owner). */
  owner: string;
  provider: Eip1193Provider;
  /** The owner's PRIMARY account id. */
  accountId: number;
  builderId: number;
  /** 0..2000 tenths of a bp; 0 clears the approval. */
  maxFeeRate: number;
  /** A fresh master-wallet nonce (ms). Every attempt takes a new one. */
  nonce: () => Promise<bigint | number>;
}

/**
 * Sign and send one approval (or, with `maxFeeRate: 0`, one revocation).
 *
 * Throws WalletError when the wallet declines or fails, SodexApiError when
 * SoDEX refuses (its reason is the message), OutcomeUnknownError when no answer
 * arrived - the caller then READS before doing anything else. Resolving means
 * SoDEX answered `code: 0`; it does not yet mean the approval is listed.
 */
export async function submitBuilderApproval(r: BuilderApprovalRequest): Promise<void> {
  const cfg = tradingConfig();
  const owner = r.owner.toLowerCase();
  // The domain is whatever chain the wallet is on: nothing to switch.
  const walletChain = await getChainId(r.provider);
  const prepared = prepareBuilderFeeApproval({
    userAddress: owner,
    accountID: r.accountId,
    builderID: r.builderId,
    maxFeeRate: r.maxFeeRate,
    nonce: await r.nonce(),
    sodexChainId: cfg.chainId,
    signatureChainId: walletChain,
  });
  const what = r.maxFeeRate === 0 ? 'builder approval revocation' : 'builder fee approval';
  log.info(`${what}: asking the wallet to sign`, {
    network: cfg.network,
    accountId: r.accountId,
    builderId: r.builderId,
    maxFeeRate: r.maxFeeRate,
    walletChain,
  });
  const signature = await signTypedData(r.provider, owner, prepared.typedData);
  // Recovers the signer first: a signature from any other account is refused here.
  const req = assembleWalletSignedRequest(prepared, signature, { base: '' });
  await sendSigned(req, what);
}

/**
 * Indexed reads lag a write: read again with growing pauses until `done`, or
 * the pauses run out. Returns the last answer (null when SoDEX never answered).
 * The first read is immediate.
 */
let pollDelays: readonly number[] = [0, 400, 800, 1500, 2500, 4000];

export async function pollBuilderRates(
  owner: string,
  builderId: number,
  done: (r: BuilderEngineRates) => boolean,
  delays: readonly number[] = pollDelays,
): Promise<BuilderEngineRates | null> {
  let last: BuilderEngineRates | null = null;
  for (const wait of delays) {
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    try {
      last = await readBuilderRates(owner, builderId);
      if (done(last)) return last;
    } catch (e) {
      log.debug('builder approval read failed; trying again', { error: String(e) });
    }
  }
  return last;
}

/** For tests: the pauses between confirmation reads. */
export function _setBuilderPollDelaysForTests(delays: readonly number[]): void {
  pollDelays = delays;
}
