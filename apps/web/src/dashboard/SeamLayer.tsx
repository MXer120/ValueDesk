/**
 * The seams between panels, as thin handles over the grid's gutters
 * (seams.ts): drag the line under the chart and the book and both get shorter
 * while the positions under them get taller, and the same for a column line
 * and widths. Drawn over the grid in the same pixel geometry react-grid-layout
 * uses; a drag commits whole rows or columns as it crosses them.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clampSeam, findSeams, moveSeam, type Seam, type SeamBox } from './seams';

export interface SeamGrid {
  cols: number;
  width: number;
  rowHeight: number;
  margin: readonly [number, number];
  padding: readonly [number, number];
}

const HIT = 10;

export function SeamLayer({ items, grid, onMove }: {
  items: readonly SeamBox[];
  grid: SeamGrid;
  /** The panels after a step of the drag. */
  onMove: (next: SeamBox[]) => void;
}) {
  const seams = useMemo(() => findSeams(items), [items]);
  const drag = useRef<{ seam: Seam; start: number; base: readonly SeamBox[]; d: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const colW = (grid.width - grid.margin[0] * (grid.cols - 1) - grid.padding[0] * 2) / grid.cols;
  const left = (c: number) => grid.padding[0] + c * (colW + grid.margin[0]);
  const top = (r: number) => grid.padding[1] + r * (grid.rowHeight + grid.margin[1]);
  const keyOf = (s: Seam) => `${s.axis}:${s.at}:${s.from}`;

  const down = (s: Seam) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { seam: s, start: s.axis === 'h' ? e.clientY : e.clientX, base: items, d: 0 };
    setActive(keyOf(s));
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    const px = (g.seam.axis === 'h' ? e.clientY : e.clientX) - g.start;
    const unit = g.seam.axis === 'h' ? grid.rowHeight + grid.margin[1] : colW + grid.margin[0];
    const d = clampSeam(g.base, g.seam, px / unit);
    if (d === g.d) return;
    g.d = d;
    onMove(moveSeam(g.base, g.seam, d));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setActive(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="dash-seams" aria-hidden="true">
      {seams.map((s) => {
        const style = s.axis === 'h'
          ? { left: left(s.from), width: left(s.to) - grid.margin[0] - left(s.from), top: top(s.at) - grid.margin[1] / 2 - HIT / 2, height: HIT }
          : { top: top(s.from), height: top(s.to) - grid.margin[1] - top(s.from), left: left(s.at) - grid.margin[0] / 2 - HIT / 2, width: HIT };
        const k = keyOf(s);
        return (
          <div
            key={k}
            className={`dash-seam dash-seam--${s.axis}${active === k ? ' is-active' : ''}`}
            style={style}
            title={s.axis === 'h' ? 'Drag to resize the panels above and below' : 'Drag to resize the panels on either side'}
            onPointerDown={down(s)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        );
      })}
    </div>
  );
}
