/**
 * /api/vs/*: the multi-venue trader API behind Explore, Leaderboard, Scan and Copy.
 *
 * This file only validates, dispatches and merges. Every venue-specific fetch,
 * cache and rate budget lives in its provider (valuedesk/sodex,
 * valuedesk/hyperliquid). Failures come back as HTTP 200 {ok:false,...}, the
 * same convention routes/scan.ts uses, so one venue being down renders as a
 * per-section message rather than a blanked page.
 *
 *   GET /api/vs/leaderboard?venue=all|sodex|hyperliquid&window=1d|7d|30d|all&sort=pnl|roi|volume|accountValue&limit&offset&q&side=top|worst&curves=1
 *   GET /api/vs/explore
 *   GET /api/vs/trader?venue&address
 *   GET /api/vs/fills?venue&address&from&to&limit
 *   GET /api/vs/whales?venue=all|..&minUsd&limit
 *   GET /api/vs/positioning?venue=all|..&symbol
 *   GET /api/vs/news?feed&category&coin&q&page&limit&topic&posts&history   (SoSoValue; coin is one or several, comma-separated; topic=macro for economics; posts=all keeps every post; history=1 the chart's: the feed as far back as kept, up to 300, hot ones ranked; SOSOVALUE_API_KEY, else not_available)
 *   GET /api/vs/news/sources?ids=whitehouse&coin&q&limit   (news from other sources' RSS feeds, newest first - valuedesk/feeds.ts)
 *   GET /api/vs/logo?domain   (a news source's site icon, read and cached here so the page asks only this origin)
 *   GET /api/vs/calendar?from&to   (the economic calendar: the Fed, BLS, BEA and SoSoValue - valuedesk/calendar.ts)
 *   GET /api/vs/calendar/results?ids=a,b   (official results of up to 50 calendar events, read at the release second - valuedesk/releases.ts)
 *   GET /api/vs/fed/live   (the Federal Reserve's current broadcast: its Brightcove HLS stream)
 *   GET /api/vs/fedwatch   (the coming FOMC meetings' decision probabilities: Kalshi, Polymarket beside - valuedesk/fedwatch.ts)
 *   GET /api/vs/fedwatch/history?meeting=YYYY-MM-DD&range=7d|30d|90d   (one meeting's probabilities over time, Kalshi's candlesticks)
 *   GET /api/vs/indicators   (the catalog of the calendar's indicators - valuedesk/indicators.ts)
 *   GET /api/vs/indicator?id&range=1y|5y|10y|max   (one indicator's history from its agency, its table and next release)
 *   GET /api/vs/etf/flows?asset=BTC|ETH|SOL..&range=1m|3m|1y|all   (US spot ETF flows and funds, SoSoValue - valuedesk/sosovalue/etf.ts; SOSOVALUE_API_KEY, else not_available)
 *   GET /api/vs/oracle?coin=BTC&venues=a,b   (the shared price oracle over 19 venues - routes/oracle.ts)
 *   GET /api/vs/live?channel   (one of the Live Feed's YouTube channels: its stream on air; YOUTUBE_API_KEY, else not_available)
 *   GET /api/vs/screener?...   (query owned by valuedesk/screener.ts)
 *   GET /api/vs/lbrow?venue=hyperliquid&address   (one leaderboard row from the index)
 *   GET /api/vs/index/status   (the indexer's full diagnostics; never on a hosted server)
 *   GET /api/vs/index/health   (its health in numbers, for monitoring on the instance)
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CORE_VENUES,
  NotAvailable,
  VENUES,
  WINDOWS,
  type LeaderboardResponse,
  type LeaderboardSort,
  type TraderRow,
  type Venue,
  type VenueProvider,
  type Window,
} from '../valuedesk/types.js';
import { sodexProvider } from '../valuedesk/sodex/index.js';
import { hlInfo, hlLeaderboardRow, hyperliquidProvider } from '../valuedesk/hyperliquid/index.js';
import { hlPriceSeries } from '../valuedesk/hyperliquid/price.js';
import { ACCOUNT_DETAIL, arcusProvider, lighterProvider, nameSpotFills, tradexyzProvider } from '../valuedesk/extra/providers.js';
import { applyCachedCurves, attachPodiumCurves } from '../valuedesk/curves.js';
import { attachStats, boardPage, cohortDetail, cohortFocus, cohortMap, cohortWallets, cohortsReady, cohortsRead, excludedNow, indexerStatus, netPage } from '../indexer/read.js';
import { isCohortId, isSector, type CohortFilter, type CohortRange, type WalletSort } from '../valuedesk/cohorts/model.js';
import { fineAskOf, fineDrawOf, isLiqRange, levFilterOf, liqAt, liqHeatmap, liqHeatmapFine, liqHeatmapOf, liqHistory, liqHistoryFine, liqWallets, walletHistoryFine, walletLiqs } from '../indexer/liqRead.js';
import { TILE_FINAL_CACHE, TILE_INDEX_CACHE, TILE_WALLET_CACHE, liqTile, liqTileIndex, liqTileIndexOf, liqTileOf, tileAskOf } from '../indexer/liqTiles.js';
import { watchAddresses } from '../indexer/host.js';
import { MAX_WINDOW_MS, flowWalletFills, flowWindow, type MarketKind } from '../flow/read.js';
import type { FlowRole, FlowSide, FlowSort } from '../flow/codec.js';
import { BOARD_WINDOWS, type BoardWindow } from '../valuedesk/types.js';
import { buildExplore, keepExploreWarm } from '../valuedesk/explore.js';
import { buildScreener, keepScreenerWarm } from '../valuedesk/screener.js';
import { scrubDeep, scrubLabels, shownLabel } from '../valuedesk/labels.js';
import { COHORT_RANGES, WALLET_SORTS, type CohortRange as WalletRange } from '../valuedesk/cohorts/model.js';
import { indexerHealth } from '../hosted.js';
import { news, newsKey, parseNewsQuery } from '../valuedesk/sosovalue/news.js';
import { feedNews, logoDomain, parseFeedQuery, siteLogo } from '../valuedesk/feeds.js';
import { SOURCE_NAME, calendar, parseCalendarQuery } from '../valuedesk/calendar.js';
import { LIVE_CHANNELS, liveVideo, youtubeKey } from '../valuedesk/youtube/live.js';
import { fedLive, releaseResults } from '../valuedesk/releases.js';
import { FOMC_ODDS_OFF, fedWatch, fedWatchHistory, fomcOddsEnabled, parseFedHistoryRange } from '../valuedesk/fedwatch.js';
import { INDICATORS, indicator, indicatorList, parseIndicatorRange } from '../valuedesk/indicators.js';
import { etfFlows, parseEtfAsset, parseEtfRange } from '../valuedesk/sosovalue/etf.js';
import { oracleRoutes } from './oracle.js';

const PROVIDERS: Record<Venue, VenueProvider> = {
  sodex: sodexProvider,
  hyperliquid: hyperliquidProvider,
  tradexyz: tradexyzProvider,
  lighter: lighterProvider,
  arcus: arcusProvider,
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SORTS: readonly LeaderboardSort[] = ['pnl', 'roi', 'volume', 'accountValue'];

type Q = Record<string, string | undefined>;

/** `venues=a,b` for the cohorts: every venue when none (or none known) is named. */
function cohortFilter(q: Q): CohortFilter {
  const coin = q.coin?.trim().toUpperCase();
  if (coin && /^[A-Z0-9]{1,20}$/.test(coin)) return { coin };
  return isSector(q.sector) ? { sector: q.sector } : {};
}

function cohortVenues(q: Q): Venue[] {
  const listed = (q.venues ?? '').split(',').map((v) => v.trim().toLowerCase()).filter((v): v is Venue => (VENUES as readonly string[]).includes(v));
  return listed.length ? [...new Set(listed)] : [...VENUES];
}

/** `wallets=0x..,0x..` for the liquidation heatmap's wallet filter: up to 10 addresses, lower-cased; anything else is left out. */
function walletsOf(q: Q): string[] {
  const list = (q.wallets ?? '').split(',').map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  return [...new Set(list)].slice(0, 10);
}

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

/** Cache-Control for the trade flow: a window that has passed never changes; one still forming moves every flush (15 s). */
const FLOW_FINAL_CACHE = 'public, max-age=86400, stale-while-revalidate=86400';
const FLOW_LIVE_CACHE = 'public, max-age=10, stale-while-revalidate=10';

/** coin=, venues=, kind=, from=, to= (ms) of a trade flow read. */
function flowWindowOf(q: Q): { coin: string; venues: Venue[]; kind: MarketKind; from: number; to: number } {
  const coin = (q.coin ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(coin)) throw bad('coin= is required');
  const from = Math.floor(Number(q.from));
  const to = Math.floor(Number(q.to));
  if (!(from > 0) || !(to > from)) throw bad('from= and to= must be a time range in ms');
  if (to - from > MAX_WINDOW_MS) throw bad('the window is longer than 400 days');
  return { coin, venues: cohortVenues(q), kind: q.kind === 'spot' ? 'spot' : 'perp', from, to: Math.min(to, Date.now() + 60_000) };
}

function venueOf(q: Q, allowAll: true): Venue | 'all';
function venueOf(q: Q, allowAll: false): Venue;
function venueOf(q: Q, allowAll: boolean): Venue | 'all' {
  const v = (q.venue ?? (allowAll ? 'all' : '')).toLowerCase();
  if (allowAll && v === 'all') return 'all';
  if ((VENUES as readonly string[]).includes(v)) return v as Venue;
  throw bad(`venue must be one of ${allowAll ? 'all, ' : ''}${VENUES.join(', ')}`);
}

function addressOf(q: Q): string {
  if (!q.address || !ADDRESS_RE.test(q.address)) throw bad('a valid 0x wallet address is required');
  return q.address.toLowerCase();
}

function intOf(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? dflt : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function numOf(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function fail(reply: FastifyReply, e: unknown) {
  const err = e as Error & { statusCode?: number };
  if (err.statusCode === 400) return reply.code(400).send({ ok: false, error: err.message });
  const code = e instanceof NotAvailable ? 'not_available' : 'upstream';
  return reply.code(200).send({ ok: false, code, error: err.message });
}

/** Sort key for merging rows from several venues into one ranking. */
function sortValue(r: TraderRow, sort: LeaderboardSort, window: Window): number {
  const v =
    sort === 'accountValue' ? r.accountValue
    : sort === 'pnl' ? r.pnl[window]
    : sort === 'roi' ? r.roi[window]
    : r.volume[window];
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

/** Explore and the screener's pools built before their first visitor and kept built while visited (index.ts, after the start). */
export function keepValuedeskWarm(): () => void {
  const core = CORE_VENUES.map((v) => PROVIDERS[v]);
  const stops = [keepExploreWarm(core), keepScreenerWarm(core)];
  return () => { for (const stop of stops) stop(); };
}

export async function valuedeskRoutes(app: FastifyInstance) {
  oracleRoutes(app);
  app.get('/api/vs/leaderboard', async (req, reply) => {
    try {
      const q = req.query as Q;
      const venue = venueOf(q, true);
      const window: BoardWindow = (BOARD_WINDOWS as readonly string[]).includes(q.window ?? '') ? (q.window as BoardWindow) : '30d';
      const sort = (SORTS as readonly string[]).includes(q.sort ?? '') ? (q.sort as LeaderboardSort) : 'pnl';
      const limit = intOf(q.limit, 50, 1, 500);
      const offset = intOf(q.offset, 0, 0, 1_000_000);
      const search = q.q?.trim() || undefined;
      const side = q.side === 'worst' ? 'worst' : 'top';
      const minTrades = q.minTrades === '2' ? 2 : 0;
      const published = (WINDOWS as readonly string[]).includes(window);
      // The PnL hundreds (top and worst, every window, with or without the
      // trade filter) are built by the indexer; this is one read of its file.
      if (sort === 'pnl' || side === 'worst' || !published) {
        const filter = minTrades > 0 ? 'active' : 'any';
        // `venues=a,b` picks any set of venues; `view=net` (the default for
        // more than one) sums each address over them, `view=single` ranks
        // each venue's rows side by side. The older `venue=` still works.
        const listed = (q.venues ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((v): v is Venue => (VENUES as readonly string[]).includes(v));
        const set: Venue[] = listed.length ? [...new Set(listed)] : venue === 'all' ? [...VENUES] : [venue];
        const net = set.length > 1 && (q.view ?? (listed.length ? 'net' : 'single')) === 'net';
        const opts = { limit: Math.min(limit, 100), offset, q: search };
        const page = net ? netPage(set, window, side, filter, opts) : boardPage(set, window, side, filter, opts);
        if (page) {
          // The rows on screen are read before anything else (indexer WATCH_PRIO).
          for (const v of set) {
            const onPage = page.rows.filter((r) => (r.venues ?? [r.venue]).includes(v)).map((r) => r.address);
            if (onPage.length) watchAddresses(v, onPage, window);
          }
          if (published && offset === 0) {
            // A netted row's curve is its venues' curves summed (curves.ts fillNet).
            applyCachedCurves(page.rows, window as Window);
            if (q.curves === '1') await attachPodiumCurves(page.rows, window as Window);
          }
          return { ok: true, venue, window, sort: 'pnl' as const, ...page };
        }
        // No board yet: the plain top list can still come from the venue.
        if (minTrades > 0 || side === 'worst' || !published) {
          return {
            ok: true,
            venue,
            window,
            sort: 'pnl' as const,
            rows: [],
            total: 0,
            updatedAt: Date.now(),
            source: 'ValueDesk index is starting. The board fills as traders are read.',
            index: { complete: false, pending: 0, updatedAt: 0 },
          };
        }
      }
      // Everything below is a published window (1d / 7d / 30d / all).
      const w = window as Window;
      // Only the top side of a venue list gets here (worst is always an index board).
      const sortKey: LeaderboardSort = sort;
      const capped = limit;
      const curves = q.curves === '1';
      const paint = async (rows: TraderRow[]) => {
        scrubLabels(rows);
        applyCachedCurves(rows, w);
        if (curves) await attachPodiumCurves(rows, w);
        attachStats(rows, w);
        watchAddresses('hyperliquid', rows.filter((r) => r.venue === 'hyperliquid').map((r) => r.address));
      };

      if (venue !== 'all') {
        const page = await PROVIDERS[venue].leaderboard({ window: w, sort: sortKey, limit: capped, offset, q: search, side });
        await paint(page.rows);
        const body: LeaderboardResponse = { venue, window: w, sort: sortKey, ...page };
        return { ok: true, ...body };
      }

      // venue=all: take the top (offset+limit) of each venue, merge by the sort
      // key, then slice. Exact for the first pages, which is what the UI shows.
      const need = offset + capped;
      const pages = await Promise.allSettled(
        CORE_VENUES.map((v) => PROVIDERS[v].leaderboard({ window: w, sort: sortKey, limit: need, offset: 0, q: search, side })),
      );
      const ok = pages.flatMap((p) => (p.status === 'fulfilled' ? [p.value] : []));
      if (!ok.length) throw (pages[0] as PromiseRejectedResult).reason;
      const merged = ok
        .flatMap((p) => p.rows)
        .sort((a, b) => sortValue(b, sortKey, w) - sortValue(a, sortKey, w))
        .slice(offset, offset + capped)
        .map((r, i) => ({ ...r, rank: offset + i + 1 }));
      await paint(merged);
      const body: LeaderboardResponse = {
        venue: 'all',
        window: w,
        sort: sortKey,
        rows: merged,
        total: ok.reduce((s, p) => s + p.total, 0),
        updatedAt: Math.min(...ok.map((p) => p.updatedAt)),
        source: ok.map((p) => p.source).join(' + '),
      };
      const failed = pages.flatMap((p, i) => (p.status === 'rejected' ? [CORE_VENUES[i]] : []));
      return { ok: true, ...body, partial: failed.length ? failed : undefined };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * SoSoValue news (the News widget, Explore): the latest, hot or featured list,
   * by type and coin, or a keyword search - sosovalue/news.ts. The key stays on
   * this process. Without it the widget is told the feed is not available,
   * rather than shown made-up rows.
   */
  app.get('/api/vs/news', async (req, reply) => {
    try {
      if (!newsKey()) throw new NotAvailable('SoSoValue news is not configured');
      const page = await news(parseNewsQuery(req.query as Record<string, unknown>));
      return { ok: true, ...page, source: 'SoSoValue' };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * News from sources beside SoSoValue (the White House), read from
   * their RSS feeds and cached - valuedesk/feeds.ts. The widget merges them in.
   */
  app.get('/api/vs/news/sources', async (req, reply) => {
    try {
      const items = await feedNews(parseFeedQuery(req.query as Record<string, unknown>));
      return { ok: true, items };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** A news source's site icon (feeds.ts siteLogo), a week in the browser; 404 when the site has none. */
  app.get('/api/vs/logo', async (req, reply) => {
    const domain = logoDomain((req.query as Record<string, unknown>).domain);
    if (!domain) return reply.code(400).send({ ok: false, error: 'domain is not a hostname' });
    const logo = await siteLogo(domain);
    if (!logo.body) return reply.code(404).header('cache-control', 'public, max-age=86400').send({ ok: false, error: 'no icon' });
    return reply.header('content-type', logo.type).header('cache-control', 'public, max-age=604800, stale-while-revalidate=2592000').send(logo.body);
  });

  /**
   * The economic calendar (the chart's news layer, the News widget's Calendar):
   * the FOMC's meetings, BLS and BEA releases and SoSoValue's macro events,
   * each source read at most twice a day - valuedesk/calendar.ts. A source
   * that does not answer is left out and said so in `sources`.
   */
  app.get('/api/vs/calendar', async (req, reply) => {
    try {
      const { from, to } = parseCalendarQuery(req.query as Record<string, unknown>);
      const page = await calendar(from, to);
      return { ok: true, ...page, sourceNames: SOURCE_NAME };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * The official results of calendar events (`ids`, comma-separated, the first
   * 50 kept): what the release watcher read from the publisher's page at the
   * release second, and the prior release's figures (valuedesk/releases.ts).
   * An id the watcher has nothing on yet is 'scheduled', with the prior values
   * when known. An edge may keep it a second while a release is near, else 30 s.
   */
  app.get('/api/vs/calendar/results', async (req, reply) => {
    const raw = String((req.query as Q).ids ?? '');
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 50);
    const now = Date.now();
    const { results, hot } = releaseResults(ids, now);
    reply.header('Cache-Control', hot ? 'public, max-age=0, s-maxage=1' : 'public, max-age=0, s-maxage=30');
    return { ok: true, now, results };
  });

  /**
   * The Federal Reserve's current broadcast (FOMC press conferences, testimony):
   * the video its live-broadcast page embeds, as an HLS stream from Brightcove's
   * playback API, read at most every 15 s (valuedesk/releases.ts fedLive). The
   * stream URLs carry expiring tokens, so an edge keeps the answer 10 s at most.
   */
  app.get('/api/vs/fed/live', async (_req, reply) => {
    try {
      const live = await fedLive();
      reply.header('Cache-Control', 'public, max-age=0, s-maxage=10');
      return { ok: true, ...live };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * What the markets expect of the FOMC (valuedesk/fedwatch.ts): the next
   * meetings, nearest first, each decision's probability from Kalshi's order
   * books, Polymarket's beside where its meeting matches, and the target range
   * each would leave. Read at most once a minute, whoever asks.
   */
  app.get('/api/vs/fedwatch', async (_req, reply) => {
    try {
      // Off until Kalshi / Polymarket license their prices in writing (fedwatch.ts header).
      if (!fomcOddsEnabled()) throw new NotAvailable(FOMC_ODDS_OFF);
      const page = await fedWatch();
      reply.header('Cache-Control', 'public, max-age=0, s-maxage=30');
      return { ok: true, ...page };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** One meeting's probabilities over `range` (Kalshi's hourly candles for 7d, daily for 30d / 90d), cached 10 minutes. */
  app.get('/api/vs/fedwatch/history', async (req, reply) => {
    try {
      const q = req.query as Q;
      const meeting = String(q.meeting ?? '');
      if (!fomcOddsEnabled()) throw new NotAvailable(FOMC_ODDS_OFF);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(meeting)) throw bad('meeting must be YYYY-MM-DD');
      const range = parseFedHistoryRange(q.range);
      const series = await fedWatchHistory(meeting, range);
      if (!series) throw new NotAvailable('Not one of the coming FOMC meetings');
      reply.header('Cache-Control', 'public, max-age=0, s-maxage=300');
      return { ok: true, meeting, range, series };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** The indicators the calendar's releases publish, each with its kind and release-card field (valuedesk/indicators.ts). */
  app.get('/api/vs/indicators', async () => ({ ok: true, indicators: indicatorList() }));

  /**
   * One indicator's history from the agency that publishes it (read at most every 6 hours, sooner
   * after a release of its kind): the chart's points over `range`, the last
   * 24 periods with their priors, and the next release on the calendar.
   */
  app.get('/api/vs/indicator', async (req, reply) => {
    try {
      const q = req.query as Q;
      const id = String(q.id ?? '');
      if (!INDICATORS[id]) throw new NotAvailable('Not one of the indicators');
      const page = await indicator(id, parseIndicatorRange(q.range));
      reply.header('Cache-Control', 'public, max-age=0, s-maxage=300');
      return { ok: true, ...page! };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * US spot ETF flows for an asset from SoSoValue (valuedesk/sosovalue/etf.ts):
   * the daily totals over `range` (SoSoValue gives a month; older days are the
   * ones this server kept) and the funds by size. Without the key: not_available.
   */
  app.get('/api/vs/etf/flows', async (req, reply) => {
    try {
      if (!newsKey()) throw new NotAvailable('SoSoValue ETF data is not configured');
      const q = req.query as Q;
      const page = await etfFlows(parseEtfAsset(q.asset), parseEtfRange(q.range));
      reply.header('Cache-Control', 'public, max-age=0, s-maxage=300');
      return { ok: true, ...page, source: 'SoSoValue' };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * The video one of the Live Feed's YouTube channels has on air, or null - asked of
   * the YouTube Data API with this server's key, cached per channel
   * (valuedesk/youtube/live.ts). No key, or not one of the widget's channels: not_available.
   */
  app.get('/api/vs/live', async (req, reply) => {
    try {
      const channel = String((req.query as Q).channel ?? '');
      if (!LIVE_CHANNELS.has(channel)) throw new NotAvailable("Not one of the Live Feed's channels");
      if (!youtubeKey()) throw new NotAvailable('The live lookup is not configured on this server (YOUTUBE_API_KEY)');
      return { ok: true, channel, video: await liveVideo(channel) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * Indexer diagnostics: lanes, streams, last board build - everything the
   * indexer publishes, wallet addresses and error text included. Local only: a
   * hosted server answers 404 to every caller (hosted.ts HOSTED_ROUTES).
   */
  app.get('/api/vs/index/status', async () => ({ ok: true, status: indexerStatus() }));

  /**
   * The indexer's health, for monitoring: which streams are up, the loop lag,
   * each lane's counts, the last build. Numbers and booleans only - the
   * projection (hosted.ts indexerHealth) picks each field by name, so no wallet
   * address, error text, path or pid can leave with it. `status` is null while
   * no status has been published (no index file, or an indexer that never ran).
   *
   * A hosted server answers it to a caller on the instance only (hosted.ts
   * ON_INSTANCE_ROUTES); through the proxy it is a 404.
   */
  app.get('/api/vs/index/health', async () => ({ ok: true, status: indexerHealth(indexerStatus()) }));

  /** Cohorts for `venues=a,b` (netted over them; all venues when none is named), `sector=` / `coin=` filters. */
  app.get('/api/vs/cohorts', async (req, reply) => {
    try {
      const q = req.query as Q;
      await cohortsReady();
      const body = cohortsRead(cohortVenues(q), cohortFilter(q));
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * Liquidation levels of `coin` over `venues` (indexer/liqRead.ts): the engine's 0.02% buckets,
   * with each venue's coverage and accuracy. `step=` with `from=` / `to=`: buckets of that width
   * over that window, exact from the books (liqHeatmapFine; at most FINE_MAX_BUCKETS in the
   * window), with `side=` long / short and `lev=low,mid,high` besides `wallets=`.
   */
  app.get('/api/vs/liquidations', async (req, reply) => {
    try {
      const q = req.query as Q;
      const coin = cohortFilter(q).coin;
      if (!coin) throw bad('coin= is required');
      const ws = walletsOf(q);
      const fine = fineAskOf(q);
      if (typeof fine === 'string') throw bad(fine);
      // The wallet filter and exact steps read the cohort load: never an old one (read.ts STALE_MAX_MS).
      if (ws.length || fine) await cohortsReady();
      const side = q.side === 'long' || q.side === 'short' ? q.side : null;
      const body = fine ? await liqHeatmapFine(coin, cohortVenues(q), fine, { wallets: new Set(ws), side, lev: levFilterOf(q.lev) })
        : ws.length ? await liqHeatmapOf(coin, cohortVenues(q), ws) : await liqHeatmap(coin, cohortVenues(q));
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** The wallets whose `side` (long / short) of `coin` liquidates in [`from`, `to`); `lev=low,mid,high`: only those leverage bands. */
  app.get('/api/vs/liquidations/wallets', async (req, reply) => {
    try {
      const q = req.query as Q;
      const coin = cohortFilter(q).coin;
      const from = Number(q.from);
      const to = Number(q.to);
      if (!coin) throw bad('coin= is required');
      if (q.side !== 'long' && q.side !== 'short') throw bad('side= must be long or short');
      if (!(from >= 0) || !(to > from)) throw bad('from= and to= must be a price range');
      await cohortsReady();
      const body = await liqWallets(coin, cohortVenues(q), q.side, from, to, 25, walletsOf(q), levFilterOf(q.lev));
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Every open position of `wallets=` (up to 10) on `venues`, every coin, with its liquidation price. */
  app.get('/api/vs/liquidations/positions', async (req, reply) => {
    try {
      const q = req.query as Q;
      const ws = walletsOf(q);
      if (!ws.length) throw bad('wallets= is required: up to 10 0x addresses, comma separated');
      await cohortsReady();
      const body = await walletLiqs(ws, cohortVenues(q));
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, wallets: ws, asOf: body.asOf, positions: body.positions };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * `coin`'s liquidation levels over `range` (1d / 7d / 30d): the indexer's 15-minute snapshots.
   * With `step=` `from=` `to=` (a price window, at most FINE_MAX_BUCKETS of the step) and `t0=`
   * `t1=` (ms): the snapshots' fine layers in that window instead (liqRead.ts liqHistoryFine).
   */
  app.get('/api/vs/liquidations/history', async (req, reply) => {
    try {
      const q = req.query as Q;
      const coin = cohortFilter(q).coin;
      if (!coin) throw bad('coin= is required');
      const ws = walletsOf(q);
      const fine = fineAskOf(q);
      if (typeof fine === 'string') throw bad(fine);
      if (fine) {
        const t0 = Number(q.t0);
        // A tile still filling (`v=`: the index's newest snapshot the view draws from) ends there: a
        // snapshot written since is not in the view's list yet, and would be the bar's one in its
        // place - that column at its own step until the index caught up - and the answer kept for
        // the URL would change under it.
        const v = q.v === undefined || q.v === '' ? Number.NaN : Number(q.v);
        if (!(t0 > 0) || !(Number(q.t1) >= t0)) throw bad('t0= and t1= must be a time range in ms with step=');
        // Before the tile (none listed in it yet): an empty answer, not a range error.
        const t1 = Number.isFinite(v) ? Math.max(t0 - 1, Math.min(Number(q.t1), v)) : Number(q.t1);
        // Some wallets: their positions from the change log at each snapshot the index lists, as at
        // the snapshots' own step (liqRead.ts walletHistoryFine); kept as the wallet tiles are.
        if (ws.length) {
          const draw = fineDrawOf(q, fine.step);
          if (typeof draw === 'string') throw bad(draw);
          const venues = cohortVenues(q);
          const idx = await liqTileIndex(coin, venues);
          const body = walletHistoryFine(coin, venues, ws, (idx?.points ?? []).filter((x) => x.t >= t0 && x.t <= t1), fine, draw);
          if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
          reply.header('Cache-Control', TILE_WALLET_CACHE);
          return { ok: true, ...body };
        }
        // A tile of the historical view (`every=` / `pool=`, liqRead.ts FineDraw): one ending before
        // the slot still filling (no `v=`) never changes, and is kept a day as the snapshots' tiles are.
        const draw = fineDrawOf(q, fine.step);
        if (typeof draw === 'string') throw bad(draw);
        const body = liqHistoryFine(coin, cohortVenues(q), t0, t1, fine, draw);
        if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
        if (draw) reply.header('Cache-Control', q.v === undefined && t1 < Date.now() - 30 * 60_000 ? TILE_FINAL_CACHE : TILE_INDEX_CACHE);
        return { ok: true, ...body };
      }
      const body = liqHistory(coin, cohortVenues(q), isLiqRange(q.range) ? q.range : '1d', ws);
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * The history in tiles (indexer/liqTiles.ts), every wallet or `wallets=` (up to 10): without `tt=`, the index - every
   * snapshot's time, price and step over 30 days and the colour scale per filter; with `tl= tt=
   * pl= band= bw=` (and `v=` for the slot still filling), the rows of one time slot and price band.
   * A final tile is kept a day, the rest a minute (perf.ts `own`).
   */
  app.get('/api/vs/liquidations/tiles', async (req, reply) => {
    try {
      const q = req.query as Q;
      const coin = cohortFilter(q).coin;
      if (!coin) throw bad('coin= is required');
      // Some wallets: their history rebuilt once and cut into the same tiles (liqTiles.ts liqTileIndexOf).
      const ws = walletsOf(q);
      if (q.tt === undefined) {
        const body = ws.length ? await liqTileIndexOf(coin, cohortVenues(q), ws) : await liqTileIndex(coin, cohortVenues(q));
        if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
        reply.header('Cache-Control', ws.length ? TILE_WALLET_CACHE : TILE_INDEX_CACHE);
        return { ok: true, ...body };
      }
      const ask = tileAskOf(q);
      if (typeof ask === 'string') throw bad(ask);
      const body = ws.length ? await liqTileOf(coin, cohortVenues(q), ws, ask) : await liqTile(coin, cohortVenues(q), ask);
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      reply.header('Cache-Control', ws.length ? TILE_WALLET_CACHE : body.final ? TILE_FINAL_CACHE : TILE_INDEX_CACHE);
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * Who sat in one cell of the history: `coin`'s positions liquidating in [`from`, `to`) at time `t`
   * (ms), `side` long / short / both, by the change log - level, size, entry, mark, margin, account,
   * since when and what happened next (indexer/liqRead.ts liqAt); `lev=low,mid,high`: only those leverage bands.
   */
  app.get('/api/vs/liquidations/at', async (req, reply) => {
    try {
      const q = req.query as Q;
      const coin = cohortFilter(q).coin;
      const t = Number(q.t);
      const from = Number(q.from);
      const to = Number(q.to);
      if (!coin) throw bad('coin= is required');
      if (!(t > 0) || t > Date.now() + 60_000) throw bad('t= must be a time in ms, not in the future');
      if (!(from >= 0) || !(to > from)) throw bad('from= and to= must be a price range');
      const side = q.side === 'long' || q.side === 'short' ? q.side : 'both';
      const body = liqAt(coin, cohortVenues(q), t, from, to, side, walletsOf(q), 100, levFilterOf(q.lev));
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * Who traded `coin` in [`from`, `to`) (ms): every wallet's volume, buys and sells, average prices,
   * fills, lean and taker share, ranked (flow/read.ts). `venues=` as the cohorts, `kind=perp|spot`,
   * `role=all|taker|maker`, `side=all|buy|sell`, `sort=volume|fills|net|buy|sell`, `limit=` (<= 500),
   * `q=` an address or account id to look for. A window that has passed is kept a day.
   */
  app.get('/api/vs/flow', async (req, reply) => {
    try {
      const q = req.query as Q;
      const ask = flowWindowOf(q);
      const role: FlowRole = q.role === 'taker' || q.role === 'maker' ? q.role : 'all';
      const side: FlowSide = q.side === 'buy' || q.side === 'sell' ? q.side : 'all';
      const sort: FlowSort = q.sort === 'fills' || q.sort === 'net' || q.sort === 'buy' || q.sort === 'sell' ? q.sort : 'volume';
      const limit = Math.max(1, Math.min(500, Math.floor(Number(q.limit) || 100)));
      const search = (q.q ?? '').trim().slice(0, 64);
      const body = await flowWindow({ ...ask, role, side, sort, limit, ...(search.length >= 3 ? { q: search } : {}) });
      if (!body) return fail(reply, new NotAvailable('The trade flow is not recorded yet'));
      reply.header('Cache-Control', body.final ? FLOW_FINAL_CACHE : FLOW_LIVE_CACHE);
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** One wallet's fills of `coin` in [`from`, `to`): time, price, size, side, taker or maker, counterparty (`w=` address or account id, `venue=` one venue's account). */
  app.get('/api/vs/flow/wallet', async (req, reply) => {
    try {
      const q = req.query as Q;
      const ask = flowWindowOf(q);
      const w = (q.w ?? '').trim();
      if (!/^(0x[0-9a-fA-F]{40}|\d{1,12})$/.test(w)) throw bad('w= must be an address or an account id');
      const venue = (VENUES as readonly string[]).includes(q.venue ?? '') ? (q.venue as Venue) : undefined;
      const body = await flowWalletFills({ ...ask, wallet: w, ...(venue ? { venue } : {}) });
      if (!body) return fail(reply, new NotAvailable('The trade flow is not recorded yet'));
      reply.header('Cache-Control', body.final ? FLOW_FINAL_CACHE : FLOW_LIVE_CACHE);
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** One cohort: its lean over `range` (1d / 7d / 30d) and every market it holds. */
  app.get('/api/vs/cohorts/detail', async (req, reply) => {
    try {
      const q = req.query as Q;
      if (!isCohortId(q.cohort)) return fail(reply, new NotAvailable('Unknown cohort'));
      const range: CohortRange = q.range === '1d' || q.range === '30d' ? q.range : '7d';
      await cohortsReady();
      const body = cohortDetail(cohortVenues(q), q.cohort, range, cohortFilter(q));
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * A coin's price over `range` (1d / 7d / 30d) for the cohort asset page:
   * Hyperliquid candles (its default dex, then its "k" 1000x unit, then the
   * trade.xyz dex). Cached a minute per coin and range. The series itself is
   * valuedesk/hyperliquid/price.ts, the same code the browser now runs with its
   * own client; a bad coin name or no history answers not_available.
   */
  app.get('/api/vs/price', async (req, reply) => {
    try {
      const q = req.query as Q;
      return { ok: true, ...(await hlPriceSeries(hlInfo, q.coin ?? '', q.range)) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * One address's Hyperliquid leaderboard row from the index: rank by 30-day
   * PnL, the rank change against the previous file, and HL's own figures - the
   * one index read a Scan profile needs (its account data the browser reads
   * from Hyperliquid itself). A lookup in the leaderboard file this process
   * already holds, never a per-address upstream call.
   *
   * `row` is null when the address is not listed (or the file cannot be read).
   * Only the row's own fields are sent, whatever the store may add later.
   */
  app.get('/api/vs/lbrow', async (req, reply) => {
    try {
      const q = req.query as Q;
      if (typeof q.venue !== 'string' || q.venue.toLowerCase() !== 'hyperliquid') throw bad('venue must be hyperliquid');
      const row = await hlLeaderboardRow(addressOf(q));
      return {
        ok: true,
        row: row && {
          venue: row.venue,
          address: row.address,
          label: row.label ?? null,
          accountValue: row.accountValue,
          pnl: row.pnl,
          roi: row.roi,
          volume: row.volume,
          rank: row.rank,
          rankChange: row.rankChange ?? null,
        },
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * The wallets left out of the cohorts and the liquidation heatmap (internalWallets.ts), each with why
   * and what it holds now: nothing is left out unsaid (owner 2026-10-31).
   */
  app.get('/api/vs/excluded', async (_req, reply) => {
    try {
      await cohortsReady();
      return { ok: true, wallets: excludedNow() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** The market map: every asset held, grouped by sector (`cohort=` for one cohort's positions). */
  app.get('/api/vs/cohorts/map', async (req, reply) => {
    try {
      const q = req.query as Q;
      await cohortsReady();
      const body = cohortMap(cohortVenues(q), isCohortId(q.cohort) ? q.cohort : null);
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** One asset (`coin=`) or sector (`sector=`) across every cohort, with each cohort's lean over `range`. */
  app.get('/api/vs/cohorts/focus', async (req, reply) => {
    try {
      const q = req.query as Q;
      const f = cohortFilter(q);
      if (!f.coin && !f.sector) return fail(reply, new NotAvailable('Name a coin or a sector'));
      const range: CohortRange = q.range === '1d' || q.range === '30d' ? q.range : '7d';
      await cohortsReady();
      const body = cohortFocus(cohortVenues(q), f, range);
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** A cohort's wallets, sorted (`sort=equity|value|leverage|upnl|pnl`, `dir`) and paged. */
  app.get('/api/vs/cohorts/wallets', async (req, reply) => {
    try {
      const q = req.query as Q;
      if (!isCohortId(q.cohort)) return fail(reply, new NotAvailable('Unknown cohort'));
      const sort: WalletSort = WALLET_SORTS.find((x) => x === q.sort) ?? 'equity';
      // `range` (1d | 7d | 30d, default 30d): the window of the PnL and win-rate columns. Membership stays all-time.
      const range: WalletRange = COHORT_RANGES.find((x) => x === q.range) ?? '30d';
      await cohortsReady();
      const body = cohortWallets(cohortVenues(q), q.cohort, cohortFilter(q), {
        sort, dir: q.dir === 'asc' ? 'asc' : 'desc', offset: intOf(q.offset, 0, 0, 1_000_000), limit: intOf(q.limit, 50, 1, 200), range,
      });
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
      return { ok: true, ...body };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/vs/explore', async (_req, reply) => {
    try {
      // No usernames anywhere (valuedesk/labels.ts); the provider caches its rows, so a copy is scrubbed.
      return { ok: true, ...scrubDeep(structuredClone(await buildExplore(CORE_VENUES.map((v) => PROVIDERS[v])))) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/vs/screener', async (req, reply) => {
    try {
      const q = req.query as Q;
      const venue = venueOf(q, true);
      const list = venue === 'all' ? CORE_VENUES : [venue];
      return { ok: true, ...(await buildScreener(list.map((v) => PROVIDERS[v]), q)) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/vs/trader', async (req, reply) => {
    try {
      const q = req.query as Q;
      const profile = await PROVIDERS[venueOf(q, false)].trader(addressOf(q));
      // A copy: the provider caches the profile object.
      return { ok: true, profile: profile ? { ...profile, summary: { ...profile.summary, label: shownLabel(profile.summary.address, profile.summary.label) } } : profile };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/vs/fills', async (req, reply) => {
    try {
      const q = req.query as Q;
      const venue = venueOf(q, false);
      const raw = await PROVIDERS[venue].fills(addressOf(q), {
        from: numOf(q.from),
        to: numOf(q.to),
        limit: intOf(q.limit, 2000, 1, 100_000),
      });
      const fills = venue === 'hyperliquid' ? await nameSpotFills(raw) : raw;
      return { ok: true, fills };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * Scan's band beyond positions and fills: `kind` = open | history | funding |
   * balances. A venue that does not publish one answers not_available.
   */
  app.get('/api/vs/account', async (req, reply) => {
    try {
      const q = req.query as Q;
      const venue = venueOf(q, false);
      const address = addressOf(q);
      const d = ACCOUNT_DETAIL[venue];
      const limit = intOf(q.limit, 500, 1, 2000);
      switch (q.kind) {
        case 'open':
          if (!d?.openOrders) throw new NotAvailable(`${venue} open orders are not public`);
          return { ok: true, orders: await d.openOrders(address) };
        case 'history':
          if (!d?.orderHistory) throw new NotAvailable(`${venue} order history is not public`);
          return { ok: true, orders: await d.orderHistory(address, { limit }) };
        case 'funding':
          if (!d?.funding) throw new NotAvailable(`${venue} funding history is not public`);
          return { ok: true, funding: await d.funding(address, { from: numOf(q.from), limit }) };
        case 'balances':
          if (!d?.balances) throw new NotAvailable(`${venue} balances are not public`);
          return { ok: true, balances: await d.balances(address) };
        default:
          throw bad('kind must be open, history, funding or balances');
      }
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/vs/whales', async (req, reply) => {
    try {
      const q = req.query as Q;
      const venue = venueOf(q, true);
      const minUsd = numOf(q.minUsd) ?? 100_000;
      const limit = intOf(q.limit, 50, 1, 500);
      const list = venue === 'all' ? CORE_VENUES : [venue];
      const got = await Promise.allSettled(list.map((v) => PROVIDERS[v].whales(minUsd, limit)));
      const trades = got
        .flatMap((g) => (g.status === 'fulfilled' ? g.value : []))
        .sort((a, b) => b.time - a.time)
        .slice(0, limit);
      if (!trades.length && got.every((g) => g.status === 'rejected')) throw (got[0] as PromiseRejectedResult).reason;
      return { ok: true, trades };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/vs/positioning', async (req, reply) => {
    try {
      const q = req.query as Q;
      const venue = venueOf(q, true);
      const list = venue === 'all' ? CORE_VENUES : [venue];
      const got = await Promise.allSettled(list.map((v) => PROVIDERS[v].positioning(q.symbol || undefined)));
      const rows = got.flatMap((g) => (g.status === 'fulfilled' ? g.value : []));
      if (!rows.length && got.every((g) => g.status === 'rejected')) throw (got[0] as PromiseRejectedResult).reason;
      return { ok: true, rows };
    } catch (e) {
      return fail(reply, e);
    }
  });
}
