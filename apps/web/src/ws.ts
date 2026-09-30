/**
 * Browser client for the backend hub.
 *
 * Reconnects with backoff and re-arms every live subscription, so a dropped
 * connection is invisible to the panels above. Subscriptions are refcounted
 * here too - two panels watching the same book share one hub subscription.
 */
import type { Engine } from './api';

export type ConnState = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface SubParams {
  channel: string;
  symbol?: string;
  symbols?: string[];
  interval?: string;
  level?: number;
  user?: string;
}

type Handler = (data: any, pushType: 'snapshot' | 'update') => void;

const keyOf = (engine: Engine, p: SubParams): string =>
  [
    engine,
    p.channel,
    p.symbol ?? '',
    (p.symbols ?? []).slice().sort().join('|'),
    p.interval ?? '',
    p.level ?? '',
    (p.user ?? '').toLowerCase(),
  ].join(':');

class HubClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private pingTimer?: number;
  private subs = new Map<string, { engine: Engine; params: SubParams; handlers: Set<Handler> }>();
  private stateHandlers = new Set<(s: ConnState, detail?: string) => void>();
  state: ConnState = 'closed';
  /** Upstream (SoDEX-side) status, reported by the backend per engine. */
  upstream: Partial<Record<Engine, string>> = {};

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      for (const s of this.subs.values()) this.send({ op: 'subscribe', engine: s.engine, params: s.params });
      this.pingTimer = window.setInterval(() => this.send({ op: 'ping' }), 25_000);
    };

    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === 'status') {
        this.upstream[m.engine as Engine] = m.status;
        this.setState(this.state, `${m.engine}:${m.status}`);
        return;
      }
      if (m.type !== 'push') return;

      // Fan out to every handler whose subscription matches this push. One
      // handler throwing (e.g. a chart series rejecting an out-of-order
      // update during a brief resubscribe window) must not stop the others
      // for this same message.
      for (const s of this.subs.values()) {
        if (s.engine !== m.engine || s.params.channel !== m.channel) continue;
        if (s.params.interval && m.data?.i && m.data.i !== s.params.interval) continue;
        // One wallet's account pushes go to that wallet's listeners only: a
        // scanned wallet's fills must never reach your own fill notifications.
        if (s.params.user && String(m.user ?? '').toLowerCase() !== s.params.user.toLowerCase()) continue;
        // Two symbols on one channel (two charts, two books): each gets its own.
        if (s.params.symbol && m.data && !Array.isArray(m.data) && m.data.s && m.data.s !== s.params.symbol) continue;
        for (const h of s.handlers) {
          try {
            h(m.data, m.pushType);
          } catch (e) {
            console.error(`[hub] handler for ${s.params.channel} threw`, e);
          }
        }
      }
    };

    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.ws = null;
      this.setState('reconnecting');
      const delay = Math.min(8000, 300 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      window.setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      /* onclose follows and handles the retry */
    };
  }

  private setState(s: ConnState, detail?: string) {
    this.state = s;
    for (const h of this.stateHandlers) h(s, detail);
  }

  private send(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  onState(h: (s: ConnState, detail?: string) => void): () => void {
    this.stateHandlers.add(h);
    h(this.state);
    return () => this.stateHandlers.delete(h);
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(engine: Engine, params: SubParams, handler: Handler): () => void {
    this.connect();
    const key = keyOf(engine, params);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { engine, params, handlers: new Set() };
      this.subs.set(key, entry);
      this.send({ op: 'subscribe', engine, params });
    }
    entry.handlers.add(handler);

    return () => {
      const e = this.subs.get(key);
      if (!e) return;
      e.handlers.delete(handler);
      if (e.handlers.size === 0) {
        this.subs.delete(key);
        this.send({ op: 'unsubscribe', engine, params });
      }
    };
  }
}

export const hub = new HubClient();
