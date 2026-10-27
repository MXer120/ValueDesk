/**
 * The builder fee as configuration, decisions and numbers - no wallet, no
 * network. The flow (read, consent, sign, verify) is in builderFlow.test.ts.
 *   npx tsx --test src/trading/builder.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64UrlBytes, builderBroken, builderEnvProblems, builderFromEnv, termsKeysFromEnv, type BuilderConfig } from './config';
import {
  activeBuilder,
  approvalFromRates,
  builderFeeOn,
  builderTerms,
  enginesCharged,
  fmtBuilderRate,
  fullyApproved,
  orderBuilder,
  owedFee,
  partlyApproved,
  quoteBuilderFee,
  ratesCover,
  ratesOf,
  sameApproval,
  type BuilderApproval,
} from './builder';

const B: BuilderConfig = { id: 777001, fee: { perps: 50, spot: 100 }, maxFeeRate: 100, required: false };
const REQUIRED: BuilderConfig = { ...B, required: true };
const approved = (engines: BuilderApproval['engines'], id = B.id): BuilderApproval => ({ id, maxFeeRate: Math.max(0, ...Object.values(engines)), engines });

// --- configuration ---------------------------------------------------------------

test('the builder is OFF until VITE_BUILDER_ID is set: nothing else switches it on', () => {
  assert.equal(builderFromEnv({}), null);
  assert.equal(builderFromEnv({ VITE_BUILDER_FEE_PERPS: '50', VITE_BUILDER_FEE_SPOT: '50', VITE_BUILDER_MAX_FEE: '50', VITE_BUILDER_REQUIRED: '1' }), null);
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '' }), null);
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '   ' }), null);
  assert.deepEqual(builderEnvProblems({}), [], 'no builder configured is not a problem');
  assert.deepEqual(builderEnvProblems({ VITE_BUILDER_REQUIRED: '1' }), []);
});

test('G1: a build that names a builder REQUIRES the approval - only VITE_BUILDER_REQUIRED=0 makes it optional', () => {
  // Nothing said about it: required.
  assert.deepEqual(builderFromEnv({ VITE_BUILDER_ID: '223169', VITE_BUILDER_FEE_PERPS: '50', VITE_BUILDER_FEE_SPOT: '100' }), {
    id: 223169,
    fee: { perps: 50, spot: 100 },
    maxFeeRate: 100,
    required: true,
  });
  assert.deepEqual(builderFromEnv({ VITE_BUILDER_ID: ' 9 ', VITE_BUILDER_FEE_PERPS: '200', VITE_BUILDER_MAX_FEE: '2000', VITE_BUILDER_REQUIRED: '1' }), {
    id: 9,
    fee: { perps: 200, spot: 0 },
    maxFeeRate: 2000,
    required: true,
  });
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_SPOT: '2000', VITE_BUILDER_REQUIRED: '' })?.required, true, 'blank is not "0"');
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_SPOT: '2000', VITE_BUILDER_REQUIRED: ' 1 ' })?.required, true);
  // The one way out: an explicit 0.
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_SPOT: '2000', VITE_BUILDER_REQUIRED: '0' })?.required, false);
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_SPOT: '2000', VITE_BUILDER_REQUIRED: ' 0 ' })?.required, false);
  // Anything else is a typo, and a typo never makes the fee optional: the builder cannot be read, and the build's trading is off.
  for (const v of ['yes', 'false', 'off', 'no', '2', 'optional']) {
    const e = { VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_SPOT: '2000', VITE_BUILDER_REQUIRED: v };
    assert.equal(builderFromEnv(e), null, v);
    assert.ok(builderEnvProblems(e).some((p) => /VITE_BUILDER_REQUIRED/.test(p)), v);
    assert.equal(builderBroken(e), true, `${v}: trading is off, not free`);
  }
});

test('G1: a build that names a builder it cannot charge does NOT trade for free - its trading is off', () => {
  // No builder named: nothing is broken.
  assert.equal(builderBroken({}), false);
  assert.equal(builderBroken({ VITE_BUILDER_FEE_PERPS: 'abc' }), false, 'fee settings without a builder id mean nothing');
  // A valid builder: not broken.
  assert.equal(builderBroken({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '20' }), false);
  // A typo in any of its settings: broken - the fee is not silently dropped.
  assert.equal(builderBroken({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '2O' }), true);
  assert.equal(builderBroken({ VITE_BUILDER_ID: 'nine', VITE_BUILDER_FEE_PERPS: '20' }), true);
  assert.equal(builderBroken({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '20', VITE_BUILDER_MAX_FEE: '10' }), true);
  // A builder with no fee at all is a forgotten fee.
  assert.equal(builderBroken({ VITE_BUILDER_ID: '9' }), true);
  assert.equal(builderBroken({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '0', VITE_BUILDER_FEE_SPOT: '0' }), true);
  assert.ok(builderEnvProblems({ VITE_BUILDER_ID: '9' }).some((p) => /both .* are 0/.test(p)));
  // An explicitly OPTIONAL build keeps the old behaviour: the builder is simply off, trading works.
  assert.equal(builderBroken({ VITE_BUILDER_ID: '9', VITE_BUILDER_REQUIRED: '0' }), false);
  assert.equal(builderBroken({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '2O', VITE_BUILDER_REQUIRED: '0' }), false);
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '2O', VITE_BUILDER_REQUIRED: '0' }), null);
  assert.deepEqual(builderEnvProblems({ VITE_BUILDER_ID: '9', VITE_BUILDER_REQUIRED: '0' }), [], 'optional + no fee: no builder, and not an error');
});

test('the pinned terms keys: base64url of 32 raw bytes, comma separated; an unusable entry is dropped and named', () => {
  const k1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 32 zero bytes
  const k2 = '_____________________w8AAAAAAAAAAAAAAAAAAAA';
  assert.equal(base64UrlBytes(k1)?.length, 32);
  assert.equal(base64UrlBytes(k2)?.length, 32);
  assert.deepEqual(termsKeysFromEnv({}), { keys: [], problems: [] });
  assert.deepEqual(termsKeysFromEnv({ VITE_BUILDER_TERMS_KEYS: '  ' }), { keys: [], problems: [] });
  assert.deepEqual(termsKeysFromEnv({ VITE_BUILDER_TERMS_KEYS: ` ${k1} , ${k2},${k1}, ` }).keys, [k1, k2], 'trimmed, in order, without repeats');
  const bad = termsKeysFromEnv({ VITE_BUILDER_TERMS_KEYS: `${k1},not base64!,QUJD,${k2}=` });
  assert.deepEqual(bad.keys, [k1], 'only the usable key is pinned');
  assert.equal(bad.problems.length, 3, 'not base64url, 3 bytes, and standard-base64 padding are each named');
  // A broken terms key costs the discount, never the fee: the builder itself is untouched.
  assert.equal(builderBroken({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '20', VITE_BUILDER_TERMS_KEYS: 'garbage' }), false);
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '20', VITE_BUILDER_TERMS_KEYS: 'garbage' })?.fee.perps, 20);
  assert.equal(base64UrlBytes(''), null);
  assert.equal(base64UrlBytes('a'), null, 'not a possible base64 length');
  assert.equal(base64UrlBytes('ab+/'), null, 'standard base64 is not base64url');
});

test('invalid builder settings give NO builder and say why - a typo never becomes a different fee', () => {
  const off = (e: Record<string, string>, why: RegExp) => {
    assert.equal(builderFromEnv(e), null, JSON.stringify(e));
    assert.ok(builderEnvProblems(e).some((p) => why.test(p)), `${JSON.stringify(e)} -> ${builderEnvProblems(e).join('; ')}`);
  };
  off({ VITE_BUILDER_ID: 'abc', VITE_BUILDER_FEE_PERPS: '50' }, /VITE_BUILDER_ID/);
  off({ VITE_BUILDER_ID: '0', VITE_BUILDER_FEE_PERPS: '50' }, /VITE_BUILDER_ID/);
  off({ VITE_BUILDER_ID: '-4', VITE_BUILDER_FEE_PERPS: '50' }, /VITE_BUILDER_ID/);
  off({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '201' }, /VITE_BUILDER_FEE_PERPS.*0\.\.200/);
  off({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_SPOT: '2001' }, /VITE_BUILDER_FEE_SPOT.*0\.\.2000/);
  off({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '5.5' }, /VITE_BUILDER_FEE_PERPS/);
  off({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '0.05%' }, /VITE_BUILDER_FEE_PERPS/);
  off({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '50', VITE_BUILDER_MAX_FEE: '40' }, /below the fee/);
  off({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '50', VITE_BUILDER_MAX_FEE: '2001' }, /VITE_BUILDER_MAX_FEE/);
  // Both fees 0 (or unset): there is nothing to charge - no builder. (Whether that build may trade: the test above.)
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9' }), null);
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9', VITE_BUILDER_FEE_PERPS: '0', VITE_BUILDER_FEE_SPOT: '0' }), null);
  assert.equal(builderFromEnv({ VITE_BUILDER_ID: '9', VITE_BUILDER_REQUIRED: '0' }), null);
});

// --- which engines an approval covers -----------------------------------------------

test('an approval is judged PER ENGINE against the fee configured for that engine', () => {
  assert.deepEqual(enginesCharged(B), ['spot', 'perps']);
  assert.deepEqual(enginesCharged({ ...B, fee: { perps: 50, spot: 0 } }), ['perps']);
  assert.deepEqual(ratesCover(B, { spot: 100, perps: 50 }), { spot: true, perps: true });
  assert.deepEqual(ratesCover(B, { spot: 99, perps: 50 }), { spot: false, perps: true }, 'below the spot fee');
  assert.deepEqual(ratesCover(B, { spot: null, perps: 200 }), { spot: false, perps: true });
  assert.equal(fullyApproved(B, { spot: 100, perps: 50 }), true);
  assert.equal(fullyApproved(B, { spot: 2000, perps: 200 }), true, 'a higher ceiling than needed is fine');
  assert.equal(fullyApproved(B, { spot: 100, perps: null }), false);
  assert.equal(partlyApproved(B, { spot: 100, perps: null }), true);
  assert.equal(partlyApproved(B, { spot: null, perps: null }), false);
  // An engine with no fee needs no approval - and does not count as "approved" either.
  const perpsOnly: BuilderConfig = { ...B, fee: { perps: 50, spot: 0 } };
  assert.equal(fullyApproved(perpsOnly, { spot: null, perps: 50 }), true);
  assert.equal(partlyApproved(perpsOnly, { spot: 500, perps: null }), false);
  // What mainnet shows for an approval of 500: spot 500, perps capped at 200.
  assert.equal(fullyApproved({ id: 1, fee: { perps: 200, spot: 500 }, maxFeeRate: 500, required: false }, { spot: 500, perps: 200 }), true);
});

test('approvalFromRates / ratesOf / sameApproval', () => {
  assert.equal(approvalFromRates(B.id, { spot: null, perps: null }), null);
  assert.deepEqual(approvalFromRates(B.id, { spot: 500, perps: 200 }), { id: B.id, maxFeeRate: 500, engines: { spot: 500, perps: 200 } });
  assert.deepEqual(approvalFromRates(B.id, { spot: null, perps: 50 }), { id: B.id, maxFeeRate: 50, engines: { perps: 50 } });
  assert.deepEqual(ratesOf(approved({ spot: 100 })), { spot: 100, perps: null });
  assert.deepEqual(ratesOf(null), { spot: null, perps: null });
  // A record written before approvals were per engine has no `engines`: it approves nothing.
  assert.deepEqual(ratesOf({ id: B.id, maxFeeRate: 100 } as unknown as BuilderApproval), { spot: null, perps: null });
  assert.equal(sameApproval(approved({ spot: 100, perps: 50 }), approved({ perps: 50, spot: 100 })), true);
  assert.equal(sameApproval(approved({ spot: 100 }), approved({ spot: 100, perps: 50 })), false);
  assert.equal(sameApproval(null, null), true);
  assert.equal(sameApproval(null, approved({ spot: 1 })), false);
  assert.equal(sameApproval(approved({ spot: 1 }, 1), approved({ spot: 1 }, 2)), false, 'another builder');
});

// --- what an order carries ------------------------------------------------------------

test('orderBuilder: {id, fee} per engine, only where the approval covers the fee', () => {
  const both = approved({ spot: 100, perps: 50 });
  assert.deepEqual(orderBuilder(B, both, 'perps'), { id: B.id, fee: 50 });
  assert.deepEqual(orderBuilder(B, both, 'spot'), { id: B.id, fee: 100 });
  assert.deepEqual(Object.keys(orderBuilder(B, both, 'spot')!), ['id', 'fee'], 'id before fee');
  // One engine only.
  assert.equal(orderBuilder(B, approved({ spot: 100 }), 'perps'), undefined);
  assert.deepEqual(orderBuilder(B, approved({ spot: 100 }), 'spot'), { id: B.id, fee: 100 });
  // Approved, but for less than the build charges: nothing is attached (never more than was approved, never a silent lower fee).
  assert.equal(orderBuilder(B, approved({ spot: 99, perps: 49 }), 'spot'), undefined);
  assert.equal(orderBuilder(B, approved({ spot: 99, perps: 49 }), 'perps'), undefined);
  // Not approved, no builder configured, or an approval for another builder account.
  assert.equal(orderBuilder(B, null, 'perps'), undefined);
  assert.equal(orderBuilder(null, both, 'perps'), undefined);
  assert.equal(orderBuilder(B, approved({ spot: 100, perps: 50 }, 5), 'perps'), undefined);
  // An engine the build does not charge on.
  assert.equal(orderBuilder({ ...B, fee: { perps: 50, spot: 0 } }, both, 'spot'), undefined);
  // The engine's own cap holds whatever was approved.
  assert.equal(orderBuilder({ ...B, fee: { perps: 201, spot: 100 } }, approved({ spot: 2000, perps: 2000 }), 'perps'), undefined);
  assert.equal(activeBuilder({ ...B, fee: { perps: 0, spot: 0 } }), null);
  assert.equal(activeBuilder(null), null);
});

test('orderBuilder at the fee OWED: lower than the default when told so, never above it, and the highest when in doubt', () => {
  const both = approved({ spot: 100, perps: 50 });
  // A volume tier: the wallet owes 30 on perps, the default is 50.
  assert.deepEqual(orderBuilder(B, both, 'perps', 30), { id: B.id, fee: 30 });
  assert.deepEqual(orderBuilder(B, both, 'spot', 100), { id: B.id, fee: 100 });
  // Never above the default, whatever is passed.
  assert.deepEqual(orderBuilder(B, both, 'perps', 60), { id: B.id, fee: 50 });
  assert.deepEqual(orderBuilder(B, approved({ spot: 2000, perps: 200 }), 'perps', 200), { id: B.id, fee: 50 });
  // Anything that is not a whole fee from 0 to the default falls to the DEFAULT, not to something lower.
  for (const bad of [Number.NaN, -1, 12.5, Number.POSITIVE_INFINITY, undefined]) {
    assert.deepEqual(orderBuilder(B, both, 'perps', bad as number | undefined), { id: B.id, fee: 50 }, String(bad));
    assert.equal(owedFee(B, 'perps', bad as number | undefined), 50, String(bad));
  }
  assert.equal(owedFee(B, 'perps', 30), 30);
  assert.equal(owedFee(B, 'perps', 0), 0);
  assert.equal(owedFee({ ...B, fee: { perps: 50, spot: 0 } }, 'spot', 10), null, 'an engine that is not charged');
  // The approval is judged against the fee OWED: an approval of 30 covers 30, not the default 50.
  assert.deepEqual(orderBuilder(B, approved({ perps: 30 }), 'perps', 30), { id: B.id, fee: 30 });
  assert.equal(orderBuilder(B, approved({ perps: 30 }), 'perps'), undefined);
  assert.equal(orderBuilder(B, approved({ perps: 29 }), 'perps', 30), undefined);
  // A fee of 0 still names the builder (the order stays ValueDesk's) - where SoDEX lists the builder at all.
  assert.deepEqual(orderBuilder(B, both, 'perps', 0), { id: B.id, fee: 0 });
  assert.equal(orderBuilder(B, approved({ spot: 100 }), 'perps', 0), undefined);
  assert.equal(orderBuilder(B, null, 'perps', 0), undefined);
  // ...and never on an engine the build does not charge on.
  assert.equal(orderBuilder({ ...B, fee: { perps: 50, spot: 0 } }, both, 'spot', 0), undefined);
});

// --- what the user is told --------------------------------------------------------------

test('builderTerms: the facts the consent dialog states', () => {
  assert.deepEqual(builderTerms(B), { builderId: 777001, perps: 50, spot: 100, maxFeeRate: 100, required: false, alreadyApproved: [], purpose: 'enable' });
  // Asked on its own (the key options): the same facts, and the dialog is told so.
  assert.deepEqual(builderTerms(B, { spot: null, perps: 50 }, 'approve'), { builderId: 777001, perps: 50, spot: 100, maxFeeRate: 100, required: false, alreadyApproved: ['perps'], purpose: 'approve' });
  assert.deepEqual(builderTerms(REQUIRED, { spot: null, perps: 50 }).alreadyApproved, ['perps']);
  assert.equal(builderTerms(REQUIRED).required, true);
  assert.deepEqual(['1', '5', '10', '50', '100', '200', '2000'].map((r) => fmtBuilderRate(Number(r))), ['0.001%', '0.005%', '0.01%', '0.05%', '0.1%', '0.2%', '2%']);
});

// --- the fee line: shown cost == charged cost ---------------------------------------------

test('no builder configured: there is no builder fee anywhere - every quote is null', () => {
  for (const engine of ['perps', 'spot'] as const) {
    for (const side of ['buy', 'sell'] as const) {
      assert.equal(quoteBuilderFee({ builder: null, approval: null, engine, side }), null);
      assert.equal(quoteBuilderFee({ builder: null, approval: approved({ spot: 100, perps: 50 }), engine, side }), null, 'even with a stored approval');
      assert.equal(quoteBuilderFee({ builder: undefined, approval: undefined, engine, side }), null);
    }
  }
});

test('optional build: the fee is quoted exactly when the order will carry it', () => {
  const both = approved({ spot: 100, perps: 50 });
  assert.equal(quoteBuilderFee({ builder: B, approval: null, engine: 'perps', side: 'buy' }), null, 'not approved: orders go out without it');
  assert.deepEqual(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy' }), {
    builderId: B.id, rate: 50, fraction: 0.0005, charged: true, status: 'attached',
  });
  assert.equal(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'sell' })!.charged, true, 'both sides on perps');
  assert.deepEqual(quoteBuilderFee({ builder: B, approval: both, engine: 'spot', side: 'sell' }), {
    builderId: B.id, rate: 100, fraction: 0.001, charged: true, status: 'attached',
  });
  // A spot buy names the builder but SoDEX charges it nothing.
  assert.deepEqual(quoteBuilderFee({ builder: B, approval: both, engine: 'spot', side: 'buy' }), {
    builderId: B.id, rate: 100, fraction: 0.001, charged: false, status: 'attached',
  });
  // Approved on one engine only: the other shows no builder fee, because none will be charged there.
  assert.equal(quoteBuilderFee({ builder: B, approval: approved({ spot: 100 }), engine: 'perps', side: 'buy' }), null);
  assert.ok(quoteBuilderFee({ builder: B, approval: approved({ spot: 100 }), engine: 'spot', side: 'sell' }));
  // An approval for another builder account attaches nothing.
  assert.equal(quoteBuilderFee({ builder: B, approval: approved({ spot: 100, perps: 50 }, 5), engine: 'perps', side: 'buy' }), null);
  // An engine with no fee has no line.
  assert.equal(quoteBuilderFee({ builder: { ...B, fee: { perps: 50, spot: 0 } }, approval: both, engine: 'spot', side: 'sell' }), null);
});

test('required build: the fee is quoted even before it is approved - every order from here will carry it', () => {
  assert.deepEqual(quoteBuilderFee({ builder: REQUIRED, approval: null, engine: 'perps', side: 'sell' }), {
    builderId: B.id, rate: 50, fraction: 0.0005, charged: true, status: 'required',
  });
  assert.equal(quoteBuilderFee({ builder: REQUIRED, approval: approved({ perps: 50 }), engine: 'perps', side: 'sell' })!.status, 'attached');
  assert.equal(quoteBuilderFee({ builder: REQUIRED, approval: null, engine: 'spot', side: 'buy' })!.charged, false);
});

test('the fee line follows the fee OWED: a lower tier is quoted with the default beside it, and the next tier when the terms name one', () => {
  const both = approved({ spot: 100, perps: 50 });
  // No tier: exactly the quote it always was - no extra fields.
  assert.deepEqual(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy', fee: 50 }), {
    builderId: B.id, rate: 50, fraction: 0.0005, charged: true, status: 'attached',
  });
  // A lower tier: the rate the order carries, and the default it came down from.
  assert.deepEqual(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy', fee: 30 }), {
    builderId: B.id, rate: 30, fraction: 0.0003, charged: true, status: 'attached', fullRate: 50,
  });
  // The next tier is shown when it is lower than what is paid now...
  const next = { atUsd: 10, rate: 30, volumeUsd: 4.2 };
  assert.deepEqual(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy', fee: 50, next }), {
    builderId: B.id, rate: 50, fraction: 0.0005, charged: true, status: 'attached', next,
  });
  // ...and not when it is no improvement on this engine, or nonsense.
  assert.equal(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy', fee: 30, next })!.next, undefined);
  assert.equal(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy', fee: 50, next: { atUsd: 10, rate: -5, volumeUsd: null } })!.next, undefined);
  assert.equal(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy', fee: 50, next: null })!.next, undefined);
  // A fee above the default is never quoted; an unusable one is the default.
  assert.equal(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy', fee: 70 })!.rate, 50);
  assert.equal(quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy', fee: Number.NaN })!.rate, 50);
  // Required build, not approved yet: the fee owed is quoted as what every order from here will carry.
  assert.deepEqual(quoteBuilderFee({ builder: REQUIRED, approval: null, engine: 'perps', side: 'sell', fee: 30 }), {
    builderId: B.id, rate: 30, fraction: 0.0003, charged: true, status: 'required', fullRate: 50,
  });
  // Optional build, approved for less than the fee owed: no line, because the order carries none.
  assert.equal(quoteBuilderFee({ builder: B, approval: approved({ perps: 20 }), engine: 'perps', side: 'buy', fee: 30 }), null);
});

test('fee estimates: the builder part of an order\'s cost, and the total next to the venue\'s own fee', () => {
  const both = approved({ spot: 100, perps: 50 });
  const perps = quoteBuilderFee({ builder: B, approval: both, engine: 'perps', side: 'buy' });
  const spotSell = quoteBuilderFee({ builder: B, approval: both, engine: 'spot', side: 'sell' });
  const spotBuy = quoteBuilderFee({ builder: B, approval: both, engine: 'spot', side: 'buy' });
  // 10,000 notional on perps at 5 bp: 5.00 on top of the venue's 0.04 % taker (4.00) = 9.00.
  assert.equal(builderFeeOn(10_000, perps), 5);
  assert.equal(10_000 * 0.0004 + builderFeeOn(10_000, perps), 9);
  // The live mainnet fill pinned in sodex-core: 121.64 * 4.355 = 529.7422 at a builder fee of 100 -> 0.5297422.
  assert.ok(Math.abs(builderFeeOn(121.64 * 4.355, spotSell) - 0.5297422) < 1e-9);
  // A spot buy is not charged; nor is anything without a quote, or a nonsense notional.
  assert.equal(builderFeeOn(10_000, spotBuy), 0);
  assert.equal(builderFeeOn(10_000, null), 0);
  assert.equal(builderFeeOn(0, perps), 0);
  assert.equal(builderFeeOn(Number.NaN, perps), 0);
  assert.equal(builderFeeOn(-5, perps), 0);
});
