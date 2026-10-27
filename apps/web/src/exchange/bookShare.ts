/**
 * The order book the page already holds, by market, for a panel that wants a
 * first copy without a read of its own.
 *
 * The book panel's shared feed (Market.tsx useOrderBook: REST depth + the
 * l2Book stream, about two pushes a second) sets the book here while it runs
 * and clears it when it closes. The ticket's depth (OrderEntry.tsx) used to
 * open with its own 100-level REST read every time its market changed, while
 * the panel beside it held a fresher, deeper copy of the same book; it takes
 * that copy first now, and reads REST only when no feed is running.
 *
 * Its own module, not an export of Market.tsx, so the ticket does not pull the
 * market panels' code in with it.
 */
import type { Engine, OrderBook } from '../api';

const books = new Map<string, OrderBook>();
const keyOf = (engine: Engine, symbol: string): string => `${engine}:${symbol}`;

/** The running feed's current book for the market (null: closed it). */
export function shareBook(engine: Engine, symbol: string, book: OrderBook | null): void {
  if (book) books.set(keyOf(engine, symbol), book);
  else books.delete(keyOf(engine, symbol));
}

/** The book a running feed holds for the market, at most `levels` a side; null when none runs. */
export function sharedBook(engine: Engine, symbol: string, levels: number): OrderBook | null {
  const b = books.get(keyOf(engine, symbol));
  if (!b || (!b.bids?.length && !b.asks?.length)) return null;
  return { ...b, bids: (b.bids ?? []).slice(0, levels), asks: (b.asks ?? []).slice(0, levels) };
}
