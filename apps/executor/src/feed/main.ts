/**
 * valuescan-feed: the box's ONE holder of the Binance sockets. It writes every SoDEX perp's Binance USD-M best bid /
 * ask into the shared ring (ring.ts) for every process on the box that quotes off Binance - the executor's
 * Binance-led maker (algo/bots.ts, kind 'mm' with ref 'binance'), the beta executor, a test tool.
 *
 * Its own process on purpose (the trading box's lesson, FEED_SHM.md: "make the shared feed not depending on <the
 * bot> being online"): the executor's restarts never take the feed down, and a reader whose producer is down for
 * longer than 2 s opens its own socket until it is back (reference.ts).
 *
 * Holds no key and places nothing. Public market data only: GET fapi.binance.com/fapi/v1/exchangeInfo, the SoDEX
 * gateway's perps symbol list, and wss://fstream.binance.com bookTicker streams (two raced copies).
 *
 *   FEED_PATH     the ring (default /run/valuescan-feed/binance-l1; the unit's RuntimeDirectory)
 *   FEED_COPIES   raced sockets per group of symbols (default 2)
 *   FEED_SYMBOLS  comma-separated SoDEX markets to carry (default: every SoDEX perp Binance lists)
 *
 * The universe is read once at start; a market listed later is carried after the next restart (a new file).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GATEWAY_ORIGIN } from '../../../../packages/sodex-core/src/index.ts';
import type { Logger } from '../../../../packages/copy-engine/src/io.ts';
import { BinanceBooks, binancePerps, plainSockets } from './binance.ts';
import { DEFAULT_FEED_PATH, RingWriter, type RingSymbol } from './ring.ts';
/** Feed ids are positions in this table (the ring's feed names). */
export const FEEDS = ['binance_fut'] as const;

const log: Logger = (() => {
  const out = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ?? {}) }) + '\n');
  return { debug: () => {}, info: out('info'), warn: out('warn'), error: out('error') };
})();

/** SoDEX market -> Binance symbol, for the markets both list: ETH-USD -> ETHUSDT. */
export function universe(sodex: readonly string[], binance: ReadonlyMap<string, string>, only: readonly string[] | null): RingSymbol[] {
  const out: RingSymbol[] = [];
  for (const market of sodex) {
    if (only && !only.includes(market)) continue;
    const m = /^([A-Z0-9]+)-USD$/.exec(market);
    const venue = m ? binance.get(m[1]!) : undefined;
    if (venue) out.push({ market, venue });
  }
  return out.sort((a, b) => a.market.localeCompare(b.market));
}

async function sodexPerps(): Promise<string[]> {
  const r = await fetch(`${GATEWAY_ORIGIN.mainnet}/api/v1/perps/markets/symbols`);
  if (!r.ok) throw new Error(`SoDEX symbols: HTTP ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ symbol?: string; name?: string; status?: string }> };
  return (j.data ?? []).map((s) => s.symbol ?? s.name ?? '').filter((s) => s.endsWith('-USD'));
}

async function main(): Promise<void> {
  const path = process.env.FEED_PATH || DEFAULT_FEED_PATH;
  const copies = Math.max(1, Math.min(4, Number(process.env.FEED_COPIES) || 2));
  const only = process.env.FEED_SYMBOLS ? process.env.FEED_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const [sodex, binance] = await Promise.all([sodexPerps(), binancePerps((u) => fetch(u))]);
  const symbols = universe(sodex, binance, only);
  if (!symbols.length) throw new Error('no market both SoDEX and Binance list');
  mkdirSync(dirname(path), { recursive: true });
  const ring = new RingWriter(path, FEEDS, symbols);
  const ids = new Map(symbols.map((s, i) => [s.venue, i]));
  let written = 0;
  let same = 0;
  const books = new BinanceBooks({
    factory: plainSockets,
    symbols: symbols.map((s) => s.venue),
    copies,
    log,
    onTick: (t) => {
      const id = ids.get(t.symbol);
      if (id === undefined) return;
      if (ring.publish(0, id, t.bid, t.ask, t.bidSz, t.askSz, t.eventMs, t.update, t.rxNs)) written++;
      else same++;
    },
  });
  books.start();
  // The heartbeat only while every symbol's stream is connected (Katana's rule, owner 2026-11-09): a reader then takes
  // a symbol without a tick for a still market, and a silent heartbeat for a feed it cannot trust.
  const beat = setInterval(() => { if (books.allUp) ring.beat(); }, 100);
  const stats = setInterval(() => {
    log.info('feed', { symbols: symbols.length, written, sizeOnly: same, raced: books.dropped, won: books.won, up: books.up, head: Number(ring.published) });
    written = same = 0;
  }, 60_000);
  log.info('feed up', { path, symbols: symbols.length, copies, markets: symbols.map((s) => s.market).join(',') });
  const stop = () => {
    clearInterval(beat);
    clearInterval(stats);
    books.stop();
    ring.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// Run as the unit's entry (src/feed/main.ts, or a bundle named feed-main.mjs); imported (tests) it only exports.
if (/feed[\/-]main\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    log.error('feed failed to start', { error: String(e) });
    process.exit(1);
  });
}
