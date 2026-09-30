/**
 * A paced JSON GET for the venues without a dedicated client (Lighter, Arcus).
 *
 * Requests on one pacer run one at a time through a token bucket: a short
 * burst (a Scan profile's handful of reads) goes out at once, and the average
 * stays at `perMin` (units: requests, or the venue's own weight when the
 * caller passes one). A 429 opens a cooldown (the venue's Retry-After, else 60 s)
 * during which every call on that pacer waits instead of piling onto the
 * limit. Read-only: nothing here builds a signed request.
 *
 * Each thread (API, indexer worker) has its own pacers, so each side's
 * `perMin` is its share of the venue's per-IP budget.
 */

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly url: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Pacer {
  private chain: Promise<unknown> = Promise.resolve();
  /** Token bucket: holds up to `burst`, refills at perMin / minute. */
  private tokens: number;
  private refilledAt = Date.now();
  private coolUntil = 0;

  constructor(
    readonly name: string,
    private readonly perMin: number,
    private readonly burst = Math.max(1, Math.floor(perMin / 6)),
    private readonly timeoutMs = 20_000,
  ) {
    this.tokens = this.burst;
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.refilledAt) * this.perMin) / 60_000);
    this.refilledAt = now;
  }

  /** ms until a request of `cost` could start (cooldown or an empty bucket). */
  waitFor(cost = 1): number {
    const now = Date.now();
    this.refill(now);
    const short = cost - this.tokens;
    return Math.max(0, this.coolUntil - now, short > 0 ? (short / this.perMin) * 60_000 : 0);
  }

  get cooling(): boolean {
    return Date.now() < this.coolUntil;
  }

  get<T>(url: string, cost = 1): Promise<T> {
    const run = async (): Promise<T> => {
      for (let wait = this.waitFor(cost); wait > 0; wait = this.waitFor(cost)) await sleep(wait);
      this.tokens -= cost;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await res.text();
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        this.coolUntil = Date.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : 60_000);
        throw new HttpError(429, `${this.name}: rate limited`, url);
      }
      if (!res.ok) throw new HttpError(res.status, `${this.name}: HTTP ${res.status} ${text.slice(0, 160)}`, url);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError(res.status, `${this.name}: non-JSON response ${text.slice(0, 160)}`, url);
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export const lowerAddress = (a: unknown): string | null =>
  typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
