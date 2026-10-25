/**
 * The News widget's sources (owner, 2026-10-26): SoSoValue's feed, and beside it
 * the White House and Watcher.Guru (server valuescan/feeds.ts), each switched on
 * or off in Settings - live in every open widget, kept in this browser.
 *
 * A story's source mark: its outlet's site icon (server /api/vs/logo, so the page
 * asks only its own origin) - the story's own site, or the outlet's known site
 * when the link is SoSoValue's page or a post on X - else the outlet's initial.
 */
import { useState } from 'react';
import { useSharedStored } from '../../hooks';
import type { NewsItem } from '../../vsApi';

export type NewsSourceId = 'sosovalue' | 'whitehouse' | 'watcherguru';
export const NEWS_SOURCES: ReadonlyArray<{ id: NewsSourceId; name: string; line: string; site: string }> = [
  { id: 'sosovalue', name: 'SoSoValue', line: 'Crypto news, research, announcements and posts on X', site: 'sosovalue.com' },
  { id: 'whitehouse', name: 'The White House', line: 'Its news and presidential actions', site: 'whitehouse.gov' },
  { id: 'watcherguru', name: 'Watcher.Guru', line: 'Breaking market and crypto news', site: 'watcher.guru' },
];
/** The sources beside SoSoValue, read by /api/vs/news/sources. */
export const FEED_IDS: readonly NewsSourceId[] = ['whitehouse', 'watcherguru'];

const SOURCES_KEY = 'vs.news.sources';
const NO_OFF: Partial<Record<NewsSourceId, boolean>> = {};

/** Which sources are on (every source is, until switched off), and the switch. */
export function useNewsSources(): [(id: NewsSourceId) => boolean, (id: NewsSourceId, on: boolean) => void] {
  const [state, setState] = useSharedStored<Partial<Record<NewsSourceId, boolean>>>(SOURCES_KEY, NO_OFF);
  const on = (id: NewsSourceId) => state?.[id] !== false;
  const set = (id: NewsSourceId, v: boolean) => setState({ ...(state ?? {}), [id]: v });
  return [on, set];
}

/** "Powered by SoSoValue" under the news, until dismissed for good (its x, or Settings brings it back). */
export const useCreditHidden = () => useSharedStored<boolean>('vs.news.creditHidden', false);

/** Outlets whose stories reach SoSoValue without their own link (its page, or a post on X): their sites. */
const KNOWN: Record<string, string> = {
  bloomberg: 'bloomberg.com', cnbc: 'cnbc.com', reuters: 'reuters.com', 'yahoo finance': 'finance.yahoo.com', 'wall street journal': 'wsj.com',
  'financial times': 'ft.com', panews: 'panewslab.com', coindesk: 'coindesk.com', cointelegraph: 'cointelegraph.com', 'the block': 'theblock.co',
  decrypt: 'decrypt.co', 'wu blockchain': 'wublock123.com', sosovalue: 'sosovalue.com', 'techub news': 'techub.news', odaily: 'odaily.news',
  blockbeats: 'theblockbeats.info', 'foresight news': 'foresightnews.pro', chaincatcher: 'chaincatcher.com', coinglass: 'coinglass.com',
  lookonchain: 'lookonchain.com', 'whale alert': 'whale-alert.io', 'watcher.guru': 'watcher.guru', 'the white house': 'whitehouse.gov',
  binance: 'binance.com', coinbase: 'coinbase.com', okx: 'okx.com', bybit: 'bybit.com', 'token terminal': 'tokenterminal.com',
  arkham: 'arkm.com', glassnode: 'glassnode.com', 'santiment': 'santiment.net', 'the kobeissi letter': 'thekobeissiletter.com',
  'kobeissi letter': 'thekobeissiletter.com', 'blockcast.it': 'blockcast.it', 'iost': 'iost.io', 'sonic': 'soniclabs.com',
};

/** The site whose icon marks a story, or null (the initial instead). */
export function sourceSite(n: Pick<NewsItem, 'href' | 'author' | 'post'> & { source?: string }): string | null {
  const own = NEWS_SOURCES.find((s) => s.id === n.source);
  if (own) return own.site;
  const name = (n.author ?? '').toLowerCase().replace(/[^\p{L}\p{N}. ]+/gu, '').trim();
  for (const [k, site] of Object.entries(KNOWN)) if (name === k || name.startsWith(`${k} `)) return site;
  try {
    const host = new URL(n.href).hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)(sosovalue\.com|twitter\.com|x\.com|t\.co)$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/** A story's source: its icon (or initial) and its name. */
export function SourceMark({ n }: { n: Pick<NewsItem, 'href' | 'author' | 'post'> & { source?: string } }) {
  const site = sourceSite(n);
  const [broken, setBroken] = useState<string | null>(null);
  const name = n.author ?? site ?? 'Source';
  const initial = (name.match(/\p{L}|\p{N}/u)?.[0] ?? '?').toUpperCase();
  return (
    <span className="nw__src" title={name}>
      {site && broken !== site ? (
        <img className="nw__logo" src={`/api/vs/logo?domain=${encodeURIComponent(site)}`} alt="" width={14} height={14} loading="lazy" onError={() => setBroken(site)} />
      ) : (
        <span className="nw__logo is-letter" aria-hidden="true">{initial}</span>
      )}
      <span className="nw__by">{name}</span>
    </span>
  );
}
