/**
 * SoPoints data.
 *
 * SOPOINTS ARE SODEX'S PROGRAMME, NOT OURS. We award nothing, hold nothing and
 * decide nothing here: this page reads their public endpoints and does arithmetic
 * on top. Every figure below is either something SoDEX published or something we
 * derived from two things SoDEX published, and the page labels which is which.
 *
 * WHAT IS PUBLIC AND WHAT IS NOT. The week, the pool, the squad boost config, the
 * boosted markets, a wallet's rank/volume/PnL, the venue's traded volume and a
 * wallet's referral code are all readable with no credentials. A wallet's OWN
 * balance, weeks and squad are not: `biz/sopoints/v2/summary` and `.../week/list`
 * answer 401 without a SoDEX token, and that sign-in is off (SODEX_SIGNIN_LIVE).
 *
 * Browser-direct, like performance.ts: these are public reads, and routing them
 * through our own backend would add a hop and a rate limit for nothing.
 */

import { SODEX_POINTS_SIGNIN_LIVE } from './sodexProgrammes';

const BIZ = 'https://alpha-biz.sodex.dev';
const DATA = 'https://mainnet-data.sodex.dev';

/** SoDEX's envelope. `code` 0 is success; anything else is an error with a msg. */
async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).pathname}`);
  const j = (await r.json()) as { code?: number; msg?: string; message?: string; data?: T };
  if (j?.code !== 0) throw new Error(j?.msg || j?.message || `code ${j?.code}`);
  return j.data as T;
}

/* ---------------------------------------------------------------------------
 * The tier ladder.
 *
 * COPIED EXACTLY from SoDEX's own FAQ ("How do SoPoints map to tiers?"), because
 * these are their thresholds and an approximation would be a lie about someone
 * else's programme. Their page writes the numbers with dot separators
 * (1.000 / 10.000 / 50.000) in the European style; those are 1,000 / 10,000 /
 * 50,000, not decimals.
 * ------------------------------------------------------------------------ */
export interface Tier { name: string; at: number }

export const TIERS: readonly Tier[] = [
  { name: 'Iron', at: 0 },
  { name: 'Bronze', at: 10 },
  { name: 'Silver', at: 100 },
  { name: 'Gold', at: 1_000 },
  { name: 'Diamond', at: 10_000 },
  { name: 'Epic', at: 50_000 },
];

export const tierFor = (points: number): Tier =>
  [...TIERS].reverse().find((t) => points >= t.at) ?? TIERS[0]!;

/* ---------------------------------------------------------------------------
 * The programme's own rules, quoted from SoDEX's FAQ so the page can state them
 * without paraphrasing someone else's terms into something subtly different.
 * ------------------------------------------------------------------------ */
/*
 * `weeklyPool` is deliberately typed `number`, not narrowed to its literal.
 *
 * `as const` alone made it the type `1000000`, so passing it anywhere that takes
 * a plain pool size - `difficultyByWeek`, `seasonStats` - was a type error the
 * moment the venue's own `weekPoolPoints` was threaded through instead. The
 * value is a default, not a constant of the universe. The page always shows the
 * pool the API reports (1,000,000 while SoDEX's page text says 900,000).
 *
 * The weekdays and season come from SoDEX's page text. Its clock times (14:00 UTC+1)
 * are not repeated here: they are an hour off the API's own timestamps, and the page
 * prints those instead.
 */
export const RULES: {
  season: string;
  seasonWeeks: number;
  weeklyPool: number;
  snapshot: string;
  distribution: string;
  minimumUnit: number;
  referralBonusPct: number;
  inviteeBoostPct: number;
} = {
  season: 'Layer1 Season',
  seasonWeeks: 20,
  weeklyPool: 1_000_000,
  snapshot: 'Every Tuesday, covering the prior week',
  distribution: 'Every Friday',
  minimumUnit: 1,
  referralBonusPct: 25,
  inviteeBoostPct: 5,
} as const;

/** `GET biz/sopoints/v2/week/info`. Times are unix seconds. */
export interface WeekInfo {
  weekNo: number;
  weekName: string;
  weekStatus: string;
  weekPoolPoints: number;
  nextWeekStartTime: number;
  distributionTime: number;
}

export const fetchWeek = (): Promise<WeekInfo> => get<WeekInfo>(`${BIZ}/biz/sopoints/v2/week/info`);

/** `GET biz/sopoints/v2/team/boost/config`. `threshold` is a decimal string of USD volume ("Energy"). */
export interface BoostConfig {
  windowRounds: number;
  maxTotalBonusPct: number;
  earlyBirdRounds: number;
  earlyBirdBonusPct: number;
  tiers: Array<{ threshold: string; bonusPct: number }>;
}

export const fetchBoostConfig = (): Promise<BoostConfig> => get<BoostConfig>(`${BIZ}/biz/sopoints/v2/team/boost/config`);

/** `GET mainnet-data /api/v1/points/volume-weights`: this round's boosted markets. */
export interface VolumeWeights {
  activity_id: number;
  round: { round_id: number; start_ts_ms: number; end_ts_ms: number };
  weights: Array<{ market_type: string; symbol_id: number; symbol: string; coefficient: string }>;
}

export const fetchVolumeWeights = (): Promise<VolumeWeights> => get<VolumeWeights>(`${DATA}/api/v1/points/volume-weights`);

export interface Standing {
  accountId: number;
  rank: number;
  volumeUsd: number;
  pnlUsd: number;
  snapshotTs: number;
  found: boolean;
}

export type Window = '24H' | '7D' | '30D';

/**
 * The rank endpoint's windows, which are NOT the leaderboard list's.
 *
 * `ALL_TIME` is accepted here and is the only window that pairs honestly with a
 * season points total; `ALL` is rejected outright (`invalid window_type`), and
 * `90D` works too. Kept separate from `Window` because the segmented control
 * above the standing panel offers the three short ones and nothing else.
 */
export type RankWindow = Window | '90D' | 'ALL_TIME';

export async function fetchStanding(address: string, window: RankWindow): Promise<Standing | null> {
  const d = await get<{
    found?: boolean;
    snapshot_ts?: number;
    item?: { account_id?: number; rank?: number; volume_usd?: string; pnl_usd?: string };
  }>(`${DATA}/api/v1/leaderboard/rank?window_type=${window}&wallet_address=${address}`);
  if (!d?.found || !d.item) return null;
  return {
    accountId: d.item.account_id ?? 0,
    rank: d.item.rank ?? 0,
    volumeUsd: Number(d.item.volume_usd ?? 0),
    pnlUsd: Number(d.item.pnl_usd ?? 0),
    snapshotTs: d.snapshot_ts ?? 0,
    found: true,
  };
}

/** How many wallets are ranked at all - the denominator behind a rank. */
export async function fetchRankedCount(window: Window): Promise<number | null> {
  const d = await get<{ total?: number }>(
    `${DATA}/api/v1/leaderboard?window_type=${window}&sort_by=volume&sort_order=desc&page=1&page_size=10`,
  );
  return typeof d?.total === 'number' ? d.total : null;
}

/**
 * The venue's own traded volume over a date range.
 *
 * This is the denominator that makes "difficulty" a real number rather than a
 * feeling: a fixed pool divided by everything competing for it. It is reported
 * per day per market, so it has to be summed.
 */
export async function fetchVenueVolume(days: number): Promise<{ total: number; days: number }> {
  const day = 86_400_000;
  const end = new Date(Date.now()).toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * day).toISOString().slice(0, 10);
  const d = await get<{ data?: Array<{ day_date: string; markets?: Record<string, string> }> }>(
    `${DATA}/api/v1/dashboard/volume?start_date=${start}&end_date=${end}`,
  );
  /*
   * EXACTLY `days` DAYS, trimmed from the end.
   *
   * The range is inclusive of both endpoints, so asking for a 7-day span returns
   * EIGHT daily rows - and dividing a WEEKLY pool by eight days of volume
   * understates difficulty by about an eighth. Take the most recent `days` rows
   * and report the count that was actually used, so the label cannot disagree
   * with the arithmetic.
   */
  const all = (d?.data ?? []).slice().sort((a, b) => a.day_date.localeCompare(b.day_date));
  const rows = all.slice(-days);
  let total = 0;
  for (const r of rows) {
    const m = r.markets ?? {};
    for (const k in m) total += Number(m[k]) || 0;
  }
  return { total, days: rows.length };
}

/* ---------------------------------------------------------------------------
 *  THE VENUE'S OWN DAILY SERIES.
 *
 *  The pool is fixed at 1,000,000 points a week. What changes is how much
 *  activity is competing for it - and that is observable, per day, for the whole
 *  season. These four series are the denominator behind every "overall" figure
 *  on the points page.
 * ------------------------------------------------------------------------ */

export type VenueMetric = 'volume' | 'open-interest' | 'tvl' | 'users';

export interface DailyPoint {
  /** YYYY-MM-DD, the venue's own day key. */
  date: string;
  /** Milliseconds. */
  ts: number;
  value: number;
}

/**
 * One venue-wide metric, daily.
 *
 * THREE RESPONSE SHAPES, one reader. `volume` and `open-interest` come as a map
 * of ~94 markets that has to be summed; `tvl` is a single `value`; `users` is a
 * running `cumulativeUsers`. Normalising here means every caller downstream
 * handles one shape.
 */
export async function fetchVenueDaily(metric: VenueMetric, days: number): Promise<DailyPoint[]> {
  const day = 86_400_000;
  const end = new Date(Date.now()).toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * day).toISOString().slice(0, 10);
  const d = await get<{
    data?: Array<{
      day_date: string;
      timestamp?: number;
      markets?: Record<string, string>;
      value?: string;
      cumulativeUsers?: number;
      newUsers?: number;
    }>;
  }>(`${DATA}/api/v1/dashboard/${metric}?start_date=${start}&end_date=${end}`);

  return (d?.data ?? [])
    .map((r) => {
      let value = 0;
      if (r.markets) for (const k in r.markets) value += Number(r.markets[k]) || 0;
      else if (r.value !== undefined) value = Number(r.value) || 0;
      else if (r.cumulativeUsers !== undefined) value = Number(r.cumulativeUsers) || 0;
      return {
        date: r.day_date,
        ts: Number(r.timestamp) || Date.parse(`${r.day_date}T00:00:00Z`),
        value,
      };
    })
    .sort((a, b) => a.ts - b.ts);
}

/** The venue's activity over one SoPoints week. */
export interface VenueWeek {
  weekNumber: number;
  /** Traded volume across the week, USD. A FLOW: summed. */
  volume: number | null;
  /** Mean open interest across the week, USD. A STOCK: averaged. */
  oi: number | null;
  /** Mean total value locked across the week, USD. A STOCK: averaged. */
  tvl: number | null;
  /** How many daily rows actually fell inside the week - 7 for a complete one. */
  days: number;
  /**
   * `days / 7`. One for a finished week, less for the week in progress or one
   * the venue has a gap in. The pool is scaled by this - see `difficultyByWeek`.
   */
  coverage: number;
}

/**
 * Fold the daily series onto the venue's own week boundaries.
 *
 * SUMMED OR AVERAGED, AND THE DIFFERENCE IS NOT COSMETIC. Volume is a FLOW: a
 * week's volume is the seven days added up. Open interest and TVL are STOCKS -
 * the same dollar open on Monday and still open on Tuesday is one position, not
 * two - so a week's figure is the average of the daily readings. Summing a stock
 * would multiply it by seven and make every "per dollar of OI" ratio wrong by
 * that factor.
 *
 * The week boundaries come from the venue's own `weekStartTime`/`weekEndTime`
 * (seconds) rather than being recomputed from a calendar, so a week that does
 * not start on the day we would have guessed still lines up.
 */
export function venueByWeek(
  weeks: PointsWeek[],
  series: { volume?: DailyPoint[]; oi?: DailyPoint[]; tvl?: DailyPoint[] },
): Map<number, VenueWeek> {
  const out = new Map<number, VenueWeek>();

  for (const w of weeks) {
    if (w.weekNumber === null || w.weekStart === null || w.weekEnd === null) continue;
    /*
     * HALF-OPEN, [start, start + 7 days).
     *
     * `weekEndTime` is 23:59:59 of the last day, so an inclusive test happens to
     * give the same seven rows - every week the venue returns is midnight
     * aligned and exactly 7.0000 days long, which was checked across all 27 of
     * them. Half-open is used anyway because it stays correct if that ever stops
     * being true, and because an inclusive upper bound against a midnight
     * timestamp is one schema change away from silently counting eight days.
     */
    const from = w.weekStart * 1000;
    const to = from + 7 * 86_400_000;
    const inWeek = (p: DailyPoint) => p.ts >= from && p.ts < to;

    const vol = (series.volume ?? []).filter(inWeek);
    const oi = (series.oi ?? []).filter(inWeek);
    const tvl = (series.tvl ?? []).filter(inWeek);
    const mean = (xs: DailyPoint[]) =>
      (xs.length ? xs.reduce((sum, x) => sum + x.value, 0) / xs.length : null);

    const days = Math.max(vol.length, oi.length, tvl.length);
    out.set(w.weekNumber, {
      weekNumber: w.weekNumber,
      volume: vol.length ? vol.reduce((sum, x) => sum + x.value, 0) : null,
      oi: mean(oi),
      tvl: mean(tvl),
      days,
      coverage: Math.min(1, days / 7),
    });
  }

  return out;
}

export interface Referral { referralCode: string; eligible: boolean }

export const fetchReferral = (address: string): Promise<Referral> =>
  get<Referral>(`${BIZ}/biz/referral/public/referralCode?walletAddress=${address}`);

/* ---------------------------------------------------------------------------
 * The derived figures.
 *
 * READ THIS BEFORE TRUSTING A NUMBER ON THE PAGE. SoDEX distributes a fixed
 * weekly pool using, in their words, "a dynamic points-weighing model" that they
 * "fine-tune weekly based on the platform's operational stage, market depth, and
 * overall user behavior" - and points also come from referrals, Vault
 * participation and holding assets, not only from trading.
 *
 * So a pure volume share is NOT their formula and this does not claim to be. It
 * is the honest first-order approximation available from public data: if the
 * pool were split by traded volume alone, this is what a given volume would be
 * worth. It is useful for the question people actually ask - "is it getting
 * harder?" - and it is labelled an estimate everywhere it appears.
 * ------------------------------------------------------------------------ */
export interface Difficulty {
  /** Points awarded per $1 of volume, if the pool were split by volume alone. */
  pointsPerDollar: number;
  /** The same figure the other way up, which is the readable one. */
  dollarsPerPoint: number;
  venueVolume: number;
  pool: number;
}

export function difficultyFrom(pool: number, venueVolume: number): Difficulty | null {
  if (!(pool > 0) || !(venueVolume > 0)) return null;
  const pointsPerDollar = pool / venueVolume;
  return { pointsPerDollar, dollarsPerPoint: 1 / pointsPerDollar, venueVolume, pool };
}

export interface YourShare {
  sharePct: number;
  estimatedPoints: number;
  /** Below SoDEX's 1-point minimum, a week's trading rounds to nothing. */
  belowMinimum: boolean;
  /** Realised PnL per estimated point. Null when no points are estimated. */
  pnlPerPoint: number | null;
}

export function shareFrom(d: Difficulty, yourVolume: number, yourPnl: number): YourShare {
  const estimatedPoints = yourVolume * d.pointsPerDollar;
  return {
    sharePct: (yourVolume / d.venueVolume) * 100,
    estimatedPoints,
    belowMinimum: estimatedPoints < RULES.minimumUnit,
    pnlPerPoint: estimatedPoints > 0 ? yourPnl / estimatedPoints : null,
  };
}

/* ===========================================================================
 *  YOUR ACTUAL POINTS.
 *
 *  `biz/sopoints/summary` and `biz/sopoints/week/list` are the real thing - your
 *  balance, your tier, your week-by-week table. Both answer
 *  `401 Unauthorized: missing bearer token` to an anonymous caller, and the
 *  token is earned by SIGNING WITH YOUR WALLET: nonce, one `personal_sign`,
 *  access token. That is the same flow SoDEX's own points page runs, and
 *  pointsAuth.ts documents the protocol.
 *
 *  HOW THE TOKEN IS HELD. sessionStorage, filed under the address that signed
 *  for it, and dropped when the tab closes. Two reasons for the pairing:
 *
 *    - It is an identity credential for a whole SoDEX account, not a read-only
 *      points key, so it gets the shortest lifetime that still avoids a second
 *      wallet prompt on every navigation. SoDEX would honour it for ~15 days;
 *      we do not keep it that long.
 *    - Someone with two wallets will connect both. A token filed without its
 *      address would be sent for whichever is connected now, and the answer
 *      would be the OTHER wallet's points, silently and wrongly.
 *
 *  It is sent to SoDEX's hosts and to nothing of ours. None of this runs while
 *  SODEX_SIGNIN_LIVE is false: `authed` below refuses first. The v2 paths answer
 *  401 today, so their row shapes have not been seen; the readers below keep the
 *  defensive field lists they had for v1, and a rename comes out as a dash.
 * ======================================================================== */

const TOKEN_KEY = 'ot.sopoints.token';

interface StoredToken { address: string; token: string }

function readStored(): StoredToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<StoredToken>;
    if (typeof j?.address === 'string' && typeof j?.token === 'string') {
      return { address: j.address, token: j.token };
    }
    return null;
  } catch {
    /* storage disabled, or a value written by an older build */
    return null;
  }
}

/**
 * The token for THIS address.
 *
 * Passing an address that does not match what is stored returns nothing rather
 * than the stored token - see the note above about two wallets.
 */
export function getPointsToken(address?: string | null): string {
  const s = readStored();
  if (!s) return '';
  if (address && s.address.toLowerCase() !== address.toLowerCase()) return '';
  return s.token;
}

/** The address the current token belongs to, for UI that wants to say so. */
export function pointsTokenAddress(): string | null {
  return readStored()?.address ?? null;
}

export function setPointsToken(address: string, token: string): void {
  try {
    const t = token.trim().replace(/^Bearer\s+/i, '');
    if (t && address) sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ address, token: t }));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage disabled - the token simply will not persist across a reload */
  }
}

export function clearPointsToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Raised when a call needs a token we do not have, so the UI can offer to sign. */
export class NeedsPointsToken extends Error {
  constructor() {
    super('Sign in with your wallet to read your SoPoints.');
    this.name = 'NeedsPointsToken';
  }
}

export async function authed<T>(url: string, address: string): Promise<T> {
  if (!SODEX_POINTS_SIGNIN_LIVE) throw new NeedsPointsToken();
  const token = getPointsToken(address);
  if (!token) throw new NeedsPointsToken();
  const r = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const j = (await r.json().catch(() => null)) as
    | { code?: number; msg?: string; message?: string; data?: T }
    | null;
  /* 401 means the token is absent, wrong or expired - all of which the user
     fixes the same way, so they get the same actionable error rather than a
     status code. An expired token is also dropped, so the UI does not keep
     retrying with a credential that is known to be dead. */
  if (r.status === 401 || j?.code === 401) {
    clearPointsToken();
    throw new NeedsPointsToken();
  }
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).pathname}`);
  if (j?.code !== 0) throw new Error(j?.msg || j?.message || `code ${j?.code}`);
  return j.data as T;
}

/**
 * Your points balance and tier.
 *
 * `wallet_address` IS IGNORED BY THE VENUE. Both points endpoints answer for the
 * wallet that owns the BEARER TOKEN and echo that address back, whatever is put
 * in the query string - asking for the top trader by 30-day volume returns our
 * own empty row, with `walletAddress` rewritten to ours. The parameter is sent
 * because SoDEX's own client sends it, and the address argument is kept because
 * it selects the right stored token, but neither can point this at somebody
 * else's account. That is also why /scan cannot show a scanned wallet's points.
 *
 * The field names are read defensively: this is an undocumented endpoint on
 * someone else's service, and a rename on their side should degrade to a dash
 * rather than crash the page.
 */
export interface PointsSummary {
  totalPoints: number | null;
  weekPoints: number | null;
  tierName: string | null;
  rank: number | null;
  raw: Record<string, unknown>;
}

/**
 * "Week 26" -> 26. Not every row is a numbered week.
 *
 * There is NO `weekNumber` field on the wire - the rows carry `weekName` and
 * `weekLabel`, both "Week 26" - so the digits in the label are the only source.
 * The pattern is SoDEX's own (`/Week\s+(\d+)/i` in their `rxe`), deliberately
 * anchored on the word: the season's first row is labelled "Closed Alpha", which
 * a bare `\d+` would either miss or match garbage in. Their mapper gives that
 * row `weekNum: 0`; this returns null, which keeps it out of the difficulty
 * chart and the venue join while leaving it in the table where it belongs.
 */
function weekNumberOf(r: Record<string, unknown>): number | null {
  const direct = Number(r.weekNumber ?? r.week_number ?? r.week);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const label = String(r.weekLabel ?? r.weekName ?? r.week_name ?? '');
  const m = label.match(/Week\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** "Jul 18 - Jul 24". Seconds in, the venue's own formatting out. */
function dateRangeOf(startS: number | null, endS: number | null): string | null {
  if (startS === null || endS === null) return null;
  try {
    const f = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', {
      month: 'short', day: '2-digit', timeZone: 'UTC',
    });
    return `${f(startS)} – ${f(endS)}`;
  } catch {
    return null;
  }
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function fetchMyPoints(address: string): Promise<PointsSummary> {
  const d = await authed<Record<string, unknown>>(
    `${BIZ}/biz/sopoints/v2/summary?wallet_address=${address}`,
    address,
  );
  return {
    totalPoints: numOrNull(d.totalPoints ?? d.total_points ?? d.total ?? d.points),
    weekPoints: numOrNull(d.weekPoints ?? d.week_points ?? d.currentWeekPoints),
    tierName: (d.tierName ?? d.tier_name ?? d.tier ?? null) as string | null,
    rank: numOrNull(d.rank ?? d.ranking),
    raw: d,
  };
}

/** One row of the week-by-week points table. */
/**
 * One week of YOUR SoPoints, as the venue reports it.
 *
 * Everything here is `biz/sopoints/week/list`'s own field, renamed but not
 * reinterpreted. The two volumes are kept SEPARATE rather than pre-summed: spot
 * and futures are weighted differently by the venue's model, and a caller that
 * wants the total can add them, while one that wants the split cannot get it
 * back out of a sum.
 *
 * `points` vs `referralPoints`: the venue reports them as two fields and the
 * summary endpoint reports totalPoints and referralPoints separately too. This
 * type does not assume which contains which - see `weekPointsOf` for the one
 * place that decision is made and stated.
 */
export interface PointsWeek {
  weekNumber: number | null;
  weekName: string | null;
  /** Unix SECONDS, as the venue sends them. */
  weekStart: number | null;
  weekEnd: number | null;
  distributedAt: number | null;
  spotVolume: number | null;
  futuresVolume: number | null;
  /** Your open interest for the week, USD. */
  oi: number | null;
  accountValue: number | null;
  vaultHolding: number | null;
  vaultHoldingsAvgHour: number | null;
  points: number | null;
  referralPoints: number | null;
  /** 'CONFIRMED' once distributed; 'TBD' while the week is still being scored. */
  status: string | null;
  /**
   * True while SoDEX has not scored the week yet.
   *
   * THE POINTS FIELD IS 0 ON THESE ROWS AND THAT ZERO IS NOT A RESULT. SoDEX's
   * own table renders `pointsStatus === 'TBD' ? 'TBD' : '+' + points`, i.e. it
   * never shows the number for an unscored week. Printing the raw 0 claims the
   * week earned nothing, which is a different statement from "not counted yet".
   */
  pending: boolean;
  /** "Jul 18 - Jul 24", the span SoDEX prints beside the week name. */
  dateRange: string | null;
  /** True for the week in progress - its figures are partial by definition. */
  isLive: boolean;
  rank: number | null;
  totalUser: number | null;
  raw: Record<string, unknown>;
}

/** Spot + futures, when either is known. */
export const weekVolumeOf = (w: PointsWeek): number | null =>
  w.spotVolume === null && w.futuresVolume === null
    ? null
    : (w.spotVolume ?? 0) + (w.futuresVolume ?? 0);

/**
 * Points for a week under the chosen referral treatment.
 *
 * WHICH FIELD HOLDS WHAT. The venue sends `points` and `referralPoints` as two
 * numbers and never says whether the first includes the second. Both readings
 * are handled rather than guessed:
 *
 *   'with'    points + referralPoints, if they are disjoint
 *   'without' points alone
 *   'only'    referralPoints alone
 *
 * `'without'` is the honest DEFAULT for difficulty, because referral points are
 * not earned by trading and mixing them into a volume-per-point rate makes a
 * referrer look far more efficient than their own trading was.
 */
export type ReferralMode = 'with' | 'without' | 'only';

export function weekPointsOf(w: PointsWeek, mode: ReferralMode): number | null {
  /* Unscored: the venue has not decided yet, so there is no number to return.
     Reading the wire's placeholder 0 would put a real zero into every average. */
  if (w.pending) return null;
  const base = w.points;
  const ref = w.referralPoints;
  if (mode === 'only') return ref;
  if (mode === 'without') return base;
  if (base === null && ref === null) return null;
  return (base ?? 0) + (ref ?? 0);
}

export async function fetchMyWeeks(address: string): Promise<PointsWeek[]> {
  const d = await authed<Record<string, unknown>>(
    `${BIZ}/biz/sopoints/v2/week/list?wallet_address=${address}&page=1&page_size=52`,
    address,
  );
  const rows = (Array.isArray(d) ? d : (d.list ?? d.items ?? d.records ?? d.data ?? [])) as
    Array<Record<string, unknown>>;
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    /*
     * PARSED OUT OF THE LABEL, because there is no numeric field.
     *
     * The wire row carries `weekName` and `weekLabel` - both "Week 26" - and NO
     * `weekNumber` of any spelling. Reading one left every row numbered null,
     * which silently emptied the venue-by-week map that keys off it. The digits
     * in the label are the only source, so they are the source.
     */
    weekNumber: weekNumberOf(r),
    weekName: (r.weekLabel ?? r.weekName ?? r.week_name ?? null) as string | null,
    weekStart: numOrNull(r.weekStartTime ?? r.week_start_time),
    weekEnd: numOrNull(r.weekEndTime ?? r.week_end_time),
    distributedAt: numOrNull(r.distributionTime ?? r.distributed_at ?? r.time),
    spotVolume: numOrNull(r.spotVolume ?? r.spot_volume),
    futuresVolume: numOrNull(r.futuresVolume ?? r.futures_volume),
    oi: numOrNull(r.oi ?? r.openInterest ?? r.open_interest),
    accountValue: numOrNull(r.accountValue ?? r.account_value),
    vaultHolding: numOrNull(r.vaultHolding ?? r.vault_holding),
    vaultHoldingsAvgHour: numOrNull(r.vaultHoldingsAvgHour ?? r.vault_holdings_avg_hour),
    points: numOrNull(r.points ?? r.point ?? r.weekPoints ?? r.amount),
    referralPoints: numOrNull(r.referralPoints ?? r.referral_points),
    status: (r.pointsStatus ?? r.points_status ?? null) as string | null,
    pending: String(r.pointsStatus ?? r.points_status ?? '').toUpperCase() === 'TBD',
    dateRange: dateRangeOf(numOrNull(r.weekStartTime), numOrNull(r.weekEndTime)),
    isLive: r.isLive === true || r.is_live === true,
    rank: numOrNull(r.rank),
    totalUser: numOrNull(r.totalUser ?? r.total_user),
    raw: r,
  }));
}

/* ---------------------------------------------------------------------------
 *  YOUR SEASON, SUMMARISED.
 * ------------------------------------------------------------------------ */

export interface SeasonStats {
  /** The first week this wallet did anything at all. Null if it never has. */
  firstActiveWeek: number | null;
  /**
   * Weeks counted in the averages: from `firstActiveWeek` to the last COMPLETE
   * week. See the note below on why the live week is excluded.
   */
  activeWeeks: number;
  /** Weeks inside that span where something actually happened. */
  weeksWithActivity: number;
  totalPoints: number;
  totalVolume: number;
  /** Sum of each week's mean OI - "OI-weeks", the denominator-friendly form. */
  totalOiWeeks: number;
  /** totalPoints / activeWeeks. */
  avgPointsPerActiveWeek: number | null;
  /** USD of your traded volume per point earned. */
  volumePerPoint: number | null;
  /** USD of open interest carried per point earned. */
  oiPerPoint: number | null;
  /**
   * USD of realised PnL per point earned, both over the whole season.
   *
   * The PnL must come from the venue's `ALL_TIME` window. Pairing a 7-day PnL
   * with 26 weeks of points - which this did - divides two spans that have
   * nothing to do with each other and produces a number that is simply wrong.
   */
  pnlPerPoint: number | null;
  /**
   * Your cost per point divided by the field's, over the weeks where both are
   * known. Below 1 means your dollars bought points at a better rate than the
   * average dollar on the venue; 1.00x is exactly pro-rata.
   */
  costVsField: number | null;
  /** How many weeks that comparison actually covers. */
  weeksCompared: number;
}

const isActive = (w: PointsWeek): boolean =>
  (w.spotVolume ?? 0) > 0 || (w.futuresVolume ?? 0) > 0 || (w.oi ?? 0) > 0
  || (w.points ?? 0) > 0 || (w.referralPoints ?? 0) > 0 || (w.vaultHolding ?? 0) > 0;

/**
 * Averages over the season, counted from when this wallet first showed up.
 *
 * WHY IT COUNTS FROM THE FIRST ACTIVE WEEK. The venue returns all 26 weeks of
 * the season for everyone, including the ones before an account existed. Dividing
 * by 26 would tell someone who joined in week 24 that they average a fraction of
 * what they actually earn, which is not a fact about them - it is a fact about
 * when the season started. So the denominator is weeks SINCE THEY ARRIVED.
 *
 * WHY THE LIVE WEEK IS EXCLUDED. `isLive` marks a week still being scored: its
 * volume is however far into the week we are, and its points are `TBD`. Averaging
 * a part-week in drags every figure down for no reason, and does it worst on a
 * Monday. Quiet-but-complete weeks after arrival ARE counted - a week you chose
 * not to trade is a real zero and belongs in your average.
 *
 * The RATES are ratios of totals, not means of ratios. A week where you traded
 * $2M for 400 points and one where you traded $10 for 0.002 points should
 * combine by weight, not by treating both weeks as equally informative.
 */
export function seasonStats(
  weeks: PointsWeek[],
  mode: ReferralMode,
  pnlUsd: number | null,
  venue?: Map<number, VenueWeek>,
  pool = RULES.weeklyPool,
): SeasonStats {
  const settled = weeks.filter((w) => !w.isLive && w.weekNumber !== null);
  const active = settled.filter(isActive);

  const firstActiveWeek = active.length
    ? Math.min(...active.map((w) => w.weekNumber as number))
    : null;

  const counted = firstActiveWeek === null
    ? []
    : settled.filter((w) => (w.weekNumber as number) >= firstActiveWeek);

  let totalPoints = 0;
  let totalVolume = 0;
  let totalOiWeeks = 0;
  for (const w of counted) {
    totalPoints += weekPointsOf(w, mode) ?? 0;
    totalVolume += weekVolumeOf(w) ?? 0;
    totalOiWeeks += w.oi ?? 0;
  }

  /* A rate with no points earned is not zero, it is undefined - and rendering it
     as 0 would read as "free points", the exact opposite of the truth. */
  const per = (x: number): number | null => (totalPoints > 0 ? x / totalPoints : null);

  /*
   * THE SEASON RATIO IS A RATIO OF SUMS, NEVER A MEAN OF RATIOS.
   *
   * Averaging the weekly cost-per-point figures would weight a $10,000 week and
   * a $10,000,000 week equally, and would blow up entirely on any week that
   * earned almost no points. Summing both sides first weights each week by the
   * activity it actually carried, and stays finite as long as any points were
   * earned at all.
   *
   * Only weeks where BOTH sides are known are counted, so the two halves of the
   * ratio always cover exactly the same weeks.
   */
  let compYourVolume = 0;
  let compYourPoints = 0;
  let compVenueVolume = 0;
  let compPoolWeighted = 0;
  let weeksCompared = 0;
  if (venue) {
    for (const w of counted) {
      const v = w.weekNumber === null ? undefined : venue.get(w.weekNumber);
      if (!v || v.volume === null || v.coverage < MIN_COVERAGE) continue;
      const pts = weekPointsOf(w, mode) ?? 0;
      const vol = weekVolumeOf(w) ?? 0;
      if (pts <= 0) continue;
      compYourVolume += vol;
      compYourPoints += pts;
      compVenueVolume += v.volume;
      compPoolWeighted += pool * v.coverage;
      weeksCompared += 1;
    }
  }
  const yoursSeason = compYourPoints > 0 ? compYourVolume / compYourPoints : null;
  const fieldSeason = compPoolWeighted > 0 ? compVenueVolume / compPoolWeighted : null;

  return {
    firstActiveWeek,
    activeWeeks: counted.length,
    weeksWithActivity: counted.filter(isActive).length,
    totalPoints,
    totalVolume,
    totalOiWeeks,
    avgPointsPerActiveWeek: counted.length ? totalPoints / counted.length : null,
    volumePerPoint: per(totalVolume),
    oiPerPoint: per(totalOiWeeks),
    pnlPerPoint: pnlUsd === null ? null : per(pnlUsd),
    costVsField: yoursSeason !== null && fieldSeason ? yoursSeason / fieldSeason : null,
    weeksCompared,
  };
}

/* ---------------------------------------------------------------------------
 *  DIFFICULTY, WEEK BY WEEK.
 * ------------------------------------------------------------------------ */

export interface DifficultyWeek {
  weekNumber: number;
  weekName: string | null;
  isLive: boolean;
  /**
   * VENUE volume per point issued, USD. The pool is fixed, so this is what the
   * field as a whole had to trade to move one point - the rate you are competing
   * against.
   */
  overall: number | null;
  /**
   * YOUR volume per point earned, USD. What one point actually cost you.
   * Below the overall line means you earned at a better rate than the field.
   */
  yours: number | null;
  /** Raw inputs, so the chart can show what the ratio was built from. */
  yourPoints: number | null;
  yourVolume: number | null;
  yourOi: number | null;
  venueVolume: number | null;
  venueOi: number | null;
  venueTvl: number | null;
  pool: number;
  /** Fraction of the week the venue series actually covers. 1 when complete. */
  coverage: number;
}

/**
 * How much of a week must be observable before its difficulty is drawn at all.
 *
 * Scaling the pool by coverage makes a partial week COMPARABLE, not reliable: a
 * Monday-morning reading is one day extrapolated over seven, and a single quiet
 * or frantic day moves it enormously. Five of seven bounds that error to
 * something a reader will not be misled by, and below it the week is gapped with
 * the reason named rather than drawn as a spike.
 */
export const MIN_COVERAGE = 5 / 7;

/**
 * The one number on this page that is ours rather than the venue's.
 *
 * BOTH SIDES ARE THE SAME QUANTITY, which is the only reason they may share an
 * axis: dollars of traded volume per SoPoint. The overall line divides the whole
 * venue's volume by the whole fixed pool; your line divides your volume by your
 * points. Where your line sits below the overall one, your dollars bought points
 * at a better rate than the average dollar on the venue did.
 *
 * WHAT THIS IS NOT. It is not their formula. SoDEX weigh volume, open interest,
 * vault participation and referrals through a model they retune weekly and do
 * not publish. Volume-per-point is a MEASURED OUTCOME - what actually happened,
 * divided - not a prediction of what the next dollar will earn. A week where you
 * held size without trading will show an expensive-looking rate for exactly that
 * reason, and the OI overlay is there so that is visible rather than mysterious.
 */
export function difficultyByWeek(
  weeks: PointsWeek[],
  venue: Map<number, VenueWeek>,
  mode: ReferralMode,
  pool: number,
): DifficultyWeek[] {
  return weeks
    .filter((w) => w.weekNumber !== null)
    .map((w) => {
      const n = w.weekNumber as number;
      const v = venue.get(n);
      const yourPoints = weekPointsOf(w, mode);
      const yourVolume = weekVolumeOf(w);
      return {
        weekNumber: n,
        weekName: w.weekName,
        isLive: w.isLive,
        /*
         * THE POOL IS SCALED TO THE DAYS WE ACTUALLY HAVE.
         *
         * Dividing three days of venue volume by a whole week's pool is a
         * category error: the numerator covers three days and the denominator
         * seven, so the live week always renders as dramatically "easier" than
         * every finished week beside it, and the ratio against your own line is
         * out by 7/3. Scaling the pool by coverage puts both sides over the same
         * window - arithmetically the same as (daily mean volume x 7) / pool -
         * so the live week reads as a RATE at this week's pace rather than as a
         * week that has collapsed in difficulty.
         */
        overall: v?.volume != null && pool > 0 && v.coverage >= MIN_COVERAGE
          ? v.volume / (pool * v.coverage)
          : null,
        coverage: v?.coverage ?? 0,
        /* Undefined rather than infinite when no points were earned: a week that
           produced nothing has no cost-per-point, and plotting it as a spike to
           the top of the axis would flatten every real week beneath it. */
        yours: yourPoints && yourPoints > 0 && yourVolume !== null
          ? yourVolume / yourPoints
          : null,
        yourPoints,
        yourVolume,
        yourOi: w.oi,
        venueVolume: v?.volume ?? null,
        venueOi: v?.oi ?? null,
        venueTvl: v?.tvl ?? null,
        pool,
      };
    })
    .sort((a, b) => a.weekNumber - b.weekNumber);
}
