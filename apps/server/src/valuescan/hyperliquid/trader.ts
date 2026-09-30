/**
 * Hyperliquid trader profile and fill history.
 *
 * COST PER FRESH PROFILE (HL weight, see info.ts): clearinghouseState on the
 * default dex (2) and on the HIP-3 dex "xyz" (2), portfolio (20), and a
 * 2,000-fill sample via userFills aggregateByTime (20 + 1 per 20 fills, so at
 * most 120). About 145 at worst, which is why the assembled profile is cached
 * for PROFILE_TTL_MS and the fill sample for longer.
 *
 * WHAT THE NUMBERS MEAN.
 * - summary: the leaderboard row when the address is listed. That row is
 *   HL's own hourly figure and AGGREGATES the master with its sub-accounts.
 *   Otherwise the summary is built from the account's own `portfolio`.
 * - positions and equity are the queried account only (HL's clearinghouseState
 *   and portfolio are per account, sub-accounts are separate addresses).
 * - winRate, trades, lastActive: from the last 2,000 (time-aggregated) fills,
 *   see fillStats in mappers.ts. For a very active trader that sample can
 *   cover only days; for a quiet one it is the whole history.
 * - maxDrawdown: the 30-day max drawdown from the portfolio equity curves
 *   (flow-neutral returns, max across the day/week/month samplings; see
 *   portfolioMaxDrawdown), not from fills, because fills alone carry no
 *   capital base to measure a drawdown against.
 * - rank / rankChange: position on the leaderboard by 30d PnL, the page's
 *   default ordering.
 */
import { unrefTimer } from '../env.js';
import type { LeaderboardSort, TraderProfile, TraderRow, VsFill, VsPosition, Window } from '../types.js';
import type { InfoLike } from './info.js';
import type { LbSnapshot } from './leaderboard.js';
import {
  fillStats,
  mapFill,
  mapPortfolio,
  mapPositions,
  num,
  portfolioHasActivity,
  portfolioMaxDrawdown,
  summaryFromPortfolio,
} from './mappers.js';
import type { HlClearinghouseState, HlFillRaw, HlPortfolio } from './raw.js';

export const HL_INFO_SOURCE = 'Hyperliquid info API';

const PROFILE_TTL_MS = 20_000;
const STATE_TTL_MS = 10_000;
const PORTFOLIO_TTL_MS = 60_000;
const SAMPLE_TTL_MS = 180_000;
const FILLS_TTL_MS = 15_000;
/**
 * How long a profile waits for a cold leaderboard download (about 7 s for
 * 39 MB) before going without the row. Only hit right after a restart.
 */
const LEADERBOARD_WAIT_MS = 10_000;
/** HIP-3 dex always checked for positions: it carries about a quarter of HL volume. */
const ALWAYS_DEXES = ['', 'xyz'];
/** Other HIP-3 dexes are checked only when the fill sample shows activity there, capped. */
const MAX_EXTRA_DEXES = 4;

/** HL's documented caps: 2,000 fills per response, only the 10,000 most recent reachable. */
export const HL_FILLS_PAGE = 2000;
export const HL_FILLS_REACHABLE = 10_000;

/** Anything that can answer one address's leaderboard row (an LbSnapshot does). */
export interface LbRowSource {
  rowFor(address: string, sort: LeaderboardSort, window: Window, prev: LbSnapshot | null): TraderRow | null;
}

export interface TraderDeps {
  info: InfoLike;
  /**
   * The server passes its HlLeaderboardStore. The browser passes a source that
   * reads just this address's row from the Valuescan index, since the file
   * behind the store is 39 MB.
   */
  leaderboard: {
    snapshot(): Promise<LbRowSource>;
    peek(): LbRowSource | null;
    previous(): LbSnapshot | null;
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => unrefTimer(setTimeout(() => r(null), ms)))]);

async function leaderboardSnapshot(deps: TraderDeps): Promise<LbRowSource | null> {
  return deps.leaderboard.peek() ?? (await withTimeout(deps.leaderboard.snapshot(), LEADERBOARD_WAIT_MS));
}

const settled = <T>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);

function dexOf(coin: string): string {
  const i = coin.indexOf(':');
  return i > 0 ? coin.slice(0, i) : '';
}

const profileCache = new Map<string, { at: number; value: TraderProfile | null }>();
const profileInflight = new Map<string, Promise<TraderProfile | null>>();

/** Profile for one address, or null if it has never done anything on HL. */
export function hlTrader(address: string, deps: TraderDeps): Promise<TraderProfile | null> {
  const a = address.toLowerCase();
  const hit = profileCache.get(a);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return Promise.resolve(hit.value);
  const running = profileInflight.get(a);
  if (running) return running;
  const p = buildProfile(a, deps)
    .then((value) => {
      profileCache.set(a, { at: Date.now(), value });
      if (profileCache.size > 500) {
        for (const [k, v] of profileCache) if (Date.now() - v.at >= PROFILE_TTL_MS) profileCache.delete(k);
      }
      return value;
    })
    .finally(() => profileInflight.delete(a));
  profileInflight.set(a, p);
  return p;
}

const stateBody = (user: string, dex: string) =>
  dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user };

async function buildProfile(address: string, deps: TraderDeps): Promise<TraderProfile | null> {
  const { info } = deps;
  const [lbR, mainR, xyzR, portfolioR, sampleR] = await Promise.allSettled([
    leaderboardSnapshot(deps),
    info.post<HlClearinghouseState>(stateBody(address, ''), { ttlMs: STATE_TTL_MS }),
    info.post<HlClearinghouseState>(stateBody(address, 'xyz'), { ttlMs: STATE_TTL_MS }),
    info.post<HlPortfolio>({ type: 'portfolio', user: address }, { ttlMs: PORTFOLIO_TTL_MS }),
    info.post<HlFillRaw[]>({ type: 'userFills', user: address, aggregateByTime: true }, { ttlMs: SAMPLE_TTL_MS, timeoutMs: 30_000 }),
  ]);
  // The default-dex state is the one read we cannot do without.
  if (mainR.status === 'rejected') throw mainR.reason;
  const main = mainR.value;
  const snap = settled(lbR);
  const portfolio = settled(portfolioR);
  const sampleRaw = settled(sampleR);
  const sample = Array.isArray(sampleRaw) ? sampleRaw : [];

  const states: Array<[string, HlClearinghouseState | null]> = [
    ['', main],
    ['xyz', settled(xyzR)],
  ];
  const extraDexes = [...new Set(sample.map((f) => dexOf(f.coin)))]
    .filter((d) => d && !ALWAYS_DEXES.includes(d))
    .slice(0, MAX_EXTRA_DEXES);
  if (extraDexes.length) {
    const extra = await Promise.allSettled(
      extraDexes.map((d) => info.post<HlClearinghouseState>(stateBody(address, d), { ttlMs: STATE_TTL_MS })),
    );
    extra.forEach((r, i) => states.push([extraDexes[i]!, settled(r)]));
  }

  const positions: VsPosition[] = states
    .flatMap(([dex, st]) => mapPositions(st, dex))
    .sort((a, b) => b.notional - a.notional);
  const perpAv = states.reduce((s, [, st]) => s + (num(st?.marginSummary?.accountValue) ?? 0), 0);

  const lbRow = snap?.rowFor(address, 'pnl', '30d', deps.leaderboard.previous()) ?? null;
  const active = !!lbRow || positions.length > 0 || sample.length > 0 || perpAv !== 0 || portfolioHasActivity(portfolio);
  if (!active) return null;

  const equity = mapPortfolio(portfolio);
  const summary = lbRow ?? summaryFromPortfolio(address, portfolio, perpAv || null);
  const stats = fillStats(sample);
  summary.trades = stats.trades;
  summary.winRate = stats.winRate;
  summary.winRateExact = stats.winRateExact;
  summary.winRateCloses = stats.closes;
  summary.winRateFrom = stats.winRateExact ? null : stats.sampleFrom;
  summary.lastActive = stats.lastActive;
  summary.maxDrawdown = portfolioMaxDrawdown(portfolio);
  summary.sharpe = null;
  const spark = (equity['30d'] ?? []).flatMap((pt) => (pt.pnl === null ? [] : [pt.pnl]));
  if (spark.length) summary.spark = spark;

  const tags: string[] = [];
  if ((summary.accountValue ?? 0) >= 1_000_000) tags.push('whale');
  if (positions.some((p) => (p.leverage ?? 0) >= 20)) tags.push('high-leverage');
  if (tags.length) summary.tags = tags;

  return {
    summary,
    positions,
    equity,
    openOrders: null,
    updatedAt: Date.now(),
    source: lbRow ? `${HL_INFO_SOURCE} + leaderboard` : HL_INFO_SOURCE,
  };
}

// --- fills ---------------------------------------------------------------------

/**
 * Fill history, newest first: the newest `limit` fills in [from, to].
 *
 * HL serves at most 2,000 fills per response and only the 10,000 most recent
 * per address at all (userFillsByTime pages ASCENDING from startTime). So:
 * 1. One `userFills` call (newest 2,000). If that already reaches back past
 *    `from`, or holds `limit` fills at or before `to`, it is the answer.
 * 2. Otherwise page forward with userFillsByTime from `from` (or 0) to the
 *    oldest fill already held, at most 5 pages, deduping by tid (a page
 *    boundary can split fills that share one millisecond).
 * `limit` is clamped to 10,000 because nothing older is reachable.
 */
export async function hlFills(
  info: InfoLike,
  address: string,
  o: { from?: number; to?: number; limit?: number },
): Promise<VsFill[]> {
  const user = address.toLowerCase();
  const limit = Math.min(HL_FILLS_REACHABLE, Math.max(1, Math.trunc(o.limit ?? HL_FILLS_PAGE)));
  // HL takes integer ms (a float or negative startTime is a 422).
  const from = o.from !== undefined && Number.isFinite(o.from) ? Math.max(0, Math.trunc(o.from)) : undefined;
  const to = o.to !== undefined && Number.isFinite(o.to) ? Math.max(0, Math.trunc(o.to)) : undefined;
  const inRange = (f: HlFillRaw) => (from === undefined || f.time >= from) && (to === undefined || f.time <= to);

  const got0 = await info.post<HlFillRaw[]>({ type: 'userFills', user }, { ttlMs: FILLS_TTL_MS, timeoutMs: 30_000 });
  const recent = Array.isArray(got0) ? got0 : [];
  const byTid = new Map<number, HlFillRaw>();
  for (const f of recent) byTid.set(f.tid, f);

  const oldest = recent.reduce((m, f) => Math.min(m, f.time), Number.POSITIVE_INFINITY);
  const complete =
    recent.length < HL_FILLS_PAGE || // the whole reachable history fits in one page
    (from !== undefined && from > oldest) ||
    recent.filter(inRange).length >= limit;

  if (!complete) {
    let start = from ?? 0;
    const end = Math.min(to ?? Number.POSITIVE_INFINITY, oldest);
    for (let page = 0; page < HL_FILLS_REACHABLE / HL_FILLS_PAGE && start <= end; page++) {
      const got = await info.post<HlFillRaw[]>(
        { type: 'userFillsByTime', user, startTime: start, endTime: end, aggregateByTime: false },
        { ttlMs: FILLS_TTL_MS, timeoutMs: 30_000 },
      );
      if (!Array.isArray(got) || !got.length) break;
      let maxT = start;
      for (const f of got) {
        byTid.set(f.tid, f);
        if (f.time > maxT) maxT = f.time;
      }
      if (got.length < HL_FILLS_PAGE) break;
      // Next page starts AT the last timestamp (inclusive, deduped by tid). If a
      // full page did not advance time at all, stepping 1 ms is the only way on.
      start = maxT > start ? maxT : start + 1;
    }
  }

  return [...byTid.values()]
    .filter(inRange)
    .sort((a, b) => b.time - a.time || b.tid - a.tid)
    .slice(0, limit)
    .map(mapFill);
}
