/**
 * The Solana module (solana.ts), offline: a fake fetch answers JSON-RPC in the shapes
 * api.mainnet-beta.solana.com answered on 2026-10-03 (apiVersion 4.3.0; rent-exempt
 * minimum (128 + bytes) x 5 080 lamports: 650 240 for a wallet, 1 488 440 for a token account).
 * Nothing here sends anything or uses a real key. The last test is a READ-ONLY dry run
 * (simulateTransaction) on mainnet of transfers signed by an unfunded throwaway key; it runs
 * only with LIVE_SOLANA_SIM=1.
 *   npx tsx --test e2e/live/native/solana.test.ts                       (from apps/web)
 *   LIVE_SOLANA_SIM=1 npx tsx --test e2e/live/native/solana.test.ts     (+ the live dry run)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  AccountState,
  AccountType,
  ExtensionType,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_FEE_CONFIG_SIZE,
  TransferFeeConfigLayout,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { addressProblem, base58Decode, base58Encode } from '../../../src/trading/addresses';
import { deriveEd25519Seed, nativeKeysFromHex } from './keys';
import { CU_LIMIT, SOLANA_RPC, feeFor, signedTransfer, solana } from './solana';
import type { NativeCoin, NativeKeys, PreparedSend } from './types';

/** A fixed TEST key (never funded, never used anywhere real). */
const TEST_KEY = '0x960432fcfc1e617ca8913deca2b0d21475a66abbdf09c17caf72f583d0d92fc3';
const KEYS = nativeKeysFromHex(TEST_KEY);
const ME = 'BYVqTJ8FJEP7Z5UzFhzsL4GM21BaTZ1AHyfRx3721PU4';
/** SoDEX's Solana deposit address of the runner's wallet (registry, 2026-10-03): unused on chain, no token accounts. */
const DEPOSIT = 'cVHMaRhhCzs35we2zAbM5shjnf1pazPNSafJN5N6eaq';
/** Its USDC associated token account (off the curve). */
const DEPOSIT_USDC_ATA = '83XQTKc23PYkp5UuZQqQPWte6babbN3igj9gACitTWqG';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
/** USDC's mint account as getAccountInfo returned it (base64, 82 bytes, Token program). */
const USDC_MINT_DATA = 'AQAAAJj+huiNm+Lqi8HMpIeLKYjCQPUrhCS/tA7Rot3LXhmbAX+YWnLhHQAGAQEAAABicKqKWcWUBbRShshncubNEm6bil06OFNtN/e0FOi2Zw==';
const BLOCKHASH = 'CnDohv45pDWbQPva3NEifimcXmVkSnKpgK6mbnAj5n62';
const LAST_VALID = 431021876;

const SOL: NativeCoin = { symbol: 'SOL', native: true, token: null, decimals: 9 };
const USDC: NativeCoin = { symbol: 'USDC', native: false, token: USDC_MINT, decimals: 6 };
const USDT: NativeCoin = { symbol: 'USDT', native: false, token: USDT_MINT, decimals: 6 };

const SYSTEM = SystemProgram.programId.toBase58();
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58();
const rent = (bytes: number) => (128 + bytes) * 5_080;
const FLOOR = rent(0); // 650 240
const SOL_FEE = 6_000n; // 5 000 + 2 000 CU x 0.5 lamport
const TOKEN_FEE = 25_000n; // 5 000 + 40 000 CU x 0.5 lamport

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- a fake Solana node: JSON-RPC answers in the recorded shapes ------------------------------------

interface FakeAcct { owner: string; lamports: number; data?: Buffer; executable?: boolean }
interface World {
  accounts: Record<string, FakeAcct>;
  /** getFeeForMessage's answer (default: computed from the message's compute-budget instructions). */
  fee?: number | null;
  /** simulateTransaction's err (default null). */
  simErr?: unknown;
  statuses?: Record<string, Record<string, unknown> | null>;
  height?: number;
  /** Origins that answer HTTP 429 (as api.mainnet-beta.solana.com does for a hot method). */
  limited?: string[];
  send?: { result?: string; error?: Record<string, unknown> };
}
interface Call { url: string; method: string; body: string; rpc: { method: string; params: unknown[] } }

const ctx = { apiVersion: '4.3.0', slot: 452983160 };
const accountJson = (a: FakeAcct | undefined) =>
  a ? { data: [(a.data ?? Buffer.alloc(0)).toString('base64'), 'base64'], executable: a.executable ?? false, lamports: a.lamports, owner: a.owner, rentEpoch: 18446744073709552000, space: (a.data ?? Buffer.alloc(0)).length } : null;

/** The fee the runtime charges for a message: 5 000 per signature + ceil(limit x price / 1e6). */
function feeOfMessage(bytes: Uint8Array): number {
  const msg = VersionedMessage.deserialize(bytes);
  const ixs = TransactionMessage.decompile(msg).instructions;
  let limit = 200_000;
  let price = 0n;
  for (const ix of ixs) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    const kind = ComputeBudgetInstruction.decodeInstructionType(ix);
    if (kind === 'SetComputeUnitLimit') limit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
    if (kind === 'SetComputeUnitPrice') price = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
  }
  return 5_000 * msg.header.numRequiredSignatures + Number((BigInt(limit) * price + 999_999n) / 1_000_000n);
}

function verifies(tx: VersionedTransaction): boolean {
  const msg = tx.message.serialize();
  return tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).every((k, i) => {
    const sig = tx.signatures[i];
    return !!sig && ed25519.verify(sig, msg, k.toBytes());
  });
}

function install(w: World): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body);
    const rpc = JSON.parse(body) as Call['rpc'];
    calls.push({ url, method: init?.method ?? 'GET', body, rpc });
    if (w.limited?.includes(new URL(url).origin)) {
      return new Response('{"jsonrpc":"2.0","error":{"code": 429,"message":"Too many requests for a specific RPC call"}, "id": 1 }', { status: 429 });
    }
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', result, id: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    const p = rpc.params;
    switch (rpc.method) {
      case 'getBalance':
        return ok({ context: ctx, value: w.accounts[p[0] as string]?.lamports ?? 0 });
      case 'getAccountInfo':
        return ok({ context: ctx, value: accountJson(w.accounts[p[0] as string]) });
      case 'getMultipleAccounts':
        return ok({ context: ctx, value: (p[0] as string[]).map((k) => accountJson(w.accounts[k])) });
      case 'getMinimumBalanceForRentExemption':
        return ok(rent(p[0] as number));
      case 'getLatestBlockhash':
        return ok({ context: ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID } });
      case 'getFeeForMessage':
        return ok({ context: ctx, value: w.fee !== undefined ? w.fee : feeOfMessage(Buffer.from(p[0] as string, 'base64')) });
      case 'simulateTransaction': {
        const tx = VersionedTransaction.deserialize(Buffer.from(p[0] as string, 'base64'));
        if (!verifies(tx)) return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32003, message: 'Transaction signature verification failure' }, id: 1 }));
        return ok({ context: ctx, value: { err: w.simErr ?? null, logs: w.simErr ? ['Program 11111111111111111111111111111111 invoke [1]', 'Transfer: insufficient lamports 1, need 2'] : [], accounts: null, unitsConsumed: 450, returnData: null } });
      }
      case 'getSignatureStatuses':
        return ok({ context: ctx, value: (p[0] as string[]).map((s) => w.statuses?.[s] ?? null) });
      case 'getBlockHeight':
        return ok(w.height ?? LAST_VALID - 100);
      case 'sendTransaction':
        if (w.send?.error) return new Response(JSON.stringify({ jsonrpc: '2.0', error: w.send.error, id: 1 }));
        return ok(w.send?.result);
      default:
        throw new Error(`fake node: no ${rpc.method}`);
    }
  }) as typeof fetch;
  return calls;
}

// --- account data ------------------------------------------------------------------------------------

function mintData(decimals: number): Buffer {
  const b = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 10n ** 15n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, b);
  return b;
}

/** A Token-2022 mint carrying a TransferFeeConfig extension. */
function mintDataWithTransferFee(decimals: number, bps: number): Buffer {
  const b = Buffer.alloc(ACCOUNT_SIZE + 1 + 4 + TRANSFER_FEE_CONFIG_SIZE);
  mintData(decimals).copy(b, 0);
  b[ACCOUNT_SIZE] = AccountType.Mint;
  b.writeUInt16LE(ExtensionType.TransferFeeConfig, ACCOUNT_SIZE + 1);
  b.writeUInt16LE(TRANSFER_FEE_CONFIG_SIZE, ACCOUNT_SIZE + 3);
  const fee = { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: bps };
  TransferFeeConfigLayout.encode({ transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n, olderTransferFee: fee, newerTransferFee: fee }, b, ACCOUNT_SIZE + 5);
  return b;
}

function tokenData(mint: string, owner: string, amount: bigint, state = AccountState.Initialized): Buffer {
  const b = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    { mint: new PublicKey(mint), owner: new PublicKey(owner), amount, delegateOption: 0, delegate: PublicKey.default, state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default },
    b,
  );
  return b;
}

const ata = (mint: string, owner: string, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, program).toBase58();
const wallet = (lamports: number): FakeAcct => ({ owner: SYSTEM, lamports });
const usdcMint = (): FakeAcct => ({ owner: TOKEN, lamports: 535328983427, data: Buffer.from(USDC_MINT_DATA, 'base64') });
const tokenAcct = (mint: string, owner: string, amount: bigint, program = TOKEN, state?: AccountState): FakeAcct => ({ owner: program, lamports: 2_039_280, data: tokenData(mint, owner, amount, state) });

// --- reading a prepared send back ----------------------------------------------------------------------

interface Decoded { tx: VersionedTransaction; ixs: TransactionInstruction[]; body: { jsonrpc: string; id: number; method: string; params: [string, Record<string, unknown>] } }

function decode(p: PreparedSend): Decoded {
  const body = JSON.parse(p.request.body) as Decoded['body'];
  const raw = Buffer.from(body.params[0], 'base64');
  const tx = VersionedTransaction.deserialize(raw);
  // The legacy decoder reads the same bytes the same way.
  const legacy = Transaction.from(raw);
  assert.equal(legacy.feePayer?.toBase58(), ME);
  assert.ok(legacy.verifySignatures(), 'legacy decoder: signatures verify');
  return { tx, ixs: TransactionMessage.decompile(tx.message).instructions, body };
}

function assertEnvelope(p: PreparedSend, d: Decoded, cuLimit: number) {
  assert.equal(p.request.url, 'https://api.mainnet-beta.solana.com');
  assert.equal(p.request.method, 'POST');
  assert.deepEqual(p.request.headers, { 'content-type': 'application/json' });
  // The exact body, byte for byte.
  assert.equal(p.request.body, `{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":["${d.body.params[0]}",{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed"}]}`);
  assert.equal(d.tx.version, 'legacy');
  assert.equal(d.tx.message.recentBlockhash, BLOCKHASH);
  assert.equal(d.tx.message.header.numRequiredSignatures, 1);
  assert.equal(d.tx.message.staticAccountKeys[0]?.toBase58(), ME, 'fee payer = the test wallet');
  const sig = d.tx.signatures[0];
  assert.ok(sig && ed25519.verify(sig, d.tx.message.serialize(), base58Decode(ME) as Uint8Array), 'the signature verifies against the test wallet (noble ed25519)');
  assert.equal(p.txid, base58Encode(sig), 'txid = the first signature, base58');
  assert.deepEqual(base58Decode(p.txid), Uint8Array.from(sig));
  assert.equal(p.explorer, `https://solscan.io/tx/${p.txid}`);
  const [limit, price] = d.ixs;
  assert.ok(limit && price);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit).units, cuLimit);
  assert.equal(BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(price).microLamports), 500_000n);
}

/** Every call `prepare` made was a read (the guard's view): no sendTransaction. */
function onlyReads(calls: Call[]) {
  for (const c of calls) assert.equal(solana.isWrite(new URL(c.url), c.method, c.body), false, `${c.rpc.method} is a read`);
  assert.ok(!calls.some((c) => c.rpc.method === 'sendTransaction'));
}

// --- tests -----------------------------------------------------------------------------------------------

test('identity: kind, chain key, label, origins', () => {
  assert.equal(solana.kind, 'solana');
  assert.equal(solana.chainKey, 'SOL');
  assert.equal(solana.label, 'Solana');
  assert.deepEqual([...solana.origins], ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']);
  assert.deepEqual(solana.origins, SOLANA_RPC);
  for (const o of solana.origins) assert.equal(new URL(o).origin, o);
});

test('address: deterministic from the test key (HKDF seed -> ed25519), base58 of 32 bytes, the app accepts it', () => {
  assert.equal(solana.address(KEYS), ME);
  assert.equal(solana.address(nativeKeysFromHex(TEST_KEY)), ME);
  assert.equal(addressProblem('solana', ME), null);
  const seed = deriveEd25519Seed(Buffer.from(TEST_KEY.slice(2), 'hex'), 'solana');
  assert.equal(base58Encode(ed25519.getPublicKey(seed)), ME, 'noble ed25519 of the derived seed');
  assert.notEqual(solana.address(nativeKeysFromHex(`0x${'11'.repeat(32)}`)), ME);
});

test('isWrite: sendTransaction / requestAirdrop / anything unknown or unreadable is a write; get* and simulate are reads', () => {
  const u = new URL('https://api.mainnet-beta.solana.com');
  const post = (o: unknown) => solana.isWrite(u, 'POST', JSON.stringify(o));
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['AA=='] }), true);
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [ME, 1] }), true);
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [] }), true);
  assert.equal(post([{ method: 'getBalance' }, { method: 'sendTransaction' }]), true, 'a batch with one send');
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [ME] }), false);
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [[ME]] }), false);
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [['x']] }), false);
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: ['AA=='] }), false);
  assert.equal(post([{ method: 'getBalance' }, { method: 'getLatestBlockhash' }]), false);
  assert.equal(solana.isWrite(u, 'POST', 'not json'), true, 'unreadable POST: fail closed');
  assert.equal(solana.isWrite(u, 'POST', null), true);
  assert.equal(post([]), true);
  assert.equal(post({ id: 1 }), true, 'no method');
  assert.equal(solana.isWrite(u, 'GET', null), false);
  assert.equal(post({ method: 'getbalance' }), true, 'not a known read');
});

test('balance: SOL lamports; a token = the owner\'s associated token account (0 when it or the wallet is unknown)', async () => {
  install({ accounts: { [ME]: wallet(123_456_789), [USDC_MINT]: usdcMint(), [ata(USDC_MINT, ME)]: tokenAcct(USDC_MINT, ME, 7_250_000n) } });
  assert.equal(await solana.balance(ME, SOL), 123_456_789n);
  assert.equal(await solana.balance(DEPOSIT, SOL), 0n);
  assert.equal(await solana.balance(ME, USDC), 7_250_000n);
  assert.equal(await solana.balance(DEPOSIT, USDC), 0n);
  await assert.rejects(solana.balance(ME, USDT), /USDT mint .* does not exist/);
  await assert.rejects(solana.balance(ME, { ...USDC, decimals: 9 }), /6 decimals on Solana, the coin says 9/);
  await assert.rejects(solana.balance('0xabc', SOL), /not a Solana address/);
});

test('balance: integers beyond 2^53 stay exact', async () => {
  install({ accounts: {} });
  globalThis.fetch = (async () => new Response('{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.0","slot":452985043},"value":10572651977324436},"id":1}')) as typeof fetch;
  assert.equal(await solana.balance(ME, SOL), 10_572_651_977_324_436n);
});

test('costs: SOL fee 6 000 lamports, nothing kept; a token send needs fee + the receiver\'s token-account rent when it is missing', async () => {
  assert.equal(feeFor(CU_LIMIT.sol), SOL_FEE);
  assert.equal(feeFor(CU_LIMIT.token), TOKEN_FEE);
  assert.equal(feeFor(CU_LIMIT.token2022), 55_000n);
  install({ accounts: { [USDC_MINT]: usdcMint(), [USDT_MINT]: { ...usdcMint() }, [ata(USDT_MINT, DEPOSIT)]: tokenAcct(USDT_MINT, DEPOSIT, 0n) } });
  assert.deepEqual(await solana.costs(ME, SOL, DEPOSIT), { fee: SOL_FEE, keep: 0n, nativeNeeded: 0n });
  assert.deepEqual(await solana.costs(ME, USDC, DEPOSIT), { fee: TOKEN_FEE, keep: 0n, nativeNeeded: TOKEN_FEE + 1_488_440n });
  assert.deepEqual(await solana.costs(ME, USDT, DEPOSIT), { fee: TOKEN_FEE, keep: 0n, nativeNeeded: TOKEN_FEE });
  await assert.rejects(solana.costs(ME, USDC, DEPOSIT_USDC_ATA), /not a wallet address/);
});

test('prepare SOL: one system transfer of the amount to the deposit address, signed, the exact sendTransaction body; nothing sent', async () => {
  const calls = install({ accounts: { [ME]: wallet(50_000_000) } });
  const p = await solana.prepare(KEYS, SOL, DEPOSIT, 31_000_000n);
  const d = decode(p);
  assertEnvelope(p, d, CU_LIMIT.sol);
  assert.equal(d.ixs.length, 3);
  const t = d.ixs[2] as TransactionInstruction;
  assert.ok(t.programId.equals(SystemProgram.programId));
  assert.equal(SystemInstruction.decodeInstructionType(t), 'Transfer');
  const x = SystemInstruction.decodeTransfer(t);
  assert.equal(x.fromPubkey.toBase58(), ME);
  assert.equal(x.toPubkey.toBase58(), DEPOSIT);
  assert.equal(BigInt(x.lamports), 31_000_000n);
  assert.equal(p.amount, 31_000_000n);
  assert.equal(p.fee, SOL_FEE);
  assert.equal(feeOfMessage(d.tx.message.serialize()), Number(SOL_FEE));
  onlyReads(calls);
  assert.ok(calls.some((c) => c.rpc.method === 'simulateTransaction'), 'dry run before it is handed back');
  assert.ok(calls.some((c) => c.rpc.method === 'getFeeForMessage'));
  // Same inputs, same bytes (ed25519 is deterministic).
  install({ accounts: { [ME]: wallet(50_000_000) } });
  assert.equal((await solana.prepare(KEYS, SOL, DEPOSIT, 31_000_000n)).request.body, p.request.body);
});

test("prepare SOL 'max': everything minus the fee leaves, the wallet ends at exactly 0", async () => {
  install({ accounts: { [ME]: wallet(50_000_000) } });
  const p = await solana.prepare(KEYS, SOL, DEPOSIT, 'max');
  const x = SystemInstruction.decodeTransfer(decode(p).ixs[2] as TransactionInstruction);
  assert.equal(BigInt(x.lamports), 50_000_000n - SOL_FEE);
  assert.equal(p.amount + p.fee, 50_000_000n);
});

test('prepare SOL refuses (plain reasons): empty, too little, dust left below rent, receiver below rent, bad receivers, failed dry run, fee mismatch', async () => {
  const refuse = async (w: World, amount: bigint | 'max', re: RegExp, to = DEPOSIT) => {
    const calls = install(w);
    await assert.rejects(solana.prepare(KEYS, SOL, to, amount), re);
    assert.ok(!calls.some((c) => c.rpc.method === 'sendTransaction'));
  };
  await refuse({ accounts: {} }, 'max', /holds 0 SOL - not even the network fee of 0.000006 SOL/);
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, 10_000_000n, /holds 0.01 SOL - not 0.01 SOL plus the network fee/);
  // 'max' needs balance - fee >= the rent floor (the runtime checks the payer after the fee).
  await refuse({ accounts: { [ME]: wallet(FLOOR + 5_999) } }, 'max', /after the network fee .* below Solana's rent-exempt minimum 0.00065024 SOL/);
  // A remainder of 1 .. floor-1 lamports is refused, 0 or >= floor is fine.
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, 10_000_000n - 6_000n - 1n, /would leave 0.000000001 SOL .* send everything \('max'/);
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, 10_000_000n - 6_000n - BigInt(FLOOR) + 1n, /would leave 0.000650239 SOL/);
  install({ accounts: { [ME]: wallet(10_000_000) } });
  assert.equal((await solana.prepare(KEYS, SOL, DEPOSIT, 10_000_000n - 6_000n - BigInt(FLOOR))).amount, 10_000_000n - 6_000n - BigInt(FLOOR));
  // The unused deposit address must receive at least the floor.
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, 100_000n, /the receiver holds 0 SOL; 0.0001 SOL more stays below .* send at least 0.00065024 SOL/);
  install({ accounts: { [ME]: wallet(10_000_000), [DEPOSIT]: wallet(FLOOR) } });
  assert.equal((await solana.prepare(KEYS, SOL, DEPOSIT, 1n)).amount, 1n, 'a funded receiver takes any amount');
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, 0n, /above 0/);
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, -5n, /above 0/);
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, 1_000_000n, /the test wallet itself/, ME);
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, 1_000_000n, /not a Solana address/, '0x20856bb5cb2b473216ef5229c6ae0e8a61b58e85');
  await refuse({ accounts: { [ME]: wallet(10_000_000) } }, 1_000_000n, /not a wallet address \(off the ed25519 curve/, DEPOSIT_USDC_ATA);
  const keypairTokenAcct = Keypair.fromSeed(sha256('solana.test: an on-curve token account')).publicKey.toBase58();
  await refuse({ accounts: { [ME]: wallet(10_000_000), [keypairTokenAcct]: tokenAcct(USDC_MINT, DEPOSIT, 0n) } }, 1_000_000n, /is a token account, not a wallet/, keypairTokenAcct);
  await refuse({ accounts: { [ME]: wallet(10_000_000), [DEPOSIT]: { owner: 'Stake11111111111111111111111111111111111111', lamports: 5_000_000, data: Buffer.alloc(200) } } }, 1_000_000n, /account of program Stake1.* not a plain wallet/);
  await refuse({ accounts: { [ME]: wallet(10_000_000), [DEPOSIT]: { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', lamports: 5_000_000, executable: true } } }, 1_000_000n, /is a program/);
  await refuse({ accounts: { [ME]: wallet(10_000_000) }, simErr: { InstructionError: [2, { Custom: 1 }] } }, 1_000_000n, /dry run .* fails: \{"InstructionError":\[2,\{"Custom":1\}\]\} - logs: .*insufficient lamports/);
  await refuse({ accounts: { [ME]: wallet(10_000_000) }, fee: 11_000 }, 1_000_000n, /prices the transaction at 0.000011 SOL, this module at 0.000006 SOL/);
  await refuse({ accounts: { [ME]: wallet(10_000_000) }, fee: null }, 1_000_000n, /could not price/);
  await assert.rejects(solana.prepare(KEYS, { ...SOL, decimals: 8 }, DEPOSIT, 1_000_000n), /SOL has 9 decimals/);
});

test('prepare USDC: idempotent create of the receiver\'s token account (test wallet pays) + transferChecked from its own; signed; exact body', async () => {
  const myAta = ata(USDC_MINT, ME);
  const calls = install({ accounts: { [ME]: wallet(3_000_000), [USDC_MINT]: usdcMint(), [myAta]: tokenAcct(USDC_MINT, ME, 9_000_000n) } });
  const p = await solana.prepare(KEYS, USDC, DEPOSIT, 6_000_000n);
  const d = decode(p);
  assertEnvelope(p, d, CU_LIMIT.token);
  assert.equal(d.ixs.length, 4);
  const [, , create, transfer] = d.ixs as [TransactionInstruction, TransactionInstruction, TransactionInstruction, TransactionInstruction];
  // createAssociatedTokenAccountIdempotent: data [1]; payer, ata, owner, mint, system, token program.
  assert.ok(create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.deepEqual([...create.data], [1]);
  assert.deepEqual(create.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [ME, true, true],
    [DEPOSIT_USDC_ATA, false, true],
    [DEPOSIT, false, false],
    [USDC_MINT, false, false],
    [SYSTEM, false, false],
    [TOKEN, false, false],
  ]);
  const t = decodeTransferCheckedInstruction(transfer, TOKEN_PROGRAM_ID);
  assert.equal(t.keys.source.pubkey.toBase58(), myAta);
  assert.equal(t.keys.mint.pubkey.toBase58(), USDC_MINT);
  assert.equal(t.keys.destination.pubkey.toBase58(), DEPOSIT_USDC_ATA);
  assert.equal(t.keys.owner.pubkey.toBase58(), ME);
  assert.ok(t.keys.owner.isSigner);
  assert.equal(t.data.amount, 6_000_000n);
  assert.equal(t.data.decimals, 6);
  assert.equal(p.amount, 6_000_000n);
  assert.equal(p.fee, TOKEN_FEE);
  assert.equal((p as PreparedSend & { rent: bigint }).rent, 1_488_440n, 'the new token account\'s rent, paid by the test wallet');
  assert.equal(feeOfMessage(d.tx.message.serialize()), Number(TOKEN_FEE));
  onlyReads(calls);
});

test("prepare USDC 'max' = the whole token balance; USDT to a receiver that has its token account: no rent", async () => {
  const myAta = ata(USDC_MINT, ME);
  install({ accounts: { [ME]: wallet(3_000_000), [USDC_MINT]: usdcMint(), [myAta]: tokenAcct(USDC_MINT, ME, 9_123_456n) } });
  const p = await solana.prepare(KEYS, USDC, DEPOSIT, 'max');
  assert.equal(decodeTransferCheckedInstruction(decode(p).ixs[3] as TransactionInstruction).data.amount, 9_123_456n);
  assert.equal(p.amount, 9_123_456n);

  const usdtMint = { ...usdcMint() };
  // Exactly fee: the wallet ends at 0 lamports, which the runtime allows.
  install({ accounts: { [ME]: wallet(Number(TOKEN_FEE)), [USDT_MINT]: usdtMint, [ata(USDT_MINT, ME)]: tokenAcct(USDT_MINT, ME, 5_000_000n), [ata(USDT_MINT, DEPOSIT)]: tokenAcct(USDT_MINT, DEPOSIT, 1n) } });
  const q = await solana.prepare(KEYS, USDT, DEPOSIT, 'max');
  const t = decodeTransferCheckedInstruction(decode(q).ixs[3] as TransactionInstruction);
  assert.equal(t.keys.mint.pubkey.toBase58(), USDT_MINT);
  assert.equal(t.keys.destination.pubkey.toBase58(), ata(USDT_MINT, DEPOSIT));
  assert.equal(t.data.amount, 5_000_000n);
  assert.equal((q as PreparedSend & { rent: bigint }).rent, 0n);
});

test('prepare token refuses: SOL for fee/rent missing, a remainder below rent, no tokens, too few, wrong decimals, not a mint, frozen, bad receivers', async () => {
  const myAta = ata(USDC_MINT, ME);
  const base = (lamports: number, held = 9_000_000n, extra: Record<string, FakeAcct> = {}): World => ({
    accounts: { [ME]: wallet(lamports), [USDC_MINT]: usdcMint(), [myAta]: tokenAcct(USDC_MINT, ME, held), ...extra },
  });
  const refuse = async (w: World, amount: bigint | 'max', re: RegExp, to = DEPOSIT, coin = USDC) => {
    const calls = install(w);
    await assert.rejects(solana.prepare(KEYS, coin, to, amount), re);
    assert.ok(!calls.some((c) => c.rpc.method === 'sendTransaction'));
  };
  await refuse(base(0), 1_000_000n, /holds 0 SOL - a token send needs 0.00151344 SOL: the network fee 0.000025 SOL \+ 0.00148844 SOL rent/);
  await refuse(base(1_513_439), 1_000_000n, /holds 0.001513439 SOL - a token send needs 0.00151344 SOL/);
  await refuse(base(1_513_440 + 1), 1_000_000n, /would leave 0.000000001 SOL .* hold exactly 0.00151344 SOL or at least 0.00216368 SOL/);
  install(base(1_513_440));
  assert.equal((await solana.prepare(KEYS, USDC, DEPOSIT, 1_000_000n)).amount, 1_000_000n, 'exactly fee + rent: the wallet ends at 0');
  await refuse({ accounts: { [ME]: wallet(3_000_000), [USDC_MINT]: usdcMint() } }, 'max', /holds no USDC on Solana/);
  await refuse(base(3_000_000, 0n), 'max', /holds no USDC on Solana/);
  await refuse(base(3_000_000), 9_000_001n, /holds 9 USDC on Solana, not 9.000001/);
  await refuse(base(3_000_000), 1_000_000n, /6 decimals on Solana, the coin says 9/, DEPOSIT, { ...USDC, decimals: 9 });
  await refuse(base(3_000_000, 9_000_000n, { [USDC_MINT]: wallet(1) }), 1_000_000n, /is not a token mint/);
  await refuse({ accounts: { [ME]: wallet(3_000_000), [USDC_MINT]: usdcMint(), [myAta]: tokenAcct(USDC_MINT, ME, 9_000_000n, TOKEN, AccountState.Frozen) } }, 1_000_000n, /is frozen/);
  await refuse(base(3_000_000, 9_000_000n, { [DEPOSIT_USDC_ATA]: tokenAcct(USDC_MINT, DEPOSIT, 0n, TOKEN, AccountState.Frozen) }), 1_000_000n, /receiver's token account .* is frozen/);
  await refuse(base(3_000_000), 1_000_000n, /not a wallet address \(off the ed25519 curve/, DEPOSIT_USDC_ATA);
  await refuse(base(3_000_000), 1_000_000n, /no mint given/, DEPOSIT, { ...USDC, token: null });
});

test('prepare token: a dry-run failure is refused with the network\'s words', async () => {
  const myAta = ata(USDC_MINT, ME);
  install({ accounts: { [ME]: wallet(3_000_000), [USDC_MINT]: usdcMint(), [myAta]: tokenAcct(USDC_MINT, ME, 9_000_000n) }, simErr: 'AccountNotFound' });
  await assert.rejects(solana.prepare(KEYS, USDC, DEPOSIT, 1_000_000n), /dry run of the transaction fails: AccountNotFound/);
});

test('Token-2022: the mint\'s program drives the token accounts, instructions and fee; a transfer-fee mint is refused', async () => {
  const mint = Keypair.fromSeed(sha256('solana.test: a Token-2022 mint')).publicKey.toBase58();
  const coin: NativeCoin = { symbol: 'TST', native: false, token: mint, decimals: 6 };
  const myAta = ata(mint, ME, TOKEN_2022_PROGRAM_ID);
  const destAta = ata(mint, DEPOSIT, TOKEN_2022_PROGRAM_ID);
  assert.notEqual(myAta, ata(mint, ME));
  const world = (mintAcct: FakeAcct): World => ({ accounts: { [ME]: wallet(3_000_000), [mint]: mintAcct, [myAta]: tokenAcct(mint, ME, 4_000_000n, TOKEN22) } });
  install(world({ owner: TOKEN22, lamports: 1_461_600, data: mintData(6) }));
  assert.equal(await solana.balance(ME, coin), 4_000_000n);
  assert.deepEqual(await solana.costs(ME, coin, DEPOSIT), { fee: 55_000n, keep: 0n, nativeNeeded: 55_000n + BigInt(rent(170)) }, 'Token-2022 ATA: 165 + 1 + ImmutableOwner TLV = 170 bytes');
  const p = await solana.prepare(KEYS, coin, DEPOSIT, 'max');
  const d = decode(p);
  assertEnvelope(p, d, CU_LIMIT.token2022);
  const create = d.ixs[2] as TransactionInstruction;
  assert.equal(create.keys[1]?.pubkey.toBase58(), destAta);
  assert.equal(create.keys[5]?.pubkey.toBase58(), TOKEN22);
  const t = decodeTransferCheckedInstruction(d.ixs[3] as TransactionInstruction, TOKEN_2022_PROGRAM_ID);
  assert.ok(t.programId.equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(t.keys.source.pubkey.toBase58(), myAta);
  assert.equal(t.keys.destination.pubkey.toBase58(), destAta);
  assert.equal(t.data.amount, 4_000_000n);
  assert.equal(p.fee, 55_000n);

  install(world({ owner: TOKEN22, lamports: 1_461_600, data: mintDataWithTransferFee(6, 50) }));
  await assert.rejects(solana.prepare(KEYS, coin, DEPOSIT, 'max'), /charges a transfer fee/);
  install(world({ owner: TOKEN22, lamports: 1_461_600, data: mintDataWithTransferFee(6, 0) }));
  assert.equal((await solana.prepare(KEYS, coin, DEPOSIT, 'max')).amount, 4_000_000n, 'a zero transfer fee is fine');
});

test('reads fall over to the second node when the first rate-limits; a node\'s definite error is not retried elsewhere', async () => {
  const calls = install({ accounts: { [ME]: wallet(42) }, limited: ['https://api.mainnet-beta.solana.com'] });
  assert.equal(await solana.balance(ME, SOL), 42n);
  assert.deepEqual(calls.map((c) => new URL(c.url).origin), ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']);
  install({ accounts: {}, limited: [...SOLANA_RPC] });
  await assert.rejects(solana.balance(ME, SOL), /no node answered .*Too many requests/);
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response('{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid param: WrongSize"},"id":1}');
  }) as typeof fetch;
  await assert.rejects(solana.confirmed('1111'), /Invalid param: WrongSize/);
  assert.equal(seen.length, 1);
});

test('broadcast: posts exactly the prepared body to the prepared node; returns the signature; throws the node\'s words', async () => {
  install({ accounts: { [ME]: wallet(50_000_000) } });
  const p = await solana.prepare(KEYS, SOL, DEPOSIT, 'max');
  const calls = install({ accounts: {}, send: { result: p.txid } });
  assert.equal(await solana.broadcast(p), p.txid);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, p.request.url);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.body, p.request.body);
  assert.equal(solana.isWrite(new URL(p.request.url), 'POST', p.request.body), true);

  install({
    accounts: {},
    send: { error: { code: -32002, message: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.', data: { accounts: null, err: 'AccountNotFound', logs: [], unitsConsumed: 0 } } },
  });
  await assert.rejects(solana.broadcast(p), /refused the transaction: Transaction simulation failed: Attempt to debit .* \(AccountNotFound\)/);
  install({ accounts: {}, send: { result: '5drs5fJjFd3SxvyMmTZMbe3FQuvbZ1HyGZnqd6V3ZC6Fj7Jch6uXbgQWisDzsc1GMmJBgQZffZgfWNuu2bFpGY8H' } });
  await assert.rejects(solana.broadcast(p), /may still have gone out/);
  globalThis.fetch = (async () => new Response('<html>502</html>', { status: 502 })) as typeof fetch;
  await assert.rejects(solana.broadcast(p), /no readable answer .*HTTP 502.*may still have gone out/);
  await assert.rejects(solana.broadcast({ ...p, request: { ...p.request, url: 'https://evil.example' } }), /not one of the Solana nodes/);
});

test('confirmed: confirmed/finalized -> true, an error -> false, processed/unknown -> null; an expired, never-seen send of this process -> false', async () => {
  install({ accounts: { [ME]: wallet(50_000_000) } });
  const p = await solana.prepare(KEYS, SOL, DEPOSIT, 'max');
  const st = (confirmationStatus: string, err: unknown = null) => ({ confirmationStatus, confirmations: confirmationStatus === 'finalized' ? null : 3, err, slot: 452915937, status: err ? { Err: err } : { Ok: null } });
  install({ accounts: {}, statuses: { [p.txid]: st('finalized') } });
  assert.equal(await solana.confirmed(p.txid), true);
  install({ accounts: {}, statuses: { [p.txid]: st('confirmed') } });
  assert.equal(await solana.confirmed(p.txid), true);
  install({ accounts: {}, statuses: { [p.txid]: st('processed') } });
  assert.equal(await solana.confirmed(p.txid), null);
  install({ accounts: {}, statuses: { [p.txid]: st('finalized', { InstructionError: [2, { Custom: 1 }] }) } });
  assert.equal(await solana.confirmed(p.txid), false);
  // Unknown while its blockhash can still land, or just past it (margin): null.
  install({ accounts: {}, height: LAST_VALID - 10 });
  assert.equal(await solana.confirmed(p.txid), null);
  install({ accounts: {}, height: LAST_VALID + 150 });
  assert.equal(await solana.confirmed(p.txid), null);
  // Finalized well past its last valid block height and still unknown: it can never land.
  install({ accounts: {}, height: LAST_VALID + 151 });
  assert.equal(await solana.confirmed(p.txid), false);
  // A signature this process did not build: no expiry known -> null, never a guess.
  const other = '4BG95KAeQ5Xa2aWR42xHkTRM1kXSbEtfKbvm4Tgo3T8gJpDHwnntGTpPkd9aDraxRc8ypTz6dM9CJBe3D8Bz7x4X';
  install({ accounts: {}, height: LAST_VALID + 10_000 });
  assert.equal(await solana.confirmed(other), null);
});

test('signedTransfer refuses a spec whose sender is not the signing key', () => {
  const kp = Keypair.fromSeed(sha256('solana.test: one'));
  assert.throws(() => signedTransfer(kp, { kind: 'sol', from: new PublicKey(ME), to: new PublicKey(DEPOSIT), amount: 1n }, BLOCKHASH), /signing key/);
});

// --- live, read-only ---------------------------------------------------------------------------------

test('LIVE read-only: mainnet dry-runs the SOL and USDC transfers of an UNFUNDED throwaway key (well-formed: AccountNotFound, not a decode error)', { skip: !process.env.LIVE_SOLANA_SIM }, async () => {
  globalThis.fetch = realFetch;
  const seed = sha256('valuedesk solana.test: unfunded throwaway, never used');
  const kp = Keypair.fromSeed(seed);
  const keys: NativeKeys = { secp256k1: new Uint8Array(32), ed25519: () => seed };
  const me = solana.address(keys);
  assert.equal(me, kp.publicKey.toBase58());
  assert.equal(await solana.balance(me, SOL), 0n, 'unfunded');
  assert.equal(await solana.balance(me, USDC), 0n);
  const c = await solana.costs(me, USDC, DEPOSIT);
  console.log(`live costs USDC -> ${DEPOSIT}: fee ${c.fee}, nativeNeeded ${c.nativeNeeded} lamports`);
  assert.equal(c.fee, TOKEN_FEE);
  assert.ok(c.nativeNeeded >= TOKEN_FEE);
  await assert.rejects(solana.prepare(keys, SOL, DEPOSIT, 'max'), /holds 0 SOL/);
  await assert.rejects(solana.prepare(keys, USDC, DEPOSIT, 1_000_000n), /holds 0 SOL|holds no USDC/);

  const post = async (method: string, params: unknown[]) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    assert.equal(solana.isWrite(new URL(SOLANA_RPC[0]), 'POST', body), false, `${method} is a read`);
    const r = await fetch(SOLANA_RPC[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return (await r.json()) as { result?: { value: { err: unknown; logs: string[] | null; blockhash?: string } }; error?: unknown };
  };
  const bh = await post('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const blockhash = bh.result?.value.blockhash as string;
  const usdcMintKey = new PublicKey(USDC_MINT);
  const specs = [
    { kind: 'sol' as const, from: kp.publicKey, to: new PublicKey(DEPOSIT), amount: 31_000_000n },
    { kind: 'token' as const, from: kp.publicKey, to: new PublicKey(DEPOSIT), amount: 6_000_000n, mint: usdcMintKey, programId: TOKEN_PROGRAM_ID, decimals: 6, cuLimit: CU_LIMIT.token },
  ];
  for (const spec of specs) {
    const tx = signedTransfer(kp, spec, blockhash);
    const sim = await post('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
    console.log(`live dry run ${spec.kind}:`, JSON.stringify(sim.error ?? sim.result?.value.err));
    assert.equal(sim.error, undefined, 'no JSON-RPC error: the transaction decodes and its signature verifies');
    assert.equal(sim.result?.value.err, 'AccountNotFound', 'the only problem: the payer has no SOL');
  }
});
