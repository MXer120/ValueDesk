/**
 * The chains the runner cannot sign on (profile all-chains).
 *
 *   chain-withdrawals  per route SoDEX pays out to on such a chain (Solana,
 *                      Bitcoin, XRP ...): the smallest amount the owner could send
 *                      straight back (at least the minimum, and what arrives clears
 *                      the deposit minimum - tour.ts roundTripAmount), withdrawn through the app's
 *                      withdrawFunds to the OWNER's own address there -
 *                      `receivers.<chain key in lower case>`. A route without that
 *                      receiver is skipped with a plain line. The arrival cannot be
 *                      read from here: SoDEX's withdrawal record is the evidence.
 *   manual-deposits    the deposits the owner opted into (`manualDeposits`): the
 *                      run shows the address the app's Deposit sheet offers - only
 *                      when the on-chain registry lists the same one - and waits
 *                      for Spot to be credited. It signs and sends nothing.
 */
import { balancesOf, chainLabel, unitsDown, withdrawQuote } from '../../src/trading/funds';
import { formatUnits } from '../../src/trading/onboard';
import { chainWithdrawals } from './chainRoutes';
import type { Ctx } from './context';
import { waitMaybe } from './orders';
import { checkDepositAddress, depositAddressProblem, spotMarketFor } from './plan';
import { buyOnSpot, moved, routeCheck, withdrawTo } from './steps';
import { roundTripAmount } from './tour';
import { ensureTrading } from './trading';
import { cut, dCmp, dur } from './util';

export async function stepChainWithdrawals(ctx: Ctx): Promise<void> {
  const { owner, cfg } = ctx;
  await ensureTrading(ctx);
  for (const w of chainWithdrawals(ctx.pre.coins, cfg)) {
    const id = routeCheck(ctx, 'chain-withdrawals', `${w.route.key}#${w.coin.coin}`);
    if (w.skip) {
      ctx.checks.skip(id, w.skip);
      continue;
    }
    const quote = await ctx.rec.sub(`SoDEX's on-chain fee for ${w.coin.coin} -> ${w.route.label}`, () => withdrawQuote(w.coin, w.route, owner), (q) => `${formatUnits(q.fee, w.coin.valuechain.decimals)} ${w.coin.coin}`);
    const amount = roundTripAmount(w.route, w.coin, formatUnits(quote.fee, w.coin.valuechain.decimals));
    const held = (await balancesOf(owner, w.coin)).spot;
    if (dCmp(held, amount) < 0) {
      const m = cfg.chainWithdrawals.buyIfMissing ? await spotMarketFor(w.coin).catch(() => null) : null;
      if (!m) {
        ctx.checks.skip(id, `Spot holds ${held} ${w.coin.coin}, less than the ${amount} minimum, and ${cfg.chainWithdrawals.buyIfMissing ? `SoDEX has no ${w.coin.coin}/USDC spot market to buy it on` : 'chainWithdrawals.buyIfMissing is off'}`);
        continue;
      }
      await buyOnSpot(ctx, w.coin, amount, id);
    }
    await moved(ctx, id, () => withdrawTo(ctx, { coin: w.coin, route: w.route, receiverName: w.receiverName, amount }));
  }
}

export async function stepManualDeposits(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  for (const [i, d] of cfg.manualDeposits.entries()) {
    const id = routeCheck(ctx, 'manual-deposits', i);
    const coin = ctx.pre.coins.find((c) => c.coin.toUpperCase() === d.coin.toUpperCase());
    const route = coin?.chains.find((r) => r.key === d.chain);
    if (!coin || !route) {
      ctx.checks.skip(id, `SoDEX lists no ${d.coin} route on ${chainLabel(d.chain)}`);
      continue;
    }
    if (!route.deposit.allowed) {
      ctx.checks.skip(id, `${d.coin} deposits from ${route.label} are closed on SoDEX right now`);
      continue;
    }
    if (route.addressKind === 'other') {
      ctx.checks.skip(id, `the app does not offer ${route.label}`);
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
      continue;
    }
    const address = a.backend!;
    const dp = coin.valuechain.decimals;
    const s0 = unitsDown((await balancesOf(owner, coin)).spot, dp);
    const want = unitsDown(d.amount, dp);
    rec.line('');
    rec.line(`   >>> SEND BY HAND: at least ${d.amount} ${coin.coin} on ${route.label}`);
    rec.line(`   >>> to ${address}`);
    if (route.memo) rec.line('   >>> No memo / tag is needed (the address is this account\'s own). If the sending exchange insists on one, any 9-digit number will do.');
    rec.line(`   >>> the run waits up to ${cfg.timeouts.depositMinutes} min for Spot ${coin.coin} to rise by ${d.amount}`);
    rec.line('');
    ctx.onManualDeposit?.({ coin: coin.coin, chain: route.key, address, amount: d.amount });
    const t0 = Date.now();
    const r = await waitMaybe({ timeoutMs: cfg.timeouts.depositMinutes * 60_000, intervalMs: 15_000, probe: async () => unitsDown((await balancesOf(owner, coin)).spot, dp), done: (s) => s >= s0 + want });
    const got = r.value !== undefined ? r.value - s0 : 0n;
    if (r.ok) {
      ctx.checks.pass(id, `${formatUnits(got, dp)} ${coin.coin} sent by hand from ${route.label} to ${address} (the address the app's Deposit sheet and the on-chain registry both name) was credited to Spot after ${dur(Date.now() - t0)}`, { address, chain: route.key, credited: formatUnits(got, dp) });
      rec.amount(`manual deposit ${coin.coin} from ${route.label}`, formatUnits(got, dp));
    } else {
      // Nothing was sent by the runner: a deposit that arrives later is still credited to Spot.
      ctx.checks.fail(id, `Spot ${coin.coin} rose by ${cut(formatUnits(got > 0n ? got : 0n, dp), 8)} in ${dur(Date.now() - t0)}, not by ${d.amount} - if you sent it, SoDEX credits it when its custody sees it`, { address, chain: route.key });
      if (got <= 0n) ctx.inFlight.push({ what: `a manual ${coin.coin} deposit from ${route.label} to ${address} (if you sent one) - not credited when the run checked`, since: t0 });
    }
  }
}
