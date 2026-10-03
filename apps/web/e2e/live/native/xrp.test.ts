/**
 * The XRP Ledger module (xrp.ts), offline: a fake fetch answers with the shapes
 * the public servers answered on 2026-10-03 (xrplcluster.com = rippled,
 * s1/s2.ripple.com = Clio). Nothing here talks to a network or uses a real key.
 *   npx tsx --test e2e/live/native/xrp.test.ts        (from apps/web)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { decode, deriveAddress, encodeForSigning, hashes, verifySignature } from 'xrpl';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { addressProblem, base58Encode } from '../../../src/trading/addresses';
import { nativeKeysFromHex } from './keys';
import type { NativeCoin, PreparedSend } from './types';
import { XRP_MAX_FEE, XRP_ORIGINS, xrp } from './xrp';

/** A fixed TEST key (never funded, never used anywhere real). */
const TEST_KEY = '0x492483aba1a41420c68c21ca348dd1130d45530863bea0fb3a69f7eb67ab39f1';
const KEYS = nativeKeysFromHex(TEST_KEY);
const ME = 'rDHyZB8NxpNnEsUKU7wCN8u6Mh1bXiDcA6';
const ME_PUB = '02053FF0369D75AC556FE04C1058A3767BEAC899014D7CEF49BA2948E79D0E328D';
/** Stand-ins for SoDEX deposit addresses: any valid r-address (fetch is fake). */
const DEST = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const NEW_DEST = 'rEBsWSAtNxGLQ7m4FhwQEaatwAwQFa5gWs';
const XRP: NativeCoin = { symbol: 'XRP', native: true, token: null, decimals: 6 };
const B58_XRP = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- a fake XRPL: JSON-RPC answers in the recorded shapes ------------------------------------------

interface Acct { Balance: string; Sequence: number; OwnerCount: number; Flags: number }
interface World {
  validated: Record<string, Acct>;
  /** The open ledger's view (defaults to `validated`). */
  current?: Record<string, Acct>;
  validatedIndex: number;
  fee: { base_fee: string; median_fee: string; minimum_fee: string; open_ledger_fee: string };
  reserveBase: number;
  reserveInc: number;
  queued?: number;
  /** Origins that answer tooBusy (the Clio servers did, once, on 2026-10-03). */
  busy?: string[];
  tx?: Record<string, Record<string, unknown>>;
  submit?: Record<string, unknown>;
}
interface Call { url: string; method: string; body: { method: string; params: Record<string, unknown>[] } }

function install(w: World): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Call['body'];
    calls.push({ url, method: init?.method ?? 'GET', body });
    const origin = new URL(url).origin;
    const p = body.params[0] ?? {};
    const reply = (result: Record<string, unknown>) => new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (w.busy?.includes(origin)) {
      return reply({ error: 'tooBusy', error_code: 9, error_message: 'The server is too busy to help you now.', status: 'error', type: 'response', request: body });
    }
    switch (body.method) {
      case 'server_info':
        return reply({
          info: {
            build_version: '3.4.1', complete_ledgers: '32570-107407551', server_state: 'full', load_factor: 1, network_id: 0,
            validated_ledger: { seq: w.validatedIndex, hash: '27153DA9FF7D6C11157F0BB7DD1B5FE6F1A6841A1E8A075BA3D30C5360DD5B52', age: 1, base_fee_xrp: 0.00001, reserve_base_xrp: w.reserveBase, reserve_inc_xrp: w.reserveInc },
          },
          status: 'success',
        });
      case 'fee':
        return reply({
          current_ledger_size: '63', current_queue_size: '0', drops: w.fee, expected_ledger_size: '2126', ledger_current_index: w.validatedIndex + 2,
          levels: { median_level: '128000', minimum_level: '256', open_ledger_level: '256', reference_level: '256' }, max_queue_size: '42520', status: 'success',
        });
      case 'account_info': {
        const current = p.ledger_index === 'current';
        const book = current ? (w.current ?? w.validated) : w.validated;
        const a = book[String(p.account)];
        const where = current ? { ledger_current_index: w.validatedIndex + 2, validated: false } : { ledger_hash: '32C5AB434C8C949BE15C041850D4B05815A30841AAE33A91D67F290A9CC47AC1', ledger_index: w.validatedIndex, validated: true };
        if (!a) return reply({ account: p.account, error: 'actNotFound', error_code: 19, error_message: 'Account not found.', ...where, request: { ...p, command: 'account_info' }, status: 'error' });
        return reply({
          account_data: { Account: p.account, ...a, LedgerEntryType: 'AccountRoot', PreviousTxnID: 'AA422A0AF62C58042BE3A243954CC1BD2560E2345F475E577F8E21F4D455BEA5', PreviousTxnLgrSeq: 106836736, index: '2B6AC232AA4C4BE41BF49D2459FA4A0347E1B543A4C92FCEE0821C0201E2E9A8' },
          account_flags: { requireDestinationTag: (a.Flags & 0x20000) !== 0, depositAuth: (a.Flags & 0x1000000) !== 0, disallowIncomingXRP: (a.Flags & 0x80000) !== 0 },
          ...(current && p.queue ? { queue_data: { txn_count: w.queued ?? 0 } } : {}),
          ...where,
          status: 'success',
        });
      }
      case 'tx': {
        const t = w.tx?.[String(p.transaction)];
        if (!t) {
          const ranged = p.min_ledger !== undefined && p.max_ledger !== undefined && Number(p.max_ledger) <= w.validatedIndex;
          return reply({ error: 'txnNotFound', error_code: 29, error_message: 'Transaction not found.', ...(p.min_ledger !== undefined ? { searched_all: ranged } : {}), request: { ...p, command: 'tx' }, status: 'error' });
        }
        return reply(t);
      }
      case 'submit':
        return reply(w.submit ?? { error: 'notImplemented', status: 'error' });
      default:
        return reply({ error: 'unknownCmd', status: 'error' });
    }
  }) as typeof fetch;
  return calls;
}

const world = (over: Partial<World> = {}): World => ({
  validated: { [ME]: { Balance: '25000000', Sequence: 104, OwnerCount: 0, Flags: 0 }, [DEST]: { Balance: '56775133590', Sequence: 44196, OwnerCount: 1, Flags: 0 } },
  validatedIndex: 107407551,
  fee: { base_fee: '10', median_fee: '5000', minimum_fee: '10', open_ledger_fee: '10' },
  reserveBase: 1,
  reserveInc: 0.2,
  ...over,
});

const sha512Half = (hex: string) => Buffer.from(sha512(Buffer.from(hex, 'hex')).slice(0, 32)).toString('hex').toUpperCase();

function decoded(p: PreparedSend): Record<string, unknown> {
  const body = JSON.parse(p.request.body) as { method: string; params: { tx_blob: string }[] };
  assert.equal(body.method, 'submit');
  return decode(body.params[0]!.tx_blob) as Record<string, unknown>;
}
const blobOf = (p: PreparedSend) => (JSON.parse(p.request.body) as { params: { tx_blob: string }[] }).params[0]!.tx_blob;

// --- address ---------------------------------------------------------------------------------------

test('xrp: the test key gives a fixed secp256k1 address = base58-XRP(0x00 + RIPEMD160(SHA256(pubkey))), valid for the app', () => {
  const a = xrp.address(KEYS);
  assert.equal(a, ME);
  const pub = secp256k1.getPublicKey(KEYS.secp256k1, true);
  assert.equal(Buffer.from(pub).toString('hex').toUpperCase(), ME_PUB);
  // Independent derivation: account id, version 0x00, double-SHA256 checksum, XRPL alphabet.
  const payload = Uint8Array.from([0x00, ...ripemd160(sha256(pub))]);
  const check = sha256(sha256(payload)).slice(0, 4);
  assert.equal(base58Encode(Uint8Array.from([...payload, ...check]), B58_XRP), ME);
  // xrpl's own derivation from the public key.
  assert.equal(deriveAddress(ME_PUB), ME);
  assert.equal(addressProblem('xrp', a), null);
  assert.equal(xrp.kind, 'xrp');
  assert.equal(xrp.chainKey, 'XRP');
  assert.equal(xrp.label, 'XRP Ledger');
  assert.deepEqual([...xrp.origins], [...XRP_ORIGINS]);
  for (const o of xrp.origins) assert.equal(new URL(o).origin, o, 'origins are bare https origins');
});

// --- balance / costs -------------------------------------------------------------------------------

test('xrp: balance = validated Balance in drops; 0 for an account the ledger does not know (actNotFound)', async () => {
  const calls = install(world());
  assert.equal(await xrp.balance(ME, XRP), 25_000_000n);
  assert.equal(await xrp.balance(NEW_DEST, XRP), 0n);
  assert.equal(calls[0]!.body.method, 'account_info');
  assert.equal(calls[0]!.body.params[0]!.ledger_index, 'validated');
  await assert.rejects(() => xrp.balance(ME, { symbol: 'USD', native: false, token: 'rIssuer', decimals: 6 }), /only XRP/);
});

test('xrp: a busy server is skipped, the next one answers', async () => {
  const calls = install(world({ busy: [XRP_ORIGINS[0]] }));
  assert.equal(await xrp.balance(ME, XRP), 25_000_000n);
  assert.deepEqual(calls.map((c) => new URL(c.url).origin), [XRP_ORIGINS[0], XRP_ORIGINS[1]]);
  install(world({ busy: [...XRP_ORIGINS] }));
  await assert.rejects(() => xrp.balance(ME, XRP), /no server answered account_info/);
});

test('xrp: costs - fee from the fee method (>= 12 drops, capped), keep = live base reserve + owner reserves, nothing else needed', async () => {
  install(world());
  assert.deepEqual(await xrp.costs(ME, XRP, DEST), { fee: 12n, keep: 1_000_000n, nativeNeeded: 0n });
  // Fee escalation: the open ledger fee + 20 %; a different reserve is read, not assumed; owned objects add their reserve.
  install(world({
    fee: { base_fee: '10', median_fee: '5000', minimum_fee: '10', open_ledger_fee: '500' },
    reserveBase: 2,
    reserveInc: 0.5,
    validated: { [ME]: { Balance: '25000000', Sequence: 104, OwnerCount: 3, Flags: 0 } },
  }));
  assert.deepEqual(await xrp.costs(ME, XRP, DEST), { fee: 600n, keep: 3_500_000n, nativeNeeded: 0n });
  install(world({ fee: { base_fee: '10', median_fee: '5000', minimum_fee: '10', open_ledger_fee: '999999' } }));
  assert.equal((await xrp.costs(ME, XRP, DEST)).fee, XRP_MAX_FEE);
  // Clio writes the reserve as 1E0 / 2E-1: the same numbers once parsed.
  install(world({ reserveBase: 1e0, reserveInc: 2e-1 }));
  assert.equal((await xrp.costs(NEW_DEST, XRP, DEST)).keep, 1_000_000n, 'an unknown account keeps the base reserve');
});

// --- prepare ---------------------------------------------------------------------------------------

test('xrp: prepare signs exactly one Payment - destination, drops, fee, sequence, LastLedgerSequence, no tag, valid signature', async () => {
  const calls = install(world());
  const p = await xrp.prepare(KEYS, XRP, DEST, 5_000_000n);
  const tx = decoded(p);
  assert.equal(tx.TransactionType, 'Payment');
  assert.equal(tx.Account, ME);
  assert.equal(tx.Destination, DEST);
  assert.equal(tx.Amount, '5000000');
  assert.equal(tx.Fee, '12');
  assert.equal(tx.Sequence, 104);
  assert.equal(tx.LastLedgerSequence, 107407551 + 20);
  assert.equal(tx.SigningPubKey, ME_PUB);
  for (const k of ['DestinationTag', 'SourceTag', 'Memos', 'NetworkID', 'InvoiceID', 'Paths', 'SendMax', 'DeliverMin']) assert.ok(!(k in tx), `no ${k}`);
  assert.equal(Number(tx.Flags ?? 0) & 0x00020000, 0, 'not a partial payment');
  assert.equal(p.amount, 5_000_000n);
  assert.equal(p.fee, 12n);

  // The signature verifies - with xrpl, and independently (SHA-512Half of "STX\0" + fields, secp256k1 DER).
  const blob = blobOf(p);
  assert.ok(verifySignature(blob, ME_PUB));
  const unsigned = { ...tx };
  delete unsigned.TxnSignature;
  const digest = sha512Half(encodeForSigning(unsigned as never));
  assert.ok(secp256k1.verify(String(tx.TxnSignature), digest, ME_PUB), 'secp256k1 signature over the signing hash');
  // The txid is the transaction's hash (SHA-512Half of "TXN\0" + blob), known before sending.
  assert.equal(p.txid, hashes.hashSignedTx(blob));
  assert.equal(p.txid, sha512Half(`54584E00${blob}`));
  assert.equal(p.explorer, `https://livenet.xrpl.org/transactions/${p.txid}`);

  // The request is the exact submit body, to an origin the module lists.
  assert.equal(p.request.method, 'POST');
  // (the server that answered the open-ledger read - the reads stay with the last server that answered)
  const openRead = calls.find((c) => c.body.method === 'account_info' && c.body.params[0]!.ledger_index === 'current');
  assert.ok((XRP_ORIGINS as readonly string[]).includes(p.request.url));
  assert.equal(p.request.url, openRead?.url);
  assert.deepEqual(p.request.headers, { 'content-type': 'application/json' });
  assert.equal(p.request.body, `{"method":"submit","params":[{"tx_blob":"${blob}"}]}`);
  assert.ok(xrp.isWrite(new URL(p.request.url), 'POST', p.request.body), 'the guard sees it as a write');
  // Nothing was sent: only reads.
  assert.ok(calls.every((c) => !xrp.isWrite(new URL(c.url), c.method, JSON.stringify(c.body))));
  assert.ok(!calls.some((c) => c.body.method === 'submit'));
  // The sequence and the queue come from the open ledger.
  assert.ok(calls.some((c) => c.body.method === 'account_info' && c.body.params[0]!.ledger_index === 'current' && c.body.params[0]!.queue === true));
});

test("xrp: 'max' = balance - fee - (base + owner) reserve; the lower of validated and open-ledger balance counts", async () => {
  install(world({ validated: { [ME]: { Balance: '25000000', Sequence: 104, OwnerCount: 2, Flags: 0 }, [DEST]: { Balance: '1', Sequence: 1, OwnerCount: 0, Flags: 0 } } }));
  const p = await xrp.prepare(KEYS, XRP, DEST, 'max');
  assert.equal(p.amount, 25_000_000n - 12n - 1_400_000n);
  assert.equal(decoded(p).Amount, String(25_000_000n - 12n - 1_400_000n));
  assert.equal(p.amount + p.fee + 1_400_000n, 25_000_000n, 'exactly the reserve stays');
  // An earlier send in the open ledger (not validated yet): the lower balance and the next sequence.
  install(world({ current: { [ME]: { Balance: '20000000', Sequence: 105, OwnerCount: 0, Flags: 0 } } }));
  const q = await xrp.prepare(KEYS, XRP, DEST, 'max');
  assert.equal(q.amount, 20_000_000n - 12n - 1_000_000n);
  assert.equal(decoded(q).Sequence, 105);
});

test('xrp: refusals - too little, nothing, unknown sender, tag-only / deposit-auth destination, new account below reserve, bad address, self, queue', async () => {
  install(world());
  await assert.rejects(() => xrp.prepare(KEYS, XRP, DEST, 24_000_000n - 11n), /too little XRP/);
  assert.equal((await xrp.prepare(KEYS, XRP, DEST, 24_000_000n - 12n)).amount, 23_999_988n, 'the last drop that can leave');
  await assert.rejects(() => xrp.prepare(KEYS, XRP, DEST, 0n), /more than 0/);
  install(world({ validated: { [ME]: { Balance: '1000012', Sequence: 1, OwnerCount: 0, Flags: 0 } } }));
  await assert.rejects(() => xrp.prepare(KEYS, XRP, DEST, 'max'), /nothing can leave/);
  install(world({ validated: {} }));
  await assert.rejects(() => xrp.prepare(KEYS, XRP, DEST, 1_000_000n), /no account on the ledger/);

  const flagged = (Flags: number) => world({ validated: { [ME]: { Balance: '25000000', Sequence: 104, OwnerCount: 0, Flags: 0 }, [DEST]: { Balance: '1', Sequence: 1, OwnerCount: 0, Flags } } });
  install(flagged(0x00020000));
  await assert.rejects(() => xrp.prepare(KEYS, XRP, DEST, 1_000_000n), /requires a destination tag/);
  install(flagged(0x01000000));
  await assert.rejects(() => xrp.prepare(KEYS, XRP, DEST, 1_000_000n), /DepositAuth/);
  install(flagged(0x00080000));
  await assert.rejects(() => xrp.prepare(KEYS, XRP, DEST, 1_000_000n), /DisallowXRP/);

  // A destination the ledger does not know: only a payment of at least the base reserve creates it.
  install(world());
  await assert.rejects(() => xrp.prepare(KEYS, XRP, NEW_DEST, 999_999n), /not on the ledger yet.*base reserve 1\.000000 XRP/);
  const created = await xrp.prepare(KEYS, XRP, NEW_DEST, 1_000_000n);
  assert.equal(decoded(created).Destination, NEW_DEST);

  await assert.rejects(() => xrp.prepare(KEYS, XRP, 'XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi', 1_000_000n), /not a classic r-address/);
  await assert.rejects(() => xrp.prepare(KEYS, XRP, 'rDHyZB8NxpNnEsUKU7wCN8u6Mh1bXiDcA7', 1_000_000n), /not a classic r-address/);
  await assert.rejects(() => xrp.prepare(KEYS, XRP, ME, 1_000_000n), /itself/);
  await assert.rejects(() => xrp.prepare(KEYS, { symbol: 'RLUSD', native: false, token: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', decimals: 6 }, DEST, 1n), /only XRP/);
  install(world({ queued: 1 }));
  await assert.rejects(() => xrp.prepare(KEYS, XRP, DEST, 1_000_000n), /still queued/);
});

// --- broadcast -------------------------------------------------------------------------------------

test('xrp: broadcast sends exactly the prepared body once; tesSUCCESS / terQUEUED -> txid; anything else throws with the node words', async () => {
  install(world());
  const p = await xrp.prepare(KEYS, XRP, DEST, 2_000_000n);
  const accepted = (engine_result: string, engine_result_message: string) => ({
    accepted: engine_result === 'tesSUCCESS' || engine_result === 'terQUEUED', applied: engine_result === 'tesSUCCESS', broadcast: true, engine_result,
    engine_result_code: 0, engine_result_message, kept: true, queued: engine_result === 'terQUEUED', status: 'success',
    tx_blob: blobOf(p), tx_json: { ...decoded(p), hash: p.txid }, validated_ledger_index: 107407551,
  });
  let calls = install(world({ submit: accepted('tesSUCCESS', 'The transaction was applied. Only final in a validated ledger.') }));
  assert.equal(await xrp.broadcast(p), p.txid);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, p.request.url);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(JSON.stringify(calls[0]!.body), p.request.body);

  calls = install(world({ submit: accepted('terQUEUED', 'Held until escalated fee drops.') }));
  assert.equal(await xrp.broadcast(p), p.txid);

  install(world({ submit: { ...accepted('tecUNFUNDED_PAYMENT', 'Insufficient XRP balance to send.'), engine_result_code: 104 } }));
  await assert.rejects(() => xrp.broadcast(p), /tecUNFUNDED_PAYMENT: Insufficient XRP balance to send\./);
  install(world({ submit: { ...accepted('tefPAST_SEQ', 'This sequence number has already passed.'), engine_result_code: -190 } }));
  await assert.rejects(() => xrp.broadcast(p), /tefPAST_SEQ/);
  install(world({ submit: { error: 'invalidTransaction', error_exception: 'fails local checks: Invalid signature.', status: 'error', request: {} } }));
  await assert.rejects(() => xrp.broadcast(p), /invalidTransaction: fails local checks: Invalid signature\./);
  install(world({ submit: { ...accepted('tesSUCCESS', 'ok'), tx_json: { hash: '00'.repeat(32) } } }));
  await assert.rejects(() => xrp.broadcast(p), /reports hash/);
});

// --- confirmed -------------------------------------------------------------------------------------

test('xrp: confirmed - validated tesSUCCESS true, validated tec false, unvalidated / not found null, past LastLedgerSequence false', async () => {
  install(world());
  const p = await xrp.prepare(KEYS, XRP, DEST, 2_000_000n);
  const found = (validated: boolean, TransactionResult: string) => ({
    ...decoded(p), hash: p.txid, ctid: 'C666DCBF00100000', date: 812822766, inLedger: 107407553, ledger_index: 107407553,
    meta: { AffectedNodes: [], TransactionIndex: 16, TransactionResult, delivered_amount: TransactionResult === 'tesSUCCESS' ? '2000000' : 'unavailable' },
    validated, status: 'success',
  });
  install(world({ tx: { [p.txid]: found(true, 'tesSUCCESS') } }));
  assert.equal(await xrp.confirmed(p.txid), true);
  assert.equal(await xrp.confirmed(p.txid.toLowerCase()), true);
  install(world({ tx: { [p.txid]: found(true, 'tecUNFUNDED_PAYMENT') } }));
  assert.equal(await xrp.confirmed(p.txid), false);
  install(world({ tx: { [p.txid]: found(false, 'tesSUCCESS') } }));
  assert.equal(await xrp.confirmed(p.txid), null, 'in the open ledger only: not final yet');

  // Not found, its LastLedgerSequence not reached yet: null. Reached and the server has every ledger in between: false.
  let calls = install(world());
  assert.equal(await xrp.confirmed(p.txid), null);
  assert.deepEqual(calls[0]!.body.params[0], { transaction: p.txid, binary: false, min_ledger: 107407552, max_ledger: 107407571 });
  calls = install(world({ validatedIndex: 107407600 }));
  assert.equal(await xrp.confirmed(p.txid), false);
  // A hash this process did not build: never "false" from absence alone.
  install(world({ validatedIndex: 107407600 }));
  assert.equal(await xrp.confirmed('AB'.repeat(32)), null);
  await assert.rejects(() => xrp.confirmed('nope'), /not a transaction hash/);
});

// --- the guard's view ------------------------------------------------------------------------------

test('xrp: isWrite - submit / sign / anything carrying a secret or unreadable is a write; reads are reads', () => {
  const u = new URL(XRP_ORIGINS[0]);
  const body = (method: string, p: Record<string, unknown> = {}) => JSON.stringify({ method, params: [p] });
  assert.equal(xrp.isWrite(u, 'POST', body('submit', { tx_blob: 'AB' })), true);
  assert.equal(xrp.isWrite(u, 'post', body('submit_multisigned')), true);
  assert.equal(xrp.isWrite(u, 'POST', body('sign', { tx_json: {} })), true);
  assert.equal(xrp.isWrite(u, 'POST', body('sign_for')), true);
  assert.equal(xrp.isWrite(u, 'POST', body('account_info', { account: ME, secret: 'x' })), true, 'a secret never leaves as a read');
  assert.equal(xrp.isWrite(u, 'POST', '[' + body('fee') + ',' + body('submit') + ']'), true);
  assert.equal(xrp.isWrite(u, 'POST', 'not json'), true);
  assert.equal(xrp.isWrite(u, 'POST', JSON.stringify({ params: [] })), true, 'no method: cannot tell');
  for (const m of ['account_info', 'server_info', 'fee', 'tx', 'ledger']) assert.equal(xrp.isWrite(u, 'POST', body(m, { account: ME })), false, m);
  assert.equal(xrp.isWrite(u, 'GET', null), false);
});
