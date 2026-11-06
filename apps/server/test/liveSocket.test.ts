/**
 * The streams' sockets (indexer/streams.ts LiveSocket, LighterStream) against a local server:
 * Lighter's sockets refuse permessage-deflate (2026-10-29: inflating on the shared zlib pool
 * paused reading, and Lighter cut the slow reader), every close is logged with why and how long
 * it was up, a 429 on connect waits out the venue's cooldown, and what Lighter says besides
 * prints reaches the log.
 *   npx tsx --test test/liveSocket.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { LighterStream, LiveSocket } from '../src/indexer/streams.js';

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function wsServer() {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: true });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const upgrades: IncomingMessage[] = [];
  wss.on('headers', (_h, req) => upgrades.push(req));
  return { wss, upgrades, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` };
}

test('deflate: false offers no compression (Lighter); the default still does', async () => {
  const { wss, upgrades, url } = await wsServer();
  const plain = new LiveSocket(url, '{}', () => {}, () => {}, { deflate: false });
  const usual = new LiveSocket(url, '{}', () => {}, () => {});
  try {
    plain.start();
    await until(() => upgrades.length === 1);
    usual.start();
    await until(() => upgrades.length === 2);
    assert.equal(upgrades[0]!.headers['sec-websocket-extensions'], undefined, 'no permessage-deflate offered');
    assert.match(String(upgrades[1]!.headers['sec-websocket-extensions']), /permessage-deflate/);
  } finally {
    plain.stop();
    usual.stop();
    wss.close();
  }
});

test('a close is logged: its code, its reason, how long the socket was up', async () => {
  const { wss, url } = await wsServer();
  wss.on('connection', (c) => {
    c.send('{"type":"connected"}');
    setTimeout(() => c.close(4001, 'bye'), 50);
  });
  const lines: string[] = [];
  const s = new LiveSocket(url, '{}', () => {}, () => {}, { name: 'lighter#1', log: (l) => lines.push(l) });
  try {
    s.start();
    await until(() => lines.length > 0);
    assert.match(lines[0]!, /^stream lighter#1: closed 4001 "bye" after \d+ s up; again in \d+ s$/);
  } finally {
    s.stop();
    wss.close();
  }
});

test('a stall of this thread is not silence: what waits to be read keeps the socket; a socket really silent is still replaced', async () => {
  const { wss, url } = await wsServer();
  let opened = 0;
  let talking = true;
  wss.on('connection', (c) => {
    opened++;
    c.send('{"type":"connected"}');
    const t = setInterval(() => { if (talking && c.readyState === c.OPEN) c.send('{"type":"tick"}'); }, 20);
    c.on('close', () => clearInterval(t));
  });
  const lines: string[] = [];
  const s = new LiveSocket(url, '{}', () => {}, () => {}, { name: 'hl', staleMs: 300, tickMs: 50, log: (l) => lines.push(l) });
  try {
    s.start();
    await until(() => s.upSince !== null);
    // The thread does nothing else for twice the stale limit. The frames sent meanwhile wait unread.
    for (let n = 0; n < 2; n++) {
      const end = Date.now() + 600;
      while (Date.now() < end) { /* a stalled thread */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(opened, 1, 'never replaced');
    assert.deepEqual(lines, [], 'never closed');
    assert.notEqual(s.upSince, null);

    talking = false;
    await until(() => lines.length > 0);
    assert.match(lines[0]!, /^stream hl: closed 1006 after \d+ s up \(nothing came for \d+ s\); again in \d+ s$/);
  } finally {
    s.stop();
    wss.close();
  }
});

test('a socket that answers pings but sends no data any more is replaced, and the data keeps a live one up', async () => {
  const { wss, url } = await wsServer();
  let opened = 0;
  let sending = true;
  wss.on('connection', (c) => {
    opened++;
    // Answers everything it is sent (the pings), whatever happens to the feed: what SoDEX does.
    c.on('message', () => c.send('{"op":"pong"}'));
    const t = setInterval(() => { if (sending) c.send('{"channel":"trade","data":[{}]}'); }, 20);
    c.on('close', () => clearInterval(t));
  });
  const lines: string[] = [];
  const isData = (m: unknown) => (m as { channel?: string }).channel === 'trade';
  const s = new LiveSocket(url, '{}', () => {}, () => {}, { name: 'sodex-perps', pingMs: 30, tickMs: 20, dataSilentMs: 200, isData, log: (l) => lines.push(l) });
  try {
    s.start();
    await until(() => s.upSince !== null);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(opened, 1, 'data flowing: never replaced');
    assert.deepEqual(lines, []);

    sending = false;
    await until(() => lines.length > 0);
    assert.match(lines[0]!, /^stream sodex-perps: closed 1006 after \d+ s up \(no data for \d+ s, though it still answers\); again in \d+ s$/);
    await until(() => opened === 2);
  } finally {
    s.stop();
    for (const c of wss.clients) c.terminate();
    wss.close();
  }
});

test('a stall of this thread is not counted as the feed going silent', async () => {
  const { wss, url } = await wsServer();
  let opened = 0;
  wss.on('connection', (c) => {
    opened++;
    c.on('message', () => c.send('{"op":"pong"}'));
    const t = setInterval(() => c.send('{"channel":"trade","data":[{}]}'), 20);
    c.on('close', () => clearInterval(t));
  });
  const isData = (m: unknown) => (m as { channel?: string }).channel === 'trade';
  const s = new LiveSocket(url, '{}', () => {}, () => {}, { name: 'sodex-perps', tickMs: 50, dataSilentMs: 300, isData });
  try {
    s.start();
    await until(() => s.upSince !== null);
    for (let n = 0; n < 2; n++) {
      const end = Date.now() + 600;
      while (Date.now() < end) { /* a stalled thread */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(opened, 1, 'never replaced');
  } finally {
    s.stop();
    for (const c of wss.clients) c.terminate();
    wss.close();
  }
});

test('a venue that sends its close frame and never ends the connection is cut within about a second', async () => {
  const { wss, url } = await wsServer();
  wss.on('connection', (c) => {
    c.send('{"type":"connected"}');
    const raw = (c as unknown as { _socket: import('node:net').Socket })._socket;
    setTimeout(() => {
      raw.pause(); // it reads nothing more, so it never finishes the close
      raw.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])); // a close frame, code 1000
    }, 30);
  });
  const lines: string[] = [];
  const s = new LiveSocket(url, '{}', () => {}, () => {}, { name: 'sodex-perps', log: (l) => lines.push(l) });
  try {
    const t0 = Date.now();
    s.start();
    await until(() => lines.length > 0, 4000);
    assert.ok(Date.now() - t0 < 3000, `cut after ${Date.now() - t0} ms, not left for the 5 s tick`);
  } finally {
    s.stop();
    for (const c of wss.clients) c.terminate();
    wss.close();
  }
});

test('an HTTP 429 on connect: logged, and the next try waits out the cooldown (60 s)', async () => {
  const http = createServer((_req, res) => res.end());
  http.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n'));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const lines: string[] = [];
  const s = new LiveSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`, '{}', () => {}, () => {}, { name: 'lighter#2', log: (l) => lines.push(l) });
  try {
    s.start();
    await until(() => lines.length > 0);
    assert.match(lines[0]!, /closed 1006 before data came \(Unexpected server response: 429\); again in 60 s/);
  } finally {
    s.stop();
    http.close();
  }
});

test('Lighter: what it says besides prints is logged (three of a kind, then every 100th); a whole socket says how long it took', () => {
  const lines: string[] = [];
  const st = new LighterStream(() => {}, async () => new Map([[0, 'ETH']]), 'ws://127.0.0.1:9', (l) => lines.push(l));
  const raw = st as unknown as { groups: number[][]; confirmed: Array<Set<number>>; readyAt: Array<number | null>; openAt: number[] };
  raw.groups = [[0]];
  raw.confirmed = [new Set()];
  raw.readyAt = [null];
  raw.openAt = [Date.now() - 3000];
  for (let n = 0; n < 5; n++) st.handle(0, { type: 'error', error: { code: 30003, message: 'Too Many Websocket Messages' } });
  st.handle(0, { type: 'connected', session_id: 'x' });
  st.handle(0, { type: 'pong' });
  st.handle(0, { type: 'subscribed/trade', channel: 'trade:0', trades: [] });
  assert.equal(lines.filter((l) => /Lighter said \(error #\d\)/.test(l)).length, 3, 'three of a kind');
  assert.match(lines[0]!, /^stream lighter#1: Lighter said \(error #1\) \{"type":"error","error":\{"code":30003,"message":"Too Many Websocket Messages"\}\}$/);
  assert.ok(!lines.some((l) => /connected|pong/.test(l)), 'its chatter is quiet');
  assert.match(lines.at(-1)!, /^stream lighter#1: all 1 markets confirmed in 3 s$/);
  assert.equal(LighterStream.PER_SOCKET, 56);
  assert.ok(60_000 / LighterStream.SEND_GAP_MS + 4 * (60_000 / LighterStream.PING_MS) <= 200, 'within Lighter\'s 200 messages a minute');
});

test('lighter pacing: a late timer catches up (at most BURST), the sockets take turns, and a minute stays within 200', () => {
  const st = new LighterStream(() => {}, async () => new Map(), 'ws://127.0.0.1:9', () => {});
  const sent: Array<[number, number]> = [];
  const raw = st as unknown as { groups: number[][]; confirmed: Array<Set<number>>; sentAt: Array<Map<number, number>>; sendFns: Array<((m: unknown) => void) | null>; lastSend: number; pump(): void };
  raw.groups = [0, 1, 2, 3].map((s) => Array.from({ length: 56 }, (_, k) => s * 56 + k));
  raw.confirmed = raw.groups.map(() => new Set());
  raw.sentAt = raw.groups.map(() => new Map());
  raw.sendFns = raw.groups.map((_, i) => (m: unknown) => sent.push([i, Number(String((m as { channel: string }).channel).slice(6))]));
  const real = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    raw.lastSend = t - 10 * LighterStream.SEND_GAP_MS; // the thread was busy: ten gaps owed
    raw.pump();
    assert.equal(sent.length, LighterStream.BURST, 'a burst, capped');
    assert.deepEqual(new Set(sent.map(([i]) => i)), new Set([0, 1, 2, 3]), 'every socket gets its turn');
    t += 100;
    raw.pump();
    assert.equal(sent.length, LighterStream.BURST, 'then the regular pace again');
    // One minute of ticks every 100 ms, nothing confirmed back: never more than the budget.
    sent.length = 0;
    for (let k = 0; k < 600; k++) {
      t += 100;
      raw.pump();
    }
    assert.ok(sent.length + 4 * (60_000 / LighterStream.PING_MS) <= 200, `${sent.length} subscribes in a minute`);
  } finally {
    Date.now = real;
  }
});
