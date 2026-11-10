/**
 * THE MARKET CONDITIONS BOARD'S OWN TAPE (owner 2026-11-10: "the board needs to always work - although it is on the
 * indexer it should be as unaffected as possible by issues there"). The API process keeps one SoDEX perps trade socket of
 * its own and sums every minute of every market as the board needs it: taker volume, 1002's and 23342's, and the mid at
 * the minute's end. The indexer, its writer and its flow file are not involved, so when the indexer stalls, lags or
 * restarts, the board fills its newest minutes from here (botMarkets.ts tailPass: a minute the flow does not hold whole).
 *
 * HELD: a minute is the tape's only when its socket was up and delivering for the whole minute (the indexer's rule:
 * on SoDEX only a trade proves the feed, streams.ts SODEX_DATA_SILENT_MS). It keeps TAPE_MINUTES (12 h), the span the
 * flow's ledger catch-up still repairs; older minutes are the flow's. Written to a small file every few minutes, so an
 * API restart keeps what it had.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NET } from '../config.js';
import { LiveSocket, sodexPrint, type SodexWsTrade } from '../indexer/streams.js';
import { defaultFlowPath } from './store.js';
import { takerClasses } from './takerClass.js';

export const TAPE_MINUTES = 12 * 60;
const SAVE_EVERY_MS = 5 * 60_000;
const SYMBOLS_EVERY_MS = 60 * 60_000;
const PAIR_MS = 10_000;
/** SoDEX's own account ids (the flow keeps its own party ids; the tape reads SoDEX's). */
const ID_1002 = '1002';
const ID_23342 = '23342';

/** inf / uni: the other takers classed informed / uninformed (takerClass.ts) when the trade came. */
export interface TapeMinute { tot: number; u: number; f: number; inf: number; uni: number; mid: number }

interface MarketTape {
  /** Minute index (ms / 60 000) each slot holds; slot = minute % TAPE_MINUTES. */
  at: Float64Array;
  tot: Float64Array; u: Float64Array; f: Float64Array; inf: Float64Array; uni: Float64Array; mid: Float64Array;
  lastBuy: number; lastBuyT: number; lastSell: number; lastSellT: number;
}

const newMarket = (): MarketTape => ({
  at: new Float64Array(TAPE_MINUTES).fill(-1),
  tot: new Float64Array(TAPE_MINUTES), u: new Float64Array(TAPE_MINUTES), f: new Float64Array(TAPE_MINUTES), inf: new Float64Array(TAPE_MINUTES), uni: new Float64Array(TAPE_MINUTES), mid: new Float64Array(TAPE_MINUTES).fill(NaN),
  lastBuy: NaN, lastBuyT: -Infinity, lastSell: NaN, lastSellT: -Infinity,
});

export class BoardTape {
  private markets = new Map<string, MarketTape>();
  /** Minutes the socket was up and delivering from start to end. */
  private held = new Set<number>();
  private socket: LiveSocket | null = null;
  private timers: NodeJS.Timeout[] = [];
  private symbols: string[] = [];
  private lastTradeAt = 0;
  /** When the socket last came up (and has been delivering since). */
  private upFrom: number | null = null;

  constructor(private readonly file: string | null = defaultTapeFile()) {}

  /** One trade (exported for tests): summed into its market's minute, and the mid moved as the indexer's analysis does. */
  add(t: SodexWsTrade): void {
    const p = sodexPrint(t);
    if (!p) return;
    this.lastTradeAt = Date.now();
    let m = this.markets.get(p.symbol);
    if (!m) this.markets.set(p.symbol, (m = newMarket()));
    const min = Math.floor(p.t / 60_000);
    const i = min % TAPE_MINUTES;
    if (m.at[i] !== min) { m.at[i] = min; m.tot[i] = 0; m.u[i] = 0; m.f[i] = 0; m.inf[i] = 0; m.uni[i] = 0; m.mid[i] = NaN; }
    if (p.taker === 'buyer') { m.lastBuy = p.px; m.lastBuyT = p.t; } else if (p.taker === 'seller') { m.lastSell = p.px; m.lastSellT = p.t; }
    m.mid[i] = Math.abs(m.lastBuyT - m.lastSellT) < PAIR_MS ? (m.lastBuy + m.lastSell) / 2 : p.px;
    if (!p.taker) return;
    const ntl = p.px * p.sz;
    m.tot[i] = m.tot[i]! + ntl;
    const who = p.taker === 'buyer' ? p.buyer : p.seller;
    if (who === ID_1002) m.u[i] = m.u[i]! + ntl;
    else if (who === ID_23342) m.f[i] = m.f[i]! + ntl;
    else if (who) {
      const c = takerClasses();
      if (c.infKeys.has(who)) m.inf[i] = m.inf[i]! + ntl;
      else if (c.uniKeys.has(who)) m.uni[i] = m.uni[i]! + ntl;
    }
  }

  /** Called at each minute's end (exported for tests): the minute is held when the feed was up and delivering throughout. */
  closeMinute(minute: number, now = Date.now()): void {
    const up = this.socket?.upSince ?? this.upFrom;
    const delivering = now - this.lastTradeAt < 90_000;
    if (up !== null && up !== undefined && up <= minute * 60_000 && delivering) this.held.add(minute);
    const old = minute - TAPE_MINUTES;
    for (const x of this.held) if (x <= old) this.held.delete(x);
  }

  /** Mark the feed up from `t` (tests; the live socket reports its own). */
  markUp(t: number | null): void {
    this.upFrom = t;
  }

  /** A minute of a market, when the tape held it (no trade in a held minute is a quiet minute: zeros, mid carried). */
  minute(symbol: string, minute: number): TapeMinute | null {
    if (!this.held.has(minute)) return null;
    const m = this.markets.get(symbol);
    const i = minute % TAPE_MINUTES;
    if (!m || m.at[i] !== minute) return { tot: 0, u: 0, f: 0, inf: 0, uni: 0, mid: NaN };
    return { tot: m.tot[i]!, u: m.u[i]!, f: m.f[i]!, inf: m.inf[i]!, uni: m.uni[i]!, mid: m.mid[i]! };
  }

  /** Whether the tape holds this minute at all. */
  holds(minute: number): boolean {
    return this.held.has(minute);
  }

  start(): void {
    if (this.socket) return;
    this.load();
    this.socket = new LiveSocket(
      `${NET.wsBase}/ws/perps`,
      JSON.stringify({ op: 'ping' }),
      async (send) => {
        await this.readSymbols().catch(() => undefined);
        if (this.symbols.length) send({ op: 'subscribe', params: { channel: 'trade', symbols: this.symbols } });
      },
      (msg) => {
        const m = msg as { channel?: string; data?: unknown };
        if (m?.channel === 'trade' && Array.isArray(m.data)) for (const t of m.data as SodexWsTrade[]) this.add(t);
      },
      { name: 'board-tape', isData: (msg) => (msg as { channel?: unknown } | null)?.channel === 'trade', dataSilentMs: 90_000 },
    );
    this.socket.start();
    // Each minute's end: hold it or not. Aligned to the minute (a second past it, so its last trades are in).
    const tick = (): void => {
      const now = Date.now();
      this.closeMinute(Math.floor(now / 60_000) - 1, now);
      this.timers[0] = setTimeout(tick, 60_000 - (now % 60_000) + 1_000);
      this.timers[0].unref?.();
    };
    this.timers[0] = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 1_000);
    this.timers[1] = setInterval(() => this.save(), SAVE_EVERY_MS);
    this.timers[2] = setInterval(() => void this.readSymbols().then((changed) => { if (changed && this.socket) { this.socket.stop(); this.socket.start(); } }).catch(() => undefined), SYMBOLS_EVERY_MS);
    for (const t of this.timers) t?.unref?.();
  }

  stop(): void {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    this.socket?.stop();
    this.socket = null;
    this.save();
  }

  private async readSymbols(): Promise<boolean> {
    const res = await fetch(`${NET.restBase}/api/v1/perps/markets/symbols`, { signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { data?: unknown };
    const list = Array.isArray(j.data) ? j.data : ((j.data as { symbols?: unknown[] } | undefined)?.symbols ?? []);
    const names = (list as Array<{ symbol?: string; name?: string }>).flatMap((s) => (typeof (s.symbol ?? s.name) === 'string' ? [String(s.symbol ?? s.name)] : []));
    if (!names.length) return false;
    const changed = names.length !== this.symbols.length || names.some((n, i) => n !== this.symbols[i]);
    this.symbols = names;
    return changed;
  }

  /** The last TAPE_MINUTES to a file (atomically), so a restart keeps them. */
  save(): void {
    if (!this.file) return;
    try {
      const out: Record<string, number[][]> = {};
      for (const [sym, m] of this.markets) {
        const rows: number[][] = [];
        for (let i = 0; i < TAPE_MINUTES; i++) if (m.at[i]! >= 0) rows.push([m.at[i]!, m.tot[i]!, m.u[i]!, m.f[i]!, Number.isFinite(m.mid[i]!) ? m.mid[i]! : 0, m.inf[i]!, m.uni[i]!]);
        out[sym] = rows;
      }
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, gzipSync(JSON.stringify({ v: 2, held: [...this.held], markets: out })));
      renameSync(tmp, this.file);
    } catch { /* no disk: the tape lives in memory only */ }
  }

  private load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(gunzipSync(readFileSync(this.file)).toString('utf8')) as { v?: number; held?: number[]; markets?: Record<string, number[][]> };
      if (j.v !== 1 && j.v !== 2) return;
      const floor = Math.floor(Date.now() / 60_000) - TAPE_MINUTES;
      for (const x of j.held ?? []) if (x > floor) this.held.add(x);
      for (const [sym, rows] of Object.entries(j.markets ?? {})) {
        const m = newMarket();
        for (const [min = 0, tot = 0, u = 0, f = 0, mid = 0, inf = 0, uni = 0] of rows) {
          if (min <= floor) continue;
          const i = min % TAPE_MINUTES;
          m.at[i] = min; m.tot[i] = tot; m.u[i] = u; m.f[i] = f; m.inf[i] = inf; m.uni[i] = uni; m.mid[i] = mid > 0 ? mid : NaN;
        }
        this.markets.set(sym, m);
      }
    } catch { /* none yet, or unreadable: start empty */ }
  }
}

function defaultTapeFile(): string | null {
  try {
    return join(dirname(defaultFlowPath()), 'valuescan-board-tape.json.gz');
  } catch {
    return null;
  }
}

let tape: BoardTape | null = null;
/** The API's tape (started with the board's warm timer); null until started. */
export const boardTape = (): BoardTape | null => tape;
export function startBoardTape(): BoardTape {
  if (!tape) { tape = new BoardTape(); tape.start(); }
  return tape;
}
export function stopBoardTape(): void {
  tape?.stop();
  tape = null;
}
