/**
 * A weighted DCA's size curve: every order's size as a bar at its level, the curve through
 * the user's points over them. Drag a point to reshape it, click anywhere off a point to add
 * one there, double-click (or right-click) a middle point to take it away. The ends stay at the
 * first and the last order; sizes run from CURVE_MIN to CURVE_MAX times Each buy.
 */
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { CURVE_MAX, CURVE_MIN, cleanCurve, curveAt, type CurvePoint } from './draft';

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

export function DcaCurve({ points, orders, each, unit, side, onChange }: {
  points: CurvePoint[];
  /** How many orders the ladder has (a bar each). */
  orders: number;
  /** Each buy, in `unit`: the size at 1×. */
  each: number;
  unit: string;
  side: 'buy' | 'sell';
  onChange: (p: CurvePoint[]) => void;
}) {
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
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? String(round(v, 2)) : String(Number(v.toPrecision(2))));
  const levels = Array.from({ length: n }, (_, i) => (n > 1 ? i / (n - 1) : 0));
  const labelEvery = n <= 10 ? 1 : Math.ceil(n / 10);
  const total = levels.reduce((a, x) => a + each * curveAt(points, x), 0);
  return (
    <div className={`algo-curve is-${side}`}>
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
                  <text x={sx(x)} y={H - 7} textAnchor="middle" className="algo-curve__axis">{i + 1}</text>
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
        </span>
      </div>
      <div className="algo-curve__presets">
        {(
          [
            ['Rising', [[0, 1], [1, 2.5]]],
            ['Steep end', [[0, 1], [0.6, 1.4], [1, 4]]],
            ['Even', [[0, 1], [1, 1]]],
            ['Falling', [[0, 2.5], [1, 1]]],
          ] as Array<[string, CurvePoint[]]>
        ).map(([name, pts]) => (
          <button key={name} type="button" className={JSON.stringify(pts) === JSON.stringify(points) ? 'is-on' : undefined} onClick={() => onChange(pts)}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
