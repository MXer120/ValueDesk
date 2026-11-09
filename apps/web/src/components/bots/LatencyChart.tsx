/**
 * The executor's latency to SoDEX over a day (bots/data.ts useBotLatency): p95 the bright line, p50 the faint one,
 * p99 dotted, one point per 10 minutes, ms on the right axis. A stretch where p95 runs well above its own day is
 * shaded and named ("tokyo · p95 elevated"), the line drawn in --neg there. Markers under the chart are the
 * moments the caller passes (bots started or stopped).
 *
 * Drawn as SVG: three lines and a band do not need the chart library, and it stays crisp at any width.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LatencyBucket, LatencyRegion } from '../../bots/data';

export interface ChartMark { t: number; label: string; tone?: 'warn' | 'muted' }

const H_DEFAULT = 232;
const PAD = { l: 8, r: 46, t: 30, b: 24 };

/** All regions as one: per bucket the worst p50 / p95 / p99 of any region (what the slowest user sees). */
export function mergeRegions(regions: LatencyRegion[]): LatencyBucket[] {
  const by = new Map<number, LatencyBucket>();
  for (const r of regions) {
    for (const b of r.buckets) {
      const x = by.get(b.t);
      if (!x) by.set(b.t, { ...b });
      else {
        const mx = (a: number | null, c: number | null) => (a === null ? c : c === null ? a : Math.max(a, c));
        by.set(b.t, { t: b.t, n: x.n + b.n, p50: mx(x.p50, b.p50), p95: mx(x.p95, b.p95), p99: mx(x.p99, b.p99) });
      }
    }
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/** Stretches of at least two buckets where p95 is over 1.6x the day's median p95 (and 40 ms above it). */
export function elevated(buckets: LatencyBucket[]): Array<{ from: number; to: number; peak: number }> {
  const p = buckets.map((b) => b.p95).filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (p.length < 6) return [];
  const med = p[Math.floor(p.length / 2)]!;
  const line = Math.max(med * 1.6, med + 40);
  const out: Array<{ from: number; to: number; peak: number }> = [];
  let cur: { from: number; to: number; peak: number; n: number } | null = null;
  for (const b of buckets) {
    if (b.p95 !== null && b.p95 > line) {
      if (cur) { cur.to = b.t; cur.peak = Math.max(cur.peak, b.p95); cur.n++; }
      else cur = { from: b.t, to: b.t, peak: b.p95, n: 1 };
    } else if (cur) {
      if (cur.n >= 2) out.push({ from: cur.from, to: cur.to, peak: cur.peak });
      cur = null;
    }
  }
  if (cur && cur.n >= 2) out.push({ from: cur.from, to: cur.to, peak: cur.peak });
  return out;
}

/** A smooth line through the points (Catmull-Rom as cubic Beziers), like the reference card. */
export function smoothPath(pts: Array<[number, number]>): string {
  if (!pts.length) return '';
  if (pts.length < 3) return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const k = 1 / 6;
    d += `C${(p1[0] + (p2[0] - p0[0]) * k).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) * k).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) * k).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) * k).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/** A round step for at most four intervals, and the top it reaches. */
export function niceScale(v: number): { top: number; step: number } {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  const step = steps.find((x) => x * 4 >= v) ?? Math.ceil(v / 4 / 1000) * 1000;
  return { top: Math.max(step * Math.ceil(v / step), step), step };
}

export function LatencyChart({ buckets, bucketMs, regionLabel, marks = [], hours = 24, height }: {
  buckets: LatencyBucket[];
  bucketMs: number;
  /** For the elevated stretch's name ('tokyo'); several regions merged: 'all regions'. */
  regionLabel: string;
  marks?: ChartMark[];
  hours?: number;
  height?: number;
}) {
  const H = height ?? H_DEFAULT;
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const end = buckets.length ? buckets[buckets.length - 1]!.t + bucketMs : Date.now();
  const start = end - hours * 3_600_000;
  const shown = useMemo(() => buckets.filter((b) => b.t >= start), [buckets, start]);
  // The scale follows p95 (the line that matters); a rare p99 spike is drawn at the top rather than flattening the rest.
  const p95max = Math.max(...shown.map((b) => b.p95 ?? b.p50 ?? 0));
  const { top, step } = niceScale(Math.max(50, p95max * 1.45));
  const x = (t: number) => PAD.l + ((t + bucketMs / 2 - start) / (end - start)) * (w - PAD.l - PAD.r);
  const y = (ms: number) => PAD.t + (1 - Math.min(ms, top) / top) * (H - PAD.t - PAD.b);
  // One smooth run per stretch with data; a bucket without writes breaks the line.
  const line = (k: 'p50' | 'p95' | 'p99', from = -Infinity, to = Infinity) => {
    let d = '';
    let run: Array<[number, number]> = [];
    for (const b of shown) {
      const v = b[k];
      if (b.t < from || b.t > to) continue;
      if (v === null || b.n === 0) { d += smoothPath(run); run = []; continue; }
      run.push([x(b.t), y(v)]);
    }
    return d + smoothPath(run);
  };
  const bands = useMemo(() => elevated(shown), [shown]);
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
  const hourTicks: number[] = [];
  const hourStep = hours <= 12 ? 2 : 4;
  const first = Math.ceil(start / (hourStep * 3_600_000)) * hourStep * 3_600_000;
  for (let t = first; t <= end; t += hourStep * 3_600_000) hourTicks.push(t);
  const hb = hover !== null ? shown[hover] : null;
  const fmtHour = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  // Stretches without a write: a dashed line at 0 (owner: never a gap that reads as missing data).
  const idle: Array<[number, number]> = [];
  {
    let from: number | null = null;
    for (const b of shown) {
      if (b.n === 0) { if (from === null) from = b.t; }
      else if (from !== null) { idle.push([from, b.t]); from = null; }
    }
    if (from !== null) idle.push([from, end]);
  }
  const none = !shown.some((b) => b.n > 0);

  return (
    <div className="bots-lat__chart" ref={wrap}>
      <svg
        width={w}
        height={H}
        viewBox={`0 0 ${w} ${H}`}
        role="img"
        aria-label={`Latency over ${hours} hours: p50, p95 and p99 in milliseconds`}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left;
          let best = -1;
          let dist = Infinity;
          shown.forEach((b, i) => { const dd = Math.abs(x(b.t) - px); if (dd < dist) { dist = dd; best = i; } });
          setHover(best >= 0 ? best : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="bots-lat-band" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--neg)" stopOpacity="0.16" />
            <stop offset="1" stopColor="var(--neg)" stopOpacity="0.02" />
          </linearGradient>
          <filter id="bots-lat-glow" x="-10%" y="-40%" width="120%" height="180%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
          <pattern id="bots-lat-idle" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="rgb(var(--ink) / 0.025)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgb(var(--ink) / 0.08)" strokeWidth="2" />
          </pattern>
          <filter id="bots-lat-hotglow" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="3.2" />
          </filter>
        </defs>
        {ticks.map((v) => (
          <text key={v} x={w - PAD.r + 14} y={y(v) + 3.5} className="bots-lat__ax">{v}</text>
        ))}
        {bands.map((b) => {
          const x0 = x(b.from) - (w / Math.max(shown.length, 1)) * 0.6;
          const x1 = x(b.to) + (w / Math.max(shown.length, 1)) * 0.6;
          return (
            <g key={b.from}>
              <rect x={x0} y={PAD.t - 6} width={Math.max(8, x1 - x0)} height={H - PAD.t - PAD.b + 6} fill="url(#bots-lat-band)" />
              <text x={Math.min(Math.max((x0 + x1) / 2, 70), w - PAD.r - 70)} y={PAD.t - 12} className="bots-lat__flag" textAnchor="middle">{regionLabel} · p95 elevated</text>
            </g>
          );
        })}
        {idle.map(([a0, a1]) => {
          const half = ((bucketMs / (end - start)) * (w - PAD.l - PAD.r)) / 2;
          const x0 = Math.max(PAD.l, x(a0) - half);
          const x1 = Math.min(w - PAD.r, x(a1) - half);
          if (x1 - x0 < 2) return null;
          return (
            <g key={`idle-${a0}`} className="bots-lat__idle">
              <rect x={x0} y={PAD.t - 6} width={x1 - x0} height={H - PAD.t - PAD.b + 6} fill="url(#bots-lat-idle)" rx={4} />
              {x1 - x0 > 64 && !none && <text x={(x0 + x1) / 2} y={H - PAD.b - 8} textAnchor="middle">no orders</text>}
            </g>
          );
        })}
        {none && <text x={(PAD.l + w - PAD.r) / 2} y={(PAD.t + H - PAD.b) / 2} textAnchor="middle" className="bots-lat__none">No orders in this window</text>}
        <path d={line('p99')} className="bots-lat__p99" />
        <path d={line('p50')} className="bots-lat__p50" />
        <path d={line('p95')} className="bots-lat__p95glow" filter="url(#bots-lat-glow)" />
        <path d={line('p95')} className="bots-lat__p95" />
        {bands.map((b) => {
          const d = line('p95', b.from - bucketMs, b.to + bucketMs);
          return (
            <g key={`hot-${b.from}`}>
              <path d={d} className="bots-lat__hotglow" filter="url(#bots-lat-hotglow)" />
              <path d={d} className="bots-lat__hot" />
            </g>
          );
        })}
        {hourTicks.map((t) => (
          <text key={t} x={Math.max(PAD.l + 14, x(t - bucketMs / 2))} y={H - 4} className="bots-lat__ax" textAnchor="middle">{fmtHour(t)}</text>
        ))}
        {marks.filter((m) => m.t >= start && m.t <= end).map((m) => (
          <g key={`${m.t}-${m.label}`} className={`bots-lat__mark is-${m.tone ?? 'muted'}`}>
            <line x1={x(m.t)} x2={x(m.t)} y1={H - PAD.b - 9} y2={H - PAD.b + 2} />
            <circle cx={x(m.t)} cy={H - PAD.b - 10} r={3}><title>{m.label}</title></circle>
          </g>
        ))}
        {hb && (
          <line x1={x(hb.t)} x2={x(hb.t)} y1={PAD.t} y2={H - PAD.b} className="bots-lat__cursor" />
        )}
      </svg>
      {hb && (
        <div className="bots-lat__tip" style={{ left: Math.min(Math.max(x(hb.t) - 70, 4), w - 150) }} role="status">
          <b>{fmtHour(hb.t)}–{fmtHour(hb.t + bucketMs)}</b>
          <span><i className="is-p95" />p95 {hb.p95 ?? '—'} ms</span>
          <span><i className="is-p50" />p50 {hb.p50 ?? '—'} ms</span>
          <span><i className="is-p99" />p99 {hb.p99 ?? '—'} ms</span>
          <small>{hb.n.toLocaleString('en-US')} writes</small>
        </div>
      )}
    </div>
  );
}
