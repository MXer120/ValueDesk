/**
 * Account creation: amounts, calldata and the route filter. The calldata is
 * checked against viem's ABI encoder, independently of our own.
 *   npx tsx --test src/trading/onboard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi } from 'viem';
import { setTradingConfig } from './config';
import { CANONICAL_USDC, decodeString, erc20TransferData, formatUnits, parseUnits, sendUsdcDeposit, usdcRoutes } from './onboard';

test('amounts: exact base units, no float, no silent rounding', () => {
  assert.equal(parseUnits('10', 6), 10_000_000n);
  assert.equal(parseUnits('12.5', 6), 12_500_000n);
  assert.equal(parseUnits('0.000001', 6), 1n);
  assert.equal(parseUnits('5', 18), 5n * 10n ** 18n, 'BNB Chain USDC has 18 decimals');
  assert.throws(() => parseUnits('0.0000001', 6), /6 decimal/);
  assert.throws(() => parseUnits('-1', 6));
  assert.throws(() => parseUnits('1e3', 6));
  assert.throws(() => parseUnits('', 6));
  assert.equal(formatUnits(12_500_000n, 6), '12.5');
  assert.equal(formatUnits(10n ** 18n, 18), '1');
});

test('ERC-20 transfer calldata matches viem', () => {
  const to = '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd';
  for (const amount of [1n, 10_000_000n, 5n * 10n ** 18n]) {
    const viem = encodeFunctionData({ abi: parseAbi(['function transfer(address to, uint256 amount)']), functionName: 'transfer', args: [to, amount] });
    assert.equal(erc20TransferData(to, amount), viem.toLowerCase());
  }
  assert.throws(() => erc20TransferData('0x1234', 1n));
  assert.throws(() => erc20TransferData(to, 0n));
});

test('token strings decode (ABI string and bytes32)', () => {
  const abiString = '0x' + '20'.padStart(64, '0') + '4'.padStart(64, '0') + '55534443'.padEnd(64, '0');
  assert.equal(decodeString(abiString), 'USDC');
  assert.equal(decodeString('0x' + '55534443'.padEnd(64, '0')), 'USDC');
});

const GW = 'https://gw.test';
const config = (chains: unknown[]) => [{ assetName: 'USDC', chains }];
function withGateway(body: unknown, fn: () => Promise<void>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, data: body }))) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test('routes: only canonical USDC contracts, open for deposits, on EVM networks we can switch to', async () => {
  setTradingConfig({ gateway: GW });
  await withGateway(
    config([
      { chainName: 'ARBITRUM_ETH', isNativeToken: false, tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', custody: { minDepositAmount: '5', allowDeposit: true, estimatedDepositSeconds: 120 } },
      { chainName: 'BASE_ETH', isNativeToken: false, tokenAddress: '0x0000000000000000000000000000000000000bad', custody: { minDepositAmount: '5', allowDeposit: true } },
      { chainName: 'ETH', isNativeToken: false, tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', custody: { minDepositAmount: '5', allowDeposit: false } },
      { chainName: 'SOL', isNativeToken: false, tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', custody: { allowDeposit: true } },
      { chainName: 'BSC_BNB', isNativeToken: false, tokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', custody: { minDepositAmount: '5', allowDeposit: true } },
    ]),
    async () => {
      const r = await usdcRoutes();
      assert.deepEqual(r.map((x) => x.chain.key), ['ARBITRUM_ETH', 'BSC_BNB'], 'non-canonical, closed and non-EVM routes are withheld');
      assert.equal(r[0]!.token, CANONICAL_USDC.ARBITRUM_ETH!.address);
      assert.equal(r[1]!.decimals, 18);
      assert.equal(r[0]!.etaSeconds, 120);
    },
  );
});

/** A wallet on Ethereum holding `balance` USDC on Arbitrum; records what it is asked. */
function wallet(balance: bigint, symbol = 'USDC', decimals = 6) {
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  let chain = 1;
  const enc = (s: string) => '0x' + '20'.padStart(64, '0') + s.length.toString(16).padStart(64, '0') + Buffer.from(s).toString('hex').padEnd(64, '0');
  return {
    calls,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push({ method, params });
      if (method === 'eth_chainId') return `0x${chain.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') {
        chain = parseInt((params![0] as { chainId: string }).chainId, 16);
        return null;
      }
      if (method === 'eth_call') {
        const data = (params![0] as { data: string }).data;
        if (data === '0x95d89b41') return enc(symbol);
        if (data === '0x313ce567') return '0x' + decimals.toString(16).padStart(64, '0');
        if (data.startsWith('0x70a08231')) return '0x' + balance.toString(16).padStart(64, '0');
      }
      if (method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32);
      throw new Error(`unexpected ${method}`);
    },
  };
}

const ROUTE = {
  chain: { key: 'ARBITRUM_ETH', chainId: 42161, name: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', native: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  token: CANONICAL_USDC.ARBITRUM_ETH!.address,
  decimals: 6,
  minDeposit: '5',
  etaSeconds: 120,
};
const OWNER = '0x00000000000000000000000000000000000000aa';
const DEPOSIT = '0x00000000000000000000000000000000000000dd';

test('sending: switches network, checks the token, sends ONE transfer of the exact amount to the deposit address', async () => {
  const w = wallet(50_000_000n);
  const r = await sendUsdcDeposit({ provider: w, owner: OWNER, route: ROUTE, depositAddress: DEPOSIT, amount: '10' });
  assert.equal(r.explorerUrl, `https://arbiscan.io/tx/0x${'ab'.repeat(32)}`);
  assert.ok(w.calls.some((c) => c.method === 'wallet_switchEthereumChain'), 'moved to Arbitrum first');
  const sent = w.calls.filter((c) => c.method === 'eth_sendTransaction');
  assert.equal(sent.length, 1);
  const tx = sent[0]!.params![0] as { from: string; to: string; data: string; value?: string };
  assert.equal(tx.from, OWNER);
  assert.equal(tx.to, CANONICAL_USDC.ARBITRUM_ETH!.address, 'to the USDC contract');
  assert.equal(tx.data, erc20TransferData(DEPOSIT, 10_000_000n), 'transfer(deposit address, 10 USDC)');
  assert.equal(tx.value, undefined, 'no native value');
});

test('sending: refuses below the minimum, a wrong token or too little balance - and sends nothing', async () => {
  const low = wallet(50_000_000n);
  await assert.rejects(sendUsdcDeposit({ provider: low, owner: OWNER, route: ROUTE, depositAddress: DEPOSIT, amount: '4.99' }), /minimum/);
  const fake = wallet(50_000_000n, 'USDT');
  await assert.rejects(sendUsdcDeposit({ provider: fake, owner: OWNER, route: ROUTE, depositAddress: DEPOSIT, amount: '10' }), /not USDC/);
  const poor = wallet(3_000_000n);
  await assert.rejects(sendUsdcDeposit({ provider: poor, owner: OWNER, route: ROUTE, depositAddress: DEPOSIT, amount: '10' }), /not enough/);
  for (const w of [low, fake, poor]) assert.equal(w.calls.filter((c) => c.method === 'eth_sendTransaction').length, 0);
});
