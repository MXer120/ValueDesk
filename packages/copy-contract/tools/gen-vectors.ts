/**
 * Generates the cross-implementation test vectors of @valuescan/copy-contract from the package itself:
 *
 *   test/vectors.json                              the vectors, for test/vectors.test.ts and for anyone porting the bindings
 *   ../../contracts/test/CrossCheckVectors.t.sol   the Foundry test that makes the CONTRACT prove it agrees with them
 *
 * Both files come from the same in-memory scenario, so they cannot drift apart; `--check` (and test/vectors.test.ts)
 * fails when either committed file differs from what the code generates now. The Solidity output is already in
 * `forge fmt` style, so `forge fmt --check` passes on it unchanged.
 *
 * The scenario is a model of the contract written with this package (storedSubscription, the event encoders and the
 * event-sourced CopyTradingIndex). Foundry then replays it against the real contract behind an ERC1967Proxy and
 * compares every digest, signature, return value, revert and log byte for byte. So a mistake in the package's model
 * of the contract (for example the stop-epoch rule or the live-set order) fails the Foundry test.
 *
 * TEST-ONLY KEYS. The private keys are keccak256 of the public strings in TEST_KEY_LABELS. They are published in this
 * repository, so anyone can sign with them: never fund them and never use them on any chain.
 *
 * Nothing here touches the network.
 *
 *   npx tsx tools/gen-vectors.ts           write both files
 *   npx tsx tools/gen-vectors.ts --check   exit 1 if either committed file is stale
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ABI,
  type Abi,
  type Address,
  type CopyTradingAction,
  type CopyTradingEvent,
  CopyTradingIndex,
  type CopyTradingPrimaryType,
  EIP712_NAME,
  EIP712_VERSION,
  ExecutionAction,
  type ExecutionRecord,
  type Hex,
  LeafEngine,
  LeafSide,
  MarketScope,
  SECP256K1_N,
  SizingMode,
  SkipReason,
  Status,
  StopReason,
  type Subscription,
  SymbolMode,
  TIMELOCK_ABI,
  TIMELOCK_MIN_DELAY_SECONDS,
  TYPEHASH,
  type TargetInput,
  type Terms,
  type TimelockOperation,
  UPGRADE_INTERFACE_VERSION,
  VALUECHAIN_CHAIN_ID,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  buildMerkleTree,
  bytesToBigInt,
  bytesToHex,
  calls,
  decodeCopyTradingLog,
  domainSeparator,
  encodeErrorResult,
  enumName,
  encodeEventLog,
  encodeFunctionResult,
  epochOf,
  executionLeaf,
  fillRef,
  hexToBytes,
  keccakUtf8,
  merkleProof,
  ownerCallProposal,
  prepareAction,
  privateKeyToAddress,
  saltFromLabel,
  serializeTypedData,
  signDigest,
  storedSubscription,
  subscriptionProblems,
  TermsField,
  termsProblems,
  timelockCalls,
  toChecksumAddress,
  upgradeProposal,
  utf8,
  withSigCalldata,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = join(here, '..');
export const REPO_DIR = join(PACKAGE_DIR, '..', '..');
export const VECTORS_JSON = join(PACKAGE_DIR, 'test', 'vectors.json');
export const FOUNDRY_TEST = join(REPO_DIR, 'contracts', 'test', 'CrossCheckVectors.t.sol');

// ---------------------------------------------------------------------------
// Fixed actors and parameters
// ---------------------------------------------------------------------------

const cs = (a: string): Address => toChecksumAddress(a);
const pad = (tail: string): Address => cs(`0x${tail.padStart(40, '0')}`);
const DAY = 86_400;

export const CHAIN_ID = VALUECHAIN_CHAIN_ID;
/** The ERC1967Proxy: the contract everyone uses and the EIP-712 verifyingContract (the spec §6.8 vector address). */
export const CONTRACT = pad('c0ffee01');
/** The V1 implementation behind it. */
export const IMPLEMENTATION = pad('c0de0001');
/** A second copy of the same implementation, the target of the timelock upgrade flow. */
export const IMPLEMENTATION_V2 = pad('c0de0002');
/** The recommended owner in the governance flow: TimelockController(48 h, proposer/executor = MULTISIG, no admin). */
export const TIMELOCK = pad('71e10c');
export const MULTISIG = pad('5afe');
/** Owner in the main scenario (it stands for the timelock; the governance flow moves ownership to TIMELOCK). */
export const OWNER = pad('a11');
export const RELAYER = pad('beef');
export const STRANGER = pad('bad0');
/** An ERC-1271 smart-wallet follower whose owner is the TEST-ONLY wallet-owner key. */
export const WALLET = pad('1271');
export const EXECUTOR = cs('0x1111111111111111111111111111111111111111');
export const KEY_F = cs('0x2222222222222222222222222222222222222222');
export const KEY_W = cs('0x7777777777777777777777777777777777777777');
export const HL_LEADER = cs('0x4444444444444444444444444444444444444444');
export const HL_LEADER2 = cs('0x8888888888888888888888888888888888888888');
/** SoDEX leader of the SEC-04 steps (a withheld Subscribe after a stop). */
export const SEC04_LEADER = cs('0x5ec0400000000000000000000000000000000004');
export const SODEX_LEADER = cs('0x5555555555555555555555555555555555555555');
export const F_ACCOUNT = 224_678n;
export const W_ACCOUNT = 230_775n;
export const BUILDER = { builderId: 231_000n, perpsFee: 50, spotFee: 100 } as const;
export const RAISED_FEES = { perpsFee: 200, spotFee: 2000 } as const;
/** Deployment time; the scenario starts at T0. */
export const SETUP_TIME = 1_789_996_400;
export const T0 = 1_790_000_000;
/** A nonce in a high bitmap word, to exercise uint256 nonces end to end (word 2^247, bit 5). */
const BIG_NONCE = (1n << 255n) + 5n;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 2 ** 32 - 1;
const U40_MAX = 2 ** 40 - 1;
const U256_MAX = (1n << 256n) - 1n;
const DELAY = BigInt(TIMELOCK_MIN_DELAY_SECONDS);
const ERC1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** The strings whose keccak256 are the TEST-ONLY private keys. */
export const TEST_KEY_LABELS = {
  follower: 'valuescan/copy-contract TEST-ONLY follower key (public, never fund)',
  walletOwner: 'valuescan/copy-contract TEST-ONLY smart-wallet owner key (public, never fund)',
} as const;

export interface TestKey {
  label: string;
  privateKey: Hex;
  address: Address;
}

function testKey(label: string): TestKey {
  const privateKey = keccakUtf8(label);
  const k = bytesToBigInt(hexToBytes(privateKey));
  if (k === 0n || k >= SECP256K1_N) throw new Error(`"${label}" does not hash to a valid secp256k1 key`);
  return { label, privateKey, address: privateKeyToAddress(privateKey) };
}

// ---------------------------------------------------------------------------
// Vector shapes
// ---------------------------------------------------------------------------

export interface ExpectedLog {
  emitter: Address;
  eventName: string;
  args: Record<string, unknown>;
  topics: Hex[];
  data: Hex;
}

export type SignerRole = 'follower' | 'wallet' | 'wrong-key';

export interface SignedVector {
  name: string;
  primaryType: CopyTradingPrimaryType;
  /** follower: the EOA follower's key; wallet: the ERC-1271 wallet's owner key; wrong-key: a key that is not the follower. */
  signerRole: SignerRole;
  /** The follower in the signed message (the EOA, or the ERC-1271 wallet). */
  follower: Address;
  /** The address of the key that produced `signature` (what ecrecover returns). */
  keyAddress: Address;
  action: CopyTradingAction;
  /** The eth_signTypedData_v4 payload, exactly as serializeTypedData produces it. */
  typedDataJson: string;
  structHash: Hex;
  digest: Hex;
  /** 65 bytes r || s || v (v 27/28), RFC 6979, low s. */
  signature: Hex;
  /** Calldata of the matching ...WithSig function, carrying `signature`. */
  callData: Hex;
}

export interface StepVector {
  name: string;
  /** block.timestamp of the call. */
  timestamp: number;
  /** msg.sender. */
  from: Address;
  /** The called contract (the proxy, or the timelock in the governance flow). */
  to: Address;
  callData: Hex;
  success: boolean;
  /** Return data on success, revert data on failure. */
  returnData: Hex;
  errorName?: string;
  errorArgs?: unknown[];
  /** ERC-1271 steps: the contract must call wallet.isValidSignature(digest, signature) with exactly these. */
  wallet?: { address: Address; digest: Hex; signature: Hex };
  logs: ExpectedLog[];
}

export interface ViewVector {
  name: string;
  to: Address;
  functionName: string;
  args: unknown[];
  callData: Hex;
  success: boolean;
  /** The ABI-encoded outputs (success) or revert data (failure), exactly as the contract returns them. */
  returnData: Hex;
  /** Decoded outputs (success) in the package's form. */
  outputs?: unknown[];
  errorName?: string;
  errorArgs?: unknown[];
}

/** An invalid subscribe, sent directly by the follower at SETUP_TIME: the contract must revert with `revertData`. */
export interface TermsCase {
  name: string;
  venue: number;
  leader: Address;
  sodexAccountId: bigint;
  terms: Terms;
  /** The first problem `subscriptionProblems` reports (a TermsField name, or VENUE_DISABLED). */
  field: string;
  callData: Hex;
  revertData: Hex;
}

export interface Vectors {
  keys: { follower: TestKey; walletOwner: TestKey };
  termsCases: TermsCase[];
  domainSeparator: Hex;
  initData: Hex;
  deploymentLogs: ExpectedLog[];
  signed: SignedVector[];
  steps: StepVector[];
  views: ViewVector[];
  finalTimestamp: number;
  executions: {
    epoch: bigint;
    uri: string;
    records: ExecutionRecord[];
    leaves: Hex[];
    root: Hex;
    proofs: Hex[][];
  };
  governance: {
    operations: { acceptOwnership: TimelockOperation; upgrade: TimelockOperation };
    steps: StepVector[];
    views: ViewVector[];
  };
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const assertValid = (terms: Terms, follower: Address, now: number): Terms => {
  const problems = termsProblems(terms, follower, now);
  if (problems.length) throw new Error(`invalid vector terms: ${problems.map((p) => `${p.field} (${p.message})`).join(', ')}`);
  return terms;
};

export function buildVectors(): Vectors {
  const keys = { follower: testKey(TEST_KEY_LABELS.follower), walletOwner: testKey(TEST_KEY_LABELS.walletOwner) };
  const F = keys.follower.address;
  const W = WALLET;
  const domain = { verifyingContract: CONTRACT, chainId: CHAIN_ID };
  const ds = domainSeparator(domain);

  // ---- the model: the package's own event-sourced index, fed with the logs this generator expects ----
  const index = new CopyTradingIndex(CONTRACT);
  let block = 1n;
  const log = (eventName: string, args: Record<string, unknown>, emitter: Address = CONTRACT, abi: Abi = ABI): ExpectedLog => ({
    emitter,
    eventName,
    args,
    ...encodeEventLog(abi, eventName, args),
  });
  /** Feed the expected logs of one block to the model, exactly as an indexer would decode them. */
  const feed = (logs: readonly ExpectedLog[], timestamp: number): void => {
    logs
      .filter((l) => l.emitter === CONTRACT)
      .forEach((l, i) => {
        const ev = decodeCopyTradingLog({ address: CONTRACT, topics: l.topics, data: l.data, blockNumber: block, logIndex: i, blockTimestamp: timestamp });
        if (!ev) throw new Error(`the package cannot decode its own ${l.eventName} log`);
        index.apply(ev as CopyTradingEvent);
      });
    block++;
  };

  // ---- deployment: ERC1967Proxy(IMPLEMENTATION, initialize(OWNER, builder, fees, [EXECUTOR])) at SETUP_TIME ----
  const initData = calls.initialize(OWNER, BUILDER.builderId, BUILDER.perpsFee, BUILDER.spotFee, [EXECUTOR]);
  const deploymentLogs = [
    log('Upgraded', { implementation: IMPLEMENTATION }),
    log('OwnershipTransferred', { previousOwner: ZERO_ADDRESS, newOwner: OWNER }),
    log('VenueUpdated', { venue: 1, enabled: true, name: 'SoDEX' }),
    log('VenueUpdated', { venue: 2, enabled: true, name: 'Hyperliquid' }),
    log('BuilderTermsUpdated', { builderId: BUILDER.builderId, perpsFee: BUILDER.perpsFee, spotFee: BUILDER.spotFee }),
    log('ExecutorSet', { executor: EXECUTOR, authorised: true }),
    log('Initialized', { version: 1n }),
  ];
  feed(deploymentLogs, SETUP_TIME);

  // ---- terms ----
  const t = (k: number): number => T0 + k * 600;
  const termsA = assertValid(
    {
      delegatedKey: KEY_F,
      keyName: 'vs-0123456789abcdefghijklmnopqrstuvw',
      marketScope: MarketScope.PERPS,
      sizingMode: SizingMode.PROPORTIONAL,
      sizingValue: 1_000_000n,
      allocationCap: 1_000_000_000n,
      maxPositionNotional: 2_500_000_000n,
      maxLeverage: 5,
      tradeStopLossBps: 500,
      maxDrawdownBps: 2000,
      takeProfitBps: 5000,
      slippageBps: 50,
      symbolMode: SymbolMode.ALLOW,
      symbols: ['ETH-USD', 'BTC-USD', 'LONG-SYMBOL-NAME-OVER-32-BYTES-USD'],
      copyExisting: false,
      maxBuilderFeePerps: 50,
      maxBuilderFeeSpot: 0,
      expiry: T0 + 180 * DAY,
    },
    F,
    t(0),
  );
  const termsB = assertValid(
    {
      ...termsA,
      marketScope: MarketScope.PERPS_AND_SPOT,
      sizingMode: SizingMode.FIXED_NOTIONAL,
      sizingValue: 100_000_000n,
      maxPositionNotional: 2_000_000_000n,
      maxLeverage: 3,
      tradeStopLossBps: 0,
      maxDrawdownBps: 10_000,
      takeProfitBps: U32_MAX,
      slippageBps: 10_000,
      symbolMode: SymbolMode.DENY,
      symbols: ['WIF-USD', 'DOGE-USD'],
      copyExisting: true,
      maxBuilderFeePerps: 30,
      maxBuilderFeeSpot: 100,
      expiry: 0,
    },
    F,
    t(1),
  );
  const termsC = assertValid(
    {
      delegatedKey: KEY_F,
      keyName: 'vs-0123456789abcdefghijklmnopqrstuvw',
      marketScope: MarketScope.SPOT,
      sizingMode: SizingMode.FIXED_RATIO,
      sizingValue: 500_000n,
      allocationCap: 500_000_000n,
      maxPositionNotional: 500_000_000n,
      maxLeverage: 1,
      tradeStopLossBps: 0,
      maxDrawdownBps: 0,
      takeProfitBps: 0,
      slippageBps: 1,
      symbolMode: SymbolMode.ALL,
      symbols: [],
      copyExisting: false,
      maxBuilderFeePerps: 0,
      maxBuilderFeeSpot: 2000,
      expiry: T0 + 30 * DAY,
    },
    F,
    t(4),
  );
  const termsW = assertValid(
    {
      delegatedKey: KEY_W,
      keyName: 'vs-w1',
      marketScope: MarketScope.PERPS,
      sizingMode: SizingMode.PROPORTIONAL,
      sizingValue: U64_MAX,
      allocationCap: U64_MAX,
      maxPositionNotional: U64_MAX,
      maxLeverage: 255,
      tradeStopLossBps: 1,
      maxDrawdownBps: 1,
      takeProfitBps: 1,
      slippageBps: 25,
      symbolMode: SymbolMode.ALLOW,
      symbols: ['BTC-USD'],
      copyExisting: true,
      maxBuilderFeePerps: 0,
      maxBuilderFeeSpot: 0,
      expiry: U40_MAX,
    },
    W,
    t(6),
  );
  const termsW2 = assertValid(
    {
      ...termsW,
      sizingValue: 2_000_000n,
      allocationCap: 5_000_000_000n,
      maxPositionNotional: 50_000_000_000n,
      maxLeverage: 10,
      symbolMode: SymbolMode.DENY,
      symbols: ['BTC-USD', 'BTC-USD'],
      expiry: 0,
    },
    W,
    t(7),
  );
  const termsW3 = assertValid(
    {
      delegatedKey: KEY_W,
      keyName: 'vs-w1',
      marketScope: MarketScope.SPOT,
      sizingMode: SizingMode.FIXED_NOTIONAL,
      sizingValue: 50_000_000n,
      allocationCap: 50_000_000n,
      maxPositionNotional: 50_000_000n,
      maxLeverage: 1,
      tradeStopLossBps: 0,
      maxDrawdownBps: 0,
      takeProfitBps: 0,
      slippageBps: 75,
      symbolMode: SymbolMode.ALL,
      symbols: [],
      copyExisting: false,
      maxBuilderFeePerps: 0,
      maxBuilderFeeSpot: 0,
      expiry: T0 + 7 * DAY,
    },
    W,
    t(10),
  );
  const termsD = assertValid(
    {
      delegatedKey: KEY_F,
      keyName: 'vs-0123456789abcdefghijklmnopqrstuvw',
      marketScope: MarketScope.PERPS,
      sizingMode: SizingMode.FIXED_RATIO,
      sizingValue: 250_000n,
      allocationCap: 2_000_000_000n,
      maxPositionNotional: 4_000_000_000n,
      maxLeverage: 2,
      tradeStopLossBps: 300,
      maxDrawdownBps: 1500,
      takeProfitBps: 0,
      slippageBps: 30,
      symbolMode: SymbolMode.ALLOW,
      symbols: ['SOL-USD'],
      copyExisting: false,
      maxBuilderFeePerps: 50,
      maxBuilderFeeSpot: 0,
      expiry: T0 + 90 * DAY,
    },
    F,
    t(19),
  );
  const termsC2 = assertValid(
    {
      ...termsC,
      sizingMode: SizingMode.PROPORTIONAL,
      sizingValue: 1_500_000n,
      allocationCap: 300_000_000n,
      maxPositionNotional: 300_000_000n,
      slippageBps: 40,
      symbolMode: SymbolMode.ALLOW,
      symbols: ['vBTC_vUSDC', 'vETH_vUSDC'],
      maxBuilderFeeSpot: 150,
      expiry: 0,
    },
    F,
    t(25),
  );
  const termsE = assertValid(
    {
      delegatedKey: KEY_F,
      keyName: 'vs-0123456789abcdefghijklmnopqrstuvw',
      marketScope: MarketScope.PERPS_AND_SPOT,
      sizingMode: SizingMode.PROPORTIONAL,
      sizingValue: 1_000_000n,
      allocationCap: 1_000_000_000n,
      maxPositionNotional: 1_000_000_000n,
      maxLeverage: 1,
      tradeStopLossBps: 0,
      maxDrawdownBps: 5000,
      takeProfitBps: 20_000,
      slippageBps: 100,
      symbolMode: SymbolMode.DENY,
      symbols: ['DOGE-USD'],
      copyExisting: true,
      maxBuilderFeePerps: 200,
      maxBuilderFeeSpot: 2000,
      expiry: 0,
    },
    F,
    t(26),
  );

  // ---- signing ----
  const signed: SignedVector[] = [];
  type SubscribeAction = Extract<CopyTradingAction, { type: 'Subscribe' }>;
  type SignInput = Exclude<CopyTradingAction, SubscribeAction> | (Omit<SubscribeAction, 'expectedLastId'> & { expectedLastId?: bigint });
  const sign = (name: string, input: SignInput, signerRole: SignerRole = 'follower'): SignedVector => {
    // A Subscribe is signed for the key's history as the index sees it now, unless the step says otherwise (SEC-04).
    const action: CopyTradingAction =
      input.type === 'Subscribe'
        ? { ...input, expectedLastId: input.expectedLastId ?? index.lastSubscriptionFor(input.follower, input.sodexAccountId, input.venue, input.leader) }
        : input;
    const prep = prepareAction(domain, action);
    const key = signerRole === 'follower' ? keys.follower : keys.walletOwner;
    const signature = signDigest(prep.digest, key.privateKey);
    const v: SignedVector = {
      name,
      primaryType: action.type,
      signerRole,
      follower: action.follower,
      keyAddress: key.address,
      action,
      typedDataJson: serializeTypedData(prep.typedData),
      structHash: prep.structHash,
      digest: prep.digest,
      signature,
      callData: withSigCalldata(action, { nonce: action.nonce, deadline: action.deadline, signature }),
    };
    signed.push(v);
    return v;
  };

  // ---- steps ----
  const steps: StepVector[] = [];
  const ok = (fn: string, values: unknown[]): Hex => encodeFunctionResult(ABI, fn, values);
  const run = (
    s: { name: string; timestamp: number; from: Address; callData: Hex; to?: Address },
    outcome: { logs?: ExpectedLog[]; returnData?: Hex } | { revert: [string, unknown[]]; abi?: Abi },
    wallet?: SignedVector,
  ): void => {
    const v: StepVector = {
      name: s.name,
      timestamp: s.timestamp,
      from: s.from,
      to: s.to ?? CONTRACT,
      callData: s.callData,
      success: true,
      returnData: '0x',
      logs: [],
    };
    if ('revert' in outcome) {
      const [errorName, args] = outcome.revert;
      v.success = false;
      v.returnData = encodeErrorResult(outcome.abi ?? ABI, errorName, args);
      v.errorName = errorName;
      v.errorArgs = args;
    } else {
      v.logs = outcome.logs ?? [];
      v.returnData = outcome.returnData ?? '0x';
      feed(v.logs, s.timestamp);
    }
    if (wallet) v.wallet = { address: wallet.follower, digest: wallet.digest, signature: wallet.signature };
    steps.push(v);
  };
  const relay = (v: SignedVector, timestamp: number, outcome: Parameters<typeof run>[1], opts: { wallet?: boolean; name?: string } = {}) =>
    run({ name: opts.name ?? v.name, timestamp, from: RELAYER, callData: v.callData }, outcome, opts.wallet ? v : undefined);

  const rec = (id: bigint): Subscription => index.get(id)!.record;
  const created = (target: TargetInput, terms: Terms, now: number): Subscription =>
    storedSubscription(target, terms, { status: Status.ACTIVE, version: 1, createdAt: now, updatedAt: now, stopEpoch: index.stopEpochOf(target.follower) });
  const updated = (id: bigint, terms: Terms, now: number): Subscription => {
    const p = rec(id);
    return storedSubscription(
      { follower: p.follower, venue: p.venue, leader: p.leader, sodexAccountId: p.sodexAccountId },
      terms,
      { status: p.status, version: p.version + 1, createdAt: p.createdAt, updatedAt: now, stopEpoch: p.stopEpoch },
    );
  };
  const nextId = (): bigint => index.subscriptionCount + 1n;
  const nonceUsed = (signer: Address, nonce: bigint) => log('NonceUsed', { signer, nonce });
  const deadline = (now: number, seconds = 900): bigint => BigInt(now + seconds);

  // 1. F subscribes to a Hyperliquid leader.
  {
    const now = t(0);
    const target = { follower: F, venue: 2, leader: HL_LEADER, sodexAccountId: F_ACCOUNT };
    const v = sign('F Subscribe: Hyperliquid leader, perps, proportional, ALLOW list with a 34-byte symbol, 36-char key name', {
      type: 'Subscribe',
      ...target,
      terms: termsA,
      stopEpoch: index.stopEpochOf(F),
      nonce: 0n,
      deadline: deadline(now),
    });
    const id = nextId();
    relay(v, now, {
      returnData: ok('subscribeWithSig', [id]),
      logs: [nonceUsed(F, 0n), log('Subscribed', { subscriptionId: id, follower: F, leader: HL_LEADER, subscription: created(target, termsA, now), symbols: termsA.symbols })],
    });
  }
  // 2. F updates it (version-bound).
  {
    const now = t(1);
    const v = sign('F UpdateSubscription: both engines, fixed notional, DENY list, max drawdown, uint32-max take profit, never expires', {
      type: 'UpdateSubscription',
      follower: F,
      subscriptionId: 1n,
      expectedVersion: rec(1n).version,
      terms: termsB,
      nonce: 1n,
      deadline: deadline(now),
    });
    relay(v, now, { logs: [nonceUsed(F, 1n), log('SubscriptionUpdated', { subscriptionId: 1n, follower: F, subscription: updated(1n, termsB, now), symbols: termsB.symbols })] });
  }
  // 3. F pauses it.
  {
    const now = t(2);
    const v = sign('F PauseSubscription', { type: 'PauseSubscription', follower: F, subscriptionId: 1n, nonce: 2n, deadline: deadline(now) });
    relay(v, now, { logs: [nonceUsed(F, 2n), log('SubscriptionPaused', { subscriptionId: 1n, follower: F, version: rec(1n).version + 1, updatedAt: now })] });
  }
  // 4. F resumes it (version-bound).
  {
    const now = t(3);
    const v = sign('F ResumeSubscription', {
      type: 'ResumeSubscription',
      follower: F,
      subscriptionId: 1n,
      expectedVersion: rec(1n).version,
      nonce: 3n,
      deadline: deadline(now),
    });
    relay(v, now, { logs: [nonceUsed(F, 3n), log('SubscriptionResumed', { subscriptionId: 1n, follower: F, version: rec(1n).version + 1, updatedAt: now })] });
  }
  // 5. F subscribes to a SoDEX leader (spot, ALL symbols).
  {
    const now = t(4);
    const target = { follower: F, venue: 1, leader: SODEX_LEADER, sodexAccountId: F_ACCOUNT };
    const v = sign('F Subscribe: SoDEX leader, spot, fixed ratio, ALL symbols, spot fee consent at the SoDEX cap', {
      type: 'Subscribe',
      ...target,
      terms: termsC,
      stopEpoch: index.stopEpochOf(F),
      nonce: 4n,
      deadline: deadline(now),
    });
    const id = nextId();
    relay(v, now, {
      returnData: ok('subscribeWithSig', [id]),
      logs: [nonceUsed(F, 4n), log('Subscribed', { subscriptionId: id, follower: F, leader: SODEX_LEADER, subscription: created(target, termsC, now), symbols: [] })],
    });
  }
  // 6. F unsubscribes #1 with closePositions, using a nonce in a high bitmap word.
  {
    const now = t(5);
    const v = sign('F Unsubscribe: closePositions, nonce 2^255 + 5', {
      type: 'Unsubscribe',
      follower: F,
      subscriptionId: 1n,
      closePositions: true,
      nonce: BIG_NONCE,
      deadline: deadline(now),
    });
    relay(v, now, {
      logs: [nonceUsed(F, BIG_NONCE), log('SubscriptionStopped', { subscriptionId: 1n, follower: F, closePositions: true, version: rec(1n).version + 1, updatedAt: now })],
    });
  }
  // 7-13. The ERC-1271 wallet follower W: every signed action; the contract must hand W exactly the package's digest.
  {
    const now = t(6);
    const target = { follower: W, venue: 2, leader: HL_LEADER, sodexAccountId: W_ACCOUNT };
    const v = sign(
      'W (ERC-1271) Subscribe: uint64-max sizing, allocation and position, 255x, uint40-max expiry, zero fee consents',
      { type: 'Subscribe', ...target, terms: termsW, stopEpoch: index.stopEpochOf(W), nonce: 0n, deadline: deadline(now) },
      'wallet',
    );
    const id = nextId();
    relay(
      v,
      now,
      {
        returnData: ok('subscribeWithSig', [id]),
        logs: [nonceUsed(W, 0n), log('Subscribed', { subscriptionId: id, follower: W, leader: HL_LEADER, subscription: created(target, termsW, now), symbols: termsW.symbols })],
      },
      { wallet: true },
    );
  }
  {
    const now = t(7);
    const v = sign(
      'W (ERC-1271) UpdateSubscription: DENY list with a duplicate entry',
      { type: 'UpdateSubscription', follower: W, subscriptionId: 3n, expectedVersion: rec(3n).version, terms: termsW2, nonce: 1n, deadline: deadline(now) },
      'wallet',
    );
    relay(v, now, { logs: [nonceUsed(W, 1n), log('SubscriptionUpdated', { subscriptionId: 3n, follower: W, subscription: updated(3n, termsW2, now), symbols: termsW2.symbols })] }, { wallet: true });
  }
  {
    const now = t(8);
    const v = sign('W (ERC-1271) PauseSubscription', { type: 'PauseSubscription', follower: W, subscriptionId: 3n, nonce: 2n, deadline: deadline(now) }, 'wallet');
    relay(v, now, { logs: [nonceUsed(W, 2n), log('SubscriptionPaused', { subscriptionId: 3n, follower: W, version: rec(3n).version + 1, updatedAt: now })] }, { wallet: true });
  }
  {
    const now = t(9);
    const v = sign(
      'W (ERC-1271) ResumeSubscription',
      { type: 'ResumeSubscription', follower: W, subscriptionId: 3n, expectedVersion: rec(3n).version, nonce: 3n, deadline: deadline(now) },
      'wallet',
    );
    relay(v, now, { logs: [nonceUsed(W, 3n), log('SubscriptionResumed', { subscriptionId: 3n, follower: W, version: rec(3n).version + 1, updatedAt: now })] }, { wallet: true });
  }
  {
    const now = t(10);
    const target = { follower: W, venue: 1, leader: SODEX_LEADER, sodexAccountId: W_ACCOUNT };
    const v = sign(
      'W (ERC-1271) Subscribe: SoDEX leader, spot, fixed notional',
      { type: 'Subscribe', ...target, terms: termsW3, stopEpoch: index.stopEpochOf(W), nonce: 4n, deadline: deadline(now) },
      'wallet',
    );
    const id = nextId();
    relay(
      v,
      now,
      {
        returnData: ok('subscribeWithSig', [id]),
        logs: [nonceUsed(W, 4n), log('Subscribed', { subscriptionId: id, follower: W, leader: SODEX_LEADER, subscription: created(target, termsW3, now), symbols: [] })],
      },
      { wallet: true },
    );
  }
  {
    const now = t(11);
    const v = sign(
      'W (ERC-1271) Unsubscribe',
      { type: 'Unsubscribe', follower: W, subscriptionId: 4n, closePositions: false, nonce: 5n, deadline: deadline(now) },
      'wallet',
    );
    relay(
      v,
      now,
      { logs: [nonceUsed(W, 5n), log('SubscriptionStopped', { subscriptionId: 4n, follower: W, closePositions: false, version: rec(4n).version + 1, updatedAt: now })] },
      { wallet: true },
    );
  }
  {
    const now = t(12);
    const v = sign(
      'W (ERC-1271) InvalidateNonces: word 0, mask 0xc0 (its own nonce 6 inside the mask)',
      { type: 'InvalidateNonces', follower: W, word: 0n, mask: 0xc0n, nonce: 6n, deadline: deadline(now) },
      'wallet',
    );
    relay(v, now, { logs: [nonceUsed(W, 6n), log('NoncesInvalidated', { signer: W, word: 0n, mask: 0xc0n })] }, { wallet: true });
  }
  // 14. The owner pauses NEW activity.
  run({ name: 'Owner pause()', timestamp: t(13), from: OWNER, callData: calls.pause() }, { logs: [log('Paused', { account: OWNER })] });
  // 15. A new subscription while paused reverts before any signature check.
  {
    const now = t(14);
    const v = sign(
      'W (ERC-1271) Subscribe while the contract is paused (reverts EnforcedPause)',
      { type: 'Subscribe', follower: W, venue: 2, leader: HL_LEADER2, sodexAccountId: W_ACCOUNT, terms: termsW3, stopEpoch: index.stopEpochOf(W), nonce: 8n, deadline: deadline(now) },
      'wallet',
    );
    relay(v, now, { revert: ['EnforcedPause', []] });
  }
  // 16. F's pre-signed emergency stop (long deadline) lands while paused: the kill switch, O(1).
  let killSwitchF: SignedVector;
  {
    const now = t(15);
    killSwitchF = sign('F UnsubscribeAll: pre-signed emergency stop with a one-year deadline, closePositions', {
      type: 'UnsubscribeAll',
      follower: F,
      closePositions: true,
      nonce: 5n,
      deadline: BigInt(T0 + 365 * DAY),
    });
    const epoch = index.stopEpochOf(F) + 1n;
    relay(killSwitchF, now, {
      returnData: ok('unsubscribeAllWithSig', [epoch]),
      logs: [nonceUsed(F, 5n), log('KillSwitchTriggered', { follower: F, stopEpoch: epoch, closePositions: true })],
    });
  }
  // 17. W's kill switch, while paused.
  {
    const now = t(16);
    const v = sign('W (ERC-1271) UnsubscribeAll while paused', { type: 'UnsubscribeAll', follower: W, closePositions: false, nonce: 9n, deadline: deadline(now) }, 'wallet');
    const epoch = index.stopEpochOf(W) + 1n;
    relay(
      v,
      now,
      { returnData: ok('unsubscribeAllWithSig', [epoch]), logs: [nonceUsed(W, 9n), log('KillSwitchTriggered', { follower: W, stopEpoch: epoch, closePositions: false })] },
      { wallet: true },
    );
  }
  // 18. The owner unpauses.
  run({ name: 'Owner unpause()', timestamp: t(17), from: OWNER, callData: calls.unpause() }, { logs: [log('Unpaused', { account: OWNER })] });
  // 19. A Subscribe signed before F's kill switch (stop epoch 0) is void.
  {
    const now = t(18);
    const v = sign('F Subscribe signed for stop epoch 0, before the kill switch (reverts StopEpochMismatch)', {
      type: 'Subscribe',
      follower: F,
      venue: 2,
      leader: HL_LEADER2,
      sodexAccountId: F_ACCOUNT,
      terms: termsD,
      stopEpoch: 0n,
      nonce: 6n,
      deadline: BigInt(T0 + DAY),
    });
    relay(v, now, { revert: ['StopEpochMismatch', [F, 0n, index.stopEpochOf(F)]] });
  }
  // 20. Re-signed for the current epoch: a new subscription in epoch 1.
  {
    const now = t(19);
    const target = { follower: F, venue: 2, leader: HL_LEADER2, sodexAccountId: F_ACCOUNT };
    const v = sign('F Subscribe for stop epoch 1 (after the kill switch)', {
      type: 'Subscribe',
      ...target,
      terms: termsD,
      stopEpoch: index.stopEpochOf(F),
      nonce: 7n,
      deadline: deadline(now),
    });
    const id = nextId();
    relay(v, now, {
      returnData: ok('subscribeWithSig', [id]),
      logs: [nonceUsed(F, 7n), log('Subscribed', { subscriptionId: id, follower: F, leader: HL_LEADER2, subscription: created(target, termsD, now), symbols: termsD.symbols })],
    });
  }
  // 21-22. The same pause, first with a v = 0/1 signature (rejected by OpenZeppelin ECDSA), then normalised.
  {
    const now = t(20);
    const v = sign('F PauseSubscription (canonical v = 27/28 signature)', { type: 'PauseSubscription', follower: F, subscriptionId: 5n, nonce: 8n, deadline: deadline(now) });
    const raw = hexToBytes(v.signature);
    raw[64] = raw[64]! - 27;
    const v01 = bytesToHex(raw);
    const a = v.action as Extract<CopyTradingAction, { type: 'PauseSubscription' }>;
    run(
      { name: 'F PauseSubscription with v = 0/1 (reverts InvalidSignature; the relayer must normalise)', timestamp: now, from: RELAYER, callData: withSigCalldata(a, { nonce: a.nonce, deadline: a.deadline, signature: v01 }) },
      { revert: ['InvalidSignature', [F]] },
    );
    relay(v, now, { logs: [nonceUsed(F, 8n), log('SubscriptionPaused', { subscriptionId: 5n, follower: F, version: rec(5n).version + 1, updatedAt: now })] });
  }
  // 23. Replaying the kill switch signature.
  run({ name: 'Replay of F UnsubscribeAll (reverts NonceAlreadyUsed)', timestamp: t(21), from: RELAYER, callData: killSwitchF.callData }, { revert: ['NonceAlreadyUsed', [F, 5n]] });
  // 24. F cancels nonce 9 by signature.
  {
    const now = t(22);
    const v = sign('F InvalidateNonces: word 0, bit 9', { type: 'InvalidateNonces', follower: F, word: 0n, mask: 1n << 9n, nonce: 10n, deadline: deadline(now) });
    relay(v, now, { logs: [nonceUsed(F, 10n), log('NoncesInvalidated', { signer: F, word: 0n, mask: 1n << 9n })] });
  }
  // 25. F resumes #5.
  {
    const now = t(23);
    const v = sign('F ResumeSubscription #5', {
      type: 'ResumeSubscription',
      follower: F,
      subscriptionId: 5n,
      expectedVersion: rec(5n).version,
      nonce: 11n,
      deadline: deadline(now),
    });
    relay(v, now, { logs: [nonceUsed(F, 11n), log('SubscriptionResumed', { subscriptionId: 5n, follower: F, version: rec(5n).version + 1, updatedAt: now })] });
  }
  // 26-29. F acts directly (msg.sender = F, paying its own gas).
  {
    const now = t(24);
    const target = { follower: F, venue: 1, leader: SODEX_LEADER, sodexAccountId: F_ACCOUNT };
    const id = nextId();
    run(
      { name: 'F subscribe (direct): SoDEX leader again, spot ALLOW list', timestamp: now, from: F, callData: calls.subscribe(1, SODEX_LEADER, F_ACCOUNT, termsC2) },
      { returnData: ok('subscribe', [id]), logs: [log('Subscribed', { subscriptionId: id, follower: F, leader: SODEX_LEADER, subscription: created(target, termsC2, now), symbols: termsC2.symbols })] },
    );
  }
  {
    const now = t(25);
    const target = { follower: F, venue: 2, leader: HL_LEADER, sodexAccountId: F_ACCOUNT };
    const id = nextId();
    run(
      { name: 'F subscribe (direct): Hyperliquid leader again, fee consents at both SoDEX caps', timestamp: now, from: F, callData: calls.subscribe(2, HL_LEADER, F_ACCOUNT, termsE) },
      { returnData: ok('subscribe', [id]), logs: [log('Subscribed', { subscriptionId: id, follower: F, leader: HL_LEADER, subscription: created(target, termsE, now), symbols: termsE.symbols })] },
    );
  }
  {
    const now = t(26);
    run(
      { name: 'F unsubscribe (direct) #5: the live set becomes [7, 6] (swap-and-pop)', timestamp: now, from: F, callData: calls.unsubscribe(5n, false) },
      { logs: [log('SubscriptionStopped', { subscriptionId: 5n, follower: F, closePositions: false, version: rec(5n).version + 1, updatedAt: now })] },
    );
  }
  run({ name: 'F invalidateNonces (direct): word 1, bits 0 and 1', timestamp: t(27), from: F, callData: calls.invalidateNonces(1n, 3n) }, { logs: [log('NoncesInvalidated', { signer: F, word: 1n, mask: 3n })] });

  // 30-31. The executor commits its executions for the epoch of T0.
  const executions = buildExecutions();
  run(
    { name: 'Executor commitExecutions', timestamp: t(28), from: EXECUTOR, callData: calls.commitExecutions(executions.epoch, executions.root, executions.records.length, executions.uri) },
    { logs: [log('ExecutionsCommitted', { executor: EXECUTOR, epoch: executions.epoch, merkleRoot: executions.root, count: executions.records.length, uri: executions.uri })] },
  );
  run(
    { name: 'Executor commits the same epoch again (reverts EpochNotIncreasing)', timestamp: t(29), from: EXECUTOR, callData: calls.commitExecutions(executions.epoch, ZERO_BYTES32, 1, 'ipfs://none') },
    { revert: ['EpochNotIncreasing', [executions.epoch, executions.epoch]] },
  );
  // 32-35. Governance: raise the fees (consents cap them), disable a venue, de-authorise the executor.
  run(
    { name: 'Owner setBuilderTerms: fees raised to the SoDEX caps', timestamp: t(30), from: OWNER, callData: calls.setBuilderTerms(BUILDER.builderId, RAISED_FEES.perpsFee, RAISED_FEES.spotFee) },
    { logs: [log('BuilderTermsUpdated', { builderId: BUILDER.builderId, ...RAISED_FEES })] },
  );
  run(
    { name: 'Owner setVenue: Hyperliquid disabled for new subscriptions', timestamp: t(31), from: OWNER, callData: calls.setVenue(2, false, 'Hyperliquid') },
    { logs: [log('VenueUpdated', { venue: 2, enabled: false, name: 'Hyperliquid' })] },
  );
  {
    const now = t(32);
    const v = sign('F Subscribe to a disabled venue (reverts VenueDisabled)', {
      type: 'Subscribe',
      follower: F,
      venue: 2,
      leader: HL_LEADER2,
      sodexAccountId: F_ACCOUNT,
      terms: termsD,
      stopEpoch: index.stopEpochOf(F),
      nonce: 12n,
      deadline: deadline(now),
    });
    relay(v, now, { revert: ['VenueDisabled', [2]] });
  }
  run(
    { name: 'Owner setExecutor: de-authorised (its record and commitments stay)', timestamp: t(33), from: OWNER, callData: calls.setExecutor(EXECUTOR, false) },
    { logs: [log('ExecutorSet', { executor: EXECUTOR, authorised: false })] },
  );
  // 36-39. What must fail.
  {
    const now = t(34);
    const v = sign('F Subscribe that duplicates live #6 (reverts DuplicateSubscription)', {
      type: 'Subscribe',
      follower: F,
      venue: 1,
      leader: SODEX_LEADER,
      sodexAccountId: F_ACCOUNT,
      terms: termsC,
      stopEpoch: index.stopEpochOf(F),
      nonce: 13n,
      deadline: deadline(now),
    });
    relay(v, now, { revert: ['DuplicateSubscription', [6n]] });
  }
  run({ name: 'A stranger pauses F\'s subscription (reverts NotFollower)', timestamp: t(35), from: STRANGER, callData: calls.pauseSubscription(7n) }, { revert: ['NotFollower', [7n, STRANGER]] });
  {
    const now = t(36);
    const v = sign(
      'Unsubscribe of F\'s #7 signed by another key (reverts InvalidSignature)',
      { type: 'Unsubscribe', follower: F, subscriptionId: 7n, closePositions: true, nonce: 14n, deadline: deadline(now) },
      'wrong-key',
    );
    relay(v, now, { revert: ['InvalidSignature', [F]] });
  }
  {
    const now = t(37);
    const v = sign('F PauseSubscription submitted after its deadline (reverts SignatureExpired)', {
      type: 'PauseSubscription',
      follower: F,
      subscriptionId: 7n,
      nonce: 15n,
      deadline: BigInt(now - 1),
    });
    relay(v, now, { revert: ['SignatureExpired', [BigInt(now - 1)]] });
  }
  // SEC-04: a Subscribe signed for a key with no subscription yet (expectedLastId 0) is withheld by the relayer. F then
  // subscribes to that leader directly and stops; landing the withheld signature afterwards reverts, and the
  // follower's latest wish (stopped) stands.
  {
    const target = { follower: F, venue: 1, leader: SEC04_LEADER, sodexAccountId: F_ACCOUNT };
    const withheld = sign('F Subscribe signed for a fresh key and withheld by the relayer (SEC-04)', {
      type: 'Subscribe',
      ...target,
      terms: termsC2,
      stopEpoch: index.stopEpochOf(F),
      nonce: 16n,
      deadline: deadline(t(40), 3600),
    });
    const id = nextId();
    const now = t(38);
    run(
      { name: 'F subscribe (direct): the same leader and account (SEC-04)', timestamp: now, from: F, callData: calls.subscribe(1, SEC04_LEADER, F_ACCOUNT, termsC2) },
      { returnData: ok('subscribe', [id]), logs: [log('Subscribed', { subscriptionId: id, follower: F, leader: SEC04_LEADER, subscription: created(target, termsC2, now), symbols: termsC2.symbols })] },
    );
    run(
      { name: 'F unsubscribe (direct): stops copying that leader (SEC-04)', timestamp: t(39), from: F, callData: calls.unsubscribe(id, false) },
      { logs: [log('SubscriptionStopped', { subscriptionId: id, follower: F, closePositions: false, version: rec(id).version + 1, updatedAt: t(39) })] },
    );
    relay(withheld, t(40), { revert: ['LastSubscriptionMismatch', [0n, id]] }, { name: 'The relayer lands the withheld Subscribe after the stop (reverts LastSubscriptionMismatch, SEC-04)' });
  }
  const finalTimestamp = t(40);

  // ---- views after the scenario (block.timestamp = finalTimestamp) ----
  const views: ViewVector[] = [];
  const view = (name: string, functionName: string, args: unknown[], outputs: unknown[], to: Address = CONTRACT, abi: Abi = ABI): void => {
    const callData = encodeFunction(abi, functionName, args);
    views.push({ name, to, functionName, args, callData, success: true, returnData: encodeFunctionResult(abi, functionName, outputs), outputs });
  };
  const viewReverts = (name: string, functionName: string, args: unknown[], errorName: string, errorArgs: unknown[]): void => {
    views.push({
      name,
      to: CONTRACT,
      functionName,
      args,
      callData: encodeFunction(ABI, functionName, args),
      success: false,
      returnData: encodeErrorResult(ABI, errorName, errorArgs),
      errorName,
      errorArgs,
    });
  };
  const now = finalTimestamp;
  view('VERSION', 'VERSION', [], ['1.0.0']);
  view('UPGRADE_INTERFACE_VERSION', 'UPGRADE_INTERFACE_VERSION', [], [UPGRADE_INTERFACE_VERSION]);
  view('DOMAIN_SEPARATOR', 'DOMAIN_SEPARATOR', [], [ds]);
  view('eip712Domain (ERC-5267)', 'eip712Domain', [], ['0x0f', EIP712_NAME, EIP712_VERSION, BigInt(CHAIN_ID), CONTRACT, ZERO_BYTES32, []]);
  viewReverts('proxiableUUID through the proxy (reverts UUPSUnauthorizedCallContext)', 'proxiableUUID', [], 'UUPSUnauthorizedCallContext', []);
  view('owner', 'owner', [], [index.owner]);
  view('pendingOwner', 'pendingOwner', [], [index.pendingOwner]);
  view('paused', 'paused', [], [index.paused]);
  view('builderTerms', 'builderTerms', [], [index.builderTerms]);
  for (const venue of [1, 2, 3]) view(`venueInfo(${venue})`, 'venueInfo', [venue], [index.venueInfo(venue)]);
  view('isExecutor', 'isExecutor', [EXECUTOR], [index.isExecutor(EXECUTOR)]);
  view('executorInfo: de-authorised, lastEpoch kept', 'executorInfo', [EXECUTOR], [index.executorInfo(EXECUTOR)]);
  view('commitment(executor, epoch)', 'commitment', [EXECUTOR, executions.epoch], [index.commitment(EXECUTOR, executions.epoch)]);
  view('commitment(executor, epoch + 1): none', 'commitment', [EXECUTOR, executions.epoch + 1n], [index.commitment(EXECUTOR, executions.epoch + 1n)]);
  view('subscriptionCount', 'subscriptionCount', [], [index.subscriptionCount]);
  for (let id = 1n; id <= index.subscriptionCount; id++) {
    const r = index.getSubscription(id)!;
    const stored = rec(id).status;
    const note = stored !== r.status ? `: stored ${String(enumName(Status, stored))}, effective STOPPED (kill switch)` : '';
    view(`getSubscription(${id})${note}`, 'getSubscription', [id], [r]);
  }
  viewReverts('getSubscription(99): unknown', 'getSubscription', [99n], 'UnknownSubscription', [99n]);
  for (const id of [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 99n]) view(`statusOf(${id})`, 'statusOf', [id], [index.statusOf(id)]);
  for (let id = 1n; id <= 5n; id++) {
    const d = index.stopDetails(id)!;
    view(`stopDetails(${id}): ${d.reason === StopReason.KILL_SWITCH ? 'KILL_SWITCH' : 'FOLLOWER'}`, 'stopDetails', [id], [d.reason, d.closePositions, d.stoppedAt]);
  }
  viewReverts('stopDetails(6): not STOPPED', 'stopDetails', [6n], 'InvalidStatus', [6n, Status.ACTIVE]);
  viewReverts('stopDetails(99): unknown', 'stopDetails', [99n], 'UnknownSubscription', [99n]);
  const page = (p: { ids: bigint[]; total: bigint }) => [p.ids, p.total];
  view('subscriptionsOfFollower(F, 0, 10)', 'subscriptionsOfFollower', [F, 0n, 10n], page(index.subscriptionsOfFollower(F, 0n, 10n)));
  view('subscriptionsOfFollower(F, 1, 2)', 'subscriptionsOfFollower', [F, 1n, 2n], page(index.subscriptionsOfFollower(F, 1n, 2n)));
  view('subscriptionsOfFollower(F, 5, 1): past the end', 'subscriptionsOfFollower', [F, 5n, 1n], page(index.subscriptionsOfFollower(F, 5n, 1n)));
  view('subscriptionsOfFollower(F, 0, 2^256 - 1): limit is not capped', 'subscriptionsOfFollower', [F, 0n, U256_MAX], page(index.subscriptionsOfFollower(F, 0n, U256_MAX)));
  view('subscriptionsOfFollower(W, 0, 10)', 'subscriptionsOfFollower', [W, 0n, 10n], page(index.subscriptionsOfFollower(W, 0n, 10n)));
  view('liveSubscriptionsOfFollower(F, 0, 10): swap-and-pop order', 'liveSubscriptionsOfFollower', [F, 0n, 10n], page(index.liveSubscriptionsOfFollower(F, 0n, 10n)));
  view('liveSubscriptionsOfFollower(F, 1, 5)', 'liveSubscriptionsOfFollower', [F, 1n, 5n], page(index.liveSubscriptionsOfFollower(F, 1n, 5n)));
  view('liveSubscriptionsOfFollower(W, 0, 10): empty after the kill switch', 'liveSubscriptionsOfFollower', [W, 0n, 10n], page(index.liveSubscriptionsOfFollower(W, 0n, 10n)));
  view('subscriptionsOfLeader(2, HL leader)', 'subscriptionsOfLeader', [2, HL_LEADER, 0n, 10n], page(index.subscriptionsOfLeader(2, HL_LEADER, 0n, 10n)));
  view('subscriptionsOfLeader(1, SoDEX leader)', 'subscriptionsOfLeader', [1, SODEX_LEADER, 0n, 10n], page(index.subscriptionsOfLeader(1, SODEX_LEADER, 0n, 10n)));
  view('subscriptionsOfLeader(2, HL leader 2)', 'subscriptionsOfLeader', [2, HL_LEADER2, 0n, 10n], page(index.subscriptionsOfLeader(2, HL_LEADER2, 0n, 10n)));
  for (const [f, acct, venue, leader, label] of [
    [F, F_ACCOUNT, 2, HL_LEADER, 'F, HL leader'],
    [F, F_ACCOUNT, 1, SODEX_LEADER, 'F, SoDEX leader'],
    [F, F_ACCOUNT, 2, HL_LEADER2, 'F, HL leader 2 (stopped)'],
    [W, W_ACCOUNT, 2, HL_LEADER, 'W, HL leader (killed)'],
  ] as const) {
    view(`liveSubscriptionFor(${label})`, 'liveSubscriptionFor', [f, acct, venue, leader], [index.liveSubscriptionFor(f, acct, venue, leader)]);
  }
  for (let id = 1n; id <= index.subscriptionCount; id++) view(`isCopyable(${id})`, 'isCopyable', [id], [index.isCopyable(id, now)]);
  for (const [a, label] of [
    [F, 'F'],
    [W, 'W'],
    [RELAYER, 'relayer'],
  ] as const) {
    view(`stopEpochOf(${label})`, 'stopEpochOf', [a], [index.stopEpochOf(a)]);
  }
  view('killSwitchInfo(F, 1)', 'killSwitchInfo', [F, 1n], [index.killSwitchInfo(F, 1n)]);
  view('killSwitchInfo(W, 1)', 'killSwitchInfo', [W, 1n], [index.killSwitchInfo(W, 1n)]);
  view('killSwitchInfo(F, 2): not reached', 'killSwitchInfo', [F, 2n], [index.killSwitchInfo(F, 2n)]);
  for (let id = 1n; id <= index.subscriptionCount; id++) {
    const e = index.effectiveBuilderFee(id)!;
    view(`effectiveBuilderFee(${id}) = min(fee, consent)`, 'effectiveBuilderFee', [id], [e.builderId, e.perpsFee, e.spotFee]);
  }
  viewReverts('effectiveBuilderFee(99): unknown', 'effectiveBuilderFee', [99n], 'UnknownSubscription', [99n]);
  for (const [a, n, label] of [
    [F, 0n, 'F, 0'],
    [F, 6n, 'F, 6 (its call reverted)'],
    [F, 9n, 'F, 9 (invalidated)'],
    [F, 12n, 'F, 12 (its call reverted)'],
    [F, BIG_NONCE, 'F, 2^255 + 5'],
    [F, 256n, 'F, 256 (invalidated directly)'],
    [W, 7n, 'W, 7 (invalidated by mask)'],
    [W, 8n, 'W, 8 (its call reverted)'],
  ] as const) {
    view(`isNonceUsed(${label})`, 'isNonceUsed', [a, n], [index.isNonceUsed(a, n)]);
  }
  for (const [a, w, label] of [
    [F, 0n, 'F, word 0'],
    [F, 1n, 'F, word 1'],
    [F, BIG_NONCE >> 8n, 'F, word 2^247'],
    [W, 0n, 'W, word 0'],
  ] as const) {
    view(`nonceBitmap(${label})`, 'nonceBitmap', [a, w], [index.nonceBitmap(a, w)]);
  }

  // ---- governance: timelock ownership and an upgrade that keeps every signature valid ----
  const governance = buildGovernance(killSwitchF, ds);

  return {
    keys,
    termsCases: buildTermsCases(F),
    domainSeparator: ds,
    initData,
    deploymentLogs,
    signed,
    steps,
    views,
    finalTimestamp,
    executions,
    governance,
  };

  // --------------------------------------------------------------------------------------------------------------

  function buildExecutions(): Vectors['executions'] {
    const epoch = epochOf(T0);
    const ms = (unix: number, extra: number): bigint => BigInt(unix) * 1000n + BigInt(extra);
    const e18 = (whole: bigint, frac = 0n, fracDigits = 0): bigint => whole * 10n ** 18n + frac * 10n ** BigInt(18 - fracDigits);
    const base = { copyTradingContract: CONTRACT, leaderVenue: 2 };
    const records: ExecutionRecord[] = [
      {
        ...base,
        subscriptionId: 1n,
        subscriptionVersion: 1,
        action: ExecutionAction.MIRROR,
        leaderFillRef: fillRef(`0x${'ab'.repeat(32)}:902174`),
        leaderFillTimeMs: ms(T0 + 30, 123),
        engine: LeafEngine.PERPS,
        symbol: 'BTC-USD',
        side: LeafSide.BUY,
        reduceOnly: false,
        quantity: e18(0n, 15n, 3),
        limitPrice: e18(70_010n, 5n, 1),
        builderFee: 50,
        followerTxHash: `0x${'12'.repeat(32)}`,
        followerOrderTimeMs: ms(T0 + 30, 211),
        skipReason: SkipReason.NONE,
      },
      {
        ...base,
        subscriptionId: 1n,
        subscriptionVersion: 1,
        action: ExecutionAction.SKIP,
        leaderFillRef: fillRef(`0x${'cd'.repeat(32)}:902175`),
        leaderFillTimeMs: ms(T0 + 95, 7),
        engine: LeafEngine.PERPS,
        symbol: 'SOL-USD',
        side: LeafSide.SELL,
        reduceOnly: false,
        quantity: e18(2n),
        limitPrice: 0n,
        builderFee: 0,
        followerTxHash: ZERO_BYTES32,
        followerOrderTimeMs: 0n,
        skipReason: SkipReason.SYMBOL_FILTERED,
      },
      {
        ...base,
        subscriptionId: 1n,
        subscriptionVersion: 2,
        action: ExecutionAction.MIRROR,
        leaderFillRef: fillRef(`0x${'ef'.repeat(32)}:902311`),
        leaderFillTimeMs: ms(T0 + 700, 450),
        engine: LeafEngine.PERPS,
        symbol: 'ETH-USD',
        side: LeafSide.BUY,
        reduceOnly: false,
        quantity: e18(0n, 38n, 3),
        limitPrice: e18(2_630n, 25n, 2),
        builderFee: 30,
        followerTxHash: `0x${'34'.repeat(32)}`,
        followerOrderTimeMs: ms(T0 + 700, 541),
        skipReason: SkipReason.NONE,
      },
      {
        ...base,
        subscriptionId: 1n,
        subscriptionVersion: 3,
        action: ExecutionAction.REDUCE_WHILE_PAUSED,
        leaderFillRef: fillRef(`0x${'01'.repeat(32)}:902402`),
        leaderFillTimeMs: ms(T0 + 1500, 0),
        engine: LeafEngine.PERPS,
        symbol: 'ETH-USD',
        side: LeafSide.SELL,
        reduceOnly: true,
        quantity: e18(0n, 19n, 3),
        limitPrice: e18(2_601n),
        builderFee: 0,
        followerTxHash: `0x${'56'.repeat(32)}`,
        followerOrderTimeMs: ms(T0 + 1500, 97),
        skipReason: SkipReason.NONE,
      },
      {
        ...base,
        leaderVenue: 1,
        subscriptionId: 2n,
        subscriptionVersion: 1,
        action: ExecutionAction.MIRROR,
        leaderFillRef: fillRef('spot:vETH_vUSDC:4409917'),
        leaderFillTimeMs: ms(T0 + 2500, 812),
        engine: LeafEngine.SPOT,
        symbol: 'vETH_vUSDC',
        side: LeafSide.SELL,
        reduceOnly: false,
        quantity: e18(0n, 5n, 1),
        limitPrice: e18(2_612n, 4n, 1),
        builderFee: 100,
        followerTxHash: `0x${'78'.repeat(32)}`,
        followerOrderTimeMs: ms(T0 + 2500, 901),
        skipReason: SkipReason.NONE,
      },
    ];
    const leaves = records.map(executionLeaf);
    const tree = buildMerkleTree(leaves);
    const proofs = leaves.map((l) => merkleProof(tree, l));
    const uri = `ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/${epoch}.json#résumé-✓`;
    return { epoch, uri, records, leaves, root: tree.root, proofs };
  }

  function buildGovernance(presignedStop: SignedVector, ds0: Hex): Vectors['governance'] {
    const gSteps: StepVector[] = [];
    const gViews: ViewVector[] = [];
    const g0 = SETUP_TIME + 600;
    const tl = (eventName: string, args: Record<string, unknown>) => log(eventName, args, TIMELOCK, TIMELOCK_ABI);
    const step = (s: Omit<StepVector, 'success' | 'returnData' | 'logs'> & Partial<StepVector>): void => {
      gSteps.push({ success: true, returnData: '0x', logs: [], ...s });
    };
    const acceptOwnership = ownerCallProposal({ target: CONTRACT, data: calls.acceptOwnership(), salt: saltFromLabel('accept-ownership') });
    const upgrade = upgradeProposal({ proxy: CONTRACT, newImplementation: IMPLEMENTATION_V2, salt: saltFromLabel('v1.0.0-redeploy') });
    const scheduled = (op: TimelockOperation) => [
      tl('CallScheduled', { id: op.id, index: 0n, target: op.target, value: op.value, data: op.data, predecessor: op.predecessor, delay: op.delay }),
      tl('CallSalt', { id: op.id, salt: op.salt }),
    ];
    const executed = (op: TimelockOperation) => tl('CallExecuted', { id: op.id, index: 0n, target: op.target, value: op.value, data: op.data });

    step({
      name: 'Owner transferOwnership(timelock): step 1 of Ownable2Step',
      timestamp: g0,
      from: OWNER,
      to: CONTRACT,
      callData: calls.transferOwnership(TIMELOCK),
      logs: [log('OwnershipTransferStarted', { previousOwner: OWNER, newOwner: TIMELOCK })],
    });
    const t1 = g0 + 60;
    step({ name: 'Multisig schedules acceptOwnership on the timelock', timestamp: t1, from: MULTISIG, to: TIMELOCK, callData: timelockCalls.schedule(acceptOwnership), logs: scheduled(acceptOwnership) });
    step({
      name: 'Multisig executes it one second early (reverts TimelockUnexpectedOperationState)',
      timestamp: t1 + Number(DELAY) - 1,
      from: MULTISIG,
      to: TIMELOCK,
      callData: timelockCalls.execute(acceptOwnership),
      success: false,
      returnData: encodeErrorResult(TIMELOCK_ABI, 'TimelockUnexpectedOperationState', [acceptOwnership.id, readyBitmap()]),
      errorName: 'TimelockUnexpectedOperationState',
      errorArgs: [acceptOwnership.id, readyBitmap()],
    });
    const t2 = t1 + Number(DELAY);
    step({
      name: 'Multisig executes acceptOwnership after 48 h: the timelock owns the proxy',
      timestamp: t2,
      from: MULTISIG,
      to: TIMELOCK,
      callData: timelockCalls.execute(acceptOwnership),
      logs: [log('OwnershipTransferred', { previousOwner: OWNER, newOwner: TIMELOCK }), executed(acceptOwnership)],
    });
    const t3 = t2 + 60;
    step({ name: 'Multisig schedules upgradeToAndCall(V2, 0x): the public 48 h notice', timestamp: t3, from: MULTISIG, to: TIMELOCK, callData: timelockCalls.schedule(upgrade), logs: scheduled(upgrade) });
    step({
      name: 'The multisig cannot upgrade directly (reverts OwnableUnauthorizedAccount)',
      timestamp: t3 + 60,
      from: MULTISIG,
      to: CONTRACT,
      callData: calls.upgradeToAndCall(IMPLEMENTATION_V2, '0x'),
      success: false,
      returnData: encodeErrorResult(ABI, 'OwnableUnauthorizedAccount', [MULTISIG]),
      errorName: 'OwnableUnauthorizedAccount',
      errorArgs: [MULTISIG],
    });
    const t4 = t3 + Number(DELAY);
    step({
      name: 'Multisig executes the upgrade after 48 h',
      timestamp: t4,
      from: MULTISIG,
      to: TIMELOCK,
      callData: timelockCalls.execute(upgrade),
      logs: [log('Upgraded', { implementation: IMPLEMENTATION_V2 }), executed(upgrade)],
    });
    step({
      name: 'F\'s pre-signed UnsubscribeAll still lands after the upgrade (the EIP-712 domain is unchanged)',
      timestamp: t4 + 60,
      from: RELAYER,
      to: CONTRACT,
      callData: presignedStop.callData,
      returnData: encodeFunctionResult(ABI, 'unsubscribeAllWithSig', [1n]),
      logs: [log('NonceUsed', { signer: presignedStop.follower, nonce: 5n }), log('KillSwitchTriggered', { follower: presignedStop.follower, stopEpoch: 1n, closePositions: true })],
    });
    const gv = (name: string, to: Address, abi: Abi, functionName: string, args: unknown[], outputs: unknown[]) =>
      gViews.push({ name, to, functionName, args, callData: encodeFunction(abi, functionName, args), success: true, returnData: encodeFunctionResult(abi, functionName, outputs), outputs });
    gv('owner: the timelock', CONTRACT, ABI, 'owner', [], [TIMELOCK]);
    gv('pendingOwner', CONTRACT, ABI, 'pendingOwner', [], [ZERO_ADDRESS]);
    gv('DOMAIN_SEPARATOR unchanged by the upgrade', CONTRACT, ABI, 'DOMAIN_SEPARATOR', [], [ds0]);
    gv('eip712Domain unchanged by the upgrade', CONTRACT, ABI, 'eip712Domain', [], ['0x0f', EIP712_NAME, EIP712_VERSION, BigInt(CHAIN_ID), CONTRACT, ZERO_BYTES32, []]);
    gv('VERSION', CONTRACT, ABI, 'VERSION', [], ['1.0.0']);
    gv('stopEpochOf(F) after the pre-signed stop', CONTRACT, ABI, 'stopEpochOf', [presignedStop.follower], [1n]);
    gv('timelock getMinDelay', TIMELOCK, TIMELOCK_ABI, 'getMinDelay', [], [DELAY]);
    gv('timelock hashOperation(upgrade) = the package id', TIMELOCK, TIMELOCK_ABI, 'hashOperation', [upgrade.target, upgrade.value, upgrade.data, upgrade.predecessor, upgrade.salt], [upgrade.id]);
    gv('timelock isOperationDone(upgrade)', TIMELOCK, TIMELOCK_ABI, 'isOperationDone', [upgrade.id], [true]);
    gv('timelock getOperationState(acceptOwnership) = Done', TIMELOCK, TIMELOCK_ABI, 'getOperationState', [acceptOwnership.id], [3]);
    gv('timelock getTimestamp(upgrade) = 1 (done)', TIMELOCK, TIMELOCK_ABI, 'getTimestamp', [upgrade.id], [1n]);
    return { operations: { acceptOwnership, upgrade }, steps: gSteps, views: gViews };
  }
}

/**
 * Invalid subscriptions for the differential test of validate.ts against the contract: every single fault once, then
 * seeded combinations of up to three faults (the contract reports the first in its check order, and so must
 * `subscriptionProblems`). Cases the ABI cannot encode (SHAPE) are left out.
 */
function buildTermsCases(F: Address): TermsCase[] {
  let seed = 0x7e57c0de >>> 0;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let x = seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const now = SETUP_TIME;
  const base: Terms = {
    delegatedKey: KEY_F,
    keyName: 'vs-case',
    marketScope: MarketScope.PERPS,
    sizingMode: SizingMode.PROPORTIONAL,
    sizingValue: 1_000_000n,
    allocationCap: 1_000_000_000n,
    maxPositionNotional: 2_000_000_000n,
    maxLeverage: 2,
    tradeStopLossBps: 100,
    maxDrawdownBps: 100,
    takeProfitBps: 100,
    slippageBps: 50,
    symbolMode: SymbolMode.ALLOW,
    symbols: ['BTC-USD'],
    copyExisting: false,
    maxBuilderFeePerps: 10,
    maxBuilderFeeSpot: 10,
    expiry: now + DAY,
  };
  type Target = { venue: number; leader: Address; sodexAccountId: bigint };
  type Fault = [string, (t: Terms, g: Target) => void];
  const faults: Fault[] = [
    ['venue 3 (never registered)', (_t, g) => void (g.venue = 3)],
    ['venue 0', (_t, g) => void (g.venue = 0)],
    ['zero leader', (_t, g) => void (g.leader = ZERO_ADDRESS)],
    ['self-copy on SoDEX', (_t, g) => {
      g.venue = 1;
      g.leader = F;
    }],
    ['zero account', (_t, g) => void (g.sodexAccountId = 0n)],
    ['zero delegated key', (t) => void (t.delegatedKey = ZERO_ADDRESS)],
    ['delegated key = follower', (t) => void (t.delegatedKey = F)],
    ['empty key name', (t) => void (t.keyName = '')],
    ['37-char key name', (t) => void (t.keyName = 'k'.repeat(37))],
    ['key name "default"', (t) => void (t.keyName = 'default')],
    ['key name with a dot', (t) => void (t.keyName = 'vs.case')],
    ['marketScope NONE', (t) => void (t.marketScope = MarketScope.NONE)],
    ['sizingMode NONE', (t) => void (t.sizingMode = SizingMode.NONE)],
    ['zero allocation cap', (t) => void (t.allocationCap = 0n)],
    ['zero leverage', (t) => void (t.maxLeverage = 0)],
    ['SPOT with leverage 2', (t) => void (t.marketScope = MarketScope.SPOT)],
    ['zero max position', (t) => void (t.maxPositionNotional = 0n)],
    ['max position above cap x leverage', (t) => void (t.maxPositionNotional = 2_000_000_001n)],
    ['zero sizing value', (t) => void (t.sizingValue = 0n)],
    ['FIXED_NOTIONAL above max position', (t) => {
      t.sizingMode = SizingMode.FIXED_NOTIONAL;
      t.sizingValue = 2_000_000_001n;
    }],
    ['stop loss 10001', (t) => void (t.tradeStopLossBps = 10_001)],
    ['drawdown 10001', (t) => void (t.maxDrawdownBps = 10_001)],
    ['slippage 0', (t) => void (t.slippageBps = 0)],
    ['slippage 10001', (t) => void (t.slippageBps = 10_001)],
    ['ALL with a symbol', (t) => void (t.symbolMode = SymbolMode.ALL)],
    ['ALLOW without symbols', (t) => void (t.symbols = [])],
    ['symbol with a space', (t) => void (t.symbols = ['BTC USD'])],
    ['empty symbol', (t) => void (t.symbols = ['ETH-USD', ''])],
    ['symbol with DEL (0x7f)', (t) => void (t.symbols = ['BTC\u007f'])],
    ['perps fee 201', (t) => void (t.maxBuilderFeePerps = 201)],
    ['spot fee 2001', (t) => void (t.maxBuilderFeeSpot = 2001)],
    ['expiry = now', (t) => void (t.expiry = now)],
    ['expiry in the past', (t) => void (t.expiry = now - 1)],
  ];
  const cases: TermsCase[] = [];
  const add = (picked: Fault[]): void => {
    const terms: Terms = { ...base, symbols: [...base.symbols] };
    const target: Target = { venue: 2, leader: HL_LEADER, sodexAccountId: F_ACCOUNT };
    for (const [, f] of picked) f(terms, target);
    const venueEnabled = target.venue === 1 || target.venue === 2;
    const problems = subscriptionProblems({ follower: F, ...target }, terms, now, { venueEnabled });
    if (problems.length === 0) throw new Error(`terms case ${picked.map((p) => p[0]).join(' + ')} is valid`);
    const field = problems[0]!.field;
    if (field === 'SHAPE') return;
    const revertData =
      field === 'VENUE_DISABLED'
        ? encodeErrorResult(ABI, 'VenueDisabled', [target.venue])
        : encodeErrorResult(ABI, 'InvalidTerms', [TermsField[field as keyof typeof TermsField]]);
    cases.push({
      name: `${picked.map((p) => p[0]).join(' + ')} -> ${field}`,
      ...target,
      terms,
      field,
      callData: calls.subscribe(target.venue, target.leader, target.sodexAccountId, terms),
      revertData,
    });
  };
  for (const f of faults) add([f]);
  for (let i = 0; i < 30; i++) {
    const n = 2 + Math.floor(rand() * 2);
    const picked = new Set<Fault>();
    while (picked.size < n) picked.add(faults[Math.floor(rand() * faults.length)]!);
    add([...picked]);
  }
  return cases;
}

/** bytes32(1 << uint8(OperationState.Ready)): TimelockController's expected-state bitmap. */
const readyBitmap = (): Hex => `0x${'00'.repeat(31)}04`;

function encodeFunction(abi: Abi, functionName: string, args: unknown[]): Hex {
  if (abi === TIMELOCK_ABI) {
    const f = (timelockCalls as Record<string, unknown>)[functionName];
    if (functionName === 'hashOperation') {
      const [target, value, data, predecessor, salt] = args as [Address, bigint, Hex, Hex, Hex];
      return timelockCalls.hashOperation({ target, value, data, predecessor, salt });
    }
    if (typeof f === 'function') return (f as (...a: unknown[]) => Hex)(...args);
    throw new Error(`no timelock encoder for ${functionName}`);
  }
  const c = (calls as Record<string, unknown>)[functionName];
  if (typeof c !== 'function') throw new Error(`no encoder for ${functionName}`);
  return (c as (...a: unknown[]) => Hex)(...args);
}

// ---------------------------------------------------------------------------
// vectors.json
// ---------------------------------------------------------------------------

const jsonReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

export function renderVectorsJson(v: Vectors): string {
  const doc = {
    description:
      'Cross-implementation vectors of @valuescan/copy-contract (ValuescanCopyTrading 1.0.0 behind an ERC1967Proxy). Generated by ' +
      'packages/copy-contract/tools/gen-vectors.ts; checked against the contract by contracts/test/CrossCheckVectors.t.sol and ' +
      'against viem by packages/copy-contract/test/vectors.test.ts. Integers above 2^53 are decimal strings.',
    testOnly:
      'THE PRIVATE KEYS IN testKeys ARE PUBLIC TEST KEYS (keccak256 of the label). Anyone can sign with them. Never fund them, never ' +
      'use them on any chain. Nothing is deployed: the addresses below exist only inside the Foundry test EVM.',
    chainId: CHAIN_ID,
    contracts: { proxy: CONTRACT, implementation: IMPLEMENTATION, implementationV2: IMPLEMENTATION_V2, timelock: TIMELOCK, erc1271Wallet: WALLET },
    actors: {
      owner: OWNER,
      multisig: MULTISIG,
      relayer: RELAYER,
      executor: EXECUTOR,
      stranger: STRANGER,
      follower: v.keys.follower.address,
      walletOwner: v.keys.walletOwner.address,
      delegatedKeys: { follower: KEY_F, wallet: KEY_W },
      leaders: { hyperliquid: HL_LEADER, hyperliquid2: HL_LEADER2, sodex: SODEX_LEADER },
      sodexAccounts: { follower: F_ACCOUNT, wallet: W_ACCOUNT },
    },
    domainSeparator: v.domainSeparator,
    typeHashes: TYPEHASH,
    testKeys: v.keys,
    deployment: {
      time: SETUP_TIME,
      builder: BUILDER,
      initData: v.initData,
      logs: v.deploymentLogs,
    },
    signed: v.signed.map((s) => ({
      name: s.name,
      primaryType: s.primaryType,
      signerRole: s.signerRole,
      follower: s.follower,
      keyAddress: s.keyAddress,
      action: s.action,
      typedData: JSON.parse(s.typedDataJson) as unknown,
      structHash: s.structHash,
      digest: s.digest,
      signature: s.signature,
      callData: s.callData,
    })),
    steps: v.steps,
    finalTimestamp: v.finalTimestamp,
    views: v.views,
    termsCases: v.termsCases,
    executions: v.executions,
    governance: {
      timelock: TIMELOCK,
      minDelay: DELAY,
      proposers: [MULTISIG],
      executors: [MULTISIG],
      operations: v.governance.operations,
      steps: v.governance.steps,
      views: v.governance.views,
    },
  };
  return JSON.stringify(doc, jsonReplacer, 2) + '\n';
}

// ---------------------------------------------------------------------------
// CrossCheckVectors.t.sol (emitted in `forge fmt` style: line_length 120, number_underscore "thousands")
// ---------------------------------------------------------------------------

const LINE = 120;

class Sol {
  readonly out: string[] = [];
  line(indent: number, s = ''): void {
    this.out.push(s === '' ? '' : ' '.repeat(indent) + s);
  }
  /**
   * `lhs = rhs;`, broken after `=` when the line would exceed the formatter's width. forge fmt indents the continuation
   * by 4, except when the literal fits only without that extra indent (it measures the indented form with a further
   * 4 columns of margin; observed with forge 1.8.3).
   */
  assign(indent: number, lhs: string, rhs: string): void {
    const one = `${' '.repeat(indent)}${lhs} = ${rhs};`;
    // The trailing semicolon does not count against the width (observed: a 121-column assignment stays on one line).
    if (one.length - 1 <= LINE) this.out.push(one);
    else {
      this.out.push(`${' '.repeat(indent)}${lhs} =`);
      const indented = indent + 4 + rhs.length + 1 <= LINE - 4;
      const flat = indent + rhs.length + 1 <= LINE;
      this.out.push(`${' '.repeat(!indented && flat ? indent : indent + 4)}${rhs};`);
    }
  }
  /** `fn(a, b, c);` on one line, else the arguments on one indented line, else one argument per line (forge fmt). */
  call(indent: number, fn: string, args: readonly string[]): void {
    const pad = ' '.repeat(indent);
    const one = `${pad}${fn}(${args.join(', ')});`;
    if (one.length <= LINE) {
      this.out.push(one);
      return;
    }
    this.out.push(`${pad}${fn}(`);
    const inner = `${pad}    ${args.join(', ')}`;
    if (inner.length <= LINE) this.out.push(inner);
    else args.forEach((a, i) => this.out.push(`${pad}    ${a}${i < args.length - 1 ? ',' : ''}`));
    this.out.push(`${pad});`);
  }
  toString(): string {
    return this.out.join('\n') + '\n';
  }
}

const hexLit = (h: Hex): string => `hex"${h.slice(2).toLowerCase()}"`;
const b32 = (h: Hex): string => h.toLowerCase();
const solStr = (s: string): string => {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error(`non-ASCII Solidity string: ${s}`);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};
/** Decimal literal as `forge fmt` writes it with number_underscore = "thousands" (separators from 5 digits on). */
export function solNum(v: bigint | number): string {
  const s = BigInt(v).toString();
  if (s.length < 5) return s;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

const KIND: Record<CopyTradingPrimaryType, number> = {
  Subscribe: 0,
  UpdateSubscription: 1,
  PauseSubscription: 2,
  ResumeSubscription: 3,
  Unsubscribe: 4,
  UnsubscribeAll: 5,
  InvalidateNonces: 6,
};

export function renderFoundryTest(v: Vectors): string {
  const addressNames = new Map<string, string>([
    [CONTRACT, 'CONTRACT'],
    [IMPLEMENTATION, 'IMPLEMENTATION'],
    [IMPLEMENTATION_V2, 'IMPLEMENTATION_V2'],
    [TIMELOCK, 'TIMELOCK'],
    [WALLET, 'WALLET'],
    [OWNER, 'OWNER'],
    [MULTISIG, 'MULTISIG'],
    [RELAYER, 'RELAYER'],
    [STRANGER, 'STRANGER'],
    [EXECUTOR, 'EXECUTOR'],
    [v.keys.follower.address, 'FOLLOWER'],
    [v.keys.walletOwner.address, 'WALLET_OWNER'],
  ]);
  const name = (a: Address): string => {
    const n = addressNames.get(a);
    if (!n) throw new Error(`no Solidity name for ${a}`);
    return n;
  };
  const s = new Sol();
  const I2 = 8;

  s.line(0, '// SPDX-License-Identifier: UNLICENSED');
  s.line(0, 'pragma solidity 0.8.36;');
  s.line(0);
  for (const l of FOUNDRY_HEADER) s.line(0, l);
  s.line(0);
  s.line(0, 'import {Test, Vm} from "forge-std/Test.sol";');
  s.line(0, 'import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";');
  s.line(0, 'import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";');
  s.line(0, 'import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";');
  s.line(0, 'import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";');
  s.line(0, 'import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";');
  s.line(0, 'import {ValuescanCopyTrading} from "../src/ValuescanCopyTrading.sol";');
  s.line(0, 'import {IValuescanCopyTrading, CopyTradingConstants as C} from "../src/interfaces/IValuescanCopyTrading.sol";');
  s.line(0);
  for (const l of WALLET_CONTRACT) s.line(0, l);
  s.line(0);
  s.line(0, '/// @notice Replays the TypeScript package\'s vectors against the contract behind an ERC1967Proxy (see the header).');
  s.line(0, 'contract CrossCheckVectorsTest is Test {');
  for (const l of STRUCTS) s.line(0, l);
  s.line(0);

  // Constants.
  const k = v.keys;
  const consts: Array<[string, string]> = [
    ['uint256 internal constant CHAIN_ID', solNum(CHAIN_ID)],
    ['address internal constant CONTRACT', CONTRACT],
    ['address internal constant IMPLEMENTATION', IMPLEMENTATION],
    ['address internal constant IMPLEMENTATION_V2', IMPLEMENTATION_V2],
    ['address internal constant TIMELOCK', TIMELOCK],
    ['address internal constant WALLET', WALLET],
    ['address internal constant OWNER', OWNER],
    ['address internal constant MULTISIG', MULTISIG],
    ['address internal constant RELAYER', RELAYER],
    ['address internal constant STRANGER', STRANGER],
    ['address internal constant EXECUTOR', EXECUTOR],
    ['uint64 internal constant BUILDER_ID', solNum(BUILDER.builderId)],
    ['uint16 internal constant PERPS_FEE', solNum(BUILDER.perpsFee)],
    ['uint16 internal constant SPOT_FEE', solNum(BUILDER.spotFee)],
    ['uint256 internal constant SETUP_TIME', solNum(SETUP_TIME)],
    ['uint256 internal constant FINAL_TIME', solNum(v.finalTimestamp)],
    ['uint256 internal constant TIMELOCK_DELAY', solNum(DELAY)],
    ['bytes32 internal constant DOMAIN_SEPARATOR', b32(v.domainSeparator)],
    ['bytes32 internal constant IMPLEMENTATION_SLOT', b32(ERC1967_IMPLEMENTATION_SLOT)],
    ['string internal constant FOLLOWER_KEY_LABEL', solStr(k.follower.label)],
    ['string internal constant WALLET_OWNER_KEY_LABEL', solStr(k.walletOwner.label)],
    ['// TEST-ONLY private keys: keccak256 of the labels above. Public; never fund them, never use them on a chain.', ''],
    ['uint256 internal constant FOLLOWER_KEY', k.follower.privateKey],
    ['uint256 internal constant WALLET_OWNER_KEY', k.walletOwner.privateKey],
    ['address internal constant FOLLOWER', k.follower.address],
    ['address internal constant WALLET_OWNER', k.walletOwner.address],
    ['bytes32 internal constant EXECUTIONS_ROOT', b32(v.executions.root)],
  ];
  for (const [lhs, rhs] of consts) {
    if (lhs.startsWith('//')) s.line(4, lhs);
    else s.assign(4, lhs, rhs);
  }
  s.line(0);
  s.line(4, '/// @dev The package\'s calls.initialize(OWNER, BUILDER_ID, PERPS_FEE, SPOT_FEE, [EXECUTOR]): the proxy\'s `_data`.');
  s.line(4, 'function _initData() internal pure returns (bytes memory) {');
  s.assign(I2, 'bytes memory data', hexLit(v.initData));
  s.line(I2, 'return data;');
  s.line(4, '}');
  s.line(0);
  for (const l of FIXED_TESTS) s.line(0, l);
  s.line(0);

  // Type hashes from the package.
  s.line(4, 'function test_typeHashesMatchThePackage() public view {');
  const th: Array<[string, Hex, string]> = [
    ['C.TERMS_TYPEHASH', TYPEHASH.Terms, 'Terms'],
    ['C.SUBSCRIBE_TYPEHASH', TYPEHASH.Subscribe, 'Subscribe'],
    ['C.UPDATE_TYPEHASH', TYPEHASH.UpdateSubscription, 'UpdateSubscription'],
    ['C.PAUSE_TYPEHASH', TYPEHASH.PauseSubscription, 'PauseSubscription'],
    ['C.RESUME_TYPEHASH', TYPEHASH.ResumeSubscription, 'ResumeSubscription'],
    ['C.UNSUBSCRIBE_TYPEHASH', TYPEHASH.Unsubscribe, 'Unsubscribe'],
    ['C.UNSUBSCRIBE_ALL_TYPEHASH', TYPEHASH.UnsubscribeAll, 'UnsubscribeAll'],
    ['C.INVALIDATE_NONCES_TYPEHASH', TYPEHASH.InvalidateNonces, 'InvalidateNonces'],
  ];
  for (const [c, h, label] of th) s.call(I2, 'assertEq', [c, b32(h), `"${label}"`]);
  s.line(I2, 'assertEq(ValuescanCopyTrading(CONTRACT).DOMAIN_SEPARATOR(), DOMAIN_SEPARATOR, "DOMAIN_SEPARATOR");');
  s.line(4, '}');
  s.line(0);

  // Data: deployment logs.
  s.line(4, `uint256 internal constant DEPLOYMENT_LOG_COUNT = ${v.deploymentLogs.length};`);
  s.line(0);
  s.line(4, 'function _deploymentLogs() internal pure returns (ExpectedLog[] memory logs) {');
  s.line(I2, `logs = new ExpectedLog[](${v.deploymentLogs.length});`);
  v.deploymentLogs.forEach((l, j) => emitLog(s, I2, `logs[${j}]`, l, name));
  s.line(4, '}');
  s.line(0);

  // Data: signed vectors.
  s.line(4, `uint256 internal constant SIGNED_COUNT = ${v.signed.length};`);
  s.line(0);
  s.line(4, 'function _signed(uint256 i) internal pure returns (Signed memory) {');
  v.signed.forEach((_, i) => s.line(I2, `if (i == ${i}) return _signed${i}();`));
  s.line(I2, 'revert("no such signed vector");');
  s.line(4, '}');
  v.signed.forEach((sv, i) => {
    s.line(0);
    s.line(4, `function _signed${i}() internal pure returns (Signed memory v) {`);
    s.assign(I2, 'v.name', solStr(sv.name));
    s.line(I2, `v.kind = ${KIND[sv.primaryType]};`);
    s.line(I2, `v.key = ${sv.signerRole === 'follower' ? 'FOLLOWER_KEY' : 'WALLET_OWNER_KEY'};`);
    s.line(I2, `v.follower = ${name(sv.follower)};`);
    s.line(I2, `v.keyAddress = ${name(sv.keyAddress)};`);
    s.line(I2, `v.structHash = ${b32(sv.structHash)};`);
    s.line(I2, `v.digest = ${b32(sv.digest)};`);
    s.assign(I2, 'v.signature', hexLit(sv.signature));
    s.assign(I2, 'v.callData', hexLit(sv.callData));
    s.assign(I2, 'v.typedDataJson', hexLit(bytesToHex(utf8(sv.typedDataJson))));
    s.line(4, '}');
  });
  s.line(0);

  // Data: steps (main and governance).
  emitSteps(s, 'STEP_COUNT', '_step', v.steps, name);
  emitSteps(s, 'GOV_STEP_COUNT', '_govStep', v.governance.steps, name);
  const termsSteps: StepVector[] = v.termsCases.map((c, i) => ({
    name: `terms case ${i}: ${c.name}`,
    timestamp: SETUP_TIME,
    from: v.keys.follower.address,
    to: CONTRACT,
    callData: c.callData,
    success: false,
    returnData: c.revertData,
    logs: [],
  }));
  emitSteps(s, 'TERMS_CASE_COUNT', '_termsCase', termsSteps, name);
  emitViews(s, 'VIEW_COUNT', '_view', v.views, name);
  emitViews(s, 'GOV_VIEW_COUNT', '_govView', v.governance.views, name);

  // Data: execution leaves and proofs.
  const e = v.executions;
  s.line(4, `uint256 internal constant LEAF_COUNT = ${e.leaves.length};`);
  s.line(0);
  s.line(4, 'function _leaf(uint256 i) internal pure returns (bytes32 leaf, bytes32[] memory proof) {');
  e.leaves.forEach((leaf, i) => {
    s.line(I2, `if (i == ${i}) {`);
    s.line(I2 + 4, `leaf = ${b32(leaf)};`);
    s.line(I2 + 4, `proof = new bytes32[](${e.proofs[i]!.length});`);
    e.proofs[i]!.forEach((p, j) => s.line(I2 + 4, `proof[${j}] = ${b32(p)};`));
    s.line(I2 + 4, 'return (leaf, proof);');
    s.line(I2, '}');
  });
  s.line(I2, 'revert("no such leaf");');
  s.line(4, '}');
  s.line(0);

  // The leaf format, re-encoded in Solidity for record 0.
  const r = e.records[0]!;
  const fillId = `0x${'ab'.repeat(32)}:902174`;
  if (r.leaderFillRef !== fillRef(fillId) || r.symbol !== 'BTC-USD') throw new Error('record 0 changed: update the Solidity leaf test');
  s.line(4, '/// @notice The execution-leaf format v1 (spec §7.2), encoded independently in Solidity for record 0, and every');
  s.line(4, '///         proof of the package\'s tree verified with OpenZeppelin\'s MerkleProof against the committed root.');
  s.line(4, 'function test_executionCommitment() public pure {');
  s.line(I2, 'bytes memory head = abi.encode(');
  const headArgs = [
    'keccak256("ValuescanExecution.v1")',
    'CONTRACT',
    `uint256(${solNum(r.subscriptionId)})`,
    `uint32(${solNum(r.subscriptionVersion)})`,
    `uint8(${r.action})`,
    `uint8(${r.leaderVenue})`,
    `keccak256(${solStr(fillId)})`,
    `uint64(${solNum(r.leaderFillTimeMs)})`,
    `uint8(${r.engine})`,
  ];
  headArgs.forEach((a, i) => s.line(I2 + 4, `${a}${i < headArgs.length - 1 ? ',' : ''}`));
  s.line(I2, ');');
  s.line(I2, 'bytes memory tail = abi.encode(');
  const tailArgs = [
    `keccak256(${solStr(r.symbol)})`,
    `uint8(${r.side})`,
    `${r.reduceOnly}`,
    `uint256(${solNum(r.quantity)})`,
    `uint256(${solNum(r.limitPrice)})`,
    `uint16(${solNum(r.builderFee)})`,
    `bytes32(${b32(r.followerTxHash)})`,
    `uint64(${solNum(r.followerOrderTimeMs)})`,
    `uint16(${solNum(r.skipReason)})`,
  ];
  tailArgs.forEach((a, i) => s.line(I2 + 4, `${a}${i < tailArgs.length - 1 ? ',' : ''}`));
  s.line(I2, ');');
  s.line(I2, '(bytes32 leaf0,) = _leaf(0);');
  s.line(I2, 'assertEq(keccak256(bytes.concat(keccak256(bytes.concat(head, tail)))), leaf0, "leaf format v1");');
  s.line(I2, 'for (uint256 i; i < LEAF_COUNT; ++i) {');
  s.line(I2 + 4, '(bytes32 leaf, bytes32[] memory proof) = _leaf(i);');
  s.line(I2 + 4, 'assertTrue(MerkleProof.verify(proof, EXECUTIONS_ROOT, leaf), "proof");');
  s.line(I2, '}');
  s.line(4, '}');
  s.line(0, '}');
  return s.toString();
}

function emitLog(s: Sol, indent: number, lhs: string, l: ExpectedLog, name: (a: Address) => string): void {
  s.line(indent, `// ${l.eventName}`);
  s.line(indent, `${lhs}.emitter = ${name(l.emitter)};`);
  s.line(indent, `${lhs}.topics = new bytes32[](${l.topics.length});`);
  l.topics.forEach((t, j) => s.assign(indent, `${lhs}.topics[${j}]`, b32(t)));
  s.assign(indent, `${lhs}.data`, hexLit(l.data));
}

function emitSteps(s: Sol, countName: string, fn: string, steps: readonly StepVector[], name: (a: Address) => string): void {
  const I2 = 8;
  s.line(4, `uint256 internal constant ${countName} = ${steps.length};`);
  s.line(0);
  s.line(4, `function ${fn}(uint256 i) internal pure returns (Step memory) {`);
  steps.forEach((_, i) => s.line(I2, `if (i == ${i}) return ${fn}${i}();`));
  s.line(I2, 'revert("no such step");');
  s.line(4, '}');
  steps.forEach((st, i) => {
    s.line(0);
    s.line(4, `function ${fn}${i}() internal pure returns (Step memory s) {`);
    s.assign(I2, 's.name', solStr(st.name));
    s.line(I2, `s.timestamp = ${solNum(st.timestamp)};`);
    s.line(I2, `s.from = ${name(st.from)};`);
    s.line(I2, `s.to = ${name(st.to)};`);
    s.assign(I2, 's.callData', hexLit(st.callData));
    s.line(I2, `s.success = ${st.success};`);
    if (st.returnData !== '0x') s.assign(I2, 's.returnData', hexLit(st.returnData));
    if (st.wallet) {
      s.line(I2, `s.wallet = ${name(st.wallet.address)};`);
      s.line(I2, `s.walletDigest = ${b32(st.wallet.digest)};`);
      s.assign(I2, 's.walletSignature', hexLit(st.wallet.signature));
    }
    s.line(I2, `s.logs = new ExpectedLog[](${st.logs.length});`);
    st.logs.forEach((l, j) => emitLog(s, I2, `s.logs[${j}]`, l, name));
    s.line(4, '}');
  });
  s.line(0);
}

function emitViews(s: Sol, countName: string, fn: string, views: readonly ViewVector[], name: (a: Address) => string): void {
  const I2 = 8;
  s.line(4, `uint256 internal constant ${countName} = ${views.length};`);
  s.line(0);
  s.line(4, `function ${fn}(uint256 i) internal pure returns (View memory) {`);
  views.forEach((_, i) => s.line(I2, `if (i == ${i}) return ${fn}${i}();`));
  s.line(I2, 'revert("no such view");');
  s.line(4, '}');
  views.forEach((w, i) => {
    s.line(0);
    s.line(4, `function ${fn}${i}() internal pure returns (View memory w) {`);
    s.assign(I2, 'w.name', solStr(w.name));
    s.line(I2, `w.to = ${name(w.to)};`);
    s.assign(I2, 'w.callData', hexLit(w.callData));
    s.line(I2, `w.success = ${w.success};`);
    s.assign(I2, 'w.returnData', hexLit(w.returnData));
    s.line(4, '}');
  });
  s.line(0);
}

const FOUNDRY_HEADER = [
  '// GENERATED by packages/copy-contract/tools/gen-vectors.ts. DO NOT EDIT BY HAND.',
  '// Regenerate:  cd packages/copy-contract && npm run vectors      Check: npm run vectors:check',
  '// The same vectors, with decoded values, are in packages/copy-contract/test/vectors.json.',
  '//',
  '// Cross-check between the TypeScript bindings (@valuescan/copy-contract) and the contract. Every constant below was',
  '// produced by the package; the tests assert that the contract (V1 implementation behind an ERC1967Proxy), Foundry\'s',
  '// own EIP-712 encoder and Foundry\'s signer agree with it byte for byte:',
  '//   - digests: Foundry\'s vm.eip712HashTypedData on the package\'s eth_signTypedData_v4 JSON equals the package\'s',
  '//     digest, and so does a Solidity recomputation from the package\'s calldata with the contract\'s own type hashes',
  '//     and DOMAIN_SEPARATOR(). The CONTRACT\'s digest: an ERC-1271 wallet follower is called with exactly the package\'s',
  '//     digest for every signed action type (vm.expectCall), and EOA signatures over it are accepted (ECDSA);',
  '//   - signers: vm.sign with the same TEST key gives the package\'s 65 bytes, and ecrecover gives the expected signer;',
  '//   - calldata, events, return and revert data: the scenario submits the package\'s calldata (relayed, direct, by the',
  '//     executor, the owner and a TimelockController) and compares every log and every return or revert payload;',
  '//   - views after the scenario, including the stop-epoch rule (a kill switch STOPS every older subscription without',
  '//     touching its record) and the live set\'s swap-and-pop order;',
  '//   - invalid subscriptions: the first problem the package\'s validation reports is exactly the contract\'s revert;',
  '//   - the execution-leaf format and the package\'s Merkle proofs (OpenZeppelin MerkleProof).',
  '//',
  '// TEST-ONLY KEYS: FOLLOWER_KEY and WALLET_OWNER_KEY are keccak256 of the public labels below. They are published in',
  '// this repository; never fund them, never use them on any chain. Nothing here is deployed: every contract exists only',
  '// inside the Foundry test EVM, at fixed addresses so that the vectors can name them.',
];

const WALLET_CONTRACT = [
  '/// @notice A minimal ERC-1271 smart wallet (TEST ONLY): approves a digest iff its owner key signed it.',
  'contract CrossCheckWallet is IERC1271 {',
  '    address public immutable owner;',
  '',
  '    constructor(address owner_) {',
  '        owner = owner_;',
  '    }',
  '',
  '    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {',
  '        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);',
  '        return err == ECDSA.RecoverError.NoError && recovered == owner ? IERC1271.isValidSignature.selector : bytes4(0);',
  '    }',
  '}',
];

const STRUCTS = [
  '    struct ExpectedLog {',
  '        address emitter;',
  '        bytes32[] topics;',
  '        bytes data;',
  '    }',
  '',
  '    struct Step {',
  '        string name;',
  '        uint256 timestamp;',
  '        address from;',
  '        address to;',
  '        bytes callData;',
  '        bool success;',
  '        bytes returnData;',
  '        address wallet;',
  '        bytes32 walletDigest;',
  '        bytes walletSignature;',
  '        ExpectedLog[] logs;',
  '    }',
  '',
  '    struct View {',
  '        string name;',
  '        address to;',
  '        bytes callData;',
  '        bool success;',
  '        bytes returnData;',
  '    }',
  '',
  '    /// @dev kind: 0 Subscribe, 1 UpdateSubscription, 2 PauseSubscription, 3 ResumeSubscription, 4 Unsubscribe,',
  '    ///      5 UnsubscribeAll, 6 InvalidateNonces.',
  '    struct Signed {',
  '        string name;',
  '        uint8 kind;',
  '        uint256 key;',
  '        address follower;',
  '        address keyAddress;',
  '        bytes32 structHash;',
  '        bytes32 digest;',
  '        bytes signature;',
  '        bytes callData;',
  '        bytes typedDataJson;',
  '    }',
  '',
  '    // The arguments of each ...WithSig function as one tuple, to ABI-decode the package\'s calldata.',
  '    struct SubscribeArgs {',
  '        address follower;',
  '        uint8 venue;',
  '        address leader;',
  '        uint64 sodexAccountId;',
  '        IValuescanCopyTrading.Terms terms;',
  '        uint64 stopEpoch;',
  '        uint256 expectedLastId;',
  '        IValuescanCopyTrading.SignatureParams sig;',
  '    }',
  '',
  '    struct UpdateArgs {',
  '        uint256 subscriptionId;',
  '        uint32 expectedVersion;',
  '        IValuescanCopyTrading.Terms terms;',
  '        IValuescanCopyTrading.SignatureParams sig;',
  '    }',
  '',
  '    struct PauseArgs {',
  '        uint256 subscriptionId;',
  '        IValuescanCopyTrading.SignatureParams sig;',
  '    }',
  '',
  '    struct ResumeArgs {',
  '        uint256 subscriptionId;',
  '        uint32 expectedVersion;',
  '        IValuescanCopyTrading.SignatureParams sig;',
  '    }',
  '',
  '    struct UnsubscribeArgs {',
  '        uint256 subscriptionId;',
  '        bool closePositions;',
  '        IValuescanCopyTrading.SignatureParams sig;',
  '    }',
  '',
  '    struct UnsubscribeAllArgs {',
  '        address follower;',
  '        bool closePositions;',
  '        IValuescanCopyTrading.SignatureParams sig;',
  '    }',
  '',
  '    struct InvalidateArgs {',
  '        address follower;',
  '        uint256 word;',
  '        uint256 mask;',
  '        IValuescanCopyTrading.SignatureParams sig;',
  '    }',
  '',
  '    /// @dev Deployment logs of the proxy, recorded in setUp (only those emitted by CONTRACT).',
  '    bytes32[][] internal _deployTopics;',
  '    bytes[] internal _deployData;',
];

const FIXED_TESTS = [
  '    // ------------------------------------------------------------------------------------------------ setup',
  '',
  '    /// @dev Runs `initCode` at `target` (as forge-std deployCodeTo does): the constructor executes in the context of',
  '    ///      `target`, so its storage writes and immutables bind to that fixed address; the runtime is then installed.',
  '    function _deployAt(address target, bytes memory initCode) internal {',
  '        vm.etch(target, initCode);',
  '        (bool ok, bytes memory runtime) = target.call("");',
  '        require(ok, "constructor reverted");',
  '        vm.etch(target, runtime);',
  '    }',
  '',
  '    function _one(address a) internal pure returns (address[] memory list) {',
  '        list = new address[](1);',
  '        list[0] = a;',
  '    }',
  '',
  '    /// @dev The V1 implementation at IMPLEMENTATION, the proxy at CONTRACT initialised with the package\'s calldata,',
  '    ///      and the ERC-1271 wallet follower at WALLET.',
  '    function setUp() public {',
  '        vm.chainId(CHAIN_ID);',
  '        vm.warp(SETUP_TIME);',
  '        _deployAt(IMPLEMENTATION, type(ValuescanCopyTrading).creationCode);',
  '        vm.recordLogs();',
  '        _deployAt(CONTRACT, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(IMPLEMENTATION, _initData())));',
  '        Vm.Log[] memory logs = vm.getRecordedLogs();',
  '        for (uint256 i; i < logs.length; ++i) {',
  '            if (logs[i].emitter != CONTRACT) continue;',
  '            _deployTopics.push(logs[i].topics);',
  '            _deployData.push(logs[i].data);',
  '        }',
  '        _deployAt(WALLET, abi.encodePacked(type(CrossCheckWallet).creationCode, abi.encode(WALLET_OWNER)));',
  '    }',
  '',
  '    // ------------------------------------------------------------------------------------------------ tests',
  '',
  '    function test_testKeysAreTheLabelledDerivations() public pure {',
  '        assertEq(FOLLOWER_KEY, uint256(keccak256(bytes(FOLLOWER_KEY_LABEL))), "follower key derivation");',
  '        assertEq(WALLET_OWNER_KEY, uint256(keccak256(bytes(WALLET_OWNER_KEY_LABEL))), "wallet owner key derivation");',
  '        assertEq(vm.addr(FOLLOWER_KEY), FOLLOWER, "follower address");',
  '        assertEq(vm.addr(WALLET_OWNER_KEY), WALLET_OWNER, "wallet owner address");',
  '    }',
  '',
  '    /// @notice The proxy, initialised with the package\'s `initialize` calldata, emits exactly the package\'s logs.',
  '    function test_deploymentLogs() public view {',
  '        ExpectedLog[] memory expected = _deploymentLogs();',
  '        assertEq(_deployTopics.length, expected.length, "number of deployment logs");',
  '        for (uint256 i; i < expected.length; ++i) {',
  '            assertEq(expected[i].emitter, CONTRACT, "emitter");',
  '            assertEq(_deployTopics[i], expected[i].topics, "deployment topics");',
  '            assertEq(_deployData[i], expected[i].data, "deployment data");',
  '        }',
  '        assertEq(',
  '            address(uint160(uint256(vm.load(CONTRACT, IMPLEMENTATION_SLOT)))), IMPLEMENTATION, "implementation slot"',
  '        );',
  '        assertEq(ValuescanCopyTrading(CONTRACT).owner(), OWNER, "owner");',
  '    }',
  '',
  '    /// @notice For every signed vector: Foundry\'s EIP-712 encoder on the package\'s wallet JSON, and a Solidity',
  '    ///         recomputation from the package\'s calldata with the contract\'s type hashes and DOMAIN_SEPARATOR(),',
  '    ///         both equal the package\'s digest; vm.sign equals the package\'s signature; ecrecover gives its key.',
  '    function test_signedVectors() public view {',
  '        bytes32 domain = ValuescanCopyTrading(CONTRACT).DOMAIN_SEPARATOR();',
  '        for (uint256 i; i < SIGNED_COUNT; ++i) {',
  '            Signed memory v = _signed(i);',
  '            assertEq(vm.eip712HashTypedData(string(v.typedDataJson)), v.digest, string.concat(v.name, ": JSON digest"));',
  '            bytes32 structHash = _structHash(v);',
  '            assertEq(structHash, v.structHash, string.concat(v.name, ": struct hash"));',
  '            assertEq(',
  '                keccak256(abi.encodePacked("\\x19\\x01", domain, structHash)),',
  '                v.digest,',
  '                string.concat(v.name, ": digest from calldata")',
  '            );',
  '            (uint8 sv, bytes32 r, bytes32 ss) = vm.sign(v.key, v.digest);',
  '            assertEq(abi.encodePacked(r, ss, sv), v.signature, string.concat(v.name, ": vm.sign"));',
  '            assertEq(ecrecover(v.digest, sv, r, ss), v.keyAddress, string.concat(v.name, ": ecrecover"));',
  '        }',
  '    }',
  '',
  '    /// @notice Replays the scenario (every log, return and revert payload), then checks every view.',
  '    function test_scenario() public {',
  '        for (uint256 i; i < STEP_COUNT; ++i) {',
  '            _runStep(_step(i));',
  '        }',
  '        assertEq(vm.getBlockTimestamp(), FINAL_TIME, "final time");',
  '        for (uint256 i; i < VIEW_COUNT; ++i) {',
  '            _checkView(_view(i));',
  '        }',
  '    }',
  '',
  '    /// @notice The package\'s client-side validation reports, as its first problem, exactly the revert the contract',
  '    ///         raises: the same bounds in the same order, for single and combined invalid fields and targets.',
  '    function test_termsValidationMatchesThePackage() public {',
  '        for (uint256 i; i < TERMS_CASE_COUNT; ++i) {',
  '            _runStep(_termsCase(i));',
  '        }',
  '    }',
  '',
  '    /// @notice The recommended governance: ownership moves to a 48 h TimelockController through its own delay, an',
  '    ///         upgrade is scheduled publicly and executes only after the delay, and a signature made before the',
  '    ///         upgrade still lands (the EIP-712 domain is unchanged). Every call is the package\'s calldata.',
  '    function test_timelockGovernance() public {',
  '        _deployAt(',
  '            TIMELOCK,',
  '            abi.encodePacked(',
  '                type(TimelockController).creationCode,',
  '                abi.encode(TIMELOCK_DELAY, _one(MULTISIG), _one(MULTISIG), address(0))',
  '            )',
  '        );',
  '        _deployAt(IMPLEMENTATION_V2, type(ValuescanCopyTrading).creationCode);',
  '        for (uint256 i; i < GOV_STEP_COUNT; ++i) {',
  '            _runStep(_govStep(i));',
  '        }',
  '        for (uint256 i; i < GOV_VIEW_COUNT; ++i) {',
  '            _checkView(_govView(i));',
  '        }',
  '        assertEq(',
  '            address(uint160(uint256(vm.load(CONTRACT, IMPLEMENTATION_SLOT)))), IMPLEMENTATION_V2, "implementation slot"',
  '        );',
  '    }',
  '',
  '    // ------------------------------------------------------------------------------------------------ helpers',
  '',
  '    function _runStep(Step memory s) internal {',
  '        vm.warp(s.timestamp);',
  '        if (s.wallet != address(0)) {',
  '            // The digest the CONTRACT computed is exactly the package\'s: the wallet must be asked about it.',
  '            vm.expectCall(s.wallet, abi.encodeCall(IERC1271.isValidSignature, (s.walletDigest, s.walletSignature)));',
  '        }',
  '        vm.recordLogs();',
  '        vm.prank(s.from);',
  '        (bool ok, bytes memory ret) = s.to.call(s.callData);',
  '        Vm.Log[] memory logs = vm.getRecordedLogs();',
  '        assertEq(ok, s.success, string.concat(s.name, ": success"));',
  '        assertEq(ret, s.returnData, string.concat(s.name, ": return or revert data"));',
  '        assertEq(logs.length, s.logs.length, string.concat(s.name, ": number of logs"));',
  '        for (uint256 j; j < logs.length; ++j) {',
  '            assertEq(logs[j].emitter, s.logs[j].emitter, string.concat(s.name, ": emitter"));',
  '            assertEq(logs[j].topics, s.logs[j].topics, string.concat(s.name, ": topics"));',
  '            assertEq(logs[j].data, s.logs[j].data, string.concat(s.name, ": data"));',
  '        }',
  '    }',
  '',
  '    function _checkView(View memory w) internal view {',
  '        (bool ok, bytes memory ret) = w.to.staticcall(w.callData);',
  '        assertEq(ok, w.success, string.concat(w.name, ": success"));',
  '        assertEq(ret, w.returnData, w.name);',
  '    }',
  '',
  '    /// @dev The calldata\'s arguments as one ABI tuple (an offset word, then the arguments without the selector).',
  '    function _argsAsTuple(bytes memory callData) internal pure returns (bytes memory out) {',
  '        out = new bytes(callData.length + 28);',
  '        out[31] = 0x20;',
  '        for (uint256 i = 4; i < callData.length; ++i) {',
  '            out[i + 28] = callData[i];',
  '        }',
  '    }',
  '',
  '    function _hashStrings(string[] memory items) internal pure returns (bytes32) {',
  '        bytes32[] memory hashes = new bytes32[](items.length);',
  '        for (uint256 i; i < items.length; ++i) {',
  '            hashes[i] = keccak256(bytes(items[i]));',
  '        }',
  '        return keccak256(abi.encodePacked(hashes));',
  '    }',
  '',
  '    function _hashTerms(IValuescanCopyTrading.Terms memory t) internal pure returns (bytes32) {',
  '        return keccak256(',
  '            bytes.concat(',
  '                abi.encode(',
  '                    C.TERMS_TYPEHASH,',
  '                    t.delegatedKey,',
  '                    keccak256(bytes(t.keyName)),',
  '                    uint8(t.marketScope),',
  '                    uint8(t.sizingMode),',
  '                    t.sizingValue,',
  '                    t.allocationCap,',
  '                    t.maxPositionNotional,',
  '                    t.maxLeverage,',
  '                    t.tradeStopLossBps',
  '                ),',
  '                abi.encode(',
  '                    t.maxDrawdownBps,',
  '                    t.takeProfitBps,',
  '                    t.slippageBps,',
  '                    uint8(t.symbolMode),',
  '                    _hashStrings(t.symbols),',
  '                    t.copyExisting,',
  '                    t.maxBuilderFeePerps,',
  '                    t.maxBuilderFeeSpot,',
  '                    t.expiry',
  '                )',
  '            )',
  '        );',
  '    }',
  '',
  '    /// @dev Decodes the vector\'s calldata with Solidity\'s strict ABI decoder, checks the selector and the signature',
  '    ///      bytes it carries, and recomputes the EIP-712 struct hash with the contract\'s type hashes.',
  '    function _structHash(Signed memory v) internal pure returns (bytes32) {',
  '        bytes4 selector = bytes4(v.callData);',
  '        bytes memory args = _argsAsTuple(v.callData);',
  '        if (v.kind == 0) {',
  '            assertTrue(selector == IValuescanCopyTrading.subscribeWithSig.selector, "selector");',
  '            SubscribeArgs memory a = abi.decode(args, (SubscribeArgs));',
  '            assertEq(a.follower, v.follower, "follower");',
  '            assertEq(a.sig.signature, v.signature, "signature bytes");',
  '            return keccak256(',
  '                abi.encode(',
  '                    C.SUBSCRIBE_TYPEHASH,',
  '                    a.follower,',
  '                    a.venue,',
  '                    a.leader,',
  '                    a.sodexAccountId,',
  '                    _hashTerms(a.terms),',
  '                    a.stopEpoch,',
  '                    a.expectedLastId,',
  '                    a.sig.nonce,',
  '                    a.sig.deadline',
  '                )',
  '            );',
  '        }',
  '        if (v.kind == 1) {',
  '            assertTrue(selector == IValuescanCopyTrading.updateSubscriptionWithSig.selector, "selector");',
  '            UpdateArgs memory a = abi.decode(args, (UpdateArgs));',
  '            assertEq(a.sig.signature, v.signature, "signature bytes");',
  '            return keccak256(',
  '                abi.encode(',
  '                    C.UPDATE_TYPEHASH,',
  '                    v.follower,',
  '                    a.subscriptionId,',
  '                    a.expectedVersion,',
  '                    _hashTerms(a.terms),',
  '                    a.sig.nonce,',
  '                    a.sig.deadline',
  '                )',
  '            );',
  '        }',
  '        if (v.kind == 2) {',
  '            assertTrue(selector == IValuescanCopyTrading.pauseSubscriptionWithSig.selector, "selector");',
  '            PauseArgs memory a = abi.decode(args, (PauseArgs));',
  '            assertEq(a.sig.signature, v.signature, "signature bytes");',
  '            return keccak256(abi.encode(C.PAUSE_TYPEHASH, v.follower, a.subscriptionId, a.sig.nonce, a.sig.deadline));',
  '        }',
  '        if (v.kind == 3) {',
  '            assertTrue(selector == IValuescanCopyTrading.resumeSubscriptionWithSig.selector, "selector");',
  '            ResumeArgs memory a = abi.decode(args, (ResumeArgs));',
  '            assertEq(a.sig.signature, v.signature, "signature bytes");',
  '            return keccak256(',
  '                abi.encode(',
  '                    C.RESUME_TYPEHASH, v.follower, a.subscriptionId, a.expectedVersion, a.sig.nonce, a.sig.deadline',
  '                )',
  '            );',
  '        }',
  '        if (v.kind == 4) {',
  '            assertTrue(selector == IValuescanCopyTrading.unsubscribeWithSig.selector, "selector");',
  '            UnsubscribeArgs memory a = abi.decode(args, (UnsubscribeArgs));',
  '            assertEq(a.sig.signature, v.signature, "signature bytes");',
  '            return keccak256(',
  '                abi.encode(',
  '                    C.UNSUBSCRIBE_TYPEHASH, v.follower, a.subscriptionId, a.closePositions, a.sig.nonce, a.sig.deadline',
  '                )',
  '            );',
  '        }',
  '        if (v.kind == 5) {',
  '            assertTrue(selector == IValuescanCopyTrading.unsubscribeAllWithSig.selector, "selector");',
  '            UnsubscribeAllArgs memory a = abi.decode(args, (UnsubscribeAllArgs));',
  '            assertEq(a.follower, v.follower, "follower");',
  '            assertEq(a.sig.signature, v.signature, "signature bytes");',
  '            return keccak256(',
  '                abi.encode(C.UNSUBSCRIBE_ALL_TYPEHASH, a.follower, a.closePositions, a.sig.nonce, a.sig.deadline)',
  '            );',
  '        }',
  '        assertEq(v.kind, 6, "kind");',
  '        assertTrue(selector == IValuescanCopyTrading.invalidateNoncesWithSig.selector, "selector");',
  '        InvalidateArgs memory x = abi.decode(args, (InvalidateArgs));',
  '        assertEq(x.follower, v.follower, "follower");',
  '        assertEq(x.sig.signature, v.signature, "signature bytes");',
  '        return',
  '            keccak256(abi.encode(C.INVALIDATE_NONCES_TYPEHASH, x.follower, x.word, x.mask, x.sig.nonce, x.sig.deadline));',
  '    }',
];

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Whether the committed Solidity file is what the generator produces now. Whitespace is ignored: the generator emits
 * `forge fmt` style, and if a Foundry release formats a line differently, `forge fmt` may reflow the file without the
 * vectors going stale. (vectors.json is compared exactly.)
 */
export const sameSolidity = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

/** Run `forge fmt` on `file` (with the fmt config of the enclosing Foundry project). False if Foundry is not found. */
export function formatWithForge(file: string): boolean {
  let dir = dirname(file);
  while (!existsSync(join(dir, 'foundry.toml'))) {
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const candidates = [
    join(home, '.foundry', 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge'),
    process.platform === 'win32' ? 'forge.exe' : 'forge',
  ];
  for (const forge of candidates) {
    const r = spawnSync(forge, ['fmt', file], { cwd: dir, stdio: 'ignore', timeout: 120_000 });
    if (r.status === 0) return true;
  }
  return false;
}

function main(): void {
  const check = process.argv.includes('--check');
  // `--foundry-out <path>` writes the Solidity file elsewhere (to try it in a scratch copy of the Foundry project).
  const at = process.argv.indexOf('--foundry-out');
  const foundryOut = at > 0 && process.argv[at + 1] && !check ? resolve(process.argv[at + 1]!) : FOUNDRY_TEST;
  const v = buildVectors();
  const json = renderVectorsJson(v);
  const sol = renderFoundryTest(v);
  if (check) {
    const stale: string[] = [];
    if (!existsSync(VECTORS_JSON) || readFileSync(VECTORS_JSON, 'utf8').replace(/\r\n/g, '\n') !== json) stale.push(relative(REPO_DIR, VECTORS_JSON));
    if (!existsSync(FOUNDRY_TEST) || !sameSolidity(readFileSync(FOUNDRY_TEST, 'utf8'), sol)) stale.push(relative(REPO_DIR, FOUNDRY_TEST));
    if (stale.length) {
      console.error(`stale: ${stale.join(', ')} (run npm run vectors)`);
      process.exit(1);
    }
    console.log(
      `vectors up to date (${v.signed.length} signed, ${v.steps.length} steps, ${v.views.length} views, ${v.termsCases.length} terms cases, ` +
        `${v.governance.steps.length} governance steps)`,
    );
    return;
  }
  writeFileSync(VECTORS_JSON, json);
  writeFileSync(foundryOut, sol);
  const formatted = formatWithForge(foundryOut);
  console.log(`wrote ${relative(REPO_DIR, VECTORS_JSON)} and ${relative(REPO_DIR, foundryOut)}${formatted ? ' (forge fmt applied)' : ' (forge not found: run forge fmt)'}`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
