/**
 * The liquidation heatmap widget: where the positions of the market on screen
 * get liquidated, across the venues picked (all by default).
 *
 *   Live        notional per price bucket - longs (red) below the price, shorts
 *               (green) above - with the cumulative curves on a second axis.
 *   Chart       the same levels as horizontal bars beside the market's candles.
 *   Historical  the levels over time, from the indexer's 15-minute snapshots.
 *
 * A bar opens its wallets (address, size @ liquidation price, USD, distance).
 * The strip at the bottom says how much of each venue's open interest the books
 * hold and how well the math has matched the venue's own liquidation prices
 * (server indexer/liqRead.ts) - the heatmap is only as complete as that.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { LiqHeatmap as HeatApi, LiqHistory, LiqWallets } from '@sign/indexer/liqRead.js';
import { api, type Engine, type Kline } from '../../api';
import { useStored } from '../../hooks';
import { SCAN_VENUES, VENUE_LABEL, vsApi, type Venue } from '../../vsApi';
import { PlatformSelect } from '../PlatformSelect';
import { VenueLogo } from '../VenueLogo';
import { fmtPx, fmtUsdShort } from '../explore/model';
import { usePolled } from '../explore/cohorts/parts';
import { useLiveHeat } from './liveHeat';
import { shortAddr } from '../../format';
import { fmtFixed, fmtNum } from '../../numStyle';
import './LiqHeatmap.css';

type View = 'live' | 'chart' | 'history';
type Res = 'fine' | 'medium' | 'coarse';
type Unit = 'usd' | 'coin';
type Range = '1d' | '7d' | '30d';
const TFS = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;
type Tf = (typeof TFS)[number];

interface Prefs {
  view: View;
  res: Res;
  unit: Unit;
  venues: Venue[];
  tf: Tf;
  range: Range;
}
const DEFAULTS: Prefs = { view: 'live', res: 'fine', unit: 'usd', venues: [...SCAN_VENUES], tf: '1h', range: '1d' };

/** A market's coin, as the server nets it (cohorts/model.ts coinOf): `BTC-USD` -> BTC, `vETH_vUSDC` -> ETH, `xyz:TSLA` -> TSLA. */
export function coinOfSymbol(symbol: string): string {
  const tail = symbol.includes(':') ? symbol.slice(symbol.indexOf(':') + 1) : symbol;
  const head = tail.split(/[-/_]/)[0] ?? tail;
  return head.replace(/^v(?=[A-Z])/, '').toUpperCase();
}

/** [low price, long USD, short USD, long size, short size, long n, short n]. */
type Bucket = [number, number, number, number, number, number, number];
type Heat = Omit<HeatApi, 'buckets'> & { buckets: Bucket[] };

/** The API's rows ([index, long USD, short USD, long n, short n]) as buckets; sizes are USD over the bucket's middle (0.02% buckets). */
function fromApi(a: HeatApi): Heat {
  const p = a.price;
  const buckets: Bucket[] = [];
  for (const [i, l0, s0, ln0, sn0] of a.buckets) {
    const lo = +(i * a.step).toPrecision(12);
    // A level the price has already crossed (a long priced above it, a short below) is past, not a level.
    const pastL = p !== null && lo >= p;
    const pastS = p !== null && lo + a.step <= p;
    const l = pastL ? 0 : l0;
    const sh = pastS ? 0 : s0;
    if (!l && !sh) continue;
    const mid = lo + a.step / 2;
    buckets.push([lo, l, sh, l / mid, sh / mid, pastL ? 0 : ln0, pastS ? 0 : sn0]);
  }
  return { ...a, buckets };
}
/** One bucket's figure in the unit shown: [long, short]. */
const valOf = (b: Bucket, unit: Unit): [number, number] => (unit === 'usd' ? [b[1], b[2]] : [b[3], b[4]]);

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

/** The price window the levels fill, with the price inside and a margin. */
function windowOf(h: Heat): [number, number] | null {
  const p = h.price;
  if (!p) return null;
  let lo = p;
  let hi = p;
  let total = 0;
  for (const b of h.buckets) total += b[1] + b[2];
  // Leave out the thinnest tails (0.5% of the notional each side) so one far order does not flatten the rest.
  let acc = 0;
  for (const b of h.buckets) {
    acc += b[1] + b[2];
    if (acc >= total * 0.005) { lo = Math.min(lo, b[0]); break; }
  }
  acc = 0;
  for (let i = h.buckets.length - 1; i >= 0; i--) {
    const b = h.buckets[i]!;
    acc += b[1] + b[2];
    if (acc >= total * 0.005) { hi = Math.max(hi, b[0] + h.step); break; }
  }
  lo = Math.max(p * 0.4, Math.min(lo, p * 0.9));
  hi = Math.min(p * 1.8, Math.max(hi, p * 1.1));
  const pad = (hi - lo) * 0.02;
  return [lo - pad, hi + pad];
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

interface Pick { from: number; to: number; side: 'long' | 'short' }

/** Pixels a bucket takes on screen per resolution: the bucket width follows the zoom and the timeframe. */
const RES_PX: Record<Res, number> = { fine: 2, medium: 5, coarse: 12 };
/** Multiples of the server's bucket a group may span: the widths stay round numbers. */
const MULTIPLES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** How many server buckets make one on screen: `span` of price across `px` pixels. */
export function groupFor(step: number, span: number, px: number, res: Res): number {
  const want = (span * RES_PX[res]) / Math.max(1, px);
  return MULTIPLES.find((k) => step * k >= want) ?? MULTIPLES[MULTIPLES.length - 1]!;
}

/**
 * The bar width a view draws, in the server's buckets, told to the stream a quarter
 * second after it settles (a zoom subscribes again at the new width); drawn at once
 * from what is held meanwhile.
 */
function useStreamWidth(rawStep: number, span: number, px: number, res: Res, onWant: (k: number) => void): number {
  const want = groupFor(rawStep, span, px, res);
  useEffect(() => {
    const t = setTimeout(() => onWant(want), 250);
    return () => clearTimeout(t);
  }, [want, onWant]);
  return want;
}

/** Buckets summed `k` server buckets at a time. */
export function regroup(h: Heat, k: number): Heat {
  if (k <= 1) return h;
  const step = +(h.step * k).toPrecision(12);
  const by = new Map<number, Bucket>();
  for (const b of h.buckets) {
    const i = Math.floor(b[0] / step + 1e-9);
    let x = by.get(i);
    if (!x) { x = [+(i * step).toPrecision(12), 0, 0, 0, 0, 0, 0]; by.set(i, x); }
    for (let j = 1; j < 7; j++) x[j] = x[j]! + b[j]!;
  }
  return { ...h, step, buckets: [...by.values()].sort((a, b) => a[0] - b[0]) };
}

export function LiqHeatmap({ symbol, engine, instance }: { symbol: string; engine: Engine; instance?: string }) {
  const [stored, setStored] = useStored<Prefs>(`vs.liqmap${instance ? `.${instance}` : ''}`, DEFAULTS);
  const prefs: Prefs = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  const venues = (Array.isArray(prefs.venues) ? prefs.venues : []).filter((v): v is Venue => (SCAN_VENUES as readonly string[]).includes(v));
  const chosen = venues.length ? venues : [...SCAN_VENUES];
  const set = (p: Partial<Prefs>) => setStored({ ...prefs, ...p });
  const coin = coinOfSymbol(symbol);
  const [pick, setPick] = useState<Pick | null>(null);
  useEffect(() => setPick(null), [coin, chosen.join(','), prefs.res]);

  const vkey = chosen.join(',');
  // Live over the WebSocket (a second apart); over HTTP, a read a minute, while the socket is down.
  // The stream is summed to the bar width the view draws (in server buckets); the views ask for it as they zoom.
  const [wantK, setWantK] = useState(5);
  const live = useLiveHeat(coin, chosen, prefs.view !== 'history', wantK);
  const streamK = live.data ? live.k : 1;
  const heat = usePolled<HeatApi>(prefs.view === 'history' || live.connected ? null : `${coin}|${vkey}`, (s) => vsApi.liquidations(coin, chosen, 'fine', s), 60_000);
  const apiData = live.data ?? heat.data;
  const raw = useMemo(() => (apiData ? fromApi(apiData) : null), [apiData]);
  const h = raw;

  return (
    <div className="lqm">
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
        {prefs.view !== 'history' && (
          <div className="lqm-seg" aria-label="Bucket size">
            {(['fine', 'medium', 'coarse'] as const).map((r) => (
              <button key={r} type="button" aria-pressed={prefs.res === r} className={prefs.res === r ? 'is-on' : ''} onClick={() => set({ res: r })}>{r[0]!.toUpperCase() + r.slice(1)}</button>
            ))}
          </div>
        )}
        {prefs.view === 'chart' && (
          <div className="lqm-seg" aria-label="Timeframe">
            {TFS.map((t) => <button key={t} type="button" aria-pressed={prefs.tf === t} className={prefs.tf === t ? 'is-on' : ''} onClick={() => set({ tf: t })}>{t}</button>)}
          </div>
        )}
        {prefs.view === 'history' && (
          <div className="lqm-seg" aria-label="Range">
            {(['1d', '7d', '30d'] as const).map((r) => <button key={r} type="button" aria-pressed={prefs.range === r} className={prefs.range === r ? 'is-on' : ''} onClick={() => set({ range: r })}>{r.toUpperCase()}</button>)}
          </div>
        )}
        {prefs.view !== 'history' && (
          <div className="lqm-seg" aria-label="Unit">
            <button type="button" aria-pressed={prefs.unit === 'coin'} className={prefs.unit === 'coin' ? 'is-on' : ''} onClick={() => set({ unit: 'coin' })}>{coin}</button>
            <button type="button" aria-pressed={prefs.unit === 'usd'} className={prefs.unit === 'usd' ? 'is-on' : ''} onClick={() => set({ unit: 'usd' })}>USD</button>
          </div>
        )}
      </div>
      {prefs.view !== 'history' && (
        <div className="lqm-legend">
          <span><i className="lqm-sw is-long" />Long liquidations</span>
          <span><i className="lqm-sw is-short" />Short liquidations</span>
          {prefs.view === 'live' && <><span><i className="lqm-ln is-long" />Cumulative longs</span><span><i className="lqm-ln is-short" />Cumulative shorts</span></>}
        </div>
      )}
      <div className="lqm-body">
        {prefs.view === 'history' ? (
          <HistoryView coin={coin} venues={chosen} range={prefs.range} />
        ) : !h ? (
          <p className="lqm-empty">{heat.error ? `Liquidation levels unavailable: ${heat.error}` : 'Reading the books…'}</p>
        ) : !h.price || !h.buckets.length ? (
          <p className="lqm-empty">No tracked {coin} positions with a liquidation price on {chosen.length === SCAN_VENUES.length ? 'any platform' : chosen.map((v) => VENUE_LABEL[v]).join(', ')}.</p>
        ) : prefs.view === 'live' ? (
          <LiveView h={h} unit={prefs.unit} res={prefs.res} streamK={streamK} onWant={setWantK} onPick={setPick} pick={pick} />
        ) : (
          <ChartView h={h} unit={prefs.unit} res={prefs.res} streamK={streamK} onWant={setWantK} engine={engine} symbol={symbol} tf={prefs.tf} onPick={setPick} pick={pick} />
        )}
        {pick && h && prefs.view !== 'history' && <Details coin={coin} venues={chosen} pick={pick} price={h.price} onClose={() => setPick(null)} />}
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

function ZoomButtons({ onIn, onOut, onReset, hint }: { onIn: () => void; onOut: () => void; onReset: () => void; hint: string }) {
  return (
    <div className="lqm-zoom" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button type="button" title="Zoom in" aria-label="Zoom in" onClick={onIn}>+</button>
      <button type="button" title="Zoom out" aria-label="Zoom out" onClick={onOut}>−</button>
      <button type="button" title={`Reset the axes (or double-click). ${hint}`} aria-label="Reset the axes" onClick={onReset}>⟲</button>
    </div>
  );
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

// --- live ---------------------------------------------------------------------------------

const M = { l: 56, r: 60, t: 10, b: 24 };

function LiveView({ h: base, unit, res, streamK, onWant, onPick, pick }: { h: Heat; unit: Unit; res: Res; streamK: number; onWant: (k: number) => void; onPick: (p: Pick) => void; pick: Pick | null }) {
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
  const cum = useMemo(() => cumulative(base, unit), [base, unit]);
  const W = Math.max(1, w - M.l - M.r);
  const H = Math.max(1, ht - M.t - M.b);
  // Zoom and pan stay between 0 and the highest short liquidation (or a little past the price).
  const top = useMemo(() => {
    let t = (base.price ?? 0) * 1.1;
    for (const b of base.buckets) if (b[2] > 0) t = Math.max(t, b[0] + base.step);
    return t;
  }, [base]);
  const clamp = ([a, b]: [number, number]): [number, number] => {
    const span = Math.min(b - a, top);
    let lo2 = a;
    let hi2 = a + span;
    if (lo2 < 0) { lo2 = 0; hi2 = span; }
    if (hi2 > top) { hi2 = top; lo2 = top - span; }
    return [lo2, hi2];
  };
  const win = view ?? (auto && clamp(auto));
  const p = base.price!;
  const [lo, hi] = win ?? [p * 0.5, p * 1.5];
  const want = useStreamWidth(base.step / streamK, hi - lo, W, res, onWant);
  const k = Math.max(1, Math.round(want / streamK));
  const h = useMemo(() => regroup(base, k), [base, k]);
  const shown = h.buckets.filter((b) => b[0] + h.step > lo && b[0] < hi);
  const fitBar = Math.max(1e-12, ...shown.map((b) => Math.max(...valOf(b, unit))));
  const fitCum = Math.max(1e-12, ...[...cum.long, ...cum.short].filter(([px]) => px >= lo && px <= hi).map(([, v]) => v));
  const maxBar = barMax === null ? fitBar * 1.05 : Math.min(fitBar * 1.05, Math.max(fitBar * 0.02, barMax));
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
    if (cx < M.l) setBarMax(Math.min(fitBar * 1.05, Math.max(fitBar * 0.02, maxBar * f)));
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
            {shown.map((b) => {
              const [l, s] = valOf(b, unit);
              const on = pick && Math.abs(pick.from - b[0]) < h.step / 2;
              return (
                <g key={b[0]} className={on ? 'is-picked' : ''}>
                  {l > 0 && <rect x={x(b[0])} y={yBar(l)} width={bw} height={M.t + H - yBar(l)} className="lqm-bar-long" />}
                  {s > 0 && <rect x={x(b[0])} y={yBar(s)} width={bw} height={M.t + H - yBar(s)} className="lqm-bar-short" />}
                </g>
              );
            })}
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
      <ZoomButtons onIn={() => zoom(0.7, p >= lo && p <= hi ? (p - lo) / (hi - lo) : 0.5)} onOut={() => zoom(1 / 0.7, p >= lo && p <= hi ? (p - lo) / (hi - lo) : 0.5)} onReset={reset} hint="Wheel zooms the price, drag pans; wheel or drag on a side axis scales it." />
      {hover !== null && !drag.dragging() && (
        <div className="lqm-tip" style={{ left: Math.min(w - 210, Math.max(0, x(hover) + 12)), top: M.t + 6 }}>
          <b>{fmtPx(hover)} – {fmtPx(hover + h.step)}</b>
          <span>{pct(hover / p - 1)} from current</span>
          {hb ? (
            <>
              {hb[1] > 0 && <span className="is-long">Longs {fmtVal(valOf(hb, unit)[0], unit, h.coin)} · {hb[5]} positions</span>}
              {hb[2] > 0 && <span className="is-short">Shorts {fmtVal(valOf(hb, unit)[1], unit, h.coin)} · {hb[6]} positions</span>}
            </>
          ) : <span>No liquidations here</span>}
          <span className="lqm-tip-sub">Cumulative {hover < p ? `longs ${fmtVal(cumAt(hover, 'long'), unit, h.coin)}` : `shorts ${fmtVal(cumAt(hover, 'short'), unit, h.coin)}`}</span>
          <span className="lqm-tip-sub">Click for the wallets</span>
        </div>
      )}
    </div>
  );
}

// --- chart --------------------------------------------------------------------------------

const TF_POLL: Record<Tf, number> = { '1m': 10_000, '5m': 20_000, '15m': 30_000, '1h': 60_000, '4h': 60_000, '1D': 120_000 };
const CANDLES = 500;

function ChartView({ h: base, unit, res, streamK, onWant, engine, symbol, tf, onPick, pick }: { h: Heat; unit: Unit; res: Res; streamK: number; onWant: (k: number) => void; engine: Engine; symbol: string; tf: Tf; onPick: (p: Pick) => void; pick: Pick | null }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [ref, { w, h: ht }] = useSize<HTMLDivElement>();
  const bind = useCallback((x: HTMLDivElement | null) => { ref(x); setEl(x); }, [ref]);
  const [hover, setHover] = useState<number | null>(null);
  const k = usePolled<Kline[]>(`${engine}|${symbol}|${tf}`, () => api.klines(engine, symbol, tf, CANDLES).then((r) => r.klines), TF_POLL[tf]);
  const candles = useMemo(() => (k.data ?? []).map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c })).filter((c) => c.h > 0).sort((a, b) => a.t - b.t), [k.data]);
  const cum = useMemo(() => cumulative(base, unit), [base, unit]);
  /** Candles shown, and how many back from the newest the view ends. */
  const [span, setSpan] = useState(120);
  const [back, setBack] = useState(0);
  /** The price axis: null follows the candles shown. */
  const [yv, setYv] = useState<[number, number] | null>(null);
  const [profMax, setProfMax] = useState<number | null>(null);
  useEffect(() => { setYv(null); setBack(0); setProfMax(null); }, [base.coin, tf]);
  const p = base.price!;
  const R = Math.min(240, Math.max(130, w * 0.28));
  const ML = 8;
  const MR = 62;
  const W = Math.max(1, w - ML - MR);
  const H = Math.max(1, ht - M.t - M.b);
  const cw = Math.max(1, W - R);
  const n = candles.length;
  const nShow = Math.max(10, Math.min(Math.max(10, n), Math.round(span)));
  const end = Math.max(0, Math.min(n, n - Math.round(back)));
  const vis = candles.slice(Math.max(0, end - nShow), end);
  const slot = cw / nShow;
  // The price axis by default: the candles shown with room either side (12% of the price), so the levels near the price show.
  let aLo = p * 0.88;
  let aHi = p * 1.12;
  for (const c of vis) { aLo = Math.min(aLo, c.l); aHi = Math.max(aHi, c.h); }
  const padY = (aHi - aLo) * 0.08;
  const [lo, hi] = yv ?? [aLo - padY, aHi + padY];
  const y = (v: number) => M.t + H - ((v - lo) / (hi - lo)) * H;
  const priceAt = (py: number) => lo + ((M.t + H - py) / H) * (hi - lo);
  const want = useStreamWidth(base.step / streamK, hi - lo, H, res, onWant);
  const group = Math.max(1, Math.round(want / streamK));
  const h = useMemo(() => regroup(base, group), [base, group]);
  const shown = h.buckets.filter((b) => b[0] + h.step > lo && b[0] < hi);
  const fitBar = Math.max(1e-12, ...shown.map((b) => Math.max(...valOf(b, unit))));
  const maxBar = profMax ?? fitBar;
  const fitCum = Math.max(1e-12, ...[...cum.long, ...cum.short].filter(([v]) => v >= lo && v <= hi).map(([, v]) => v));
  const x0 = ML + W; // the bars grow left from the price axis
  const bx = (v: number) => Math.min(1, v / maxBar) * (R - 8);
  const cx = (v: number) => x0 - Math.min(1, v / fitCum) * (R - 8);
  const ph = (h.step / (hi - lo)) * H;
  const bh = Math.max(1, ph > 4 ? ph - 0.5 : ph);
  const area = (pts: Array<[number, number]>) => {
    const inWin = pts.filter(([v]) => v >= lo - h.step && v <= hi + h.step);
    if (!inWin.length) return null;
    let d = `M${x0},${y(p)}`;
    for (const [v, c] of inWin) d += ` V${y(v)} H${cx(c)}`;
    const line = d;
    return { line, fill: `${d} V${y(inWin.at(-1)![0])} H${x0} Z` };
  };
  const longA = area(cum.long);
  const shortA = area(cum.short);
  const ys = ticks(lo, hi, Math.max(2, Math.floor(H / 45)));
  const fmtT = (t: number) => {
    const d = new Date(t);
    return tf === '1D' ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const zoomY = (f: number, at = (lo + hi) / 2) => setYv(zoomAt([lo, hi], at, f));
  const zoomT = (f: number) => setSpan((s) => Math.max(10, Math.min(Math.max(10, n), s * f)));
  useWheel(el, (e) => {
    const r = el!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const f = wheelFactor(e);
    if (px > ML + cw - 4 || e.shiftKey) zoomY(f, priceAt(py));
    else zoomT(f);
  });
  const drag = useDrag((dx, dy, start) => {
    setHover(null);
    if (start.x > ML + W) { zoomY(Math.exp(dy / 150)); return; }
    if (start.x > ML + cw - 4 && start.x <= ML + W) return;
    setBack((b) => Math.max(0, Math.min(Math.max(0, n - 10), b + dx / slot)));
    const d = (dy / H) * (hi - lo);
    setYv([lo + d, hi + d]);
  }, (px, py) => {
    if (px < ML + cw - 4 || px > ML + W || py < M.t || py > M.t + H) return;
    const { from, b } = nearestBucket(h, shown, priceAt(py), (8 / H) * (hi - lo));
    setHover(from);
    onPick({ from, to: from + h.step, side: sideOf(b, from, h.step, p) });
  });
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.onPointerMoveDrag(e)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const py = e.clientY - r.top;
    const px = e.clientX - r.left;
    if (px < ML + cw - 4 || px > ML + W || py < M.t || py > M.t + H) { setHover(null); return; }
    setHover(Math.floor(priceAt(py) / h.step) * h.step);
  };
  const reset = () => { setYv(null); setBack(0); setSpan(120); setProfMax(null); };
  const hb = hover !== null ? h.buckets.find((b) => Math.abs(b[0] - hover) < h.step / 2) ?? null : null;
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
      {w > 0 && (
        <svg width={w} height={ht} role="img" aria-label={`${h.coin} candles with liquidation levels`}>
          <defs><clipPath id="lqm-clip-chart"><rect x={ML} y={M.t} width={W} height={H} /></clipPath></defs>
          {ys.map((v) => (
            <g key={v}>
              <line x1={ML} x2={ML + W} y1={y(v)} y2={y(v)} className="lqm-grid" />
              <text x={ML + W + 6} y={y(v) + 3} className="lqm-ax">{fmtPx(v)}</text>
            </g>
          ))}
          <rect x={ML + W} y={M.t} width={MR} height={H} className="lqm-axis-hit is-y" />
          <g clipPath="url(#lqm-clip-chart)">
            {vis.map((c, i) => {
              const xc = ML + slot * (i + 0.5);
              const up = c.c >= c.o;
              return (
                <g key={c.t} className={up ? 'lqm-up' : 'lqm-down'}>
                  <line x1={xc} x2={xc} y1={y(c.h)} y2={y(c.l)} />
                  <rect x={xc - Math.max(0.5, slot * 0.35)} width={Math.max(1, slot * 0.7)} y={y(Math.max(c.o, c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} />
                </g>
              );
            })}
            {shortA && <path d={shortA.fill} className="lqm-area is-short" />}
            {longA && <path d={longA.fill} className="lqm-area is-long" />}
            {shown.map((b) => {
              const [l, s] = valOf(b, unit);
              const on = pick && Math.abs(pick.from - b[0]) < h.step / 2;
              const yy = y(b[0] + h.step);
              return (
                <g key={b[0]} className={on ? 'is-picked' : ''}>
                  {l > 0 && <rect x={x0 - bx(l)} y={yy} width={bx(l)} height={bh} className="lqm-bar-long" />}
                  {s > 0 && <rect x={x0 - bx(s)} y={yy} width={bx(s)} height={bh} className="lqm-bar-short" />}
                </g>
              );
            })}
            {shortA && <path d={shortA.line} className="lqm-cum is-short" />}
            {longA && <path d={longA.line} className="lqm-cum is-long" />}
            <line x1={ML} x2={ML + W} y1={y(p)} y2={y(p)} className="lqm-now" />
            {hover !== null && <rect x={ML} y={y(hover + h.step)} width={W} height={Math.max(2, bh)} className="lqm-hover" />}
          </g>
          {vis.length > 0 && ticks(0, vis.length - 1, Math.max(2, Math.floor(cw / 90))).map((i) => {
            const c = vis[Math.round(i)];
            return c ? <text key={`t${i}`} x={ML + slot * (Math.round(i) + 0.5)} y={M.t + H + 16} className="lqm-ax" textAnchor="middle">{fmtT(c.t)}</text> : null;
          })}
          {p >= lo && p <= hi && (
            <g transform={`translate(${ML + W + 2},${y(p) - 9})`}>
              <rect width={MR - 4} height={18} rx={3} className="lqm-now-tag is-solid" />
              <text x={(MR - 4) / 2} y={13} textAnchor="middle" className="lqm-now-text">{fmtPx(p)}</text>
            </g>
          )}
          {!n && <text x={ML + cw / 2} y={M.t + H / 2} textAnchor="middle" className="lqm-ax">{k.error ? 'No candles for this market' : 'Loading candles…'}</text>}
        </svg>
      )}
      <ZoomButtons onIn={() => zoomY(0.7, p >= lo && p <= hi ? p : undefined)} onOut={() => zoomY(1 / 0.7, p >= lo && p <= hi ? p : undefined)} onReset={reset} hint="Wheel zooms time, wheel on the price scale (or Shift+wheel) zooms price; drag pans." />
      {hover !== null && !drag.dragging() && (
        <div className="lqm-tip" style={{ right: R + MR, top: Math.min(ht - 120, Math.max(0, y(hover) - 20)) }}>
          <b>{fmtPx(hover)} – {fmtPx(hover + h.step)}</b>
          <span>{pct(hover / p - 1)} from current</span>
          {hb ? (
            <>
              {hb[1] > 0 && <span className="is-long">Longs {fmtVal(valOf(hb, unit)[0], unit, h.coin)} · {hb[5]}</span>}
              {hb[2] > 0 && <span className="is-short">Shorts {fmtVal(valOf(hb, unit)[1], unit, h.coin)} · {hb[6]}</span>}
            </>
          ) : <span>No liquidations here</span>}
          <span className="lqm-tip-sub">Click for the wallets</span>
        </div>
      )}
    </div>
  );
}

// --- history ------------------------------------------------------------------------------

function HistoryView({ coin, venues, range }: { coin: string; venues: Venue[]; range: Range }) {
  const r = usePolled<LiqHistory>(`${coin}|${venues.join(',')}|${range}`, (s) => vsApi.liquidationHistory(coin, venues, range, s), 5 * 60_000);
  const [ref, { w, h: ht }] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string[] } | null>(null);
  const pts = r.data?.points ?? [];
  const geo = useMemo(() => {
    if (!pts.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    let max = 0;
    for (const q of pts) {
      lo = Math.min(lo, q.p * 0.75);
      hi = Math.max(hi, q.p * 1.25);
      for (const [, l, s] of q.b) max = Math.max(max, l + s);
    }
    return { lo, hi, max, t0: pts[0]!.t, t1: pts.at(-1)!.t };
  }, [pts]);
  const ML = 8;
  const MR = 58;
  const W = Math.max(0, w - ML - MR);
  const H = Math.max(0, ht - M.t - M.b);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !geo || !w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = ht * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, ht);
    const { lo, hi, max, t0, t1 } = geo;
    const span = Math.max(1, t1 - t0);
    const colW = Math.max(1, W / Math.max(1, pts.length));
    const y = (v: number) => M.t + H - ((v - lo) / (hi - lo)) * H;
    const lmax = Math.log1p(max);
    pts.forEach((q, i) => {
      const x = ML + (pts.length > 1 ? ((q.t - t0) / span) * (W - colW) : 0);
      for (const [bi, l, s] of q.b) {
        const v = l + s;
        if (!(v > 0)) continue;
        const a = Math.log1p(v) / lmax;
        const top = y((bi + 1) * q.st);
        const hh = Math.max(1, y(bi * q.st) - top);
        // Long-heavy cells lean red, short-heavy green; brightness is the notional (log).
        const share = l / v;
        const rr = Math.round(239 * share + 0 * (1 - share));
        const gg = Math.round(74 * share + 180 * (1 - share));
        const bb = Math.round(60 * share + 129 * (1 - share));
        g.fillStyle = `rgba(${rr},${gg},${bb},${(0.12 + 0.88 * a).toFixed(3)})`;
        g.fillRect(x, top, colW + 0.5, hh);
      }
      void i;
    });
    // The price over time.
    g.strokeStyle = 'rgba(247,247,247,0.85)';
    g.lineWidth = 1.25;
    g.beginPath();
    pts.forEach((q, i) => {
      const x = ML + (pts.length > 1 ? ((q.t - t0) / span) * (W - colW) : 0) + colW / 2;
      if (i) g.lineTo(x, y(q.p)); else g.moveTo(x, y(q.p));
    });
    g.stroke();
  }, [geo, pts, w, ht, W, H]);
  if (r.error && !r.data) return <p className="lqm-empty">History unavailable: {r.error}</p>;
  if (!r.data) return <p className="lqm-empty">Reading the snapshots…</p>;
  if (!pts.length) {
    return (
      <p className="lqm-empty">
        No snapshots of {coin} yet. The index keeps the levels of the {r.data.coins.length || 30} coins with the most open interest tracked, every 15 minutes
        {r.data.coins.length ? ` (now: ${r.data.coins.slice(0, 12).join(', ')}…)` : ''}.
      </p>
    );
  }
  const g = geo!;
  const y = (v: number) => M.t + H - ((v - g.lo) / (g.hi - g.lo)) * H;
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px < ML || px > ML + W || py < M.t || py > M.t + H) { setTip(null); return; }
    const t = g.t0 + ((px - ML) / Math.max(1, W)) * (g.t1 - g.t0);
    let q = pts[0]!;
    for (const x of pts) if (Math.abs(x.t - t) < Math.abs(q.t - t)) q = x;
    const price = g.lo + ((M.t + H - py) / H) * (g.hi - g.lo);
    const bi = Math.floor(price / q.st);
    const cell = q.b.find((b) => b[0] === bi);
    setTip({
      x: px, y: py,
      text: [
        new Date(q.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
        `${fmtPx(bi * q.st)} – ${fmtPx((bi + 1) * q.st)} (${pct(bi * q.st / q.p - 1)} from ${fmtPx(q.p)})`,
        cell ? `Longs ${fmtUsdShort(cell[1])} · Shorts ${fmtUsdShort(cell[2])}` : 'No liquidations here',
      ],
    });
  };
  return (
    <div ref={ref} className="lqm-plot" onPointerMove={move} onPointerLeave={() => setTip(null)}>
      <canvas ref={canvas} style={{ width: w, height: ht }} />
      <svg width={w} height={ht} className="lqm-over">
        {ticks(g.lo, g.hi, Math.max(2, Math.floor(H / 50))).map((v) => <text key={v} x={ML + W + 6} y={y(v) + 3} className="lqm-ax">{fmtPx(v)}</text>)}
        {ticks(g.t0, g.t1, Math.max(2, Math.floor(W / 110))).map((t) => (
          <text key={t} x={ML + ((t - g.t0) / Math.max(1, g.t1 - g.t0)) * W} y={M.t + H + 16} textAnchor="middle" className="lqm-ax">
            {new Date(t).toLocaleString('en-US', range === '1d' ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric' })}
          </text>
        ))}
      </svg>
      {tip && <div className="lqm-tip" style={{ left: Math.min(w - 230, tip.x + 12), top: Math.max(0, tip.y - 40) }}>{tip.text.map((t, i) => (i ? <span key={i}>{t}</span> : <b key={i}>{t}</b>))}</div>}
    </div>
  );
}

// --- details ------------------------------------------------------------------------------

function Details({ coin, venues, pick, price, onClose }: { coin: string; venues: Venue[]; pick: Pick; price: number | null; onClose: () => void }) {
  const [side, setSide] = useState(pick.side);
  useEffect(() => setSide(pick.side), [pick]);
  const fetcher = useCallback((s: AbortSignal) => vsApi.liquidationWallets(coin, venues, side, pick.from, pick.to, s), [coin, venues, side, pick]);
  const r = usePolled<LiqWallets>(`${coin}|${venues.join(',')}|${side}|${pick.from}|${pick.to}`, fetcher, 30_000);
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
        <dt>As of</dt><dd>{new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd>
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
              {w.label ?? shortAddr(w.address)}
            </span>
            <span className="lqm-det-usd">{fmtUsdShort(w.usd)}</span>
            <span className="lqm-det-sz">{fmtSize(Math.abs(w.szi))} {coin} @ {fmtPx(w.liq)}</span>
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
        const held = (c.long + c.short) / 2;
        const share = c.oi ? held / c.oi : null;
        const known = c.long + c.short > 0 ? (c.longKnown + c.shortKnown) / (c.long + c.short) : null;
        const acc = c.accuracy;
        const matched = acc && acc.checked ? acc.matched / acc.checked : null;
        const tracked = acc && acc.n ? acc.within1 / acc.n : null;
        const title = [
          `${VENUE_LABEL[v]} ${coin}: the books hold ${fmtSize(c.long)} long and ${fmtSize(c.short)} short in ${c.positions} positions`,
          c.past > 0 ? `${fmtSize(c.past)} ${coin} more is past its liquidation price (being liquidated, or a book not caught up yet): not in the bars` : '',
          c.oi !== null ? `against open interest of ${fmtSize(c.oi)} ${coin}${c.oiUsd ? ` (${fmtUsdShort(c.oiUsd)})` : ''}` : 'open interest unavailable',
          known !== null ? `${fmtFixed(known * 100, 1)}% of that size has a known liquidation price` : '',
          c.computed ? `${VENUE_LABEL[v]} publishes no liquidation price: computed from its maintenance margin rules` : '',
          matched !== null ? `At reads ${acc!.window === 'today' ? 'today' : 'yesterday'}: ${acc!.matched} of ${acc!.checked} venue figures reproduced to 0.01%` : '',
          tracked !== null ? `At re-reads: ${fmtFixed(tracked * 100, 1)}% of ${acc!.n} figures within 1% of the venue's new one (${acc!.moved} positions had changed size)` : '',
          c.noRules ? 'The market list could not be read: no levels' : '',
        ].filter(Boolean).join('\n');
        return (
          <span key={v} className="lqm-cov-row" title={title}>
            <VenueLogo venue={v} size={12} />
            <span>{share === null ? 'OI –' : `${share > 1.05 ? '>100' : Math.round(share * 100)}% of OI`}</span>
            {known !== null && known < 0.995 && <span className="lqm-cov-dim">{Math.round(known * 100)}% priced</span>}
            <span className="lqm-cov-dim">{c.computed ? 'computed' : matched !== null ? `${fmtFixed(matched * 100, matched >= 0.9995 ? 0 : 1)}% exact` : 'checking'}</span>
          </span>
        );
      })}
    </div>
  );
}
