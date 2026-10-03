/**
 * The runner's own parts, offline and one at a time: the check registry, the
 * fee arithmetic of a fill, the history limiter, the independent terms
 * verifier (against the shared Ed25519 vector), the ledger, the receivers the
 * refusals use, the coverage table, the profiles, the tour's legs and amounts,
 * the chain withdrawals and what cannot be tested. (The guard's write kinds and
 * the wallet policies are in safety.test.ts.)
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
import { DEFAULT_CONFIG, type RunConfig } from './config';
import { applyProfile, profileSteps } from './profiles';
import { memoRuleProblems, notTestable } from './routes';
import { nativeLegAmounts, roundTripAmount, tourPlan, usdcLegAmounts } from './tour';

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

test('tour amounts: what goes out clears the deposit minimum when it comes back, with the gas kept back; a round trip never withdraws a minimum the fee eats', () => {
  assert.deepEqual(usdcLegAmounts(route('ARBITRUM_ETH'), '1'), { withdraw: '6', back: '5' });
  assert.deepEqual(usdcLegAmounts(route('MATIC', { withdraw: { allowed: true, min: '2', fee: '1' } }), '1'), { withdraw: '6', back: '5' });
  const eth = coinOf('ETH', 18, []);
  assert.deepEqual(nativeLegAmounts(native('ARBITRUM_ETH', '0.0015', '0.0015', '0.0005'), eth, '0.0005', '0.0002'), { withdraw: '0.0022', back: '0.0015' });
  // BNB: SoDEX's withdrawal minimum (0.0005) is below its fee (0.002) - the leg withdraws enough to come back.
  assert.deepEqual(nativeLegAmounts(native('BSC_BNB', '0.005', '0.0005', '0.002'), coinOf('BNB', 18, []), '0.002', '0.0005'), { withdraw: '0.0075', back: '0.005' });
  // Arc: USDC is the native coin, 6 decimals on SoDEX.
  assert.deepEqual(nativeLegAmounts(native('ARC', '5', '5', '1'), coinOf('USDC', 6, []), '1', '0.05'), { withdraw: '6.05', back: '5' });
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
