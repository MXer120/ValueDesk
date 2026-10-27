/**
 * One WebSocket to the SoDEX gateway (`wss://…/ws/{engine}`), run by the
 * socket host. The browser twin of the server's Upstream (sodex/ws.ts):
 *
 *  - keepalive {"op":"ping"} every KEEPALIVE_MS (the gateway drops a silent
 *    connection after 60 s), as SoDEX's docs ask;
 *  - a watchdog: nothing heard for SILENT_MS (not even the pong) means the
 *    connection is dead without having said so (a laptop asleep, a network
 *    switched, a proxy that dropped it) - it is closed and made again; one still
 *    not open after CONNECT_TIMEOUT_MS is too;
 *  - `wake()`: the network is back (or the page woke) - a connection that is
 *    down is retried now instead of at the end of its backoff;
 *  - reconnect with exponential backoff and jitter (250 ms -> 8 s), and every
 *    subscription re-sent once the socket is open again;
 *  - refcounted subscriptions keyed by the shared protocol's `subKey`, sent
 *    in the gateway's own shape (`normaliseSubParams`);
 *  - the last snapshot per subscription kept, to seed a late joiner at once;
 *  - `user` set: a connection for ONE wallet's account channels. The gateway's
 *    account pushes name no wallet, so every push it receives is stamped with
 *    that wallet here, and routed by it (socketHub.ts, accountPushFor).
 *
 * No DOM, no Node: it runs in a SharedWorker, a leader tab, or a plain tab.
 */
import { KEEPALIVE_MS, normaliseSubParams, routeKeys, subKey, type SubParams } from '@sign/sodex/wsProtocol.js';
import type { Engine, SocketStatus } from './messages';

export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const CONNECTING = 0;

/** No message at all for this long (a pong is due every KEEPALIVE_MS): the connection is dead. */
export const SILENT_MS = KEEPALIVE_MS + 15_000;
/** A connection still not open after this is given up and made again. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How often the keepalive and the watchdog look. */
const TICK_MS = 5_000;

interface Sub {
  params: SubParams;
  refs: number;
  /** Last snapshot seen, replayed to a late joiner so its panel fills immediately. */
  lastSnapshot?: unknown;
}

export interface SodexSocketEvents {
  onPush(sock: SodexSocket, msg: any): void;
  onStatus?(sock: SodexSocket, status: SocketStatus): void;
  onAckError?(sock: SodexSocket, message: string): void;
}

export class SodexSocket {
  private ws: SocketLike | null = null;
  private subs = new Map<string, Sub>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPingAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;
  /** A wallet with no SoDEX account yet: its account subscriptions are sent again later. */
  private noAccountTimer: ReturnType<typeof setTimeout> | undefined;
  private noAccountTries = 0;
  status: SocketStatus = 'closed';
  lastMessageAt = 0;

  constructor(
    readonly base: string,
    readonly engine: Engine,
    private readonly events: SodexSocketEvents,
    private readonly factory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike,
    /** A connection for this one wallet's account channels (lower-case), or market data when unset. */
    readonly user?: string,
  ) {}

  get url(): string {
    return `${this.base}/ws/${this.engine}`;
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  connect(): void {
    if (this.closed || this.ws) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: SocketLike;
    try {
      ws = this.factory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      if (this.ws === ws && ws.readyState !== OPEN) this.drop(ws);
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      this.clearConnectTimer();
      this.attempt = 0;
      this.setStatus('open');
      this.lastMessageAt = Date.now();
      // Re-arm every subscription still wanted.
      for (const sub of this.subs.values()) this.send({ op: 'subscribe', params: sub.params });
      this.startPing();
    };

    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg?.op === 'pong') return;
      if (msg?.op) {
        // Subscribe/unsubscribe acknowledgement: {op, success, result|error, connID}
        if (msg.success === false) {
          const error = String(msg.error ?? 'subscription refused');
          this.events.onAckError?.(this, error);
          // "user not found": the wallet has no SoDEX account YET - a brand-new user before
          // the first deposit is credited. Ask again, slower each time (20 s up to 2 min),
          // so the account's orders and fills start to arrive once the account exists.
          // Without this they never did until the page was reloaded (found by the live run).
          if (this.user && /user not found/i.test(error)) this.retryForAccount();
        } else if (msg.success === true && msg.op === 'subscribe') this.noAccountTries = 0;
        return;
      }
      if (!msg?.channel) return;
      // Whose push this is: the wallet this connection was opened for. Never taken
      // from the payload - the gateway does not put one there.
      if (this.user) msg.user = this.user;
      if (msg.type === 'snapshot') {
        for (const key of routeKeys(msg)) {
          const sub = this.subs.get(key);
          if (sub) sub.lastSnapshot = msg;
        }
      }
      this.events.onPush(this, msg);
    };

    ws.onclose = () => {
      if (this.ws === ws) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows and handles the retry */
    };
  }

  private retryForAccount(): void {
    if (this.noAccountTimer !== undefined || this.closed) return;
    const delay = Math.min(120_000, 20_000 * 2 ** Math.min(this.noAccountTries++, 3));
    this.noAccountTimer = setTimeout(() => {
      this.noAccountTimer = undefined;
      for (const sub of this.subs.values()) this.send({ op: 'subscribe', params: sub.params });
    }, delay);
  }

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.events.onStatus?.(this, s);
  }

  private startPing(): void {
    this.stopPing();
    this.lastPingAt = Date.now();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== OPEN) return;
      const now = Date.now();
      // Silent past the pong that was due: dead, though the browser has not noticed.
      if (now - this.lastMessageAt > SILENT_MS) {
        this.drop(ws);
        return;
      }
      if (now - this.lastPingAt >= KEEPALIVE_MS) {
        this.lastPingAt = now;
        this.send({ op: 'ping' });
      }
    }, TICK_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  /** Close a connection that is dead or stuck, and make a new one. */
  private drop(ws: SocketLike): void {
    if (this.ws !== ws) return;
    try {
      ws.close(4000, 'silent');
    } catch {
      /* already gone */
    }
    this.scheduleReconnect();
  }

  /**
   * The network is back, or the page woke up: a connection that is down is
   * made again now, from a fresh backoff. An open one is checked by a ping.
   */
  wake(): void {
    if (this.closed || this.subs.size === 0) return;
    if (this.ws?.readyState === OPEN) {
      this.lastPingAt = Date.now();
      this.send({ op: 'ping' });
      return;
    }
    if (this.ws) return; // still connecting: its own timeout decides
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.attempt = 0;
    this.connect();
  }

  private scheduleReconnect(): void {
    this.stopPing();
    this.clearConnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    }
    if (this.closed) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    // 250ms -> 8s, with jitter so many tabs and browsers don't retry in lockstep.
    const delay = Math.min(8000, 250 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(obj));
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
    this.clearConnectTimer();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.noAccountTimer !== undefined) clearTimeout(this.noAccountTimer);
    this.noAccountTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (ws.readyState === OPEN || ws.readyState === CONNECTING) ws.close(1000, 'idle');
    }
    this.setStatus('closed');
  }
}
