/**
 * The ticket's unplaced order on the chart (draftOrders.ts): each of its prices
 * a thin dashed line, muted in the side's colour, slowly fading in and out so
 * it never reads as a placed order (those are klinecharts overlays, solid and
 * labelled with a side, chart/orderOverlays.ts). An HTML layer over the canvas,
 * as SelectionMarks: the lines follow pans, zooms and scale drags in the frame
 * the chart draws them (candleDraws.ts), re-rendering this layer alone and only
 * when a line moved.
 */
import { useEffect, useState } from 'react';
import type { Chart as KChart } from 'klinecharts';
import { useDraftOrders } from '../draftOrders';
import { followChart } from './candleDraws';

const PANE = 'candle_pane';

export function DraftOrderLines({ chart, engine, symbol, left, top }: { chart: KChart | null; engine: string; symbol: string; left: number; top: number }) {
  const draft = useDraftOrders();
  const mine = draft && draft.symbol === symbol && draft.engine === engine ? draft : null;
  const [rows, setRows] = useState<Array<{ y: number; label: string; kind: string }>>([]);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!chart || !mine) {
      setRows([]);
      return;
    }
    let last = '';
    const read = () => {
      const pane = chart.getSize(PANE);
      const px = chart.convertToPixel(mine.lines.map((l) => ({ value: l.price })), { paneId: PANE }) as Array<{ y?: number }>;
      const out: Array<{ y: number; label: string; kind: string }> = [];
      mine.lines.forEach((l, i) => {
        const y = px[i]?.y;
        if (typeof y !== 'number' || !Number.isFinite(y)) return;
        if (pane && (y < 0 || y > pane.height)) return;
        out.push({ y: Math.round(y), label: l.label, kind: l.kind });
      });
      const w = pane?.width ?? 0;
      const k = `${w}|${out.map((r) => `${r.y}:${r.label}`).join(';')}`;
      if (k !== last) {
        last = k;
        setRows(out);
        setWidth(w);
      }
    };
    return followChart(chart, PANE, read);
  }, [chart, mine]);

  if (!mine || !rows.length || !width) return null;
  return (
    <div className={`kc-draft is-${mine.side}`} style={{ left, top, width }} aria-hidden>
      {rows.map((r, i) => (
        <div key={i} className={`kc-draft__line is-${r.kind}`} style={{ top: r.y }}>
          <span className="kc-draft__tag">{r.label}</span>
        </div>
      ))}
    </div>
  );
}
