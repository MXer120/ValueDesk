/**
 * The builder-fee approval, end to end in the trading session: read what SoDEX
 * lists, disclose, ONE extra wallet signature, send, read again - and the fee
 * attached to orders only where SoDEX lists the approval.
 *
 * A fake wallet (a throwaway key, MetaMask's rules) and a fake SoDEX gateway
 * that VERIFIES every signature it is sent: the approval must recover the
 * account owner under ApproveBuilderFeeAction with the wallet's chain as the
 * domain, and an order must recover the registered trading key over the exact
 * bytes of its body. Like the real one, the fake REJECTS an order naming a
 * builder the account has not approved. Nothing leaves the process.
 *   npx tsx --test src/trading/builderFlow.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  approveBuilderFeeTypedData,
  bytesToHex,
  eip712Digest,
  engineDomainName,
  exchangeActionStructHash,
  generateTradingKey,
  goJSONStringify,
  hashTypedData,
  hexToBytes,
  keccak256,
  makeDomain,
  payloadJSONFromBody,
  recoverAddress,
  recoverWireSigner,
  signTypedDataWithKey,
  SodexApiError,
  utf8,
  type Engine,
} from '@sodex-core';
import { gateway as exchangeGateway } from '../exchange/sodexGateway';
import { recentLogs, type LogEntry } from '../log';
import { WalletError } from '../wallet';
import { setTradingConfig, type BuilderConfig } from './config';
import { _setBuilderPollDelaysForTests } from './builderApproval';
import type { BuilderTerms } from './builder';
import { memoryVault } from './vault';
import {
  _resetTradingForTests,
  approveBuilderFee,
  builderApprovalPending,
  enableTrading,
  getTradingState,
  readBuilderApproval,
  refreshBuilderApproval,
  restoreTrading,
  revokeBuilderApproval,
  TradingError,
  type BuilderChoice,
} from './session';
import { placeOrder } from './actions';

// --- a wallet -------------------------------------------------------------------

const master = generateTradingKey();
const OWNER = master.address.toLowerCase();
const AID = 4242;
const SODEX = 286623;

/** An EIP-1193 wallet on Arbitrum that signs typed data with `master`. */
const wallet = {
  chainId: 42161,
  /** Every typed-data request, in order (signed or refused). */
  asked: [] as Array<{ primaryType: string; td: any }>,
  /** Primary types the user rejects in the wallet (EIP-1193 code 4001). */
  rejects: new Set<string>(),
  async request({ method, params }: { method: string; params?: unknown[] }) {
    if (method === 'eth_chainId') return `0x${this.chainId.toString(16)}`;
    if (method === 'eth_signTypedData_v4') {
      const [addr, json] = params as [string, string];
      assert.equal(addr.toLowerCase(), OWNER, 'the wallet is asked to sign as the owner');
      const td = JSON.parse(json);
      this.asked.push({ primaryType: td.primaryType, td });
      // MetaMask's rule: typed data for another chain is refused.
      assert.equal(Number(td.domain.chainId), this.chainId, 'the domain is the chain the wallet is on - no network switch');
      if (this.rejects.has(td.primaryType)) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      const raw = hexToBytes(signTypedDataWithKey(td, master.privateKey)).slice(1);
      raw[64] = raw[64]! + 27; // wallets return r || s || v with v 27/28
      return bytesToHex(raw);
    }
    throw new Error(`unexpected wallet call ${method}`);
  },
};
const prompts = () => wallet.asked.map((a) => a.primaryType);

// --- a SoDEX gateway that checks signatures ---------------------------------------

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  raw: string;
}

const world = {
  hasAccount: true,
  /** Approved fee rate per engine and builder id - what GET /builders lists. */
  approvals: { spot: new Map<number, number>(), perps: new Map<number, number>() } as Record<Engine, Map<number, number>>,
  /** Engines whose list does not show a NEW approval (it never lands there). */
  hidden: new Set<Engine>(),
  /** This many reads after a write still show the state from BEFORE it (indexed reads lag). */
  lagReads: 0,
  stale: null as null | { spot: [number, number][]; perps: [number, number][] },
  /** POST /builders answers with this instead of applying it. */
  refuse: null as null | { status: number; body: unknown },
  /** POST /builders: 'landed' applies it and then drops the answer; 'lost' drops the request. */
  silent: null as null | 'landed' | 'lost',
  /** GET /builders fails (network). */
  readsFail: false,
  keys: { spot: [], perps: [] } as Record<Engine, Array<{ name: string; publicKey: string; expiresAt: number }>>,
  sent: [] as Sent[],
  nonces: new Set<string>(),
  approvalSigners: [] as string[],
};

const SYMBOLS = [{ id: 7, name: 'BTC-USD', displayName: 'BTC-USD', tickSize: '0.5', stepSize: '0.001', minQuantity: '0.001', minNotional: '5', maxLeverage: 50 }];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => reply({ code: 0, data, timestamp: Date.now() });
const snapshot = () => ({ spot: [...world.approvals.spot.entries()], perps: [...world.approvals.perps.entries()] });
const rows = (list: [number, number][]) => list.map(([builderID, feeRate]) => ({ userID: AID, builderID, feeRate }));

/** Who signed an exchange action (X-API-Sign over {type, params} of the body bytes). */
function exchangeSigner(s: Sent, engine: Engine, type: string): string {
  const payloadHash = keccak256(utf8(payloadJSONFromBody(type, s.raw)));
  const digest = eip712Digest(makeDomain(engineDomainName(engine), SODEX), exchangeActionStructHash(payloadHash, BigInt(s.headers['X-API-Nonce']!)));
  return recoverAddress(digest, hexToBytes(s.headers['X-API-Sign']!).slice(1)).toLowerCase();
}

function approve(s: Sent): Response {
  const { accountID, builderID, maxFeeRate } = s.body;
  // The canonical body: these three keys, in this order.
  assert.equal(s.raw, goJSONStringify({ accountID, builderID, maxFeeRate }), 'body {accountID, builderID, maxFeeRate}');
  assert.equal(s.headers['X-API-Key'], undefined, 'the master wallet signs: no X-API-Key');
  const chain = Number(s.headers['X-API-Chain']);
  const nonce = s.headers['X-API-Nonce']!;
  const wire = s.headers['X-API-Sign']!;
  if (world.nonces.has(nonce)) return reply({ code: 400, error: 'nonce already used' }, 400);
  world.nonces.add(nonce);
  // What a gateway does: rebuild the typed data from the request and recover the signer.
  const td = approveBuilderFeeTypedData({ accountID, builderID, maxFeeRate }, SODEX, BigInt(nonce), chain);
  let signer: string;
  try {
    signer = recoverWireSigner(hashTypedData(td), wire, 2).toLowerCase();
  } catch (e) {
    return reply({ code: 401, error: `bad signature: ${String(e)}` }, 401);
  }
  world.approvalSigners.push(signer);
  if (signer !== OWNER) return reply({ code: 401, error: 'signature does not recover the account owner' }, 401);
  if (accountID !== AID) return reply({ code: 400, error: 'accountID must be the primary account ID' }, 400);
  if (!Number.isInteger(maxFeeRate) || maxFeeRate < 0 || maxFeeRate > 2000) return reply({ code: 400, error: 'maxFeeRate out of range' }, 400);
  if (world.refuse) return reply(world.refuse.body, world.refuse.status);
  if (world.silent === 'lost') throw new TypeError('fetch failed');
  if (world.lagReads > 0) world.stale = snapshot();
  for (const engine of ['spot', 'perps'] as const) {
    if (maxFeeRate === 0) world.approvals[engine].delete(builderID);
    // As on mainnet: an approval above the perps cap is stored as the cap.
    else if (!world.hidden.has(engine)) world.approvals[engine].set(builderID, engine === 'perps' ? Math.min(maxFeeRate, 200) : maxFeeRate);
  }
  if (world.silent === 'landed') throw new TypeError('fetch failed');
  return ok(null);
}

function order(s: Sent, engine: Engine): Response {
  const type = engine === 'perps' ? 'newOrder' : 'batchNewOrder';
  const key = world.keys[engine].find((k) => k.name === s.headers['X-API-Key']);
  if (!key || exchangeSigner(s, engine, type) !== key.publicKey.toLowerCase()) return reply({ code: 401, error: 'API key error: invalid signature' }, 401);
  const b = s.body.builder;
  if (b !== undefined) {
    // "builder is the last field in its containing order or batch structure, with id before fee".
    assert.equal(Object.keys(s.body).at(-1), 'builder', 'builder is the LAST key of the batch');
    assert.deepEqual(Object.keys(b), ['id', 'fee'], 'id before fee');
    assert.ok(s.raw.endsWith(`,"builder":{"id":${b.id},"fee":${b.fee}}}`), s.raw);
    const approved = world.approvals[engine].get(b.id);
    if (approved === undefined || b.fee > approved) return reply({ code: 400, error: 'builder fee is not approved' }, 400);
  }
  return ok(s.body.orders.map((o: { clOrdID: string }, i: number) => ({ code: 0, clOrdID: o.clOrdID, orderID: 100 + i })));
}

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const raw = typeof init?.body === 'string' ? init.body : '';
  const s: Sent = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: raw ? JSON.parse(raw) : null, raw };
  if (url.startsWith('/api/md/')) return reply({ symbols: SYMBOLS });
  if (/\/api\/v1\/(spot|perps)\/markets\/symbols$/.test(url)) return ok(SYMBOLS);
  world.sent.push(s);
  const path = url.replace(GW, '');
  if (path === `/api/v1/user/${OWNER}/subaccounts`) {
    return world.hasAccount ? ok({ userID: AID, primaryAccountID: AID, subaccounts: [] }) : reply({ code: -1, error: 'user not found' });
  }
  if (/^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: world.hasAccount ? AID : 0, B: [] });
  if (path === `/api/v1/user/${OWNER}/builders`) {
    if (s.method === 'GET') {
      if (world.readsFail) throw new TypeError('fetch failed');
      if (world.stale && world.lagReads > 0) {
        world.lagReads -= 1;
        return ok({ spot: rows(world.stale.spot), perps: rows(world.stale.perps) });
      }
      world.stale = null;
      const now = snapshot();
      return ok({ spot: rows(now.spot), perps: rows(now.perps) });
    }
    if (s.method === 'POST') return approve(s);
  }
  const ex = /^\/api\/v1\/(spot|perps)\/exchange$/.exec(path);
  if (ex && s.method === 'POST' && s.body?.type === 'addAPIKey') {
    const engine = ex[1] as Engine;
    world.keys[engine] = world.keys[engine].filter((k) => k.name !== s.body.params.name).concat({ name: s.body.params.name, publicKey: s.body.params.publicKey, expiresAt: s.body.params.expiresAt });
    return ok(null);
  }
  const keys = /^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/api-keys$/.exec(path);
  if (keys) return ok(world.keys[keys[1] as Engine]);
  if (path === '/api/v1/perps/trade/orders' && s.method === 'POST') return order(s, 'perps');
  if (path === '/api/v1/spot/trade/orders/batch' && s.method === 'POST') return order(s, 'spot');
  return reply({ code: 404, error: `fake gateway: ${s.method} ${path}` }, 404);
}) as typeof fetch;

// --- fixtures -------------------------------------------------------------------------

const GW = 'https://gw.test';
const BID = 777001;
const B: BuilderConfig = { id: BID, fee: { perps: 50, spot: 100 }, maxFeeRate: 100, required: false };
const REQUIRED: BuilderConfig = { ...B, required: true };

/** The consent dialog: records what it was shown, answers as told. */
const dialog = {
  shown: [] as BuilderTerms[],
  answer: 'approve' as BuilderChoice,
  ask: async (terms: BuilderTerms): Promise<BuilderChoice> => {
    dialog.shown.push(terms);
    return dialog.answer;
  },
};
const steps: string[] = [];
const enable = (extra: Partial<Parameters<typeof enableTrading>[0]> = {}) =>
  enableTrading({ owner: OWNER, provider: wallet, confirmBuilderFee: dialog.ask, onStep: (s) => steps.push(s), ...extra });

const builderWrites = () => world.sent.filter((s) => s.method === 'POST' && s.url.endsWith('/builders'));
const builderReads = () => world.sent.filter((s) => s.method === 'GET' && s.url.endsWith('/builders'));
const registrations = () => world.sent.filter((s) => s.method === 'POST' && /\/exchange$/.test(s.url));
const orders = (engine: Engine) =>
  world.sent.filter((s) => s.method === 'POST' && s.url === `${GW}/api/v1/${engine}/trade/orders${engine === 'spot' ? '/batch' : ''}`);
const preApprove = (spot: number | null, perps: number | null) => {
  if (spot !== null) world.approvals.spot.set(BID, spot);
  if (perps !== null) world.approvals.perps.set(BID, perps);
};
const perpsOrder = () => placeOrder('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01' });
const spotOrder = () => placeOrder('spot', { symbol: 'BTC-USD', side: 'sell', price: '84000', quantity: '0.01' });
const tick = () => new Promise((r) => setTimeout(r, 20));

/** The app's own log (log.ts ring buffer), from this test only. */
let logMark: LogEntry | null = null;
function logged(): LogEntry[] {
  const all = recentLogs();
  const from = logMark ? all.lastIndexOf(logMark) : -1;
  return all.slice(from + 1);
}

/** A suite reads the gateway far more often per minute than a person does: each test starts with an empty request budget. */
function resetReadBudget(): void {
  (exchangeGateway.budget as unknown as { mem: unknown[] }).mem = [];
  try {
    (globalThis as { localStorage?: { removeItem(k: string): void } }).localStorage?.removeItem('vs:ledger:sodex-gw');
  } catch {
    /* no storage in this runtime: the in-memory copy above is the ledger */
  }
  assert.equal(exchangeGateway.budget.spent(), 0, 'the request budget could not be reset for the test');
}

function configure(builder: BuilderConfig | null): void {
  setTradingConfig({ network: 'mainnet', chainId: SODEX, gateway: GW, writesAllowed: true, disabled: false, keyTtlMs: 7 * 24 * 3_600_000, builder });
}

beforeEach(() => {
  world.hasAccount = true;
  world.approvals = { spot: new Map(), perps: new Map() };
  world.hidden = new Set();
  world.lagReads = 0;
  world.stale = null;
  world.refuse = null;
  world.silent = null;
  world.readsFail = false;
  world.keys = { spot: [], perps: [] };
  world.sent = [];
  world.nonces = new Set();
  world.approvalSigners = [];
  wallet.asked = [];
  wallet.rejects = new Set();
  wallet.chainId = 42161;
  dialog.shown = [];
  dialog.answer = 'approve';
  steps.length = 0;
  configure(B);
  _setBuilderPollDelaysForTests([0, 2, 2, 2]);
  _resetTradingForTests(memoryVault());
  resetReadBudget();
  logMark = recentLogs().at(-1) ?? null;
});

// --- no builder: nothing changes ---------------------------------------------------------

test('no builder configured: enabling is exactly as before - one signature, no builders request, no builder on orders', async () => {
  configure(null);
  const st = await enable();
  assert.deepEqual(prompts(), ['UserSignedAddAPIKeyAction']);
  assert.equal(builderReads().length + builderWrites().length, 0, 'SoDEX is never asked about builders');
  assert.equal(dialog.shown.length, 0);
  assert.equal(st.builder, null);
  await perpsOrder();
  await spotOrder();
  assert.equal(orders('perps')[0]!.body.builder, undefined);
  assert.equal(orders('spot')[0]!.body.builder, undefined);
  assert.ok(!orders('perps')[0]!.raw.includes('builder'));
  assert.equal(await readBuilderApproval(OWNER), null);
});

// --- already approved ----------------------------------------------------------------------

test('already approved: nothing is asked, nothing extra is signed, the approval is recorded per engine', async () => {
  preApprove(100, 50);
  const st = await enable();
  assert.equal(dialog.shown.length, 0, 'no disclosure: there is nothing to approve');
  assert.deepEqual(prompts(), ['UserSignedAddAPIKeyAction'], 'only the key registration');
  assert.equal(builderWrites().length, 0);
  assert.equal(builderReads().length, 1, 'one public read');
  assert.deepEqual(st.builder, { id: BID, maxFeeRate: 100, engines: { spot: 100, perps: 50 } });
  assert.deepEqual(steps, ['key-registration']);
});

test('the approval belongs to the account: a key rotation asks for nothing again', async () => {
  const first = await enable();
  assert.deepEqual(prompts(), ['ApproveBuilderFeeAction', 'UserSignedAddAPIKeyAction']);
  wallet.asked = [];
  dialog.shown = [];
  const second = await enable();
  assert.notEqual(second.keyAddress, first.keyAddress, 'a new key');
  assert.deepEqual(prompts(), ['UserSignedAddAPIKeyAction'], 'one signature: the approval is still there');
  assert.equal(dialog.shown.length, 0);
  assert.deepEqual(second.builder?.engines, { spot: 100, perps: 100 });
});

test('a higher ceiling than this build needs is enough; SoDEX\'s perps cap (200) counts as the approval there', async () => {
  configure({ id: BID, fee: { perps: 200, spot: 500 }, maxFeeRate: 500, required: false });
  preApprove(500, 200); // what mainnet lists for an approval of 500
  const st = await enable();
  assert.deepEqual(prompts(), ['UserSignedAddAPIKeyAction']);
  assert.deepEqual(st.builder?.engines, { spot: 500, perps: 200 });
});

// --- approve --------------------------------------------------------------------------------

test('approve: the fee is disclosed, ONE additional typed-data signature recovers the owner, both engines confirm', async () => {
  const st = await enable();
  // 1. What the user was shown before anything was signed.
  assert.deepEqual(dialog.shown, [{ builderId: BID, perps: 50, spot: 100, maxFeeRate: 100, required: false, alreadyApproved: [], purpose: 'enable' }]);
  // 2. Two wallet prompts, in this order, each announced to the UI.
  assert.deepEqual(prompts(), ['ApproveBuilderFeeAction', 'UserSignedAddAPIKeyAction']);
  assert.deepEqual(steps, ['builder-approval', 'key-registration']);
  // 3. The typed data: universal domain on the wallet's chain, the SoDEX network id in the message, the maximum only.
  const td = wallet.asked[0]!.td;
  assert.deepEqual(td.domain, { name: 'universal', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' });
  assert.deepEqual(td.types.ApproveBuilderFeeAction.map((f: { name: string; type: string }) => `${f.type} ${f.name}`), [
    'uint64 chainID', 'uint64 nonce', 'uint64 accountID', 'uint64 builderID', 'uint64 maxFeeRate',
  ]);
  assert.equal(td.message.chainID, String(SODEX));
  assert.equal(td.message.accountID, String(AID));
  assert.equal(td.message.builderID, String(BID));
  assert.equal(td.message.maxFeeRate, '100', 'the configured maximum - not more');
  // 4. The request, sent from the browser straight to the gateway.
  const [w] = builderWrites();
  assert.equal(builderWrites().length, 1);
  assert.equal(w!.url, `${GW}/api/v1/user/${OWNER}/builders`);
  assert.equal(w!.raw, `{"accountID":${AID},"builderID":${BID},"maxFeeRate":100}`);
  assert.equal(w!.headers['X-API-Chain'], '42161', 'X-API-Chain == the domain chainId');
  assert.equal(w!.headers['X-API-Nonce'], td.message.nonce, 'the same nonce in the message and the header');
  assert.equal(w!.headers['X-API-Sign']!.slice(0, 4), '0x02', 'universal signature type');
  assert.equal(hexToBytes(w!.headers['X-API-Sign']!).length, 66);
  assert.ok(hexToBytes(w!.headers['X-API-Sign']!)[65]! <= 1, 'v normalised to 0/1');
  assert.deepEqual(world.approvalSigners, [OWNER], 'the gateway recovers the account owner');
  // 5. Read first, sign, then read again: the approval is recorded where SoDEX lists it.
  assert.ok(world.sent.indexOf(builderReads()[0]!) < world.sent.indexOf(w!), 'read before asking');
  assert.ok(world.sent.indexOf(builderReads().at(-1)!) > world.sent.indexOf(w!), 're-read after sending');
  assert.ok(world.sent.indexOf(w!) < world.sent.indexOf(registrations()[0]!), 'approval before the key registration');
  assert.equal(st.status, 'enabled');
  assert.deepEqual(st.builder, { id: BID, maxFeeRate: 100, engines: { spot: 100, perps: 100 } });
  assert.equal(builderApprovalPending(), false);
});

test('an approval lower than what this build charges is not enough: the configured maximum is asked for', async () => {
  preApprove(50, 50); // covers perps (50) but not spot (100)
  const st = await enable();
  assert.deepEqual(dialog.shown[0]!.alreadyApproved, ['perps']);
  assert.equal(builderWrites()[0]!.body.maxFeeRate, 100);
  assert.deepEqual(st.builder?.engines, { spot: 100, perps: 100 });
});

// --- decline ---------------------------------------------------------------------------------

test('optional + declined: no approval signature, trading works WITHOUT a builder fee', async () => {
  dialog.answer = 'decline';
  const st = await enable();
  assert.deepEqual(prompts(), ['UserSignedAddAPIKeyAction']);
  assert.equal(builderWrites().length, 0);
  assert.equal(st.status, 'enabled');
  assert.equal(st.builder, null);
  await perpsOrder();
  await spotOrder();
  assert.ok(!orders('perps')[0]!.raw.includes('builder'));
  assert.ok(!orders('spot')[0]!.raw.includes('builder'));
  assert.ok(logged().some((e) => e.ns === 'trade' && /builder fee: not approved/.test(e.msg)), 'the reason is logged');
});

test('optional + yes in the dialog, no in the wallet: trading is still enabled, without the fee', async () => {
  wallet.rejects.add('ApproveBuilderFeeAction');
  const st = await enable();
  assert.deepEqual(prompts(), ['ApproveBuilderFeeAction', 'UserSignedAddAPIKeyAction']);
  assert.equal(builderWrites().length, 0, 'a rejected signature sends nothing');
  assert.equal(st.status, 'enabled');
  assert.equal(st.builder, null);
  assert.ok(logged().some((e) => e.ns === 'trade' && /did not go through/.test(e.msg) && /declined in the wallet/.test(JSON.stringify(e.data))));
});

test('optional + the dialog is closed: enabling is cancelled, nothing is signed, trading stays off', async () => {
  dialog.answer = 'cancel';
  await assert.rejects(enable(), (e: unknown) => e instanceof TradingError && e.kind === 'cancelled');
  assert.deepEqual(prompts(), []);
  assert.equal(registrations().length + builderWrites().length, 0);
  assert.equal(getTradingState().status, 'off');
});

test('no disclosure, no approval: a caller that cannot show the terms never gets a signature', async () => {
  const st = await enableTrading({ owner: OWNER, provider: wallet });
  assert.deepEqual(prompts(), ['UserSignedAddAPIKeyAction']);
  assert.equal(st.builder, null);
  configure(REQUIRED);
  await assert.rejects(enableTrading({ owner: OWNER, provider: wallet }), (e: unknown) => e instanceof TradingError && e.kind === 'builder-required');
});

test('REQUIRED + declined: trading stays off with a clear message, and NO key is registered', async () => {
  configure(REQUIRED);
  for (const answer of ['decline', 'cancel'] as const) {
    dialog.answer = answer;
    await assert.rejects(
      enable(),
      (e: unknown) => e instanceof TradingError && e.kind === 'builder-required' && /requires approving its builder fee, so trading stays off/.test(e.message),
      answer,
    );
  }
  assert.equal(dialog.shown[0]!.required, true);
  assert.deepEqual(prompts(), [], 'the wallet was never asked');
  assert.equal(registrations().length, 0, 'no orphan key on SoDEX');
  assert.equal(getTradingState().status, 'off');
});

test('REQUIRED + rejected in the wallet: trading stays off, the key is never requested', async () => {
  configure(REQUIRED);
  wallet.rejects.add('ApproveBuilderFeeAction');
  await assert.rejects(enable(), (e: unknown) => e instanceof TradingError && e.kind === 'builder-required' && /stays off/.test(e.message));
  assert.deepEqual(prompts(), ['ApproveBuilderFeeAction']);
  assert.equal(registrations().length, 0);
  assert.equal(getTradingState().status, 'off');
});

// --- the gateway says no ------------------------------------------------------------------------

test('the gateway rejects the approval (optional): trading works without a builder fee and the reason is logged', async () => {
  world.refuse = { status: 400, body: { code: 400, error: 'spot builder USDC balance is insufficient' } };
  const st = await enable();
  assert.equal(st.status, 'enabled');
  assert.equal(st.builder, null);
  assert.deepEqual(prompts(), ['ApproveBuilderFeeAction', 'UserSignedAddAPIKeyAction']);
  await perpsOrder();
  assert.ok(!orders('perps')[0]!.raw.includes('builder'));
  const refusals = logged().filter((e) => e.ns === 'trade' && e.level === 'warn' && /builder fee: the approval did not go through/.test(e.msg));
  assert.ok(refusals.some((e) => /spot builder USDC balance is insufficient/.test(JSON.stringify(e.data))), 'SoDEX\'s own reason is in the log');
});

test('the gateway rejects the approval (REQUIRED): trading stays off and says why; no key is registered', async () => {
  configure(REQUIRED);
  world.refuse = { status: 400, body: { code: 400, error: 'perps builder USDC balance is insufficient' } };
  await assert.rejects(
    enable(),
    (e: unknown) => e instanceof TradingError && e.kind === 'builder-required' && /perps builder USDC balance is insufficient/.test(e.message) && /stays off/.test(e.message),
  );
  assert.equal(registrations().length, 0);
  assert.equal(getTradingState().status, 'off');
});

test('SoDEX cannot be asked about approvals: optional goes on without the fee (and looks again later), required refuses', async () => {
  world.readsFail = true;
  const st = await enable();
  assert.equal(st.status, 'enabled');
  assert.equal(st.builder, null);
  assert.equal(dialog.shown.length, 0, 'unknown is not "not approved": nothing is asked');
  assert.equal(builderApprovalPending(), true);
  // The approval was there all along: the next look finds it.
  preApprove(100, 100);
  world.readsFail = false;
  assert.deepEqual((await refreshBuilderApproval())?.engines, { spot: 100, perps: 100 });
  assert.equal(builderApprovalPending(), false);

  _resetTradingForTests(memoryVault());
  configure(REQUIRED);
  world.readsFail = true;
  wallet.asked = [];
  await assert.rejects(enable(), (e: unknown) => e instanceof TradingError && e.kind === 'network');
  assert.deepEqual(prompts(), []);
});

// --- one engine only, and lag ----------------------------------------------------------------------

test('approval visible in one engine only: the fee is attached on that engine alone', async () => {
  world.hidden.add('perps');
  const st = await enable();
  assert.deepEqual(st.builder, { id: BID, maxFeeRate: 100, engines: { spot: 100 } });
  assert.equal(builderApprovalPending(), true, 'SoDEX accepted it: keep looking for the other engine');
  await spotOrder();
  assert.deepEqual(orders('spot')[0]!.body.builder, { id: BID, fee: 100 });
  // Perps: SoDEX would reject an order naming a builder it does not list there - so none is named.
  await perpsOrder();
  assert.equal(orders('perps')[0]!.body.builder, undefined);
  // Once it shows up, perps orders carry it too (the order itself re-reads while one is pending).
  world.hidden.clear();
  world.approvals.perps.set(BID, 100);
  await perpsOrder();
  assert.deepEqual(orders('perps')[1]!.body.builder, { id: BID, fee: 50 });
  assert.equal(builderApprovalPending(), false);
});

test('REQUIRED + one engine only: orders on the other engine are refused, not sent without the fee', async () => {
  configure(REQUIRED);
  world.hidden.add('perps');
  const st = await enable();
  assert.equal(st.status, 'enabled');
  await spotOrder();
  assert.deepEqual(orders('spot')[0]!.body.builder, { id: BID, fee: 100 });
  await assert.rejects(perpsOrder(), (e: unknown) => e instanceof TradingError && e.kind === 'builder-required' && /does not list your approval/.test(e.message));
  assert.equal(orders('perps').length, 0, 'nothing was sent');
});

test('lagging query: the first reads after the approval still show nothing; polling with backoff finds it', async () => {
  world.lagReads = 2;
  const st = await enable();
  assert.deepEqual(st.builder?.engines, { spot: 100, perps: 100 });
  assert.equal(builderReads().length, 4, 'one before, then 2 stale answers, then the approval');
  assert.equal(builderWrites().length, 1, 'the approval was sent once - never re-sent while waiting');
  assert.equal(builderApprovalPending(), false);
});

test('lag longer than the wait: trading is enabled without the fee attached, and it is picked up as soon as SoDEX lists it', async () => {
  world.lagReads = 50;
  const st = await enable();
  assert.equal(st.status, 'enabled');
  assert.equal(st.builder, null, 'nothing is listed yet: nothing is attached');
  assert.equal(builderApprovalPending(), true);
  assert.equal(builderWrites().length, 1);
  await perpsOrder();
  assert.equal(orders('perps')[0]!.body.builder, undefined, 'still not listed: the order goes out without (SoDEX would reject it otherwise)');
  // The index catches up.
  world.lagReads = 0;
  await perpsOrder();
  assert.deepEqual(orders('perps')[1]!.body.builder, { id: BID, fee: 50 });
  assert.deepEqual(getTradingState().builder?.engines, { spot: 100, perps: 100 });
  assert.equal(builderWrites().length, 1, 'still exactly one approval sent');
});

test('no answer to the approval: it is READ before anything else - an approval that did land is found', async () => {
  world.silent = 'landed';
  const st = await enable();
  assert.equal(builderWrites().length, 1);
  assert.deepEqual(st.builder?.engines, { spot: 100, perps: 100 });
});

test('no answer and nothing landed: no fee for now; pressing Enable again re-reads first and signs with a FRESH nonce', async () => {
  world.silent = 'lost';
  const first = await enable();
  assert.equal(first.builder, null);
  assert.equal(builderApprovalPending(), true);
  world.silent = null;
  const readsBefore = builderReads().length;
  const second = await enable();
  assert.deepEqual(second.builder?.engines, { spot: 100, perps: 100 });
  const [a, b] = builderWrites();
  assert.equal(builderWrites().length, 2);
  assert.notEqual(a!.headers['X-API-Nonce'], b!.headers['X-API-Nonce'], 'a fresh nonce for the retry');
  assert.ok(BigInt(b!.headers['X-API-Nonce']!) > BigInt(a!.headers['X-API-Nonce']!));
  assert.ok(world.sent.indexOf(builderReads()[readsBefore]!) < world.sent.indexOf(b!), 're-queried before the retry');

  // REQUIRED: an unanswered approval that SoDEX does not list leaves trading off.
  _resetTradingForTests(memoryVault());
  world.approvals = { spot: new Map(), perps: new Map() };
  world.silent = 'lost';
  configure(REQUIRED);
  await assert.rejects(enable(), (e: unknown) => e instanceof TradingError && e.kind === 'builder-required' && /did not answer/.test(e.message));
  assert.equal(getTradingState().status, 'off');
});

// --- orders ---------------------------------------------------------------------------------------------

test('orders carry the builder LAST, per engine, with that engine\'s fee - signed by the trading key over those exact bytes', async () => {
  const st = await enable();
  await perpsOrder();
  await spotOrder();
  const p = orders('perps')[0]!;
  const s = orders('spot')[0]!;
  assert.ok(p.raw.endsWith(`,"builder":{"id":${BID},"fee":50}}`), p.raw);
  assert.ok(s.raw.endsWith(`,"builder":{"id":${BID},"fee":100}}`), s.raw);
  assert.deepEqual(Object.keys(p.body), ['accountID', 'symbolID', 'orders', 'builder']);
  assert.deepEqual(Object.keys(s.body), ['accountID', 'orders', 'builder']);
  // The fake only answered because the signature covers these bytes (builder included) and recovers the key.
  assert.equal(exchangeSigner(p, 'perps', 'newOrder'), st.keyAddress);
  assert.equal(exchangeSigner(s, 'spot', 'batchNewOrder'), st.keyAddress);
  assert.deepEqual(prompts(), ['ApproveBuilderFeeAction', 'UserSignedAddAPIKeyAction'], 'no wallet prompt for an order');
  // A perps entry with exits is ONE batch: the builder is still last, after all three legs.
  await placeOrder('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01', takeProfit: { price: '90000' }, stopLoss: { price: '80000' } });
  const withExits = orders('perps')[1]!;
  assert.equal(withExits.body.orders.length, 3);
  assert.equal(Object.keys(withExits.body).at(-1), 'builder');
  assert.ok(withExits.body.orders.every((o: object) => !('builder' in o)), 'batch level only');
});

test('an engine this build does not charge on never names the builder, approved or not', async () => {
  configure({ id: BID, fee: { perps: 50, spot: 0 }, maxFeeRate: 50, required: true });
  const st = await enable();
  assert.deepEqual(dialog.shown[0], { builderId: BID, perps: 50, spot: 0, maxFeeRate: 50, required: true, alreadyApproved: [], purpose: 'enable' });
  assert.deepEqual(st.builder?.engines, { spot: 50, perps: 50 }, 'SoDEX lists the approval on both engines');
  await spotOrder();
  assert.equal(orders('spot')[0]!.body.builder, undefined, 'no spot fee configured: nothing attached, and nothing required');
  await perpsOrder();
  assert.deepEqual(orders('perps')[0]!.body.builder, { id: BID, fee: 50 });
});

test('revoked somewhere else: SoDEX rejects the order that names the builder, the approval is re-read, the next order goes out without it', async () => {
  await enable();
  world.approvals = { spot: new Map(), perps: new Map() }; // revoked from another device
  await assert.rejects(perpsOrder(), (e: unknown) => e instanceof SodexApiError && /builder fee is not approved/.test(e.message));
  await tick();
  assert.equal(getTradingState().builder, null, 'no longer attached');
  await perpsOrder();
  assert.equal(orders('perps')[1]!.body.builder, undefined);
  assert.equal(orders('perps').length, 2, 'nothing was re-sent automatically');
  assert.ok(logged().some((e) => e.level === 'warn' && /SoDEX no longer lists the approval/.test(e.msg)));
});

test('a restored key re-reads the approval: what the device remembers is only a hint', async () => {
  const vault = memoryVault();
  _resetTradingForTests(vault);
  await enable();
  // A reload, after the approval was revoked elsewhere.
  _resetTradingForTests(vault);
  world.approvals = { spot: new Map(), perps: new Map() };
  const restored = await restoreTrading(OWNER);
  assert.deepEqual(restored.builder?.engines, { spot: 100, perps: 100 }, 'the stored hint, until SoDEX answers');
  await tick();
  assert.equal(getTradingState().builder, null);
  // ...and approved again elsewhere: found on the next load, with no signature here.
  _resetTradingForTests(vault);
  preApprove(100, 100);
  wallet.asked = [];
  await restoreTrading(OWNER);
  await tick();
  assert.deepEqual(getTradingState().builder?.engines, { spot: 100, perps: 100 });
  assert.deepEqual(prompts(), []);
  // The update is stored with the key.
  _resetTradingForTests(vault);
  world.readsFail = true;
  assert.deepEqual((await restoreTrading(OWNER)).builder?.engines, { spot: 100, perps: 100 });
});

// --- revoke -------------------------------------------------------------------------------------------------

test('revoke: ONE wallet signature for maxFeeRate 0, both lists cleared, the builder is no longer attached', async () => {
  await enable();
  await perpsOrder();
  assert.ok(orders('perps')[0]!.body.builder);
  wallet.asked = [];
  const r = await revokeBuilderApproval({ owner: OWNER, provider: wallet });
  assert.deepEqual(r, { cleared: true, nothingToRevoke: false, tradingTurnedOff: false });
  assert.deepEqual(prompts(), ['ApproveBuilderFeeAction'], 'one signature');
  assert.equal(wallet.asked[0]!.td.message.maxFeeRate, '0');
  const w = builderWrites().at(-1)!;
  assert.equal(w.raw, `{"accountID":${AID},"builderID":${BID},"maxFeeRate":0}`, 'the zero is sent, not dropped');
  assert.equal(world.approvalSigners.at(-1), OWNER);
  assert.equal(world.approvals.spot.size + world.approvals.perps.size, 0, 'both arrays cleared');
  assert.equal(getTradingState().status, 'enabled', 'trading stays on in an optional build');
  assert.equal(getTradingState().builder, null);
  await perpsOrder();
  await spotOrder();
  assert.equal(orders('perps')[1]!.body.builder, undefined);
  assert.equal(orders('spot')[0]!.body.builder, undefined);
  assert.equal(await readBuilderApproval(OWNER), null);
});

test('revoke with lagging reads: polled until both lists are clear', async () => {
  await enable();
  world.lagReads = 2;
  const r = await revokeBuilderApproval({ owner: OWNER, provider: wallet });
  assert.equal(r.cleared, true);
  assert.equal(getTradingState().builder, null);
});

test('revoke in a REQUIRED build: the approval is cleared and trading is turned off on this device', async () => {
  configure(REQUIRED);
  await enable();
  const r = await revokeBuilderApproval({ owner: OWNER, provider: wallet });
  assert.deepEqual(r, { cleared: true, nothingToRevoke: false, tradingTurnedOff: true });
  assert.equal(getTradingState().status, 'off');
  await assert.rejects(perpsOrder(), TradingError);
});

test('revoke with nothing approved signs nothing', async () => {
  dialog.answer = 'decline';
  await enable();
  wallet.asked = [];
  const r = await revokeBuilderApproval({ owner: OWNER, provider: wallet });
  assert.deepEqual(r, { cleared: true, nothingToRevoke: true, tradingTurnedOff: false });
  assert.deepEqual(prompts(), []);
  assert.equal(builderWrites().length, 0);
});

test('revoke declined in the wallet, or refused by SoDEX: nothing changes here', async () => {
  await enable();
  wallet.rejects.add('ApproveBuilderFeeAction');
  await assert.rejects(revokeBuilderApproval({ owner: OWNER, provider: wallet }), WalletError);
  assert.deepEqual(getTradingState().builder?.engines, { spot: 100, perps: 100 });
  wallet.rejects.clear();
  // SoDEX checks the BUILDER's balance even for a revocation.
  world.refuse = { status: 400, body: { code: 400, error: 'spot builder USDC balance is insufficient' } };
  await assert.rejects(revokeBuilderApproval({ owner: OWNER, provider: wallet }), (e: unknown) => e instanceof SodexApiError && /insufficient/.test(e.message));
  assert.deepEqual(getTradingState().builder?.engines, { spot: 100, perps: 100 });
  await perpsOrder();
  assert.deepEqual(orders('perps').at(-1)!.body.builder, { id: BID, fee: 50 }, 'still approved on SoDEX, still attached');
});

test('revoke works with trading off: the approval is the account\'s, not the key\'s', async () => {
  preApprove(100, 100);
  await restoreTrading(OWNER);
  assert.equal(getTradingState().status, 'off');
  assert.deepEqual((await readBuilderApproval(OWNER))?.engines, { spot: 100, perps: 100 });
  const r = await revokeBuilderApproval({ owner: OWNER, provider: wallet });
  assert.equal(r.cleared, true);
  assert.equal(world.approvals.spot.size + world.approvals.perps.size, 0);
  assert.equal(builderWrites()[0]!.body.accountID, AID, 'the primary account id, looked up');
});

test('writes switched off: neither an approval nor a revocation is ever signed', async () => {
  setTradingConfig({ writesAllowed: false });
  await assert.rejects(enable(), (e: unknown) => e instanceof TradingError && e.kind === 'writes-off');
  await assert.rejects(revokeBuilderApproval({ owner: OWNER, provider: wallet }), (e: unknown) => e instanceof TradingError && e.kind === 'writes-off');
  await assert.rejects(approveBuilderFee({ owner: OWNER, provider: wallet, confirmBuilderFee: dialog.ask }), (e: unknown) => e instanceof TradingError && e.kind === 'writes-off');
  assert.deepEqual(prompts(), []);
  assert.equal(world.sent.filter((s) => s.method !== 'GET').length, 0);
});

// --- approving on its own (after enabling without the fee) ----------------------------------------

const approve1 = (extra: Partial<Parameters<typeof approveBuilderFee>[0]> = {}) =>
  approveBuilderFee({ owner: OWNER, provider: wallet, confirmBuilderFee: dialog.ask, onStep: (s) => steps.push(s), ...extra });

test('approve later: enabled without the fee, then ONE signature approves it and the next order carries the builder', async () => {
  dialog.answer = 'decline';
  await enable();
  await perpsOrder();
  assert.equal(orders('perps')[0]!.body.builder, undefined, 'declined: no builder on the order');
  wallet.asked = [];
  dialog.shown = [];
  dialog.answer = 'approve';
  steps.length = 0;
  const r = await approve1();
  assert.deepEqual(r, { status: 'approved', approval: { id: BID, maxFeeRate: 100, engines: { spot: 100, perps: 100 } } });
  assert.equal(dialog.shown.length, 1, 'the same disclosure, shown before the wallet is asked');
  // ...and told that it is asked on its own: it must not offer to "enable trading".
  assert.deepEqual(dialog.shown[0], { builderId: BID, perps: 50, spot: 100, maxFeeRate: 100, required: false, alreadyApproved: [], purpose: 'approve' });
  assert.deepEqual(prompts(), ['ApproveBuilderFeeAction'], 'ONE signature - the key is not registered again');
  assert.deepEqual(steps, ['builder-approval']);
  assert.equal(registrations().length, 2, 'only the registration from enabling (spot + perps)');
  const w = builderWrites();
  assert.equal(w.length, 1);
  assert.equal(w[0]!.raw, `{"accountID":${AID},"builderID":${BID},"maxFeeRate":100}`);
  assert.equal(world.approvalSigners.at(-1), OWNER, 'the signature recovers the owner');
  assert.deepEqual(getTradingState().builder?.engines, { spot: 100, perps: 100 }, 'the session follows what SoDEX lists');
  await perpsOrder();
  await spotOrder();
  assert.deepEqual(orders('perps')[1]!.body.builder, { id: BID, fee: 50 });
  assert.deepEqual(orders('spot')[0]!.body.builder, { id: BID, fee: 100 });
});

test('approve later, already approved: nothing is shown, nothing is signed', async () => {
  preApprove(500, 200);
  const r = await approve1();
  assert.equal(r.status, 'already');
  assert.deepEqual(r.approval?.engines, { spot: 500, perps: 200 });
  assert.equal(dialog.shown.length, 0);
  assert.deepEqual(prompts(), []);
  assert.equal(builderWrites().length, 0);
});

test('approve later: declined in the dialog, or no dialog at all - nothing is signed and nothing changes', async () => {
  dialog.answer = 'decline';
  await enable();
  wallet.asked = [];
  for (const answer of ['decline', 'cancel'] as const) {
    dialog.answer = answer;
    assert.deepEqual(await approve1(), { status: 'declined', approval: null });
  }
  assert.deepEqual(await approveBuilderFee({ owner: OWNER, provider: wallet }), { status: 'declined', approval: null }, 'without a disclosure nothing is ever signed');
  assert.deepEqual(prompts(), []);
  assert.equal(builderWrites().length, 0);
  assert.equal(getTradingState().builder, null);
});

test('approve later: the wallet declines, or SoDEX refuses - the caller is told, and orders stay without the fee', async () => {
  dialog.answer = 'decline';
  await enable();
  dialog.answer = 'approve';
  wallet.rejects.add('ApproveBuilderFeeAction');
  await assert.rejects(approve1(), WalletError);
  wallet.rejects.clear();
  world.refuse = { status: 400, body: { code: 400, error: 'spot builder USDC balance is insufficient' } };
  await assert.rejects(approve1(), (e: unknown) => e instanceof SodexApiError && /insufficient/.test(e.message));
  assert.equal(getTradingState().builder, null);
  assert.equal(getTradingState().status, 'enabled', 'trading stays on');
  await perpsOrder();
  assert.equal(orders('perps').at(-1)!.body.builder, undefined);
  assert.ok(logged().some((e) => e.level === 'warn' && /the approval did not go through/.test(e.msg) && /insufficient/.test(JSON.stringify(e.data))));
});

test('approve later: SoDEX cannot be asked what it lists - nothing is signed blind', async () => {
  world.readsFail = true;
  await assert.rejects(approve1(), (e: unknown) => e instanceof TradingError && e.kind === 'network');
  assert.deepEqual(prompts(), []);
  assert.equal(dialog.shown.length, 0);
});

test('approve later: accepted but not listed everywhere yet is "pending" and followed up; no answer and nothing listed is an error', async () => {
  dialog.answer = 'decline';
  await enable();
  dialog.answer = 'approve';
  world.hidden.add('perps');
  const r = await approve1();
  assert.equal(r.status, 'pending');
  assert.deepEqual(r.approval?.engines, { spot: 100 });
  assert.equal(builderApprovalPending(), true, 'it is re-read before the next order');
  world.hidden.clear();
  world.approvals.perps.set(BID, 100);
  await perpsOrder();
  assert.deepEqual(orders('perps').at(-1)!.body.builder, { id: BID, fee: 50 }, 're-read, now listed, attached');
  assert.equal(builderApprovalPending(), false);
  // A request that never arrived: SoDEX lists nothing, and says nothing.
  world.approvals = { spot: new Map(), perps: new Map() };
  await refreshBuilderApproval();
  world.silent = 'lost';
  await assert.rejects(approve1(), (e: unknown) => e instanceof TradingError && e.kind === 'network' && /did not confirm/.test(e.message));
  // The same, but it landed: read after the silence, found, approved.
  world.silent = 'landed';
  const landed = await approve1();
  assert.equal(landed.status, 'approved');
});

test('approve later works with trading off (the approval is the account\'s); the key enabled afterwards finds it', async () => {
  const r = await approve1();
  assert.equal(r.status, 'approved');
  assert.equal(getTradingState().status, 'off', 'no key was registered');
  assert.equal(builderWrites()[0]!.body.accountID, AID, 'the primary account id, looked up');
  dialog.shown = [];
  wallet.asked = [];
  const st = await enable();
  assert.equal(dialog.shown.length, 0, 'nothing to ask');
  assert.deepEqual(prompts(), ['UserSignedAddAPIKeyAction']);
  assert.deepEqual(st.builder?.engines, { spot: 100, perps: 100 });
});

test('approve later with no builder configured: there is nothing to approve', async () => {
  configure(null);
  await assert.rejects(approve1(), (e: unknown) => e instanceof TradingError && e.kind === 'not-enabled');
  assert.equal(world.sent.length, 0);
});

test('a REQUIRED build with a key from before it had a builder: orders are refused with a way out, and approving once fixes it', async () => {
  configure(null);
  await enable();
  configure(REQUIRED);
  await assert.rejects(perpsOrder(), (e: unknown) => e instanceof TradingError && e.kind === 'builder-required' && /press "ValueDesk fee"/.test(e.message));
  assert.equal(orders('perps').length, 0, 'never sent without the fee');
  const r = await approve1();
  assert.equal(r.status, 'approved');
  assert.equal(dialog.shown[0]!.required, true);
  await perpsOrder();
  assert.deepEqual(orders('perps')[0]!.body.builder, { id: BID, fee: 50 });
});

test('an approval signed by another wallet account never leaves the browser', async () => {
  const stranger = generateTradingKey();
  const wrong = {
    request: async (a: { method: string; params?: unknown[] }) => {
      if (a.method !== 'eth_signTypedData_v4') return wallet.request(a);
      const td = JSON.parse((a.params as string[])[1]!);
      wallet.asked.push({ primaryType: td.primaryType, td });
      if (td.primaryType !== 'ApproveBuilderFeeAction') return wallet.request(a);
      const raw = hexToBytes(signTypedDataWithKey(td, stranger.privateKey)).slice(1);
      raw[64] = raw[64]! + 27;
      return bytesToHex(raw);
    },
  };
  const st = await enable({ provider: wrong });
  assert.equal(builderWrites().length, 0, 'refused before sending');
  assert.equal(st.builder, null);
  assert.ok(logged().some((e) => /did not go through/.test(e.msg) && /must be signed by the account owner/.test(JSON.stringify(e.data))));
});
