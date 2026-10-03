/**
 * The run config as the guide writes it.
 *   npx tsx --test e2e/guide/config.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyChoices,
  builderKeyNames,
  builderSection,
  configProblems,
  describeConfig,
  parseConfigText,
  receiversSet,
  saveConfig,
  serializeConfig,
  type BuilderChoice,
  type BuilderKeyNames,
  type Json,
} from './config';

const TODAY: BuilderKeyNames = { max: 'maxFee', address: false, required: true, termsKeys: null };
const BUILDER: BuilderChoice = { id: 12345, address: `0x${'b'.repeat(40)}`, feePerps: 20, feeSpot: 100, maxFee: 100, revokeAtEnd: true, termsKeys: ['PUBKEY'] };

const example = (): Json => ({
  '//': 'a comment key the runner ignores',
  acknowledgeRealFunds: false,
  backend: 'http://127.0.0.1:5180',
  maxSpendUsd: 8,
  allowExistingAccount: false,
  deposit: { chain: 'ARBITRUM_ETH', amount: '25' },
  withdrawExternal: { coin: 'USDC', chain: 'ARBITRUM_ETH', amount: '5', receiver: 'self' },
  receivers: { valuechain: '' },
  cleanup: { enabled: false, chain: 'ARBITRUM_ETH' },
  builder: null,
});

test('builderKeyNames: read from the runner\'s own key list', () => {
  const src = "const b = obj(src.builder, 'builder', ['id', 'feePerps', 'feeSpot', 'maxFee', 'required', 'revokeAtEnd']);";
  assert.deepEqual(builderKeyNames(src), TODAY);
  const later = "obj(src.builder, 'builder', ['id', 'address', 'feePerps', 'feeSpot', 'maxFeeRate', 'termsKeys', 'revokeAtEnd'])";
  assert.deepEqual(builderKeyNames(later), { max: 'maxFeeRate', address: true, required: false, termsKeys: 'termsKeys' });
});

test('builderKeyNames: no source at all = the shape of 2026-10-02; an example that names termsKeys is believed', () => {
  assert.deepEqual(builderKeyNames(null), TODAY);
  assert.equal(builderKeyNames(null, '{"// builder": "{ id, feePerps, feeSpot, maxFeeRate, termsKeys, revokeAtEnd }"}').max, 'maxFeeRate');
  assert.equal(builderKeyNames(null, '{"// builder": "{ id, feePerps, feeSpot, maxFee, termsKeys }"}').termsKeys, 'termsKeys');
});

test('the real runner source parses (so a rename there is noticed here)', () => {
  const file = fileURLToPath(new URL('../live/config.ts', import.meta.url));
  if (!existsSync(file)) return; // the runner is not in this checkout
  const names = builderKeyNames(readFileSync(file, 'utf8'));
  assert.ok(names.max === 'maxFee' || names.max === 'maxFeeRate');
});

test('builderSection: a configured builder is REQUIRED; only the fields this runner knows are written', () => {
  assert.deepEqual(builderSection(BUILDER, TODAY), { id: 12345, feePerps: 20, feeSpot: 100, maxFee: 100, required: true, revokeAtEnd: true });
  assert.deepEqual(builderSection(BUILDER, { max: 'maxFeeRate', address: true, required: false, termsKeys: 'termsKeys' }), {
    id: 12345,
    address: BUILDER.address,
    feePerps: 20,
    feeSpot: 100,
    maxFeeRate: 100,
    revokeAtEnd: true,
    termsKeys: ['PUBKEY'],
  });
});

test('applyChoices: sets what was chosen, keeps everything else - comments and order included', () => {
  const base = example();
  const out = applyChoices(base, { acknowledgeRealFunds: true, builder: BUILDER, receivers: { valuechain: `0x${'c'.repeat(40)}`, xrp: { address: 'rXYZ', memo: '77' } }, cleanupEnabled: true }, TODAY);
  assert.deepEqual(Object.keys(out), Object.keys(base));
  assert.equal(out['//'], base['//']);
  assert.equal(out.acknowledgeRealFunds, true);
  assert.deepEqual(out.builder, builderSection(BUILDER, TODAY));
  assert.deepEqual(out.receivers, { valuechain: `0x${'c'.repeat(40)}`, xrp: { address: 'rXYZ', memo: '77' } });
  assert.deepEqual(out.cleanup, { enabled: true, chain: 'ARBITRUM_ETH' });
  // The input is not touched.
  assert.equal(base.acknowledgeRealFunds, false);
  assert.equal(base.builder, null);
});

test('applyChoices: undefined leaves a section alone, null switches the builder off, "" clears a receiver', () => {
  const withBuilder = applyChoices(example(), { builder: BUILDER, receivers: { valuechain: '0xabc' } }, TODAY);
  assert.deepEqual(applyChoices(withBuilder, {}, TODAY), withBuilder);
  assert.equal(applyChoices(withBuilder, { builder: null }, TODAY).builder, null);
  assert.deepEqual(receiversSet(applyChoices(withBuilder, { receivers: { valuechain: '' } }, TODAY)), []);
});

test('a key in the config is refused, and never written', () => {
  const key = `0x${'5e'.repeat(32)}`; // made up; controls nothing
  const bad = { ...example(), receivers: { valuechain: key } };
  const problems = configProblems(bad);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /size of a private key at: receivers\.valuechain/);
  assert.ok(!problems[0]!.includes(key.slice(2)));
  const dir = mkdtempSync(join(tmpdir(), 'vs-guide-cfg-'));
  try {
    const file = join(dir, 'config.json');
    assert.throws(() => saveConfig(file, bad), /private key/);
    assert.equal(existsSync(file), false);
    saveConfig(file, example());
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), example());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(configProblems(example()), []);
});

test('parseConfigText and serializeConfig', () => {
  assert.deepEqual(parseConfigText('{"a":1}', 'config.json'), { ok: true, config: { a: 1 } });
  const bad = parseConfigText('{oops', 'config.json');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.problem, /config\.json is not valid JSON/);
  assert.equal(parseConfigText('[1]', 'config.json').ok, false);
  assert.equal(serializeConfig({ a: 1 }), '{\n  "a": 1\n}\n');
});

test('describeConfig: the settings that decide what a live run does, in words', () => {
  const lines = describeConfig(applyChoices(example(), { builder: BUILDER, receivers: { valuechain: '0xabc' }, allowExistingAccount: true }, { ...TODAY, termsKeys: 'termsKeys' }));
  const text = lines.join('\n');
  assert.match(text, /spend cap \.+ \$8/);
  assert.match(text, /deposit \.+ 25 USDC from ARBITRUM_ETH/);
  assert.match(text, /other receivers \.+ valuechain = 0xabc/);
  assert.match(text, /cleanup at the end \.+ no/);
  assert.match(text, /builder fee \.+ builder account #12345, perps 20 \/ spot 100 .*revoked at the end, fee tiers on/);
  assert.match(text, /existing account \.+ allowed/);
  assert.match(describeConfig(example()).join('\n'), /builder fee \.+ off/);
});
