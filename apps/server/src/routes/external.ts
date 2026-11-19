/**
 * Public SoDEX services that do NOT live behind the trading gateway:
 * the trader leaderboard, the maintenance flag, and the announcements feed.
 *
 * Everything is proxied rather than fetched from the browser. Three reasons,
 * all of them the same reasons market.ts proxies market data:
 *  - these hosts are third-party origins; their CORS policy is theirs to change,
 *    and a terminal that goes blank because someone tightened a header is not
 *    acceptable,
 *  - responses are cached here once for every open tab instead of once per tab,
 *  - a 503 from any of them is meaningful (see the maintenance route) and we
 *    want to interpret it in one place.
 *
 * NOTHING in this file invents a value. Where upstream gives us a field that is
 * structurally useless (announcement startTime/endTime, always literally 0) it
 * is DROPPED rather than forwarded, so no downstream consumer can mistake it for
 * a real timestamp. See the announcements section.
 */
import type { FastifyInstance } from 'fastify';
import { AheadValue } from '../aheadValue.js';
import { NET } from '../config.js';
import { resolveAccountOnChain } from '../sodex/chain.js';

/**
 * The leaderboard lives on the "data" host, a sibling of the trading gateway
 * (mainnet-gw.sodex.dev -> mainnet-data.sodex.dev). Derived from the configured
 * gateway rather than hardcoded so a testnet run does not silently display
 * MAINNET rankings next to testnet balances. If the sibling host does not exist
 * for the selected network the fetch fails and the UI shows that error - which
 * is the correct outcome, and strictly better than showing the wrong network's
 * numbers.
 */
const DATA_API =
  process.env.SODEX_DATA_API?.trim() || NET.restBase.replace('-gw.', '-data.');

/** Same host the cross-chain deposit routes use; overridable the same way. */
const BIZ_API = process.env.SODEX_BIZ_API?.trim() || 'https://alpha-biz.sodex.dev';

const TIMEOUT_MS = 20_000;

// --- enums (verified against the live API) -----------------------------------

const WINDOW_TYPES = ['24H', '7D', '30D', 'ALL_TIME'] as const;
const SORT_BYS = ['pnl', 'volume'] as const;
const SORT_ORDERS = ['asc', 'desc'] as const;

/**
 * page_size is an ENUM, not a range.
 *
 * 10 / 20 / 50 are accepted; 25, 100 and 500 were each tested and each returned
 * HTTP 400. So this is validated here and rejected with a 400 of our own that
 * names the allowed values, rather than being forwarded to earn an opaque
 * upstream error.
 */
const PAGE_SIZES = [10, 20, 50] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type WindowType = (typeof WINDOW_TYPES)[number];
type SortBy = (typeof SORT_BYS)[number];
type SortOrder = (typeof SORT_ORDERS)[number];

// --- transport ---------------------------------------------------------------

/**
 * Raised when an upstream host answers 503. Kept distinct from every other
 * failure because for these hosts a 503 is not noise - it is the exchange
 * telling us it is down, which is exactly what the maintenance route reports.
 */
class UpstreamUnavailableError extends Error {
  constructor(readonly url: string) {
    super(`upstream returned HTTP 503 (${url})`);
    this.name = 'UpstreamUnavailableError';
  }
}

/**
 * The most recent HTTP 503 seen from any SoDEX host this process talked to.
 *
 * Kept for a short window (RECENT_503_MS) and folded into the maintenance
 * answer, so an outage that takes down the leaderboard host is not invisible
 * just because the status endpoint itself is still answering. Reported with its
 * own `reason` so the UI can say what the claim rests on - a 503 and a declared
 * ALL_MAINTENANCE are different facts and should not be conflated in the text
 * the trader reads.
 */
let last503: { at: number; host: string } | null = null;

/** Two maintenance poll cycles. Long enough to survive a poll, short enough to clear on its own. */
const RECENT_503_MS = 90_000;

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** The recorded 503 if it is still recent, else null. Never fabricates an age. */
const recent503 = (now = Date.now()): { host: string; agoMs: number } | null =>
  last503 && now - last503.at < RECENT_503_MS
    ? { host: last503.host, agoMs: now - last503.at }
    : null;

/**
 * One GET against a public SoDEX host.
 *
 * Both hosts use the `{code, data, message|msg}` envelope, but they disagree on
 * the message key (the data host sends `message`, biz sends `msg`) and biz sends
 * code as a number here while the mirror service sends it as a string elsewhere.
 * So success is asserted the tolerant way: code, if present, must be 0 or "0".
 */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 503) {
    // Recorded, not just thrown: a 503 from ANY SoDEX host is itself a
    // maintenance signal, and the host that happens to observe it (here, the
    // leaderboard or the announcements feed) is usually not the one being
    // asked "is the exchange up?". See `recent503` below.
    // ORIGIN only, not the full URL: the rank endpoint carries a wallet address
    // in its query string, and that has no business turning up in an unrelated
    // status payload just because that request happened to be the one that 503'd.
    last503 = { at: Date.now(), host: originOf(url) };
    throw new UpstreamUnavailableError(url);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`non-JSON response (HTTP ${res.status}) from ${url}: ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    throw new Error(body?.message || body?.msg || body?.error || `HTTP ${res.status} from ${url}`);
  }
  const code = body?.code;
  if (code !== undefined && code !== null && String(code) !== '0') {
    throw new Error(body?.message || body?.msg || `upstream error code ${code} from ${url}`);
  }
  if (!body || !('data' in body)) throw new Error(`unrecognised response envelope from ${url}`);
  return body.data as T;
}

/**
 * Short-TTL response cache.
 *
 * The maintenance flag is polled by every open tab on a ~45s cadence and the
 * leaderboard is re-fetched on every control change; without this each tab is a
 * separate request to a host we do not own. Concurrent identical requests are
 * coalesced onto one upstream call. Deliberately does NOT cache failures - a
 * transient blip should not be pinned for the whole TTL.
 *
 * BOUNDED. Keys are upstream URLs, and those carry caller-chosen page numbers,
 * ids and wallet addresses - an unbounded map is memory anyone can fill. Past
 * CACHE_MAX entries, anything older than the longest TTL used here goes first,
 * then the oldest.
 */
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const CACHE_MAX = 500;
/** The longest TTL any route here passes to `cached`. */
const CACHE_MAX_AGE_MS = 5 * 60_000;

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn()
    .then((value) => {
      cache.delete(key);
      cache.set(key, { at: Date.now(), value });
      if (cache.size > CACHE_MAX) {
        const now = Date.now();
        for (const [k, v] of cache) if (now - v.at >= CACHE_MAX_AGE_MS) cache.delete(k);
        for (const k of cache.keys()) {
          if (cache.size <= CACHE_MAX) break;
          cache.delete(k);
        }
      }
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test seam: how many upstream answers are held. */
export const _externalCacheSize = (): number => cache.size;

type MaintenanceBody = { status?: string; maintenanceDuration?: number; createTime?: number; updateTime?: number };
let maintenance: AheadValue<MaintenanceBody> | null = null;

/**
 * SoDEX's maintenance flag, held 15 s as `cached` held it, and read ahead while a banner polls (every 45 s per tab:
 * web MaintenanceBanner.tsx; asked within 50 s keeps it ready). Made on first use, so BIZ_API is read as configured.
 */
function maintenanceFlag(): AheadValue<MaintenanceBody> {
  maintenance ??= new AheadValue(() => getJson<MaintenanceBody>(`${BIZ_API}/biz/v1/maintenance/status`), { ttlMs: 15_000, askedWithinMs: 50_000 });
  return maintenance;
}

/** Test seam: forget the held maintenance flag. */
export const _resetMaintenanceFlag = (): void => { maintenance?.reset(); maintenance = null; };

/** Highest page number any list here is asked for. SoDEX publishes its top 1,000 rows. */
const MAX_PAGE = 1000;
/** A language tag as the announcements host takes it: `en`, `zh-CN`, `pt_BR`. */
const LANG_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/;
const MAX_LABEL = 64;

// --- leaderboard shapes ------------------------------------------------------

/** pnl_usd / volume_usd are decimal STRINGS upstream and stay strings here. */
export interface LeaderboardItem {
  window_type: string;
  wallet_address: string;
  account_id: number;
  pnl_usd: string;
  volume_usd: string;
  rank: number;
}

export interface LeaderboardPage {
  window_type: string;
  page: number;
  page_size: number;
  total: number;
  /** Millisecond epoch. When the ranking snapshot was taken, not "now". */
  snapshot_ts: number;
  items: LeaderboardItem[];
}

export interface LeaderboardRank {
  window_type: string;
  wallet_address: string;
  found: boolean;
  snapshot_ts: number;
  /** Absent when found is false. An unranked wallet is a fact, not an error. */
  item?: LeaderboardItem;
}

// --- announcement shapes -----------------------------------------------------

/**
 * Deliberately NARROWER than what upstream sends.
 *
 * The upstream article carries `startTime` and `endTime`, and on every
 * historical maintenance article both are literally 0. They are dropped here,
 * at the boundary, so nothing further down the stack can pick them up and paint
 * a time band with them. `createdAt` (a real seconds epoch) is the only temporal
 * fact an announcement actually gives us, and it marks when the notice was
 * PUBLISHED - not when any maintenance window began or ended.
 */
export interface Announcement {
  id: number;
  title: string;
  /** 'alert' upstream generally means an upcoming/active notice; passed through verbatim. */
  style: string;
  labels: string[];
  /** Seconds epoch - multiply by 1000 for a JS Date. */
  createdAt: number;
}

export interface AnnouncementDetail extends Announcement {
  /**
   * The article body with all markup removed. The raw upstream body is
   * third-party HTML; it is never forwarded, so it can never reach our DOM.
   */
  text: string;
}

// --- HTML -> text ------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ',
};

/**
 * Flatten article HTML to plain text.
 *
 * Not a sanitiser and not trying to be one - it is a one-way conversion that
 * throws the markup away entirely, which is a much smaller thing to get right
 * than an allow-list sanitiser. Block-level closers become newlines so the
 * paragraph structure of the announcement survives; everything else goes.
 * Entities are decoded LAST, after the tags are already gone, so a decoded
 * "&lt;b&gt;" cannot re-enter as a tag.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr|table|section)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeCodePoint(Number.parseInt(h, 16)))
    .replace(/&([a-zA-Z]+|#\d+);/g, (m, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key]!;
      if (name.startsWith('#')) return safeCodePoint(Number.parseInt(name.slice(1), 10));
      return m;
    })
    // Collapse horizontal whitespace only - \n is what carries the paragraphs.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

const safeCodePoint = (cp: number): string =>
  Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';

// --- routes ------------------------------------------------------------------

export async function externalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A page of the leaderboard, straight through with the enums validated.
   *
   * The upstream page is returned as-is (strings stay strings): any rounding or
   * reformatting here would be this server asserting a number it did not
   * compute, and the numbers are volume and PnL in dollars.
   */
  app.get('/api/external/leaderboard', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;

    const windowType = (q.window_type ?? '7D') as WindowType;
    if (!WINDOW_TYPES.includes(windowType)) {
      return reply.code(400).send({ error: `window_type must be one of ${WINDOW_TYPES.join(', ')}` });
    }
    const sortBy = (q.sort_by ?? 'volume') as SortBy;
    if (!SORT_BYS.includes(sortBy)) {
      return reply.code(400).send({ error: `sort_by must be one of ${SORT_BYS.join(', ')}` });
    }
    const sortOrder = (q.sort_order ?? 'desc') as SortOrder;
    if (!SORT_ORDERS.includes(sortOrder)) {
      return reply.code(400).send({ error: `sort_order must be one of ${SORT_ORDERS.join(', ')}` });
    }
    const pageSize = Number.parseInt(q.page_size ?? '10', 10);
    if (!PAGE_SIZES.includes(pageSize as (typeof PAGE_SIZES)[number])) {
      return reply.code(400).send({
        error: `page_size must be one of ${PAGE_SIZES.join(', ')} (the API rejects any other value with HTTP 400)`,
      });
    }
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
    if (page > MAX_PAGE) return reply.code(400).send({ error: `page must be 1..${MAX_PAGE}` });

    const params = new URLSearchParams({
      window_type: windowType,
      sort_by: sortBy,
      sort_order: sortOrder,
      page: String(page),
      page_size: String(pageSize),
    });
    const url = `${DATA_API}/api/v1/leaderboard?${params}`;

    try {
      // 30s: the snapshot only moves when upstream recomputes it, and paging
      // back and forth should not re-request pages we just fetched.
      return await cached(url, 30_000, () => getJson<LeaderboardPage>(url));
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, source: 'sodex-data' });
    }
  });

  /**
   * One wallet's own standing in a window.
   *
   * `found: false` comes back for a wallet that has not traded in the window.
   * That is a legitimate answer and is forwarded as such - it must never be
   * rendered as rank 0 or as an error.
   */
  app.get('/api/external/leaderboard/rank', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.wallet_address || !ADDRESS_RE.test(q.wallet_address)) {
      return reply.code(400).send({ error: 'a valid 0x wallet address is required' });
    }
    const windowType = (q.window_type ?? '7D') as WindowType;
    if (!WINDOW_TYPES.includes(windowType)) {
      return reply.code(400).send({ error: `window_type must be one of ${WINDOW_TYPES.join(', ')}` });
    }
    const sortBy = (q.sort_by ?? 'volume') as SortBy;
    if (!SORT_BYS.includes(sortBy)) {
      return reply.code(400).send({ error: `sort_by must be one of ${SORT_BYS.join(', ')}` });
    }

    const params = new URLSearchParams({
      window_type: windowType,
      sort_by: sortBy,
      wallet_address: q.wallet_address,
    });
    const url = `${DATA_API}/api/v1/leaderboard/rank?${params}`;
    try {
      return await cached(url, 30_000, () => getJson<LeaderboardRank>(url));
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, source: 'sodex-data' });
    }
  });

  /**
   * A trade print carries only a numeric account id, never a wallet address
   * (see api.ts's TapeTrade/PublicTrade) - the leaderboard is address-keyed
   * the other way, and an internal market maker never appears on it at all.
   * This is the one route that goes the id -> address direction, and it does
   * so on-chain rather than by guessing from a ranking, which is what makes
   * it work for an id the leaderboard never lists (see resolveAccountOnChain's
   * own header comment in sodex/chain.ts for why).
   */
  app.get('/api/external/resolve-account', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const id = Number.parseInt(q.id ?? '', 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'a positive integer account id is required' });
    }
    try {
      return await resolveAccountOnChain(id);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, source: 'valuechain-explorer' });
    }
  });

  /**
   * Is the exchange up?
   *
   * Two independent signals, both reported:
   *  - the maintenance service's own `status` enum, which is
   *    NORMAL | ALL_MAINTENANCE | CHAIN_MAINTENANCE. Anything that is not
   *    exactly NORMAL means degraded. (The comparison is `!== 'NORMAL'` on
   *    purpose: there is no 'MAINTENANCE' value to equal, so an equality test
   *    against one would report "up" during an actual outage.)
   *  - an HTTP 503 from ANY SoDEX host this process has talked to in the last
   *    90 seconds, which is a maintenance signal in its own right - including
   *    the case where the status endpoint is itself too down to answer.
   *
   * They are reported separately (`reason`) rather than merged, because "SoDEX
   * declared ALL_MAINTENANCE" and "a SoDEX host returned 503 a minute ago" are
   * different facts and deserve different words on screen.
   *
   * A network-level failure is NOT treated as maintenance. "We could not reach
   * the host" and "the exchange is in maintenance" are different claims, and
   * asserting the second from the first would tell a trader their orders are
   * frozen when the truth may be that their wifi dropped. Unreachable is
   * reported as unreachable, with maintenance left false and status null.
   */
  app.get('/api/external/maintenance/status', async () => {
    const checkedAt = Date.now();
    try {
      // 15s TTL against a ~45s per-tab poll: several tabs share one request,
      // but the flag is never more than 15s stale. Read again just before it
      // lapses while a tab polls (aheadValue.ts), so a poll never waits for SoDEX.
      const data = await maintenanceFlag().get();
      const status = typeof data?.status === 'string' ? data.status : null;
      // `!== 'NORMAL'`, never `=== 'MAINTENANCE'` - see the route comment.
      const declared = status !== null && status !== 'NORMAL';
      const seen503 = recent503(checkedAt);
      return {
        reachable: true,
        /** Only ever derived from a status we actually received, or a real 503. */
        maintenance: declared || seen503 !== null,
        /** What the claim rests on, so the UI never has to guess which it was. */
        reason: declared ? 'status' : seen503 ? 'http-503' : null,
        status,
        recent503: seen503,
        maintenanceDuration: typeof data?.maintenanceDuration === 'number' ? data.maintenanceDuration : null,
        // Seconds epoch upstream. Left in seconds; the UI multiplies by 1000.
        createTime: typeof data?.createTime === 'number' ? data.createTime : null,
        updateTime: typeof data?.updateTime === 'number' ? data.updateTime : null,
        checkedAt,
        error: null as string | null,
      };
    } catch (e) {
      const is503 = e instanceof UpstreamUnavailableError;
      const seen503 = recent503(checkedAt);
      return {
        // A 503 is an ANSWER: the host is up enough to say it is down. Any other
        // failure means we learned nothing, and that is reported as nothing.
        reachable: is503,
        maintenance: is503 || seen503 !== null,
        reason: is503 || seen503 ? ('http-503' as const) : null,
        status: null,
        recent503: seen503,
        maintenanceDuration: null,
        createTime: null,
        updateTime: null,
        checkedAt,
        error: (e as Error).message,
      };
    }
  });

  /**
   * The announcements index.
   *
   * Only the fields listed on `Announcement` survive - see the comment there for
   * why startTime/endTime are dropped at this boundary rather than forwarded.
   */
  app.get('/api/external/announcements', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
    if (page > MAX_PAGE) return reply.code(400).send({ error: `page must be 1..${MAX_PAGE}` });
    // Upstream caps size at 100.
    const size = Math.min(100, Math.max(1, Number.parseInt(q.size ?? '20', 10) || 20));
    const lang = q.lang || 'en';
    if (!LANG_RE.test(lang)) return reply.code(400).send({ error: 'lang must be a language tag such as en' });
    if (q.label && q.label.length > MAX_LABEL) return reply.code(400).send({ error: `label is longer than ${MAX_LABEL} characters` });
    const params = new URLSearchParams({ page: String(page), size: String(size), lang });
    if (q.label) params.set('label', q.label);

    const url = `${BIZ_API}/biz/announcements?${params}`;
    try {
      const data = await cached(url, 60_000, () =>
        getJson<{ articles?: any[]; page?: number; size?: number; count?: number }>(url),
      );
      const items: Announcement[] = (data?.articles ?? []).map((a) => ({
        id: Number(a?.id),
        title: String(a?.title ?? ''),
        style: String(a?.style ?? ''),
        labels: Array.isArray(a?.label_names) ? a.label_names.map(String) : [],
        createdAt: typeof a?.createdAt === 'number' ? a.createdAt : 0,
      }));
      return { page: data?.page ?? page, size: data?.size ?? size, count: data?.count ?? items.length, items };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, source: 'sodex-biz' });
    }
  });

  /**
   * One article's body, flattened to text.
   *
   * The upstream body is third-party HTML. It is converted here and the raw
   * markup is never returned, so no consumer has the option of injecting it.
   */
  app.get('/api/external/announcements/:id', async (req, reply) => {
    const id = Number.parseInt(String((req.params as any).id ?? ''), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'a numeric announcement id is required' });
    }
    const lang = (req.query as { lang?: string }).lang || 'en';
    if (!LANG_RE.test(lang)) return reply.code(400).send({ error: 'lang must be a language tag such as en' });
    const url = `${BIZ_API}/biz/announcements/detail/${id}?lang=${encodeURIComponent(lang)}`;
    try {
      const data = await cached(url, 5 * 60_000, () =>
        getJson<{ id?: number; title?: string; style?: string; label_names?: string[]; createdAt?: number; body?: string }>(url),
      );
      const detail: AnnouncementDetail = {
        id: typeof data?.id === 'number' ? data.id : id,
        title: String(data?.title ?? ''),
        style: String(data?.style ?? ''),
        labels: Array.isArray(data?.label_names) ? data.label_names.map(String) : [],
        createdAt: typeof data?.createdAt === 'number' ? data.createdAt : 0,
        text: htmlToText(String(data?.body ?? '')),
      };
      return detail;
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, source: 'sodex-biz' });
    }
  });
}
