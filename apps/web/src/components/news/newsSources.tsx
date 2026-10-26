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
import type { CalendarSource, NewsItem } from '../../vsApi';
import SHIPPED_JSON from '../../../public/logos/news.json';

/** The icons shipped in public/logos/news: site -> file extension. */
const SHIPPED: Record<string, string> = SHIPPED_JSON;

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

/**
 * Outlets and accounts whose stories reach SoSoValue without their own link (its
 * page, or a post on X): their sites, keyed by the name with everything but
 * letters and digits dropped ("ForesightNews" and "Foresight News" alike). A
 * key also matches the start of a longer name ("RocketX | Privacy Swaps").
 */
const KNOWN: Record<string, string> = {
  bloomberg: 'bloomberg.com', cnbc: 'cnbc.com', reuters: 'reuters.com', yahoofinance: 'finance.yahoo.com', wallstreetjournal: 'wsj.com', wsj: 'wsj.com',
  financialtimes: 'ft.com', marketwatch: 'marketwatch.com', forbes: 'forbes.com', fortune: 'fortune.com', thestreet: 'thestreet.com', 道琼斯: 'dowjones.com', dowjones: 'dowjones.com',
  financialjuice: 'financialjuice.com', moomoonews: 'moomoo.com', moomoo: 'moomoo.com',
  panews: 'panewslab.com', coindesk: 'coindesk.com', cointelegraph: 'cointelegraph.com', theblock: 'theblock.co', decrypt: 'decrypt.co', blockworks: 'blockworks.co',
  dlnews: 'dlnews.com', thedefiant: 'thedefiant.io', bitcoinmagazine: 'bitcoinmagazine.com', cryptonews: 'crypto.news', cryptoslate: 'cryptoslate.com',
  beincrypto: 'beincrypto.com', bitcoinist: 'bitcoinist.com', newsbtc: 'newsbtc.com', utoday: 'u.today', ambcrypto: 'ambcrypto.com', coingape: 'coingape.com',
  thecryptotimes: 'thecryptotimes.com', altcoinist: 'altcoinist.com', watcherguru: 'watcher.guru', thewhitehouse: 'whitehouse.gov', whitehouse: 'whitehouse.gov',
  ussecuritiesandexchangecommission: 'sec.gov', sec: 'sec.gov', thekobeissiletter: 'thekobeissiletter.com', kobeissiletter: 'thekobeissiletter.com',
  wublockchain: 'wublock123.com', 吴说区块链: 'wublock123.com', 吴说深度: 'wublock123.com', odaily: 'odaily.news', odaily星球日报: 'odaily.news',
  techflow: 'techflowpost.com', 深潮techflow: 'techflowpost.com', techflowselected: 'techflowpost.com', blockbeats: 'theblockbeats.info', 律动blockbeats: 'theblockbeats.info',
  foresightnews: 'foresightnews.pro', chaincatcher: 'chaincatcher.com', chaincatcherresearch: 'chaincatcher.com', 金色财经: 'jinse.cn', jinse: 'jinse.cn',
  metaera: 'metaera.hk', metaeraresearch: 'metaera.hk', techubnews: 'techub.news', blockcastit: 'blockcast.it', 區塊客blockcastit: 'blockcast.it',
  sosovalue: 'sosovalue.com', coinglass: 'coinglass.com', lookonchain: 'lookonchain.com', arkham: 'arkm.com', glassnode: 'glassnode.com',
  santiment: 'santiment.net', cryptoquant: 'cryptoquant.com', kiyoungju: 'cryptoquant.com', messari: 'messari.io', nansen: 'nansen.ai', defillama: 'defillama.com',
  coingecko: 'coingecko.com', coinmarketcap: 'coinmarketcap.com', tokenterminal: 'tokenterminal.com', polymarket: 'polymarket.com', kalshi: 'kalshi.com', velo: 'velo.xyz',
  binance: 'binance.com', coinbase: 'coinbase.com', okx: 'okx.com', bybit: 'bybit.com', kraken: 'kraken.com', bitget: 'bitget.com', phemex: 'phemex.com',
  upbit: 'upbit.com', upbitkorea: 'upbit.com', wazirx: 'wazirx.com', swissborg: 'swissborg.com', onekey: 'onekey.so', hyperliquid: 'hyperliquid.xyz',
  tether: 'tether.to', circle: 'circle.com', blackrock: 'blackrock.com', fidelity: 'fidelity.com', ethereum: 'ethereum.org', solana: 'solana.com',
  sonic: 'soniclabs.com', iost: 'iost.io', zetachain: 'zetachain.com', fhenix: 'fhenix.io', rocketx: 'rocketx.exchange', mantra: 'mantrachain.io', listadao: 'lista.org',
};
/** Sites whose icon this app carries itself (the icon service has none for them). */
const OWN_ICON: Record<string, string> = { 'sosovalue.com': '/logos/brand/sosovalue.png' };

const keyOf = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The site whose icon marks a story, or null (the initial instead). */
export function sourceSite(n: Pick<NewsItem, 'href' | 'author' | 'post'> & { source?: string }): string | null {
  const own = NEWS_SOURCES.find((s) => s.id === n.source);
  if (own) return own.site;
  const raw = (n.author ?? '').trim().toLowerCase();
  // A name that is itself a site ("crypto.news").
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(raw)) return raw.replace(/^www\./, '');
  const key = keyOf(raw);
  if (key) {
    if (KNOWN[key]) return KNOWN[key];
    for (const [k, site] of Object.entries(KNOWN)) if (k.length >= 4 && key.startsWith(k)) return site;
  }
  try {
    const host = new URL(n.href).hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)(sosovalue\.com|twitter\.com|x\.com|t\.co)$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * A site's icon: the app's own where it carries one, then the copy shipped with
 * the app (public/logos/news, the known outlets and the calendar's agencies -
 * served by the CDN, no wait), else the server's logo route.
 */
export const logoUrl = (site: string) =>
  OWN_ICON[site] ?? (SHIPPED[site] ? `/logos/news/${site}.${SHIPPED[site]}` : `/api/vs/logo?domain=${encodeURIComponent(site)}`);

/** The calendar's publishers' sites, for their marks. */
export const CALENDAR_SITE: Record<CalendarSource, string> = { fed: 'federalreserve.gov', bls: 'bls.gov', bea: 'bea.gov', sosovalue: 'sosovalue.com' };

/** A calendar publisher's mark. */
export const CalendarMark = ({ source }: { source: CalendarSource }) => (
  <img className="nw__logo" src={logoUrl(CALENDAR_SITE[source])} alt="" width={14} height={14} />
);

/** A story's source: its icon (or initial) and its name. */
export function SourceMark({ n }: { n: Pick<NewsItem, 'href' | 'author' | 'post'> & { source?: string } }) {
  const site = sourceSite(n);
  const [broken, setBroken] = useState<string | null>(null);
  const name = n.author ?? site ?? 'Source';
  const initial = (name.match(/\p{L}|\p{N}/u)?.[0] ?? '?').toUpperCase();
  return (
    <span className="nw__src" title={name}>
      {site && broken !== site ? (
        <img className="nw__logo" src={logoUrl(site)} alt="" width={14} height={14} loading="lazy" onError={() => setBroken(site)} />
      ) : (
        <span className="nw__logo is-letter" aria-hidden="true">{initial}</span>
      )}
      <span className="nw__by">{name}</span>
    </span>
  );
}
