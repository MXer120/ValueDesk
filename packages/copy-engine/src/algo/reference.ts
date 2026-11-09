/**
 * The Binance-led maker's outside price (MmSpec.ref): what the runtime reads of a reference venue, and the fair price
 * it makes of it.
 *
 *   fair = reference mid x basis,  basis = SoDEX's mid / the reference's mid, averaged with a half-life of BASIS_HALF_LIFE_MS
 *
 * The basis carries what differs between the two books for long (USD against USDT, funding, a contract's scale); the
 * reference's mid carries what moves first. On an executor the source is the box's shared feed (apps/executor/src/feed:
 * one process holds the Binance sockets, every reader the same ticks); tests pass a fake.
 */

export interface RefQuote {
  bid: number;
  ask: number;
  /** When it was received, ms since the epoch. */
  at: number;
}

export interface ReferenceSource {
  /** The SoDEX markets (ETH-USD) to follow; replaces the previous set. */
  watch(markets: readonly string[]): void;
  /** The newest quote for a market, or null (not carried, or none yet). */
  quote(market: string): RefQuote | null;
  /** Called on every new quote of a watched market, at once (the fast pull). */
  onQuote(cb: (market: string) => void): void;
}

export const BASIS_HALF_LIFE_MS = 30_000;
/** A reference quote older than this is no price: the maker holds instead of quoting off it. */
export const REF_MAX_AGE_MS = 2_000;
/**
 * A reference gap shorter than this keeps the maker's resting quotes and places nothing new; only a longer one holds
 * it and pulls them (owner 2026-11-09: MCD held ~312 times an hour for well under a second each, every hold pulling
 * and re-placing both quotes). The quotes rest at a fair price of at most this long ago.
 */
export const REF_GRACE_MS = 3_000;

/** One market's basis, from pairs of SoDEX and reference mids. */
export class FairBasis {
  private basis: number | null = null;
  private at = 0;

  /** A pair of mids seen at `now`. */
  update(sodexMid: number, refMid: number, now: number): void {
    if (!(sodexMid > 0) || !(refMid > 0)) return;
    const r = sodexMid / refMid;
    if (this.basis === null || !(now > this.at)) {
      if (this.basis === null) this.basis = r;
      this.at = Math.max(this.at, now);
      return;
    }
    this.basis += (1 - Math.pow(0.5, (now - this.at) / BASIS_HALF_LIFE_MS)) * (r - this.basis);
    this.at = now;
  }

  get ready(): boolean {
    return this.basis !== null;
  }

  /** The fair price for a reference mid (null before the first pair). */
  fair(refMid: number): number | null {
    return this.basis === null ? null : refMid * this.basis;
  }
}
