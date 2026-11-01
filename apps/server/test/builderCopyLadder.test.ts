/**
 * The ledger's copy of the copy fee ladder is the engines' own: an order of the copy or algo
 * engines is judged against it (builder/verifier.ts), so the two must never drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPY_LADDER, COPY_LADDER_DAYS, ENGINE_ORDER_ID, copyLadderFee } from '../src/builder/tiers.js';
import { COPY_FEE_LADDER, COPY_FEE_WINDOW_DAYS, copyFeeFor } from '../../../packages/copy-engine/src/policy.js';

test('copy ladder: the same steps and window as the copy engine', () => {
  assert.deepEqual(COPY_LADDER.map((s) => [s.fromUsd, s.fee]), COPY_FEE_LADDER.map((s) => [s.fromUsd, s.fee]));
  assert.equal(COPY_LADDER_DAYS, COPY_FEE_WINDOW_DAYS);
  for (const v of [0, 99_999, 100_000, 499_999, 500_000, 2_000_000, 9_999_999, 10_000_000, 5e8]) assert.equal(copyLadderFee(v), copyFeeFor(v), `$${v}`);
});

test('copy ladder: the engines’ client order ids, nothing of the site', () => {
  for (const cl of ['va-1v405g0a2n2s-1', 'vdc-0123456789abcdef01234567', 'vds-0123456789abcdef01234567']) assert.ok(ENGINE_ORDER_ID.test(cl), cl);
  for (const cl of ['vs-abc', 'tp-1', 'sl-m', 'valgo', null as unknown as string]) assert.ok(!ENGINE_ORDER_ID.test(String(cl)), String(cl));
});
