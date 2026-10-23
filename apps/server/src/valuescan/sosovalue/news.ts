/**
 * SoSoValue's news (https://openapi.sosovalue.com/openapi/v1): the feed
 * (`/news`, by category and currency, the last 7 days), the hot and featured
 * lists (`/news/hot`, `/news/pick`) and keyword search (`/news/search`, which
 * is the way back past those 7 days).
 *
 * The key is SOSOVALUE_API_KEY, read here and sent as `x-soso-api-key`. It is
 * never logged, never put on a URL, and never returned to the browser. When it
 * is absent the route answers `not_available` and the page says so.
 *
 * The published budget is 20 requests a minute and 100,000 a month per key, and
 * a page of visitors must not spend that once each: every distinct query is
 * cached (5 minutes; search 10), one flight at a time, and past 15 upstream
 * calls in a minute a query is answered from its last copy or refused as busy.
 */
import { NotAvailable, type NewsItem } from '../types.js';

export type { NewsItem };

const BASE = 'https://openapi.sosovalue.com/openapi/v1';
const CACHE_MS = 5 * 60_000;
const SEARCH_CACHE_MS = 10 * 60_000;
const CURRENCY_CACHE_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 12_000;
const MAX_CACHED = 64;
const BUDGET_PER_MIN = 15;

export type NewsFeed = 'latest' | 'hot' | 'featured';

/** SoSoValue's categories (the `category` parameter). */
export const NEWS_CATEGORIES = [1, 2, 3, 4, 7, 13] as const;

export interface NewsQuery {
  feed: NewsFeed;
  /** One of NEWS_CATEGORIES, or every category. The feed and search only. */
  category: number | null;
  /** A coin symbol (BTC); the feed only. */
  coin: string | null;
  /** Keyword search, which reaches further back than the feed's 7 days. */
  q: string | null;
  page: number;
  limit: number;
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

/** The route's query, made safe: unknown values fall back, text is bounded. */
export function parseNewsQuery(raw: Record<string, unknown>): NewsQuery {
  const feed = raw.feed === 'hot' || raw.feed === 'featured' ? raw.feed : 'latest';
  const cat = int(raw.category, 0, 0, 99);
  const coinRaw = typeof raw.coin === 'string' ? raw.coin.trim().toUpperCase() : '';
  const qRaw = typeof raw.q === 'string' ? raw.q.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return {
    feed,
    category: (NEWS_CATEGORIES as readonly number[]).includes(cat) ? cat : null,
    coin: /^[A-Z0-9]{1,15}$/.test(coinRaw) ? coinRaw : null,
    q: qRaw.length >= 2 ? qRaw : null,
    page: int(raw.page, 1, 1, 50),
    limit: int(raw.limit, 12, 1, 50),
  };
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

function pageOf(body: unknown): { list: unknown[]; total: number | null } {
  if (!body || typeof body !== 'object') return { list: [], total: null };
  const o = body as Record<string, unknown>;
  const at = Array.isArray(o.list) ? o : o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null;
  if (!at) return { list: Array.isArray(o.data) ? (o.data as unknown[]) : [], total: null };
  const total = typeof at.total === 'number' && Number.isFinite(at.total) ? at.total : null;
  return { list: Array.isArray(at.list) ? at.list : [], total };
}

/** The documented page, or the same page wrapped in `{ data }`. Rows without a title and a link are dropped. */
export function mapNewsList(body: unknown, limit: number): NewsItem[] {
  const out: NewsItem[] = [];
  for (const raw of pageOf(body).list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const titleRaw = typeof r.title === 'string' ? stripHtml(r.title) : '';
    const content = typeof r.content === 'string' ? stripHtml(r.content) : '';
    const title = titleRaw || content.slice(0, 160);
    if (!title) continue;
    const href = httpsUrl(r.source_link) ?? httpsUrl(r.original_link);
    if (!href) continue;
    const time = typeof r.release_time === 'number' && Number.isFinite(r.release_time) ? r.release_time : 0;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : href;
    const nick = typeof r.nick_name === 'string' ? r.nick_name.trim() : '';
    const authorName = typeof r.author === 'string' ? r.author.trim() : '';
    const author = nick || authorName || null;
    const symbols: string[] = [];
    if (Array.isArray(r.matched_currencies)) {
      for (const c of r.matched_currencies) {
        if (symbols.length >= 3) break;
        if (!c || typeof c !== 'object') continue;
        const name = (c as { name?: unknown }).name;
        if (typeof name !== 'string') continue;
        const sym = name.trim().toUpperCase();
        if (sym && !symbols.includes(sym)) symbols.push(sym);
      }
    }
    const category = typeof r.category === 'number' && Number.isFinite(r.category) ? r.category : null;
    // The body's first lines, when the title is not already all of it.
    const summary = titleRaw && content && content !== titleRaw ? content.slice(0, 240) : null;
    out.push({ id, title, href, time, author, symbols, category, summary });
    if (out.length >= limit) break;
  }
  return out;
}

/* --- the cache and the budget ------------------------------------------------------------- */

const cache = new Map<string, { at: number; page: NewsPage }>();
const inflight = new Map<string, Promise<NewsPage>>();
let calls: number[] = [];
let currencies: { at: number; ids: Map<string, string> } | null = null;

/** Tests only. */
export function resetNewsCache(): void {
  cache.clear();
  inflight.clear();
  calls = [];
  currencies = null;
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

/** SoSoValue's currency id for a symbol (its /currencies list, read once a day). */
async function currencyId(symbol: string, fetchImpl: typeof fetch): Promise<string | null> {
  if (!currencies || Date.now() - currencies.at > CURRENCY_CACHE_MS) {
    const body = await getJson(`${BASE}/currencies`, fetchImpl);
    const list = Array.isArray(body) ? body : pageOf(body).list.length ? pageOf(body).list : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
    const ids = new Map<string, string>();
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const sym = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
      const id = typeof r.currency_id === 'string' ? r.currency_id : typeof r.currency_id === 'number' ? String(r.currency_id) : '';
      if (sym && id && !ids.has(sym)) ids.set(sym, id);
    }
    currencies = { at: Date.now(), ids };
  }
  return currencies.ids.get(symbol) ?? null;
}

/** The upstream URL for a query (the currency id already resolved). */
export function newsUrl(q: NewsQuery, currency: string | null): string {
  const p = new URLSearchParams({ language: 'en', page: String(q.page), page_size: String(Math.min(100, Math.max(q.limit, 12))) });
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

/** One page of news for a query, cached; a failed refresh keeps the last copy. */
export async function news(q: NewsQuery, fetchImpl: typeof fetch = fetch): Promise<NewsPage> {
  const key = JSON.stringify([q.feed, q.category, q.coin, q.q, q.page, q.limit]);
  const hit = cache.get(key);
  const ttl = q.q ? SEARCH_CACHE_MS : CACHE_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.page;
  let flight = inflight.get(key);
  if (!flight) {
    flight = (async () => {
      try {
        // A coin SoSoValue does not list has no news of its own: an empty page, not every coin's.
        const currency = q.coin && !q.q && q.feed === 'latest' ? await currencyId(q.coin, fetchImpl) : null;
        if (q.coin && !q.q && q.feed === 'latest' && !currency) return { items: [], page: q.page, total: 0 };
        const body = await getJson(newsUrl(q, currency), fetchImpl);
        const page: NewsPage = { items: mapNewsList(body, q.limit), page: q.page, total: pageOf(body).total };
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
  const page = await news({ feed: 'latest', category: 1, coin: null, q: null, page: 1, limit: 12 }, fetchImpl);
  return page.items.slice(0, limit);
}
