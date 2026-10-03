/**
 * The fee guard, end to end in the trading session (docs/BUILDER-TIERS.md
 * sections 1, 2 and 8): what an order placed through the app carries, and that
 * NOTHING a user can change locally ends in an order without the builder or
 * below the fee owed. Each manipulation of section 1 is a test here:
 *
 *   the stored approval deleted / edited / forged      -> the builder, or no order
 *   the vault entry tampered with                      -> the builder, or no order
 *   the approval revoked or lowered on SoDEX           -> no order until approved again
 *   the terms request blocked                          -> the default fee
 *   the terms answer rewritten                         -> the default fee
 *   terms that ran out                                 -> the default fee
 *
 * A fake wallet, a fake SoDEX gateway that VERIFIES the trading key's signature
 * over the exact bytes of every order and - like the real one - REJECTS an order
 * naming a builder the account has not approved for that fee, and a fake terms
 * server that signs with a real Ed25519 key. Nothing leaves the process.
 *   npx tsx --test src/trading/feeGuardFlow.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  OrderValidationError,
  SodexApiError,
  bytesToHex,
  eip712Digest,
  engineDomainName,
  exchangeActionStructHash,
  generateTradingKey,
  hexToBytes,
  keccak256,
  makeDomain,
  payloadJSONFromBody,
  recoverAddress,
  signTypedDataWithKey,
  utf8,
  type Engine,
  type OrderRow,
} from '@sodex-core';
import { gateway as exchangeGateway } from '../exchange/sodexGateway';
import { changeOrder, changeRoute, modifyOrder, placeOrder, recreateOrder, replaceOrder, ticketFromOpenOrder } from './actions';
import { _setBuilderPollDelaysForTests } from './builderApproval';
import { setTradingConfig, type BuilderConfig } from './config';
import { builderNow } from './feeGuard';
import { _resetTradingForTests, approveBuilderFee, enableTrading, getTradingState, restoreTrading, TradingError, type BuilderChoice } from './session';
import { TERMS_PATH, _resetTermsForTests, configureTerms, feeNow, refreshTerms } from './terms';
import { memoryVault, type KeyVault } from './vault';

// --- a wallet -----------------------------------------------------------------------

const master = generateTradingKey();
const OWNER = master.address.toLowerCase();
const AID = 4242;
const SODEX = 286623;
const GW = 'https://gw.test';
const BID = 123456;
/** The contract's test values: perps 20 and spot 20 by default, maximum 20, required. */
const REQUIRED: BuilderConfig = { id: BID, fee: { perps: 20, spot: 20 }, maxFeeRate: 20, required: true };
const OPTIONAL: BuilderConfig = { ...REQUIRED, required: false };

const wallet = {
  asked: [] as string[],
  async request({ method, params }: { method: string; params?: unknown[] }) {
    if (method === 'eth_chainId') return '0xa4b1';
    if (method === 'eth_signTypedData_v4') {
      const td = JSON.parse((params as [string, string])[1]);
      wallet.asked.push(td.primaryType);
      const raw = hexToBytes(signTypedDataWithKey(td, master.privateKey)).slice(1);
      raw[64] = raw[64]! + 27;
      return bytesToHex(raw);
    }
    throw new Error(`unexpected wallet call ${method}`);
  },
};

// --- a terms server --------------------------------------------------------------------

const subtle = globalThis.crypto.subtle;
const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const PUB = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const clock = { mono: 1_000, wall: 1_790_000_000_000 };

const termsApi = {
  /** Counted volume per wallet, USD - what the server's verifier would have found on SoDEX. */
  volumeUsd: 0,
  /** The tiers of the contract's test: 20, and 15 on perps once more than 10 USDC went through. */
  feeFor: (volumeUsd: number) => (volumeUsd > 10 ? { perps: 15, spot: 20 } : { perps: 20, spot: 20 }),
  down: false,
  rewrite: null as null | ((body: any) => any),
  requests: [] as Array<{ address: string; hint: boolean }>,
};

async function termsServer(url: string): Promise<Response> {
  const u = new URL(url);
  const address = u.searchParams.get('address')!;
  const nonce = u.searchParams.get('nonce')!;
  termsApi.requests.push({ address, hint: u.searchParams.get('hint') === '1' });
  if (termsApi.down) throw new TypeError('fetch failed');
  const fee = termsApi.feeFor(termsApi.volumeUsd);
  const issued = clock.wall;
  const ttl = 600_000;
  const msg = `valuescan-builder-terms/1\nchain:${SODEX}\nbuilder:${BID}\naddress:${address}\nperps:${fee.perps}\nspot:${fee.spot}\nnonce:${nonce}\nissued:${issued}\nttl:${ttl}`;
  const sig = Buffer.from(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(msg))).toString('base64url');
  let body: any = {
    ok: true, chain: SODEX, builderId: BID, address, fee, nonce, issued, ttl, keyId: 'k', sig,
    default: { perps: 20, spot: 20 },
    volume: { perpsUsd: termsApi.volumeUsd, spotUsd: 0, totalUsd: termsApi.volumeUsd, verifiedAt: issued, pending: false },
    tier: fee.perps === 20 ? { index: 0, next: { atUsd: 10, fee: { perps: 15, spot: 20 } } } : { index: 1, next: null },
    flags: [],
  };
  if (termsApi.rewrite) body = termsApi.rewrite(body) ?? body;
  return new Response(JSON.stringify(body), { status: 200 });
}

// --- a SoDEX gateway that checks signatures ------------------------------------------------

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  raw: string;
  /** What the gateway did with it. */
  accepted?: boolean;
}

const world = {
  /** Approved fee rate per engine for our builder - what GET /builders lists. null: not listed. */
  approved: { spot: 20 as number | null, perps: 20 as number | null },
  /** GET /builders gets no answer. */
  buildersDown: false,
  keys: { spot: [], perps: [] } as Record<Engine, Array<{ name: string; publicKey: string; expiresAt: number }>>,
  /** Resting orders, as GET /orders lists them. */
  open: { spot: [], perps: [] } as Record<Engine, OrderRow[]>,
  /** The next POST of a new order is rejected with this. */
  rejectNextOrder: null as null | string,
  nextOrderId: 9_000,
  sent: [] as Sent[],
};

const SYMBOLS = [{ id: 7, name: 'BTC-USD', displayName: 'BTC-USD', tickSize: '0.5', stepSize: '0.001', minQuantity: '0.001', minNotional: '5', maxLeverage: 50 }];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => reply({ code: 0, data, timestamp: Date.now() });
const builderRows = (rate: number | null) => (rate === null ? [] : [{ userID: AID, builderID: BID, feeRate: rate }]);

/** Who signed an exchange action (X-API-Sign over {type, params} of the body bytes). */
function signerOf(s: Sent, engine: Engine, type: string): string {
  const payloadHash = keccak256(utf8(payloadJSONFromBody(type, s.raw)));
  const digest = eip712Digest(makeDomain(engineDomainName(engine), SODEX), exchangeActionStructHash(payloadHash, BigInt(s.headers['X-API-Nonce']!)));
  return recoverAddress(digest, hexToBytes(s.headers['X-API-Sign']!).slice(1)).toLowerCase();
}
const keySigned = (s: Sent, engine: Engine, type: string): boolean => {
  const key = world.keys[engine].find((k) => k.name === s.headers['X-API-Key']);
  return !!key && signerOf(s, engine, type) === key.publicKey.toLowerCase();
};

const SIDE = { 1: 'BUY', 2: 'SELL' } as const;
const TYPE = { 1: 'LIMIT', 2: 'MARKET' } as const;
const TIF = { 1: 'GTC', 2: 'FOK', 3: 'IOC', 4: 'GTX' } as const;

function newOrder(s: Sent, engine: Engine): Response {
  if (!keySigned(s, engine, engine === 'perps' ? 'newOrder' : 'batchNewOrder')) return reply({ code: 401, error: 'API key error: invalid signature' }, 401);
  if (s.body.accountID !== AID) return reply({ code: 400, error: 'account mismatch' }, 400);
  const b = s.body.builder;
  if (b !== undefined) {
    assert.equal(Object.keys(s.body).at(-1), 'builder', 'builder is the LAST key of the batch');
    assert.deepEqual(Object.keys(b), ['id', 'fee'], 'id before fee');
    const approved = b.id === BID ? world.approved[engine] : null;
    // What SoDEX does: a builder the account has not approved for this fee is rejected.
    if (approved === null || b.fee > approved) return reply({ code: 400, error: 'builder fee is not approved' }, 400);
  }
  if (world.rejectNextOrder) {
    const error = world.rejectNextOrder;
    world.rejectNextOrder = null;
    return reply({ code: 400, error }, 400);
  }
  s.accepted = true;
  return ok(
    s.body.orders.map((o: any) => {
      const orderID = world.nextOrderId++;
      // A limit GTC/GTX order away from the market rests.
      if (o.type === 1 && (o.timeInForce === 1 || o.timeInForce === 4)) {
        world.open[engine].push({
          orderID, clOrdID: o.clOrdID, symbol: 'BTC-USD', side: SIDE[o.side as 1 | 2], type: TYPE[o.type as 1 | 2], timeInForce: TIF[o.timeInForce as 1 | 2 | 3 | 4],
          price: o.price, origQty: o.quantity, executedQty: '0', executedValue: '0', status: 'NEW', reduceOnly: o.reduceOnly === true,
          ...(b ? { builder: { builderID: b.id, feeRate: b.fee } } : {}),
        });
      }
      return { code: 0, clOrdID: o.clOrdID, orderID };
    }),
  );
}

function cancel(s: Sent, engine: Engine): Response {
  if (!keySigned(s, engine, engine === 'perps' ? 'cancelOrder' : 'batchCancelOrder')) return reply({ code: 401, error: 'API key error: invalid signature' }, 401);
  const out = s.body.cancels.map((c: { orderID?: number; clOrdID?: string }) => {
    const i = world.open[engine].findIndex((o) => o.orderID === c.orderID);
    if (i < 0) return { code: 404, clOrdID: c.clOrdID, error: 'order not found' };
    world.open[engine].splice(i, 1);
    return { code: 0, clOrdID: c.clOrdID, orderID: c.orderID };
  });
  s.accepted = true;
  return ok(out);
}

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const raw = typeof init?.body === 'string' ? init.body : '';
  if (url.startsWith('/api/md/')) return reply({ symbols: SYMBOLS });
  if (/\/api\/v1\/(spot|perps)\/markets\/symbols$/.test(url)) return ok(SYMBOLS);
  const path = url.replace(GW, '');
  const s: Sent = { method: init?.method ?? 'GET', path, headers: (init?.headers ?? {}) as Record<string, string>, body: raw ? JSON.parse(raw) : null, raw };
  world.sent.push(s);
  if (path === `/api/v1/user/${OWNER}/subaccounts`) return ok({ userID: AID, primaryAccountID: AID, subaccounts: [] });
  if (/^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: AID, B: [] });
  if (path === `/api/v1/user/${OWNER}/builders`) {
    if (s.method === 'GET') {
      if (world.buildersDown) throw new TypeError('fetch failed');
      return ok({ spot: builderRows(world.approved.spot), perps: builderRows(world.approved.perps) });
    }
    // An approval or a revocation (its signature is builderFlow.test.ts's subject).
    world.approved = s.body.maxFeeRate === 0 ? { spot: null, perps: null } : { spot: s.body.maxFeeRate, perps: Math.min(s.body.maxFeeRate, 200) };
    return ok(null);
  }
  const ex = /^\/api\/v1\/(spot|perps)\/exchange$/.exec(path);
  if (ex && s.method === 'POST' && s.body?.type === 'addAPIKey') {
    const engine = ex[1] as Engine;
    world.keys[engine] = world.keys[engine].filter((k) => k.name !== s.body.params.name).concat({ name: s.body.params.name, publicKey: s.body.params.publicKey, expiresAt: s.body.params.expiresAt });
    return ok(null);
  }
  const keys = /^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/api-keys$/.exec(path);
  if (keys) return ok(world.keys[keys[1] as Engine]);
  const open = /^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/orders(\?.*)?$/.exec(path);
  if (open && s.method === 'GET') return ok({ blockTime: Date.now(), blockHeight: 1, orders: world.open[open[1] as Engine] });
  if (path === '/api/v1/perps/trade/orders') return s.method === 'DELETE' ? cancel(s, 'perps') : newOrder(s, 'perps');
  if (path === '/api/v1/spot/trade/orders/batch') return s.method === 'DELETE' ? cancel(s, 'spot') : newOrder(s, 'spot');
  const change = /^\/api\/v1\/(spot|perps)\/trade\/orders\/(modify|replace)$/.exec(path);
  if (change && s.method === 'POST') {
    if (!keySigned(s, change[1] as Engine, change[2] === 'modify' ? 'modifyOrder' : 'replaceOrder')) return reply({ code: 401, error: 'API key error: invalid signature' }, 401);
    s.accepted = true;
    return ok(change[2] === 'modify' ? { orderID: s.body.orderID } : s.body.orders.map((o: any) => ({ code: 0, clOrdID: o.clOrdID, orderID: world.nextOrderId++ })));
  }
  return reply({ code: 404, error: `fake gateway: ${s.method} ${path}` }, 404);
}) as typeof fetch;

// --- fixtures ----------------------------------------------------------------------------------

let vault: KeyVault = memoryVault();
const dialog = { answer: 'approve' as BuilderChoice, shown: 0 };
const enable = () =>
  enableTrading({
    owner: OWNER,
    provider: wallet,
    confirmBuilderFee: async () => {
      dialog.shown += 1;
      return dialog.answer;
    },
  });

const ordersSent = (engine: Engine) => world.sent.filter((s) => s.method === 'POST' && s.path === `/api/v1/${engine}/trade/orders${engine === 'spot' ? '/batch' : ''}`);
const accepted = (engine: Engine) => ordersSent(engine).filter((s) => s.accepted);
const writes = () => world.sent.filter((s) => s.method !== 'GET' && !/\/exchange$/.test(s.path) && !/\/builders$/.test(s.path));
const perps = (price = '84000') => placeOrder('perps', { symbol: 'BTC-USD', side: 'buy', price, quantity: '0.01' });
const spot = () => placeOrder('spot', { symbol: 'BTC-USD', side: 'sell', price: '84000', quantity: '0.01' });
const ours = (fee: number) => ({ id: BID, fee });
const isRefusal = (kind: TradingError['kind'], why?: RegExp) => (e: unknown) => e instanceof TradingError && e.kind === kind && (!why || why.test(e.message));

function configure(builder: BuilderConfig | null): void {
  setTradingConfig({ network: 'mainnet', chainId: SODEX, gateway: GW, writesAllowed: true, disabled: false, keyTtlMs: 7 * 24 * 3_600_000, builder });
  configureTerms({ keys: [PUB], endpoint: `https://vs.test${TERMS_PATH}`, fetch: termsServer, monotonicNow: () => clock.mono, wallNow: () => clock.wall });
}

/** A page reload: the session forgets everything and restores from the (same) vault. */
async function reload(): Promise<void> {
  _resetTradingForTests(vault);
  await restoreTrading(OWNER);
}

/** Change what the vault holds about the builder approval, the way a user with the devtools open could. */
async function tamper(builder: unknown): Promise<void> {
  const hit = await vault.load('mainnet', OWNER);
  assert.ok(hit, 'a key is stored');
  await vault.save({ ...hit!.meta, builder: builder as never }, hit!.privateKey);
}

/** Let the terms request the session started on its own (enable / restore) finish. */
const termsSettled = () => refreshTerms(OWNER);

function resetReadBudget(): void {
  (exchangeGateway.budget as unknown as { mem: unknown[] }).mem = [];
  try {
    (globalThis as { localStorage?: { removeItem(k: string): void } }).localStorage?.removeItem('vs:ledger:sodex-gw');
  } catch {
    /* no storage in this runtime */
  }
}

beforeEach(() => {
  world.approved = { spot: 20, perps: 20 };
  world.buildersDown = false;
  world.keys = { spot: [], perps: [] };
  world.open = { spot: [], perps: [] };
  world.rejectNextOrder = null;
  world.nextOrderId = 9_000;
  world.sent = [];
  wallet.asked = [];
  dialog.answer = 'approve';
  dialog.shown = 0;
  termsApi.volumeUsd = 0;
  termsApi.down = false;
  termsApi.rewrite = null;
  termsApi.requests = [];
  clock.mono = 1_000;
  clock.wall = 1_790_000_000_000;
  vault = memoryVault();
  _resetTermsForTests();
  configure(REQUIRED);
  _setBuilderPollDelaysForTests([0, 2, 2]);
  _resetTradingForTests(vault);
  resetReadBudget();
});

// --- what an order carries -----------------------------------------------------------------------

test('a required build, the default fee: every order carries the pinned builder at 20, last in the batch, signed by the trading key', async () => {
  await enable();
  await termsSettled();
  assert.deepEqual(builderNow('perps'), ours(20));
  assert.deepEqual(builderNow('spot'), ours(20));
  await perps();
  await spot();
  assert.deepEqual(accepted('perps')[0]!.body.builder, ours(20));
  assert.deepEqual(accepted('spot')[0]!.body.builder, ours(20));
  assert.ok(accepted('perps')[0]!.raw.endsWith(`,"builder":{"id":${BID},"fee":20}}`));
});

test('the simulated run of the contract: volume passes the milestone, the terms change, the NEXT order carries the lower fee', async () => {
  await enable();
  await termsSettled();
  assert.deepEqual(termsApi.requests[0], { address: OWNER, hint: false }, 'terms are asked for when trading is enabled');
  assert.equal(feeNow('perps', OWNER), 20);
  await perps();
  await perps();
  assert.deepEqual(accepted('perps').map((s) => s.body.builder.fee), [20, 20], 'the first orders carry the default');
  // More than 10 USDC of volume went through us; the server has verified it.
  termsApi.volumeUsd = 12.4;
  assert.deepEqual((await refreshTerms(OWNER, { hint: true }))?.fee, { perps: 15, spot: 20 });
  assert.deepEqual(termsApi.requests.at(-1), { address: OWNER, hint: true });
  assert.deepEqual(builderNow('perps'), ours(15));
  await perps();
  await spot();
  assert.equal(accepted('perps').at(-1)!.body.builder.fee, 15, 'the next perps order carries 15');
  assert.ok(accepted('perps').at(-1)!.raw.endsWith(`,"builder":{"id":${BID},"fee":15}}`));
  assert.equal(accepted('spot').at(-1)!.body.builder.fee, 20, 'spot stays at 20');
  // SoDEX's own record of the resting orders names the builder at the fee each was placed with.
  assert.deepEqual(world.open.perps.map((o) => o.builder), [{ builderID: BID, feeRate: 20 }, { builderID: BID, feeRate: 20 }, { builderID: BID, feeRate: 15 }]);
});

test('terms follow the trading key: asked for on enable and again on restore; a reload starts from the default', async () => {
  termsApi.volumeUsd = 50;
  await enable();
  await termsSettled();
  assert.equal(feeNow('perps', OWNER), 15);
  const asked = termsApi.requests.length;
  // A reload: nothing of the terms was stored anywhere. Until the new answer arrives the fee is the default.
  _resetTermsForTests();
  configure(REQUIRED);
  _resetTradingForTests(vault);
  assert.equal(feeNow('perps', OWNER), 20, 'verified terms live in memory only');
  await restoreTrading(OWNER);
  await termsSettled();
  assert.ok(termsApi.requests.length > asked, 'asked again when the key is restored');
  assert.equal(feeNow('perps', OWNER), 15);
  await perps();
  assert.equal(accepted('perps').at(-1)!.body.builder.fee, 15);
});

test('an order placed the moment the page loads still gets the wallet\'s tier: the terms are awaited (briefly) before it is built', async () => {
  termsApi.volumeUsd = 50;
  await enable();
  // No waiting for the terms here: the order itself makes sure of them.
  await perps();
  assert.equal(accepted('perps')[0]!.body.builder.fee, 15);
});

// --- the manipulations of section 1 ------------------------------------------------------------------

test('the terms request is BLOCKED: the default fee, never a lower one', async () => {
  termsApi.volumeUsd = 50;
  termsApi.down = true;
  await enable();
  await termsSettled();
  assert.equal(feeNow('perps', OWNER), 20);
  await perps();
  assert.deepEqual(accepted('perps')[0]!.body.builder, ours(20));
});

test('the terms answer is REWRITTEN (the developer tools, a proxy): the default fee', async () => {
  termsApi.rewrite = (b) => ({ ...b, fee: { perps: 0, spot: 0 }, default: { perps: 0, spot: 0 } });
  await enable();
  await termsSettled();
  await perps();
  await spot();
  assert.deepEqual(accepted('perps')[0]!.body.builder, ours(20));
  assert.deepEqual(accepted('spot')[0]!.body.builder, ours(20));
  // The same for an answer taken from a wallet that HAS the lower tier and replayed for this one.
  termsApi.rewrite = (b) => ({ ...b, address: OWNER, fee: { perps: 15, spot: 20 } });
  assert.equal(await refreshTerms(OWNER), null);
  await perps();
  assert.equal(accepted('perps').at(-1)!.body.builder.fee, 20);
});

test('terms that RAN OUT: a tier that is no longer vouched for is not kept - the default again', async () => {
  termsApi.volumeUsd = 50;
  await enable();
  await termsSettled();
  await perps();
  assert.equal(accepted('perps')[0]!.body.builder.fee, 15);
  // The server stops answering, and time passes.
  termsApi.down = true;
  clock.mono += 600_000;
  await perps();
  assert.equal(accepted('perps')[1]!.body.builder.fee, 20, 'after the ttl the order pays the default');
});

test('the stored approval is DELETED from the browser: SoDEX is asked instead, and the order carries the builder', async () => {
  await enable();
  await tamper(null);
  await reload();
  await perps();
  await spot();
  assert.deepEqual(accepted('perps')[0]!.body.builder, ours(20));
  assert.deepEqual(accepted('spot')[0]!.body.builder, ours(20));
  assert.equal(writes().every((s) => s.body.builder !== undefined), true, 'no order left without it');
});

test('...and when SoDEX cannot be asked either, NO order is sent', async () => {
  await enable();
  await tamper(null);
  world.buildersDown = true;
  await reload();
  await assert.rejects(perps(), isRefusal('builder-required', /requires it/));
  await assert.rejects(spot(), isRefusal('builder-required'));
  assert.equal(ordersSent('perps').length + ordersSent('spot').length, 0, 'nothing was signed, nothing was sent');
});

test('the stored approval is EDITED (another builder, lower numbers, nonsense): what it says is not what the order follows', async () => {
  for (const forged of [
    { id: 999, maxFeeRate: 2000, engines: { spot: 2000, perps: 200 } }, // another builder account
    { id: BID, maxFeeRate: 1, engines: { spot: 1, perps: 1 } }, // "I only approved 1"
    { id: BID, maxFeeRate: 0, engines: {} },
    { id: BID },
    'none',
    { id: BID, maxFeeRate: 20, engines: { spot: 'x', perps: -5 } },
  ]) {
    _resetTradingForTests(vault);
    await enable();
    world.sent = [];
    await tamper(forged);
    await reload();
    await perps();
    await spot();
    assert.deepEqual(accepted('perps')[0]!.body.builder, ours(20), JSON.stringify(forged));
    assert.deepEqual(accepted('spot')[0]!.body.builder, ours(20), JSON.stringify(forged));
  }
});

test('the approval is REVOKED on SoDEX while the browser still remembers it: SoDEX rejects the order, and the app sends nothing more', async () => {
  await enable();
  world.approved = { spot: null, perps: null };
  // The browser still believes in the approval: the order goes out WITH the builder - and SoDEX rejects it.
  await assert.rejects(perps(), (e: unknown) => e instanceof SodexApiError && /builder fee is not approved/.test(e.message));
  assert.deepEqual(ordersSent('perps')[0]!.body.builder, ours(20), 'what was sent named the builder');
  assert.equal(accepted('perps').length, 0, 'nothing was accepted');
  // The rejection made the app read the approval again: from now on the order is not even sent.
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(perps(), isRefusal('builder-required'));
  await assert.rejects(spot(), isRefusal('builder-required'));
  assert.equal(ordersSent('perps').length, 1);
  assert.equal(ordersSent('spot').length, 0);
  assert.equal(getTradingState().builder, null);
  // ...until it is approved again.
  world.approved = { spot: 20, perps: 20 };
  await perps();
  assert.deepEqual(accepted('perps')[0]!.body.builder, ours(20));
});

test('a FORGED "approved" in the vault while SoDEX lists none: the order is rejected by SoDEX, never sent without the builder', async () => {
  world.approved = { spot: null, perps: null };
  dialog.answer = 'approve';
  await enable(); // approves 20 through the fake
  world.approved = { spot: null, perps: null }; // ...then revoked elsewhere
  await tamper({ id: BID, maxFeeRate: 2000, engines: { spot: 2000, perps: 200 } });
  // Keep the restore's own re-read from correcting the forgery before the order: SoDEX cannot be asked right now.
  world.buildersDown = true;
  await reload();
  assert.deepEqual(getTradingState().builder?.engines, { spot: 2000, perps: 200 }, 'the session believes the forged record for the moment');
  await assert.rejects(perps(), (e: unknown) => e instanceof SodexApiError && /builder fee is not approved/.test(e.message));
  assert.deepEqual(ordersSent('perps')[0]!.body.builder, ours(20));
  assert.equal(accepted('perps').length, 0);
});

test('the approval is LOWERED on SoDEX below the fee owed: no order until it is approved again - or the wallet\'s own tier fits under it', async () => {
  await enable();
  await termsSettled();
  world.approved = { spot: 20, perps: 15 };
  await assert.rejects(perps(), (e: unknown) => e instanceof SodexApiError && /builder fee is not approved/.test(e.message));
  assert.equal(accepted('perps').length, 0);
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(perps(), isRefusal('builder-required'));
  assert.equal(ordersSent('perps').length, 1, 'the second one never left');
  // Spot is still covered.
  await spot();
  assert.deepEqual(accepted('spot')[0]!.body.builder, ours(20));
  // A wallet on the 15 tier owes 15: an approval of 15 covers that - and the order carries exactly 15, not less.
  termsApi.volumeUsd = 50;
  await refreshTerms(OWNER);
  await perps();
  assert.deepEqual(accepted('perps')[0]!.body.builder, ours(15));
});

test('declining the approval: a required build does not enable trading at all; only an optional build trades without the fee', async () => {
  world.approved = { spot: null, perps: null };
  dialog.answer = 'decline';
  await assert.rejects(enable(), isRefusal('builder-required'));
  assert.equal(getTradingState().status, 'off');
  assert.equal(world.keys.perps.length, 0, 'no key was registered');
  await assert.rejects(perps(), isRefusal('not-enabled'));
  // VITE_BUILDER_REQUIRED=0, a test build:
  configure(OPTIONAL);
  await enable();
  await perps();
  assert.equal(accepted('perps')[0]!.body.builder, undefined);
  assert.equal(builderNow('perps'), undefined);
});

// --- G6: changing an order ------------------------------------------------------------------------------

test('G6, required build: a REPLACE is made as cancel + new order with the builder - SoDEX\'s replace request is not sent', async () => {
  await enable();
  await termsSettled();
  await perps('84000');
  const original = world.open.perps[0]!;
  world.sent = [];
  const r = await replaceOrder('perps', { symbol: 'BTC-USD', origOrderID: original.orderID, price: '83000.5' });
  assert.equal((r as { recreated?: boolean }).recreated, true);
  const w = writes();
  assert.deepEqual(w.map((s) => `${s.method} ${s.path}`), ['DELETE /api/v1/perps/trade/orders', 'POST /api/v1/perps/trade/orders'], 'cancel, then a new order');
  assert.equal(w.some((s) => /\/replace$/.test(s.path)), false);
  assert.deepEqual(w[0]!.body.cancels, [{ symbolID: 7, orderID: original.orderID }]);
  const order = w[1]!.body;
  assert.deepEqual(order.builder, ours(20), 'the new order carries the builder');
  assert.equal(order.orders.length, 1);
  assert.equal(order.orders[0].price, '83000.5');
  assert.equal(order.orders[0].quantity, '0.01');
  assert.equal(order.orders[0].side, 1);
  assert.equal(order.orders[0].type, 1);
  assert.equal(order.orders[0].timeInForce, 1);
  assert.equal(world.open.perps.length, 1, 'one order rests again');
  assert.notEqual(world.open.perps[0]!.orderID, original.orderID);
  assert.deepEqual(world.open.perps[0]!.builder, { builderID: BID, feeRate: 20 });
});

test('G6, required build, spot: the same - and a partly filled order is recreated for what is LEFT of it', async () => {
  await enable();
  await spot();
  const original = world.open.spot[0]!;
  original.executedQty = '0.004';
  original.status = 'PARTIALLY_FILLED';
  world.sent = [];
  await replaceOrder('spot', { symbol: 'BTC-USD', origClOrdID: original.clOrdID, price: '85000' });
  const w = writes();
  assert.deepEqual(w.map((s) => `${s.method} ${s.path}`), ['DELETE /api/v1/spot/trade/orders/batch', 'POST /api/v1/spot/trade/orders/batch']);
  assert.equal(w[1]!.body.orders[0].quantity, '0.006', '0.01 - 0.004');
  assert.equal(w[1]!.body.orders[0].side, 2);
  assert.deepEqual(w[1]!.body.builder, ours(20));
});

test('G6: a MODIFY keeps the order (same id), so SoDEX\'s own request is used - one request, no cancel', async () => {
  await enable();
  await perps();
  const original = world.open.perps[0]!;
  world.sent = [];
  await modifyOrder({ symbol: 'BTC-USD', orderID: original.orderID, price: '83000' });
  assert.deepEqual(writes().map((s) => `${s.method} ${s.path}`), ['POST /api/v1/perps/trade/orders/modify']);
});

test('G6: where no builder is required (an optional build, no builder at all) a replace is SoDEX\'s replace request, as it always was', async () => {
  for (const b of [OPTIONAL, null]) {
    configure(b);
    _resetTradingForTests(memoryVault());
    await enable();
    world.open.perps = [];
    await perps();
    world.sent = [];
    await replaceOrder('perps', { symbol: 'BTC-USD', origOrderID: world.open.perps[0]!.orderID, price: '83000' });
    assert.deepEqual(writes().map((s) => `${s.method} ${s.path}`), ['POST /api/v1/perps/trade/orders/replace'], b ? 'optional' : 'no builder');
  }
});

test('G6: an order that cannot be rebuilt exactly is refused BEFORE anything is cancelled', async () => {
  await enable();
  await perps();
  const o = world.open.perps[0]!;
  const untouched = async (why: RegExp, change: Parameters<typeof recreateOrder>[2] = { price: '83000' }) => {
    world.sent = [];
    await assert.rejects(recreateOrder('perps', { symbol: 'BTC-USD', orderID: o.orderID }, change), (e: unknown) => e instanceof OrderValidationError && why.test(e.message));
    assert.equal(writes().length, 0, 'nothing was cancelled, nothing was sent');
    assert.equal(world.open.perps.length, 1, 'the order is still resting');
  };
  o.attachedOrderIDs = [77];
  await untouched(/take-profit or stop-loss attached/);
  o.attachedOrderIDs = undefined;
  o.primaryOrderID = 5;
  await untouched(/attached to another order/);
  o.primaryOrderID = undefined;
  o.executedQty = '0.01';
  await untouched(/nothing of it is left/);
  o.executedQty = '0';
  await untouched(/no trigger price to change/, { stopPrice: '80000' });
  // A change the market's own rules forbid (a size below the minimum) is caught by the app's validation - still before the cancel.
  world.sent = [];
  await assert.rejects(recreateOrder('perps', { symbol: 'BTC-USD', orderID: o.orderID }, { quantity: '0.0001' }), (e: unknown) => e instanceof OrderValidationError && /rounds to zero|below the minimum/.test(e.message));
  assert.equal(writes().length, 0);
  assert.equal(world.open.perps.length, 1);
  // An order that is not open any more.
  await assert.rejects(recreateOrder('perps', { symbol: 'BTC-USD', orderID: 1 }, { price: '83000' }), (e: unknown) => e instanceof OrderValidationError && /no longer open/.test(e.message));
  // And when the approval is gone, the original is not sacrificed for an order that cannot be placed.
  world.approved = { spot: null, perps: null };
  await tamper(null);
  await reload();
  world.sent = [];
  await assert.rejects(recreateOrder('perps', { symbol: 'BTC-USD', orderID: o.orderID }, { price: '83000' }), isRefusal('builder-required'));
  assert.equal(writes().length, 0);
  assert.equal(world.open.perps.length, 1);
});

test('G6: if SoDEX refuses the new order after the cancel, the error says in plain words that the original is gone', async () => {
  await enable();
  await perps();
  const o = world.open.perps[0]!;
  world.rejectNextOrder = 'insufficient margin';
  await assert.rejects(
    recreateOrder('perps', { symbol: 'BTC-USD', orderID: o.orderID }, { price: '83000' }),
    isRefusal('recreate-failed', /Your order was cancelled, but the changed order was not accepted \(.*insufficient margin.*\)\. Nothing is resting on SoDEX for it now - place it again\./),
  );
  assert.equal(world.open.perps.length, 0);
});

test('ticketFromOpenOrder: the open order as SoDEX lists it, with the change applied', () => {
  const row = (extra: Partial<OrderRow> = {}): OrderRow => ({ orderID: 1, symbol: 'BTC-USD', side: 'SELL', type: 'LIMIT', timeInForce: 'GTX', price: '84000', origQty: '0.5', executedQty: '0.125', executedValue: '0', status: 'PARTIALLY_FILLED', ...extra });
  assert.deepEqual(ticketFromOpenOrder('BTC-USD', row(), { price: '85000' }), { symbol: 'BTC-USD', side: 'sell', type: 'limit', price: '85000', quantity: '0.375', tif: 'gtx', reduceOnly: false });
  // A new size is a new TOTAL: 0.2 ordered in all, of which 0.125 has filled - the new order is for 0.075.
  assert.deepEqual(ticketFromOpenOrder('BTC-USD', row({ reduceOnly: true }), { quantity: '0.2' }), { symbol: 'BTC-USD', side: 'sell', type: 'limit', price: '84000', quantity: '0.075', tif: 'gtx', reduceOnly: true });
  assert.throws(() => ticketFromOpenOrder('BTC-USD', row(), { quantity: '0.1' }), (e: unknown) => e instanceof OrderValidationError && /not above what has already filled/.test(e.message));
  // The stream's numeric enums read the same as REST's names.
  assert.deepEqual(ticketFromOpenOrder('BTC-USD', row({ side: 2 as never, type: 1 as never, timeInForce: 4 as never }), {}), { symbol: 'BTC-USD', side: 'sell', type: 'limit', price: '84000', quantity: '0.375', tif: 'gtx', reduceOnly: false });
  // A stand-alone stop: its trigger moves, the rest stays.
  assert.deepEqual(
    ticketFromOpenOrder('BTC-USD', row({ type: 'MARKET', timeInForce: 'IOC', price: undefined, stopPrice: '80000', stopType: 'STOP_LOSS', triggerType: 'MARK_PRICE', reduceOnly: true, executedQty: '0' }), { stopPrice: '79000' }),
    { symbol: 'BTC-USD', side: 'sell', type: 'market', quantity: '0.5', tif: 'ioc', reduceOnly: true, stopPrice: '79000', stopType: 'sl', triggerType: 'mark' },
  );
  for (const [bad, why] of [
    [row({ side: 'SIDEWAYS' as never }), /side/],
    [row({ type: 'STOP_LIMIT' }), /type is STOP_LIMIT/],
    [row({ timeInForce: 'GTD' }), /time in force is gtd/],
    [row({ origQty: undefined, funds: '100' }), /not listed as a quantity/],
    [row({ price: undefined }), /does not list its price/],
    [row({ stopPrice: '80000' }), /what its trigger is/],
  ] as const) {
    assert.throws(() => ticketFromOpenOrder('BTC-USD', bad, {}), (e: unknown) => e instanceof OrderValidationError && why.test(e.message) && /Cancel it and place a new one/.test(e.message), String(why));
  }
});

// --- changing a resting order: ONE function (changeOrder) ---------------------------------------------

const tpslRow = (extra: Partial<OrderRow> = {}): OrderRow => ({
  orderID: 777, clOrdID: 'vs-tpsl-1', symbol: 'BTC-USD', side: 'SELL', type: 'MARKET', timeInForce: 'IOC', origQty: '0.01', executedQty: '0', executedValue: '0',
  status: 'NEW', reduceOnly: true, stopPrice: '90000', stopType: 'TAKE_PROFIT', triggerType: 'MARK_PRICE', positionID: 5, ...extra,
});
const limitRow = (extra: Partial<OrderRow> = {}): OrderRow => ({
  orderID: 778, clOrdID: 'vs-lim-1', symbol: 'BTC-USD', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '84000', origQty: '0.01', executedQty: '0', executedValue: '0',
  status: 'NEW', reduceOnly: false, ...extra,
});
const writeLines = () => writes().map((s) => `${s.method} ${s.path}`);

test('changeRoute: a TP/SL is modified; a plain limit GTC/GTX is replaced - or cancel + new where the builder is required; anything else is refused', () => {
  // The required build of beforeEach.
  assert.equal(changeRoute('perps', tpslRow(), { stopPrice: '91000' }), 'modify', 'a position take-profit');
  assert.equal(changeRoute('perps', tpslRow({ stopType: 'STOP_LOSS', stopPrice: '80000', positionID: undefined, reduceOnly: false }), { stopPrice: '79000' }), 'modify', 'a stand-alone stop');
  assert.equal(changeRoute('perps', tpslRow({ primaryOrderID: 12 }), { stopPrice: '91000' }), 'modify', 'an exit attached to an entry');
  assert.equal(changeRoute('perps', limitRow(), { price: '83000' }), 'recreate');
  assert.equal(changeRoute('perps', limitRow({ timeInForce: 'GTX', status: 'PARTIALLY_FILLED' }), { quantity: '0.02' }), 'recreate');
  assert.equal(changeRoute('spot', limitRow(), { price: '83000' }), 'recreate');
  // The stream's numeric enums read like REST's names.
  assert.equal(changeRoute('perps', limitRow({ type: 1 as never, timeInForce: 4 as never, status: 1 as never }), { price: '83000' }), 'recreate');
  assert.equal(changeRoute('perps', tpslRow({ stopType: 2 as never }), { stopPrice: '91000' }), 'modify');
  // Where no builder is required, SoDEX's own replace request is used.
  configure(OPTIONAL);
  assert.equal(changeRoute('perps', limitRow(), { price: '83000' }), 'replace');
  configure(null);
  assert.equal(changeRoute('spot', limitRow(), { price: '83000' }), 'replace');
  assert.equal(changeRoute('perps', tpslRow(), { stopPrice: '91000' }), 'modify');
  configure({ ...REQUIRED, fee: { perps: 20, spot: 0 } });
  assert.equal(changeRoute('spot', limitRow(), { price: '83000' }), 'replace', 'an engine the build does not charge on');
  assert.equal(changeRoute('perps', limitRow(), { price: '83000' }), 'recreate');
  configure(REQUIRED);
  const refused = (engine: Engine, row: OrderRow, change: Parameters<typeof changeRoute>[2], why: RegExp) =>
    assert.throws(() => changeRoute(engine, row, change), (e: unknown) => e instanceof OrderValidationError && why.test(e.message), String(why));
  refused('perps', limitRow(), {}, /Nothing to change/);
  refused('perps', limitRow(), { price: '  ', quantity: '' }, /Nothing to change/);
  refused('perps', limitRow(), { stopPrice: '80000' }, /it has no trigger price\. Cancel it and place a new one\./);
  refused('perps', limitRow({ timeInForce: 'IOC' }), { price: '83000' }, /only good-till-cancelled and post-only limit orders, and this one is IOC/);
  refused('perps', limitRow({ type: 'MARKET', timeInForce: 'IOC', price: undefined }), { quantity: '0.02' }, /only resting limit orders and take-profit \/ stop-loss orders can be changed/);
  refused('perps', limitRow({ status: 'FILLED' }), { price: '83000' }, /its status is filled/);
  refused('perps', limitRow({ status: 'PENDING_CANCEL' }), { price: '83000' }, /its status is pending cancel/);
  refused('spot', tpslRow(), { stopPrice: '91000' }, /spot has no take-profit or stop-loss orders/);
});

test('changeOrder, required build: a plain limit order is changed as cancel + new order WITH the builder - SoDEX\'s replace request is never sent', async () => {
  await enable();
  await termsSettled();
  await perps('84000');
  const o = world.open.perps[0]!;
  world.sent = [];
  // What the chart sends: the dragged price, and the size verbatim.
  const r = await changeOrder('perps', { symbol: 'BTC-USD', orderID: o.orderID }, { price: '83000.5', quantity: '0.01' });
  assert.equal(r.route, 'recreate');
  assert.deepEqual(writeLines(), ['DELETE /api/v1/perps/trade/orders', 'POST /api/v1/perps/trade/orders']);
  const read = world.sent.findIndex((s) => s.method === 'GET' && /\/orders\?symbol=/.test(s.path));
  assert.ok(read >= 0 && read < world.sent.indexOf(writes()[0]!), 'the order is read from SoDEX before anything is written');
  const placed = writes()[1]!.body;
  assert.deepEqual(placed.builder, ours(20));
  assert.deepEqual([placed.orders[0].price, placed.orders[0].quantity, placed.orders[0].side, placed.orders[0].modifier, placed.orders[0].reduceOnly], ['83000.5', '0.01', 1, 1, false]);
  assert.deepEqual(world.open.perps.map((x) => [x.price, x.builder]), [['83000.5', { builderID: BID, feeRate: 20 }]]);
});

test('changeOrder: a take-profit / stop-loss is changed with SoDEX\'s modify request - one request, by order id only, no cancel', async () => {
  await enable();
  world.open.perps.push(tpslRow({ orderID: 4321, clOrdID: 'sl-x' }));
  world.sent = [];
  // The positions table's TP/SL edit.
  const r = await changeOrder('perps', { symbol: 'BTC-USD', orderID: 4321 }, { stopPrice: '91000.2' });
  assert.equal(r.route, 'modify');
  assert.deepEqual(writeLines(), ['POST /api/v1/perps/trade/orders/modify']);
  assert.deepEqual(writes()[0]!.body, { accountID: AID, symbolID: 7, orderID: 4321, stopPrice: '91000' }, 'snapped to the tick; nothing else is sent');
  // Found by its client id as well - and still sent by order id only (SoDEX: "either orderID or clOrdID").
  world.sent = [];
  await changeOrder('perps', { symbol: 'BTC-USD', clOrdID: 'sl-x' }, { stopPrice: '91500' });
  assert.equal(writes()[0]!.body.orderID, 4321);
  assert.equal('clOrdID' in writes()[0]!.body, false);
});

test('changeOrder, optional build: a plain limit order is replaced with SoDEX\'s request, sending only what changes', async () => {
  configure(OPTIONAL);
  await enable();
  await perps('84000');
  const o = world.open.perps[0]!;
  world.sent = [];
  // The Modify dialog sends both fields; only the price differs from the order's.
  const r = await changeOrder('perps', { symbol: 'BTC-USD', orderID: o.orderID }, { price: '83000', quantity: '0.010' });
  assert.equal(r.route, 'replace');
  assert.deepEqual(writeLines(), ['POST /api/v1/perps/trade/orders/replace']);
  const item = writes()[0]!.body.orders[0];
  assert.deepEqual(Object.keys(item), ['symbolID', 'clOrdID', 'origOrderID', 'price'], 'no origClOrdID, no unchanged quantity');
  assert.deepEqual([item.origOrderID, item.price], [o.orderID, '83000']);
  world.sent = [];
  await assert.rejects(changeOrder('perps', { symbol: 'BTC-USD', orderID: o.orderID }, { price: '84000.0', quantity: '0.01' }), (e: unknown) => e instanceof OrderValidationError && /already has/.test(e.message));
  assert.equal(writes().length, 0);
});

test('changeOrder refuses what SoDEX cannot change - before anything is signed', async () => {
  await enable();
  world.open.perps.push(limitRow({ orderID: 55, timeInForce: 'IOC' }));
  world.sent = [];
  await assert.rejects(changeOrder('perps', { symbol: 'BTC-USD', orderID: 55 }, { price: '83000' }), (e: unknown) => e instanceof OrderValidationError && /IOC/.test(e.message));
  await assert.rejects(changeOrder('perps', { symbol: 'BTC-USD', orderID: 56 }, { price: '83000' }), (e: unknown) => e instanceof OrderValidationError && /no longer open/.test(e.message));
  await assert.rejects(changeOrder('perps', { symbol: 'BTC-USD' }, { price: '83000' }), (e: unknown) => e instanceof OrderValidationError && /orderID or clOrdID/.test(e.message));
  assert.equal(writes().length, 0);
});

test('approving the fee on its own after a revocation (the key options): the next order carries the builder at the fee owed again', async () => {
  termsApi.volumeUsd = 50;
  await enable();
  await termsSettled();
  world.approved = { spot: null, perps: null };
  await tamper(null);
  await reload();
  await termsSettled();
  await assert.rejects(perps(), isRefusal('builder-required'));
  const asked = wallet.asked.length;
  const r = await approveBuilderFee({ owner: OWNER, provider: wallet, confirmBuilderFee: async () => 'approve' });
  assert.equal(r.status, 'approved');
  assert.deepEqual(wallet.asked.slice(asked), ['ApproveBuilderFeeAction'], 'one signature, no new key');
  await perps();
  assert.deepEqual(accepted('perps').at(-1)!.body.builder, ours(15), 'the wallet\'s tier, not the default');
});
