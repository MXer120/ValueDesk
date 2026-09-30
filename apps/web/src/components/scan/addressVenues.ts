/**
 * Which venues have a wallet, before Scan opens an explorer for it.
 *
 * One read per venue, the same ones Scan already uses:
 *   - both venues: `vsApi.trader` (Hyperliquid's clearinghouse profile, and
 *     SoDEX's account + portfolio chart). A null profile is "no account".
 *   - SoDEX, only when that read fails: the portfolio account fetch
 *     (`/api/acct/.../state` and positions). A 404 or `exists: false` is not
 *     an account. Any other failure is "couldn't check", not "absent".
 *
 * Inactive means the account is there but has no equity and no activity in
 * the last 30 days. It is still listed. Equity with no timestamp is active.
 */
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../api';
import { SCAN_VENUES, vsApi, VsError, type TraderProfile, type Venue } from '../../vsApi';
import { analyticsSuspectNote, curveOf, type HlCurve } from './hlModel';

export const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

export const VENUE_CHECK = 'Checking SoDEX and Hyperliquid…';
export const VENUE_NONE = 'No SoDEX or Hyperliquid account for this address.';
export const VENUE_FAIL = "Couldn't check SoDEX and Hyperliquid.";

export interface VenueCard {
  venue: Venue;
  /** Confirmed account (state, equity, or positions). */
  exists: boolean;
  /** The read failed. Not the same as "no account". */
  unknown: boolean;
  /** Exists, but no equity and no recent activity. Still shown. */
  inactive: boolean;
  equity: number | null;
  /** Newest fill, trade, or funding time, ms. Null when the venue didn't say. */
  lastActive: number | null;
  /** PnL window the portfolio chart already draws. Null when there aren't two points. */
  curve: HlCurve | null;
  /** The venue's history is unusable (`analyticsSuspect`): no curve, this sentence instead. */
  historyNote?: string | null;
  /** Shown the moment a search starts, before this venue answers. */
  pending?: boolean;
}

export type AddressVerdict =
  | { kind: 'one'; venue: Venue }
  | { kind: 'many' }
  | { kind: 'none' }
  | { kind: 'ask' };

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function absent(venue: Venue): VenueCard {
  return { venue, exists: false, unknown: false, inactive: false, equity: null, lastActive: null, curve: null };
}

export function unknownCard(venue: Venue): VenueCard {
  return { venue, exists: false, unknown: true, inactive: false, equity: null, lastActive: null, curve: null };
}

/** No positive equity and nothing recent: open positions, 30d volume, or a fill inside 30 days. */
export function inactiveVenue(p: TraderProfile, now = Date.now()): boolean {
  const s = p.summary;
  if (finite(s.accountValue) && s.accountValue > 0) return false;
  if (p.positions.length > 0) return false;
  if (finite(s.lastActive) && s.lastActive > 0 && now - s.lastActive <= RECENT_MS) return false;
  for (const w of ['1d', '7d', '30d'] as const) {
    const v = s.volume?.[w];
    if (finite(v) && v > 0) return false;
  }
  return true;
}

export function cardFromProfile(venue: Venue, profile: TraderProfile | null, now = Date.now()): VenueCard {
  if (!profile) return absent(venue);
  const s = profile.summary;
  const historyNote = analyticsSuspectNote(profile.analyticsSuspect);
  let curve: HlCurve | null = null;
  // A flagged history's PnL is its account value: no line rather than a wrong one.
  for (const w of historyNote ? [] : (['30d', 'all', '7d', '1d'] as const)) {
    curve = curveOf(profile.equity[w], 'pnl');
    if (curve) break;
  }
  return {
    venue,
    exists: true,
    unknown: false,
    inactive: inactiveVenue(profile, now),
    equity: finite(s.accountValue) ? s.accountValue : null,
    lastActive: finite(s.lastActive) && s.lastActive > 0 ? s.lastActive : null,
    curve,
    ...(historyNote ? { historyNote } : {}),
  };
}

/**
 * The SoDEX account card's own read, used when the multi-venue profile cannot
 * answer. `exists` with no equity and no open positions is an inactive account,
 * not a missing one. There is no chart on this path.
 */
export function accountStanding(
  account: { exists: boolean; accountValue: number },
  openPositions: number,
): 'active' | 'inactive' | 'none' {
  if (account.accountValue > 0 || openPositions > 0) return 'active';
  return account.exists ? 'inactive' : 'none';
}

export function verdictOf(cards: readonly VenueCard[]): AddressVerdict {
  const found = cards.filter((c) => c.exists);
  const unknown = cards.some((c) => c.unknown);
  if (found.length > 1) return { kind: 'many' };
  if (found.length === 1 && !unknown) return { kind: 'one', venue: found[0]!.venue };
  if (found.length === 0 && !unknown) return { kind: 'none' };
  return { kind: 'ask' };
}

/** Rows the chooser shows: every venue that exists, plus any we couldn't check. */
export function chooserCards(cards: readonly VenueCard[]): VenueCard[] {
  const v = verdictOf(cards);
  if (v.kind === 'many') return cards.filter((c) => c.exists);
  if (v.kind === 'ask') return cards.filter((c) => c.exists || c.unknown);
  return [];
}

export function chooserLead(cards: readonly VenueCard[]): string | null {
  const v = verdictOf(cards);
  if (v.kind === 'many') return 'This address is on more than one venue.';
  if (v.kind === 'ask') return "Couldn't check every venue. You can still open one.";
  return null;
}

/** Both venues, including an inactive account and one we could not check. */
export function overviewCards(cards: readonly VenueCard[]): VenueCard[] {
  return SCAN_VENUES.map((venue) => cards.find((c) => c.venue === venue) ?? absent(venue));
}

export interface NettedEquity {
  /** Sum of balances we could read. A venue with no account counts as 0. */
  equity: number | null;
  known: number;
  /** Venues that did not answer, so they are missing from the sum. */
  unread: number;
}

export function nettedEquity(cards: readonly VenueCard[]): NettedEquity {
  let equity = 0;
  let known = 0;
  let unread = 0;
  for (const c of overviewCards(cards)) {
    if (c.unknown) {
      unread += 1;
      continue;
    }
    if (!c.exists) {
      known += 1;
      continue;
    }
    if (c.equity !== null && Number.isFinite(c.equity)) {
      equity += c.equity;
      known += 1;
    } else unread += 1;
  }
  return { equity: known > 0 ? equity : null, known, unread };
}

/** The sentence above the two venue cards. One match still shows both. */
export function overviewLead(cards: readonly VenueCard[]): string {
  const v = verdictOf(cards);
  if (v.kind === 'many') return 'Both venues have this wallet.';
  if (v.kind === 'one') return 'One venue is active. The other stays here when the wallet has an account.';
  if (v.kind === 'none') return 'No SoDEX or Hyperliquid account for this address.';
  return "Couldn't check every venue. You can still open one.";
}

/** Header switch. Grayed: `inactive` (an account with nothing recent) and `none` (no account). */
export function switchStanding(
  r: { data: TraderProfile | null; loading: boolean; error: string | null; settled: boolean },
  now = Date.now(),
): 'active' | 'inactive' | 'none' | 'unknown' | 'loading' {
  if (r.error) return 'unknown';
  if (!r.settled || (r.loading && !r.data)) return 'loading';
  if (!r.data) return 'none';
  return inactiveVenue(r.data, now) ? 'inactive' : 'active';
}

/** Overview order: active, then inactive accounts, then unread, then no account. Pending keeps its place. */
export function overviewRank(c: VenueCard): number {
  if (c.pending) return 0;
  if (c.exists && !c.inactive) return 0;
  if (c.exists) return 1;
  if (c.unknown) return 2;
  return 3;
}

export function sortOverview(cards: readonly VenueCard[]): VenueCard[] {
  const at = (v: Venue) => SCAN_VENUES.indexOf(v);
  return [...cards].sort((a, b) => overviewRank(a) - overviewRank(b) || at(a.venue) - at(b.venue));
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function isNotFound(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 404;
  if (e instanceof VsError) return e.code === 'not_found' || /\b404\b/.test(e.message);
  return false;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** ms, or seconds when the venue sent those. */
function stamp(row: unknown, keys: string[]): number | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  for (const k of keys) {
    const n = numOrNull(rec[k]);
    if (n === null || n <= 0) continue;
    return n < 1e11 ? n * 1000 : n;
  }
  return null;
}

function accountBodyExists(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as { exists?: boolean; accountId?: unknown; state?: { aid?: unknown; av?: unknown; P?: unknown[] } };
  if (b.exists === true) return true;
  const aid = Number(b.accountId ?? b.state?.aid ?? 0);
  if (Number.isFinite(aid) && aid !== 0) return true;
  const av = numOrNull(b.state?.av);
  if (av !== null && av > 0) return true;
  const P = b.state?.P;
  if (Array.isArray(P) && P.some((p) => {
    const sz = numOrNull((p as { sz?: unknown; size?: unknown })?.sz ?? (p as { size?: unknown })?.size);
    return sz !== null && sz !== 0;
  })) return true;
  return false;
}

function openPositionCount(body: unknown): number {
  const rows = (body as { positions?: unknown[] } | null)?.positions;
  if (!Array.isArray(rows)) return 0;
  return rows.filter((p) => {
    const sz = numOrNull((p as { size?: unknown; sz?: unknown })?.size ?? (p as { sz?: unknown })?.sz);
    return sz !== null && sz !== 0;
  }).length;
}

async function sodexLastActive(address: string): Promise<number | null> {
  const [perps, spot, funding] = await Promise.all([
    api.userTrades('perps', address, 20).catch(() => null),
    api.userTrades('spot', address, 20).catch(() => null),
    api.fundingHistory(address, 20).catch(() => null),
  ]);
  let best: number | null = null;
  const take = (rows: unknown[] | undefined, keys: string[]) => {
    for (const row of rows ?? []) {
      const t = stamp(row, keys);
      if (t !== null) best = best === null ? t : Math.max(best, t);
    }
  };
  take(perps?.trades, ['time', 'T', 'createdAt', 'updatedAt']);
  take(spot?.trades, ['time', 'T', 'createdAt', 'updatedAt']);
  take(funding?.funding, ['timestamp', 'time', 'createdAt']);
  return best;
}

/** Portfolio account fetch. Used only when `/api/vs/trader` for SoDEX failed. */
async function sodexAccountCard(address: string, now: number): Promise<VenueCard> {
  const reads = await Promise.all([
    api.state('perps', address).then((body) => ({ ok: true as const, body }), (e: unknown) => ({ ok: false as const, e })),
    api.state('spot', address).then((body) => ({ ok: true as const, body }), (e: unknown) => ({ ok: false as const, e })),
    api.positions(address).then((body) => ({ ok: true as const, body }), (e: unknown) => ({ ok: false as const, e })),
  ]);
  const failures = reads.filter((r) => !r.ok);
  if (reads.every((r) => !r.ok)) {
    return failures.every((f) => isNotFound(f.e)) ? absent('sodex') : unknownCard('sodex');
  }
  const perps = reads[0].ok ? reads[0].body : null;
  const spot = reads[1].ok ? reads[1].body : null;
  const positions = reads[2].ok ? reads[2].body : null;
  const nPos = openPositionCount(positions);
  const exists = accountBodyExists(perps) || accountBodyExists(spot) || nPos > 0;
  if (!exists) {
    const missed = failures.some((f) => !isNotFound(f.e));
    return missed ? unknownCard('sodex') : absent('sodex');
  }
  const equity = numOrNull((perps as { state?: { av?: unknown } } | null)?.state?.av);
  let lastActive: number | null = null;
  try {
    lastActive = await sodexLastActive(address);
  } catch {
    /* equity still counts; last active stays a dash */
  }
  const recent = lastActive !== null && now - lastActive <= RECENT_MS;
  const hasEquity = equity !== null && equity > 0;
  return {
    venue: 'sodex',
    exists: true,
    unknown: false,
    inactive: !hasEquity && !recent && nPos === 0,
    equity,
    lastActive,
    curve: null,
  };
}

async function readSodex(address: string, signal: AbortSignal | undefined, now: number): Promise<VenueCard> {
  try {
    const profile = await vsApi.trader('sodex', address, signal);
    return cardFromProfile('sodex', profile, now);
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw e;
    if (isNotFound(e)) return absent('sodex');
    return sodexAccountCard(address, now);
  }
}

/** One venue's profile read (every venue but SoDEX, which has its own fallback). */
async function readProfile(venue: Venue, address: string, signal: AbortSignal | undefined, now: number): Promise<VenueCard> {
  try {
    const profile = await vsApi.trader(venue, address, signal);
    return cardFromProfile(venue, profile, now);
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw e;
    if (isNotFound(e)) return absent(venue);
    return unknownCard(venue);
  }
}

export function lookupAddressVenues(address: string, signal?: AbortSignal, now = Date.now()): Promise<VenueCard[]> {
  return Promise.all(SCAN_VENUES.map((v) => readVenue(v, address, signal, now)));
}

/** One venue, on its own. The scan page paints a card as soon as this returns. */
export function readVenue(venue: Venue, address: string, signal?: AbortSignal, now = Date.now()): Promise<VenueCard> {
  return venue === 'sodex' ? readSodex(address, signal, now) : readProfile(venue, address, signal, now);
}

export function useAddressVenues(address: string | null): {
  loading: boolean;
  cards: VenueCard[] | null;
  verdict: AddressVerdict | null;
} {
  const [tick, setTick] = useState<{ address: string; cards: VenueCard[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setTick(null);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    let off = false;
    setLoading(true);
    setTick(null);
    lookupAddressVenues(address, ac.signal)
      .then((cards) => { if (!off) setTick({ address, cards }); })
      .catch((e: unknown) => {
        if (off || isAbort(e)) return;
        setTick({ address, cards: [unknownCard('sodex'), unknownCard('hyperliquid')] });
      })
      .finally(() => { if (!off) setLoading(false); });
    return () => {
      off = true;
      ac.abort();
    };
  }, [address]);

  const cards = tick && address && tick.address === address ? tick.cards : null;
  return {
    loading: !!address && (loading || !cards),
    cards,
    verdict: cards ? verdictOf(cards) : null,
  };
}
