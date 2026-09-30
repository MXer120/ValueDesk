/**
 * One trader on one venue - profile, fills, and Scan's account band (open
 * orders, order history, funding, balances) - read from the user's own browser.
 *
 * This is the Valuescan server's /api/vs/trader, /fills and /account, minus the
 * server: the SAME provider code runs here (imported through `@sign`), bound to
 * browser clients that spend each user's own IP budget at each venue:
 *
 *   sodex        valuescan/sodex/traderCore.ts over the gateway + data host
 *   hyperliquid  valuescan/hyperliquid/trader.ts over this runtime's /info client
 *   tradexyz / lighter / arcus  valuescan/extra/providers.ts (their own pacers)
 *
 * Only one input still comes from Valuescan: a Hyperliquid address's row on
 * Hyperliquid's leaderboard (rank and aggregated PnL). That row lives in the
 * server's index - the file behind it is 39 MB - so it is one small index read.
 */
import { NotAvailable, type TraderProfile, type TraderRow, type Venue, type VsBalance, type VsFill, type VsFunding, type VsOrder } from '@sign/valuescan/types.js';
import { shownLabel } from '@sign/valuescan/labels.js';
import { buildSodexProfile, fillLimit, sodexFills, type SodexTraderIo } from '@sign/valuescan/sodex/traderCore.js';
import { gatewayReads } from '@sign/valuescan/sodex/gatewayCore.js';
import { coolingDown } from '@sign/valuescan/sodex/util.js';
import { hlFills, hlTrader, type LbRowSource } from '@sign/valuescan/hyperliquid/trader.js';
import { hlInfo } from '@sign/valuescan/hyperliquid/client.js';
import { hlPriceSeries, type PriceRange, type PriceSeries } from '@sign/valuescan/hyperliquid/price.js';
import { ACCOUNT_DETAIL, arcusProvider, lighterProvider, nameSpotFills, tradexyzProvider } from '@sign/valuescan/extra/providers.js';
import { dataReads } from './sodexData';
import { gwGet } from './sodexGateway';
import { RequestGate } from './gate';

/** A venue failure, as the server's `{ok:false, code, error}` answered it. */
export class VenueError extends Error {
  constructor(
    message: string,
    readonly code: 'not_available' | 'upstream' | 'bad_request',
  ) {
    super(message);
    this.name = 'VenueError';
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function addressOf(a: string): string {
  if (!a || !ADDRESS_RE.test(a)) throw new VenueError('a valid 0x wallet address is required', 'bad_request');
  return a.toLowerCase();
}

/** NotAvailable -> not_available, everything else -> upstream (what the route's `fail` did). */
function asVenueError(e: unknown): VenueError {
  if (e instanceof VenueError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new VenueError(msg, e instanceof NotAvailable ? 'not_available' : 'upstream');
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw asVenueError(e);
  }
}

// --- SoDEX ---------------------------------------------------------------------------------

const sodexIo: SodexTraderIo = {
  ...gatewayReads((path, weight) => gwGet(path, weight !== undefined ? { weight } : {})),
  portfolioChart: (accountId, window) => dataReads.portfolioChart(accountId, window),
  lbRank: (window, sortBy, address) => dataReads.lbRank(window, sortBy, address),
  coolingDown,
};

// Whole answers, briefly (the server kept a profile 30 s and fills 20 s).
const answers = new RequestGate(500);
const PROFILE_TTL = 30_000;
const FILLS_TTL = 20_000;

// --- Hyperliquid: the leaderboard row comes from the index -------------------------------

/**
 * One address's Hyperliquid leaderboard row from the Valuescan index, or null
 * (not listed, or the index cannot say).
 *
 * `/api/vs/lbrow` answers exactly what the server's profile used: the row
 * ranked by 30-day PnL, with its rank change (hyperliquid/index.ts
 * hlLeaderboardRow). Where the index does not serve it yet, the same row -
 * HL's own figures - comes from the index's leaderboard search; that search
 * ranks by another ordering, so its rank is left out rather than shown wrong.
 */
/** The index answered 404 for /api/vs/lbrow: an older server - ask its search instead, for the rest of this session. */
let lbrowMissing = false;

async function hlIndexRow(address: string): Promise<TraderRow | null> {
  if (!lbrowMissing) {
    try {
      const res = await fetch(`/api/vs/lbrow?venue=hyperliquid&address=${address}`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { ok?: boolean; row?: TraderRow | null } | null;
        return body?.ok ? (body.row ?? null) : null;
      }
      if (res.status !== 404) return null;
      lbrowMissing = true;
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(`/api/vs/leaderboard?venue=hyperliquid&window=30d&sort=volume&limit=1&q=${address}`, { headers: { Accept: 'application/json' } });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; rows?: TraderRow[] } | null;
    const row = body?.ok ? body.rows?.find((r) => r.address.toLowerCase() === address) : undefined;
    return row ? { ...row, rank: undefined, rankChange: null } : null;
  } catch {
    return null;
  }
}

/** A leaderboard source for one address, in the shape hlTrader asks for. */
function indexRowSource(address: string): { snapshot(): Promise<LbRowSource>; peek(): null; previous(): null } {
  return {
    async snapshot() {
      const row = await hlIndexRow(address);
      // rowFor is asked for exactly this address, rank by 30-day PnL - what the index answered.
      return { rowFor: (a: string) => (row && a.toLowerCase() === row.address.toLowerCase() ? { ...row } : null) };
    },
    peek: () => null,
    previous: () => null,
  };
}

// --- one interface over every venue ---------------------------------------------------------

async function traderOf(venue: Venue, address: string): Promise<TraderProfile | null> {
  switch (venue) {
    case 'sodex':
      return buildSodexProfile(sodexIo, address);
    case 'hyperliquid':
      return hlTrader(address, { info: hlInfo, leaderboard: indexRowSource(address) });
    case 'tradexyz':
      return tradexyzProvider.trader(address);
    case 'lighter':
      return lighterProvider.trader(address);
    case 'arcus':
      return arcusProvider.trader(address);
  }
}

async function fillsOf(venue: Venue, address: string, o: { from?: number; to?: number; limit: number }): Promise<VsFill[]> {
  switch (venue) {
    case 'sodex':
      return sodexFills(sodexIo, address, o, fillLimit(o.limit));
    case 'hyperliquid':
      return nameSpotFills(await hlFills(hlInfo, address, o));
    case 'tradexyz':
      return tradexyzProvider.fills(address, o);
    case 'lighter':
      return lighterProvider.fills(address, o);
    case 'arcus':
      return arcusProvider.fills(address, o);
  }
}

const intOf = (v: number | undefined, dflt: number, min: number, max: number): number => {
  const n = v === undefined || !Number.isFinite(v) ? dflt : Math.trunc(v);
  return Math.min(max, Math.max(min, n));
};

export const venues = {
  /** The venue's profile of one address, or null when it has no account there. */
  trader(venue: Venue, addressIn: string): Promise<TraderProfile | null> {
    return guarded(async () => {
      const address = addressOf(addressIn);
      const profile = await answers.run(`trader:${venue}:${address}`, PROFILE_TTL, () => traderOf(venue, address));
      // A copy (the provider caches the profile object); no names anywhere (valuescan/labels.ts).
      return profile ? { ...profile, summary: { ...profile.summary, label: shownLabel(profile.summary.address, profile.summary.label) } } : profile;
    });
  },

  /** The newest fills, newest first (the route's default limit was 2,000). */
  fills(venue: Venue, addressIn: string, o: { from?: number; to?: number; limit?: number } = {}): Promise<VsFill[]> {
    return guarded(async () => {
      const address = addressOf(addressIn);
      const q = { from: o.from, to: o.to, limit: intOf(o.limit, 2000, 1, 100_000) };
      return answers.run(`fills:${venue}:${address}:${q.from ?? ''}:${q.to ?? ''}:${q.limit}`, FILLS_TTL, () => fillsOf(venue, address, q));
    });
  },

  openOrders(venue: Venue, addressIn: string): Promise<VsOrder[]> {
    return guarded(async () => {
      const d = ACCOUNT_DETAIL[venue];
      if (!d?.openOrders) throw new NotAvailable(`${venue} open orders are not public`);
      return d.openOrders(addressOf(addressIn));
    });
  },

  orderHistory(venue: Venue, addressIn: string, limit?: number): Promise<VsOrder[]> {
    return guarded(async () => {
      const d = ACCOUNT_DETAIL[venue];
      if (!d?.orderHistory) throw new NotAvailable(`${venue} order history is not public`);
      return d.orderHistory(addressOf(addressIn), { limit: intOf(limit, 500, 1, 2000) });
    });
  },

  funding(venue: Venue, addressIn: string, o: { from?: number; limit?: number } = {}): Promise<VsFunding[]> {
    return guarded(async () => {
      const d = ACCOUNT_DETAIL[venue];
      if (!d?.funding) throw new NotAvailable(`${venue} funding history is not public`);
      return d.funding(addressOf(addressIn), { from: o.from, limit: intOf(o.limit, 500, 1, 2000) });
    });
  },

  balances(venue: Venue, addressIn: string): Promise<VsBalance[]> {
    return guarded(async () => {
      const d = ACCOUNT_DETAIL[venue];
      if (!d?.balances) throw new NotAvailable(`${venue} balances are not public`);
      return d.balances(addressOf(addressIn));
    });
  },

  /**
   * A coin's price over a range for the cohort asset page (Hyperliquid candles),
   * what the server's /api/vs/price answered - valuescan/hyperliquid/price.ts,
   * read with this runtime's /info client.
   */
  price(coin: string, range: PriceRange): Promise<PriceSeries & { ok: true }> {
    return guarded(async () => ({ ok: true as const, ...(await hlPriceSeries(hlInfo, coin, range)) }));
  },
};
