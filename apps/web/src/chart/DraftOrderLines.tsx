/**
 * The ticket's unplaced order on the chart (draftOrders.ts): the same label and
 * price tag as a placed order (chart/orderOverlays.ts), but hollow, at the left
 * of the plot and on a line slowly fading in and out, so it never reads as one
 * and never sits on top of one. An HTML layer over the canvas, as SelectionMarks:
 * the lines follow pans, zooms and scale drags in the frame the chart draws them
 * (candleDraws.ts), re-rendering this layer alone and only when a line moved.
 */
import { useEffect, useState } from 'react';
import type { Chart as KChart } from 'klinecharts';
import { useDraftOrders } from '../draftOrders';
import { fmtPrice } from '../format';
import { followChart } from './candleDraws';

const PANE = 'candle_pane';

/** "Limit · 0.5 BTC" -> the word and the size, as a placed order's label has them. */
export function draftLabelParts(label: string): { tag: string; amount: string | null } {
  const at = label.lastIndexOf(' · ');
  return at < 0 ? { tag: label, amount: null } : { tag: label.slice(0, at), amount: label.slice(at + 3) };
}

export function DraftOrderLines({ chart, engine, symbol, left, top, tickSize }: { chart: KChart | null; engine: string; symbol: string; left: number; top: number; tickSize?: string | undefined }) {
  const draft = useDraftOrders();
  const mine = draft && draft.symbol === symbol && draft.engine === engine ? draft : null;
  const [rows, setRows] = useState<Array<{ y: number; label: string; kind: string; price: number }>>([]);
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
      const out: Array<{ y: number; label: string; kind: string; price: number }> = [];
      mine.lines.forEach((l, i) => {
        const y = px[i]?.y;
        if (typeof y !== 'number' || !Number.isFinite(y)) return;
        if (pane && (y < 0 || y > pane.height)) return;
        out.push({ y: Math.round(y), label: l.label, kind: l.kind, price: l.price });
      });
      const w = pane?.width ?? 0;
      const k = `${w}|${out.map((r) => `${r.y}:${r.label}:${r.price}`).join(';')}`;
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
      {rows.map((r, i) => {
        const { tag, amount } = draftLabelParts(r.label);
        return (
          <div key={i} className={`kc-draft__line is-${r.kind}`} style={{ top: r.y }}>
            <span className="kc-draft__tag">
              <span>{tag}</span>
              {amount && <span className="kc-draft__amount">{amount}</span>}
            </span>
            <span className="kc-draft__price">{fmtPrice(String(r.price), tickSize)}</span>
          </div>
        );
      })}
    </div>
  );
}
