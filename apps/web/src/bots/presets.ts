/**
 * The Bots page's strategies, in plain words, their presets, and what each costs per $1M of volume.
 *
 * Two strategies, picked for the most volume at the least net cost (owner, 2026-11-02; a DCA is an algo order,
 * not a bot - the owner took it off this page the same day):
 *   maker  Volume maker (algo kind 'mm'): a post-only bid and ask at the touch, an inventory cap, a skew that
 *          unwinds what it holds first. Every fill is a maker fill: SoDEX's 1.2 bp + ValueDesk's 0.5 bp,
 *          $170 per $1M, and it earns what the spread gives. Delta-neutral by construction.
 *   grid   Grid (kind 'grid'): post-only levels in a range; every round trip earns one step.
 * A bot that takes (pays 4.0 bp + the spread) would cost $450+ per $1M: none is offered.
 *
 * Pure: the page and its tests read the same numbers.
 */
import type { AlgoSpec, MarketInfo } from '@copy-engine';
import { gridPrices, gridStepPct } from '@copy-engine';

export type Strategy = 'maker' | 'grid';
export const STRATEGIES: readonly Strategy[] = ['maker', 'grid'];

export type PresetId = 'steady' | 'balanced' | 'active';
export const PRESETS: readonly PresetId[] = ['steady', 'balanced', 'active'];
export const PRESET_NAMES: Record<PresetId, string> = { steady: 'Steady', balanced: 'Balanced', active: 'Active' };

/** SoDEX's maker fee at tier 0 when the market does not say (fees.ts FEE_TIERS), and ours for bots (policy.ts BOT_FEE). */
export const DEFAULT_MAKER_FEE = 0.00012;
export const DEFAULT_BOT_FEE_TENTHS = 5;

export const STRATEGY_INFO: Record<Strategy, { name: string; kind: AlgoSpec['kind']; line: string; how: string[]; risk: string; best: string }> = {
  maker: {
    name: 'Volume maker',
    kind: 'mm',
    line: 'Quotes both sides at the best price and earns the spread. Built for volume at the lowest cost.',
    how: [
      'Keeps one buy and one sell order resting at the best price, moved as the price moves.',
      'Every fill rests on the book: the maker fee, never the spread.',
      'Holds at most your inventory cap either way; what it holds is unwound first.',
    ],
    risk: 'If the price runs one way it ends up holding up to the cap and the move counts against it. The loss limit stops it.',
    best: 'BTC: the cheapest in our live runs (about $210 per $1M).',
  },
  grid: {
    name: 'Grid',
    kind: 'grid',
    line: 'Buys low and sells high on levels in a range. Earns every swing inside it.',
    how: [
      'Rests buy orders below the price and sell orders above it, one per level.',
      'Each buy that fills puts a sell one level higher; each sell a buy one level lower.',
      'Every round trip earns one step, less two maker fees.',
    ],
    risk: 'If the price leaves the range it holds the position it built on the way. Set it to stop, or keep it waiting.',
    best: 'A market moving sideways in a known range.',
  },
};

/** What the form holds: every strategy's fields, the market and the switches. */
export interface BotDraft {
  strategy: Strategy;
  symbol: string;
  label: string;
  paper: boolean;
  /* maker */
  orderUsd: number;
  maxInventoryUsd: number;
  skewTicks: number;
  chaseTicks: number;
  minRepriceMs: number;
  /** Each quote at least this far from the mid, bp (0: at the touch). */
  edgeBps: number;
  /** The queue guard, a fraction (0: off): the adding side waits while its own queue is thinner than this share. */
  queueGuard: number;
  /* grid */
  rangePct: number;
  low: number | null;
  high: number | null;
  levels: number;
  /* limits */
  volumeTargetUsd: number | null;
  maxLossUsd: number | null;
  onStop: 'close' | 'keep';
  outOfRange: 'wait' | 'stop';
}

/** The presets, per strategy. Prices of a grid come from the mark when it is set up (rangePct either way). */
export const PRESET_VALUES: Record<Strategy, Record<PresetId, Partial<BotDraft>>> = {
  maker: {
    steady: { orderUsd: 20, maxInventoryUsd: 60, skewTicks: 4, chaseTicks: 2, minRepriceMs: 5_000, maxLossUsd: 3 },
    balanced: { orderUsd: 50, maxInventoryUsd: 200, skewTicks: 4, chaseTicks: 2, minRepriceMs: 3_000, maxLossUsd: 10 },
    active: { orderUsd: 150, maxInventoryUsd: 600, skewTicks: 6, chaseTicks: 1, minRepriceMs: 2_000, maxLossUsd: 30 },
  },
  grid: {
    steady: { rangePct: 0.03, levels: 10, orderUsd: 15, maxLossUsd: 5 },
    balanced: { rangePct: 0.02, levels: 16, orderUsd: 25, maxLossUsd: 15 },
    active: { rangePct: 0.01, levels: 24, orderUsd: 40, maxLossUsd: 40 },
  },
};

export function draftFor(strategy: Strategy, preset: PresetId = 'balanced', symbol = 'BTC-USD'): BotDraft {
  return {
    strategy,
    symbol,
    label: '',
    paper: true,
    orderUsd: 50,
    maxInventoryUsd: 200,
    skewTicks: 4,
    chaseTicks: 2,
    minRepriceMs: 3_000,
    edgeBps: 0,
    queueGuard: 0,
    rangePct: 0.02,
    low: null,
    high: null,
    levels: 16,
    volumeTargetUsd: null,
    maxLossUsd: null,
    onStop: 'close',
    outOfRange: 'wait',
    ...PRESET_VALUES[strategy][preset],
  };
}

/** Which preset a draft still matches (null: changed by hand). */
export function presetOf(d: BotDraft): PresetId | null {
  for (const p of PRESETS) {
    const v = PRESET_VALUES[d.strategy][p];
    if (Object.entries(v).every(([k, x]) => (d as unknown as Record<string, unknown>)[k] === x)) return p;
  }
  return null;
}

/** A grid's range around `mark`, on the tick: rangePct either way, unless the draft names its own prices. */
export function gridRange(d: BotDraft, mark: number | null): { low: number; high: number } | null {
  if (d.low !== null && d.high !== null) return { low: d.low, high: d.high };
  if (!mark || !(mark > 0)) return null;
  return { low: roundSig(mark * (1 - d.rangePct)), high: roundSig(mark * (1 + d.rangePct)) };
}

const roundSig = (x: number): number => Number(x.toPrecision(6));

/** The spec the wallet signs (parseAlgoSpec form; the executor checks it again). */
export function specOf(d: BotDraft, mark: number | null): Record<string, unknown> {
  const base = { symbol: d.symbol, paper: d.paper, label: d.label.trim() || null };
  const limits = { volumeTargetUsd: d.volumeTargetUsd, maxLossUsd: d.maxLossUsd, onStop: d.onStop };
  if (d.strategy === 'maker') {
    return { ...base, ...limits, kind: 'mm', orderUsd: d.orderUsd, maxInventoryUsd: d.maxInventoryUsd, skewTicks: d.skewTicks, chaseTicks: d.chaseTicks, minRepriceMs: d.minRepriceMs, ...(d.edgeBps > 0 ? { edgeBps: d.edgeBps } : {}), ...(d.queueGuard > 0 ? { queueGuard: d.queueGuard } : {}) };
  }
  const r = gridRange(d, mark);
  return { ...base, ...limits, kind: 'grid', low: r?.low ?? null, high: r?.high ?? null, levels: d.levels, orderUsd: d.orderUsd, spacing: 'geometric', outOfRange: d.outOfRange };
}

/** The draft a running bot's spec reads back as (the Edit form). */
export function draftOfSpec(s: AlgoSpec): BotDraft {
  if (s.kind === 'mm') {
    return { ...draftFor('maker', 'balanced', s.symbol), label: s.label ?? '', paper: s.paper, orderUsd: s.orderUsd, maxInventoryUsd: s.maxInventoryUsd, skewTicks: s.skewTicks, chaseTicks: s.chaseTicks, minRepriceMs: s.minRepriceMs, edgeBps: s.edgeBps ?? 0, queueGuard: s.queueGuard ?? 0, volumeTargetUsd: s.volumeTargetUsd, maxLossUsd: s.maxLossUsd, onStop: s.onStop };
  }
  if (s.kind === 'grid') {
    return { ...draftFor('grid', 'balanced', s.symbol), label: s.label ?? '', paper: s.paper, low: s.low, high: s.high, levels: s.levels, orderUsd: s.orderUsd, volumeTargetUsd: s.volumeTargetUsd, maxLossUsd: s.maxLossUsd, onStop: s.onStop, outOfRange: s.outOfRange };
  }
  return draftFor('maker', 'balanced', s.symbol);
}

/** What an Edit may send (runtime BOT_UPDATABLE): only the fields that changed. */
export function patchOf(before: BotDraft, after: BotDraft): Record<string, unknown> {
  const keys: Array<keyof BotDraft> =
    after.strategy === 'maker' ? ['orderUsd', 'maxInventoryUsd', 'skewTicks', 'chaseTicks', 'minRepriceMs', 'edgeBps', 'queueGuard', 'volumeTargetUsd', 'maxLossUsd', 'onStop']
    : ['orderUsd', 'volumeTargetUsd', 'maxLossUsd', 'onStop', 'outOfRange'];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (before[k] !== after[k]) out[k] = after[k];
  if (before.label.trim() !== after.label.trim()) out.label = after.label.trim() || null;
  return out;
}

/** The strategy a running algo is (null: not one of the page's bots - a bot DCA from before 2026-11-02 included). */
export function strategyOf(s: AlgoSpec): Strategy | null {
  if (!s.bot) return null;
  return s.kind === 'mm' ? 'maker' : s.kind === 'grid' ? 'grid' : null;
}

/* ------------------------------------------------------------------- cost ----- */

export interface CostPerMillion {
  /** SoDEX's maker fee and the ValueDesk bot fee, per $1M traded (USD). */
  trade: number;
  builder: number;
  fees: number;
  /**
   * What the spread gives back per $1M, before price moves (USD): a grid's steps; a volume maker's one tick a
   * round trip at the touch (a market whose tick is a larger share of its price gives more). null: unknown yet.
   */
  edge: number | null;
  /** fees - edge, or the fees alone. Negative: it earns. */
  net: number;
}

/**
 * What $1M of a bot's volume costs, before price moves: every fill a maker fill. A grid's round trip is two
 * fills (twice the order in volume) and earns one step on one order, so per $1M of volume it earns step / 2; a
 * volume maker's round trip at the touch earns the spread, one tick where the spread is one tick: tick / 2 per $1.
 */
export function costPerMillion(d: BotDraft, m: Pick<MarketInfo, 'makerFee' | 'tickSize'> | null, mark: number | null, botFeeTenths = DEFAULT_BOT_FEE_TENTHS): CostPerMillion {
  const makerFee = m?.makerFee ?? DEFAULT_MAKER_FEE;
  const trade = makerFee * 1_000_000;
  const builder = (botFeeTenths / 100_000) * 1_000_000;
  const fees = trade + builder;
  let edge: number | null = null;
  if (d.strategy === 'grid') {
    const r = gridRange(d, mark);
    if (r && m) {
      const prices = gridPrices({ low: r.low, high: r.high, levels: d.levels, spacing: 'geometric' }, m.tickSize);
      edge = (gridStepPct(prices) / 2) * 1_000_000;
    }
  } else if (m && mark && mark > 0 && d.edgeBps === 0) {
    edge = (Number(m.tickSize) / mark / 2) * 1_000_000;
  }
  return { trade, builder, fees, edge, net: fees - (edge ?? 0) };
}
