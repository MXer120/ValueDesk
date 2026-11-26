/**
 * The drag versions' marks over the grid (versions/store.ts; localhost only), in the grid's own pixel geometry
 * (the same as SeamLayer.tsx):
 *
 * - swap / split, while a panel is moved: where it lands, as a label on the spot it will take ("Swap with Chart",
 *   "Right of Chart"), and, in split, the target's four side bands and its middle with the one under the pointer lit.
 *   A move that cannot happen says why, on the target.
 * - flow, while a panel is dragged or resized: its name and size in columns x rows on the place the grid would drop
 *   it, and a guide line through every edge of it that meets another panel's edge.
 *
 * Draws only; every decision is Dashboard.tsx's (arrange.ts for the geometry).
 */
import type { LayoutItem } from 'react-grid-layout';
import { alignedEdges, SPLIT_BAND, type MoveResult, type Zone } from '../../arrange';
import type { DragVersion } from '../store';

interface Grid {
  cols: number;
  width: number;
  rowHeight: number;
  margin: readonly [number, number];
  padding: readonly [number, number];
}

interface Props {
  mode: DragVersion;
  grid: Grid;
  /** The layout as committed (a move's target is picked on it). */
  items: readonly LayoutItem[];
  move: { id: string; name: string; target: string | null; zone: Zone | null; result: MoveResult | null } | null;
  flow: { i: string; x: number; y: number; w: number; h: number; resizing: boolean; live: readonly LayoutItem[] } | null;
  nameOf: (id: string) => string;
}

const WHERE: Record<Exclude<Zone, 'center'>, string> = { left: 'Left of', right: 'Right of', top: 'Above', bottom: 'Below' };

const SwapIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const SplitIcon = ({ zone }: { zone: Exclude<Zone, 'center'> }) => {
  const r = { left: 'M2.5 2.5h5v11h-5z', right: 'M8.5 2.5h5v11h-5z', top: 'M2.5 2.5h11v5h-11z', bottom: 'M2.5 8.5h11v5h-11z' }[zone];
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d={r} fill="currentColor" opacity="0.85" />
    </svg>
  );
};
const NoIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m4.2 11.8 7.6-7.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
);

export function ArrangeOverlay({ mode, grid, items, move, flow, nameOf }: Props) {
  const colW = (grid.width - grid.margin[0] * (grid.cols - 1) - grid.padding[0] * 2) / grid.cols;
  const left = (c: number) => grid.padding[0] + c * (colW + grid.margin[0]);
  const top = (r: number) => grid.padding[1] + r * (grid.rowHeight + grid.margin[1]);
  const rect = (b: { x: number; y: number; w: number; h: number }) => ({
    left: left(b.x),
    top: top(b.y),
    width: left(b.x + b.w) - grid.margin[0] - left(b.x),
    height: top(b.y + b.h) - grid.margin[1] - top(b.y),
  });

  let marks: React.ReactNode = null;

  if ((mode === 'swap' || mode === 'split') && move?.target) {
    const t = items.find((b) => b.i === move.target);
    const r = move.result;
    if (t && r && !r.ok) {
      const tName = nameOf(t.i);
      const why = r.why === 'moved' ? `${move.name} can't take ${tName}'s size` : mode === 'split' && move.zone !== 'center' ? `${tName} has no room to split here` : `${tName} can't take ${move.name}'s size`;
      marks = (
        <div className="arr-target is-refused" style={rect(t)}>
          <span className="arr-badge is-refused"><NoIcon /><span><b>{move.name}</b><small>{why}</small></span></span>
        </div>
      );
    } else if (t && r?.ok) {
      const z = move.zone ?? 'center';
      const bandPct = `${SPLIT_BAND * 100}%`;
      marks = (
        <>
          {mode === 'split' && (
            <div className={`arr-zones is-${z}`} style={{ ...rect(t), ['--band' as string]: bandPct }} aria-hidden="true">
              <i className="arr-zone arr-zone--left" />
              <i className="arr-zone arr-zone--right" />
              <i className="arr-zone arr-zone--top" />
              <i className="arr-zone arr-zone--bottom" />
              <i className="arr-zone arr-zone--center" />
            </div>
          )}
          <div className="arr-land" style={rect(r.plan.box)}>
            <span className="arr-badge">
              {z === 'center' ? <SwapIcon /> : <SplitIcon zone={z} />}
              <span>
                <b>{move.name}</b>
                <small>{z === 'center' ? `Swap with ${nameOf(t.i)}` : `${WHERE[z]} ${nameOf(t.i)}`} · {r.plan.box.w} × {r.plan.box.h}</small>
              </span>
            </span>
          </div>
        </>
      );
    }
  }

  if (mode === 'flow' && flow) {
    const others = flow.live.length ? flow.live : items;
    const { xs, ys } = alignedEdges(others, flow);
    const bottom = Math.max(...others.map((b) => b.y + b.h), flow.y + flow.h);
    const fullH = top(bottom) - grid.margin[1];
    const fullW = left(grid.cols) - grid.margin[0];
    marks = (
      <>
        {xs.map((x) => <i key={`x${x}`} className="arr-guide arr-guide--v" style={{ left: x === 0 ? left(0) : left(x) - grid.margin[0] / 2, top: 0, height: fullH }} />)}
        {ys.map((y) => <i key={`y${y}`} className="arr-guide arr-guide--h" style={{ top: y === 0 ? top(0) : top(y) - grid.margin[1] / 2, left: 0, width: fullW }} />)}
        <div className="arr-land arr-land--flow" style={rect(flow)}>
          <span className={`arr-badge arr-badge--size${flow.resizing ? ' is-resizing' : ''}`}>
            <span><b>{nameOf(flow.i)}</b><small>{flow.w} × {flow.h}</small></span>
          </span>
        </div>
      </>
    );
  }

  return <div className="arr-overlay" aria-hidden="true">{marks}</div>;
}
