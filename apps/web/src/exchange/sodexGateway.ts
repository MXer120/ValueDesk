/**
 * The SoDEX trading gateway, read straight from the user's browser.
 *
 * Every rule here is the server's (sodex/restCore.ts, imported, not copied):
 * the documented weight of each path, the per-path cache lifetimes, the retry
 * policy for reads, and the 15 s -> 5 min cooldown after a rate limit. What
 * changes is whose budget it is: the weight a minute is now the user's own
 * IP's, counted over every tab they have open (ledger.ts). It starts at the
 * documented 1200 and follows the limit the gateway reports (`learn`) - when
 * the browser can read it: on 2026-10-31 SoDEX reports 6000 but does not
 * expose the header to CORS, so a browser stays at 1200 until it does.
 *
 * HARD RULE, kept from the server: SoDEX's Cloudflare answers
 * `/accounts/{a}/trades` and `/orders/history` with 1015 once one IP asks too
 * often, and a 1015 stops that route for a minute or more (every tab, and the
 * user's other devices behind the same IP). Measured 2026-09-30 from a quiet
 * IP: one request every ~13 s answered 200 four times and 1015 on the fifth
 * (53 s) - on /trades, on /orders/history, and on the two mixed (T, O, T, O,
 * then T refused): ONE counter, 4 per ~60 s. Cloudflare estimates the rate as
 * the previous minute (weighted) plus this one, so ANY two adjacent minutes
 * must hold at most 4: both routes, both engines, share ONE drip of
 * HISTORY_DRIP.max per HISTORY_DRIP.windowMs over every tab. A page that opens
 * four history panels gets two at once and two a minute later - not a 1015
 * that blanks all four (three per minute was seen to trip it).
 * They are never replayed after a failure that could have been that 1015: one
 * refusal stops every history read of every tab for HISTORY_COOL (doubling
 * while refusals continue). A read asked for meanwhile waits that out in its
 * queue, as it would wait for a slot - none is sent before it ends.
 *
 * Signed writes do not come through here (trading/gateway.ts sends them once,
 * never retried); they are only counted against the budget.
 */
import { SodexApiError, parseEnvelope } from '@sodex-core';
import {
  COOL_BASE_MS,
  COOL_MAX_MS,
  COOL_WAIT_MAX_MS,
  GATEWAY_WEIGHT_PER_MIN,
  GATEWAY_WINDOW_MS,
  RETRY_ATTEMPTS,
  TRANSIENT_ENVELOPE_RE,
  endpointOf,
  limitOf,
  reportedRateLimit,
  retryDelayMs,
  ttlFor,
  unbookedWeight,
  weightFor,
} from '@sign/sodex/restCore.js';
import { noteRateLimited } from '@sign/valuedesk/sodex/util.js';
import { RateLimitedError, UnreachableError, isAbort, isOffline, isRateLimitError } from './errors';
import { RequestGate } from './gate';
import { gatewayOrigin } from './hosts';
import { SharedCooldowns, SharedLedger, defaultLedgerDeps, type LedgerDeps } from './ledger';
import { HistoryQueue, type HistoryPriority } from './historyQueue';
import { isHidden } from './visibility';

/** At most this many `/trades` and `/orders/history` requests together per window, every tab together. */
export const HISTORY_DRIP = { max: 2, windowMs: 60_000 } as const;
/**
 * The drip's ledger counts a little longer than that window: a slot is taken a
 * few milliseconds before its request leaves, and that lag varies - so two
 * requests exactly a window apart in the ledger could be a hair closer on the wire.
 */
const DRIP_GUARD_MS = 500;

/**
 * After a refused (or unreadable) history read, no tab sends another for this
 * long, doubling while refusals continue: Cloudflare's 1015 outlasts the
 * gateway's usual 15 s cooldown, and every request into it prolongs it.
 */
export const HISTORY_COOL = { baseMs: 60_000, maxMs: 10 * 60_000 } as const;
const HISTORY_COOL_KEY = 'history';

/** Same cache lifetime the server gave history pages: identical reads from several panels share one. */
export const HISTORY_TTL_MS = 5_000;
/** A history page (up to 1000 rows) gets one long attempt. */
const READ_TIMEOUT_MS = 20_000;
/**
 * Every other read gets 8 s and one retry, inside the 20 s a page waits: a
 * connection that stalls (the first one of a visit, a network switch) costs
 * one retry, not twenty seconds of "Loading...".
 */
const QUICK_READ_TIMEOUT_MS = 8_000;
/**
 * ...and all of such a read - its wait for a cooldown and for the budget, and
 * both attempts - ends within this, under the 20 s the page waits (api.ts): a
 * read is never still queued, or sent, after the page that asked gave up on
 * it. A normal answer takes about 0.3 s (measured 2026-10-29).
 */
export const QUICK_READ_MAX_MS = 18_000;
/** No attempt of such a read is started with less than this left of it. */
const MIN_ATTEMPT_MS = 2_000;
/** How long a history read may wait for the per-IP weight budget (the server's WeightBudget waited 30 s). */
const BUDGET_WAIT_MS = 30_000;
/**
 * How long a history read for something on screen may queue for its drip slot:
 * two full windows (two reads ahead of it in each) and the polling slack.
 */
const DRIP_WAIT_MS = 2 * HISTORY_DRIP.windowMs + 5_000;
/** ...a page of a view's many (a wallet's fills for the copy simulator): tables go first, so it may wait longer... */
const BULK_DRIP_WAIT_MS = 5 * 60_000;
/** ...and a background history read (it waits behind everything on screen). */
const BACKGROUND_DRIP_WAIT_MS = 15 * 60_000;

/** How long a history read of `priority` may wait for its slot (and for a history cooldown to end). */
const dripWaitOf = (priority: HistoryPriority): number =>
  priority === 'visible' ? DRIP_WAIT_MS : priority === 'bulk' ? BULK_DRIP_WAIT_MS : BACKGROUND_DRIP_WAIT_MS;

/**
 * The longest a history read for something on screen can take here: the
 * per-IP budget, its turn for a slot (a cooldown included), and its one long
 * attempt. A caller's own deadline for such a read (api.ts) is at least this,
 * or it would give up on a read that is still on its way.
 */
export const VISIBLE_HISTORY_MAX_MS = BUDGET_WAIT_MS + DRIP_WAIT_MS + READ_TIMEOUT_MS;

const HISTORY_RE = /\/accounts\/[^/]+\/(orders\/history|trades|fundings|funding-history|positions\/history)(\?|$)/;
const TRADES_RE = /\/accounts\/[^/]+\/trades(\?|$)/;
const ORDERS_HISTORY_RE = /\/accounts\/[^/]+\/orders\/history(\?|$)/;

export const isHistoryPath = (path: string): boolean => HISTORY_RE.test(path);

export interface GatewayClientOptions {
  deps?: LedgerDeps;
  fetchImpl?: typeof fetch;
  origin?: () => string;
  /** The cache's clock (tests). */
  now?: () => number;
  /** Whether this tab is off screen (history reads from a hidden tab are background). */
  hidden?: () => boolean;
  /** Whether the browser says it has no network (errors.ts isOffline). */
  offline?: () => boolean;
}

export interface GwGetOptions {
  /** Weight when it is not the path's documented default. */
  weight?: number;
  /** Cache lifetime; default: the server's table, 5 s for history pages, else concurrent dedupe only. */
  ttlMs?: number;
  /**
   * The reader no longer wants the answer. Ends a read that is still waiting
   * (budget, history slot) at once. A history read already sent completes all
   * the same: its slot is spent, and the answer is kept for the next reader.
   */
  signal?: AbortSignal;
  /** Attempts for a transient failure (the server used 4). */
  attempts?: number;
  /** false: do not keep this answer as the path's last good copy (bulk walk pages). */
  keepLastGood?: boolean;
  /**
   * For /trades and /orders/history: who this read is for (historyQueue.ts).
   * Default 'visible' - a table on screen; 'bulk' for a view's many pages (a
   * wallet's fills); 'background' for anything nobody is looking at; 'walk'
   * for the all-time walk.
   */
  priority?: HistoryPriority;
  /** Called when the request is sent - after any wait for the budget or a history slot. */
  onSent?: () => void;
}

/** A gateway client with its own budget ledgers. The app uses the one below; tests make their own. */
export class GatewayClient {
  readonly budget: SharedLedger;
  readonly cooldowns: SharedCooldowns;
  /** The one drip `/trades` and `/orders/history` share. */
  readonly historyDrip: SharedLedger;
  /** The class-wide cooldown after a refused history read. */
  readonly historyCool: SharedCooldowns;
  /** Who gets the drip's next slot. */
  readonly historyQueue: HistoryQueue;
  readonly gate: RequestGate;
  private readonly deps: LedgerDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly origin: () => string;
  private readonly offline: () => boolean;

  constructor(o: GatewayClientOptions = {}) {
    this.deps = o.deps ?? defaultLedgerDeps();
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.origin = o.origin ?? gatewayOrigin;
    this.offline = o.offline ?? isOffline;
    this.gate = new RequestGate(2_000, o.now ?? this.deps.now);
    // No lock per request: this budget has room to spare (see ledger.ts `atomic`).
    this.budget = new SharedLedger('sodex-gw', GATEWAY_WEIGHT_PER_MIN, GATEWAY_WINDOW_MS, this.deps, false);
    this.cooldowns = new SharedCooldowns('sodex-gw', COOL_BASE_MS, COOL_MAX_MS, this.deps);
    this.historyDrip = new SharedLedger('sodex-history', HISTORY_DRIP.max, HISTORY_DRIP.windowMs + DRIP_GUARD_MS, this.deps);
    this.historyCool = new SharedCooldowns('sodex-history', HISTORY_COOL.baseMs, HISTORY_COOL.maxMs, this.deps);
    this.historyQueue = new HistoryQueue({
      drip: this.historyDrip,
      store: this.deps.store,
      now: this.deps.now,
      sleep: this.deps.sleep,
      hidden: o.hidden ?? isHidden,
    });
  }

  /** The drip a path must pass, or null. */
  dripFor(path: string): SharedLedger | null {
    return TRADES_RE.test(path) || ORDERS_HISTORY_RE.test(path) ? this.historyDrip : null;
  }

  /** Default cache lifetime of a path. */
  ttlOf(path: string): number {
    const t = ttlFor(path);
    if (t > 0) return t;
    return isHistoryPath(path) ? HISTORY_TTL_MS : 0;
  }

  /** One gateway GET (path relative to the gateway origin); resolves with the envelope's `data`. */
  get<T>(path: string, o: GwGetOptions = {}): Promise<T> {
    const ttl = o.ttlMs ?? this.ttlOf(path);
    // A history read waits only on a request of its own priority: a table on
    // screen never stands in a background read's place in the queue. The answer
    // and the last good copy are the path's, whoever read it.
    const lane = this.dripFor(path) ? (o.priority ?? 'visible') : '';
    return this.gate.run(`${this.origin()}${path}`, ttl, () => this.request<T>(path, o), o.keepLastGood ?? true, lane);
  }

  /** The last good answer for a path (history pages fall back to it). */
  lastGood<T>(path: string): { at: number; value: T } | null {
    return this.gate.lastGood<T>(`${this.origin()}${path}`);
  }

  /** Book a signed write's weight (writes are never delayed or retried here). */
  chargeWrite(weight = 1): void {
    void this.budget.charge(weight);
  }

  /**
   * One gateway answer's x-ratelimit-* headers (a read's or a signed write's).
   * The budget's limit becomes the reported one (a header that is not an
   * integer in 600..60000 changes nothing), and what the IP spent beyond every
   * tab's ledger - the copier's and algos' own clients, the user's other
   * devices - is booked, so the next read waits rather than drawing a 429.
   * Booking only adds weight; nothing lets more through than the limit.
   */
  learn(headers: { get(name: string): string | null } | null | undefined): void {
    const r = reportedRateLimit(headers ? (name) => headers.get(name) : undefined);
    if (!r) return;
    this.budget.setLimit(r.limit);
    const owed = unbookedWeight(r, this.budget.spent());
    if (owed > 0) void this.budget.charge(owed);
  }

  /** ms until `path`'s endpoint may be asked again. */
  cooldownLeft(path: string): number {
    const own = this.cooldowns.left(endpointOf(path));
    return this.dripFor(path) ? Math.max(own, this.historyCool.left(HISTORY_COOL_KEY)) : own;
  }

  private async request<T>(path: string, o: GwGetOptions): Promise<T> {
    const endpoint = endpointOf(path);
    const weight = o.weight ?? weightFor(path, limitOf(path));
    const drip = this.dripFor(path);
    const attempts = Math.max(1, o.attempts ?? RETRY_ATTEMPTS);
    const host = new URL(this.origin()).host;

    const priority = o.priority ?? 'visible';
    const dripWait = dripWaitOf(priority);
    // A read that is not dripped ends - waits, attempts and all - by `until` (QUICK_READ_MAX_MS).
    const until = drip ? Infinity : this.deps.now() + QUICK_READ_MAX_MS;
    /** Whether another attempt, `after` ms from now, would still have its minimum time. */
    const roomFor = (after: number) => this.deps.now() + after + MIN_ATTEMPT_MS <= until;
    for (let attempt = 1; ; attempt++) {
      const cool = this.cooldownLeft(path);
      if (drip) {
        // A history read waits a cooldown out in its queue (below); one that
        // outlasts all this read may wait is refused now, before any budget.
        if (cool > dripWait) throw new RateLimitedError(host, cool, 'history reads');
      } else {
        if (cool > COOL_WAIT_MAX_MS || (cool > 0 && !roomFor(cool))) throw new RateLimitedError(host, cool);
        if (cool > 0) await this.deps.sleep(cool);
      }
      // Waiting for the budget past the read's end would only send it after nobody waits for it.
      await this.budget.take(weight, drip ? BUDGET_WAIT_MS : Math.min(BUDGET_WAIT_MS, until - MIN_ATTEMPT_MS - this.deps.now()), o.signal);
      if (drip) {
        const queued = this.deps.now();
        await this.historyQueue.take(priority, dripWait, o.signal, () => {
          // A refusal (this tab's or another's) closes history for every read:
          // this one takes no slot and is not sent until the cooldown is over.
          // It waits for that as long as its priority may wait - a table on
          // screen shows "Loading…" for a minute rather than "couldn't load"
          // with a Retry that cannot work yet - and gives up at its next look
          // once the cooldown outlasts that.
          const left = this.cooldownLeft(path);
          if (left > 0 && this.deps.now() - queued + left > dripWait) throw new RateLimitedError(host, left, 'history reads');
          return left;
        });
      }
      if (o.signal?.aborted) throw o.signal.reason ?? new DOMException('aborted', 'AbortError');

      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      // A history read that was sent is not cancelled by its reader leaving: the
      // slot is spent, and the answer is kept for whoever reads that page next.
      if (!drip) o.signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, drip ? READ_TIMEOUT_MS : Math.max(MIN_ATTEMPT_MS, Math.min(QUICK_READ_TIMEOUT_MS, until - this.deps.now())));
      let status = 0;
      let text = '';
      o.onSent?.();
      try {
        const res = await this.fetchImpl(this.origin() + path, {
          headers: { Accept: 'application/json' },
          signal: ctl.signal,
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        status = res.status;
        this.learn(res.headers);
        text = await res.text();
      } catch (e) {
        if (o.signal?.aborted && isAbort(e)) throw e;
        // No readable answer. A drip path is never replayed: that is what a
        // Cloudflare 1015 looks like from a browser (which answers at once - a
        // read that merely ran out of time is not one, and closes nothing; nor
        // is one sent while the browser had no network at all).
        if (drip && (timedOut || this.offline())) throw new UnreachableError(host, timedOut);
        if (drip) {
          this.cooldowns.hit(endpoint);
          const ms = this.historyCool.hit(HISTORY_COOL_KEY);
          noteRateLimited();
          throw new RateLimitedError(host, ms, 'history reads');
        }
        const delay = retryDelayMs(attempt);
        if (attempt >= Math.min(attempts, 2) || !roomFor(delay)) throw new UnreachableError(host, timedOut);
        await this.deps.sleep(delay);
        continue;
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
      }

      try {
        const data = parseEnvelope<T>(status, text, path);
        this.cooldowns.clear(endpoint);
        if (drip) this.historyCool.clear(HISTORY_COOL_KEY);
        return data;
      } catch (e) {
        if (isRateLimitError(e)) {
          // Never replayed: a cooldown opens for every tab, doubling while 429s continue.
          this.cooldowns.hit(endpoint);
          if (drip) this.historyCool.hit(HISTORY_COOL_KEY);
          noteRateLimited();
          throw e;
        }
        const delay = retryDelayMs(attempt);
        if (attempt >= attempts || !isTransient(e) || !roomFor(delay)) throw e;
        await this.deps.sleep(delay);
      }
    }
  }
}

/** The server's isTransientFailure, for the browser's error type. */
export function isTransient(e: unknown): boolean {
  if (e instanceof SodexApiError) {
    if (e.httpStatus >= 500) return true;
    if (e.httpStatus === 429 || e.code === 429) return true;
    if (e.httpStatus < 400) return TRANSIENT_ENVELOPE_RE.test(e.message);
    return false;
  }
  return e instanceof UnreachableError;
}

/** This app's gateway client. */
export const gateway = new GatewayClient();

/** One gateway read through this app's client. */
export const gwGet = <T>(path: string, o?: GwGetOptions): Promise<T> => gateway.get<T>(path, o);
