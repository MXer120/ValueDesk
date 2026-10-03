/**
 * The deposits the OWNER sends by hand from their own wallet (profile
 * all-chains, the guided "full test"), planned - pure: plan.ts and the steps
 * both use it.
 *
 * A full test is a round trip per chain the runner cannot sign on:
 *
 *   withdraw-first   the coin has a USDC spot market: chain-withdrawals buys it
 *                    and withdraws it to the owner's own address there
 *                    (`receivers.<chain>`); the owner then sends `sendBack` to
 *                    the wallet's verified SoDEX deposit address. The withdrawal
 *                    is sized so that what ARRIVES covers `sendBack` (at least
 *                    SoDEX's deposit minimum), the owner's wallet fee and what a
 *                    chain keeps at an address (XRP / Stellar reserve, Solana
 *                    rent, Cardano's minimum output) - the owner needs nothing of
 *                    their own. On Solana the SOL withdrawal also carries the SOL
 *                    the USDC / USDT sends need for their fees.
 *   deposit-first    no spot market (TON): nothing can be bought with USDC, so
 *                    the owner sends first (`sendBack`, enough that the
 *                    withdrawal back clears SoDEX's minimum and fee) and the run
 *                    withdraws what was credited back to the owner. Without that
 *                    send the withdrawal is not testable from USDC alone.
 *
 * NEVER below the deposit minimum: `sendBack` is at least SoDEX's deposit
 * minimum on that chain, with the owner's network fee ON TOP (a deposit below
 * the minimum is not credited). The wallet figures are typical ceilings - the
 * owner's wallet shows the exact fee before sending.
 */
import type { ChainRoute, CoinConfig } from '../../src/trading/funds';
import { chainWithdrawals, type ChainWithdrawal } from './chainRoutes';
import type { ManualDeposit, RunConfig } from './config';
import { roundTripAmount } from './tour';
import { dAdd, dCmp, dMax, dMul, dSub, toStep } from './util';

/** What a self-custody wallet (SafePal and the like) costs to SEND from a chain: a typical ceiling, and what must stay at the address. */
export interface OwnerWallet {
  /** The network fee of one send of the chain's native coin, in that coin. */
  fee: string;
  /** What stays at the address after a send (reserve, rent, minimum output), in the native coin. */
  keep: string;
  keepWhy: string | null;
  /** The fee of one TOKEN send on this chain (USDC / USDT on Solana), in the native coin. */
  tokenFee: string | null;
  tokenFeeWhy: string | null;
}

/** Typical ceilings as of 2026-10 (each chain's own documentation; the wallet shows the exact fee). */
export const OWNER_WALLET: Readonly<Record<string, OwnerWallet>> = {
  BTC: { fee: '0.00003', keep: '0', keepWhy: null, tokenFee: null, tokenFeeWhy: null },
  LTC: { fee: '0.0001', keep: '0', keepWhy: null, tokenFee: null, tokenFeeWhy: null },
  DOGE: { fee: '1', keep: '0', keepWhy: null, tokenFee: null, tokenFeeWhy: null },
  ADA: { fee: '0.3', keep: '1', keepWhy: "Cardano's minimum per output (about 1 ADA): what is left at the address after a send must be at least that", tokenFee: null, tokenFeeWhy: null },
  SOL: {
    fee: '0.00001',
    keep: '0.00089088',
    keepWhy: "Solana's rent-exempt minimum of a wallet account (0.00089088 SOL)",
    tokenFee: '0.00205',
    tokenFeeWhy: "the network fee plus the rent of the deposit address's token account (0.00203928 SOL), which the sender pays when that account does not exist yet",
  },
  SUI: { fee: '0.01', keep: '0', keepWhy: null, tokenFee: null, tokenFeeWhy: null },
  TON: { fee: '0.05', keep: '0', keepWhy: null, tokenFee: null, tokenFeeWhy: null },
  XLM: { fee: '0.00001', keep: '1', keepWhy: "Stellar's minimum balance of an account (2 x 0.5 XLM base reserve) - it stays at the address", tokenFee: null, tokenFeeWhy: null },
  XRP: { fee: '0.00002', keep: '1', keepWhy: "the XRP Ledger's base reserve (1 XRP) - it stays at the address for good", tokenFee: null, tokenFeeWhy: null },
};

const NO_WALLET: OwnerWallet = { fee: '0', keep: '0', keepWhy: null, tokenFee: null, tokenFeeWhy: null };

const stepOf = (coin: CoinConfig): string => {
  const dp = Math.min(coin.valuechain.decimals, 6);
  return dp <= 0 ? '1' : `0.${'0'.repeat(dp - 1)}1`;
};

/** One hand-sent deposit, planned. Every amount is a decimal string. */
export interface HandPlan {
  coin: string;
  chain: string;
  label: string;
  order: 'withdraw-first' | 'deposit-first';
  /** What the run withdraws to the owner's address (withdraw-first), or back after the deposit (deposit-first). */
  withdraw: string;
  /** What lands at the owner's address from that withdrawal. */
  arrives: string;
  /** What the owner sends to the verified SoDEX deposit address - never below `depositMin`. */
  sendBack: string;
  depositMin: string;
  /** SoDEX's withdrawal fee (the chain's, as read). */
  sodexFee: string;
  /** The owner's wallet fee for this send, and the coin it is paid in. */
  walletFee: string;
  feeCoin: string;
  walletFeeWhy: string | null;
  /** What stays at the owner's address (in `coin`), and why. */
  keep: string;
  keepWhy: string | null;
  /** What the owner must already hold of `coin` before (0: the run's withdrawal covers everything). */
  needFirst: string;
  /** ... and of the fee coin when it is another coin (a token send's fee in SOL). */
  needFirstFeeCoin: string;
}

/**
 * Plan one hand-sent deposit.
 *   market            SoDEX has a <coin>/USDC spot market (the run can buy it: withdraw first)
 *   nativeCarriesFees the chain's native coin is withdrawn to the owner too, and carries the fees of the token sends
 *   tokenSends        how many token sends on this chain that native withdrawal must carry the fees of
 */
export function handPlan(route: ChainRoute, coin: CoinConfig, sodexFee: string, o: { market: boolean; nativeCoin: string; nativeCarriesFees: boolean; tokenSends: number }): HandPlan {
  const w = OWNER_WALLET[route.key] ?? NO_WALLET;
  const step = stepOf(coin);
  const token = !route.isNativeToken;
  const feeInCoin = token ? '0' : w.fee;
  const walletFee = token ? w.tokenFee ?? w.fee : w.fee;
  const keep = token ? '0' : w.keep;
  // The SOL withdrawal carries what the USDC / USDT sends on Solana pay in SOL.
  const carry = !token && o.tokenSends > 0 && w.tokenFee ? dMul(w.tokenFee, String(o.tokenSends)) : '0';
  const depositMin = route.deposit.min ?? '0';
  const base = {
    coin: coin.coin,
    chain: route.key,
    label: route.label,
    depositMin,
    sodexFee,
    walletFee,
    feeCoin: token ? o.nativeCoin : coin.coin,
    walletFeeWhy: token ? w.tokenFeeWhy : null,
    keep,
    keepWhy: token ? null : w.keepWhy,
    needFirstFeeCoin: token && !o.nativeCarriesFees ? walletFee : '0',
  };
  if (o.market) {
    const needArrive = dAdd(dAdd(dAdd(depositMin, feeInCoin), keep), carry);
    const withdraw = toStep(dMax(route.withdraw.min ?? '0', dAdd(needArrive, sodexFee)), step, 'ceil');
    const arrives = dSub(withdraw, sodexFee);
    // Send back what arrived, less the wallet's fee and what stays - never below the minimum.
    const sendBack = dMax(depositMin, toStep(dSub(dSub(dSub(arrives, feeInCoin), keep), carry), step, 'floor'));
    return { ...base, order: 'withdraw-first', withdraw, arrives, sendBack, needFirst: '0' };
  }
  // No market: the owner sends first, enough that the withdrawal back clears SoDEX's minimum and its fee.
  const sendBack = dMax(depositMin, roundTripAmount(route, coin, sodexFee));
  return { ...base, order: 'deposit-first', withdraw: sendBack, arrives: dSub(sendBack, sodexFee), sendBack, needFirst: dAdd(dAdd(sendBack, feeInCoin), keep) };
}

/** A route the owner can send a deposit from by hand: a chain the runner cannot sign on, deposits open, offered by the app, the coin tradable. */
export interface HandRoute {
  coin: CoinConfig;
  route: ChainRoute;
  /** The configured hand-sent deposit (null: not configured). */
  deposit: ManualDeposit | null;
  /** The chain withdrawal of the same route (null: SoDEX lists none the runner could make). */
  withdrawal: ChainWithdrawal | null;
  /** Why no hand-sent deposit can be offered here (null: it can). */
  why: string | null;
}

export const isHandActive = (d: ManualDeposit | null): d is ManualDeposit => !!d && d.skip !== true;

/** Every route on a chain the runner cannot sign on, as a hand-sent deposit, with the configured entry and the chain withdrawal. */
export function handRoutes(coins: readonly CoinConfig[], cfg: RunConfig): HandRoute[] {
  const ws = chainWithdrawals(coins, cfg);
  const out: HandRoute[] = [];
  for (const w of ws) {
    const { coin, route } = w;
    let why: string | null = null;
    if (coin.assetId === null) why = `${coin.coin} is not tradable on SoDEX`;
    else if (route.addressKind === 'other') why = `the app does not offer ${route.label}`;
    else if (!route.deposit.allowed) why = `${coin.coin} deposits from ${route.label} are closed on SoDEX right now`;
    const deposit = cfg.manualDeposits.find((d) => d.coin.toUpperCase() === coin.coin.toUpperCase() && d.chain === route.key) ?? null;
    out.push({ coin, route, deposit, withdrawal: w, why });
  }
  return out;
}

/** The native coin of a chain the runner cannot sign on (SOL on Solana ...), from SoDEX's asset config. */
export function nativeCoinOf(coins: readonly CoinConfig[], chainKey: string): CoinConfig | null {
  return coins.find((c) => c.chains.some((r) => r.key === chainKey && r.isNativeToken)) ?? null;
}

/** How many active hand-sent TOKEN deposits a chain has (their fees are paid in the chain's native coin). */
export function tokenSendsOn(cfg: RunConfig, coins: readonly CoinConfig[], chainKey: string): number {
  const native = nativeCoinOf(coins, chainKey);
  return cfg.manualDeposits.filter((d) => isHandActive(d) && d.chain === chainKey && (!native || d.coin.toUpperCase() !== native.coin.toUpperCase())).length;
}

/** The plan of every hand route, given which coins have a spot market and the fee of each route. Pure. */
export function handPlans(routes: readonly HandRoute[], coins: readonly CoinConfig[], cfg: RunConfig, has: { market: (coin: string) => boolean; fee: (coin: string, chain: string) => string }): Map<string, HandPlan> {
  const out = new Map<string, HandPlan>();
  for (const h of routes) {
    if (h.why) continue;
    const native = nativeCoinOf(coins, h.route.key);
    const nativeRoute = routes.find((x) => native && x.coin.coin === native.coin && x.route.key === h.route.key);
    // The native withdrawal carries the token fees only when it runs and the owner sends the native coin back too.
    const nativeCarriesFees = !!nativeRoute && !nativeRoute.withdrawal?.skip && has.market(nativeRoute.coin.coin) && isHandActive(nativeRoute.deposit);
    const tokenSends = h.route.isNativeToken && nativeCarriesFees ? tokenSendsOn(cfg, coins, h.route.key) : 0;
    out.set(handKey(h.coin.coin, h.route.key), handPlan(h.route, h.coin, has.fee(h.coin.coin, h.route.key), { market: has.market(h.coin.coin), nativeCoin: native?.coin ?? h.route.key, nativeCarriesFees, tokenSends }));
  }
  return out;
}

export const handKey = (coin: string, chain: string): string => `${coin.toUpperCase()}|${chain}`;

/** The instructions for one hand-sent deposit, as the run prints them - unmistakable: coin, network, amount, minimum, fee on top, address. */
export function handInstructions(p: HandPlan, o: { address: string; memo: boolean; index: number; of: number; waitMin: number; arrivedFromRun: boolean; skipHint: boolean }): string[] {
  const native = p.feeCoin === p.coin;
  const out = [
    `>>> SEND BY HAND (optional) - ${o.index} of ${o.of}: ${p.coin} on ${p.label}`,
    `>>>   coin ........ ${p.coin}${native ? ` (the native coin of ${p.label})` : ` (the ${p.label} token, NOT ${p.feeCoin})`}`,
    `>>>   network ..... ${p.label} - only this network; not another chain, not an exchange's internal transfer`,
    `>>>   amount ...... ${p.sendBack} ${p.coin}   (SoDEX credits nothing below its deposit minimum of ${p.depositMin} ${p.coin} - send at least that)`,
    `>>>   to .......... ${o.address}`,
    `>>>                 (the app's Deposit sheet and SoDEX's on-chain registry both name this address for this wallet)`,
  ];
  if (o.memo) out.push(">>>   memo / tag .. none - the address is this account's own. If a wallet insists on one, any 9-digit number will do.");
  out.push(
    `>>>   network fee . your wallet adds it ON TOP: about ${p.walletFee} ${p.feeCoin}${p.walletFeeWhy ? ` (${p.walletFeeWhy})` : ''}. If your wallet takes the fee out of the amount (a "max" send), send ${dAdd(p.sendBack, native ? p.walletFee : '0')} so that ${p.sendBack} arrives.`,
  );
  if (dCmp(p.keep, '0') > 0) out.push(`>>>   stays ....... ${p.keep} ${p.coin} stays at your address: ${p.keepWhy ?? 'the chain keeps it'}`);
  if (o.arrivedFromRun) out.push(`>>>   the run sent ${p.arrives} ${p.coin} to your address for this a moment ago - enough for the amount, the fee and what stays.`);
  else if (dCmp(p.needFirst, '0') > 0) out.push(`>>>   from your own wallet: ${p.needFirst} ${p.coin}${dCmp(p.needFirstFeeCoin, '0') > 0 ? ` + ${p.needFirstFeeCoin} ${p.feeCoin}` : ''} (the amount, the fee${dCmp(p.keep, '0') > 0 ? ', what stays' : ''})`);
  if (p.order === 'deposit-first') out.push(`>>>   then the run withdraws it back to you: ${p.withdraw} ${p.coin}, ${p.arrives} arrives (SoDEX's fee ${p.sodexFee}).`);
  out.push(`>>> The run waits up to ${o.waitMin} min for Spot ${p.coin} to rise by at least ${p.sendBack}.${o.skipHint ? ' To skip this one: type s and Enter (skip all = every one still to come).' : ''}`);
  return out;
}

/** One line per hand-sent deposit for the plan (and the guide): what goes out, what comes back, what the owner needs. */
export function handLine(p: HandPlan, d: ManualDeposit | null, withdrawalRuns: boolean): string {
  const state = !d ? 'not configured' : d.skip ? 'left out (skipped by you)' : 'you send it';
  const fee = `your wallet's fee ~${p.walletFee} ${p.feeCoin} on top`;
  const keep = dCmp(p.keep, '0') > 0 ? `; ${p.keep} ${p.coin} stays at your address (${p.keepWhy})` : '';
  if (p.order === 'deposit-first') {
    return `${p.coin} on ${p.label} [${state}]: no ${p.coin}/USDC market on SoDEX - YOU send first: ${p.sendBack} ${p.coin} (${fee}; you need ${p.needFirst} ${p.coin} in your wallet), the run then withdraws it back: ${p.arrives} ${p.coin} arrives (SoDEX's fee ${p.sodexFee})`;
  }
  if (!withdrawalRuns) {
    return `${p.coin} on ${p.label} [${state}]: no withdrawal to you first (no receiver) - you send ${p.sendBack} ${p.coin} from your own funds (${fee}; you need ${dAdd(dAdd(p.sendBack, p.feeCoin === p.coin ? p.walletFee : '0'), p.keep)} ${p.coin}${p.feeCoin !== p.coin ? ` + ${p.walletFee} ${p.feeCoin}` : ''})`;
  }
  return `${p.coin} on ${p.label} [${state}]: the run withdraws ${p.withdraw} ${p.coin} to you, ${p.arrives} arrives; you send back ${p.sendBack} ${p.coin} (deposit minimum ${p.depositMin}; ${fee})${keep}${dCmp(p.needFirstFeeCoin, '0') > 0 ? `; you need ${p.needFirstFeeCoin} ${p.feeCoin} of your own for the fee` : ''} - nothing else needed from you`;
}


/**
 * Every hand route with its plan, resolving which coins have a USDC spot market
 * and each route's withdrawal fee through `io` (the plan and the steps read them
 * the same way). USDC is the quote coin: it needs no market.
 */
export async function resolveHandPlans(
  coins: readonly CoinConfig[],
  cfg: RunConfig,
  io: { market: (coin: CoinConfig) => Promise<boolean>; fee: (coin: CoinConfig, route: ChainRoute) => Promise<string> },
): Promise<{ routes: HandRoute[]; plans: Map<string, HandPlan>; market: Map<string, boolean> }> {
  const routes = handRoutes(coins, cfg);
  const market = new Map<string, boolean>();
  const fee = new Map<string, string>();
  for (const h of routes) {
    if (h.why) continue;
    if (!market.has(h.coin.coin)) market.set(h.coin.coin, h.coin.coin.toUpperCase() === 'USDC' ? true : await io.market(h.coin).catch(() => false));
    fee.set(handKey(h.coin.coin, h.route.key), h.route.withdraw.allowed ? await io.fee(h.coin, h.route).catch(() => h.route.withdraw.fee ?? '0') : h.route.withdraw.fee ?? '0');
  }
  const plans = handPlans(routes, coins, cfg, { market: (c) => market.get(c) ?? false, fee: (c, ch) => fee.get(handKey(c, ch)) ?? '0' });
  return { routes, plans, market };
}
