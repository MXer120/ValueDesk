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
import { inviteLink, inviteLinkShown, useOwnCode } from '../../invites/invites';
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
    <section className={`spm-card${iron ? ' is-iron' : ''}${tier === 'Gold' || tier === 'Diamond' || epic ? ' is-glare' : ''}`} style={{ background: st.bg, outlineColor: st.border, boxShadow: `0 25px 50px -12px ${st.shadow}` }} aria-label="Your SoPoints">
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

export function SeasonCard({ week, address, settled }: { week: WeekInfo | null; address: string | null; settled: boolean }) {
  const now = useNow();
  // The user's own ValueDesk invite link (its SoDEX code; invites/invites.ts), never ours (owner 2026-11-16).
  const own = useOwnCode(address);
  const code = own.state === 'ok' ? own.code : null;
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
  const link = code ? inviteLinkShown(code) : null;
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
          <div className="spm-season__row"><b className={code ? '' : 'is-muted'}>{code ?? (!address ? 'Connect a wallet' : own.state === 'loading' ? '…' : own.state === 'none' ? 'Trade on SoDEX first' : DASH)}</b>{code && <CopyBtn onClick={() => void copy(code, 'Invite code')} label="Copy invite code" />}</div>
        </div>
        <div>
          <span className="spm-season__k">Your invite link</span>
          <div className="spm-season__row"><b className={link ? 'is-link' : 'is-muted'}>{link ?? DASH}</b>{code && <CopyBtn onClick={() => void copy(inviteLink(code), 'Invite link')} label="Copy invite link" />}</div>
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
            <tr><th>Week</th><th>Volume</th><th>Open interest</th><th>Holdings</th><th>Rank</th><th>Squad</th><th>Trading</th><th>Referrals</th><th>Points</th></tr>
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
                    <td className="is-num">{r.split.volume ? usd(r.split.volume) : '—'}</td>
                    <td className="is-num">{w.oi ? usd(w.oi) : '—'}</td>
                    <td className="is-num">{holdings >= 1 ? usd(holdings) : '—'}</td>
                    <td className="is-num">{w.rank ? fmt(w.rank, 0) : '—'}</td>
                    <td className="is-num">{r.season === 'L1' ? <span className={w.totalBonusPct ? 'is-pos' : ''}>+{w.totalBonusPct ?? 0}%</span> : '—'}</td>
                    <td className="is-num">{tbd ? '—' : fmt(r.split.own, 0)}</td>
                    <td className="is-num">{tbd ? '—' : fmt(r.split.referral, 0)}</td>
                    <td className="is-num is-strong">{tbd ? 'TBD' : fmt(w.points, 0)}</td>
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
