/**
 * Before a copy starts: which of the trader's markets a copy cannot follow on SoDEX (owner,
 * 2026-10-29) - their open positions first, then the coins they traded lately - as one line,
 * with the list behind it (the copy setup and the trader page show it).
 *
 * The running copy's own rules (copy-engine markets.ts uncopyable): a market SoDEX lists none
 * for is skipped ('not-on-sodex'); a Hyperliquid market whose SoDEX namesake prices another
 * asset is held back ('different-asset') - said only on two fresh prices, the position's mark
 * from the trader's profile against SoDEX's mark read with it, so a coin traded lately is only
 * ever judged by the list. Spot is left out (a copy follows perps only). Nothing is said
 * before SoDEX's market list is in: a list not read says nothing about what SoDEX lists.
 */
import { MarketBook, isSpotSymbol, parseMarkets, uncopyable, type Uncopyable } from '@copy-engine';

export interface NotCopyableItem {
  /** The market as the trader's venue names it: 'PURR', 'kPEPE', 'xyz:TSLA'. */
  symbol: string;
  /** Why, in a few words. */
  why: string;
  /** An open position of the trader's (else a coin traded lately). */
  held: boolean;
}

export interface NotCopyable {
  /** "3 of 7 open positions can't be copied: PURR, HYPE and kPEPE aren't on SoDEX." - null when there is nothing to say. */
  line: string | null;
  items: NotCopyableItem[];
}

export interface NotCopyableInput {
  venue: 'sodex' | 'hyperliquid';
  /** The trader's open positions, as their profile lists them (null: not read). */
  positions: ReadonlyArray<{ symbol: string; markPx: number | null }> | null;
  /** When those positions and their marks were read (null: not known - no price is compared). */
  positionsAt: number | null;
  /** The trader's recent fills (null: not read). */
  fills: ReadonlyArray<{ symbol: string; time: number }> | null;
  /** SoDEX's perps market list, as GET /perps/markets/symbols answers it (null: not read). */
  markets: readonly unknown[] | null;
  /** SoDEX's perps marks and when they were read (null: not read). */
  marks: { at: number; rows: ReadonlyArray<{ symbol?: unknown; markPrice?: unknown }> } | null;
}

const NONE: NotCopyable = { line: null, items: [] };

/** 'PURR', 'PURR and HYPE', 'PURR, HYPE and kPEPE', 'PURR, HYPE, kPEPE and 2 more'. */
function names(list: readonly string[]): string {
  if (list.length <= 1) return list.join('');
  if (list.length <= 4) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
}

/** "PURR and HYPE aren't on SoDEX; xyz:QNT is another asset on SoDEX". */
function phrase(list: readonly Uncopyable[]): string {
  const off = list.filter((x) => x.reason === 'not-on-sodex').map((x) => x.symbol);
  const other = list.filter((x) => x.reason === 'different-asset').map((x) => x.symbol);
  const parts: string[] = [];
  if (off.length) parts.push(`${names(off)} ${off.length === 1 ? "isn't" : "aren't"} on SoDEX`);
  if (other.length) parts.push(`${names(other)} ${other.length === 1 ? 'is another asset' : 'are other assets'} on SoDEX`);
  return parts.join('; ');
}

const why = (x: Uncopyable): string =>
  x.reason === 'not-on-sodex' || !x.verdict
    ? 'not listed on SoDEX'
    : `${x.verdict.market} on SoDEX is another asset (priced ${(Math.abs(x.verdict.deviation) * 100).toFixed(1)}% apart)`;

/**
 * Whether a copy could trade this market of the trader's at all: SoDEX lists a market for it (the
 * running copy's own mapping). The backtest leaves out the fills it could not (owner, 2026-10-29),
 * so its result is what a live copy would do; null when SoDEX's list is not in (nothing is judged).
 */
export function copyableMarket(venue: NotCopyableInput['venue'], marketsRaw: readonly unknown[] | null): ((symbol: string) => boolean) | null {
  const markets = marketsRaw ? parseMarkets(marketsRaw) : [];
  if (!markets.length) return null;
  const book = new MarketBook();
  book.load(markets);
  return (symbol) => !isSpotSymbol(venue, symbol) && book.sodexMarketFor(venue, symbol) !== null;
}

/** The line and the list, from what the page already read. */
export function notCopyable(o: NotCopyableInput, now = Date.now()): NotCopyable {
  const markets = o.markets ? parseMarkets(o.markets) : [];
  if (!markets.length) return NONE;
  const book = new MarketBook();
  book.load(markets);
  let at = now;
  if (o.marks) {
    for (const r of o.marks.rows) {
      const p = Number(r.markPrice);
      if (typeof r.symbol === 'string' && p > 0) book.setMark(r.symbol, p, o.marks.at);
    }
    at = o.marks.at;
  }
  const positions = o.positions ?? [];
  if (o.positionsAt !== null && Number.isFinite(o.positionsAt)) {
    for (const p of positions) if (p.markPx !== null && p.markPx > 0) book.observeLeaderPrice(o.venue, p.symbol, p.markPx, o.positionsAt);
    at = Math.max(at, o.positionsAt);
  }
  const perp = (s: string) => !isSpotSymbol(o.venue, s);
  const held = [...new Set(positions.map((p) => p.symbol))].filter(perp);
  const recentAll = [...new Set([...(o.fills ?? [])].sort((a, b) => b.time - a.time).map((f) => f.symbol))].filter(perp);
  const recent = recentAll.filter((s) => !held.includes(s));
  const badHeld = uncopyable(o.venue, held, book, at);
  const badRecent = uncopyable(o.venue, recent, book, at);
  if (!badHeld.length && !badRecent.length) return NONE;
  const items: NotCopyableItem[] = [
    ...badHeld.map((x) => ({ symbol: x.symbol, why: why(x), held: true })),
    ...badRecent.map((x) => ({ symbol: x.symbol, why: why(x), held: false })),
  ];
  const n = held.length;
  if (badHeld.length) {
    const more = badRecent.length ? ` ${badRecent.length} more ${badRecent.length === 1 ? 'coin' : 'coins'} traded lately can't be either.` : '';
    return { line: `${badHeld.length} of ${n} open position${n === 1 ? '' : 's'} can't be copied: ${phrase(badHeld)}.${more}`, items };
  }
  const t = recentAll.length;
  return { line: `${badRecent.length} of the ${t} coin${t === 1 ? '' : 's'} traded lately can't be copied: ${phrase(badRecent)}.`, items };
}
