/**
 * What the executor does when SoDEX says no: read the refusal, and never send
 * the same doomed order again and again from one IP that every follower shares.
 *
 * Every answer of a live copy's or algo's sink passes through here
 * (guardedOrderSink, guardedAlgoSink). A refusal is sorted into a class
 * (classifyRejection) and the class decides:
 *
 *   key           the key was refused (not found, bad signature, expired):
 *                 every copy and algo of that wallet is held, the key is
 *                 checked against SoDEX again, the operator is alerted
 *   margin        not enough margin: that copy opens nothing for a while
 *   limit         SoDEX's position, open-interest or open-order limit
 *   account-rate  SoDEX's order or address quota of that account
 *   size          a size or price SoDEX will not take (minimum notional,
 *                 price band, step): held after 3 within 10 minutes
 *   unknown       anything else: the operator is alerted; held after 5
 *                 within 10 minutes
 *   ip-rate/local the per-IP rate limit (429 / Cloudflare 1015) or the local
 *                 gate refused it (nothing was sent): no hold - the gate's
 *                 cooldown (copy-engine sodex.ts) already holds everyone
 *
 * A HOLD is a copy `blocked` with its reason (it still follows the leader's
 * closes and keeps its stops, reduce-only: runtime.ts READINESS) or an algo
 * `waiting`. It ends by itself; a second hold of the same copy within a day
 * lasts twice as long (at most 2 hours). A filled order clears the strikes.
 * Holds live in memory: after a restart the next refusal holds again.
 *
 * Algos hold themselves on SoDEX's limits (algo/runtime.ts onLimit) and end
 * after 25 refusals in a row, so for an algo only the key and the unknown
 * classes hold here - and an order the local gate refused is tried again once
 * the cooldown allows (it never left, so a new signature is safe) rather than
 * counted as one of the 25.
 */
import type { AlgoRecord, AlgoSink, ChildRequest, ChildResult, MarginChoice, MarketInfo, OrderSink, SendResult, StopOrder, StopRequest, WeightBudget } from '../../../packages/copy-engine/src/index.ts';
import type { BuilderParams } from '../../../packages/sodex-core/src/index.ts';

export type RejectClass = 'key' | 'margin' | 'limit' | 'account-rate' | 'size' | 'gone' | 'unknown' | 'ip-rate' | 'local' | 'post-only' | 'nonce';

/** Sort one refusal text (SoDEX's words, or the local gate's "Not sent: ..."). SoDEX does not document them, so this reads loosely. */
export function classifyRejection(error: string | null | undefined): RejectClass {
  const e = String(error ?? '');
  // A local refusal of any kind - the order rate included - never left: waited out, never a strike (research 2026-11-09).
  if (/^Not sent:/i.test(e)) return 'local';
  // The touch moved under a post-only quote: re-priced on the next step; a market maker sees many (research 2026-11-09).
  if (/post[- _]?only|would (immediately )?(take|cross|match|trade)|immediately (match|execute)|maker only/i.test(e)) return 'post-only';
  // A nonce out of order: nothing executed, the next write is fine.
  if (/nonce/i.test(e)) return 'nonce';
  if (/HTTP 429|error code:?\s*1015/i.test(e)) return 'ip-rate';
  // What the order was for is already gone: a close of a position SoDEX closed meanwhile (its stop, a liquidation:
  // "position not found: 1", the only refusal on ValueDesk's executor on 2026-10-29/30, alerted as unknown) or a cancel
  // of an order that filled or was cancelled. The engines book it themselves (refusedNoPosition, the cancel's next read).
  if (/position not found|no (open )?position|order (not found|never placed)|already (filled|canceled|cancelled|closed)|unknown order/i.test(e)) return 'gone';
  // A margin-mode change on a market where the wallet already holds a position: SoDEX keeps that position's mode and the
  // copy goes on in it (copy-engine runtime.ts ensureLeverage). Nothing for the operator: two "Order refused" alerts on
  // 2026-11-09 04:46 were this, a follower's own BTC position when the copy started.
  if (/cannot (update|change) margin mode|margin mode[^.]*open position/i.test(e)) return 'gone';
  if (/api[\s_-]?key[^.]*(not found|invalid|expired|revoked|unknown)|key not found|unknown api key|no (copy|trading) key|signature (rejected|invalid|mismatch|verification)|invalid signature|unauthori[sz]ed|trading key has expired/i.test(e)) return 'key';
  if (/insufficient|not enough (margin|balance|collateral|funds)|margin (is )?(insufficient|not enough)|available (balance|margin)/i.test(e)) return 'margin';
  if (/open[\s_-]?interest|\boi\b[^.]*\b(cap|limit|exceed)|max(imum)?[\s_-]?position|position[^.]*\b(limit|exceed|too (large|big))|risk[\s_-]?limit|too many (open )?orders|open[\s_-]?orders?[^.]*\b(limit|exceed|max)/i.test(e)) return 'limit';
  if (/rate[\s_-]?limit|too many requests|quota|request limit/i.test(e)) return 'account-rate';
  if (/notional|tick[\s_-]?size|step[\s_-]?size|precision|price[^.]*(band|range|deviat|too (high|low)|limit)|quantity[^.]*(too small|invalid|min)|min(imum)? (qty|quantity|size)|reduce[\s_-]?only|would (increase|not reduce)/i.test(e)) return 'size';
  return 'unknown';
}

/** What the guard tells the service: alert the operator; a copy or algo was held; a wallet's key was refused. */
export interface GuardHost {
  alert(kind: 'order-rejected' | 'sub-held' | 'key-refused', o: { owner: string; ref: string; text: string }): void;
  /** A copy or algo (or, `wallet`, every one of its wallet) is held from now until `until`: re-check readiness now and when it ends. */
  held(target: GuardTarget, reason: string, until: number, wallet: boolean): void;
  /** SoDEX refused the wallet's key: forget the opened key and check the registration again. */
  keyRefused(owner: string): void;
  now?(): number;
}

export interface GuardTarget {
  kind: 'copy' | 'algo';
  id: string;
  owner: string;
}

interface Policy {
  /** Refusals of this class within STRIKE_WINDOW_MS that make a hold. 0: never held for it. */
  strikes: number;
  holdMs: number;
  words: string;
}

const STRIKE_WINDOW_MS = 10 * 60_000;
const MAX_HOLD_MS = 2 * 60 * 60_000;
const ESCALATE_WINDOW_MS = 24 * 60 * 60_000;

const COPY_POLICY: Record<RejectClass, Policy> = {
  key: { strikes: 1, holdMs: 5 * 60_000, words: 'SoDEX refused the copy key' },
  margin: { strikes: 1, holdMs: 10 * 60_000, words: 'SoDEX refused an order for lack of margin' },
  limit: { strikes: 1, holdMs: 15 * 60_000, words: 'SoDEX refused an order at one of its limits (position, open interest or open orders)' },
  'account-rate': { strikes: 1, holdMs: 2 * 60_000, words: "SoDEX refused an order at this account's order rate" },
  size: { strikes: 3, holdMs: 10 * 60_000, words: 'SoDEX refused several orders of this size or price' },
  gone: { strikes: 0, holdMs: 0, words: '' },
  unknown: { strikes: 5, holdMs: 15 * 60_000, words: 'SoDEX refused several orders' },
  'ip-rate': { strikes: 0, holdMs: 0, words: '' },
  local: { strikes: 0, holdMs: 0, words: '' },
  'post-only': { strikes: 0, holdMs: 0, words: '' },
  nonce: { strikes: 0, holdMs: 0, words: '' },
};

/** Algos hold themselves on limits and end after 25 refusals in a row; only these hold here. */
const ALGO_POLICY: Partial<Record<RejectClass, Policy>> = {
  key: COPY_POLICY.key,
  unknown: { strikes: 5, holdMs: 15 * 60_000, words: 'SoDEX refused several orders' },
};

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** A refusal as the operator reads it: one line, no long hex (a signature, a key), at most 200 characters. */
export const refusalText = (e: string | null | undefined): string =>
  String(e ?? '').replace(/0x[0-9a-fA-F]{64,}/g, '0x…').replace(/\s+/g, ' ').trim().slice(0, 200);

export class ErrorGuard {
  /** `copy:<id>`, `algo:<id>` or `owner:<wallet>` -> the hold. */
  private holds = new Map<string, { until: number; reason: string }>();
  /** When each target was last held (for the doubling), and how many times within a day. */
  private history = new Map<string, { at: number; n: number }>();
  private strikes = new Map<string, number[]>();

  constructor(private readonly host: GuardHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  /** Why this copy or algo may not trade now (a hold of its own or of its wallet), or null. */
  holdOf(t: GuardTarget): string | null {
    const now = this.now();
    for (const k of [`${t.kind}:${t.id}`, `owner:${t.owner}`]) {
      const h = this.holds.get(k);
      if (!h) continue;
      if (h.until <= now) {
        this.holds.delete(k);
        continue;
      }
      return h.reason;
    }
    return null;
  }

  /** Every hold running now (for the health view and tests). */
  active(): Array<{ key: string; until: number; reason: string }> {
    const now = this.now();
    return [...this.holds].filter(([, h]) => h.until > now).map(([key, h]) => ({ key, ...h }));
  }

  /** Read the answers of one send. */
  record(t: GuardTarget, results: ReadonlyArray<{ ok: boolean; error: string | null; outcomeUnknown: boolean }>): void {
    if (results.some((r) => r.ok)) this.clearStrikes(t);
    for (const r of results) {
      if (r.ok || r.outcomeUnknown || !r.error) continue;
      this.refused(t, r.error);
    }
  }

  /** A call that threw (leverage, cancel): read its error the same way. */
  recordError(t: GuardTarget, e: unknown): void {
    if (e && typeof e === 'object' && (e as { outcomeUnknown?: boolean }).outcomeUnknown) return;
    this.refused(t, e instanceof Error ? e.message : String(e));
  }

  private clearStrikes(t: GuardTarget): void {
    for (const k of this.strikes.keys()) if (k.startsWith(`${t.kind}:${t.id}|`)) this.strikes.delete(k);
  }

  private refused(t: GuardTarget, error: string): void {
    const cls = classifyRejection(error);
    const text = refusalText(error);
    const ref = `${t.kind}:${t.id}`;
    if (cls === 'unknown') this.host.alert('order-rejected', { owner: t.owner, ref, text: `${t.kind === 'copy' ? 'Copy' : 'Algo'} ${t.id}: SoDEX refused an order for a reason the executor does not know: ${text}` });
    if (cls === 'key') {
      this.host.keyRefused(t.owner);
      this.host.alert('key-refused', { owner: t.owner, ref: `owner:${t.owner}`, text: `SoDEX refused the key of a wallet (${t.kind} ${t.id}): ${text}` });
    }
    const policy = t.kind === 'copy' ? COPY_POLICY[cls] : ALGO_POLICY[cls];
    if (!policy || !policy.strikes) return;
    const now = this.now();
    const sk = `${ref}|${cls}`;
    const list = (this.strikes.get(sk) ?? []).filter((at) => now - at < STRIKE_WINDOW_MS);
    list.push(now);
    this.strikes.set(sk, list);
    if (list.length < policy.strikes) return;
    this.strikes.delete(sk);
    // A key refusal holds the whole wallet: every copy and algo signs with the same key.
    const holdKey = cls === 'key' ? `owner:${t.owner}` : ref;
    if ((this.holds.get(holdKey)?.until ?? 0) > now) return;
    const past = this.history.get(holdKey);
    const n = past && now - past.at < ESCALATE_WINDOW_MS ? past.n + 1 : 1;
    this.history.set(holdKey, { at: now, n });
    if (this.history.size > 20_000) for (const [k, v] of this.history) if (now - v.at >= ESCALATE_WINDOW_MS) this.history.delete(k);
    const ms = Math.min(MAX_HOLD_MS, policy.holdMs * 2 ** (n - 1));
    const until = now + ms;
    const reason = `Held for ${minutes(ms)}: ${policy.words}${text ? ` ("${text.slice(0, 120)}")` : ''}. It goes on by itself; closes and stops still go out.`;
    this.holds.set(holdKey, { until, reason });
    this.host.held(t, reason, until, holdKey.startsWith('owner:'));
    // The operator hears of holds that are not the follower's own matter (margin, size, limits are theirs, in their activity log).
    if (cls === 'unknown' || cls === 'key') this.host.alert('sub-held', { owner: t.owner, ref: holdKey, text: `${t.kind === 'copy' ? 'Copy' : 'Algo'} ${t.id} held for ${minutes(ms)} after repeated refusals (${cls}): ${text}` });
  }
}

/* ------------------------------------------------------------- sinks ----- */

/** A live copy's sink, every answer read by the guard. */
export function guardedOrderSink(inner: OrderSink, guard: ErrorGuard, t: GuardTarget): OrderSink {
  return {
    paper: inner.paper,
    async place(accountId: number, market: MarketInfo, intents, builder: BuilderParams | null, reference: number): Promise<SendResult[]> {
      const out = await inner.place(accountId, market, intents, builder, reference);
      guard.record(t, out);
      return out;
    },
    async setLeverage(accountId: number, market: MarketInfo, leverage: number, margin: MarginChoice): Promise<void> {
      try {
        await inner.setLeverage(accountId, market, leverage, margin);
      } catch (e) {
        guard.recordError(t, e);
        throw e;
      }
    },
    async placeStop(accountId: number, market: MarketInfo, stop: StopOrder, builder: BuilderParams | null): Promise<SendResult> {
      const r = await inner.placeStop(accountId, market, stop, builder);
      guard.record(t, [r]);
      return r;
    },
    async cancel(accountId: number, market: MarketInfo, clOrdID: string): Promise<void> {
      try {
        await inner.cancel(accountId, market, clOrdID);
      } catch (e) {
        guard.recordError(t, e);
        throw e;
      }
    },
  };
}

/** How long an algo's order the local gate refused may wait for the gate in all (then it counts as refused). */
const LOCAL_RETRY_BUDGET_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

/**
 * A live algo's sink, every answer read by the guard. Orders the local gate
 * refused (nothing left the executor) are tried again while the gate allows
 * within LOCAL_RETRY_BUDGET_MS, so a cooldown does not use up an algo's 25
 * refusals in a row.
 */
export function guardedAlgoSink(inner: AlgoSink, guard: ErrorGuard, budget: Pick<WeightBudget, 'cooldownLeft'> | null, retryBudgetMs = LOCAL_RETRY_BUDGET_MS): AlgoSink {
  const target = (a: AlgoRecord): GuardTarget => ({ kind: 'algo', id: a.id, owner: a.owner });
  const local = (rs: ChildResult[]) => rs.length > 0 && rs.every((r) => !r.ok && !r.outcomeUnknown && classifyRejection(r.error) === 'local');
  async function withRetry(go: () => Promise<ChildResult[]>): Promise<ChildResult[]> {
    const t0 = Date.now();
    let out = await go();
    while (local(out) && Date.now() - t0 < retryBudgetMs) {
      const wait = Math.min(retryBudgetMs - (Date.now() - t0), Math.max(500, (budget?.cooldownLeft() ?? 0) + 250 + Math.random() * 750));
      if (wait <= 0) break;
      await sleep(wait);
      out = await go();
    }
    return out;
  }
  return {
    paper: inner.paper,
    async place(a: AlgoRecord, market: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
      const out = await withRetry(() => inner.place(a, market, orders));
      guard.record(target(a), out);
      return out;
    },
    async placeStops(a: AlgoRecord, market: MarketInfo, stops: StopRequest[]): Promise<ChildResult[]> {
      const out = await withRetry(() => inner.placeStops(a, market, stops));
      guard.record(target(a), out);
      return out;
    },
    async cancel(a: AlgoRecord, market: MarketInfo, clOrdIDs: string[]): Promise<void> {
      try {
        await inner.cancel(a, market, clOrdIDs);
      } catch (e) {
        guard.recordError(target(a), e);
        throw e;
      }
    },
    async setLeverage(a: AlgoRecord, market: MarketInfo, leverage: number, margin: MarginChoice): Promise<void> {
      try {
        await inner.setLeverage(a, market, leverage, margin);
      } catch (e) {
        guard.recordError(target(a), e);
        throw e;
      }
    },
  };
}
