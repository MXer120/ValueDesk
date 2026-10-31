/**
 * The SoDEX gateway's request POLICY, pure: weights, cache lifetimes, retry
 * and cooldown timings, list unwrapping.
 *
 * Shared by the server's client (sodex/rest.ts, which re-exports all of it) and
 * the browser's own gateway client (apps/web/src/exchange/sodex), so a request
 * is billed, cached and backed off the same way whichever side sends it. No
 * fetch, no Node, no DOM here.
 */

/**
 * The gateway's REST budget per IP before it has said otherwise: the documented
 * 1200 weight a minute. Every answer reports the real one (x-ratelimit-limit:
 * 6000 on 2026-10-31), and the budgets adopt it (reportedRateLimit) - this is
 * only where they start, and what they keep when a header is missing.
 */
export const GATEWAY_WEIGHT_PER_MIN = 1200;
export const GATEWAY_WINDOW_MS = 60_000;
/** A reported limit outside this range is a broken header, not a new limit. */
export const REPORTED_LIMIT_MIN = 600;
export const REPORTED_LIMIT_MAX = 60_000;

/** What one gateway answer says about the per-IP budget. */
export interface ReportedRateLimit {
  /** Weight per minute per IP (x-ratelimit-limit). */
  limit: number;
  /** Weight the IP has left this minute (x-ratelimit-remaining), null when absent or unreadable. */
  remaining: number | null;
}

/**
 * The gateway's x-ratelimit-* headers, read: null unless the limit is an
 * integer in REPORTED_LIMIT_MIN..MAX; `remaining` is kept only as an integer
 * 0..limit. The copy engine has the same reader (sodex-core envelope.ts).
 *
 * A browser sees neither header unless the gateway exposes them to CORS: on
 * 2026-10-31 it exposes only Content-Length, so the browser's budget keeps
 * GATEWAY_WEIGHT_PER_MIN until that changes.
 */
export function reportedRateLimit(get: ((name: string) => string | null | undefined) | undefined): ReportedRateLimit | null {
  if (!get) return null;
  const int = (raw: string | null | undefined): number | null => {
    const s = (raw ?? '').trim();
    return /^\d{1,7}$/.test(s) ? Number(s) : null;
  };
  const limit = int(get('x-ratelimit-limit'));
  if (limit === null || limit < REPORTED_LIMIT_MIN || limit > REPORTED_LIMIT_MAX) return null;
  const rem = int(get('x-ratelimit-remaining'));
  return { limit, remaining: rem !== null && rem <= limit ? rem : null };
}

/**
 * Weight others on the IP spent that a budget has not booked yet: what SoDEX
 * says the IP spent this minute (limit - remaining) beyond everything in the
 * budget's own window (`spent`, earlier bookings included). Never negative.
 * SoDEX's minute resets on the clock while a budget's window slides, so the
 * window holds at least SoDEX's minute: this can under-book, never over-free.
 */
export function unbookedWeight(r: ReportedRateLimit, spent: number): number {
  if (r.remaining === null) return 0;
  return Math.max(0, Math.min(r.limit, r.limit - r.remaining - spent));
}

/**
 * Normalise a list response to a bare array.
 *
 * The gateway is inconsistent: `orders`, `positions` and `balances` come wrapped
 * as `{blockTime, blockHeight, <name>: [...]}`, while `trades` and
 * `orders/history` are bare arrays. Callers that assumed "always an array" got a
 * silent empty list - which for cancel-all meant reporting success while
 * cancelling nothing.
 *
 * The [] fallback is only safe because the transport refuses to return a body
 * that does not positively assert success. Reached with an error envelope,
 * this function would turn a failed page into an indistinguishable empty one.
 */
export function unwrapList<T = unknown>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

// --- retry policy ------------------------------------------------------------

/**
 * Total attempts, the first one included, so 4 means at most 3 retries.
 *
 * Sized against the observed failure: roughly 8% of history pages come back HTTP
 * 200 with an error envelope. Untreated that is a ~98% chance of losing at least
 * one page somewhere in a 50-page walk. Four attempts drops the per-page loss
 * rate to ~0.004%, i.e. ~0.2% across the same walk, for a worst case of ~1.75s of
 * added latency - well inside the 30s request timeout.
 */
export const RETRY_ATTEMPTS = 4;
export const RETRY_BASE_MS = 250;
export const RETRY_CAP_MS = 4_000;

/** A rate-limit cooldown: 15 s, doubling to 5 min; callers wait at most 8 s for one to end. */
export const COOL_BASE_MS = 15_000;
export const COOL_MAX_MS = 5 * 60_000;
export const COOL_WAIT_MAX_MS = 8_000;

/** `/api/v1/perps/accounts/0xabc…/trades?limit=5` -> `/api/v1/perps/accounts/{a}/trades`. */
export const endpointOf = (path: string): string =>
  path.replace(/\?.*$/, '').replace(/0x[0-9a-fA-F]{40}/g, '{a}').replace(/\/\d+(?=\/|$)/g, '/{n}');

/**
 * Exponential backoff with equal jitter: half of each window is fixed so a retry
 * is never effectively instantaneous, half is random so several stalled callers
 * do not resynchronise into a thundering herd against an already-sick gateway.
 */
export function retryDelayMs(attempt: number, rand = Math.random()): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return ceiling / 2 + rand * (ceiling / 2);
}

/**
 * Envelope text that means "the gateway had a bad minute" rather than "your
 * request was wrong". Only ever matched against an HTTP-200-with-error-envelope
 * body, which is how SoDEX reports the intermittent history failure:
 *
 *   {"code":-1,"error":"internal server error: invalid character 'R'..."}
 *
 * The stray 'R' is an upstream non-JSON error page leaking into a JSON decode -
 * unambiguously an upstream fault and not a property of anything we sent, which
 * is exactly why replaying the identical request usually works.
 */
export const TRANSIENT_ENVELOPE_RE =
  /internal (server )?error|service unavailable|unavailable|timed? ?out|temporar|try again|too many requests|server busy|unexpected EOF|connection reset/i;

// --- weight budget -----------------------------------------------------------

/** Documented endpoint weights (references/market-data.md, account-query.md). */
export function weightFor(path: string, limit = 0): number {
  if (/\/markets\/(symbols|tickers|bookTickers|coins|mark-prices)/.test(path)) return 2;
  if (/\/orderbook/.test(path)) return limit > 100 ? 10 : 5;
  if (/\/(klines|trades)/.test(path) && !/accounts/.test(path)) return 20;
  // 20 + limit/20 is measured, not guessed: limit 1 -> 20, 20 -> 21, 100 -> 25,
  // 200 -> 30, 500 -> 45, 1000 -> 70. It applies to every paged history endpoint,
  // but the alternation used to name the funding log `funding-history` - the path
  // the published table documents and which 404s. The live route is `/fundings`
  // (see routes/account.ts, verified against testnet), so funding pages fell
  // through to the flat 5 below: a limit=500 funding page was billed 5 instead of
  // 45, quietly overdrawing the shared per-minute budget and inviting a 429 that
  // looks like it came from nowhere. `positions/history` scales identically and
  // was missing for the same reason. `funding-history` is kept in case the
  // gateway ever honours the documented spelling.
  if (/\/(orders\/history|trades|funding-history|fundings|positions\/history)/.test(path)) {
    return 20 + Math.floor(limit / 20);
  }
  if (/\/fee-rate/.test(path)) return 2;
  if (/\/accounts\//.test(path)) return 5;
  return 5;
}

/** The `limit` a gateway path asks for, 0 when it names none. */
export function limitOf(path: string): number {
  const m = /[?&]limit=(\d+)/.exec(path);
  return m ? Number(m[1]) : 0;
}

// --- response cache ----------------------------------------------------------

/** Per-path cache TTLs. Anything not listed is uncached. */
export const CACHE_TTL: ReadonlyArray<readonly [RegExp, number]> = [
  [/\/markets\/symbols/, 60_000],
  [/\/markets\/coins/, 60_000],
  [/\/markets\/tickers/, 1_000],
  [/\/markets\/bookTickers/, 1_000],
  [/\/markets\/mark-prices/, 1_000],
  [/\/klines/, 2_000],
];

export const ttlFor = (path: string): number => CACHE_TTL.find(([re]) => re.test(path))?.[1] ?? 0;
