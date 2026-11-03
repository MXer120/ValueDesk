/**
 * Binance USD-M futures best bid / ask (bookTicker) on several sockets at once - the first copy of each update wins,
 * by its update id - for the shared feed (feed/main.ts) and for a reader's own fallback (reference.ts).
 *
 * Raced copies are what the trading box's feed does (two Binance futures connections): one socket's stall, GC pause
 * or reconnect costs nothing while another is up, and the first arrival of a tick is the one the bots see.
 */
import WebSocket from 'ws';
import { LiveSocket } from '../../../../packages/copy-engine/src/socket.ts';
import type { Logger, WebSocketFactory, WebSocketLike } from '../../../../packages/copy-engine/src/io.ts';
import { monoNs } from './ring.ts';

export const BINANCE_FUTURES_WS = 'wss://fstream.binance.com';

/**
 * Binance's sockets WITHOUT permessage-deflate. Node's built-in WebSocket asks for it, Binance grants it, and inflating
 * a busy bookTicker stream falls behind: measured on server 2 (2026-11-03, ETH alone, 15 s) arrival minus Binance's
 * event time p50 246 ms / p99 1,009 ms with it, p50 7 ms / p99 107 ms with the `ws` package and no deflate (8 symbols:
 * 5.7 s behind vs 5 ms). The Lighter streams had the same stall (indexer, v0.2.86).
 */
export const plainSockets: WebSocketFactory = (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as WebSocketLike;
export const BINANCE_FUTURES_REST = 'https://fapi.binance.com';
/**
 * Symbols per socket. Binance allows 200 streams on one, but one busy connection falls behind: on server 2
 * (2026-11-03) 54 symbols on one socket arrived p50 80-100 ms after Binance's event time on the busy ones, 8 on
 * one 5 ms.
 */
export const SYMBOLS_PER_SOCKET = 8;

export interface BookTick {
  /** Binance's symbol, e.g. ETHUSDT. */
  symbol: string;
  bid: number;
  ask: number;
  bidSz: number;
  askSz: number;
  eventMs: number;
  update: number;
  rxNs: bigint;
  /** Which copy delivered it first. */
  copy: number;
}

export interface BinanceBooksOptions {
  factory: WebSocketFactory;
  symbols: readonly string[];
  /** Sockets per group of symbols, raced (default 2). */
  copies?: number;
  /** Symbols per socket (default SYMBOLS_PER_SOCKET). */
  perSocket?: number;
  onTick: (t: BookTick) => void;
  log?: Logger;
  origin?: string;
}

export class BinanceBooks {
  private sockets: LiveSocket[] = [];
  /** The newest update id per symbol: a copy's later arrival of the same update is dropped. */
  private readonly seen = new Map<string, number>();
  /** Ticks per copy that won the race, and duplicates dropped (for the feed's stats). */
  readonly won: number[];
  dropped = 0;

  constructor(private readonly o: BinanceBooksOptions) {
    this.won = new Array(o.copies ?? 2).fill(0);
  }

  start(): void {
    const groups: string[][] = [];
    const per = this.o.perSocket ?? SYMBOLS_PER_SOCKET;
    for (let i = 0; i < this.o.symbols.length; i += per) groups.push(this.o.symbols.slice(i, i + per));
    for (let copy = 0; copy < (this.o.copies ?? 2); copy++) {
      for (const g of groups) {
        const streams = g.map((s) => `${s.toLowerCase()}@bookTicker`).join('/');
        const socket = new LiveSocket({
          url: `${this.o.origin ?? BINANCE_FUTURES_WS}/stream?streams=${streams}`,
          factory: this.o.factory,
          // Binance pings the client itself; a cheap request keeps our side of the silence check honest.
          ping: '{"method":"LIST_SUBSCRIPTIONS","id":1}',
          pingMs: 60_000,
          staleMs: 15_000,
          subscribe: () => {},
          onMessage: (m) => this.message(m, copy),
          log: this.o.log,
          name: `binance books ${copy}`,
        });
        this.sockets.push(socket);
        socket.start();
      }
    }
  }

  stop(): void {
    for (const s of this.sockets) s.stop();
    this.sockets = [];
  }

  /** At least one socket is up. */
  get up(): boolean {
    return this.sockets.some((s) => s.up);
  }

  private message(m: unknown, copy: number): void {
    const d = (m as { data?: Record<string, unknown> } | null)?.data;
    if (!d || typeof d.s !== 'string') return;
    const rxNs = monoNs();
    const u = Number(d.u);
    const prev = this.seen.get(d.s);
    if (prev !== undefined && u <= prev) {
      this.dropped++;
      return;
    }
    this.seen.set(d.s, u);
    const bid = Number(d.b);
    const ask = Number(d.a);
    if (!(bid > 0) || !(ask > 0)) return;
    this.won[copy] = (this.won[copy] ?? 0) + 1;
    this.o.onTick({ symbol: d.s, bid, ask, bidSz: Number(d.B) || 0, askSz: Number(d.A) || 0, eventMs: Number(d.E) || 0, update: u, rxNs, copy });
  }
}

/** Binance's USD-M perpetuals that are trading, by base asset: ETH -> ETHUSDT (USDT-quoted only). */
export async function binancePerps(fetch: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>, origin = BINANCE_FUTURES_REST): Promise<Map<string, string>> {
  const r = await fetch(`${origin}/fapi/v1/exchangeInfo`);
  if (!r.ok) throw new Error('Binance exchangeInfo did not answer');
  const j = JSON.parse(await r.text()) as { symbols?: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string }> };
  const out = new Map<string, string>();
  for (const s of j.symbols ?? []) if (s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING') out.set(s.baseAsset, s.symbol);
  return out;
}
