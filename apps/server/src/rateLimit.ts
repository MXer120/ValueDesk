/**
 * Rate limits.
 *
 * LOCAL MODE (the default). The local API is already gated by origin and token,
 * so this is not a defence against an anonymous flood - it is a blast-radius
 * limit for the case where something legitimate-looking goes wrong or hostile:
 * a compromised tab, a runaway loop in our own code, or a script that got hold
 * of the token. Without a cap, any of those can empty a rate-limit budget at
 * the exchange, spam the order book, or burn the account's fee tier before
 * anyone notices.
 *
 * Deliberately generous for a human. A person clicking Buy as fast as they can
 * manage will not reach 300 writes a minute; a loop reaches it in under a
 * second. Money movement is far tighter because each one is supposed to cost a
 * wallet signature - more than a handful a minute means something is wrong.
 *
 * HOSTED MODE (VALUESCAN_HOSTED=1, see hosted.ts). The public index API is
 * anonymous, so there the same fixed windows are kept PER CLIENT: `KeyedLimiter`
 * holds one bucket per (class, client) and bounds its own memory, because on a
 * public server the set of keys is chosen by whoever is sending requests.
 *
 * Fixed windows rather than a token bucket: this needs to be obviously correct
 * and cheap, and the imprecision at a window boundary does not matter when the
 * limit is far above a plausible human rate.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Fixed-window counters under arbitrary keys, with bounded memory.
 *
 * Expired buckets are swept at most once per `sweepEveryMs`, so the map holds
 * roughly the keys seen in the last window. If it still reaches `maxKeys` (an
 * address flood), the OLDEST key is evicted rather than the new one refused:
 * an evicted client merely starts a fresh window, which fails open for that
 * one client instead of failing closed for everyone.
 */
export class KeyedLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private readonly maxKeys = 100_000,
    private readonly sweepEveryMs = 60_000,
  ) {}

  /** Null when allowed, else the whole seconds to wait. */
  take(key: string, limit: Limit, now = Date.now()): number | null {
    if (now - this.lastSweep >= this.sweepEveryMs) this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      if (!b && this.buckets.size >= this.maxKeys) {
        this.sweep(now);
        if (this.buckets.size >= this.maxKeys) {
          const oldest = this.buckets.keys().next().value;
          if (oldest !== undefined) this.buckets.delete(oldest);
        }
      }
      // Re-inserted so Map order stays "oldest window first" for eviction.
      this.buckets.delete(key);
      this.buckets.set(key, { count: 1, resetAt: now + limit.windowMs });
      return null;
    }
    if (b.count < limit.max) {
      b.count += 1;
      return null;
    }
    return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  }

  /** Drop every bucket whose window has ended. */
  sweep(now = Date.now()): void {
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now >= b.resetAt) this.buckets.delete(k);
  }

  clear(): void {
    this.buckets.clear();
    this.lastSweep = 0;
  }

  get size(): number {
    return this.buckets.size;
  }
}

const local = new KeyedLimiter();

/** Writes overall: high enough that no human, and no normal UI, will notice. */
export const WRITE_LIMIT: Limit = { max: 300, windowMs: 60_000 };
/** Money movement: each is meant to cost a wallet signature. */
export const MONEY_LIMIT: Limit = { max: 12, windowMs: 60_000 };

/**
 * Returns null when allowed, or the seconds to wait when not.
 * `key` scopes the counter - one per limit class, not per caller, because on
 * loopback there is only ever one caller worth distinguishing.
 */
export function take(key: string, limit: Limit): number | null {
  return local.take(key, limit);
}

/**
 * Which limit class a path falls into. Money is a subset of writes.
 *
 * Pass the MATCHED ROUTE PATTERN (`req.routeOptions.url`) where there is one:
 * the router matches percent-decoded paths, so the raw URL of
 * `/api/%6Doney/withdraw` would otherwise escape the money class.
 */
export function classify(path: string): Array<{ key: string; limit: Limit }> {
  const out = [{ key: 'write', limit: WRITE_LIMIT }];
  if (path.startsWith('/api/money/')) out.push({ key: 'money', limit: MONEY_LIMIT });
  return out;
}

/** Test seam. */
export function reset(): void {
  local.clear();
}
