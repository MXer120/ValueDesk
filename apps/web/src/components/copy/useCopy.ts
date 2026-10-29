/**
 * Everything the Copy page's panels read, in one context object.
 *
 * Same seam as usePortfolioContext / usePointsContext: the page and its
 * panels render as pure functions of this object, and all fetching and state
 * lives here (the trader grid's boards are Discover.tsx's own). The trader
 * data is /api/vs/* public reads; live copying is copy/live.ts, where every
 * change is the follower's own signature.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStored } from '../../hooks';
import { logLoadFailure, useLoadFailedToast } from '../LoadFailed';
import {
  vsApi, VsError, type TraderProfile, type Venue, type VsFill, type Window,
} from '../../vsApi';
import type { Eip1193Provider } from '../../wallet';
import { simulate, toSimFills, type Reconstruction, type SimResult } from './sim';
import { checkSettings, type CopySettings } from '@copy-engine';
import { readiness, startCopy as startLiveCopy, useLiveCopy, type CopyModeId, type LiveCopy } from '../../copy/live';
import {
  DEFAULT_SETUP, COPY_BUILDER_TENTHS_BPS, normaliseSetup, parseSetup, readTarget, toCopySettings, windowStart,
  isAddress, type ParsedSetup, type SetupState,
} from './setup';

/**
 * Fills replayed per backtest. An answer shorter than this is the whole window.
 *
 * 5,000 because that is the lower of the two providers' ceilings (SoDEX walks at
 * most 5,000; Hyperliquid reaches its newest 10,000): asking for more than a
 * venue will ever return would make "we got fewer than we asked for" stop
 * meaning "that was everything". Both answer with the NEWEST fills, so a
 * capped answer is still contiguous up to now.
 */
export const FILL_LIMIT = 5_000;

/* ---------------------------------------------------------------- load ----- */

export interface Load<T> {
  data: T | null;
  error: string | null;
  /** 'not_available' when the venue has not implemented this yet. */
  code: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * One request per key, aborted when the key changes.
 *
 * Unlike useAsync this CLEARS the previous answer when the key changes: showing
 * the last trader's fills under the next trader's name, even for the second a
 * request takes, is a wrong number on screen.
 */
function useLoad<T>(key: string | null, fn: (signal: AbortSignal) => Promise<T>): Load<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null; code: string | null; loading: boolean }>(
    { key: null, data: null, error: null, code: null, loading: false },
  );
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (key === null) {
      setState({ key, data: null, error: null, code: null, loading: false });
      return;
    }
    const ctl = new AbortController();
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, data: null, error: null, code: null, loading: true }));
    fnRef.current(ctl.signal).then(
      (data) => { if (!ctl.signal.aborted) setState({ key, data, error: null, code: null, loading: false }); },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        const code = e instanceof VsError ? (e.code ?? null) : null;
        setState({ key, data: null, error: e instanceof Error ? e.message : String(e), code, loading: false });
      },
    );
    return () => ctl.abort();
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    code: current ? state.code : null,
    loading: key !== null && (!current || state.loading),
    reload,
  };
}

/**
 * Upstream failures also go to the toast rail - as the generic "<What> couldn't
 * load." only, the detail goes to the console. "Not implemented yet" is a
 * state, said in the panel.
 */
function useFailureToast(l: Load<unknown>, what: string): void {
  useLoadFailedToast(l.code === 'not_available' ? null : l.error, what, l.reload);
}

/* ------------------------------------------------------------- context ----- */

export interface CopyPageProps {
  address: string | null;
  provider: Eip1193Provider | null;
  onScan: (address: string, venue?: Venue) => void;
}

export interface SimState {
  result: SimResult | null;
  busy: boolean;
  error: string | null;
  /** Fills handed to the engine, and whether FILL_LIMIT cut the window short. */
  fillCount: number;
  truncated: boolean;
  reconstruction: Reconstruction | null;
  /** True when the run went to the worker. */
  inWorker: boolean;
}

export interface CopyContext {
  /** The connected wallet. Copies would belong to it. */
  wallet: string | null;
  venue: Venue;
  setVenue: (v: Venue) => void;
  /** The trader being set up for copying. */
  leader: string | null;
  selectLeader: (address: string | null, venue?: Venue) => void;


  profile: Load<TraderProfile | null>;
  fills: Load<VsFill[]>;
  window: Window;
  setWindow: (w: Window) => void;

  setup: SetupState;
  patchSetup: (p: Partial<SetupState>) => void;
  resetSetup: () => void;
  parsed: ParsedSetup;

  sim: SimState;

  /** Live copying across the three modes (copy/live.ts). */
  live: LiveCopy;
  /** Where a new copy runs. */
  runOn: CopyModeId;
  setRunOn: (m: CopyModeId) => void;
  /** The setup sheet, and what its main button does (start this copy, or just close). */
  setupOpen: boolean;
  setupStarts: boolean;
  openSetup: (start?: boolean) => void;
  closeSetup: () => void;
  /** The form as copy rules for the picked trader, or why it cannot be. */
  copySettings: CopySettings | null;
  copyErrors: string[];
  /** Start copying the picked trader with this setup on `runOn`: true once it runs; false when setup opened instead. */
  startCopy: () => Promise<boolean>;

  onScan: (address: string, venue?: Venue) => void;
}

export function useCopyContext({ address, provider, onScan }: CopyPageProps): CopyContext {
  /* The venue the page opens on is remembered; a ?venue= in the link wins. */
  const [storedVenue, setStoredVenue] = useStored<Venue>('vs.copy.venue', 'hyperliquid');
  const initial = useMemo(() => readTarget(window.location.search, storedVenue), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [venue, setVenueState] = useState<Venue>(initial.venue);
  const [leader, setLeader] = useState<string | null>(initial.address);
  const [win, setWindow] = useStored<Window>('vs.copy.window', '30d');
  const [stored, setStored] = useStored<SetupState>('vs.copy.setup', DEFAULT_SETUP);
  const setup = useMemo(() => normaliseSetup(stored), [stored]);
  const live = useLiveCopy(address, provider);
  // ValueDesk's executor by default (owner, 2026-10-29): a copy runs 24/7 without a tab; the browser and a
  // self-hosted copier stay one click away, and a choice made before is kept. Not set up yet: starting opens
  // the setup at the step that is missing (terms, sign-in, key, fee approval), as the algo ticket does.
  const [runOn, setRunOn] = useStored<CopyModeId>('vs.copy.runOn', 'hosted');
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStarts, setSetupStarts] = useState(false);

  /* The URL is the selection, so a copy setup is a link you can send. */
  const writeUrl = useCallback((a: string | null, v: Venue) => {
    const url = a ? `/copy?address=${a}&venue=${v}` : '/copy';
    if (window.location.pathname + window.location.search !== url) window.history.replaceState(null, '', url);
  }, []);

  useEffect(() => {
    const onPop = () => {
      const t = readTarget(window.location.search, venue);
      setVenueState(t.venue);
      setLeader(t.address);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [venue]);

  const setVenue = useCallback((v: Venue) => {
    setVenueState(v);
    setStoredVenue(v);
    // A trader is an address ON a venue; the same address elsewhere is a different trader.
    setLeader(null);
    writeUrl(null, v);
  }, [setStoredVenue, writeUrl]);

  const selectLeader = useCallback((a: string | null, v?: Venue) => {
    const next = a && isAddress(a) ? a.trim().toLowerCase() : null;
    const nv = v ?? venue;
    if (nv !== venue) { setVenueState(nv); setStoredVenue(nv); }
    setLeader(next);
    writeUrl(next, nv);
  }, [venue, setStoredVenue, writeUrl]);

  const profile = useLoad(leader ? `${venue}|${leader}` : null, (signal) => vsApi.trader(venue, leader!, signal));

  /*
   * ONE FETCH PER TRADER, NOT PER WINDOW.
   *
   * 24H, 7D and 30D are all cut from one 30-day answer: the shorter window's
   * earlier fills become the replay's warm-up (they rebuild the leader's
   * positions and are not copied), so switching windows costs no request. Only
   * "All" asks for more. A fill walk is the most expensive read these venues
   * have, and it shares the 1200-weight budget with the running app.
   *
   * Both edges are ROUNDED to five minutes, because the providers cache fills
   * by (address, from, to, limit) and a `from` that moved with the clock made
   * every page load a fresh walk.
   */
  const fetchWindow: Window = win === 'all' ? 'all' : '30d';
  const fillsKey = leader ? `${venue}|${leader}|${fetchWindow}` : null;
  const now5 = useMemo(() => Math.floor(Date.now() / 300_000) * 300_000, [fillsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const from = windowStart(fetchWindow, now5);
  const startAt = windowStart(win, now5);
  const fills = useLoad(fillsKey, (signal) =>
    vsApi.fills(venue, leader!, { from: from ?? undefined, limit: FILL_LIMIT }, signal));

  useFailureToast(profile, 'Trader profile');
  useFailureToast(fills, 'Fills');

  const patchSetup = useCallback((p: Partial<SetupState>) => setStored({ ...setup, ...p }), [setup, setStored]);
  const resetSetup = useCallback(() => setStored(DEFAULT_SETUP), [setStored]);
  const parsed = useMemo(() => parseSetup(setup), [setup]);

  /* ---- the backtest, recomputed on change, debounced ---- */

  const prepared = useMemo(() => {
    if (!fills.data) return null;
    // Positions are needed to recover each fill's position-before; without
    // them (venue did not answer yet, or at all) the engine rebuilds forward.
    const positions = profile.data ? profile.data.positions : profile.loading ? undefined : null;
    if (positions === undefined) return null;
    return toSimFills(venue, fills.data, { positions });
  }, [fills.data, profile.data, profile.loading, venue]);

  const [sim, setSim] = useState<SimState>({
    result: null, busy: false, error: null, fillCount: 0, truncated: false, reconstruction: null, inWorker: false,
  });
  const runId = useRef(0);

  useEffect(() => {
    if (!prepared || Object.keys(parsed.errors).length) {
      setSim((s) => ({ ...s, result: null, busy: false, error: null }));
      return;
    }
    const id = ++runId.current;
    const truncated = (fills.data?.length ?? 0) >= FILL_LIMIT;
    // A capped answer starts where its fills start: a window edge older than the
    // oldest fill we hold would claim a quiet stretch we never saw.
    const oldest = prepared.fills.reduce((m, f) => (f.time < m ? f.time : m), Number.POSITIVE_INFINITY);
    const clipped = truncated && (startAt === null || startAt < oldest);
    const start = startAt === null || clipped ? undefined : startAt;
    setSim((s) => ({ ...s, busy: true, error: null }));
    const p = profile.data;
    const timer = window.setTimeout(() => {
      try {
        const out = simulate(prepared.fills, parsed.config, {
          leader: leader ? { venue, address: leader } : undefined,
          startAt: start,
          leaderEquity: p?.summary.accountValue ?? undefined,
          leaderEquitySeries: p?.equity[win] ?? p?.equity.all ?? undefined,
          fixedNotionalUsd: parsed.fixedNotionalUsd,
          builderFeeTenthsBps: COPY_BUILDER_TENTHS_BPS,
          builderFeeOnReduce: true,
        });
        const inWorker = out instanceof Promise;
        const done = (result: SimResult) => {
          if (runId.current !== id) return;
          setSim({
            result, busy: false, error: null, fillCount: prepared.fills.length, truncated: clipped,
            reconstruction: prepared.reconstruction, inWorker,
          });
        };
        const fail = (e: unknown) => {
          if (runId.current !== id) return;
          logLoadFailure('Backtest', e);
          setSim((s) => ({ ...s, result: null, busy: false, error: e instanceof Error ? e.message : String(e) }));
        };
        if (inWorker) out.then(done, fail);
        else done(out);
      } catch (e) {
        if (runId.current === id) logLoadFailure('Backtest', e);
        if (runId.current === id) setSim((s) => ({ ...s, result: null, busy: false, error: e instanceof Error ? e.message : String(e) }));
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [prepared, parsed, leader, venue, win, startAt, profile.data, fills.data]);

  const copyCheck = useMemo(() => {
    if (!leader || (venue !== 'sodex' && venue !== 'hyperliquid')) return { settings: null as CopySettings | null, errors: leader ? ['Copies follow SoDEX and Hyperliquid traders only.'] : [] };
    if (Object.keys(parsed.errors).length) return { settings: null, errors: Object.values(parsed.errors) as string[] };
    const r = checkSettings(toCopySettings(parsed, setup, { venue, address: leader }));
    return { settings: r.settings, errors: Object.values(r.errors) as string[] };
  }, [leader, venue, parsed, setup]);

  const openSetup = useCallback((start = false) => { setSetupStarts(start); setSetupOpen(true); }, []);
  const closeSetup = useCallback(() => setSetupOpen(false), []);
  const startCopy = useCallback(async () => {
    const settings = copyCheck.settings;
    if (!settings) throw new Error(copyCheck.errors[0] ?? 'Pick a trader first.');
    const r = readiness(live, runOn);
    const ok = settings.paper ? r.terms && r.connected : r.ready;
    if (!ok) { openSetup(true); return false; }
    await startLiveCopy(runOn, settings);
    return true;
  }, [copyCheck, live, runOn, openSetup]);

  return {
    wallet: address,
    venue,
    setVenue,
    leader,
    selectLeader,
    profile,
    fills,
    window: win,
    setWindow,
    setup,
    patchSetup,
    resetSetup,
    parsed,
    sim,
    live,
    runOn,
    setRunOn,
    setupOpen,
    setupStarts,
    openSetup,
    closeSetup,
    copySettings: copyCheck.settings,
    copyErrors: copyCheck.errors,
    startCopy,
    onScan,
  };
}
