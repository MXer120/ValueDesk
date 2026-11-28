/**
 * The signed-in Blind Box (boxVault.ts): what is signed, how requests are cut, how SoDEX's job answer is read.
 * Run (from apps/web): npx tsx --test src/boxVault.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batches, checkParams, giftData, mergeAdvice, readJob, sortIds, typedRequest } from './boxVault';

const PARAMS = { chainId: 286623, verifyingContract: '0x371c4F7F68bE3e558b89cC1f0fB113851C76E750', domainName: 'SoDEXTreasureBox', domainVersion: '1', primaryType: 'RequestOpen', nonce: '17', deadline: '1795872000' };

test('sign params are signed only when they are SoDEX\'s box contract and the action\'s type', () => {
  assert.equal(checkParams(PARAMS, 'open').nonce, '17');
  assert.throws(() => checkParams(PARAMS, 'merge'), /nothing was signed/);
  assert.throws(() => checkParams({ ...PARAMS, verifyingContract: '0x0000000000000000000000000000000000000001' }, 'open'));
  assert.throws(() => checkParams({ ...PARAMS, chainId: 1 }, 'open'));
  assert.throws(() => checkParams({ ...PARAMS, domainName: 'Other' }, 'open'));
});

test('the typed request: the owner, the ids de-duplicated and ascending, SoDEX\'s nonce and deadline', () => {
  const t = typedRequest(checkParams(PARAMS, 'open'), '0xabc', ['30', '4', '30', '100']);
  assert.deepEqual(t.message, { owner: '0xabc', tokenIds: ['4', '30', '100'], nonce: '17', deadline: '1795872000' });
  assert.equal(t.primaryType, 'RequestOpen');
  assert.deepEqual(t.types.RequestOpen!.map((f) => f.type), ['address', 'uint256[]', 'uint256', 'uint256']);
  assert.deepEqual(sortIds(['10', '9', '10']), ['9', '10']);
});

test('opens are cut at the per-request cap; merges take exactly the merge size, leftovers stay', () => {
  const ids = Array.from({ length: 65 }, (_, i) => String(i + 1));
  assert.deepEqual(batches('open', ids, 30).map((b) => b.length), [30, 30, 5]);
  assert.deepEqual(batches('merge', ids, 10).map((b) => b.length), [10, 10, 10, 10, 10, 10]);
  assert.deepEqual(batches('merge', ids.slice(0, 3), 4), []);
});

test('a job: opened boxes with their reward and any Cybereator, merged boxes with what they used', () => {
  const j = readJob('j1', { status: 'revealed', boxes: [
    { tokenId: 5, level: 'Common', rewardUsd: '1.00', reward: { asset: { symbol: 'vsoUSDC' }, amount: '1.0' }, pfpTokenId: 0 },
    { tokenId: 6, level: 'Common', rewardUsd: '1.65', pfpTokenId: 2564 },
  ] });
  assert.equal(j.opened.length, 2);
  assert.equal(j.opened[0]!.pfpTokenId, null);
  assert.equal(j.opened[1]!.pfpTokenId, '2564');
  assert.equal(j.opened[1]!.rewardUsd, 1.65);
  const m = readJob('j2', { status: 'done', boxes: [{ tokenId: 900, level: 'Uncommon', consumedTokenIds: [1, 2, 3] }] });
  assert.deepEqual(m.merged, [{ tokenId: '900', level: 'Uncommon', consumed: ['1', '2', '3'] }]);
});

test('a gift is safeTransferFrom(from, to, id)', () => {
  const d = giftData('0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb', '197778');
  assert.equal(d.slice(0, 10), '0x42842e0e');
  assert.equal(d.length, 10 + 64 * 3);
  assert.equal(BigInt(`0x${d.slice(-64)}`), 197778n);
});

test('merge advice: the next tier\'s average against the boxes it uses, opened', () => {
  const t = (avg: number, median: number, n: number) => ({ n, avg, median, p25: 0, p75: 0, low: 0, high: 0, total: 0, common: [], recent: null });
  const doc = { at: 0, block: 0, boxes: 0, opens: 0, levels: { Common: t(1.05, 1, 132438), Uncommon: t(11.49, 10.41, 9772), Rare: t(142.89, 109.11, 139), SuperRare: t(465.65, 430.99, 57) } };
  const a = mergeAdvice(doc, 'Common', 'Uncommon', 10)!;
  assert.ok(Math.abs(a.gain - 0.99) < 1e-9);
  assert.ok(mergeAdvice(doc, 'Rare', 'SuperRare', 4)!.gain < 0, 'four Rares paid more opened than merged');
  assert.equal(mergeAdvice(null, 'Common', 'Uncommon', 10), null);
});
