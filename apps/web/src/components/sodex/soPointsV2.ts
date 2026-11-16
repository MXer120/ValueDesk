/**
 * SoPoints, Layer 1 Season: the signed-in wallet's own figures as SoDEX's points page reads them (their bundle,
 * 2026-11-16: biz/sopoints/v2/summary, /week/list, /team/bonus behind the sign-in token; /team/boost/config public),
 * and the arithmetic the page builds on them (owner 2026-11-16: "squad boost needs to show the users squad boost",
 * "more actually useful analytics which explain traders how to earn more sopoints while keeping them simple").
 *
 * What is SoDEX's and what is ours:
 *  - Every field below is SoDEX's, read as is.
 *  - points = round((own + referral) x (1 + squad %)) is fitted from 19 of the owner's wallets (all referral-only weeks
 *    within 1 point); the split of a week into own / referral / boost uses it.
 *  - "Twice the volume earns about 1.6x the points" is fitted (exponent ~0.62-0.71 on volume share) and is labelled
 *    an estimate wherever it is shown.
 */
import { useEffect, useState } from 'react';
import { authed, fetchVenueDaily, type BoostConfig, type DailyPoint, type VolumeWeights } from '../../points';

const BIZ = 'https://alpha-biz.sodex.dev';

export interface S2Summary {
  totalPoints: number;
  basePoints?: number;
  boostPoints?: number;
  referralPoints?: number;
  currentTier: string;
  nextTier?: string | null;
  nextTierPoints?: number | null;
  rank?: number;
  totalUser?: number;
}

export interface S2WeightDetail { marketType: string; symbol: string; coefficient: string; rawVolumeU: string; weightedVolumeU: string }

export interface S2Week {
  weekNo: number;
  weekName: string;
  status: string;
  weekStartTime: number;
  weekEndTime: number;
  distributionTime: number;
  isLive: boolean;
  spotVolume: number;
  futuresVolume: number;
  futuresVolumeWeightDetails?: S2WeightDetail[];
  vaultHolding: number | null;
  wealthTvl: number | null;
  oi: number | null;
  accountValue: number | null;
  teamWeekVolume: number;
  teamWindowVolume: number;
  totalBonusPct: number | null;
  points: number;
  referralPoints: number;
  pointsStatus: string;
  rank: number;
  totalUser: number;
  rankPercentile: string;
}

export interface S2TeamBonus {
  eligible: boolean;
  teamMemberCount: number;
  activeTeamCount: number;
  isEarlyBird: boolean;
  windowRounds: number;
  /** The squad the wallet joined (its inviter's), USD over the window. */
  uplineTeamVolume: string | number;
  /** The squad the wallet built (its invitees), USD over the window. */
  downlineTeamVolume: string | number;
  asOfTsMs: number;
}

export const fetchS2Summary = (a: string) => authed<S2Summary>(`${BIZ}/biz/sopoints/v2/summary`, a);
export const fetchS2Weeks = (a: string) => authed<S2Week[]>(`${BIZ}/biz/sopoints/v2/week/list`, a).then((r) => r ?? []);
export const fetchS2TeamBonus = (a: string) => authed<S2TeamBonus>(`${BIZ}/biz/sopoints/v2/team/bonus`, a);

/** Season 1 (before Layer 1): SoDEX's v1 list, newest first, "Closed Alpha" last. Same token. */
export interface S1Week {
  weekName: string;
  weekStartTime: number;
  weekEndTime: number;
  spotVolume: number;
  futuresVolume: number;
  vaultHolding: number;
  oi: number;
  accountValue: number;
  points: number;
  referralPoints: number;
  pointsStatus: string;
  rank: number;
  totalUser: number;
}
export const fetchS1Weeks = (a: string) => authed<S1Week[]>(`${BIZ}/biz/sopoints/week/list`, a).then((r) => r ?? []);

/** One bar of the all-weeks charts: either season, oldest first. */
export interface AnyWeek {
  key: string;
  season: 'S1' | 'L1';
  /** "W12" (Season 1) or "L3" (Layer 1). */
  short: string;
  name: string;
  start: number;
  split: WeekSplit;
}

/** Season 1 and Layer 1 weeks on one line, oldest first; Closed Alpha (a 4-month period) is left out of the charts. */
export function allWeeks(s1: S1Week[], l1: S2Week[]): AnyWeek[] {
  const a: AnyWeek[] = s1
    .filter((w) => /Week\s+\d+/i.test(w.weekName))
    .map((w) => {
      const n = Number(/Week\s+(\d+)/i.exec(w.weekName)![1]);
      const as2: S2Week = { weekNo: n, weekName: w.weekName, status: 'COMPLETED', weekStartTime: w.weekStartTime, weekEndTime: w.weekEndTime, distributionTime: 0, isLive: false, spotVolume: w.spotVolume, futuresVolume: w.futuresVolume, vaultHolding: w.vaultHolding, wealthTvl: 0, oi: w.oi, accountValue: w.accountValue, teamWeekVolume: 0, teamWindowVolume: 0, totalBonusPct: 0, points: w.points, referralPoints: w.referralPoints, pointsStatus: w.pointsStatus, rank: w.rank, totalUser: w.totalUser, rankPercentile: '' };
      return { key: `s1-${n}`, season: 'S1' as const, short: `W${n}`, name: `Season 1 · ${w.weekName}`, start: w.weekStartTime, split: splitWeek(as2) };
    });
  const b: AnyWeek[] = l1.map((w) => ({ key: `l1-${w.weekNo}`, season: 'L1' as const, short: `L${w.weekNo}`, name: `Layer 1 · ${w.weekName}`, start: w.weekStartTime, split: splitWeek(w) }));
  return [...a, ...b].sort((x, y) => x.start - y.start);
}

/* --- squad boost ------------------------------------------------------------------------------------------------ */

/** The +% one squad's window volume reaches on SoDEX's ladder (0 below the first step). */
export function stepPct(volume: number, cfg: BoostConfig): number {
  let pct = 0;
  for (const t of [...cfg.tiers].sort((a, b) => Number(a.threshold) - Number(b.threshold))) if (volume >= Number(t.threshold)) pct = t.bonusPct;
  return pct;
}

/** The next step above `volume`: its threshold, its +% and how much volume is missing. Null at the top. */
export function nextStep(volume: number, cfg: BoostConfig): { threshold: number; pct: number; missing: number } | null {
  const t = [...cfg.tiers].sort((a, b) => Number(a.threshold) - Number(b.threshold)).find((x) => volume < Number(x.threshold));
  return t ? { threshold: Number(t.threshold), pct: t.bonusPct, missing: Number(t.threshold) - volume } : null;
}

export interface SquadBreakdown {
  joined: { volume: number; pct: number; next: ReturnType<typeof nextStep> };
  built: { volume: number; pct: number; next: ReturnType<typeof nextStep>; members: number; active: number };
  earlyBird: number;
  /** SoDEX's own total for the week in progress when it has one, else the sum of the parts. */
  total: number;
  fromSodex: boolean;
}

export function squadBreakdown(bonus: S2TeamBonus, cfg: BoostConfig, liveWeek: S2Week | null): SquadBreakdown {
  const jv = Number(bonus.uplineTeamVolume) || 0;
  const bv = Number(bonus.downlineTeamVolume) || 0;
  const joined = { volume: jv, pct: stepPct(jv, cfg), next: nextStep(jv, cfg) };
  const built = { volume: bv, pct: stepPct(bv, cfg), next: nextStep(bv, cfg), members: bonus.teamMemberCount, active: bonus.activeTeamCount };
  const earlyBird = bonus.isEarlyBird ? cfg.earlyBirdBonusPct : 0;
  const sodex = liveWeek?.totalBonusPct;
  // Early bird (+20%) applied to Layer 1 weeks 1-4 only: every one of 19 measured wallets drops by exactly 20 from week 4 to 5.
  const sum = joined.pct + built.pct;
  return { joined, built, earlyBird, total: typeof sodex === 'number' ? sodex : sum, fromSodex: typeof sodex === 'number' };
}

/* --- a week, split ----------------------------------------------------------------------------------------------- */

export interface WeekSplit {
  week: S2Week;
  own: number;
  referral: number;
  boost: number;
  volume: number;
  /** USD of the wallet's own volume per own point; null without both. */
  dollarsPerPoint: number | null;
}

/** points = (own + referral) x (1 + squad %): the boost is what the multiplier added. Unscored weeks split to nothing. */
export function splitWeek(w: S2Week): WeekSplit {
  const volume = (w.spotVolume || 0) + (w.futuresVolume || 0);
  if (w.pointsStatus !== 'CONFIRMED') return { week: w, own: 0, referral: 0, boost: 0, volume, dollarsPerPoint: null };
  const mult = 1 + (w.totalBonusPct ?? 0) / 100;
  const before = w.points / mult;
  const referral = Math.min(w.referralPoints || 0, before);
  // A residue under 1% of the week is rounding in SoDEX's referral figure, not trading.
  const rawOwn = Math.max(0, before - referral);
  const own = rawOwn < w.points * 0.01 ? 0 : rawOwn;
  const boost = Math.max(0, w.points - before);
  return { week: w, own, referral, boost, volume, dollarsPerPoint: own >= 1 && volume >= 1000 ? volume / own : null };
}

/* --- this week so far ------------------------------------------------------------------------------------------ */

/** Our fitted exponent on volume share (Season 1: 0.71, Layer 1: ~0.62): points grow slower than volume. */
export const VOLUME_EXPONENT = 0.65;

export interface WeekForecast {
  live: S2Week;
  volume: number;
  /** The wallet's own dollars of volume per point, median of its last scored trading weeks; null when it has none. */
  dpp: number | null;
  /** Points from trading so far, before the squad boost (estimate). */
  own: number | null;
  /** The same with this week's squad boost on top (estimate). */
  boosted: number | null;
  /** What the next $10K of volume adds, boost included (estimate; concave). */
  per10k: number | null;
}

export function forecastWeek(weeks: S2Week[]): WeekForecast | null {
  const live = weeks.find((w) => w.isLive);
  if (!live) return null;
  const volume = (live.spotVolume || 0) + (live.futuresVolume || 0);
  const past = weeks.filter((w) => !w.isLive && w.pointsStatus === 'CONFIRMED').sort((a, b) => b.weekNo - a.weekNo).map(splitWeek)
    .map((x) => x.dollarsPerPoint).filter((x): x is number => x !== null).slice(0, 4).sort((a, b) => a - b);
  const dpp = past.length ? past[Math.floor(past.length / 2)]! : null;
  const mult = 1 + (live.totalBonusPct ?? 0) / 100;
  const own = dpp && volume > 0 ? volume / dpp : dpp ? 0 : null;
  const boosted = own !== null ? own * mult : null;
  // Marginal points of the next $10K: d(points)/d(volume) = k * points / volume on a power law; from zero, the plain rate.
  const per10k = dpp ? (volume > 0 && own ? VOLUME_EXPONENT * (own / volume) * 10_000 : 10_000 / dpp) * mult : null;
  return { live, volume, dpp, own, boosted, per10k };
}

/* --- the field ---------------------------------------------------------------------------------------------------- */

/** The venue's traded volume inside each week, from the daily series (half-open [start, start + 7 d)). */
export function venueVolumeByWeek(weeks: S2Week[], daily: DailyPoint[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const w of weeks) {
    const from = w.weekStartTime * 1000;
    const to = from + 7 * 86_400_000;
    const rows = daily.filter((p) => p.ts >= from - 12 * 3_600_000 && p.ts < to - 12 * 3_600_000);
    if (rows.length >= 6) out.set(w.weekNo, rows.reduce((s, p) => s + p.value, 0));
  }
  return out;
}

/** The venue's mean open interest inside each week (a stock: averaged, not summed). */
export function venueOiByWeek(weeks: S2Week[], daily: DailyPoint[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const w of weeks) {
    const from = w.weekStartTime * 1000;
    const to = from + 7 * 86_400_000;
    const rows = daily.filter((p) => p.ts >= from - 12 * 3_600_000 && p.ts < to - 12 * 3_600_000);
    if (rows.length >= 6) out.set(w.weekNo, rows.reduce((t, p) => t + p.value, 0) / rows.length);
  }
  return out;
}

/**
 * What the platform figures leave out for one week (owner 2026-11-16, "All four"): accounts 1002 + 23342's volume
 * (known from 2026-11-06 on; null before) and SoDEX's internal pair's mean open interest (null without prices).
 */
export interface MmWeek { volume: number | null; oi: number | null }

export interface MmDay { date: string; volume: number | null; internalOi: number | null }

/** Server 1's /api/vs/sodex/mm-daily (valuedesk/sodex/mmDaily.ts). Null on any failure: the platform then includes them. */
export async function fetchMmDaily(fromMs: number): Promise<{ days: MmDay[]; takersOiNow: number | null } | null> {
  try {
    const r = await fetch(`/api/vs/sodex/mm-daily?from=${fromMs}`, { headers: { Accept: 'application/json' } });
    const j = (await r.json()) as { ok?: boolean; days?: MmDay[]; takersOiNow?: number | null };
    return r.ok && j.ok && Array.isArray(j.days) ? { days: j.days, takersOiNow: typeof j.takersOiNow === 'number' ? j.takersOiNow : null } : null;
  } catch {
    return null;
  }
}

/** The days folded onto the points weeks: volume summed only when every day of the week is known; OI averaged. */
export function mmByWeek(weeks: S2Week[], days: MmDay[] | null): Map<number, MmWeek> | null {
  if (!days) return null;
  const out = new Map<number, MmWeek>();
  for (const w of weeks) {
    const from = w.weekStartTime * 1000 - 12 * 3_600_000;
    const to = from + 7 * 86_400_000;
    const inWeek = days.filter((d) => { const t = Date.parse(`${d.date}T00:00:00Z`); return t >= from && t < to; });
    if (inWeek.length < 6) continue;
    const vols = inWeek.map((d) => d.volume);
    const ois = inWeek.map((d) => d.internalOi).filter((x): x is number => x !== null);
    out.set(w.weekNo, {
      volume: vols.every((v) => v !== null) ? (vols as number[]).reduce((a, b) => a + b, 0) : null,
      oi: ois.length >= 6 ? ois.reduce((a, b) => a + b, 0) / ois.length : null,
    });
  }
  return out;
}

/**
 * Difficulty, week by week, both seasons: dollars per point. Yours by volume (your volume / your trading points) and by
 * open interest (your mean OI / your trading points). The platform's (the venue's volume or mean OI, less the big
 * accounts, over the week's pool) for Layer 1 weeks only: Season 1's weekly pool is not published. Lower is easier.
 *
 * The big accounts (owner 2026-11-16: "the 2-4 mm accounts need to be excluded for platform difficulty"):
 *  - SoDEX's internal pair: its open interest every week (its sizes priced each day).
 *  - 1002 + 23342: their volume as measured from 2026-11-06; before that, their measured share of the venue's volume
 *    applied to the week (marked estimated); their open interest now taken off every week (marked estimated).
 */
export interface DifficultyRow {
  key: string;
  short: string;
  name: string;
  season: 'S1' | 'L1';
  youVol: number | null;
  youOi: number | null;
  platVol: number | null;
  platOi: number | null;
  /** How 1002 + 23342's volume was taken out: measured, estimated from their share, or not at all. */
  volOut: 'measured' | 'estimated' | null;
  /** Whether the big accounts' open interest was taken out (the takers' part is an estimate). */
  oiOut: boolean;
}

export function difficultyRows(all: AnyWeek[], venueVol: Map<number, number>, venueOi: Map<number, number>, mm: Map<number, MmWeek> | null, pool: number | null, takersOi: number | null): DifficultyRow[] {
  // 1002 + 23342's share of the venue's volume over the weeks it was measured.
  let mv = 0;
  let vv = 0;
  for (const [n, m] of mm ?? []) { const v = venueVol.get(n); if (m.volume !== null && v) { mv += m.volume; vv += v; } }
  const share = vv > 0 ? Math.min(1, mv / vv) : null;
  return all.filter((r) => !r.split.week.isLive).map((r) => {
    const sp = r.split;
    const w = sp.week;
    const l1 = r.season === 'L1';
    const m = l1 ? mm?.get(w.weekNo) ?? null : null;
    const v = l1 ? venueVol.get(w.weekNo) : undefined;
    const o = l1 ? venueOi.get(w.weekNo) : undefined;
    const mmVol = m?.volume ?? (v && share !== null ? v * share : null);
    const volOut: DifficultyRow['volOut'] = m?.volume != null ? 'measured' : mmVol !== null ? 'estimated' : null;
    const mmOi = m?.oi != null ? m.oi + (takersOi ?? 0) : null;
    return {
      key: r.key,
      short: r.short,
      name: r.name,
      season: r.season,
      youVol: sp.own >= 1 && sp.volume >= 1000 ? sp.volume / sp.own : null,
      youOi: sp.own >= 1 && (w.oi ?? 0) >= 1 ? (w.oi as number) / sp.own : null,
      platVol: v && pool ? Math.max(0, v - (mmVol ?? 0)) / pool : null,
      platOi: o && pool ? Math.max(0, o - (mmOi ?? 0)) / pool : null,
      volOut,
      oiOut: mmOi !== null,
    };
  });
}

/* --- how to earn more -------------------------------------------------------------------------------------------- */

export interface Tip {
  id: 'squad' | 'boosted' | 'pace' | 'steady' | 'hold' | 'invite';
  title: string;
  /** The one figure that matters, already formatted. */
  value: string;
  line: string;
  /** "estimate" when the line rests on our fit rather than on SoDEX's own numbers. */
  kind: 'fact' | 'estimate';
}

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1e4 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n).toLocaleString('en-US')}`);

export function earnTips(input: {
  weeks: S2Week[];
  squad: SquadBreakdown | null;
  cfg: BoostConfig | null;
  weights: VolumeWeights | null;
  pool: number | null;
  venue: Map<number, number>;
}): Tip[] {
  const tips: Tip[] = [];
  const scored = input.weeks.filter((w) => w.pointsStatus === 'CONFIRMED').sort((a, b) => b.weekNo - a.weekNo);
  const last = scored[0] ?? null;
  const s = input.squad;

  // 1. The squad: the cheapest next step.
  if (s && input.cfg) {
    const steps = [
      s.built.next && { who: 'your squad', ...s.built.next },
      s.joined.next && s.joined.volume > 0 && { who: 'the squad you joined', ...s.joined.next },
    ].filter(Boolean) as Array<{ who: string; threshold: number; pct: number; missing: number }>;
    const best = steps.sort((a, b) => a.missing - b.missing)[0];
    if (best) {
      const gain = best.pct - (best.who === 'your squad' ? s.built.pct : s.joined.pct);
      tips.push({ id: 'squad', kind: 'fact', title: 'Next squad step', value: `+${gain}%`,
        line: `${usd(best.missing)} more volume in ${best.who} over the ${input.cfg.windowRounds}-week window lifts every point you earn by ${gain}% more (to +${best.pct}%).` });
    } else if (s.built.volume === 0 && s.joined.volume === 0) {
      tips.push({ id: 'squad', kind: 'fact', title: 'Join a squad', value: `up to +${input.cfg.maxTotalBonusPct}%`,
        line: 'You are in no squad. A squad multiplies every point you earn, referral points included.' });
    }
  }

  // 2. Boosted markets.
  const boosted = input.weights?.weights ?? [];
  if (boosted.length) {
    const coef = Math.max(...boosted.map((b) => Number(b.coefficient) || 1));
    const lastBoosted = last?.futuresVolumeWeightDetails?.reduce((n, d) => n + (Number(d.rawVolumeU) || 0), 0) ?? 0;
    const share = last && last.futuresVolume > 0 ? lastBoosted / last.futuresVolume : 0;
    tips.push({ id: 'boosted', kind: 'fact', title: 'Boosted markets', value: `×${coef}`,
      line: `${boosted.slice(0, 4).map((b) => b.symbol.replace('-USD', '')).join(', ')}${boosted.length > 4 ? ` and ${boosted.length - 4} more` : ''} count ×${coef} this round.${last && last.futuresVolume > 0 ? ` ${Math.round(share * 100)}% of your futures volume last week was in boosted markets.` : ''}` });
  }

  // 3. Your pace against the field: dollars of volume per point.
  const traded = scored.map(splitWeek).find((x) => x.dollarsPerPoint !== null);
  if (traded && input.pool) {
    const v = input.venue.get(traded.week.weekNo);
    const field = v ? v / input.pool : null;
    tips.push({ id: 'pace', kind: 'fact', title: 'Your cost per point', value: `${usd(traded.dollarsPerPoint!)}`,
      line: `${traded.week.weekName}: ${usd(traded.dollarsPerPoint!)} of your volume per point${field ? `, against ${usd(field)} for the whole venue` : ''}.` });
  }

  // 4. Steady beats one big week (our fit).
  tips.push({ id: 'steady', kind: 'estimate', title: 'Steady beats big', value: '2× → ~1.6×',
    line: 'Points grow slower than volume: twice the volume earned about 1.6× the points in the weeks we measured. Trading every week earns more than the same volume in one week.' });

  // 5. Holdings and open positions.
  const holds = scored.slice(0, 4).some((w) => (w.wealthTvl ?? 0) > 1 || (w.vaultHolding ?? 0) > 1);
  tips.push({ id: 'hold', kind: 'fact', title: 'Holdings count too', value: holds ? 'Earning' : 'Not used',
    line: holds ? 'Your Wealth or SLP Vault balance is earning points. Larger holdings earn more.' : 'Wealth products, the SLP Vault and open positions earn points without trading. You hold none of these.' });

  // 6. Referrals.
  const ref = last?.referralPoints ?? 0;
  tips.push({ id: 'invite', kind: 'fact', title: 'Invites', value: ref > 0 ? `+${ref.toLocaleString('en-US')}` : '25%',
    line: ref > 0 ? `Your invitees earned you ${ref.toLocaleString('en-US')} referral points last week (25% of their points), before your squad boost.` : 'You get 25% of the points your invitees earn, and they get +5%.' });

  return tips;
}

/* --- the week log ------------------------------------------------------------------------------------------------ */

/**
 * Every signed-in wallet's weeks go to our server once per browser session (owner 2026-11-16: "log all weeks of user
 * data with all the infos once they connect"; server routes/sopointsLog.ts). Only SoDEX's own figures; never the token.
 * A failure is silent: the page works the same without it.
 */
export function logWeeks(address: string, d: { summary: S2Summary | null; bonus: S2TeamBonus | null; layer1: S2Week[]; season1: S1Week[] }): void {
  if (!d.layer1.length && !d.season1.length) return;
  const key = `vd.sopoints.logged.${address.toLowerCase()}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    /* no storage: send anyway */
  }
  void fetch('/api/vs/sopoints/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ address, summary: d.summary ?? undefined, bonus: d.bonus ?? undefined, layer1: d.layer1, season1: d.season1 }),
  }).catch(() => {});
}

/* --- the hook ---------------------------------------------------------------------------------------------------- */

export interface S2State {
  summary: S2Summary | null;
  weeks: S2Week[];
  s1: S1Week[];
  venueOiDaily: DailyPoint[];
  mmDays: MmDay[] | null;
  takersOiNow: number | null;
  bonus: S2TeamBonus | null;
  venueDaily: DailyPoint[];
  loading: boolean;
  error: string | null;
}

export function useSoPointsV2(address: string | null, signedIn: boolean): S2State {
  // Loading from the first render when the wallet is signed in, so nothing shows a default before the reads start.
  const [s, set] = useState<S2State>({ summary: null, weeks: [], s1: [], venueOiDaily: [], mmDays: null, takersOiNow: null, bonus: null, venueDaily: [], loading: !!address && signedIn, error: null });
  useEffect(() => {
    if (!address || !signedIn) { set({ summary: null, weeks: [], s1: [], venueOiDaily: [], mmDays: null, takersOiNow: null, bonus: null, venueDaily: [], loading: false, error: null }); return; }
    let live = true;
    set((x) => ({ ...x, loading: true, error: null }));
    void Promise.allSettled([fetchS2Summary(address), fetchS2Weeks(address), fetchS2TeamBonus(address), fetchVenueDaily('volume', 90), fetchS1Weeks(address), fetchVenueDaily('open-interest', 90), fetchMmDaily(Date.now() - 90 * 86_400_000)]).then(([a, b, c, d, e, g, h]) => {
      if (!live) return;
      const err = [a, b, c].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      logWeeks(address, {
        summary: a.status === 'fulfilled' ? a.value : null,
        bonus: c.status === 'fulfilled' ? c.value : null,
        layer1: b.status === 'fulfilled' ? b.value : [],
        season1: e.status === 'fulfilled' ? e.value : [],
      });
      set({
        summary: a.status === 'fulfilled' ? a.value : null,
        weeks: b.status === 'fulfilled' ? b.value : [],
        s1: e.status === 'fulfilled' ? e.value : [],
        venueOiDaily: g.status === 'fulfilled' ? g.value : [],
        mmDays: h.status === 'fulfilled' ? h.value?.days ?? null : null,
        takersOiNow: h.status === 'fulfilled' ? h.value?.takersOiNow ?? null : null,
        bonus: c.status === 'fulfilled' ? c.value : null,
        venueDaily: d.status === 'fulfilled' ? d.value : [],
        loading: false,
        error: err ? String((err.reason as Error)?.message ?? err.reason) : null,
      });
    });
    return () => { live = false; };
  }, [address, signedIn]);
  return s;
}
