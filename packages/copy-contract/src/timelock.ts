/**
 * Governance through the TimelockController (COPY-TRADING.md §10.2, §10.5): building proposals for the multisig, and
 * recognising scheduled operations so the UI and the executor can announce them to followers.
 *
 *   multisig (Safe)  --schedule / execute / cancel-->  TimelockController(minDelay 48 h, admin none)  --owner-->  proxy
 *
 *   const op = upgradeProposal({ proxy, newImplementation, salt: saltFromLabel('v1.1.0') });
 *   // The multisig submits  { to: timelock, data: timelockCalls.schedule(op) }   (from its Safe; this package never sends)
 *   // 48 h later            { to: timelock, data: timelockCalls.execute(op) }
 *
 *   // Monitoring: EVERY CallScheduled on the timelock is decoded and explained before it can execute, including calls
 *   // on the timelock itself (updateDelay can shorten the notice for all later calls: audit SEC-02), and every
 *   // MinDelayChange / RoleGranted / RoleRevoked.
 *   const ev = decodeTimelockLog(log, timelock);
 *   const what = describeScheduledCall(ev.args, proxy, timelock);  // upgrade | owner-call | timelock-admin | ...
 *   const loud = announcementSeverity(what);                        // 'critical' for upgrades and timelock changes
 *
 * Every owner action (upgrade, builder terms, venues, executors, pause) goes through the same delay.
 */
import { timelockControllerAbi } from './abi.ts';
import { type Abi, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, eventTopicOf, getAbiItem } from './abiCodec.ts';
import { type Address, type Hex, ZERO_BYTES32, bytesToHex, hexToBytes, keccak256, sameAddress, utf8 } from './bytes.ts';
import { calls, decodeCall } from './calldata.ts';
import { TIMELOCK_MIN_DELAY_SECONDS } from './constants.ts';
import type { RpcLog } from './events.ts';

export const TIMELOCK_ABI = timelockControllerAbi as unknown as Abi;

/** One timelock operation (single call). `id` = hashOperation(target, value, data, predecessor, salt). */
export interface TimelockOperation {
  target: Address;
  value: bigint;
  data: Hex;
  predecessor: Hex;
  salt: Hex;
  /** Seconds; must be >= the timelock's getMinDelay(). */
  delay: bigint;
  id: Hex;
}

/** `bytes32(bytes(label))` as Solidity writes `bytes32("v2")`: left-aligned, zero-padded; at most 32 bytes. */
export function saltFromLabel(label: string): Hex {
  const b = utf8(label);
  if (b.length > 32) throw new RangeError('a salt label is at most 32 bytes');
  const out = new Uint8Array(32);
  out.set(b);
  return bytesToHex(out);
}

/** TimelockController.hashOperation: keccak256(abi.encode(target, value, data, predecessor, salt)). */
export function hashOperation(target: Address, value: bigint, data: Hex, predecessor: Hex, salt: Hex): Hex {
  const enc = encodeAbiParameters(
    [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'predecessor', type: 'bytes32' },
      { name: 'salt', type: 'bytes32' },
    ],
    [target, value, data, predecessor, salt],
  );
  return bytesToHex(keccak256(hexToBytes(enc)));
}

export interface ProposalInput {
  /** The contract the timelock calls (the proxy). */
  target: Address;
  /** The call (e.g. `calls.setBuilderTerms(...)`). */
  data: Hex;
  /** Distinguishes identical operations; use `saltFromLabel('v1.1.0')` or a random bytes32. */
  salt: Hex;
  /** Operation that must be executed first (bytes32 id), or zero. */
  predecessor?: Hex;
  /** Default: the recommended 48 h. */
  delay?: bigint;
}

/** A timelock operation for any owner call on the proxy. Value is always 0: the contract never accepts funds. */
export function ownerCallProposal(i: ProposalInput): TimelockOperation {
  const predecessor = i.predecessor ?? ZERO_BYTES32;
  const delay = i.delay ?? BigInt(TIMELOCK_MIN_DELAY_SECONDS);
  return { target: i.target, value: 0n, data: i.data, predecessor, salt: i.salt, delay, id: hashOperation(i.target, 0n, i.data, predecessor, i.salt) };
}

/** A timelock operation that upgrades the proxy: `upgradeToAndCall(newImplementation, initData)`. */
export function upgradeProposal(i: {
  proxy: Address;
  newImplementation: Address;
  /** The new version's `reinitializer(n)` call, or 0x. */
  initData?: Hex;
  salt: Hex;
  predecessor?: Hex;
  delay?: bigint;
}): TimelockOperation {
  const p: ProposalInput = { target: i.proxy, data: calls.upgradeToAndCall(i.newImplementation, i.initData ?? '0x'), salt: i.salt };
  if (i.predecessor) p.predecessor = i.predecessor;
  if (i.delay !== undefined) p.delay = i.delay;
  return ownerCallProposal(p);
}

/** Calldata for the TimelockController (sent by the multisig; views by anyone). */
export const timelockCalls = {
  schedule: (op: TimelockOperation): Hex =>
    encodeFunctionData(TIMELOCK_ABI, 'schedule', [op.target, op.value, op.data, op.predecessor, op.salt, op.delay]),
  execute: (op: TimelockOperation): Hex => encodeFunctionData(TIMELOCK_ABI, 'execute', [op.target, op.value, op.data, op.predecessor, op.salt]),
  cancel: (id: Hex): Hex => encodeFunctionData(TIMELOCK_ABI, 'cancel', [id]),
  hashOperation: (op: Pick<TimelockOperation, 'target' | 'value' | 'data' | 'predecessor' | 'salt'>): Hex =>
    encodeFunctionData(TIMELOCK_ABI, 'hashOperation', [op.target, op.value, op.data, op.predecessor, op.salt]),
  getMinDelay: (): Hex => encodeFunctionData(TIMELOCK_ABI, 'getMinDelay', []),
  getTimestamp: (id: Hex): Hex => encodeFunctionData(TIMELOCK_ABI, 'getTimestamp', [id]),
  getOperationState: (id: Hex): Hex => encodeFunctionData(TIMELOCK_ABI, 'getOperationState', [id]),
  isOperationPending: (id: Hex): Hex => encodeFunctionData(TIMELOCK_ABI, 'isOperationPending', [id]),
  isOperationReady: (id: Hex): Hex => encodeFunctionData(TIMELOCK_ABI, 'isOperationReady', [id]),
  isOperationDone: (id: Hex): Hex => encodeFunctionData(TIMELOCK_ABI, 'isOperationDone', [id]),
} as const;

/** TimelockController.OperationState. */
export const OperationState = { Unset: 0, Waiting: 1, Ready: 2, Done: 3 } as const;

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface CallScheduledArgs {
  id: Hex;
  index: bigint;
  target: Address;
  value: bigint;
  data: Hex;
  predecessor: Hex;
  delay: bigint;
}

export type TimelockEvent =
  | { eventName: 'CallScheduled'; args: CallScheduledArgs }
  | { eventName: 'CallExecuted'; args: { id: Hex; index: bigint; target: Address; value: bigint; data: Hex } }
  | { eventName: 'CallSalt'; args: { id: Hex; salt: Hex } }
  | { eventName: 'Cancelled'; args: { id: Hex } }
  | { eventName: 'MinDelayChange'; args: { oldDuration: bigint; newDuration: bigint } }
  | { eventName: 'RoleGranted'; args: { role: Hex; account: Address; sender: Address } }
  | { eventName: 'RoleRevoked'; args: { role: Hex; account: Address; sender: Address } };

const TIMELOCK_EVENTS = ['CallScheduled', 'CallExecuted', 'CallSalt', 'Cancelled', 'MinDelayChange', 'RoleGranted', 'RoleRevoked'] as const;

/** TimelockController roles (OpenZeppelin 5.x): keccak256 of the role name; DEFAULT_ADMIN_ROLE is zero. */
export const TIMELOCK_ROLES = {
  DEFAULT_ADMIN_ROLE: ZERO_BYTES32,
  PROPOSER_ROLE: bytesToHex(keccak256(utf8('PROPOSER_ROLE'))),
  EXECUTOR_ROLE: bytesToHex(keccak256(utf8('EXECUTOR_ROLE'))),
  CANCELLER_ROLE: bytesToHex(keccak256(utf8('CANCELLER_ROLE'))),
} as const satisfies Record<string, Hex>;

/** topic0 of the timelock events a monitor follows. */
export const TIMELOCK_EVENT_TOPICS: Readonly<Record<(typeof TIMELOCK_EVENTS)[number], Hex>> = Object.freeze(
  Object.fromEntries(TIMELOCK_EVENTS.map((n) => [n, eventTopicOf(getAbiItem(TIMELOCK_ABI, 'event', n))])) as Record<
    (typeof TIMELOCK_EVENTS)[number],
    Hex
  >,
);

/** Decode a TimelockController log the monitor cares about; null for other logs (RoleGranted, other contracts...). */
export function decodeTimelockLog(log: Pick<RpcLog, 'address' | 'topics' | 'data'>, timelock?: Address): TimelockEvent | null {
  if (timelock && !sameAddress(log.address, timelock)) return null;
  const t0 = log.topics[0]?.toLowerCase();
  if (!t0 || !Object.values(TIMELOCK_EVENT_TOPICS).some((t) => t.toLowerCase() === t0)) return null;
  return decodeEventLog(TIMELOCK_ABI, log) as unknown as TimelockEvent;
}

/** What a scheduled call does, for the announcement shown to followers. */
export type ScheduledCallDescription =
  /** The proxy's implementation changes. */
  | { kind: 'upgrade'; newImplementation: Address; initData: Hex }
  /** Another owner call on the proxy (builder terms, venues, executors, pause, ownership). */
  | { kind: 'owner-call'; functionName: string; args: unknown[] }
  /**
   * A call on the TIMELOCK ITSELF: `updateDelay` (it can shorten the notice window for every later call, audit SEC-02),
   * `grantRole` / `revokeRole` (it can add a proposer or executor). As serious as an upgrade.
   */
  | { kind: 'timelock-admin'; functionName: string; args: unknown[] }
  | { kind: 'other-target'; target: Address }
  | { kind: 'undecodable'; data: Hex };

/**
 * Explain a CallScheduled (or CallExecuted). Pass the timelock's own address so that calls on the timelock itself are
 * recognised: a monitor MUST watch every CallScheduled on the timelock, not only those that target the proxy, because
 * a timelock self-call can lower the delay first and then upgrade the proxy with no notice (audit SEC-02).
 */
export function describeScheduledCall(call: { target: Address; data: Hex }, proxy: Address, timelock?: Address): ScheduledCallDescription {
  const onTimelock = timelock !== undefined && sameAddress(call.target, timelock);
  if (!onTimelock && !sameAddress(call.target, proxy)) return { kind: 'other-target', target: call.target };
  let d: { functionName: string; args: unknown[] };
  try {
    d = onTimelock ? decodeFunctionData(TIMELOCK_ABI, call.data) : decodeCall(call.data);
  } catch {
    return { kind: 'undecodable', data: call.data };
  }
  if (onTimelock) return { kind: 'timelock-admin', functionName: d.functionName, args: d.args };
  if (d.functionName === 'upgradeToAndCall') {
    const [newImplementation, initData] = d.args as [Address, Hex];
    return { kind: 'upgrade', newImplementation, initData };
  }
  return { kind: 'owner-call', functionName: d.functionName, args: d.args };
}

/** How loudly to announce a scheduled call: `critical` (upgrade, timelock administration, undecodable) or `notice`. */
export function announcementSeverity(d: ScheduledCallDescription): 'critical' | 'notice' | 'ignore' {
  if (d.kind === 'upgrade' || d.kind === 'timelock-admin' || d.kind === 'undecodable') return 'critical';
  if (d.kind === 'owner-call') {
    // Handing the proxy to another owner is as serious as an upgrade.
    return d.functionName === 'transferOwnership' || d.functionName === 'acceptOwnership' ? 'critical' : 'notice';
  }
  return 'ignore';
}

/**
 * Whether the governance guarantee still holds: the timelock's delay is at least `minimum` (default the recommended
 * 48 h). Check `getMinDelay()` on start-up and on every MinDelayChange; if it fails, tell followers the notice window
 * is gone.
 */
export const delayIsSafe = (minDelay: bigint, minimum: bigint = BigInt(TIMELOCK_MIN_DELAY_SECONDS)): boolean => minDelay >= minimum;

/** Unix time from which a scheduled operation can execute: the scheduling block's timestamp + delay. */
export const readyAt = (scheduledBlockTimestamp: number, delay: bigint): number => scheduledBlockTimestamp + Number(delay);
