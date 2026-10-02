/**
 * Request dedupe and short-lived answers, per tab.
 *
 * Several panels ask for the same thing at once (the order book's REST seed,
 * three account panels reading one wallet's state, a profile and its fills on
 * the same address). Identical concurrent reads share one request; an answer
 * is reused for its TTL; a failure is never cached, so the next caller tries
 * again. `lastGood` keeps the newest answer per key after its TTL for callers
 * that prefer a known-stale page to "couldn't load" (history pages).
 */

interface Hit {
  at: number;
  value: unknown;
}

export class RequestGate {
  private fresh = new Map<string, Hit>();
  private inflight = new Map<string, Promise<unknown>>();
  private good = new Map<string, Hit>();

  constructor(
    private readonly maxEntries = 1_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The cached answer for `key` if younger than `ttlMs`, else the in-flight
   * request for it, else a new `load()` (shared with anyone asking meanwhile).
   * `ttlMs` 0 still dedupes concurrent calls. `keep: false` leaves the answer
   * out of `lastGood` (a bulk read nobody will fall back to, like a history walk page).
   *
   * `lane` separates callers that must not wait on each other's request (a
   * read with another place in a queue): only the request in flight is per
   * lane. The answer and the last good copy are the key's, whoever read it.
   */
  run<T>(key: string, ttlMs: number, load: () => Promise<T>, keep = true, lane = ''): Promise<T> {
    if (ttlMs > 0) {
      const hit = this.fresh.get(key);
      if (hit && this.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
    }
    const flight = lane ? `${key} #${lane}` : key;
    const running = this.inflight.get(flight);
    if (running) return running as Promise<T>;
    const p = load()
      .then((value) => {
        const hit = { at: this.now(), value };
        if (ttlMs > 0) this.remember(this.fresh, key, hit);
        if (keep) this.remember(this.good, key, hit);
        return value;
      })
      .finally(() => this.inflight.delete(flight));
    this.inflight.set(flight, p);
    return p;
  }

  /** The newest successful answer for `key`, however old, with when it was read. */
  lastGood<T>(key: string): { at: number; value: T } | null {
    const hit = this.good.get(key);
    return hit ? { at: hit.at, value: hit.value as T } : null;
  }

  /** Forget cached answers whose key starts with `prefix` (a write just changed them). */
  forget(prefix: string): void {
    for (const k of [...this.fresh.keys()]) if (k.startsWith(prefix)) this.fresh.delete(k);
  }

  get size(): number {
    return this.fresh.size;
  }

  private remember(map: Map<string, Hit>, key: string, hit: Hit): void {
    map.delete(key);
    map.set(key, hit);
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
