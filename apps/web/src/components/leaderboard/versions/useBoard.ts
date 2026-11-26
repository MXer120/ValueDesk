/**
 * The leaderboard versions' one read (localhost only, versions/index.tsx): the same board, the same way, as the
 * Original page (LeaderboardPage.tsx) reads it - the hundred on the bar's choices, its kept answer drawn at once, a
 * poll every 15 s, the podium's curves when the first answer has none, the other windows read ahead in idle time.
 * Only the presentation differs between versions, so they all show the same figures.
 *
 * Shaping (sort, search, asset group, account size) only narrows or reorders that hundred on the page. Nothing here
 * is computed that the board does not carry, except two plain ratios of its own figures: edge (PnL per traded
 * dollar, bps) and the account-size band of the Cohorts page (sizeCohort over the row's account value).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useAsync } from '../../../hooks';
import { mayReadAhead, peekAnswer, peekJson, readingAhead, revalidating } from '../../../serverFetch';
import { vsPaths } from '../../../vsPaths';
import { useLoadFailedToast } from '../../LoadFailed';
import { VsError, vsApi, type BoardWindow, type LeaderboardResponse, type TraderRow, type Venue } from '../../../vsApi';
import { DEFAULT_VIEW, lbQuery, parseView, writeView, type LbMode, type LbView, type SodexTradeNote } from '../lbState';

export type Page = LeaderboardResponse & {
  partial?: Venue[];
  index?: { complete: boolean; pending: number; updatedAt: number; rankSince?: number | null };
  sodexTrades?: SodexTradeNote;
};
type Loaded = { ok: true; key: string; res: Page } | { ok: false; key: string; code?: string; message: string };

export * from './shape';


/* ----------------------------------------------------------------------------------- the read ----- */

const SEARCH_DEBOUNCE_MS = 200;
const AHEAD_WINDOWS: readonly BoardWindow[] = ['1d', '7d', '30d', 'all'];

function withCurves(rows: TraderRow[], curves: TraderRow[] | undefined): TraderRow[] {
  if (!curves?.length) return rows;
  const by = new Map(curves.slice(0, 3).map((r) => [`${r.venue}:${r.address}`, r]));
  return rows.map((r) => {
    const c = by.get(`${r.venue}:${r.address}`);
    if (!c) return r;
    return { ...r, accountValue: r.accountValue ?? c.accountValue, spark: (c.spark?.length ?? 0) > 1 ? c.spark : r.spark };
  });
}

const needsCurves = (rows: TraderRow[]): boolean => rows.slice(0, 3).some((r) => (r.spark?.length ?? 0) < 2 || r.accountValue == null);

/** Once the first board is drawn, the same hundred's other windows in idle time (LeaderboardPage.tsx useOtherWindows). */
function useOtherWindows(view: LbView, minTrades: 0 | 2, ready: boolean): void {
  const done = useRef(false);
  const latest = useRef({ view, minTrades });
  latest.current = { view, minTrades };
  useEffect(() => {
    if (!ready || done.current || !mayReadAhead()) return;
    const run = () => {
      if (done.current) return;
      done.current = true;
      const { view: v, minTrades: m } = latest.current;
      for (const w of AHEAD_WINDOWS) {
        const q = lbQuery({ ...v, window: w }, m);
        if (w === v.window || peekAnswer(vsPaths.leaderboard(q))) continue;
        readingAhead(() => vsApi.leaderboard(q)).catch(() => { /* the tap reads it then */ });
      }
    };
    const idle = typeof window.requestIdleCallback === 'function';
    const h = idle ? window.requestIdleCallback(run, { timeout: 4_000 }) : window.setTimeout(run, 1_000);
    return () => { if (idle) window.cancelIdleCallback(h); else window.clearTimeout(h); };
  }, [ready]);
}

export interface Board {
  view: LbView;
  /** Narrowing the hundred (venues, side, mode, window) or the URL's search. Back to page 1. */
  update: (patch: Partial<LbView>) => void;
  setVenues: (next: Venue[]) => void;
  multi: boolean;
  mode: LbMode;
  minTrades: 0 | 2;
  setMinTrades: (m: 0 | 2) => void;
  /** The search box's text (committed to `view.q` after a pause, on Enter, or cleared on Escape). */
  draft: string;
  onSearch: (text: string) => void;
  onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** The board's answer: the current one, or the kept one while it comes. */
  page: Page | null;
  /** The hundred, in the server's (PnL) order, the podium's curves merged in. */
  rows: TraderRow[] | null;
  /** The answer drawn is a kept one: when it was made. */
  heldAt: number | null;
  loading: boolean;
  failed: boolean;
  unavailable: boolean;
  refresh: () => void;
  /** Changes whenever the board's choices do (venues, side, mode, window, trades filter). */
  key: string;
}

export function useBoard(embedded: boolean): Board {
  const [view, setView] = useState<LbView>(() => parseView(embedded ? '' : window.location.search));
  const [minTrades, setMinTrades] = useState<0 | 2>(2);
  const [draft, setDraft] = useState(view.q);
  const debounce = useRef<number>();

  const update = useCallback((patch: Partial<LbView>) => setView((v) => ({ ...v, page: 1, ...patch })), []);
  const setVenues = useCallback((next: Venue[]) => setView((cur) => ({ ...cur, venues: next, page: 1 })), []);
  const multi = view.venues.length > 1;

  useEffect(() => {
    if (embedded) return;
    const next = writeView(window.location.search, view, DEFAULT_VIEW);
    if (next !== window.location.search) window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`);
  }, [view, embedded]);

  useEffect(() => { setDraft((d) => (d.trim() === view.q ? d : view.q)); }, [view.q]);
  useEffect(() => () => window.clearTimeout(debounce.current), []);
  const commit = useCallback((text: string) => {
    window.clearTimeout(debounce.current);
    const q = text.trim().slice(0, 64);
    setView((v) => (v.q === q ? v : { ...v, q, page: 1 }));
  }, []);
  const onSearch = useCallback((text: string) => {
    setDraft(text);
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => commit(text), SEARCH_DEBOUNCE_MS);
  }, [commit]);
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit(draft);
    if (e.key === 'Escape') { setDraft(''); commit(''); }
  };

  const mode: LbMode = multi ? view.mode : 'single';
  const key = `${view.venues.join(',')}|${view.side}|${mode}|${view.window}|${minTrades}`;
  const query = lbQuery(view, minTrades);
  const path = vsPaths.leaderboard(query);
  const [keptTick, setKeptTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const kept = useMemo(() => peekJson<Page>(path), [path, keptTick]);
  const keptShown = useRef(false);
  const { data, error, loading, refresh } = useAsync<Loaded>(
    () => {
      const read = () => vsApi.leaderboard(query).then(
        (res): Loaded => ({ ok: true, key, res }),
        (e: unknown): Loaded => {
          if (e instanceof VsError) return { ok: false, key, code: e.code, message: e.message };
          throw e;
        },
      );
      return keptShown.current ? revalidating(read) : read();
    },
    [key],
    { pollMs: 15_000 },
  );
  const fresh = data?.ok && data.key === key ? data.res : null;
  const held = !fresh && !(data && data.key === key) && kept ? kept : null;
  keptShown.current = !!held;
  const page = fresh ?? held?.body ?? null;
  useEffect(() => {
    if (!held) return;
    const t = window.setTimeout(() => setKeptTick((n) => n + 1), Math.max(0, held.until - Date.now()));
    return () => window.clearTimeout(t);
  }, [held]);
  const missing = !!fresh && needsCurves(fresh.rows);
  const { data: curves } = useAsync<Loaded | null>(
    () => vsApi.leaderboard({ ...query, curves: 1 }).then((res): Loaded => ({ ok: true, key, res }), () => null),
    [key],
    { enabled: missing },
  );
  useOtherWindows(view, minTrades, !!fresh);

  const failure = data && !data.ok && data.key === key && data.code !== 'not_available' ? data.message : null;
  useLoadFailedToast(failure ?? error, 'Leaderboard', refresh);
  const curveRows = fresh && curves?.ok && curves.key === key ? curves.res.rows : undefined;
  const rows = useMemo(() => (page ? withCurves(page.rows, curveRows) : null), [page, curveRows]);

  return {
    view, update, setVenues, multi, mode, minTrades, setMinTrades, draft, onSearch, onSearchKey,
    page, rows, heldAt: held?.at ?? null, loading,
    failed: !!(failure || error),
    unavailable: data?.ok === false && data.key === key && data.code === 'not_available',
    refresh, key,
  };
}
