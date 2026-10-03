/**
 * native/cardano.ts offline: a fake fetch answers with the shapes Koios gave on
 * 2026-10-03 (/tip, /cli_protocol_params, /address_utxos, /tx_status, /ogmios -
 * recorded from read-only calls on public addresses), and every prepared
 * transaction is decoded again and checked independently: the body's bytes cut
 * out of the CBOR by hand, BLAKE2b-256 of them = the txid, the ed25519
 * signature over it (noble), the fee = 44 * size + 155381, inputs, outputs, TTL.
 * The test key is a fixed key made for these tests - never funded.
 *   npx tsx --test e2e/live/native/cardano.test.ts        (from apps/web)
 * With NATIVE_LIVE_READS=1 one more test reads Koios live (reads only).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { ed25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import { addressProblem } from '../../../src/trading/addresses';
import { CARDANO_TTL_SLOTS, KOIOS, KOIOS_OGMIOS, cardano, cardanoSubmitBody, readCardanoTransfer } from './cardano';
import { nativeKeysFromHex } from './keys';
import type { NativeCoin, PreparedSend } from './types';

const KEY_HEX = '0x8b269756d3b9c04db4aa5d1d579552e5b69f525e3f17a05b59abe87bde009ca1';
const keys = nativeKeysFromHex(KEY_HEX);
/** The test key's enterprise address (pinned: the derivation must never change). */
const ADDRESS = 'addr1vx6qx4002amgga7gyum8st4z8q3wugsc82j6rdvzy3x0nhsxp945x';
/** Public addresses seen on mainnet 2026-10-03 (a base and an enterprise address) - receivers only. */
const TO = 'addr1q8385phmnsuyk9fzy692vdgrvcrkgvsnwlc0d0cx4eztrqdxzyykkpqv7mwxezgd7hzqqy3d4cenhspj79h2huaw5ttscrrydj';
const TO_ENT = 'addr1v8v3auqmw0eszza3ww29ea2pwftuqrqqyu26zvzjq9dt2ncydzvs5';
const ADA: NativeCoin = { symbol: 'ADA', native: true, token: null, decimals: 6 };
const TIP = 199_477_428;
const A = 44n;
const B = 155_381n;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- the fake Koios ---------------------------------------------------------------------------------------------

/** /cli_protocol_params as Koios answered (costModels left out). */
const PARAMS = {
  collateralPercentage: 150, maxTxSize: 16384, maxValueSize: 5000, minFeeRefScriptCostPerByte: 15, minPoolCost: 170000000,
  protocolVersion: { major: 11, minor: 0 }, stakeAddressDeposit: 2000000, txFeeFixed: 155381, txFeePerByte: 44, utxoCostPerByte: 4310,
  executionUnitPrices: { priceMemory: 0.0577, priceSteps: 0.0000721 }, maxBlockBodySize: 90112, maxCollateralInputs: 3,
};

interface Utxo {
  tx_hash: string;
  tx_index: number;
  value: string;
  asset_list: unknown[];
  reference_script: unknown;
}
const utxo = (n: number, lovelace: bigint, extra: Partial<Utxo> = {}): Utxo => ({ tx_hash: n.toString(16).padStart(2, '0').repeat(32), tx_index: n % 3, value: String(lovelace), asset_list: [], reference_script: null, ...extra });
const TOKEN = { decimals: 6, quantity: '1666666666', policy_id: '51a5e236c4de3af2b8020442e2a26f454fda3b04cb621c1294a0ef34', asset_name: '424f4f4b', fingerprint: 'asset1lpmhzq33vsj9jpj2wsluu0usqfaf6kk96zdw5c' };

interface World {
  tip: number;
  utxos: Record<string, Utxo[]>;
  status: Record<string, number | null>;
  submit?: (cbor: string) => { status: number; body: unknown };
}
interface Call {
  method: string;
  url: string;
  body: string | null;
}

function install(w: World): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = (init?.body as string | undefined) ?? null;
    if (body !== null) assert.equal(typeof body, 'string', 'every body is a string the guard can compare');
    calls.push({ method, url: url.href, body });
    assert.equal(url.origin, 'https://api.koios.rest');
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    const path = url.pathname.replace('/api/v1', '');
    if (method === 'GET' && path === '/tip') return json(200, [{ hash: '17df7b2cee7f41df316e20d21f30757b3513414bfc45fb90e27d2fc0d4559c79', epoch_no: 659, era: 'Conway', abs_slot: w.tip, epoch_slot: 152628, block_height: 14021218, block_no: 14021218, block_time: 1791043719 }]);
    if (method === 'GET' && path === '/cli_protocol_params') return json(200, PARAMS);
    if (method === 'POST' && path === '/address_utxos') {
      const q = JSON.parse(body!) as { _addresses: string[]; _extended: boolean };
      assert.equal(q._extended, true);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      const rows = (w.utxos[q._addresses[0]!] ?? []).slice(offset, offset + limit);
      return json(200, rows.map((u) => ({ ...u, address: q._addresses[0], stake_address: null, payment_cred: 'b4035def5776847bc827367825a23822ee22183aa5a1b582244cf9de', epoch_no: 659, block_height: 14021000, block_time: 1791040000, datum_hash: null, inline_datum: null, is_spent: false })));
    }
    if (method === 'POST' && path === '/tx_status') {
      const q = JSON.parse(body!) as { _tx_hashes: string[] };
      return json(200, q._tx_hashes.map((h) => ({ tx_hash: h, num_confirmations: w.status[h] ?? null })));
    }
    if (method === 'POST' && path === '/ogmios') {
      const q = JSON.parse(body!) as { method: string; params: { transaction: { cbor: string } } };
      assert.equal(q.method, 'submitTransaction');
      const r = w.submit?.(q.params.transaction.cbor) ?? { status: 500, body: { error: 'no submit in this test' } };
      return json(r.status, r.body);
    }
    throw new Error(`unexpected Koios call ${method} ${url.href}`);
  }) as typeof fetch;
  return calls;
}
const world = (o: Partial<World> = {}): World => ({ tip: TIP, utxos: {}, status: {}, ...o });

// --- an independent reading of the bytes ------------------------------------------------------------------------

/** The end of the CBOR item at `i` (definite lengths only - what the library writes). */
function cborEnd(b: Uint8Array, i: number): number {
  const ib = b[i]!;
  const major = ib >> 5;
  const ai = ib & 31;
  i += 1;
  let n: number;
  if (ai < 24) n = ai;
  else if (ai === 24) (n = b[i]!), (i += 1);
  else if (ai === 25) (n = (b[i]! << 8) | b[i + 1]!), (i += 2);
  else if (ai === 26) (n = new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0)), (i += 4);
  else if (ai === 27) (n = Number(new DataView(b.buffer, b.byteOffset + i, 8).getBigUint64(0))), (i += 8);
  else throw new Error('indefinite or reserved CBOR length');
  switch (major) {
    case 0:
    case 1:
    case 7:
      return i;
    case 2:
    case 3:
      return i + n;
    case 4:
      for (let k = 0; k < n; k++) i = cborEnd(b, i);
      return i;
    case 5:
      for (let k = 0; k < 2 * n; k++) i = cborEnd(b, i);
      return i;
    default: // 6: a tag and its item
      return cborEnd(b, i);
  }
}

/** The cbor hex inside a prepared request (the Ogmios submitTransaction body). */
function unpack(p: PreparedSend): Uint8Array {
  assert.equal(p.request.url, KOIOS_OGMIOS);
  assert.equal(p.request.method, 'POST');
  assert.equal(p.request.headers['content-type'], 'application/json');
  const j = JSON.parse(p.request.body) as { jsonrpc: string; method: string; params: { transaction: { cbor: string } }; id: string };
  assert.equal(j.jsonrpc, '2.0');
  assert.equal(j.method, 'submitTransaction');
  assert.match(j.params.transaction.cbor, /^[0-9a-f]+$/);
  const bytes = hexToBytes(j.params.transaction.cbor);
  assert.equal(p.request.body, cardanoSubmitBody(bytes, p.txid));
  return bytes;
}

/** Checks the signed transaction: [body, witnesses, true, null]; txid; the one vkey witness; the exact fee. */
function checkSigned(p: PreparedSend, bytes: Uint8Array): CSL.Transaction {
  assert.equal(bytes[0], 0x84, 'a 4-element array');
  const bodyEnd = cborEnd(bytes, 1);
  const witEnd = cborEnd(bytes, bodyEnd);
  assert.deepEqual([...bytes.slice(witEnd)], [0xf5, 0xf6], 'is_valid true, no auxiliary data');
  const txidBytes = blake2b(bytes.slice(1, bodyEnd), { dkLen: 32 });
  assert.equal(p.txid, bytesToHex(txidBytes));
  assert.equal(p.explorer, `https://cardanoscan.io/transaction/${p.txid}`);
  const tx = CSL.Transaction.from_bytes(bytes);
  const vk = tx.witness_set().vkeys()!;
  assert.equal(vk.len(), 1);
  const pub = ed25519.getPublicKey(keys.ed25519('cardano'));
  assert.deepEqual(vk.get(0).vkey().public_key().as_bytes(), pub);
  assert.ok(ed25519.verify(vk.get(0).signature().to_bytes(), txidBytes, pub), 'the ed25519 signature verifies over the txid');
  assert.equal(tx.witness_set().native_scripts(), undefined);
  assert.equal(tx.auxiliary_data(), undefined);
  const fee = BigInt(tx.body().fee().to_str());
  assert.equal(p.fee, fee);
  assert.ok(fee >= A * BigInt(bytes.length) + B, 'the fee covers the size');
  assert.equal(BigInt(tx.body().ttl_bignum()!.to_str()), BigInt(TIP) + CARDANO_TTL_SLOTS);
  return tx;
}

const inputsOf = (tx: CSL.Transaction) => {
  const ins = tx.body().inputs();
  return Array.from({ length: ins.len() }, (_, i) => `${ins.get(i).transaction_id().to_hex()}#${ins.get(i).index()}`).sort();
};
const outputsOf = (tx: CSL.Transaction) => {
  const outs = tx.body().outputs();
  return Array.from({ length: outs.len() }, (_, i) => ({ address: outs.get(i).address().to_bech32(), lovelace: BigInt(outs.get(i).amount().coin().to_str()), tokens: !!outs.get(i).amount().multiasset() }));
};

// --- address -------------------------------------------------------------------------------------------------------

test('address: enterprise 0x61 || BLAKE2b-224(public key), bech32 addr1v..., the pinned vector, valid for the app', () => {
  const pub = ed25519.getPublicKey(keys.ed25519('cardano'));
  const raw = new Uint8Array([0x61, ...blake2b(pub, { dkLen: 28 })]);
  const mine = bech32.encode('addr', bech32.toWords(raw), 1023);
  assert.equal(cardano.address(keys), mine);
  assert.equal(cardano.address(keys), ADDRESS);
  assert.match(ADDRESS, /^addr1v/);
  assert.equal(addressProblem('cardano', ADDRESS), null);
  assert.deepEqual([cardano.kind, cardano.chainKey, cardano.label], ['cardano', 'ADA', 'Cardano']);
  assert.deepEqual([...cardano.origins], ['https://api.koios.rest']);
});

// --- prepare -------------------------------------------------------------------------------------------------------

test("prepare 'max': every UTxO in, one output of total - fee, the fee exactly 44 * size + 155381; reads are reads, the submit a write", async () => {
  const w = world({ utxos: { [ADDRESS]: [utxo(1, 3_000_000n), utxo(2, 2_500_000n)] } });
  const calls = install(w);
  const p = await cardano.prepare(keys, ADA, TO, 'max');
  const bytes = unpack(p);
  const tx = checkSigned(p, bytes);
  assert.equal(p.fee, A * BigInt(bytes.length) + B, 'the smallest fee the size allows');
  assert.deepEqual(inputsOf(tx), [`${'01'.repeat(32)}#1`, `${'02'.repeat(32)}#2`]);
  assert.deepEqual(outputsOf(tx), [{ address: TO, lovelace: 5_500_000n - p.fee, tokens: false }]);
  assert.equal(p.amount, 5_500_000n - p.fee);
  assert.ok(p.fee > 160_000n && p.fee < 200_000n, `a believable fee (${p.fee})`);
  for (const c of calls) assert.equal(cardano.isWrite(new URL(c.url), c.method, c.body), false, `${c.method} ${c.url} is a read`);
  assert.equal(cardano.isWrite(new URL(p.request.url), p.request.method, p.request.body), true);
  // The module's own reading agrees.
  const back = readCardanoTransfer(bytes);
  assert.equal(back.txid, p.txid);
  assert.deepEqual(back.extras, []);
  assert.equal(back.witnesses.length, 1);
  assert.ok(back.witnesses[0]!.valid);
});

test('prepare a fixed amount: the output + change back to the wallet; the fee exact', async () => {
  install(world({ utxos: { [ADDRESS]: [utxo(1, 10_000_000n)] } }));
  const p = await cardano.prepare(keys, ADA, TO_ENT, 2_000_000n);
  const bytes = unpack(p);
  const tx = checkSigned(p, bytes);
  assert.equal(p.fee, A * BigInt(bytes.length) + B);
  assert.equal(p.amount, 2_000_000n);
  assert.deepEqual(outputsOf(tx), [
    { address: TO_ENT, lovelace: 2_000_000n, tokens: false },
    { address: ADDRESS, lovelace: 10_000_000n - 2_000_000n - p.fee, tokens: false },
  ]);
});

test('prepare a fixed amount whose change would be below the min-UTxO: no change output, the rest is the fee', async () => {
  install(world({ utxos: { [ADDRESS]: [utxo(1, 3_000_000n)] } }));
  const p = await cardano.prepare(keys, ADA, TO, 2_500_000n);
  const bytes = unpack(p);
  const tx = checkSigned(p, bytes);
  assert.deepEqual(outputsOf(tx), [{ address: TO, lovelace: 2_500_000n, tokens: false }]);
  assert.equal(p.fee, 500_000n);
  assert.equal(p.amount, 2_500_000n);
});

test('UTxOs with tokens: refused for max; a fixed amount leaves them alone; one with a reference script likewise', async () => {
  install(world({ utxos: { [ADDRESS]: [utxo(1, 5_000_000n), utxo(2, 1_155_080n, { asset_list: [TOKEN] })] } }));
  await assert.rejects(cardano.prepare(keys, ADA, TO, 'max'), /carry native tokens/);
  const p = await cardano.prepare(keys, ADA, TO, 1_500_000n);
  const tx = checkSigned(p, unpack(p));
  assert.deepEqual(inputsOf(tx), [`${'01'.repeat(32)}#1`]);
  assert.ok(outputsOf(tx).every((o) => !o.tokens));
  assert.equal(await cardano.balance(ADDRESS, ADA), 6_155_080n, 'the balance counts their lovelace (not the tokens)');
  install(world({ utxos: { [ADDRESS]: [utxo(1, 5_000_000n), utxo(2, 9_000_000n, { reference_script: { hash: 'ab', size: 300, type: 'plutusV2' } })] } }));
  await assert.rejects(cardano.prepare(keys, ADA, TO, 'max'), /reference script/);
});

test('prepare refuses: below the min-UTxO, too little, nothing, too big, not ADA, a bad / testnet / script / own destination', async () => {
  install(world({ utxos: { [ADDRESS]: [utxo(1, 1_500_000n)] } }));
  await assert.rejects(cardano.prepare(keys, ADA, TO, 900_000n), /below the min-UTxO/);
  await assert.rejects(cardano.prepare(keys, ADA, TO, 1_400_000n), /too little ADA/);
  await assert.rejects(cardano.prepare(keys, ADA, TO, 0n), /more than 0/);
  await assert.rejects(cardano.prepare(keys, { symbol: 'USDC', native: false, token: 'abc', decimals: 6 }, TO, 'max'), /only ADA/);
  await assert.rejects(cardano.prepare(keys, ADA, 'addr1qxyz', 'max'), /not a Shelley mainnet address/);
  await assert.rejects(cardano.prepare(keys, ADA, 'DdzFFzCqrhsjZHKn8Y9Zr', 'max'), /not a Shelley mainnet address/);
  const testnet = CSL.EnterpriseAddress.new(0, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('b4035def5776847bc827367825a23822ee22183aa5a1b582244cf9de'))).to_address().to_bech32();
  assert.match(testnet, /^addr_test1/);
  await assert.rejects(cardano.prepare(keys, ADA, testnet, 'max'), /not a Shelley mainnet address/);
  await assert.rejects(cardano.prepare(keys, ADA, ADDRESS, 'max'), /itself/);
  const script = CSL.EnterpriseAddress.new(1, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex('b4035def5776847bc827367825a23822ee22183aa5a1b582244cf9de'))).to_address().to_bech32();
  assert.equal(addressProblem('cardano', script), null, 'a valid address the app would take');
  await assert.rejects(cardano.prepare(keys, ADA, script, 'max'), /SCRIPT address/);
  install(world({ utxos: { [ADDRESS]: [utxo(1, 1_000_000n)] } }));
  await assert.rejects(cardano.prepare(keys, ADA, TO, 'max'), /below the min-UTxO/);
  install(world());
  await assert.rejects(cardano.prepare(keys, ADA, TO, 'max'), /has no UTxO/);
  install(world({ utxos: { [ADDRESS]: Array.from({ length: 500 }, (_, i) => ({ ...utxo(i % 250, 2_000_000n), tx_index: i })) } }));
  await assert.rejects(cardano.prepare(keys, ADA, TO, 'max'), /more than the 16384 allowed/);
});

// --- reads ---------------------------------------------------------------------------------------------------------

test('balance pages through Koios (1000 rows a page); an unknown address is 0; costs covers a real send of that shape', async () => {
  const many = Array.from({ length: 1003 }, (_, i) => ({ ...utxo(i % 200, 1_000_000n), tx_index: i }));
  const calls = install(world({ utxos: { [ADDRESS]: many } }));
  assert.equal(await cardano.balance(ADDRESS, ADA), 1_003_000_000n);
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('offset')), ['0', '1000']);
  assert.equal(await cardano.balance(TO, ADA), 0n);
  await assert.rejects(cardano.balance('addr_test1vz', ADA), /not a Shelley mainnet address/);

  install(world({ utxos: { [ADDRESS]: [utxo(1, 4_000_000n), utxo(2, 6_000_000n)] } }));
  const c = await cardano.costs(ADDRESS, ADA, TO);
  assert.equal(c.keep, 0n);
  assert.equal(c.nativeNeeded, 0n);
  const p = await cardano.prepare(keys, ADA, TO, 2_000_000n);
  assert.ok(c.fee >= p.fee, `costs (${c.fee}) covers the real fee (${p.fee})`);
  assert.ok(c.fee <= (p.fee * 13n) / 10n, `and not by much (${c.fee} vs ${p.fee})`);
  install(world());
  const none = await cardano.costs(ADDRESS, ADA, 'not an address');
  assert.ok(none.fee > B && none.fee < 300_000n);
});

test('isWrite: /submittx and an Ogmios submitTransaction are writes; Koios reads and Ogmios queries are not; unreadable = write', () => {
  const og = new URL(KOIOS_OGMIOS);
  const rpc = (method: string) => JSON.stringify({ jsonrpc: '2.0', method, params: {} });
  assert.equal(cardano.isWrite(og, 'POST', rpc('submitTransaction')), true);
  assert.equal(cardano.isWrite(og, 'POST', rpc('queryNetwork/tip')), false);
  assert.equal(cardano.isWrite(og, 'POST', rpc('queryLedgerState/protocolParameters')), false);
  assert.equal(cardano.isWrite(og, 'POST', rpc('evaluateTransaction')), false);
  assert.equal(cardano.isWrite(og, 'POST', rpc('releaseMempool')), true, 'an unknown method is gated');
  assert.equal(cardano.isWrite(og, 'POST', JSON.stringify([JSON.parse(rpc('queryNetwork/tip')), JSON.parse(rpc('submitTransaction'))])), true);
  assert.equal(cardano.isWrite(og, 'POST', '\xa1\x00'), true);
  assert.equal(cardano.isWrite(new URL(`${KOIOS}/submittx`), 'POST', '\x84\xa4'), true);
  assert.equal(cardano.isWrite(new URL(`${KOIOS}/address_utxos`), 'POST', JSON.stringify({ _addresses: [ADDRESS] })), false);
  assert.equal(cardano.isWrite(new URL(`${KOIOS}/tx_status`), 'POST', JSON.stringify({ _tx_hashes: ['00'.repeat(32)] })), false);
  assert.equal(cardano.isWrite(new URL(`${KOIOS}/tip`), 'GET', null), false);
});

// --- broadcast, confirmed ------------------------------------------------------------------------------------------

test('broadcast sends exactly the prepared body and returns the txid; refusals and mismatches throw with the words', async () => {
  install(world({ utxos: { [ADDRESS]: [utxo(1, 3_000_000n)] } }));
  const p = await cardano.prepare(keys, ADA, TO, 'max');
  const sent: string[] = [];
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), KOIOS_OGMIOS);
      sent.push(init!.body as string);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  };
  answer(200, { jsonrpc: '2.0', method: 'submitTransaction', result: { transaction: { id: p.txid } }, id: p.txid });
  assert.equal(await cardano.broadcast(p), p.txid);
  assert.equal(sent[0], p.request.body, 'byte for byte the armed body');
  answer(200, {
    jsonrpc: '2.0', method: 'submitTransaction', id: p.txid,
    error: { code: 3117, message: "The transaction contains unknown UTxO references as inputs. This can happen if the inputs you're trying to spend have already been spent.", data: { unknownOutputReferences: [{ transaction: { id: '01'.repeat(32) }, index: 1 }] } },
  });
  await assert.rejects(cardano.broadcast(p), /Cardano refused the transaction: The transaction contains unknown UTxO references.*\(code 3117\)/);
  answer(403, { error: 'E2E guard refused this request: no chain-broadcast is expected right now. Nothing was sent.' });
  await assert.rejects(cardano.broadcast(p), /refused the transaction: E2E guard refused/);
  answer(200, { jsonrpc: '2.0', method: 'submitTransaction', result: { transaction: { id: 'ff'.repeat(32) } }, id: null });
  await assert.rejects(cardano.broadcast(p), /reports id/);
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(cardano.broadcast(p), /may still have reached the network/);
});

test('confirmed: confirmations -> true; not yet -> null; past its TTL (+900 slots) -> false; not an id -> throws', async () => {
  const w = world({ utxos: { [ADDRESS]: [utxo(1, 3_000_000n)] } });
  install(w);
  const p = await cardano.prepare(keys, ADA, TO, 'max');
  w.status[p.txid] = null;
  assert.equal(await cardano.confirmed(p.txid), null);
  w.tip = TIP + 1000 + 900;
  assert.equal(await cardano.confirmed(p.txid), null, 'not yet beyond the margin');
  w.tip = TIP + 1000 + 901;
  assert.equal(await cardano.confirmed(p.txid), false, 'its TTL has passed: it can never be on chain');
  w.status[p.txid] = 3;
  assert.equal(await cardano.confirmed(p.txid.toUpperCase()), true);
  w.status['16db6d09ec5e8e40cd036c8b5b4aa94af0f6bb8c32f43f57ea9b11b303073089'] = 0;
  assert.equal(await cardano.confirmed('16db6d09ec5e8e40cd036c8b5b4aa94af0f6bb8c32f43f57ea9b11b303073089'), null);
  assert.equal(await cardano.confirmed('00'.repeat(32)), null, 'unknown and not ours: not yet known');
  await assert.rejects(cardano.confirmed('0x12'), /not a transaction id/);
});

// --- optional: Koios live, reads only ---------------------------------------------------------------------------

test('live (NATIVE_LIVE_READS=1): Koios answers for the unfunded test key - reads only', { skip: process.env.NATIVE_LIVE_READS !== '1' }, async () => {
  globalThis.fetch = realFetch;
  assert.equal(await cardano.balance(ADDRESS, ADA), 0n);
  const c = await cardano.costs(ADDRESS, ADA, TO);
  assert.ok(c.fee > 155_381n && c.fee < 1_000_000n, `a believable fee (${c.fee})`);
  await assert.rejects(cardano.prepare(keys, ADA, TO, 'max'), /has no UTxO/);
  assert.equal(await cardano.confirmed('00'.repeat(32)), null);
});
