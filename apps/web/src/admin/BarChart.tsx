/**
 * One series of daily columns (docs/DESIGN.md tokens; the dataviz mark specs): thin
 * columns (at most 24px) growing from one baseline, a 4px rounded top, 2px of air
 * between them, hairline axis, the value of a column on hover or keyboard focus - and
 * every value in the table under "Table", so the tooltip never gates a number.
 * One series, so no legend: the title names it. Magnitude, not direction: --muted,
 * never --pos / --neg.
 */
import { useId, useState } from 'react';

export interface Bar {
  key: string | number;
  label: string;
  value: number;
}

const W = 720;
const H = 160;
const PAD_L = 56;
const PAD_B = 22;
const PAD_T = 8;

export function BarChart({ title, bars, fmt, fmtAxis }: { title: string; bars: readonly Bar[]; fmt: (v: number) => string; fmtAxis?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const max = Math.max(0, ...bars.map((b) => b.value));
  const top = max > 0 ? niceCeil(max) : 1;
  const plotW = W - PAD_L - 4;
  const plotH = H - PAD_B - PAD_T;
  const band = bars.length ? plotW / bars.length : plotW;
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => PAD_T + plotH - (v / top) * plotH;
  const tick = (v: number) => (fmtAxis ?? fmt)(v);
  const every = Math.max(1, Math.ceil(bars.length / 8));
  const h = hover === null ? null : bars[hover];
  return (
    <figure className="dv-chart" aria-labelledby={`${id}-t`}>
      <figcaption className="dv-chart__head">
        <span id={`${id}-t`} className="dv-chart__title">{title}</span>
        <span className="dv-chart__read" aria-live="polite">{h ? `${h.label}: ${fmt(h.value)}` : `max ${fmt(max)}`}</span>
        <button type="button" className="dv-link" onClick={() => setTable((t) => !t)} aria-expanded={table}>{table ? 'Chart' : 'Table'}</button>
      </figcaption>
      {table ? (
        <table className="dv-table">
          <thead><tr><th>Day</th><th className="right">{title}</th></tr></thead>
          <tbody>{bars.map((b) => <tr key={b.key}><td>{b.label}</td><td className="right">{fmt(b.value)}</td></tr>)}</tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="dv-chart__svg" role="img" aria-label={`${title} per day`} onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD_L} x2={W} y1={y(top * f)} y2={y(top * f)} className={f === 0 ? 'dv-chart__base' : 'dv-chart__grid'} />
              <text x={PAD_L - 6} y={y(top * f) + 4} className="dv-chart__tick" textAnchor="end">{tick(top * f)}</text>
            </g>
          ))}
          {bars.map((b, i) => {
            const x = PAD_L + i * band + (band - barW) / 2;
            const top0 = y(b.value);
            const hgt = Math.max(0, PAD_T + plotH - top0);
            const r = Math.min(4, barW / 2, hgt);
            return (
              <g
                key={b.key}
                tabIndex={0}
                role="graphics-symbol"
                aria-label={`${b.label}: ${fmt(b.value)}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                {/* The hit target is the whole band, taller than the column. */}
                <rect x={PAD_L + i * band} y={PAD_T} width={band} height={plotH} fill="transparent" />
                {hgt > 0 && <path d={columnPath(x, top0, barW, hgt, r)} className={hover === i ? 'dv-chart__bar is-hot' : 'dv-chart__bar'} />}
                {i % every === 0 && <text x={PAD_L + i * band + band / 2} y={H - 6} className="dv-chart__tick" textAnchor="middle">{b.label}</text>}
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}

/** A column with a rounded top and a square foot on the baseline. */
function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** The next round number at or above `v` (1, 2, 2.5, 5 x 10^n). */
export function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
