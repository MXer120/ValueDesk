/**
 * The cohort's markets as a zoomable treemap (and the pieces the market map
 * shares with it).
 *
 * SIZE: a tile's area is the coin's gross exposure - long plus short position
 * value of the wallets read - so the biggest books are the biggest tiles.
 * Squarified (Bruls, Huizing & van Wijk), so tiles stay close to square.
 * COLOUR: the side the wallets lean to on that coin, stronger the further from
 * even (never grey).
 *
 * EVERY COIN is laid out, however small. Scroll (or pinch) zooms around the
 * pointer, drag pans, double-click zooms in (mapZoom.ts). Text appears as a
 * tile grows: the logo alone, then the name, then the uPnL, then the lean. A
 * click (not a drag) opens that coin.
 */
import { LEAN_LABEL, leanOf, longShare, type CohortMarket, type Lean } from '@sign/valuescan/cohorts/model.js';
import { marketName } from '../../../format';
import { CoinIcon } from '../../CoinIcon';
import { fmtUsdShort } from '../model';
import { useMapZoom } from './mapZoom';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Tile<T> extends Rect { item: T }

/** Squarified layout of `items` (value desc) into a box. */
export function squarify<T>(items: ReadonlyArray<{ value: number; item: T }>, box: Rect): Array<Tile<T>> {
  const total = items.reduce((s, x) => s + x.value, 0);
  if (!(total > 0) || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const areas = items.map((x) => ({ a: x.value * scale, item: x.item }));
  const out: Array<Tile<T>> = [];
  let { x, y, w, h } = box;
  let i = 0;
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row: number[] = [areas[i]!.a];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]!.a], side) <= worst(row, side)) {
      row.push(areas[j]!.a);
      j++;
    }
    const s = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (let k = 0; k < row.length; k++) {
        const ch = row[k]! / cw;
        out.push({ x, y: cy, w: cw, h: ch, item: areas[i + k]!.item });
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      const ch = s / w;
      let cx = x;
      for (let k = 0; k < row.length; k++) {
        const cw = row[k]! / ch;
        out.push({ x: cx, y, w: cw, h: ch, item: areas[i + k]!.item });
        cx += cw;
      }
      y += ch;
      h -= ch;
    }
    i = j;
  }
  return out;
}

/** The side a share leans to, stronger the further from even. */
export function tone(share: number | null): string {
  const s = share ?? 0.5;
  const strength = Math.min(1, Math.abs(s - 0.5) * 2);
  const pct = Math.round(14 + strength * 46);
  return `color-mix(in srgb, ${s >= 0.5 ? 'var(--pos)' : 'var(--neg)'} ${pct}%, var(--bg-panel))`;
}

const GAP = 2;

/** One market's tile at a screen rect: what fits of logo, name, uPnL and lean. */
export function MarketTile({
  m, rect, active, onClick,
}: {
  m: CohortMarket;
  rect: Rect;
  active: boolean;
  onClick: () => void;
}) {
  const { x, y, w, h } = rect;
  const share = longShare(m.long, m.short);
  const lean: Lean = leanOf(share) ?? 'slightly-bullish';
  const nameW = marketName(m.coin).length * 6.6 + 26;
  const tier = w >= 96 && h >= 64 ? 3 : w >= 70 && h >= 38 ? 2 : w >= nameW && h >= 18 ? 1 : 0;
  const logoOnly = tier === 0 && Math.min(w, h) >= 14;
  const logoSize = Math.max(10, Math.min(16, Math.min(w, h) - 6));
  return (
    <button
      type="button"
      className={`coh-tree__tile is-t${tier}${logoOnly ? ' is-logo' : ''}${active ? ' is-on' : ''}`}
      style={{ left: x + GAP / 2, top: y + GAP / 2, width: Math.max(0, w - GAP), height: Math.max(0, h - GAP), background: tone(share) }}
      title={`${marketName(m.coin)} · long ${fmtUsdShort(m.long)} · short ${fmtUsdShort(m.short)} · uPnL ${fmtUsdShort(m.upnl, true)} · ${m.holders} wallets`}
      onClick={onClick}
    >
      {logoOnly && <CoinIcon coin={m.coin} size={logoSize} />}
      {tier >= 1 && (
        <span className="coh-tree__name">
          <CoinIcon coin={m.coin} size={tier >= 3 ? 16 : 12} />
          {marketName(m.coin)}
        </span>
      )}
      {tier >= 2 && <span className="coh-tree__upnl">{fmtUsdShort(m.upnl, true)} uPnL</span>}
      {tier >= 3 && <span className="coh-tree__lean">{LEAN_LABEL[lean]}</span>}
    </button>
  );
}

/** Off screen, or below a pixel: not drawn. */
export const visible = (r: Rect, size: { w: number; h: number }) =>
  !(r.x > size.w || r.y > size.h || r.x + r.w < 0 || r.y + r.h < 0 || r.w * r.h < 1);

export function ZoomControls({ zoom }: { zoom: ReturnType<typeof useMapZoom> }) {
  return (
    <div className="coh-tree__ctl" role="group" aria-label="Zoom">
      {/* Towards the bottom-right corner: squarify lays the smallest tiles out there. */}
      <button type="button" aria-label="Zoom in" onClick={() => zoom.zoomAt(1.6, zoom.size.w, zoom.size.h)}>+</button>
      <button type="button" aria-label="Zoom out" disabled={!zoom.zoomed} onClick={() => zoom.zoomAt(1 / 1.6, zoom.size.w, zoom.size.h)}>−</button>
      <button type="button" aria-label="Show the whole map" disabled={!zoom.zoomed} onClick={zoom.reset}>
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1.5 4.5v-3h3M10.5 4.5v-3h-3M1.5 7.5v3h3M10.5 7.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

export function Treemap({
  markets, onPick, active, resetKey,
}: {
  markets: readonly CohortMarket[];
  onPick: (coin: string) => void;
  active?: string | null;
  /** A new cohort or filter: back to the whole map (a data refresh keeps the zoom). */
  resetKey: string;
}) {
  const zoom = useMapZoom(resetKey);
  const shown = markets.filter((m) => m.long + m.short > 0);
  const tiles = squarify(shown.map((m) => ({ value: m.long + m.short, item: m })), { x: 0, y: 0, ...zoom.size });

  return (
    <div className="coh-tree-wrap">
      <div ref={zoom.ref} className={`coh-tree${zoom.moving ? ' is-moving' : ''}${zoom.zoomed ? ' is-zoomed' : ''}`} {...zoom.handlers}>
        {tiles.map((t) => {
          const r = zoom.toScreen(t);
          if (!visible(r, zoom.size)) return null;
          return <MarketTile key={t.item.coin} m={t.item} rect={r} active={active === t.item.coin} onClick={() => { if (zoom.isClick()) onPick(t.item.coin); }} />;
        })}
        {!tiles.length && <p className="coh-tree__empty">No open positions in this view.</p>}
      </div>
      {tiles.length > 0 && <ZoomControls zoom={zoom} />}
      {tiles.length > 0 && !zoom.zoomed && <span className="coh-tree__hint">{tiles.length.toLocaleString('en-US')} assets · scroll to zoom</span>}
    </div>
  );
}
