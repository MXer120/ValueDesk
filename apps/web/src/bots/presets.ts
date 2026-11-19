/**
 * The Bots page's strategies, in plain words, their presets, and what each costs per $1M of volume.
 *
 * Two strategies, picked for the most volume at the least net cost (owner, 2026-11-02; a DCA is an algo order,
 * not a bot - the owner took it off this page the same day):
 *   maker  Volume maker (algo kind 'mm'): a post-only bid and ask at the touch, an inventory cap, a skew that
 *          unwinds what it holds first. Every fill is a maker fill: SoDEX's 1.2 bp + ValueDesk's 0.1 bp,
 *          $130 per $1M, and it earns what the spread gives. Delta-neutral by construction.
 *   lead   Binance-led maker (kind 'mm' with ref 'binance', 2026-11-03): the volume maker priced off Binance USD-M's
 *          mid (times the SoDEX/Binance basis). Binance moves first: a quote the Binance price came too close to is
 *          pulled the moment the tick reaches the executor, not at its next step. Hosted only.
 *   grid   Grid (kind 'grid'): post-only levels in a range; every round trip earns one step.
 * A bot that takes (pays 4.0 bp + the spread) would cost $450+ per $1M: none is offered.
 *
 * Pure: the page and its tests read the same numbers.
 */
import type { AlgoSpec, MarketInfo } from '@copy-engine';
import { engineOfSymbol, type BotEngine, marketLabel } from './engines';
import { botMarginUsd, checkSizes, gridPrices, gridStepPct, minChildQty, parseAlgoSpec } from '@copy-engine';

export type Strategy = 'market' | 'maker' | 'lead' | 'grid' | 'hedge';
/**
 * What a new bot can be (owner, 2026-11-07): the market maker (R10, the live-tested setting) and the grid. The
 * volume maker and the Binance-led maker before it still run and show, they are no longer offered.
 */
export const STRATEGIES: readonly Strategy[] = ['market', 'grid'];
/** The volume makers (kind 'mm'): the same sizes, cap and guards; `lead` adds its Binance distances. */
export const isMaker = (s: Strategy): boolean => s !== 'grid' && s !== 'hedge';

export type PresetId = 'steady' | 'balanced' | 'active';
export const PRESETS: readonly PresetId[] = ['steady', 'balanced', 'active'];
export const PRESET_NAMES: Record<PresetId, string> = { steady: 'Steady', balanced: 'Balanced', active: 'Active' };

/** SoDEX's maker fee at tier 0 when the market does not say (fees.ts FEE_TIERS), and ours for bots (policy.ts BOT_FEE). */
export const DEFAULT_MAKER_FEE = 0.00012;
export const DEFAULT_BOT_FEE_TENTHS = 1;
/** The bot fee in words: 1 tenth -> '0.1 bp'. */
export const botFeeWords = (tenths: number = DEFAULT_BOT_FEE_TENTHS): string => `${(tenths / 10).toFixed(1)} bp`;

export const STRATEGY_INFO: Record<Strategy, { name: string; kind: AlgoSpec['kind']; line: string; how: string[]; risk: string; best: string }> = {
  market: {
    name: 'Market maker',
    kind: 'mm',
    line: 'Rests a buy and a sell at the best price, priced off the oracle, and earns the spread. The lowest cost per $1M we measured.',
    how: [
      'Keeps one buy and one sell resting at the best price, for up to 10 seconds each, then places it again.',
      'Reads the oracle (a leading futures price, which moves first): a quote the oracle moved through is pulled at once.',
      'Every fill rests on the book: the maker fee, never the spread. What it holds is unwound first.',
    ],
    risk: 'If the price runs one way it holds up to the cap and the move counts against it. The loss limit stops it. It holds while the oracle price is not fresh.',
    best: 'Liquid coins with an oracle. Explore shows what it costs on each.',
  },
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
  lead: {
    name: 'Oracle-led maker',
    kind: 'mm',
    line: 'The volume maker, priced off the oracle. Pulls a quote the moment the oracle moves through it.',
    how: [
      'Reads the oracle, which moves first, and SoDEX\'s gap to it: that is the fair price.',
      'Rests at the best price only while it is safely on its side of the fair price, or a set distance from it.',
      'An oracle move that reaches a quote cancels it at once, before the next step.',
    ],
    risk: 'Like the volume maker: up to the cap either way, the move counts against it, the loss limit stops it. It holds while the oracle price is not fresh.',
    best: 'Liquid coins with an oracle: BTC, ETH, SOL.',
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
  hedge: {
    name: 'Hedge',
    kind: 'hedge',
    line: 'Holds open interest market-neutral: a long and a short of the same size, in two wallets or against spot.',
    how: [
      'Two wallets: a long in one, the same short in the other. Spot: a short as large as the coin you hold as futures margin.',
      'Keeps both legs equal. When a price move brings a leg near its liquidation, both legs get smaller; they grow back when there is room.',
      'Only takes (IOC): its two legs never trade with each other.',
    ],
    risk: 'Every open and close pays the taker fee on both legs. A move faster than it can trim may still liquidate a leg; the other is then closed. SoDEX cannot move margin between two wallets.',
    best: 'Liquid markets, where a taker costs little: BTC, ETH, SOL.',
  },
};

/** 'trading': the exchange's trading days in that zone (NYSE for New York, LSE for London), holidays skipped (engine bots.ts). */
/** A trading-hours window; zone: utc, new_york, london or any IANA zone (the viewer's own clock, DST followed). */
export interface QuietWindow { from: string; to: string; zone: 'utc' | 'new_york' | 'london' | (string & {}); days: 'all' | 'weekdays' | 'trading' }
/** The usual session windows (zone time), on the exchange's trading days: its holidays are skipped. */
export const QUIET_PRESETS: Array<{ id: string; label: string; w: QuietWindow }> = [
  { id: 'ny-open', label: 'New York open', w: { from: '09:25', to: '09:50', zone: 'new_york', days: 'trading' } },
  { id: 'ny-close', label: 'New York close', w: { from: '15:55', to: '16:10', zone: 'new_york', days: 'trading' } },
  { id: 'ldn-open', label: 'London open', w: { from: '07:55', to: '08:20', zone: 'london', days: 'trading' } },
  { id: 'ny-session', label: 'New York session', w: { from: '09:30', to: '16:00', zone: 'new_york', days: 'trading' } },
  { id: 'ldn-session', label: 'London session', w: { from: '08:00', to: '16:30', zone: 'london', days: 'trading' } },
  { id: 'asia', label: 'Asia morning', w: { from: '00:00', to: '03:00', zone: 'utc', days: 'weekdays' } },
];
/** The news gate (engine MmSpec.news): off the book from beforeMin before to afterMin after each US release of its level. */
export interface NewsGate { beforeMin: number; afterMin: number; level: 'high' | 'medium' }
export const NEWS_DEFAULT: NewsGate = { beforeMin: 2, afterMin: 10, level: 'high' };
export const FLOW_DEFAULT = { flowMinUsd: 250_000, flowWindowMin: 10, flowAction: 'pause' as const, flowShrink: 0.5 };

/** What the form holds: every strategy's fields, the market and the switches. */
export interface BotDraft {
  strategy: Strategy;
  /**
   * Futures or spot (owner 2026-11-19): the engine `symbol` belongs to (bots/engines.ts). Spot has no short, no
   * leverage: a spot grid runs long (buys first, sells only what it bought), a spot market maker sells only what it bought.
   */
  engine: BotEngine;
  symbol: string;
  label: string;
  paper: boolean;
  /* maker */
  /** Ticks from the best price: 0 joins it, -1 steps one tick inside where the spread has room (front of the queue). */
  offsetTicks: number;
  orderUsd: number;
  maxInventoryUsd: number;
  skewTicks: number;
  chaseTicks: number;
  minRepriceMs: number;
  /** Each quote at least this far from the mid, bp (0: at the touch). */
  edgeBps: number;
  /** The queue guard, a fraction (0: off): the adding side waits while its own queue is thinner than this share. */
  queueGuard: number;
  /** Quotes a side keeps resting as the touch moves away (1: one, re-priced): the spec's `levels`. */
  ladder: number;
  /** Ticks the mid may move in 2 s before the side it runs into waits (0: off). */
  moveGuard: number;
  /* Binance-led maker */
  /** Where the adding side rests, bp from the Binance fair price (0: SoDEX's best price while it is far enough). */
  refBps: number;
  /** The adding side is not quoted, and is pulled, within this many bp of the fair price. */
  pullBps: number;
  /* market maker (R10) */
  /** The longest a quote rests before it is placed again, seconds (spec restMs). */
  restS: number;
  /** Rests at SoDEX's touch with no limit or pull at the oracle; the oracle only feeds the gate (spec noFair, N5). */
  noFair: boolean;
  /** The market gate: no new quote while Binance moved more than gateBps over the last gateWindowS (spec stillBps / stillMs). */
  gate: boolean;
  gateBps: number;
  gateWindowS: number;
  /** Not quoted while SoDEX's spread is wider than this, bp (null: no limit). On by default at 20 bp (owner 2026-11-08). */
  maxSpreadBps: number | null;
  /** The leverage SoDEX is set to on the market before the first order (null: as the account holds it). */
  leverage: number | null;
  /**
   * Leverage follows the sizing (owner 2026-11-08): the lowest whole leverage at which the bot's margin fits what is
   * free in the account (autoLeverage). Off once the user sets one by hand; a running bot's draft starts off.
   */
  leverageAuto: boolean;
  /** Quotes and levels post-only (maker only, the default); off: plain limits that may take (owner 2026-11-08). */
  postOnly: boolean;
  /* grid */
  /**
   * The step in units of the market's hourly volatility (bots/gridPresets.ts): the range follows the market as it is
   * now (rangePct is set from it once the volatility is read). null: the range is the draft's own (rangePct, low/high).
   */
  gridK: number | null;
  rangePct: number;
  low: number | null;
  high: number | null;
  levels: number;
  /** Neutral: buys below and sells above from the start; long: buys first and sells only what it bought; short: the mirror. */
  gridDir: 'neutral' | 'long' | 'short';
  /** Even steps in percent (geometric) or in dollars (linear). */
  spacing: 'geometric' | 'linear';
  /** Start only once the price reaches this (engine triggerPrice); null: at once. */
  triggerPrice: number | null;
  /** Stop when the price goes above / below these (engine upper / lower bounds, then 'stop'); null: none. */
  stopAbove: number | null;
  stopBelow: number | null;
  /* safeguards (engine flowGate / quiet, owner 2026-11-07) */
  /** The flow gate: pause, or quote smaller, while the patient taker (1002) traded less than flowMinUsd here over flowWindowMin. */
  flowOn: boolean;
  flowMinUsd: number;
  flowWindowMin: number;
  flowAction: 'pause' | 'shrink';
  flowShrink: number;
  /** Time windows (zone time, HH:MM): paused inside them, or (quietOnly) trading only inside them. */
  quiet: QuietWindow[];
  quietOnly: boolean;
  /** The news gate (null: off). */
  news: NewsGate | null;
  /** Stops after this many hours (null: runs until stopped): spec endAt from its start. */
  runHours: number | null;
  /**
   * A running bot's exact end and the hours it read back as (draftOfSpec): kept as it is while runHours is not
   * changed, so a save or restart never moves the end (audit 2026-11-09: it gained up to 59 min each time).
   */
  endAt?: number | null;
  runHoursAt?: number | null;
  /* limits */
  volumeTargetUsd: number | null;
  maxLossUsd: number | null;
  /** Stop once its net PnL reaches this (engine takeProfitUsd); null: no take-profit. */
  takeProfitUsd: number | null;
  onStop: 'close' | 'keep';
  outOfRange: 'wait' | 'stop';
}

/** The presets, per strategy. Prices of a grid come from the mark when it is set up (rangePct either way). */
export const PRESET_VALUES: Record<Strategy, Record<PresetId, Partial<BotDraft>>> = {
  market: {
    steady: { orderUsd: 12, maxInventoryUsd: 24, maxLossUsd: 3 },
    balanced: { orderUsd: 50, maxInventoryUsd: 150, maxLossUsd: 10 },
    active: { orderUsd: 150, maxInventoryUsd: 450, maxLossUsd: 30 },
  },
  maker: {
    steady: { orderUsd: 20, maxInventoryUsd: 60, skewTicks: 4, chaseTicks: 2, minRepriceMs: 5_000, maxLossUsd: 3 },
    balanced: { orderUsd: 50, maxInventoryUsd: 200, skewTicks: 4, chaseTicks: 2, minRepriceMs: 3_000, maxLossUsd: 10 },
    active: { orderUsd: 150, maxInventoryUsd: 600, skewTicks: 6, chaseTicks: 1, minRepriceMs: 2_000, maxLossUsd: 30 },
  },
  lead: {
    steady: { orderUsd: 20, maxInventoryUsd: 60, skewTicks: 4, chaseTicks: 2, minRepriceMs: 5_000, maxLossUsd: 3, refBps: 0, pullBps: 1 },
    balanced: { orderUsd: 50, maxInventoryUsd: 200, skewTicks: 4, chaseTicks: 2, minRepriceMs: 3_000, maxLossUsd: 10, refBps: 0, pullBps: 0.5 },
    active: { orderUsd: 150, maxInventoryUsd: 600, skewTicks: 6, chaseTicks: 1, minRepriceMs: 2_000, maxLossUsd: 30, refBps: 0, pullBps: 0.25 },
  },
  hedge: { steady: {}, balanced: {}, active: {} },
  grid: {
    steady: { rangePct: 0.03, levels: 10, orderUsd: 15, maxLossUsd: 5 },
    balanced: { rangePct: 0.02, levels: 16, orderUsd: 25, maxLossUsd: 15 },
    active: { rangePct: 0.01, levels: 24, orderUsd: 40, maxLossUsd: 40 },
  },
};

/** R10, the setting the live tests kept (docs/BOTS-UI.md): at the touch, no skew, re-placed after 10 s, no chase. */
export const R10 = { offsetTicks: 0, skewTicks: 0, chaseTicks: 40, minRepriceMs: 1_000, restS: 10 } as const;
/** The market gate the backtest kept: 12 bp of Binance path over a minute. */
export const GATE_DEFAULT = { gateBps: 12, gateWindowS: 60 } as const;

export function draftFor(strategy: Strategy, preset: PresetId = 'balanced', symbol = 'BTC-USD'): BotDraft {
  return {
    strategy,
    engine: engineOfSymbol(symbol),
    symbol,
    label: '',
    paper: false, // real by default (owner 2026-11-10: "remove paper option enabled per default"); a wallet that may not trade real bots is held on Practice (BotNewPage liveAllowed)
    restS: R10.restS,
    noFair: false,
    gate: false,
    ...GATE_DEFAULT,
    maxSpreadBps: 20,
    leverage: null,
    leverageAuto: true,
    postOnly: true,
    offsetTicks: -1,
    orderUsd: 50,
    maxInventoryUsd: 200,
    skewTicks: 4,
    chaseTicks: 2,
    minRepriceMs: 3_000,
    edgeBps: 0,
    queueGuard: 0,
    ladder: 1,
    moveGuard: 0,
    refBps: 0,
    pullBps: 0,
    gridK: null,
    rangePct: 0.02,
    low: null,
    high: null,
    levels: 16,
    gridDir: 'neutral',
    spacing: 'geometric',
    triggerPrice: null,
    stopAbove: null,
    stopBelow: null,
    volumeTargetUsd: null,
    maxLossUsd: null,
    takeProfitUsd: null,
    onStop: 'close',
    outOfRange: 'wait',
    flowOn: false,
    ...FLOW_DEFAULT,
    quiet: [],
    quietOnly: false,
    news: null,
    runHours: null,
    ...(strategy === 'market' ? R10 : {}),
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
  const spot = d.engine === 'spot';
  // The oracle makers quote off Binance futures: not on spot (the engine refuses `ref` there). A spot maker is the plain one.
  if (spot && (d.strategy === 'market' || d.strategy === 'lead')) d = { ...d, strategy: 'maker' };
  const base = { symbol: d.symbol, engine: d.engine, paper: d.paper, label: d.label.trim() || null, ...(!spot && d.leverage !== null ? { leverage: d.leverage } : {}), ...(d.postOnly === false ? { postOnly: false } : {}) };
  const limits = { volumeTargetUsd: d.volumeTargetUsd, maxLossUsd: d.maxLossUsd, onStop: d.onStop, ...(d.takeProfitUsd !== null && d.takeProfitUsd > 0 ? { takeProfitUsd: d.takeProfitUsd } : {}) };
  if (d.strategy === 'market') {
    return {
      ...base, ...limits, kind: 'mm', ref: 'binance', offsetTicks: d.offsetTicks, orderUsd: d.orderUsd, maxInventoryUsd: d.maxInventoryUsd, skewTicks: d.skewTicks,
      chaseTicks: d.chaseTicks, minRepriceMs: d.minRepriceMs, restMs: Math.round(d.restS * 1000),
      ...(d.gate ? { stillBps: d.gateBps, stillMs: Math.round(d.gateWindowS * 1000) } : {}),
      ...(d.maxSpreadBps !== null ? { maxSpreadBps: d.maxSpreadBps } : {}),
      ...(d.refBps > 0 ? { refBps: d.refBps } : {}), ...(d.pullBps > 0 ? { pullBps: d.pullBps } : {}),
      ...(d.ladder > 1 ? { levels: d.ladder } : {}), ...(d.moveGuard > 0 ? { moveGuard: d.moveGuard } : {}),
      ...(d.noFair ? { noFair: true } : {}),
      ...safeguards(d),
    };
  }
  if (isMaker(d.strategy)) {
    const lead = d.strategy === 'lead' ? { ref: 'binance', ...(d.refBps > 0 ? { refBps: d.refBps } : {}), ...(d.pullBps > 0 ? { pullBps: d.pullBps } : {}) } : {};
    return { ...base, ...limits, ...lead, ...safeguards(d), ...(d.maxSpreadBps !== null ? { maxSpreadBps: d.maxSpreadBps } : {}), kind: 'mm', offsetTicks: d.offsetTicks, orderUsd: d.orderUsd, maxInventoryUsd: d.maxInventoryUsd, skewTicks: d.skewTicks, chaseTicks: d.chaseTicks, minRepriceMs: d.minRepriceMs, ...(d.edgeBps > 0 ? { edgeBps: d.edgeBps } : {}), ...(d.queueGuard > 0 ? { queueGuard: d.queueGuard } : {}), ...(d.ladder > 1 ? { levels: d.ladder } : {}), ...(d.moveGuard > 0 ? { moveGuard: d.moveGuard } : {}) };
  }
  if (d.strategy === 'hedge') throw new Error('A hedge is set up on its own page (HedgeNewPage).');
  // A grid takes the spread limit and the end time (spec base / botLimits); the flow gate, trading hours and news gate
  // are the volume maker's only (spec.ts parses them for 'mm'), so a grid never carries them.
  const r = gridRange(d, mark);
  return {
    ...base, ...limits, kind: 'grid', low: r?.low ?? null, high: r?.high ?? null, levels: d.levels, orderUsd: d.orderUsd, spacing: d.spacing, outOfRange: d.outOfRange,
    // Spot cannot short: its grid runs long - buys first, sells only what it bought.
    ...(spot ? { direction: 'long' } : d.gridDir !== 'neutral' ? { direction: d.gridDir } : {}),
    ...(d.triggerPrice !== null && d.triggerPrice > 0 ? { triggerPrice: d.triggerPrice } : {}),
    ...(d.stopAbove !== null && d.stopAbove > 0 ? { upper: { price: d.stopAbove, then: 'stop' } } : {}),
    ...(d.stopBelow !== null && d.stopBelow > 0 ? { lower: { price: d.stopBelow, then: 'stop' } } : {}),
    ...(d.maxSpreadBps !== null ? { maxSpreadBps: d.maxSpreadBps } : {}),
    ...runEnd(d),
  };
}

/** The run time as the spec's end (engine botLimits.endAt): from now, the hours the draft says. */
function runEnd(d: BotDraft, now = Date.now()): { endAt?: number } {
  if (d.endAt !== undefined && d.endAt !== null && d.runHours === (d.runHoursAt ?? null) && d.endAt > now) return { endAt: d.endAt };
  return d.runHours !== null && d.runHours > 0 ? { endAt: now + Math.round(d.runHours * 3_600_000) } : {};
}

/** A spec's end as the hours it still has, rounded up to a whole hour (null: no end, or already past). */
export function runHoursLeft(endAt: number | null | undefined, now = Date.now()): number | null {
  if (endAt === null || endAt === undefined || !Number.isFinite(endAt) || endAt <= now) return null;
  return Math.max(1, Math.ceil((endAt - now) / 3_600_000));
}

/** The flow gate, the quiet windows and the run time, as the spec carries them (engine flowGate / quiet / endAt). */
function safeguards(d: BotDraft): Record<string, unknown> {
  return {
    ...(d.flowOn ? { flowGate: { minUsd: d.flowMinUsd, windowMs: Math.round(d.flowWindowMin * 60_000), action: d.flowAction, shrink: d.flowShrink } } : {}),
    ...(d.quiet.length ? { quiet: d.quiet.map((w) => ({ ...w })), ...(d.quietOnly ? { quietOnly: true } : {}) } : {}),
    ...(d.news ? { news: { ...d.news } } : {}),
    ...runEnd(d),
  };
}

/** The safeguards a spec carries, back as draft fields. */
function safeguardsOf(s: AlgoSpec, now: number): Partial<BotDraft> {
  const x = s as unknown as { flowGate?: { minUsd: number; windowMs: number; action: 'pause' | 'shrink'; shrink: number }; quiet?: QuietWindow[]; quietOnly?: boolean; news?: NewsGate; endAt?: number | null };
  const left = runHoursLeft(x.endAt, now);
  return {
    runHours: left,
    endAt: left !== null ? (x.endAt ?? null) : null,
    runHoursAt: left,
    ...(x.flowGate ? { flowOn: true, flowMinUsd: x.flowGate.minUsd, flowWindowMin: x.flowGate.windowMs / 60_000, flowAction: x.flowGate.action, flowShrink: x.flowGate.shrink } : {}),
    ...(x.quiet ? { quiet: x.quiet.map((w) => ({ ...w })), quietOnly: x.quietOnly === true } : {}),
    ...(x.news ? { news: { ...x.news } } : {}),
  };
}

/** What changed between two drafts, as spec fields (the restart's "N changes"). endAt is a time from now: not a change. */
export function specChanges(before: BotDraft, after: BotDraft): string[] {
  const a = specOf(before, null);
  const b = specOf(after, null);
  delete a.endAt;
  delete b.endAt;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  // The run time changed only when the user changed it: an edit started from a read-back keeps its own reading, so an
  // hour boundary passing while it is open is not a change (audit 2026-11-09).
  const changed = after.runHoursAt !== undefined ? after.runHours !== after.runHoursAt : after.runHours !== before.runHours;
  if (changed) out.push('endAt');
  return out;
}

/** The draft a running bot's spec reads back as (the Edit form; a restart keeps its end time as the hours left). */
export function draftOfSpec(s: AlgoSpec, now = Date.now()): BotDraft {
  if (s.kind === 'mm' && s.ref && s.restMs) {
    return {
      ...draftFor('market', 'balanced', s.symbol), label: s.label ?? '', paper: s.paper, offsetTicks: s.offsetTicks, orderUsd: s.orderUsd, maxInventoryUsd: s.maxInventoryUsd,
      skewTicks: s.skewTicks, chaseTicks: s.chaseTicks, minRepriceMs: s.minRepriceMs, restS: s.restMs / 1000,
      gate: (s.stillBps ?? 0) > 0, gateBps: s.stillBps ?? GATE_DEFAULT.gateBps, gateWindowS: (s.stillMs ?? GATE_DEFAULT.gateWindowS * 1000) / 1000,
      maxSpreadBps: s.maxSpreadBps, leverage: s.leverage ?? null, leverageAuto: false, postOnly: (s as { postOnly?: false }).postOnly !== false, volumeTargetUsd: s.volumeTargetUsd, maxLossUsd: s.maxLossUsd, takeProfitUsd: s.takeProfitUsd ?? null, onStop: s.onStop,
      refBps: s.refBps ?? 0, pullBps: s.pullBps ?? 0, ladder: s.levels ?? 1, moveGuard: s.moveGuard ?? 0, noFair: !!s.noFair,
      ...safeguardsOf(s, now),
    };
  }
  if (s.kind === 'mm') {
    return { ...draftFor(s.ref ? 'lead' : 'maker', 'balanced', s.symbol), refBps: s.refBps ?? 0, pullBps: s.pullBps ?? 0, label: s.label ?? '', paper: s.paper, offsetTicks: s.offsetTicks, orderUsd: s.orderUsd, maxInventoryUsd: s.maxInventoryUsd, skewTicks: s.skewTicks, chaseTicks: s.chaseTicks, minRepriceMs: s.minRepriceMs, edgeBps: s.edgeBps ?? 0, queueGuard: s.queueGuard ?? 0, ladder: s.levels ?? 1, moveGuard: s.moveGuard ?? 0, volumeTargetUsd: s.volumeTargetUsd, maxLossUsd: s.maxLossUsd, takeProfitUsd: s.takeProfitUsd ?? null, onStop: s.onStop, maxSpreadBps: s.maxSpreadBps ?? null, leverage: s.leverage ?? null, leverageAuto: false, postOnly: (s as { postOnly?: false }).postOnly !== false, ...safeguardsOf(s, now) };
  }
  if (s.kind === 'grid') {
    return { ...draftFor('grid', 'balanced', s.symbol), gridK: null, label: s.label ?? '', paper: s.paper, leverage: s.leverage ?? null, leverageAuto: false, postOnly: (s as { postOnly?: false }).postOnly !== false, low: s.low, high: s.high, levels: s.levels, spacing: s.spacing === 'linear' ? 'linear' : 'geometric', gridDir: s.direction ?? 'neutral', triggerPrice: s.triggerPrice ?? null, stopAbove: s.upper?.then === 'stop' ? s.upper.price : null, stopBelow: s.lower?.then === 'stop' ? s.lower.price : null, takeProfitUsd: s.takeProfitUsd ?? null, orderUsd: s.orderUsd, volumeTargetUsd: s.volumeTargetUsd, maxLossUsd: s.maxLossUsd, onStop: s.onStop, outOfRange: s.outOfRange, maxSpreadBps: s.maxSpreadBps, runHours: runHoursLeft(s.endAt, now), endAt: runHoursLeft(s.endAt, now) !== null ? s.endAt : null, runHoursAt: runHoursLeft(s.endAt, now) };
  }
  if (s.kind === 'hedge') {
    // Its limits only: its size and buffers have their own settings (HedgeSettings).
    return { ...draftFor('hedge', 'balanced', s.symbol), label: s.label ?? '', paper: s.paper, leverage: s.leverage ?? null, leverageAuto: false, volumeTargetUsd: s.volumeTargetUsd, maxLossUsd: s.maxLossUsd, takeProfitUsd: s.takeProfitUsd ?? null, onStop: s.onStop, maxSpreadBps: s.maxSpreadBps, runHours: runHoursLeft(s.endAt, now), endAt: runHoursLeft(s.endAt, now) !== null ? s.endAt : null, runHoursAt: runHoursLeft(s.endAt, now) };
  }
  return draftFor('maker', 'balanced', s.symbol);
}

/** What an Edit may send (runtime BOT_UPDATABLE): only the fields that changed. */
export function patchOf(before: BotDraft, after: BotDraft): Record<string, unknown> {
  if (after.strategy === 'market') {
    const out: Record<string, unknown> = {};
    for (const k of ['offsetTicks', 'orderUsd', 'maxInventoryUsd', 'skewTicks', 'volumeTargetUsd', 'maxLossUsd', 'takeProfitUsd', 'onStop', 'maxSpreadBps'] as const) if (before[k] !== after[k]) out[k] = after[k];
    if (before.restS !== after.restS) out.restMs = Math.round(after.restS * 1000);
    // The gate off is stillBps 0 (the spec drops it); on, both numbers so a change of one keeps the other.
    if (before.gate !== after.gate || (after.gate && (before.gateBps !== after.gateBps || before.gateWindowS !== after.gateWindowS))) {
      out.stillBps = after.gate ? after.gateBps : 0;
      if (after.gate) out.stillMs = Math.round(after.gateWindowS * 1000);
    }
    if (before.label.trim() !== after.label.trim()) out.label = after.label.trim() || null;
    return out;
  }
  const keys: Array<keyof BotDraft> =
    after.strategy === 'maker' ? ['offsetTicks', 'orderUsd', 'maxInventoryUsd', 'skewTicks', 'chaseTicks', 'minRepriceMs', 'edgeBps', 'queueGuard', 'ladder', 'moveGuard', 'volumeTargetUsd', 'maxLossUsd', 'takeProfitUsd', 'onStop', 'maxSpreadBps']
    : after.strategy === 'lead' ? ['orderUsd', 'maxInventoryUsd', 'skewTicks', 'chaseTicks', 'minRepriceMs', 'refBps', 'pullBps', 'volumeTargetUsd', 'maxLossUsd', 'takeProfitUsd', 'onStop', 'maxSpreadBps']
    : after.strategy === 'hedge' ? ['volumeTargetUsd', 'maxLossUsd', 'takeProfitUsd', 'onStop', 'maxSpreadBps']
    : ['orderUsd', 'volumeTargetUsd', 'maxLossUsd', 'takeProfitUsd', 'onStop', 'outOfRange', 'maxSpreadBps'];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (before[k] !== after[k]) out[k === 'ladder' ? 'levels' : k] = after[k];
  // A grid's range, levels, spacing and direction are what it is (a restart changes them); its stop prices may change.
  if (after.strategy === 'grid') {
    if (before.stopAbove !== after.stopAbove) out.upper = after.stopAbove ? { price: after.stopAbove, then: 'stop' } : null;
    if (before.stopBelow !== after.stopBelow) out.lower = after.stopBelow ? { price: after.stopBelow, then: 'stop' } : null;
  }
  if (before.label.trim() !== after.label.trim()) out.label = after.label.trim() || null;
  return out;
}

/** The strategy a running algo is (null: not one of the page's bots - a bot DCA from before 2026-11-02 included). */
export function strategyOf(s: AlgoSpec): Strategy | null {
  if (!s.bot) return null;
  return s.kind === 'mm' ? (s.ref && s.restMs ? 'market' : s.ref ? 'lead' : 'maker') : s.kind === 'grid' ? 'grid' : s.kind === 'hedge' ? 'hedge' : null;
}

/* ------------------------------------------------------ trading hours chart ----- */
/*
 * The hours chart (HoursGate) works in the viewer's own clock, `offMin` minutes off UTC, and stores UTC windows. A
 * half-hour zone (UTC+5:30, offMin 330) was rounded to +6 (audit B), so a picked hour landed 30 minutes off: here a
 * local hour j is UTC minute j*60 - offMin to + 60, and its window keeps the minutes ('18:30'-'19:30').
 */
const minOf = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};
const hhmm = (m: number): string => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

/** "UTC+5:30", "UTC−4", "UTC+0". */
export function offWords(offMin: number): string {
  const a = Math.abs(offMin);
  return `UTC${offMin >= 0 ? '+' : '−'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

/** The viewer's own time zone (IANA, e.g. 'Europe/Berlin'); 'UTC' where the browser does not say. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A window the chart made: in the viewer's own zone `zone` (owner 2026-11-08: a picked hour stays that hour of their
 * clock across daylight saving), every day, on the hour (or the whole day); or, from before, UTC on the hour of a
 * viewer `offMin` off UTC.
 */
export function isChartWindow(w: QuietWindow, offMin: number, zone?: string): boolean {
  if (w.days !== 'all') return false;
  if (zone && w.zone === zone && zone !== 'utc') {
    if (w.from === '00:00' && w.to === '23:59') return true;
    const a = minOf(w.from), b = minOf(w.to);
    return a !== null && b !== null && a % 60 === 0 && b % 60 === 0;
  }
  if (w.zone !== 'utc') return false;
  if (w.from === '00:00' && w.to === '23:59') return true;
  const a = minOf(w.from), b = minOf(w.to);
  if (a === null || b === null) return false;
  return ((a + offMin) % 60 + 60) % 60 === 0 && ((b + offMin) % 60 + 60) % 60 === 0;
}

/** The viewer's hours (0-23 of their clock) the chart windows cover. */
export function chartHours(ws: readonly QuietWindow[], offMin: number, zone?: string): Set<number> {
  const hours = new Set<number>();
  for (const w of ws) {
    if (!isChartWindow(w, offMin, zone)) continue;
    if (w.from === '00:00' && w.to === '23:59') { for (let h = 0; h < 24; h++) hours.add(h); continue; }
    const a = minOf(w.from)!, b = minOf(w.to)!;
    const len = b > a ? b - a : b + 1440 - a;
    // In the viewer's zone the window's hours are their clock's; a UTC one is shifted by their offset now.
    const own = !!zone && w.zone === zone && zone !== 'utc';
    const start = Math.round(((((own ? a : a + offMin) % 1440) + 1440) % 1440) / 60);
    for (let k = 0; k < Math.round(len / 60); k++) hours.add((start + k) % 24);
  }
  return hours;
}

/**
 * The viewer's hours back as joined windows, every day: in their own zone `zone` when given (the engine follows its
 * daylight saving), else UTC at their offset now.
 */
export function chartWindows(hours: ReadonlySet<number>, offMin: number, zone?: string): QuietWindow[] {
  const z = zone && zone !== 'utc' ? zone : null;
  if (hours.size >= 24) return [{ from: '00:00', to: '23:59', zone: z ?? 'utc', days: 'all' }];
  const out: QuietWindow[] = [];
  for (let h = 0; h < 24; h++) {
    if (!hours.has(h) || hours.has((h + 23) % 24)) continue;
    let e = h;
    while (hours.has((e + 1) % 24)) e = (e + 1) % 24;
    out.push(z ? { from: hhmm(h * 60), to: hhmm((e + 1) * 60), zone: z, days: 'all' } : { from: hhmm(h * 60 - offMin), to: hhmm((e + 1) * 60 - offMin), zone: 'utc', days: 'all' });
  }
  return out;
}

/* --------------------------------------------------------------- leverage ----- */
/**
 * The leverage a bot may use: the market's maximum and the region's ceiling (EEA 2x), whichever is lower; null while
 * the market's maximum is unknown (no slider is offered then: 20x before the market says is how A4 started).
 */
export function leverageCap(marketMax: number | null | undefined, regionMax: number | null | undefined): number | null {
  if (marketMax === null || marketMax === undefined || !(marketMax >= 1)) return null;
  const r = regionMax !== null && regionMax !== undefined && regionMax >= 1 ? regionMax : Infinity;
  return Math.max(1, Math.floor(Math.min(marketMax, r)));
}

/**
 * The leverage that follows the sizing (owner 2026-11-08): the lowest whole leverage at which `reserveUsd` (what the bot
 * may hold and quote, at 1x) fits in `freeUsd` with a tenth to spare, up to the market's maximum. Nothing free known
 * (practice, no wallet): 1x. null while the market's maximum is unknown.
 */
export function autoLeverage(reserveUsd: number, freeUsd: number | null, cap: number | null): number | null {
  if (cap === null) return null;
  if (freeUsd === null || !(reserveUsd > 0)) return 1;
  if (!(freeUsd > 0)) return cap;
  return Math.max(1, Math.min(cap, Math.ceil(reserveUsd / (freeUsd * 0.9) - 1e-9)));
}

/** A chosen leverage kept under the cap (null stays null: the spec then leaves the account's own). */
export function clampLeverage(v: number | null, cap: number | null): number | null {
  if (v === null) return null;
  return cap === null ? v : Math.max(1, Math.min(cap, Math.round(v)));
}

/** $12.34 without a locale (errors read the same everywhere). */
const fmtUsdPlain = (x: number): string => `$${x.toFixed(x >= 100 ? 0 : 2)}`;

/* ---------------------------------------------------------- start, per market ----- */

/** The smallest quote SoDEX takes on a market at a price (USD): a bot's smaller quote goes out at this (mmQuotes / gridQty). */
export function minQuoteUsd(m: MarketInfo, price: number | null): number {
  if (!price || !(price > 0)) return 0;
  return minChildQty(m, price) * price;
}

type MarginFn = (s: AlgoSpec, minOrderUsd?: number, ceiling?: number) => number;
/**
 * The margin a real bot sets aside, as the executor counts it (copy-engine botMarginUsd), on the quote SoDEX really
 * takes: an order under the market's minimum goes out at the minimum, so it is counted at the minimum (audit A3), and
 * the leverage at most the region's ceiling. Passed to the engine too (botMarginUsd(s, minOrderUsd, ceiling) where it
 * takes them); both ways give the same number.
 */
export function botNeedUsd(spec: AlgoSpec, minOrderUsd = 0, ceiling: number | null = null): number {
  const min = Number.isFinite(minOrderUsd) && minOrderUsd > 0 ? minOrderUsd : 0;
  const leverage = clampLeverage(spec.leverage ?? null, ceiling);
  const s = spec.kind === 'mm'
    ? { ...spec, orderUsd: Math.max(spec.orderUsd, min), leverage }
    : spec.kind === 'grid' ? { ...spec, orderUsd: Math.max(spec.orderUsd, min), leverage } : spec;
  return (botMarginUsd as MarginFn)(s as AlgoSpec, min || undefined, ceiling ?? undefined);
}

export interface MarketPlan {
  symbol: string;
  /** The spec to sign (null: it does not parse). */
  spec: Record<string, unknown> | null;
  errors: string[];
  /** checkSizes notes: "Each quote goes out at SoDEX's minimum here, about $X". */
  notes: string[];
  /** The quote SoDEX really takes, USD (the order, or the market's minimum when that is larger). */
  quoteUsd: number;
  /** Its margin (botNeedUsd). */
  marginUsd: number;
}

/**
 * Every picked market checked before anything is signed (audit A4: sizes were checked on the first market only, so
 * a start failed half way): each with its own market rules, its own price and its leverage under its own maximum
 * and the region's ceiling.
 */
export function planMarkets(
  d: BotDraft,
  symbols: readonly string[],
  look: (symbol: string) => { market: MarketInfo | null; price: number | null; maxLeverage: number | null; draft?: BotDraft },
  o: { paper: boolean; regionMax?: number | null; mark?: number | null; now?: number },
): MarketPlan[] {
  return symbols.map((symbol) => {
    const { market, price, maxLeverage, draft } = look(symbol);
    const cap = leverageCap(maxLeverage, o.regionMax ?? null);
    const base = draft ?? d;
    const x: BotDraft = { ...base, symbol, paper: o.paper, leverage: clampLeverage(base.leverage, cap) };
    const spec = specOf(x, symbol === d.symbol ? (o.mark ?? price) : price);
    let parsed: AlgoSpec;
    try {
      parsed = parseAlgoSpec(spec);
    } catch (e) {
      return { symbol, spec: null, errors: [e instanceof Error ? e.message : String(e)], notes: [], quoteUsd: x.orderUsd, marginUsd: 0 };
    }
    if (!market) return { symbol, spec, errors: [], notes: [], quoteUsd: x.orderUsd, marginUsd: botNeedUsd(parsed, 0, o.regionMax ?? null) };
    const px = parsed.kind === 'grid' ? (gridRange(x, price)?.low ?? price) : price;
    const r = checkSizes(parsed, market, { price, seed: 1, now: o.now ?? Date.now() });
    const min = minQuoteUsd(market, px);
    // An order under SoDEX's minimum is not raised behind the user's back: it cannot be started (owner 2026-11-08).
    const errors = [...r.errors];
    if (min > 0 && x.orderUsd < min - 0.005) errors.push(`The order size is under SoDEX's minimum order on ${marketLabel(symbol)} (about ${fmtUsdPlain(Math.ceil(min * 100) / 100)}). Raise it to at least that.`);
    if (min > 0 && parsed.kind === 'mm' && parsed.maxInventoryUsd < Math.max(x.orderUsd, min) - 0.005) errors.push(`Max holding must be at least one order (${fmtUsdPlain(Math.max(x.orderUsd, min))}).`);
    return { symbol, spec, errors, notes: [], quoteUsd: Math.max(x.orderUsd, min), marginUsd: botNeedUsd(parsed, min, o.regionMax ?? null) };
  });
}

/**
 * Practice (paper) bots are off (owner 2026-11-15): New bot, Run again, hedges and the setup start real bots only.
 * The executor refuses a new practice bot as well (EXECUTOR_PRACTICE_BOTS). Practice bots that already run are still
 * shown and can be stopped.
 */
export const PRACTICE_BOTS = false;

/* ---------------------------------------------------------------- refusals ----- */

export type RefusalAction = 'setup' | 'deposit' | 'stop-other' | 'discord' | 'size' | 'practice' | null;
/**
 * An executor refusal (ExecutorError.code, apps/executor service.ts) in plain words, with the one thing to do about
 * it (audit B: the raw messages named copy-trading steps, "algo orders" and beta.valuedesk.so, with no button).
 */
export function refusalOf(code: string | null | undefined, message: string, many = false): { text: string; action: RefusalAction; label: string | null } {
  const it = many ? 'these bots' : 'this bot';
  switch (code) {
    case 'key': return { text: 'Real orders need a trading key on SoDEX first. Set it up once, then start again.', action: 'setup', label: 'Set up real orders' };
    case 'account': return { text: 'Your wallet has no SoDEX account yet. Deposit USDC first, then start again.', action: 'deposit', label: 'Deposit' };
    case 'paper-only':
    case 'beta': return { text: 'Real bots are open to beta testers only for now. Ask on Discord to be added.', action: 'discord', label: 'Ask on Discord' };
    case 'limit': return { text: 'You already run the most bots and algo orders allowed at once. Stop one first.', action: 'stop-other', label: 'See my bots' };
    case 'margin': return /spot|vUSDC/i.test(message)
      ? { text: `Your spot account does not have enough USDC for ${it}'s buys. Lower the order size or max holding, or move USDC to spot.`, action: 'deposit', label: 'Add USDC' }
      : { text: `Your futures account does not have enough free margin for ${it}. Lower the order size or max holding, deposit more, or stop another bot or copy.`, action: 'deposit', label: 'Deposit' };
    // Spot bots (2026-11-19): a trading key or fee approval from before covers futures only.
    case 'key-spot': return { text: 'Your trading key covers futures only. Renew it once in the bot setup (one signature): it then covers spot too.', action: 'setup', label: 'Renew trading key' };
    case 'builder-spot': return { text: 'The bot fee is not approved for spot yet. Approve it once in the bot setup, then start again.', action: 'setup', label: 'Approve for spot' };
    case 'bot-market': return { text: 'You already run a real bot on this market. Stop it first, or pick another market.', action: 'stop-other', label: 'Stop the other bot' };
    // The executor's own codes (apps/executor service.ts BotRefusalCode), each with its one thing to do (audit 2026-11-09).
    case 'bot-capacity':
    case 'live-cap': return { text: 'Real bots are full on our servers right now. Try again later.', action: null, label: null };
    case 'hedge-beta': return { text: 'Hedges are in early access: a wallet of the hedge must be on the beta list. Ask on Discord to be added.', action: 'discord', label: 'Ask on Discord' };
    case 'practice-off': return { text: 'Practice bots are off. Start it with real orders instead.', action: null, label: null };
    case 'margin-unknown': return { text: 'SoDEX did not tell your account balance just now, so the margin could not be checked. Try again in a moment.', action: null, label: null };
    case 'market-position': return { text: `${message} A bot starts only on a market where you hold nothing: close it in Trade first, or pick another market.`, action: null, label: null };
    case 'market-copy': return { text: `${message} Stop that copy in Copy trading, or pick another market.`, action: null, label: null };
    case 'market-algo': return { text: `${message} Cancel it in Trade, or pick another market.`, action: null, label: null };
    case 'moved': return { text: 'Your bots run on the other servers now. Reload to manage them there.', action: null, label: null };
    case 'vip-moving':
    case 'move': return { text: 'Your bots are moving between servers right now. Wait for the move to finish, then start again.', action: null, label: null };
    case 'size':
    case 'spec':
    case 'algo': return /size|minimum|order|holding|cap/i.test(message) ? { text: message, action: 'size', label: 'Change the size' } : { text: message, action: null, label: null };
    default: return { text: message, action: null, label: null };
  }
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
  } else if (d.strategy === 'lead' && d.refBps > 0) {
    // refBps from fair on each side: a round trip (two fills) earns twice it on one order, refBps per $1 of volume.
    edge = (d.refBps / 10_000) * 1_000_000;
  } else if (m && mark && mark > 0 && d.edgeBps === 0) {
    edge = (Number(m.tickSize) / mark / 2) * 1_000_000;
  }
  return { trade, builder, fees, edge, net: fees - (edge ?? 0) };
}

/* --------------------------------------------------------- where it costs least ----- */

export interface MarketCost {
  symbol: string;
  spreadBps: number;
  /** What a round trip of quotes one tick inside the spread earns, bp (one tick where the spread is one tick). */
  captureBps: number;
  /** Fees less half the capture, per $1M, before price moves (USD). Negative: it earns. */
  costPerMillion: number;
  /** SoDEX's 24 h volume (USD): takers to fill against. */
  volumeUsd: number;
}

/**
 * The markets a volume maker costs least on now, cheapest first: where the spread is wide, a quote one tick
 * inside each side earns most of it on every round trip (spread less two ticks); where it is one tick, that tick.
 * Only markets with enough takers (24 h volume) and a sane spread (at most 60 bp) count. Before price moves:
 * the live runs (docs/BOTS.md) put those at $40-90 per $1M on a one-tick market.
 */
export function cheapestMakerMarkets(
  tickers: ReadonlyArray<{ symbol: string; bidPx: string; askPx: string; quoteVolume: string }>,
  tickOf: (symbol: string) => number | null,
  o: { minVolumeUsd?: number; makerFee?: number; botFeeTenths?: number; limit?: number } = {},
): MarketCost[] {
  const fees = ((o.makerFee ?? DEFAULT_MAKER_FEE) + (o.botFeeTenths ?? DEFAULT_BOT_FEE_TENTHS) / 100_000) * 1_000_000;
  const out: MarketCost[] = [];
  for (const t of tickers) {
    const bid = Number(t.bidPx);
    const ask = Number(t.askPx);
    const tick = tickOf(t.symbol);
    const vol = Number(t.quoteVolume);
    if (!(bid > 0 && ask > bid) || !tick || !(vol >= (o.minVolumeUsd ?? 100_000))) continue;
    const mid = (bid + ask) / 2;
    const ticks = Math.round((ask - bid) / tick);
    const spreadBps = ((ask - bid) / mid) * 10_000;
    if (spreadBps > 60) continue;
    const captureBps = ((ticks >= 3 ? ticks - 2 : 1) * tick / mid) * 10_000;
    out.push({ symbol: t.symbol, spreadBps, captureBps, costPerMillion: fees - (captureBps / 2) * 100, volumeUsd: vol });
  }
  return out.sort((a, b) => a.costPerMillion - b.costPerMillion).slice(0, o.limit ?? 6);
}

/**
 * The spread limit a bot starts with on a market (owner 2026-11-09): about 1.5x the market's typical spread from
 * SoDEX's book, rounded up to 5 bp, never under the 20 bp default - so a thin market (KORU ~29 bp) quotes instead of
 * waiting. null: the market's spread is not known from the book (the default stands).
 */
export function suggestedSpreadBps(m: { spreadBps: number; spreadFrom?: 'book' | 'prints' } | null | undefined): number | null {
  if (!m || m.spreadFrom !== 'book' || !(m.spreadBps > 0)) return null;
  return Math.max(20, Math.ceil((m.spreadBps * 1.5) / 5) * 5);
}
