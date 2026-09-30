/**
 * Shared test helpers: paths, the committed vectors, a seeded PRNG, JSON normalisation, a generic ABI value sampler
 * (for fuzzing every function, event and error of the ABI against viem), typed-data revival, and valid fixtures.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AbiParameter,
  type Address,
  type CopyTradingEvent,
  type Hex,
  MarketScope,
  SizingMode,
  SymbolMode,
  type Terms,
  bytesToHex,
  decodeCopyTradingLog,
  encodeEventLog,
  ABI,
  toChecksumAddress,
} from '../src/index.ts';

export const testDir = dirname(fileURLToPath(import.meta.url));
export const packageDir = join(testDir, '..');
export const srcDir = join(packageDir, 'src');
export const repoDir = join(packageDir, '..', '..');
export const contractsDir = join(repoDir, 'contracts');
export const interfacePath = join(contractsDir, 'src', 'interfaces', 'IValuescanCopyTrading.sol');
export const implementationPath = join(contractsDir, 'src', 'ValuescanCopyTrading.sol');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** The committed test/vectors.json (bigints as decimal strings). */
export const vectors: Json = JSON.parse(readFileSync(join(testDir, 'vectors.json'), 'utf8'));

/** JSON round trip with bigints as decimal strings, so decoded values compare with JSON fixtures. */
export const norm = (v: unknown): Json =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  bool(): boolean;
  bytes(n: number): Uint8Array;
  pick<T>(xs: readonly T[]): T;
  uint(bits: number): bigint;
}

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (m: number): number => Math.floor(next() * m);
  const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(256));
  return {
    next,
    int,
    bool: () => next() < 0.5,
    bytes,
    pick: <T>(xs: readonly T[]): T => xs[int(xs.length)]!,
    uint: (bits: number): bigint => {
      // Mix edge values in: 0, 1, max, and random widths.
      const r = next();
      const max = (1n << BigInt(bits)) - 1n;
      if (r < 0.1) return 0n;
      if (r < 0.2) return max;
      if (r < 0.3) return 1n;
      let v = 0n;
      for (const b of bytes(Math.ceil(bits / 8))) v = (v << 8n) | BigInt(b);
      return v & (max >> BigInt(int(bits)));
    },
  };
}

const UNICODE_POOL = ['a', 'Z', '0', '-', '_', ' ', 'ü', 'é', '✓', '中', '🚀', '"', '\\', '\n', '\u0000', ' '];

export const randomString = (r: Rng, maxLen = 12): string =>
  Array.from({ length: r.int(maxLen + 1) }, () => r.pick(UNICODE_POOL)).join('');

export const randomAddress = (r: Rng): Address => toChecksumAddress(bytesToHex(r.bytes(20)));

/**
 * A random value for an ABI parameter, in the input form both this package and viem accept: numbers for uint/int of
 * 48 bits or fewer and bigints above, checksum addresses, lower-case hex for bytes, objects for named tuples.
 */
export function sampleAbiValue(p: AbiParameter, r: Rng, depth = 0): unknown {
  const arr = /^(.*)\[(\d*)\]$/.exec(p.type);
  if (arr) {
    const len = arr[2] === '' ? r.int(depth > 1 ? 2 : 4) : Number(arr[2]);
    const elem: AbiParameter = { ...p, type: arr[1]! };
    return Array.from({ length: len }, () => sampleAbiValue(elem, r, depth + 1));
  }
  if (p.type === 'tuple') {
    const o: Record<string, unknown> = {};
    for (const c of p.components ?? []) o[c.name!] = sampleAbiValue(c, r, depth + 1);
    return o;
  }
  if (p.type === 'address') return randomAddress(r);
  if (p.type === 'bool') return r.bool();
  if (p.type === 'string') return randomString(r);
  if (p.type === 'bytes') return bytesToHex(r.bytes(r.int(70)));
  const fb = /^bytes(\d+)$/.exec(p.type);
  if (fb) return bytesToHex(r.bytes(Number(fb[1])));
  const u = /^uint(\d*)$/.exec(p.type);
  if (u) {
    const bits = u[1] === '' ? 256 : Number(u[1]);
    const v = r.uint(bits);
    return bits <= 48 ? Number(v) : v;
  }
  throw new Error(`sampleAbiValue: unsupported ${p.type}`);
}

// ---------------------------------------------------------------------------
// Typed data from JSON (decimal strings back to bigints where the type is an integer)
// ---------------------------------------------------------------------------

export function reviveTypedData(td: Json): Json {
  const types = td.types as Record<string, Array<{ name: string; type: string }>>;
  const revive = (type: string, v: unknown): unknown => {
    const arr = /^(.*)\[\d*\]$/.exec(type);
    if (arr) return (v as unknown[]).map((x) => revive(arr[1]!, x));
    if (types[type]) {
      const o: Record<string, unknown> = {};
      for (const f of types[type]!) o[f.name] = revive(f.type, (v as Record<string, unknown>)[f.name]);
      return o;
    }
    if (/^u?int\d*$/.test(type) && typeof v === 'string') return BigInt(v);
    return v;
  };
  return { ...td, domain: { ...td.domain }, message: revive(td.primaryType, td.message) };
}

/** Revive decimal strings of known bigint keys in a JSON value from vectors.json (for the package's own types). */
export function reviveBigints<T = Json>(v: Json, bigKeys: ReadonlySet<string>): T {
  const walk = (x: Json, key?: string): Json => {
    if (Array.isArray(x)) return x.map((e) => walk(e, key));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, e]) => [k, walk(e, k)]));
    if (typeof x === 'string' && key && bigKeys.has(key) && /^\d+$/.test(x)) return BigInt(x);
    return x;
  };
  return walk(v) as T;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const NOW = 1_790_000_000;
export const PROXY: Address = '0x00000000000000000000000000000000c0ffee01';
export const FOLLOWER: Address = '0x3333333333333333333333333333333333333333';
export const LEADER: Address = '0x4444444444444444444444444444444444444444';
export const KEY: Address = '0x2222222222222222222222222222222222222222';

/** Terms that pass every check at NOW for FOLLOWER (the spec §6.8 vector terms). */
export const validTerms = (over: Partial<Terms> = {}): Terms => ({
  delegatedKey: KEY,
  keyName: 'vs-000001',
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
  symbols: ['BTC-USD', 'ETH-USD'],
  copyExisting: false,
  maxBuilderFeePerps: 50,
  maxBuilderFeeSpot: 0,
  expiry: 1_806_000_000,
  ...over,
});

export const asHex = (s: string): Hex => s as Hex;

/**
 * A decoded event at (block, logIndex) with a timestamp, built through the real encoder and decoder, so tests feed the
 * index exactly what an RPC log would give it.
 */
export function mkEvent(
  eventName: string,
  args: Record<string, unknown>,
  pos: { block: bigint | number; logIndex?: number; timestamp?: number },
  address: Address = PROXY,
): CopyTradingEvent {
  const { topics, data } = encodeEventLog(ABI, eventName, args);
  const log: Parameters<typeof decodeCopyTradingLog>[0] = {
    address,
    topics,
    data,
    blockNumber: BigInt(pos.block),
    logIndex: pos.logIndex ?? 0,
  };
  if (pos.timestamp !== undefined) log.blockTimestamp = pos.timestamp;
  const ev = decodeCopyTradingLog(log);
  if (!ev) throw new Error(`cannot decode ${eventName}`);
  return ev;
}
