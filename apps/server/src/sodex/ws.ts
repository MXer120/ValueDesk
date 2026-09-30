/**
 * Upstream WebSocket manager.
 *
 * One connection per engine, shared by every browser client. The gateway allows
 * 10 connections per IP and 2000 messages/minute; every tab connecting directly
 * would exhaust that quickly, and each would re-request the same book snapshots.
 * So: browser tabs talk to our hub, the hub keeps a single refcounted upstream
 * subscription per (channel, params) tuple.
 *
 * Handles keepalive ({"op":"ping"} every 30s - the gateway drops after 60s of
 * silence), exponential reconnect backoff, and re-subscription after a drop.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { NET, wsPath, type Engine } from '../config.js';
import {
  ACCOUNT_CHANNELS,
  ACCOUNT_CONN_CAP,
  ACCOUNT_IDLE_CLOSE_MS,
  KEEPALIVE_MS,
  normaliseSubParams,
  subKey,
  routeKeys,
  type SubParams,
} from './wsProtocol.js';

// The protocol (subscription shapes, keys, routing) is pure and shared with the
// browser's own connections: sodex/wsProtocol.ts. Re-exported unchanged.
export {
  ACCOUNT_CHANNELS,
  ACCOUNT_CONN_CAP,
  ARRAY_CHANNELS,
  CHANNEL_PARAM_STYLE,
  normaliseSubParams,
  routeKeys,
  subKey,
  symbolsIn,
  type SubParams,
} from './wsProtocol.js';

export type UpstreamStatus = 'connecting' | 'open' | 'closed' | 'reconnecting';

interface Sub {
  params: SubParams;
  refs: number;
  /** Last snapshot seen, replayed to a late joiner so its UI fills immediately. */
  lastSnapshot?: unknown;
}

export class Upstream extends EventEmitter {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>();
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private attempt = 0;
  private closed = false;
  status: UpstreamStatus = 'closed';
  lastMessageAt = 0;

  /**
   * `user` set: a connection for ONE wallet's account channels. Every push it
   * receives is that wallet's, and is stamped with it (the gateway's own
   * pushes do not say whose they are).
   */
  constructor(readonly engine: Engine, private readonly base = NET.wsBase, readonly user?: string) {
    super();
    this.setMaxListeners(0);
  }

  private url(): string {
    return this.base + wsPath(this.engine);
  }

  connect(): void {
    if (this.closed || this.ws) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.setStatus('open');
      this.lastMessageAt = Date.now();
      // Re-arm every subscription the hub still wants.
      for (const sub of this.subs.values()) this.send({ op: 'subscribe', params: sub.params });
      this.startPing();
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.op === 'pong') return;
      if (msg.op) {
        // Subscribe/unsubscribe acknowledgement: {op, success, result|error, connID}
        this.emit('ack', msg);
        if (msg.success === false) this.emit('upstream-error', new Error(String(msg.error)));
        return;
      }
      if (!msg.channel) return;
      if (this.user) msg.user = this.user;

      // The subscribed symbol is carried INSIDE the payload (data.s for object
      // payloads, data[].s for array payloads) - never at the top level. Cache
      // snapshots per concrete symbol so a late joiner can be seeded instantly.
      if (msg.type === 'snapshot') {
        for (const key of routeKeys(msg)) {
          const sub = this.subs.get(key);
          if (sub) sub.lastSnapshot = msg;
        }
      }
      this.emit('push', msg);
    });

    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', (err) => {
      this.emit('upstream-error', err);
      // 'close' follows an 'error'; reconnect is handled there.
    });
  }

  private setStatus(s: UpstreamStatus) {
    if (this.status !== s) {
      this.status = s;
      this.emit('status', s);
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ op: 'ping' });
    }, KEEPALIVE_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private scheduleReconnect() {
    this.stopPing();
    this.ws?.removeAllListeners();
    this.ws = null;
    if (this.closed) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    // 250ms -> 8s, with jitter so many clients don't retry in lockstep.
    const delay = Math.min(8000, 250 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Add a reference to a subscription; subscribes upstream on the first one. */
  subscribe(raw: SubParams): { key: string; snapshot?: unknown } {
    // Always send the gateway's expected shape, never the caller's.
    const params = normaliseSubParams(raw);
    const key = subKey(params);
    const existing = this.subs.get(key);
    if (existing) {
      existing.refs++;
      return { key, snapshot: existing.lastSnapshot };
    }
    this.subs.set(key, { params, refs: 1 });
    this.connect();
    this.send({ op: 'subscribe', params });
    return { key };
  }

  /** Drop a reference; unsubscribes upstream when the last one goes. */
  unsubscribe(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    if (--sub.refs > 0) return;
    this.subs.delete(key);
    this.send({ op: 'unsubscribe', params: sub.params });
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  stats() {
    return {
      engine: this.engine,
      status: this.status,
      subscriptions: this.subs.size,
      refs: [...this.subs.values()].reduce((n, s) => n + s.refs, 0),
      lastMessageAt: this.lastMessageAt,
    };
  }
}

export const upstreams: Record<Engine, Upstream> = {
  spot: new Upstream('spot'),
  perps: new Upstream('perps'),
};

/*
 * ACCOUNT CHANNELS: ONE CONNECTION PER WALLET.
 *
 * The gateway's account pushes (accountTrade, accountOrderUpdate, accountUpdate,
 * accountState) carry no wallet: only the subscribe ack names it. With two
 * wallets subscribed on one shared connection - your own, and one you are
 * scanning - their fills are indistinguishable, and the old routing handed the
 * scanned wallet's fills to your fill notifications on every page. So each
 * wallet gets its own connection and every push is stamped with it.
 *
 * The gateway allows 10 connections per IP: the two market connections above
 * plus at most ACCOUNT_CONN_CAP of these. A wallet beyond the cap gets no live
 * stream (the pages poll the same data anyway); idle connections close after
 * IDLE_CLOSE_MS so a scan does not hold one for good.
 */
const IDLE_CLOSE_MS = ACCOUNT_IDLE_CLOSE_MS;

const accountConns = new Map<string, { up: Upstream; idle?: NodeJS.Timeout }>();
const accountListeners = new Set<(up: Upstream) => void>();

/** Called for every single-wallet connection as it is created (the hub wires its pushes). */
export function onAccountUpstream(fn: (up: Upstream) => void): () => void {
  accountListeners.add(fn);
  return () => accountListeners.delete(fn);
}

const accountKey = (engine: Engine, user: string) => `${engine}|${user.toLowerCase()}`;

/**
 * The connection a subscription belongs on: the shared one for market data, the
 * wallet's own for account channels. null: an account channel without a wallet,
 * or no room for another wallet's connection.
 */
export function upstreamFor(engine: Engine, params: SubParams, make = (e: Engine, u: string) => new Upstream(e, NET.wsBase, u)): Upstream | null {
  if (!ACCOUNT_CHANNELS.has(params.channel)) return upstreams[engine];
  const user = params.user?.trim().toLowerCase();
  if (!user) return null;
  const k = accountKey(engine, user);
  const hit = accountConns.get(k);
  if (hit) {
    if (hit.idle) clearTimeout(hit.idle);
    hit.idle = undefined;
    return hit.up;
  }
  if (accountConns.size >= ACCOUNT_CONN_CAP) {
    // Make room from a connection nobody is using any more.
    for (const [key, e] of accountConns) {
      if (e.up.stats().subscriptions === 0) {
        if (e.idle) clearTimeout(e.idle);
        e.up.close();
        accountConns.delete(key);
        break;
      }
    }
    if (accountConns.size >= ACCOUNT_CONN_CAP) return null;
  }
  const up = make(engine, user);
  accountConns.set(k, { up });
  for (const fn of accountListeners) fn(up);
  return up;
}

/** After an unsubscribe: close a wallet's connection once nothing has used it for a while. */
export function releaseUpstream(up: Upstream): void {
  if (!up.user) return;
  const k = accountKey(up.engine, up.user);
  const e = accountConns.get(k);
  if (!e || e.up !== up || up.stats().subscriptions > 0 || e.idle) return;
  e.idle = setTimeout(() => {
    if (up.stats().subscriptions > 0) { e.idle = undefined; return; }
    up.close();
    accountConns.delete(k);
  }, IDLE_CLOSE_MS);
  e.idle.unref?.();
}

export const accountStats = () => [...accountConns.values()].map((e) => ({ ...e.up.stats(), user: e.up.user }));
