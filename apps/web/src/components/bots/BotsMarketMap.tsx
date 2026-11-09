/**
 * Bots > Explore: the market map (owner 2026-11-09: "a market map based off of our score + timeframe, last 1h, 6h, 24h,
 * 7d; show empty data like in the latency chart for higher timeframes because we didn't record"). One tile per market:
 * its area the market's activity in the window (square root, so the majors do not swallow the rest), its colour our
 * score there (what $1M of the best bot - or the picked one - is estimated to do, all-in). Under it, the window's hours:
 * the part the trade recorder holds and the part it did not record, hatched as the latency chart's idle stretches.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotMarket } from '../../bots/data';
import { fmtUsd } from '../../format';
import { fmtBpUsd } from './BotNewPage';

export type MapWindow = '1h' | '6h' | '24h' | '7d';
export const WINDOW_H: Record<MapWindow, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };

interface Tile { m: BotMarket; bp: number | null; x: number; y: number; w: number; h: number }

/** Squarified treemap (Bruls et al.): rows laid along the shorter side, each row kept as square as it can be. */
export function squarify<T>(items: ReadonlyArray<{ v: number; it: T }>, W: number, H: number): Array<{ it: T; x: number; y: number; w: number; h: number }> {
  const total = items.reduce((a, x) => a + x.v, 0);
  if (!(total > 0) || W <= 0 || H <= 0) return [];
  const scale = (W * H) / total;
  const rest = [...items].filter((x) => x.v > 0).sort((a, b) => b.v - a.v).map((x) => ({ a: x.v * scale, it: x.it }));
  const out: Array<{ it: T; x: number; y: number; w: number; h: number }> = [];
  let x = 0, y = 0, w = W, h = H;
  const worst = (row: number[], side: number) => {
    const s = row.reduce((p, q) => p + q, 0);
    const mx = Math.max(...row), mn = Math.min(...row);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    const row: typeof rest = [rest.shift()!];
    while (rest.length && worst([...row.map((r) => r.a), rest[0]!.a], side) <= worst(row.map((r) => r.a), side)) row.push(rest.shift()!);
    const s = row.reduce((p, r) => p + r.a, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (const r of row) { const ch = r.a / cw; out.push({ it: r.it, x, y: cy, w: cw, h: ch }); cy += ch; }
      x += cw; w -= cw;
    } else {
      const ch = s / w;
      let cx = x;
      for (const r of row) { const cw = r.a / ch; out.push({ it: r.it, x: cx, y, w: cw, h: ch }); cx += cw; }
      y += ch; h -= ch;
    }
  }
  return out;
}

/** The tile's colour: green when $1M earns, amber up to the fees, red past them; stronger the further from zero. */
function tone(bp: number | null, feeBps: number): { bg: string; cls: string } {
  if (bp === null) return { bg: 'rgb(var(--ink) / 0.05)', cls: 'is-none' };
  if (bp <= 0) return { bg: `color-mix(in srgb, var(--pos) ${Math.round(28 + Math.min(1, -bp / 2) * 52)}%, rgb(var(--ink) / 0.04))`, cls: 'is-earn' };
  if (bp <= feeBps) return { bg: `color-mix(in srgb, var(--warn) ${Math.round(22 + (bp / feeBps) * 30)}%, rgb(var(--ink) / 0.04))`, cls: 'is-mid' };
  return { bg: `color-mix(in srgb, var(--neg) ${Math.round(30 + Math.min(1, (bp - feeBps) / 2) * 50)}%, rgb(var(--ink) / 0.04))`, cls: 'is-dear' };
}

export function MarketMap({ markets, scoreOf, feeBps, window: win, onOpen, height = 340 }: {
  markets: readonly BotMarket[];
  scoreOf: (m: BotMarket) => number | null;
  feeBps: number;
  window: MapWindow;
  onOpen: (symbol: string) => void;
  height?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tiles: Tile[] = useMemo(() => squarify(markets.map((m) => ({ v: Math.sqrt(Math.max(0, m.volumeUsdH)), it: m })), w, height)
    .map((t) => ({ m: t.it, bp: scoreOf(t.it), x: t.x, y: t.y, w: t.w, h: t.h })), [markets, w, height, scoreOf]);
  const hv = hover ? tiles.find((t) => t.m.symbol === hover) : null;
  return (
    <div className="bots-mm" ref={wrap}>
      <div className="bots-mm__map" style={{ height }} onPointerLeave={() => setHover(null)}>
        {tiles.map((t) => {
          const c = tone(t.bp, feeBps);
          const big = t.w > 74 && t.h > 44, mid = t.w > 38 && t.h > 22;
          return (
            <button
              key={t.m.symbol}
              type="button"
              className={`bots-mm__t ${c.cls}${hover === t.m.symbol ? ' is-hover' : ''}`}
              style={{ left: t.x, top: t.y, width: t.w, height: t.h, background: c.bg }}
              onPointerEnter={() => setHover(t.m.symbol)}
              onFocus={() => setHover(t.m.symbol)}
              onClick={() => onOpen(t.m.symbol)}
              aria-label={`${t.m.base}: ${t.bp === null ? 'no estimate' : `${fmtBpUsd(t.bp)} per $1M`}, ${fmtUsd(t.m.volumeUsdH, 0)} an hour. Open it in the list`}
            >
              {mid && <b>{t.m.base}</b>}
              {big && <span>{t.bp === null ? 'no estimate' : fmtBpUsd(t.bp)}</span>}
            </button>
          );
        })}
      </div>
      <div className="bots-mm__read" aria-live="polite">
        {hv ? (
          <>
            <b>{hv.m.base}</b>
            <span>{hv.bp === null ? 'No estimate' : <><b>{fmtBpUsd(hv.bp)}</b> per $1M</>}</span>
            <span className="dim">{fmtUsd(hv.m.volumeUsdH, 0)}/h traded · uninformed {Math.round(hv.m.takers.t1002 * 100)}% · informed {Math.round(hv.m.takers.t23342 * 100)}% · {Math.round(hv.m.volBpsH)} bp/h moves</span>
          </>
        ) : <span className="dim">Tile size: activity in the window. Colour: what $1M of the bot is estimated to do there. Point at or tap a tile for its figures; a click opens it in the list.</span>}
      </div>
      <div className="bots-mm__key" aria-hidden>
        <span><i className="is-earn" />Earns</span><span><i className="is-mid" />Costs up to the fees</span><span><i className="is-dear" />Costs more than the fees</span><span><i className="is-none" />No estimate</span>
      </div>
    </div>
  );
}

/**
 * The window's hours, recorded and not: the trade recorder's held hours (the most any market holds) against the
 * window, the rest hatched like the latency chart's stretches without orders.
 */
export function Coverage({ window: win, heldH }: { window: MapWindow; heldH: number | null }) {
  const total = WINDOW_H[win];
  if (heldH === null) return null;
  const held = Math.min(total, Math.max(0, heldH));
  const gap = total - held;
  const label = (h: number) => (h >= 48 ? `${Math.round(h / 24)} days` : h >= 1.5 ? `${Math.round(h)} h` : `${Math.round(h * 60)} min`);
  return (
    <div className="bots-cov" role="img" aria-label={gap > 0.05 ? `Recorded ${label(held)} of the last ${label(total)}; ${label(gap)} not recorded` : `The whole ${label(total)} is recorded`}>
      <div className="bots-cov__bar">
        {gap > 0.05 && <span className="bots-cov__gap" style={{ width: `${(gap / total) * 100}%` }}>{gap / total > 0.18 && 'not recorded'}</span>}
        <span className="bots-cov__held" style={{ width: `${(held / total) * 100}%` }} />
      </div>
      <div className="bots-cov__words">
        <span>{label(total)} ago</span>
        <span>{gap > 0.05 ? `Recorded: the last ${label(held)}` : 'Fully recorded'}</span>
        <span>now</span>
      </div>
    </div>
  );
}
