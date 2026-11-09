/**
 * Run: npx tsx --test test/liqFeedThread.test.ts   (from apps/server)
 *
 * The API's copy of the heatmap feed (indexer/liqFeed.ts) worked out on the feed's own thread (2026-11-09: the freeze
 * gate rolled v0.2.200 back on stalls "by liq:feed"): the copy and every change announced equal what the reader before
 * it (v0.2.198, kept below as `before`) held and announced, frame by frame over a scripted run of new coins, deltas,
 * minute refreshes, new layouts and fine layers; inline and on the thread; and a large coin is written into the copy
 * in slices, none of them long.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { LiqFeedState, type CoinChange, type LiveCoin } from '../src/indexer/liqFeed.js';
import type { LiveDelta } from '../src/valuedesk/liquidations/live.js';
import type { LiqRow } from '../src/valuedesk/liquidations/levels.js';
import type { Venue } from '../src/valuedesk/types.js';

// --- the reader before the thread (v0.2.198 LiqFeedState.apply/applyFine), verbatim but for `this` ---------------

function before(coins: Map<string, LiveCoin>, d: LiveDelta): CoinChange {
  const old = coins.get(d.coin);
  const relayout = !old || old.ep !== d.ep;
  const c: LiveCoin = relayout || d.whole ? { p: d.p, st: d.st, ep: d.ep, at: Date.now(), v: d.whole || relayout ? new Map() : old!.v, ...(old?.f && !relayout ? { f: old.f } : {}) } : old!;
  c.p = d.p;
  c.at = Date.now();
  coins.set(d.coin, c);
  const venues = new Map<Venue, number[]>();
  const covered = new Set<Venue>();
  for (const [venue, x] of Object.entries(d.v) as Array<[Venue, NonNullable<LiveDelta['v'][Venue]>]>) {
    let v = c.v.get(venue);
    if (!v) { v = { b: new Map(), c: [0, 0, 0, 0, 0, 0, 0, 0], o: [0, 0, 0, 0] }; c.v.set(venue, v); }
    const idx: number[] = [];
    for (const r of x.b) {
      const i = r[0];
      if (!r[3] && !r[4]) v.b.delete(i);
      else v.b.set(i, r.slice(1));
      idx.push(i);
    }
    if (x.c) { v.c = x.c; covered.add(venue); }
    if (x.o) v.o = x.o;
    venues.set(venue, idx);
  }
  if (d.whole && !relayout) {
    for (const [venue, idx] of venues) {
      const was = old!.v.get(venue);
      const now = c.v.get(venue)!;
      const diff = new Set<number>();
      for (const i of idx) { const p = was?.b.get(i); const q = now.b.get(i); if (!p || !q || p.length !== q.length || p.some((y, k) => y !== q[k])) diff.add(i); }
      for (const i of was?.b.keys() ?? []) if (!now.b.has(i)) diff.add(i);
      venues.set(venue, [...diff]);
      if (was && was.c.every((y, k) => y === now.c[k])) covered.delete(venue);
    }
    for (const [venue, was] of old!.v) {
      if (c.v.has(venue)) continue;
      venues.set(venue, [...was.b.keys()]);
      covered.add(venue);
    }
  }
  let fine: CoinChange['fine'];
  if (d.f) {
    const f = d.f;
    const whole = f.whole || !c.f || c.f.ep !== f.ep;
    if (whole) c.f = { st: f.st, lo: f.lo, hi: f.hi, ep: f.ep, v: new Map() };
    const held = c.f!;
    const fv = new Map<Venue, number[]>();
    for (const [venue, rows] of Object.entries(f.v) as Array<[Venue, LiqRow[]]>) {
      let m = held.v.get(venue);
      if (!m) { m = new Map(); held.v.set(venue, m); }
      const idx: number[] = [];
      for (const r of rows) {
        if (!r[3] && !r[4]) m.delete(r[0]);
        else m.set(r[0], r.slice(1));
        idx.push(r[0]);
      }
      fv.set(venue, idx);
    }
    fine = { whole, venues: fv };
  }
  return { coin: d.coin, whole: relayout, venues, covered, ...(fine ? { fine } : {}) };
}

// --- a scripted feed -------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const VS: Venue[] = ['hyperliquid', 'sodex', 'lighter'];

/** What the engine would send, at random: new coins, deltas, minute refreshes (a few values moved, rows gone, a venue gone or new), new layouts, fine layers. */
function script(seed: number, frames: number): LiveDelta[] {
  const r = rng(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const row = (i: number): LiqRow => {
    const x = r();
    if (x < 0.08) return [i, 0, 0, 0, 0];
    const n = 5 + (r() < 0.5 ? 6 : Math.floor(r() * 4));
    const out = [i, Math.round(r() * 1e5), Math.round(r() * 1e5), Math.floor(r() * 3), Math.floor(r() * 3) + (r() < 0.5 ? 1 : 0)] as LiqRow;
    for (let k = 5; k < n; k++) out.push(Math.round(r() * 1e4));
    return out;
  };
  // The engine's own view: per coin its epoch, rows per venue and fine layer.
  type Held = { ep: number; v: Map<Venue, Map<number, LiqRow>>; c: Map<Venue, number[]>; f: { ep: number; st: number; lo: number; hi: number; v: Map<Venue, Map<number, LiqRow>> } | null };
  const held = new Map<string, Held>();
  let epoch = 0;
  const fill = (n: number, from: number) => { const m = new Map<number, LiqRow>(); for (let k = 0; k < n; k++) { const x = row(from + Math.floor(r() * n * 3)); if (x[3] || x[4]) m.set(x[0], x); } return m; };
  const out: LiveDelta[] = [];
  for (let k = 0; k < frames; k++) {
    const coin = pick(['BTC', 'ETH', 'SOL', 'DOGE']);
    let h = held.get(coin);
    const x = r();
    const cov = () => (r() < 0.5 ? [1, 1, 1, 1, 10, 0, 1, 1] : [r(), r(), 1, 1, Math.floor(r() * 9), 0, 1, 1]);
    if (!h || x < 0.08) {
      // New coin or a new layout: whole.
      h = { ep: ++epoch, v: new Map(), c: new Map(), f: null };
      held.set(coin, h);
      for (const v of VS) if (r() < 0.8) { h.v.set(v, fill(40, 100)); h.c.set(v, cov()); }
      const d: LiveDelta = { coin, p: 100 + r(), st: 2, ep: h.ep, whole: true, v: {} };
      for (const [v, m] of h.v) d.v[v] = { b: [...m.values()], c: h.c.get(v) as never, o: [1, 2, 3, 4] };
      if (r() < 0.7) {
        h.f = { ep: ++epoch, st: 0.1, lo: 50, hi: 300, v: new Map() };
        for (const v of VS) if (r() < 0.8) h.f.v.set(v, fill(60, 1000));
        d.f = { st: h.f.st, lo: h.f.lo, hi: h.f.hi, ep: h.f.ep, whole: true, v: Object.fromEntries([...h.f.v].map(([v, m]) => [v, [...m.values()]])) };
      }
      out.push(d);
      continue;
    }
    if (x < 0.3) {
      // The minute refresh: every venue whole in the same layout; some values moved, some rows gone or zero, a venue gone or new, the coverage the same or not.
      if (r() < 0.2 && h.v.size) h.v.delete(pick([...h.v.keys()]));
      if (r() < 0.2) { const v = pick(VS); if (!h.v.has(v)) { h.v.set(v, fill(20, 100)); h.c.set(v, cov()); } }
      const d: LiveDelta = { coin, p: 100 + r(), st: 2, ep: h.ep, whole: true, v: {} };
      for (const [v, m] of h.v) {
        for (const [i, y] of m) { const u = r(); if (u < 0.15) m.set(i, row(i)); else if (u < 0.2) m.delete(i); else if (u < 0.25) { const z = y.slice() as LiqRow; z.push(7); m.set(i, z); } }
        if (r() < 0.4) h.c.set(v, cov());
        const rows = [...m.values()];
        // A row of zeros in a whole frame (a level just gone).
        if (r() < 0.3) rows.push([9_999, 0, 0, 0, 0]);
        d.v[v] = r() < 0.9 ? { b: rows, c: h.c.get(v) as never, o: [5, 6, 7, 8] } : { b: rows };
      }
      if (h.f && r() < 0.8) {
        // The fine layer whole in its layout (resendAll), a venue maybe left out.
        const fv: Record<string, LiqRow[]> = {};
        for (const [v, m] of h.f.v) {
          if (r() < 0.1) { h.f.v.delete(v); continue; }
          for (const [i] of m) { const u = r(); if (u < 0.1) m.set(i, row(i)); else if (u < 0.15) m.delete(i); }
          fv[v] = [...m.values()];
        }
        d.f = { st: h.f.st, lo: h.f.lo, hi: h.f.hi, ep: h.f.ep, whole: true, v: fv };
      }
      out.push(d);
      continue;
    }
    // A delta: some rows of some venues (a venue maybe new), the coverage now and then; the fine layer's cells, or a new layout of it.
    const d: LiveDelta = { coin, p: 100 + r(), st: 2, ep: h.ep, whole: false, v: {} };
    for (const v of VS) {
      if (r() < 0.4) continue;
      let m = h.v.get(v);
      if (!m) { m = new Map(); h.v.set(v, m); }
      const rows: LiqRow[] = [];
      for (let j = 0; j < 1 + Math.floor(r() * 8); j++) { const y = row(100 + Math.floor(r() * 120)); rows.push(y); if (y[3] || y[4]) m.set(y[0], y); else m.delete(y[0]); }
      const e: NonNullable<LiveDelta['v'][Venue]> = { b: rows };
      if (r() < 0.3) { const c = cov(); h.c.set(v, c); e.c = c as never; }
      if (r() < 0.3) e.o = [1, 1, 1, 1];
      d.v[v] = e;
    }
    const y = r();
    if (h.f && y < 0.5) {
      const fv: Record<string, LiqRow[]> = {};
      for (const v of VS) {
        if (r() < 0.5) continue;
        let m = h.f.v.get(v);
        if (!m) { m = new Map(); h.f.v.set(v, m); }
        const rows: LiqRow[] = [];
        for (let j = 0; j < 1 + Math.floor(r() * 6); j++) { const z = row(1000 + Math.floor(r() * 150)); rows.push(z); if (z[3] || z[4]) m.set(z[0], z); else m.delete(z[0]); }
        fv[v] = rows;
      }
      d.f = { st: h.f.st, lo: h.f.lo, hi: h.f.hi, ep: h.f.ep, whole: false, v: fv };
    } else if (y < 0.6) {
      // The fine layer laid out anew (the price moved a tenth), sent as a delta of the new epoch (the API takes it whole).
      h.f = { ep: ++epoch, st: 0.1, lo: 60 + r(), hi: 320, v: new Map([['sodex', fill(10, 1000)]]) };
      d.f = { st: h.f.st, lo: h.f.lo, hi: h.f.hi, ep: h.f.ep, whole: r() < 0.5, v: { sodex: [...h.f.v.get('sodex')!.values()] } };
    }
    out.push(d);
  }
  return out;
}

/** A copy as data: every row by index (the order a map holds them in is not part of it), without `at`. */
function plain(coins: Map<string, LiveCoin>) {
  const rows = (m: Map<number, number[]>) => [...m].sort((a, b) => a[0] - b[0]);
  return Object.fromEntries([...coins].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([coin, c]) => [coin, {
    p: c.p, st: c.st, ep: c.ep,
    v: Object.fromEntries([...c.v].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([v, x]) => [v, { b: rows(x.b), c: x.c, o: x.o }])),
    f: c.f ? { st: c.f.st, lo: c.f.lo, hi: c.f.hi, ep: c.f.ep, v: Object.fromEntries([...c.f.v].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([v, m]) => [v, rows(m)])) } : null,
  }]));
}

const line = (d: LiveDelta) => `${JSON.stringify({ t: 'd', ...d })}\n`;
const turn = () => new Promise<void>((r) => setImmediate(r));

test('inline: frame by frame, the copy and the changes announced are what the reader before held and announced', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const frames = script(seed, 400);
    const ref = new Map<string, LiveCoin>();
    const s = new LiqFeedState(0, { thread: false });
    const got: CoinChange[] = [];
    s.on('change', (c: CoinChange) => got.push(c));
    for (let k = 0; k < frames.length; k++) {
      const want = before(ref, frames[k]!);
      s.data(line(frames[k]!));
      while (s.backlog) await turn();
      assert.equal(got.length, k + 1, `seed ${seed} frame ${k}: announced`);
      assert.deepStrictEqual(got[k], want, `seed ${seed} frame ${k}: the change`);
      assert.deepStrictEqual(plain(s.coins), plain(ref), `seed ${seed} frame ${k}: the copy`);
    }
    // The script went through every kind of frame.
    assert.ok(got.some((c) => c.whole) && got.some((c) => !c.whole && c.fine?.whole) && got.some((c) => c.fine && !c.fine.whole), `seed ${seed}: kinds`);
  }
});

/** A feed server of the test's own: one reader, lines written as given. */
async function feedServer(): Promise<{ port: number; reader: () => Promise<net.Socket>; close: () => void }> {
  let sock: net.Socket | null = null;
  const srv = net.createServer((s) => { sock = s; s.on('error', () => {}); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    port,
    reader: async () => { for (let i = 0; i < 1_000 && !sock; i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(sock, 'the reader connected'); return sock!; },
    close: () => { (sock as net.Socket | null)?.destroy(); srv.close(); },
  };
}

test('on the feed\'s thread: the same copy and the same changes, in order, after a tick', async () => {
  const frames = script(11, 600);
  const ref = new Map<string, LiveCoin>();
  const want = frames.map((d) => before(ref, d));
  const srv = await feedServer();
  const s = new LiqFeedState(srv.port, { thread: true });
  const got: CoinChange[] = [];
  let ticks = 0;
  s.on('change', (c: CoinChange) => got.push(c));
  s.on('tick', () => { ticks++; });
  s.start();
  try {
    const sock = await srv.reader();
    for (let i = 0; i < 500 && !s.connected; i++) await new Promise((r) => setTimeout(r, 10));
    // In pieces cut anywhere, as a socket delivers them.
    const all = `${frames.map(line).join('')}${JSON.stringify({ t: 'tick', at: 7, ready: true })}\n`;
    for (let at = 0; at < all.length; at += 7_777) sock.write(all.slice(at, at + 7_777));
    for (let i = 0; i < 1_000 && !ticks; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(ticks, 1);
    assert.ok(s.live);
    assert.equal(got.length, want.length);
    for (let k = 0; k < want.length; k++) assert.deepStrictEqual(got[k], want[k], `frame ${k}`);
    assert.deepStrictEqual(plain(s.coins), plain(ref));
  } finally {
    s.stop();
    srv.close();
  }
});

test('a large coin (5 venues of 5,000 levels and 50,000 fine cells) is written in slices: none holds this thread 50 ms', async () => {
  const VENUES: Venue[] = ['hyperliquid', 'sodex', 'tradexyz', 'lighter', 'arcus'];
  const r = rng(3);
  const row = (i: number) => [i, Math.round(r() * 1e6), Math.round(r() * 1e6), 1, 2, Math.round(r() * 1e5), Math.round(r() * 1e5), Math.round(r() * 1e5), Math.round(r() * 1e5), Math.round(r() * 1e5), Math.round(r() * 1e5)];
  const b = VENUES.map(() => Array.from({ length: 5_000 }, (_, i) => row(5_000 + i)));
  const f = VENUES.map(() => Array.from({ length: 50_000 }, (_, i) => row(70_000 + i)));
  const frame = (at: number) => `${JSON.stringify({
    t: 'd', coin: 'BTC', p: 100_000, st: 20, ep: 1, whole: true,
    v: Object.fromEntries(VENUES.map((v, k) => [v, { b: b[k], c: [1, 1, 1, 1, 9, 0, 1, 1], o: [1, 2, 3, 4] }])),
    f: { st: 1, lo: 20_000, hi: 300_000, ep: 2, whole: true, v: Object.fromEntries(VENUES.map((v, k) => [v, f[k]])) },
  })}\n${JSON.stringify({ t: 'tick', at, ready: true })}\n`;
  const first = frame(1);
  const was = b[0]!.map((x) => x[1]);
  for (const rows of [...b, ...f]) for (const x of rows) if (r() < 0.1) x[1] = Math.round(r() * 1e6);
  const second = frame(2);
  const srv = await feedServer();
  const s = new LiqFeedState(srv.port, { thread: true });
  // Every turn this thread gives the copy, timed.
  const P = LiqFeedState.prototype as unknown as { drain: () => void };
  const drain = P.drain;
  let longest = 0;
  let turns = 0;
  (s as unknown as { drain: () => void }).drain = function (this: LiqFeedState) {
    const t0 = performance.now();
    drain.call(this);
    longest = Math.max(longest, performance.now() - t0);
    turns++;
  };
  let ticks = 0;
  let changed: CoinChange | null = null;
  s.on('tick', () => { ticks++; });
  s.on('change', (c: CoinChange) => { changed = c; });
  s.start();
  try {
    const sock = await srv.reader();
    for (let i = 0; i < 500 && !s.connected; i++) await new Promise((res) => setTimeout(res, 10));
    sock.write(first);
    for (let i = 0; i < 3_000 && ticks < 1; i++) await new Promise((res) => setTimeout(res, 10));
    sock.write(second);
    for (let i = 0; i < 3_000 && ticks < 2; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(ticks, 2);
    assert.ok(turns > 2, `turns ${turns}`);
    assert.ok(longest < 50, `the longest turn took ${longest.toFixed(1)} ms`);
    const c = s.coins.get('BTC')!;
    assert.deepEqual(c.v.get('lighter')!.b.get(5_123), b[3]![123]!.slice(1));
    assert.deepEqual(c.f!.v.get('arcus')!.get(70_000 + 4_321), f[4]![4_321]!.slice(1));
    assert.equal(c.f!.v.get('sodex')!.size, 50_000);
    // The refresh announced only the levels that moved; the fine layer whole (as before).
    const ch = changed! as CoinChange;
    const moved = b[0]!.filter((x, i) => x[1] !== was[i]).length;
    assert.equal(ch.venues.get('hyperliquid')!.length, moved);
    assert.equal(ch.fine!.whole, true);
  } finally {
    s.stop();
    srv.close();
  }
});
