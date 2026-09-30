/**
 * A small, strict Solidity ABI codec: enough for this contract's ABI (elementary types, bytes, string, dynamic and
 * fixed arrays, nested tuples), plus function selectors, event topics, logs and custom errors.
 *
 * Conventions match viem, so results can be compared one to one (test/abiCodec.test.ts does exactly that):
 *   - uint/int of 48 bits or fewer decode to `number`, wider ones to `bigint`;
 *   - addresses decode to EIP-55 checksum form, bytes/bytesN to lower-case hex;
 *   - tuples with named components decode to objects (keys in component order), otherwise to arrays;
 *   - a function with one output decodes to that value, with several to an array.
 *
 * Decoding is STRICT, like Solidity's own ABI decoder: dirty high bits in an address, a bool that is not 0/1, a
 * uintN above 2^N, non-zero padding after bytesN, out-of-range offsets and truncated data all throw.
 */
import {
  type Hex,
  MAX_UINT256,
  assertAddress,
  bytesToBigInt,
  bytesToHex,
  concatBytes,
  fromUtf8,
  hexToBytes,
  isHex,
  keccak256,
  toChecksumAddress,
  toUint,
  uintToWord,
  utf8,
} from './bytes.ts';

// ---------------------------------------------------------------------------
// ABI JSON shapes
// ---------------------------------------------------------------------------

export interface AbiParameter {
  readonly name?: string;
  readonly type: string;
  readonly internalType?: string;
  readonly components?: readonly AbiParameter[];
  readonly indexed?: boolean;
}

export interface AbiFunctionItem {
  readonly type: 'function';
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
  readonly outputs: readonly AbiParameter[];
  readonly stateMutability: string;
}

export interface AbiEventItem {
  readonly type: 'event';
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
  readonly anonymous?: boolean;
}

export interface AbiErrorItem {
  readonly type: 'error';
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
}

export interface AbiOtherItem {
  readonly type: 'constructor' | 'fallback' | 'receive';
  readonly inputs?: readonly AbiParameter[];
  readonly stateMutability?: string;
}

export type AbiItem = AbiFunctionItem | AbiEventItem | AbiErrorItem | AbiOtherItem;
export type Abi = readonly AbiItem[];

export class AbiError extends Error {
  override name = 'AbiError';
}

// ---------------------------------------------------------------------------
// Type descriptors
// ---------------------------------------------------------------------------

type Desc =
  | { kind: 'uint'; bits: number }
  | { kind: 'int'; bits: number }
  | { kind: 'address' }
  | { kind: 'bool' }
  | { kind: 'fixedBytes'; size: number }
  | { kind: 'bytes' }
  | { kind: 'string' }
  | { kind: 'array'; elem: Desc; length: number | null }
  | { kind: 'tuple'; components: ReadonlyArray<{ name: string | undefined; desc: Desc }> };

const descCache = new WeakMap<AbiParameter, Desc>();

function parseDesc(p: AbiParameter): Desc {
  const cached = descCache.get(p);
  if (cached) return cached;
  const d = parseType(p.type, p.components);
  descCache.set(p, d);
  return d;
}

function parseType(type: string, components: readonly AbiParameter[] | undefined): Desc {
  const arr = /^(.*)\[(\d*)\]$/.exec(type);
  if (arr) {
    const length = arr[2] === '' ? null : Number(arr[2]);
    if (length !== null && (!Number.isSafeInteger(length) || length < 1)) throw new AbiError(`bad array length in ${type}`);
    return { kind: 'array', elem: parseType(arr[1]!, components), length };
  }
  if (type === 'tuple') {
    if (!components) throw new AbiError('tuple without components');
    return { kind: 'tuple', components: components.map((c) => ({ name: c.name || undefined, desc: parseDesc(c) })) };
  }
  if (type === 'address') return { kind: 'address' };
  if (type === 'bool') return { kind: 'bool' };
  if (type === 'string') return { kind: 'string' };
  if (type === 'bytes') return { kind: 'bytes' };
  const int = /^(u?)int(\d*)$/.exec(type);
  if (int) {
    const bits = int[2] === '' ? 256 : Number(int[2]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) throw new AbiError(`bad integer type ${type}`);
    return { kind: int[1] ? 'uint' : 'int', bits };
  }
  const fb = /^bytes(\d+)$/.exec(type);
  if (fb) {
    const size = Number(fb[1]);
    if (size < 1 || size > 32) throw new AbiError(`bad fixed bytes type ${type}`);
    return { kind: 'fixedBytes', size };
  }
  throw new AbiError(`unsupported ABI type ${type}`);
}

function isDynamic(d: Desc): boolean {
  switch (d.kind) {
    case 'bytes':
    case 'string':
      return true;
    case 'array':
      return d.length === null || isDynamic(d.elem);
    case 'tuple':
      return d.components.some((c) => isDynamic(c.desc));
    default:
      return false;
  }
}

/** Size of a value's head: 32 for dynamic values, the full encoding for static ones. */
function headSize(d: Desc): number {
  if (isDynamic(d)) return 32;
  if (d.kind === 'array') return d.length! * headSize(d.elem);
  if (d.kind === 'tuple') return d.components.reduce((n, c) => n + headSize(c.desc), 0);
  return 32;
}

/** Canonical type for signatures: tuples expanded to `(t1,t2,...)`, keeping array suffixes. */
export function canonicalType(p: AbiParameter): string {
  if (p.type.startsWith('tuple')) {
    if (!p.components) throw new AbiError('tuple without components');
    return `(${p.components.map(canonicalType).join(',')})${p.type.slice('tuple'.length)}`;
  }
  const int = /^(u?int)(\[.*)?$/.exec(p.type);
  if (int) return `${int[1]}256${int[2] ?? ''}`; // bare uint/int -> uint256/int256
  return p.type;
}

/** `name(type1,type2,...)`. */
export const signatureOf = (item: { readonly name: string; readonly inputs: readonly AbiParameter[] }): string =>
  `${item.name}(${item.inputs.map(canonicalType).join(',')})`;

/** 4-byte selector of a function or error. */
export const selectorOf = (item: { readonly name: string; readonly inputs: readonly AbiParameter[] }): Hex =>
  bytesToHex(keccak256(utf8(signatureOf(item))).slice(0, 4));

/** topic0 of an event. */
export const eventTopicOf = (item: { readonly name: string; readonly inputs: readonly AbiParameter[] }): Hex =>
  bytesToHex(keccak256(utf8(signatureOf(item))));

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const padRight32 = (b: Uint8Array): Uint8Array => {
  const len = Math.ceil(b.length / 32) * 32;
  if (len === b.length) return b;
  const out = new Uint8Array(len);
  out.set(b);
  return out;
};

function toBytesInput(v: unknown, path: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string' && isHex(v)) return hexToBytes(v);
  throw new AbiError(`${path}: expected 0x hex bytes`);
}

function encodeValue(d: Desc, v: unknown, path: string): Uint8Array {
  switch (d.kind) {
    case 'uint':
      try {
        return uintToWord(toUint(v, d.bits, path));
      } catch (e) {
        throw new AbiError((e as Error).message);
      }
    case 'int': {
      let x: bigint;
      if (typeof v === 'bigint') x = v;
      else if (typeof v === 'number' && Number.isSafeInteger(v)) x = BigInt(v);
      else throw new AbiError(`${path}: expected an integer`);
      const lim = 1n << BigInt(d.bits - 1);
      if (x < -lim || x >= lim) throw new AbiError(`${path}: does not fit int${d.bits}`);
      return uintToWord(x < 0n ? x + MAX_UINT256 + 1n : x);
    }
    case 'address': {
      let a: string;
      try {
        a = assertAddress(v, path);
      } catch (e) {
        throw new AbiError((e as Error).message);
      }
      const out = new Uint8Array(32);
      out.set(hexToBytes(a), 12);
      return out;
    }
    case 'bool':
      if (typeof v !== 'boolean') throw new AbiError(`${path}: expected a boolean`);
      return uintToWord(v ? 1n : 0n);
    case 'fixedBytes': {
      const b = toBytesInput(v, path);
      if (b.length !== d.size) throw new AbiError(`${path}: expected exactly ${d.size} bytes, got ${b.length}`);
      const out = new Uint8Array(32);
      out.set(b);
      return out;
    }
    case 'bytes': {
      const b = toBytesInput(v, path);
      return concatBytes(uintToWord(BigInt(b.length)), padRight32(b));
    }
    case 'string': {
      if (typeof v !== 'string') throw new AbiError(`${path}: expected a string`);
      const b = utf8(v);
      return concatBytes(uintToWord(BigInt(b.length)), padRight32(b));
    }
    case 'array': {
      if (!Array.isArray(v)) throw new AbiError(`${path}: expected an array`);
      if (d.length !== null && v.length !== d.length) {
        throw new AbiError(`${path}: expected ${d.length} elements, got ${v.length}`);
      }
      const body = encodeSequence(
        v.map(() => d.elem),
        v,
        v.map((_, i) => `${path}[${i}]`),
      );
      return d.length === null ? concatBytes(uintToWord(BigInt(v.length)), body) : body;
    }
    case 'tuple': {
      let values: unknown[];
      if (Array.isArray(v)) {
        if (v.length !== d.components.length) throw new AbiError(`${path}: expected ${d.components.length} fields`);
        values = v;
      } else if (v !== null && typeof v === 'object') {
        values = d.components.map((c, i) => {
          if (c.name === undefined) throw new AbiError(`${path}: tuple component ${i} has no name; pass an array`);
          if (!(c.name in (v as Record<string, unknown>))) throw new AbiError(`${path}.${c.name} is missing`);
          return (v as Record<string, unknown>)[c.name];
        });
      } else {
        throw new AbiError(`${path}: expected a tuple (object or array)`);
      }
      return encodeSequence(
        d.components.map((c) => c.desc),
        values,
        d.components.map((c, i) => `${path}.${c.name ?? i}`),
      );
    }
  }
}

function encodeSequence(descs: readonly Desc[], values: readonly unknown[], paths: readonly string[]): Uint8Array {
  const encoded = descs.map((d, i) => encodeValue(d, values[i], paths[i]!));
  let tailOffset = descs.reduce((n, d) => n + headSize(d), 0);
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  descs.forEach((d, i) => {
    const e = encoded[i]!;
    if (isDynamic(d)) {
      heads.push(uintToWord(BigInt(tailOffset)));
      tails.push(e);
      tailOffset += e.length;
    } else {
      heads.push(e);
    }
  });
  return concatBytes(...heads, ...tails);
}

/** `abi.encode(values...)` for the given parameter list. */
export function encodeAbiParameters(params: readonly AbiParameter[], values: readonly unknown[]): Hex {
  if (values.length !== params.length) {
    throw new AbiError(`expected ${params.length} values, got ${values.length}`);
  }
  return bytesToHex(
    encodeSequence(
      params.map(parseDesc),
      values,
      params.map((p, i) => p.name || `arg${i}`),
    ),
  );
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function word(data: Uint8Array, pos: number): Uint8Array {
  if (!Number.isSafeInteger(pos) || pos < 0 || pos + 32 > data.length) {
    throw new AbiError(`ABI data too short: need 32 bytes at offset ${pos}, have ${data.length}`);
  }
  return data.subarray(pos, pos + 32);
}

/** An offset or length word; must be a sane in-memory number. */
function smallUint(data: Uint8Array, pos: number): number {
  const v = bytesToBigInt(word(data, pos));
  if (v > BigInt(data.length)) throw new AbiError(`offset/length ${v} at ${pos} exceeds the data (${data.length} bytes)`);
  return Number(v);
}

function decodeValue(d: Desc, data: Uint8Array, pos: number): unknown {
  switch (d.kind) {
    case 'uint': {
      const v = bytesToBigInt(word(data, pos));
      if (v >> BigInt(d.bits) !== 0n) throw new AbiError(`uint${d.bits} at ${pos} has dirty high bits`);
      return d.bits <= 48 ? Number(v) : v;
    }
    case 'int': {
      let v = bytesToBigInt(word(data, pos));
      if (v >> 255n === 1n) v -= MAX_UINT256 + 1n;
      const lim = 1n << BigInt(d.bits - 1);
      if (v < -lim || v >= lim) throw new AbiError(`int${d.bits} at ${pos} is not sign-extended`);
      return d.bits <= 48 ? Number(v) : v;
    }
    case 'address': {
      const w = word(data, pos);
      for (let i = 0; i < 12; i++) if (w[i] !== 0) throw new AbiError(`address at ${pos} has dirty high bytes`);
      return toChecksumAddress(bytesToHex(w.subarray(12)));
    }
    case 'bool': {
      const v = bytesToBigInt(word(data, pos));
      if (v > 1n) throw new AbiError(`bool at ${pos} is neither 0 nor 1`);
      return v === 1n;
    }
    case 'fixedBytes': {
      const w = word(data, pos);
      for (let i = d.size; i < 32; i++) if (w[i] !== 0) throw new AbiError(`bytes${d.size} at ${pos} has dirty padding`);
      return bytesToHex(w.subarray(0, d.size));
    }
    case 'bytes':
    case 'string': {
      const len = smallUint(data, pos);
      if (pos + 32 + len > data.length) throw new AbiError(`${d.kind} at ${pos} runs past the end of the data`);
      const b = data.subarray(pos + 32, pos + 32 + len);
      return d.kind === 'bytes' ? bytesToHex(b) : fromUtf8(b);
    }
    case 'array': {
      if (d.length === null) {
        const len = smallUint(data, pos);
        // Every element occupies at least one 32-byte head slot; refuse lengths the data cannot hold.
        if (len * 32 > data.length - pos - 32) throw new AbiError(`array length ${len} at ${pos} exceeds the data`);
        return decodeSequence(
          new Array<Desc>(len).fill(d.elem),
          data,
          pos + 32,
        );
      }
      return decodeSequence(new Array<Desc>(d.length).fill(d.elem), data, pos);
    }
    case 'tuple': {
      const values = decodeSequence(
        d.components.map((c) => c.desc),
        data,
        pos,
      );
      if (d.components.every((c) => c.name !== undefined)) {
        const o: Record<string, unknown> = {};
        d.components.forEach((c, i) => (o[c.name!] = values[i]));
        return o;
      }
      return values;
    }
  }
}

function decodeSequence(descs: readonly Desc[], data: Uint8Array, base: number): unknown[] {
  const out: unknown[] = [];
  let cursor = base;
  for (const d of descs) {
    if (isDynamic(d)) {
      const off = smallUint(data, cursor);
      out.push(decodeValue(d, data, base + off));
      cursor += 32;
    } else {
      out.push(decodeValue(d, data, cursor));
      cursor += headSize(d);
    }
  }
  return out;
}

const asBytes = (data: Hex | Uint8Array): Uint8Array => (data instanceof Uint8Array ? data : hexToBytes(data));

/** `abi.decode(data, (types...))`. */
export function decodeAbiParameters(params: readonly AbiParameter[], data: Hex | Uint8Array): unknown[] {
  return decodeSequence(params.map(parseDesc), asBytes(data), 0);
}

// ---------------------------------------------------------------------------
// ABI item lookup
// ---------------------------------------------------------------------------

type Named = AbiFunctionItem | AbiEventItem | AbiErrorItem;

interface AbiIndex {
  byName: Map<string, Named[]>;
  bySelector: Map<string, AbiFunctionItem | AbiErrorItem>;
  byTopic: Map<string, AbiEventItem>;
}

const indexCache = new WeakMap<Abi, AbiIndex>();

function indexOf(abi: Abi): AbiIndex {
  const hit = indexCache.get(abi);
  if (hit) return hit;
  const idx: AbiIndex = { byName: new Map(), bySelector: new Map(), byTopic: new Map() };
  for (const item of abi) {
    if (item.type !== 'function' && item.type !== 'event' && item.type !== 'error') continue;
    const key = `${item.type}:${item.name}`;
    const list = idx.byName.get(key) ?? [];
    list.push(item);
    idx.byName.set(key, list);
    if (item.type === 'event') {
      if (!item.anonymous) idx.byTopic.set(eventTopicOf(item), item);
    } else {
      idx.bySelector.set(`${item.type}:${selectorOf(item)}`, item);
    }
  }
  indexCache.set(abi, idx);
  return idx;
}

/** Find a function/event/error by name, or by full signature when the name is overloaded. */
export function getAbiItem<T extends 'function' | 'event' | 'error'>(
  abi: Abi,
  type: T,
  nameOrSignature: string,
): Extract<Named, { type: T }> {
  const idx = indexOf(abi);
  const name = nameOrSignature.includes('(') ? nameOrSignature.slice(0, nameOrSignature.indexOf('(')) : nameOrSignature;
  const list = (idx.byName.get(`${type}:${name}`) ?? []) as Extract<Named, { type: T }>[];
  if (list.length === 0) throw new AbiError(`no ${type} named ${name} in the ABI`);
  if (nameOrSignature.includes('(')) {
    const hit = list.find((i) => signatureOf(i) === nameOrSignature);
    if (!hit) throw new AbiError(`no ${type} with signature ${nameOrSignature}`);
    return hit;
  }
  if (list.length > 1) throw new AbiError(`${type} ${name} is overloaded; pass its full signature`);
  return list[0]!;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function encodeFunctionData(abi: Abi, functionName: string, args: readonly unknown[] = []): Hex {
  const fn = getAbiItem(abi, 'function', functionName);
  return (selectorOf(fn) + encodeAbiParameters(fn.inputs, args).slice(2)) as Hex;
}

export function decodeFunctionData(abi: Abi, data: Hex | Uint8Array): { functionName: string; args: unknown[] } {
  const b = asBytes(data);
  if (b.length < 4) throw new AbiError('calldata shorter than a selector');
  const fn = indexOf(abi).bySelector.get(`function:${bytesToHex(b.subarray(0, 4))}`);
  if (!fn || fn.type !== 'function') throw new AbiError(`unknown function selector ${bytesToHex(b.subarray(0, 4))}`);
  return { functionName: fn.name, args: decodeSequence(fn.inputs.map(parseDesc), b.subarray(4), 0) };
}

/** Return data of a call: the single output's value, or an array for several outputs, or undefined for none. */
export function decodeFunctionResult(abi: Abi, functionName: string, data: Hex | Uint8Array): unknown {
  const fn = getAbiItem(abi, 'function', functionName);
  const values = decodeAbiParameters(fn.outputs, data);
  if (fn.outputs.length === 0) return undefined;
  return fn.outputs.length === 1 ? values[0] : values;
}

/** Encode return data (for mocks and tests). */
export function encodeFunctionResult(abi: Abi, functionName: string, values: readonly unknown[]): Hex {
  const fn = getAbiItem(abi, 'function', functionName);
  return encodeAbiParameters(fn.outputs, values);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface RawLog {
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

/**
 * Decode a log against `abi`. Indexed static values are decoded from their topics; an indexed dynamic value (none
 * in this contract) is returned as its topic hash, as Solidity only stores the hash.
 */
export function decodeEventLog(abi: Abi, log: RawLog): { eventName: string; args: Record<string, unknown> } {
  const topic0 = log.topics[0];
  if (!topic0) throw new AbiError('anonymous logs are not supported');
  const ev = indexOf(abi).byTopic.get(topic0.toLowerCase());
  if (!ev) throw new AbiError(`unknown event topic ${topic0}`);
  const indexed = ev.inputs.filter((i) => i.indexed);
  const plain = ev.inputs.filter((i) => !i.indexed);
  if (log.topics.length !== indexed.length + 1) {
    throw new AbiError(`${ev.name}: expected ${indexed.length + 1} topics, got ${log.topics.length}`);
  }
  const plainValues = decodeAbiParameters(plain, log.data);
  const args: Record<string, unknown> = {};
  let ti = 1;
  let pi = 0;
  for (const input of ev.inputs) {
    const key = input.name || `arg${ti + pi - 1}`;
    if (input.indexed) {
      const d = parseDesc(input);
      const t = hexToBytes(log.topics[ti++]!);
      if (t.length !== 32) throw new AbiError(`${ev.name}: topic is not 32 bytes`);
      args[key] = isDynamic(d) || d.kind === 'tuple' || d.kind === 'array' ? bytesToHex(t) : decodeValue(d, t, 0);
    } else {
      args[key] = plainValues[pi++];
    }
  }
  return { eventName: ev.name, args };
}

/** Encode a log (for mocks and tests). Only static indexed values are supported. */
export function encodeEventLog(abi: Abi, eventName: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const ev = getAbiItem(abi, 'event', eventName);
  const topics: Hex[] = [eventTopicOf(ev)];
  const plain: AbiParameter[] = [];
  const plainValues: unknown[] = [];
  for (const input of ev.inputs) {
    if (!input.name || !(input.name in args)) throw new AbiError(`${eventName}.${input.name} is missing`);
    const v = args[input.name];
    if (input.indexed) {
      const d = parseDesc(input);
      if (isDynamic(d) || d.kind === 'tuple' || d.kind === 'array') throw new AbiError('dynamic indexed values unsupported');
      topics.push(bytesToHex(encodeValue(d, v, input.name)));
    } else {
      plain.push(input);
      plainValues.push(v);
    }
  }
  return { topics, data: encodeAbiParameters(plain, plainValues) };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const BUILTIN_ERRORS: readonly AbiErrorItem[] = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
];

/**
 * Decode revert data into `{errorName, args}` (args as an object keyed by input name). Knows Solidity's built-in
 * `Error(string)` and `Panic(uint256)`. Throws for unknown selectors and empty data (a bare `revert()` or an
 * out-of-gas); callers treat those as "unknown failure".
 */
export function decodeErrorResult(abi: Abi, data: Hex | Uint8Array): { errorName: string; args: Record<string, unknown> } {
  const b = asBytes(data);
  if (b.length < 4) throw new AbiError('revert data has no selector (empty revert or out of gas)');
  const sel = bytesToHex(b.subarray(0, 4));
  const err =
    (indexOf(abi).bySelector.get(`error:${sel}`) as AbiErrorItem | undefined) ??
    BUILTIN_ERRORS.find((e) => selectorOf(e) === sel);
  if (!err) throw new AbiError(`unknown error selector ${sel}`);
  const values = decodeSequence(err.inputs.map(parseDesc), b.subarray(4), 0);
  const args: Record<string, unknown> = {};
  err.inputs.forEach((i, k) => (args[i.name || `arg${k}`] = values[k]));
  return { errorName: err.name, args };
}

/** Encode revert data (for mocks and tests). */
export function encodeErrorResult(abi: Abi, errorName: string, args: readonly unknown[] = []): Hex {
  const err = getAbiItem(abi, 'error', errorName);
  return (selectorOf(err) + encodeAbiParameters(err.inputs, args).slice(2)) as Hex;
}
