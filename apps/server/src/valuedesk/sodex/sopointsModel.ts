/**
 * The SoPoints estimate (owner 2026-11-27: "our formula cant be in the frontend code, it needs to be hidden"). SoDEX
 * publishes no formula; ValueDesk fitted one from settled wallet-weeks. The page asks this server for every estimate
 * (routes/sopointsEstimate.ts) and never holds the model.
 *
 * The fitted numbers are not in this repository (it is public). They are read from a private JSON file:
 * VALUESCAN_SOPOINTS_MODEL, else <data dir>/sopoints-model.json. Without the file the route answers 503 and the page
 * shows no estimate. The file holds the weights of a week's activity, the exponent, the points per 10,000 of weighted
 * activity in a typical, a busy and a quiet week, and the rate measured in each settled week.
 *
 * A wallet's own weeks make its estimate its own (owner 2026-11-27: "include the users previous data, e.g. points
 * too ... points for 0 activity or something we dont know needs to be used in estimate and projection too"): each
 * scored week's own points (SoDEX's points before the squad's boost, minus the invited part) are held against what the
 * model explains from that week's activity. What a quiet week earns anyway is carried as `extra`, the wallet's usual
 * distance from the model as `ratio` (shrunk toward 1 when few weeks say so), and its recent invited points as
 * `referral`. What the model cannot explain in a week is returned as that week's `other`: loyalty and consistency
 * rewards, bug reports, campaigns, or the model's own error (SoDEX's own rounding of the week's points is not counted).
 *
 * The weeks to come (owner 2026-11-27: "projection needs to be more accurate ... the trend is slowly going down, use
 * last 4 weeks or something, a combination of longterm and short term"): the wallet's points before the squad's boost,
 * on a log scale, get two weighted line fits, a short one (the last 6 weeks, half-life 3 weeks) and a long one (every
 * week from week 5, after the early-bird weeks, half-life 8 weeks). Their slopes are blended 65/35 and damped by 0.9 a
 * week ahead, so a trend slows instead of running away; `factors[k]` is week k+1 ahead against this week, `sigma` the
 * short fit's scatter (the range widens with it).
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../../builder/paths.js';

export interface ModelParams {
  exponent: number;
  weights: { futures: number; spot: number; oi: number; wealth: number; vault: number };
  /** Points per 10,000 of weighted activity: a typical week, a busy week (fewer points per dollar), a quiet week (more). */
  rate: { mid: number; busy: number; quiet: number };
  /** The rate each settled Layer 1 week had, by week number. */
  weekRates: Record<string, number>;
  fittedOn: string;
  fittedAt: string;
}

export interface PlanIn {
  futures?: number;
  spot?: number;
  oi?: number;
  wealth?: number;
  vault?: number;
  /** Share of the futures volume on boosted markets (0..1) and their coefficient (SoDEX's, e.g. 1.2). */
  boostedShare?: number;
  coef?: number;
}

export interface WeekIn {
  weekNo: number;
  futures?: number;
  spot?: number;
  oi?: number;
  wealth?: number;
  vault?: number;
  /** SoDEX's points for the week, its invited part (before the boost) and the squad's boost in %. */
  points: number;
  referral?: number;
  bonusPct?: number;
}

export interface Trend {
  /** Weekly growth of the points before the squad's boost (log scale), blended short and long. */
  growth: number;
  /** Scatter of a week around the short fit (log scale). */
  sigma: number;
  /** Week k+1 ahead against this week. */
  factors: number[];
}

export interface Calibration {
  ratio: number;
  extra: number;
  referral: number;
  /** Scored weeks the ratio and extra were read from. */
  weeks: number;
  rows: Array<{ weekNo: number; own: number; explained: number; other: number }>;
  trend: Trend;
}

export interface PlanOut {
  mid: number;
  busy: number;
  quiet: number;
  /** The typical week's own points by where they come from (the activity's share of the weighted total, and extra). */
  parts: { futures: number; spot: number; oi: number; wealth: number; vault: number; extra: number };
}

const num = (x: unknown, max = 1e12): number => {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

/* ------------------------------------------------------------------------------------------- the model ----- */

const pos = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** The file's numbers, checked; null when anything is missing or out of range. */
export function parseParams(raw: unknown): ModelParams | null {
  const p = raw as Partial<ModelParams> | null;
  if (!p || typeof p !== 'object') return null;
  const w = p.weights as Partial<ModelParams['weights']> | undefined;
  const r = p.rate as Partial<ModelParams['rate']> | undefined;
  if (!pos(p.exponent) || p.exponent! > 2 || !w || !r) return null;
  if (![w.futures, w.spot, w.oi, w.wealth, w.vault].every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) return null;
  if (![r.mid, r.busy, r.quiet].every(pos) || !(r.busy! <= r.mid! && r.mid! <= r.quiet!)) return null;
  const weekRates: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.weekRates ?? {})) if (/^\d{1,3}$/.test(k) && pos(v)) weekRates[k] = v;
  return {
    exponent: p.exponent!,
    weights: { futures: w.futures!, spot: w.spot!, oi: w.oi!, wealth: w.wealth!, vault: w.vault! },
    rate: { mid: r.mid!, busy: r.busy!, quiet: r.quiet! },
    weekRates,
    fittedOn: String(p.fittedOn ?? '').slice(0, 80),
    fittedAt: String(p.fittedAt ?? '').slice(0, 20),
  };
}

export const modelPath = (): string => process.env.VALUESCAN_SOPOINTS_MODEL?.trim() || join(dataDir(), 'sopoints-model.json');

let cache: { path: string; mtime: number; checked: number; params: ModelParams | null } | null = null;

/** The private file's model, re-read when it changes (checked at most every 30 s). Null without a valid file. */
export function loadParams(path = modelPath(), now = Date.now()): ModelParams | null {
  if (cache && cache.path === path && now - cache.checked < 30_000) return cache.params;
  let mtime = -1;
  try { mtime = statSync(path).mtimeMs; } catch { /* no file */ }
  if (cache && cache.path === path && cache.mtime === mtime) { cache.checked = now; return cache.params; }
  let params: ModelParams | null = null;
  if (mtime >= 0) {
    try { params = parseParams(JSON.parse(readFileSync(path, 'utf8'))); } catch { params = null; }
  }
  cache = { path, mtime, checked: now, params };
  return params;
}

type Activity = { futures: number; spot: number; oi: number; wealth: number; vault: number };

const activityOf = (p: PlanIn | WeekIn, boosted = true): Activity => {
  const share = boosted ? Math.min(1, num((p as PlanIn).boostedShare, 1)) : 0;
  const coef = boosted ? num((p as PlanIn).coef, 10) || 1 : 1;
  return { futures: num(p.futures) * (1 + (coef - 1) * share), spot: num(p.spot), oi: num(p.oi), wealth: num(p.wealth), vault: num(p.vault) };
};

const scoreOf = (m: ModelParams, a: Activity) =>
  m.weights.futures * a.futures + m.weights.spot * a.spot + m.weights.oi * a.oi + m.weights.wealth * a.wealth + m.weights.vault * a.vault;

const ownAt = (m: ModelParams, score: number, rate: number) => (score > 0 ? rate * (score / 10_000) ** m.exponent : 0);

/* ------------------------------------------------------------------------------------- the wallet's own ----- */

/** A weighted least-squares line through (x, y); null with fewer than three points or no spread in x. */
function fitLine(pts: Array<{ x: number; y: number; w: number }>): { a: number; b: number; sigma: number } | null {
  if (pts.length < 3) return null;
  const W = pts.reduce((t, p) => t + p.w, 0);
  const mx = pts.reduce((t, p) => t + p.w * p.x, 0) / W;
  const my = pts.reduce((t, p) => t + p.w * p.y, 0) / W;
  const sxx = pts.reduce((t, p) => t + p.w * (p.x - mx) ** 2, 0);
  if (sxx <= 0) return null;
  const b = pts.reduce((t, p) => t + p.w * (p.x - mx) * (p.y - my), 0) / sxx;
  const a = my - b * mx;
  const sigma = Math.sqrt(pts.reduce((t, p) => t + p.w * (p.y - (a + b * p.x)) ** 2, 0) / W);
  return { a, b, sigma };
}

const SHORT = { weeks: 6, half: 3 };
const LONG = { from: 5, half: 8 };
const BLEND = 0.65;
const DAMP = 0.9;
export const MAX_AHEAD = 30;

/** The trend of a wallet's weekly points before the squad's boost, for `ahead` weeks after this one. */
export function trendOf(rows: ReadonlyArray<{ weekNo: number; pre: number }>, ahead: number): Trend {
  const n = Math.max(0, Math.min(MAX_AHEAD, Math.trunc(ahead)));
  const last = rows.length ? rows[rows.length - 1]!.weekNo : 0;
  const pts = (list: typeof rows, half: number) => list.map((r) => ({ x: r.weekNo, y: Math.log1p(Math.max(0, r.pre)), w: 0.5 ** ((last - r.weekNo) / half) }));
  const short = fitLine(pts(rows.filter((r) => r.weekNo > last - SHORT.weeks), SHORT.half));
  const longRows = rows.filter((r) => r.weekNo >= LONG.from);
  const long = fitLine(pts(longRows.length >= 3 ? longRows : rows, LONG.half));
  const g = short && long ? BLEND * short.b + (1 - BLEND) * long.b : short?.b ?? long?.b ?? 0;
  const growth = Math.max(-0.2, Math.min(0.2, g));
  const sigma = Math.max(0.04, Math.min(0.6, short?.sigma ?? long?.sigma ?? 0.25));
  const factors: number[] = [];
  let damp = 0;
  for (let k = 1; k <= n; k++) {
    damp += DAMP ** k;
    factors.push(Math.round(Math.exp(growth * damp) * 10_000) / 10_000);
  }
  return { growth: Math.round(growth * 10_000) / 10_000, sigma: Math.round(sigma * 1000) / 1000, factors };
}

/** Weeks whose model part is under this many points count as quiet: what they earned is the wallet's extra. */
const QUIET = 2;
/** Weeks the ratio and extra are read from: the latest scored ones. */
const RECENT = 8;

export function calibrate(m: ModelParams, weeks: readonly WeekIn[], ahead = 0): Calibration {
  const rows = weeks
    .filter((w) => Number.isInteger(w.weekNo) && w.weekNo > 0)
    .sort((a, b) => a.weekNo - b.weekNo)
    .map((w) => {
      const b = Math.min(500, num(w.bonusPct));
      const own = Math.max(0, num(w.points) / (1 + b / 100) - num(w.referral));
      const rate = m.weekRates[String(w.weekNo)] ?? m.rate.mid;
      // SoDEX's week volume already carries the boosted markets' weight, so no boost on top here.
      const explained = ownAt(m, scoreOf(m, activityOf(w, false)), rate);
      // SoDEX rounds the week's points and the invited part to whole points: what that leaves is not "other".
      const round = 0.5 / (1 + b / 100) + 0.55;
      const other = Math.abs(own - explained) <= round ? 0 : own - explained;
      return { weekNo: w.weekNo, own, explained, other, referral: num(w.referral), pre: num(w.points) / (1 + b / 100) };
    });
  const recent = rows.slice(-RECENT);
  const quiet = recent.filter((r) => r.explained < QUIET);
  const extra = quiet.length ? median(quiet.map((r) => r.own)) : 0;
  const active = recent.filter((r) => r.explained >= QUIET);
  // Shrunk toward 1: one week's ratio also carries that week's own busy-or-quiet swing.
  const raw = active.length ? median(active.map((r) => (r.own - extra) / r.explained)) : 1;
  const ratio = Math.min(2.5, Math.max(0.4, 1 + (raw - 1) * (active.length / (active.length + 2))));
  const referral = median(rows.slice(-4).map((r) => r.referral));
  return {
    ratio: Math.round(ratio * 1000) / 1000,
    extra: r1(extra),
    referral: r1(referral),
    weeks: recent.length,
    rows: rows.map((r) => ({ weekNo: r.weekNo, own: r1(r.own), explained: r1(r.explained), other: r1(r.other) })),
    trend: trendOf(rows, ahead),
  };
}

/** One plan's own points (before invited points and the squad's boost) in a typical, a busy and a quiet week. */
export function estimatePlan(m: ModelParams, plan: PlanIn, cal: Pick<Calibration, 'ratio' | 'extra'> | null): PlanOut {
  const a = activityOf(plan);
  const score = scoreOf(m, a);
  const ratio = cal?.ratio ?? 1;
  const extra = cal?.extra ?? 0;
  const at = (rate: number) => ratio * ownAt(m, score, rate) + extra;
  const mid = at(m.rate.mid);
  const trade = mid - extra;
  const part = (k: keyof Activity) => (score > 0 ? r1((trade * m.weights[k] * a[k]) / score) : 0);
  return {
    mid: r1(mid),
    busy: r1(at(m.rate.busy)),
    quiet: r1(at(m.rate.quiet)),
    parts: { futures: part('futures'), spot: part('spot'), oi: part('oi'), wealth: part('wealth'), vault: part('vault'), extra: r1(extra) },
  };
}

export const MAX_PLANS = 16;
export const MAX_WEEKS = 40;

/** The route's answer for one request body; null when the body is not a request. */
export function answer(m: ModelParams, body: unknown): { model: { fittedOn: string; fittedAt: string }; plans: PlanOut[]; calib: Calibration | null } | null {
  const b = (body ?? {}) as { plans?: unknown; weeks?: unknown; ahead?: unknown };
  if (!Array.isArray(b.plans) || b.plans.length > MAX_PLANS) return null;
  if (b.weeks !== undefined && (!Array.isArray(b.weeks) || b.weeks.length > MAX_WEEKS)) return null;
  const plans = b.plans.filter((p): p is PlanIn => !!p && typeof p === 'object');
  const weeks = Array.isArray(b.weeks)
    ? b.weeks.filter((w): w is WeekIn => !!w && typeof w === 'object').map((w) => ({ ...w, weekNo: Math.trunc(Number(w.weekNo)) }))
    : [];
  const calib = weeks.length ? calibrate(m, weeks, Number(b.ahead) || 0) : null;
  return { model: { fittedOn: m.fittedOn, fittedAt: m.fittedAt }, plans: plans.map((p) => estimatePlan(m, p, calib)), calib };
}
