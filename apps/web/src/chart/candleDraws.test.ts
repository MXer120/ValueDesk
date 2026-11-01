/**
 * The chart's HTML layers read where things sit after each candle-pane draw, not every frame.
 *   npx tsx --test src/chart/candleDraws.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chart as KChart } from 'klinecharts';
import { followChart } from './candleDraws';

function fakeChart() {
  const cleared: string[] = [];
  const ctxOf = (name: string) => ({ clearRect(..._a: number[]) { cleared.push(name); } });
  const canvases = [ctxOf('main'), ctxOf('overlay')].map((ctx) => ({ getContext: () => ctx, ctx }));
  const dom = { querySelectorAll: () => canvases };
  const chart = { getDom: (pane: string, pos: string) => (pane === 'candle_pane' && pos === 'main' ? dom : null) } as unknown as KChart;
  return { chart, canvases, cleared };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test('reads at once, then once after each frame the pane is drawn in, and not otherwise', async () => {
  const { chart, canvases, cleared } = fakeChart();
  let reads = 0;
  const off = followChart(chart, 'candle_pane', () => { reads++; }, 60_000);
  assert.equal(reads, 1, 'read when added');
  await tick();
  assert.equal(reads, 1, 'nothing drawn: nothing read');
  // klinecharts draws both canvases of a pane in one frame: one read after them.
  canvases[0]!.ctx.clearRect(0, 0, 10, 10);
  canvases[1]!.ctx.clearRect(0, 0, 10, 10);
  assert.equal(reads, 1, 'read after the draw, not inside it');
  await tick();
  assert.equal(reads, 2);
  assert.deepEqual(cleared, ['main', 'overlay'], 'the canvas is still cleared');
  off();
  canvases[0]!.ctx.clearRect(0, 0, 10, 10);
  await tick();
  assert.equal(reads, 2, 'off: no more reads');
});

test('two layers on one chart share a canvas; one leaving keeps the other', async () => {
  const { chart, canvases } = fakeChart();
  const own = canvases[0]!.ctx.clearRect;
  let a = 0;
  let b = 0;
  const offA = followChart(chart, 'candle_pane', () => { a++; }, 60_000);
  const offB = followChart(chart, 'candle_pane', () => { b++; }, 60_000);
  canvases[0]!.ctx.clearRect(0, 0, 1, 1);
  await tick();
  assert.deepEqual([a, b], [2, 2]);
  offA();
  canvases[0]!.ctx.clearRect(0, 0, 1, 1);
  await tick();
  assert.deepEqual([a, b], [2, 3]);
  offB();
  assert.equal(canvases[0]!.ctx.clearRect, own, 'the last one gone: the canvas as it was');
});

test('reads again on the recheck clock, whatever was drawn', async () => {
  const { chart } = fakeChart();
  let reads = 0;
  const off = followChart(chart, 'candle_pane', () => { reads++; }, 5);
  // Waits for the reads, not a time: a loaded build machine runs timers late.
  const until = Date.now() + 10_000;
  while (reads < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  off();
  assert.ok(reads >= 3, `rechecked (${reads} reads)`);
});
