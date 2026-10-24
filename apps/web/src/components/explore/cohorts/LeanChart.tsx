/**
 * A cohort's lean over time: the long share of its open exposure.
 *
 * Sparkline (cards): the line alone, scaled to its own range, --pos above the
 * even line (dashed) and --neg below it - clipped at the even line, so a
 * crossing changes colour exactly where it crosses.
 *
 * Full (the cohort page): a fixed 0-100% scale; the line glows toward the
 * even line - green where the cohort leans long, red where it leans short,
 * fading out at 50% - with the window's word and share in the corner, dates
 * along the bottom and a hover readout.
 *
 * Switching window or cohort morphs the line rather than swapping it.
 *
 * Bands (full chart): hours rebuilt from funding history rather than recorded,
 * and hours with no data at all, are shaded behind the line and named - the
 * line still runs through a gap (it morphs as one path), so the band says it
 * is not data.
 */
import { useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { BIAS_LABEL, biasOf } from '@sign/valuescan/cohorts/model.js';

export interface LeanBand {
  from: number;
  to: number;
  kind: 'rebuilt' | 'gap';
}

export interface LeanChartProps {
  /** [t ms, long share 0..1], oldest first. */
  points: ReadonlyArray<readonly [number, number]>;
  height: number;
  full?: boolean;
  /** Full chart: the window's name for the corner ("30D"). */
  label?: string;
  /** Full chart: rebuilt and missing stretches (bandsOf). */
  bands?: readonly LeanBand[];
  className?: string;
}

const BAND_TITLE: Record<LeanBand['kind'], string> = {
  rebuilt:
    'Rebuilt: the index was not recording here. Hyperliquid and trade.xyz positions are rebuilt hour by hour from their funding history; ' +
    'in a view with Lighter, SoDEX or Arcus, those are drawn straight between the recorded points either side.',
  gap: 'No data: the index was not recording here.',
};
const BAND_WORD: Record<LeanBand['kind'], string> = { rebuilt: 'Rebuilt', gap: 'No data' };

/**
 * The stretches of a series that were rebuilt (`rebuilt` points), and the gaps
 * in it: a step over four times the usual one, and at least two hours.
 */
export function bandsOf(series: ReadonlyArray<{ t: number; rebuilt?: boolean }>): LeanBand[] {
  const out: LeanBand[] = [];
  if (series.length < 2) return out;
  const steps = series.slice(1).map((p, i) => p.t - series[i]!.t).sort((a, b) => a - b);
  const usual = steps[Math.floor(steps.length / 2)]!;
  const gapOver = Math.max(2 * 3_600_000, 4 * usual);
  let run: LeanBand | null = null;
  for (let i = 0; i < series.length; i++) {
    const p = series[i]!;
    if (i && p.t - series[i - 1]!.t > gapOver) out.push({ from: series[i - 1]!.t, to: p.t, kind: 'gap' });
    if (p.rebuilt) {
      if (run && i && series[i - 1]!.rebuilt) run.to = p.t;
      else out.push((run = { from: p.t, to: p.t, kind: 'rebuilt' }));
    }
  }
  // A lone rebuilt point is an hour wide.
  for (const b of out) if (b.kind === 'rebuilt' && b.to - b.from < 3_600_000) { b.from -= 1_800_000; b.to += 1_800_000; }
  return out;
}

const W = 600;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const SAMPLES = 140;

/** The line through `points`, resampled to SAMPLES evenly spaced times (linear between points). */
export function morphPath(
  points: ReadonlyArray<readonly [number, number]>, t0: number, t1: number,
  x: (t: number) => number, y: (v: number) => number,
): string {
  if (points.length < 2) return '';
  const out: string[] = [];
  let j = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t = t0 + ((t1 - t0) * i) / (SAMPLES - 1);
    while (j < points.length - 2 && points[j + 1]![0] < t) j++;
    const [ta, va] = points[j]!;
    const [tb, vb] = points[Math.min(j + 1, points.length - 1)]!;
    const v = tb > ta ? va + ((vb - va) * Math.max(0, Math.min(1, (t - ta) / (tb - ta)))) : va;
    out.push(`${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`);
  }
  return out.join(' ');
}

export function LeanChart({ points, height, full = false, label, bands = [], className = '' }: LeanChartProps) {
  const id = useId().replace(/:/g, '');
  const box = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const padT = full ? 8 : 4;
  const padB = full ? 24 : 4;
  const padR = full ? 46 : 0;
  const plotW = W - padR;

  if (points.length < 2 && !full) {
    return (
      <svg className={`coh-lean is-empty ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="coh-lean__even" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }

  const t0 = points[0]?.[0] ?? 0;
  const t1 = points[points.length - 1]?.[0] ?? 1;
  let lo = 0;
  let hi = 1;
  if (!full) {
    lo = 0.5;
    hi = 0.5;
    for (const [, v] of points) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const span = Math.max(0.04, hi - lo);
    lo = Math.max(0, lo - span * 0.12);
    hi = Math.min(1, hi + span * 0.12);
  }
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * plotW : 0);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  // A fixed number of evenly spaced samples, so a new window or cohort MORPHS
  // the line (CSS transitions `d` between paths of the same shape) instead of
  // swapping it.
  const d = morphPath(points, t0, t1, (t) => x(t), y);
  const even = y(0.5);
  // The same samples closed along the even line: morphs with the line.
  const area = d ? `${d} L${plotW.toFixed(1)} ${even.toFixed(1)} L0 ${even.toFixed(1)} Z` : '';
  let vMax = 0.5;
  let vMin = 0.5;
  for (const [, v] of points) { vMax = Math.max(vMax, v); vMin = Math.min(vMin, v); }
  const lineTop = y(vMax);
  const lineBottom = y(vMin);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !full || points.length < 2) return;
    const fx = ((e.clientX - r.left) / r.width) * W;
    const t = t0 + (Math.max(0, Math.min(plotW, fx)) / plotW) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i]![0] - t) < Math.abs(points[best]![0] - t)) best = i;
    setHover(best);
  };
  const h = hover !== null ? points[hover] : null;
  const last = points[points.length - 1]?.[1] ?? null;
  const shown = h ? h[1] : last;
  const bias = biasOf(shown);
  const shownBands = full && points.length > 1
    ? bands.flatMap((b) => {
      const xa = x(Math.max(t0, b.from));
      const xb = x(Math.min(t1, b.to));
      return xb - xa >= 1 ? [{ ...b, xa, xb }] : [];
    })
    : [];
  const hRebuilt = !!h && bands.some((b) => b.kind === 'rebuilt' && h[0] >= b.from && h[0] <= b.to);
  const ticks = full ? [1, 0.75, 0.5, 0.25, 0] : [];
  const dates = full && points.length > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0)) : [];

  return (
    <div className={`coh-lean-wrap${full ? ' is-full' : ''} ${className}`} style={{ height: H }}>
      <svg
        ref={box}
        className={`coh-lean${full ? ' is-full' : ''}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role={full ? 'img' : undefined}
        aria-label={full && last !== null ? `Long share now ${pct(last)}` : undefined}
        aria-hidden={full ? undefined : true}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={`${id}-up`}><rect className="coh-lean__clip" x="0" y="0" width={W} height={Math.max(0, even)} /></clipPath>
          <clipPath id={`${id}-dn`}><rect className="coh-lean__clip" x="0" y={even} width={W} height={Math.max(0, H - even)} /></clipPath>
          {full && points.length > 1 && (
            <>
              {/* From the line's highest point down to 50%, and its lowest point up to 50%. */}
              <linearGradient id={`${id}-gu`} gradientUnits="userSpaceOnUse" x1="0" y1={lineTop} x2="0" y2={even}>
                <stop offset="0" className="coh-lean__glow is-long" />
                <stop offset="1" className="coh-lean__glow is-long is-off" />
              </linearGradient>
              <linearGradient id={`${id}-gd`} gradientUnits="userSpaceOnUse" x1="0" y1={lineBottom} x2="0" y2={even}>
                <stop offset="0" className="coh-lean__glow is-short" />
                <stop offset="1" className="coh-lean__glow is-short is-off" />
              </linearGradient>
            </>
          )}
        </defs>
        {shownBands.map((b, i) => (
          <rect key={`b${i}`} x={b.xa} y={padT} width={b.xb - b.xa} height={Math.max(0, H - padT - padB)} className={`coh-lean__band is-${b.kind}`} />
        ))}
        {full && points.length > 1 && (
          <>
            {/* The area between the line and 50%: above it green, below it red. */}
            <path d={area} style={{ d: `path("${area}")` } as CSSProperties} className="coh-lean__area" fill={`url(#${id}-gu)`} clipPath={`url(#${id}-up)`} />
            <path d={area} style={{ d: `path("${area}")` } as CSSProperties} className="coh-lean__area" fill={`url(#${id}-gd)`} clipPath={`url(#${id}-dn)`} />
          </>
        )}
        {ticks.map((v) => (
          <line key={v} x1="0" x2={plotW} y1={y(v)} y2={y(v)} className="coh-lean__grid" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1="0" x2={plotW} y1={even} y2={even} className="coh-lean__even" vectorEffect="non-scaling-stroke" />
        {points.length > 1 && (
          <>
            <path d={d} style={{ d: `path("${d}")` } as CSSProperties} className="coh-lean__line is-up" clipPath={`url(#${id}-up)`} vectorEffect="non-scaling-stroke" />
            <path d={d} style={{ d: `path("${d}")` } as CSSProperties} className="coh-lean__line is-dn" clipPath={`url(#${id}-dn)`} vectorEffect="non-scaling-stroke" />
          </>
        )}
        {h && <line x1={x(h[0])} x2={x(h[0])} y1={padT} y2={H - padB} className="coh-lean__cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      {full && (
        <>
          {shown !== null && (
            <div className="coh-lean__badge">
              <span>{h ? when(h[0]) : label}{bias ? ` · ${BIAS_LABEL[bias]}` : ''}{hRebuilt ? ' · Rebuilt' : ''}</span>
              <b className={shown >= 0.5 ? 'pos' : 'neg'}>{pct(shown)} Long</b>
            </div>
          )}
          {ticks.map((v) => (
            <span key={v} className="coh-lean__tick" style={{ top: `${(y(v) / H) * 100}%` }}>{Math.round(v * 100)}%</span>
          ))}
          {shownBands.map((b, i) => (
            <span
              key={`l${i}`}
              className={`coh-lean__band-label is-${b.kind}`}
              style={{ left: `${(b.xa / W) * 100}%`, width: `${((b.xb - b.xa) / W) * 100}%`, bottom: padB + 4 }}
              title={BAND_TITLE[b.kind]}
            >
              {b.xb - b.xa >= 44 ? BAND_WORD[b.kind] : ''}
            </span>
          ))}
          {dates.map((t, i) => (
            <span key={i} className="coh-lean__date" style={{ left: `${(x(t) / W) * 100}%`, transform: i === 0 ? 'none' : i === dates.length - 1 ? 'translateX(-100%)' : undefined }}>{t1 - t0 < 36 * 3_600_000 ? clock(t) : day(t)}</span>
          ))}
        </>
      )}
    </div>
  );
}
