/**
 * SoPoints, version "Planner" (localhost only, owner 2026-11-26): the page as a tool for the question traders ask, "what
 * gets me more points this week?". A week is planned with the kit's sliders (futures, spot, the position held, the share
 * on boosted markets, the squad's boost) and priced with ValueDesk's fitted model, labelled an estimate everywhere; the
 * levers beside it re-rank as it moves. Signed in, any of the wallet's own weeks fills the plan (SoDEX's rows, its
 * boosted share from SoDEX's weight details). Under it: $10K six ways, and the wallet's weeks.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Eip1193Provider } from '../../../../wallet';
import { IconTile, Skeleton, Slider } from '../../../bots/kit/kit';
import type { S2Week, WeekSplit } from '../../soPointsV2';
import {
  Clock, DASH, EstPill, SOPOINTS_MODEL, STEPS, SignInPanel, WeekPill, bandOf, boostedOf, coefText, levers, logScale, money, planOwn, plusPct, pts, ptsEst,
  scoreOf, useSignIn, usePointsView, weekRange, type Plan, type PointsView,
} from './shared';

const FUT = logScale(3, 7, true);
const SPOT = logScale(2, 6, true);
const POS = logScale(2, 6, true);

/** A week of SoDEX's as a plan: its own volumes, its open interest, the share it traded on boosted markets, its boost. */
function planOf(w: S2Week, squadNow: number | null): Plan {
  const boosted = (w.futuresVolumeWeightDetails ?? []).reduce((t, d) => t + (Number(d.rawVolumeU) || 0), 0);
  return {
    futures: w.futuresVolume || 0,
    spot: w.spotVolume || 0,
    oi: w.oi ?? 0,
    boostedShare: w.futuresVolume > 0 ? Math.min(1, boosted / w.futuresVolume) : 0,
    squadPct: w.isLive ? squadNow ?? w.totalBonusPct ?? 0 : w.totalBonusPct ?? 0,
  };
}

const START: Plan = { futures: 100_000, spot: 0, oi: 1_000, boostedShare: 0, squadPct: 0 };

export function Planner({ address, provider, sample }: { address: string | null; provider: Eip1193Provider | null; sample: boolean }) {
  const v = usePointsView(address, provider, sample);
  const { c, week } = v;
  const b = boostedOf(c);
  const [plan, setPlan] = useState<Plan>(START);
  const [from, setFrom] = useState<string | null>(null);
  // Signed in: the plan starts from the wallet's last scored Layer 1 week, once.
  const lastL1 = useMemo(() => [...v.all].reverse().find((w) => w.season === 'L1' && w.split.week.pointsStatus === 'CONFIRMED') ?? null, [v.all]);
  const filled = useRef(false);
  useEffect(() => {
    if (!v.mine) { filled.current = false; setFrom(null); setPlan(START); return; }
    if (filled.current || !lastL1) return;
    filled.current = true;
    setPlan(planOf(lastL1.split.week, v.squad?.total ?? null));
    setFrom(lastL1.key);
  }, [v.mine, lastL1, v.squad]);
  const set = (p: Partial<Plan>) => { setPlan((x) => ({ ...x, ...p })); setFrom(null); };
  const own = planOwn(plan, b.coef);
  const mult = 1 + plan.squadPct / 100;
  const list = levers(plan, b.coef, v.mine ? v.squad : null, c.boost, v.mine ? v.last?.split.referral ?? null : null);
  const maxSquad = c.boost?.maxTotalBonusPct ?? 50;
  const fromWeek = from ? v.all.find((w) => w.key === from) ?? null : null;
  return (
    <div className="tf bots-page rf-page sx spx spp">
      <div className="bots-col">
        <header className="spn-head">
          <div className="spn-head__t">
            <h1>SoPoints</h1>
            <span>Plan a week, see what moves it</span>
            <WeekPill week={week} />
          </div>
          <div className="spn-head__a">
            <span className="spn-head__snap"><small>Next snapshot</small><Clock to={week ? week.nextWeekStartTime * 1000 : null} /></span>
          </div>
        </header>

        <div className="spp-main">
          <section className="rf-dark spp-plan" aria-label="Plan a week">
            <span className="spp-plan__light" aria-hidden="true" />
            <div className="spp-plan__k">
              <h2>Plan a week</h2>
              <EstPill />
              <FromWeek v={v} from={fromWeek?.split.week.weekName ?? null} onPick={() => { if (lastL1) { setPlan(planOf(lastL1.split.week, v.squad?.total ?? null)); setFrom(lastL1.key); } }} />
            </div>
            <Result own={own} mult={mult} plan={plan} coef={b.coef} scored={fromWeek && fromWeek.split.week.pointsStatus === 'CONFIRMED' ? fromWeek.split : null} />
            <div className="spp-inputs">
              <Field label="Futures volume" value={plan.futures ? money(plan.futures) : '$0'}>
                <Slider value={FUT.t(plan.futures)} min={0} max={STEPS} onChange={(t) => set({ futures: FUT.of(t) })} label={`Futures volume in the week: ${money(plan.futures)}`} minLabel="$0" maxLabel="$10M" />
              </Field>
              <Field label="Spot volume" value={plan.spot ? money(plan.spot) : '$0'}>
                <Slider value={SPOT.t(plan.spot)} min={0} max={STEPS} onChange={(t) => set({ spot: SPOT.of(t) })} label={`Spot volume in the week: ${money(plan.spot)}`} minLabel="$0" maxLabel="$1M" />
              </Field>
              <Field label="Position held, on average" value={plan.oi ? money(plan.oi) : '$0'}>
                <Slider value={POS.t(plan.oi)} min={0} max={STEPS} onChange={(t) => set({ oi: POS.of(t) })} label={`Average open position over the week: ${money(plan.oi)}`} minLabel="$0" maxLabel="$1M" />
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
            <p className="spp-plan__fine">ValueDesk’s fit of {SOPOINTS_MODEL.fittedOn} ({SOPOINTS_MODEL.fittedAt}); SoDEX publishes no formula. Referral points come on top.</p>
          </section>

          <section className="spx-earn spp-levers" aria-label="What moves it">
            <div className="spx-earn__h"><h3>What moves it most</h3><EstPill /></div>
            <p className="spx-earn__base">Points a week gained against this plan, best first.</p>
            <ul className="rf-list spx-levers">
              {list.map((l, i) => (
                <li key={l.id}>
                  <em className="spp-rank sx-num">{l.gain !== null ? i + 1 : ''}</em>
                  <IconTile icon={l.icon} />
                  <span><b>{l.title}</b><small>{l.line}</small></span>
                  <span className="rf-pay"><em className={l.gain !== null && l.gain > 0 ? 'is-credit' : undefined}>{l.value}</em>{l.gain !== null && <small>a week</small>}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="sx-sec" aria-label="$10K six ways">
          <header className="sx-sec__h"><div><h2>$10K, six ways</h2><p>Own points a week from one thing alone, before referrals and squads.</p></div><EstPill /></header>
          <SixWays coef={b.coef} />
        </section>

        <section className="sx-sec" aria-label="Your weeks">
          <header className="sx-sec__h"><div><h2>Your weeks</h2><p>{v.mine ? 'SoDEX’s rows. Plan any of them to see what would have moved it.' : 'Sign in to plan from your own weeks.'}</p></div></header>
          {v.mine ? <MyWeeks v={v} on={from} onPlan={(w) => { setPlan(planOf(w.split.week, v.squad?.total ?? null)); setFrom(w.key); (document.querySelector('.appcontent') ?? window).scrollTo({ top: 0, behavior: 'smooth' }); }} />
            : <div className="spn-signin"><SignInPanel c={c} line={c.address ? 'Plan from your own weeks' : undefined} /></div>}
        </section>
      </div>
    </div>
  );
}

function FromWeek({ v, from, onPick }: { v: PointsView; from: string | null; onPick: () => void }) {
  const a = useSignIn(v.c);
  if (v.mine) return <button type="button" className="rf-howbtn spp-from" onClick={onPick} disabled={!v.last}>{from ? `From your ${from}` : 'Fill from my last week'}</button>;
  return <button type="button" className="rf-howbtn spp-from" onClick={a.go} disabled={a.busy || a.off} onPointerEnter={a.warm}>{a.connect ? 'Connect to use your weeks' : a.busy ? a.label : 'Sign in to use your weeks'}</button>;
}

function Field({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="spp-field">
      <div className="spp-field__h"><span>{label}</span><output>{value}</output></div>
      {children}
    </div>
  );
}

/** The plan's points and where they come from: each part of the score's share of the own points, then the squad's boost. */
function Result({ own, mult, plan, coef, scored }: { own: ReturnType<typeof planOwn>; mult: number; plan: Plan; coef: number; scored: WeekSplit | null }) {
  const futures = plan.futures * (1 + (coef - 1) * plan.boostedShare);
  const parts = own.score > 0 ? [
    { k: 'fut', label: 'Futures', v: own.mid * (futures / own.score) },
    { k: 'spot', label: 'Spot', v: own.mid * ((SOPOINTS_MODEL.weights.spot * plan.spot) / own.score) },
    { k: 'oi', label: 'Position', v: own.mid * ((SOPOINTS_MODEL.weights.oi * plan.oi) / own.score) },
    { k: 'sq', label: 'Squad', v: own.mid * (mult - 1) },
  ] : [];
  const total = own.mid * mult;
  return (
    <div className="spp-result">
      <div className="spp-result__n">
        <b className="sx-num">≈ {ptsEst(total)}</b>
        <span>SoPoints this week</span>
        <small className="sx-num">Quiet week {ptsEst(own.low * mult)} · busy week {ptsEst(own.high * mult)}</small>
        {/* Filled from a scored week: what SoDEX gave it, so the estimate can be held against the real figure. */}
        {scored && <small className="spp-result__real">SoDEX scored that {scored.week.weekName} <b className="sx-num">{pts(scored.week.points)}</b>{scored.referral > 0 ? `, ${pts(scored.referral * (1 + (scored.week.totalBonusPct ?? 0) / 100))} of it from invitees` : ''}</small>}
      </div>
      <div className="spp-result__mix">
        <div className="spp-mixbar" aria-hidden="true">{parts.filter((p) => p.v > 0.01).map((p) => <i key={p.k} className={`is-${p.k}`} style={{ flexGrow: p.v }} />)}</div>
        <ul>{parts.map((p) => <li key={p.k} className={p.v > 0.01 ? undefined : 'is-zero'}><i className={`is-${p.k}`} />{p.label}<b className="sx-num">{p.v > 0.01 ? ptsEst(p.v) : '0'}</b></li>)}</ul>
      </div>
    </div>
  );
}

function SixWays({ coef }: { coef: number }) {
  const rows: Array<{ k: string; what: string; sub: string; score: number }> = [
    { k: 'f', what: '$10K futures', sub: 'Volume, any market', score: scoreOf({ futures: 10_000 }) },
    { k: 's', what: '$10K spot', sub: 'Counts three times futures', score: scoreOf({ futures: 0, spot: 10_000 }) },
    ...(coef > 1 ? [{ k: 'b', what: '$10K on a boosted market', sub: `Counts ${coefText(coef)}`, score: scoreOf({ futures: 10_000 * coef }) }] : []),
    { k: 'p1', what: '$1K position, all week', sub: 'Held, not traded', score: scoreOf({ futures: 0, oi: 1_000 }) },
    { k: 'p10', what: '$10K position, all week', sub: 'Ten times the position', score: scoreOf({ futures: 0, oi: 10_000 }) },
    { k: 'f100', what: '$100K futures', sub: 'Ten times the volume', score: scoreOf({ futures: 100_000 }) },
  ];
  const top = Math.max(...rows.map((r) => bandOf(r.score).high));
  return (
    <ul className="spp-six">
      {rows.map((r) => {
        const e = bandOf(r.score);
        return (
          <li key={r.k}>
            <span><b>{r.what}</b><small>{r.sub}</small></span>
            <span className="spp-six__bar" aria-hidden="true"><i style={{ left: `${(e.low / top) * 100}%`, width: `${((e.high - e.low) / top) * 100}%` }} /><em style={{ left: `${(e.mid / top) * 100}%` }} /></span>
            <span className="spp-six__v"><b className="sx-num">≈ {ptsEst(e.mid)}</b><small className="sx-num">{ptsEst(e.low)} – {ptsEst(e.high)}</small></span>
          </li>
        );
      })}
    </ul>
  );
}

function MyWeeks({ v, on, onPlan }: { v: PointsView; on: string | null; onPlan: (w: PointsView['all'][number]) => void }) {
  const rows = useMemo(() => v.all.filter((w) => w.season === 'L1' && w.split.week.pointsStatus === 'CONFIRMED').reverse().slice(0, 8), [v.all]);
  if (v.s.loading && !rows.length) return <div className="spx-skelrows">{[0, 1, 2].map((i) => <Skeleton key={i} className="rf-skel-row" />)}</div>;
  if (!rows.length) return <p className="spx-note">No scored Layer 1 week yet.</p>;
  const top = Math.max(1, ...rows.map((w) => w.split.week.points));
  return (
    <ul className="spp-weeks">
      {rows.map((w) => {
        const k = w.split.week;
        return (
          <li key={w.key} className={on === w.key ? 'is-on' : undefined}>
            <span className="spx-wk">{w.short}</span>
            <span className="spp-weeks__t"><b>{k.weekName}</b><small>{weekRange(k.weekStartTime)}</small></span>
            <span className="spp-weeks__bar" aria-hidden="true"><i style={{ width: `${(k.points / top) * 100}%` }} /></span>
            <span className="spp-weeks__f"><b className="sx-num">{pts(k.points)}</b><small className="sx-num">{w.split.volume ? money(w.split.volume) : '$0'}{w.split.dollarsPerPoint ? ` · ${money(w.split.dollarsPerPoint)}/pt` : ''}</small></span>
            <button type="button" className="rf-text spp-weeks__go" onClick={() => onPlan(w)} aria-pressed={on === w.key}>{on === w.key ? 'Planned' : 'Plan this'}</button>
          </li>
        );
      })}
    </ul>
  );
}
