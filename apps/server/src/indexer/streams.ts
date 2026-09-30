/**
 * The venues' public trade streams, every market, as one print shape.
 *
 * Every venue here publishes both parties of every trade:
 *   Hyperliquid  `trades`       users: [buyer, seller] (addresses)
 *   SoDEX        `trade`        bi / si (buyer / seller account ids)
 *   Arcus        `trades`       maker / taker addresses
 *   Lighter      `trade/{id}`   bid / ask account indices (sub-accounts)
 * So one socket per venue (two on SoDEX: perps and spot) sees every account
 * that trades, which is what finds losers the venues do not rank, and it
 * writes a tracked trader's fills the moment they happen, so their index
 * stays complete without polling.
 *
 * Connection handling is the whale feed's: ping every 30 s, a socket silent
 * for 90 s is replaced, reconnects back off 1 s to 30 s with jitter. The
 * first message per market after subscribing is a snapshot of recent prints;
 * `Dedup` drops what was already seen, so a reconnect never counts a print
 * twice.
 *
 * `since` is when the stream last came up whole (null while down). A tracked
 * trader's fills are complete from then on; the indexer only trusts that
 * window.
 */
import WebSocket from 'ws';
import { NET } from '../config.js';
import type { Venue } from '../valuescan/types.js';
import { hlInfo } from '../valuescan/hyperliquid/index.js';
import type { HlWsTrade } from '../valuescan/hyperliquid/raw.js';
import { HL_WS_URL } from '../valuescan/hyperliquid/whales.js';

/** One print. `buyer` / `seller` are HL addresses or SoDEX account ids as strings. */
export interface Print {
  venue: Venue;
  /** Unique per venue: HL tid, SoDEX `${symbol}:${tradeID}`. */
  id: string;
  t: number;
  symbol: string;
  px: number;
  sz: number;
  buyer: string;
  seller: string;
}

const PING_MS = 30_000;
const STALE_MS = 90_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const MARKETS_REFRESH_MS = 6 * 60 * 60_000;

/** Remembers the last `cap` ids. */
export class Dedup {
  private set = new Set<string>();
  constructor(private readonly cap = 200_000) {}
  /** True the first time an id is seen. */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.cap) {
      // Sets iterate in insertion order: drop the oldest tenth.
      let n = Math.floor(this.cap / 10);
      for (const k of this.set) {
        this.set.delete(k);
        if (--n <= 0) break;
      }
    }
    return true;
  }
}

/** A socket that keeps itself up. `subscribe` is called on every (re)open. */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastMessageAt = 0;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private running = false;
  /** When this socket last opened and received data. Null while down. */
  upSince: number | null = null;
  private openedAt = 0;
  private lastPingAt = 0;

  constructor(
    private readonly url: string,
    private readonly ping: string,
    private readonly subscribe: (send: (msg: unknown) => void) => void | Promise<void>,
    private readonly onMessage: (msg: unknown) => void,
    private readonly opts: { pingMs?: number; onClose?: () => void } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.timer = setInterval(() => this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    this.upSince = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
    }
  }

  /** Resubscribe on the live socket (the market list changed). */
  resubscribe(): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) void this.subscribe((m) => ws.send(JSON.stringify(m)));
  }

  private connect(): void {
    if (!this.running || this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.openedAt = this.lastMessageAt = Date.now();
      void Promise.resolve(this.subscribe((m) => ws.send(JSON.stringify(m)))).catch(() => ws.terminate());
    });
    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      // Up from the moment the subscriptions were sent and data flows.
      if (this.upSince === null) this.upSince = this.openedAt;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        this.onMessage(msg);
      } catch { /* one bad print never takes the socket down */ }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.upSince = null;
      this.opts.onClose?.();
      if (!this.running) return;
      const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.attempt++);
      this.reconnectTimer = setTimeout(() => this.connect(), base / 2 + Math.random() * (base / 2));
      this.reconnectTimer.unref?.();
    });
    ws.on('error', () => {});
  }

  private tick(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessageAt > STALE_MS) {
      ws.terminate();
      return;
    }
    if (Date.now() - this.lastPingAt < (this.opts.pingMs ?? 0)) return;
    this.lastPingAt = Date.now();
    ws.send(this.ping);
  }
}

// --- Hyperliquid -------------------------------------------------------------------

interface HlSpotMeta { universe?: Array<{ name?: string }> }
interface HlMeta { universe?: Array<{ name?: string; isDelisted?: boolean }> }

/** Every live perp (default dex and every HIP-3 dex) and every spot pair. */
async function hlMarkets(): Promise<string[]> {
  const opts = { ttlMs: 60 * 60_000, background: true };
  const dexes = await hlInfo.post<Array<{ name?: string } | null>>({ type: 'perpDexs' }, opts).catch(() => [null]);
  const names = ['', ...(Array.isArray(dexes) ? dexes : []).flatMap((d) => (d?.name ? [d.name] : []))];
  const metas = await Promise.all(
    names.map((dex) => hlInfo.post<HlMeta>(dex ? { type: 'meta', dex } : { type: 'meta' }, opts).catch(() => null)),
  );
  const perps = metas.flatMap((m) => (m?.universe ?? []).flatMap((u) => (u.name && !u.isDelisted ? [u.name] : [])));
  const spot = await hlInfo.post<HlSpotMeta>({ type: 'spotMeta' }, opts).catch(() => null);
  const pairs = (spot?.universe ?? []).flatMap((u) => (u.name ? [u.name] : []));
  // HL allows 1,000 subscriptions per connection.
  return [...new Set([...perps, ...pairs])].slice(0, 990);
}

export class HlStream {
  private socket: LiveSocket;
  private markets: string[] = [];
  private subscribed = new Set<string>();
  private dedup = new Dedup();
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly onPrint: (p: Print) => void, url = HL_WS_URL) {
    this.socket = new LiveSocket(
      url,
      JSON.stringify({ method: 'ping' }),
      async (send) => {
        if (!this.markets.length) this.markets = await hlMarkets();
        this.subscribed.clear();
        for (const coin of this.markets) {
          send({ method: 'subscribe', subscription: { type: 'trades', coin } });
          this.subscribed.add(coin);
        }
      },
      (msg) => this.handle(msg),
    );
  }

  get since(): number | null {
    return this.socket.upSince;
  }

  start(): void {
    this.socket.start();
    this.refreshTimer = setInterval(() => {
      void hlMarkets().then((m) => {
        if (m.length && m.some((c) => !this.subscribed.has(c))) {
          this.markets = m;
          this.socket.resubscribe();
        }
      }).catch(() => {});
    }, MARKETS_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    this.socket.stop();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /** One raw message. Public for tests. */
  handle(msg: unknown): void {
    const m = msg as { channel?: string; data?: unknown };
    if (m?.channel !== 'trades' || !Array.isArray(m.data)) return;
    for (const t of m.data as HlWsTrade[]) {
      const p = hlPrint(t);
      if (p && this.dedup.add(p.id)) this.onPrint(p);
    }
  }
}

export function hlPrint(t: HlWsTrade): Print | null {
  if (!t || typeof t.tid !== 'number' || !Array.isArray(t.users) || t.users.length !== 2) return null;
  const px = Number(t.px);
  const sz = Number(t.sz);
  if (!(px > 0) || !(sz > 0) || typeof t.time !== 'number') return null;
  return {
    venue: 'hyperliquid',
    id: String(t.tid),
    t: t.time,
    symbol: t.coin,
    px,
    sz,
    buyer: String(t.users[0]).toLowerCase(),
    seller: String(t.users[1]).toLowerCase(),
  };
}

// --- SoDEX ---------------------------------------------------------------------------

interface SodexWsTrade {
  T?: number;
  t?: number;
  s?: string;
  p?: string;
  q?: string;
  bi?: number;
  si?: number;
}

async function sodexSymbols(engine: 'perps' | 'spot'): Promise<string[]> {
  const res = await fetch(`${NET.restBase}/api/v1/${engine}/markets/symbols`, { signal: AbortSignal.timeout(15_000) });
  const j = (await res.json()) as { data?: unknown };
  const list = Array.isArray(j.data) ? j.data : ((j.data as { symbols?: unknown[] } | undefined)?.symbols ?? []);
  return (list as Array<{ symbol?: string; name?: string }>).flatMap((s) => {
    const n = s.symbol ?? s.name;
    return typeof n === 'string' && n ? [n] : [];
  });
}

export function sodexPrint(t: SodexWsTrade): Print | null {
  if (!t || typeof t.t !== 'number' || typeof t.s !== 'string' || typeof t.T !== 'number') return null;
  const px = Number(t.p);
  const sz = Number(t.q);
  if (!(px > 0) || !(sz > 0) || !Number.isInteger(t.bi) || !Number.isInteger(t.si)) return null;
  return { venue: 'sodex', id: `${t.s}:${t.t}`, t: t.T, symbol: t.s, px, sz, buyer: String(t.bi), seller: String(t.si) };
}

export class SodexStream {
  private sockets: LiveSocket[];
  private dedup = new Dedup();

  constructor(private readonly onPrint: (p: Print) => void, wsBase = NET.wsBase) {
    this.sockets = (['perps', 'spot'] as const).map(
      (engine) =>
        new LiveSocket(
          `${wsBase}/ws/${engine}`,
          JSON.stringify({ op: 'ping' }),
          async (send) => {
            const symbols = await sodexSymbols(engine);
            if (symbols.length) send({ op: 'subscribe', params: { channel: 'trade', symbols } });
          },
          (msg) => this.handle(msg),
        ),
    );
  }

  /** Up only when both engines are up; the later of the two start times. */
  get since(): number | null {
    let out = 0;
    for (const s of this.sockets) {
      if (s.upSince === null) return null;
      out = Math.max(out, s.upSince);
    }
    return out;
  }

  start(): void {
    for (const s of this.sockets) s.start();
  }

  stop(): void {
    for (const s of this.sockets) s.stop();
  }

  handle(msg: unknown): void {
    const m = msg as { channel?: string; data?: unknown };
    if (m?.channel !== 'trade' || !Array.isArray(m.data)) return;
    for (const t of m.data as SodexWsTrade[]) {
      const p = sodexPrint(t);
      if (p && this.dedup.add(p.id)) this.onPrint(p);
    }
  }
}

// --- Arcus -----------------------------------------------------------------------------

interface ArcusWsTrade {
  marketDisplayName?: string;
  side?: string;
  price?: string;
  size?: string;
  tradeId?: string;
  timestamp?: number;
  makerAddress?: string;
  takerAddress?: string;
}

/** `side` is the taker's: SELL means the maker bought. Timestamps are µs. */
export function arcusPrint(t: ArcusWsTrade): Print | null {
  const px = Number(t.price);
  const sz = Number(t.size);
  const maker = t.makerAddress?.toLowerCase();
  const taker = t.takerAddress?.toLowerCase();
  if (!t.tradeId || !t.marketDisplayName || typeof t.timestamp !== 'number' || !(px > 0) || !(sz > 0) || !maker || !taker) return null;
  const takerBuys = t.side !== 'SELL';
  return {
    venue: 'arcus',
    id: t.tradeId,
    t: Math.floor(t.timestamp / 1000),
    symbol: t.marketDisplayName,
    px,
    sz,
    buyer: takerBuys ? taker : maker,
    seller: takerBuys ? maker : taker,
  };
}

/**
 * Arcus's public `trades` channel for every market on one socket (the venue
 * allows 100 subscriptions per connection and closes a socket after 24 h;
 * LiveSocket reconnects).
 */
export class ArcusStream {
  private socket: LiveSocket;
  private dedup = new Dedup();

  constructor(private readonly onPrint: (p: Print) => void, markets: () => Promise<string[]>, url: string) {
    this.socket = new LiveSocket(
      url,
      JSON.stringify({ type: 'ping' }),
      async (send) => {
        for (const id of (await markets()).slice(0, 100)) send({ type: 'subscribe', channel: 'trades', id });
      },
      (msg) => this.handle(msg),
    );
  }

  get since(): number | null {
    return this.socket.upSince;
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
  }

  handle(msg: unknown): void {
    const m = msg as { type?: string; channel?: string; contents?: unknown };
    if (m?.type !== 'channel_data' || m.channel !== 'trades' || !Array.isArray(m.contents)) return;
    for (const t of m.contents as ArcusWsTrade[]) {
      const p = arcusPrint(t);
      if (p && this.dedup.add(p.id)) this.onPrint(p);
    }
  }
}

// --- Lighter ---------------------------------------------------------------------------

interface LighterWsTrade {
  trade_id?: number;
  trade_id_str?: string;
  market_id?: number;
  size?: string;
  price?: string;
  ask_account_id?: number;
  bid_account_id?: number;
  timestamp?: number;
}

/** Both parties are ACCOUNT INDICES (sub-accounts); the venue maps them to L1 addresses. */
export function lighterPrint(t: LighterWsTrade, symbolOf: (marketId: number) => string | null): Print | null {
  const px = Number(t.price);
  const sz = Number(t.size);
  const id = t.trade_id_str ?? (typeof t.trade_id === 'number' ? String(t.trade_id) : null);
  if (!id || typeof t.market_id !== 'number' || typeof t.timestamp !== 'number' || !(px > 0) || !(sz > 0)) return null;
  if (!Number.isInteger(t.ask_account_id) || !Number.isInteger(t.bid_account_id)) return null;
  const symbol = symbolOf(t.market_id);
  if (!symbol) return null;
  return { venue: 'lighter', id, t: t.timestamp, symbol, px, sz, buyer: String(t.bid_account_id), seller: String(t.ask_account_id) };
}

/**
 * Lighter's public `trade/{market}` channels (wss://.../stream). Verified
 * 2026-09-29: each print names both accounts (`ask_account_id`,
 * `bid_account_id` - sub-account indices). The venue limits messages per IP
 * ("Too Many Websocket Messages", "Too Many Inflight Messages" when a burst
 * of subscribes goes out), so every socket's subscribes go through one slow
 * shared pacer, each is confirmed (`subscribed/trade`) and re-sent if not,
 * and pings are sparse. `since` is set only once EVERY market is confirmed:
 * a stream missing markets would undercount, and the indexer trusts `since`.
 */
export class LighterStream {
  private sockets: LiveSocket[] = [];
  private dedup = new Dedup();
  private groups: number[][] = [];
  private confirmed: Array<Set<number>> = [];
  private sentAt: Array<Map<number, number>> = [];
  private sendFns: Array<((m: unknown) => void) | null> = [];
  private readyAt: Array<number | null> = [];
  private timer?: NodeJS.Timeout;
  private lastSend = 0;
  /** Subscribe messages wait this long between them, across every socket. */
  static SEND_GAP_MS = 700;
  static PER_SOCKET = 120;
  static CONFIRM_MS = 20_000;

  constructor(
    private readonly onPrint: (p: Print) => void,
    private readonly markets: () => Promise<Map<number, string>>,
    private readonly url: string,
  ) {}

  private symbols = new Map<number, string>();

  get since(): number | null {
    if (!this.sockets.length) return null;
    let out = 0;
    for (let i = 0; i < this.sockets.length; i++) {
      const up = this.sockets[i]!.upSince;
      const ready = this.readyAt[i];
      if (up === null || ready == null) return null;
      out = Math.max(out, ready);
    }
    return out;
  }

  /** Markets confirmed / wanted, for the status line. */
  get subscribed(): { confirmed: number; markets: number } {
    return { confirmed: this.confirmed.reduce((n, s) => n + s.size, 0), markets: this.groups.reduce((n, g) => n + g.length, 0) };
  }

  async start(): Promise<void> {
    this.symbols = await this.markets();
    const ids = [...this.symbols.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i += LighterStream.PER_SOCKET) this.groups.push(ids.slice(i, i + LighterStream.PER_SOCKET));
    this.groups.forEach((group, i) => {
      this.confirmed[i] = new Set();
      this.sentAt[i] = new Map();
      this.readyAt[i] = null;
      this.sendFns[i] = null;
      this.sockets.push(new LiveSocket(
        this.url,
        JSON.stringify({ type: 'ping' }),
        (send) => {
          // A (re)opened socket starts from nothing: every market is subscribed again.
          this.confirmed[i] = new Set();
          this.sentAt[i] = new Map();
          this.readyAt[i] = null;
          this.sendFns[i] = send;
        },
        (msg) => this.handle(i, msg),
        { pingMs: 50_000, onClose: () => { this.sendFns[i] = null; this.readyAt[i] = null; } },
      ));
    });
    for (const s of this.sockets) s.start();
    this.timer = setInterval(() => this.pump(), 250);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sockets) s.stop();
  }

  /** Send the next due subscribe (one per SEND_GAP_MS over all sockets). */
  private pump(): void {
    const now = Date.now();
    if (now - this.lastSend < LighterStream.SEND_GAP_MS) return;
    for (let i = 0; i < this.groups.length; i++) {
      const send = this.sendFns[i];
      if (!send) continue;
      for (const id of this.groups[i]!) {
        if (this.confirmed[i]!.has(id)) continue;
        const at = this.sentAt[i]!.get(id);
        if (at !== undefined && now - at < LighterStream.CONFIRM_MS) continue;
        try {
          send({ type: 'subscribe', channel: `trade/${id}` });
        } catch {
          return;
        }
        this.sentAt[i]!.set(id, now);
        this.lastSend = now;
        return;
      }
    }
  }

  /** One raw message on socket `i`. Public for tests. */
  handle(i: number, msg: unknown): void {
    const m = msg as { type?: string; channel?: string; trades?: unknown; liquidation_trades?: unknown };
    if (typeof m?.type !== 'string' || typeof m.channel !== 'string' || !m.channel.startsWith('trade:')) return;
    if (m.type === 'subscribed/trade') {
      const id = Number(m.channel.slice(6));
      const conf = this.confirmed[i];
      if (conf && Number.isInteger(id)) {
        conf.add(id);
        if (this.readyAt[i] == null && this.groups[i]!.every((g) => conf.has(g))) this.readyAt[i] = Date.now();
      }
    }
    if (m.type !== 'update/trade' && m.type !== 'subscribed/trade') return;
    for (const list of [m.trades, m.liquidation_trades]) {
      if (!Array.isArray(list)) continue;
      for (const t of list as LighterWsTrade[]) {
        const p = lighterPrint(t, (id) => this.symbols.get(id) ?? null);
        if (p && this.dedup.add(p.id)) this.onPrint(p);
      }
    }
  }
}
