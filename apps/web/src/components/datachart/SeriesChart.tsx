/**
 * A small time-series chart for the data widgets (an indicator's history, the
 * FOMC probabilities over time, ETF flows): TradingView's Lightweight Charts
 * (Apache 2.0; its attribution logo stays on, as its licence asks), themed to
 * the app, sized to its box.
 *
 * Each series is a line or bars; `scale: 'left'` puts one on a second axis (ETF
 * flows: the daily bars on the right, the running total on the left); `mark`
 * picks out one point. Times are ms; a daily or monthly series is drawn by its
 * UTC day.
 */
import { useEffect, useRef } from 'react';
import { ColorType, LineStyle, createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';

export interface ChartSeries {
  key: string;
  kind: 'line' | 'bars';
  color: string;
  points: ReadonlyArray<readonly [number, number]>;
  /** Bars below zero in this colour (flows out). */
  negColor?: string;
  scale?: 'right' | 'left';
  /** How values print on the axis and crosshair. */
  format?: (v: number) => string;
  title?: string;
  /** One point picked out with a dot and a label (a calendar card: the release just out). Time in ms. */
  mark?: { time: number; text?: string; color?: string };
}

const css = (name: string, fallback: string) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

export function SeriesChart({ series, height = 220, daily = true }: { series: ChartSeries[]; height?: number; daily?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const made = useRef(new Map<string, ISeriesApi<'Line'> | ISeriesApi<'Histogram'>>());

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--muted', '#bcbcbc'), fontFamily: css('--font-num', 'system-ui'), fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderVisible: false },
      leftPriceScale: { borderVisible: false, visible: false },
      timeScale: { borderVisible: false, timeVisible: !daily, secondsVisible: false },
      crosshair: { vertLine: { color: 'rgba(255,255,255,0.25)', style: LineStyle.Dashed }, horzLine: { color: 'rgba(255,255,255,0.25)', style: LineStyle.Dashed } },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
      handleScroll: { mouseWheel: false, pressedMouseMove: true },
    });
    chart.current = c;
    const m = made.current;
    return () => { m.clear(); c.remove(); chart.current = null; };
  }, [daily]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const m = made.current;
    const keep = new Set(series.map((s) => s.key));
    for (const [k, s] of m) if (!keep.has(k)) { c.removeSeries(s); m.delete(k); }
    let left = false;
    for (const s of series) {
      const fmt = s.format ? { type: 'custom' as const, formatter: s.format, minMove: 0.01 } : undefined;
      let api = m.get(s.key);
      if (!api) {
        api = s.kind === 'bars'
          ? c.addHistogramSeries({ color: s.color, priceScaleId: s.scale ?? 'right', priceLineVisible: false, lastValueVisible: false, ...(fmt ? { priceFormat: fmt } : {}) })
          : c.addLineSeries({ color: s.color, lineWidth: 2, priceScaleId: s.scale ?? 'right', priceLineVisible: false, lastValueVisible: true, title: s.title ?? '', ...(fmt ? { priceFormat: fmt } : {}) });
        m.set(s.key, api);
      }
      if (s.scale === 'left') left = true;
      const seen = new Set<number>();
      const data = [...s.points]
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ time: Math.floor(t / 1000) as UTCTimestamp, value: v, ...(s.kind === 'bars' && s.negColor && v < 0 ? { color: s.negColor } : {}) }))
        .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)));
      (api as ISeriesApi<'Line'>).setData(data as Array<{ time: Time; value: number }>);
      api.setMarkers(s.mark ? [{ time: Math.floor(s.mark.time / 1000) as UTCTimestamp, position: 'aboveBar', shape: 'circle', color: s.mark.color ?? s.color, text: s.mark.text ?? '' }] : []);
    }
    c.applyOptions({ leftPriceScale: { visible: left, borderVisible: false } });
    c.timeScale().fitContent();
  }, [series]);

  return <div ref={box} className="dc-chart" style={{ height }} />;
}
