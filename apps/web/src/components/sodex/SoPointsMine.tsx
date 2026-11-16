/**
 * SoPoints, signed in: the wallet's own part of the page (owner 2026-11-16). The tier card and the season card are
 * SoDEX's own designs (their points page, read from their bundle: per-tier gradient, outline and shadow; total, last
 * week, next tier or MAX LEVEL, "Rank N of all users"; the season card's pool, countdown and the wallet's invite code
 * and link). The squad card shows the wallet's own boost; the charts show every week of both seasons at once; the
 * tips explain how to earn more, simply. Data and arithmetic: soPointsV2.ts.
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Card } from '../portfolio/parts';
import { DASH, fmt } from '../../format';
import { notify } from '../../toast';
import type { BoostConfig, VolumeWeights, WeekInfo } from '../../points';
import { Pill, SegSwitch, SkelRows, useNow } from './parts';
import { allWeeks, difficultyRows, earnTips, forecastWeek, mmByWeek, squadBreakdown, venueOiByWeek, venueVolumeByWeek, type AnyWeek, type DifficultyRow, type S2State, type SquadBreakdown, type Tip } from './soPointsV2';

/* SoDEX's own tier styles, as their points page draws its card (bundle 2026-11-16). */
const TIER_STYLE: Record<string, { bg: string; border: string; shadow: string; bar: string; chip: string }> = {
  Iron: { bg: 'linear-gradient(165deg, #27272A 0%, #18181B 50%, #2D2D2D 100%)', border: '#3F3F46', shadow: 'rgba(0,0,0,0.5)', bar: 'linear-gradient(to right, #52525B, #A1A1AA)', chip: '#A1A1AA' },
  Bronze: { bg: 'linear-gradient(165deg, #9A6754 0%, #795546 50%, #451A03 100%)', border: '#9A6754', shadow: 'rgba(154,103,84,0.4)', bar: 'linear-gradient(90deg, rgba(255,255,255,0.6) 0%, #fff 100%)', chip: '#F9A789' },
  Silver: { bg: 'linear-gradient(165deg, #94A3B8 0%, #475569 50%, #0F172A 100%)', border: '#94A3B8', shadow: 'rgba(148,163,184,0.4)', bar: 'linear-gradient(90deg, rgba(255,255,255,0.6) 0%, #fff 100%)', chip: '#CBD5E1' },
  Gold: { bg: 'linear-gradient(165deg, #E0CB82 0%, #A87024 50%, #5E3C0F 100%)', border: '#DDA700', shadow: 'rgba(221,167,0,0.4)', bar: 'linear-gradient(to right, #DDA700, #FACC15)', chip: '#FACC15' },
  Diamond: { bg: 'linear-gradient(165deg, #818CF8 0%, #4338CA 50%, #1E1B4B 100%)', border: '#818CF8', shadow: 'rgba(129,140,248,0.4)', bar: 'linear-gradient(to right, #818CF8, #A5B4FC)', chip: '#A5B4FC' },
  Epic: { bg: 'linear-gradient(165deg, #1A1A1A 0%, #080808 50%, #000000 100%)', border: 'rgba(255,255,255,0.2)', shadow: 'rgba(0,0,0,0.8)', bar: 'linear-gradient(to right, #6B7280, #FFFFFF, #D1D5DB)', chip: '#FFFFFF' },
};
/** SoDEX's mapping: an unknown tier is Iron (their EV). */
const tierKey = (t: string | null | undefined) => {
  const k = (t ?? '').toLowerCase();
  return Object.keys(TIER_STYLE).find((x) => x.toLowerCase() === k) ?? 'Iron';
};
const usd = (n: number) => (n >= 1e6 ? `$${fmt(n / 1e6, n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `$${fmt(n / 1e3, 0)}K` : n >= 10 ? `$${fmt(n, 0)}` : `$${fmt(n, 2)}`);
/** SoDEX's season card shows a fixed 900,000 (their bundle's constant), not the API's pool field. */
const SODEX_POOL_SHOWN = 900_000;

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    notify('ok', `${what} copied.`);
  } catch {
    notify('warn', 'This browser did not allow copying.');
  }
};

/* --- the tier card (SoDEX's) --------------------------------------------------------------------------------------- */

export function SoPointsCard({ s }: { s: S2State }) {
  if (!s.summary && s.loading) return <div className="spm-card spm-card--skel sdx-skel__row" aria-label="Loading your SoPoints" />;
  const sum = s.summary;
  const tier = tierKey(sum?.currentTier);
  const st = TIER_STYLE[tier]!;
  const epic = tier === 'Epic';
  const iron = tier === 'Iron';
  // SoDEX: max level when there is no next tier, or the tier is Epic; progress = total / next tier's points.
  const max = !sum?.nextTier || epic;
  const total = sum?.totalPoints ?? null;
  const goal = sum?.nextTierPoints ?? 0;
  const pct = max || !total || goal <= 0 ? 100 : Math.max(0, Math.min(100, Math.floor((total / goal) * 10_000) / 100));
  const last = s.weeks.filter((w) => w.pointsStatus === 'CONFIRMED').sort((a, b) => b.weekNo - a.weekNo)[0];
  const share = () => {
    if (total === null) return;
    const text = `I'm ${tier} on SoDEX with ${total.toLocaleString('en-US')} SoPoints${sum?.rank ? `, rank ${sum.rank.toLocaleString('en-US')}` : ''}.`;
    const url = `${location.origin}/points`;
    if (navigator.share) void navigator.share({ text, url }).catch(() => {});
    else void copy(`${text} ${url}`, 'Text');
  };
  return (
    <section className={`spm-card${iron ? ' is-iron' : ''}`} style={{ background: st.bg, outlineColor: st.border, boxShadow: `0 25px 50px -12px ${st.shadow}` }} aria-label="Your SoPoints">
      <div className="spm-card__top">
        <span className="spm-card__tier">{tier.toUpperCase()}</span>
        <button type="button" className="spm-card__share" onClick={share} disabled={total === null}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="12" cy="3.5" r="2" /><circle cx="4" cy="8" r="2" /><circle cx="12" cy="12.5" r="2" /><path d="M5.7 7.1 10.3 4.4M5.7 8.9l4.6 2.7" stroke="currentColor" strokeWidth="1.3" fill="none" /></svg>
          SHARE
        </button>
      </div>
      <div className="spm-card__total">
        <b className={epic ? 'is-epic' : ''}>{total !== null ? total.toLocaleString('en-US') : s.loading ? '…' : DASH}</b>
        <span className="spm-card__chip" style={epic ? { background: 'rgba(38,38,38,0.9)', borderColor: '#404040', color: '#E5E5E5' } : { color: st.chip }}>SOPOINTS</span>
      </div>
      {last && last.points > 0 && <span className={`spm-card__last${iron ? ' is-iron' : ''}`}>Last week <b>+{last.points.toLocaleString('en-US')}</b></span>}
      <div className="spm-card__next">
        <div className={`spm-card__nextrow${iron ? ' is-iron' : ''}`}>
          <span>{max ? 'MAX LEVEL' : `NEXT TIER: ${tierKey(sum?.nextTier).toUpperCase()}`}</span>
          <span className="spm-card__mono">{max ? '—' : goal.toLocaleString('en-US')}</span>
        </div>
        <div className="spm-card__bar" style={epic ? { background: '#111827', borderColor: '#374151' } : undefined}>
          <i style={{ width: `${pct}%`, background: st.bar, boxShadow: epic ? 'none' : '0 0 10px rgba(255,255,255,0.4)' }} />
        </div>
        {sum?.rank ? (
          <span className="spm-card__rank">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 5.5 5.5 8 8 3.5 10.5 8l3-2.5-1.2 6.5H3.7z" /><path d="M3.7 13.5h8.6" /></svg>
            Rank {sum.rank.toLocaleString('en-US')} of all users
          </span>
        ) : null}
      </div>
    </section>
  );
}

/* --- the season card (SoDEX's) ------------------------------------------------------------------------------------ */

export function SeasonCard({ week, code, settled }: { week: WeekInfo | null; code: string | null; settled: boolean }) {
  const now = useNow();
  if (!week && !settled) {
    return (
      <section className="spm-season" aria-label="Loading this week">
        <div className="spm-season__main"><SkelRows rows={1} height={18} /><SkelRows rows={1} height={64} /><SkelRows rows={2} height={16} /></div>
        <div className="spm-season__invite"><SkelRows rows={2} height={40} /></div>
      </section>
    );
  }
  const ends = week ? week.nextWeekStartTime * 1000 : null;
  const left = ends ? Math.max(0, ends - now) : null;
  const two = (n: number) => String(n).padStart(2, '0');
  const parts = left === null ? null : [Math.floor(left / 86_400_000), Math.floor((left % 86_400_000) / 3_600_000), Math.floor((left % 3_600_000) / 60_000), Math.floor((left % 60_000) / 1000)];
  const link = code ? `sodex.com/join/${code}?points=1` : null;
  const at = (ms: number) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const live = week?.weekStatus === 'LIVE';
  return (
    <section className="spm-season" aria-label="This week">
      <div className="spm-season__main">
        <div className="spm-season__live">
          <span className={`spm-season__on${live ? '' : ' is-off'}`}><i />{week ? `Layer1 Season ${week.weekName} is ${live ? 'Live' : 'closed'}` : 'Layer1 Season'}</span>
          <span className="spm-season__split">· Split this week</span>
        </div>
        <b className="spm-season__pool">{SODEX_POOL_SHOWN.toLocaleString('en-US')}</b>
        <span className="spm-season__sub">SoPoints · 20-week season</span>
        <div className="spm-season__snap">
          <span className="spm-season__k2">Next Snapshot</span>
          <span className="spm-season__times">
            {['D', 'H', 'M', 'S'].map((u, i) => (
              <span key={u} className="spm-season__t"><b>{parts ? two(parts[i]!) : '--'}</b>{u}{i < 3 && <em>:</em>}</span>
            ))}
          </span>
        </div>
        {week && <span className="spm-season__when">Snapshot every {at(week.nextWeekStartTime * 1000)} · distribution every {at(week.distributionTime * 1000)} (your time)</span>}
      </div>
      <div className="spm-season__invite">
        <div>
          <span className="spm-season__k">Invite code</span>
          <div className="spm-season__row"><b>{code ?? (settled ? DASH : '…')}</b>{code && <CopyBtn onClick={() => void copy(code, 'Invite code')} label="Copy invite code" />}</div>
        </div>
        <div>
          <span className="spm-season__k">Invite link</span>
          <div className="spm-season__row"><b className="is-link">{link ?? DASH}</b>{link && <CopyBtn onClick={() => void copy(`https://${link}`, 'Invite link')} label="Copy invite link" />}</div>
        </div>
      </div>
    </section>
  );
}

const CopyBtn = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" className="spm-copy" onClick={onClick} aria-label={label} title={label}>
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" /></svg>
  </button>
);

/* --- the wallet's squad boost: one track per squad ----------------------------------------------------------------- */

export function MySquadBoost({ s, cfg }: { s: S2State; cfg: BoostConfig | null }) {
  const live = s.weeks.find((w) => w.isLive) ?? null;
  const q: SquadBreakdown | null = s.bonus && cfg ? squadBreakdown(s.bonus, cfg, live) : null;
  const steps = cfg ? [...cfg.tiers].sort((a, b) => Number(a.threshold) - Number(b.threshold)) : [];
  return (
    <Card title="Your squad boost" action={q ? <span className="spm-sq__total">+{q.total}%</span> : undefined}>
      {!q || !cfg ? (s.loading ? <SkelRows rows={3} height={56} /> : <p className="pf-note">{DASH}</p>) : (
        <div className="spm-sq">
          <p className="spm-sq__sum">
            Squad you joined <b>+{q.joined.pct}%</b> <i>+</i> squad you built <b>+{q.built.pct}%</b>
          </p>
          <SquadTrack label="Squad you joined" pct={q.joined.pct} volume={q.joined.volume} steps={steps} next={q.joined.next} meta={q.joined.volume > 0 ? `${usd(q.joined.volume)} in the last ${cfg.windowRounds} weeks` : 'You joined no squad'} />
          <SquadTrack label="Squad you built" pct={q.built.pct} volume={q.built.volume} steps={steps} next={q.built.next} meta={`${usd(q.built.volume)} in the last ${cfg.windowRounds} weeks · ${q.built.members} members, ${q.built.active} active`} />
        </div>
      )}
    </Card>
  );
}

/** One squad: its +% and a track over SoDEX's five steps (equal spacing; the fill runs inside the step it is in). */
function SquadTrack({ label, pct, volume, steps, next, meta }: {
  label: string; pct: number; volume: number; steps: Array<{ threshold: string; bonusPct: number }>;
  next: { threshold: number; pct: number; missing: number } | null; meta: string;
}) {
  const t = steps.map((x) => Number(x.threshold));
  let reached = 0;
  for (const x of t) if (volume >= x) reached += 1;
  const lo = reached === 0 ? 0 : t[reached - 1]!;
  const hi = t[reached] ?? lo;
  const inside = reached >= t.length ? 0 : (volume - lo) / Math.max(1, hi - lo);
  const fill = Math.min(100, ((reached + Math.max(0, Math.min(1, inside))) / t.length) * 100);
  return (
    <div className="spm-sq__row">
      <div className="spm-sq__head">
        <span className="spm-sq__label">{label}</span>
        <b className={pct ? 'is-on' : ''}>{pct ? `+${pct}%` : '0%'}</b>
        <span className="spm-sq__next">{next ? <>{usd(next.missing)} more to <b>+{next.pct}%</b></> : 'Top step reached'}</span>
      </div>
      <div className="spm-sq__track" role="img" aria-label={`${label}: ${usd(volume)}, ${pct ? `+${pct}%` : 'no boost'}`}>
        <i className="spm-sq__fill" style={{ width: `${fill}%` }} />
        {steps.map((x, i) => (
          <span key={x.threshold} className={`spm-sq__step${i < reached ? ' is-on' : ''}`} style={{ left: `${((i + 1) / steps.length) * 100}%` }}>
            <em>+{x.bonusPct}%</em><small>{usd(Number(x.threshold))}</small>
          </span>
        ))}
      </div>
      <span className="spm-sq__meta">{meta}</span>
    </div>
  );
}

/* --- a bar chart frame with a hover tooltip ------------------------------------------------------------------------ */

function Bars<T extends { key: string }>({ rows, render, tip, axis, mark, height = 200, under }: {
  rows: T[];
  render: (r: T) => ReactNode;
  tip: (r: T) => ReactNode;
  axis: [string, string];
  mark?: { index: number; label: string } | null;
  height?: number;
  /** Drawn under the columns (area and line charts); the columns then only carry the hover. */
  under?: ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const left = hover === null ? 0 : ((hover + 0.5) / rows.length) * 100;
  return (
    <div className="spm-bars">
      <div className="spm-bars__plot" style={{ height }} onMouseLeave={() => setHover(null)}>
        {under && <div className="spm-bars__under" aria-hidden="true">{under}</div>}
        {rows.map((r, i) => (
          <button key={r.key} type="button" className={`spm-col${hover === i ? ' is-hover' : ''}${mark && i === mark.index && i > 0 ? ' is-season' : ''}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
            <span className="spm-col__stack">{render(r)}</span>
          </button>
        ))}
        {hover !== null && rows[hover] && (
          <div className={`spm-tt${left > 60 ? ' is-left' : ''}`} style={{ left: `${left}%` }} role="tooltip">{tip(rows[hover]!)}</div>
        )}
      </div>
      <div className="spm-bars__axis">
        <span>{axis[0]}</span>
        {mark && mark.index > 0 && <span className="spm-bars__mark" style={{ left: `${(mark.index / rows.length) * 100}%` }}>{mark.label}</span>}
        <span>{axis[1]}</span>
      </div>
    </div>
  );
}

const TipRow = ({ k, v, dot }: { k: string; v: ReactNode; dot?: string }) => (
  <span className="spm-tt__row">{dot && <i className={dot} />}<span>{k}</span><b>{v}</b></span>
);

/* --- points by week, every week of both seasons ------------------------------------------------------------------ */

type WeekChartKind = 'bar' | 'area' | 'line';

/** Stacked areas or a total line over the weeks, in a 0-100 box stretched to the plot. */
function WeekLines({ rows, max, kind }: { rows: AnyWeek[]; max: number; kind: 'area' | 'line' }) {
  const n = rows.length;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (v: number) => 100 - (v / max) * 100;
  const scored = (r: AnyWeek) => r.split.week.pointsStatus === 'CONFIRMED';
  if (kind === 'line') {
    const pts = rows.map((r, i) => (scored(r) ? `${x(i)},${y(r.split.week.points)}` : null)).filter(Boolean).join(' ');
    return (
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="spm-lines">
        <polyline points={pts} className="is-total" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  // Stacked: trading at the bottom, referrals on it, the squad boost on top.
  const layers: Array<[string, (r: AnyWeek) => number]> = [
    ['is-own', (r) => r.split.own],
    ['is-ref', (r) => r.split.own + r.split.referral],
    ['is-boost', (r) => r.split.own + r.split.referral + r.split.boost],
  ];
  const band = (top: (r: AnyWeek) => number, base: (r: AnyWeek) => number) => {
    const up = rows.map((r, i) => `${x(i)},${y(scored(r) ? top(r) : 0)}`);
    const down = rows.map((r, i) => `${x(i)},${y(scored(r) ? base(r) : 0)}`).reverse();
    return [...up, ...down].join(' ');
  };
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="spm-lines">
      {layers.map(([cls, top], k) => (
        <polygon key={cls} className={cls} points={band(top, k === 0 ? () => 0 : layers[k - 1]![1])} />
      ))}
    </svg>
  );
}

export function WeeklyPoints({ s }: { s: S2State }) {
  const all = useMemo(() => allWeeks(s.s1, s.weeks), [s.s1, s.weeks]);
  // From the first week with points (or Layer 1's start): weeks before a wallet's first trade are only empty space.
  const rows = useMemo(() => {
    const first = all.findIndex((r) => r.split.week.points > 0);
    const l1 = all.findIndex((r) => r.season === 'L1');
    const from = first < 0 ? Math.max(0, l1) : l1 < 0 ? first : Math.min(first, l1);
    return all.slice(from);
  }, [all]);
  const [kind, setKind] = useState<WeekChartKind>('bar');
  const max = Math.max(1, ...rows.map((r) => r.split.week.points));
  const h = (v: number) => `${(v / max) * 100}%`;
  const firstL1 = rows.findIndex((r) => r.season === 'L1');
  const scored = rows.filter((r) => r.split.week.pointsStatus === 'CONFIRMED');
  const l1 = scored.filter((r) => r.season === 'L1');
  const best = scored.reduce<AnyWeek | null>((b, r) => (!b || r.split.week.points > b.split.week.points ? r : b), null);
  const l1Total = l1.reduce((t, r) => t + r.split.week.points, 0);
  return (
    <Card title="Points by week" action={<SegSwitch<WeekChartKind> label="Chart" value={kind} onChange={setKind} options={[{ v: 'bar', label: 'Bars' }, { v: 'area', label: 'Area' }, { v: 'line', label: 'Line' }]} />}>
      {!rows.length ? (s.loading ? <SkelRows rows={1} height={220} /> : <p className="pf-note">No weeks yet.</p>) : (
        <div className="spm-diff">
          <div className="spm-diff__head">
            <div><span>Layer 1 so far</span><b>{fmt(l1Total, 0)}</b><small>{l1.length} scored weeks</small></div>
            <div><span>Best week</span><b>{best ? fmt(best.split.week.points, 0) : DASH}</b><small>{best?.name ?? ''}</small></div>
            <div><span>Average, Layer 1</span><b>{l1.length ? fmt(l1Total / l1.length, 0) : DASH}</b><small>points a week</small></div>
          </div>
          {kind === 'line'
            ? <span className="spm-legend"><i className="is-own" />Points</span>
            : <span className="spm-legend"><i className="is-own" />Trading<i className="is-ref" />Referrals<i className="is-boost" />Squad boost</span>}
          <Bars
            rows={rows}
            height={160}
            axis={[rows[0]!.short, rows.at(-1)!.short]}
            mark={firstL1 > 0 ? { index: firstL1, label: 'Layer 1' } : null}
            under={kind === 'bar' ? undefined : <WeekLines rows={rows} max={max} kind={kind} />}
            render={(r) => kind !== 'bar' ? null : r.split.week.pointsStatus !== 'CONFIRMED' ? <i className="spm-col__tbd" /> : (<>
              <i className="is-boost" style={{ height: h(r.split.boost) }} />
              <i className="is-ref" style={{ height: h(r.split.referral) }} />
              <i className="is-own" style={{ height: h(r.split.own) }} />
            </>)}
            tip={(r) => {
              const w = r.split.week;
              return (<>
                <b className="spm-tt__h">{r.name}</b>
                {w.pointsStatus !== 'CONFIRMED' ? <TipRow k="Status" v="Not scored yet" /> : (<>
                  <TipRow k="Points" v={fmt(w.points, 0)} />
                  <TipRow dot="is-own" k="Trading" v={fmt(r.split.own, 0)} />
                  <TipRow dot="is-ref" k="Referrals" v={fmt(r.split.referral, 0)} />
                  {r.season === 'L1' && <TipRow dot="is-boost" k={`Squad +${w.totalBonusPct ?? 0}%`} v={fmt(r.split.boost, 0)} />}
                </>)}
                <TipRow k="Volume" v={usd(r.split.volume)} />
                {w.rank ? <TipRow k="Rank" v={fmt(w.rank, 0)} /> : null}
              </>);
            }}
          />
        </div>
      )}
    </Card>
  );
}

/* --- this week so far: the forecast -------------------------------------------------------------------------------- */

export function ThisWeek({ s, week }: { s: S2State; week: WeekInfo | null }) {
  const f = useMemo(() => forecastWeek(s.weeks), [s.weeks]);
  const now = useNow(60_000);
  const left = week ? Math.max(0, week.nextWeekStartTime * 1000 - now) : null;
  const leftTxt = left === null ? DASH : `${Math.floor(left / 86_400_000)}d ${Math.floor((left % 86_400_000) / 3_600_000)}h`;
  return (
    <Card title="This week so far" className="spm-soon">
      <div className="spm-soon__veil" aria-hidden="true">
      {!f ? (s.loading ? <SkelRows rows={3} height={48} /> : <p className="pf-note">{DASH}</p>) : (
        <div className="spm-tw">
          <div className="spm-tw__big">
            <span>Points from trading so far</span>
            <b>{f.boosted !== null ? `≈ ${fmt(f.boosted, 0)}` : DASH}</b>
            <small>{f.live.weekName} · scored at the snapshot in {leftTxt}</small>
          </div>
          <div className="spm-tw__grid">
            <div><span>Your volume</span><b>{usd(f.volume)}</b></div>
            <div><span>Squad boost</span><b className="is-pos">+{f.live.totalBonusPct ?? 0}%</b></div>
            <div><span>Next $10K adds</span><b>{f.per10k !== null ? `≈ ${fmt(f.per10k, 0)}` : DASH}</b></div>
            <div><span>Your cost per point</span><b>{f.dpp !== null ? usd(f.dpp) : DASH}</b></div>
          </div>
        </div>
      )}
      </div>
      <div className="spm-soon__badge"><b>Coming soon</b><span>This needs more data before its numbers are good enough.</span></div>
    </Card>
  );
}

/* --- difficulty, week by week ------------------------------------------------------------------------------------ */

export function Difficulty({ s, pool }: { s: S2State; pool: number | null }) {
  const mm = useMemo(() => mmByWeek(s.weeks, s.mmDays), [s.weeks, s.mmDays]);
  const [basis, setBasis] = useState<'vol' | 'oi'>('vol');
  const rows = useMemo(
    () => difficultyRows(s.weeks, venueVolumeByWeek(s.weeks, s.venueDaily), venueOiByWeek(s.weeks, s.venueOiDaily), mm, pool).map((r) => ({ ...r, key: `d${r.weekNo}` })),
    [s.weeks, s.venueDaily, s.venueOiDaily, mm, pool],
  );
  const you = (r: DifficultyRow) => (basis === 'vol' ? r.youVol : r.youOi);
  const plat = (r: DifficultyRow) => (basis === 'vol' ? r.platVol : r.platOi);
  const max = Math.max(1, ...rows.flatMap((r) => [you(r), plat(r)]).filter((x): x is number => x !== null));
  const last = [...rows].reverse().find((r) => you(r) !== null && (plat(r) ?? 0) > 0) ?? null;
  const score = last && plat(last)! > 0 ? you(last)! / plat(last)! : null;
  const unit = basis === 'vol' ? 'volume' : 'open interest';
  return (
    <Card
      title="Difficulty"
      action={<SegSwitch<'vol' | 'oi'> label="Difficulty by" value={basis} onChange={setBasis} options={[{ v: 'vol', label: 'Volume' }, { v: 'oi', label: 'Open interest' }]} />}
    >
      {!rows.length ? (s.loading ? <SkelRows rows={1} height={240} /> : <p className="pf-note">{DASH}</p>) : (
        <div className="spm-diff">
          <div className="spm-diff__head">
            <div><span>Your difficulty, {last?.name ?? 'last week'}</span><b>{last && you(last) !== null ? usd(you(last)!) : DASH}</b><small>of {unit} per point</small></div>
            <div><span>Platform{last && (basis === 'vol' ? last.volOut : last.oiOut) ? (basis === 'vol' ? ', without 1002 and 23342' : ", without SoDEX's internal pair") : ''}</span><b>{last && plat(last) !== null ? usd(plat(last)!) : DASH}</b><small>of {unit} per point</small></div>
            <div><span>Score</span><b className={score === null ? '' : score <= 1 ? 'is-pos' : 'is-neg'}>{score === null ? DASH : `${fmt(score, 2)}×`}</b><small>{score === null ? 'no trading week yet' : score <= 1 ? 'easier for you than the platform' : 'harder for you than the platform'}</small></div>
          </div>
          <span className="spm-legend"><i className="is-own" />You<i className="is-field" />Platform</span>
          <Bars
            rows={rows}
            height={160}
            axis={[rows[0] ? `L${rows[0].weekNo}` : '', rows.at(-1) ? `L${rows.at(-1)!.weekNo}` : '']}
            render={(r) => (
              <span className="spm-col__pair">
                <i className="is-own" style={{ height: you(r) ? `${(you(r)! / max) * 100}%` : 0 }} />
                <i className="is-field" style={{ height: plat(r) ? `${(plat(r)! / max) * 100}%` : 0 }} />
              </span>
            )}
            tip={(r) => (<>
              <b className="spm-tt__h">Layer 1 · {r.name}</b>
              <TipRow dot="is-own" k="You, by volume" v={r.youVol ? usd(r.youVol) : '—'} />
              <TipRow dot="is-own" k="You, by open interest" v={r.youOi ? usd(r.youOi) : '—'} />
              <TipRow dot="is-field" k="Platform, by volume" v={r.platVol ? usd(r.platVol) : '—'} />
              <TipRow dot="is-field" k="Platform, by open interest" v={r.platOi ? usd(r.platOi) : '—'} />
              <TipRow k="Big accounts" v={r.volOut && r.oiOut ? 'taken out' : r.oiOut ? 'OI taken out, volume not known yet' : r.volOut ? 'volume taken out' : 'included'} />
            </>)}
          />
        </div>
      )}
    </Card>
  );
}

/* --- the week table, both seasons -------------------------------------------------------------------------------- */

export function WeekTable({ s }: { s: S2State }) {
  const rows = useMemo(() => allWeeks(s.s1, s.weeks).reverse(), [s.s1, s.weeks]);
  const [all, setAll] = useState(false);
  const firstS1 = rows.findIndex((r) => r.season === 'S1');
  const shown = all ? rows : rows.filter((r) => r.season === 'L1' || r.split.week.points > 0);
  if (!rows.length) return s.loading ? <Card title="Every week"><SkelRows rows={6} height={34} /></Card> : null;
  return (
    <Card title="Every week" action={<button type="button" className="spm-linkbtn" onClick={() => setAll((x) => !x)}>{all ? 'Hide empty weeks' : 'Show empty weeks'}</button>}>
      <div className="spm-tbl__wrap">
        <table className="spm-tbl">
          <thead>
            <tr><th>Week</th><th>Points</th><th>Trading</th><th>Referrals</th><th>Squad</th><th>Volume</th><th>Open interest</th><th>Holdings</th><th>Rank</th></tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const w = r.split.week;
              const tbd = w.pointsStatus !== 'CONFIRMED';
              const holdings = (w.wealthTvl ?? 0) + (w.vaultHolding ?? 0);
              const seasonHead = i === 0 || shown[i - 1]!.season !== r.season;
              return (
                <Fragment key={r.key}>
                  {seasonHead && <tr className="spm-tbl__season"><td colSpan={9}>{r.season === 'L1' ? 'Layer 1 Season' : 'Season 1'}</td></tr>}
                  <tr className={w.isLive ? 'is-live' : ''}>
                    <td><b>{w.weekName}</b>{w.isLive && <span className="spm-tbl__live">Live</span>}<small>{dateRange(w.weekStartTime, w.weekEndTime)}</small></td>
                    <td className="is-num is-strong">{tbd ? 'TBD' : fmt(w.points, 0)}</td>
                    <td className="is-num">{tbd ? '—' : fmt(r.split.own, 0)}</td>
                    <td className="is-num">{tbd ? '—' : fmt(r.split.referral, 0)}</td>
                    <td className="is-num">{r.season === 'L1' ? <span className={w.totalBonusPct ? 'is-pos' : ''}>+{w.totalBonusPct ?? 0}%</span> : '—'}</td>
                    <td className="is-num">{r.split.volume ? usd(r.split.volume) : '—'}</td>
                    <td className="is-num">{w.oi ? usd(w.oi) : '—'}</td>
                    <td className="is-num">{holdings >= 1 ? usd(holdings) : '—'}</td>
                    <td className="is-num">{w.rank ? fmt(w.rank, 0) : '—'}</td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {firstS1 < 0 && <p className="pf-note">Season 1 weeks appear here once SoDEX returns them for this wallet.</p>}
    </Card>
  );
}

const dateRange = (a: number, b: number) => {
  const f = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
  return a && b ? `${f(a)} – ${f(b)}` : '';
};

/* --- how to earn more ---------------------------------------------------------------------------------------------- */

export function EarnMore({ s, cfg, weights, pool, children }: { s: S2State; cfg: BoostConfig | null; weights: VolumeWeights | null; pool: number | null; children?: ReactNode }) {
  const tips: Tip[] = useMemo(() => {
    const live = s.weeks.find((w) => w.isLive) ?? null;
    const squad = s.bonus && cfg ? squadBreakdown(s.bonus, cfg, live) : null;
    return earnTips({ weeks: s.weeks, squad, cfg, weights, pool, venue: venueVolumeByWeek(s.weeks, s.venueDaily) });
  }, [s, cfg, weights, pool]);
  return (
    <section className="sdx-section" aria-label="How to earn more">
      <h2 className="sdx-section__title">How to earn more</h2>
      {children}
      <div className="spm-tips">
        {tips.filter((t) => t.id !== 'boosted').map((t) => (
          <article key={t.id} className="spm-tip">
            <div className="spm-tip__head"><span>{t.title}</span>{t.kind === 'estimate' && <Pill tone="quiet" title="From our fit of measured weeks, not a SoDEX figure">Estimate</Pill>}</div>
            <b className="spm-tip__v">{t.value}</b>
            <p>{t.line}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
