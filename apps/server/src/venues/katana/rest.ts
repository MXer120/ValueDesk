/**
 * Katana perps REST transport: rate limiting, backoff, and error mapping.
 *
 * READ-ONLY. Nothing in this file signs anything, and nothing in it may. Katana's
 * write path needs an API key plus an HMAC plus a separate EIP-712 wallet
 * signature, and the delegated-key variant is contested in their own docs - so
 * trading is out of scope for this adapter by decision, not by omission. There is
 * no request builder here that a later change could quietly point at a POST.
 *
 * WHY THIS IS SERVER-SIDE. Katana's REST responses carry no
 * `access-control-allow-origin`, so a browser cannot read them at all. Every call
 * must be proxied through this process. That also means the rate limit below is
 * shared by every open tab, which is exactly why it is enforced in one place.
 */
import {
  VenueRequestError,
  type VenueInfo,
} from '../types.js';

/**
 * Base URL.
 *
 * NOT the host in the published docs. `perps-api.katana.network` has no A or
 * AAAA record - the authoritative Cloudflare zone answers NODATA, so every
 * request to it fails at DNS with ENOTFOUND before a socket is opened. The host
 * that actually serves the documented `/v1/*` routes is `api-perps.katana.network`
 * (verified: /v1/ping -> 200 {}, /v1/time -> 200 {"serverTime":...}). Overridable
 * so a host change does not need a code change.
 */
export const KATANA_BASE = (process.env.KATANA_API_BASE?.trim() || 'https://api-perps.katana.network').replace(
  /\/+$/,
  '',
);

export const KATANA_VENUE_ID = 'katana-perps';

/**
 * The only candle intervals Katana accepts.
 *
 * Verified by probing, not copied from a table: 3m and 1w both return
 * HTTP 400 INVALID_PARAMETER. Validating locally turns a wasted round trip -
 * which also costs a rate-limit token - into an immediate, specific error.
 */
export const KATANA_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type KatanaInterval = (typeof KATANA_INTERVALS)[number];

/** Katana's own bounds, from its 400 messages. */
export const KATANA_MAX_ROWS = 1000;
/** `limit` on /v1/orderbook counts BOTH sides, so per-side tops out at half. */
export const KATANA_MAX_BOOK_TOTAL = 1000;
export const KATANA_MAX_BOOK_DEPTH = KATANA_MAX_BOOK_TOTAL / 2;

export const KATANA_INFO: VenueInfo = {
  id: KATANA_VENUE_ID,
  label: 'Katana Perps',
  kind: 'perps',
  intervals: KATANA_INTERVALS,
  maxBookDepth: KATANA_MAX_BOOK_DEPTH,
  maxRows: KATANA_MAX_ROWS,
};

export function isKatanaInterval(v: unknown): v is KatanaInterval {
  return typeof v === 'string' && (KATANA_INTERVALS as readonly string[]).includes(v);
}

/**
 * Convert levels-per-side (what the Venue interface speaks) into Katana's
 * `limit` (which counts both sides together).
 *
 * This is not cosmetic. Measured: limit=10 returns 5 bids and 5 asks, limit=50
 * returns 25 and 25. Passing a per-side depth straight through would silently
 * deliver half the requested book - a half-depth ladder looks perfectly normal on
 * screen, so the bug would never announce itself.
 *
 * Katana rejects limit<2, so a 1-level request is widened to 2 and the caller's
 * own slice trims it back.
 */
export function bookLimitForDepth(depth: number): number {
  const perSide = Math.min(KATANA_MAX_BOOK_DEPTH, Math.max(1, Math.trunc(depth) || 1));
  return Math.min(KATANA_MAX_BOOK_TOTAL, Math.max(2, perSide * 2));
}

// --- errors ------------------------------------------------------------------

export class KatanaApiError extends VenueRequestError {
  constructor(
    readonly httpStatus: number,
    message: string,
    readonly path: string,
    readonly code?: string,
  ) {
    // A 5xx from Katana is not our caller's fault, but surfacing it as our own
    // 500 would blame this process for an upstream outage. 502 says "the venue
    // is unwell", which is the actionable truth.
    super(message, httpStatus >= 500 ? 502 : httpStatus, KATANA_VENUE_ID);
    this.name = 'KatanaApiError';
  }
}

// --- rate limiting -----------------------------------------------------------

/**
 * Measured limit: 5 requests per ~1s sliding window.
 *
 * A 12-way simultaneous burst returned 5x200 and 7x429; after draining the bucket
 * the first success came back ~1.07s later, and a sustained 4 req/s for 16
 * requests never tripped it. So the shape is a 5-token bucket refilling over one
 * second.
 *
 * We run at 4/s, not 5. The window edge is inferred rather than documented, this
 * process shares one IP with every browser tab, and a 429 costs a whole extra
 * second of latency - so one token of slack buys more than it costs.
 */
const CAPACITY = 4;
const REFILL_PER_SEC = 4;

/**
 * Token bucket with an injected clock.
 *
 * `reserve` returns the delay the caller owes rather than sleeping itself, which
 * keeps the arithmetic a pure function of (state, now) and therefore testable
 * without a timer. Tokens are allowed to go NEGATIVE: that is what serialises
 * concurrent callers. If ten requests arrive at once, each takes one token from a
 * running debt and gets a distinct, increasing delay, instead of ten callers all
 * seeing "0 tokens" and all waking at the same instant to collide again.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity = CAPACITY,
    private readonly refillPerSec = REFILL_PER_SEC,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Claims one slot and returns how many ms to wait before using it. */
  reserve(now = Date.now()): number {
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.refillPerSec) / 1000);
    this.last = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    // Debt: wait until the bucket has refilled back up to this caller's slot.
    const deficit = 1 - this.tokens;
    this.tokens -= 1;
    return Math.ceil((deficit / this.refillPerSec) * 1000);
  }

  /** Test/diagnostic view. */
  available(now = Date.now()): number {
    const elapsed = Math.max(0, now - this.last);
    return Math.min(this.capacity, this.tokens + (elapsed * this.refillPerSec) / 1000);
  }
}

// --- backoff -----------------------------------------------------------------

/** Total attempts including the first, so 4 means at most 3 retries. */
export const KATANA_RETRY_ATTEMPTS = 4;

/**
 * Katana's 429 carries NO Retry-After header - verified against a real 429, whose
 * only headers were the CORS/expose set plus kp-request-id. So the backoff is
 * ours to choose, and it has to be chosen from the measured refill rate rather
 * than a generic default.
 *
 * A rate-limit retry therefore starts at a FULL second: the bucket needs ~1s to
 * refill, so a conventional 250ms first retry is guaranteed to draw a second 429
 * and merely spend an attempt. Transport faults start much lower because nothing
 * is throttling us - the request simply did not land.
 *
 * Equal jitter (half fixed, half random) on both: the fixed half stops a retry
 * from being effectively instantaneous, the random half stops several stalled
 * tabs from resynchronising into a burst that trips the limiter all over again.
 */
export const KATANA_BACKOFF_BASE_MS = { rateLimit: 1000, transport: 300 } as const;
export const KATANA_BACKOFF_CAP_MS = 8000;

export type BackoffKind = keyof typeof KATANA_BACKOFF_BASE_MS;

export function katanaBackoffMs(attempt: number, kind: BackoffKind, rand = Math.random()): number {
  const n = Math.max(1, Math.trunc(attempt));
  const ceiling = Math.min(KATANA_BACKOFF_CAP_MS, KATANA_BACKOFF_BASE_MS[kind] * 2 ** (n - 1));
  return Math.round(ceiling / 2 + rand * (ceiling / 2));
}

/**
 * Whether a failure is worth replaying.
 *
 * An ALLOW-list, matching the house rule already applied to SoDEX: anything
 * unrecognised is final. Only GETs reach this file, so a replay has no side
 * effect - but an unwarranted retry still burns rate-limit tokens shared with
 * every other tab and delays the error the trader needs to see.
 *
 * 429 and 5xx are transient. 4xx is not: a bad interval, an unknown market or a
 * limit out of range is deterministic, and replaying it reproduces it exactly.
 */
export function katanaRetryKind(err: unknown): BackoffKind | null {
  if (err instanceof KatanaApiError) {
    if (err.httpStatus === 429) return 'rateLimit';
    if (err.httpStatus >= 500) return 'transport';
    return null;
  }
  // No HTTP response at all: DNS, socket reset, or the request timeout. undici
  // reports network faults as TypeError('fetch failed').
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError'
      ? 'transport'
      : null;
  }
  return null;
}

// --- response cache ----------------------------------------------------------

/**
 * Short-TTL cache with in-flight coalescing.
 *
 * With a 4/s budget shared by every tab, two tabs polling tickers would otherwise
 * spend half of it on identical data. Coalescing matters more than the TTL: N
 * simultaneous callers collapse to one upstream request instead of N-1 of them
 * taking a 429.
 */
class TtlCache {
  private entries = new Map<string, { at: number; ttl: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();

  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const p = fn()
      .then((value) => {
        this.entries.set(key, { at: Date.now(), ttl: ttlMs, value });
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Per-path TTLs. Anything unlisted is uncached.
 *
 * The orderbook is deliberately absent: a stale ladder is a wrong ladder, and one
 * second of staleness on a book is a materially different screen. Markets are
 * cached hard because the symbol universe is 9 entries that change ~never.
 */
const CACHE_TTL: Array<[RegExp, number]> = [
  [/^\/v1\/markets/, 60_000],
  [/^\/v1\/exchange/, 60_000],
  [/^\/v1\/tickers/, 1_000],
  [/^\/v1\/candles/, 2_000],
];

const ttlFor = (path: string): number => CACHE_TTL.find(([re]) => re.test(path))?.[1] ?? 0;

// --- client ------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 20_000;

export class KatanaClient {
  private bucket = new TokenBucket();
  private cache = new TtlCache();

  constructor(private readonly base: string = KATANA_BASE) {}

  /** Cached, rate-limited, retried GET. The only verb this client has. */
  async get<T>(path: string): Promise<T> {
    const ttl = ttlFor(path);
    const run = () => this.request<T>(path);
    return ttl > 0 ? this.cache.wrap(path, ttl, run) : run();
  }

  private async request<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      // Every attempt pays its own token - a retry is a real extra request
      // against the shared budget, not a free replay.
      const wait = this.bucket.reserve();
      if (wait > 0) await sleep(wait);
      try {
        return await this.send<T>(path);
      } catch (err) {
        const kind = katanaRetryKind(err);
        if (attempt >= KATANA_RETRY_ATTEMPTS || kind === null) throw err;
        await sleep(katanaBackoffMs(attempt, kind));
      }
    }
  }

  /** One HTTP round trip. Owns neither budgeting nor retry. */
  private async send<T>(path: string): Promise<T> {
    const res = await fetch(this.base + path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new KatanaApiError(
        res.status,
        `non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
        path,
      );
    }

    if (!res.ok) throw katanaErrorFrom(res.status, parsed, path);

    // Katana returns bare JSON - no {code, data} envelope - so a 2xx body is the
    // payload itself. There is no "HTTP 200 with an error inside" case to guard
    // against here the way there is on SoDEX; an empty 200 body would be, and is
    // rejected rather than being handed on as a silently empty page.
    if (parsed === null) {
      throw new KatanaApiError(res.status, `empty body on HTTP ${res.status}`, path);
    }
    return parsed as T;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Map a Katana error body to an error.
 *
 * Two shapes are in play, verified live: `{code, message}` for validation and
 * rate-limit failures (`INVALID_PARAMETER`, `BAD_REQUEST`, `MARKET_NOT_FOUND`,
 * `EXCEEDED_RATE_LIMIT`) and Fastify's own `{statusCode, error, message}` for an
 * unrouted path. Both carry `message`, so that is what is trusted, with the
 * status as the fallback.
 */
export function katanaErrorFrom(status: number, body: unknown, path: string): KatanaApiError {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const message = typeof obj.message === 'string' && obj.message ? obj.message : `HTTP ${status}`;
  const code = typeof obj.code === 'string' ? obj.code : undefined;
  return new KatanaApiError(status, message, path, code);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const katana = new KatanaClient();
