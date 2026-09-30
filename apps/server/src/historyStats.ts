/**
 * All-time totals over a wallet's walked history: pure (no Node, no DOM, no
 * fetch), shared by the server's Stats route (through history.ts, which
 * re-exports all of it) and the browser's own history walk.
 *
 * FEES ARE PER-COIN, NOT DOLLARS. Over a thousand live spot fills, every BUY was
 * charged in the base coin (WSOSO, vAVAX, vARB...) and every SELL in vUSDC.
 * Summing those into a single "$" figure would be arithmetic on unrelated units.
 * Every fee and funding total here is therefore a bucket keyed by coin, and stays
 * one all the way to the screen.
 *
 * Amounts are accumulated as exact decimal strings (see DecimalSum), not floats:
 * these are money totals over tens of thousands of rows, and the repo already
 * pays for exact decimal handling everywhere else.
 */
import { canonicalDecimal } from './decimal.js';
import { mulDecimal } from './sodex/decimalMath.js';
import type { NormalRow } from './historyRows.js';

// --- exact decimal accumulation ---------------------------------------------

/**
 * Sums decimal STRINGS exactly, by keeping a bigint of scaled units and growing
 * the scale to whatever the widest value seen needs.
 *
 * Floats would be roughly fine for display, but "roughly fine" on a fee total is
 * how a trading screen starts lying quietly. `canonicalDecimal` already exists to
 * keep decimals off the float path; this keeps them off it while adding up too.
 */
export class DecimalSum {
  private scale = 0;
  private units = 0n;
  private n = 0;

  /** Number of values that were actually readable and added. */
  get count(): number {
    return this.n;
  }

  /** Returns false (and adds nothing) for a missing or unparseable value. */
  add(value: string | number | undefined | null): boolean {
    if (value === undefined || value === null || value === '') return false;
    let c: string;
    try {
      c = canonicalDecimal(value);
    } catch {
      return false;
    }
    const neg = c.startsWith('-');
    const body = neg ? c.slice(1) : c;
    const dot = body.indexOf('.');
    const intPart = dot < 0 ? body : body.slice(0, dot);
    const fracPart = dot < 0 ? '' : body.slice(dot + 1);

    if (fracPart.length > this.scale) {
      this.units *= 10n ** BigInt(fracPart.length - this.scale);
      this.scale = fracPart.length;
    }
    const digits = BigInt(intPart + fracPart.padEnd(this.scale, '0'));
    this.units += neg ? -digits : digits;
    this.n++;
    return true;
  }

  toString(): string {
    if (this.scale === 0) return this.units.toString();
    const neg = this.units < 0n;
    const raw = (neg ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const s = raw.slice(0, raw.length - this.scale) + '.' + raw.slice(raw.length - this.scale);
    return canonicalDecimal((neg ? '-' : '') + s);
  }
}

// --- aggregation -------------------------------------------------------------

export interface CoinTotal {
  coin: string | null;
  amount: string;
  count: number;
}

export interface SymbolTotal {
  symbol: string;
  count: number;
  volume: string | null;
  volumeCoin: string | null;
}

export interface TradeStats {
  count: number;
  firstTime: number | null;
  lastTime: number | null;
  /** Per-coin, never summed together. `coin: null` means the venue did not label it. */
  fees: CoinTotal[];
  /** Notional per quote coin. */
  volume: CoinTotal[];
  volumeSource: { reported: number; derived: number; unavailable: number };
  /** Fee tiers differ maker vs taker, so the split is the context for the fees above. */
  liquidity: { maker: number; taker: number; unknown: number };
  bySymbol: SymbolTotal[];
  /** Rows whose fee had a value but no coin label. */
  feeCoinUnlabelled: number;
  /** Rows we could not read a fee or a notional from at all. */
  unreadable: { fee: number; volume: number };
}

export interface FundingStats {
  count: number;
  firstTime: number | null;
  lastTime: number | null;
  totals: CoinTotal[];
  feeCoinUnlabelled: number;
  bySymbol: SymbolTotal[];
}

const sortedTotals = (m: Map<string | null, DecimalSum>): CoinTotal[] =>
  [...m.entries()]
    .map(([coin, sum]) => ({ coin, amount: sum.toString(), count: sum.count }))
    .sort((a, b) => b.count - a.count);

/**
 * Fill totals. `quotes` maps symbol -> quote coin, so notional is bucketed by
 * the unit it is actually denominated in; a symbol it cannot resolve buckets
 * under `null` rather than being folded into whichever coin is most common.
 */
export function aggregateTradeRows(quotes: ReadonlyMap<string, string>, rows: NormalRow[]): TradeStats {
  const fees = new Map<string | null, DecimalSum>();
  const volume = new Map<string | null, DecimalSum>();
  const perSymbol = new Map<string, { count: number; sum: DecimalSum; coin: string | null }>();

  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let feeCoinUnlabelled = 0;
  let unreadableFee = 0;
  let unreadableVolume = 0;
  const source = { reported: 0, derived: 0, unavailable: 0 };
  const liquidity = { maker: 0, taker: 0, unknown: 0 };

  for (const r of rows) {
    if (Number.isFinite(r.time)) {
      if (firstTime === null || r.time < firstTime) firstTime = r.time;
      if (lastTime === null || r.time > lastTime) lastTime = r.time;
    }
    if (r.isMaker === null) liquidity.unknown++;
    else if (r.isMaker) liquidity.maker++;
    else liquidity.taker++;

    // -- fees, bucketed by the coin they were charged in --------------------
    if (r.fee !== null) {
      const key = r.feeCoin;
      if (key === null) feeCoinUnlabelled++;
      let bucket = fees.get(key);
      if (!bucket) fees.set(key, (bucket = new DecimalSum()));
      if (!bucket.add(r.fee)) unreadableFee++;
    }

    // -- notional -----------------------------------------------------------
    // Prefer a reported quote quantity; fall back to an EXACT price x quantity
    // (mulDecimal, no float), and record which of the two produced the number so
    // the panel can label the volume figure as derived where it is.
    let notional: string | null = null;
    if (r.quote !== null) {
      notional = r.quote;
      source.reported++;
    } else if (r.price !== null && r.qty !== null) {
      try {
        notional = mulDecimal(r.price, r.qty);
        source.derived++;
      } catch {
        source.unavailable++;
        unreadableVolume++;
      }
    } else {
      source.unavailable++;
    }

    const coin = r.symbol ? (quotes.get(r.symbol) ?? null) : null;
    if (notional !== null) {
      let bucket = volume.get(coin);
      if (!bucket) volume.set(coin, (bucket = new DecimalSum()));
      bucket.add(notional);
    }

    if (r.symbol) {
      let s = perSymbol.get(r.symbol);
      if (!s) perSymbol.set(r.symbol, (s = { count: 0, sum: new DecimalSum(), coin }));
      s.count++;
      if (notional !== null) s.sum.add(notional);
    }
  }

  return {
    count: rows.length,
    firstTime,
    lastTime,
    fees: sortedTotals(fees),
    volume: sortedTotals(volume),
    volumeSource: source,
    liquidity,
    bySymbol: [...perSymbol.entries()]
      .map(([symbol, s]) => ({
        symbol,
        count: s.count,
        volume: s.sum.count > 0 ? s.sum.toString() : null,
        volumeCoin: s.coin,
      }))
      .sort((a, b) => b.count - a.count),
    feeCoinUnlabelled,
    unreadable: { fee: unreadableFee, volume: unreadableVolume },
  };
}

/** The symbol -> quote coin map `aggregateTradeRows` wants, from a symbol list. */
export function quoteCoinMap(list: ReadonlyArray<{ name?: string; quoteCoin?: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of list) {
    if (s.name && s.quoteCoin) out.set(s.name, s.quoteCoin);
  }
  return out;
}

export function aggregateFunding(rows: NormalRow[]): FundingStats {
  const totals = new Map<string | null, DecimalSum>();
  const perSymbol = new Map<string, { count: number; sum: DecimalSum; coin: string | null }>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let feeCoinUnlabelled = 0;

  for (const r of rows) {
    if (Number.isFinite(r.time)) {
      if (firstTime === null || r.time < firstTime) firstTime = r.time;
      if (lastTime === null || r.time > lastTime) lastTime = r.time;
    }
    if (r.fee === null) continue;
    if (r.feeCoin === null) feeCoinUnlabelled++;

    // Summed with the venue's own sign. We do not flip it to a "paid/received"
    // convention of our own invention - the record does not say which it means.
    let bucket = totals.get(r.feeCoin);
    if (!bucket) totals.set(r.feeCoin, (bucket = new DecimalSum()));
    bucket.add(r.fee);

    if (r.symbol) {
      let s = perSymbol.get(r.symbol);
      if (!s) perSymbol.set(r.symbol, (s = { count: 0, sum: new DecimalSum(), coin: r.feeCoin }));
      s.count++;
      s.sum.add(r.fee);
    }
  }

  return {
    count: rows.length,
    firstTime,
    lastTime,
    totals: sortedTotals(totals),
    feeCoinUnlabelled,
    bySymbol: [...perSymbol.entries()]
      .map(([symbol, s]) => ({
        symbol,
        count: s.count,
        volume: s.sum.count > 0 ? s.sum.toString() : null,
        volumeCoin: s.coin,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
