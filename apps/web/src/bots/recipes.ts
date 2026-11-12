/**
 * The bots a user can start (owner 2026-11-08: "Market maker is basically just the category"): every setting our
 * live runs and the replay backtest kept, each a bot of its own, and the grid.
 *
 * What each is measured against: the market's own estimate (bots/data.ts estCostBps, what small makers' fills cost on
 * that market, calibrated on our R10 live runs) is R10's. The others carry the difference the tests measured
 * (deltaBps, volumeX), with where it comes from (evidence). Sources: docs/BOTS.md, memory maker-wider-test (switch6-13,
 * replay bsweep2/ethsweep 2026-11-07), btc-maker-cost-levers (2026-11-04).
 *
 * Pure: the page and its tests read the same numbers.
 */
import type { AlgoSpec } from '@copy-engine';
import { GATE_DEFAULT, R10, draftFor, type BotDraft, type Strategy } from './presets';
import { GRID_PRESETS } from './gridPresets';

export type RecipeId = 'r10' | 'r10g' | 's1' | 'n5' | 'n5g' | 'touch' | 'gridc' | 'grid' | 'gridv';
export type Category = 'market' | 'grid';

export interface Evidence {
  kind: 'live' | 'replay';
  /** What was run, where: "BTC live, 11 rounds". */
  what: string;
  /** Its result, per $1M at our 1.3 bp fee (negative earns): bp. */
  bp: number;
}

export interface Recipe {
  id: RecipeId;
  category: Category;
  strategy: Strategy;
  name: string;
  /** The test name, shown small. */
  code: string;
  line: string;
  /** For someone new: what it is good for, in one plain sentence. */
  plain: string;
  /** The draft fields this bot sets over the strategy's defaults. */
  params: Partial<BotDraft>;
  /** Against R10 on the same market (bp; negative is cheaper), and its volume against R10's. */
  deltaBps: number;
  volumeX: number;
  /** Quotes off the oracle (Binance futures): a market without one runs `touch` instead. */
  oracle: boolean;
  evidence: Evidence[];
  /** How sure the tests are: 'proven' repeated live, 'tested' live or replay once, 'early' a few rounds. */
  proof: 'proven' | 'tested' | 'early';
  tag?: string;
}

const GATE = { gate: true, ...GATE_DEFAULT } as const;

export const RECIPES: readonly Recipe[] = [
  {
    id: 'r10', category: 'market', strategy: 'market', name: 'Oracle maker', code: 'R10', tag: 'Recommended',
    line: 'Rests at the best price for up to 10 s and pulls a quote the oracle moved through.',
    plain: 'Our default. Proven in live trading on BTC and ETH.',
    params: { ...R10, noFair: false, gate: false },
    deltaBps: 0, volumeX: 1, oracle: true, proof: 'proven',
    evidence: [
      { kind: 'live', what: 'ETH live, 5 rounds', bp: 1.18 },
      { kind: 'live', what: 'BTC live, 11 rounds', bp: 1.84 },
      { kind: 'replay', what: 'BTC replay, 3 days', bp: 1.96 },
    ],
  },
  {
    id: 'r10g', category: 'market', strategy: 'market', name: 'Calm oracle maker', code: 'R10 + gate',
    line: 'The oracle maker, quoting only after a calm minute.',
    plain: 'The default, but it sits out when the price jumps around. Trades less.',
    params: { ...R10, noFair: false, ...GATE },
    deltaBps: -0.08, volumeX: 0.65, oracle: true, proof: 'tested',
    evidence: [
      { kind: 'replay', what: 'BTC replay, 3 days', bp: 1.88 },
      { kind: 'replay', what: 'ETH replay, weekdays', bp: 1.82 },
    ],
  },
  {
    id: 's1', category: 'market', strategy: 'market', name: 'Skewed oracle maker', code: 'S1',
    line: 'The oracle maker, stepping its adding side back one tick as it holds.',
    plain: 'The default, leaning against what it holds. Only a few test runs so far.',
    params: { ...R10, noFair: false, gate: false, skewTicks: 1 },
    deltaBps: -0.1, volumeX: 1, oracle: true, proof: 'early',
    evidence: [{ kind: 'live', what: 'BTC live, 2 rounds', bp: 1.76 }],
  },
  {
    id: 'n5', category: 'market', strategy: 'market', name: 'Touch maker', code: 'N5',
    line: 'Rests at the best price for up to 5 s; reads the oracle only for the gate.',
    plain: 'A simpler version that waits at the best price. Trades less.',
    params: { ...R10, restS: 5, noFair: true, gate: false },
    deltaBps: 0.1, volumeX: 0.68, oracle: true, proof: 'tested',
    evidence: [
      { kind: 'live', what: 'ETH live, 5 rounds', bp: 1.28 },
      { kind: 'replay', what: 'ETH replay, Saturday', bp: 1.32 },
    ],
  },
  {
    id: 'n5g', category: 'market', strategy: 'market', name: 'Calm touch maker', code: 'N5 + gate',
    line: 'The touch maker, quoting only after a calm minute.',
    plain: 'The simpler version, sitting out when the price jumps around.',
    params: { ...R10, restS: 5, noFair: true, ...GATE },
    deltaBps: -0.09, volumeX: 0.65, oracle: true, proof: 'tested',
    evidence: [{ kind: 'replay', what: 'BTC replay, 3 days', bp: 1.87 }],
  },
  {
    id: 'touch', category: 'market', strategy: 'maker', name: 'Book maker', code: 'Plain',
    line: 'Quotes off SoDEX\'s own book, no oracle. Runs on every market.',
    plain: 'Works on every market and trades the most, but usually costs more.',
    params: { offsetTicks: 0, chaseTicks: 1, minRepriceMs: 1_000, skewTicks: 0, gate: false },
    deltaBps: 0.45, volumeX: 1.2, oracle: false, proof: 'tested',
    evidence: [
      { kind: 'live', what: 'BTC live, 4 Nov', bp: 2.28 },
      { kind: 'live', what: 'KORU live, 1 round', bp: -3.59 },
    ],
  },
  // The grids (bots/gridPresets.ts GRID_PRESETS, from the grid backtest): the step in units of the market's hourly
  // volatility, stopped (and closed) when the price leaves the range - stopping beat waiting in every test.
  {
    id: 'gridc', category: 'grid', strategy: 'grid', name: 'Wide grid', code: `Grid ${GRID_PRESETS.gridc.k}σ × ${GRID_PRESETS.gridc.levels}`,
    line: 'Few levels far apart: trades rarely, rides out bigger swings.',
    plain: 'The calmest grid. Trades little; the range is wide enough for most weeks.',
    params: { gridK: GRID_PRESETS.gridc.k, levels: GRID_PRESETS.gridc.levels, outOfRange: GRID_PRESETS.gridc.outOfRange, low: null, high: null },
    deltaBps: 0, volumeX: 1, oracle: false, proof: 'tested', evidence: [],
  },
  {
    id: 'grid', category: 'grid', strategy: 'grid', name: 'Range grid', code: `Grid ${GRID_PRESETS.grid.k}σ × ${GRID_PRESETS.grid.levels}`, tag: 'Recommended',
    line: 'Buys low and sells high on levels in a range. Earns every swing inside it.',
    plain: 'The balanced grid: steps twice the hourly swing, stops if the price leaves the range.',
    params: { gridK: GRID_PRESETS.grid.k, levels: GRID_PRESETS.grid.levels, outOfRange: GRID_PRESETS.grid.outOfRange, low: null, high: null },
    deltaBps: 0, volumeX: 1, oracle: false, proof: 'tested', evidence: [],
  },
  {
    id: 'gridv', category: 'grid', strategy: 'grid', name: 'Dense grid', code: `Grid ${GRID_PRESETS.gridv.k}σ × ${GRID_PRESETS.gridv.levels}`,
    line: 'Many levels close together: trades the most of the grids.',
    plain: 'The busiest grid, for volume. Each swing earns less, more of them count.',
    params: { gridK: GRID_PRESETS.gridv.k, levels: GRID_PRESETS.gridv.levels, outOfRange: GRID_PRESETS.gridv.outOfRange, low: null, high: null },
    deltaBps: 0, volumeX: 1, oracle: false, proof: 'tested', evidence: [],
  },
];

export const RECIPE: Record<RecipeId, Recipe> = Object.fromEntries(RECIPES.map((r) => [r.id, r])) as Record<RecipeId, Recipe>;
export const CATEGORIES: Array<{ id: Category; name: string; line: string }> = [
  { id: 'market', name: 'Market maker', line: 'Builds trading volume at the lowest cost.' },
  { id: 'grid', name: 'Grid', line: 'Buys low and sells high in a price range.' },
];
export const recipesOf = (c: Category): Recipe[] => RECIPES.filter((r) => r.category === c);

/** Which bot a running spec is (the closest one: a bot edited by hand stays its recipe's). */
export function recipeOfSpec(s: AlgoSpec): RecipeId {
  if (s.kind === 'grid') return gridRecipeOf(s.levels);
  if (s.kind !== 'mm') return 'r10';
  // No oracle: the book maker. An oracle without a rest time (the older oracle-led maker) is closest to R10, never
  // the book maker - it holds when the oracle goes quiet, which the book maker never does (owner 2026-11-09, MCD).
  if (!s.ref) return 'touch';
  if (!s.restMs) return 'r10';
  const gated = (s.stillBps ?? 0) > 0;
  if (s.noFair) return gated ? 'n5g' : 'n5';
  if (gated) return 'r10g';
  if (s.skewTicks > 0) return 's1';
  return 'r10';
}

/** The recipe a draft still is (null: changed away from every one). */
export function recipeOfDraft(d: BotDraft): RecipeId {
  if (d.strategy === 'grid') return gridRecipeOf(d.levels, d.gridK);
  if (d.strategy !== 'market') return 'touch';
  if (d.noFair) return d.gate ? 'n5g' : 'n5';
  if (d.gate) return 'r10g';
  if (d.skewTicks > 0) return 's1';
  return 'r10';
}

/**
 * The draft a picked bot makes: the bot's own quoting values over its strategy's defaults, and everything else the
 * user already set kept (audit A4: a preset change dropped leverage, news, flow gate, volume target, on stop, and
 * turned "trade only 14-16" into "skip 14-16"). Sizes (order, max holding, loss limit) carry over only inside one
 * category: a grid's order is per level, a market maker's per side.
 */
export function draftOfRecipe(id: RecipeId, symbol: string, keep?: BotDraft): BotDraft {
  const rc = RECIPE[id];
  const base = draftFor(rc.strategy, 'balanced', symbol);
  if (!keep) return { ...base, ...rc.params, strategy: rc.strategy };
  const sameKind = (keep.strategy === 'grid') === (rc.strategy === 'grid');
  const kept: Partial<BotDraft> = {
    label: keep.label,
    paper: keep.paper,
    leverage: keep.leverage,
    maxSpreadBps: keep.maxSpreadBps,
    flowOn: keep.flowOn, flowMinUsd: keep.flowMinUsd, flowWindowMin: keep.flowWindowMin, flowAction: keep.flowAction, flowShrink: keep.flowShrink,
    quiet: keep.quiet.map((w) => ({ ...w })),
    quietOnly: keep.quietOnly,
    news: keep.news ? { ...keep.news } : null,
    runHours: keep.runHours,
    volumeTargetUsd: keep.volumeTargetUsd,
    onStop: keep.onStop,
    outOfRange: keep.outOfRange,
    ...(sameKind ? { orderUsd: keep.orderUsd, maxInventoryUsd: keep.maxInventoryUsd, maxLossUsd: keep.maxLossUsd } : {}),
    // A grid preset sets its own step and levels (rc.params): the range is laid out again from them.
    ...(sameKind && rc.strategy === 'grid' ? { low: null, high: null } : {}),
  };
  return { ...base, ...kept, ...rc.params, strategy: rc.strategy };
}

/** The grid preset a grid is closest to: by its step (in units of the volatility) where known, else by its levels. */
export function gridRecipeOf(levels: number, k: number | null = null): 'gridc' | 'grid' | 'gridv' {
  const ids = ['gridc', 'grid', 'gridv'] as const;
  const dist = (id: (typeof ids)[number]) => (k !== null ? Math.abs(Math.log(k / GRID_PRESETS[id].k)) : 0) + Math.abs(Math.log(Math.max(2, levels) / GRID_PRESETS[id].levels));
  return ids.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}
