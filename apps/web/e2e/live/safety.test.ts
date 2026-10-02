/**
 * The runner's safety rails, offline: the network guard (plan = read-only,
 * live = only expected writes), config validation, exact decimal sizing, the
 * budget check, and the independent registry decoder.
 *   npx tsx --test e2e/live/safety.test.ts        (from apps/web)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { OutcomeUnknownError, sendSigned } from '../../src/trading/gateway';
import { setTradingConfig } from '../../src/trading/config';
import { BIZ_ORIGIN, RelayRefused, analyseAddress, submitCallForPermit } from '../../src/trading/relay';
import { api } from '../../src/api';
import { CLOB_GATEWAY, SodexApiError, WITHDRAW_TOKEN_TARGET, encodeDepositCmd, encodeWithdrawTokenCmd } from '@sodex-core';
import { validateConfig, DEFAULT_CONFIG } from './config';
import { installGuard, type Guard } from './guard';
import { checkBudget, SafetyStop, type Ctx } from './context';
import { marketQty, restingBuy, type Market } from './plan';
import { decodeDepositWalletList } from './reads';
import { dCmp, dDiv, dMul, lessPct, morePct, toStep, fx, unfx } from './util';

const BACKEND = 'http://127.0.0.1:5180';
const GW = 'https://gw.test';
const RPC = 'https://rpc.valuechain.xyz';
const OWNER = '0x1111111111111111111111111111111111111111';

/** What reached the "network" (the fetch the guard wraps). */
let hits: Array<{ url: string; method: string; body: string | null }> = [];
const realFetch = globalThis.fetch;
let guard: Guard | null = null;

function install(mode: 'plan' | 'live', extra: { blockDepositIssuing?: boolean } = {}): Guard {
  hits = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    hits.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: typeof init?.body === 'string' ? init.body : null });
    if (url.startsWith(RPC)) {
      const body = JSON.parse(String(init?.body));
      const one = (c: { id: number }) => ({ jsonrpc: '2.0', id: c.id, result: '0x1' });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { ok: true } }), { status: 200 });
  }) as typeof fetch;
  guard = installGuard({ mode, backend: BACKEND, gateway: GW, relayer: BIZ_ORIGIN, rpcUrls: [RPC], owner: OWNER, ...extra });
  return guard;
}

afterEach(() => {
  guard?.uninstall();
  guard = null;
  globalThis.fetch = realFetch;
});

const post = (url: string, body: unknown, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('guard: relative /api URLs go to the backend origin; reads pass in plan mode', async () => {
  install('plan');
  const r = await fetch('/api/health');
  assert.equal(r.status, 200);
  assert.equal(hits[0]?.url, `${BACKEND}/api/health`);
  await fetch(`${GW}/api/v1/spot/accounts/${OWNER}/state`);
  assert.equal(hits.length, 2);
});

test('guard, plan mode: EVERY write is refused before it leaves - SoDEX, backend, raw transactions', async () => {
  const g = install('plan');
  const transfer = await post(`${GW}/api/v1/spot/accounts/transfers`, { type: 3 });
  assert.equal(transfer.status, 403);
  assert.match((await transfer.json()).error, /plan mode is read-only/);
  assert.equal((await post(`${GW}/api/v1/spot/exchange`, { type: 'addAPIKey' })).status, 403);
  assert.equal((await post(`${GW}/api/v1/perps/trade/orders`, {}, 'DELETE')).status, 403);
  assert.equal((await post(`${GW}/api/v1/user/${OWNER}/evm-withdraw`, { cmdData: '0x' })).status, 403);
  assert.equal((await post('/api/deposit/prepare', { address: OWNER })).status, 403);
  // JSON-RPC: reads pass, a raw transaction does not (even hidden in a batch).
  const read = await post(RPC, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] });
  assert.equal((await read.json()).result, '0x1');
  const send = await (await post(RPC, { jsonrpc: '2.0', id: 9, method: 'eth_sendRawTransaction', params: ['0x00'] })).json();
  assert.equal(send.id, 9);
  assert.match(send.error.message, /plan mode is read-only/);
  const batch = await (await post(RPC, [{ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_sendRawTransaction', params: ['0x00'] }])).json();
  assert.ok(Array.isArray(batch) && batch.every((x: { error?: unknown }) => x.error));
  assert.deepEqual(hits.map((h) => h.method), ['POST'], 'only the eth_call reached the network');
  assert.equal(g.refusals.length, 7);
});

test('guard: hosts the runner does not know are refused in both modes', async () => {
  install('live');
  assert.equal((await fetch('https://example.com/steal')).status, 403);
  assert.equal(hits.length, 0);
});

test('guard, live mode: a write goes out only when armed, only as often as armed, only if its body matches', async () => {
  const g = install('live');
  const body = { id: 1, fromAccountID: 7, toAccountID: 999, coinID: 0, amount: '2', type: 3 };
  assert.equal((await post(`${GW}/api/v1/spot/accounts/transfers`, body)).status, 403, 'nothing armed');
  const disarm = g.expect({
    kind: 'engine-transfer',
    label: 'Spot -> Perps 2 USDC',
    check: (r) => (r.engine === 'spot' && r.body.type === 3 && r.body.amount === '2' && r.body.toAccountID === 999 ? null : 'not the planned transfer'),
  });
  assert.equal((await post(`${GW}/api/v1/spot/accounts/transfers`, { ...body, amount: '20' })).status, 403, 'wrong amount');
  assert.equal((await post(`${GW}/api/v1/perps/accounts/transfers`, body)).status, 403, 'wrong engine');
  assert.equal((await post(`${GW}/api/v1/spot/accounts/transfers`, body)).status, 200, 'the planned one');
  assert.equal((await post(`${GW}/api/v1/spot/accounts/transfers`, body)).status, 403, 'used up');
  disarm();
  assert.equal(hits.length, 1);
  // Paths the runner never writes to are refused even when something is armed.
  g.expect({ kind: 'order', label: 'x' });
  assert.equal((await post(`${GW}/api/v1/perps/trade/leverage`, {})).status, 403);
  assert.equal((await post(`${GW}/api/v1/spot/accounts/api-keys`, {}, 'DELETE')).status, 403);
});

test('guard: a builder-fee approval goes out only for THIS wallet, only when armed, only with the planned maximum - and never in plan mode', async () => {
  const g = install('live');
  const url = `${GW}/api/v1/user/${OWNER}/builders`;
  const body = { accountID: 7, builderID: 9, maxFeeRate: 50 };
  assert.equal((await post(url, body)).status, 403, 'nothing armed');
  g.expect({
    kind: 'builder-approval',
    label: 'approve builder #9 up to 50',
    check: (r) => (r.body.accountID === 7 && r.body.builderID === 9 && r.body.maxFeeRate === 50 ? null : 'not the planned approval'),
  });
  assert.equal((await post(url, { ...body, maxFeeRate: 2000 })).status, 403, 'a higher maximum than planned');
  assert.equal((await post(url, { ...body, builderID: 10 })).status, 403, 'another builder');
  assert.equal((await post(`${GW}/api/v1/user/0x2222222222222222222222222222222222222222/builders`, body)).status, 403, 'an approval on another account is not a write the runner makes');
  assert.equal((await post(url, body)).status, 200, 'the planned one');
  assert.equal((await post(url, body)).status, 403, 'used up');
  assert.equal(hits.length, 1);
  g.uninstall();
  // Reading the approvals is a plain GET (plan mode may do it); the write is refused there.
  const p = install('plan');
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await post(url, body)).status, 403);
  assert.match(p.refusals[0]?.blocked ?? '', /plan mode is read-only \(builder-approval\)/);
});

const RELAY = `${BIZ_ORIGIN}/biz/mirror/call_for_permit`;
const MINE = '0x2222222222222222222222222222222222222222';
const withdrawCmd = (receiver: string, amount: bigint) => encodeWithdrawTokenCmd({ coinSymbol: 'USDC', chain: 'ARBITRUM_ETH', receiver, amount });
const relayed = (cmdType: string, to: string, cmdData: string) => ({ to, cmdType, cmdData, nonce: '1', deadline: '1', signature: '0x' });

test('guard, live mode: a relayed WithdrawToken is DECODED and its receiver/amount checked - on either channel', async () => {
  const g = install('live');
  g.expect({ kind: 'withdraw-permit', label: 'permit', times: 2, check: (r) => (r.permit?.receiver === MINE && r.permit.amount === 5_000_000n && r.permit.chain === 'ARBITRUM_ETH' ? null : `receiver ${r.permit?.receiver} amount ${r.permit?.amount}`) });
  const bad = await post(RELAY, relayed('WithdrawToken', WITHDRAW_TOKEN_TARGET, withdrawCmd('0x3333333333333333333333333333333333333333', 5_000_000n)));
  assert.equal(bad.status, 403);
  assert.match((await bad.json()).msg, /receiver 0x3333/, 'the relayer shape: RelayRefused reads `msg`');
  assert.equal((await post(RELAY, relayed('WithdrawToken', WITHDRAW_TOKEN_TARGET, withdrawCmd(MINE, 6_000_000n)))).status, 403, 'wrong amount');
  assert.equal((await post(RELAY, relayed('WithdrawToken', CLOB_GATEWAY, withdrawCmd(MINE, 5_000_000n)))).status, 403, 'a WithdrawToken addressed to the wrong contract');
  assert.equal((await post(RELAY, relayed('WithdrawToken', WITHDRAW_TOKEN_TARGET, '0xdead'))).status, 403, 'undecodable');
  assert.equal((await post(RELAY, relayed('Something', WITHDRAW_TOKEN_TARGET, '0x'))).status, 403, 'a command the runner never sends');
  assert.equal((await post(RELAY, relayed('WithdrawToken', WITHDRAW_TOKEN_TARGET, withdrawCmd(MINE, 5_000_000n)))).status, 200);
  // The gateway's older evm-withdraw route meets the same check; another owner's path is refused outright.
  assert.equal((await post(`${GW}/api/v1/user/${MINE}/evm-withdraw`, { cmdData: withdrawCmd(MINE, 5_000_000n) })).status, 403, 'not this wallet\'s path');
  assert.equal((await post(`${GW}/api/v1/user/${OWNER}/evm-withdraw`, { cmdData: withdrawCmd(MINE, 5_000_000n) })).status, 200);
  assert.equal(hits.length, 2);
});

test('guard, live mode: a relayed DepositERC20WithPermit is decoded (token + amount); the address check must be expected for that address', async () => {
  const g = install('live');
  const usdc = '0xcb7f80dff2727c791fa491722c428e6657f7e2c6';
  const dep = (token: string, amount: bigint) => relayed('DepositERC20WithPermit', CLOB_GATEWAY, encodeDepositCmd(token, amount, 1n, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`));
  g.expect({ kind: 'deposit-permit', label: 'deposit', check: (r) => (r.deposit?.token === usdc && r.deposit.amount === 1_000_000n ? null : 'not the planned deposit') });
  assert.equal((await post(RELAY, dep(usdc, 2_000_000n))).status, 403, 'wrong amount');
  assert.equal((await post(RELAY, dep('0x4444444444444444444444444444444444444444', 1_000_000n))).status, 403, 'wrong token');
  assert.equal((await post(RELAY, dep(usdc, 1_000_000n))).status, 200);
  const kyt = `${BIZ_ORIGIN}/biz/mirror/analyse_address`;
  assert.equal((await post(kyt, { address: MINE })).status, 403, 'not expected');
  g.expect({ kind: 'kyt-check', label: 'kyt', check: (r) => (r.body?.address === MINE ? null : 'another address') });
  assert.equal((await post(kyt, { address: OWNER })).status, 403, 'for another address');
  assert.equal((await post(kyt, { address: MINE })).status, 200);
  // The app's own deposit-option read (exchange/deposits.ts - what the backend used to do) passes;
  // a relayer write the runner never makes does not.
  assert.equal((await post(`${BIZ_ORIGIN}/biz/mirror/create_deposit_addresses`, { account: OWNER })).status, 200, 'the app reads its deposit options');
  assert.equal((await post(`${BIZ_ORIGIN}/biz/mirror/replace_deposit_address`, { account: OWNER, chain: 'ETH' })).status, 403, 'relayer writes the runner never makes');
  assert.equal(hits.length, 3);
});

test('guard, plan mode: the relayer is read-only too (maintenance reads pass; permits and address checks do not)', async () => {
  install('plan');
  assert.equal((await fetch(`${BIZ_ORIGIN}/biz/v1/ext-chain/maintenance?coin=USDC`)).status, 200);
  assert.equal((await post(RELAY, relayed('WithdrawToken', WITHDRAW_TOKEN_TARGET, withdrawCmd(MINE, 5_000_000n)))).status, 403);
  assert.equal((await post(`${BIZ_ORIGIN}/biz/mirror/analyse_address`, { address: MINE })).status, 403);
  assert.deepEqual(hits.map((h) => h.method), ['GET']);
});

test('a refused write is a definite NO for the app (SodexApiError / ApiError), never "it may have gone through"', async () => {
  install('plan');
  setTradingConfig({ gateway: GW });
  await assert.rejects(
    sendSigned({ method: 'POST', gatewayPath: '/api/v1/spot/accounts/transfers', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 'transfer'),
    (e: unknown) => e instanceof SodexApiError && !(e instanceof OutcomeUnknownError) && /plan mode is read-only/.test(e.message),
  );
  await assert.rejects(api.prepareDeposit(OWNER, 0, '1'), /plan mode is read-only/);
  // The relayer: RelayRefused (definite) - not OutcomeUnknownError, which would make the app remember an unclear permit.
  await assert.rejects(submitCallForPermit(relayed('WithdrawToken', WITHDRAW_TOKEN_TARGET, withdrawCmd(MINE, 1n)) as never), (e: unknown) => e instanceof RelayRefused && /plan mode is read-only/.test((e as Error).message));
  await assert.rejects(analyseAddress(MINE), RelayRefused);
  assert.equal(hits.length, 0);
});

test('--registry-only: the backend is not even asked for deposit addresses (it would ask SoDEX to issue them)', async () => {
  install('plan', { blockDepositIssuing: true });
  assert.equal((await fetch(`/api/mirror/deposit-options?address=${OWNER}`)).status, 403);
  assert.equal(hits.length, 0);
});

// --- config ---------------------------------------------------------------------------------------

test('config: the defaults are valid; unknown keys warn; "//" keys are comments', () => {
  const ok = validateConfig({});
  assert.deepEqual(ok.errors, []);
  const w = validateConfig({ '//': 'a comment', acknowledgeRealfunds: true, deposit: { chain: 'ARBITRUM_ETH', amount: '20', '// why': 'x', amout: '1' } });
  assert.deepEqual(w.errors, []);
  assert.ok(w.warnings.some((x) => /acknowledgeRealfunds/.test(x)), 'a typo of acknowledgeRealFunds is flagged');
  assert.ok(w.warnings.some((x) => /deposit\.amout/.test(x)));
  assert.equal(w.config.acknowledgeRealFunds, false, 'the typo does not acknowledge anything');
});

test('config: the builder is OFF by default; when set it is validated like the build\'s own settings', () => {
  assert.equal(DEFAULT_CONFIG.builder, null);
  assert.equal(validateConfig({}).config.builder, null);
  assert.equal(validateConfig({ builder: null }).config.builder, null);
  const ok = validateConfig({ builder: { id: 223169, feePerps: 50, feeSpot: 100 } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.config.builder, { id: 223169, feePerps: 50, feeSpot: 100, maxFee: 100, required: false, revokeAtEnd: false });
  assert.deepEqual(validateConfig({ builder: { id: 9, feePerps: 200, maxFee: 2000, required: true, revokeAtEnd: true } }).config.builder, {
    id: 9, feePerps: 200, feeSpot: 0, maxFee: 2000, required: true, revokeAtEnd: true,
  });
  const bad = (b: unknown, why: RegExp) => {
    const r = validateConfig({ builder: b });
    assert.ok(r.errors.some((e) => why.test(e)), `${JSON.stringify(b)} -> ${r.errors.join('; ')}`);
    assert.equal(r.config.builder, null, 'an invalid builder never switches one on');
  };
  bad({ feePerps: 50 }, /builder\.id/);
  bad({ id: 0, feePerps: 50 }, /builder\.id/);
  bad({ id: 9 }, /feePerps or feeSpot above 0/);
  bad({ id: 9, feePerps: 201 }, /builder\.feePerps/);
  bad({ id: 9, feeSpot: 2001 }, /builder\.feeSpot/);
  bad({ id: 9, feePerps: 5.5 }, /whole number/);
  bad({ id: 9, feePerps: '50' }, /builder\.feePerps/);
  bad({ id: 9, feePerps: 50, maxFee: 40 }, /below the fee/);
  bad({ id: 9, feePerps: 50, required: 'yes' }, /builder\.required/);
  bad('223169', /builder must be an object/);
  assert.ok(validateConfig({ builder: { id: 9, feePerps: 50, fee: 1 } }).warnings.some((w) => /builder\.fee/.test(w)), 'a typo is flagged');
});

test('config: amounts must be decimal STRINGS (a JSON number is already a float), words only where allowed', () => {
  const r = validateConfig({ deposit: { amount: 20 }, transfers: { amount: '1e3' }, spotToEvm: { soso: 'all', usdc: 'all' }, withdrawExternal: { amount: 'min' }, evmToSpot: { usdc: '0' } });
  assert.ok(r.errors.some((e) => /deposit\.amount must be a decimal STRING/.test(e)));
  assert.ok(r.errors.some((e) => /transfers\.amount/.test(e)));
  assert.ok(r.errors.some((e) => /spotToEvm\.usdc/.test(e)), '"all" is not allowed for spotToEvm.usdc');
  assert.ok(!r.errors.some((e) => /spotToEvm\.soso/.test(e)), '"all" is allowed for spotToEvm.soso');
  assert.ok(!r.errors.some((e) => /withdrawExternal\.amount/.test(e)), '"min" is allowed for withdrawExternal.amount');
  assert.ok(r.errors.some((e) => /evmToSpot\.usdc must be more than 0/.test(e)));
});

test('config: receivers - named ones must exist, "self" is reserved, memos are digits, the ValueChain "other" receiver is not self', () => {
  const r = validateConfig({
    withdrawExternal: { receiver: 'friend' },
    withdrawValuechainOther: { receiver: 'self' },
    receivers: { self: '0x1', xrp: { address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', memo: '12a' } },
    extraWithdrawals: [{ coin: 'XRP', chain: 'XRP', amount: 'min', receiver: 'nobody' }],
  });
  assert.ok(r.errors.some((e) => /withdrawExternal\.receiver is "friend"/.test(e)));
  assert.ok(r.errors.some((e) => /withdrawValuechainOther\.receiver must name a DIFFERENT address/.test(e)));
  assert.ok(r.errors.some((e) => /receivers\."self"/.test(e)));
  assert.ok(r.errors.some((e) => /receivers\.xrp\.memo must be a string of digits/.test(e)));
  assert.ok(r.errors.some((e) => /extraWithdrawals\[0\]\.receiver is "nobody"/.test(e)));
  const ok = validateConfig({ receivers: { valuechain: '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd', xrp: { address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', noMemo: true } } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.receivers.xrp?.noMemo, true);
});

test('config: the default plan covers USDC and the native coin on Arbitrum, and live needs an explicit acknowledgement', () => {
  assert.equal(DEFAULT_CONFIG.acknowledgeRealFunds, false);
  assert.equal(DEFAULT_CONFIG.withdrawExternal.coin, 'USDC');
  assert.equal(DEFAULT_CONFIG.withdrawExternal.chain, 'ARBITRUM_ETH');
  assert.deepEqual(DEFAULT_CONFIG.extraWithdrawals.map((w) => `${w.coin}@${w.chain}`), ['ETH@ARBITRUM_ETH']);
});

// --- exact decimals and order sizing ---------------------------------------------------------------

test('decimals: exact, never a float - steps, percentages, division', () => {
  assert.equal(lessPct('0.2996', 40), '0.17976');
  assert.equal(morePct('1', 5), '1.05');
  assert.equal(toStep('0.17976', '0.0001', 'floor'), '0.1797');
  assert.equal(toStep('5.843', '0.01', 'ceil'), '5.85');
  assert.equal(toStep('5.84', '0.01', 'ceil'), '5.84');
  assert.equal(dDiv('1', '3', 'ceil'), '0.333333333333333333333333333333333334');
  assert.equal(dMul('0.1', '0.2'), '0.02', 'no 0.020000000000000004');
  assert.equal(unfx(fx('84.0949996')), '84.0949996');
  assert.equal(dCmp('0.30', '0.3'), 0);
});

const market = (o: Partial<Market['sym']> & { bid: string; ask: string; engine?: 'spot' | 'perps' }): Market => ({
  engine: o.engine ?? 'spot',
  bid: o.bid,
  ask: o.ask,
  sym: { id: 4, name: 'WSOSO_vUSDC', displayName: 'SOSO/USDC', baseCoin: 'WSOSO', quoteCoin: 'vUSDC', quoteCoinID: 0, pricePrecision: 4, tickSize: '0.0001', quantityPrecision: 2, stepSize: '0.01', minQuantity: '0.01', minNotional: '1', makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING', sellLimitDownRatio: '0.5', ...o },
});

test('sizing: the resting buy sits inside the price band, on the tick, at the smallest size that clears the minimum notional', () => {
  const m = market({ bid: '0.2996', ask: '0.3' });
  const r = restingBuy(m, 50);
  assert.equal(r.offsetPct, 40, '50 % asked, capped at 80 % of the 50 % band');
  assert.equal(r.price, '0.1797');
  assert.equal(toStep(r.price, '0.0001', 'floor'), r.price, 'on the tick');
  assert.equal(toStep(r.qty, '0.01', 'floor'), r.qty, 'on the step');
  assert.ok(dCmp(dMul(r.price, r.qty), '1.05') >= 0, 'clears min notional x 1.05');
  assert.ok(dCmp(dMul(r.price, dDiv(r.qty, '1')), '1.1') < 0, 'and not much more');
  const perps = market({ engine: 'perps', bid: '84071', ask: '84072', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', minNotional: '10', sellLimitDownRatio: '0.05' });
  const p = restingBuy(perps, 50);
  assert.equal(p.offsetPct, 4, 'a 5 % perps band keeps the order 4 % below the bid');
  assert.equal(p.price, '80708');
});

test('sizing: the smallest market order clears the minimum notional with headroom', () => {
  const q = marketQty(market({ bid: '84071', ask: '84072', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', minNotional: '10' }), 10);
  assert.equal(q, '0.00014');
  assert.ok(dCmp(dMul(q, '84072'), '11') >= 0);
  assert.equal(marketQty(market({ bid: '0.2996', ask: '0.3' }), 20), '4');
});

test('budget: a step that would take the run past maxSpendUsd is refused before anything is sent', () => {
  const ctx = { cfg: { maxSpendUsd: 5 }, spend: { costUsd: 3, sentAwayUsd: 1 } } as unknown as Ctx;
  assert.doesNotThrow(() => checkBudget(ctx, 'withdraw-external', 1));
  assert.throws(() => checkBudget(ctx, 'withdraw-external', 1.01), (e: unknown) => e instanceof SafetyStop && /maxSpendUsd/.test((e as Error).message));
});

// --- the deposit-wallet registry ------------------------------------------------------------------

test('registry: viem\'s decoder reads the live answer the backend\'s own decoder is pinned to (wallets[i][0])', (t) => {
  const file = new URL('../../../server/test/depositWallets.fixture.json', import.meta.url);
  if (!existsSync(file)) return t.skip('apps/server fixture not present');
  const fxj = JSON.parse(readFileSync(file, 'utf8')) as { cases: Record<string, { result: string; chains: string[]; wallets: string[][] }> };
  for (const [coin, c] of Object.entries(fxj.cases)) {
    const got = decodeDepositWalletList(c.result);
    const want = new Map(c.chains.map((ch, i) => [ch.toUpperCase(), c.wallets[i]?.[0]?.trim()] as const).filter((x): x is readonly [string, string] => !!x[1]));
    assert.deepEqual([...got.entries()], [...want.entries()], coin);
  }
  assert.throws(() => decodeDepositWalletList(`0x${'ff'.repeat(64)}`));
});
