/**
 * SoPoints, version "Season" (localhost only, owner 2026-11-26): the season as the page's spine. SoDEX's tier ladder on
 * one log axis with the wallet's place on it and the weeks to the next tier at its own pace; the Layer 1 Season's twenty
 * weeks as a grid (done, live, to come) that opens any week; under it the points over the season and this week's
 * multipliers. Signed out, the grid carries the venue's traded volume of each week (SoDEX's daily series).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { Eip1193Provider } from '../../../../wallet';
import { RULES, TIERS, fetchVenueDaily, type DailyPoint } from '../../../../points';
import { Segmented, Skeleton, StatusPill } from '../../../bots/kit/kit';
import { levels } from '../../../referrals/calendar';
import { SODEX_POOL_SHOWN } from '../../SoPointsMine';
import type { AnyWeek } from '../../soPointsV2';
import {
  BoostedMarkets, Clock, DASH, SignInButton, SignInPanel, SquadLadder, SquadTracks, TierName, WeekPill,
  boostedOf, coefText, money, plusPct, pts, tierProgress, usePhone, usePointsView, weekRange, weekday, type PointsView,
} from './shared';

const WEEK_MS = 7 * 86_400_000;
const LOG_TOP = Math.log10(TIERS.at(-1)!.at);
const xOf = (points: number) => (points <= 1 ? 0 : Math.min(1, Math.log10(points) / LOG_TOP));

export function Season({ address, provider, sample }: { address: string | null; provider: Eip1193Provider | null; sample: boolean }) {
  const v = usePointsView(address, provider, sample);
  const { c, week } = v;
  return (
    <div className="tf bots-page rf-page sx spx spn">
      <div className="bots-col">
        <header className="spn-head">
          <div className="spn-head__t">
            <h1>SoPoints</h1>
            <span>{RULES.season} · {RULES.seasonWeeks} weeks · {pts(SODEX_POOL_SHOWN)} a week</span>
            <WeekPill week={week} />
          </div>
          <div className="spn-head__a">
            <span className="spn-head__snap"><small>Next snapshot</small><Clock to={week ? week.nextWeekStartTime * 1000 : null} /></span>
            {!v.mine && <SignInButton c={c} />}
          </div>
        </header>

        <Ladder v={v} />
        <Weeks v={v} />

        <div className="spn-duo">
          <section className="sx-sec" aria-label={v.mine ? 'Points over the season' : 'Your SoPoints'}>
            {v.mine ? (<>
              <header className="sx-sec__h"><div><h2>Points over the season</h2><p>Every scored week added up, with SoDEX’s tiers behind.</p></div></header>
              <Climb weeks={v.scored} />
            </>) : (
              <div className="spn-signin"><SignInPanel c={c} line={c.address ? 'Place yourself on the ladder and in every week' : undefined} /></div>
            )}
          </section>
          <section className="sx-sec" aria-label="This week's multipliers">
            <header className="sx-sec__h"><div><h2>This week’s multipliers</h2><p>{c.boost ? `Squads up to ${plusPct(c.boost.maxTotalBonusPct)}` : 'Squads'} · {boostedOf(c).rows.length ? `${boostedOf(c).rows.length} markets ${coefText(boostedOf(c).coef)}` : 'boosted markets'}</p></div></header>
            {v.mine ? <SquadTracks v={v} /> : <SquadLadder cfg={c.boost} />}
            <div className="spn-mk"><BoostedMarkets c={c} max={5} /></div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------- the ladder ----- */

function Ladder({ v }: { v: PointsView }) {
  const prog = tierProgress(v.mine ? v.total : null);
  const weeksLeft = v.week ? RULES.seasonWeeks - v.week.weekNo + 1 : null;
  const need = prog?.nxt && v.pace ? Math.ceil(prog.left / v.pace) : null;
  const at = v.mine && v.total !== null ? xOf(v.total) : null;
  return (
    <section className={`spn-ladder${v.mine ? ' is-mine' : ''}`} aria-label="Tiers">
      <div className="spn-ladder__top">
        {v.mine ? (
          v.total === null ? <Skeleton className="spx-skel-md" /> : (
            <div className="spn-ladder__me">
              <TierName tier={v.tier} className="is-lead" />
              <b className="sx-num">{pts(v.total)}</b><span>SoPoints</span>
              {v.s.summary?.rank ? <span className="spn-ladder__rank">#{pts(v.s.summary.rank)}</span> : null}
            </div>
          )
        ) : <div className="spn-ladder__me"><span className="spn-ladder__k">SoDEX’s tiers, by SoPoints held</span></div>}
        {prog?.nxt && (
          <div className="spn-ladder__goal">
            <span><b className="sx-num">{pts(prog.left)}</b> to <TierName tier={prog.nxt.name} /></span>
            <small>{need !== null && weeksLeft !== null ? (need <= weeksLeft ? `≈ ${need} ${need === 1 ? 'week' : 'weeks'} at your last 4 weeks’ pace · ${weeksLeft} left in the season` : `Not this season at your last 4 weeks’ pace · ${weeksLeft} weeks left`) : `${weeksLeft ?? DASH} weeks left in the season`}</small>
          </div>
        )}
      </div>
      <div className="spn-track" role="img" aria-label={v.mine && v.total !== null ? `${pts(v.total)} SoPoints, ${v.tier}` : 'Tier thresholds'}>
        {/* The rail runs through SoDEX's tier colours; the wallet's part of it is lit (clipped, so the colours sit under their tiers). */}
        <div className="spn-track__rail"><i style={{ clipPath: `inset(0 ${100 - (at ?? 0) * 100}% 0 0 round 999px)` }} /></div>
        {TIERS.map((t) => (
          <span key={t.name} className={`spn-node is-${t.name.toLowerCase()}${v.mine && v.total !== null && v.total >= t.at ? ' is-on' : ''}`} style={{ left: `${xOf(t.at) * 100}%` }}>
            <i aria-hidden="true" />
            <b>{t.name}</b>
            <small className="sx-num">{pts(t.at)}</small>
          </span>
        ))}
        {at !== null && <span className="spn-pin" style={{ left: `${at * 100}%` }}><b className="sx-num">{pts(v.total!)}</b></span>}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------- the weeks ----- */

interface Cell {
  key: string;
  label: string;
  start: number;
  state: 'done' | 'live' | 'ahead';
  week: AnyWeek | null;
  venue: number | null;
  value: number;
}

/** The venue's traded volume per Layer 1 week, from SoDEX's public daily series (signed out). */
function useVenueWeeks(enabled: boolean): DailyPoint[] | null {
  const [d, setD] = useState<DailyPoint[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let on = true;
    fetchVenueDaily('volume', 150).then((x) => { if (on) setD(x); }).catch(() => { if (on) setD([]); });
    return () => { on = false; };
  }, [enabled]);
  return d;
}

const venueIn = (daily: DailyPoint[], startMs: number): number | null => {
  const rows = daily.filter((p) => p.ts >= startMs - 12 * 3_600_000 && p.ts < startMs + WEEK_MS - 12 * 3_600_000);
  return rows.length >= 6 ? rows.reduce((t, p) => t + p.value, 0) : null;
};

type SeasonPick = 'L1' | 'S1';

function Weeks({ v }: { v: PointsView }) {
  const { week } = v;
  const daily = useVenueWeeks(!v.mine);
  const [season, setSeason] = useState<SeasonPick>('L1');
  const hasS1 = v.all.some((w) => w.season === 'S1');
  const cells: Cell[] = useMemo(() => {
    if (season === 'S1') {
      const s1 = v.all.filter((w) => w.season === 'S1');
      const lv = levels(s1.map((w) => w.split.week.points));
      return s1.map((w, i) => ({ key: w.key, label: w.short, start: w.start * 1000, state: 'done' as const, week: w, venue: null, value: lv[i]!.level }));
    }
    if (!week) return [];
    const liveNo = week.weekNo;
    const startOf = (k: number) => week.nextWeekStartTime * 1000 - (liveNo - k + 1) * WEEK_MS;
    const l1 = new Map(v.all.filter((w) => w.season === 'L1').map((w) => [w.split.week.weekNo, w]));
    const raw = Array.from({ length: Math.max(RULES.seasonWeeks, liveNo) }, (_, i) => {
      const k = i + 1;
      const state: Cell['state'] = k < liveNo ? 'done' : k === liveNo ? 'live' : 'ahead';
      return { key: `l1-${k}`, label: `W${k}`, start: startOf(k), state, week: l1.get(k) ?? null, venue: daily && state !== 'ahead' ? venueIn(daily, startOf(k)) : null, value: 0 };
    });
    const lv = levels(raw.map((c) => (c.state !== 'done' ? 0 : v.mine ? c.week?.split.week.points ?? 0 : c.venue ?? 0)));
    return raw.map((c, i) => ({ ...c, value: lv[i]!.level }));
  }, [season, week, v.all, v.mine, daily]);
  const liveIx = cells.findIndex((c) => c.state === 'live');
  const [pick, setPick] = useState<number | null>(null);
  const on = pick !== null && pick < cells.length ? pick : liveIx >= 0 ? liveIx : cells.length - 1;
  useEffect(() => setPick(null), [season]);
  const done = cells.filter((c) => c.state === 'done').length;
  return (
    <section className="sx-sec" aria-label="The season's weeks">
      <header className="sx-sec__h">
        <div><h2>{season === 'S1' ? 'Season 1' : `Week ${week?.weekNo ?? DASH} of ${RULES.seasonWeeks}`}</h2><p>{season === 'S1' ? `${cells.length} weeks scored before Layer 1` : v.mine ? `${done} scored, your points by week. Pick one to open it.` : `${done} done. Each week shows what the whole venue traded.`}</p></div>
        {v.mine && hasS1 && <Segmented<SeasonPick> label="Season" value={season} onChange={setSeason} options={[{ value: 'L1', label: 'Layer 1' }, { value: 'S1', label: 'Season 1' }]} />}
      </header>
      {!cells.length ? <Skeleton className="spn-gridskel" /> : (
        <ol className={`spn-grid${season === 'S1' ? ' is-s1' : ''}`}>
          {cells.map((c, i) => (
            <li key={c.key}>
              <button type="button" className={`spn-cell is-${c.state} is-l${c.value}${i === on ? ' is-on' : ''}`} aria-pressed={i === on} onClick={() => setPick(i)} aria-label={`${c.label}, ${c.state === 'ahead' ? 'to come' : c.state === 'live' ? 'live' : 'done'}`}>
                <span className="spn-cell__n">{c.label}{c.state === 'live' && <i aria-hidden="true" />}</span>
                <b className="sx-num">{cellFigure(c, v)}</b>
                <small>{cellLine(c, v)}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
      {cells[on] && <Detail c={cells[on]!} v={v} />}
    </section>
  );
}

const cellFigure = (c: Cell, v: PointsView): string => {
  if (c.state === 'ahead') return new Date(c.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (v.mine) {
    const w = c.week?.split.week;
    if (!w) return DASH;
    return w.pointsStatus === 'CONFIRMED' ? pts(w.points) : 'TBD';
  }
  return c.state === 'live' ? 'Live' : c.venue !== null ? money(c.venue) : DASH;
};

const cellLine = (c: Cell, v: PointsView): string => {
  if (c.state === 'ahead') return 'to come';
  if (c.state === 'live') return v.mine ? 'live now' : 'this week';
  if (v.mine) return c.week?.season === 'L1' ? plusPct(c.week.split.week.totalBonusPct ?? 0) : c.week?.split.week.rank ? `#${pts(c.week.split.week.rank)}` : '';
  return 'traded';
};

function Detail({ c, v }: { c: Cell; v: PointsView }) {
  const w = c.week?.split;
  const wk = w?.week;
  const hold = wk ? (wk.wealthTvl ?? 0) + (wk.vaultHolding ?? 0) : 0;
  const total = w ? w.own + w.referral + w.boost : 0;
  return (
    <div className="spn-detail" aria-live="polite">
      <div className="spn-detail__t">
        <span className="spn-detail__n">{c.label}</span>
        <div>
          <b>{c.week?.name ?? `Layer 1 · Week ${c.label.slice(1)}`}</b>
          <small>{weekRange(c.start / 1000)}</small>
        </div>
        <StatusPill size="sm" tone={c.state === 'live' ? 'positive' : 'neutral'} dot={c.state === 'live'}>{c.state === 'live' ? 'Live' : c.state === 'ahead' ? 'To come' : wk && wk.pointsStatus !== 'CONFIRMED' ? 'Not scored yet' : 'Scored'}</StatusPill>
      </div>
      {c.state === 'ahead' ? (
        <p className="spn-detail__line">Starts {new Date(c.start).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, your time. {pts(SODEX_POOL_SHOWN)} SoPoints to split.</p>
      ) : c.state === 'live' && !v.mine ? (
        <p className="spn-detail__line">Snapshot in <Clock to={c.start + WEEK_MS} />{v.week ? ` · points land ${weekday(v.week.distributionTime)}` : ''}</p>
      ) : !v.mine ? (
        <dl className="spn-detail__figs"><div><dt>The venue traded</dt><dd>{c.venue !== null ? money(c.venue) : DASH}</dd></div><div><dt>SoPoints split</dt><dd>{pts(SODEX_POOL_SHOWN)}</dd></div></dl>
      ) : !wk ? (
        <p className="spn-detail__line">No row from SoDEX for this week.</p>
      ) : (
        <>
          <dl className="spn-detail__figs">
            <div className="is-big"><dt>{wk.isLive ? 'Points' : 'Points this week'}</dt><dd>{wk.pointsStatus === 'CONFIRMED' ? pts(wk.points) : 'TBD'}</dd></div>
            <div><dt>Volume</dt><dd>{w!.volume ? money(w!.volume) : DASH}</dd></div>
            <div><dt>Open interest</dt><dd>{wk.oi ? money(wk.oi) : DASH}</dd></div>
            <div><dt>Holdings</dt><dd>{hold >= 1 ? money(hold) : DASH}</dd></div>
            <div><dt>Rank</dt><dd>{wk.rank ? `#${pts(wk.rank)}` : DASH}</dd></div>
            {c.week?.season === 'L1' && <div><dt>Squad</dt><dd className={wk.totalBonusPct ? 'pos' : undefined}>{plusPct(wk.totalBonusPct ?? 0)}</dd></div>}
          </dl>
          {total > 0 && (
            <div className="spn-split">
              <div className="spn-split__bar" aria-hidden="true">
                <i className="is-own" style={{ flexGrow: w!.own }} /><i className="is-referral" style={{ flexGrow: w!.referral }} /><i className="is-boost" style={{ flexGrow: w!.boost }} />
              </div>
              <ul className="spx-legend"><li><i className="is-own" />Own {pts(w!.own)}</li><li><i className="is-referral" />From invitees {pts(w!.referral)}</li>{c.week?.season === 'L1' && <li><i className="is-boost" />Squad boost {pts(w!.boost)}</li>}</ul>
            </div>
          )}
          {wk.isLive && <p className="spn-detail__line">Scored at the snapshot in <Clock to={(wk.weekEndTime || 0) * 1000 || c.start + WEEK_MS} /></p>}
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------- points over the season ----- */

const CW = 600;
const CH = 220;

function Climb({ weeks }: { weeks: readonly AnyWeek[] }) {
  const id = useId();
  const phone = usePhone();
  const [at, setAt] = useState<number | null>(null);
  const cum = useMemo(() => { let t = 0; return weeks.map((w) => (t += w.split.week.points)); }, [weeks]);
  if (!weeks.length) return <div className="rfc is-empty"><p>Your season draws here from the first scored week.</p></div>;
  const top = Math.max(10, cum.at(-1)!) * 1.12;
  const X = (i: number) => (weeks.length <= 1 ? CW / 2 : (i / (weeks.length - 1)) * CW);
  const Y = (p: number) => CH - (p / top) * (CH - 8);
  const line = cum.map((p, i) => `${i ? 'L' : 'M'}${X(i)} ${Y(p)}`).join('');
  // A tier's line only where it has room: on a linear axis Bronze (10) and Silver (100) crowd the floor.
  const lines = TIERS.filter((t) => t.at > 0 && t.at < top && t.at >= top * 0.07);
  const read = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (weeks.length - 1)));
  };
  const left = at === null ? 0 : (X(at) / CW) * 100;
  const every = Math.ceil(weeks.length / (phone ? 5 : 9));
  return (
    <div className="rfc spn-climb" role="img" aria-label="SoPoints over the season" onPointerDown={read} onPointerMove={read} onPointerLeave={(e) => { if (e.pointerType !== 'touch') setAt(null); }}>
      <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--rf-points)" stopOpacity="0.32" /><stop offset="1" stopColor="var(--rf-points)" stopOpacity="0" /></linearGradient></defs>
        {lines.map((t) => <path key={t.name} className="spn-climb__tier" d={`M0 ${Y(t.at)}H${CW}`} />)}
        <path d={`${line}V${CH}H0Z`} fill={`url(#${id})`} />
        <path className="spn-climb__l" d={line} />
      </svg>
      {lines.map((t) => <span key={t.name} className="spn-climb__lab" style={{ top: `calc((100% - 24px) * ${Y(t.at) / CH})` }}><TierName tier={t.name} /></span>)}
      {at !== null && <span className="rfc__x" style={{ left: `${left}%` }} />}
      {at !== null && <span className="rfc__d spn-climb__d" style={{ left: `${left}%`, top: `calc((100% - 24px) * ${Y(cum[at]!) / CH})` }} />}
      {at !== null && (
        <span className="rfc__tip" style={{ left: `clamp(90px, ${left}%, calc(100% - 90px))` }}>
          <small>{weeks[at]!.name}</small>
          <span className="is-own"><i />Points so far<b>{pts(cum[at]!)}</b></span>
          <span><i style={{ opacity: 0 }} />That week<b>+{pts(weeks[at]!.split.week.points)}</b></span>
        </span>
      )}
      <span className="rfc__ax is-cells">{weeks.map((w, i) => <i key={w.key}>{i % every === 0 ? w.short : ''}</i>)}</span>
    </div>
  );
}

