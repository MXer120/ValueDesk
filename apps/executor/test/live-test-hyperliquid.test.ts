/**
 * The live test's Hyperliquid client (apps/executor/tools/live-test/hyperliquid.ts)
 * and its Hyperliquid leader (leader.ts): the msgpack bytes of an action, the
 * connectionId and the EIP-712 digest an L1 action is signed over, the
 * signature, the price and size rounding, the guard that refuses every action
 * but an IOC, a cancel and a leverage change, and what goes over the wire - to
 * a fake Hyperliquid on loopback. Nothing here reaches Hyperliquid.
 *
 * THE VECTORS. Two are the official Python SDK's own (hyperliquid-python-sdk,
 * tests/signing_test.py): the connectionId of its ETH order
 * (test_phantom_agent_creation_matches_production) and the signatures of its
 * "dummy" action (test_l1_action_signing_matches). The msgpack bytes and the
 * digest are pinned here from this implementation, cross-checked when they
 * were written against @msgpack/msgpack 3.1.3 and viem 2.56.0 (hashTypedData),
 * and the digest is also computed in this file from the EIP-712 formula.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bytesToHex, concat, hexToBytes, keccak256, privateKeyToAddress, recoverAddress, utf8, word } from '../../../packages/sodex-core/src/index.ts';
import { walletSign } from '../tools/live-test/exchange.ts';
import {
  HL_ALLOWED_ACTIONS,
  HyperliquidExchange,
  HyperliquidInfo,
  actionHash,
  guardAction,
  hlCoinOf,
  hlPrice,
  hlSize,
  l1Digest,
  msgpack,
  signL1Action,
  sodexSymbolOf,
} from '../tools/live-test/hyperliquid.ts';
import { HyperliquidLeader, leaderKeyName, leaderVenueOf } from '../tools/live-test/leader.ts';

/** The SDK test's order: ETH (asset 4), buy 0.0147 at 1670.1, IOC, not reduce-only, keys in the SDK's order. */
const SDK_ORDER = { type: 'order', orders: [{ a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' };
const SDK_NONCE = 1677777606040;
const SDK_KEY = hexToBytes('0x0123456789012345678901234567890123456789012345678901234567890123');

/* --------------------------------------------------------------- msgpack ----- */

test('msgpack: the SDK order is the bytes Python\'s msgpack gives (maps in insertion order, fixstr, fixint, booleans)', () => {
  const hex = [
    '83', // map of 3
    'a474797065', 'a56f72646572', // "type": "order"
    'a66f7264657273', '91', // "orders": [ one
    '86', // map of 6
    'a161', '04', // "a": 4
    'a162', 'c3', // "b": true
    'a170', 'a6313637302e31', // "p": "1670.1"
    'a173', 'a6302e30313437', // "s": "0.0147"
    'a172', 'c2', // "r": false
    'a174', '81', 'a56c696d6974', '81', 'a3746966', 'a3496f63', // "t": { "limit": { "tif": "Ioc" } } ]
    'a867726f7570696e67', 'a26e61', // "grouping": "na"
  ].join('');
  assert.equal(bytesToHex(msgpack(SDK_ORDER)), `0x${hex}`);
});

test('msgpack: integers in the smallest format, uint64 order ids, str8 from 32 bytes, null', () => {
  const first = (v: unknown) => bytesToHex(msgpack(v)).slice(2, 4);
  const cases: Array<[number | bigint, string]> = [
    [0, '00'], [127, '7f'], [128, 'cc'], [255, 'cc'], [256, 'cd'], [65535, 'cd'], [65536, 'ce'], [2 ** 32 - 1, 'ce'], [2 ** 32, 'cf'],
    [-1, 'ff'], [-32, 'e0'], [-33, 'd0'], [-128, 'd0'], [-129, 'd1'], [-32768, 'd1'], [-32769, 'd2'], [-(2 ** 31) - 1, 'd3'],
    [2n ** 64n - 1n, 'cf'],
  ];
  for (const [v, f] of cases) assert.equal(first(v), f, String(v));
  // A cancel's order id above 2^32: uint64, big-endian.
  assert.equal(bytesToHex(msgpack({ type: 'cancel', cancels: [{ a: 0, o: 91490942035 }] })), '0x82a474797065a663616e63656ca763616e63656c739182a16100a16fcf000000154d48fc53');
  assert.equal(bytesToHex(msgpack('a'.repeat(31))).slice(2, 4), 'bf', 'fixstr up to 31 bytes');
  assert.equal(bytesToHex(msgpack('a'.repeat(32))).slice(2, 6), 'd920', 'str8 from 32');
  assert.equal(bytesToHex(msgpack([null, true])), '0x92c0c3');
  assert.equal(bytesToHex(msgpack({ type: 'updateLeverage', asset: 1, isCross: true, leverage: 2 })), '0x84a474797065ae7570646174654c65766572616765a5617373657401a7697343726f7373c3a86c6576657261676502');
});

test('msgpack: a float, an undefined field and an integer-like key are refused (the bytes would not be the SDK\'s)', () => {
  assert.throws(() => msgpack({ p: 1670.1 }), /not a whole number/);
  assert.throws(() => msgpack({ p: undefined }), /undefined/);
  assert.throws(() => msgpack({ 1: 'x' }), /lose its place/);
  assert.throws(() => msgpack(Symbol('x')), /cannot encode/);
});

/* --------------------------------------------------------------- signing ----- */

test('connectionId: keccak256(msgpack(action) || nonce || 0x00) - the official SDK\'s vector for its ETH order', () => {
  assert.equal(bytesToHex(actionHash(SDK_ORDER, SDK_NONCE)), '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
  // The same bytes laid out by hand: the nonce big-endian, then the no-vault byte.
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setBigUint64(0, BigInt(SDK_NONCE));
  assert.equal(bytesToHex(actionHash(SDK_ORDER, SDK_NONCE)), bytesToHex(keccak256(concat(msgpack(SDK_ORDER), nonce, Uint8Array.of(0)))));
  assert.notEqual(bytesToHex(actionHash(SDK_ORDER, SDK_NONCE + 1)), bytesToHex(actionHash(SDK_ORDER, SDK_NONCE)), 'the nonce is in it');
});

test('digest: EIP-712 Agent(string source, bytes32 connectionId) in the Exchange domain, chain 1337, zero contract', () => {
  const conn = actionHash(SDK_ORDER, SDK_NONCE);
  // Written out from the EIP-712 formula, not through hashTypedData.
  const domainType = keccak256(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const domain = keccak256(concat(domainType, keccak256(utf8('Exchange')), keccak256(utf8('1')), word(1337), new Uint8Array(32)));
  const agent = (source: string) => keccak256(concat(keccak256(utf8('Agent(string source,bytes32 connectionId)')), keccak256(utf8(source)), conn));
  const digest = (source: string) => bytesToHex(keccak256(concat(Uint8Array.of(0x19, 0x01), domain, agent(source))));
  assert.equal(bytesToHex(l1Digest(SDK_ORDER, SDK_NONCE)), digest('a'), 'mainnet: source a');
  assert.equal(bytesToHex(l1Digest(SDK_ORDER, SDK_NONCE, 'b')), digest('b'), 'testnet: source b');
  assert.equal(bytesToHex(l1Digest(SDK_ORDER, SDK_NONCE)), '0xbe5eb0697b77c2acfeaa07a3d4913ae5d06489c63bfd143c5d3d66540a196c43');
});

test('signature: the official SDK\'s vectors for its "dummy" action (nonce 0, no vault), and it recovers to the signer', () => {
  const dummy = { type: 'dummy', num: 100_000_000_000 };
  const s = signL1Action(dummy, 0, SDK_KEY);
  // The SDK writes r without its leading zero (0x53749d...); here it is the full 32 bytes.
  assert.deepEqual(s, { r: '0x053749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', s: '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', v: 27 });
  assert.equal(walletSign(bytesToHex(l1Digest(dummy, 0, 'b')), SDK_KEY), '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f951017b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a6131c', 'testnet');
  const o = signL1Action(SDK_ORDER, SDK_NONCE, SDK_KEY);
  const rsv = hexToBytes(`${o.r}${o.s.slice(2)}${o.v.toString(16)}`);
  assert.equal(recoverAddress(l1Digest(SDK_ORDER, SDK_NONCE), rsv).toLowerCase(), privateKeyToAddress(SDK_KEY).toLowerCase());
});

/* -------------------------------------------------------------- rounding ----- */

test('rounding: sizes floored to szDecimals; prices 5 significant figures, at most 6 - szDecimals decimals, no trailing zeros', () => {
  assert.equal(hlSize(0.00015, 5), '0.00015', 'binary noise does not drop a step');
  assert.equal(hlSize(0.000159, 5), '0.00015');
  assert.equal(hlSize(1.999999, 3), '1.999');
  assert.equal(hlSize(12, 0), '12');
  assert.equal(hlSize(0.4, 0), '0', 'under one step');
  assert.equal(hlSize(0.0147, 4), '0.0147');
  assert.equal(hlPrice(67234.56, 5), '67235', 'BTC: 5 significant figures, no decimal left');
  assert.equal(hlPrice(2345.678, 4), '2345.7');
  assert.equal(hlPrice(2345.0, 4), '2345');
  assert.equal(hlPrice(1670.1, 4), '1670.1');
  assert.equal(hlPrice(0.0123456, 0), '0.012346', 'kPEPE-like: 6 decimals');
  assert.equal(hlPrice(1.23456789, 2), '1.2346');
  assert.equal(hlPrice(0.000123456, 2), '0.0001', 'at most 4 decimals with szDecimals 2');
  assert.equal(hlPrice(123456.7, 2), '123460');
  assert.throws(() => hlPrice(0, 2));
  assert.throws(() => hlSize(-1, 2));
});

test('venues: BTC-USD <-> BTC, ETH-USD <-> ETH; LIVE_LEADER_VENUE is sodex by default, hyperliquid, nothing else', () => {
  assert.deepEqual([hlCoinOf('BTC-USD'), hlCoinOf('ETH-USD'), sodexSymbolOf('BTC'), sodexSymbolOf('ETH')], ['BTC', 'ETH', 'BTC-USD', 'ETH-USD']);
  assert.equal(leaderVenueOf(undefined), 'sodex');
  assert.equal(leaderVenueOf(''), 'sodex');
  assert.equal(leaderVenueOf(' Hyperliquid '), 'hyperliquid');
  assert.throws(() => leaderVenueOf('binance'), /LIVE_LEADER_VENUE must be sodex or hyperliquid/);
  assert.deepEqual([leaderKeyName('sodex'), leaderKeyName('hyperliquid')], ['LIVE_LEADER_KEY', 'LIVE_HL_LEADER_KEY']);
});

/* ------------------------------------------------------------------ guard ----- */

test('guard: an IOC, a cancel and a leverage change are signed; nothing else, in no other shape', () => {
  assert.deepEqual([...HL_ALLOWED_ACTIONS], ['order', 'cancel', 'updateLeverage']);
  guardAction(SDK_ORDER);
  guardAction({ type: 'order', orders: [{ ...SDK_ORDER.orders[0]!, r: true }], grouping: 'na' });
  guardAction({ type: 'cancel', cancels: [{ a: 0, o: 91490942035 }] });
  guardAction({ type: 'updateLeverage', asset: 1, isCross: true, leverage: 2 });
  const o = SDK_ORDER.orders[0]!;
  const refused: Array<[string, unknown]> = [
    ['a withdrawal', { type: 'withdraw3', hyperliquidChain: 'Mainnet', signatureChainId: '0xa4b1', amount: '1', time: 1, destination: '0x' + '11'.repeat(20) }],
    ['a transfer', { type: 'usdSend', destination: '0x' + '11'.repeat(20), amount: '1', time: 1 }],
    ['a spot/perps move', { type: 'usdClassTransfer', amount: '1', toPerp: false, nonce: 1 }],
    ['an agent', { type: 'approveAgent', agentAddress: '0x' + '11'.repeat(20), agentName: null, nonce: 1 }],
    ['a builder approval', { type: 'approveBuilderFee', maxFeeRate: '0.1%', builder: '0x' + '11'.repeat(20), nonce: 1 }],
    ['a vault transfer', { type: 'vaultTransfer', vaultAddress: '0x' + '11'.repeat(20), isDeposit: false, usd: 1 }],
    ['a TWAP', { type: 'twapOrder', twap: { a: 0, b: true, s: '1', r: false, m: 5, t: false } }],
    ['a modify', { type: 'batchModify', modifies: [] }],
    ['a trigger order', { type: 'order', orders: [{ ...o, t: { trigger: { isMarket: true, triggerPx: '1', tpsl: 'sl' } } }], grouping: 'na' }],
    ['a GTC order', { type: 'order', orders: [{ ...o, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' }],
    ['an order with a builder', { ...SDK_ORDER, builder: { b: '0x' + '11'.repeat(20), f: 10 } }],
    ['a TP/SL grouping', { ...SDK_ORDER, grouping: 'normalTpsl' }],
    ['a spot asset', { type: 'order', orders: [{ ...o, a: 10_000 }], grouping: 'na' }],
    ['a float price', { type: 'order', orders: [{ ...o, p: 1670.1 }], grouping: 'na' }],
    ['a cloid or other extra field', { type: 'order', orders: [{ ...o, c: '0x' + '00'.repeat(16) }], grouping: 'na' }],
    ['no orders', { type: 'order', orders: [], grouping: 'na' }],
    ['a leverage of 100x', { type: 'updateLeverage', asset: 1, isCross: true, leverage: 100 }],
    ['nothing', null],
  ];
  for (const [what, a] of refused) assert.throws(() => guardAction(a), /refusing to sign a Hyperliquid/, what);
});

/* ------------------------------------------------------------ the wire ----- */

/** A fake Hyperliquid on loopback: info answers from `state`, exchange records each body and answers `exchange`. */
async function fakeHl() {
  const posted: Array<Record<string, any>> = [];
  const asked: string[] = [];
  const state = {
    positions: [] as Array<{ coin: string; szi: string }>,
    orders: [] as Array<{ coin: string; oid: number; isTrigger: boolean }>,
    exchange: { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.0002', avgPx: '60000.5', oid: 777 } }] } } } as unknown,
  };
  const body = (req: IncomingMessage) => new Promise<any>((r) => {
    let s = '';
    req.on('data', (c: Buffer) => (s += c.toString()));
    req.on('end', () => r(JSON.parse(s)));
  });
  const srv = createServer(async (req, res) => {
    const b = await body(req);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/exchange') {
      posted.push(b);
      return void res.end(JSON.stringify(state.exchange));
    }
    asked.push(b.type);
    if (b.type === 'meta') return void res.end(JSON.stringify({ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }, { name: 'kPEPE', szDecimals: 0, maxLeverage: 10 }, { name: 'OLD', szDecimals: 2, maxLeverage: 3, isDelisted: true }] }));
    if (b.type === 'l2Book') return void res.end(JSON.stringify({ coin: b.coin, levels: [[{ px: '60000', sz: '1', n: 1 }], [{ px: '60001', sz: '1', n: 1 }]] }));
    if (b.type === 'clearinghouseState') return void res.end(JSON.stringify({ marginSummary: { accountValue: '123.45' }, assetPositions: state.positions.map((p) => ({ type: 'oneWay', position: p })) }));
    if (b.type === 'frontendOpenOrders') return void res.end(JSON.stringify(state.orders));
    if (b.type === 'userFillsByTime') return void res.end(JSON.stringify([{ coin: 'BTC', px: '60000.5', sz: '0.0002', side: 'B', time: 1_800_000_000_123, oid: 777, crossed: true, fee: '0.0054', tid: 1 }, { coin: 'ETH', px: '3000', sz: '0.01', side: 'A', time: 1_800_000_000_200, oid: 778, crossed: false, fee: '0', tid: 2 }]));
    res.statusCode = 400;
    res.end('{}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const info = new HyperliquidInfo(fetch as never, `${base}/info`);
  const ex = new HyperliquidExchange(SDK_KEY, info, fetch as never, `${base}/exchange`);
  return { srv, posted, asked, state, info, ex };
}

test('exchange: the body the SDK posts (action, nonce, signature, no vault, no expiry), signed over exactly the action sent, by the leader\'s key', async () => {
  const h = await fakeHl();
  try {
    const f = await h.ex.ioc('BTC', true, 0.000159, 60_180.37, false);
    assert.deepEqual(f, { oid: 777, totalSz: 0.0002, avgPx: 60000.5 });
    const b = h.posted[0]!;
    assert.deepEqual(Object.keys(b), ['action', 'nonce', 'signature', 'vaultAddress', 'expiresAfter']);
    assert.equal(b.vaultAddress, null);
    assert.equal(b.expiresAfter, null);
    assert.equal(JSON.stringify(b.action), '{"type":"order","orders":[{"a":0,"b":true,"p":"60180","s":"0.00015","r":false,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"}', 'asset from meta, price and size rounded, the SDK\'s key order');
    assert.ok(Math.abs(b.nonce - Date.now()) < 60_000, 'the nonce is the time in ms');
    const rsv = hexToBytes(`${b.signature.r}${b.signature.s.slice(2)}${Number(b.signature.v).toString(16)}`);
    assert.equal(recoverAddress(l1Digest(b.action, b.nonce), rsv).toLowerCase(), h.ex.address);
    await h.ex.cancel('ETH', [91490942035]);
    await h.ex.updateLeverage('kPEPE', 20, true);
    assert.deepEqual(h.posted.slice(1).map((x) => x.action), [{ type: 'cancel', cancels: [{ a: 1, o: 91490942035 }] }, { type: 'updateLeverage', asset: 2, isCross: true, leverage: 10 }], 'leverage capped at the coin\'s maximum');
    assert.ok(h.posted[2]!.nonce > h.posted[1]!.nonce && h.posted[1]!.nonce > b.nonce, 'nonces never repeat');
    // Hyperliquid's refusals are thrown: an order status error, and a failed action.
    h.state.exchange = { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order could not immediately match against any resting orders. asset=0' }] } } };
    await assert.rejects(h.ex.ioc('BTC', false, 0.0002, 59_000, true), /did not fill the sell of 0.0002 BTC: Order could not immediately match/);
    h.state.exchange = { status: 'err', response: 'User or API Wallet does not exist.' };
    await assert.rejects(h.ex.cancel('BTC', [1]), /Hyperliquid refused the cancel: 200 User or API Wallet does not exist/);
    await assert.rejects(h.ex.ioc('NOPE', true, 1, 1, false), /Hyperliquid lists no perps coin NOPE/);
    // Anything else is refused before it is signed: nothing is posted.
    const n = h.posted.length;
    await assert.rejects(h.ex.send({ type: 'withdraw3', amount: '1' } as never), /refusing to sign/);
    assert.equal(h.posted.length, n);
  } finally {
    h.srv.close();
  }
});

test('Hyperliquid leader: IOCs of at least $10 rounded up to the step, leverage set once per coin, closes reduce-only, flattened on every coin it holds', async () => {
  const h = await fakeHl();
  const lines: string[] = [];
  try {
    const L = new HyperliquidLeader(h.ex, (l) => lines.push(l));
    assert.equal(L.venue, 'hyperliquid');
    assert.equal(L.symbolFor('BTC-USD'), 'BTC');
    assert.deepEqual(await L.preflight(), { account: 'Hyperliquid perps', equity: 123.45 });
    const tr = await L.buyUsd('BTC', 12);
    assert.equal(tr.ref, '777');
    assert.ok(tr.sentAt <= tr.answeredAt);
    await L.buyUsd('BTC', 5);
    const actions = h.posted.map((x) => x.action);
    assert.deepEqual(actions.map((a) => a.type), ['updateLeverage', 'order', 'order'], 'leverage once, before the first trade');
    assert.deepEqual(actions[0], { type: 'updateLeverage', asset: 0, isCross: true, leverage: 2 });
    assert.equal(actions[1].orders[0].s, '0.0002', '$12 at the ask 60001, rounded up to 0.00001');
    assert.equal(actions[1].orders[0].p, '60181', 'the ask plus 30 bp, 5 significant figures');
    assert.equal(actions[2].orders[0].s, '0.00018', 'under the minimum: raised to $10.50');
    h.state.positions = [{ coin: 'BTC', szi: '0.0004' }, { coin: 'kPEPE', szi: '-100' }];
    h.state.orders = [{ coin: 'ETH', oid: 55, isTrigger: true }];
    assert.equal(await L.position('BTC'), 0.0004);
    assert.equal(await L.position('kPEPE'), -100);
    assert.deepEqual(await L.markets(['BTC-USD', 'ETH-USD', '1000PEPE-USD']), ['BTC', 'ETH', 'kPEPE'], 'the test markets as the coins it lists, and every coin it holds or has an order on');
    assert.deepEqual(await L.openOrders('ETH'), [{ orderId: '55', clOrdID: null, stop: true }]);
    await L.close('kPEPE', -100);
    const close = h.posted[h.posted.length - 1]!.action;
    assert.deepEqual(close.orders[0], { a: 2, b: true, p: '60601', s: '100', r: true, t: { limit: { tif: 'Ioc' } } }, 'a short is bought back reduce-only, 1% through the ask');
    const fills = await L.fills('BTC', 1_800_000_000_000);
    assert.deepEqual(fills.map((f) => [f.orderId, f.side, f.qty, f.maker, f.time]), [['777', 'buy', 0.0002, false, 1_800_000_000_123]]);
    assert.deepEqual(lines, []);
  } finally {
    h.srv.close();
  }
});
