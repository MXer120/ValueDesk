/**
 * A stand-in for SoDEX in the builder tier tests: the three reads the verifier
 * makes, answered the way the live gateway and explorer answer them
 * (shapes read on mainnet, 2026-10-02):
 *
 *   GET /api/v1/user/{a}/builders                 { spot: [{userID, builderID, feeRate}], perps: [...] }
 *   GET /api/v1/{engine}/accounts/{a}/api-keys    [{ name, type, publicKey, expiresAt }]
 *   GET /api/v1/{engine}/accounts/{a}/trades      a bare array, newest first; startTime and endTime inclusive
 *   GET {explorer}/api/v1/{engine}/transaction?account_id=&order_id=
 *                                                 { code: 0, data: { tx_hash, ts_ms, order_ids, action, tx_json } }
 *
 * Orders are signed here with real keys (the server's own signing code), so
 * the signer the verifier recovers from an explorer answer is a real recovery.
 * Nothing in this file touches the network or a real data directory.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { privateKeyToAddress, signExchangeAction } from '../src/signing/eip712.js';
import type { Engine, LogLike } from '../src/builder/config.js';
import type { VerifierIo } from '../src/builder/verifier.js';
import { ExplorerError } from '../src/builder/verifier.js';

export const CHAIN = 286623;
export const BUILDER = 123456;
export const OTHER_BUILDER = 223169;

export const addr = (n: number): string => '0x' + n.toString(16).padStart(40, '0');

/** A directory of its own for one test file; removed on exit. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a file still open on Windows: the OS clears its temp directory */
    }
  });
  return dir;
}

export class Clock {
  constructor(public t: number = 1_790_000_000_000) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Collects what was logged, so a test can look for a warning - or for something that must never be logged. */
export class MemoryLog implements LogLike {
  lines: Array<{ level: string; msg: string; o: Record<string, unknown> }> = [];
  info = (o: Record<string, unknown>, msg: string): void => void this.lines.push({ level: 'info', msg, o });
  warn = (o: Record<string, unknown>, msg: string): void => void this.lines.push({ level: 'warn', msg, o });
  error = (o: Record<string, unknown>, msg: string): void => void this.lines.push({ level: 'error', msg, o });
  text(): string {
    return JSON.stringify(this.lines);
  }
}

/** An API key: a secp256k1 key and the address SoDEX lists it under. */
export interface ApiKey {
  name: string;
  secret: Uint8Array;
  address: string;
}

export function apiKey(name: string): ApiKey {
  const secret = secp256k1.utils.randomSecretKey();
  return { name, secret, address: privateKeyToAddress(secret).toLowerCase() };
}

export interface OrderSpec {
  engine: Engine;
  orderId: number;
  symbol?: string;
  clOrdID?: string;
  side?: 'BUY' | 'SELL';
  /** Created (and, unless `fillAt` says otherwise, filled) at this time. */
  at: number;
  /** price x quantity of each fill; default one fill. */
  fills?: Array<{ price: string; quantity: string; at?: number }>;
  /** The builder the order names, if any. */
  builder?: { id: number; fee: number } | null;
  /** The key that signs the order. */
  key: ApiKey;
}

interface Wallet {
  accountId: number;
  approved: Array<{ builderID: number; feeRate: number }>;
  keys: ApiKey[];
  trades: Record<Engine, Array<Record<string, unknown>>>;
}

const SYMBOL_ID: Record<string, number> = { 'BTC-USD': 1, 'ETH-USD': 2, vETH_vUSDC: 2, vSOL_vUSDC: 7, vBTC_vETH: 9 };

/** Exact decimal product of two short decimals (the fixtures use few digits). */
function mul(a: string, b: string, rateTenthsBp = 100_000): string {
  const dec = (s: string) => ({ n: BigInt(s.replace('.', '')), d: (s.split('.')[1] ?? '').length });
  const x = dec(a);
  const y = dec(b);
  const n = x.n * y.n * BigInt(rateTenthsBp);
  const scale = x.d + y.d + 5;
  const s = n.toString().padStart(scale + 1, '0');
  return (s.slice(0, s.length - scale) + '.' + s.slice(s.length - scale)).replace(/\.?0+$/, '') || '0';
}

export class FakeSodex implements VerifierIo {
  wallets = new Map<string, Wallet>();
  /** `${engine}:${accountId}:${orderId}` -> the explorer's answer body. */
  txs = new Map<string, unknown>();
  /** Every request, in order. */
  calls: Array<{ kind: 'builders' | 'keys' | 'trades' | 'explorer'; path: string; at: number }> = [];
  /** Make the next request of a kind fail: a status (429 = rate limit) or 'timeout'. */
  fail: Partial<Record<'builders' | 'keys' | 'trades' | 'explorer', Array<number | 'timeout'>>> = {};
  cooldown = 0;
  weight = 0;
  private tradeSeq = 1_000_000;

  constructor(readonly clock: Clock) {}

  wallet(address: string, accountId: number): Wallet {
    let w = this.wallets.get(address);
    if (!w) {
      w = { accountId, approved: [], keys: [], trades: { perps: [], spot: [] } };
      this.wallets.set(address, w);
    }
    return w;
  }

  approve(address: string, accountId: number, builderID: number = BUILDER, feeRate = 20): void {
    this.wallet(address, accountId).approved.push({ builderID, feeRate });
  }

  listKey(address: string, key: ApiKey): void {
    const w = this.wallets.get(address)!;
    w.keys = w.keys.filter((k) => k.name !== key.name);
    w.keys.push(key);
  }

  /**
   * Place and fill an order: its fills appear in `/trades` (with `builderFee`
   * where SoDEX charges one), its signed request on the explorer.
   */
  order(address: string, o: OrderSpec): void {
    const w = this.wallets.get(address)!;
    const symbol = o.symbol ?? (o.engine === 'perps' ? 'BTC-USD' : 'vETH_vUSDC');
    const side = o.side ?? 'SELL';
    const clOrdID = o.clOrdID ?? `vs-${o.orderId.toString(36)}`;
    const charged = !!o.builder && o.builder.fee > 0 && (o.engine === 'perps' || side === 'SELL');
    for (const f of o.fills ?? [{ price: '100', quantity: '0.1' }]) {
      const row: Record<string, unknown> = {
        symbol, tradeID: this.tradeSeq++, orderID: o.orderId, clOrdID, side, price: f.price, quantity: f.quantity,
        fee: mul(f.price, f.quantity, 65), feeCoin: o.engine === 'spot' && side === 'BUY' ? symbol.split('_')[0] : 'vUSDC', time: f.at ?? o.at, isMaker: false,
      };
      if (charged) row.builderFee = mul(f.price, f.quantity, o.builder!.fee);
      w.trades[o.engine].push(row);
    }
    this.txs.set(`${o.engine}:${w.accountId}:${o.orderId}`, this.explorerBody(w.accountId, o, symbol, side, clOrdID));
  }

  /** More fills for an order that exists already (a resting order filling further). */
  fillMore(address: string, engine: Engine, orderId: number, fills: Array<{ price: string; quantity: string; at: number }>): void {
    const w = this.wallets.get(address)!;
    const first = w.trades[engine].find((r) => r.orderID === orderId)!;
    for (const f of fills) {
      const row: Record<string, unknown> = { ...first, tradeID: this.tradeSeq++, price: f.price, quantity: f.quantity, time: f.at, fee: mul(f.price, f.quantity, 65) };
      if (first.builderFee !== undefined) {
        const rate = Math.round((Number(first.builderFee) / (Number(first.price) * Number(first.quantity))) * 100_000);
        row.builderFee = mul(f.price, f.quantity, rate);
      }
      w.trades[engine].push(row);
    }
  }

  private explorerBody(accountId: number, o: OrderSpec, symbol: string, side: 'BUY' | 'SELL', clOrdID: string): unknown {
    const sideN = side === 'BUY' ? 1 : 2;
    const symbolID = SYMBOL_ID[symbol] ?? 50;
    const builder = o.builder ? { id: o.builder.id, fee: o.builder.fee } : undefined;
    // In the structs' field order: this is what the key signs.
    const params =
      o.engine === 'perps'
        ? { accountID: accountId, symbolID, orders: [{ clOrdID, modifier: 1, side: sideN, type: 2, timeInForce: 3, quantity: '0.1', reduceOnly: false, positionSide: 1 }], builder }
        : { accountID: accountId, orders: [{ symbolID, clOrdID, side: sideN, type: 2, timeInForce: 3, quantity: '0.1' }], builder };
    const type = o.engine === 'perps' ? 'newOrder' : 'batchNewOrder';
    const nonce = o.at - 300;
    const signature = signExchangeAction(o.engine === 'spot' ? 'spot' : 'futures', CHAIN, type, params, BigInt(nonce), o.key.secret);
    // The explorer returns the request with its keys sorted.
    const sorted = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sorted)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)]))
        : v;
    return {
      code: 0,
      message: '',
      data: {
        tx_hash: '0x' + o.orderId.toString(16).padStart(64, '0'),
        snapshot_id: 1,
        ts_ms: o.at,
        seq: 0,
        account_id: accountId,
        cl_ord_ids: [clOrdID],
        order_ids: [o.orderId],
        action: type,
        status: 1,
        msg: '',
        tx_json: JSON.stringify({ nonce, payload: sorted(params), signature, type }),
      },
    };
  }

  // --- VerifierIo ---------------------------------------------------------------------------

  private failure(kind: 'builders' | 'keys' | 'trades' | 'explorer'): number | 'timeout' | undefined {
    return this.fail[kind]?.shift();
  }

  async get(path: string): Promise<unknown> {
    const at = this.clock.now();
    let m = /^\/api\/v1\/user\/(0x[0-9a-f]{40})\/builders$/.exec(path);
    if (m) {
      this.calls.push({ kind: 'builders', path, at });
      const f = this.failure('builders');
      if (f !== undefined) throw Object.assign(new Error(f === 429 ? 'error code: 1015' : `HTTP ${f}`), { httpStatus: f === 'timeout' ? 0 : f });
      const w = this.wallets.get(m[1]!);
      const rows = (w?.approved ?? []).map((a) => ({ userID: w!.accountId, builderID: a.builderID, feeRate: a.feeRate }));
      return { spot: rows, perps: rows.map((r) => ({ ...r, feeRate: Math.min(r.feeRate, 200) })) };
    }
    m = /^\/api\/v1\/(perps|spot)\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (m) {
      this.calls.push({ kind: 'keys', path, at });
      const f = this.failure('keys');
      if (f !== undefined) throw Object.assign(new Error(f === 429 ? 'error code: 1015' : `HTTP ${f}`), { httpStatus: f === 'timeout' ? 0 : f });
      const w = this.wallets.get(m[2]!);
      return [{ name: 'default', type: 'EVM', publicKey: m[2], expiresAt: 0 }, ...(w?.keys ?? []).map((k) => ({ name: k.name, type: 'EVM', publicKey: k.address, expiresAt: at + 7 * 86_400_000 }))];
    }
    m = /^\/api\/v1\/(perps|spot)\/accounts\/(0x[0-9a-f]{40})\/trades\?(.*)$/.exec(path);
    if (m) {
      this.calls.push({ kind: 'trades', path, at });
      const f = this.failure('trades');
      if (f !== undefined) throw Object.assign(new Error(f === 429 ? 'error code: 1015' : `HTTP ${f}`), { httpStatus: f === 'timeout' ? 0 : f });
      const q = new URLSearchParams(m[3]!);
      const limit = Number(q.get('limit') ?? 100);
      const start = Number(q.get('startTime') ?? 0);
      const end = q.has('endTime') ? Number(q.get('endTime')) : Number.POSITIVE_INFINITY;
      const rows = (this.wallets.get(m[2]!)?.trades[m[1] as Engine] ?? [])
        .filter((r) => (r.time as number) >= start && (r.time as number) <= end && (r.time as number) <= at)
        .sort((a, b) => (b.time as number) - (a.time as number) || (b.tradeID as number) - (a.tradeID as number));
      return rows.slice(0, limit);
    }
    throw new Error(`unexpected gateway request in a test: ${path}`);
  }

  /** Answer an unknown order with HTTP 404 (mainnet) instead of a 200 body. */
  notFoundStatus = false;

  async explorer(path: string): Promise<unknown> {
    this.calls.push({ kind: 'explorer', path, at: this.clock.now() });
    const f = this.failure('explorer');
    if (f !== undefined) throw f === 'timeout' ? new Error('The operation was aborted due to timeout') : new ExplorerError(f, `the explorer answered HTTP ${f}`);
    const m = /^\/api\/v1\/(perps|spot)\/transaction\?account_id=(\d+)&order_id=(\d+)$/.exec(path);
    if (!m) throw new Error(`unexpected explorer request in a test: ${path}`);
    const tx = this.txs.get(`${m[1]}:${m[2]}:${m[3]}`);
    // Mainnet (2026-11-01) answers an order it does not know with HTTP 404, not a 200 body.
    if (!tx && this.notFoundStatus) throw new ExplorerError(404, 'the explorer answered HTTP 404');
    return tx ?? { code: 404, message: 'record not found', data: null };
  }

  cooldownMs(): number {
    return this.cooldown;
  }

  weightSpent(): number {
    return this.weight;
  }

  count(kind: 'builders' | 'keys' | 'trades' | 'explorer'): number {
    return this.calls.filter((c) => c.kind === kind).length;
  }
}

/**
 * Run a verifier on the fake clock until nothing is queued, or until `ms` of
 * that clock have passed. Returns how many rounds it took.
 */
export async function drive(v: { runOnce(): Promise<number | null> }, clock: Clock, ms: number): Promise<number> {
  const until = clock.now() + ms;
  let rounds = 0;
  for (;;) {
    const wait = await v.runOnce();
    rounds += 1;
    if (wait === null || rounds > 100_000) return rounds;
    if (clock.now() + wait > until) {
      clock.t = until;
      return rounds;
    }
    clock.advance(Math.max(wait, 1));
  }
}
