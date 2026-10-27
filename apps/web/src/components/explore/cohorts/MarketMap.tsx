/**
 * Every asset the wallets hold, on one map, grouped by sector.
 *
 * Each sector is a block sized by its gross exposure, each asset a tile inside
 * it sized the same way and coloured by the lean (Treemap.tsx). The sector's
 * header names it with its size and lean. Zoom and pan like the cohort map
 * (mapZoom.ts); a header opens the sector, a tile the asset.
 */
import { LEAN_LABEL, SECTORS, leanOf, longShare, type MapSector, type Sector } from '@sign/valuedesk/cohorts/model.js';
import { fmtUsdShort } from '../model';
import { useMapZoom } from './mapZoom';
import { MarketTile, ZoomControls, squarify, visible } from './Treemap';

const SECTOR_LABEL = Object.fromEntries(SECTORS.map((s) => [s.id, s.label])) as Record<Sector, string>;
/** A sector's header strip, in layout pixels (it grows with the zoom, its text does not). */
const HEAD = 20;
const PAD = 2;

export function MarketMap({
  sectors, onSector, onAsset, resetKey, height,
}: {
  sectors: readonly MapSector[];
  onSector: (s: Sector) => void;
  onAsset: (coin: string) => void;
  resetKey: string;
  height: number;
}) {
  const zoom = useMapZoom(resetKey);
  const blocks = squarify(
    sectors.filter((s) => s.long + s.short > 0).map((s) => ({ value: s.long + s.short, item: s })),
    { x: 0, y: 0, ...zoom.size },
  );
  const count = sectors.reduce((n, s) => n + s.assets.length, 0);

  return (
    <div className="coh-map" style={{ height }}>
      <div ref={zoom.ref} className={`coh-tree${zoom.moving ? ' is-moving' : ''}${zoom.zoomed ? ' is-zoomed' : ''}`} {...zoom.handlers}>
        {blocks.map((b) => {
          const s = b.item;
          const inner = { x: b.x + PAD, y: b.y + HEAD, w: Math.max(0, b.w - PAD * 2), h: Math.max(0, b.h - HEAD - PAD) };
          const tiles = squarify(s.assets.map((m) => ({ value: m.long + m.short, item: m })), inner);
          const frame = zoom.toScreen(b);
          if (!visible(frame, zoom.size)) return null;
          const lean = leanOf(longShare(s.long, s.short));
          const bull = !!lean && lean.endsWith('bullish');
          const head = HEAD * zoom.view.z;
          return (
            <div key={s.sector} className="coh-map__sector" style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
              {frame.w > 56 && (
                <button
                  type="button"
                  className="coh-map__head"
                  style={{ height: Math.min(head, 26) }}
                  title={`${SECTOR_LABEL[s.sector]} · long ${fmtUsdShort(s.long)} · short ${fmtUsdShort(s.short)} · uPnL ${fmtUsdShort(s.upnl, true)}`}
                  onClick={() => { if (zoom.isClick()) onSector(s.sector); }}
                >
                  <b>{SECTOR_LABEL[s.sector]}</b>
                  {frame.w > 150 && <span>{fmtUsdShort(s.long + s.short)}</span>}
                  {frame.w > 230 && lean && <i className={bull ? 'pos' : 'neg'}>{LEAN_LABEL[lean]}</i>}
                </button>
              )}
              {tiles.map((t) => {
                const r = zoom.toScreen(t);
                if (!visible(r, zoom.size)) return null;
                return (
                  <MarketTile
                    key={t.item.coin}
                    m={t.item}
                    rect={{ x: r.x - frame.x, y: r.y - frame.y, w: r.w, h: r.h }}
                    active={false}
                    onClick={() => { if (zoom.isClick()) onAsset(t.item.coin); }}
                  />
                );
              })}
            </div>
          );
        })}
        {!blocks.length && <p className="coh-tree__empty">No open positions in this view.</p>}
      </div>
      {blocks.length > 0 && <ZoomControls zoom={zoom} />}
      {blocks.length > 0 && !zoom.zoomed && <span className="coh-tree__hint">{count.toLocaleString('en-US')} assets in {blocks.length} sectors · scroll to zoom</span>}
    </div>
  );
}
