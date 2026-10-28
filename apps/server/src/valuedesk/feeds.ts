/**
 * News sources beside SoSoValue, read from their own RSS feeds: the White House
 * (its news and its presidential actions; US-government works). The News
 * widget merges them into its Latest list by time, each source switched on or
 * off in Settings (NewsFeed.tsx).
 *
 * Each feed is read at most every FEED_MS, one flight at a time; a failed read
 * keeps the last copy, and a source that cannot be read is simply absent. A
 * story is reduced to what the widget shows (types.ts NewsItem): its time, title,
 * link, the first lines of its text, and the coins its text names (coins.ts,
 * with SoSoValue's coin index once that is loaded).
 *
 * Watcher.Guru was dropped (2026-10-28): its terms (s. 3.1) license its services for
 * "personal, non-commercial use" only and say nothing about syndication. Any other
 * outlet needs its written OK before it is added here (docs/legal/THIRD-PARTY-REVIEW.md).
 *
 * The Kobeissi Letter is not read: it publishes only on X (its site embeds the
 * X timeline and has no feed of its own), and X's timelines need its paid API.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
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
    // An XML link writes its & as &amp;.
    const link = stripHtml(tag(body, 'link') ?? '');
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

/** An image's type from its first bytes (PNG, ICO, GIF, JPEG, WebP, SVG); null when unknown. */
export function imageType(b: Buffer): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(b.toString('utf8', 0, Math.min(b.length, 256)))) return 'image/svg+xml';
  return null;
}

/** A hostname, lower-case, without `www.`; null when it is not one. */
export function logoDomain(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = v.trim().toLowerCase().replace(/^www\./, '');
  return /^(?=.{3,100}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d) ? d : null;
}

/**
 * Where a site's icon is asked for: the site itself - its apple-touch-icon, then
 * its favicon, at the paths browsers ask (licence review 2026-10-28: the icon is the
 * site owner's own mark, shown at 14-20 px next to that site's own story, which is
 * identification; DuckDuckGo's and Google's icon services, which have no public
 * terms for this, are no longer asked).
 *
 * The domain is whatever a visitor puts in the query, so every connection goes
 * through publicGet: https only, the name resolved here and refused when any
 * address it resolves to is private, loopback, link-local or otherwise not public
 * (checked when the socket connects, so a DNS answer cannot change in between),
 * at most 3 redirects (each checked the same way), small bodies only.
 */
export const logoSources = (domain: string): string[] => [
  `https://${domain}/apple-touch-icon.png`,
  `https://${domain}/favicon.ico`,
];

/** Addresses no logo is ever fetched from (RFC 6890 special-purpose ranges and their IPv6 forms). */
const NOT_PUBLIC = (() => {
  const b = new BlockList();
  for (const [net, len] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const) b.addSubnet(net, len, 'ipv4');
  for (const [net, len] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
    ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ] as const) b.addSubnet(net, len, 'ipv6');
  return b;
})();

/** Whether `address` (IPv4 or IPv6, an IPv4-mapped one checked as IPv4) is a public unicast address. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !NOT_PUBLIC.check(address, 'ipv4');
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !NOT_PUBLIC.check(mapped[1]!, 'ipv4');
    return !NOT_PUBLIC.check(address, 'ipv6');
  }
  return false;
}

/** dns.lookup for the logo sockets: every address the name has must be public, else the connection fails. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as unknown as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} is not a public host`), { code: 'ENOTPUBLIC' }), '', 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface PublicResponse {
  status: number;
  body: Buffer;
}
export type PublicGet = (url: string) => Promise<PublicResponse | null>;

const LOGO_MAX_BYTES = 200_000;
const NO_SITE_ICON: readonly string[] = ['federalreserve.gov', 'stlouisfed.org', 'frb.org', 'kalshi.com', 'sec.gov', 'dol.gov'];

/** One GET of a public https URL (redirects followed, at most 3, each checked); null on any failure or refusal. */
export const publicGet: PublicGet = (url, hops = 0) =>
  new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve(null);
    }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || isIP(u.hostname.replace(/^\[|\]$/g, ''))) return resolve(null);
    const req = httpsRequest(u, { method: 'GET', lookup: publicLookup, timeout: 4_000, headers: { 'user-agent': 'Mozilla/5.0 (compatible; ValueDesk site icons)', accept: 'image/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && hops < 3) {
        res.resume();
        let next: string;
        try {
          next = new URL(res.headers.location, u).toString();
        } catch {
          return resolve(null);
        }
        return resolve((publicGet as (url: string, hops: number) => Promise<PublicResponse | null>)(next, hops + 1));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > LOGO_MAX_BYTES) {
          req.destroy();
          resolve(null);
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });

/** The image types a logo may be served as: raster only. An SVG can carry script, and it would be served from the site's own origin. */
const LOGO_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/x-icon', 'image/gif', 'image/jpeg', 'image/webp']);

/**
 * A site's own icon (logoSources, through publicGet) kept a day per site; null
 * when it has none. Read here so the browser asks only this origin. Raster
 * images only (LOGO_TYPES).
 */
export async function siteLogo(domain: string, get: PublicGet = publicGet): Promise<{ type: string; body: Buffer | null }> {
  // Official seals and marks whose owners ask for written permission (the Fed Board's and Reserve
  // Banks' logos and seals, the SEC's and DOL's seals, Kalshi's s. 6.4): never fetched; the app
  // ships a neutral letter badge for them instead.
  if (NO_SITE_ICON.some((d) => domain === d || domain.endsWith(`.${d}`))) return { type: 'image/x-icon', body: null };
  const hit = logos.get(domain);
  if (hit && Date.now() - hit.at < LOGO_MS) return hit;
  let flight = logoFlights.get(domain);
  if (!flight) {
    flight = (async () => {
      let got: { type: string; body: Buffer | null } = { type: 'image/x-icon', body: null };
      // Both paths asked at once, the first in that order that is an image kept.
      const one = async (url: string): Promise<{ type: string; body: Buffer } | null> => {
        const res = await get(url).catch(() => null);
        if (!res || res.status < 200 || res.status >= 300) return null;
        // The type the bytes are, not the one the server says (some label .ico files PNG).
        const type = imageType(res.body);
        return type && LOGO_TYPES.has(type) && res.body.length > 0 && res.body.length < LOGO_MAX_BYTES ? { type, body: res.body } : null;
      };
      const tries = logoSources(domain).map(one);
      for (const t of tries) {
        const hit = await t;
        if (hit) { got = hit; break; }
      }
      logos.set(domain, { at: Date.now(), ...got });
      if (logos.size > MAX_LOGOS) logos.delete(logos.keys().next().value!);
      return got;
    })().finally(() => logoFlights.delete(domain));
    logoFlights.set(domain, flight);
  }
  return flight;
}
