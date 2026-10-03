/**
 * Nothing secret reaches a file: the scrubber, the key redactor, the key check.
 *   npx tsx --test e2e/guide/scrub.test.ts        (from apps/web)
 *
 * Every "key" here is generated in the test (viem) or made up; none controls funds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { addressOfKey, normaliseKey, sameAddress, shortAddress } from './key';
import { REDACTED, collectTxHashes, findKeyLike, looksLikeKey, makeKeyRedactor, scrubJson, scrubText } from './scrub';

const KEY = generatePrivateKey();
const HASH = `0x${'7a'.repeat(32)}`;
const OTHER = `0x${'3c'.repeat(32)}`;

test('scrubText: anything key-sized goes, with or without 0x, in any case', () => {
  assert.equal(scrubText(`key ${KEY} end`), `key ${REDACTED} end`);
  assert.equal(scrubText(`key ${KEY.slice(2).toUpperCase()} end`), `key ${REDACTED} end`);
  assert.equal(scrubText(`a signature 0x${'ab'.repeat(65)} too`), `a signature ${REDACTED} too`);
  assert.equal(scrubText('nothing here: 0x1234, an address 0x1111111111111111111111111111111111111111'), 'nothing here: 0x1234, an address 0x1111111111111111111111111111111111111111');
});

test('scrubText: a transaction hash stays only when it came from a known hash field', () => {
  const report = { steps: [{ txs: [{ chain: 'ARBITRUM_ETH', hash: HASH, explorer: `https://arbiscan.io/tx/${HASH}` }] }], note: `mentions ${OTHER}` };
  const allow = collectTxHashes(report);
  assert.deepEqual([...allow], [HASH.slice(2)]);
  const text = `tx ${HASH} and ${OTHER} and https://arbiscan.io/tx/${HASH}`;
  assert.equal(scrubText(text, allow), `tx ${HASH} and ${REDACTED} and https://arbiscan.io/tx/${HASH}`);
});

test('collectTxHashes: a key that sits in a hash field is not a hash', () => {
  const allow = collectTxHashes({ txs: [{ hash: KEY }, { hash: HASH }] }, KEY);
  assert.equal(allow.has(KEY.slice(2).toLowerCase()), false);
  assert.equal(allow.has(HASH.slice(2)), true);
  // Without being told, the field name decides - which is why the exact-key redactor always runs as well.
  assert.equal(collectTxHashes({ hash: KEY }).has(KEY.slice(2).toLowerCase()), true);
});

test('scrubJson: deep, strings and property names, other types untouched', () => {
  const out = scrubJson({ a: 1, b: null, c: [KEY, { hash: HASH, d: `x ${KEY} y` }], [KEY]: true }, new Set([HASH.slice(2)]));
  assert.deepEqual(out, { a: 1, b: null, c: [REDACTED, { hash: HASH, d: `x ${REDACTED} y` }], [REDACTED]: true });
});

test('makeKeyRedactor: the exact key in any spelling; no key = no change', () => {
  const redact = makeKeyRedactor(KEY);
  const bare = KEY.slice(2);
  assert.equal(redact(`VS_E2E_KEY=${KEY}`), 'VS_E2E_KEY=[redacted key]');
  assert.equal(redact(`upper ${bare.toUpperCase()} and 0X-less ${bare}`), 'upper [redacted key] and 0X-less [redacted key]');
  assert.equal(redact(`another hash ${HASH}`), `another hash ${HASH}`);
  assert.equal(makeKeyRedactor(null)(`x ${KEY}`), `x ${KEY}`);
  assert.equal(makeKeyRedactor('not a key')(`x ${KEY}`), `x ${KEY}`);
});

test('findKeyLike: where a config holds something key-sized - without repeating it', () => {
  const paths = findKeyLike({ maxSpendUsd: 8, receivers: { valuechain: '0x1111111111111111111111111111111111111111', oops: KEY }, list: ['fine', KEY.slice(2)], [KEY]: 'as a name' });
  assert.deepEqual(paths.sort(), ['<a key-sized property name>', 'list[1]', 'receivers.oops'].sort());
  for (const p of paths) assert.ok(!p.includes(KEY.slice(2)));
  assert.deepEqual(findKeyLike({ a: 'b', n: 1, x: null }), []);
});

test('looksLikeKey', () => {
  assert.equal(looksLikeKey(KEY), true);
  assert.equal(looksLikeKey(` ${KEY.slice(2)} `), true);
  assert.equal(looksLikeKey('0x1111111111111111111111111111111111111111'), false);
});

// --- the key as it is typed ---------------------------------------------------------------------

test('normaliseKey: with or without 0x, spaces and quotes dropped, lower-cased', () => {
  const bare = KEY.slice(2);
  for (const typed of [KEY, bare, ` ${KEY}\r\n`, `"${bare.toUpperCase()}"`, `0X${bare}`]) {
    const r = normaliseKey(typed);
    assert.ok(r.ok, typed.length.toString());
    if (r.ok) assert.equal(r.key, KEY.toLowerCase());
  }
});

test('normaliseKey: says what is wrong by KIND and LENGTH - never by repeating the input', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /Nothing was entered/],
    ['0x1111111111111111111111111111111111111111', /wallet ADDRESS/],
    [KEY.slice(0, 40), /38 hex characters/],
    [`${KEY}ab`, /66 hex characters/],
    [`${KEY.slice(0, -1)}z`, /not hex/],
    ['abandon ability able about above absent absorb abstract absurd abuse access accident', /recovery phrase/],
    [`0x${'0'.repeat(64)}`, /all zeros/],
  ];
  for (const [typed, want] of cases) {
    const r = normaliseKey(typed);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.problem, want);
      if (typed.length > 20) assert.ok(!r.problem.includes(typed.slice(0, 20)), 'the problem text must not echo the input');
    }
  }
});

test('addressOfKey: the address viem derives; sameAddress compares without case', () => {
  const address = addressOfKey(KEY);
  assert.equal(address, privateKeyToAccount(KEY).address);
  assert.equal(sameAddress(address!, address!.toLowerCase()), true);
  assert.equal(sameAddress(address!, '0x1111111111111111111111111111111111111111'), false);
  assert.equal(sameAddress('yes', 'yes'), false);
  assert.match(shortAddress(address!), /^0x[0-9a-fA-F]{6}\.\.\.[0-9a-fA-F]{6}$/);
  // Not on the curve: no address, no throw.
  assert.equal(addressOfKey(`0x${'f'.repeat(64)}`), null);
});
