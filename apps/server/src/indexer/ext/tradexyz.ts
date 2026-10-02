/**
 * trade.xyz in the index: Hyperliquid's HIP-3 dex "xyz" (markets `xyz:*`),
 * ranked on its own.
 *
 * Everything comes from Hyperliquid:
 *   - who trades: the HL trade stream, whose `xyz:*` prints the engine also
 *     files under `tradexyz`;
 *   - fills: `userFillsByTime`, whose `xyz:*` rows the store mirrors under
 *     `tradexyz` along with the held range (store.ts).
 *
 * PnL: Hyperliquid publishes no per-dex PnL (its portfolio ignores `dex`), so
 * a trader's xyz PnL for a window is what their xyz fills realised in it, net
 * of fees - the same basis Arcus uses for its own board. It is computed for
 * every trader whose fills are held back to the window start; the rest are
 * queued for a Hyperliquid fill read on the HL lane.
 *
 * Checked 2026-09-29 for a better source: Hyperliquid's leaderboard file and
 * `portfolio` are per account over every dex (no per-dex PnL), and
 * `clearinghouseState` with dex "xyz" gives the xyz margin book (value and
 * open PnL) but no realised PnL. So fills it is. Who gets read first: the
 * stream's most active xyz traders, then the largest xyz books the cohorts
 * found (their all-time figure also sorts them into a PnL cohort).
 *
 * Freshness: realised PnL needs REST fills (stream prints carry no closedPnl),
 * so a figure is "as of the last REST read" - at most 2 h old for 24h, 6 h
 * for the longer windows. A held range the stream keeps moving up (to_t) does
 * not count as fresher: `rest_at` does.
 */
import type { BoardWindow } from '../../valuescan/types.js';
import { spanCovers } from '../boards.js';
import { hlSyncFills } from '../hlSource.js';
import { hlInfo } from '../../valuescan/hyperliquid/index.js';
import { Lane } from '../lanes.js';
import { dayOf, hourOf, INDEX_WINDOWS, windowStart } from '../windows.js';
import type { ExtContext, ExtVenue } from './types.js';

const PER_WINDOW = 150;
/** The largest xyz books (cohort reads) also get a full read, for their all-time figure. */
const TOP_BOOKS = 300;
const EVERY_MS = 10 * 60_000;
const FRESH_MS: Partial<Record<BoardWindow, number>> = { '1d': 2 * 60 * 60_000 };
const FRESH_DEFAULT_MS = 6 * 60 * 60_000;
const HOUR_WINDOWS: ReadonlySet<BoardWindow> = new Set(['1d', '7d', '30d']);

export class TradexyzVenue implements ExtVenue {
  readonly venue = 'tradexyz' as const;
  readonly lane = new Lane({ name: 'tradexyz', perMin: 100_000 });
  private ctx!: ExtContext;
  private computedAt: Partial<Record<BoardWindow, number>> = {};

  start(ctx: ExtContext): void {
    this.ctx = ctx;
  }

  stop(): void {}

  /** The HL stream carries xyz; the engine uses its span. */
  socketSince(): number | null {
    return null;
  }

  maxAgeMs(): number {
    return 2 * EVERY_MS;
  }

  /** Ready once computed with no xyz fill read still waiting. */
  sourceReady(window: BoardWindow): boolean {
    return this.computedAt[window] !== undefined && this.ctx.hlLane.countPrefix('xyz:') === 0;
  }

  private queueRead(address: string, from: number, prio: number, maxPages: number): void {
    this.ctx.hlLane.add({
      key: `xyz:${address}`,
      prio,
      replace: true,
      run: async () => {
        const r = await hlSyncFills(this.ctx.store, address, from, { maxPages, now: this.ctx.now() });
        return r.pages * 20 + Math.ceil(r.rows / 20);
      },
    });
  }

  async refresh(now: number): Promise<void> {
    const store = this.ctx.store;
    const known = new Set(store.indexedAddresses('tradexyz'));
    const books = store.topCohortBooks('tradexyz', TOP_BOOKS);
    void spanCovers;
    // Hand the loop back every 40 ms: a trader's sum is a scan of its window's first day,
    // and summing every trader for every window in one go held the loop for seconds.
    let last = Date.now();
    const pause = async (): Promise<void> => {
      if (Date.now() - last < 40) return;
      await new Promise<void>((r) => setImmediate(r));
      last = Date.now();
    };
    for (const window of INDEX_WINDOWS) {
      if (now - (this.computedAt[window] ?? 0) < EVERY_MS) continue;
      const from = windowStart(window, now);
      const fresh = FRESH_MS[window] ?? FRESH_DEFAULT_MS;
      const active = store
        .activeAccounts('tradexyz', HOUR_WINDOWS.has(window) ? { hour: hourOf(from) } : { day: dayOf(from) }, 1, PER_WINDOW)
        .map((a) => a.acct);
      const rows: Array<{ address: string; pnl: number; volume: number | null }> = [];
      const order = [...new Set([...active, ...books, ...known])];
      const wanted = new Set([...active, ...books]);
      for (let i = 0; i < order.length; i++) {
        const address = order[i]!;
        const cov = store.coverage('tradexyz', address, 'fills');
        // Realised PnL needs REST fills (stream prints carry no closedPnl or fee), so
        // the stream does not stand in here; a history cut by HL's 10k cap does not either.
        if (cov?.capped && cov.fromT > from) continue;
        const back = !!cov && (cov.fromT <= from || cov.exhausted);
        if (!back || now - cov!.restAt > fresh) {
          // Read back to the start of all time once: one pass then serves every window.
          // Above the HL "any"-board histories, below the HL trade checks.
          if (wanted.has(address)) this.queueRead(address, 0, 5_900 - Math.min(400, i), 6);
          continue;
        }
        // Whole days from the day rows (they outlive the raw fills), the window's first day from its fills.
        const r = await store.realizedAsync('tradexyz', address, from, pause);
        if (r.fills > 0) {
          rows.push({ address, pnl: r.pnl, volume: r.volume });
          this.queueAccountValue(address, 5_800);
        }
        await pause();
      }
      store.putPnl('tradexyz', window, rows, now, now);
      this.computedAt[window] = now;
    }
  }

  private avAt = new Map<string, number>();

  /**
   * The xyz dex's own margin account value (clearinghouseState, dex xyz: 2
   * weight). A board row asks at the visible priority: at 5,800 these sat
   * behind the HL histories and trade checks for 10 h.
   */
  queueAccountValue(address: string, prio: number): void {
    const now = this.ctx.now();
    const read = this.avAt.get(address);
    if (read !== undefined && now - read < 60 * 60_000) return;
    this.ctx.hlLane.add({
      key: `xyzav:${address}`,
      prio,
      run: async () => {
        // Not `background`: that waits for spare room the fill backfill rarely leaves; the lane paces it.
        const st = await hlInfo.post<{ marginSummary?: { accountValue?: string } }>(
          { type: 'clearinghouseState', user: address, dex: 'xyz' },
          { ttlMs: 60_000 },
        );
        this.avAt.set(address, this.ctx.now());
        const av = Number(st?.marginSummary?.accountValue);
        if (Number.isFinite(av)) this.ctx.store.setAccountValue('tradexyz', address, av, this.ctx.now());
        return 2;
      },
    });
  }

  queueCheck(address: string, from: number, prio: number): void {
    this.queueRead(address, from, 5_000 + prio, 1);
  }

  queueHistory(address: string, from: number, prio: number): void {
    this.queueRead(address, from, prio, 6);
  }

  status(): Record<string, unknown> {
    return { computedAt: this.computedAt };
  }
}
