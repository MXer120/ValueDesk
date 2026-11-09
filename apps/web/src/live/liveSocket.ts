/**
 * THE LIVE SOCKET: one WebSocket per tab to the API's /ws/liq (server routes/liveHub.ts) carrying every live read the open
 * pages ask for - the Trade flow's forming candle, the cohort pages - straight from server 1, not through Vercel.
 *
 * A read is named by the very path + query the page fetches over HTTP; the server answers with that route's own answer
 * ({t:"ls"}), then lossless patches ({t:"lp"}, @sign/live/jsonPatch) as the data moves. Several components on one path
 * share one subscription. A patch out of order (the server skipped one while this socket was full) asks again and gets the
 * whole answer. While the socket is down, or the server refuses a path, listeners hear `down` and the page polls over HTTP
 * as before (useLiveRead.ts).
 *
 * Opened on the first subscription, closed 15 s after the last one goes; a tab hidden for HIDDEN_CLOSE_MS (as the heatmap's
 * socket, liveHeat.ts) closes it until shown again. Reconnects back off 1 s -> 30 s.
 *
 * The heatmap keeps its own socket per widget (liveHeat.ts): the server allows one heatmap subscription per connection and a
 * terminal layout can hold several heatmaps, so moving them here would make two heatmaps fight over one subscription.
 */
import { apply, type Patch } from '@sign/live/jsonPatch.js';
import { HIDDEN_CLOSE_MS, liqWsUrl } from '../components/liqmap/liveHeat';

export type LiveEvent = { kind: 'data'; body: unknown } | { kind: 'down' };
type Listener = (ev: LiveEvent) => void;

interface Sub {
  id: string;
  listeners: Set<Listener>;
  body: unknown;
  /** The seq of what is held; -1: waiting for the whole answer. */
  seq: number;
  refused: boolean;
}

/** What the socket needs from its surroundings (tests pass their own). */
export interface LiveEnv {
  WebSocket: new (url: string) => WebSocketLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  /** null: no document (the tab's visibility is not followed). */
  document: Pick<Document, 'visibilityState' | 'addEventListener'> | null;
}

export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(text: string): void;
  close(): void;
}

export const IDLE_CLOSE_MS = 15_000;

export class LiveSocket {
  private subs = new Map<string, Sub>();
  private byId = new Map<string, string>();
  private status = new Set<(up: boolean) => void>();
  private ws: WebSocketLike | null = null;
  private nextId = 1;
  private backoff = 1_000;
  private retry: unknown = null;
  private idle: unknown = null;
  private hideTimer: unknown = null;
  private away = false;
  up = false;

  constructor(private readonly url: string, private readonly env: LiveEnv) {
    env.document?.addEventListener('visibilitychange', () => this.seen());
  }

  /** Follow `path`; returns the unsubscribe. A listener joining a read already held hears its answer at once. */
  subscribe(path: string, fn: Listener): () => void {
    let s = this.subs.get(path);
    if (!s) {
      s = { id: String(this.nextId++), listeners: new Set(), body: undefined, seq: -1, refused: false };
      this.subs.set(path, s);
      this.byId.set(s.id, path);
      if (this.ws?.readyState === 1) this.ask(path, s);
    }
    s.listeners.add(fn);
    if (s.seq >= 0 && this.up) fn({ kind: 'data', body: s.body });
    else if (s.refused || !this.up) fn({ kind: 'down' });
    if (this.idle !== null) { this.env.clearTimeout(this.idle); this.idle = null; }
    this.open();
    return () => this.drop(path, fn);
  }

  /** Hear when the socket comes up or goes down. */
  onStatus(fn: (up: boolean) => void): () => void {
    this.status.add(fn);
    return () => { this.status.delete(fn); };
  }

  private drop(path: string, fn: Listener): void {
    const s = this.subs.get(path);
    if (!s) return;
    s.listeners.delete(fn);
    if (s.listeners.size) return;
    this.subs.delete(path);
    this.byId.delete(s.id);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op: 'live.off', id: s.id }));
    if (!this.subs.size && this.idle === null) {
      this.idle = this.env.setTimeout(() => { this.idle = null; if (!this.subs.size) this.shut(); }, IDLE_CLOSE_MS);
    }
  }

  private ask(path: string, s: Sub): void {
    s.seq = -1;
    s.refused = false;
    this.ws!.send(JSON.stringify({ op: 'live', id: s.id, path }));
  }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    for (const fn of this.status) fn(up);
  }

  private open(): void {
    if (this.ws || this.away || this.retry !== null || !this.subs.size) return;
    const ws = new this.env.WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1_000;
      this.setUp(true);
      for (const [path, s] of this.subs) this.ask(path, s);
    };
    ws.onmessage = (ev) => this.frame(String(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setUp(false);
      for (const s of this.subs.values()) { s.seq = -1; for (const fn of s.listeners) fn({ kind: 'down' }); }
      if (this.away || !this.subs.size) return;
      this.retry = this.env.setTimeout(() => { this.retry = null; this.open(); }, this.backoff);
      this.backoff = Math.min(30_000, this.backoff * 2);
    };
    ws.onerror = () => ws.close();
  }

  private shut(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onclose = null;
    ws.close();
    this.setUp(false);
    for (const s of this.subs.values()) { s.seq = -1; for (const fn of s.listeners) fn({ kind: 'down' }); }
  }

  /** One frame from the server (exported through the class for tests). */
  frame(text: string): void {
    let m: { t?: string; id?: string; seq?: number; body?: unknown; p?: Patch };
    try { m = JSON.parse(text); } catch { return; }
    if (m.t !== 'ls' && m.t !== 'lp' && m.t !== 'le') return; // the heatmap's frames are not sent on this socket's subscriptions
    const path = this.byId.get(String(m.id));
    const s = path === undefined ? undefined : this.subs.get(path);
    if (!s || path === undefined) return;
    if (m.t === 'le') {
      s.refused = true;
      s.seq = -1;
      for (const fn of s.listeners) fn({ kind: 'down' });
      return;
    }
    if (m.t === 'ls') {
      s.body = m.body;
      s.seq = Number(m.seq);
    } else {
      // Out of order: what is held is no longer the server's; ask for the whole answer again.
      if (s.seq < 0 || m.seq !== s.seq + 1) { if (s.seq >= 0 && this.ws?.readyState === 1) this.ask(path, s); return; }
      s.body = apply(s.body, m.p);
      s.seq = m.seq;
    }
    for (const fn of s.listeners) fn({ kind: 'data', body: s.body });
  }

  private seen(): void {
    const doc = this.env.document;
    if (!doc) return;
    if (doc.visibilityState === 'hidden') {
      this.hideTimer ??= this.env.setTimeout(() => {
        this.hideTimer = null;
        this.away = true;
        if (this.retry !== null) { this.env.clearTimeout(this.retry); this.retry = null; }
        this.shut();
      }, HIDDEN_CLOSE_MS);
      return;
    }
    if (this.hideTimer !== null) { this.env.clearTimeout(this.hideTimer); this.hideTimer = null; }
    if (!this.away) return;
    this.away = false;
    this.backoff = 1_000;
    this.open();
  }
}

let shared: LiveSocket | null | undefined;

/** The tab's live socket, or null where there is none (no socket URL: a build without VITE_LIQ_WS_URL, tests). */
export function liveSocket(): LiveSocket | null {
  if (shared !== undefined) return shared;
  const url = typeof WebSocket === 'undefined' ? null : liqWsUrl();
  shared = url
    ? new LiveSocket(url, {
      WebSocket: WebSocket as unknown as LiveEnv['WebSocket'],
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      document: typeof document === 'undefined' ? null : document,
    })
    : null;
  return shared;
}
