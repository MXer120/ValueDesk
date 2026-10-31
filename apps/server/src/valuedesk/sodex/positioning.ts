/**
 * Net perps positioning of SoDEX's top traders, per market.
 *
 * FIRST: THE INDEX. The tracked set is the index's 30-day boards - the top
 * 100 and the lowest 100 by PnL, the rows the leaderboard shows - and the
 * indexer keeps a book for each of those wallets, moved by the wallet's own
 * prints on the trade stream (indexer/held.ts). Summing them is two board
 * reads and a key lookup per wallet in a file: no request to SoDEX, for one
 * visitor or ten thousand. The answer is reused for INDEX_TTL_MS.
 *
 * OTHERWISE: A CRAWL, only where the index cannot answer yet (no 30-day
 * board, or books for fewer than half its wallets) AND this process is the
 * single-process dev server. A process that only serves the API (env.ts
 * apiOnly: next to the indexer, or public) never crawls - 1,000 gateway weight
 * whenever a visitor finds the cache expired would come out of the address
 * the indexer reads from, and the ceiling below counts only this process's
 * own requests. There, "the index cannot answer yet" is the answer
 * (NotAvailable).
 *
 * The crawl's tracked set is SoDEX's own 30-day PnL list: the top 100 and
 * the lowest 100. SoDEX only publishes its top 1,000, so that low hundred is
 * the bottom of the published list, not the bottom of every wallet. Each
 * one's perps state is read from the gateway (weight 5, so about 1,000 weight
 * for 200 wallets) and the open positions are summed per symbol.
 *
 * Politeness, because the running Valuetrade UI shares this IP's per-minute
 * weight (the limit SoDEX reports: 6000 on 2026-10-31):
 *  - 3 reads in flight, >=150 ms apart;
 *  - before each read, wait while this process has already spent more than
 *    half the minute's budget, so interactive requests always keep headroom;
 *  - a 429/1015 anywhere stops the crawl (shared cooldown);
 *  - the result is kept 4 minutes and then served stale while one background
 *    crawl refreshes it. No timer: nothing is crawled unless someone asks.
 *
 * With the UI polling alongside, a crawl can take a minute or more. The very
 * first request therefore waits at most FIRST_WAIT_MS and then answers with a
 * "still computing" error (with progress) while the crawl carries on; every
 * request after that is served from the snapshot.
 */
import { boardHoldings, type Holdings } from '../../indexer/held.js';
import { apiOnly } from '../env.js';
import { NotAvailable, type Positioning, type VsPosition } from '../types.js';
import { LB_PAGE_SIZE, lbPage } from './data.js';
import { gatewayWeightLimit, gatewayWeightSpent, markPrices, perpsState } from './gateway.js';
import { aggregatePositioning, lowerAddress, markMap, statePositions, symbolMatches } from './mappers.js';
import { seedAddress } from './resolver.js';
import { Limiter, TtlCache, coolingDown, sleep, within } from './util.js';

export const TRACKED_TOP = 100;
export const TRACKED_WORST = 100;
const TTL_MS = 4 * 60_000;
const MAX_LB_PAGES = 4;
/** Leave at least this share of the gateway's per-minute budget to everything else. */
const WEIGHT_CEILING_SHARE = 0.5;
const BUDGET_WAIT_MS = 20_000;
/** A crawl that read fewer accounts than this share is not published. */
const MIN_COVERAGE = 0.5;
/** How long the first-ever request waits for the first crawl. */
const FIRST_WAIT_MS = 15_000;
/** The index's answer is reused this long (the indexer writes its books every 10 s). */
export const INDEX_TTL_MS = 15_000;

/** Progress of the crawl in flight, for the "still computing" message. */
const progress = { tracked: 0, done: 0 };

interface Snapshot {
  at: number;
  tracked: number;
  scanned: number;
  rows: Positioning[];
}

const cache = new TtlCache(4);
const KEY = 'positioning';

async function budgetRoom(): Promise<void> {
  const t0 = Date.now();
  while (gatewayWeightSpent() > gatewayWeightLimit() * WEIGHT_CEILING_SHARE && Date.now() - t0 < BUDGET_WAIT_MS) await sleep(1_000);
}

async function pnlSlice(order: 'asc' | 'desc', n: number): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= MAX_LB_PAGES && out.length < n; page++) {
    const pg = await lbPage('30D', 'pnl', page, 'low', order);
    for (const it of pg.items ?? []) {
      const a = lowerAddress(it.wallet_address);
      if (!a || out.includes(a)) continue;
      seedAddress(it.account_id, a);
      if (out.length < n) out.push(a);
    }
    if ((pg.items?.length ?? 0) < LB_PAGE_SIZE) break;
  }
  return out;
}

/** Top 100 by 30-day PnL, plus the lowest 100 on the published PnL list. */
async function trackedWallets(): Promise<string[]> {
  const [top, worst] = await Promise.all([
    pnlSlice('desc', TRACKED_TOP),
    pnlSlice('asc', TRACKED_WORST),
  ]);
  return [...new Set([...top, ...worst])];
}

async function crawl(): Promise<Snapshot> {
  const wallets = await trackedWallets();
  progress.tracked = wallets.length;
  progress.done = 0;
  const marks = markMap(await markPrices());
  const limiter = new Limiter(3, 150);
  const accounts: Array<{ positions: VsPosition[] }> = [];
  let scanned = 0;

  await Promise.all(
    wallets.map((address) =>
      limiter.run(async () => {
        if (coolingDown()) return;
        await budgetRoom();
        try {
          const st = await perpsState(address);
          scanned++;
          accounts.push({ positions: statePositions(st?.P, marks) });
        } catch {
          // One unreadable wallet does not sink the snapshot; coverage is checked below.
        } finally {
          progress.done++;
        }
      }),
    ),
  );

  if (!wallets.length || scanned < wallets.length * MIN_COVERAGE) {
    throw new Error(
      `SoDEX positioning: read ${scanned} of ${wallets.length} tracked wallets` +
        (coolingDown() ? ' (SoDEX rate limit hit, backing off for a minute)' : ''),
    );
  }
  return { at: Date.now(), tracked: wallets.length, scanned, rows: aggregatePositioning(accounts) };
}

let fromIndex: { at: number; rows: Positioning[] } | null = null;

/**
 * The index's books for the 30-day boards' wallets, summed per market: no
 * request to SoDEX. Null when the index cannot answer yet. `read` and `now`
 * are for tests.
 */
export function indexPositioning(read: () => Holdings | null = () => boardHoldings('sodex'), now = Date.now()): Positioning[] | null {
  if (fromIndex && now - fromIndex.at < INDEX_TTL_MS && now >= fromIndex.at) return fromIndex.rows;
  const h = read();
  if (!h || !h.tracked || h.held < h.tracked * MIN_COVERAGE) return null;
  fromIndex = { at: now, rows: aggregatePositioning(h.traders.map((positions) => ({ positions }))) };
  return fromIndex.rows;
}

/** Tests: forget the index's last answer. */
export function resetIndexPositioning(): void {
  fromIndex = null;
}

export async function positioning(symbol?: string): Promise<Positioning[]> {
  const held = indexPositioning();
  if (held) return symbol ? held.filter((r) => symbolMatches(r.symbol, symbol)) : held;
  if (apiOnly()) {
    throw new NotAvailable("SoDEX positioning is read from the index, which does not hold the 30-day boards' wallets and their positions yet");
  }
  const hit = cache.stale<Snapshot>(KEY);
  let snap: Snapshot;
  if (hit) {
    snap = hit.value;
    if (Date.now() - hit.at > TTL_MS && !cache.isRunning(KEY) && !coolingDown()) {
      void cache.refresh(KEY, crawl).catch(() => {});
    }
  } else {
    const run = cache.refresh(KEY, crawl);
    run.catch(() => {}); // a failure is reported to whoever is waiting, never unhandled
    const first = await within(run, FIRST_WAIT_MS, null);
    if (!first) {
      throw new Error(
        `SoDEX positioning is still being computed (${progress.done} of ${progress.tracked || TRACKED_TOP + TRACKED_WORST} ` +
          'top wallets read, paced to stay inside the shared SoDEX rate limit). Try again in a minute.',
      );
    }
    snap = first;
  }
  return symbol ? snap.rows.filter((r) => symbolMatches(r.symbol, symbol)) : snap.rows;
}
