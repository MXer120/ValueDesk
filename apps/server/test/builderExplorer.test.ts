/**
 * Reading an order's signed request from SoDEX's public explorer: the builder
 * it names and the key that signed it (src/builder/explorer.ts).
 *
 * The fixture holds real answers (mainnet, 2026-10-02, public data): two spot
 * orders that name a builder and a perps order that names none. Each must
 * recover a key its account really lists - that is what proves the request is
 * rebuilt in the order it was signed in, from an answer whose keys are sorted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Engine } from '../src/builder/config.js';
import { EXPLORER_BASE, explorerPath, orderFacts, readExplorerTx, recoverSigner, signedParams } from '../src/builder/explorer.js';
import { readApproval, readAppKeys } from '../src/builder/verifier.js';
import { explorerBase } from '../src/builder/service.js';
import { BUILDER, CHAIN, Clock, FakeSodex, addr, apiKey } from './builderFakes.js';

interface Sample {
  what: string;
  engine: Engine;
  orderId: string;
  body: { data: { tx_json: string; [k: string]: unknown }; [k: string]: unknown };
  signer: string;
  keyName: string;
  builder: { id: string; fee: number } | null;
  createdAt: number;
}
const FX = JSON.parse(readFileSync(new URL('./builderExplorer.fixture.json', import.meta.url), 'utf8')) as {
  chainId: number;
  orders: Sample[];
  apiKeys: Record<string, Array<{ name: string; publicKey: string }>>;
  builders226415: unknown;
  historyRow: Record<string, unknown>;
  openOrder: Record<string, unknown>;
};

test('explorer: every real order recovers a key its account lists, and names the builder it was sent with', () => {
  assert.equal(FX.chainId, CHAIN);
  const listed = new Map([...FX.apiKeys.spot226415!, ...FX.apiKeys.perps1061!].map((k) => [k.publicKey.toLowerCase(), k.name]));
  for (const s of FX.orders) {
    const tx = readExplorerTx(s.body);
    assert.ok(tx, s.what);
    assert.equal(tx.tsMs, s.createdAt, s.what);
    assert.deepEqual(tx.orderIds, [s.orderId], s.what);
    const facts = orderFacts(tx, s.engine, s.orderId, FX.chainId);
    assert.ok(facts, s.what);
    assert.equal(facts.signer, s.signer, s.what);
    assert.equal(listed.get(facts.signer!), s.keyName, `${s.what}: the signer is a key the account lists`);
    assert.deepEqual(facts.builder, s.builder, s.what);
    assert.equal(facts.createdAt, s.createdAt);
    assert.match(facts.txHash!, /^0x[0-9a-f]{64}$/);
  }
});

test('explorer: the order of the keys in the answer does not matter - the signed order is rebuilt from the names', () => {
  const [sorted, signedOrder] = [FX.orders[2]!, FX.orders[3]!];
  assert.notEqual(sorted.body.data.tx_json, signedOrder.body.data.tx_json, 'the two routes serialise the same request differently');
  const a = readExplorerTx(sorted.body)!;
  const b = readExplorerTx(signedOrder.body)!;
  assert.equal(b.type, 'newOrder', 'the type is read from the request when the answer has no action field');
  assert.deepEqual(signedParams('perps', a.type, a.payload), signedParams('perps', b.type, b.payload));
  assert.equal(recoverSigner(a, 'perps', CHAIN), recoverSigner(b, 'perps', CHAIN));
  // Exactly the text the key signed, as the by-hash route returns it.
  assert.equal(JSON.stringify(signedParams('perps', b.type, b.payload)), JSON.stringify((JSON.parse(signedOrder.body.data.tx_json) as { payload: unknown }).payload));
});

test('explorer: a request that was changed after signing recovers a stranger, never the key', () => {
  const s = FX.orders[1]!;
  const change = (fn: (tj: { payload: { builder?: { fee: number; id: number }; orders: Array<Record<string, unknown>> }; nonce: number }) => void) => {
    const tj = JSON.parse(s.body.data.tx_json);
    fn(tj);
    return readExplorerTx({ ...s.body, data: { ...s.body.data, tx_json: JSON.stringify(tj) } })!;
  };
  for (const tx of [
    change((tj) => (tj.payload.builder!.fee = 99)),
    change((tj) => delete tj.payload.builder),
    change((tj) => (tj.payload.orders[0]!.quantity = '15')),
    change((tj) => (tj.nonce += 1)),
  ]) {
    const who = recoverSigner(tx, 'spot', CHAIN);
    assert.notEqual(who, s.signer);
  }
  // The engine's domain and the chain are part of what was signed.
  const tx = readExplorerTx(s.body)!;
  assert.notEqual(recoverSigner(tx, 'spot', 138565), s.signer);
  assert.equal(recoverSigner(tx, 'perps', CHAIN), null, 'a spot request is not a perps order');
});

test('explorer: what is not an order\'s own request says nothing', () => {
  const s = FX.orders[0]!;
  const tx = readExplorerTx(s.body)!;
  assert.equal(orderFacts(tx, 'spot', '999', CHAIN), null, 'the request created other orders');
  // A replace or a modify answers for the order id too, and carries no builder.
  for (const type of ['replaceOrder', 'modifyOrder', 'cancelOrder', 'newTwapOrder']) {
    assert.equal(orderFacts({ ...tx, type }, 'spot', s.orderId, CHAIN), null, type);
    assert.equal(recoverSigner({ ...tx, type }, 'spot', CHAIN), null, type);
  }
  // Answers that hold no transaction.
  for (const body of [null, {}, { code: 404, message: 'record not found', data: null }, { code: 0, data: {} }, { code: 0, data: { tx_json: '{' } },
    { code: 0, data: { ...s.body.data, tx_json: JSON.stringify({ nonce: 1, payload: {}, type: 'batchNewOrder', signature: '0x01' }) } },
    { code: 0, data: { ...s.body.data, ts_ms: 'yesterday' } }, { code: 1, data: s.body.data }]) {
    assert.equal(readExplorerTx(body), null, JSON.stringify(body).slice(0, 60));
  }
});

test('explorer: a builder per order (perps) wins over the request\'s; an order that cannot be told apart is left undecided', () => {
  const clock = new Clock();
  const sodex = new FakeSodex(clock);
  const key = apiKey('valuescan-web');
  const wallet = addr(0xa1);
  sodex.approve(wallet, 4242);
  sodex.order(wallet, { engine: 'perps', orderId: 11, at: clock.now(), builder: { id: BUILDER, fee: 20 }, key });
  const body = sodex.txs.get('perps:4242:11') as { data: Record<string, unknown> };
  const base = readExplorerTx(body)!;
  assert.deepEqual(orderFacts(base, 'perps', '11', CHAIN)!.builder, { id: String(BUILDER), fee: 20 });
  assert.equal(orderFacts(base, 'perps', '11', CHAIN)!.signer, key.address);

  const two = (orders: unknown[], orderIds: string[], builder?: unknown) => ({ ...base, orderIds, payload: { ...base.payload, orders, builder } });
  const plain = { clOrdID: 'a', side: 1 };
  const own = { clOrdID: 'b', side: 1, builder: { id: 777, fee: 5 } };
  // The order's own builder, found by its place in the request.
  assert.deepEqual(orderFacts(two([plain, own], ['11', '12'], { id: BUILDER, fee: 20 }), 'perps', '12', CHAIN)!.builder, { id: '777', fee: 5 });
  assert.deepEqual(orderFacts(two([plain, own], ['11', '12'], { id: BUILDER, fee: 20 }), 'perps', '11', CHAIN)!.builder, { id: String(BUILDER), fee: 20 });
  assert.equal(orderFacts(two([plain, own], ['11', '12']), 'perps', '11', CHAIN)!.builder, null, 'this order names none');
  // Fewer ids than orders (one was refused): which is which cannot be said - nothing is concluded.
  assert.equal(orderFacts(two([plain, own], ['12'], { id: BUILDER, fee: 20 }), 'perps', '12', CHAIN), null);
  // No order has a builder of its own: the request's holds for all of them.
  assert.deepEqual(orderFacts(two([plain, plain], ['12'], { id: BUILDER, fee: 20 }), 'perps', '12', CHAIN)!.builder, { id: String(BUILDER), fee: 20 });
  // A builder that cannot be read is not "no builder".
  assert.equal(orderFacts(two([plain], ['11'], { id: 'abc', fee: 20 }), 'perps', '11', CHAIN), null);
  assert.equal(orderFacts(two([plain], ['11'], { id: BUILDER, fee: 1.5 }), 'perps', '11', CHAIN), null);
  assert.equal(orderFacts(two([plain], ['11'], 'yes'), 'perps', '11', CHAIN), null);
});

test('explorer: the path is built from digits only', () => {
  assert.equal(explorerPath('spot', 226415, '6896407749'), '/api/v1/spot/transaction?account_id=226415&order_id=6896407749');
  assert.equal(explorerPath('perps', 1061, '26767050140'), '/api/v1/perps/transaction?account_id=1061&order_id=26767050140');
  for (const id of ['', '1&x=1', '../1', '1 2', '-1', '1e3', 'abc']) assert.throws(() => explorerPath('spot', 1, id), RangeError, id);
  for (const account of [0, -1, 1.5, Number.NaN]) assert.throws(() => explorerPath('spot', account, '1'), RangeError);
  assert.equal(EXPLORER_BASE.mainnet, 'https://clobscan-mainnet.sodex.dev');
  // The override is an https origin or it is ignored.
  assert.equal(explorerBase('https://explorer.example/', 'mainnet'), 'https://explorer.example');
  for (const bad of [undefined, '', 'http://explorer.example', 'https://explorer.example/path', 'javascript:alert(1)', 'https://u:p@explorer.example']) {
    assert.equal(explorerBase(bad, 'mainnet'), EXPLORER_BASE.mainnet, String(bad));
  }
});

test('gateway shapes: approvals, the app\'s keys - and a finished order\'s row has no builder', () => {
  // GET /user/{address}/builders, as it is answered.
  assert.deepEqual(readApproval(FX.builders226415, 223169), { approved: true, accountId: 226415 });
  assert.deepEqual(readApproval(FX.builders226415, BUILDER), { approved: false, accountId: null }, 'another builder\'s approval is not ours');
  assert.deepEqual(readApproval({ spot: [], perps: [] }, BUILDER), { approved: false, accountId: null });
  assert.deepEqual(readApproval({ spot: [{ userID: 5, builderID: BUILDER, feeRate: 0 }] }, BUILDER), { approved: false, accountId: null }, 'a rate of 0 is no approval');
  assert.deepEqual(readApproval({ perps: [{ userID: '5', builderID: String(BUILDER), feeRate: '20' }] }, BUILDER), { approved: true, accountId: 5 });
  assert.deepEqual(readApproval({ perps: [{ builderID: BUILDER, feeRate: 20 }] }, BUILDER), { approved: true, accountId: null }, 'approved, but without an account id it cannot be looked up');
  for (const junk of [null, 'x', [], { spot: 'none' }, { spot: [null, 7] }]) assert.deepEqual(readApproval(junk, BUILDER), { approved: false, accountId: null });

  // Only keys our app registered are kept; the user's other keys are theirs.
  assert.deepEqual(readAppKeys(FX.apiKeys.spot226415), []);
  assert.deepEqual(
    readAppKeys([
      { name: 'default', type: 'EVM', publicKey: addr(1) },
      { name: 'valuescan-web', type: 'EVM', publicKey: '0x' + 'AB'.repeat(20), expiresAt: 1 },
      { name: 'valuescan-mobile', type: 'EVM', publicKey: addr(2) },
      { name: 'webkey', type: 'EVM', publicKey: addr(3) },
      { name: 'valuescan-web', publicKey: 'not-an-address' },
      { name: 'xvaluescan-web', publicKey: addr(4) },
    ]),
    [{ name: 'valuescan-web', key: '0x' + 'ab'.repeat(20) }, { name: 'valuescan-mobile', key: addr(2) }],
  );
  assert.deepEqual(readAppKeys(null), []);

  // What the page used to assume, and what SoDEX really returns: the builder is on the OPEN order only.
  assert.deepEqual(FX.openOrder.builder, { builderID: 223169, feeRate: 100 });
  assert.equal('builder' in FX.historyRow, false, 'order history rows of finished orders carry no builder');
  assert.equal(FX.historyRow.orderID, 6896407749, 'the very order the explorer shows with builder 223169');
});
