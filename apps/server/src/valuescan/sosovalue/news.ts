/**
 * SoSoValue's news (https://openapi.sosovalue.com/openapi/v1): the feed
 * (`/news`, by category and currency, the last 7 days), the hot and featured
 * lists (`/news/hot`, `/news/pick`) and keyword search (`/news/search`, which
 * is the way back past those 7 days).
 *
 * Each story is reduced to what the News widget shows: its time (SoSoValue
 * sends it as a string of milliseconds), the title - or, for a post (a tweet),
 * the post itself - a link (SoSoValue's own page when the story has no other),
 * its coins and SoSoValue's keywords. Its coins are the tickers SoSoValue
 * matched, stocks left out; a story with none (the whole hot list) gets the
 * coins its text names (coins.ts). A story that came from two outlets under the
 * same title is shown once, and the hot list keeps each story's place in it.
 *
 * Coins filter every list: the feed by SoSoValue's currency (several coins:
 * each coin's feed, merged by time), the hot and featured lists and a search
 * by the coins of their stories. A coin's feed keeps only the stories that
 * name the coin (SoSoValue tags a story with every coin it touches).
 *
 * Posts on X come from any account; the latest feed keeps the notable ones -
 * an organisation's or a government's account (X's verified type), or a post
 * many have seen or liked - and leaves out the rest unless asked for all.
 *
 * The macro topic is economics, not everything SoSoValue files as macro: its
 * macro stream (Bloomberg's), CNBC's and the news, kept where a story is about
 * rates, inflation, jobs, growth, central banks, bonds, trade and the like.
 *
 * The key is SOSOVALUE_API_KEY, read here and sent as `x-soso-api-key`. It is
 * never logged, never put on a URL, and never returned to the browser. When it
 * is absent the route answers `not_available` and the page says so.
 *
 * The published budget is 20 requests a minute and 100,000 a month per key, and
 * a page of visitors must not spend that once each: every distinct query is
 * cached (5 minutes; search 10), one flight at a time, the currency list is read
 * once a day, and past 15 upstream calls in a minute a query is answered from
 * its last copy or refused as busy.
 */
import { NotAvailable, type NewsItem } from '../types.js';
import { coinIndex, coinsIn, stockName, type CoinIndex } from './coins.js';

export type { NewsItem };

const BASE = 'https://openapi.sosovalue.com/openapi/v1';
const CACHE_MS = 5 * 60_000;
const SEARCH_CACHE_MS = 10 * 60_000;
const CURRENCY_CACHE_MS = 24 * 60 * 60_000;
/** A currency list that did not load is not asked for again for this long. */
const CURRENCY_RETRY_MS = 10 * 60_000;
const TIMEOUT_MS = 12_000;
const MAX_CACHED = 64;
const BUDGET_PER_MIN = 15;
/** Coins one query may filter by. */
export const MAX_COINS = 5;
/** Stories read from a list that is filtered by coin here, to have some left. */
const FILTERED_PAGE = 50;

export type NewsFeed = 'latest' | 'hot' | 'featured';

/** SoSoValue's categories (the `category` parameter); 5 is its macro stream. */
export const NEWS_CATEGORIES = [1, 2, 3, 4, 5, 7, 13] as const;
/** Where the macro topic is looked for: SoSoValue's macro stream, CNBC's (6), the news. */
const MACRO_SOURCES = [5, 6, 1] as const;
/** Stories mapped from one upstream page before the filters here thin it. */
const MAP_ALL = 100;

export interface NewsQuery {
  feed: NewsFeed;
  /** One of NEWS_CATEGORIES, or every category. The feed and search only. */
  category: number | null;
  /** Coin symbols (BTC), at most MAX_COINS; none is every coin. */
  coins: string[];
  /** Keyword search, which reaches further back than the feed's 7 days. */
  q: string | null;
  page: number;
  limit: number;
  /** 'macro': economics only, from several streams (the chart's macro news). */
  topic: 'macro' | null;
  /** The latest feed's posts on X: the notable ones (the default), or all. */
  posts: 'notable' | 'all';
}

export interface NewsPage {
  items: NewsItem[];
  page: number;
  total: number | null;
}

export function newsKey(): string {
  return process.env.SOSOVALUE_API_KEY?.trim() ?? '';
}

const int = (v: unknown, dflt: number, lo: number, hi: number) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** The route's query, made safe: unknown values fall back, text is bounded. `coin` is one symbol or several, comma-separated. */
export function parseNewsQuery(raw: Record<string, unknown>): NewsQuery {
  const feed = raw.feed === 'hot' || raw.feed === 'featured' ? raw.feed : 'latest';
  const cat = int(raw.category, 0, 0, 99);
  const coinRaw = typeof raw.coin === 'string' ? raw.coin : '';
  const coins = [...new Set(coinRaw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{1,15}$/.test(s)))].slice(0, MAX_COINS);
  const qRaw = typeof raw.q === 'string' ? raw.q.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return {
    feed,
    category: (NEWS_CATEGORIES as readonly number[]).includes(cat) ? cat : null,
    coins,
    q: qRaw.length >= 2 ? qRaw : null,
    page: int(raw.page, 1, 1, 50),
    limit: int(raw.limit, 12, 1, 50),
    topic: raw.topic === 'macro' ? 'macro' : null,
    posts: raw.posts === 'all' ? 'all' : 'notable',
  };
}

/**
 * A post worth showing: an organisation's or a government's account (X's
 * verified type - the blue tick alone is bought), or one many have seen or
 * liked by the time SoSoValue read it.
 */
export function notablePost(r: Record<string, unknown>): boolean {
  const type = typeof r.verified_type === 'string' ? r.verified_type.toLowerCase() : '';
  if (type === 'business' || type === 'government') return true;
  return num(r.impression_count) >= 10_000 || num(r.like_count) >= 100 || num(r.retweet_count) >= 25;
}

/**
 * Economics: what a macro story is about, in its headline - whole words, and
 * phrases where a word alone is crypto's too (a company's bitcoin "treasury",
 * a staking "yield", a "bond" of validators).
 */
const MACRO_WORDS = [
  'fed', 'federal reserve', 'fomc', 'powell', 'rate (cut|cuts|hike|hikes|decision)', 'interest rates?', 'inflation', 'deflation',
  'cpi', 'pce', 'ppi', 'payrolls?', 'nonfarm', 'non-farm', 'jobs (report|data)', 'jobless', 'unemployment', 'labou?r market',
  'wages?', 'gdp', 'recession', 'econom(y|ic|ics|ist|ists)', 'treasuries', 'treasury (yields?|bonds?|bills?|notes?|secretary|market|auctions?)',
  '(bond|bonds|junk bonds?|government bonds?|gilts?|bunds?) (market|markets|yields?|sales?|selloff|rally|traders?|prices?)', 'junk bonds?',
  'bond yields?', 'yield curve', '10-year', 'tariffs?', 'trade (war|deal|deficit|talks)', 'central banks?', 'ecb', 'boj', 'boe', 'pboc',
  'rba', 'snb', 'lagarde', 'bessent', 'yellen', 'dollar (index|strength|weakness)', 'dxy', 'yuan', 'yen', 'stimulus', 'deficits?',
  'debt ceiling', 'fiscal', 'monetary', 'opec', 'oil prices?', 'crude', 'consumer (spending|confidence|sentiment|prices)',
  'retail sales', 'pmi', 'manufacturing', 'home sales', 'housing (market|starts)', 'mortgage rates?', 'imf', 'world bank', 'g7', 'g20',
  'quantitative (easing|tightening)', 'stagflation', 'credit rating',
];
const MACRO_RE = new RegExp(`(?<![A-Za-z0-9])(${MACRO_WORDS.join('|')})(?![A-Za-z])`, 'i');
/** Its headline (a post: its text) is economics; the summary is not read - crypto stories mention a rate in passing. */
export const isMacroStory = (n: Pick<NewsItem, 'title'> & Partial<Pick<NewsItem, 'summary'>>): boolean => MACRO_RE.test(n.title);

/** A coin's story: it names the coin (ticker or name), or SoSoValue tagged that coin alone. */
export function namesCoin(n: Pick<NewsItem, 'title' | 'summary' | 'symbols'>, coin: string, index: CoinIndex | null | undefined): boolean {
  if (n.symbols.length === 1 && n.symbols[0] === coin) return true;
  if (!index) return n.symbols.includes(coin);
  return coinsIn(`${n.title} ${n.summary ?? ''}`, index, 8).includes(coin);
}

/** Tags out, a handful of entities back, whitespace collapsed. Titles are plain; bodies are HTML. */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A number, or a string of one (SoSoValue's times are strings). */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

/** A post on X: its text is the story, not a headline above one. */
function isPost(link: string | null): boolean {
  if (!link) return false;
  try {
    return /(^|\.)(twitter\.com|x\.com)$/i.test(new URL(link).hostname);
  } catch {
    return false;
  }
}

function pageOf(body: unknown): { list: unknown[]; total: number | null } {
  if (!body || typeof body !== 'object') return { list: [], total: null };
  const o = body as Record<string, unknown>;
  // The currency list is an array straight under `data`.
  if (Array.isArray(o.data)) return { list: o.data as unknown[], total: null };
  const at = Array.isArray(o.list) ? o : o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null;
  if (!at) return { list: [], total: null };
  const total = typeof at.total === 'number' && Number.isFinite(at.total) ? at.total : null;
  return { list: Array.isArray(at.list) ? at.list : [], total };
}

/** The coins SoSoValue matched to a story: tickers, stocks left out. */
function matchedCoins(v: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(v)) return out;
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const { symbol, name } = c as { symbol?: unknown; name?: unknown };
    if (stockName(name) !== null || typeof symbol !== 'string') continue;
    const sym = symbol.trim().toUpperCase();
    if (/^[A-Z0-9]{2,12}$/.test(sym) && !out.includes(sym)) out.push(sym);
    if (out.length >= 4) break;
  }
  return out;
}

const sameStory = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);

/**
 * The documented page, or the same page wrapped in `{ data }`. Rows without a
 * title, or without any link and an id to make one from, are dropped. `index`
 * finds the coins of a story SoSoValue did not tag; `rankFrom` numbers the rows
 * (the hot list) by their place in the list.
 */
export function mapNewsList(body: unknown, limit: number, opts: { index?: CoinIndex | null; rankFrom?: number } = {}): NewsItem[] {
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  const list = pageOf(body).list;
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const titleRaw = typeof r.title === 'string' ? stripHtml(r.title) : '';
    const content = typeof r.content === 'string' ? stripHtml(r.content) : '';
    const original = httpsUrl(r.original_link);
    const post = isPost(original);
    const title = post ? (content || titleRaw).slice(0, 320) : titleRaw || content.slice(0, 160);
    if (!title) continue;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : typeof r.id === 'number' ? String(r.id) : '';
    // SoSoValue's own stories come without a link: its page for them.
    const href = httpsUrl(r.source_link) ?? original ?? (/^\d+$/.test(id) ? `https://sosovalue.com/research/${id}` : null);
    if (!href) continue;
    const dupe = sameStory(title);
    if (seen.has(dupe)) continue;
    seen.add(dupe);
    const nick = typeof r.nick_name === 'string' ? r.nick_name.trim() : '';
    const authorName = typeof r.author === 'string' ? r.author.trim() : '';
    let symbols = matchedCoins(r.matched_currencies);
    if (!symbols.length && opts.index) symbols = coinsIn(`${title} ${content}`, opts.index);
    const tags = Array.isArray(r.tags)
      ? [...new Set(r.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter((t) => t && t.length <= 40))].slice(0, 5)
      : [];
    const category = typeof r.category === 'number' && Number.isFinite(r.category) ? r.category : null;
    // The body's first lines, when the title is not already all of it.
    const summary = !post && titleRaw && content && content !== titleRaw ? content.slice(0, 240) : null;
    const quiet = post && !notablePost(r);
    out.push({
      id: id || href,
      title,
      href,
      time: num(r.release_time),
      author: nick || authorName || null,
      symbols,
      category,
      summary,
      tags,
      ...(post ? { post: true } : {}),
      ...(quiet ? { notable: false } : {}),
      ...(opts.rankFrom ? { rank: opts.rankFrom + i } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* --- the cache and the budget ------------------------------------------------------------- */

const cache = new Map<string, { at: number; page: NewsPage }>();
const inflight = new Map<string, Promise<NewsPage>>();
let calls: number[] = [];
let currencies: { at: number; ids: Map<string, string>; index: CoinIndex } | null = null;
let currenciesFailed = 0;

/** Tests only. */
export function resetNewsCache(): void {
  cache.clear();
  inflight.clear();
  calls = [];
  currencies = null;
  currenciesFailed = 0;
}

function spend(): boolean {
  const now = Date.now();
  calls = calls.filter((t) => now - t < 60_000);
  if (calls.length >= BUDGET_PER_MIN) return false;
  calls.push(now);
  return true;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const key = newsKey();
  if (!key) throw new NotAvailable('SoSoValue news is not configured');
  if (!spend()) throw new Error('SoSoValue news is busy; try again in a minute');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { 'x-soso-api-key': key, accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`SoSoValue news HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('SoSoValue news timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Another SoSoValue read (its macro calendar, calendar.ts), on the same key and the same budget. */
export const sosoValueJson = (path: string, fetchImpl: typeof fetch = fetch): Promise<unknown> => getJson(`${BASE}${path}`, fetchImpl);

/**
 * SoSoValue's currency list (read once a day): each symbol's currency id, and
 * the index that finds coins in a story's text. Null while it cannot be read -
 * the news itself never waits on it twice.
 */
async function currencyList(fetchImpl: typeof fetch): Promise<typeof currencies> {
  if (currencies && Date.now() - currencies.at < CURRENCY_CACHE_MS) return currencies;
  if (Date.now() - currenciesFailed < CURRENCY_RETRY_MS) return currencies;
  try {
    const body = await getJson(`${BASE}/currencies`, fetchImpl);
    const list = Array.isArray(body) ? body : pageOf(body).list;
    const ids = new Map<string, string>();
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const sym = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
      const id = typeof r.currency_id === 'string' ? r.currency_id : typeof r.currency_id === 'number' ? String(r.currency_id) : '';
      if (sym && id && !ids.has(sym)) ids.set(sym, id);
    }
    currencies = { at: Date.now(), ids, index: coinIndex(list) };
  } catch (e) {
    if (e instanceof NotAvailable) throw e;
    currenciesFailed = Date.now();
  }
  return currencies;
}

/** The coins of a query are filtered here (not by SoSoValue): the hot and featured lists, and a search. */
const filteredHere = (q: NewsQuery) => q.coins.length > 0 && (q.feed !== 'latest' || !!q.q);
/** The latest feed leaves out posts that are not notable: it reads twice the page. */
const thinsPosts = (q: NewsQuery) => q.feed === 'latest' && !q.q && q.posts === 'notable';
const pageSize = (q: NewsQuery) => (filteredHere(q) ? FILTERED_PAGE : Math.min(100, Math.max(q.limit, 12) * (thinsPosts(q) ? 2 : 1)));

/** The upstream URL for a query (the currency id already resolved). */
export function newsUrl(q: NewsQuery, currency: string | null): string {
  const p = new URLSearchParams({ language: 'en', page: String(q.page), page_size: String(pageSize(q)) });
  if (q.q) {
    p.set('keyword', q.q);
    if (q.category) p.set('category', String(q.category));
    return `${BASE}/news/search?${p}`;
  }
  if (q.feed === 'hot') return `${BASE}/news/hot?${p}`;
  if (q.feed === 'featured') return `${BASE}/news/pick?${p}`;
  if (q.category) p.set('category', String(q.category));
  if (currency) p.set('currency_id', currency);
  return `${BASE}/news?${p}`;
}

const byTime = (a: NewsItem, b: NewsItem) => b.time - a.time;

/** One page of news for a query, cached; a failed refresh keeps the last copy. */
export async function news(q: NewsQuery, fetchImpl: typeof fetch = fetch): Promise<NewsPage> {
  // The macro topic: each source's latest (cached) page, the economics kept, merged by time.
  if (q.topic === 'macro' && q.feed === 'latest' && !q.q) {
    const pages = await Promise.allSettled(
      MACRO_SOURCES.map((category) => news({ ...q, topic: null, category, coins: [], page: 1, limit: 50 }, fetchImpl)),
    );
    const ok = pages.filter((p): p is PromiseFulfilledResult<NewsPage> => p.status === 'fulfilled').map((p) => p.value);
    if (!ok.length) throw (pages[0] as PromiseRejectedResult).reason;
    const seen = new Set<string>();
    const items = ok
      .flatMap((p) => p.items)
      .filter((n) => isMacroStory(n) && !seen.has(sameStory(n.title)) && !!seen.add(sameStory(n.title)))
      .map((n) => ({ ...n, topic: 'macro' as const }))
      .sort(byTime)
      .slice(0, q.limit);
    return { items, page: q.page, total: null };
  }
  // Several coins in the feed: each coin's own (cached) page, merged by time.
  if (q.feed === 'latest' && !q.q && q.coins.length > 1) {
    const pages = await Promise.allSettled(q.coins.map((c) => news({ ...q, coins: [c] }, fetchImpl)));
    const ok = pages.filter((p): p is PromiseFulfilledResult<NewsPage> => p.status === 'fulfilled').map((p) => p.value);
    if (!ok.length) throw (pages[0] as PromiseRejectedResult).reason;
    const seen = new Set<string>();
    const items = ok.flatMap((p) => p.items).filter((n) => !seen.has(n.id) && !!seen.add(n.id)).sort(byTime).slice(0, q.limit);
    return { items, page: q.page, total: null };
  }
  const key = JSON.stringify([q.feed, q.category, q.coins, q.q, q.page, q.limit, q.posts]);
  const hit = cache.get(key);
  const ttl = q.q ? SEARCH_CACHE_MS : CACHE_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.page;
  let flight = inflight.get(key);
  if (!flight) {
    flight = (async () => {
      try {
        const list = await currencyList(fetchImpl);
        const coin = q.coins[0];
        const byCurrency = q.feed === 'latest' && !q.q && !!coin;
        // A coin SoSoValue does not list has no news of its own: an empty page, not every coin's.
        const currency = byCurrency && list ? list.ids.get(coin!) ?? null : null;
        if (byCurrency && list && !currency) return { items: [], page: q.page, total: 0 };
        const body = await getJson(newsUrl(q, currency), fetchImpl);
        // Without the currency list the feed is filtered here, by the coins its stories name.
        const here = filteredHere(q) || (byCurrency && !currency);
        const rankFrom = q.feed === 'hot' && !q.q ? (q.page - 1) * pageSize(q) + 1 : undefined;
        let items = mapNewsList(body, MAP_ALL, { index: list?.index, rankFrom });
        if (here) items = items.filter((n) => n.symbols.some((s) => q.coins.includes(s)));
        // A coin's feed: the stories that are about it, not every one that touches it.
        if (byCurrency) items = items.filter((n) => namesCoin(n, coin!, list?.index));
        if (thinsPosts(q)) items = items.filter((n) => n.notable !== false);
        items = items.slice(0, q.limit);
        // A search comes back by relevance; the widget lists it by time like the rest.
        if (q.q) items = items.sort(byTime);
        const page: NewsPage = { items, page: q.page, total: here ? null : pageOf(body).total };
        cache.set(key, { at: Date.now(), page });
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
        return page;
      } catch (e) {
        if (hit) return hit.page;
        throw e;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, flight);
  }
  return flight;
}

/** The latest news, sliced (Explore's short list). */
export async function latestNews(limit: number, fetchImpl: typeof fetch = fetch): Promise<NewsItem[]> {
  const page = await news({ feed: 'latest', category: 1, coins: [], q: null, page: 1, limit: 12, topic: null, posts: 'notable' }, fetchImpl);
  return page.items.slice(0, limit);
}
