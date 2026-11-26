/**
 * SoPoints, version "Stage" (localhost only, owner 2026-11-26). The Referrals page's own layout carried over: a dark
 * stage with three cards in a row (owner 2026-11-27: no "How it works", no multipliers bar under it, "like a card"):
 * SoDEX's tier card, SoDEX's season card and this week's live SoPoints, whose plan sliders open under the cards.
 *
 * Owner 2026-11-26: "Stage as a base, i need the original sopoints cards designs. I also want the hero element from
 * season implemented, points over season. Generally all analytics from original should be displayed somehow." So the
 * stage carries SoDEX's own two cards exactly as Original draws them (SoPointsMine: the tier card, and the season card
 * with the invite code and link); under it Season's tier ladder (the wallet's place, its pace, the weeks left); then the
 * desk (this week so far, the weeks as bars or a calendar, what earns more); then Original's analytics in Original's
 * cards: points over the season, where the points come from, and the cost per point against the venue's.
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Eip1193Provider } from '../../../../wallet';
import { useTilt } from '../../../../tilt';
import { Icon, IconTile, Segmented, Skeleton, Slider } from '../../../bots/kit/kit';
import { Card } from '../../../portfolio/parts';
import { HeatGrid } from '../../../referrals/CreditCalendar';
import { pointsGrid } from '../../../referrals/calendar';
import { SODEX_POOL_SHOWN, SeasonCard, SoPointsCard, TIER_STYLE } from '../../SoPointsMine';
import { DifficultyChart, PointsMix } from '../../pointsCharts';
import { Climb, Ladder } from './Season';
import { Field, START, planOf } from './Planner';
import {
  BarsLegend, BoostedMarkets, DASH, EstPill, SignInButton, SignInPanel, SquadLadder, SquadTracks, WeekBars, WeekPill, WeeksTable,
  SOPOINTS_MODEL, STEPS, bandOf, boostedOf, coefText, levers, logScale, money, planOwn, plusPct, pts, ptsEst, scoreOf, useSignIn, usePointsView,
  type BarMetric, type Plan, type PointsView,
} from './shared';

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
  return (
    <div className="tf bots-page rf-page sx spx">
      <div className="bots-col">
        <section className="rf-dark spx-st" style={{ '--spx-glow': glow } as CSSProperties}>
          <span className="spx-st__light" aria-hidden="true" />
          <div className="spx-st__k">
            <h1>SoPoints</h1>
            <WeekPill week={week} />
          </div>
          {/* SoDEX's own two cards, as Original draws them (the season card carries the pool, the snapshot clock and the
              invite code), and this week's live SoPoints: three cards of one size. */}
          <div className={`spx-st__cards${v.mine ? '' : ' is-out'}`}>
            {v.mine ? <div className="spx-tilt tf-tilt" ref={tierTilt.ref} onPointerMove={tierTilt.onMove} onPointerLeave={tierTilt.onLeave}><SoPointsCard s={v.s} /></div> : <SignInFront v={v} />}
            <div className="spx-tilt tf-tilt" ref={seasonTilt.ref} onPointerMove={seasonTilt.onMove} onPointerLeave={seasonTilt.onLeave}><SeasonCard week={week} address={address} settled={c.publicSettled} /></div>
            <LiveCard v={v} live={live} adjust={adjust} onAdjust={() => setAdjust(!adjust)} controls={id} />
          </div>
          {/* The plan's settings, shut until asked for (owner 2026-11-27: "Hide any sliders or settings per default"). */}
          <div id={id} className={`spx-adj${adjust ? ' is-open' : ''}`} {...(adjust ? {} : { inert: '' })}>
            <div className="spx-adj__clip"><PlanFields v={v} live={live} /></div>
          </div>
        </section>

        {/* Season's hero: the tier ladder with the wallet's place, its pace and the season's weeks left. */}
        <Ladder v={v} figures={false} />

        <div className="spx-desk">
          {v.mine ? <MineCol v={v} /> : <PublicCol v={v} />}
          {/* Signed out, the weeks wait for a sign-in; what a week earns is the live card's (its sliders shut, owner 2026-11-27). */}
          <section className="spx-panel" aria-label="Your weeks">{v.mine ? <WeeksPanel v={v} /> : <SignInPanel c={c} line={c.address ? 'Your weeks, as SoDEX scored them' : undefined} />}</section>
          <EarnMore v={v} />
        </div>

        {v.mine && <Analytics v={v} />}

        <div className="spx-duo">
          <section className="sx-sec spx-box" aria-label="Squad boost">
            <header className="sx-sec__h"><div><h2>{v.mine ? 'Your squads' : 'Squad boost'}</h2><p>Up to {c.boost ? plusPct(c.boost.maxTotalBonusPct) : DASH} on every point: the squad you joined plus the one you built.</p></div></header>
            {v.mine ? <SquadTracks v={v} /> : <SquadLadder cfg={c.boost} />}
            {c.boost && <p className="spx-note">$1 traded by a squad is 1 energy, counted over the last {c.boost.windowRounds} weeks.</p>}
          </section>
          <section className="sx-sec spx-box" aria-label="Boosted markets">
            <header className="sx-sec__h">
              <div>
                <h2>Boosted markets</h2>
                <p>
                  {c.weights ? `Count ${coefText(boostedOf(c).coef)} until ${new Date(c.weights.round.end_ts_ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.` : 'This round’s markets.'}
                  {share && ` ${share.pct}% of your futures volume in ${share.week} was on boosted markets.`}
                </p>
              </div>
            </header>
            <BoostedMarkets c={c} />
          </section>
        </div>

        {v.mine && (
          <section className="sx-sec" aria-label="Every week">
            <header className="sx-sec__h"><div><h2>Every week</h2><p>SoDEX’s own rows, both seasons.</p></div></header>
            <WeeksTable v={v} />
          </section>
        )}
      </div>
    </div>
  );
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
 * Live SoPoints (owner 2026-11-27: "add the Live SoPoints thing for this week, per default values of the last week are
 * used"): what this week earns by ValueDesk's fitted model, from the plan above, squad boost included, referral points
 * on top. Labelled an estimate; the inputs it uses are listed, and Adjust opens their sliders under the cards.
 */
function LiveCard({ v, live, adjust, onAdjust, controls }: { v: PointsView; live: LivePlan; adjust: boolean; onAdjust: () => void; controls: string }) {
  const coef = boostedOf(v.c).coef;
  const { plan } = live;
  const own = planOwn(plan, coef);
  const mult = 1 + plan.squadPct / 100;
  const tilt = useTilt(6, 5, 0.5);
  const on = v.week?.weekStatus === 'LIVE';
  const source = live.from ? `From your ${live.from}` : plan === START ? `From a ${money(plan.futures)} futures week` : 'From your plan';
  const inputs = [
    { k: 'Futures', v: money(plan.futures) },
    ...(plan.spot > 0 ? [{ k: 'Spot', v: money(plan.spot) }] : []),
    { k: 'Position', v: plan.oi ? money(plan.oi) : '$0' },
    ...(coef > 1 && plan.boostedShare > 0 ? [{ k: 'Boosted', v: `${Math.round(plan.boostedShare * 100)}%` }] : []),
    { k: 'Squad', v: plusPct(plan.squadPct) },
  ];
  return (
    <div className="spx-tilt tf-tilt" ref={tilt.ref} onPointerMove={tilt.onMove} onPointerLeave={tilt.onLeave}>
      <section className="spx-card spx-live" aria-label="Live SoPoints this week">
        <div className="spx-live__top">
          <span className={`spx-live__on${on ? '' : ' is-off'}`}><i />Live SoPoints{v.week ? ` · ${v.week.weekName}` : ''}</span>
          <EstPill />
        </div>
        <div className="spx-live__n"><b className="sx-num">≈ {ptsEst(own.mid * mult)}</b><span>this week</span></div>
        <small className="spx-live__band sx-num">Quiet week {ptsEst(own.low * mult)} · busy week {ptsEst(own.high * mult)}</small>
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

const FUT = logScale(3, 7, true);
const SPOT = logScale(2, 6, true);
const HELD = logScale(2, 6, true);

/** The plan's sliders (Planner's), in a row under the cards; and the way back to the week it was filled from. */
function PlanFields({ v, live }: { v: PointsView; live: LivePlan }) {
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
        <p>ValueDesk’s fit of {SOPOINTS_MODEL.fittedOn} ({SOPOINTS_MODEL.fittedAt}); SoDEX publishes no formula. Referral points come on top.</p>
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

/** Signed out: what SoDEX shows of the wallet publicly (its rank and volume), and what that volume is worth by our fit. */
function PublicCol({ v }: { v: PointsView }) {
  const { c } = v;
  const days = c.window === '24H' ? 1 : c.window === '7D' ? 7 : 30;
  const st = c.standing;
  const week = st ? st.volumeUsd * (7 / days) : null;
  const e = week !== null ? bandOf(scoreOf({ futures: week })) : null;
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
        <div><dt>Quiet to busy week</dt><dd>{e ? `${ptsEst(e.low)} – ${ptsEst(e.high)}` : DASH}</dd></div>
      </dl>}
    </div>
  );
}

type Show = 'chart' | 'calendar';

function WeeksPanel({ v }: { v: PointsView }) {
  const [metric, setMetric] = useState<BarMetric>('points');
  const [show, setShow] = useState<Show>('chart');
  const invited = v.scored.reduce((t, w) => t + w.split.referral, 0);
  const all = v.scored.reduce((t, w) => t + w.split.week.points, 0);
  return (
    <>
      <div className="rf-earn__bar">
        <Segmented<BarMetric> label="Show" value={metric} onChange={setMetric} options={[{ value: 'points', label: 'Points' }, { value: 'mix', label: 'Mix' }, { value: 'invited', label: 'Invited' }, { value: 'rank', label: 'Rank' }]} />
        {metric === 'points' && <Segmented<Show> label="As" value={show} onChange={setShow} options={[{ value: 'chart', label: 'Chart' }, { value: 'calendar', label: 'Calendar' }]} />}
      </div>
      <div className="rf-earn__figs">
        <div className="is-points" title="Every week SoDEX scored, both seasons (Closed Alpha not included)"><span><i />Scored weeks</span>{v.s.loading && !v.scored.length ? <Skeleton className="rf-skel-big" /> : <b>{pts(all)}</b>}</div>
        <div className="is-referral"><span><i />From invitees</span>{v.s.loading && !v.scored.length ? <Skeleton className="rf-skel-big" /> : <b>{pts(invited)}</b>}</div>
      </div>
      {metric === 'points' && show === 'calendar'
        ? <HeatGrid caption="SoPoints by week" step="week" grid={(cols, offset) => pointsGrid(v.all, cols, offset)} />
        : <><BarsLegend metric={metric} /><WeekBars weeks={v.scored} metric={metric} /></>}
    </>
  );
}

/** Ranked by points gained this week, from the wallet's own last week (or a $100K week signed out). */
function EarnMore({ v }: { v: PointsView }) {
  const { c } = v;
  const b = boostedOf(c);
  const plan: Plan = useMemo(() => {
    const w = v.last?.season === 'L1' ? v.last.split.week : null;
    if (w) return { futures: w.futuresVolume || 0, spot: w.spotVolume || 0, oi: w.oi ?? 0, boostedShare: 0, squadPct: v.squad?.total ?? w.totalBonusPct ?? 0 };
    const days = c.window === '24H' ? 1 : c.window === '7D' ? 7 : 30;
    const futures = c.standing ? Math.max(10_000, c.standing.volumeUsd * (7 / days)) : 100_000;
    return { futures, spot: 0, oi: 0, boostedShare: 0, squadPct: 0 };
  }, [v.last, v.squad, c.standing, c.window]);
  const list = levers(plan, b.coef, v.mine ? v.squad : null, c.boost, v.mine ? v.last?.split.referral ?? null : null);
  return (
    <section className="spx-earn" aria-label="Earn more">
      <div className="spx-earn__h"><h3>Earn more</h3><EstPill /></div>
      <p className="spx-earn__base">Points a week gained, from {v.mine && v.last?.season === 'L1' ? `your ${v.last.split.week.weekName}` : `a ${money(plan.futures)} futures week`}.</p>
      <ul className="rf-list spx-levers">
        {list.map((l) => (
          <li key={l.id}>
            <IconTile icon={l.icon} />
            <span><b>{l.title}</b><small>{l.line}</small></span>
            <span className="rf-pay"><em className={l.gain !== null && l.gain > 0 ? 'is-credit' : undefined}>{l.value}</em>{l.gain !== null && <small>a week</small>}</span>
          </li>
        ))}
      </ul>
      {/* Original's "Steady beats big" (soPointsV2 earnTips), the same fit. */}
      <p className="spx-note">Steady beats big: twice the volume earned about 1.6× the points in the weeks we measured, so trading every week earns more than the same volume in one.</p>
      <a className="spx-earn__go" href="/trade">Trade on ValueDesk<Icon name="arrowRight" size={14} /></a>
    </section>
  );
}

/* ------------------------------------------------------------------------- Original's analytics ----- */

/**
 * The analytics only Original had, in Original's own cards: points over the season (Season's chart, tier lines behind),
 * where the points come from (pointsCharts PointsMix) and the cost per point against the venue's (DifficultyChart).
 * With the Sample on, the cost chart reads no trade history: the wallet's side is the sample's, the venue's side SoDEX's.
 */
function Analytics({ v }: { v: PointsView }) {
  const pool = v.week?.weekPoolPoints ?? null;
  return (
    <div className="pf sdx spx-cards">
      <div className="spx-cards__row">
        <Card title="Points over the season" action={<span className="pf-unit">{v.scored.length} scored weeks</span>}>
          <Climb weeks={v.scored} />
        </Card>
        <PointsMix s={v.s} />
      </div>
      <DifficultyChart s={v.s} pool={pool} address={v.sample ? null : v.c.address} />
    </div>
  );
}
