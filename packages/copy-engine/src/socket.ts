/**
 * A WebSocket that keeps itself up: pings, replaces a silent socket, and
 * reconnects with jittered backoff (1 s to 30 s). `subscribe` runs on every
 * open, so a reconnect restores every subscription. The same policy as the
 * indexer's streams (apps/server/src/indexer/streams.ts), host-neutral.
 */
import { WS_OPEN, timers, type Logger, type WebSocketFactory, type WebSocketLike } from './io.ts';

export interface LiveSocketOptions {
  url: string;
  factory: WebSocketFactory;
  /** The ping frame, e.g. '{"op":"ping"}' (SoDEX) or '{"method":"ping"}' (Hyperliquid). */
  ping: string;
  pingMs?: number;
  staleMs?: number;
  /** `fresh`: a new socket (every subscription is gone); otherwise the set changed on a live one. */
  subscribe: (send: (msg: unknown) => void, fresh: boolean) => void;
  onMessage: (msg: unknown) => void;
  onState?: (up: boolean) => void;
  log?: Logger;
  name?: string;
}

export class LiveSocket {
  private ws: WebSocketLike | null = null;
  private running = false;
  private attempt = 0;
  private lastMessageAt = 0;
  private lastPingAt = 0;
  private tick: unknown = null;
  private retry: unknown = null;
  /** When the socket last came up (null while down). */
  upSince: number | null = null;

  constructor(private readonly o: LiveSocketOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.tick = timers.every(10_000, () => this.check());
  }

  stop(): void {
    this.running = false;
    timers.cancel(this.tick);
    timers.cancel(this.retry);
    this.tick = this.retry = null;
    this.drop();
  }

  get up(): boolean {
    return this.upSince !== null;
  }

  send(msg: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg));
  }

  /** Re-run `subscribe` on the live socket (the subscription set changed). */
  resubscribe(): void {
    if (this.ws && this.ws.readyState === WS_OPEN) this.o.subscribe((m) => this.send(m), false);
  }

  private connect(): void {
    if (!this.running || this.ws) return;
    let ws: WebSocketLike;
    try {
      ws = this.o.factory(this.o.url);
    } catch (e) {
      this.o.log?.warn(`${this.o.name ?? 'socket'}: could not open`, { error: String(e) });
      this.schedule();
      return;
    }
    this.ws = ws;
    this.lastMessageAt = Date.now();
    ws.onopen = () => {
      this.attempt = 0;
      this.upSince = Date.now();
      this.o.onState?.(true);
      this.lastPingAt = Date.now();
      this.o.subscribe((m) => this.send(m), true);
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (!raw || raw === 'pong') return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        this.o.onMessage(msg);
      } catch (e) {
        this.o.log?.error(`${this.o.name ?? 'socket'}: handler failed`, { error: String(e) });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.upSince !== null;
      this.upSince = null;
      if (was) this.o.onState?.(false);
      this.schedule();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    if (this.upSince !== null) this.o.onState?.(false);
    this.upSince = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private schedule(): void {
    if (!this.running) return;
    timers.cancel(this.retry);
    const base = Math.min(30_000, 1_000 * 2 ** this.attempt++);
    const delay = base / 2 + Math.random() * (base / 2);
    this.retry = timers.after(delay, () => {
      this.retry = null;
      this.connect();
    });
  }

  private check(): void {
    if (!this.running) return;
    const now = Date.now();
    if (this.ws && now - this.lastMessageAt > (this.o.staleMs ?? 90_000)) {
      this.o.log?.warn(`${this.o.name ?? 'socket'}: silent, replacing`, { silentMs: now - this.lastMessageAt });
      this.drop();
      this.schedule();
      return;
    }
    // SoDEX drops a client that has not pinged for 60 s, however busy the stream is.
    if (this.ws && this.ws.readyState === WS_OPEN && now - this.lastPingAt >= (this.o.pingMs ?? 30_000)) {
      this.lastPingAt = now;
      try {
        this.ws.send(this.o.ping);
      } catch {
        /* the next check replaces it */
      }
    }
  }
}
