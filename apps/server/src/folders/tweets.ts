/**
 * A post on X, read for saving: its text, its author and its day, from X's
 * own public embed endpoint (publish.x.com/oembed - no key, no account).
 *
 * The SERVER asks, never the browser: the page loads nothing from X, so X
 * learns nothing about who saves what (only that this server asked about a
 * post), and the CSP stays as it is. What comes back is HTML for X's widget;
 * only its text is taken out of it here (tags dropped, entities decoded) and
 * the result is stored and shown as plain text.
 *
 * Answers are kept for an hour (the same post saved twice asks once), at most
 * a few hundred, and each request gives up after a few seconds.
 */
import type { TweetData } from './types.js';
import { parseTweetUrl, type TweetRef } from './tweetUrl.js';
import { FoldersFailure } from './store.js';

const ENDPOINT = 'https://publish.x.com/oembed';
const TIMEOUT_MS = 6000;
const CACHE_MS = 60 * 60_000;
const CACHE_MAX = 500;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The post's words out of X's embed HTML: line breaks kept, links as the text X shows for them, every tag dropped. */
export function textOfEmbed(html: string): { text: string; lang?: string; day: string | null } {
  const p = /<p\b([^>]*)>([\s\S]*?)<\/p>/i.exec(html);
  const lang = p ? /\blang="([a-z]{2,3}(?:-[A-Za-z]{2,4})?)"/.exec(p[1] ?? '')?.[1] : undefined;
  const inner = p?.[2] ?? '';
  const text = decodeEntities(
    inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  // After the post: "&mdash; Name (@handle) <a href="…/status/…">March 21, 2006</a>"
  const tail = p ? html.slice(p.index + p[0].length) : html;
  const day = /<a\b[^>]*\/status\/\d+[^>]*>([^<]{4,40})<\/a>/i.exec(tail)?.[1]?.trim() ?? null;
  return { text, ...(lang ? { lang } : {}), day };
}

/** "March 21, 2006" as noon UTC of that day (ms), or null. */
export function dayToMs(day: string | null): number | null {
  if (!day) return null;
  const t = Date.parse(`${day} 12:00 UTC`);
  return Number.isFinite(t) ? t : null;
}

export function tweetFromEmbed(ref: TweetRef, o: unknown): Omit<TweetData, 'note' | 'tags'> {
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const html = typeof r.html === 'string' ? r.html : '';
  const { text, lang, day } = textOfEmbed(html);
  const authorUrl = typeof r.author_url === 'string' ? r.author_url : '';
  const fromUrl = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/.exec(authorUrl)?.[1];
  const handle = fromUrl ?? ref.handle;
  return {
    url: handle ? `https://x.com/${handle}/status/${ref.id}` : ref.url,
    id: ref.id,
    handle,
    author: typeof r.author_name === 'string' ? decodeEntities(r.author_name).slice(0, 100) : handle,
    text: text.slice(0, 30_000),
    time: dayToMs(day),
    ...(lang ? { lang } : {}),
    fetched: !!text,
  };
}

export class TweetReader {
  private readonly cache = new Map<string, { at: number; tweet: Omit<TweetData, 'note' | 'tags'> }>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async read(rawUrl: unknown): Promise<Omit<TweetData, 'note' | 'tags'>> {
    const ref = parseTweetUrl(rawUrl);
    if (!ref) throw new FoldersFailure(400, 'input', 'That is not a link to a post on X.');
    const hit = this.cache.get(ref.id);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.tweet;
    const q = new URLSearchParams({ url: ref.url, omit_script: '1', dnt: 'true', hide_thread: 'true' });
    let res: Response;
    try {
      res = await this.fetchImpl(`${ENDPOINT}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' }, redirect: 'follow' });
    } catch {
      throw new FoldersFailure(502, 'unavailable', 'X did not answer. Try again in a moment, or save the link only.');
    }
    if (res.status === 404 || res.status === 403) throw new FoldersFailure(404, 'not-found', 'X does not show this post (deleted, private, or not a post). You can save the link only.');
    if (!res.ok) throw new FoldersFailure(502, 'unavailable', 'X did not answer. Try again in a moment, or save the link only.');
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new FoldersFailure(502, 'unavailable', 'X answered with something that is not a post.');
    }
    const tweet = tweetFromEmbed(ref, body);
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(ref.id, { at: this.now(), tweet });
    return tweet;
  }
}
