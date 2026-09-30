/**
 * Worker-backed simulator: routing, identity-preserving transport, fallbacks.
 * Run (from apps/web): npx tsx --test src/components/copy/sim/client.test.ts
 *
 * A fake worker runs the real engine + protocol through structuredClone, which
 * is what a browser Worker does to the messages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CopyConfig, SimFill as Fill } from './types';
import { createWorkerSimulator, type WorkerLike } from './client';
import { runCopySimulation, type SimOptions, type SimResult } from './engine';
import { packResult, type SimRequest, type SimResponse } from './protocol';

const CONFIG: CopyConfig = {
  sizingMode: 'fixedRatio',
  allocationUsd: 10_000,
  ratio: 0.1,
  maxLeverage: 10,
  maxPositionUsd: 1e9,
  stopLossPct: null,
  drawdownStopPct: null,
  takeProfitPct: null,
  assetAllow: [],
  assetDeny: [],
  copyExisting: false,
  slippageBps: 0,
};

function fills(n: number): Fill[] {
  const out: Fill[] = [];
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? 'buy' : 'sell';
    out.push({
      id: String(i),
      venue: 'hyperliquid',
      symbol: 'TST',
      coin: 'TST',
      side,
      price: 100 + (i % 7),
      size: 10,
      notionalUsd: 1_000,
      fee: 0,
      feeAsset: 'USDC',
      realizedPnl: null,
      dir: null,
      startPosition: side === 'buy' ? 0 : 10,
      orderId: null,
      time: 1_000 + i,
    });
  }
  return out;
}

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: SimResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  received = 0;
  constructor(private readonly mode: 'ok' | 'crash' | 'throw-engine' = 'ok') {}
  postMessage(msg: SimRequest): void {
    this.received++;
    const req = structuredClone(msg);
    queueMicrotask(() => {
      if (this.mode === 'crash') {
        this.onerror?.(new Error('worker script failed to load'));
        return;
      }
      let res: SimResponse;
      try {
        if (this.mode === 'throw-engine') throw new Error('boom');
        res = { id: req.id, ok: true, result: packResult(runCopySimulation(req.fills, req.config, req.opts), req.fills) };
      } catch (e) {
        res = { id: req.id, ok: false, error: (e as Error).message };
      }
      this.onmessage?.({ data: structuredClone(res) });
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

test('small replays run synchronously without creating a worker', () => {
  let created = 0;
  const sim = createWorkerSimulator({ threshold: 100, createWorker: () => (created++, new FakeWorker()) });
  const r = sim(fills(10), CONFIG);
  assert.ok(!(r instanceof Promise));
  assert.equal(created, 0);
  sim.dispose();
});

test('large replays go through the worker; result equals the sync engine and keeps fill identity', async () => {
  const w = new FakeWorker();
  const sim = createWorkerSimulator({ threshold: 100, createWorker: () => w, idleMs: 0 });
  const input = fills(500);
  const opts: SimOptions = { lotSize: { TST: 0.001 } };
  const viaWorker = (await sim(input, CONFIG, opts)) as SimResult;
  const direct = runCopySimulation(input, CONFIG, opts);
  assert.equal(w.received, 1);
  assert.deepEqual(viaWorker, direct);
  for (const t of viaWorker.fills) assert.equal(t.leaderFill, input[t.leaderIndex], 'caller fill objects are re-attached');
  assert.equal(w.terminated, true, 'idle worker is terminated');
});

test('concurrent jobs resolve to their own results', async () => {
  const sim = createWorkerSimulator({ threshold: 100, createWorker: () => new FakeWorker(), idleMs: 0 });
  const a = fills(200);
  const b = fills(300);
  const [ra, rb] = (await Promise.all([sim(a, CONFIG), sim(b, { ...CONFIG, ratio: 0.2 })])) as SimResult[];
  assert.equal(ra!.copiedFills + ra!.skippedFills, 200);
  assert.equal(rb!.copiedFills + rb!.skippedFills, 300);
  assert.equal(rb!.config.ratio, 0.2);
});

test('a worker that fails to construct falls back to synchronous runs', () => {
  const sim = createWorkerSimulator({
    threshold: 1,
    createWorker: () => {
      throw new Error('CSP refused');
    },
  });
  const r = sim(fills(10), CONFIG);
  assert.ok(!(r instanceof Promise));
  assert.equal(sim.usesWorker, false);
});

test('a worker that errors hands its pending jobs to the sync engine and is not reused', async () => {
  let created = 0;
  const sim = createWorkerSimulator({ threshold: 1, createWorker: () => (created++, new FakeWorker('crash')) });
  const input = fills(50);
  const r = (await sim(input, CONFIG)) as SimResult;
  assert.deepEqual(r, runCopySimulation(input, CONFIG));
  assert.equal(sim.usesWorker, false);
  const again = sim(input, CONFIG);
  assert.ok(!(again instanceof Promise));
  assert.equal(created, 1);
});

test('an engine error inside the worker rejects that job', async () => {
  const sim = createWorkerSimulator({ threshold: 1, createWorker: () => new FakeWorker('throw-engine'), idleMs: 0 });
  await assert.rejects(Promise.resolve(sim(fills(5), CONFIG)), /boom/);
});

test('no worker factory = always synchronous', () => {
  const sim = createWorkerSimulator({ threshold: 1 });
  assert.equal(sim.usesWorker, false);
  assert.ok(!(sim(fills(5), CONFIG) instanceof Promise));
});
