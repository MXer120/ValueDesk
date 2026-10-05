/**
 * SoSoValue's news feed (GET https://openapi.sosovalue.com/openapi/v1/news).
 *
 * The key is SOSOVALUE_API_KEY, read here and sent as `x-soso-api-key`. It is
 * never logged, never put on a URL, and never returned to the browser. When it
 * is absent the route answers `not_available` and Explore says so.
 *
 * One in-process cache. The published budget is 20 requests a minute; a page
 * of visitors must not spend that once each.
 */
import { NotAvailable, type NewsItem } from '../types.js';

export type { NewsItem };

const NEWS_URL = 'https://openapi.sosovalue.com/openapi/v1/news?category=1&language=en&page=1&page_size=12';
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 12_000;

export function newsKey(): string {
  return process.env.SOSOVALUE_API_KEY?.trim() ?? '';
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

function listOf(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return [];
  const o = body as Record<string, unknown>;
  if (Array.isArray(o.list)) return o.list;
  const data = o.data;
  if (data && typeof data === 'object' && Array.isArray((data as { list?: unknown }).list)) {
    return (data as { list: unknown[] }).list;
  }
  return [];
}

/** The documented page, or the same page wrapped in `{ data }`. Rows without a title and a link are dropped. */
export function mapNewsList(body: unknown, limit: number): NewsItem[] {
  const out: NewsItem[] = [];
  for (const raw of listOf(body)) {
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
    out.push({ id, title, href, time, author, symbols });
    if (out.length >= limit) break;
  }
  return out;
}

let cache: { at: number; items: NewsItem[] } | null = null;
let inflight: Promise<NewsItem[]> | null = null;

/** Tests only. */
export function resetNewsCache(): void {
  cache = null;
  inflight = null;
}

async function pull(fetchImpl: typeof fetch): Promise<NewsItem[]> {
  const key = newsKey();
  if (!key) throw new NotAvailable('SoSoValue news is not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(NEWS_URL, {
      headers: { 'x-soso-api-key': key, accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`SoSoValue news HTTP ${res.status}`);
    const items = mapNewsList(await res.json(), 12);
    cache = { at: Date.now(), items };
    return items;
  } catch (e) {
    if (cache) return cache.items;
    if (e instanceof NotAvailable) throw e;
    throw new Error(e instanceof Error && e.name === 'AbortError' ? 'SoSoValue news timed out' : (e instanceof Error ? e.message : 'SoSoValue news failed'));
  } finally {
    clearTimeout(timer);
  }
}

/** The cached page, sliced. One flight at a time; a failed refresh keeps the last page. */
export async function latestNews(limit: number, fetchImpl: typeof fetch = fetch): Promise<NewsItem[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.items.slice(0, limit);
  if (!inflight) {
    const flight = pull(fetchImpl).finally(() => {
      if (inflight === flight) inflight = null;
    });
    inflight = flight;
  }
  const items = await inflight;
  return items.slice(0, limit);
}
