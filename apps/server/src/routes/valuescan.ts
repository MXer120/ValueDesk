/**
 * /api/vs/*: the multi-venue trader API behind Explore, Leaderboard, Scan and Copy.
 *
 * This file only validates, dispatches and merges. Every venue-specific fetch,
 * cache and rate budget lives in its provider (valuescan/sodex,
 * valuescan/hyperliquid). Failures come back as HTTP 200 {ok:false,...}, the
 * same convention routes/scan.ts uses, so one venue being down renders as a
 * per-section message rather than a blanked page.
 *
 *   GET /api/vs/leaderboard?venue=all|sodex|hyperliquid&window=1d|7d|30d|all&sort=pnl|roi|volume|accountValue&limit&offset&q&side=top|worst&curves=1
 *   GET /api/vs/explore
 *   GET /api/vs/trader?venue&address
 *   GET /api/vs/fills?venue&address&from&to&limit
 *   GET /api/vs/whales?venue=all|..&minUsd&limit
 *   GET /api/vs/positioning?venue=all|..&symbol
 *   GET /api/vs/screener?...   (query owned by valuescan/screener.ts)
 *   GET /api/vs/lbrow?venue=hyperliquid&address   (one leaderboard row from the index)
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
} from '../valuescan/types.js';
import { sodexProvider } from '../valuescan/sodex/index.js';
import { hlInfo, hlLeaderboardRow, hyperliquidProvider } from '../valuescan/hyperliquid/index.js';
import { hlPriceSeries } from '../valuescan/hyperliquid/price.js';
import { ACCOUNT_DETAIL, arcusProvider, lighterProvider, nameSpotFills, tradexyzProvider } from '../valuescan/extra/providers.js';
import { applyCachedCurves, attachPodiumCurves } from '../valuescan/curves.js';
import { attachStats, boardPage, cohortDetail, cohortFocus, cohortMap, cohortWallets, cohortsRead, indexerStatus, netPage } from '../indexer/read.js';
import { isCohortId, isSector, type CohortFilter, type CohortRange, type WalletSort } from '../valuescan/cohorts/model.js';
import { watchAddresses } from '../indexer/host.js';
import { BOARD_WINDOWS, type BoardWindow } from '../valuescan/types.js';
import { buildExplore } from '../valuescan/explore.js';
import { buildScreener } from '../valuescan/screener.js';
import { scrubDeep, scrubLabels, shownLabel } from '../valuescan/labels.js';
import { COHORT_RANGES, WALLET_SORTS, type CohortRange as WalletRange } from '../valuescan/cohorts/model.js';

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

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

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

export async function valuescanRoutes(app: FastifyInstance) {
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
            source: 'ValueScan index is starting. The board fills as traders are read.',
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

  /** Indexer diagnostics: lanes, streams, last board build. */
  app.get('/api/vs/index/status', async () => ({ ok: true, status: indexerStatus() }));

  /** Cohorts for `venues=a,b` (netted over them; all venues when none is named), `sector=` / `coin=` filters. */
  app.get('/api/vs/cohorts', async (req, reply) => {
    try {
      const q = req.query as Q;
      const body = cohortsRead(cohortVenues(q), cohortFilter(q));
      if (!body) return fail(reply, new NotAvailable('The index is not running yet'));
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
   * valuescan/hyperliquid/price.ts, the same code the browser now runs with its
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

  /** The market map: every asset held, grouped by sector (`cohort=` for one cohort's positions). */
  app.get('/api/vs/cohorts/map', async (req, reply) => {
    try {
      const q = req.query as Q;
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
      // No usernames anywhere (valuescan/labels.ts); the provider caches its rows, so a copy is scrubbed.
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
