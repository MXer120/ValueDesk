/**
 * LIVE CHANNELS on the heatmap's socket (/ws/liq, routes/liqWs.ts): the Trade flow's forming candle and the cohort pages,
 * pushed from server 1 straight to the browser instead of polled through Vercel.
 *
 * Why (2026-11-09): the recorder makes a print readable in ~0.5 s (flow/thread.ts on rt/flow), but the browser saw it 15-30 s
 * late - TradeFlow.tsx polled the forming candle every 15 s, the answer carried max-age=10 + swr=10 and read.ts kept it 5 s -
 * and every poll was a Vercel function invocation (the cohorts: two to four per tab per minute). Here one socket per tab
 * carries any number of these reads (at most MAX_SUBS), next to its heatmap subscription.
 *
 * A subscription names the very path and query the page reads over HTTP (`/api/vs/flow?coin=BTC&...`): routes/valuedesk.ts
 * liveAskOf parses it as the route does, so what is pushed is the route's own answer ({ok: true, ...}) and the HTTP route
 * stays the history read and the fallback while the socket is down. Paths not pushed are refused ('le'); the page polls them.
 *
 *   browser -> {op: "live", id, path}       subscribe (the same id again replaces it)
 *              {op: "live.off", id}         unsubscribe
 *   server  -> {t: "ls", id, seq, body}     the whole answer: on subscribing, and after a gap
 *              {t: "lp", id, seq, p}        what changed since seq - 1 (live/jsonPatch.ts; lossless)
 *              {t: "le", id, error}         refused: the page reads that path over HTTP instead
 *
 * Viewers of one read share one group: it is built once per change and the patch is sent to each. Per group:
 *   - Trade flow, a window still forming: every THROTTLE_MS (or 4x its last build time, if slower) the prints held in its
 *     newest slots are counted (read.ts flowStamp: two indexed reads per market); the window is built again only when that
 *     moved, and at least every LIVE_REFRESH_MS (an address resolved, a catch-up further back). A window that has passed:
 *     every CLOSED_REFRESH_MS until it is final (a venue's own count still coming: PENDING_REFRESH_MS), then never again.
 *   - Cohorts: built again when the cohort load in use changes (cohortThread.ts cohortLoadAt, about once a minute) and at
 *     least every COHORT_REFRESH_MS.
 * Memory per client is bounded: MAX_SUBS reads, and a client whose socket holds more than SEND_BUFFER unsent bytes is
 * skipped - the next patch then shows it a gap in `seq` and it asks again, getting the whole answer.
 */
import type { WebSocket } from 'ws';
import { diff, type Patch } from '../live/jsonPatch.js';
import type { FlowAsk, FlowWindow } from '../flow/read.js';
import type { CohortJob } from '../indexer/cohortThread.js';
import type { LiveAsk } from './valuedesk.js';

export const THROTTLE_MS = 500;
export const LIVE_REFRESH_MS = 15_000;
export const CLOSED_REFRESH_MS = 60_000;
export const PENDING_REFRESH_MS = 5_000;
export const COHORT_REFRESH_MS = 60_000;
/** A window is "still forming" until this long after its end (the recorder's last prints of it, a late stream). */
const FORMING_SLACK_MS = 60_000;
export const MAX_SUBS = 8;
const MAX_GROUPS = 2_000;
const SEND_BUFFER = 4 * 1024 * 1024;
const TICK_MS = 250;

export interface LiveSources {
  /** routes/valuedesk.ts liveAskOf. Throws (statusCode 400) on a bad query. */
  parse(path: string, q: Record<string, string | undefined>): LiveAsk | null;
  flowWindow(ask: FlowAsk, now: number, maxAgeMs: number): Promise<FlowWindow | null>;
  flowStamp(ask: FlowAsk, now: number): number | null;
  cohortJob(job: CohortJob): Promise<string | null>;
  cohortLoadAt(): Promise<number | null>;
  now(): number;
}

/** What a socket needs here (ws.WebSocket; tests pass a stand-in). */
export type LiveClient = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send'>;

interface Group {
  key: string;
  ask: LiveAsk;
  subs: Map<LiveClient, Set<string>>;
  body: unknown;
  text: string | null;
  seq: number;
  busy: boolean;
  /** When it was last built (0: never), and when its stamp was last read. */
  at: number;
  checkedAt: number;
  stamp: number | null;
  loadAt: number | null;
  /** A final window: never built again. */
  done: boolean;
  /** How long its last build took (ms): a slow read is asked less often. */
  cost: number;
}

const notRecorded = { ok: false, code: 'not_available', error: 'The trade flow is not recorded yet' };
const notRunning = { ok: false, code: 'not_available', error: 'The index is not running yet' };

export class LiveHub {
  private groups = new Map<string, Group>();
  private clients = new Map<LiveClient, Map<string, Group>>();
  private timer: NodeJS.Timeout | null = null;
  /** Patches and snapshots sent, bytes sent (for the report and the status). */
  readonly stats = { snapshots: 0, patches: 0, bytes: 0, builds: 0, refused: 0 };

  constructor(private readonly src: LiveSources, private readonly opts: { timer?: boolean } = {}) {}

  /** A message from the socket that is a live op: handled here (true), or not one (false: the heatmap's). */
  message(ws: LiveClient, m: { op?: unknown; id?: unknown; path?: unknown; [k: string]: unknown }): boolean {
    if (m.op !== 'live' && m.op !== 'live.off') return false;
    const id = typeof m.id === 'string' && /^[\w.-]{1,32}$/.test(m.id) ? m.id : null;
    if (!id) return true;
    if (m.op === 'live.off') { this.off(ws, id); return true; }
    this.sub(ws, id, String(m.path ?? ''));
    return true;
  }

  /** The socket closed: every subscription of it goes. */
  leave(ws: LiveClient): void {
    const mine = this.clients.get(ws);
    if (!mine) return;
    for (const id of [...mine.keys()]) this.off(ws, id);
    this.clients.delete(ws);
  }

  get size(): { groups: number; clients: number } {
    return { groups: this.groups.size, clients: this.clients.size };
  }

  private refuse(ws: LiveClient, id: string, error: string): void {
    this.stats.refused++;
    this.send(ws, JSON.stringify({ t: 'le', id, error }));
  }

  private sub(ws: LiveClient, id: string, raw: string): void {
    if (raw.length > 900) { this.refuse(ws, id, 'path'); return; }
    const qi = raw.indexOf('?');
    const path = qi < 0 ? raw : raw.slice(0, qi);
    const q: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1))) q[k] = v;
    let ask: LiveAsk | null;
    try { ask = this.src.parse(path, q); } catch (e) { this.refuse(ws, id, String((e as Error)?.message ?? e)); return; }
    if (!ask) { this.refuse(ws, id, 'not pushed'); return; }
    const key = ask.kind === 'flow' ? `flow|${JSON.stringify(ask.ask)}` : `cohort|${JSON.stringify(ask.job)}`;
    let mine = this.clients.get(ws);
    // The same read again: the browser saw a gap in `seq` (a patch skipped while its socket was full) - the whole answer.
    if (mine?.get(id)?.key === key) {
      const held = mine.get(id)!;
      if (held.body !== null) this.snapshot(held, ws, id);
      return;
    }
    if (mine?.has(id)) this.off(ws, id);
    mine = this.clients.get(ws);
    if ((mine?.size ?? 0) >= MAX_SUBS) { this.refuse(ws, id, 'too many subscriptions'); return; }
    let g = this.groups.get(key);
    if (!g) {
      if (this.groups.size >= MAX_GROUPS) { this.refuse(ws, id, 'busy'); return; }
      g = { key, ask, subs: new Map(), body: null, text: null, seq: 0, busy: false, at: 0, checkedAt: 0, stamp: null, loadAt: null, done: false, cost: 0 };
      this.groups.set(key, g);
    }
    if (!mine) { mine = new Map(); this.clients.set(ws, mine); }
    mine.set(id, g);
    let ids = g.subs.get(ws);
    if (!ids) { ids = new Set(); g.subs.set(ws, ids); }
    ids.add(id);
    if (g.body !== null) this.snapshot(g, ws, id);
    else if (!g.busy) void this.build(g);
    this.start();
  }

  private off(ws: LiveClient, id: string): void {
    const mine = this.clients.get(ws);
    const g = mine?.get(id);
    if (!g) return;
    mine!.delete(id);
    if (!mine!.size) this.clients.delete(ws);
    const ids = g.subs.get(ws);
    ids?.delete(id);
    if (ids && !ids.size) g.subs.delete(ws);
    if (!g.subs.size) this.groups.delete(g.key);
    if (!this.groups.size) this.stop();
  }

  private send(ws: LiveClient, text: string): void {
    if (ws.readyState !== 1 || ws.bufferedAmount >= SEND_BUFFER) return;
    ws.send(text);
    this.stats.bytes += text.length;
  }

  private snapshot(g: Group, ws: LiveClient, id: string): void {
    g.text ??= JSON.stringify(g.body);
    this.stats.snapshots++;
    this.send(ws, `{"t":"ls","id":${JSON.stringify(id)},"seq":${g.seq},"body":${g.text}}`);
  }

  /** A new answer for a group: the whole of it to everyone the first time, else the patch (nothing when equal). */
  private publish(g: Group, body: unknown): void {
    if (g.body === null) {
      g.body = body;
      g.text = null;
      g.seq++;
      for (const [ws, ids] of g.subs) for (const id of ids) this.snapshot(g, ws, id);
      return;
    }
    const p: Patch | undefined = diff(g.body, body);
    g.body = body;
    g.text = null;
    if (p === undefined) return;
    g.seq++;
    const tail = `,"seq":${g.seq},"p":${JSON.stringify(p)}}`;
    for (const [ws, ids] of g.subs) {
      for (const id of ids) { this.stats.patches++; this.send(ws, `{"t":"lp","id":${JSON.stringify(id)}${tail}`); }
    }
  }

  private async build(g: Group, loadAt?: number | null): Promise<void> {
    g.busy = true;
    const t0 = performance.now();
    const now = this.src.now();
    try {
      let body: unknown;
      if (g.ask.kind === 'flow') {
        // Its print count as of now, before the read: a print landing during the read moves it again, and is built next.
        g.stamp = this.src.flowStamp(g.ask.ask, now);
        const w = await this.src.flowWindow(g.ask.ask, now, 0);
        body = w ? { ok: true, ...w } : notRecorded;
        if (w?.final) g.done = true;
      } else {
        g.loadAt = loadAt === undefined ? await this.src.cohortLoadAt() : loadAt;
        const text = await this.src.cohortJob(g.ask.job);
        body = text === null ? notRunning : JSON.parse(text);
      }
      this.stats.builds++;
      g.at = this.src.now();
      if (this.groups.get(g.key) === g) this.publish(g, body);
    } catch (e) {
      // A read that failed: said like the route says it, and asked again on the next refresh.
      g.at = this.src.now();
      if (g.body === null && this.groups.get(g.key) === g) this.publish(g, { ok: false, code: 'upstream', error: String((e as Error)?.message ?? e) });
    } finally {
      g.cost = performance.now() - t0;
      g.busy = false;
    }
  }

  /** One pass over the groups (every TICK_MS; tests call it with their own clock). */
  async tick(): Promise<void> {
    const now = this.src.now();
    let loadAt: number | null | undefined;
    const work: Array<Promise<void>> = [];
    for (const g of this.groups.values()) {
      if (g.busy || g.done) continue;
      if (g.ask.kind === 'flow') {
        const ask = g.ask.ask;
        if (now - g.checkedAt < Math.max(THROTTLE_MS, 4 * g.cost)) continue;
        g.checkedAt = now;
        let due: boolean;
        if (ask.to + FORMING_SLACK_MS > now) {
          const stamp = this.src.flowStamp(ask, now);
          due = stamp !== g.stamp || now - g.at >= LIVE_REFRESH_MS;
        } else {
          const w = g.body as Partial<FlowWindow> | null;
          const pending = !!(w?.coverage?.pending || w?.checks?.some((c) => c.pending));
          due = now - g.at >= (pending ? PENDING_REFRESH_MS : CLOSED_REFRESH_MS);
        }
        if (due) work.push(this.build(g));
      } else {
        if (loadAt === undefined) loadAt = await this.src.cohortLoadAt();
        if ((loadAt !== null && loadAt !== g.loadAt) || now - g.at >= COHORT_REFRESH_MS) work.push(this.build(g, loadAt));
      }
    }
    await Promise.all(work);
  }

  private start(): void {
    if (this.timer || this.opts.timer === false) return;
    let running = false;
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.tick().finally(() => { running = false; });
    }, TICK_MS);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The hub with the API's own readers (flow/read.ts on its read-only connection, the cohort thread). */
export async function defaultLiveHub(parse: LiveSources['parse']): Promise<LiveHub> {
  const F = await import('../flow/read.js');
  const C = await import('../indexer/cohortThread.js');
  return new LiveHub({
    parse,
    flowWindow: (ask, now, maxAgeMs) => F.flowWindow(ask, now, maxAgeMs),
    flowStamp: (ask, now) => F.flowStamp(ask, now),
    cohortJob: (job) => C.cohortJob(job),
    cohortLoadAt: () => C.cohortLoadAt(),
    now: () => Date.now(),
  });
}
