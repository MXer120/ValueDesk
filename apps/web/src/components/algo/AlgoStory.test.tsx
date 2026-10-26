/**
 * The Preview's moving picture: every order type gets a scene, at the start,
 * midway and at the end, drawn from its own plan.
 * Run (from apps/web): npx tsx --test src/components/algo/AlgoStory.test.tsx
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidElement, type ReactNode } from 'react';
import { checkAlgoSpec, planAlgo, type AlgoSpec, type MarketInfo } from '@copy-engine';
import { DEFAULT, cond, draftToSpec, legs, type Draft, type TicketShared } from './draft';
import { ALGO_MENU, type UiKind } from './menu';
import { sceneFor, viewsFor, type Level, type StoryProps } from './AlgoStory';

/** Every attribute the picture would draw, its components called (no DOM needed). */
function attrs(n: ReactNode, out: string[] = []): string[] {
  if (Array.isArray(n)) n.forEach((x) => attrs(x, out));
  else if (isValidElement(n)) {
    const { children, ...rest } = n.props as Record<string, unknown> & { children?: ReactNode };
    if (typeof n.type === 'function') return attrs((n.type as (p: unknown) => ReactNode)(n.props), out);
    for (const [k, v] of Object.entries(rest)) if (typeof v === 'number' || typeof v === 'string') out.push(`${k}=${v}`);
    attrs(children, out);
  } else if (typeof n === 'string' || typeof n === 'number') out.push(String(n));
  return out;
}

const NOW = 1_800_000_000_000;
const shared: TicketShared = { symbol: 'BTC-USD', side: 'buy', quantity: '0.5', reduceOnly: false, leverage: 5, marginMode: 'cross', bid: 99_990, ask: 100_000 };
const BTC = { id: 1, name: 'BTC-USD', base: 'BTC', tickSize: '0.1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', marketMaxQuantity: null, minNotional: 10, maxNotional: 5_000_000, maxLeverage: 50, buyLimitUpRatio: 0.05, sellLimitDownRatio: 0.05, takerFee: 0.0004, makerFee: 0.0002 } as unknown as MarketInfo;

function draftFor(kind: UiKind): Draft {
  const d: Draft = { ...DEFAULT };
  if (kind === 'scale') Object.assign(d, { from: '99800', to: '98000' });
  if (kind === 'conditional') d.conds = [cond('BTC-USD', { value: '101000' })];
  if (kind === 'basket') d.legs = legs('BTC-USD', 'buy');
  if (kind === 'iceberg') d.display = '0.05';
  if (kind === 'bracket') Object.assign(d, { tp: '2', sl: '1' });
  return d;
}

const levelsFor = (s: AlgoSpec): Level[] => {
  const out: Level[] = [{ label: 'Now', price: 99_995, tone: 'now' }];
  if (s.kind === 'chase') out.push({ label: 'Rests at', price: 99_990, tone: 'pos' }, { label: 'Chases to', price: 100_300, tone: 'muted' });
  if (s.kind === 'iceberg') out.push({ label: 'Clip at', price: 99_990, tone: 'pos' });
  if (s.kind === 'trailing') out.push({ label: 'Stop', price: 98_995, tone: 'pos' });
  if (s.kind === 'conditional') out.push({ label: 'When ≥', price: 101_000, tone: 'warn' });
  return out;
};

for (const { id } of ALGO_MENU) {
  test(`${id}: a scene at every moment`, () => {
    const side = id === 'trailing' ? 'sell' : 'buy';
    const c = checkAlgoSpec(draftToSpec(id, draftFor(id), { ...shared, side }, NOW));
    assert.ok(c.spec, `${id}: ${JSON.stringify(c.errors ?? c)}`);
    const spec = c.spec!;
    const plan = planAlgo(spec, BTC, { now: NOW, price: 99_995, seed: 1, hourVolume: 50, prices: () => 3_000 });
    const history = Array.from({ length: 90 }, (_, i) => ({ t: NOW - (90 - i) * 60_000, p: 99_900 + Math.sin(i / 7) * 80 }));
    const props: StoryProps = { plan, spec, side, mid: 99_995, levels: levelsFor(spec), base: 'BTC', sweepRef: { price: 100_010, name: 'Oracle mid' }, uiKind: id, history, book: { bid: 99_990, ask: 100_000 }, profile: null, refs: { mid: 99_995, mark: 99_990, index: 99_980, oracleMid: 100_000, oracleFair: 100_002 }, bandDepth: 0.2, tz: 'utc', dayVolume: { from: NOW - 4 * 3_600_000, v: Array.from({ length: 24 }, (_, i) => 10 + i) } };
    for (const view of viewsFor(props)) {
      for (const t of [0, 0.5, 1]) {
        for (const pr of [props, { ...props, history: null }]) {
          const s = sceneFor(t, pr, view);
          assert.ok(s, `${id} ${view} at ${t}`);
          assert.ok(s!.steps.length >= 2);
          assert.ok(s!.step >= 0 && s!.step < s!.steps.length, `${id} ${view} step ${s!.step}`);
          const svg = attrs(s!.svg).join(' ');
          assert.doesNotMatch(svg, /NaN|Infinity/, `${id} ${view} at ${t}`);
          if (t === 1 && !['conditional', 'chase'].includes(id)) assert.ok(s!.done > 0, `${id} ${view} ends with something done`);
        }
      }
    }
  });
}

test('Fill fast: the rounds follow the depth SoDEX\'s book holds within the max slippage', () => {
  const spec = checkAlgoSpec(draftToSpec('sweep', DEFAULT, shared, NOW)).spec!;
  const plan = planAlgo(spec, BTC, { now: NOW, price: 99_995, seed: 1 });
  const props: StoryProps = { plan, spec, side: 'buy', mid: 99_995, levels: [], base: 'BTC', sweepRef: { price: 100_000, name: 'Oracle mid' } };
  // 0.5 BTC against 0.2 BTC within the limit: three rounds; against 5 BTC: one.
  assert.match(sceneFor(1, { ...props, bandDepth: 0.2 }, 'how')!.steps[0]!, /about 3 IOCs/);
  assert.match(sceneFor(1, { ...props, bandDepth: 5 }, 'how')!.steps[0]!, /one IOC fills it all/);
  assert.equal(sceneFor(1, { ...props, bandDepth: 0.2 }, 'how')!.done, 1);
});

test('a slice\'s slippage reference reaches the spec only when it is not the best price', () => {
  const touch = draftToSpec('twap', DEFAULT, shared, NOW) as { exec: Record<string, unknown> };
  assert.equal('slipFrom' in touch.exec, false);
  const oracle = checkAlgoSpec(draftToSpec('twap', { ...DEFAULT, slipFrom: 'oracleMid' }, shared, NOW));
  assert.equal(oracle.spec?.kind === 'twap' && oracle.spec.exec.slipFrom, 'oracleMid');
});
