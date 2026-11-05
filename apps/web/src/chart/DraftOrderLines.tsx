/**
 * The ticket's unplaced order on the chart (draftOrders.ts): the same line, label and price tag as
 * a placed order (chart/orderOverlays.ts), in the same column, only darker and pulsing. An HTML
 * layer over the canvas, as SelectionMarks, because a pulse there costs the compositor and on the
 * canvas a redraw a frame: the lines follow pans, zooms and scale drags in the frame the chart
 * draws them (candleDraws.ts), re-rendering this layer alone and only when a line moved.
 */
import { useEffect, useState } from 'react';
import type { Chart as KChart } from 'klinecharts';
import { useDraftOrders, type DraftLineKind } from '../draftOrders';
import { fmtPrice } from '../format';
import { followChart } from './candleDraws';
import { labelParts, layoutLabels, orderLineLayerOf, type LabelRow } from './orderOverlays';

const PANE = 'candle_pane';

/**
 * A preview line's words, as the placed order will say them. "Limit · 0.5 BTC" is
 * "Sell limit" and "0.5 BTC". An algo's own name ("DCA 3/5") stays.
 */
export function draftLabelParts(label: string, kind: DraftLineKind, side: 'buy' | 'sell'): { tag: string; amount: string | null } {
  const at = label.lastIndexOf(' · ');
  const word = at < 0 ? label : label.slice(0, at);
  const amount = at < 0 ? null : label.slice(at + 3);
  const who = side === 'buy' ? 'Buy' : 'Sell';
  if (word === 'Limit' && kind === 'limit') return { tag: `${who} limit`, amount };
  if (word === 'Trigger' && kind === 'trigger') return { tag: `${who} stop`, amount };
  return { tag: word, amount };
}

/** Green or red as on the placed order: an exit is on the other side of the order it closes. */
export const draftInkSide = (kind: DraftLineKind, side: 'buy' | 'sell'): 'buy' | 'sell' =>
  kind === 'tp' || kind === 'sl' ? (side === 'buy' ? 'sell' : 'buy') : side;

interface Row {
  key: string;
  y: number;
  labelY: number;
  tag: string;
  amount: string | null;
  ink: 'buy' | 'sell';
  kind: DraftLineKind;
  price: number;
}

export function DraftOrderLines({ chart, engine, symbol, left, top, tickSize }: { chart: KChart | null; engine: string; symbol: string; left: number; top: number; tickSize?: string | undefined }) {
  const draft = useDraftOrders();
  const mine = draft && draft.symbol === symbol && draft.engine === engine ? draft : null;
  const [view, setView] = useState<{ rows: Row[]; width: number; x: number; head: number; amountW: number } | null>(null);
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
      const plot = chart.getSize(PANE, 'main');
      const px = chart.convertToPixel(mine.lines.map((l) => ({ value: l.price })), { paneId: PANE }) as Array<{ y?: number }>;
      const rows: Row[] = [];
      const labels: LabelRow[] = [];
      mine.lines.forEach((l, i) => {
        const y = px[i]?.y;
        if (typeof y !== 'number' || !Number.isFinite(y)) return;
        if (pane && (y < 0 || y > pane.height)) return;
        const words = draftLabelParts(l.label, l.kind, mine.side);
        const key = `preview:${i}`;
        rows.push({ key, y: Math.round(y), labelY: Math.round(y), ...words, ink: draftInkSide(l.kind, mine.side), kind: l.kind, price: l.price });
        labels.push({ key, y, ...labelParts(words) });
      });
      // Laid out with the placed orders' labels when there is a layer: one column, and no label on another.
      const at = layer?.layout(labels) ?? layoutLabels(labels, plot?.width ?? 0);
      for (const r of rows) r.labelY = r.y + (at.dy.get(r.key) ?? 0);
      const width = pane?.width ?? 0;
      const k = `${width}|${at.x}|${at.head}|${at.amount}|${rows.map((r) => `${r.y}:${r.labelY}:${r.tag}:${r.amount}:${r.price}`).join(';')}`;
      if (k !== last) {
        last = k;
        setView({ rows, width, x: at.x, head: at.head, amountW: at.amount });
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
          <div className={`kc-draft__line is-${r.kind}`} style={{ top: r.y }} />
          <span className="kc-draft__tag" style={{ left: view.x, top: r.labelY - 9, width: view.head + view.amountW }}>
            <span className="kc-draft__word" style={{ width: view.head }}>{r.tag}</span>
            {r.amount && <span className="kc-draft__amount" style={{ width: view.amountW }}>{r.amount}</span>}
          </span>
          <span className="kc-draft__price" style={{ top: r.labelY - 9 }}>{fmtPrice(String(r.price), tickSize)}</span>
        </div>
      ))}
    </div>
  );
}
