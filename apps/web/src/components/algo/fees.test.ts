import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AlgoPlan, AlgoSpec } from '@copy-engine';
import { feeRange, feeSplit, feeWords } from './fees';

const book = { bid: 99, ask: 101, px: 100 };
const rates = { maker: 0.0001, taker: 0.0005 };
const plan = (children: Array<{ qty: number; price: number | null }>, notional: number | null = null): AlgoPlan =>
  ({ notional, children: children.map((c) => ({ ...c, at: null, tag: '' })) }) as unknown as AlgoPlan;

test('a post-only ladder is all maker, exactly: one figure, no range', () => {
  const s = { kind: 'scale', side: 'buy', postOnly: true } as AlgoSpec;
  const f = feeSplit(s, plan([{ qty: 1, price: 100 }, { qty: 1, price: 98 }]), book);
  assert.deepEqual(f, { maker: 198, taker: 0, either: 0, refused: 0 });
  const r = feeRange(f, rates);
  assert.equal(r.lo, r.hi);
  assert.equal(feeWords(f), 'all resting · maker');
});

test('a ladder level at the ask takes when it may, and is refused when post-only', () => {
  const kids = [{ qty: 1, price: 101 }, { qty: 1, price: 98 }];
  assert.deepEqual(feeSplit({ kind: 'scale', side: 'buy', postOnly: false } as AlgoSpec, plan(kids), book), { maker: 98, taker: 101, either: 0, refused: 0 });
  assert.deepEqual(feeSplit({ kind: 'scale', side: 'buy', postOnly: true } as AlgoSpec, plan(kids), book), { maker: 98, taker: 0, either: 0, refused: 101 });
  // A sell rests above the bid, takes at or below it.
  assert.deepEqual(feeSplit({ kind: 'scale', side: 'sell', postOnly: false } as AlgoSpec, plan([{ qty: 1, price: 99 }, { qty: 1, price: 100 }]), book), { maker: 100, taker: 99, either: 0, refused: 0 });
});

test('time-sliced kinds follow their execution style; only hybrid or a taking finish is a range', () => {
  const twap = (style: string, finish: string) => ({ kind: 'twap', side: 'buy', exec: { style }, finish }) as unknown as AlgoSpec;
  const p = plan([], 1000);
  assert.equal(feeSplit(twap('taker', 'take'), p, book).taker, 1000);
  assert.equal(feeSplit(twap('maker', 'leave'), p, book).maker, 1000);
  assert.equal(feeSplit(twap('maker', 'take'), p, book).either, 1000);
  assert.equal(feeSplit(twap('hybrid', 'leave'), p, book).either, 1000);
  const r = feeRange(feeSplit(twap('hybrid', 'leave'), p, book), rates);
  assert.ok(Math.abs(r.lo - 0.1) < 1e-12 && Math.abs(r.hi - 0.5) < 1e-12);
});

test('takers are takers: swarm, fill fast, basket, a market bracket and a market trailing exit', () => {
  const p = plan([], 500);
  for (const s of [{ kind: 'swarm' }, { kind: 'sweep' }, { kind: 'basket' }, { kind: 'bracket', entry: 'market' }, { kind: 'trailing', exit: 'market' }]) {
    assert.equal(feeSplit({ side: 'buy', ...s } as AlgoSpec, p, book).taker, 500, s.kind);
  }
  assert.equal(feeSplit({ kind: 'chase', side: 'buy', onEnd: 'cancel', timeoutMs: 1000, maxChaseBps: null } as AlgoSpec, p, book).maker, 500);
  assert.equal(feeSplit({ kind: 'chase', side: 'buy', onEnd: 'take', timeoutMs: 1000, maxChaseBps: null } as AlgoSpec, p, book).either, 500);
});
