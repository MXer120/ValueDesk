/**
 * The UTXO chains (bitcoin.ts: Bitcoin, Litecoin, Dogecoin), offline: a fake fetch answers
 * with the shapes the public APIs answered on 2026-10-03 (mempool.space / litecoinspace.org /
 * blockstream.info = Esplora, dogecoin.atomicwallet.io / litecoin.atomicwallet.io = Blockbook,
 * api.blockcypher.com). Every built transaction is decoded twice - by @scure/btc-signer and by a
 * small parser here - and each signature is checked against a sighash computed HERE (legacy and
 * BIP143), independent of the signer. Nothing talks to a network or uses a real key.
 *   npx tsx --test e2e/live/native/bitcoin.test.ts        (from apps/web)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { Address, OutScript, Transaction } from '@scure/btc-signer';
import { addressProblem, base58CheckEncode, bech32Encode, convertBits } from '../../../src/trading/addresses';
import { bitcoin, dogecoin, estimateVsize, litecoin } from './bitcoin';
import { nativeKeysFromHex } from './keys';
import type { NativeChain, NativeCoin, PreparedSend } from './types';

/** Private key 1: the BIP173 vector's key. A TEST key - never funded, never used anywhere real. */
const KEYS = nativeKeysFromHex(`0x${'00'.repeat(31)}01`);
const PUB = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const H160 = '751e76e8199196d454941c45d1b3a323f1433bd6';
const BTC_ME = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const LTC_ME = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9';
const DOGE_ME = 'DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE';
const WPKH_ME = `0014${H160}`;
const PKH_ME = `76a914${H160}88ac`;

/** Stand-ins for SoDEX deposit addresses: valid public addresses (fetch is fake). */
const BTC_TO = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const BTC_TO_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const LTC_TO_P2WSH = 'ltc1qzvcgmntglcuv4smv3lzj6k8szcvsrmvk0phrr9wfq8w493r096ssm2fgsw';
const LTC_TO_LEGACY = 'LQTpS3VaYTjCr4s9Y1t5zbeY26zevf7Fb3';
const DOGE_TO = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L';

const BTC: NativeCoin = { symbol: 'BTC', native: true, token: null, decimals: 8 };
const LTC: NativeCoin = { symbol: 'LTC', native: true, token: null, decimals: 8 };
const DOGE: NativeCoin = { symbol: 'DOGE', native: true, token: null, decimals: 8 };

const MEMPOOL = 'https://mempool.space/api';
const BLOCKSTREAM = 'https://blockstream.info/api';
const LTCSPACE = 'https://litecoinspace.org/api';
const LTC_BB = 'https://litecoin.atomicwallet.io';
const DOGE_BB = 'https://dogecoin.atomicwallet.io';
const BCY = 'https://api.blockcypher.com/v1/doge/main';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- bytes, hashes, an independent transaction parser -----------------------------------------------

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b));
const le = (v: bigint | number, bytes: number): Uint8Array => {
  let n = BigInt(v);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
};
const varint = (n: number): Uint8Array => (n < 0xfd ? Uint8Array.of(n) : cat(Uint8Array.of(0xfd), le(n, 2)));
const withLen = (b: Uint8Array): Uint8Array => cat(varint(b.length), b);

interface ParsedTx {
  version: Uint8Array;
  segwit: boolean;
  inputs: Array<{ outpoint: Uint8Array; txid: string; vout: number; scriptSig: Uint8Array; sequence: Uint8Array }>;
  outputs: Array<{ raw: Uint8Array; value: bigint; script: string }>;
  witnesses: Uint8Array[][];
  lockTime: Uint8Array;
}

/** A raw transaction, parsed here (not by the library that built it). */
function parseTx(b: Uint8Array): ParsedTx {
  let o = 0;
  const take = (n: number): Uint8Array => {
    if (o + n > b.length) throw new Error('truncated transaction');
    o += n;
    return b.slice(o - n, o);
  };
  const vi = (): number => {
    const f = take(1)[0]!;
    if (f < 0xfd) return f;
    if (f === 0xfd) {
      const x = take(2);
      return x[0]! | (x[1]! << 8);
    }
    throw new Error('varint too large for a test transaction');
  };
  const version = take(4);
  const segwit = b[o] === 0 && b[o + 1] === 1;
  if (segwit) o += 2;
  const inputs: ParsedTx['inputs'] = [];
  for (let i = vi(); i > 0; i--) {
    const outpoint = take(36);
    const scriptSig = take(vi());
    const sequence = take(4);
    const v = outpoint.slice(32);
    inputs.push({ outpoint, txid: hex(outpoint.slice(0, 32).reverse()), vout: v[0]! | (v[1]! << 8) | (v[2]! << 16) | (v[3]! << 24), scriptSig, sequence });
  }
  const outputs: ParsedTx['outputs'] = [];
  for (let i = vi(); i > 0; i--) {
    const start = o;
    const value = take(8).reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
    const script = hex(take(vi()));
    outputs.push({ raw: b.slice(start, o), value, script });
  }
  const witnesses: Uint8Array[][] = [];
  if (segwit) {
    for (let i = 0; i < inputs.length; i++) {
      const items: Uint8Array[] = [];
      for (let n = vi(); n > 0; n--) items.push(take(vi()));
      witnesses.push(items);
    }
  }
  const lockTime = take(4);
  if (o !== b.length) throw new Error('trailing bytes');
  return { version, segwit, inputs, outputs, witnesses, lockTime };
}

const serializeInputs = (t: ParsedTx, scriptFor: (i: number) => Uint8Array): Uint8Array =>
  cat(varint(t.inputs.length), ...t.inputs.map((x, i) => cat(x.outpoint, withLen(scriptFor(i)), x.sequence)));
const serializeOutputs = (t: ParsedTx): Uint8Array => cat(varint(t.outputs.length), ...t.outputs.map((x) => x.raw));

/** txid: double SHA-256 of the serialization without witnesses, byte-reversed. */
const txidOf = (t: ParsedTx): string => hex(sha256d(cat(t.version, serializeInputs(t, (i) => t.inputs[i]!.scriptSig), serializeOutputs(t), t.lockTime)).reverse());

/** SIGHASH_ALL, legacy. */
const legacySighash = (t: ParsedTx, idx: number, prevScript: Uint8Array): Uint8Array =>
  sha256d(cat(t.version, serializeInputs(t, (i) => (i === idx ? prevScript : new Uint8Array())), serializeOutputs(t), t.lockTime, le(1, 4)));

/** SIGHASH_ALL, BIP143 (P2WPKH: scriptCode = the P2PKH script of the key hash). */
function bip143Sighash(t: ParsedTx, idx: number, keyHash: string, amount: bigint): Uint8Array {
  const input = t.inputs[idx]!;
  return sha256d(
    cat(
      t.version,
      sha256d(cat(...t.inputs.map((x) => x.outpoint))),
      sha256d(cat(...t.inputs.map((x) => x.sequence))),
      input.outpoint,
      withLen(unhex(`76a914${keyHash}88ac`)),
      le(amount, 8),
      input.sequence,
      sha256d(cat(...t.outputs.map((x) => x.raw))),
      t.lockTime,
      le(1, 4),
    ),
  );
}

/** Checks a DER signature + SIGHASH_ALL byte against `hash` and the test key. */
function assertSig(sigWithType: Uint8Array, pub: Uint8Array, hash: Uint8Array, what: string): void {
  assert.equal(hex(pub), PUB, `${what}: the test key's compressed public key`);
  assert.equal(sigWithType[sigWithType.length - 1], 1, `${what}: SIGHASH_ALL`);
  const sig = secp256k1.Signature.fromDER(sigWithType.slice(0, -1));
  assert.ok(secp256k1.verify(sig, hash, pub), `${what}: the signature verifies`);
}

/** Splits a P2PKH scriptSig (push sig, push key). */
function scriptSigParts(s: Uint8Array): [Uint8Array, Uint8Array] {
  const sigLen = s[0]!;
  const sig = s.slice(1, 1 + sigLen);
  const keyLen = s[1 + sigLen]!;
  const key = s.slice(2 + sigLen, 2 + sigLen + keyLen);
  assert.equal(2 + sigLen + keyLen, s.length, 'scriptSig = <sig> <pubkey>, nothing else');
  return [sig, key];
}

/** A legacy transaction paying `outputs` (a funding transaction for the Dogecoin wallet). */
function legacyTx(outputs: Array<{ script: string; value: bigint }>, salt: number): { hex: string; txid: string } {
  const raw = cat(
    le(1, 4),
    varint(1),
    le(BigInt(salt) * 0x1000001n + 7n, 32),
    le(0, 4),
    varint(0),
    le(0xffffffff, 4),
    varint(outputs.length),
    ...outputs.map((x) => cat(le(x.value, 8), withLen(unhex(x.script)))),
    le(0, 4),
  );
  return { hex: hex(raw), txid: hex(sha256d(raw).reverse()) };
}

// --- a fake network ---------------------------------------------------------------------------------

type Reply = { status?: number; json?: unknown; text?: string };
type Routes = Record<string, Reply | ((body: string | null) => Reply)>;
interface Seen {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
}

function install(routes: Routes): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body == null ? null : String(init.body);
    seen.push({ method, url, body, headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) } });
    const r = routes[`${method} ${url}`];
    if (!r) throw new TypeError(`fake fetch: no route for ${method} ${url}`);
    const reply = typeof r === 'function' ? r(body) : r;
    return new Response(reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? ''), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return seen;
}

// Recorded shapes (2026-10-03).
const MEMPOOL_FEES = { fastestFee: 6, halfHourFee: 5, hourFee: 4, economyFee: 2, minimumFee: 1 };
const LTCSPACE_FEES = { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
const esploraUtxo = (txid: string, vout: number, value: number, confirmed: boolean) => ({
  txid,
  vout,
  status: confirmed
    ? { confirmed: true, block_height: 922973, block_hash: '000000000000000000007bf7cf6e6504d151b7fa42e70385e8c8d174e17cdaec', block_time: 1762766581 }
    : { confirmed: false },
  value,
});
const blockbookUtxo = (txid: string, vout: number, value: bigint, confirmations: number) =>
  confirmations > 0 ? { txid, vout, value: value.toString(), height: 6385234, confirmations } : { txid, vout, value: value.toString(), confirmations: 0, lockTime: 6400019 };

const T1 = 'a1'.repeat(32);
const T2 = 'b2'.repeat(32);
/** Bitcoin wallet: 50,000 sat confirmed + 30,000 sat still in the mempool. */
const BTC_UTXOS = [esploraUtxo(T1, 0, 50_000, true), esploraUtxo(T2, 1, 30_000, false)];
const BTC_AMOUNTS: Record<string, bigint> = { [`${T1}:0`]: 50_000n, [`${T2}:1`]: 30_000n };

const btcWorld = (o: { utxos?: unknown; fees?: unknown; feesStatus?: number } = {}): Routes => ({
  [`GET ${MEMPOOL}/address/${BTC_ME}/utxo`]: { json: o.utxos ?? BTC_UTXOS },
  [`GET ${MEMPOOL}/v1/fees/recommended`]: { status: o.feesStatus ?? 200, json: o.fees ?? MEMPOOL_FEES },
});

/** Decodes a prepared send both ways; returns the parsed transaction. */
function decoded(p: PreparedSend): { lib: Transaction; t: ParsedTx; raw: Uint8Array } {
  const raw = unhex(p.request.body);
  const lib = Transaction.fromRaw(raw, { allowUnknownOutputs: true });
  const t = parseTx(raw);
  assert.equal(p.txid, lib.id, 'the txid is the transaction id (btc-signer)');
  assert.equal(p.txid, txidOf(t), 'the txid is the transaction id (hashed here)');
  assert.equal(lib.outputsLength, t.outputs.length);
  return { lib, t, raw };
}

/** Segwit inputs: every one signed by the test key over BIP143, computed here. */
function assertWitnessSigned(t: ParsedTx, amounts: Record<string, bigint>): void {
  assert.ok(t.segwit, 'a segwit transaction');
  t.inputs.forEach((input, i) => {
    assert.equal(input.scriptSig.length, 0, 'P2WPKH: empty scriptSig');
    const w = t.witnesses[i]!;
    assert.equal(w.length, 2, 'witness = <sig> <pubkey>');
    const amount = amounts[`${input.txid}:${input.vout}`];
    assert.ok(amount !== undefined, `input ${input.txid}:${input.vout} is one of the wallet's`);
    assertSig(w[0]!, w[1]!, bip143Sighash(t, i, H160, amount!), `input ${i}`);
  });
}

// --- addresses, origins, isWrite -------------------------------------------------------------------

test('addresses: key 1 gives the BIP173 vector and its Litecoin / Dogecoin twins; each passes the app\'s own validator', () => {
  assert.equal(bitcoin.address(KEYS), BTC_ME);
  assert.equal(litecoin.address(KEYS), LTC_ME);
  assert.equal(dogecoin.address(KEYS), DOGE_ME);
  // Derived again here, without the signing library.
  const h160 = ripemd160(sha256(secp256k1.getPublicKey(KEYS.secp256k1, true)));
  assert.equal(hex(h160), H160);
  const words = [0, ...convertBits(Array.from(h160), 8, 5, true)!];
  assert.equal(bech32Encode('bc', words), BTC_ME);
  assert.equal(bech32Encode('ltc', words), LTC_ME);
  assert.equal(base58CheckEncode(Uint8Array.from([0x1e, ...h160])), DOGE_ME);
  assert.equal(addressProblem('bitcoin', BTC_ME), null);
  assert.equal(addressProblem('litecoin', LTC_ME), null);
  assert.equal(addressProblem('dogecoin', DOGE_ME), null);
  // Another key, another address; pure (no fetch installed that would answer).
  const other = nativeKeysFromHex(`0x${'11'.repeat(32)}`);
  for (const [chain, kind] of [[bitcoin, 'bitcoin'], [litecoin, 'litecoin'], [dogecoin, 'dogecoin']] as const) {
    const a = chain.address(other);
    assert.notEqual(a, chain.address(KEYS));
    assert.equal(addressProblem(kind, a), null, `${kind} ${a}`);
  }
});

test('chains: kind / chainKey / label, and https API origins only', () => {
  assert.deepEqual([bitcoin.kind, bitcoin.chainKey, bitcoin.label], ['bitcoin', 'BTC', 'Bitcoin']);
  assert.deepEqual([litecoin.kind, litecoin.chainKey, litecoin.label], ['litecoin', 'LTC', 'Litecoin']);
  assert.deepEqual([dogecoin.kind, dogecoin.chainKey, dogecoin.label], ['dogecoin', 'DOGE', 'Dogecoin']);
  assert.deepEqual(bitcoin.origins, ['https://mempool.space', 'https://blockstream.info']);
  assert.deepEqual(litecoin.origins, ['https://litecoinspace.org', 'https://litecoin.atomicwallet.io']);
  assert.deepEqual(dogecoin.origins, ['https://dogecoin.atomicwallet.io', 'https://api.blockcypher.com']);
  for (const c of [bitcoin, litecoin, dogecoin]) for (const o of c.origins) assert.equal(new URL(o).origin, o);
});

test('isWrite: the broadcast POSTs (and any write-shaped request) are writes; every read is a read', () => {
  const w = (c: NativeChain, url: string, method: string) => c.isWrite(new URL(url), method, method === 'GET' ? null : 'ab');
  assert.equal(w(bitcoin, `${MEMPOOL}/tx`, 'POST'), true);
  assert.equal(w(litecoin, `${LTCSPACE}/tx`, 'POST'), true);
  assert.equal(w(dogecoin, `${DOGE_BB}/api/v2/sendtx/`, 'POST'), true);
  assert.equal(w(dogecoin, `${DOGE_BB}/api/v2/sendtx/0100abcd`, 'GET'), true, 'Blockbook broadcasts on a GET too');
  assert.equal(w(dogecoin, `${BCY}/txs/push`, 'POST'), true);
  assert.equal(w(dogecoin, `${BCY}/txs/push`, 'GET'), true);
  assert.equal(w(bitcoin, `${MEMPOOL}/tx`, 'PUT'), true);
  for (const [c, url] of [
    [bitcoin, `${MEMPOOL}/address/${BTC_ME}/utxo`],
    [bitcoin, `${MEMPOOL}/v1/fees/recommended`],
    [bitcoin, `${MEMPOOL}/tx/${T1}/status`],
    [bitcoin, `${MEMPOOL}/tx/${T1}/hex`],
    [bitcoin, `${BLOCKSTREAM}/fee-estimates`],
    [litecoin, `${LTC_BB}/api/v2/utxo/${LTC_ME}`],
    [dogecoin, `${DOGE_BB}/api/v2/tx/${T1}`],
    [dogecoin, `${DOGE_BB}/api/v2/estimatefee/2`],
    [dogecoin, `${BCY}/addrs/${DOGE_ME}?unspentOnly=true`],
    [dogecoin, `${BCY}/txs/${T1}?includeHex=true`],
  ] as const) {
    assert.equal(w(c, url, 'GET'), false, url);
  }
});

// --- balance ---------------------------------------------------------------------------------------

test('balance: confirmed + unconfirmed UTXOs, exact base units; an unknown address is 0', async () => {
  install({
    ...btcWorld(),
    [`GET ${MEMPOOL}/address/${BTC_TO}/utxo`]: { json: [] },
    [`GET ${DOGE_BB}/api/v2/utxo/${DOGE_ME}`]: { json: [blockbookUtxo(T1, 0, 12345678901234567890n, 14786), blockbookUtxo(T2, 3, 10n, 0)] },
  });
  assert.equal(await bitcoin.balance(BTC_ME, BTC), 80_000n);
  assert.equal(await bitcoin.balance(BTC_TO, BTC), 0n);
  assert.equal(await dogecoin.balance(DOGE_ME, DOGE), 12345678901234567900n, 'string values stay exact beyond 2^53');
});

test('balance: refuses another coin, a token and an address of another chain; falls back when the first API fails', async () => {
  const seen = install({
    [`GET ${MEMPOOL}/address/${BTC_ME}/utxo`]: { status: 503, text: '<html>503 Service Temporarily Unavailable</html>' },
    [`GET ${BLOCKSTREAM}/address/${BTC_ME}/utxo`]: { json: [esploraUtxo(T1, 0, 1_000, true)] },
  });
  await assert.rejects(bitcoin.balance(BTC_ME, LTC), /only its own coin BTC/);
  await assert.rejects(bitcoin.balance(BTC_ME, { symbol: 'USDC', native: false, token: 'x', decimals: 6 }), /a token/);
  await assert.rejects(bitcoin.balance(LTC_ME, BTC), /not a Bitcoin address/);
  assert.equal(seen.length, 0, 'nothing asked for a refused call');
  assert.equal(await bitcoin.balance(BTC_ME, BTC), 1_000n);
  assert.deepEqual(seen.map((s) => s.url), [`${MEMPOOL}/address/${BTC_ME}/utxo`, `${BLOCKSTREAM}/address/${BTC_ME}/utxo`]);
});

test('balance: an API that answers garbage, or every API down, is an error - not a zero', async () => {
  install({
    [`GET ${MEMPOOL}/address/${BTC_ME}/utxo`]: { status: 400, text: 'Too many unspent transaction outputs (>500). Contact support to raise limits.' },
    [`GET ${BLOCKSTREAM}/address/${BTC_ME}/utxo`]: { json: [{ txid: T1, vout: 0, value: 1.5, status: { confirmed: true } }] },
  });
  await assert.rejects(bitcoin.balance(BTC_ME, BTC), (e: Error) => /Too many unspent/.test(e.message) && /not an amount/.test(e.message));
});

// --- Bitcoin prepare -------------------------------------------------------------------------------

test('prepare BTC max: every UTXO in, one output of total - fee, signed (BIP143 checked here), txid known, the request is the raw hex', async () => {
  const seen = install(btcWorld());
  const p = await bitcoin.prepare(KEYS, BTC, BTC_TO, 'max');
  const { lib, t } = decoded(p);
  assert.equal(t.inputs.length, 2);
  assert.deepEqual(t.inputs.map((i) => `${i.txid}:${i.vout}`).sort(), Object.keys(BTC_AMOUNTS).sort());
  assert.equal(lib.outputsLength, 1);
  const out = lib.getOutput(0);
  assert.equal(hex(out.script!), hex(OutScript.encode(Address().decode(BTC_TO))));
  // 2 P2WPKH in, 1 P2WPKH out: 178 vbytes (upper bound) x halfHourFee 5.
  assert.equal(estimateVsize('wpkh', 2, [out.script!]), 178);
  assert.equal(p.fee, 890n);
  assert.equal(p.amount, 79_110n);
  assert.equal(out.amount, p.amount);
  assert.equal(80_000n - out.amount!, p.fee, 'inputs - outputs = the fee');
  assert.ok(lib.vsize <= 178 && p.fee >= BigInt(lib.vsize) * 5n, `paid rate >= 5 sat/vB (vsize ${lib.vsize})`);
  assertWitnessSigned(t, BTC_AMOUNTS);
  assert.deepEqual(p.request, { url: `${MEMPOOL}/tx`, method: 'POST', headers: { 'content-type': 'text/plain' }, body: p.request.body });
  assert.match(p.request.body, /^[0-9a-f]+$/);
  assert.equal(p.explorer, `https://mempool.space/tx/${p.txid}`);
  assert.ok(seen.every((s) => s.method === 'GET'), 'prepare sends nothing');
  assert.equal(bitcoin.isWrite(new URL(p.request.url), p.request.method, p.request.body), true);
});

test('prepare BTC fixed amount: the receiver gets exactly it, the change returns to the same address', async () => {
  install(btcWorld());
  const p = await bitcoin.prepare(KEYS, BTC, BTC_TO_P2SH, 20_000n);
  const { lib, t } = decoded(p);
  assert.equal(lib.outputsLength, 2);
  assert.equal(t.outputs[0]!.script, hex(OutScript.encode(Address().decode(BTC_TO_P2SH))));
  assert.match(t.outputs[0]!.script, /^a914[0-9a-f]{40}87$/, 'P2SH');
  assert.equal(t.outputs[0]!.value, 20_000n);
  assert.equal(t.outputs[1]!.script, WPKH_ME, 'change to the test wallet');
  // 2 in, P2SH + P2WPKH out: 210 vbytes x 5.
  assert.equal(p.fee, 1_050n);
  assert.equal(t.outputs[1]!.value, 80_000n - 20_000n - 1_050n);
  assert.equal(p.amount, 20_000n);
  assertWitnessSigned(t, BTC_AMOUNTS);
});

test('prepare BTC fixed amount: change at or below dust goes to the fee, not to a dust output', async () => {
  install(btcWorld());
  const p = await bitcoin.prepare(KEYS, BTC, BTC_TO_P2SH, 80_000n - 1_050n - 500n);
  const { lib, t } = decoded(p);
  assert.equal(lib.outputsLength, 1);
  assert.equal(p.fee, 1_550n, 'the 500 sat change is folded into the fee');
  assert.equal(t.outputs[0]!.value, p.amount);
  assertWitnessSigned(t, BTC_AMOUNTS);
});

test('prepare BTC refusals: dust, too little, the fee above the amount, an empty wallet, a wrong address', async () => {
  install({ ...btcWorld(), [`GET ${MEMPOOL}/address/${BTC_TO}/utxo`]: { json: [] } });
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO, 545n), /0.00000545 BTC is below the dust limit of 0.00000546 BTC/);
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO_P2SH, 79_500n), /too little for 0.000795 BTC plus the 0.00000895 BTC fee/);
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO, 0n), /positive bigint/);
  await assert.rejects(bitcoin.prepare(KEYS, BTC, LTC_TO_LEGACY, 'max'), /not a Bitcoin address \(format\)/);
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO.slice(0, -1) + 'p', 'max'), /not a Bitcoin address \(checksum\)/);
  await assert.rejects(bitcoin.prepare(KEYS, BTC, 'bc1pfeessrawgf', 'max'), /p2a address, not one the runner sends BTC to/);
  await assert.rejects(bitcoin.prepare(KEYS, LTC, BTC_TO, 'max'), /only its own coin BTC/);

  install(btcWorld({ utxos: [esploraUtxo(T1, 0, 100_000, true)] }));
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO, 600n), /the fee \(0.00000705 BTC\) would be more than the 0.000006 BTC sent/);
  install(btcWorld({ utxos: [esploraUtxo(T1, 0, 1_000, true)] }));
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO, 'max'), /leaves 0.0000045 BTC, below the dust limit/);
  install(btcWorld({ utxos: [] }));
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO, 'max'), /holds no BTC to send/);
});

test('prepare BTC fee rate: never below 2 sat/vB, refused above the cap, and no guessing when no API knows it', async () => {
  install(btcWorld({ fees: { ...MEMPOOL_FEES, halfHourFee: 1, fastestFee: 1 } }));
  const low = await bitcoin.prepare(KEYS, BTC, BTC_TO, 'max');
  assert.equal(low.fee, 178n * 2n, 'the 2 sat/vB floor');

  install(btcWorld({ fees: { ...MEMPOOL_FEES, halfHourFee: 301, fastestFee: 400 } }));
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO, 'max'), /above the runner's cap of 300/);

  // mempool.space's fee endpoint down: blockstream.info's per-target table (3 blocks), rounded up.
  install({
    ...btcWorld({ feesStatus: 502, fees: {} }),
    [`GET ${MEMPOOL}/fee-estimates`]: { status: 502, text: 'Bad Gateway' },
    [`GET ${BLOCKSTREAM}/v1/fees/recommended`]: { status: 404, text: 'Not Found' },
    [`GET ${BLOCKSTREAM}/fee-estimates`]: { json: { '1': 4.185, '2': 4.185, '3': 3.76, '6': 0.594, '144': 0.25 } },
  });
  const fb = await bitcoin.prepare(KEYS, BTC, BTC_TO, 'max');
  assert.equal(fb.fee, 178n * 4n);

  install({
    ...btcWorld({ feesStatus: 502, fees: {} }),
    [`GET ${MEMPOOL}/fee-estimates`]: { status: 502, text: 'Bad Gateway' },
    [`GET ${BLOCKSTREAM}/v1/fees/recommended`]: { status: 404, text: 'Not Found' },
    [`GET ${BLOCKSTREAM}/fee-estimates`]: { status: 429, text: 'Too Many Requests' },
  });
  await assert.rejects(bitcoin.prepare(KEYS, BTC, BTC_TO, 'max'), /no API could tell the fee rate.*Too Many Requests/);
});

test('costs BTC: on the high side (fast rate, a change output, every UTXO); nothing has to stay', async () => {
  install(btcWorld());
  const c = await bitcoin.costs(BTC_ME, BTC, BTC_TO);
  // 2 in, 2 P2WPKH out: 209 vbytes x fastestFee 6.
  assert.equal(estimateVsize('wpkh', 2, [unhex(WPKH_ME), unhex(WPKH_ME)]), 209);
  assert.deepEqual(c, { fee: 209n * 6n, keep: 0n, nativeNeeded: 0n });
  const p = await bitcoin.prepare(KEYS, BTC, BTC_TO, 10_000n);
  assert.ok(c.fee >= p.fee, `costs ${c.fee} >= the prepared fee ${p.fee}`);
  await assert.rejects(bitcoin.costs(BTC_ME, BTC, DOGE_TO), /not a Bitcoin address/);

  install({ ...btcWorld({ utxos: [] }) });
  const empty = await bitcoin.costs(BTC_ME, BTC, BTC_TO);
  assert.equal(empty.fee, BigInt(estimateVsize('wpkh', 1, [unhex(WPKH_ME), unhex(WPKH_ME)])) * 6n, 'an empty wallet is priced as one input');
});

// --- Litecoin --------------------------------------------------------------------------------------

test('prepare LTC: P2WPKH spend to a P2WSH, a legacy L... and an old 3... address; fee floor 10 lit/vB over the API\'s 1', async () => {
  const L1 = 'c3'.repeat(32);
  install({
    [`GET ${LTCSPACE}/address/${LTC_ME}/utxo`]: { json: [esploraUtxo(L1, 2, 1_000_000, true)] },
    [`GET ${LTCSPACE}/v1/fees/recommended`]: { json: LTCSPACE_FEES },
  });
  const amounts = { [`${L1}:2`]: 1_000_000n };
  const max = await litecoin.prepare(KEYS, LTC, LTC_TO_P2WSH, 'max');
  const m = decoded(max);
  assert.equal(m.t.outputs.length, 1);
  assert.equal(m.t.outputs[0]!.script.length, 68, 'a 34-byte P2WSH script');
  // 1 in, 1 P2WSH out: 122 vbytes x 10.
  assert.equal(max.fee, 1_220n);
  assert.equal(max.amount, 1_000_000n - 1_220n);
  assertWitnessSigned(m.t, amounts);
  assert.equal(max.request.url, `${LTCSPACE}/tx`);
  assert.equal(max.explorer, `https://litecoinspace.org/tx/${max.txid}`);

  const fixed = await litecoin.prepare(KEYS, LTC, LTC_TO_LEGACY, 300_000n);
  const f = decoded(fixed);
  assert.equal(f.t.outputs.length, 2);
  assert.match(f.t.outputs[0]!.script, /^76a914[0-9a-f]{40}88ac$/);
  assert.equal(f.t.outputs[0]!.value, 300_000n);
  assert.equal(f.t.outputs[1]!.script, WPKH_ME);
  assertWitnessSigned(f.t, amounts);

  const old = await litecoin.prepare(KEYS, LTC, BTC_TO_P2SH, 300_000n);
  assert.match(decoded(old).t.outputs[0]!.script, /^a914[0-9a-f]{40}87$/, "Litecoin's old 3... P2SH form");
  await assert.rejects(litecoin.prepare(KEYS, LTC, BTC_TO, 'max'), /not a Litecoin address/);
  await assert.rejects(litecoin.prepare(KEYS, LTC, LTC_TO_LEGACY, 5_459n), /below the dust limit of 0.0000546 LTC/);
});

test('LTC: litecoinspace down - Blockbook answers the reads; the fee floor stands in for a missing estimate; the broadcast stays on litecoinspace', async () => {
  const L1 = 'c3'.repeat(32);
  install({
    [`GET ${LTCSPACE}/address/${LTC_ME}/utxo`]: { status: 502, text: 'error code: 502' },
    [`GET ${LTCSPACE}/v1/fees/recommended`]: { status: 502, text: 'error code: 502' },
    [`GET ${LTCSPACE}/fee-estimates`]: { status: 404, text: 'endpoint does not exist "/fee-estimates"' },
    [`GET ${LTC_BB}/api/v2/utxo/${LTC_ME}`]: { json: [blockbookUtxo(L1, 2, 1_000_000n, 99448)] },
    [`GET ${LTC_BB}/api/v2/estimatefee/2`]: { status: 503, text: 'busy' },
  });
  assert.equal(await litecoin.balance(LTC_ME, LTC), 1_000_000n);
  const p = await litecoin.prepare(KEYS, LTC, LTC_TO_P2WSH, 'max');
  assert.equal(p.fee, 1_220n);
  assert.equal(p.request.url, `${LTCSPACE}/tx`);
  assertWitnessSigned(decoded(p).t, { [`${L1}:2`]: 1_000_000n });
});

// --- Dogecoin --------------------------------------------------------------------------------------

/** Dogecoin wallet: 5 DOGE confirmed + 2.5 DOGE unconfirmed, each with its funding transaction. */
const FUND_A = legacyTx([{ script: `76a914${'00'.repeat(20)}88ac`, value: 1n }, { script: PKH_ME, value: 500_000_000n }], 1);
const FUND_B = legacyTx([{ script: PKH_ME, value: 250_000_000n }], 2);
const dogeWorld = (extra: Routes = {}): Routes => ({
  [`GET ${DOGE_BB}/api/v2/utxo/${DOGE_ME}`]: { json: [blockbookUtxo(FUND_A.txid, 1, 500_000_000n, 14786), blockbookUtxo(FUND_B.txid, 0, 250_000_000n, 0)] },
  [`GET ${DOGE_BB}/api/v2/tx/${FUND_A.txid}`]: { json: { txid: FUND_A.txid, version: 1, confirmations: 14786, blockHeight: 6385234, hex: FUND_A.hex } },
  [`GET ${DOGE_BB}/api/v2/tx/${FUND_B.txid}`]: { json: { txid: FUND_B.txid, version: 1, confirmations: 0, blockHeight: -1, hex: FUND_B.hex } },
  [`GET ${DOGE_BB}/api/v2/estimatefee/2`]: { json: { result: '0.48363738' } },
  ...extra,
});

/** Legacy inputs: every one signed by the test key over the legacy sighash, computed here. */
function assertLegacySigned(t: ParsedTx): void {
  assert.ok(!t.segwit, 'no segwit on Dogecoin');
  assert.equal(hex(t.version), '01000000', 'version 1');
  t.inputs.forEach((input, i) => {
    const [sig, key] = scriptSigParts(input.scriptSig);
    assertSig(sig, key, legacySighash(t, i, unhex(PKH_ME)), `input ${i}`);
  });
}

test('prepare DOGE max: legacy P2PKH, the previous transactions checked, 1 DOGE/kB, signed (legacy sighash checked here)', async () => {
  const seen = install(dogeWorld());
  const p = await dogecoin.prepare(KEYS, DOGE, DOGE_TO, 'max');
  const { lib, t, raw } = decoded(p);
  assert.deepEqual(t.inputs.map((i) => `${i.txid}:${i.vout}`), [`${FUND_A.txid}:1`, `${FUND_B.txid}:0`]);
  assert.equal(lib.outputsLength, 1);
  assert.equal(t.outputs[0]!.script, hex(OutScript.encode(Address({ bech32: '', pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e }).decode(DOGE_TO))));
  // 2 P2PKH in, 1 P2PKH out: 342 bytes (upper bound) x 100,000 koinu (1 DOGE per kB).
  assert.equal(p.fee, 34_200_000n);
  assert.equal(p.amount, 750_000_000n - 34_200_000n);
  assert.equal(t.outputs[0]!.value, p.amount);
  assert.ok(raw.length <= 342 && p.fee >= BigInt(raw.length) * 100_000n, `paid >= 1 DOGE/kB (${raw.length} bytes)`);
  assert.equal(hex(sha256d(raw).reverse()), p.txid, 'legacy: the txid is the hash of the whole transaction');
  assertLegacySigned(t);
  assert.deepEqual(p.request, { url: `${DOGE_BB}/api/v2/sendtx/`, method: 'POST', headers: { 'content-type': 'text/plain' }, body: hex(raw) });
  assert.equal(p.explorer, `https://blockchair.com/dogecoin/transaction/${p.txid}`);
  assert.ok(seen.every((s) => s.method === 'GET'));
});

test('prepare DOGE fixed amount: 1 DOGE out, change back to D..., all above the 0.01 DOGE dust', async () => {
  install(dogeWorld());
  const p = await dogecoin.prepare(KEYS, DOGE, DOGE_TO, 100_000_000n);
  const { t } = decoded(p);
  assert.equal(t.outputs.length, 2);
  assert.equal(t.outputs[0]!.value, 100_000_000n);
  assert.equal(t.outputs[1]!.script, PKH_ME);
  assert.equal(p.fee, 37_600_000n, '376 bytes x 100,000 koinu');
  assert.equal(t.outputs[1]!.value, 750_000_000n - 100_000_000n - 37_600_000n);
  assertLegacySigned(t);

  await assert.rejects(dogecoin.prepare(KEYS, DOGE, DOGE_TO, 999_999n), /0.00999999 DOGE is below the dust limit of 0.01 DOGE/);
  await assert.rejects(dogecoin.prepare(KEYS, DOGE, BTC_TO, 'max'), /not a Dogecoin address/);
  await assert.rejects(dogecoin.prepare(KEYS, DOGE, 'doge1qw508d6qejxtdg4y5r3zarvary0c5xw7kq8z2z5', 'max'), /not a Dogecoin address \(format\)/);
});

test('prepare DOGE: a previous transaction that does not hash to its txid, pays someone else, or holds another amount is refused', async () => {
  // Served for A: B's transaction.
  install(dogeWorld({ [`GET ${DOGE_BB}/api/v2/tx/${FUND_A.txid}`]: { json: { hex: FUND_B.hex } } }));
  await assert.rejects(dogecoin.prepare(KEYS, DOGE, DOGE_TO, 'max'), new RegExp(`served for ${FUND_A.txid} hashes to ${FUND_B.txid}`));
  // A UTXO "of ours" whose transaction (a real one, recorded) pays DH5y...
  const REAL = '484c94145e97c0b2dd96912c1f056c9e05c8d358ab96ea429c51039d75d0d3c4';
  const REAL_HEX =
    '01000000010354f70e38ca0ed6ca899a0a90b3181737a92b7253d56d52ec84628a8be00afb010000006b483045022100e40cb3394af03ee7d36fc82043ca83fe2277ee7c76c6ff5e4978adcf585a9060022057c4edc62d7cd42c424e56711333bddfe8b86f01f87fc9f6fe57fea41e1233cb012103da47ef0fb4175eb7e203f701b33e5cf12a12aa9116112b907bb7f4f05c38dfe2ffffffff023b34ba38000000001976a914830a7420e63d76244ff7cbd1c248e94c1446325988acbe1af867010000001976a9147c6c616ba48979099d53b6a64ae147dce5501c7388ac00000000';
  install({
    ...dogeWorld(),
    [`GET ${DOGE_BB}/api/v2/utxo/${DOGE_ME}`]: { json: [blockbookUtxo(REAL, 0, 951_727_163n, 14786)] },
    [`GET ${DOGE_BB}/api/v2/tx/${REAL}`]: { json: { txid: REAL, confirmations: 14787, hex: REAL_HEX } },
  });
  await assert.rejects(dogecoin.prepare(KEYS, DOGE, DOGE_TO, 'max'), /:0 does not pay the test wallet/);
  // The API inflates an amount: the previous transaction says otherwise.
  install({
    ...dogeWorld(),
    [`GET ${DOGE_BB}/api/v2/utxo/${DOGE_ME}`]: { json: [blockbookUtxo(FUND_B.txid, 0, 900_000_000n, 3)] },
  });
  await assert.rejects(dogecoin.prepare(KEYS, DOGE, DOGE_TO, 'max'), /holds 250000000, the API said 900000000/);
});

test('DOGE: Blockbook down - BlockCypher answers UTXOs and raw transactions; the broadcast request stays on Blockbook', async () => {
  const bcyRef = (txid: string, n: number, value: number, confirmations: number) => ({
    tx_hash: txid, block_height: confirmations ? 6385234 : -1, tx_input_n: -1, tx_output_n: n, value, ref_balance: 0, spent: false, confirmations,
    ...(confirmations ? { confirmed: '2026-09-22T19:10:21Z' } : { received: '2026-10-03T16:00:00Z' }), double_spend: false, script: PKH_ME,
  });
  const seen = install({
    [`GET ${DOGE_BB}/api/v2/utxo/${DOGE_ME}`]: { status: 502, text: 'error code: 502' },
    [`GET ${DOGE_BB}/api/v2/tx/${FUND_A.txid}`]: { status: 502, text: 'error code: 502' },
    [`GET ${DOGE_BB}/api/v2/tx/${FUND_B.txid}`]: { status: 502, text: 'error code: 502' },
    [`GET ${DOGE_BB}/api/v2/estimatefee/2`]: { status: 502, text: 'error code: 502' },
    [`GET ${BCY}/addrs/${DOGE_ME}?unspentOnly=true&includeScript=true&limit=2000`]: {
      json: {
        address: DOGE_ME, total_received: 750000001, total_sent: 1, balance: 500000000, unconfirmed_balance: 250000000, final_balance: 750000000,
        n_tx: 3, unconfirmed_n_tx: 1, final_n_tx: 4,
        txrefs: [bcyRef(FUND_A.txid, 1, 500_000_000, 14793)],
        unconfirmed_txrefs: [bcyRef(FUND_B.txid, 0, 250_000_000, 0)],
      },
    },
    [`GET ${BCY}/txs/${FUND_A.txid}?includeHex=true`]: { json: { hash: FUND_A.txid, block_height: 6385234, confirmations: 14793, hex: FUND_A.hex } },
    [`GET ${BCY}/txs/${FUND_B.txid}?includeHex=true`]: { json: { hash: FUND_B.txid, block_height: -1, confirmations: 0, hex: FUND_B.hex } },
    [`GET ${BCY}`]: { json: { name: 'DOGE.main', height: 6400019, high_fee_per_kb: 179569147, medium_fee_per_kb: 52533952, low_fee_per_kb: 10976752 } },
  });
  assert.equal(await dogecoin.balance(DOGE_ME, DOGE), 750_000_000n);
  const p = await dogecoin.prepare(KEYS, DOGE, DOGE_TO, 'max');
  assert.equal(p.fee, 34_200_000n, 'BlockCypher\'s 0.53 DOGE/kB estimate is below the 1 DOGE/kB floor');
  assertLegacySigned(decoded(p).t);
  assert.equal(p.request.url, `${DOGE_BB}/api/v2/sendtx/`);
  assert.ok(seen.some((s) => s.url.startsWith(`${BCY}/txs/`)));

  const c = await dogecoin.costs(DOGE_ME, DOGE, DOGE_TO);
  // high_fee_per_kb 1.796 DOGE/kB = 179,570 koinu/byte (rounded up) x 376 bytes (2 in, 2 out).
  assert.deepEqual(c, { fee: 376n * 179_570n, keep: 0n, nativeNeeded: 0n });
});

// --- broadcast -------------------------------------------------------------------------------------

test('broadcast BTC: sends exactly the prepared request, returns the node\'s txid; refusals carry the node\'s words', async () => {
  install(btcWorld());
  const p = await bitcoin.prepare(KEYS, BTC, BTC_TO, 'max');
  const seen = install({ [`POST ${MEMPOOL}/tx`]: () => ({ text: p.txid }) });
  assert.equal(await bitcoin.broadcast(p), p.txid);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { method: 'POST', url: `${MEMPOOL}/tx`, body: p.request.body, headers: { 'content-type': 'text/plain' } });

  install({ [`POST ${MEMPOOL}/tx`]: { status: 400, text: 'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 100 < 178"}' } });
  await assert.rejects(bitcoin.broadcast(p), /refused the transaction \(HTTP 400\): sendrawtransaction RPC error: .*min relay fee not met/);
  install({ [`POST ${MEMPOOL}/tx`]: { text: T1 } });
  await assert.rejects(bitcoin.broadcast(p), new RegExp(`answered txid ${T1}, the signed transaction is ${p.txid}`));
  install({});
  await assert.rejects(bitcoin.broadcast(p), /no answer from mempool.space .* may still have gone out: https:\/\/mempool.space\/tx\//);
  await assert.rejects(litecoin.broadcast(p), /is not where Litecoin transactions are broadcast/);
});

test('broadcast DOGE: Blockbook {"result": txid}; {"error": ...} is the node refusing', async () => {
  install(dogeWorld());
  const p = await dogecoin.prepare(KEYS, DOGE, DOGE_TO, 'max');
  const seen = install({ [`POST ${DOGE_BB}/api/v2/sendtx/`]: (body) => ({ json: { result: body === p.request.body ? p.txid : 'wrong body' } }) });
  assert.equal(await dogecoin.broadcast(p), p.txid);
  assert.equal(seen[0]!.body, p.request.body);
  install({ [`POST ${DOGE_BB}/api/v2/sendtx/`]: { status: 400, json: { error: '-26: min relay fee not met, 0 < 100000' } } });
  await assert.rejects(dogecoin.broadcast(p), /dogecoin.atomicwallet.io refused the transaction \(HTTP 400\): -26: min relay fee not met/);
  install({ [`POST ${DOGE_BB}/api/v2/sendtx/`]: { status: 400, json: { error: { message: 'txn-mempool-conflict' } } } });
  await assert.rejects(dogecoin.broadcast(p), /txn-mempool-conflict/);
});

// --- confirmed -------------------------------------------------------------------------------------

test('confirmed: true in a block, null in the mempool or unknown, never throws for "not found"', async () => {
  const U = 'cf1092d1cd034c82eef32e5a3242bd52f0be2a8873117562fb196dda1461f6f3';
  install({
    [`GET ${MEMPOOL}/tx/${T1}/status`]: { json: { confirmed: true, block_height: 922973, block_hash: '000000000000000000007bf7cf6e6504d151b7fa42e70385e8c8d174e17cdaec', block_time: 1762766581 } },
    [`GET ${MEMPOOL}/tx/${U}/status`]: { json: { confirmed: false } },
    [`GET ${MEMPOOL}/tx/${T2}/status`]: { status: 404, text: 'Transaction not found' },
    [`GET ${DOGE_BB}/api/v2/tx/${T1}`]: { json: { txid: T1, confirmations: 3, blockHeight: 6400017, hex: '00' } },
    [`GET ${DOGE_BB}/api/v2/tx/${U}`]: { json: { txid: U, confirmations: 0, blockHeight: -1, hex: '00' } },
    [`GET ${DOGE_BB}/api/v2/tx/${T2}`]: { status: 400, json: { error: `Transaction '${T2}' not found` } },
  });
  assert.equal(await bitcoin.confirmed(T1), true);
  assert.equal(await bitcoin.confirmed(U.toUpperCase()), null);
  assert.equal(await bitcoin.confirmed(T2), null);
  assert.equal(await dogecoin.confirmed(T1), true);
  assert.equal(await dogecoin.confirmed(U), null);
  assert.equal(await dogecoin.confirmed(T2), null);
  await assert.rejects(bitcoin.confirmed('nope'), /not a txid/);
});

test('confirmed: the next API answers when one fails; all failing is an error, not a "no"', async () => {
  install({
    [`GET ${LTCSPACE}/tx/${T1}/status`]: { status: 503, text: 'Service Unavailable' },
    [`GET ${LTC_BB}/api/v2/tx/${T1}`]: { json: { txid: T1, confirmations: 1 } },
    [`GET ${MEMPOOL}/tx/${T1}/status`]: { status: 500, text: 'oops' },
    [`GET ${BLOCKSTREAM}/tx/${T1}/status`]: { status: 429, text: 'Too Many Requests' },
  });
  assert.equal(await litecoin.confirmed(T1), true);
  await assert.rejects(bitcoin.confirmed(T1), /no API could tell the status.*oops.*Too Many Requests/);
});
