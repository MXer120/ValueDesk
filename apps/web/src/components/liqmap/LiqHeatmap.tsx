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
import type { LiqAt, LiqHeatmap as HeatApi, LiqHistory, LiqWallets } from '@sign/indexer/liqRead.js';
import { api, type Engine, type Kline } from '../../api';
import { useStored } from '../../hooks';
import { SCAN_VENUES, VENUE_LABEL, vsApi, type Venue } from '../../vsApi';
import { PlatformSelect } from '../PlatformSelect';
import { VenueLogo } from '../VenueLogo';
import { fmtPx, fmtUsdShort } from '../explore/model';
import { usePolled } from '../explore/cohorts/parts';
import { useLiveHeat } from './liveHeat';
import { WalletView, type Res, type Side, type Unit } from './WalletView';
import { Chart } from '../Chart';
import type { Chart as KChart } from 'klinecharts';
import { CANDLE_PANE_ID } from '../../chart/theme';
import { HEAT_FLOOR, LIQ_HEAT, barMsOf, heatScale, liqHeatTemplate, snapshotFor, type HeatData, type HeatPoint } from '../../chart/liqHeatIndicator';
import { coinOfSymbol, groupFor } from '../../chart/liqMap';
import { shortAddr } from '../../format';
import { asOfText } from '../../asOf';
import { coverageText } from './coverageText';
import { fmtFixed, fmtNum } from '../../numStyle';
import './LiqHeatmap.css';

type View = 'live' | 'chart' | 'history';
const TFS = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;
type Tf = (typeof TFS)[number];

interface Prefs {
  view: View;
  res: Res;
  unit: Unit;
  venues: Venue[];
  tf: Tf;
  /** Only these wallets (none: every wallet), and which side - every view (WalletView.tsx). */
  wallets: string[];
  side: Side;
}
const DEFAULTS: Prefs = { view: 'live', res: 'fine', unit: 'usd', venues: [...SCAN_VENUES], tf: '1h', wallets: [], side: 'both' };

export { coinOfSymbol };

/** [low price, long USD, short USD, long size, short size, long n, short n]. */
type Bucket = [number, number, number, number, number, number, number];
type Heat = Omit<HeatApi, 'buckets'> & { buckets: Bucket[] };

/** The API's rows ([index, long USD, short USD, long n, short n]) as buckets; sizes are USD over the bucket's middle (0.02% buckets). */
function fromApi(a: HeatApi, side: Side = 'both'): Heat {
  const p = a.price;
  const buckets: Bucket[] = [];
  for (const [i, l0, s0, ln0, sn0] of a.buckets) {
    const lo = +(i * a.step).toPrecision(12);
    // A level the price has already crossed (a long priced above it, a short below) is past, not a level.
    const pastL = p !== null && lo >= p;
    const pastS = p !== null && lo + a.step <= p;
    const l = pastL || side === 'short' ? 0 : l0;
    const sh = pastS || side === 'long' ? 0 : s0;
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
    if (!x) { x = [+(i * step).toPrecision(12), 0, 0, 0, 0, 0, 0]; by.set(i, x); }
    for (let j = 1; j < 7; j++) x[j] = x[j]! + b[j]!;
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
  const wkey = wallets.join(',');
  const coin = coinOfSymbol(symbol);
  const [pick, setPick] = useState<Pick | null>(null);
  useEffect(() => setPick(null), [coin, chosen.join(','), prefs.res, wkey, prefs.view]);

  const vkey = chosen.join(',');
  // Live over the WebSocket (a second apart); over HTTP, a read a minute, while the socket is down.
  // The stream is summed to the bar width the view draws (in server buckets); the views ask for it as they zoom.
  const [wantK, setWantK] = useState(5);
  const live = useLiveHeat(coin, chosen, prefs.view !== 'history' && !wallets.length, wantK);
  const streamK = live.data ? live.k : 1;
  // Some wallets only: their levels read every 10 s (the stream is every wallet's).
  const heat = usePolled<HeatApi>(
    prefs.view === 'history' || (live.connected && !wallets.length) ? null : `${coin}|${vkey}|${wkey}`,
    (s) => vsApi.liquidations(coin, chosen, 'fine', s, wallets),
    wallets.length ? 10_000 : 60_000,
  );
  const apiData = wallets.length ? heat.data : live.data ?? heat.data;
  const raw = useMemo(() => (apiData ? fromApi(apiData, side) : null), [apiData, side]);
  const h = raw;
  const res: Res = prefs.res === 'medium' || prefs.res === 'coarse' ? prefs.res : 'fine';
  const unit: Unit = prefs.unit === 'coin' ? 'coin' : 'usd';
  // The bar width in server buckets: from the price and the resolution only (groupFor), told to the
  // stream a quarter second after it settles; drawn at once from what is held meanwhile.
  const rawStep = h ? h.step / streamK : 0;
  const want = h?.price && rawStep > 0 ? groupFor(rawStep, h.price, res) : wantK;
  useEffect(() => {
    const t = setTimeout(() => setWantK(want), 250);
    return () => clearTimeout(t);
  }, [want]);
  const barWidth = h?.price && rawStep > 0 ? rawStep * want : null;

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
        {prefs.view === 'chart' && (
          <div className="lqm-seg" aria-label="Timeframe">
            {TFS.map((t) => <button key={t} type="button" aria-pressed={prefs.tf === t} className={prefs.tf === t ? 'is-on' : ''} onClick={() => set({ tf: t })}>{t}</button>)}
          </div>
        )}
        <PlatformSelect options={SCAN_VENUES} value={chosen} onChange={(v) => set({ venues: v })} align="end" />
        <WalletView
          wallets={wallets}
          side={side}
          venues={chosen}
          self={address}
          bars={prefs.view !== 'history' ? { res, unit, coin, width: barWidth !== null ? `$${fmtPx(barWidth)}` : null } : null}
          onChange={(p) => set(p)}
          onReset={() => set({ wallets: [], side: 'both', res: 'fine', unit: 'usd' })}
        />
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
          <HistoryView coin={coin} venues={chosen} engine={engine} symbol={symbol} wallets={wallets} side={side} onPick={setPick} />
        ) : !h ? (
          <p className="lqm-empty">{heat.error ? `Liquidation levels unavailable: ${heat.error}` : 'Reading the books…'}</p>
        ) : !h.price || !h.buckets.length ? (
          <p className="lqm-empty">{wallets.length ? (wallets.length === 1 ? 'This wallet holds' : 'These wallets hold') + ` no ${coin} position with a liquidation price` : `No tracked ${coin} positions with a liquidation price`} on {chosen.length === SCAN_VENUES.length ? 'any platform' : chosen.map((v) => VENUE_LABEL[v]).join(', ')}.</p>
        ) : prefs.view === 'live' ? (
          <LiveView h={h} unit={unit} want={want} streamK={streamK} onPick={setPick} pick={pick} />
        ) : (
          <ChartView h={h} unit={unit} want={want} streamK={streamK} engine={engine} symbol={symbol} tf={prefs.tf} onPick={setPick} pick={pick} />
        )}
        {pick && h && prefs.view !== 'history' && <Details coin={coin} venues={chosen} pick={pick} price={h.price} wallets={wallets} onClose={() => setPick(null)} />}
        {pick?.at !== undefined && prefs.view === 'history' && <AtDetails coin={coin} venues={chosen} pick={pick as Required<Pick>} wallets={wallets} onClose={() => setPick(null)} />}
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

// --- live ---------------------------------------------------------------------------------

const M = { l: 56, r: 60, t: 10, b: 24 };

/** Wheel zooms the price, drag pans; wheel on a side axis scales it; a double-click resets the axes. */
function LiveView({ h: base, unit, want, streamK, onPick, pick }: { h: Heat; unit: Unit; want: number; streamK: number; onPick: (p: Pick) => void; pick: Pick | null }) {
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
/** Where the chart view starts: four empty slots right of the newest candle. */
const CHART_BACK = -4;

/** Wheel zooms time, wheel on the price scale (or Shift+wheel) zooms price, drag pans; a double-click resets. */
function ChartView({ h: base, unit, want, streamK, engine, symbol, tf, onPick, pick }: { h: Heat; unit: Unit; want: number; streamK: number; engine: Engine; symbol: string; tf: Tf; onPick: (p: Pick) => void; pick: Pick | null }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [ref, { w, h: ht }] = useSize<HTMLDivElement>();
  const bind = useCallback((x: HTMLDivElement | null) => { ref(x); setEl(x); }, [ref]);
  const [hover, setHover] = useState<number | null>(null);
  const k = usePolled<Kline[]>(`${engine}|${symbol}|${tf}`, () => api.klines(engine, symbol, tf, CANDLES).then((r) => r.klines), TF_POLL[tf]);
  const candles = useMemo(() => (k.data ?? []).map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c })).filter((c) => c.h > 0).sort((a, b) => a.t - b.t), [k.data]);
  const cum = useMemo(() => cumulative(base, unit), [base, unit]);
  /**
   * Candle slots shown, and how many slots back from the newest the view ends: below zero the
   * view runs past the newest candle into empty slots, as far as most of the width - room on the
   * right to see the levels next to the price; dragging moves it either way.
   */
  const [span, setSpan] = useState(120);
  const [back, setBack] = useState(CHART_BACK);
  /** The price axis: null follows the candles shown. */
  const [yv, setYv] = useState<[number, number] | null>(null);
  const [profMax, setProfMax] = useState<number | null>(null);
  useEffect(() => { setYv(null); setBack(CHART_BACK); setProfMax(null); }, [base.coin, tf]);
  const p = base.price!;
  const R = Math.min(240, Math.max(130, w * 0.28));
  const ML = 8;
  const MR = 62;
  const W = Math.max(1, w - ML - MR);
  const H = Math.max(1, ht - M.t - M.b);
  /** Where the profile's hover and click begin: its bars grow left from the price axis over the last R pixels. */
  const cw = Math.max(1, W - R);
  const n = candles.length;
  const nShow = Math.max(10, Math.min(Math.max(10, n), Math.round(span)));
  // The window in candle slots, [start, end): end past n is empty slots after the newest candle. The
  // candles run the whole width up to the price axis, over the profile, wherever the view is moved.
  const end = n - back;
  const start = end - nShow;
  const first = Math.max(0, Math.floor(start));
  const vis = candles.slice(first, Math.max(first, Math.min(n, Math.ceil(end))));
  const slot = W / nShow;
  /** The middle of candle slot `i` (an index into `candles`). */
  const xAt = (i: number) => ML + slot * (i - start + 0.5);
  const panBack = (b: number) => Math.max(-Math.floor(nShow * 0.85), Math.min(Math.max(0, n - 10), b));
  // The price axis by default: the candles shown with room either side (12% of the price), so the levels near the price show.
  let aLo = p * 0.88;
  let aHi = p * 1.12;
  for (const c of vis) { aLo = Math.min(aLo, c.l); aHi = Math.max(aHi, c.h); }
  const padY = (aHi - aLo) * 0.08;
  const [lo, hi] = yv ?? [aLo - padY, aHi + padY];
  const y = (v: number) => M.t + H - ((v - lo) / (hi - lo)) * H;
  const priceAt = (py: number) => lo + ((M.t + H - py) / H) * (hi - lo);
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
    if (px > ML + W || e.shiftKey) zoomY(f, priceAt(py));
    else zoomT(f);
  });
  const drag = useDrag((dx, dy, start) => {
    setHover(null);
    if (start.x > ML + W) { zoomY(Math.exp(dy / 150)); return; }
    setBack((b) => panBack(b + dx / slot));
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
  const reset = () => { setYv(null); setBack(CHART_BACK); setSpan(120); setProfMax(null); };
  const hb = hover !== null ? h.buckets.find((b) => Math.abs(b[0] - hover) < h.step / 2) ?? null : null;
  return (
    <div
      ref={bind}
      className={`lqm-plot is-chart${drag.dragging() ? ' is-drag' : ''}`}
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
            {/* The profile first, the candles over it. */}
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
            {vis.map((c, i) => {
              const xc = xAt(first + i);
              const up = c.c >= c.o;
              return (
                <g key={c.t} className={up ? 'lqm-up' : 'lqm-down'}>
                  <line x1={xc} x2={xc} y1={y(c.h)} y2={y(c.l)} />
                  <rect x={xc - Math.max(0.5, slot * 0.35)} width={Math.max(1, slot * 0.7)} y={y(Math.max(c.o, c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} />
                </g>
              );
            })}
            <line x1={ML} x2={ML + W} y1={y(p)} y2={y(p)} className="lqm-now" />
            {hover !== null && <rect x={ML} y={y(hover + h.step)} width={W} height={Math.max(2, bh)} className="lqm-hover" />}
          </g>
          {vis.length > 0 && ticks(0, vis.length - 1, Math.max(2, Math.floor((slot * vis.length) / 90))).map((i) => {
            const c = vis[Math.round(i)];
            return c ? <text key={`t${i}`} x={xAt(first + Math.round(i))} y={M.t + H + 16} className="lqm-ax" textAnchor="middle">{fmtT(c.t)}</text> : null;
          })}
          {p >= lo && p <= hi && (
            <g transform={`translate(${ML + W + 2},${y(p) - 9})`}>
              <rect width={MR - 4} height={18} rx={3} className="lqm-now-tag is-solid" />
              <text x={(MR - 4) / 2} y={13} textAnchor="middle" className="lqm-now-text">{fmtPx(p)}</text>
            </g>
          )}
          {!n && <text x={ML + W / 2} y={M.t + H / 2} textAnchor="middle" className="lqm-ax">{k.error ? 'No candles for this market' : 'Loading candles…'}</text>}
        </svg>
      )}
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

/**
 * The historical view: the app's own chart (Chart.tsx, `bare`) with the levels over time
 * drawn on its candle pane (chart/liqHeatIndicator.ts). Every control is the chart's -
 * timeframes, scroll and zoom, auto / log / percentage scale, the clock (UTC or local) -
 * and the cells follow them, as nothing else on it: no drawings, studies or order lines.
 * The snapshots are 15-minutely for 3 days and hourly to 30: a shorter bar repeats the
 * snapshot in force when it closed. A click on a cell opens who sat in it then (AtDetails).
 */
function HistoryView({ coin, venues, engine, symbol, wallets, side, onPick }: { coin: string; venues: Venue[]; engine: Engine; symbol: string; wallets: string[]; side: Side; onPick: (p: Pick) => void }) {
  const wkey = wallets.join(',');
  const r = usePolled<LiqHistory>(
    `${coin}|${venues.join(',')}|30d|${wkey}`,
    (s) => vsApi.liquidationHistory(coin, venues, '30d', s, wallets),
    5 * 60_000,
  );
  const [kc, setKc] = useState<KChart | null>(null);
  const points = r.data?.points ?? EMPTY_POINTS;
  const data = useMemo<HeatData>(() => ({ points, side, scale: heatScale(points, side) }), [points, side]);
  const dataRef = useRef(data);
  dataRef.current = data;
  // The layer on each chart instance the chart makes (it makes a new one on a rebuild).
  useEffect(() => {
    if (!kc) return;
    let id: string | null = null;
    let gone = false;
    void import('klinecharts').then((lib) => {
      if (gone) return;
      lib.registerIndicator(liqHeatTemplate);
      id = kc.createIndicator({ name: LIQ_HEAT, paneId: CANDLE_PANE_ID, extendData: dataRef.current }, true);
    });
    return () => {
      gone = true;
      if (id) kc.removeIndicator({ id, paneId: CANDLE_PANE_ID });
    };
  }, [kc]);
  useEffect(() => {
    kc?.overrideIndicator({ name: LIQ_HEAT, paneId: CANDLE_PANE_ID, extendData: data });
  }, [kc, data]);
  const note = r.error && !r.data ? `History unavailable: ${r.error}`
    : !r.data ? 'Reading the snapshots…'
      : !points.length ? (wallets.length ? `No snapshots of ${coin} for ${wallets.length === 1 ? 'this wallet' : 'these wallets'} in this range: every position's level is kept from 28 Oct 2026, 15-minutely for 3 days and hourly to 30.` : `No snapshots of ${coin} yet: the index keeps every coin SoDEX lists, a snapshot every 15 minutes.`)
        : null;
  // A click (not a drag) on a cell: that bar's snapshot and the cell of it under the pointer - the
  // positions in it, as they stood then, open beside the chart (AtDetails).
  const down = useRef<{ x: number; y: number } | null>(null);
  const pickAt = (clientX: number, clientY: number) => {
    if (!kc || !points.length) return;
    const dom = (kc.getDom() as HTMLElement | null) ?? null;
    const pane = kc.getSize(CANDLE_PANE_ID);
    if (!dom || !pane) return;
    const r = dom.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    if (y < pane.top || y > pane.top + pane.height || x < pane.left || x > pane.left + pane.width) return;
    const [pt] = kc.convertFromPixel([{ x, y }], { paneId: CANDLE_PANE_ID, absolute: true }) as Array<{ dataIndex?: number; value?: number }>;
    const list = kc.getDataList();
    const bar = pt?.dataIndex !== undefined ? list[pt.dataIndex] : undefined;
    const price = pt?.value;
    if (!bar || price === undefined || !Number.isFinite(price)) return;
    const i = snapshotFor(points.map((q) => q.t), bar.timestamp, barMsOf(list));
    const snap = i >= 0 ? points[i]! : null;
    if (!snap) return;
    const lo = Math.floor(price / snap.st) * snap.st;
    onPick({ from: lo, to: lo + snap.st, side: price < snap.p ? 'long' : 'short', at: snap.t });
  };
  return (
    <div
      className="lqm-hist2"
      onPointerDownCapture={(e) => { down.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }}
      onPointerUpCapture={(e) => {
        const d = down.current;
        down.current = null;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) pickAt(e.clientX, e.clientY);
      }}
    >
      <Chart engine={engine} symbol={symbol} bare onChartReady={setKc} />
      <div className="lqm-hist2-key" onPointerDown={(e) => e.stopPropagation()}>
        <span className="lqm-hist-scale" title="Liquidation notional per cell (USD at the liquidation price): low to high">
          <span>{fmtUsdShort(data.scale * HEAT_FLOOR)}</span>
          <i aria-hidden="true" />
          <span>{fmtUsdShort(data.scale)}+</span>
        </span>
        {note && <span className="lqm-hist2-note">{note}</span>}
      </div>
    </div>
  );
}
const EMPTY_POINTS: HeatPoint[] = [];

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
function AtDetails({ coin, venues, pick, wallets, onClose }: { coin: string; venues: Venue[]; pick: Required<Pick>; wallets: string[]; onClose: () => void }) {
  const [side, setSide] = useState<'long' | 'short' | 'both'>(pick.side);
  useEffect(() => setSide(pick.side), [pick]);
  const fetcher = useCallback((s: AbortSignal) => vsApi.liquidationAt(coin, venues, pick.at, pick.from, pick.to, side, s, wallets), [coin, venues, pick, side, wallets]);
  const r = usePolled<LiqAt>(`at|${coin}|${venues.join(',')}|${pick.at}|${pick.from}|${pick.to}|${side}|${wallets.join(',')}`, fetcher, 5 * 60_000);
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

function Details({ coin, venues, pick, price, wallets, onClose }: { coin: string; venues: Venue[]; pick: Pick; price: number | null; wallets: string[]; onClose: () => void }) {
  const [side, setSide] = useState(pick.side);
  useEffect(() => setSide(pick.side), [pick]);
  const fetcher = useCallback((s: AbortSignal) => vsApi.liquidationWallets(coin, venues, side, pick.from, pick.to, s, wallets), [coin, venues, side, pick, wallets]);
  const r = usePolled<LiqWallets>(`${coin}|${venues.join(',')}|${side}|${pick.from}|${pick.to}|${wallets.join(',')}`, fetcher, 30_000);
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
