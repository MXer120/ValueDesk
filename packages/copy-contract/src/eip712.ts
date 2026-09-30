/**
 * EIP-712 typed data for every `...WithSig` action of ValuescanCopyTrading, and a general EIP-712 encoder (nested
 * structs, arrays, strings) that hashes them exactly as a spec-compliant wallet does.
 *
 * What a follower's wallet signs:
 *
 *   const req = prepareSubscribe({ verifyingContract: proxy }, {
 *     follower, venue, leader, sodexAccountId, terms, stopEpoch, expectedLastId, nonce, deadline,
 *   });
 *   const signature = await provider.request({
 *     method: 'eth_signTypedData_v4',
 *     params: [follower, serializeTypedData(req.typedData)],
 *   });
 *   // The contract recomputes req.digest from the call's arguments; ECDSA must recover `follower` (or the follower's
 *   // ERC-1271 wallet must approve req.digest).
 *
 * The domain is { name: "ValuescanCopyTrading", version: "1", chainId: 286623, verifyingContract: THE PROXY }. The
 * contract has no digest views: check the domain against `eip712Domain()` / `DOMAIN_SEPARATOR()` (see
 * `domainFromEip712Domain`), then hash here. MetaMask-style wallets refuse typed data whose chainId differs from the
 * active chain, so the UI switches the wallet to ValueChain first.
 *
 * The follower signs readable strings (`keyName`, each symbol). The contract stores `keyName` and only the commitment
 * `symbolsHash` of the list (= `symbolsHash(symbols)` here); the full list is emitted in the events.
 *
 * Verified against viem's hashTypedData (test/eip712.test.ts), the published spec vectors (COPY-TRADING.md §6.8), and
 * the contract itself (contracts/test/CrossCheckVectors.t.sol: Foundry's `vm.eip712HashTypedData` on the JSON below,
 * ECDSA acceptance, and the exact digest an ERC-1271 wallet receives from the contract).
 */
import {
  type Address,
  type Hex,
  MAX_UINT256,
  assertAddress,
  bytesToHex,
  concatBytes,
  hexToBytes,
  isHex,
  keccak256,
  sameAddress,
  toUint,
  uintToWord,
  utf8,
} from './bytes.ts';
import { EIP712_NAME, EIP712_VERSION, VALUECHAIN_CHAIN_ID } from './constants.ts';
import type { Eip712DomainInfo, Terms } from './types.ts';

// ---------------------------------------------------------------------------
// General EIP-712
// ---------------------------------------------------------------------------

export interface TypedDataField {
  readonly name: string;
  readonly type: string;
}

export type TypedDataTypes = Readonly<Record<string, readonly TypedDataField[]>>;

export interface TypedDataDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/** An `eth_signTypedData_v4` payload (before JSON serialisation: uint64/uint256 values are bigints). */
export interface TypedData<P extends string = string, M = Record<string, unknown>> {
  types: TypedDataTypes;
  primaryType: P;
  domain: TypedDataDomain;
  message: M;
}

export const EIP712_DOMAIN_FIELDS: readonly TypedDataField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

export class TypedDataError extends Error {
  override name = 'TypedDataError';
}

const baseType = (t: string): string => t.replace(/(\[\d*\])+$/, '');

function dependencies(primary: string, types: TypedDataTypes, found = new Set<string>()): Set<string> {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const f of types[primary]!) dependencies(baseType(f.type), types, found);
  return found;
}

/** `Primary(fields)Dep1(fields)Dep2(fields)`, dependencies sorted by name (EIP-712 `encodeType`). */
export function encodeType(primaryType: string, types: TypedDataTypes): string {
  if (!types[primaryType]) throw new TypedDataError(`unknown type ${primaryType}`);
  const deps = [...dependencies(primaryType, types)].filter((t) => t !== primaryType).sort();
  return [primaryType, ...deps].map((t) => `${t}(${types[t]!.map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
}

export const typeHash = (primaryType: string, types: TypedDataTypes): Hex =>
  bytesToHex(keccak256(utf8(encodeType(primaryType, types))));

function encodeField(type: string, value: unknown, types: TypedDataTypes, path: string): Uint8Array {
  if (types[type]) {
    if (value === null || typeof value !== 'object') throw new TypedDataError(`${path}: expected a ${type} struct`);
    return hashStructBytes(type, value as Record<string, unknown>, types, path);
  }
  const arr = /^(.*)\[(\d*)\]$/.exec(type);
  if (arr) {
    if (!Array.isArray(value)) throw new TypedDataError(`${path}: expected an array`);
    if (arr[2] !== '' && value.length !== Number(arr[2])) {
      throw new TypedDataError(`${path}: expected ${arr[2]} elements, got ${value.length}`);
    }
    return keccak256(concatBytes(...value.map((v, i) => encodeField(arr[1]!, v, types, `${path}[${i}]`))));
  }
  if (type === 'string') {
    if (typeof value !== 'string') throw new TypedDataError(`${path}: expected a string`);
    return keccak256(utf8(value));
  }
  if (type === 'bytes') {
    if (typeof value !== 'string' || !isHex(value)) throw new TypedDataError(`${path}: expected 0x hex bytes`);
    return keccak256(hexToBytes(value));
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new TypedDataError(`${path}: expected a boolean`);
    return uintToWord(value ? 1n : 0n);
  }
  if (type === 'address') {
    const out = new Uint8Array(32);
    try {
      out.set(hexToBytes(assertAddress(value, path)), 12);
    } catch (e) {
      throw new TypedDataError((e as Error).message);
    }
    return out;
  }
  const uint = /^uint(\d+)$/.exec(type);
  if (uint) {
    try {
      return uintToWord(toUint(value, Number(uint[1]), path));
    } catch (e) {
      throw new TypedDataError((e as Error).message);
    }
  }
  const int = /^int(\d+)$/.exec(type);
  if (int) {
    const bits = BigInt(int[1]!);
    const v =
      typeof value === 'bigint' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : null;
    if (v === null || v < -(1n << (bits - 1n)) || v >= 1n << (bits - 1n)) {
      throw new TypedDataError(`${path}: expected an int${bits}`);
    }
    return uintToWord(v < 0n ? v + MAX_UINT256 + 1n : v);
  }
  const fb = /^bytes(\d+)$/.exec(type);
  if (fb) {
    if (typeof value !== 'string' || !isHex(value, Number(fb[1]))) {
      throw new TypedDataError(`${path}: expected ${fb[1]} bytes of hex`);
    }
    const out = new Uint8Array(32);
    out.set(hexToBytes(value));
    return out;
  }
  throw new TypedDataError(`${path}: unsupported EIP-712 type ${type}`);
}

function hashStructBytes(
  primaryType: string,
  data: Record<string, unknown>,
  types: TypedDataTypes,
  path: string,
): Uint8Array {
  const fields = types[primaryType];
  if (!fields) throw new TypedDataError(`unknown type ${primaryType}`);
  const parts: Uint8Array[] = [keccak256(utf8(encodeType(primaryType, types)))];
  for (const f of fields) {
    if (!(f.name in data)) throw new TypedDataError(`${path}.${f.name} is missing`);
    parts.push(encodeField(f.type, data[f.name], types, `${path}.${f.name}`));
  }
  const extra = Object.keys(data).filter((k) => !fields.some((f) => f.name === k));
  if (extra.length) {
    throw new TypedDataError(`${path} has fields that are not in type ${primaryType}: ${extra.join(', ')}`);
  }
  return keccak256(concatBytes(...parts));
}

/** EIP-712 `hashStruct`. */
export const hashStruct = (primaryType: string, data: Record<string, unknown>, types: TypedDataTypes): Hex =>
  bytesToHex(hashStructBytes(primaryType, data, types, primaryType));

export const hashDomain = (domain: TypedDataDomain): Hex =>
  hashStruct('EIP712Domain', domain as unknown as Record<string, unknown>, { EIP712Domain: EIP712_DOMAIN_FIELDS });

/** keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message)): what the wallet signs and the contract recomputes. */
export function hashTypedData(td: TypedData): Hex {
  const types = { ...td.types, EIP712Domain: td.types['EIP712Domain'] ?? EIP712_DOMAIN_FIELDS };
  return digestOf(
    hashStruct('EIP712Domain', td.domain as unknown as Record<string, unknown>, types),
    hashStruct(td.primaryType, td.message as Record<string, unknown>, types),
  );
}

/** keccak256(0x1901 ‖ domainSeparator ‖ structHash). */
export const digestOf = (domainSeparatorHex: Hex, structHash: Hex): Hex =>
  bytesToHex(keccak256(concatBytes(new Uint8Array([0x19, 0x01]), hexToBytes(domainSeparatorHex), hexToBytes(structHash))));

/**
 * JSON for `eth_signTypedData_v4`. bigints become decimal strings (wallets, viem and Foundry accept them), so uint64
 * and uint256 values above 2^53 survive the trip. Numbers stay numbers.
 */
export const serializeTypedData = (td: TypedData): string =>
  JSON.stringify({ types: td.types, primaryType: td.primaryType, domain: td.domain, message: td.message }, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

// ---------------------------------------------------------------------------
// ValuescanCopyTrading types (field order = the Solidity type strings in CopyTradingConstants)
// ---------------------------------------------------------------------------

export const TERMS_FIELDS: readonly TypedDataField[] = [
  { name: 'delegatedKey', type: 'address' },
  { name: 'keyName', type: 'string' },
  { name: 'marketScope', type: 'uint8' },
  { name: 'sizingMode', type: 'uint8' },
  { name: 'sizingValue', type: 'uint64' },
  { name: 'allocationCap', type: 'uint64' },
  { name: 'maxPositionNotional', type: 'uint64' },
  { name: 'maxLeverage', type: 'uint8' },
  { name: 'tradeStopLossBps', type: 'uint16' },
  { name: 'maxDrawdownBps', type: 'uint16' },
  { name: 'takeProfitBps', type: 'uint32' },
  { name: 'slippageBps', type: 'uint16' },
  { name: 'symbolMode', type: 'uint8' },
  { name: 'symbols', type: 'string[]' },
  { name: 'copyExisting', type: 'bool' },
  { name: 'maxBuilderFeePerps', type: 'uint16' },
  { name: 'maxBuilderFeeSpot', type: 'uint16' },
  { name: 'expiry', type: 'uint40' },
];

/** Field lists of every type, in the exact order of the Solidity type strings. */
export const COPY_TRADING_TYPES = {
  Terms: TERMS_FIELDS,
  Subscribe: [
    { name: 'follower', type: 'address' },
    { name: 'venue', type: 'uint8' },
    { name: 'leader', type: 'address' },
    { name: 'sodexAccountId', type: 'uint64' },
    { name: 'terms', type: 'Terms' },
    { name: 'stopEpoch', type: 'uint64' },
    { name: 'expectedLastId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  UpdateSubscription: [
    { name: 'follower', type: 'address' },
    { name: 'subscriptionId', type: 'uint256' },
    { name: 'expectedVersion', type: 'uint32' },
    { name: 'terms', type: 'Terms' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  PauseSubscription: [
    { name: 'follower', type: 'address' },
    { name: 'subscriptionId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  ResumeSubscription: [
    { name: 'follower', type: 'address' },
    { name: 'subscriptionId', type: 'uint256' },
    { name: 'expectedVersion', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  Unsubscribe: [
    { name: 'follower', type: 'address' },
    { name: 'subscriptionId', type: 'uint256' },
    { name: 'closePositions', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  UnsubscribeAll: [
    { name: 'follower', type: 'address' },
    { name: 'closePositions', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  InvalidateNonces: [
    { name: 'follower', type: 'address' },
    { name: 'word', type: 'uint256' },
    { name: 'mask', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const satisfies Record<string, readonly TypedDataField[]>;

export type CopyTradingPrimaryType = Exclude<keyof typeof COPY_TRADING_TYPES, 'Terms'>;

/** Every signed action, in the order of the interface. */
export const PRIMARY_TYPES: readonly CopyTradingPrimaryType[] = [
  'Subscribe',
  'UpdateSubscription',
  'PauseSubscription',
  'ResumeSubscription',
  'Unsubscribe',
  'UnsubscribeAll',
  'InvalidateNonces',
];

/** The `...WithSig` function that carries each primary type. */
export const WITH_SIG_FUNCTION: Readonly<Record<CopyTradingPrimaryType, string>> = {
  Subscribe: 'subscribeWithSig',
  UpdateSubscription: 'updateSubscriptionWithSig',
  PauseSubscription: 'pauseSubscriptionWithSig',
  ResumeSubscription: 'resumeSubscriptionWithSig',
  Unsubscribe: 'unsubscribeWithSig',
  UnsubscribeAll: 'unsubscribeAllWithSig',
  InvalidateNonces: 'invalidateNoncesWithSig',
};

/** The `types` object of one primary type: EIP712Domain, the primary type and Terms when it is referenced. */
export function typesFor(primaryType: CopyTradingPrimaryType): TypedDataTypes {
  const fields = COPY_TRADING_TYPES[primaryType];
  if (!fields) throw new TypedDataError(`unknown action type ${String(primaryType)}`);
  const types: Record<string, readonly TypedDataField[]> = { EIP712Domain: EIP712_DOMAIN_FIELDS, [primaryType]: fields };
  if (primaryType === 'Subscribe' || primaryType === 'UpdateSubscription') types['Terms'] = TERMS_FIELDS;
  return types;
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface DomainInput {
  /** The PROXY address (never the implementation): it is the contract everyone uses and it never changes. */
  verifyingContract: Address;
  /** Default: ValueChain mainnet, 286623. */
  chainId?: number;
}

export function copyTradingDomain(d: DomainInput): TypedDataDomain {
  const chainId = d.chainId ?? VALUECHAIN_CHAIN_ID;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TypedDataError('chainId must be a positive integer');
  return {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId,
    verifyingContract: assertAddress(d.verifyingContract, 'verifyingContract'),
  };
}

/** `DOMAIN_SEPARATOR()` of a deployment. */
export const domainSeparator = (d: DomainInput): Hex => hashDomain(copyTradingDomain(d));

/**
 * The signing domain as the deployed contract reports it (ERC-5267 `eip712Domain()`, see `results.eip712Domain`).
 * Throws unless the fields are exactly name, version, chainId and verifyingContract (0x0f) with no salt and no
 * extensions. A UI builds its domain from this, not from constants, so a deliberate domain bump in an upgrade (spec
 * §10.4) is noticed instead of producing signatures the contract rejects.
 */
export function domainFromEip712Domain(info: Eip712DomainInfo): TypedDataDomain {
  if (info.fields.toLowerCase() !== '0x0f') throw new TypedDataError(`unexpected ERC-5267 fields ${info.fields}`);
  if (BigInt(info.salt) !== 0n || info.extensions.length !== 0) throw new TypedDataError('unexpected salt or extensions');
  if (info.chainId <= 0n || info.chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypedDataError('bad chainId');
  return {
    name: info.name,
    version: info.version,
    chainId: Number(info.chainId),
    verifyingContract: assertAddress(info.verifyingContract, 'verifyingContract'),
  };
}

/** Whether the on-chain domain is the one this package signs for (name "ValuescanCopyTrading", version "1"). */
export function isExpectedDomain(info: Eip712DomainInfo, expected: DomainInput): boolean {
  const want = copyTradingDomain(expected);
  let got: TypedDataDomain;
  try {
    got = domainFromEip712Domain(info);
  } catch {
    return false;
  }
  return (
    got.name === want.name &&
    got.version === want.version &&
    got.chainId === want.chainId &&
    sameAddress(got.verifyingContract, want.verifyingContract)
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** EIP-712 `Terms` message (same keys as `Terms`, a fresh symbol array, numeric enums). */
export interface TermsMessage {
  delegatedKey: Address;
  keyName: string;
  marketScope: number;
  sizingMode: number;
  sizingValue: bigint;
  allocationCap: bigint;
  maxPositionNotional: bigint;
  maxLeverage: number;
  tradeStopLossBps: number;
  maxDrawdownBps: number;
  takeProfitBps: number;
  slippageBps: number;
  symbolMode: number;
  symbols: string[];
  copyExisting: boolean;
  maxBuilderFeePerps: number;
  maxBuilderFeeSpot: number;
  expiry: number;
}

const wrap = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof TypedDataError) throw e;
    throw new TypedDataError((e as Error).message);
  }
};

/** Copy `terms` into its EIP-712 message form, range-checking every field against its Solidity type. */
export function termsMessage(t: Terms): TermsMessage {
  if (t === null || typeof t !== 'object') throw new TypedDataError('terms must be an object');
  const n = (v: unknown, bits: number, what: string) => wrap(() => Number(toUint(v, bits, `terms.${what}`)));
  const b = (v: unknown, bits: number, what: string) => wrap(() => toUint(v, bits, `terms.${what}`));
  if (typeof t.copyExisting !== 'boolean') throw new TypedDataError('terms.copyExisting must be a boolean');
  if (typeof t.keyName !== 'string') throw new TypedDataError('terms.keyName must be a string');
  if (!Array.isArray(t.symbols) || t.symbols.some((s) => typeof s !== 'string')) {
    throw new TypedDataError('terms.symbols must be an array of strings');
  }
  return {
    delegatedKey: wrap(() => assertAddress(t.delegatedKey, 'terms.delegatedKey')),
    keyName: t.keyName,
    marketScope: n(t.marketScope, 8, 'marketScope'),
    sizingMode: n(t.sizingMode, 8, 'sizingMode'),
    sizingValue: b(t.sizingValue, 64, 'sizingValue'),
    allocationCap: b(t.allocationCap, 64, 'allocationCap'),
    maxPositionNotional: b(t.maxPositionNotional, 64, 'maxPositionNotional'),
    maxLeverage: n(t.maxLeverage, 8, 'maxLeverage'),
    tradeStopLossBps: n(t.tradeStopLossBps, 16, 'tradeStopLossBps'),
    maxDrawdownBps: n(t.maxDrawdownBps, 16, 'maxDrawdownBps'),
    takeProfitBps: n(t.takeProfitBps, 32, 'takeProfitBps'),
    slippageBps: n(t.slippageBps, 16, 'slippageBps'),
    symbolMode: n(t.symbolMode, 8, 'symbolMode'),
    symbols: [...t.symbols],
    copyExisting: t.copyExisting,
    maxBuilderFeePerps: n(t.maxBuilderFeePerps, 16, 'maxBuilderFeePerps'),
    maxBuilderFeeSpot: n(t.maxBuilderFeeSpot, 16, 'maxBuilderFeeSpot'),
    expiry: n(t.expiry, 40, 'expiry'),
  };
}

/** Inputs of each signed action, in the field order of its EIP-712 type. */
export interface SubscribeInput {
  follower: Address;
  venue: number;
  leader: Address;
  sodexAccountId: bigint;
  terms: Terms;
  /** The follower's CURRENT stop epoch (`stopEpochOf(follower)`); a kill switch voids signatures for older epochs. */
  stopEpoch: bigint;
  /**
   * The key's CURRENT last subscription id, `lastSubscriptionFor(follower, sodexAccountId, venue, leader)` (0n for
   * none). Any subscription created for the key after signing voids the signature, and a later stop never revives it
   * (audit SEC-04). Never sign a Subscribe while that subscription is still live: it would become valid when it stops.
   */
  expectedLastId: bigint;
  nonce: bigint;
  deadline: bigint;
}
export interface UpdateSubscriptionInput {
  follower: Address;
  subscriptionId: bigint;
  /** The subscription's current `version`; a signature for any other version reverts with VersionMismatch. */
  expectedVersion: number;
  terms: Terms;
  nonce: bigint;
  deadline: bigint;
}
export interface PauseSubscriptionInput {
  follower: Address;
  subscriptionId: bigint;
  nonce: bigint;
  deadline: bigint;
}
export interface ResumeSubscriptionInput {
  follower: Address;
  subscriptionId: bigint;
  expectedVersion: number;
  nonce: bigint;
  deadline: bigint;
}
export interface UnsubscribeInput {
  follower: Address;
  subscriptionId: bigint;
  closePositions: boolean;
  nonce: bigint;
  deadline: bigint;
}
export interface UnsubscribeAllInput {
  follower: Address;
  closePositions: boolean;
  nonce: bigint;
  deadline: bigint;
}
export interface InvalidateNoncesInput {
  follower: Address;
  /** Bitmap word index (`nonce >> 8`). */
  word: bigint;
  /** Bits to mark used in that word. The signature's own nonce is consumed first and may lie inside the mask. */
  mask: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface ActionInputs {
  Subscribe: SubscribeInput;
  UpdateSubscription: UpdateSubscriptionInput;
  PauseSubscription: PauseSubscriptionInput;
  ResumeSubscription: ResumeSubscriptionInput;
  Unsubscribe: UnsubscribeInput;
  UnsubscribeAll: UnsubscribeAllInput;
  InvalidateNonces: InvalidateNoncesInput;
}

/** A signed-action description: the primary type plus its inputs. The unit the UI hands to the relayer. */
export type CopyTradingAction = {
  [P in CopyTradingPrimaryType]: { type: P } & ActionInputs[P];
}[CopyTradingPrimaryType];

const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== 'boolean') throw new TypedDataError(`${what} must be a boolean`);
  return v;
};
const u = (v: unknown, bits: number, what: string): bigint => wrap(() => toUint(v, bits, what));
const addr = (v: unknown, what: string): Address => wrap(() => assertAddress(v, what));

/** The EIP-712 message of an action, normalised and range-checked. */
export function actionMessage(action: CopyTradingAction): Record<string, unknown> {
  if (action === null || typeof action !== 'object') throw new TypedDataError('action must be an object');
  const common = () => ({ nonce: u(action.nonce, 256, 'nonce'), deadline: u(action.deadline, 256, 'deadline') });
  switch (action.type) {
    case 'Subscribe':
      return {
        follower: addr(action.follower, 'follower'),
        venue: Number(u(action.venue, 8, 'venue')),
        leader: addr(action.leader, 'leader'),
        sodexAccountId: u(action.sodexAccountId, 64, 'sodexAccountId'),
        terms: termsMessage(action.terms),
        stopEpoch: u(action.stopEpoch, 64, 'stopEpoch'),
        expectedLastId: u(action.expectedLastId, 256, 'expectedLastId'),
        ...common(),
      };
    case 'UpdateSubscription':
      return {
        follower: addr(action.follower, 'follower'),
        subscriptionId: u(action.subscriptionId, 256, 'subscriptionId'),
        expectedVersion: Number(u(action.expectedVersion, 32, 'expectedVersion')),
        terms: termsMessage(action.terms),
        ...common(),
      };
    case 'PauseSubscription':
      return {
        follower: addr(action.follower, 'follower'),
        subscriptionId: u(action.subscriptionId, 256, 'subscriptionId'),
        ...common(),
      };
    case 'ResumeSubscription':
      return {
        follower: addr(action.follower, 'follower'),
        subscriptionId: u(action.subscriptionId, 256, 'subscriptionId'),
        expectedVersion: Number(u(action.expectedVersion, 32, 'expectedVersion')),
        ...common(),
      };
    case 'Unsubscribe':
      return {
        follower: addr(action.follower, 'follower'),
        subscriptionId: u(action.subscriptionId, 256, 'subscriptionId'),
        closePositions: bool(action.closePositions, 'closePositions'),
        ...common(),
      };
    case 'UnsubscribeAll':
      return {
        follower: addr(action.follower, 'follower'),
        closePositions: bool(action.closePositions, 'closePositions'),
        ...common(),
      };
    case 'InvalidateNonces':
      return {
        follower: addr(action.follower, 'follower'),
        word: u(action.word, 256, 'word'),
        mask: u(action.mask, 256, 'mask'),
        ...common(),
      };
    default: {
      const t: never = action;
      throw new TypedDataError(`unknown action type ${(t as { type: string }).type}`);
    }
  }
}

/** Who must sign an action: always the follower (an EOA key, an EIP-7702 account's key, or an ERC-1271 wallet). */
export const actionSigner = (action: CopyTradingAction): Address => action.follower;

export interface PreparedSignature<P extends CopyTradingPrimaryType = CopyTradingPrimaryType> {
  /** Hand `serializeTypedData(typedData)` to `eth_signTypedData_v4`; viem's signTypedData takes it as is. */
  typedData: TypedData<P>;
  /** EIP-712 digest: the contract recomputes exactly this from the call's arguments. */
  digest: Hex;
  /** hashStruct of the message. */
  structHash: Hex;
  /** Address that must sign (the follower). */
  signer: Address;
}

/** Typed data, digest and expected signer of any action. */
export function prepareAction<A extends CopyTradingAction>(domain: DomainInput, action: A): PreparedSignature<A['type']> {
  const message = actionMessage(action);
  const types = typesFor(action.type);
  const typedData: TypedData<A['type']> = { types, primaryType: action.type, domain: copyTradingDomain(domain), message };
  return {
    typedData,
    digest: hashTypedData(typedData),
    structHash: hashStruct(action.type, message, types),
    signer: actionSigner(action),
  };
}

export const prepareSubscribe = (d: DomainInput, m: SubscribeInput) => prepareAction(d, { type: 'Subscribe', ...m });
export const prepareUpdateSubscription = (d: DomainInput, m: UpdateSubscriptionInput) =>
  prepareAction(d, { type: 'UpdateSubscription', ...m });
export const preparePauseSubscription = (d: DomainInput, m: PauseSubscriptionInput) =>
  prepareAction(d, { type: 'PauseSubscription', ...m });
export const prepareResumeSubscription = (d: DomainInput, m: ResumeSubscriptionInput) =>
  prepareAction(d, { type: 'ResumeSubscription', ...m });
export const prepareUnsubscribe = (d: DomainInput, m: UnsubscribeInput) => prepareAction(d, { type: 'Unsubscribe', ...m });
export const prepareUnsubscribeAll = (d: DomainInput, m: UnsubscribeAllInput) =>
  prepareAction(d, { type: 'UnsubscribeAll', ...m });
export const prepareInvalidateNonces = (d: DomainInput, m: InvalidateNoncesInput) =>
  prepareAction(d, { type: 'InvalidateNonces', ...m });

/** hashStruct(Terms) alone (what the contract embeds in Subscribe and UpdateSubscription). */
export const hashTerms = (terms: Terms): Hex =>
  hashStruct('Terms', termsMessage(terms) as unknown as Record<string, unknown>, { Terms: TERMS_FIELDS });

/**
 * The symbol-list commitment: keccak256 of the concatenated keccak256 of each UTF-8 symbol (the EIP-712 encoding of
 * `string[]`); keccak256("") for an empty list. Equals the stored `Subscription.symbolsHash` and the `symbols` word
 * of the signed Terms, so anyone can check an event's list against the record.
 */
export function symbolsHash(symbols: readonly string[]): Hex {
  if (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string')) {
    throw new TypedDataError('symbols must be an array of strings');
  }
  return bytesToHex(keccak256(concatBytes(...symbols.map((s) => keccak256(utf8(s))))));
}

/** keccak256 of one symbol's UTF-8 bytes (the `symbolHash` field of execution leaves, spec §7.2). */
export const symbolHash = (symbol: string): Hex => bytesToHex(keccak256(utf8(symbol)));
