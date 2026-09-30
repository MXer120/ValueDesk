/**
 * The deposit-options assembly (sodex/depositOptions.ts), now shared by the
 * server route and the browser: only whitelisted pairs with a cross-checked
 * address are offered; everything else is reported, never guessed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDepositOptions, newDepositAddressRequester, type DepositOptionsIo } from '../src/sodex/depositOptions.js';
import type { IssuerStatus } from '../src/sodex/depositAddressCore.js';

const ME = '0x48d98beb9dfce0a24f284e7653f05609b058ad96';
const ARB = '0x4577c24e9e7a53aa775589c7d9fa7ae4bbc426cb';

function io(o: Partial<DepositOptionsIo> & { current?: Record<string, string | null>; lists?: Record<string, Record<string, string[]>> } = {}): DepositOptionsIo {
  return {
    sodexConfig: async () => ({
      whitelist: { USDC: { ARBITRUM_ETH: { depositTime: 2 }, BASE_ETH: {} }, PEPE: { ETH: {} }, ETH: { ARBITRUM_ETH: {} } },
      explorer: { ARBITRUM_ETH: 'https://arbiscan.io/token/' },
    }),
    issuedAddresses: async () => [{ chain: 'ARBITRUM_ETH', address: ARB, custodian: 'cobo', status: 'Enabled' }],
    remoteNativeTokens: async () => [
      { chain: 'ARBITRUM_ETH', coinAddr: '', bridgeAddr: '', custodyDisabled: false, minDepositAmount: 10n ** 16n, custodyAmount: 0n, bridgedAmount: 0n },
    ],
    currentDepositWallet: async (_a, chain) => (o.current ?? { ARBITRUM_ETH: ARB, BASE_ETH: '0x' + 'b'.repeat(40) })[chain] ?? null,
    issuerDepositStatus: async () => ({ status: 'Enabled' as IssuerStatus, address: null }),
    depositWalletLists: async (_a, coin) => new Map(Object.entries((o.lists ?? { USDC: { ARBITRUM_ETH: [ARB], BASE_ETH: [] }, ETH: { ARBITRUM_ETH: [ARB] } })[coin] ?? {})),
    registryInfo: () => ({ address: '0xB37295d1ea21E65b76dCB2E85e035eE0dBFC70CB', chainId: 286623 }),
    ...o,
  };
}

test('deposit options: a route is offered only when chain, registry and issuer agree', async () => {
  const r = await buildDepositOptions(io(), ME);
  const usdc = r.assets.find((a) => a.symbol === 'USDC')!;
  assert.deepEqual(usdc.routes.map((x) => [x.chain, x.address, x.verified]), [['ARBITRUM_ETH', ARB, true]]);
  assert.equal(usdc.routes[0]!.explorerUrl, 'https://arbiscan.io/token/');
  assert.equal(usdc.routes[0]!.minDeposit, null, 'the chain minimum is for its NATIVE coin, never USDC');
  const eth = r.assets.find((a) => a.symbol === 'ETH')!;
  assert.equal(eth.routes[0]!.minDeposit, '0.01', 'ETH on Arbitrum carries the registry minimum');
  assert.ok(!r.assets.some((a) => a.symbol === 'PEPE'), 'PEPE is never offered');
  assert.ok(r.rejected.some((x) => x.chain === 'BASE_ETH' && /no address issued/.test(x.reason)));
  assert.equal(r.allVerified, false);
  assert.equal(r.assets[0]!.symbol, 'USDC', 'stablecoins first');
});

test('deposit options: a registry that lists another address withholds the route', async () => {
  const r = await buildDepositOptions(io({ lists: { USDC: { ARBITRUM_ETH: ['0x' + 'd'.repeat(40)] } } }), ME);
  assert.ok(!r.assets.some((a) => a.symbol === 'USDC' && a.routes.some((x) => x.chain === 'ARBITRUM_ETH')));
  assert.ok(r.rejected.some((x) => /not this coin's registered address/.test(x.reason)));
});

test('deposit options: an address SoDEX flagged is withheld, and flagged, never shown', async () => {
  const r = await buildDepositOptions(io({ issuedAddresses: async () => [{ chain: 'ARBITRUM_ETH', address: ARB, custodian: 'cobo', status: 'Suspicious' }] }), ME);
  const route = r.assets.find((a) => a.symbol === 'USDC')!.routes.find((x) => x.chain === 'ARBITRUM_ETH')!;
  assert.equal(route.flagged, true);
  assert.equal(route.address, '');
  assert.equal(route.verified, false);
});

test('deposit options: the issuer not answering leaves the on-chain sources to decide', async () => {
  const r = await buildDepositOptions(io({ issuedAddresses: async () => { throw new Error('timeout'); } }), ME);
  assert.ok(r.rejected.some((x) => x.chain === '*' && /did not answer/.test(x.reason)));
  assert.equal(r.assets.find((a) => a.symbol === 'USDC')!.routes[0]!.address, ARB, 'chain + registry still agree');
});

test('new deposit address: only for a flagged address, at most once per 30 s', async () => {
  const calls: string[] = [];
  let status: IssuerStatus = 'Enabled';
  const request = newDepositAddressRequester({
    issuerDepositStatus: async () => ({ status, address: null }),
    replaceDepositAddress: async (_a, c) => void calls.push(c),
    forget: () => {},
  });
  await assert.rejects(request(ME, 'ARBITRUM_ETH'), (e: { statusCode?: number }) => e.statusCode === 409);
  status = 'Suspicious';
  await request(ME, 'ARBITRUM_ETH');
  await assert.rejects(request(ME, 'ARBITRUM_ETH'), (e: { statusCode?: number }) => e.statusCode === 429);
  await assert.rejects(request('nope', 'ARBITRUM_ETH'), (e: { statusCode?: number }) => e.statusCode === 400);
  assert.deepEqual(calls, ['ARBITRUM_ETH']);
});
