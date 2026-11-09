/**
 * KeyAlgoSink: cancels of one account that arrive together go out as ONE signed request (owner 2026-11-09, Katana's
 * rule), each caller with its own outcome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyAlgoSink } from '../src/algo/sink.ts';

const mkt = (id: number) => ({ id, name: `M${id}-USD` }) as never;
const algo = (accountId: number) => ({ accountId }) as never;

function sinkWith(answer: (rows: Array<{ clOrdID: string }>) => unknown) {
  const sent: Array<Array<{ symbolID: number; clOrdID: string }>> = [];
  const sink = new KeyAlgoSink(null as never, () => null, null as never, 1, async () => null);
  (sink as unknown as { signAndSend: (action: { params?: unknown; orders?: unknown }) => Promise<unknown> }).signAndSend = async (action) => {
    const rows = ((action as { params?: { cancels?: unknown; orders?: unknown } }).params?.cancels ?? (action as { params?: { orders?: unknown } }).params?.orders ?? (action as { cancels?: unknown }).cancels ?? []) as Array<{ symbolID: number; clOrdID: string }>;
    sent.push(rows);
    return answer(rows);
  };
  return { sink, sent };
}

test('two bots of one wallet pulling on two markets at once: one request; another wallet\'s goes on its own', async () => {
  const { sink, sent } = sinkWith((rows) => rows.map((r) => ({ code: 0, clOrdID: r.clOrdID })));
  const [x, y, z] = await Promise.all([
    sink.cancel(algo(7), mkt(1), ['a1']),
    sink.cancel(algo(7), mkt(2), ['b1', 'b2']),
    sink.cancel(algo(9), mkt(1), ['c1']),
  ]);
  assert.equal(sent.length, 2, 'one request per account');
  const seven = sent.find((r) => r.some((x) => x.clOrdID === 'a1'))!;
  assert.deepEqual(seven.map((r) => [r.symbolID, r.clOrdID]), [[1, 'a1'], [2, 'b1'], [2, 'b2']]);
  assert.deepEqual([x, y, z], [[], [], []]);
});

test('in one request: a row SoDEX answers "OrderNotFound" is gone for its caller; one it refused fails only its caller', async () => {
  const { sink } = sinkWith(() => [
    { code: 0, clOrdID: 'a1' },
    { code: -1, clOrdID: 'b1', error: 'order rejected: OrderNotFound' },
    { code: -2, clOrdID: 'c1', error: 'order is being matched' },
  ]);
  const ra = sink.cancel(algo(7), mkt(1), ['a1']);
  const rb = sink.cancel(algo(7), mkt(2), ['b1']);
  const rc = sink.cancel(algo(7), mkt(3), ['c1']);
  assert.deepEqual(await ra, []);
  assert.deepEqual(await rb, ['b1']);
  await assert.rejects(rc, /did not cancel 1 order: c1: order is being matched/);
});
