/**
 * SoDEX, as the copier talks to it: public reads, and signed writes it never
 * retries.
 *
 * READS go through one weight budget per client (SoDEX allows 1,200 weight a
 * minute per IP; reads use at most 75% of it, see WeightBudget) and are
 * retried on a transient failure - never on a 429, which opens a cooldown for
 * every caller. WRITES are sent once, closes and stops before openings when
 * the budget is tight, and only the actions in ALLOWED_WRITES. A write that got no answer, or an
 * answer that cannot be read, may still have executed: it raises
 * `OutcomeUnknownError` and the caller re-reads instead of sending again (the
 * nonce makes a resend of the SAME bytes harmless, a new signature would not).
 */
import {
  GATEWAY_ORIGIN,
  SodexApiError,
  approvedBuilderRates,
  isTransientFailure,
  parseEnvelope,
  weightFor,
  type BuiltRequest,
  type Network,
} from '../../sodex-core/src/index.ts';
import { abortController, sleep, timers, type FetchLike, type ResponseLike } from './io.ts';
import { parseMarkets } from './markets.ts';
import type { FollowerSnapshot, LeaderRead, MarginChoice, MarketInfo } from './types.ts';

export class OutcomeUnknownError extends Error {
  override name = 'OutcomeUnknownError';
  readonly outcomeUnknown = true;
}

/**
 * Refused here, before anything was signed onto the wire: the local rate gate
 * (an opening order while SoDEX's rate limit cools down or the budget is
 * nearly spent, an account over its order rate) or a signed action this
 * client never sends. Nothing reached SoDEX, so nothing can have executed.
 */
export class LocalRefusal extends SodexApiError {
  override name = 'LocalRefusal';
  readonly local = true;
  constructor(message: string, path = '', readonly reason: 'rate' | 'account-rate' | 'not-allowed' = 'rate') {
    super(reason === 'not-allowed' ? 403 : 429, `Not sent: ${message}`, reason === 'not-allowed' ? 403 : 429, path);
  }
}

/**
 * Which signed writes leave first when the budget is tight: what protects a
 * position (a cancel, a reduce-only close, a stop) before what adds risk (an
 * opening order, a leverage change for one).
 */
export type WritePriority = 'protect' | 'open';

/** What the gate tells its host (the executor alerts on it). */
export type GateEvent = { kind: 'rate-limited'; ms: number; path: string; retryAfterMs: number | null } | { kind: 'rate-cleared' };

/** Cooldown after SoDEX's (Cloudflare's) 429 / error 1015: 15 s, doubling to 5 min while they keep coming. */
export const COOL_BASE_MS = 15_000;
export const COOL_MAX_MS = 5 * 60_000;
/** A read never queues into a cooldown longer than this: it fails at once (the caller retries on its next tick). */
const COOL_WAIT_MAX_MS = 20_000;
/** During a cooldown, protective writes still go out, spaced this far apart (one probe at a time, not a burst into the ban). */
const PROTECT_SPACING_MS = 1_000;

/** ±20 % jitter, so many waiters do not wake in the same millisecond. */
const jitter = (ms: number, rnd: () => number = Math.random): number => Math.round(ms * (0.8 + 0.4 * rnd()));

/**
 * The per-IP REST budget every caller of one client shares (copies, algos,
 * key checks), and SoDEX's rate-limit cooldown.
 *
 * SoDEX allows 1,200 weight a minute per IP. Every follower's request leaves
 * the executor from one address, so this is the budget of all of them:
 *   - reads wait until they fit under `readShare` (default 75 %);
 *   - an opening write goes only while the minute stays under `openShare`
 *     (92 %) and no cooldown runs - otherwise it is refused (LocalRefusal),
 *     never queued: a copied order that leaves a minute late is a different
 *     trade;
 *   - a protective write (cancel, reduce-only, stop) always goes, up to and
 *     past the line - one per PROTECT_SPACING_MS while a cooldown runs.
 * A 429 (or Cloudflare's "error code: 1015") opens a cooldown: Retry-After
 * when SoDEX sends one, else 15 s doubling to 5 min, with jitter; the next
 * answer that is not a 429 ends it. Replaying into a ban is what keeps it on.
 */
export class WeightBudget {
  private spent: Array<{ at: number; w: number }> = [];
  private coolUntil = 0;
  private coolMs = 0;
  private lastProtectAt = 0;
  /** Told when a cooldown opens or ends. */
  onEvent: ((e: GateEvent) => void) | null = null;
  constructor(
    readonly perMinute = 1200,
    readonly readShare = 0.75,
    readonly openShare = 0.92,
  ) {}

  used(now = Date.now()): number {
    while (this.spent.length && now - this.spent[0]!.at >= 60_000) this.spent.shift();
    return this.spent.reduce((a, b) => a + b.w, 0);
  }

  /** Book `w` now. */
  charge(w: number, now = Date.now()): void {
    this.spent.push({ at: now, w });
  }

  /** ms until SoDEX's rate limit has cooled down (0: not limited). */
  cooldownLeft(now = Date.now()): number {
    return Math.max(0, this.coolUntil - now);
  }

  /**
   * SoDEX answered 429 to a request sent at `sentAt`: open (or lengthen) the
   * cooldown. Retry-After wins when it is longer. Requests that were already on
   * their way when the cooldown opened all get the same 429; they do not double
   * it again - only one sent after it (into the ban) does.
   */
  penalise(path: string, retryAfterMs: number | null, now = Date.now(), rnd: () => number = Math.random, sentAt = now): number {
    if (this.coolUntil > now && sentAt <= this.penalisedAt) {
      if (retryAfterMs !== null && now + retryAfterMs > this.coolUntil) this.coolUntil = now + Math.min(retryAfterMs, 10 * 60_000);
      return this.coolUntil - now;
    }
    this.coolMs = Math.min(COOL_MAX_MS, this.coolMs ? this.coolMs * 2 : COOL_BASE_MS);
    const ms = Math.min(10 * 60_000, Math.max(jitter(this.coolMs, rnd), retryAfterMs ?? 0));
    const was = this.coolUntil > now;
    this.penalisedAt = now;
    this.coolUntil = Math.max(this.coolUntil, now + ms);
    if (!was) this.onEvent?.({ kind: 'rate-limited', ms, path, retryAfterMs });
    return ms;
  }

  private penalisedAt = 0;

  /** When the last 429 came (0: never). */
  get lastPenaltyAt(): number {
    return this.penalisedAt;
  }

  /**
   * An answer that was not a 429 to a request sent at `sentAt`: the limit is
   * lifted - unless the request left before the last 429 (a slow answer to an
   * old request says nothing about the ban) and the cooldown still runs.
   */
  cleared(sentAt = Date.now(), now = Date.now()): void {
    if (!this.coolMs && !this.coolUntil) return;
    if (this.coolUntil > now && sentAt <= this.penalisedAt) return;
    const was = this.coolMs > 0;
    this.coolMs = 0;
    this.coolUntil = 0;
    if (was) this.onEvent?.({ kind: 'rate-cleared' });
  }

  /** Wait until a read of weight `w` fits under the read share and no cooldown runs, then book it. */
  async take(w: number): Promise<void> {
    for (let i = 0; i < 120; i++) {
      const now = Date.now();
      const cool = this.cooldownLeft(now);
      if (cool > COOL_WAIT_MAX_MS) throw new LocalRefusal(`SoDEX's rate limit is cooling down (${Math.ceil(cool / 1000)} s left)`);
      if (cool > 0) {
        await sleep(jitter(cool));
        continue;
      }
      if (this.used(now) + w <= this.perMinute * this.readShare) {
        this.charge(w, now);
        return;
      }
      const oldest = this.spent[0];
      await sleep(jitter(oldest ? Math.max(50, 60_000 - (now - oldest.at) + 5) : 250));
    }
    throw new LocalRefusal('the read budget is exhausted');
  }

  /**
   * Admit a signed write of weight `w` now, or say why not. Protective writes
   * are never refused; they are only spaced while a cooldown runs.
   */
  async admitWrite(w: number, priority: WritePriority, path = ''): Promise<void> {
    let now = Date.now();
    if (priority === 'open') {
      const cool = this.cooldownLeft(now);
      if (cool > 0) throw new LocalRefusal(`SoDEX's rate limit is cooling down (${Math.ceil(cool / 1000)} s left); opening orders wait for it`, path);
      if (this.used(now) + w > this.perMinute * this.openShare) throw new LocalRefusal('the per-IP request budget is nearly spent; closes and stops go first', path);
    } else if (this.cooldownLeft(now) > 0) {
      const wait = this.lastProtectAt + PROTECT_SPACING_MS - now;
      if (wait > 0) {
        this.lastProtectAt += PROTECT_SPACING_MS;
        await sleep(Math.min(wait, 10 * PROTECT_SPACING_MS));
        now = Date.now();
      } else this.lastProtectAt = now;
    }
    this.charge(w, now);
  }
}

/**
 * SoDEX's order rate per account (API key): 20 orders a second and 600 a
 * minute. Opening orders stop at `share` of either (90 %), so the rest stays
 * for closes and stops, which may use all of it (and wait for the next second
 * rather than be refused for the per-second one). Batches count every order.
 */
export class AccountRate {
  private hits = new Map<number, Array<{ at: number; n: number }>>();
  constructor(
    readonly perSecond = 20,
    readonly perMinute = 600,
    readonly share = 0.9,
  ) {}

  private window(id: number, now: number): Array<{ at: number; n: number }> {
    let h = this.hits.get(id);
    if (!h) this.hits.set(id, (h = []));
    while (h.length && now - h[0]!.at >= 60_000) h.shift();
    return h;
  }

  counts(id: number, now = Date.now()): { second: number; minute: number } {
    const h = this.window(id, now);
    let second = 0;
    let minute = 0;
    for (const x of h) {
      minute += x.n;
      if (now - x.at < 1_000) second += x.n;
    }
    return { second, minute };
  }

  async admit(id: number, n: number, priority: WritePriority, path = ''): Promise<void> {
    if (!(id > 0) || !(n > 0)) return;
    let now = Date.now();
    let c = this.counts(id, now);
    if (priority === 'open') {
      if (c.second + n > this.perSecond * this.share) throw new LocalRefusal(`account ${id} is at SoDEX's order rate (${this.perSecond} a second)`, path, 'account-rate');
      if (c.minute + n > this.perMinute * this.share) throw new LocalRefusal(`account ${id} is at SoDEX's order rate (${this.perMinute} a minute)`, path, 'account-rate');
    } else if (c.second + n > this.perSecond) {
      await sleep(1_000);
      now = Date.now();
      c = this.counts(id, now);
    }
    this.book(id, n, now);
  }

  /** ms until `n` more orders of account `id` fit under `share` of both windows (0: now). */
  waitMs(id: number, n: number, share = 1, now = Date.now()): number {
    if (!(id > 0) || !(n > 0)) return 0;
    const h = this.window(id, now);
    const c = this.counts(id, now);
    let wait = 0;
    if (c.second + n > this.perSecond * share) {
      const inSecond = h.filter((x) => now - x.at < 1_000);
      wait = Math.max(wait, inSecond.length ? 1_000 - (now - inSecond[0]!.at) + 1 : 1);
    }
    if (c.minute + n > this.perMinute * share) wait = Math.max(wait, h.length ? 60_000 - (now - h[0]!.at) + 1 : 1);
    return wait;
  }

  /** Count `n` orders of account `id` sent now. */
  book(id: number, n: number, now = Date.now()): void {
    if (!(id > 0) || !(n > 0)) return;
    this.window(id, now).push({ at: now, n });
    // Bounded: accounts idle for a minute are forgotten.
    if (this.hits.size > 5_000) for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1]!.at >= 60_000) this.hits.delete(k);
  }
}

/** SoDEX (or Cloudflare) answered 429 to a signed write: it was not executed, and the same bytes may be sent again. */
export class IpRateLimitedError extends SodexApiError {
  override name = 'IpRateLimitedError';
  constructor(path: string) {
    super(429, 'SoDEX rate limit (HTTP 429) - not executed; backing off', 429, path);
  }
}

/**
 * The classes of a signed write, in the order they leave: a cancel, then what
 * protects a position (a stop, a take-profit, a reduce-only close), then a
 * leverage change, then an opening order.
 */
export const SEND_CLASSES = ['cancel', 'protect', 'leverage', 'open'] as const;
export type SendClass = (typeof SEND_CLASSES)[number];

export function sendClass(method: string, path: string, priority: WritePriority): SendClass {
  if (method === 'DELETE') return 'cancel';
  if (/\/leverage$/.test(path)) return 'leverage';
  return priority === 'protect' ? 'protect' : 'open';
}

/** What the queue holds now: for the health check and the alert. */
export interface QueueStats {
  waiting: number;
  byClass: Record<SendClass, number>;
  /** Age of the oldest waiting item (ms; 0: none). */
  oldestMs: number;
  inFlight: number;
  cooldownMs: number;
  /** Writes sent from the queue, and 429s it sent again, since start. */
  sent: number;
  resent: number;
}

export type QueueEvent = { kind: 'queue-slow'; waiting: number; oldestMs: number; byClass: Record<SendClass, number> };

/** A protective item waiting longer than this is reported (QueueEvent), at most once a minute. */
export const QUEUE_SLOW_MS = 10_000;
/** Above this many waiting items a leverage change is refused (protective items never are). */
export const QUEUE_CAP = 1_000;
/** While a cooldown runs, one waiting item is sent at most this often, to learn whether the ban is over. */
const PROBE_MS = 2_000;
/** The pump looks again at least this often while anything waits (ages, budget windows). */
const PUMP_MAX_WAIT_MS = 1_000;

interface QueueItem {
  seq: number;
  cls: SendClass;
  accountId: number;
  orders: number;
  weight: number;
  at: number;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/**
 * THE SEND QUEUE of one client (one IP): every signed write of every copy and
 * algo on this executor passes it.
 *
 *   - Cancels, protective orders and leverage changes WAIT here: never dropped,
 *     never refused for the rate (a leverage change only above QUEUE_CAP). They
 *     leave in class order across accounts as fast as the per-IP minute (all of
 *     it) and each account's order rate (all of it) allow. One account's writes
 *     leave strictly in the order they came, one at a time (each after the
 *     answer to the one before): a cancel and its replacement never swap, and
 *     the key's nonces stay in order.
 *   - A 429 (or Cloudflare 1015) means not executed: the item goes back to the
 *     head of its account's line and is sent again, the same bytes, once the
 *     cooldown allows - with no deadline. During a cooldown one item is sent
 *     every PROBE_MS to learn whether it is over; the first answer that is not
 *     a 429 lifts it and the rest follows at full speed. Any other answer (a
 *     refusal, no answer) goes back to the caller: never sent twice.
 *   - An opening order is NEVER queued (one sent late is a different trade):
 *     it leaves at once when nothing waits, no cooldown runs, the minute is
 *     under the open share and the account under its share of the order rate;
 *     otherwise it is refused at once (LocalRefusal), and nothing was sent.
 *
 * In memory only. After a restart nothing is replayed: whoever was waiting is
 * gone too, and the runtimes read what SoDEX holds instead (the copy runtime
 * re-reads followers and reconciles every copy and its stops on start; the
 * algo runtime settles each algo's children against SoDEX) - an order that
 * never left is simply planned again from the state SoDEX reports.
 */
export class SendQueue {
  private items: QueueItem[] = [];
  private busy = new Set<number>();
  private seq = 0;
  private timer: unknown = null;
  private lastProbeAt = 0;
  private probing = false;
  private lastSlowAt = 0;
  private sentN = 0;
  private resentN = 0;
  onEvent: ((e: QueueEvent) => void) | null = null;

  constructor(
    private readonly budget: WeightBudget,
    private readonly rate: AccountRate,
  ) {}

  stats(now = Date.now()): QueueStats {
    const byClass = { cancel: 0, protect: 0, leverage: 0, open: 0 } as Record<SendClass, number>;
    let oldest = now;
    for (const it of this.items) {
      byClass[it.cls]++;
      oldest = Math.min(oldest, it.at);
    }
    return { waiting: this.items.length, byClass, oldestMs: this.items.length ? now - oldest : 0, inFlight: this.busy.size, cooldownMs: this.budget.cooldownLeft(now), sent: this.sentN, resent: this.resentN };
  }

  /** Send `run` (one signed write) under the queue's rules. */
  submit<T>(cls: SendClass, accountId: number, orders: number, run: () => Promise<T>, path = ''): Promise<T> {
    const weight = 1 + Math.floor(orders / 40);
    const now = Date.now();
    if (cls === 'open') {
      const why = this.items.length
        ? 'closes and stops go first'
        : this.budget.cooldownLeft(now) > 0
          ? `it is cooling down (${Math.ceil(this.budget.cooldownLeft(now) / 1000)} s left); closes and stops go first`
          : this.budget.used(now) + weight > this.budget.perMinute * this.budget.openShare
            ? 'the per-IP budget is nearly spent; closes and stops go first'
            : null;
      if (why) return Promise.reject(new LocalRefusal(`SoDEX's rate limit is reached; ${why}`, path));
      if (this.rate.waitMs(accountId, orders, this.rate.share, now) > 0) {
        return Promise.reject(new LocalRefusal(`account ${accountId} is at SoDEX's order rate; closes and stops go first`, path, 'account-rate'));
      }
      this.budget.charge(weight, now);
      this.rate.book(accountId, orders, now);
      this.sentN++;
      return run();
    }
    if (cls === 'leverage' && this.items.length >= QUEUE_CAP) return Promise.reject(new LocalRefusal(`the send queue is full (${this.items.length} waiting); closes and stops go first`, path));
    return new Promise<T>((resolve, reject) => {
      this.items.push({ seq: ++this.seq, cls, accountId, orders, weight, at: now, run, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  /** The next item that may leave: per account only its oldest, and only when that account has nothing in flight; then class, then age. */
  private candidates(): QueueItem[] {
    const heads = new Map<number, QueueItem>();
    for (const it of this.items) if (!heads.has(it.accountId)) heads.set(it.accountId, it);
    return [...heads.values()]
      .filter((it) => !this.busy.has(it.accountId))
      .sort((a, b) => SEND_CLASSES.indexOf(a.cls) - SEND_CLASSES.indexOf(b.cls) || a.seq - b.seq);
  }

  private schedule(ms: number): void {
    timers.cancel(this.timer);
    this.timer = timers.after(Math.max(1, Math.min(ms, PUMP_MAX_WAIT_MS)), () => {
      this.timer = null;
      this.pump();
    });
  }

  private pump(): void {
    timers.cancel(this.timer);
    this.timer = null;
    let wait = Infinity;
    for (;;) {
      const now = Date.now();
      const next = this.candidates();
      if (!next.length) break;
      const cool = this.budget.cooldownLeft(now);
      if (cool > 0) {
        // Into a ban: one probe at a time, every PROBE_MS (counted from the 429 too).
        const since = now - Math.max(this.lastProbeAt, this.budget.lastPenaltyAt);
        if (this.probing || since < PROBE_MS) {
          wait = Math.min(wait, this.probing ? PUMP_MAX_WAIT_MS : PROBE_MS - since);
          break;
        }
        this.lastProbeAt = now;
        this.probing = true;
        this.dispatch(next[0]!, now, true);
        break;
      }
      const room = this.budget.perMinute - this.budget.used(now);
      let sent = false;
      for (const it of next) {
        if (it.weight > room) {
          wait = Math.min(wait, 250);
          break; // the minute is full: nothing of a lower class jumps ahead
        }
        const w = this.rate.waitMs(it.accountId, it.orders, 1, now);
        if (w > 0) {
          wait = Math.min(wait, w);
          continue; // this account waits for its own order rate; others go on
        }
        this.dispatch(it, now, false);
        sent = true;
        break;
      }
      if (!sent) break;
    }
    this.watch();
    if (this.items.length) this.schedule(Number.isFinite(wait) ? wait : PUMP_MAX_WAIT_MS);
  }

  private dispatch(it: QueueItem, now: number, probe: boolean): void {
    this.items.splice(this.items.indexOf(it), 1);
    this.busy.add(it.accountId);
    this.budget.charge(it.weight, now);
    this.rate.book(it.accountId, it.orders, now);
    this.sentN++;
    void it
      .run()
      .then(
        (v) => it.resolve(v),
        (e) => {
          if (e instanceof IpRateLimitedError) {
            // Not executed: back to the head of its account's line, the same bytes, no deadline.
            this.resentN++;
            this.items.push(it);
            this.items.sort((a, b) => a.seq - b.seq);
          } else it.reject(e);
        },
      )
      .finally(() => {
        this.busy.delete(it.accountId);
        if (probe) this.probing = false;
        this.pump();
      });
  }

  private watch(now = Date.now()): void {
    if (!this.items.length || now - this.lastSlowAt < 60_000) return;
    const s = this.stats(now);
    if (s.oldestMs >= QUEUE_SLOW_MS || s.waiting >= QUEUE_CAP) {
      this.lastSlowAt = now;
      this.onEvent?.({ kind: 'queue-slow', waiting: s.waiting, oldestMs: s.oldestMs, byClass: s.byClass });
    }
  }
}

/**
 * The signed writes a copier sends: perps orders (new, cancel) and leverage.
 * Nothing else is ever sent with a follower's key - not a transfer, not a
 * withdrawal, not a key revocation - whatever a caller asks: SoDEX cannot make
 * a key that trades but cannot withdraw (sodex-core permissions.ts), so this
 * list is the line.
 */
export const ALLOWED_WRITES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/v1/perps/trade/orders' },
  { method: 'DELETE', path: '/api/v1/perps/trade/orders' },
  { method: 'POST', path: '/api/v1/perps/trade/leverage' },
];

/** What a signed write is, read from its body: its account, how many orders, and whether it only protects. */
export function writeShape(method: string, path: string, body: string | undefined): { accountId: number; orders: number; priority: WritePriority } {
  let p: { accountID?: unknown; orders?: unknown; cancels?: unknown } = {};
  try {
    p = body ? (JSON.parse(body) as typeof p) : {};
  } catch {
    p = {};
  }
  const accountId = Number(p.accountID) || 0;
  if (method === 'DELETE') return { accountId, orders: Array.isArray(p.cancels) ? p.cancels.length : 1, priority: 'protect' };
  if (Array.isArray(p.orders)) {
    const all = p.orders as Array<{ reduceOnly?: unknown }>;
    return { accountId, orders: all.length, priority: all.length > 0 && all.every((o) => o && o.reduceOnly === true) ? 'protect' : 'open' };
  }
  return { accountId, orders: 1, priority: 'open' };
}

/** A Retry-After header, in ms (seconds or an HTTP date); null when absent or unreadable. */
export function retryAfterMs(v: string | null | undefined, now = Date.now()): number | null {
  if (!v) return null;
  const s = Number(v.trim());
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 3_600_000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.min(t - now, 3_600_000)) : null;
}

/** HTTP 429 from SoDEX's gateway or Cloudflare (1015): the IP is rate limited. */
export function isIpRateLimited(status: number, text: string): boolean {
  return status === 429 || /error code:\s*1015/i.test(text);
}

/** How SoDEX's REST has answered lately: for the health check and the "unreachable" alert. */
export interface SodexReach {
  lastOkAt: number;
  lastFailAt: number;
  /** When the current run of failures began (0: the last answer was fine). */
  failingSince: number;
  lastError: string | null;
}

export interface SodexClientOptions {
  network: Network;
  /** REST origin; default SoDEX's gateway for the network. */
  gateway?: string;
  fetch: FetchLike;
  budget?: WeightBudget;
  /** Per-account order rate (default: SoDEX's 20/s, 600/min). */
  accountRate?: AccountRate;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

interface ApiKeyRow {
  name: string;
  publicKey: string;
  expiresAt: number;
  permissions?: number;
}

export class SodexClient {
  readonly network: Network;
  readonly gateway: string;
  readonly budget: WeightBudget;
  readonly accountRate: AccountRate;
  /** Every signed write leaves through it (SendQueue). */
  readonly queue: SendQueue;
  /** How SoDEX's REST has answered lately (reachability, for the health check and alerts). */
  readonly reach: SodexReach = { lastOkAt: 0, lastFailAt: 0, failingSince: 0, lastError: null };
  private readonly fetch: FetchLike;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;

  constructor(o: SodexClientOptions) {
    this.network = o.network;
    this.gateway = (o.gateway ?? GATEWAY_ORIGIN[o.network]).replace(/\/+$/, '');
    this.fetch = o.fetch;
    this.budget = o.budget ?? new WeightBudget();
    this.accountRate = o.accountRate ?? new AccountRate();
    this.queue = new SendQueue(this.budget, this.accountRate);
    this.readTimeoutMs = o.readTimeoutMs ?? 10_000;
    this.writeTimeoutMs = o.writeTimeoutMs ?? 15_000;
  }

  /** An answer arrived (any HTTP status below 500): SoDEX is reachable. */
  private reached(): void {
    this.reach.lastOkAt = Date.now();
    this.reach.failingSince = 0;
  }

  private unreached(e: unknown): void {
    const now = Date.now();
    this.reach.lastFailAt = now;
    this.reach.lastError = String(e instanceof Error ? e.message : e).slice(0, 200);
    if (!this.reach.failingSince) this.reach.failingSince = now;
  }

  /**
   * One HTTP answer, read: a 429 opens the cooldown (and is never retried by
   * the caller); anything else below 500 proves SoDEX is there and lifts it.
   */
  private observe(res: ResponseLike, text: string, path: string, sentAt: number): void {
    if (isIpRateLimited(res.status, text)) {
      this.reached();
      this.budget.penalise(path, retryAfterMs(res.headers?.get('retry-after')), Date.now(), Math.random, sentAt);
      return;
    }
    if (res.status >= 500) {
      this.unreached(`HTTP ${res.status}`);
      return;
    }
    this.reached();
    this.budget.cleared(sentAt);
  }

  /** An unsigned GET, budgeted and retried on transient failures (never on a 429: that waits out the cooldown). */
  async get<T>(path: string, weight = weightFor(path), attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      await this.budget.take(weight);
      const ctl = abortController();
      const timer = timers.after(this.readTimeoutMs, () => ctl.abort());
      const sentAt = Date.now();
      try {
        let res: ResponseLike;
        try {
          res = await this.fetch(this.gateway + path, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctl.signal });
        } catch (e) {
          this.unreached(e);
          throw e;
        }
        const text = await res.text();
        this.observe(res, text, path, sentAt);
        if (isIpRateLimited(res.status, text)) throw new SodexApiError(429, 'SoDEX rate limit (HTTP 429) - backing off', 429, path);
        return parseEnvelope<T>(res.status, text, path);
      } catch (e) {
        last = e;
        const limited = e instanceof SodexApiError && (e.httpStatus === 429 || e.code === 429);
        if (i >= attempts || limited || !isTransientFailure(e)) throw e;
        await sleep(jitter(300 * 2 ** (i - 1)));
      } finally {
        timers.cancel(timer);
      }
    }
    throw last;
  }

  /**
   * Send one signed request through the queue (SendQueue): only ALLOWED_WRITES
   * leave; cancels, stops, closes and leverage wait their turn (and are sent
   * again after a 429, which was not executed); an opening order leaves at once
   * or is refused (LocalRefusal: nothing was sent). Any other answer is never
   * sent twice.
   */
  async send<T = unknown>(req: Pick<BuiltRequest, 'method' | 'gatewayPath' | 'headers' | 'body'>): Promise<T> {
    if (!ALLOWED_WRITES.some((w) => w.method === req.method && w.path === req.gatewayPath)) {
      throw new LocalRefusal(`${req.method} ${req.gatewayPath} is not an action this copier sends`, req.gatewayPath, 'not-allowed');
    }
    const shape = writeShape(req.method, req.gatewayPath, req.body);
    // Weight of a signed write: 1 + floor(N/40) for a batch of N (research 01); the queue books it.
    return this.queue.submit(sendClass(req.method, req.gatewayPath, shape.priority), shape.accountId, shape.orders, () => this.transmit<T>(req), req.gatewayPath);
  }

  /** One signed write on the wire (the queue decides when). */
  private async transmit<T>(req: Pick<BuiltRequest, 'method' | 'gatewayPath' | 'headers' | 'body'>): Promise<T> {
    const ctl = abortController();
    const timer = timers.after(this.writeTimeoutMs, () => ctl.abort());
    const sentAt = Date.now();
    let res: ResponseLike;
    try {
      res = await this.fetch(this.gateway + req.gatewayPath, { method: req.method, headers: req.headers, body: req.body, signal: ctl.signal });
    } catch (e) {
      this.unreached(e);
      throw new OutcomeUnknownError(`SoDEX did not answer (${String(e).slice(0, 120)}); the request may still have executed.`);
    } finally {
      timers.cancel(timer);
    }
    const text = await res.text().catch(() => '');
    this.observe(res, text, req.gatewayPath, sentAt);
    // Cloudflare's 1015 page is HTML: refused at the edge, it never reached the exchange.
    if (isIpRateLimited(res.status, text)) throw new IpRateLimitedError(req.gatewayPath);
    const unreadable = res.status < 400 && text.trim() !== '' && !/^[\[{]/.test(text.trim());
    if (res.status >= 500 || unreadable) {
      throw new OutcomeUnknownError(`SoDEX answered HTTP ${res.status} after receiving the request; it may still have executed.`);
    }
    return parseEnvelope<T>(res.status, text, req.gatewayPath);
  }

  async markets(): Promise<MarketInfo[]> {
    return parseMarkets(await this.get<unknown>('/api/v1/perps/markets/symbols'));
  }

  /** Every market's mark, and its open interest in the coin (`openInterest`, null when absent). */
  async markPrices(): Promise<Array<{ symbol: string; price: number; oi?: number | null }>> {
    const rows = await this.get<Array<{ symbol?: string; markPrice?: string; openInterest?: string }>>('/api/v1/perps/markets/mark-prices');
    return (rows ?? [])
      .map((r) => ({ symbol: String(r.symbol ?? ''), price: Number(r.markPrice), oi: Number.isFinite(Number(r.openInterest)) && r.openInterest !== undefined ? Number(r.openInterest) : null }))
      .filter((r) => r.symbol && Number.isFinite(r.price) && r.price > 0);
  }

  /** The primary account id (0 when SoDEX has never seen a deposit from the wallet). */
  async accountId(address: string): Promise<number> {
    const a = address.toLowerCase();
    try {
      const s = await this.get<{ primaryAccountID?: number } | null>(`/api/v1/user/${a}/subaccounts`);
      if (s && typeof s.primaryAccountID === 'number' && s.primaryAccountID > 0) return s.primaryAccountID;
    } catch (e) {
      if (!(e instanceof SodexApiError && /user not found/i.test(e.message))) throw e;
    }
    const st = await this.perpsState(a);
    return st && typeof st.aid === 'number' && st.aid > 0 ? st.aid : 0;
  }

  async perpsState(address: string): Promise<RawPerpsState | null> {
    return this.get<RawPerpsState | null>(`/api/v1/perps/accounts/${address.toLowerCase()}/state`);
  }

  /** The follower's account as the copier needs it. */
  async follower(address: string, now = Date.now()): Promise<FollowerSnapshot> {
    return followerFromState(await this.perpsState(address), now);
  }

  /** Leader positions on SoDEX, symbol -> signed size, plus equity. */
  async leaderPositions(address: string): Promise<LeaderRead> {
    const st = await this.perpsState(address);
    const positions: Record<string, number> = {};
    const marks: Record<string, number> = {};
    for (const p of st?.P ?? []) {
      const sz = Number(p.sz);
      if (p.s && Number.isFinite(sz) && sz !== 0) positions[p.s] = sz;
    }
    const av = Number(st?.av);
    return { positions, equity: Number.isFinite(av) ? av : null, marks };
  }

  /** The account's API keys on perps (names are public). */
  async apiKeys(address: string, engine: 'spot' | 'perps' = 'perps'): Promise<ApiKeyRow[]> {
    const rows = await this.get<ApiKeyRow[] | { apiKeys?: ApiKeyRow[] } | null>(`/api/v1/${engine}/accounts/${address.toLowerCase()}/api-keys`);
    return Array.isArray(rows) ? rows : rows?.apiKeys ?? [];
  }

  /** Whether `keyAddress` is registered under `name` and not expired. */
  async keyRegistered(owner: string, name: string, keyAddress: string, now = Date.now()): Promise<{ ok: boolean; expiresAt: number | null }> {
    const rows = await this.apiKeys(owner, 'perps');
    const row = rows.find((r) => r.name === name);
    if (!row || row.publicKey.toLowerCase() !== keyAddress.toLowerCase()) return { ok: false, expiresAt: null };
    if (row.expiresAt && row.expiresAt <= now) return { ok: false, expiresAt: row.expiresAt };
    return { ok: true, expiresAt: row.expiresAt || null };
  }

  /** The perps builder-fee ceiling the account approved for `builderId` (null: none). */
  async builderApproval(owner: string, builderId: number): Promise<number | null> {
    const data = await this.get<unknown>(`/api/v1/user/${owner.toLowerCase()}/builders`);
    return approvedBuilderRates(data, builderId).perps;
  }
}

/** The part of `GET /perps/accounts/{a}/state` the copier reads. */
export interface RawPerpsState {
  aid?: number;
  av?: string;
  am?: string;
  P?: Array<{ s: string; sz: string; ep: string; l?: number; m?: string }> | null;
  S?: Array<{ s: string; l: number; m: string }> | null;
}

export function followerFromState(st: RawPerpsState | null, now = Date.now()): FollowerSnapshot {
  const positions: FollowerSnapshot['positions'] = {};
  for (const p of st?.P ?? []) {
    const size = Number(p.sz);
    if (!p.s || !Number.isFinite(size) || size === 0) continue;
    positions[p.s] = {
      size,
      entry: Number(p.ep) || 0,
      leverage: typeof p.l === 'number' ? p.l : 1,
      leverageReported: typeof p.l === 'number' && p.l > 0,
      marginMode: (p.m === 'ISOLATED' ? 'isolated' : 'cross') as MarginChoice,
    };
  }
  const equity = Number(st?.av);
  const available = Number(st?.am);
  return {
    accountId: typeof st?.aid === 'number' ? st.aid : 0,
    equity: Number.isFinite(equity) ? equity : 0,
    available: Number.isFinite(available) ? available : 0,
    marginKnown: Number.isFinite(available),
    positions,
    at: now,
  };
}

/** Per-symbol leverage settings the account has (S[]), symbol -> {leverage, margin}. */
export function leverageSettings(st: RawPerpsState | null): Record<string, { leverage: number; marginMode: MarginChoice }> {
  const out: Record<string, { leverage: number; marginMode: MarginChoice }> = {};
  for (const s of st?.S ?? []) out[s.s] = { leverage: s.l, marginMode: s.m === 'ISOLATED' ? 'isolated' : 'cross' };
  return out;
}

/* --------------------------------------------------------- Hyperliquid ----- */

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';

/** Hyperliquid's public info endpoint: leader positions and equity. */
export class HyperliquidClient {
  constructor(
    private readonly fetch: FetchLike,
    private readonly url = HL_INFO_URL,
  ) {}

  async post<T>(body: Record<string, unknown>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      const ctl = abortController();
      const timer = timers.after(10_000, () => ctl.abort());
      try {
        const res = await this.fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
        const text = await res.text();
        if (!res.ok) throw new SodexApiError(res.status, `Hyperliquid answered HTTP ${res.status}`, res.status, this.url);
        return JSON.parse(text) as T;
      } catch (e) {
        last = e;
        if (i >= attempts || !isTransientFailure(e)) throw e;
        await sleep(300 * 2 ** (i - 1));
      } finally {
        timers.cancel(timer);
      }
    }
    throw last;
  }

  /** Account mode per address (from its spot state): a unified one's perps run on its spot. */
  private modes = new Map<string, { unified: boolean; at: number }>();
  private spotPx: { at: number; value: Promise<Map<string, number> | null> } | null = null;

  /** The HIP-3 dexes (perpDexs; the main dex is not one of them). */
  async perpDexs(): Promise<string[]> {
    const rows = await this.post<Array<{ name?: string } | null> | null>({ type: 'perpDexs' });
    return (Array.isArray(rows) ? rows : []).flatMap((d) => (d?.name ? [d.name] : []));
  }

  /** The live perps of one dex ('' = the main dex), as its trade stream names them: 'BTC', 'xyz:TSLA'. */
  async perpCoins(dex: string): Promise<string[]> {
    const meta = await this.post<{ universe?: Array<{ name?: string; isDelisted?: boolean }> } | null>(dex ? { type: 'meta', dex } : { type: 'meta' });
    return (meta?.universe ?? []).filter((u) => u.name && !u.isDelisted).map((u) => u.name!);
  }

  /**
   * Perp positions (coin -> signed size) on the main dex and each HIP-3 dex in `dexes`
   * (one clearinghouseState each: every dex is its own margin book), merged; HL names a
   * HIP-3 coin with its dex ('xyz:TSLA'). The main dex is the one read that cannot fail:
   * it throws. Another dex that fails is left out of `dexes` and the read is `partial`.
   *
   * EQUITY - what proportional sizing divides the leader's positions by - is the account's
   * PERP EQUITY, as the server's size cohorts count it (apps/server/src/valuedesk/cohorts/
   * model.ts perpEquity, checked against Hyperdash 2026-10-03 and 2026-10-24):
   *  - a unified or portfolio-margin account (its spot state has
   *    tokenToAvailableAfterMaintenance): its spot holdings, stablecoins at $1 and every
   *    other token at its spot price. One pool backs every dex, and each dex's account
   *    value is only the margin in use there - which made copies of such a leader far
   *    too large.
   *  - a standard account: the account values of the dexes read, summed (main, xyz and
   *    any other dex in `dexes`). Its spot is not perps margin and is not counted.
   * Null - the last known equity is kept - when a dex read failed, when the spot state
   * could not be read and the account's mode is not known, or when a unified account
   * holds other tokens than stablecoins and no spot prices could be read: an equity
   * counted short sizes copies too large.
   * The spot state is read every time for a unified account and every
   * HL_MODE_RECHECK_MS for a standard one (to see it change mode).
   */
  async leaderPositions(address: string, dexes: readonly string[] = HL_DEXES, now = Date.now()): Promise<LeaderRead> {
    const user = address.toLowerCase();
    const want = [...new Set(['', ...dexes])];
    const mode = this.modes.get(user);
    const readSpot = !mode || mode.unified || now - mode.at >= HL_MODE_RECHECK_MS;
    const [spotR, ...stateR] = await Promise.allSettled([
      readSpot ? this.post<HlSpotState | null>({ type: 'spotClearinghouseState', user }) : Promise.resolve(null),
      ...want.map((dex) => this.post<HlState | null>(dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user })),
    ]);
    const main = stateR[0]!;
    if (main.status === 'rejected') throw main.reason;
    const positions: Record<string, number> = {};
    const marks: Record<string, number> = {};
    const read: string[] = [];
    let valueSum = 0;
    let asOf = -Infinity;
    stateR.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      read.push(want[i]!);
      const st = r.value;
      for (const ap of st?.assetPositions ?? []) {
        const p = ap.position;
        const sz = Number(p?.szi);
        if (p?.coin && Number.isFinite(sz) && sz !== 0) {
          positions[p.coin] = sz;
          const pv = Number(p.positionValue);
          if (Number.isFinite(pv) && pv > 0) marks[p.coin] = pv / Math.abs(sz);
        }
      }
      const av = Number(st?.marginSummary?.accountValue ?? 0);
      valueSum = Number.isFinite(av) && Number.isFinite(valueSum) ? valueSum + av : NaN;
      const t = Number(st?.time);
      // The latest answer: a print after it is in none of them (one between two answers is missed, not counted twice).
      if (Number.isFinite(t) && t > 0) asOf = Math.max(asOf, t);
    });
    const partial = read.length < want.length;
    let unified = mode?.unified ?? null;
    let collateral: number | null = null;
    if (readSpot && spotR.status === 'fulfilled') {
      const spot = spotR.value;
      unified = Array.isArray(spot?.tokenToAvailableAfterMaintenance);
      this.modes.set(user, { unified, at: now });
      if (unified) collateral = hlSpotCollateral(spot, await this.spotPrices(now));
    }
    const equity = unified === null ? null : unified ? collateral : partial || !Number.isFinite(valueSum) ? null : valueSum;
    return { positions, equity, marks, dexes: read, partial, ...(asOf > 0 ? { asOf } : {}) };
  }

  /** Spot tokens' prices in USDC (spotMetaAndAssetCtxs, weight 20), kept SPOT_PRICES_MS; null when they cannot be read. */
  private spotPrices(now: number): Promise<Map<string, number> | null> {
    if (this.spotPx && now - this.spotPx.at < SPOT_PRICES_MS) return this.spotPx.value;
    const value = this.post<HlSpotMetaCtxs | null>({ type: 'spotMetaAndAssetCtxs' })
      .then((raw) => {
        const px = hlSpotPrices(raw);
        return px.size ? px : null;
      })
      .catch(() => null);
    this.spotPx = { at: now, value };
    void value.then((px) => {
      if (!px && this.spotPx?.value === value) this.spotPx = null;
    });
    return value;
  }
}

/** Hyperliquid's main perp dex ('') and trade.xyz's HIP-3 dex: read for every Hyperliquid leader. */
export const HL_DEXES: readonly string[] = ['', 'xyz'];
/** A standard account's spot state is read again this often, to see it turn unified. */
export const HL_MODE_RECHECK_MS = 10 * 60_000;
const SPOT_PRICES_MS = 5 * 60_000;

interface HlState {
  marginSummary?: { accountValue?: string };
  assetPositions?: Array<{ position?: { coin?: string; szi?: string; positionValue?: string } }>;
  time?: number;
}

export interface HlSpotState {
  balances?: Array<{ coin?: string; token?: number; total?: string }>;
  /** Present only on a unified or portfolio-margin account: the tokens its perps run on. */
  tokenToAvailableAfterMaintenance?: Array<[number, string]>;
}

export type HlSpotMetaCtxs = [
  { tokens?: Array<{ name?: string; index?: number }>; universe?: Array<{ tokens?: [number, number]; index?: number }> },
  Array<{ markPx?: string | null; midPx?: string | null }>,
];

/** Stablecoins counted at $1 as perps collateral. */
const STABLE_COLLATERAL = /^(USDC|USDT0?|USDE|USDH|USDG)$/i;

/** Spot tokens' prices in USDC (token name -> mark): the pairs quoted in USDC (token 0). */
export function hlSpotPrices(raw: HlSpotMetaCtxs | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  const [meta, ctxs] = raw;
  const name = new Map((meta?.tokens ?? []).map((t) => [Number(t.index), String(t.name ?? '')]));
  for (const u of meta?.universe ?? []) {
    const [base, quote] = u.tokens ?? [];
    if (quote !== 0 || base === undefined) continue;
    const c = ctxs?.[Number(u.index)];
    const p = Number(c?.markPx ?? c?.midPx);
    const n = name.get(Number(base));
    if (n && Number.isFinite(p) && p > 0 && !out.has(n)) out.set(n, p);
  }
  return out;
}

/**
 * A unified / portfolio-margin account's perp equity: its spot holdings, stablecoins at $1,
 * other tokens at their spot price (`px`; one without a USDC pair counts 0), as
 * apps/server/src/indexer/cohortSource.ts spotCollateral. Null for a standard account, and -
 * unlike the server, which then counts the stablecoins alone - when it holds other tokens
 * and no prices could be read: counted short, it would size copies too large.
 */
export function hlSpotCollateral(st: HlSpotState | null | undefined, px: ReadonlyMap<string, number> | null): number | null {
  if (!Array.isArray(st?.tokenToAvailableAfterMaintenance)) return null;
  let sum = 0;
  for (const b of st?.balances ?? []) {
    const coin = String(b.coin ?? '');
    const total = Number(b.total);
    if (!Number.isFinite(total) || total === 0) continue;
    if (STABLE_COLLATERAL.test(coin)) sum += total;
    else if (!px) return null;
    else sum += total * (px.get(coin) ?? 0);
  }
  return sum;
}
