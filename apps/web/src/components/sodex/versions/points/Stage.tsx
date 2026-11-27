/**
 * SoPoints, version "Stage" (localhost only, owner 2026-11-26). The Referrals page's own layout carried over: a dark
 * stage with three cards in a row: SoDEX's tier card (its Share opens the page's share dialog), SoDEX's season card
 * (bare: no "is Live", "Split this week" or snapshot times) and this week's SoPoints, estimated, with its range drawn
 * under the number and the plan's sliders behind Adjust.
 *
 * Under it the tier ladder; the desk (this week so far, the weeks as Total with SoDEX's tiers on the axis, Weekly,
 * Invited or Rank, with a projection to the season's end; what earns more, each row linked to where it is done);
 * Original's analytics; the squads (SoDEX's block: names, members, naming once, joining by code) and boosted markets;
 * every week, simple or detailed.
 *
 * Owner 2026-11-27: the estimate is the server's (sopointsEstimate.ts: "our formula cant be in the frontend code"),
 * made the wallet's own by its scored weeks ("include the users previous data ... points for 0 activity"), and it
 * drives the live card, the levers, the projection and the table's "Loyalty & other" column.
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Eip1193Provider } from '../../../../wallet';
import { useTilt } from '../../../../tilt';
import { RULES } from '../../../../points';
import { Icon, IconTile, Segmented, Skeleton, Slider, Switch } from '../../../bots/kit/kit';
import { HeatGrid } from '../../../referrals/CreditCalendar';
import { pointsGrid } from '../../../referrals/calendar';
import { SeasonCard, SoPointsCard, TIER_STYLE } from '../../SoPointsMine';
import { estWeeks, useEstimate, type EstAnswer, type EstState } from '../../sopointsEstimate';
import { Climb, Ladder } from './Season';
import { Field, START, planOf } from './Planner';
import { PointsShare } from './PointsShare';
import { Squads } from './Squads';
import {
  BOT_MARKETS, BarsLegend, BoostedMarkets, DASH, EstPill, SignInButton, SignInPanel, WeekBars, WeekPill, WeeksTable,
  STEPS, aheadOf, boostedOf, coefText, estPlan, leverPlans, levers, logScale, money, plusPct, pts, ptsEst, stepsFor, useSignIn, usePointsView, usualOf,
  type Ahead, type BarMetric, type Plan, type PointsView, type Steps,
} from './shared';
import './points.css';

export function Stage({ address, provider, sample }: { address: string | null; provider: Eip1193Provider | null; sample: boolean }) {
  const v = usePointsView(address, provider, sample);
  const { c, week } = v;
  const id = useId();
  // The tier's own colour glows softly behind its card; signed out, a neutral light (owner 2026-11-26: no colour the stage does not show).
  const glow = v.mine ? TIER_STYLE[v.tier]!.border : '#d4d4d2';
  const share = boostedShare(v);
  // The cards lean a little toward the mouse (owner 2026-11-26), as the VIP pass does.
  const tierTilt = useTilt(6, 5, 0.5);
  const seasonTilt = useTilt(6, 5, 0.5);
  const live = useLivePlan(v);
  const [adjust, setAdjust] = useState(false);
  const [sharing, setSharing] = useState(false);
  const b = boostedOf(c);
  // One question to the server per change: this week's plan and the levers' plans, with the wallet's scored weeks.
  const weeksIn = useMemo(() => (v.mine ? estWeeks(v.all) : null), [v.mine, v.all]);
  // The levers' steps follow the wallet's usual week (the median of its last four), not the plan's sliders.
  const steps = useMemo(() => stepsFor(usualOf(v.mine ? v.all : [], START)), [v.mine, v.all]);
  const plans = useMemo(() => leverPlans(live.plan, b.coef, steps), [live.plan, b.coef, steps]);
  const aheadN = week ? Math.max(0, RULES.seasonWeeks - week.weekNo) : 0;
  const est = useEstimate(plans, weeksIn, { debounceMs: 160, ahead: aheadN, keepKey: v.sample ? null : v.mine && c.address ? `stage:${c.address.toLowerCase()}` : 'stage:out' });
  const wk = weekEstimate(est.data, live.plan.squadPct, v.mine);
  // This week by the estimate, the weeks after it by the wallet's own trend (short and long blended, damped).
  const ahead: Ahead | null = useMemo(() => (wk && week ? aheadOf(week.weekNo, RULES.seasonWeeks, wk, v.mine ? est.data?.calib?.trend ?? null : null) : null), [wk?.mid, wk?.busy, wk?.quiet, week, v.mine, est.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const other = useMemo(() => (est.data?.calib ? new Map(est.data.calib.rows.map((r) => [r.weekNo, r.other])) : null), [est.data]);
  return (
    <div className="tf bots-page rf-page sx spx">
      <div className="bots-col">
        <section className="rf-dark spx-st" style={{ '--spx-glow': glow } as CSSProperties}>
          <span className="spx-st__light" aria-hidden="true" />
          <div className="spx-st__k">
            <h1>SoPoints</h1>
            <WeekPill week={week} />
          </div>
          {/* SoDEX's own two cards (the season card bare: no "is Live", "Split this week" or snapshot times, owner
              2026-11-27) and this week's live SoPoints: three cards of one size. */}
          <div className={`spx-st__cards${v.mine ? '' : ' is-out'}`}>
            {v.mine ? <div className="spx-tilt tf-tilt" ref={tierTilt.ref} onPointerMove={tierTilt.onMove} onPointerLeave={tierTilt.onLeave}><SoPointsCard s={v.s} onShare={() => setSharing(true)} /></div> : <SignInFront v={v} />}
            <div className="spx-tilt tf-tilt" ref={seasonTilt.ref} onPointerMove={seasonTilt.onMove} onPointerLeave={seasonTilt.onLeave}><SeasonCard week={week} address={address} settled={c.publicSettled} bare /></div>
            <LiveCard v={v} live={live} est={est} adjust={adjust} onAdjust={() => setAdjust(!adjust)} controls={id} />
          </div>
          {/* The plan's settings, shut until asked for (owner 2026-11-27: "Hide any sliders or settings per default"). */}
          <div id={id} className={`spx-adj${adjust ? ' is-open' : ''}`} {...(adjust ? {} : { inert: '' })}>
            <div className="spx-adj__clip"><PlanFields v={v} live={live} model={est.data?.model ?? null} /></div>
          </div>
        </section>

        {/* Season's hero: the tier ladder with the wallet's place. */}
        <Ladder v={v} figures={false} />

        <div className="spx-desk">
          {v.mine ? <MineCol v={v} /> : <PublicCol v={v} />}
          {/* Signed out, the weeks wait for a sign-in; what a week earns is the live card's (its sliders shut, owner 2026-11-27). */}
          <section className="spx-panel" aria-label="Your weeks">{v.mine ? <WeeksPanel v={v} ahead={ahead} /> : <SignInPanel c={c} line={c.address ? 'Your weeks, as SoDEX scored them' : undefined} />}</section>
          <EarnMore v={v} plan={live.plan} est={est} steps={steps} refEst={v.mine ? est.data?.calib?.referral ?? 0 : 0} />
        </div>

        <div className="spx-duo">
          <Squads v={v} />
          <section className="sx-sec spx-box" aria-label="Boosted markets">
            <header className="sx-sec__h">
              <div>
                <h2>Boosted markets</h2>
                <p>
                  {c.weights ? `Count ${coefText(b.coef)} until ${new Date(c.weights.round.end_ts_ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.` : 'This round’s markets.'}
                  {share && ` ${share.pct}% of your futures volume in ${share.week} was on boosted markets.`}
                </p>
              </div>
            </header>
            <BoostedMarkets c={c} />
          </section>
        </div>

        {v.mine && (
          <section className="sx-sec" aria-label="Every week">
            <header className="sx-sec__h"><div><h2>Every week</h2><p>SoDEX’s own rows, both seasons. Detailed adds every figure and the points the estimate cannot place.</p></div></header>
            <WeeksTable v={v} other={other} />
          </section>
        )}
      </div>
      {sharing && v.mine && <PointsShare v={v} week={wk} onClose={() => setSharing(false)} />}
    </div>
  );
}

/**
 * This week's points from the server's answer (plans[0] = the plan): own points, the wallet's usual invited points on
 * top (its last weeks', SoDEX's figure), times the squad's boost (SoDEX's rule: (own + invited) x (1 + boost)).
 */
function weekEstimate(a: EstAnswer | null, squadPct: number, mine: boolean): { mid: number; busy: number; quiet: number; ref: number; extra: number; weeks: number } | null {
  const p = a?.plans[0];
  if (!p) return null;
  const ref = mine ? a!.calib?.referral ?? 0 : 0;
  const m = 1 + squadPct / 100;
  return { mid: (p.mid + ref) * m, busy: (p.busy + ref) * m, quiet: (p.quiet + ref) * m, ref, extra: mine ? a!.calib?.extra ?? 0 : 0, weeks: mine ? a!.calib?.weeks ?? 0 : 0 };
}

/** The share of the last scored Layer 1 week's futures volume that SoDEX weighted as boosted (its weight details). */
function boostedShare(v: PointsView): { pct: number; week: string } | null {
  if (!v.mine) return null;
  const w = [...v.scored].reverse().find((x) => x.season === 'L1')?.split.week;
  if (!w || !(w.futuresVolume > 0)) return null;
  const raw = (w.futuresVolumeWeightDetails ?? []).reduce((t, d) => t + (Number(d.rawVolumeU) || 0), 0);
  return { pct: Math.round((raw / w.futuresVolume) * 100), week: w.weekName };
}

/* --------------------------------------------------------------------------------------- the stage ----- */

/** Signed out, beside the season card: what a sign-in shows, and the one button. */
function SignInFront({ v }: { v: PointsView }) {
  const a = useSignIn(v.c);
  return (
    <div className="spx-st__t">
      <h2>Your tier, your rank and every week.</h2>
      <div className="rf-bar is-big">
        <div className="rf-bar__in">
          <span className={`rf-linktext is-empty${a.connect && !v.c.address ? ' is-connect' : ''}`}>{v.c.address ? 'Sign SoDEX’s message once to see yours' : 'Connect a wallet to see yours'}</span>
          <SignInButton c={v.c} />
        </div>
      </div>
      <p className="spx-st__fine">{a.error ? <span className="neg" role="alert">{a.error}</span> : 'Free: no transaction, no gas, no funds move.'}</p>
    </div>
  );
}

/* ------------------------------------------------------------------------ this week, live ----- */

interface LivePlan {
  plan: Plan;
  /** The week the plan was filled from (SoDEX's name), or null once a slider moved it. */
  from: string | null;
  /** The wallet's last scored Layer 1 week, to fill from again. */
  last: { key: string; name: string } | null;
  set: (p: Partial<Plan>) => void;
  reset: () => void;
}

/**
 * This week's plan: the wallet's last scored Layer 1 week as SoDEX scored it (its volumes, open interest, the share on
 * boosted markets and the squad's boost now; Planner.tsx planOf), or a $100K futures week signed out. A slider moves it.
 */
function useLivePlan(v: PointsView): LivePlan {
  const lastL1 = useMemo(() => [...v.all].reverse().find((w) => w.season === 'L1' && w.split.week.pointsStatus === 'CONFIRMED') ?? null, [v.all]);
  const [plan, setPlan] = useState<Plan>(START);
  const [from, setFrom] = useState<string | null>(null);
  const filled = useRef(false);
  const fill = () => {
    if (!lastL1) return;
    setPlan(planOf(lastL1.split.week, v.squad?.total ?? null));
    setFrom(lastL1.split.week.weekName);
  };
  useEffect(() => {
    if (!v.mine) { filled.current = false; setFrom(null); setPlan(START); return; }
    if (filled.current || !lastL1) return;
    filled.current = true;
    fill();
  }, [v.mine, lastL1, v.squad]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    plan,
    from,
    last: lastL1 ? { key: lastL1.key, name: lastL1.split.week.weekName } : null,
    set: (p) => { setPlan((x) => ({ ...x, ...p })); setFrom(null); },
    reset: () => { if (lastL1) fill(); else { setPlan(START); setFrom(null); } },
  };
}

/**
 * Live SoPoints (owner 2026-11-27: "the element should automatically get user estimate & fast"): this week's points by
 * ValueDesk's estimate, which the server answers from the plan above and, signed in, the wallet's own scored weeks (what
 * it earns in a quiet week, its usual invitee points, its usual distance from the model). The squad's boost is on top.
 * Under the number, the range as a small chart (owner: "Quiet week ... busy week ... What is this? Show a range chart").
 */
function LiveCard({ v, live, est, adjust, onAdjust, controls }: { v: PointsView; live: LivePlan; est: EstState; adjust: boolean; onAdjust: () => void; controls: string }) {
  const coef = boostedOf(v.c).coef;
  const { plan } = live;
  const tilt = useTilt(6, 5, 0.5);
  const wk = weekEstimate(est.data, plan.squadPct, v.mine);
  const source = live.from ? `From your ${live.from}` : plan === START ? `From a ${money(plan.futures)} futures week` : 'From your plan';
  const inputs = [
    { k: 'Futures', v: money(plan.futures) },
    ...(plan.spot > 0 ? [{ k: 'Spot', v: money(plan.spot) }] : []),
    { k: 'Position', v: plan.oi ? money(plan.oi) : '$0' },
    ...((plan.wealth ?? 0) + (plan.vault ?? 0) >= 1 ? [{ k: 'Holdings', v: money((plan.wealth ?? 0) + (plan.vault ?? 0)) }] : []),
    ...(coef > 1 && plan.boostedShare > 0 ? [{ k: 'Boosted', v: `${Math.round(plan.boostedShare * 100)}%` }] : []),
    { k: 'Squad', v: plusPct(plan.squadPct) },
  ];
  return (
    <div className="spx-tilt tf-tilt" ref={tilt.ref} onPointerMove={tilt.onMove} onPointerLeave={tilt.onLeave}>
      <section className="spx-card spx-live" aria-label="SoPoints this week, estimated" aria-busy={est.loading || undefined}>
        <div className="spx-live__top">
          <span className="spx-live__k">This week</span>
          <EstPill />
        </div>
        <div className="spx-live__n">
          {wk ? <b className={`sx-num${est.loading ? ' is-stale' : ''}`}>≈ {ptsEst(wk.mid)}</b> : est.failed ? <b className="sx-num is-none">{DASH}</b> : <Skeleton className="spx-live__skel" />}
          <span>{est.failed && !wk ? 'No estimate right now' : 'SoPoints'}</span>
        </div>
        {wk ? <RangeChart busy={wk.busy} mid={wk.mid} quiet={wk.quiet} /> : <div className="spx-range is-wait" aria-hidden="true" />}
        <div className="spx-live__foot">
          <div className="spx-live__src">
            <span>{source}</span>
            <ul>{inputs.map((x) => <li key={x.k}><small>{x.k}</small><b className="sx-num">{x.v}</b></li>)}</ul>
          </div>
          <button type="button" className={`spx-live__adj${adjust ? ' is-on' : ''}`} aria-expanded={adjust} aria-controls={controls} onClick={onAdjust}>
            <Icon name="gear" size={14} />{adjust ? 'Done' : 'Adjust'}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * The week's range as a small chart: a scale from 0, the busy-to-quiet band on it and the typical week marked, the two
 * ends named. The "?" says what the range is.
 */
function RangeChart({ busy, mid, quiet }: { busy: number; mid: number; quiet: number }) {
  const max = Math.max(1, quiet * 1.12);
  const at = (x: number) => `${(x / max) * 100}%`;
  const tip = useId();
  return (
    <div className="spx-range" role="img" aria-label={`Busy week ${ptsEst(busy)}, typical ${ptsEst(mid)}, quiet week ${ptsEst(quiet)} SoPoints`}>
      <div className="spx-range__plot" aria-hidden="true">
        <span className="spx-range__axis" />
        <span className="spx-range__band" style={{ left: at(busy), width: `${((quiet - busy) / max) * 100}%` }} />
        <span className="spx-range__mid" style={{ left: at(mid) }} />
        <span className="spx-range__end is-busy" style={{ left: at(busy) }} />
        <span className="spx-range__end is-quiet" style={{ left: at(quiet) }} />
      </div>
      <div className="spx-range__ends">
        <span><small><i className="is-busy" />Busy week</small><b className="sx-num">{ptsEst(busy)}</b></span>
        <span><small><i className="is-mid" />Typical</small><b className="sx-num">{ptsEst(mid)}</b></span>
        <span><small><i className="is-quiet" />Quiet week</small><b className="sx-num">{ptsEst(quiet)}</b></span>
      </div>
      <span className="spx-qs">
        <button type="button" aria-describedby={tip} aria-label="What is this range?">?</button>
        <span id={tip} role="tooltip" className="spx-qs__tip">SoDEX splits 900,000 SoPoints every week. When everyone trades more, the same week earns fewer points (a busy week); when they trade less, more (a quiet week). The range runs from the season’s busiest week to its quietest so far.</span>
      </span>
    </div>
  );
}

const FUT = logScale(3, 7, true);
const SPOT = logScale(2, 6, true);
const HELD = logScale(2, 6, true);

/** The plan's sliders (Planner's), in a row under the cards; and the way back to the week it was filled from. */
function PlanFields({ v, live, model }: { v: PointsView; live: LivePlan; model: EstAnswer['model'] | null }) {
  const { c } = v;
  const b = boostedOf(c);
  const { plan, set } = live;
  const maxSquad = c.boost?.maxTotalBonusPct ?? 50;
  return (
    <div className="spx-adj__in">
      <div className="spx-adj__fields">
        <Field label="Futures volume" value={plan.futures ? money(plan.futures) : '$0'}>
          <Slider value={FUT.t(plan.futures)} min={0} max={STEPS} onChange={(t) => set({ futures: FUT.of(t) })} label={`Futures volume this week: ${money(plan.futures)}`} minLabel="$0" maxLabel="$10M" />
        </Field>
        <Field label="Spot volume" value={plan.spot ? money(plan.spot) : '$0'}>
          <Slider value={SPOT.t(plan.spot)} min={0} max={STEPS} onChange={(t) => set({ spot: SPOT.of(t) })} label={`Spot volume this week: ${money(plan.spot)}`} minLabel="$0" maxLabel="$1M" />
        </Field>
        <Field label="Position held, on average" value={plan.oi ? money(plan.oi) : '$0'}>
          <Slider value={HELD.t(plan.oi)} min={0} max={STEPS} onChange={(t) => set({ oi: HELD.of(t) })} label={`Average open position this week: ${money(plan.oi)}`} minLabel="$0" maxLabel="$1M" />
        </Field>
        {b.coef > 1 ? (
          <Field label={`On boosted markets, ${coefText(b.coef)}`} value={`${Math.round(plan.boostedShare * 100)}%`}>
            <Slider value={Math.round(plan.boostedShare * 100)} min={0} max={100} step={5} onChange={(x) => set({ boostedShare: x / 100 })} label="Share of the futures volume on boosted markets" minLabel="0%" maxLabel="100%" />
          </Field>
        ) : <Field label="Boosted markets" value={c.weights ? 'None now' : DASH}><p className="spp-none">No market counts more this round.</p></Field>}
        <Field label={v.mine ? 'Squad boost, yours now' : 'Squad boost'} value={plusPct(plan.squadPct)}>
          <Slider value={plan.squadPct} min={0} max={maxSquad} step={5} onChange={(x) => set({ squadPct: x })} label="Squad boost" minLabel="0%" maxLabel={plusPct(maxSquad)} />
        </Field>
      </div>
      <div className="spx-adj__foot">
        <p>ValueDesk’s estimate{model ? `, fitted on ${model.fittedOn} (${model.fittedAt})` : ''}{v.mine ? ', made yours by your scored weeks' : ''}. SoDEX publishes no formula.</p>
        {(live.last || !v.mine) && (
          <button type="button" className="rf-howbtn" onClick={live.reset} disabled={live.from !== null && live.from === live.last?.name}>
            {live.last ? `Back to your ${live.last.name}` : 'Back to a $100K week'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------- the desk ----- */

function MineCol({ v }: { v: PointsView }) {
  const last = v.last;
  const traded = [...v.scored].reverse().find((w) => w.split.dollarsPerPoint !== null) ?? null;
  const s1 = v.s.s1.reduce((t, w) => t + (w.pointsStatus === 'CONFIRMED' ? w.points : 0), 0);
  const live = v.live;
  const hold = live ? (live.wealthTvl ?? 0) + (live.vaultHolding ?? 0) : 0;
  const tilt = useTilt<HTMLElement>(6, 5, 0.5);
  return (
    <div className="spx-col1">
      {/* The week in progress, SoDEX's own figures so far; its points are not estimated (Original veils that "Coming soon"). */}
      <section className="rf-dark rf-cc spx-cc tf-tilt" aria-label="This week so far" ref={tilt.ref} onPointerMove={tilt.onMove} onPointerLeave={tilt.onLeave}>
        <span className="rf-cc__sheen" aria-hidden="true" />
        <div><img src="/logos/brand/sodex.svg" width="28" height="28" alt="" /><em>This week so far</em></div>
        <dl>
          <div><dt>Volume</dt><dd>{live ? money((live.futuresVolume || 0) + (live.spotVolume || 0)) : DASH}</dd></div>
          <div><dt>Open interest</dt><dd>{live?.oi ? money(live.oi) : DASH}</dd></div>
        </dl>
        <div><span>{live ? `Squad ${plusPct(live.totalBonusPct ?? 0)} · ${hold >= 1 ? `holding ${money(hold)}` : 'no holdings'}` : v.s.loading ? 'Reading…' : DASH}</span><span>{live?.weekName ?? DASH}</span></div>
      </section>
      <dl className="rf-kv">
        <div><dt>{last ? `${last.split.week.weekName}, last scored` : 'Last scored week'}</dt><dd className="pos">{last ? `+${pts(last.split.week.points)}` : DASH}</dd></div>
        {last && <div><dt>Own · invited · squad</dt><dd>{pts(last.split.own)} · {pts(last.split.referral)} · {pts(last.split.boost)}</dd></div>}
        <div><dt>Squad boost now</dt><dd className={v.squad?.total ? 'pos' : undefined}>{v.squad ? plusPct(v.squad.total) : DASH}</dd></div>
        <div title={traded ? `${traded.name}: your volume over your own points` : undefined}><dt>Your volume per point</dt><dd>{traded ? money(traded.split.dollarsPerPoint!) : DASH}</dd></div>
        <div><dt>Weeks scored</dt><dd>{v.scored.filter((w) => w.season === 'L1').length} in Layer 1</dd></div>
        {s1 > 0 && <div><dt>Season 1</dt><dd>{pts(s1)}</dd></div>}
      </dl>
    </div>
  );
}

/** Signed out: what SoDEX shows of the wallet publicly (its rank and volume), and what that volume is worth by our estimate. */
function PublicCol({ v }: { v: PointsView }) {
  const { c } = v;
  const days = c.window === '24H' ? 1 : c.window === '7D' ? 7 : 30;
  const st = c.standing;
  const week = st ? st.volumeUsd * (7 / days) : null;
  const plans = useMemo(() => (week !== null ? [estPlan({ futures: week, spot: 0, oi: 0, boostedShare: 0, squadPct: 0 }, 1)] : null), [week]);
  const e = useEstimate(plans, null).data?.plans[0] ?? null;
  const tilt = useTilt<HTMLElement>(6, 5, 0.5);
  return (
    <div className="spx-col1">
      <section className="rf-dark rf-cc spx-cc tf-tilt" aria-label="Your trading" ref={tilt.ref} onPointerMove={tilt.onMove} onPointerLeave={tilt.onLeave}>
        <span className="rf-cc__sheen" aria-hidden="true" />
        <div><img src="/logos/brand/sodex.svg" width="28" height="28" alt="" /><em>Your trading, {c.window}</em></div>
        {c.address ? (
          <dl>
            <div><dt>Volume</dt><dd>{st ? money(st.volumeUsd) : DASH}</dd></div>
            <div><dt>Rank</dt><dd>{st?.rank ? `#${pts(st.rank)}` : DASH}</dd></div>
          </dl>
        ) : <p className="spx-cc__empty">Your volume and rank on SoDEX, from public data, once a wallet is connected.</p>}
        <div><span>{c.address ? (st ? (c.ranked ? `of ${pts(c.ranked)} wallets` : 'by volume') : c.publicSettled ? 'No SoDEX volume yet' : 'Reading…') : 'No wallet'}</span><span>{c.address ? `${c.address.slice(0, 6)}…${c.address.slice(-4)}` : '0x•••• ••••'}</span></div>
      </section>
      {c.address && <dl className="rf-kv">
        <div><dt>A week like this, as futures</dt><dd>{week !== null ? money(week) : DASH}</dd></div>
        <div><dt>≈ own points a week <EstPill /></dt><dd>{e ? ptsEst(e.mid) : DASH}</dd></div>
        <div><dt>Busy to quiet week</dt><dd>{e ? `${ptsEst(e.busy)} – ${ptsEst(e.quiet)}` : DASH}</dd></div>
      </dl>}
    </div>
  );
}

type Show = 'chart' | 'calendar';

/**
 * The weeks (owner 2026-11-27: no "Mix"; "Total" = the season's points added up with SoDEX's tiers on its axis; a
 * projection switch continues Total and Weekly to the season's last week with this week's estimate).
 */
function WeeksPanel({ v, ahead }: { v: PointsView; ahead: Ahead | null }) {
  const [metric, setMetric] = useState<BarMetric>('total');
  const [show, setShow] = useState<Show>('chart');
  const [proj, setProj] = useState(false);
  const invited = v.scored.reduce((t, w) => t + w.split.referral, 0);
  const all = v.scored.reduce((t, w) => t + w.split.week.points, 0);
  const canProj = (metric === 'points' && show === 'chart') || metric === 'total';
  const a = proj && canProj ? ahead : null;
  const end = ahead ? all + ahead.weeks.reduce((t, x) => t + x.mid, 0) : null;
  return (
    <>
      <div className="rf-earn__bar spx-wbar">
        <Segmented<BarMetric> label="Show" value={metric} onChange={setMetric} options={[{ value: 'total', label: 'Total' }, { value: 'points', label: 'Weekly' }, { value: 'invited', label: 'Invited' }, { value: 'rank', label: 'Rank' }]} />
        {metric === 'points' && <Segmented<Show> label="As" value={show} onChange={setShow} options={[{ value: 'chart', label: 'Chart' }, { value: 'calendar', label: 'Calendar' }]} />}
        {canProj && <Switch className="spx-proj" checked={proj} onChange={setProj} label="Projection" disabled={!ahead} />}
      </div>
      <div className="rf-earn__figs">
        <div className="is-points" title="Every week SoDEX scored, both seasons (Closed Alpha not included)"><span><i />Scored weeks</span>{v.s.loading && !v.scored.length ? <Skeleton className="rf-skel-big" /> : <b>{pts(all)}</b>}</div>
        {a && end !== null
          ? <div className="is-est" title="This week's estimate, every week to the season's last"><span><i />Season end, est.</span><b>≈ {pts(end)}</b></div>
          : <div className="is-referral"><span><i />From invitees</span>{v.s.loading && !v.scored.length ? <Skeleton className="rf-skel-big" /> : <b>{pts(invited)}</b>}</div>}
      </div>
      {metric === 'points' && show === 'calendar'
        ? <HeatGrid caption="SoPoints by week" step="week" grid={(cols, offset) => pointsGrid(v.all, cols, offset)} />
        : metric === 'total' ? <Climb weeks={v.scored} ahead={a} />
        : <><BarsLegend metric={metric} ahead={!!a} /><WeekBars weeks={v.scored} metric={metric} ahead={a} /></>}
    </>
  );
}

/**
 * Ranked by points gained this week, against this week's plan (the live card's, so Adjust re-ranks them). Every row
 * goes where it is done (owner 2026-11-27: "earn more needs to have hover effects & e.g. clickable").
 */
function EarnMore({ v, plan, est, steps, refEst }: { v: PointsView; plan: Plan; est: EstState; steps: Steps; refEst: number }) {
  const { c } = v;
  const b = boostedOf(c);
  const bot = useRotating(BOT_MARKETS, 2600);
  const list = levers(plan, b.coef, v.mine ? v.squad : null, c.boost, v.mine ? v.last?.split.referral ?? null : null, est.data?.plans ?? null,
    { steps, refEst, boosted: b.rows.map((r) => r.symbol), bot });
  return (
    <section className="spx-earn" aria-label="Earn more">
      <div className="spx-earn__h"><h3>Earn more</h3><EstPill /></div>
      <p className="spx-earn__base">Points a week gained against this week’s plan.</p>
      <ul className="rf-list spx-levers">
        {list.map((l) => (
          <li key={l.id}>
            <a className="spx-lever" href={l.href} aria-label={`${l.title}: ${l.go}`}>
              <IconTile icon={l.icon} />
              <span><b key={l.id === 'bot' ? l.title : undefined} className={l.id === 'bot' ? 'spx-rot' : undefined}>{l.title}</b><small>{l.line}</small></span>
              <span className="rf-pay">{l.value ? <em className={l.gain !== null && l.gain > 0 ? 'is-credit' : undefined}>{l.value}</em> : l.est ? <Skeleton className="spx-lever__skel" /> : null}{l.gain !== null && <small>a week</small>}</span>
              <span className="spx-lever__go" aria-hidden="true">{l.go}<Icon name="arrowRight" size={13} /></span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One of `items` after another, every `ms` (the bot row's market). Stops while the tab is hidden. */
function useRotating<T>(items: readonly T[], ms: number): T {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => { if (!document.hidden) setI((x) => (x + 1) % items.length); }, ms);
    return () => window.clearInterval(t);
  }, [items.length, ms]);
  return items[i % items.length]!;
}
