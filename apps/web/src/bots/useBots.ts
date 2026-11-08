/**
 * The wallet's bots on the ValueDesk executor (hosted, 24/7): its algos whose spec is a bot (spec.bot), read
 * every 5 s while the page is shown, and one bot's log on demand. Starting, stopping and changing one is one
 * wallet signature each (algo/executorAlgos.ts); the executor's answer replaces the row at once.
 *
 * Bots run on the hosted executor only: a bot quotes around the clock, and a browser tab is not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FINAL_STATUSES, type AlgoEvent, type AlgoUpdatePatch, type AlgoView } from '@copy-engine';
import { actOn, eventsOn, listBotsOn, startOn, updateOn, viewOn } from '../algo/executorAlgos';
import { pollEvery } from '../exchange/visibility';
import { newSeed } from '@copy-engine';
import { keepSeries } from './fleet';

export const BOTS_POLL_MS = 5_000;
/** The bot on screen is read this often (one bot, no series: about 2 KB). */
export const BOT_LIVE_MS = 1_000;
/**
 * The figures every read, each bot's series (up to 1,500 points, 6 MB a read at 100 bots) once a minute: the
 * series samples every 5 minutes, and its newest point is drawn from the figures anyway (fleet.ts, BotSheet.tsx).
 */
export const BOTS_SERIES_MS = 60_000;

export interface BotsState {
  bots: AlgoView[];
  /** The first read is still out. */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: (spec: Record<string, unknown>, restart?: { from: string; how: 'clean' | 'takeover' }) => Promise<AlgoView>;
  act: (op: 'pause' | 'resume' | 'cancel' | 'archive', id: string, o?: { now?: boolean }) => Promise<void>;
  stopAll: () => Promise<void>;
  update: (id: string, patch: AlgoUpdatePatch) => Promise<void>;
  /** The bot whose page is open (read every second), or null. */
  focus: (id: string | null) => void;
}

/** Running first (newest first), then ended (newest first). */
export function sortBots(list: AlgoView[]): AlgoView[] {
  return [...list].sort((a, b) => Number(FINAL_STATUSES.has(a.algo.status)) - Number(FINAL_STATUSES.has(b.algo.status)) || b.algo.createdAt - a.algo.createdAt);
}

export function useBots(owner: string | null, signedIn: boolean): BotsState {
  const [bots, setBots] = useState<AlgoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  /** The list on screen, and when a read last brought the series. */
  const shown = useRef<AlgoView[]>([]);
  const seriesAt = useRef(0);
  const show = useCallback((list: AlgoView[]) => {
    shown.current = list;
    setBots(list);
  }, []);

  const refresh = useCallback(async () => {
    if (!owner || !signedIn) {
      seriesAt.current = 0;
      show([]);
      setLoading(false);
      return;
    }
    try {
      const askedAt = Date.now();
      const whole = askedAt - seriesAt.current >= BOTS_SERIES_MS;
      const read = await listBotsOn('hosted', whole);
      if (!alive.current) return;
      const list = read.algos.filter((v) => v.algo.spec.bot === true);
      if (!read.noSeries) seriesAt.current = askedAt;
      const next = read.noSeries ? keepSeries(list, shown.current) : list;
      if (next) show(sortBots(next));
      // A bot this page has no series for: read them all now rather than show it without.
      else {
        seriesAt.current = 0;
        void refreshRef.current();
      }
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [owner, signedIn, show]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void refresh();
    const stop = pollEvery(BOTS_POLL_MS, () => void refresh());
    return () => {
      alive.current = false;
      stop();
    };
  }, [refresh]);

  /** The executor's answer for these bots, in place. */
  const merge = useCallback((views: AlgoView[]) => {
    const byId = new Map(shown.current.map((v) => [v.algo.id, v]));
    for (const v of views) byId.set(v.algo.id, v);
    show(sortBots([...byId.values()].filter((v) => !v.algo.k.archived)));
  }, [show]);

  const start = useCallback(async (spec: Record<string, unknown>, restart?: { from: string; how: 'clean' | 'takeover' }) => {
    const v = await startOn('hosted', spec, newSeed(), restart);
    merge([v]);
    // A restart stopped the old bot too: read the list again for its new state.
    if (restart) void refresh();
    return v;
  }, [merge, refresh]);
  const act = useCallback(async (op: 'pause' | 'resume' | 'cancel' | 'archive', id: string, o: { now?: boolean } = {}) => merge(await actOn('hosted', op, id, o)), [merge]);
  const stopAll = useCallback(async () => merge(await actOn('hosted', 'cancel-all')), [merge]);
  const update = useCallback(async (id: string, patch: AlgoUpdatePatch) => merge(await updateOn('hosted', id, patch)), [merge]);

  // The bot on screen: read alone every second (owner 2026-11-08: orders, trades and PnL in real time), its series
  // kept from the last full read; the list goes on every few seconds.
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || !owner || !signedIn) return;
    let live = true;
    const read = () => void viewOn('hosted', focus).then((v) => {
      if (!live || !v) return;
      const had = shown.current.find((x) => x.algo.id === v.algo.id);
      const series = had?.algo.book?.series;
      merge([series && v.algo.book ? { ...v, algo: { ...v.algo, book: { ...v.algo.book, series } } } : v]);
    }).catch(() => undefined);
    const stop = pollEvery(BOT_LIVE_MS, read);
    return () => { live = false; stop(); };
  }, [focus, owner, signedIn, merge]);

  return { bots, loading, error, refresh, start, act, stopAll, update, focus: setFocus };
}

/** One bot's log, newest first, read while `open` (every 10 s). */
export function useBotEvents(id: string | null, open: boolean): { events: AlgoEvent[] | null; error: string | null } {
  const [events, setEvents] = useState<AlgoEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !open) return;
    let live = true;
    setEvents(null);
    const read = () =>
      eventsOn('hosted', id, 300)
        .then((e) => {
          if (!live) return;
          setEvents([...e].sort((a, b) => b.at - a.at));
          setError(null);
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    void read();
    const stop = pollEvery(10_000, () => void read());
    return () => {
      live = false;
      stop();
    };
  }, [id, open]);
  return { events, error };
}

/** A page of a bot's log, and how often the live tail asks for what is new (an empty answer when nothing is). */
export const LOG_PAGE = 40;
export const LOG_TAIL_MS = 2_000;

/**
 * A bot's log for its Activity and Trades tabs (owner 2026-11-08: scrollable, more on scroll, real time, little
 * traffic): the newest page first, then only what is new every two seconds (`after`), older pages as the list is
 * scrolled to its end (`before`). Newest first.
 */
export function useBotLog(id: string | null, open: boolean): { events: AlgoEvent[] | null; error: string | null; more: boolean; loading: boolean; loadMore: () => void } {
  const [events, setEvents] = useState<AlgoEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const list = useRef<AlgoEvent[]>([]);
  const put = useCallback((xs: AlgoEvent[]) => {
    const byId = new Map(xs.map((e) => [e.id, e]));
    list.current = [...byId.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    setEvents(list.current);
  }, []);
  useEffect(() => {
    if (!id || !open) return;
    let live = true;
    list.current = [];
    setEvents(null);
    setMore(true);
    void eventsOn('hosted', id, LOG_PAGE)
      .then((e) => { if (live) { put(e); setMore(e.length >= LOG_PAGE); setError(null); } })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    const stop = pollEvery(LOG_TAIL_MS, () => {
      const newest = list.current[0]?.at;
      if (newest === undefined) return;
      void eventsOn('hosted', id, 50, { after: newest }).then((e) => { if (live && e.length) put([...e, ...list.current]); }).catch(() => undefined);
    });
    return () => { live = false; stop(); };
  }, [id, open, put]);
  const loadMore = useCallback(() => {
    const oldest = list.current[list.current.length - 1]?.at;
    if (!id || oldest === undefined || loading || !more) return;
    setLoading(true);
    void eventsOn('hosted', id, LOG_PAGE, { before: oldest })
      .then((e) => { put([...list.current, ...e]); setMore(e.length >= LOG_PAGE); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id, loading, more, put]);
  return { events, error, more, loading, loadMore };
}
