/**
 * Shared Hyperliquid /info client: weight budget, timeouts, 429 backoff,
 * in-flight dedup and a small TTL cache.
 *
 * READ-ONLY. The only endpoint this file knows is POST /info, which takes no
 * signature and cannot change state. There is deliberately no /exchange
 * builder here that a later change could quietly point at an order.
 *
 * WHY ONE CLIENT. HL limits REST to 1,200 weight per minute PER IP
 * (rate-limits-and-user-limits.md). Leaderboard profiles, fills, positioning
 * and the whale feed's coin ranking all spend the same budget, and so does any
 * browser tab on this machine that queries HL directly. One process-wide bucket
 * is the only place that budget can be enforced. We default to 1,000/min so
 * there is headroom for those other callers - and to 200/min in a process that
 * only serves the API beside the indexer (hlWeightPerMin below).
 *
 * Weights (documented): clearinghouseState, spotClearinghouseState, l2Book,
 * allMids, orderStatus, exchangeStatus = 2; userRole = 60; every other info
 * type = 20. userFills, userFillsByTime, historicalOrders, recentTrades,
 * userFunding and a few more add weight per 20 items RETURNED, which is only
 * known after the response. That extra is charged afterwards (see
 * WeightBudget.charge), so it delays the NEXT requests, not this one.
 */
import { apiOnly, envOf } from '../env.js';

export const HL_INFO_URL = (envOf('VALUESCAN_HL_INFO_URL')?.trim() || 'https://api.hyperliquid.xyz/info').replace(
  /\/+$/,
  '',
);

/** HL's own limit: REST weight per minute per IP. */
export const HL_LIMIT_PER_MIN = 1200;
/** The share of a client that is its address's main Hyperliquid reader. */
export const HL_WEIGHT_DEFAULT = 1000;
/** The share of a process that only serves the API (env.ts apiOnly). */
export const HL_WEIGHT_API_ONLY = 200;

/**
 * This client's share of HL's 1,200 weight/min/IP.
 *
 *   VALUESCAN_HL_WEIGHT_PER_MIN set   that, clamped to 60..1,200 - for every role.
 *   a browser, the dev server         1,000: the address's main reader (the dev
 *                                     server's indexer thread has lanes of its own).
 *   a process that only serves the    200. The indexer reads Hyperliquid from the
 *   API (VALUESCAN_INDEXER=0 or       same address under its own lanes - 500 for the
 *   VALUESCAN_HOSTED=1)               boards (VALUESCAN_INDEX_HL_WEIGHT, at most 900)
 *                                     and 400 for the cohort books and holders' PnL
 *                                     (VALUESCAN_INDEX_HL_COHORT) - and those plus
 *                                     this must fit 1,200: 1,100 by default. It used
 *                                     to be 1,000 here too, which with the indexer's
 *                                     700 is 1,700 from one address. Such a process
 *                                     needs next to nothing: positioning is answered
 *                                     from the index, and the whale feed's coin
 *                                     ranking is 40 weight an hour.
 *   the indexer itself (`indexer`)    1,000, whatever the two switches say (one env
 *                                     file often serves both processes): there the
 *                                     lanes are the limit, and this client must not
 *                                     hold them below it (indexer/worker.ts).
 */
export function hlWeightPerMin(get: (name: string) => string | undefined = envOf, indexer = false): number {
  const n = Number.parseInt(get('VALUESCAN_HL_WEIGHT_PER_MIN') ?? '', 10);
  if (Number.isFinite(n) && n > 0) return Math.min(HL_LIMIT_PER_MIN, Math.max(60, n));
  return !indexer && apiOnly(get) ? HL_WEIGHT_API_ONLY : HL_WEIGHT_DEFAULT;
}

/** What this process's shared client starts with (client.ts). */
export const HL_WEIGHT_PER_MIN = hlWeightPerMin();

const WEIGHT_2 = new Set(['clearinghouseState', 'spotClearinghouseState', 'l2Book', 'allMids', 'orderStatus', 'exchangeStatus']);

const ITEM_WEIGHTED = new Set([
  'userFills',
  'userFillsByTime',
  'historicalOrders',
  'recentTrades',
  'userFunding',
  'fundingHistory',
  'nonUserFundingUpdates',
  'twapHistory',
  'userTwapSliceFills',
  'userTwapSliceFillsByTime',
  'delegatorHistory',
  'delegatorRewards',
  'validatorStats',
]);

/** Weight HL charges for the request itself. */
export function baseWeight(type: string): number {
  if (WEIGHT_2.has(type)) return 2;
  if (type === 'userRole') return 60;
  return 20;
}

/**
 * Extra weight for the items a response returned. The docs say "per 20 items"
 * without the rounding; we round UP, which can only make us more polite.
 */
export function itemWeight(type: string, result: unknown): number {
  if (!ITEM_WEIGHTED.has(type) || !Array.isArray(result)) return 0;
  return Math.ceil(result.length / 20);
}

// --- weight budget -------------------------------------------------------------

/**
 * Token bucket measured in HL weight, with an injected clock.
 *
 * Same idea as the Katana TokenBucket (venues/katana/rest.ts), generalised
 * from "one token per call" to "w weight per call":
 * - `reserve` returns the delay the caller owes instead of sleeping, so the
 *   arithmetic is a pure function of (state, now) and testable without timers.
 * - The balance may go NEGATIVE. That is what serialises concurrent callers:
 *   ten simultaneous requests each take their weight from a running debt and
 *   get distinct, increasing delays instead of all waking at once.
 */
export class WeightBudget {
  private tokens: number;
  private last: number;

  constructor(
    readonly perMin: number,
    readonly capacity: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.perMin) / 60_000);
    this.last = now;
  }

  /** Weight available right now (negative = queued debt). */
  available(now = Date.now()): number {
    this.refill(now);
    return this.tokens;
  }

  /** Claim `w` weight; returns how many ms to wait before sending. */
  reserve(w: number, now = Date.now()): number {
    this.refill(now);
    this.tokens -= w;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.perMin) * 60_000);
  }

  /** Book weight learned after the fact (items returned). */
  charge(w: number, now = Date.now()): void {
    this.refill(now);
    this.tokens -= w;
  }

  /** ms until at least `w` weight is free (0 = now). */
  msUntil(w: number, now = Date.now()): number {
    const have = this.available(now);
    return have >= w ? 0 : Math.ceil(((w - have) / this.perMin) * 60_000);
  }

  /**
   * After a 429 our view of HL's window is wrong: HL thinks the minute is
   * spent. Drain to a debt worth `ms` of refill so every queued caller backs
   * off together instead of each discovering the 429 on its own.
   */
  penalize(ms: number, now = Date.now()): void {
    this.refill(now);
    this.tokens = Math.min(this.tokens, -(this.perMin * ms) / 60_000);
  }
}

// --- errors and backoff --------------------------------------------------------

export class HlApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly infoType: string,
  ) {
    super(message);
    this.name = 'HlApiError';
  }
}

export type BackoffKind = 'rateLimit' | 'transport';

/** Total attempts including the first. */
export const HL_RETRY_ATTEMPTS = 4;
export const HL_BACKOFF_BASE_MS: Record<BackoffKind, number> = { rateLimit: 2000, transport: 400 };
export const HL_BACKOFF_CAP_MS = 15_000;
/** How much refill a 429 drains from the shared bucket. */
export const HL_429_PENALTY_MS = 10_000;

/** Exponential with equal jitter: half fixed, half random. */
export function hlBackoffMs(attempt: number, kind: BackoffKind, rand = Math.random()): number {
  const n = Math.max(1, Math.trunc(attempt));
  const ceiling = Math.min(HL_BACKOFF_CAP_MS, HL_BACKOFF_BASE_MS[kind] * 2 ** (n - 1));
  return Math.round(ceiling / 2 + rand * (ceiling / 2));
}

/**
 * Allow-list of retryable failures. 429 and 5xx are transient; any other 4xx
 * (HL answers 422 "Failed to deserialize" for a bad body) is deterministic.
 * undici reports network faults as TypeError('fetch failed').
 */
export function hlRetryKind(err: unknown): BackoffKind | null {
  if (err instanceof HlApiError) {
    if (err.status === 429) return 'rateLimit';
    if (err.status >= 500) return 'transport';
    return null;
  }
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError' ? 'transport' : null;
  }
  return null;
}

// --- client --------------------------------------------------------------------

export type InfoBody = { type: string } & Record<string, unknown>;

export interface InfoOpts {
  /** Cache the result this long. 0 = no cache (in-flight dedup still applies). */
  ttlMs?: number;
  timeoutMs?: number;
  /**
   * Background work (positioning sweeps, coin ranking) only starts when the
   * bucket still has BACKGROUND_HEADROOM weight left after it, so a sweep can
   * never starve an interactive profile lookup.
   */
  background?: boolean;
}

/** What the rest of the provider needs; lets tests pass a stub. */
export interface InfoLike {
  post<T>(body: InfoBody, o?: InfoOpts): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const BACKGROUND_HEADROOM = 150;
const CACHE_MAX = 2000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HlInfoClient implements InfoLike {
  budget: WeightBudget;
  private cache = new Map<string, { at: number; ttl: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly url: string = HL_INFO_URL,
    perMin: number = HL_WEIGHT_PER_MIN,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep,
  ) {
    // Half a minute of burst: enough for a profile (about 150 weight) plus a
    // few clearinghouse reads, far from HL's full 1,200.
    this.budget = new WeightBudget(perMin, Math.round(perMin / 2));
  }

  /**
   * Give this client another share of HL's limit, with a fresh bucket. For the
   * indexer process at its start (indexer/worker.ts), before it has sent anything.
   */
  resize(perMin: number): void {
    const n = Math.min(HL_LIMIT_PER_MIN, Math.max(60, Math.round(perMin)));
    if (n !== this.budget.perMin) this.budget = new WeightBudget(n, Math.round(n / 2));
  }

  async post<T>(body: InfoBody, o: InfoOpts = {}): Promise<T> {
    // Our bodies are built with a fixed key order, so the JSON is a stable key.
    const key = JSON.stringify(body);
    const ttl = o.ttlMs ?? 0;
    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const p = this.request<T>(body, o)
      .then((value) => {
        if (ttl > 0) this.remember(key, ttl, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private remember(key: string, ttl: number, value: unknown): void {
    this.cache.delete(key);
    this.cache.set(key, { at: Date.now(), ttl, value });
    if (this.cache.size <= CACHE_MAX) return;
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (now - v.at >= v.ttl) this.cache.delete(k);
    }
    // Still full: drop the oldest insertions (Map keeps insertion order).
    for (const k of this.cache.keys()) {
      if (this.cache.size <= CACHE_MAX) break;
      this.cache.delete(k);
    }
  }

  private async request<T>(body: InfoBody, o: InfoOpts): Promise<T> {
    const w = baseWeight(body.type);
    for (let attempt = 1; ; attempt++) {
      if (o.background) {
        // Never more than the bucket can hold: with a small share (an API-only
        // process: 100 of burst) "the request plus 150 of headroom" is a level
        // the bucket never reaches, and this wait would never end. There a
        // background request waits for a full bucket instead.
        const need = Math.min(w + BACKGROUND_HEADROOM, this.budget.capacity);
        for (let wait = this.budget.msUntil(need); wait > 0; wait = this.budget.msUntil(need)) {
          await this.sleepImpl(Math.min(wait, 2000));
        }
      }
      // Every attempt pays: a retry is a real extra request against HL's window.
      const wait = this.budget.reserve(w);
      if (wait > 0) await this.sleepImpl(wait);
      try {
        const out = await this.send<T>(body, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const extra = itemWeight(body.type, out);
        if (extra) this.budget.charge(extra);
        return out;
      } catch (err) {
        const kind = hlRetryKind(err);
        if (kind === 'rateLimit') this.budget.penalize(HL_429_PENALTY_MS);
        if (kind === null || attempt >= HL_RETRY_ATTEMPTS) throw err;
        await this.sleepImpl(hlBackoffMs(attempt, kind));
      }
    }
  }

  /** One HTTP round trip. Owns neither budgeting nor retry. */
  private async send<T>(body: InfoBody, timeoutMs: number): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HlApiError(res.status, `Hyperliquid ${body.type}: HTTP ${res.status} ${text.slice(0, 160)}`.trim(), body.type);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HlApiError(res.status, `Hyperliquid ${body.type}: non-JSON response ${text.slice(0, 160)}`, body.type);
    }
  }
}

/** Run `fn` over `items` with at most `n` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i] as T, i) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
