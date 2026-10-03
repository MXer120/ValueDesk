/**
 * The runner's own parts, offline and one at a time: the check registry, the
 * fee arithmetic of a fill, the history limiter, the independent terms
 * verifier (against the shared Ed25519 vector), the ledger, the receivers the
 * refusals use, the coverage table, the profiles, the tour's legs and amounts,
 * the chain withdrawals and what cannot be tested, and the summary. (The
 * guard's write kinds and the wallet policies are in safety.test.ts.)
 *   npx tsx --test e2e/live/units.test.ts        (from apps/web)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressProblem, type AddressKind } from '../../src/trading/addresses';
import * as actionsMod from '../../src/trading/actions';
import * as fundsMod from '../../src/trading/funds';
import * as sessionMod from '../../src/trading/session';
import * as builderApprovalMod from '../../src/trading/builderApproval';
import * as termsMod from '../../src/trading/terms';
import * as feeGuardMod from '../../src/trading/feeGuard';
import * as onboardMod from '../../src/trading/onboard';
import { CHECKS, Checks } from './checks';
import { APP_COVERAGE, coverageList } from './coverage';
import { checkFill, fillOk, type Fill } from './fees';
import type { Guard, SentWrite } from './guard';
import { HistoryBlocked, HistoryLimiter, isLimitedHistoryPath } from './history';
import { Ledger } from './ledger';
import { NO_CHECKSUM, SAMPLE_ADDRESS, malformedReceivers } from './refusalSteps';
import { capabilities, parseArgs } from './run';
import { TermsWatch, judgeTerms, termsKeyId, termsMessage, verifyTermsSignature } from './terms';
import { CHAIN_ADDRESS, chainLabel, type ChainRoute, type CoinConfig } from '../../src/trading/funds';
import { chainWithdrawals } from './chainRoutes';
import { DEFAULT_CONFIG, validateConfig, type RunConfig } from './config';
import { applyProfile, profileSteps } from './profiles';
import { memoRuleProblems, notTestable } from './routes';
import { nativeLegAmounts, roundTripAmount, tourPlan, usdcLegAmounts, depositBackProblem, oneWayAmount } from './tour';
import { buildSummary, minimumsBelowFee, type SummaryInput } from './summary';
import { handInstructions, handPlan, handRoutes, isHandActive } from './handBack';
import { ownerWord } from './ownerInput';

const OWNER = '0x1111111111111111111111111111111111111111';
const GW = 'https://gw.test';
const realFetch = globalThis.fetch;
let guard: Guard | null = null;
afterEach(() => {
  guard?.uninstall();
  guard = null;
  globalThis.fetch = realFetch;
});

// --- checks -----------------------------------------------------------------------------------------

test('checks: ids are unique; an undeclared id is a bug that throws; run-time routes get ids of their own', () => {
  assert.equal(new Set(CHECKS.map((c) => c.id)).size, CHECKS.length, 'no id twice');
  const c = new Checks();
  assert.throws(() => c.pass('no-such-check', 'x'), /not declared/);
  const a = c.declareUnique({ id: 'withdraw-usdc-arbitrum_eth', area: 'withdrawals', title: 'a', step: 'withdraw-external' });
  const b = c.declareUnique({ id: 'withdraw-usdc-arbitrum_eth', area: 'withdrawals', title: 'b', step: 'extra-withdrawals' });
  assert.deepEqual([a, b], ['withdraw-usdc-arbitrum_eth', 'withdraw-usdc-arbitrum_eth-2']);
  c.pass('key-enable', 'ok', { x: 1 });
  c.set('key-enable', 'fail', 'later', { y: 2 });
  assert.deepEqual(c.get('key-enable')?.evidence, { x: 1, y: 2 }, 'evidence accumulates');
  const all = c.all((d) => ({ status: 'not-run', detail: `why ${d.id}` }));
  assert.equal(all.find((r) => r.id === 'key-restore')?.detail, 'why key-restore');
  assert.equal(all.find((r) => r.id === 'key-enable')?.status, 'fail');
});

// --- fees ---------------------------------------------------------------------------------------------

const fill = (o: Partial<Fill>): Fill => ({ engine: 'perps', symbol: 'BTC-USD', tradeID: 1, orderID: 2, clOrdID: 'vs-1', side: 'BUY', price: '84072', quantity: '0.00014', fee: '0', builderFee: '0', feeCoin: 'vUSDC', isMaker: false, time: 1, source: 'history', ...o });
const PERPS_RATES = [{ source: "the account's", rates: { taker: '0.0004', maker: '0.00012' } }];

test('fees: a perps taker fill with a 2 bp builder fee is judged right; the approved maximum instead of the order\'s fee is caught', () => {
  // notional 11.77008: commission 4 bp = 0.004708, builder 2 bp = 0.002354 -> fee 0.007062
  const ok = checkFill(fill({ fee: '0.007062', builderFee: '0.002354' }), { builderRate: 20, rates: PERPS_RATES, quoteCoin: 'vUSDC', baseCoin: 'BTC', label: 'x' });
  assert.ok(fillOk(ok), [...ok.commissionProblems, ...ok.builderProblems].join('; '));
  // Charged at 10 bp (an approval of 100) although the order carried 20 (2 bp).
  const wrong = checkFill(fill({ fee: '0.016478', builderFee: '0.01177' }), { builderRate: 20, rates: PERPS_RATES, quoteCoin: 'vUSDC', baseCoin: 'BTC', label: 'x' });
  assert.match(wrong.builderProblems.join(), /not the order's 2 bp/);
  // Maker rate on a taker fill.
  const maker = checkFill(fill({ fee: '0.001412' }), { builderRate: null, rates: PERPS_RATES, quoteCoin: 'vUSDC', baseCoin: 'BTC', label: 'x' });
  assert.ok(maker.commissionProblems.length > 0);
  // No builder on the order, yet a builder fee on the fill.
  const sneaky = checkFill(fill({ fee: '0.007062', builderFee: '0.002354' }), { builderRate: null, rates: PERPS_RATES, quoteCoin: 'vUSDC', baseCoin: 'BTC', label: 'x' });
  assert.match(sneaky.builderProblems.join(), /none is due/);
});

test('fees: a spot buy pays its commission in the base coin and never a builder fee', () => {
  const spot = [{ source: "the account's", rates: { taker: '0.00065', maker: '0.00035' } }];
  const buy = fill({ engine: 'spot', symbol: 'WSOSO_vUSDC', price: '0.3', quantity: '4', fee: '0.0026', feeCoin: 'WSOSO' });
  assert.ok(fillOk(checkFill(buy, { builderRate: 20, rates: spot, quoteCoin: 'vUSDC', baseCoin: 'WSOSO', label: 'x' })));
  const charged = checkFill({ ...buy, builderFee: '0.00024' }, { builderRate: 20, rates: spot, quoteCoin: 'vUSDC', baseCoin: 'WSOSO', label: 'x' });
  assert.match(charged.builderProblems.join(), /spot buy/);
});

// --- history -----------------------------------------------------------------------------------------

test('history: one read per gap over both routes, one admission per read, none while blocked; the last read survives a restart', async () => {
  let now = 1_000_000;
  const slept: number[] = [];
  const file = join(mkdtempSync(join(tmpdir(), 'vs-hist-')), 'h.json');
  const h = new HistoryLimiter({ minGapMs: 35_000, stateFile: file, now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
  assert.match(h.admit() ?? '', /limiter/, 'nothing admitted outside a read');
  let inside: Array<string | null> = [];
  await h.run('a', async () => {
    inside = [h.admit(), h.admit()];
  });
  assert.deepEqual(inside.map((x) => x === null), [true, false], 'exactly one request per read');
  await h.run('b', async () => undefined);
  assert.deepEqual(slept, [35_000], 'the second read waited out the gap');
  h.block('the verifier reads');
  await assert.rejects(h.run('c', async () => undefined), HistoryBlocked);
  assert.match(h.admit() ?? '', /verifier/);
  h.unblock();
  h.touch(now + 10_000);
  assert.equal(h.waitLeft(), 45_000, 'a read by someone else on this IP counts too');
  const again = new HistoryLimiter({ stateFile: file, now: () => now + 10_000 });
  assert.equal(again.waitLeft(), 35_000, 'the time of the last read is kept on disk');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).last, now + 10_000);
  assert.ok(isLimitedHistoryPath(`/api/v1/perps/accounts/${OWNER}/trades`) && isLimitedHistoryPath(`/api/v1/spot/accounts/${OWNER}/orders/history`));
  assert.ok(!isLimitedHistoryPath(`/api/v1/spot/accounts/${OWNER}/orders`));
});

// --- the independent terms verifier ---------------------------------------------------------------------

const VECTOR = (() => {
  const f = new URL('../../../server/test/builderTerms.vector.json', import.meta.url);
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as { publicKey: string; keyId: string; vectors: Array<{ fields: Parameters<typeof termsMessage>[0]; message: string; sig: string }> };
  } catch {
    return null;
  }
})();

test('terms: the runner\'s verifier reproduces the shared vector byte for byte', (t) => {
  if (!VECTOR) return t.skip('apps/server/test/builderTerms.vector.json not present');
  assert.equal(termsKeyId(VECTOR.publicKey), VECTOR.keyId);
  for (const v of VECTOR.vectors) {
    assert.equal(termsMessage(v.fields), v.message);
    assert.ok(verifyTermsSignature(v.message, v.sig, VECTOR.publicKey));
    assert.ok(!verifyTermsSignature(v.message.replace('perps:', 'perps:1'), v.sig, VECTOR.publicKey), 'a changed fee breaks it');
  }
});

test('terms: an answer is judged as the app must judge it; only verified, unexpired statements allow a lower fee', (t) => {
  if (!VECTOR) return t.skip('vector not present');
  const v = VECTOR.vectors[0]!;
  const f = v.fields;
  const body = { ok: true, chain: f.chain, builderId: f.builderId, address: f.address, fee: { perps: f.perps, spot: f.spot }, nonce: f.nonce, issued: f.issued, ttl: f.ttl, keyId: VECTOR.keyId, sig: v.sig, volume: { totalUsd: 12 }, flags: [] };
  const x = { address: f.address, nonce: f.nonce, builderId: f.builderId, chainId: f.chain, keys: [VECTOR.publicKey], defaults: { perps: 20, spot: 20 }, receivedAt: 0 };
  assert.ok(judgeTerms(200, body, x).verified);
  assert.match(judgeTerms(200, { ...body, fee: { perps: 10, spot: 20 } }, x).problems.join(), /does not verify/);
  assert.match(judgeTerms(200, body, { ...x, nonce: 'BBBBBBBBBBBBBBBBBBBBBB' }).problems.join(), /nonce/);
  assert.match(judgeTerms(200, body, { ...x, defaults: { perps: 10, spot: 20 } }).problems.join(), /above the default/);
  assert.ok(judgeTerms(200, { ...body, sig: null, keyId: null }, x).unsigned);
  assert.ok(judgeTerms(200, { ok: true, builderId: null }, x).off);
  assert.ok(!judgeTerms(200, { ok: false, code: 'unavailable' }, x).verified);
  let now = 1000;
  const w = new TermsWatch({ owner: f.address, builderId: f.builderId, chainId: f.chain, keys: [VECTOR.publicKey], defaults: { perps: 20, spot: 20 }, now: () => now });
  const url = new URL(`http://x/api/vs/builder/terms?address=${f.address}&nonce=${f.nonce}`);
  w.observe(url, 200, JSON.stringify(body));
  assert.deepEqual(w.allowedFees('perps'), [20, 15]);
  now += f.ttl + 1;
  assert.deepEqual(w.allowedFees('perps'), [20], 'expired: the default only');
  assert.equal(w.observe(new URL('http://x/api/vs/builder/terms?address=0x2222222222222222222222222222222222222222&nonce=x'), 200, '{}'), null, 'another wallet says nothing');
});

// --- the ledger -----------------------------------------------------------------------------------------

test('ledger: a stream push that beats SoDEX\'s answer is merged into the order; a finished history row does not erase the builder seen', () => {
  const l = new Ledger();
  l.noteRecord('perps', { i: 5, c: 'vs-a', X: 'FILLED', z: '1', v: '10', b: { i: 9, f: 20 } }, 'stream');
  assert.equal(l.orders[0]!.origin, 'sodex');
  const w: SentWrite = { kind: 'order', engine: 'perps', tag: 't', label: 'an order', body: { accountID: 1, symbolID: 1, orders: [{ clOrdID: 'vs-a', side: 1, type: 2, quantity: '1' }], builder: { id: 9, fee: 20 } }, status: 200, responseText: JSON.stringify({ code: 0, data: [{ code: 0, clOrdID: 'vs-a', orderID: 5 }] }), at: 1, direct: false };
  l.noteOrderRequest(w, 'app');
  assert.equal(l.orders.length, 1, 'one order, not two');
  const o = l.orders[0]!;
  assert.deepEqual([o.origin, o.tag, o.status, o.executedQty, o.builder?.fee, o.recordBuilder?.fee], ['app', 't', 'FILLED', '1', 20, 20]);
  l.noteRecord('perps', { orderID: 5, status: 'FILLED', executedQty: '1' }, 'history');
  assert.equal(l.orders[0]!.recordBuilder?.fee, 20, 'the history row names no builder - that says nothing');
});

// --- receivers -------------------------------------------------------------------------------------------------

test('receivers: every sample address is valid for its format, and every malformed one is refused by the app\'s own check', () => {
  for (const kind of Object.keys(SAMPLE_ADDRESS) as AddressKind[]) {
    assert.equal(addressProblem(kind, SAMPLE_ADDRESS[kind]), null, `${kind} sample ${SAMPLE_ADDRESS[kind]}`);
    for (const bad of malformedReceivers(kind)) assert.notEqual(bad.address.trim() ? addressProblem(kind, bad.address) : 'format', null, `${kind}: ${bad.what} "${bad.address}" passes`);
    if (!NO_CHECKSUM.has(kind)) assert.ok(malformedReceivers(kind).some((b) => b.what === 'one character mistyped'));
  }
});

// --- coverage and the command line -------------------------------------------------------------------------------

test('coverage: every function the app\'s trading and funds layer exports is mapped to checks, or marked with why not', () => {
  const mods: Record<string, Record<string, unknown>> = { actions: actionsMod, funds: fundsMod, session: sessionMod, builderApproval: builderApprovalMod, terms: termsMod, feeGuard: feeGuardMod, onboard: onboardMod };
  const known = new Set(CHECKS.map((c) => c.id));
  for (const [name, mod] of Object.entries(mods)) {
    const table = APP_COVERAGE[name] ?? {};
    for (const [fn, v] of Object.entries(mod)) {
      if (typeof v !== 'function' || /^[A-Z]/.test(fn)) continue;
      assert.ok(fn in table, `${name}.${fn} is exported by the app but not in coverage.ts`);
    }
    for (const [fn, cov] of Object.entries(table)) {
      if ('checks' in cov) for (const id of cov.checks) assert.ok(id.endsWith('*') || known.has(id), `${name}.${fn}: unknown check ${id}`);
    }
  }
  assert.ok(coverageList().length > 60);
});

test('command line: --profile, --only with the old "orders" name, and capabilities as one JSON line', () => {
  const a = parseArgs(['plan', '--profile', 'core', '--only', 'orders,refusals']);
  assert.ok(typeof a !== 'string');
  assert.deepEqual(a.only, ['orders-spot', 'orders-perps', 'refusals']);
  assert.match(String(parseArgs(['plan', '--profile', 'nope'])), /unknown profile/);
  assert.match(String(parseArgs(['plan', '--only', 'nope'])), /unknown step/);
  const c = capabilities() as { steps: string[]; profiles: string[]; flags: string[]; coverage: unknown[] };
  assert.ok(c.steps.includes('cross-check') && c.profiles.includes('core') && c.flags.includes('--profile') && c.coverage.length > 0);
});

test('config.example.json is a valid config with no unknown keys, and its builder example is one too', async () => {
  const { validateConfig } = await import('./config');
  const raw = JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const r = validateConfig(raw);
  assert.deepEqual([...r.errors, ...r.warnings], []);
  const b = validateConfig({ ...raw, builder: { id: 12345, address: '0x00000000000000000000000000000000000b1d00', feePerps: 20, feeSpot: 20, maxFee: 20, required: true, revokeAtEnd: true, termsKeys: ['A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg'] } });
  assert.deepEqual([...b.errors, ...b.warnings], []);
});

// --- profiles, the tour, the other chains ----------------------------------------------------------------------

test('profiles: core leaves the wider steps out, evm-tour adds the tour, all-chains adds the other chains, builder-rerun is the fee test alone', () => {
  const core = profileSteps('core');
  for (const s of ['evm-tour', 'chain-withdrawals', 'manual-deposits']) assert.ok(!core.includes(s as never), s);
  assert.deepEqual(profileSteps('evm-tour').filter((s) => !core.includes(s)), ['evm-tour']);
  assert.deepEqual(profileSteps('all-chains').filter((s) => !core.includes(s)), ['evm-tour', 'chain-withdrawals', 'manual-deposits']);
  assert.deepEqual(profileSteps('builder-rerun'), ['enable-trading', 'builder-tiers', 'cross-check', 'revoke-builder']);
  const cfg = structuredClone(DEFAULT_CONFIG);
  assert.deepEqual(applyProfile(cfg, 'core'), []);
  assert.equal(applyProfile(cfg, 'builder-rerun').length, 1);
  assert.equal(cfg.allowExistingAccount, true, 'builder-rerun runs on the existing test account');
  const c = capabilities() as { profiles: string[]; profileInfo: Array<{ name: string; steps: string[] }> };
  assert.deepEqual(c.profiles, ['core', 'evm-tour', 'all-chains', 'builder-rerun'], 'no profile creates a builder account');
  assert.ok(c.profileInfo.every((p) => p.steps.length > 0));
  assert.ok(typeof parseArgs(['plan', '--profile', 'all-chains']) !== 'string');
  assert.match(String(parseArgs(['plan', '--profile', 'builder-setup'])), /unknown profile/);
});

test('config: the wider profiles\' sections are validated', async () => {
  const { validateConfig } = await import('./config');
  const ok = validateConfig({ evmTour: { chains: ['BASE_ETH'], skip: ['ETH'], sellBack: false }, chainWithdrawals: { skip: ['BTC'], buyIfMissing: false }, manualDeposits: [{ coin: 'SOL', chain: 'SOL', amount: '0.03' }] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.config.evmTour, { chains: ['BASE_ETH'], skip: ['ETH'], sellBack: false });
  assert.match(validateConfig({ evmTour: { chains: 'some' } }).errors.join(), /evmTour\.chains/);
  assert.match(validateConfig({ manualDeposits: [{ coin: 'SOL', chain: 'SOL', amount: 0.03 }] }).errors.join(), /decimal STRING/);
  assert.match(validateConfig({ manualDeposits: [{ coin: 'SOL', chain: 'SOL', amount: '1' }, { coin: 'sol', chain: 'SOL', amount: '2' }] }).errors.join(), /twice/);
  assert.match(validateConfig({ chainWithdrawals: { skip: ['bad key'] } }).errors.join(), /chain key/);
});

const route = (key: string, o: Partial<ChainRoute> = {}): ChainRoute => ({
  key,
  label: chainLabel(key),
  addressKind: CHAIN_ADDRESS[key] ?? 'other',
  memo: key === 'XRP' || key === 'XLM' ? 'numeric' : null,
  withdrawType: 0,
  tokenAddress: null,
  isNativeToken: false,
  deposit: { allowed: true, min: '5', etaSeconds: null },
  withdraw: { allowed: true, min: '5', fee: '1' },
  ...o,
});
const coinOf = (name: string, dp: number, chains: ChainRoute[], assetId = 1): CoinConfig => ({ coin: name, asset: `v${name}`, assetId, valuechain: { token: '0x00000000000000000000000000000000000000c0', symbol: `v${name}`, decimals: dp, native: false }, chains });
const native = (key: string, dep: string, wd: string, fee: string) => route(key, { isNativeToken: true, deposit: { allowed: true, min: dep, etaSeconds: null }, withdraw: { allowed: true, min: wd, fee } });

test('tour amounts: what goes out clears the deposit minimum (+2 %) when it comes back, with the gas kept back; a round trip never withdraws a minimum the fee eats', () => {
  // Every deposit back is SoDEX's deposit minimum + 2 %: a minimum read hours earlier, or applied as "more than", still credits it.
  assert.deepEqual(usdcLegAmounts(route('ARBITRUM_ETH'), '1'), { withdraw: '6.1', back: '5.1' });
  assert.deepEqual(usdcLegAmounts(route('MATIC', { withdraw: { allowed: true, min: '2', fee: '1' } }), '1'), { withdraw: '6.1', back: '5.1' });
  const eth = coinOf('ETH', 18, []);
  assert.deepEqual(nativeLegAmounts(native('ARBITRUM_ETH', '0.0015', '0.0015', '0.0005'), eth, '0.0005', '0.0002'), { withdraw: '0.00223', back: '0.00153' });
  // BNB: SoDEX's withdrawal minimum (0.0005) is below its fee (0.002) - the leg withdraws enough to come back.
  assert.deepEqual(nativeLegAmounts(native('BSC_BNB', '0.005', '0.0005', '0.002'), coinOf('BNB', 18, []), '0.002', '0.0005'), { withdraw: '0.0076', back: '0.0051' });
  // Arc: USDC is the native coin, 6 decimals on SoDEX (the tour runs it one-way: SoDEX issues no USDC deposit address there).
  assert.deepEqual(nativeLegAmounts(native('ARC', '5', '5', '1'), coinOf('USDC', 6, []), '1', '0.05'), { withdraw: '6.15', back: '5.1' });
  assert.equal(oneWayAmount(native('ARC', '5', '5', '1'), coinOf('USDC', 6, []), '1'), '5');
  // The way back: none on a route SoDEX issues no address on, none on a chain missing while the coin has addresses elsewhere.
  const arcLeg = { chain: 'ARC', label: 'Arc', coin: coinOf('USDC', 6, []) };
  assert.match(depositBackProblem(arcLeg, null) ?? '', /issues no USDC deposit address on Arc/);
  const ethLeg = (chain: string) => ({ chain, label: chain, coin: eth });
  assert.equal(depositBackProblem(ethLeg('BASE_ETH'), new Map([['BASE_ETH', '0xff']])), null);
  assert.equal(depositBackProblem(ethLeg('BASE_ETH'), new Map()), null, 'nothing issued yet (a new wallet): the deposit step asks for it');
  assert.equal(depositBackProblem(ethLeg('BASE_ETH'), null), null, 'unread: the deposit step checks again');
  assert.match(depositBackProblem(ethLeg('ROBINHOOD_ETH'), new Map([['BASE_ETH', '0xff']])) ?? '', /none on ROBINHOOD_ETH/);
  assert.equal(roundTripAmount(native('SOL', '0.03', '0.01', '0.012'), coinOf('SOL', 9, []), '0.012'), '0.042');
  assert.equal(roundTripAmount(native('BTC', '0.00005', '0.0005', '0.00006'), coinOf('BTC', 8, []), '0.00006'), '0.0005');
});

test('tour plan: which chains, which legs, and why the others are left out', () => {
  const usdc = coinOf('USDC', 6, [route('ARBITRUM_ETH', { tokenAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' }), route('MATIC', { tokenAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' }), route('BASE_ETH', { tokenAddress: '0x0000000000000000000000000000000000000bad' }), native('ARC', '5', '5', '1'), route('SOL')], 0);
  const coins = [usdc, coinOf('ETH', 18, [native('ARBITRUM_ETH', '0.0015', '0.0015', '0.0005'), native('ROBINHOOD_ETH', '0.002', '0.002', '0.0005'), native('BASE_ETH', '0.002', '0.0005', '0.0005')], 2), coinOf('AVAX', 18, [{ ...native('AVAXC', '0.35', '0.35', '0.12'), withdraw: { allowed: false, min: '0.35', fee: '0.12' } }], 6)];
  const cfg: RunConfig = { ...structuredClone(DEFAULT_CONFIG), evmTour: { chains: 'all', skip: ['ROBINHOOD_ETH'], sellBack: true } };
  const all = new Set(profileSteps('evm-tour'));
  const t = tourPlan(coins, cfg, all);
  const legs = Object.fromEntries(t.chains.map((c) => [c.chain, c.legs.map((l) => `${l.kind}:${l.skip ? 'skip' : 'run'}`)]));
  assert.deepEqual(legs.ARBITRUM_ETH, ['native:run', 'usdc:skip'], 'USDC on the deposit chain is covered by deposit-external + withdraw-external');
  assert.match(t.chains.find((c) => c.chain === 'ARBITRUM_ETH')!.legs[1]!.skip!, /covered in this run/);
  assert.deepEqual(legs.MATIC, ['usdc:run']);
  assert.ok(t.chains.find((c) => c.chain === 'MATIC')!.ownerGas, 'Polygon: no native route - the owner funds the gas');
  assert.match(t.chains.find((c) => c.chain === 'BASE_ETH')!.legs.find((l) => l.kind === 'usdc')!.skip!, /non-canonical|not the canonical/);
  assert.deepEqual(legs.ARC, ['native:run'], 'Arc: USDC is the native coin');
  assert.match(t.chains.find((c) => c.chain === 'AVAXC')!.legs[0]!.skip!, /withdrawals .* closed/);
  assert.deepEqual(t.left.map((l) => `${l.chain}: ${l.why}`), ['ROBINHOOD_ETH: in evmTour.skip']);
  // Only the chains named; and without withdraw-external the deposit chain's USDC leg runs too.
  const only = tourPlan(coins, { ...cfg, evmTour: { chains: ['ARBITRUM_ETH'], skip: [], sellBack: true } }, new Set(['evm-tour']));
  assert.deepEqual(only.chains.map((c) => c.chain), ['ARBITRUM_ETH']);
  assert.deepEqual(only.chains[0]!.legs.map((l) => l.skip), [null, null]);
});

test('chain withdrawals and what cannot be tested: every route on a chain the runner cannot sign on, each with its reason', () => {
  const coins = [
    coinOf('USDC', 6, [route('SOL')], 0),
    coinOf('SOL', 9, [native('SOL', '0.03', '0.01', '0.012')], 8),
    coinOf('XRP', 6, [native('XRP', '4', '2', '0.8')], 9),
    coinOf('ZEC', 8, [{ ...native('ZEC', '1', '1', '0.1'), deposit: { allowed: false, min: '1', etaSeconds: null }, withdraw: { allowed: false, min: '1', fee: '0.1' } }], 12),
    coinOf('BTC', 8, [{ ...native('BTC', '0.00005', '0.0005', '0.00006'), withdraw: { allowed: false, min: '0.0005', fee: '0.00006' } }], 10),
  ];
  const cfg: RunConfig = { ...structuredClone(DEFAULT_CONFIG), receivers: { sol: { address: SAMPLE_ADDRESS.solana } }, manualDeposits: [{ coin: 'XRP', chain: 'XRP', amount: '4' }] };
  const w = Object.fromEntries(chainWithdrawals(coins, cfg).map((x) => [`${x.coin.coin}@${x.route.key}`, x.skip ?? 'runs']));
  assert.deepEqual(w, {
    'USDC@SOL': 'runs',
    'SOL@SOL': 'runs',
    'XRP@XRP': 'receivers.xrp is not set (your own XRP Ledger address)',
    'ZEC@ZEC': 'the app does not offer Zcash',
    'BTC@BTC': 'BTC withdrawals to Bitcoin are closed on SoDEX right now',
  });
  const nt = Object.fromEntries(notTestable(coins, cfg).map((n) => [n.what, n.why]));
  assert.match(nt['SOL on Solana']!, /deposit: the runner cannot sign on Solana - opt in with manualDeposits/);
  assert.match(nt['SOL on Solana']!, /withdrawal: the arrival cannot be read/);
  assert.ok(!/manualDeposits/.test(nt['XRP on XRP Ledger'] ?? ''), 'XRP is opted into a manual deposit');
  assert.match(nt['BTC on Bitcoin']!, /withdrawal: closed/);
  assert.equal(nt['ZEC on Zcash'], 'the app does not offer this chain at all');
  assert.deepEqual(memoRuleProblems(native('XRP', '4', '2', '0.8')), [], 'the app\'s memo rules for XRP hold');
  assert.deepEqual(memoRuleProblems(native('XLM', '26', '25', '7')), []);
});

// --- the summary ------------------------------------------------------------------------------------------------

const rec = (id: string, area: string, step: string, status: CheckRecordLike['status'], detail: string, evidence: Record<string, unknown> = {}): CheckRecordLike => ({ id, area: area as CheckRecordLike['area'], step: step as CheckRecordLike['step'], title: `title of ${id}`, status, detail, evidence, costUsd: null, at: null });
type CheckRecordLike = SummaryInput['checks'][number];

function summaryInput(o: Partial<SummaryInput> = {}): SummaryInput {
  return {
    mode: 'live',
    profile: 'core',
    wallet: OWNER,
    exitCode: 0,
    startedAt: '2026-10-03T10:00:00.000Z',
    finishedAt: '2026-10-03T10:30:00.000Z',
    checks: [
      rec('builder-fee-lowered', 'builder', 'builder-tiers', 'pass', 'the next order carried 15'),
      rec('builder-fee-default', 'builder', 'builder-tiers', 'pass', 'the first orders carried 20'),
      rec('builder-replace-keeps-builder', 'builder', 'orders-spot', 'finding', 'SoDEX keeps the builder on a replace - set REPLACE_KEEPS_BUILDER = true'),
      rec('perps-limit-rest', 'orders-perps', 'orders-perps', 'pass', 'rests'),
      rec('spot-fok-fillable', 'orders-spot', 'orders-spot', 'finding', 'FOK is not supported'),
      rec('key-enable', 'keys', 'enable-trading', 'pass', 'one signature'),
      rec('refuse-quantity-rounds-to-zero', 'refusals', 'refusals', 'pass', 'refused before signing'),
      rec('transfer-spot-to-perps', 'transfers', 'transfers', 'fail', 'Perps did not rise'),
      rec('withdraw-eth-base_eth', 'withdrawals', 'evm-tour', 'pass', 'arrived on Base'),
      rec('route-bnb-bsc_bnb', 'routes', 'preflight', 'finding', 'min below fee', { minBelowFee: { coin: 'BNB', chain: 'BSC_BNB', label: 'BNB Smart Chain', min: '0.0005', fee: '0.002' } }),
      rec('route-eth-base_eth', 'routes', 'preflight', 'finding', 'min equals fee', { minBelowFee: { coin: 'ETH', chain: 'BASE_ETH', label: 'Base', min: '0.0005', fee: '0.0005' } }),
      rec('cross-end-state', 'cross-checks', 'cross-check', 'pass', 'nothing open'),
    ],
    chains: [{ chain: 'BSC_BNB', label: 'BNB Smart Chain', coin: 'BNB', native: true, deposit: { status: 'pass', detail: '' }, withdraw: { status: 'not-run', detail: 'not part of this run' }, route: { status: 'finding', detail: 'min below fee' } }],
    feeTable: [{ order: 'perps market buy', symbol: 'BTC-USD', side: 'BUY', liquidity: 'taker', quantity: '0.00014', price: '84072', notional: '11.77', commission: '0.0047 vUSDC', commissionRate: '4 bp', builderFee: '0.0023', builderFeeRate: '2 bp', orderBuilderFee: '2 bp', verdict: 'ok' }],
    termsSeen: [
      { at: 1, verified: true, fee: { perps: 20, spot: 20 }, flags: [] },
      { at: 2, verified: true, fee: { perps: 20, spot: 20 }, flags: [] },
      { at: 3, verified: true, fee: { perps: 15, spot: 20 }, flags: [] },
      { at: 4, verified: true, fee: { perps: 20, spot: 20 }, flags: ['underpaid'] },
    ],
    spend: { costUsd: 3.2, sentAwayUsd: 1 },
    maxSpendUsd: 8,
    builder: { id: 223169, feePerps: 20, feeSpot: 20 },
    steps: [],
    whereFunds: ['  SoDEX Spot               vUSDC 12.5', '  Open orders              none'],
    inFlight: [],
    plan: { problems: [], notTestable: [{ what: 'BTC on Bitcoin', why: 'deposit: the runner cannot sign on Bitcoin' }] },
    ...o,
  };
}

test('summary: the builder fee comes first, under a heading that names fees - with the fee of every fill under it; then failures, findings, chains, orders, the key, refusals, funds, cost, the coins', () => {
  const md = buildSummary(summaryInput());
  const heads = md.split('\n').filter((l) => /^##\s/.test(l));
  assert.deepEqual(heads, [
    '## Builder fee and the fee of every fill',
    '## Failed checks',
    '## Findings (how SoDEX or the app behaved - for you to decide on, not failures)',
    '## Chains',
    '## Order types',
    '## The trading key',
    '## Refusals (nothing here may move anything)',
    '## Transfers, deposits and withdrawals',
    '## Cross-check',
    '## Cost',
    '## Where every coin is',
  ]);
  // What the guided launcher takes as the runner's fee table: the first section whose heading names fees.
  const lines = md.split('\n');
  const first = lines.findIndex((l) => /^#{1,6}\s.*\bfees?\b/i.test(l));
  assert.equal(lines[first], '## Builder fee and the fee of every fill');
  const section = lines.slice(first + 1, lines.findIndex((l, i) => i > first && /^##\s/.test(l))).join('\n');
  assert.ok(section.indexOf('builder-fee-default') < section.indexOf('builder-fee-lowered'), 'in the contract\'s order, not the record\'s');
  assert.match(section, /perps 20 \/ spot 20 -> perps 15 \/ spot 20 -> perps 20 \/ spot 20/);
  assert.match(section, /Flags the server set on this wallet: underpaid/);
  assert.match(section, /### Fee of every fill[\s\S]*\| perps market buy \| BTC-USD \| BUY \| taker/);
  assert.match(md, /## Failed checks\n\n\| check \| what was seen \|\n\|---\|---\|\n\| transfer-spot-to-perps \| Perps did not rise \|/);
  assert.match(md, /Spent \$3\.20 in costs .* \+ \$1\.00 sent to your other addresses = \$4\.20 \(maxSpendUsd \$8\.00\)/);
  assert.match(md, /```\nSoDEX Spot +vUSDC 12\.5/);
  assert.match(md, /- \*\*BTC on Bitcoin\*\*: deposit: the runner cannot sign on Bitcoin/);
  assert.match(md, /\| withdraw-eth-base_eth \| PASS \| arrived on Base \|/, 'the tour legs have their own table');
});

test('summary: a withdrawal minimum that does not cover the fee is said in the owner\'s words, at the top of the findings', () => {
  const md = buildSummary(summaryInput());
  const f = md.slice(md.indexOf('## Findings'));
  assert.ok(f.indexOf('### Withdrawal minimums that do not cover the fee') < f.indexOf('| check |'), 'before the findings table');
  const lines = minimumsBelowFee(summaryInput().checks);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /\*\*BNB to BNB Smart Chain\*\*: minimum 0\.0005 BNB, fee 0\.002 BNB\. A user who withdraws the minimum - or anything up to 0\.002 BNB - would receive nothing/);
  assert.match(lines[0]!, /The app's Withdraw sheet stops it before anything is signed \("The amount must be more than the 0\.002 BNB fee"\)/);
  assert.match(lines[1]!, /\*\*ETH to Base\*\*: minimum 0\.0005 ETH, fee 0\.0005 ETH\. A user who withdraws exactly the minimum would receive nothing/);
  // A plan, no builder, nothing found: plain words, no empty tables pretending otherwise.
  const plan = buildSummary(summaryInput({ mode: 'plan', builder: null, checks: [], feeTable: [], termsSeen: [], whereFunds: null }));
  assert.match(plan, /PLAN \(nothing was signed or sent\)/);
  assert.match(plan, /No builder was configured for this run/);
  assert.match(plan, /No fills were recorded\./);
  assert.match(plan, /Plan mode: nothing moved\./);
  assert.ok(!/### Withdrawal minimums/.test(plan));
});

test('capabilities: the route kinds and the chains the runner signs on', () => {
  const c = capabilities() as { routeKinds: Array<{ id: string; steps: readonly string[] }>; chains: Array<{ key: string; chainId: number; source: string }> };
  assert.deepEqual(c.routeKinds.map((k) => k.id), ['route-<coin>-<chain>', 'deposit-<coin>-<chain>', 'withdraw-<coin>-<chain>', 'manual-deposit-<coin>-<chain>']);
  assert.ok(c.routeKinds.every((k) => k.steps.length > 0));
  assert.deepEqual(c.chains.filter((x) => x.source === 'runner').map((x) => `${x.key}:${x.chainId}`), ['ARC:5042', 'AVAXC:43114', 'HYPEREVM_HYPE:999', 'ROBINHOOD_ETH:4663']);
});

// --- the full test: deposits the owner sends back by hand -----------------------------------------------

test('hand-sent deposits: what arrives covers the deposit back, the wallet fee and what the chain keeps - never below the deposit minimum', () => {
  const sol = coinOf('SOL', 9, [native('SOL', '0.03', '0.01', '0.012')]);
  const xrp = coinOf('XRP', 6, [native('XRP', '4', '2', '0.8')]);
  const btc = coinOf('BTC', 8, [native('BTC', '0.00005', '0.0005', '0.00006')]);
  const ton = coinOf('TON', 9, [native('TON', '3', '3', '0.8')]);
  const usdcSol = coinOf('USDC', 6, [route('SOL', { tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })], 0);
  const plain = { market: true, nativeCoin: 'X', nativeCarriesFees: false, tokenSends: 0 };
  // XRP: 4 back + 0.00002 fee + the 1 XRP reserve arrive; the reserve stays with the owner.
  const x = handPlan(xrp.chains[0]!, xrp, '0.8', { ...plain, nativeCoin: 'XRP' });
  assert.deepEqual([x.withdraw, x.arrives, x.sendBack, x.keep, x.needFirst], ['5.80002', '5.00002', '4', '1', '0']);
  // SOL carrying the fees of two token sends (USDC, USDT on Solana).
  const s = handPlan(sol.chains[0]!, sol, '0.012', { ...plain, nativeCoin: 'SOL', nativeCarriesFees: true, tokenSends: 2 });
  assert.deepEqual([s.withdraw, s.sendBack], ['0.047001', '0.03']);
  // BTC: the withdrawal minimum dominates - the owner sends back what arrived less the fee.
  const b = handPlan(btc.chains[0]!, btc, '0.00006', { ...plain, nativeCoin: 'BTC' });
  assert.deepEqual([b.withdraw, b.arrives, b.sendBack], ['0.0005', '0.00044', '0.00041']);
  // A token send pays its fee in the chain's coin; without a SOL withdrawal the owner brings it.
  const u = handPlan(usdcSol.chains[0]!, usdcSol, '1', { ...plain, nativeCoin: 'SOL' });
  assert.deepEqual([u.withdraw, u.sendBack, u.feeCoin, u.walletFee, u.needFirstFeeCoin], ['6', '5', 'SOL', '0.00205', '0.00205']);
  // TON: no spot market - the owner sends first, enough for the withdrawal back to clear SoDEX's minimum and fee.
  const t = handPlan(ton.chains[0]!, ton, '0.8', { ...plain, market: false, nativeCoin: 'TON' });
  assert.deepEqual([t.order, t.sendBack, t.withdraw, t.arrives, t.needFirst], ['deposit-first', '3.8', '3.8', '3', '3.85']);
  for (const p of [x, s, b, u, t]) assert.ok(Number(p.sendBack) >= Number(p.depositMin), `${p.coin}: ${p.sendBack} >= ${p.depositMin}`);
  // The instructions say it: the minimum, the fee ON TOP, the address.
  const text = handInstructions(x, { address: 'rDeposit', memo: true, index: 1, of: 3, waitMin: 30, arrivedFromRun: true, skipHint: true }).join('\n');
  assert.match(text, /amount \.+ 4 XRP {3}\(SoDEX credits nothing below its deposit minimum of 4 XRP/);
  assert.match(text, /ON TOP/);
  assert.match(text, /memo \/ tag \.\. none/);
  assert.match(text, /1 XRP stays at your address/);
  assert.match(text, /type s and Enter/);
});

test('hand-sent deposits: the routes offered, the config ("auto", "skip"), and what a typed line means', () => {
  const sol = coinOf('SOL', 9, [native('SOL', '0.03', '0.01', '0.012')], 8);
  const zec = coinOf('ZEC', 8, [{ ...native('ZEC', '0.01', '0.01', '0.001'), addressKind: 'other' as const }], 12);
  const closed = coinOf('DOGE', 8, [{ ...native('DOGE', '30', '30', '12'), deposit: { allowed: false, min: '30', etaSeconds: null } }], 11);
  const cfg = validateConfig({ receivers: { sol: SAMPLE_ADDRESS.solana }, manualDeposits: [{ coin: 'SOL', chain: 'SOL', amount: 'auto' }, { coin: 'DOGE', chain: 'DOGE', skip: true }] });
  assert.deepEqual(cfg.errors, []);
  assert.deepEqual(cfg.config.manualDeposits, [{ coin: 'SOL', chain: 'SOL', amount: 'auto' }, { coin: 'DOGE', chain: 'DOGE', amount: 'auto', skip: true }]);
  assert.match(validateConfig({ manualDeposits: [{ coin: 'SOL', chain: 'SOL', amount: 'some' }] }).errors.join(), /"auto"/);
  const hr = handRoutes([sol, zec, closed], cfg.config);
  assert.deepEqual(hr.map((h) => [h.coin.coin, h.why === null, isHandActive(h.deposit)]), [['DOGE', false, false], ['SOL', true, true], ['ZEC', false, false]]);
  assert.equal(ownerWord('s'), 'skip');
  assert.equal(ownerWord(' Skip '), 'skip');
  assert.equal(ownerWord('skip all'), 'skip-all');
  assert.equal(ownerWord('yes'), null);
  assert.equal(ownerWord(null), null);
});

test('transientWait: reads again after the network failed, never after an answer', async () => {
  const { transientWait } = await import('./context');
  const { UnreachableError, RateLimitedError } = await import('../../src/exchange/errors');
  assert.equal(transientWait(new UnreachableError('mainnet-gw.sodex.dev', true), 5_000), 5_000);
  assert.equal(transientWait(new RateLimitedError('mainnet-gw.sodex.dev', 30_000), 5_000), 32_000);
  assert.equal(transientWait(Object.assign(new Error('Bad Gateway'), { httpStatus: 502 }), 5_000), 5_000);
  assert.equal(transientWait(new TypeError('fetch failed'), 5_000), 5_000);
  assert.equal(transientWait(new Error('order below the minimum notional'), 5_000), null);
  assert.equal(transientWait(new UnreachableError('x', true), undefined), null, 'no more attempts left');
});
