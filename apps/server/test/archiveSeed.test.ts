import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadSeeds, seedLine } from '../src/indexer/archiveSeed.js';

test('an archive line names its venue, address and notional', () => {
  assert.deepEqual(seedLine('0xAbC\tBTC\t-0.5\t1\t80000'), { venue: 'hyperliquid', address: '0xabc', notional: 40000 });
  assert.deepEqual(seedLine('0xabc\txyz:TSLA\t10\t1\t250'), { venue: 'tradexyz', address: '0xabc', notional: 2500 });
  assert.equal(seedLine('0xabc\tpara:BTC\t1\t1\t1'), null, 'other HIP-3 dexes are no venue here');
  assert.equal(seedLine('0xabc\tBTC\t0\t1\t80000'), null);
  assert.equal(seedLine('address\tcoin\tszi\tlast_t\tlast_px'), null);
});

test('the archive loads per venue, a wallet\'s positions summed; no archive is an empty map', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  writeFileSync(join(dir, 'hl-positions.tsv.gz'), gzipSync(
    'address\tcoin\tszi\tlast_t\tlast_px\n0xa\tBTC\t1\t1\t100\n0xa\tETH\t-2\t1\t10\n0xb\txyz:NVDA\t3\t1\t5\n0xc\tmkts:X\t1\t1\t1\n'));
  const { seeds, at } = await loadSeeds(dir);
  assert.ok(at);
  assert.deepEqual([...seeds.get('hyperliquid')!], [['0xa', 120]]);
  assert.deepEqual([...seeds.get('tradexyz')!], [['0xb', 15]]);
  const none = await loadSeeds(join(dir, 'missing'));
  assert.equal(none.seeds.size, 0);
  assert.equal(none.at, null);
});
