/**
 * The screener's trader pool: a few leaderboard slices per venue, merged into
 * one record per (venue, address). Same pattern as explore.ts, which it reuses
 * for the merge, and the same rule that one venue failing never blanks the
 * other.
 *
 * SLICES. Several rankings, not one: a trader who is top-50 by account value
 * but not by PnL must still be screenable as a whale, and "most active" needs
 * the 24h volume ranking. Hyperliquid serves every slice from one in-memory
 * snapshot, so it gets deep slices (~800 distinct traders). SoDEX's slices are
 * separate upstream pages behind a rate-limited Cloudflare zone, so its slices
 * are the ones Explore already asks (shared 60 s provider cache) plus a single
 * extra page or two - about 300 distinct traders.
 *
 * CACHE. Per venue, so `venue=all` and `venue=sodex` share one build. Fresh for
 * POOL_TTL_MS; up to POOL_STALE_MAX_MS the last pool is served at once while one
 * rebuild runs behind it. A failed build is remembered for POOL_FAIL_TTL_MS and
 * never replaces a good pool that is still within its stale window. Only the
 * very first request per venue waits for a build.
 */
import { mergeRows } from '../explore.js';
import {
  NotAvailable,
  type LeaderboardPage,
  type LeaderboardQuery,
  type TraderRow,
  type CoreVenue,
  type Venue,
  type VenueProvider,
} from '../types.js';

export const POOL_TTL_MS = 2 * 60_000;
export const POOL_STALE_MAX_MS = 20 * 60_000;
export const POOL_FAIL_TTL_MS = 15_000;
export const POOL_SLICE_TIMEOUT_MS = 25_000;
/** Slices of one venue in flight at once, after the first. */
export const POOL_SLICE_CONCURRENCY = 3;

const s = (window: LeaderboardQuery['window'], sort: LeaderboardQuery['sort'], limit: number): LeaderboardQuery =>
  ({ window, sort, limit, offset: 0 });

/** First slice first: it is the one every venue serves, and it warms the provider's cache. */
export const POOL_SLICES: Record<CoreVenue, readonly LeaderboardQuery[]> = {
  hyperliquid: [
    s('30d', 'pnl', 300),
    s('1d', 'volume', 250),
    s('30d', 'accountValue', 250),
    s('7d', 'pnl', 150),
    s('all', 'pnl', 150),
    s('30d', 'roi', 150),
    s('7d', 'volume', 150),
  ],
  sodex: [
    s('30d', 'pnl', 150),
    s('1d', 'volume', 100),
    s('7d', 'volume', 100),
    s('7d', 'pnl', 100),
    s('all', 'pnl', 100),
    s('30d', 'accountValue', 50),
    s('30d', 'roi', 100),
  ],
};

export interface VenuePool {
  venue: Venue;
  rows: TraderRow[];
  /** Oldest upstream snapshot among the slices that answered. */
  updatedAt: number;
  /** When this pool was built. */
  builtAt: number;
  /** Slices that answered / were asked. */
  slices: { ok: number; asked: number };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Ask a provider for its slices. Throws only when no slice answered. */
export async function harvestPool(
  p: VenueProvider,
  slices: readonly LeaderboardQuery[] = POOL_SLICES[p.venue as CoreVenue] ?? [],
  now: () => number = Date.now,
): Promise<VenuePool> {
  const pages: Array<LeaderboardPage | undefined> = [];
  const errors: unknown[] = [];
  const ask = async (i: number): Promise<boolean> => {
    const q = slices[i]!;
    try {
      const page = await withTimeout(
        Promise.resolve().then(() => p.leaderboard(q)),
        POOL_SLICE_TIMEOUT_MS,
        `${p.venue} leaderboard ${q.sort}/${q.window}`,
      );
      if (page && Array.isArray(page.rows)) pages[i] = page;
      return true;
    } catch (e) {
      errors.push(e);
      return false;
    }
  };

  const firstOk = await ask(0);
  if (!(!firstOk && errors[0] instanceof NotAvailable)) {
    let next = 1;
    const worker = async () => {
      while (next < slices.length) await ask(next++);
    };
    await Promise.all(Array.from({ length: Math.min(POOL_SLICE_CONCURRENCY, Math.max(0, slices.length - 1)) }, worker));
  }

  const got = pages.filter((x): x is LeaderboardPage => !!x);
  if (!got.length) {
    const msg = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ') || 'no slice answered';
    if (errors.length && errors.every((e) => e instanceof NotAvailable)) throw new NotAvailable(`${p.venue}: ${msg}`);
    throw new Error(`${p.venue}: ${msg}`);
  }
  const rows = mergeRows(got.flatMap((pg) => pg.rows.map((r) => ({ ...r, venue: p.venue }))));
  const stamps = got.map((pg) => pg.updatedAt).filter((t) => Number.isFinite(t) && t > 0);
  const t = now();
  return {
    venue: p.venue,
    rows,
    updatedAt: stamps.length ? Math.min(t, ...stamps) : t,
    builtAt: t,
    slices: { ok: got.length, asked: slices.length },
  };
}

interface Entry {
  value?: VenuePool;
  error?: unknown;
  errorAt?: number;
  pending?: Promise<VenuePool>;
}

/** Per-venue pool cache with stale-while-refresh. Injectable harvest and clock for tests. */
export class PoolCache {
  private readonly entries = new Map<Venue, Entry>();

  constructor(
    private readonly harvest: (p: VenueProvider) => Promise<VenuePool> = (p) => harvestPool(p),
    private readonly now: () => number = Date.now,
  ) {}

  private rebuild(venue: Venue, provider: VenueProvider): Promise<VenuePool> {
    const e = this.entries.get(venue) ?? {};
    this.entries.set(venue, e);
    if (e.pending) return e.pending;
    const promise = this.harvest(provider)
      .then((value) => {
        e.value = value;
        e.error = undefined;
        e.errorAt = undefined;
        return value;
      })
      .catch((err: unknown) => {
        e.error = err;
        e.errorAt = this.now();
        throw err;
      })
      .finally(() => {
        if (e.pending === promise) e.pending = undefined;
      });
    e.pending = promise;
    return promise;
  }

  async get(provider: VenueProvider): Promise<VenuePool> {
    const venue = provider.venue;
    const e = this.entries.get(venue);
    const now = this.now();
    const recentlyFailed = e?.errorAt !== undefined && now - e.errorAt < POOL_FAIL_TTL_MS;
    if (e?.value) {
      const age = now - e.value.builtAt;
      if (age < POOL_TTL_MS) return e.value;
      if (age < POOL_STALE_MAX_MS) {
        if (!recentlyFailed) this.rebuild(venue, provider).catch(() => { /* kept in the entry */ });
        return e.value;
      }
    }
    if (recentlyFailed) throw e!.error;
    return this.rebuild(venue, provider);
  }

  /** When the venue's pool in hand was built (null: none yet). */
  builtAt(venue: Venue): number | null {
    return this.entries.get(venue)?.value?.builtAt ?? null;
  }

  /** Tests only. */
  clear(): void {
    this.entries.clear();
  }
}
