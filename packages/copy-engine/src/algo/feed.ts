/**
 * What an algo sees of the market, and of its own orders, from ONE SoDEX
 * perps socket:
 *
 *   bookTicker          best bid / ask per watched market (where children are priced);
 *   trade               every print, with buyer and seller account ids: POV's volume
 *                       (the algo's own prints left out), the market VWAP it is
 *                       measured against, the last price, and paper fills;
 *   allMarkPrice        mark, index, funding and open interest (conditions, bounds);
 *   accountOrderUpdate  the trader's own order updates, by wallet (SoDEX serves any
 *                       wallet's without auth): every child's cumulative fill, by
 *                       client order id - the books follow these, not guesses.
 *                       At most ACCOUNT_USERS_PER_IP wallets (SoDEX's limit per IP);
 *                       the runtime reads the others' orders by REST (pollOrders).
 *
 * Prices are sampled once a second into an hour of history per market, so a
 * condition can ask how far a price or the open interest has moved within a
 * window; prints are kept an hour for volume windows.
 */
import { GATEWAY_WS_ORIGIN, type Network } from '../../../sodex-core/src/index.ts';
import { timers, type Logger, type WebSocketFactory } from '../io.ts';
import { LiveSocket } from '../socket.ts';
import type { Quote } from './math.ts';
import type { PriceSource, Side } from './types.ts';

export interface Print {
  symbol: string;
  price: number;
  qty: number;
  /** Account ids of both sides (-1 when not given). */
  buyer: number;
  seller: number;
  taker: Side;
  at: number;
}

export interface OrderUpdate {
  clOrdID: string;
  orderId: string | null;
  symbol: string;
  /** NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, EXPIRED... */
  status: string;
  /** Cumulative over the order's life. */
  filledQty: number;
  filledValue: number;
  /** This execution was a maker fill (null: not said). */
  maker: boolean | null;
  reason: string | null;
  at: number;
}

export interface MarkInfo {
  mark: number;
  index: number | null;
  funding: number | null;
  oi: number | null;
  at: number;
}

/** The market data and order updates an algo runtime reads. The feed below; tests pass a fake. */
export interface AlgoMarket {
  start(): void;
  stop(): void;
  readonly up: boolean;
  /**
   * The markets to watch and the wallets whose order updates to follow
   * (replaces the previous sets). `owners` most important first: when there
   * are more than the socket may follow, the first ones get the socket.
   */
  watch(symbols: readonly string[], owners: readonly string[]): void;
  /**
   * Whether this wallet's order updates arrive on the socket now. false: the
   * runtime reads its orders by REST instead (AlgoRuntime.pollOrders). Absent
   * (a test's fake): every wallet is followed.
   */
  followsOrders?(owner: string): boolean;
  quote(symbol: string): Quote | null;
  last(symbol: string): { price: number; at: number } | null;
  mark(symbol: string): MarkInfo | null;
  price(symbol: string, source: PriceSource): number | null;
  /** The price `agoMs` ago (nearest sample), or null when there is no sample that old. */
  priceAgo(symbol: string, source: PriceSource, agoMs: number): number | null;
  oiAgo(symbol: string, agoMs: number): number | null;
  /** Traded within the last `windowMs`: base units and USD. */
  volume(symbol: string, windowMs: number): { qty: number; usd: number };
  onPrint(cb: (p: Print) => void): void;
  onOrder(cb: (u: OrderUpdate) => void): void;
  onState(cb: (up: boolean) => void): void;
  /** A market's best bid or ask changed (owner 2026-11-09: bots act on every update). Absent: a test's fake. */
  onQuote?(cb: (symbol: string) => void): void;
}

/** A quote older than this is not a price. */
export const QUOTE_MAX_AGE_MS = 15_000;
/**
 * ...and for a bot, this (audit 2026-11-08): a bot rests quotes at the touch, and a touch 15 s old is where takers
 * fill them after the price has gone. The feed keeps quotes fresh on still markets (refreshQuotes), so a bot holds
 * only when SoDEX's prices really stop coming.
 */
export const BOT_QUOTE_MAX_AGE_MS = 3_000;
/** A watched market's quote older than this is read by REST (refreshQuotes)... */
const QUOTE_REFRESH_AGE_MS = 1_000;
/** ...at most this often for all of them (one read of every market's best prices, weight 2). */
const QUOTE_REFRESH_EVERY_MS = 1_500;
const HISTORY_MS = 60 * 60_000;

interface Sample {
  t: number;
  mark: number | null;
  mid: number | null;
  last: number | null;
  index: number | null;
  oi: number | null;
}

const toNum = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const rows = (d: unknown): Array<Record<string, unknown>> =>
  Array.isArray(d) ? (d as Array<Record<string, unknown>>) : d && typeof d === 'object' ? [d as Record<string, unknown>] : [];

export interface AlgoFeedOptions {
  network: Network;
  factory: WebSocketFactory;
  log?: Logger;
  /** Override the gateway origin (tests). */
  wsOrigin?: string;
  /** Wallets one socket (one IP) may follow on account channels (default ACCOUNT_USERS_PER_IP). */
  maxAccountUsers?: number;
  /**
   * More sockets for account channels only, each leaving from its own address (owner 2026-11-09: "our bots always need
   * to be connected via ws. Always."): SoDEX's limit is per IP, so each one follows another maxAccountUsers wallets.
   */
  accountFactories?: WebSocketFactory[];
  /**
   * SoDEX's best prices of every market by REST (GET /api/v1/perps/markets/bookTickers). The socket's bookTicker
   * may stay silent while a market does not move: a watched quote that ages is read here (refreshQuotes), so a still
   * market keeps a fresh price. Absent: socket only.
   */
  bookTickers?: () => Promise<unknown>;
}

/**
 * SoDEX's documented limit: 10 unique users per IP on account channels
 * (docs/research/01-sodex-valuechain.md, WS account channels). Every hosted
 * algo leaves the executor from one IP, so one socket follows at most this
 * many wallets' order updates; the others are read by REST (pollOrders).
 */
export const ACCOUNT_USERS_PER_IP = 10;

export class AlgoFeed implements AlgoMarket {
  private socket: LiveSocket;
  private symbols = new Set<string>();
  /** The wallets the socket follows: at most maxAccountUsers, most important first. */
  private owners = new Set<string>();
  private subscribed = { symbols: new Set<string>(), owners: new Set<string>(), marks: false };
  private quotes = new Map<string, Quote>();
  private lasts = new Map<string, { price: number; at: number }>();
  private marks = new Map<string, MarkInfo>();
  private history = new Map<string, Sample[]>();
  private tape = new Map<string, Array<{ t: number; q: number; usd: number }>>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private printCbs: Array<(p: Print) => void> = [];
  private orderCbs: Array<(u: OrderUpdate) => void> = [];
  private stateCbs: Array<(up: boolean) => void> = [];
  private sampler: unknown = null;
  /** The extra account sockets (accountFactories): each follows its own wallets, account channels only. */
  private extras: Array<{ socket: LiveSocket; owners: Set<string>; subscribed: Set<string> }> = [];
  private refreshing = false;
  private refreshedAt = 0;

  constructor(private readonly o: AlgoFeedOptions) {
    const origin = o.wsOrigin ?? GATEWAY_WS_ORIGIN[o.network];
    this.socket = new LiveSocket({
      url: `${origin}/ws/perps`,
      factory: o.factory,
      ping: '{"op":"ping"}',
      name: 'sodex-algo',
      log: o.log,
      subscribe: (send, fresh) => this.subscribeAll(send, fresh),
      onMessage: (m) => this.handle(m),
      onState: (up) => {
        for (const cb of this.stateCbs) cb(up);
      },
    });
    for (const [k, factory] of (o.accountFactories ?? []).entries()) {
      const x = { socket: null as unknown as LiveSocket, owners: new Set<string>(), subscribed: new Set<string>() };
      x.socket = new LiveSocket({
        url: `${origin}/ws/perps`,
        factory,
        ping: '{"op":"ping"}',
        name: `sodex-account-${k + 1}`,
        log: o.log,
        subscribe: (send, fresh) => {
          if (fresh) x.subscribed = new Set();
          let id = 9_000;
          for (const w of [...x.subscribed]) if (!x.owners.has(w)) { send({ op: 'unsubscribe', id: id++, params: { channel: 'accountOrderUpdate', user: w } }); x.subscribed.delete(w); }
          for (const w of x.owners) if (!x.subscribed.has(w)) { send({ op: 'subscribe', id: id++, params: { channel: 'accountOrderUpdate', user: w } }); x.subscribed.add(w); }
        },
        onMessage: (m) => this.handle(m),
      });
      this.extras.push(x);
    }
  }

  /** Wallets the sockets can follow at once (every socket's places). */
  get accountCapacity(): number {
    return Math.max(0, this.o.maxAccountUsers ?? ACCOUNT_USERS_PER_IP) * (1 + this.extras.length);
  }

  start(): void {
    this.socket.start();
    for (const x of this.extras) x.socket.start();
    this.sampler ??= timers.every(500, () => {
      const now = Date.now();
      if (now - this.sampledAt >= 1_000) this.sample(now);
      void this.refreshQuotes(now);
    });
  }

  stop(): void {
    this.socket.stop();
    for (const x of this.extras) x.socket.stop();
    timers.cancel(this.sampler);
    this.sampler = null;
  }

  get up(): boolean {
    return this.socket.up;
  }

  watch(symbols: readonly string[], owners: readonly string[]): void {
    const s = new Set(symbols.map((x) => x.toUpperCase()));
    const want = [...new Set(owners.map((x) => x.toLowerCase()))];
    // Who keeps the socket: a wallet it follows already stays (no churn), the free places go in order of importance.
    const cap = Math.max(0, this.o.maxAccountUsers ?? ACCOUNT_USERS_PER_IP);
    const w = new Set(want.filter((x) => this.owners.has(x)).slice(0, cap));
    for (const x of want) if (w.size < cap) w.add(x);
    const changed = [...s].some((x) => !this.subscribed.symbols.has(x)) || [...w].some((x) => !this.subscribed.owners.has(x)) || [...this.subscribed.owners].some((x) => !w.has(x));
    this.symbols = s;
    this.owners = w;
    if (changed) this.socket.resubscribe();
    // The rest on the extra sockets, in order: each keeps the wallets it follows, the free places go in order.
    const rest = want.filter((x) => !w.has(x));
    const left = new Set(rest);
    for (const x of this.extras) {
      const keep = [...x.owners].filter((o) => left.has(o)).slice(0, cap);
      const next = new Set(keep);
      for (const o of keep) left.delete(o);
      x.owners = next;
    }
    for (const x of this.extras) for (const o of [...left]) if (x.owners.size < cap) { x.owners.add(o); left.delete(o); }
    for (const x of this.extras) {
      const diff = [...x.owners].some((o) => !x.subscribed.has(o)) || [...x.subscribed].some((o) => !x.owners.has(o));
      if (diff) x.socket.resubscribe();
    }
  }

  followsOrders(owner: string): boolean {
    const o = owner.toLowerCase();
    if (this.socket.up && this.subscribed.owners.has(o)) return true;
    return this.extras.some((x) => x.socket.up && x.subscribed.has(o));
  }

  private subscribeAll(send: (m: unknown) => void, fresh: boolean): void {
    if (fresh) {
      this.subscribed = { symbols: new Set(), owners: new Set(), marks: false };
    }
    let id = 500;
    if (!this.subscribed.marks) {
      send({ op: 'subscribe', id: id++, params: { channel: 'allMarkPrice' } });
      this.subscribed.marks = true;
    }
    const add = [...this.symbols].filter((s) => !this.subscribed.symbols.has(s));
    for (let i = 0; i < add.length; i += 40) {
      const chunk = add.slice(i, i + 40);
      send({ op: 'subscribe', id: id++, params: { channel: 'bookTicker', symbols: chunk } });
      send({ op: 'subscribe', id: id++, params: { channel: 'trade', symbols: chunk } });
      for (const s of chunk) this.subscribed.symbols.add(s);
    }
    // A wallet that lost its place (or no longer has an algo) frees it first: the per-IP count is of users subscribed now.
    for (const w of [...this.subscribed.owners]) {
      if (this.owners.has(w)) continue;
      send({ op: 'unsubscribe', id: id++, params: { channel: 'accountOrderUpdate', user: w } });
      this.subscribed.owners.delete(w);
    }
    for (const w of this.owners) {
      if (this.subscribed.owners.has(w)) continue;
      send({ op: 'subscribe', id: id++, params: { channel: 'accountOrderUpdate', user: w } });
      this.subscribed.owners.add(w);
    }
  }

  private dedupe(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 20_000) for (const x of this.seenOrder.splice(0, 5_000)) this.seen.delete(x);
    return true;
  }

  /** Feed one gateway message (also how tests drive it). */
  handle(m: unknown): void {
    const msg = m as { channel?: string; data?: unknown };
    const ch = msg?.channel;
    if (!ch) return;
    const now = Date.now();
    if (ch === 'bookTicker') {
      for (const r of rows(msg.data)) {
        const s = typeof r.s === 'string' ? r.s.toUpperCase() : null;
        const bid = toNum(r.b);
        const ask = toNum(r.a);
        const bidSz = toNum(r.B);
        const askSz = toNum(r.A);
        if (s && bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid) {
          const prev = this.quotes.get(s);
          this.quotes.set(s, { bid, ask, at: now, ...(bidSz !== null && bidSz >= 0 ? { bidSz } : {}), ...(askSz !== null && askSz >= 0 ? { askSz } : {}) });
          if (!prev || prev.bid !== bid || prev.ask !== ask) for (const cb of this.quoteCbs) cb(s);
        }
      }
      return;
    }
    if (ch === 'allMarkPrice' || ch === 'markPrice') {
      for (const r of rows(msg.data)) {
        const s = typeof r.s === 'string' ? r.s.toUpperCase() : null;
        const p = toNum(r.p);
        if (!s || p === null || !(p > 0)) continue;
        const prev = this.marks.get(s);
        this.marks.set(s, {
          mark: p,
          index: toNum(r.i) ?? prev?.index ?? null,
          funding: toNum(r.r) ?? prev?.funding ?? null,
          oi: toNum(r.oi) ?? prev?.oi ?? null,
          at: now,
        });
      }
      return;
    }
    if (ch === 'trade') {
      for (const r of rows(msg.data)) {
        const s = typeof r.s === 'string' ? r.s.toUpperCase() : null;
        const price = toNum(r.p);
        const qty = toNum(r.q);
        if (!s || price === null || qty === null || !(price > 0) || !(qty > 0)) continue;
        if (!this.dedupe(`t:${s}:${String(r.t ?? `${r.T}:${r.p}:${r.q}`)}`)) continue;
        const at = toNum(r.T) ?? now;
        this.lasts.set(s, { price, at });
        let list = this.tape.get(s);
        if (!list) this.tape.set(s, (list = []));
        list.push({ t: at, q: qty, usd: qty * price });
        if (list.length > 50_000 || (list[0] && list[0].t < at - HISTORY_MS)) {
          const cut = list.findIndex((x) => x.t >= at - HISTORY_MS);
          list.splice(0, cut < 0 ? list.length : cut);
        }
        const p: Print = {
          symbol: s,
          price,
          qty,
          buyer: typeof r.bi === 'number' ? r.bi : -1,
          seller: typeof r.si === 'number' ? r.si : -1,
          taker: r.S === 'SELL' ? 'sell' : 'buy',
          at,
        };
        for (const cb of this.printCbs) cb(p);
      }
      return;
    }
    if (ch === 'accountOrderUpdate') {
      for (const r of rows(msg.data)) {
        const c = typeof r.c === 'string' ? r.c : null;
        if (!c) continue;
        const u: OrderUpdate = {
          clOrdID: c,
          orderId: r.i === undefined || r.i === null ? null : String(r.i),
          symbol: typeof r.s === 'string' ? r.s.toUpperCase() : '',
          status: String(r.X ?? r.x ?? '').toUpperCase(),
          filledQty: toNum(r.z) ?? 0,
          filledValue: toNum(r.v) ?? 0,
          maker: typeof r.m === 'boolean' ? r.m : null,
          reason: typeof r.r === 'string' ? r.r : null,
          at: toNum(r.E) ?? now,
        };
        for (const cb of this.orderCbs) cb(u);
      }
    }
  }

  /**
   * Watched markets whose quote is older than QUOTE_REFRESH_AGE_MS (a still market the socket says nothing about, or
   * a subscription that went quiet) read their best prices by REST - at most every QUOTE_REFRESH_EVERY_MS, one read
   * for all of them. A REST answer never overwrites a socket quote newer than the read.
   */
  async refreshQuotes(now = Date.now()): Promise<void> {
    if (!this.o.bookTickers || this.refreshing || now - this.refreshedAt < QUOTE_REFRESH_EVERY_MS || !this.symbols.size) return;
    const stale = [...this.symbols].filter((s) => now - (this.quotes.get(s)?.at ?? 0) > QUOTE_REFRESH_AGE_MS);
    if (!stale.length) return;
    this.refreshing = true;
    this.refreshedAt = now;
    try {
      const data = await this.o.bookTickers();
      const list = Array.isArray(data) ? data : ((data as { bookTickers?: unknown[] } | null)?.bookTickers ?? []);
      const at = Date.now();
      for (const r of list as Array<Record<string, unknown>>) {
        const s = typeof r.symbol === 'string' ? r.symbol.toUpperCase() : typeof r.s === 'string' ? r.s.toUpperCase() : null;
        if (!s || !stale.includes(s)) continue;
        const bid = toNum(r.bidPx ?? r.bidPrice ?? r.b);
        const ask = toNum(r.askPx ?? r.askPrice ?? r.a);
        if (bid === null || ask === null || !(bid > 0) || !(ask >= bid)) continue;
        const prev = this.quotes.get(s);
        if (prev && prev.at >= now) continue;
        const bidSz = toNum(r.bidSz ?? r.bidQty ?? r.B);
        const askSz = toNum(r.askSz ?? r.askQty ?? r.A);
        this.quotes.set(s, { bid, ask, at, ...(bidSz !== null && bidSz >= 0 ? { bidSz } : {}), ...(askSz !== null && askSz >= 0 ? { askSz } : {}) });
      }
    } catch (e) {
      this.o.log?.warn('algo feed: best prices by REST failed', { error: String(e) });
    } finally {
      this.refreshing = false;
    }
  }

  private sampledAt = 0;

  private sample(now = Date.now()): void {
    this.sampledAt = now;
    for (const s of this.symbols) {
      const q = this.quote(s);
      const m = this.marks.get(s);
      const l = this.lasts.get(s);
      let list = this.history.get(s);
      if (!list) this.history.set(s, (list = []));
      list.push({ t: now, mark: m?.mark ?? null, mid: q ? (q.bid + q.ask) / 2 : null, last: l?.price ?? null, index: m?.index ?? null, oi: m?.oi ?? null });
      if (list.length > 3_700) list.splice(0, list.length - 3_600);
    }
  }

  quote(symbol: string): Quote | null {
    const q = this.quotes.get(symbol.toUpperCase());
    return q && Date.now() - q.at <= QUOTE_MAX_AGE_MS ? q : null;
  }

  last(symbol: string): { price: number; at: number } | null {
    return this.lasts.get(symbol.toUpperCase()) ?? null;
  }

  mark(symbol: string): MarkInfo | null {
    const m = this.marks.get(symbol.toUpperCase());
    return m && Date.now() - m.at <= 120_000 ? m : null;
  }

  price(symbol: string, source: PriceSource): number | null {
    if (source === 'mid') {
      const q = this.quote(symbol);
      return q ? (q.bid + q.ask) / 2 : null;
    }
    if (source === 'last') return this.last(symbol)?.price ?? null;
    const m = this.mark(symbol);
    return source === 'index' ? (m?.index ?? null) : (m?.mark ?? null);
  }

  private sampleAgo(symbol: string, agoMs: number): Sample | null {
    const list = this.history.get(symbol.toUpperCase());
    if (!list?.length) return null;
    const want = Date.now() - agoMs;
    if (list[0]!.t > want + 2_000) return null;
    let best = list[0]!;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.t <= want) {
        best = list[i]!;
        break;
      }
    }
    return best;
  }

  priceAgo(symbol: string, source: PriceSource, agoMs: number): number | null {
    const s = this.sampleAgo(symbol, agoMs);
    if (!s) return null;
    return source === 'mid' ? s.mid : source === 'last' ? s.last : source === 'index' ? s.index : s.mark;
  }

  oiAgo(symbol: string, agoMs: number): number | null {
    return this.sampleAgo(symbol, agoMs)?.oi ?? null;
  }

  volume(symbol: string, windowMs: number): { qty: number; usd: number } {
    const list = this.tape.get(symbol.toUpperCase());
    if (!list) return { qty: 0, usd: 0 };
    const from = Date.now() - windowMs;
    let qty = 0;
    let usd = 0;
    for (let i = list.length - 1; i >= 0 && list[i]!.t >= from; i--) {
      qty += list[i]!.q;
      usd += list[i]!.usd;
    }
    return { qty, usd };
  }

  private quoteCbs: Array<(symbol: string) => void> = [];
  onQuote(cb: (symbol: string) => void): void {
    this.quoteCbs.push(cb);
  }

  onPrint(cb: (p: Print) => void): void {
    this.printCbs.push(cb);
  }

  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }

  onState(cb: (up: boolean) => void): void {
    this.stateCbs.push(cb);
  }
}
