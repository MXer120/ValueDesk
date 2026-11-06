/**
 * Hyperliquid whale trades from the public WS `trades` channel.
 *
 * Every HL print carries users: [buyer, seller] and the aggressor's side, so
 * the taker of every trade is public in real time (research 02, section 2.2).
 * This feed subscribes, once and lazily on the first whales() call, to the
 * TRACKED_COINS most traded coins (24h notional across the default dex and
 * the HIP-3 dex "xyz"), groups the prints of each taker order
 * (aggregateTakerPrints), and keeps orders of at least WHALE_KEEP_USD in a
 * ring buffer. whales(minUsd) filters that buffer on read, so a minUsd below
 * WHALE_KEEP_USD still only sees trades of at least WHALE_KEEP_USD.
 *
 * CONNECTION. One socket (HL allows 10 per IP and 1,000 subscriptions). Ping
 * every 30 s (HL drops a connection after 60 s idle). A socket silent for 90 s
 * is presumed dead and replaced. Reconnects back off exponentially, 1 s to
 * 30 s with jitter, well inside HL's 30 new connections per minute. The coin
 * list is re-ranked hourly and subscriptions are diffed. When nobody has read
 * the feed for 30 minutes the socket is closed; the buffer is kept and the
 * next read reopens it.
 *
 * Duplicates: the first message per coin after (re)subscribing is a snapshot
 * of about 30 recent prints. It is ingested (it fills the buffer at once) and
 * deduplicated by trade id against what was already seen.
 *
 * WHAT THIS COSTS HYPERLIQUID, WHATEVER THE NUMBER OF VISITORS. A request
 * reads the ring buffer; it never causes a request of its own. One feed serves
 * everyone: one socket with TRACKED_COINS subscriptions, and the coin ranking -
 * two metaAndAssetCtxs (20 weight each) when the feed starts and once an hour
 * while it runs. A feed stops after 30 idle minutes, so that is at most
 * 40 weight per half hour, of the 200 a minute an API-only process may spend
 * at all (info.ts) and of HL's 1,200.
 */
import WebSocket from 'ws';
import type { WhaleTrade } from '../types.js';
import type { InfoLike } from './info.js';
import { aggregateTakerPrints, coinsFromMeta, topCoins, type CoinVolume } from './mappers.js';
import type { HlMetaAndAssetCtxs, HlWsTrade } from './raw.js';

export const HL_WS_URL = process.env.VALUESCAN_HL_WS_URL?.trim() || 'wss://api.hyperliquid.xyz/ws';

export const TRACKED_COINS = 20;
/** Taker orders below this notional are not kept. */
export const WHALE_KEEP_USD = 10_000;
const RING_CAPACITY = 5000;
const PING_MS = 30_000;
const STALE_MS = 90_000;
const HEALTH_TICK_MS = 10_000;
const COINS_REFRESH_MS = 60 * 60_000;
const IDLE_STOP_MS = 30 * 60_000;
/** The very first read waits this long for the snapshots to land. */
const FIRST_READ_WAIT_MS = 4000;
/** The first connect waits at most this long for the coin ranking. */
const COINS_WAIT_MS = 1500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;
/** Used only if the market ranking cannot be fetched. */
const FALLBACK_COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'SUI', 'ZEC', 'ENA', 'BNB'];
const DEXES = ['', 'xyz'];

/** Newest-first view over a bounded set of whale trades. */
export class TradeRing {
  private items: WhaleTrade[] = [];

  constructor(private readonly capacity = RING_CAPACITY) {}

  push(t: WhaleTrade): void {
    this.items.push(t);
    if (this.items.length > this.capacity * 1.2) {
      this.items.sort((a, b) => a.time - b.time);
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  get size(): number {
    return this.items.length;
  }

  recent(minUsd: number, limit: number): WhaleTrade[] {
    return this.items
      .filter((t) => t.notional >= minUsd)
      .sort((a, b) => b.time - a.time)
      .slice(0, Math.max(0, limit))
      .map((t) => ({ ...t }));
  }
}

/** Remembers recent trade ids with bounded memory (two generations). */
export class SeenIds {
  private cur = new Set<number>();
  private old = new Set<number>();

  constructor(private readonly generation = 100_000) {}

  /** true if `id` is new (and records it). */
  add(id: number): boolean {
    if (this.cur.has(id) || this.old.has(id)) return false;
    this.cur.add(id);
    if (this.cur.size >= this.generation) {
      this.old = this.cur;
      this.cur = new Set();
    }
    return true;
  }
}

export class HlTradeFeed {
  private ws: WebSocket | null = null;
  private coins: string[] = [];
  private subscribed = new Set<string>();
  private snapshotSeen = new Set<string>();
  private ring = new TradeRing();
  private seen = new SeenIds();
  private attempt = 0;
  private running = false;
  private lastRead = 0;
  private lastMessageAt = 0;
  private lastPingAt = 0;
  private coinsAt = 0;
  private health?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private ready: Promise<void> = Promise.resolve();
  private markReady: () => void = () => {};
  status: 'stopped' | 'connecting' | 'open' | 'reconnecting' = 'stopped';

  constructor(
    private readonly info: InfoLike,
    private readonly url: string = HL_WS_URL,
  ) {}

  /** Recent whale trades, newest first. Starts the feed on first use. */
  async recent(minUsd: number, limit: number): Promise<WhaleTrade[]> {
    this.lastRead = Date.now();
    if (!this.running) {
      this.start();
      await Promise.race([this.ready, new Promise((r) => setTimeout(r, FIRST_READ_WAIT_MS).unref())]);
    }
    return this.ring.recent(Math.max(0, minUsd), limit);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastRead = this.lastRead || Date.now();
    this.ready = new Promise<void>((r) => (this.markReady = r));
    this.health = setInterval(() => this.tick(), HEALTH_TICK_MS);
    this.health.unref();
    // The first ranking runs at interactive priority, and the socket does not
    // wait for it for long: when the shared budget is in debt (a deep fills
    // query just ran) the ranking can take a while, and the fallback majors
    // are a fine start. The ranking re-syncs subscriptions when it lands.
    const ranking = this.refreshCoins(false);
    void Promise.race([ranking, new Promise((r) => setTimeout(r, COINS_WAIT_MS).unref())]).finally(() => {
      if (!this.coins.length) this.coins = FALLBACK_COINS;
      this.connect();
    });
  }

  stop(): void {
    this.running = false;
    if (this.health) clearInterval(this.health);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.health = this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    this.subscribed.clear();
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
    }
    this.status = 'stopped';
    this.markReady();
  }

  /** Rank coins by 24h notional; keeps the previous list (or a fallback) on failure. */
  private async refreshCoins(background = true): Promise<void> {
    this.coinsAt = Date.now();
    const got = await Promise.allSettled(
      DEXES.map((dex) =>
        this.info.post<HlMetaAndAssetCtxs>(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, {
          ttlMs: 10 * 60_000,
          background,
        }),
      ),
    );
    const all: CoinVolume[] = got.flatMap((g) => (g.status === 'fulfilled' ? coinsFromMeta(g.value) : []));
    const ranked = topCoins(all, TRACKED_COINS);
    if (ranked.length) this.coins = ranked;
    else if (!this.coins.length) this.coins = FALLBACK_COINS;
    this.syncSubscriptions();
  }

  private connect(): void {
    if (!this.running || this.ws) return;
    this.status = this.attempt === 0 ? 'connecting' : 'reconnecting';
    const ws = new WebSocket(this.url, { perMessageDeflate: false });
    this.ws = ws;
    this.subscribed.clear();
    this.snapshotSeen.clear();

    ws.on('open', () => {
      this.attempt = 0;
      this.status = 'open';
      this.lastMessageAt = this.lastPingAt = Date.now();
      this.syncSubscriptions();
    });
    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let msg: { channel?: string; data?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.channel === 'trades' && Array.isArray(msg.data)) this.ingest(msg.data as HlWsTrade[]);
    });
    ws.on('close', () => this.scheduleReconnect(ws));
    // 'close' always follows 'error'; reconnect is handled there.
    ws.on('error', () => {});
  }

  /** Feed one `trades` message. Public for tests. */
  ingest(trades: readonly HlWsTrade[]): void {
    const fresh = trades.filter((t) => typeof t?.tid === 'number' && this.seen.add(t.tid));
    for (const w of aggregateTakerPrints(fresh)) {
      if (w.notional >= WHALE_KEEP_USD) this.ring.push(w);
    }
    const coin = trades[0]?.coin;
    if (coin && !this.snapshotSeen.has(coin)) {
      this.snapshotSeen.add(coin);
      if (this.coins.length && this.coins.every((c) => this.snapshotSeen.has(c))) this.markReady();
    }
  }

  get buffered(): number {
    return this.ring.size;
  }

  private syncSubscriptions(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const want = new Set(this.coins);
    for (const coin of want) {
      if (this.subscribed.has(coin)) continue;
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
      this.subscribed.add(coin);
    }
    for (const coin of [...this.subscribed]) {
      if (want.has(coin)) continue;
      ws.send(JSON.stringify({ method: 'unsubscribe', subscription: { type: 'trades', coin } }));
      this.subscribed.delete(coin);
    }
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastRead > IDLE_STOP_MS) {
      this.stop();
      return;
    }
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (now - this.lastMessageAt > STALE_MS) {
        ws.terminate(); // 'close' schedules the reconnect
        return;
      }
      if (now - this.lastPingAt >= PING_MS) {
        this.lastPingAt = now;
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    }
    if (now - this.coinsAt >= COINS_REFRESH_MS) void this.refreshCoins();
  }

  private scheduleReconnect(ws: WebSocket): void {
    if (this.ws !== ws) return;
    ws.removeAllListeners();
    ws.on('error', () => {});
    this.ws = null;
    this.subscribed.clear();
    if (!this.running) return;
    this.status = 'reconnecting';
    const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.attempt++);
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref();
  }
}
