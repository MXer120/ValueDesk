/**
 * What the wallets on a venue's 30-day boards hold right now - from the index.
 *
 * The indexer keeps a book per wallet (`cohort_book`): read once, then moved
 * by the wallet's own prints on the venue's trade stream (cohortTracker.ts),
 * with the stream's last prices beside it (`cohort_mark`). So "what do the top
 * 100 and the lowest 100 by 30-day PnL hold" - the very rows the leaderboard
 * shows - is two board reads and a key lookup per wallet in a file this
 * process already has open. It costs no exchange request, whoever asks and
 * however often.
 *
 * That is what /api/vs/positioning answers from. It used to crawl ~200 account
 * states per venue from the API process itself: 1,000 SoDEX gateway weight or
 * 800 Hyperliquid weight a sweep, spent from the address the indexer shares,
 * whenever a visitor found the cache expired.
 *
 * Kept apart from read.ts on purpose: the venue providers import this, and the
 * indexer imports the providers.
 */
import type { Venue, VsPosition } from '../valuescan/types.js';
import { reader } from './reader.js';

export interface Holdings {
  /** One list of positions per board wallet the index holds a book for. */
  traders: VsPosition[][];
  /** Wallets on the two boards (one on both counts once). */
  tracked: number;
  /** How many of them have a book. */
  held: number;
  /** The newest of those books' last full read (ms). Stream prints move a book without moving this. */
  at: number;
}

/**
 * The positions of every wallet on `venue`'s 30-day top and worst boards.
 * `books`: the venues whose books make up such a wallet's account - its own,
 * and for Hyperliquid also `tradexyz` (the xyz dex is indexed as a venue of
 * its own; its symbols carry the `xyz:` prefix). `null` when the index is not
 * there or has no 30-day board for the venue yet.
 *
 * Notional is size x the stream's last price for the symbol, else x the
 * book's entry price - the same order the venue readers use.
 */
export function boardHoldings(venue: Venue, books: readonly Venue[] = [venue]): Holdings | null {
  const s = reader();
  if (!s) return null;
  try {
    const wallets = new Set<string>();
    let boards = 0;
    for (const side of ['top', 'worst'] as const) {
      const b = s.readBoard(venue, '30d', side, 'any');
      if (!b) continue;
      boards++;
      for (const r of b.rows) wallets.add(r.address);
    }
    if (!boards) return null;
    const marks = s.cohortMarks();
    const traders: VsPosition[][] = [];
    let at = 0;
    for (const address of wallets) {
      const positions: VsPosition[] = [];
      let found = false;
      for (const v of books) {
        const book = s.cohortBook(v, address);
        if (!book) continue;
        found = true;
        at = Math.max(at, book.at);
        for (const p of book.positions) {
          if (!p.szi) continue;
          const size = Math.abs(p.szi);
          const mark = marks.get(`${v}|${p.symbol}`) ?? null;
          positions.push({
            symbol: p.symbol,
            side: p.szi > 0 ? 'long' : 'short',
            size,
            notional: size * (mark ?? p.entry ?? 0),
            entryPx: p.entry,
            markPx: mark,
            liqPx: null,
            uPnl: mark !== null && p.entry !== null ? (mark - p.entry) * p.szi : null,
            leverage: null,
          });
        }
      }
      if (found) traders.push(positions.sort((a, b) => b.notional - a.notional));
    }
    return { traders, tracked: wallets.size, held: traders.length, at };
  } catch {
    return null;
  }
}
