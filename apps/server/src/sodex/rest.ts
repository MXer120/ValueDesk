/**
 * SoDEX REST client: public reads, plus signed writes.
 *
 * Responsibilities that specifically belong on the server side:
 *  - Nonce monotonicity. Nonces must strictly increase per API key; only a single
 *    process can guarantee that. N browser tabs racing would collide.
 *  - Weight budgeting. The gateway allows a weight a minute per IP that every
 *    answer reports (6000 on 2026-10-31; the budget starts at the documented
 *    1200 and adopts the reported one). Every browser client shares this
 *    process's IP, so the budget is enforced here.
 *  - Holding the signing key. It never reaches the browser.
 */
import { NET, enginePath, type Engine } from '../config.js';
import { signExchangeAction, DomainName, type Hex } from '../signing/eip712.js';
import {
  COOL_BASE_MS,
  COOL_MAX_MS,
  COOL_WAIT_MAX_MS,
  GATEWAY_WEIGHT_PER_MIN,
  RETRY_ATTEMPTS,
  TRANSIENT_ENVELOPE_RE,
  endpointOf,
  reportedRateLimit,
  retryDelayMs,
  ttlFor,
  unbookedWeight,
  unwrapList,
  weightFor,
} from './restCore.js';

// The request POLICY (weights, cache lifetimes, retry and cooldown timings, list
// unwrapping) is pure and shared with the browser's gateway client: restCore.ts.
export { endpointOf, unwrapList, weightFor } from './restCore.js';

export interface Envelope<T> {
  code: number;
  data: T;
  timestamp: number;
}

/**
 * Raised locally when no signing key is loaded. Deliberately NOT a
 * SodexApiError: the gateway was never contacted, so the signature-verification
 * hint would be actively misleading.
 */
export class NotUnlockedError extends Error {
  readonly statusCode = 401;
  constructor(message = 'No signing key loaded. Unlock or create an API key first.') {
    super(message);
    this.name = 'NotUnlockedError';
  }
}

export class SodexApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus: number,
    readonly path: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'SodexApiError';
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
      return 'This machine’s trading key is no longer registered on SoDEX. Enable trading again to mint a new one.';
    }
    if (this.httpStatus === 401 || this.code === 401) {
      return 'Signature rejected. Check: X-API-Key header present, signing domain matches the engine (futures vs spot), and the key is registered for this account.';
    }
    if (this.httpStatus === 429 || this.code === 429) return 'Rate limited - backing off.';
    if (/nonce/i.test(this.message)) {
      return 'Nonce must be a millisecond timestamp inside (now-2d, now+1d) and strictly increasing.';
    }
    if (this.httpStatus === 400 || this.code === 400) {
      return 'Rejected payload. Common causes: trailing zeros in price/quantity, duplicate clOrdID, or a value outside the symbol tick/step grid.';
    }
    return undefined;
  }
}

// --- retry policy ------------------------------------------------------------

/** Weight the gateway bills for a signed write. */
const SIGNED_WEIGHT = 1;

export const isRateLimited = (err: unknown): boolean =>
  err instanceof SodexApiError && (err.httpStatus === 429 || err.code === 429);

/**
 * Whether a failure is worth replaying.
 *
 * Deliberately an ALLOW-list. Anything unrecognised is final, because a missed
 * retry costs one visible error while an unwarranted retry ranges from wasted
 * weight to a duplicate fill. In particular no 4xx is ever transient: rejected
 * signatures, insufficient balance, off-grid prices, duplicate clOrdIDs and
 * stale nonces are all deterministic, so a replay reproduces them exactly while
 * burning budget and delaying the error the trader needs to see.
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
  // No HTTP response at all - DNS, socket reset, or the 30s AbortSignal.timeout.
  // undici surfaces network faults as TypeError('fetch failed'). Safe to replay
  // only because this path is restricted to GETs (see `request`); for a write,
  // "no response" is not evidence that the engine did not act on it.
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError';
  }
  return false;
}

// --- weight budget -----------------------------------------------------------

export class WeightBudget {
  private used: Array<{ at: number; w: number }> = [];
  constructor(private limit = GATEWAY_WEIGHT_PER_MIN, private readonly windowMs = 60_000) {}

  /** Weight a minute now: what the gateway last reported, or the documented 1200 until it has. */
  get perMinute(): number {
    return this.limit;
  }

  /**
   * One gateway answer's x-ratelimit-* headers: the limit becomes the reported
   * one (a header that is not an integer in 600..60000 changes nothing), and
   * weight the IP spent beyond this window - the indexer, the executor's
   * neighbours, anything else behind this address - is booked as if it were
   * ours, so the next request waits instead of drawing a 429. Booking only
   * adds weight; it can never let more through than the limit.
   */
  learn(get: ((name: string) => string | null) | undefined, now = Date.now()): void {
    const r = reportedRateLimit(get);
    if (!r) return;
    this.limit = r.limit;
    const owed = unbookedWeight(r, this.spent(now));
    if (owed > 0) this.used.push({ at: now, w: owed });
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    while (this.used.length && this.used[0]!.at < cutoff) this.used.shift();
  }

  spent(now = Date.now()): number {
    this.prune(now);
    return this.used.reduce((n, u) => n + u.w, 0);
  }

  /** Weight spent elsewhere in this process (a read on another thread): it counts, and waits for nothing. */
  charge(w: number, now = Date.now()): void {
    this.used.push({ at: now, w });
  }

  /**
   * Resolves once there is room for `w`. Bounded, not infinite: it used to
   * say "never rejects; just delays," which is what let one exhausted budget
   * take the whole process down. Under sustained contention (heavy multi-tab
   * polling stacked with automated testing, both hitting this exact path)
   * every stalled caller becomes a live setTimeout loop that survives even
   * after its own HTTP request has been abandoned - this class has no wiring
   * back to the request, so it cannot know or care that nobody is listening
   * for the answer anymore. Enough of those accumulate and it is an unbounded
   * number of pending timers and closures, not a queue with a size - which is
   * a leak by construction, and is the most likely mechanism behind an actual
   * process crash observed under exactly this condition (budget pinned near
   * its ceiling for minutes, not draining, while response times climbed past
   * ten seconds).
   *
   * MAX_WAIT_MS rejects instead: a real error a caller can catch, log, and -
   * for the one path that matters most, `request()`'s retry loop - simply not
   * retry, rather than a loop this class can never be told to abandon.
   * Deliberately longer than the web client's own 20s fetch timeout (see
   * REQUEST_TIMEOUT_MS in web/src/api.ts): in the common case the BROWSER
   * gives up first and the user sees an honest error sooner, while this stays
   * a hard backstop for every caller that has no timeout of its own.
   */
  private static readonly MAX_WAIT_MS = 30_000;

  async take(w: number): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const now = Date.now();
      if (this.spent(now) + w <= this.limit) {
        this.used.push({ at: now, w });
        return;
      }
      if (now - startedAt >= WeightBudget.MAX_WAIT_MS) {
        throw new Error(
          `Request budget (${this.limit}/${this.windowMs / 1000}s) stayed exhausted for ` +
            `${WeightBudget.MAX_WAIT_MS / 1000}s - giving up rather than waiting indefinitely.`,
        );
      }
      const oldest = this.used[0];
      const wait = oldest ? Math.max(25, oldest.at + this.windowMs - now) : 25;
      await new Promise((r) => setTimeout(r, Math.min(wait, 2000)));
    }
  }
}

// --- response cache ----------------------------------------------------------

/**
 * Short TTL cache. Market data that many browser tabs poll (symbols, tickers)
 * would otherwise burn the shared weight budget. Also coalesces concurrent
 * identical requests into one upstream call.
 */
/** Bounded (security audit S-17): /klines paths carry caller-chosen times. */
const TTL_CACHE_MAX = 2_000;

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
        this.entries.delete(key);
        this.entries.set(key, { at: Date.now(), ttl: ttlMs, value });
        this.prune();
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  /** Expired entries first, then the oldest, down to TTL_CACHE_MAX. */
  private prune(): void {
    if (this.entries.size <= TTL_CACHE_MAX) return;
    const now = Date.now();
    for (const [k, v] of this.entries) if (now - v.at >= v.ttl) this.entries.delete(k);
    for (const k of this.entries.keys()) {
      if (this.entries.size <= TTL_CACHE_MAX) break;
      this.entries.delete(k);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

// --- signing session ---------------------------------------------------------

export interface SigningSession {
  privateKey: Uint8Array;
  apiKeyName: string;
  accountId: number;
  address: string;
  keyAddress: string;
  permissions: number;
  /**
   * Unix SECONDS, 0 = never. Mirrors what the gateway was told at registration.
   *
   * Enforced locally as well as upstream so an expired key fails with something
   * a user can act on ("your trading session expired, enable it again") instead
   * of the opaque 401 the gateway returns, which is indistinguishable from a
   * signing bug.
   */
  expiresAt?: number;
}

/** Public, non-secret projection of a session. Never carries `privateKey`. */
export interface SessionInfo {
  apiKeyName: string;
  accountId: number;
  address: string;
  keyAddress: string;
  permissions: number;
  /** True for the account that unspecified requests act as. */
  active: boolean;
  /** Unix seconds; 0/undefined = no expiry. */
  expiresAt?: number;
  /** Whole seconds until expiry, or null when it never expires. */
  secondsLeft?: number | null;
}

/** Addresses key the session map, so they normalise in exactly one place. */
const addrKey = (address: string): string => address.trim().toLowerCase();

// --- client ------------------------------------------------------------------

/**
 * ONE instance serves every unlocked account, deliberately.
 *
 * The budget, the response cache and the nonce counter are all per-instance and
 * all of them are really per-IP or per-process facts, not per-account ones:
 *  - the gateway's weight a minute is billed per IP, and every account here
 *    shares this process's IP, so a second client would fork the budget into two
 *    halves that each believe they have the whole allowance;
 *  - the market-data cache is account-independent, and duplicating it would
 *    double the upstream polling it exists to prevent;
 *  - the nonce counter is a globally monotone sequence. Monotone in the whole
 *    sequence implies monotone in each account's subsequence, so one counter is
 *    already correct for N keys - and cheaper than reasoning about N counters.
 */
export class SodexClient {
  private budget = new WeightBudget();
  private cache = new TtlCache();
  /**
   * RATE-LIMIT COOLDOWN. SoDEX's Cloudflare answers an IP that asked too much
   * with 429 ("error code: 1015") for EVERY path, and replaying into it (four
   * retries per read, from every caller at once) is what keeps the ban alive.
   * So a 429 is never retried: it opens a cooldown - 15 s, doubling to 5 min
   * while 429s keep coming, reset by the next success - and until it ends no
   * request leaves. A caller that would wait longer than COOL_WAIT_MAX_MS fails
   * at once with a 429 (the UI shows "couldn't load" + Retry) instead of
   * queueing into the ban.
   */
  private cool = new Map<string, { until: number; ms: number }>();

  /** Weight spent in the current window - background walks yield above half of it. */
  budgetSpent(): number {
    return this.budget.spent();
  }

  /**
   * ms until SoDEX's rate limit on `path`'s endpoint has cooled down (0 = not
   * limited); with no path, the longest cooldown running. The limit is per
   * endpoint in practice (/trades and /orders/history can be limited while
   * /positions/history answers), so one endpoint's 429 does not stop the rest.
   */
  cooldownLeft(path?: string): number {
    const now = Date.now();
    if (path !== undefined) return Math.max(0, (this.cool.get(endpointOf(path))?.until ?? 0) - now);
    let left = 0;
    for (const c of this.cool.values()) left = Math.max(left, c.until - now);
    return left;
  }
  private lastNonce = 0n;
  /** Unlocked accounts, keyed by lowercased master wallet address. */
  private sessions = new Map<string, SigningSession>();
  /** Which account unspecified requests act as. */
  private active: string | null = null;

  constructor(private readonly base: string = NET.restBase, private readonly chainId: number = NET.chainId) {}

  // -- sessions -------------------------------------------------------------

  /** Unlock an account (or replace its session) and make it the active one. */
  addSession(s: SigningSession): void {
    const key = addrKey(s.address);
    this.sessions.set(key, s);
    this.active = key;
  }

  /**
   * Back-compatible single-account entry point.
   *
   * `setSession(null)` locks the ACTIVE account only, which is what its one
   * historical meaning ("lock the session") reduces to when there is exactly one.
   * Callers that mean "lock everything" must say `lockAll()`.
   */
  setSession(s: SigningSession | null): void {
    if (s) this.addSession(s);
    else if (this.active) this.lockAccount(this.active);
  }

  /** Lock one account. Returns false if it was not unlocked. */
  lockAccount(address: string): boolean {
    const key = addrKey(address);
    if (!this.sessions.delete(key)) return false;
    // Promote an arbitrary survivor rather than leaving `active` dangling: a null
    // active with sessions still held would read as "locked" everywhere.
    if (this.active === key) this.active = this.sessions.keys().next().value ?? null;
    return true;
  }

  lockAll(): void {
    this.sessions.clear();
    this.active = null;
  }

  /** Returns false when that account is not unlocked, so callers can 404. */
  setActiveAddress(address: string): boolean {
    const key = addrKey(address);
    if (!this.sessions.has(key)) return false;
    this.active = key;
    return true;
  }

  get activeAddress(): string | null {
    return this.active;
  }

  /** True when at least one account is unlocked. */
  get isUnlocked(): boolean {
    return this.sessions.size > 0;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(address: string): boolean {
    return this.sessions.has(addrKey(address));
  }

  /**
   * The session to sign with. `address` names one explicitly; omitting it uses
   * the active account, which is what the pre-multi-account call sites do.
   */
  requireSession(address?: string): SigningSession {
    const key = address ? addrKey(address) : this.active;
    const s = key ? this.sessions.get(key) : undefined;
    if (!s) {
      throw new NotUnlockedError(
        address
          ? `No signing key loaded for ${address}. Unlock that account first.`
          : undefined,
      );
    }
    return s;
  }

  /**
   * Resolve what to sign with.
   *
   * An explicit SigningSession is used verbatim and is NOT looked up in - or
   * added to - the session map. That is what lets a just-in-time elevated key
   * (see elevation.ts) sign one money movement without ever being persisted,
   * without displacing the resting trade-only key for the same address, and
   * without becoming reachable through the ordinary `requireSession` path that
   * every other route uses.
   */
  private resolveSession(target?: string | SigningSession): SigningSession {
    const s = target && typeof target === 'object' ? target : this.requireSession(target);
    // `expiresAt` is a millisecond timestamp - comparing it against seconds
    // here would have judged every live key expired the moment the unit was
    // fixed, which is a worse failure than the one it replaced.
    if (s.expiresAt && s.expiresAt <= Date.now()) {
      // Drop it rather than only refusing: a key the gateway will reject is not
      // worth keeping in memory, and leaving it there would make every
      // subsequent request fail the same way with no path to recovery.
      this.lockAccount(s.address);
      throw new NotUnlockedError(
        'Your trading session expired. Enable trading again to get a new 24-hour key.',
      );
    }
    return s;
  }

  private info(key: string, s: SigningSession): SessionInfo {
    const { apiKeyName, accountId, address, keyAddress, permissions, expiresAt } = s;
    return {
      apiKeyName, accountId, address, keyAddress, permissions,
      active: key === this.active,
      expiresAt,
      secondsLeft: expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : null,
    };
  }

  /** Public, non-secret view of one session (default: the active one). */
  sessionInfo(address?: string): SessionInfo | null {
    const key = address ? addrKey(address) : this.active;
    const s = key ? this.sessions.get(key) : undefined;
    return s && key ? this.info(key, s) : null;
  }

  /** Public view of every unlocked account. */
  sessionList(): SessionInfo[] {
    return [...this.sessions].map(([key, s]) => this.info(key, s));
  }

  /**
   * Millisecond timestamp, forced strictly increasing.
   * Mirrors client.go's `nonce()`.
   *
   * One counter across all accounts. The gateway requires increasing nonces PER
   * API key, and a sequence that strictly increases overall strictly increases in
   * every subsequence, so interleaving accounts cannot produce a stale nonce.
   */
  private nextNonce(): bigint {
    const ts = BigInt(Date.now());
    this.lastNonce = ts > this.lastNonce ? ts : this.lastNonce + 1n;
    return this.lastNonce;
  }

  // -- transport ------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      weight?: number;
      /** The caller already reserved this request's weight - see `signed`. */
      weightReserved?: boolean;
    } = {},
  ): Promise<T> {
    const weight = opts.weight ?? weightFor(path);

    // Only GETs are ever replayed. A signed write carries a one-shot nonce, and a
    // timeout or a socket reset is NOT evidence that the matching engine never saw
    // the order - resending could double-fill. `relay` posts a wallet-signed
    // API-key action, equally one-shot. A read has no side effect at all, which is
    // the whole reason it is safe to repeat.
    const attempts = method === 'GET' ? RETRY_ATTEMPTS : 1;

    for (let attempt = 1; ; attempt++) {
      const cool = this.cooldownLeft(path);
      if (cool > COOL_WAIT_MAX_MS) throw new SodexApiError(429, 'Rate limited - backing off.', 429, path);
      if (cool > 0) await new Promise((r) => setTimeout(r, cool));
      // Every attempt pays its own weight - a retry is a real extra request against
      // the shared per-minute budget. The first attempt of a signed write skips this
      // because `signed` deliberately reserved the weight before taking its nonce.
      if (attempt > 1 || !opts.weightReserved) await this.budget.take(weight);
      try {
        const out = await this.send<T>(method, path, opts);
        this.cool.delete(endpointOf(path));
        return out;
      } catch (err) {
        if (isRateLimited(err)) {
          const key = endpointOf(path);
          const prev = this.cool.get(key);
          const ms = Math.min(COOL_MAX_MS, prev ? prev.ms * 2 : COOL_BASE_MS);
          this.cool.set(key, { until: Math.max(prev?.until ?? 0, Date.now() + ms), ms });
          throw err;
        }
        if (attempt >= attempts || !isTransientFailure(err)) throw err;
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
      }
    }
  }

  /** One HTTP round trip. Owns neither budgeting nor retry - `request` does both. */
  private async send<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> },
  ): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      // Pre-serialised by the caller so the signed bytes and the sent bytes are identical.
      body: opts.body === undefined ? undefined : (opts.body as string),
      signal: AbortSignal.timeout(30_000),
    });

    // Every answer (a 429 too) carries the IP's limit and what is left of it.
    this.budget.learn((name) => res.headers.get(name));
    const text = await res.text();

    // A completely empty body on a 2xx is the gateway's bare ack for some writes.
    // It has never been observed on a read, so it stays `undefined` rather than
    // being promoted to an error: failing a cancel that actually succeeded is the
    // worse of the two mistakes.
    if (!text && res.ok) return undefined as T;

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new SodexApiError(-1, `non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status, path);
    }

    const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const env = obj as unknown as Envelope<T> & { message?: string; msg?: string; error?: string };
    const errText = env.error ?? env.message ?? env.msg;

    /*
     * An error envelope must never be readable as an empty page.
     *
     * Roughly one history page in twelve comes back HTTP 200 with a body of
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
     */
    const asserted = env.code === 0;
    const failed =
      !res.ok ||
      (typeof env.code === 'number' && env.code !== 0) ||
      (!asserted && ((typeof errText === 'string' && errText !== '') || !('data' in obj)));

    if (failed) {
      const msg = errText ?? `HTTP ${res.status}`;
      throw new SodexApiError(typeof env.code === 'number' ? env.code : res.status, msg, res.status, path, parsed);
    }
    return env.data;
  }

  /** Public GET, cached and weight-budgeted. */
  async get<T>(path: string, weight?: number): Promise<T> {
    const ttl = ttlFor(path);
    const run = () => this.request<T>('GET', path, { weight });
    return ttl > 0 ? this.cache.wrap(path, ttl, run) : run();
  }

  /**
   * Signed write.
   *
   * The body is serialised ONCE by the signer and that exact string is sent, so
   * the bytes the gateway hashes are the bytes we signed. Re-serialising here
   * would risk a divergence.
   *
   * `address` names which unlocked account signs. Omitted, it is the active one -
   * the behaviour every existing call site relies on.
   */
  private async signed<T>(
    method: 'POST' | 'DELETE',
    engine: Engine,
    path: string,
    actionType: string,
    params: unknown,
    target?: string | SigningSession,
  ): Promise<T> {
    // Resolved BEFORE the budget wait below, so a switch of the active account
    // mid-wait cannot redirect an in-flight write to a different key. The nonce
    // still comes after that wait - see the comment there.
    const s = this.resolveSession(target);
    const domain = engine === 'spot' ? DomainName.spot : DomainName.perps;
    const { goJSONStringify } = await import('../signing/eip712.js');

    /*
     * The nonce is allocated LAST, after everything that can suspend.
     *
     * Nonces must reach the gateway in increasing order per API key, and
     * `nextNonce` hands them out in call order - so the two orders agree only if
     * nothing can reorder callers between allocation and transmission.
     * `WeightBudget.take` is not a queue: it is an independent polling loop per
     * caller, and when the budget is saturated the waiters wake in whatever order
     * their individual timers happen to fire, not in the order they arrived.
     * Allocating first therefore allowed the write holding nonce N to leave after
     * the write holding N+1, and the gateway rejects the lower one as stale.
     *
     * Reserving the weight before allocating closes the window: from here down to
     * `fetch` there is no `await` (`goJSONStringify` and `signExchangeAction` are
     * synchronous, and `request` skips its own `budget.take` via `weightReserved`),
     * so the order `nextNonce` imposes is the order on the wire.
     */
    await this.budget.take(SIGNED_WEIGHT);
    const nonce = this.nextNonce();
    const bodyString = goJSONStringify(params);
    const signature: Hex = signExchangeAction(domain, this.chainId, actionType, params, nonce, s.privateKey);

    return this.request<T>(method, enginePath(engine) + path, {
      body: bodyString,
      weight: SIGNED_WEIGHT,
      weightReserved: true,
      headers: {
        'X-API-Sign': signature,
        'X-API-Nonce': nonce.toString(),
        'X-API-Chain': String(this.chainId),
        // The single most common cause of 401s if omitted.
        'X-API-Key': s.apiKeyName,
      },
    });
  }

  post<T>(engine: Engine, path: string, actionType: string, params: unknown, target?: string | SigningSession): Promise<T> {
    return this.signed<T>('POST', engine, path, actionType, params, target);
  }

  del<T>(engine: Engine, path: string, actionType: string, params: unknown, target?: string | SigningSession): Promise<T> {
    return this.signed<T>('DELETE', engine, path, actionType, params, target);
  }

  /**
   * Unsigned POST - used for the wallet-signed API-key flow, where the browser
   * wallet produced the signature and we merely relay it.
   */
  relay<T>(path: string, body: unknown, headers: Record<string, string>): Promise<T> {
    return this.request<T>('POST', path, {
      body: JSON.stringify(body),
      weight: 1,
      headers,
    });
  }

  weightSpent(): number {
    return this.budget.spent();
  }

  /** Weight spent on this gateway outside this client (a read on another thread). */
  chargeWeight(w: number): void {
    this.budget.charge(w);
  }

  /** The gateway's weight a minute for this IP, as it last reported it (1200 before its first answer). */
  weightLimit(): number {
    return this.budget.perMinute;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const sodex = new SodexClient();
