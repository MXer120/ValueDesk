/**
 * Leader feeds: from the venues' public streams to leader position changes.
 *
 * SODEX. The public `trade` stream names both parties of every print by
 * account id (`bi` buyer, `si` seller; research 03 D.1, verified 58/58), so
 * one socket on every perps market sees every leader's fills - and every
 * follower's, which is how the copier learns its own fill prices. A leader's
 * position moves by +q when it bought and -q when it sold. (SoDEX's
 * per-account channels carry no account in their pushes, so they cannot be
 * shared on one socket; the trade stream can.)
 *
 * HYPERLIQUID. `userFills` per leader carries `startPosition`, the exact
 * position before each fill; Hyperliquid allows 10 such users per IP, which
 * suits a browser. An executor following more uses the `trades` stream on
 * every coin, which names `users: [buyer, seller]`.
 *
 * Every leader is SEEDED from REST before its stream counts (the LeaderBook),
 * stream prints older than the seed are ignored, and every leader is re-read
 * on a timer (`reconcileLeaders`): a difference becomes a 'reconcile' event,
 * so a missed print costs one reconcile interval, never a wrong position.
 * Prints of one leader on one market within COALESCE_MS are merged into one
 * change at their VWAP, so an order that prints as forty fills is copied once.
 *
 * A reconcile's REST answer is as old as the moment the read started: a market
 * whose stream printed since (or shortly before, still merging) is left to the
 * stream, so a slow answer neither undoes a newer fill nor counts a fill the
 * stream is about to apply a second time. The next reconcile checks it again.
 */
import { GATEWAY_WS_ORIGIN, type Network } from '../../sodex-core/src/index.ts';
import { timers, type Logger, type WebSocketFactory } from './io.ts';
import { LiveSocket } from './socket.ts';
import type { LeaderEvent, LeaderRef, LeaderVenue } from './types.ts';
import { HL_WS_URL } from './sodex.ts';

export const COALESCE_MS = 150;

/** A fill of a follower's account, seen on the public stream (or its own stream). */
export interface FollowerFill {
  /** `${venue}:${trade id}` - unique. */
  id: string;
  accountId: number;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  qty: number;
  /** Whether the follower took liquidity (copied IOCs always do). */
  taker: boolean;
  time: number;
  /** Known only from the account's own stream. */
  clOrdID: string | null;
  fee: number | null;
}

export interface FeedSink {
  leader(e: LeaderEvent): void;
  follower?(f: FollowerFill): void;
  mark?(symbol: string, price: number, at: number): void;
  state?(feed: string, up: boolean): void;
}

const key = (l: LeaderRef): string => `${l.venue}:${l.address.toLowerCase()}`;

/** The canonical position of every followed leader. */
export class LeaderBook {
  private pos = new Map<string, Map<string, number>>();
  private eq = new Map<string, { value: number; at: number }>();
  private seededAt = new Map<string, number>();
  /** `${leader}|${symbol}` -> when a stream print last arrived there (local clock). */
  private printedAt = new Map<string, number>();
  /** `${leader}|${symbol}` with prints still being merged (not applied yet). */
  private merging = new Set<string>();

  seeded(l: LeaderRef): boolean {
    return this.seededAt.has(key(l));
  }

  seedTime(l: LeaderRef): number | null {
    return this.seededAt.get(key(l)) ?? null;
  }

  positions(l: LeaderRef): Record<string, number> {
    return Object.fromEntries(this.pos.get(key(l)) ?? []);
  }

  position(l: LeaderRef, symbol: string): number {
    return this.pos.get(key(l))?.get(symbol) ?? 0;
  }

  equity(l: LeaderRef): { value: number; at: number } | null {
    return this.eq.get(key(l)) ?? null;
  }

  forget(l: LeaderRef): void {
    this.pos.delete(key(l));
    this.eq.delete(key(l));
    this.seededAt.delete(key(l));
  }

  /** A stream print of the leader on `symbol` arrived; `merging`: it is held to be merged, not applied yet. */
  notePrint(l: LeaderRef, symbol: string, merging: boolean, at = Date.now()): void {
    const k = `${key(l)}|${symbol}`;
    this.printedAt.set(k, at);
    if (merging) this.merging.add(k);
  }

  /** The prints held for the leader on `symbol` were merged (and applied, unless they netted to nothing). */
  merged(l: LeaderRef, symbol: string): void {
    this.merging.delete(`${key(l)}|${symbol}`);
  }

  /** Whether prints of the leader on `symbol` are still being merged: the book is about to change there. */
  isMerging(l: LeaderRef, symbol: string): boolean {
    return this.merging.has(`${key(l)}|${symbol}`);
  }

  /** A position change by `delta` from the stream. Null while the leader is not seeded. */
  applyDelta(l: LeaderRef, symbol: string, delta: number, price: number, time: number, id: string): LeaderEvent | null {
    if (!this.seeded(l) || !Number.isFinite(delta) || delta === 0) return null;
    const m = this.map(l);
    const before = m.get(symbol) ?? 0;
    let after = before + delta;
    if (Math.abs(after) < 1e-12 * Math.max(1, Math.abs(before))) after = 0;
    if (after === 0) m.delete(symbol);
    else m.set(symbol, after);
    return { leader: { venue: l.venue, address: l.address.toLowerCase() }, symbol, before, after, price, time, id, source: 'stream' };
  }

  /** A position change to `after` (a source that knows the total). */
  applyTotal(l: LeaderRef, symbol: string, before: number | null, after: number, price: number, time: number, id: string): LeaderEvent | null {
    if (!this.seeded(l) || !Number.isFinite(after)) return null;
    this.notePrint(l, symbol, false);
    const m = this.map(l);
    const b = before ?? m.get(symbol) ?? 0;
    if (after === 0) m.delete(symbol);
    else m.set(symbol, after);
    if (b === after) return null;
    return { leader: { venue: l.venue, address: l.address.toLowerCase() }, symbol, before: b, after, price, time, id, source: 'stream' };
  }

  /**
   * The REST truth. The first call seeds the leader (no events: whatever is
   * open now is "pre-existing"); later calls emit a 'reconcile' event per
   * market that differs. With `readStart` (when the REST read began), a market
   * a stream print reached since then, or whose prints are still being merged,
   * is left as the stream has it.
   */
  resync(
    l: LeaderRef,
    positions: Record<string, number>,
    equity: number | null,
    marks: Record<string, number>,
    now: number,
    priceOf: (symbol: string) => number | null,
    readStart?: number,
  ): LeaderEvent[] {
    const k = key(l);
    if (equity !== null) this.eq.set(k, { value: equity, at: now });
    if (!this.seededAt.has(k)) {
      this.seededAt.set(k, now);
      this.pos.set(k, new Map(Object.entries(positions).filter(([, v]) => v !== 0)));
      return [];
    }
    const m = this.map(l);
    const out: LeaderEvent[] = [];
    const symbols = new Set([...m.keys(), ...Object.keys(positions)]);
    for (const s of symbols) {
      if (readStart !== undefined) {
        const printed = this.printedAt.get(`${k}|${s}`);
        if ((printed !== undefined && printed >= readStart) || this.merging.has(`${k}|${s}`)) continue;
      }
      const before = m.get(s) ?? 0;
      const after = positions[s] ?? 0;
      if (!Number.isFinite(after)) continue;
      const tol = 1e-9 * Math.max(1, Math.abs(before), Math.abs(after));
      if (Math.abs(before - after) <= tol) continue;
      if (after === 0) m.delete(s);
      else m.set(s, after);
      const price = marks[s] ?? priceOf(s) ?? 0;
      out.push({ leader: { venue: l.venue, address: l.address.toLowerCase() }, symbol: s, before, after, price, time: now, id: `rc:${s}:${now}`, source: 'reconcile' });
    }
    return out;
  }

  private map(l: LeaderRef): Map<string, number> {
    const k = key(l);
    let m = this.pos.get(k);
    if (!m) this.pos.set(k, (m = new Map()));
    return m;
  }
}

/** Merges prints of one (leader, market) arriving within COALESCE_MS. */
class Coalescer {
  private pending = new Map<string, { l: LeaderRef; symbol: string; delta: number; notional: number; qty: number; time: number; ids: string[]; timer: unknown }>();
  constructor(private readonly flush: (l: LeaderRef, symbol: string, delta: number, vwap: number, time: number, id: string) => void) {}

  add(l: LeaderRef, symbol: string, delta: number, price: number, time: number, id: string): void {
    const k = `${key(l)}|${symbol}`;
    let p = this.pending.get(k);
    if (!p) {
      p = { l, symbol, delta: 0, notional: 0, qty: 0, time, ids: [], timer: null };
      this.pending.set(k, p);
      const entry = p;
      // Flushed even when the prints net to nothing, so the book knows the merge is over.
      p.timer = timers.after(COALESCE_MS, () => {
        this.pending.delete(k);
        this.flush(entry.l, entry.symbol, entry.delta, entry.qty > 0 ? entry.notional / entry.qty : 0, entry.time, entry.ids[0]!);
      });
    }
    p.delta += delta;
    p.notional += Math.abs(delta) * price;
    p.qty += Math.abs(delta);
    p.time = Math.max(p.time, time);
    p.ids.push(id);
  }

  stop(): void {
    for (const p of this.pending.values()) timers.cancel(p.timer);
    this.pending.clear();
  }
}

/** Bounded set of seen ids. */
class Seen {
  private set = new Set<string>();
  constructor(private readonly cap = 50_000) {}
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.cap) {
      let n = Math.floor(this.cap / 10);
      for (const k of this.set) {
        this.set.delete(k);
        if (--n <= 0) break;
      }
    }
    return true;
  }
}

/* ------------------------------------------------------------------ SoDEX ----- */

export interface SodexFeedOptions {
  network: Network;
  factory: WebSocketFactory;
  book: LeaderBook;
  sink: FeedSink;
  /** Every perps market name (the trade stream needs them listed). */
  symbols: () => string[];
  log?: Logger;
  wsOrigin?: string;
}

/** SoDEX perps: the `trade` stream on every market, plus `allMarkPrice`. */
export class SodexFeed {
  private socket: LiveSocket;
  private leadersById = new Map<number, LeaderRef>();
  private followers = new Set<number>();
  private seen = new Seen();
  private coalesce: Coalescer;
  private subscribed = new Set<string>();

  constructor(private readonly o: SodexFeedOptions) {
    this.coalesce = new Coalescer((l, symbol, delta, vwap, time, id) => {
      this.o.book.merged(l, symbol);
      const e = delta !== 0 ? this.o.book.applyDelta(l, symbol, delta, vwap, time, id) : null;
      if (e) this.o.sink.leader(e);
    });
    const origin = o.wsOrigin ?? GATEWAY_WS_ORIGIN[o.network];
    this.socket = new LiveSocket({
      url: `${origin}/ws/perps`,
      factory: o.factory,
      ping: '{"op":"ping"}',
      name: 'sodex-perps',
      log: o.log,
      subscribe: (send, fresh) => this.subscribeAll(send, fresh),
      onMessage: (m) => this.handle(m),
      onState: (up) => o.sink.state?.('sodex', up),
    });
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
    this.coalesce.stop();
  }

  get up(): boolean {
    return this.socket.up;
  }

  /** Leaders to follow, by SoDEX account id. */
  setLeaders(list: Array<{ ref: LeaderRef; accountId: number }>): void {
    this.leadersById = new Map(list.filter((x) => x.accountId > 0).map((x) => [x.accountId, x.ref]));
  }

  /** Follower accounts whose fills to report. */
  setFollowers(accountIds: number[]): void {
    this.followers = new Set(accountIds.filter((x) => x > 0));
  }

  /** The market list grew: subscribe the new ones. */
  refreshSymbols(): void {
    this.socket.resubscribe();
  }

  private subscribeAll(send: (m: unknown) => void, fresh: boolean): void {
    if (fresh) {
      this.subscribed.clear();
      send({ op: 'subscribe', id: 1, params: { channel: 'allMarkPrice' } });
    }
    const all = this.o.symbols().filter((s) => !this.subscribed.has(s));
    for (let i = 0; i < all.length; i += 40) {
      const chunk = all.slice(i, i + 40);
      send({ op: 'subscribe', id: 100 + i, params: { channel: 'trade', symbols: chunk } });
      for (const s of chunk) this.subscribed.add(s);
    }
  }

  private handle(m: unknown): void {
    const msg = m as { channel?: string; data?: unknown };
    if (msg.channel === 'allMarkPrice' && Array.isArray(msg.data)) {
      for (const r of msg.data as Array<{ s?: string; p?: string; E?: number }>) {
        const p = Number(r.p);
        if (r.s && Number.isFinite(p)) this.o.sink.mark?.(r.s, p, r.E ?? Date.now());
      }
      return;
    }
    if (msg.channel !== 'trade' || !Array.isArray(msg.data)) return;
    for (const t of msg.data as Array<{ T?: number; t?: number; s?: string; S?: string; p?: string; q?: string; bi?: number; si?: number }>) {
      if (!t.s || typeof t.t !== 'number') continue;
      const id = `sodex:${t.s}:${t.t}`;
      if (!this.seen.add(id)) continue;
      const price = Number(t.p);
      const qty = Number(t.q);
      const time = t.T ?? Date.now();
      if (!(price > 0) || !(qty > 0)) continue;
      const buyer = typeof t.bi === 'number' ? t.bi : -1;
      const seller = typeof t.si === 'number' ? t.si : -1;
      if (buyer === seller) continue;
      const takerBuy = t.S === 'BUY';
      for (const [acct, side] of [[buyer, 'buy'], [seller, 'sell']] as const) {
        const l = this.leadersById.get(acct);
        if (l) {
          const seed = this.o.book.seedTime(l);
          if (seed !== null && time >= seed) {
            this.o.book.notePrint(l, t.s, true);
            this.coalesce.add(l, t.s, side === 'buy' ? qty : -qty, price, time, id);
          }
        }
        if (this.followers.has(acct)) {
          this.o.sink.follower?.({
            id,
            accountId: acct,
            symbol: t.s,
            side,
            price,
            qty,
            taker: side === 'buy' ? takerBuy : !takerBuy,
            time,
            clOrdID: null,
            fee: null,
          });
        }
      }
    }
  }
}

/* ------------------------------------------------------------ Hyperliquid ----- */

export interface HyperliquidFeedOptions {
  factory: WebSocketFactory;
  book: LeaderBook;
  sink: FeedSink;
  /** 'user': `userFills` per leader (at most 10 per IP); 'firehose': `trades` on every coin. */
  mode: 'user' | 'firehose';
  /** Every perp coin (firehose mode). */
  coins?: () => string[];
  log?: Logger;
  url?: string;
}

export const HL_USER_LIMIT = 10;

export class HyperliquidFeed {
  private socket: LiveSocket;
  private leaders = new Map<string, LeaderRef>();
  private seen = new Seen();
  private coalesce: Coalescer;
  private subscribedUsers = new Set<string>();
  private subscribedCoins = new Set<string>();

  constructor(private readonly o: HyperliquidFeedOptions) {
    this.coalesce = new Coalescer((l, symbol, delta, vwap, time, id) => {
      this.o.book.merged(l, symbol);
      const e = delta !== 0 ? this.o.book.applyDelta(l, symbol, delta, vwap, time, id) : null;
      if (e) this.o.sink.leader(e);
    });
    this.socket = new LiveSocket({
      url: o.url ?? HL_WS_URL,
      factory: o.factory,
      ping: '{"method":"ping"}',
      name: `hyperliquid-${o.mode}`,
      log: o.log,
      subscribe: (send, fresh) => this.subscribeAll(send, fresh),
      onMessage: (m) => this.handle(m),
      onState: (up) => o.sink.state?.('hyperliquid', up),
    });
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
    this.coalesce.stop();
  }

  get up(): boolean {
    return this.socket.up;
  }

  setLeaders(list: LeaderRef[]): void {
    const next = new Map(list.filter((l) => l.venue === 'hyperliquid').map((l) => [l.address.toLowerCase(), l]));
    if (this.o.mode === 'user') {
      for (const u of this.subscribedUsers) {
        if (!next.has(u)) {
          this.socket.send({ method: 'unsubscribe', subscription: { type: 'userFills', user: u } });
          this.subscribedUsers.delete(u);
        }
      }
    }
    this.leaders = next;
    this.socket.resubscribe();
  }

  refreshCoins(): void {
    this.socket.resubscribe();
  }

  private subscribeAll(send: (m: unknown) => void, fresh: boolean): void {
    if (fresh) {
      this.subscribedUsers.clear();
      this.subscribedCoins.clear();
    }
    if (this.o.mode === 'user') {
      let n = this.subscribedUsers.size;
      for (const u of this.leaders.keys()) {
        if (this.subscribedUsers.has(u)) continue;
        if (n >= HL_USER_LIMIT) {
          this.o.log?.warn('hyperliquid: more leaders than one IP may follow per user; the rest rely on reconciliation', { limit: HL_USER_LIMIT });
          break;
        }
        send({ method: 'subscribe', subscription: { type: 'userFills', user: u } });
        this.subscribedUsers.add(u);
        n++;
      }
      return;
    }
    for (const c of this.o.coins?.() ?? []) {
      if (this.subscribedCoins.has(c)) continue;
      send({ method: 'subscribe', subscription: { type: 'trades', coin: c } });
      this.subscribedCoins.add(c);
    }
  }

  private handle(m: unknown): void {
    const msg = m as { channel?: string; data?: unknown };
    if (msg.channel === 'userFills') {
      const d = msg.data as { isSnapshot?: boolean; user?: string; fills?: Array<Record<string, unknown>> } | undefined;
      if (!d || d.isSnapshot || !d.user) return;
      const l = this.leaders.get(d.user.toLowerCase());
      if (!l) return;
      const seed = this.o.book.seedTime(l);
      // One order's fills share `oid`: the change from the first fill's start to the last fill's end.
      const byOrder = new Map<string, { coin: string; before: number; after: number; notional: number; qty: number; time: number; id: string }>();
      for (const f of d.fills ?? []) {
        const coin = String(f.coin ?? '');
        const sz = Number(f.sz);
        const px = Number(f.px);
        const start = Number(f.startPosition);
        const time = Number(f.time);
        const id = `hl:${String(f.tid ?? f.hash ?? `${coin}:${time}`)}`;
        if (!coin || !(sz > 0) || !(px > 0) || !Number.isFinite(start) || !this.seen.add(id)) continue;
        if (seed !== null && time < seed) continue;
        if (coin.startsWith('@') || coin.includes('/')) continue;
        const signed = f.side === 'B' ? sz : -sz;
        const k = `${coin}|${String(f.oid ?? time)}`;
        const g = byOrder.get(k);
        if (!g) byOrder.set(k, { coin, before: start, after: start + signed, notional: sz * px, qty: sz, time, id });
        else {
          g.after += signed;
          g.notional += sz * px;
          g.qty += sz;
          g.time = Math.max(g.time, time);
        }
      }
      for (const g of byOrder.values()) {
        const after = Math.abs(g.after) < 1e-12 ? 0 : g.after;
        const e = this.o.book.applyTotal(l, g.coin, null, after, g.notional / g.qty, g.time, g.id);
        if (e) this.o.sink.leader(e);
      }
      return;
    }
    if (msg.channel === 'trades' && Array.isArray(msg.data)) {
      for (const t of msg.data as Array<{ coin?: string; px?: string; sz?: string; time?: number; tid?: number; users?: [string, string] }>) {
        if (!t.coin || !Array.isArray(t.users)) continue;
        const id = `hl:${t.tid ?? `${t.coin}:${t.time}`}`;
        if (!this.seen.add(id)) continue;
        const px = Number(t.px);
        const sz = Number(t.sz);
        const time = t.time ?? Date.now();
        if (!(px > 0) || !(sz > 0)) continue;
        const [buyer, seller] = [t.users[0]?.toLowerCase(), t.users[1]?.toLowerCase()];
        if (buyer === seller) continue;
        for (const [addr, signed] of [[buyer, sz], [seller, -sz]] as const) {
          const l = addr ? this.leaders.get(addr) : undefined;
          if (!l) continue;
          const seed = this.o.book.seedTime(l);
          if (seed !== null && time >= seed) {
            this.o.book.notePrint(l, t.coin, true);
            this.coalesce.add(l, t.coin, signed, px, time, id);
          }
        }
      }
    }
  }
}

/** Which venues a set of leaders needs. */
export const venuesOf = (leaders: readonly LeaderRef[]): Set<LeaderVenue> => new Set(leaders.map((l) => l.venue));
