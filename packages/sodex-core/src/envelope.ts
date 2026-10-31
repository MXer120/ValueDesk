/**
 * Response-envelope handling and request-budget facts, ported (pure parts
 * only) from Opentrade/server/src/sodex/rest.ts. No fetch lives here: the app's
 * transport calls `parseEnvelope(status, text, path)` on what it received.
 */

export interface Envelope<T> {
  code: number;
  data: T;
  timestamp: number;
}

export class SodexApiError extends Error {
  override name = 'SodexApiError';
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus: number,
    readonly path: string,
    readonly body?: unknown,
  ) {
    super(message);
  }

  /** Human-actionable hint, mapped from the documented failure modes. */
  get hint(): string | undefined {
    /*
     * "API key not found" is the venue saying the key this request was signed
     * with does not exist ON THEIR SIDE - revoked from another device, expired,
     * or belonging to an account that has since been rebuilt. It is NOT a
     * signing bug, and the generic 401 hint below sends people to check headers
     * and domains that are all fine. There is exactly one fix and it is worth
     * naming: enable trading again, which mints and registers a new key.
     */
    if (/api key not found|key not found|unknown api key/i.test(this.message)) {
      return 'This trading key is no longer registered on SoDEX. Enable trading again to mint a new one.';
    }
    if (this.httpStatus === 401 || this.code === 401) {
      return 'Signature rejected. Check: X-API-Key header present, signing domain matches the engine (futures vs spot), and the key is registered for this account.';
    }
    if (this.httpStatus === 429 || this.code === 429) return 'Rate limited - backing off.';
    if (/nonce/i.test(this.message)) {
      return 'Nonce must be a millisecond timestamp inside (now-2d, now+1d), unique, and above the lowest of the last 100 used.';
    }
    /*
     * An order naming a builder the account has not approved for that fee is
     * rejected with a 400 like any malformed payload - and the generic hint
     * below (trailing zeros, tick grid) then points away from the one thing
     * that is wrong: the approval was never given, was revoked, or is lower
     * than the fee on the order.
     */
    if (/builder/i.test(this.message)) {
      return 'SoDEX does not list an approval of this builder fee for the account (never approved, revoked, or approved for less). Approve the builder fee again, then place the order again.';
    }
    if (this.httpStatus === 400 || this.code === 400) {
      return 'Rejected payload. Common causes: trailing zeros in price/quantity, duplicate clOrdID, or a value outside the symbol tick/step grid.';
    }
    return undefined;
  }
}

/**
 * Parse one HTTP response into its `data`, or throw SodexApiError.
 *
 * An error envelope must never be readable as an empty page. Roughly one
 * history page in twelve comes back HTTP 200 with a body of
 * {"code":-1,"error":"internal server error: ..."} and no `data` at all. A
 * caller that unwraps a missing `data` to [] then sees an utterly ordinary
 * "no more rows" and stops paging - which is exactly how a 50-page walk
 * truncated in silence and reported a confidently wrong total.
 *
 * So a body is accepted only when it POSITIVELY asserts success. `code === 0`
 * is that assertion and is trusted on its own, because some endpoints pair it
 * with a cosmetic msg:"success" that must not be read as a failure. Without
 * it, two further tells are each fatal:
 *   - an error/message/msg string (an error envelope that omitted `code`)
 *   - no `data` property at all - not a recognisable envelope
 * A legitimately empty page, {code: 0, data: []}, trips none of them and comes
 * back as the empty array it genuinely is.
 *
 * A completely empty body on a 2xx is the gateway's bare ack for some writes.
 * It has never been observed on a read, so it stays `undefined` rather than
 * being promoted to an error: failing a cancel that actually succeeded is the
 * worse of the two mistakes.
 */
export function parseEnvelope<T>(httpStatus: number, text: string, path = ''): T {
  const ok = httpStatus >= 200 && httpStatus < 300;
  if (!text && ok) return undefined as T;

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new SodexApiError(-1, `non-JSON response (HTTP ${httpStatus}): ${text.slice(0, 200)}`, httpStatus, path);
  }

  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const env = obj as unknown as Envelope<T> & { message?: string; msg?: string; error?: string };
  const errText = env.error ?? env.message ?? env.msg;

  const asserted = env.code === 0;
  const failed =
    !ok ||
    (typeof env.code === 'number' && env.code !== 0) ||
    (!asserted && ((typeof errText === 'string' && errText !== '') || !('data' in obj)));

  if (failed) {
    const msg = errText ?? `HTTP ${httpStatus}`;
    throw new SodexApiError(typeof env.code === 'number' ? env.code : httpStatus, msg, httpStatus, path, parsed);
  }
  return env.data;
}

/** One entry of a batch order / cancel response (per-order `code`). */
export interface OrderResult {
  code: number;
  clOrdID: string;
  orderID?: number;
  error?: string;
}

/**
 * Per-order failures inside a successful envelope. The top-level `code` can be
 * 0 while individual orders were rejected; and a payload-level pre-validation
 * error is returned ONCE for the whole batch (docs), possibly duplicated.
 */
export const failedOrders = (results: readonly OrderResult[] | undefined | null): OrderResult[] =>
  (results ?? []).filter((r) => r && typeof r.code === 'number' && r.code !== 0);

/**
 * Normalise a list response to a bare array.
 *
 * The gateway is inconsistent: `orders`, `positions` and `balances` come wrapped
 * as `{blockTime, blockHeight, <name>: [...]}`, while `trades` and
 * `orders/history` are bare arrays. Callers that assumed "always an array" got a
 * silent empty list - which for cancel-all meant reporting success while
 * cancelling nothing.
 *
 * The [] fallback is only safe because `parseEnvelope` refuses to return a
 * body that does not positively assert success.
 */
export function unwrapList<T = unknown>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
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
const TRANSIENT_ENVELOPE_RE =
  /internal (server )?error|service unavailable|unavailable|timed? ?out|temporar|try again|too many requests|server busy|unexpected EOF|connection reset/i;

/**
 * Whether a failure is worth replaying - FOR READS ONLY.
 *
 * Deliberately an ALLOW-list. Anything unrecognised is final, because a missed
 * retry costs one visible error while an unwarranted retry ranges from wasted
 * weight to a duplicate fill. In particular no 4xx is ever transient: rejected
 * signatures, insufficient balance, off-grid prices, duplicate clOrdIDs and
 * stale nonces are all deterministic, so a replay reproduces them exactly while
 * burning budget and delaying the error the trader needs to see.
 *
 * NEVER replay a signed write on the strength of this: a nonce is one-shot, and
 * a timeout or a socket reset is NOT evidence that the matching engine never
 * saw the order - resending could double-fill.
 */
export function isTransientFailure(err: unknown): boolean {
  if (err instanceof SodexApiError) {
    // The gateway or an engine behind it is unhealthy; our payload is not implicated.
    if (err.httpStatus >= 500) return true;
    // Load shedding. Backing off is the documented response, not an error to surface.
    if (err.httpStatus === 429 || err.code === 429) return true;
    // A 2xx that still carried a non-zero code: the intermittent failure above.
    if (err.httpStatus < 400) return TRANSIENT_ENVELOPE_RE.test(err.message);
    return false;
  }
  // No HTTP response at all - DNS, socket reset, or an AbortSignal timeout.
  // Browsers and undici surface network faults as TypeError('Failed to fetch' /
  // 'fetch failed').
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError';
  }
  return false;
}

/** Documented endpoint weights (references/market-data.md, account-query.md). */
export function weightFor(path: string, limit = 0): number {
  if (/\/markets\/(symbols|tickers|bookTickers|coins|mark-prices)/.test(path)) return 2;
  if (/\/orderbook/.test(path)) return limit > 100 ? 10 : 5;
  if (/\/(klines|trades)/.test(path) && !/accounts/.test(path)) return 20;
  // 20 + limit/20 is measured, not guessed: limit 1 -> 20, 20 -> 21, 100 -> 25,
  // 200 -> 30, 500 -> 45, 1000 -> 70. It applies to every paged history endpoint,
  // but the alternation used to name the funding log `funding-history` - the path
  // the published table documents and which 404s. The live route is `/fundings`
  // (verified against testnet), so funding pages fell through to the flat 5
  // below: a limit=500 funding page was billed 5 instead of 45, quietly
  // overdrawing the shared 1200/min budget and inviting a 429 that looks like
  // it came from nowhere. `positions/history` scales identically and was missing
  // for the same reason. `funding-history` is kept in case the gateway ever
  // honours the documented spelling.
  if (/\/(orders\/history|trades|funding-history|fundings|positions\/history)/.test(path)) {
    return 20 + Math.floor(limit / 20);
  }
  if (/\/fee-rate/.test(path)) return 2;
  if (/\/accounts\//.test(path)) return 5;
  return 5;
}

/** Weight the gateway bills for a signed write. */
export const SIGNED_WRITE_WEIGHT = 1;
/**
 * REST budget per IP before SoDEX has said otherwise: the documented 1,200 a
 * minute. The gateway reports the real one on every answer (x-ratelimit-limit:
 * 6,000 on 2026-10-31), and the budgets adopt that (reportedRateLimit).
 */
export const REST_WEIGHT_PER_MINUTE = 1200;
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
 * SoDEX's x-ratelimit-* headers, read: null unless the limit is an integer in
 * REPORTED_LIMIT_MIN..MAX. `remaining` is kept only as an integer 0..limit.
 * (A browser sees neither unless the gateway exposes them to CORS: on
 * 2026-10-31 it exposes only Content-Length, so a browser keeps its default.)
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
