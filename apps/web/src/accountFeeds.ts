/**
 * Shared, refcounted polling for account-scoped REST resources - positions,
 * open orders, account state - the same pattern `useTickers` already proves
 * out for public market data in Market.tsx, generalised to any
 * (resource, engine, address) key.
 *
 * WHY THIS EXISTS. On the trade page, Account.tsx (Positions / OpenOrders /
 * Balances), Chart.tsx (order-line drawing) and OrderEntry.tsx (the
 * Available / current-position readouts) are all mounted at once, and each
 * used to run its OWN independent `useAsync` + `pollMs` against the SAME
 * endpoint - three separate 10s timers hitting `/positions` for one address,
 * for instance, each ALSO independently re-fetching on every WS account
 * event. Under real usage - a real connected wallet, live trading, a
 * WS-triggered extra fetch layered on top of the interval poll for every
 * fill - this was directly implicated in exhausting the shared REST weight
 * budget hard enough to crash the backend (see the `WeightBudget` class in
 * server/src/sodex/rest.ts, and its own comment on what an unbounded wait
 * under sustained contention does). One poll per (resource, engine, address),
 * shared and refcounted, cuts that duplication to a third with no change to
 * what any consumer sees - and a WS-triggered refresh from one consumer now
 * benefits every OTHER subscriber of that same resource too, including ones
 * (OrderEntry) that never subscribed to the WS channel themselves.
 *
 * This module does not parse or reshape any payload - it only shares the
 * FETCH. Every consumer still gets exactly the same response shape `api.*`
 * already returns, so none of the field-level honesty work in Account.tsx
 * (positionDirection, the derived-PnL labelling, etc.) is touched by this.
 */
import { useEffect, useRef, useState } from 'react';

interface FeedState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface Feed<T> extends FeedState<T> {
  subs: Set<(s: FeedState<T>) => void>;
  /** One entry per live subscriber. Pump uses one of these, never a ref a
   *  subscriber later pointed at a different resource (Balances switches
   *  Perps/Spot on one component; a shared ref then fetched the wrong engine
   *  into this key and the other book came back as "couldn't load"). */
  fetchers: Set<() => Promise<T>>;
  fetcher: () => Promise<T>;
  timer?: number;
  inflight?: Promise<void>;
  debounceTimer?: number;
  evictTimer?: number;
}

/**
 * How long an orphaned feed (zero subscribers) is kept before eviction.
 *
 * React 18 StrictMode double-invokes effects on the whole INITIAL tree in
 * dev: mount everything, run every cleanup, mount everything again - all
 * within the same tick or the next one. Three real, independently-lifecycled
 * consumers (Account.tsx, Chart.tsx, OrderEntry.tsx, all mounted on first
 * paint) go through that dance together, and evicting on the very cleanup
 * pass - which is what an immediate `feeds.delete` did - meant the almost-
 * immediate remount found nothing to resubscribe to and paid for a second
 * fetch it did not need. Measured directly: a synthetic 3-subscriber mount
 * produced fetchCount=2, not 1, before this grace period existed.
 * EVICT_GRACE_MS only has to outlast that gap, not a real navigation - 1.5s
 * comfortably does, and a genuinely abandoned key (address disconnected, tab
 * closed) is still reclaimed well within a session.
 */
const EVICT_GRACE_MS = 1500;

const feeds = new Map<string, Feed<any>>();
/**
 * The last answer of every key, kept after its feed is evicted: going back to
 * a tab (or a page) shows what was there at once and only checks for updates,
 * instead of a spinner and a fresh read every time.
 */
const lastData = new Map<string, unknown>();

function notify<T>(feed: Feed<T>): void {
  const snapshot: FeedState<T> = { data: feed.data, error: feed.error, loading: feed.loading };
  for (const s of feed.subs) s(snapshot);
}

function pump<T>(key: string): void {
  const feed = feeds.get(key) as Feed<T> | undefined;
  // Already in flight: the caller that triggered this will see the same
  // answer everyone else does when it lands, rather than paying for a second
  // request that can only resolve microseconds apart from the first.
  if (!feed || feed.inflight) return;
  const run = feed.fetchers && feed.fetchers.size > 0 ? feed.fetchers.values().next().value! : feed.fetcher;
  feed.inflight = run()
    .then((data) => {
      feed.data = data;
      feed.error = null;
      lastData.set(key, data);
    })
    .catch((e) => {
      feed.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      feed.loading = false;
      feed.inflight = undefined;
      notify(feed);
    });
}

/**
 * Subscribe to a shared, polled account resource.
 *
 * `key` fully identifies the resource - callers on the SAME key ride the same
 * poll regardless of what their own `fetcher` closure looks like, so keep it
 * exact: `pos:${address}`, `orders:${engine}:${address}`, and so on. `null`
 * disables the hook (no wallet connected, wrong engine, etc.) the same way
 * `enabled: false` did on the `useAsync` calls this replaces.
 *
 * All subscribers on a key should pass the same `pollMs` - the interval is
 * set once, by whichever subscriber mounts first, and later subscribers'
 * values are not read. This is a shared feed, not a per-consumer one.
 */
export function useAccountResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  pollMs: number,
): FeedState<T> & { refresh: () => void } {
  // Re-read on every render without re-subscribing: the key already captures
  // every param this closure depends on (address, engine, ...), so a fresh
  // fetcher on a stable key is just the latest equivalent function, not a
  // reason to tear down and recreate the shared feed.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const blank = (k: string | null): FeedState<T> => {
    const f = k ? feeds.get(k) : undefined;
    if (f) return { data: f.data, error: f.error, loading: f.loading };
    const kept = k ? (lastData.get(k) as T | undefined) : undefined;
    return kept !== undefined ? { data: kept, error: null, loading: false } : { data: null, error: null, loading: !!k };
  };
  const [state, setState] = useState<FeedState<T>>(() => blank(key));
  // The book (or the wallet) changed. Show that key's own cache on this
  // render — the previous key's error must not sit on the new one until the
  // effect catches up.
  const shownKey = useRef(key);
  if (shownKey.current !== key) {
    shownKey.current = key;
    setState(blank(key));
  }

  useEffect(() => {
    if (!key) return;
    // Snapshot. `fetcherRef` is rewritten every render, including when this
    // component moves to another key; the closure has to keep the function
    // that belonged to THIS subscription.
    const call = fetcherRef.current;
    let feed = feeds.get(key) as Feed<T> | undefined;
    if (!feed) {
      const kept = lastData.get(key) as T | undefined;
      feed = {
        data: kept ?? null, error: null, loading: kept === undefined, subs: new Set(),
        fetchers: new Set(), fetcher: () => call(),
      };
      feeds.set(key, feed);
    }
    if (!feed.fetchers) feed.fetchers = new Set();
    feed.fetchers.add(call);
    // A pending eviction means the feed is between "last subscriber left" and
    // "actually cleared" - a new subscriber arriving in that window (the
    // StrictMode remount case, or any ordinary quick remount) reclaims the
    // still-live feed and its cached data instead of racing a teardown.
    if (feed.evictTimer) {
      clearTimeout(feed.evictTimer);
      feed.evictTimer = undefined;
    }
    const sub = (s: FeedState<T>) => setState(s);
    feed.subs.add(sub);
    setState({ data: feed.data, error: feed.error, loading: feed.loading });

    // First subscriber owns the timer; the rest ride along - identical
    // contract to useTickers in Market.tsx.
    if (!feed.timer) {
      pump<T>(key);
      feed.timer = window.setInterval(() => pump<T>(key), pollMs);
    }

    return () => {
      const f = feeds.get(key);
      if (!f) return;
      f.subs.delete(sub);
      f.fetchers?.delete(call);
      if (f.subs.size === 0) {
        // Stop polling immediately - nothing is reading this, so there is no
        // reason to keep spending REST weight on it. Only the CACHE entry
        // itself gets a grace period before it is discarded (below).
        if (f.timer) {
          clearInterval(f.timer);
          f.timer = undefined;
        }
        if (f.debounceTimer) {
          clearTimeout(f.debounceTimer);
          f.debounceTimer = undefined;
        }
        // The key already embeds the address (`state:perps:0xABC...`), so a
        // switched wallet is a DIFFERENT key and a fresh, empty feed - an
        // orphaned entry sitting here briefly can never be shown as if it
        // belonged to a different address. What it protects against instead
        // is StrictMode's mount -> cleanup -> remount dance on the initial
        // tree: an immediate delete here meant the near-instant remount found
        // nothing to resubscribe to and paid for a wholly avoidable second
        // fetch (measured: a synthetic 3-subscriber mount produced
        // fetchCount=2, not 1, before this grace period existed).
        f.evictTimer = window.setTimeout(() => {
          const cur = feeds.get(key);
          if (cur === f && cur.subs.size === 0) feeds.delete(key);
        }, EVICT_GRACE_MS);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);

  return { ...state, refresh: () => key && pump(key) };
}

/**
 * Debounced external refresh - the WS side of this module. A burst of
 * account events (several fills in quick succession) collapses into ONE
 * re-poll instead of one REST call per event, which is exactly the pattern
 * that stacked up requests faster than they could resolve in the crash log
 * this module exists to fix. A no-op if nothing is currently subscribed to
 * `key` - there is nothing to refresh for a resource nobody is looking at.
 */
export function bumpAccountResource(key: string | null, debounceMs = 400): void {
  if (!key) return;
  const feed = feeds.get(key);
  // subs.size, not just existence: a feed can outlive its last subscriber for
  // a short EVICT_GRACE_MS window (see below) so a StrictMode remount can
  // reclaim it instead of paying for a duplicate fetch. A WS event landing in
  // exactly that window has no live subscriber to answer either - without
  // this check it would still fetch, for a cache entry about to be discarded
  // and nobody reading it. Caught by this module's own dedup test: the
  // "bump after unmount" case fetched anyway until this line existed.
  if (!feed || feed.subs.size === 0) return;
  if (feed.debounceTimer) clearTimeout(feed.debounceTimer);
  feed.debounceTimer = window.setTimeout(() => {
    feed.debounceTimer = undefined;
    pump(key);
  }, debounceMs);
}
