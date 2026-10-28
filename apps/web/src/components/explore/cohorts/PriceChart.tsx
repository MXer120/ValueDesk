/**
 * An asset's price over the page's range, beside its positioning chart: so a
 * shift in how the cohorts lean can be read against what the price did.
 * Hyperliquid candles (server: /api/vs/price), drawn as candles by default or
 * as a line with a soft fill; the range's high and low on the right, a hover
 * readout (open / high / low / close).
 *
 * The hover is shared with the page: moving over this chart moves the
 * positioning chart's crosshair and the cohort table to that time, and the
 * reverse (`syncT`).
 *
 * Candle colour follows the trade chart: up = --pos, down = --neg, and a
 * candle that closed where it opened takes the side of its move from the
 * previous close - never grey.
 */
import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { DASH } from '../../../format';
import { fmtPx } from '../model';
import { fmtFixed } from '../../../numStyle';

export type Candle = readonly [t: number, o: number, h: number, l: number, c: number];
export type PriceKind = 'candles' | 'line';

const W = 600;
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${fmtFixed(Math.abs(v * 100), 2)}%`;

/** Candles from the answer; an older server sends closes only - each opens at the previous close. */
export function toCandles(candles: ReadonlyArray<Candle> | undefined, points: ReadonlyArray<readonly [number, number]>): Candle[] {
  if (candles?.length) return [...candles];
  return points.map(([t, c], i) => {
    const o = i ? points[i - 1]![1] : c;
    return [t, o, Math.max(o, c), Math.min(o, c), c] as const;
  });
}

/** Up or down for each candle; a flat one takes the side of its move from the previous close. */
export function candleUp(cs: ReadonlyArray<Candle>): boolean[] {
  return cs.map(([, o, , , c], i) => (c !== o ? c > o : i ? c >= cs[i - 1]![4] : true));
}

/** The last candle at or before t (null before the first). */
function indexAt(cs: ReadonlyArray<Candle>, t: number): number | null {
  if (!cs.length || t < cs[0]![0]) return null;
  let lo = 0;
  let hi = cs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cs[mid]![0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function PriceChart({
  candles, kind, height, syncT = null, onHover,
}: {
  candles: ReadonlyArray<Candle>;
  kind: PriceKind;
  height: number;
  /** A time hovered elsewhere on the page. */
  syncT?: number | null;
  /** The time under the pointer here (null when it leaves). */
  onHover?: (t: number | null) => void;
}) {
  const box = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const padT = 10;
  const padB = 24;
  const padR = 64;
  const plotW = W - padR;
  const n = candles.length;

  const geo = useMemo(() => {
    if (n < 2) return null;
    const t0 = candles[0]![0];
    // One slot per candle, the last one ending at the right edge of the plot.
    const step = (candles[n - 1]![0] - t0) / (n - 1) || 1;
    const t1 = candles[n - 1]![0] + step;
    let lo = Infinity;
    let hi = -Infinity;
    // One scale for both kinds (the wicks'), so switching never jumps.
    for (const [, , h, l] of candles) { lo = Math.min(lo, l); hi = Math.max(hi, h); }
    const pad = (hi - lo) * 0.08 || hi * 0.01;
    return { t0, t1, step, lo, hi, y0: lo - pad, y1: hi + pad, up: candleUp(candles) };
  }, [candles, n]);
  if (!geo) return null;

  const { t0, t1, step, lo, hi, y0, y1, up } = geo;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * plotW;
  const y = (v: number) => padT + (1 - (v - y0) / (y1 - y0 || 1)) * (H - padT - padB);
  const slot = (step / (t1 - t0)) * plotW;
  const body = Math.max(0.6, slot * 0.62);
  const mid = (t: number) => x(t) + slot / 2;

  const line = candles.map(([t, , , , c], i) => `${i ? 'L' : 'M'}${mid(t).toFixed(1)} ${y(c).toFixed(1)}`).join(' ');
  const first = candles[0]!;
  const last = candles[n - 1]!;
  const rising = last[4] >= first[1];
  const nearLast = (v: number) => Math.abs(y(v) - y(last[4])) < 14;

  // Our pointer first; otherwise the page's.
  const shown = hover ?? (syncT !== null ? indexAt(candles, syncT) : null);
  const h = shown !== null ? candles[shown]! : null;
  const short = t1 - t0 < 36 * 3_600_000;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const fx = Math.max(0, Math.min(plotW - 0.01, ((e.clientX - r.left) / r.width) * W));
    const i = Math.min(n - 1, Math.floor(fx / slot));
    setHover(i);
    onHover?.(candles[i]![0]);
  };
  const onLeave = () => {
    setHover(null);
    onHover?.(null);
  };

  return (
    <div className="coh-price" style={{ height: H }} onPointerMove={onMove} onPointerLeave={onLeave}>
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={kind === 'candles' ? 'Price candles over the range' : 'Price over the range'}>
        <defs>
          <linearGradient id="coh-price-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className={`coh-price__stop ${rising ? 'pos' : 'neg'}`} />
            <stop offset="1" className={`coh-price__stop is-off ${rising ? 'pos' : 'neg'}`} />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => {
          const yy = padT + f * (H - padT - padB);
          return <line key={f} x1="0" x2={plotW} y1={yy} y2={yy} className="coh-lean__grid" vectorEffect="non-scaling-stroke" />;
        })}
        <g className={`coh-price__candles${kind === 'candles' ? ' is-on' : ''}`} aria-hidden={kind !== 'candles'}>
          {candles.map(([t, o, hh, l, c], i) => {
            const cx = mid(t);
            const top = y(Math.max(o, c));
            const bh = Math.max(1, y(Math.min(o, c)) - top);
            const tone = up[i] ? 'pos' : 'neg';
            return (
              <g key={t} className={`coh-candle ${tone}${shown === i ? ' is-hover' : ''}`}>
                <line x1={cx} x2={cx} y1={y(hh)} y2={y(l)} vectorEffect="non-scaling-stroke" />
                <rect x={cx - body / 2} y={top} width={body} height={bh} />
              </g>
            );
          })}
        </g>
        <g className={`coh-price__lineg${kind === 'line' ? ' is-on' : ''}`} aria-hidden={kind !== 'line'}>
          <path d={`${line} L${mid(last[0])} ${H - padB} L${mid(first[0])} ${H - padB} Z`} fill="url(#coh-price-fill)" />
          <path d={line} className={`coh-price__line ${rising ? 'pos' : 'neg'}`} vectorEffect="non-scaling-stroke" />
        </g>
        {h && <line x1={mid(h[0])} x2={mid(h[0])} y1={padT} y2={H - padB} className="coh-lean__cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="coh-price__badge">
        <span>{h ? when(h[0]) : 'Last'}</span>
        {h ? (
          <>
            <span className="coh-price__ohlc">
              <i>O</i>{fmtPx(h[1])}<i>H</i>{fmtPx(h[2])}<i>L</i>{fmtPx(h[3])}<i>C</i><b>{fmtPx(h[4])}</b>
            </span>
            <em className={h[4] >= h[1] ? 'pos' : 'neg'}>{signed((h[4] - h[1]) / h[1])}</em>
          </>
        ) : (
          <>
            <b>{fmtPx(last[4])}</b>
            <em className={rising ? 'pos' : 'neg'}>{signed((last[4] - first[1]) / first[1])}</em>
          </>
        )}
      </div>
      {/* The range's high and low, unless the last price's tag already sits there. */}
      {!nearLast(hi) && <span className="coh-multi__tick" style={{ top: `${(y(hi) / H) * 100}%`, left: `calc(${(plotW / W) * 100}% + 6px)` }}>{Number.isFinite(hi) ? fmtPx(hi) : DASH}</span>}
      {!nearLast(lo) && <span className="coh-multi__tick" style={{ top: `${(y(lo) / H) * 100}%`, left: `calc(${(plotW / W) * 100}% + 6px)` }}>{Number.isFinite(lo) ? fmtPx(lo) : DASH}</span>}
      <span className={`coh-price__last ${rising ? 'pos' : 'neg'}`} style={{ top: `${(y(last[4]) / H) * 100}%`, left: `calc(${(plotW / W) * 100}% + 2px)` }}>{fmtPx(last[4])}</span>
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const t = t0 + f * (t1 - t0);
        return (
          <span key={i} className="coh-lean__date" style={{ left: `${(x(t) / W) * 100}%`, transform: i === 0 ? 'none' : i === 4 ? 'translateX(-100%)' : undefined }}>
            {short ? clock(t) : day(t)}
          </span>
        );
      })}
    </div>
  );
}
