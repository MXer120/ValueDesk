/**
 * The candles "Who traded" picks from (owner 2026-11-02: "the breakdown must be for the specific
 * candle the user picks ... exactly that candle's open-close window, any timeframe"). The chart
 * itself is parked while the view is open, so the view carries its own row of the chart's candles:
 * hover one to read its window and prices, click it to break that candle down. The picked candle is
 * a lit column; the one still forming says so.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Engine } from '../../api';
import { fetchKlineRows } from '../../chart/klines';
import { normalizeBars } from '../../chart/tv/datafeedCore';
import { fmtPx } from '../explore/model';
import { candleAt, windowText, type CandleWindow } from './flowWindow';

/** Candles shown. */
const N = 60;

interface Bar { time: number; open: number; high: number; low: number; close: number }

export function CandleStrip({ engine, symbol, interval, picked, onPick, nav }: {
  engine: Engine;
  symbol: string;
  interval: string;
  picked: CandleWindow;
  onPick: (w: CandleWindow) => void;
  /** The step buttons (previous, next, live), at the row's end. */
  nav?: ReactNode;
}) {
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // The row ends a third of the way past the picked candle (or now), so the pick sits right of centre.
  const now = Date.now();
  const span = Math.max(60_000, picked.to - picked.from);
  const endTime = Math.min(now, picked.to + Math.floor(N / 3) * span);
  const endKey = candleAt(interval, endTime).from;
  useEffect(() => {
    const ac = new AbortController();
    setBars(null);
    setHover(null);
    fetchKlineRows({ engine, symbol, interval, limit: N, endTime: endKey + span - 1 }, { signal: ac.signal, timeoutMs: 15_000 })
      .then((rows) => setBars(normalizeBars(rows) as Bar[]))
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setBars([]); });
    return () => ac.abort();
  }, [engine, symbol, interval, endKey, span]);

  const scale = useMemo(() => {
    if (!bars?.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bars) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); }
    return { lo, hi: hi > lo ? hi : lo + 1 };
  }, [bars]);

  const W = 600;
  const H = 64;
  const slot = W / N;
  const y = (v: number) => (scale ? 4 + ((scale.hi - v) / (scale.hi - scale.lo)) * (H - 8) : 0);
  const shown = hover !== null && bars?.[hover] ? bars[hover] : bars?.find((b) => b.time === picked.from) ?? null;
  const shownWin = shown ? candleAt(interval, shown.time) : picked;
  const change = shown ? shown.close / shown.open - 1 : null;
  const offset = bars ? N - bars.length : 0;

  return (
    <div className="tfl-strip">
      <div className="tfl-strip__info">
        <span className="tfl-strip__when" aria-live="polite">
          <span className={`tfl-pill ${hover !== null ? 'is-hover' : 'is-pick'}`}>{hover !== null ? 'Hover' : 'Candle'}</span>
          <b>{windowText(shownWin)}</b>
          {shownWin.to > now && <span className="tfl-pill is-live">Forming</span>}
        </span>
        {shown && (
          <span className="tfl-strip__ohlc">
            <span><i>O</i>{fmtPx(shown.open)}</span>
            <span><i>H</i>{fmtPx(shown.high)}</span>
            <span><i>L</i>{fmtPx(shown.low)}</span>
            <span><i>C</i>{fmtPx(shown.close)}</span>
            {change !== null && <span className={change >= 0 ? 'pos' : 'neg'}>{change >= 0 ? '+' : '−'}{Math.abs(change * 100).toFixed(2)}%</span>}
          </span>
        )}
        {nav && <span className="tfl-strip__nav">{nav}</span>}
      </div>
      <svg
        className="tfl-strip__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="listbox"
        aria-label="Candles: click one to break it down"
        onMouseLeave={() => setHover(null)}
      >
        {!bars && <rect className="tfl-strip__wait" x="0" y={H / 2 - 1} width={W} height="2" />}
        {bars && scale && bars.map((b, i) => {
          const x = (i + offset) * slot;
          const up = b.close >= b.open;
          const on = b.time === picked.from;
          const top = y(Math.max(b.open, b.close));
          const body = Math.max(1, Math.abs(y(b.open) - y(b.close)));
          return (
            <g
              key={b.time}
              className={`tfl-strip__c${on ? ' is-on' : ''}${hover === i ? ' is-hover' : ''}`}
              role="option"
              aria-selected={on}
              aria-label={windowText(candleAt(interval, b.time))}
              onMouseEnter={() => setHover(i)}
              onClick={() => onPick(candleAt(interval, b.time))}
            >
              <rect className="tfl-strip__col" x={x} y="0" width={slot} height={H} />
              <line className={up ? 'is-up' : 'is-down'} x1={x + slot / 2} x2={x + slot / 2} y1={y(b.high)} y2={y(b.low)} vectorEffect="non-scaling-stroke" />
              <rect className={up ? 'is-up' : 'is-down'} x={x + slot * 0.2} y={top} width={slot * 0.6} height={body} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
