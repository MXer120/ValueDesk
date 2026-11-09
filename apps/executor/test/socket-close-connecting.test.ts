/**
 * The executor stopped on "uncaught exception: WebSocket was closed before the connection was established" (owner
 * 2026-11-09): the `ws` package emits 'error' when a socket still connecting is closed, and LiveSocket.drop removed
 * every handler first. A socket dropped while connecting must never throw.
 * Run (from apps/executor): npx tsx --test test/socket-close-connecting.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { LiveSocket } from '../../../packages/copy-engine/src/socket.ts';
import { plainSockets } from '../src/feed/binance.ts';

test('a socket dropped while it is still connecting raises nothing (real ws, a server that never answers)', async () => {
  const held: Socket[] = [];
  const server = createServer((s) => { held.push(s); }); // accepts TCP, never answers the upgrade
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const uncaught: unknown[] = [];
  const onErr = (e: unknown) => uncaught.push(e);
  process.on('uncaughtException', onErr);
  try {
    for (let i = 0; i < 5; i++) {
      const s = new LiveSocket({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/x`, factory: plainSockets, ping: '{}', pingMs: 60_000, staleMs: 15_000, subscribe: () => {}, onMessage: () => {}, name: `t${i}` } as never);
      s.start();
      await new Promise((r) => setTimeout(r, 20));
      s.stop(); // still CONNECTING: close() on it
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(uncaught.map(String), [], 'no uncaught exception');
  } finally {
    process.off('uncaughtException', onErr);
    for (const s of held) s.destroy();
    await new Promise((r) => server.close(r));
  }
});
