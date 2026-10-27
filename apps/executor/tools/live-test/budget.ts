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
 *                   (the leader's orders carry no builder);
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
  /** Leverage a peak is held at unless the scenario says otherwise (EEA and the copies' 2x: 2). */
  leverage: number;
  /** Indicative move while a position is held (a fraction), for the plus-or-minus. */
  riskMove?: number;
  /** Margin buffer over the peak (1.5 = 50% more). */
  buffer?: number;
}

export interface BudgetRow {
  id: string;
  section: string;
  traded: number;
  feesUsd: number;
  spreadUsd: number;
  leaderUsd: number;
  spentUsd: number;
  peakUsd: number;
  marginUsd: number;
  leaderMarginUsd: number;
  riskUsd: number;
}

export interface Budget {
  rows: BudgetRow[];
  bySection: Record<string, { spentUsd: number; peakMarginUsd: number; leaderPeakMarginUsd: number; traded: number }>;
  total: { spentUsd: number; feesUsd: number; spreadUsd: number; leaderUsd: number; traded: number; peakMarginUsd: number; leaderPeakMarginUsd: number; riskUsd: number; depositFollowerUsd: number; depositLeaderUsd: number; walletSignatures: number };
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

export function computeBudget(list: readonly Scenario[], i: BudgetInput): Budget {
  const hs = halfSpreadFrac(i.book);
  const maker = i.main.makerFee ?? i.main.takerFee;
  const buffer = i.buffer ?? 1.5;
  const risk = i.riskMove ?? 0.005;
  const rows: BudgetRow[] = [];
  let sigs = 0;
  for (const s of list) {
    const c = s.cost(i.U);
    sigs += c.walletSignatures ?? 0;
    const fees = c.takerUsd * (i.main.takerFee + i.builderRate) + c.makerUsd * (maker + i.builderRate);
    const spread = c.takerUsd * hs;
    const leader = (c.leaderTakerUsd ?? 0) * (i.main.takerFee + hs);
    const lev = Math.max(1, Math.min(c.leverage ?? i.leverage, i.leverage));
    rows.push({
      id: s.id,
      section: s.section,
      traded: c.takerUsd + c.makerUsd,
      feesUsd: fees,
      spreadUsd: spread,
      leaderUsd: leader,
      spentUsd: fees + spread + leader,
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
      traded: sum((r) => r.traded),
      peakMarginUsd: peak,
      leaderPeakMarginUsd: lpeak,
      riskUsd: max((r) => r.riskUsd),
      depositFollowerUsd: deposit(peak, spent - sum((r) => r.leaderUsd)),
      depositLeaderUsd: deposit(lpeak, sum((r) => r.leaderUsd)),
      walletSignatures: sigs,
    },
    assumptions: [
      `market ${i.main.name}: taker ${(i.main.takerFee * 1e4).toFixed(2)} bp, maker ${(maker * 1e4).toFixed(2)} bp, min order $${i.main.minNotional}, step ${i.main.stepSize}, tick ${i.main.tickSize} (SoDEX's public market list)`,
      `book now: bid ${i.book.bid} / ask ${i.book.ask}, half spread ${(hs * 1e4).toFixed(3)} bp`,
      `builder fee ${(i.builderRate * 1e4).toFixed(2)} bp on every follower order (the copy ladder's top step: no 14-day volume known to a local executor); none on the leader's`,
      `every child order $${i.U} (SoDEX's minimum $${i.main.minNotional} plus headroom for a move during the scenario); "traded" counts opens and closes, the cleanup's close included`,
      `margin at ${i.leverage}x (the EEA cap and the copies' 2x; an algo that keeps SoDEX's default leverage needs less), x${buffer} buffer; peaks are per scenario (each ends flat)`,
      `price risk: a ${(risk * 100).toFixed(1)}% move on the largest scenario's exposure, either way (not a cost on average)`,
      'ETH-USD legs (baskets) are costed at the main market\'s fees (the same on SoDEX: 4 bp / 1.2 bp)',
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
  out.push(`(a) MONEY SPENT (gone): ${usd(t.spentUsd)}  = fees and builder ${usd(t.feesUsd)} + spread ${usd(t.spreadUsd)} + the leader's ${usd(t.leaderUsd)}  on ${usd(t.traded)} traded`);
  out.push(`(b) PEAK MARGIN (held, returned): follower ${usd(t.peakMarginUsd)}, leader ${usd(t.leaderPeakMarginUsd)}`);
  out.push(`    deposit at least: follower ${usd(t.depositFollowerUsd)}, leader ${usd(t.depositLeaderUsd)} (the buffered peak, plus what is spent, plus $10)`);
  out.push(`    price risk while a position is open: about +/- ${usd(t.riskUsd)} on the largest scenario`);
  out.push(`    wallet signatures (free): ${t.walletSignatures} plus one key registration per wallet per run`);
  out.push('');
  out.push('assumptions:');
  for (const a of b.assumptions) out.push(`  - ${a}`);
  return out.join('\n');
}
