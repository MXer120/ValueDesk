/**
 * The browser trading flow end to end, against a fake wallet and a fake SoDEX
 * gateway: enable (one wallet signature, sodex.com's own registration on both
 * engines), sign and send orders with the trading key, per-order rejections, a
 * key SoDEX no longer knows or replaced, partial registration, no account,
 * expiry, withdrawals, turning off.
 *   npx tsx --test src/trading/session.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToHex,
  eip712Digest,
  engineDomainName,
  exchangeActionStructHash,
  generateTradingKey,
  hashTypedData,
  hexToBytes,
  keccak256,
  makeDomain,
  payloadJSONFromBody,
  recoverAddress,
  signTypedDataWithKey,
  userSignedAddAPIKeyTypedData,
  utf8,
  type Engine,
} from '@sodex-core';
import { setTradingConfig } from './config';
import { memoryVault } from './vault';
import {
  _resetTradingForTests,
  checkKeyAfterRejection,
  disableTrading,
  enableTrading,
  getTradingState,
  refreshAccount,
  restoreTrading,
  requireSigner,
  tradingKeyName,
  TradingError,
} from './session';
import { cancelAll, placeOrder, withdraw } from './actions';
import { _resetAcceptanceForTests, _signedTermsForTests, browseAccepted, setTermsGate, signedTerms } from '../legal/acceptance';
import { _resetGeoForTests } from '../legal/geo';

// --- a wallet and a gateway --------------------------------------------------

const master = generateTradingKey();
const OWNER = master.address.toLowerCase();
const AID = 4242;

/** An EIP-1193 wallet on Arbitrum that signs typed data with `master`. */
const wallet = {
  prompts: 0,
  chainId: 42161,
  switched: 0,
  lastTyped: null as any,
  async request({ method, params }: { method: string; params?: unknown[] }) {
    if (method === 'eth_chainId') return `0x${this.chainId.toString(16)}`;
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
      this.switched++;
      return null;
    }
    if (method === 'eth_signTypedData_v4') {
      this.prompts++;
      const [addr, json] = params as [string, string];
      assert.equal(addr.toLowerCase(), OWNER, 'the wallet is asked to sign as the owner');
      const td = JSON.parse(json);
      // MetaMask's rule: typed data for another chain is refused.
      assert.equal(Number(td.domain.chainId), this.chainId, 'the domain is the chain the wallet is on');
      this.lastTyped = td;
      const wire = hexToBytes(signTypedDataWithKey(td, master.privateKey));
      const raw = wire.slice(1); // wallets return r || s || v with v 27/28
      raw[64] = raw[64]! + 27;
      return bytesToHex(raw);
    }
    throw new Error(`unexpected wallet call ${method}`);
  },
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  raw: string;
}
let sent: Sent[] = [];
let reply: (s: Sent) => { status?: number; body: unknown } | undefined = () => undefined;
/** Registered keys per engine, as the gateway lists them. */
let listed: Record<Engine, Array<{ name: string; publicKey: string; expiresAt: number }>> = { spot: [], perps: [] };
let hasAccount = true;
let spotUsdc = '0';

const SYMBOLS = {
  symbols: [{ id: 7, name: 'BTC-USD', displayName: 'BTC-USD', tickSize: '0.5', stepSize: '0.001', minQuantity: '0.001', minNotional: '5', maxLeverage: 50 }],
};
const ok = (data: unknown) => ({ body: { code: 0, data } });

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const raw = typeof init?.body === 'string' ? init.body : '';
  const s: Sent = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: raw ? JSON.parse(raw) : null, raw };
  if (url.startsWith('/api/md/')) return new Response(JSON.stringify(SYMBOLS), { status: 200 });
  // Market data is read from the gateway directly now (exchange/sodexMarket.ts).
  if (/\/api\/v1\/(spot|perps)\/markets\/symbols$/.test(url)) return new Response(JSON.stringify({ code: 0, data: SYMBOLS.symbols }), { status: 200 });
  sent.push(s);
  const custom = reply(s);
  const r: { status?: number; body: unknown } =
    custom ??
    (url.endsWith(`/user/${OWNER}/subaccounts`)
      ? hasAccount
        ? ok({ userID: AID, primaryAccountID: AID, subaccounts: [{ id: AID, evmAddress: OWNER }] })
        : { body: { code: -1, error: 'user not found' } }
      : /\/accounts\/0x[0-9a-f]{40}\/state$/.test(url)
        ? ok(hasAccount ? { aid: AID, B: [{ i: 0, a: 'vUSDC', t: spotUsdc, l: '0' }] } : { aid: 0, B: [] })
        : /\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/api-keys$/.test(url)
          ? ok(listed[url.includes('/spot/') ? 'spot' : 'perps'])
          : /\/(spot|perps)\/exchange$/.test(url) && s.body?.type === 'addAPIKey'
            ? (() => {
                const e: Engine = url.includes('/spot/') ? 'spot' : 'perps';
                listed[e] = listed[e].filter((k) => k.name !== s.body.params.name).concat({ name: s.body.params.name, publicKey: s.body.params.publicKey, expiresAt: s.body.params.expiresAt });
                return ok(null);
              })()
            : ok(null));
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
}) as typeof fetch;

const GW = 'https://gw.test';
beforeEach(() => {
  sent = [];
  reply = () => undefined;
  listed = { spot: [], perps: [] };
  hasAccount = true;
  spotUsdc = '0';
  wallet.prompts = 0;
  wallet.switched = 0;
  wallet.chainId = 42161;
  setTradingConfig({
    network: 'mainnet',
    chainId: 286623,
    gateway: GW,
    writesAllowed: true,
    disabled: false,
    keyTtlMs: 7 * 24 * 3_600_000,
    builder: null,
  });
  _resetTradingForTests(memoryVault());
  // The wallet has signed ValueDesk's terms (legalGate.ts); the test below takes the signature away.
  _resetAcceptanceForTests();
  _signedTermsForTests(OWNER);
});

/** Who signed an exchange-action request (X-API-Sign over {type, params}). */
function exchangeSigner(s: Sent, engine: Engine, type: string): string {
  const payloadHash = keccak256(utf8(payloadJSONFromBody(type, s.raw)));
  const digest = eip712Digest(makeDomain(engineDomainName(engine), 286623), exchangeActionStructHash(payloadHash, BigInt(s.headers['X-API-Nonce']!)));
  return recoverAddress(digest, hexToBytes(s.headers['X-API-Sign']!).slice(1)).toLowerCase();
}

// --- enable ------------------------------------------------------------------

test('enable: ONE wallet signature on the wallet’s own chain, sodex.com’s registration on both engines', async () => {
  const st = await enableTrading({ owner: OWNER, provider: wallet });
  assert.equal(wallet.prompts, 1, 'exactly one signature');
  assert.equal(wallet.switched, 0, 'no network switch');
  assert.equal(st.status, 'enabled');
  assert.equal(st.accountId, AID, 'the primary account id');
  assert.deepEqual(st.engines, ['spot', 'perps']);
  assert.ok(st.expiresAt! > Date.now() + 6.9 * 86_400_000 && st.expiresAt! < Date.now() + 7 * 86_400_000, 'a 7-day key');

  const regs = sent.filter((s) => s.method === 'POST' && /\/exchange$/.test(s.url));
  assert.deepEqual(regs.map((s) => s.url).sort(), [`${GW}/api/v1/perps/exchange`, `${GW}/api/v1/spot/exchange`]);
  const b = regs[0]!.body;
  assert.deepEqual(Object.keys(b), ['type', 'params', 'nonce', 'signature', 'signatureChainID']);
  assert.equal(b.type, 'addAPIKey');
  assert.deepEqual(b.params, { accountID: AID, name: tradingKeyName(), type: 1, publicKey: st.keyAddress, expiresAt: st.expiresAt });
  assert.equal(b.signatureChainID, 42161, 'the domain chain travels with the body');
  assert.equal(b.signature.slice(0, 4), '0x02', 'universal signature type');
  assert.notEqual(b.params.publicKey, OWNER, 'a separate key, never the wallet');
  assert.equal(regs[0]!.headers['X-API-Sign'], undefined, 'no X-API-* headers on /exchange');

  // What the wallet signed is exactly the UserSignedAddAPIKeyAction for this body.
  assert.equal(wallet.lastTyped.primaryType, 'UserSignedAddAPIKeyAction');
  const expected = userSignedAddAPIKeyTypedData(
    { accountID: AID, name: b.params.name, publicKey: b.params.publicKey, expiresAt: b.params.expiresAt },
    286623,
    BigInt(b.nonce),
    42161,
  );
  const digest = hashTypedData(expected);
  assert.equal(recoverAddress(digest, hexToBytes(b.signature).slice(1)).toLowerCase(), OWNER, 'the gateway recovers the owner');
});

test('enable again replaces the key under the same name (no pile-up against the 5-key limit)', async () => {
  const first = await enableTrading({ owner: OWNER, provider: wallet });
  const second = await enableTrading({ owner: OWNER, provider: wallet });
  assert.equal(first.keyName, second.keyName);
  assert.notEqual(first.keyAddress, second.keyAddress);
  assert.equal(listed.spot.length, 1);
  assert.equal(listed.perps.length, 1);
});

test('no SoDEX account yet: a clear precondition, no signature, and the account state says so', async () => {
  hasAccount = false;
  await assert.rejects(
    enableTrading({ owner: OWNER, provider: wallet }),
    (e: unknown) => e instanceof TradingError && e.kind === 'no-account',
  );
  assert.equal(wallet.prompts, 0);
  await restoreTrading(OWNER);
  assert.equal(await refreshAccount(OWNER), 'none');
  assert.equal(getTradingState().accountStatus, 'none');
  hasAccount = true;
  assert.equal(await refreshAccount(OWNER), 'ready', 'the first deposit landed');
  assert.equal(getTradingState().accountId, AID);
});

test('one engine refuses: trading is enabled on the other, and the refused one says why', async () => {
  reply = (s) => (s.url === `${GW}/api/v1/spot/exchange` ? { status: 400, body: { code: 400, error: 'account not found' } } : undefined);
  const st = await enableTrading({ owner: OWNER, provider: wallet });
  assert.deepEqual(st.engines, ['perps']);
  reply = (s) => (/trade\/orders$/.test(s.url) ? ok([{ code: 0, clOrdID: 'x', orderID: 1 }]) : undefined);
  await placeOrder('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01' });
  assert.throws(() => requireSigner(undefined, 'spot'), (e: unknown) => e instanceof TradingError && /spot/.test(e.message));
});

test('both engines refuse: nothing is stored and the gateway’s reason surfaces', async () => {
  reply = (s) => (/\/exchange$/.test(s.url) ? { status: 401, body: { code: 401, error: 'API key error: invalid signature' } } : undefined);
  await assert.rejects(enableTrading({ owner: OWNER, provider: wallet }), /invalid signature/);
  assert.equal(getTradingState().status, 'off');
});

test('mainnet writes switched off: refused before anything is signed', async () => {
  setTradingConfig({ writesAllowed: false });
  await assert.rejects(enableTrading({ owner: OWNER, provider: wallet }), (e: unknown) => e instanceof TradingError && e.kind === 'writes-off');
  assert.equal(wallet.prompts, 0);
});

// --- orders --------------------------------------------------------------------

test('an order is signed by the browser key and goes straight to SoDEX, with no wallet prompt', async () => {
  const st = await enableTrading({ owner: OWNER, provider: wallet });
  sent = [];
  reply = (s) => (/trade\/orders$/.test(s.url) ? ok([{ code: 0, clOrdID: 'x', orderID: 1 }]) : undefined);
  const r = await placeOrder('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000.2', quantity: '0.0105' });
  assert.equal(r.orderCount, 1);
  assert.equal(wallet.prompts, 1, 'no wallet prompt for the order');
  const o = sent.find((s) => s.url === `${GW}/api/v1/perps/trade/orders`)!;
  assert.ok(o);
  assert.equal(o.headers['X-API-Key'], st.keyName);
  assert.equal(o.headers['X-API-Chain'], '286623');
  assert.equal(o.body.accountID, AID);
  assert.equal(o.body.orders[0].price, '84000');
  assert.equal(o.body.orders[0].quantity, '0.01');
  assert.equal(o.body.builder, undefined, 'no builder fee without an approval');
  assert.equal(exchangeSigner(o, 'perps', 'newOrder'), st.keyAddress, 'signed by the trading key');
});

test('a batch SoDEX accepts can still reject single orders: never reported as submitted', async () => {
  await enableTrading({ owner: OWNER, provider: wallet });
  reply = (s) =>
    /trade\/orders$/.test(s.url)
      ? ok([{ code: 0, clOrdID: 'a', orderID: 1 }, { code: 1025, clOrdID: 'b', error: 'reduce only rejected' }])
      : undefined;
  await assert.rejects(
    placeOrder('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01', takeProfit: { price: '90000' } }),
    /Part of the order went through.*the take-profit: reduce only rejected/,
  );
});

test('a key SoDEX no longer knows is dropped, and the user is told to enable again', async () => {
  await enableTrading({ owner: OWNER, provider: wallet });
  reply = (s) => (/trade\/orders$/.test(s.url) ? { status: 401, body: { code: 401, error: 'API key not found' } } : undefined);
  await assert.rejects(placeOrder('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01' }));
  assert.equal(getTradingState().status, 'expired');
  assert.throws(() => requireSigner(), TradingError);
});

test('a key replaced on another device is detected and dropped', async () => {
  const st = await enableTrading({ owner: OWNER, provider: wallet });
  // Another browser enabled trading: same name, another public key.
  const other = generateTradingKey().address.toLowerCase();
  listed.perps = [{ name: st.keyName!, publicKey: other, expiresAt: st.expiresAt! }];
  await checkKeyAfterRejection();
  assert.equal(getTradingState().status, 'expired');
  assert.match(getTradingState().reason ?? '', /replaced/);
});

test('cancel-all reads open orders fresh and cancels them in one signed request', async () => {
  await enableTrading({ owner: OWNER, provider: wallet });
  sent = [];
  reply = (s) =>
    s.url.includes('/orders?') || s.url.endsWith('/orders')
      ? s.method === 'GET'
        ? ok({ orders: [{ si: 7, i: 11 }, { si: 7, i: 12 }] })
        : ok([{ code: 0, clOrdID: '' }, { code: 0, clOrdID: '' }])
      : undefined;
  const r = await cancelAll('perps');
  assert.equal(r.cancelled, 2);
  const del = sent.find((s) => s.method === 'DELETE')!;
  assert.deepEqual(del.body.cancels.map((c: any) => c.orderID), [11, 12]);
});

// --- the legal gate (legalGate.ts), where every action is signed ----------------

test('terms not accepted, or a close-only place: an opening order asks the terms popup and is not sent when it is closed; a close, a cancel and a withdrawal never ask and still go', async () => {
  await enableTrading({ owner: OWNER, provider: wallet });
  reply = (s) =>
    /trade\/orders$/.test(s.url) && s.method === 'POST' ? ok([{ code: 0, clOrdID: 'x', orderID: 1 }])
    : s.url.includes('/orders') && s.method === 'GET' ? ok({ orders: [{ si: 7, i: 11 }] })
    : s.method === 'DELETE' ? ok([{ code: 0, clOrdID: '' }])
    : undefined;
  const asked: string[] = [];
  try {
    for (const restrict of [() => _resetAcceptanceForTests(), () => _resetGeoForTests({ country: 'US', region: null, known: true })]) {
      _signedTermsForTests(OWNER);
      _resetGeoForTests();
      restrict();
      // The popup (LegalGate.tsx TermsGate): the visitor closes it - the terms stay as they are.
      setTermsGate(async (r) => {
        asked.push(r.reason);
        return !!browseAccepted() && !!signedTerms(r.owner);
      });
      sent = [];
      await assert.rejects(
        placeOrder('perps', { symbol: 'BTC-USD', side: 'buy', price: '84000', quantity: '0.01' }),
        (e: unknown) => e instanceof TradingError && e.kind === 'legal',
      );
      assert.equal(sent.filter((s) => s.method === 'POST' && /trade\/orders$/.test(s.url)).length, 0,'nothing was sent');
      await placeOrder('perps', { symbol: 'BTC-USD', side: 'sell', price: '84000', quantity: '0.01', reduceOnly: true });
      assert.equal(sent.filter((s) => s.method === 'POST' && /trade\/orders$/.test(s.url)).length, 1,'the close was sent');
      assert.equal((await cancelAll('perps')).cancelled, 1);
      await withdraw({ engine: 'spot', coinId: 0, amount: '1' });
    }
    assert.deepEqual(asked, ['place this order', 'place this order'], 'only the opening orders asked; closing, cancelling and withdrawing never did');
  } finally {
    setTermsGate(null);
    _resetGeoForTests();
    _signedTermsForTests(OWNER);
  }
});

// --- money ----------------------------------------------------------------------

test('withdraw from spot: one signed transferAsset on SPOT, EVM_WITHDRAW to account 999', async () => {
  const st = await enableTrading({ owner: OWNER, provider: wallet });
  sent = [];
  await withdraw({ engine: 'spot', coinId: 0, amount: '12.5' });
  const t = sent.filter((s) => s.method === 'POST' && /accounts\/transfers$/.test(s.url));
  assert.equal(t.length, 1);
  assert.equal(t[0]!.url, `${GW}/api/v1/spot/accounts/transfers`);
  assert.deepEqual({ ...t[0]!.body, id: 0 }, { id: 0, fromAccountID: AID, toAccountID: 999, coinID: 0, amount: '12.5', type: 2 });
  assert.equal(exchangeSigner(t[0]!, 'spot', 'transferAsset'), st.keyAddress);
});

test('withdraw from perps: perps -> spot, wait for the credit, then spot -> wallet', async () => {
  await enableTrading({ owner: OWNER, provider: wallet });
  sent = [];
  spotUsdc = '0';
  reply = (s) => {
    // The perps -> spot move credits spot.
    if (s.method === 'POST' && s.url === `${GW}/api/v1/perps/accounts/transfers`) spotUsdc = '12.5';
    return undefined;
  };
  await withdraw({ engine: 'perps', coinId: 0, amount: '12.5' });
  const t = sent.filter((s) => s.method === 'POST' && /accounts\/transfers$/.test(s.url));
  assert.deepEqual(t.map((x) => [x.url.includes('/perps/') ? 'perps' : 'spot', x.body.type, x.body.toAccountID]), [
    ['perps', 5, 999],
    ['spot', 2, 999],
  ]);
});

// --- lifetime -----------------------------------------------------------------------

test('restore follows the wallet; turning off deletes the key', async () => {
  const vault = memoryVault();
  _resetTradingForTests(vault);
  await enableTrading({ owner: OWNER, provider: wallet });
  const name = getTradingState().keyName;
  // A reload: the key comes back for the same wallet, not for another.
  _resetTradingForTests(vault);
  assert.equal((await restoreTrading(OWNER)).keyName, name);
  assert.equal((await restoreTrading(generateTradingKey().address)).status, 'off');
  assert.equal((await restoreTrading(OWNER)).status, 'enabled');
  await disableTrading();
  assert.equal(getTradingState().status, 'off');
  assert.equal((await restoreTrading(OWNER)).status, 'off', 'gone from the vault too');
});

test('revoke: the wallet signs one engine-domain revocation per engine, sent to /exchange', async () => {
  await enableTrading({ owner: OWNER, provider: wallet });
  wallet.chainId = 286623; // the revocation's domain is the SoDEX chain
  sent = [];
  await disableTrading({ revoke: true, provider: wallet });
  const revs = sent.filter((s) => s.method === 'POST' && /\/exchange$/.test(s.url));
  assert.deepEqual(revs.map((s) => [s.url.includes('/spot/') ? 'spot' : 'perps', s.body.type]), [
    ['spot', 'revokeAPIKey'],
    ['perps', 'revokeAPIKey'],
  ]);
  assert.equal(revs[0]!.body.signature.slice(0, 4), '0x01', 'engine-domain signature type');
  assert.equal(wallet.prompts, 3, 'one for enabling, one per engine for revoking');
});

test('the wallet is only ever asked for typed data, and hashes what it is shown', async () => {
  let seen: unknown = null;
  const spy = {
    request: async (a: { method: string; params?: unknown[] }) => {
      if (a.method === 'eth_signTypedData_v4') seen = JSON.parse((a.params as string[])[1]!);
      return wallet.request(a);
    },
  };
  await enableTrading({ owner: OWNER, provider: spy });
  assert.ok(seen, 'typed data, not a raw message');
  assert.equal(hashTypedData(seen as never).length, 32);
});
