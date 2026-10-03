/**
 * Stellar (types.ts NativeChain): an ed25519 seed DERIVED from the test key
 * (keys.ed25519('stellar')) -> Keypair.fromRawEd25519Seed -> a G... account.
 * Native XLM only, in stroops (7 decimals), on the public network, signed
 * locally (stellar-base), sent as POST /transactions (form body tx=<XDR>) to
 * Horizon. No memo: SoDEX gives each wallet its own address - a destination
 * that asks for a memo (SEP-29 config.memo_required) is refused.
 *
 * Servers (Horizon, both answered 2026-10-03): horizon.stellar.org (SDF),
 * horizon.stellar.lobstr.co. Reads go to the first that answers; the
 * transaction goes to the one that answered the prepare's reads.
 *
 * To an account that exists: a Payment. To one that does not: createAccount,
 * which must bring at least the minimum balance of a new account (2 base
 * reserves, read live: 1 XLM today) - less is refused here.
 * What must stay: (2 + subentries + sponsoring - sponsored) base reserves +
 * selling liabilities - the account's minimum balance.
 */
import { Account, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, type Transaction } from '@stellar/stellar-base';
import type { NativeChain, NativeCoin, NativeKeys, PreparedSend, SendCosts } from './types';

export const STELLAR_ORIGINS = ['https://horizon.stellar.org', 'https://horizon.stellar.lobstr.co'] as const;
const EXPLORER = 'https://stellar.expert/explorer/public/tx/';

/** The fee bid per operation, stroops: at least the network minimum, at most 0.01 XLM. */
export const STELLAR_MIN_FEE = 100n;
export const STELLAR_MAX_FEE = 100_000n;
/** How long a signed transaction stays valid (its time bounds' maxTime), seconds. */
export const STELLAR_TIMEOUT_S = 300;

const TIMEOUT_MS = 20_000;

let preferred = 0;
/** Sends we built: their maxTime (unix seconds), so `confirmed` can tell "never" from "not yet". */
const expiries = new Map<string, number>();

function assertXlm(coin: NativeCoin): void {
  if (!coin.native || coin.token !== null || coin.decimals !== 7) {
    throw new Error(`Stellar: only XLM itself is sent here (7 decimals, stroops), not ${coin.symbol}${coin.token ? ` (${coin.token})` : ''}`);
  }
}

export function stellarKeypair(keys: NativeKeys): Keypair {
  const seed = keys.ed25519('stellar');
  if (seed.length !== 32) throw new Error('Stellar: the derived seed must be 32 bytes');
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

/** "99.4338370" -> 994338370n. */
export function stroopsOf(s: unknown): bigint {
  if (typeof s !== 'string' || !/^\d+(\.\d{1,7})?$/.test(s)) throw new Error(`Stellar: not an XLM amount: ${String(s)}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * 10_000_000n + BigInt(frac.padEnd(7, '0'));
}

/** 994338370n -> "99.4338370". */
export function xlmOf(stroops: bigint): string {
  if (stroops < 0n) throw new Error('Stellar: negative amount');
  return `${stroops / 10_000_000n}.${(stroops % 10_000_000n).toString().padStart(7, '0')}`;
}

type Got = { origin: string; status: number; json: Record<string, unknown> };

async function get(origin: string, path: string): Promise<Got | { origin: string; why: string }> {
  try {
    const res = await globalThis.fetch(`${origin}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) return { origin, why: `HTTP ${res.status}` };
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { origin, why: `HTTP ${res.status}, not JSON: ${text.slice(0, 120)}` };
    }
    return { origin, status: res.status, json };
  } catch (e) {
    return { origin, why: (e as Error).message };
  }
}

/** A Horizon read: server after server until one answers (404 IS an answer). `only`: that server and no other. */
async function horizon(path: string, only?: string): Promise<Got> {
  const order = only ? [only] : STELLAR_ORIGINS.map((_, i) => STELLAR_ORIGINS[(preferred + i) % STELLAR_ORIGINS.length]!);
  const tried: string[] = [];
  for (const origin of order) {
    const r = await get(origin, path);
    if ('why' in r) {
      tried.push(`${origin}: ${r.why}`);
      continue;
    }
    const idx = STELLAR_ORIGINS.indexOf(origin as (typeof STELLAR_ORIGINS)[number]);
    if (idx >= 0) preferred = idx;
    return r;
  }
  throw new Error(`Stellar: no Horizon answered ${path} (${tried.join('; ')})`);
}

interface StellarAccount {
  origin: string;
  exists: boolean;
  balance: bigint;
  sequence: string;
  /** The minimum balance (reserves + selling liabilities), given the base reserve. */
  minimum: (reserve: bigint) => bigint;
  memoRequired: boolean;
}

async function account(id: string): Promise<StellarAccount> {
  const r = await horizon(`/accounts/${encodeURIComponent(id)}`);
  if (r.status === 404) return { origin: r.origin, exists: false, balance: 0n, sequence: '0', minimum: (reserve) => 2n * reserve, memoRequired: false };
  if (r.status !== 200) throw new Error(`Stellar: account ${id}: HTTP ${r.status} ${String(r.json.detail ?? r.json.title ?? '')}`);
  const j = r.json as {
    sequence?: string; subentry_count?: number; num_sponsoring?: number; num_sponsored?: number;
    balances?: { asset_type?: string; balance?: string; selling_liabilities?: string }[]; data?: Record<string, string>;
  };
  const native = (j.balances ?? []).find((b) => b.asset_type === 'native');
  if (!native || typeof j.sequence !== 'string' || !/^\d+$/.test(j.sequence)) throw new Error(`Stellar: account ${id}: unexpected answer`);
  const entries = 2n + BigInt(j.subentry_count ?? 0) + BigInt(j.num_sponsoring ?? 0) - BigInt(j.num_sponsored ?? 0);
  const selling = native.selling_liabilities ? stroopsOf(native.selling_liabilities) : 0n;
  return {
    origin: r.origin,
    exists: true,
    balance: stroopsOf(native.balance),
    sequence: j.sequence,
    minimum: (reserve) => (entries > 0n ? entries : 0n) * reserve + selling,
    memoRequired: j.data?.['config.memo_required'] === 'MQ==', // base64("1"), SEP-29
  };
}

/** The latest ledger Horizon has: its base reserve (stroops) and when it closed (unix seconds). */
async function latestLedger(only?: string): Promise<{ origin: string; reserve: bigint; closedAt: number }> {
  const r = await horizon('/ledgers?order=desc&limit=1', only);
  const rec = ((r.json._embedded as { records?: unknown[] } | undefined)?.records?.[0] ?? null) as { base_reserve_in_stroops?: number; closed_at?: string } | null;
  if (r.status !== 200 || !rec || !Number.isSafeInteger(rec.base_reserve_in_stroops) || !(rec.base_reserve_in_stroops! > 0)) {
    throw new Error(`Stellar: no base reserve in Horizon's latest ledger (HTTP ${r.status})`);
  }
  const closedAt = Date.parse(rec.closed_at ?? '');
  return { origin: r.origin, reserve: BigInt(rec.base_reserve_in_stroops!), closedAt: Number.isFinite(closedAt) ? Math.floor(closedAt / 1000) : 0 };
}

/** The fee bid of one operation, stroops: 2 x max(network base fee, p90 of what the last ledger charged), 100..100000. */
export async function stellarFee(): Promise<bigint> {
  const r = await horizon('/fee_stats');
  if (r.status !== 200) throw new Error(`Stellar: fee_stats HTTP ${r.status}`);
  const j = r.json as { last_ledger_base_fee?: string; fee_charged?: { p90?: string; p50?: string } };
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? BigInt(s) : 0n);
  let fee = STELLAR_MIN_FEE;
  for (const f of [num(j.last_ledger_base_fee), num(j.fee_charged?.p50), num(j.fee_charged?.p90)]) if (f > fee) fee = f;
  // A bid is a maximum: in surge pricing every transaction pays the ledger's clearing fee, not its bid.
  fee *= 2n;
  return fee > STELLAR_MAX_FEE ? STELLAR_MAX_FEE : fee;
}

const xlmText = (stroops: bigint) => `${xlmOf(stroops)} XLM`;

export const stellar: NativeChain = {
  kind: 'stellar',
  label: 'Stellar',
  chainKey: 'XLM',
  origins: STELLAR_ORIGINS,

  isWrite(_url, method) {
    // Horizon's only writes are POST /transactions (and /transactions_async); any non-read method counts as one.
    const m = method.toUpperCase();
    return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
  },

  address(keys) {
    return stellarKeypair(keys).publicKey();
  },

  async balance(address, coin) {
    assertXlm(coin);
    return (await account(address)).balance;
  },

  async costs(address, coin, _to): Promise<SendCosts> {
    assertXlm(coin);
    const [fee, ledger, acct] = await Promise.all([stellarFee(), latestLedger(), account(address)]);
    return { fee, keep: acct.minimum(ledger.reserve), nativeNeeded: 0n };
  },

  async prepare(keys, coin, to, amount): Promise<PreparedSend> {
    assertXlm(coin);
    if (typeof to !== 'string' || !StrKey.isValidEd25519PublicKey(to)) {
      throw new Error(`Stellar: ${String(to)} is not a G... account address (muxed M... addresses and memos are not used: SoDEX gives each wallet its own address)`);
    }
    const kp = stellarKeypair(keys);
    const from = kp.publicKey();
    if (to === from) throw new Error('Stellar: the destination is the test wallet itself');
    if (amount !== 'max' && amount <= 0n) throw new Error('Stellar: the amount must be more than 0 stroops');

    const [fee, ledger, src, dest] = await Promise.all([stellarFee(), latestLedger(), account(from), account(to)]);
    if (!src.exists) throw new Error(`Stellar: the test wallet ${from} has no account on the network yet (balance 0)`);
    const keep = src.minimum(ledger.reserve);
    const free = src.balance - fee - keep;
    const value = amount === 'max' ? free : amount;
    if (amount === 'max' && value <= 0n) {
      throw new Error(`Stellar: nothing can leave ${from}: balance ${xlmText(src.balance)}, fee ${fee} stroops, minimum balance ${xlmText(keep)} must stay`);
    }
    if (value > free) {
      throw new Error(`Stellar: too little XLM: ${xlmText(value)} + fee ${fee} stroops + minimum balance ${xlmText(keep)} > balance ${xlmText(src.balance)}`);
    }

    let op;
    let kind: 'payment' | 'createAccount';
    if (dest.exists) {
      if (dest.memoRequired) throw new Error(`Stellar: ${to} requires a memo (SEP-29) - not a per-wallet SoDEX address; refused (no memo is ever set here)`);
      kind = 'payment';
      op = Operation.payment({ destination: to, asset: Asset.native(), amount: xlmOf(value) });
    } else {
      const minNew = 2n * ledger.reserve;
      if (value < minNew) {
        throw new Error(`Stellar: ${to} does not exist yet; creating it needs at least ${xlmText(minNew)} (asked: ${xlmText(value)})`);
      }
      kind = 'createAccount';
      op = Operation.createAccount({ destination: to, startingBalance: xlmOf(value) });
    }

    const tx = new TransactionBuilder(new Account(from, src.sequence), { fee: fee.toString(), networkPassphrase: Networks.PUBLIC })
      .addOperation(op)
      .setTimeout(STELLAR_TIMEOUT_S)
      .build();
    tx.sign(kp);
    const xdr = tx.toEnvelope().toXDR('base64');
    const txid = tx.hash().toString('hex');

    // Check what was signed before it can be sent: the decoded envelope is exactly the transfer asked for.
    const back = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC) as Transaction;
    const bop = back.operations[0] as unknown as { type: string; destination?: string; amount?: string; startingBalance?: string; asset?: Asset; source?: string };
    const sig = back.signatures[0];
    const ok =
      back.source === from && back.operations.length === 1 && bop.type === kind && bop.destination === to && !bop.source &&
      stroopsOf(kind === 'payment' ? bop.amount : bop.startingBalance) === value &&
      (kind !== 'payment' || bop.asset?.isNative() === true) &&
      back.fee === fee.toString() && back.sequence === (BigInt(src.sequence) + 1n).toString() &&
      back.memo.type === 'none' && back.signatures.length === 1 && !!sig &&
      kp.verify(back.hash(), sig.signature()) && back.hash().toString('hex') === txid;
    if (!ok) throw new Error('Stellar: the signed transaction does not read back as the transfer asked for - not sent');

    const maxTime = Number(back.timeBounds?.maxTime ?? 0);
    if (maxTime > 0) expiries.set(txid, maxTime);
    return {
      request: {
        url: `${src.origin}/transactions`,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `tx=${encodeURIComponent(xdr)}`,
      },
      txid,
      amount: value,
      fee,
      explorer: `${EXPLORER}${txid}`,
    };
  },

  async broadcast(p) {
    let res: Response;
    try {
      res = await globalThis.fetch(p.request.url, {
        method: p.request.method,
        headers: p.request.headers,
        body: p.request.body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new Error(`Stellar: Horizon gave no answer (${(e as Error).message}) - the transaction may still be included before it expires; check ${p.txid}`);
    }
    const text = await res.text();
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON: reported below */
    }
    if (res.ok) {
      if (j.successful === false) throw new Error(`Stellar: the transaction ${p.txid} was included but failed`);
      const hash = typeof j.hash === 'string' ? j.hash : null;
      if (!hash) throw new Error(`Stellar: Horizon accepted the transaction but sent no hash: ${text.slice(0, 300)}`);
      if (hash.toLowerCase() !== p.txid.toLowerCase()) throw new Error(`Stellar: Horizon reports hash ${hash}, the signed transaction is ${p.txid}`);
      return p.txid;
    }
    const codes = (j.extras as { result_codes?: unknown } | undefined)?.result_codes;
    if (res.status === 504) {
      throw new Error(`Stellar: Horizon timed out waiting for the ledger (${String(j.detail ?? 'timeout')}) - the transaction may still be included before it expires; check ${p.txid}`);
    }
    throw new Error(`Stellar refused the transaction: HTTP ${res.status} ${String(j.title ?? '')}${codes ? ` ${JSON.stringify(codes)}` : ''}${!codes && j.detail ? ` - ${String(j.detail)}` : ''}${!text.startsWith('{') ? ` ${text.slice(0, 200)}` : ''}`.trim());
  },

  async confirmed(txid) {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`Stellar: ${txid} is not a transaction hash`);
    const hash = txid.toLowerCase();
    // A transaction we built: first the latest ledger, THEN the transaction, on the same Horizon - if that ledger
    // closed after the transaction's maxTime and the transaction is still not there, it can never be included.
    const maxTime = expiries.get(hash);
    const before = maxTime ? await latestLedger() : null;
    const r = await horizon(`/transactions/${hash}`, before?.origin);
    if (r.status === 200) return r.json.successful === true;
    if (r.status !== 404) throw new Error(`Stellar: transaction ${hash}: HTTP ${r.status} ${String(r.json.detail ?? r.json.title ?? '')}`);
    return before && maxTime && before.closedAt > maxTime ? false : null;
  },
};
