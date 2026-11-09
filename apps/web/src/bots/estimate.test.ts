/**
 * The estimate per $1M (estimate.ts) and the bots (recipes.ts): every safeguard moves the estimate by what the
 * market's own fills say, a bot carries its tested difference, the wallet's own runs pull it toward what they did,
 * and every bot makes a spec the engine accepts that reads back as the same bot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlgoSpec, type AlgoSpec, type AlgoView } from '@copy-engine';
import type { BotMarket } from './data';
import { draftFor, draftOfSpec, specOf, type BotDraft } from './presets';
import { RECIPE, RECIPES, recipeOfDraft, recipeOfSpec } from './recipes';
import { PRIOR_USD, bestOf, estimate, feeAdjOf, ownRuns, quietCover, quietCoverLocal, rankRecipes } from './estimate';

const M: BotMarket = {
  symbol: 'ETH-USD', base: 'ETH', tick: 0.01, tickBps: 0.03, price: 3000, volumeUsdH: 2_000_000, spreadBps: 0.1, volBpsH: 100,
  takers: { t1002: 0.7, t23342: 0.3, other: 0 },
  smallMakers: { count: 20, volumeUsdH: 50_000, fills: 5000, markout30Bps: 0, on1002Bps: 0.2, on23342Bps: -0.8 },
  estCostBps: 1.6, estCostLowBps: 1.2, estCostHighBps: 2.1, gateCostBps: 1.4, gateShare: 0.75,
  flowGate: [{ minUsd: 100_000, costBps: 1.5, share: 0.9 }, { minUsd: 250_000, costBps: 1.45, share: 0.8 }, { minUsd: 500_000, costBps: 1.3, share: 0.5 }, { minUsd: 1_000_000, costBps: null, share: 0 }],
  spreadGate: [{ maxBps: 5, costBps: 1.55, share: 0.95 }, { maxBps: 10, costBps: 1.58, share: 0.98 }, { maxBps: 20, costBps: 1.6, share: 1 }],
  capacityUsdH: 50_000, confidence: 'high', weekdayCostBps: 1.7, weekendCostBps: 1.3,
  hourly: Array.from({ length: 24 }, (_, h) => ({ h, costBps: h >= 13 && h <= 14 ? 3 : 1.5, volumeUsdH: 100_000 })),
  lead: 'binance',
};
const r10 = (): BotDraft => ({ ...draftFor('market', 'balanced', 'ETH-USD'), ...RECIPE.r10.params });

test('R10 alone: the market reading', () => {
  const e = estimate(r10(), M);
  assert.equal(e.bp, 1.6);
  assert.equal(e.volumeX, 1);
});

test('the market gate: the reading over calm minutes, and the time it quotes', () => {
  const e = estimate({ ...r10(), gate: true }, M);
  assert.ok(Math.abs(e.bp! - 1.4) < 1e-9);
  assert.equal(e.volumeX, 0.75);
  assert.equal(e.lines.find((l) => l.id === 'gate')?.source, 'market');
});

test('the gate with too few calm fills: the backtest saving is shown, not counted (not proven live)', () => {
  const e = estimate({ ...r10(), gate: true }, { ...M, gateCostBps: null, gateShare: null });
  assert.equal(e.bp, 1.6);
  const g = e.lines.find((l) => l.id === 'gate');
  assert.equal(g?.source, 'tests');
  assert.equal(g?.counted, false);
  assert.equal(g?.bp, RECIPE.r10g.deltaBps);
});

test('a saving only tests show is not counted; an extra cost from tests is', () => {
  const s1 = estimate({ ...r10(), ...RECIPE.s1.params }, M);
  assert.equal(s1.bp, 1.6);
  assert.equal(s1.lines.find((l) => l.id === 'bot')?.counted, false);
  const n5 = estimate({ ...r10(), ...RECIPE.n5.params }, M);
  assert.ok(n5.bp! > 1.6);
  // So the cheapest shown is the best: ties go to the simpler bot (R10 ahead of S1).
  assert.equal(bestOf(rankRecipes({ ...M, gateCostBps: null }, draftFor('market')))!.id, 'r10');
});

test('the flow gate: its bucket (the window scales the threshold); pause drops, shrink keeps it smaller', () => {
  const pause = estimate({ ...r10(), flowOn: true, flowMinUsd: 250_000, flowWindowMin: 10, flowAction: 'pause' }, M);
  assert.ok(Math.abs(pause.bp! - 1.45) < 1e-9);
  assert.equal(pause.volumeX, 0.8);
  // $500K over 20 minutes is $250K per 10.
  const scaled = estimate({ ...r10(), flowOn: true, flowMinUsd: 500_000, flowWindowMin: 20, flowAction: 'pause' }, M);
  assert.ok(Math.abs(scaled.bp! - 1.45) < 1e-9);
  const shrink = estimate({ ...r10(), flowOn: true, flowMinUsd: 250_000, flowWindowMin: 10, flowAction: 'shrink', flowShrink: 0.5 }, M);
  assert.ok(shrink.bp! > pause.bp! && shrink.bp! < 1.6, `shrink sits between: ${shrink.bp}`);
  assert.ok(Math.abs(shrink.volumeX - 0.9) < 1e-9);
  const never = estimate({ ...r10(), flowOn: true, flowMinUsd: 1_000_000, flowWindowMin: 10 }, M);
  assert.equal(never.volumeX, 0);
});

test('quiet hours: the profile without the hours they cover', () => {
  const cover = quietCover([{ from: '13:00', to: '15:00', zone: 'utc', days: 'all' }]);
  assert.equal(cover[13], 1);
  assert.equal(cover[14], 1);
  assert.equal(cover[12], 0);
  const e = estimate({ ...r10(), quiet: [{ from: '13:00', to: '15:00', zone: 'utc', days: 'all' }] }, M);
  // The dear hours 13-14 out: 1.5 instead of the profile's (22 x 1.5 + 2 x 3) / 24.
  const all = (22 * 1.5 + 2 * 3) / 24;
  assert.ok(Math.abs(e.bp! - (1.6 + 1.5 - all)) < 1e-9, String(e.bp));
  assert.ok(Math.abs(e.volumeX - 22 / 24) < 1e-9);
  // Weekdays only: 5/7 of each covered hour.
  assert.ok(Math.abs(quietCover([{ from: '13:00', to: '14:00', zone: 'utc', days: 'weekdays' }])[13]! - 5 / 7) < 1e-9);
});

test('a bot carries its tested difference; a market without an oracle runs the book maker', () => {
  const n5 = estimate({ ...r10(), ...RECIPE.n5.params }, M);
  assert.ok(Math.abs(n5.bp! - (1.6 + RECIPE.n5.deltaBps)) < 1e-9);
  const plain = estimate(r10(), { ...M, lead: null });
  assert.ok(Math.abs(plain.bp! - (1.6 + RECIPE.touch.deltaBps)) < 1e-9);
});

const bot = (spec: Record<string, unknown>, volume: number, netPnl: number): AlgoView =>
  ({ algo: { id: 'x', spec: { ...parseAlgoSpec(spec), bot: true } as AlgoSpec, startedAt: 0, createdAt: 0 }, bot: { volume, netPnl } }) as unknown as AlgoView;

test('your own bots: blended in by volume, more weight the more they trade; practice ones not', () => {
  const spec = specOf({ ...r10(), paper: false }, 3000);
  // Real: 1.0 bp on $250K (netPnl = -$25), the reading 1.6: half way at PRIOR_USD.
  const runs = ownRuns([bot(spec, PRIOR_USD, -25)], [M]);
  assert.equal(runs.length, 1);
  const e = estimate(r10(), M, runs);
  assert.ok(Math.abs(e.bp! - 1.3) < 1e-9, String(e.bp));
  assert.equal(e.learned?.scope, 'market');
  const more = estimate(r10(), M, ownRuns([bot(spec, PRIOR_USD * 9, -225)], [M]));
  assert.ok(Math.abs(more.bp! - (1.6 + (1.0 - 1.6) * 0.9)) < 1e-9);
  assert.equal(ownRuns([bot(specOf({ ...r10(), paper: true }, 3000), PRIOR_USD, -25)], [M]).length, 0);
  // On another market: the fleet's bias, weighed against a larger prior.
  const other = estimate({ ...r10(), symbol: 'SOL-USD' }, { ...M, symbol: 'SOL-USD' }, runs);
  assert.equal(other.learned?.scope, 'fleet');
  assert.ok(other.bp! < 1.6 && other.bp! > 1.3);
});

test('every market maker makes a spec the engine accepts and reads back as the same bot', () => {
  for (const r of RECIPES) {
    const d: BotDraft = { ...draftFor(r.strategy, 'balanced', 'ETH-USD'), ...r.params };
    if (r.strategy === 'grid') continue;
    const s = { ...parseAlgoSpec(specOf(d, 3000)), bot: true } as AlgoSpec;
    assert.equal(recipeOfSpec(s), r.id, r.id);
    assert.equal(recipeOfDraft(draftOfSpec(s)), r.id, `${r.id} draft`);
  }
});

test('ranking: cheapest first; an early bot is never called best', () => {
  const ranked = rankRecipes(M, draftFor('market'));
  for (let i = 1; i < ranked.length; i++) assert.ok((ranked[i - 1]!.est.bp ?? 99) <= (ranked[i]!.est.bp ?? 99));
  assert.notEqual(RECIPE[bestOf(ranked)!.id].proof, 'early');
  assert.deepEqual(rankRecipes({ ...M, lead: null }, draftFor('market')).map((x) => x.id), ['touch']);
});

test('fees: the wallet\'s own bot fee, not the flat 0.1 bp the reading was made with', () => {
  assert.equal(feeAdjOf(1, 0.1), 0);
  assert.ok(Math.abs(feeAdjOf(5, 0.1) - 0.4) < 1e-12, 'the 0.5 bp step of the ladder');
  const e = estimate(r10(), M, [], feeAdjOf(5, 0.1));
  assert.ok(Math.abs(e.bp! - 2.0) < 1e-9, String(e.bp));
  assert.ok(Math.abs(e.low! - 1.6) < 1e-9 && Math.abs(e.high! - 2.5) < 1e-9, `${e.low} ${e.high}`);
  assert.ok(Math.abs(e.lines.find((l) => l.id === 'market')!.bp! - 2.0) < 1e-9, 'the market line carries it, so price moves stay the same');
  // A VIP at 0.1 bp pays what the reading assumed.
  assert.equal(estimate(r10(), M, [], feeAdjOf(1, 0.1)).bp, 1.6);
});

test('quiet cover per hour of a half-hour clock (UTC+5:30): an Indian 14:00-16:00 window covers exactly those two hours', () => {
  const w = [{ from: '08:30', to: '10:30', zone: 'utc' as const, days: 'all' as const }];
  const local = quietCoverLocal(w, 330);
  assert.equal(local[14], 1);
  assert.equal(local[15], 1);
  assert.equal(local[13], 0);
  assert.equal(local[16], 0);
  // By UTC hour the same window is half of 08, all of 09, half of 10.
  const utc = quietCover(w);
  assert.equal(utc[8], 0.5);
  assert.equal(utc[9], 1);
  assert.equal(utc[10], 0.5);
});

test('the spread limit moves the book maker\'s estimate too (it is sent for every bot now)', () => {
  const plain = { ...draftFor('maker', 'balanced', 'ETH-USD'), ...RECIPE.touch.params, maxSpreadBps: 5 };
  assert.ok(estimate(plain, M).lines.some((l) => l.id === 'spread'));
});

test('a maker on the oracle without a rest time is never shown as the book maker (owner 2026-11-09, MCD)', () => {
  const s = { ...parseAlgoSpec({ kind: 'mm', symbol: 'MCD-USD', orderUsd: 60, maxInventoryUsd: 270, maxLossUsd: 5, ref: 'binance' }), bot: true } as AlgoSpec;
  assert.notEqual(recipeOfSpec(s), 'touch');
  assert.equal(RECIPE[recipeOfSpec(s)].oracle, true, 'named as an oracle maker');
  const book = { ...parseAlgoSpec({ kind: 'mm', symbol: 'MCD-USD', orderUsd: 60, maxInventoryUsd: 270, maxLossUsd: 5 }), bot: true } as AlgoSpec;
  assert.equal(recipeOfSpec(book), 'touch');
});
