/**
 * Every cohort's lean on one asset or sector, on one chart.
 *
 * One line per cohort (its long share over time), each in the cohort's own
 * colour. On each line's newest point sits the cohort's icon, white on a disc
 * coloured by that share - green long, red short, stronger further from even -
 * so where the crowd stands is readable at a glance. Hovering shows, top left, every cohort
 * at that moment: icon, name and long share, most bullish first.
 *
 * Fixed 0-100% scale with the even line dashed; lines morph when the range or
 * the subject changes (same sampling as LeanChart).
 */
import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { COHORT_BY_ID, longShare, type CohortId, type CohortPoint } from '@sign/valuescan/cohorts/model.js';
import { CohortIcon } from './CohortIcon';
import { COHORT_COLOR } from './cohortStyle';
import { morphPath } from './LeanChart';

/** The value of a line at time t (the last point at or before it) - also used by the page's table. */
export function shareAt(points: ReadonlyArray<{ t: number; long: number; short: number }>, t: number): { long: number; short: number } | null {
  let hit: { long: number; short: number } | null = null;
  for (const p of points) {
    if (p.t > t) break;
    hit = p;
  }
  return hit;
}

const W = 600;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type Line = { id: CohortId; pts: Array<readonly [number, number]> };

/** A marker's disc: the side the share leans to, solid, stronger further from even. */
function dotTone(share: number): string {
  const strength = Math.min(1, Math.abs(share - 0.5) * 2);
  const pct = Math.round(55 + strength * 45);
  return `color-mix(in srgb, ${share >= 0.5 ? 'var(--pos)' : 'var(--neg)'} ${pct}%, var(--bg-panel))`;
}

/** The value of a line at time t (the last point at or before it). */
function valueAt(pts: ReadonlyArray<readonly [number, number]>, t: number): number | null {
  let v: number | null = null;
  for (const [pt, pv] of pts) {
    if (pt > t) break;
    v = pv;
  }
  return v;
}

export function MultiLeanChart({
  series, ids, height, onHover, syncT = null,
}: {
  series: Partial<Record<CohortId, CohortPoint[]>>;
  ids: readonly CohortId[];
  height: number;
  /** The time under the pointer (null when it leaves), for the page's table. */
  onHover?: (t: number | null) => void;
  /** A time hovered elsewhere on the page (the price chart): shown here while this chart is not hovered. */
  syncT?: number | null;
}) {
  const box = useRef<SVGSVGElement>(null);
  const [hoverT, setHoverTState] = useState<number | null>(null);
  const setHoverT = (t: number | null) => {
    setHoverTState(t);
    onHover?.(t);
  };
  const H = height;
  const padT = 10;
  const padB = 24;
  const padR = 58;
  const plotW = W - padR;

  const lines: Line[] = ids.flatMap((id) => {
    const pts = (series[id] ?? []).flatMap((p) => {
      const s = longShare(p.long, p.short);
      return s === null ? [] : [[p.t, s] as const];
    });
    return pts.length > 1 ? [{ id, pts }] : [];
  });
  const t0 = Math.min(...lines.map((l) => l.pts[0]![0]));
  const t1 = Math.max(...lines.map((l) => l.pts[l.pts.length - 1]![0]));
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * plotW : 0);
  const y = (v: number) => padT + (1 - v) * (H - padT - padB);

  // Markers ON each line's newest point. Two at the same spot step left of each
  // other (never up or down: the height is the reading).
  const ends = lines
    .map((l) => {
      const [t, v] = l.pts[l.pts.length - 1]!;
      return { id: l.id, v, px: x(t), py: y(v), dx: 0 };
    })
    .sort((a, b) => a.py - b.py);
  for (let i = 1; i < ends.length; i++) {
    const prev = ends[i - 1]!;
    if (Math.abs(ends[i]!.py - prev.py) < 14 && Math.abs(ends[i]!.px - prev.px) < 1) ends[i]!.dx = prev.dx - 16;
  }

  // Tracked on the whole box: the markers and the readout sit on top of the SVG,
  // and moving onto one of them must not count as leaving the chart.
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !lines.length) return;
    const fx = ((e.clientX - r.left) / r.width) * W;
    setHoverT(t0 + (Math.max(0, Math.min(plotW, fx)) / plotW) * (t1 - t0));
  };
  // Our own pointer first; otherwise the page's (only inside this chart's span).
  const shownT = hoverT ?? (syncT !== null && lines.length && syncT >= t0 && syncT <= t1 ? syncT : null);
  const readout = shownT === null ? null : lines
    .map((l) => ({ id: l.id, v: valueAt(l.pts, shownT) }))
    .filter((r): r is { id: CohortId; v: number } => r.v !== null)
    .sort((a, b) => b.v - a.v);
  const dates = lines.length ? [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0)) : [];
  const short = t1 - t0 < 36 * 3_600_000;

  return (
    <div className="coh-multi" style={{ height: H }} onPointerMove={onMove} onPointerLeave={() => setHoverT(null)}>
      <svg
        ref={box}
        className="coh-multi__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Long share of each cohort over time"
      >
        {[1, 0.75, 0.25, 0].map((v) => (
          <line key={v} x1="0" x2={plotW} y1={y(v)} y2={y(v)} className="coh-lean__grid" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1="0" x2={plotW} y1={y(0.5)} y2={y(0.5)} className="coh-lean__even" vectorEffect="non-scaling-stroke" />
        {lines.map((l) => {
          const d = morphPath(l.pts, t0, t1, x, y);
          return (
            <path
              key={l.id}
              d={d}
              style={{ d: `path("${d}")`, stroke: COHORT_COLOR[l.id] } as CSSProperties}
              className={`coh-multi__line${readout && readout[0]?.id === l.id ? ' is-top' : ''}`}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {shownT !== null && <line x1={x(shownT)} x2={x(shownT)} y1={padT} y2={H - padB} className="coh-lean__cross" vectorEffect="non-scaling-stroke" />}
      </svg>

      {ends.map((e) => (
        <span
          key={e.id}
          className="coh-multi__dot"
          style={{
            left: `calc(${(e.px / W) * 100}% + ${e.dx}px)`,
            top: e.py,
            background: dotTone(e.v),
            '--c': COHORT_COLOR[e.id],
          } as CSSProperties}
          title={`${COHORT_BY_ID[e.id].name}: ${pct(e.v)} long`}
        >
          <CohortIcon id={e.id} size={12} />
        </span>
      ))}

      {readout && readout.length > 0 && (
        <div className="coh-multi__readout">
          <span className="coh-multi__when">{when(shownT!)}</span>
          {readout.map((r) => (
            <span key={r.id} className="coh-multi__row" style={{ '--c': COHORT_COLOR[r.id] } as CSSProperties}>
              <i><CohortIcon id={r.id} size={12} /></i>
              <span>{COHORT_BY_ID[r.id].name}</span>
              <b className={r.v >= 0.5 ? 'pos' : 'neg'}>{pct(r.v)}</b>
            </span>
          ))}
        </div>
      )}

      {[1, 0.75, 0.5, 0.25, 0].map((v) => (
        <span key={v} className="coh-multi__tick" style={{ top: `${(y(v) / H) * 100}%`, left: `calc(${(plotW / W) * 100}% + 16px)` }}>{Math.round(v * 100)}%</span>
      ))}
      {dates.map((t, i) => (
        <span key={i} className="coh-lean__date" style={{ left: `${(x(t) / W) * 100}%`, transform: i === 0 ? 'none' : i === dates.length - 1 ? 'translateX(-100%)' : undefined }}>
          {short ? clock(t) : day(t)}
        </span>
      ))}
      {!lines.length && (
        <div className="coh-chart__empty" role="status">
          <b>Not enough history yet</b>
          <span>Each cohort's positioning on this is charted hourly. The first lines appear within the hour.</span>
        </div>
      )}
    </div>
  );
}
