/**
 * One legend row per indicator, TradingView style: the study's name and its
 * values at the bar under the crosshair (or the newest bar), and - under the
 * pointer - the controls that act on it: show/hide, settings, remove, and
 * "more", which opens the study's menu (as does a right-click on the row):
 * the chart owns that menu, so every right-click menu on it is the same one.
 *
 * Rows for studies drawn over the candles stack under the OHLC legend; a study
 * with a pane of its own gets its row at the top-left of that pane, which is
 * where the eye looks for it (studies sharing a pane stack there). Positions are read from klinecharts on every
 * render (getSize is a plain getter), and the parent re-renders on every
 * crosshair move and every live tick, so a row follows its pane through
 * resizes and reorders without a subscription of its own; a pointer release
 * anywhere re-reads them too, which covers a pane separator being dragged.
 */
import { useEffect, useReducer } from 'react';
import type { Chart as KChart, KLineData } from 'klinecharts';
import { CANDLE_PANE_ID } from './theme';
import { BAR_DOWN, BAR_UP, legendName, stylesFor, type IndicatorSpec } from './indicators';
import { compactNumber } from './volumeAxis';
import { fmtNum, localize } from '../numStyle';
import { MENU_ICONS } from '../dashboard/tabExtras';

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
  /** Pane ids in display order. */
  paneOrder: string[];
  onToggle: (id: string) => void;
  onSettings: (id: string) => void;
  onRemove: (id: string) => void;
  /** Open the study's menu at a viewport point. */
  onMenu: (id: string, at: { x: number; y: number }) => void;
}

const grouped = (v: number, decimals: number): string =>
  fmtNum(v, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

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
      f.key === 'volume' ? localize(compactNumber(v, volumeDecimals))
      : live.shouldFormatBigNumber && Math.abs(v) >= 1e3 ? localize(compactNumber(v))
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
  // Literal, not the theme's: a badge's fill is its own colour on either theme.
  return lum > 0.55 ? '#0e0e0e' : '#f7f7f7';
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
  onMenu,
}: IndicatorLegendProps) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);

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

  if (!chart || indicators.length === 0) return null;
  const list = chart.getDataList();
  const index = bar ? indexAt(list, bar.timestamp) : list.length - 1;
  const offTop = holder?.offsetTop ?? 0;
  const offLeft = holder?.offsetLeft ?? 0;
  const panes = [...new Set(paneOrder)].filter((p) => p !== CANDLE_PANE_ID);
  const rowInPane = new Map<string, number>();

  return (
    <div className="kc-ind-legend">
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
        return (
          <div
            key={ind.id}
            className={`kc-ind-row${ind.visible ? '' : ' is-off'}`}
            style={{ top, left: offLeft + 4 }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(ind.id, { x: e.clientX, y: e.clientY });
            }}
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
                className="kc-ind-eye"
                title={ind.visible ? 'Hide' : 'Show'}
                aria-label={ind.visible ? `Hide ${name}` : `Show ${name}`}
                aria-pressed={!ind.visible}
                onClick={() => onToggle(ind.id)}
              >
                {ind.visible ? MENU_ICONS.show : MENU_ICONS.hide}
              </button>
              <button type="button" title="Settings" aria-label={`${name} settings`} onClick={() => onSettings(ind.id)}>
                {MENU_ICONS.settings}
              </button>
              <button type="button" title="Remove" aria-label={`Remove ${name}`} className="kc-ind-rm" onClick={() => onRemove(ind.id)}>
                {MENU_ICONS.close}
              </button>
              <button
                type="button"
                title="More"
                aria-label={`More for ${name}`}
                aria-haspopup="menu"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  onMenu(ind.id, { x: r.left, y: r.bottom + 4 });
                }}
              >
                {MENU_ICONS.more}
              </button>
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
