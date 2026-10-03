/**
 * The evm-tour step (profiles evm-tour, all-chains): every EVM chain SoDEX
 * pays out to that the runner can sign on (chains.ts), out and back.
 *
 * Per chain, in this order:
 *   1. the chain's NATIVE coin (ETH, BNB, AVAX, HYPE - on Arc that is USDC):
 *      bought on Spot if Spot holds too little, withdrawn to this wallet on the
 *      chain through the app's withdrawFunds (one permit), and then sent BACK to
 *      the wallet's own SoDEX deposit address there by a plain value transfer.
 *      The app has no function that sends a native coin (its Deposit sheet only
 *      shows the address), so THE RUNNER SENDS IT - the second stated exception,
 *      labelled DIRECT: the address must be the one the app's Deposit sheet
 *      offers AND the one the on-chain registry lists, the network guard lets
 *      exactly that transfer out (kind `native-transfer`: chain, sender,
 *      receiver, value) and the wallet signs exactly that one.
 *      What comes back keeps a little for gas, so the USDC deposit can pay it.
 *   2. USDC (where the app sends USDC from): withdrawn to this wallet there,
 *      deposited back with the app's own sendUsdcDeposit.
 * Every coin bought for the tour is sold back to USDC once the last chain that
 * needs it is done (evmTour.sellBack). A chain with USDC but no native route
 * (Polygon) needs gas from the owner - the plan asks for it.
 */
import { balancesOf, unitsDown, withdrawQuote } from '../../src/trading/funds';
import { formatUnits, parseUnits } from '../../src/trading/onboard';
import { addOrSwitchChain, sendTransaction } from '../../src/wallet';
import { SafetyStop, armed, endsTheRun, tripFailed, type Ctx } from './context';
import { marketQty, checkDepositAddress, depositAddressProblem, ownerGasNeed, spotMarketFor } from './plan';
import { nativeBalance, receipt, registryDepositAddresses } from './reads';
import { buyOnSpot, creditWaitMs, depositOne, moved, routeCheck, withdrawTo } from './steps';
import { mustPlace, orderMs, settleFills, waitFor } from './orders';
import { depositBackProblem, depositFloor, gasReserve, nativeLegAmounts, nativeTransferExpect, nativeTransferPolicy, oneWayAmount, oneWayUsdcAmount, reserveGasUnits, tourPlan, usdcLegAmounts, type TourLeg } from './tour';
import { ensureTrading } from './trading';
import { approx, cut, dCmp, dMax, dSub, toStep, usd } from './util';

// --- the step ------------------------------------------------------------------------------------------

/**
 * Send `amount` of a chain's native coin back to the wallet's own SoDEX deposit
 * address there and wait for Spot to be credited. DIRECT: the runner sends it.
 */
async function depositNative(ctx: Ctx, leg: TourLeg, amount: string): Promise<{ detail: string; evidence: Record<string, unknown>; costUsd: number }> {
  const { owner, rec } = ctx;
  const { spec, coin } = leg;
  const coinDp = coin.valuechain.decimals;
  const d = await rec.sub(
    `the ${coin.coin} deposit address on ${leg.label}: the app's Deposit sheet vs the on-chain registry`,
    () => checkDepositAddress(owner, leg.chain, { registryOnly: false, waitMs: ctx.cfg.timeouts.addressIssueSeconds * 1000, coin: coin.coin, say: (s) => rec.line(s, 7) }),
    (x) => `${x.backend ?? '-'} vs ${x.registry ?? '-'}`,
  );
  const bad = depositAddressProblem(owner, leg.chain, d, { coin: coin.coin });
  if (bad) throw new SafetyStop(`deposit address: ${bad}`);
  const to = d.backend!.toLowerCase();
  // Never a deposit SoDEX would not credit: below its minimum it is lost, not refunded.
  if (leg.route.deposit.min && dCmp(amount, leg.route.deposit.min) < 0) throw new SafetyStop(`${amount} ${coin.coin} is below SoDEX's deposit minimum ${leg.route.deposit.min} on ${leg.label} - nothing was sent`);
  const value = parseUnits(amount, spec.native.decimals);
  const have = await nativeBalance(spec.rpcUrl, owner);
  if (have <= value) throw new SafetyStop(`the wallet holds ${formatUnits(have, spec.native.decimals)} ${spec.native.symbol} on ${spec.name} - not ${amount} plus gas`);
  const spot0 = unitsDown((await balancesOf(owner, coin)).spot, coinDp);
  const label = `DIRECT native transfer: ${amount} ${spec.native.symbol} on ${spec.name} to the verified deposit address ${to}`;
  const hash = await rec.sub(`send ${amount} ${spec.native.symbol} on ${spec.name} to ${to} (the runner sends it: the app has no function that sends a native coin - labelled DIRECT)`, () =>
    armed(ctx, { expect: [nativeTransferExpect({ chainId: spec.chainId, from: owner, to, value, label })], policy: nativeTransferPolicy({ chainId: spec.chainId, to, value }) }, async () => {
      await addOrSwitchChain(ctx.provider, { chainId: `0x${spec.chainId.toString(16)}`, chainName: spec.name, rpcUrls: [spec.rpcUrl], blockExplorerUrls: [spec.explorer], nativeCurrency: spec.native });
      return sendTransaction(ctx.provider, { from: owner, to, data: '0x', value: `0x${value.toString(16)}`, chainId: spec.chainId });
    }),
  );
  const flight = { what: `${amount} ${spec.native.symbol} sent on ${spec.name} to the wallet's SoDEX deposit address ${to} - not credited yet`, since: Date.now(), ref: `${spec.explorer}/tx/${hash}` };
  ctx.inFlight.push(flight);
  const rc = await rec.sub(`wait for the receipt on ${spec.name}`, () =>
    waitFor(ctx, `the receipt on ${spec.name}`, {
      timeoutMs: 10 * 60_000,
      intervalMs: 3000,
      probe: async () => {
        const r = await receipt(spec.rpcUrl, hash);
        if (!r) throw new Error('not mined yet');
        return r;
      },
      done: () => true,
      show: () => 'not mined yet',
    }),
  );
  const gasWei = rc.gasUsed * rc.effectiveGasPrice;
  const gas = formatUnits(gasWei, spec.native.decimals);
  if (rc.status !== 'success') {
    ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
    throw new Error(`the transfer REVERTED on ${spec.name} (${spec.explorer}/tx/${hash}) - nothing left the wallet but the gas`);
  }
  rec.fee(`gas on ${spec.name}`, `${cut(gas, 10)} ${spec.native.symbol}`);
  // Spot is credited in the coin's own decimals on SoDEX (Arc's USDC: 18 on the chain, 6 on SoDEX).
  const want = unitsDown(amount, coinDp);
  const eta = leg.route.deposit.etaSeconds ? `SoDEX estimate ~${Math.max(1, Math.round(leg.route.deposit.etaSeconds / 60))} min` : 'no SoDEX estimate';
  const t0 = Date.now();
  const s1 = await rec.sub(`wait for SoDEX to credit Spot +${amount} ${coin.coin} (${eta})`, () =>
    waitFor(ctx, `SoDEX to credit the ${coin.coin} deposit (${eta})`, {
      timeoutMs: creditWaitMs(ctx, leg.route.deposit.etaSeconds),
      intervalMs: 15_000,
      probe: async () => unitsDown((await balancesOf(owner, coin)).spot, coinDp),
      done: (s) => s >= spot0 + want,
      show: (s) => `Spot ${coin.coin} ${s === undefined ? '?' : formatUnits(s, coinDp)} (want >= ${formatUnits(spot0 + want, coinDp)})`,
    }),
  );
  ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
  const credited = formatUnits(s1 - spot0, coinDp);
  rec.amount(`deposit back ${coin.coin} from ${spec.name}`, `sent ${amount}, credited ${credited}`);
  return {
    detail: `${amount} ${spec.native.symbol} sent on ${spec.name} (DIRECT, ${hash}) to the deposit address the app's Deposit sheet and the on-chain registry both name; Spot was credited ${credited} ${coin.coin} after ${Math.round((Date.now() - t0) / 1000)} s; gas ${cut(gas, 10)} ${spec.native.symbol}`,
    evidence: { tx: hash, chain: leg.chain, depositAddress: to, sent: amount, credited, direct: true },
    costUsd: 0,
  };
}

export async function stepEvmTour(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  await ensureTrading(ctx);
  const plan = tourPlan(ctx.pre.coins, cfg, ctx.selected);
  for (const l of plan.left) rec.note(`${l.label}: not toured - ${l.why}`);
  // The last chain each bought coin is needed on: it is sold back after that one.
  const lastUse = new Map<string, number>();
  plan.chains.forEach((tc, i) => tc.legs.forEach((l) => l.kind === 'native' && !l.skip && l.coin.coin.toUpperCase() !== 'USDC' && lastUse.set(l.coin.coin, i)));
  const bought = new Map<string, bigint>();

  for (const [i, tc] of plan.chains.entries()) {
    const usdcRuns = tc.legs.some((l) => l.kind === 'usdc' && !l.skip);
    for (const leg of tc.legs) {
      const wId = routeCheck(ctx, 'evm-tour', `${leg.chain}#${leg.kind}#withdraw`);
      const dId = routeCheck(ctx, 'evm-tour', `${leg.chain}#${leg.kind}#deposit`);
      if (leg.skip) {
        ctx.checks.skip(wId, leg.skip);
        ctx.checks.skip(dId, leg.skip);
        continue;
      }
      // Each leg on its own: what goes wrong in one is reported there, and the next goes on (the spend cap still ends the run).
      try {
        const quote = await rec.read(`SoDEX's on-chain fee for ${leg.coin.coin} -> ${leg.label}`, () => withdrawQuote(leg.coin, leg.route, owner), (q) => `${formatUnits(q.fee, leg.coin.valuechain.decimals)} ${leg.coin.coin}`);
        const fee = formatUnits(quote.fee, leg.coin.valuechain.decimals);
        // The way back must exist BEFORE anything leaves (Arc: SoDEX issues no USDC deposit address there). Without
        // one, the withdrawal alone is tested - with the least SoDEX pays out - and what arrives is reported, never a stop.
        const listed = await registryDepositAddresses(owner, leg.coin.coin).catch(() => null);
        const noBack = depositBackProblem(leg, listed);
        if (noBack) {
          const one = oneWayAmount(leg.route, leg.coin, fee);
          const held = (await balancesOf(owner, leg.coin)).spot;
          if (dCmp(held, one) < 0) {
            ctx.checks.skip(wId, `${noBack}, and Spot holds ${held} ${leg.coin.coin} - less than the ${one} a one-way withdrawal needs`);
            ctx.checks.skip(dId, noBack);
            continue;
          }
          let arrived = dSub(one, fee);
          await moved(ctx, wId, async () => {
            const r = await withdrawTo(ctx, { coin: leg.coin, route: leg.route, receiverName: 'self', amount: one });
            if (typeof r.evidence.received === 'string') arrived = r.evidence.received;
            return r;
          });
          ctx.checks.set(dId, 'not-run', `not run: ${noBack}. The ${cut(arrived, 6)} ${leg.coin.coin} that arrived stays in the test wallet on ${leg.label}.`, { chain: leg.chain, leftOnChain: arrived, reason: noBack });
          rec.note(`${leg.label}: ${noBack} - the withdrawal alone was tested; ${cut(arrived, 6)} ${leg.coin.coin} stays in the test wallet there`);
          continue;
        }
        if (leg.kind === 'native') {
          const reserve = await gasReserve(tc.spec, reserveGasUnits(usdcRuns));
          const amt = nativeLegAmounts(leg.route, leg.coin, fee, reserve);
          const isUsdc = leg.coin.coin.toUpperCase() === 'USDC';
          if (!isUsdc) {
            const held = (await balancesOf(owner, leg.coin)).spot;
            if (dCmp(held, amt.withdraw) < 0) {
              const m = await spotMarketFor(leg.coin).catch(() => null);
              if (!m) {
                const why = `Spot holds ${held} ${leg.coin.coin} and SoDEX has no ${leg.coin.coin}/USDC spot market to buy ${amt.withdraw} on`;
                ctx.checks.skip(wId, why);
                ctx.checks.skip(dId, why);
                if (usdcRuns) rec.warn('gas', `${tc.label}: no ${leg.coin.coin} comes back for gas - the USDC deposit back needs ${tc.spec.native.symbol} already in the wallet there`);
                continue;
              }
              const dp = leg.coin.valuechain.decimals;
              const b0 = unitsDown(held, dp);
              await buyOnSpot(ctx, leg.coin, amt.withdraw, wId);
              const b1 = unitsDown((await balancesOf(owner, leg.coin)).spot, dp);
              bought.set(leg.coin.coin, (bought.get(leg.coin.coin) ?? 0n) + (b1 > b0 ? b1 - b0 : 0n));
            }
          }
          let received = '0';
          await moved(ctx, wId, async () => {
            const r = await withdrawTo(ctx, { coin: leg.coin, route: leg.route, receiverName: 'self', amount: amt.withdraw });
            received = typeof r.evidence.received === 'string' ? r.evidence.received : dSub(amt.withdraw, fee);
            return r;
          });
          // What arrived, less what stays for gas - never below SoDEX's deposit minimum.
          const reserveNow = await gasReserve(tc.spec, reserveGasUnits(usdcRuns));
          const dp = Math.min(leg.coin.valuechain.decimals, tc.spec.native.decimals, 8);
          const back = dMax(depositFloor(leg.route, dp), toStep(dSub(received, reserveNow), dp <= 0 ? '1' : `0.${'0'.repeat(dp - 1)}1`, 'floor'));
          if (dCmp(back, '0') <= 0) throw new SafetyStop(`${received} ${leg.coin.coin} arrived on ${tc.label}: nothing left to send back after ${reserveNow} for gas`);
          await moved(ctx, dId, () => depositNative(ctx, leg, back));
        } else {
          if (tc.ownerGas) {
            // SoDEX lists no route for this chain's gas coin (Polygon: POL), so the run cannot get any. The deposit back
            // runs only if the wallet already holds enough; otherwise the withdrawal alone is tested.
            const sym = tc.spec.native.symbol;
            const need = await ownerGasNeed(tc.chain);
            const have = await nativeBalance(tc.spec.rpcUrl, owner).catch(() => 0n);
            const held = formatUnits(have, tc.spec.native.decimals);
            if (approx(held) + 1e-12 < need) {
              const one = oneWayUsdcAmount(leg.route, fee);
              let arrived = dSub(one, fee);
              await moved(ctx, wId, async () => {
                const r = await withdrawTo(ctx, { coin: leg.coin, route: leg.route, receiverName: 'self', amount: one });
                if (typeof r.evidence.received === 'string') arrived = r.evidence.received;
                return r;
              });
              ctx.checks.set(
                dId,
                'not-run',
                `not run: no ${sym} for gas on ${tc.label} - SoDEX lists no ${sym} route, so the run cannot get any, and the wallet holds ${cut(held, 6)} ${sym} (the USDC deposit back needs ~${need} ${sym}). The ${cut(arrived, 6)} USDC that arrived stays in the test wallet on ${tc.label}; send ~${need} ${sym} there to move it.`,
                { chain: tc.chain, gasHeld: held, gasNeeded: String(need), leftOnChain: arrived },
              );
              rec.note(`${tc.label}: the USDC deposit back is not run - no ${sym} for gas (the wallet holds ${cut(held, 6)}, it needs ~${need}); ${cut(arrived, 6)} USDC stays in the test wallet there`);
              continue;
            }
          }
          const amt = usdcLegAmounts(leg.route, fee);
          await moved(ctx, wId, () => withdrawTo(ctx, { coin: leg.coin, route: leg.route, receiverName: 'self', amount: amt.withdraw }));
          await moved(ctx, dId, () => depositOne(ctx, leg.chain, amt.back));
        }
      } catch (e) {
        if (endsTheRun(e)) throw e;
        tripFailed(ctx, `${leg.coin.coin} on ${leg.label}`, e, [wId, dId]);
      }
    }
    if (cfg.evmTour.sellBack) {
      for (const [coinName, last] of lastUse) {
        if (last !== i) continue;
        await sellBack(ctx, coinName, bought.get(coinName) ?? 0n, 'evm-tour', 'what the tour bought');
      }
    }
  }
}

/** Sell what a step bought of `coinName` back to USDC (at most `boughtUnits`, at least the market's minimum). */
export async function sellBack(ctx: Ctx, coinName: string, boughtUnits: bigint, tag: string, what: string): Promise<void> {
  const { owner, rec } = ctx;
  const coin = ctx.pre.coins.find((c) => c.coin === coinName);
  if (!coin || boughtUnits <= 0n) return;
  const dp = coin.valuechain.decimals;
  const held = unitsDown((await balancesOf(owner, coin)).spot, dp);
  const m = await spotMarketFor(coin).catch(() => null);
  if (!m) return;
  const qty = toStep(formatUnits(held < boughtUnits ? held : boughtUnits, dp), m.sym.stepSize || '0', 'floor');
  const notional = approx(qty) * approx(m.bid);
  const minN = Math.max(approx(m.sym.minNotional), approx(marketQty(m, 0)) * approx(m.bid));
  if (dCmp(qty, '0') <= 0 || notional < minN * 1.02) {
    rec.note(`${coin.coin}: ${cut(formatUnits(held, dp), 8)} left in Spot (~${usd(notional)}, below what ${m.sym.name} sells)`);
    return;
  }
  const placed = await rec.sub(`sell back ${qty} ${coin.coin} on ${m.sym.name} (${what})`, () =>
    mustPlace(ctx, { market: m, side: 'sell', type: 'market', quantity: qty, tag, label: `sell back ${qty} ${coin.coin}` }),
  );
  await rec.sub(`verify: Spot ${coin.coin} went down by ${qty}`, () =>
    waitFor(ctx, `${coin.coin} sold`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: async () => unitsDown((await balancesOf(owner, coin)).spot, dp), done: (v) => v + unitsDown(qty, dp) <= held, show: (v) => `Spot ${coin.coin} ${v === undefined ? '?' : formatUnits(v, dp)}` }),
  );
  const s = await settleFills(ctx, m, placed.id, qty);
  rec.amount(`sold back ${coin.coin}`, `${qty} on ${m.sym.name}; ${s.note}`);
}
