/**
 * Flattening: what every scenario ends with (also when it failed) and what
 * every start begins with, so a crash mid-scenario never leaves exposure.
 *
 * ORDER. First the executor is told to stop (the kill switch for algos, every
 * copy stopped with close), so nothing new is placed while the account is
 * being cleared. Then, straight on SoDEX with the harness's own key, on each
 * test market: every open order is cancelled (resting children, the exits and
 * copy stops SoDEX holds), the position is closed with a reduce-only IOC, and
 * the account is read again. That repeats until a read finds nothing - or the
 * attempts run out, and the cleanup says so loudly: the exposure flag stays
 * set and the runner stops.
 *
 * It is written against a small interface (FlattenVenue) so its rules are
 * tested without SoDEX (test/live-test-runner.test.ts).
 */
import type { RunState } from './state.ts';

export interface VenueOrder {
  orderId: string;
  clOrdID: string | null;
  /** A SoDEX stop (an exit or a copy's stop-loss / take-profit), not a resting limit. */
  stop: boolean;
}

export interface FlattenVenue {
  /** Which account (for the log): 'follower' / 'leader'. */
  readonly name: string;
  openOrders(symbol: string): Promise<VenueOrder[]>;
  /** Signed base size; 0 when flat. A read that fails throws (unknown is never flat). */
  position(symbol: string): Promise<number>;
  cancel(symbol: string, orders: VenueOrder[]): Promise<void>;
  /** One reduce-only IOC for `size` (signed: the position to close). */
  close(symbol: string, size: number): Promise<void>;
}

export interface FlattenReport {
  ok: boolean;
  /** What was found and done, per account and market. */
  lines: string[];
  /** What is still there when it gave up. */
  left: Array<{ venue: string; symbol: string; position: number; orders: number }>;
  rounds: number;
}

export interface FlattenOptions {
  attempts?: number;
  /** Wait after a round's cancels and closes before reading again (SoDEX's reads lag a write by a moment). */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Base-unit sizes below this count as flat (dust after rounding). */
  dust?: (symbol: string) => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cancel every open order and close every position on `symbols` of every
 * venue, then read again; repeat until nothing is left or `attempts` rounds
 * have run. A failing read or write in a round is reported and tried again in
 * the next one; it never ends the cleanup early.
 */
export async function flatten(venues: readonly FlattenVenue[], symbols: readonly string[], o: FlattenOptions = {}): Promise<FlattenReport> {
  const attempts = o.attempts ?? 6;
  const sleep = o.sleep ?? realSleep;
  const pause = o.pauseMs ?? 1_500;
  const dust = o.dust ?? (() => 0);
  const lines: string[] = [];
  let left: FlattenReport['left'] = [];
  for (let round = 1; round <= attempts; round++) {
    left = [];
    let acted = false;
    for (const v of venues) {
      for (const sym of symbols) {
        let orders: VenueOrder[] | null = null;
        let pos: number | null = null;
        try {
          orders = await v.openOrders(sym);
        } catch (e) {
          lines.push(`round ${round}: ${v.name} ${sym}: open orders could not be read (${short(e)})`);
        }
        try {
          pos = await v.position(sym);
        } catch (e) {
          lines.push(`round ${round}: ${v.name} ${sym}: the position could not be read (${short(e)})`);
        }
        const flatPos = pos !== null && Math.abs(pos) <= dust(sym);
        if (orders === null || pos === null || orders.length || !flatPos) {
          left.push({ venue: v.name, symbol: sym, position: pos ?? NaN, orders: orders?.length ?? NaN });
        }
        if (orders?.length) {
          acted = true;
          lines.push(`round ${round}: ${v.name} ${sym}: cancelling ${orders.length} order(s) (${orders.filter((x) => x.stop).length} stop(s))`);
          try {
            await v.cancel(sym, orders);
          } catch (e) {
            lines.push(`round ${round}: ${v.name} ${sym}: cancel failed (${short(e)})`);
          }
        }
        if (pos !== null && !flatPos) {
          acted = true;
          lines.push(`round ${round}: ${v.name} ${sym}: closing a position of ${pos}`);
          try {
            await v.close(sym, pos);
          } catch (e) {
            lines.push(`round ${round}: ${v.name} ${sym}: close failed (${short(e)})`);
          }
        }
      }
    }
    if (!left.length) return { ok: true, lines, left, rounds: round };
    if (acted || round < attempts) await sleep(pause * Math.min(round, 4));
  }
  return { ok: false, lines, left, rounds: attempts };
}

const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * What the start-up cleanup does with what it finds on the test markets:
 *
 *   flatten  the state says a live order may be out (a crash, an interrupted
 *            scenario, an unreadable state file), or `--adopt` was given: clear it;
 *   clean    nothing there: go on;
 *   refuse   positions or orders are there that this runner never recorded
 *            sending: they may be the owner's own trades, so nothing is touched
 *            and the runner stops with what it found (--adopt clears them).
 */
export function startDecision(exposure: RunState['exposure'], found: { orders: number; positions: number }, adopt: boolean): 'flatten' | 'clean' | 'refuse' {
  const any = found.orders > 0 || found.positions > 0;
  if (exposure || adopt) return any || exposure ? 'flatten' : 'clean';
  return any ? 'refuse' : 'clean';
}
