/**
 * Pure-logic tests for the account history readers and margin usage.
 *   npx tsx --test src/accountData.test.ts
 *
 * Every fixture row is a real payload shape observed live on mainnet
 * (2026-09-26, public address 0xe290…cb67), trimmed to the fields used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY, collateralSplit, countNew, crossAccountLeverage, crossMarginRatio, flowStatus, formatCollateralRatio, fromUnits, historyQuery,
  mapAccountFlow, mapFundTransfer, marginUsage, rowMarginUsd,
  mergeRows, nextCursor, timeline, toMs, txUrl, type LedgerRow, type TokenBook,
} from './accountData';
import { setNumStyle } from './numStyle';

// These cases are written in the 1,234.56 format; the app's default (1.234,56) has its own tests in numStyle.test.ts.
setNumStyle('comma-dot');

const ME = '0xe290506a7472136df8f49fe1e35d2079a61dcb67';

test('fromUnits is exact and rejects what is not a base-unit integer', () => {
  assert.equal(fromUnits('82386414', 6), '82.386414');
  assert.equal(fromUnits('1000000', 6), '1');
  assert.equal(fromUnits('1000000000000000000000', 18), '1000');
  assert.equal(fromUnits('5', 6), '0.000005');
  assert.equal(fromUnits('0', 6), '0');
  assert.equal(fromUnits('270099000000000000000', 18), '270.099');
  assert.equal(fromUnits('12', 0), '12');
  assert.equal(fromUnits('1.5', 6), null);
  assert.equal(fromUnits('-3', 6), null);
  assert.equal(fromUnits(undefined, 6), null);
});

test('toMs takes seconds or milliseconds', () => {
  assert.equal(toMs(1781342164), 1781342164000);
  assert.equal(toMs(1790450483018), 1790450483018);
  assert.equal(toMs('1781342164'), 1781342164000);
  assert.equal(toMs(0), 0);
  assert.equal(toMs(undefined), 0);
});

test('nextCursor is the oldest creation time of a FULL page, else the end', () => {
  const t = HISTORY.orders.timeOf;
  const page = [{ createdAt: 30 }, { createdAt: 20 }, { createdAt: 25 }];
  assert.equal(nextCursor(page, t, 3), 20);
  assert.equal(nextCursor(page, t, 4), null, 'a short page is the last one');
  assert.equal(nextCursor([{}, {}], t, 2), null, 'no usable time: stop rather than loop');
});

test('the gateway filters endTime inclusively, so the overlap row is merged away by id', () => {
  const spec = HISTORY.positions;
  const first = [
    { id: 18102632, createdAt: 1790450640577 },
    { id: 18102581, createdAt: 1790450630632 },
  ];
  // Exactly what the gateway answered for endTime = 1790450630632.
  const second = [
    { id: 18102581, createdAt: 1790450630632 },
    { id: 18102455, createdAt: 1790450604278 },
  ];
  assert.equal(countNew(first, second, spec.idOf), 1);
  const merged = mergeRows(first, second, spec.idOf, spec.timeOf);
  assert.deepEqual(merged.map((r) => r.id), [18102632, 18102581, 18102455]);
  assert.equal(countNew(merged, second, spec.idOf), 0, 'a page of nothing new stops paging');
});

test('mergeRows keeps the incoming copy of a row (an order that has since filled)', () => {
  const spec = HISTORY.orders;
  const merged = mergeRows(
    [{ orderID: 1, createdAt: 10, status: 'NEW' }],
    [{ orderID: 1, createdAt: 10, status: 'FILLED' }, { orderID: 2, createdAt: 11, status: 'NEW' }],
    spec.idOf, spec.timeOf,
  );
  assert.deepEqual(merged.map((r) => [r.orderID, r.status]), [[2, 'NEW'], [1, 'FILLED']]);
});

test('funding rows are keyed by position and timestamp', () => {
  const f = { symbol: 'BTC-USD', positionID: 18095559, positionSide: 'SHORT', fundingFee: '0.009312723609', feeCoin: 'vUSDC', timestamp: 1790449200023 };
  assert.equal(HISTORY.funding.idOf(f), '18095559:1790449200023:BTC-USD');
  assert.equal(HISTORY.funding.timeOf(f), 1790449200023);
  assert.equal(HISTORY.funding.path('spot', ME), `/api/v1/perps/accounts/${ME}/fundings`, 'funding is perps whatever the engine');
  assert.equal(HISTORY.trades.path('spot', ME), `/api/v1/spot/accounts/${ME}/trades`);
});

test('historyQuery', () => {
  assert.equal(historyQuery(100, null), '?limit=100');
  assert.equal(historyQuery(50, 1790450630632), '?limit=50&endTime=1790450630632');
});

test('a withdrawal carries its destination tx, fee and status', () => {
  const row = mapAccountFlow({
    account: '0xe290506a7472136dF8f49Fe1e35d2079a61Dcb67', amount: '82386414', chain: 'BASE_ETH', coin: 'USDC', decimals: 6,
    displaySymbol: 'USDC', failCode: '', originTxHash: '0x00144c3fa954d049ba29ca0e79f45b7507a9c3cfabc69611778fda89931ff301',
    status: 'Success', statusTime: 1781342229, stmp: 1781342164, token: 'BASE_USDC',
    txHash: '0x513460ca658c001d6fb6f70b030ff9ebf523631f77a92aba6f8ded6a9427414b', type: 'CustodyWithdraw',
    withdrawFee: '1000000', withdrawId: 140308,
  })!;
  assert.equal(row.kind, 'withdraw');
  assert.equal(row.label, 'Withdrawal');
  assert.equal(row.amount, '82.386414');
  assert.equal(row.fee, '1');
  assert.equal(row.coin, 'USDC');
  assert.equal(row.status, 'Completed');
  assert.equal(row.time, 1781342164000);
  assert.equal(row.tx, '0x00144c3fa954d049ba29ca0e79f45b7507a9c3cfabc69611778fda89931ff301');
  assert.equal(row.valueChainTx, '0x513460ca658c001d6fb6f70b030ff9ebf523631f77a92aba6f8ded6a9427414b');
  assert.equal(txUrl(row.txChain, row.tx), 'https://basescan.org/tx/0x00144c3fa954d049ba29ca0e79f45b7507a9c3cfabc69611778fda89931ff301');
});

test('a withdrawal in flight has no destination tx yet', () => {
  const row = mapAccountFlow({ type: 'CustodyWithdraw', status: 'Withdrawing', amount: '5000000', decimals: 6, coin: 'USDC', chain: 'ARBITRUM_ETH', txHash: '0xabc', originTxHash: '', stmp: 1 })!;
  assert.equal(row.status, 'Sending');
  assert.equal(row.state, 'pending');
  assert.equal(row.tx, null);
});

test('withdrawal steps read Requested -> Sending -> Completed | Failed', () => {
  assert.equal(flowStatus('withdraw', 'Requesting').status, 'Requested');
  assert.equal(flowStatus('withdraw', 'Withdrawing').status, 'Sending');
  assert.equal(flowStatus('withdraw', 'Settling').status, 'Sending');
  assert.equal(flowStatus('withdraw', 'Success').status, 'Completed');
  assert.equal(flowStatus('withdraw', 'Failed').state, 'failed');
  assert.equal(flowStatus('deposit', 'Depositing').status, 'Pending');
  assert.equal(flowStatus('deposit', 'Suspicious').state, 'review');
});

test('a deposit links its source-chain transfer', () => {
  const row = mapAccountFlow({
    amount: '1000000000000000000000', chain: 'BSC_BNB', coin: 'USDC', decimals: 18, displaySymbol: 'USDC',
    originTxHash: '0xaf8deb0d9816ac1c517fb6407d119c84c8d332a3258152f8b16e86160f65a13e', status: 'Success',
    statusTime: 1789869893, stmp: 1789869850, token: 'BSC_USDC',
    txHash: '0xaf8deb0d9816ac1c517fb6407d119c84c8d332a3258152f8b16e86160f65a13e', type: 'CustodyDeposit',
  })!;
  assert.equal(row.kind, 'deposit');
  assert.equal(row.amount, '1000');
  assert.equal(row.fee, null);
  assert.equal(txUrl(row.txChain, row.tx), 'https://bscscan.com/tx/0xaf8deb0d9816ac1c517fb6407d119c84c8d332a3258152f8b16e86160f65a13e');
  assert.equal(mapAccountFlow({ type: 'Mystery' }), null);
});

test('ValueChain transfers: stake, reward, EVM <-> Spot', () => {
  const tokens: TokenBook = new Map([['0xusdc', { symbol: 'USDC', decimals: 6 }]]);
  const stake = mapFundTransfer({
    amount: '270099000000000000000', assetAddress: '0x0000000000000000000000000000000000000000', blockTimestamp: 1789292359,
    transferType: -1, txHash: '0x45b27f0d03c3f2984d562f64e679201c383a2d2368f721aa6b01d86badca2172',
    receiver: '0xb04eB6b64137d1673D46731C8f84718092c50B0D', sender: '0xe290506a7472136dF8f49Fe1e35d2079a61Dcb67',
    source: 'native_transfer', actionType: 'stake',
  }, ME, tokens)!;
  assert.equal(stake.label, 'Stake');
  assert.equal(stake.coin, 'SOSO');
  assert.equal(stake.amount, '270.099');
  assert.equal(stake.time, 1789292359000);
  assert.equal(txUrl(stake.txChain, stake.tx), 'https://main-scan.valuechain.xyz/tx/0x45b27f0d03c3f2984d562f64e679201c383a2d2368f721aa6b01d86badca2172');

  const airdrop = mapFundTransfer({ amount: '300000000000000000000', assetAddress: '0x5050505050505050505050505050505050505050', blockTimestamp: 1781335492, transferType: 1, txHash: '0x8f', source: 'fund_transfer', actionType: 'airdrop' }, ME, tokens)!;
  assert.equal(airdrop.label, 'Airdrop');
  assert.equal(airdrop.amount, '300');

  const out = mapFundTransfer({ amount: '2500000', assetAddress: '0xUSDC', blockTimestamp: 5, transferType: 2, txHash: '0x1', source: 'fund_transfer', actionType: '' }, ME, tokens)!;
  assert.equal(out.label, 'Spot → EVM');
  assert.equal(out.amount, '2.5');
  const into = mapFundTransfer({ amount: '2500000', assetAddress: '0xUSDC', blockTimestamp: 5, transferType: 1, txHash: '0x2', source: 'fund_transfer', actionType: '' }, ME, tokens)!;
  assert.equal(into.label, 'EVM → Spot');

  const sent = mapFundTransfer({ amount: '1', assetAddress: '0x0000000000000000000000000000000000000000', blockTimestamp: 5, txHash: '0x3', source: 'native_transfer', actionType: 'transfer', sender: ME.toUpperCase().replace('0X', '0x') }, ME, tokens)!;
  assert.equal(sent.label, 'Sent');
  const unknown = mapFundTransfer({ amount: '1', assetAddress: '0x1234567890123456789012345678901234567890', blockTimestamp: 5, txHash: '0x4', source: 'fund_transfer' }, ME, tokens)!;
  assert.equal(unknown.coin, '0x1234…7890', 'an unlisted token keeps its address, not a guessed name');
});

test('timeline shows only rows no later page can land above', () => {
  const r = (id: string, time: number) => ({ id, time }) as unknown as LedgerRow;
  const flows = { rows: [r('a', 100), r('b', 60)], done: false };
  const vc = { rows: [r('x', 90), r('y', 20)], done: false };
  const t1 = timeline([flows, vc], (x) => x.time);
  // flows has only reached 60: anything older than 60 might still be preceded
  // by an unseen flow row, so y (20) waits.
  assert.deepEqual(t1.rows.map((x) => x.id), ['a', 'x', 'b']);
  assert.deepEqual(t1.pull, [0]);
  assert.equal(t1.more, true);

  const t2 = timeline([{ ...flows, done: true }, vc], (x) => x.time);
  assert.deepEqual(t2.rows.map((x) => x.id), ['a', 'x', 'b', 'y']);
  assert.deepEqual(t2.pull, [1]);

  const t3 = timeline([{ ...flows, done: true }, { ...vc, done: true }], (x) => x.time);
  assert.equal(t3.more, false);
  assert.deepEqual(t3.pull, []);

  const t4 = timeline([{ rows: [], done: false }, vc], (x) => x.time);
  assert.deepEqual(t4.rows, [], 'a source not yet read holds everything back');
  assert.deepEqual(t4.pull, [0]);
});

test('txUrl links only what it can', () => {
  assert.equal(txUrl('XRP', 'ABCDEF'), null);
  assert.equal(txUrl('BASE_ETH', 'not-a-hash'), null);
  assert.equal(txUrl('BASE_ETH', null), null);
});

test('margin usage is (av - am) / av, and equals the four margin holds', () => {
  // A live perps state, trimmed.
  const state = {
    av: '2076.12610668005399999997676', am: '1364.45821621827799999997676',
    im: '0', cm: '29.983006461776', oim: '0', ocm: '681.684884', mm: '3.74810060625',
  };
  const m = marginUsage(state)!;
  assert.ok(Math.abs(m.inUse - 711.6678904617) < 1e-6);
  assert.ok(Math.abs(m.ratio! - 0.342786) < 1e-5);
  assert.ok(Math.abs(m.inUse - (m.positions + m.orders)) < 1e-9, 'av = am + cm + im + oim + ocm when there is no haircut');
  const withAmi = marginUsage({ ...state, ami: '12.5' })!;
  assert.ok(Math.abs(withAmi.available - Number(state.am)) < 1e-6, 'ami is not added on top of am');
  assert.ok(Math.abs(withAmi.inUse - m.inUse) < 1e-6);
  const haircut = marginUsage({ av: '2.254', am: '1.803', cm: '0', im: '0', oim: '0', ocm: '0', haircut: '0.451' })!;
  assert.ok(Math.abs(haircut.inUse) < 1e-9, 'a collateral haircut is equity, not margin in use');
  assert.ok(Math.abs(m.positions - 29.983006461776) < 1e-12);
  assert.ok(Math.abs(m.orders - 681.684884) < 1e-12);
});

test('multi-asset margin is USDC at par plus each other coin at its haircut', () => {
  // wm is SoDEX's own contribution. 1 BTC at index 100000 and 90% is 90000,
  // which is what wm already says. A row without wm is balance × price × ratio.
  assert.equal(rowMarginUsd({ a: 'vUSDC', wb: '1000' }), 1000);
  // Live perps rows: mr "1" is 100%, and wm is the contribution SoDEX already computed.
  assert.equal(rowMarginUsd({ a: 'vUSDC', wb: '1939.701453651631', co: '0', mr: '1', px: '1', wm: '1939.701453651631' }), 1939.701453651631);
  assert.equal(rowMarginUsd({ a: 'vBTC', wb: '1', px: '100000', mr: '90' }), 90000);
  assert.equal(rowMarginUsd({ a: 'vBTC', wb: '1', px: '100000', mr: '0.9' }), 90000);
  assert.equal(rowMarginUsd({ a: 'vETH', wb: '2', wm: '4800' }), 4800);
  // No ratio and no wm: not a guess.
  assert.equal(rowMarginUsd({ a: 'vBTC', wb: '1', px: '100000' }), null);

  const split = collateralSplit([
    { a: 'vUSDC', wb: '1000', wm: '1000' },
    { a: 'vBTC', wb: '1', px: '100000', mr: '90', wm: '90000' },
    { a: 'WSOSO', wb: '0' },
  ]);
  assert.equal(split.usdc, 1000);
  assert.equal(split.multi, 90000);
  assert.equal(split.marginBalance, 91000);

  // One unpriced coin with a balance voids the multi-asset total.
  const gap = collateralSplit([
    { a: 'vUSDC', wb: '10' },
    { a: 'vDOGE', wb: '100', px: '0.1' },
  ]);
  assert.equal(gap.usdc, 10);
  assert.equal(gap.multi, null);
  assert.equal(gap.marginBalance, null);
});

test('collateral ratio labels follow the coins metadata, and USDC with none is 100%', () => {
  assert.equal(formatCollateralRatio(0.9), '90%');
  assert.equal(formatCollateralRatio('0.8'), '80%');
  assert.equal(formatCollateralRatio(1), '100%');
  assert.equal(formatCollateralRatio('1', 'vUSDC'), '100%');
  assert.equal(formatCollateralRatio(90), '90%');
  assert.equal(formatCollateralRatio(0.875), '87.5%');
  assert.equal(formatCollateralRatio(null, 'USDC'), '100%');
  assert.equal(formatCollateralRatio(undefined, 'vUSDC'), '100%');
  assert.equal(formatCollateralRatio(null, 'BTC'), null);
  assert.equal(formatCollateralRatio(0, 'ETH'), null);
  assert.equal(formatCollateralRatio('', 'SOL'), null);
});

test('cross margin ratio is mm/av, and cross leverage ignores isolated positions', () => {
  assert.equal(crossMarginRatio({ mm: '50', av: '1000' }), 0.05);
  assert.equal(crossMarginRatio({ mmr: '0.05', mm: '1', av: '1000' }), 0.05);
  const state = {
    av: '1000',
    P: [
      { s: 'BTC-USD', m: 'CROSS', sz: '0.1' },
      { s: 'ETH-USD', m: 'ISOLATED', sz: '10' },
    ],
  };
  const marks: Record<string, number> = { 'BTC-USD': 80000, 'ETH-USD': 3000 };
  // 0.1 * 80000 / 1000 = 8. Isolated ETH is not in the cross pool.
  assert.equal(crossAccountLeverage(state, (s) => marks[s] ?? null), 8);
  assert.equal(crossAccountLeverage({ av: '1000', P: [{ s: 'BTC-USD', m: 'CROSS', sz: '1' }] }, () => null), null);
  assert.equal(crossAccountLeverage({ av: '1000', P: [] }, () => null), 0);
});

test('margin usage has no ratio without account value, and can exceed 100%', () => {
  assert.equal(marginUsage({ av: '0', am: '0' })!.ratio, null);
  assert.equal(marginUsage(null), null);
  assert.equal(marginUsage({ av: 'x' }), null);
  assert.equal(marginUsage({ av: '100', am: '-20', cm: '120' })!.ratio, 1.2);
});

test('fills: one trade id on two markets is two rows (the id is per market), the inclusive overlap row still one', () => {
  const spec = HISTORY.trades;
  // As the gateway answers: QNT and XPL each have a trade 122066.
  const page = [
    { symbol: 'QNT-USD', tradeID: 122066, orderID: 26740480687, side: 'SELL', price: '237.69', quantity: '0.17', time: 1790965125744 },
    { symbol: 'XPL-USD', tradeID: 122066, orderID: 26740466573, side: 'SELL', price: '0.0947', quantity: '11', time: 1790965125814 },
    // Both sides of a trade against oneself: one trade, two orders.
    { symbol: 'XPL-USD', tradeID: 122067, orderID: 1, side: 'BUY', price: '0.0947', quantity: '5', time: 1790965125900 },
    { symbol: 'XPL-USD', tradeID: 122067, orderID: 2, side: 'SELL', price: '0.0947', quantity: '5', time: 1790965125900 },
  ];
  assert.equal(mergeRows([], page, spec.idOf, spec.timeOf).length, 4, 'no fill is dropped');
  // The next page starts with the row at the boundary again: merged away, nothing else.
  const next = [page[0]!, { symbol: 'QNT-USD', tradeID: 122065, orderID: 26740478488, side: 'SELL', price: '237.72', quantity: '0.09', time: 1790965124889 }];
  assert.equal(countNew(page, next, spec.idOf), 1);
  assert.equal(mergeRows(page, next, spec.idOf, spec.timeOf).length, 5);
  assert.equal(spec.idOf({ orderID: 7, time: 9, quantity: '1' }), '7:9:1', 'without a trade id: order, time and size');
});
