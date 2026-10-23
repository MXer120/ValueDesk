/**
 * The day's moves as a heatmap: the busiest markets as tiles, the area their
 * 24h volume (softened, so BTC does not take half the box), the colour their
 * 24h move. Squarified like the cohort treemap (cohorts/Treemap.tsx). Text
 * appears as a tile grows: the logo, the name and the move, then the price and
 * the volume. A click features the market.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { DASH } from '../../../format';
import { CoinIcon } from '../../CoinIcon';
import { squarify } from '../cohorts/Treemap';
import { fmtPx, fmtUsdShort } from '../model';
import { heatTone, type MarketRow } from './model';

const GAP = 2;
const pct = (v: number | null) => (v === null ? DASH : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`);

function useBoxSize<T extends HTMLElement>(): [RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function Heatmap({ rows, active, onPick, limit = 44 }: {
  rows: readonly MarketRow[];
  active: string | null;
  onPick: (key: string) => void;
  limit?: number;
}) {
  const [ref, size] = useBoxSize<HTMLDivElement>();
  const shown = rows.filter((r) => r.volume > 0).slice(0, limit);
  const tiles = squarify(shown.map((r) => ({ value: Math.pow(r.volume, 0.62), item: r })), { x: 0, y: 0, ...size });
  return (
    <div ref={ref} className="mk-heat" role="list" aria-label="Markets by 24h volume, coloured by the 24h move">
      {tiles.map(({ x, y, w, h, item: r }) => {
        const tier = w >= 120 && h >= 74 ? 3 : w >= 64 && h >= 40 ? 2 : w >= 36 && h >= 22 ? 1 : 0;
        return (
          <button
            key={r.key}
            type="button"
            role="listitem"
            className={`mk-heat__tile is-t${tier}${active === r.key ? ' is-on' : ''}`}
            style={{ left: x + GAP / 2, top: y + GAP / 2, width: Math.max(0, w - GAP), height: Math.max(0, h - GAP), background: heatTone(r.changePct) }}
            title={`${r.name} · ${fmtPx(r.price)} · ${pct(r.changePct)} · ${fmtUsdShort(r.volume)} 24h volume`}
            onClick={() => onPick(r.key)}
          >
            {tier >= 1 && (
              <span className="mk-heat__name">
                {tier >= 2 && <CoinIcon coin={r.name} size={tier >= 3 ? 18 : 14} />}
                {r.name}
              </span>
            )}
            {tier >= 1 && <span className="mk-heat__chg">{pct(r.changePct)}</span>}
            {tier >= 3 && <span className="mk-heat__sub">{fmtPx(r.price)} · {fmtUsdShort(r.volume)}</span>}
          </button>
        );
      })}
    </div>
  );
}
