/**
 * Stage C's pure parts: eligibility, fees, tiers, the app's settings, the signed terms.
 *   npx tsx --test e2e/guide/builder.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  appendEnvText,
  builderCheckLines,
  builderEnvLines,
  classifyBuilderInput,
  feeBp,
  feePercent,
  hasPrivateKeyField,
  judgeBuilder,
  lastJsonLine,
  makeBuilderChoice,
  parseEnv,
  parseFee,
  planEnvAppend,
  readCheckBuilderJson,
  readTiersJson,
  tierLines,
  tiersProblems,
  whatToMove,
} from './builder';
import { TERMS_CHAIN, isTermsNonce, judgeTerms, keyIdOf, rawPublicKey, termsMessage, verifyTermsSignature } from './terms';

const ADDR = `0x${'a1'.repeat(20)}`;

test('fee units: tenths of a basis point', () => {
  assert.equal(feePercent(50), '0.05 %');
  assert.equal(feePercent(100), '0.1 %');
  assert.equal(feePercent(15), '0.015 %');
  assert.equal(feeBp(20), '2 bp');
  assert.equal(feeBp(15), '1.5 bp');
});

test('a typed fee: Enter = the default, whole numbers up to the cap, nothing else', () => {
  assert.deepEqual(parseFee('', 200, 50), { ok: true, value: 50 });
  assert.deepEqual(parseFee(' 20 ', 200, 50), { ok: true, value: 20 });
  assert.deepEqual(parseFee('0', 200, 50), { ok: true, value: 0 });
  for (const bad of ['201', '1.5', '-1', 'five', '0x10']) assert.equal(parseFee(bad, 200, 50).ok, false, bad);
  assert.deepEqual(parseFee('2000', 2000, 100), { ok: true, value: 2000 });
});

test('the builder choice: the approved ceiling is what is charged - or the tier file\'s, when that covers it', () => {
  assert.equal(makeBuilderChoice({ id: 1, feePerps: 50, feeSpot: 100, revokeAtEnd: true }).maxFee, 100);
  assert.equal(makeBuilderChoice({ id: 1, feePerps: 20, feeSpot: 20, revokeAtEnd: true, maxFeeRate: 20 }).maxFee, 20);
  assert.equal(makeBuilderChoice({ id: 1, feePerps: 20, feeSpot: 10, revokeAtEnd: true, maxFeeRate: 200 }).maxFee, 200);
  // A ceiling BELOW a fee would switch the builder off in the app: never written.
  assert.equal(makeBuilderChoice({ id: 1, feePerps: 20, feeSpot: 100, revokeAtEnd: true, maxFeeRate: 20 }).maxFee, 100);
  const b = makeBuilderChoice({ id: 7, address: ADDR, feePerps: 20, feeSpot: 0, revokeAtEnd: false, termsKeys: ['K'] });
  assert.deepEqual(b, { id: 7, address: ADDR, feePerps: 20, feeSpot: 0, maxFee: 20, revokeAtEnd: false, termsKeys: ['K'] });
});

test('what the owner typed for the builder: an address, an id - and a key is called a key', () => {
  assert.deepEqual(classifyBuilderInput(` ${ADDR} `), { kind: 'address', address: ADDR });
  assert.deepEqual(classifyBuilderInput('#223169'), { kind: 'id', id: 223169 });
  assert.equal(classifyBuilderInput('0').kind, 'bad');
  assert.equal(classifyBuilderInput('builder').kind, 'bad');
  const key = classifyBuilderInput(`0x${'9f'.repeat(32)}`);
  assert.equal(key.kind, 'bad');
  if (key.kind === 'bad') assert.match(key.problem, /PRIVATE KEY/);
});

test('eligibility: 100 vUSDC in Spot AND in Perps - and exactly what is missing', () => {
  const ok = judgeBuilder({ address: ADDR, builderId: 12345, spot: 130.5, perps: 100 });
  assert.equal(ok.eligible, true);
  assert.deepEqual(ok.missing, []);
  const low = judgeBuilder({ address: ADDR, builderId: 12345, spot: 37.5, perps: 99.999999 });
  assert.equal(low.eligible, false);
  assert.deepEqual(low.missing, ['Spot holds 37.5 vUSDC - it needs 100: short by 62.5 vUSDC.', 'Perps holds 99.999999 vUSDC - it needs 100: short by 0.000001 vUSDC.']);
  const none = judgeBuilder({ address: ADDR, builderId: null, spot: null, perps: null });
  assert.equal(none.eligible, false);
  assert.match(none.missing[0]!, /no SoDEX account yet/);
  const locked = judgeBuilder({ address: ADDR, builderId: 1, spot: 120, perps: 100, spotLocked: 40 });
  assert.equal(locked.eligible, true);
  assert.match(locked.notes[0]!, /Only 80 vUSDC of the Spot balance is free/);
});

test('check-builder.mjs --json: both of its answers', () => {
  const full = readCheckBuilderJson(`{"network":"mainnet","address":"${ADDR}","builderId":12345,"spot":{"total":130.5,"locked":0},"perps":{"total":100,"locked":0},"eligible":true,"env":["VITE_BUILDER_ID=12345"]}`);
  assert.equal(full?.eligible, true);
  assert.equal(full?.builderId, 12345);
  assert.deepEqual(builderCheckLines(full!), [`wallet ............ ${ADDR}`, 'builder ID ........ 12345   (the account ID)', 'Spot  ............. 130.5 vUSDC   ok (at least 100)', 'Perps ............. 100 vUSDC   ok (at least 100)']);
  const none = readCheckBuilderJson(`{"network":"mainnet","address":"${ADDR}","builderId":null,"eligible":false,"reason":"no account"}`);
  assert.equal(none?.eligible, false);
  assert.equal(none?.builderId, null);
  assert.equal(builderCheckLines(none!).length, 2);
  assert.equal(readCheckBuilderJson('could not read the account: timeout'), null);
});

test('lastJsonLine: one compact line, a pretty-printed object, log lines around it', () => {
  assert.deepEqual(lastJsonLine('{"a":1}'), { a: 1 });
  assert.deepEqual(lastJsonLine('{\n  "a": 1,\n  "tiers": [\n    { "minVolumeUsd": 0 }\n  ]\n}\n'), { a: 1, tiers: [{ minVolumeUsd: 0 }] });
  assert.deepEqual(lastJsonLine('note: wrote the key\n{"a":2}\ndone'), { a: 2 });
  assert.equal(lastJsonLine('nothing'), null);
});

// --- fee tiers --------------------------------------------------------------------------------

const TOOL_INIT = JSON.stringify({ configPath: 'C:\\data\\builder-tiers.json', keyPath: 'C:\\data\\builder-terms.key', publicKey: 'PUB', keyId: '1a2b3c4d', builderId: 12345, tiers: [{ minVolumeUsd: 10, perps: 15, spot: 20 }, { minVolumeUsd: 0, perps: 20, spot: 20 }] }, null, 2);

test('the tier tool\'s answer: paths, the PUBLIC key, the tiers in order', () => {
  const t = readTiersJson(TOOL_INIT)!;
  assert.equal(t.publicKey, 'PUB');
  assert.equal(t.keyId, '1a2b3c4d');
  assert.equal(t.builderId, 12345);
  assert.deepEqual(t.tiers, [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 15, spot: 20 }]);
  assert.equal(t.valid, null);
  assert.deepEqual(tiersProblems(t, 12345), []);
  const lines = tierLines(t.tiers);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^from \$0 to \$10 of volume\s+perps 2 bp \(20\), spot 2 bp \(20\)$/);
  assert.match(lines[1]!, /^from \$10 of volume\s+perps 1\.5 bp \(15\), spot 2 bp \(20\)$/);
  assert.equal(readTiersJson('error: no such command'), null);
  assert.equal(readTiersJson('{"hello":"world"}'), null);
});

test('tier problems: another builder, an invalid file, no key', () => {
  const t = readTiersJson(TOOL_INIT)!;
  assert.deepEqual(tiersProblems(t, 999), ['the tiers file is for builder #12345, not #999']);
  const status = readTiersJson(JSON.stringify({ configPath: 'x', valid: false, problems: ['tiers[1].perps is above the first tier'], builderId: 12345, tiers: [], keyPath: 'k', publicKey: null, keyId: null }))!;
  assert.deepEqual(tiersProblems(status, 12345), ['the tiers file is not valid: tiers[1].perps is above the first tier', 'the tool printed no tiers', 'the tool printed no public key (is the terms key file there?)']);
});

test('a tool answer that carries a private key is recognised as one', () => {
  assert.equal(hasPrivateKeyField({ publicKey: 'PUB', keyId: 'x' }), false);
  assert.equal(hasPrivateKeyField({ privateKey: 'whatever' }), true);
  assert.equal(hasPrivateKeyField({ key: '-----BEGIN PRIVATE KEY-----\nMC4C...' }), true);
  assert.equal(hasPrivateKeyField(null), false);
});

// --- the app's settings -------------------------------------------------------------------------

test('the .env.local lines: ID, the two fees, the ceiling - and the terms key only with tiers', () => {
  assert.deepEqual(builderEnvLines(makeBuilderChoice({ id: 12345, feePerps: 50, feeSpot: 100, revokeAtEnd: true })), ['VITE_BUILDER_ID=12345', 'VITE_BUILDER_FEE_PERPS=50', 'VITE_BUILDER_FEE_SPOT=100', 'VITE_BUILDER_MAX_FEE=100']);
  assert.deepEqual(builderEnvLines(makeBuilderChoice({ id: 12345, feePerps: 20, feeSpot: 20, revokeAtEnd: true, maxFeeRate: 20, termsKeys: ['PUB', 'OLD'] })), [
    'VITE_BUILDER_ID=12345',
    'VITE_BUILDER_FEE_PERPS=20',
    'VITE_BUILDER_FEE_SPOT=20',
    'VITE_BUILDER_MAX_FEE=20',
    'VITE_BUILDER_TERMS_KEYS=PUB,OLD',
  ]);
});

test('parseEnv: assignments only - comments, blanks and commented-out lines are not values', () => {
  const env = parseEnv('# a comment\nVITE_WALLETCONNECT_PROJECT_ID=abc\n\n# VITE_BUILDER_ID=1\nexport FOO="bar baz"\nX = 1  # trailing\nVITE_BUILDER_ID=7\nVITE_BUILDER_ID=8\r\n');
  assert.deepEqual([...env], [['VITE_WALLETCONNECT_PROJECT_ID', 'abc'], ['FOO', 'bar baz'], ['X', '1'], ['VITE_BUILDER_ID', '8']]);
});

test('appending to .env.local: only what is missing; an existing line is NEVER changed', () => {
  const lines = ['VITE_BUILDER_ID=12345', 'VITE_BUILDER_FEE_PERPS=20', 'VITE_BUILDER_FEE_SPOT=20', 'VITE_BUILDER_MAX_FEE=20', 'VITE_BUILDER_TERMS_KEYS=PUB'];
  const existing = 'VITE_WALLETCONNECT_PROJECT_ID=abc\nVITE_BUILDER_ID=12345\nVITE_BUILDER_FEE_PERPS=50';
  const plan = planEnvAppend(existing, lines);
  assert.deepEqual(plan.same, ['VITE_BUILDER_ID=12345']);
  assert.deepEqual(plan.conflicts, [{ name: 'VITE_BUILDER_FEE_PERPS', existing: '50', wanted: '20' }]);
  assert.deepEqual(plan.append, ['VITE_BUILDER_FEE_SPOT=20', 'VITE_BUILDER_MAX_FEE=20', 'VITE_BUILDER_TERMS_KEYS=PUB']);
  const text = appendEnvText(existing, plan, '2026-10-02');
  assert.ok(text.startsWith(`${existing}\n`), 'every existing byte is kept, in place');
  assert.match(text, /\n# Builder fee test settings - added by RUN-LIVE-TESTS on 2026-10-02 .*\nVITE_BUILDER_FEE_SPOT=20\nVITE_BUILDER_MAX_FEE=20\nVITE_BUILDER_TERMS_KEYS=PUB\n$/);
  assert.equal(parseEnv(text).get('VITE_BUILDER_FEE_PERPS'), '50');
  // Nothing missing: the file is returned as it is.
  assert.equal(appendEnvText(existing, planEnvAppend(existing, ['VITE_BUILDER_ID=12345']), 'x'), existing);
  // A new file.
  assert.match(appendEnvText('', planEnvAppend('', ['A=1']), 'x'), /^\n# Builder fee test settings.*\nA=1\n$/);
});

test('what to move: a transfer where one side can spare it, a deposit only for what neither can - exact amounts', () => {
  const at = (spot: number | null, perps: number | null, id: number | null = 7) => whatToMove(judgeBuilder({ address: ADDR, builderId: id, spot, perps }));
  assert.deepEqual(at(130, 102), [], 'eligible: nothing');
  assert.deepEqual(at(230.5, 40), ['Transfer 60 vUSDC from "SoDEX Spot" to "SoDEX Futures" (Perps).']);
  assert.deepEqual(at(80, 150), ['Transfer 20 vUSDC from "SoDEX Futures" (Perps) to "SoDEX Spot".']);
  assert.deepEqual(at(130.5, 40), ['Deposit 29.5 USDC (or more) to the builder account - it lands in "SoDEX Spot".', 'Then Transfer 60 vUSDC from "SoDEX Spot" to "SoDEX Futures" (Perps).']);
  assert.deepEqual(at(50, 110), ['Deposit 40 USDC (or more) to the builder account - it lands in "SoDEX Spot".', 'Transfer 10 vUSDC from "SoDEX Futures" (Perps) to "SoDEX Spot".']);
  assert.deepEqual(at(10, 20), ['Deposit 170 USDC (or more) to the builder account - it lands in "SoDEX Spot".', 'Then Transfer 80 vUSDC from "SoDEX Spot" to "SoDEX Futures" (Perps).']);
  assert.match(at(null, null, null)[0]!, /Deposit at least 201 USDC/);
  assert.match(at(null, 120)[0]!, /could not be read/);
});

// --- signed terms (docs/BUILDER-TIERS.md section 3) -----------------------------------------------

/** A terms key made for this test - what the server holds, and its public half as the app pins it. */
function termsKey(): { pub: string; signTerms: (message: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pub: raw.toString('base64url'), signTerms: (m) => sign(null, Buffer.from(m, 'utf8'), privateKey).toString('base64url') };
}

const NONCE = 'n0nce_n0nce_n0nce_1234';

function answer(k: ReturnType<typeof termsKey>, o: Partial<{ perps: number; spot: number; builderId: number; address: string; nonce: string; ttl: number; issued: number }> = {}, now = 1_790_000_000_000): Record<string, unknown> {
  const f = { chain: TERMS_CHAIN, builderId: o.builderId ?? 12345, address: o.address ?? ADDR, perps: o.perps ?? 20, spot: o.spot ?? 20, nonce: o.nonce ?? NONCE, issued: o.issued ?? now, ttl: o.ttl ?? 600_000 };
  return {
    ok: true,
    chain: f.chain,
    builderId: f.builderId,
    address: f.address,
    fee: { perps: f.perps, spot: f.spot },
    nonce: f.nonce,
    issued: f.issued,
    ttl: f.ttl,
    keyId: keyIdOf(k.pub),
    sig: k.signTerms(termsMessage(f)),
    default: { perps: 20, spot: 20 },
    volume: { perpsUsd: 0, spotUsd: 0, totalUsd: 0, verifiedAt: now, pending: false },
    tier: { index: 0, next: { atUsd: 10, fee: { perps: 15, spot: 20 } } },
    flags: [],
  };
}
const NOW = 1_790_000_000_000;
const expect = (k: ReturnType<typeof termsKey>): Parameters<typeof judgeTerms>[2] => ({ address: ADDR, nonce: NONCE, builderId: 12345, publicKeys: [k.pub], cacheControl: 'no-store', now: NOW });

test('the signed message is exactly the contract\'s bytes', () => {
  assert.equal(
    termsMessage({ chain: 286623, builderId: 123456, address: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD', perps: 15, spot: 100, nonce: 'abc', issued: 1790000000000, ttl: 600000 }),
    'valuescan-builder-terms/1\nchain:286623\nbuilder:123456\naddress:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd\nperps:15\nspot:100\nnonce:abc\nissued:1790000000000\nttl:600000',
  );
});

test('a terms answer the app would accept: the signature verifies under the pinned key', () => {
  const k = termsKey();
  assert.equal(rawPublicKey(k.pub)?.length, 32);
  assert.match(keyIdOf(k.pub)!, /^[0-9a-f]{8}$/);
  const v = judgeTerms(200, answer(k), expect(k));
  assert.equal(v.status, 'PASS', v.detail);
  assert.match(v.detail, /perps 20 \/ spot 20 \(default 20 \/ 20\), valid 10 min, signature verifies/);
  assert.deepEqual(v.fee, { perps: 20, spot: 20 });
  assert.deepEqual(v.next, { atUsd: 10, perps: 15, spot: 20 });
});

test('every way a terms answer can be wrong is named', () => {
  const k = termsKey();
  const other = termsKey();
  const bad = (body: unknown, x: Partial<Parameters<typeof judgeTerms>[2]> = {}, status = 200): string => {
    const v = judgeTerms(status, body, { ...expect(k), ...x });
    assert.equal(v.status, 'FAIL', v.detail);
    return v.detail;
  };
  assert.match(bad(answer(other)), /signature does NOT verify/); // signed with another key
  assert.match(bad({ ...answer(k), fee: { perps: 15, spot: 20 } }), /signature does NOT verify/); // a fee changed on the way
  assert.match(bad(answer(k, { builderId: 999 })), /signs for builder #999, not #12345/);
  assert.match(bad(answer(k, { address: `0x${'bb'.repeat(20)}` })), /another address/);
  assert.match(bad(answer(k, { nonce: 'replayed_replayed_1' })), /nonce was not echoed/);
  assert.match(bad(answer(k, { perps: 25 })), /above the default/);
  assert.match(bad(answer(k, { ttl: 0 })), /ttl is 0 ms - the app needs a positive one/);
  assert.match(bad(answer(k), { cacheControl: 'public, max-age=10' }), /not no-store/);
  assert.match(bad({ ...answer(k), sig: null, keyId: null }), /NOT SIGNED/);
  assert.match(bad({ ok: true, builderId: null }), /fee tiers are OFF/);
  assert.match(bad({ ok: false, error: 'bad nonce' }), /bad nonce/);
  assert.match(bad({ ok: false, code: 'unavailable', error: 'the volume store is not open' }), /not ok \(unavailable\): the volume store is not open - every order carries the default fee/);
  assert.match(bad({ error: 'not found' }, {}, 404), /no \/api\/vs\/builder\/terms route yet/);
});

test('what the app tolerates is a warning, not a failure: a long ttl, an odd issued time, a wrong keyId', () => {
  const k = termsKey();
  const warn = (body: unknown): string => {
    const v = judgeTerms(200, body, expect(k));
    assert.equal(v.status, 'WARN', v.detail);
    assert.match(v.detail, /signature verifies/);
    return v.detail;
  };
  assert.match(warn(answer(k, { ttl: 3_600_000 })), /ttl is 3600000 ms; the app cuts it to 900000/);
  assert.match(warn(answer(k, { issued: NOW - 3_600_000 })), /3600 s away from this computer's clock/);
  assert.match(warn({ ...answer(k), keyId: 'deadbeef' }), /keyId says deadbeef, the key that verifies has id [0-9a-f]{8} \(the app accepts it anyway\)/);
  // The server's own header as the contract writes it.
  assert.equal(judgeTerms(200, answer(k), { ...expect(k), cacheControl: 'no-store, no-transform' }).status, 'PASS');
});

test('the contract\'s fixed vector (docs/BUILDER-TIERS.md section 3): message, keyId and signature, byte for byte', () => {
  const pub = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
  const message = termsMessage({ chain: 286623, builderId: 123456, address: `0x${'ab'.repeat(20)}`, perps: 15, spot: 20, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', issued: 1790000000000, ttl: 600000 });
  assert.equal(message, `valuescan-builder-terms/1\nchain:286623\nbuilder:123456\naddress:0x${'ab'.repeat(20)}\nperps:15\nspot:20\nnonce:AAAAAAAAAAAAAAAAAAAAAA\nissued:1790000000000\nttl:600000`);
  assert.equal(keyIdOf(pub), '56475aa7');
  const sig = 'jGEDlHgiyK5gGlaulDSDIgY-yC3vRb-ZnG7YdQzqUpoq9vF4pTlFnJU7RtNTqh0MXeB8jDge9HZsZF21PWR_Cw';
  assert.equal(verifyTermsSignature(message, sig, pub), true);
  assert.equal(verifyTermsSignature(message.replace('perps:15', 'perps:14'), sig, pub), false);
  // The seed is public (00 01 ... 1f): deriving the key from it must give the pinned public key.
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  assert.equal(createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), pub);
  assert.equal(sign(null, Buffer.from(message, 'utf8'), priv).toString('base64url'), sig);
});

test('terms without expectations: tiers off is a warning, an unverifiable signature too', () => {
  const k = termsKey();
  assert.equal(judgeTerms(200, { ok: true, builderId: null }, { ...expect(k), builderId: null }).status, 'WARN');
  const unknownKey = judgeTerms(200, answer(k), { ...expect(k), publicKeys: [] });
  assert.equal(unknownKey.status, 'WARN');
  assert.match(unknownKey.detail, /signature not checked/);
});

test('signature and nonce helpers refuse malformed input instead of throwing', () => {
  const k = termsKey();
  assert.equal(verifyTermsSignature('m', 'not base64url!!', k.pub), false);
  assert.equal(verifyTermsSignature('m', 'AAAA', k.pub), false);
  assert.equal(verifyTermsSignature('m', k.signTerms('m'), 'short'), false);
  assert.equal(verifyTermsSignature('m', k.signTerms('m'), k.pub), true);
  assert.equal(verifyTermsSignature('other', k.signTerms('m'), k.pub), false);
  assert.equal(isTermsNonce(NONCE), true);
  assert.equal(isTermsNonce('short'), false);
  assert.equal(isTermsNonce('has spaces in it 1234'), false);
});
