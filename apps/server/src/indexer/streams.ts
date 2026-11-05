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
 * twice. A handshake not done in 15 s, or a close not done in 10 s, is cut,
 * so a socket never hangs between up and down; every close and connect error
 * is logged (`log`), with how long it was up.
 *
 * `since` is when the stream last came up whole (null while down). A tracked
 * trader's fills are complete from then on; the indexer only trusts that
 * window.
 */
import WebSocket, { type ClientOptions } from 'ws';
import { NET } from '../config.js';
import type { Venue } from '../valuedesk/types.js';
import { hlInfo } from '../valuedesk/hyperliquid/index.js';
import type { HlWsTrade } from '../valuedesk/hyperliquid/raw.js';
import { HL_WS_URL } from '../valuedesk/hyperliquid/whales.js';

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
  /** Which party took liquidity, where the venue says (Hyperliquid's `side`): it pays the taker fee, the other the maker's. */
  taker?: 'buyer' | 'seller';
  /** What each party paid (USD; negative = a rebate), where the trade itself says (Lighter). */
  fee?: { buyer: number; seller: number };
}

/*
 * A dead socket is found in 45 s, not 90: Arcus and SoDEX sockets went silent ("nothing came for
 * 91-96 s") and every such drop was a degraded minute or two on the status page (owner
 * 2026-11-01: uptime). A ping every 15 s (each answered) keeps an idle socket well inside 45 s;
 * Lighter has run on 20 s / 45 s since 2026-10-29 with no false drop.
 */
const PING_MS = 15_000;
const STALE_MS = 45_000;
/** How often a socket is looked at (stale, closing, ping). */
const TICK_MS = 5_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
/** A handshake still open after this is given up: ws has no default, and a stuck one held the socket for good. */
const HANDSHAKE_MS = 15_000;
/** A socket left closing this long is cut: otherwise its close event - and the reconnect - may never come. 3 s, not 10: "its close never finished" was SoDEX's commonest drop (57 of 115 since 10-29). */
const CLOSING_MS = 3_000;
/**
 * ws cuts a socket itself this long after the venue's close frame if the venue then never ends the
 * connection. It still was SoDEX's commonest drop (82 of 100, 2026-11-04 to 11-05), and waiting for
 * tick() to find it made each one up to 8 s of a stream counted as down. tick() stays as the backstop.
 */
const CLOSE_HANDSHAKE_MS = 1_000;
/** After an HTTP 429 on connect the next try waits at least this long (Lighter: a static 60 s cooldown). */
const RATE_LIMITED_MS = 60_000;

/** The indexer's log line for a stream (main.ts prints the rest under the same prefix). */
export const streamLog = (line: string): void => console.log(`[indexer] ${line}`);

const dur = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
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
  /**
   * How much of the time since the last message this thread itself was not running (tick() came
   * late), so what the socket sent could not have been read. 2026-11-03 to 11-05: 33 times all six
   * Hyperliquid, Arcus and Lighter sockets were called silent in the same second, after a stall of
   * the indexer's own thread: the tick ran before the waiting frames did, and cutting the sockets
   * threw those frames away and cost Lighter its ~90 s of subscribing again.
   */
  private stalledMs = 0;
  private lastTickAt = 0;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private running = false;
  /** When this socket last opened and received data. Null while down. */
  upSince: number | null = null;
  private openedAt = 0;
  private lastPingAt = 0;
  private closingAt = 0;
  private limitedUntil = 0;
  /** Why the socket is going: the last connect error, or what tick() saw. */
  private why: string | null = null;

  constructor(
    private readonly url: string,
    private readonly ping: string,
    private readonly subscribe: (send: (msg: unknown) => void) => void | Promise<void>,
    private readonly onMessage: (msg: unknown) => void,
    private readonly opts: {
      pingMs?: number;
      /** Silent this long: replaced (default STALE_MS). */
      staleMs?: number;
      /** How often the socket is looked at (default TICK_MS). */
      tickMs?: number;
      /** false: no permessage-deflate - frames are parsed as they come, never held for the zlib pool (LighterStream). */
      deflate?: boolean;
      /** For the log lines. */
      name?: string;
      log?: (line: string) => void;
      onClose?: () => void;
    } = {},
  ) {}

  private say(line: string): void {
    this.opts.log?.(`stream ${this.opts.name ?? this.url}: ${line}`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS);
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
    // closeTimeout: in ws, not yet in its published types.
    const options: ClientOptions & { closeTimeout: number } = { perMessageDeflate: this.opts.deflate !== false, handshakeTimeout: HANDSHAKE_MS, closeTimeout: CLOSE_HANDSHAKE_MS };
    const ws = new WebSocket(this.url, options);
    this.ws = ws;
    this.closingAt = 0;
    ws.on('open', () => {
      this.attempt = 0;
      this.openedAt = this.lastMessageAt = Date.now();
      this.stalledMs = 0;
      void Promise.resolve(this.subscribe((m) => ws.send(JSON.stringify(m)))).catch(() => ws.terminate());
    });
    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      this.stalledMs = 0;
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
    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.ws = null;
      const wasUp = this.upSince;
      this.upSince = null;
      this.closingAt = 0;
      this.opts.onClose?.();
      if (!this.running) return;
      const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.attempt++);
      const wait = Math.max(base / 2 + Math.random() * (base / 2), this.limitedUntil - Date.now());
      const said = reason?.length ? ` "${reason.toString().slice(0, 120)}"` : '';
      this.say(`closed ${code}${said}${wasUp !== null ? ` after ${dur(Date.now() - wasUp)} up` : ' before data came'}${this.why ? ` (${this.why})` : ''}; again in ${dur(wait)}`);
      this.why = null;
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
      this.reconnectTimer.unref?.();
    });
    ws.on('error', (e) => {
      this.why = String((e as Error)?.message ?? e).slice(0, 160);
      // Too many requests: the venue's cooldown is waited out, not hammered (each try may extend it).
      if (/Unexpected server response: 429/.test(this.why)) this.limitedUntil = Date.now() + RATE_LIMITED_MS;
    });
  }

  private tick(): void {
    const tickedAt = Date.now();
    this.stalledMs += Math.max(0, tickedAt - this.lastTickAt - (this.opts.tickMs ?? TICK_MS));
    this.lastTickAt = tickedAt;
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSING) {
      if (!this.closingAt) this.closingAt = Date.now();
      else if (Date.now() - this.closingAt > CLOSING_MS) {
        this.why = 'its close never finished';
        ws.terminate();
      }
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const staleMs = this.opts.staleMs ?? STALE_MS;
    if (Date.now() - this.lastMessageAt - this.stalledMs > staleMs) {
      this.why = `nothing came for ${dur(Date.now() - this.lastMessageAt)}`;
      ws.terminate();
      return;
    }
    if (Date.now() - this.lastPingAt < (this.opts.pingMs ?? PING_MS)) return;
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
      { name: 'hyperliquid', log: streamLog },
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
    ...(t.side === 'B' ? { taker: 'buyer' as const } : t.side === 'A' ? { taker: 'seller' as const } : {}),
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
  /** The taker's side: BUY or SELL. */
  S?: string;
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
  // `S` is the taker's side, as on Hyperliquid and Arcus.
  const taker = t.S === 'BUY' ? 'buyer' as const : t.S === 'SELL' ? 'seller' as const : undefined;
  return { venue: 'sodex', id: `${t.s}:${t.t}`, t: t.T, symbol: t.s, px, sz, buyer: String(t.bi), seller: String(t.si), ...(taker ? { taker } : {}) };
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
          { name: `sodex-${engine}`, log: streamLog },
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
    taker: takerBuys ? 'buyer' : 'seller',
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
      { name: 'arcus', log: streamLog },
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
  /** Whether the ask (seller) made the book; each side's fee in millionths of the notional (taker_fee absent = 0). */
  is_maker_ask?: boolean;
  maker_fee?: number;
  taker_fee?: number;
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
  const ntl = px * sz;
  const makerFee = (Number(t.maker_fee) || 0) * 1e-6 * ntl;
  const takerFee = (Number(t.taker_fee) || 0) * 1e-6 * ntl;
  const sellerMakes = t.is_maker_ask === true;
  return {
    venue: 'lighter', id, t: t.timestamp, symbol, px, sz, buyer: String(t.bid_account_id), seller: String(t.ask_account_id),
    ...(typeof t.is_maker_ask === 'boolean' ? { taker: sellerMakes ? 'buyer' as const : 'seller' as const, fee: { buyer: sellerMakes ? takerFee : makerFee, seller: sellerMakes ? makerFee : takerFee } } : {}),
  };
}

/**
 * Lighter's public `trade/{market}` channels (wss://.../stream). Verified
 * 2026-09-29: each print names both accounts (`ask_account_id`,
 * `bid_account_id` - sub-account indices). The venue limits messages per IP
 * ("Too Many Websocket Messages", "Too Many Inflight Messages" when a burst
 * of subscribes goes out; documented 2026-10: 200 client messages a minute,
 * 50 in flight), so every socket's subscribes go through one shared pacer,
 * each is confirmed (`subscribed/trade`) and re-sent if not. `since` is set
 * only once EVERY market is confirmed: a stream missing markets would
 * undercount, and the indexer trusts `since`.
 *
 * Why it dropped (2026-10-29, incidents 22 and 25): Lighter compresses its
 * frames (permessage-deflate), ws inflates them on the shared zlib thread pool,
 * and while that pool or this thread is busy ws stops reading the socket -
 * server 1 held 0.5-2.9 MB unread on two of the sockets. Lighter cuts a client
 * whose writes block ("writes to slow clients time out after 250 ms"), and the
 * socket then sat silent until the 90 s stale check, after which 120 markets
 * re-subscribed at one per 700 ms. Now: no deflate (frames are parsed as they
 * come; a busy thread only fills the kernel buffer), a ping every 20 s and 45 s
 * of silence to call a socket dead, sockets of 56 markets and one subscribe
 * per 400 ms - one socket is whole again in about 25 s, all four in under 2 min.
 */
/** Lighter's messages that need no word in the log. */
const LIGHTER_QUIET = new Set(['update/trade', 'subscribed/trade', 'connected', 'pong']);

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
  /** The socket served first next time: they take turns. */
  private turn = 0;
  /** When each socket's subscribes started (its last open), for the log. */
  private openAt: number[] = [];
  /** Lighter's other messages (errors), by type: how many, so the log names each type without flooding. */
  private others = new Map<string, number>();
  /** Subscribe messages wait this long between them, across every socket: at most 182 a minute, beside 12 pings (Lighter: 200). 330 ms, not 400: after a restart all 224 markets are whole again in ~75 s, under the 2-minute gap that breaks a stream's span (measured 2026-11-01: one socket's 54 markets confirm in 22 s at 400 ms with no error). */
  static SEND_GAP_MS = 330;
  /** At most this many subscribes in one go (a late timer catching up): 182 a minute + 6 + 12 pings stays within Lighter's 200. */
  static BURST = 6;
  static PER_SOCKET = 56;
  static CONFIRM_MS = 20_000;
  static PING_MS = 20_000;
  static STALE_MS = 45_000;

  constructor(
    private readonly onPrint: (p: Print) => void,
    private readonly markets: () => Promise<Map<number, string>>,
    private readonly url: string,
    private readonly log: (line: string) => void = streamLog,
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
          this.openAt[i] = Date.now();
        },
        (msg) => this.handle(i, msg),
        {
          pingMs: LighterStream.PING_MS, staleMs: LighterStream.STALE_MS, deflate: false, name: `lighter#${i + 1}`, log: this.log,
          onClose: () => { this.sendFns[i] = null; this.readyAt[i] = null; },
        },
      ));
    });
    for (const s of this.sockets) s.start();
    this.timer = setInterval(() => this.pump(), 100);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sockets) s.stop();
  }

  /**
   * Send the subscribes due: one per SEND_GAP_MS over all sockets on average, and when this
   * timer comes late, the ones it owes at once (at most BURST). One per call before: the indexer's
   * thread lags 2-10 s while a board builds, every late tick was a subscribe lost, and after a
   * restart the four sockets came up about a minute apart (2026-11-01) instead of ~18 s each.
   * The sockets take turns, so each is whole about as soon as the others.
   */
  private pump(): void {
    const now = Date.now();
    let owed = Math.min(LighterStream.BURST, Math.floor((now - this.lastSend) / LighterStream.SEND_GAP_MS));
    if (owed <= 0) return;
    let sent = 0;
    for (let round = 0; owed > 0; round++) {
      let any = false;
      for (let k = 0; k < this.groups.length && owed > 0; k++) {
        const i = (this.turn + k) % this.groups.length;
        const send = this.sendFns[i];
        if (!send) continue;
        const id = this.groups[i]!.find((g) => !this.confirmed[i]!.has(g) && !(now - (this.sentAt[i]!.get(g) ?? -Infinity) < LighterStream.CONFIRM_MS));
        if (id === undefined) continue;
        try {
          send({ type: 'subscribe', channel: `trade/${id}` });
        } catch {
          owed = 0;
          break;
        }
        this.sentAt[i]!.set(id, now);
        owed -= 1;
        sent += 1;
        any = true;
      }
      if (!any) break;
    }
    if (!sent) return;
    this.turn = (this.turn + 1) % Math.max(1, this.groups.length);
    // The budget is spent, not the time: a burst of n moves the clock on by n gaps (never ahead of now).
    this.lastSend = Math.min(now, Math.max(this.lastSend, now - LighterStream.BURST * LighterStream.SEND_GAP_MS) + sent * LighterStream.SEND_GAP_MS);
  }

  /** One raw message on socket `i`. Public for tests. */
  handle(i: number, msg: unknown): void {
    const m = msg as { type?: string; channel?: string; trades?: unknown; liquidation_trades?: unknown };
    // Anything but prints, confirmations and the socket's own chatter is Lighter telling us something (an error, a limit).
    const kind = typeof m?.type === 'string' ? m.type : 'no-type';
    if (!LIGHTER_QUIET.has(kind)) {
      const n = (this.others.get(kind) ?? 0) + 1;
      this.others.set(kind, n);
      if (n <= 3 || n % 100 === 0) this.log(`stream lighter#${i + 1}: Lighter said (${kind} #${n}) ${JSON.stringify(msg).slice(0, 200)}`);
    }
    if (typeof m?.type !== 'string' || typeof m.channel !== 'string' || !m.channel.startsWith('trade:')) return;
    if (m.type === 'subscribed/trade') {
      const id = Number(m.channel.slice(6));
      const conf = this.confirmed[i];
      if (conf && Number.isInteger(id)) {
        conf.add(id);
        if (this.readyAt[i] == null && this.groups[i]!.every((g) => conf.has(g))) {
          this.readyAt[i] = Date.now();
          const took = this.openAt[i] ? ` in ${Math.round((this.readyAt[i]! - this.openAt[i]!) / 1000)} s` : '';
          this.log(`stream lighter#${i + 1}: all ${conf.size} markets confirmed${took}`);
        }
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
