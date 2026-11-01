/**
 * The drawings picked by a marked area (Ctrl / ⌘ + drag, Chart.tsx), shown as
 * small squares on every anchor - klinecharts itself can show only one
 * selected drawing. The squares follow the chart through pans, zooms and
 * scale drags in the frame the chart draws them (candleDraws.ts), re-rendering
 * this layer alone (never the chart) and only when a square actually moved.
 */
import { useEffect, useState } from 'react';
import type { Chart as KChart } from 'klinecharts';
import { followChart } from './candleDraws';

const PANE = 'candle_pane';

export function SelectionMarks({ chart, ids, left, top }: { chart: KChart | null; ids: readonly string[]; left: number; top: number }) {
  const [pts, setPts] = useState<Array<{ x: number; y: number }>>([]);
  useEffect(() => {
    if (!chart || ids.length === 0) {
      setPts([]);
      return;
    }
    let last = '';
    const read = () => {
      const pane = chart.getSize(PANE);
      const out: Array<{ x: number; y: number }> = [];
      for (const id of ids) {
        const o = chart.getOverlays({ id })[0];
        if (!o || !o.visible) continue;
        const px = chart.convertToPixel(
          o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
          { paneId: PANE },
        ) as Array<{ x?: number; y?: number }>;
        for (const p of px) {
          if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          if (pane && (p.y < 0 || p.y > pane.height || p.x < 0 || p.x > pane.width)) continue;
          out.push({ x: Math.round(p.x), y: Math.round(p.y) });
        }
      }
      const key = out.map((p) => `${p.x},${p.y}`).join(';');
      if (key !== last) {
        last = key;
        setPts(out);
      }
    };
    return followChart(chart, PANE, read);
  }, [chart, ids]);

  if (pts.length === 0) return null;
  return (
    <svg className="kc-multi-marks" style={{ left, top }} aria-hidden>
      {pts.map((p, i) => (
        <rect key={i} x={p.x - 3.5} y={p.y - 3.5} width={7} height={7} rx={1.5} />
      ))}
    </svg>
  );
}
