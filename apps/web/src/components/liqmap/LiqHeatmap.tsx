/**
 * The liquidation heatmap widget: where the positions of the market on screen
 * get liquidated, across the venues picked (all by default).
 *
 *   Live        notional per price bucket - longs (red) below the price, shorts
 *               (green) above - with the cumulative curves on a second axis.
 *   Chart       the same levels as horizontal bars beside the market's candles, on the
 *               app's own chart (ChartPanel): it zooms, scrolls and scales as the trade chart.
 *   Historical  the levels over time, from the indexer's 15-minute snapshots, on that chart;
 *               finer than they keep (BTC $10, $1), from their fine layers near the price.
 *
 * A bar opens its wallets (address, size @ liquidation price, USD, distance).
 * The strip at the bottom says how much of each venue's open interest the books
 * hold and how well the math has matched the venue's own liquidation prices
 * (server indexer/liqRead.ts) - the heatmap is only as complete as that.
 *
 * Resolution (owner 2026-10-31, chart/liqSteps.ts): per coin, Auto (Fine / Medium / Coarse) or a
 * fixed step in the coin's price units down to its SoDEX tick - BTC $100 by default, $10, $1. A
 * whole number of the stream's 0.02% buckets is the stream summed; finer comes from the API's
 * fine layer the stream carries for the window on screen (liveHeat.ts), a second apart like the
 * buckets. Auto picks the step from the zoom: about PX_PER_CELL pixels a cell (Fine / Medium / Coarse).
 *
 * View (owner 2026-10-31) colours every view by side or by leverage band and shows only
 * the bands picked (chart/liqLev.ts); the historical view can lay the levels now over its
 * right edge on the same price axis. Bars and cells scale to robustMax, so one giant level
 * is drawn at full (a tick marks it, the tooltip has its figure) and the rest stay readable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { LiqAt, LiqHeatmap as HeatApi, LiqHistoryFine, LiqWallets } from '@sign/indexer/liqRead.js';
import type { Engine } from '../../api';
import { useStored, useSymbols } from '../../hooks';
import { SCAN_VENUES, VENUE_LABEL, vsApi, type Venue } from '../../vsApi';
import { PlatformSelect } from '../PlatformSelect';
import { VenueLogo } from '../VenueLogo';
import { fmtPx, fmtUsdShort } from '../explore/model';
import { usePolled } from '../explore/cohorts/parts';
import { useLiveHeat, type FineSub } from './liveHeat';
import { useHistTiles } from './histTiles';
import { WalletView, type Res, type Side, type StepsView, type Unit, type ViewChange } from './WalletView';
import { Chart } from '../Chart';
import type { Chart as KChart } from 'klinecharts';
import { CANDLE_PANE_ID } from '../../chart/theme';
import { HEAT_FLOOR, LIQ_HEAT, barMsOf, boxed, cellAt, cellOf, heatScale, liqHeatTemplate, profileWidth, refStep, snapRowsOf, snapshotFor, stepNorm, stripWidth, type HeatData, type HeatPoint } from '../../chart/liqHeatIndicator';
import { autoStep, fineWindow, niceUp, stepAt, stepLabel, stepLadder, streamAsk, streamGroup, streamSteps, tickOf, type StepLevel } from '../../chart/liqSteps';
import { coinOfSymbol, groupFor, mapData, type LiqMapData } from '../../chart/liqMap';
import {
  LEV_BANDS, LEV_COLOR, LEV_LABEL, addBands, isAllLev, levBandOf, levFilterOf, levelWindow, robustMax, shownBands, shownTotal, sideBands,
  type Bands, type ColorBy, type LevBand, type LevFilter, type LevKey,
} from '../../chart/liqLev';
import { shortAddr } from '../../format';
import { asOfText } from '../../asOf';
import { coverageText } from './coverageText';
import { fmtFixed, fmtNum } from '../../numStyle';
import './LiqHeatmap.css';

type View = 'live' | 'chart' | 'history';

interface Prefs {
  view: View;
  res: Res;
  unit: Unit;
  venues: Venue[];
  /** Only these wallets (none: every wallet), and which side - every view (WalletView.tsx). */
  wallets: string[];
  side: Side;
  /** Colours by side or by leverage band, and the bands shown - every view. */
  colorBy: ColorBy;
  lev: LevBand[];
  /** The historical view: the levels now laid over its right edge. */
  strip: boolean;
  /** The resolution per coin (liqSteps.ts): Auto or a place on the coin's ladder; a coin not here has the default. */
  steps: Record<string, StepLevel>;
}
const DEFAULTS: Prefs = { view: 'live', res: 'fine', unit: 'usd', venues: [...SCAN_VENUES], wallets: [], side: 'both', colorBy: 'side', lev: [...LEV_BANDS], strip: false, steps: {} };
/** Exact steps from the fine route (some wallets, or past the stream's fine layer) are read this often: as the wallet filter's levels. */
const FINE_POLL_MS = 10_000;
/** Auto's cell height (or width, in Live): about this many pixels, by Fine / Medium / Coarse. */
const PX_PER_CELL: Record<Res, number> = { fine: 3, medium: 6, coarse: 12 };
/** A view narrower than this (not laid out yet) picks no step. */
const MIN_PX = 40;

export { coinOfSymbol };

/**
 * [low price, long USD, short USD, long size, short size, long n, short n, then both sides' USD
 * by leverage band: low, mid, high, unknown] - as shown: side and leverage filter applied.
 */
type Bucket = [number, number, number, number, number, number, number, number, number, number, number];
type Heat = Omit<HeatApi, 'buckets'> & { buckets: Bucket[] };
const ZERO: Bands = [0, 0, 0, 0];

/**
 * The API's rows (server levels.ts LiqRow: [index, long USD, short USD, long n, short n, ...USD
 * per band]) as buckets; sizes are USD over the bucket's middle (0.02% buckets). Only the side and
 * the leverage bands shown are kept (liqLev.ts shownTotal: every band on keeps the whole side).
 */
function fromApi(a: HeatApi, side: Side = 'both', lev: LevFilter = LEV_BANDS): Heat {
  const p = a.price;
  const buckets: Bucket[] = [];
  for (const r of a.buckets) {
    const [i, l0, s0, ln0, sn0] = r;
    const lo = +(i * a.step).toPrecision(12);
    // A level the price has already crossed (a long priced above it, a short below) is past, not a level.
    const pastL = p !== null && lo >= p;
    const pastS = p !== null && lo + a.step <= p;
    const useL = !pastL && side !== 'short' && l0 > 0;
    const useS = !pastS && side !== 'long' && s0 > 0;
    const lb = useL ? sideBands(l0, r, 5) : ZERO;
    const sb = useS ? sideBands(s0, r, 8) : ZERO;
    const l = useL ? shownTotal(l0, lb, lev) : 0;
    const sh = useS ? shownTotal(s0, sb, lev) : 0;
    if (!l && !sh) continue;
    const mid = lo + a.step / 2;
    const b = addBands(shownBands(lb, lev), shownBands(sb, lev));
    buckets.push([lo, l, sh, l / mid, sh / mid, useL ? ln0 : 0, useS ? sn0 : 0, b[0], b[1], b[2], b[3]]);
  }
  return { ...a, buckets };
}
/** One bucket's figure in the unit shown: [long, short]. */
const valOf = (b: Bucket, unit: Unit): [number, number] => (unit === 'usd' ? [b[1], b[2]] : [b[3], b[4]]);
/** One bucket's figure by band in the unit shown ([low, mid, high, unknown]; in the coin, by the bucket's own USD per coin). */
function bandsOf(b: Bucket, unit: Unit): Bands {
  const usd: Bands = [b[7], b[8], b[9], b[10]];
  if (unit === 'usd') return usd;
  const f = b[1] + b[2] > 0 ? (b[3] + b[4]) / (b[1] + b[2]) : 0;
  return [usd[0] * f, usd[1] * f, usd[2] * f, usd[3] * f];
}
const LEV_KEYS: readonly LevKey[] = ['low', 'mid', 'high', 'unknown'];
/** The band colours as CSS variables (LiqHeatmap.css .lqm-bar-lev), from the one list the canvas layers use too. */
const LEV_VARS = Object.fromEntries(LEV_KEYS.map((k) => [`--lqm-lev-${k}`, LEV_COLOR[k]])) as CSSProperties;
/** A bar's length by colour mode: by side the larger side (they overlap), by leverage both sides stacked. */
const barOf = (b: Bucket, unit: Unit, colorBy: ColorBy) => {
  const [l, s] = valOf(b, unit);
  return colorBy === 'lev' ? l + s : Math.max(l, s);
};

const fmtSize = (v: number) => (Math.abs(v) >= 1e6 ? `${fmtFixed(v / 1e6, 2)}M` : Math.abs(v) >= 1e4 ? `${fmtFixed(v / 1e3, 1)}K` : fmtNum(v, { maximumSignificantDigits: 5 }));
const fmtVal = (v: number, unit: Unit, coin: string) => (unit === 'usd' ? fmtUsdShort(v) : `${fmtSize(v)} ${coin}`);
const pct = (v: number | null, signed = true) => (v === null || !Number.isFinite(v) ? '–' : `${signed && v > 0 ? '+' : ''}${fmtFixed(v * 100, 1)}%`);

/** The element's size, kept current. */
function useSize<T extends HTMLElement>(): [(el: T | null) => void, { w: number; h: number }] {
  // A callback ref: the element can mount after the first render (the history view waits for its data).
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: Math.floor(r.width), h: Math.floor(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

/** Round axis ticks across [lo, hi]. */
function ticks(lo: number, hi: number, n: number): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const e = 10 ** Math.floor(Math.log10(raw));
  const f = raw / e;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) out.push(+v.toPrecision(12));
  return out;
}

/** The price window the levels fill, with the price inside and a margin (liqLev.ts levelWindow, as the historical view's axis). */
function windowOf(h: Heat): [number, number] | null {
  const p = h.price;
  if (!p) return null;
  return levelWindow(h.buckets.map((b) => [b[0], b[1] + b[2]] as const), h.step, p);
}

/** Long cumulative: everything liquidated as the price falls to each bucket; short likewise as it rises. */
function cumulative(h: Heat, unit: Unit): { long: Array<[number, number]>; short: Array<[number, number]> } {
  const p = h.price ?? 0;
  const long: Array<[number, number]> = [];
  const short: Array<[number, number]> = [];
  let acc = 0;
  for (let i = h.buckets.length - 1; i >= 0; i--) {
    const b = h.buckets[i]!;
    if (b[0] + h.step > p) continue;
    acc += valOf(b, unit)[0];
    long.push([b[0], acc]);
  }
  acc = 0;
  for (const b of h.buckets) {
    if (b[0] < p) continue;
    acc += valOf(b, unit)[1];
    short.push([b[0] + h.step, acc]);
  }
  return { long, short };
}

/**
 * What the cumulative curves are summed from: the fine answer when its window holds the price (every
 * level between the price and the screen's edges is in it, at its exact step), else the stream - at
 * $1 bars the stream's $20 curve read as stairs beside them.
 */
function cumSrc(base: Heat, fine: Heat | null): Heat {
  const w = fine as (Heat & { from?: number; to?: number }) | null;
  return w?.price && w.from !== undefined && w.to !== undefined && w.from <= w.price && w.price < w.to ? w : base;
}

/** A picked cell: its price range and side - and, in the historical view, the snapshot's time it is of. */
interface Pick { from: number; to: number; side: 'long' | 'short'; at?: number }

/** Buckets summed `k` server buckets at a time. */
export function regroup(h: Heat, k: number): Heat {
  if (k <= 1) return h;
  const step = +(h.step * k).toPrecision(12);
  const by = new Map<number, Bucket>();
  for (const b of h.buckets) {
    const i = Math.floor(b[0] / step + 1e-9);
    let x = by.get(i);
    if (!x) { x = [+(i * step).toPrecision(12), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; by.set(i, x); }
    for (let j = 1; j < 11; j++) x[j] = x[j]! + b[j]!;
  }
  return { ...h, step, buckets: [...by.values()].sort((a, b) => a[0] - b[0]) };
}

export function LiqHeatmap({ symbol, engine, instance, address = null }: { symbol: string; engine: Engine; instance?: string; address?: string | null }) {
  const [stored, setStored] = useStored<Prefs>(`vs.liqmap${instance ? `.${instance}` : ''}`, DEFAULTS);
  const prefs: Prefs = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  const venues = (Array.isArray(prefs.venues) ? prefs.venues : []).filter((v): v is Venue => (SCAN_VENUES as readonly string[]).includes(v));
  const chosen = venues.length ? venues : [...SCAN_VENUES];
  const set = (p: Partial<Prefs>) => setStored({ ...prefs, ...p });
  const wallets = (Array.isArray(prefs.wallets) ? prefs.wallets : []).filter((w): w is string => typeof w === 'string' && /^0x[0-9a-f]{40}$/.test(w)).slice(0, 10);
  const side: Side = prefs.side === 'long' || prefs.side === 'short' ? prefs.side : 'both';
  const colorBy: ColorBy = prefs.colorBy === 'lev' ? 'lev' : 'side';
  const lev = levFilterOf(prefs.lev);
  const levKey = lev.join(',');
  const wkey = wallets.join(',');
  const coin = coinOfSymbol(symbol);
  const [pick, setPick] = useState<Pick | null>(null);
  useEffect(() => setPick(null), [coin, chosen.join(','), prefs.res, wkey, prefs.view, levKey]);
  // The price window the view shows and the pixels it spans (it reports them): what Auto picks the
  // step for and what exact steps are read for; and the historical view's time window.
  // Kept with the coin and view they were reported for, not reset when those change: a view reports
  // as it mounts (a child's effect runs before this one's), and the live view only again once its
  // window moves - a reset after it left the step picked undrawn (owner 2026-11-01: "sometimes still
  // switching to $100").
  const winKey = `${coin}|${prefs.view}`;
  const [winAt, setWinAt] = useState<{ k: string; w: [number, number, number] } | null>(null);
  const [timesAt, setTimesAt] = useState<{ k: string; w: [number, number] } | null>(null);
  const win = winAt && winAt.k === winKey ? winAt.w : null;
  const times = timesAt && timesAt.k === winKey ? timesAt.w : null;
  const onWindow = useCallback((lo: number, hi: number, px: number) => setWinAt((x) => (x && x.k === winKey && x.w[0] === lo && x.w[1] === hi && x.w[2] === px ? x : { k: winKey, w: [lo, hi, px] })), [winKey]);
  const onTimes = useCallback((a: number, b: number) => setTimesAt((x) => (x && x.k === winKey && x.w[0] === a && x.w[1] === b ? x : { k: winKey, w: [a, b] })), [winKey]);
  const { symbols } = useSymbols('perps');

  const vkey = chosen.join(',');
  // The historical view's snapshots (30 days): every snapshot's time, price and step and the colour
  // scales, and the rows of the time and price window on screen and around it, in tiles (histTiles.ts;
  // the wallet filter in one piece). Its newest: width and price (the resolution's ladder there).
  const histOn = prefs.view === 'history';
  const hist = useHistTiles(histOn ? coin : null, chosen, win && times ? { t0: times[0], t1: times[1], lo: win[0], hi: win[1] } : null, wallets);
  const coarsePts = histOn ? hist.points : EMPTY_POINTS;
  const newest = histOn ? hist.list.at(-1) : undefined;
  const histAt = newest ? { st: newest.st, p: newest.p } : null;
  // The historical view's strip of the levels now (its newest column reads them too).
  const strip = histOn && prefs.strip === true;
  // Live over the WebSocket (a second apart); over HTTP, a read a minute, while the socket is down.
  // The stream is summed to the bar width the view draws (in server buckets); the views ask for it as
  // they zoom. A step finer than its buckets streams from its fine layer, for the window on screen
  // (`fineSub`, settled from the render before: it needs the fine layer's step the stream sends).
  const [wantK, setWantK] = useState(5);
  const [fineSub, setFineSub] = useState<FineSub>(null);
  const live = useLiveHeat(coin, chosen, !wallets.length, wantK, wallets.length ? null : fineSub);
  const streamK = live.data ? live.k : 1;
  // Some wallets only: their levels read every 10 s (the stream is every wallet's).
  const heat = usePolled<HeatApi>(
    live.connected && !wallets.length ? null : `${coin}|${vkey}|${wkey}`,
    (s) => vsApi.liquidations(coin, chosen, 'fine', s, wallets),
    wallets.length ? 10_000 : 60_000,
  );
  const apiData = wallets.length ? heat.data : live.data ?? heat.data;
  const raw = useMemo(() => (apiData ? fromApi(apiData, side, lev) : null), [apiData, side, levKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const stripData = useMemo(() => (strip ? mapData(apiData, { side, lev, colorBy }) : null), [strip, apiData, side, levKey, colorBy]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = raw;
  const res: Res = prefs.res === 'medium' || prefs.res === 'coarse' ? prefs.res : 'fine';
  const unit: Unit = prefs.unit === 'coin' ? 'coin' : 'usd';
  // The resolution: the coin's ladder from its price and SoDEX tick, the level kept for it. A panel
  // set to Medium or Coarse before the steps keeps Auto until a step is picked.
  const price = h?.price ?? (histOn ? histAt?.p ?? null : null);
  const ladder = price ? stepLadder(price, tickOf(coin, symbols, price)) : [];
  const initial: StepLevel = res === 'fine' ? 0 : 'auto';
  const kept = prefs.steps && typeof prefs.steps === 'object' ? prefs.steps[coin] : undefined;
  const level: StepLevel = kept === 'auto' || (typeof kept === 'number' && kept >= 0) ? kept : initial;
  const picked = stepAt(level, ladder);
  // The step drawn: the one picked, or Auto's (owner 2026-11-01: "auto is bad as its just the 100
  // steps no matter what"): about PX_PER_CELL of the window's pixels a cell (Fine / Medium / Coarse
  // under it), from the widths the live data holds - the stream's and, near the price, its fine
  // layer's (BTC $1, $2, $5, $10...); in Historical, the snapshot's step or the finer ones of the coin's ladder (kept down to its tick).
  const rawStep = h ? h.step / streamK : 0;
  const fm = live.fineMeta;
  const inReach = !!(fm && win && win[0] >= fm.lo && win[1] <= fm.hi);
  let step: number | null = picked;
  // Only once the view has a size: unmeasured, it spans a pixel and Auto would pick the coarsest width.
  if (level === 'auto' && win && win[2] >= MIN_PX) {
    const target = ((win[1] - win[0]) / win[2]) * PX_PER_CELL[res];
    step = histOn ? (histAt ? autoStep(target, [histAt.st, ...ladder.filter((x) => x < histAt.st * (1 - 1e-9))]) : null)
      : rawStep > 0 ? autoStep(target, streamSteps(rawStep, inReach ? fm!.st : null)) : null;
  }
  // The bar width in server buckets: from the price and Fine / Medium / Coarse until the window is
  // known (groupFor), else the step when it is a whole number of them - told to the stream a quarter
  // second after it settles, drawn at once from what is held meanwhile. A finer step streams from the
  // fine layer for the window on screen, at the step picked however far out (fineWindow); with
  // wallets picked, or beyond the layer's reach, the fine route is read.
  const fineSubOf = (w: { step: number; from: number; to: number }): FineSub => {
    const fk = fm && !wallets.length && live.connected ? streamGroup(w.step, fm.st) : null;
    if (!fk || fk > 1000) return null;
    const from = Math.max(w.from, Math.ceil(fm!.lo / w.step) * w.step);
    const to = Math.min(w.to, Math.floor(fm!.hi / w.step) * w.step);
    return to > from ? { k: fk, from: +from.toPrecision(12), to: +to.toPrecision(12) } : null;
  };
  let want = h?.price && rawStep > 0 ? groupFor(rawStep, h.price, step === null ? res : 'fine') : wantK;
  let fineAsk: { step: number; from: number; to: number } | null = null;
  let sub: FineSub = null;
  let barStep: number | null = null;
  if (step !== null && h?.price && rawStep > 0 && !histOn) {
    const k = streamGroup(step, rawStep);
    const fw = k ? null : win ? fineWindow(win[0], win[1], step) : null;
    const k2 = fw ? streamGroup(fw.step, rawStep) : null;
    if (k) { want = k; barStep = step; } else if (k2) { want = k2; barStep = fw!.step; } else if (fw) {
      barStep = fw.step;
      sub = inReach ? fineSubOf(fw) : null;
      if (!sub) fineAsk = fw;
    }
  }

  // Historical at a step finer than its snapshots keep (BTC $10, $1): their fine layers for the
  // price and time windows on screen (server liqRead.ts liqHistoryFine), merged into the snapshots
  // they belong to (liqHeatIndicator.ts cellsOf); its newest column is the stream's, fine layer and
  // all. Every wallet only: the layers keep no addresses.
  const finer = histOn && step !== null && histAt !== null && step < histAt.st * (1 - 1e-9);
  let histAsk: { step: number; from: number; to: number; t0: number; t1: number } | null = null;
  if (finer && !wallets.length && win && times) {
    const fw = fineWindow(win[0], win[1], step!);
    if (fw.step < histAt!.st * (1 - 1e-9)) {
      // The time window and half of it either side, on a grid of a quarter of it (viewers share answers, perf.ts).
      const span = Math.max(times[1] - times[0], 15 * 60_000);
      const g = Math.max(15 * 60_000, niceUp(span / 4));
      histAsk = { ...fw, t0: Math.floor((times[0] - span / 2) / g) * g, t1: Math.ceil((times[1] + span / 2) / g) * g };
      sub = fineSubOf(fw);
    }
  }
  // The stream at the snapshots' width in Historical (its newest column), whole buckets of it.
  if (histOn && histAt && rawStep > 0) want = streamGroup(histAt.st, rawStep) ?? want;
  useEffect(() => {
    const t = setTimeout(() => setWantK(streamAsk(want)), 250);
    return () => clearTimeout(t);
  }, [want]);
  const subKey = sub ? `${sub.k}|${sub.from}|${sub.to}` : '-';
  useEffect(() => setFineSub(sub), [subKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The fine window streamed, when it is of the step asked (a window panned past stays drawn until the next arrives).
  const lf = sub && live.fine && live.fine.k === sub.k ? live.fine : null;
  const fineKey = fineAsk ? `${coin}|${vkey}|${wkey}|${fineAsk.step}|${fineAsk.from}|${fineAsk.to}` : null;
  const fineR = usePolled<HeatApi>(fineKey, (s) => vsApi.liquidations(coin, chosen, 'fine', s, wallets, fineAsk ?? undefined), FINE_POLL_MS);
  const fd = fineAsk && fineR.data && fineR.data.coin === coin && fineR.data.venues.join(',') === vkey && Math.abs(fineR.data.step / fineAsk.step - 1) < 1e-9 ? fineR.data : null;
  const fineSrc = useMemo((): (HeatApi & { from?: number; to?: number }) | null => (lf && apiData ? { ...apiData, price: lf.p, step: lf.st, buckets: lf.buckets, from: lf.from, to: lf.to } : fd), [lf, apiData, fd]);
  const fine = useMemo(() => (fineSrc && !histOn ? fromApi(fineSrc, side, lev) : null), [fineSrc, histOn, side, levKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const fineOn = !!(lf || fineAsk);
  const barWidth = barStep ?? (h?.price && rawStep > 0 ? rawStep * want : null);
  // The chart view's profile: the bars at the step drawn, the curves from the fine answer when it holds the price.
  const chartH = prefs.view === 'chart' && h?.price && h.buckets.length ? h : null;
  const group = Math.max(1, Math.round(want / streamK));
  const profile = useMemo(() => (chartH ? profileOf(fineOn && fine ? fine : regroup(chartH, group), cumSrc(chartH, fineOn ? fine : null), unit, colorBy) : null), [chartH, fineOn, fine, group, unit, colorBy]);

  const histFineKey = histAsk ? `${coin}|${vkey}|${histAsk.step}|${histAsk.from}|${histAsk.to}|${histAsk.t0}|${histAsk.t1}` : null;
  const hf = usePolled<LiqHistoryFine>(histFineKey, (s) => vsApi.liquidationHistoryFine(coin, chosen, histAsk!, s), 5 * 60_000);
  // An answer of the step asked (a window panned past stays drawn until the next one is read).
  const histFine = histAsk && hf.data && hf.data.coin === coin && hf.data.venues.join(',') === vkey && Math.abs(hf.data.step / histAsk.step - 1) < 1e-9 ? hf.data : null;
  // Only into a snapshot the history holds: a fine part newer than its answer (both are read every 5 minutes) waits for it.
  const { points: snapPts, finePts } = useMemo(() => {
    if (!histFine?.points.length) return { points: coarsePts, finePts: null };
    const by = new Map(histFine.points.map((q) => [q.t, q]));
    const used: HeatPoint[] = [];
    const out = coarsePts.map((q): HeatPoint => {
      const f = by.get(q.t);
      if (!f) return q;
      used.push({ t: q.t, p: q.p, st: f.st, b: f.b });
      return { ...q, f: { st: f.st, lo: f.lo, hi: f.hi, b: f.b } };
    });
    return { points: out, finePts: used.length ? used : null };
  }, [coarsePts, histFine]);
  // The newest column: the stream now at the snapshots' step, and its fine window at the step drawn
  // (a second apart, as the live view). Every wallet only, as the stream.
  const livePt = useMemo((): HeatPoint | null => {
    if (!histOn || wallets.length || !apiData?.price || !histAt || !newest || !(apiData.at > newest.t)) return null;
    const p = apiData.price;
    const f = lf ? { st: lf.st, lo: lf.from, hi: lf.to, b: snapRowsOf(lf.buckets, lf.st, lf.st, p) } : null;
    return { t: apiData.at, p, st: histAt.st, b: snapRowsOf(apiData.buckets, apiData.step, histAt.st, p), f };
  }, [histOn, wkey, apiData, histAt?.st, newest?.t, lf]); // eslint-disable-line react-hooks/exhaustive-deps
  const points = useMemo(() => (livePt ? [...snapPts, livePt] : snapPts), [snapPts, livePt]);
  // The colours per the step drawn (the snapshots', not the live column's: the scale holds still): a
  // $1 cell is full at what $1 cells hold, a $100 cell around it reads as a hundred of them.
  // Over the 30 days at every price (the index's, the tiles on screen being a part of them); the fine parts' own.
  const heatSc = useMemo(() => (finePts ? heatScale(finePts, side, lev) : hist.scale(side, lev)), [finePts, hist.scale, side, levKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const refSt = finePts ? histFine!.step : null;
  const steps: StepsView | null = ladder.length ? {
    value: level === 'auto' ? 'auto' : String(Math.min(level, ladder.length - 1)),
    options: [['auto', 'Auto'], ...ladder.map((x, i): [string, string] => [String(i), stepLabel(x)])],
    initial: String(initial),
    note: null,
  } : null;
  // What the live and chart views say instead of levels; and the historical view, instead of snapshots.
  const nowEmpty = !h ? (heat.error ? `Liquidation levels unavailable: ${heat.error}` : 'Reading the books…')
    : !h.price || !h.buckets.length ? `${wallets.length ? (wallets.length === 1 ? 'This wallet holds' : 'These wallets hold') + ` no ${coin} position with a liquidation price` : `No tracked ${coin} positions with a liquidation price`} on ${chosen.length === SCAN_VENUES.length ? 'any platform' : chosen.map((v) => VENUE_LABEL[v]).join(', ')}.`
      : null;
  const histEmpty = hist.error && !hist.ready ? `History unavailable: ${hist.error}`
    : !hist.ready ? 'Reading the snapshots…'
      : !hist.list.length ? (wallets.length ? `No snapshots of ${coin} for ${wallets.length === 1 ? 'this wallet' : 'these wallets'} in this range: every position's level is kept from 28 Oct 2026, 15-minutely for 3 days and hourly to 30.` : `No snapshots of ${coin} yet: the index keeps every coin SoDEX lists, a snapshot every 15 minutes.`)
        : null;
  const change = (p: ViewChange) => {
    const { step, ...rest } = p;
    if (step === undefined) { set(rest); return; }
    set({ ...rest, steps: { ...(prefs.steps ?? {}), [coin]: step === 'auto' ? 'auto' : Number(step) } });
  };

  return (
    <div className="lqm" style={LEV_VARS}>
      <div className="lqm-bar">
        <div className="lqm-seg" role="tablist" aria-label="View">
          {(['live', 'chart', 'history'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={prefs.view === v} className={prefs.view === v ? 'is-on' : ''} onClick={() => set({ view: v })}>
              {v === 'live' ? <><span className={`lqm-dot${live.connected ? ' is-on' : ''}`} aria-hidden="true" title={live.connected ? 'Streaming: updates every second' : 'Not streaming: refreshed every minute'} />Live</> : v === 'chart' ? 'Chart' : 'Historical'}
            </button>
          ))}
        </div>
        <span className="lqm-coin" title="The market on screen">{coin}</span>
        <span className="lqm-grow" />
        <PlatformSelect options={SCAN_VENUES} value={chosen} onChange={(v) => set({ venues: v })} align="end" />
        <WalletView
          wallets={wallets}
          side={side}
          venues={chosen}
          self={address}
          bars={prefs.view !== 'history' ? { res, unit, coin, width: barWidth !== null ? stepLabel(barWidth) : null } : null}
          steps={steps}
          colors={{ colorBy, lev, strip: prefs.view === 'history' ? strip : null }}
          onChange={change}
          onReset={() => set({ wallets: [], side: 'both', res: 'fine', unit: 'usd', colorBy: 'side', lev: [...LEV_BANDS], strip: false, steps: {} })}
        />
      </div>
      {(prefs.view !== 'history' || colorBy === 'lev') && (
        <div className="lqm-legend">
          {colorBy === 'lev' ? (
            LEV_KEYS.filter((k) => (k === 'unknown' ? isAllLev(lev) : lev.includes(k))).map((k) => <span key={k}><i className="lqm-sw" style={{ background: LEV_COLOR[k] }} />{LEV_LABEL[k]}</span>)
          ) : (
            <><span><i className="lqm-sw is-long" />Long liquidations</span><span><i className="lqm-sw is-short" />Short liquidations</span></>
          )}
          {prefs.view === 'live' && <><span><i className="lqm-ln is-long" />Cumulative longs</span><span><i className="lqm-ln is-short" />Cumulative shorts</span></>}
        </div>
      )}
      <div className="lqm-body">
        {prefs.view !== 'live' ? (
          // One chart for Chart and Historical: switching keeps its timeframe, zoom and scale.
          <ChartPanel
            engine={engine}
            symbol={symbol}
            points={histOn ? points : EMPTY_POINTS}
            scale={histOn ? heatSc : 1}
            refSt={histOn ? refSt : null}
            side={side}
            colorBy={colorBy}
            lev={lev}
            strip={histOn ? stripData : profile}
            profile={!histOn}
            fmt={histOn ? fmtUsdShort : (v) => fmtVal(v, unit, coin)}
            note={histOn ? histEmpty : profile ? null : nowEmpty}
            onWindow={onWindow}
            onTimes={onTimes}
            onPick={setPick}
          />
        ) : nowEmpty ? (
          <p className="lqm-empty">{nowEmpty}</p>
        ) : (
          <LiveView h={h!} fine={fineOn ? fine : null} onWindow={onWindow} unit={unit} want={want} streamK={streamK} colorBy={colorBy} lev={lev} onPick={setPick} pick={pick} />
        )}
        {/* The wallets now: a bar of the live and chart views, or of the historical view's strip. */}
        {pick && pick.at === undefined && h && <Details coin={coin} venues={chosen} pick={pick} price={h.price} wallets={wallets} lev={lev} onClose={() => setPick(null)} />}
        {pick?.at !== undefined && prefs.view === 'history' && <AtDetails coin={coin} venues={chosen} pick={pick as Required<Pick>} wallets={wallets} lev={lev} onClose={() => setPick(null)} />}
      </div>
      {raw && prefs.view !== 'history' && <Coverage h={raw} coin={coin} />}
    </div>
  );
}

// --- zoom and pan -------------------------------------------------------------------------

/** A wheel listener that may cancel the page's scroll (React's onWheel is passive). */
function useWheel(el: HTMLElement | null, on: (e: WheelEvent) => void): void {
  const fn = useRef(on);
  fn.current = on;
  useEffect(() => {
    if (!el) return;
    const h = (e: WheelEvent) => { e.preventDefault(); fn.current(e); };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, [el]);
}

/** Zoom [lo, hi] by `f` (below 1 = in) around `at`. */
const zoomAt = ([lo, hi]: [number, number], at: number, f: number): [number, number] => [at - (at - lo) * f, at + (hi - at) * f];
const wheelFactor = (e: WheelEvent) => Math.exp(Math.max(-1, Math.min(1, e.deltaY / 300)));

/**
 * Pointer drags that are not clicks: a press that moves less than 4px is a
 * click (`onClick`), anything more is a drag (`onDrag` with the move since the
 * last event).
 */
function useDrag(onDrag: (dx: number, dy: number, start: { x: number; y: number }) => void, onClick: (x: number, y: number) => void) {
  const st = useRef<{ x: number; y: number; lx: number; ly: number; moved: boolean; id: number } | null>(null);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const r = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      st.current = { x, y, lx: e.clientX, ly: e.clientY, moved: false, id: e.pointerId };
    },
    onPointerMoveDrag: (e: ReactPointerEvent<HTMLElement>) => {
      const s = st.current;
      if (!s || s.id !== e.pointerId) return false;
      const dx = e.clientX - s.lx;
      const dy = e.clientY - s.ly;
      if (!s.moved && Math.hypot(e.clientX - (s.lx), e.clientY - (s.ly)) < 4 && Math.abs(dx) + Math.abs(dy) < 4) return false;
      if (!s.moved) { s.moved = true; e.currentTarget.setPointerCapture(e.pointerId); }
      s.lx = e.clientX;
      s.ly = e.clientY;
      onDrag(dx, dy, { x: s.x, y: s.y });
      return true;
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const s = st.current;
      st.current = null;
      if (s && !s.moved) onClick(s.x, s.y);
      if (s?.moved) e.currentTarget.releasePointerCapture?.(e.pointerId);
    },
    dragging: () => !!st.current?.moved,
  };
}

/** The bucket with liquidations nearest a price, within `tol` (else the bucket at it, empty). */
function nearestBucket(h: Heat, shown: readonly Bucket[], price: number, tol: number): { from: number; b: Bucket | null } {
  let b: Bucket | null = null;
  for (const x of shown) {
    const d = Math.abs(x[0] + h.step / 2 - price);
    if (d <= Math.max(tol, h.step / 2) && (!b || d < Math.abs(b[0] + h.step / 2 - price))) b = x;
  }
  return { from: b ? b[0] : Math.floor(price / h.step) * h.step, b };
}
const sideOf = (b: Bucket | null, from: number, step: number, p: number): 'long' | 'short' =>
  b && (b[1] > 0) !== (b[2] > 0) ? (b[1] > 0 ? 'long' : 'short') : from + step / 2 < p ? 'long' : 'short';

/**
 * The bar scale: robustMax of the bars on screen (liqLev.ts), so a level far past every other
 * (SoDEX BTC's two ~$70M accounts beside levels under $0.3M) is drawn at full with a tick, and
 * the rest keep a length to read. `top`: the largest bar, how far a side axis may scale out.
 */
function barScale(shown: readonly Bucket[], unit: Unit, colorBy: ColorBy): { fit: number; top: number } {
  const v = shown.map((b) => barOf(b, unit, colorBy));
  const top = Math.max(1e-12, ...v);
  return { fit: Math.max(1e-12, Math.min(top, robustMax(v))), top };
}

/** A tooltip's lines by leverage band (only the bands with some), and a note when the bar or cell runs past the scale. */
function BandLines({ v, fmt, over, lev, what = 'bar' }: { v: Bands; fmt: (x: number) => string; over: boolean; lev: LevFilter; what?: 'bar' | 'cell' }) {
  const any = v[0] + v[1] + v[2] > 0;
  return (
    <>
      {any && LEV_KEYS.map((k, i) => (v[i]! > 0 ? <span key={k} className="lqm-tip-lev"><i className="lqm-sw" style={{ background: LEV_COLOR[k] }} />{LEV_LABEL[k]} {fmt(v[i]!)}</span> : null))}
      {!any && isAllLev(lev) && v[3] > 0 && <span className="lqm-tip-sub">Leverage not known for these positions</span>}
      {over && <span className="lqm-tip-sub">{what === 'bar' ? 'Past the bar scale: drawn at full length' : 'Past the colour scale: drawn at full'}</span>}
    </>
  );
}

/** Positions per side are counted for every band together: with a band filter on they are left out. */
const countText = (n: number, lev: LevFilter, word = ' positions') => (isAllLev(lev) ? ` · ${n}${word}` : '');

// --- live ---------------------------------------------------------------------------------

const M = { l: 56, r: 60, t: 10, b: 24 };
/** The live view's narrowest window, as a share of the price. */
const MIN_SPAN = 0.0005;

/** Wheel zooms the price, drag pans; wheel on a side axis scales it; a double-click resets the axes. */
function LiveView({ h: base, fine, onWindow, unit, want, streamK, colorBy, lev, onPick, pick }: { h: Heat; fine: Heat | null; onWindow: (lo: number, hi: number, px: number) => void; unit: Unit; want: number; streamK: number; colorBy: ColorBy; lev: LevFilter; onPick: (p: Pick) => void; pick: Pick | null }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [ref, { w, h: ht }] = useSize<HTMLDivElement>();
  const bind = useCallback((x: HTMLDivElement | null) => { ref(x); setEl(x); }, [ref]);
  const [hover, setHover] = useState<number | null>(null);
  const auto = useMemo(() => windowOf(base), [base]);
  const [view, setView] = useState<[number, number] | null>(null);
  /** Manual axis scales (null = fit what is shown). */
  const [barMax, setBarMax] = useState<number | null>(null);
  const [cumMax, setCumMax] = useState<number | null>(null);
  useEffect(() => { setView(null); setBarMax(null); setCumMax(null); }, [base.coin, unit]);
  const cum = useMemo(() => cumulative(cumSrc(base, fine), unit), [base, fine, unit]);
  const W = Math.max(1, w - M.l - M.r);
  const H = Math.max(1, ht - M.t - M.b);
  // Zoom and pan stay between 0 and the highest short liquidation (or a little past the price).
  const top = useMemo(() => {
    let t = (base.price ?? 0) * 1.1;
    for (const b of base.buckets) if (b[2] > 0) t = Math.max(t, b[0] + base.step);
    return t;
  }, [base]);
  // Zoomed in no further than MIN_SPAN of the price (BTC ~$39: $1 cells some 16 px wide), around the middle.
  const clamp = ([a, b]: [number, number]): [number, number] => {
    const min = (base.price ?? 0) * MIN_SPAN;
    const span = Math.min(Math.max(b - a, min), top);
    let lo2 = b - a < min ? (a + b) / 2 - span / 2 : a;
    let hi2 = lo2 + span;
    if (lo2 < 0) { lo2 = 0; hi2 = span; }
    if (hi2 > top) { hi2 = top; lo2 = top - span; }
    return [lo2, hi2];
  };
  const win = view ?? (auto && clamp(auto));
  const p = base.price!;
  const [lo, hi] = win ?? [p * 0.5, p * 1.5];
  const k = Math.max(1, Math.round(want / streamK));
  // Exact steps for the window (the fine route) when asked; the window, the curves and the axis stay the stream's.
  const h = useMemo(() => fine ?? regroup(base, k), [fine, base, k]);
  useEffect(() => { if (w > 0) onWindow(lo, hi, W); }, [lo, hi, w, W, onWindow]);
  const shown = useMemo(() => h.buckets.filter((b) => b[0] + h.step > lo && b[0] < hi), [h, lo, hi]);
  const { fit: fitBar, top: topBar } = barScale(shown, unit, colorBy);
  const fitCum = Math.max(1e-12, ...[...cum.long, ...cum.short].filter(([px]) => px >= lo && px <= hi).map(([, v]) => v));
  // The left axis scales from 2% of the fit out to the largest bar (to see a giant level whole).
  const maxBar = barMax === null ? fitBar * 1.05 : Math.min(topBar * 1.05, Math.max(fitBar * 0.02, barMax));
  const maxCum = cumMax === null ? fitCum * 1.05 : Math.min(fitCum * 1.05, Math.max(fitCum * 0.02, cumMax));
  const x = (v: number) => M.l + ((v - lo) / (hi - lo)) * W;
  const priceAt = (cx: number) => lo + ((cx - M.l) / W) * (hi - lo);
  const yBar = (v: number) => M.t + H - Math.min(1, v / maxBar) * H;
  const yCum = (v: number) => M.t + H - Math.min(1, v / maxCum) * H;
  const px1 = (h.step / (hi - lo)) * W;
  const bw = Math.max(1, px1 > 4 ? px1 - 1 : px1);
  const xs = ticks(lo, hi, Math.max(2, Math.floor(W / 90)));
  const path = (pts: Array<[number, number]>, toward: 'lo' | 'hi') => {
    const inWin = pts.filter(([v]) => v >= lo - h.step && v <= hi + h.step);
    if (!inWin.length) return '';
    let d = `M${x(p)},${yCum(0)}`;
    for (const [v, c] of inWin) d += ` H${x(v)} V${yCum(c)}`;
    return d + ` H${x(toward === 'hi' ? hi : lo)}`;
  };
  const longPath = path(cum.long, 'lo');
  const shortPath = path(cum.short, 'hi');
  // The bars, one path per colour (a step picked holds zoomed out - BTC $1 over the whole range is
  // ~13k of them, too many SVG rects to redraw each second); the picked one drawn again on top.
  const { bars, pickedBar } = useMemo(() => {
    const d = new Map<string, string>();
    let pickedBar: Array<[string, [number, number, number, number]]> | null = null;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    for (const b of shown) {
      const [l, s] = valOf(b, unit);
      const rs: Array<[string, [number, number, number, number]]> = [];
      const bx = x(b[0]);
      if (colorBy === 'lev') {
        // Both sides stacked by band from the axis up: low, mid, high, unknown; as tall as their total.
        const v = bandsOf(b, unit);
        const sum = v[0] + v[1] + v[2] + v[3] || l + s;
        const full = M.t + H - yBar(l + s);
        let y0 = M.t + H;
        LEV_KEYS.forEach((k, i) => {
          const hh = (v[i]! / sum) * full;
          if (!(hh > 0)) return;
          y0 -= hh;
          rs.push([`lqm-bar-lev is-${k}`, [bx, y0, bw, hh]]);
        });
      } else {
        if (l > 0) rs.push(['lqm-bar-long', [bx, yBar(l), bw, M.t + H - yBar(l)]]);
        if (s > 0) rs.push(['lqm-bar-short', [bx, yBar(s), bw, M.t + H - yBar(s)]]);
      }
      if (barOf(b, unit, colorBy) > maxBar) rs.push(['lqm-bar-over', [bx, M.t, bw, 2]]);
      for (const [cls, [rx, ry, rw, rh]] of rs) d.set(cls, `${d.get(cls) ?? ''}M${r1(rx)} ${r1(ry)}h${r1(rw)}v${r1(rh)}h${r1(-rw)}z`);
      if (pick && Math.abs(pick.from - b[0]) < h.step / 2) pickedBar = rs;
    }
    return { bars: [...d], pickedBar };
  }, [shown, unit, colorBy, maxBar, lo, hi, W, H, bw, pick, h.step]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Zoom by `f` around a point `frac` of the way across the window (functional: fast wheel ticks each count). */
  const zoom = (f: number, frac = 0.5) => setView((v) => {
    const [a, b] = v ?? [lo, hi];
    return clamp(zoomAt([a, b], a + frac * (b - a), f));
  });
  useWheel(el, (e) => {
    const r = el!.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const f = wheelFactor(e);
    // A side axis scales its bars up (to read small ones) and back to fit, never smaller than fit.
    if (cx < M.l) setBarMax(Math.min(topBar * 1.05, Math.max(fitBar * 0.02, maxBar * f)));
    else if (cx > M.l + W) setCumMax(Math.min(fitCum * 1.05, Math.max(fitCum * 0.02, maxCum * f)));
    else zoom(f, (cx - M.l) / W);
  });
  const drag = useDrag((dx, dy, start) => {
    setHover(null);
    // A drag that starts on a side axis does nothing (it used to rescale it, and a stray one hid the bars).
    if (start.x < M.l || start.x > M.l + W) return;
    setView((v) => {
      const [a, b] = v ?? [lo, hi];
      const d = (dx / W) * (b - a);
      return clamp([a - d, b - d]);
    });
  }, (cx) => {
    if (cx < M.l || cx > M.l + W) return;
    const { from, b } = nearestBucket(h, shown, priceAt(cx), (10 / W) * (hi - lo));
    setHover(from);
    onPick({ from, to: from + h.step, side: sideOf(b, from, h.step, p) });
  });
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.onPointerMoveDrag(e)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - r.left;
    setHover(cx >= M.l && cx <= M.l + W ? Math.floor(priceAt(cx) / h.step) * h.step : null);
  };
  const reset = () => { setView(null); setBarMax(null); setCumMax(null); };
  const hb = hover !== null ? h.buckets.find((b) => Math.abs(b[0] - hover) < h.step / 2) ?? null : null;
  const cumAt = (b: number, side: 'long' | 'short') => {
    const list = side === 'long' ? cum.long : cum.short;
    const hit = side === 'long' ? list.find(([v]) => v <= b) : list.find(([v]) => v >= b + h.step);
    return hit?.[1] ?? 0;
  };
  const fmtAx = (v: number) => (unit === 'usd' ? fmtUsdShort(v) : fmtSize(v));
  return (
    <div
      ref={bind}
      className={`lqm-plot${drag.dragging() ? ' is-drag' : ''}`}
      onPointerDown={drag.onPointerDown}
      onPointerMove={move}
      onPointerUp={drag.onPointerUp}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={reset}
    >
      {w > 0 && win && (
        <svg width={w} height={ht} role="img" aria-label={`Liquidation levels of ${h.coin}`}>
          <defs><clipPath id="lqm-clip-live"><rect x={M.l} y={0} width={W} height={ht} /></clipPath></defs>
          {ticks(0, maxBar, 4).map((v) => (
            <g key={`l${v}`}>
              <line x1={M.l} x2={M.l + W} y1={yBar(v)} y2={yBar(v)} className="lqm-grid" />
              <text x={M.l - 6} y={yBar(v) + 3} className="lqm-ax" textAnchor="end">{fmtAx(v)}</text>
            </g>
          ))}
          {ticks(0, maxCum, 4).map((v) => <text key={`r${v}`} x={M.l + W + 6} y={yCum(v) + 3} className="lqm-ax">{fmtAx(v)}</text>)}
          {xs.map((v) => <text key={`x${v}`} x={x(v)} y={M.t + H + 16} className="lqm-ax" textAnchor="middle">{fmtPx(v)}</text>)}
          
          <g clipPath="url(#lqm-clip-live)">
            {longPath && <path d={`${longPath} V${yCum(0)} Z`} className="lqm-area is-long" />}
            {shortPath && <path d={`${shortPath} V${yCum(0)} Z`} className="lqm-area is-short" />}
            {bars.map(([cls, d]) => <path key={cls} d={d} className={cls} />)}
            {pickedBar && (
              <g className="is-picked">
                {pickedBar.map(([cls, r]) => <rect key={cls} x={r[0]} y={r[1]} width={r[2]} height={r[3]} className={cls} />)}
              </g>
            )}
            {longPath && <path d={longPath} className="lqm-cum is-long" />}
            {shortPath && <path d={shortPath} className="lqm-cum is-short" />}
            <line x1={x(p)} x2={x(p)} y1={M.t} y2={M.t + H} className="lqm-now" />
            {hover !== null && <rect x={x(hover)} y={M.t} width={Math.max(2, bw)} height={H} className="lqm-hover" />}
          </g>
          {p >= lo && p <= hi && (
            <g transform={`translate(${Math.min(M.l + W - 48, Math.max(M.l + 48, x(p)))},${M.t + H + 2})`}>
              <rect x={-48} y={0} width={96} height={18} rx={4} className="lqm-now-tag" />
              <text y={13} textAnchor="middle" className="lqm-now-text">Current: {fmtPx(p)}</text>
            </g>
          )}
        </svg>
      )}
      {hover !== null && !drag.dragging() && (
        <div className="lqm-tip" style={{ left: Math.min(w - 210, Math.max(0, x(hover) + 12)), top: M.t + 6 }}>
          <b>{fmtPx(hover)} – {fmtPx(hover + h.step)}</b>
          <span>{pct(hover / p - 1)} from current</span>
          {hb ? (
            <>
              {hb[1] > 0 && <span className="is-long">Longs {fmtVal(valOf(hb, unit)[0], unit, h.coin)}{countText(hb[5], lev)}</span>}
              {hb[2] > 0 && <span className="is-short">Shorts {fmtVal(valOf(hb, unit)[1], unit, h.coin)}{countText(hb[6], lev)}</span>}
              <BandLines v={bandsOf(hb, unit)} fmt={(x) => fmtVal(x, unit, h.coin)} over={barOf(hb, unit, colorBy) > maxBar} lev={lev} />
            </>
          ) : <span>No liquidations here</span>}
          <span className="lqm-tip-sub">Cumulative {hover < p ? `longs ${fmtVal(cumAt(hover, 'long'), unit, h.coin)}` : `shorts ${fmtVal(cumAt(hover, 'short'), unit, h.coin)}`}</span>
          <span className="lqm-tip-sub">Click for the wallets</span>
        </div>
      )}
    </div>
  );
}

// --- chart and history: the app's own chart ----------------------------------------------------

/**
 * The chart and historical views: the app's own chart (Chart.tsx, `bare`) with the levels drawn on
 * its candle pane (chart/liqHeatIndicator.ts). Every control is the chart's - timeframes, wheel
 * zoom and drag with the price axis following, auto / log / percentage scale, the clock (UTC or
 * local) - exactly as on the trade page's chart, and the levels follow them (owner 2026-11-01:
 * "scrolling in out in chart & historical is different than normal chart ... we dont have % A L
 * switches & utc time"; the chart view drew its own SVG until then). No drawings, studies or
 * order lines.
 *
 *   chart     the levels now as a profile growing left from the price axis, with the cumulative
 *             curves (`strip` drawn as the `profile`), at the resolution picked.
 *   history   the levels over time as cells behind the candles (`points`): the indexer's
 *             snapshots, 15-minutely for 3 days and hourly to 30 - a shorter bar repeats the
 *             snapshot in force at its close - with their fine layers where a finer step is
 *             picked (cellsOf). `strip`: the levels now over the right edge, on the same axis.
 *
 * One chart for both: switching view keeps its timeframe, zoom and scale. It reports the price
 * window on screen (`onWindow`: what exact steps are read for) and the time window (`onTimes`:
 * which snapshots' fine layers). A click on a cell opens who sat in it then (AtDetails); on the
 * strip or the profile, the wallets now (Details).
 */
function ChartPanel({ engine, symbol, points, scale, refSt, side, colorBy, lev, strip, profile, fmt, note, onWindow, onTimes, onPick }: {
  engine: Engine; symbol: string;
  /** The snapshots drawn (none in the chart view), the notional a cell is full at, and the width that is of (null: the newest snapshot's). */
  points: HeatPoint[]; scale: number; refSt: number | null;
  side: Side; colorBy: ColorBy; lev: LevFilter;
  strip: LiqMapData | null;
  /** The strip as the chart view's profile (wider, with the cumulative curves). */
  profile: boolean;
  /** A figure of the strip in the unit shown. */
  fmt: (v: number) => string;
  note: string | null;
  onWindow: (lo: number, hi: number, px: number) => void;
  onTimes: (t0: number, t1: number) => void;
  onPick: (p: Pick) => void;
}) {
  const levKey = lev.join(',');
  const [kc, setKc] = useState<KChart | null>(null);
  // The cells, their scale and the strip change with the snapshots, the side and the bands; the
  // strip with the levels now (a second apart), which only redraws. `rev` tells the chart to work
  // the bars out again (an extendData change alone only redraws).
  const rev = useMemo(() => ++calcRev, [points, side, levKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The axis fits the candles (fit off): fitted to every bar's levels as well, the candles lay flat in a
  // tenth of the pane (owner 2026-10-31). The snapshots hold the levels 0.2x-3x the price, so zooming the
  // price axis out shows all of them - none is cut off.
  const data = useMemo<HeatData>(() => ({ points, side, lev, colorBy, scale, fit: false, strip, ref: refSt, profile }), [points, side, levKey, colorBy, scale, strip, refSt, profile]); // eslint-disable-line react-hooks/exhaustive-deps
  const dataRef = useRef({ data, rev });
  dataRef.current = { data, rev };
  // The layer on each chart instance the chart makes (it makes a new one on a rebuild).
  useEffect(() => {
    if (!kc) return;
    let id: string | null = null;
    let gone = false;
    void import('klinecharts').then((lib) => {
      if (gone) return;
      lib.registerIndicator(liqHeatTemplate);
      id = kc.createIndicator({ name: LIQ_HEAT, paneId: CANDLE_PANE_ID, extendData: boxed(dataRef.current.data), calcParams: [dataRef.current.rev] }, true);
    });
    return () => {
      gone = true;
      if (id) kc.removeIndicator({ id, paneId: CANDLE_PANE_ID });
    };
  }, [kc]);
  useEffect(() => {
    kc?.overrideIndicator({ name: LIQ_HEAT, paneId: CANDLE_PANE_ID, extendData: boxed(data), calcParams: [rev] });
  }, [kc, data, rev]);
  // The price and time windows on screen, read off the chart's own axes a few times a second: a
  // wheel, a drag, a scale switch or a new bar all move them, and none of them tells.
  const report = useRef({ onWindow, onTimes });
  report.current = { onWindow, onTimes };
  useEffect(() => {
    if (!kc) return;
    const read = () => {
      const pane = kc.getSize(CANDLE_PANE_ID);
      if (!pane || !(pane.height > 0)) return;
      const [top, bot] = kc.convertFromPixel([{ x: 0, y: 0 }, { x: 0, y: pane.height }], { paneId: CANDLE_PANE_ID }) as Array<{ value?: number }>;
      const hi = top?.value;
      const lo = bot?.value;
      if (lo !== undefined && hi !== undefined && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) report.current.onWindow(Math.max(0, lo), hi, pane.height);
      const list = kc.getDataList();
      if (list.length) {
        const r = kc.getVisibleRange();
        const a = list[Math.max(0, Math.min(list.length - 1, Math.floor(r.realFrom)))]!.timestamp;
        const b = list[Math.max(0, Math.min(list.length - 1, Math.ceil(r.realTo) - 1))]!.timestamp + barMsOf(list);
        report.current.onTimes(a, b);
      }
    };
    read();
    const t = window.setInterval(read, 400);
    return () => window.clearInterval(t);
  }, [kc]);
  const wrap = useRef<HTMLDivElement>(null);
  const stripW = profile ? profileWidth : stripWidth;
  /** What is under the pointer: a cell of the snapshot in force at that bar, or a bar of the strip of the levels now. */
  const spotAt = (clientX: number, clientY: number): Spot | null => {
    if (!kc || !wrap.current) return null;
    const dom = (kc.getDom() as HTMLElement | null) ?? null;
    const pane = kc.getSize(CANDLE_PANE_ID);
    if (!dom || !pane) return null;
    const rect = dom.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (y < pane.top || y > pane.top + pane.height || x < pane.left || x > pane.left + pane.width) return null;
    const [pt] = kc.convertFromPixel([{ x, y }], { paneId: CANDLE_PANE_ID, absolute: true }) as Array<{ dataIndex?: number; value?: number }>;
    const price = pt?.value;
    if (price === undefined || !Number.isFinite(price)) return null;
    const box = wrap.current.getBoundingClientRect();
    const at = { x: clientX - box.left, y: clientY - box.top, price };
    if (strip && x - pane.left >= pane.width - stripW(pane.width) - 6) {
      const lo = Math.floor(price / strip.step + 1e-9) * strip.step;
      const k = strip.rows.findIndex((row) => Math.abs(row[0] - lo) < strip.step / 2);
      return { ...at, kind: 'now', lo, step: strip.step, p: strip.price, l: k >= 0 ? strip.rows[k]![1] : 0, s: k >= 0 ? strip.rows[k]![2] : 0, bands: (k >= 0 ? strip.bands?.[k] : null) ?? ZERO };
    }
    if (!points.length) return null;
    const list = kc.getDataList();
    const bar = pt?.dataIndex !== undefined ? list[pt.dataIndex] : undefined;
    if (!bar) return null;
    const i = snapshotFor(points.map((q) => q.t), bar.timestamp, barMsOf(list));
    const snap = i >= 0 ? points[i]! : null;
    if (!snap) return null;
    const cell = cellAt(snap, price);
    const st = cell ? cell.st : snap.st;
    const lo = cell ? cell.lo : Math.floor(price / st) * st;
    const l = cell && side !== 'short' ? cellOf(cell.r, 'long', lev).v : 0;
    const s = cell && side !== 'long' ? cellOf(cell.r, 'short', lev).v : 0;
    return { ...at, kind: 'then', lo, step: st, p: snap.p, t: snap.t, l, s, bands: cell ? cellOf(cell.r, side, lev).bands : ZERO };
  };
  // A click (not a drag) on a cell: that bar's snapshot and the cell of it under the pointer - the
  // positions in it, as they stood then, open beside the chart (AtDetails); on the strip, the wallets now.
  const down = useRef<{ x: number; y: number } | null>(null);
  const pickAt = (clientX: number, clientY: number) => {
    const sp = spotAt(clientX, clientY);
    if (!sp) return;
    const sideAt = sp.price < sp.p ? 'long' : 'short';
    onPick({ from: sp.lo, to: sp.lo + sp.step, side: sideAt, ...(sp.kind === 'then' ? { at: sp.t } : {}) });
  };
  const [tip, setTip] = useState<Spot | null>(null);
  const frame = useRef(0);
  const hover = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons) { setTip(null); return; }
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setTip(spotAt(clientX, clientY)));
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const box = wrap.current?.getBoundingClientRect();
  const over = (sp: Spot) => sp.kind === 'then' && (sp.l + sp.s) * stepNorm({ st: sp.step } as HeatPoint, refSt ?? refStep(points)) > scale;
  const fmtTip = (v: number) => (tip?.kind === 'now' ? fmt(v) : fmtUsdShort(v));
  return (
    <div
      ref={wrap}
      className="lqm-hist2"
      onPointerDownCapture={(e) => { down.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }}
      onPointerUpCapture={(e) => {
        const d = down.current;
        down.current = null;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) pickAt(e.clientX, e.clientY);
      }}
      onPointerMove={hover}
      onPointerLeave={() => { cancelAnimationFrame(frame.current); setTip(null); }}
    >
      <Chart engine={engine} symbol={symbol} bare onChartReady={setKc} />
      {(!profile || note) && (
        <div className="lqm-hist2-key" onPointerDown={(e) => e.stopPropagation()}>
          {!profile && (
            <span className="lqm-hist-scale" title={colorBy === 'lev' ? 'Liquidation notional per cell (USD at the liquidation price): the stronger, the more; the colour is its mix of leverage' : 'Liquidation notional per cell (USD at the liquidation price): low to high'}>
              <span>{fmtUsdShort(scale * HEAT_FLOOR)}</span>
              <i aria-hidden="true" className={colorBy === 'lev' ? 'is-lev' : ''} />
              <span>{fmtUsdShort(scale)}+</span>
            </span>
          )}
          {note && <span className="lqm-hist2-note">{note}</span>}
        </div>
      )}
      {tip && (tip.l > 0 || tip.s > 0 || tip.kind === 'now') && (
        <div className="lqm-tip" style={{ left: Math.max(0, Math.min((box?.width ?? 400) - 220, tip.x + (tip.kind === 'now' ? -232 : 14))), top: Math.max(0, Math.min((box?.height ?? 300) - 150, tip.y - 20)) }}>
          <b>{fmtPx(tip.lo)} – {fmtPx(tip.lo + tip.step)}</b>
          <span>{tip.kind === 'now' ? `Now · ${pct((tip.lo + tip.step / 2) / tip.p - 1)} from current` : `${whenFmt(tip.t)} · ${pct((tip.lo + tip.step / 2) / tip.p - 1)} from the price then`}</span>
          {tip.l > 0 && <span className="is-long">Longs {fmtTip(tip.l)}</span>}
          {tip.s > 0 && <span className="is-short">Shorts {fmtTip(tip.s)}</span>}
          {!(tip.l > 0 || tip.s > 0) && <span>No liquidations here</span>}
          <BandLines v={tip.bands} fmt={fmtTip} over={over(tip)} lev={lev} what="cell" />
          <span className="lqm-tip-sub">{tip.kind === 'now' ? 'Click for the wallets now' : 'Click for the positions then'}</span>
        </div>
      )}
    </div>
  );
}
/** A place on the chart: a past cell (`then`) or a bar of the levels now (`now`), as shown. */
type Spot = { x: number; y: number; price: number; lo: number; step: number; p: number; l: number; s: number; bands: Bands } & ({ kind: 'now' } | { kind: 'then'; t: number });
let calcRev = 0;
const EMPTY_POINTS: HeatPoint[] = [];

/** The chart view's profile: the bars shown in the unit shown, with the cumulative curves (from `cumFrom`). */
function profileOf(h: Heat, cumFrom: Heat, unit: Unit, colorBy: ColorBy): LiqMapData | null {
  if (!h.price) return null;
  return {
    price: h.price,
    step: h.step,
    rows: h.buckets.map((b): [number, number, number] => { const [l, s] = valOf(b, unit); return [b[0], l, s]; }),
    bands: h.buckets.map((b) => bandsOf(b, unit)),
    colorBy,
    cum: cumulative(cumFrom, unit),
  };
}

// --- details of a past cell ---------------------------------------------------------------

const whenFmt = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Isolated with its leverage, or cross with its effective one (notional over the account's equity, "~"). */
function marginText(p: LiqAt['positions'][number]): string | null {
  if (p.iso === null) return null;
  if (p.iso) return `isolated${p.lev ? ` ${fmtFixed(p.lev, 0)}×` : ''}`;
  const eff = p.lev ?? (p.sz !== null && p.mark !== null && p.eq && p.eq > 0 ? (Math.abs(p.sz) * p.mark) / p.eq : null);
  return `cross${eff ? ` ~${fmtFixed(eff, eff < 10 ? 1 : 0)}×` : ''}`;
}

/** What a position did after the time asked, in a few words. */
function nextText(p: LiqAt['positions'][number]): string {
  const n = p.next;
  if (!n) return 'unchanged since';
  if (n.kind === 'closed') return `closed ${whenFmt(n.t)}${n.nearLevel ? ' near its level (likely liquidated)' : n.mark !== null ? ` at ${fmtPx(n.mark)}` : ''}`;
  if (n.kind === 'flipped') return `flipped ${whenFmt(n.t)}`;
  return `level ${fmtPx(n.liq!)} from ${whenFmt(n.t)}`;
}

/**
 * The historical view's details: who sat in the picked cell at the snapshot's time, by the change
 * log - each position's size, entry, margin and account then, since when it was open and what it
 * did next. Positions are kept from the log's first step (28 Oct 2026); before that only the cells.
 */
function AtDetails({ coin, venues, pick, wallets, lev, onClose }: { coin: string; venues: Venue[]; pick: Required<Pick>; wallets: string[]; lev: LevFilter; onClose: () => void }) {
  const [side, setSide] = useState<'long' | 'short' | 'both'>(pick.side);
  useEffect(() => setSide(pick.side), [pick]);
  const levKey = lev.join(',');
  // Only the bands shown (the server reads each row's leverage from the change log: liqRead.ts logLev).
  const fetcher = useCallback((s: AbortSignal) => vsApi.liquidationAt(coin, venues, pick.at, pick.from, pick.to, side, s, wallets, isAllLev(lev) ? [] : lev), [coin, venues, pick, side, wallets, levKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = usePolled<LiqAt>(`at|${coin}|${venues.join(',')}|${pick.at}|${pick.from}|${pick.to}|${side}|${wallets.join(',')}|${levKey}`, fetcher, 5 * 60_000);
  const d = r.data;
  const before = d?.logFrom !== null && d?.logFrom !== undefined && pick.at < d.logFrom;
  return (
    <aside className="lqm-det" aria-label="Liquidation details then">
      <header>
        <b>Liquidations then</b>
        <button type="button" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <dl>
        <dt>Price range</dt><dd>{fmtPx(pick.from)} – {fmtPx(pick.to)}</dd>
        <dt>As of</dt><dd>{whenFmt(d?.snapT ?? pick.at)}</dd>
        <dt>Price then</dt><dd>{d?.price ? `${fmtPx(d.price)} (${pct((pick.from + pick.to) / 2 / d.price - 1)})` : '–'}</dd>
        {!isAllLev(lev) && <><dt>Leverage</dt><dd>{lev.map((b) => LEV_LABEL[b]).join(', ')}</dd></>}
      </dl>
      <div className="lqm-seg lqm-det-side" role="group" aria-label="Side">
        <button type="button" className={side === 'long' ? 'is-on' : ''} onClick={() => setSide('long')}>Longs</button>
        <button type="button" className={side === 'short' ? 'is-on' : ''} onClick={() => setSide('short')}>Shorts</button>
        <button type="button" className={side === 'both' ? 'is-on' : ''} onClick={() => setSide('both')}>Both</button>
      </div>
      <p className="lqm-det-sum">
        {d ? `${d.count} position${d.count === 1 ? '' : 's'}` : 'Reading…'}
        {d && <strong className="is-long">{fmtUsdShort(d.long.usd)}</strong>}
        {d && <strong className="is-short">{fmtUsdShort(d.short.usd)}</strong>}
      </p>
      <ol className="lqm-det-list lqm-det-list--at">
        {r.error && !d && <li className="lqm-empty">{r.error}</li>}
        {d && before && <li className="lqm-empty">Positions are kept from {whenFmt(d.logFrom!)}; this cell is from before that.</li>}
        {d && !before && !d.positions.length && <li className="lqm-empty">None in this cell then.</li>}
        {d?.positions.map((p) => (
          <li key={`${p.venue}|${p.address}`} className={p.side === 'long' ? 'is-long' : 'is-short'}>
            <span className="lqm-det-who" title={`${VENUE_LABEL[p.venue]} · ${p.address}`}>
              <VenueLogo venue={p.venue} size={12} />
              <LevDot lev={p.levRun} />
              {p.label ?? shortAddr(p.address)}
            </span>
            <span className="lqm-det-usd">{fmtUsdShort(p.usd)}</span>
            <span className="lqm-det-sz">
              {p.sz !== null ? `${fmtSize(Math.abs(p.sz))} ${coin}` : p.side === 'long' ? 'Long' : 'Short'} @ {fmtPx(p.liq)}
              {p.entry !== null && ` · entry ${fmtPx(p.entry)}`}
            </span>
            <span className="lqm-det-dist">{p.dist === null ? '' : `${fmtFixed(Math.abs(p.dist) * 100, 1)}% away`}</span>
            <span className="lqm-det-more">
              {[
                marginText(p),
                p.eq !== null ? `equity ${fmtUsdShort(p.eq)}` : null,
                `since ${whenFmt(p.since)}`,
                nextText(p),
              ].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
        {d && d.count > d.positions.length && <li className="lqm-empty">and {d.count - d.positions.length} smaller</li>}
      </ol>
    </aside>
  );
}

// --- details ------------------------------------------------------------------------------

/** A position's leverage band as a dot (grey: not known), its figure on hover. */
function LevDot({ lev }: { lev: number | null | undefined }) {
  if (lev === undefined) return null;
  const b = levBandOf(lev);
  return <i className="lqm-lev-dot" style={{ background: LEV_COLOR[b ?? 'unknown'] }} title={lev === null ? 'Leverage not known' : `${lev >= 1000 ? 'No margin left' : `${fmtFixed(lev, lev < 10 ? 1 : 0)}×`} (${LEV_LABEL[b ?? 'unknown']})`} aria-hidden="true" />;
}

function Details({ coin, venues, pick, price, wallets, lev, onClose }: { coin: string; venues: Venue[]; pick: Pick; price: number | null; wallets: string[]; lev: LevFilter; onClose: () => void }) {
  const [side, setSide] = useState(pick.side);
  useEffect(() => setSide(pick.side), [pick]);
  const levKey = lev.join(',');
  // Only the bands shown: the server filters, so the total and the top 25 are of those alone.
  const fetcher = useCallback((s: AbortSignal) => vsApi.liquidationWallets(coin, venues, side, pick.from, pick.to, s, wallets, isAllLev(lev) ? [] : lev), [coin, venues, side, pick, wallets, levKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = usePolled<LiqWallets>(`${coin}|${venues.join(',')}|${side}|${pick.from}|${pick.to}|${wallets.join(',')}|${levKey}`, fetcher, 30_000);
  const mid = (pick.from + pick.to) / 2;
  const d = r.data;
  return (
    <aside className="lqm-det" aria-label="Liquidation details">
      <header>
        <b>Liquidation details</b>
        <button type="button" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <dl>
        <dt>Price range</dt><dd>{fmtPx(pick.from)} – {fmtPx(pick.to)}</dd>
        <dt>From current</dt><dd>{price ? pct(mid / price - 1) : '–'}</dd>
        {/* When the positions listed were taken (the cohort load), not the time on this screen. */}
        <dt>As of</dt><dd>{asOfText(d?.asOf)?.slice('As of '.length) ?? '…'}</dd>
        {!isAllLev(lev) && <><dt>Leverage</dt><dd>{lev.map((b) => LEV_LABEL[b]).join(', ')}</dd></>}
      </dl>
      <div className="lqm-seg lqm-det-side">
        <button type="button" className={side === 'long' ? 'is-on' : ''} onClick={() => setSide('long')}>Longs</button>
        <button type="button" className={side === 'short' ? 'is-on' : ''} onClick={() => setSide('short')}>Shorts</button>
      </div>
      <p className="lqm-det-sum">
        {side === 'long' ? 'Long' : 'Short'} liquidations{d ? ` (${d.count})` : ''}
        <strong className={side === 'long' ? 'is-long' : 'is-short'}>{d ? fmtUsdShort(d.total) : '…'}</strong>
      </p>
      <p className="lqm-det-h">Top {side} liquidations</p>
      <ol className="lqm-det-list">
        {r.error && !d && <li className="lqm-empty">{r.error}</li>}
        {d && !d.wallets.length && <li className="lqm-empty">None in this range.</li>}
        {d?.wallets.map((w) => (
          <li key={`${w.venue}|${w.address}`} className={side === 'long' ? 'is-long' : 'is-short'}>
            <span className="lqm-det-who" title={`${VENUE_LABEL[w.venue]} · ${w.address}`}>
              <VenueLogo venue={w.venue} size={12} />
              <LevDot lev={w.lev} />
              {w.label ?? shortAddr(w.address)}
            </span>
            <span className="lqm-det-usd">{fmtUsdShort(w.usd)}</span>
            <span className="lqm-det-sz">{fmtSize(Math.abs(w.szi))} {coin} @ {fmtPx(w.liq)}{w.lev != null ? ` · ${w.lev >= 1000 ? 'no margin left' : `${fmtFixed(w.lev, w.lev < 10 ? 1 : 0)}×`}` : ''}</span>
            <span className="lqm-det-dist">{w.dist === null ? '' : `${fmtFixed(Math.abs(w.dist) * 100, 1)}% away`}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

// --- coverage -----------------------------------------------------------------------------

function Coverage({ h, coin }: { h: Heat; coin: string }) {
  const rows = (Object.entries(h.coverage) as Array<[Venue, NonNullable<Heat['coverage'][Venue]>]>).filter(([, c]) => c.oi !== null || c.positions > 0);
  if (!rows.length) return null;
  return (
    <div className="lqm-cov" aria-label="Coverage">
      {rows.map(([v, c]) => {
        // Honest labels (coverageText.ts): accuracy is the drift between reads; "priced" leaves out positions that never liquidate.
        const t = coverageText(c, VENUE_LABEL[v], coin, fmtSize);
        return (
          <span key={v} className="lqm-cov-row" title={t.lines.join('\n')}>
            <VenueLogo venue={v} size={12} />
            <span>{t.share}</span>
            {t.priced && <span className="lqm-cov-dim">{t.priced}</span>}
            <span className="lqm-cov-dim">{t.accuracy}</span>
          </span>
        );
      })}
    </div>
  );
}
