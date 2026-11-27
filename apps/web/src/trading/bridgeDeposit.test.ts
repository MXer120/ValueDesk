/**
 * The Base bridge deposit (trading/bridgeDeposit.ts) against a fake wallet, a
 * fake Base node and a fake ValueChain:
 *   - the calldata is exactly what viem encodes for sodex.com's ABI;
 *   - the Query contract's getTokenConfig answer is read for Base;
 *   - only routes SoDEX has switched on are offered (sSOSO never), USDC first;
 *   - nothing reaches the wallet when SoDEX has it paused, when SoDEX's config and
 *     ValueChain name different contracts, when the "USDC" is not Circle's, below
 *     the minimum, without gas, or when the bridge would refuse the call;
 *   - prompts are counted up front: switch, approval (only when short), deposit.
 *   npx tsx --test src/trading/bridgeDeposit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem';
import { MIRROR_REGISTRY } from '@sign/sodex/mirrorCore.js';
import {
  BRIDGE_CHAIN,
  allowanceData,
  approveData,
  bridgeCallData,
  bridgeRoutes,
  decodeTokenConfigBase,
  depositViaBridge,
  type BridgeDeps,
  type BridgeRoute,
} from './bridgeDeposit';
import { QUERY_CONTRACT, type Maintenance } from './relay';
import type { CoinConfig, FundsStep } from './funds';
import type { Eip1193Provider } from '../wallet';

const OWNER = '0x04fb8f9d0d8cd5495aa47e81ca9804cdf32a277d';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BRIDGE = '0xCC7322A2f9f82251dA51584B1a89915dBc02185B';
const SOSO_BASE = '0x624e2e7fDc8903165F64891672267AB0FCB98831';

const ABI = parseAbi([
  'function bridge(string coinSymbol, address receiver, uint256 amount, bool toClob)',
  'function bridgeNativeToken(address receiver, uint256 amount, bool toClob) payable',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

test('calldata: sodex.com ABI, byte for byte', () => {
  assert.equal(bridgeCallData('USDC', OWNER, 5_000_000n), encodeFunctionData({ abi: ABI, functionName: 'bridge', args: ['USDC', OWNER, 5_000_000n, true] }));
  assert.equal(bridgeCallData('MAG7.ssi', OWNER, 7n, true), encodeFunctionData({ abi: ABI, functionName: 'bridge', args: ['MAG7.ssi', OWNER, 7n, true] }));
  assert.equal(bridgeCallData('SOSO', OWNER, 10n ** 18n), encodeFunctionData({ abi: ABI, functionName: 'bridgeNativeToken', args: [OWNER, 10n ** 18n, true] }));
  assert.equal(approveData(BRIDGE, 9n), encodeFunctionData({ abi: ABI, functionName: 'approve', args: [BRIDGE, 9n] }));
  assert.equal(allowanceData(OWNER, BRIDGE), encodeFunctionData({ abi: ABI, functionName: 'allowance', args: [OWNER, BRIDGE] }));
  assert.ok(bridgeCallData('USDC', OWNER, 1n).startsWith('0x6ff03081'));
  assert.throws(() => bridgeCallData('sSOSO', OWNER, 1n), /not deposited/);
  assert.throws(() => bridgeCallData('USDC', OWNER, 0n), RangeError);
});

/** The Query contract's getTokenConfig answer (its first seven outputs; the reader needs the first three). */
function tokenConfig(rows: Array<{ chain: string; coin: string; bridge: string }>): string {
  return encodeAbiParameters(
    [
      { type: 'string[]' }, { type: 'string[]' }, { type: 'string[]' }, { type: 'uint256[]' }, { type: 'uint256[]' },
      { type: 'tuple[]', components: [{ type: 'uint256' }, { type: 'uint256' }] }, { type: 'bool[]' },
    ],
    [
      rows.map((r) => r.chain), rows.map((r) => r.coin), rows.map((r) => r.bridge), rows.map(() => 1_000_000n), rows.map(() => 0n),
      rows.map(() => [5_000_000n, 5_000_000n] as const), rows.map(() => false),
    ],
  );
}

test('getTokenConfig: the Base row, else null', () => {
  const ans = tokenConfig([
    { chain: 'ETH', coin: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', bridge: '' },
    { chain: 'BASE_ETH', coin: USDC_BASE, bridge: BRIDGE },
  ]);
  assert.deepEqual(decodeTokenConfigBase(ans), { token: USDC_BASE, bridge: BRIDGE });
  assert.equal(decodeTokenConfigBase(tokenConfig([{ chain: 'ETH', coin: USDC_BASE, bridge: BRIDGE }])), null);
  assert.equal(decodeTokenConfigBase(tokenConfig([{ chain: 'BASE_ETH', coin: USDC_BASE, bridge: '' }])), null);
});

const chainRoute = (over: Partial<CoinConfig['chains'][number]> = {}): CoinConfig['chains'][number] => ({
  key: 'BASE_ETH', label: 'Base', addressKind: 'evm', memo: null, withdrawType: 0, tokenAddress: USDC_BASE, isNativeToken: false,
  deposit: { allowed: true, min: '5', etaSeconds: 120 }, withdraw: { allowed: true, min: '5', fee: '1' },
  bridge: { address: BRIDGE, deposit: true, min: '5', etaSeconds: 120 },
  ...over,
});
const coin = (name: string, chains: CoinConfig['chains']): CoinConfig => ({
  coin: name, asset: `v${name}`, assetId: 1, valuechain: { token: '0x0000000000000000000000000000000000000001', symbol: `v${name}`, decimals: 6, native: false }, chains,
});

test('bridgeRoutes: SoDEX switched on, sSOSO never, USDC first', () => {
  const routes = bridgeRoutes([
    coin('USSI', [chainRoute({ tokenAddress: '0x3a46ed8FCeb6eF1ADA2E4600A522AE7e24D2Ed18' })]),
    coin('sSOSO', [chainRoute({ tokenAddress: '0xCE89AC7fD59808106B4E346175bCB8D8b273db90' })]),
    coin('soUSDC', [chainRoute({ tokenAddress: '0xb88A0269C0b7E665F15DE46F634e02cE81E361c9' })]),
    coin('MEME.ssi', [chainRoute({ bridge: { address: BRIDGE, deposit: false, min: '20', etaSeconds: 120 } })]),
    coin('USDT', [chainRoute({ bridge: null })]),
    coin('ETH', [chainRoute({ tokenAddress: null })]),
    coin('XAUt', [chainRoute({ key: 'ETH' })]),
    coin('USDC', [chainRoute({ key: 'ARBITRUM_ETH', bridge: null }), chainRoute()]),
  ]);
  assert.deepEqual(routes.map((r) => r.coin), ['USDC', 'USSI']);
  assert.deepEqual(routes[0], { coin: 'USDC', asset: 'vUSDC', token: USDC_BASE, bridge: BRIDGE, min: '5', etaSeconds: 120 });
});

// --- the deposit, against fakes -------------------------------------------------------------

const ROUTE: BridgeRoute = { coin: 'USDC', asset: 'vUSDC', token: USDC_BASE, bridge: BRIDGE, min: '5', etaSeconds: 120 };
const OPEN: Maintenance = { known: true, global: {}, coinWide: {}, byChain: {} };
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const abiStr = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);

interface World {
  chainId: number;
  balance: bigint;
  allowance: bigint;
  gas: bigint;
  symbol: string;
  decimals: number;
  maintenance: Maintenance;
  /** What ValueChain names (getTokenConfig). */
  chainToken: string;
  chainBridge: string;
  /** The bridge refuses the call (eth_call reverts). */
  refuse: boolean;
  sent: Array<{ to: string; data: string; chainId?: string }>;
  walletCalls: string[];
  receipts: Map<string, { status: string; blockNumber: string }>;
}

function world(over: Partial<World> = {}): { w: World; provider: Eip1193Provider; deps: BridgeDeps } {
  const w: World = {
    chainId: BRIDGE_CHAIN.chainId, balance: 100_000_000n, allowance: 0n, gas: 10n ** 15n, symbol: 'USDC', decimals: 6, maintenance: OPEN,
    chainToken: USDC_BASE, chainBridge: BRIDGE, refuse: false, sent: [], walletCalls: [], receipts: new Map(), ...over,
  };
  const provider: Eip1193Provider = {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<any> {
      w.walletCalls.push(method);
      if (method === 'eth_chainId') return `0x${w.chainId.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') {
        w.chainId = Number((params as Array<{ chainId: string }>)[0]!.chainId);
        return null;
      }
      if (method === 'eth_sendTransaction') {
        const tx = (params as Array<{ to: string; data: string; chainId?: string }>)[0]!;
        w.sent.push(tx);
        const hash = word(BigInt(w.sent.length));
        if (tx.data.startsWith('0x095ea7b3')) w.allowance = BigInt(`0x${tx.data.slice(74)}`);
        w.receipts.set(hash, { status: '0x1', blockNumber: '0x10' });
        return hash;
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
  } as Eip1193Provider;
  const deps: BridgeDeps = {
    async valueChainCall(to, data) {
      if (to === QUERY_CONTRACT && data.startsWith('0x81f868f7')) return tokenConfig([{ chain: 'BASE_ETH', coin: w.chainToken, bridge: w.chainBridge }]);
      if (to === MIRROR_REGISTRY) throw new Error('not used for USDC');
      throw new Error(`unexpected ValueChain call ${to} ${data.slice(0, 10)}`);
    },
    maintenance: async () => w.maintenance,
    async baseRpc<T>(method: string, params: unknown[]) {
      if (method === 'eth_blockNumber') return { result: '0x11' as T };
      if (method === 'eth_getBalance') return { result: `0x${w.gas.toString(16)}` as T };
      if (method === 'eth_getTransactionReceipt') return { result: (w.receipts.get(params[0] as string) ?? null) as T };
      if (method === 'eth_call') {
        const { to, data } = params[0] as { to: string; data: string };
        if (to === USDC_BASE && data === '0x95d89b41') return { result: abiStr(w.symbol) as T };
        if (to === USDC_BASE && data === '0x313ce567') return { result: word(BigInt(w.decimals)) as T };
        if (to === USDC_BASE && data.startsWith('0x70a08231')) return { result: word(w.balance) as T };
        if (to === USDC_BASE && data.startsWith('0xdd62ed3e')) return { result: word(w.allowance) as T };
        if (to === BRIDGE) {
          return w.refuse || w.allowance < 5_000_000n ? { error: { message: 'execution reverted: ERC20: transfer amount exceeds allowance' } } : { result: '0x' as T };
        }
      }
      throw new Error(`unexpected Base call ${method}`);
    },
    requireTerms: async () => undefined,
    sleep: async () => undefined,
  };
  return { w, provider, deps };
}

test('allowance already there, wallet on Base: one prompt, one call to the bridge', async () => {
  const { w, provider, deps } = world({ allowance: 50_000_000n });
  const steps: FundsStep[] = [];
  const r = await depositViaBridge({ provider, owner: OWNER, route: ROUTE, amount: '12.5', onStep: (s) => steps.push(s) }, deps);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.to, BRIDGE);
  assert.equal(w.sent[0]!.data, encodeFunctionData({ abi: ABI, functionName: 'bridge', args: ['USDC', OWNER, 12_500_000n, true] }));
  assert.equal(w.sent[0]!.chainId, '0x2105');
  assert.deepEqual(steps.filter((s) => s.wallet), [{ wallet: 'confirm', n: 1, of: 1 }]);
  assert.deepEqual(r, { hash: word(1n), explorerUrl: `https://basescan.org/tx/${word(1n)}`, amount: '12.5', confirmed: true });
});

test('allowance short, wallet elsewhere: switch, exact approval, then the deposit - 3 prompts counted up front', async () => {
  const { w, provider, deps } = world({ chainId: 1 });
  const steps: FundsStep[] = [];
  await depositViaBridge({ provider, owner: OWNER, route: ROUTE, amount: '5', onStep: (s) => steps.push(s) }, deps);
  assert.equal(w.chainId, 8453);
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[0]!.to, USDC_BASE);
  assert.equal(w.sent[0]!.data, encodeFunctionData({ abi: ABI, functionName: 'approve', args: [BRIDGE, 5_000_000n] }));
  assert.equal(w.sent[1]!.to, BRIDGE);
  assert.deepEqual(steps.filter((s) => s.wallet), [
    { wallet: 'approve', n: 1, of: 3 },
    { wallet: 'approve', n: 2, of: 3 },
    { wallet: 'confirm', n: 3, of: 3 },
  ]);
});

const refused = async (over: Partial<World>, amount: string, why: RegExp) => {
  const { w, provider, deps } = world(over);
  await assert.rejects(depositViaBridge({ provider, owner: OWNER, route: ROUTE, amount }, deps), why);
  assert.equal(w.sent.length, 0, 'nothing was sent');
  return w;
};

test('nothing reaches the wallet: paused, contracts that do not match ValueChain, not Circle USDC', async () => {
  let w = await refused({ maintenance: { ...OPEN, byChain: { BASE_ETH: { deposit: { severity: 'unavailable', message: 'upgrade', duration: '' } } } } }, '10', /paused: upgrade/);
  assert.deepEqual(w.walletCalls, []);
  w = await refused({ chainBridge: '0x1111111111111111111111111111111111111111' }, '10', /does not match/);
  assert.deepEqual(w.walletCalls, []);
  w = await refused({ chainToken: '0x2222222222222222222222222222222222222222' }, '10', /does not match/);
  assert.deepEqual(w.walletCalls, []);
  const { w: w2, provider, deps } = world();
  await assert.rejects(depositViaBridge({ provider, owner: OWNER, route: { ...ROUTE, token: '0x3333333333333333333333333333333333333333' }, amount: '10' }, deps), /not Circle's USDC/);
  assert.deepEqual(w2.walletCalls, []);
});

test('nothing is sent: wrong token on Base, below the minimum, more than held, no gas, the bridge would refuse', async () => {
  await refused({ symbol: 'USDbC' }, '10', /is not USDC/);
  await refused({ decimals: 18 }, '10', /is not USDC/);
  await refused({}, '4.99', /minimum deposit is 5 USDC/);
  await refused({ balance: 9_000_000n }, '10', /holds 9 USDC on Base/);
  await refused({ gas: 0n }, '10', /no ETH on Base/);
  const w = await refused({ allowance: 50_000_000n, refuse: true }, '10', /bridge would refuse/);
  assert.ok(!w.walletCalls.includes('eth_sendTransaction'));
});

test('an approval that does not cover the amount stops before the deposit', async () => {
  const { w, provider, deps } = world();
  const send = provider.request.bind(provider);
  provider.request = async (a: { method: string; params?: unknown[] }) => {
    const r = await send(a);
    if (a.method === 'eth_sendTransaction') w.allowance = 1n; // the token kept a smaller allowance
    return r;
  };
  await assert.rejects(depositViaBridge({ provider, owner: OWNER, route: ROUTE, amount: '10' }, deps), /does not cover the amount/);
  assert.equal(w.sent.length, 1, 'only the approval');
});
