/**
 * Hyperliquid PnL on its leaderboard's terms (valuedesk/hyperliquid/scope.ts): perp only, a master's sub-accounts added
 * when the file's figure has them. Figures from the live check of 2026-11-26 (top and worst 50 of the 30d board: 80 matched
 * by the address's own perp PnL, the other 20 by master + sub-accounts, none left over; 33 did not match the
 * spot-inclusive month curve the podium drew).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explains, PERP_WINDOW, rowSeries, sumSeries, type InfoPost } from '../src/valuedesk/hyperliquid/scope.js';

const D = 86_400_000;
const T0 = Date.UTC(2026, 9, 27);

/** A portfolio answer: `month` (spot included) and `perpMonth`, cumulative PnL at day 0, 10, 20, 30. */
const portfolio = (month: number[], perpMonth: number[]) => {
  const w = (pnl: number[]) => ({
    accountValueHistory: pnl.map((_, k) => [T0 + k * 10 * D, '1000']),
    pnlHistory: pnl.map((v, k) => [T0 + k * 10 * D, String(v)]),
    vlm: '0',
  });
  return [['month', w(month)], ['perpMonth', w(perpMonth)]];
};

function fakeInfo(answers: Record<string, unknown>, subs: Record<string, string[]> = {}) {
  const asked: string[] = [];
  const post: InfoPost = async <T>(body: { type: string; user?: unknown }) => {
    asked.push(`${body.type}:${String(body.user)}`);
    if (body.type === 'subAccounts') return (subs[String(body.user)] ?? []).map((s) => ({ subAccountUser: s })) as T;
    const a = answers[String(body.user)];
    if (a === undefined) throw new Error(`no answer for ${String(body.user)}`);
    return a as T;
  };
  return { post, asked };
}

test('the board ranks perp PnL: a spot loss is not in its figure, so the curve leaves it out too (0x5b5d…c060)', async () => {
  // File 30d 114,041,785.91 = perpMonth; month with spot 103,728,711.
  const { post, asked } = fakeInfo({ m: portfolio([0, 40e6, 80e6, 103_728_711], [0, 45e6, 90e6, 114_041_786]) });
  const r = await rowSeries('m', PERP_WINDOW['30d'], 114_041_785.906637, post);
  assert.equal(r.explained, true);
  assert.equal(r.subs, 0);
  assert.equal(r.series.at(-1)!.pnl, 114_041_786);
  assert.deepEqual(asked, ['portfolio:m'], 'its own perp PnL explains the figure: no sub-account read');
});

test("a master trading through sub-accounts: the board's figure is master + subs, and so is the curve (0xf5d8…ad53)", async () => {
  // File 30d +34,450,041; master's own perpMonth -483,367; sub 3 +35,346,932, sub 5 +2,165,880, sub 7 -3,458,244, sub 1 0.
  const { post, asked } = fakeInfo(
    {
      m: portfolio([0, 0, 0, -491_783], [0, -100_000, -300_000, -483_367]),
      s1: portfolio([0, 0, 0, 0], [0, 0, 0, 0]),
      s3: portfolio([0, 9e6, 20e6, 35_346_932], [0, 9e6, 20e6, 35_346_932]),
      s5: portfolio([0, 1e6, 2e6, 2_165_880], [0, 1e6, 2e6, 2_165_880]),
      s7: portfolio([0, -1e6, -2e6, -3_458_244], [0, -1e6, -2e6, -3_458_244]),
    },
    { m: ['S1', 's3', 's5', 's7', 's3'] },
  );
  const own = await rowSeries('m', PERP_WINDOW['30d'], null, post);
  assert.equal(own.series.at(-1)!.pnl, -483_367, 'nothing to match: the address alone');
  const r = await rowSeries('m', PERP_WINDOW['30d'], 34_450_040.68, post);
  assert.equal(r.subs, 4, 'every sub-account, once, lower-cased');
  assert.equal(r.series.at(-1)!.pnl, -483_367 + 35_346_932 + 2_165_880 - 3_458_244);
  assert.equal(r.explained, true, '33.57M against the file\'s 34.45M: inside the hourly file\'s drift');
  assert.ok(asked.includes('subAccounts:m'));
});

test("a figure nothing explains is reported as such (the podium then draws no curve), and a sub-account that can't be read fails the read", async () => {
  const { post } = fakeInfo({ m: portfolio([0, 0, 0, 0], [0, 0, 0, 10_000]), s: portfolio([0, 0, 0, 0], [0, 0, 0, 20_000]) }, { m: ['s'] });
  const r = await rowSeries('m', PERP_WINDOW['30d'], 5_000_000, post);
  assert.equal(r.explained, false);
  const broken = fakeInfo({ m: portfolio([0, 0, 0, 0], [0, 0, 0, 0]) }, { m: ['gone'] });
  await assert.rejects(rowSeries('m', PERP_WINDOW['30d'], 5_000_000, broken.post));
});

test('sumSeries: held at each last point, 0 before a first point; explains: $25k or 10 %', () => {
  const a = [{ t: 0, pnl: 0, accountValue: 10 }, { t: 20, pnl: 5, accountValue: 15 }];
  const b = [{ t: 10, pnl: 0, accountValue: 100 }, { t: 30, pnl: -2, accountValue: 98 }];
  assert.deepEqual(sumSeries([a, b]), [
    { t: 0, pnl: 0, accountValue: 10 },
    { t: 10, pnl: 0, accountValue: 110 },
    { t: 20, pnl: 5, accountValue: 115 },
    { t: 30, pnl: 3, accountValue: 113 },
  ]);
  assert.equal(explains(20_000, 0), true);
  assert.equal(explains(30_000, 0), false);
  assert.equal(explains(9.1e6, 10e6), true);
  assert.equal(explains(8.9e6, 10e6), false);
});
