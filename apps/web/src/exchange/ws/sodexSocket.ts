/**
 * One WebSocket to the SoDEX gateway (`wss://…/ws/{engine}`), run by the
 * socket host. The browser twin of the server's Upstream (sodex/ws.ts):
 *
 *  - keepalive {"op":"ping"} every KEEPALIVE_MS (the gateway drops a silent
 *    connection after 60 s);
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
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;
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

    ws.onopen = () => {
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
        if (msg.success === false) this.events.onAckError?.(this, String(msg.error ?? 'subscription refused'));
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

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.events.onStatus?.(this, s);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === OPEN) this.send({ op: 'ping' });
    }, KEEPALIVE_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private scheduleReconnect(): void {
    this.stopPing();
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
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (ws.readyState === OPEN || ws.readyState === CONNECTING) ws.close(1000, 'idle');
    }
    this.setStatus('closed');
  }
}
