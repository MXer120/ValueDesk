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
import { keepActed, keepSeries, mergeLog } from './fleet';

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
  /** `terms: false`: a change that only serves a stop (it never waits for the terms). */
  update: (id: string, patch: AlgoUpdatePatch, o?: { terms?: boolean }) => Promise<void>;
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
  /**
   * Which wallet's reads count: bumped on every wallet or sign-in change, so a read still out for the old wallet
   * never lands on the new one (one counter for every read here, not a flag the next effect turns back on).
   */
  const gen = useRef(0);
  /** The list on screen, and when a read last brought the series. */
  const shown = useRef<AlgoView[]>([]);
  const seriesAt = useRef(0);
  /** When this page last acted on each bot: reads sent before it are not let undo it on screen (keepActed). */
  const actedAt = useRef(new Map<string, number>());
  const show = useCallback((list: AlgoView[]) => {
    shown.current = list;
    setBots(list);
  }, []);

  // Another wallet (or signed out): its list goes at once, nothing of the last wallet's stays on screen.
  useEffect(() => {
    gen.current++;
    seriesAt.current = 0;
    actedAt.current = new Map();
    show([]);
    setError(null);
  }, [owner, signedIn, show]);

  const refresh = useCallback(async () => {
    const g = gen.current;
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
      if (g !== gen.current) return;
      const list = keepActed(read.algos.filter((v) => v.algo.spec.bot === true), shown.current, askedAt, actedAt.current);
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
      if (g === gen.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, [owner, signedIn, show]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    setLoading(true);
    void refresh();
    const stop = pollEvery(BOTS_POLL_MS, () => void refresh());
    return () => {
      gen.current++;
      stop();
    };
  }, [refresh]);

  /** The executor's answer for these bots, in place (dropped when the wallet changed while it was out). */
  const merge = useCallback((views: AlgoView[], g: number) => {
    if (g !== gen.current) return;
    const byId = new Map(shown.current.map((v) => [v.algo.id, v]));
    for (const v of views) byId.set(v.algo.id, v);
    show(sortBots([...byId.values()].filter((v) => !v.algo.k.archived)));
  }, [show]);
  /** An action on these bots: stamped before it is sent and again when its answer is on screen. */
  const acting = useCallback(async (ids: string[], send: () => Promise<AlgoView[]>) => {
    const g = gen.current;
    const stamp = () => { const t = Date.now(); for (const id of ids) actedAt.current.set(id, t); };
    stamp();
    const views = await send();
    merge(views, g);
    stamp();
  }, [merge]);

  const start = useCallback(async (spec: Record<string, unknown>, restart?: { from: string; how: 'clean' | 'takeover' }) => {
    const g = gen.current;
    const v = await startOn('hosted', spec, newSeed(), restart);
    merge([v], g);
    // A restart stopped the old bot too: read the list again for its new state.
    if (restart) void refresh();
    return v;
  }, [merge, refresh]);
  const act = useCallback((op: 'pause' | 'resume' | 'cancel' | 'archive', id: string, o: { now?: boolean } = {}) => acting([id], () => actOn('hosted', op, id, o)), [acting]);
  const stopAll = useCallback(() => acting(shown.current.filter((v) => !FINAL_STATUSES.has(v.algo.status)).map((v) => v.algo.id), () => actOn('hosted', 'cancel-all')), [acting]);
  const update = useCallback((id: string, patch: AlgoUpdatePatch, o: { terms?: boolean } = {}) => acting([id], () => updateOn('hosted', id, patch, o)), [acting]);

  // The bot on screen: read alone every second (owner 2026-11-08: orders, trades and PnL in real time), its series
  // kept from the last full read; the list goes on every few seconds.
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || !owner || !signedIn) return;
    let live = true;
    const g = gen.current;
    const read = () => {
      const askedAt = Date.now();
      void viewOn('hosted', focus).then((v) => {
        if (!live || !v) return;
        const at = actedAt.current.get(v.algo.id);
        if (at !== undefined && at >= askedAt) return;
        const had = shown.current.find((x) => x.algo.id === v.algo.id);
        const series = had?.algo.book?.series;
        merge([series && v.algo.book ? { ...v, algo: { ...v.algo, book: { ...v.algo.book, series } } } : v], g);
      }).catch(() => undefined);
    };
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
/** The tail's page; a full one means more may be waiting behind it, read before the next tick. */
const LOG_TAIL = 50;

/**
 * A bot's log for its Activity and Trades tabs (owner 2026-11-08: scrollable, more on scroll, real time, little
 * traffic): the newest page first, then only what is new every two seconds, older pages as the list is scrolled to
 * its end. Newest first. The executor's `after`/`before` are strict, so each read asks from the edge's own
 * millisecond (at or after, at or before) and lines are kept by id: two lines in one millisecond are never lost.
 * A tail page that comes back full is followed by the next one down until a page is not full (a hidden tab or a
 * burst never leaves a gap); a first page that failed or came back empty is asked again on the next tick.
 */
export function useBotLog(id: string | null, open: boolean): { events: AlgoEvent[] | null; error: string | null; more: boolean; loading: boolean; loadMore: () => void } {
  const [events, setEvents] = useState<AlgoEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const list = useRef<AlgoEvent[]>([]);
  /** The bot whose log is on screen: an answer for another one is dropped. */
  const current = useRef<string | null>(null);
  const put = useCallback((pages: AlgoEvent[][]) => {
    const r = mergeLog(list.current, pages);
    list.current = r.list;
    setEvents(r.list);
    if (r.cut) setMore(true);
    return r;
  }, []);
  useEffect(() => {
    if (!id || !open) return;
    let live = true;
    current.current = id;
    list.current = [];
    setEvents(null);
    setMore(true);
    setError(null);
    let first = false;
    let busy = false;
    const readFirst = async () => {
      const e = await eventsOn('hosted', id, LOG_PAGE);
      if (!live) return;
      first = true;
      put([e]);
      setMore(e.length >= LOG_PAGE);
      setError(null);
    };
    const tail = async () => {
      const newest = list.current[0]?.at;
      if (newest === undefined) { await readFirst(); return; }
      const pages: AlgoEvent[][] = [];
      let before: number | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await eventsOn('hosted', id, LOG_TAIL, before === undefined ? { after: newest - 1 } : { after: newest - 1, before });
        if (!live) return;
        pages.push(page);
        if (page.length < LOG_TAIL) break;
        const low = Math.min(...page.map((e) => e.at));
        // A full page of one millisecond cannot be paged by time: what it read is kept, the rest comes next tick.
        if (before !== undefined && low + 1 >= before) break;
        before = low + 1;
      }
      put(pages);
    };
    const tick = () => {
      if (busy) return;
      busy = true;
      void (first ? tail() : readFirst())
        .catch((e) => { if (live && !first) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { busy = false; });
    };
    tick();
    const stop = pollEvery(LOG_TAIL_MS, tick);
    return () => { live = false; stop(); if (current.current === id) current.current = null; };
  }, [id, open, put]);
  const loadMore = useCallback(() => {
    const oldest = list.current[list.current.length - 1]?.at;
    if (!id || current.current !== id || oldest === undefined || loading || !more) return;
    setLoading(true);
    const page = (before: number) => eventsOn('hosted', id, LOG_PAGE, { before });
    void (async () => {
      let e = await page(oldest + 1);
      if (current.current !== id) return;
      let r = put([e]);
      // Every line of a full page was one already held (one millisecond full of lines): step past that millisecond.
      if (!r.added && e.length >= LOG_PAGE) {
        e = await page(oldest);
        if (current.current !== id) return;
        r = put([e]);
      }
      setMore(e.length >= LOG_PAGE || r.cut);
    })()
      .catch((e) => { if (current.current === id) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setLoading(false));
  }, [id, loading, more, put]);
  return { events, error, more, loading, loadMore };
}
