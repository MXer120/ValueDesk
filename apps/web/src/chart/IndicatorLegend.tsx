/**
 * One legend row per indicator, TradingView style: the study's name and its
 * values at the bar under the crosshair (or the newest bar), and - under the
 * pointer - the controls that act on it: show/hide, settings, remove, and a
 * menu that moves its pane up or down or the study into another pane.
 *
 * Rows for studies drawn over the candles stack under the OHLC legend; a study
 * with a pane of its own gets its row at the top-left of that pane, which is
 * where the eye looks for it (studies sharing a pane stack there). Positions are read from klinecharts on every
 * render (getSize is a plain getter), and the parent re-renders on every
 * crosshair move and every live tick, so a row follows its pane through
 * resizes and reorders without a subscription of its own; a pointer release
 * anywhere re-reads them too, which covers a pane separator being dragged.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { Chart as KChart, KLineData } from 'klinecharts';
import { CANDLE_PANE_ID } from './theme';
import { BAR_DOWN, BAR_UP, legendName, stylesFor, type IndicatorSpec } from './indicators';
import { compactNumber } from './volumeAxis';

export interface LegendIndicator {
  id: string;
  name: string;
  paneId: string;
  visible: boolean;
  /** Set when the study reads an unseen scale of its own in a shared pane. */
  yAxisId?: string;
  spec: IndicatorSpec;
}

export interface IndicatorLegendProps {
  chart: KChart | null;
  indicators: LegendIndicator[];
  /** The bar the values are read at: hovered, else the newest. */
  bar: KLineData | null;
  /** Where the candle pane's rows start, px from the top of the plot box. */
  candleTop: number;
  /** The canvas holder; pane positions are relative to it. */
  holder: HTMLElement | null;
  /** Decimals of the volume step size (BTC: 5). */
  volumeDecimals: number;
  /** Pane ids in display order, so the move menu knows what is first/last. */
  paneOrder: string[];
  onToggle: (id: string) => void;
  onSettings: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  /** Into 'main' (over the candles), 'new' (a pane of its own) or another
   *  study's pane (that study's id). */
  onMoveTo: (id: string, target: string) => void;
}

/* 16px glyphs on a 1:1 grid, -0.5 origin so 1px strokes land on whole pixels
   (the rail's technique - see DrawingRail.tsx). */
const G = {
  viewBox: '-0.5 -0.5 16 16',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
} as const;

const EyeIcon = (
  <svg {...G}>
    <path d="M1 8c1.8-3.2 4.2-4.8 7-4.8s5.2 1.6 7 4.8c-1.8 3.2-4.2 4.8-7 4.8S2.8 11.2 1 8z" />
    <circle cx="8" cy="8" r="2.2" />
  </svg>
);
const EyeOffIcon = (
  <svg {...G}>
    <path d="M3.2 5.3C2.4 6 1.6 6.9 1 8c1.8 3.2 4.2 4.8 7 4.8 1.1 0 2.1-.2 3-.7M6 3.5c.6-.2 1.3-.3 2-.3 2.8 0 5.2 1.6 7 4.8-.5.9-1 1.6-1.6 2.3" />
    <path d="M2 2l12 12" />
  </svg>
);
const GearIcon = (
  <svg {...G}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    <circle cx="8" cy="8" r="4.6" />
  </svg>
);
const CloseIcon = (
  <svg {...G}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </svg>
);
const MoreIcon = (
  <svg {...G}>
    <circle cx="3" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="13" cy="8" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const grouped = (v: number, decimals: number): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** Index of the bar at `ts` in an ascending list, or -1. */
function indexAt(list: KLineData[], ts: number): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = list[mid]!.timestamp;
    if (t === ts) return mid;
    if (t < ts) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

interface Reading {
  key: string;
  text: string;
  color: string;
}

/** The values one indicator shows at one bar, coloured like its figures. */
function readValues(chart: KChart, ind: LegendIndicator, index: number, volumeDecimals: number): Reading[] {
  const live = chart.getIndicators({ id: ind.id })[0];
  if (!live || index < 0) return [];
  const row = (live.result[index] ?? null) as Record<string, unknown> | null;
  const bar = chart.getDataList()[index];
  const lineCount = live.figures.filter((f) => f.type === 'line').length;
  const styles = stylesFor(ind.spec, lineCount);
  const out: Reading[] = [];
  let line = 0;
  for (const f of live.figures) {
    const v = row?.[f.key];
    const isLine = f.type === 'line';
    const lineIdx = isLine ? line++ : -1;
    if (isLine && ind.spec.lines?.[lineIdx]?.hidden) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (f.type === 'line' || f.type === 'bar') out.push({ key: f.key, text: '∅', color: 'var(--dim)' });
      continue;
    }
    let color = 'var(--kc-ink)';
    if (isLine) color = (styles.lines?.[lineIdx]?.color as string | undefined) ?? color;
    else if (f.type === 'bar') {
      const up = ind.spec.up ?? BAR_UP;
      const down = ind.spec.down ?? BAR_DOWN;
      const rising = f.key === 'volume' && bar ? bar.close >= bar.open : v >= 0;
      color = rising ? up : down;
    }
    const text =
      f.key === 'volume' ? compactNumber(v, volumeDecimals)
      : live.shouldFormatBigNumber && Math.abs(v) >= 1e3 ? compactNumber(v)
      : grouped(v, live.precision);
    out.push({ key: f.key, text, color: opaque(color) });
  }
  return out;
}

/** A bar fill at 60% is right on the canvas and too faint as text. */
function opaque(color: string): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)$/.exec(color);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : color;
}

/** Dark or light text for a tag on `bg` (#rrggbb or rgb()), by luminance. */
function inkOn(bg: string): string {
  let r = 0;
  let g = 0;
  let b = 0;
  const hex = /^#([0-9a-f]{6})$/i.exec(bg);
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    r = n >> 16;
    g = (n >> 8) & 255;
    b = n & 255;
  } else if (rgb) {
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  } else return 'var(--text)';
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? 'var(--bg)' : 'var(--text)';
}

interface Tag {
  key: string;
  text: string;
  color: string;
  y: number;
}

/**
 * The newest value of a study in its own pane, as a tag on that pane's scale
 * in the figure's colour - what SoDEX's volume pane shows for the current bar.
 */
function readTags(chart: KChart, ind: LegendIndicator, volumeDecimals: number, offTop: number): Tag[] {
  const list = chart.getDataList();
  const index = list.length - 1;
  const pane = chart.getSize(ind.paneId);
  if (index < 0 || !pane) return [];
  const readings = new Map(readValues(chart, ind, index, volumeDecimals).map((x) => [x.key, x]));
  const live = chart.getIndicators({ id: ind.id })[0];
  const row = (live?.result[index] ?? null) as Record<string, unknown> | null;
  const tags: Tag[] = [];
  for (const f of live?.figures ?? []) {
    const v = row?.[f.key];
    const reading = readings.get(f.key);
    if (typeof v !== 'number' || !Number.isFinite(v) || !reading || reading.text === '∅') continue;
    const at = chart.convertToPixel({ dataIndex: index, value: v }, { paneId: ind.paneId }) as { y?: number };
    if (typeof at.y !== 'number' || at.y < 0 || at.y > pane.height) continue;
    tags.push({ key: f.key, text: reading.text, color: reading.color, y: offTop + pane.top + at.y });
  }
  return tags;
}

/** Nudge overlapping tags on one scale apart, bottom-most first. */
function spread(tags: Tag[]): Tag[] {
  const out = [...tags].sort((a, b) => b.y - a.y);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    if (prev.y - out[i]!.y < 18) out[i]!.y = prev.y - 18;
  }
  return out;
}

export function IndicatorLegend({
  chart,
  indicators,
  bar,
  candleTop,
  holder,
  volumeDecimals,
  paneOrder,
  onToggle,
  onSettings,
  onRemove,
  onMove,
  onMoveTo,
}: IndicatorLegendProps) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // A separator drag resizes panes without re-rendering anything of ours.
  useEffect(() => {
    const up = () => requestAnimationFrame(rerender);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  // klinecharts lays panes out in a microtask after an add, a remove or a
  // reorder, so the positions read in the render that announced the change
  // are the old ones; one frame later they are not.
  useEffect(() => {
    const id = requestAnimationFrame(rerender);
    return () => cancelAnimationFrame(id);
  }, [indicators]);

  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenuFor(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuFor(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menuFor]);

  if (!chart || indicators.length === 0) return null;
  const list = chart.getDataList();
  const index = bar ? indexAt(list, bar.timestamp) : list.length - 1;
  const offTop = holder?.offsetTop ?? 0;
  const offLeft = holder?.offsetLeft ?? 0;
  const panes = [...new Set(paneOrder)].filter((p) => p !== CANDLE_PANE_ID);
  /** Which study names a pane, for "Move to": its first study's name. */
  const paneName = (paneId: string) => {
    const first = indicators.find((i) => i.paneId === paneId);
    return first ? legendName(first.name, chart.getIndicators({ id: first.id })[0]?.calcParams ?? []) : paneId;
  };
  const rowInPane = new Map<string, number>();
  /** A menu item: close the menu, then act. */
  const pick = (run: () => void) => () => {
    setMenuFor(null);
    run();
  };

  return (
    <div className="kc-ind-legend" ref={root}>
      {indicators.map((ind) => {
        const own = ind.paneId !== CANDLE_PANE_ID;
        const n = rowInPane.get(ind.paneId) ?? 0;
        rowInPane.set(ind.paneId, n + 1);
        let top: number;
        if (own) {
          const size = chart.getSize(ind.paneId);
          if (!size) return null;
          top = offTop + size.top + 4 + n * 22;
        } else {
          top = candleTop + n * 22;
        }
        const live = chart.getIndicators({ id: ind.id })[0];
        const name = legendName(ind.name, live?.calcParams ?? ind.spec.calcParams ?? [], ind.spec.source);
        const values = ind.visible ? readValues(chart, ind, index, volumeDecimals) : [];
        const at = panes.indexOf(ind.paneId);
        const shared = indicators.filter((i) => i.paneId === ind.paneId).length > 1;
        const others = panes.filter((p) => p !== ind.paneId);
        return (
          <div
            key={ind.id}
            className={`kc-ind-row${ind.visible ? '' : ' is-off'}${menuFor === ind.id ? ' is-open' : ''}`}
            style={{ top, left: offLeft + 4 }}
          >
            <button type="button" className="kc-ind-name" onClick={() => onSettings(ind.id)} title="Settings">
              {name}
            </button>
            {values.map((v, i) => (
              <span key={i} className="kc-ind-val" style={{ color: v.color }}>
                {v.text}
              </span>
            ))}
            <span className="kc-ind-ctl">
              <button
                type="button"
                title={ind.visible ? 'Hide' : 'Show'}
                aria-label={ind.visible ? `Hide ${name}` : `Show ${name}`}
                aria-pressed={!ind.visible}
                onClick={() => onToggle(ind.id)}
              >
                {ind.visible ? EyeIcon : EyeOffIcon}
              </button>
              <button type="button" title="Settings" aria-label={`${name} settings`} onClick={() => onSettings(ind.id)}>
                {GearIcon}
              </button>
              <button type="button" title="Remove" aria-label={`Remove ${name}`} className="kc-ind-rm" onClick={() => onRemove(ind.id)}>
                {CloseIcon}
              </button>
              <span className="kc-ind-more">
                <button
                  type="button"
                  title="More"
                  aria-label={`More for ${name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === ind.id}
                  onClick={() => setMenuFor((m) => (m === ind.id ? null : ind.id))}
                >
                  {MoreIcon}
                </button>
                {menuFor === ind.id && (
                  <div className="menu-popup kc-ind-menu" role="menu">
                    <div className="kc-menu-list">
                      {own && (
                        <>
                          <button type="button" role="menuitem" disabled={at <= 0} onClick={pick(() => onMove(ind.id, -1))}>
                            Move pane up
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={at < 0 || at >= panes.length - 1}
                            onClick={pick(() => onMove(ind.id, 1))}
                          >
                            Move pane down
                          </button>
                        </>
                      )}
                    </div>
                    <div className="kc-menu-label kc-ind-menu-head">Move to</div>
                    <div className="kc-menu-list">
                      {(!own || shared) && (
                        <button type="button" role="menuitem" onClick={pick(() => onMoveTo(ind.id, 'new'))}>
                          New pane
                        </button>
                      )}
                      {own && (
                        <button type="button" role="menuitem" onClick={pick(() => onMoveTo(ind.id, 'main'))}>
                          Main chart
                        </button>
                      )}
                      {others.map((p) => {
                        const target = indicators.find((i) => i.paneId === p);
                        return target ? (
                          <button key={p} type="button" role="menuitem" onClick={pick(() => onMoveTo(ind.id, target.id))}>
                            Pane with {paneName(p)}
                          </button>
                        ) : null;
                      })}
                    </div>
                    <div className="kc-menu-list kc-ind-menu-foot">
                      <button type="button" role="menuitem" onClick={pick(() => onSettings(ind.id))}>
                        Settings…
                      </button>
                    </div>
                  </div>
                )}
              </span>
            </span>
          </div>
        );
      })}
      {panes.flatMap((paneId) => {
        const axis = chart.getSize(paneId, 'yAxis');
        if (!axis) return [];
        const tags = indicators
          // A study on an unseen scale has no place on the visible one.
          .filter((ind) => ind.visible && ind.paneId === paneId && !ind.yAxisId)
          .flatMap((ind) => readTags(chart, ind, volumeDecimals, offTop).map((t) => ({ ...t, key: `${ind.id}:${t.key}` })));
        return spread(tags).map((t) => (
          <span
            key={t.key}
            className="kc-ind-tag"
            style={{ top: t.y, left: offLeft + axis.left, minWidth: axis.width, background: t.color, color: inkOn(t.color) }}
          >
            {t.text}
          </span>
        ));
      })}
    </div>
  );
}
