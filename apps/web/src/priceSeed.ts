/**
 * The order ticket's price box is seeded from the book when the market (or
 * Futures / Spot) changes: the book's best price arrives a moment after the
 * switch. A price the user set in that moment (typed, MID, a click in the book)
 * is theirs and stays. It was overwritten before: a price typed right after a
 * switch was replaced by the book's, and the order would have gone at a price
 * the user never typed.
 *
 * One switch can be several: Futures -> Spot changes the engine, then the market
 * falls back to the engine's default. They count as one, from the first, until
 * the book's answer settles it.
 */
export interface PriceSeeder {
  /** The user set the price. */
  typed(): void;
  /** The market changed: a seed is on its way (the first change of a chain counts). */
  start(): void;
  /** The book answered (or could not): whether its price goes in the box. Ends the switch. */
  settle(): boolean;
}

export function priceSeeder(): PriceSeeder {
  let seq = 0;
  let typedAt = 0;
  let pendingSince: number | null = null;
  return {
    typed() {
      typedAt = ++seq;
    },
    start() {
      if (pendingSince === null) pendingSince = ++seq;
    },
    settle() {
      const seed = pendingSince !== null && typedAt < pendingSince;
      pendingSince = null;
      return seed;
    },
  };
}
