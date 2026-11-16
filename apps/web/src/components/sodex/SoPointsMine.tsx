/**
 * SoPoints, signed in: the wallet's own part of the page (owner 2026-11-16). The tier card is SoDEX's own design
 * (their points page: per-tier gradient, outline and shadow, tier name, total, last week, progress to the next tier);
 * the squad card shows the wallet's own boost; the two charts and the tips explain how to earn more, simply.
 * Data and arithmetic: soPointsV2.ts.
 */
import { useMemo, useState } from 'react';
import { Card } from '../portfolio/parts';
import { DASH, fmt } from '../../format';
import { TIERS, type BoostConfig, type VolumeWeights } from '../../points';
import { Pill } from './parts';
import { earnTips, splitWeek, squadBreakdown, venueVolumeByWeek, type S2State, type SquadBreakdown, type Tip, type WeekSplit } from './soPointsV2';

/* SoDEX's own tier styles, as their points page draws its card (bundle 2026-11-16). */
const TIER_STYLE: Record<string, { bg: string; border: string; shadow: string; bar: string; chip: string }> = {
  Iron: { bg: 'linear-gradient(165deg, #27272A 0%, #18181B 50%, #2D2D2D 100%)', border: '#3F3F46', shadow: 'rgba(0,0,0,0.5)', bar: 'linear-gradient(to right, #52525B, #A1A1AA)', chip: '#A1A1AA' },
  Bronze: { bg: 'linear-gradient(165deg, #9A6754 0%, #795546 50%, #451A03 100%)', border: '#9A6754', shadow: 'rgba(154,103,84,0.4)', bar: 'linear-gradient(90deg, rgba(255,255,255,0.6) 0%, #fff 100%)', chip: '#F9A789' },
  Silver: { bg: 'linear-gradient(165deg, #94A3B8 0%, #475569 50%, #0F172A 100%)', border: '#94A3B8', shadow: 'rgba(148,163,184,0.4)', bar: 'linear-gradient(90deg, rgba(255,255,255,0.6) 0%, #fff 100%)', chip: '#CBD5E1' },
  Gold: { bg: 'linear-gradient(165deg, #E0CB82 0%, #A87024 50%, #5E3C0F 100%)', border: '#DDA700', shadow: 'rgba(221,167,0,0.4)', bar: 'linear-gradient(to right, #DDA700, #FACC15)', chip: '#FACC15' },
  Diamond: { bg: 'linear-gradient(165deg, #818CF8 0%, #4338CA 50%, #1E1B4B 100%)', border: '#818CF8', shadow: 'rgba(129,140,248,0.4)', bar: 'linear-gradient(to right, #818CF8, #A5B4FC)', chip: '#A5B4FC' },
  Epic: { bg: 'linear-gradient(165deg, #1A1A1A 0%, #080808 50%, #000000 100%)', border: 'rgba(255,255,255,0.2)', shadow: 'rgba(0,0,0,0.8)', bar: 'linear-gradient(to right, #6B7280, #FFFFFF, #D1D5DB)', chip: '#FFFFFF' },
};
const tierKey = (t: string | undefined) => {
  const k = (t ?? 'Iron').toLowerCase();
  return Object.keys(TIER_STYLE).find((x) => x.toLowerCase() === k) ?? 'Iron';
};
const usd = (n: number) => (n >= 1e6 ? `$${fmt(n / 1e6, n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `$${fmt(n / 1e3, 0)}K` : `$${fmt(n, 0)}`);

/* --- the tier card ------------------------------------------------------------------------------------------------ */

export function SoPointsCard({ s }: { s: S2State }) {
  const sum = s.summary;
  const tier = tierKey(sum?.currentTier);
  const st = TIER_STYLE[tier]!;
  const last = s.weeks.filter((w) => w.pointsStatus === 'CONFIRMED').sort((a, b) => b.weekNo - a.weekNo)[0];
  const total = sum?.totalPoints ?? null;
  const next = sum?.nextTier ? tierKey(sum.nextTier) : null;
  const goal = sum?.nextTierPoints ?? null;
  // Progress inside the current tier's band, as SoDEX draws it (from this tier's floor to the next tier's).
  const floor = TIERS.find((t) => t.name.toLowerCase() === tier.toLowerCase())?.at ?? 0;
  const pct = total !== null && goal && goal > floor ? Math.max(0, Math.min(100, ((total - floor) / (goal - floor)) * 100)) : 100;
  const epic = tier === 'Epic';
  return (
    <section className={`spm-card${tier === 'Iron' ? ' is-iron' : ''}`} style={{ background: st.bg, outlineColor: st.border, boxShadow: `0 25px 50px -12px ${st.shadow}` }} aria-label="Your SoPoints">
      <div className="spm-card__top">
        <span className="spm-card__tier">{tier.toUpperCase()}</span>
        {sum?.rank ? <span className="spm-card__rank">Rank #{fmt(sum.rank, 0)}{sum.totalUser ? ` of ${fmt(sum.totalUser, 0)}` : ''}</span> : null}
      </div>
      <div className="spm-card__total">
        <b className={epic ? 'is-epic' : ''}>{total !== null ? fmt(total, 0) : s.loading ? '…' : DASH}</b>
        <span className="spm-card__chip" style={{ color: epic ? '#E5E5E5' : st.chip }}>SOPOINTS</span>
      </div>
      {last && last.points > 0 && <span className="spm-card__last">Last week <b>+{fmt(last.points, 0)}</b></span>}
      <div className="spm-card__next">
        <div className="spm-card__nextrow">
          <span>{next ? `NEXT TIER: ${next.toUpperCase()}` : 'MAX LEVEL'}</span>
          {next && total !== null && goal ? <span className="spm-card__mono">{fmt(total, 0)} / {fmt(goal, 0)}</span> : null}
        </div>
        <div className="spm-card__bar"><i style={{ width: `${pct}%`, background: st.bar }} /></div>
      </div>
    </section>
  );
}

/* --- the wallet's squad boost ------------------------------------------------------------------------------------ */

export function MySquadBoost({ s, cfg }: { s: S2State; cfg: BoostConfig | null }) {
  const live = s.weeks.find((w) => w.isLive) ?? null;
  const q: SquadBreakdown | null = s.bonus && cfg ? squadBreakdown(s.bonus, cfg, live) : null;
  const tiers = cfg ? [...cfg.tiers].sort((a, b) => Number(a.threshold) - Number(b.threshold)) : [];
  return (
    <Card title="Your squad boost" action={cfg ? <span className="pf-unit">up to +{cfg.maxTotalBonusPct}%</span> : undefined}>
      {!q ? <p className="pf-note">{s.loading ? 'Reading your squad…' : DASH}</p> : (
        <div className="spm-squad">
          <div className="spm-squad__head">
            <b>+{q.total}%</b>
            <span>on every point you earn this week{q.fromSodex ? '' : ' (from your squads)'}</span>
          </div>
          <div className="spm-squad__parts">
            <Part label="Squad you joined" pct={q.joined.pct} vol={q.joined.volume} next={q.joined.next} />
            <Part label="Squad you built" pct={q.built.pct} vol={q.built.volume} next={q.built.next} sub={`${q.built.members} members · ${q.built.active} active`} />
            <div className="spm-part">
              <span className="spm-part__k">Early bird</span>
              <b>{q.earlyBird ? `+${q.earlyBird}%` : '—'}</b>
              <small>{q.earlyBird ? `locked in during the first ${cfg?.earlyBirdRounds ?? 4} weeks` : 'not locked in'}</small>
            </div>
          </div>
          <ol className="spm-ladder" aria-label="Squad steps">
            {tiers.map((t) => {
              const on = q.built.volume >= Number(t.threshold) || q.joined.volume >= Number(t.threshold);
              return <li key={t.threshold} className={on ? 'is-on' : ''}><b>+{t.bonusPct}%</b><span>{usd(Number(t.threshold))}</span></li>;
            })}
          </ol>
          <p className="pf-note">A squad's volume over the last {cfg?.windowRounds ?? 4} weeks sets its step; $1 traded = 1 energy. Both squads add up.</p>
        </div>
      )}
    </Card>
  );
}

function Part({ label, pct, vol, next, sub }: { label: string; pct: number; vol: number; next: { threshold: number; pct: number; missing: number } | null; sub?: string }) {
  const prog = next ? Math.min(100, (vol / next.threshold) * 100) : 100;
  return (
    <div className="spm-part">
      <span className="spm-part__k">{label}</span>
      <b>{pct ? `+${pct}%` : '—'}</b>
      <small>{usd(vol)} {next ? `· ${usd(next.missing)} to +${next.pct}%` : '· top step'}</small>
      <div className="spm-part__bar"><i style={{ width: `${prog}%` }} /></div>
      {sub && <small>{sub}</small>}
    </div>
  );
}

/* --- weekly points ------------------------------------------------------------------------------------------------ */

export function WeeklyPoints({ s }: { s: S2State }) {
  const rows = useMemo(() => [...s.weeks].sort((a, b) => a.weekNo - b.weekNo).map(splitWeek), [s.weeks]);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.week.points));
  const h = hover !== null ? rows[hover] : rows.filter((r) => r.week.pointsStatus === 'CONFIRMED').at(-1) ?? null;
  return (
    <Card title="Points by week" action={<Legend />}>
      {!rows.length ? <p className="pf-note">{s.loading ? 'Reading your weeks…' : 'No weeks yet.'}</p> : (
        <div className="spm-weeks">
          <div className="spm-weeks__plot" onMouseLeave={() => setHover(null)}>
            {rows.map((r, i) => {
              const tbd = r.week.pointsStatus !== 'CONFIRMED';
              const part = (v: number) => `${(v / max) * 100}%`;
              return (
                <button key={r.week.weekNo} type="button" className={`spm-col${hover === i ? ' is-hover' : ''}${tbd ? ' is-tbd' : ''}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} aria-label={`${r.week.weekName}: ${tbd ? 'not scored yet' : `${r.week.points} points`}`}>
                  <span className="spm-col__stack">
                    {tbd ? <i className="spm-col__tbd" /> : (<>
                      <i className="is-boost" style={{ height: part(r.boost) }} />
                      <i className="is-ref" style={{ height: part(r.referral) }} />
                      <i className="is-own" style={{ height: part(r.own) }} />
                    </>)}
                  </span>
                  <span className="spm-col__x">{r.week.weekNo}</span>
                </button>
              );
            })}
          </div>
          {h && <WeekReadout r={h} />}
        </div>
      )}
    </Card>
  );
}

const Legend = () => (
  <span className="spm-legend"><i className="is-own" />Trading<i className="is-ref" />Referrals<i className="is-boost" />Squad boost</span>
);

function WeekReadout({ r }: { r: WeekSplit }) {
  const w = r.week;
  if (w.pointsStatus !== 'CONFIRMED') return <p className="spm-readout"><b>{w.weekName}</b> · not scored yet · {usd(r.volume)} volume so far · squad +{w.totalBonusPct ?? 0}%</p>;
  return (
    <p className="spm-readout">
      <b>{w.weekName}</b> · <b>{fmt(w.points, 0)}</b> points = {fmt(r.own, 0)} trading + {fmt(r.referral, 0)} referrals + {fmt(r.boost, 0)} squad (+{w.totalBonusPct ?? 0}%) · {usd(r.volume)} volume{w.rankPercentile ? ` · ${w.rankPercentile}` : ''}
    </p>
  );
}

/* --- cost per point: you vs the venue ----------------------------------------------------------------------------- */

export function CostPerPoint({ s, pool }: { s: S2State; pool: number | null }) {
  const venue = useMemo(() => venueVolumeByWeek(s.weeks, s.venueDaily), [s.weeks, s.venueDaily]);
  const rows = useMemo(() => [...s.weeks].sort((a, b) => a.weekNo - b.weekNo).filter((w) => !w.isLive).map((w) => {
    const sp = splitWeek(w);
    const v = venue.get(w.weekNo);
    return { w, you: sp.dollarsPerPoint, field: v && pool ? v / pool : null };
  }), [s.weeks, venue, pool]);
  const vals = rows.flatMap((r) => [r.you, r.field]).filter((x): x is number => x !== null);
  const max = Math.max(1, ...vals);
  const traded = rows.some((r) => r.you !== null);
  return (
    <Card title="Volume per point" action={<span className="spm-legend"><i className="is-own" />You<i className="is-field" />Whole venue</span>}>
      <p className="pf-note spm-sub">Dollars of volume it took to earn one point. Lower is better.</p>
      {!rows.length || !vals.length ? <p className="pf-note">{s.loading ? 'Reading…' : 'Not enough weeks yet.'}</p> : (
        <div className="spm-cpp">
          {rows.map((r) => (
            <div key={r.w.weekNo} className="spm-cpp__row">
              <span className="spm-cpp__wk">W{r.w.weekNo}</span>
              <div className="spm-cpp__bars">
                <span className="spm-cpp__bar is-own" style={{ width: r.you ? `${(r.you / max) * 100}%` : 0 }} />
                <span className="spm-cpp__bar is-field" style={{ width: r.field ? `${(r.field / max) * 100}%` : 0 }} />
              </div>
              <span className="spm-cpp__v">{r.you ? usd(r.you) : '—'}<small>{r.field ? usd(r.field) : '—'}</small></span>
            </div>
          ))}
          {!traded && <p className="pf-note">You traded too little in these weeks to measure your own cost.</p>}
        </div>
      )}
    </Card>
  );
}

/* --- how to earn more ---------------------------------------------------------------------------------------------- */

export function EarnMore({ s, cfg, weights, pool }: { s: S2State; cfg: BoostConfig | null; weights: VolumeWeights | null; pool: number | null }) {
  const tips: Tip[] = useMemo(() => {
    const live = s.weeks.find((w) => w.isLive) ?? null;
    const squad = s.bonus && cfg ? squadBreakdown(s.bonus, cfg, live) : null;
    return earnTips({ weeks: s.weeks, squad, cfg, weights, pool, venue: venueVolumeByWeek(s.weeks, s.venueDaily) });
  }, [s, cfg, weights, pool]);
  return (
    <section className="sdx-section" aria-label="How to earn more">
      <h2 className="sdx-section__title">How to earn more</h2>
      <div className="spm-tips">
        {tips.map((t) => (
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
