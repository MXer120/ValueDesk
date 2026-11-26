/**
 * SoPoints, version "Stage" (localhost only, owner 2026-11-26). The Referrals page's own layout carried over: a dark
 * stage, "How it works" swapping three steps into its place, and the multipliers in the bar under it.
 *
 * Owner 2026-11-26: "Stage as a base, i need the original sopoints cards designs. I also want the hero element from
 * season implemented, points over season. Generally all analytics from original should be displayed somehow." So the
 * stage carries SoDEX's own two cards exactly as Original draws them (SoPointsMine: the tier card, and the season card
 * with the invite code and link); under it Season's tier ladder (the wallet's place, its pace, the weeks left); then the
 * desk (this week so far, the weeks as bars or a calendar, what earns more); then Original's analytics in Original's
 * cards: points over the season, where the points come from, and the cost per point against the venue's.
 */
import { useId, useMemo, useState, type CSSProperties } from 'react';
import type { Eip1193Provider } from '../../../../wallet';
import { useTilt } from '../../../../tilt';
import { WE_GET, YOU_GET } from '../../../../onboarding/referralRules';
import { TIERS } from '../../../../points';
import { Icon, IconTile, Segmented, Skeleton, Slider } from '../../../bots/kit/kit';
import { Card } from '../../../portfolio/parts';
import { HeatGrid } from '../../../referrals/CreditCalendar';
import { pointsGrid } from '../../../referrals/calendar';
import { SODEX_POOL_SHOWN, SeasonCard, SoPointsCard, TIER_STYLE } from '../../SoPointsMine';
import { DifficultyChart, PointsMix } from '../../pointsCharts';
import { Climb, Ladder } from './Season';
import {
  BarsLegend, BoostedMarkets, Clock, DASH, EstPill, SignInButton, SquadLadder, SquadTracks, TierName, WeekBars, WeekPill, WeeksTable,
  STEPS, bandOf, boostedOf, coefText, levers, logScale, money, plusPct, pts, ptsEst, scoreOf, tierProgress, useSignIn, usePointsView, weekday,
  type BarMetric, type Plan, type PointsView,
} from './shared';

export function Stage({ address, provider, sample }: { address: string | null; provider: Eip1193Provider | null; sample: boolean }) {
  const v = usePointsView(address, provider, sample);
  const { c, week } = v;
  const id = useId();
  const [how, setHow] = useState(false);
  const [toggled, setToggled] = useState(false);
  // The tier's own colour glows softly behind its card; signed out, a neutral light (owner 2026-11-26: no colour the stage does not show).
  const glow = v.mine ? TIER_STYLE[v.tier]!.border : '#d4d4d2';
  const share = boostedShare(v);
  // The cards lean a little toward the mouse (owner 2026-11-26), as the VIP pass does.
  const tierTilt = useTilt(6, 5, 0.5);
  return (
    <div className="tf bots-page rf-page sx spx">
      <div className="bots-col">
        <section className={`rf-dark spx-st${how ? ' is-how' : ''}${toggled ? ' is-toggled' : ''}`} style={{ '--spx-glow': glow } as CSSProperties}>
          <span className="spx-st__light" aria-hidden="true" />
          <div className="spx-st__k">
            <h1>SoPoints</h1>
            <WeekPill week={week} />
            <button type="button" className="rf-howbtn" aria-expanded={how} aria-controls={id} onClick={() => { setHow(!how); setToggled(true); }}>
              {how ? 'Close' : 'How it works'}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={how ? 'm4.5 4.5 7 7m0-7-7 7' : 'm4 6 4 4 4-4'} /></svg>
            </button>
          </div>
          <div className="spx-st__body">
            {/* SoDEX's own cards, as Original draws them; the season card carries the pool, the snapshot clock and the invite code. */}
            <div className={`spx-st__front spx-st__cards${v.mine ? '' : ' is-out'}`} aria-hidden={how} {...(how ? { inert: '' } : {})}>
              {v.mine ? <div className="spx-tilt tf-tilt" ref={tierTilt.ref} onPointerMove={tierTilt.onMove} onPointerLeave={tierTilt.onLeave}><SoPointsCard s={v.s} /></div> : <SignInFront v={v} />}
              <SeasonCard week={week} address={address} settled={c.publicSettled} />
            </div>
            <div className="spx-st__steps" id={id} aria-hidden={!how} {...(how ? {} : { inert: '' })}><How v={v} /></div>
          </div>
          <Multipliers v={v} />
        </section>

        {/* Season's hero: the tier ladder with the wallet's place, its pace and the season's weeks left. */}
        <Ladder v={v} figures={false} />

        <div className="spx-desk">
          {v.mine ? <MineCol v={v} /> : <PublicCol v={v} />}
          <section className="spx-panel" aria-label={v.mine ? 'Your weeks' : 'What a week earns'}>{v.mine ? <WeeksPanel v={v} /> : <WeekEstimate />}</section>
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

/** The three steps, each with its own real figures. */
function How({ v }: { v: PointsView }) {
  const { c, week } = v;
  const b = boostedOf(c);
  const prog = tierProgress(v.mine ? v.total : null);
  return (
    <section className="rf-steps spx-how" aria-label="How SoPoints work">
      <article>
        <h2><i>1</i>Trade and hold</h2>
        <p>Volume, open positions and holdings earn. Some markets count more.</p>
        <div className="rf-steps__art">
          <ul className="spx-how__mk">
            {b.rows.slice(0, 3).map((m) => <li key={m.symbol}><span>{m.symbol.replace(/-USD$/, '')}</span><b>{coefText(Number(m.coefficient))}</b></li>)}
            {b.rows.length > 3 && <li className="is-more"><span>{b.rows.length - 3} more boosted</span></li>}
            {!b.rows.length && <li className="is-more"><span>{c.weights ? 'No market boosted this round' : DASH}</span></li>}
          </ul>
        </div>
      </article>
      <article>
        <h2><i>2</i>Snapshot</h2>
        <p>Every {week ? weekday(week.nextWeekStartTime) : 'Tuesday'}: the week’s points are split. Squads multiply yours.</p>
        <div className="rf-steps__art">
          <div className="spx-how__snap"><Clock to={week ? week.nextWeekStartTime * 1000 : null} /><span>until {pts(SODEX_POOL_SHOWN)} are split</span></div>
          <SquadLadder cfg={c.boost} at={v.squad ? Math.max(v.squad.joined.volume, v.squad.built.volume) : null} />
        </div>
      </article>
      <article>
        <h2><i>3</i>Paid, tier up</h2>
        <p>Every {week ? weekday(week.distributionTime) : 'Friday'} points land and lift your tier.</p>
        <div className="rf-steps__art">
          <ol className="spx-how__tiers">
            {TIERS.map((t) => <li key={t.name} className={prog && v.total !== null && v.total >= t.at ? 'is-on' : undefined}><TierName tier={t.name} /><span className="sx-num">{pts(t.at)}</span></li>)}
          </ol>
        </div>
      </article>
    </section>
  );
}

/** The bar under the stage: what multiplies points. The week's pool and times are on the season card above it. */
function Multipliers({ v }: { v: PointsView }) {
  const { c } = v;
  const b = boostedOf(c);
  return (
    <div className="rf-pays spx-pays is-one">
      <div className="rf-pays__g">
        <h3>Multipliers</h3>
        <ul>
          <li><b>{c.boost ? plusPct(c.boost.maxTotalBonusPct) : DASH}</b><span>Squad boost, at most</span></li>
          <li><b>{b.rows.length ? coefText(b.coef) : DASH}</b><span>{b.rows.length} boosted markets</span></li>
          <li><b>25%</b><a href={WE_GET[0]!.source.url} target="_blank" rel="noopener noreferrer" title={WE_GET[0]!.line}><img src="/logos/brand/sodex.svg" width="15" height="15" alt="SoDEX" />Of invitees’ points</a></li>
          <li><b>+5%</b><a href={YOU_GET[0]!.source.url} target="_blank" rel="noopener noreferrer" title={YOU_GET[0]!.line}><img src="/logos/brand/sodex.svg" width="15" height="15" alt="SoDEX" />For the invitee</a></li>
        </ul>
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

/* A week's futures volume and the position held, on a log scale: $1K-$10M and $0, $100-$1M. */
const VOL = logScale(3, 7);
const POS = logScale(2, 6, true);

/** Signed out: what a week earns, by ValueDesk's fitted model, as the landing page's calculator does. */
function WeekEstimate() {
  const [tv, setTv] = useState(() => VOL.t(100_000));
  const [tp, setTp] = useState(() => POS.t(1_000));
  const futures = VOL.of(tv);
  const oi = POS.of(tp);
  const e = bandOf(scoreOf({ futures, oi }));
  return (
    <div className="spx-est">
      <div className="spx-est__h"><span>What a week earns</span><EstPill /></div>
      <div className="spx-est__out"><b>≈ {ptsEst(e.mid)}</b><span>own SoPoints</span></div>
      <p className="spx-est__band">Quiet week {ptsEst(e.low)} · busy week {ptsEst(e.high)}</p>
      <div className="spx-est__row"><span>Futures volume</span><output>{money(futures)}</output></div>
      <Slider value={tv} min={0} max={STEPS} onChange={setTv} label={`Futures volume in a week: ${money(futures)}`} minLabel="$1K" maxLabel="$10M" />
      <div className="spx-est__row"><span>Position held all week</span><output>{oi ? money(oi) : '$0'}</output></div>
      <Slider value={tp} min={0} max={STEPS} onChange={setTp} label={`Average open position: ${money(oi)}`} minLabel="$0" maxLabel="$1M" />
      <p className="spx-note">Before referrals and your squad’s boost. SoDEX publishes no formula: this is our fit of settled weeks.</p>
    </div>
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
