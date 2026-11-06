/**
 * SODEX'S OWN RECENT TRADES, COMPARED WITH WHAT IS HELD. Whatever loses a print (a frozen socket, a restart, a reconnect),
 * this adds it back while SoDEX still serves it. Measured 2026-11-06: 500 rows per market are all there is, 11 minutes back
 * on BTC to about 7.6 h on a quiet market, and nothing older exists anywhere, so each market is read at half its reach.
 *
 * It adds only what is missing: a row counts as held when this run saw its id or the who-traded chunk holds the same time,
 * price, size and both parties. Activity and who traded take every print together, so what the chunk holds they hold.
 * A market is read every 2 s at most, one at a time: about 300 calls an hour over all markets.
 */
import { NET } from '../config.js';
import type { Print, SodexWsTrade } from './streams.js';
import { sodexSymbols } from './streams.js';

export const CATCHUP_LIMIT = 500;
const TICK_MS = 2_000;
const MIN_EVERY_MS = 3 * 60_000;
const MAX_EVERY_MS = 30 * 60_000;
const SYMBOLS_EVERY_MS = 60 * 60_000;
const LIMITED_MS = 5 * 60_000;
/** Newer rows are the stream's to deliver: they are looked at on the next read. */
const STREAM_FIRST_MS = 20_000;

type Engine = 'perps' | 'spot';
interface Market { engine: Engine; symbol: string; nextAt: number; newest?: number }
interface Row extends SodexWsTrade { t?: number; T?: number }

export type ReadTrades = (engine: Engine, symbol: string) => Promise<{ rows: Row[]; limited?: boolean }>;

const readTrades: ReadTrades = async (engine, symbol) => {
  const res = await fetch(`${NET.restBase}/api/v1/${engine}/markets/${encodeURIComponent(symbol)}/trades?limit=${CATCHUP_LIMIT}`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 429) return { rows: [], limited: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { data?: unknown };
  return { rows: Array.isArray(j.data) ? (j.data as Row[]) : [] };
};

export class SodexCatchup {
  private markets = new Map<string, Market>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private limitedUntil = 0;
  private symbolsAt = -Infinity;
  private stats = { reads: 0, added: 0, beyondReach: 0, errors: 0, lastAddedAt: 0, lastError: null as string | null };

  constructor(
    private readonly add: (rows: Row[]) => Print[],
    private readonly log: (line: string) => void,
    private readonly read: ReadTrades = readTrades,
    private readonly symbols: (engine: Engine) => Promise<string[]> = sodexSymbols,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): { markets: number; reads: number; added: number; beyondReach: number; errors: number; lastAddedAt: number; lastError: string | null } {
    return { markets: this.markets.size, ...this.stats };
  }

  /** One step. Public for tests. */
  async tick(): Promise<void> {
    const now = this.now();
    if (this.busy || now < this.limitedUntil) return;
    this.busy = true;
    try {
      if (now - this.symbolsAt >= SYMBOLS_EVERY_MS) await this.refreshSymbols(now);
      let due: Market | null = null;
      for (const m of this.markets.values()) if (m.nextAt <= now && (!due || m.nextAt < due.nextAt)) due = m;
      if (due) await this.readOne(due);
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = String((e as Error)?.message ?? e).slice(0, 160);
    } finally {
      this.busy = false;
    }
  }

  private async refreshSymbols(now: number): Promise<void> {
    this.symbolsAt = now;
    for (const engine of ['perps', 'spot'] as const) {
      for (const symbol of await this.symbols(engine)) {
        const k = `${engine}|${symbol}`;
        if (!this.markets.has(k)) this.markets.set(k, { engine, symbol, nextAt: now });
      }
    }
  }

  private async readOne(m: Market): Promise<void> {
    const now = this.now();
    // Whatever happens, this market waits its turn: one that fails does not hold up the others.
    m.nextAt = now + MIN_EVERY_MS;
    const { rows, limited } = await this.read(m.engine, m.symbol);
    if (limited) {
      this.limitedUntil = now + LIMITED_MS;
      this.stats.lastError = 'SoDEX said 429';
      return;
    }
    this.stats.reads++;
    const sorted = rows.filter((r) => typeof r.t === 'number' && typeof r.T === 'number').sort((a, b) => a.t! - b.t!);
    if (!sorted.length) { m.nextAt = now + MAX_EVERY_MS; return; }
    const oldest = sorted[0]!;
    const newest = sorted[sorted.length - 1]!;
    // Trade ids run without a hole per market, so what fell out of reach since the last read can be counted.
    if (m.newest !== undefined && oldest.t! > m.newest + 1) {
      this.stats.beyondReach += oldest.t! - m.newest - 1;
      this.log(`sodex catch-up: ${m.symbol}: ${oldest.t! - m.newest - 1} trades went out of SoDEX's reach before they were read`);
    }
    m.newest = newest.t!;
    const added = this.add(sorted.filter((r) => now - r.T! >= STREAM_FIRST_MS));
    if (added.length) {
      this.stats.added += added.length;
      this.stats.lastAddedAt = now;
      this.log(`sodex catch-up: ${m.symbol}: added ${added.length} of ${sorted.length} (the oldest ${Math.round((now - added[0]!.t) / 60_000)} min old)`);
    }
    const reach = sorted.length >= CATCHUP_LIMIT ? newest.T! - oldest.T! : Infinity;
    m.nextAt = now + Math.max(MIN_EVERY_MS, Math.min(MAX_EVERY_MS, reach / 2));
  }
}
