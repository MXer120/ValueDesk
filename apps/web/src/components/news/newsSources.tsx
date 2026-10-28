/**
 * The News widget's sources (owner, 2026-10-26): SoSoValue's feed, and beside it
 * the White House (server valuedesk/feeds.ts), each switched on or off in
 * Settings - live in every open widget, kept in this browser. Watcher.Guru was
 * dropped (2026-10-28: its terms allow personal, non-commercial use only); a
 * SoSoValue story that names it as its source is still marked and listed below.
 *
 * A story's source mark: its outlet's site icon (server /api/vs/logo, so the page
 * asks only its own origin) - the story's own site, or the outlet's known site
 * when the link is SoSoValue's page or a post on X - else (no site, or its icon
 * fails to load) the mark of the feed that carried the story (SoSoValue's, the
 * White House's). Never a letter (owner, 2026-10-28).
 */
import { useState } from 'react';
import { useSharedStored } from '../../hooks';
import type { CalendarSource, NewsItem } from '../../vsApi';
import SHIPPED_JSON from '../../../public/logos/news.json';

/** The icons shipped in public/logos/news: site -> file extension. */
const SHIPPED: Record<string, string> = SHIPPED_JSON;

export type NewsSourceId = 'sosovalue' | 'whitehouse';
export const NEWS_SOURCES: ReadonlyArray<{ id: NewsSourceId; name: string; line: string; site: string }> = [
  { id: 'sosovalue', name: 'SoSoValue', line: 'Crypto news, research, announcements and posts on X', site: 'sosovalue.com' },
  { id: 'whitehouse', name: 'The White House', line: 'Its news and presidential actions', site: 'whitehouse.gov' },
];
/** The sources beside SoSoValue, read by /api/vs/news/sources. */
export const FEED_IDS: readonly NewsSourceId[] = ['whitehouse'];

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
  bloomberg: 'bloomberg.com', cnbc: 'cnbc.com', reuters: 'reuters.com', yahoofinance: 'finance.yahoo.com', wallstreetjournal: 'wsj.com', thewallstreetjournal: 'wsj.com', wsj: 'wsj.com',
  financialtimes: 'ft.com', marketwatch: 'marketwatch.com', forbes: 'forbes.com', fortune: 'fortune.com', thestreet: 'thestreet.com', 道琼斯: 'dowjones.com', dowjones: 'dowjones.com',
  financialjuice: 'financialjuice.com', moomoonews: 'moomoo.com', moomoo: 'moomoo.com',
  panews: 'panewslab.com', coindesk: 'coindesk.com', cointelegraph: 'cointelegraph.com', theblock: 'theblock.co', decrypt: 'decrypt.co', blockworks: 'blockworks.co',
  dlnews: 'dlnews.com', thedefiant: 'thedefiant.io', bitcoinmagazine: 'bitcoinmagazine.com', cryptonews: 'crypto.news', cryptoslate: 'cryptoslate.com',
  beincrypto: 'beincrypto.com', bitcoinist: 'bitcoinist.com', newsbtc: 'newsbtc.com', utoday: 'u.today', ambcrypto: 'ambcrypto.com', coingape: 'coingape.com',
  thecryptotimes: 'thecryptotimes.com', altcoinist: 'altcoinist.com', watcherguru: 'watcher.guru', thewhitehouse: 'whitehouse.gov', whitehouse: 'whitehouse.gov',
  ussecuritiesandexchangecommission: 'sec.gov', ussec: 'sec.gov', sec: 'sec.gov', thekobeissiletter: 'thekobeissiletter.com', kobeissiletter: 'thekobeissiletter.com',
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
/**
 * Every outlet and account the news names (KNOWN's sites), by name, for
 * Settings > News: each can be switched off, and its stories leave every list.
 * Grouped as Settings shows them.
 */
export const OUTLETS: ReadonlyArray<{ group: string; list: ReadonlyArray<readonly [site: string, name: string]> }> = [
  { group: 'Markets and finance', list: [
    ['bloomberg.com', 'Bloomberg'], ['reuters.com', 'Reuters'], ['cnbc.com', 'CNBC'], ['finance.yahoo.com', 'Yahoo Finance'], ['wsj.com', 'The Wall Street Journal'],
    ['ft.com', 'Financial Times'], ['marketwatch.com', 'MarketWatch'], ['forbes.com', 'Forbes'], ['fortune.com', 'Fortune'], ['thestreet.com', 'TheStreet'],
    ['dowjones.com', 'Dow Jones'], ['financialjuice.com', 'FinancialJuice'], ['moomoo.com', 'Moomoo News'],
    ['sec.gov', 'U.S. SEC'],
  ] },
  { group: 'Crypto news', list: [
    ['coindesk.com', 'CoinDesk'], ['cointelegraph.com', 'Cointelegraph'], ['theblock.co', 'The Block'], ['decrypt.co', 'Decrypt'], ['blockworks.co', 'Blockworks'],
    ['dlnews.com', 'DL News'], ['thedefiant.io', 'The Defiant'], ['bitcoinmagazine.com', 'Bitcoin Magazine'], ['crypto.news', 'crypto.news'], ['cryptoslate.com', 'CryptoSlate'],
    ['beincrypto.com', 'BeInCrypto'], ['bitcoinist.com', 'Bitcoinist'], ['newsbtc.com', 'NewsBTC'], ['u.today', 'U.Today'], ['ambcrypto.com', 'AMBCrypto'],
    ['coingape.com', 'CoinGape'], ['thecryptotimes.com', 'The Crypto Times'], ['altcoinist.com', 'Altcoinist'], ['panewslab.com', 'PANews'], ['wublock123.com', 'Wu Blockchain'],
    ['odaily.news', 'Odaily'], ['techflowpost.com', 'TechFlow'], ['theblockbeats.info', 'BlockBeats'], ['foresightnews.pro', 'Foresight News'], ['chaincatcher.com', 'ChainCatcher'],
    ['jinse.cn', 'Jinse Finance'], ['metaera.hk', 'MetaEra'], ['techub.news', 'Techub News'], ['blockcast.it', 'Blockcast.it'], ['watcher.guru', 'Watcher.Guru'],
  ] },
  { group: 'Data and research', list: [
    ['coinglass.com', 'CoinGlass'], ['lookonchain.com', 'Lookonchain'], ['arkm.com', 'Arkham'], ['glassnode.com', 'Glassnode'], ['santiment.net', 'Santiment'],
    ['cryptoquant.com', 'CryptoQuant'], ['messari.io', 'Messari'], ['nansen.ai', 'Nansen'], ['defillama.com', 'DefiLlama'], ['coingecko.com', 'CoinGecko'],
    ['coinmarketcap.com', 'CoinMarketCap'], ['tokenterminal.com', 'Token Terminal'], ['polymarket.com', 'Polymarket'], ['kalshi.com', 'Kalshi'], ['velo.xyz', 'Velo'],
  ] },
  { group: 'Exchanges and companies', list: [
    ['binance.com', 'Binance'], ['coinbase.com', 'Coinbase'], ['okx.com', 'OKX'], ['bybit.com', 'Bybit'], ['kraken.com', 'Kraken'], ['bitget.com', 'Bitget'],
    ['phemex.com', 'Phemex'], ['upbit.com', 'Upbit'], ['wazirx.com', 'WazirX'], ['swissborg.com', 'SwissBorg'], ['onekey.so', 'OneKey'], ['hyperliquid.xyz', 'Hyperliquid'],
    ['tether.to', 'Tether'], ['circle.com', 'Circle'], ['blackrock.com', 'BlackRock'], ['fidelity.com', 'Fidelity'],
  ] },
  { group: 'Projects', list: [
    ['ethereum.org', 'Ethereum'], ['solana.com', 'Solana'], ['soniclabs.com', 'Sonic'], ['iost.io', 'IOST'], ['zetachain.com', 'ZetaChain'], ['fhenix.io', 'Fhenix'],
    ['rocketx.exchange', 'RocketX'], ['mantrachain.io', 'MANTRA'], ['lista.org', 'Lista DAO'],
  ] },
];

/** The outlets switched off (their sites), the switch, and all back on; every one is on until switched off. */
export function useOutletsOff(): [ReadonlySet<string>, (site: string, on: boolean) => void, () => void] {
  const [state, setState] = useSharedStored<string[]>('vs.news.outletsOff', []);
  const off = new Set(Array.isArray(state) ? state : []);
  const set = (site: string, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(site); else next.add(site);
    setState([...next]);
  };
  return [off, set, () => setState([])];
}

/** Sites whose icon this app carries itself (the icon service has none for them). */
const OWN_ICON: Record<string, string> = { 'sosovalue.com': '/logos/brand/sosovalue.png' };

const keyOf = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The site whose icon marks a story, or null (the feed's mark instead). */
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

/** The feed that carried a story (SoSoValue unless it names another), whose mark stands in for an outlet without an icon. */
export const feedSite = (n: { source?: string }) => NEWS_SOURCES.find((s) => s.id === n.source)?.site ?? 'sosovalue.com';

/** A story's source: its icon (or the feed's mark) and its name. */
export function SourceMark({ n }: { n: Pick<NewsItem, 'href' | 'author' | 'post'> & { source?: string } }) {
  const site = sourceSite(n);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const name = n.author ?? site ?? 'Source';
  const shown = [site, feedSite(n)].find((s): s is string => !!s && !broken.has(s));
  return (
    <span className="nw__src" title={name}>
      {shown ? (
        <img className="nw__logo" src={logoUrl(shown)} alt="" width={14} height={14} loading="lazy" onError={() => setBroken((b) => new Set(b).add(shown))} />
      ) : (
        <span className="nw__logo" aria-hidden="true" />
      )}
      <span className="nw__by">{name}</span>
    </span>
  );
}
