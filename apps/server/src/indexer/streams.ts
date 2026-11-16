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

/**
 * A print this old proves nothing about the feed: it is a backlog or a snapshot arriving. Measured 2026-11-06: the SoDEX
 * perps socket went on delivering a trickle of prints 20 minutes old, so it looked alive while most of the market's
 * trades waited unread in the kernel.
 */
const FRESH_PRINT_MS = 60_000;
/** Whether a frame's trades hold one that just happened. */
export const hasFreshPrint = (list: unknown, timeOf: (t: never) => unknown, now = Date.now()): boolean => {
  if (!Array.isArray(list)) return false;
  for (const t of list as never[]) {
    const at = timeOf(t);
    if (typeof at === 'number' && now - at < FRESH_PRINT_MS) return true;
  }
  return false;
};

/**
 * Remembers the last `cap` ids, each with its print's time. The times are for a handover (handover.ts): the outgoing
 * indexer names every print it took since a time, and up to when it can no longer say (`forgotThrough`), so the incoming
 * one applies exactly the rest of what its own sockets buffered.
 */
export class Dedup {
  private seen = new Map<string, number>();
  /** The newest print time among the ids dropped for the cap (0: none dropped). */
  forgotThrough = 0;
  constructor(private cap = 200_000) {}
  has(id: string): boolean {
    return this.seen.has(id);
  }
  /** True the first time an id is seen. */
  add(id: string, t = 0): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, t);
    if (this.seen.size > this.cap) {
      // Maps iterate in insertion order: drop the oldest tenth.
      let n = Math.floor(this.cap / 10);
      for (const [k, at] of this.seen) {
        this.seen.delete(k);
        if (at > this.forgotThrough) this.forgotThrough = at;
        if (--n <= 0) break;
      }
    }
    return true;
  }
  /** Keep at least this many from now on (a handover is coming: what the incoming indexer buffers must stay nameable). */
  keepAtLeast(cap: number): void {
    if (cap > this.cap) this.cap = cap;
  }
  /** The ids of prints at `from` or later. */
  since(from: number): string[] {
    const out: string[] = [];
    for (const [id, t] of this.seen) if (t >= from) out.push(id);
    return out;
  }
  get size(): number {
    return this.seen.size;
  }
}

/** A socket that keeps itself up. `subscribe` is called on every (re)open. */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastMessageAt = 0;
  private lastDataAt = 0;
  private dataStalledMs = 0;
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
      /**
       * No DATA this long, whatever else arrives: replaced. A socket can go on answering pings and subscribe
       * acks after its venue stopped sending it data, so "something came" says nothing about the feed.
       * Pair it with `isData`; leave it out for a feed that can really go quiet.
       */
      dataSilentMs?: number;
      /** Whether a message is the feed itself, not a pong or an ack. */
      isData?: (msg: unknown) => boolean;
      /** false while the feed cannot be expected yet (a socket still subscribing): its clock waits. */
      dataExpected?: () => boolean;
      /** How often the socket is looked at (default TICK_MS). */
      tickMs?: number;
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

  /** One message on the live socket now; false while it is not open. */
  send(msg: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /** Resubscribe on the live socket (the market list changed). */
  resubscribe(): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) void this.subscribe((m) => ws.send(JSON.stringify(m)));
  }

  private connect(): void {
    if (!this.running || this.ws) return;
    // No compression on any feed. An inflated frame takes a turn of the event loop through the zlib pool, so on this
    // thread, busy with builds, a socket reads about one frame per turn, whatever is waiting. Measured 2026-11-06 on a
    // thread busy 150 ms a turn, one SoDEX socket: with compression 43 s behind after 90 s and 333 of 876 trades read;
    // without, 0.26 s behind and all 876. A venue sending many small frames loses the most: SoDEX sends one per trade.
    // closeTimeout: in ws, not yet in its published types.
    const options: ClientOptions & { closeTimeout: number } = { perMessageDeflate: false, handshakeTimeout: HANDSHAKE_MS, closeTimeout: CLOSE_HANDSHAKE_MS };
    const ws = new WebSocket(this.url, options);
    this.ws = ws;
    this.closingAt = 0;
    ws.on('open', () => {
      this.attempt = 0;
      this.openedAt = this.lastMessageAt = this.lastDataAt = Date.now();
      this.stalledMs = 0;
      this.dataStalledMs = 0;
      void Promise.resolve(this.subscribe((m) => ws.send(JSON.stringify(m)))).catch((e: unknown) => {
        this.why = `subscribing failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
        ws.terminate();
      });
    });
    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      this.stalledMs = 0;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        if (this.upSince === null && !this.opts.isData) this.upSince = this.openedAt;
        return;
      }
      const isData = this.opts.isData?.(msg) ?? false;
      if (isData) {
        this.lastDataAt = Date.now();
        this.dataStalledMs = 0;
      }
      // Up from the moment the subscriptions were sent and data flows. Where the feed can be told from the rest, only
      // the feed counts: a socket that answers but delivers nothing was counted as up, and its hours as complete.
      if (this.upSince === null && (isData || !this.opts.isData)) this.upSince = this.openedAt;
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
    const late = Math.max(0, tickedAt - this.lastTickAt - (this.opts.tickMs ?? TICK_MS));
    this.stalledMs += late;
    this.dataStalledMs += late;
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
    const dataSilentMs = this.opts.dataSilentMs;
    if (this.opts.dataExpected?.() === false) {
      this.lastDataAt = Date.now();
      this.dataStalledMs = 0;
    } else if (dataSilentMs !== undefined && Date.now() - this.lastDataAt - this.dataStalledMs > dataSilentMs) {
      this.why = `no data for ${dur(Date.now() - this.lastDataAt)}, though it still answers`;
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

/**
 * Every live perp (default dex and every HIP-3 dex) and every spot pair. A read that failed used to count as an empty list: a
 * start with the main list unread subscribed to what was left and stayed so for 6 hours (MARKETS_REFRESH_MS), its prints unseen.
 * Now the main list or the spot list unread throws, so the socket tries again and says why. A HIP-3 dex unread must not keep the
 * whole venue down: `partial` says so, and the list is read again soon. `first`: no list yet, so it waits behind nothing.
 */
export async function hlMarkets(
  first = false,
  post: <T>(body: { type: string; dex?: string }, o: { ttlMs: number; background: boolean }) => Promise<T> = (b, o) => hlInfo.post(b as never, o),
): Promise<{ markets: string[]; partial: boolean }> {
  const opts = { ttlMs: 60 * 60_000, background: !first };
  const dexes = await post<Array<{ name?: string } | null>>({ type: 'perpDexs' }, opts).catch(() => null);
  const names = ['', ...(Array.isArray(dexes) ? dexes : []).flatMap((d) => (d?.name ? [d.name] : []))];
  const metas = await Promise.all(
    names.map((dex) => post<HlMeta>(dex ? { type: 'meta', dex } : { type: 'meta' }, opts).catch(() => null)),
  );
  const spot = await post<HlSpotMeta>({ type: 'spotMeta' }, opts).catch(() => null);
  if (!metas[0] || !spot) throw new Error('Hyperliquid market list: a read failed');
  const perps = metas.flatMap((m) => (m?.universe ?? []).flatMap((u) => (u.name && !u.isDelisted ? [u.name] : [])));
  const pairs = (spot.universe ?? []).flatMap((u) => (u.name ? [u.name] : []));
  // HL allows 1,000 subscriptions per connection.
  return { markets: [...new Set([...perps, ...pairs])].slice(0, 990), partial: !dexes || metas.some((m) => !m) };
}

/** How soon a list with a dex unread is read again (what was read is cached, so only the missing reads go out). */
const HL_PARTIAL_RETRY_MS = 60_000;

/** The whole venue on one socket and always trading: over 60 s without a fresh print means the socket, not the market. */
const HL_DATA_SILENT_MS = 60_000;
const isHlFresh = (msg: unknown): boolean => {
  const m = msg as { channel?: unknown; data?: unknown } | null;
  return m?.channel === 'trades' && hasFreshPrint(m.data, (t: { time?: unknown }) => t?.time);
};

/**
 * Hyperliquid counts trade subscriptions PER IP, at most 1,000 (measured 2026-11-09: two sockets from one address asking
 * for all 697 markets got 1,000 acks between them and "Cannot subscribe to more than 1000 channels." for the other 394).
 * So a handover's standby cannot simply subscribe everything beside the running indexer: markets move across in batches
 * (standby.ts moveHlMarkets) - the standby subscribes some (`take`), and once Hyperliquid confirmed them the running
 * process lets them go (`lend`: unsubscribed, and not subscribed again on a reconnect), so no market is ever without a
 * socket.
 */
export const HL_SUBSCRIPTION_LIMIT = 1_000;

export class HlStream {
  private socket: LiveSocket;
  private markets: string[] = [];
  private subscribed = new Set<string>();
  /** The ids this stream took (a handover names them: handover.ts). */
  readonly dedup = new Dedup();
  private refreshTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  /** Markets handed to a standby (running side): not subscribed here until `unlendAll`. */
  private lent = new Set<string>();
  /** When lent markets came back: the stream counts as reconnected then (their prints meanwhile went to the standby). */
  private backAt = 0;
  /** Standby side: subscribe only the markets taken so far (null: all of them, as usual). */
  private only: Set<string> | null;
  /** Markets Hyperliquid confirmed (subscriptionResponse) on the current socket. */
  readonly acked = new Set<string>();
  /** Hyperliquid's refusals on the current socket (its 1,000 per IP): how many. */
  refusals = 0;

  constructor(private readonly onPrint: (p: Print) => void, url = HL_WS_URL, o: { gradual?: boolean } = {}) {
    this.only = o.gradual ? new Set() : null;
    this.socket = new LiveSocket(
      url,
      JSON.stringify({ method: 'ping' }),
      async (send) => {
        await this.marketList();
        this.subscribed.clear();
        this.acked.clear();
        this.refusals = 0;
        for (const coin of this.markets) {
          if (this.lent.has(coin) || (this.only && !this.only.has(coin))) continue;
          send({ method: 'subscribe', subscription: { type: 'trades', coin } });
          this.subscribed.add(coin);
        }
      },
      (msg) => this.handle(msg),
      // Every market lent (a handover under way), or a standby that took none yet: no data is expected, and the silence
      // must not reconnect the socket.
      { name: 'hyperliquid', log: streamLog, isData: isHlFresh, dataSilentMs: HL_DATA_SILENT_MS, dataExpected: () => this.subscribed.size > 0 },
    );
  }

  /** The market list (read once, as the socket's first subscribe does). */
  async marketList(): Promise<string[]> {
    if (!this.markets.length) {
      const { markets, partial } = await hlMarkets(true);
      this.markets = markets;
      if (partial) this.refreshSoon();
    }
    return this.markets;
  }

  get since(): number | null {
    const up = this.socket.upSince;
    return up === null ? null : Math.max(up, this.backAt);
  }

  /** How many markets are lent to a standby now. */
  get lentCount(): number {
    return this.lent.size;
  }

  /** Running side: stop receiving these markets (the standby has them). */
  lend(coins: readonly string[]): void {
    for (const coin of coins) {
      if (this.lent.has(coin)) continue;
      this.lent.add(coin);
      if (this.subscribed.delete(coin)) this.socket.send({ method: 'unsubscribe', subscription: { type: 'trades', coin } });
    }
  }

  /** Running side: the standby went away - every lent market subscribed again here. */
  unlendAll(): number {
    const n = this.lent.size;
    if (!n) return 0;
    const back = [...this.lent];
    this.lent.clear();
    this.backAt = Date.now();
    for (const coin of back) {
      if (this.socket.send({ method: 'subscribe', subscription: { type: 'trades', coin } })) this.subscribed.add(coin);
    }
    return n;
  }

  /** Standby side: subscribe these markets too. */
  take(coins: readonly string[]): void {
    if (!this.only) return;
    for (const coin of coins) {
      this.only.add(coin);
      if (this.socket.send({ method: 'subscribe', subscription: { type: 'trades', coin } })) this.subscribed.add(coin);
    }
  }

  /** Standby side, once it writes: every market not confirmed yet as well, and a reconnect subscribes all. */
  takeAll(): void {
    if (!this.only) return;
    const rest = this.markets.filter((c) => !this.acked.has(c));
    this.only = null;
    for (const coin of rest) {
      if (this.socket.send({ method: 'subscribe', subscription: { type: 'trades', coin } })) this.subscribed.add(coin);
    }
  }

  /** Every market not confirmed (nor lent) asked for again; how many. After a takeover, the old socket's may be freed late. */
  subscribeMissing(): number {
    if (this.only) return 0;
    let n = 0;
    for (const coin of this.markets) {
      if (this.acked.has(coin) || this.lent.has(coin)) continue;
      if (this.socket.send({ method: 'subscribe', subscription: { type: 'trades', coin } })) { this.subscribed.add(coin); n++; }
    }
    return n;
  }

  start(): void {
    this.socket.start();
    this.refreshTimer = setInterval(() => this.refresh(), MARKETS_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  private refresh(): void {
    void hlMarkets().then(({ markets, partial }) => {
      if (markets.length && markets.some((c) => !this.subscribed.has(c) && !this.lent.has(c) && (!this.only || this.only.has(c)))) {
        this.markets = markets;
        this.socket.resubscribe();
      }
      if (partial) this.refreshSoon();
    }).catch(() => this.refreshSoon());
  }

  private refreshSoon(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.refresh();
    }, HL_PARTIAL_RETRY_MS);
    this.retryTimer.unref?.();
  }

  stop(): void {
    this.socket.stop();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /** One raw message. Public for tests. */
  handle(msg: unknown): void {
    const m = msg as { channel?: string; data?: unknown };
    if (m?.channel === 'subscriptionResponse') {
      const d = m.data as { method?: string; subscription?: { coin?: unknown } } | undefined;
      const coin = d?.subscription?.coin;
      if (d?.method === 'subscribe' && typeof coin === 'string') this.acked.add(coin);
      else if (d?.method === 'unsubscribe' && typeof coin === 'string') this.acked.delete(coin);
      return;
    }
    if (m?.channel === 'error') {
      // "Cannot subscribe to more than 1000 channels." names no market: the ones never acked are the refused ones.
      this.refusals++;
      return;
    }
    if (m?.channel !== 'trades' || !Array.isArray(m.data)) return;
    for (const t of m.data as HlWsTrade[]) {
      const p = hlPrint(t);
      if (p && this.dedup.add(p.id, p.t)) this.onPrint(p);
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

export type { SodexWsTrade };

export function sodexPrint(t: SodexWsTrade): Print | null {
  if (!t || typeof t.t !== 'number' || typeof t.s !== 'string' || typeof t.T !== 'number') return null;
  const px = Number(t.p);
  const sz = Number(t.q);
  if (!(px > 0) || !(sz > 0) || !Number.isInteger(t.bi) || !Number.isInteger(t.si)) return null;
  // `S` is the taker's side, as on Hyperliquid and Arcus.
  const taker = t.S === 'BUY' ? 'buyer' as const : t.S === 'SELL' ? 'seller' as const : undefined;
  return { venue: 'sodex', id: `${t.s}:${t.t}`, t: t.T, symbol: t.s, px, sz, buyer: String(t.bi), seller: String(t.si), ...(taker ? { taker } : {}) };
}

/**
 * A SODEX SOCKET CAN GO ON ANSWERING PINGS AND DELIVER NO TRADES. Measured 2026-11-06: the perps socket delivered no
 * trade from 03:00 to 08:10 UTC while it counted as up, so no gap was recorded and the hours came out short. Hours
 * without such a silence match SoDEX's own candles (2026-11-06 01:00: 7,632 of 7,632 trades), so this silence is the
 * loss. Why it stops is not known: a 12 s stall of this thread came just before that one, but a test client blocked
 * for 30 s and 90 s got its trades back with the backlog. So on SoDEX only a trade proves the feed. The limits are
 * above the quietest real market: over 1,000 minutes neither book had more than 1 empty minute in a row.
 */
const SODEX_DATA_SILENT_MS: Readonly<Record<'perps' | 'spot', number>> = { perps: 90_000, spot: 180_000 };
const isSodexFresh = (msg: unknown): boolean => {
  const m = msg as { channel?: unknown; data?: unknown } | null;
  return m?.channel === 'trade' && hasFreshPrint(m.data, (t: { T?: unknown }) => t?.T);
};

export class SodexStream {
  private sockets: LiveSocket[];
  /** The ids this stream took (a handover names them: handover.ts). */
  readonly dedup = new Dedup();
  /** The last good list: a failed REST call never takes a live feed down. */
  private symbols: Partial<Record<'perps' | 'spot', string[]>> = {};

  constructor(private readonly onPrint: (p: Print) => void, wsBase = NET.wsBase) {
    this.sockets = (['perps', 'spot'] as const).map(
      (engine) =>
        new LiveSocket(
          `${wsBase}/ws/${engine}`,
          JSON.stringify({ op: 'ping' }),
          async (send) => {
            const read = await sodexSymbols(engine).catch((e: unknown) => {
              if (!this.symbols[engine]?.length) throw e;
              return [];
            });
            if (read.length) this.symbols[engine] = read;
            const symbols = this.symbols[engine] ?? [];
            if (symbols.length) send({ op: 'subscribe', params: { channel: 'trade', symbols } });
          },
          (msg) => this.handle(msg),
          { name: `sodex-${engine}`, log: streamLog, isData: isSodexFresh, dataSilentMs: SODEX_DATA_SILENT_MS[engine] },
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
      if (p && this.dedup.add(p.id, p.t)) this.onPrint(p);
    }
  }

  /** Trades read over REST: the ones this run has not seen and `missing` says are not held go in as prints. How many did. */
  catchUp(rows: readonly SodexWsTrade[], missing: (prints: readonly Print[]) => Print[]): Print[] {
    return catchUpRows(rows, sodexPrint, this.dedup, missing, this.onPrint);
  }
}

/**
 * What the catch-up adds: never a row this run's stream brought or added, and of the rest what `missing` says is not held.
 * `every`: `missing` sees the rows already seen too. Where it matches with a margin each must take its own held print, or a lost
 * trade could take a neighbour's.
 */
function catchUpRows<R>(rows: readonly R[], print: (r: R) => Print | null, dedup: Dedup, missing: (prints: readonly Print[]) => Print[], sink: (p: Print) => void, every = false): Print[] {
  const fresh: Print[] = [];
  for (const r of rows) {
    const p = print(r);
    if (p && (every || !dedup.has(p.id))) fresh.push(p);
  }
  const added: Print[] = [];
  for (const p of missing(fresh)) {
    if (!dedup.add(p.id, p.t)) continue;
    sink(p);
    added.push(p);
  }
  return added;
}

// --- Arcus -----------------------------------------------------------------------------

export interface ArcusWsTrade {
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
/** Arcus's thinnest hours are not measured over a weekend: this is above what 5 days showed, and a wrong cut costs 1 s. */
const ARCUS_DATA_SILENT_MS = 120_000;
const isArcusFresh = (msg: unknown): boolean => {
  const m = msg as { type?: unknown; channel?: unknown; contents?: unknown } | null;
  return m?.type === 'channel_data' && m.channel === 'trades'
    && hasFreshPrint(m.contents, (t: { timestamp?: unknown }) => (typeof t?.timestamp === 'number' ? t.timestamp / 1000 : undefined));
};

export class ArcusStream {
  private socket: LiveSocket;
  /** The ids this stream took (a handover names them: handover.ts). */
  readonly dedup = new Dedup();
  /**
   * The last good list. A failed market read used to end the socket with nothing logged, each time: 302 closes and
   * 305 silent minutes from 2026-11-01 to 11-06 while the REST side was slow.
   */
  private lastMarkets: string[] = [];

  constructor(private readonly onPrint: (p: Print) => void, markets: () => Promise<string[]>, url: string) {
    this.socket = new LiveSocket(
      url,
      JSON.stringify({ type: 'ping' }),
      async (send) => {
        const read = await markets().catch((e: unknown) => {
          if (!this.lastMarkets.length) throw e;
          return [];
        });
        if (read.length) this.lastMarkets = read;
        for (const id of this.lastMarkets.slice(0, 100)) send({ type: 'subscribe', channel: 'trades', id });
      },
      (msg) => this.handle(msg),
      { name: 'arcus', log: streamLog, isData: isArcusFresh, dataSilentMs: ARCUS_DATA_SILENT_MS },
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
      if (p && this.dedup.add(p.id, p.t)) this.onPrint(p);
    }
  }

  /** As SodexStream.catchUp; `sink` takes what goes in, as an old print goes less far than a live one (engine.ts). */
  catchUp(rows: readonly ArcusWsTrade[], missing: (prints: readonly Print[]) => Print[], sink: (p: Print) => void = this.onPrint): Print[] {
    return catchUpRows(rows, arcusPrint, this.dedup, missing, sink, true);
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

const isLighterFresh = (msg: unknown): boolean => {
  const m = msg as { type?: unknown; trades?: unknown; liquidation_trades?: unknown } | null;
  if (m?.type !== 'update/trade') return false;
  const at = (t: { timestamp?: unknown }) => t?.timestamp;
  return hasFreshPrint(m.trades, at) || hasFreshPrint(m.liquidation_trades, at);
};

export class LighterStream {
  /** A full socket with no fresh print this long is deaf. */
  private static readonly DATA_SILENT_MS = 180_000;
  private sockets: LiveSocket[] = [];
  /** The ids this stream took (a handover names them: handover.ts). */
  readonly dedup = new Dedup();
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
  /** Each socket's subscribes not yet answered, oldest first: an "Invalid Channel" answer names no market, and Lighter answers in order, so it is the oldest. */
  private unanswered: Array<number[]> = [];
  /**
   * Markets Lighter refused ("Invalid Channel", code 30005): not asked again, and not waited for, until the next market
   * refresh. 2026-11-16 11:14 UTC: after Lighter's restart one market of socket 4 was refused every 20 s for hours,
   * the socket never counted as whole, and the stream showed down (an open incident) with 219 of 220 markets flowing.
   */
  private rejected = new Set<number>();
  private refreshTimer?: NodeJS.Timeout;
  /** The active market list is read again this often: Lighter lists and delists markets while we run. */
  static REFRESH_MS = 30 * 60_000;
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
    return { confirmed: this.confirmed.reduce((n, s) => n + s.size, 0), markets: this.groups.reduce((n, g) => n + this.wanted(g).length, 0) };
  }

  /** A socket's markets less the ones Lighter refused. */
  private wanted(group: readonly number[]): number[] {
    return this.rejected.size ? group.filter((g) => !this.rejected.has(g)) : [...group];
  }

  /** Mark socket `i` whole once every market it still wants is confirmed. */
  private checkReady(i: number): void {
    const conf = this.confirmed[i];
    if (!conf || this.readyAt[i] != null) return;
    if (!this.wanted(this.groups[i]!).every((g) => conf.has(g))) return;
    this.readyAt[i] = Date.now();
    const took = this.openAt[i] ? ` in ${Math.round((this.readyAt[i]! - this.openAt[i]!) / 1000)} s` : '';
    this.log(`stream lighter#${i + 1}: all ${conf.size} markets confirmed${took}`);
  }

  /**
   * Read the active markets again: delisted ones leave their socket (no longer waited for), new ones join the socket
   * with the fewest, and refused ones are tried once more. Public for tests.
   */
  async refresh(): Promise<void> {
    let now: Map<number, string>;
    try {
      now = await this.markets();
    } catch {
      return; // the next refresh tries again
    }
    if (!now.size) return;
    const had = new Set(this.groups.flat());
    const gone = [...had].filter((id) => !now.has(id));
    const added = [...now.keys()].filter((id) => !had.has(id)).sort((a, b) => a - b);
    for (const [id, sym] of now) this.symbols.set(id, sym);
    this.groups = this.groups.map((g, i) => {
      const keep = g.filter((id) => now.has(id));
      for (const id of gone) this.confirmed[i]?.delete(id);
      return keep;
    });
    for (const id of added) {
      let best = 0;
      for (let i = 1; i < this.groups.length; i++) if (this.groups[i]!.length < this.groups[best]!.length) best = i;
      if (this.groups[best]) this.groups[best]!.push(id);
    }
    const retried = this.rejected.size;
    this.rejected.clear();
    if (gone.length || added.length || retried) {
      this.log(`stream lighter: markets refreshed, ${gone.length} delisted (${gone.join(', ') || '-'}), ${added.length} new (${added.join(', ') || '-'}), ${retried} refused tried again`);
    }
    this.groups.forEach((_, i) => { if (this.sendFns[i]) this.checkReady(i); });
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
          this.unanswered[i] = [];
          this.readyAt[i] = null;
          this.sendFns[i] = send;
          this.openAt[i] = Date.now();
        },
        (msg) => this.handle(i, msg),
        {
          pingMs: LighterStream.PING_MS, staleMs: LighterStream.STALE_MS, name: `lighter#${i + 1}`, log: this.log,
          // A full socket trades all the time; the last one may hold a few thin markets and can be really quiet. A socket
          // still subscribing is left alone: cutting it would only start its ~90 s again.
          ...(group.length >= LighterStream.PER_SOCKET
            ? { isData: isLighterFresh, dataSilentMs: LighterStream.DATA_SILENT_MS, dataExpected: () => this.readyAt[i] != null }
            : {}),
          onClose: () => { this.sendFns[i] = null; this.readyAt[i] = null; },
        },
      ));
    });
    for (const s of this.sockets) s.start();
    this.timer = setInterval(() => this.pump(), 100);
    this.timer.unref?.();
    this.refreshTimer = setInterval(() => void this.refresh(), LighterStream.REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
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
        const id = this.groups[i]!.find((g) => !this.confirmed[i]!.has(g) && !this.rejected.has(g) && !(now - (this.sentAt[i]!.get(g) ?? -Infinity) < LighterStream.CONFIRM_MS));
        if (id === undefined) continue;
        try {
          send({ type: 'subscribe', channel: `trade/${id}` });
        } catch {
          owed = 0;
          break;
        }
        this.sentAt[i]!.set(id, now);
        (this.unanswered[i] ??= []).push(id);
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
    const m = msg as { type?: string; channel?: string; trades?: unknown; liquidation_trades?: unknown; error?: { code?: unknown } };
    // Anything but prints, confirmations and the socket's own chatter is Lighter telling us something (an error, a limit).
    const kind = typeof m?.type === 'string' ? m.type : 'no-type';
    if (!LIGHTER_QUIET.has(kind)) {
      const n = (this.others.get(kind) ?? 0) + 1;
      this.others.set(kind, n);
      if (n <= 3 || n % 100 === 0) this.log(`stream lighter#${i + 1}: Lighter said (${kind} #${n}) ${JSON.stringify(msg).slice(0, 200)}`);
    }
    if (m?.error?.code === 30005) {
      const id = this.unanswered[i]?.shift();
      if (id != null && !this.confirmed[i]?.has(id) && !this.rejected.has(id)) {
        this.rejected.add(id);
        this.log(`stream lighter#${i + 1}: Lighter refused market ${id} (${this.symbols.get(id) ?? '?'}); not waited for until the next market refresh`);
        this.checkReady(i);
      }
      return;
    }
    if (typeof m?.type !== 'string' || typeof m.channel !== 'string' || !m.channel.startsWith('trade:')) return;
    if (m.type === 'subscribed/trade') {
      const id = Number(m.channel.slice(6));
      const conf = this.confirmed[i];
      if (conf && Number.isInteger(id)) {
        conf.add(id);
        const q = this.unanswered[i];
        const at = q ? q.indexOf(id) : -1;
        if (at >= 0) q!.splice(0, at + 1);
        this.checkReady(i);
      }
    }
    if (m.type !== 'update/trade' && m.type !== 'subscribed/trade') return;
    for (const list of [m.trades, m.liquidation_trades]) {
      if (!Array.isArray(list)) continue;
      for (const t of list as LighterWsTrade[]) {
        const p = lighterPrint(t, (id) => this.symbols.get(id) ?? null);
        if (p && this.dedup.add(p.id, p.t)) this.onPrint(p);
      }
    }
  }
}
