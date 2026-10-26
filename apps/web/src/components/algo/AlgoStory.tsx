/**
 * The Preview's moving picture: what an algo does, played out once and looped.
 *
 * Everything that is the order's own is drawn from the engine's plan and the
 * ticket's levels: every child's time, size and price, the levels, the band,
 * the stop distance, the exits, the price now. What the market will do is not
 * known, so where a kind reacts to the price (a ladder, a chase, a trail, a
 * trigger, Fill fast's rounds) the price path it plays against is an example,
 * and the picture says so.
 *
 *   time     slices, clips, waves, legs over real time (TWAP, Chase TWAP, VWAP,
 *            POV, swarm, basket): each child appears when it is due, the
 *            filled share follows
 *   ladder   resting levels (scale, DCA): an example move walks through them,
 *            each fills as it is reached, the average follows
 *   iceberg  one clip shown at a time, refilled until the whole is done
 *   chase    the order follows the best price, up to its cap, until hit
 *   trailing the stop follows the best price at its distance and fires on the turn
 *   trigger  a conditional's condition, met, then its action
 *   bracket  the entry, then take-profit or stop-loss, the other cancelled
 *   sweep    Fill fast: rounds that wait while the best ask is past the max
 *            slippage and send one IOC when it is within it
 *
 * One playhead (0..1) drives every scene; with reduced motion it rests at the
 * end. SVG on a fixed viewBox, in the chart tokens (algo.css .algo-st).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AlgoPlan, AlgoSpec, PlannedChild } from '@copy-engine';
import { fmtTime } from '../../format';
import { fmtDuration } from './menu';

export interface Level {
  label: string;
  price: number;
  tone: 'now' | 'pos' | 'neg' | 'warn' | 'muted';
}

export function fmtP(p: number): string {
  const a = Math.abs(p);
  const dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return p.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

export const fmtQ = (q: number): string => {
  if (!(q > 0)) return '0';
  const dp = q >= 1000 ? 0 : q >= 1 ? 4 : q >= 0.01 ? 5 : 8;
  return q.toLocaleString('en-US', { maximumFractionDigits: dp });
};

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

export interface StoryProps {
  plan: AlgoPlan;
  spec: AlgoSpec | null;
  side: 'buy' | 'sell';
  mid: number | null;
  levels: Level[];
  base: string;
  sweepRef?: { price: number | null; name: string } | null;
  /** Draws another random schedule (kinds with jitter). */
  onShuffle?: () => void;
  /** The ticket's order type (Chase TWAP and DCA are other kinds' specs). */
  uiKind?: string;
  /** The market's real recent prices (1-minute closes), oldest first. */
  history?: Array<{ t: number; p: number }> | null;
  /** SoDEX's best bid and ask now. */
  book?: { bid: number; ask: number } | null;
  /** VWAP: the usual share of volume in each slice's time (the profile it follows). */
  profile?: number[] | null;
  /** VWAP: the usual volume in each of 24 hours from `from` (same kind of day, median), base units. */
  dayVolume?: { from: number; v: number[] } | null;
  /** The slippage references when the window opened: SoDEX mid, mark, index; the oracle's mid and fair price. */
  refs?: { mid: number | null; mark: number | null; index: number | null; oracleMid: number | null; oracleFair: number | null } | null;
  /** Fill fast: what SoDEX's book holds within the max slippage, on average (base units). */
  bandDepth?: number | null;
  /** The chart's time zone. */
  tz?: 'local' | 'utc';
}

/* --------------------------------------------------------------- frame ----- */

const W = 560;
const H = 232;
const PL = 62;
const PR = 104;
const PT = 16;
const PB = 24;
const IW = W - PL - PR;
const IH = H - PT - PB;
const X1 = PL + IW;
const Y1 = PT + IH;

const PLAY_MS = 7_000;
const HOLD_MS = 1_800;

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The playhead: 0..1 over PLAY_MS, held at 1 a moment, then again. Restarts when `key` changes. */
function usePlayhead(key: string) {
  const still = useRef(reducedMotion()).current;
  const [t, setT] = useState(still ? 1 : 0);
  const [playing, setPlaying] = useState(!still);
  const at = useRef(still ? 1 : 0);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (still) return;
    at.current = 0;
    setT(0);
  }, [key, run, still]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let start = performance.now() - at.current * PLAY_MS;
    const tick = (now: number) => {
      let e = now - start;
      if (e > PLAY_MS + HOLD_MS) {
        start = now;
        e = 0;
      }
      const v = Math.min(1, e / PLAY_MS);
      at.current = v;
      setT(v);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, key, run]);
  return {
    t,
    playing,
    toggle: () => {
      if (at.current >= 1) at.current = 0;
      setPlaying((x) => !x);
    },
    replay: () => {
      at.current = 0;
      setT(0);
      setPlaying(true);
      setRun((n) => n + 1);
    },
  };
}

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => x >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** A price axis over these prices, padded. */
function priceScale(prices: number[], padShare = 0.14) {
  const ps = [...prices, ...F.hist.map((h) => h.p)].filter((p) => Number.isFinite(p) && p > 0);
  let lo = Math.min(...ps);
  let hi = Math.max(...ps);
  if (!(hi > lo)) {
    hi = (hi || 1) * 1.002;
    lo = (lo || 1) * 0.998;
  }
  const pad = (hi - lo) * padShare;
  lo -= pad;
  hi += pad;
  const y = (p: number) => PT + ((hi - p) / (hi - lo)) * IH;
  return { lo, hi, y, ticks: niceTicks(lo, hi, 4) };
}

/** An example price path through keyframes (f 0..1 -> price), smooth, with a little texture. */
function examplePath(keys: Array<[number, number]>, wiggle: number, n = 180): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    let k = 0;
    while (k < keys.length - 2 && f > keys[k + 1]![0]) k++;
    const [f0, p0] = keys[k]!;
    const [f1, p1] = keys[k + 1] ?? keys[k]!;
    const u = f1 > f0 ? Math.min(1, Math.max(0, (f - f0) / (f1 - f0))) : 1;
    const e = (1 - Math.cos(Math.PI * u)) / 2;
    const tex = Math.sin(f * 37) * 0.5 + Math.sin(f * 83 + 1.3) * 0.3 + Math.sin(f * 151 + 0.4) * 0.2;
    // The texture fades at the keyframes so the path passes through them.
    out.push(p0 + (p1 - p0) * e + wiggle * tex * Math.sin(Math.PI * u));
  }
  return out;
}

const sampleAt = (path: number[], f: number) => path[Math.min(path.length - 1, Math.max(0, Math.round(f * (path.length - 1))))]!;
/**
 * The frame a price scene is drawn in. With the market's real recent prices
 * (`hist`, 1-minute closes) the left `hf` of the plot is that history, solid,
 * and the scene's example future runs from "now" to the right, dashed, on a
 * darker ground. Set by sceneFor before a scene is built; every x below is
 * computed while the scene is built, so one render never sees another's frame.
 */
const F: { hf: number; hist: Array<{ t: number; p: number }> } = { hf: 0, hist: [] };
const HIST_SHARE = 0.36;
const fx = (f: number) => PL + (F.hf + f * (1 - F.hf)) * IW;

/** The first f at which the path reaches `p` coming from its start (null: never). */
function reachAt(path: number[], p: number): number | null {
  const s0 = path[0]!;
  const up = p >= s0;
  for (let i = 0; i < path.length; i++) if (up ? path[i]! >= p : path[i]! <= p) return i / (path.length - 1);
  return null;
}

function pathD(path: number[], y: (p: number) => number, upto = 1): string {
  const n = Math.max(1, Math.round(upto * (path.length - 1)));
  let d = '';
  for (let i = 0; i <= n; i++) d += `${i ? 'L' : 'M'}${fx(i / (path.length - 1)).toFixed(1)},${y(path[i]!).toFixed(1)}`;
  return d;
}

/** The grid, the axes and - with history - the real prices up to now and the darker future. */
function priceGrid(y: (p: number) => number, ticks: number[]): ReactNode {
  const h = F.hist;
  const x0 = fx(0);
  let hd = '';
  if (F.hf > 0 && h.length > 1) {
    const t0 = h[0]!.t;
    const t1 = h[h.length - 1]!.t;
    h.forEach((pt, i) => {
      hd += `${i ? 'L' : 'M'}${(PL + ((pt.t - t0) / (t1 - t0 || 1)) * (x0 - PL)).toFixed(1)},${y(pt.p).toFixed(1)}`;
    });
  }
  const mins = h.length > 1 ? Math.round((h[h.length - 1]!.t - h[0]!.t) / 60_000) : 0;
  return (
    <>
      {F.hf > 0 && <rect className="algo-st__future" x={x0} y={PT} width={X1 - x0} height={IH} />}
      {ticks.map((v) => (
        <g key={v}>
          <line className="algo-st__grid" x1={PL} x2={X1} y1={y(v)} y2={y(v)} />
          <text className="algo-st__tick" x={PL - 6} y={y(v) + 3} textAnchor="end">{fmtP(v)}</text>
        </g>
      ))}
      <line className="algo-st__axis" x1={PL} x2={PL} y1={PT} y2={Y1} />
      <line className="algo-st__axis" x1={PL} x2={X1} y1={Y1} y2={Y1} />
      {hd && (
        <>
          <path className="algo-st__hist" d={hd} />
          <line className="algo-st__nowline" x1={x0} x2={x0} y1={PT} y2={Y1} />
          <text className="algo-st__tick" x={PL} y={H - 8}>−{mins} min</text>
          <text className="algo-st__tick is-now" x={x0} y={H - 8} textAnchor="middle">Now</text>
          <text className="algo-st__tick" x={X1} y={H - 8} textAnchor="end">example →</text>
        </>
      )}
    </>
  );
}

/** A price rule with a tag at the right, labels kept apart. */
function Rule({ y, label, tone, dashed, faded }: { y: number; label: string; tone: string; dashed?: boolean; faded?: boolean }) {
  return (
    <g className={`algo-st__rule is-${tone}${dashed ? ' is-dashed' : ''}${faded ? ' is-faded' : ''}`}>
      <line x1={PL} x2={X1} y1={y} y2={y} />
      <g transform={`translate(${X1 + 4},${y})`}>
        <rect x={0} y={-8} width={PR - 8} height={16} rx={4} />
        <text x={6} y={3.5}>{label}</text>
      </g>
    </g>
  );
}

/** Rules' label rows pushed apart so no two tags overlap (each 18 units). */
function spread<T extends { y: number }>(rules: T[]): Array<T & { ty: number }> {
  const s = [...rules].sort((a, b) => a.y - b.y);
  let last = -1e9;
  const out = s.map((r) => {
    const ty = Math.max(r.y, last + 18);
    last = ty;
    return { ...r, ty };
  });
  const over = (out[out.length - 1]?.ty ?? 0) - (Y1 + 6);
  if (over > 0) for (const r of out) r.ty -= over;
  return out;
}

function Tags({ rules }: { rules: Array<{ y: number; label: string; tone: string; dashed?: boolean; faded?: boolean }> }) {
  return (
    <>
      {spread(rules).map((r) => (
        <g key={`${r.label}${r.y}`} className={`algo-st__rule is-${r.tone}${r.dashed ? ' is-dashed' : ''}${r.faded ? ' is-faded' : ''}`}>
          <line x1={PL} x2={X1} y1={r.y} y2={r.y} />
          {Math.abs(r.ty - r.y) > 1 && <line className="algo-st__lead" x1={X1} x2={X1 + 4} y1={r.y} y2={r.ty} />}
          <g transform={`translate(${X1 + 4},${r.ty})`}>
            <rect x={0} y={-8} width={PR - 8} height={16} rx={4} />
            <text x={6} y={3.5}>{r.label}</text>
          </g>
        </g>
      ))}
    </>
  );
}

function Dot({ x, y, tone, pulse }: { x: number; y: number; tone: string; pulse?: boolean }) {
  return (
    <g className={`algo-st__dot is-${tone}`}>
      {pulse && <circle className="algo-st__ping" cx={x} cy={y} r={4} />}
      <circle cx={x} cy={y} r={3.6} />
    </g>
  );
}

function Head({ x, y }: { x: number; y: number }) {
  return (
    <g className="algo-st__head">
      <line x1={x} x2={x} y1={PT} y2={Y1} />
      <circle cx={x} cy={y} r={3} />
    </g>
  );
}

/* ------------------------------------------------------------- scenes ------ */

interface Scene {
  svg: ReactNode;
  steps: string[];
  /** Which step is happening now. */
  step: number;
  /** What it has done so far, in a few words. */
  status: string;
  /** Share done (0..1), for the meter. */
  done: number;
  /** A line under the picture: what is example and what is the order's. */
  note?: string;
  /** What the marks mean, shown under the picture (never inside it). */
  legend?: Legend;
}

/** A swatch class (algo.css .algo-st__sw--*) and its words. */
type Legend = Array<{ swatch: string; text: string }>;

const dirTone = (side: 'buy' | 'sell') => (side === 'buy' ? 'pos' : 'neg');
const verbOf = (side: 'buy' | 'sell') => (side === 'buy' ? 'Buys' : 'Sells');
const EXAMPLE = 'The price line is an example; the prices, sizes and times are your order’s.';

/* time: children over real time */

function timeScene(t: number, p: StoryProps): Scene | null {
  const { plan, spec, side, base } = p;
  const kids = (plan.schedule?.length ? plan.schedule : plan.children).filter((c) => c.at !== null && c.qty > 0).sort((a, b) => a.at! - b.at!);
  if (!kids.length) return null;
  const t0 = plan.startsAt;
  const last = kids[kids.length - 1]!.at!;
  const t1 = Math.max(plan.endsAt ?? last, last, t0 + 1_000);
  // A little room after the last child so it is seen landing.
  const span = (t1 - t0) * 1.04 || 1;
  const T = t0 + t * span;
  const x = (ms: number) => PL + ((ms - t0) / span) * IW;
  const usdOf = (c: PlannedChild) => c.usd ?? c.qty;
  const basket = spec?.kind === 'basket';
  const wt = (c: PlannedChild) => (basket ? usdOf(c) : c.qty);
  const total = kids.reduce((a, c) => a + wt(c), 0) || 1;
  const stacks = new Map<number, number>();
  for (const c of kids) stacks.set(c.at!, (stacks.get(c.at!) ?? 0) + wt(c));
  const tallest = Math.max(...stacks.values());
  const yS = (q: number) => Y1 - (q / tallest) * IH * 0.86;
  const bw = Math.max(1.4, Math.min(18, (IW / Math.max(stacks.size, 1)) * 0.62));
  const under = new Map<number, number>();
  let sent = 0;
  let filled = 0;
  // A slice that rests first (Chase TWAP, a resting VWAP or POV) is drawn as the order book draws a
  // limit: its top part dotted - resting at the best price - and the rest solid, what is taken once its
  // rest time is up. How much fills while it rests depends on the market; the dotted part shows the idea
  // (half the rest share, between a fifth and a half of the slice), not a forecast.
  const exec = spec?.kind === 'twap' || spec?.kind === 'vwap' || spec?.kind === 'pov' ? spec.exec : null;
  const gapMs = plan.intervalMs ?? span / Math.max(1, kids.length);
  const restShare = !exec || exec.style === 'taker' ? 0 : exec.style === 'maker' ? 1 : Math.min(0.5, Math.max(0.2, exec.makerShare / 2));
  const bars = kids.map((c, i) => {
    const u = under.get(c.at!) ?? 0;
    under.set(c.at!, u + wt(c));
    const on = c.at! <= T;
    if (on) {
      sent++;
      filled += wt(c);
    }
    const fresh = on && T - c.at! < span * 0.05;
    const tone = c.tag.startsWith('sell') ? 'neg' : c.tag.startsWith('buy') ? 'pos' : dirTone(side);
    const top = yS(u + wt(c));
    const bottom = yS(u);
    const h = Math.max(0.8, bottom - top);
    const lim = h * restShare;
    return (
      <g key={i}>
        <title>{`${c.tag}: ${fmtQ(c.qty)} ${base} at ${fmtTime(c.at!)}`}</title>
        {lim < h && <rect className={`algo-st__bar is-${tone}${on ? ' is-on' : ''}${fresh ? ' is-fresh' : ''}`} x={x(c.at!) - bw / 2} y={top + lim} width={bw} height={h - lim} />}
        {lim > 0 && <rect className={`algo-st__bar is-limit is-${tone}${on ? ' is-on' : ''}`} x={x(c.at!) - bw / 2 + 0.5} y={top + 0.5} width={Math.max(0.5, bw - 1)} height={Math.max(0.5, lim - 1)} />}
      </g>
    );
  });
  // The filled share as a stepped line, right axis 0-100%.
  const yC = (f: number) => Y1 - f * IH;
  let cum = 0;
  let d = `M${PL},${Y1}`;
  for (const c of kids) {
    if (c.at! > T) break;
    d += `L${x(c.at!).toFixed(1)},${yC(cum / total).toFixed(1)}`;
    cum += wt(c);
    d += `L${x(c.at!).toFixed(1)},${yC(cum / total).toFixed(1)}`;
  }
  d += `L${Math.min(x(T), X1).toFixed(1)},${yC(cum / total).toFixed(1)}`;
  const share = filled / total;
  const yTicks = niceTicks(0, tallest, 3);
  const unit = basket ? 'USD' : base || 'size';
  // VWAP: the usual volume in each slice's hour behind its bars (the profile it follows).
  const prof = spec?.kind === 'vwap' && p.profile && p.profile.length === kids.length ? p.profile : null;
  const pmax = prof ? Math.max(...prof) || 1 : 1;
  const profD = prof
    ? `M${x(kids[0]!.at!).toFixed(1)},${Y1}${kids.map((c, i) => `L${x(c.at!).toFixed(1)},${(Y1 - (prof[i]! / pmax) * IH * 0.86).toFixed(1)}`).join('')}L${x(kids[kids.length - 1]!.at!).toFixed(1)},${Y1}Z`
    : '';
  const svg = (
    <>
      {profD && <path className="algo-st__profile" d={profD} />}
      {spec?.kind === 'twap' && <line className="algo-st__pace" x1={PL} y1={Y1} x2={x(t1)} y2={PT}><title>Even pace</title></line>}
      {yTicks.map((v) => (
        <g key={v}>
          <line className="algo-st__grid" x1={PL} x2={X1} y1={yS(v)} y2={yS(v)} />
          <text className="algo-st__tick" x={PL - 6} y={yS(v) + 3} textAnchor="end">{basket ? `$${fmtQ(v)}` : fmtQ(v)}</text>
        </g>
      ))}
      {[0, 0.5, 1].map((f) => (
        <text key={f} className="algo-st__tick is-cum" x={X1 + 6} y={yC(f) + 3}>{pct(f)} done</text>
      ))}
      {bars}
      <path className="algo-st__cum" d={d} />
      <line className="algo-st__axis" x1={PL} x2={X1} y1={Y1} y2={Y1} />
      <line className="algo-st__axis" x1={PL} x2={PL} y1={PT} y2={Y1} />
      <Head x={Math.min(x(T), X1)} y={yC(share)} />
      <text className="algo-st__tick" x={PL} y={H - 8}>{t0 <= Date.now() + 2_000 ? 'Now' : fmtTime(t0)}</text>
      <text className="algo-st__tick" x={PL + IW / 2} y={H - 8} textAnchor="middle">+{fmtDuration((t1 - t0) / 2)}</text>
      <text className="algo-st__tick" x={X1} y={H - 8} textAnchor="end">{fmtTime(t1)}</text>
      <text className="algo-st__clock" x={Math.min(Math.max(x(T), PL + 30), X1 - 30)} y={PT - 4} textAnchor="middle">{fmtTime(Math.min(T, t1))}</text>
      <text className="algo-st__unit" x={PL - 6} y={PT - 4} textAnchor="end">{unit}</text>
    </>
  );
  const n = kids.length;
  const each = fmtQ(kids.reduce((a, c) => a + c.qty, 0) / n);
  const tn = dirTone(side);
  const legend: Legend = !exec
    ? [{ swatch: `bar is-${tn}`, text: 'an order, its height the size' }, { swatch: 'cum', text: 'share done' }]
    : exec.style === 'taker'
      ? [{ swatch: `bar is-${tn}`, text: `each slice taken at once at the ${side === 'buy' ? 'ask' : 'bid'}` }, { swatch: 'cum', text: 'share done' }, ...(spec?.kind === 'twap' ? [{ swatch: 'pace', text: 'even pace' }] : [])]
      : exec.style === 'maker'
        ? [{ swatch: `limit is-${tn}`, text: 'rests as a limit at the best price; never takes' }, { swatch: 'cum', text: 'share sent' }]
        : [
            { swatch: `limit is-${tn}`, text: `rests as a limit at the best price first (${pct(exec.makerShare)} of each ${fmtDuration(gapMs)})` },
            { swatch: `bar is-${tn}`, text: 'what is still open then is taken' },
            { swatch: 'cum', text: 'share sent' },
          ];
  const every = plan.intervalMs ? fmtDuration(plan.intervalMs) : fmtDuration((t1 - t0) / Math.max(1, n - 1));
  const amount = basket ? `$${fmtQ(total)}` : `${fmtQ(plan.total ?? total)} ${base}`;
  let steps: string[];
  switch (spec?.kind) {
    case 'vwap':
      steps = [`Splits ${amount} into ${n} slices`, prof ? `Sized by the usual volume at each hour (the last ${spec.lookbackDays} days)${spec.adaptive ? ', faster when today trades more' : ''}` : 'Even slices until the volume profile is read', `Done by ${fmtTime(t1)}`];
      break;
    case 'pov':
      steps = [`Joins in for ${pct(spec.rate)} of what trades`, `About ${n} orders at the last hour’s pace`, plan.endsAt ? `Done around ${fmtTime(t1)}` : 'Done when the amount is filled'];
      break;
    case 'swarm':
      steps = [`Cuts ${amount} into ${n} small takers`, `Sends ${spec.inFlight} at a time, a wave every ${fmtDuration(spec.waveMs)}`, 'The book refills between waves'];
      break;
    case 'basket':
      steps = [`${spec.legs.length} markets, ${amount} in all`, `Every market in step, ${spec.style === 'twap' ? `a slice every ${every}` : 'in small waves'}`, `Done by ${fmtTime(t1)}`];
      break;
    case 'twap': {
      const chase = spec.exec.style === 'hybrid';
      steps = [`Splits ${amount} into ${n} slices of ~${each}`, chase ? `One every ${every}, resting at the best price first` : `Sends one every ${every}`, chase ? 'What falls behind is taken; done by ' + fmtTime(t1) : `Done by ${fmtTime(t1)}`];
      break;
    }
    default:
      steps = [`${n} orders`, `One every ${every}`, `Done by ${fmtTime(t1)}`];
  }
  return {
    svg,
    legend,
    steps,
    step: sent === 0 ? 0 : sent < n ? 1 : 2,
    status: `${sent} of ${n} sent · ${basket ? `$${fmtQ(filled)}` : `${fmtQ(kids.slice(0, sent).reduce((a, c) => a + c.qty, 0))} ${base}`}`,
    done: share,
    note: plan.estimated ? 'Paced at the last hour’s volume; the real pace follows what trades.' : undefined,
  };
}

/* ladder: resting levels walked through by an example move */

function ladderScene(t: number, p: StoryProps): Scene | null {
  const { plan, spec, side, mid, base } = p;
  const now = mid ?? plan.children.find((c) => c.price !== null)?.price ?? null;
  if (!now) return null;
  const lv = plan.children.filter((c) => c.qty > 0).map((c) => ({ ...c, px: c.price ?? now }));
  if (!lv.length) return null;
  const sgn = side === 'buy' ? -1 : 1; // the way the levels lie from now
  const far = lv.reduce((a, c) => (sgn * (c.px - a) > 0 ? c.px : a), now);
  const reach = far + (far - now) * 0.12 || now * (1 + sgn * 0.002);
  const exits = plan.exits;
  const prices = [now, reach, ...lv.map((c) => c.px), ...(plan.avgPrice ? [plan.avgPrice] : []), ...(exits?.tp ? [exits.tp] : []), ...(exits?.sl ? [exits.sl] : [])];
  const sc = priceScale(prices, 0.08);
  const range = Math.abs(reach - now) || now * 0.002;
  const back = exits?.tp ?? (plan.avgPrice ? plan.avgPrice + (now - plan.avgPrice) * 0.6 : now);
  const path = examplePath([[0, now], [0.28, now + (far - now) * 0.45], [0.42, now + (far - now) * 0.3], [0.78, reach], [1, back]], range * 0.06);
  const head = sampleAt(path, t);
  let qtyDone = 0;
  let usdDone = 0;
  let nDone = 0;
  const bars: ReactNode[] = [];
  const dots: ReactNode[] = [];
  const maxQ = Math.max(...lv.map((c) => c.qty));
  lv.forEach((c, i) => {
    const at = c.price === null ? 0 : reachAt(path, c.px);
    const on = at !== null && at <= t;
    if (on) {
      nDone++;
      qtyDone += c.qty;
      usdDone += c.qty * c.px;
      dots.push(<Dot key={`d${i}`} x={fx(at!)} y={sc.y(c.px)} tone={dirTone(side)} pulse={t - at! < 0.06} />);
    }
    const len = Math.max(3, (c.qty / maxQ) * 70);
    bars.push(
      <g key={i} className={`algo-st__lvl is-${dirTone(side)}${on ? ' is-on' : ''}`}>
        <line x1={on ? fx(at!) : PL} x2={X1} y1={sc.y(c.px)} y2={sc.y(c.px)} />
        <rect x={X1 - len} y={sc.y(c.px) - 3.5} width={len} height={7} rx={1.5}>
          <title>{`${c.tag}: ${fmtQ(c.qty)} ${base} at ${fmtP(c.px)}`}</title>
        </rect>
      </g>,
    );
  });
  const avg = qtyDone ? usdDone / qtyDone : null;
  const rules: Array<{ y: number; label: string; tone: string; dashed?: boolean; faded?: boolean }> = [{ y: sc.y(now), label: `Now ${fmtP(now)}`, tone: 'now', dashed: true }];
  if (avg) rules.push({ y: sc.y(avg), label: `Avg ${fmtP(avg)}`, tone: 'dir' });
  const allIn = nDone === lv.length;
  if (exits?.tp) rules.push({ y: sc.y(exits.tp), label: `TP ${fmtP(exits.tp)}`, tone: 'pos', dashed: true, faded: !allIn });
  if (exits?.sl) rules.push({ y: sc.y(exits.sl), label: `SL ${fmtP(exits.sl)}`, tone: 'neg', dashed: true, faded: !allIn });
  const top = lv.reduce((a, c) => (sgn * (c.px - a.px) > 0 ? c : a), lv[0]!);
  const near = lv.reduce((a, c) => (sgn * (c.px - a.px) < 0 ? c : a), lv[0]!);
  const svg = (
    <>
      {priceGrid(sc.y, sc.ticks)}
      {bars}
      <path className="algo-st__path is-ghost" d={pathD(path, sc.y)} />
      <path className="algo-st__path" d={pathD(path, sc.y, t)} />
      {dots}
      <Tags rules={rules} />
      <Head x={fx(t)} y={sc.y(head)} />
      <text className="algo-st__unit" x={PL - 6} y={PT - 4} textAnchor="end">price</text>
    </>
  );
  const dca = spec?.kind === 'scale' && spec.label === 'DCA';
  const n = lv.length;
  const verb = verbOf(side);
  const steps = dca
    ? [`${verb} ${fmtQ(near.qty)} ${base} at ${fmtP(near.px)}`, n > 1 ? `Then a ${side} at each of ${n - 1} lower prices, down to ${fmtP(top.px)}` : 'One price only', plan.avgPrice ? `Average ${fmtP(plan.avgPrice)} if all fill` : 'Waits at each price']
    : [`Rests ${n} orders from ${fmtP(near.px)} to ${fmtP(top.px)}`, 'Each fills when the price reaches it', plan.avgPrice ? `Average ${fmtP(plan.avgPrice)} if all fill` : 'All filled'];
  return {
    svg,
    steps: exits && (exits.tp || exits.sl) ? [...steps, 'Then its take-profit and stop-loss wait'] : steps,
    step: nDone === 0 ? 0 : !allIn ? 1 : exits && (exits.tp || exits.sl) ? 3 : 2,
    status: `${nDone} of ${n} filled${avg ? ` · avg ${fmtP(avg)}` : ''}`,
    done: plan.total ? qtyDone / plan.total : nDone / n,
    note: EXAMPLE,
  };
}

/* iceberg: one clip at a time */

function icebergScene(t: number, p: StoryProps): Scene | null {
  const { plan, spec, side, mid, levels, base } = p;
  if (spec?.kind !== 'iceberg') return null;
  const total = plan.total ?? 0;
  const show = Number(spec.displayQty) || 0;
  const px = spec.price ?? levels.find((l) => l.label === 'Clip at')?.price ?? mid;
  if (!(total > 0) || !(show > 0) || !px || !mid) return null;
  const clips = Math.max(1, Math.ceil(total / show));
  const sgn = side === 'buy' ? 1 : -1;
  const gap = Math.abs(mid - px) || mid * 0.0008;
  // The price keeps coming back to the clip: each touch fills one.
  const keys: Array<[number, number]> = [[0, mid]];
  const touches = Math.min(clips, 6);
  for (let i = 0; i < touches; i++) {
    const f = (i + 0.7) / (touches + 0.4);
    keys.push([f - 0.06, px + sgn * gap * 0.9], [f, px - sgn * gap * 0.15]);
  }
  keys.push([1, px + sgn * gap * 0.8]);
  const path = examplePath(keys, gap * 0.12);
  const sc = priceScale([...path, px, mid], 0.18);
  // Fills follow the touches; with more clips than touches each touch takes several.
  let fills = 0;
  for (let i = 0; i < touches; i++) if ((i + 0.7) / (touches + 0.4) <= t) fills = Math.round(((i + 1) / touches) * clips);
  const filled = Math.min(total, fills * show);
  const shown = Math.min(show, total - filled);
  const tone = dirTone(side);
  // The whole order as a column: filled, the clip on the book, and the hidden rest.
  const cx = X1 - 30;
  const ch = IH - 8;
  const hY = (q: number) => Y1 - 4 - (q / total) * ch;
  const svg = (
    <>
      {priceGrid(sc.y, sc.ticks)}
      <path className="algo-st__path is-ghost" d={pathD(path, sc.y)} />
      <path className="algo-st__path" d={pathD(path, sc.y, t)} />
      {Array.from({ length: touches }, (_, i) => {
        const f = (i + 0.7) / (touches + 0.4);
        return f <= t ? <Dot key={i} x={fx(f)} y={sc.y(px)} tone={tone} pulse={t - f < 0.06} /> : null;
      })}
      <g className="algo-st__ice">
        <rect className="is-hidden" x={cx} y={hY(total)} width={22} height={hY(filled + shown) - hY(total)} />
        <rect className={`is-show is-${tone}`} x={cx} y={hY(filled + shown)} width={22} height={hY(filled) - hY(filled + shown)} />
        <rect className={`is-done is-${tone}`} x={cx} y={hY(filled)} width={22} height={hY(0) - hY(filled)} />
        <text x={cx + 11} y={PT - 4} textAnchor="middle">order</text>
      </g>
      <Rule y={sc.y(px)} label={`Clip ${fmtP(px)}`} tone={tone} />
      <Rule y={sc.y(mid)} label={`Now ${fmtP(mid)}`} tone="now" dashed />
      <Head x={fx(t)} y={sc.y(sampleAt(path, t))} />
    </>
  );
  return {
    svg,
    steps: [`Shows ${fmtQ(show)} ${base} of ${fmtQ(total)} on the book`, spec.price !== null ? `At ${fmtP(px)}; each fill shows the next clip` : 'Pegged to the best price; each fill shows the next clip', `${clips} clips until it is done`],
    step: fills === 0 ? 0 : fills < clips ? 1 : 2,
    status: `${fmtQ(filled)} of ${fmtQ(total)} ${base} · ${Math.min(fills, clips)} of ${clips} clips`,
    done: filled / total,
    note: EXAMPLE,
  };
}

/* chase: follows the best price up to its cap */

function chaseScene(t: number, p: StoryProps): Scene | null {
  const { plan, side, mid, levels, base } = p;
  const rest = levels.find((l) => l.label === 'Rests at')?.price ?? null;
  if (!mid || !rest) return null;
  const away = side === 'buy' ? 1 : -1;
  const off = Math.abs(mid - rest) || mid * 0.0001;
  const cap = levels.find((l) => l.label === 'Chases to')?.price ?? null;
  const reach = cap ? Math.abs(cap - mid) * 1.5 : mid * 0.003;
  const path = examplePath([[0, mid], [0.5, mid + away * reach], [0.68, mid + away * reach * 0.9], [0.84, mid + away * reach * 0.55], [1, mid + away * reach * 0.62]], reach * 0.05);
  const order = path.map((x) => {
    const o = x - away * off;
    return cap === null ? o : away > 0 ? Math.min(o, cap) : Math.max(o, cap);
  });
  // A seller (or buyer) hits it once the price comes back to it.
  const fillF = 0.84;
  const sc = priceScale([...path, ...order, ...(cap ? [cap] : [])], 0.1);
  const filled = t >= fillF;
  const tt = Math.min(t, fillF);
  const capped = cap !== null && order.slice(0, Math.round(tt * (path.length - 1)) + 1).some((o) => o === cap);
  const tone = dirTone(side);
  const svg = (
    <>
      {priceGrid(sc.y, sc.ticks)}
      <path className="algo-st__path is-ghost" d={pathD(path, sc.y)} />
      <path className="algo-st__path" d={pathD(path, sc.y, t)} />
      <path className={`algo-st__order is-${tone}`} d={pathD(order, sc.y, tt)} />
      {filled && <Dot x={fx(fillF)} y={sc.y(sampleAt(order, fillF))} tone={tone} pulse={t - fillF < 0.06} />}
      {cap !== null && <Rule y={sc.y(cap)} label={`Cap ${fmtP(cap)}`} tone="warn" dashed />}
      <Rule y={sc.y(mid)} label={`Now ${fmtP(mid)}`} tone="now" dashed />
      <Head x={fx(t)} y={sc.y(sampleAt(path, t))} />
    </>
  );
  return {
    svg,
    steps: [`Rests ${fmtQ(plan.total ?? 0)} ${base} at ${fmtP(rest)}, the best ${side === 'buy' ? 'bid' : 'ask'}`, cap ? `Follows the price, never past ${fmtP(cap)}` : 'Follows the price as it moves', 'Fills when the market comes to it'],
    step: filled ? 2 : t > 0.08 ? 1 : 0,
    status: filled ? `Filled at ${fmtP(sampleAt(order, fillF))}` : capped ? `Waiting at the cap ${fmtP(cap!)}` : `Resting at ${fmtP(sampleAt(order, t))}`,
    done: filled ? 1 : 0,
    note: EXAMPLE,
  };
}

/* trailing: the stop follows at its distance, fires on the turn */

function trailingScene(t: number, p: StoryProps): Scene | null {
  const { plan, spec, side, mid, levels, base } = p;
  if (spec?.kind !== 'trailing' || !mid) return null;
  const stopNow = levels.find((l) => l.label === 'Stop')?.price ?? null;
  const from = spec.activationPrice ?? mid;
  const dist = stopNow !== null ? Math.abs(from - stopNow) : spec.trailAbs ?? from * (spec.trailPct ?? 0.01);
  if (!(dist > 0)) return null;
  const good = side === 'sell' ? 1 : -1; // a sell stop protects a long: up is good
  const actF = spec.activationPrice !== null ? 0.18 : 0;
  const peak = from + good * dist * 2.2;
  const keys: Array<[number, number]> = [[0, mid]];
  if (actF) keys.push([actF, from]);
  keys.push([0.6, peak], [0.68, peak - good * dist * 0.35], [0.74, peak + good * dist * 0.1], [1, peak - good * dist * 2.2]);
  const path = examplePath(keys, dist * 0.08);
  const stop: Array<number | null> = [];
  let best: number | null = null;
  let fireF: number | null = null;
  path.forEach((x, i) => {
    const f = i / (path.length - 1);
    if (best === null && (actF === 0 || good * (x - from) >= 0 || f >= actF)) best = x;
    if (best !== null && fireF === null) best = good > 0 ? Math.max(best, x) : Math.min(best, x);
    const s = best === null ? null : best - good * dist;
    if (s !== null && fireF === null && good * (x - s) <= 0) fireF = f;
    stop.push(s);
  });
  const sc = priceScale([...path, from - good * dist], 0.08);
  const fired = fireF !== null && t >= fireF;
  const until = fireF !== null ? Math.min(t, fireF) : t;
  const n = Math.round(until * (path.length - 1));
  let sd = '';
  for (let i = 0; i <= n; i++) {
    const s = stop[i];
    if (s == null) continue;
    sd += `${sd ? 'L' : 'M'}${fx(i / (path.length - 1)).toFixed(1)},${sc.y(s).toFixed(1)}`;
  }
  const tone = dirTone(side);
  const cur = stop[Math.round(t * (path.length - 1))] ?? null;
  const svg = (
    <>
      {priceGrid(sc.y, sc.ticks)}
      <path className="algo-st__path is-ghost" d={pathD(path, sc.y)} />
      <path className="algo-st__path" d={pathD(path, sc.y, t)} />
      {sd && <path className={`algo-st__order is-${tone}`} d={sd} />}
      {fired && <Dot x={fx(fireF!)} y={sc.y(sampleAt(path, fireF!))} tone={tone} pulse={t - fireF! < 0.06} />}
      {spec.activationPrice !== null && <Rule y={sc.y(from)} label={`Starts ${fmtP(from)}`} tone="warn" dashed />}
      <Rule y={sc.y(mid)} label={`Now ${fmtP(mid)}`} tone="now" dashed />
      <Head x={fx(t)} y={sc.y(sampleAt(path, t))} />
    </>
  );
  const distW = spec.trailPct !== null ? pct(spec.trailPct, spec.trailPct < 0.01 ? 2 : 1) : fmtP(dist);
  const what = spec.quantity === null ? 'the whole position' : `${fmtQ(plan.total ?? Number(spec.quantity))} ${base}`;
  return {
    svg,
    steps: [spec.activationPrice !== null ? `Waits for ${fmtP(from)}` : `Starts at ${fmtP(mid)}`, `The stop follows ${distW} behind the ${good > 0 ? 'high' : 'low'}`, `It turns ${distW}: ${side === 'sell' ? 'sells' : 'buys'} ${what}${spec.exit === 'chase' ? ', chasing' : ' at market'}`],
    step: fired ? 2 : cur !== null ? 1 : 0,
    status: fired ? `Fired at ${fmtP(sampleAt(path, fireF!))}` : cur !== null ? `Stop at ${fmtP(cur)}` : `Waiting for ${fmtP(from)}`,
    done: fired ? 1 : 0,
    note: EXAMPLE,
  };
}

/* conditional: condition met, then the action */

function conditionScene(t: number, p: StoryProps): Scene | null {
  const { spec, side, mid, levels, base } = p;
  if (spec?.kind !== 'conditional' || !mid) return null;
  const trig = levels.find((l) => l.tone === 'warn' && l.label !== 'Then limit');
  const lim = levels.find((l) => l.label === 'Then limit')?.price ?? null;
  const target = trig?.price ?? mid * 1.004;
  const span = Math.abs(target - mid) || mid * 0.003;
  const path = examplePath([[0, mid], [0.25, mid - Math.sign(target - mid || 1) * span * 0.3], [0.6, target + (target - mid) * 0.2], [1, target + (target - mid) * 0.35]], span * 0.07);
  const metF = trig ? reachAt(path, target) ?? 0.55 : 0.55;
  const met = t >= metF;
  const sc = priceScale([...path, target, ...(lim ? [lim] : [])], 0.1);
  const tone = dirTone(side);
  const th = spec.then;
  const act =
    th.type === 'market' ? `${verbOf(side)} ${th.quantity} ${base} at market`
    : th.type === 'limit' ? `Places a ${side} limit for ${th.quantity} ${base} at ${fmtP(th.price)}`
    : th.type === 'close' ? `Closes ${pct(th.share)} of the position`
    : `Starts the ${th.algo.kind.toUpperCase()} order`;
  const cond = spec.conditions.length === 1 ? (trig ? `${trig.label} ${fmtP(target)}` : `its ${spec.conditions[0]!.type} condition`) : `${spec.conditions.length} conditions (${spec.match})`;
  const svg = (
    <>
      {priceGrid(sc.y, sc.ticks)}
      <path className="algo-st__path is-ghost" d={pathD(path, sc.y)} />
      <path className="algo-st__path" d={pathD(path, sc.y, t)} />
      {met && (
        <g className="algo-st__met">
          <line x1={fx(metF)} x2={fx(metF)} y1={PT} y2={Y1} />
          <text x={fx(metF) + 4} y={PT + 10}>met</text>
        </g>
      )}
      {met && <Dot x={fx(metF)} y={sc.y(sampleAt(path, metF))} tone={tone} pulse={t - metF < 0.06} />}
      {trig && <Rule y={sc.y(target)} label={`${trig.label.replace('When ', '')} ${fmtP(target)}`} tone="warn" dashed />}
      {lim !== null && <Rule y={sc.y(lim)} label={`Limit ${fmtP(lim)}`} tone={tone} faded={!met} />}
      <Rule y={sc.y(mid)} label={`Now ${fmtP(mid)}`} tone="now" dashed />
      <Head x={fx(t)} y={sc.y(sampleAt(path, t))} />
    </>
  );
  return {
    svg,
    steps: [`Watches ${cond}`, spec.holdMs ? `Met and held for ${fmtDuration(spec.holdMs)}` : 'The moment it is met', act],
    step: met ? (t - metF > 0.04 ? 2 : 1) : 0,
    status: met ? 'Condition met: order sent' : 'Watching',
    done: met ? 1 : 0,
    note: trig ? EXAMPLE : 'Shown on the price for illustration; the condition is what decides.',
  };
}

/* bracket: entry, then one exit fills and the other is cancelled */

function bracketScene(t: number, p: StoryProps): Scene | null {
  const { plan, spec, side, mid, base } = p;
  if (spec?.kind !== 'bracket' || !mid) return null;
  const tp = plan.exits?.tp ?? null;
  const sl = plan.exits?.sl ?? null;
  const entry = spec.entry === 'limit' && spec.price !== null ? spec.price : mid;
  const exit = tp ?? sl ?? entry * (side === 'buy' ? 1.004 : 0.996);
  const entryF = spec.entry === 'limit' ? 0.3 : 0.04;
  const keys: Array<[number, number]> = [[0, mid]];
  if (spec.entry === 'limit') keys.push([entryF, entry]);
  keys.push([0.5, entry + (exit - entry) * 0.3], [0.62, entry + (exit - entry) * 0.1], [0.9, exit + (exit - entry) * 0.04], [1, exit + (exit - entry) * 0.1]);
  const path = examplePath(keys, Math.abs(exit - entry) * 0.05);
  const inF = spec.entry === 'limit' ? reachAt(path, entry) ?? entryF : 0.02;
  const outF = reachAt(path.slice(Math.round(inF * (path.length - 1))), exit);
  const exitF = outF !== null ? inF + outF * (1 - inF) : 0.9;
  const inside = t >= inF;
  const out = t >= exitF;
  const sc = priceScale([...path, entry, ...(tp ? [tp] : []), ...(sl ? [sl] : [])], 0.08);
  const tone = dirTone(side);
  const svg = (
    <>
      {priceGrid(sc.y, sc.ticks)}
      {inside && tp && sl && <rect className="algo-st__band" x={fx(inF)} y={Math.min(sc.y(tp), sc.y(sl))} width={(out ? fx(exitF) : fx(t)) - fx(inF)} height={Math.abs(sc.y(tp) - sc.y(sl))} />}
      <path className="algo-st__path is-ghost" d={pathD(path, sc.y)} />
      <path className="algo-st__path" d={pathD(path, sc.y, t)} />
      {inside && <Dot x={fx(inF)} y={sc.y(entry)} tone={tone} pulse={t - inF < 0.06} />}
      {out && <Dot x={fx(exitF)} y={sc.y(exit)} tone={tp ? 'pos' : 'neg'} pulse={t - exitF < 0.06} />}
      <Tags
        rules={[
          { y: sc.y(entry), label: `Entry ${fmtP(entry)}`, tone },
          ...(tp ? [{ y: sc.y(tp), label: `TP ${fmtP(tp)}`, tone: 'pos', faded: !inside }] : []),
          ...(sl ? [{ y: sc.y(sl), label: out && tp ? 'SL cancelled' : `SL ${fmtP(sl)}`, tone: 'neg', dashed: out && !!tp, faded: !inside || (out && !!tp) }] : []),
        ]}
      />
      <Head x={fx(t)} y={sc.y(sampleAt(path, t))} />
    </>
  );
  return {
    svg,
    steps: [spec.entry === 'limit' ? `${verbOf(side)} ${fmtQ(plan.total ?? 0)} ${base} when the price reaches ${fmtP(entry)}` : `${verbOf(side)} ${fmtQ(plan.total ?? 0)} ${base} at market`, `Places ${[tp && `TP ${fmtP(tp)}`, sl && `SL ${fmtP(sl)}`].filter(Boolean).join(' and ') || 'its exits'} on SoDEX`, tp && sl ? 'When one fills, the other is cancelled' : 'Closes at the exit'],
    step: out ? 2 : inside ? 1 : 0,
    status: out ? `Closed at ${tp ? 'TP' : 'SL'} ${fmtP(exit)}` : inside ? `In at ${fmtP(entry)}` : `Waiting for ${fmtP(entry)}`,
    done: out ? 1 : inside ? 0.5 : 0,
    note: EXAMPLE,
  };
}

/* sweep: Fill fast, how it works - rounds against the book's real depth */

/** Labels that ride on moving lines: each at the right, at the height its line has reached, joined to the line's end. */
function EndTags({ rules }: { rules: Array<{ x: number; y: number; label: string; tone: string }> }) {
  return (
    <>
      {spread(rules).map((r) => (
        <g key={r.label} className={`algo-st__rule is-${r.tone} is-end`}>
          <path className="algo-st__lead" d={`M${r.x.toFixed(1)},${r.y.toFixed(1)} L${X1},${r.y.toFixed(1)} L${X1 + 4},${r.ty.toFixed(1)}`} />
          <g transform={`translate(${X1 + 4},${r.ty})`}>
            <rect x={0} y={-8} width={PR - 8} height={16} rx={4} />
            <text x={6} y={3.5}>{r.label}</text>
          </g>
        </g>
      ))}
    </>
  );
}

/** At most this many rounds are drawn one by one; more are summed up in words. */
const MAX_ROUNDS_DRAWN = 36;

function sweepScene(t: number, p: StoryProps): Scene | null {
  const { plan, spec, side, mid, base, sweepRef, bandDepth, book } = p;
  if (spec?.kind !== 'sweep') return null;
  const ref0 = sweepRef?.price ?? mid;
  if (!ref0) return null;
  const slip = spec.slippageBps / 10_000;
  const away = side === 'buy' ? 1 : -1;
  const total = plan.total ?? 0;
  const gap = ref0 * slip;
  const book1 = side === 'buy' ? 'ask' : 'bid';
  // Each round can take what the book holds within the max slippage: its average over the last updates.
  // The book is taken to refill to that average between rounds (500 ms or more apart).
  const per = bandDepth && bandDepth > 0 ? bandDepth : null;
  const need = per ? Math.max(1, Math.ceil(total / per - 1e-9)) : 2;
  // A round waits only when SoDEX's best ask (a sell: bid) was past the limit when the window opened.
  const real0 = book ? (side === 'buy' ? book.ask : book.bid) : null;
  const pastNow = real0 !== null && real0 > 0 && (away > 0 ? real0 > ref0 + gap : real0 < ref0 - gap);
  const waitAt = new Set(pastNow ? [0] : []);
  const rounds = need + waitAt.size;
  const drawn = Math.min(rounds, MAX_ROUNDS_DRAWN);
  const roundMs = spec.roundMs;
  // The reference holds near its value when the window opened (the one the facts show); it only wiggles.
  const refPath = examplePath([[0, ref0], [1, ref0]], gap * 0.04);
  const capPath = refPath.map((r) => r * (1 + away * slip));
  // The best ask: where SoDEX's book had it when the window opened on the rounds that fill (when that is
  // within the limit), past the limit on the ones that wait.
  const realIn = real0 !== null && real0 > 0 && !pastNow ? real0 : null;
  const keys: Array<[number, number]> = [];
  for (let i = 0; i < drawn; i++) {
    const f = (i + 0.5) / drawn;
    const r = sampleAt(refPath, f);
    const inside = realIn !== null ? realIn + away * gap * 0.06 * Math.sin(i * 1.7) : r + away * gap * (0.35 + 0.25 * Math.sin(i * 1.7));
    keys.push([f, waitAt.has(i) ? r + away * gap * 1.35 : inside]);
  }
  const touchPath = examplePath([[0, keys[0]![1]], ...keys, [1, keys[keys.length - 1]![1]]], gap * 0.04);
  const sc = priceScale([...refPath, ...touchPath, ...capPath], 0.12);
  const tone = dirTone(side);
  let filled = 0;
  let sent = 0;
  let waits = 0;
  const marks: ReactNode[] = [];
  for (let i = 0; i < drawn; i++) {
    const f = (i + 0.5) / drawn;
    if (f > t || filled >= total - 1e-12) break;
    const touch = sampleAt(touchPath, f);
    const cap = sampleAt(capPath, f);
    if (!waitAt.has(i)) {
      const q = Math.min(total - filled, per ?? total / need);
      filled += q;
      sent++;
      marks.push(
        <g key={i} className={`algo-st__ioc is-${tone}`}>
          <line x1={fx(f)} x2={fx(f)} y1={sc.y(touch)} y2={sc.y(cap)} />
          <Dot x={fx(f)} y={sc.y(touch)} tone={tone} pulse={t - f < 0.04} />
          {drawn <= 8 && <text x={fx(f) + 5} y={sc.y(cap) + (away > 0 ? -6 : 12)}>{fmtQ(q)}</text>}
        </g>,
      );
    } else {
      waits++;
      marks.push(<circle key={i} className="algo-st__wait" cx={fx(f)} cy={sc.y(cap)} r={2.6}><title>{`The best ${book1} is past your max slippage: no order this round`}</title></circle>);
    }
  }
  // With more rounds than are drawn, the rest fill as the drawn ones do.
  if (t >= 1 && rounds > drawn) filled = total;
  const n = Math.max(1, Math.round(t * (refPath.length - 1)));
  let zone = '';
  for (let i = 0; i <= n; i++) zone += `${i ? 'L' : 'M'}${fx(i / (refPath.length - 1)).toFixed(1)},${sc.y(refPath[i]!).toFixed(1)}`;
  for (let i = n; i >= 0; i--) zone += `L${fx(i / (refPath.length - 1)).toFixed(1)},${sc.y(capPath[i]!).toFixed(1)}`;
  const name = sweepRef?.name ?? 'Reference';
  const xNow = fx(t);
  const refNow = sampleAt(refPath, t);
  const capNow = sampleAt(capPath, t);
  const touchNow = sampleAt(touchPath, t);
  const svg = (
    <>
      {priceGrid(sc.y, sc.ticks)}
      <path className={`algo-st__bandarea is-${tone}`} d={`${zone}Z`} />
      <path className="algo-st__path is-ref" d={pathD(refPath, sc.y, t)} />
      <path className={`algo-st__edge is-${tone}`} d={pathD(capPath, sc.y, t)} />
      <path className="algo-st__path is-touch" d={pathD(touchPath, sc.y, t)} />
      {marks}
      <EndTags
        rules={[
          { x: xNow, y: sc.y(refNow), label: `${name} ${fmtP(refNow)}`, tone: 'now' },
          { x: xNow, y: sc.y(capNow), label: `Max slippage ${fmtP(capNow)}`, tone },
          { x: xNow, y: sc.y(touchNow), label: `Best ${book1} ${fmtP(touchNow)}`, tone: 'muted' },
        ]}
      />
      <Head x={xNow} y={sc.y(touchNow)} />
      <text className="algo-st__tick" x={fx(0)} y={H - 8}>0</text>
      <text className="algo-st__tick" x={X1} y={H - 8} textAnchor="end">+{fmtDuration(drawn * roundMs)}</text>
    </>
  );
  const took = fmtDuration(rounds * roundMs);
  return {
    svg,
    legend: [
      { swatch: 'line', text: `best ${book1} on SoDEX` },
      { swatch: 'dotline', text: name.toLowerCase() },
      { swatch: `dash is-${tone}`, text: `max slippage (${pct(slip, 2)} ${away > 0 ? 'above' : 'below'} it)` },
      { swatch: `area is-${tone}`, text: 'where it may fill' },
      { swatch: `dot is-${tone}`, text: 'an IOC sent, what it fills' },
      { swatch: 'ring', text: 'a round that waits' },
    ],
    steps: [
      per
        ? `SoDEX’s book holds about ${fmtQ(per)} ${base} within your max slippage (its average over the last updates): ${need === 1 ? 'one round fills it all' : `about ${need} rounds for ${fmtQ(total)} ${base}`}`
        : `Book depth not read yet: shown as ${need} rounds`,
      `Every ${fmtDuration(roundMs)}: with the best ${book1} past your max slippage it waits; within it, one IOC for all that is left, limited at the max-slippage price`,
      pastNow ? `Now SoDEX’s best ${book1} is past your max slippage: it waits until it is within it` : `${need === 1 ? 'One IOC' : `${need} IOCs`}, about ${took}${rounds > drawn ? ` (the first ${drawn} drawn)` : ''}`,
    ],
    step: sent === 0 ? 0 : filled < total - 1e-12 ? 1 : 2,
    status: `${sent} of ${need} IOC${need === 1 ? '' : 's'} · ${waits} waited · ${fmtQ(filled)} of ${fmtQ(total)} ${base}`,
    done: total ? filled / total : 0,
    note: `${need > 1 ? 'A round after the first fills what the book has refilled; here it is taken to refill to its average. ' : ''}The price moves are an example.${per ? '' : ' Enter the amount on the ticket to read the book’s depth.'}`,
  };
}

/* one slice of a time-sliced order, by its execution, on SoDEX's real book */

function sliceScene(t: number, p: StoryProps): Scene | null {
  const { plan, spec, side, mid, base, book, refs } = p;
  if (!mid || !spec || (spec.kind !== 'twap' && spec.kind !== 'vwap' && spec.kind !== 'pov')) return null;
  const kids = (plan.schedule?.length ? plan.schedule : plan.children).filter((c) => c.qty > 0);
  const qty = kids.length ? kids.reduce((a, c) => a + c.qty, 0) / kids.length : plan.total ?? 0;
  const interval = plan.intervalMs ?? (plan.endsAt && kids.length > 1 ? (plan.endsAt - plan.startsAt) / (kids.length - 1) : 60_000);
  const ex = spec.exec;
  const sgn = side === 'buy' ? 1 : -1;
  // The real spread at the moment the window opened.
  const bid0 = book && book.ask > book.bid ? book.bid : mid - mid * 0.00001;
  const ask0 = book && book.ask > book.bid ? book.ask : mid + mid * 0.00001;
  const spread = ask0 - bid0;
  const mid0 = (bid0 + ask0) / 2;
  // Within one slice the market moves a few spreads (an example), away from the order, back once.
  const wig = Math.max(spread * 4, mid0 * 0.00004);
  const path = examplePath([[0, mid0], [0.25, mid0 + sgn * wig * 0.5], [0.38, mid0 - sgn * wig * 0.5], [0.7, mid0 + sgn * wig * 1.0], [1, mid0 + sgn * wig * 1.2]], wig * 0.12);
  const near = (x: number) => x - sgn * (spread / 2); // the order's own side: a buy's bid
  const far = (x: number) => x + sgn * (spread / 2); // what it takes: a buy's ask
  const maker = ex.style === 'maker';
  const taker = ex.style === 'taker';
  const lateF = taker ? 0.03 : maker ? null : Math.min(0.95, Math.max(0.05, ex.makerShare));
  const dipF = 0.38;
  const restFill = taker ? 0 : maker ? 0.55 : 0.4;
  const tone = dirTone(side);
  const slip = ex.slippageBps / 10_000;
  // What the slippage is measured from, as the engine does (ExecSpec.slipFrom).
  const from = ex.slipFrom ?? 'touch';
  const fixedRef = from === 'mid' ? refs?.mid ?? mid0 : from === 'mark' ? refs?.mark : from === 'index' ? refs?.index : from === 'oracleMid' ? refs?.oracleMid : from === 'oracleFair' ? refs?.oracleFair : null;
  const takeF = lateF ?? 1;
  const base0 = from === 'touch' ? far(sampleAt(path, takeF)) : fixedRef ?? null;
  const cap = base0 ? base0 * (1 + sgn * slip) : null;
  // The scale is the book's: the bid, the ask and the reference. A max slippage far past them is marked at the edge, not stretched to.
  const core = [...path.map(near), ...path.map(far), ...(fixedRef ? [fixedRef] : [])];
  const span0 = Math.max(...core) - Math.min(...core);
  const capOn = cap !== null && !maker && Math.abs(cap - mid0) < span0 * 2.5;
  const sc = priceScale([...core, ...(capOn ? [cap!] : [])], capOn || maker || cap === null ? 0.12 : 0.2);
  let filled = 0;
  const dots: ReactNode[] = [];
  if (!taker && t >= dipF) {
    filled += qty * restFill;
    dots.push(<Dot key="r" x={fx(dipF)} y={sc.y(near(sampleAt(path, dipF)))} tone={tone} pulse={t - dipF < 0.06} />);
  }
  if (lateF !== null && t >= lateF) {
    filled = qty;
    dots.push(<Dot key="l" x={fx(lateF)} y={sc.y(far(sampleAt(path, lateF)))} tone={tone} pulse={t - lateF < 0.06} />);
  }
  const xNow = fx(t);
  const refName = SLIP_NAMES[from] ?? 'Best price';
  const tags: Array<{ x: number; y: number; label: string; tone: string }> = [
    { x: xNow, y: sc.y(far(sampleAt(path, t))), label: `${side === 'buy' ? 'Ask' : 'Bid'} ${fmtP(far(sampleAt(path, t)))}`, tone: 'muted' },
    { x: xNow, y: sc.y(near(sampleAt(path, t))), label: `${side === 'buy' ? 'Bid' : 'Ask'} ${fmtP(near(sampleAt(path, t)))}`, tone: 'now' },
  ];
  const svg = (
    <>
      {priceGrid(sc.y, sc.ticks)}
      <path className="algo-st__path is-touch" d={pathD(path.map(far), sc.y, t)} />
      <path className="algo-st__path is-ref" d={pathD(path.map(near), sc.y, t)} />
      {!taker && <path className={`algo-st__order is-${tone}`} d={pathD(path.map(near), sc.y, Math.min(t, lateF ?? 1))} />}
      {lateF !== null && !taker && (
        <g className="algo-st__met">
          <line x1={fx(lateF)} x2={fx(lateF)} y1={PT} y2={Y1} />
          <text x={fx(lateF) + 4} y={PT + 10}>takes the rest</text>
        </g>
      )}
      {fixedRef && <Rule y={sc.y(fixedRef)} label={`${refName} ${fmtP(fixedRef)}`} tone="warn" dashed />}
      {cap !== null && !maker && capOn && <Rule y={sc.y(cap)} label={`Max slippage ${fmtP(cap)}`} tone={tone} dashed />}
      {cap !== null && !maker && !capOn && (
        // Far past the book: drawn at the edge, past a break in the price axis (≈), at its real price.
        <g className="algo-st__break">
          <Rule y={sgn > 0 ? PT + 2 : Y1 - 2} label={`Max slippage ${fmtP(cap)}`} tone={tone} dashed />
          <path d={sgn > 0 ? `M${PL - 5},${PT + 11} l4,-3 l2,3 l4,-3 M${PL - 5},${PT + 15} l4,-3 l2,3 l4,-3` : `M${PL - 5},${Y1 - 11} l4,-3 l2,3 l4,-3 M${PL - 5},${Y1 - 15} l4,-3 l2,3 l4,-3`} />
        </g>
      )}
      {dots}
      <EndTags rules={tags} />
      <Head x={xNow} y={sc.y(sampleAt(path, t))} />
      <text className="algo-st__tick" x={fx(0)} y={H - 8}>slice due</text>
      <text className="algo-st__tick" x={X1} y={H - 8} textAnchor="end">+{fmtDuration(interval)} next slice</text>
    </>
  );
  const sliceW = `${fmtQ(qty)} ${base}`;
  const capW = cap !== null ? `${fmtP(cap)}, ${pct(slip, 2)} ${sgn > 0 ? 'above' : 'below'} the ${from === 'touch' ? (side === 'buy' ? 'ask' : 'bid') : refName.toLowerCase()}` : `${pct(slip, 2)} past the ${refName.toLowerCase()}`;
  const steps = taker
    ? [`Each slice of ~${sliceW} is due every ${fmtDuration(interval)}`, `Taken at once: an IOC limited at ${capW}`, 'Then nothing until the next slice']
    : maker
      ? [`Each slice of ~${sliceW} rests at the ${side === 'buy' ? 'bid' : 'ask'}`, `Re-priced to the best price as it moves (once it is ${ex.chaseTicks} tick${ex.chaseTicks === 1 ? '' : 's'} behind)`, 'Fills only when the market comes to it; never takes']
      : [`Each slice of ~${sliceW} rests at the ${side === 'buy' ? 'bid' : 'ask'} first`, `For ${pct(ex.makerShare)} of the ${fmtDuration(interval)} it follows the best price`, `Then what is still open is taken: an IOC limited at ${capW}`];
  return {
    svg,
    legend: [
      { swatch: 'line', text: `best ${side === 'buy' ? 'ask' : 'bid'}` },
      { swatch: 'dotline', text: `best ${side === 'buy' ? 'bid' : 'ask'}` },
      ...(!taker ? [{ swatch: `order is-${tone}`, text: 'your resting order' }] : []),
      ...(fixedRef ? [{ swatch: 'dash is-warn', text: `${refName.toLowerCase()}: slippage measured from it` }] : []),
      ...(!maker ? [{ swatch: `dash is-${tone}`, text: 'max slippage: the worst price taken' }] : []),
      { swatch: `dot is-${tone}`, text: 'a fill' },
    ],
    steps,
    step: taker ? (t < 0.03 ? 0 : 1) : t < dipF ? 0 : lateF !== null && t >= lateF ? 2 : 1,
    status: `${fmtQ(filled)} of ${sliceW}${filled > 0 && !taker ? ` · ${filled > qty * restFill + 1e-12 ? 'part rested, rest taken' : 'resting fill'}` : ''}`,
    done: qty ? filled / qty : 0,
    note: `Bid and ask as they were when this window opened (spread ${fmtP(spread)}); how they move here is an example.`,
  };
}

const SLIP_NAMES: Record<string, string> = { touch: 'Best price', mid: 'SoDEX mid', mark: 'SoDEX mark', index: 'SoDEX index', oracleMid: 'Oracle mid', oracleFair: 'Oracle fair price' };

/* VWAP: the market's usual volume over the hours of the day, and where the order runs in it */

function vwapDayScene(t: number, p: StoryProps): Scene | null {
  const { plan, spec, side, base, dayVolume, tz } = p;
  if (spec?.kind !== 'vwap') return null;
  const kids = (plan.schedule?.length ? plan.schedule : plan.children).filter((c) => c.at !== null && c.qty > 0).sort((a, b) => a.at! - b.at!);
  if (!kids.length) return null;
  const HOUR = 3_600_000;
  const start = plan.startsAt;
  const end = Math.max(plan.endsAt ?? kids[kids.length - 1]!.at!, start + 60_000);
  const from = dayVolume?.from ?? Math.floor(start / HOUR) * HOUR - 4 * HOUR;
  const to = from + 24 * HOUR;
  const x = (ms: number) => PL + ((Math.min(Math.max(ms, from), to) - from) / (to - from)) * IW;
  // The chart's own zone (its footer switch): local or UTC.
  const clock = (ms: number) => {
    const dd = new Date(ms);
    const h = tz === 'utc' ? dd.getUTCHours() : dd.getHours();
    const mi = tz === 'utc' ? dd.getUTCMinutes() : dd.getMinutes();
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  };
  const vol = dayVolume && dayVolume.v.length === 24 && dayVolume.v.some((v) => v > 0) ? dayVolume.v : null;
  const vmax = vol ? Math.max(...vol) : 1;
  const yV = (v: number) => Y1 - (v / vmax) * IH * 0.82;
  const T = start + t * (end - start);
  const bw = IW / 24 - 2;
  const bars = Array.from({ length: 24 }, (_, i) => {
    const h0 = from + i * HOUR;
    const v = vol ? vol[i]! : 0;
    const inside = h0 + HOUR > start && h0 < end;
    return (
      <rect key={i} className={`algo-st__hour${inside ? ` is-${dirTone(side)}` : ''}`} x={x(h0) + 1} y={yV(v)} width={bw} height={Math.max(0.5, Y1 - yV(v))}>
        <title>{`${clock(h0)}: usually ${fmtQ(v)} ${base} an hour`}</title>
      </rect>
    );
  });
  const qmax = Math.max(...kids.map((c) => c.qty));
  const sent = kids.filter((c) => c.at! <= T);
  const ticks = kids.map((c, i) => (
    <line key={i} className={`algo-st__due is-${dirTone(side)}${c.at! <= T ? ' is-on' : ''}`} x1={x(c.at!)} x2={x(c.at!)} y1={Y1} y2={Y1 - 4 - 14 * (c.qty / qmax)} />
  ));
  const dayTotal = vol ? vol.reduce((a, v) => a + v, 0) : 0;
  let inWin = 0;
  if (vol) for (let ms = start; ms < end; ms += 60_000) inWin += (vol[Math.floor((ms - from) / HOUR)] ?? 0) / 60;
  const hoursSpanned = new Set(kids.map((c) => Math.floor(c.at! / HOUR))).size;
  const weekend = [0, 6].includes(new Date(start).getUTCDay());
  const labels = [0, 6, 12, 18, 24].map((h) => (
    <text key={h} className="algo-st__tick" x={x(from + h * HOUR)} y={H - 8} textAnchor={h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}>{clock(from + h * HOUR)}</text>
  ));
  // The scale is relative: a bracket from nothing to the busiest hour, named, instead of numbers.
  const bx = PL - 16;
  const svg = (
    <>
      <rect className="algo-st__window" x={x(start)} y={PT} width={Math.max(2, x(end) - x(start))} height={IH} />
      {bars}
      {ticks}
      <line className="algo-st__axis" x1={PL} x2={X1} y1={Y1} y2={Y1} />
      <g className="algo-st__range">
        <line x1={bx} x2={bx} y1={yV(vmax)} y2={Y1} />
        <line x1={bx - 4} x2={bx + 4} y1={yV(vmax)} y2={yV(vmax)} />
        <line x1={bx - 4} x2={bx + 4} y1={Y1} y2={Y1} />
        <text transform={`translate(${bx - 7},${(yV(vmax) + Y1) / 2}) rotate(-90)`} textAnchor="middle">usual volume</text>
      </g>
      <Head x={x(T)} y={Y1 - 4} />
      {labels}
      {!vol && <text className="algo-st__unit" x={PL + IW / 2} y={PT + IH / 2} textAnchor="middle">Reading the usual volume…</text>}
    </>
  );
  return {
    svg,
    legend: [
      { swatch: 'bar is-muted', text: `usual volume each hour (${weekend ? 'weekends' : 'weekdays'}, median of the last ${spec.lookbackDays} days)` },
      { swatch: `bar is-${dirTone(side)}`, text: 'the hours your order runs in' },
      { swatch: `tick is-${dirTone(side)}`, text: 'its slices, by size' },
    ],
    steps: [
      `The market’s usual volume by hour on ${weekend ? 'weekends' : 'weekdays'}, in the chart’s time (${tz === 'utc' ? 'UTC' : 'local'})`,
      vol ? `Your order runs ${clock(start)}–${clock(end)}, when ${pct(inWin / (dayTotal || 1), 1)} of a usual day’s volume trades` : `Your order runs ${clock(start)}–${clock(end)}`,
      hoursSpanned > 1 ? 'Its slices are bigger in the hours that usually trade more' : 'Within one hour the profile is even, so are its slices; over several hours they follow the curve',
    ],
    step: t < 0.15 ? 0 : t < 0.5 ? 1 : 2,
    status: `${sent.length} of ${kids.length} slices due`,
    done: sent.reduce((a, c) => a + c.qty, 0) / (kids.reduce((a, c) => a + c.qty, 0) || 1),
    note: 'Volume from SoDEX’s hourly candles, the way the engine builds its profile (same time of day, weekdays with weekdays).',
  };
}

type View = 'chart' | 'schedule' | 'slice' | 'how' | 'volume';
const VIEW_NAMES: Record<View, string> = { chart: 'Chart', schedule: 'Schedule', slice: 'Each slice', how: 'How it works', volume: 'Usual volume' };

/** The pictures a kind has, the first shown first. */
export function viewsFor(p: StoryProps): View[] {
  const k = p.spec?.kind;
  if (k === 'sweep') return ['how'];
  if (k === 'vwap') return ['volume', 'schedule', 'slice'];
  if (k === 'twap') return p.uiKind === 'chasetwap' ? ['slice', 'schedule'] : ['schedule', 'slice'];
  if (k === 'pov') return ['schedule', 'slice'];
  if (k === 'swarm' || k === 'basket') return ['schedule'];
  return ['chart'];
}

export function sceneFor(t: number, p: StoryProps, view: View = viewsFor(p)[0]!): Scene | null {
  const { spec, plan } = p;
  // Real recent prices behind the price-level pictures; not behind one slice or Fill fast's rounds (their seconds vanish against 90 minutes).
  const hist = view === 'chart' ? (p.history ?? []).filter((h) => h.p > 0) : [];
  F.hist = hist.length > 3 ? hist : [];
  F.hf = F.hist.length ? HIST_SHARE : 0;
  if (view === 'how') return sweepScene(t, p);
  if (view === 'volume') return vwapDayScene(t, p);
  if (view === 'slice') return sliceScene(t, p);
  switch (spec?.kind) {
    case 'scale':
      return ladderScene(t, p);
    case 'iceberg':
      return icebergScene(t, p);
    case 'chase':
      return chaseScene(t, p);
    case 'trailing':
      return trailingScene(t, p);
    case 'conditional':
      return conditionScene(t, p);
    case 'bracket':
      return bracketScene(t, p);
    case 'sweep':
      return sweepScene(t, p);
    default:
      return timeScene(t, p) ?? (plan.children.some((c) => c.price !== null) ? ladderScene(t, p) : null);
  }
}

/* --------------------------------------------------------------- whole ----- */

export function AlgoStory(p: StoryProps) {
  const views = viewsFor(p);
  const [picked, setPicked] = useState<View | null>(null);
  const view = picked && views.includes(picked) ? picked : views[0]!;
  // Prices and sizes that follow the live price move every tick, so they count only to 3 digits.
  const r3 = (x: number | null) => (x ? Number(x.toPrecision(3)) : 0);
  const key = `${view}|${p.spec?.kind}|${p.side}|${p.plan.children.length}|${r3(p.plan.total)}|${p.plan.children.slice(0, 60).map((c) => `${r3(c.qty)}@${r3(c.price)}`).join(',')}`;
  const ph = usePlayhead(key);
  const s = sceneFor(ph.t, p, view);
  return (
    <figure className={`algo-st is-${p.side}`}>
      {views.length > 1 && (
        <div className="algo-st__views" role="tablist" aria-label="Pictures">
          {views.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={v === view} className={`algo-chip${v === view ? ' is-on' : ''}`} onClick={() => setPicked(v)}>
              {VIEW_NAMES[v]}
            </button>
          ))}
        </div>
      )}
      {!s ? (
        <p className="oe-hint">Nothing to draw yet.</p>
      ) : (
        <>
          <div className="algo-st__top">
            <span className="algo-st__status" aria-live="off">{s.status}</span>
            <span className="algo-st__ctl">
              {p.onShuffle && view === 'schedule' && (
                <button type="button" className="algo-chip" onClick={p.onShuffle} title="Draw another random schedule (sizes and times)">New draw</button>
              )}
              {(
                <>
                  <button type="button" className="algo-chip" onClick={ph.toggle} aria-label={ph.playing ? 'Pause' : 'Play'}>
                    {ph.playing ? (
                      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" /></svg>
                    ) : (
                      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.5v9l7-4.5z" fill="currentColor" /></svg>
                    )}
                  </button>
                  <button type="button" className="algo-chip" onClick={ph.replay} aria-label="Play from the start">
                    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.2 6a3.8 3.8 0 1 0 1.1-2.7M2 1.6v2.2h2.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                </>
              )}
            </span>
          </div>
          <div className="algo-st__meter" aria-hidden="true"><span style={{ width: `${Math.round(Math.min(1, s.done) * 100)}%` }} /></div>
          {s.legend && s.legend.length > 0 && (
            <ul className="algo-st__key" aria-label="What the marks mean">
              {s.legend.map((l) => (
                <li key={l.text}><i className={`algo-st__sw algo-st__sw--${l.swatch.split(' ')[0]} ${l.swatch.split(' ').slice(1).join(' ')}`} aria-hidden="true" />{l.text}</li>
              ))}
            </ul>
          )}
          <svg className="algo-st__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={s.steps.join('. ')}>
            {s.svg}
          </svg>
          <ol className="algo-st__steps">
            {s.steps.map((x, i) => (
              <li key={i} className={i === s.step ? 'is-on' : i < s.step ? 'is-past' : ''}>
                <span className="algo-st__n">{i + 1}</span>
                {x}
              </li>
            ))}
          </ol>
          {s.note && <figcaption className="algo-st__note">{s.note}</figcaption>}
        </>
      )}
    </figure>
  );
}
