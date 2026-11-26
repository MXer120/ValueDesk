/**
 * The new Scan versions' state: which wallet, which venue, and what each venue says about it.
 *
 * THE SAME LINKS AS THE ORIGINAL PAGE. `?address=X` is SoDEX (the canonical link every page already makes),
 * `?address=X&venue=v` is venue v, and `?find=X` is "this wallet, wherever it is": the lookup runs on every venue
 * and, once all of them answered, the largest active account opens (bestVenue) and the URL becomes its link. A search
 * typed on the page is a `?find=`.
 *
 * THE SAME READS. One profile per venue (useVsTrader, shared with every other reader through useVs's cache and
 * vsApi's sharedRead), the selected venue's polled every 30 s, its fills for every venue but SoDEX, and for SoDEX the
 * portfolio's own context (only while SoDEX is open, as on the original page), whose band shows the SoDEX account.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SCAN_VENUES, type TraderProfile, type Venue, type Window } from '../../../vsApi';
import { resolveTarget } from '../../../dashboard/scanAliases';
import { useStored } from '../../../hooks';
import { usePortfolioContext, type PortfolioContext, type PortfolioProps } from '../../Portfolio';
import { absent, cardFromProfile, unknownCard, type VenueCard } from '../addressVenues';
import { analyticsSuspectNote, chartValueIsPnl } from '../hlModel';
import type { HlState } from '../HlCards';
import { useVsFills, useVsTrader, type VsRead } from '../useVs';
import { bestVenue } from './model';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface UrlState {
  address: string | null;
  /** Null while a `?find=` waits for the venues to answer. */
  venue: Venue | null;
}

function readUrl(): UrlState {
  const q = new URLSearchParams(window.location.search);
  const a = q.get('address');
  const v = q.get('venue')?.toLowerCase() ?? '';
  const named = (SCAN_VENUES as readonly string[]).includes(v) ? (v as Venue) : null;
  if (a && ADDRESS_RE.test(a)) return { address: a, venue: named ?? 'sodex' };
  const f = q.get('find');
  const found = f ? resolveTarget(f) : null;
  if (found) return { address: found, venue: null };
  return { address: null, venue: null };
}

export function scanUrl(address: string | null, venue: Venue | null): string {
  const q = new URLSearchParams();
  if (address && venue) {
    q.set('address', address);
    if (venue !== 'sodex') q.set('venue', venue);
  } else if (address) q.set('find', address);
  const s = q.toString();
  return s ? `/scan?${s}` : '/scan';
}

/** A venue's lookup card from its profile read: pending until it answers, "couldn't check" on a failure. */
function cardOf(venue: Venue, r: VsRead<TraderProfile | null>): VenueCard {
  if (!r.settled) return { ...absent(venue), pending: true };
  if (r.error) return unknownCard(venue);
  return cardFromProfile(venue, r.data);
}

export interface ScanFlow {
  address: string | null;
  /** The venue on screen. Null while the lookup decides, or when the wallet has no account anywhere. */
  venue: Venue | null;
  /** Every venue's card, in SCAN_VENUES order. */
  cards: VenueCard[];
  /** Every venue's profile read, for the views that show all of them. */
  profiles: Record<Venue, VsRead<TraderProfile | null>>;
  /** Every venue has answered. */
  settled: boolean;
  error: string | null;
  search: (input: string) => void;
  pick: (v: Venue) => void;
  clear: () => void;
}

export function useScanFlow(): ScanFlow {
  const [url, setUrl] = useState<UrlState>(readUrl);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const pop = () => {
      setUrl(readUrl());
      setError(null);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  const a = url.address;
  // Fixed order, one hook per venue (SCAN_VENUES): the same five reads the original header makes.
  const sodex = useVsTrader('sodex', a);
  const hyperliquid = useVsTrader('hyperliquid', a);
  const tradexyz = useVsTrader('tradexyz', a);
  const lighter = useVsTrader('lighter', a);
  const arcus = useVsTrader('arcus', a);
  const profiles = useMemo(
    () => ({ sodex, hyperliquid, tradexyz, lighter, arcus }),
    [sodex, hyperliquid, tradexyz, lighter, arcus],
  );
  const cards = useMemo(() => SCAN_VENUES.map((v) => cardOf(v, profiles[v])), [profiles]);
  const settled = cards.every((c) => !c.pending);
  const best = bestVenue(cards);

  /* A `?find=`: once every venue answered, the best account opens and the link becomes its own. */
  useEffect(() => {
    if (!a || url.venue || !best) return;
    window.history.replaceState(null, '', scanUrl(a, best));
    setUrl({ address: a, venue: best });
  }, [a, url.venue, best]);

  const search = useCallback((input: string) => {
    const t = input.trim();
    if (!t) {
      setError(null);
      window.history.pushState(null, '', '/scan');
      setUrl({ address: null, venue: null });
      return;
    }
    const addr = resolveTarget(t);
    if (!addr) {
      setError('Not an address or a saved alias. Paste a 0x… address.');
      return;
    }
    setError(null);
    window.history.pushState(null, '', scanUrl(addr, null));
    setUrl({ address: addr, venue: null });
  }, []);

  const urlRef = useRef(url);
  urlRef.current = url;
  const pick = useCallback((v: Venue) => {
    const cur = urlRef.current;
    if (!cur.address || cur.venue === v) return;
    window.history.pushState(null, '', scanUrl(cur.address, v));
    setUrl({ address: cur.address, venue: v });
  }, []);

  const clear = useCallback(() => {
    setError(null);
    window.history.pushState(null, '', '/scan');
    setUrl({ address: null, venue: null });
  }, []);

  return { address: a, venue: url.venue, cards, profiles, settled, error, search, pick, clear };
}

/* ---------------------------------------------------------------------------
 * THE VENUE ON SCREEN
 * ------------------------------------------------------------------------ */

export interface VenueView {
  venue: Venue | null;
  address: string | null;
  /** The venue's profile, polled every 30 s. */
  trader: VsRead<TraderProfile | null>;
  /** What the Hyperliquid cards and VenueBand read (every venue but SoDEX draws its band with them). */
  hl: HlState;
  /** The SoDEX account as the portfolio reads it, for its band. Address null unless SoDEX is open. */
  sodex: PortfolioContext;
  /** SoDEX's history for this account is unusable: its curves and window PnL give way to this sentence. */
  historyNote: string | null;
  win: Window;
  setWin: (w: Window) => void;
}

const TRADER_POLL_MS = 30_000;
const FILL_LIMIT = 200;

export type ScanPageProps = Omit<PortfolioProps, 'address'> & { address: string | null };

export function useVenueView(props: ScanPageProps, address: string | null, venue: Venue | null): VenueView {
  const v = venue ?? 'sodex';
  const trader = useVsTrader(v, venue ? address : null, TRADER_POLL_MS);
  // SoDEX's fills come with its band (the portfolio's own reads): no second read of them here.
  const fills = useVsFills(v, venue && venue !== 'sodex' ? address : null, FILL_LIMIT);
  const [win, setWin] = useStored<Window>('vs.scanx.window', '30d');
  const [valueWin, setValueWin] = useStored<Window>('vs.scanx.valuewindow', '30d');
  const base = usePortfolioContext({ ...props, address: venue === 'sodex' ? address : null, unlocked: false });
  const sodex = { ...base, readOnly: true } as PortfolioContext;
  // Until the profile answers, the same first check the original page makes on the chart it already holds.
  const flag = venue === 'sodex' ? (trader.data ? trader.data.analyticsSuspect ?? null : chartValueIsPnl(base.venue.points)) : null;
  const historyNote = analyticsSuspectNote(flag);
  const hl: HlState = { venue: v, address: venue ? address : null, trader, fills, win, setWin, valueWin, setValueWin };
  return { venue, address, trader, hl, sodex, historyNote, win, setWin };
}
