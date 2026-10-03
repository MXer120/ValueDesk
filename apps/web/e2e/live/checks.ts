/**
 * The run's record of what was ASSERTED: one entry per assertion, with a stable
 * id, in plain words, with its evidence. The report's `checks` array and the
 * summary are built from this and nothing else.
 *
 *   pass      the assertion held
 *   fail      it did not (the run's exit code is 1)
 *   finding   SoDEX (or the app) did something the owner has to know about and
 *             decide on - not a failure of the run (FOK is refused, a replaced
 *             order drops its builder, ...)
 *   skipped   deliberately not run, with the reason (no builder configured, the
 *             app's ticket does not offer it, no receiver for that chain, ...)
 *   not-run   it should have run and did not (the run stopped before it, its
 *             step was not selected, plan mode)
 *
 * The fixed checks are declared below, so a check that never ran still appears
 * - as `not-run`, with why - instead of silently missing. Per-route checks
 * (one per coin and chain) are declared when the routes are known.
 */
import type { StepId } from './context';

export type CheckStatus = 'pass' | 'fail' | 'finding' | 'skipped' | 'not-run';
export type CheckArea = 'orders-perps' | 'orders-spot' | 'builder' | 'keys' | 'transfers' | 'deposits' | 'withdrawals' | 'refusals' | 'cross-checks';

/** For a check about one coin on one chain: which, and in which direction (the report's per-chain table is built from these). */
export interface CheckRoute {
  coin: string;
  chain: string;
  label: string;
  direction: 'deposit' | 'withdraw';
}

export interface CheckDef {
  id: string;
  area: CheckArea;
  /** What is asserted, in plain words. */
  title: string;
  /** The step that runs it. */
  step: StepId | 'preflight';
  route?: CheckRoute;
}

export interface CheckRecord extends CheckDef {
  status: CheckStatus;
  /** One line: what was seen, or why it did not run. */
  detail: string;
  /** Order ids, tx hashes, expected vs seen. */
  evidence: Record<string, unknown>;
  /** What this assertion cost (fees, gas), USD; null = nothing or not known. */
  costUsd: number | null;
  /** When it was (last) recorded. */
  at: string | null;
}

const def = (area: CheckArea, step: CheckDef['step'], rows: Array<[string, string]>): CheckDef[] => rows.map(([id, title]) => ({ id, area, title, step }));

/** The fixed checks, in the order the summary lists them. */
export const CHECKS: readonly CheckDef[] = [
  // --- the builder fee and its tiers (docs/BUILDER-TIERS.md section 8) ----------------------------
  ...def('builder', 'enable-trading', [['builder-approval', 'The wallet approves the builder fee with ONE signature and SoDEX lists the approval on both engines']]),
  ...def('builder', 'builder-tiers', [
    ['builder-terms-signed', 'The server\'s fee terms for this wallet carry a signature that verifies under the pinned key (address, builder, chain, nonce, validity)'],
    ['builder-terms-tamper-rejected', 'A tampered copy of a real terms answer is rejected by the app, and the default fee is used'],
    ['builder-fee-default', 'First orders carry the default fee; the order records name the builder with it; each fill\'s builderFee is that share of its notional'],
    ['builder-volume-verified', 'Volume above the milestone, verified by the server from SoDEX\'s own records, changes the signed terms'],
    ['builder-fee-lowered', 'The next order carries the lower fee; its fill\'s builderFee is the lower share'],
    ['builder-underpaid-not-counted', 'Cheating attempt: an order sent with a lower fee than owed is not credited, and the wallet is flagged underpaid'],
    ['builder-no-builder-not-counted', 'Cheating attempt: an order sent without the builder is not credited'],
    ['builder-no-builder-flagged', 'The order without the builder, signed with the app\'s own key, is flagged by the server (no-builder / tampered)'],
    ['builder-terms-back-to-default', 'After the underpaid order the signed terms are back on the default fee, and the next order carries it'],
    ['builder-approval-enforced', 'Approval lowered below the fee owed, and revoked: the app sends nothing until it is approved again'],
    ['builder-reapproved-orders-resume', 'After approving again, orders go out with the builder'],
  ]),
  ...def('builder', 'orders-perps', [
    ['builder-modify-keeps-builder', 'A modified order still names the builder'],
    ['builder-replace-keeps-builder', 'A replaced order still names the builder'],
  ]),
  ...def('builder', 'orders-spot', [['builder-spot-buy-not-charged', 'A spot buy names the builder and is charged no builder fee; a spot sell is charged it']]),
  ...def('builder', 'cross-check', [
    ['builder-order-records', "SoDEX's records of the run's orders (open orders, the stream's order updates) name the builder with exactly the fee each order carried"],
    ['builder-income-matches', 'The builder account\'s income equals the builderFee of the run\'s fills'],
  ]),
  ...def('builder', 'revoke-builder', [['builder-revoke', 'The approval is revoked with ONE signature and is gone from both lists']]),

  // --- perps orders ---------------------------------------------------------------------------
  ...def('orders-perps', 'orders-perps', [
    ['perps-leverage-cross', 'Leverage is changed in cross margin and the account state shows it'],
    ['perps-leverage-isolated', 'The market is switched to isolated margin and the account state shows it'],
    ['perps-market-by-quantity', 'Market order by quantity: fills and opens a position of that size'],
    ['perps-market-by-funds', 'Market order by funds'],
    ['perps-margin-add', 'Margin is added to an isolated position'],
    ['perps-margin-remove', 'Margin is removed from an isolated position'],
    ['perps-reduce-only-close', 'Reduce-only market order closes the position, and nothing more'],
    ['perps-limit-rest', 'Limit order (GTC) below the market rests on the book'],
    ['perps-limit-change-price', 'The resting order\'s price is changed'],
    ['perps-limit-change-size', 'The resting order\'s size is changed'],
    ['perps-limit-cancel', 'The resting order is cancelled and leaves the book'],
    ['perps-gtx-rest', 'Post-only (GTX) order below the market rests'],
    ['perps-gtx-cross', 'Post-only (GTX) order that would cross: it must not fill'],
    ['perps-ioc-no-cross', 'IOC order that does not cross: expires without a fill'],
    ['perps-ioc-cross', 'IOC order that crosses: fills at once'],
    ['perps-fok-not-fillable', 'FOK order that cannot fill: nothing fills'],
    ['perps-fok-fillable', 'FOK order that can fill'],
    ['perps-position-stop-loss', 'Stand-alone stop-loss on an open position: listed, stop price changed, cancelled'],
    ['perps-position-take-profit', 'Stand-alone take-profit on an open position: listed, stop price changed, cancelled'],
    ['perps-trigger-observed', 'A take-profit placed at the market triggers and closes the position'],
    ['perps-entry-with-tp-sl', 'Entry with attached take-profit and stop-loss: the entry fills and both exits are listed'],
    ['perps-cancel-all', 'Cancel-all removes several resting orders at once'],
    ['perps-schedule-cancel-clear', 'Dead-man switch: a scheduled cancel that is cleared does not fire'],
    ['perps-schedule-cancel-fires', 'Dead-man switch: SoDEX cancels the resting order at the scheduled time'],
    ['perps-fees-commission', 'Every perps fill pays SoDEX\'s commission at the account\'s own maker or taker rate'],
    ['perps-fees-builder', 'Every perps fill pays the builder fee the order carried (both sides), and none without a builder'],
    ['perps-end-flat', 'The step ends flat, with no open orders, at the leverage and margin mode it started with'],
  ]),

  // --- spot orders ----------------------------------------------------------------------------
  ...def('orders-spot', 'orders-spot', [
    ['spot-limit-rest', 'Limit order (GTC) below the market rests on the book'],
    ['spot-limit-change-price', 'The resting order\'s price is changed'],
    ['spot-limit-change-size', 'The resting order\'s size is changed'],
    ['spot-limit-cancel', 'The resting order is cancelled and its funds are unlocked'],
    ['spot-market-buy-by-funds', 'Market buy by funds (spend this much of the quote coin)'],
    ['spot-market-buy-by-quantity', 'Market buy by quantity'],
    ['spot-market-sell', 'Market sell'],
    ['spot-gtx-rest', 'Post-only (GTX) order below the market rests'],
    ['spot-gtx-cross', 'Post-only (GTX) order that would cross: it must not fill'],
    ['spot-ioc-no-cross', 'IOC order that does not cross: expires without a fill'],
    ['spot-ioc-cross', 'IOC order that crosses: fills at once'],
    ['spot-fok-not-fillable', 'FOK order that cannot fill: nothing fills'],
    ['spot-fok-fillable', 'FOK order that can fill'],
    ['spot-schedule-cancel', 'Dead-man switch on spot: scheduled, then cleared'],
    ['spot-fees-commission', 'Every spot fill pays SoDEX\'s commission at the account\'s own maker or taker rate (buys in the base coin)'],
    ['spot-fees-builder', 'Every spot sell pays the builder fee the order carried; no spot buy pays one'],
    ['spot-end-clean', 'The step ends with no open spot orders and nothing locked'],
  ]),

  // --- the trading key --------------------------------------------------------------------------
  ...def('keys', 'enable-trading', [['key-enable', 'Enabling trading registers a key with ONE wallet signature, and SoDEX lists it on both engines']]),
  ...def('keys', 'key-lifecycle', [
    ['key-restore', 'The key is restored from the device vault (as after a page reload) and still signs'],
    ['key-still-registered', 'The app\'s check says the key is still the one SoDEX holds'],
    ['key-disable-revoke', 'Disabling with revocation removes the key from both engines'],
    ['key-old-key-rejected', 'An order signed with the revoked key is rejected by SoDEX'],
    ['key-reenable', 'Trading can be enabled again (a new key under the same name)'],
  ]),

  // --- transfers between the owner's own accounts -------------------------------------------------
  ...def('transfers', 'transfers', [
    ['transfer-spot-to-perps', 'Spot -> Perps moves exactly the amount'],
    ['transfer-perps-to-spot', 'Perps -> Spot moves exactly the amount'],
  ]),
  ...def('transfers', 'spot-to-evm', [
    ['transfer-spot-to-evm-usdc', 'Spot -> ValueChain wallet (USDC) arrives in the wallet'],
    ['transfer-spot-to-evm-soso', 'Spot -> ValueChain wallet (SOSO) arrives as native SOSO'],
  ]),
  ...def('transfers', 'evm-to-spot', [['transfer-evm-to-spot', 'ValueChain wallet -> Spot (gasless: two signatures, relayed) is credited']]),

  // --- withdrawals on ValueChain ------------------------------------------------------------------
  ...def('withdrawals', 'withdraw-valuechain-self', [['withdraw-valuechain-self', 'Withdrawal to the own ValueChain wallet arrives']]),
  ...def('withdrawals', 'withdraw-valuechain-other', [['withdraw-valuechain-other', 'Withdrawal to another ValueChain address arrives there']]),
  ...def('withdrawals', 'cleanup', [['cleanup-sweep', 'Cleanup: Perps and the ValueChain wallet are emptied into Spot, and all Spot USDC is withdrawn to the deposit chain']]),

  // --- refusals: none of these may move anything ---------------------------------------------------
  ...def('refusals', 'refusals', [
    ['refuse-perps-limit-below-min-notional', 'Perps limit order below the minimum notional: the app refuses it before signing'],
    ['refuse-spot-limit-below-min-notional', 'Spot limit order below the minimum notional: the app refuses it before signing'],
    ['refuse-perps-market-below-min-notional', 'Perps market order below the minimum notional: nothing fills'],
    ['refuse-spot-market-below-min-notional', 'Spot market order below the minimum notional: nothing fills'],
    ['refuse-quantity-rounds-to-zero', 'A quantity below one step: the app refuses it before signing'],
    ['refuse-off-tick-price', 'An off-tick price is snapped to the tick before signing (the order carries the snapped price)'],
    ['refuse-off-step-quantity', 'An off-step quantity is cut down to the step before signing (the order carries the cut quantity)'],
    ['refuse-reduce-only-without-position', 'Reduce-only order with no position: nothing fills, no position opens'],
    ['refuse-trigger-type-not-mark', 'A trigger on the last or the index price (SoDEX takes the mark price only): the app refuses it before signing'],
    ['refuse-spot-trigger', 'A spot order with a trigger or attached exits (the venue has none): the app refuses it before signing'],
    ['refuse-transfer-over-balance', 'Transfers of more than the balance (Spot, Perps, wallet): the app refuses them, nothing is sent'],
    ['refuse-withdraw-over-balance', 'Withdrawal of more than the balance: the app refuses it, nothing is sent'],
    ['refuse-withdraw-below-minimum', 'Withdrawal below the route\'s minimum: the app refuses it, nothing is sent'],
    ['refuse-malformed-receiver', 'Malformed, mistyped and zero receivers are refused for every address format the app offers'],
    ['refuse-unapproved-builder', 'An order naming a builder the wallet has not approved is rejected by SoDEX'],
    ['refuse-builder-fee-above-approval', 'An order naming the approved builder with a fee above the approval is rejected by SoDEX'],
  ]),

  // --- the final reconciliation ---------------------------------------------------------------------
  ...def('cross-checks', 'cross-check', [
    ['cross-orders-perps', 'SoDEX\'s perps order history holds every order the run sent, as the run recorded it'],
    ['cross-orders-spot', 'SoDEX\'s spot order history holds every order the run sent, as the run recorded it'],
    ['cross-fills-perps', 'SoDEX\'s perps fills are exactly the fills the run recorded, with the same fees'],
    ['cross-fills-spot', 'SoDEX\'s spot fills are exactly the fills the run recorded, with the same fees'],
    ['cross-stream-vs-rest', 'The account stream reported every fill that the fill history lists'],
    ['cross-end-state', 'At the end: no open orders, no position, nothing in flight'],
  ]),
];

/** A stable id from words ("USDC", "ARBITRUM_ETH" -> "usdc-arbitrum_eth"). */
export const idPart = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9_.]+/g, '-').replace(/^-+|-+$/g, '');

export const withdrawCheckId = (coin: string, chain: string): string => `withdraw-${idPart(coin)}-${idPart(chain)}`;
export const depositCheckId = (coin: string, chain: string): string => `deposit-${idPart(coin)}-${idPart(chain)}`;
export const routeCheckId = (coin: string, chain: string): string => `route-${idPart(coin)}-${idPart(chain)}`;
export const manualDepositCheckId = (coin: string, chain: string): string => `manual-deposit-${idPart(coin)}-${idPart(chain)}`;

export interface CheckCounts {
  pass: number;
  fail: number;
  finding: number;
  skipped: number;
  'not-run': number;
}

export class Checks {
  private readonly defs = new Map<string, CheckDef>();
  private readonly recs = new Map<string, CheckRecord>();
  /** Called for every recorded assertion (the console line). */
  onRecord: ((r: CheckRecord) => void) | null = null;

  constructor(defs: readonly CheckDef[] = CHECKS) {
    for (const d of defs) this.defs.set(d.id, d);
  }

  /** Declare a check that is only known at run time (one per coin and chain). Declaring twice keeps the first. */
  declare(d: CheckDef): void {
    if (!this.defs.has(d.id)) this.defs.set(d.id, d);
  }

  /**
   * Declare a run-time check under an id nothing else uses: `base`, or `base-2`,
   * `base-3` ... when two steps test the same coin on the same chain. Returns the id.
   */
  declareUnique(d: CheckDef): string {
    let id = d.id;
    for (let n = 2; this.defs.has(id); n++) id = `${d.id}-${n}`;
    this.defs.set(id, { ...d, id });
    return id;
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }
  /** Every declared check, in declaration order. */
  definitions(): CheckDef[] {
    return [...this.defs.values()];
  }
  get(id: string): CheckRecord | undefined {
    return this.recs.get(id);
  }
  statusOf(id: string): CheckStatus | null {
    return this.recs.get(id)?.status ?? null;
  }

  /** Record (or replace) the verdict of one check. An unknown id is a bug in the runner, never ignored. */
  set(id: string, status: CheckStatus, detail: string, evidence: Record<string, unknown> = {}, costUsd: number | null = null): CheckRecord {
    const d = this.defs.get(id);
    if (!d) throw new Error(`check "${id}" is not declared (checks.ts)`);
    const prev = this.recs.get(id);
    const r: CheckRecord = {
      ...d,
      status,
      detail,
      evidence: { ...(prev?.evidence ?? {}), ...evidence },
      costUsd: costUsd ?? prev?.costUsd ?? null,
      at: new Date().toISOString(),
    };
    this.recs.set(id, r);
    try {
      this.onRecord?.(r);
    } catch {
      /* a listener must not break the record */
    }
    return r;
  }
  pass(id: string, detail: string, evidence?: Record<string, unknown>, costUsd?: number | null): CheckRecord {
    return this.set(id, 'pass', detail, evidence, costUsd ?? null);
  }
  fail(id: string, detail: string, evidence?: Record<string, unknown>, costUsd?: number | null): CheckRecord {
    return this.set(id, 'fail', detail, evidence, costUsd ?? null);
  }
  finding(id: string, detail: string, evidence?: Record<string, unknown>, costUsd?: number | null): CheckRecord {
    return this.set(id, 'finding', detail, evidence, costUsd ?? null);
  }
  skip(id: string, detail: string, evidence?: Record<string, unknown>): CheckRecord {
    return this.set(id, 'skipped', detail, evidence, null);
  }
  /** Add to what a check cost (several fills under one assertion). */
  addCost(id: string, usd: number): void {
    const r = this.recs.get(id);
    if (r && Number.isFinite(usd)) r.costUsd = (r.costUsd ?? 0) + usd;
  }

  /**
   * Every declared check, recorded or not. `why(def)` says why an unrecorded one
   * did not run (its step was not selected, the run stopped before it, plan mode).
   */
  all(why: (d: CheckDef) => { status: 'skipped' | 'not-run'; detail: string }): CheckRecord[] {
    const out: CheckRecord[] = [];
    for (const d of this.defs.values()) {
      const r = this.recs.get(d.id);
      if (r) out.push(r);
      else {
        const w = why(d);
        out.push({ ...d, status: w.status, detail: w.detail, evidence: {}, costUsd: null, at: null });
      }
    }
    return out;
  }

  recorded(): CheckRecord[] {
    return [...this.recs.values()];
  }
  failed(): CheckRecord[] {
    return this.recorded().filter((r) => r.status === 'fail');
  }
}

export function countChecks(list: readonly CheckRecord[]): CheckCounts {
  const c: CheckCounts = { pass: 0, fail: 0, finding: 0, skipped: 0, 'not-run': 0 };
  for (const r of list) c[r.status] += 1;
  return c;
}

export const STATUS_WORD: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', finding: 'FINDING', skipped: 'skipped', 'not-run': 'not run' };
