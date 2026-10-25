/**
 * Each venue's maintenance margin per market, and its open interest - read
 * from the venue's own market list, one request per venue, kept an hour
 * (margin) or a minute (open interest):
 *
 *   hyperliquid  POST /info metaAndAssetCtxs              weight 20: marginTables tiers (a table
 *                                                         id under 50 is one tier at that leverage)
 *   tradexyz     the same with dex "xyz"                  weight 20
 *   sodex        GET perps /markets/symbols + /tickers    marginTiers (rate and deduction published)
 *   lighter      GET /api/v1/orderBookDetails             maintenance_margin_fraction (1e-4 units), one rate
 *   arcus        GET /v1/markets                          maintenanceMarginFraction, one rate
 *
 * Hyperliquid's rate per tier is 1 / (2 x that tier's max leverage) - its docs,
 * and what its `crossMaintenanceMarginUsed` adds up to (checked 2026-10-25).
 * Open interest is in coins, one side (Lighter's `open_interest_usd` counts both).
 */
import { VENUES, type Venue } from '../types.js';
import { hlInfo } from '../hyperliquid/index.js';
import { gwGet } from '../sodex/gateway.js';
import { LIGHTER_API, lighterPacer } from '../extra/lighter.js';
import { ARCUS_API, arcusPacer } from '../extra/arcus.js';
import { num, type Pacer } from '../extra/http.js';
import { flatTiers, tiersOf, type Tiers } from './math.js';

export interface VenueMarkets {
  /** symbol (as the venue's stream names it) -> maintenance tiers. */
  tiers: Map<string, Tiers>;
  /** symbol -> open interest in coins (one side) and the venue's mark. */
  oi: Map<string, { oi: number; px: number | null }>;
  at: number;
}

const RULES_TTL = 60 * 60_000;
const OI_TTL = 60_000;
/** After a failed read, wait this long before the next try. */
const RETRY_MS = 60_000;

type HlMeta = {
  universe?: Array<{ name?: string; maxLeverage?: number; marginTableId?: number }>;
  marginTables?: Array<[number, { marginTiers?: Array<{ lowerBound?: string; maxLeverage?: number }> }]>;
};
type HlCtx = { openInterest?: string; markPx?: string | null };

/** Hyperliquid's tiers for every market of one dex (pure: tests feed it a meta). */
export function hlTiers(meta: HlMeta | null | undefined): Map<string, Tiers> {
  const tables = new Map<number, Tiers>();
  for (const [id, t] of meta?.marginTables ?? []) {
    tables.set(Number(id), tiersOf((t?.marginTiers ?? []).map((x) => ({ lb: num(x.lowerBound) ?? 0, r: 1 / (2 * Number(x.maxLeverage)) }))));
  }
  const out = new Map<string, Tiers>();
  for (const u of meta?.universe ?? []) {
    if (!u.name) continue;
    const id = Number(u.marginTableId);
    const lev = Number(u.maxLeverage);
    const t = tables.get(id) ?? (id > 0 && id < 50 ? flatTiers(1 / (2 * id)) : lev > 0 ? flatTiers(1 / (2 * lev)) : null);
    if (t?.length) out.set(u.name, t);
  }
  return out;
}

async function readHl(dex: string | null, withRules: boolean): Promise<Partial<VenueMarkets>> {
  const raw = await hlInfo.post<[HlMeta, HlCtx[]] | null>(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, { ttlMs: OI_TTL / 2 });
  if (!Array.isArray(raw)) throw new Error('Hyperliquid: no market list');
  const [meta, ctxs] = raw;
  const oi = new Map<string, { oi: number; px: number | null }>();
  (meta?.universe ?? []).forEach((u, i) => {
    const c = ctxs?.[i];
    const n = num(c?.openInterest ?? null);
    if (u.name && n !== null) oi.set(u.name, { oi: n, px: num(c?.markPx ?? null) });
  });
  return withRules ? { tiers: hlTiers(meta), oi } : { oi };
}

type SodexSymbol = { name?: string; marginTiers?: Array<{ maxNotionalValue?: string; maintenanceMarginRate?: string; maintenanceDeduction?: string }> };

/** SoDEX's tiers: each row's bound is the upper one, so a tier starts where the one before ended. */
export function sodexTiers(list: readonly SodexSymbol[]): Map<string, Tiers> {
  const out = new Map<string, Tiers>();
  for (const s of list) {
    if (!s.name) continue;
    let lb = 0;
    const rows = (s.marginTiers ?? []).map((t) => {
      const row = { lb, r: num(t.maintenanceMarginRate) ?? 0, ded: num(t.maintenanceDeduction) ?? 0 };
      lb = num(t.maxNotionalValue) ?? Infinity;
      return row;
    });
    // SoDEX states its liquidation prices at the tier the position is in now (math.ts Tiers.now).
    const t = tiersOf(rows, { now: true });
    if (t.length) out.set(s.name, t);
  }
  return out;
}

const listOf = <T>(j: unknown): T[] => (Array.isArray(j) ? j : Array.isArray((j as { data?: unknown })?.data) ? (j as { data: T[] }).data : []) as T[];

async function readSodex(withRules: boolean): Promise<Partial<VenueMarkets>> {
  const [syms, tickers] = await Promise.all([
    withRules ? gwGet<unknown>('/api/v1/perps/markets/symbols') : Promise.resolve(null),
    gwGet<unknown>('/api/v1/perps/markets/tickers'),
  ]);
  const oi = new Map<string, { oi: number; px: number | null }>();
  for (const t of listOf<{ symbol?: string; openInterest?: string; markPrice?: string }>(tickers)) {
    const n = num(t.openInterest ?? null);
    if (t.symbol && n !== null) oi.set(t.symbol, { oi: n, px: num(t.markPrice ?? null) });
  }
  return withRules ? { tiers: sodexTiers(listOf<SodexSymbol>(syms)), oi } : { oi };
}

type LighterBook = { symbol?: string; market_type?: string; maintenance_margin_fraction?: number; open_interest?: number; mark_price?: string };

export function lighterMarkets(list: readonly LighterBook[]): VenueMarkets {
  const tiers = new Map<string, Tiers>();
  const oi = new Map<string, { oi: number; px: number | null }>();
  for (const b of list) {
    if (!b.symbol || (b.market_type && b.market_type !== 'perp')) continue;
    const t = flatTiers(Number(b.maintenance_margin_fraction) / 10_000);
    if (t.length) tiers.set(b.symbol, t);
    const n = num(b.open_interest ?? null);
    if (n !== null) oi.set(b.symbol, { oi: n, px: num(b.mark_price ?? null) });
  }
  return { tiers, oi, at: Date.now() };
}

async function readLighter(pacer: Pacer): Promise<Partial<VenueMarkets>> {
  const j = await pacer.get<{ order_book_details?: LighterBook[] }>(`${LIGHTER_API}/api/v1/orderBookDetails`);
  return lighterMarkets(j.order_book_details ?? []);
}

type ArcusMarket = { marketDisplayName?: string; maintenanceMarginFraction?: string; openInterest?: string; markPrice?: string; type?: string };

export function arcusMarkets(list: readonly ArcusMarket[]): VenueMarkets {
  const tiers = new Map<string, Tiers>();
  const oi = new Map<string, { oi: number; px: number | null }>();
  for (const m of list) {
    if (!m.marketDisplayName || (m.type && m.type !== 'PERPETUAL')) continue;
    const t = flatTiers(num(m.maintenanceMarginFraction ?? null) ?? 0);
    if (t.length) tiers.set(m.marketDisplayName, t);
    const n = num(m.openInterest ?? null);
    if (n !== null) oi.set(m.marketDisplayName, { oi: n, px: num(m.markPrice ?? null) });
  }
  return { tiers, oi, at: Date.now() };
}

async function readArcus(pacer: Pacer): Promise<Partial<VenueMarkets>> {
  const j = await pacer.get<unknown>(`${ARCUS_API}/v1/markets`, 20);
  const list = Array.isArray(j) ? j : ((j as { markets?: unknown[] }).markets ?? Object.values(j as object));
  return arcusMarkets(list as ArcusMarket[]);
}

/** Pacers per thread: the indexer passes its own lanes' (cohortTracker.ts deps). */
export interface RulesPacers {
  lighter?: Pacer;
  arcus?: Pacer;
}

const state = new Map<Venue, { m: VenueMarkets | null; rulesAt: number; oiAt: number; failedAt: number; inflight: Promise<VenueMarkets | null> | null }>();
let pacers: RulesPacers = {};

export function setRulesPacers(p: RulesPacers): void {
  pacers = p;
}

async function refresh(venue: Venue): Promise<VenueMarkets | null> {
  const st = state.get(venue)!;
  const now = Date.now();
  const withRules = !st.m || now - st.rulesAt >= RULES_TTL;
  try {
    const got = venue === 'hyperliquid' ? await readHl(null, withRules)
      : venue === 'tradexyz' ? await readHl('xyz', withRules)
        : venue === 'sodex' ? await readSodex(withRules)
          : venue === 'lighter' ? await readLighter(pacers.lighter ?? lighterPacer)
            : await readArcus(pacers.arcus ?? arcusPacer);
    const m: VenueMarkets = { tiers: got.tiers ?? st.m?.tiers ?? new Map(), oi: got.oi ?? st.m?.oi ?? new Map(), at: now };
    if (got.tiers) st.rulesAt = now;
    st.oiAt = now;
    st.m = m;
    return m;
  } catch {
    st.failedAt = now;
    return st.m;
  }
}

/**
 * A venue's markets: from the cache while fresh (`oi` asks for open interest no
 * older than a minute; margin rules are kept an hour), else read now. Null when
 * the venue has never answered.
 */
export async function venueMarkets(venue: Venue, o: { oi?: boolean } = {}): Promise<VenueMarkets | null> {
  let st = state.get(venue);
  if (!st) { st = { m: null, rulesAt: 0, oiAt: 0, failedAt: 0, inflight: null }; state.set(venue, st); }
  const now = Date.now();
  const stale = !st.m || now - st.rulesAt >= RULES_TTL || (o.oi && now - st.oiAt >= OI_TTL);
  if (!stale || now - st.failedAt < RETRY_MS) return st.m;
  if (!st.inflight) st.inflight = refresh(venue).finally(() => { st!.inflight = null; });
  return st.inflight;
}

/** What is cached now, without a read (null before the first). */
export function marketsNow(venue: Venue): VenueMarkets | null {
  return state.get(venue)?.m ?? null;
}

/** Every venue's markets, read where stale (in parallel). */
export async function allMarkets(o: { oi?: boolean } = {}): Promise<Map<Venue, VenueMarkets | null>> {
  const got = await Promise.all(VENUES.map((v) => venueMarkets(v, o)));
  return new Map(VENUES.map((v, i) => [v, got[i]!]));
}

/** Tests: a venue's markets as given. */
export function _setMarkets(venue: Venue, m: VenueMarkets | null): void {
  state.set(venue, { m, rulesAt: m ? Date.now() : 0, oiAt: m ? Date.now() : 0, failedAt: m ? 0 : Date.now(), inflight: null });
}
