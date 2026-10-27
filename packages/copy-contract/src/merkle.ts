/**
 * Execution commitments (COPY-TRADING.md §7.2): leaf format v1, an OpenZeppelin-compatible Merkle tree, and the
 * document an executor publishes.
 *
 * Per epoch (the unix hour, floor(t / 3600)) an authorised executor records one leaf per copy decision, including
 * skips, builds the tree, publishes the document (every record, its leaf and its proof) at a URI, and then calls
 *
 *   commitExecutions(epoch, tree.root, tree.leaves.length, uri)          // calls.commitExecutions(...)
 *
 * The contract stores {merkleRoot, count, committedAt} and does NOT verify anything. Anyone checks a record off-chain:
 * `verifyExecution(commitment(executor, epoch), record, proof)` here (OpenZeppelin `MerkleProof.verify` semantics), and
 * the order itself on clobscan.
 *
 * The tree is the @openzeppelin/merkle-tree StandardMerkleTree layout (leaves double-hashed, sorted by hash, stored in
 * a complete binary tree array, commutative keccak for pairs), so its proofs verify with MerkleProof.verify. The
 * Foundry cross-check re-encodes a leaf in Solidity and verifies every proof with OpenZeppelin's MerkleProof.
 */
import { encodeAbiParameters, type AbiParameter } from './abiCodec.ts';
import { type Address, type Hex, bytesToHex, compareBytes, concatBytes, hexToBytes, keccak256, keccakUtf8, lowerAddress } from './bytes.ts';
import { COMMITMENT_EPOCH_SECONDS, EXECUTION_LEAF_TAG_STRING } from './constants.ts';
import { symbolHash } from './eip712.ts';
import type { Commitment } from './types.ts';

/** keccak256("ValuescanExecution.v1"). */
export const EXECUTION_LEAF_TAG: Hex = keccakUtf8(EXECUTION_LEAF_TAG_STRING);

/** What the executor did for one leader signal and subscription. */
export const ExecutionAction = {
  MIRROR: 0,
  SKIP: 1,
  COPY_EXISTING: 2,
  STOP_LOSS: 3,
  DRAWDOWN_HALT: 4,
  TAKE_PROFIT_HALT: 5,
  STOP_FLATTEN: 6,
  REDUCE_WHILE_PAUSED: 7,
} as const;
export type ExecutionAction = (typeof ExecutionAction)[keyof typeof ExecutionAction];

/** SoDEX engine in leaves: 0 spot, 1 perps. */
export const LeafEngine = { SPOT: 0, PERPS: 1 } as const;
export const LeafSide = { BUY: 0, SELL: 1 } as const;

/**
 * `skipReason` codes (spec §7.2: "0 none; otherwise a documented code"). This list IS the documentation: append new
 * codes, never renumber.
 */
export const SkipReason = {
  NONE: 0,
  /** Unknown or STOPPED subscription. */
  NOT_COPYABLE: 1,
  /** PAUSED or expired: the part that would open or increase was dropped. */
  REDUCE_ONLY: 2,
  /** Cycle protection: the leader fill came from an order signed by a key ValueDesk executes for. */
  COPY_OF_COPY: 3,
  /** The signal was older than the published staleness limit. */
  STALE_SIGNAL: 4,
  /** A Hyperliquid coin without a SoDEX symbol. */
  UNMAPPED_SYMBOL: 5,
  /** The engine is outside `marketScope`. */
  OUT_OF_SCOPE: 6,
  /** The symbol filter (ALLOW / DENY) excluded it. */
  SYMBOL_FILTERED: 7,
  /** Clipped to nothing by maxPositionNotional or allocationCap. */
  CAPPED_TO_ZERO: 8,
  /** Below the venue's minimum order size after sizing. */
  BELOW_MIN_SIZE: 9,
  /** An opening order would need a builder approval the follower has not given on SoDEX. */
  NO_BUILDER_APPROVAL: 10,
  /** Preflight failed (account, key or approval). */
  PREFLIGHT_FAILED: 11,
  /** Halted by the drawdown stop or the take profit until the follower re-arms it. */
  HALTED: 12,
} as const;
export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

/** One execution record. Field order is the leaf's ABI order (the tag first). */
export interface ExecutionRecord {
  /** The ValuescanCopyTrading PROXY. */
  copyTradingContract: Address;
  subscriptionId: bigint;
  /** The subscription version the executor acted on. */
  subscriptionVersion: number;
  action: ExecutionAction;
  leaderVenue: number;
  /** keccak256 of the venue's fill id (see `fillRef`); zero if none. */
  leaderFillRef: Hex;
  leaderFillTimeMs: bigint;
  engine: number;
  /** The SoDEX symbol as text; the leaf holds keccak256(bytes(symbol)), as in the symbol commitment. */
  symbol: string;
  side: number;
  reduceOnly: boolean;
  /** 1e18 fixed point. */
  quantity: bigint;
  /** 1e18 fixed point. */
  limitPrice: bigint;
  /** Tenths of a bp actually attached; 0 if none. */
  builderFee: number;
  /** clobscan tx_hash of the follower's order; zero for SKIP. */
  followerTxHash: Hex;
  followerOrderTimeMs: bigint;
  skipReason: number;
}

export const EXECUTION_LEAF_PARAMS: readonly AbiParameter[] = [
  { name: 'tag', type: 'bytes32' },
  { name: 'copyTradingContract', type: 'address' },
  { name: 'subscriptionId', type: 'uint256' },
  { name: 'subscriptionVersion', type: 'uint32' },
  { name: 'action', type: 'uint8' },
  { name: 'leaderVenue', type: 'uint8' },
  { name: 'leaderFillRef', type: 'bytes32' },
  { name: 'leaderFillTimeMs', type: 'uint64' },
  { name: 'engine', type: 'uint8' },
  { name: 'symbolHash', type: 'bytes32' },
  { name: 'side', type: 'uint8' },
  { name: 'reduceOnly', type: 'bool' },
  { name: 'quantity', type: 'uint256' },
  { name: 'limitPrice', type: 'uint256' },
  { name: 'builderFee', type: 'uint16' },
  { name: 'followerTxHash', type: 'bytes32' },
  { name: 'followerOrderTimeMs', type: 'uint64' },
  { name: 'skipReason', type: 'uint16' },
];

/** keccak256 of a venue fill id: SoDEX "engine:symbol:t", Hyperliquid "hash:tid". */
export const fillRef = (venueFillId: string): Hex => keccakUtf8(venueFillId);

/** The ABI encoding under the leaf (for auditors who want to see the preimage). */
export function executionLeafPreimage(r: ExecutionRecord): Hex {
  return encodeAbiParameters(EXECUTION_LEAF_PARAMS, [
    EXECUTION_LEAF_TAG,
    r.copyTradingContract,
    r.subscriptionId,
    r.subscriptionVersion,
    r.action,
    r.leaderVenue,
    r.leaderFillRef,
    r.leaderFillTimeMs,
    r.engine,
    symbolHash(r.symbol),
    r.side,
    r.reduceOnly,
    r.quantity,
    r.limitPrice,
    r.builderFee,
    r.followerTxHash,
    r.followerOrderTimeMs,
    r.skipReason,
  ]);
}

/** The leaf: keccak256(bytes.concat(keccak256(abi.encode(tag, ...record)))) (OpenZeppelin's "standard" double hash). */
export const executionLeaf = (r: ExecutionRecord): Hex => bytesToHex(keccak256(keccak256(hexToBytes(executionLeafPreimage(r)))));

/** OpenZeppelin's commutative pair hash: keccak256(sorted(a, b)). */
export function hashPair(a: Hex, b: Hex): Hex {
  const x = hexToBytes(a);
  const y = hexToBytes(b);
  return bytesToHex(keccak256(compareBytes(x, y) <= 0 ? concatBytes(x, y) : concatBytes(y, x)));
}

export interface MerkleTree {
  root: Hex;
  /** The complete binary tree, root at 0 (StandardMerkleTree layout). */
  tree: Hex[];
  /** Leaves sorted by hash, with their position in `tree`. */
  leaves: Array<{ leaf: Hex; treeIndex: number }>;
}

/** Build a tree over leaf hashes (at least one). Duplicate leaves are rejected (a commitment lists each record once). */
export function buildMerkleTree(leafHashes: readonly Hex[]): MerkleTree {
  if (leafHashes.length === 0) throw new RangeError('a commitment needs at least one leaf');
  const sortedLeaves = [...leafHashes]
    .map((h) => {
      if (hexToBytes(h).length !== 32) throw new RangeError(`leaf ${h} is not 32 bytes`);
      return h.toLowerCase() as Hex;
    })
    .sort((a, b) => compareBytes(hexToBytes(a), hexToBytes(b)));
  for (let i = 1; i < sortedLeaves.length; i++) {
    if (sortedLeaves[i] === sortedLeaves[i - 1]) throw new RangeError(`duplicate leaf ${sortedLeaves[i]}`);
  }
  const n = sortedLeaves.length;
  const tree = new Array<Hex>(2 * n - 1);
  const leaves = sortedLeaves.map((leaf, i) => {
    const treeIndex = tree.length - 1 - i;
    tree[treeIndex] = leaf;
    return { leaf, treeIndex };
  });
  for (let i = tree.length - 1 - n; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1]!, tree[2 * i + 2]!);
  return { root: tree[0]!, tree, leaves };
}

/** Proof of `leaf` in `tree` (siblings from the leaf up). */
export function merkleProof(t: MerkleTree, leaf: Hex): Hex[] {
  const entry = t.leaves.find((l) => l.leaf === leaf.toLowerCase());
  if (!entry) throw new RangeError(`leaf ${leaf} is not in the tree`);
  const proof: Hex[] = [];
  let i = entry.treeIndex;
  while (i > 0) {
    proof.push(t.tree[i % 2 === 1 ? i + 1 : i - 1]!);
    i = Math.floor((i - 1) / 2);
  }
  return proof;
}

/** OpenZeppelin MerkleProof.verify. */
export function verifyMerkleProof(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  let h = leaf.toLowerCase() as Hex;
  for (const p of proof) h = hashPair(h, p);
  return h === root.toLowerCase();
}

/**
 * Check one published record against the on-chain commitment (`commitment(executor, epoch)`): the record's leaf with
 * its proof reaches the committed root. (The contract no longer has an on-chain verifier: this is the check.)
 */
export const verifyExecution = (onChain: Commitment, record: ExecutionRecord, proof: readonly Hex[]): boolean =>
  onChain.committedAt !== 0 && verifyMerkleProof(onChain.merkleRoot, executionLeaf(record), proof);

/** The epoch an execution at unix time `t` (seconds) belongs to: the unix hour. */
export const epochOf = (unixSeconds: number): bigint => BigInt(Math.floor(unixSeconds / COMMITMENT_EPOCH_SECONDS));

/** The commitment document an executor publishes at `uri`: every record (with the symbol as text), leaf and proof. */
export function commitmentDocument(
  executor: Address,
  epoch: bigint,
  records: readonly ExecutionRecord[],
): { json: string; root: Hex; count: number; leaves: Hex[] } {
  const leaves = records.map(executionLeaf);
  const tree = buildMerkleTree(leaves);
  const doc = {
    format: EXECUTION_LEAF_TAG_STRING,
    executor: lowerAddress(executor),
    epoch: epoch.toString(),
    root: tree.root,
    count: records.length,
    records: records.map((r, i) => ({ ...r, symbolHash: symbolHash(r.symbol), leaf: leaves[i], proof: merkleProof(tree, leaves[i]!) })),
  };
  return {
    json: JSON.stringify(doc, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    root: tree.root,
    count: records.length,
    leaves,
  };
}
