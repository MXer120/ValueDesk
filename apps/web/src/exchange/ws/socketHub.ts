/**
 * The socket host: every SoDEX connection this browser holds, shared by every
 * tab that talks to it.
 *
 * The gateway allows 10 connections per IP, and a user's tabs share one IP. So
 * one host (a SharedWorker; else the tab that holds the leader lock; else the
 * tab itself) keeps:
 *   - one market connection per engine (and gateway), shared by every tab;
 *   - one connection per wallet and engine for account channels - SoDEX's
 *     account pushes carry no wallet, so a connection is the only thing that
 *     says whose fills they are. The user's own wallet; a scanned wallet only
 *     while a page shows it. At most ACCOUNT_CONN_CAP of those; one nobody
 *     uses closes after ACCOUNT_IDLE_CLOSE_MS.
 * so every tab together stays within 2 + ACCOUNT_CONN_CAP (= 8) connections.
 *
 * Routing is the server hub's, from the shared protocol (sodex/wsProtocol.ts
 * `pushFor`): an account push reaches a subscription only when it arrived on
 * THAT wallet's connection and names that wallet - so a scanned wallet's fills
 * can never reach the connected user's fill and order notifications.
 */
import {
  ACCOUNT_CHANNELS,
  ACCOUNT_CONN_CAP,
  ACCOUNT_IDLE_CLOSE_MS,
  pushFor,
  subKey,
  wantedSymbols,
  type SubParams,
} from '@sign/sodex/wsProtocol.js';
import type { ClientPort, Engine, SocketStatus, ToHost, ToTab } from './messages';
import { WS_PROTOCOL_VERSION } from './messages';
import { SodexSocket, type SocketFactory } from './sodexSocket';
import { isAllowedGatewayWs } from './allowed';

/** A market connection nobody subscribes to any more closes after this. */
export const MARKET_IDLE_CLOSE_MS = 60_000;
/** A tab that has not been heard from for this long is gone (closed, crashed, frozen). */
export const CLIENT_TIMEOUT_MS = 45_000;
/** Per-tab subscription ceiling (the server hub's MAX_SUBS_PER_CLIENT). */
const MAX_SUBS_PER_CLIENT = 512;

interface ClientSub {
  engine: Engine;
  sock: SodexSocket;
  params: SubParams;
  key: string;
  wanted: Set<string>;
}

interface Client {
  port: ClientPort;
  subs: Map<string, ClientSub>;
  lastSeen: number;
}

interface Pooled {
  sock: SodexSocket;
  idle?: ReturnType<typeof setTimeout>;
}

export interface SocketHubOptions {
  factory?: SocketFactory;
  /** Which kind of host this is, reported in the hello answer. */
  host?: 'worker' | 'leader' | 'local';
  /**
   * Which gateway origins may be opened (default: SoDEX's own, allowed.ts).
   * Anything else a tab names is refused - see allowed.ts for why.
   */
  allowBase?: (base: string) => boolean;
  now?: () => number;
}

export class SocketHub {
  private clients = new Map<string, Client>();
  private market = new Map<string, Pooled>();
  private accounts = new Map<string, Pooled>();
  /** Wallet connections that dropped and are not back yet. */
  private readonly dropped = new WeakSet<SodexSocket>();
  private readonly factory?: SocketFactory;
  private readonly host: 'worker' | 'leader' | 'local';
  private readonly now: () => number;
  private readonly allowBase: (base: string) => boolean;

  constructor(o: SocketHubOptions = {}) {
    this.factory = o.factory;
    this.allowBase = o.allowBase ?? isAllowedGatewayWs;
    this.host = o.host ?? 'local';
    this.now = o.now ?? (() => Date.now());
  }

  // --- clients -------------------------------------------------------------------------

  addClient(port: ClientPort): void {
    const existing = this.clients.get(port.id);
    if (existing) {
      existing.port = port;
      existing.lastSeen = this.now();
    } else {
      this.clients.set(port.id, { port, subs: new Map(), lastSeen: this.now() });
    }
    port.send({ type: 'hello', v: WS_PROTOCOL_VERSION, host: this.host });
    // Tell the newcomer what the market connections are doing right now.
    for (const [, p] of this.market) port.send({ type: 'status', engine: p.sock.engine, status: p.sock.status });
  }

  removeClient(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    for (const sub of c.subs.values()) this.release(sub);
  }

  /** Drop every tab not heard from within CLIENT_TIMEOUT_MS (their subscriptions go with them). */
  sweep(): void {
    const cutoff = this.now() - CLIENT_TIMEOUT_MS;
    for (const [id, c] of this.clients) if (c.lastSeen < cutoff) this.removeClient(id);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** One message from a tab. `port` is how to answer it (needed only for `hello`). */
  handle(msg: ToHost, port?: ClientPort): void {
    if (!msg || typeof msg !== 'object' || typeof msg.client !== 'string') return;
    if (msg.op === 'hello') {
      if (msg.v !== WS_PROTOCOL_VERSION) return;
      if (port) this.addClient(port);
      return;
    }
    const c = this.clients.get(msg.client);
    if (!c) {
      // A tab we dropped (timed out, or a host that restarted): it must say hello again.
      if (port && msg.op !== 'bye') port.send({ type: 'error', message: 'unknown client - say hello' });
      return;
    }
    c.lastSeen = this.now();
    switch (msg.op) {
      case 'ping':
        c.port.send({ type: 'pong' });
        return;
      case 'bye':
        this.removeClient(msg.client);
        // The last tab left (closed, reloaded, or gone into the back-forward
        // cache): nothing will use a connection before a page says hello again,
        // and a worker with no page is cut off by the browser anyway - close
        // cleanly now rather than be cut.
        if (this.clients.size === 0) this.close();
        return;
      case 'subscribe':
        this.subscribe(c, msg.engine === 'spot' ? 'spot' : 'perps', msg.params, msg.wsBase);
        return;
      case 'unsubscribe':
        this.unsubscribe(c, msg.engine === 'spot' ? 'spot' : 'perps', msg.params);
        return;
    }
  }

  // --- subscriptions -------------------------------------------------------------------

  private subscribe(c: Client, engine: Engine, params: SubParams, wsBase: string): void {
    if (!params?.channel || typeof params.channel !== 'string') {
      c.port.send({ type: 'error', op: 'subscribe', engine, message: 'params.channel is required' });
      return;
    }
    // Only SoDEX's own gateways, over wss: this host serves every tab (allowed.ts).
    if (!this.allowBase(wsBase)) {
      c.port.send({ type: 'error', op: 'subscribe', engine, channel: params.channel, message: 'gateway not allowed' });
      return;
    }
    const localKey = `${engine}:${subKey(params)}`;
    if (c.subs.has(localKey)) return; // idempotent
    if (c.subs.size >= MAX_SUBS_PER_CLIENT) {
      c.port.send({ type: 'error', op: 'subscribe', engine, channel: params.channel, message: `subscription limit reached (${MAX_SUBS_PER_CLIENT})` });
      return;
    }
    const sock = this.socketFor(wsBase, engine, params);
    if (!sock) {
      // An account channel with no wallet, or no room for another wallet's
      // connection: no live stream, the page's polling covers it.
      c.port.send({ type: 'error', op: 'subscribe', engine, channel: params.channel, message: 'account stream unavailable', ...(params.user ? { user: params.user } : {}) });
      return;
    }
    const { key, snapshot } = sock.subscribe(params);
    const sub: ClientSub = { engine, sock, params, key, wanted: wantedSymbols(params) };
    c.subs.set(localKey, sub);
    c.port.send({ type: 'ack', op: 'subscribe', engine, channel: params.channel });
    // Seed a late joiner from the cached snapshot so its panel is never blank.
    if (snapshot) this.deliverTo(c, sub, snapshot);
  }

  private unsubscribe(c: Client, engine: Engine, params: SubParams): void {
    const localKey = `${engine}:${subKey(params)}`;
    const sub = c.subs.get(localKey);
    if (!sub) return;
    c.subs.delete(localKey);
    this.release(sub);
    c.port.send({ type: 'ack', op: 'unsubscribe', engine, channel: params.channel });
  }

  private release(sub: ClientSub): void {
    sub.sock.unsubscribe(sub.key);
    this.releaseSocket(sub.sock);
  }

  // --- connections -----------------------------------------------------------------------

  /**
   * The connection a subscription belongs on: the shared one for market data,
   * the wallet's own for account channels. null: an account channel without a
   * wallet, or no room for another wallet's connection.
   */
  private socketFor(base: string, engine: Engine, params: SubParams): SodexSocket | null {
    if (!ACCOUNT_CHANNELS.has(params.channel)) {
      const k = `${base}|${engine}`;
      const hit = this.market.get(k);
      if (hit) {
        if (hit.idle) clearTimeout(hit.idle);
        hit.idle = undefined;
        return hit.sock;
      }
      const sock = new SodexSocket(base, engine, {
        onPush: (s, msg) => this.onPush(s, msg),
        onStatus: (s, status) => this.onStatus(s, status),
      }, this.factory);
      this.market.set(k, { sock });
      return sock;
    }
    const user = params.user?.trim().toLowerCase();
    if (!user || !/^0x[0-9a-f]{40}$/.test(user)) return null;
    const k = `${base}|${engine}|${user}`;
    const hit = this.accounts.get(k);
    if (hit) {
      if (hit.idle) clearTimeout(hit.idle);
      hit.idle = undefined;
      return hit.sock;
    }
    if (this.accounts.size >= ACCOUNT_CONN_CAP) {
      // Make room from a connection nobody is using any more.
      for (const [key, p] of this.accounts) {
        if (p.sock.subscriptionCount === 0) {
          if (p.idle) clearTimeout(p.idle);
          p.sock.close();
          this.accounts.delete(key);
          break;
        }
      }
      if (this.accounts.size >= ACCOUNT_CONN_CAP) return null;
    }
    const sock = new SodexSocket(base, engine, {
      onPush: (s, msg) => this.onPush(s, msg),
      // A wallet connection's status is not the engine's (an idle close is not an
      // outage). A drop is told to the tabs listening on it: they may have missed pushes.
      onStatus: (s, status) => this.onAccountStatus(s, status),
    }, this.factory, user);
    this.accounts.set(k, { sock });
    return sock;
  }

  /** After an unsubscribe: close a connection once nothing has used it for a while. */
  private releaseSocket(sock: SodexSocket): void {
    if (sock.subscriptionCount > 0) return;
    const pool = sock.user ? this.accounts : this.market;
    const k = sock.user ? `${sock.base}|${sock.engine}|${sock.user}` : `${sock.base}|${sock.engine}`;
    const p = pool.get(k);
    if (!p || p.sock !== sock || p.idle) return;
    p.idle = setTimeout(() => {
      p.idle = undefined;
      if (sock.subscriptionCount > 0) return;
      sock.close();
      if (pool.get(k) === p) pool.delete(k);
    }, sock.user ? ACCOUNT_IDLE_CLOSE_MS : MARKET_IDLE_CLOSE_MS);
  }

  /** Connections currently held: market + account (what the gateway counts against the IP). */
  connectionCount(): { market: number; accounts: number; total: number } {
    let market = 0;
    let accounts = 0;
    for (const p of this.market.values()) if (p.sock.status !== 'closed') market++;
    for (const p of this.accounts.values()) if (p.sock.status !== 'closed') accounts++;
    return { market, accounts, total: market + accounts };
  }

  // --- fan-out ---------------------------------------------------------------------------

  private onPush(sock: SodexSocket, msg: any): void {
    for (const c of this.clients.values()) {
      for (const sub of c.subs.values()) {
        // A subscription only ever hears the connection it was placed on.
        if (sub.sock !== sock) continue;
        this.deliverTo(c, sub, msg);
      }
    }
  }

  private deliverTo(c: Client, sub: ClientSub, msg: any): void {
    const out = pushFor(sub.params, sub.wanted, msg);
    if (!out) return;
    c.port.send({
      type: 'push',
      engine: sub.engine,
      channel: String(msg.channel),
      pushType: msg.type === 'snapshot' ? 'snapshot' : 'update',
      data: out.data,
      ...(out.user ? { user: out.user } : {}),
    });
  }

  private onStatus(sock: SodexSocket, status: SocketStatus): void {
    if (sock.user) return;
    for (const c of this.clients.values()) c.port.send({ type: 'status', engine: sock.engine, status });
  }

  /** A wallet connection dropped, or is back after a drop: the tabs listening on it may have missed pushes. */
  private onAccountStatus(sock: SodexSocket, status: SocketStatus): void {
    if (status === 'reconnecting') this.dropped.add(sock);
    else if (status !== 'open' || !this.dropped.delete(sock)) return;
    if (!sock.user) return;
    for (const c of this.clients.values()) {
      for (const sub of c.subs.values()) {
        if (sub.sock !== sock) continue;
        c.port.send({ type: 'gap', engine: sock.engine, user: sock.user });
        break;
      }
    }
  }

  /** Close everything (a host shutting down). */
  close(): void {
    for (const p of [...this.market.values(), ...this.accounts.values()]) {
      if (p.idle) clearTimeout(p.idle);
      p.sock.close();
    }
    this.market.clear();
    this.accounts.clear();
    this.clients.clear();
  }
}

/** Message a tab sent, validated enough to hand to SocketHub.handle. */
export function asToHost(raw: unknown): ToHost | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<ToHost> & { op?: unknown; client?: unknown };
  if (typeof m.op !== 'string' || typeof m.client !== 'string') return null;
  return m as ToHost;
}

export type { ToTab };
