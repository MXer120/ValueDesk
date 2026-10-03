/**
 * The chains the runner cannot sign on (profile all-chains, the guided full test).
 *
 *   chain-withdrawals  per route SoDEX pays out to on such a chain (Solana,
 *                      Bitcoin, XRP ...), withdrawn through the app's
 *                      withdrawFunds to the OWNER's own address there -
 *                      `receivers.<chain key in lower case>`; a route without that
 *                      receiver is skipped with a plain line. The amount: when the
 *                      owner sends the coin back by hand (manualDeposits), enough
 *                      that what arrives covers that deposit, their wallet's fee and
 *                      what the chain keeps at an address (handBack.ts); else the
 *                      smallest amount they could send straight back (tour.ts
 *                      roundTripAmount). The coin is bought on SoDEX spot with
 *                      USDC first. A coin with no spot market (TON) cannot be bought:
 *                      with a hand-sent deposit of it the withdrawal runs AFTER that
 *                      deposit (manual-deposits), without one it is "not testable
 *                      from USDC alone". The arrival cannot be read from here:
 *                      SoDEX's withdrawal record is the evidence.
 *   manual-deposits    the deposits the owner sends by hand (`manualDeposits`,
 *                      each optional): the run shows the address the app's Deposit
 *                      sheet offers - only when the on-chain registry lists the same
 *                      one - with the exact coin, network, amount (never below
 *                      SoDEX's deposit minimum; the wallet's fee on top), and waits
 *                      for Spot to be credited. The owner can type `s` to skip one
 *                      ("skipped (owner)"). It signs and sends nothing itself - except
 *                      the deferred withdrawal back (TON), through withdrawFunds.
 *                      At the end, everything these two steps left in Spot is sold
 *                      back to USDC where a market takes it.
 */
import { balancesOf, chainLabel, unitsDown, withdrawQuote, type CoinConfig } from '../../src/trading/funds';
import { formatUnits } from '../../src/trading/onboard';
import { coinPrices, priceOf } from '../../src/trading/prices';
import { chainWithdrawals } from './chainRoutes';
import type { Ctx } from './context';
import { sellBack } from './evmTour';
import { handInstructions, handKey, isHandActive, resolveHandPlans, type HandPlan } from './handBack';
import { ownerWord } from './ownerInput';
import { checkDepositAddress, depositAddressProblem, spotMarketFor } from './plan';
import { buyOnSpot, moved, routeCheck, withdrawTo } from './steps';
import { roundTripAmount } from './tour';
import { ensureTrading } from './trading';
import { approx, cut, dCmp, dSub, dur, paced, sleep, toStep } from './util';

/** The hand-sent deposits planned with live reads (which coins have a market, each route's on-chain fee). */
async function planHands(ctx: Ctx): Promise<Map<string, HandPlan>> {
  const r = await resolveHandPlans(ctx.pre.coins, ctx.cfg, {
    market: async (c) => !!(await spotMarketFor(c).catch(() => null)),
    fee: async (c, route) => formatUnits((await withdrawQuote(c, route, ctx.owner)).fee, c.valuechain.decimals),
  });
  return r.plans;
}

const addOther = (ctx: Ctx, coin: string, units: bigint): void => {
  ctx.otherCoins.set(coin, (ctx.otherCoins.get(coin) ?? 0n) + units);
};

/** Is the owner's hand-sent deposit of this route part of this run? */
const handActive = (ctx: Ctx, coin: string, chain: string): boolean =>
  ctx.selected.has('manual-deposits') && isHandActive(ctx.cfg.manualDeposits.find((d) => d.coin.toUpperCase() === coin.toUpperCase() && d.chain === chain) ?? null);

export async function stepChainWithdrawals(ctx: Ctx): Promise<void> {
  const { owner, cfg, rec } = ctx;
  await ensureTrading(ctx);
  const plans = await planHands(ctx);
  const markets = new Map<string, boolean>();
  const hasMarket = async (c: CoinConfig): Promise<boolean> => {
    if (c.coin.toUpperCase() === 'USDC') return true;
    if (!markets.has(c.coin)) markets.set(c.coin, !!(await spotMarketFor(c).catch(() => null)));
    return markets.get(c.coin)!;
  };
  for (const w of chainWithdrawals(ctx.pre.coins, cfg)) {
    const id = routeCheck(ctx, 'chain-withdrawals', `${w.route.key}#${w.coin.coin}`);
    if (w.skip) {
      ctx.checks.skip(id, w.skip);
      continue;
    }
    const key = handKey(w.coin.coin, w.route.key);
    const hand = handActive(ctx, w.coin.coin, w.route.key);
    const hp = plans.get(key) ?? null;
    const quote = await rec.sub(`SoDEX's on-chain fee for ${w.coin.coin} -> ${w.route.label}`, () => withdrawQuote(w.coin, w.route, owner), (q) => `${formatUnits(q.fee, w.coin.valuechain.decimals)} ${w.coin.coin}`);
    const fee = formatUnits(quote.fee, w.coin.valuechain.decimals);
    // With a hand-sent deposit back: enough that what arrives covers it, the wallet's fee and what stays (handBack.ts).
    const amount = hand && hp && hp.order === 'withdraw-first' ? hp.withdraw : roundTripAmount(w.route, w.coin, fee);
    const dp = w.coin.valuechain.decimals;
    const held = (await balancesOf(owner, w.coin)).spot;
    if (dCmp(held, amount) < 0) {
      const market = await hasMarket(w.coin);
      if (!market && hand) {
        ctx.deferredWithdrawals.add(key);
        rec.note(`${w.coin.coin} -> ${w.route.label}: runs after your hand-sent ${w.coin.coin} deposit (manual-deposits) - SoDEX has no ${w.coin.coin}/USDC spot market, so it cannot be bought with USDC`);
        continue;
      }
      if (!market || !cfg.chainWithdrawals.buyIfMissing) {
        ctx.checks.skip(
          id,
          !market
            ? `not testable from USDC alone: Spot holds ${held} ${w.coin.coin}, and SoDEX has no ${w.coin.coin}/USDC spot market to buy ${amount} on - send ${w.coin.coin} by hand first (manualDeposits; the full test offers it), the run then withdraws it back`
            : `Spot holds ${held} ${w.coin.coin}, less than the ${amount} needed, and chainWithdrawals.buyIfMissing is off`,
        );
        continue;
      }
      const b0 = unitsDown(held, dp);
      await buyOnSpot(ctx, w.coin, amount, id);
      const b1 = unitsDown((await balancesOf(owner, w.coin)).spot, dp);
      if (b1 > b0) addOther(ctx, w.coin.coin, b1 - b0);
    }
    let arrived = dSub(amount, fee);
    await moved(ctx, id, async () => {
      const r = await withdrawTo(ctx, { coin: w.coin, route: w.route, receiverName: w.receiverName, amount });
      if (typeof r.evidence.received === 'string') arrived = r.evidence.received;
      return r;
    });
    addOther(ctx, w.coin.coin, -unitsDown(amount, dp));
    ctx.handArrived.set(key, arrived);
  }
  // Without the hand-sent deposits in this run, what the buys left over is sold back now.
  if (!ctx.selected.has('manual-deposits')) await sellBackOther(ctx);
}

/** Sell back to USDC what chain-withdrawals and manual-deposits left in Spot (where a market takes it). */
async function sellBackOther(ctx: Ctx): Promise<void> {
  for (const [coin, units] of ctx.otherCoins) {
    if (units <= 0n || coin.toUpperCase() === 'USDC') continue;
    await sellBack(ctx, coin, units, 'other-chains', 'what the chain withdrawals bought and the hand-sent deposits brought in');
    ctx.otherCoins.set(coin, 0n);
  }
}

const usdOf = async (coin: string): Promise<number> => (/^v?USDC$/i.test(coin) ? 1 : priceOf(await coinPrices().catch(() => new Map()), coin) ?? 0);

export async function stepManualDeposits(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const plans = await planHands(ctx).catch(() => new Map<string, HandPlan>());
  const active = cfg.manualDeposits.filter((d) => !d.skip);
  let n = 0;
  let skipAll = false;
  for (const [i, d] of cfg.manualDeposits.entries()) {
    const id = routeCheck(ctx, 'manual-deposits', i);
    const coin = ctx.pre.coins.find((c) => c.coin.toUpperCase() === d.coin.toUpperCase());
    const route = coin?.chains.find((r) => r.key === d.chain);
    const key = handKey(d.coin, d.chain);
    // A withdrawal that waited for this deposit (no spot market): without the deposit it cannot be tested.
    const deferredId = coin && route && ctx.deferredWithdrawals.has(key) ? routeCheck(ctx, 'chain-withdrawals', `${route.key}#${coin.coin}`) : null;
    const notTestable = (why: string): void => {
      if (deferredId) ctx.checks.skip(deferredId, `not testable from USDC alone: SoDEX has no ${d.coin}/USDC spot market, and ${why}`);
    };
    if (d.skip) {
      ctx.checks.skip(id, 'skipped (owner): you left this hand-sent deposit out when the run was set up - nothing was waited for');
      notTestable(`you left the hand-sent ${d.coin} deposit out (skipped (owner))`);
      continue;
    }
    n += 1;
    if (skipAll) {
      ctx.checks.skip(id, 'skipped (owner): you typed "skip all" at an earlier hand-sent deposit');
      notTestable(`you skipped the hand-sent ${d.coin} deposit (skipped (owner))`);
      continue;
    }
    if (!coin || !route) {
      ctx.checks.skip(id, `SoDEX lists no ${d.coin} route on ${chainLabel(d.chain)}`);
      continue;
    }
    if (!route.deposit.allowed) {
      ctx.checks.skip(id, `${d.coin} deposits from ${route.label} are closed on SoDEX right now`);
      notTestable(`${d.coin} deposits from ${route.label} are closed on SoDEX right now`);
      continue;
    }
    if (route.addressKind === 'other') {
      ctx.checks.skip(id, `the app does not offer ${route.label}`);
      continue;
    }
    const hp = plans.get(key) ?? null;
    const amount = d.amount === 'auto' ? hp?.sendBack ?? route.deposit.min ?? null : d.amount;
    if (!amount) {
      ctx.checks.skip(id, `SoDEX lists no deposit minimum for ${coin.coin} on ${route.label} and no amount is configured`);
      continue;
    }
    // Never ask for a deposit SoDEX would not credit.
    if (route.deposit.min && dCmp(amount, route.deposit.min) < 0) {
      ctx.checks.fail(id, `not shown to you: ${amount} ${coin.coin} is below SoDEX's deposit minimum ${route.deposit.min} on ${route.label} - a deposit below it is not credited`);
      notTestable(`its hand-sent deposit was below the deposit minimum`);
      continue;
    }
    const a = await rec.sub(
      `the ${coin.coin} deposit address on ${route.label}: the app's Deposit sheet vs the on-chain registry`,
      () => checkDepositAddress(owner, route.key, { registryOnly: false, waitMs: cfg.timeouts.addressIssueSeconds * 1000, coin: coin.coin, kind: route.addressKind, say: (s) => rec.line(s, 7) }),
      (x) => `${x.backend ?? '-'} vs ${x.registry ?? '-'}`,
    );
    const bad = depositAddressProblem(owner, route.key, a, { coin: coin.coin, kind: route.addressKind });
    if (bad) {
      ctx.checks.fail(id, `not shown to you: ${bad}`);
      notTestable(`its deposit address could not be verified`);
      continue;
    }
    const address = a.backend!;
    const dp = coin.valuechain.decimals;
    const s0 = unitsDown((await balancesOf(owner, coin)).spot, dp);
    const want = unitsDown(amount, dp);
    const minUnits = unitsDown(route.deposit.min ?? amount, dp);
    // Bitcoin and friends wait for confirmations: never less than twice SoDEX's own estimate.
    const waitMin = Math.max(cfg.timeouts.depositMinutes, Math.ceil(((route.deposit.etaSeconds ?? 0) * 2) / 60));
    const shown: HandPlan =
      hp && dCmp(hp.sendBack, amount) === 0
        ? hp
        : { coin: coin.coin, chain: route.key, label: route.label, order: 'withdraw-first', withdraw: '0', arrives: '0', sendBack: amount, depositMin: route.deposit.min ?? amount, sodexFee: route.withdraw.fee ?? '0', walletFee: hp?.walletFee ?? '?', feeCoin: hp?.feeCoin ?? coin.coin, walletFeeWhy: hp?.walletFeeWhy ?? null, keep: hp?.keep ?? '0', keepWhy: hp?.keepWhy ?? null, needFirst: amount, needFirstFeeCoin: '0' };
    rec.line('');
    for (const l of handInstructions(shown, { address, memo: route.memo === 'numeric', index: n, of: active.length, waitMin, arrivedFromRun: ctx.handArrived.has(key), skipHint: !!ctx.ownerInput })) rec.line(`   ${l}`);
    rec.line('');
    ctx.onManualDeposit?.({ coin: coin.coin, chain: route.key, address, amount });
    const t0 = Date.now();
    let got = 0n;
    let outcome: 'credited' | 'skip' | 'skip-all' | 'timeout' = 'timeout';
    let lastProbe = -Infinity;
    let lastSaid = t0;
    ctx.ownerInput?.start(key);
    try {
      for (;;) {
        const word = ownerWord(ctx.ownerInput?.take() ?? null);
        if (word) {
          outcome = word;
          break;
        }
        if (Date.now() - lastProbe >= paced(15_000)) {
          lastProbe = Date.now();
          try {
            const s = unitsDown((await balancesOf(owner, coin)).spot, dp);
            got = s - s0;
            if (got >= want) {
              outcome = 'credited';
              break;
            }
          } catch {
            /* a failed read: look again */
          }
        }
        if (Date.now() - t0 >= waitMin * 60_000) break;
        if (Date.now() - lastSaid >= paced(120_000)) {
          lastSaid = Date.now();
          rec.line(`still waiting for ${amount} ${coin.coin} on ${route.label} (${dur(Date.now() - t0)}; Spot rose by ${cut(formatUnits(got > 0n ? got : 0n, dp), 8)})${ctx.ownerInput ? ' - s + Enter skips it' : ''}`, 5);
        }
        await sleep(paced(1000));
      }
    } finally {
      ctx.ownerInput?.stop();
    }
    if (outcome === 'skip' || outcome === 'skip-all') {
      if (outcome === 'skip-all') skipAll = true;
      ctx.checks.skip(id, `skipped (owner): you typed "${outcome === 'skip' ? 's' : 'skip all'}" while the run waited after ${dur(Date.now() - t0)} - if you sent it anyway, SoDEX credits it when its custody sees it`, { address, chain: route.key });
      notTestable(`you skipped the hand-sent ${coin.coin} deposit (skipped (owner))`);
      continue;
    }
    if (outcome === 'credited' || got >= minUnits) {
      const credited = formatUnits(got, dp);
      ctx.checks.pass(id, `${credited} ${coin.coin} sent by hand from ${route.label} to ${address} (the address the app's Deposit sheet and the on-chain registry both name) was credited to Spot after ${dur(Date.now() - t0)}${outcome === 'credited' ? '' : ` (less than the ${amount} asked for, but at least SoDEX's minimum)`}`, { address, chain: route.key, credited });
      rec.amount(`manual deposit ${coin.coin} from ${route.label}`, credited);
      addOther(ctx, coin.coin, got);
      // Value that came back from your own address is no longer "sent away".
      const back = approx(credited) * (await usdOf(coin.coin));
      ctx.stepSentAwayUsd -= Math.min(back, Math.max(0, ctx.spend.sentAwayUsd + ctx.stepSentAwayUsd));
      if (deferredId) await withdrawBack(ctx, deferredId, coin, route.key, got);
    } else {
      // Nothing was sent by the runner: a deposit that arrives later is still credited to Spot.
      ctx.checks.fail(id, `Spot ${coin.coin} rose by ${cut(formatUnits(got > 0n ? got : 0n, dp), 8)} in ${dur(Date.now() - t0)}, not by ${amount} - if you sent it, SoDEX credits it when its custody sees it`, { address, chain: route.key });
      if (got <= 0n) ctx.inFlight.push({ what: `a manual ${coin.coin} deposit from ${route.label} to ${address} (if you sent one) - not credited when the run checked`, since: t0 });
      notTestable(`the hand-sent ${coin.coin} deposit was not credited in time`);
    }
  }
  await sellBackOther(ctx);
}

/** The deferred withdrawal (no spot market): what the hand-sent deposit brought in, back to the owner's own address. */
async function withdrawBack(ctx: Ctx, id: string, coin: CoinConfig, chain: string, credited: bigint): Promise<void> {
  const route = coin.chains.find((r) => r.key === chain)!;
  const w = chainWithdrawals(ctx.pre.coins, ctx.cfg).find((x) => x.coin.coin === coin.coin && x.route.key === chain);
  const dp = coin.valuechain.decimals;
  const amount = toStep(formatUnits(credited, dp), `0.${'0'.repeat(Math.max(0, Math.min(dp, 6) - 1))}1`, 'floor');
  if (!w || w.skip) {
    ctx.checks.skip(id, w?.skip ?? `SoDEX lists no ${coin.coin} withdrawal to ${route.label}`);
    return;
  }
  if (route.withdraw.min && dCmp(amount, route.withdraw.min) < 0) {
    ctx.checks.skip(id, `the hand-sent deposit brought ${amount} ${coin.coin}, less than SoDEX's withdrawal minimum ${route.withdraw.min} on ${route.label} - it stays in Spot`);
    return;
  }
  ctx.rec.line(`   ${coin.coin} -> ${route.label}: withdrawing what your hand-sent deposit brought in back to your own address (SoDEX has no ${coin.coin}/USDC spot market, so this route is tested deposit first)`);
  await moved(ctx, id, () => withdrawTo(ctx, { coin, route, receiverName: w.receiverName, amount }));
  addOther(ctx, coin.coin, -unitsDown(amount, dp));
  ctx.handArrived.set(handKey(coin.coin, chain), amount);
}
