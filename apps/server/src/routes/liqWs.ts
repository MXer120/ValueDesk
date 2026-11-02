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
 *                                  long n, short n, ...USD per leverage band]: levels.ts
 *                                  LiqRow; counts zero = gone), and the venues whose
 *                                  coverage moved ([long, short, long priced, short priced, n])
 *   {t:"fs", coin, p, st, k, base, lo, hi, from, to, buckets}
 *                                  with `fine: {k, from, to}`: the fine layer (live.ts FineAgg: BTC
 *                                  $1, `base`, over [lo, hi)) summed k cells at a time over the
 *                                  window [from, to) - on subscribing, with every snapshot and on a
 *                                  new layout of it; then {t:"fd", coin, at, p, b}, its changed
 *                                  cells once a second as the buckets (owner 2026-11-01: $10 and $1
 *                                  "as accurate / updating as the normal heatmap")
 *   {t:"fm", coin, st, lo, hi}     the fine layer laid out anew: its step and reach (also in "s", `fine`)
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
import { VENUES, type Venue } from '../valuedesk/types.js';
import { clientKey } from '../hosted.js';
import { liqFeed, type CoinChange } from '../indexer/liqFeed.js';
import { heatOf, liqHeatmap, liveSrc } from '../indexer/liqRead.js';
import { marketsNow } from '../valuedesk/liquidations/rules.js';
import { FINE_MAX_BUCKETS, addRow, trimRow, type LiqRow } from '../valuedesk/liquidations/levels.js';

export const LIQ_WS_PATH = '/ws/liq';
const MAX_CONNECTIONS = Number(process.env.VALUESCAN_LIQ_WS_MAX) || 5_000;
const MAX_PER_ADDRESS = 12;
/** The whole heatmap again this often (and on subscribing). */
const SNAP_MS = 60_000;
const PING_MS = 25_000;
/** Messages a client may send in 10 s (subscribing is all it does; a pan at $1 moves its window). */
const MAX_MSGS = 60;

interface Group {
  coin: string;
  venues: Venue[];
  /** Server buckets per streamed bucket: the width the viewer draws (it re-subscribes on zoom). */
  k: number;
  conns: Set<WebSocket>;
  snapAt: number;
  /** What was last sent per streamed bucket (a LiqRow summed over the venues), to skip moves under SEND_MOVE. */
  sent: Map<number, LiqRow>;
  /** The fine layer asked for: cells per streamed one and the price window; what was last sent of it. */
  fine: { k: number; from: number; to: number } | null;
  fineSent: Map<number, LiqRow>;
}

/** A fine window holds at most this many streamed cells (it sends only those with levels). */
const FINE_MAX = FINE_MAX_BUCKETS;

/** Widths a viewer may ask for, in server buckets (the web's groupFor uses the same). */
const MULTIPLES = new Set([1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
/** A streamed bucket goes out again once its USD moved this much (or it appeared or went). */
const SEND_MOVE = 0.01;
const near = (a: number, b: number) => Math.abs(a - b) <= SEND_MOVE * Math.max(Math.abs(a), Math.abs(b), 1);
/** Every USD field of two rows (sides and bands) within SEND_MOVE; the counts catch up. */
const nearRow = (y: LiqRow, was: LiqRow) => {
  for (let k = 1; k < Math.max(y.length, was.length); k++) if (k !== 3 && k !== 4 && !near(y[k] ?? 0, was[k] ?? 0)) return false;
  return true;
};

/** Buckets summed k at a time: LiqRows at index i / k, bands and all. */
export function aggregate(rows: ReadonlyArray<LiqRow>, k: number): LiqRow[] {
  if (k <= 1) return rows.slice();
  const by = new Map<number, LiqRow>();
  for (const r of rows) {
    const j = Math.floor(r[0] / k);
    const x = by.get(j);
    if (x) addRow(x, r); else { const y = r.slice() as LiqRow; y[0] = j; by.set(j, y); }
  }
  return [...by.values()].sort((a, b) => a[0] - b[0]);
}

const groups = new Map<string, Group>();
const subOf = new WeakMap<WebSocket, string>();
const perAddress = new Map<string, number>();
let connections = 0;
/** Coin -> venue -> changed bucket indices since the last tick; and venues whose coverage moved. */
const pending = new Map<string, { b: Map<Venue, Set<number>>; c: Set<Venue>; whole: boolean; f: Map<Venue, Set<number>>; fWhole: boolean }>();
let wired = false;

const send = (ws: WebSocket, msg: unknown) => {
  if (ws.readyState === 1 && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
};

async function snapshot(g: Group): Promise<string | null> {
  const heat = await liqHeatmap(g.coin, g.venues).catch(() => null);
  if (!heat) return null;
  const buckets = aggregate(heat.buckets, g.k);
  g.sent = new Map(buckets.map((r) => [r[0], r]));
  return JSON.stringify({ t: 's', ...heat, step: +(heat.step * g.k).toPrecision(12), k: g.k, buckets, live: liqFeed().live, fine: fineMeta(g.coin) });
}

/** The fine layer's step and reach for a coin (null: none held). */
function fineMeta(coin: string): { st: number; lo: number; hi: number } | null {
  const f = liqFeed().coins.get(coin)?.f;
  return f ? { st: f.st, lo: f.lo, hi: f.hi } : null;
}

/** A fine cell's streamed index for a group (null: outside its window). */
function fineIdx(g: Group, st: number, i: number): number | null {
  const px = i * st;
  return px < g.fine!.from || px >= g.fine!.to ? null : Math.floor(i / g.fine!.k);
}

/** The fine layer over a group's window, summed over its venues and k cells at a time (`only`: those streamed cells). */
function fineRows(g: Group, only: Set<number> | null): Map<number, LiqRow> {
  const out = new Map<number, LiqRow>();
  const f = liqFeed().coins.get(g.coin)?.f;
  if (!f || !g.fine) return out;
  for (const v of g.venues) {
    for (const [i, y] of f.v.get(v) ?? []) {
      const j = fineIdx(g, f.st, i);
      if (j === null || (only && !only.has(j))) continue;
      const row = [j, ...y] as LiqRow;
      const x = out.get(j);
      if (x) addRow(x, row); else out.set(j, row);
    }
  }
  return out;
}

/** A row as sent: whole dollars, trailing zeros left off. */
const tidyRow = (y: LiqRow) => trimRow(y.map((v, k) => (k === 3 || k === 4 || k === 0 ? v : Math.round(v))) as LiqRow);

function fineSnapshot(g: Group): string | null {
  const c = liqFeed().coins.get(g.coin);
  const f = c?.f;
  // A layer not kept yet (live.ts want) sends nothing: the viewer keeps what it draws until it is.
  if (!c || !f || !f.on || !g.fine) return null;
  const rows = fineRows(g, null);
  g.fineSent = new Map(rows);
  const buckets = [...rows.values()].sort((a, b) => a[0] - b[0]).map(tidyRow);
  return JSON.stringify({ t: 'fs', coin: g.coin, at: Date.now(), p: c.p, st: +(f.st * g.fine.k).toPrecision(12), k: g.fine.k, base: f.st, lo: f.lo, hi: f.hi, from: g.fine.from, to: g.fine.to, buckets });
}

/** The fine layer's changed streamed cells for a group, past what moved under SEND_MOVE. */
function fineDeltaFor(g: Group, changed: Map<Venue, Set<number>>): string | null {
  const c = liqFeed().coins.get(g.coin);
  const f = c?.f;
  if (!c || !f || !f.on || !g.fine) return null;
  const idx = new Set<number>();
  for (const v of g.venues) {
    for (const i of changed.get(v) ?? []) {
      const j = fineIdx(g, f.st, i);
      if (j !== null) idx.add(j);
    }
  }
  if (!idx.size) return null;
  const now = fineRows(g, idx);
  const b: LiqRow[] = [];
  for (const j of [...idx].sort((m, n) => m - n)) {
    const y = now.get(j);
    const was = g.fineSent.get(j);
    if (y && was && nearRow(y, was)) continue;
    if (!y && !was) continue;
    if (y) { g.fineSent.set(j, y); b.push(tidyRow(y)); } else { g.fineSent.delete(j); b.push([j, 0, 0, 0, 0]); }
  }
  return b.length ? JSON.stringify({ t: 'fd', coin: g.coin, at: Date.now(), p: c.p, b }) : null;
}

/** The changed streamed buckets of one coin over a group's venues, summed, past what moved under SEND_MOVE. */
function deltaFor(g: Group, ch: { b: Map<Venue, Set<number>>; c: Set<Venue> }): string | null {
  const c = liqFeed().coins.get(g.coin);
  if (!c) return null;
  const idx = new Set<number>();
  for (const v of g.venues) for (const i of ch.b.get(v) ?? []) idx.add(Math.floor(i / g.k));
  const now = new Map<number, LiqRow>();
  if (idx.size) {
    for (const v of g.venues) {
      for (const [i, y] of c.v.get(v)?.b ?? []) {
        const j = Math.floor(i / g.k);
        if (!idx.has(j)) continue;
        // y is the row without its index: shifted one place, as the row it was.
        const row = [j, ...y] as LiqRow;
        const x = now.get(j);
        if (x) addRow(x, row); else now.set(j, row);
      }
    }
  }
  const b: LiqRow[] = [];
  for (const j of [...idx].sort((m, n) => m - n)) {
    const y = now.get(j);
    const was = g.sent.get(j);
    if (y && was && nearRow(y, was)) continue;
    if (!y && !was) continue;
    if (y) { g.sent.set(j, y); b.push(trimRow(y.map((v, k) => (k === 3 || k === 4 || k === 0 ? v : Math.round(v))) as LiqRow)); }
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
    if (!p) { p = { b: new Map(), c: new Set(), whole: false, f: new Map(), fWhole: false }; pending.set(ch.coin, p); }
    if (ch.whole) p.whole = true;
    if (ch.fine?.whole) p.fWhole = true;
    for (const [v, idx] of ch.fine?.venues ?? []) {
      let s = p.f.get(v);
      if (!s) { s = new Set(); p.f.set(v, s); }
      for (const i of idx) s.add(i);
    }
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
      // The fine layer laid out anew (the price moved a tenth): its step and reach, and the window whole again.
      if (ch?.fWhole) {
        const fm = fineMeta(g.coin);
        if (fm) for (const ws of g.conns) send(ws, { t: 'fm', coin: g.coin, ...fm });
        const msg = g.fine ? fineSnapshot(g) : null;
        if (msg) for (const ws of g.conns) send(ws, msg);
      } else if (ch && g.fine) {
        const msg = fineDeltaFor(g, ch.f);
        if (msg) for (const ws of g.conns) send(ws, msg);
      }
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
  // The fine window whole with it (exact again after the deltas' SEND_MOVE).
  const fm = g.fine ? fineSnapshot(g) : null;
  if (fm) for (const ws of g.conns) send(ws, fm);
}

function leave(ws: WebSocket): void {
  const key = subOf.get(ws);
  if (!key) return;
  subOf.delete(ws);
  const g = groups.get(key);
  g?.conns.delete(ws);
  if (g && !g.conns.size) groups.delete(key);
  wantFine();
}

/** The coins viewers stream at a fine step, told to the indexer (it keeps only their fine layers, live.ts want). */
function wantFine(): void {
  const coins = new Set<string>();
  for (const g of groups.values()) if (g.fine && g.conns.size) coins.add(g.coin);
  liqFeed().want([...coins]);
}

function join(ws: WebSocket, coin: string, venues: Venue[], k: number, fine: Group['fine']): void {
  const heatKey = `${coin}|${venues.join(',')}|${k}`;
  const key = `${heatKey}|${fine ? `${fine.k}|${fine.from}|${fine.to}` : '-'}`;
  const was = subOf.get(ws);
  // The same subscription again: nothing to do.
  if (was === key) return;
  // Only the fine window moved (a pan at $1): the heatmap held stays, only the window goes out.
  const sameHeat = was !== undefined && was.startsWith(`${heatKey}|`);
  leave(ws);
  let g = groups.get(key);
  const fresh = !g;
  if (!g) { g = { coin, venues, k, conns: new Set(), snapAt: 0, sent: new Map(), fine, fineSent: new Map() }; groups.set(key, g); }
  g.conns.add(ws);
  subOf.set(ws, key);
  wantFine();
  // A new group gets its snapshot now; a newcomer to a running one gets one for itself.
  if (fresh && !sameHeat) { void pushSnap(g); return; }
  if (fresh) g.snapAt = Date.now();
  if (!sameHeat) void snapshot(g).then((msg) => { if (msg) send(ws, msg); });
  const fm = g.fine ? fineSnapshot(g) : null;
  if (fm) send(ws, fm);
}

/**
 * A subscription's fine window: k whole cells of the layer (1-1000) over [from, to), at most
 * FINE_MAX streamed cells; null when not asked or not one (the viewer reads the fine route instead).
 */
function fineAsk(coin: string, x: { k?: unknown; from?: unknown; to?: unknown } | null | undefined): Group['fine'] {
  if (!x || typeof x !== 'object') return null;
  const k = Number(x.k);
  const from = Number(x.from);
  const to = Number(x.to);
  if (!Number.isInteger(k) || k < 1 || k > 1000 || !(from >= 0) || !Number.isFinite(to) || !(to > from)) return null;
  const st = liqFeed().coins.get(coin)?.f?.st;
  if (st && (to - from) / (st * k) > FINE_MAX + 1) return null;
  return { k, from, to };
}

/** The route. `originOk`: the site's own origins (hosted) or the local dev ones. */
export function liqWsRoute(app: FastifyInstance, originOk: (origin: string | undefined) => boolean): void {
  wire();
  app.get('/ws/liq', { websocket: true }, (socket: WebSocket, req) => {
    // The address as the rate limits key it (hosted.ts clientKey): an IPv6 client by its /64, or one
    // subscriber could open a dozen sockets from every address of its block.
    const who = clientKey(req.ip);
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
      let m: { op?: string; coin?: unknown; venues?: unknown; k?: unknown; fine?: { k?: unknown; from?: unknown; to?: unknown } | null };
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.op === 'unsub') { leave(socket); return; }
      if (m.op !== 'sub') return;
      const coin = String(m.coin ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,20}$/.test(coin)) { send(socket, { t: 'error', error: 'coin' }); return; }
      const asked = Array.isArray(m.venues) ? m.venues.map(String) : [];
      const venues = VENUES.filter((v) => !asked.length || asked.includes(v));
      if (!venues.length) { send(socket, { t: 'error', error: 'venues' }); return; }
      const k = MULTIPLES.has(Number(m.k)) ? Number(m.k) : 5;
      join(socket, coin, venues, k, fineAsk(coin, m.fine));
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
