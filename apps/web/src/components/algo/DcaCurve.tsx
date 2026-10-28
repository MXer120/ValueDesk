/**
 * A weighted DCA's size curve: every order's size as a bar at its level, the curve through
 * the user's points over them. Drag a point to reshape it, click anywhere off a point to add
 * one there, double-click (or right-click) a middle point to take it away. The ends stay at the
 * first and the last order; sizes run from CURVE_MIN to CURVE_MAX times Each buy.
 *
 * Top right, as the Trade and Portfolio panels have them: View (the axis by order or by price),
 * a shape to start from, Smooth (dcaCurveMath.smoothCurve) and Revert (undoes the last Smooth,
 * fit or shape). Under it: an average fill price to fit the curve to (fitAvg: the same shape and
 * spend, tilted).
 */
import { localize, toInputText } from '../../numStyle';
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { ViewPop } from '../ViewPop';
import { Section, Seg } from '../accountTables/FilterBar';
import { MiniSelect } from './MarketSelect';
import { CURVE_MAX, CURVE_MIN, cleanCurve, curveAt, type CurvePoint } from './draft';
import { avgReach, fitAvg, ladderAvg, smoothCurve } from './dcaCurveMath';
import { decimalInput } from '../numberInput';

const W = 340;
const H = 170;
const L = 34; // room for the × labels
const R = 10;
const T = 26; // room for the size labels over the bars
const B = 22; // room for the level numbers
const iw = W - L - R;
const ih = H - T - B;

const sx = (x: number) => L + x * iw;
const sy = (y: number) => T + ih - (y / CURVE_MAX) * ih;
const fromX = (px: number) => Math.min(1, Math.max(0, (px - L) / iw));
const fromY = (py: number) => Math.min(CURVE_MAX, Math.max(CURVE_MIN, ((T + ih - py) / ih) * CURVE_MAX));
const round = (v: number, dp: number) => Number(v.toFixed(dp));

/** A price as the axis shows it: whole above 1,000, cents to 1, significant digits below. */
const pxText = (p: number): string =>
  p >= 1000 ? Math.round(p).toLocaleString('en-US') : p >= 1 ? p.toFixed(2) : String(Number(p.toPrecision(4)));
/** `pxText` in the number format (numStyle.ts). */
const fmtPx = (p: number): string => localize(pxText(p));

/** The axis' short form, so ten prices fit under ten bars: 80.1k, 1.25k, 3.42. */
const axisPx = (p: number): string => localize(p >= 1000 ? `${Number((p / 1000).toPrecision(p >= 100_000 ? 4 : 3))}k` : Number(p.toPrecision(3)).toString());

const SHAPES: Array<[string, string, CurvePoint[]]> = [
  ['rising', 'Rising', [[0, 1], [1, 2.5]]],
  ['steep', 'Steep end', [[0, 1], [0.6, 1.4], [1, 4]]],
  ['even', 'Even', [[0, 1], [1, 1]]],
  ['falling', 'Falling', [[0, 2.5], [1, 1]]],
];

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const SlidersGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4.5h12M2 11.5h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" /><circle cx="10.5" cy="4.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.5" cy="11.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /></svg>
);

export function DcaCurve({ points, orders, each, unit, side, prices, coin, onChange }: {
  points: CurvePoint[];
  /** How many orders the ladder has (a bar each). */
  orders: number;
  /** Each buy, in `unit`: the size at 1×. */
  each: number;
  unit: string;
  side: 'buy' | 'sell';
  /** Each order's price (null: no first price yet). */
  prices: number[] | null;
  /** Each buy is in the coin (else USD): how the average weighs the orders. */
  coin: boolean;
  onChange: (p: CurvePoint[]) => void;
}) {
  const [axis, setAxis] = useState<'order' | 'price'>('order');
  const [viewOpen, setViewOpen] = useState(false);
  const viewBtn = useRef<HTMLButtonElement>(null);
  // What Revert goes back to: the curve before the last Smooth, fit or preset.
  const [undo, setUndo] = useState<CurvePoint[] | null>(null);
  const [target, setTarget] = useState('');
  const [miss, setMiss] = useState<string | null>(null);
  const px = prices && prices.length === Math.max(1, Math.trunc(orders) || 1) && prices.every((p) => p > 0) ? prices : null;
  const avg = px ? ladderAvg(points, px, coin) : null;
  const replace = (next: CurvePoint[]) => {
    setUndo(points);
    setMiss(null);
    emit(next);
  };
  const fit = () => {
    const t = Number(target);
    if (!px || !(t > 0)) return;
    const out = fitAvg(points, px, coin, t);
    if (out) {
      replace(out);
      setTarget('');
      return;
    }
    const r = avgReach(points, px, coin);
    setMiss(r ? `This curve reaches ${fmtPx(r[0])} to ${fmtPx(r[1])}` : 'Out of reach');
  };
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDragState] = useState<number | null>(null);
  // The drag and the points as of the last event, not the last render: a quick drag moves
  // before React has drawn the point it just added.
  const dragRef = useRef<number | null>(null);
  const pts = useRef(points);
  pts.current = points;
  const setDrag = (i: number | null) => {
    dragRef.current = i;
    setDragState(i);
  };
  const emit = (p: CurvePoint[]) => {
    pts.current = p;
    onChange(p);
  };
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(1, Math.min(200, Math.trunc(orders) || 1));
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  const move = (i: number, e: { clientX: number; clientY: number }) => {
    const [px, py] = at(e);
    const next = pts.current.map((q) => [...q] as CurvePoint);
    const last = next.length - 1;
    // The ends stay at the first and last order; a middle point stays between its neighbours.
    const x = i === 0 ? 0 : i === last ? 1 : Math.min(next[i + 1]![0] - 0.02, Math.max(next[i - 1]![0] + 0.02, fromX(px)));
    next[i] = [round(x, 3), round(fromY(py), 2)];
    emit(next);
  };
  const down = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const [px, py] = at(e);
    // On a point (within 9 units): drag it. Elsewhere: a new point there, dragged at once.
    const hit = points.findIndex(([x, y]) => Math.hypot(sx(x) - px, sy(y) - py) < 9);
    svg.current!.setPointerCapture(e.pointerId);
    setMiss(null);
    if (hit >= 0) {
      setDrag(hit);
      return;
    }
    const x = fromX(px);
    if (x <= 0.02 || x >= 0.98) return;
    const next = cleanCurve([...points, [round(x, 3), round(fromY(py), 2)]]);
    const i = next.findIndex((q) => q[0] === round(x, 3));
    emit(next);
    setDrag(i >= 0 ? i : null);
  };
  const remove = (i: number) => {
    if (i <= 0 || i >= points.length - 1) return;
    emit(points.filter((_, k) => k !== i));
  };
  const path = (() => {
    const steps = 80;
    let d = '';
    for (let s = 0; s <= steps; s++) {
      const x = s / steps;
      d += `${s ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(curveAt(points, x)).toFixed(1)}`;
    }
    return d;
  })();
  const bw = Math.max(2, Math.min(18, (iw / n) * 0.55));
  const fmt = (v: number) => localize(v >= 100 ? v.toFixed(0) : v >= 1 ? String(round(v, 2)) : String(Number(v.toPrecision(2))));
  const levels = Array.from({ length: n }, (_, i) => (n > 1 ? i / (n - 1) : 0));
  const labelEvery = n <= 10 ? 1 : Math.ceil(n / 10);
  const total = levels.reduce((a, x) => a + each * curveAt(points, x), 0);
  return (
    <div className={`algo-curve is-${side}`}>
      <div className="algo-curve__head">
        <span className="algo-curve__title">Size per order</span>
        <div className="algo-curve__tools">
          <button
            ref={viewBtn}
            type="button"
            className={`acctf-view${viewOpen ? ' is-open' : ''}${axis !== 'order' ? ' is-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={viewOpen}
            onClick={() => setViewOpen((v) => !v)}
          >
            <SlidersGlyph />
            <span>View</span>
          </button>
          <ViewPop open={viewOpen} anchor={viewBtn} onClose={() => setViewOpen(false)} onReset={() => setAxis('order')} resetDisabled={axis === 'order'}>
            <Section label="Under the bars">
              <Seg value={axis === 'price' && !px ? 'order' : axis} onChange={(v) => setAxis(v === 'price' && !px ? 'order' : v)} options={[['order', 'Order number'], ['price', px ? 'Price' : 'Price (set a first price)']]} />
            </Section>
          </ViewPop>
          <MiniSelect
            label="Start from a shape"
            value={SHAPES.find(([, , p]) => JSON.stringify(p) === JSON.stringify(points))?.[0] ?? 'custom'}
            options={[...SHAPES.map(([v, t]) => [v, t] as const), ['custom', 'Custom']]}
            onChange={(v) => {
              const sh = SHAPES.find(([k]) => k === v);
              if (sh) replace(sh[2]);
            }}
          />
          <button type="button" className="algo-curve__icon" aria-label="Smooth" title="Smooth: bends onto orders, clean sizes, near-level parts made flat" onClick={() => replace(smoothCurve(points, n))}>
            <Icon d="M2 12.5 4.5 9 6 10.5 8.5 6 10 7.5 14 3.5M2 13.5c4 0 8-3 12-8" />
          </button>
          <button
            type="button"
            className="algo-curve__icon"
            aria-label="Revert"
            title={undo ? 'Revert: back to the curve before the last Smooth, fit or shape' : 'Nothing to revert'}
            disabled={!undo}
            onClick={() => {
              if (!undo) return;
              setUndo(null);
              setMiss(null);
              emit(undo);
            }}
          >
            <Icon d="M3.5 6.5h6.5a3.5 3.5 0 0 1 0 7H7M6 3.5l-3 3 3 3" />
          </button>
        </div>
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Each order's size along the ladder"
        onPointerDown={down}
        onPointerMove={(e) => {
          if (dragRef.current !== null) move(dragRef.current, e);
          else {
            const [px, py] = at(e);
            const hit = points.findIndex(([x, y]) => Math.hypot(sx(x) - px, sy(y) - py) < 9);
            setHover(hit >= 0 ? hit : null);
          }
        }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => setHover(null)}
        onContextMenu={(e) => {
          const [px, py] = at(e);
          const hit = points.findIndex(([x, y]) => Math.hypot(sx(x) - px, sy(y) - py) < 9);
          if (hit > 0 && hit < points.length - 1) {
            e.preventDefault();
            remove(hit);
          }
        }}
        onDoubleClick={(e) => {
          const [px, py] = at(e);
          remove(points.findIndex(([x, y]) => Math.hypot(sx(x) - px, sy(y) - py) < 9));
        }}
        style={{ cursor: drag !== null ? 'grabbing' : hover !== null ? 'grab' : 'crosshair' }}
      >
        {[1, 2, 3, 4, 5].map((y) => (
          <g key={y}>
            <line x1={L} x2={W - R} y1={sy(y)} y2={sy(y)} className={y === 1 ? 'algo-curve__one' : 'algo-curve__grid'} />
            <text x={L - 6} y={sy(y) + 3} textAnchor="end" className="algo-curve__axis">{y}×</text>
          </g>
        ))}
        {levels.map((x, i) => {
          const y = curveAt(points, x);
          return (
            <g key={i}>
              <rect x={sx(x) - bw / 2} y={sy(y)} width={bw} height={sy(0) - sy(y)} rx={2} className="algo-curve__bar" />
              {i % labelEvery === 0 && (
                <>
                  <text x={sx(x)} y={sy(y) - 10} textAnchor="middle" className="algo-curve__size">{fmt(each * y)}</text>
                  <text x={sx(x)} y={H - 7} textAnchor="middle" className="algo-curve__axis">{axis === 'price' && px ? axisPx(px[i]!) : i + 1}</text>
                </>
              )}
            </g>
          );
        })}
        <path d={path} className="algo-curve__line" />
        {points.map(([x, y], i) => (
          <circle key={i} cx={sx(x)} cy={sy(y)} r={drag === i || hover === i ? 6 : 4.5} className={`algo-curve__pt${i === 0 || i === points.length - 1 ? ' is-end' : ''}`} />
        ))}
      </svg>
      <div className="algo-curve__foot">
        <span>Drag a point · click to add one · double-click to remove</span>
        <span>
          {n} orders · {fmt(total)} {unit}
          {avg !== null && <> · avg {fmtPx(avg)}</>}
        </span>
      </div>
      <div className="algo-curve__fit">
        <label htmlFor="algo-curve-avg">Avg fill if all fill</label>
        <div className={`algo-sf${miss ? ' is-bad' : ''}`}>
          <input
            id="algo-curve-avg"
            autoComplete="off"
            inputMode="decimal"
            value={toInputText(target)}
            placeholder={avg !== null ? toInputText(pxText(avg).replace(/,/g, '')) : 'set a first price'}
            disabled={!px}
            onChange={(e) => {
              setTarget(decimalInput(e.target.value, { prev: target }));
              setMiss(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') fit();
            }}
          />
          <span className="algo-sf__unit">USD</span>
        </div>
        <button type="button" className="algo-curve__go" disabled={!px || !(Number(target) > 0)} onClick={fit}>
          Fit curve
        </button>
      </div>
      {miss ? <p className="oe-hint algo-ferr">{miss}</p> : <p className="algo-curve__note">Keeps the curve’s shape and what it spends; moves size toward the cheaper or dearer end until the average is yours.</p>}
    </div>
  );
}
