/**
 * What a move would do, drawn over the page while a panel is held (Dashboard.tsx; arrange.ts for the geometry). The
 * page itself does not move until the release (owner 2026-11-26: "when dragging, nothing should happen until released,
 * only preview appears"): every panel the move changes is drawn as a frame at its new place and size - a blueprint
 * over the page - the moved one solid, with where it goes ("Left of Chart") and its size. A move that cannot happen
 * says why, on the panel it was aimed at.
 *
 * In the grid's own pixel geometry, the same as SeamLayer.tsx. Draws only.
 */
import type { LayoutItem } from 'react-grid-layout';
import type { MoveResult, Zone } from '../arrange';

interface Grid {
  cols: number;
  width: number;
  rowHeight: number;
  margin: readonly [number, number];
  padding: readonly [number, number];
}

interface Props {
  grid: Grid;
  /** The layout as it is (a move's target is picked on it). */
  items: readonly LayoutItem[];
  move: { id: string; name: string; target: string | null; zone: Zone | null; result: MoveResult | null } | null;
  nameOf: (id: string) => string;
}

const WHERE: Record<Exclude<Zone, 'center'>, string> = { left: 'Left of', right: 'Right of', top: 'Above', bottom: 'Below' };

const SwapIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const SideIcon = ({ zone }: { zone: Exclude<Zone, 'center'> }) => {
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

export function ArrangeOverlay({ grid, items, move, nameOf }: Props) {
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
  const t = move?.target ? items.find((b) => b.i === move.target) : undefined;
  const r = move?.result;
  if (move && t && r && !r.ok) {
    const tName = nameOf(t.i);
    const why = r.why === 'moved'
      ? `${move.name} can't take ${tName}'s size`
      : move.zone && move.zone !== 'center' ? `${tName} has no room to split here` : `${tName} can't take ${move.name}'s size`;
    marks = (
      <div className="arr-refused" style={rect(t)}>
        <span className="arr-badge is-refused"><NoIcon /><span><b>{move.name}</b><small>{why}</small></span></span>
      </div>
    );
  } else if (move && t && r?.ok) {
    const was = new Map(items.map((b) => [b.i, b]));
    const changed = r.plan.placements.filter((p) => {
      const b = was.get(p.i);
      return p.i === move.id || !b || b.x !== p.x || b.y !== p.y || b.w !== p.w || b.h !== p.h;
    });
    const z = move.zone ?? 'center';
    marks = changed.map((p) => {
      const moved = p.i === move.id;
      return (
        <div key={p.i} className={`arr-frame${moved ? ' is-moved' : ''}`} style={rect(p)}>
          {moved ? (
            <span className="arr-badge">
              {z === 'center' ? <SwapIcon /> : <SideIcon zone={z} />}
              <span>
                <b>{move.name}</b>
                <small>{z === 'center' ? `Swap with ${nameOf(t.i)}` : `${WHERE[z]} ${nameOf(t.i)}`} · {p.w} × {p.h}</small>
              </span>
            </span>
          ) : (
            <span className="arr-frame__t"><b>{nameOf(p.i)}</b><small>{p.w} × {p.h}</small></span>
          )}
        </div>
      );
    });
  }

  return <div className="arr-overlay" aria-hidden="true">{marks}</div>;
}
