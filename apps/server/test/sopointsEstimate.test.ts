/**
 * The SoPoints estimate (routes/sopointsEstimate.ts, valuedesk/sodex/sopointsModel.ts): plans priced in a typical, a
 * busy and a quiet week; a wallet's own weeks carry its quiet-week points and its distance from the model; no model
 * file is a 503; bad bodies are refused; a rate limit. The numbers here are made up: the fitted ones stay private.
 *   npx tsx --test test/sopointsEstimate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { SOPOINTS_ESTIMATE_LIMIT, sopointsEstimateRoutes } from '../src/routes/sopointsEstimate.js';
import { calibrate, estimatePlan, loadParams, parseParams, type ModelParams } from '../src/valuedesk/sodex/sopointsModel.js';

// Made-up: half-power, 10 points per 10,000 in a typical week.
const M: ModelParams = {
  exponent: 0.5,
  weights: { futures: 1, spot: 2, oi: 5, wealth: 4, vault: 1 },
  rate: { mid: 10, busy: 8, quiet: 15 },
  weekRates: { '1': 12 },
  fittedOn: 'test rows',
  fittedAt: '2026-01-01',
};

const app = (params: () => ModelParams | null = () => M) => {
  const a = Fastify();
  void a.register(sopointsEstimateRoutes({ params }));
  return a;
};

test('a plan is priced in a typical, a busy and a quiet week, and split by where it comes from', () => {
  const e = estimatePlan(M, { futures: 40_000 }, null);
  assert.equal(e.mid, 20); // 10 x (40,000 / 10,000)^0.5
  assert.equal(e.busy, 16);
  assert.equal(e.quiet, 30);
  const s = estimatePlan(M, { futures: 10_000, spot: 5_000, coef: 1.2, boostedShare: 0.5 }, null);
  // futures counted 1.1x on the boosted half: 11,000 + 2 x 5,000 = 21,000
  assert.equal(s.mid, Math.round(10 * Math.sqrt(2.1) * 10) / 10);
  assert.ok(Math.abs(s.parts.futures + s.parts.spot - s.mid) <= 0.2);
  assert.equal(estimatePlan(M, {}, null).mid, 0);
});

test('the wallet’s own weeks:quiet weeks give its extra, busy ones its ratio (shrunk toward 1)', () => {
  // Weeks 2-3 idle with 5 own points each; weeks 4-7 traded $40K (model 20) and earned 5 + 30 own (ratio 1.5).
  const weeks = [
    { weekNo: 2, points: 5 },
    { weekNo: 3, points: 6, referral: 1 },
    ...[4, 5, 6, 7].map((n) => ({ weekNo: n, futures: 40_000, points: Math.round((35 + 4) * 1.25), referral: 4, bonusPct: 25 })),
  ];
  const c = calibrate(M, weeks);
  assert.equal(c.extra, 5);
  assert.equal(c.weeks, 6);
  // raw ratio 1.5 shrunk by 4 / (4 + 2): 1 + 0.5 x 2/3
  assert.ok(Math.abs(c.ratio - 1.333) < 0.01, String(c.ratio));
  assert.equal(c.referral, 4);
  const r4 = c.rows.find((r) => r.weekNo === 4)!;
  assert.equal(r4.explained, 20);
  assert.ok(Math.abs(r4.other - 15.2) < 0.2, String(r4.other)); // 39 x 1.25 = 48.75 → 49 points, / 1.25 − 4 = 35.2 own
  // The plan carries both: ratio x model + extra.
  const e = estimatePlan(M, { futures: 40_000 }, c);
  assert.ok(Math.abs(e.mid - (c.ratio * 20 + 5)) < 0.1);
  assert.equal(e.parts.extra, 5);
  // A week with its own measured rate is explained at that rate.
  assert.equal(calibrate(M, [{ weekNo: 1, futures: 10_000, points: 12 }]).rows[0]!.explained, 12);
});

test('no weeks: no calibration; nothing but idle weeks: ratio 1', () => {
  const c = calibrate(M, [{ weekNo: 1, points: 3 }, { weekNo: 2, points: 3 }]);
  assert.equal(c.ratio, 1);
  assert.equal(c.extra, 3);
});

test('the route answers plans and the calibration; refuses bad bodies; 503 without a model', async () => {
  const a = app();
  const r = await a.inject({ method: 'POST', url: '/api/vs/sopoints/estimate', payload: { plans: [{ futures: 40_000 }], weeks: [{ weekNo: 2, points: 5 }] } });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.ok, true);
  assert.equal(j.plans.length, 1);
  assert.equal(j.calib.extra, 5);
  assert.deepEqual(j.model, { fittedOn: 'test rows', fittedAt: '2026-01-01' });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await a.inject({ method: 'POST', url: '/api/vs/sopoints/estimate', payload: { plans: 'x' } })).statusCode, 400);
  assert.equal((await a.inject({ method: 'POST', url: '/api/vs/sopoints/estimate', payload: { plans: Array.from({ length: 17 }, () => ({})) } })).statusCode, 400);
  assert.equal((await app(() => null).inject({ method: 'POST', url: '/api/vs/sopoints/estimate', payload: { plans: [] } })).statusCode, 503);
});

test('rate limit per client', async () => {
  const a = app();
  let last = 0;
  for (let i = 0; i <= SOPOINTS_ESTIMATE_LIMIT.max; i++) last = (await a.inject({ method: 'POST', url: '/api/vs/sopoints/estimate', payload: { plans: [] } })).statusCode;
  assert.equal(last, 429);
});

test('the private file: read, checked, missing or broken means no model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-'));
  try {
    const f = join(dir, 'm.json');
    assert.equal(loadParams(f, 1), null);
    writeFileSync(f, JSON.stringify(M));
    assert.equal(loadParams(f, 100_000)?.rate.mid, 10);
    assert.equal(parseParams({ ...M, rate: { mid: 10, busy: 20, quiet: 15 } }), null);
    assert.equal(parseParams({ ...M, exponent: 3 }), null);
    assert.equal(parseParams(null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
