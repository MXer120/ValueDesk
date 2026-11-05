/**
 * The ticket's unplaced order on the chart (draftOrders.ts): the same line, boxes and price tag as
 * a placed order (chart/orderOverlays.ts), only darker and pulsing. An HTML layer over the canvas,
 * as SelectionMarks, because a pulse there costs the compositor and on the canvas a redraw a frame:
 * the lines follow pans, zooms and scale drags in the frame the chart draws them (candleDraws.ts),
 * re-rendering this layer alone and only when a line moved.
 */
import { useEffect, useState } from 'react';
import type { Chart as KChart } from 'klinecharts';
import { useDraftOrders, type DraftLineKind } from '../draftOrders';
import { fmtPrice } from '../format';
import { followChart } from './candleDraws';
import { LABEL_WORDS_X, layoutLabels, orderLineLayerOf, type LabelRow } from './orderOverlays';

const PANE = 'candle_pane';

/** A preview line's words, as the placed order will say them: "Limit · 0.5 BTC" is "Limit" and "0.5 BTC". */
export function draftLabelParts(label: string): { tag: string; amount: string | null } {
  const at = label.lastIndexOf(' · ');
  const word = at < 0 ? label : label.slice(0, at);
  return { tag: word === 'Trigger' ? 'Stop' : word, amount: at < 0 ? null : label.slice(at + 3) };
}

/** Green or red as on the placed order: a TP is green and an SL red, the rest by side. */
export const draftInkSide = (kind: DraftLineKind, side: 'buy' | 'sell'): 'buy' | 'sell' =>
  kind === 'tp' ? 'buy' : kind === 'sl' ? 'sell' : side;

interface Row {
  key: string;
  y: number;
  labelY: number;
  tag: string;
  amount: string | null;
  ink: 'buy' | 'sell';
  price: number;
}

export function DraftOrderLines({ chart, engine, symbol, left, top, tickSize }: { chart: KChart | null; engine: string; symbol: string; left: number; top: number; tickSize?: string | undefined }) {
  const draft = useDraftOrders();
  const mine = draft && draft.symbol === symbol && draft.engine === engine ? draft : null;
  const [view, setView] = useState<{ rows: Row[]; width: number } | null>(null);
  useEffect(() => {
    const layer = chart ? orderLineLayerOf(chart) : undefined;
    if (!chart || !mine) {
      layer?.layout([]);
      setView(null);
      return;
    }
    let last = '';
    const read = () => {
      const pane = chart.getSize(PANE);
      const px = chart.convertToPixel(mine.lines.map((l) => ({ value: l.price })), { paneId: PANE }) as Array<{ y?: number }>;
      const rows: Row[] = [];
      const labels: LabelRow[] = [];
      mine.lines.forEach((l, i) => {
        const y = px[i]?.y;
        if (typeof y !== 'number' || !Number.isFinite(y)) return;
        if (pane && (y < 0 || y > pane.height)) return;
        const key = `preview:${i}`;
        rows.push({ key, y: Math.round(y), labelY: Math.round(y), ...draftLabelParts(l.label), ink: draftInkSide(l.kind, mine.side), price: l.price });
        labels.push({ key, y });
      });
      // Laid out with the placed orders' labels when there is a layer: no label on another.
      const dy = layer?.layout(labels) ?? layoutLabels(labels);
      for (const r of rows) r.labelY = r.y + (dy.get(r.key) ?? 0);
      const width = pane?.width ?? 0;
      const k = `${width}|${rows.map((r) => `${r.y}:${r.labelY}:${r.tag}:${r.amount}:${r.price}:${r.ink}`).join(';')}`;
      if (k !== last) {
        last = k;
        setView({ rows, width });
      }
    };
    const stop = followChart(chart, PANE, read);
    return () => {
      stop();
      layer?.layout([]);
    };
  }, [chart, mine]);

  if (!mine || !view || !view.rows.length || !view.width) return null;
  return (
    <div className="kc-draft" style={{ left, top, width: view.width }} aria-hidden>
      {view.rows.map((r) => (
        <div key={r.key} className={`kc-draft__row is-${r.ink}`}>
          <div className="kc-draft__line" style={{ top: r.y }} />
          <span className="kc-draft__tag" style={{ left: LABEL_WORDS_X, top: r.labelY - 9 }}>
            <span className="kc-draft__word">{r.tag}</span>
            {r.amount && <span className="kc-draft__amount">{r.amount}</span>}
          </span>
          <span className="kc-draft__price" style={{ top: r.labelY - 9 }}>{fmtPrice(String(r.price), tickSize)}</span>
        </div>
      ))}
    </div>
  );
}
