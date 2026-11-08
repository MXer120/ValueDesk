/**
 * All of a wallet's bots together, for the Bots page's summary and chart: the totals, and one series of volume
 * and net PnL summed over every bot (each bot's book samples every 5 minutes on its own clock, so the sum is
 * taken on a shared grid, each bot counted at its last point at or before each step).
 *
 * Money figures (volume, PnL, fees, holding, the chart) count REAL bots only: a practice bot sends no order, and
 * adding its paper fills to real money misleads (launch audit B). Practice bots are counted on their own.
 *
 * Pure: the page and its test read the same numbers.
 */
import { BOT_SAMPLE_MS, FINAL_STATUSES, type AlgoView } from '@copy-engine';

/**
 * A read without the series, with each bot's series from the last read that had one. null when a bot has none
 * here yet (just started elsewhere): then the next read asks for them all.
 */
export function keepSeries(views: readonly AlgoView[], before: readonly AlgoView[]): AlgoView[] | null {
  const kept = new Map(before.map((v) => [v.algo.id, v.algo.book?.series]));
  const out: AlgoView[] = [];
  for (const v of views) {
    const book = v.algo.book;
    if (!book) {
      out.push(v);
      continue;
    }
    const series = kept.get(v.algo.id);
    if (!series) return null;
    out.push({ ...v, algo: { ...v.algo, book: { ...book, series } } });
  }
  return out;
}

/**
 * A read that left before the page's last action on a bot can carry the bot as it was before that action (a stop
 * shown as running again; a second "Clean stop" then ends it with the position open, audit A5). For each bot acted
 * on at or after `askedAt`, the row on screen is kept instead of the read's.
 */
export function keepActed(read: readonly AlgoView[], shown: readonly AlgoView[], askedAt: number, actedAt: ReadonlyMap<string, number>): AlgoView[] {
  if (!actedAt.size) return [...read];
  const had = new Map(shown.map((v) => [v.algo.id, v]));
  return read.map((v) => {
    const at = actedAt.get(v.algo.id);
    const mine = had.get(v.algo.id);
    return at !== undefined && at >= askedAt && mine ? mine : v;
  });
}

export const isPractice = (v: AlgoView): boolean => v.algo.spec.paper === true;
/** The bots whose money is real (the fleet's figures and chart). */
export const realBots = (views: readonly AlgoView[]): AlgoView[] => views.filter((v) => !isPractice(v));

export interface FleetTotals {
  /** Real bots: every one, running (quoting, waiting or closing), paused, and ended. */
  bots: number;
  running: number;
  paused: number;
  stopped: number;
  /** Practice bots, counted apart: none of their figures are in the money totals. */
  practice: { bots: number; running: number };
  volume: number;
  netPnl: number;
  tradeFees: number;
  builderFees: number;
  /** What the running real bots hold now, gross: longs and shorts added as absolute values, never netted. */
  holdingUsd: number;
  longUsd: number;
  shortUsd: number;
  fills: number;
  makerValue: number;
  /** -net per $1M traded; null under $1. */
  costPerMillion: number | null;
}

/** A dollar amount that rounds to nothing shown as 0 (not -0.00). */
export const cleanUsd = (x: number): number => (Math.abs(x) < 0.005 ? 0 : x);

/**
 * Stopped runs of one bot as one row (owner 2026-11-08: a test that starts a fresh bot every round showed as 20
 * bots): stopped bots with the same name, market and practice-or-real fold into the newest of them, with their
 * volume, PnL, fees and fills added up, their series joined end to end (each run's figures on top of the runs
 * before it), and the run count in `runs`. Running and paused bots always stand alone.
 */
export function foldRuns(views: readonly AlgoView[], name: (v: AlgoView) => string): { list: AlgoView[]; runs: Map<string, number> } {
  const runs = new Map<string, number>();
  const groups = new Map<string, AlgoView[]>();
  const list: AlgoView[] = [];
  for (const v of views) {
    if (!FINAL_STATUSES.has(v.algo.status)) { list.push(v); continue; }
    const k = `${name(v)}|${v.algo.spec.symbol}|${isPractice(v) ? 'practice' : 'real'}`;
    const g = groups.get(k);
    if (g) g.push(v); else groups.set(k, [v]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (b.algo.endedAt ?? b.algo.createdAt) - (a.algo.endedAt ?? a.algo.createdAt));
    const top = g[0]!;
    if (g.length === 1) { list.push(top); continue; }
    const sum = (f: (b: NonNullable<AlgoView['bot']>) => number) => g.reduce((t, x) => t + (x.bot ? f(x.bot) : 0), 0);
    const volume = sum((b) => b.volume);
    const netPnl = sum((b) => b.netPnl);
    // The runs' series joined oldest first, each lifted by what the runs before it ended at.
    const series: Array<[number, number, number, number]> = [];
    let ov = 0;
    let on = 0;
    let of = 0;
    for (const x of [...g].sort((a, b) => (a.algo.startedAt ?? a.algo.createdAt) - (b.algo.startedAt ?? b.algo.createdAt))) {
      const pts = x.algo.book?.series ?? [];
      for (const p of pts) series.push([p[0], p[1] + ov, p[2] + on, (p[3] ?? 0) + of]);
      ov += x.bot?.volume ?? pts.at(-1)?.[1] ?? 0;
      on += x.bot?.netPnl ?? pts.at(-1)?.[2] ?? 0;
      of += x.bot ? x.bot.tradeFees + x.bot.builderFees : pts.at(-1)?.[3] ?? 0;
    }
    series.sort((a, b) => a[0] - b[0]);
    const merged: AlgoView = {
      ...top,
      algo: {
        ...top.algo,
        createdAt: Math.min(...g.map((x) => x.algo.createdAt)),
        startedAt: Math.min(...g.map((x) => x.algo.startedAt ?? x.algo.createdAt)),
        ...(top.algo.book ? { book: { ...top.algo.book, series } } : {}),
      },
      bot: top.bot ? {
        ...top.bot, volume, netPnl, grossPnl: sum((b) => b.grossPnl), tradeFees: sum((b) => b.tradeFees), builderFees: sum((b) => b.builderFees), fills: sum((b) => b.fills),
        makerShare: volume > 0 ? sum((b) => b.volume * b.makerShare) / volume : top.bot.makerShare,
        costPerMillion: volume >= 1 ? (-netPnl / volume) * 1_000_000 : null, inventory: 0, inventoryUsd: 0,
      } : top.bot,
    };
    runs.set(top.algo.id, g.length);
    list.push(merged);
  }
  return { list, runs };
}

export function fleetTotals(views: readonly AlgoView[]): FleetTotals {
  const t: FleetTotals = {
    bots: 0, running: 0, paused: 0, stopped: 0, practice: { bots: 0, running: 0 }, volume: 0, netPnl: 0, tradeFees: 0, builderFees: 0,
    holdingUsd: 0, longUsd: 0, shortUsd: 0, fills: 0, makerValue: 0, costPerMillion: null,
  };
  for (const v of views) {
    const ended = FINAL_STATUSES.has(v.algo.status);
    if (isPractice(v)) {
      t.practice.bots++;
      if (!ended && v.algo.status !== 'paused') t.practice.running++;
      continue;
    }
    t.bots++;
    if (ended) t.stopped++;
    else if (v.algo.status === 'paused') t.paused++;
    else t.running++;
    const b = v.bot;
    if (!b) continue;
    t.volume += b.volume;
    t.netPnl += b.netPnl;
    t.tradeFees += b.tradeFees;
    t.builderFees += b.builderFees;
    // What the fleet holds now: live bots only (a stopped one closed or handed over what it held), gross.
    if (!ended) {
      if (b.inventoryUsd > 0) t.longUsd += b.inventoryUsd;
      else t.shortUsd += -b.inventoryUsd;
    }
    t.fills += b.fills;
    t.makerValue += b.volume * b.makerShare;
  }
  t.holdingUsd = t.longUsd + t.shortUsd;
  t.costPerMillion = t.volume >= 1 ? (-t.netPnl / t.volume) * 1_000_000 : null;
  return t;
}

export type FleetSeries = { volume: Array<[number, number]>; pnl: Array<[number, number]>; fees: Array<[number, number]> };

/** At most this many steps: a window of months steps in hours, a window of an hour in 5 minutes. */
const MAX_STEPS = 1_500;

/**
 * The fleet's series: per step, the volume traded in it (bars) and the net PnL and fees so far (lines).
 *
 * `from` (a window's start): the step is chosen for the window, not the whole history, so 1H and 6H keep their
 * 5-minute points on a fleet with months behind it; the first step starts at `from` (nothing from before it is
 * counted as traded in it), and one point just before `from` carries the PnL and fees the window starts at.
 */
export function fleetSeries(views: readonly AlgoView[], now: number, step = BOT_SAMPLE_MS, from?: number): FleetSeries {
  const books = views
    .map((v) => {
      const pts = [...(v.algo.book?.series ?? [])];
      // The figures now, for a bot still running whose last point is older than a minute.
      if (v.bot && !FINAL_STATUSES.has(v.algo.status) && (!pts.length || now - pts[pts.length - 1]![0] > 60_000)) pts.push([now, v.bot.volume, v.bot.netPnl, v.bot.tradeFees + v.bot.builderFees]);
      return pts;
    })
    .filter((p) => p.length > 0);
  if (!books.length) return { volume: [], pnl: [], fees: [] };
  const first = Math.min(...books.map((p) => p[0]![0]));
  const last = Math.max(...books.map((p) => p[p.length - 1]![0]));
  const windowed = from !== undefined && Number.isFinite(from) && from > first;
  if (windowed && from! >= last) return { volume: [], pnl: [], fees: [] };
  const lo = windowed ? from! : first;
  while ((last - lo) / step > MAX_STEPS) step *= 2;
  const start = windowed ? lo : Math.floor(first / step) * step;
  const volume: Array<[number, number]> = [];
  const pnl: Array<[number, number]> = [];
  const fees: Array<[number, number]> = [];
  const at = books.map(() => -1);
  /** Each bot's last point at or before `end`, summed. */
  const sumAt = (end: number): { vol: number; net: number; fee: number } => {
    let vol = 0;
    let net = 0;
    let fee = 0;
    books.forEach((p, i) => {
      while (at[i]! + 1 < p.length && p[at[i]! + 1]![0] <= end) at[i]!++;
      const x = at[i]! >= 0 ? p[at[i]!]! : null;
      if (x) {
        vol += x[1];
        net += x[2];
        fee += x[3] ?? 0;
      }
    });
    return { vol, net, fee };
  };
  let prevVol = 0;
  if (windowed) {
    const s0 = sumAt(start);
    prevVol = s0.vol;
    volume.push([start - 1, 0]);
    pnl.push([start - 1, s0.net]);
    fees.push([start - 1, s0.fee]);
  }
  for (let t = start + step; ; t += step) {
    const end = Math.min(t, last);
    const s = sumAt(end);
    volume.push([end, Math.max(0, s.vol - prevVol)]);
    pnl.push([end, s.net]);
    fees.push([end, s.fee]);
    prevVol = s.vol;
    if (t >= last) break;
  }
  return { volume, pnl, fees };
}

/**
 * The fleet over a timeframe (owner 2026-11-08: the Fleet panel shows 24 hours by default): volume traded in it, what
 * the net PnL and the fees moved in it (net PnL at the mark, so an open position counts), and its cost per $1M.
 * `from` -Infinity: everything. The cumulative volume and PnL inside the window, for the cards' sparklines.
 */
export function fleetWindow(s: FleetSeries, from: number): { volume: number; netPnl: number; fees: number; costPerMillion: number | null; volTrend: number[]; pnlTrend: number[] } {
  const before = (xs: Array<[number, number]>) => (Number.isFinite(from) ? xs.filter((p) => p[0] < from).at(-1)?.[1] ?? 0 : 0);
  const vols = s.volume.filter((p) => p[0] >= from);
  const pnls = s.pnl.filter((p) => p[0] >= from);
  const fees = s.fees.filter((p) => p[0] >= from);
  const p0 = before(s.pnl);
  const f0 = before(s.fees);
  let acc = 0;
  const volTrend = vols.map((p) => (acc += p[1]));
  const volume = acc;
  const netPnl = pnls.length ? pnls[pnls.length - 1]![1] - p0 : 0;
  return {
    volume, netPnl, fees: fees.length ? fees[fees.length - 1]![1] - f0 : 0,
    costPerMillion: volume >= 1 ? (-netPnl / volume) * 1_000_000 : null,
    volTrend, pnlTrend: pnls.map((p) => p[1] - p0),
  };
}

/* --------------------------------------------------------------- edits ----- */

/** What the executor changes on a running bot in place (runtime BOT_UPDATABLE, executor algoPatch). */
const IN_PLACE: Record<'mm' | 'grid', ReadonlySet<string>> = {
  mm: new Set(['ref', 'noFair', 'placeBps', 'calmBps', 'calmMs', 'pauseAfter', 'pauseMs', 'leverage', 'marginMode', 'postOnly', 'label', 'maxSpreadBps', 'orderUsd', 'maxInventoryUsd', 'offsetTicks', 'chaseTicks', 'minRepriceMs', 'skewTicks', 'edgeBps', 'queueGuard', 'levels', 'moveGuard', 'refBps', 'pullBps', 'stillBps', 'stillMs', 'restMs', 'flowGate', 'quiet', 'quietOnly', 'news', 'volumeTargetUsd', 'maxLossUsd', 'endAt', 'onStop']),
  grid: new Set(['low', 'high', 'levels', 'spacing', 'leverage', 'marginMode', 'postOnly', 'label', 'maxSpreadBps', 'orderUsd', 'volumeTargetUsd', 'maxLossUsd', 'endAt', 'onStop', 'outOfRange']),
};
/** Fields a patch may clear with null (their absence in the new spec). */
const CLEARABLE = new Set(['label', 'maxSpreadBps', 'volumeTargetUsd', 'maxLossUsd', 'endAt', 'flowGate', 'quiet', 'quietOnly', 'news', 'ref', 'refBps', 'pullBps', 'placeBps', 'calmBps', 'calmMs', 'pauseAfter', 'pauseMs', 'edgeBps', 'queueGuard', 'moveGuard', 'levels', 'leverage', 'marginMode', 'restMs']);
/** Off in the spec is the field left out; in a patch it is this value. */
const OFF_VALUE: Record<string, unknown> = { stillBps: 0, stillMs: 0, quietOnly: false, postOnly: true, noFair: false };

/**
 * A settings change as an in-place update, when the executor can make it on the running bot (a name, a loss limit,
 * a run time, a volume target, sizes and distances): the patch, with only the fields that changed. null when any
 * change needs a restart (the market, the kind, the strategy's reference, leverage, practice or real, a grid's range
 * and levels), or nothing changed. `endAt` is compared by `endChanged` (a run time is a time from now).
 */
export function inPlacePatch(before: Record<string, unknown>, after: Record<string, unknown>, endChanged: boolean): Record<string, unknown> | null {
  const kind = after.kind;
  if (kind !== before.kind || (kind !== 'mm' && kind !== 'grid')) return null;
  const allowed = IN_PLACE[kind];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('endAt');
  const patch: Record<string, unknown> = {};
  for (const k of keys) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    if (!allowed.has(k)) return null;
    const v = after[k];
    if (v === undefined) {
      if (CLEARABLE.has(k)) patch[k] = null;
      else if (k in OFF_VALUE) patch[k] = OFF_VALUE[k];
      else return null;
    } else patch[k] = v;
  }
  if (endChanged) patch.endAt = typeof after.endAt === 'number' ? after.endAt : null;
  return Object.keys(patch).length ? patch : null;
}

/* ----------------------------------------------------------------- log ----- */

/** The most log lines a page keeps (older ones are read again on scroll). */
export const LOG_CAP = 2_000;

/**
 * Log pages put together: one line per id (a line read twice, at a page's edge, shows once), newest first, at most
 * `cap` lines (the oldest go). `added`: how many lines were not there before; `cut`: lines dropped at the cap.
 */
export function mergeLog<E extends { id: string; at: number }>(have: readonly E[], pages: ReadonlyArray<readonly E[]>, cap = LOG_CAP): { list: E[]; added: number; cut: boolean } {
  const byId = new Map(have.map((e) => [e.id, e]));
  let added = 0;
  for (const page of pages) for (const e of page) { if (!byId.has(e.id)) added++; byId.set(e.id, e); }
  const all = [...byId.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { list: all.length > cap ? all.slice(0, cap) : all, added, cut: all.length > cap };
}
