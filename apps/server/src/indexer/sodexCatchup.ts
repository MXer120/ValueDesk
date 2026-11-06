/**
 * SoDEX's source for the catch-up (tradeCatchup.ts). Measured 2026-11-06: 500 rows per market are all there is, 11 minutes back
 * on BTC to about 7.6 h on a quiet market, and nothing older exists anywhere, so each market is read at half its reach.
 *
 * A row counts as held when this run saw its id or the who-traded chunk holds the same time, price, size and both parties.
 * A market is read every 2 s at most, one at a time: about 300 calls an hour over all markets.
 */
import type { Print, SodexWsTrade } from './streams.js';
import { CATCHUP_LIMIT, RestReader, TradeCatchup, type ReadTrades } from './tradeCatchup.js';

export { CATCHUP_LIMIT, RestReader, WATCH_MS, type RestAnswer, type ReadTrades, type WatchState } from './tradeCatchup.js';

type Engine = 'perps' | 'spot';
interface Row extends SodexWsTrade { t?: number; T?: number }

export class SodexCatchup extends TradeCatchup<Row> {
  private readonly reader: RestReader | null;

  constructor(
    add: (rows: Row[]) => Print[],
    log: (line: string) => void,
    read?: ReadTrades,
    symbols?: (engine: Engine) => Promise<string[]>,
    now: () => number = Date.now,
  ) {
    const reader = read && symbols ? null : new RestReader();
    const readTrades = read ?? reader!.readTrades;
    const list = symbols ?? reader!.symbols;
    super({
      name: 'sodex',
      title: 'SoDEX',
      limit: CATCHUP_LIMIT,
      tickMs: 2_000,
      async markets() {
        const keys: string[] = [];
        for (const engine of ['perps', 'spot'] as const) for (const symbol of await list(engine)) keys.push(`${engine}|${symbol}`);
        return keys;
      },
      read(key) {
        const i = key.indexOf('|');
        return readTrades(key.slice(0, i) as Engine, key.slice(i + 1));
      },
      at: (r) => r.T,
      seq: (r) => r.t,
      label: (key) => key.slice(key.indexOf('|') + 1),
    }, add, log, now);
    this.reader = reader;
  }

  override stop(): void {
    super.stop();
    this.reader?.stop();
  }
}
