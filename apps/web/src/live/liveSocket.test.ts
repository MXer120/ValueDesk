/**
 * Run: npx tsx --test apps/web/src/live/liveSocket.test.ts
 *
 * The tab's live socket (liveSocket.ts): one socket for every read; a read's whole answer, then patches merged in order to
 * exactly the server's answer; a patch out of order asks for the whole answer again; a refused path and a lost socket say
 * `down` (the page polls); it reconnects with backoff and subscribes everything again; the last unsubscribe closes it after
 * IDLE_CLOSE_MS; a tab hidden for HIDDEN_CLOSE_MS closes it and reopens when shown. And when the hook reads over HTTP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installViteStubs } from '../components/macro/testEnv';

installViteStubs();
const { LiveSocket, IDLE_CLOSE_MS } = await import('./liveSocket');
const { httpPlan } = await import('./useLiveRead');
const { HIDDEN_CLOSE_MS } = await import('../components/liqmap/liveHeat');
const { diff } = await import('@sign/live/jsonPatch.js');
type LiveEvent = import('./liveSocket').LiveEvent;

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeWs.all.push(this); }
  send(text: string): void { this.sent.push(JSON.parse(text)); }
  close(): void { this.readyState = 3; this.onclose?.({}); }
  // The server's side.
  accept(): void { this.readyState = 1; this.onopen?.({}); }
  push(m: object): void { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop(): void { this.readyState = 3; this.onclose?.({}); }
}

function rig() {
  FakeWs.all = [];
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let now = 0;
  let nextId = 1;
  const listeners: Array<() => void> = [];
  const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (_: string, fn: () => void) => { listeners.push(fn); } };
  const sock = new LiveSocket('ws://x/ws/liq', {
    WebSocket: FakeWs as never,
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    document: doc as never,
  });
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  const setVisible = (v: boolean) => { doc.visibilityState = v ? 'visible' : 'hidden'; for (const fn of listeners) fn(); };
  return { sock, advance, setVisible };
}

const last = (evs: LiveEvent[]) => evs.at(-1);

test('one socket for every read; whole answer then patches merged to exactly the server answer', () => {
  const { sock } = rig();
  const a: LiveEvent[] = [];
  const b: LiveEvent[] = [];
  sock.subscribe('/api/vs/flow?coin=BTC', (e) => a.push(e));
  sock.subscribe('/api/vs/cohorts', (e) => b.push(e));
  assert.equal(FakeWs.all.length, 1, 'one socket');
  assert.equal(last(a)?.kind, 'down', 'not up yet: the page reads HTTP');
  const ws = FakeWs.all[0]!;
  ws.accept();
  assert.deepEqual(ws.sent.map((m) => [m.op, m.path]), [['live', '/api/vs/flow?coin=BTC'], ['live', '/api/vs/cohorts']]);
  const id = ws.sent[0]!.id as string;
  const v1 = { ok: true, rows: [{ venue: 'hyperliquid', key: 'a', vol: 1 }], summary: { total: 1 } };
  const v2 = { ok: true, rows: [{ venue: 'hyperliquid', key: 'b', vol: 5 }, { venue: 'hyperliquid', key: 'a', vol: 1 }], summary: { total: 6 } };
  const v3 = { ok: true, rows: [{ venue: 'hyperliquid', key: 'b', vol: 7 }, { venue: 'hyperliquid', key: 'a', vol: 1 }], summary: { total: 8 } };
  ws.push({ t: 'ls', id, seq: 4, body: v1 });
  ws.push({ t: 'lp', id, seq: 5, p: diff(v1, v2) });
  ws.push({ t: 'lp', id, seq: 6, p: diff(v2, v3) });
  assert.deepEqual(a.filter((e) => e.kind === 'data').map((e) => (e as { body: unknown }).body), [v1, v2, v3]);
  // The unchanged row keeps its identity (React does not redraw it).
  const d2 = (a[2] as { body: typeof v2 }).body;
  const d3 = (a[3] as { body: typeof v3 }).body;
  assert.equal(d2.rows[1], d3.rows[1]);
  assert.equal(b.filter((e) => e.kind === 'data').length, 0, 'the other read hears only its own frames');
  // A second listener on the same path shares the subscription and hears what is held at once.
  const c: LiveEvent[] = [];
  sock.subscribe('/api/vs/flow?coin=BTC', (e) => c.push(e));
  assert.equal(ws.sent.length, 2);
  assert.deepEqual(c, [{ kind: 'data', body: v3 }]);
});

test('a patch out of order asks for the whole answer again; a refused path says down', () => {
  const { sock } = rig();
  const a: LiveEvent[] = [];
  const r: LiveEvent[] = [];
  sock.subscribe('/api/vs/flow?coin=BTC', (e) => a.push(e));
  sock.subscribe('/api/vs/leaderboard', (e) => r.push(e));
  const ws = FakeWs.all[0]!;
  ws.accept();
  const [fid, lid] = ws.sent.map((m) => m.id as string);
  ws.push({ t: 'ls', id: fid, seq: 1, body: { ok: true, n: 1 } });
  ws.push({ t: 'lp', id: fid, seq: 3, p: { o: { n: { $: 3 } } } });
  assert.equal(a.filter((e) => e.kind === 'data').length, 1, 'the gap is not applied');
  assert.deepEqual(ws.sent.at(-1), { op: 'live', id: fid, path: '/api/vs/flow?coin=BTC' });
  ws.push({ t: 'ls', id: fid, seq: 3, body: { ok: true, n: 3 } });
  assert.deepEqual(last(a), { kind: 'data', body: { ok: true, n: 3 } });
  ws.push({ t: 'le', id: lid, error: 'not pushed' });
  assert.deepEqual(last(r), { kind: 'down' });
});

test('a lost socket says down, reconnects with backoff and subscribes again', () => {
  const { sock, advance } = rig();
  const a: LiveEvent[] = [];
  const ups: boolean[] = [];
  sock.onStatus((u) => ups.push(u));
  sock.subscribe('/api/vs/cohorts', (e) => a.push(e));
  FakeWs.all[0]!.accept();
  FakeWs.all[0]!.push({ t: 'ls', id: FakeWs.all[0]!.sent[0]!.id, seq: 1, body: { ok: true } });
  FakeWs.all[0]!.drop();
  assert.deepEqual(last(a), { kind: 'down' });
  advance(999);
  assert.equal(FakeWs.all.length, 1);
  advance(1);
  assert.equal(FakeWs.all.length, 2, 'again after 1 s');
  FakeWs.all[1]!.drop();
  advance(1_999);
  assert.equal(FakeWs.all.length, 2);
  advance(1);
  assert.equal(FakeWs.all.length, 3, 'then after 2 s');
  FakeWs.all[2]!.accept();
  assert.deepEqual(FakeWs.all[2]!.sent.map((m) => m.path), ['/api/vs/cohorts']);
  assert.deepEqual(ups, [true, false, true]);
});

test('closed IDLE_CLOSE_MS after the last read goes; a hidden tab closes it, shown again it reopens', () => {
  const { sock, advance, setVisible } = rig();
  const off = sock.subscribe('/api/vs/cohorts', () => undefined);
  const ws = FakeWs.all[0]!;
  ws.accept();
  off();
  assert.deepEqual(ws.sent.at(-1), { op: 'live.off', id: ws.sent[0]!.id });
  advance(IDLE_CLOSE_MS);
  assert.equal(ws.readyState, 3);
  assert.equal(sock.up, false);

  sock.subscribe('/api/vs/cohorts', () => undefined);
  const ws2 = FakeWs.all.at(-1)!;
  ws2.accept();
  setVisible(false);
  advance(HIDDEN_CLOSE_MS);
  assert.equal(ws2.readyState, 3);
  advance(60_000);
  assert.equal(FakeWs.all.length, 2, 'no reconnect while hidden');
  setVisible(true);
  assert.equal(FakeWs.all.length, 3, 'shown again: open at once');
});

test('the hook reads HTTP at once without a socket, after a wait while it is up, never while it streams', () => {
  assert.equal(httpPlan(false, false, true), 'now');
  assert.equal(httpPlan(false, true, true), 'wait');
  assert.equal(httpPlan(false, true, false), 'now');
  assert.equal(httpPlan(true, true, true), 'none');
});
