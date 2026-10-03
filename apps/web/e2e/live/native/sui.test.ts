/**
 * native/sui.ts offline: a fake fetch answers with the shapes Sui's public GraphQL
 * endpoint gave on 2026-10-03 (recorded from read-only queries and dry runs of
 * public addresses), and every prepared transaction is decoded again and checked
 * independently (BLAKE2b digest, the secp256k1 signature, the commands, the gas).
 * The test key is a fixed key made for these tests - never funded.
 *   npx tsx --test e2e/live/native/sui.test.ts        (from apps/web)
 * With NATIVE_LIVE_READS=1 one more test reads the live endpoint (a balance and a
 * dry run of an unfunded key: reads only, nothing is signed or sent).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import { blake2b } from '@noble/hashes/blake2b';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import { Transaction } from '@mysten/sui/transactions';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { fromBase64, toBase58 } from '@mysten/sui/utils';
import { addressProblem } from '../../../src/trading/addresses';
import { nativeKeysFromHex } from './keys';
import {
  SUI_EXECUTE_MUTATION,
  SUI_GRAPHQL,
  SUI_MAINNET_CHAIN_ID,
  SUI_MAX_GAS_OBJECTS,
  isSuiCoinReservation,
  readSuiTransfer,
  sui,
  suiCoinReservation,
} from './sui';
import type { NativeCoin, PreparedSend } from './types';

const KEY_HEX = '0x8b269756d3b9c04db4aa5d1d579552e5b69f525e3f17a05b59abe87bde009ca1';
const keys = nativeKeysFromHex(KEY_HEX);
/** The test key's Sui address (pinned: the derivation must never change). */
const ADDRESS = '0x73cf688465d4ec7136927dc59c7742062ab22995dbe8b14641c5cf91c3accfd1';
const TO = '0x1111111111111111111111111111111111111111111111111111111111111111';
const SUI: NativeCoin = { symbol: 'SUI', native: true, token: null, decimals: 9 };
const SUI_REPR = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- the fake endpoint ------------------------------------------------------------------------------------------

interface Coin {
  objectId: string;
  version: number;
  digest: string;
  balance: bigint;
}
interface World {
  chainId: string;
  epoch: number;
  gasPrice: bigint;
  coins: Coin[];
  addressBalance: bigint;
  /** The address the state is asked for must be this one (null: any). */
  owner: string | null;
  dryRun?: 'fail' | 'short-receiver';
  effects: Record<string, 'SUCCESS' | 'FAILURE'>;
  execute?: (vars: { tx: string; signatures: string[] }) => { status: number; body: unknown };
}
interface Call {
  op: string;
  body: string;
  vars: Record<string, unknown>;
}

const digestOf = (n: number) => toBase58(new Uint8Array(32).fill(n));
const coin = (n: number, balance: bigint): Coin => ({ objectId: `0x${n.toString(16).padStart(64, '0')}`, version: 500_000_000 + n, digest: digestOf(n), balance });
const world = (o: Partial<World> = {}): World => ({ chainId: SUI_MAINNET_CHAIN_ID, epoch: 1269, gasPrice: 100n, coins: [], addressBalance: 0n, owner: ADDRESS, effects: {}, ...o });
const total = (w: World) => w.coins.reduce((s, c) => s + c.balance, 0n) + w.addressBalance;

/** The recorded gas of a SUI transfer at gas price 100 (2026-10-03): computation 100,000; storage 988,000 per written coin. */
function dryRunAnswer(w: World, bytes: Uint8Array) {
  const t = readSuiTransfer(bytes);
  const mocked = t.payment.length === 0;
  const computation = 100_000n;
  const storage = mocked && t.amount !== 'max' ? 1_976_000n : 988_000n;
  const rebate = mocked ? 0n : 978_120n * BigInt(t.payment.filter((r) => !isSuiCoinReservation(r)).length);
  const net = computation + storage - rebate;
  const have = mocked ? 1_000_000_000_000_000_000n : total(w);
  let recv = t.amount === 'max' ? have - net : t.amount;
  const send = t.amount === 'max' ? -have : -(t.amount + net);
  if (!mocked && w.dryRun === 'short-receiver') recv -= 1n;
  const failed = !mocked && w.dryRun === 'fail';
  return {
    data: {
      simulateTransaction: {
        effects: {
          status: failed ? 'FAILURE' : 'SUCCESS',
          executionError: failed ? { message: 'Error in 1st command, Insufficient coin balance for operation.' } : null,
          gasEffects: { gasSummary: { computationCost: Number(computation), storageCost: Number(storage), storageRebate: Number(rebate), nonRefundableStorageFee: Number(rebate / 99n) } },
          balanceChanges: {
            nodes: failed
              ? [{ owner: { address: t.sender }, coinType: { repr: SUI_REPR }, amount: String(-net) }]
              : [
                  { owner: { address: t.sender }, coinType: { repr: SUI_REPR }, amount: String(send) },
                  { owner: { address: t.to }, coinType: { repr: SUI_REPR }, amount: String(recv) },
                ],
          },
        },
      },
    },
  };
}

function install(w: World): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), SUI_GRAPHQL);
    assert.equal(init?.method, 'POST');
    assert.equal(typeof init?.body, 'string', 'every body is a string the guard can compare');
    const body = init!.body as string;
    const j = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(j.query)?.[1] ?? '?';
    calls.push({ op, body, vars: j.variables });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    switch (op) {
      case 'SuiState': {
        if (w.owner) assert.equal(j.variables.owner, w.owner);
        const start = j.variables.after ? Number(j.variables.after) : 0;
        const page = w.coins.slice(start, start + 50);
        const more = start + 50 < w.coins.length;
        const coinBalance = w.coins.reduce((s, c) => s + c.balance, 0n);
        return json(200, {
          data: {
            chainIdentifier: w.chainId,
            epoch: { epochId: w.epoch, referenceGasPrice: String(w.gasPrice) },
            address: {
              balance: { totalBalance: String(coinBalance + w.addressBalance), coinBalance: String(coinBalance), addressBalance: String(w.addressBalance) },
              objects: {
                pageInfo: { hasNextPage: more, endCursor: more ? String(start + 50) : 'gjupEwAAAADMAQ==' },
                nodes: page.map((c) => ({ address: c.objectId, version: c.version, digest: c.digest, contents: { json: { id: c.objectId, balance: String(c.balance) } } })),
              },
            },
          },
        });
      }
      case 'SuiBalance':
        return json(200, { data: { address: { balance: { totalBalance: String(j.variables.owner === w.owner ? total(w) : 0n) } } } });
      case 'SuiNetwork':
        return json(200, { data: { chainIdentifier: w.chainId, epoch: { epochId: w.epoch, referenceGasPrice: String(w.gasPrice) } } });
      case 'SuiDryRun':
        return json(200, dryRunAnswer(w, fromBase64((j.variables.tx as { bcs: { value: string } }).bcs.value)));
      case 'SuiEffects': {
        const d = String(j.variables.digest);
        const s = w.effects[d];
        return json(200, { data: { transactionEffects: s ? { digest: d, status: s, checkpoint: { sequenceNumber: 329853396 }, executionError: s === 'FAILURE' ? { message: 'abort code: 2' } : null } : null } });
      }
      case 'SuiExecute': {
        const r = w.execute?.(j.variables as { tx: string; signatures: string[] }) ?? { status: 500, body: { error: 'no execute in this test' } };
        return json(r.status, r.body);
      }
      default:
        throw new Error(`unexpected GraphQL operation ${op}`);
    }
  }) as typeof fetch;
  return calls;
}

/** The tx bytes and signature inside a prepared request, checked independently of the module. */
function unpack(p: PreparedSend): { bytes: Uint8Array; signature: string } {
  assert.equal(p.request.url, SUI_GRAPHQL);
  assert.equal(p.request.method, 'POST');
  assert.equal(p.request.headers['content-type'], 'application/json');
  const j = JSON.parse(p.request.body) as { query: string; variables: { tx: string; signatures: string[] } };
  assert.equal(j.query, SUI_EXECUTE_MUTATION);
  assert.equal(j.variables.signatures.length, 1);
  return { bytes: fromBase64(j.variables.tx), signature: j.variables.signatures[0]! };
}

async function checkSigned(p: PreparedSend, bytes: Uint8Array, signature: string): Promise<void> {
  // The digest: BLAKE2b-256("TransactionData::" || bytes), base58.
  const tagged = new Uint8Array([...new TextEncoder().encode('TransactionData::'), ...bytes]);
  assert.equal(p.txid, base58.encode(blake2b(tagged, { dkLen: 32 })));
  assert.equal(p.explorer, `https://suiscan.xyz/mainnet/tx/${p.txid}`);
  // The signature: flag 0x01 (secp256k1) || 64-byte signature || 33-byte compressed key, over sha256(blake2b(intent || bytes)).
  const sig = fromBase64(signature);
  assert.equal(sig.length, 1 + 64 + 33);
  assert.equal(sig[0], 0x01);
  const pub = secp256k1.getPublicKey(keys.secp256k1, true);
  assert.deepEqual(sig.slice(65), pub);
  const msg = blake2b(new Uint8Array([0, 0, 0, ...bytes]), { dkLen: 32 });
  assert.ok(secp256k1.verify(sig.slice(1, 65), sha256(msg), pub), 'the secp256k1 signature verifies');
  const pk = await verifyTransactionSignature(bytes, signature);
  assert.equal(pk.toSuiAddress(), ADDRESS);
}

// --- address -------------------------------------------------------------------------------------------------------

test('address: BLAKE2b-256(0x01 || compressed key), the pinned vector, valid for the app', () => {
  const pub = secp256k1.getPublicKey(keys.secp256k1, true);
  const mine = `0x${Buffer.from(blake2b(new Uint8Array([0x01, ...pub]), { dkLen: 32 })).toString('hex')}`;
  assert.equal(sui.address(keys), mine);
  assert.equal(sui.address(keys), ADDRESS);
  assert.equal(addressProblem('sui', ADDRESS), null);
  assert.deepEqual([sui.kind, sui.chainKey, sui.label], ['sui', 'SUI', 'Sui']);
  assert.deepEqual([...sui.origins], ['https://graphql.mainnet.sui.io']);
});

// --- prepare -------------------------------------------------------------------------------------------------------

test("prepare 'max' (coin objects): the gas coin itself goes; amount = balance - budget; every read is a read, the send a write", async () => {
  const w = world({ coins: [coin(1, 6_000_000_000n), coin(2, 4_000_000_000n)] });
  const calls = install(w);
  const p = await sui.prepare(keys, SUI, TO, 'max');
  const { bytes, signature } = unpack(p);
  const t = readSuiTransfer(bytes);
  // Budget: (computation 100,000 + storage 988,000 + 2000 units x 100) x 1.2.
  const budget = 1_545_600n;
  assert.equal(t.sender, ADDRESS);
  assert.equal(t.to, TO);
  assert.equal(t.amount, 'max');
  assert.equal(t.gasPrice, 100n);
  assert.equal(t.budget, budget);
  assert.equal(t.gasOwner, ADDRESS);
  assert.equal(t.expiration, null);
  assert.deepEqual(t.payment, w.coins.map((c) => ({ objectId: c.objectId, version: String(c.version), digest: c.digest })));
  assert.equal(p.amount, 10_000_000_000n - budget);
  assert.equal(p.fee, budget);
  // Exactly one TransferObjects([GasCoin], to) in the bytes the SDK decodes.
  const d = Transaction.from(bytes).getData();
  assert.equal(d.commands.length, 1);
  assert.equal(d.commands[0]!.$kind, 'TransferObjects');
  assert.equal(d.commands[0]!.TransferObjects!.objects[0]!.$kind, 'GasCoin');
  await checkSigned(p, bytes, signature);
  // Calls: the state, the gas dry run (mocked gas: no payment, a ValidDuring), the dry run of the real bytes.
  assert.deepEqual(calls.map((c) => c.op), ['SuiState', 'SuiDryRun', 'SuiDryRun']);
  const est = readSuiTransfer(fromBase64((calls[1]!.vars.tx as { bcs: { value: string } }).bcs.value));
  assert.equal(est.payment.length, 0);
  assert.equal(est.expiration, 'ValidDuring');
  assert.deepEqual(fromBase64((calls[2]!.vars.tx as { bcs: { value: string } }).bcs.value), bytes);
  for (const c of calls) assert.equal(sui.isWrite(new URL(SUI_GRAPHQL), 'POST', c.body), false, `${c.op} is a read`);
  assert.equal(sui.isWrite(new URL(p.request.url), p.request.method, p.request.body), true);
});

test("prepare 'max' (address balance only): a coin reservation of all of it is the gas payment - as the SDK's own resolver makes it", async () => {
  const w = world({ addressBalance: 14_368_299_504n });
  install(w);
  const p = await sui.prepare(keys, SUI, TO, 'max');
  const { bytes, signature } = unpack(p);
  const t = readSuiTransfer(bytes);
  assert.equal(t.payment.length, 1);
  const r = t.payment[0]!;
  assert.ok(isSuiCoinReservation(r));
  assert.equal(r.version, '0');
  const dg = base58.decode(r.digest);
  const view = new DataView(dg.buffer, dg.byteOffset, dg.byteLength);
  assert.equal(view.getBigUint64(0, true), w.addressBalance);
  assert.equal(view.getUint32(8, true), w.epoch);
  // The SDK's (unexported) createCoinReservationRef, loaded from its file: the same ref.
  const req = createRequire(import.meta.url);
  const utilsDir = dirname(req.resolve('@mysten/sui/utils'));
  const sdk = (await import(pathToFileURL(join(utilsDir, 'coin-reservation.mjs')).href)) as { createCoinReservationRef(a: bigint, o: string, c: string, e: string): { objectId: string; version: string; digest: string } };
  const ref = sdk.createCoinReservationRef(w.addressBalance, ADDRESS, SUI_MAINNET_CHAIN_ID, String(w.epoch));
  assert.deepEqual({ ...r }, { objectId: ref.objectId, version: String(ref.version), digest: ref.digest });
  assert.deepEqual(suiCoinReservation(w.addressBalance, ADDRESS, SUI_MAINNET_CHAIN_ID, BigInt(w.epoch)), { objectId: ref.objectId, version: '0', digest: ref.digest });
  assert.equal(p.amount, w.addressBalance - 1_545_600n);
  await checkSigned(p, bytes, signature);
});

test('prepare a fixed amount (coins + address balance): SplitCoins(GasCoin, [amount]) to the receiver, the rest stays', async () => {
  const w = world({ coins: [coin(3, 2_500_000_000n)], addressBalance: 1_000_000_000n });
  install(w);
  const p = await sui.prepare(keys, SUI, TO, 1_234_567_890n);
  const { bytes, signature } = unpack(p);
  const t = readSuiTransfer(bytes);
  assert.equal(t.amount, 1_234_567_890n);
  assert.equal(t.to, TO);
  // Budget of a split (a new coin object: storage 1,976,000): (100,000 + 1,976,000 + 200,000) x 1.2.
  assert.equal(t.budget, 2_731_200n);
  assert.equal(p.fee, 2_731_200n);
  assert.equal(p.amount, 1_234_567_890n);
  assert.equal(t.payment.length, 2);
  assert.ok(isSuiCoinReservation(t.payment[0]!));
  assert.equal(t.payment[1]!.objectId, w.coins[0]!.objectId);
  const d = Transaction.from(bytes).getData();
  assert.deepEqual(d.commands.map((c) => c.$kind), ['SplitCoins', 'TransferObjects']);
  await checkSigned(p, bytes, signature);
});

test('prepare refuses: too little, nothing, not SUI, a bad / own destination, another network, too many coins, a failing or short dry run', async () => {
  install(world({ coins: [coin(1, 1_000_000_000n)] }));
  await assert.rejects(sui.prepare(keys, SUI, TO, 1_000_000_000n), /too little SUI/);
  await assert.rejects(sui.prepare(keys, SUI, TO, 0n), /more than 0/);
  await assert.rejects(sui.prepare(keys, { ...SUI, symbol: 'USDC', native: false, token: '0xdba3::usdc::USDC', decimals: 6 }, TO, 'max'), /only SUI/);
  await assert.rejects(sui.prepare(keys, SUI, '0x1234', 'max'), /not a Sui address/);
  await assert.rejects(sui.prepare(keys, SUI, ADDRESS, 'max'), /itself/);

  install(world({ coins: [] }));
  await assert.rejects(sui.prepare(keys, SUI, TO, 'max'), /holds no SUI/);
  install(world({ coins: [coin(1, 1_500_000n)] }));
  await assert.rejects(sui.prepare(keys, SUI, TO, 'max'), /nothing can leave/);
  install(world({ coins: [coin(1, 5_000_000_000n)], chainId: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD' }));
  await assert.rejects(sui.prepare(keys, SUI, TO, 'max'), /not on mainnet/);
  install(world({ coins: Array.from({ length: SUI_MAX_GAS_OBJECTS }, (_, i) => coin(i + 1, 1_000_000n)), addressBalance: 5n }));
  await assert.rejects(sui.prepare(keys, SUI, TO, 'max'), /merge them first/);
  install(world({ coins: [coin(1, 5_000_000_000n)], dryRun: 'fail' }));
  await assert.rejects(sui.prepare(keys, SUI, TO, 'max'), /dry run of the transfer fails: Error in 1st command/);
  install(world({ coins: [coin(1, 5_000_000_000n)], dryRun: 'short-receiver' }));
  await assert.rejects(sui.prepare(keys, SUI, TO, 1_000_000_000n), /receiver gets/);
});

test('prepare pages through more than 50 coin objects', async () => {
  const w = world({ coins: Array.from({ length: 120 }, (_, i) => coin(i + 1, 100_000_000n)) });
  const calls = install(w);
  const p = await sui.prepare(keys, SUI, TO, 'max');
  assert.deepEqual(calls.map((c) => c.op), ['SuiState', 'SuiState', 'SuiState', 'SuiDryRun', 'SuiDryRun']);
  assert.equal(readSuiTransfer(unpack(p).bytes).payment.length, 120);
  assert.equal(p.amount, 12_000_000_000n - 1_545_600n);
});

// --- reads ---------------------------------------------------------------------------------------------------------

test('balance: coin objects + address balance; an unknown address is 0; costs: the split budget, nothing kept', async () => {
  install(world({ coins: [coin(1, 7n)], addressBalance: 5n }));
  assert.equal(await sui.balance(ADDRESS, SUI), 12n);
  assert.equal(await sui.balance(TO, SUI), 0n);
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { address: null } }), { status: 200 })) as typeof fetch;
  assert.equal(await sui.balance(TO, SUI), 0n);
  install(world({ owner: null }));
  assert.deepEqual(await sui.costs(ADDRESS, SUI, TO), { fee: 2_731_200n, keep: 0n, nativeNeeded: 0n });
  await assert.rejects(sui.balance('0xabc', SUI), /not a Sui address/);
});

test('isWrite: only a mutation (executeTransaction) is a write; comments and strings do not count; unreadable = write', () => {
  const u = new URL(SUI_GRAPHQL);
  const q = (query: string) => JSON.stringify({ query, variables: {} });
  assert.equal(sui.isWrite(u, 'POST', q('query { chainIdentifier }')), false);
  assert.equal(sui.isWrite(u, 'POST', q('{ epoch { referenceGasPrice } } # mutation executeTransaction')), false);
  assert.equal(sui.isWrite(u, 'POST', q('query X($a: String = "mutation") { chainIdentifier }')), false);
  assert.equal(sui.isWrite(u, 'POST', q('mutation { executeTransaction(transactionDataBcs: "", signatures: []) { effects { digest } } }')), true);
  assert.equal(sui.isWrite(u, 'POST', q('{ executeTransaction }')), true);
  assert.equal(sui.isWrite(u, 'POST', JSON.stringify([{ query: '{ chainIdentifier }' }, { query: 'mutation M { executeTransaction }' }])), true);
  assert.equal(sui.isWrite(u, 'POST', JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'ab' } } })), true);
  assert.equal(sui.isWrite(u, 'POST', 'not json'), true);
  assert.equal(sui.isWrite(u, 'POST', null), false);
  assert.equal(sui.isWrite(new URL(`${SUI_GRAPHQL}?query=${encodeURIComponent('mutation { executeTransaction }')}`), 'GET', null), true);
  assert.equal(sui.isWrite(new URL(`${SUI_GRAPHQL}?query=${encodeURIComponent('{ chainIdentifier }')}`), 'GET', null), false);
  assert.equal(sui.isWrite(u, 'PUT', null), true);
});

// --- broadcast, confirmed ------------------------------------------------------------------------------------------

test('broadcast sends exactly the prepared body and returns the digest; refusals and mismatches throw with the words', async () => {
  const w = world({ coins: [coin(1, 5_000_000_000n)] });
  install(w);
  const p = await sui.prepare(keys, SUI, TO, 'max');
  const sent: string[] = [];
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), p.request.url);
      sent.push(init!.body as string);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  };
  answer(200, { data: { executeTransaction: { effects: { digest: p.txid, status: 'SUCCESS', executionError: null } } } });
  assert.equal(await sui.broadcast(p), p.txid);
  assert.equal(sent[0], p.request.body, 'byte for byte the armed body');
  // On chain but failed (gas charged): the digest comes back; `confirmed` says false.
  answer(200, { data: { executeTransaction: { effects: { digest: p.txid, status: 'FAILURE', executionError: { message: 'InsufficientGas' } } } } });
  assert.equal(await sui.broadcast(p), p.txid);
  answer(200, { data: null, errors: [{ message: 'Transaction validator signing failed due to issues with transaction inputs', path: ['executeTransaction'] }] });
  await assert.rejects(sui.broadcast(p), new RegExp(`Sui refused the transaction: Transaction validator signing failed.*\\(digest ${p.txid}\\)`));
  answer(403, { error: 'E2E guard refused this request: no chain-broadcast is expected right now. Nothing was sent.' });
  await assert.rejects(sui.broadcast(p), /HTTP 403: E2E guard refused/);
  answer(200, { data: { executeTransaction: { effects: { digest: digestOf(9), status: 'SUCCESS' } } } });
  await assert.rejects(sui.broadcast(p), /reports digest/);
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(sui.broadcast(p), /may still have reached the network/);
});

test('confirmed: SUCCESS -> true, FAILURE -> false, unknown -> null; not a digest -> throws', async () => {
  const ok = 'DjGoT2RpxrxSqU7UcEzKjTxa9FdTR8bVHw9jUrYexJJq';
  const failed = 'G9wQXKvp6xySa1SXxioD918kuYaCU48BPYiYmQXzgDmD';
  install(world({ effects: { [ok]: 'SUCCESS', [failed]: 'FAILURE' } }));
  assert.equal(await sui.confirmed(ok), true);
  assert.equal(await sui.confirmed(failed), false);
  assert.equal(await sui.confirmed(SUI_MAINNET_CHAIN_ID), null);
  await assert.rejects(sui.confirmed('0xabc'), /not a transaction digest/);
});

// --- optional: the live endpoint, reads only --------------------------------------------------------------------

test('live (NATIVE_LIVE_READS=1): balance of the unfunded test key and a gas dry run - reads only', { skip: process.env.NATIVE_LIVE_READS !== '1' }, async () => {
  globalThis.fetch = realFetch;
  assert.equal(await sui.balance(ADDRESS, SUI), 0n);
  const c = await sui.costs(ADDRESS, SUI, TO);
  assert.ok(c.fee > 0n && c.fee < 100_000_000n, `a believable gas budget (${c.fee})`);
  await assert.rejects(sui.prepare(keys, SUI, TO, 'max'), /holds no SUI/);
});
