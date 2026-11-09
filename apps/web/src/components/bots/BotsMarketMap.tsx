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
import { FxSelect } from '../funds/ui';
import { Segmented } from './kit/kit';

export type MapWindow = '1h' | '6h' | '24h' | '7d';
export const WINDOW_H: Record<MapWindow, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };


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

/** What sizes a tile, what colours it and in which order the tiles are laid (owner 2026-11-10: "settings to sort by
 * different things - score, activity"; "zoom in into smaller markets"; "all markets displayed in every timeframe"). */
export type MapSize = 'activity' | 'equal';
export type MapColour = 'score' | 'uninformed' | 'informed' | 'volatility';
export type MapOrder = 'size' | 'score' | 'activity' | 'uninformed' | 'volatility' | 'name';
const ORDER_WORDS: Record<MapOrder, string> = { size: 'Largest first', score: 'Best score first', activity: 'Most active first', uninformed: 'Most uninformed first', volatility: 'Calmest first', name: 'A to Z' };
const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8] as const;
const PREF_KEY = 'vs.bots.map';

interface Item { m: BotMarket | null; symbol: string; base: string; bp: number | null }
interface Cell extends Item { x: number; y: number; w: number; h: number }

/** An equal grid: as many columns as keep the cells near square. */
function grid<T>(items: readonly T[], W: number, H: number): Array<{ it: T; x: number; y: number; w: number; h: number }> {
  const n = items.length;
  if (!n) return [];
  const cols = Math.max(1, Math.round(Math.sqrt((n * W) / H)));
  const rows = Math.ceil(n / cols);
  const cw = W / cols, ch = H / rows;
  return items.map((it, i) => ({ it, x: (i % cols) * cw, y: Math.floor(i / cols) * ch, w: cw, h: ch }));
}

/** Squarified rows over items kept in the given order (for an order other than size: aspect ratios are a bit worse). */
function rowsInOrder<T>(items: ReadonlyArray<{ v: number; it: T }>, W: number, H: number): Array<{ it: T; x: number; y: number; w: number; h: number }> {
  const total = items.reduce((a, x) => a + x.v, 0);
  if (!(total > 0)) return [];
  const scale = (W * H) / total;
  const rest = items.map((x) => ({ a: x.v * scale, it: x.it }));
  const out: Array<{ it: T; x: number; y: number; w: number; h: number }> = [];
  let x = 0, y = 0, w = W, h = H;
  const worst = (row: number[], side: number) => {
    const s = row.reduce((p, q) => p + q, 0);
    return Math.max((side * side * Math.max(...row)) / (s * s), (s * s) / (side * side * Math.min(...row)));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    const row = [rest.shift()!];
    while (rest.length && worst([...row.map((r) => r.a), rest[0]!.a], side) <= worst(row.map((r) => r.a), side)) row.push(rest.shift()!);
    const s = row.reduce((p, r) => p + r.a, 0);
    if (w >= h) { const cw = s / h; let cy = y; for (const r of row) { const c = r.a / cw; out.push({ it: r.it, x, y: cy, w: cw, h: c }); cy += c; } x += cw; w -= cw; }
    else { const ch = s / w; let cx = x; for (const r of row) { const c = r.a / ch; out.push({ it: r.it, x: cx, y, w: c, h: ch }); cx += c; } y += ch; h -= ch; }
  }
  return out;
}

const mix = (token: string, pct: number) => `color-mix(in srgb, ${token} ${Math.round(pct)}%, rgb(var(--ink) / 0.04))`;

/** A tile's colour and the figure it shows, for the colour picked. */
function look(it: Item, colour: MapColour, feeBps: number, maxVol: number): { bg: string; cls: string; figure: string } {
  const m = it.m;
  if (!m) return { bg: 'rgb(var(--ink) / 0.035)', cls: 'is-empty', figure: 'no trades' };
  if (colour === 'score') { const t = tone(it.bp, feeBps); return { ...t, figure: it.bp === null ? 'no estimate' : fmtBpUsd(it.bp) }; }
  if (colour === 'uninformed') return { bg: mix('var(--pos)', 8 + m.takers.t1002 * 72), cls: 'is-u', figure: `${Math.round(m.takers.t1002 * 100)}%` };
  if (colour === 'informed') return { bg: mix('var(--neg)', 8 + m.takers.t23342 * 72), cls: 'is-f', figure: `${Math.round(m.takers.t23342 * 100)}%` };
  const r = maxVol > 0 ? Math.log1p(m.volBpsH) / Math.log1p(maxVol) : 0;
  return { bg: mix('var(--warn)', 8 + r * 62), cls: 'is-v', figure: `${Math.round(m.volBpsH)} bp/h` };
}

function readPrefs(): { size: MapSize; colour: MapColour; order: MapOrder } {
  const d = { size: 'activity' as MapSize, colour: 'score' as MapColour, order: 'size' as MapOrder };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as object) }; } catch { return d; }
}

export function MarketMap({ markets, absent = [], scoreOf, feeBps, window: win, onOpen, height = 360 }: {
  /** The window's markets (their figures in that window). */
  markets: readonly BotMarket[];
  /** Markets with no trades in the window (from the 7 d list): shown as empty tiles, so every window shows every market. */
  absent?: ReadonlyArray<{ symbol: string; base: string }>;
  scoreOf: (m: BotMarket) => number | null;
  feeBps: number;
  window: MapWindow;
  onOpen: (symbol: string) => void;
  height?: number;
}) {
  const vp = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<string | null>(null);
  const [prefs, setPrefs] = useState(readPrefs);
  const [zi, setZi] = useState(0);
  const drag = useRef<{ x: number; y: number; l: number; t: number; moved: boolean } | null>(null);
  const suppress = useRef(false);
  const z = ZOOMS[zi]!;
  const set = (p: Partial<typeof prefs>) => setPrefs((x) => { const n = { ...x, ...p }; try { localStorage.setItem(PREF_KEY, JSON.stringify(n)); } catch { /* private mode */ } return n; });
  useEffect(() => {
    const el = vp.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Zoom about a point of the view (the pointer, or the centre for the buttons), keeping that point under it.
  const zoomTo = (next: number, cx?: number, cy?: number) => {
    const el = vp.current;
    const k = Math.min(ZOOMS.length - 1, Math.max(0, next));
    if (!el || k === zi) return;
    const px = cx ?? el.clientWidth / 2, py = cy ?? el.clientHeight / 2;
    const fx = (el.scrollLeft + px) / z, fy = (el.scrollTop + py) / z;
    const nz = ZOOMS[k]!;
    setZi(k);
    requestAnimationFrame(() => { el.scrollLeft = fx * nz - px; el.scrollTop = fy * nz - py; });
  };
  // Ctrl / ⌘ + wheel (and a trackpad pinch, which browsers send as one) zooms; a plain wheel scrolls the page.
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomTo(zi + (e.deltaY < 0 ? 1 : -1), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  const maxVol = Math.max(0, ...markets.map((m) => m.volBpsH));
  const cells: Cell[] = useMemo(() => {
    const items: Item[] = [
      ...markets.map((m) => ({ m, symbol: m.symbol, base: m.base, bp: scoreOf(m) })),
      ...absent.map((a) => ({ m: null, symbol: a.symbol, base: a.base, bp: null })),
    ];
    const act = (it: Item) => (it.m ? Math.sqrt(Math.max(0, it.m.volumeUsdH)) : 0);
    const key: Record<MapOrder, (it: Item) => number | string> = {
      size: (it) => -act(it),
      score: (it) => it.bp ?? Infinity,
      activity: (it) => -(it.m?.volumeUsdH ?? -1),
      uninformed: (it) => -(it.m?.takers.t1002 ?? -1),
      volatility: (it) => it.m?.volBpsH ?? Infinity,
      name: (it) => it.base,
    };
    const k = key[prefs.order];
    items.sort((a, b) => { const x = k(a), y = k(b); return typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number); });
    const W = w * z, H = height * z;
    if (prefs.size === 'equal') return grid(items, W, H).map((c) => ({ ...c.it, x: c.x, y: c.y, w: c.w, h: c.h }));
    // Every market keeps a floor of the area (0.35 %), so a quiet or empty one is still a tile to point at and zoom to.
    const total = items.reduce((a, it) => a + act(it), 0) || 1;
    const vals = items.map((it) => ({ v: Math.max(act(it), total * 0.0035), it }));
    const laid = prefs.order === 'size' ? squarify(vals, W, H) : rowsInOrder(vals, W, H);
    return laid.map((c) => ({ ...c.it, x: c.x, y: c.y, w: c.w, h: c.h }));
  }, [markets, absent, scoreOf, prefs, w, height, z]);
  const hv = hover ? cells.find((c) => c.symbol === hover) : null;
  const winWords = { '1h': 'the last hour', '6h': 'the last 6 hours', '24h': 'the last 24 hours', '7d': 'the last 7 days' }[win];
  const KEY: Record<MapColour, Array<[string, string]>> = {
    score: [['is-earn', 'Earns'], ['is-mid', 'Costs up to the fees'], ['is-dear', 'Costs more than the fees'], ['is-none', 'No estimate'], ['is-empty', 'No trades']],
    uninformed: [['is-u-lo', 'Little uninformed flow'], ['is-u', 'Much'], ['is-empty', 'No trades']],
    informed: [['is-f-lo', 'Little informed flow'], ['is-f', 'Much'], ['is-empty', 'No trades']],
    volatility: [['is-v-lo', 'Calm'], ['is-v', 'Volatile'], ['is-empty', 'No trades']],
  };
  return (
    <div className="bots-mm">
      <div className="bots-mm__bar">
        <div className="bots-mm__set"><span>Size</span><Segmented value={prefs.size} label="Tile size" onChange={(v) => set({ size: v })} options={[{ value: 'activity', label: 'Activity' }, { value: 'equal', label: 'Equal' }]} /></div>
        <div className="bots-mm__set"><span>Colour</span><Segmented value={prefs.colour} label="Tile colour" onChange={(v) => set({ colour: v })} options={[{ value: 'score', label: 'Score' }, { value: 'uninformed', label: 'Uninformed' }, { value: 'informed', label: 'Informed' }, { value: 'volatility', label: 'Volatility' }]} /></div>
        <div className="bots-mm__set"><span>Order</span><FxSelect value={prefs.order} options={(Object.keys(ORDER_WORDS) as MapOrder[]).map((k) => ({ value: k, label: ORDER_WORDS[k] }))} onChange={(v) => set({ order: v as MapOrder })} label="Tile order" triggerClassName="bots-rg__pick" listMinWidth={200} /></div>
        <span className="bots-mm__sp" />
        <div className="bots-mm__zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomTo(zi - 1)} disabled={zi === 0} aria-label="Zoom out">−</button>
          <span>{z === 1 ? 'Fit' : `${z}×`}</span>
          <button type="button" onClick={() => zoomTo(zi + 1)} disabled={zi === ZOOMS.length - 1} aria-label="Zoom in">+</button>
          {zi > 0 && <button type="button" className="is-reset" onClick={() => { setZi(0); if (vp.current) { vp.current.scrollLeft = 0; vp.current.scrollTop = 0; } }}>Reset</button>}
        </div>
      </div>
      <div
        className={`bots-mm__vp${zi > 0 ? ' is-zoomed' : ''}${drag.current?.moved ? ' is-dragging' : ''}`}
        ref={vp}
        style={{ height }}
        onPointerLeave={() => setHover(null)}
        // Zoomed in, a mouse drag moves the view (touch scrolls natively); a drag never opens the tile it ends on.
        onPointerDown={(e) => { if (zi > 0 && e.pointerType === 'mouse' && e.button === 0) drag.current = { x: e.clientX, y: e.clientY, l: vp.current!.scrollLeft, t: vp.current!.scrollTop, moved: false }; }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !vp.current) return;
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
          if (d.moved) { vp.current.scrollLeft = d.l - (e.clientX - d.x); vp.current.scrollTop = d.t - (e.clientY - d.y); }
        }}
        onPointerUp={() => { const d = drag.current; drag.current = null; if (d?.moved) { suppress.current = true; requestAnimationFrame(() => { suppress.current = false; }); } }}
        onClickCapture={(e) => { if (suppress.current) { e.stopPropagation(); e.preventDefault(); } }}
      >
        <div className="bots-mm__map" style={{ width: w * z, height: height * z }}>
          {cells.map((c) => {
            const lk = look(c, prefs.colour, feeBps, maxVol);
            const big = c.w > 58 && c.h > 36, mid = c.w > 34 && c.h > 20;
            return (
              <button
                key={c.symbol}
                type="button"
                className={`bots-mm__t ${lk.cls}${hover === c.symbol ? ' is-hover' : ''}`}
                style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: lk.bg }}
                onPointerEnter={() => setHover(c.symbol)}
                onFocus={() => setHover(c.symbol)}
                onClick={() => (c.m ? onOpen(c.symbol) : undefined)}
                aria-label={`${c.base}: ${c.m ? `${lk.figure}, ${fmtUsd(c.m.volumeUsdH, 0)} an hour. Open it in the list` : `no trades in ${winWords}`}`}
              >
                {mid && <b>{c.base}</b>}
                {big && <span>{lk.figure}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="bots-mm__read" aria-live="polite">
        {hv ? (
          hv.m ? (
            <>
              <b>{hv.base}</b>
              <span>{hv.bp === null ? 'No estimate' : <><b>{fmtBpUsd(hv.bp)}</b> per $1M</>}</span>
              <span className="dim">{fmtUsd(hv.m.volumeUsdH, 0)}/h traded · uninformed {Math.round(hv.m.takers.t1002 * 100)}% · informed {Math.round(hv.m.takers.t23342 * 100)}% · volatility {Math.round(hv.m.volBpsH)} bp/h</span>
            </>
          ) : <><b>{hv.base}</b><span className="dim">No trades in {winWords}</span></>
        ) : <span className="dim">{prefs.size === 'activity' ? 'Size: activity in the window.' : 'Every tile the same size.'} Point at or tap a tile for its figures; a click opens it in the list. Zoom with the buttons or Ctrl + wheel / pinch, then drag or scroll to move.</span>}
      </div>
      <div className="bots-mm__key" aria-hidden>
        {KEY[prefs.colour].map(([cls, words]) => <span key={cls}><i className={cls} />{words}</span>)}
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
