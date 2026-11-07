/**
 * A trader's fills: from the ValueDesk index where it holds them, the rest from
 * the venue in this browser, exactly as before.
 *
 * The Copy page's replay and Scan's cards asked the venue for up to 5,000 fills
 * per trader (exchange/venues.ts) - minutes on SoDEX, which serves a couple of
 * trade pages a minute per IP. The indexer holds the fills of every wallet it
 * tracks; GET /api/vs/wallet/fills (server
 * indexer/walletFills.ts) answers them when its held span covers the window:
 *
 *   covered: false, an error, an older server (404)  ->  the venue's own read, unchanged
 *   covered, heldTo at the window's end              ->  the index's fills alone
 *   covered, heldTo earlier                          ->  the venue's fills after heldTo
 *                                                        (one short read), then the index's
 *
 * Same answer either way: the newest `limit` fills in [from, to], newest first.
 */
import type { Venue, VsFill } from '@sign/valuedesk/types.js';

/** A held span ending this close to the window's end is taken as reaching it: the indexer moves it up every 30 s. */
export const TAIL_SLACK_MS = 90_000;
/** venues.fills's default. */
const DEFAULT_LIMIT = 2_000;
export const FROM_STEP_MS = 60_000;

export interface IndexFillsAnswer {
  ok?: boolean;
  covered?: boolean;
  heldTo?: number;
  fills?: VsFill[];
}

export interface FillsQuery {
  from?: number;
  to?: number;
  limit?: number;
}

export function indexFillsPath(venue: Venue, address: string, o: FillsQuery): string {
  // The address in the query: the server's log keeps the path only.
  const p = new URLSearchParams({ venue, address: address.toLowerCase() });
  // `from` to the minute: the same request from every visitor in that minute, so the edge cache (max-age 60) answers it.
  // Up to a minute of older fills comes with it, which the replay takes as warm-up before its window.
  if (o.from !== undefined) p.set('from', String(Math.floor(o.from / FROM_STEP_MS) * FROM_STEP_MS));
  if (o.to !== undefined) p.set('to', String(Math.trunc(o.to)));
  p.set('limit', String(o.limit ?? DEFAULT_LIMIT));
  return `/api/vs/wallet/fills?${p.toString()}`;
}

const newestFirst = (a: VsFill, b: VsFill): number => b.time - a.time;

/** The venues the route answers (server indexer/walletFills.ts FILL_KINDS); the others go straight to the venue. */
export const INDEX_FILL_VENUES: ReadonlySet<Venue> = new Set<Venue>(['sodex', 'hyperliquid']);

/**
 * `index`: the route's answer, or null when there is none (it resolves, never throws, for a
 * failure). `direct`: the venue's own read, as vsApi called it before. `name`: what the venue
 * read does to its fills after reading (Hyperliquid's spot names), applied to the index's.
 */
export async function fillsWithIndex(
  venue: Venue,
  address: string,
  o: FillsQuery,
  io: {
    index: (path: string) => Promise<IndexFillsAnswer | null>;
    direct: (o: FillsQuery) => Promise<VsFill[]>;
    name?: (fills: VsFill[]) => Promise<VsFill[]>;
    now?: () => number;
  },
): Promise<VsFill[]> {
  if (!INDEX_FILL_VENUES.has(venue)) return io.direct(o);
  const limit = o.limit ?? DEFAULT_LIMIT;
  const got = await io.index(indexFillsPath(venue, address, { ...o, limit })).catch(() => null);
  const heldTo = got?.heldTo;
  if (!got || got.ok !== true || got.covered !== true || !Array.isArray(got.fills) || typeof heldTo !== 'number' || !Number.isFinite(heldTo)) {
    return io.direct(o);
  }
  const held = io.name ? await io.name(got.fills) : got.fills;
  const end = o.to ?? (io.now ?? Date.now)();
  if (heldTo >= end - TAIL_SLACK_MS) return held;
  // The tail the index has not caught up with: from the venue, then the index's below it.
  const tail = (await io.direct({ ...o, from: Math.max(o.from ?? 0, heldTo + 1), limit })).filter((f) => f.time > heldTo);
  return [...tail.sort(newestFirst), ...held.filter((f) => f.time <= heldTo)].slice(0, limit);
}
