/**
 * SoPoints, signed in: the wallet's own part of the page (owner 2026-11-16). The tier card and the season card are
 * SoDEX's own designs (their points page, read from their bundle: per-tier gradient, outline and shadow; total, last
 * week, next tier or MAX LEVEL, "Rank N of all users"; the season card's pool, countdown and the wallet's invite code
 * and link). The squad card shows the wallet's own boost; the charts show every week of both seasons at once; the
 * tips explain how to earn more, simply. Data and arithmetic: soPointsV2.ts.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Card } from '../portfolio/parts';
import { DASH, fmt } from '../../format';
import { notify } from '../../toast';
import type { BoostConfig, VolumeWeights, WeekInfo } from '../../points';
import { Pill, useNow } from './parts';
import { allWeeks, earnTips, squadBreakdown, venueVolumeByWeek, type AnyWeek, type S2State, type SquadBreakdown, type Tip } from './soPointsV2';

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
const usd = (n: number) => (n >= 1e6 ? `$${fmt(n / 1e6, n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `$${fmt(n / 1e3, 0)}K` : `$${fmt(n, 0)}`);
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

export function SeasonCard({ week, code }: { week: WeekInfo | null; code: string | null }) {
  const now = useNow();
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
          <span className="spm-season__k">Your invite code</span>
          <div className="spm-season__row"><b>{code ?? DASH}</b>{code && <CopyBtn onClick={() => void copy(code, 'Invite code')} label="Copy invite code" />}</div>
        </div>
        <div>
          <span className="spm-season__k">Your invite link</span>
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
            <span>on every point you earn this week</span>
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

/* --- all weeks, both charts --------------------------------------------------------------------------------------- */

function useAllWeeks(s: S2State) {
  return useMemo(() => allWeeks(s.s1, s.weeks), [s.s1, s.weeks]);
}

/** One frame for both charts: a fixed height, every week of both seasons, the season start marked, a hover readout. */
function WeekBars({ rows, render, readout, label }: {
  rows: AnyWeek[];
  render: (r: AnyWeek) => ReactNode;
  readout: (r: AnyWeek) => ReactNode;
  label: (r: AnyWeek) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const firstL1 = rows.findIndex((r) => r.season === 'L1');
  const shown = hover !== null ? rows[hover] : [...rows].reverse().find((r) => r.split.week.pointsStatus === 'CONFIRMED') ?? null;
  return (
    <div className="spm-weeks">
      <div className="spm-weeks__plot" onMouseLeave={() => setHover(null)}>
        {rows.map((r, i) => (
          <button
            key={r.key}
            type="button"
            className={`spm-col${hover === i ? ' is-hover' : ''}${i === firstL1 && i > 0 ? ' is-season' : ''}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            aria-label={label(r)}
          >
            <span className="spm-col__stack">{render(r)}</span>
          </button>
        ))}
      </div>
      <div className="spm-weeks__axis">
        <span>{rows[0]?.short}</span>
        {firstL1 > 0 && <span className="spm-weeks__mark" style={{ left: `${(firstL1 / rows.length) * 100}%` }}>Layer 1</span>}
        <span>{rows.at(-1)?.short}</span>
      </div>
      {shown && <p className="spm-readout">{readout(shown)}</p>}
    </div>
  );
}

export function WeeklyPoints({ s }: { s: S2State }) {
  const rows = useAllWeeks(s);
  const max = Math.max(1, ...rows.map((r) => r.split.week.points));
  const h = (v: number) => `${(v / max) * 100}%`;
  return (
    <Card title="Points by week" action={<span className="spm-legend"><i className="is-own" />Trading<i className="is-ref" />Referrals<i className="is-boost" />Squad boost</span>}>
      {!rows.length ? <p className="pf-note">{s.loading ? 'Reading your weeks…' : 'No weeks yet.'}</p> : (
        <WeekBars
          rows={rows}
          label={(r) => `${r.name}: ${r.split.week.pointsStatus === 'CONFIRMED' ? `${r.split.week.points} points` : 'not scored yet'}`}
          render={(r) => r.split.week.pointsStatus !== 'CONFIRMED' ? <i className="spm-col__tbd" /> : (<>
            <i className="is-boost" style={{ height: h(r.split.boost) }} />
            <i className="is-ref" style={{ height: h(r.split.referral) }} />
            <i className="is-own" style={{ height: h(r.split.own) }} />
          </>)}
          readout={(r) => {
            const w = r.split.week;
            if (w.pointsStatus !== 'CONFIRMED') return <><b>{r.name}</b> · not scored yet · {usd(r.split.volume)} volume so far</>;
            return <><b>{r.name}</b> · <b>{w.points.toLocaleString('en-US')}</b> points = {fmt(r.split.own, 0)} trading + {fmt(r.split.referral, 0)} referrals{r.split.boost >= 1 ? ` + ${fmt(r.split.boost, 0)} squad (+${w.totalBonusPct ?? 0}%)` : ''} · {usd(r.split.volume)} volume{w.rank ? ` · rank ${w.rank.toLocaleString('en-US')}` : ''}</>;
          }}
        />
      )}
    </Card>
  );
}

export function CostPerPoint({ s, pool }: { s: S2State; pool: number | null }) {
  const rows = useAllWeeks(s);
  const venue = useMemo(() => venueVolumeByWeek(s.weeks, s.venueDaily), [s.weeks, s.venueDaily]);
  const field = (r: AnyWeek): number | null => {
    if (r.season !== 'L1' || !pool) return null;
    const v = venue.get(r.split.week.weekNo);
    return v ? v / pool : null;
  };
  const vals = rows.flatMap((r) => [r.split.dollarsPerPoint, field(r)]).filter((x): x is number => x !== null && x > 0);
  const max = Math.max(1, ...vals);
  return (
    <Card title="Volume per point" action={<span className="spm-legend"><i className="is-own" />You<i className="is-field" />Whole venue</span>}>
      {!rows.length ? <p className="pf-note">{s.loading ? 'Reading…' : 'No weeks yet.'}</p> : (
        <WeekBars
          rows={rows}
          label={(r) => `${r.name}: ${r.split.dollarsPerPoint ? usd(r.split.dollarsPerPoint) : 'no trading'} per point`}
          render={(r) => {
            const f = field(r);
            return (
              <span className="spm-col__pair">
                <i className="is-own" style={{ height: r.split.dollarsPerPoint ? `${(r.split.dollarsPerPoint / max) * 100}%` : 0 }} />
                <i className="is-field" style={{ height: f ? `${(f / max) * 100}%` : 0 }} />
              </span>
            );
          }}
          readout={(r) => {
            const f = field(r);
            return <><b>{r.name}</b> · {r.split.dollarsPerPoint ? <>you <b>{usd(r.split.dollarsPerPoint)}</b> per point</> : 'no trading by you'}{f ? <> · venue {usd(f)} per point</> : null} · lower is better</>;
          }}
        />
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
