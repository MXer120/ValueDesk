/**
 * Cross-chain deposit safety.
 *
 * A wrong address or a wrong asset/chain pair here means unrecoverable funds,
 * so these tests pin the decoding and the verification gate rather than any
 * cosmetic behaviour. The fixtures are real: the ABI blob is what ValueChain
 * actually returned, and the expected deposit address is one confirmed against
 * both the REST service and the on-chain registry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeRemoteNativeTokens,
  getDepositWallet,
  remoteNativeTokens,
  MIRROR_REGISTRY,
  MIRROR_SELECTORS,
} from '../src/sodex/mirrorRegistry.js';

// A wallet with no SoDEX account, and the address the mirror issues it on
// Ethereum — verified identical from the REST service and the registry.
const ACCOUNT = '0x727d78415c4c5d5209dbbd74661321971485ab9a';
const EXPECTED_ETH_DEPOSIT = '0x5Cc60dB393c3d48B8128BC82183dA57fD9fC7B01';

test('registry address and selectors are pinned', () => {
  // Identified by brute force: the only verified contract on ValueChain whose
  // getDepositWallet reproduces the REST service's address for a known wallet.
  assert.equal(MIRROR_REGISTRY, '0xB37295d1ea21E65b76dCB2E85e035eE0dBFC70CB');
  assert.equal(MIRROR_SELECTORS.getDepositWallet, '0xbc2e50ed');
  assert.equal(MIRROR_SELECTORS.listRemoteNativeTokens, '0x3c79e67d');
});

test('getDepositWallet reproduces the issued address exactly', async () => {
  // This is THE safety property: the UI only ever shows an address that the
  // chain itself confirms. Case-insensitive compare, byte-identical otherwise.
  const onChain = await getDepositWallet(ACCOUNT, 'ETH');
  assert.ok(onChain, 'registry returned no deposit wallet');
  assert.equal(onChain!.toLowerCase(), EXPECTED_ETH_DEPOSIT.toLowerCase());
});

test('an unknown chain yields no address rather than a wrong one', async () => {
  const onChain = await getDepositWallet(ACCOUNT, 'NOT_A_CHAIN');
  assert.ok(onChain === null || onChain === '', `expected nothing, got ${onChain}`);
});

test('the live registry decodes into usable routes', async () => {
  const tokens = await remoteNativeTokens();
  assert.ok(tokens.length > 0, 'registry returned no routes');
  for (const t of tokens) {
    assert.match(t.chain, /^[A-Z_]+$/, `odd chain code: ${t.chain}`);
    assert.equal(typeof t.custodyDisabled, 'boolean');
    assert.equal(typeof t.minDepositAmount, 'bigint');
    assert.ok(t.minDepositAmount >= 0n);
  }
  // Ethereum is the route everything else is sanity-checked against.
  assert.ok(tokens.some((t) => t.chain.toUpperCase() === 'ETH'));
});

test('decodeRemoteNativeTokens handles the real ABI layout', () => {
  // Hand-built encoding of one RemoteNativeToken, matching the struct order:
  // (string chain, string coinAddr, string bridgeAddr, bool custodyDisabled,
  //  uint256 minDepositAmount, uint256 custodyAmount, uint256 bridgedAmount)
  const w = (n: number | bigint) => n.toString(16).padStart(64, '0');
  const str = (s: string) => {
    const hex = Buffer.from(s, 'utf8').toString('hex');
    return w(s.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0');
  };
  // element head is 7 words; strings follow at offsets relative to the element
  const head = w(0x20 * 7) + w(0x20 * 7 + 0x40) + w(0x20 * 7 + 0x80) + w(0) + w(10n ** 18n) + w(5) + w(6);
  const body = str('ETH') + str('0xabc') + str('0xdef');
  const element = head + body;
  const encoded = '0x' + w(0x20) + w(1) + w(0x20) + element;

  const out = decodeRemoteNativeTokens(encoded);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.chain, 'ETH');
  assert.equal(out[0]!.coinAddr, '0xabc');
  assert.equal(out[0]!.bridgeAddr, '0xdef');
  assert.equal(out[0]!.custodyDisabled, false);
  assert.equal(out[0]!.minDepositAmount, 10n ** 18n);
  assert.equal(out[0]!.custodyAmount, 5n);
  assert.equal(out[0]!.bridgedAmount, 6n);
});

test('decoding empty or malformed data yields nothing, never a partial route', () => {
  // Better to offer no deposit route than one built from garbage.
  assert.deepEqual(decodeRemoteNativeTokens('0x'), []);
  assert.deepEqual(decodeRemoteNativeTokens(''), []);
  assert.deepEqual(decodeRemoteNativeTokens('0x' + '00'.repeat(31)), []);
});

// --- the end-to-end gate ----------------------------------------------------

test('deposit options are verified against the chain before being offered', async () => {
  const { mirrorRoutes } = await import('../src/routes/mirror.js');
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register(mirrorRoutes);

  const res = await app.inject({ method: 'GET', url: `/api/mirror/deposit-options?address=${ACCOUNT}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.ok(body.assets.length > 0, 'no deposit assets offered');
  for (const asset of body.assets) {
    for (const route of asset.routes) {
      assert.equal(route.verified, true, `${asset.symbol}/${route.chain} was offered unverified`);
      assert.ok(route.address, `${asset.symbol}/${route.chain} has no address`);
    }
  }

  // USDC is the asset a new user actually onboards with.
  const usdc = body.assets.find((a: any) => a.symbol === 'USDC');
  assert.ok(usdc, 'USDC is not offered');
  assert.ok(usdc.routes.length >= 3, 'USDC should be available on several chains');

  // A per-chain native minimum must never be attached to a non-native asset:
  // "min 1" against USDC would read as 1 USDC when the real figure is 1 ETH.
  for (const r of usdc.routes) {
    assert.equal(r.minDeposit, null, `USDC/${r.chain} carries a native-token minimum`);
  }
  const eth = body.assets.find((a: any) => a.symbol === 'ETH');
  if (eth) {
    const ethOnEth = eth.routes.find((r: any) => r.chain === 'ETH');
    if (ethOnEth) assert.ok(ethOnEth.minDeposit, 'ETH on Ethereum should carry its minimum');
  }

  await app.close();
});

test('a bad wallet address is refused', async () => {
  const { mirrorRoutes } = await import('../src/routes/mirror.js');
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register(mirrorRoutes);
  const res = await app.inject({ method: 'GET', url: '/api/mirror/deposit-options?address=nothex' });
  assert.equal(res.statusCode, 400);
  await app.close();
});
