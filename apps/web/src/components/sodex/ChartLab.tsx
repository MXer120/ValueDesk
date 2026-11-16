/**
 * SoPoints chart lab - LOCALHOST ONLY (import.meta.env.DEV; owner 2026-11-16: "throw out 10 charts temporarily on
 * localhost of different types + what's shown"). Ten candidate charts from the signed-in wallet's own weeks, each with
 * a line saying what it shows, so the owner can pick which ones go on the page. Never built into production.
 */
import { useMemo } from 'react';
import { Card } from '../portfolio/parts';
import { fmt } from '../../format';
import { TIERS } from '../../points';
import { allWeeks, splitWeek, venueVolumeByWeek, type AnyWeek, type S2State } from './soPointsV2';

const W = 300;
const H = 120;
const usd = (n: number) => (n >= 1e6 ? `$${fmt(n / 1e6, 1)}M` : n >= 1e4 ? `$${fmt(n / 1e3, 0)}K` : `$${fmt(n, 0)}`);

/* --- tiny SVG primitives ------------------------------------------------------------------------------------------- */

function Line({ ys, area, step, invert, refs, cls = 'is-a' }: { ys: Array<number | null>; area?: boolean; step?: boolean; invert?: boolean; refs?: Array<{ v: number; label: string }>; cls?: string }) {
  const vals = ys.filter((y): y is number => y !== null);
  const lo = invert ? Math.min(...vals) : 0;
  const hi = Math.max(1, ...vals, ...(refs ?? []).map((r) => r.v));
  const n = ys.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => (invert ? ((v - lo) / Math.max(1, hi - lo)) * H : H - (v / hi) * H);
  const pts: string[] = [];
  ys.forEach((v, i) => {
    if (v === null) return;
    if (step && pts.length) pts.push(`${x(i)},${pts[pts.length - 1]!.split(',')[1]}`);
    pts.push(`${x(i)},${y(v)}`);
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="lab-svg">
      {(refs ?? []).filter((r) => r.v <= hi).map((r) => (
        <g key={r.label}><line x1={0} x2={W} y1={y(r.v)} y2={y(r.v)} className="lab-ref" vectorEffect="non-scaling-stroke" /><text x={W - 2} y={y(r.v) - 3} className="lab-reft" textAnchor="end">{r.label}</text></g>
      ))}
      {area && pts.length > 1 && <polygon points={`${pts[0]!.split(',')[0]},${H} ${pts.join(' ')} ${pts[pts.length - 1]!.split(',')[0]},${H}`} className={`lab-area ${cls}`} />}
      <polyline points={pts.join(' ')} className={`lab-line ${cls}`} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function BarsSvg({ stacks, classes }: { stacks: number[][]; classes: string[] }) {
  const max = Math.max(1, ...stacks.map((s) => s.reduce((a, b) => a + b, 0)));
  const n = stacks.length;
  const bw = W / Math.max(1, n);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="lab-svg">
      {stacks.map((s, i) => {
        let top = H;
        return s.map((v, k) => {
          const h = (v / max) * H;
          top -= h;
          return <rect key={`${i}-${k}`} x={i * bw + bw * 0.12} y={top} width={bw * 0.76} height={h} className={classes[k]} />;
        });
      })}
    </svg>
  );
}

function Scatter({ pts }: { pts: Array<[number, number]> }) {
  const mx = Math.max(1, ...pts.map((p) => p[0]));
  const my = Math.max(1, ...pts.map((p) => p[1]));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="lab-svg">
      {pts.map(([a, b], i) => <circle key={i} cx={(a / mx) * (W - 8) + 4} cy={H - (b / my) * (H - 8) - 4} r={3.5} className="lab-dot" />)}
    </svg>
  );
}

function Donut({ parts }: { parts: Array<{ v: number; cls: string; label: string }> }) {
  const total = Math.max(1, parts.reduce((a, p) => a + p.v, 0));
  let a0 = -Math.PI / 2;
  const R = 46;
  const arcs = parts.map((p) => {
    const a1 = a0 + (p.v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = `M ${60 + R * Math.cos(a0)} ${60 + R * Math.sin(a0)} A ${R} ${R} 0 ${large} 1 ${60 + R * Math.cos(a1)} ${60 + R * Math.sin(a1)}`;
    a0 = a1;
    return { d, ...p };
  });
  return (
    <div className="lab-donut">
      <svg viewBox="0 0 120 120" width="120" height="120">{arcs.map((a) => a.v > 0 && <path key={a.label} d={a.d} className={`lab-arc ${a.cls}`} />)}</svg>
      <ul>{parts.map((p) => <li key={p.label}><i className={p.cls} />{p.label}<b>{Math.round((p.v / total) * 100)}%</b></li>)}</ul>
    </div>
  );
}

function Tile({ n, title, shows, children }: { n: number; title: string; shows: string; children: React.ReactNode }) {
  return (
    <Card title={`${n}. ${title}`}>
      <div className="lab-tile">{children}<p className="pf-note">{shows}</p></div>
    </Card>
  );
}

/* --- the ten ------------------------------------------------------------------------------------------------------- */

export function ChartLab({ s, pool }: { s: S2State; pool: number | null }) {
  const rows = useMemo(() => allWeeks(s.s1, s.weeks).filter((r) => r.split.week.pointsStatus === 'CONFIRMED'), [s.s1, s.weeks]);
  const l1 = rows.filter((r) => r.season === 'L1');
  const traded = rows.filter((r) => r.split.dollarsPerPoint !== null);
  const venue = useMemo(() => venueVolumeByWeek(s.weeks, s.venueDaily), [s.weeks, s.venueDaily]);
  if (!rows.length) return null;
  let cum = 0;
  const cumulative = rows.map((r) => (cum += r.split.week.points));
  const sum = (f: (r: AnyWeek) => number) => rows.reduce((a, r) => a + f(r), 0);
  return (
    <section className="sdx-section lab" aria-label="Chart lab (localhost only)">
      <h2 className="sdx-section__title">Chart lab · localhost only, not on the live site</h2>
      <div className="lab-grid">
        <Tile n={1} title="Points over the season" shows="Cumulative points, week by week (Season 1 and Layer 1), with SoDEX's tier lines. Shows how far the next tier is in weeks of your pace.">
          <Line ys={cumulative} area refs={TIERS.filter((t) => t.at >= 1000).map((t) => ({ v: t.at, label: t.name }))} />
        </Tile>
        <Tile n={2} title="Rank by week" shows="Your weekly rank (higher on the chart = better). Shows whether you are gaining on the field or falling back.">
          <Line ys={rows.map((r) => (r.split.week.rank > 0 ? r.split.week.rank : null))} invert />
        </Tile>
        <Tile n={3} title="Where your points come from" shows="All your points split into trading, referrals and squad boost. Shows which lever matters most for you.">
          <Donut parts={[{ v: sum((r) => r.split.own), cls: 'is-own', label: 'Trading' }, { v: sum((r) => r.split.referral), cls: 'is-ref', label: 'Referrals' }, { v: sum((r) => r.split.boost), cls: 'is-boost', label: 'Squad boost' }]} />
        </Tile>
        <Tile n={4} title="Volume vs points" shows="Each dot is one week you traded: volume across, trading points up. The curve flattening is the diminishing return of big weeks.">
          <Scatter pts={traded.map((r) => [r.split.volume, r.split.own])} />
        </Tile>
        <Tile n={5} title="Spot and futures volume" shows="Your weekly volume split into spot (on top) and futures. Spot counted ~1.85x per dollar in our Season 1 fit.">
          <BarsSvg stacks={rows.map((r) => [r.split.week.futuresVolume || 0, r.split.week.spotVolume || 0])} classes={['lab-r is-own', 'lab-r is-boost']} />
        </Tile>
        <Tile n={6} title="Squad boost by week" shows="Your total squad boost each Layer 1 week (a step line). Shows when your squads gained or lost a step - and the early-bird drop after week 4.">
          <Line ys={l1.map((r) => r.split.week.totalBonusPct ?? 0)} step cls="is-b" />
        </Tile>
        <Tile n={7} title="Referral points by week" shows="Points your invitees earned you each week (25% of theirs). Shows whether your referral income is growing.">
          <BarsSvg stacks={rows.map((r) => [r.split.referral])} classes={['lab-r is-ref']} />
        </Tile>
        <Tile n={8} title="Your share of the pool" shows={`Your points as a share of the weekly pool (${pool ? fmt(pool, 0) : '—'}), Layer 1. Shows your slice of the season, independent of how big the pool is.`}>
          <Line ys={l1.map((r) => (pool ? (r.split.week.points / pool) * 100 : null))} area />
        </Tile>
        <Tile n={9} title="Platform difficulty trend" shows="The venue's volume per point of the pool, each Layer 1 week (whole venue). Rising = points get harder to earn for everyone.">
          <Line ys={l1.map((r) => { const v = venue.get(r.split.week.weekNo); return v && pool ? v / pool : null; })} cls="is-c" />
        </Tile>
        <Tile n={10} title="Points per $1K traded" shows="Trading points per $1,000 of your volume, each week you traded. Higher is better; compare it across weeks of different size.">
          <BarsSvg stacks={traded.map((r) => [(r.split.own / r.split.volume) * 1000])} classes={['lab-r is-own']} />
        </Tile>
      </div>
      <p className="pf-note">Latest figures: {rows.length} scored weeks · biggest week {usd(Math.max(...rows.map((r) => r.split.volume)))} volume · {splitWeek(rows.at(-1)!.split.week).week.weekName} last.</p>
    </section>
  );
}
