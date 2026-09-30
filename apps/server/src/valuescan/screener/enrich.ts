/**
 * Background enrichment for the screener: win rate, trade count, last fill,
 * drawdown and open positions, which no venue's leaderboard carries.
 *
 * ONE PROFILE AT A TIME, PER VENUE, AT A WALKING PACE. Each venue has its own
 * Enricher that reads `provider.trader(address)` for one trader every
 * `intervalMs`, walking a bounded target list (the top of the pool). A read is
 * expensive - about 145 Hyperliquid weight (fills sample + portfolio + states),
 * or a dozen SoDEX calls including one history endpoint, the kind Cloudflare
 * rate-limited this IP for - so:
 *   - the pace is fixed and slow (see screener.ts for the numbers per venue);
 *   - a `gate` is asked before every read, and a "no" skips the turn. The
 *     venues' gates look at the shared budgets (HL weight bucket, SoDEX
 *     cooldown and data-host backlog), so interactive pages always win;
 *   - a failure backs that trader off exponentially, and a rate-limit answer
 *     pauses the whole venue for `pauseMs`;
 *   - the loop only runs while someone is using the screener: it stops
 *     `idleStopMs` after the last request and restarts on the next one.
 *
 * NEVER ON THE REQUEST PATH. `demand()` only records targets and makes sure the
 * loop is scheduled; a request reads whatever is cached right now. Entries are
 * served however old they are (stale-while-refresh: the loop re-reads entries
 * older than `ttlMs`, oldest first, once every target has a first read) and
 * dropped only after `maxAgeMs`.
 */
import type { TraderProfile, Venue } from '../types.js';
import { enrichmentFromProfile, type Enrichment } from './model.js';

export interface EnricherOptions {
  venue: Venue;
  fetchProfile: (address: string) => Promise<TraderProfile | null>;
  /** Gap between two reads. */
  intervalMs: number;
  /** Re-read an entry older than this. */
  ttlMs: number;
  /** Forget an entry older than this. */
  maxAgeMs: number;
  /** At most this many targets are kept. */
  maxTargets: number;
  /** Stop the loop this long after the last demand. */
  idleStopMs: number;
  /** Pause the venue this long after a rate-limit answer. */
  pauseMs: number;
  /** First back-off for a trader whose read failed; doubles per failure. */
  retryBaseMs: number;
  /** May a read be spent right now? */
  gate?: () => boolean;
  /** Master switch (env). */
  enabled?: boolean;
  now?: () => number;
  /** Timer; returns a cancel. Injected by tests. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  // Never keep the process (or a test run) alive for a background trickle.
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

/** A rate-limit answer from either venue (HTTP 429, Cloudflare 1015, the SoDEX cooldown error). */
export function isRateLimited(err: unknown): boolean {
  const e = err as { status?: unknown; httpStatus?: unknown; code?: unknown; name?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.status === 429 || e.httpStatus === 429 || e.code === 429) return true;
  if (e.name === 'RateLimitedError') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /\b429\b|\b1015\b|rate.?limit/i.test(msg);
}

export class Enricher {
  private readonly cache = new Map<string, Enrichment>();
  private readonly failures = new Map<string, { n: number; until: number }>();
  private targets: string[] = [];
  private lastDemand = 0;
  private pausedUntil = 0;
  private cancel: (() => void) | null = null;
  private busy = false;
  readonly o: Required<Omit<EnricherOptions, 'gate'>> & { gate?: () => boolean };

  constructor(opts: EnricherOptions) {
    this.o = {
      enabled: true,
      now: Date.now,
      schedule: defaultSchedule,
      ...opts,
    };
  }

  get venue(): Venue {
    return this.o.venue;
  }

  /** Cached enrichment for an address, however old (see maxAgeMs). */
  get(address: string): Enrichment | undefined {
    const a = address.toLowerCase();
    const e = this.cache.get(a);
    if (!e) return undefined;
    if (this.o.now() - e.at > this.o.maxAgeMs) {
      this.cache.delete(a);
      return undefined;
    }
    return e;
  }

  /** Put a read in the cache directly (tests, or a profile another page already paid for). */
  remember(address: string, e: Enrichment): void {
    this.cache.set(address.toLowerCase(), e);
  }

  get size(): number {
    return this.cache.size;
  }

  get running(): boolean {
    return this.cancel !== null;
  }

  /** Record that the screener was used with these targets (best first), and keep the loop going. */
  demand(targets: readonly string[]): void {
    if (!this.o.enabled) return;
    this.lastDemand = this.o.now();
    this.targets = [...new Set(targets.map((t) => t.toLowerCase()))].slice(0, this.o.maxTargets);
    if (!this.cancel && !this.busy) this.arm(Math.min(1_000, this.o.intervalMs));
  }

  /** The next address to read, or null when every target is fresh or backing off. */
  nextTarget(): string | null {
    const now = this.o.now();
    const ready = (a: string) => {
      const f = this.failures.get(a);
      return !f || f.until <= now;
    };
    // Never-read targets first, in priority order.
    for (const a of this.targets) if (!this.cache.has(a) && ready(a)) return a;
    // Then the stalest entry past its TTL.
    let best: string | null = null;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const a of this.targets) {
      const e = this.cache.get(a);
      if (e && now - e.at >= this.o.ttlMs && e.at < bestAt && ready(a)) {
        best = a;
        bestAt = e.at;
      }
    }
    return best;
  }

  private arm(ms: number): void {
    this.cancel?.();
    this.cancel = this.o.schedule(() => {
      this.cancel = null;
      void this.tick();
    }, ms);
  }

  /**
   * One turn: maybe read one trader, then schedule the next turn unless idle.
   * Exported behaviour for tests; the loop calls it itself.
   */
  async tick(): Promise<void> {
    if (this.busy) return;
    const now = this.o.now();
    if (now - this.lastDemand > this.o.idleStopMs) return; // idle: stop until the next demand
    this.busy = true;
    try {
      if (now < this.pausedUntil || (this.o.gate && !this.o.gate())) return;
      const a = this.nextTarget();
      if (!a) return;
      try {
        const profile = await this.o.fetchProfile(a);
        this.cache.set(a, enrichmentFromProfile(profile, this.o.now()));
        this.failures.delete(a);
      } catch (err) {
        const n = (this.failures.get(a)?.n ?? 0) + 1;
        this.failures.set(a, { n, until: this.o.now() + this.o.retryBaseMs * 2 ** Math.min(n - 1, 6) });
        if (isRateLimited(err)) this.pausedUntil = this.o.now() + this.o.pauseMs;
      }
      this.prune();
    } finally {
      this.busy = false;
      if (this.o.now() - this.lastDemand <= this.o.idleStopMs) this.arm(this.o.intervalMs);
    }
  }

  private prune(): void {
    if (this.cache.size < 5_000) return;
    const now = this.o.now();
    for (const [k, v] of this.cache) if (now - v.at > this.o.maxAgeMs) this.cache.delete(k);
  }

  /** Tests only. */
  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.lastDemand = 0;
  }
}
