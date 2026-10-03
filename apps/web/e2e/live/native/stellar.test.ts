/**
 * The Stellar module (stellar.ts), offline: a fake fetch answers with the
 * shapes Horizon (horizon.stellar.org, horizon.stellar.lobstr.co) answered on
 * 2026-10-03. Nothing here talks to a network or uses a real key.
 *   npx tsx --test e2e/live/native/stellar.test.ts        (from apps/web)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Asset, Keypair, Networks, StrKey, TransactionBuilder, xdr, type Transaction } from '@stellar/stellar-base';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { addressProblem } from '../../../src/trading/addresses';
import { deriveEd25519Seed, nativeKeysFromHex } from './keys';
import type { NativeCoin, PreparedSend } from './types';
import { STELLAR_MAX_FEE, STELLAR_ORIGINS, STELLAR_TIMEOUT_S, stellar, stroopsOf, xlmOf } from './stellar';

/** A fixed TEST key (never funded, never used anywhere real). */
const TEST_KEY = '0x492483aba1a41420c68c21ca348dd1130d45530863bea0fb3a69f7eb67ab39f1';
const KEYS = nativeKeysFromHex(TEST_KEY);
const ME = 'GAAK66B23NXACCLI5N2TQ3DMHXRKDMO3ZCGJDUEQZ6DAHX27CEZLB7FB';
const ME_SEED = 'ac58f0045742a90a43511054ad9d283f0cfe348a72ae95c98896716c78967efe';
/** Stand-ins for SoDEX deposit addresses: any valid G-address (fetch is fake). */
const DEST = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const NEW_DEST = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const XLM: NativeCoin = { symbol: 'XLM', native: true, token: null, decimals: 7 };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- a fake Horizon: answers in the recorded shapes ------------------------------------------------

interface Acct { balance: string; sequence: string; subentry_count?: number; num_sponsoring?: number; num_sponsored?: number; selling?: string; data?: Record<string, string> }
interface World {
  accounts: Record<string, Acct>;
  fee: { last_ledger_base_fee: string; p50: string; p90: string };
  reserve: number;
  closedAt: string;
  /** Origins that answer 503. */
  down?: string[];
  txs?: Record<string, { successful: boolean }>;
  submit?: { status: number; json: Record<string, unknown> };
}
interface Call { url: string; method: string; headers: Record<string, string>; body: string | null }

const NOT_FOUND = {
  type: 'https://stellar.org/horizon-errors/not_found', title: 'Resource Missing', status: 404,
  detail: 'The resource at the url requested was not found.  This usually occurs for one of two reasons:  The url requested is not valid, or no data in our database could be found with the parameters provided.',
};

function install(w: World): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ url: String(input), method, headers: { ...(init?.headers as Record<string, string> | undefined) }, body: (init?.body as string | undefined) ?? null });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/hal+json; charset=utf-8' } });
    if (w.down?.includes(url.origin)) return new Response('upstream unavailable', { status: 503 });
    const path = url.pathname;
    if (method === 'POST' && path === '/transactions') return json(w.submit?.status ?? 500, w.submit?.json ?? {});
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/accounts\/([A-Z0-9]+)$/))) {
      const a = w.accounts[m[1]!];
      if (!a) return json(404, NOT_FOUND);
      return json(200, {
        id: m[1], account_id: m[1], sequence: a.sequence, subentry_count: a.subentry_count ?? 0, last_modified_ledger: 64709926, last_modified_time: '2026-10-01T06:16:52Z',
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
        balances: [
          { balance: '25.0000000', limit: '922337203685.4775807', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
          { balance: a.balance, buying_liabilities: '0.0000000', selling_liabilities: a.selling ?? '0.0000000', asset_type: 'native' },
        ],
        signers: [{ weight: 1, key: m[1], type: 'ed25519_public_key' }],
        data: a.data ?? {}, num_sponsoring: a.num_sponsoring ?? 0, num_sponsored: a.num_sponsored ?? 0, paging_token: m[1],
      });
    }
    if (path === '/fee_stats') {
      return json(200, {
        last_ledger: '64751577', last_ledger_base_fee: w.fee.last_ledger_base_fee, ledger_capacity_usage: '1.01',
        fee_charged: { max: '398436', min: '100', mode: w.fee.p90, p10: '100', p20: '100', p30: '100', p40: '100', p50: w.fee.p50, p60: w.fee.p90, p70: w.fee.p90, p80: w.fee.p90, p90: w.fee.p90, p95: '15521', p99: '84940' },
        max_fee: { max: '369679006', min: '100', mode: '116140', p10: '243', p20: '20000', p30: '21009', p40: '116140', p50: '116140', p60: '116140', p70: '116140', p80: '116140', p90: '250005', p95: '1000000', p99: '5100000' },
      });
    }
    if (path === '/ledgers' && url.searchParams.get('order') === 'desc' && url.searchParams.get('limit') === '1') {
      return json(200, {
        _embedded: {
          records: [{
            id: 'b4e916e979c0311fa5080e073d48807b168ab8e8455f1e1a0449fdf7ba968edc', sequence: 64751577, successful_transaction_count: 286, failed_transaction_count: 70,
            operation_count: 909, closed_at: w.closedAt, total_coins: '105443902087.3472865', fee_pool: '10751804.2524886',
            base_fee_in_stroops: 100, base_reserve_in_stroops: w.reserve, max_tx_set_size: 1000, protocol_version: 29,
          }],
        },
      });
    }
    if ((m = path.match(/^\/transactions\/([0-9a-f]{64})$/))) {
      const t = w.txs?.[m[1]!];
      if (!t) return json(404, NOT_FOUND);
      return json(200, { id: m[1], hash: m[1], successful: t.successful, ledger: 64751580, fee_charged: '100', operation_count: 1, memo_type: 'none' });
    }
    return json(404, NOT_FOUND);
  }) as typeof fetch;
  return calls;
}

const world = (over: Partial<World> = {}): World => ({
  accounts: { [ME]: { balance: '100.0000000', sequence: '278105905579425792' }, [DEST]: { balance: '99.4338370', sequence: '1' } },
  fee: { last_ledger_base_fee: '100', p50: '100', p90: '100' },
  reserve: 5_000_000,
  closedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  ...over,
});

function envelope(p: PreparedSend): { tx: Transaction; b64: string } {
  assert.ok(p.request.body.startsWith('tx='));
  const b64 = decodeURIComponent(p.request.body.slice(3));
  return { tx: TransactionBuilder.fromXDR(b64, Networks.PUBLIC) as Transaction, b64 };
}

// --- address ---------------------------------------------------------------------------------------

test('stellar: the HKDF-derived seed gives a fixed G-address, valid for the app', () => {
  const a = stellar.address(KEYS);
  assert.equal(a, ME);
  const seed = KEYS.ed25519('stellar');
  assert.equal(Buffer.from(seed).toString('hex'), ME_SEED);
  assert.deepEqual(seed, deriveEd25519Seed(KEYS.secp256k1, 'stellar'));
  // Independently: the ed25519 public key of that seed, as a StrKey.
  assert.equal(StrKey.encodeEd25519PublicKey(Buffer.from(ed25519.getPublicKey(seed))), ME);
  assert.notEqual(Buffer.from(seed).toString('hex'), Buffer.from(KEYS.secp256k1).toString('hex'), 'never the same bytes on two curves');
  assert.equal(addressProblem('stellar', a), null);
  assert.equal(addressProblem('stellar', NEW_DEST), null);
  assert.equal(stellar.kind, 'stellar');
  assert.equal(stellar.chainKey, 'XLM');
  assert.equal(stellar.label, 'Stellar');
  assert.deepEqual([...stellar.origins], [...STELLAR_ORIGINS]);
  for (const o of stellar.origins) assert.equal(new URL(o).origin, o);
});

test('stellar: amounts - stroops <-> XLM strings, 7 decimals', () => {
  assert.equal(stroopsOf('99.4338370'), 994_338_370n);
  assert.equal(stroopsOf('1'), 10_000_000n);
  assert.equal(stroopsOf('0.0000001'), 1n);
  assert.equal(xlmOf(994_338_370n), '99.4338370');
  assert.equal(xlmOf(1n), '0.0000001');
  assert.throws(() => stroopsOf('1.00000001'));
  assert.throws(() => stroopsOf('-1'));
});

// --- balance / costs -------------------------------------------------------------------------------

test('stellar: balance = native balance in stroops (not the USDC line); 0 for an account Horizon does not know (404)', async () => {
  install(world());
  assert.equal(await stellar.balance(DEST, XLM), 994_338_370n);
  assert.equal(await stellar.balance(NEW_DEST, XLM), 0n);
  await assert.rejects(() => stellar.balance(DEST, { symbol: 'USDC', native: false, token: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', decimals: 7 }), /only XLM/);
  // A Horizon that is down is skipped.
  const calls = install(world({ down: [STELLAR_ORIGINS[0]] }));
  assert.equal(await stellar.balance(DEST, XLM), 994_338_370n);
  assert.deepEqual(calls.map((c) => new URL(c.url).origin), [STELLAR_ORIGINS[0], STELLAR_ORIGINS[1]]);
  install(world({ down: [...STELLAR_ORIGINS] }));
  await assert.rejects(() => stellar.balance(DEST, XLM), /no Horizon answered/);
});

test('stellar: costs - fee bid from fee_stats (2 x p90, >= 100, capped), keep = minimum balance from the live base reserve', async () => {
  install(world());
  assert.deepEqual(await stellar.costs(ME, XLM, DEST), { fee: 200n, keep: 10_000_000n, nativeNeeded: 0n });
  // 2026-10-03: surge pricing, the last ledger charged p90 = 6970 stroops.
  install(world({ fee: { last_ledger_base_fee: '100', p50: '6970', p90: '6970' } }));
  assert.equal((await stellar.costs(ME, XLM, DEST)).fee, 13_940n);
  install(world({ fee: { last_ledger_base_fee: '100', p50: '6970', p90: '9000000' } }));
  assert.equal((await stellar.costs(ME, XLM, DEST)).fee, STELLAR_MAX_FEE);
  // Subentries, sponsorships and selling liabilities stay too; a different base reserve is read, not assumed.
  install(world({ reserve: 10_000_000, accounts: { [ME]: { balance: '100.0000000', sequence: '5', subentry_count: 2, num_sponsoring: 1, num_sponsored: 1, selling: '3.0000000' } } }));
  assert.equal((await stellar.costs(ME, XLM, DEST)).keep, 4n * 10_000_000n + 30_000_000n);
  install(world());
  assert.equal((await stellar.costs(NEW_DEST, XLM, DEST)).keep, 10_000_000n, 'an account that does not exist yet: 2 base reserves');
});

// --- prepare ---------------------------------------------------------------------------------------

test('stellar: prepare to an existing account signs one native Payment - destination, stroops, fee, sequence, no memo, 5 min, PUBLIC signature', async () => {
  const calls = install(world({ fee: { last_ledger_base_fee: '100', p50: '6970', p90: '6970' } }));
  const before = Math.floor(Date.now() / 1000);
  const p = await stellar.prepare(KEYS, XLM, DEST, 123_456_789n);
  const { tx, b64 } = envelope(p);
  assert.equal(tx.source, ME);
  assert.equal(tx.operations.length, 1);
  const op = tx.operations[0] as unknown as { type: string; destination: string; asset: Asset; amount: string; source?: string };
  assert.equal(op.type, 'payment');
  assert.equal(op.destination, DEST);
  assert.ok(op.asset.isNative());
  assert.equal(op.amount, '12.3456789');
  assert.equal(op.source, undefined);
  assert.equal(tx.fee, '13940');
  assert.equal(tx.sequence, '278105905579425793', 'the account sequence + 1');
  assert.equal(tx.memo.type, 'none');
  assert.equal(tx.timeBounds?.minTime, '0');
  const maxTime = Number(tx.timeBounds?.maxTime);
  assert.ok(maxTime >= before + STELLAR_TIMEOUT_S && maxTime <= before + STELLAR_TIMEOUT_S + 5, `maxTime ~ now + 5 min (${maxTime - before})`);
  assert.equal(p.amount, 123_456_789n);
  assert.equal(p.fee, 13_940n);

  // The hash: SHA-256(SHA-256(PUBLIC passphrase) || ENVELOPE_TYPE_TX || tx XDR), computed here independently.
  const txXdr = xdr.TransactionEnvelope.fromXDR(b64, 'base64').v1().tx().toXDR();
  const hash = sha256(Uint8Array.from([...sha256(new TextEncoder().encode(Networks.PUBLIC)), 0, 0, 0, 2, ...txXdr]));
  assert.equal(p.txid, Buffer.from(hash).toString('hex'));
  assert.equal(p.explorer, `https://stellar.expert/explorer/public/tx/${p.txid}`);
  // One signature, by the test wallet, over that PUBLIC-network hash (and not over the testnet one).
  assert.equal(tx.signatures.length, 1);
  const sig = tx.signatures[0]!;
  const pub = StrKey.decodeEd25519PublicKey(ME);
  assert.deepEqual(Buffer.from(sig.hint()), Buffer.from(pub.subarray(28)));
  assert.ok(ed25519.verify(sig.signature(), hash, pub));
  const testnet = sha256(Uint8Array.from([...sha256(new TextEncoder().encode(Networks.TESTNET)), 0, 0, 0, 2, ...txXdr]));
  assert.ok(!ed25519.verify(sig.signature(), testnet, pub));

  // The request: POST /transactions, form body tx=<url-encoded XDR>, to the Horizon that answered the reads.
  assert.equal(p.request.method, 'POST');
  assert.ok(STELLAR_ORIGINS.map((o) => `${o}/transactions`).includes(p.request.url));
  assert.deepEqual(p.request.headers, { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(p.request.body, `tx=${encodeURIComponent(b64)}`);
  assert.ok(b64.includes('+') || b64.includes('/') || b64.includes('=') ? p.request.body.includes('%') : true, 'base64 specials are encoded');
  assert.ok(stellar.isWrite(new URL(p.request.url), 'POST', p.request.body));
  assert.ok(calls.every((c) => c.method === 'GET'), 'nothing was sent');
});

test("stellar: 'max' leaves exactly the minimum balance (reserves + subentries) and the fee", async () => {
  install(world({ accounts: { [ME]: { balance: '100.0000000', sequence: '7', subentry_count: 1 }, [DEST]: { balance: '1.0000000', sequence: '1' } } }));
  const p = await stellar.prepare(KEYS, XLM, DEST, 'max');
  const keep = 3n * 5_000_000n;
  assert.equal(p.amount, 1_000_000_000n - 200n - keep);
  assert.equal(p.amount + p.fee + keep, 1_000_000_000n);
  const op = envelope(p).tx.operations[0] as unknown as { type: string; amount: string };
  assert.equal(op.type, 'payment');
  assert.equal(stroopsOf(op.amount), p.amount);
});

test('stellar: a destination that does not exist gets createAccount - only with at least 2 base reserves (1 XLM)', async () => {
  install(world());
  const p = await stellar.prepare(KEYS, XLM, NEW_DEST, 10_000_000n);
  const op = envelope(p).tx.operations[0] as unknown as { type: string; destination: string; startingBalance: string };
  assert.equal(op.type, 'createAccount');
  assert.equal(op.destination, NEW_DEST);
  assert.equal(op.startingBalance, '1.0000000');
  assert.equal(p.amount, 10_000_000n);
  await assert.rejects(() => stellar.prepare(KEYS, XLM, NEW_DEST, 9_999_999n), /does not exist yet; creating it needs at least 1\.0000000 XLM/);
  // The minimum follows the live reserve.
  install(world({ reserve: 10_000_000 }));
  await assert.rejects(() => stellar.prepare(KEYS, XLM, NEW_DEST, 10_000_000n), /at least 2\.0000000 XLM/);
  // 'max' to a new account with less than that free: refused, not a doomed createAccount.
  install(world({ accounts: { [ME]: { balance: '1.5000000', sequence: '7' } } }));
  await assert.rejects(() => stellar.prepare(KEYS, XLM, NEW_DEST, 'max'), /does not exist yet/);
});

test('stellar: refusals - too little, nothing, unknown sender, memo-required destination, bad / muxed address, self, a token', async () => {
  install(world());
  await assert.rejects(() => stellar.prepare(KEYS, XLM, DEST, 1_000_000_000n - 200n - 10_000_000n + 1n), /too little XLM/);
  assert.equal((await stellar.prepare(KEYS, XLM, DEST, 1_000_000_000n - 200n - 10_000_000n)).amount, 989_999_800n, 'the last stroop that can leave');
  await assert.rejects(() => stellar.prepare(KEYS, XLM, DEST, 0n), /more than 0/);
  install(world({ accounts: { [ME]: { balance: '1.0000200', sequence: '7' }, [DEST]: { balance: '1.0000000', sequence: '1' } } }));
  await assert.rejects(() => stellar.prepare(KEYS, XLM, DEST, 'max'), /nothing can leave/);
  install(world({ accounts: { [DEST]: { balance: '1.0000000', sequence: '1' } } }));
  await assert.rejects(() => stellar.prepare(KEYS, XLM, DEST, 10_000_000n), /no account on the network/);
  install(world({ accounts: { [ME]: { balance: '100.0000000', sequence: '7' }, [DEST]: { balance: '1.0000000', sequence: '1', data: { 'config.memo_required': 'MQ==' } } } }));
  await assert.rejects(() => stellar.prepare(KEYS, XLM, DEST, 10_000_000n), /requires a memo/);
  install(world());
  const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(DEST), Buffer.alloc(8, 1)]));
  await assert.rejects(() => stellar.prepare(KEYS, XLM, muxed, 10_000_000n), /not a G\.\.\. account address/);
  await assert.rejects(() => stellar.prepare(KEYS, XLM, `${DEST.slice(0, -1)}A`, 10_000_000n), /not a G\.\.\. account address/);
  await assert.rejects(() => stellar.prepare(KEYS, XLM, Keypair.random().secret(), 10_000_000n), /not a G\.\.\. account address/);
  await assert.rejects(() => stellar.prepare(KEYS, XLM, ME, 10_000_000n), /itself/);
  await assert.rejects(() => stellar.prepare(KEYS, { symbol: 'USDC', native: false, token: 'GA5Z', decimals: 7 }, DEST, 1n), /only XLM/);
});

// --- broadcast -------------------------------------------------------------------------------------

test('stellar: broadcast posts exactly the prepared form once; 200 -> hash; 400 throws with result_codes; 504 throws "may still be included"', async () => {
  install(world());
  const p = await stellar.prepare(KEYS, XLM, DEST, 50_000_000n);
  const ok = { id: p.txid, hash: p.txid, successful: true, ledger: 64751580, envelope_xdr: envelope(p).b64, result_xdr: 'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=', fee_charged: '100' };
  let calls = install(world({ submit: { status: 200, json: ok } }));
  assert.equal(await stellar.broadcast(p), p.txid);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, p.request.url);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.body, p.request.body);
  assert.deepEqual(calls[0]!.headers, p.request.headers);

  const failed = (transaction: string, operations?: string[]) => ({
    status: 400,
    json: {
      type: 'https://stellar.org/horizon-errors/transaction_failed', title: 'Transaction Failed', status: 400,
      detail: 'The transaction failed when submitted to the stellar network. The `extras.result_codes` field on this response contains further details.',
      extras: { envelope_xdr: envelope(p).b64, result_codes: { transaction, ...(operations ? { operations } : {}) }, result_xdr: 'AAAAAAAAAGT/////AAAAAQAAAAAAAAAB/////gAAAAA=' },
    },
  });
  calls = install(world({ submit: failed('tx_failed', ['op_underfunded']) }));
  await assert.rejects(() => stellar.broadcast(p), /Transaction Failed .*"transaction":"tx_failed".*"op_underfunded"/);
  install(world({ submit: failed('tx_bad_seq') }));
  await assert.rejects(() => stellar.broadcast(p), /tx_bad_seq/);
  install(world({ submit: failed('tx_insufficient_fee') }));
  await assert.rejects(() => stellar.broadcast(p), /tx_insufficient_fee/);
  install(world({ submit: { status: 504, json: { type: 'https://stellar.org/horizon-errors/timeout', title: 'Timeout', status: 504, detail: 'Your request timed out before completing.' } } }));
  await assert.rejects(() => stellar.broadcast(p), /may still be included/);
  install(world({ submit: { status: 200, json: { ...ok, hash: 'ab'.repeat(32) } } }));
  await assert.rejects(() => stellar.broadcast(p), /reports hash/);
});

// --- confirmed -------------------------------------------------------------------------------------

test('stellar: confirmed - successful true / false, 404 null; after maxTime (a later ledger on the same Horizon) false', async () => {
  install(world());
  const p = await stellar.prepare(KEYS, XLM, DEST, 50_000_000n);
  install(world({ txs: { [p.txid]: { successful: true } } }));
  assert.equal(await stellar.confirmed(p.txid), true);
  assert.equal(await stellar.confirmed(p.txid.toUpperCase()), true);
  install(world({ txs: { [p.txid]: { successful: false } } }));
  assert.equal(await stellar.confirmed(p.txid), false);
  // Not found, still inside its time bounds: not known yet.
  install(world());
  assert.equal(await stellar.confirmed(p.txid), null);
  // Not found and Horizon has a ledger that closed after maxTime: it can never be included.
  const later = new Date(Date.now() + (STELLAR_TIMEOUT_S + 60) * 1000).toISOString();
  let calls = install(world({ closedAt: later }));
  assert.equal(await stellar.confirmed(p.txid), false);
  assert.equal(new Set(calls.map((c) => new URL(c.url).origin)).size, 1, 'the ledger and the transaction read on the same Horizon');
  assert.ok(calls[0]!.url.includes('/ledgers') && calls[1]!.url.includes(`/transactions/${p.txid}`), 'the ledger first, then the transaction');
  // A hash this process did not build: never "false" from absence alone.
  calls = install(world({ closedAt: later }));
  assert.equal(await stellar.confirmed('cd'.repeat(32)), null);
  await assert.rejects(() => stellar.confirmed('nope'), /not a transaction hash/);
});

// --- the guard's view ------------------------------------------------------------------------------

test('stellar: isWrite - POST /transactions (and anything not a read) is a write; GETs are reads', () => {
  const o = STELLAR_ORIGINS[0];
  assert.equal(stellar.isWrite(new URL(`${o}/transactions`), 'POST', 'tx=AAAA'), true);
  assert.equal(stellar.isWrite(new URL(`${o}/transactions_async`), 'POST', 'tx=AAAA'), true);
  assert.equal(stellar.isWrite(new URL(`${o}/transactions`), 'post', null), true);
  assert.equal(stellar.isWrite(new URL(`${o}/accounts/${ME}`), 'PUT', null), true);
  assert.equal(stellar.isWrite(new URL(`${o}/accounts/${ME}`), 'GET', null), false);
  assert.equal(stellar.isWrite(new URL(`${o}/transactions/${'ab'.repeat(32)}`), 'GET', null), false);
  assert.equal(stellar.isWrite(new URL(`${o}/fee_stats`), 'GET', null), false);
  assert.equal(stellar.isWrite(new URL(`${o}/ledgers?order=desc&limit=1`), 'HEAD', null), false);
});
