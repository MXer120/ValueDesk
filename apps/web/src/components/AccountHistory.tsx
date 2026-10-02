/**
 * The account's history tables, its ledger of money in and out, and every
 * balance it has in one place.
 *
 * Where each reads from, and why, is in accountData.ts. What is here is
 * presentation plus the paging state:
 *
 *   HistoryTable   order history, trade (fill) history, funding payments and
 *                  closed positions - paged by `endTime` with "Load more".
 *                  Closed positions draw as the reference's cards (image 15) or
 *                  as a slim table (the band's card / list switch).
 *   AccountLedger  deposits, withdrawals (with their status and payout tx) and
 *                  ValueChain transfers, on one timeline.
 *   AllBalances    Spot, Perps and the EVM (ValueChain) wallet together.
 *
 * The band's filters (accountTables/filters.ts) are applied to the rows held
 * here. The only fetch a filter causes is the capped auto "load more" toward a
 * timeframe start older than what is loaded (AUTO_PAGES).
 *
 * Same rules as Account.tsx: an absent value is an em-dash, never a 0, and a
 * failed read is ONLY "<What> couldn't load." with a Retry.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, type Engine, type Symbol as MarketSymbol } from '../api';
import { bumpAccountResource, useAccountResource } from '../accountFeeds';
import {
  HISTORY, HISTORY_PAGE, countNew, fetchAccountFlows, fetchFundTransfers, fetchHistoryPage, ledgerAvailable, mergeRows,
  timeline, txUrl, type HistoryKind, type HistoryPage, type LedgerRow, type TokenBook,
} from '../accountData';
import { DASH, coinLabel, fmt, fmtBalance, fmtDateTime, fmtPrice, fmtQty, fmtUsd, num, pick } from '../format';
import { LAG_MS, accountActivity } from '../exchange/accountActivity';
import { isAbort } from '../exchange/errors';
import { network } from '../exchange/hosts';
import { holdsAll, newWants, notePush, tableStore, trimForStore, type StreamWants } from '../exchange/historyTables';
import { CrossFade } from './motion';
import { useAsync, useChannel, useSharedStored } from '../hooks';
import { useMask } from '../privacy';
import { cachedAssetConfigs, canDepositCoin, canWithdrawCoin, chainLabel, transferProblem, type CoinConfig } from '../trading/funds';
import { coinPrices, priceOf } from '../trading/prices';
import { refreshWallet, subscribeWallet, walletRead } from '../trading/walletBalances';
import { CoinIcon, CoinLabel } from './CoinIcon';
import { SodexMark } from './funds/ui';
import { requestDeposit, requestTransfer, requestWithdraw } from './account/actions';
import { SortTh, sortRows, useTableSort } from './accountTables/sort';
import { LoadFailed, logLoadFailure } from './LoadFailed';
import {
  DEFAULT_FILTER, TAB_CAPS, applyFilter, directionOfPosition, directionOfSide, marginOf, sourceOf, timeWindow, windowKey,
  type BandTab, type RowFacts, type TableFilter,
} from './accountTables/filters';
import {
  FilteredEmpty, FilteredHint, LoadMore, MarketCell, Note, Pill, SidePill, SourcePill, StatusCell, Unit, amount, orderTypeText, signedPct, signedUsd, tifText, toneOf,
} from './accountTables/cells';
import { StatusIcon } from './accountTables/StatusIcon';
import type { BandMeta } from './accountTables/FilterBar';
import type { StatusKind, StatusTone } from './accountTables/orderStatus';

const dashed = (s: string): string => (s === '-' ? DASH : s);
/*
 * A quantity or price to the market's own step/tick - or, when the market list
 * has not loaded, to as many places as the value has (up to 8).
 */
const qty = (v: unknown, step?: string): string =>
  dashed(step ? fmtQty(v as string | number | undefined, step) : fmt(v as string | number | undefined));
const price = (v: unknown, tick?: string): string =>
  dashed(tick ? fmtPrice(v as string | number | undefined, tick) : fmt(v as string | number | undefined));
const when = (v: unknown): string => dashed(fmtDateTime(num(v) || undefined));

/** How many pages a timeframe may pull on its own before it asks for a click. */
export const AUTO_PAGES = 5;

/**
 * LoadFailed, plus the console line. Logged once per distinct failure, not on
 * every render, so ?debug=load reads as a list of what failed.
 */
export function ReadFailed({ what, error, onRetry }: { what: string; error: unknown; onRetry?: () => void }) {
  const detail = error instanceof Error ? error.message : String(error);
  useEffect(() => { logLoadFailure(what, error); }, [what, detail]); // eslint-disable-line react-hooks/exhaustive-deps
  return <LoadFailed what={what} onRetry={onRetry} className="acct-failed" />;
}

/** Spot / Perps, for the tables whose rows exist on both engines. */
export function EngineSwitch({ value, onChange }: { value: Engine; onChange: (e: Engine) => void }) {
  return (
    <div className="acct-switch" role="group" aria-label="Engine">
      {(['spot', 'perps'] as const).map((e) => (
        <button key={e} type="button" className={value === e ? 'active' : ''} aria-pressed={value === e} onClick={() => onChange(e)}>
          {e === 'spot' ? 'Spot' : 'Futures'}
        </button>
      ))}
    </div>
  );
}

/**
 * At most one call per `ms`, on the trailing edge, for account-stream pushes.
 * A throttle and not a debounce: a busy account fills without pause.
 */
function useThrottled(fn: () => void, ms: number): () => void {
  const timer = useRef<number>();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      ref.current();
    }, ms);
  }, [ms]);
}

/** Tells the band's filter bar what this table holds - only when it changes. */
function useReportMeta(onMeta: ((m: BandMeta) => void) | undefined, oldest: number | null, staleAt: number | null, more: boolean) {
  useEffect(() => { onMeta?.({ oldest, staleAt, more }); }, [onMeta, oldest, staleAt, more]);
}

const oldestOf = <T,>(rows: T[], timeOf: (r: T) => number): number | null => {
  let min = Infinity;
  for (const r of rows) {
    const t = timeOf(r);
    if (Number.isFinite(t) && t > 0 && t < min) min = t;
  }
  return Number.isFinite(min) ? min : null;
};

/**
 * Pull pages on its own until the chosen timeframe start is covered - at most
 * AUTO_PAGES per start the reader picks, so a "90D" on a busy account cannot
 * become a request storm against SoDEX's rate limit.
 */
function useAutoLoad(
  filter: TableFilter, enabled: boolean, oldest: number | null,
  state: { busy: boolean; failed: boolean; hasMore: boolean }, more: () => void,
): { from: number | null; short: boolean } {
  const { from } = timeWindow(filter, Date.now());
  const key = windowKey(filter);
  const auto = useRef({ key: '', pages: 0 });
  useEffect(() => {
    if (!enabled || from === null) return;
    if (auto.current.key !== key) auto.current = { key, pages: 0 };
    if (state.busy || state.failed || !state.hasMore) return;
    if (oldest !== null && oldest <= from) return;
    if (auto.current.pages >= AUTO_PAGES) return;
    auto.current.pages++;
    more();
  }); // runs after every render: the guards above are the dependency list
  return { from, short: enabled && from !== null && state.hasMore && (oldest === null || oldest > from) };
}

const dateOnly = (ms: number) => new Date(ms).toLocaleDateString();

/* ===========================================================================
 *  PAGED GATEWAY HISTORY
 * ======================================================================== */

interface Paged {
  key: string | null;
  rows: any[];
  next: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  moreError: unknown;
  /**
   * Set while what is on screen is older than what SoDEX would answer now (ms
   * read): SoDEX refused, or the copy is still waiting for its turn to be
   * caught up (SoDEX allows two history reads a minute).
   */
  staleAt: number | null;
  /** When SoDEX answered for the newest rows on screen (ms; 0 = never). */
  fetchedAt: number;
  /**
   * When SoDEX was asked for them (ms; 0 = not known). The copy is current
   * for as long as nothing has happened on the account since.
   */
  askedAt: number;
}

const IDLE: Paged = { key: null, rows: [], next: null, loading: false, loadingMore: false, error: null, moreError: null, staleAt: null, fetchedAt: 0, askedAt: 0 };

/**
 * What each history held when its tab was last on screen (rows, the pages
 * already loaded, the cursor). Switching back shows it at once. Between visits
 * the same lives in IndexedDB (exchange/historyTables.ts). The PAGED_KEEP most
 * recently shown tables stay here; an older one opens from IndexedDB.
 */
const pagedCache = new Map<string, Paged>();
const PAGED_KEEP = 24;

/**
 * SoDEX allows two reads a minute of `/trades` and `/orders/history` per IP
 * (exchange/sodexGateway.ts), so a table spends none it does not need:
 *  - a copy read less than FRESH_MS ago, with nothing heard on the account's
 *    stream since it was asked for (exchange/accountActivity.ts), is shown as
 *    it is - a tab switch or a quick reload with no trading in between;
 *  - any other copy is shown at once and ONE read catches it up - for fills
 *    only the ones newer than the newest held (a fill never changes); orders
 *    do change (one that closes late), so their newest page is read again;
 *  - a push on the account stream is a reason to read only if the table
 *    lacks what it reports: a fill it already holds, an order that is still
 *    open (not in the order history at all) or a final state it already
 *    shows need none;
 *  - after the user's own action (the app's refresh) the stream is heard
 *    first, for half a second: a push the table lacks reads at once, a
 *    stream that reported nothing it lacks needs no read, a stream that
 *    says nothing reads as before;
 *  - a trigger (a fill on the stream, a refresh) that arrives while a read
 *    still waits for its slot is served by that read; one that arrives after
 *    it was sent gets one more read after it;
 *  - the table on screen reads first ('visible'); background readers wait
 *    behind it (exchange/historyQueue.ts).
 * The usual stale note says how old the rows are when the catch-up does not
 * land within STALE_GRACE_MS, or at once when the kept copy is older than
 * SHOW_AGE_MS.
 */
const FRESH_MS = 30_000;
const STALE_GRACE_MS = 3_000;
const SHOW_AGE_MS = 5 * 60_000;

/** The account channels whose pushes change each history (funding is paid on a schedule, not pushed). */
const CHANGED_BY: Record<HistoryKind, readonly string[]> = {
  trades: ['accountTrade'],
  orders: ['accountOrderUpdate', 'accountTrade'],
  positions: ['accountTrade'],
  funding: [],
};

function newestTime(rows: any[], timeOf: (r: any) => number): number | undefined {
  let max = -Infinity;
  for (const r of rows) {
    const t = timeOf(r);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return Number.isFinite(max) && max > 0 ? max : undefined;
}

/** Orders and fills: the two histories SoDEX rate-limits (exchange/sodexGateway.ts HISTORY_DRIP). */
const DRIPPED: ReadonlySet<HistoryKind> = new Set<HistoryKind>(['trades', 'orders']);
/** After the user's own action: how long the stream is heard before the table reads anyway. */
const REFRESH_WAIT_MS = 500;
/** A push this long before the action's refresh still belongs to it (the stream can be faster than the answer). */
const REFRESH_HEARD_MS = 2_000;
/** For this long after an action, a push the table lacks reads at once instead of 5 s later. */
const REFRESH_URGENT_MS = 5_000;

/**
 * Keep a table for its next visit: in memory for this session and, once SoDEX
 * has answered for it, in IndexedDB between visits (`storeKey`).
 */
function keepTable(key: string, storeKey: string | null, s: Paged, timeOf: (r: any) => number): void {
  if (s.rows.length === 0 || s.error) return;
  pagedCache.delete(key);
  pagedCache.set(key, { ...s, loading: false, loadingMore: false, moreError: null });
  for (const oldest of pagedCache.keys()) {
    if (pagedCache.size <= PAGED_KEEP) break;
    pagedCache.delete(oldest);
  }
  if (storeKey && s.fetchedAt > 0) tableStore.put(storeKey, trimForStore(s, timeOf));
}

/**
 * One gateway history, newest first, with "load more".
 *
 * A refresh reads the newest rows and merges them in, so older pages already
 * loaded stay put - unless every row read is new and the page was full, in
 * which case there may be a gap and the list starts over from it.
 *
 * A table that leaves the screen (another tab, engine or wallet) gives up its
 * place in the queue for a history slot - the next slot is for what is shown -
 * and an answer that arrives after it left is still kept for its next visit.
 */
function usePagedHistory(kind: HistoryKind, engine: Engine, address: string | null, refreshToken: number) {
  const spec = HISTORY[kind];
  const eng: Engine = spec.perpsOnly ? 'perps' : engine;
  const key = address ? `${kind}:${eng}:${address}` : null;
  const storeKey = address ? `${network()}:${kind}:${eng}:${address.toLowerCase()}` : null;
  const [s, setS] = useState<Paged>(() => (key && pagedCache.get(key)) || IDLE);
  const cur = useRef(s);
  cur.current = s;
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    if (s.key) keepTable(s.key, s.key === keyRef.current ? storeKey : null, s, spec.timeOf);
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * Ends this table's reads that still wait for a history slot when it leaves
   * the screen. null while no table is mounted here.
   */
  const leave = useRef<AbortController | null>(null);
  /** Nothing can have changed since this copy was asked for: it is shown as it is, without a read. */
  const current = (p: Paged): boolean =>
    !!address && p.askedAt > 0 && Date.now() - p.fetchedAt < FRESH_MS && accountActivity.quietSince(eng, address, CHANGED_BY[kind], p.askedAt);
  const inFlight = useRef<string | null>(null);
  /** The table that was asked for again while it could not be read (one more read follows), and when. */
  const again = useRef<string | null>(null);
  const againAt = useRef(0);
  /** The table whose kept copy is still being read from IndexedDB: SoDEX is not asked before it is known. */
  const hydrating = useRef<string | null>(null);
  /** What the account stream has reported since the table was last checked against it. */
  const wants = useRef<StreamWants>(newWants());
  /** The user's own action the table is still hearing the stream about: when, and the wait. */
  const refreshAt = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);

  const first = useCallback((reset: boolean) => {
    if (!key || !address) return;
    const k = key;
    const sk = storeKey;
    // One read at a time per table, and none before its kept copy is known;
    // whatever asks meanwhile gets one more read after that.
    if (inFlight.current === k || hydrating.current === k) {
      again.current = k;
      againAt.current = Date.now();
      return;
    }
    inFlight.current = k;
    const signal = leave.current?.signal;
    /** When this read left for SoDEX (0: it has not - still waiting for its slot, or never sent). */
    let sentAt = 0;
    /** Still this table, still on screen. */
    const shown = () => keyRef.current === k && leave.current !== null;
    const base = cur.current.key === k ? cur.current : null;
    const since = !reset && kind === 'trades' && base && base.rows.length > 0 ? newestTime(base.rows, spec.timeOf) : undefined;
    setS((p) => (reset || p.key !== k ? { ...IDLE, key: k, loading: true } : { ...p, loading: p.rows.length === 0, error: null }));
    // Rows on screen that are not caught up promptly say how old they are.
    const staleTimer = window.setTimeout(() => {
      setS((p) => (p.key === k && p.rows.length > 0 && p.staleAt === null && p.fetchedAt > 0 ? { ...p, staleAt: p.fetchedAt } : p));
    }, STALE_GRACE_MS);
    /** The table once `page` (its newest rows) is in. */
    const withPage = (p: Paged, page: HistoryPage<any>): Paged => {
      const staleAt = page.staleAt ?? null;
      const fetchedAt = staleAt ?? Date.now();
      // Asked when this read was sent - unless the page is an older copy
      // (SoDEX refused), or came from a request that was not this table's.
      const askedAt = staleAt === null && sentAt > 0 ? sentAt : p.askedAt;
      const gap = p.rows.length > 0 && page.next !== null && countNew(p.rows, page.rows, spec.idOf) === page.rows.length;
      if (p.rows.length === 0 || gap) return { ...p, rows: mergeRows([], page.rows, spec.idOf, spec.timeOf), next: page.next, loading: false, error: null, staleAt, fetchedAt, askedAt };
      return { ...p, rows: mergeRows(p.rows, page.rows, spec.idOf, spec.timeOf), loading: false, error: null, staleAt, fetchedAt: Math.max(p.fetchedAt, fetchedAt), askedAt };
    };
    // Dropped before it was sent: this table left the screen, or another reader of the same page did.
    let dropped = false;
    // `fresh`: never an answer kept from a moment ago - this read is made because something may have changed.
    const read = { priority: 'visible' as const, since, signal, fresh: true, onSent: () => { sentAt = Date.now(); } };
    fetchHistoryPage(kind, eng, address, null, HISTORY_PAGE, read).then(
      (page) => {
        if (shown()) {
          setS((p) => (p.key === k ? withPage(p, page) : p));
          return;
        }
        // SoDEX answered after the table left the screen. The read is paid for
        // (two a minute), so it is kept for the table's next visit.
        keepTable(k, sk, withPage(pagedCache.get(k) ?? base ?? { ...IDLE, key: k }, page), spec.timeOf);
      },
      (e: unknown) => {
        if (isAbort(e)) {
          dropped = true;
          return;
        }
        if (!shown()) return;
        // A background re-read that fails under rows already on screen keeps
        // them, marked with how old they are, and says why only in the console.
        if (!reset && cur.current.key === k && cur.current.rows.length > 0) {
          logLoadFailure(WHAT[kind], e);
          setS((p) => (p.key === k ? { ...p, loading: false, staleAt: p.staleAt ?? (p.fetchedAt > 0 ? p.fetchedAt : null) } : p));
          return;
        }
        setS((p) => (p.key === k ? { ...p, loading: false, error: e } : p));
      },
    ).finally(() => {
      window.clearTimeout(staleTimer);
      if (inFlight.current === k) inFlight.current = null;
      if (!shown()) return;
      // Asked for again while this read was pending: one more read - unless this
      // one left for SoDEX after that (it waited for its slot), so it already
      // holds the answer. Dropped unsent while the table is still shown: again.
      const more = again.current === k && (sentAt === 0 || againAt.current + LAG_MS >= sentAt);
      if (again.current === k) again.current = null;
      if (more || dropped) first(dropped ? reset : false);
    });
  }, [key, address, kind, eng, spec, storeKey]);

  const more = useCallback(() => {
    const p0 = cur.current;
    if (!key || !address || p0.key !== key || p0.next === null || p0.loadingMore) return;
    const k = key;
    const sk = storeKey;
    const cursor = p0.next;
    const shown = () => keyRef.current === k && leave.current !== null;
    setS((p) => ({ ...p, loadingMore: true, moreError: null }));
    /** The table once the next older `page` is in. */
    const withOlder = (p: Paged, page: HistoryPage<any>): Paged => {
      // A page of nothing new means the cursor stopped moving: stop.
      const added = countNew(p.rows, page.rows, spec.idOf);
      return {
        ...p,
        rows: mergeRows(p.rows, page.rows, spec.idOf, spec.timeOf),
        next: added === 0 ? null : page.next,
        loadingMore: false,
        staleAt: page.staleAt ? Math.min(page.staleAt, p.staleAt ?? Infinity) : p.staleAt,
      };
    };
    fetchHistoryPage(kind, eng, address, cursor, HISTORY_PAGE, { priority: 'visible', signal: leave.current?.signal }).then(
      (page) => {
        if (shown()) {
          setS((p) => (p.key === k ? withOlder(p, page) : p));
          return;
        }
        // Answered after the table left the screen: kept, if the table still ends where this page starts.
        const held = pagedCache.get(k);
        if (held && held.next === cursor) keepTable(k, sk, withOlder(held, page), spec.timeOf);
      },
      (e: unknown) => {
        if (!shown()) return;
        // Dropped unsent (another reader of the same page left): "load more" is simply there again.
        setS((p) => (p.key === k ? { ...p, loadingMore: false, moreError: isAbort(e) ? null : e } : p));
      },
    );
  }, [key, address, kind, eng, spec, storeKey]);

  useEffect(() => {
    if (!key) {
      setS(IDLE);
      return;
    }
    const ctl = new AbortController();
    leave.current = ctl;
    wants.current = newWants();
    // An action still being heard is the old table's: this one starts clean.
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = undefined;
    refreshAt.current = 0;
    let dead = false;
    const kept = pagedCache.get(key);
    if (kept) {
      // Shown at once; read again unless nothing can have changed since.
      setS(kept);
      cur.current = kept;
      if (!current(kept)) first(false);
    } else {
      hydrating.current = key;
      setS({ ...IDLE, key, loading: true });
      void (storeKey ? tableStore.get(storeKey) : Promise.resolve(null)).then((stored) => {
        if (dead || keyRef.current !== key) return;
        hydrating.current = null;
        // Asked for meanwhile (a fill on the stream, a refresh): the catch-up below serves it.
        const wanted = again.current === key;
        if (wanted) again.current = null;
        if (!stored || stored.rows.length === 0) {
          first(true);
          return;
        }
        // What this table showed last time, at once; an old copy says so at once.
        const age = Date.now() - stored.fetchedAt;
        const view: Paged = { ...IDLE, key, rows: stored.rows as any[], next: stored.next, fetchedAt: stored.fetchedAt, askedAt: stored.askedAt ?? 0, staleAt: age >= SHOW_AGE_MS ? stored.fetchedAt : null };
        setS(view);
        cur.current = view;
        if (wanted || !current(view)) first(false);
      });
    }
    return () => {
      dead = true;
      if (hydrating.current === key) hydrating.current = null;
      // The table leaves the screen: its reads still waiting for a slot end here.
      if (leave.current === ctl) leave.current = null;
      ctl.abort();
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The table holds everything the stream has reported since it was last checked (and nothing is pending or failed). */
  const holds = (w: StreamWants): boolean => {
    const p = cur.current;
    return !!key && p.key === key && inFlight.current !== key && p.fetchedAt > 0 && p.staleAt === null && !p.error && holdsAll(kind, w, p.rows, spec.idOf);
  };

  // A refresh is a CHANGED token - not the first run, and not React's dev
  // re-run of the effect on mount (which would spend a history read each time).
  // It is the app saying "the account may have changed" after the user's own
  // action. Orders and fills are rate-limited reads, and the account stream
  // says exactly what an action changed - often nothing here: an order that was
  // only placed is in neither history. So the stream is heard first, briefly:
  // a push the table lacks reads at once; a stream that reported nothing the
  // table lacks needs no read; a stream that says nothing reads as before.
  const seenToken = useRef(refreshToken);
  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);
  useEffect(() => {
    if (seenToken.current === refreshToken) return;
    seenToken.current = refreshToken;
    if (!address || !DRIPPED.has(kind) || !accountActivity.isListening(eng, address)) {
      first(false);
      return;
    }
    const at = Date.now();
    refreshAt.current = at;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = undefined;
      if (accountActivity.pushedSince(eng, address, at - REFRESH_HEARD_MS) && holds(wants.current)) return;
      first(false);
    }, REFRESH_WAIT_MS);
  }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fills and order changes arrive on the account stream; history follows them -
  // unless the table already holds what was reported (the read made for the
  // user's own action usually brought it), or the push cannot change this
  // history (an order that is still open is not in the order history). With
  // two history reads a minute, a read that would bring nothing is one the next
  // table has to wait for.
  const onStream = useThrottled(() => {
    const w = wants.current;
    wants.current = newWants();
    if (holds(w)) {
      // Nothing to read - and the table is known to be current as of now.
      if (cur.current.askedAt > 0) setS((q) => (q.key === key ? { ...q, askedAt: Date.now() } : q));
      return;
    }
    first(false);
  }, 5000);
  const onPush = (channel: 'accountTrade' | 'accountOrderUpdate') => (data: unknown) => {
    notePush(wants.current, channel, data);
    // Right after the user's own action a push is its result: if the table
    // lacks it, read at once (the look 5 s later sees whether that read brought it).
    if (Date.now() - refreshAt.current < REFRESH_URGENT_MS && inFlight.current !== key && !holds(wants.current)) {
      refreshAt.current = 0;
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = undefined;
      first(false);
    }
    onStream();
  };
  useChannel(eng, address ? { channel: 'accountTrade', user: address } : null, onPush('accountTrade'));
  useChannel(eng, address && kind === 'orders' ? { channel: 'accountOrderUpdate', user: address } : null, onPush('accountOrderUpdate'));

  const live = s.key === key ? s : { ...IDLE, loading: !!key };
  return { ...live, more, retry: () => first(false) };
}

const WHAT: Record<HistoryKind, string> = {
  orders: 'Order history',
  trades: 'Trade history',
  funding: 'Funding history',
  positions: 'Position history',
};

const EMPTY_TEXT: Record<HistoryKind, string> = {
  orders: 'No orders yet.',
  trades: 'No fills yet.',
  funding: 'No funding payments yet.',
  positions: 'No closed positions yet.',
};

export const BAND_TAB: Record<HistoryKind, BandTab> = {
  orders: 'order-history',
  trades: 'trade-history',
  funding: 'funding-history',
  positions: 'position-history',
};

const MARGIN_WORD = { cross: 'Cross', isolated: 'Isolated' } as const;

/** The row facts the band's filters read, per history. */
function factsOf(kind: HistoryKind, r: any): RowFacts {
  const symbol = pick<string>(r, 'symbol', 's') ?? null;
  switch (kind) {
    case 'orders':
      return { symbol, side: directionOfSide(pick(r, 'side')), source: sourceOf(pick(r, 'clOrdID')), time: num(pick(r, 'createdAt')) || null };
    case 'trades':
      return { symbol, side: directionOfSide(pick(r, 'side')), source: sourceOf(pick(r, 'clOrdID')), time: num(pick(r, 'time')) || null };
    case 'funding':
      return { symbol, side: directionOfPosition(pick(r, 'positionSide')), time: num(pick(r, 'timestamp')) || null };
    default:
      // A closed position belongs to the day it CLOSED.
      return {
        symbol,
        margin: marginOf(pick(r, 'marginMode')),
        side: directionOfPosition(pick(r, 'positionSide')),
        time: num(pick(r, 'updatedAt')) || num(pick(r, 'createdAt')) || null,
      };
  }
}

export interface HistoryTableProps {
  kind: HistoryKind;
  engine: Engine;
  address: string | null;
  byName: Map<string, MarketSymbol>;
  refreshToken: number;
  /** Rows of one market only (the band's "Current market" checkbox). */
  symbolFilter?: string | null;
  /** The band's View filters for this tab. */
  filter?: TableFilter;
  onResetView?: () => void;
  onMeta?: (m: BandMeta) => void;
  /** Rendered at the right of the head row - the Spot/Perps switch on the portfolio. */
  headAction?: ReactNode;
  /** Position history as cards (image 15) rather than a table. */
  cardView?: boolean;
}

export function HistoryTable({
  kind, engine, address, byName, refreshToken, symbolFilter, filter = DEFAULT_FILTER, onResetView, onMeta, headAction, cardView = false,
}: HistoryTableProps) {
  const h = usePagedHistory(kind, engine, address, refreshToken);
  // Closed positions show the funding each one paid - summed from the funding
  // history, which carries the positionID. Read only on that tab.
  const fh = usePagedHistory('funding', 'perps', kind === 'positions' ? address : null, refreshToken);
  const caps = TAB_CAPS[BAND_TAB[kind]];
  const spec = HISTORY[kind];
  const rows = applyFilter(h.rows, (r) => factsOf(kind, r), filter, caps, { market: symbolFilter ?? null, now: Date.now() });
  const oldest = useMemo(() => oldestOf(h.rows, spec.timeOf), [h.rows, spec]);
  useReportMeta(onMeta, oldest, h.staleAt, h.next !== null);
  const auto = useAutoLoad(filter, caps.time, oldest, { busy: h.loading || h.loadingMore, failed: !!h.error || !!h.moreError, hasMore: h.next !== null }, h.more);
  const perps = engine === 'perps' || spec.perpsOnly;
  const eng: 'spot' | 'perps' = perps ? 'perps' : 'spot';

  let body: ReactNode = null;
  if (rows.length > 0) {
    if (kind === 'orders') body = <OrdersTable rows={rows} byName={byName} engine={eng} />;
    else if (kind === 'trades') body = <TradesTable rows={rows} byName={byName} engine={eng} />;
    else if (kind === 'funding') body = <FundingTable rows={rows} byName={byName} />;
    else {
      const funding = fundingByPosition(fh);
      // Cards <-> list cross-fade in place (motion.tsx CrossFade).
      body = (
        <CrossFade viewKey={cardView ? 'cards' : 'list'}>
          {cardView
            ? <div className="acct-cards">{rows.map((p) => <PositionCard key={HISTORY.positions.idOf(p)} p={p} byName={byName} funding={funding} />)}</div>
            : <ClosedTable rows={rows} byName={byName} funding={funding} />}
        </CrossFade>
      );
    }
  }

  return (
    <section className="panel acct">
      {headAction && <div className="acct-head">{headAction}</div>}
      {!address ? <Note>Connect a wallet to see your history.</Note>
        : h.error ? <ReadFailed what={WHAT[kind]} error={h.error} onRetry={h.retry} />
        : null}
      {address && !h.error && rows.length === 0 && (
        h.rows.length > 0 && !(auto.short && (h.loadingMore || h.next !== null))
          ? <FilteredEmpty onReset={onResetView} />
          : <Note>{h.loading || (auto.short && h.loadingMore) ? 'Loading…' : h.rows.length > 0 ? 'Nothing in this view yet.' : EMPTY_TEXT[kind]}</Note>
      )}
      {address && body}
      {address && rows.length > 0 && <FilteredHint shown={rows.length} total={h.rows.length} onReset={onResetView} />}
      {address && h.rows.length > 0 && (
        h.moreError ? <ReadFailed what={`More ${WHAT[kind].toLowerCase()}`} error={h.moreError} onRetry={h.more} />
        : h.next !== null ? (
          <LoadMore
            onMore={h.more}
            loading={h.loadingMore}
            note={auto.short && !h.loadingMore && oldest !== null && auto.from !== null
              ? `Loaded back to ${dateOnly(oldest)}. Scroll down to reach ${dateOnly(auto.from)}.`
              : undefined}
          />
        ) : null
      )}
    </section>
  );
}

// --- the four views ------------------------------------------------------------------

function OrdersTable({ rows, byName, engine }: { rows: any[]; byName: Map<string, MarketSymbol>; engine: 'spot' | 'perps' }) {
  const { sort, toggle } = useTableSort();
  const shown = sortRows(rows, sort, (o, key) => {
    const filled = num(pick(o, 'executedQty'));
    const px = num(pick(o, 'price'));
    if (key === 'market') return String(pick(o, 'symbol') ?? '');
    if (key === 'status') return String(pick(o, 'status') ?? '');
    if (key === 'type') return orderTypeText(o);
    if (key === 'price') return px > 0 ? px : null;
    if (key === 'avg') return filled > 0 ? num(pick(o, 'executedValue')) / filled : null;
    if (key === 'size') return num(pick(o, 'origQty', 'quantity'));
    if (key === 'filled') return filled;
    if (key === 'value') return num(pick(o, 'executedValue')) || null;
    if (key === 'placed') return num(pick(o, 'createdAt')) || null;
    return null;
  });
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          <SortTh k="status" label="Status" sort={sort} onSort={toggle} />
          <SortTh k="type" label="Type" sort={sort} onSort={toggle} />
          <SortTh k="price" label="Price" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="avg" label="Avg. fill" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="size" label="Size" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="filled" label="Filled" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="value" label="Value" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="placed" label="Placed" numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((o) => {
          const symbol = String(pick(o, 'symbol') ?? DASH);
          const sym = byName.get(symbol);
          const filled = num(pick(o, 'executedQty'));
          // executedValue / executedQty - sodex.com's own "execution price".
          const avg = filled > 0 ? num(pick(o, 'executedValue')) / filled : null;
          const px = num(pick(o, 'price'));
          const unit = coinLabel(sym?.baseCoin) || undefined;
          const tif = tifText(pick(o, 'timeInForce'));
          const value = num(pick(o, 'executedValue'));
          return (
            <tr key={HISTORY.orders.idOf(o)}>
              <td>
                <MarketCell symbol={symbol} sym={sym} engine={engine}>
                  <SidePill dir={directionOfSide(pick(o, 'side'))} spot={engine === 'spot'} />
                  <SourcePill source={sourceOf(pick(o, 'clOrdID'))} />
                </MarketCell>
              </td>
              <td>
                <StatusCell
                  o={{ status: pick(o, 'status'), executedQty: pick(o, 'executedQty'), origQty: pick(o, 'origQty', 'quantity'), stopPrice: pick(o, 'stopPrice'), stopType: pick(o, 'stopType') }}
                  qtyText={(v) => qty(v, sym?.stepSize)}
                  unit={unit}
                  priceText={avg !== null ? fmtPrice(avg, sym?.tickSize) : null}
                />
              </td>
              <td className="acct-word">
                {orderTypeText(o)}
                {tif && <span className="acct-sub"> · {tif}</span>}
                {pick(o, 'reduceOnly') === true && <Pill tone="muted">Reduce</Pill>}
              </td>
              {/* A market order has no limit price; 0 is not one. */}
              <td className="num">{px > 0 ? price(px, sym?.tickSize) : <span className="acct-dim">Market</span>}</td>
              <td className="num">{avg === null ? DASH : price(avg, sym?.tickSize)}</td>
              <td className="num"><Unit value={qty(pick(o, 'origQty', 'quantity'), sym?.stepSize)} unit={unit} /></td>
              <td className="num">{filled > 0 ? qty(filled, sym?.stepSize) : <span className="acct-dim">0</span>}</td>
              <td className="num">{value > 0 ? fmtUsd(value) : DASH}</td>
              <td className="num acct-time">{when(pick(o, 'createdAt'))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TradesTable({ rows, byName, engine }: { rows: any[]; byName: Map<string, MarketSymbol>; engine: 'spot' | 'perps' }) {
  const { sort, toggle } = useTableSort();
  const shown = sortRows(rows, sort, (t, key) => {
    const px = num(pick(t, 'price'));
    const q = num(pick(t, 'quantity'));
    if (key === 'market') return String(pick(t, 'symbol') ?? '');
    if (key === 'price') return px || null;
    if (key === 'size') return q || null;
    if (key === 'value') return px > 0 && q > 0 ? px * q : null;
    if (key === 'fee') return num(pick(t, 'fee'));
    if (key === 'role') return pick<boolean>(t, 'isMaker') ? 'maker' : 'taker';
    if (key === 'time') return num(pick(t, 'time')) || null;
    return null;
  });
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          <SortTh k="price" label="Price" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="size" label="Size" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="value" label="Value" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="fee" label="Fee" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="role" label="Role" sort={sort} onSort={toggle} />
          <SortTh k="time" label="Time" numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((t) => {
          const symbol = String(pick(t, 'symbol') ?? DASH);
          const sym = byName.get(symbol);
          const px = pick(t, 'price');
          const q = pick(t, 'quantity');
          const fee = pick(t, 'fee');
          const feeCoin = coinLabel(pick<string>(t, 'feeCoin'));
          const maker = pick<boolean>(t, 'isMaker');
          const unit = coinLabel(sym?.baseCoin) || undefined;
          return (
            <tr key={HISTORY.trades.idOf(t)}>
              <td>
                <MarketCell symbol={symbol} sym={sym} engine={engine}>
                  <SidePill dir={directionOfSide(pick(t, 'side'))} spot={engine === 'spot'} />
                  <SourcePill source={sourceOf(pick(t, 'clOrdID'))} />
                </MarketCell>
              </td>
              <td className="num">{price(px, sym?.tickSize)}</td>
              <td className="num"><Unit value={qty(q, sym?.stepSize)} unit={unit} /></td>
              <td className="num">{px !== undefined && q !== undefined ? fmtUsd(num(px) * num(q)) : DASH}</td>
              {/* In the fee's own coin; a negative fee is a maker rebate, as the venue reports it. */}
              <td className={`num${num(fee) < 0 ? ' pos' : ''}`}>
                {fee === undefined ? DASH
                  : feeCoin === 'USDC' ? signedUsd(num(fee), false)
                  : <Unit value={amount(fee, undefined)} unit={feeCoin || undefined} />}
              </td>
              <td className="acct-word acct-dim">{maker === true ? 'Maker' : maker === false ? 'Taker' : DASH}</td>
              <td className="num acct-time">{when(pick(t, 'time'))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FundingTable({ rows, byName }: { rows: any[]; byName: Map<string, MarketSymbol> }) {
  const { sort, toggle } = useTableSort();
  const shown = sortRows(rows, sort, (f, key) => {
    if (key === 'market') return String(pick(f, 'symbol') ?? '');
    if (key === 'payment') return num(pick(f, 'fundingFee'));
    if (key === 'time') return num(pick(f, 'timestamp')) || null;
    return null;
  });
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          <SortTh k="payment" label="Payment" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="time" label="Time" numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((f) => {
          const symbol = String(pick(f, 'symbol') ?? DASH);
          // Settled per coin: shown in feeCoin. Positive = received.
          const fee = pick(f, 'fundingFee');
          const coin = coinLabel(pick<string>(f, 'feeCoin'));
          return (
            <tr key={HISTORY.funding.idOf(f)}>
              <td>
                <MarketCell symbol={symbol} sym={byName.get(symbol)} engine="perps">
                  <SidePill dir={directionOfPosition(pick(f, 'positionSide'))} />
                </MarketCell>
              </td>
              <td className={`num ${toneOf(num(fee))}`}>
                {fee === undefined ? DASH : <Unit value={`${num(fee) > 0 ? '+' : ''}${amount(fee, undefined)}`} unit={coin || undefined} />}
              </td>
              <td className="num acct-time">{when(pick(f, 'timestamp'))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- closed positions ----------------------------------------------------------------

/** positionID -> funding paid (signed, + received), and whether a position's whole life is covered. */
interface FundingIndex {
  sum: (id: unknown, openedAt: number) => number | null;
}

function fundingByPosition(fh: ReturnType<typeof usePagedHistory>): FundingIndex {
  const sums = new Map<string, number>();
  let oldest = Infinity;
  for (const f of fh.rows) {
    const id = String(pick(f, 'positionID') ?? '');
    sums.set(id, (sums.get(id) ?? 0) + num(pick(f, 'fundingFee')));
    const t = num(pick(f, 'timestamp'));
    if (t > 0 && t < oldest) oldest = t;
  }
  const ready = !fh.loading && !fh.error && fh.key !== null;
  const all = ready && fh.next === null;
  return {
    // Only a sum that covers the position's whole life: a partial one would be
    // a confident wrong number. Covered = the funding loaded reaches back to
    // the position's opening (or is the whole history).
    sum: (id: unknown, openedAt: number) => {
      if (!ready) return null;
      if (!all && !(openedAt > 0 && oldest <= openedAt)) return null;
      return sums.get(String(id)) ?? 0;
    },
  };
}

interface Closed {
  symbol: string;
  sym: MarketSymbol | undefined;
  side: 'long' | 'short' | null;
  margin: 'cross' | 'isolated' | null;
  lev: number;
  pnl: number | null;
  roe: number | null;
  fees: number | null;
  funding: number | null;
  entry: unknown;
  close: number;
  maxOi: unknown;
  closedVol: unknown;
  opened: unknown;
  closed: unknown;
  open: boolean;
  unit?: string;
}

function closedOf(p: any, byName: Map<string, MarketSymbol>, funding: FundingIndex): Closed {
  const symbol = String(pick(p, 'symbol') ?? DASH);
  const sym = byName.get(symbol);
  const pnlRaw = pick(p, 'realizedPnL');
  const pnl = pnlRaw === undefined ? null : num(pnlRaw);
  const entry = num(pick(p, 'avgEntryPrice'));
  const maxSize = num(pick(p, 'maxSize'));
  const lev = num(pick(p, 'leverage'));
  // Return on the margin the position needed at its largest: PnL / (entry x max size / leverage).
  const margin0 = entry > 0 && maxSize > 0 && lev > 0 ? (entry * maxSize) / lev : 0;
  const feeRaw = pick(p, 'cumTradingFee');
  return {
    symbol,
    sym,
    side: directionOfPosition(pick(p, 'positionSide')),
    margin: marginOf(pick(p, 'marginMode')),
    lev,
    pnl,
    roe: pnl !== null && margin0 > 0 ? pnl / margin0 : null,
    fees: feeRaw === undefined ? null : -num(feeRaw),
    // A position closed before the funding page reached back gets a dash, not a partial sum.
    funding: funding.sum(pick(p, 'id'), num(pick(p, 'createdAt'))),
    entry: pick(p, 'avgEntryPrice'),
    close: num(pick(p, 'avgClosePrice')),
    maxOi: pick(p, 'maxSize'),
    closedVol: pick(p, 'cumClosedSize'),
    opened: pick(p, 'createdAt'),
    closed: pick(p, 'updatedAt'),
    open: pick<boolean>(p, 'active') === true,
    unit: coinLabel(sym?.baseCoin) || undefined,
  };
}

const TRADE_LINK = (symbol: string) => `/trade?symbol=${encodeURIComponent(symbol)}`;

/** Image 15: the market line, a row of big figures, a row of small ones. A hairline between cards, no box. */
function PositionCard({ p, byName, funding }: { p: any; byName: Map<string, MarketSymbol>; funding: FundingIndex }) {
  const c = closedOf(p, byName, funding);
  const mask = useMask('history');
  const pill = c.margin ? MARGIN_WORD[c.margin] : undefined;
  const Big = ({ label, value, tone, title }: { label: string; value: string; tone: string; title?: string }) => (
    <div className="acct-card__m" title={title}>
      <span className="acct-card__k">{label}</span>
      <span className={`acct-card__v acct-card__v--big ${tone}`}>{mask(value)}</span>
    </div>
  );
  const Small = ({ label, value, unit }: { label: string; value: string; unit?: string }) => (
    <div className="acct-card__m">
      <span className="acct-card__k">{label}</span>
      <span className="acct-card__v">{mask(value)}{unit && value !== DASH && <span className="acct-unit"> {unit}</span>}</span>
    </div>
  );
  return (
    <article className="acct-card">
      <header className="acct-card__head">
        <CoinIcon coin={c.sym?.baseCoin ?? c.symbol} size={20} />
        <span className="acct-card__sym">{c.sym?.displayName ?? c.symbol}</span>
        <SidePill dir={c.side} prefix={pill} />
        {c.lev > 0 && <span className="acct-lev">{c.lev}x</span>}
        {c.open && <Pill tone="accent">Open</Pill>}
        <a className="acct-card__link" href={TRADE_LINK(c.symbol)} title={`Trade ${c.sym?.displayName ?? c.symbol}`} aria-label={`Open ${c.sym?.displayName ?? c.symbol} on the trade page`}>
          <ExternalIcon />
        </a>
      </header>
      <div className="acct-card__grid acct-card__grid--big">
        <Big label="Closing PnL" value={signedUsd(c.pnl)} tone={toneOf(c.pnl)} title="realizedPnL as the venue reports it - after trading fees." />
        <Big label="ROE" value={signedPct(c.roe)} tone={toneOf(c.roe)} title="Closing PnL over the margin at the position's largest size (entry × max size ÷ leverage)." />
        <Big label="Fees" value={signedUsd(c.fees)} tone={toneOf(c.fees)} />
        <Big label="Funding" value={signedUsd(c.funding)} tone={toneOf(c.funding)} title={c.funding === null ? 'Funding for this position is older than the funding history loaded.' : 'Funding paid (−) or received (+) over the position’s life.'} />
      </div>
      <div className="acct-card__grid">
        <Small label="Entry Price" value={price(c.entry, c.sym?.tickSize)} />
        <Small label="Avg. Close Price" value={c.close > 0 ? price(c.close, c.sym?.tickSize) : DASH} />
        <Small label="Max Open Interest" value={qty(c.maxOi, c.sym?.stepSize)} unit={c.unit} />
        <Small label="Closed Vol." value={qty(c.closedVol, c.sym?.stepSize)} unit={c.unit} />
        <Small label="Opened" value={when(c.opened)} />
        <Small label="Closed" value={c.open ? 'Open' : when(c.closed)} />
      </div>
    </article>
  );
}

/** The slim view: the card's figures as an ordinary table. */
function ClosedTable({ rows, byName, funding }: { rows: any[]; byName: Map<string, MarketSymbol>; funding: FundingIndex }) {
  const { sort, toggle } = useTableSort();
  const shown = sortRows(rows, sort, (p, key) => {
    const c = closedOf(p, byName, funding);
    if (key === 'market') return c.symbol;
    if (key === 'pnl') return c.pnl;
    if (key === 'roe') return c.roe;
    if (key === 'fees') return c.fees;
    if (key === 'funding') return c.funding;
    if (key === 'entry') return num(c.entry) || null;
    if (key === 'close') return c.close > 0 ? c.close : null;
    if (key === 'oi') return num(c.maxOi) || null;
    if (key === 'vol') return num(c.closedVol) || null;
    if (key === 'opened') return num(c.opened) || null;
    if (key === 'closed') return c.open ? null : num(c.closed);
    return null;
  });
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          <SortTh k="pnl" label="Closing PnL" numeric sort={sort} onSort={toggle} className="num" title="realizedPnL as the venue reports it - after trading fees." />
          <SortTh k="roe" label="ROE" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="fees" label="Fees" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="funding" label="Funding" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="entry" label="Entry" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="close" label="Avg. close" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="oi" label="Max OI" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="vol" label="Closed vol." numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="opened" label="Opened" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="closed" label="Closed" numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((p) => {
          const c = closedOf(p, byName, funding);
          return (
            <tr key={HISTORY.positions.idOf(p)}>
              <td>
                <MarketCell symbol={c.symbol} sym={c.sym} engine="perps">
                  <SidePill dir={c.side} prefix={c.margin ? MARGIN_WORD[c.margin] : undefined} />
                  {c.lev > 0 && <span className="acct-lev">{c.lev}x</span>}
                </MarketCell>
              </td>
              <td className={`num ${toneOf(c.pnl)}`}>{signedUsd(c.pnl)}</td>
              <td className={`num ${toneOf(c.roe)}`}>{signedPct(c.roe)}</td>
              <td className={`num ${toneOf(c.fees)}`}>{signedUsd(c.fees)}</td>
              <td className={`num ${toneOf(c.funding)}`}>{signedUsd(c.funding)}</td>
              <td className="num">{price(c.entry, c.sym?.tickSize)}</td>
              <td className="num">{c.close > 0 ? price(c.close, c.sym?.tickSize) : DASH}</td>
              <td className="num"><Unit value={qty(c.maxOi, c.sym?.stepSize)} unit={c.unit} /></td>
              <td className="num"><Unit value={qty(c.closedVol, c.sym?.stepSize)} unit={c.unit} /></td>
              <td className="num acct-time">{when(c.opened)}</td>
              <td className="num acct-time">{c.open ? 'Open' : when(c.closed)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const ExternalIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  </svg>
);

/* ===========================================================================
 *  ACCOUNT LEDGER - money in, money out, and moves on ValueChain
 * ======================================================================== */

interface Ledger {
  key: string | null;
  flows: { rows: LedgerRow[]; offset: number; done: boolean };
  vc: { rows: LedgerRow[]; page: number; done: boolean };
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  moreError: unknown;
}

const LEDGER_IDLE: Ledger = {
  key: null,
  flows: { rows: [], offset: 0, done: false },
  vc: { rows: [], page: 0, done: false },
  loading: false,
  loadingMore: false,
  error: null,
  moreError: null,
};

/** ValueChain token address -> coin, from SoDEX's asset config. Empty if that read fails. */
async function tokenBook(): Promise<TokenBook> {
  const book: TokenBook = new Map();
  try {
    for (const c of await cachedAssetConfigs()) {
      if (!c.valuechain.native) book.set(c.valuechain.token.toLowerCase(), { symbol: c.coin, decimals: c.valuechain.decimals });
    }
  } catch {
    /* labelled by address instead */
  }
  return book;
}

const byId = (r: LedgerRow) => r.id;
const byTime = (r: LedgerRow) => r.time;

/** A withdrawal still on its way is re-read this often, so its status moves on screen. */
const PENDING_POLL_MS = 15_000;

/** Account history as last shown, per address - see pagedCache. */
const ledgerCache = new Map<string, Ledger>();

function useLedger(address: string | null, refreshToken: number) {
  const key = address ? `ledger:${address}` : null;
  const [s, setS] = useState<Ledger>(() => (key && ledgerCache.get(key)) || LEDGER_IDLE);
  useEffect(() => {
    if (s.key && !s.loading && !s.error) ledgerCache.set(s.key, s);
  }, [s]);
  const cur = useRef(s);
  cur.current = s;
  const keyRef = useRef(key);
  keyRef.current = key;

  const first = useCallback((reset: boolean) => {
    if (!key || !address) return;
    const k = key;
    setS((p) => (reset || p.key !== k ? { ...LEDGER_IDLE, key: k, loading: true } : { ...p, error: null }));
    Promise.all([fetchAccountFlows(address, 0), tokenBook().then((t) => fetchFundTransfers(address, 1, t))]).then(
      ([flows, vc]) => {
        if (keyRef.current !== k) return;
        setS((p) => {
          if (p.key !== k) return p;
          const fresh = p.flows.offset === 0;
          return {
            ...p,
            loading: false,
            error: null,
            // Re-read of the first page: merged, so a status that moved replaces
            // the old row and older pages stay loaded.
            flows: {
              rows: mergeRows(p.flows.rows, flows.rows, byId, byTime),
              offset: fresh ? flows.raw : p.flows.offset,
              done: fresh ? flows.done : p.flows.done,
            },
            vc: {
              rows: mergeRows(p.vc.rows, vc.rows, byId, byTime),
              page: p.vc.page === 0 ? 1 : p.vc.page,
              done: p.vc.page === 0 ? vc.done : p.vc.done,
            },
          };
        });
      },
      (e: unknown) => {
        if (keyRef.current !== k) return;
        if (!reset && cur.current.key === k && (cur.current.flows.rows.length > 0 || cur.current.vc.rows.length > 0)) {
          logLoadFailure('Account history', e);
          return;
        }
        setS((p) => (p.key === k ? { ...p, loading: false, error: e } : p));
      },
    );
  }, [key, address]);

  const more = useCallback(() => {
    const p0 = cur.current;
    if (!key || !address || p0.key !== key || p0.loadingMore) return;
    const { pull } = timeline([p0.flows, p0.vc], byTime);
    if (pull.length === 0) return;
    const k = key;
    setS((p) => ({ ...p, loadingMore: true, moreError: null }));
    Promise.all([
      pull.includes(0) ? fetchAccountFlows(address, p0.flows.offset) : null,
      pull.includes(1) ? tokenBook().then((t) => fetchFundTransfers(address, p0.vc.page + 1, t)) : null,
    ]).then(
      ([flows, vc]) => {
        if (keyRef.current !== k) return;
        setS((p) => {
          if (p.key !== k) return p;
          return {
            ...p,
            loadingMore: false,
            flows: flows
              ? {
                  rows: mergeRows(p.flows.rows, flows.rows, byId, byTime),
                  offset: p.flows.offset + flows.raw,
                  done: flows.done || countNew(p.flows.rows, flows.rows, byId) === 0,
                }
              : p.flows,
            vc: vc
              ? {
                  rows: mergeRows(p.vc.rows, vc.rows, byId, byTime),
                  page: p.vc.page + 1,
                  done: vc.done || countNew(p.vc.rows, vc.rows, byId) === 0,
                }
              : p.vc,
          };
        });
      },
      (e: unknown) => {
        if (keyRef.current !== k) return;
        setS((p) => (p.key === k ? { ...p, loadingMore: false, moreError: e } : p));
      },
    );
  }, [key, address]);

  useEffect(() => {
    if (!key) { setS(LEDGER_IDLE); return; }
    const kept = ledgerCache.get(key);
    if (kept) { setS(kept); first(false); } else first(true);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    first(false);
  }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = s.key === key ? s : { ...LEDGER_IDLE, loading: !!key };
  const view = useMemo(() => timeline([live.flows, live.vc], byTime), [live.flows, live.vc]);
  const pending = view.rows.some((r) => r.state === 'pending');
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => first(false), PENDING_POLL_MS);
    return () => window.clearInterval(id);
  }, [pending, first]);

  return { ...live, rows: view.rows, hasMore: view.more, more, retry: () => first(false) };
}

function TxLink({ chain, hash }: { chain: string; hash: string | null }) {
  if (!hash) return <>{DASH}</>;
  const short = `${hash.slice(0, 6)}…${hash.slice(-4)}`;
  const url = txUrl(chain, hash);
  return url
    ? <a className="acct-tx" href={url} target="_blank" rel="noreferrer noopener" title={hash}>{short}<ExternalIcon /></a>
    : <span className="acct-tx" title={hash}>{short}</span>;
}

/** A ledger state as the order-status glyphs draw it. */
const LEDGER_GLYPH: Record<LedgerRow['state'], { kind: StatusKind; tone: StatusTone }> = {
  completed: { kind: 'filled', tone: 'pos' },
  pending: { kind: 'pending', tone: 'accent' },
  review: { kind: 'pending', tone: 'warn' },
  failed: { kind: 'expired', tone: 'neg' },
  refunded: { kind: 'replaced', tone: 'muted' },
};

/** Money that arrives (into SoDEX, or into this wallet) against money that leaves. */
const INBOUND: ReadonlySet<LedgerRow['kind']> = new Set(['deposit', 'received', 'reward', 'evm-to-spot']);

export function AccountLedger({
  address, refreshToken, filter = DEFAULT_FILTER, onResetView, onMeta,
}: { address: string | null; refreshToken: number; filter?: TableFilter; onResetView?: () => void; onMeta?: (m: BandMeta) => void }) {
  const available = ledgerAvailable();
  const l = useLedger(available ? address : null, refreshToken);
  const caps = TAB_CAPS['account-history'];
  const rows = applyFilter(l.rows, (r) => ({ time: r.time }), filter, caps, { market: null, now: Date.now() });
  const { sort, toggle } = useTableSort();
  const shown = sortRows(rows, sort, (r, key) => {
    if (key === 'type') return r.kind;
    if (key === 'asset') return r.coin ?? '';
    if (key === 'amount') return r.amount === null ? null : num(r.amount);
    if (key === 'network') return r.chain ?? '';
    if (key === 'fee') return r.fee === null ? null : num(r.fee);
    if (key === 'status') return r.status;
    if (key === 'tx') return r.tx ?? '';
    if (key === 'time') return r.time || null;
    return null;
  });
  const oldest = useMemo(() => oldestOf(l.rows, byTime), [l.rows]);
  useReportMeta(onMeta, oldest, null, l.hasMore);
  const auto = useAutoLoad(filter, caps.time, oldest, { busy: l.loading || l.loadingMore, failed: !!l.error || !!l.moreError, hasMore: l.hasMore }, l.more);

  if (!address) return <section className="panel acct"><Note>Connect a wallet to see deposits, withdrawals and transfers.</Note></section>;
  if (!available) return <section className="panel acct"><Note>Deposits, withdrawals and transfers are published for mainnet accounts only.</Note></section>;

  return (
    <section className="panel acct">
      {l.error ? <ReadFailed what="Account history" error={l.error} onRetry={l.retry} />
        : rows.length === 0 ? (
          l.rows.length > 0 && !(auto.short && (l.loadingMore || l.hasMore))
            ? <FilteredEmpty onReset={onResetView} />
            : <Note>{l.loading || l.loadingMore ? 'Loading…' : l.rows.length > 0 ? 'Nothing in this view yet.' : 'No deposits, withdrawals or transfers yet.'}</Note>
        )
        : (
          <table className="acct-table acct-t">
            <thead>
              <tr>
                <SortTh k="type" label="Type" sort={sort} onSort={toggle} />
                <SortTh k="asset" label="Asset" sort={sort} onSort={toggle} />
                <SortTh k="amount" label="Amount" numeric sort={sort} onSort={toggle} className="num" />
                <SortTh k="network" label="Network" sort={sort} onSort={toggle} />
                <SortTh k="fee" label="Fee" numeric sort={sort} onSort={toggle} className="num" />
                <SortTh k="status" label="Status" sort={sort} onSort={toggle} />
                <SortTh k="tx" label="Transaction" sort={sort} onSort={toggle} />
                <SortTh k="time" label="Time" numeric sort={sort} onSort={toggle} className="num" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const inbound = INBOUND.has(r.kind);
                const g = LEDGER_GLYPH[r.state];
                return (
                  <tr key={r.id}>
                    <td>
                      <span className="acct-mkt">
                        <span className={`acct-dir acct-dir--${inbound ? 'in' : 'out'}`} aria-hidden="true">{inbound ? <InIcon /> : <OutIcon />}</span>
                        <span className="acct-mkt__n">{r.label}</span>
                      </span>
                    </td>
                    <td><span className="acct-mkt"><CoinLabel coin={r.coin} size={18}><span className="acct-word">{coinLabel(r.coin)}</span></CoinLabel></span></td>
                    <td className={`num${inbound ? ' pos' : ''}`}>
                      {r.amount === null ? DASH : `${inbound ? '+' : '−'}${fmt(r.amount, undefined)}`}
                    </td>
                    <td className="acct-word">
                      <span className="acct-net">
                        <CoinIcon chain={r.chain} size={16} />
                        {r.chain === 'VALUECHAIN' ? 'ValueChain' : chainLabel(r.chain)}
                      </span>
                    </td>
                    <td className="num">{r.fee === null ? DASH : fmt(r.fee, undefined)}</td>
                    <td>
                      <span className="acct-status" title={r.status}>
                        <StatusIcon info={{ ...g, filled: null }} title={r.status} />
                        <span className="acct-status__l">{r.status}</span>
                      </span>
                    </td>
                    <td className="acct-word" title={r.valueChainTx ? `ValueChain tx ${r.valueChainTx}` : undefined}>
                      {/* A withdrawal links its payout on the destination chain, which only exists once SoDEX has sent it. */}
                      <TxLink chain={r.txChain} hash={r.tx} />
                    </td>
                    <td className="num acct-time">{when(r.time)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      {!l.error && l.rows.length > 0 && (
        l.moreError ? <ReadFailed what="More account history" error={l.moreError} onRetry={l.more} />
        : l.hasMore ? (
          <LoadMore
            onMore={l.more}
            loading={l.loadingMore}
            note={auto.short && !l.loadingMore && oldest !== null && auto.from !== null
              ? `Loaded back to ${dateOnly(oldest)}. Scroll down to reach ${dateOnly(auto.from)}.`
              : undefined}
          />
        ) : null
      )}
    </section>
  );
}

const InIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" />
  </svg>
);
const OutIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" />
  </svg>
);

/* ===========================================================================
 *  ALL BALANCES - Spot, Perps and the EVM wallet
 * ======================================================================== */

interface BalanceLine {
  coin: string;
  total: number | null;
  locked: number | null;
  available: number | null;
}

function Section({
  title, icon, lines, prices, lockedLabel, note,
}: {
  title: string;
  /** The account's mark, as the funds sheets draw it. */
  icon?: ReactNode;
  lines: BalanceLine[]; prices: Map<string, number> | null; lockedLabel: string; note?: ReactNode;
}) {
  let sum = 0;
  let priced = 0;
  const value = (l: BalanceLine): number | null => {
    const px = prices ? priceOf(prices, l.coin) : undefined;
    return px !== undefined && l.total !== null ? l.total * px : null;
  };
  for (const l of lines) {
    const v = value(l);
    if (v !== null) { sum += v; priced++; }
  }
  const d = (v: number | null, coin: string) => (v === null ? DASH : fmtBalance(v, coin));
  return (
    <>
      <div className="acct-head acct-sub">
        <h2>{icon}{title}</h2>
        {priced > 0 && <span className="acct-sub__total">{fmtUsd(sum)}</span>}
      </div>
      {note ?? (
        <table className="acct-table acct-t">
          <thead>
            <tr>
              <th>Asset</th><th className="num">Total</th><th className="num">{lockedLabel}</th>
              <th className="num">Available</th><th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const v = value(l);
              return (
                <tr key={l.coin}>
                  <td><span className="acct-mkt"><CoinLabel coin={l.coin} size={18}><span className="acct-mkt__n">{coinLabel(l.coin)}</span></CoinLabel></span></td>
                  <td className="num">{d(l.total, l.coin)}</td>
                  <td className="num">{l.locked ? d(l.locked, l.coin) : <span className="acct-dim">{l.locked === null ? DASH : '0'}</span>}</td>
                  <td className="num">{d(l.available, l.coin)}</td>
                  <td className="num">{v === null ? DASH : fmtUsd(v)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Rows with nothing in them are left out: a list of zeros says nothing. */
const held = (l: BalanceLine) => (l.total ?? 0) !== 0 || (l.available ?? 0) !== 0;

/** sSOSO is a staking receipt. Unstake lives on SoDEX's own portfolio, not here. */
const SODEX_PORTFOLIO = 'https://sodex.com/portfolio';
const isStakedSoso = (label: string) => label.toUpperCase() === 'SSOSO';

function matchCoin(configs: CoinConfig[] | null, label: string): CoinConfig | null {
  if (!configs) return null;
  const u = label.toUpperCase();
  return configs.find((c) => c.coin.toUpperCase() === u || c.asset.toUpperCase() === u || coinLabel(c.asset).toUpperCase() === u) ?? null;
}

/** Deposit and withdraw only where SoDEX currently allows that coin to move. Transfer only where a route exists. */
function coinActions(configs: CoinConfig[] | null, label: string): { deposit: boolean; withdraw: boolean; transfer: boolean } {
  const coin = matchCoin(configs, label);
  if (!coin) return { deposit: false, withdraw: false, transfer: false };
  const accounts = ['spot', 'perps', 'evm'] as const;
  const transfer = accounts.some((from) => accounts.some((to) => from !== to && transferProblem(coin, from, to) === null));
  return { deposit: canDepositCoin(coin), withdraw: canWithdrawCoin(coin), transfer };
}

function BalanceActions({
  coin, parts, deposit, withdraw, transfer,
}: {
  coin: string;
  parts: { spot?: BalanceLine; futures?: BalanceLine; evm?: BalanceLine };
  deposit: boolean;
  withdraw: boolean;
  transfer: boolean;
}) {
  const from = richestVenue(parts);
  const to = from === 'spot' ? 'perps' : 'spot';
  return (
    <>
      {transfer && <button type="button" className="acct-act" onClick={() => requestTransfer({ from, to, coin })}>Transfer</button>}
      {deposit && <button type="button" className="acct-act" onClick={requestDeposit}>Deposit</button>}
      {withdraw && <button type="button" className="acct-act" onClick={() => requestWithdraw({ coin })}>Withdraw</button>}
      {isStakedSoso(coin) && (
        <a className="acct-act" href={SODEX_PORTFOLIO} target="_blank" rel="noopener noreferrer">Unstake</a>
      )}
    </>
  );
}

/** The account that holds the most of this coin, which is where a transfer starts. */
function richestVenue(parts: { spot?: BalanceLine; futures?: BalanceLine; evm?: BalanceLine }): 'spot' | 'perps' | 'evm' {
  const ranked = [
    ['spot', parts.spot],
    ['perps', parts.futures],
    ['evm', parts.evm],
  ] as const;
  let best: 'spot' | 'perps' | 'evm' = 'spot';
  let n = -1;
  for (const [id, line] of ranked) {
    if (!line) continue;
    const v = line.available ?? line.total ?? 0;
    if (v > n) { n = v; best = id; }
  }
  return best;
}

export function AllBalances({ address, refreshToken, readOnly = false }: { address: string | null; refreshToken: number; readOnly?: boolean }) {
  // The same shared feeds (and keys, and interval) the Balances table and the
  // order ticket read - no extra request when they are mounted too.
  const spotKey = address ? `state:spot:${address}` : null;
  const perpsKey = address ? `state:perps:${address}` : null;
  const spot = useAccountResource(spotKey, () => api.state('spot', address!), 20_000);
  const perps = useAccountResource(perpsKey, () => api.state('perps', address!), 20_000);
  const bumpSpot = useCallback(() => bumpAccountResource(spotKey), [spotKey]);
  const bumpPerps = useCallback(() => bumpAccountResource(perpsKey), [perpsKey]);
  useChannel('spot', address ? { channel: 'accountUpdate', user: address } : null, bumpSpot);
  useChannel('perps', address ? { channel: 'accountUpdate', user: address } : null, bumpPerps);

  const wallet = useSyncExternalStore(subscribeWallet, () => (address ? walletRead(address) : null));
  useEffect(() => { if (address) refreshWallet(address); }, [address]);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    spot.refresh();
    perps.refresh();
    if (address) refreshWallet(address, true);
  }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const prices = useAsync(() => coinPrices(), [], { pollMs: 60_000 });
  const [hideDust] = useSharedStored('vs.balances.hideDust', false);
  const [openCoin, setOpenCoin] = useState<string | null>(null);
  const [coinConfigs, setCoinConfigs] = useState<CoinConfig[] | null>(null);
  useEffect(() => {
    let stop = false;
    cachedAssetConfigs().then((c) => { if (!stop) setCoinConfigs(c); }).catch(() => { if (!stop) setCoinConfigs([]); });
    return () => { stop = true; };
  }, []);
  const { sort, toggle } = useTableSort({ key: 'usd', dir: 'desc' });

  if (!address) return <section className="panel acct"><Note>Connect a wallet to see your balances.</Note></section>;

  // Spot rows are { a coin, t total, l locked }.
  const spotLines: BalanceLine[] = ((spot.data?.state?.B ?? []) as any[]).map((b) => {
    const t = pick(b, 't', 'total');
    const l = pick(b, 'l', 'locked');
    return {
      coin: String(pick(b, 'a', 'coin') ?? DASH),
      total: t === undefined ? null : num(t),
      locked: l === undefined ? null : num(l),
      available: t === undefined || l === undefined ? null : num(t) - num(l),
    };
  }).filter(held);
  // Perps rows are { a coin, wb wallet balance, aw available for margin }.
  const perpsLines: BalanceLine[] = ((perps.data?.state?.B ?? []) as any[]).map((b) => {
    const wb = pick(b, 'wb');
    const aw = pick(b, 'aw');
    return {
      coin: String(pick(b, 'a', 'coin') ?? DASH),
      total: wb === undefined ? null : num(wb),
      locked: wb === undefined || aw === undefined ? null : Math.max(0, num(wb) - num(aw)),
      available: aw === undefined ? null : num(aw),
    };
  }).filter(held);
  // The EVM account is the wallet on ValueChain - what sodex.com calls EVM-Funding.
  const evmLines: BalanceLine[] = (wallet?.rows ?? [])
    .filter((r) => r.chain === 'VALUECHAIN')
    .map((r) => ({ coin: r.symbol, total: num(r.amount), locked: null, available: num(r.amount) }))
    .filter(held);

  const px = prices.data ?? null;
  const engineNote = (what: string, f: typeof spot, lines: BalanceLine[]): ReactNode =>
    f.error && !f.data ? <ReadFailed what={what} error={f.error} onRetry={f.refresh} />
      : !f.data ? <Note>Loading…</Note>
      : f.data.exists === false ? <Note>No account here yet - deposit once to create one.</Note>
      : lines.length === 0 ? <Note>Nothing held.</Note>
      : undefined;

  const byCoin = new Map<string, { spot?: BalanceLine; futures?: BalanceLine; evm?: BalanceLine }>();
  const put = (venue: 'spot' | 'futures' | 'evm', line: BalanceLine) => {
    const key = coinLabel(line.coin) || line.coin;
    const row = byCoin.get(key) ?? {};
    row[venue] = line;
    byCoin.set(key, row);
  };
  for (const l of spotLines) put('spot', l);
  for (const l of perpsLines) put('futures', l);
  for (const l of evmLines) put('evm', l);

  const pxOf = (coin: string, amount: number | null): number | null => {
    if (!px || amount === null) return null;
    const v = priceOf(px, coin);
    return v === undefined ? null : amount * v;
  };

  const rows = [...byCoin.entries()].map(([label, parts]) => {
    const pieces = (
      [
        ['spot', 'Spot', parts.spot],
        ['futures', 'Margin & futures', parts.futures],
        ['evm', 'EVM funding', parts.evm],
      ] as const
    ).filter((p) => p[2]);
    const total = pieces.reduce((s, p) => s + (p[2]!.total ?? 0), 0);
    const usd = pieces.reduce((s, p) => {
      const v = pxOf(p[2]!.coin, p[2]!.total);
      return v === null || s === null ? null : s + v;
    }, 0 as number | null);
    let available: number | null = null;
    for (const p of pieces) {
      const a = p[2]!.available;
      if (a === null) continue;
      available = (available ?? 0) + a;
    }
    return { label, pieces, parts, total, available, usd, coin: pieces[0]![2]!.coin };
  }).filter((r) => !(hideDust && r.usd !== null && r.usd < 1));
  const shown = sortRows(rows, sort, (r, key) => {
    if (key === 'coin') return r.label;
    if (key === 'total') return r.total;
    if (key === 'usd') return r.usd;
    if (key === 'available') return r.available;
    return null;
  });

  const loading = (!spot.data && !spot.error) || (!perps.data && !perps.error) || (!wallet || wallet.pending > 0);
  const failed = spot.error && !spot.data ? spot : perps.error && !perps.data ? perps : null;

  return (
    <section className="panel acct">
      {failed ? <ReadFailed what="Balances" error={failed.error!} onRetry={failed.refresh} />
        : loading && rows.length === 0 ? <Note>Loading…</Note>
        : rows.length === 0 ? <Note>{hideDust ? 'Nothing above 1 USDC.' : 'Nothing held.'}</Note>
        : (
          <table className="acct-table acct-t">
            <thead>
              <tr>
                <SortTh k="coin" label="Coin" sort={sort} onSort={toggle} />
                <SortTh k="total" label="Total balance" numeric sort={sort} onSort={toggle} className="num" />
                <SortTh k="usd" label="USD value" numeric sort={sort} onSort={toggle} className="num" />
                <SortTh k="available" label="Available balance" numeric sort={sort} onSort={toggle} className="num" />
                <th className="acct-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const many = r.pieces.length > 1;
                const open = openCoin === r.label;
                return (
                  <Fragment key={r.label}>
                    <tr>
                      <td>
                        <span className="acct-mkt">
                          <CoinLabel coin={r.coin} size={18}><span className="acct-mkt__n">{r.label}</span></CoinLabel>
                          {many && (
                            <button
                              type="button"
                              className={`bal-more${open ? ' is-open' : ''}`}
                              aria-expanded={open}
                              aria-label={open ? 'Hide breakdown' : 'Show breakdown'}
                              onClick={() => setOpenCoin(open ? null : r.label)}
                            >
                              <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true" focusable="false">
                                <path d="M1 1.2 4 3.9l3-2.7" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          )}
                          <span className="bal-tags">
                            {r.pieces.map((p) => <span key={p[0]} className="bal-tag">{p[1]}</span>)}
                          </span>
                        </span>
                      </td>
                      <td className="num">{fmtBalance(r.total, r.coin)}</td>
                      <td className="num">{r.usd === null ? DASH : fmtUsd(r.usd)}</td>
                      <td className="num">{r.available === null ? DASH : fmtBalance(r.available, r.coin)}</td>
                      <td className="acct-actions">
                        {!readOnly && (
                          <BalanceActions
                            coin={coinLabel(r.coin) || r.label}
                            parts={r.parts}
                            {...coinActions(coinConfigs, coinLabel(r.coin) || r.label)}
                          />
                        )}
                      </td>
                    </tr>
                    {many && open && r.pieces.map((p) => (
                      <tr key={`${r.label}-${p[0]}`} className="bal-sub">
                        <td><span className="bal-tag">{p[1]}</span></td>
                        <td className="num">{fmtBalance(p[2]!.total, p[2]!.coin)}</td>
                        <td className="num">{(() => { const v = pxOf(p[2]!.coin, p[2]!.total); return v === null ? DASH : fmtUsd(v); })()}</td>
                        <td className="num">{p[2]!.available === null ? DASH : fmtBalance(p[2]!.available, p[2]!.coin)}</td>
                        <td />
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
    </section>
  );
}
