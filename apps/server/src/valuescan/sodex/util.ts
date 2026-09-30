/**
 * Small, dependency-free helpers for the SoDEX provider: a TTL cache that
 * coalesces concurrent misses, a polite request limiter, and a shared
 * rate-limit cooldown.
 */

/**
 * TTL cache with in-flight coalescing. Failures are never cached, so a blip is
 * not pinned for the whole TTL. `stale()` hands back an expired value, which is
 * what lets slow crawls serve the last good answer while they refresh.
 */
export class TtlCache {
  private entries = new Map<string, { at: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries = 5_000) {}

  get<T>(key: string, ttlMs: number): T | undefined {
    const hit = this.entries.get(key);
    return hit && Date.now() - hit.at < ttlMs ? (hit.value as T) : undefined;
  }

  stale<T>(key: string): { at: number; value: T } | undefined {
    return this.entries.get(key) as { at: number; value: T } | undefined;
  }

  set(key: string, value: unknown): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Oldest insertion first: Map iteration order is insertion order.
      const first = this.entries.keys().next().value;
      if (first !== undefined) this.entries.delete(first);
    }
    this.entries.delete(key);
    this.entries.set(key, { at: Date.now(), value });
  }

  isRunning(key: string): boolean {
    return this.inflight.has(key);
  }

  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key, ttlMs);
    if (hit !== undefined) return hit;
    return this.refresh(key, fn);
  }

  /** Run `fn` (coalesced with any run already in flight for `key`) and store the result. */
  refresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = fn()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

/**
 * Concurrency + minimum-gap limiter with two priorities. Foreground work (a
 * page someone is looking at) always goes before background enrichment.
 */
export class Limiter {
  private active = 0;
  private high: Array<() => void> = [];
  private low: Array<() => void> = [];
  private lastStart = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly concurrency: number, private readonly gapMs: number) {}

  run<T>(fn: () => Promise<T>, priority: 'high' | 'low' = 'high'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        fn().then(resolve, reject).finally(() => {
          this.active--;
          this.pump();
        });
      };
      (priority === 'high' ? this.high : this.low).push(start);
      this.pump();
    });
  }

  get pending(): number {
    return this.high.length + this.low.length;
  }

  get pendingLow(): number {
    return this.low.length;
  }

  private pump(): void {
    while (this.active < this.concurrency && (this.high.length || this.low.length)) {
      const wait = this.lastStart + this.gapMs - Date.now();
      if (wait > 0) {
        if (!this.timer) {
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.pump();
          }, wait);
          this.timer.unref?.();
        }
        return;
      }
      const next = (this.high.length ? this.high : this.low).shift()!;
      this.active++;
      this.lastStart = Date.now();
      next();
    }
  }
}

/**
 * One shared "back off" flag for everything this provider does on sodex.dev.
 * A Cloudflare 1015 or an HTTP 429 from any SoDEX host sets it; background
 * crawls (positioning, enrichment) then pause so the running Valuetrade UI,
 * which shares this machine's IP, gets the budget back first.
 */
let coolUntil = 0;

export const COOLDOWN_MS = 60_000;

export function noteRateLimited(): void {
  coolUntil = Date.now() + COOLDOWN_MS;
}

export const coolingDown = (): boolean => Date.now() < coolUntil;

export const cooldownLeftMs = (): number => Math.max(0, coolUntil - Date.now());

/** Thrown instead of calling upstream while the cooldown is set. */
export class RateLimitedError extends Error {
  constructor(what: string) {
    super(
      `SoDEX is rate-limiting this machine's IP; ${what} paused for ` +
        `${Math.ceil(cooldownLeftMs() / 1000)} s so the running app keeps working. Try again shortly.`,
    );
    this.name = 'RateLimitedError';
  }
}

/** True for the failures that mean "you are asking too fast". */
export function isRateLimit(err: unknown): boolean {
  const e = err as { httpStatus?: number; code?: number; status?: number; message?: string };
  return (
    e?.httpStatus === 429 ||
    e?.status === 429 ||
    e?.code === 429 ||
    /\b1015\b|too many requests|rate.?limit/i.test(String(e?.message ?? ''))
  );
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/** Resolve with `p`, or with `fallback` once `ms` has passed. Never rejects on timeout. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => fallback)]);
}
