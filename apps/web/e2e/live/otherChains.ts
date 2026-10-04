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
import type { AddressKind } from '../../src/trading/addresses';
import { balancesOf, chainLabel, unitsDown, withdrawQuote, type ChainRoute, type CoinConfig } from '../../src/trading/funds';
import { formatUnits } from '../../src/trading/onboard';
import { coinPrices, priceOf } from '../../src/trading/prices';
import { chainWithdrawals, type ChainWithdrawal } from './chainRoutes';
import { CheckFailure, armed, endsTheRun, tripFailed, type Ctx } from './context';
import { nativeChainFor, nativeCoinFor, nativeCoinOf } from './native';
import { ACCOUNT_MINIMUM, NATIVE_DECIMALS, NATIVE_SYMBOL, type NativeChain, type NativeCoin, type PreparedSend, type SendCosts } from './native/types';
import { WaitTimeout, waitMaybe } from './orders';
import type { InFlight } from './reads';
import { sellBack } from './evmTour';
import { handInstructions, handKey, isHandActive, resolveHandPlans, type HandPlan } from './handBack';
import { ownerWord } from './ownerInput';
import { checkDepositAddress, depositAddressProblem, spotMarketFor } from './plan';
import { api } from '../../src/api';
import { buyOnSpot, creditWaitMs, moved, routeCheck, withdrawTo } from './steps';
import { depositFloor, roundTripAmount, roundTripWithdrawal } from './tour';
import { ensureTrading } from './trading';
import { approx, cut, dAdd, dCmp, dMax, dSub, dur, errText, paced, sleep, toStep } from './util';

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
  const list = nativeFirst(chainWithdrawals(ctx.pre.coins, cfg));
  // SoDEX issues a wallet's address on Bitcoin, XRP, Stellar, ... only when asked (its bulk issue covers the EVM
  // chains - in the live run of 2026-10-03 seven chains had none). Reading the Deposit sheet's options asks for every
  // chain without one, as sodex.com's sheet does - now, so each is issued by the time its trip needs it.
  const issueBy = Date.now() + ISSUE_WAIT_MS;
  if (list.some((w) => w.roundTrip && !w.skip)) {
    try {
      await rec.read(
        "the Deposit sheet's addresses (SoDEX is asked to issue those it has not issued yet)",
        () => api.depositOptions(owner),
        (r) => (r.issuing.length ? `asked SoDEX to issue: ${r.issuing.join(', ')}` : 'every chain has its address'),
      );
    } catch {
      /* each trip reads them again, and waits */
    }
  }
  // Withdrawals that had not arrived when their wait ended: sent back at the end of the step, once they are there.
  const late: LateTrip[] = [];
  for (const w of list) {
    const id = routeCheck(ctx, 'chain-withdrawals', `${w.route.key}#${w.coin.coin}`);
    const depId = w.roundTrip ? routeCheck(ctx, 'chain-withdrawals', `${w.route.key}#${w.coin.coin}#deposit`) : null;
    if (w.skip) {
      ctx.checks.skip(id, w.skip);
      if (depId) ctx.checks.skip(depId, w.skip);
      continue;
    }
    // Each trip on its own: what goes wrong in one is reported there, and the next goes on (the spend cap still ends the run).
    try {
      if (w.roundTrip) {
        const l = await roundTripLeg(ctx, w, id, list, hasMarket, issueBy);
        if (l) late.push(l);
        continue;
      }
      await ownerTrip(ctx, w, id, plans, hasMarket);
    } catch (e) {
      if (endsTheRun(e)) throw e;
      tripFailed(ctx, `${w.coin.coin} -> ${w.route.label}`, e, depId ? [id, depId] : [id]);
    }
  }
  for (const l of late) {
    try {
      await lateTrip(ctx, l);
    } catch (e) {
      if (endsTheRun(e)) throw e;
      tripFailed(ctx, `${l.coinCfg.coin} back from ${l.route.label}`, e, [l.dId]);
    }
  }
  // Without the hand-sent deposits in this run, what the buys left over is sold back now.
  if (!ctx.selected.has('manual-deposits')) await sellBackOther(ctx);
}

/** A withdrawal to the OWNER's address on a chain the runner does not sign on (the deposit back, if any, is theirs). */
async function ownerTrip(ctx: Ctx, w: ChainWithdrawal, id: string, plans: Map<string, HandPlan>, hasMarket: (c: CoinConfig) => Promise<boolean>): Promise<void> {
  const { owner, cfg, rec } = ctx;
  {
    const key = handKey(w.coin.coin, w.route.key);
    const hand = handActive(ctx, w.coin.coin, w.route.key);
    const hp = plans.get(key) ?? null;
    const quote = await rec.read(`SoDEX's on-chain fee for ${w.coin.coin} -> ${w.route.label}`, () => withdrawQuote(w.coin, w.route, owner), (q) => `${formatUnits(q.fee, w.coin.valuechain.decimals)} ${w.coin.coin}`);
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
        return;
      }
      if (!market || !cfg.chainWithdrawals.buyIfMissing) {
        ctx.checks.skip(
          id,
          !market
            ? `not testable from USDC alone: Spot holds ${held} ${w.coin.coin}, and SoDEX has no ${w.coin.coin}/USDC spot market to buy ${amount} on - send ${w.coin.coin} by hand first (manualDeposits; the full test offers it), the run then withdraws it back`
            : `Spot holds ${held} ${w.coin.coin}, less than the ${amount} needed, and chainWithdrawals.buyIfMissing is off`,
        );
        return;
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
}

// --- round trips on the chains the runner signs on (native/*.ts) ------------------------------------------------

const unitStep = (dp: number): string => (dp <= 0 ? '1' : `0.${'0'.repeat(dp - 1)}1`);

/** The native coin of a chain first (a token's transfer back needs it for its fee), the routes' own order otherwise. */
function nativeFirst(list: ChainWithdrawal[]): ChainWithdrawal[] {
  const keys = [...new Set(list.map((w) => w.route.key))];
  return keys.flatMap((k) => {
    const on = list.filter((w) => w.route.key === k);
    return [...on.filter((w) => w.route.isNativeToken), ...on.filter((w) => !w.route.isNativeToken)];
  });
}

/**
 * One round trip on a chain the runner signs on itself (the test key - native/*.ts): the coin out to the test
 * wallet's OWN address there (its arrival read on the chain), then back to the wallet's verified SoDEX deposit
 * address in a transfer the runner signs (DIRECT), until Spot is credited. The way back is checked BEFORE anything
 * leaves; without one only the withdrawal runs. Nothing goes to anyone else.
 */
/** A round trip whose withdrawal had not arrived when its wait ended: what the deposit back needs, for the end of the step. */
interface LateTrip {
  chain: NativeChain;
  coinCfg: CoinConfig;
  route: ChainRoute;
  ncoin: NativeCoin;
  here: string;
  to: string;
  wId: string;
  dId: string;
  reserve: bigint;
  floor: string;
}

/** How long after the step began a chain's newly issued deposit address is waited for (sodex.com asks every 5 s for ~2.5 min). */
const ISSUE_WAIT_MS = 10 * 60_000;

async function roundTripLeg(ctx: Ctx, w: ChainWithdrawal, wId: string, list: readonly ChainWithdrawal[], hasMarket: (c: CoinConfig) => Promise<boolean>, issueBy: number): Promise<LateTrip | null> {
  const { owner, cfg, rec } = ctx;
  const chain = nativeChainFor(ctx.native, w.route.key);
  const dId = routeCheck(ctx, 'chain-withdrawals', `${w.route.key}#${w.coin.coin}#deposit`);
  const ncoin = chain ? nativeCoinOf(chain, w.route, w.coin.coin) : null;
  if (!chain || !ctx.native || !ncoin) {
    const why = !chain ? `the runner does not sign on ${w.route.label}` : `the runner does not know ${w.coin.coin}'s decimals on ${w.route.label}`;
    ctx.checks.skip(wId, why);
    ctx.checks.skip(dId, why);
    return null;
  }
  const keys = ctx.native.keys;
  const here = chain.address(keys);
  const sodexDp = w.coin.valuechain.decimals;
  const dp = Math.min(ncoin.decimals, sodexDp, 8);
  const kind = w.route.addressKind as AddressKind;

  // 1. The way back: the wallet's deposit address there, the app's and the on-chain registry's - before anything leaves.
  //    A chain SoDEX was asked to issue an address on at the start of the step gets until then + ISSUE_WAIT_MS.
  const addressWaitMs = Math.max(cfg.timeouts.addressIssueSeconds * 1000, issueBy - Date.now());
  const d = await rec.read(
    `the ${w.coin.coin} deposit address on ${w.route.label}: the app's Deposit sheet vs the on-chain registry`,
    () => checkDepositAddress(owner, w.route.key, { registryOnly: false, waitMs: addressWaitMs, coin: w.coin.coin, kind, say: (s) => rec.line(s, 7) }),
    (x) => `${x.backend ?? '-'} vs ${x.registry ?? '-'}`,
  );
  const noBack = depositAddressProblem(owner, w.route.key, d, { coin: w.coin.coin, kind });
  const to = noBack ? null : d.backend!;

  // 2. How much: what must be at the address for the deposit back (SoDEX's minimum + 2 %), the chain's fee, what must
  //    stay there - and, for a chain's native coin, the fees its tokens' transfers back will need. What an earlier run
  //    left there (a deposit back that could not run) counts: only what is missing is withdrawn, at least the minimum.
  const quote = await rec.read(`SoDEX's on-chain fee for ${w.coin.coin} -> ${w.route.label}`, () => withdrawQuote(w.coin, w.route, owner), (q) => `${formatUnits(q.fee, sodexDp)} ${w.coin.coin}`);
  const fee = formatUnits(quote.fee, sodexDp);
  let costs: SendCosts = { fee: 0n, keep: 0n, nativeNeeded: 0n };
  let reserve = 0n;
  let have = '0';
  // Without the deposit address (not issued yet) the costs are those of a transfer to the wallet's own address there.
  const dest = to ?? here;
  {
    costs = await rec.read(`what a ${w.coin.coin} transfer on ${w.route.label} costs from ${here}`, () => chain.costs(here, ncoin, dest), (c) => `fee ${c.fee}, keep ${c.keep}, native needed ${c.nativeNeeded} (base units)`);
    if (ncoin.native) {
      for (const t of list) {
        if (t.route.key !== w.route.key || t.route.isNativeToken || t.skip || !t.roundTrip) continue;
        const tc = nativeCoinOf(chain, t.route, t.coin.coin);
        if (!tc) continue;
        const c = await chain.costs(here, tc, dest).catch(() => null);
        if (c) reserve += (c.nativeNeeded * 12n) / 10n;
      }
      // Solana: the paying account must stay rent-exempt (~650,240 lamports) after each token send - or be empty.
      if (reserve > 0n) reserve += ACCOUNT_MINIMUM[chain.kind] ?? 0n;
    }
    try {
      have = formatUnits(await rec.read(`what the test wallet already holds at ${here}`, () => chain.balance(here, ncoin), (b) => `${formatUnits(b, ncoin.decimals)} ${w.coin.coin}`), ncoin.decimals);
    } catch {
      /* unreadable: withdrawn as if nothing were there */
    }
  }
  const floor = depositFloor(w.route, dp);
  const extra = ncoin.native ? formatUnits(costs.fee + costs.keep + reserve, ncoin.decimals) : '0';
  const need = dAdd(floor, extra);
  // What an earlier run's withdrawal left there already pays for the transfer back: it goes back, and nothing is
  // withdrawn again - that withdrawal was the test of it, and the next run (nothing left there) withdraws again.
  // So a run on the coins it already has needs no USDC for them.
  if (dCmp(have, '0') > 0 && dCmp(have, need) >= 0) {
    ctx.checks.skip(wId, `not withdrawn again: ${cut(have, 8)} ${w.coin.coin} from an earlier run's withdrawal is already at the test wallet's own address ${here} - this run sends it back (the deposit is what is tested here); the next run, with nothing left there, withdraws again`);
    if (!to) {
      // No address to send it to yet: it stays there, and nothing more is withdrawn on top of it.
      ctx.checks.set(dId, 'not-run', `not run: ${noBack}. The ${cut(have, 8)} ${w.coin.coin} from an earlier run stays at the test wallet's ${w.route.label} address ${here}.`, { chain: w.route.key, address: here, leftOnChain: have });
      return null;
    }
    rec.note(`${w.route.label}: ${cut(have, 8)} ${w.coin.coin} from an earlier run is already at ${here} - sending it back, no new withdrawal`);
    await depositBack(ctx, { chain, coinCfg: w.coin, route: w.route, ncoin, here, to, dId, reserve, floor });
    return null;
  }
  const amount = to ? roundTripWithdrawal({ need, have, min: w.route.withdraw.min ?? null, fee, dp }) : roundTripAmount(w.route, w.coin, fee);
  if (dCmp(have, '0') > 0) rec.note(`${w.route.label}: ${cut(have, 8)} ${w.coin.coin} from an earlier run is already at ${here} - it goes back to SoDEX with this run's ${amount}`);

  // 3. The coin in Spot (bought with USDC where Spot holds less).
  const held = (await balancesOf(owner, w.coin)).spot;
  if (dCmp(held, amount) < 0) {
    if (!(await hasMarket(w.coin)) || !cfg.chainWithdrawals.buyIfMissing) {
      const why = !(await hasMarket(w.coin)) ? `Spot holds ${held} ${w.coin.coin} and SoDEX has no ${w.coin.coin}/USDC market that is TRADING to buy ${amount} on` : `Spot holds ${held} ${w.coin.coin}, less than ${amount}, and chainWithdrawals.buyIfMissing is off`;
      ctx.checks.skip(wId, why);
      ctx.checks.skip(dId, why);
      return null;
    }
    const b0 = unitsDown(held, sodexDp);
    await buyOnSpot(ctx, w.coin, amount, wId);
    const b1 = unitsDown((await balancesOf(owner, w.coin)).spot, sodexDp);
    if (b1 > b0) addOther(ctx, w.coin.coin, b1 - b0);
  }

  // 4. Out, to the test wallet's own address there - its arrival read on the chain.
  let arrived = dSub(amount, fee);
  try {
    await moved(ctx, wId, async () => {
      const r = await withdrawTo(ctx, { coin: w.coin, route: w.route, receiverName: w.receiverName, amount });
      if (typeof r.evidence.received === 'string') arrived = r.evidence.received;
      return r;
    });
  } catch (e) {
    // SoDEX's record says the payout FAILED: a withdrawal paid from Spot is credited back there - known state, the
    // other chains go on (a payout to a brand-new account a chain refuses, e.g. Stellar without createAccount).
    if (/ended as "/.test(errText(e))) {
      ctx.checks.skip(dId, `nothing to send back: the withdrawal failed (${errText(e)})`);
      return null;
    }
    // Sent, but not seen arriving in time: in flight. Its deposit back is tried at the end of the step, once it is there.
    if (e instanceof WaitTimeout && to) {
      ctx.checks.finding(wId, `sent, but it had not arrived at ${here} when the wait ended (${errText(e)}) - IN FLIGHT; its deposit back is tried at the end of the step`);
      addOther(ctx, w.coin.coin, -unitsDown(amount, sodexDp));
      return { chain, coinCfg: w.coin, route: w.route, ncoin, here, to, wId, dId, reserve, floor };
    }
    throw e;
  }
  addOther(ctx, w.coin.coin, -unitsDown(amount, sodexDp));
  if (!to) {
    ctx.checks.set(dId, 'not-run', `not run: ${noBack}. The ${cut(arrived, 8)} ${w.coin.coin} that arrived stays at the test wallet's ${w.route.label} address ${here}.`, { chain: w.route.key, address: here, leftOnChain: arrived });
    rec.note(`${w.route.label}: the ${w.coin.coin} deposit back is not run (${noBack}); ${cut(arrived, 8)} stays at ${here}`);
    return null;
  }

  // 5. Back to SoDEX, signed by the runner (DIRECT): exactly the bytes armed, once.
  await depositBack(ctx, { chain, coinCfg: w.coin, route: w.route, ncoin, here, to, dId, reserve, floor });
  // 6. The coin is sold back now, not at the end of the step: the next trip buys its own coin with this USDC, so
  //    the step needs the largest single trip in Spot, not all of them at once.
  await sellBackNow(ctx, w, list);
  return null;
}

/** Sell what this step bought of `w`'s coin back to USDC, unless a later trip of the step needs the same coin. */
async function sellBackNow(ctx: Ctx, w: ChainWithdrawal, list: readonly ChainWithdrawal[]): Promise<void> {
  const coin = w.coin.coin;
  if (coin.toUpperCase() === 'USDC') return;
  if (list.slice(list.indexOf(w) + 1).some((t) => !t.skip && t.coin.coin === coin)) return;
  const units = ctx.otherCoins.get(coin) ?? 0n;
  if (units <= 0n) return;
  try {
    const dp = w.coin.valuechain.decimals;
    const before = unitsDown((await balancesOf(ctx.owner, w.coin)).spot, dp);
    await sellBack(ctx, coin, units, 'other-chains', `the ${coin} the round trip bought - sold back before the next trip`);
    // What is below the market's minimum order stays, and is still the step's: sold at its end with what joins it.
    const after = unitsDown((await balancesOf(ctx.owner, w.coin)).spot, dp);
    const sold = before > after ? before - after : 0n;
    ctx.otherCoins.set(coin, units > sold ? units - sold : 0n);
  } catch (e) {
    // Left for the sale at the end of the step.
    ctx.rec.warn('sell back', `${coin} after its round trip: ${errText(e)} - tried again at the end of the step`);
  }
}

/** A withdrawal that arrived late: if it is there now, the deposit back runs (the deposit is still tested). */
async function lateTrip(ctx: Ctx, l: LateTrip): Promise<void> {
  const label = `${l.coinCfg.coin} on ${l.route.label}`;
  const have = await ctx.rec.read(`did the late ${label} withdrawal arrive at ${l.here}?`, () => l.chain.balance(l.here, l.ncoin), (b) => `${formatUnits(b, l.ncoin.decimals)} ${l.coinCfg.coin}`);
  if (have < unitsDown(l.floor, l.ncoin.decimals)) {
    ctx.checks.set(l.dId, 'not-run', `not run: the ${label} withdrawal had not arrived by the end of the step (${l.here} holds ${formatUnits(have, l.ncoin.decimals)}) - it is IN FLIGHT`);
    return;
  }
  ctx.checks.finding(l.wId, `arrived at ${l.here} after its wait ended (${formatUnits(have, l.ncoin.decimals)} ${l.coinCfg.coin} there now): slower than the run expected, but there`);
  ctx.rec.note(`${label}: the withdrawal arrived late - sending it back now`);
  await depositBack(ctx, { chain: l.chain, coinCfg: l.coinCfg, route: l.route, ncoin: l.ncoin, here: l.here, to: l.to, dId: l.dId, reserve: l.reserve, floor: l.floor });
}

async function depositBack(
  ctx: Ctx,
  o: { chain: NativeChain; coinCfg: CoinConfig; route: ChainRoute; ncoin: NativeCoin; here: string; to: string; dId: string; reserve: bigint; floor: string },
): Promise<void> {
  const { owner, rec } = ctx;
  const { chain, ncoin, route, here, to, dId } = o;
  const coin = o.coinCfg.coin;
  const sodexDp = o.coinCfg.valuechain.decimals;
  const natSym = NATIVE_SYMBOL[chain.kind];
  const natDp = NATIVE_DECIMALS[chain.kind];
  let flight: InFlight | null = null;
  try {
    let amount: bigint | 'max' = 'max';
    if (ncoin.native && o.reserve > 0n) {
      // What the chain's tokens still need for their fees stays here.
      const bal = await chain.balance(here, ncoin);
      const c = await chain.costs(here, ncoin, to);
      amount = bal - c.fee - c.keep - o.reserve;
      if (amount <= 0n) throw new CheckFailure(`only ${formatUnits(bal, ncoin.decimals)} ${coin} at ${here}: nothing left to send back after the fee and ${formatUnits(o.reserve, natDp)} ${natSym} kept for the tokens' transfers`);
    }
    if (!ncoin.native) {
      const nat = await chain.balance(here, nativeCoinFor(chain, natSym));
      const c = await chain.costs(here, ncoin, to);
      if (nat < c.nativeNeeded) throw new CheckFailure(`not sent: ${here} holds ${formatUnits(nat, natDp)} ${natSym}, the ${coin} transfer needs ${formatUnits(c.nativeNeeded, natDp)} ${natSym} for its fee - the ${coin} stays there`);
    }
    const p: PreparedSend = await rec.sub(
      `build and sign the ${coin} transfer back on ${route.label} (nothing is sent yet)`,
      () => chain.prepare(ctx.native!.keys, ncoin, to, amount),
      (x) => `${formatUnits(x.amount, ncoin.decimals)} ${coin}, network fee ${formatUnits(x.fee, natDp)} ${natSym}, tx ${x.txid}`,
    );
    const sent = formatUnits(p.amount, ncoin.decimals);
    if (p.amount < unitsDown(o.floor, ncoin.decimals)) throw new CheckFailure(`not sent: ${sent} ${coin} is below SoDEX's deposit minimum ${route.deposit.min} (+2 %) on ${route.label} - a deposit below it is not credited`);
    const spot0 = unitsDown((await balancesOf(owner, o.coinCfg)).spot, sodexDp);
    const label = `DIRECT ${route.label} transfer: ${sent} ${coin} from the test wallet's own address ${here} to the verified deposit address ${to}`;
    await rec.sub(`send it (the runner signs it - DIRECT): ${sent} ${coin} on ${route.label} to ${to}`, () =>
      armed(ctx, { expect: [{ kind: 'chain-broadcast', label, exact: p.request.body, tag: dId }] }, () => chain.broadcast(p)),
    );
    rec.tx({ chain: route.key, hash: p.txid, what: `DIRECT ${coin} transfer back to SoDEX`, explorer: p.explorer });
    flight = { what: `${sent} ${coin} sent on ${route.label} to the wallet's SoDEX deposit address ${to} - not credited yet`, since: Date.now(), ref: p.explorer };
    ctx.inFlight.push(flight);
    const want = unitsDown(sent, sodexDp);
    const eta = route.deposit.etaSeconds ? `SoDEX estimate ~${Math.max(1, Math.round(route.deposit.etaSeconds / 60))} min` : 'no SoDEX estimate';
    const waitMs = Math.max(creditWaitMs(ctx, route.deposit.etaSeconds), 60 * 60_000);
    const t0 = Date.now();
    const r = await rec.sub(`wait for SoDEX to credit Spot +${sent} ${coin} (${eta})`, () =>
      waitMaybe({
        timeoutMs: waitMs,
        intervalMs: 20_000,
        probe: async () => ({ spot: unitsDown((await balancesOf(owner, o.coinCfg)).spot, sodexDp), ok: await chain.confirmed(p.txid).catch(() => null) }),
        done: (v) => v.spot >= spot0 + want || v.ok === false,
      }),
    );
    const last = r.value;
    if (last?.ok === false) {
      ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
      ctx.checks.fail(dId, `the transfer FAILED on ${route.label} (${p.explorer}) - the ${coin} did not leave ${here}, but its fee did`, { tx: p.txid });
      return;
    }
    if (!r.ok || !last) {
      ctx.checks.finding(dId, `sent on ${route.label} (DIRECT, ${p.explorer}), but Spot was not credited +${sent} ${coin} within ${dur(waitMs)} (${last?.ok ? 'final on the chain' : 'not yet final on the chain'}) - IN FLIGHT: SoDEX credits it once its custody sees it`, { tx: p.txid, sent });
      // Final on its chain: the coins are SoDEX's to credit (2026-10-04: a first deposit to a new XRP / Stellar
      // address was credited well after an hour). The end-of-run check reports it as a finding, not an open transfer.
      if (last?.ok) flight.depositFinal = true;
      return;
    }
    ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
    const credited = formatUnits(last.spot - spot0, sodexDp);
    addOther(ctx, coin, last.spot - spot0);
    rec.amount(`deposit back ${coin} from ${route.label}`, `sent ${sent}, credited ${credited}`);
    ctx.checks.pass(
      dId,
      `${sent} ${coin} sent on ${route.label} (DIRECT, ${p.txid}) from the test wallet's own address to the deposit address the app's Deposit sheet and the on-chain registry both name; Spot was credited ${credited} ${coin} after ${dur(Date.now() - t0)}; network fee ${formatUnits(p.fee, natDp)} ${natSym}`,
      { tx: p.txid, from: here, depositAddress: to, sent, credited, direct: true },
    );
  } catch (e) {
    if (flight) {
      ctx.checks.finding(dId, `${errText(e)} - after the transfer was sent (${flight.ref ?? ''}): IN FLIGHT`);
      return;
    }
    ctx.checks.fail(dId, errText(e));
  }
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
