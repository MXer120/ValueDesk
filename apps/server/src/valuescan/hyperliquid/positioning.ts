/**
 * Net positioning of Hyperliquid's largest accounts, per coin.
 *
 * WHO. The top 100 and the lowest 100 by 30-day PnL. About 200 accounts.
 *
 * HOW. clearinghouseState (weight 2) for each of them on the default dex and
 * on the HIP-3 dex "xyz", so 200 traders cost 800 weight per sweep. Requests
 * run a few at a time with background priority (info.ts), so a sweep only
 * spends weight the interactive pages are not using. The result is cached for
 * CACHE_MS; after that, callers get the cached rows at once and a new sweep
 * starts behind them (stale-while-revalidate). Only the very first call waits.
 *
 * LIMITS. clearinghouseState is per account, while leaderboard rows aggregate
 * sub-accounts, so a master that trades only through sub-accounts shows no
 * positions here. Covering those would need `subAccounts` (weight 20 each).
 */
import type { Positioning, VsPosition } from '../types.js';
import { mapLimit, type InfoLike } from './info.js';
import type { HlLeaderboardStore } from './leaderboard.js';
import { aggregatePositioning, mapPositions, symbolMatches } from './mappers.js';
import type { HlClearinghouseState } from './raw.js';

export const TRACKED_TOP = 100;
export const TRACKED_WORST = 100;
const DEXES = ['', 'xyz'];
const CACHE_MS = 3 * 60_000;
const CONCURRENCY = 6;

export class HlPositioning {
  private rows: Positioning[] | null = null;
  private at = 0;
  private running: Promise<Positioning[]> | null = null;

  constructor(
    private readonly info: InfoLike,
    private readonly leaderboard: Pick<HlLeaderboardStore, 'snapshot'>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(symbol?: string): Promise<Positioning[]> {
    let rows = this.rows;
    if (!rows) rows = await this.sweep();
    else if (this.now() - this.at >= CACHE_MS) void this.sweep().catch(() => {});
    return symbol ? rows.filter((r) => symbolMatches(r.symbol, symbol)) : rows;
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
