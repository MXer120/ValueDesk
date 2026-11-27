/**
 * What the SoPoints versions share (localhost only, owner 2026-11-26): the page's data, the sign-in, the countdown, the
 * tier coin, the boosted markets, the squad tracks, the week bars, the week table and the levers.
 *
 * Every figure is SoDEX's (its public reads; the wallet's own after the SoDEX sign-in, through the same relay and call
 * as Original: PointsContext.signIn), arithmetic on SoDEX's figures, or ValueDesk's estimate, which the server answers
 * (sopointsEstimate.ts: the model never reaches the page) and which is labelled an estimate wherever it shows. The
 * switch's Sample replaces the wallet's own figures with made-up ones (sample.ts), never in a build.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { usePointsContext, type PointsContext } from '../../../Points';
import { TIERS, fetchVenueDaily, type BoostConfig, type DailyPoint, type WeekInfo } from '../../../../points';
import { SODEX_POINTS_SIGNIN_LIVE } from '../../../../sodexProgrammes';
import type { Eip1193Provider } from '../../../../wallet';
import { warmWalletModal } from '../../../../walletconnect';
import { openConnectDialog } from '../../../account/connect';
import { useAccountPending } from '../../../account/actions';
import { useWalletSnapshot } from '../../../account/useWallet';
import { CoinIcon } from '../../../CoinIcon';
import { EmptyState, Icon, Segmented, Skeleton, StatusPill, type IconName } from '../../../bots/kit/kit';
import { whole } from '../../../referrals/parts';
import { DASH, fmt } from '../../../../format';
import { localize } from '../../../../numStyle';
import { TIER_STYLE, tierKey } from '../../SoPointsMine';
import { useNow } from '../../parts';
import { allWeeks, squadBreakdown, useSoPointsV2, type AnyWeek, type S2State, type S2Week, type SquadBreakdown } from '../../soPointsV2';
import type { EstBand, EstPlan } from '../../sopointsEstimate';
import { samplePoints } from './sample';

/* ------------------------------------------------------------------------------------------- data ----- */

export interface PointsView {
  c: PointsContext;
  s: S2State;
  /** The wallet's own figures are on the page: signed in to SoDEX, or the switch's sample. */
  mine: boolean;
  sample: boolean;
  week: WeekInfo | null;
  /** Both seasons, oldest first (Closed Alpha left out), and the ones SoDEX has scored. */
  all: AnyWeek[];
  scored: AnyWeek[];
  live: S2Week | null;
  last: AnyWeek | null;
  squad: SquadBreakdown | null;
  total: number | null;
  tier: string;
  next: { name: string; at: number } | null;
  /** Mean points of the last four scored weeks: arithmetic on SoDEX's weeks. */
  pace: number | null;
}

/**
 * With the Sample on: the venue's own daily volume and open interest (SoDEX's public series, the same reads a sign-in
 * makes), so the platform's side of the cost-per-point chart is real while the wallet's side is the sample's.
 */
function useSampleVenue(on: boolean): { vol: DailyPoint[]; oi: DailyPoint[] } | null {
  const [d, setD] = useState<{ vol: DailyPoint[]; oi: DailyPoint[] } | null>(null);
  useEffect(() => {
    if (!on || d) return;
    let live = true;
    void Promise.allSettled([fetchVenueDaily('volume', 150), fetchVenueDaily('open-interest', 150)]).then(([a, b]) => {
      if (live) setD({ vol: a.status === 'fulfilled' ? a.value : [], oi: b.status === 'fulfilled' ? b.value : [] });
    });
    return () => { live = false; };
  }, [on, d]);
  return d;
}

export function usePointsView(address: string | null, provider: Eip1193Provider | null, sample: boolean): PointsView {
  const c = usePointsContext(address, provider);
  const real = SODEX_POINTS_SIGNIN_LIVE && c.tokenPresent && !!address;
  const v2 = useSoPointsV2(address, real && !sample);
  const venue = useSampleVenue(sample);
  const demo = useMemo(() => (sample ? { ...samplePoints(c.week, c.boost), venueDaily: venue?.vol ?? [], venueOiDaily: venue?.oi ?? [] } : null), [sample, c.week, c.boost, venue]);
  const s = demo ?? v2;
  const mine = sample || real;
  return useMemo(() => {
    const all = mine ? allWeeks(s.s1, s.weeks) : [];
    const scored = all.filter((w) => w.split.week.pointsStatus === 'CONFIRMED');
    const live = s.weeks.find((w) => w.isLive) ?? null;
    const squad = s.bonus && c.boost ? squadBreakdown(s.bonus, c.boost, live) : null;
    const sum = s.summary;
    const recent = scored.slice(-4);
    const pace = recent.length ? recent.reduce((t, w) => t + w.split.week.points, 0) / recent.length : null;
    const next = sum?.nextTier && sum.nextTierPoints ? { name: tierKey(sum.nextTier), at: sum.nextTierPoints } : null;
    return { c, s, mine, sample, week: c.week, all, scored, live, last: scored.at(-1) ?? null, squad, total: sum?.totalPoints ?? null, tier: tierKey(sum?.currentTier), next, pace };
  }, [c, s, mine, sample]);
}

/* ------------------------------------------------------------------------------------- figures ----- */

export const pts = (n: number) => whole(n);
/** Up to `dp` places, trailing zeros dropped, in the app's number style: 1.5 → "1,5", 5 → "5", 1.84 → "1,84". */
const trim = (x: number, dp: number) => { const v = Number(x.toFixed(dp)); const d = (String(v).split('.')[1] ?? '').length; return fmt(v, d); };
/** Money in a line: $1,84M, $462K, $9.400, $8,50 (whole dollars under $10K, so $1,000 is never "$1,00K"). */
export const money = (n: number): string => {
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  if (a >= 1e9) return `${s}$${trim(a / 1e9, 2)}B`;
  if (a >= 1e6) return `${s}$${trim(a / 1e6, a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${s}$${trim(a / 1e3, 0)}K`;
  return `${s}$${a >= 10 || Number.isInteger(a) ? fmt(Math.round(a), 0) : fmt(a, 2)}`;
};
/** Points under 100 keep a decimal when they have one (an estimate of 4.3 is not 4). */
export const ptsEst = (n: number) => (n >= 100 ? whole(n) : localize(n.toFixed(n >= 10 ? 0 : 1)));
export const plusPct = (n: number) => localize(n === 0 ? '0%' : `+${Number(n.toFixed(1))}%`);
export const coefText = (x: number) => `×${localize(String(x))}`;
export const weekRange = (startS: number) => {
  const f = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${f(startS)} – ${f(startS + 7 * 86_400)}`;
};

/** A phone's width: lists stay lists there. */
export function usePhone(): boolean {
  const [on, setOn] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 720px)');
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return on;
}

/* ---------------------------------------------------------------------------------- the clock ----- */

const two = (n: number) => String(n).padStart(2, '0');

/** "05d 11h 59m 00s" to SoDEX's next snapshot; it ticks on its own, so the page does not re-render every second. */
export function Clock({ to, className }: { to: number | null; className?: string }) {
  const now = useNow(1000);
  if (to === null) return <span className={`spx-clock ${className ?? ''}`}>{DASH}</span>;
  const left = Math.max(0, to - now);
  const p = [Math.floor(left / 86_400_000), Math.floor((left % 86_400_000) / 3_600_000), Math.floor((left % 3_600_000) / 60_000), Math.floor((left % 60_000) / 1000)];
  return (
    <span className={`spx-clock ${className ?? ''}`} role="timer" aria-label={`${p[0]} days ${p[1]} hours ${p[2]} minutes left`}>
      {['d', 'h', 'm', 's'].map((u, i) => <span key={u}><b>{two(p[i]!)}</b>{u}</span>)}
    </span>
  );
}

/** "Tue 13:00" in the reader's own clock. */
export const weekday = (s: number) => new Date(s * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function WeekPill({ week }: { week: WeekInfo | null }) {
  if (!week) return <Skeleton className="spx-pillskel" />;
  const live = week.weekStatus === 'LIVE';
  return <StatusPill tone={live ? 'positive' : 'neutral'} dot={live} pulse={live}>{week.weekName} · {live ? 'Live' : week.weekStatus.toLowerCase()}</StatusPill>;
}

/* ---------------------------------------------------------------------------------- sign-in ----- */

/** The Original's one button, as an action: connect, reconnect, or sign SoDEX's own message once (PointsContext). */
export function useSignIn(c: PointsContext) {
  const pending = useAccountPending();
  const wallet = useWalletSnapshot();
  const restoring = !!c.address && !c.provider && wallet.status === 'connecting';
  const connect = !c.address || !c.provider;
  const opening = connect && (pending === 'connect' || restoring);
  const label = restoring ? 'Reconnecting wallet…' : opening ? 'Opening…' : !c.address ? 'Connect wallet' : !c.provider ? 'Reconnect wallet'
    : c.signingIn ? 'Check your wallet…' : c.signInError ? 'Try again' : 'Show my SoPoints';
  return {
    label,
    connect,
    busy: opening || (!connect && c.signingIn),
    error: c.signInError,
    off: !SODEX_POINTS_SIGNIN_LIVE,
    go: () => { if (connect) void openConnectDialog(); else void c.signIn(); },
    warm: connect ? warmWalletModal : undefined,
  };
}

export function SignInButton({ c, className }: { c: PointsContext; className?: string }) {
  const a = useSignIn(c);
  return (
    <button type="button" className={`rf-cta ${className ?? ''}`} disabled={a.busy || a.off} aria-busy={a.busy || undefined} onPointerEnter={a.warm} onFocus={a.warm} onClick={a.go}>
      {a.label}
    </button>
  );
}

/** SoDEX's mark beside one line and the button: what the signature is and what it shows. */
export function SignInPanel({ c, line, items = true }: { c: PointsContext; line?: ReactNode; items?: boolean }) {
  const a = useSignIn(c);
  return (
    <div className="spx-signin">
      <img src="/logos/brand/sodex.svg" width="30" height="30" alt="" />
      <p>{line ?? (c.address ? 'Your SoPoints, week by week' : 'Connect a wallet to see your SoPoints')}</p>
      <small>One free signature of SoDEX's own sign-in message. No transaction, no gas, no funds move.</small>
      {items && <ul>{['Balance and tier', 'Every week', 'Your squads', 'Cost per point'].map((i) => <li key={i}><Icon name="check" size={13} />{i}</li>)}</ul>}
      <SignInButton c={c} />
      {a.error && <span className="spx-signin__err" role="alert">{a.error}</span>}
    </div>
  );
}

/* --------------------------------------------------------------------------------- tier coin ----- */

/** The tier's colours from SoDEX's own card (SoPointsMine TIER_STYLE): its three gradient stops and its edge. */
function tierPaint(tier: string) {
  const st = TIER_STYLE[tierKey(tier)]!;
  const stops = st.bg.match(/#[0-9a-f]{6}/gi) ?? ['#52525B', '#27272A', '#18181B'];
  return { stops, edge: st.border, chip: st.chip };
}

function Coin({ tier, cx, cy, r, mark = true }: { tier: string; cx: number; cy: number; r: number; mark?: boolean }) {
  const id = useId();
  const p = tierPaint(tier);
  const epic = tierKey(tier) === 'Epic';
  return (
    <g>
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="1" y2="1">{p.stops.map((c, i) => <stop key={i} offset={i / Math.max(1, p.stops.length - 1)} stopColor={c} />)}</linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" stopOpacity="0.42" /><stop offset="0.45" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <ellipse cx={cx + r * 0.2} cy={cy} rx={r * 0.92} ry={r} fill={p.stops.at(-1)} />
      <ellipse cx={cx} cy={cy} rx={r * 0.92} ry={r} fill={`url(#${id}f)`} stroke={p.edge} strokeOpacity="0.9" />
      <ellipse cx={cx} cy={cy} rx={r * 0.76} ry={r * 0.84} fill="none" stroke={epic ? '#e5e5e5' : p.chip} strokeOpacity="0.55" strokeWidth={Math.max(1, r * 0.025)} />
      <ellipse cx={cx} cy={cy} rx={r * 0.92} ry={r} fill={`url(#${id}s)`} />
      {mark && <image href="/logos/brand/sodex.svg" x={cx - r * 0.4} y={cy - r * 0.4} width={r * 0.8} height={r * 0.8} opacity="0.95" />}
    </g>
  );
}

/** The wallet's tier as a coin, the next one smaller behind it; signed out, Silver, Gold and Diamond fanned out. */
export function TierCoins({ tier, next }: { tier: string | null; next: string | null }) {
  return (
    <svg className="spx-coins" viewBox="0 0 240 220" aria-hidden="true">
      <ellipse cx="120" cy="204" rx="78" ry="9" fill="#000" opacity="0.42" />
      {tier ? (
        <>
          {next && <g className="spx-coins__b"><Coin tier={next} cx={186} cy={58} r={30} /></g>}
          <g className="spx-coins__a"><Coin tier={tier} cx={112} cy={112} r={78} /></g>
        </>
      ) : (
        <>
          <g className="spx-coins__b"><Coin tier="Silver" cx={52} cy={128} r={40} /></g>
          <g className="spx-coins__c"><Coin tier="Diamond" cx={190} cy={86} r={38} /></g>
          <g className="spx-coins__a"><Coin tier="Gold" cx={120} cy={112} r={70} /></g>
        </>
      )}
      {[[22, 40, 1], [218, 150, 0.8], [40, 182, 0.7], [212, 18, 0.9]].map(([x, y, s]) => <path key={x} className="spx-coins__sp" transform={`translate(${x} ${y}) scale(${s})`} d="M0-9 2.300-2.300 9 0 2.300 2.300 0 9-2.300 2.300-9 0-2.300-2.300z" fill="#f4f4f2" />)}
    </svg>
  );
}

/** A tier's name in its own colour (SoDEX's chip colour), with a gem. */
export function TierName({ tier, className }: { tier: string; className?: string }) {
  const k = tierKey(tier);
  return <span className={`spx-tiername is-${k.toLowerCase()} ${className ?? ''}`}><i aria-hidden="true" />{k}</span>;
}

/** SoDEX's ladder (points.ts TIERS, their FAQ), with where the wallet stands. */
export function tierProgress(total: number | null) {
  if (total === null) return null;
  const ix = TIERS.reduce((k, t, i) => (total >= t.at ? i : k), 0);
  const cur = TIERS[ix]!;
  const nxt = TIERS[ix + 1] ?? null;
  return { cur, nxt, left: nxt ? nxt.at - total : 0, share: nxt ? (total - cur.at) / (nxt.at - cur.at) : 1 };
}

/* ---------------------------------------------------------------------------- boosted markets ----- */

export function boostedOf(c: PointsContext) {
  const rows = c.weights?.weights ?? [];
  const coef = rows.length ? Math.max(...rows.map((w) => Number(w.coefficient) || 1)) : 1;
  return { rows, coef, until: c.weights?.round.end_ts_ms ?? null };
}

export function BoostedMarkets({ c, max }: { c: PointsContext; max?: number }) {
  const b = boostedOf(c);
  if (!c.publicSettled) return <div className="spx-markets">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="spx-market is-skel" />)}</div>;
  if (!b.rows.length) return <p className="spx-note">{c.weights ? 'No market is boosted this round.' : DASH}</p>;
  const shown = max ? b.rows.slice(0, max) : b.rows;
  return (
    <ul className="spx-markets">
      {shown.map((m) => (
        <li key={`${m.market_type}:${m.symbol_id}`}>
          <a className="spx-market" href={`/trade?symbol=${encodeURIComponent(m.symbol)}`} title={`Trade ${m.symbol}`}>
            <CoinIcon coin={m.symbol} size={22} />
            <span>{m.symbol.replace(/-USD$/, '')}</span>
            <b>{coefText(Number(m.coefficient))}</b>
          </a>
        </li>
      ))}
      {max && b.rows.length > max && <li className="spx-market is-more">+{b.rows.length - max}</li>}
    </ul>
  );
}

/* ------------------------------------------------------------------------------- squad boost ----- */

export const stepsOf = (cfg: BoostConfig | null) => (cfg ? [...cfg.tiers].sort((a, b) => Number(a.threshold) - Number(b.threshold)) : []);

/** SoDEX's five steps: the +% a squad's 4-week volume reaches. */
export function SquadLadder({ cfg, at }: { cfg: BoostConfig | null; at?: number | null }) {
  const steps = stepsOf(cfg);
  if (!cfg) return <Skeleton className="spx-ladderskel" />;
  const reached = at == null ? -1 : steps.reduce((k, s, i) => (at >= Number(s.threshold) ? i : k), -1);
  return (
    <ol className="spx-ladder">
      {steps.map((s, i) => (
        <li key={s.threshold} className={i <= reached ? 'is-on' : undefined}>
          <b>{plusPct(s.bonusPct)}</b>
          <span>{money(Number(s.threshold))}</span>
        </li>
      ))}
    </ol>
  );
}

/** One squad's 4-week volume on SoDEX's steps (equal spacing, the fill runs inside the step it is in). */
export function SquadTrack({ label, volume, pct, cfg, meta }: { label: string; volume: number; pct: number; cfg: BoostConfig; meta: ReactNode }) {
  const steps = stepsOf(cfg);
  const t = steps.map((x) => Number(x.threshold));
  const reached = t.filter((x) => volume >= x).length;
  const lo = reached === 0 ? 0 : t[reached - 1]!;
  const hi = t[reached] ?? lo;
  const inside = reached >= t.length ? 0 : (volume - lo) / Math.max(1, hi - lo);
  const fill = Math.min(100, ((reached + Math.max(0, Math.min(1, inside))) / t.length) * 100);
  const nxt = steps[reached];
  return (
    <div className="spx-track">
      <div className="spx-track__h">
        <span>{label}</span>
        <b className={pct ? 'is-on' : undefined}>{pct ? plusPct(pct) : '0%'}</b>
      </div>
      <div className="spx-track__bar" role="img" aria-label={`${label}: ${money(volume)}, ${pct ? plusPct(pct) : 'no boost'}`}>
        <i style={{ width: `${fill}%` }} />
        {steps.map((s, i) => <span key={s.threshold} className={i < reached ? 'is-on' : undefined} style={{ left: `${((i + 1) / steps.length) * 100}%` }} />)}
      </div>
      <div className="spx-track__f"><span>{meta}</span><span>{nxt ? <>{money(Number(nxt.threshold) - volume)} to <b>{plusPct(nxt.bonusPct)}</b></> : 'Top step'}</span></div>
    </div>
  );
}

export function SquadTracks({ v }: { v: PointsView }) {
  const cfg = v.c.boost;
  const q = v.squad;
  if (!cfg || !q) return v.s.loading ? <Skeleton className="spx-ladderskel" /> : <SquadLadder cfg={cfg} />;
  return (
    <div className="spx-tracks">
      <SquadTrack label="Squad you joined" volume={q.joined.volume} pct={q.joined.pct} cfg={cfg} meta={q.joined.volume > 0 ? `${money(q.joined.volume)} in ${cfg.windowRounds} weeks` : 'You joined no squad'} />
      <SquadTrack label="Squad you built" volume={q.built.volume} pct={q.built.pct} cfg={cfg} meta={`${money(q.built.volume)} · ${q.built.members} members, ${q.built.active} active`} />
    </div>
  );
}


/* -------------------------------------------------------------------------------- week bars ----- */

/** Points stacked (own, invited, squad); total = the season's points added up (Season.tsx Climb, tiers on its axis);
 * invited = the points from invitees alone; rank with 1 at the top. (Owner 2026-11-27: no "Mix".) */
export type BarMetric = 'points' | 'total' | 'invited' | 'rank';

/**
 * The weeks still to come, priced by the estimate (owner 2026-11-27: "make it possible to enable projections in the
 * chart"): Layer 1 weeks `from` to `to`, each earning `mid` points in a typical week, `busy` to `quiet` around it.
 */
export interface Ahead { from: number; to: number; mid: number; busy: number; quiet: number }

/** Every scored week as a column: own, from invitees and the squad's boost stacked; the invited part alone; or the
 * week's rank (1 at the top). With `ahead`, the weeks to come follow as estimated columns with their busy-to-quiet range. */
export function WeekBars({ weeks, metric = 'points', height = 220, ahead }: { weeks: readonly AnyWeek[]; metric?: BarMetric; height?: number; ahead?: Ahead | null }) {
  const [at, setAt] = useState<number | null>(null);
  const ws = metric === 'rank' ? weeks.filter((w) => w.split.week.rank > 0) : weeks;
  const none = metric === 'invited' && !ws.some((w) => w.split.referral > 0);
  const fut = metric === 'points' && ahead && ahead.to >= ahead.from ? Array.from({ length: ahead.to - ahead.from + 1 }, (_, i) => ahead.from + i) : [];
  if (!ws.length || none) return <div className="rfc is-empty spx-bars" style={{ minHeight: height }}><p>{metric === 'rank' ? 'No ranked week yet.' : none ? 'No points from invitees yet.' : 'Your weeks draw here from the first scored one.'}</p></div>;
  const val = (w: AnyWeek) => (metric === 'invited' ? w.split.referral : w.split.week.points);
  const n = ws.length + fut.length;
  const top = metric === 'rank' ? Math.max(10, ...ws.map((w) => w.split.week.rank)) : Math.max(1, ...ws.map(val), fut.length ? ahead!.quiet : 0);
  const decades = Math.ceil(Math.log10(top));
  const h = (w: AnyWeek) => (metric === 'rank' ? Math.max(0.04, 1 - Math.log10(Math.max(1, w.split.week.rank)) / Math.max(1, decades)) : val(w) / top);
  const every = Math.ceil(n / 9);
  const read = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n))));
  };
  const w = at === null || at >= ws.length ? null : ws[at]!;
  const f = at !== null && at >= ws.length ? fut[at - ws.length]! : null;
  const l1 = ws.findIndex((x) => x.season === 'L1');
  const pct = (x: number) => `${Math.max(1.5, (x / top) * 100)}%`;
  return (
    <div className="rfc is-bars spx-bars" style={{ minHeight: height }} role="img" aria-label={metric === 'rank' ? 'Rank by week' : 'SoPoints by week'} onPointerDown={read} onPointerMove={read} onPointerLeave={(e) => { if (e.pointerType !== 'touch') setAt(null); }}>
      <div className="rfc__bars" aria-hidden="true">
        {ws.map((x, i) => (
          <span key={x.key} className={`${at === i ? 'is-on' : ''}${i === l1 && l1 > 0 ? ' is-l1' : ''}`}>
            <span style={{ height: `${Math.max(1.5, h(x) * 100)}%` }}>
              {metric === 'rank' ? <i className="is-own" style={{ flexGrow: 1 }} /> : metric === 'invited' ? <i className="is-referral" style={{ flexGrow: 1 }} /> : (<>
                {x.split.boost > 0 && <i className="is-boost" style={{ flexGrow: x.split.boost }} />}
                {x.split.referral > 0 && <i className="is-referral" style={{ flexGrow: x.split.referral }} />}
                {x.split.own > 0 && <i className="is-own" style={{ flexGrow: x.split.own }} />}
              </>)}
            </span>
          </span>
        ))}
        {fut.map((k, i) => (
          <span key={`a${k}`} className={`is-ahead${at === ws.length + i ? ' is-on' : ''}${i === 0 ? ' is-first' : ''}`}>
            <em className="spx-bars__range" style={{ bottom: pct(ahead!.busy), height: `${Math.max(0, ((ahead!.quiet - ahead!.busy) / top) * 100)}%` }} />
            <span style={{ height: pct(ahead!.mid) }}><i className="is-est" style={{ flexGrow: 1 }} /></span>
          </span>
        ))}
      </div>
      {l1 > 0 && <span className="spx-bars__season" style={{ left: `${(l1 / n) * 100}%` }}>Layer 1</span>}
      {fut.length > 0 && <span className="spx-bars__season is-ahead" style={{ left: `${(ws.length / n) * 100}%` }}>Estimate</span>}
      {(w || f !== null) && at !== null && (
        <span className="rfc__tip" style={{ left: `clamp(90px, ${(100 / n) * (at + 0.5)}%, calc(100% - 90px))` }}>
          {f !== null ? (<>
            <small>Layer 1 · Week {f}, estimate</small>
            <span className="is-est"><i />Typical week<b>≈ {ptsEst(ahead!.mid)}</b></span>
            <span><i style={{ opacity: 0 }} />Busy to quiet<b>{ptsEst(ahead!.busy)} – {ptsEst(ahead!.quiet)}</b></span>
          </>) : (<>
            <small>{w!.name}</small>
            {metric === 'rank' ? <span><i style={{ color: 'var(--rf-points)' }} />Rank<b>#{pts(w!.split.week.rank)}</b></span> : metric === 'invited' ? (<>
              <span className="is-referral"><i />From invitees<b>{pts(w!.split.referral)}</b></span>
              <span><i style={{ opacity: 0 }} />Week<b>{pts(w!.split.week.points)}</b></span>
            </>) : (<>
              <span className="is-own"><i />Own<b>{pts(w!.split.own)}</b></span>
              <span className="is-referral"><i />From invitees<b>{pts(w!.split.referral)}</b></span>
              {w!.season === 'L1' && <span className="is-boost"><i />Squad {plusPct(w!.split.week.totalBonusPct ?? 0)}<b>{pts(w!.split.boost)}</b></span>}
              <span><i style={{ opacity: 0 }} />Week<b>{pts(w!.split.week.points)}</b></span>
            </>)}
          </>)}
        </span>
      )}
      <span className="rfc__ax is-cells">
        {ws.map((x, i) => <i key={x.key}>{i % every === 0 ? x.short : ''}</i>)}
        {fut.map((k, i) => <i key={`a${k}`}>{(ws.length + i) % every === 0 ? `L${k}` : ''}</i>)}
      </span>
    </div>
  );
}

export function BarsLegend({ metric = 'points', ahead = false }: { metric?: BarMetric; ahead?: boolean }) {
  if (metric === 'rank') return <ul className="spx-legend"><li><i className="is-own" />Rank, #1 at the top</li></ul>;
  if (metric === 'invited') return <ul className="spx-legend"><li><i className="is-referral" />From invitees, before the squad's boost</li></ul>;
  return <ul className="spx-legend"><li><i className="is-own" />Own</li><li><i className="is-referral" />From invitees</li><li><i className="is-boost" />Squad boost</li>{ahead && <li><i className="is-est" />Estimate, busy to quiet week</li>}</ul>;
}

/* -------------------------------------------------------------------------------- rank colour ----- */

/**
 * A week's place among everyone SoDEX ranked that week, as a colour step (owner 2026-11-27: "totalpoints per week
 * colored depending on users rank in that week"): top 0.1% gold, top 1% green, top 10% blue, the rest plain.
 */
export function rankStep(rank: number, users: number): { cls: string; label: string } | null {
  if (!(rank > 0) || !(users > 0)) return null;
  const p = (rank / users) * 100;
  if (p <= 0.1) return { cls: 'is-r1', label: 'Top 0.1%' };
  if (p <= 1) return { cls: 'is-r2', label: 'Top 1%' };
  if (p <= 10) return { cls: 'is-r3', label: 'Top 10%' };
  return { cls: 'is-r4', label: `Top ${Math.ceil(p)}%` };
}

/** "Top 0.61%": SoDEX's own words when it gave them, else rank over users. */
export const topText = (rank: number, users: number, given?: string): string => {
  if (given && /top/i.test(given)) return localize(given);
  if (!(rank > 0) || !(users > 0)) return DASH;
  const p = (rank / users) * 100;
  return localize(`Top ${p < 1 ? Number(p.toFixed(2)) : Math.ceil(p)}%`);
};

export function RankLegend() {
  return (
    <ul className="spx-legend spx-ranklegend" aria-label="Points coloured by rank that week">
      <li><i className="is-r1" />Top 0.1%</li><li><i className="is-r2" />Top 1%</li><li><i className="is-r3" />Top 10%</li><li><i className="is-r4" />Below</li>
    </ul>
  );
}

/* -------------------------------------------------------------------------------- week table ----- */

type SeasonPick = 'L1' | 'S1';
type TableView = 'simple' | 'detailed';

/** What the estimate says each scored week earned beyond its activity, by week number (sopointsEstimate EstCalib rows). */
export type OtherByWeek = ReadonlyMap<number, number> | null;

const OTHER_INFO = 'From ValueDesk’s estimate: own points beyond what the week’s trading, positions and holdings explain. '
  + 'Loyalty and consistency rewards, bug reports, campaigns, or the estimate’s own error: points SoDEX does not itemise.';

/**
 * Every week, simple by default (week, rank, points coloured by that week's rank); Detailed is the full row
 * (owner 2026-11-27) with the points the estimate cannot place in their own column.
 */
export function WeeksTable({ v, other }: { v: PointsView; other?: OtherByWeek }) {
  const phone = usePhone();
  const [season, setSeason] = useState<SeasonPick>('L1');
  const [view, setView] = useState<TableView>('simple');
  const [empty, setEmpty] = useState(false);
  const rows = useMemo(() => v.all.filter((r) => r.season === season && (empty || r.split.week.points > 0 || r.split.week.isLive)).reverse(), [v.all, season, empty]);
  const hasS1 = v.all.some((r) => r.season === 'S1');
  const detailed = view === 'detailed' && !phone;
  const oth = (r: AnyWeek) => (r.season === 'L1' && other ? other.get(r.split.week.weekNo) ?? null : null);
  if (v.s.loading && !v.all.length) return <div className="spx-skelrows">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="rf-skel-row" />)}</div>;
  return (
    <div className="spx-weeks">
      <div className="spx-weeks__bar">
        <SeasonSwitch value={season} onChange={setSeason} s1={hasS1} />
        {!phone && <Segmented<TableView> label="View" value={view} onChange={setView} options={[{ value: 'simple', label: 'Simple' }, { value: 'detailed', label: 'Detailed' }]} />}
        <button type="button" className="rf-text spx-weeks__empty" onClick={() => setEmpty(!empty)}>{empty ? 'Hide empty weeks' : 'Show empty weeks'}</button>
      </div>
      {!rows.length ? <EmptyState compact icon="clock" title="No weeks here yet" /> : phone ? (
        <ul className="rf-list spx-weeklist">
          {rows.map((r) => {
            const w = r.split.week;
            const tbd = w.pointsStatus !== 'CONFIRMED';
            const step = rankStep(w.rank, w.totalUser);
            return (
              <li key={r.key}>
                <span className="spx-wk">{r.short}</span>
                <span><b>{w.weekName}{w.isLive && <StatusPill size="sm" tone="positive" dot>Live</StatusPill>}</b><small>{w.rank ? `#${pts(w.rank)} · ${topText(w.rank, w.totalUser, w.rankPercentile)}` : 'Not ranked'}</small></span>
                <span className="rf-pay"><em className={`spx-rk ${step?.cls ?? ''}`}>{tbd ? 'TBD' : pts(w.points)}</em>{!tbd && r.split.referral > 0 && <small>{pts(r.split.referral)} invited</small>}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={`bots-tablewrap spx-tblwrap${detailed ? ' is-detailed' : ''}`}>
          <table className="bots-table spx-tbl">
            <thead>
              {detailed ? (
                <tr>
                  <th>Week</th><th className="right">Volume</th><th className="right">Open interest</th><th className="right">Holdings</th><th className="right">Rank</th>
                  {season === 'L1' && <th className="right">Squad</th>}<th className="right">Own</th>
                  {season === 'L1' && <th className="right"><span className="spx-tbl__info" title={OTHER_INFO} tabIndex={0} aria-label={`Loyalty and other. ${OTHER_INFO}`}>Loyalty &amp; other<Icon name="info" size={12} /></span></th>}
                  <th className="right">Invited</th><th className="right">Points</th>
                </tr>
              ) : <tr><th>Week</th><th className="right">Rank</th><th className="right">Place</th><th className="right">Points</th></tr>}
            </thead>
            <tbody>
              {rows.map((r) => {
                const w = r.split.week;
                const tbd = w.pointsStatus !== 'CONFIRMED';
                const hold = (w.wealthTvl ?? 0) + (w.vaultHolding ?? 0);
                const step = rankStep(w.rank, w.totalUser);
                const o = oth(r);
                const pointsCell = <td className="right num spx-tbl__pts"><span className={`spx-rk ${tbd ? '' : step?.cls ?? ''}`}>{tbd ? 'TBD' : pts(w.points)}</span></td>;
                const weekCell = <td><span className="spx-tbl__wk"><b>{w.weekName}</b>{w.isLive && <StatusPill size="sm" tone="positive" dot>Live</StatusPill>}<small>{weekRange(w.weekStartTime)}</small></span></td>;
                if (!detailed) {
                  return (
                    <tr key={r.key} className={w.isLive ? 'is-live' : undefined}>
                      {weekCell}
                      <td className="right num">{w.rank ? `#${pts(w.rank)}` : DASH}</td>
                      <td className="right num">{w.rank ? topText(w.rank, w.totalUser, w.rankPercentile) : DASH}</td>
                      {pointsCell}
                    </tr>
                  );
                }
                return (
                  <tr key={r.key} className={w.isLive ? 'is-live' : undefined}>
                    {weekCell}
                    <td className="right num">{r.split.volume ? money(r.split.volume) : DASH}</td>
                    <td className="right num">{w.oi ? money(w.oi) : DASH}</td>
                    <td className="right num">{hold >= 1 ? money(hold) : DASH}</td>
                    <td className="right num">{w.rank ? `#${pts(w.rank)}` : DASH}</td>
                    {season === 'L1' && <td className={`right num${w.totalBonusPct ? ' pos' : ''}`}>{plusPct(w.totalBonusPct ?? 0)}</td>}
                    <td className="right num">{tbd ? DASH : pts(r.split.own)}</td>
                    {season === 'L1' && <td className="right num">{tbd || o === null ? DASH : o >= 0.5 ? <span className="spx-other">≈ {ptsEst(o)}</span> : '0'}</td>}
                    <td className="right num">{tbd ? DASH : pts(r.split.referral)}</td>
                    {pointsCell}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="spx-weeks__foot">
        <RankLegend />
        {detailed && season === 'L1' && <small className="spx-weeks__note"><Icon name="info" size={12} />Loyalty &amp; other is an estimate: points SoDEX gave beyond what the week’s activity explains.</small>}
      </div>
    </div>
  );
}

function SeasonSwitch({ value, onChange, s1 }: { value: SeasonPick; onChange: (v: SeasonPick) => void; s1: boolean }) {
  return <Segmented<SeasonPick> label="Season" value={value} onChange={onChange} options={[{ value: 'L1', label: 'Layer 1' }, { value: 'S1', label: 'Season 1', disabled: !s1 }]} />;
}

/* -------------------------------------------------------------------------------- the levers ----- */

export interface Plan { futures: number; spot: number; oi: number; boostedShare: number; squadPct: number; wealth?: number; vault?: number }
export interface Lever { id: string; icon: IconName; title: string; line: string; gain: number | null; value: string; est: boolean; href: string; go: string }

/** A plan as the estimate reads it (SoDEX's boosted coefficient applied by the server). */
export const estPlan = (p: Plan, coef: number): EstPlan => ({ futures: p.futures, spot: p.spot, oi: p.oi, wealth: p.wealth ?? 0, vault: p.vault ?? 0, boostedShare: p.boostedShare, coef });

/** The plans the levers compare, in this order: the plan, all of it on boosted markets, $1K more held, $10K moved to spot, $10K more futures. */
export function leverPlans(p: Plan, coef: number): EstPlan[] {
  return [
    estPlan(p, coef),
    estPlan({ ...p, boostedShare: 1 }, coef),
    estPlan({ ...p, oi: p.oi + 1000 }, coef),
    estPlan(p.futures >= 10_000 ? { ...p, futures: p.futures - 10_000, spot: p.spot + 10_000 } : p, coef),
    estPlan({ ...p, futures: p.futures + 10_000 }, coef),
  ];
}

/**
 * What would move this week's points most, ranked by points gained: the squad's next step, boosted markets, a held
 * position, spot. `bands` are the server's answers for leverPlans (null while they load: the rows show without figures).
 * Each row goes where it is done (owner 2026-11-27: squad and invites to the Referrals page, trading to the trade page).
 */
export function levers(p: Plan, coef: number, squad: SquadBreakdown | null, cfg: BoostConfig | null, lastRef: number | null, bands: readonly EstBand[] | null, boostedSymbol: string | null): Lever[] {
  const mult = 1 + p.squadPct / 100;
  const ok = bands && bands.length >= 5;
  const base = ok ? bands[0]!.mid : null;
  const gainAt = (i: number) => (ok ? (bands[i]!.mid - bands[0]!.mid) * mult : null);
  const out: Lever[] = [];
  if (cfg) {
    const steps = [squad?.built.next && { who: 'your squad', ...squad.built.next, from: squad.built.pct }, squad?.joined.next && squad.joined.volume > 0 && { who: 'the squad you joined', ...squad.joined.next, from: squad.joined.pct }]
      .filter(Boolean) as Array<{ who: string; threshold: number; pct: number; missing: number; from: number }>;
    const best = steps.sort((a, b) => a.missing - b.missing)[0];
    if (best) out.push({ id: 'squad', icon: 'layers', title: `Next squad step, ${plusPct(best.pct)}`, line: `${money(best.missing)} more in ${best.who} over ${cfg.windowRounds} weeks lifts every point`, gain: base !== null ? base * ((best.pct - best.from) / 100) : null, value: '', est: true, href: '/referrals', go: 'Grow your squad' });
    else if (!squad) { const first = stepsOf(cfg)[0]; if (first) out.push({ id: 'squad', icon: 'layers', title: `A squad, up to ${plusPct(cfg.maxTotalBonusPct)}`, line: `From ${money(Number(first.threshold))} a squad's volume adds ${plusPct(first.bonusPct)} to every point`, gain: base !== null ? base * (first.bonusPct / 100) : null, value: '', est: true, href: '/referrals', go: 'Build a squad' }); }
  }
  const trade = (sym: string | null) => (sym ? `/trade?symbol=${encodeURIComponent(sym)}` : '/trade');
  if (coef > 1 && p.futures > 0 && p.boostedShare < 1) out.push({ id: 'boosted', icon: 'bolt', title: `Boosted markets, ${coefText(coef)}`, line: 'Trade the same futures volume on the boosted markets', gain: gainAt(1), value: '', est: true, href: trade(boostedSymbol), go: boostedSymbol ? `Trade ${boostedSymbol.replace(/-USD$/, '')}` : 'Trade' });
  out.push({ id: 'hold', icon: 'clock', title: 'Hold a $1K position all week', line: 'Open interest counts every hour a position is open', gain: gainAt(2), value: '', est: true, href: '/trade', go: 'Open a position' });
  if (p.futures >= 10_000) out.push({ id: 'spot', icon: 'coins', title: 'Move $10K from futures to spot', line: 'Spot volume counts more than futures', gain: gainAt(3), value: '', est: true, href: '/trade', go: 'Trade spot' });
  out.push({ id: 'more', icon: 'chart', title: 'Trade $10K more futures', line: 'Volume earns less per dollar as it grows', gain: gainAt(4), value: '', est: true, href: '/trade', go: 'Trade' });
  out.sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0));
  out.push({ id: 'invite', icon: 'share', title: 'Invite traders', line: lastRef ? `Your invitees earned you ${pts(lastRef)} last week, before your squad's boost` : 'You get 25% of what they earn, they get +5%', gain: null, value: '25%', est: false, href: '/referrals', go: 'Invite' });
  return out.map((l) => ({ ...l, value: l.value || (l.gain !== null ? `+${ptsEst(Math.max(0, l.gain))}` : '') }));
}

/** A slider's 0..STEPS on a log scale from 10^lo to 10^hi, two significant figures; 0 is $0 when `zero` (the landing calculator's). */
export const STEPS = 1000;
export const logScale = (lo: number, hi: number, zero = false) => ({
  of: (t: number): number => { if (zero && t === 0) return 0; const x = 10 ** (lo + ((hi - lo) * t) / STEPS); const m = 10 ** (Math.floor(Math.log10(x)) - 1); return Math.round(x / m) * m; },
  t: (usd: number): number => (usd <= 0 ? 0 : Math.max(zero ? 1 : 0, Math.min(STEPS, Math.round(((Math.log10(usd) - lo) / (hi - lo)) * STEPS)))),
});

/** The pill every estimated figure carries. */
export function EstPill() {
  return <StatusPill size="sm" tone="neutral" title="ValueDesk’s estimate from SoDEX’s scored weeks, not a SoDEX figure">Estimate</StatusPill>;
}

export { fmt, DASH };
