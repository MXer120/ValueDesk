/**
 * What SoDEX publishes about each Wealth fund, relayed for the fund pages (owner 2026-11-28: "a full info page for every
 * asset of existing underlying wealth products, provided by sodex info"). sodex.com builds its fund pages from:
 *
 *   alpha-biz.sodex.dev/biz/config/wealth        its CMS: name, highlight, key features, about, FAQ, curator, links,
 *                                                the underlying's keystone id; USDC Earn's rules (one 283 KB file, all
 *                                                funds, 12 languages)
 *   keystone.sosovalue.com/v1/instruments/{id}   the underlying ETF's live holdings and quote (answers sodex.com only)
 *   wealth.sodex.dev/api/v1/wealth/funds/{id}    a vault's issuer, launch date, fees and minimums (sodex.com only)
 *   sodex.com/assets/locales/{lng}/wealth.json   ANT Believers Index's text (not in the CMS; no CORS at all)
 *
 * (research 2026-11-28, side-session notes sodex-fund-info-2026-11-28.md). Relayed rather than called from the
 * browser: two of them answer only sodex.com, and a direct call would hand the visitor's IP and Cloudflare cookies to
 * SoDEX (the same reason fonts are self-hosted). The relay keeps the CMS five minutes, as sodex.com does, and answers a
 * few KB per fund and language:
 *
 *   GET /api/vs/wealth/info?fund=vQQQ&lang=de  ->  {ok, info}
 *
 * FAQ answers SoDEX writes in HTML are turned into text and a list of https links here; no markup reaches the page.
 * Nothing is kept about who asked.
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { BASKETS, decodeAddrUints, decodeString, decodeTokenset, tickerOf, weigh, type Basket } from '../wealth/basket.js';

const CMS = process.env.VALUESCAN_SODEX_CMS?.trim() || 'https://alpha-biz.sodex.dev/biz/config/wealth';
const KEYSTONE = (process.env.VALUESCAN_KEYSTONE?.trim() || 'https://keystone.sosovalue.com/v1/instruments').replace(/\/+$/, '');
const WEALTH = (process.env.VALUESCAN_SODEX_WEALTH?.trim() || 'https://wealth.sodex.dev/api/v1/wealth').replace(/\/+$/, '');
const LOCALES = (process.env.VALUESCAN_SODEX_LOCALES?.trim() || 'https://sodex.com/assets/locales').replace(/\/+$/, '');

export const WEALTH_INFO_LIMIT: Limit = { max: 60, windowMs: 60_000 };
/**
 * USDC Earn's daily share price, for the index lines (SoDEX's price-history and nav-history send nothing for it,
 * checked 2026-11-28): the Morpho vault behind it (SoDEX's own stable-earn identity: vault 0xb88A…61c9 on Base, history
 * from 2025-09-01), from Morpho's public API, read at most once an hour. Morpho has said that API retires 2027-01-25.
 */
const MORPHO = process.env.VALUESCAN_MORPHO_API?.trim() || 'https://api.morpho.org/graphql';
export const EARN_VAULT = '0xb88A0269C0b7E665F15DE46F634e02cE81E361c9';
const EARN_FROM = 1_756_684_800;
/** The unit price by day; the APY (Morpho's average net APY, what sodex.com calls "Instant APY") by day, and by hour for the last 30 days. */
const earnQuery = (from: number, hourFrom: number) => `{ vaultV2ByAddress(address: "${EARN_VAULT}", chainId: 8453) { historicalState { sharePrice(options: { startTimestamp: ${from}, interval: DAY }) { x y } apyDay: avgNetApy(options: { startTimestamp: ${from}, interval: DAY }) { x y } apyHour: avgNetApy(options: { startTimestamp: ${hourFrom}, interval: HOUR }) { x y } } } }`;
/** The languages SoDEX writes (CMS and locale files); anything else reads English, as sodex.com does. */
export const INFO_LANGS = ['en', 'zh', 'hk', 'ja', 'ko', 'es', 'ru', 'vi', 'fr', 'tr', 'de', 'pt'] as const;
const FUND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** Enough for an index page to add its funds' holdings up by weight (VD index look-through), still a few KB. */
const HOLDINGS_SHOWN = 25;

const MIN = 60_000;
const TTL = { cms: 5 * MIN, holdings: 30 * MIN, quote: 10 * MIN, vault: 10 * MIN, locale: 60 * MIN, answer: 5 * MIN } as const;

export interface FundInfo {
  fundId: string;
  lang: string;
  /** The CMS's version number, for the page to tell a change. */
  version: number | null;
  name: string | null;
  market: 'US' | 'CN' | null;
  underlying: { symbol: string | null; fullSymbol: string | null; name: string | null; currency: string | null } | null;
  headline: { title: string | null; subtitle: string | null; points: string[] } | null;
  features: string[];
  about: { title: string | null; body: string[] } | null;
  faq: Array<{ q: string; a: string[]; links: Array<{ label: string; href: string }> }>;
  curator: string | null;
  social: Array<{ type: string; url: string; name: string | null }>;
  holdings: {
    source: 'live' | 'sodex' | 'chain'; asOf: string | null; total: number | null; stale: boolean;
    rows: Array<{ name: string; ticker: string | null; weight: number }>;
    /** An on-chain basket's holdings SoDEX does not price: named, no weight. */
    unpriced?: string[];
  } | null;
  /** Why no holdings are shown when SoDEX's own page would show some (USSI's backing is off chain). */
  holdingsNote?: string | null;
  underlyingQuote: { since: string | null; marketCap: number | null; high52w: number | null; low52w: number | null; currency: string | null; kind: string | null; pe: number | null } | null;
  vault: { issuer: string | null; launched: string | null; managementFee: number | null; performanceFee: number | null; minDeposit: string | null; minRedeemShares: string | null } | null;
  earn: { minIn: string | null; minOut: string | null; vaultName: string | null; shareToken: string | null; crossChain: string | null; risk: string | null; subscription: string[]; redemption: string[] } | null;
}

type Json = Record<string, unknown>;
type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
const RPC = { valuechain: process.env.VALUESCAN_VALUECHAIN_RPC?.trim() || 'https://mainnet.valuechain.xyz/', base: process.env.VALUESCAN_BASE_RPC?.trim() || 'https://mainnet.base.org' } as const;
const GATEWAY = (process.env.VALUESCAN_SODEX_GATEWAY?.trim() || 'https://mainnet-gw.sodex.dev/api/v1').replace(/\/+$/, '');

const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const numOrNull = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

/** A CMS text in `lang`, English when that is missing or empty (sodex.com's rule). */
export function pick(v: unknown, lang: string): string | null {
  const o = obj(v);
  if (!o) return str(v);
  return str(o[lang]) ?? str(o.en);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };
const decode = (s: string): string => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 31 ? String.fromCodePoint(c) : ''; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** SoDEX's HTML answer as paragraphs of text and its https links; every tag dropped. */
export function htmlToText(html: string): { paragraphs: string[]; links: Array<{ label: string; href: string }> } {
  const links: Array<{ label: string; href: string }> = [];
  const withLinks = html.replace(/<(script|style|iframe|object|template)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const text = decode(label.replace(/<[^>]*>/g, '')).trim();
    const h = decode(href).trim();
    if (/^https:\/\/[^\s<>"']+$/i.test(h) && links.length < 8 && !links.some((l) => l.href === h)) links.push({ label: text || h, href: h });
    return text;
  });
  const text = decode(withLinks.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]*>/g, ''));
  return { paragraphs: paras(text), links };
}

const paras = (s: string): string[] => s.split(/\n+/).map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).slice(0, 20);
const safeUrl = (u: unknown): string | null => { const s = str(u); return s && /^https:\/\/[^\s<>"']+$/i.test(s) ? s : null; };

// --- the sources, each read once per its time ------------------------------------------------------

class Cache<T> {
  private hits = new Map<string, { at: number; v: T }>();
  private inFlight = new Map<string, Promise<T>>();
  constructor(private ttl: number, private max = 200) {}
  get(key: string, now: number, load: () => Promise<T>): Promise<T> {
    const h = this.hits.get(key);
    if (h && now - h.at < this.ttl) return Promise.resolve(h.v);
    const f = this.inFlight.get(key);
    if (f) return f;
    const p = load().then((v) => {
      if (this.hits.size >= this.max) this.hits.delete(this.hits.keys().next().value!);
      this.hits.set(key, { at: now, v });
      return v;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }
}

export function wealthInfoRoutes(o: { fetch?: Fetch; now?: () => number } = {}) {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const limiter = new KeyedLimiter();
  const caches = {
    cms: new Cache<Json>(TTL.cms, 2),
    holdings: new Cache<Json | null>(TTL.holdings),
    quote: new Cache<Json | null>(TTL.quote),
    vault: new Cache<Json | null>(TTL.vault),
    locale: new Cache<Json | null>(TTL.locale, 20),
    basket: new Cache<Basket | null>(10 * MIN, 10),
    marks: new Cache<Map<string, number>>(MIN, 1),
    earn: new Cache<{ points: Array<[number, number]>; apy: Array<[number, number]> }>(60 * MIN, 1),
    answer: new Cache<FundInfo | null>(TTL.answer, 400),
  };

  async function get(url: string, extra: Record<string, string> = {}): Promise<Json | null> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await doFetch(url, { headers: { Accept: 'application/json', ...extra }, signal: ac.signal });
      if (r.status !== 200) return null;
      return obj(await r.json().catch(() => null));
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /** JSON-RPC eth_calls in one batch; each result's hex or null. */
  async function ethCalls(chain: keyof typeof RPC, calls: Array<{ to: string; data: string }>): Promise<Array<string | null>> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] })));
      const r = await doFetch(RPC[chain], { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal: ac.signal });
      if (r.status !== 200) return calls.map(() => null);
      const j = (await r.json().catch(() => null)) as Array<{ id: number; result?: string }> | null;
      return calls.map((_, i) => { const x = Array.isArray(j) ? j.find((y) => y.id === i) : null; return typeof x?.result === 'string' && x.result.length > 2 ? x.result : null; });
    } catch {
      return calls.map(() => null);
    } finally {
      clearTimeout(t);
    }
  }
  const marks = () => caches.marks.get('marks', now(), async () => {
    const [perps, spot] = await Promise.all([get(`${GATEWAY}/perps/markets/tickers`), get(`${GATEWAY}/spot/markets/tickers`)]);
    const rows = (j: Json | null, mark: boolean) => arr(j?.data).map(obj).flatMap((x) => { const sym = str(x?.symbol); const p = (mark ? numOrNull(x?.markPrice) : null) ?? numOrNull(x?.lastPx); return sym && p !== null ? [[sym, p] as const] : []; });
    return new Map([...rows(spot, false), ...rows(perps, true)]);
  });
  const basket = (fundId: string) => caches.basket.get(fundId, now(), async (): Promise<Basket | null> => {
    const b = BASKETS[fundId];
    if (!b) return null;
    let items: Array<{ name: string; ticker: string; quantity: number }>;
    if (b.kind === 'v2') {
      const [comp] = await ethCalls(b.chain, [{ to: b.token, data: '0x803a50f7' }]);
      if (!comp) return null;
      const { tokens, units } = decodeAddrUints(comp);
      const syms = await ethCalls(b.chain, tokens.map((to) => ({ to, data: '0x95d89b41' })));
      items = tokens.map((tok, i) => { const sym = syms[i] ? decodeString(syms[i]!) : tok.slice(0, 8); return { name: tickerOf(sym), ticker: tickerOf(sym), quantity: Number(units[i]!) / 1e18 }; });
    } else {
      const [set] = await ethCalls(b.chain, [{ to: b.token, data: '0x7b73ff04' }]);
      if (!set) return null;
      items = decodeTokenset(set).map((r) => ({ name: tickerOf(r.symbol), ticker: tickerOf(r.symbol), quantity: Number(r.amount) / 10 ** r.decimals }));
    }
    if (!items.length) return null;
    const w = weigh(items, await marks().catch(() => new Map<string, number>()));
    return { ...w, chain: b.chain, token: b.token };
  });

  const cms = () => caches.cms.get('cms', now(), async () => {
    const j = await get(CMS);
    const d = obj(j?.data);
    if (!d || d.schemaVersion !== 2) throw new Error('SoDEX’s fund content did not load');
    return d;
  });
  const holdings = (id: number) => caches.holdings.get(String(id), now(), () => get(`${KEYSTONE}/${id}/holdings`));
  const quote = (id: number) => caches.quote.get(String(id), now(), () => get(`${KEYSTONE}/${id}/quote`));
  const vault = (fundId: string) => caches.vault.get(fundId, now(), () => get(`${WEALTH}/funds/${encodeURIComponent(fundId)}`));
  const locale = (lang: string) => caches.locale.get(lang, now(), () => get(`${LOCALES}/${lang}/wealth.json`));

  async function build(fundId: string, lang: string): Promise<FundInfo | null> {
    const c = await cms();
    const product = arr(c.products).map(obj).find((p) => p && String(p.fundId ?? '').toLowerCase() === fundId.toLowerCase()) ?? null;
    const isAnt = fundId.toLowerCase() === 'antb';
    const basketId = Object.keys(BASKETS).find((k) => k.toLowerCase() === fundId.toLowerCase()) ?? null;
    const isUssi = fundId.toLowerCase() === 'vussi';
    if (!product && !isAnt && !basketId && !isUssi) return null;
    const detail = obj(product?.detail);
    const ks = obj(obj(product?.dataSources)?.keystone);
    const ksId = numOrNull(ks?.instrumentId);
    const fundType = str(product?.fundType);
    const [h, q, v, loc] = await Promise.all([
      ksId !== null ? holdings(ksId) : Promise.resolve(null),
      ksId !== null ? quote(ksId) : Promise.resolve(null),
      fundType === 'escrow_vault' ? vault(String(product!.fundId)) : Promise.resolve(null),
      isAnt ? locale(lang).then((l) => l ?? (lang === 'en' ? null : locale('en'))) : Promise.resolve(null),
    ]);
    const info: FundInfo = {
      fundId: product ? String(product.fundId) : basketId ?? (isUssi ? 'vUSSI' : 'antb'),
      lang,
      version: numOrNull(c.version),
      name: pick(detail?.displayName, lang),
      market: product?.tradingMarket === 'US' || product?.tradingMarket === 'CN' ? product.tradingMarket : null,
      underlying: ks ? { symbol: str(ks.symbol), fullSymbol: str(ks.fullSymbol), name: str(ks.name), currency: str(ks.currency) } : null,
      headline: null,
      features: arr(detail?.keyFeatures).map((x) => pick(x, lang)).filter((x): x is string => !!x).slice(0, 8),
      about: null,
      faq: [],
      curator: pick(obj(detail?.governance)?.curatorDisplayName, lang),
      social: arr(detail?.socialMedia).map(obj).flatMap((s) => { const url = safeUrl(s?.url); return url ? [{ type: str(s?.type) ?? 'link', url, name: pick(s?.name, lang) }] : []; }).slice(0, 6),
      holdings: null,
      underlyingQuote: null,
      vault: null,
      earn: null,
    };
    const hl = obj(detail?.highlight);
    if (hl && hl.mode === 'text') info.headline = { title: pick(hl.title, lang), subtitle: pick(hl.subtitle, lang), points: arr(hl.phrases).map((x) => pick(x, lang)).filter((x): x is string => !!x).slice(0, 6) };
    const about = obj(detail?.about);
    const body = pick(about?.body, lang);
    if (body) info.about = { title: pick(about?.title, lang), body: paras(body) };
    info.faq = arr(detail?.faq).map(obj).flatMap((f) => {
      const qq = pick(f?.question, lang);
      const a = pick(f?.answer, lang);
      if (!qq || !a) return [];
      const t = f?.answerFormat === 'html' ? htmlToText(a) : { paragraphs: paras(a), links: [] };
      return [{ q: qq, a: t.paragraphs, links: t.links }];
    }).slice(0, 16);

    // Holdings: keystone's live list, top by weight; SoDEX's own fallback when keystone has none (sodex.com's rule:
    // shown only when one row has a ticker and at least 1%).
    const hd = obj(h?.data);
    const port = obj(hd?.portfolio);
    const live = arr(hd?.holdings).map(obj).flatMap((r) => {
      const wgt = numOrNull(r?.weight);
      const name = str(r?.held_name);
      return wgt !== null && name ? [{ name, ticker: str(r?.held_symbol), weight: wgt }] : [];
    }).sort((a, b) => b.weight - a.weight);
    const asOf = str(port?.as_of) ?? str(arr(hd?.holdings).map(obj)[0]?.as_of);
    if (live.some((r) => r.ticker && r.weight >= 0.01)) {
      info.holdings = {
        source: 'live', asOf, total: numOrNull(port?.total_count) ?? numOrNull(hd?.count) ?? live.length,
        stale: asOf ? now() - Date.parse(`${asOf}T00:00:00Z`) > 7 * 86_400_000 : false,
        rows: live.slice(0, HOLDINGS_SHOWN),
      };
    } else {
      const fb = arr(detail?.topHoldingsFallback).map(obj).flatMap((r) => {
        const wgt = numOrNull(r?.weightRatio);
        const name = pick(r?.name, lang);
        return wgt !== null && name ? [{ name, ticker: str(r?.ticker), weight: wgt }] : [];
      }).sort((a, b) => b.weight - a.weight);
      if (fb.length) info.holdings = { source: 'sodex', asOf: null, total: fb.length, stale: false, rows: fb.slice(0, HOLDINGS_SHOWN) };
    }
    const qd = obj(obj(q?.data)?.quote);
    if (qd) {
      info.underlyingQuote = {
        since: str(qd.roi_inception_since), marketCap: numOrNull(qd.market_cap), high52w: numOrNull(qd.high_52w), low52w: numOrNull(qd.low_52w),
        currency: str(qd.currency), kind: str(qd.class), pe: numOrNull(qd.pe_ttm),
      };
    }
    const vd = obj(v?.data);
    if (vd) {
      const cfg = obj(vd.chainConfig);
      const rate = (x: unknown) => { const n = numOrNull(x); return n === null ? null : n / 1e18; };
      info.vault = {
        issuer: str(vd.issuerName), launched: str(vd.inceptionDate), managementFee: rate(cfg?.mgmtFeeRate), performanceFee: rate(cfg?.perfFeeRate),
        minDeposit: str(cfg?.minDeposit) ?? str(obj(vd.subscription)?.minimumSubscribeAmount), minRedeemShares: str(cfg?.minRedeemShares),
      };
    }
    const se = obj(detail?.stableEarn);
    if (se) {
      const rules = obj(se.tradingRules);
      const ab = obj(se.about);
      const steps = (x: unknown) => { const s = obj(x); return [pick(s?.submitDescription, lang), pick(s?.conversionDescription, lang), pick(s?.deliveryDescription, lang)].filter((t): t is string => !!t); };
      info.earn = {
        minIn: str(rules?.minimumSubscription), minOut: str(rules?.minimumRedemption), vaultName: pick(se.vaultDisplayName, lang),
        shareToken: pick(ab?.shareTokenDescription, lang), crossChain: pick(ab?.crossChainDescription, lang), risk: pick(ab?.riskDisclaimer, lang),
        subscription: steps(rules?.subscription), redemption: steps(rules?.redemption),
      };
      const sh = obj(se.highlight);
      if (sh) info.headline = { title: pick(sh.title, lang), subtitle: pick(sh.description, lang), points: arr(sh.items).map((x) => pick(obj(x)?.text, lang)).filter((x): x is string => !!x).slice(0, 6) };
      if (!info.features.length) info.features = arr(se.keyFeatures).map((x) => pick(x, lang)).filter((x): x is string => !!x).slice(0, 8);
      const ov = pick(ab?.overview, lang);
      if (ov) info.about = { title: pick(ab?.title, lang), body: paras(ov) };
    }
    // An SSI index token: its basket from its own contract, the same breakdown sodex.com shows.
    if (basketId) {
      const bk = await basket(basketId).catch(() => null);
      info.name = info.name ?? BASKETS[basketId]!.name;
      if (bk) {
        info.holdings = { source: 'chain', asOf: null, total: bk.rows.length, stale: false, rows: bk.rows.filter((r) => r.weight !== null).map((r) => ({ name: r.name, ticker: r.ticker, weight: r.weight! })), unpriced: bk.unpriced };
      }
    }
    if (isUssi) {
      info.name = 'USSI';
      info.holdingsNote = 'USSI is redeemable in USDC and hedged off chain: its contract holds no basket, and SoSoValue publishes its holdings only through a keyed API.';
    }
    if (isAnt) {
      const l = loc ?? {};
      const t = (k: string) => str(l[k]);
      info.name = info.name ?? 'ANT Believers Index';
      info.about = { title: null, body: ['ant_index_about_tracking', 'ant_index_about_compute', 'ant_index_about_holdings', 'ant_index_about_exposure'].map(t).filter((x): x is string => !!x) };
      if (!info.about.body.length) info.about = null;
      info.features = ['ant_index_feature_tracking', 'ant_index_detail_feature_eligibility', 'ant_index_detail_feature_weighting'].map(t).filter((x): x is string => !!x);
      info.faq = Object.keys(l).filter((k) => /^antb_faq_[a-z_]+_question$/.test(k)).flatMap((k) => {
        const qq = t(k);
        const a = t(k.replace(/_question$/, '_answer'));
        return qq && a ? [{ q: qq, a: paras(a), links: [] }] : [];
      }).slice(0, 16);
    }
    return info;
  }

  const earnHistory = () => caches.earn.get('earn', now(), async () => {
    const hourFrom = Math.floor(now() / 1000) - 30 * 86_400;
    const j = await get(`${MORPHO}?query=${encodeURIComponent(earnQuery(EARN_FROM, hourFrom))}`, { 'apollo-require-preflight': 'true' });
    const h = obj(obj(obj(j?.data)?.vaultV2ByAddress)?.historicalState);
    const series = (v: unknown, scale: number) => arr(v).map(obj)
      .flatMap((p) => { const x = numOrNull(p?.x); const y = numOrNull(p?.y); return x !== null && y !== null && y >= 0 ? [[x * 1000, y * scale] as [number, number]] : []; })
      .sort((a, b) => a[0] - b[0]);
    const points = series(h?.sharePrice, 1).filter((p) => p[1] > 0);
    if (points.length < 2) throw new Error('USDC Earn’s history did not load');
    // Daily before the last 30 days, hourly within them (the spikes sodex.com's chart shows are hours, not days).
    const hour = series(h?.apyHour, 100);
    const cut = hour[0]?.[0] ?? Infinity;
    const apy = [...series(h?.apyDay, 100).filter((p) => p[0] < cut), ...hour];
    return { points, apy };
  });

  return async function routes(app: FastifyInstance): Promise<void> {
    // What sodex.com lists right now (owner 2026-11-28: "block that automatically as long as sodex does"): each fund in
    // SoDEX's CMS with whether it is listed (visibility 'listed' and on a homepage shelf), its shelf and order. A fund
    // SoDEX has but does not list reads as coming soon on ValueDesk.
    app.get('/api/vs/wealth/listing', async (req, reply) => {
      const wait = limiter.take(`winfo|${clientKey(req.ip)}`, WEALTH_INFO_LIMIT, now());
      if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
      try {
        const c = await cms();
        const shelves = obj(c.homepageCategories) ?? {};
        const onShelf = new Set(Object.values(shelves).flatMap((v) => arr(v).map((x) => String(x))));
        const funds: Record<string, { listed: boolean; visibility: string | null; category: string | null; sort: number | null }> = {};
        for (const p of arr(c.products).map(obj)) {
          const id = str(p?.fundId);
          if (!id) continue;
          const visibility = str(p?.visibility);
          funds[id] = { listed: visibility === 'listed' && onShelf.has(String(p?.productKey ?? '')), visibility, category: str(p?.category), sort: numOrNull(p?.sort) };
        }
        reply.header('Cache-Control', 'public, max-age=300');
        return reply.send({ ok: true, version: numOrNull(c.version), funds });
      } catch (e) {
        return reply.code(502).send({ ok: false, error: (e as Error).message || 'SoDEX did not answer' });
      }
    });

    app.get('/api/vs/wealth/history', async (req, reply) => {
      const wait = limiter.take(`winfo|${clientKey(req.ip)}`, WEALTH_INFO_LIMIT, now());
      if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
      if ((req.query as { fund?: unknown }).fund !== 'Morpho-Earn') return reply.code(404).send({ ok: false, error: 'only USDC Earn’s history is relayed; the other funds have SoDEX’s own' });
      try {
        const { points, apy } = await earnHistory();
        reply.header('Cache-Control', 'public, max-age=3600');
        return reply.send({ ok: true, fund: 'Morpho-Earn', source: 'morpho', points, apy });
      } catch (e) {
        return reply.code(502).send({ ok: false, error: (e as Error).message || 'Morpho did not answer' });
      }
    });
    app.get('/api/vs/wealth/info', async (req, reply) => {
      const wait = limiter.take(`winfo|${clientKey(req.ip)}`, WEALTH_INFO_LIMIT, now());
      if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
      const qs = req.query as { fund?: unknown; lang?: unknown };
      const fund = typeof qs.fund === 'string' ? qs.fund : '';
      if (!FUND.test(fund)) return reply.code(400).send({ ok: false, error: 'fund must be a SoDEX Wealth fund id' });
      const raw = typeof qs.lang === 'string' ? qs.lang.toLowerCase().split('-')[0]! : 'en';
      const lang = (INFO_LANGS as readonly string[]).includes(raw) ? raw : 'en';
      try {
        const info = await caches.answer.get(`${fund.toLowerCase()}|${lang}`, now(), () => build(fund, lang));
        if (!info) return reply.code(404).send({ ok: false, error: 'SoDEX publishes nothing about this fund' });
        reply.header('Cache-Control', 'public, max-age=300');
        return reply.send({ ok: true, info });
      } catch (e) {
        return reply.code(502).send({ ok: false, error: (e as Error).message || 'SoDEX did not answer' });
      }
    });
  };
}
