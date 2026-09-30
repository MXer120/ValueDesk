/**
 * The key-backed EIP-1193 wallet, offline: a fake JSON-RPC node stands in for
 * the chains, nothing leaves the process.
 *   npx tsx --test e2e/live/provider.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { custom, keccak256, parseTransaction, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  assembleExchangeRequests,
  assembleWithdrawPermit,
  hashTypedData,
  hexToBytes,
  prepareApiKeyRegistrationExchange,
  prepareWithdrawPermit,
  recoverAddress,
  type TypedData,
} from '@sodex-core';
import { addOrSwitchChain, sendTransaction, signMessage, signTypedData, WalletError } from '../../src/wallet';
import { erc20TransferData } from '../../src/trading/onboard';
import { KNOWN_CHAINS, ProviderRpcError, VALUECHAIN_CHAIN_ID, createKeyProvider, type ChainSpec, type ProviderEvent, type ProviderPolicy } from './provider';

const ARBITRUM = 42161;
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const DEPOSIT = '0x00000000000000000000000000000000000000dd';
const ALLOW_ALL: ProviderPolicy = { tx: () => null, typedData: () => null, message: () => null };

/** A fake node per chain: answers what viem asks while preparing a tx, records every call. */
function fakeChains() {
  const calls: Array<{ chain: number; method: string; params: unknown[] }> = [];
  const raw: Array<{ chain: number; tx: Hex }> = [];
  let failWith: string | null = null;
  const node = (c: ChainSpec) => async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as unknown[];
    calls.push({ chain: c.id, method, params: p });
    if (failWith) throw new Error(failWith);
    switch (method) {
      case 'eth_chainId':
        return `0x${c.id.toString(16)}`;
      case 'eth_fillTransaction':
        throw Object.assign(new Error('the method eth_fillTransaction does not exist/is not available'), { code: -32601 });
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_getBlockByNumber': {
        // BNB Chain plays a pre-London chain here: no base fee -> a legacy transaction.
        const block = { number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [] };
        return c.id === 56 ? block : { ...block, baseFeePerGas: '0x3b9aca00' };
      }
      case 'eth_gasPrice':
        return '0x3b9aca00';
      case 'eth_maxPriorityFeePerGas':
        return '0x5f5e100';
      case 'eth_estimateGas':
        return '0xfde8';
      case 'eth_sendRawTransaction':
        raw.push({ chain: c.id, tx: p[0] as Hex });
        return keccak256(p[0] as Hex);
      case 'eth_call':
        return `0x${c.id.toString(16).padStart(64, '0')}`;
      case 'eth_getBalance':
        return '0xde0b6b3a7640000';
      default:
        throw Object.assign(new Error(`fake node: ${method} not handled`), { code: -32601 });
    }
  };
  // No retries: a failing fake node should fail at once.
  const transport = (c: ChainSpec) => custom({ request: node(c) }, { retryCount: 0 });
  return {
    calls,
    raw,
    transport,
    fail(msg: string | null) {
      failWith = msg;
    },
  };
}

function setup(o: { policy?: ProviderPolicy | null; startChainId?: number } = {}) {
  const key = generatePrivateKey();
  const node = fakeChains();
  const events: ProviderEvent[] = [];
  const provider = createKeyProvider({ privateKey: key, startChainId: o.startChainId ?? ARBITRUM, policy: o.policy === undefined ? ALLOW_ALL : o.policy, transport: node.transport, onEvent: (e) => events.push(e) });
  return { key, node, events, provider, address: privateKeyToAccount(key).address.toLowerCase() };
}

test('a malformed or invalid key is refused WITHOUT echoing it', () => {
  const bad = ['0x1234', `0x${'zz'.repeat(32)}`, `${'ab'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`];
  for (const k of bad) {
    assert.throws(
      () => createKeyProvider({ privateKey: k }),
      (e: unknown) => e instanceof Error && !e.message.includes(k.replace(/^0x/, '')) && /VS_E2E_KEY/.test(e.message),
      `refused: ${k.slice(0, 6)}...`,
    );
  }
});

test('accounts: the key\'s address (lower-case), the chain it starts on', async () => {
  const { provider, address } = setup({ startChainId: VALUECHAIN_CHAIN_ID });
  assert.deepEqual(await provider.request({ method: 'eth_accounts' }), [address]);
  assert.deepEqual(await provider.request({ method: 'eth_requestAccounts' }), [address]);
  assert.equal(await provider.request({ method: 'eth_chainId' }), '0x45f9f');
  assert.equal(provider.address, address);
  assert.equal(provider.chainId, VALUECHAIN_CHAIN_ID);
});

test('chain switching: known chains switch (and emit chainChanged); the app\'s addOrSwitchChain works', async () => {
  const { provider, events } = setup({ startChainId: VALUECHAIN_CHAIN_ID });
  const seen: unknown[] = [];
  provider.on?.('chainChanged', (id: unknown) => seen.push(id));
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4b1' }] });
  assert.equal(await provider.request({ method: 'eth_chainId' }), '0xa4b1');
  await addOrSwitchChain(provider, { chainId: '0x45f9f', chainName: 'ValueChain', rpcUrls: ['https://rpc.valuechain.xyz'], blockExplorerUrls: [], nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 } });
  assert.equal(provider.chainId, VALUECHAIN_CHAIN_ID);
  // wallet_addEthereumChain for a KNOWN chain switches to it - with the wallet's own RPC, not the page's.
  await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x2105', rpcUrls: ['https://evil.example'] }] });
  assert.equal(provider.chainId, 8453);
  assert.equal(provider.chain.rpcUrl, KNOWN_CHAINS.find((c) => c.id === 8453)!.rpcUrl);
  assert.deepEqual(seen, ['0xa4b1', '0x45f9f', '0x2105']);
  assert.deepEqual(events.filter((e) => e.type === 'switch').map((e) => (e as { to: number }).to), [ARBITRUM, VALUECHAIN_CHAIN_ID, 8453]);
  // Every EVM chain the app sends from, plus ValueChain, is known.
  assert.deepEqual(KNOWN_CHAINS.map((c) => c.id).sort((a, b) => a - b), [1, 56, 137, 8453, 42161, VALUECHAIN_CHAIN_ID].sort((a, b) => a - b));
});

test('unknown chains are refused (4902), for switch AND add; the app sees a WalletError and the wallet stays put', async () => {
  const { provider } = setup();
  await assert.rejects(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x539' }] }), (e: unknown) => e instanceof ProviderRpcError && e.code === 4902);
  await assert.rejects(provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x539', rpcUrls: ['http://127.0.0.1:8545'] }] }), (e: unknown) => e instanceof ProviderRpcError && e.code === 4902);
  await assert.rejects(addOrSwitchChain(provider, { chainId: '0x539', chainName: 'Local', rpcUrls: ['http://127.0.0.1:8545'], blockExplorerUrls: [], nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 } }), WalletError);
  assert.equal(provider.chainId, ARBITRUM);
});

test('typed data: 65-byte r||s||v with v 27/28, recovering to the wallet - for the app\'s own key registration and withdraw permit', async () => {
  const { provider, address } = setup({ startChainId: ARBITRUM });
  // 1. The key registration enableTrading asks for: domain = the wallet's CURRENT chain.
  const reg = prepareApiKeyRegistrationExchange({
    userAddress: address,
    accountID: 4242,
    name: 'valuescan-web',
    publicKey: privateKeyToAccount(generatePrivateKey()).address,
    expiresAt: Date.now() + 86_400_000,
    nonce: Date.now(),
    sodexChainId: VALUECHAIN_CHAIN_ID,
    signatureChainId: ARBITRUM,
  } as Parameters<typeof prepareApiKeyRegistrationExchange>[0]);
  const sig1 = await signTypedData(provider, address, reg.typedData);
  assert.match(sig1, /^0x[0-9a-f]{128}(1b|1c)$/, '65 bytes, v = 27/28 like MetaMask');
  assert.equal(recoverAddress(hashTypedData(reg.typedData), hexToBytes(sig1)).toLowerCase(), address, 'sodex-core\'s own hashing recovers the wallet');
  assert.equal(assembleExchangeRequests(reg, sig1, { base: '' }).length, 2, 'the app\'s signer check accepts it');
  // 2. The withdraw permit withdrawFunds asks for: domain = ValueChain, so the wallet switches first.
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x45f9f' }] });
  const permit = prepareWithdrawPermit({ owner: address, coinSymbol: 'USDC', chain: 'ARBITRUM_ETH', receiver: address, amount: 5_000_000n, nonce: 3n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), chainId: VALUECHAIN_CHAIN_ID });
  const sig2 = await signTypedData(provider, address, permit.typedData);
  assert.match(sig2, /^0x[0-9a-f]{128}(1b|1c)$/);
  assert.doesNotThrow(() => assembleWithdrawPermit(permit, sig2), 'the permit\'s signer check accepts it');
  const viaViem = await recoverTypedDataAddress({ ...(permit.typedData as unknown as Parameters<typeof recoverTypedDataAddress>[0]), signature: sig2 as Hex });
  assert.equal(viaViem.toLowerCase(), address, 'and viem agrees on the digest');
});

test('typed data for a chain that is not the active one is refused, as MetaMask does', async () => {
  const { provider, address } = setup({ startChainId: ARBITRUM });
  const permit = prepareWithdrawPermit({ owner: address, coinSymbol: 'USDC', chain: 'ARBITRUM_ETH', receiver: address, amount: 5_000_000n, nonce: 3n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), chainId: VALUECHAIN_CHAIN_ID });
  await assert.rejects(signTypedData(provider, address, permit.typedData), (e: unknown) => e instanceof WalletError && /must match the active chainId/.test(e.message));
});

test('nothing is signed or sent without a policy; a policy refusal names its reason (4100)', async () => {
  const { provider, address, node, events } = setup({ policy: null });
  const td = prepareWithdrawPermit({ owner: address, coinSymbol: 'USDC', chain: 'ARBITRUM_ETH', receiver: address, amount: 1n, nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), chainId: ARBITRUM }).typedData;
  await assert.rejects(signTypedData(provider, address, td), (e: unknown) => e instanceof WalletError && e.code === 4100);
  await assert.rejects(signMessage(provider, address, 'hello'), (e: unknown) => e instanceof WalletError && e.code === 4100);
  await assert.rejects(sendTransaction(provider, { from: address, to: USDC_ARB, data: erc20TransferData(DEPOSIT, 1n), value: '0x0', chainId: ARBITRUM }), (e: unknown) => e instanceof WalletError && e.code === 4100);
  provider.setPolicy({ tx: (t) => (t.to === USDC_ARB ? 'only the deposit address may be paid' : null) });
  await assert.rejects(sendTransaction(provider, { from: address, to: USDC_ARB, data: '0x', value: '0x0' }), /only the deposit address may be paid/);
  assert.equal(node.raw.length, 0, 'no raw transaction ever reached a node');
  assert.ok(events.filter((e) => e.type === 'refused').length >= 4);
});

test('eth_sendTransaction: signed for the ACTIVE chain, broadcast raw, hash returned at once - via the app\'s own sendTransaction', async () => {
  const { provider, address, node, events } = setup({ startChainId: ARBITRUM });
  const data = erc20TransferData(DEPOSIT, 10_000_000n);
  const hash = await sendTransaction(provider, { from: address, to: USDC_ARB, data, value: '0x0', chainId: ARBITRUM });
  assert.equal(node.raw.length, 1);
  const raw = node.raw[0]!;
  assert.equal(raw.chain, ARBITRUM, 'sent to the Arbitrum node');
  assert.equal(hash, keccak256(raw.tx), 'the hash of the raw transaction');
  const tx = parseTransaction(raw.tx);
  assert.equal(tx.chainId, ARBITRUM, 'EIP-155 chain id of the active chain');
  assert.equal(tx.type, 'eip1559', 'EIP-1559 where the chain has a base fee');
  assert.equal(tx.to?.toLowerCase(), USDC_ARB);
  assert.equal(tx.data, data);
  assert.equal(tx.value ?? 0n, 0n);
  assert.equal(tx.nonce, 7, 'the pending nonce from the node');
  assert.equal((await recoverTransactionAddress({ serializedTransaction: raw.tx as never })).toLowerCase(), address, 'signed by the wallet');
  const sent = events.find((e) => e.type === 'tx-sent') as Extract<ProviderEvent, { type: 'tx-sent' }>;
  assert.equal(sent.hash, hash);
  assert.equal(sent.selector, '0xa9059cbb');
});

test('a native-value transfer on ValueChain; a chain without a base fee gets a legacy transaction', async () => {
  const { provider, address, node } = setup({ startChainId: VALUECHAIN_CHAIN_ID });
  await sendTransaction(provider, { from: address, to: DEPOSIT, data: '0x', value: '0xde0b6b3a7640000', chainId: VALUECHAIN_CHAIN_ID });
  const tx = parseTransaction(node.raw[0]!.tx);
  assert.equal(tx.chainId, VALUECHAIN_CHAIN_ID);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.value, 10n ** 18n);
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
  await sendTransaction(provider, { from: address, to: DEPOSIT, data: '0x', value: '0x1', chainId: 56 });
  const legacy = parseTransaction(node.raw[1]!.tx);
  assert.equal(node.raw[1]!.chain, 56);
  assert.equal(legacy.type, 'legacy');
  assert.equal(legacy.chainId, 56, 'EIP-155 replay protection');
  assert.equal(legacy.gasPrice, 1_200_000_000n, "the node's gas price with viem's default 1.2x buffer");
});

test('a transaction for another chain, from another account, or a deploy is refused - and nothing is sent', async () => {
  const { provider, address, node } = setup({ startChainId: ARBITRUM });
  await assert.rejects(provider.request({ method: 'eth_sendTransaction', params: [{ from: address, to: USDC_ARB, data: '0x', chainId: '0x1' }] }), (e: unknown) => e instanceof ProviderRpcError && e.code === -32602 && /nothing was sent/.test(e.message));
  await assert.rejects(provider.request({ method: 'eth_sendTransaction', params: [{ from: DEPOSIT, to: USDC_ARB, data: '0x' }] }), (e: unknown) => e instanceof ProviderRpcError && e.code === 4100);
  await assert.rejects(provider.request({ method: 'eth_sendTransaction', params: [{ from: address, data: '0x6000' }] }), (e: unknown) => e instanceof ProviderRpcError && e.code === -32602);
  // The app's own guard catches the chain mismatch before the wallet is even asked.
  await assert.rejects(sendTransaction(provider, { from: address, to: USDC_ARB, data: '0x', value: '0x0', chainId: 1 }), /Nothing was sent/);
  assert.equal(node.raw.length, 0);
});

test('reads go to the ACTIVE chain\'s node; unsupported methods are refused', async () => {
  const { provider, node } = setup({ startChainId: ARBITRUM });
  assert.equal(await provider.request({ method: 'eth_call', params: [{ to: USDC_ARB, data: '0x70a08231' }, 'latest'] }), `0x${ARBITRUM.toString(16).padStart(64, '0')}`);
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x45f9f' }] });
  assert.equal(await provider.request({ method: 'eth_call', params: [{ to: USDC_ARB, data: '0x' }, 'latest'] }), `0x${VALUECHAIN_CHAIN_ID.toString(16).padStart(64, '0')}`);
  assert.deepEqual(node.calls.filter((c) => c.method === 'eth_call').map((c) => c.chain), [ARBITRUM, VALUECHAIN_CHAIN_ID]);
  await assert.rejects(provider.request({ method: 'eth_sign', params: [] }), (e: unknown) => e instanceof ProviderRpcError && e.code === 4200);
  await assert.rejects(provider.request({ method: 'eth_coinbase' }), (e: unknown) => e instanceof ProviderRpcError && e.code === 4200);
});

test('personal_sign: EIP-191 with v 27/28, recovering to the wallet', async () => {
  const { provider, address } = setup();
  const sig = await signMessage(provider, address, 'sign in to SoDEX');
  assert.match(sig, /^0x[0-9a-f]{128}(1b|1c)$/);
  assert.equal((await recoverMessageAddress({ message: 'sign in to SoDEX', signature: sig as Hex })).toLowerCase(), address);
});

test('the key never shows: not in JSON, inspect, errors (even an RPC error quoting it) or console output', async () => {
  const { provider, address, key, node } = setup({ startChainId: ARBITRUM });
  const body = key.slice(2);
  const leaks = (s: string) => s.toLowerCase().includes(body.toLowerCase());
  // console.* only: process.stdout carries node:test's own event stream in a --test child.
  const out: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const grab = (...a: unknown[]) => void out.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 6 }))).join(' '));
  console.log = console.info = console.warn = console.error = console.debug = grab;
  const errors: string[] = [];
  const attempt = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      errors.push(`${(e as Error).name}: ${(e as Error).message}\n${(e as Error).stack ?? ''}\n${inspect(e, { depth: 6, showHidden: true })}`);
    }
  };
  try {
    await attempt(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x539' }] }));
    await attempt(provider.request({ method: 'eth_signTypedData_v4', params: [address, '{not json'] }));
    await attempt(provider.request({ method: 'eth_signTypedData_v4', params: [DEPOSIT, '{}'] }));
    await attempt(provider.request({ method: 'eth_sendTransaction', params: [{ from: DEPOSIT, to: USDC_ARB }] }));
    await attempt(provider.request({ method: 'eth_nope' }));
    // A node whose error message quotes the key must not get it through.
    node.fail(`upstream exploded near ${key} and ${body.toUpperCase()}`);
    await attempt(provider.request({ method: 'eth_getBalance', params: [address, 'latest'] }));
    await attempt(sendTransaction(provider, { from: address, to: USDC_ARB, data: '0x', value: '0x0', chainId: ARBITRUM }));
    node.fail(null);
    console.log(provider);
    console.log(JSON.stringify(provider));
  } finally {
    Object.assign(console, orig);
  }
  assert.equal(errors.length, 7, 'every attempt failed');
  for (const e of errors) assert.ok(!leaks(e), `an error leaked the key: ${e.slice(0, 120)}`);
  assert.ok(errors.some((e) => e.includes('[redacted]')), 'the quoting node error was scrubbed');
  for (const o of out) assert.ok(!leaks(o), 'console output leaked the key');
  assert.ok(!leaks(JSON.stringify(provider)));
  assert.ok(!leaks(inspect(provider, { showHidden: true, depth: 10 })));
  assert.ok(!leaks(Object.keys(provider).join(',')));
  assert.equal(provider.redact(`a ${key} b ${body.toUpperCase()} c`), 'a [redacted] b [redacted] c');
});

test('the typed data the policy sees is what gets signed (a policy can pin the permit)', async () => {
  const { provider, address } = setup({ startChainId: VALUECHAIN_CHAIN_ID });
  const seen: TypedData[] = [];
  provider.setPolicy({ typedData: (td) => (seen.push(td as unknown as TypedData), (td.message as { cmd?: { receiver?: string } }).cmd?.receiver === address ? null : 'receiver is not the wallet') });
  const mk = (receiver: string) => prepareWithdrawPermit({ owner: address, coinSymbol: 'USDC', chain: 'ARBITRUM_ETH', receiver, amount: 5_000_000n, nonce: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), chainId: VALUECHAIN_CHAIN_ID }).typedData;
  await signTypedData(provider, address, mk(address));
  await assert.rejects(signTypedData(provider, address, mk(DEPOSIT)), /receiver is not the wallet/);
  assert.equal(seen.length, 2);
});
