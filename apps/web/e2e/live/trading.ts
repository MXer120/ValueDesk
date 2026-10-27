/**
 * The trading key and the builder approval: the wallet's signatures that no
 * funds move on, each pinned to exactly what it may sign.
 *
 *   key registration   UserSignedAddAPIKeyAction - this account, this key name,
 *                      a key that is not the wallet itself; sent to both engines
 *   builder approval   ApproveBuilderFeeAction - this account, this builder,
 *                      exactly this maximum (0 = the revocation); ONE per call
 *   key revocation     ExchangeAction under an engine's domain whose payload is
 *                      exactly `revokeAPIKey` of this account's key of this name -
 *                      a master-wallet ExchangeAction could carry ANY engine
 *                      action, so the payload hash is the whole check
 */
import { ACTION, actionPayloadHash, bytesToHex, engineDomainName, revokeAPIKey } from '@sodex-core';
import { SITE_TERMS_VERSION, _signedTermsForTests, signedTerms } from '../../src/legal/acceptance';
import { activeBuilder } from '../../src/trading/builder';
import { tradingConfig } from '../../src/trading/config';
import { enableTrading, getTradingState, sodexAccountId, tradingKeyName } from '../../src/trading/session';
import { SafetyStop, armed, type Ctx } from './context';
import type { Expectation } from './guard';
import type { ProviderPolicy, TypedDataSeen } from './provider';

/** Expect ONE approval write for this account and builder, with exactly this maximum (0 = revoke). */
export function builderApprovalExpect(accountId: number, builderId: number, maxFeeRate: number, label: string): Expectation {
  return {
    kind: 'builder-approval',
    label,
    check: (r) => {
      const b = r.body ?? {};
      if (Object.keys(b).join(',') !== 'accountID,builderID,maxFeeRate') return `body keys ${Object.keys(b).join(',')}, expected accountID,builderID,maxFeeRate`;
      if (b.accountID !== accountId) return `account ${b.accountID}, expected ${accountId}`;
      if (b.builderID !== builderId) return `builder ${b.builderID}, expected ${builderId}`;
      if (b.maxFeeRate !== maxFeeRate) return `maxFeeRate ${b.maxFeeRate}, expected ${maxFeeRate}`;
      return null;
    },
  };
}

/** The wallet signs an ApproveBuilderFeeAction only for this account, this builder and this maximum. */
export function builderTypedDataProblem(m: Record<string, unknown>, accountId: number, builderId: number, maxFeeRate: number): string | null {
  if (String(m.accountID) !== String(accountId)) return `account ${String(m.accountID)}, expected ${accountId}`;
  if (String(m.builderID) !== String(builderId)) return `builder ${String(m.builderID)}, expected ${builderId}`;
  if (String(m.maxFeeRate) !== String(maxFeeRate)) return `maxFeeRate ${String(m.maxFeeRate)}, expected ${maxFeeRate}`;
  if (String(m.chainID) !== String(tradingConfig().chainId)) return `SoDEX chain ${String(m.chainID)}`;
  return null;
}

/** A wallet policy for exactly ONE ApproveBuilderFeeAction with this maximum; a second signature is refused. */
export function builderApprovalPolicy(accountId: number, builderId: number, maxFeeRate: number): ProviderPolicy {
  let signed = 0;
  return {
    typedData: (td) => {
      if (td.primaryType !== 'ApproveBuilderFeeAction') return `unexpected typed data ${td.primaryType}`;
      const why = builderTypedDataProblem(td.message, accountId, builderId, maxFeeRate);
      if (why) return why;
      if (signed >= 1) return 'a second builder approval signature - this step signs exactly one';
      signed += 1;
      return null;
    },
  };
}

/** The key registration's typed data: this account, this key name, the SoDEX network. */
export function keyTypedDataProblem(td: TypedDataSeen, accountId: number, name: string): string | null {
  const m = td.message;
  if (td.primaryType !== 'UserSignedAddAPIKeyAction') return `unexpected typed data ${td.primaryType}`;
  if (String(m.accountID) !== String(accountId)) return `account ${String(m.accountID)}, expected ${accountId}`;
  if (m.name !== name) return `key name ${String(m.name)}, expected ${name}`;
  if (String(m.chainID) !== String(tradingConfig().chainId)) return `SoDEX chain ${String(m.chainID)}`;
  return null;
}

export function keyRegistrationExpect(owner: string, accountId: number, name: string): Expectation {
  return {
    kind: 'key-registration',
    label: `addAPIKey "${name}" (spot + perps)`,
    times: 2,
    check: (r) => {
      const b = r.body ?? {};
      const p = b.params ?? {};
      if (b.type !== 'addAPIKey') return `action ${b.type}, expected addAPIKey`;
      if (p.accountID !== accountId) return `account ${p.accountID}, expected ${accountId}`;
      if (p.name !== name) return `key name ${p.name}, expected ${name}`;
      if (typeof p.publicKey !== 'string' || p.publicKey.toLowerCase() === owner) return 'the trading key must be a separate key';
      return null;
    },
  };
}

/**
 * The revocation of this account's key `name`: one request per engine, each with
 * exactly `{type: revokeAPIKey, params: {accountID, name}}`.
 */
export function keyRevocationExpect(accountId: number, name: string): Expectation {
  return {
    kind: 'key-revocation',
    label: `revokeAPIKey "${name}" (one per engine)`,
    times: 2,
    check: (r) => {
      const b = r.body ?? {};
      const p = b.params ?? {};
      if (b.type !== 'revokeAPIKey') return `action ${b.type}, expected revokeAPIKey`;
      if (Object.keys(p).join(',') !== 'accountID,name') return `params ${Object.keys(p).join(',')}, expected accountID,name`;
      if (p.accountID !== accountId) return `account ${p.accountID}, expected ${accountId}`;
      if (p.name !== name) return `key name ${p.name}, expected ${name}`;
      return null;
    },
  };
}

/**
 * The wallet's policy for revoking a key: an ExchangeAction under the `spot` or
 * the `futures` domain on the SoDEX chain whose payload hash is EXACTLY the hash
 * of this revocation - once per engine, nothing else.
 */
export function keyRevocationPolicy(accountId: number, name: string): ProviderPolicy {
  const want = bytesToHex(actionPayloadHash(ACTION.revokeAPIKey, revokeAPIKey(accountId, name))).toLowerCase();
  const done = new Set<string>();
  const domains = new Set([engineDomainName('spot'), engineDomainName('perps')]);
  return {
    typedData: (td, chainId) => {
      if (td.primaryType !== 'ExchangeAction') return `unexpected typed data ${td.primaryType}`;
      if (chainId !== tradingConfig().chainId) return 'a key revocation is signed on ValueChain';
      const d = td.domain as { name?: unknown; chainId?: unknown; verifyingContract?: unknown };
      const domain = String(d.name);
      if (!domains.has(domain as 'spot' | 'futures')) return `domain "${domain}" is not an engine's`;
      if (!/^0x0{40}$/i.test(String(d.verifyingContract))) return 'not the engines\' zero-address domain';
      if (String(td.message.payloadHash).toLowerCase() !== want) return `the action is not the revocation of key "${name}" on account ${accountId} - a master-wallet ExchangeAction could be any engine action, so nothing else is signed`;
      if (done.has(domain)) return `a second revocation signature for ${domain}`;
      done.add(domain);
      return null;
    },
  };
}

/** Register the trading key (and, when a builder is configured and not yet approved, approve its fee first) through the app's own enableTrading. */
export async function registerKey(ctx: Ctx): Promise<number> {
  const accountId = await sodexAccountId(ctx.owner);
  if (!accountId) throw new SafetyStop('this wallet has no SoDEX account yet - run deposit-external first');
  const name = tradingKeyName();
  const fee = activeBuilder(tradingConfig().builder);
  const approval = fee ? builderApprovalPolicy(accountId, fee.id, fee.maxFeeRate) : null;
  await armed(
    ctx,
    {
      expect: [
        // Only sent when SoDEX does not already list the approval; an unused expectation is fine.
        ...(fee ? [builderApprovalExpect(accountId, fee.id, fee.maxFeeRate, `approve builder #${fee.id} up to ${fee.maxFeeRate}`)] : []),
        keyRegistrationExpect(ctx.owner, accountId, name),
      ],
      policy: {
        typedData: (td, chainId) => {
          if (approval && td.primaryType === 'ApproveBuilderFeeAction') return approval.typedData!(td, chainId);
          return keyTypedDataProblem(td, accountId, name);
        },
      },
    },
    () =>
      enableTrading({
        owner: ctx.owner,
        provider: ctx.provider,
        remember: true,
        // The run's config IS the consent: what the app's dialog would state is noted, then approved.
        ...(fee
          ? {
              confirmBuilderFee: async (terms) => {
                ctx.rec.note(
                  `builder fee disclosure: builder #${terms.builderId}, perps ${terms.perps} / spot ${terms.spot} tenths of a bp per fill, maximum ${terms.maxFeeRate}, ${terms.required ? 'required' : 'optional'}` +
                    `${terms.alreadyApproved.length ? `, already approved on ${terms.alreadyApproved.join(' + ')}` : ''} - approving (ONE more signature)`,
                );
                return 'approve' as const;
              },
            }
          : {}),
      }),
  );
  const st = getTradingState();
  if (st.status !== 'enabled' || !st.accountId) throw new Error(`trading did not switch on (status ${st.status})`);
  if (fee) ctx.rec.note(`builder approval SoDEX lists for #${fee.id}: ${st.builder ? JSON.stringify(st.builder.engines) : 'none yet'}`);
  ctx.rec.note(`trading key "${st.keyName}" ${st.keyAddress} on ${(st.engines ?? []).join(' + ')}, account #${st.accountId}, expires ${new Date(st.expiresAt ?? 0).toISOString()}`);
  // The legal gate (src/trading/legalGate.ts) refuses every opening order until the wallet has accepted the current
  // site terms. The runner's wallet is the owner's own test wallet, run by the owner: its acceptance is recorded here
  // for this run (the country of residence from LIVE_COUNTRY, default DE), as the app records it after the signature.
  if (!signedTerms(ctx.owner)) {
    const country = (process.env.LIVE_COUNTRY ?? 'DE').trim().toUpperCase();
    _signedTermsForTests(ctx.owner, country);
    ctx.rec.note(`site terms ${SITE_TERMS_VERSION} accepted for this run (residence ${country})`);
  }
  return st.accountId;
}

/** Steps that sign with the trading key call this first: enables trading if it is not on (a signature, no funds). */
export async function ensureTrading(ctx: Ctx): Promise<number> {
  const st = getTradingState();
  if (st.status === 'enabled' && st.owner === ctx.owner && st.accountId && (st.expiresAt ?? 0) > Date.now() + 120_000) return st.accountId;
  return ctx.rec.sub('enable trading first (one wallet signature, no funds move)', () => registerKey(ctx));
}
