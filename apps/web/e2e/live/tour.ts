/**
 * The evm-tour's planning half, pure (plan.ts and the step both use it): which
 * EVM chains are toured, which legs run on each and why the others do not, the
 * amounts, the gas kept back, and the one write the runner itself sends there -
 * the native-coin transfer - with its guard expectation and its wallet policy.
 */
import { canonicalDecimal } from '@sodex-core';
import type { ChainRoute, CoinConfig } from '../../src/trading/funds';
import { CANONICAL_USDC } from '../../src/trading/onboard';
import { GAS_FLOOR, appSendsUsdc, chainRank, evmChain, type EvmSpec } from './chains';
import { depositCheckId, withdrawCheckId } from './checks';
import type { RunConfig } from './config';
import type { Ctx, StepId } from './context';
import type { Expectation } from './guard';
import type { ProviderPolicy } from './provider';
import { gasPrice } from './reads';
import { dAdd, dCmp, dMax, dMul, dSub, toStep } from './util';

// --- which chains, which legs ---------------------------------------------------------------------

export interface TourLeg {
  chain: string;
  label: string;
  spec: EvmSpec;
  /** 'native': the chain's own coin, sent back by a plain transfer; 'usdc': the ERC-20, sent back with sendUsdcDeposit. */
  kind: 'native' | 'usdc';
  coin: CoinConfig;
  route: ChainRoute;
  /** Why this leg does not run (null: it runs). */
  skip: string | null;
}

export interface TourChain {
  chain: string;
  label: string;
  spec: EvmSpec;
  legs: TourLeg[];
  /** The USDC leg runs but no native leg does: the gas for the USDC deposit back must come from the owner. */
  ownerGas: boolean;
}

export interface TourPlan {
  chains: TourChain[];
  /** EVM chains SoDEX lists that the tour does not visit, and why. */
  left: Array<{ chain: string; label: string; why: string }>;
}

/** The chains and legs of the tour, from SoDEX's live asset config and the run's config. */
export function tourPlan(coins: readonly CoinConfig[], cfg: RunConfig, selected: ReadonlySet<StepId>): TourPlan {
  const usdc = coins.find((c) => c.coin.toUpperCase() === 'USDC');
  const keys = new Set<string>();
  for (const c of coins) for (const r of c.chains) if (r.addressKind === 'evm') keys.add(r.key);
  const out: TourPlan = { chains: [], left: [] };
  const coveredByCore =
    selected.has('deposit-external') && selected.has('withdraw-external') && cfg.withdrawExternal.coin.toUpperCase() === 'USDC' && cfg.withdrawExternal.receiver === 'self' && cfg.withdrawExternal.chain === cfg.deposit.chain;
  for (const key of [...keys].sort((a, b) => chainRank(a) - chainRank(b) || a.localeCompare(b))) {
    const spec = evmChain(key);
    const label = spec?.name ?? key;
    if (cfg.evmTour.chains !== 'all' && !cfg.evmTour.chains.includes(key)) {
      out.left.push({ chain: key, label, why: 'not in evmTour.chains' });
      continue;
    }
    if (cfg.evmTour.skip.includes(key)) {
      out.left.push({ chain: key, label, why: 'in evmTour.skip' });
      continue;
    }
    if (!spec) {
      out.left.push({ chain: key, label, why: 'the runner has no chain id and public RPC for it (chains.ts)' });
      continue;
    }
    const legs: TourLeg[] = [];
    const nativeCoin = coins.find((c) => c.chains.some((r) => r.key === key && r.isNativeToken));
    if (nativeCoin) {
      const route = nativeCoin.chains.find((r) => r.key === key && r.isNativeToken)!;
      legs.push({ chain: key, label, spec, kind: 'native', coin: nativeCoin, route, skip: legSkip(nativeCoin, route) });
    }
    const ur = usdc?.chains.find((r) => r.key === key && !r.isNativeToken);
    if (usdc && ur) {
      let skip = legSkip(usdc, ur);
      if (!skip && !appSendsUsdc(key)) skip = `the app sends USDC deposits only from its own chains (sendUsdcDeposit), not from ${label}`;
      if (!skip && (ur.tokenAddress ?? '').toLowerCase() !== CANONICAL_USDC[key]?.address) skip = `SoDEX lists ${ur.tokenAddress ?? 'no token'} as USDC on ${label}, not the canonical USDC - the app does not offer it`;
      if (!skip && coveredByCore && key === cfg.deposit.chain) skip = `covered in this run by deposit-external and withdraw-external (USDC on ${label}, both ways)`;
      legs.push({ chain: key, label, spec, kind: 'usdc', coin: usdc, route: ur, skip });
    }
    if (!legs.length) {
      out.left.push({ chain: key, label, why: 'SoDEX lists neither its native coin nor USDC there' });
      continue;
    }
    const runs = (k: TourLeg['kind']) => legs.some((l) => l.kind === k && !l.skip);
    out.chains.push({ chain: key, label, spec, legs, ownerGas: runs('usdc') && !runs('native') });
  }
  return out;
}

function legSkip(coin: CoinConfig, route: ChainRoute): string | null {
  if (coin.assetId === null) return `${coin.coin} is not tradable on SoDEX`;
  if (route.withdrawType === 1) return `${coin.coin} is paid out through SoDEX's bridge, not its custodian`;
  if (!route.withdraw.allowed && !route.deposit.allowed) return `${coin.coin} on ${route.label}: deposits and withdrawals are closed on SoDEX right now`;
  if (!route.withdraw.allowed) return `${coin.coin} withdrawals to ${route.label} are closed on SoDEX right now`;
  if (!route.deposit.allowed) return `${coin.coin} deposits from ${route.label} are closed on SoDEX right now`;
  if (!route.withdraw.min) return `SoDEX lists no withdrawal minimum for ${coin.coin} on ${route.label}`;
  return null;
}

/** Routes SoDEX issues no deposit address on at all (sodex.com shows none): USDC on Arc (verified 2026-09-26, again 2026-10-03). */
export const NO_DEPOSIT_ADDRESS: ReadonlySet<string> = new Set(['USDC|ARC']);

/**
 * Why a leg's deposit BACK cannot run - decided before anything is withdrawn, so the coins never leave for a
 * chain they cannot come back from: a route SoDEX issues no address on, or a chain missing from the wallet's
 * deposit addresses for that coin while SoDEX has issued it others (`listed`: the on-chain registry's
 * chain -> address for the leg's coin; null when it could not be read). null: it can run.
 */
export function depositBackProblem(leg: Pick<TourLeg, 'chain' | 'label' | 'coin'>, listed: ReadonlyMap<string, string> | null): string | null {
  if (NO_DEPOSIT_ADDRESS.has(`${leg.coin.coin.toUpperCase()}|${leg.chain}`)) return `SoDEX issues no ${leg.coin.coin} deposit address on ${leg.label}`;
  if (listed && listed.size > 0 && !listed.has(leg.chain)) return `SoDEX has issued this wallet ${leg.coin.coin} deposit addresses on other chains, but none on ${leg.label}`;
  return null;
}

/** The checks of the tour, one per leg and direction (declared with the other funds checks). */
export function declareTourChecks(ctx: Ctx, add: (key: string, area: 'deposits' | 'withdrawals', direction: 'deposit' | 'withdraw', coin: string, chain: string, title: string, id: string) => void): void {
  for (const tc of tourPlan(ctx.pre.coins, ctx.cfg, ctx.selected).chains) {
    for (const leg of tc.legs) {
      const what = leg.kind === 'native' ? `${leg.coin.coin} (the chain's native coin)` : 'USDC';
      add(`${leg.chain}#${leg.kind}#withdraw`, 'withdrawals', 'withdraw', leg.coin.coin, leg.chain, `Tour: withdrawal of ${what} to this wallet on ${leg.label} arrives (SoDEX's record is final, the balance there rose)`, withdrawCheckId(leg.coin.coin, leg.chain));
      add(
        `${leg.chain}#${leg.kind}#deposit`,
        'deposits',
        'deposit',
        leg.coin.coin,
        leg.chain,
        leg.kind === 'native'
          ? `Tour: ${what} sent back from ${leg.label} to the wallet's verified SoDEX deposit address (a plain transfer the runner signs - DIRECT) is credited to Spot`
          : `Tour: USDC sent back from ${leg.label} with the app's sendUsdcDeposit is credited to Spot`,
        depositCheckId(leg.coin.coin, leg.chain),
      );
    }
  }
}

// --- amounts ---------------------------------------------------------------------------------------

const step = (dp: number): string => (dp <= 0 ? '1' : `0.${'0'.repeat(dp - 1)}1`);

/** What a deposit back must at least be: SoDEX's deposit minimum + 2 % (a minimum read hours earlier, or applied as "more than", still credits it). */
export function depositFloor(route: ChainRoute, dp: number): string {
  const min = route.deposit.min ?? '0';
  return dCmp(min, '0') > 0 ? toStep(dMul(min, '1.02'), step(Math.min(dp, 8)), 'ceil') : '0';
}

/**
 * How much a round trip to the test wallet's own address withdraws: what the transfer back needs there (`need`:
 * SoDEX's deposit minimum + 2 %, and for a chain's native coin its fees and what must stay), less what an earlier
 * run already left there (`have` - a deposit back that could not run), plus SoDEX's fee. Never below SoDEX's
 * withdrawal minimum, and never nothing: the withdrawal is tested in every run, the coins already there go back with it.
 */
export function roundTripWithdrawal(o: { need: string; have: string; min: string | null; fee: string; dp: number }): string {
  const s = step(o.dp);
  const missing = dCmp(o.have, o.need) >= 0 ? '0' : dSub(o.need, o.have);
  return toStep(dMax(o.min ?? '0', dAdd(dAdd(missing, o.fee), s)), s, 'ceil');
}

/** A coin out only (its way back cannot run): the withdrawal minimum, and more than the fee. */
export function oneWayAmount(route: ChainRoute, coin: CoinConfig, fee: string): string {
  const dp = Math.min(coin.valuechain.decimals, 6);
  return toStep(dMax(route.withdraw.min ?? '0', dAdd(fee, step(dp))), step(dp), 'ceil');
}

/**
 * A withdrawal the owner could send straight back: at least SoDEX's withdrawal
 * minimum, and enough that what arrives (less the fee) clears the deposit
 * minimum - never a withdrawal of the minimum that the fee would eat.
 */
export function roundTripAmount(route: ChainRoute, coin: CoinConfig, fee: string): string {
  const dp = Math.min(coin.valuechain.decimals, 6);
  return toStep(dMax(route.withdraw.min ?? '0', dAdd(route.deposit.min ?? '0', fee)), step(dp), 'ceil');
}

/** USDC out and back: at least the withdrawal minimum, and enough that what arrives clears the deposit minimum. */
export function usdcLegAmounts(route: ChainRoute, fee: string): { withdraw: string; back: string } {
  const need = dMax(route.withdraw.min ?? '0', dAdd(depositFloor(route, 6), fee));
  const withdraw = toStep(need, '0.01', 'ceil');
  return { withdraw, back: dSub(withdraw, fee) };
}

/** USDC out only (no way back - e.g. no gas for the deposit back): the withdrawal minimum, and more than the fee. */
export function oneWayUsdcAmount(route: ChainRoute, fee: string): string {
  return toStep(dMax(route.withdraw.min ?? '0', dAdd(fee, '0.01')), '0.01', 'ceil');
}

/**
 * A native coin out and back: what arrives must clear the deposit minimum AND
 * leave `reserve` for gas (the transfer back, and the USDC deposit after it).
 */
export function nativeLegAmounts(route: ChainRoute, coin: CoinConfig, fee: string, reserve: string): { withdraw: string; back: string } {
  const dp = Math.min(coin.valuechain.decimals, 6);
  const floor = depositFloor(route, dp);
  const need = dMax(route.withdraw.min ?? '0', dAdd(dAdd(floor, fee), reserve));
  const withdraw = toStep(need, step(dp), 'ceil');
  return { withdraw, back: dMax(floor, toStep(dSub(dSub(withdraw, fee), reserve), step(dp), 'floor')) };
}

/** Gas units the native coin must cover on a chain: the transfer back, plus the USDC deposit when that leg runs and no other gas is there. */
export const reserveGasUnits = (usdcLegRuns: boolean): number => 21_000 + (usdcLegRuns ? 65_000 : 0);

/** The native coin to keep for gas: today's gas price x units x 3, at least the chain's floor. */
export async function gasReserve(spec: EvmSpec, units: number): Promise<string> {
  const floor = GAS_FLOOR[spec.key] ?? 0.001;
  let v = floor;
  try {
    const gp = await gasPrice(spec.rpcUrl);
    v = Math.max(floor, (Number(gp) * units * 3) / 10 ** spec.native.decimals);
  } catch {
    /* the floor */
  }
  return canonicalDecimal(v.toFixed(Math.min(8, spec.native.decimals)));
}

// --- the native transfer: its guard expectation and its wallet policy ------------------------------------

export interface NativeTransfer {
  chainId: number;
  /** The wallet (lower-case). */
  from: string;
  /** The verified deposit address (lower-case). */
  to: string;
  /** Exactly this much, in the chain's base units. */
  value: bigint;
  label: string;
}

/** The network guard lets out exactly ONE raw transaction: this chain, this signer, this receiver, this value, no calldata. */
export function nativeTransferExpect(t: NativeTransfer): Expectation {
  return {
    kind: 'native-transfer',
    label: t.label,
    check: (r) => {
      const x = r.tx;
      if (!x) return 'not a decoded transaction';
      if (x.chainId !== t.chainId) return `chain ${x.chainId}, expected ${t.chainId}`;
      if (x.from !== t.from) return `signed by ${x.from}, expected ${t.from}`;
      if (x.to !== t.to) return `to ${x.to}, expected the verified deposit address ${t.to}`;
      if (x.value !== t.value) return `value ${x.value}, expected ${t.value}`;
      if (x.data !== '0x') return 'carries calldata';
      return null;
    },
  };
}

/** The wallet signs exactly ONE such transfer - nothing else, no second one. */
export function nativeTransferPolicy(t: Omit<NativeTransfer, 'label' | 'from'>): ProviderPolicy {
  let sent = 0;
  return {
    tx: (x) => {
      if (x.chainId !== t.chainId) return `chain ${x.chainId}, expected ${t.chainId}`;
      if (x.to !== t.to) return `to ${x.to}, not the verified deposit address ${t.to}`;
      if (x.value !== t.value) return `value ${x.value}, expected ${t.value}`;
      if (x.data !== '0x') return 'carries calldata - a native-coin deposit is a plain transfer';
      if (sent >= 1) return 'a second transfer - this step sends exactly one';
      sent += 1;
      return null;
    },
  };
}
