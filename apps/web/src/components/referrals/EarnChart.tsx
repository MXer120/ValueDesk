/**
 * Rewards over time - USDC rebates from SoDEX and ValueDesk fee credits as two step lines on one scale, both values under
 * the pointer - and SoPoints by week as bars.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { LinePoint } from '../../invites/sodexRewards';
import type { AnyWeek } from '../sodex/soPointsV2';
import { DAY_MS, scoredWeeks, valueAt } from './calendar';
import { credit, day, whole } from './parts';

const W = 600;
const H = 200;

/** Where the pointer is, as a share of the width. */
const shareOf = (e: React.PointerEvent<HTMLElement>): number => {
  const r = e.currentTarget.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
};
const path = (line: readonly LinePoint[], X: (t: number) => number, Y: (v: number) => number, t1: number): string =>
  line.length ? `M0 ${Y(0)}` + line.map((p) => `H${X(p.t)}V${Y(p.v)}`).join('') + `H${X(t1)}` : '';

export function Empty({ children, steps }: { children: ReactNode; steps?: boolean }) {
  return (
    <div className="rfc is-empty">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"><path d={steps ? 'M0 190V150H70V190M100 190V120H170V190M200 190V140H270V190M300 190V90H370V190M400 190V60H470V190M500 190V30H570V190' : 'M0 178H110V160H210V142H330V104H430V72H520V38H600'} /></svg>
      <p>{children}</p>
    </div>
  );
}

/** `usdc` null: not signed in to SoDEX - only the credits are drawn, and nothing is said of USDC. */
export function RewardsChart({ usdc, credits, now }: { usdc: LinePoint[] | null; credits: LinePoint[]; now: number }) {
  const id = useId();
  const [at, setAt] = useState<number | null>(null);
  const g = useMemo(() => {
    const times = [...new Set([...(usdc ?? []).map((p) => p.t), ...credits.map((p) => p.t)])].sort((a, b) => a - b);
    const top = Math.max(0, ...(usdc ?? []).map((p) => p.v), ...credits.map((p) => p.v));
    if (!times.length || top <= 0) return null;
    // A little before the first one, so the line starts at 0.
    const first = Math.min(times[0]!, now - DAY_MS);
    const t0 = first - (now - first) * 0.04;
    const X = (t: number) => ((t - t0) / Math.max(1, now - t0)) * W;
    const Y = (v: number) => H - 4 - (v / top) * (H - 22);
    return { times: [t0, ...times, ...(times[times.length - 1] === now ? [] : [now])], t0, X, Y, c: path(credits, X, Y, now), u: usdc ? path(usdc, X, Y, now) : '' };
  }, [usdc, credits, now]);
  if (!g) return <Empty>Your rewards draw here from your first referral.</Empty>;
  const read = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = g.t0 + shareOf(e) * (now - g.t0);
    setAt(g.times.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), g.times[0]!));
  };
  const uv = at === null || !usdc ? null : valueAt(usdc, at);
  const cv = at === null ? null : valueAt(credits, at);
  const left = at === null ? 0 : (g.X(at) / W) * 100;
  return (
    <div className="rfc" role="img" aria-label="Rewards over time" onPointerDown={read} onPointerMove={read} onPointerLeave={() => setAt(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--pos)" stopOpacity="0.24" /><stop offset="1" stopColor="var(--pos)" stopOpacity="0" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map((k) => <path key={k} className="rfc__g" d={`M0 ${H * k}H${W}`} />)}
        {g.c && <path d={`${g.c}V${H}H0Z`} fill={`url(#${id})`} />}
        {g.c && <path className="rfc__l is-credit" d={g.c} />}
        {g.u && <path className="rfc__l is-usdc" d={g.u} />}
      </svg>
      {at !== null && <span className="rfc__x" style={{ left: `${left}%` }} />}
      {at !== null && cv !== null && <span className="rfc__d is-credit" style={{ left: `${left}%`, top: `calc((100% - 24px) * ${g.Y(cv) / H})` }} />}
      {at !== null && uv !== null && <span className="rfc__d is-usdc" style={{ left: `${left}%`, top: `calc((100% - 24px) * ${g.Y(uv) / H})` }} />}
      {at !== null && cv !== null && (
        <span className="rfc__tip" style={{ left: `clamp(86px, ${left}%, calc(100% - 86px))` }}>
          <small>{day(at)}</small>
          {uv !== null && <span className="is-usdc"><i />USDC<b>{credit(uv)}</b></span>}
          <span className="is-credit"><i />Fee credits<b>{credit(cv)}</b></span>
        </span>
      )}
      <span className="rfc__ax"><i>{day(g.t0)}</i><i>Today</i></span>
    </div>
  );
}

const PARTS = [['referral', 'Invited'], ['own', 'Own'], ['boost', 'Boost']] as const;

/** Every week SoDEX has scored, both seasons: what came from invitees, from the wallet itself and from its squads. */
export function PointsChart({ weeks }: { weeks: readonly AnyWeek[] }) {
  const [at, setAt] = useState<number | null>(null);
  const ws = useMemo(() => scoredWeeks(weeks), [weeks]);
  const top = Math.max(0, ...ws.map((w) => w.split.week.points));
  if (!ws.length || top <= 0) return <Empty steps>Your SoPoints draw here from your first scored week.</Empty>;
  const w = at === null ? null : ws[Math.min(at, ws.length - 1)]!;
  const step = 100 / ws.length;
  // At most eight labels.
  const every = Math.ceil(ws.length / 8);
  const read = (e: React.PointerEvent<HTMLDivElement>) => setAt(Math.min(ws.length - 1, Math.floor(shareOf(e) * ws.length)));
  return (
    <div className="rfc is-bars" role="img" aria-label="SoPoints by week" onPointerDown={read} onPointerMove={read} onPointerLeave={() => setAt(null)}>
      <div className="rfc__bars" aria-hidden="true">
        {ws.map((x, i) => (
          <span key={x.key} className={at === i ? 'is-on' : undefined}>
            <span style={{ height: `${Math.max(1.5, (x.split.week.points / top) * 100)}%` }}>{PARTS.map(([k]) => x.split[k] > 0 && <i key={k} className={`is-${k}`} style={{ flexGrow: x.split[k] }} />)}</span>
          </span>
        ))}
      </div>
      {w && at !== null && (
        <span className="rfc__tip" style={{ left: `clamp(86px, ${step * (at + 0.5)}%, calc(100% - 86px))` }}>
          <small>{w.name}</small>
          <span><i />All<b>{whole(w.split.week.points)}</b></span>
          {PARTS.map(([k, l]) => <span key={k} className={`is-${k}`}><i />{l}<b>{whole(w.split[k])}</b></span>)}
        </span>
      )}
      <span className="rfc__ax is-cells">{ws.map((x, i) => <i key={x.key}>{i % every === 0 ? x.short : ''}</i>)}</span>
    </div>
  );
}
