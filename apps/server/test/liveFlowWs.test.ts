/**
 * Run: node --import tsx --test apps/server/test/liveFlowWs.test.ts
 *
 * End to end on a real socket: the flow recorder writes a print, the API's live channel (routes/liveHub.ts on /ws/liq, with
 * the real flow reader and routes/valuedesk.ts liveAskOf) sees its slot's count move and pushes the patch; the browser side
 * applies it and holds exactly what GET /api/vs/flow answers. Measures print-written -> patch-received and logs it
 * (2026-11-09, this laptop: see the commit message); asserts every print arrives within 2 s.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'vs-live-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
process.env.VALUESCAN_FLOW_DB = join(dir, 'flow.db');
process.env.VALUESCAN_LIQ_FEED = '0';
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const { setCandleRead } = await import('../src/flow/venueCheck.js');
const { FlowStore, closeFlowReader } = await import('../src/flow/store.js');
const { FlowRecorder } = await import('../src/flow/recorder.js');
const { flowWindow } = await import('../src/flow/read.js');
const { liqWsRoute } = await import('../src/routes/liqWs.js');
const { defaultLiveHub } = await import('../src/routes/liveHub.js');
const { liveAskOf } = await import('../src/routes/valuedesk.js');
const { apply } = await import('../src/live/jsonPatch.js');

setCandleRead(async () => null);
const A = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a print written reaches the subscribed browser as a patch, and the held answer equals the HTTP one', async () => {
  const store = new FlowStore(process.env.VALUESCAN_FLOW_DB!);
  const rec = new FlowRecorder(store, () => null);
  const app = Fastify();
  await app.register(websocket);
  liqWsRoute(app, () => true, await defaultLiveHub(liveAskOf));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  // The forming hour.
  const from = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const to = from + 3_600_000;
  const path = `/api/vs/flow?coin=BTC&venues=hyperliquid&kind=perp&from=${from}&to=${to}&role=all&side=all&sort=volume&limit=100`;
  // A first print so the market exists.
  rec.add({ venue: 'hyperliquid', id: '0', t: Date.now(), symbol: 'BTC', px: 60_000, sz: 1, buyer: A(1), seller: A(2), taker: 'buyer' });
  // A table as a busy candle has it: 150 wallets, 100 shown.
  for (let i = 0; i < 150; i++) rec.add({ venue: 'hyperliquid', id: `w${i}`, t: Date.now(), symbol: 'BTC', px: 60_000, sz: 0.01 + i / 1000, buyer: A(10 + i), seller: A(2), taker: 'seller' });
  rec.flush();
  const texts: { ls: string[]; lp: string[] } = { ls: [], lp: [] };

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/liq`);
  let held: Record<string, unknown> | null = null;
  let seq = 0;
  const arrived = new Map<string, number>();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as { t: string; id: string; seq: number; body?: Record<string, unknown>; p?: unknown };
    if (m.id !== 'f') return;
    if (m.t === 'ls' || m.t === 'lp') texts[m.t].push(String(raw));
    if (m.t === 'ls') held = m.body!;
    else if (m.t === 'lp') { assert.equal(m.seq, seq + 1, 'patches in order'); held = apply(held, m.p as never) as Record<string, unknown>; }
    seq = m.seq;
    for (const r of (held?.rows as Array<{ address: string }> | undefined) ?? []) if (!arrived.has(r.address)) arrived.set(r.address, performance.now());
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ op: 'live', id: 'f', path }));
  for (let i = 0; i < 40 && !held; i++) await sleep(50);
  assert.ok(held, 'the whole answer on subscribing');
  assert.equal((held as { ok: boolean }).ok, true);

  const lat: number[] = [];
  try {
    for (let i = 0; i < 12; i++) {
      await sleep(300 + Math.floor(Math.random() * 500));
      const who = A(1000 + i);
      rec.add({ venue: 'hyperliquid', id: String(i + 1), t: Date.now(), symbol: 'BTC', px: 60_000 + i, sz: 0.5, buyer: who, seller: A(2), taker: 'buyer' });
      // What flow/thread.ts (rt/flow) does within ~0.5 s of a print: the slot readable. Timed from here.
      rec.flush();
      const t0 = performance.now();
      for (let k = 0; k < 200 && !arrived.has(who); k++) await sleep(5);
      assert.ok(arrived.has(who), `print ${i} pushed`);
      lat.push(arrived.get(who)! - t0);
    }
    lat.sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length / 2)]!;
    console.log(`print written -> patch applied: p50 ${p50.toFixed(0)} ms, max ${lat.at(-1)!.toFixed(0)} ms, min ${lat[0]!.toFixed(0)} ms (n=${lat.length})`);
    assert.ok(lat.at(-1)! < 2_000);
    // Bytes: the whole answer against a patch, raw and deflated (permessage-deflate's own algorithm, per message).
    const { deflateRawSync } = await import('node:zlib');
    const avg = (xs: string[], f: (s: string) => number) => Math.round(xs.reduce((s, x) => s + f(x), 0) / Math.max(1, xs.length));
    const z = (s: string) => deflateRawSync(s).length;
    console.log(`whole answer ${avg(texts.ls, (s) => s.length)} B (deflated ${avg(texts.ls, z)} B); patch avg ${avg(texts.lp, (s) => s.length)} B (deflated ${avg(texts.lp, z)} B), n=${texts.lp.length}`);
    // What the browser holds is what the route answers.
    const http = await flowWindow({ coin: 'BTC', venues: ['hyperliquid'], kind: 'perp', from, to, role: 'all', side: 'all', sort: 'volume', limit: 100 }, Date.now(), 0);
    assert.deepEqual((held as unknown as { rows: unknown }).rows, http!.rows);
    assert.deepEqual((held as unknown as { summary: unknown }).summary, http!.summary);
  } finally {
    ws.terminate();
    await app.close();
    rec.stop();
    closeFlowReader();
  }
});
