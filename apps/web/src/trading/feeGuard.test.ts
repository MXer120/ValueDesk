/**
 * The fee guard (docs/BUILDER-TIERS.md section 2, G2 and G6): every action type
 * @sodex-core can sign is classified, and an action that would create or change
 * an order outside the builder rules is refused before anything is signed.
 *
 * The actions are built with @sodex-core's own builders - the same objects
 * actions.ts hands to the signer. No wallet, no network.
 *   npx tsx --test src/trading/feeGuard.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION, OrderSide, OrderType, TimeInForce, perpsActions, spotActions, type ActionType, type BuilderParams, type RawOrderInput, type SignableAction } from '@sodex-core';
import { setTradingConfig, type BuilderConfig } from './config';
import { ACTION_CLASS, MODIFY_KEEPS_BUILDER, REPLACE_KEEPS_BUILDER, classifyAction, guardAction, mustRecreate } from './feeGuard';
import { TradingError } from './session';
import { TERMS_PATH, _resetTermsForTests, configureTerms, feeNow, refreshTerms } from './terms';

const SODEX = 286623;
const BID = 123456;
const AID = 4242;
const OWNER = '0x' + 'ab'.repeat(20);
/** The contract's test values: 2 bp on both engines by default. */
const REQUIRED: BuilderConfig = { id: BID, fee: { perps: 20, spot: 20 }, maxFeeRate: 20, required: true };
const OPTIONAL: BuilderConfig = { ...REQUIRED, required: false };
const PERPS_ONLY: BuilderConfig = { ...REQUIRED, fee: { perps: 20, spot: 0 } };

const configure = (builder: BuilderConfig | null) =>
  setTradingConfig({ network: 'mainnet', chainId: SODEX, gateway: 'https://gw.test', writesAllowed: true, disabled: false, keyTtlMs: 7 * 86_400_000, builder });

// --- a terms server (so "the fee owed now" can be lower than the default) --------------------

const subtle = globalThis.crypto.subtle;
const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const PUB = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const clock = { mono: 1_000 };
let signedFee = { perps: 15, spot: 20 };

async function termsServer(url: string): Promise<Response> {
  const u = new URL(url);
  const address = u.searchParams.get('address')!;
  const nonce = u.searchParams.get('nonce')!;
  const issued = 1_790_000_000_000;
  const ttl = 600_000;
  const msg = `valuescan-builder-terms/1\nchain:${SODEX}\nbuilder:${BID}\naddress:${address}\nperps:${signedFee.perps}\nspot:${signedFee.spot}\nnonce:${nonce}\nissued:${issued}\nttl:${ttl}`;
  const sig = Buffer.from(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(msg))).toString('base64url');
  return new Response(JSON.stringify({ ok: true, chain: SODEX, builderId: BID, address, fee: signedFee, nonce, issued, ttl, keyId: 'x', sig }), { status: 200 });
}

/** Give OWNER verified terms: from here its fee owed is `fee`. */
async function owes(fee: { perps: number; spot: number }): Promise<void> {
  signedFee = fee;
  configureTerms({ keys: [PUB], endpoint: `https://vs.test${TERMS_PATH}`, fetch: termsServer, monotonicNow: () => clock.mono, wallNow: () => 1_790_000_000_000 });
  assert.deepEqual((await refreshTerms(OWNER))?.fee, fee);
}

beforeEach(() => {
  clock.mono = 1_000;
  _resetTermsForTests();
  configure(REQUIRED);
});

// --- actions ------------------------------------------------------------------------------------

const leg = (extra: Partial<RawOrderInput> = {}): RawOrderInput => ({ clOrdID: 'vs-test-1', side: OrderSide.BUY, type: OrderType.LIMIT, timeInForce: TimeInForce.GTC, price: '84000', quantity: '0.01', ...extra });
const perpsOrder = (builder?: BuilderParams, legs: RawOrderInput[] = [leg()]) => perpsActions.newOrder(AID, 7, legs, builder);
const spotOrder = (builder?: BuilderParams) =>
  spotActions.batchNewOrder(AID, [{ symbolID: 7, clOrdID: 'vs-test-2', side: OrderSide.SELL, type: OrderType.LIMIT, timeInForce: TimeInForce.GTC, price: '84000', quantity: '0.01' }], builder);
const ours = (fee: number): BuilderParams => ({ id: BID, fee });

/** One action of every type @sodex-core can sign (on an engine that has it). */
const EVERY: Record<ActionType, SignableAction> = {
  newOrder: perpsOrder(ours(20)),
  batchNewOrder: spotOrder(ours(20)),
  cancelOrder: perpsActions.cancelOrder(AID, [{ symbolID: 7, orderID: 1 }]),
  batchCancelOrder: spotActions.batchCancelOrder(AID, [{ symbolID: 7, clOrdID: 'cx-1', orderID: 1 }]),
  modifyOrder: perpsActions.modifyOrder({ accountID: AID, symbolID: 7, orderID: 1, price: '84001' }),
  replaceOrder: perpsActions.replaceOrder(AID, [{ symbolID: 7, clOrdID: 'rp-1', origOrderID: 1, price: '84001' }]),
  scheduleCancel: perpsActions.scheduleCancel(AID, 1_790_000_100_000),
  transferAsset: spotActions.transferAsset({ id: 1, fromAccountID: AID, toAccountID: 999, coinID: 0, amount: '1', type: 5 }),
  updateLeverage: perpsActions.updateLeverage(AID, 7, 5, 2),
  updateMargin: perpsActions.updateMargin(AID, 7, '1'),
  // Signed by the master wallet in practice; classified all the same.
  revokeAPIKey: { engine: 'perps', type: 'revokeAPIKey', params: { accountID: AID, name: 'valuescan-web' } },
  newTwapOrder: perpsActions.newTwapOrder({ accountID: AID, symbolID: 7, side: OrderSide.BUY, quantity: '1', minutes: 5, randomize: false }),
  cancelTwapOrder: perpsActions.cancelTwapOrder(AID, 7, 1),
};

const refused = (fn: () => void, why: RegExp, msg?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof TradingError && e.kind === 'fee-guard' && why.test(e.message), msg);
const passes = (a: SignableAction, msg?: string) => assert.doesNotThrow(() => guardAction(a, OWNER), msg);
const stops = (a: SignableAction, why: RegExp, msg?: string) => refused(() => guardAction(a, OWNER), why, msg);

// --- G2: every type is classified ------------------------------------------------------------------

test('EVERY action type of @sodex-core is classified - none more, none less', () => {
  const known = Object.values(ACTION).sort();
  assert.deepEqual(Object.keys(ACTION_CLASS).sort(), known, 'a type added to @sodex-core must be classified in feeGuard.ts before it can be signed');
  assert.deepEqual(Object.keys(EVERY).sort(), known, 'this test builds one action of every type');
  for (const t of known) assert.ok(['order', 'order-without-builder', 'change', 'other'].includes(classifyAction(t)), t);
  // What creates orders, and what changes them - by name, so a reclassification is a deliberate edit here too.
  const byClass = (c: string) => known.filter((t) => ACTION_CLASS[t] === c);
  assert.deepEqual(byClass('order'), ['batchNewOrder', 'newOrder']);
  assert.deepEqual(byClass('order-without-builder'), ['newTwapOrder']);
  assert.deepEqual(byClass('change'), ['modifyOrder', 'replaceOrder']);
  assert.deepEqual(byClass('other'), ['batchCancelOrder', 'cancelOrder', 'cancelTwapOrder', 'revokeAPIKey', 'scheduleCancel', 'transferAsset', 'updateLeverage', 'updateMargin']);
});

test('an action type the guard has never heard of is refused, not waved through', () => {
  for (const type of ['newOcoOrder', 'batchNewOrderV2', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    refused(() => classifyAction(type), /not one the builder-fee guard knows/, type);
    stops({ engine: 'perps', type: type as ActionType, params: { accountID: AID, orders: [leg()], builder: ours(20) } }, /not one the builder-fee guard knows/, type);
  }
});

test('with no builder configured the guard does nothing: every action passes exactly as built', () => {
  configure(null);
  for (const [type, a] of Object.entries(EVERY)) passes(a, type);
  passes(perpsOrder(undefined));
  passes(spotOrder(undefined));
  // Even one it does not know: without a builder there is nothing to protect, and nothing changes.
  passes({ engine: 'perps', type: 'somethingNew' as ActionType, params: {} });
});

// --- orders that can carry the builder ---------------------------------------------------------------

test('required build: an order goes out with the pinned builder at the fee owed - or not at all', () => {
  passes(perpsOrder(ours(20)));
  passes(spotOrder(ours(20)));
  // No builder.
  stops(perpsOrder(undefined), /does not carry the Valuescan builder fee/);
  stops(spotOrder(undefined), /does not carry the Valuescan builder fee/);
  // A lower fee than is owed, down to none.
  for (const fee of [19, 15, 1, 0]) stops(perpsOrder(ours(fee)), /not the fee this wallet owes/, `fee ${fee}`);
  stops(spotOrder(ours(19)), /not the fee this wallet owes/);
  // More than the default is not sent either: the app never charges above what it showed.
  stops(perpsOrder(ours(21)), /not the fee this wallet owes/);
  stops(spotOrder(ours(2000)), /not the fee this wallet owes/);
  // Another builder, at any fee.
  stops(perpsOrder({ id: BID + 1, fee: 20 }), /another builder than Valuescan/);
  stops(spotOrder({ id: 1, fee: 20 }), /another builder than Valuescan/);
});

test('required build: a batch with several legs is one order - the builder is the batch\'s, and no leg may name its own', () => {
  const entry = leg({ clOrdID: 'vs-e' });
  const tp = leg({ clOrdID: 'tp-e', side: OrderSide.SELL, type: OrderType.MARKET, timeInForce: TimeInForce.IOC, price: undefined, stopPrice: '90000', stopType: 2, triggerType: 2, reduceOnly: true });
  passes(perpsOrder(ours(20), [entry, tp]));
  stops(perpsOrder(undefined, [entry, tp]), /does not carry the Valuescan builder fee/);
  // A per-order builder (perps allows one) could undercut the batch's: refused whatever it says.
  stops(perpsOrder(ours(20), [entry, { ...tp, builder: { id: BID, fee: 1 } }]), /a builder of its own/);
  stops(perpsOrder(ours(20), [{ ...entry, builder: { id: 999, fee: 20 } }]), /a builder of its own/);
  stops(perpsOrder(undefined, [{ ...entry, builder: ours(20) }]), /a builder of its own/, 'not even the right one: the batch carries it');
});

test('the fee owed follows verified terms: a lower tier is the new floor, the default stays the ceiling', async () => {
  await owes({ perps: 15, spot: 20 });
  assert.equal(feeNow('perps', OWNER), 15);
  passes(perpsOrder(ours(15)), 'the tier\'s fee');
  passes(perpsOrder(ours(20)), 'an order built a moment before the tier arrived still pays at least what is owed');
  passes(perpsOrder(ours(17)));
  stops(perpsOrder(ours(14)), /not the fee this wallet owes/);
  stops(perpsOrder(ours(21)), /not the fee this wallet owes/);
  stops(perpsOrder(undefined), /does not carry the Valuescan builder fee/);
  // Spot has no lower tier: 20 or nothing.
  passes(spotOrder(ours(20)));
  stops(spotOrder(ours(15)), /not the fee this wallet owes/);
  // Another wallet's terms are not this wallet's: its orders owe the default.
  assert.throws(() => guardAction(perpsOrder(ours(15)), '0x' + 'cd'.repeat(20)), TradingError);
  // The terms run out: 15 is below the fee owed again.
  clock.mono += 600_000;
  assert.equal(feeNow('perps', OWNER), 20);
  stops(perpsOrder(ours(15)), /not the fee this wallet owes/, 'expired terms');
  passes(perpsOrder(ours(20)));
});

test('a wallet whose terms say 0 still names the builder: {id, fee: 0} passes, no builder does not', async () => {
  await owes({ perps: 0, spot: 0 });
  passes(perpsOrder(ours(0)));
  passes(spotOrder(ours(0)));
  passes(perpsOrder(ours(20)));
  stops(perpsOrder(undefined), /does not carry the Valuescan builder fee/);
});

test('optional build (VITE_BUILDER_REQUIRED=0): an order may go without the builder - but never with another one or a lower fee', async () => {
  configure(OPTIONAL);
  passes(perpsOrder(undefined), 'an account that declined trades without it');
  passes(spotOrder(undefined));
  passes(perpsOrder(ours(20)));
  stops(perpsOrder(ours(19)), /not the fee this wallet owes/);
  stops(perpsOrder({ id: 999, fee: 20 }), /another builder than Valuescan/);
  stops(perpsOrder(ours(20), [leg({ builder: { id: BID, fee: 1 } })]), /a builder of its own/);
});

test('an engine the build does not charge on carries no builder: none is required there, and none is let through', () => {
  configure(PERPS_ONLY);
  passes(spotOrder(undefined));
  stops(spotOrder(ours(20)), /names a builder on spot, where Valuescan charges none/);
  stops(spotOrder(ours(0)), /names a builder on spot/);
  // Perps is still guarded.
  stops(perpsOrder(undefined), /does not carry the Valuescan builder fee/);
  passes(perpsOrder(ours(20)));
});

// --- orders that cannot carry it, and changes --------------------------------------------------------

test('TWAP cannot carry a builder: refused in a build that requires it, on perps and on spot', () => {
  stops(EVERY.newTwapOrder, /TWAP orders are not available here/);
  stops(spotActions.newTwapOrder({ accountID: AID, symbolID: 7, side: OrderSide.SELL, quantity: '1', minutes: 5, randomize: false }), /TWAP orders are not available here/);
  passes(EVERY.cancelTwapOrder, 'cancelling one is always allowed');
  // Where no builder is required - an optional build, an engine that is not charged - TWAP is as it was.
  configure(OPTIONAL);
  passes(EVERY.newTwapOrder);
  configure(PERPS_ONLY);
  passes(spotActions.newTwapOrder({ accountID: AID, symbolID: 7, side: OrderSide.SELL, quantity: '1', minutes: 5, randomize: false }));
  stops(EVERY.newTwapOrder, /TWAP orders are not available here/);
});

test('G6: a change request is sent where it is known to keep the builder - modify and replace (both proven live)', () => {
  // The live run of 2026-10-03 showed both keep the builder at the fee the order carried.
  assert.equal(MODIFY_KEEPS_BUILDER, true, 'modify changes the order in place (same order id)');
  assert.equal(REPLACE_KEEPS_BUILDER, true, 'the replaced order still names the builder (live run, spot and perps)');
  passes(EVERY.modifyOrder);
  passes(EVERY.replaceOrder);
  passes(spotActions.replaceOrder(AID, [{ symbolID: 7, clOrdID: 'rp-2', origOrderID: 1, price: '84001' }]));
  assert.equal(mustRecreate('modifyOrder', 'perps'), false);
  assert.equal(mustRecreate('replaceOrder', 'perps'), false);
  assert.equal(mustRecreate('replaceOrder', 'spot'), false);
  // Not required, not charged, or no builder: SoDEX's own request is used as it always was.
  configure(OPTIONAL);
  passes(EVERY.replaceOrder);
  assert.equal(mustRecreate('replaceOrder', 'perps'), false);
  configure(PERPS_ONLY);
  passes(spotActions.replaceOrder(AID, [{ symbolID: 7, clOrdID: 'rp-3', origOrderID: 1, price: '84001' }]));
  assert.equal(mustRecreate('replaceOrder', 'spot'), false);
  assert.equal(mustRecreate('replaceOrder', 'perps'), false);
  configure(null);
  passes(EVERY.replaceOrder);
  assert.equal(mustRecreate('replaceOrder', 'perps'), false);
});

test('everything that neither creates nor changes an order is unaffected, in every kind of build', () => {
  const other = (Object.keys(EVERY) as ActionType[]).filter((t) => ACTION_CLASS[t] === 'other');
  assert.equal(other.length, 8);
  for (const b of [REQUIRED, OPTIONAL, PERPS_ONLY, null]) {
    configure(b);
    for (const t of other) passes(EVERY[t], `${t} in ${b ? (b.required ? 'a required' : 'an optional') : 'a no-builder'} build`);
  }
});

test('the gate cannot be walked around: the app signs exchange actions in ONE place, and the guard is called there before the signature', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)); // apps/web/src
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) sources.push(p);
    }
  };
  walk(root);
  assert.ok(sources.length > 100, 'the whole app was scanned');
  const rel = (p: string) => relative(root, p).replace(/\\/g, '/');
  const using = (re: RegExp) => sources.filter((p) => re.test(readFileSync(p, 'utf8'))).map(rel).sort();
  // @sodex-core's two functions that sign an exchange action with a trading key.
  assert.deepEqual(using(/\bsignAndBuild(WithNonceManager)?\s*\(/), ['trading/actions.ts'], 'a second place that signs actions must go through signAndSend - or be guarded the same way and listed here');
  // The trading key leaves the session only through requireSigner - and only actions.ts asks for it.
  assert.deepEqual(using(/\brequireSigner\s*\(/), ['trading/actions.ts', 'trading/session.ts']);
  const actions = readFileSync(join(root, 'trading', 'actions.ts'), 'utf8');
  assert.equal(actions.split('signAndBuildWithNonceManager(').length - 1, 1, 'one signing call in actions.ts');
  const send = actions.slice(actions.indexOf('async function signAndSend'));
  const guard = send.indexOf('guardAction(action, s.meta.owner)');
  const sign = send.indexOf('signAndBuildWithNonceManager(');
  assert.ok(guard > 0 && sign > guard, 'signAndSend calls the guard BEFORE it signs');
  // Between the check and the signing call there is no `await` (the one in front of the call itself aside): nothing can change in between.
  assert.ok(!/await/.test(send.slice(guard, sign).replace(/await\s*$/, '')), 'nothing can happen between the check and the signature');
});

test('a refusal is logged with what was wrong, and nothing in the action is changed by the guard', () => {
  const a = perpsOrder(ours(20));
  const before = JSON.stringify(a);
  passes(a);
  assert.equal(JSON.stringify(a), before, 'the guard only looks');
  const bad = perpsOrder(ours(5));
  const badBefore = JSON.stringify(bad);
  stops(bad, /not the fee this wallet owes/);
  assert.equal(JSON.stringify(bad), badBefore, 'a refused action is not "repaired" either');
});
