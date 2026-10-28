/**
 * The SoPoints page, as dashboard panels.
 *
 * BUILT FROM THE DESIGN SYSTEM, NOT BESIDE IT. Every surface here is a `Card`,
 * a `Group`, a `Row` or a `Stat` imported from Portfolio.tsx - the same
 * components the portfolio rail is made of - so the row rhythm, the label/value
 * alignment, the provenance tags and the em-dash-for-no-data rule are inherited
 * rather than re-implemented. The first version of this page invented its own
 * `.pts-*` vocabulary; that was the mistake this replaces.
 *
 * WHOSE PROGRAMME THIS IS. SoPoints belong to SoDEX. We award nothing and decide
 * nothing - this reads their endpoints and does arithmetic they do not publish,
 * and every derived figure carries the `derived` tag the rest of the app uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStored } from '../hooks';
import {
  NeedsPointsToken, RULES, TIERS, difficultyFrom, fetchMyPoints, fetchMyWeeks,
  fetchRankedCount, fetchReferral, fetchStanding, fetchVenueVolume, fetchWeek,
  clearPointsToken, getPointsToken, setPointsToken, shareFrom, tierFor, weekVolumeOf,
  difficultyByWeek, fetchVenueDaily, seasonStats, venueByWeek, MIN_COVERAGE,
  type DailyPoint, type Difficulty, type DifficultyWeek, type PointsSummary, type PointsWeek,
  type Referral,
  type ReferralMode, type SeasonStats, type Standing, type VenueWeek, type WeekInfo,
  type Window, type YourShare,
} from '../points';
import { Card, Group, Meter, Row, PeriodSeg, fmtCompactUsd } from './Portfolio';
import { DASH, fmt, fmtUsd } from '../format';
import { useMask } from '../privacy';
import { PointsAuthError, signInToPoints } from '../pointsAuth';
import { WalletError, type Eip1193Provider } from '../wallet';
import type { PanelDefinition } from '../dashboard/types';
import './Points.css';
import { notifyError } from '../toast';
import { NoWallet } from './EmptyState';
import { fmtFixed, fmtPlain } from '../numStyle';
/* The window the pool competes over. Weekly pool, so 7D is the honest default. */
const POOL_DAYS = 7;

export interface PointsContext {
  address: string | null;
  /** The connected wallet, for the one signature the SoPoints sign-in needs. */
  provider: Eip1193Provider | null;
  window: Window;
  setWindow: (w: Window) => void;
  week: WeekInfo | null;
  standing: Standing | null;
  ranked: number | null;
  venue: { total: number; days: number } | null;
  referral: Referral | null;
  mine: PointsSummary | null;
  weeks: PointsWeek[] | null;
  /** Venue-wide activity, folded onto the venue's own week boundaries. */
  venueWeeks: Map<number, VenueWeek>;
  /** Your cost per point against the field's, week by week. */
  difficulty: DifficultyWeek[];
  /** Season aggregates for the per-point panel. */
  stats: SeasonStats | null;
  /** Which activity the cost-per-point ratio is measured in. */
  basis: 'volume' | 'oi';
  setBasis: (b: 'volume' | 'oi') => void;
  /** How referral points are treated in every points figure on the page. */
  refMode: ReferralMode;
  setRefMode: (m: ReferralMode) => void;
  /** Which context series is drawn under the difficulty lines. */
  band: 'venue' | 'you' | 'points';
  setBand: (b: 'venue' | 'you' | 'points') => void;
  showTvl: boolean;
  setShowTvl: (v: boolean) => void;

  needsToken: boolean;
  tokenPresent: boolean;
  /** Prompts the wallet, exchanges the signature, and reloads the authed feeds. */
  signIn: () => Promise<void>;
  signOut: () => void;
  signingIn: boolean;
  signInError: string | null;
  loading: boolean;
  diff: Difficulty | null;
  share: YourShare | null;
}

export function usePointsContext(
  address: string | null,
  provider: Eip1193Provider | null,
): PointsContext {
  /* `PeriodSeg` speaks the portfolio's Period vocabulary; the leaderboard speaks
     24H/7D/30D. They line up for the three we offer, so the segment is reused
     rather than a fourth kind of period control being invented. */
  const [window, setWindow] = useState<Window>('7D');
  const [week, setWeek] = useState<WeekInfo | null>(null);
  const [standing, setStanding] = useState<Standing | null>(null);
  /* Separate from `standing`, which follows the 24H/7D/30D control. Season
     points can only be divided by a season-long PnL. */
  const [seasonPnl, setSeasonPnl] = useState<number | null>(null);
  const [ranked, setRanked] = useState<number | null>(null);
  const [venue, setVenue] = useState<{ total: number; days: number } | null>(null);
  const [referral, setReferral] = useState<Referral | null>(null);
  const [mine, setMine] = useState<PointsSummary | null>(null);
  const [weeks, setWeeks] = useState<PointsWeek[] | null>(null);
  const [venueDaily, setVenueDaily] = useState<{
    volume: DailyPoint[]; oi: DailyPoint[]; tvl: DailyPoint[];
  } | null>(null);
  const [basis, setBasis] = useStored<'volume' | 'oi'>('ot.pts.basis', 'volume');
  const [refMode, setRefMode] = useStored<ReferralMode>('ot.pts.ref', 'without');
  const [band, setBand] = useStored<'venue' | 'you' | 'points'>('ot.pts.band', 'venue');
  const [showTvl, setShowTvl] = useStored<boolean>('ot.pts.tvl', false);
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenPresent, setTokenPresent] = useState(() => !!getPointsToken(address));
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  /**
   * One wallet prompt, then the authed feeds re-run.
   *
   * A rejected signature is not an error worth a red banner - it is someone
   * changing their mind in the wallet - so it clears the state and says nothing.
   */
  const signIn = useCallback(async () => {
    if (!address || !provider) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      setPointsToken(address, await signInToPoints(provider, address));
      setTokenPresent(!!getPointsToken(address));
      setTick((n) => n + 1);
    } catch (e) {
      /* A rejected signature is someone changing their mind, not a fault. */
      if (e instanceof WalletError && /reject|denied|cancel/i.test(e.message)) return;
      setSignInError(notifyError('SoPoints sign-in', e));
    } finally {
      setSigningIn(false);
    }
  }, [address, provider]);

  const signOut = useCallback(() => {
    clearPointsToken();
    setTokenPresent(false);
    setMine(null);
    setWeeks(null);
    setNeedsToken(true);
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let off = false;
    setLoading(true);

    /* The public feeds run regardless of a wallet, so the difficulty figures and
       the tier ladder are useful before anyone connects. One failing feed must
       not blank the rest, hence a catch per call. */
    const jobs: Array<Promise<unknown>> = [
      fetchVenueVolume(POOL_DAYS).then((v) => { if (!off) setVenue(v); }).catch(() => {}),
      fetchRankedCount(window).then((n) => { if (!off) setRanked(n); }).catch(() => {}),
      /* The three venue-wide series behind "overall difficulty". Public, so they
         load without a token and the chart's context half is drawn even for a
         visitor who never signs in. 200 days covers the whole 26-week season. */
      Promise.all([
        fetchVenueDaily('volume', 200),
        fetchVenueDaily('open-interest', 200),
        fetchVenueDaily('tvl', 200),
      ]).then(([volume, oi, tvl]) => { if (!off) setVenueDaily({ volume, oi, tvl }); })
        .catch(() => {}),
    ];

    if (address) {
      jobs.push(
        fetchWeek(address).then((w) => { if (!off) setWeek(w); }).catch(() => {}),
        fetchStanding(address, window).then((s) => { if (!off) setStanding(s); }).catch(() => {}),
        fetchStanding(address, 'ALL_TIME')
          .then((s) => { if (!off) setSeasonPnl(s?.pnlUsd ?? null); }).catch(() => {}),
        fetchReferral(address).then((r) => { if (!off) setReferral(r); }).catch(() => {}),
        /* The two authed feeds. A missing token is not an error to shout about -
           it is the expected state until someone signs in, so it sets a flag the
           panel reads rather than surfacing a red banner. */
        fetchMyPoints(address)
          .then((m) => { if (!off) { setMine(m); setNeedsToken(false); } })
          .catch((e) => { if (!off && e instanceof NeedsPointsToken) setNeedsToken(true); }),
        fetchMyWeeks(address)
          .then((w) => { if (!off) setWeeks(w); })
          .catch((e) => { if (!off && e instanceof NeedsPointsToken) setNeedsToken(true); }),
      );
    }

    void Promise.allSettled(jobs).then(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [address, window, tick]);

  /*
   * The derived layer, memoised on its inputs.
   *
   * All three fall out of the same two fetches, and computing them here rather
   * than in each panel is what stops the chart, the table's totals and the
   * per-point rail from ever disagreeing about a number.
   */
  const venueWeeks = useMemo(
    () => (weeks && venueDaily ? venueByWeek(weeks, venueDaily) : new Map<number, VenueWeek>()),
    [weeks, venueDaily],
  );

  const pool = week?.weekPoolPoints ?? RULES.weeklyPool;

  const difficulty = useMemo(
    () => (weeks ? difficultyByWeek(weeks, venueWeeks, refMode, pool) : []),
    [weeks, venueWeeks, refMode, pool],
  );

  const stats = useMemo(
    () => (weeks
      ? seasonStats(weeks, refMode, seasonPnl, venueWeeks, pool)
      : null),
    [weeks, refMode, seasonPnl, venueWeeks, pool],
  );
  const diff = venue ? difficultyFrom(pool, venue.total) : null;
  const share = diff && standing ? shareFrom(diff, standing.volumeUsd, standing.pnlUsd) : null;

  return {
    address, provider, window, setWindow, week, standing, ranked, venue, referral, mine,
    weeks, venueWeeks, difficulty, stats,
    basis, setBasis, refMode, setRefMode, band, setBand, showTvl, setShowTvl,
    needsToken, tokenPresent, signIn, signOut, signingIn, signInError,
    loading, diff, share,
  };
}

/* ---------------------------------------------------------------------------
 * Panels. Ids are permanent - they key the saved layout.
 * ------------------------------------------------------------------------ */

export const POINTS_PANELS: Array<PanelDefinition<PointsContext>> = [
  {
    id: 'mine',
    title: 'Your SoPoints',
    pad: false,
    minW: 8,
    minH: 6,
    render: (c) => <MinePanel c={c} />,
  },
  {
    /*
     * The left rail's second card. Sits directly under the points card, which is
     * the only other thing in that column - "what you have" above "what it cost".
     */
    id: 'economics',
    title: 'Per-point economics',
    pad: false,
    minW: 8,
    minH: 8,
    render: (c) => <EconomicsPanel c={c} />,
  },
  {
    id: 'difficulty',
    title: 'Difficulty',
    pad: false,
    minW: 14,
    minH: 11,
    render: (c) => <DifficultyPanel c={c} />,
  },
  {
    id: 'standing',
    title: 'Your standing',
    pad: false,
    minW: 8,
    minH: 6,
    render: (c) => <StandingPanel c={c} />,
  },
  {
    id: 'tiers',
    title: 'Tiers',
    pad: false,
    minW: 8,
    minH: 5,
    render: (c) => <TiersPanel c={c} />,
  },
  {
    id: 'weeks',
    title: 'Weekly points',
    pad: false,
    minW: 10,
    minH: 6,
    render: (c) => <WeeksPanel c={c} />,
  },
  {
    id: 'programme',
    title: 'Programme',
    pad: false,
    minW: 8,
    minH: 6,
    render: (c) => <ProgrammePanel c={c} />,
  },
];

/* ---- your real points, or the door to them ------------------------------ */

/**
 * A generic segmented control.
 *
 * `PeriodSeg` is welded to the `Period` union, and this page has four toggles
 * that are not periods. Same `.pf-seg` / `.pf-ctl` classes so it is the same
 * control visually - the styling is the design system's, only the type is local.
 */
function Seg<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ v: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="pf-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="tab"
          aria-selected={o.v === value}
          title={o.hint}
          className={`pf-ctl ${o.v === value ? 'is-on' : ''}`}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Read a possibly-absent numeric field off the venue's raw summary. */
function numOf(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The points card, and nothing else.
 *
 * This panel is deliberately ONE object: tier, balance, standing, and how far
 * the next tier is. It is the thing you look at first and the thing you would
 * screenshot, so it gets no surrounding rail of rows competing with it - those
 * live in the panel below it.
 */
function MinePanel({ c }: { c: PointsContext }) {
  const mask = useMask('funds');

  if (!c.address) {
    return <Card title="Your SoPoints" className="pf-card--identity"><p className="pf-note">Connect a wallet first.</p></Card>;
  }
  if (c.needsToken && !c.mine) return <PointsLogin c={c} />;

  const total = c.mine?.totalPoints ?? null;
  const tier = total != null ? tierFor(total) : null;
  const tierName = c.mine?.tierName ?? tier?.name ?? null;

  /* Progress to the next tier, from SoDEX's own published thresholds. The top
     tier has nothing above it, so it reads as complete rather than as stalled. */
  const idx = tier ? TIERS.findIndex((t) => t.name === tier.name) : -1;
  const next = idx >= 0 ? TIERS[idx + 1] : undefined;
  const span = next && tier ? next.at - tier.at : 0;
  const progress = next && tier && span > 0 && total != null
    ? Math.max(0, Math.min(1, (total - tier.at) / span))
    : 1;

  const rank = c.mine?.rank ?? null;
  const totalUsers = numOf(c.mine?.raw?.totalUser);
  const pct = rank && totalUsers ? (rank / totalUsers) * 100 : null;

  return (
    <Card title="Your SoPoints" className="pf-card--identity">
      <div className="pts-card">
        <div className="pts-card__top">
          <span className="pts-tier">{tierName ?? DASH}</span>
          <span className="pf-unit">SoDEX</span>
        </div>

        <div className="pts-card__value">
          {total != null ? mask(fmt(total, 0)) : DASH}
        </div>
        <div className="pts-card__unit">SoPoints</div>

        <div className="pts-card__rank">
          {rank ? (
            <>
              {'Rank '}
              {mask(fmt(rank, 0))}
              {pct !== null ? ` · top ${pct < 1 ? '<1' : fmt(pct, 1)}%` : ''}
              {totalUsers ? ` of ${fmt(totalUsers, 0)}` : ''}
            </>
          ) : (
            <span className="pf-dim">Not ranked yet</span>
          )}
        </div>

        <Meter value={progress} tone="pos" label={`Progress to ${next?.name ?? 'the top tier'}`} />
        <div className="pts-card__next">
          {next && total != null
            ? <>{mask(fmt(Math.max(0, next.at - total), 0))}{` to ${next.name}`}</>
            : 'Top tier'}
        </div>
      </div>

      {c.tokenPresent && (
        <button type="button" className="pf-btn" onClick={c.signOut}>Sign out</button>
      )}
    </Card>
  );
}

/**
 * What a point actually costs you.
 *
 * EVERY RATE HERE IS A RATIO OF SUMS, never a mean of weekly ratios - see
 * `seasonStats`. Averaging the weekly figures would weight a $10k week and a
 * $10M week equally, and would blow up on any week that earned almost no points.
 */
function EconomicsPanel({ c }: { c: PointsContext }) {
  const mask = useMask('funds');
  const st = c.stats;

  if (!c.address) {
    return <Card title="Per-point economics"><p className="pf-note">Connect a wallet.</p></Card>;
  }
  if (c.needsToken && !c.weeks) {
    return (
      <Card title="Per-point economics">
        <p className="pf-note">Sign in with your wallet — the button is in “Your SoPoints”.</p>
      </Card>
    );
  }
  if (!st || st.firstActiveWeek === null) {
    return (
      <Card title="Per-point economics">      </Card>
    );
  }

  const ratio = st.costVsField;
  const weeksWord = st.activeWeeks === 1 ? 'week' : 'weeks';

  return (
    <Card title="Per-point economics">
      <Group title="Against the field">
        <Row
          label="Cost vs field"
          privacy="pnl"
          value={ratio === null ? DASH : `${fmt(ratio, 2)}×`}
          cls={ratio === null ? 'pf-dim' : ratio < 1 ? 'pf-pos-text' : ratio > 1 ? 'pf-neg-text' : undefined}
          tag={ratio === null ? undefined : 'derived'}
          hint={
            ratio === null
              ? 'Needs at least one week where both your points and the venue’s volume are known.'
              : `Your dollars-per-point divided by the venue’s, over ${st.weeksCompared} week(s). `
                + 'Below 1.00× means your volume bought points at a better rate than the average '
                + 'dollar on the venue. 1.00× is exactly pro-rata.'
          }
        />
      </Group>

      <Group title={`Per week · from week ${st.firstActiveWeek}`}>
        <Row
          label="Points per week"
          value={st.avgPointsPerActiveWeek === null ? DASH : mask(fmt(st.avgPointsPerActiveWeek, 1))}
          cls={st.avgPointsPerActiveWeek === null ? 'pf-dim' : undefined}
          tag="derived"
          hint={`Total points divided by the ${st.activeWeeks} completed ${weeksWord} since your first activity. Quiet weeks after you started are counted — a week you chose not to trade is a real zero.`}
        />
      </Group>

      <Group title="Per point earned">
        <Row
          label="Volume"
          value={st.volumePerPoint === null ? DASH : mask(fmtUsd(st.volumePerPoint, 2))}
          cls={st.volumePerPoint === null ? 'pf-dim' : undefined}
          tag="derived"
          hint="Spot + futures volume you traded, divided by the points it earned."
        />
        <Row
          label="Open interest"
          value={st.oiPerPoint === null ? DASH : mask(fmtUsd(st.oiPerPoint, 2))}
          cls={st.oiPerPoint === null ? 'pf-dim' : undefined}
          tag="derived"
          hint="Each week’s average open interest, summed and divided by points. A level carried, not a flow."
        />
        <Row
          label="Realised PnL"
          privacy="pnl"
          value={st.pnlPerPoint === null ? DASH : mask(fmtUsd(st.pnlPerPoint, 2))}
          cls={st.pnlPerPoint === null ? 'pf-dim' : st.pnlPerPoint < 0 ? 'pf-neg-text' : 'pf-pos-text'}
          tag="derived"
          hint={
            st.pnlPerPoint === null
              ? 'Needs a realised PnL figure from the leaderboard.'
              : `Realised PnL over the ${c.window} window divided by season points. The two cover different spans — a rough figure, not an accounting identity.`
          }
        />
      </Group>    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * DIFFICULTY, WEEK BY WEEK.
 * ------------------------------------------------------------------------ */

const BASIS_OPTS = [
  { v: 'volume' as const, label: 'Volume', hint: 'Dollars of traded volume per SoPoint.' },
  { v: 'oi' as const, label: 'Open interest', hint: 'Dollars of week-average open interest per SoPoint.' },
];

const REF_OPTS = [
  { v: 'without' as const, label: 'Trading', hint: 'Points from your own trading. Referral points excluded.' },
  { v: 'with' as const, label: 'All', hint: 'Trading points plus referral points.' },
  { v: 'only' as const, label: 'Referral', hint: 'Referral points alone.' },
];

const BAND_OPTS = [
  { v: 'venue' as const, label: 'Venue', hint: 'Venue-wide volume and open interest.' },
  { v: 'you' as const, label: 'You', hint: 'Your own volume and open interest.' },
  { v: 'points' as const, label: 'Points', hint: 'Points you earned, split by trading and referral.' },
];

/**
 * Log-space helper, used ONLY by the ratio strip now.
 *
 * The main axis is linear - outliers are clamped instead of compressed - but a
 * ratio is genuinely multiplicative: half the field's cost and twice it are
 * equally far from parity, and only a log scale puts them equally far from 1x.
 */
const lg = (v: number) => Math.log10(v);

/** A percentile of an already-sorted array. */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i] as number;
}

interface Pt { x: number; y: number; clipped: boolean }

/**
 * Your cost per point against the field's, every week of the season.
 *
 * THE TWO LINES ARE THE SAME QUANTITY, which is the only thing that entitles
 * them to share an axis: dollars of activity per SoPoint. The overall line
 * divides the whole venue's activity by the whole fixed pool. Your line divides
 * your activity by the points you were actually awarded.
 *
 * WHY THERE IS A SEPARATE RATIO STRIP. A single week where you earned almost no
 * points sends your cost-per-point to five figures while the field sits near
 * $450 - a real case, and it blows the shared axis to nearly two decades, which
 * pins the field line flat against the floor at 2.6% height. The comparison the
 * chart exists for becomes unreadable exactly when it is most interesting. The
 * ratio strip is scale-free: it plots yours ÷ field against a 1× line, so
 * "four times the field" reads the same whether the field is $40 or $40,000.
 *
 * WHAT IT IS NOT. It is not SoDEX's formula. They weight volume, open interest,
 * vault participation and referrals through a model they retune weekly and do
 * not publish. This is a MEASURED OUTCOME - what happened, divided.
 */
function DifficultyPanel({ c }: { c: PointsContext }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const ro = useRef<ResizeObserver | null>(null);

  /*
   * A CALLBACK REF, NOT AN EFFECT. `useEffect(..., [])` runs once, on mount -
   * and on mount this panel is usually showing the "connect a wallet" card, so
   * the chart div does not exist yet. The effect found a null ref, returned
   * early, and never ran again when the div appeared: the observer was never
   * attached and the SVG was gated out forever.
   */
  const attach = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const obs = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    obs.observe(el);
    ro.current = obs;
    setSize({ w: el.clientWidth, h: el.clientHeight });
  }, []);

  const rows = c.difficulty;
  const isVol = c.basis === 'volume';

  /* The numerator on YOUR side, matched to the basis. Volume is spot + futures
     because the venue's own volume series is mixed too - 88 perp markets and 31
     spot pairs - so a futures-only numerator would be divided by a denominator
     that is not futures-only. */
  const yourVal = (d: DifficultyWeek): number | null => {
    if (isVol) return d.yours;
    if (!d.yourPoints || d.yourPoints <= 0 || d.yourOi === null) return null;
    return d.yourOi / d.yourPoints;
  };
  const fieldVal = (d: DifficultyWeek): number | null => {
    if (isVol) return d.overall;
    if (d.venueOi === null || d.coverage < MIN_COVERAGE) return null;
    return d.venueOi / d.pool;
  };
  const ratioVal = (d: DifficultyWeek): number | null => {
    const a = yourVal(d);
    const b = fieldVal(d);
    return a !== null && b !== null && b > 0 ? a / b : null;
  };

  const PAD = { l: 54, r: 10, t: 6, b: 16 };
  const GAP = 8;
  const w = Math.max(0, size.w);
  const h = Math.max(0, size.h);
  const avail = Math.max(0, h - PAD.t - PAD.b - GAP * 2);
  const mainH = avail * 0.54;
  const ratioH = avail * 0.18;
  const bandH = avail * 0.28;
  const mainTop = PAD.t;
  const ratioTop = mainTop + mainH + GAP;
  const bandTop = ratioTop + ratioH + GAP;
  const plotW = Math.max(0, w - PAD.l - PAD.r);

  const xOf = (i: number) =>
    PAD.l + (rows.length <= 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);

  /*
   * LINEAR, AND ROBUST.
   *
   * This axis used to be logarithmic, for one reason: a single week where you
   * earned almost no points sends your cost-per-point into five figures while
   * the field sits near $450, and a linear axis would flatten every other week
   * against the floor. Log survived that, but at the price of an axis nobody
   * reads naturally - "why is it logarithmic" is the correct question, and the
   * answer was "to survive one bad week".
   *
   * Clamping solves that directly and better. Tukey fences on the quartiles
   * decide what counts as an outlier, those weeks are drawn at the edge as
   * hollow dots with the true figure on hover, and the axis is then a plain
   * linear dollar scale over the range where the data actually lives. A
   * percentile trim would not do: with five active weeks the 95th percentile IS
   * the outlier. The spread floor covers the degenerate case where several weeks
   * cost almost the same and the fence would otherwise have zero width.
   *
   * The field range is always inside the domain - it is the reference line and
   * must never be squashed - and both ends are padded so neither line is drawn
   * on the frame.
   */
  const fieldVals = rows.map(fieldVal).filter((v): v is number => v !== null && v > 0);
  const yourVals = rows.map(yourVal).filter((v): v is number => v !== null && v > 0);
  const domain = (() => {
    const all = [...fieldVals, ...yourVals];
    if (!all.length) return null;
    let lo = fieldVals.length ? Math.min(...fieldVals) : Math.min(...all);
    let hi = fieldVals.length ? Math.max(...fieldVals) : Math.max(...all);
    if (yourVals.length) {
      const sorted = [...yourVals].sort((a, b) => a - b);
      const q1 = pct(sorted, 0.25);
      const q3 = pct(sorted, 0.75);
      const iqr = Math.max(q3 - q1, Math.abs(q3) * 0.25 || 1);
      lo = Math.min(lo, Math.max(sorted[0] as number, q1 - 1.5 * iqr));
      hi = Math.max(hi, Math.min(sorted[sorted.length - 1] as number, q3 + 1.5 * iqr));
    }
    if (!(hi > lo)) { lo *= 0.9; hi *= 1.1; }
    const padding = (hi - lo) * 0.1;
    return { lo: Math.max(0, lo - padding), hi: hi + padding };
  })();

  const yMain = (v: number) => {
    if (!domain) return mainTop + mainH;
    const t = (v - domain.lo) / Math.max(1e-9, domain.hi - domain.lo);
    return mainTop + mainH - Math.max(0, Math.min(1, t)) * mainH;
  };
  const clippedMain = (v: number) =>
    !!domain && (v < domain.lo || v > domain.hi);

  /* The ratio strip: log, centred on 1x, always covering at least half a decade
     each way so a near-parity season does not render as noise magnified. */
  const ratios = rows.map(ratioVal).filter((v): v is number => v !== null && v > 0);
  const rSpan = ratios.length
    ? Math.max(0.3, ...ratios.map((v) => Math.abs(lg(v)))) * 1.15
    : 0.3;
  const yRatio = (v: number) => {
    const t = (lg(v) + rSpan) / (2 * rSpan);
    return ratioTop + ratioH - Math.max(0, Math.min(1, t)) * ratioH;
  };

  const runs = (pick: (d: DifficultyWeek) => number | null, toY: (v: number) => number,
    clip?: (v: number) => boolean): Pt[][] => {
    const out: Pt[][] = [];
    let run: Pt[] = [];
    rows.forEach((d, i) => {
      const v = pick(d);
      if (v === null || v <= 0) {
        if (run.length) out.push(run);
        run = [];
        return;
      }
      run.push({ x: xOf(i), y: toY(v), clipped: clip ? clip(v) : false });
    });
    if (run.length) out.push(run);
    return out;
  };

  const path = (pts: Pt[]) =>
    pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('');

  /* The context band. Its own plot with its own scale - a USD axis and a
     USD-per-point axis sharing one rectangle is how a dual-axis chart lies. */
  const bandOf = (d: DifficultyWeek): { a: number | null; b: number | null } => {
    if (c.band === 'venue') return { a: d.venueVolume, b: c.showTvl ? d.venueTvl : d.venueOi };
    if (c.band === 'you') return { a: d.yourVolume, b: d.yourOi };
    return { a: d.yourPoints, b: null };
  };
  const bandVals = rows.flatMap((d) => [bandOf(d).a, bandOf(d).b])
    .filter((v): v is number => v !== null && v > 0);
  const bandMax = bandVals.length ? Math.max(...bandVals) : 1;
  const yBand = (v: number) => bandTop + bandH - (v / bandMax) * bandH;

  /* Round steps at 1/2/5 x 10^k, the interval closest to five gridlines. */
  const ticks = (() => {
    if (!domain) return [];
    const span = domain.hi - domain.lo;
    if (!(span > 0)) return [];
    const raw = span / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag)
      .reduce((best, cand) => (Math.abs(cand - raw) < Math.abs(best - raw) ? cand : best));
    const out: number[] = [];
    for (let v = Math.ceil(domain.lo / step) * step; v <= domain.hi; v += step) out.push(v);
    return out.slice(0, 6);
  })();

  const hovered = hover !== null ? rows[hover] : null;
  const unit = isVol ? '$ of traded volume per SoPoint' : '$ of open interest per SoPoint';
  const bandName = c.band === 'venue'
    ? `venue volume${c.showTvl ? ' + TVL' : ' + open interest'}`
    : c.band === 'you' ? 'your volume + open interest' : 'points earned';

  if (!c.address) {
    return <Card title="Difficulty"><p className="pf-note">Connect a wallet.</p></Card>;
  }
  if (c.needsToken && !c.weeks) {
    return (
      <Card title="Difficulty">
        <p className="pf-note">Sign in with your wallet — the button is in “Your SoPoints”.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Difficulty"
      action={<Seg value={c.basis} options={BASIS_OPTS} onChange={c.setBasis} label="Basis" />}
    >
      <div className="pts-chartctl">
        <Seg value={c.refMode} options={REF_OPTS} onChange={c.setRefMode} label="Points basis" />
        <Seg value={c.band} options={BAND_OPTS} onChange={c.setBand} label="Context band" />
        {c.band === 'venue' && (
          <label className="pts-check" title="Draw venue TVL instead of venue open interest.">
            <span>TVL</span>
            <input type="checkbox" checked={c.showTvl} onChange={(e) => c.setShowTvl(e.target.checked)} />
          </label>
        )}
      </div>

      <div className="pts-readout">
        {hovered ? (
          <>
            <b>{hovered.weekName ?? `Week ${hovered.weekNumber}`}</b>
            {' · field '}
            {fieldVal(hovered) === null ? DASH : fmtUsd(fieldVal(hovered) as number, 2)}
            {' · you '}
            {yourVal(hovered) === null ? DASH : fmtUsd(yourVal(hovered) as number, 2)}
            {ratioVal(hovered) !== null && (
              <b className={(ratioVal(hovered) as number) < 1 ? 'pf-pos-text' : 'pf-neg-text'}>
                {` · ${fmt(ratioVal(hovered) as number, 2)}× the field`}
              </b>
            )}
            {hovered.coverage > 0 && hovered.coverage < 1
              ? ` · ${Math.round(hovered.coverage * 7)} of 7 days`
              : ''}
          </>
        ) : (
          <span className="pf-dim">
            {unit} · band: {bandName} · hover a week
          </span>
        )}
      </div>

      <div className="pts-chart" ref={attach}>
        {w > 0 && h > 0 && rows.length > 0 && (
          <svg width={w} height={h} role="img" aria-label="Cost per SoPoint, week by week">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={w - PAD.r} y1={yMain(t)} y2={yMain(t)} className="pts-grid" />
                <text x={PAD.l - 6} y={yMain(t) + 3} className="pts-ylabel">{fmtCompactUsd(t)}</text>
              </g>
            ))}

            {/* Context band, drawn first so the lines sit over it. */}
            {rows.map((d, i) => {
              const { a, b } = bandOf(d);
              const bw = Math.max(2, plotW / Math.max(1, rows.length) - 2);
              return (
                <g key={`b${d.weekNumber}`}>
                  {a !== null && a > 0 && (
                    <rect x={xOf(i) - bw / 2} y={yBand(a)} width={bw}
                      height={Math.max(0, bandTop + bandH - yBand(a))} className="pts-band" />
                  )}
                  {b !== null && b > 0 && (
                    <line x1={xOf(i) - bw / 2} x2={xOf(i) + bw / 2} y1={yBand(b)} y2={yBand(b)}
                      className="pts-bandline" />
                  )}
                </g>
              );
            })}

            {runs(fieldVal, yMain).map((run, i) => (
              <path key={`f${i}`} d={path(run)} className="pts-line pts-line--field" />
            ))}
            {runs(yourVal, yMain, clippedMain).map((run, i) => (
              <path key={`y${i}`} d={path(run)} className="pts-line pts-line--you" />
            ))}
            {/* A week whose value sits outside the plotted domain, marked where it
                was clamped so it reads as "off the top" rather than as data. */}
            {runs(yourVal, yMain, clippedMain).flat().filter((q) => q.clipped).map((q, i) => (
              <circle key={`c${i}`} cx={q.x} cy={q.y} r="3" className="pts-clip" />
            ))}

            {/*
              The ratio strip stays multiplicative, and that is not the same
              choice as the axis above. A ratio is symmetric about 1: half the
              field's cost and twice it are equally far from parity, and only a
              multiplicative scale puts them equally far from the line. The
              0.5x/1x/2x ticks say so without a paragraph.
            */}
            {[0.5, 1, 2].filter((r) => Math.abs(lg(r)) <= rSpan).map((r) => (
              <g key={`rt${r}`}>
                <line x1={PAD.l} x2={w - PAD.r} y1={yRatio(r)} y2={yRatio(r)}
                  className={r === 1 ? 'pts-parity' : 'pts-grid'} />
                <text x={PAD.l - 6} y={yRatio(r) + 3} className="pts-ylabel">{`${fmtPlain(r)}×`}</text>
              </g>
            ))}
            {runs(ratioVal, yRatio).map((run, i) => (
              <path key={`r${i}`} d={path(run)} className="pts-line pts-line--ratio" />
            ))}

            {hover !== null && (
              <line x1={xOf(hover)} x2={xOf(hover)} y1={mainTop} y2={bandTop + bandH}
                className="pts-cross" />
            )}

            {/* One transparent column per week: a hover target that does not
                depend on landing on a 2px line. */}
            {rows.map((d, i) => (
              <rect key={`h${d.weekNumber}`}
                x={xOf(i) - plotW / Math.max(1, rows.length) / 2} y={mainTop}
                width={Math.max(2, plotW / Math.max(1, rows.length))}
                height={Math.max(0, bandTop + bandH - mainTop)} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            ))}

            {rows.map((d, i) => (
              (i === 0 || i === rows.length - 1 || i % 4 === 0) ? (
                <text key={`x${d.weekNumber}`} x={xOf(i)} y={h - 3} className="pts-xlabel">
                  {d.weekNumber}
                </text>
              ) : null
            ))}
          </svg>
        )}
      </div>

      <div className="pts-legend">
        <span><i className="pts-key pts-key--field" />Field — venue activity ÷ the pool</span>
        <span><i className="pts-key pts-key--you" />You — your activity ÷ your points</span>
        <span><i className="pts-key pts-key--ratio" />Ratio — yours ÷ field, against 1×</span>
      </div>

    </Card>
  );
}

function StandingPanel({ c }: { c: PointsContext }) {
  const maskFunds = useMask('funds');
  const maskPnl = useMask('pnl');
  const s = c.share;
  return (
    <Card
      title="Your standing"
      action={
        <PeriodSeg
          period={c.window === '24H' ? '7D' : (c.window as never)}
          onPeriod={(p) => c.setWindow((p === 'ALL' ? '30D' : p) as Window)}
          label="Window"
        />
      }
    >
      {!c.address ? (
        <NoWallet line="Connect a wallet to see your standing." compact />
      ) : !c.standing ? (
        <p className="pf-note">Not ranked in this window.</p>
      ) : (
        <>
          <Group title={`Window · ${c.window}`}>
            <Row
              label="Your volume"
              value={maskFunds(fmtUsd(c.standing.volumeUsd, 2))}
              tag="venue"
            />
            <Row
              label="Rank"
              value={maskFunds(
                c.ranked
                  ? `${fmt(c.standing.rank, 0)} of ${fmt(c.ranked, 0)}`
                  : fmt(c.standing.rank, 0),
              )}
              tag="venue"
            />
            <Row
              label="Estimated points"
              value={s ? maskFunds(fmt(s.estimatedPoints, 2)) : DASH}
              cls={s ? undefined : 'pf-dim'}
              tag={s ? 'derived' : undefined}
              tagHint={s ? `${fmtFixed(s.sharePct, 6)}% of the pool, by volume share alone.` : undefined}
            />
            <Row
              label="PnL per point"
              value={
                s?.pnlPerPoint == null ? DASH : maskPnl(fmtUsd(s.pnlPerPoint, 4))
              }
              cls={s?.pnlPerPoint != null && s.pnlPerPoint < 0 ? 'pf-neg-text' : 'pf-dim'}
              tag={s?.pnlPerPoint != null ? 'derived' : undefined}
              tagHint="What each estimated point cost you in realised PnL."
            />
          </Group>
        </>
      )}
    </Card>
  );
}

/* ---- the ladder ---------------------------------------------------------- */

function TiersPanel({ c }: { c: PointsContext }) {
  /* Prefer the REAL balance when we have it; fall back to the estimate, and say
     which one the highlighting is following. */
  const real = c.mine?.totalPoints ?? null;
  const points = real ?? c.share?.estimatedPoints ?? null;
  const now = points != null ? tierFor(points) : null;
  return (
    <Card
      title="Tiers"
      action={<span className="pf-unit">{real != null ? 'your balance' : 'estimate'}</span>}
    >
      <Group title="SoDEX's thresholds">
        {TIERS.map((t) => (
          <Row
            key={t.name}
            label={t.name}
            value={t.at === 0 ? 'from 0' : `${fmt(t.at, 0)}+`}
            cls={now?.name === t.name ? undefined : 'pf-dim'}
            tag={now?.name === t.name ? 'venue' : undefined}
            tagHint={now?.name === t.name ? 'Your current tier at this balance.' : undefined}
          />
        ))}
      </Group>    </Card>
  );
}

/* ---- the weekly table ---------------------------------------------------- */

/**
 * Every week, every field the venue reports, with the best week in each column
 * called out.
 *
 * A TABLE, NOT A ROW LIST. The old version was one `Row` per week showing points
 * alone, which threw away nine of the eleven numbers the venue actually sends.
 * Eleven columns down twenty-six weeks is a grid, and a grid wants a table:
 * columns you can scan vertically to find your best week, which a stack of
 * label/value rows makes impossible.
 *
 * THE HIGHLIGHT IS PER COLUMN. The maximum of each column is marked
 * independently - your biggest volume week and your biggest points week are
 * usually not the same week, and that mismatch is the interesting part.
 * Zero is never highlighted: in a column that is all zeros every cell would be
 * "the best", which says nothing and looks like a rendering fault.
 */
interface WeekColumn {
  key: 'points' | 'referralPoints' | 'volume' | 'spotVolume' | 'futuresVolume'
    | 'oi' | 'accountValue' | 'vaultHolding' | 'rank';
  label: string;
  hint: string;
  /** Render as a compact dollar figure rather than a plain count. */
  usd?: boolean;
  /** Lower is better, so the MINIMUM is the highlighted cell. */
  invert?: boolean;
}

const WEEK_COLUMNS: WeekColumn[] = [
  { key: 'points', label: 'Points', hint: 'SoPoints awarded for the week, excluding referrals.' },
  { key: 'referralPoints', label: 'Referral', hint: 'Points from people you invited.' },
  { key: 'volume', label: 'Volume', usd: true, hint: 'Spot + futures traded volume.' },
  { key: 'spotVolume', label: 'Spot', usd: true, hint: 'Spot traded volume.' },
  { key: 'futuresVolume', label: 'Futures', usd: true, hint: 'Futures traded volume.' },
  { key: 'oi', label: 'OI', usd: true, hint: 'Your open interest across the week.' },
  { key: 'accountValue', label: 'Account', usd: true, hint: 'Account value the venue recorded for the week.' },
  { key: 'vaultHolding', label: 'Vault', usd: true, hint: 'Vault holdings across the week.' },
  { key: 'rank', label: 'Rank', invert: true, hint: 'Your rank that week — lower is better, so the BEST rank is highlighted.' },
];

/**
 * One cell's value, or null when the venue has not published it.
 *
 * POINTS ON AN UNSCORED WEEK ARE NULL, NOT ZERO. `pointsStatus: 'TBD'` rows
 * carry `points: 0` on the wire, and SoDEX's own table never prints that number
 * - it renders the literal "TBD" instead. Showing 0 asserts the week earned
 * nothing, which is a claim the venue has not made. The traded figures on the
 * same row ARE real and stay.
 */
const weekCell = (w: PointsWeek, key: WeekColumn['key']): number | null => {
  if (w.pending && (key === 'points' || key === 'referralPoints')) return null;
  return key === 'volume' ? weekVolumeOf(w) : (w[key] as number | null);
};

function WeeksPanel({ c }: { c: PointsContext }) {
  const mask = useMask('funds');

  if (!c.address) return <Card title="Weekly points"><p className="pf-note">Connect a wallet.</p></Card>;
  if (c.needsToken && !c.weeks) {
    return (
      <Card title="Weekly points">      </Card>
    );
  }

  const rows = (c.weeks ?? []).slice().sort((a, b) => (b.weekNumber ?? 0) - (a.weekNumber ?? 0));

  /*
   * The best week per column, computed once over all rows.
   *
   * The live week is INCLUDED: it is a real, if partial, week, and excluding it
   * would hide a record someone is currently setting. It carries its own marker
   * in the Week column so a part-week topping a chart is not mistaken for a
   * finished one.
   *
   * Rank inverts - rank 1 beats rank 900 - and only counts weeks that were
   * actually ranked, since an unranked week reports 0 and 0 would win every time.
   */
  const best = new Map<string, number>();
  for (const col of WEEK_COLUMNS) {
    const vals = rows
      .map((w) => weekCell(w, col.key))
      .filter((v): v is number => v !== null && v > 0);
    if (vals.length) best.set(col.key, col.invert ? Math.min(...vals) : Math.max(...vals));
  }

  if (rows.length === 0) {
    return (
      <Card title="Weekly points">
        <p className="pf-note">{c.loading ? 'Loading…' : 'No weeks recorded yet.'}</p>
      </Card>
    );
  }

  return (
    <Card title="Weekly points" action={<span className="pf-unit">{rows.length}w</span>}>
      <div className="pts-tablewrap">
        <table className="pts-table">
          <thead>
            <tr>
              <th>Week</th>
              {WEEK_COLUMNS.map((col) => (
                <th key={col.key} className="num" title={col.hint}>{col.label}</th>
              ))}
              <th className="num" title="CONFIRMED once the week has been scored and distributed.">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w, i) => (
              <tr key={w.weekNumber ?? i} className={w.isLive ? 'is-live' : undefined}>
                <td>
                  <span className="pts-wk">
                    {w.weekName ?? (w.weekNumber != null ? `Week ${w.weekNumber}` : `#${i + 1}`)}
                  </span>
                  {w.dateRange && <span className="pts-range">{w.dateRange}</span>}
                  {w.isLive && <span className="pts-live" title="This week is still being scored — its figures are partial.">live</span>}
                </td>
                {WEEK_COLUMNS.map((col) => {
                  const v = weekCell(w, col.key);
                  const top = v !== null && v > 0 && best.get(col.key) === v;
                  return (
                    <td
                      key={col.key}
                      className={`num ${top ? 'is-best' : ''} ${v === null || v === 0 ? 'pf-dim' : ''}`}
                      title={top ? `Best week for ${col.label.toLowerCase()}` : undefined}
                    >
                      {v === null
                        ? (w.pending && (col.key === 'points' || col.key === 'referralPoints')
                          ? <span className="pts-tbd" title="SoDEX has not scored this week yet.">TBD</span>
                          : DASH)
                        : mask(col.usd ? fmtCompactUsd(v) : fmt(v, 0))}
                    </td>
                  );
                })}
                <td className="num pf-dim">{w.status ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>    </Card>
  );
}

function ProgrammePanel({ c }: { c: PointsContext }) {
  return (
    <Card title="Programme">
      <Group title="Schedule">
        <Row label="Snapshot" value={RULES.snapshot} tag="venue" />
        <Row label="Distribution" value={RULES.distribution} tag="venue" />
        <Row label="Minimum award" value={`${RULES.minimumUnit} point`} tag="venue" />
        <Row label="Referral bonus" value={`${RULES.referralBonusPct}% of an invitee's`} tag="venue" />
      </Group>
      <Group title="Your invite code">
        <Row
          label="Code"
          value={c.referral?.referralCode ?? (c.address ? (c.loading ? '…' : DASH) : DASH)}
          cls={c.referral ? undefined : 'pf-dim'}
          tag={c.referral ? 'venue' : undefined}
        />
        {c.referral && !c.referral.eligible && (
          <Row label="Eligible" value="No" cls="pf-neg-text" tag="venue" />
        )}
      </Group>
      {/* The attribution is a panel, not a footnote: it is someone else's
          programme and that is a fact about everything above it. */}    </Card>
  );
}

/**
 * The SoPoints login.
 *
 * Two steps, because that is what Privy's passwordless flow is. See
 * pointsAuth.ts for WHY it is email rather than a wallet signature: SoDEX has
 * wallet login switched off on their own Privy app, so there is nothing to sign.
 */
/**
 * Sign in, with the button carrying every state.
 *
 * ONE CONTROL, NOT A CONTROL PLUS A PARAGRAPH. A failed signature used to add a
 * line of red text under the button and leave the button saying the same thing
 * it said before - so the way to retry was to re-read a sentence and press the
 * same control again. The button now IS the state: it says what will happen,
 * what is happening, and after a failure it says Retry. The reason for the
 * failure goes to the toast rail with a code, where every other error goes.
 *
 * Only reached with an address: MinePanel gates on that before delegating here.
 */
function PointsLogin({ c }: { c: PointsContext }) {
  const failed = !!c.signInError;
  const label = c.signingIn
    ? 'Check your wallet…'
    : failed ? 'Retry sign-in'
      : 'Sign in with wallet';

  return (
    <Card title="Your SoPoints" className="pf-card--identity">
      <div className="pts-signin">
        <button
          type="button"
          className="pf-btn pf-btn--primary"
          disabled={c.signingIn || !c.provider}
          onClick={() => { void c.signIn(); }}
        >
          {label}
        </button>
        <span className="pts-signin__hint">
          {c.provider ? 'One signature. No transaction, no gas.' : 'Reconnect your wallet to sign.'}
        </span>
      </div>
    </Card>
  );
}
