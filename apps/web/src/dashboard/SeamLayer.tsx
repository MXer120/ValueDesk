/**
 * The seams between panels, as thin handles over the grid's gutters
 * (seams.ts): drag the line under the chart and the book and both get shorter
 * while the positions under them get taller, and the same for a column line
 * and widths. Drawn over the grid in the same pixel geometry react-grid-layout
 * uses; a drag commits whole rows or columns as it crosses them.
 *
 * Given `labels` (the layout editor's swap and split versions, where the seams are how a panel is resized), a drag
 * reads out the panels on either side of the line and their new widths or heights, in columns or rows.
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

export function SeamLayer({ items, grid, onMove, onDrag, labels }: {
  items: readonly SeamBox[];
  grid: SeamGrid;
  /** The panels after a step of the drag. */
  onMove: (next: SeamBox[]) => void;
  /** A drag starts (true) or ends (false): the grid stops easing panels meanwhile. */
  onDrag?: (on: boolean) => void;
  /** A panel's name: with it, a drag reads out both sides' sizes. */
  labels?: (id: string) => string;
}) {
  const seams = useMemo(() => findSeams(items), [items]);
  const drag = useRef<{ seam: Seam; start: number; base: readonly SeamBox[]; d: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [live, setLive] = useState<{ seam: Seam; d: number } | null>(null);

  const colW = (grid.width - grid.margin[0] * (grid.cols - 1) - grid.padding[0] * 2) / grid.cols;
  const left = (c: number) => grid.padding[0] + c * (colW + grid.margin[0]);
  const top = (r: number) => grid.padding[1] + r * (grid.rowHeight + grid.margin[1]);
  // By the panels on either side, not the line's place: a seam keeps its key (and its lit line) while it is dragged.
  const keyOf = (s: Seam) => `${s.axis}:${s.before.join(',')}|${s.after.join(',')}`;

  const down = (s: Seam) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { seam: s, start: s.axis === 'h' ? e.clientY : e.clientX, base: items, d: 0 };
    setActive(keyOf(s));
    setLive({ seam: s, d: 0 });
    onDrag?.(true);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    const px = (g.seam.axis === 'h' ? e.clientY : e.clientX) - g.start;
    const unit = g.seam.axis === 'h' ? grid.rowHeight + grid.margin[1] : colW + grid.margin[0];
    const d = clampSeam(g.base, g.seam, px / unit);
    if (d === g.d) return;
    g.d = d;
    setLive({ seam: g.seam, d });
    onMove(moveSeam(g.base, g.seam, d));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setActive(null);
    setLive(null);
    onDrag?.(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const readout = live && labels ? (() => {
    const { seam, d } = live;
    const by = new Map(items.map((b) => [b.i, b]));
    const size = (id: string) => {
      const b = by.get(id);
      return b ? (seam.axis === 'h' ? b.h : b.w) : 0;
    };
    const side = (ids: string[]) => {
      const shown = ids.slice(0, 2).map((id) => <span key={id}>{labels(id)} <b>{size(id)}</b></span>);
      return ids.length > 2 ? [...shown, <span key="more">+{ids.length - 2}</span>] : shown;
    };
    const line = seam.at + d;
    const style = seam.axis === 'h'
      ? { left: (left(seam.from) + left(seam.to) - grid.margin[0]) / 2, top: top(line) - grid.margin[1] / 2 }
      : { left: left(line) - grid.margin[0] / 2, top: (top(seam.from) + top(seam.to) - grid.margin[1]) / 2 };
    return (
      <div className={`dash-seam-readout dash-seam-readout--${seam.axis}`} style={style}>
        <span className="dash-seam-readout__side">{side(seam.before)}</span>
        <i aria-hidden="true">{seam.axis === 'h' ? 'rows' : 'cols'}</i>
        <span className="dash-seam-readout__side">{side(seam.after)}</span>
      </div>
    );
  })() : null;

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
      {readout}
    </div>
  );
}
