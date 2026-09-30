/**
 * The TypeScript mirrors against the normative Solidity: CopyTradingConstants, the EIP-712 type strings and hashes,
 * the enums, the structs, the errors and the committed ABI. Parses contracts/src/interfaces/IValuescanCopyTrading.sol
 * and the implementation directly, so any drift in the contract fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as cc from '../src/index.ts';
import { FOLLOWER, LEADER, NOW, implementationPath, interfacePath, validTerms } from './helpers.ts';

const sol = readFileSync(interfacePath, 'utf8');
const impl = readFileSync(implementationPath, 'utf8');

/** `<type> internal constant NAME = <expr>;` inside CopyTradingConstants. */
function solConstants(): Map<string, string> {
  const lib = sol.slice(sol.indexOf('library CopyTradingConstants'), sol.indexOf('interface IValuescanCopyTrading'));
  const out = new Map<string, string>();
  for (const m of lib.matchAll(/(?:uint\d+|string|bytes32)\s+internal\s+constant\s+(\w+)\s*=\s*([\s\S]*?);/g)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const solNumber = (expr: string): bigint => {
  if (!/^[\d_]+$/.test(expr)) throw new Error(`not a numeric constant: ${expr}`);
  return BigInt(expr.replace(/_/g, ''));
};

function solString(expr: string): string {
  const lit = /^"([^"]*)"$/.exec(expr.trim());
  if (!lit) throw new Error(`not a string literal: ${expr}`);
  return lit[1]!;
}

function solEnum(name: string): string[] {
  const m = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(sol);
  if (!m) throw new Error(`enum ${name} not found`);
  return m[1]!
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').trim())
    .filter(Boolean);
}

function solStructFields(struct: string): string[] {
  const m = new RegExp(`struct\\s+${struct}\\s*\\{([\\s\\S]*?)\\}`).exec(sol);
  if (!m) throw new Error(`struct ${struct} not found`);
  return [...m[1]!.replace(/\/\/.*$/gm, '').matchAll(/[\w.[\]]+\s+(\w+);/g)].map((x) => x[1]!);
}

test('numeric constants equal CopyTradingConstants (and there are no product limits)', () => {
  const c = solConstants();
  const expect: Record<string, number | bigint> = {
    VENUE_SODEX: cc.Venue.SODEX,
    VENUE_HYPERLIQUID: cc.Venue.HYPERLIQUID,
    PERPS_BUILDER_FEE_CAP: cc.PERPS_BUILDER_FEE_CAP,
    SPOT_BUILDER_FEE_CAP: cc.SPOT_BUILDER_FEE_CAP,
    MAX_BPS: cc.MAX_BPS,
    MAX_KEY_NAME_LENGTH: cc.MAX_KEY_NAME_LENGTH,
  };
  const numericInSol = [...c.entries()].filter(([, v]) => /^[\d_]+$/.test(v)).map(([k]) => k);
  assert.deepEqual(numericInSol.sort(), Object.keys(expect).sort(), 'every numeric constant is mirrored, and nothing else exists');
  for (const [name, ts] of Object.entries(expect)) assert.equal(solNumber(c.get(name)!), BigInt(ts), name);
  // The old limits are gone from the package too.
  for (const gone of ['MAX_LIVE_SUBSCRIPTIONS_PER_FOLLOWER', 'MAX_SYMBOLS', 'MAX_PAGE_SIZE', 'MAX_SUBSCRIPTION_DURATION', 'MAX_SYMBOL_LENGTH']) {
    assert.equal((cc as Record<string, unknown>)[gone], undefined, `${gone} must not exist`);
  }
});

test('EIP-712 name, version and type strings equal CopyTradingConstants', () => {
  const c = solConstants();
  assert.equal(solString(c.get('EIP712_NAME')!), cc.EIP712_NAME);
  assert.equal(solString(c.get('EIP712_VERSION')!), cc.EIP712_VERSION);
  const pairs: Array<[string, string]> = [
    ['TERMS_TYPE', cc.TERMS_TYPE],
    ['SUBSCRIBE_TYPE', cc.SUBSCRIBE_TYPE],
    ['UPDATE_TYPE', cc.UPDATE_TYPE],
    ['PAUSE_TYPE', cc.PAUSE_TYPE],
    ['RESUME_TYPE', cc.RESUME_TYPE],
    ['UNSUBSCRIBE_TYPE', cc.UNSUBSCRIBE_TYPE],
    ['UNSUBSCRIBE_ALL_TYPE', cc.UNSUBSCRIBE_ALL_TYPE],
    ['INVALIDATE_NONCES_TYPE', cc.INVALIDATE_NONCES_TYPE],
  ];
  const strings = [...c.entries()].filter(([k]) => k.endsWith('_TYPE')).map(([k]) => k);
  assert.deepEqual(strings.sort(), pairs.map(([k]) => k).sort(), 'every type string is mirrored');
  for (const [name, ts] of pairs) assert.equal(solString(c.get(name)!), ts, name);
  // The implementation pins the domain in code (not storage), from these constants.
  assert.match(impl, /function _EIP712Name\(\)[\s\S]*?return C\.EIP712_NAME;/);
  assert.match(impl, /function _EIP712Version\(\)[\s\S]*?return C\.EIP712_VERSION;/);
});

test('type hashes: published constants == keccak(type string) == encodeType(typed-data field lists)', () => {
  const strings: Record<keyof typeof cc.TYPEHASH, string> = {
    Terms: cc.TERMS_TYPE,
    Subscribe: cc.SUBSCRIBE_TYPE,
    UpdateSubscription: cc.UPDATE_TYPE,
    PauseSubscription: cc.PAUSE_TYPE,
    ResumeSubscription: cc.RESUME_TYPE,
    Unsubscribe: cc.UNSUBSCRIBE_TYPE,
    UnsubscribeAll: cc.UNSUBSCRIBE_ALL_TYPE,
    InvalidateNonces: cc.INVALIDATE_NONCES_TYPE,
  };
  for (const [name, str] of Object.entries(strings) as Array<[keyof typeof cc.TYPEHASH, string]>) {
    assert.equal(cc.keccakUtf8(str), cc.TYPEHASH[name], `keccak ${name}`);
    const types = name === 'Terms' ? { Terms: cc.TERMS_FIELDS } : cc.typesFor(name);
    assert.equal(cc.encodeType(name, types), str, `encodeType ${name}`);
    assert.equal(cc.typeHash(name, types), cc.TYPEHASH[name], `typeHash ${name}`);
  }
  assert.equal(cc.encodeType('EIP712Domain', { EIP712Domain: cc.EIP712_DOMAIN_FIELDS }), cc.EIP712_DOMAIN_TYPE);
  assert.deepEqual([...cc.PRIMARY_TYPES].sort(), Object.keys(cc.TYPEHASH).filter((k) => k !== 'Terms').sort());
});

test('enums have the Solidity ordinals', () => {
  const check = (name: string, ts: Record<string, number>) => {
    const members = solEnum(name);
    assert.deepEqual(Object.keys(ts), members, `${name} members in order`);
    members.forEach((m, i) => assert.equal(ts[m], i, `${name}.${m}`));
  };
  check('Status', cc.Status);
  check('MarketScope', cc.MarketScope);
  check('SizingMode', cc.SizingMode);
  check('SymbolMode', cc.SymbolMode);
  check('StopReason', cc.StopReason);
  check('TermsField', cc.TermsField);
  assert.equal(cc.enumName(cc.Status, 2), 'PAUSED');
  assert.equal(cc.enumName(cc.Status, 9), undefined);
});

test('struct field lists match the interface declaration order (EIP-712 Terms and every ABI tuple)', () => {
  assert.deepEqual(
    cc.TERMS_FIELDS.map((f) => f.name),
    solStructFields('Terms'),
    'EIP-712 Terms fields follow the Solidity struct',
  );
  const outTuple = (fn: string): string[] => {
    const item = cc.ABI.find((i) => i.type === 'function' && i.name === fn) as cc.AbiFunctionItem;
    return item.outputs[0]!.components!.map((c) => c.name!);
  };
  const inTuple = (fn: string, idx: number): string[] => {
    const item = cc.ABI.find((i) => i.type === 'function' && i.name === fn) as cc.AbiFunctionItem;
    return item.inputs[idx]!.components!.map((c) => c.name!);
  };
  assert.deepEqual(outTuple('getSubscription'), solStructFields('Subscription'));
  assert.deepEqual(outTuple('builderTerms'), solStructFields('BuilderTerms'));
  assert.deepEqual(outTuple('venueInfo'), solStructFields('Venue'));
  assert.deepEqual(outTuple('commitment'), solStructFields('Commitment'));
  assert.deepEqual(outTuple('executorInfo'), solStructFields('Executor'));
  assert.deepEqual(outTuple('killSwitchInfo'), solStructFields('KillSwitch'));
  assert.deepEqual(inTuple('subscribe', 3), solStructFields('Terms'));
  assert.deepEqual(inTuple('subscribeWithSig', 7), solStructFields('SignatureParams'));
  // The package builds and decodes records with the same keys in the same order.
  const rec = cc.storedSubscription(
    { follower: FOLLOWER, venue: 2, leader: LEADER, sodexAccountId: 224_678n },
    validTerms(),
    { status: cc.Status.ACTIVE, version: 1, createdAt: NOW, updatedAt: NOW, stopEpoch: 0n },
  );
  assert.deepEqual(Object.keys(rec), solStructFields('Subscription'));
  const decoded = cc.results.getSubscription(cc.encodeFunctionResult(cc.ABI, 'getSubscription', [rec]));
  assert.deepEqual(Object.keys(decoded), solStructFields('Subscription'));
  assert.deepEqual(decoded, { ...rec, follower: cc.toChecksumAddress(FOLLOWER), leader: cc.toChecksumAddress(LEADER) });
});

test('every event, error and function of the interface is in the committed ABI, and nothing else is payable', () => {
  const names = (kind: 'event' | 'error' | 'function') =>
    new Set(cc.ABI.filter((i) => i.type === kind).map((i) => (i as { name: string }).name));
  const iface = sol.slice(sol.indexOf('interface IValuescanCopyTrading'));
  for (const m of iface.matchAll(/^\s*event\s+(\w+)\s*\(/gm)) assert.ok(names('event').has(m[1]!), `event ${m[1]}`);
  for (const m of iface.matchAll(/^\s*error\s+(\w+)\s*\(/gm)) assert.ok(names('error').has(m[1]!), `error ${m[1]}`);
  for (const m of iface.matchAll(/^\s*function\s+(\w+)\s*\(/gm)) assert.ok(names('function').has(m[1]!), `function ${m[1]}`);
  // The OpenZeppelin members the spec says the implementation exposes.
  for (const f of [
    'owner',
    'pendingOwner',
    'transferOwnership',
    'acceptOwnership',
    'renounceOwnership',
    'paused',
    'eip712Domain',
    'upgradeToAndCall',
    'proxiableUUID',
    'UPGRADE_INTERFACE_VERSION',
    'initialize',
  ]) {
    assert.ok(names('function').has(f), `function ${f}`);
  }
  // Removed from the previous draft.
  for (const f of ['hashSubscribe', 'getSubscriptions', 'verifyExecution', 'limits', 'closeExpired', 'registerOperator', 'setLeaderProfile']) {
    assert.ok(!names('function').has(f), `${f} is gone`);
  }
  assert.ok(!cc.ABI.some((i) => i.type === 'receive' || i.type === 'fallback'), 'no receive or fallback');
  const payable = cc.ABI.filter((i) => i.type === 'function' && (i as cc.AbiFunctionItem).stateMutability === 'payable').map((i) => (i as cc.AbiFunctionItem).name);
  assert.deepEqual(payable, ['upgradeToAndCall'], 'only the UUPS upgrade is payable (and it rejects value)');
  assert.ok(names('error').has('FundsNotAccepted'));
  // Every function has a typed builder, and every view a typed decoder.
  for (const f of cc.ABI.filter((i): i is cc.AbiFunctionItem => i.type === 'function')) {
    assert.equal(typeof (cc.calls as Record<string, unknown>)[f.name], 'function', `calls.${f.name}`);
    if (f.stateMutability === 'view' || f.stateMutability === 'pure') {
      if (f.name === 'renounceOwnership') continue; // a view that always reverts
      assert.equal(typeof (cc.results as Record<string, unknown>)[f.name], 'function', `results.${f.name}`);
    }
  }
  // Every event has a name in EVENT_NAMES.
  assert.deepEqual([...names('event')].sort(), [...cc.EVENT_NAMES].sort());
});

test('the committed ABI came from the implementation artifact, and CONTRACT_VERSION matches VERSION()', () => {
  assert.equal(cc.ABI_SOURCES.valuescanCopyTradingAbi.artifact, 'contracts/out/ValuescanCopyTrading.sol/ValuescanCopyTrading.json');
  assert.match(cc.ABI_SOURCES.valuescanCopyTradingAbi.compiler, /^0\.8\.36\+/);
  const v = /function VERSION\(\)[^{]*\{\s*return "([^"]+)";/.exec(impl);
  assert.ok(v, 'VERSION() in the implementation');
  assert.equal(v[1], cc.CONTRACT_VERSION);
  const loc = /STORAGE_LOCATION = (0x[0-9a-f]{64});/.exec(impl);
  assert.equal(loc?.[1], cc.COPY_TRADING_STORAGE_LOCATION);
});

test('chain, gateway and ERC-1967 constants', () => {
  assert.equal(cc.VALUECHAIN_CHAIN_ID, 0x45f9f);
  assert.equal(cc.SODEX_CLOB_GATEWAY, '0x0101010101010101010101010101010101010101');
  const sel = (s: string) => cc.keccakUtf8(s).slice(0, 10);
  assert.equal(sel('getAccountsByAddress(address)'), cc.SODEX_GATEWAY_SELECTORS.getAccountsByAddress);
  assert.equal(sel('addAPIKey(uint256,string,bytes)'), cc.SODEX_GATEWAY_SELECTORS.addAPIKey);
  assert.equal(sel('revokeAPIKey(uint256,string)'), cc.SODEX_GATEWAY_SELECTORS.revokeAPIKey);
  const slot = (BigInt(cc.keccakUtf8('eip1967.proxy.implementation')) - 1n).toString(16).padStart(64, '0');
  assert.equal(cc.ERC1967_IMPLEMENTATION_SLOT, `0x${slot}`);
  const erc7201 = cc.bytesToHex(
    cc.uintToWord(
      BigInt(cc.keccak256Hex(cc.uintToWord(BigInt(cc.keccakUtf8('valuescan.storage.CopyTrading')) - 1n))) & ~0xffn,
    ),
  );
  assert.equal(erc7201, cc.COPY_TRADING_STORAGE_LOCATION, 'ERC-7201 formula');
  assert.deepEqual(Object.keys(cc.DEPLOYMENTS), [], 'nothing is deployed');
  assert.equal(cc.TIMELOCK_MIN_DELAY_SECONDS, 48 * 3600);
});
