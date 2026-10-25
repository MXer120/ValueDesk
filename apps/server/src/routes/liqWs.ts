/**
 * GET /ws/liq - the liquidation heatmap, live (the one WebSocket hosted mode serves).
 *
 * The API holds every coin's levels as the indexer streams them (indexer/liqFeed.ts,
 * a second apart). A browser subscribes to one coin over a set of venues and gets:
 *
 *   {t:"s", ...LiqHeatmap, k, live} the whole heatmap at the width asked (k): on subscribing,
 *                                  every SNAP_MS, and on a new layout
 *                                  (open interest and accuracy refreshed)
 *   {t:"d", coin, at, p, b, cov}   once a second while it moves: the buckets that changed,
 *                                  summed over the venues ([index, long USD, short USD,
 *                                  long n, short n], all zero = gone), and the venues whose
 *                                  coverage moved ([long, short, long priced, short priced, n])
 *
 * A subscription names the bucket width the viewer draws (`k` server buckets; it
 * subscribes again when it zooms): the stream is summed to it, so a liquidation price
 * moving within a drawn bar costs nothing, and a bar goes out again only once its USD
 * moved SEND_MOVE (measured on BTC at the server's 0.02% buckets: ~130 changes a
 * second, nearly all hops between neighbours). One subscription per connection (a new
 * one replaces it); viewers of the same coin, venues and width share one computation. On the instance, Caddy passes this
 * path through without the origin secret the rest of the API needs (a browser
 * cannot connect through Vercel's functions), with the viewer's own address for
 * the per-address limit; the API checks the site Origin itself.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { VENUES, type Venue } from '../valuescan/types.js';
import { liqFeed, type CoinChange } from '../indexer/liqFeed.js';
import { heatOf, liqHeatmap, liveSrc } from '../indexer/liqRead.js';
import { marketsNow } from '../valuescan/liquidations/rules.js';

export const LIQ_WS_PATH = '/ws/liq';
const MAX_CONNECTIONS = Number(process.env.VALUESCAN_LIQ_WS_MAX) || 5_000;
const MAX_PER_ADDRESS = 12;
/** The whole heatmap again this often (and on subscribing). */
const SNAP_MS = 60_000;
const PING_MS = 25_000;
/** Messages a client may send in 10 s (subscribing is all it does). */
const MAX_MSGS = 20;

interface Group {
  coin: string;
  venues: Venue[];
  /** Server buckets per streamed bucket: the width the viewer draws (it re-subscribes on zoom). */
  k: number;
  conns: Set<WebSocket>;
  snapAt: number;
  /** What was last sent per streamed bucket (sums over the venues), to skip moves under SEND_MOVE. */
  sent: Map<number, [number, number, number, number]>;
}

/** Widths a viewer may ask for, in server buckets (the web's groupFor uses the same). */
const MULTIPLES = new Set([1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
/** A streamed bucket goes out again once its USD moved this much (or it appeared or went). */
const SEND_MOVE = 0.01;
const near = (a: number, b: number) => Math.abs(a - b) <= SEND_MOVE * Math.max(Math.abs(a), Math.abs(b), 1);

/** Buckets summed k at a time: [index at k, long USD, short USD, long n, short n]. */
export function aggregate(rows: ReadonlyArray<[number, number, number, number, number]>, k: number): Array<[number, number, number, number, number]> {
  if (k <= 1) return rows.slice();
  const by = new Map<number, [number, number, number, number, number]>();
  for (const [i, l, s, ln, sn] of rows) {
    const j = Math.floor(i / k);
    const x = by.get(j);
    if (x) { x[1] += l; x[2] += s; x[3] += ln; x[4] += sn; } else by.set(j, [j, l, s, ln, sn]);
  }
  return [...by.values()].sort((a, b) => a[0] - b[0]);
}

const groups = new Map<string, Group>();
const subOf = new WeakMap<WebSocket, string>();
const perAddress = new Map<string, number>();
let connections = 0;
/** Coin -> venue -> changed bucket indices since the last tick; and venues whose coverage moved. */
const pending = new Map<string, { b: Map<Venue, Set<number>>; c: Set<Venue>; whole: boolean }>();
let wired = false;

const send = (ws: WebSocket, msg: unknown) => {
  if (ws.readyState === 1 && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
};

async function snapshot(g: Group): Promise<string | null> {
  const heat = await liqHeatmap(g.coin, g.venues).catch(() => null);
  if (!heat) return null;
  const buckets = aggregate(heat.buckets, g.k);
  g.sent = new Map(buckets.map(([i, l, s, ln, sn]) => [i, [l, s, ln, sn]]));
  return JSON.stringify({ t: 's', ...heat, step: +(heat.step * g.k).toPrecision(12), k: g.k, buckets, live: liqFeed().live });
}

/** The changed streamed buckets of one coin over a group's venues, summed, past what moved under SEND_MOVE. */
function deltaFor(g: Group, ch: { b: Map<Venue, Set<number>>; c: Set<Venue> }): string | null {
  const c = liqFeed().coins.get(g.coin);
  if (!c) return null;
  const idx = new Set<number>();
  for (const v of g.venues) for (const i of ch.b.get(v) ?? []) idx.add(Math.floor(i / g.k));
  const now = new Map<number, [number, number, number, number]>();
  if (idx.size) {
    for (const v of g.venues) {
      for (const [i, y] of c.v.get(v)?.b ?? []) {
        const j = Math.floor(i / g.k);
        if (!idx.has(j)) continue;
        const x = now.get(j);
        if (x) { x[0] += y[0]; x[1] += y[1]; x[2] += y[2]; x[3] += y[3]; } else now.set(j, [y[0], y[1], y[2], y[3]]);
      }
    }
  }
  const b: Array<[number, number, number, number, number]> = [];
  for (const j of [...idx].sort((m, n) => m - n)) {
    const y = now.get(j);
    const was = g.sent.get(j);
    if (y && was && near(y[0], was[0]) && near(y[1], was[1])) continue;
    if (!y && !was) continue;
    if (y) { g.sent.set(j, y); b.push([j, Math.round(y[0]), Math.round(y[1]), y[2], y[3]]); }
    else { g.sent.delete(j); b.push([j, 0, 0, 0, 0]); }
  }
  const cov: Partial<Record<Venue, number[]>> = {};
  for (const v of g.venues) if (ch.c.has(v)) { const x = c.v.get(v); if (x) cov[v] = x.c; }
  if (!b.length && !Object.keys(cov).length) return null;
  return JSON.stringify({ t: 'd', coin: g.coin, at: Date.now(), p: c.p, b, cov });
}

function wire(): void {
  if (wired) return;
  wired = true;
  const feed = liqFeed();
  feed.on('change', (ch: CoinChange) => {
    let p = pending.get(ch.coin);
    if (!p) { p = { b: new Map(), c: new Set(), whole: false }; pending.set(ch.coin, p); }
    if (ch.whole) p.whole = true;
    for (const [v, idx] of ch.venues) {
      let s = p.b.get(v);
      if (!s) { s = new Set(); p.b.set(v, s); }
      for (const i of idx) s.add(i);
    }
    for (const v of ch.covered) p.c.add(v);
  });
  feed.on('tick', () => {
    const now = Date.now();
    for (const g of groups.values()) {
      if (!g.conns.size) continue;
      const ch = pending.get(g.coin);
      // A new layout (the price left half to twice the old) goes out whole.
      if (ch?.whole || now - g.snapAt >= SNAP_MS) { void pushSnap(g); continue; }
      if (!ch) continue;
      const msg = deltaFor(g, ch);
      if (msg) for (const ws of g.conns) send(ws, msg);
    }
    pending.clear();
  });
  // Without the feed (the indexer elsewhere or restarting) the snapshots still come, from the minute rows.
  const t = setInterval(() => {
    if (feed.live) return;
    const now = Date.now();
    for (const g of groups.values()) if (g.conns.size && now - g.snapAt >= SNAP_MS) void pushSnap(g);
  }, 5_000);
  t.unref?.();
}

async function pushSnap(g: Group): Promise<void> {
  g.snapAt = Date.now();
  const msg = await snapshot(g);
  if (msg) for (const ws of g.conns) send(ws, msg);
}

function leave(ws: WebSocket): void {
  const key = subOf.get(ws);
  if (!key) return;
  subOf.delete(ws);
  const g = groups.get(key);
  g?.conns.delete(ws);
  if (g && !g.conns.size) groups.delete(key);
}

function join(ws: WebSocket, coin: string, venues: Venue[], k: number): void {
  leave(ws);
  const key = `${coin}|${venues.join(',')}|${k}`;
  let g = groups.get(key);
  const fresh = !g;
  if (!g) { g = { coin, venues, k, conns: new Set(), snapAt: 0, sent: new Map() }; groups.set(key, g); }
  g.conns.add(ws);
  subOf.set(ws, key);
  // A new group gets its snapshot now; a newcomer to a running one gets one for itself.
  if (fresh) void pushSnap(g);
  else void snapshot(g).then((msg) => { if (msg) send(ws, msg); });
}

/** The route. `originOk`: the site's own origins (hosted) or the local dev ones. */
export function liqWsRoute(app: FastifyInstance, originOk: (origin: string | undefined) => boolean): void {
  wire();
  app.get('/ws/liq', { websocket: true }, (socket: WebSocket, req) => {
    const who = req.ip || 'unknown';
    if (!originOk(req.headers.origin)) { socket.close(1008, 'origin not allowed'); return; }
    if (connections >= MAX_CONNECTIONS) { socket.close(1013, 'busy - try again shortly'); return; }
    if ((perAddress.get(who) ?? 0) >= MAX_PER_ADDRESS) { socket.close(1008, 'too many connections from this address'); return; }
    connections++;
    perAddress.set(who, (perAddress.get(who) ?? 0) + 1);
    let msgs = 0;
    let alive = true;
    const window = setInterval(() => { msgs = 0; }, 10_000);
    const ping = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, PING_MS);
    socket.on('pong', () => { alive = true; });
    socket.on('message', (raw: Buffer) => {
      if (++msgs > MAX_MSGS || raw.length > 1024) { socket.close(1008, 'slow down'); return; }
      let m: { op?: string; coin?: unknown; venues?: unknown; k?: unknown };
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.op === 'unsub') { leave(socket); return; }
      if (m.op !== 'sub') return;
      const coin = String(m.coin ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,20}$/.test(coin)) { send(socket, { t: 'error', error: 'coin' }); return; }
      const asked = Array.isArray(m.venues) ? m.venues.map(String) : [];
      const venues = VENUES.filter((v) => !asked.length || asked.includes(v));
      if (!venues.length) { send(socket, { t: 'error', error: 'venues' }); return; }
      const k = MULTIPLES.has(Number(m.k)) ? Number(m.k) : 5;
      join(socket, coin, venues, k);
    });
    const done = () => {
      clearInterval(window);
      clearInterval(ping);
      leave(socket);
      connections--;
      const n = (perAddress.get(who) ?? 1) - 1;
      if (n > 0) perAddress.set(who, n); else perAddress.delete(who);
    };
    socket.once('close', done);
    socket.on('error', () => socket.terminate());
  });
}

/** Status: connections and groups. */
export const liqWsStats = () => ({ connections, groups: groups.size, live: liqFeed().live, coins: liqFeed().coins.size });

// Used by tests: a coin's heatmap straight from the live state (no markets read).
export const _liveHeat = (coin: string, venues: readonly Venue[]) => {
  const src = liveSrc(coin);
  return src ? heatOf(coin, venues, src, new Map(venues.map((v) => [v, marketsNow(v)]))) : null;
};
