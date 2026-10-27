/**
 * Per-IP budgets shared by every tab of this browser.
 *
 * An exchange limits requests per IP, and every tab of ValueDesk a user has
 * open sends from the same IP. So a budget kept inside one tab would let two
 * tabs spend twice the allowance. The ledger lives in localStorage (one entry
 * per budget) and every read-modify-write runs under a Web Lock of the same
 * name, so tabs take turns instead of racing. Without Web Locks the ledger is
 * still shared, just not atomically (good enough: the numbers carry headroom);
 * without localStorage (private mode quirks) it falls back to this tab alone.
 *
 * Two primitives:
 *  - SharedLedger: a sliding-window budget. `take(w)` resolves once `w` fits
 *    in the window (waiting as long as needed, up to a cap), and records it.
 *  - SharedCooldowns: per-endpoint "stop until" marks after a 429 / 1015, so
 *    a rate limit seen by one tab quiets every tab.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LockManagerLike {
  request<T>(name: string, cb: () => Promise<T> | T): Promise<T>;
}

export interface LedgerDeps {
  store: KeyValueStore | null;
  locks: LockManagerLike | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function browserStore(): KeyValueStore | null {
  try {
    const s = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    if (!s) return null;
    const probe = '__vs_ledger_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function browserLocks(): LockManagerLike | null {
  const l = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return l && typeof l.request === 'function' ? l : null;
}

export const defaultLedgerDeps = (): LedgerDeps => ({
  store: browserStore(),
  locks: browserLocks(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** Thrown when a budget stayed full for longer than the caller was willing to wait. */
export class BudgetWaitError extends Error {
  override name = 'BudgetWaitError';
  constructor(
    readonly budget: string,
    readonly waitedMs: number,
  ) {
    super(`${budget}: the per-IP request budget stayed full for ${Math.round(waitedMs / 1000)} s`);
  }
}

type Entry = [at: number, w: number];

/**
 * A sliding-window budget: at most `limit` units in any `windowMs`, counted
 * over every tab. Entries are [time, units].
 */
export class SharedLedger {
  private mem: Entry[] = [];
  private readonly storeKey: string;

  constructor(
    readonly name: string,
    readonly limit: number,
    readonly windowMs: number,
    private readonly deps: LedgerDeps = defaultLedgerDeps(),
    /**
     * Take the Web Lock around every update (exact across tabs). A budget with
     * room to spare passes false: no lock round trip before each request, and
     * two tabs racing can overshoot by one entry at most.
     */
    readonly atomic = true,
  ) {
    this.storeKey = `vs:ledger:${name}`;
  }

  private read(now: number): Entry[] {
    let list: Entry[] = this.mem;
    const s = this.deps.store;
    if (s) {
      try {
        const raw = s.getItem(this.storeKey);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        list = Array.isArray(parsed) ? (parsed.filter((e) => Array.isArray(e) && e.length === 2) as Entry[]) : [];
      } catch {
        list = [];
      }
    }
    const cutoff = now - this.windowMs;
    return list.filter(([at]) => at > cutoff);
  }

  private write(list: Entry[]): void {
    this.mem = list;
    const s = this.deps.store;
    if (!s) return;
    try {
      s.setItem(this.storeKey, JSON.stringify(list));
    } catch {
      /* storage full or blocked: this tab's copy still counts */
    }
  }

  private locked<T>(fn: () => T): Promise<T> {
    const l = this.atomic ? this.deps.locks : null;
    return l ? l.request(this.storeKey, () => fn()) : Promise.resolve(fn());
  }

  /** Units spent in the current window, over every tab. */
  spent(): number {
    const now = this.deps.now();
    return this.read(now).reduce((n, [, w]) => n + w, 0);
  }

  /**
   * Record `w` units if they fit right now. Returns 0 when recorded, else the
   * ms until the oldest entry leaves the window (when the next try can succeed).
   */
  tryTake(w: number): Promise<number> {
    return this.locked(() => {
      const now = this.deps.now();
      const list = this.read(now);
      const used = list.reduce((n, [, x]) => n + x, 0);
      // A single request bigger than the whole budget is let through alone once
      // the window is empty, rather than waiting forever.
      if (used + w <= this.limit || (used === 0 && w > this.limit)) {
        list.push([now, w]);
        this.write(list);
        return 0;
      }
      // Free enough room: walk the oldest entries until `w` would fit.
      let free = this.limit - used;
      for (const [at, x] of list) {
        free += x;
        if (free >= w) return Math.max(1, at + this.windowMs - now);
      }
      return Math.max(1, (list[0]?.[0] ?? now) + this.windowMs - now);
    });
  }

  /**
   * Record `w` units only if NOTHING is in the window - one step, so of several
   * callers (other tabs included) exactly one gets an idle budget. Returns 0
   * when recorded, else the ms until the window is clear.
   */
  tryTakeIdle(w: number): Promise<number> {
    return this.locked(() => {
      const now = this.deps.now();
      const list = this.read(now);
      if (list.length === 0) {
        this.write([[now, w]]);
        return 0;
      }
      let newest = 0;
      for (const [at] of list) newest = Math.max(newest, at);
      return Math.max(1, newest + this.windowMs - now);
    });
  }

  /**
   * Wait until `w` units fit, then record them. Rejects with BudgetWaitError
   * once more than `maxWaitMs` would pass, or when `signal` aborts.
   */
  async take(w: number, maxWaitMs = 30_000, signal?: AbortSignal): Promise<void> {
    const start = this.deps.now();
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      const wait = await this.tryTake(w);
      if (wait === 0) return;
      const waited = this.deps.now() - start;
      if (waited + wait > maxWaitMs) throw new BudgetWaitError(this.name, waited + wait);
      await this.deps.sleep(Math.min(wait, 2_000));
    }
  }

  /** Book units learned after the fact (Hyperliquid bills per item returned). */
  charge(w: number): Promise<void> {
    if (!(w > 0)) return Promise.resolve();
    return this.locked(() => {
      const now = this.deps.now();
      const list = this.read(now);
      list.push([now, w]);
      this.write(list);
    });
  }
}

/**
 * "Stop until" marks per endpoint, shared by every tab: 15 s after the first
 * rate limit, doubling while they keep coming (to a cap), reset by a success.
 */
export class SharedCooldowns {
  private mem = new Map<string, { until: number; ms: number }>();

  constructor(
    readonly name: string,
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly deps: LedgerDeps = defaultLedgerDeps(),
  ) {}

  private key(endpoint: string): string {
    return `vs:cool:${this.name}:${endpoint}`;
  }

  private get(endpoint: string): { until: number; ms: number } | null {
    const s = this.deps.store;
    if (s) {
      try {
        const raw = s.getItem(this.key(endpoint));
        if (!raw) return null;
        const v = JSON.parse(raw) as { until?: unknown; ms?: unknown };
        return typeof v.until === 'number' && typeof v.ms === 'number' ? { until: v.until, ms: v.ms } : null;
      } catch {
        return null;
      }
    }
    return this.mem.get(endpoint) ?? null;
  }

  /** ms until `endpoint` may be asked again (0 = not cooling). */
  left(endpoint: string): number {
    const c = this.get(endpoint);
    return c ? Math.max(0, c.until - this.deps.now()) : 0;
  }

  /** A rate limit was seen on `endpoint`: start (or double) its cooldown. Returns its length. */
  hit(endpoint: string): number {
    const now = this.deps.now();
    const prev = this.get(endpoint);
    // Still inside a cooldown another tab (or an earlier request) opened: extend by doubling.
    const ms = Math.min(this.maxMs, prev && prev.until > now - this.maxMs ? prev.ms * 2 : this.baseMs);
    const next = { until: Math.max(prev?.until ?? 0, now + ms), ms };
    this.mem.set(endpoint, next);
    const s = this.deps.store;
    if (s) {
      try {
        s.setItem(this.key(endpoint), JSON.stringify(next));
      } catch {
        /* this tab still honours it */
      }
    }
    return ms;
  }

  /** A success on `endpoint`: its cooldown (and doubling) is over. */
  clear(endpoint: string): void {
    if (!this.get(endpoint)) return;
    this.mem.delete(endpoint);
    try {
      this.deps.store?.removeItem(this.key(endpoint));
    } catch {
      /* ignore */
    }
  }
}
