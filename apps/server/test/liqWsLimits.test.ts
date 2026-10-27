/**
 * /ws/liq's per-address cap counts an IPv6 client by its /64 (hosted.ts clientKey),
 * like every other limit: one subscriber holds a whole /64 and could otherwise open
 * a dozen sockets from each of its addresses.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';

process.env.VALUESCAN_LIQ_FEED = '0';
const { liqWsRoute } = await import('../src/routes/liqWs.js');

/** Open a socket as `ip` (the app trusts X-Forwarded-For); resolves with the close code, or 0 while it stays open. */
function open(port: number, ip: string): Promise<{ code: number; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/liq`, { headers: { 'x-forwarded-for': ip } });
    const t = setTimeout(() => resolve({ code: 0, ws }), 300);
    ws.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, ws });
    });
    ws.on('error', () => undefined);
  });
}

test('/ws/liq: at most a dozen sockets per IPv6 /64, whichever addresses of it they come from', async () => {
  const app = Fastify({ trustProxy: true });
  await app.register(websocket);
  liqWsRoute(app, () => true);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const held: WebSocket[] = [];
  try {
    for (let i = 1; i <= 12; i++) {
      const r = await open(port, `2001:db8:1:2::${i.toString(16)}`);
      assert.equal(r.code, 0, `socket ${i} of the /64 stays open`);
      held.push(r.ws);
    }
    const thirteenth = await open(port, '2001:db8:1:2:ffff::1');
    held.push(thirteenth.ws);
    assert.equal(thirteenth.code, 1008, 'the 13th from the same /64 is refused');
    const other = await open(port, '2001:db8:1:3::1');
    held.push(other.ws);
    assert.equal(other.code, 0, 'another /64 is another client');
  } finally {
    for (const ws of held) ws.terminate();
    await app.close();
  }
});
