/**
 * Governance proposals for the TimelockController and the announcement helpers, against viem and OpenZeppelin's
 * hashOperation. The Foundry cross-check runs these exact operations through a real TimelockController (48 h) that
 * owns the proxy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, keccak256, toBytes } from 'viem';

import {
  OperationState,
  TIMELOCK_EVENT_TOPICS,
  TIMELOCK_ABI,
  TIMELOCK_ROLES,
  announcementSeverity,
  delayIsSafe,
  ZERO_BYTES32,
  calls,
  decodeTimelockLog,
  describeScheduledCall,
  encodeEventLog,
  hashOperation,
  ownerCallProposal,
  readyAt,
  saltFromLabel,
  timelockCalls,
  timelockControllerAbi,
  toChecksumAddress,
  upgradeProposal,
} from '../src/index.ts';
import { LEADER, PROXY } from './helpers.ts';

const TIMELOCK = toChecksumAddress('0x00000000000000000000000000000000000071e1');
const IMPL = toChecksumAddress('0x00000000000000000000000000000000c0de0002');

test('hashOperation = keccak256(abi.encode(target, value, data, predecessor, salt)) (viem)', () => {
  const data = calls.pause();
  const want = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [PROXY, 0n, data, ZERO_BYTES32, saltFromLabel('pause-1')],
    ),
  );
  assert.equal(hashOperation(PROXY, 0n, data, ZERO_BYTES32, saltFromLabel('pause-1')), want);
});

test('an upgrade proposal: upgradeToAndCall on the proxy, 48 h, value 0, schedule/execute calldata as viem encodes it', () => {
  const op = upgradeProposal({ proxy: PROXY, newImplementation: IMPL, salt: saltFromLabel('v1.1.0') });
  assert.equal(op.target, PROXY);
  assert.equal(op.value, 0n);
  assert.equal(op.delay, 172_800n);
  assert.equal(op.predecessor, ZERO_BYTES32);
  assert.equal(op.data, calls.upgradeToAndCall(IMPL, '0x'));
  assert.equal(op.id, hashOperation(op.target, op.value, op.data, op.predecessor, op.salt));
  const abi = timelockControllerAbi;
  assert.equal(timelockCalls.schedule(op), encodeFunctionData({ abi, functionName: 'schedule', args: [op.target, op.value, op.data, op.predecessor, op.salt, op.delay] }));
  assert.equal(timelockCalls.execute(op), encodeFunctionData({ abi, functionName: 'execute', args: [op.target, op.value, op.data, op.predecessor, op.salt] }));
  assert.equal(timelockCalls.cancel(op.id), encodeFunctionData({ abi, functionName: 'cancel', args: [op.id] }));
  assert.equal(timelockCalls.getOperationState(op.id), encodeFunctionData({ abi, functionName: 'getOperationState', args: [op.id] }));
  assert.equal(saltFromLabel('v1.1.0'), `0x${Buffer.from('v1.1.0').toString('hex').padEnd(64, '0')}`);
  assert.throws(() => saltFromLabel('x'.repeat(33)), RangeError);
  const withInit = upgradeProposal({ proxy: PROXY, newImplementation: IMPL, initData: '0x1234', salt: ZERO_BYTES32, delay: 200_000n });
  assert.equal(withInit.delay, 200_000n);
  assert.notEqual(withInit.id, op.id);
  assert.equal(OperationState.Done, 3);
});

test('monitoring: CallScheduled is decoded and explained (an upgrade vs an owner call vs another target)', () => {
  const up = upgradeProposal({ proxy: PROXY, newImplementation: IMPL, salt: saltFromLabel('v1.1.0') });
  const fee = ownerCallProposal({ target: PROXY, data: calls.setBuilderTerms(231_000n, 60, 100), salt: saltFromLabel('fees') });
  const log = (op: typeof up) =>
    ({
      address: TIMELOCK,
      ...encodeEventLog(TIMELOCK_ABI, 'CallScheduled', { id: op.id, index: 0n, target: op.target, value: op.value, data: op.data, predecessor: op.predecessor, delay: op.delay }),
    }) as const;
  const ev = decodeTimelockLog(log(up), TIMELOCK);
  assert.ok(ev && ev.eventName === 'CallScheduled');
  assert.equal(ev.args.id, up.id);
  assert.deepEqual(describeScheduledCall(ev.args, PROXY), { kind: 'upgrade', newImplementation: IMPL, initData: '0x' });
  const ev2 = decodeTimelockLog(log(fee));
  assert.ok(ev2 && ev2.eventName === 'CallScheduled');
  assert.deepEqual(describeScheduledCall(ev2.args, PROXY), { kind: 'owner-call', functionName: 'setBuilderTerms', args: [231_000n, 60, 100] });
  assert.deepEqual(describeScheduledCall({ target: LEADER, data: '0x' }, PROXY), { kind: 'other-target', target: LEADER });
  assert.deepEqual(describeScheduledCall({ target: PROXY, data: '0xdeadbeef' }, PROXY), { kind: 'undecodable', data: '0xdeadbeef' });
  assert.equal(decodeTimelockLog(log(up), LEADER), null, 'another timelock');
  assert.equal(decodeTimelockLog({ address: TIMELOCK, topics: [`0x${'11'.repeat(32)}`], data: '0x' }), null);
  assert.equal(Object.keys(TIMELOCK_EVENT_TOPICS).length, 7);
  assert.equal(readyAt(1_790_000_000, 172_800n), 1_790_172_800);
});

test('audit SEC-02: a scheduled call on the timelock itself (updateDelay) is critical, and so is a shorter delay', () => {
  const lower = encodeFunctionData({ abi: timelockControllerAbi, functionName: 'updateDelay', args: [0n] });
  const d = describeScheduledCall({ target: TIMELOCK, data: lower }, PROXY, TIMELOCK);
  assert.deepEqual(d, { kind: 'timelock-admin', functionName: 'updateDelay', args: [0n] });
  assert.equal(announcementSeverity(d), 'critical');
  assert.deepEqual(describeScheduledCall({ target: TIMELOCK, data: lower }, PROXY), { kind: 'other-target', target: TIMELOCK }, 'without the timelock address the monitor is blind: pass it');
  const grant = encodeFunctionData({ abi: timelockControllerAbi, functionName: 'grantRole', args: [TIMELOCK_ROLES.PROPOSER_ROLE, LEADER] });
  assert.equal(announcementSeverity(describeScheduledCall({ target: TIMELOCK, data: grant }, PROXY, TIMELOCK)), 'critical');
  assert.equal(announcementSeverity(describeScheduledCall({ target: PROXY, data: calls.upgradeToAndCall(IMPL) }, PROXY, TIMELOCK)), 'critical');
  assert.equal(announcementSeverity(describeScheduledCall({ target: PROXY, data: calls.transferOwnership(LEADER) }, PROXY, TIMELOCK)), 'critical');
  assert.equal(announcementSeverity(describeScheduledCall({ target: PROXY, data: calls.pause() }, PROXY, TIMELOCK)), 'notice');
  assert.equal(announcementSeverity(describeScheduledCall({ target: LEADER, data: '0x' }, PROXY, TIMELOCK)), 'ignore');
  assert.equal(delayIsSafe(172_800n), true);
  assert.equal(delayIsSafe(0n), false);
  // The roles and the events a monitor follows.
  assert.equal(TIMELOCK_ROLES.PROPOSER_ROLE, keccak256(toBytes('PROPOSER_ROLE')));
  assert.equal(TIMELOCK_ROLES.CANCELLER_ROLE, keccak256(toBytes('CANCELLER_ROLE')));
  const md = decodeTimelockLog({ address: TIMELOCK, ...encodeEventLog(TIMELOCK_ABI, 'MinDelayChange', { oldDuration: 172_800n, newDuration: 0n }) }, TIMELOCK);
  assert.deepEqual(md, { eventName: 'MinDelayChange', args: { oldDuration: 172_800n, newDuration: 0n } });
  const rg = decodeTimelockLog({ address: TIMELOCK, ...encodeEventLog(TIMELOCK_ABI, 'RoleGranted', { role: TIMELOCK_ROLES.PROPOSER_ROLE, account: LEADER, sender: TIMELOCK }) }, TIMELOCK);
  assert.equal(rg?.eventName, 'RoleGranted');
});
