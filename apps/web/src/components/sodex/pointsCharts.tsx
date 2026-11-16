/**
 * SoPoints charts (owner 2026-11-16): one frame for all of them - a Y axis, gridlines, a hover tooltip, bars or lines -
 * and the page's own controls: the chart's view is the dropdown in the title (RangePicker), the timeframe is the switch
 * (ViewSeg), as on the portfolio page. Charts: points by week (points / share in % / referrals), difficulty (line by
 * default), points over the season (tier bands behind), rank by week, and where the points come from.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Card } from '../portfolio/parts';
import { RangePicker, ViewSeg } from '../portfolio/RangePicker';
import { DASH, fmt } from '../../format';
import { TIERS } from '../../points';
import { SkelRows } from './parts';
import { allWeeks, difficultyRows, mmByWeek, venueOiByWeek, venueVolumeByWeek, type AnyWeek, type DifficultyRow, type S2State } from './soPointsV2';
import '../PlatformSelect.css';
import '../portfolio/PortfolioPage.css';

const usd = (n: number) => (n >= 1e6 ? `$${fmt(n / 1e6, 1)}M` : n >= 1e4 ? `$${fmt(n / 1e3, 0)}K` : n >= 10 ? `$${fmt(n, 0)}` : `$${fmt(n, 2)}`);
const num = (n: number) => (n >= 1e6 ? `${fmt(n / 1e6, 1)}M` : n >= 1e4 ? `${fmt(n / 1e3, 0)}K` : fmt(n, 0));
const H = 200;

type Span = 'w4' | 'w12' | 'all';
const SPANS: ReadonlyArray<readonly [Span, string]> = [['w4', '4w'], ['w12', '12w'], ['all', 'All']];
const cut = <T,>(rows: T[], span: Span) => (span === 'w4' ? rows.slice(-4) : span === 'w12' ? rows.slice(-12) : rows);

/** "Nice" Y-axis steps up to `max`. */
function ticks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

export interface Series { key: string; cls: string; value: (i: number) => number | null }

/**
 * The frame. `kind` bar: stacked series per column; line: one polyline per series. `top` is the axis top (the last
 * tick); `y` maps a value to 0..1 of the height (linear unless given). Bands paint the background between values.
 */
function Frame({ n, labels, series, kind, top, yTicks, yLabel, tip, mark, bands, y }: {
  n: number;
  labels: string[];
  series: Series[];
  kind: 'bar' | 'line';
  top: number;
  yTicks: number[];
  yLabel: (v: number) => string;
  tip: (i: number) => ReactNode;
  mark?: { index: number; label: string } | null;
  bands?: Array<{ from: number; to: number; cls: string; label: string }>;
  y?: (v: number) => number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const yy = y ?? ((v: number) => Math.max(0, Math.min(1, v / (top || 1))));
  const xc = (i: number) => ((i + 0.5) / n) * 100;
  return (
    <div className="spc">
      <div className="spc__y" aria-hidden="true">
        {yTicks.map((t) => <span key={t} style={{ bottom: `${yy(t) * 100}%` }}>{yLabel(t)}</span>)}
      </div>
      <div className="spc__plot" style={{ height: H }} onMouseLeave={() => setHover(null)}>
        {bands?.map((b) => (
          <div key={b.label} className={`spc__band ${b.cls}${(yy(b.to) - yy(b.from)) * H < 16 ? ' is-thin' : ''}`} style={{ bottom: `${yy(b.from) * 100}%`, height: `${(yy(b.to) - yy(b.from)) * 100}%` }}><em>{b.label}</em></div>
        ))}
        {yTicks.map((t) => <i key={t} className="spc__grid" style={{ bottom: `${yy(t) * 100}%` }} />)}
        {mark && mark.index > 0 && <i className="spc__mark" style={{ left: `${(mark.index / n) * 100}%` }}><em>{mark.label}</em></i>}
        {kind === 'line' && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="spc__svg" aria-hidden="true">
            {series.map((s) => {
              const pts: string[] = [];
              for (let i = 0; i < n; i++) { const v = s.value(i); if (v !== null) pts.push(`${xc(i)},${100 - yy(v) * 100}`); }
              return <polyline key={s.key} points={pts.join(' ')} className={`spc__line ${s.cls}`} vectorEffect="non-scaling-stroke" />;
            })}
          </svg>
        )}
        <div className="spc__cols">
          {Array.from({ length: n }, (_, i) => (
            <button key={i} type="button" className={`spc__col${hover === i ? ' is-hover' : ''}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={labels[i]}>
              {kind === 'bar' && (
                <span className="spc__stack">
                  {series.map((s) => { const v = s.value(i); return v ? <i key={s.key} className={s.cls} style={{ height: `${yy(v) * 100}%` }} /> : null; }).reverse()}
                </span>
              )}
              {kind === 'line' && hover === i && series.map((s) => { const v = s.value(i); return v === null ? null : <b key={s.key} className={`spc__dot ${s.cls}`} style={{ bottom: `${yy(v) * 100}%` }} />; })}
            </button>
          ))}
        </div>
        {hover !== null && (
          <div className={`spm-tt${(hover + 0.5) / n > 0.6 ? ' is-left' : ''}`} style={{ left: `${xc(hover)}%` }} role="tooltip">{tip(hover)}</div>
        )}
      </div>
      <div className="spc__x"><span>{labels[0]}</span><span>{labels[n - 1]}</span></div>
    </div>
  );
}

const Row = ({ k, v, dot }: { k: string; v: ReactNode; dot?: string }) => (
  <span className="spm-tt__row">{dot && <i className={dot} />}<span>{k}</span><b>{v}</b></span>
);

/* --- points by week ----------------------------------------------------------------------------------------------- */

type PView = 'points' | 'share' | 'refs';
const PVIEWS: ReadonlyArray<readonly [PView, string]> = [['points', 'Points by week'], ['share', 'Points mix by week'], ['refs', 'Referral points by week']];

export function PointsByWeek({ s }: { s: S2State }) {
  const all = useMemo(() => {
    const w = allWeeks(s.s1, s.weeks);
    const first = w.findIndex((r) => r.split.week.points > 0);
    return first < 0 ? w : w.slice(first);
  }, [s.s1, s.weeks]);
  const [view, setView] = useState<PView>('points');
  const [span, setSpan] = useState<Span>('all');
  const rows = cut(all, span);
  const ok = (r: AnyWeek) => r.split.week.pointsStatus === 'CONFIRMED';
  const tot = (r: AnyWeek) => (ok(r) ? r.split.week.points : 0);
  const share = (r: AnyWeek, v: number) => (tot(r) > 0 ? (v / tot(r)) * 100 : 0);
  const series: Series[] = view === 'refs'
    ? [{ key: 'ref', cls: 'is-ref', value: (i) => (ok(rows[i]!) ? rows[i]!.split.referral : null) }]
    : view === 'share'
      ? [
          { key: 'own', cls: 'is-own', value: (i) => share(rows[i]!, rows[i]!.split.own) },
          { key: 'ref', cls: 'is-ref', value: (i) => share(rows[i]!, rows[i]!.split.referral) },
          { key: 'boost', cls: 'is-boost', value: (i) => share(rows[i]!, rows[i]!.split.boost) },
        ]
      : [
          { key: 'own', cls: 'is-own', value: (i) => (ok(rows[i]!) ? rows[i]!.split.own : null) },
          { key: 'ref', cls: 'is-ref', value: (i) => (ok(rows[i]!) ? rows[i]!.split.referral : null) },
          { key: 'boost', cls: 'is-boost', value: (i) => (ok(rows[i]!) ? rows[i]!.split.boost : null) },
        ];
  // Stacked bars: each series' height is its own value; the stack is the sum, so the axis runs to the largest total.
  const max = view === 'share' ? 100 : Math.max(1, ...rows.map((r, i) => series.reduce((t, s) => t + (s.value(i) ?? 0), 0)));
  const yt = ticks(max);
  const l1 = rows.findIndex((r) => r.season === 'L1');
  return (
    <Card
      title={<RangePicker value={view} options={PVIEWS} onChange={setView} label="Chart" align="start" />}
      action={<ViewSeg value={span} options={SPANS} onChange={setSpan} label="Timeframe" />}
    >
      {!all.length ? (s.loading ? <SkelRows rows={1} height={H + 30} /> : <p className="pf-note">No weeks yet.</p>) : (<>
        <span className="spm-legend">{view === 'refs' ? <><i className="is-ref" />Referrals</> : <><i className="is-own" />Trading<i className="is-ref" />Referrals<i className="is-boost" />Squad boost</>}</span>
        <Frame
          n={rows.length}
          labels={rows.map((r) => r.short)}
          kind="bar"
          series={series}
          top={yt.at(-1)!}
          yTicks={yt}
          yLabel={(v) => (view === 'share' ? `${v}%` : num(v))}
          mark={l1 > 0 ? { index: l1, label: 'Layer 1' } : null}
          tip={(i) => {
            const r = rows[i]!;
            const w = r.split.week;
            return (<>
              <b className="spm-tt__h">{r.name}</b>
              {!ok(r) ? <Row k="Status" v="Not scored yet" /> : (<>
                <Row k="Points" v={fmt(w.points, 0)} />
                <Row dot="is-own" k="Trading" v={view === 'share' ? `${fmt(share(r, r.split.own), 0)}%` : fmt(r.split.own, 0)} />
                <Row dot="is-ref" k="Referrals" v={view === 'share' ? `${fmt(share(r, r.split.referral), 0)}%` : fmt(r.split.referral, 0)} />
                {r.season === 'L1' && <Row dot="is-boost" k={`Squad +${w.totalBonusPct ?? 0}%`} v={view === 'share' ? `${fmt(share(r, r.split.boost), 0)}%` : fmt(r.split.boost, 0)} />}
              </>)}
              <Row k="Volume" v={usd(r.split.volume)} />
            </>);
          }}
        />
      </>)}
    </Card>
  );
}

/* --- difficulty --------------------------------------------------------------------------------------------------- */

type DBasis = 'vol' | 'oi';
const DBASES: ReadonlyArray<readonly [DBasis, string]> = [['vol', 'Difficulty by volume'], ['oi', 'Difficulty by open interest']];
type DKind = 'line' | 'bar';
const DKINDS: ReadonlyArray<readonly [DKind, string]> = [['line', 'Line'], ['bar', 'Bars']];

export function DifficultyChart({ s, pool }: { s: S2State; pool: number | null }) {
  const [basis, setBasis] = useState<DBasis>('vol');
  const [kind, setKind] = useState<DKind>('line');
  const [span, setSpan] = useState<Span>('all');
  const mm = useMemo(() => mmByWeek(s.weeks, s.mmDays), [s.weeks, s.mmDays]);
  const all = useMemo(() => difficultyRows(allWeeks(s.s1, s.weeks).filter((r) => r.split.week.pointsStatus === 'CONFIRMED'), venueVolumeByWeek(s.weeks, s.venueDaily), venueOiByWeek(s.weeks, s.venueOiDaily), mm, pool), [s.s1, s.weeks, s.venueDaily, s.venueOiDaily, mm, pool]);
  const rows = cut(all, span);
  const you = (r: DifficultyRow) => (basis === 'vol' ? r.youVol : r.youOi);
  const plat = (r: DifficultyRow) => (basis === 'vol' ? r.platVol : r.platOi);
  const last = [...rows].reverse().find((r) => you(r) !== null && (plat(r) ?? 0) > 0) ?? null;
  const score = last ? you(last)! / plat(last)! : null;
  const max = Math.max(1, ...rows.flatMap((r) => [you(r), plat(r)]).filter((x): x is number => x !== null));
  const yt = ticks(max);
  return (
    <Card
      title={<RangePicker value={basis} options={DBASES} onChange={setBasis} label="Chart" align="start" />}
      action={<span className="spc__acts"><ViewSeg value={kind} options={DKINDS} onChange={setKind} label="Chart type" /><ViewSeg value={span} options={SPANS} onChange={setSpan} label="Timeframe" /></span>}
    >
      {!all.length ? (s.loading ? <SkelRows rows={1} height={H + 30} /> : <p className="pf-note">{DASH}</p>) : (<>
        <div className="spc__head">
          <span>You <b>{last && you(last) !== null ? usd(you(last)!) : DASH}</b></span>
          <span>Platform <b>{last && plat(last) !== null ? usd(plat(last)!) : DASH}</b></span>
          <span>Score <b className={score === null ? '' : score <= 1 ? 'is-pos' : 'is-neg'}>{score === null ? DASH : `${fmt(score, 2)}×`}</b></span>
          <span className="spm-legend"><i className="is-own" />You<i className="is-field" />Platform</span>
        </div>
        <Frame
          n={rows.length}
          labels={rows.map((r) => r.short)}
          kind={kind}
          mark={(() => { const k = rows.findIndex((r) => r.season === 'L1'); return k > 0 ? { index: k, label: 'Layer 1' } : null; })()}
          series={[
            { key: 'you', cls: 'is-own', value: (i) => you(rows[i]!) },
            { key: 'plat', cls: 'is-field', value: (i) => plat(rows[i]!) },
          ]}
          top={yt.at(-1)!}
          yTicks={yt}
          yLabel={(v) => usd(v)}
          tip={(i) => {
            const r = rows[i]!;
            return (<>
              <b className="spm-tt__h">{r.name}</b>
              <Row dot="is-own" k="You, by volume" v={r.youVol ? usd(r.youVol) : '—'} />
              <Row dot="is-own" k="You, by open interest" v={r.youOi ? usd(r.youOi) : '—'} />
              <Row dot="is-field" k="Platform, by volume" v={r.platVol ? usd(r.platVol) : '—'} />
              <Row dot="is-field" k="Platform, by open interest" v={r.platOi ? usd(r.platOi) : '—'} />
              {r.season === 'L1' ? <Row k="Big accounts" v={`${r.oiOut ? 'internal pair OI out' : 'OI in'} · ${r.volOut ? '1002/23342 volume out' : 'volume in'}`} /> : <Row k="Platform" v="Season 1 pool not published" />}
            </>);
          }}
        />
      </>)}
    </Card>
  );
}

/* --- points over the season: tier bands behind -------------------------------------------------------------------- */

const TIER_BAND: Record<string, string> = { Iron: 'is-iron', Bronze: 'is-bronze', Silver: 'is-silver', Gold: 'is-gold', Diamond: 'is-diamond', Epic: 'is-epic' };

export function SeasonPoints({ s }: { s: S2State }) {
  const all = useMemo(() => allWeeks(s.s1, s.weeks).filter((r) => r.split.week.pointsStatus === 'CONFIRMED'), [s.s1, s.weeks]);
  const [span, setSpan] = useState<Span>('all');
  const cum = useMemo(() => { let t = 0; return all.map((r) => (t += r.split.week.points)); }, [all]);
  const from = span === 'w4' ? Math.max(0, all.length - 4) : span === 'w12' ? Math.max(0, all.length - 12) : 0;
  const rows = all.slice(from);
  const ys = cum.slice(from);
  const max = Math.max(1, ...ys);
  const yt = ticks(max);
  const top = yt.at(-1)!;
  const bands = TIERS.map((t, i) => ({ from: t.at, to: Math.min(top, TIERS[i + 1]?.at ?? top), cls: TIER_BAND[t.name] ?? '', label: t.name }))
    .filter((b) => b.from < top && b.to > b.from);
  return (
    <Card title="Points over the season" action={<ViewSeg value={span} options={SPANS} onChange={setSpan} label="Timeframe" />}>
      {!all.length ? (s.loading ? <SkelRows rows={1} height={H + 30} /> : <p className="pf-note">No weeks yet.</p>) : (
        <Frame
          n={rows.length}
          labels={rows.map((r) => r.short)}
          kind="line"
          series={[{ key: 'cum', cls: 'is-own', value: (i) => ys[i]! }]}
          top={top}
          yTicks={yt}
          yLabel={num}
          bands={bands}
          tip={(i) => (<>
            <b className="spm-tt__h">{rows[i]!.name}</b>
            <Row k="Points so far" v={fmt(ys[i]!, 0)} />
            <Row k="That week" v={`+${fmt(rows[i]!.split.week.points, 0)}`} />
          </>)}
        />
      )}
    </Card>
  );
}

/* --- rank by week (log scale, 1 at the top) ----------------------------------------------------------------------- */

export function RankByWeek({ s }: { s: S2State }) {
  const all = useMemo(() => allWeeks(s.s1, s.weeks).filter((r) => r.split.week.rank > 0), [s.s1, s.weeks]);
  const [span, setSpan] = useState<Span>('all');
  const rows = cut(all, span);
  const worst = Math.max(10, ...rows.map((r) => r.split.week.rank));
  const decades = Math.ceil(Math.log10(worst));
  const yt = Array.from({ length: decades + 1 }, (_, k) => 10 ** k);
  // Rank 1 at the top, the worst decade at the bottom: y = 1 - log10(rank) / decades.
  const y = (v: number) => 1 - Math.log10(Math.max(1, v)) / decades;
  return (
    <Card title="Rank by week" action={<ViewSeg value={span} options={SPANS} onChange={setSpan} label="Timeframe" />}>
      {!all.length ? (s.loading ? <SkelRows rows={1} height={H + 30} /> : <p className="pf-note">No ranked weeks yet.</p>) : (
        <Frame
          n={rows.length}
          labels={rows.map((r) => r.short)}
          kind="line"
          series={[{ key: 'rank', cls: 'is-own', value: (i) => rows[i]!.split.week.rank }]}
          top={yt.at(-1)!}
          yTicks={yt}
          yLabel={(v) => `#${num(v)}`}
          y={y}
          tip={(i) => (<>
            <b className="spm-tt__h">{rows[i]!.name}</b>
            <Row k="Rank" v={`#${fmt(rows[i]!.split.week.rank, 0)}`} />
            {rows[i]!.split.week.totalUser ? <Row k="Of" v={fmt(rows[i]!.split.week.totalUser, 0)} /> : null}
          </>)}
        />
      )}
    </Card>
  );
}

/* --- where the points come from ----------------------------------------------------------------------------------- */

type MixSpan = 's1' | 'l1' | 'all';
const MIX_SPANS: ReadonlyArray<readonly [MixSpan, string]> = [['s1', 'Season 1'], ['l1', 'Layer 1'], ['all', 'All']];

export function PointsMix({ s }: { s: S2State }) {
  const [span, setSpan] = useState<MixSpan>('all');
  // Season 1 straight from SoDEX's rows, Closed Alpha included (allWeeks leaves it out of the week charts): without it
  // the total fell short of the balance SoDEX shows. Season 1 had no squad boost.
  const s1 = useMemo(() => {
    let own = 0;
    let ref = 0;
    for (const w of s.s1) { if (w.pointsStatus !== 'CONFIRMED') continue; own += Math.max(0, w.points - w.referralPoints); ref += w.referralPoints; }
    return { own, ref, boost: 0, n: s.s1.length };
  }, [s.s1]);
  const l1 = useMemo(() => {
    const rows = allWeeks([], s.weeks).filter((r) => r.split.week.pointsStatus === 'CONFIRMED');
    return { own: rows.reduce((a, r) => a + r.split.own, 0), ref: rows.reduce((a, r) => a + r.split.referral, 0), boost: rows.reduce((a, r) => a + r.split.boost, 0), n: rows.length };
  }, [s.weeks]);
  const pick = span === 's1' ? s1 : span === 'l1' ? l1 : { own: s1.own + l1.own, ref: s1.ref + l1.ref, boost: l1.boost, n: s1.n + l1.n };
  const parts = [
    { v: pick.own, cls: 'is-own', label: 'Trading' },
    { v: pick.ref, cls: 'is-ref', label: 'Referrals' },
    { v: pick.boost, cls: 'is-boost', label: 'Squad boost' },
  ];
  const total = parts.reduce((a, p) => a + p.v, 0);
  const rows = { length: pick.n };
  let a0 = -Math.PI / 2;
  const R = 52;
  const arcs = parts.map((p) => {
    const a1 = a0 + (total ? p.v / total : 0) * Math.PI * 2;
    const d = `M ${70 + R * Math.cos(a0)} ${70 + R * Math.sin(a0)} A ${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${70 + R * Math.cos(a1)} ${70 + R * Math.sin(a1)}`;
    a0 = a1;
    return { ...p, d };
  });
  return (
    <Card title="Where your points come from" action={<ViewSeg value={span} options={MIX_SPANS} onChange={setSpan} label="Season" />}>
      {!rows.length ? (s.loading ? <SkelRows rows={1} height={160} /> : <p className="pf-note">No weeks yet.</p>) : (
        <div className="spc-mix">
          <svg viewBox="0 0 140 140" width="150" height="150" aria-hidden="true">
            {arcs.map((a) => a.v > 0 && <path key={a.label} d={a.d} className={`spc-mix__arc ${a.cls}`} />)}
            <text x="70" y="66" textAnchor="middle" className="spc-mix__big">{num(total)}</text>
            <text x="70" y="84" textAnchor="middle" className="spc-mix__small">points</text>
          </svg>
          <ul>
            {parts.map((p) => (
              <li key={p.label}><i className={p.cls} /><span>{p.label}</span><b>{total ? `${Math.round((p.v / total) * 100)}%` : DASH}</b><small>{num(p.v)}</small></li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
