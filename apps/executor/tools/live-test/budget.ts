/**
 * What the live suite costs, before anything is signed (--budget prints it and
 * stops; a live run prints it and checks the accounts hold enough).
 *
 * Per scenario, from its own cost declaration (scenario.ts) and SoDEX's public
 * market rules and book:
 *
 *   SPENT (gone):   taker notional x (taker fee + builder fee + half the spread)
 *                 + maker notional x (maker fee + builder fee)
 *                 + the leader's taker notional x (taker fee + half the spread)
 *                   (the leader's orders carry no builder), at its venue's fee
 *                   and book: SoDEX's, or Hyperliquid's 4.5 bp and its book;
 *                 + the margin a liquidation scenario may lose (its own bound);
 *   PEAK MARGIN:    the largest exposure at once / the leverage it is held at,
 *                   plus a buffer for the move while it is open and the fees.
 *
 * Scenarios run one at a time and each ends flat, so the account's peak is
 * the largest single scenario - not the sum. Price risk (the market moving
 * while a scenario holds a position, a few minutes) is not a cost on average;
 * it is shown apart as a plus-or-minus.
 */
import type { MarketInfo } from '../../../../packages/copy-engine/src/index.ts';
import type { Scenario } from './scenario.ts';

export interface BookSnapshot {
  bid: number;
  ask: number;
}

export interface BudgetInput {
  main: MarketInfo;
  book: BookSnapshot;
  /** USD per child order. */
  U: number;
  /** The builder fee, as a fraction (2.5 bp = 0.00025). */
  builderRate: number;
  /** Why it is that fee, for the assumptions (default: a local executor's, the ladder's top step). */
  builderWhy?: string;
  /** Leverage a peak is held at unless the scenario says otherwise (EEA and the copies' 2x: 2). */
  leverage: number;
  /** Indicative move while a position is held (a fraction), for the plus-or-minus. */
  riskMove?: number;
  /** Margin buffer over the peak (1.5 = 50% more). */
  buffer?: number;
  /** Where the leader trades and what it pays there. Default: SoDEX, the main market's taker fee and spread. */
  leader?: LeaderCosts;
}

/** The leader's venue, for its share of the budget. */
export interface LeaderCosts {
  venue: 'sodex' | 'hyperliquid';
  /** Its market of the main one ('BTC' on Hyperliquid). */
  market: string;
  takerFee: number;
  /** Half its book's spread, a fraction (null: its book could not be read; the main market's is used). */
  halfSpread: number | null;
  /** Its minimum order value, USD. */
  minOrderUsd: number;
}

export interface BudgetRow {
  id: string;
  section: string;
  traded: number;
  feesUsd: number;
  spreadUsd: number;
  leaderUsd: number;
  /** Margin lost to a liquidation (an upper bound; 0 for every other scenario). */
  lostUsd: number;
  spentUsd: number;
  peakUsd: number;
  marginUsd: number;
  leaderMarginUsd: number;
  riskUsd: number;
}

export interface Budget {
  rows: BudgetRow[];
  bySection: Record<string, { spentUsd: number; peakMarginUsd: number; leaderPeakMarginUsd: number; traded: number }>;
  total: { spentUsd: number; feesUsd: number; spreadUsd: number; leaderUsd: number; lostUsd: number; leaderTraded: number; traded: number; peakMarginUsd: number; leaderPeakMarginUsd: number; riskUsd: number; depositFollowerUsd: number; depositLeaderUsd: number; walletSignatures: number };
  /** Where the leader's deposit goes: 'SoDEX' or 'Hyperliquid'. */
  leaderWhere: string;
  assumptions: string[];
}

export const halfSpreadFrac = (b: BookSnapshot): number => (b.ask - b.bid) / ((b.ask + b.bid) / 2) / 2;

/** The market where a taker round trip costs least: taker fee plus half the spread. */
export function pickMarket(candidates: Array<{ m: MarketInfo; book: BookSnapshot }>): { m: MarketInfo; book: BookSnapshot; costBps: number } {
  const scored = candidates
    .filter((c) => c.m.status === 'TRADING' && c.book.bid > 0 && c.book.ask > c.book.bid)
    .map((c) => ({ ...c, costBps: (c.m.takerFee + halfSpreadFrac(c.book)) * 10_000 }))
    .sort((a, b) => a.costBps - b.costBps);
  if (!scored.length) throw new Error('no candidate market is trading with a two-sided book');
  return scored[0]!;
}

/**
 * The market that moves most: for the scenarios that need the market to reach a level (a take-profit firing). Among
 * markets trading with a spread of at most `maxSpreadBps`, the one whose last minutes' one-minute ranges (high - low,
 * over the close) average highest. A quiet BTC hour left the copy's 0.5% stop (the EEA's 2x) and a bracket's 4 bp
 * take-profit untouched for 10-20 min, inconclusive again and again (2026-10-30); a market that moves settles them.
 * Its tick must be fine too (at most `maxTickBps` of the price): on 1000PEPE-USD one tick is about 19 bp, so a level
 * "4 bp away" rounds to a whole tick and the mark (15 bp under the ask there) had to rise 0.2% (2026-10-30).
 */
export function pickVolatile(candidates: Array<{ m: MarketInfo; book: BookSnapshot; candles: Array<{ h: number; l: number; c: number }> }>, maxSpreadBps = 3, maxTickBps = 1.5): { m: MarketInfo; rangeBps: number } | null {
  const scored = candidates
    .filter((c) => c.m.status === 'TRADING' && c.book.bid > 0 && c.book.ask > c.book.bid && halfSpreadFrac(c.book) * 2 * 10_000 <= maxSpreadBps && c.candles.length >= 5)
    .filter((c) => (Number(c.m.tickSize) / ((c.book.bid + c.book.ask) / 2)) * 10_000 <= maxTickBps)
    .map((c) => ({ m: c.m, rangeBps: (c.candles.reduce((a, k) => a + (k.h - k.l) / k.c, 0) / c.candles.length) * 10_000 }))
    .sort((a, b) => b.rangeBps - a.rangeBps);
  return scored[0] ?? null;
}

export function computeBudget(list: readonly Scenario[], i: BudgetInput): Budget {
  const hs = halfSpreadFrac(i.book);
  const maker = i.main.makerFee ?? i.main.takerFee;
  const buffer = i.buffer ?? 1.5;
  const risk = i.riskMove ?? 0.005;
  const L: LeaderCosts = i.leader ?? { venue: 'sodex', market: i.main.name, takerFee: i.main.takerFee, halfSpread: hs, minOrderUsd: i.main.minNotional };
  const leaderRate = L.takerFee + (L.halfSpread ?? hs);
  const rows: BudgetRow[] = [];
  let sigs = 0;
  let leaderTraded = 0;
  for (const s of list) {
    const c = s.cost(i.U);
    sigs += c.walletSignatures ?? 0;
    leaderTraded += c.leaderTakerUsd ?? 0;
    const fees = c.takerUsd * (i.main.takerFee + i.builderRate) + c.makerUsd * (maker + i.builderRate);
    const spread = c.takerUsd * hs;
    const leader = (c.leaderTakerUsd ?? 0) * leaderRate;
    const lost = c.lostUsd ?? 0;
    const lev = Math.max(1, Math.min(c.leverage ?? i.leverage, i.leverage));
    rows.push({
      id: s.id,
      section: s.section,
      traded: c.takerUsd + c.makerUsd,
      feesUsd: fees,
      spreadUsd: spread,
      leaderUsd: leader,
      lostUsd: lost,
      spentUsd: fees + spread + leader + lost,
      peakUsd: c.peakUsd,
      marginUsd: (c.peakUsd / lev) * buffer,
      leaderMarginUsd: ((c.leaderPeakUsd ?? 0) / i.leverage) * buffer,
      riskUsd: (c.peakUsd + (c.leaderPeakUsd ?? 0)) * risk,
    });
  }
  const bySection: Budget['bySection'] = {};
  for (const r of rows) {
    const b = (bySection[r.section] ??= { spentUsd: 0, peakMarginUsd: 0, leaderPeakMarginUsd: 0, traded: 0 });
    b.spentUsd += r.spentUsd;
    b.traded += r.traded;
    b.peakMarginUsd = Math.max(b.peakMarginUsd, r.marginUsd);
    b.leaderPeakMarginUsd = Math.max(b.leaderPeakMarginUsd, r.leaderMarginUsd);
  }
  const sum = (f: (r: BudgetRow) => number) => rows.reduce((x, r) => x + f(r), 0);
  const max = (f: (r: BudgetRow) => number) => rows.reduce((x, r) => Math.max(x, f(r)), 0);
  const spent = sum((r) => r.spentUsd);
  const peak = max((r) => r.marginUsd);
  const lpeak = max((r) => r.leaderMarginUsd);
  // A deposit that covers the (already buffered) peak margin, what is spent, and a round $10 of slack.
  const deposit = (m: number, spentPart: number) => (m > 0 ? Math.ceil((m + spentPart + 10) / 5) * 5 : 0);
  return {
    rows,
    bySection,
    total: {
      spentUsd: spent,
      feesUsd: sum((r) => r.feesUsd),
      spreadUsd: sum((r) => r.spreadUsd),
      leaderUsd: sum((r) => r.leaderUsd),
      lostUsd: sum((r) => r.lostUsd),
      leaderTraded,
      traded: sum((r) => r.traded),
      peakMarginUsd: peak,
      leaderPeakMarginUsd: lpeak,
      riskUsd: max((r) => r.riskUsd),
      depositFollowerUsd: deposit(peak, spent - sum((r) => r.leaderUsd)),
      depositLeaderUsd: deposit(lpeak, sum((r) => r.leaderUsd)),
      walletSignatures: sigs,
    },
    leaderWhere: L.venue === 'hyperliquid' ? 'Hyperliquid' : 'SoDEX',
    assumptions: [
      ...(L.venue === 'hyperliquid'
        ? [
            `the leader trades on Hyperliquid (${L.market}): taker ${(L.takerFee * 1e4).toFixed(2)} bp (its base tier), ${L.halfSpread !== null ? `half spread ${(L.halfSpread * 1e4).toFixed(3)} bp on its book now` : `its book not read: SoDEX's half spread used`}, no builder; its minimum order $${L.minOrderUsd}${i.U < L.minOrderUsd ? `: every leader order is raised to it (U is $${i.U})` : `, every leader order is at least U ($${i.U})`}; margin at the 2x the runner sets on its coins`,
          ]
        : []),
      `market ${i.main.name}: taker ${(i.main.takerFee * 1e4).toFixed(2)} bp, maker ${(maker * 1e4).toFixed(2)} bp, min order $${i.main.minNotional}, step ${i.main.stepSize}, tick ${i.main.tickSize} (SoDEX's public market list)`,
      `book now: bid ${i.book.bid} / ask ${i.book.ask}, half spread ${(hs * 1e4).toFixed(3)} bp`,
      `builder fee ${(i.builderRate * 1e4).toFixed(2)} bp on every follower order (${i.builderWhy ?? 'the copy ladder\'s top step: no 14-day volume known to a local executor'}); none on the leader's`,
      `every child order $${i.U} (SoDEX's minimum $${i.main.minNotional} plus headroom for a move during the scenario); "traded" counts opens and closes, the cleanup's close included`,
      `margin at ${i.leverage}x (the EEA cap and the copies' 2x; an algo that keeps SoDEX's default leverage needs less), x${buffer} buffer; peaks are per scenario (each ends flat)`,
      `price risk: a ${(risk * 100).toFixed(1)}% move on the largest scenario's exposure, either way (not a cost on average)`,
      'ETH-USD legs (baskets) are costed at the main market\'s fees (the same on SoDEX: 4 bp / 1.2 bp)',
      ...(rows.some((r) => r.lostUsd > 0)
        ? [
            `a liquidation scenario loses the position's isolated margin: costed at its bound (the most margin it waits with, 5% of the position), about $${(i.U / Math.max(1, i.main.maxLeverage)).toFixed(2)} when SoDEX lets the harness take it to ${i.main.maxLeverage}x (the market's maximum); SoDEX's takeover fill itself was fee-free in the one case the repository verified (docs/research/07-gaps-sodex-contract.md, G7); a further liquidation fee is not documented: unknown, not costed`,
          ]
        : []),
    ],
  };
}

const usd = (x: number) => `$${x.toFixed(x < 1 ? 4 : 2)}`;

export function formatBudget(b: Budget): string {
  const out: string[] = [];
  out.push('scenario                          traded    fees+builder  spread   leader   SPENT     peak exp.  margin');
  for (const r of b.rows) {
    out.push(`${r.id.padEnd(32)} ${usd(r.traded).padStart(8)} ${usd(r.feesUsd).padStart(12)} ${usd(r.spreadUsd).padStart(8)} ${usd(r.leaderUsd).padStart(8)} ${usd(r.spentUsd).padStart(9)} ${usd(r.peakUsd).padStart(10)} ${usd(r.marginUsd + r.leaderMarginUsd).padStart(8)}`);
  }
  out.push('');
  for (const [s, x] of Object.entries(b.bySection)) {
    out.push(`${s.padEnd(6)} traded ${usd(x.traded)}, spent ${usd(x.spentUsd)}, peak margin follower ${usd(x.peakMarginUsd)}, leader ${usd(x.leaderPeakMarginUsd)}`);
  }
  const t = b.total;
  out.push('');
  out.push(`(a) MONEY SPENT (gone): ${usd(t.spentUsd)}  = fees and builder ${usd(t.feesUsd)} + spread ${usd(t.spreadUsd)} + the leader's ${usd(t.leaderUsd)}${t.lostUsd > 0 ? ` + margin lost to liquidations at most ${usd(t.lostUsd)}` : ''}  on ${usd(t.traded)} traded (the leader's ${usd(t.leaderTraded)} on ${b.leaderWhere})`);
  out.push(`(b) PEAK MARGIN (held, returned): follower ${usd(t.peakMarginUsd)}, leader ${usd(t.leaderPeakMarginUsd)}`);
  out.push(`    deposit at least: follower ${usd(t.depositFollowerUsd)} on SoDEX, leader ${usd(t.depositLeaderUsd)} on ${b.leaderWhere} (the buffered peak, plus what is spent, plus $10)`);
  out.push(`    price risk while a position is open: about +/- ${usd(t.riskUsd)} on the largest scenario`);
  out.push(`    wallet signatures (free): ${t.walletSignatures} plus one key registration per wallet per run`);
  out.push('');
  out.push('assumptions:');
  for (const a of b.assumptions) out.push(`  - ${a}`);
  return out.join('\n');
}
