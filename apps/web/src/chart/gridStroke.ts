/**
 * The plot's grid, stroked with klinecharts' own line calls (GridView ->
 * drawLine: a 1px line offset half a pixel so it covers one whole row or
 * column), rows first - for the chart's own layers that stand in for the
 * library's canvas: the candle morph (CandleMorph.tsx) and the history reveal
 * (historyReveal.ts). Identical calls on an identical pixel grid are what make
 * a hand-over invisible.
 */
import { chartStyles } from './theme';

/** The grid exactly as klinecharts' GridView strokes it (theme.ts `grid`). */
export const GRID = {
  h: { ...{ size: 1, color: '#272621', style: 'solid', dashedValue: [2, 2] }, ...chartStyles.grid?.horizontal },
  v: { ...{ size: 1, color: '#272621', style: 'solid', dashedValue: [2, 2] }, ...chartStyles.grid?.vertical },
};

export function drawGrid(ctx: CanvasRenderingContext2D, lines: { xs: readonly number[]; ys: readonly number[] }, width: number, height: number): void {
  const stroke = (s: typeof GRID.h, vertical: boolean, coords: readonly number[]) => {
    ctx.lineWidth = s.size;
    ctx.strokeStyle = s.color;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.setLineDash(s.style === 'dashed' ? s.dashedValue : []);
    const k = s.size % 2 === 1 ? 0.5 : 0;
    for (const c of coords) {
      ctx.beginPath();
      if (vertical) {
        ctx.moveTo(c + k, 0);
        ctx.lineTo(c + k, height);
      } else {
        ctx.moveTo(0, c + k);
        ctx.lineTo(width, c + k);
      }
      ctx.stroke();
      ctx.closePath();
    }
  };
  const g = chartStyles.grid;
  if (g?.show === false) return;
  if (g?.horizontal?.show !== false) stroke(GRID.h, false, lines.ys);
  if (g?.vertical?.show !== false) stroke(GRID.v, true, lines.xs);
}
