import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveSocket } from '../src/socket.js';

class FakeWs {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  send() {}
  close() { this.closed = true; }
}

const socket = (dataStaleMs: number | undefined) => {
  const made: FakeWs[] = [];
  const s = new LiveSocket({
    url: 'wss://x', ping: 'ping', name: 't', staleMs: 90_000, ...(dataStaleMs !== undefined ? { dataStaleMs } : {}),
    factory: () => { const w = new FakeWs(); made.push(w); return w as never; },
    subscribe: () => {},
    onMessage: () => {},
  } as never);
  return { s, made };
};
type Priv = { check(): void; connect(): void; running: boolean; lastDataAt: number; lastMessageAt: number; retry: unknown };

test('a stream that only answers pings is replaced when it should always have data; a quiet one is left', () => {
  const mute = socket(90_000);
  const quiet = socket(undefined);
  for (const { s, made } of [mute, quiet]) {
    const p = s as unknown as Priv;
    p.running = true;
    p.connect();
    made[0]!.onopen?.();
    // Pongs keep coming; nothing else for two minutes.
    p.lastDataAt = Date.now() - 120_000;
    made[0]!.onmessage?.({ data: 'pong' });
    assert.ok(Date.now() - p.lastMessageAt < 1_000);
    assert.ok(Date.now() - p.lastDataAt >= 120_000, 'a pong is not data');
    p.check();
  }
  assert.equal(mute.made[0]!.closed, true, 'deaf: replaced');
  assert.equal(quiet.made[0]!.closed, false, 'may rightly be quiet: kept');
  (mute.s as unknown as { stop(): void }).stop();
  (quiet.s as unknown as { stop(): void }).stop();
});

test('real data keeps a stream with a data limit', () => {
  const { s, made } = socket(90_000);
  const p = s as unknown as Priv;
  p.running = true;
  p.connect();
  made[0]!.onopen?.();
  p.lastDataAt = Date.now() - 120_000;
  made[0]!.onmessage?.({ data: '{"channel":"allMarkPrice"}' });
  p.check();
  assert.equal(made[0]!.closed, false);
  (s as unknown as { stop(): void }).stop();
});
