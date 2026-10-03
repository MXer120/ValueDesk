/**
 * The live steps that MOVE FUNDS, and the table of all steps. Each one:
 *   1. checks its preconditions against LIVE state (never an assumption from an
 *      earlier step - so `--only` can resume after an interruption);
 *   2. acts through the SAME app function the UI calls (sendUsdcDeposit,
 *      enableTrading, transferFunds, withdrawFunds ...), inside `armed()`: the
 *      network guard expects exactly the writes this action makes and the wallet
 *      signs exactly what it should - nothing else can go out;
 *   3. verifies the outcome by polling real balances / SoDEX state, with a
 *      timeout, and records amounts, fees, tx hashes and timings - and its
 *      verdict under a check id (checks.ts).
 * A funds step that fails or times out STOPS the run (where the money is decides
 * what may follow); the runner then prints where every coin is. The order,
 * builder, refusal and key steps live in their own files and record each
 * assertion separately.
 */
import { CALL_FOR_PERMIT_CONTRACT, CLOB_GATEWAY, TransferType, WITHDRAW_TOKEN_TARGET, canonicalDecimal } from '@sodex-core';
import { decodeFunctionData, parseAbi } from 'viem';
import { activeBuilder, fullyApproved, ratesOf } from '../../src/trading/builder';
import { readBuilderRates } from '../../src/trading/builderApproval';
import { tradingConfig } from '../../src/trading/config';
import {
  balancesOf,
  chainLabel,
  memoProblem,
  receiverProblem,
  toChecksumAddress,
  transferFunds,
  unitsDown,
  withdrawFunds,
  withdrawQuote,
  withdrawalProgress,
  type ChainRoute,
  type CoinConfig,
} from '../../src/trading/funds';
import { CANONICAL_USDC, erc20TransferData, formatUnits, parseUnits, sendUsdcDeposit, usdcRoutes } from '../../src/trading/onboard';
import { coinPrices, priceOf } from '../../src/trading/prices';
import { VALUECHAIN_RPC } from '../../src/trading/rpc';
import { getTradingState, keyStillRegistered, readBuilderApproval, refreshBuilderApproval, requireSigner, revokeBuilderApproval, sodexAccountId } from '../../src/trading/session';
import { evmChain } from './chains';
import { depositCheckId, withdrawCheckId, type CheckArea } from './checks';
import { SafetyStop, allowedReceivers, armed, coinNamed, receiverNamed, routeOf, type Ctx, type StepId } from './context';
import { stepCrossCheck } from './crossCheck';
import { declareChainWithdrawalChecks, declareManualDepositChecks } from './chainRoutes';
import { stepEvmTour } from './evmTour';
import { stepChainWithdrawals, stepManualDeposits } from './otherChains';
import { declareTourChecks } from './tour';
import { stepKeyLifecycle } from './keySteps';
import { engineTransfer, mustPlace, orderMs, settleFills, settleMs, waitFor } from './orders';
import { stepOrdersPerps, stepOrdersSpot } from './orderSteps';
import { ACTIVATION_FEE_USDC, checkDepositAddress, depositAddressProblem, marketQty, spotMarketFor } from './plan';
import { VALUECHAIN_CHAIN_ID } from './provider';
import { apiKeys, nativeBalance, receipt, rpcRead, tokenBalance } from './reads';
import { stepRefusals } from './refusalSteps';
import { stepBuilderTiers } from './tierSteps';
import { builderApprovalExpect, builderTypedDataProblem, ensureTrading, registerKey } from './trading';
import { approx, cut, dCmp, dDiv, dMax, dMul, dSub, errText, isDecimal, toStep, usd } from './util';

const ERC20 = parseAbi(['function approve(address spender, uint256 amount)', 'function transfer(address to, uint256 amount)']);
const EXCHANGE = parseAbi(['function depositERC20(address token, uint256 amount)']);

// --- shared helpers --------------------------------------------------------------------------------

const unitsOf = (v: string, dp: number): bigint => unitsDown(v, dp);

/** Explorer link for a tx on a chain key. */
function explorer(ctx: Ctx, chainKey: string, hash: string): string | undefined {
  if (chainKey === 'VALUECHAIN') return ctx.pre.vc.explorerUrl ? `${ctx.pre.vc.explorerUrl.replace(/\/+$/, '')}/tx/${hash}` : undefined;
  const c = evmChain(chainKey);
  return c ? `${c.explorer}/tx/${hash}` : undefined;
}

async function usdPrice(coin: string): Promise<number> {
  if (/^v?USDC$/i.test(coin)) return 1;
  return priceOf(await coinPrices().catch(() => new Map()), coin) ?? 0;
}

/**
 * A funds move under its check id. It passes with what `fn` returns as its
 * detail; a failure is recorded AND thrown - the run stops, because what follows
 * depends on where the money is.
 */
export async function moved(ctx: Ctx, id: string, fn: () => Promise<{ detail: string; evidence?: Record<string, unknown>; costUsd?: number }>): Promise<void> {
  ctx.rec.line(`* ${id}`, 3);
  try {
    const r = await fn();
    ctx.checks.pass(id, r.detail, r.evidence ?? {}, r.costUsd ?? null);
  } catch (e) {
    ctx.checks.fail(id, errText(e));
    throw e;
  }
}

/** The check a configured deposit / withdrawal reports under (`key`: its index in the config, or the step's own key). */
export function routeCheck(ctx: Ctx, step: StepId, key: number | string): string {
  const id = ctx.routeChecks.get(`${step}#${key}`);
  if (!id) throw new Error(`no check was declared for ${step}#${key} (steps.ts declareFundsChecks)`);
  return id;
}

/**
 * One check per deposit and per withdrawal the config asks for - declared when
 * the routes are known, so each shows in the report even when the run never
 * reaches it. Two steps on the same coin and chain get separate ids.
 */
export function declareFundsChecks(ctx: Ctx): void {
  const { cfg } = ctx;
  const add = (step: StepId, index: number | string, area: CheckArea, direction: 'deposit' | 'withdraw', coin: string, chain: string, what: string, base?: string): void => {
    const id = ctx.checks.declareUnique({
      id: base ?? (direction === 'deposit' ? depositCheckId(coin, chain) : withdrawCheckId(coin, chain)),
      area,
      step,
      title: what,
      route: { coin, chain, label: chainLabel(chain), direction },
    });
    ctx.routeChecks.set(`${step}#${index}`, id);
  };
  add('deposit-external', 0, 'deposits', 'deposit', 'USDC', cfg.deposit.chain, `Deposit of USDC from ${chainLabel(cfg.deposit.chain)} is credited to Spot (a new wallet: less the activation fee)`);
  cfg.extraDeposits.forEach((d, i) => add('extra-deposits', i, 'deposits', 'deposit', 'USDC', d.chain, `Deposit of USDC from ${chainLabel(d.chain)} is credited to Spot`));
  const w = cfg.withdrawExternal;
  add('withdraw-external', 0, 'withdrawals', 'withdraw', w.coin, w.chain, `Withdrawal of ${w.coin} to ${chainLabel(w.chain)} arrives (SoDEX's record is final${evmChain(w.chain) ? ', the balance on that chain rose' : ''})`);
  cfg.extraWithdrawals.forEach((x, i) => add('extra-withdrawals', i, 'withdrawals', 'withdraw', x.coin, x.chain, `Withdrawal of ${x.coin} to ${chainLabel(x.chain)} arrives (SoDEX's record is final${evmChain(x.chain) ? ', the balance on that chain rose' : ''})`));
  // The wider profiles' checks: declared when their step is part of the run.
  if (ctx.selected.has('evm-tour')) declareTourChecks(ctx, (key, area, direction, coin, chain, title, id) => add('evm-tour', key, area, direction, coin, chain, title, id));
  if (ctx.selected.has('chain-withdrawals')) declareChainWithdrawalChecks(ctx.pre.coins, cfg, (key, area, direction, coin, chain, title, id) => add('chain-withdrawals', key, area, direction, coin, chain, title, id));
  if (ctx.selected.has('manual-deposits')) declareManualDepositChecks(cfg, (key, area, direction, coin, chain, title, id) => add('manual-deposits', key, area, direction, coin, chain, title, id));
}

// --- deposit from an EVM chain --------------------------------------------------------------------

export async function depositOne(ctx: Ctx, chainKey: string, amountIn: string): Promise<{ detail: string; evidence: Record<string, unknown>; costUsd: number }> {
  const { rec, owner } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const route = (await usdcRoutes()).find((r) => r.chain.key === chainKey);
  if (!route) throw new SafetyStop(`SoDEX has no OPEN canonical USDC deposit route on ${chainKey} right now`);
  const amount = canonicalDecimal(amountIn);
  const units = parseUnits(amount, route.decimals);
  if (units < parseUnits(route.minDeposit, route.decimals)) throw new SafetyStop(`${amount} USDC is below SoDEX's minimum ${route.minDeposit} on ${route.chain.name}`);

  // The deposit address: the backend's AND the on-chain registry's, re-read right before sending.
  const d = await rec.sub(
    `re-check the ${chainKey} deposit address (backend vs on-chain registry)`,
    () => checkDepositAddress(owner, chainKey, { registryOnly: false, waitMs: ctx.cfg.timeouts.addressIssueSeconds * 1000, say: (s) => rec.line(s, 7) }),
    (x) => `${x.backend ?? '-'} vs ${x.registry ?? '-'}`,
  );
  const bad = depositAddressProblem(owner, chainKey, d);
  if (bad) throw new SafetyStop(`deposit address: ${bad}`);
  const addr = d.backend!;

  const have = await tokenBalance(route.chain.rpcUrl, route.token, owner);
  if (have < units) throw new SafetyStop(`the wallet holds ${formatUnits(have, route.decimals)} USDC on ${route.chain.name}, not ${amount}`);
  const gas = await nativeBalance(route.chain.rpcUrl, owner);
  if (gas === 0n) throw new SafetyStop(`the wallet has no ${route.chain.native.symbol} on ${route.chain.name} for gas`);

  const acct0 = await sodexAccountId(owner);
  const spot0 = acct0 ? unitsOf((await balancesOf(owner, usdc)).spot, dp) : 0n;
  const expected = acct0 ? amount : dSub(amount, ACTIVATION_FEE_USDC);
  if (dCmp(expected, '0') <= 0) throw new SafetyStop(`a first deposit must be more than the ${ACTIVATION_FEE_USDC} USDC activation fee`);
  const expectUnits = unitsOf(expected, dp);

  const want = erc20TransferData(addr, units).toLowerCase();
  const token = route.token.toLowerCase();
  const sent = await rec.sub(`send ${amount} USDC on ${route.chain.name} to ${addr} (the app's sendUsdcDeposit)`, () =>
    armed(
      ctx,
      {
        policy: {
          tx: (t) =>
            t.chainId !== route.chain.chainId
              ? `chain ${t.chainId}, expected ${route.chain.chainId}`
              : t.to !== token
                ? `to ${t.to}, not the canonical USDC contract ${token}`
                : t.value !== 0n
                  ? 'carries native value'
                  : t.data !== want
                    ? 'not transfer(verified deposit address, exact amount)'
                    : null,
        },
      },
      () => sendUsdcDeposit({ provider: ctx.provider, owner, route, depositAddress: addr, amount }),
    ),
  );
  const flight = { what: `${amount} USDC sent on ${route.chain.name} to the wallet's SoDEX deposit address ${addr} - not credited yet`, since: Date.now(), ref: sent.explorerUrl };
  ctx.inFlight.push(flight);
  const rc = await rec.sub(
    `wait for the receipt on ${route.chain.name}`,
    () =>
      waitFor(ctx, `the receipt on ${route.chain.name}`, {
        timeoutMs: 10 * 60_000,
        intervalMs: 3000,
        // No receipt yet reads as a failed probe: polling goes on.
        probe: async () => {
          const r = await receipt(route.chain.rpcUrl, sent.hash);
          if (!r) throw new Error('not mined yet');
          return r;
        },
        done: () => true,
        show: () => 'not mined yet',
      }),
    (r) => `${r.status}, block ${r.blockNumber}`,
  );
  const gasWei = rc.gasUsed * rc.effectiveGasPrice;
  const gasUsd = approx(formatUnits(gasWei, 18)) * (await usdPrice(route.chain.native.symbol));
  const txr = ctx.rec.current?.txs.find((t) => t.hash.toLowerCase() === sent.hash.toLowerCase());
  if (txr) Object.assign(txr, { status: rc.status, gas: `${cut(formatUnits(gasWei, 18), 10)} ${route.chain.native.symbol}`, gasUsd });
  if (rc.status !== 'success') {
    ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
    throw new Error(`the USDC transfer REVERTED on ${route.chain.name} (${sent.explorerUrl}) - the USDC did not leave the wallet`);
  }
  rec.fee(`gas on ${route.chain.name}`, `${cut(formatUnits(gasWei, 18), 10)} ${route.chain.native.symbol} (${usd(gasUsd)})`);

  const eta = route.etaSeconds ? `SoDEX estimate ~${Math.max(1, Math.round(route.etaSeconds / 60))} min` : 'no SoDEX estimate';
  const t0 = Date.now();
  const credited = await rec.sub(`wait for SoDEX to ${acct0 ? 'credit' : 'open the account and credit'} Spot +${expected} USDC (${eta})`, () =>
    waitFor(ctx, `SoDEX to credit the deposit (${eta})`, {
      timeoutMs: ctx.cfg.timeouts.depositMinutes * 60_000,
      intervalMs: 15_000,
      probe: async () => {
        const id = await sodexAccountId(owner);
        const s = id ? unitsOf((await balancesOf(owner, usdc)).spot, dp) : 0n;
        return { id, s };
      },
      done: (v) => v.id > 0 && v.s >= spot0 + expectUnits,
      show: (v) => (v ? `account ${v.id || 'none yet'}, Spot USDC ${formatUnits(v.s, dp)} (want >= ${formatUnits(spot0 + expectUnits, dp)})` : 'no answer yet'),
    }),
  );
  ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
  const got = credited.s - spot0;
  const kept = formatUnits(unitsOf(amount, dp) - got, dp);
  rec.amount(`deposit ${route.chain.name}`, `sent ${amount} USDC, credited ${formatUnits(got, dp)} USDC to Spot${acct0 ? '' : ` (account #${credited.id} opened)`}`);
  if (!acct0) rec.fee('activation (first deposit)', `${kept} USDC`);
  return {
    detail: `${amount} USDC sent on ${route.chain.name} (${sent.hash}); Spot was credited ${formatUnits(got, dp)} USDC after ${Math.round((Date.now() - t0) / 1000)} s${acct0 ? '' : ` - account #${credited.id} was opened, SoDEX kept ${kept} USDC as the activation fee`}; gas ${cut(formatUnits(gasWei, 18), 10)} ${route.chain.native.symbol}`,
    evidence: { tx: sent.hash, chain: chainKey, depositAddress: addr, sent: amount, credited: formatUnits(got, dp), accountOpened: !acct0, creditedAfterMs: Date.now() - t0 },
    costUsd: gasUsd + (acct0 ? 0 : approx(kept)),
  };
}

// --- the steps ---------------------------------------------------------------------------------------

async function stepDepositExternal(ctx: Ctx): Promise<void> {
  await moved(ctx, routeCheck(ctx, 'deposit-external', 0), () => depositOne(ctx, ctx.cfg.deposit.chain, ctx.cfg.deposit.amount));
}

async function stepEnableTrading(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const fee = activeBuilder(tradingConfig().builder);
  // What SoDEX lists BEFORE: an account that already approved the builder signs nothing for it.
  const before = fee ? await readBuilderRates(owner, fee.id).catch(() => null) : null;
  const already = !!fee && !!before && fullyApproved(fee, before);
  const signedFrom = ctx.walletSigned.length;
  try {
    await rec.sub('register the trading key (one wallet signature)', () => registerKey(ctx));
  } catch (e) {
    ctx.checks.fail('key-enable', errText(e));
    if (fee) ctx.checks.set('builder-approval', 'not-run', 'enabling trading failed');
    throw e;
  }
  const signed = ctx.walletSigned.slice(signedFrom);
  const st = getTradingState();
  if ((st.engines ?? []).length < 2) rec.warn('engines', `SoDEX accepted the key on ${(st.engines ?? []).join(', ')} only`);

  await moved(ctx, 'key-enable', async () => {
    const meta = { ...requireSigner(owner).meta };
    await rec.sub('verify: SoDEX lists the key on each engine', () =>
      waitFor(ctx, "the new key in SoDEX's key list", {
        timeoutMs: Math.max(settleMs(ctx), 180_000),
        intervalMs: 10_000,
        probe: () => keyStillRegistered(meta),
        done: (v) => v === true,
        show: (v) => (v === null ? 'SoDEX could not be asked' : v ? 'listed' : 'not listed yet (indexed reads lag a fresh key)'),
      }),
    );
    const rows = await Promise.all((['spot', 'perps'] as const).map(async (e) => [e, (await apiKeys(e, owner)).find((k) => k.name === meta.name) ?? null] as const));
    const off = rows.filter(([, row]) => !row || row.publicKey.toLowerCase() !== meta.keyAddress);
    if (off.length) throw new Error(`${off.map(([e]) => e).join(' and ')} do not list key ${meta.keyAddress} under "${meta.name}"`);
    const keySigs = signed.filter((s) => s === 'UserSignedAddAPIKeyAction').length;
    const other = signed.filter((s) => s !== 'UserSignedAddAPIKeyAction' && s !== 'ApproveBuilderFeeAction');
    if (keySigs !== 1 || other.length) throw new Error(`enabling trading took ${keySigs} key signature(s)${other.length ? ` and ${other.join(', ')}` : ''} - expected exactly ONE UserSignedAddAPIKeyAction`);
    rec.amount('trading key', `${st.keyName} ${st.keyAddress}`);
    return {
      detail: `key "${meta.name}" ${meta.keyAddress} registered with ONE wallet signature (UserSignedAddAPIKeyAction, signed on the chain the wallet was on - no network switch); spot and perps both list it, expiring ${new Date(meta.expiresAt).toISOString()}`,
      evidence: { name: meta.name, key: meta.keyAddress, expiresAt: meta.expiresAt, engines: st.engines, walletSignatures: signed },
    };
  });

  if (!fee) {
    ctx.checks.skip('builder-approval', 'no builder in this run');
    return;
  }
  await moved(ctx, 'builder-approval', async () => {
    const listed = await rec.sub(`verify: SoDEX lists the approval of builder #${fee.id} on every engine it is charged on`, () =>
      waitFor(ctx, 'the builder approval in GET /user/{wallet}/builders', {
        timeoutMs: Math.max(settleMs(ctx), 60_000),
        intervalMs: 5_000,
        probe: () => readBuilderApproval(owner),
        done: (a) => fullyApproved(fee, ratesOf(a)),
        show: (a) => (a ? `listed ${JSON.stringify(a.engines)}` : 'not listed (indexed reads lag an approval)'),
      }),
    );
    // The app attaches the fee from what its session knows: bring it up to what SoDEX lists.
    await refreshBuilderApproval();
    rec.amount('builder approval', `builder #${fee.id}: ${JSON.stringify(listed?.engines ?? {})} (tenths of a bp)`);
    const approvals = signed.filter((s) => s === 'ApproveBuilderFeeAction').length;
    if (approvals > 1) throw new Error(`the approval took ${approvals} wallet signatures - expected ONE`);
    if (already && approvals) throw new Error('SoDEX already listed a covering approval, yet the wallet was asked to sign another');
    if (!already && approvals !== 1) throw new Error(`SoDEX did not list the approval before, and the wallet signed ${approvals} approval(s) - expected exactly ONE`);
    return {
      detail: already
        ? `SoDEX already listed a covering approval of builder #${fee.id} (${JSON.stringify(listed?.engines ?? {})}): nothing was signed for it`
        : `builder #${fee.id} approved up to ${fee.maxFeeRate} (tenths of a bp) with ONE wallet signature (ApproveBuilderFeeAction), before the key; SoDEX lists it: ${JSON.stringify(listed?.engines ?? {})}`,
      evidence: { builder: fee.id, maxFeeRate: fee.maxFeeRate, listed: listed?.engines ?? null, alreadyApproved: already, required: fee.required },
    };
  });
}

/** Clear the builder approval with ONE wallet signature (maxFeeRate 0), through the app's own revokeBuilderApproval. */
async function stepRevokeBuilder(ctx: Ctx): Promise<void> {
  const b = ctx.cfg.builder;
  if (!b) throw new SafetyStop('no builder is configured for this run');
  const accountId = await sodexAccountId(ctx.owner);
  if (!accountId) throw new SafetyStop('this wallet has no SoDEX account');
  await moved(ctx, 'builder-revoke', async () => {
    const from = ctx.walletSigned.length;
    const r = await ctx.rec.sub(`revoke the approval of builder #${b.id} (one wallet signature, maxFeeRate 0)`, () =>
      armed(
        ctx,
        {
          expect: [builderApprovalExpect(accountId, b.id, 0, `revoke builder #${b.id}`)],
          policy: {
            typedData: (td) => (td.primaryType === 'ApproveBuilderFeeAction' ? builderTypedDataProblem(td.message, accountId, b.id, 0) : `unexpected typed data ${td.primaryType}`),
          },
        },
        () => revokeBuilderApproval({ owner: ctx.owner, provider: ctx.provider, builderId: b.id }),
      ),
    );
    if (r.nothingToRevoke) ctx.rec.note('SoDEX listed no approval for this builder - nothing was signed');
    await ctx.rec.sub('verify: the builder is gone from both lists', () =>
      waitFor(ctx, 'the approval to leave GET /user/{wallet}/builders', {
        timeoutMs: Math.max(settleMs(ctx), 60_000),
        intervalMs: 5_000,
        probe: () => readBuilderApproval(ctx.owner, b.id),
        done: (a) => a === null,
        show: (a) => (a ? `still listed ${JSON.stringify(a.engines)}` : 'gone'),
      }),
    );
    const signed = ctx.walletSigned.slice(from);
    if (signed.length > 1) throw new Error(`the revocation took ${signed.length} wallet signatures - expected ONE`);
    ctx.rec.amount('builder approval', `builder #${b.id}: revoked${r.tradingTurnedOff ? ' (trading turned off: this run requires the fee)' : ''}`);
    return {
      detail: r.nothingToRevoke
        ? `SoDEX listed no approval of builder #${b.id}: nothing was signed`
        : `the approval of builder #${b.id} was revoked with ONE wallet signature (maxFeeRate 0); it is gone from both lists${r.tradingTurnedOff ? '; the app turned trading off (this build requires the fee)' : ''}`,
      evidence: { builder: b.id, nothingToRevoke: r.nothingToRevoke, tradingTurnedOff: r.tradingTurnedOff, walletSignatures: signed },
    };
  });
}

async function stepTransfers(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const amount = canonicalDecimal(ctx.cfg.transfers.amount);
  const units = parseUnits(amount, dp);
  await ensureTrading(ctx);
  const b0 = await balancesOf(owner, usdc);
  if (unitsOf(b0.spot, dp) < units) throw new SafetyStop(`Spot holds ${b0.spot} USDC, less than ${amount}`);
  let b1 = b0;
  await moved(ctx, 'transfer-spot-to-perps', async () => {
    await rec.sub(`Spot -> Perps ${amount} USDC (transferFunds)`, () =>
      armed(ctx, { expect: [engineTransfer('spot', TransferType.PERPS_WITHDRAW, usdc, amount, 'Spot -> Perps')] }, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'spot', to: 'perps', amount })),
    );
    b1 = await rec.sub('verify: Perps +amount, Spot -amount', () =>
      waitFor(ctx, 'the transfer in the balances', {
        timeoutMs: settleMs(ctx),
        probe: () => balancesOf(owner, usdc),
        done: (b) => unitsOf(b.perps, dp) >= unitsOf(b0.perps, dp) + units && unitsOf(b.spot, dp) + units <= unitsOf(b0.spot, dp),
        show: (b) => (b ? `Spot ${b.spot}, Perps ${b.perps} (were ${b0.spot} / ${b0.perps})` : '-'),
      }),
    );
    return { detail: `${amount} USDC: Spot ${b0.spot} -> ${b1.spot}, Perps ${b0.perps} -> ${b1.perps}`, evidence: { amount, before: b0, after: b1 } };
  });
  await moved(ctx, 'transfer-perps-to-spot', async () => {
    await rec.sub(`Perps -> Spot ${amount} USDC (transferFunds)`, () =>
      armed(ctx, { expect: [engineTransfer('perps', TransferType.SPOT_WITHDRAW, usdc, amount, 'Perps -> Spot')] }, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'perps', to: 'spot', amount })),
    );
    const b2 = await rec.sub('verify: Spot +amount, Perps -amount', () =>
      waitFor(ctx, 'the transfer back in the balances', {
        timeoutMs: settleMs(ctx),
        probe: () => balancesOf(owner, usdc),
        done: (b) => unitsOf(b.spot, dp) >= unitsOf(b1.spot, dp) + units && unitsOf(b.perps, dp) + units <= unitsOf(b1.perps, dp),
        show: (b) => (b ? `Spot ${b.spot}, Perps ${b.perps} (were ${b1.spot} / ${b1.perps})` : '-'),
      }),
    );
    return { detail: `${amount} USDC: Perps ${b1.perps} -> ${b2.perps}, Spot ${b1.spot} -> ${b2.spot}`, evidence: { amount, before: b1, after: b2 } };
  });
  rec.amount('Spot <-> Perps', `${amount} USDC each way`);
}

async function stepSpotToEvm(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const usdc = ctx.pre.usdc;
  const soso = ctx.pre.soso;
  const udp = usdc.valuechain.decimals;
  await ensureTrading(ctx);

  await moved(ctx, 'transfer-spot-to-evm-usdc', async () => {
    const a = canonicalDecimal(cfg.spotToEvm.usdc);
    const units = parseUnits(a, udp);
    const b0 = await balancesOf(owner, usdc);
    if (unitsOf(b0.spot, udp) < units) throw new SafetyStop(`Spot holds ${b0.spot} USDC, less than ${a}`);
    const w0 = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner);
    await rec.sub(`Spot -> ValueChain wallet ${a} USDC (transferFunds)`, () =>
      armed(ctx, { expect: [engineTransfer('spot', TransferType.EVM_WITHDRAW, usdc, a, 'Spot -> own wallet (USDC)')] }, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'spot', to: 'evm', amount: a })),
    );
    const w1 = await rec.sub('verify: USDC arrived in the ValueChain wallet', () =>
      waitFor(ctx, 'USDC in the ValueChain wallet', { timeoutMs: settleMs(ctx), probe: () => tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner), done: (v) => v >= w0 + units, show: (v) => `wallet USDC ${v === undefined ? '?' : formatUnits(v, udp)} (want >= ${formatUnits(w0 + units, udp)})` }),
    );
    rec.amount('Spot -> wallet USDC', a);
    return { detail: `${a} USDC left Spot; the ValueChain wallet's USDC went ${formatUnits(w0, udp)} -> ${formatUnits(w1, udp)}`, evidence: { amount: a, walletBefore: formatUnits(w0, udp), walletAfter: formatUnits(w1, udp) } };
  });

  const sdp = soso.valuechain.decimals;
  const s0 = await balancesOf(owner, soso);
  const amt = cfg.spotToEvm.soso === 'all' ? s0.spot : canonicalDecimal(cfg.spotToEvm.soso);
  if (unitsOf(amt, sdp) === 0n) {
    rec.warn('SOSO', 'Spot holds no SOSO - nothing to move. The ValueChain wallet needs a little SOSO for gas in withdraw-valuechain-other.');
    ctx.checks.skip('transfer-spot-to-evm-soso', 'Spot holds no SOSO (the spot order step buys some when its market is a SOSO market)');
    return;
  }
  await moved(ctx, 'transfer-spot-to-evm-soso', async () => {
    if (unitsOf(s0.spot, sdp) < unitsOf(amt, sdp)) throw new SafetyStop(`Spot holds ${s0.spot} SOSO, less than ${amt}`);
    const n0 = await nativeBalance(VALUECHAIN_RPC, owner);
    await rec.sub(`Spot -> ValueChain wallet ${amt} SOSO (lands as native SOSO)`, () =>
      armed(ctx, { expect: [engineTransfer('spot', TransferType.EVM_WITHDRAW, soso, amt, 'Spot -> own wallet (SOSO)')] }, () => transferFunds({ owner, provider: ctx.provider, coin: soso, from: 'spot', to: 'evm', amount: amt })),
    );
    const n1 = await rec.sub('verify: native SOSO arrived', () =>
      waitFor(ctx, 'SOSO in the ValueChain wallet', { timeoutMs: settleMs(ctx), probe: () => nativeBalance(VALUECHAIN_RPC, owner), done: (v) => v >= n0 + unitsOf(amt, sdp), show: (v) => `wallet SOSO ${v === undefined ? '?' : formatUnits(v, sdp)}` }),
    );
    rec.amount('Spot -> wallet SOSO', amt);
    return { detail: `${amt} SOSO (held in Spot as WSOSO) arrived as native SOSO: the wallet went ${cut(formatUnits(n0, sdp), 8)} -> ${cut(formatUnits(n1, sdp), 8)}`, evidence: { amount: amt, walletBefore: formatUnits(n0, sdp), walletAfter: formatUnits(n1, sdp) } };
  });
}

/**
 * Wallet -> Spot for USDC through transferFunds -> depositFromWallet. The app
 * does it gaslessly: the token's ERC-2612 Permit (spender: the CallForPermit
 * contract) and a CallForPermit wrapping DepositERC20WithPermit, relayed by
 * SoDEX. Both signatures are pinned to this token, this amount and SoDEX's own
 * contracts; so is the relayed request. (The app's earlier path - backend-built
 * approve + depositERC20 sent by the wallet - is accepted on the same terms.)
 */
async function walletToSpot(ctx: Ctx, amountIn: string, title: string): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const amount = canonicalDecimal(amountIn);
  const units = parseUnits(amount, dp);
  const w0 = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner);
  if (w0 < units) throw new SafetyStop(`the ValueChain wallet holds ${formatUnits(w0, dp)} USDC, less than ${amount}`);
  const spot0 = unitsOf((await balancesOf(owner, usdc)).spot, dp);
  const token = usdc.valuechain.token.toLowerCase();
  const exchange = ctx.pre.vc.exchange.toLowerCase();
  const permitContract = CALL_FOR_PERMIT_CONTRACT.toLowerCase();
  const gateway = CLOB_GATEWAY.toLowerCase();
  const signedFrom = ctx.walletSigned.length;
  const txsFrom = ctx.rec.current?.txs.length ?? 0;
  await rec.sub(title, () =>
    armed(
      ctx,
      {
        expect: [
          {
            kind: 'deposit-permit',
            label: `relayed DepositERC20WithPermit ${amount} USDC`,
            check: (r) => (r.deposit?.token === token && r.deposit.amount === units ? null : `deposits ${r.deposit?.amount} of ${r.deposit?.token}, expected ${units} of ${token}`),
          },
          {
            kind: 'deposit-prepare',
            label: `prepare deposit ${amount} USDC`,
            check: (r) => {
              const b = r.body ?? {};
              if (String(b.address).toLowerCase() !== owner) return `for ${b.address}, not this wallet`;
              if (b.coinId !== usdc.assetId) return `coin ${b.coinId}, expected ${usdc.assetId}`;
              if (b.amount !== amount) return `amount ${b.amount}, expected ${amount}`;
              return null;
            },
          },
        ],
        policy: {
          typedData: (td, chainId) => {
            if (chainId !== VALUECHAIN_CHAIN_ID) return 'deposit signatures are signed on ValueChain';
            const d = td.domain as { name?: unknown; verifyingContract?: unknown };
            const m = td.message as Record<string, unknown>;
            if (td.primaryType === 'Permit') {
              // Signature 1: the token's own ERC-2612 permit, spender = SoDEX's CallForPermit contract.
              if (String(d.verifyingContract).toLowerCase() !== token) return `a Permit for token ${String(d.verifyingContract)}, not USDC`;
              if (String(m.owner).toLowerCase() !== owner) return 'a Permit for another owner';
              if (String(m.spender).toLowerCase() !== permitContract) return `a Permit for spender ${String(m.spender)}, not the CallForPermit contract`;
              return String(m.value) === units.toString() ? null : `a Permit for ${String(m.value)}, expected ${units}`;
            }
            if (td.primaryType === 'CallForPermit') {
              // Signature 2: DepositERC20WithPermit into the CLOB gateway, same token and amount.
              if (d.name !== 'SoDexTokenCallForPermit' || String(d.verifyingContract).toLowerCase() !== permitContract) return 'not the SoDEX CallForPermit contract';
              const cmd = (m.cmd ?? {}) as Record<string, unknown>;
              if (String(m.to).toLowerCase() !== gateway) return `a CallForPermit to ${String(m.to)}, not the CLOB gateway`;
              if (String(cmd.token).toLowerCase() !== token || String(cmd.amount) !== units.toString()) return `deposits ${String(cmd.amount)} of ${String(cmd.token)}, expected ${units} of USDC`;
              return null;
            }
            return `unexpected typed data ${td.primaryType}`;
          },
          tx: (t) => {
            if (t.chainId !== VALUECHAIN_CHAIN_ID) return `chain ${t.chainId}, expected ValueChain`;
            if (t.value !== 0n) return 'carries native value';
            try {
              if (t.to === token) {
                const d = decodeFunctionData({ abi: ERC20, data: t.data as `0x${string}` });
                if (d.functionName !== 'approve') return `USDC.${d.functionName} was not expected`;
                const [spender, amt] = d.args as readonly [string, bigint];
                return spender.toLowerCase() === exchange && amt === units ? null : `approve(${spender}, ${amt}) is not approve(exchange, ${units})`;
              }
              if (t.to === exchange) {
                const d = decodeFunctionData({ abi: EXCHANGE, data: t.data as `0x${string}` });
                const [tk, amt] = d.args as readonly [string, bigint];
                return tk.toLowerCase() === token && amt === units ? null : `depositERC20(${tk}, ${amt}) is not depositERC20(USDC, ${units})`;
              }
            } catch {
              return 'calldata is not approve/depositERC20';
            }
            return `to ${t.to}: neither the USDC token nor the exchange`;
          },
        },
      },
      () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'evm', to: 'spot', amount }),
    ),
  );
  await rec.sub('verify: Spot credited', () =>
    waitFor(ctx, 'the deposit in Spot', { timeoutMs: settleMs(ctx), probe: async () => unitsOf((await balancesOf(owner, usdc)).spot, dp), done: (s) => s >= spot0 + units, show: (s) => `Spot USDC ${s === undefined ? '?' : formatUnits(s, dp)} (want >= ${formatUnits(spot0 + units, dp)})` }),
  );
  rec.amount('wallet -> Spot USDC', amount);
  const signed = ctx.walletSigned.slice(signedFrom);
  const txs = (ctx.rec.current?.txs.length ?? 0) - txsFrom;
  return {
    detail: `${amount} USDC went from the ValueChain wallet to Spot ${txs === 0 ? `without a wallet transaction and without gas: ${signed.length} signature(s) (${signed.join(' + ')}), relayed by SoDEX` : `with ${txs} wallet transaction(s)`}`,
    evidence: { amount, walletSignatures: signed, walletTransactions: txs },
  };
}

async function stepEvmToSpot(ctx: Ctx): Promise<void> {
  await moved(ctx, 'transfer-evm-to-spot', () => walletToSpot(ctx, ctx.cfg.evmToSpot.usdc, `ValueChain wallet -> Spot ${ctx.cfg.evmToSpot.usdc} USDC (transferFunds -> depositFromWallet)`));
}

async function stepWithdrawValuechainSelf(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const amount = canonicalDecimal(ctx.cfg.withdrawValuechainSelf.amount);
  const units = parseUnits(amount, dp);
  await ensureTrading(ctx);
  await moved(ctx, 'withdraw-valuechain-self', async () => {
    const b0 = await balancesOf(owner, usdc);
    if (unitsOf(b0.spot, dp) < units) throw new SafetyStop(`Spot holds ${b0.spot} USDC, less than ${amount}`);
    const w0 = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner);
    await rec.sub(`withdrawFunds: ${amount} USDC Spot -> own ValueChain wallet`, () =>
      armed(ctx, { expect: [engineTransfer('spot', TransferType.EVM_WITHDRAW, usdc, amount, 'withdraw to own wallet')] }, () =>
        withdrawFunds({ owner, provider: ctx.provider, coin: usdc, route: 'VALUECHAIN', receiver: owner, amount, sources: { spot: true, perps: false, evm: false } }),
      ),
    );
    const w1 = await rec.sub('verify: the wallet received it', () =>
      waitFor(ctx, 'USDC in the ValueChain wallet', { timeoutMs: settleMs(ctx), probe: () => tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner), done: (v) => v >= w0 + units, show: (v) => `wallet USDC ${v === undefined ? '?' : formatUnits(v, dp)}` }),
    );
    rec.amount('withdrawn to own wallet', `${amount} USDC`);
    return { detail: `the Withdraw path sent ${amount} USDC from Spot to the own ValueChain wallet (an engine transfer, no wallet prompt): the wallet went ${formatUnits(w0, dp)} -> ${formatUnits(w1, dp)}`, evidence: { amount, walletBefore: formatUnits(w0, dp), walletAfter: formatUnits(w1, dp) } };
  });
}

async function stepWithdrawValuechainOther(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const r = receiverNamed(ctx, cfg.withdrawValuechainOther.receiver);
  const to = r.address;
  const bad = receiverProblem('VALUECHAIN', to);
  if (bad) throw new SafetyStop(`receivers.${cfg.withdrawValuechainOther.receiver}: ${bad}`);
  if (r.self) throw new SafetyStop('the receiver is this wallet itself - withdraw-valuechain-other needs a DIFFERENT address');
  if (!allowedReceivers(ctx).has(to.toLowerCase())) throw new SafetyStop(`${to} is not in the config's receivers`);
  const amount = canonicalDecimal(cfg.withdrawValuechainOther.amount);
  const units = parseUnits(amount, dp);
  await ensureTrading(ctx);
  await moved(ctx, 'withdraw-valuechain-other', async () => {
    const b0 = await balancesOf(owner, usdc);
    if (unitsOf(b0.spot, dp) < units) throw new SafetyStop(`Spot holds ${b0.spot} USDC, less than ${amount}`);
    if ((await nativeBalance(VALUECHAIN_RPC, owner)) === 0n) throw new SafetyStop('the ValueChain wallet has no SOSO for the transfer\'s gas');
    const o0 = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, to);
    const token = usdc.valuechain.token.toLowerCase();
    const want = erc20TransferData(to, units).toLowerCase();
    const res = await rec.sub(`withdrawFunds: ${amount} USDC Spot -> ${to} on ValueChain`, () =>
      armed(
        ctx,
        {
          expect: [engineTransfer('spot', TransferType.EVM_WITHDRAW, usdc, amount, 'Spot -> own wallet (then on to the receiver)')],
          policy: {
            tx: (t) => (t.chainId !== VALUECHAIN_CHAIN_ID ? `chain ${t.chainId}` : t.to !== token ? `to ${t.to}, not USDC` : t.value !== 0n ? 'native value' : t.data !== want ? `not transfer(${to}, ${units})` : null),
          },
        },
        () => withdrawFunds({ owner, provider: ctx.provider, coin: usdc, route: 'VALUECHAIN', receiver: to, amount, sources: { spot: true, perps: false, evm: false } }),
      ),
    );
    const hash = 'txHash' in res && res.txHash ? res.txHash : null;
    if (hash) rec.note(`ValueChain transfer ${hash}`);
    const o1 = await rec.sub('verify: the receiver got it', () =>
      waitFor(ctx, `USDC at ${to}`, { timeoutMs: settleMs(ctx), probe: () => tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, to), done: (v) => v >= o0 + units, show: (v) => `receiver USDC ${v === undefined ? '?' : formatUnits(v, dp)}` }),
    );
    ctx.stepSentAwayUsd += approx(amount);
    rec.amount('sent to another ValueChain address', `${amount} USDC -> ${to}`);
    return { detail: `${amount} USDC went Spot -> own wallet -> ${to} (ONE ERC-20 transfer the wallet signed${hash ? `, ${hash}` : ''}): the receiver's USDC went ${formatUnits(o0, dp)} -> ${formatUnits(o1, dp)}`, evidence: { amount, receiver: to, tx: hash } };
  });
}

/** How to read the receiver's balance on the destination chain (every EVM chain the runner reads, chains.ts), or null. */
export async function destinationReader(route: ChainRoute, holder: string): Promise<{ read: () => Promise<bigint>; decimals: number; symbol: string } | null> {
  const chain = evmChain(route.key);
  if (!chain || route.addressKind !== 'evm') return null;
  if (route.isNativeToken) return { read: () => nativeBalance(chain.rpcUrl, holder), decimals: chain.native.decimals, symbol: chain.native.symbol };
  const token = route.tokenAddress?.toLowerCase();
  if (!token || !/^0x[0-9a-f]{40}$/.test(token)) return null;
  const canon = CANONICAL_USDC[route.key];
  let decimals = canon && canon.address === token ? canon.decimals : null;
  if (decimals === null) {
    const hex = (await rpcRead(chain.rpcUrl, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest'])) as string;
    decimals = Number(BigInt(hex));
  }
  return { read: () => tokenBalance(chain.rpcUrl, token, holder), decimals, symbol: token };
}

/** A decimal amount in another token's decimals, cut down. */
const toUnitsCut = (v: string, dp: number): bigint => unitsDown(v, dp);

/**
 * Withdraw `amount` of `coin` from Spot to another chain through the app's
 * withdrawFunds, called as the Withdraw sheet calls it: the on-chain quote
 * first (withdrawQuote), its fee passed back as `expectedFee`. The app then runs
 * SoDEX's own pre-checks (maintenance, the address risk check, blacklist,
 * liquidity), moves Spot -> own ValueChain wallet, has the wallet sign ONE
 * WithdrawToken permit and SoDEX relays it. Followed to the end with
 * withdrawalProgress (the on-chain Withdrawer record) AND the receiver's
 * balance on the destination chain where it can be read.
 */
export async function withdrawTo(ctx: Ctx, o: { coin: CoinConfig; route: ChainRoute; receiverName: string; amount: string }): Promise<{ detail: string; evidence: Record<string, unknown>; costUsd: number }> {
  const { owner, rec } = ctx;
  const { coin, route } = o;
  const dp = coin.valuechain.decimals;
  const r = receiverNamed(ctx, o.receiverName);
  const address = r.address.trim();
  // Every check BEFORE anything is signed.
  if (!allowedReceivers(ctx).has(address.toLowerCase())) throw new SafetyStop(`${address} is neither this wallet nor in the config's receivers`);
  if (!route.withdraw.allowed) throw new SafetyStop(`${coin.coin} withdrawals to ${route.label} are closed right now`);
  if (route.addressKind === 'other') throw new SafetyStop(`the app does not offer ${route.label}`);
  if (r.self && route.addressKind !== 'evm') throw new SafetyStop(`"self" is an EVM address; ${route.label} needs a receiver from the config`);
  if (route.memo === 'numeric' && !r.memo && !r.noMemo) throw new SafetyStop(`${route.label} takes a memo: set "memo" or "noMemo": true on receivers.${o.receiverName}`);
  const bad = receiverProblem(route, address) ?? memoProblem(route, r.memo ?? '', r.noMemo === true);
  if (bad) throw new SafetyStop(`receiver ${address}: ${bad}`);
  const amount = canonicalDecimal(o.amount);
  const units = parseUnits(amount, dp);
  if (route.withdraw.min && units < unitsDown(route.withdraw.min, dp)) throw new SafetyStop(`${amount} ${coin.coin} is below the minimum ${route.withdraw.min} on ${route.label}`);
  await ensureTrading(ctx);

  // The fee and liquidity SoDEX's registry states on-chain - what the Withdraw sheet shows and passes back.
  const quote = await rec.sub(
    `SoDEX's on-chain fee and liquidity for ${coin.coin} -> ${route.label} (withdrawQuote)`,
    () => withdrawQuote(coin, route, owner),
    (q) => `fee ${formatUnits(q.fee, dp)} ${coin.coin}, available ${formatUnits(q.available, dp)}`,
  );
  const fee = formatUnits(quote.fee, dp);
  if (route.withdraw.fee !== null && unitsDown(route.withdraw.fee, dp) !== quote.fee) {
    rec.warn('fee', `SoDEX's asset config says ${route.withdraw.fee} ${coin.coin}, the chain says ${fee} - the chain's fee applies`);
  }
  if (units <= quote.fee) throw new SafetyStop(`${amount} ${coin.coin} does not cover the ${fee} fee`);
  if (units > quote.available) throw new SafetyStop(`SoDEX can pay out only ${formatUnits(quote.available, dp)} ${coin.coin} on ${route.label} right now`);
  const px = await usdPrice(coin.coin);
  const feeUsd = approx(fee) * px;
  if (ctx.spend.costUsd + ctx.spend.sentAwayUsd + feeUsd > ctx.cfg.maxSpendUsd + 1e-9) {
    throw new SafetyStop(`budget: the ${fee} ${coin.coin} fee (${usd(feeUsd)}) would take the run past maxSpendUsd ${usd(ctx.cfg.maxSpendUsd)}`);
  }
  const b0 = await balancesOf(owner, coin);
  if (unitsOf(b0.spot, dp) < units) throw new SafetyStop(`Spot holds ${b0.spot} ${coin.coin}, less than ${amount}`);

  const dest = await destinationReader(route, address).catch(() => null);
  const before = dest ? await dest.read() : null;
  const memo = route.memo === 'numeric' && !r.noMemo ? r.memo ?? '' : '';
  // As the app builds it: an EVM receiver checksummed; a memo rides in "address:memo" AND the memo field.
  const permitReceiver = route.addressKind === 'evm' ? toChecksumAddress(address) : memo ? `${address}:${memo}` : address;
  const permitMatches = (p: { coinSymbol: unknown; chain: unknown; receiver: unknown; amount: unknown; memo?: unknown; withdrawType?: unknown }): string | null => {
    if (p.coinSymbol !== coin.coin) return `coin ${String(p.coinSymbol)}`;
    if (p.chain !== route.key) return `chain ${String(p.chain)}`;
    if (p.receiver !== permitReceiver) return `receiver ${String(p.receiver)}, expected ${permitReceiver}`;
    if (String(p.amount) !== units.toString()) return `amount ${String(p.amount)}, expected ${units}`;
    if ((p.memo ?? '') !== memo) return `memo "${String(p.memo)}"`;
    if (p.withdrawType !== undefined && Number(p.withdrawType) !== route.withdrawType) return `withdrawType ${String(p.withdrawType)}`;
    return null;
  };
  const t0 = Date.now();
  const res = await rec.sub(`withdrawFunds: ${amount} ${coin.coin} -> ${route.label} ${o.receiverName === 'self' ? '(this wallet)' : `(${o.receiverName} ${address})`}, fee ${fee}`, () =>
    armed(
      ctx,
      {
        expect: [
          engineTransfer('spot', TransferType.EVM_WITHDRAW, coin, amount, `Spot -> own wallet (${coin.coin}, the permit's source)`),
          ...(route.withdrawType === 0
            ? [{ kind: 'kyt-check' as const, label: `SoDEX address risk check for ${address}`, check: (w: { body: any }) => (String(w.body?.address ?? '') === address ? null : `for ${String(w.body?.address)}, not ${address}`) }]
            : []),
          {
            kind: 'withdraw-permit',
            label: `permit ${amount} ${coin.coin} -> ${route.key} ${permitReceiver}`,
            check: (w) => (w.permit ? permitMatches(w.permit) : 'no permit'),
          },
        ],
        policy: {
          typedData: (td, chainId) => {
            if (td.primaryType !== 'CallForPermit') return `unexpected typed data ${td.primaryType}`;
            if (chainId !== VALUECHAIN_CHAIN_ID) return 'a permit must be signed on ValueChain';
            const d = td.domain as { name?: unknown; verifyingContract?: unknown };
            if (d.name !== 'SoDexTokenCallForPermit' || String(d.verifyingContract).toLowerCase() !== CALL_FOR_PERMIT_CONTRACT.toLowerCase()) return 'not the SoDEX permit contract';
            const m = td.message as { to?: unknown; cmd?: Record<string, unknown> };
            if (String(m.to).toLowerCase() !== WITHDRAW_TOKEN_TARGET.toLowerCase()) return 'not a WithdrawToken command';
            const c = m.cmd ?? {};
            const why = permitMatches({ coinSymbol: c.coinSymbol, chain: c.chain, receiver: c.receiver, amount: c.amount, memo: c.memo, withdrawType: c.withdrawType });
            return why ? `the permit is not what this step expects: ${why}` : null;
          },
        },
      },
      () => withdrawFunds({ owner, provider: ctx.provider, coin, route, receiver: address, memo, amount, sources: { spot: true, perps: false, evm: false }, expectedFee: quote.fee }),
    ),
  );
  const txHash = 'txHash' in res && res.txHash ? res.txHash : '';
  const withdrawId = 'withdrawId' in res ? res.withdrawId : null;
  if (!txHash && !withdrawId && !dest) {
    throw new Error(`SoDEX accepted the withdrawal without a transaction to follow, and ${route.label} cannot be read from here - check the Withdraw sheet before retrying (the app refuses to send a second permit while this one may still run)`);
  }
  if (txHash) rec.tx({ chain: 'VALUECHAIN', hash: txHash, what: `SoDEX relayed permit: ${amount} ${coin.coin} -> ${route.label}`, explorer: explorer(ctx, 'VALUECHAIN', txHash) });
  if (withdrawId) rec.note(`SoDEX withdrawal id ${withdrawId}`);
  const flight = { what: `${amount} ${coin.coin} withdrawal to ${route.label} ${permitReceiver} (fee ${fee})`, since: Date.now(), ref: txHash ? `ValueChain tx ${txHash}` : withdrawId ? `withdrawal ${withdrawId}` : undefined };
  ctx.inFlight.push(flight);
  const net = dSub(amount, fee);
  const want = dest ? toUnitsCut(net, dest.decimals) : 0n;
  const arrived = (bal: bigint | null) => !!dest && before !== null && bal !== null && bal >= before + want;
  // withdrawalProgress is polled as the Withdraw sheet polls it; the destination balance is read alongside,
  // so a record the app cannot read (or a status it never calls final) cannot hang the run.
  const seen = await rec.sub(
    'verify: SoDEX\'s withdrawal record is final (withdrawalProgress, as the Withdraw sheet polls it)',
    () =>
      waitFor(ctx, `the withdrawal to ${route.label}`, {
        timeoutMs: ctx.cfg.timeouts.withdrawMinutes * 60_000,
        intervalMs: 10_000,
        probe: async () => ({
          p: txHash || withdrawId ? await withdrawalProgress({ withdrawId, txHash }).catch(() => null) : null,
          bal: dest ? await dest.read().catch(() => null) : null,
        }),
        done: (v) => !!v.p?.done || arrived(v.bal),
        show: (v) => `${v?.p ? v.p.status : 'no record yet'}${dest && v?.bal !== undefined && v.bal !== null ? `, ${route.label} balance ${formatUnits(v.bal, dest.decimals)}` : ''}`,
      }),
    (v) => v.p?.status ?? 'no record',
  );
  const p = seen.p;
  if (p?.done && !p.ok) {
    flight.what += ` - SoDEX's record says "${p.status}" (a failed withdrawal paid from Spot is credited back to Spot)`;
    throw new Error(`the withdrawal to ${route.label} ended as "${p.status}"`);
  }
  let recordNote = `SoDEX's record: "${p?.status ?? 'none read'}"`;
  if (!p?.done) {
    recordNote = `the funds arrived, but withdrawalProgress() does not report the withdrawal final (${p ? `"${p.status}"` : 'no record read'}) - the Withdraw sheet would not show "Completed"`;
    rec.warn('withdrawal record', recordNote);
  }
  if (p?.destinationTx) rec.tx({ chain: route.key, hash: p.destinationTx, what: `SoDEX payout on ${route.label}`, ...(evmChain(route.key) ? { explorer: explorer(ctx, route.key, p.destinationTx) } : {}) });
  let received: string | null = null;
  if (dest && before !== null) {
    const after = await rec.sub(`verify: ${cut(net, 8)} arrived on ${route.label}`, () =>
      waitFor(ctx, `the funds on ${route.label}`, {
        timeoutMs: 15 * 60_000,
        intervalMs: 10_000,
        probe: dest.read,
        done: (v) => v >= before + want,
        show: (v) => `balance ${v === undefined ? '?' : formatUnits(v, dest.decimals)} (want >= ${formatUnits(before + want, dest.decimals)})`,
      }),
    );
    received = formatUnits(after - before, dest.decimals);
    rec.amount(`withdrawn to ${route.label}`, `${amount} ${coin.coin} sent, ${received} received`);
    rec.fee(`withdrawal ${coin.coin} -> ${route.label}`, `${cut(dSub(amount, received), 12)} ${coin.coin} (on-chain fee ${fee}${p?.fee !== null && p?.fee !== undefined ? `, record says ${formatUnits(p.fee, dp)}` : ''})`);
  } else {
    rec.note(`arrival on ${route.label} cannot be read from here - SoDEX's record "${p?.status ?? '?'}" is the evidence`);
    rec.amount(`withdrawn to ${route.label}`, `${amount} ${coin.coin} (fee ${fee}, net ${net})`);
    rec.fee(`withdrawal ${coin.coin} -> ${route.label}`, `${p?.fee !== null && p?.fee !== undefined ? formatUnits(p.fee, dp) : fee} ${coin.coin}`);
  }
  ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
  if (!r.self) ctx.stepSentAwayUsd += approx(net) * px;
  return {
    detail: `${amount} ${coin.coin} -> ${route.label} ${o.receiverName === 'self' ? '(this wallet)' : `(${o.receiverName})`}: ONE permit signature, relayed by SoDEX; ${received !== null ? `${received} arrived on ${route.label} (fee ${fee} ${coin.coin})` : `arrival cannot be read on ${route.label} from this computer`}; ${recordNote}; ${Math.round((Date.now() - t0) / 1000)} s`,
    evidence: { coin: coin.coin, chain: route.key, receiver: permitReceiver, amount, fee, received, relayTx: txHash || null, withdrawId, payoutTx: p?.destinationTx ?? null, recordStatus: p?.status ?? null, arrivalVerified: received !== null },
    costUsd: feeUsd,
  };
}

const amountFor = async (ctx: Ctx, coin: CoinConfig, route: ChainRoute, spec: string): Promise<string> => {
  if (spec === 'min') {
    if (!route.withdraw.min) throw new SafetyStop(`SoDEX lists no withdrawal minimum for ${coin.coin} on ${route.label} - give an amount`);
    return route.withdraw.min;
  }
  if (spec === 'all') return (await balancesOf(ctx.owner, coin)).spot;
  if (!isDecimal(spec)) throw new SafetyStop(`not an amount: ${spec}`);
  return spec;
};

async function stepWithdrawExternal(ctx: Ctx): Promise<void> {
  const w = ctx.cfg.withdrawExternal;
  await moved(ctx, routeCheck(ctx, 'withdraw-external', 0), async () => {
    const coin = coinNamed(ctx, w.coin);
    const route = routeOf(coin, w.chain);
    return withdrawTo(ctx, { coin, route, receiverName: w.receiver, amount: await amountFor(ctx, coin, route, w.amount) });
  });
}

async function stepExtraDeposits(ctx: Ctx): Promise<void> {
  if (!(await sodexAccountId(ctx.owner))) throw new SafetyStop('extra deposits expect the account to exist (run deposit-external first)');
  for (const [i, d] of ctx.cfg.extraDeposits.entries()) await moved(ctx, routeCheck(ctx, 'extra-deposits', i), () => depositOne(ctx, d.chain, d.amount));
}

/** Market-buy what is missing of `coin` so Spot holds `amount` (costs a taker fee + spread). Through the app's placeOrder. */
export async function buyOnSpot(ctx: Ctx, coin: CoinConfig, amount: string, tag: string): Promise<void> {
  const { owner, rec } = ctx;
  const dp = coin.valuechain.decimals;
  const b0 = await balancesOf(owner, coin);
  const missing = dSub(amount, b0.spot);
  if (dCmp(missing, '0') <= 0) return;
  const m = await spotMarketFor(coin);
  const q = toStep(dMax(marketQty(m, 10), dDiv(missing, String(1 - approx(m.sym.takerFee) - 0.0005), 'ceil')), m.sym.stepSize || '0', 'ceil');
  const cost = dMul(q, m.ask);
  const u0 = await balancesOf(owner, ctx.pre.usdc);
  if (approx(u0.spot) < approx(cost) * 1.05) throw new SafetyStop(`buying ${q} ${coin.coin} needs ~${cut(cost, 4)} USDC; Spot holds ${u0.spot}`);
  const placed = await rec.sub(`spot ${m.sym.name}: market BUY ${q} ${coin.coin} (~${cut(cost, 4)} USDC) - Spot held ${b0.spot}, needs ${amount}`, () =>
    mustPlace(ctx, { market: m, side: 'buy', type: 'market', quantity: q, tag, label: `buy ${q} ${coin.coin} for the withdrawal` }),
  );
  const b1 = await rec.sub(`verify: Spot holds >= ${amount} ${coin.coin}`, () =>
    waitFor(ctx, `${coin.coin} in Spot`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => balancesOf(owner, coin), done: (b) => unitsDown(b.spot, dp) >= unitsDown(amount, dp), show: (b) => `Spot ${coin.coin} ${b?.spot ?? '?'}` }),
  );
  const s = await settleFills(ctx, m, placed.id, q);
  const u1 = await balancesOf(owner, ctx.pre.usdc);
  const udp = ctx.pre.usdc.valuechain.decimals;
  rec.amount(`bought ${coin.coin}`, `${formatUnits(unitsDown(b1.spot, dp) - unitsDown(b0.spot, dp), dp)} ${coin.coin} for ${formatUnits(unitsDown(u0.spot, udp) - unitsDown(u1.spot, udp), udp)} USDC (whatever is not withdrawn stays in Spot); ${s.note}`);
}

async function stepExtraWithdrawals(ctx: Ctx): Promise<void> {
  for (const [i, x] of ctx.cfg.extraWithdrawals.entries()) {
    const id = routeCheck(ctx, 'extra-withdrawals', i);
    await moved(ctx, id, async () => {
      const coin = coinNamed(ctx, x.coin);
      const route = routeOf(coin, x.chain);
      const amount = await amountFor(ctx, coin, route, x.amount);
      const held = (await balancesOf(ctx.owner, coin)).spot;
      if (dCmp(held, amount) < 0) {
        if (!x.buyIfMissing) throw new SafetyStop(`Spot holds ${held} ${coin.coin}, less than ${amount} (buyIfMissing is off)`);
        await buyOnSpot(ctx, coin, amount, id);
      }
      return withdrawTo(ctx, { coin, route, receiverName: x.receiver, amount });
    });
  }
}

async function stepCleanup(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  await ensureTrading(ctx);
  await moved(ctx, 'cleanup-sweep', async () => {
    const parts: string[] = [];
    const b = await balancesOf(owner, usdc);
    if (unitsOf(b.perps, dp) > 0n) {
      const amt = formatUnits(unitsOf(b.perps, dp), dp);
      await rec.sub(`Perps -> Spot ${amt} USDC`, () =>
        armed(ctx, { expect: [engineTransfer('perps', TransferType.SPOT_WITHDRAW, usdc, amt, 'cleanup Perps -> Spot')] }, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'perps', to: 'spot', amount: amt })),
      );
      await rec.sub('verify: in Spot', () =>
        waitFor(ctx, 'Perps USDC back in Spot', { timeoutMs: settleMs(ctx), probe: () => balancesOf(owner, usdc), done: (x) => unitsOf(x.spot, dp) >= unitsOf(b.spot, dp) + unitsOf(amt, dp), show: (x) => `Spot ${x?.spot ?? '?'}` }),
      );
      parts.push(`Perps -> Spot ${amt} USDC`);
    }
    const w = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner);
    if (w > 0n) {
      await walletToSpot(ctx, formatUnits(w, dp), `ValueChain wallet -> Spot ${formatUnits(w, dp)} USDC (all)`);
      parts.push(`ValueChain wallet -> Spot ${formatUnits(w, dp)} USDC`);
    }
    const route = routeOf(usdc, ctx.cfg.cleanup.chain);
    const spot = (await balancesOf(owner, usdc)).spot;
    if (route.withdraw.min && unitsOf(spot, dp) < unitsDown(route.withdraw.min, dp)) {
      rec.warn('cleanup withdrawal', `Spot holds ${spot} USDC, below the ${route.withdraw.min} minimum on ${route.label} - left in Spot`);
      return { detail: `${parts.join('; ') || 'nothing to move'}; Spot holds ${spot} USDC, below the ${route.withdraw.min} minimum on ${route.label}: left in Spot`, evidence: { leftInSpot: spot } };
    }
    const out = await withdrawTo(ctx, { coin: usdc, route, receiverName: 'self', amount: spot });
    return { detail: `${[...parts, out.detail].join('; ')}`, evidence: out.evidence, costUsd: out.costUsd };
  });
}

export const STEPS: Record<StepId, (ctx: Ctx) => Promise<void>> = {
  'deposit-external': stepDepositExternal,
  'enable-trading': stepEnableTrading,
  transfers: stepTransfers,
  'builder-tiers': stepBuilderTiers,
  'orders-spot': stepOrdersSpot,
  'orders-perps': stepOrdersPerps,
  refusals: stepRefusals,
  'spot-to-evm': stepSpotToEvm,
  'evm-to-spot': stepEvmToSpot,
  'withdraw-valuechain-self': stepWithdrawValuechainSelf,
  'withdraw-valuechain-other': stepWithdrawValuechainOther,
  'withdraw-external': stepWithdrawExternal,
  'extra-deposits': stepExtraDeposits,
  'extra-withdrawals': stepExtraWithdrawals,
  'evm-tour': stepEvmTour,
  'chain-withdrawals': stepChainWithdrawals,
  'manual-deposits': stepManualDeposits,
  'key-lifecycle': stepKeyLifecycle,
  cleanup: stepCleanup,
  'cross-check': stepCrossCheck,
  'revoke-builder': stepRevokeBuilder,
};
