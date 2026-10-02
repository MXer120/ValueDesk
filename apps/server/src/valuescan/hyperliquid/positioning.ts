/**
 * Net positioning of Hyperliquid's largest accounts, per coin.
 *
 * WHO. The top 100 and the lowest 100 by 30-day PnL. About 200 accounts.
 *
 * HOW, FIRST: THE INDEX. The indexer keeps a book for each of those wallets,
 * moved by the wallet's own prints on the trade stream (indexer/held.ts), on
 * the default dex and on the HIP-3 dex "xyz". Summing them is a few hundred
 * key lookups in a file and no request to Hyperliquid, so it costs the same
 * for one visitor as for ten thousand. The answer is reused for INDEX_TTL_MS.
 *
 * HOW, OTHERWISE: A SWEEP. Only where the index cannot answer yet (no 30-day
 * board, or books for fewer than half its wallets) AND this process is the
 * single-process dev server: clearinghouseState (weight 2) for each wallet on
 * both dexes, so 200 traders cost 800 weight per sweep. Requests run a few at
 * a time with background priority (info.ts), so a sweep only spends weight the
 * interactive pages are not using. The result is cached for CACHE_MS; after
 * that, callers get the cached rows at once and a new sweep starts behind them
 * (stale-while-revalidate). Only the very first call waits.
 *
 * A process that only serves the API (env.ts apiOnly: next to the indexer, or
 * public) never sweeps: 800 weight whenever a visitor finds the cache expired
 * would come out of the address the indexer reads from. There, "the index
 * cannot answer yet" is the answer (NotAvailable).
 *
 * LIMITS. clearinghouseState is per account, while leaderboard rows aggregate
 * sub-accounts, so a master that trades only through sub-accounts shows no
 * positions here. Covering those would need `subAccounts` (weight 20 each).
 * The index's books have the same reach (they start from the same read).
 */
import { NotAvailable, type Positioning, type VsPosition } from '../types.js';
import { mapLimit, type InfoLike } from './info.js';
import type { HlLeaderboardStore } from './leaderboard.js';
import { aggregatePositioning, mapPositions, symbolMatches } from './mappers.js';
import type { HlClearinghouseState } from './raw.js';

export const TRACKED_TOP = 100;
export const TRACKED_WORST = 100;
const DEXES = ['', 'xyz'];
const CACHE_MS = 3 * 60_000;
const CONCURRENCY = 6;
/** The index's answer is reused this long (the indexer writes its books every 10 s). */
export const INDEX_TTL_MS = 15_000;
/** Books for a smaller share of the boards' wallets than this are not published. */
const MIN_COVERAGE = 0.5;

/** Where the positions come from when the index holds them (indexer/held.ts). */
export interface IndexSource {
  /** Positions per board wallet the index has a book for; null = no index, or no 30-day board yet. */
  holdings(): { traders: VsPosition[][]; tracked: number; held: number } | null;
  /** This process must not sweep the venue itself (env.ts apiOnly). */
  only(): boolean;
}

export class HlPositioning {
  private rows: Positioning[] | null = null;
  private at = 0;
  private running: Promise<Positioning[]> | null = null;
  private fromIndex: { at: number; rows: Positioning[] } | null = null;

  constructor(
    private readonly info: InfoLike,
    private readonly leaderboard: Pick<HlLeaderboardStore, 'snapshot'>,
    private readonly now: () => number = Date.now,
    private readonly index?: IndexSource,
  ) {}

  async get(symbol?: string): Promise<Positioning[]> {
    const rows = this.indexRows() ?? (await this.swept());
    return symbol ? rows.filter((r) => symbolMatches(r.symbol, symbol)) : rows;
  }

  /** The index's books for the boards' wallets, summed: no request to Hyperliquid. */
  private indexRows(): Positioning[] | null {
    if (!this.index) return null;
    const now = this.now();
    if (this.fromIndex && now - this.fromIndex.at < INDEX_TTL_MS) return this.fromIndex.rows;
    const h = this.index.holdings();
    if (!h || !h.tracked || h.held < h.tracked * MIN_COVERAGE) return null;
    this.fromIndex = { at: now, rows: aggregatePositioning(h.traders) };
    return this.fromIndex.rows;
  }

  /** The sweep's rows (see the header): never in a process that only serves the API. */
  private async swept(): Promise<Positioning[]> {
    if (this.index?.only()) {
      throw new NotAvailable("Hyperliquid positioning is read from the index, which does not hold the 30-day boards' wallets and their positions yet");
    }
    const rows = this.rows;
    if (!rows) return this.sweep();
    if (this.now() - this.at >= CACHE_MS) void this.sweep().catch(() => {});
    return rows;
  }

  private sweep(): Promise<Positioning[]> {
    if (!this.running) {
      this.running = this.compute()
        .then((rows) => {
          this.rows = rows;
          this.at = this.now();
          return rows;
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private async compute(): Promise<Positioning[]> {
    const snap = await this.leaderboard.snapshot();
    const order = snap.order('pnl', '30d');
    const top: string[] = [];
    for (let k = 0; k < order.length && top.length < TRACKED_TOP; k++) {
      const i = order[k]!;
      if (!Number.isFinite(snap.data.cols['pnl:30d'][i]!)) continue;
      top.push(snap.data.addresses[i]!);
    }
    const worst: string[] = [];
    for (let k = order.length - 1; k >= 0 && worst.length < TRACKED_WORST; k--) {
      const i = order[k]!;
      if (!Number.isFinite(snap.data.cols['pnl:30d'][i]!)) continue;
      worst.push(snap.data.addresses[i]!);
    }
    const addresses = [...new Set([...top, ...worst])];

    const jobs = addresses.flatMap((user) => DEXES.map((dex) => ({ user, dex })));
    const results = await mapLimit(jobs, CONCURRENCY, ({ user, dex }) =>
      this.info.post<HlClearinghouseState>(dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user }, {
        ttlMs: 60_000,
        background: true,
      }),
    );
    if (results.every((r) => r.status === 'rejected')) {
      throw (results[0] as PromiseRejectedResult | undefined)?.reason ?? new Error('no traders to sweep');
    }

    const perTrader = new Map<string, VsPosition[]>();
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const { user, dex } = jobs[i]!;
      const list = perTrader.get(user) ?? [];
      list.push(...mapPositions(r.value, dex));
      perTrader.set(user, list);
    });
    return aggregatePositioning([...perTrader.values()]);
  }
}
