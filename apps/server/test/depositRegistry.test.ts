/**
 * A DEPOSIT MUST NOT BE ADDRESSED BY SYMBOL ALONE.
 *
 * Symbols are not unique on ValueChain. Two ERC-20s both call themselves
 * `vGRAM`, both declare 9 decimals, and both are named "SoDexToken: GRAM":
 *
 *     0x99b2d9978922f573A5313bB7301f61c3ea6bBb1A   <- SoDEX's own list names this
 *     0xe2896008BEf7b9e35C446AA9be79448790767198
 *
 * `depositRegistry()` resolved a coin to a contract with
 * `new Map(tokens.map(t => [t.symbol, t]))`, where the LAST write wins, so the
 * address it produced depended on the explorer's pagination order. Both existing
 * safety nets are blind to it: the decimals guard passes (9 === 9) and the name
 * check passes (identical strings).
 *
 * The failure is not a rejected deposit. It is a SUCCESSFUL transfer to a
 * contract the exchange does not credit - unrecoverable, and silent.
 *
 * These tests pin the resolution RULE rather than calling the network: the rule
 * is the thing that was wrong, and a test that needs the live chain would not
 * run in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const chain = readFileSync(join(SRC, 'sodex', 'chain.ts'), 'utf8');

test('the registry consults SoDEX\'s own address-bearing list', () => {
  assert.match(
    chain,
    /tradable-tokens/,
    'chain.ts must fetch /{net}/chain/tradable-tokens - the only source that maps a symbol to ONE address',
  );
  assert.match(chain, /officialBySymbol/, 'the authoritative list needs its own lookup');
});

test('SoDEX beats the explorer, never the other way round', () => {
  const get = chain.slice(chain.indexOf('const bySymbol = {'), chain.indexOf('const assets: DepositAsset[]'));
  assert.ok(get.length > 0, 'bySymbol lookup not found');
  const off = get.indexOf('officialBySymbol.get');
  const exp = get.indexOf('explorerBySymbol.get');
  assert.ok(off !== -1 && exp !== -1, 'both sources must be consulted');
  assert.ok(off < exp, 'the authoritative list must be checked BEFORE the explorer');
});

test('an ambiguous symbol is refused, not guessed', () => {
  assert.match(
    chain,
    /if \(ambiguous\.has\(k\)\) return undefined;/,
    'two contracts with one symbol and no authoritative answer must yield NO deposit address',
  );
});

test('the last-write-wins map is gone', () => {
  /*
   * The exact shape of the bug. `new Map(tokens.map(...))` over a list keyed by
   * symbol silently keeps the last duplicate, which is how a deposit ended up
   * addressed to whichever vGRAM the explorer returned second.
   */
  assert.doesNotMatch(
    chain,
    /new Map\(tokens\.map\(\(t\) => \[t\.symbol\.toLowerCase\(\), t\]\)\)/,
    'symbol-keyed last-write-wins map must not come back',
  );
});
