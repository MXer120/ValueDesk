/**
 * GET /algos/stream (owner 2026-11-09: push, not poll): the wallet's bots at once, then each again as soon as anything
 * shown of it changes, over a real HTTP server.
 * Run (from apps/executor): npx tsx --test test/algos-stream.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createExecutorServer, STREAM_EVERY_MS } from '../src/server.ts';
import type { ExecutorConfig } from '../src/config.ts';
import type { ExecutorService } from '../src/service.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const view = (id: string, price: number) => ({ algo: { id, status: 'running', statusReason: null, filled: 0, book: { series: [[1, 2, 3, 4]] } }, working: null, bot: { volume: 1, netPnl: 0, inventory: 0, fills: 0, closing: false, mark: 100, matchedAt: null, orders: [{ side: 'buy', price }], health: { checks: [] } } });

test('the stream sends every bot, then only the one that changed, without its series', async () => {
  const views = [view('a', 99), view('b', 98)];
  const svc = { authenticate: (t: string) => { if (t !== 'tok') throw new Error('no'); return '0xowner'; }, algoList: () => views, audit() {} } as unknown as ExecutorService;
  const cfg = { trustEdge: true, allowedOrigins: [], originSecrets: [], builderToken: null } as unknown as ExecutorConfig;
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const ctl = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1/algos/stream`, { headers: { Authorization: 'Bearer tok' }, signal: ctl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    const frame = async (): Promise<{ algos: Array<{ algo: { id: string; book?: { series: unknown[] } } }>; gone: string[] }> => {
      for (;;) {
        const i = buf.indexOf('\n\n');
        if (i >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('the stream ended');
        buf += value;
      }
    };
    const first = await frame();
    assert.deepEqual(first.algos.map((v) => v.algo.id).sort(), ['a', 'b']);
    assert.deepEqual(first.algos[0]!.algo.book!.series, [], 'no series on the stream');
    views[1] = view('b', 97); // b's order moved
    const t0 = Date.now();
    const next = await frame();
    assert.deepEqual(next.algos.map((v) => v.algo.id), ['b'], 'only the bot that changed');
    assert.ok(Date.now() - t0 <= STREAM_EVERY_MS * 3, 'within a few hundred ms');
    views.splice(0, 1); // a was removed from the list
    const gone = await frame();
    assert.deepEqual(gone.gone, ['a']);
  } finally {
    ctl.abort();
    await new Promise((r) => server.close(r));
  }
});

test('the stream needs the session', async () => {
  const svc = { authenticate: () => { const e = new Error('Sign in again') as Error & { status: number; code: string }; throw Object.assign(e, { status: 401, code: 'session' }); }, algoList: () => [], audit() {} } as unknown as ExecutorService;
  const cfg = { trustEdge: true, allowedOrigins: [], originSecrets: [], builderToken: null } as unknown as ExecutorConfig;
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1/algos/stream`);
    assert.notEqual(res.status, 200);
    await res.text();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
