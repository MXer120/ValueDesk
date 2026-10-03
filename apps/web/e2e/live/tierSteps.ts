/**
 * The builder fee and its tiers, live: docs/BUILDER-TIERS.md section 8, items
 * 1 to 7. In the order things happen to a new wallet:
 *
 *   1. the server's terms for it verify under the pinned key (the runner's own
 *      check, terms.ts) and say the default fee;
 *   2. a tampered copy of that answer is refused by the app (default fee used);
 *   3. the first orders carry the default fee, and their fills pay it;
 *   4. their volume passes the milestone; after a hint the server verifies it
 *      from SoDEX's records and signs the lower fee - a bounded wait, during
 *      which this run reads no order history (the verifier needs that budget);
 *   5. the next order carries the lower fee, and its fill pays it;
 *   6. two CHEATING orders - one with a lower fee than owed, one with no builder
 *      at all - are sent AROUND the app's gate. These two the runner builds and
 *      signs itself with @sodex-core and the trading key: it stands in for a
 *      person who rewrote the app. Each leaves through the guard as a
 *      `direct-order` with exactly its bytes. Neither may be credited, the first
 *      must raise `underpaid`, and the terms must be back on the default fee;
 *   7. the approval is lowered below the fee owed, then revoked: the app must
 *      send nothing - and after approving again, orders go out as before.
 * (Whether a modified / replaced order keeps its builder is observed where
 * orders are changed, orderSteps.ts; the builder account's income is reconciled
 * in the final cross-check.)
 */
import { OrderSide, OrderType, TimeInForce, canonicalDecimal, nonceKey, perpsActions } from '@sodex-core';
import { fullyApproved, ratesOf } from '../../src/trading/builder';
import { readBuilderRates, submitBuilderApproval } from '../../src/trading/builderApproval';
import { setTradingConfig, tradingConfig } from '../../src/trading/config';
import { genClOrdID } from '../../src/trading/orderParams';
import { approveBuilderFee, getTradingState, nonces, readBuilderApproval, refreshBuilderApproval, revokeBuilderApproval, sodexAccountId } from '../../src/trading/session';
import { app, feeNumber } from './app';
import { CheckFailure, SafetyStop, armed, scenario, type Ctx } from './context';
import { fillKey, fillOk, rateBp, type FillCheck } from './fees';
import type { LedgerOrder } from './ledger';
import {
  clearLeftovers,
  cancel,
  ensurePerpsCollateral,
  expectGone,
  expectOpen,
  expectPosition,
  flatten,
  idText,
  judgeFills,
  mustPlace,
  positionOf,
  putInOrder,
  refusedLocally,
  releasePerpsCollateral,
  rememberMarket,
  sameBuilder,
  sendDirect,
  settleFills,
  settleMs,
  ticketOf,
  waitFor,
  type OrderSpec,
} from './orders';
import { marketQty, readMarket, restingBuy, type Market } from './plan';
import { requestTerms, type FeePair, type TermsVerdict } from './terms';
import { builderApprovalExpect, builderApprovalPolicy, ensureTrading, registerKey } from './trading';
import { approx, cut, dAdd, dMul, dur, errText, pollUntil } from './util';

const TIER_IDS = [
  'builder-terms-signed',
  'builder-terms-tamper-rejected',
  'builder-fee-default',
  'builder-volume-verified',
  'builder-fee-lowered',
  'builder-underpaid-not-counted',
  'builder-no-builder-not-counted',
  'builder-no-builder-flagged',
  'builder-terms-back-to-default',
  'builder-approval-enforced',
  'builder-reapproved-orders-resume',
] as const;

const notRun = (ctx: Ctx, ids: readonly string[], why: string): void => {
  for (const id of ids) if (!ctx.checks.get(id)) ctx.checks.set(id, 'not-run', why);
};

const feeText = (f: FeePair | null): string => (f ? `perps ${f.perps} / spot ${f.spot}` : 'none');

/** What an order's fills amount to, in the quote coin: SoDEX's own figure when the stream gave it, else price x quantity. */
function executedValue(ctx: Ctx, o: LedgerOrder): string | null {
  if (o.executedValue && approx(o.executedValue) > 0) return o.executedValue;
  const fills = ctx.ledger.fillsOf(o.engine, o);
  return fills.length ? fills.reduce((s, f) => dAdd(s, dMul(f.price, f.quantity)), '0') : null;
}

/**
 * Judge "orders of this scenario carried exactly `fee`, their records name the
 * builder with it, and every fill paid that share" from the ledger. Run at the
 * end of the scenario and again by the final cross-check, when the fill history
 * has been read (a run without the account stream is judged then).
 */
export function judgeFeeScenario(ctx: Ctx, id: 'builder-fee-default' | 'builder-fee-lowered', fee: number): void {
  const b = ctx.cfg.builder;
  if (!b) return;
  const orders = ctx.ledger.orders.filter((o) => o.tag === id && o.origin === 'app' && o.accepted !== false);
  if (!orders.length) return;
  const wrong = orders.filter((o) => !o.builder || o.builder.id !== b.id || o.builder.fee !== fee);
  if (wrong.length) {
    ctx.checks.fail(id, `${wrong.length} order(s) did not carry builder #${b.id} at ${fee}: ${wrong.map((o) => `${o.label} carried ${o.builder ? o.builder.fee : 'no builder'}`).join('; ')}`, { fee });
    return;
  }
  const recorded = orders.filter((o) => o.recordBuilder !== undefined);
  const badRecord = recorded.filter((o) => !sameBuilder(o.recordBuilder, o.builder));
  if (badRecord.length) {
    ctx.checks.fail(id, `SoDEX's record of ${badRecord[0]!.label} names ${badRecord[0]!.recordBuilder ? `builder #${badRecord[0]!.recordBuilder.id} at ${badRecord[0]!.recordBuilder.fee}` : 'no builder'}, not #${b.id} at ${fee}`, { fee });
    return;
  }
  const fills: FillCheck[] = orders.flatMap((o) => ctx.ledger.fillsOf(o.engine, o)).map((f) => ctx.fillChecks.get(fillKey(f))).filter((c): c is FillCheck => !!c);
  const evidence = {
    fee,
    orders: orders.map((o) => ({ label: o.label, orderID: o.orderID, carried: o.builder, record: o.recordBuilder ?? 'not seen', recordFrom: o.recordSource })),
    fills: fills.map((c) => ({ orderID: c.fill.orderID, tradeID: c.fill.tradeID, notional: c.notional, builderFee: c.fill.builderFee, expected: c.expectedBuilderFee })),
  };
  if (!fills.length) {
    ctx.checks.set(id, 'not-run', `${orders.length} order(s) left carrying ${fee} (${rateBp(fee)}), but the account stream reported no fill - their fills are judged in the final cross-check`, evidence);
    return;
  }
  const bad = fills.filter((c) => !fillOk(c) && c.builderProblems.length);
  if (bad.length) {
    ctx.checks.fail(id, `${bad.length} of ${fills.length} fill(s): ${bad[0]!.builderProblems[0]}`, evidence);
    return;
  }
  ctx.checks.pass(
    id,
    `${orders.length} order(s) carried builder #${b.id} at ${fee} (${rateBp(fee)}); ${recorded.length ? `${recorded.length} order record(s) name the builder with it` : 'no order record was seen (the final cross-check reads them)'}; ${fills.length} fill(s) each paid ${rateBp(fee)} of their notional`,
    evidence,
  );
}

/**
 * Poll the terms until `done`; the order history stays untouched meanwhile - the server's
 * verifier needs that budget. The first read carries a hint; another one only once the
 * server has FINISHED a pass that does not show it yet, and at most every minute. A hint
 * on every poll queued a new verification each time, so "pending" never cleared; a single
 * hint left a pass that ran before SoDEX listed the fills ($0 verified, 2026-10-03 17:39)
 * as the last word for the whole wait.
 */
const REHINT_MS = 60_000;

async function waitTerms(ctx: Ctx, what: string, done: (v: TermsVerdict) => boolean): Promise<{ ok: boolean; last: TermsVerdict | undefined; ms: number }> {
  const watch = ctx.terms!;
  let hintAt = 0;
  let idle = false;
  ctx.history?.block('the server\'s fee verifier is reading this wallet\'s order history on SoDEX (it needs the same four-a-minute budget)');
  try {
    const r = await pollUntil({
      timeoutMs: ctx.cfg.timeouts.verifierMinutes * 60_000,
      intervalMs: 10_000,
      probe: async () => {
        const hint = hintAt === 0 || (idle && Date.now() - hintAt >= REHINT_MS);
        if (hint) hintAt = Date.now();
        const v = (await requestTerms(watch, ctx.owner, { hint })).verdict;
        // Nothing pending: the pass the hint asked for has finished, without what we wait for - the next poll may ask again.
        idle = !v.answer.volume?.pending;
        return v;
      },
      done,
      progressEveryMs: 30_000,
      progress: (v, ms) =>
        ctx.rec.line(`... ${dur(ms)} waiting for ${what}: terms ${feeText(v?.answer.fee ?? null)}, verified volume ${v?.answer.volume ? `$${v.answer.volume.totalUsd}${v.answer.volume.pending ? ' (verification pending)' : ''}` : '?'}, flags [${(v?.answer.flags ?? []).join(', ')}]`, 7),
    });
    return r.ok ? { ok: true, last: r.value, ms: r.ms } : { ok: false, last: r.last, ms: r.ms };
  } finally {
    ctx.history?.unblock();
    // Whatever the verifier read just now came out of the same budget.
    ctx.history?.touch();
  }
}

export async function stepBuilderTiers(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const b = cfg.builder;
  const watch = ctx.terms;
  if (!b || !watch) throw new SafetyStop('the builder-tiers step needs a builder with termsKeys in the config');
  const D: FeePair = { perps: b.feePerps, spot: b.feeSpot };
  await ensureTrading(ctx);
  const ref = cfg.orders.perpsSymbol;
  const fresh = async (): Promise<Market> => {
    const x = await readMarket('perps', ref);
    rememberMarket(x);
    return x;
  };
  let m = await fresh();
  await clearLeftovers(ctx, m, 'builder-tiers');
  const unit = marketQty(m, 10);
  const unitUsd = approx(unit) * approx(m.ask);
  await ensurePerpsCollateral(ctx, String(Math.max(approx(cfg.orders.perpsCollateral), Math.ceil(unitUsd * 0.6 + 3))));
  const appTerms = ctx.appTerms;
  const appFee = (engine: 'perps' | 'spot'): number | null => (appTerms ? feeNumber(appTerms.feeNow(engine, owner)) : null);
  ctx.tiers.defaultFee = D.perps;

  /** A resting order far below the market that must carry exactly `fee`; cancelled again. Proves what the app attaches without a fill. */
  const restingProbe = async (tag: string, fee: number, what: string): Promise<void> => {
    m = await fresh();
    const rb = restingBuy(m, cfg.orders.perpsLimitOffsetPct);
    const r = await mustPlace(ctx, { market: m, side: 'buy', type: 'limit', tif: 'gtc', price: rb.price, quantity: rb.qty, builderFee: fee, tag, label: what });
    await expectOpen(ctx, m, r.id, what);
    await cancel(ctx, m, r.id, `${what}: cancel`, tag);
    await expectGone(ctx, m, r.id, what);
  };

  // --- 1. the terms verify ---------------------------------------------------------------------------------------
  let first: TermsVerdict | null = null as TermsVerdict | null;
  let next = null as { atUsd: number; perps: number; spot: number } | null;
  await scenario(ctx, 'builder-terms-signed', async () => {
    const t = await requestTerms(watch, owner);
    const v = t.verdict;
    first = v;
    if (v.off) throw new CheckFailure('the server answers `builderId: null`: fee tiers are OFF on the backend (it has no builder-tiers.json)', { answer: v.answer });
    if (!v.verified) throw new CheckFailure(`the terms answer does not verify: ${v.problems.join('; ')}`, { answer: v.answer });
    const problems: string[] = [];
    if (!/\bno-store\b/i.test(t.cacheControl ?? '')) problems.push(`Cache-Control is "${t.cacheControl ?? ''}", not no-store`);
    if (v.answer.default && (v.answer.default.perps !== D.perps || v.answer.default.spot !== D.spot)) problems.push(`the server's first tier (${feeText(v.answer.default)}) is not this run's default (${feeText(D)})`);
    if (problems.length) throw new CheckFailure(problems.join('; '), { answer: v.answer });
    const announced = v.answer.tier?.next ? { atUsd: v.answer.tier.next.atUsd, perps: v.answer.tier.next.fee.perps, spot: v.answer.tier.next.fee.spot } : null;
    next = b.expectTier ?? announced;
    ctx.checks.pass(
      'builder-terms-signed',
      `terms for ${owner}: ${feeText(v.answer.fee)} (default ${feeText(v.answer.default)}), valid ${Math.round((v.answer.ttl ?? 0) / 60_000)} min, signed by key ${v.keyId}; verified volume $${v.answer.volume?.totalUsd ?? '?'}; next tier ${announced ? `from $${announced.atUsd}: perps ${announced.perps} / spot ${announced.spot}` : 'none'}; flags [${v.answer.flags.join(', ')}]`,
      { fee: v.answer.fee, default: v.answer.default, volume: v.answer.volume, tier: v.answer.tier, flags: v.answer.flags, keyId: v.keyId, expectedTier: next },
    );
    if (b.expectTier && announced && (announced.atUsd !== b.expectTier.atUsd || announced.perps !== b.expectTier.perps || announced.spot !== b.expectTier.spot)) {
      rec.warn('tiers', `the config expects ${JSON.stringify(b.expectTier)}, the server announces ${JSON.stringify(announced)} - the config's values are asserted`);
    }
  });
  if (!first || !first.verified) {
    notRun(ctx, TIER_IDS, 'the server\'s terms did not verify (builder-terms-signed)');
    await releasePerpsCollateral(ctx);
    return;
  }
  const startFee = first.answer.fee!;
  const alreadyLower = startFee.perps < D.perps || startFee.spot < D.spot;
  const flagged = first.answer.flags.includes('underpaid');

  if (appTerms) {
    const got = await appTerms.refreshTerms(owner);
    rec.note(`the app's terms module: ${got ? 'verified terms' : 'NO verified terms (it uses the default fee)'}; an order placed now carries perps ${appFee('perps')} / spot ${appFee('spot')}`);
  } else rec.note('this checkout has no app terms module: the app always carries the default fee, and the checks that need it to follow the terms are reported as not run');

  // --- 2. a tampered answer --------------------------------------------------------------------------------------
  await scenario(
    ctx,
    'builder-terms-tamper-rejected',
    async () => {
      if (!appTerms) {
        ctx.checks.set('builder-terms-tamper-rejected', 'not-run', 'the app has no terms module (apps/web/src/trading/terms.ts) in this checkout');
        return;
      }
      const real = startFee.perps;
      if (real <= 0) {
        ctx.checks.set('builder-terms-tamper-rejected', 'not-run', 'the signed perps fee is 0: there is no lower fee to forge');
        return;
      }
      const forged = real > 10 ? real - 10 : real - 1;
      // Terms the app verified before stay in force until they run out: a refused answer must leave them as they were.
      const held = appFee('perps');
      let seenBody = false;
      ctx.tamperTerms = (body) => {
        seenBody = true;
        // The real answer, real signature - with a lower perps fee written into it.
        return { ...body, fee: { ...((body.fee as object | undefined) ?? {}), perps: forged } };
      };
      let answer: unknown;
      try {
        answer = await appTerms.refreshTerms(owner);
      } finally {
        ctx.tamperTerms = null;
      }
      if (!seenBody) throw new CheckFailure("the app's terms module did not ask through the fetch it was configured with - the tampered copy never reached it");
      const now = appFee('perps');
      if (answer !== null && answer !== undefined) throw new CheckFailure(`the app ACCEPTED a terms answer whose perps fee was changed from ${real} to ${forged} after signing`, { forged, real, feeNow: now });
      if (now === forged || now !== held) throw new CheckFailure(`after the rejected answer the app would carry ${String(now)} on perps; before it, ${String(held)} - a refused answer must change nothing`, { forged, real, feeNow: now, before: held });
      // And it acts on it: an order placed now carries that fee (the guard lets no other out).
      const carry = now ?? D.perps;
      await restingProbe('builder-terms-tamper-rejected', carry, 'a resting order after the tampered terms');
      ctx.checks.pass(
        'builder-terms-tamper-rejected',
        `a real answer with its perps fee changed from ${real} to ${forged} (same signature) was rejected; the app still carries ${carry}${carry === D.perps ? ' (the default)' : ' (the terms it had verified before)'}, and an order placed then carried exactly that`,
        { real, forged, feeNow: now, before: held },
      );
    },
    async () => {
      ctx.tamperTerms = null;
      await putInOrder(ctx, m, 'builder-terms-tamper-rejected');
    },
  );
  // The untampered terms again.
  if (appTerms) await appTerms.refreshTerms(owner);

  // --- 3. the first orders carry the default fee ---------------------------------------------------------------------
  const startOwed = appTerms ? startFee.perps : D.perps;
  let counted = '0'; // what the run's own counted orders amount to (USD), by its own book
  const roundTrip = async (tag: string, fee: number, label: string): Promise<void> => {
    m = await fresh();
    const q = marketQty(m, 10);
    const o1 = await mustPlace(ctx, { market: m, side: 'buy', type: 'market', quantity: q, builderFee: fee, tag, label: `${label}: market buy ${q}` });
    await expectPosition(ctx, m.sym.name, q, `the ${m.sym.name} position of ${q}`);
    const s1 = await settleFills(ctx, m, o1.id, q);
    const c = await flattenWith(ctx, m, tag, fee, `${label}: reduce-only close`);
    ctx.checks.addCost(tag, s1.costUsd);
    rec.line(`${label}: bought ${q} (${s1.note}); closed (${c})`, 5);
  };
  await scenario(
    ctx,
    'builder-fee-default',
    async () => {
      if (alreadyLower) {
        ctx.checks.skip('builder-fee-default', `this wallet's terms are already below the default (${feeText(startFee)}, verified volume $${first!.answer.volume?.totalUsd ?? '?'}): the default fee cannot be shown on its first orders. Use a wallet the server has not seen, or clear it (apps/server: npx tsx tools/builderTiers.ts forget --address ${owner})`);
        return;
      }
      await roundTrip('builder-fee-default', startOwed, 'first orders');
      await judgeFills(ctx);
      judgeFeeScenario(ctx, 'builder-fee-default', startOwed);
    },
    () => putInOrder(ctx, m, 'builder-fee-default'),
  );
  /**
   * What the run's own honest orders of this step amount to (USD): every order
   * the APP sent with the builder. `exact` is false when a fill was not seen on
   * the account stream and its value is an estimate at the current price.
   */
  const sumCounted = (): { usd: string; exact: boolean } => {
    let exact = true;
    const usd = ctx.ledger.orders
      .filter((o) => o.engine === 'perps' && o.origin === 'app' && o.builder && o.accepted !== false && (TIER_IDS as readonly string[]).includes(o.tag))
      .reduce((sum, o) => {
        const v = executedValue(ctx, o);
        if (v !== null) return dAdd(sum, v);
        if (o.type !== 'MARKET' || !o.quantity) return sum; // a resting probe: nothing executed
        exact = false;
        return dAdd(sum, dMul(o.quantity, m.ask));
      }, '0');
    return { usd, exact };
  };

  // --- 4. the volume passes the milestone and the terms change ------------------------------------------------------------
  let lowered: TermsVerdict | null = null as TermsVerdict | null;
  await scenario(
    ctx,
    'builder-volume-verified',
    async () => {
      if (!next) {
        ctx.checks.set('builder-volume-verified', 'not-run', 'the server announces no further tier for this wallet (and the config names none): there is no milestone to pass');
        return;
      }
      if (flagged) {
        ctx.checks.skip('builder-volume-verified', `the server has this wallet flagged "underpaid" (an earlier cheating test): it stays on the default fee, so no tier can be reached. Clear it first (apps/server: npx tsx tools/builderTiers.ts forget --address ${owner}), or use a new wallet`);
        return;
      }
      const target = next;
      const before = first!.answer.volume?.totalUsd ?? 0;
      // More round trips only if the first orders did not get the volume past the milestone.
      for (let i = 0; i < 6 && before + approx(sumCounted().usd) <= target.atUsd * 1.05; i++) await roundTrip('builder-volume-verified', appTerms ? (appFee('perps') ?? D.perps) : D.perps, `more volume (${i + 1})`);
      counted = sumCounted().usd;
      if (before + approx(counted) <= target.atUsd) throw new CheckFailure(`the run's own orders amount to $${cut(counted, 4)}; with the $${before} verified before, that does not pass the $${target.atUsd} milestone`);
      rec.line(`the run's counted volume so far: $${cut(counted, 4)} (the server had verified $${before}); the milestone is $${target.atUsd} - hinting, then waiting up to ${dur(cfg.timeouts.verifierMinutes * 60_000)} for the verifier`, 5);
      const w = await waitTerms(ctx, `the signed terms to say perps ${target.perps} / spot ${target.spot}`, (v) => v.verified && !!v.answer.fee && v.answer.fee.perps === target.perps && v.answer.fee.spot === target.spot && (v.answer.volume?.totalUsd ?? 0) > target.atUsd);
      const v = w.last;
      if (!w.ok || !v) {
        throw new CheckFailure(
          `after ${dur(w.ms)} the terms still say ${feeText(v?.answer.fee ?? null)} with $${v?.answer.volume?.totalUsd ?? '?'} verified${v?.answer.volume?.pending ? ' (verification pending)' : ''}; expected perps ${target.perps} / spot ${target.spot} above $${target.atUsd}`,
          { last: v?.answer ?? null, counted },
        );
      }
      lowered = v;
      const server = v.answer.volume!.totalUsd;
      const mine = before + approx(counted);
      if (server > mine * 1.01 + 0.05) throw new CheckFailure(`the server credits $${server}; the run's own orders (plus the $${before} it had before) amount to $${mine.toFixed(4)} - it counts more than was traded`, { server, mine, counted });
      ctx.checks.pass(
        'builder-volume-verified',
        `the server verified $${server} of volume (the run's own book: $${mine.toFixed(4)}) after ${dur(w.ms)}; the signed terms changed from ${feeText(startFee)} to ${feeText(v.answer.fee)} (key ${v.keyId})`,
        { milestoneUsd: target.atUsd, serverVolume: v.answer.volume, runVolumeUsd: mine, before: startFee, after: v.answer.fee, waitedMs: w.ms, tier: v.answer.tier },
      );
    },
    () => putInOrder(ctx, m, 'builder-volume-verified'),
  );

  // --- 5. the next order carries the lower fee ----------------------------------------------------------------------------
  const low = lowered?.answer.fee ?? null;
  await scenario(
    ctx,
    'builder-fee-lowered',
    async () => {
      if (!low) {
        ctx.checks.set('builder-fee-lowered', 'not-run', 'the signed terms did not change to a lower fee (builder-volume-verified)');
        return;
      }
      if (!appTerms) {
        ctx.checks.set('builder-fee-lowered', 'not-run', 'the app has no terms module in this checkout: it cannot follow the signed terms, so its orders stay on the default fee');
        return;
      }
      const got = await appTerms.refreshTerms(owner);
      const now = appFee('perps');
      if (got === null || got === undefined || now !== low.perps) throw new CheckFailure(`the server signs perps ${low.perps}, but the app ${got ? '' : 'has no verified terms and '}would carry ${String(now)}`, { feeNow: now, signed: low });
      ctx.tiers.loweredFee = low.perps;
      await roundTrip('builder-fee-lowered', low.perps, 'order at the lower fee');
      await judgeFills(ctx);
      judgeFeeScenario(ctx, 'builder-fee-lowered', low.perps);
    },
    () => putInOrder(ctx, m, 'builder-fee-lowered'),
  );

  // --- 6. the two cheating orders ---------------------------------------------------------------------------------------
  await cheats(ctx, { m: await fresh(), D, low, first, restingProbe, sumCounted, appFee });

  // --- 7. the approval, lowered and revoked ------------------------------------------------------------------------------
  await approvalEnforcement(ctx, { D, fresh, restingProbe });

  await judgeFills(ctx);
  m = await fresh();
  await putInOrder(ctx, m, 'builder-tiers');
  await releasePerpsCollateral(ctx);
}

/** Close the position with ONE reduce-only market order that must carry exactly `fee`. */
async function flattenWith(ctx: Ctx, m: Market, tag: string, fee: number, label: string): Promise<string> {
  const pos = await positionOf(ctx, m.sym.name);
  if (!pos) return 'already flat';
  const size = String(pos.size);
  const long = approx(size) > 0;
  const qty = canonicalDecimal(size.replace(/^-/, ''));
  const r = await mustPlace(ctx, { market: m, side: long ? 'sell' : 'buy', type: 'market', quantity: qty, reduceOnly: true, builderFee: fee, tag, label });
  await expectPosition(ctx, m.sym.name, '0', `the ${m.sym.name} position to close`);
  const s = await settleFills(ctx, m, r.id, qty);
  ctx.checks.addCost(tag, s.costUsd);
  return s.note;
}

interface CheatInput {
  m: Market;
  D: FeePair;
  low: FeePair | null;
  /** The terms the step started with: what the server had verified BEFORE any order of this step. */
  first: TermsVerdict;
  restingProbe: (tag: string, fee: number, what: string) => Promise<void>;
  /** Every honest order of this step so far, by the run's own book. */
  sumCounted: () => { usd: string; exact: boolean };
  appFee: (engine: 'perps' | 'spot') => number | null;
}

/**
 * The two cheating orders, their close, the verification, and what the server
 * then says. One verification covers both: the under-paying order is ONE unit
 * and the order without a builder TWO units, so the volume tells which of them
 * (if any) was credited.
 */
async function cheats(ctx: Ctx, x: CheatInput): Promise<void> {
  const { owner, rec } = ctx;
  const b = ctx.cfg.builder!;
  const ids = ['builder-underpaid-not-counted', 'builder-no-builder-not-counted', 'builder-no-builder-flagged', 'builder-terms-back-to-default'] as const;
  // The lowest fee the server has signed for this wallet that is still in force: nothing below it is ever owed.
  const owed = Math.min(x.low?.perps ?? x.D.perps, ...(ctx.terms ? ctx.terms.allowedFees('perps') : [x.D.perps]));
  const under = owed - 5 >= 1 ? owed - 5 : owed > 1 ? 1 : 0;
  if (under <= 0 || under >= owed) return notRun(ctx, ids, `the fee owed on perps is ${owed}: there is no lower fee above 0 to under-pay with`);
  const accountId = getTradingState().accountId;
  if (!accountId) return notRun(ctx, ids, 'trading is not enabled');
  let m = x.m;
  const unit = marketQty(m, 10);
  const two = canonicalDecimal(dMul(unit, '2'));
  // The server's figure BEFORE this step's first order; everything since is in the run's own book.
  const before = x.first.answer.volume?.perpsUsd ?? 0;
  let sentUnder = null as LedgerOrder | null;
  let sentNone = null as LedgerOrder | null;
  let closeFee = owed;

  const direct = async (tag: string, qty: string, builder: { id: number; fee: number } | undefined, label: string, purpose: string): Promise<LedgerOrder> => {
    const action = perpsActions.newOrder(accountId, m.sym.id, [{ clOrdID: genClOrdID('vs'), side: OrderSide.BUY, type: OrderType.MARKET, timeInForce: TimeInForce.IOC, quantity: qty, reduceOnly: false }], builder);
    const r = await sendDirect(ctx, 'perps', action, { tag, label, purpose });
    if (!r.accepted || !r.order) throw new CheckFailure(`SoDEX REJECTED the ${label}: ${r.rejection ?? 'no order in the ledger'} - it cannot be shown that the server does not credit it`, { rejection: r.rejection });
    await settleFills(ctx, m, r.id, qty);
    return r.order;
  };

  await scenario(
    ctx,
    'builder-underpaid-not-counted',
    async () => {
      rec.line(`CHEATING ORDER 1 (the runner signs it itself, around the app's gate - it stands in for a modified client): perps market buy ${unit} naming builder #${b.id} at ${under} while ${owed} is owed`, 5);
      sentUnder = await direct('builder-underpaid-not-counted', unit, { id: b.id, fee: under }, `market buy ${unit} with builder fee ${under} (owed: ${owed})`, 'a modified client under-paying the builder fee');
      ctx.tiers.cheats.push({ kind: 'underpaid', orderID: sentUnder.orderID, clOrdID: sentUnder.clOrdID, notional: executedValue(ctx, sentUnder) ?? dMul(unit, m.ask) });
      ctx.checks.set('builder-underpaid-not-counted', 'not-run', 'the order was sent and filled; waiting for the server to verify (below)', { orderID: sentUnder.orderID });
    },
    () => putInOrder(ctx, m, 'builder-underpaid-not-counted'),
  );
  await scenario(
    ctx,
    'builder-no-builder-not-counted',
    async () => {
      rec.line(`CHEATING ORDER 2 (signed by the runner itself, with the app's key and the app's "vs-" order id): perps market buy ${two} with NO builder`, 5);
      sentNone = await direct('builder-no-builder-not-counted', two, undefined, `market buy ${two} without a builder`, 'a modified client sending no builder at all');
      ctx.tiers.cheats.push({ kind: 'no-builder', orderID: sentNone.orderID, clOrdID: sentNone.clOrdID, notional: executedValue(ctx, sentNone) ?? dMul(two, m.ask) });
      ctx.checks.set('builder-no-builder-not-counted', 'not-run', 'the order was sent and filled; waiting for the server to verify (below)', { orderID: sentNone.orderID });
    },
    () => putInOrder(ctx, m, 'builder-no-builder-not-counted'),
  );

  // Close what the two orders opened - through the app, paying what is owed now. This close IS counted.
  m = await readMarket('perps', ctx.cfg.orders.perpsSymbol);
  rememberMarket(m);
  if (await positionOf(ctx, m.sym.name)) {
    closeFee = x.appFee('perps') ?? x.D.perps;
    await rec.sub(`close the position the two cheating orders opened (the app's own order, builder fee ${closeFee})`, () => flattenWith(ctx, m, 'builder-terms-back-to-default', closeFee, 'close after the cheating orders'), (n) => n);
  }
  if (!sentUnder && !sentNone) return notRun(ctx, ['builder-no-builder-flagged', 'builder-terms-back-to-default'], 'neither cheating order was sent');

  // One verification for everything since the baseline.
  const ref = (await requestTerms(ctx.terms!, owner, { hint: true })).verdict.answer.issued ?? Date.now();
  rec.line(`hinting, then waiting up to ${dur(ctx.cfg.timeouts.verifierMinutes * 60_000)} for the server to verify everything since it had $${before} of perps volume`, 5);
  // Verified after the hint is enough: a verification that is queued again does not hide one that finished.
  const w = await waitTerms(ctx, 'the server to verify the cheating orders', (v) => v.verified && !!v.answer.volume && (v.answer.volume.verifiedAt ?? 0) > ref);
  const v = w.last;
  if (!w.ok || !v || !v.answer.volume) {
    const why = `the server did not finish a verification within ${dur(w.ms)} (last: verified at ${v?.answer.volume?.verifiedAt ?? '?'}, pending ${String(v?.answer.volume?.pending ?? '?')})`;
    for (const id of ['builder-underpaid-not-counted', 'builder-no-builder-not-counted'] as const) ctx.checks.fail(id, why, { last: v?.answer ?? null });
    return notRun(ctx, ['builder-no-builder-flagged', 'builder-terms-back-to-default'], why);
  }
  await judgeFills(ctx);
  const underUsd = sentUnder ? approx(executedValue(ctx, sentUnder) ?? '0') : 0;
  const noneUsd = sentNone ? approx(executedValue(ctx, sentNone) ?? '0') : 0;
  const book = x.sumCounted();
  const honest = approx(book.usd); // every honest order of this step, the close after the cheating orders included
  const delta = v.answer.volume.perpsUsd - before;
  const extra = delta - honest;
  // Exact figures from the stream: half a percent. Estimates at today's price: two percent - still far from one order ($10+).
  const tol = Math.max(0.05, honest * (book.exact ? 0.005 : 0.02));
  const near = (a: number, c: number): boolean => Math.abs(a - c) <= tol;
  const creditedUnder = sentUnder ? near(extra, underUsd) || near(extra, underUsd + noneUsd) : false;
  const creditedNone = sentNone ? near(extra, noneUsd) || near(extra, underUsd + noneUsd) : false;
  const clean = near(extra, 0);
  const flags = v.answer.flags;
  const evidence = {
    perpsVolumeBefore: before,
    perpsVolumeAfter: v.answer.volume.perpsUsd,
    countedByTheRun: Number(honest.toFixed(6)),
    countedFromExactFills: book.exact,
    credited: Number(delta.toFixed(6)),
    unexplained: Number(extra.toFixed(6)),
    underpaidOrder: sentUnder ? { orderID: sentUnder.orderID, usd: underUsd, carried: under, owed } : null,
    noBuilderOrder: sentNone ? { orderID: sentNone.orderID, usd: noneUsd } : null,
    flags,
    verifiedAt: v.answer.volume.verifiedAt,
  };
  const unexplained = !clean && !creditedUnder && !creditedNone ? ` (the server credited $${delta.toFixed(4)}; the run's counted orders since then amount to $${honest.toFixed(4)} - the difference of $${extra.toFixed(4)} matches neither cheating order)` : '';
  void closeFee;

  if (sentUnder) {
    if (creditedUnder) ctx.checks.fail('builder-underpaid-not-counted', `the server CREDITED the under-paying order: perps volume rose by $${delta.toFixed(4)}, the honest orders are $${honest.toFixed(4)}`, evidence);
    else if (!flags.includes('underpaid')) ctx.checks.fail('builder-underpaid-not-counted', `the order with fee ${under} (owed ${owed}) was not credited, but the wallet is NOT flagged "underpaid" (flags: [${flags.join(', ')}])${unexplained}`, evidence);
    else if (!clean) ctx.checks.fail('builder-underpaid-not-counted', `flagged "underpaid", but the credited volume does not add up${unexplained}`, evidence);
    else ctx.checks.pass('builder-underpaid-not-counted', `order ${idText({ orderID: sentUnder.orderID, clOrdID: sentUnder.clOrdID })} ($${underUsd.toFixed(4)}, fee ${under} while ${owed} was owed) was NOT credited: perps volume rose by exactly the honest $${honest.toFixed(4)}; the wallet is flagged "underpaid"`, evidence);
  }
  if (sentNone) {
    if (creditedNone) ctx.checks.fail('builder-no-builder-not-counted', `the server CREDITED the order without a builder: perps volume rose by $${delta.toFixed(4)}, the honest orders are $${honest.toFixed(4)}`, evidence);
    else if (!clean) ctx.checks.fail('builder-no-builder-not-counted', `the credited volume does not add up${unexplained}`, evidence);
    else ctx.checks.pass('builder-no-builder-not-counted', `order ${idText({ orderID: sentNone.orderID, clOrdID: sentNone.clOrdID })} ($${noneUsd.toFixed(4)}, no builder) was NOT credited: perps volume rose by exactly the honest $${honest.toFixed(4)}`, evidence);
    const mark = flags.filter((f) => f === 'no-builder' || f === 'tampered');
    if (mark.length) ctx.checks.pass('builder-no-builder-flagged', `the server flags the wallet: ${mark.join(' and ')} (the order carried the app's "vs-" id and was signed with the app's key)`, { flags });
    else ctx.checks.set('builder-no-builder-flagged', 'not-run', 'server check not available: neither "no-builder" nor "tampered" is among the flags the server returned', { flags });
  } else notRun(ctx, ['builder-no-builder-flagged'], 'the order without a builder was not sent');

  // The policy (default-fee): after an underpaid order the wallet is back on the default fee.
  await scenario(
    ctx,
    'builder-terms-back-to-default',
    async () => {
      if (!sentUnder) {
        ctx.checks.set('builder-terms-back-to-default', 'not-run', 'no under-paying order was sent');
        return;
      }
      const fee = v.answer.fee!;
      if (fee.perps !== x.D.perps || fee.spot !== x.D.spot) {
        ctx.checks.finding('builder-terms-back-to-default', `after the under-paying order the signed terms say ${feeText(fee)}, not the default ${feeText(x.D)} - the server's underpaid policy is not "default-fee" (flags: [${flags.join(', ')}])`, { fee, flags });
        return;
      }
      let carried = 'the app has no terms module: it carries the default anyway';
      if (ctx.appTerms) {
        await ctx.appTerms.refreshTerms(owner);
        const now = x.appFee('perps');
        if (now !== x.D.perps) throw new CheckFailure(`the server signs the default ${x.D.perps} again, but the app would still carry ${String(now)}`, { feeNow: now });
        await x.restingProbe('builder-terms-back-to-default', x.D.perps, 'a resting order after the terms went back to the default');
        carried = `an order placed then carried exactly ${x.D.perps}`;
      }
      ctx.checks.pass('builder-terms-back-to-default', `the signed terms are back at ${feeText(fee)} (the default) with the wallet flagged [${flags.join(', ')}]; ${carried}`, { fee, flags });
    },
    () => putInOrder(ctx, m, 'builder-terms-back-to-default'),
  );
}

/**
 * The approval lowered below the fee owed, then revoked: the app must send
 * NOTHING. Then approved again: orders go out. Run as a build that requires the
 * builder (docs/BUILDER-TIERS.md G1) - when the run's config says optional, the
 * app's config is switched to required for these checks only, and said so.
 */
async function approvalEnforcement(ctx: Ctx, x: { D: FeePair; fresh: () => Promise<Market>; restingProbe: (tag: string, fee: number, what: string) => Promise<void> }): Promise<void> {
  const { owner, rec } = ctx;
  const b = ctx.cfg.builder!;
  const chainId = tradingConfig().chainId;
  const was = tradingConfig().builder;
  const forced = !!was && !was.required;
  const restoreConfig = (): void => {
    if (forced && was) setTradingConfig({ builder: was });
  };
  const listed = (): Promise<{ spot: number | null; perps: number | null }> => readBuilderRates(owner, b.id);
  /** Bring the account back to "approved up to the maximum, trading on" - whatever state a failed scenario left. */
  const reapprove = async (): Promise<void> => {
    const accountId = await sodexAccountId(owner);
    const st = getTradingState();
    if (st.status !== 'enabled' || st.owner !== owner) {
      await registerKey(ctx);
    } else if (!fullyApproved(tradingConfig().builder!, await listed())) {
      await armed(ctx, { expect: [builderApprovalExpect(accountId, b.id, b.maxFee, `approve builder #${b.id} up to ${b.maxFee} again`)], policy: builderApprovalPolicy(accountId, b.id, b.maxFee) }, () =>
        approveBuilderFee({ owner, provider: ctx.provider, confirmBuilderFee: async () => 'approve' as const }),
      );
    }
    await waitFor(ctx, 'the approval on both engines', { timeoutMs: Math.max(settleMs(ctx), 60_000), intervalMs: 5000, probe: () => readBuilderApproval(owner), done: (a) => fullyApproved(tradingConfig().builder!, ratesOf(a)), show: (a) => (a ? JSON.stringify(a.engines) : 'not listed') });
    await refreshBuilderApproval();
    if (ctx.appTerms) await ctx.appTerms.refreshTerms(owner);
  };
  /** What the app does with an order now: refuses it by itself (good), or tries to send it. */
  const attempt = async (m: Market): Promise<{ refused: true; reason: string } | { refused: false; why: string }> => {
    const rb = restingBuy(m, ctx.cfg.orders.perpsLimitOffsetPct);
    const spec: OrderSpec = { market: m, side: 'buy', type: 'limit', tif: 'gtc', price: rb.price, quantity: rb.qty, tag: 'builder-approval-enforced', label: 'an order while the approval does not cover the fee' };
    return refusedLocally(ctx, () => app.placeOrder('perps', ticketOf(spec)));
  };

  let ok = false as boolean;
  await scenario(
    ctx,
    'builder-approval-enforced',
    async () => {
      const accountId = await sodexAccountId(owner);
      if (!accountId) throw new SafetyStop('this wallet has no SoDEX account');
      if (forced && was) {
        setTradingConfig({ builder: { ...was, required: true } });
        rec.note('the run\'s config says the builder is optional: for this check the app is set to REQUIRE it, as a build with a builder does (docs/BUILDER-TIERS.md G1)');
      }
      const owed = Math.min(x.D.perps, ctx.terms ? Math.min(...ctx.terms.allowedFees('perps')) : x.D.perps);
      const lower = Math.max(1, Math.floor(owed / 2));
      if (lower >= owed) {
        ctx.checks.skip('builder-approval-enforced', `the fee owed on perps is ${owed}: there is no approval above 0 and below it`);
        return;
      }
      let m = await x.fresh();

      // (a) the approval lowered below the fee owed - as if on another device.
      await rec.sub(`lower the approval of builder #${b.id} to ${lower} (below the ${owed} owed) - one wallet signature`, () =>
        armed(ctx, { expect: [builderApprovalExpect(accountId, b.id, lower, `lower the approval of builder #${b.id} to ${lower}`)], policy: builderApprovalPolicy(accountId, b.id, lower) }, () =>
          submitBuilderApproval({ owner, provider: ctx.provider, accountId, builderId: b.id, maxFeeRate: lower, nonce: () => nonces().next(nonceKey(owner, chainId)) }),
        ),
      );
      const after = await waitFor(ctx, `SoDEX to list the approval at ${lower}`, { timeoutMs: Math.max(settleMs(ctx), 60_000), intervalMs: 5000, probe: listed, done: (r) => r.perps === lower, show: (r) => (r ? `spot ${r.spot ?? 'none'}, perps ${r.perps ?? 'none'}` : '-') });
      await refreshBuilderApproval(); // what a page load does: the app learns what SoDEX lists
      const a = await attempt(m);
      if (!a.refused) throw new CheckFailure(`with the approval at ${after.perps} (fee owed ${owed}): ${a.why}`, { listed: after });

      // (b) the approval revoked.
      const rv = await rec.sub(`revoke the approval of builder #${b.id} (the app's revokeBuilderApproval) - one wallet signature`, () =>
        armed(ctx, { expect: [builderApprovalExpect(accountId, b.id, 0, `revoke builder #${b.id}`)], policy: builderApprovalPolicy(accountId, b.id, 0) }, () => revokeBuilderApproval({ owner, provider: ctx.provider, builderId: b.id })),
      );
      await waitFor(ctx, 'the approval to leave SoDEX\'s lists', { timeoutMs: Math.max(settleMs(ctx), 60_000), intervalMs: 5000, probe: listed, done: (r) => r.spot === null && r.perps === null, show: (r) => (r ? `spot ${r.spot ?? 'none'}, perps ${r.perps ?? 'none'}` : '-') });
      m = await x.fresh();
      const c = await attempt(m);
      if (!c.refused) throw new CheckFailure(`with the approval revoked: ${c.why}`);
      ok = true;
      ctx.checks.pass(
        'builder-approval-enforced',
        `approval lowered to ${lower} (fee owed ${owed}): the app refused the order itself ("${a.reason}") and sent nothing; approval revoked${rv.tradingTurnedOff ? ' (the app turned trading off)' : ''}: the app refused again ("${c.reason}") and sent nothing`,
        { owed, loweredTo: lower, refusalLowered: a.reason, refusalRevoked: c.reason, tradingTurnedOff: rv.tradingTurnedOff, requiredForcedForThisCheck: forced },
      );
    },
    async () => {
      await reapprove();
    },
  );

  await scenario(
    ctx,
    'builder-reapproved-orders-resume',
    async () => {
      await rec.sub(`approve builder #${b.id} again (and enable trading again if the app turned it off)`, reapprove);
      const fee = (ctx.appTerms ? feeNumber(ctx.appTerms.feeNow('perps', owner)) : null) ?? x.D.perps;
      await x.restingProbe('builder-reapproved-orders-resume', fee, 'a resting order after approving again');
      ctx.checks.pass('builder-reapproved-orders-resume', `approved up to ${b.maxFee} again; an order placed then left with builder #${b.id} at ${fee} and rested${ok ? '' : ' (the enforcement check before it failed)'}`, { fee });
    },
    async () => {
      try {
        await reapprove();
      } catch (e) {
        throw new SafetyStop(`the builder approval could not be restored: ${errText(e)}`);
      }
    },
  );
  restoreConfig();
}
