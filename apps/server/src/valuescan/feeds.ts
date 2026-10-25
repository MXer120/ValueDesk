/**
 * News sources beside SoSoValue, read from their own RSS feeds: the White House
 * (its news and its presidential actions) and Watcher.Guru (its news). The News
 * widget merges them into its Latest list by time, each source switched on or
 * off in Settings (NewsFeed.tsx).
 *
 * Each feed is read at most every FEED_MS, one flight at a time; a failed read
 * keeps the last copy, and a source that cannot be read is simply absent. A
 * story is reduced to what the widget shows (types.ts NewsItem): its time, title,
 * link, the first lines of its text, and the coins its text names (coins.ts,
 * with SoSoValue's coin index once that is loaded).
 *
 * The Kobeissi Letter publishes only on X, whose timelines need X's paid API:
 * not read here.
 */
import type { NewsItem } from './types.js';
import { coinsIn } from './sosovalue/coins.js';
import { newsCoinIndex, stripHtml } from './sosovalue/news.js';

export interface FeedSource {
  id: string;
  name: string;
  /** Its site, for its logo (the logo route). */
  site: string;
  urls: readonly string[];
}

export const FEED_SOURCES: readonly FeedSource[] = [
  { id: 'whitehouse', name: 'The White House', site: 'whitehouse.gov', urls: ['https://www.whitehouse.gov/news/feed/', 'https://www.whitehouse.gov/presidential-actions/feed/'] },
  { id: 'watcherguru', name: 'Watcher.Guru', site: 'watcher.guru', urls: ['https://watcher.guru/news/feed'] },
];

const FEED_MS = 5 * 60_000;
const TIMEOUT_MS = 12_000;
const KEEP_MS = 8 * 86_400_000;
/** Stories a source may return. */
const PER_SOURCE = 40;

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return m[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
};

/** An RSS document's items as stories of `src`. Items without a title, a link or a time are dropped. */
export function parseRss(xml: string, src: FeedSource): NewsItem[] {
  const out: NewsItem[] = [];
  const index = newsCoinIndex();
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = m[1]!;
    const title = stripHtml(tag(body, 'title') ?? '');
    const link = (tag(body, 'link') ?? '').trim();
    const time = Date.parse(tag(body, 'pubDate') ?? '');
    if (!title || !/^https:\/\//i.test(link) || !Number.isFinite(time)) continue;
    const text = stripHtml(tag(body, 'description') ?? tag(body, 'content:encoded') ?? '')
      .replace(/\s*The post .* appeared first on .*$/i, '')
      .replace(/\s*\[(…|\.\.\.)\]\s*$/, '…');
    const summary = text && text !== title ? text.slice(0, 240) : null;
    out.push({
      id: `${src.id}:${link}`,
      title: title.slice(0, 320),
      href: link,
      time,
      author: src.name,
      symbols: index ? coinsIn(`${title} ${text}`, index) : [],
      category: null,
      summary,
      source: src.id,
    });
  }
  return out;
}

const cache = new Map<string, { at: number; items: NewsItem[] }>();
const flights = new Map<string, Promise<NewsItem[]>>();

async function readFeed(url: string, src: FeedSource, fetchImpl: typeof fetch): Promise<NewsItem[]> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < FEED_MS) return hit.items;
  let flight = flights.get(url);
  if (!flight) {
    flight = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, { headers: { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; ValueDesk news)' }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`${src.name} feed HTTP ${res.status}`);
        const items = parseRss(await res.text(), src);
        cache.set(url, { at: Date.now(), items });
        return items;
      } catch {
        // The last copy, or nothing: one source's trouble never fails the list.
        if (hit) cache.set(url, { at: Date.now() - FEED_MS + 60_000, items: hit.items });
        return hit?.items ?? [];
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => flights.delete(url));
    flights.set(url, flight);
  }
  return flight;
}

export interface FeedQuery {
  ids: string[];
  coins: string[];
  q: string | null;
  limit: number;
}

/** The route's query, made safe: known sources only, coins as the news route takes them, text bounded. */
export function parseFeedQuery(raw: Record<string, unknown>): FeedQuery {
  const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const ids = [...new Set(list(raw.ids))].filter((id) => FEED_SOURCES.some((s) => s.id === id));
  const coins = [...new Set(list(raw.coin).map((s) => s.toUpperCase()).filter((s) => /^[A-Z0-9]{1,15}$/.test(s)))].slice(0, 5);
  const qRaw = typeof raw.q === 'string' ? raw.q.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const n = typeof raw.limit === 'string' ? Number(raw.limit) : Number.NaN;
  return { ids, coins, q: qRaw.length >= 2 ? qRaw : null, limit: Number.isInteger(n) ? Math.min(100, Math.max(1, n)) : 60 };
}

/** The chosen sources' stories, newest first: of the coins asked for (their text names one), matching every word of a search. */
export async function feedNews(q: FeedQuery, fetchImpl: typeof fetch = fetch): Promise<NewsItem[]> {
  const srcs = FEED_SOURCES.filter((s) => q.ids.includes(s.id));
  const lists = await Promise.all(srcs.flatMap((s) => s.urls.map((u) => readFeed(u, s, fetchImpl))));
  const since = Date.now() - KEEP_MS;
  const words = q.q ? q.q.toLowerCase().split(' ').filter((w) => w.length >= 2) : [];
  const seen = new Set<string>();
  const perSource = new Map<string, number>();
  return lists
    .flat()
    .filter((n) => n.time >= since && !seen.has(n.href) && !!seen.add(n.href))
    .filter((n) => !q.coins.length || n.symbols.some((s) => q.coins.includes(s)))
    .filter((n) => !words.length || words.every((w) => `${n.title} ${n.summary ?? ''}`.toLowerCase().includes(w)))
    .sort((a, b) => b.time - a.time)
    .filter((n) => {
      const k = (perSource.get(n.source!) ?? 0) + 1;
      perSource.set(n.source!, k);
      return k <= PER_SOURCE;
    })
    .slice(0, q.limit);
}

/** Tests only. */
export function resetFeeds(): void {
  cache.clear();
  flights.clear();
}

/* --- logos -------------------------------------------------------------------------------- */

const LOGO_MS = 24 * 60 * 60_000;
const MAX_LOGOS = 400;
const logos = new Map<string, { at: number; type: string; body: Buffer | null }>();
const logoFlights = new Map<string, Promise<{ type: string; body: Buffer | null }>>();

/** A hostname, lower-case, without `www.`; null when it is not one. */
export function logoDomain(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = v.trim().toLowerCase().replace(/^www\./, '');
  return /^(?=.{3,100}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d) ? d : null;
}

/**
 * A site's icon (DuckDuckGo's icon service), kept a day per site; null when it
 * has none. Read here so the browser asks only this origin.
 */
export async function siteLogo(domain: string, fetchImpl: typeof fetch = fetch): Promise<{ type: string; body: Buffer | null }> {
  const hit = logos.get(domain);
  if (hit && Date.now() - hit.at < LOGO_MS) return hit;
  let flight = logoFlights.get(domain);
  if (!flight) {
    flight = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      let got: { type: string; body: Buffer | null } = { type: 'image/x-icon', body: null };
      try {
        const res = await fetchImpl(`https://icons.duckduckgo.com/ip3/${domain}.ico`, { signal: ctrl.signal });
        const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
        if (res.ok && /^image\//.test(type)) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 0 && buf.length < 200_000) got = { type, body: buf };
        }
      } catch {
        // No icon: the widget shows the source's initial.
      } finally {
        clearTimeout(timer);
      }
      logos.set(domain, { at: Date.now(), ...got });
      if (logos.size > MAX_LOGOS) logos.delete(logos.keys().next().value!);
      return got;
    })().finally(() => logoFlights.delete(domain));
    logoFlights.set(domain, flight);
  }
  return flight;
}
