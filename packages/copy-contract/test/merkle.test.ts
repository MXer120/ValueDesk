/**
 * Execution commitments: the leaf format v1 (spec §7.2) against viem's ABI encoder, the OpenZeppelin-compatible tree
 * (StandardMerkleTree layout, sorted pairs) with an independent verifier, and the published document. The Foundry
 * cross-check re-encodes a leaf in Solidity and verifies the proofs with OpenZeppelin's MerkleProof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, encodeAbiParameters, keccak256, toBytes } from 'viem';

import {
  EXECUTION_LEAF_PARAMS,
  EXECUTION_LEAF_TAG,
  ExecutionAction,
  type ExecutionRecord,
  type Hex,
  LeafEngine,
  LeafSide,
  SkipReason,
  buildMerkleTree,
  commitmentDocument,
  epochOf,
  executionLeaf,
  fillRef,
  hashPair,
  merkleProof,
  verifyExecution,
  verifyMerkleProof,
} from '../src/index.ts';
import { PROXY, rng } from './helpers.ts';

const record = (i: number): ExecutionRecord => ({
  copyTradingContract: PROXY,
  subscriptionId: BigInt(1 + (i % 3)),
  subscriptionVersion: 1 + (i % 4),
  action: (i % 8) as ExecutionRecord['action'],
  leaderVenue: 1 + (i % 2),
  leaderFillRef: fillRef(`fill-${i}`),
  leaderFillTimeMs: 1_790_000_000_000n + BigInt(i),
  engine: i % 2 === 0 ? LeafEngine.PERPS : LeafEngine.SPOT,
  symbol: i % 2 === 0 ? 'BTC-USD' : 'vETH_vUSDC',
  side: i % 2 === 0 ? LeafSide.BUY : LeafSide.SELL,
  reduceOnly: i % 3 === 0,
  quantity: 10n ** 18n * BigInt(i + 1),
  limitPrice: 70_000n * 10n ** 18n + BigInt(i),
  builderFee: i % 5 === 0 ? 0 : 50,
  followerTxHash: i % 4 === 0 ? `0x${'00'.repeat(32)}` : (`0x${(i + 1).toString(16).padStart(64, '0')}` as Hex),
  followerOrderTimeMs: 1_790_000_000_100n + BigInt(i),
  skipReason: i % 4 === 0 ? SkipReason.SYMBOL_FILTERED : SkipReason.NONE,
});

test('leaf v1 = keccak256(keccak256(abi.encode(tag, fields..., keccak256(symbol), ...))) as viem encodes it', () => {
  assert.equal(EXECUTION_LEAF_TAG, keccak256(toBytes('ValuescanExecution.v1')));
  for (let i = 0; i < 20; i++) {
    const r = record(i);
    const values = [
      EXECUTION_LEAF_TAG,
      r.copyTradingContract,
      r.subscriptionId,
      r.subscriptionVersion,
      r.action,
      r.leaderVenue,
      r.leaderFillRef,
      r.leaderFillTimeMs,
      r.engine,
      keccak256(toBytes(r.symbol)),
      r.side,
      r.reduceOnly,
      r.quantity,
      r.limitPrice,
      r.builderFee,
      r.followerTxHash,
      r.followerOrderTimeMs,
      r.skipReason,
    ];
    const enc = encodeAbiParameters(EXECUTION_LEAF_PARAMS as never, values as never);
    assert.equal(executionLeaf(r), keccak256(keccak256(enc)), `record ${i}`);
  }
  assert.equal(ExecutionAction.REDUCE_WHILE_PAUSED, 7);
});

/** An independent sorted-pair verifier written with viem only. */
function viemVerify(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  let h = leaf;
  for (const p of proof) h = keccak256(BigInt(h) <= BigInt(p) ? concat([h, p]) : concat([p, h]));
  return h === root;
}

test('tree: every proof verifies (ours and an independent verifier), for 1..40 leaves; wrong proofs fail', () => {
  for (let n = 1; n <= 40; n++) {
    const leaves = Array.from({ length: n }, (_, i) => executionLeaf(record(i)));
    const t = buildMerkleTree(leaves);
    for (const leaf of leaves) {
      const proof = merkleProof(t, leaf);
      assert.ok(verifyMerkleProof(t.root, leaf, proof), `n=${n}`);
      assert.ok(viemVerify(t.root, leaf, proof), `n=${n} (viem)`);
    }
    if (n > 1) assert.equal(verifyMerkleProof(t.root, leaves[0]!, merkleProof(t, leaves[1]!)), false);
  }
  assert.equal(buildMerkleTree([executionLeaf(record(0))]).root, executionLeaf(record(0)), 'one leaf: the root is the leaf');
  assert.throws(() => buildMerkleTree([]), /at least one/);
  assert.throws(() => buildMerkleTree([executionLeaf(record(0)), executionLeaf(record(0))]), /duplicate/);
  assert.equal(hashPair(`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`), hashPair(`0x${'02'.repeat(32)}`, `0x${'01'.repeat(32)}`), 'commutative');
});

test('the tree is independent of input order (sorted leaves), as StandardMerkleTree', () => {
  const r = rng(77);
  const leaves = Array.from({ length: 13 }, (_, i) => executionLeaf(record(i)));
  const shuffled = [...leaves].sort(() => r.next() - 0.5);
  assert.equal(buildMerkleTree(shuffled).root, buildMerkleTree(leaves).root);
});

test('commitmentDocument and verifyExecution against an on-chain commitment', () => {
  const records = Array.from({ length: 5 }, (_, i) => record(i));
  const doc = commitmentDocument(PROXY, 497_222n, records);
  const parsed = JSON.parse(doc.json);
  assert.equal(parsed.format, 'ValuescanExecution.v1');
  assert.equal(parsed.count, 5);
  assert.equal(parsed.root, doc.root);
  assert.equal(parsed.records[0].symbol, 'BTC-USD', 'the document shows the symbol as text');
  assert.equal(parsed.records[0].symbolHash, keccak256(toBytes('BTC-USD')));
  const onChain = { merkleRoot: doc.root, count: 5, committedAt: 1_790_003_600 };
  for (const r of parsed.records) {
    const rec = records[parsed.records.indexOf(r)]!;
    assert.ok(verifyExecution(onChain, rec, r.proof));
  }
  assert.equal(verifyExecution({ ...onChain, committedAt: 0 }, records[0]!, parsed.records[0].proof), false, 'no commitment published');
  assert.equal(verifyExecution(onChain, { ...records[0]!, builderFee: 51 }, parsed.records[0].proof), false, 'a tampered record');
  assert.equal(epochOf(1_790_000_000), 497_222n);
});
