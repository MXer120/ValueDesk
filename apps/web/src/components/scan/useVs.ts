/**
 * Reading one address's profile and fills on one venue - straight from the
 * venue, in this browser (vsApi -> exchange/venues.ts).
 *
 * WHY NOT `useAsync`. Its error state is a string, and the multi-venue API has
 * two very different failures behind one HTTP 200: `not_available` (the venue's
 * provider has not been built yet, or this venue cannot serve the feature) and
 * everything else (the venue is down). The first is a calm "not available yet"
 * in the panel; the second is a red error. Collapsing both into `String(e)`
 * would print "Error: hyperliquid trader not implemented yet" in red on a page
 * that is working as designed, so this hook keeps the VsError code.
 *
 * ONE REQUEST PER ADDRESS, NOT ONE PER PANEL. The venue switch in the Scan
 * header asks both venues whether this address has traded there, and the
 * Hyperliquid view then needs the same profile. A short-lived module cache
 * lets both read one response instead of each paying the venue's rate budget.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { vsApi, VsError, type TraderProfile, type Venue, type VsFill } from '../../vsApi';
import { hasActivity } from './hlModel';
import { logLoadFailure } from '../LoadFailed';
import { pollEvery, visibleTimeout } from '../../exchange/visibility';

export interface VsRead<T> {
  data: T | null;
  loading: boolean;
  /** Set for every failure, including `unavailable`. */
  error: string | null;
  /** The venue answered `not_available`: a feature that is not served yet, not an outage. */
  unavailable: boolean;
  /** True once a response (or a failure) has arrived for the current address. */
  settled: boolean;
  refresh: () => void;
}

const TTL_MS = 20_000;
const RETRY_MS = 15_000;
const cache = new Map<string, { at: number; p: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>, fresh: boolean): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.p as Promise<T>;
  const p = load();
  cache.set(key, { at: Date.now(), p });
  // A failure is not worth remembering: the next caller should try again.
  p.catch(() => { if (cache.get(key)?.p === p) cache.delete(key); });
  return p;
}

export function useVsRead<T>(
  key: string | null,
  load: () => Promise<T>,
  pollMs?: number,
): VsRead<T> {
  const [state, setState] = useState<Omit<VsRead<T>, 'refresh'>>({
    data: null, loading: false, error: null, unavailable: false, settled: false,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!key) {
      lastKey.current = null;
      setState({ data: null, loading: false, error: null, unavailable: false, settled: false });
      return;
    }
    const sameKey = lastKey.current === key;
    lastKey.current = key;
    let off = false;
    // A new address clears the old one's numbers at once; a refresh of the
    // same address keeps them on screen until the new response lands.
    setState((s) => (sameKey
      ? { ...s, loading: true }
      : { data: null, loading: true, error: null, unavailable: false, settled: false }));
    cached(key, () => loadRef.current(), tick > 0 && sameKey)
      .then((data) => {
        if (!off) setState({ data: data as T, loading: false, error: null, unavailable: false, settled: true });
      })
      .catch((e: unknown) => {
        if (off) return;
        const unavailable = e instanceof VsError && e.code === 'not_available';
        // Kept for the console only: panels say "<What> couldn't load." (LoadFailed.tsx).
        if (!unavailable) logLoadFailure(`Venue data (${key})`, e);
        const error = e instanceof Error ? e.message : String(e);
        setState((s) => ({ data: sameKey ? s.data : null, loading: false, error, unavailable, settled: true }));
      });
    return () => { off = true; };
  }, [key, tick]);

  useEffect(() => {
    if (!key || !pollMs) return;
    return pollEvery(pollMs, () => setTick((t) => t + 1));
  }, [key, pollMs]);

  /* An outage is retried on its own, once per RETRY_MS, so a backend restart
     does not leave a red line in the card until the page is reloaded. A
     `not_available` answer is not retried: it will not change within minutes. */
  const failed = !!key && !!state.error && !state.unavailable && !state.loading;
  useEffect(() => {
    if (!failed) return;
    return visibleTimeout(RETRY_MS, () => setTick((t) => t + 1));
    // `state`, not just the message: a retry that fails with the SAME message
    // still has to schedule the next one.
  }, [failed, state]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}

/** The venue's profile of one address. `data === null` after settling = no such trader. */
export function useVsTrader(venue: Venue, address: string | null, pollMs?: number): VsRead<TraderProfile | null> {
  const a = address?.toLowerCase() ?? null;
  return useVsRead(a ? `trader:${venue}:${a}` : null, () => vsApi.trader(venue, a!), pollMs);
}

/** The most recent fills, newest first. */
export function useVsFills(venue: Venue, address: string | null, limit = 200): VsRead<VsFill[]> {
  const a = address?.toLowerCase() ?? null;
  return useVsRead(a ? `fills:${venue}:${a}:${limit}` : null, () => vsApi.fills(venue, a!, { limit }));
}

/**
 * Has this address traded on the venue?
 *
 *   active   - the venue returned a profile with any real activity in it
 *   inactive - there is an account, but no equity and nothing in 30 days
 *   none     - the venue answered, and there is no account
 *   unknown  - the venue could not say (not available yet, or down)
 *   loading  - asking
 */
export type Presence = 'active' | 'inactive' | 'none' | 'unknown' | 'loading';

export function presenceOf(r: VsRead<TraderProfile | null>): Presence {
  if (r.loading && !r.settled) return 'loading';
  if (r.error) return 'unknown';
  if (!r.settled) return 'loading';
  return hasActivity(r.data) ? 'active' : 'none';
}
