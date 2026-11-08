/**
 * What a bot is estimated to do per $1M on a market, with every setting that changes it (owner 2026-11-08: "market
 * gate, flow gates etc don't change estimate per $1M"; "make it more accurate the more data we get, automatically").
 *
 * Layers, each a line the receipt shows:
 *   market      the market's own reading (bots/data.ts estCostBps): what small makers' fills cost there, recomputed
 *               from the latest trades every 5 minutes. It is R10's (calibrated on our live runs).
 *   bot         the recipe's measured difference to R10 (bots/recipes.ts), from live runs and the replay.
 *   market gate the reading over only the fills after a calm minute (gateCostBps), and the volume that keeps.
 *   flow gate   the reading over only the fills while uninformed flow traded enough here (flowGate buckets).
 *   spread      the same while the spread stayed under the limit (spreadGate buckets).
 *   quiet hours the hour-of-day profile (hourly) without the hours the windows cover.
 *   your bots   what this wallet's own bots really did, blended in by volume: on this market and bot first, else
 *               the fleet's bias against its estimates. The more they trade, the more it weighs.
 * A layer without enough fills under it falls back to the tests' figure, or says it is not measured.
 */
import type { AlgoView } from '@copy-engine';
import type { BotMarket } from './data';
import type { BotDraft, QuietWindow } from './presets';
import { RECIPE, recipeOfDraft, recipeOfSpec, type Recipe, type RecipeId } from './recipes';

export type Source = 'market' | 'tests' | 'yours' | 'none';
/**
 * One line of the estimate. `counted: false`: a saving only our backtests or a few live rounds show, on a bot not yet
 * proven live; shown, but not taken off the estimate (owner 2026-11-08: people read the cost alone, so the cost holds
 * only what is measured; an extra cost from tests still counts).
 */
export interface EstLine { id: string; label: string; bp: number | null; source: Source; note?: string; counted?: boolean }
export interface BotEstimate {
  /** All-in per $1M, bp (negative earns); null: no reading on this market. */
  bp: number | null;
  low: number | null;
  high: number | null;
  /** Of the market's volume the bot would quote into, against R10 with no safeguard (1 = the same). */
  volumeX: number;
  lines: EstLine[];
  /** What the wallet's own bots added: their volume and its weight (0..1). */
  learned: { volumeUsd: number; weight: number; scope: 'market' | 'fleet' } | null;
  confidence: BotMarket['confidence'] | null;
}

/** USD of the wallet's own volume that weighs as much as the market's reading. */
export const PRIOR_USD = 250_000;
const NOT_COUNTED = 'Our tests show this saving; not counted until proven live';
/** A saving (negative) that only tests show, on a bot not proven live: shown, not counted. */
const unproven = (delta: number, rc: Recipe): boolean => delta < 0 && rc.proof !== 'proven';
/** The fleet's bias needs more: it is the same bias carried to other markets. */
const FLEET_PRIOR_USD = 1_000_000;

const ZONES: Record<QuietWindow['zone'], string> = { utc: 'UTC', new_york: 'America/New_York', london: 'Europe/London' };

/** A zone's offset from UTC now, hours (New York -5 or -4). */
function offsetH(zone: QuietWindow['zone'], at = new Date()): number {
  if (zone === 'utc') return 0;
  const p = new Intl.DateTimeFormat('en-US', { timeZone: ZONES[zone], hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0) + Number(p.find((x) => x.type === 'minute')?.value ?? 0) / 60;
  const u = at.getUTCHours() + at.getUTCMinutes() / 60;
  let d = h - u;
  if (d > 12) d -= 24;
  if (d < -12) d += 24;
  return d;
}

const mins = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};

/** How much of each UTC minute of the day the windows cover (0..1 each; weekdays count 5/7, trading days a little less). */
export function quietCoverMinutes(ws: readonly QuietWindow[], at = new Date()): number[] {
  const cover = new Array<number>(1440).fill(0);
  for (const w of ws) {
    const a = mins(w.from), b = mins(w.to);
    if (a === null || b === null) continue;
    const off = Math.round(offsetH(w.zone, at) * 60);
    const len = b > a ? b - a : b + 1440 - a;
    // Trading days: Monday to Friday less about ten exchange holidays a year.
    const days = w.days === 'weekdays' ? 5 / 7 : w.days === 'trading' ? (5 / 7) * (251 / 261) : 1;
    for (let m = 0; m < len; m++) {
      const u = (((a + m - off) % 1440) + 1440) % 1440;
      cover[u] = Math.min(1, cover[u]! + days);
    }
  }
  return cover;
}

/** How much of each UTC hour of the week the windows cover, averaged to the hour of day (0..1 each). */
export function quietCover(ws: readonly QuietWindow[], at = new Date()): number[] {
  const m = quietCoverMinutes(ws, at);
  return Array.from({ length: 24 }, (_, h) => m.slice(h * 60, h * 60 + 60).reduce((a, b) => a + b, 0) / 60);
}

/**
 * The same, per hour of a clock `offMin` minutes off UTC (the viewer's own; a half-hour zone such as UTC+5:30
 * included): hour j of that clock is UTC minutes j*60 - offMin to j*60 - offMin + 60.
 */
export function quietCoverLocal(ws: readonly QuietWindow[], offMin: number, at = new Date()): number[] {
  const m = quietCoverMinutes(ws, at);
  return Array.from({ length: 24 }, (_, j) => {
    let t = 0;
    for (let k = 0; k < 60; k++) t += m[(((j * 60 + k - offMin) % 1440) + 1440) % 1440]!;
    return t / 60;
  });
}

/** The bucket a setting falls in: the flow gate's threshold per 10 minutes (its window scales it). */
function flowBucket(m: BotMarket, d: BotDraft) {
  const per10 = d.flowMinUsd * (10 / Math.max(1, d.flowWindowMin));
  const xs = m.flowGate ?? [];
  let pick = xs[0] ?? null;
  for (const x of xs) if (x.minUsd <= per10 * 1.0001) pick = x;
  return pick;
}

/** A gate's effect, cost and volume, from its bucket: pause drops the rest, shrink keeps it smaller. */
function gated(base: number, on: { costBps: number | null; share: number } | null, shrink: number | null): { bp: number | null; x: number } {
  if (!on || on.costBps === null) return { bp: null, x: on ? on.share + (1 - on.share) * (shrink ?? 0) : 1 };
  if (shrink === null || on.share >= 1) return { bp: on.costBps - base, x: on.share };
  // Shrink: the quiet stretches still trade, smaller. Their cost is what the whole reading leaves for them.
  const off = on.share < 1 ? (base - on.costBps * on.share) / (1 - on.share) : base;
  const vol = on.share + (1 - on.share) * shrink;
  return { bp: (on.costBps * on.share + off * (1 - on.share) * shrink) / vol - base, x: vol };
}

export interface OwnRun { recipe: RecipeId; symbol: string; volume: number; costBp: number; estBp: number | null }

/** The wallet's own real runs: live bots with volume, their cost and what the market read for them. */
export function ownRuns(bots: readonly AlgoView[], markets: readonly BotMarket[] | null): OwnRun[] {
  const out: OwnRun[] = [];
  for (const v of bots) {
    const vol = v.bot?.volume ?? 0;
    if (v.algo.spec.paper || !(vol >= 100) || !v.algo.spec.bot) continue;
    const m = markets?.find((x) => x.symbol === v.algo.spec.symbol) ?? null;
    const r = recipeOfSpec(v.algo.spec);
    out.push({ recipe: r, symbol: v.algo.spec.symbol, volume: vol, costBp: (-(v.bot?.netPnl ?? 0) / vol) * 10_000, estBp: m ? m.estCostBps + RECIPE[r].deltaBps : null });
  }
  return out;
}

/**
 * The estimate for a draft on a market, with its lines. `feeAdjBps`: the wallet's own bot fee less the one the
 * market's reading was made with (BotMarketsResponse.fee.builderBps), so the estimate charges what this wallet pays
 * (the executor's fee ladder, /me bots.feeTenths), never a flat 0.1 bp.
 */
export function estimate(d: BotDraft, m: BotMarket | null, runs: readonly OwnRun[] = [], feeAdjBps = 0): BotEstimate {
  const lines: EstLine[] = [];
  if (!m) return { bp: null, low: null, high: null, volumeX: 1, lines, learned: null, confidence: null };
  const rid = recipeOfDraft(d);
  const r = RECIPE[rid];
  if (d.strategy === 'grid') return { bp: null, low: null, high: null, volumeX: 1, lines, learned: null, confidence: m.confidence };
  const noOracle = m.lead === null;
  const adj = Number.isFinite(feeAdjBps) ? feeAdjBps : 0;
  let bp = m.estCostBps + adj;
  let x = 1;
  lines.push({ id: 'market', label: 'Market reading', bp: m.estCostBps + adj, source: 'market' });

  // The bot: its measured difference, except the gate part (measured on this market below when it can be).
  const own = noOracle ? RECIPE.touch : r;
  const botDelta = d.gate && !noOracle ? (rid === 'n5g' ? RECIPE.n5g.deltaBps - RECIPE.r10g.deltaBps : 0) : own.deltaBps;
  const botX = d.gate && !noOracle ? (rid === 'n5g' ? RECIPE.n5g.volumeX / RECIPE.r10g.volumeX : 1) : own.volumeX;
  // A saving from tests counts only once the bot is proven live; an extra cost always counts.
  const botCounted = !unproven(botDelta, d.gate && !noOracle ? RECIPE.n5g : own);
  if (own.id !== 'r10' && Math.abs(botDelta) >= 0.005) lines.push({ id: 'bot', label: own.name, bp: botDelta, source: noOracle && r.oracle ? 'none' : 'tests', note: noOracle && r.oracle ? 'No oracle here: the book maker runs' : botCounted ? undefined : NOT_COUNTED, counted: botCounted });
  if (botCounted) bp += botDelta;
  x *= botX;

  if (d.gate && !noOracle) {
    if (m.gateCostBps !== null) {
      const g = m.gateCostBps - m.estCostBps;
      lines.push({ id: 'gate', label: 'Volatility gate', bp: g, source: 'market', note: `Quotes ${Math.round((m.gateShare ?? 1) * 100)}% of the time` });
      bp += g;
      x *= m.gateShare ?? 1;
    } else {
      const ok = !unproven(RECIPE.r10g.deltaBps, RECIPE.r10g);
      lines.push({ id: 'gate', label: 'Volatility gate', bp: RECIPE.r10g.deltaBps, source: 'tests', note: ok ? 'Too few calm fills here: the backtest\'s figure' : `Too few calm fills here. ${NOT_COUNTED}`, counted: ok });
      if (ok) bp += RECIPE.r10g.deltaBps;
      x *= RECIPE.r10g.volumeX;
    }
  }
  if (d.flowOn) {
    const b = flowBucket(m, d);
    const g = gated(m.estCostBps, b, d.flowAction === 'shrink' ? d.flowShrink : null);
    const share = b?.share ?? 1;
    lines.push({ id: 'flow', label: 'Flow gate', bp: g.bp, source: g.bp === null ? 'none' : 'market', note: share <= 0 ? 'Uninformed flow never reached it: it would not quote' : g.bp === null ? `Quotes ${Math.round(g.x * 100)}% of the time, cost not measured` : `Quotes ${Math.round(share * 100)}% of the time` });
    if (g.bp !== null) bp += g.bp;
    x *= g.x;
  }
  if (d.maxSpreadBps !== null) {
    const xs = m.spreadGate ?? [];
    const b = [...xs].reverse().find((s) => s.maxBps <= d.maxSpreadBps!) ?? xs[0] ?? null;
    const g = gated(m.estCostBps, b, null);
    lines.push({ id: 'spread', label: 'Spread limit', bp: g.bp, source: g.bp === null ? 'none' : 'market', note: b ? `Quotes ${Math.round(b.share * 100)}% of the time` : undefined });
    if (g.bp !== null) bp += g.bp;
    x *= g.x;
  }
  if (d.quiet.length) {
    // Trading only in the windows: everything else is covered.
    const cover = d.quietOnly ? quietCover(d.quiet).map((c) => 1 - c) : quietCover(d.quiet);
    let wAll = 0, cAll = 0, wKeep = 0, cKeep = 0;
    for (const h of m.hourly) {
      const w = h.volumeUsdH;
      const c = h.costBps ?? m.estCostBps;
      wAll += w; cAll += w * c;
      wKeep += w * (1 - cover[h.h]!); cKeep += w * (1 - cover[h.h]!) * c;
    }
    const measured = m.hourly.some((h) => h.costBps !== null && cover[h.h]! > 0);
    const g = wKeep > 0 && wAll > 0 ? cKeep / wKeep - cAll / wAll : 0;
    lines.push({ id: 'quiet', label: d.quietOnly ? 'Trading hours' : 'Pause hours', bp: measured ? g : null, source: measured ? 'market' : 'none', note: `Off ${Math.round((1 - (wAll > 0 ? wKeep / wAll : 1)) * 100)}% of the volume` });
    if (measured) bp += g;
    x *= wAll > 0 ? wKeep / wAll : 1;
  }

  // The news gate: a few minutes around each US release; its cost here is not measured yet.
  if (d.news) lines.push({ id: 'news', label: 'News gate', bp: null, source: 'none', note: `Off ${d.news.beforeMin} min before to ${d.news.afterMin} min after each ${d.news.level === 'high' ? 'major' : 'major or medium'} US release` });

  // The wallet's own runs: this market and bot first (weight by volume), else the fleet's bias.
  let learned: BotEstimate['learned'] = null;
  const here = runs.filter((u) => u.symbol === m.symbol && u.recipe === (noOracle ? 'touch' : rid));
  const hv = here.reduce((s, u) => s + u.volume, 0);
  if (hv > 0) {
    const real = here.reduce((s, u) => s + u.costBp * u.volume, 0) / hv;
    const w = hv / (hv + PRIOR_USD);
    const adj = (real - bp) * w;
    lines.push({ id: 'yours', label: 'Your bots here', bp: adj, source: 'yours' });
    bp += adj;
    learned = { volumeUsd: hv, weight: w, scope: 'market' };
  } else {
    const all = runs.filter((u) => u.estBp !== null);
    const av = all.reduce((s, u) => s + u.volume, 0);
    if (av > 0) {
      const bias = all.reduce((s, u) => s + (u.costBp - u.estBp!) * u.volume, 0) / av;
      const w = av / (av + FLEET_PRIOR_USD);
      lines.push({ id: 'yours', label: 'Your bots elsewhere', bp: bias * w, source: 'yours' });
      bp += bias * w;
      learned = { volumeUsd: av, weight: w, scope: 'fleet' };
    }
  }
  const shift = bp - m.estCostBps;
  const conf = learned && learned.weight >= 0.5 ? 'high' : m.confidence;
  return { bp, low: m.estCostLowBps + shift, high: m.estCostHighBps + shift, volumeX: x, lines, learned, confidence: conf };
}

/** The bots a market suits, cheapest first (Explore): every market maker on its reading. */
export function rankRecipes(m: BotMarket, base: BotDraft, runs: readonly OwnRun[] = [], feeAdjBps = 0): Array<{ id: RecipeId; est: BotEstimate }> {
  const ids: RecipeId[] = m.lead === null ? ['touch'] : ['r10', 'r10g', 's1', 'n5', 'n5g', 'touch'];
  return ids
    .map((id) => ({ id, est: estimate({ ...base, ...RECIPE[id].params, strategy: RECIPE[id].strategy, symbol: m.symbol }, m, runs, feeAdjBps) }))
    .sort((a, b) => (a.est.bp ?? 99) - (b.est.bp ?? 99));
}

/**
 * The best of a ranked list: the cheapest. The estimate already leaves out savings not measured on this market or
 * proven live (EstLine.counted), so the cheapest number is the best bot. Ties (to the dollar per $1M) go to the simpler.
 */
export function bestOf<T extends { id: RecipeId; est: BotEstimate }>(ranked: readonly T[]): T | null {
  const ids = Object.keys(RECIPE) as RecipeId[];
  const r = (x: T): number => (x.est.bp === null ? 99 : Math.round(x.est.bp * 100) / 100);
  return [...ranked].sort((a, b) => r(a) - r(b) || ids.indexOf(a.id) - ids.indexOf(b.id))[0] ?? null;
}

/** The fee difference `estimate` takes: the wallet's bot fee (tenths of a bp) less the reading's (bp). */
export const feeAdjOf = (feeTenths: number, readingBuilderBps: number | null | undefined): number =>
  Number.isFinite(feeTenths) ? feeTenths / 10 - (readingBuilderBps ?? 0.1) : 0;
