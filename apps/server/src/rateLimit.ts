/**
 * Rate limits for state-changing requests.
 *
 * The local API is already gated by origin and token, so this is not a defence
 * against an anonymous flood - it is a blast-radius limit for the case where
 * something legitimate-looking goes wrong or hostile: a compromised tab, a
 * runaway loop in our own code, or a script that got hold of the token. Without
 * a cap, any of those can empty a rate-limit budget at the exchange, spam the
 * order book, or burn the account's fee tier before anyone notices.
 *
 * Deliberately generous for a human. A person clicking Buy as fast as they can
 * manage will not reach 300 writes a minute; a loop reaches it in under a
 * second. Money movement is far tighter because each one is supposed to cost a
 * wallet signature - more than a handful a minute means something is wrong.
 *
 * Fixed windows rather than a token bucket: this needs to be obviously correct
 * and cheap, and the imprecision at a window boundary does not matter when the
 * limit is 20x a plausible human rate.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

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
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    return null;
  }
  if (b.count < limit.max) {
    b.count += 1;
    return null;
  }
  return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
}

/** Which limit class a path falls into. Money is a subset of writes. */
export function classify(path: string): Array<{ key: string; limit: Limit }> {
  const out = [{ key: 'write', limit: WRITE_LIMIT }];
  if (path.startsWith('/api/money/')) out.push({ key: 'money', limit: MONEY_LIMIT });
  return out;
}

/** Test seam. */
export function reset(): void {
  buckets.clear();
}
