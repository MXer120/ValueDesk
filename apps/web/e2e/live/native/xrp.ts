/**
 * XRP Ledger (types.ts NativeChain): the test key used as it is, as a
 * secp256k1 XRPL key (private key '00' + 64 hex, address = base58-XRP of
 * RIPEMD160(SHA256(compressed public key))). Plain XRP Payments in drops,
 * signed locally (xrpl Wallet.sign), sent as JSON-RPC `submit` to a public
 * server. No DestinationTag: SoDEX gives each wallet its own address - a
 * destination that REQUIRES a tag is refused before anything is signed.
 *
 * Servers (JSON-RPC over HTTPS POST, all answered 2026-10-03): xrplcluster.com
 * (full rippled), s1/s2.ripple.com:51234 (Clio, forwards submit / fee / current
 * reads to rippled). Reads go to the first that answers; `submit` goes to the
 * one that answered the prepare's reads.
 *
 * What must stay: the base reserve plus the owner reserve per owned object,
 * read live from server_info (validated_ledger.reserve_base_xrp / reserve_inc_xrp).
 * A Payment to an address the ledger does not know yet creates it, and only
 * when it brings at least the base reserve (else tecNO_DST_INSUF_XRP, fee burnt):
 * refused here instead.
 */
import { Wallet, decode, isValidClassicAddress, verifySignature } from 'xrpl';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { NativeChain, NativeCoin, NativeKeys, PreparedSend, SendCosts } from './types';

export const XRP_ORIGINS = ['https://xrplcluster.com', 'https://s1.ripple.com:51234', 'https://s2.ripple.com:51234'] as const;
const EXPLORER = 'https://livenet.xrpl.org/transactions/';

/** The lowest fee we ever pay (the reference fee is 10 drops) and the most (fee escalation beyond it: wait). */
export const XRP_MIN_FEE = 12n;
export const XRP_MAX_FEE = 2000n;
/** LastLedgerSequence = the validated ledger + this (~ 60-80 s at 3-4 s per ledger). */
export const XRP_LEDGER_WINDOW = 20;

// AccountRoot flags (rippled LedgerFormats.h).
const LSF_REQUIRE_DEST_TAG = 0x00020000;
const LSF_DISALLOW_XRP = 0x00080000;
const LSF_DEPOSIT_AUTH = 0x01000000;

/** Server answers that mean "ask the next server", not "the answer is no". */
const RETRY_ERRORS = new Set(['tooBusy', 'noNetwork', 'noCurrent', 'noClosed', 'notSynced', 'notReady', 'slowDown', 'amendmentBlocked', 'internal', 'lgrNotFound', 'unknownCmd']);
/** JSON-RPC methods that send or sign a transaction (or carry a secret): writes for the network guard. */
const WRITE_METHODS = new Set(['submit', 'submit_multisigned', 'sign', 'sign_for', 'channel_authorize', 'json']);

const TIMEOUT_MS = 20_000;

type RpcResult = Record<string, unknown> & { error?: string; error_message?: string; error_exception?: string; status?: string };

/** Start reads at the server that answered last. */
let preferred = 0;

/** Sends we built: their ledger window, so `confirmed` can tell "never" from "not yet". */
const windows = new Map<string, { min: number; max: number }>();

function assertXrp(coin: NativeCoin): void {
  if (!coin.native || coin.token !== null || coin.decimals !== 6) {
    throw new Error(`XRP Ledger: only XRP itself is sent here (6 decimals, drops), not ${coin.symbol}${coin.token ? ` (${coin.token})` : ''}`);
  }
}

/** The test key as an XRPL secp256k1 wallet. */
export function xrpWallet(keys: NativeKeys): Wallet {
  const key = keys.secp256k1;
  if (key.length !== 32) throw new Error('XRP Ledger: the test key must be 32 bytes');
  const pub = Buffer.from(secp256k1.getPublicKey(key, true)).toString('hex').toUpperCase();
  return new Wallet(pub, `00${Buffer.from(key).toString('hex').toUpperCase()}`);
}

async function post(origin: string, body: string): Promise<{ ok: true; result: RpcResult } | { ok: false; why: string }> {
  try {
    const res = await globalThis.fetch(origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, why: `HTTP ${res.status} ${text.slice(0, 200)}` };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, why: `not JSON: ${text.slice(0, 200)}` };
    }
    const result = (json as { result?: RpcResult } | null)?.result;
    if (!result || typeof result !== 'object') return { ok: false, why: `no result: ${text.slice(0, 200)}` };
    return { ok: true, result };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

/**
 * One JSON-RPC read, server after server until one answers for real (`accept`: e.g. "has a validated ledger").
 * Errors such as actNotFound / txnNotFound ARE answers and come back to the caller.
 */
async function rpc(method: string, params: Record<string, unknown>, accept: (r: RpcResult) => boolean = () => true): Promise<{ origin: string; result: RpcResult }> {
  const body = JSON.stringify({ method, params: [params] });
  const tried: string[] = [];
  for (let i = 0; i < XRP_ORIGINS.length; i++) {
    const idx = (preferred + i) % XRP_ORIGINS.length;
    const origin = XRP_ORIGINS[idx]!;
    const r = await post(origin, body);
    if (!r.ok) {
      tried.push(`${origin}: ${r.why}`);
      continue;
    }
    if (r.result.error && RETRY_ERRORS.has(r.result.error)) {
      tried.push(`${origin}: ${r.result.error}`);
      continue;
    }
    if (!r.result.error && !accept(r.result)) {
      tried.push(`${origin}: incomplete answer`);
      continue;
    }
    preferred = idx;
    return { origin, result: r.result };
  }
  throw new Error(`XRP Ledger: no server answered ${method} (${tried.join('; ')})`);
}

const errText = (r: RpcResult) => r.error_message || r.error_exception || r.error || 'unknown error';

interface AccountState {
  origin: string;
  exists: boolean;
  balance: bigint;
  sequence: number;
  ownerCount: number;
  flags: number;
  /** validated: the ledger index; current: the open ledger's index. */
  ledger: number;
  queued: number;
}

async function accountInfo(account: string, ledger: 'validated' | 'current'): Promise<AccountState> {
  const params: Record<string, unknown> = { account, ledger_index: ledger };
  if (ledger === 'current') params.queue = true;
  const { origin, result } = await rpc('account_info', params);
  const ledgerIndex = Number(result.ledger_index ?? result.ledger_current_index ?? 0);
  if (result.error === 'actNotFound') return { origin, exists: false, balance: 0n, sequence: 0, ownerCount: 0, flags: 0, ledger: ledgerIndex, queued: 0 };
  if (result.error) throw new Error(`XRP Ledger: account_info ${account}: ${errText(result)}`);
  const d = result.account_data as { Balance?: string; Sequence?: number; OwnerCount?: number; Flags?: number } | undefined;
  if (!d || typeof d.Balance !== 'string' || !/^\d+$/.test(d.Balance) || typeof d.Sequence !== 'number') {
    throw new Error(`XRP Ledger: account_info ${account}: unexpected answer`);
  }
  const queue = result.queue_data as { txn_count?: number } | undefined;
  return {
    origin,
    exists: true,
    balance: BigInt(d.Balance),
    sequence: d.Sequence,
    ownerCount: Number(d.OwnerCount ?? 0),
    flags: Number(d.Flags ?? 0),
    ledger: ledgerIndex,
    queued: Number(queue?.txn_count ?? 0),
  };
}

/** XRP amount as the server writes it (1, 1E0, 0.2, 2E-1) -> drops. */
function xrpToDropsExact(v: unknown, what: string): bigint {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new Error(`XRP Ledger: server_info ${what} is not a number of XRP (${String(v)})`);
  const [whole, frac = ''] = n.toFixed(6).split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

/** The reserves, live: base (an account) and increment (per owned object), drops. */
export async function xrpReserves(): Promise<{ base: bigint; inc: bigint }> {
  const { result } = await rpc('server_info', {}, (r) => {
    const vl = (r.info as { validated_ledger?: { reserve_base_xrp?: unknown } } | undefined)?.validated_ledger;
    return vl?.reserve_base_xrp !== undefined;
  });
  if (result.error) throw new Error(`XRP Ledger: server_info: ${errText(result)}`);
  const vl = (result.info as { validated_ledger: { reserve_base_xrp: unknown; reserve_inc_xrp?: unknown } }).validated_ledger;
  const base = xrpToDropsExact(vl.reserve_base_xrp, 'reserve_base_xrp');
  const inc = xrpToDropsExact(vl.reserve_inc_xrp ?? 0, 'reserve_inc_xrp');
  if (base <= 0n) throw new Error('XRP Ledger: server_info says the base reserve is 0 - not believed');
  return { base, inc };
}

/** The fee of one Payment, drops: the open ledger's fee (+20 %), at least 12, at most 2000. */
export async function xrpFee(): Promise<bigint> {
  const { result } = await rpc('fee', {}, (r) => typeof (r.drops as { open_ledger_fee?: unknown } | undefined)?.open_ledger_fee === 'string');
  if (result.error) throw new Error(`XRP Ledger: fee: ${errText(result)}`);
  const drops = result.drops as { base_fee?: string; open_ledger_fee?: string; minimum_fee?: string };
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? BigInt(s) : 0n);
  const open = num(drops.open_ledger_fee);
  let fee = (open * 12n + 9n) / 10n;
  for (const f of [num(drops.base_fee), num(drops.minimum_fee), XRP_MIN_FEE]) if (f > fee) fee = f;
  return fee > XRP_MAX_FEE ? XRP_MAX_FEE : fee;
}

const keepOf = (r: { base: bigint; inc: bigint }, ownerCount: number) => r.base + r.inc * BigInt(Math.max(0, ownerCount));
const xrpText = (drops: bigint) => `${drops / 1_000_000n}.${(drops % 1_000_000n).toString().padStart(6, '0')} XRP`;

function isWriteBody(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(isWriteBody);
  if (!v || typeof v !== 'object') return true;
  const o = v as { method?: unknown; command?: unknown; params?: unknown };
  const m = typeof o.method === 'string' ? o.method : typeof o.command === 'string' ? o.command : null;
  if (m === null) return true;
  if (WRITE_METHODS.has(m.toLowerCase())) return true;
  // A read that carries a secret is never let out as a read.
  const params = Array.isArray(o.params) ? o.params : [o.params];
  return params.some((p) => p && typeof p === 'object' && ['secret', 'seed', 'seed_hex', 'passphrase'].some((k) => k in (p as object)));
}

export const xrp: NativeChain = {
  kind: 'xrp',
  label: 'XRP Ledger',
  chainKey: 'XRP',
  origins: XRP_ORIGINS,

  isWrite(_url, method, body) {
    if (method.toUpperCase() !== 'POST') return false;
    if (body === null || body === '') return false;
    try {
      return isWriteBody(JSON.parse(body));
    } catch {
      return true; // cannot tell: treat as a write
    }
  },

  address(keys) {
    return xrpWallet(keys).classicAddress;
  },

  async balance(address, coin) {
    assertXrp(coin);
    return (await accountInfo(address, 'validated')).balance;
  },

  async costs(address, coin, _to): Promise<SendCosts> {
    assertXrp(coin);
    const [fee, reserves, acct] = await Promise.all([xrpFee(), xrpReserves(), accountInfo(address, 'validated')]);
    return { fee, keep: keepOf(reserves, acct.ownerCount), nativeNeeded: 0n };
  },

  async prepare(keys, coin, to, amount): Promise<PreparedSend> {
    assertXrp(coin);
    if (typeof to !== 'string' || !isValidClassicAddress(to)) {
      throw new Error(`XRP Ledger: ${String(to)} is not a classic r-address (X-addresses and tags are not used: SoDEX gives each wallet its own address)`);
    }
    const wallet = xrpWallet(keys);
    const from = wallet.classicAddress;
    if (to === from) throw new Error('XRP Ledger: the destination is the test wallet itself');
    if (amount !== 'max' && amount <= 0n) throw new Error('XRP Ledger: the amount must be more than 0 drops');

    const [fee, reserves, validated, current, dest] = await Promise.all([
      xrpFee(),
      xrpReserves(),
      accountInfo(from, 'validated'),
      accountInfo(from, 'current'),
      accountInfo(to, 'validated'),
    ]);
    if (!validated.exists || !current.exists) throw new Error(`XRP Ledger: the test wallet ${from} has no account on the ledger yet (balance 0)`);
    if (current.queued > 0) throw new Error(`XRP Ledger: ${current.queued} transaction(s) of ${from} are still queued - wait until they are final`);

    // What can leave: the lower of the validated and the open ledger's balance (an earlier send not yet validated counts).
    const balance = validated.balance < current.balance ? validated.balance : current.balance;
    const keep = keepOf(reserves, Math.max(validated.ownerCount, current.ownerCount));
    const free = balance - fee - keep;
    const value = amount === 'max' ? free : amount;
    if (amount === 'max' && value <= 0n) {
      throw new Error(`XRP Ledger: nothing can leave ${from}: balance ${xrpText(balance)}, fee ${fee} drops, reserve ${xrpText(keep)} must stay`);
    }
    if (value > free) {
      throw new Error(`XRP Ledger: too little XRP: ${xrpText(value)} + fee ${fee} drops + reserve ${xrpText(keep)} > balance ${xrpText(balance)}`);
    }

    if (!dest.exists) {
      if (value < reserves.base) {
        throw new Error(`XRP Ledger: ${to} is not on the ledger yet; a payment that creates it must bring at least the base reserve ${xrpText(reserves.base)} (asked: ${xrpText(value)})`);
      }
    } else {
      if (dest.flags & LSF_REQUIRE_DEST_TAG) throw new Error(`XRP Ledger: ${to} requires a destination tag - not a per-wallet SoDEX address; refused (no tag is ever set here)`);
      if (dest.flags & LSF_DEPOSIT_AUTH) throw new Error(`XRP Ledger: ${to} only accepts preauthorized senders (DepositAuth) - the payment would fail`);
      if (dest.flags & LSF_DISALLOW_XRP) throw new Error(`XRP Ledger: ${to} asks not to receive XRP (DisallowXRP)`);
    }

    const sequence = current.sequence;
    const validatedLedger = validated.ledger > 0 ? validated.ledger : current.ledger - 1;
    if (!(validatedLedger > 0)) throw new Error('XRP Ledger: no validated ledger index in the answer');
    const lastLedger = validatedLedger + XRP_LEDGER_WINDOW;
    const tx = {
      TransactionType: 'Payment' as const,
      Account: from,
      Destination: to,
      Amount: value.toString(),
      Fee: fee.toString(),
      Sequence: sequence,
      LastLedgerSequence: lastLedger,
      Flags: 0,
    };
    const signed = wallet.sign(tx);

    // Check what was signed before it can be sent: the decoded blob is exactly the payment asked for.
    const back = decode(signed.tx_blob) as Record<string, unknown>;
    if (
      back.TransactionType !== 'Payment' || back.Account !== from || back.Destination !== to || back.Amount !== tx.Amount ||
      back.Fee !== tx.Fee || back.Sequence !== sequence || back.LastLedgerSequence !== lastLedger ||
      'DestinationTag' in back || 'Memos' in back || 'NetworkID' in back || !verifySignature(signed.tx_blob, wallet.publicKey)
    ) {
      throw new Error('XRP Ledger: the signed transaction does not read back as the payment asked for - not sent');
    }

    windows.set(signed.hash, { min: validatedLedger + 1, max: lastLedger });
    // Submit to the server that answered the open-ledger read.
    const origin = current.origin;
    return {
      request: {
        url: origin,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'submit', params: [{ tx_blob: signed.tx_blob }] }),
      },
      txid: signed.hash,
      amount: value,
      fee,
      explorer: `${EXPLORER}${signed.hash}`,
    };
  },

  async broadcast(p) {
    let res: Response;
    try {
      res = await globalThis.fetch(p.request.url, {
        method: p.request.method,
        headers: p.request.headers,
        body: p.request.body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`XRP Ledger: submit got no answer (${(e as Error).message}) - the transaction may still have reached the network; check ${p.txid}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`XRP Ledger: submit HTTP ${res.status}: ${text.slice(0, 300)}`);
    let result: RpcResult & { engine_result?: string; engine_result_message?: string; tx_json?: { hash?: string } };
    try {
      result = (JSON.parse(text) as { result: typeof result }).result;
    } catch {
      throw new Error(`XRP Ledger: submit answered something that is not JSON: ${text.slice(0, 300)}`);
    }
    if (!result || typeof result !== 'object') throw new Error(`XRP Ledger: submit: no result in ${text.slice(0, 300)}`);
    if (result.error) throw new Error(`XRP Ledger refused the transaction: ${result.error}: ${errText(result)}`);
    const er = result.engine_result;
    if (er !== 'tesSUCCESS' && er !== 'terQUEUED') {
      throw new Error(`XRP Ledger refused the transaction: ${er ?? 'no engine_result'}: ${result.engine_result_message ?? ''}`.trim());
    }
    const hash = result.tx_json?.hash;
    if (hash && hash.toUpperCase() !== p.txid.toUpperCase()) throw new Error(`XRP Ledger: the server reports hash ${hash}, the signed transaction is ${p.txid}`);
    return p.txid;
  },

  async confirmed(txid) {
    if (!/^[0-9A-Fa-f]{64}$/.test(txid)) throw new Error(`XRP Ledger: ${txid} is not a transaction hash`);
    const hash = txid.toUpperCase();
    const w = windows.get(hash);
    const params: Record<string, unknown> = { transaction: hash, binary: false };
    if (w) Object.assign(params, { min_ledger: w.min, max_ledger: w.max });
    const { result } = await rpc('tx', params);
    if (result.error === 'txnNotFound') {
      // searched_all: the server holds every ledger up to LastLedgerSequence - the transaction can never be in one.
      return w && result.searched_all === true ? false : null;
    }
    if (result.error) throw new Error(`XRP Ledger: tx ${hash}: ${errText(result)}`);
    if (result.validated !== true) return null;
    const meta = result.meta as { TransactionResult?: string } | string | undefined;
    const code = typeof meta === 'object' && meta ? meta.TransactionResult : undefined;
    if (!code) return null;
    return code === 'tesSUCCESS';
  },
};
