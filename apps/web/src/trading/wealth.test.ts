/**
 * SoDEX Wealth: which route a fund takes, and calldata byte by byte. No network, nothing sent.
 *   npx tsx --test src/trading/wealth.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  SELECTOR, allowanceData, approveData, fundAction, fundLabel, joinHoldings, requestDepositData, requestProblem, requestRedeemData, rfqData,
  type TradingStatus, type VaultFacts,
} from './wealth';

const selector = (sig: string): string =>
  `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex').slice(0, 8)}`;

const OWNER = '0x1111111111111111111111111111111111111111';
const VAULT = '0x9876b381a94876ea8fea56b625e15556fb450629';

test('each selector is the keccak of the documented signature', () => {
  assert.equal(SELECTOR.approve, selector('approve(address,uint256)'));
  assert.equal(SELECTOR.allowance, selector('allowance(address,address)'));
  assert.equal(SELECTOR.requestDeposit, selector('requestDeposit(uint256,address,bytes32,bytes32)'));
  assert.equal(SELECTOR.requestRedeem, selector('requestRedeem(uint256,address,bytes32,bytes32)'));
  assert.equal(SELECTOR.rfqBuy, selector('buy(address,uint256,uint256,uint256,bytes)'));
  assert.equal(SELECTOR.rfqSell, selector('sell(address,uint256,uint256,uint256,bytes)'));
  assert.equal(SELECTOR.getAsset, selector('getAsset()'));
  assert.equal(SELECTOR.minDeposit, selector('getMinDepositAmount()'));
  assert.equal(SELECTOR.minRedeem, selector('getMinRedeemShares()'));
});

const word = (hex: string) => hex.padStart(64, '0');
const addr = (a: string) => word(a.slice(2));

test('a deposit request: assets, receiver, no builder fee, no referral', () => {
  assert.equal(
    requestDepositData(1_000_000n, OWNER),
    `${SELECTOR.requestDeposit}${word('f4240')}${addr(OWNER)}${'0'.repeat(64)}${'0'.repeat(64)}`,
  );
});

test('a redemption request: shares, receiver, no builder fee, no referral', () => {
  assert.equal(
    requestRedeemData(5n * 10n ** 17n, OWNER),
    `${SELECTOR.requestRedeem}${word('6f05b59d3b20000')}${addr(OWNER)}${'0'.repeat(64)}${'0'.repeat(64)}`,
  );
});

test('approve and allowance', () => {
  assert.equal(approveData(VAULT, 5n), `${SELECTOR.approve}${addr(VAULT)}${word('5')}`);
  assert.equal(allowanceData(OWNER, VAULT), `${SELECTOR.allowance}${addr(OWNER)}${addr(VAULT)}`);
  assert.throws(() => approveData('0x12', 5n), /bad address/);
});

test('RFQ calldata encodes the signature as dynamic bytes, right-padded', () => {
  const sig = `0x${'ab'.repeat(65)}`;
  const data = rfqData('buy', VAULT, 10n, 20n, 30n, sig);
  const expected = [
    SELECTOR.rfqBuy,
    addr(VAULT), word('a'), word('14'), word('1e'),
    word('a0'), // offset: five head words
    word('41'), // 65 bytes
    'ab'.repeat(65).padEnd(192, '0'),
  ].join('');
  assert.equal(data, expected);
  assert.equal((data.length - 10) % 64, 0, 'whole words');
  assert.ok(rfqData('sell', VAULT, 1n, 1n, 1n, sig).startsWith(SELECTOR.rfqSell));
  assert.throws(() => rfqData('buy', VAULT, 1n, 1n, 1n, 'nope'), /signature/);
});

const status = (o: Partial<TradingStatus>): TradingStatus => ({
  fundId: 'X', vault: VAULT, channel: 'closed', closedReason: null, nextChannel: null, nextChannelAt: null, rfq: null, batch: null, subscription: null, ...o,
});
const spot = { symbol: 'vQQQ_vUSDC', symbolId: 41, displayName: 'QQQ/USDC', quote: { coin: 'vUSDC', decimals: 6 } };

test('the Quickstart table: what each fund and channel allows', () => {
  const clob = { fundType: 'clob' as const, fundStatus: 'live' as const, spot };
  const vault = { fundType: 'escrow_vault' as const, fundStatus: 'live' as const };
  assert.deepEqual(fundAction(clob, status({ channel: 'clob' })), { kind: 'trade', symbol: 'vQQQ_vUSDC' });
  assert.equal(fundAction(clob, status({ channel: 'closed', closedReason: 'market_closed', nextChannelAt: 9 }))?.kind, 'closed');
  assert.equal(fundAction(clob, null), null, 'not read yet');
  assert.deepEqual(
    fundAction(vault, status({ channel: 'batch', batch: { opensAt: 1, cutoffAt: 2, expectedDeliveryAt: 3 } })),
    { kind: 'batch', cutoffAt: 2, deliveryAt: 3 },
  );
  const rfq = { address: VAULT, quotable: true, pausedByMaker: false, minBuyAmount: '1', minSellAmount: '2', expectedDeliveryAt: 4 };
  assert.deepEqual(fundAction(vault, status({ channel: 'rfq', rfq })), { kind: 'rfq', rfq: VAULT, deliveryAt: 4, minBuy: '1', minSell: '2' });
  assert.equal(fundAction(vault, status({ channel: 'rfq', rfq: { ...rfq, pausedByMaker: true } }))?.kind, 'closed');
  assert.equal(fundAction(vault, status({ channel: 'subscription' }))?.kind, 'external');
  assert.equal(fundAction({ fundType: 'bridged_vault', fundStatus: 'live' }, null)?.kind, 'external', 'its status route answers not found');
});

test('a vault request is refused in words before anything is sent', () => {
  const f: VaultFacts = {
    asset: VAULT, assetDecimals: 6, shareDecimals: 18, minDeposit: 1_000_000n, minRedeem: 500n,
    assetBalance: 5_000_000n, shareBalance: 1000n, gasBalance: 1n, paused: false,
  };
  assert.equal(requestProblem('buy', 2_000_000n, f), null);
  assert.equal(requestProblem('sell', 500n, f), null);
  assert.match(requestProblem('buy', 0n, f)!, /Enter/);
  assert.match(requestProblem('buy', 999_999n, f)!, /minimum/);
  assert.match(requestProblem('buy', 6_000_000n, f)!, /ValueChain/);
  assert.match(requestProblem('sell', 2000n, f)!, /shares/);
  assert.match(requestProblem('buy', 2_000_000n, { ...f, gasBalance: 0n })!, /SOSO/);
  assert.match(requestProblem('buy', 2_000_000n, { ...f, paused: true })!, /paused/);
});

test('SoDEX\'s product names, and a new fund still shows', () => {
  assert.equal(fundLabel({ fundId: 'vBOXX', name: 'vBOXX Fund', fundType: 'clob' }).name, 'US Cash Yield');
  assert.equal(fundLabel({ fundId: 'Morpho-Earn', name: 'x', fundType: 'bridged_vault' }).name, 'USDC Earn');
  assert.deepEqual(fundLabel({ fundId: 'NEW', name: 'New Fund', fundType: 'escrow_vault' }), { name: 'New Fund', shelf: 'Specialty', yield: false });
});

test('holdings: the two reads join on the fund, unpriced funds have no value', () => {
  const positions = [
    { fundId: 'vQQQ', source: 'clob' as const, share: { coin: 'vQQQ', address: VAULT, decimals: 8 }, spotShares: '2', processingCost: '0', pendingProceeds: '0' },
    { fundId: 'CXMT', source: 'vault' as const, coin: 'aCXMT', evmShares: '5', processingCost: '10', pendingProceeds: '3' },
    { fundId: 'dust', source: 'clob' as const, spotShares: '0' },
  ];
  const rows = joinHoldings(null, positions, {
    inFlightValue: '13',
    positions: [
      { fundId: 'vQQQ', source: 'clob', priced: true, marketValue: '1200', shares: '2' },
      { fundId: 'CXMT', source: 'vault', priced: false, shares: '5' },
    ],
  });
  assert.deepEqual(rows.map((r) => r.fundId), ['vQQQ', 'CXMT'], 'by value, empty rows dropped');
  assert.equal(rows[0]!.marketValue, 1200);
  assert.equal(rows[0]!.spotShares, 2);
  assert.equal(rows[1]!.marketValue, null);
  assert.equal(rows[1]!.coin, 'aCXMT');
  assert.equal(rows[1]!.inFlight, 13);
});

test('holdings: SoDEX in-flight total is kept, and an incomplete fund is not valued', () => {
  const rows = joinHoldings(null, [{ fundId: 'A', source: 'clob', spotShares: '1' }], {
    inFlightValue: '7', incompleteFunds: ['A'], positions: [{ fundId: 'A', source: 'clob', priced: true, marketValue: '5' }],
  });
  assert.equal(rows[0]!.inFlight, 7);
  assert.equal(rows[0]!.marketValue, null);
});
