/**
 * Solana (types.ts NativeChain): SOL and SPL tokens (SoDEX's Solana USDC and USDT, both on the classic
 * Token program; a Token-2022 mint is recognised by the program that owns the mint account) from the ONE
 * test key: keys.ed25519('solana') -> Keypair.fromSeed.
 *
 * The network: plain JSON-RPC over HTTPS through global fetch, ONE POST per call, so the runner's guard
 * sees every exact body (web3.js / spl-token only build, sign and serialize; their Connection is never
 * used). Reads go to the first node and fall over to the second when it is unreachable or rate-limits;
 * the send goes to the first node only, with exactly the body `prepare` returned.
 *
 * Rules the network enforces and `prepare` checks before it signs (a plain refusal, nothing built):
 *   - fee: 5 000 lamports per signature + a priority fee (compute-unit limit x price, rounded up),
 *     fixed per kind of send, so `costs().fee` is the exact fee of the prepared transaction (and is
 *     checked against the node's getFeeForMessage);
 *   - rent: an account may hold 0 lamports or at least the rent-exempt minimum for its size (a wallet:
 *     getMinimumBalanceForRentExemption(0)) - never anything in between. That holds for the sender
 *     after the fee is taken and after the send, and for the receiver. SOL can therefore be emptied to
 *     exactly 0 ('max', `keep` 0), but a send that would leave 1 .. minimum-1 lamports is refused;
 *   - a token send creates the receiver's associated token account when it is missing (idempotent
 *     create, the test wallet pays its rent) and then transferChecked from the test wallet's own
 *     associated token account. `nativeNeeded` = fee + that rent when the account is missing;
 *   - the receiver must be a plain wallet: an ed25519 (on-curve) address that is unused or a
 *     system-owned account without data - never a token account, a program or a program's account;
 *   - every transaction is dry-run (simulateTransaction, signatures checked) before it is handed back.
 *
 * `confirmed`: confirmed / finalized and no error -> true; an error -> false; unknown -> null - except a
 * transaction `prepare` built in this process whose blockhash has expired (finalized block height past
 * its last valid block height + a margin) and that is still unknown: it can never land -> false.
 */
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccountLen,
  getAccountTypeOfMintType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getNonTransferable,
  getPausableConfig,
  getTransferFeeConfig,
  getTransferHook,
  unpackAccount,
  unpackMint,
  type Account as TokenAccount,
  type Mint,
} from '@solana/spl-token';
import type { NativeChain, NativeCoin, NativeKeys, PreparedSend, SendCosts } from './types';

/** Public mainnet JSON-RPC nodes, no key needed (both answered getLatestBlockhash / getMultipleAccounts / simulateTransaction / getFeeForMessage on 2026-10-03). */
export const SOLANA_RPC = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'] as const;
/** The node that gets the send (Solana's own public endpoint: it accepts sendTransaction without a key). */
const SEND_URL: string = SOLANA_RPC[0];
const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };
const COMMITMENT = 'confirmed';
const READ_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 30_000;

export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** The priority fee's price: 0.5 lamport per compute unit (dearer than most transfers pay, still a fraction of a cent). */
export const CU_PRICE_MICROLAMPORTS = 500_000n;
/**
 * Compute-unit limits: about 3-4x what the instructions used in a dry run on mainnet (2026-10-03: SOL transfer 450 CU incl.
 * the two compute-budget instructions; USDC create-ATA + transferChecked 13 923; with the ATA already there 6 323).
 */
export const CU_LIMIT = { sol: 2_000, token: 40_000, token2022: 100_000 } as const;
/** The fee of a one-signature transaction with this compute-unit limit (the priority part rounds up, as the runtime does). */
export const feeFor = (cuLimit: number): bigint => LAMPORTS_PER_SIGNATURE + (BigInt(cuLimit) * CU_PRICE_MICROLAMPORTS + 999_999n) / 1_000_000n;
/** How far past a blockhash's last valid block height the chain must be (finalized) before an unknown transaction counts as never landed. */
const EXPIRY_MARGIN_BLOCKS = 150n;

const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
const U64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------- base58 / amounts

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** base units -> decimal text, trailing zeros cut. */
function units(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
const sol = (lamports: bigint): string => `${units(lamports, 9)} SOL`;

// ---------------------------------------------------------------- JSON-RPC

/** A node's definite JSON-RPC error (not a transport failure / rate limit). */
class NodeError extends Error {}

/** JSON with integers beyond 2^53 kept exact (as bigint): lamport balances of big wallets do not fit a double. */
function parseJson(text: string): unknown {
  const reviver = (_key: string, value: unknown, ctx?: { source?: string }): unknown =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && ctx?.source && /^-?\d+$/.test(ctx.source) ? BigInt(ctx.source) : value;
  return JSON.parse(text, reviver as (this: unknown, key: string, value: unknown) => unknown);
}

function big(v: unknown, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`Solana: ${what} is not an integer (${String(v)})`);
}

type RpcErrorBody = { code?: unknown; message?: unknown; data?: unknown };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function describeRpcError(e: RpcErrorBody): string {
  const parts = [typeof e.message === 'string' ? e.message : JSON.stringify(e)];
  if (isObj(e.data)) {
    if (e.data.err != null) parts.push(`(${typeof e.data.err === 'string' ? e.data.err : JSON.stringify(e.data.err, bigintSafe)})`);
    const logs = Array.isArray(e.data.logs) ? e.data.logs.filter((l): l is string => typeof l === 'string') : [];
    if (logs.length) parts.push(`- logs: ${logs.slice(-4).join(' | ')}`);
  }
  return parts.join(' ');
}
const bigintSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

/** A rate limit or an overloaded node: try the next one. */
const transient = (e: RpcErrorBody): boolean =>
  e.code === 429 || e.code === -32005 || e.code === -32429 || (typeof e.message === 'string' && /too many requests|rate limit|temporarily unavailable/i.test(e.message));

/** One JSON-RPC read: one POST per node, the next node only when this one did not answer. */
async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const failures: string[] = [];
  for (const url of SOLANA_RPC) {
    let status: number;
    let text: string;
    try {
      const res = await globalThis.fetch(url, { method: 'POST', headers: JSON_HEADERS, body, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      status = res.status;
      text = await res.text();
    } catch (e) {
      failures.push(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    let json: unknown = null;
    try {
      json = parseJson(text);
    } catch {
      /* not JSON: below */
    }
    if (isObj(json) && isObj(json.error)) {
      const err = json.error as RpcErrorBody;
      if (transient(err) || status >= 500) {
        failures.push(`${new URL(url).host}: ${describeRpcError(err)}`);
        continue;
      }
      throw new NodeError(`Solana ${method}: ${describeRpcError(err)}`);
    }
    if (status >= 200 && status < 300 && isObj(json) && 'result' in json) return json.result as T;
    failures.push(`${new URL(url).host}: HTTP ${status} ${text.slice(0, 160)}`);
  }
  throw new Error(`Solana ${method}: no node answered (${failures.join('; ')})`);
}

interface Acct {
  owner: string;
  lamports: bigint;
  data: Buffer;
  executable: boolean;
}

function acct(v: unknown, what: string): Acct | null {
  if (v == null) return null;
  if (!isObj(v) || !Array.isArray(v.data) || v.data[1] !== 'base64' || typeof v.data[0] !== 'string' || typeof v.owner !== 'string') {
    throw new Error(`Solana: unreadable account answer for ${what}`);
  }
  return { owner: v.owner, lamports: big(v.lamports, `${what} lamports`), data: Buffer.from(v.data[0], 'base64'), executable: v.executable === true };
}

/** Several accounts in one read (null: the chain does not know it). */
async function accounts(keys: readonly PublicKey[]): Promise<(Acct | null)[]> {
  const ids = keys.map((k) => k.toBase58());
  const r = await rpc<{ value?: unknown }>('getMultipleAccounts', [ids, { encoding: 'base64', commitment: COMMITMENT }]);
  if (!isObj(r) || !Array.isArray(r.value) || r.value.length !== ids.length) throw new Error('Solana getMultipleAccounts: unexpected answer');
  return r.value.map((v, i) => acct(v, ids[i] ?? '?'));
}

async function rentExempt(bytes: number): Promise<bigint> {
  return big(await rpc('getMinimumBalanceForRentExemption', [bytes, { commitment: COMMITMENT }]), 'rent-exempt minimum');
}

async function latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  const r = await rpc<{ value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>('getLatestBlockhash', [{ commitment: COMMITMENT }]);
  const v = isObj(r) && isObj(r.value) ? r.value : null;
  if (!v || typeof v.blockhash !== 'string') throw new Error('Solana getLatestBlockhash: unexpected answer');
  return { blockhash: v.blockhash, lastValidBlockHeight: big(v.lastValidBlockHeight, 'lastValidBlockHeight') };
}

const web3Info = (a: Acct): AccountInfo<Buffer> => ({ data: a.data, executable: a.executable, lamports: Number(a.lamports), owner: new PublicKey(a.owner) });

// ---------------------------------------------------------------- checks

/** A canonical base58 address of 32 bytes, or a plain refusal. */
function pubkey(a: string, what: string): PublicKey {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) throw new Error(`${what} "${a}" is not a Solana address`);
  let k: PublicKey;
  try {
    k = new PublicKey(a);
  } catch {
    throw new Error(`${what} "${a}" is not a Solana address (not 32 bytes)`);
  }
  if (k.toBase58() !== a) throw new Error(`${what} "${a}" is not a canonical Solana address`);
  return k;
}

/** The receiver must be a plain wallet: on the ed25519 curve, unused or a system account without data. */
function receiverProblem(to: PublicKey, info: Acct | null): string | null {
  if (!PublicKey.isOnCurve(to.toBytes())) return `the receiver ${to.toBase58()} is not a wallet address (off the ed25519 curve: a program-derived address such as a token account) - refused`;
  if (!info) return null;
  if (info.executable) return `the receiver ${to.toBase58()} is a program, not a wallet - refused`;
  if (TOKEN_PROGRAMS.has(info.owner)) return `the receiver ${to.toBase58()} is a token account, not a wallet - the deposit address must be the owner wallet - refused`;
  if (info.owner !== SYSTEM_PROGRAM || info.data.length > 0) return `the receiver ${to.toBase58()} is an account of program ${info.owner}, not a plain wallet - refused`;
  return null;
}

function payerProblem(info: Acct | null): string | null {
  if (info && (info.owner !== SYSTEM_PROGRAM || info.data.length > 0)) return `the test wallet's Solana account is owned by ${info.owner}, not the system program - it cannot pay fees`;
  return null;
}

/**
 * Lamports leaving the test wallet's SOL balance, checked against Solana's rent rule: a wallet holds 0 or at least
 * `floor` lamports - after the fee is taken (before the instructions run) and after the transaction - and so does
 * the receiver. Throws a plain reason.
 */
export function solAmount(have: bigint, fee: bigint, floor: bigint, toHas: bigint, want: bigint | 'max'): bigint {
  if (have <= fee) throw new Error(`the test wallet holds ${sol(have)} - not even the network fee of ${sol(fee)}`);
  const amount = want === 'max' ? have - fee : want;
  if (amount <= 0n) throw new Error('the amount must be above 0');
  if (amount > U64_MAX) throw new Error('the amount is too large');
  if (amount + fee > have) throw new Error(`the test wallet holds ${sol(have)} - not ${sol(amount)} plus the network fee ${sol(fee)}`);
  if (have - fee < floor) {
    throw new Error(`after the network fee the test wallet would hold ${sol(have - fee)}, below Solana's rent-exempt minimum ${sol(floor)} - the network refuses that; a SOL send needs at least ${sol(floor + fee)} in the wallet`);
  }
  const left = have - fee - amount;
  if (left > 0n && left < floor) {
    throw new Error(`the send would leave ${sol(left)} in the test wallet, below Solana's rent-exempt minimum ${sol(floor)} (the network refuses that) - send everything ('max': ${sol(have - fee)}) or leave at least ${sol(floor)}`);
  }
  if (toHas + amount < floor) {
    throw new Error(`the receiver holds ${sol(toHas)}; ${sol(amount)} more stays below Solana's rent-exempt minimum ${sol(floor)} - the network refuses that; send at least ${sol(floor - toHas)}`);
  }
  return amount;
}

/** The SOL a token send takes from the test wallet (fee + the receiver's token-account rent), against the same rent rule. */
export function tokenSolProblem(have: bigint, fee: bigint, rent: bigint, floor: bigint): string | null {
  const need = fee + rent;
  const what = rent > 0n ? `the network fee ${sol(fee)} + ${sol(rent)} rent for the receiver's token account (it has none yet)` : `the network fee ${sol(fee)}`;
  if (have < need) return `the test wallet holds ${sol(have)} - a token send needs ${sol(need)}: ${what}`;
  const afterFee = have - fee;
  if (afterFee > 0n && afterFee < floor) return `after the network fee the test wallet would hold ${sol(afterFee)}, below Solana's rent-exempt minimum ${sol(floor)} - the network refuses that`;
  const left = have - need;
  if (left > 0n && left < floor) {
    return `the token send would leave ${sol(left)} in the test wallet, below Solana's rent-exempt minimum ${sol(floor)} (the network refuses that) - hold exactly ${sol(need)} or at least ${sol(need + floor)}`;
  }
  return null;
}

// ---------------------------------------------------------------- mints

interface MintInfo {
  mint: PublicKey;
  programId: PublicKey;
  decimals: number;
  /** Size of an associated token account for this mint (Token-2022 adds the mint's account extensions + ImmutableOwner). */
  ataLen: number;
  cuLimit: number;
}

function mintInfo(coin: NativeCoin, mint: PublicKey, info: Acct | null): MintInfo {
  if (!info) throw new Error(`the ${coin.symbol} mint ${mint.toBase58()} does not exist on Solana`);
  if (!TOKEN_PROGRAMS.has(info.owner)) throw new Error(`${mint.toBase58()} is not a token mint (owned by ${info.owner})`);
  const programId = new PublicKey(info.owner);
  let m: Mint;
  try {
    m = unpackMint(mint, web3Info(info), programId);
  } catch (e) {
    throw new Error(`${mint.toBase58()} is not a readable ${coin.symbol} mint (${e instanceof Error ? e.name || e.message : String(e)})`);
  }
  if (!m.isInitialized) throw new Error(`the ${coin.symbol} mint ${mint.toBase58()} is not initialised`);
  if (m.decimals !== coin.decimals) throw new Error(`the ${coin.symbol} mint has ${m.decimals} decimals on Solana, the coin says ${coin.decimals} - refused`);
  const classic = programId.equals(TOKEN_PROGRAM_ID);
  if (!classic) {
    const fee = getTransferFeeConfig(m);
    if (fee && (fee.olderTransferFee.transferFeeBasisPoints > 0 || fee.newerTransferFee.transferFeeBasisPoints > 0)) {
      throw new Error(`the ${coin.symbol} mint charges a transfer fee - the receiver would get less than sent; refused`);
    }
    const hook = getTransferHook(m);
    if (hook && !hook.programId.equals(PublicKey.default)) throw new Error(`the ${coin.symbol} mint runs a transfer-hook program on every transfer - not supported; refused`);
    if (getNonTransferable(m)) throw new Error(`the ${coin.symbol} mint is non-transferable`);
    if (getPausableConfig(m)?.paused) throw new Error(`the ${coin.symbol} mint is paused - no transfers right now`);
  }
  const accountExts = [...new Set(getExtensionTypes(m.tlvData).map(getAccountTypeOfMintType))].filter((e) => e !== ExtensionType.Uninitialized);
  const ataLen = classic ? getAccountLen([]) : getAccountLen([...accountExts.filter((e) => e !== ExtensionType.ImmutableOwner), ExtensionType.ImmutableOwner]);
  return { mint, programId, decimals: m.decimals, ataLen, cuLimit: classic ? CU_LIMIT.token : CU_LIMIT.token2022 };
}

/** Both possible associated token accounts of `owner` (classic, Token-2022): the mint's program picks one after the read. */
function bothAtas(mint: PublicKey, owner: PublicKey): [PublicKey, PublicKey] {
  return [getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID), getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID)];
}

function tokenAccount(address: PublicKey, info: Acct, m: MintInfo, owner: PublicKey, whose: string): TokenAccount {
  let a: TokenAccount;
  try {
    a = unpackAccount(address, web3Info(info), m.programId);
  } catch (e) {
    throw new Error(`${whose} token account ${address.toBase58()} is not readable (${e instanceof Error ? e.name || e.message : String(e)})`);
  }
  if (!a.mint.equals(m.mint) || !a.owner.equals(owner)) throw new Error(`${whose} token account ${address.toBase58()} is not ${owner.toBase58()}'s account for ${m.mint.toBase58()}`);
  if (!a.isInitialized) throw new Error(`${whose} token account ${address.toBase58()} is not initialised`);
  if (a.isFrozen) throw new Error(`${whose} token account ${address.toBase58()} is frozen - no transfers`);
  return a;
}

const nativeCoin = (coin: NativeCoin): boolean => {
  if (coin.native) {
    if (coin.token) throw new Error(`${coin.symbol}: a native coin has no mint`);
    if (coin.decimals !== 9) throw new Error(`SOL has 9 decimals on Solana, the coin says ${coin.decimals}`);
    return true;
  }
  if (!coin.token) throw new Error(`${coin.symbol} on Solana: no mint given`);
  return false;
};

// ---------------------------------------------------------------- building

export type TransferSpec =
  | { kind: 'sol'; from: PublicKey; to: PublicKey; amount: bigint }
  | { kind: 'token'; from: PublicKey; to: PublicKey; amount: bigint; mint: PublicKey; programId: PublicKey; decimals: number; cuLimit: number };

/** The instructions of one transfer: compute budget, then a system transfer - or the receiver's ATA (idempotent) + transferChecked. */
export function transferInstructions(s: TransferSpec): TransactionInstruction[] {
  const budget = (limit: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS })];
  if (s.kind === 'sol') return [...budget(CU_LIMIT.sol), SystemProgram.transfer({ fromPubkey: s.from, toPubkey: s.to, lamports: s.amount })];
  const source = getAssociatedTokenAddressSync(s.mint, s.from, false, s.programId);
  const dest = getAssociatedTokenAddressSync(s.mint, s.to, false, s.programId);
  return [
    ...budget(s.cuLimit),
    createAssociatedTokenAccountIdempotentInstruction(s.from, dest, s.to, s.mint, s.programId),
    createTransferCheckedInstruction(source, s.mint, dest, s.from, s.amount, s.decimals, [], s.programId),
  ];
}

/** A signed legacy transaction (the payer is the only signer). */
export function signedTransfer(payer: Keypair, s: TransferSpec, blockhash: string): VersionedTransaction {
  if (!s.from.equals(payer.publicKey)) throw new Error('the sender must be the signing key');
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: transferInstructions(s) }).compileToLegacyMessage();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** The node's own fee for the message must be the one this module computed (it is what 'max' and the checks used). */
async function checkFee(tx: VersionedTransaction, fee: bigint): Promise<void> {
  const r = await rpc<{ value?: unknown }>('getFeeForMessage', [b64(tx.message.serialize()), { commitment: COMMITMENT }]);
  const v = isObj(r) ? r.value : null;
  if (v == null) throw new Error('the Solana node could not price the transaction (its blockhash is unknown to it) - try again');
  const nodeFee = big(v, 'fee');
  if (nodeFee !== fee) throw new Error(`the Solana node prices the transaction at ${sol(nodeFee)}, this module at ${sol(fee)} - refused`);
}

/** Dry run of the signed transaction (signatures checked); throws the network's words when it would fail. */
async function simulate(tx: VersionedTransaction): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const r = await rpc<{ value?: { err?: unknown; logs?: unknown } }>('simulateTransaction', [b64(tx.serialize()), { encoding: 'base64', sigVerify: true, commitment: COMMITMENT }]);
    const v = isObj(r) && isObj(r.value) ? r.value : null;
    if (!v) throw new Error('Solana simulateTransaction: unexpected answer');
    if (v.err == null) return;
    if (v.err === 'BlockhashNotFound' && attempt < 1) {
      await new Promise((ok) => setTimeout(ok, 1_500));
      continue;
    }
    const logs = Array.isArray(v.logs) ? v.logs.filter((l): l is string => typeof l === 'string').slice(-4) : [];
    throw new Error(`the network's dry run of the transaction fails: ${typeof v.err === 'string' ? v.err : JSON.stringify(v.err, bigintSafe)}${logs.length ? ` - logs: ${logs.join(' | ')}` : ''}`);
  }
}

/** Last valid block heights of the transactions `prepare` built in this process (for `confirmed`'s expiry rule). */
const expiries = new Map<string, bigint>();

const keypair = (keys: NativeKeys): Keypair => Keypair.fromSeed(keys.ed25519('solana'));

const READ_METHODS = new Set(['simulateTransaction', 'isBlockhashValid', 'minimumLedgerSlot']);
const isReadMethod = (m: string): boolean => /^get[A-Z]/.test(m) || READ_METHODS.has(m);

// ---------------------------------------------------------------- the chain

export const solana: NativeChain = {
  kind: 'solana',
  label: 'Solana',
  chainKey: 'SOL',
  origins: SOLANA_RPC,

  /** A POST whose JSON-RPC method (any of a batch) is not a read - sendTransaction, requestAirdrop, ... An unreadable POST body counts as a write. */
  isWrite(_url: URL, method: string, body: string | null): boolean {
    if (method.toUpperCase() !== 'POST') return false;
    let calls: unknown[];
    try {
      const j: unknown = JSON.parse(body ?? '');
      calls = Array.isArray(j) ? j : [j];
    } catch {
      return true;
    }
    if (calls.length === 0) return true;
    return calls.some((c) => !isObj(c) || typeof c.method !== 'string' || !isReadMethod(c.method));
  },

  address(keys: NativeKeys): string {
    return keypair(keys).publicKey.toBase58();
  },

  async balance(address: string, coin: NativeCoin): Promise<bigint> {
    const owner = pubkey(address, 'the address');
    if (nativeCoin(coin)) {
      const r = await rpc<{ value?: unknown }>('getBalance', [owner.toBase58(), { commitment: COMMITMENT }]);
      return big(isObj(r) ? r.value : undefined, 'balance');
    }
    const mint = pubkey(coin.token as string, `the ${coin.symbol} mint`);
    const [ataClassic, ata2022] = bothAtas(mint, owner);
    const [mintAcct, aClassic, a2022] = await accounts([mint, ataClassic, ata2022]);
    const m = mintInfo(coin, mint, mintAcct ?? null);
    const classic = m.programId.equals(TOKEN_PROGRAM_ID);
    const ata = classic ? ataClassic : ata2022;
    const info = (classic ? aClassic : a2022) ?? null;
    if (!info) return 0n;
    return tokenAccount(ata, info, m, owner, 'the').amount;
  },

  async costs(_address: string, coin: NativeCoin, to: string): Promise<SendCosts> {
    if (nativeCoin(coin)) return { fee: feeFor(CU_LIMIT.sol), keep: 0n, nativeNeeded: 0n };
    const mint = pubkey(coin.token as string, `the ${coin.symbol} mint`);
    const toKey = pubkey(to, 'the receiver');
    if (!PublicKey.isOnCurve(toKey.toBytes())) throw new Error(receiverProblem(toKey, null) ?? 'the receiver is not a wallet');
    const [dClassic, d2022] = bothAtas(mint, toKey);
    const [mintAcct, dAcctClassic, dAcct2022] = await accounts([mint, dClassic, d2022]);
    const m = mintInfo(coin, mint, mintAcct ?? null);
    const classic = m.programId.equals(TOKEN_PROGRAM_ID);
    const destExists = !!(classic ? dAcctClassic : dAcct2022);
    const fee = feeFor(m.cuLimit);
    const rent = destExists ? 0n : await rentExempt(m.ataLen);
    return { fee, keep: 0n, nativeNeeded: fee + rent };
  },

  async prepare(keys: NativeKeys, coin: NativeCoin, to: string, amount: bigint | 'max'): Promise<PreparedSend> {
    const kp = keypair(keys);
    const from = kp.publicKey;
    const toKey = pubkey(to, 'the receiver');
    if (toKey.equals(from)) throw new Error('the receiver is the test wallet itself - refused');
    if (amount !== 'max' && amount <= 0n) throw new Error('the amount must be above 0');
    const isSol = nativeCoin(coin);
    const offCurve = receiverProblem(toKey, null);
    if (offCurve) throw new Error(offCurve);

    let spec: TransferSpec;
    let fee: bigint;
    let rent = 0n;
    if (isSol) {
      const [payerAcct, toAcct] = await accounts([from, toKey]);
      const problem = payerProblem(payerAcct ?? null) ?? receiverProblem(toKey, toAcct ?? null);
      if (problem) throw new Error(problem);
      fee = feeFor(CU_LIMIT.sol);
      const floor = await rentExempt(0);
      const send = solAmount(payerAcct?.lamports ?? 0n, fee, floor, toAcct?.lamports ?? 0n, amount);
      spec = { kind: 'sol', from, to: toKey, amount: send };
    } else {
      const mint = pubkey(coin.token as string, `the ${coin.symbol} mint`);
      const [sClassic, s2022] = bothAtas(mint, from);
      const [dClassic, d2022] = bothAtas(mint, toKey);
      const [payerAcct, toAcct, mintAcct, sAcctC, sAcct22, dAcctC, dAcct22] = await accounts([from, toKey, mint, sClassic, s2022, dClassic, d2022]);
      const problem = payerProblem(payerAcct ?? null) ?? receiverProblem(toKey, toAcct ?? null);
      if (problem) throw new Error(problem);
      const m = mintInfo(coin, mint, mintAcct ?? null);
      const classic = m.programId.equals(TOKEN_PROGRAM_ID);
      const [srcAddr, srcInfo, dstAddr, dstInfo] = classic ? [sClassic, sAcctC, dClassic, dAcctC] : [s2022, sAcct22, d2022, dAcct22];
      if (!srcInfo) throw new Error(`the test wallet holds no ${coin.symbol} on Solana`);
      const held = tokenAccount(srcAddr, srcInfo, m, from, "the test wallet's").amount;
      const send = amount === 'max' ? held : amount;
      if (send <= 0n) throw new Error(`the test wallet holds no ${coin.symbol} on Solana`);
      if (send > U64_MAX) throw new Error('the amount is too large');
      if (send > held) throw new Error(`the test wallet holds ${units(held, m.decimals)} ${coin.symbol} on Solana, not ${units(send, m.decimals)}`);
      if (dstInfo) tokenAccount(dstAddr, dstInfo, m, toKey, "the receiver's");
      fee = feeFor(m.cuLimit);
      const [floor, ataRent] = await Promise.all([rentExempt(0), dstInfo ? Promise.resolve(0n) : rentExempt(m.ataLen)]);
      rent = ataRent;
      const solProblem = tokenSolProblem(payerAcct?.lamports ?? 0n, fee, rent, floor);
      if (solProblem) throw new Error(solProblem);
      spec = { kind: 'token', from, to: toKey, amount: send, mint, programId: m.programId, decimals: m.decimals, cuLimit: m.cuLimit };
    }

    const { blockhash, lastValidBlockHeight } = await latestBlockhash();
    const tx = signedTransfer(kp, spec, blockhash);
    await checkFee(tx, fee);
    await simulate(tx);
    const signature = tx.signatures[0];
    if (!signature) throw new Error('the transaction is not signed');
    const txid = base58(signature);
    expiries.set(txid, lastValidBlockHeight);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64(tx.serialize()), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }] });
    const prepared: PreparedSend & { rent: bigint } = {
      request: { url: SEND_URL, method: 'POST', headers: { ...JSON_HEADERS }, body },
      txid,
      amount: spec.amount,
      fee,
      /** Lamports the send also moves into the receiver's new token account (0 for SOL / when it exists): not a fee, but SOL that leaves the test wallet. */
      rent,
      explorer: `https://solscan.io/tx/${txid}`,
    };
    return prepared;
  },

  async broadcast(p: PreparedSend): Promise<string> {
    if (!(SOLANA_RPC as readonly string[]).includes(new URL(p.request.url).origin)) throw new Error(`refused: ${p.request.url} is not one of the Solana nodes`);
    let status: number;
    let text: string;
    try {
      const res = await globalThis.fetch(p.request.url, { method: p.request.method, headers: p.request.headers, body: p.request.body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      status = res.status;
      text = await res.text();
    } catch (e) {
      throw new Error(`the Solana node did not answer the send (${e instanceof Error ? e.message : String(e)}) - it may still have gone out: check ${p.explorer}`);
    }
    let json: unknown = null;
    try {
      json = parseJson(text);
    } catch {
      /* below */
    }
    if (isObj(json) && isObj(json.error)) throw new Error(`the Solana node refused the transaction: ${describeRpcError(json.error as RpcErrorBody)}`);
    if (!isObj(json) || typeof json.result !== 'string') throw new Error(`the Solana node gave no readable answer to the send (HTTP ${status}: ${text.slice(0, 200)}) - it may still have gone out: check ${p.explorer}`);
    if (json.result !== p.txid) throw new Error(`the Solana node answered signature ${json.result}, but the transaction's is ${p.txid} - it may still have gone out: check ${p.explorer}`);
    return p.txid;
  },

  async confirmed(txid: string): Promise<boolean | null> {
    const status = async (): Promise<Record<string, unknown> | null> => {
      const r = await rpc<{ value?: unknown }>('getSignatureStatuses', [[txid], { searchTransactionHistory: true }]);
      if (!isObj(r) || !Array.isArray(r.value)) throw new Error('Solana getSignatureStatuses: unexpected answer');
      const s: unknown = r.value[0];
      return isObj(s) ? s : null;
    };
    const verdict = (s: Record<string, unknown>): boolean | null =>
      s.err != null ? false : s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? true : null;
    const s = await status();
    if (s) return verdict(s);
    const lastValid = expiries.get(txid);
    if (lastValid === undefined) return null;
    const height = big(await rpc('getBlockHeight', [{ commitment: 'finalized' }]), 'block height');
    if (height <= lastValid + EXPIRY_MARGIN_BLOCKS) return null;
    // Expired for good: look once more (after the height read), then it can never land.
    const again = await status();
    return again ? verdict(again) : false;
  },
};

/** The rent-exempt minimum of a wallet (0 data bytes), lamports: a Solana wallet holds 0 or at least this. */
export const solanaWalletRentFloor = (): Promise<bigint> => rentExempt(0);
