/**
 * A whole LIVE run, offline: the runner (guard, key-backed wallet, the app's
 * own funds/session/actions code) against a stateful fake of the backend, the
 * SoDEX gateway and every chain's JSON-RPC node. Nothing leaves the process -
 * the fake replaces globalThis.fetch UNDER the runner's guard.
 *
 * What it proves: every write the app really makes matches what the step
 * armed (no guard or wallet-policy refusals), every verification converges on
 * the state the write produced, and the run ends where the plan says. What it
 * cannot prove: that SoDEX itself behaves like this fake.
 *   npx tsx --test e2e/live/simulate.test.ts        (from apps/web)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, parseAbiParameters, parseTransaction, recoverTransactionAddress, toFunctionSelector, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CALL_FOR_PERMIT_CONTRACT, CLOB_GATEWAY, WITHDRAWAL_CREATED_TOPIC, WITHDRAW_TOKEN_TARGET } from '@sodex-core';
import { formatUnits, parseUnits } from '../../src/trading/onboard';
import { unitsDown } from '../../src/trading/funds';
import { BIZ_ORIGIN, QUERY_CONTRACT } from '../../src/trading/relay';
import { runE2E } from './runner';
import { DEPOSIT_WALLET_REGISTRY } from './reads';
import { dMul, dSub } from './util';

const GW = 'https://mainnet-gw.sodex.dev';
const BACKEND = 'http://127.0.0.1:5999';
/** SoDEX's relayer contracts and views the app reads on ValueChain (sodex-core callForPermit.ts, trading/relay.ts). */
const PERMIT_ABI = parseAbi([
  'function nonces(address owner, uint192 key) view returns (uint256)',
  'function execute(address to, string cmdType, bytes cmdData, uint256 nonce, uint256 deadline, bytes signature)',
]);
const QUERY_ABI = parseAbi(['function getWithdrawRequirements(string coinSymbol, string chain, address account, uint8 withdrawType) view returns (uint256, uint256, uint256)']);
const WITHDRAWER_ABI = parseAbi(['function isBlacklistedWallet(string chain, string receiver) view returns (bool)', 'function getWithdrawal(uint256 id) view returns (uint256)']);
const WITHDRAWAL_TUPLE = parseAbiParameters(
  '(uint256 withdrawId, string chain, string coinAddr, address account, string receiver, uint256 amount, uint256 withdrawFee, string bridgeAddr, uint256 createdTimestamp, uint256 settledTimestamp, string txHash, uint8 status, string memo, bool failedBackToClob, uint256 updatedTimestamp, string coinSymbol)',
);
const FEES: Record<string, bigint> = { USDC: 1_000_000n, ETH: 500_000_000_000_000n };
const VC_USDC = '0xcb7f80dff2727c791fa491722c428e6657f7e2c6';
const VC_ETH = '0xd76544025769c13496bf4a6c2b4e67ead3f857d8';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const EXCHANGE = '0x0101010101010101010101010101010101010101';
const DEPOSIT_ADDR = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const FRIEND = '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd';
const CHAINS: Record<string, number> = {
  'https://rpc.valuechain.xyz': 286623,
  'https://arb1.arbitrum.io/rpc': 42161,
  'https://mainnet.base.org': 8453,
  'https://ethereum-rpc.publicnode.com': 1,
  'https://bsc-dataseed.bnbchain.org': 56,
  'https://polygon-bor-rpc.publicnode.com': 137,
};
const REGISTRY_ABI = parseAbi(['function getDepositWalletList(address account, string coinSymbol) view returns (string[] chains, string[][] wallets)']);
/** The mirror registry the app reads the CURRENT deposit address from (apps/server/src/sodex/mirrorCore.ts). */
const MIRROR_REGISTRY = '0xb37295d1ea21e65b76dcb2e85e035ee0dbfc70cb';
const MIRROR_ABI = parseAbi([
  'function getDepositWallet(address account, string chain) view returns (string)',
  'function listRemoteNativeTokens() view returns ((string chain, string coinAddr, string bridgeAddr, bool custodyDisabled, uint256 minDepositAmount, uint256 custodyAmount, uint256 bridgedAmount)[])',
]);
const ERC20 = parseAbi(['function approve(address spender, uint256 amount)', 'function transfer(address to, uint256 amount)']);
const EXCHANGE_ABI = parseAbi(['function depositERC20(address token, uint256 amount)']);
const PERMIT_CMD = [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'string' }, { type: 'bool' }] as const;
const DEPOSIT_CMD = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }] as const;

const COINS: Record<number, { asset: string; dp: number; token: string | null }> = {
  0: { asset: 'vUSDC', dp: 6, token: VC_USDC },
  2: { asset: 'vETH', dp: 18, token: VC_ETH },
  4: { asset: 'WSOSO', dp: 18, token: null },
};
const ASK: Record<number, string> = { 4: '0.3', 2: '2690' };
const BID: Record<number, string> = { 4: '0.2996', 2: '2689' };

const assetConfig = [
  {
    assetName: 'USDC',
    valueChainMetadata: { tokenSymbol: 'vUSDC', tokenDecimals: 6, evmAddress: '0xcb7F80Dff2727c791fA491722c428e6657f7e2c6', isNativeToken: false },
    sodexMetadata: { id: 0, name: 'vUSDC', marginRatio: '1', tokenPrice: '1' },
    chains: [{ chainName: 'ARBITRUM_ETH', isNativeToken: false, tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', custody: { minDepositAmount: '5', minWithdrawAmount: '5', withdrawFee: '1', allowDeposit: true, allowWithdraw: true, estimatedDepositSeconds: 120 } }],
  },
  {
    assetName: 'SOSO',
    valueChainMetadata: { tokenSymbol: 'SOSO', tokenDecimals: 18, isNativeToken: true },
    sodexMetadata: { id: 4, name: 'WSOSO', marginRatio: '0.5', tokenPrice: '0.3' },
    chains: [{ chainName: 'BASE_ETH', isNativeToken: false, custody: { minDepositAmount: '1', allowDeposit: true, allowWithdraw: false } }],
  },
  {
    assetName: 'ETH',
    valueChainMetadata: { tokenSymbol: 'vETH', tokenDecimals: 18, evmAddress: '0xD76544025769c13496Bf4a6c2b4E67eAD3F857D8', isNativeToken: false },
    sodexMetadata: { id: 2, name: 'vETH', marginRatio: '0.9', tokenPrice: '2690' },
    chains: [{ chainName: 'ARBITRUM_ETH', isNativeToken: true, custody: { minDepositAmount: '0.0015', minWithdrawAmount: '0.0015', withdrawFee: '0.0005', allowDeposit: true, allowWithdraw: true } }],
  },
];
const spotSymbols = [
  { id: 4, name: 'WSOSO_vUSDC', displayName: 'SOSO/USDC', baseCoin: 'WSOSO', baseCoinID: 4, quoteCoin: 'vUSDC', quoteCoinID: 0, pricePrecision: 4, tickSize: '0.0001', quantityPrecision: 2, stepSize: '0.01', minQuantity: '0.01', marketMinQuantity: '0.01', minNotional: '1', maxNotional: '0', minPrice: '0.0001', maxPrice: '0', makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING', sellLimitDownRatio: '0.5', buyLimitUpRatio: '1' },
  { id: 2, name: 'vETH_vUSDC', displayName: 'ETH/USDC', baseCoin: 'vETH', baseCoinID: 2, quoteCoin: 'vUSDC', quoteCoinID: 0, pricePrecision: 1, tickSize: '0.1', quantityPrecision: 4, stepSize: '0.0001', minQuantity: '0.0001', marketMinQuantity: '0.0001', minNotional: '5', maxNotional: '0', minPrice: '0.1', maxPrice: '0', makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING', sellLimitDownRatio: '0.5', buyLimitUpRatio: '1' },
];
const perpsSymbols = [
  { id: 1, name: 'BTC-USD', displayName: 'BTC-USD', baseCoin: 'BTC', quoteCoin: 'vUSDC', quoteCoinID: 0, pricePrecision: 0, tickSize: '1', quantityPrecision: 5, stepSize: '0.00001', minQuantity: '0.00001', marketMinQuantity: '0.00001', minNotional: '10', maxNotional: '4000000', minPrice: '1', maxPrice: '0', makerFee: '0.00012', takerFee: '0.0004', status: 'TRADING', sellLimitDownRatio: '0.05', buyLimitUpRatio: '0.05', initLeverage: 20, maxLeverage: 40 },
];

interface Order {
  engine: 'spot' | 'perps';
  orderID: number;
  clOrdID: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  origQty: string;
  status: string;
  executedQty: string;
}

/** The fake SoDEX + backend + chains, with balances in exact base units. */
class World {
  owner = '';
  aid = 0;
  spot = new Map<number, bigint>();
  locked = new Map<number, bigint>();
  perps = 0n;
  position = '0';
  vcNative = 0n;
  vcTok = new Map<string, Map<string, bigint>>();
  arbUsdc = new Map<string, bigint>();
  arbEth = new Map<string, bigint>();
  /** CallForPermit nonce lanes: 0 withdrawals, 2 deposits (the contract answers lane 2 key-packed). */
  permitNonce = 5n;
  depositNonce = 0n;
  /** The ValueChain token's own ERC-2612 nonce. */
  tokenNonce = 0n;
  /** SoDEX's Withdrawer records, abi-encoded as getWithdrawal returns them. */
  withdrawals = new Map<bigint, Hex>();
  orders: Order[] = [];
  history: Order[] = [];
  keys: Array<{ name: string; publicKey: string; expiresAt: number }> = [];
  /** Mined transactions (wallet-sent and relayed) and their logs. */
  receipts = new Map<string, Array<{ address: string; topics: string[]; data: string }>>();
  txCount = new Map<number, number>();
  nextId = 1000;
  writes: string[] = [];
  /** Test switches. */
  registryAddress = DEPOSIT_ADDR;

  tok(token: string, holder: string): bigint {
    return this.vcTok.get(token)?.get(holder.toLowerCase()) ?? 0n;
  }
  addTok(token: string, holder: string, d: bigint): void {
    const m = this.vcTok.get(token) ?? new Map<string, bigint>();
    const v = (m.get(holder.toLowerCase()) ?? 0n) + d;
    assert.ok(v >= 0n, `negative ${token} balance for ${holder}`);
    m.set(holder.toLowerCase(), v);
    this.vcTok.set(token, m);
  }
  addSpot(coin: number, d: bigint): void {
    const v = (this.spot.get(coin) ?? 0n) + d;
    assert.ok(v >= 0n, `negative spot balance of coin ${coin}`);
    this.spot.set(coin, v);
  }
  add(map: Map<string, bigint>, who: string, d: bigint): void {
    const v = (map.get(who.toLowerCase()) ?? 0n) + d;
    assert.ok(v >= 0n, 'negative balance');
    map.set(who.toLowerCase(), v);
  }
}

let world = new World();
const realFetch = globalThis.fetch;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown) => json({ code: 0, data, timestamp: Date.now() });
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

async function rpc(chainId: number, method: string, params: any[]): Promise<unknown> {
  const w = world;
  switch (method) {
    case 'eth_chainId':
      return `0x${chainId.toString(16)}`;
    case 'eth_gasPrice':
      return chainId === 286623 ? '0x1e8480' : '0x3b9aca00';
    case 'eth_maxPriorityFeePerGas':
      return '0x0';
    case 'eth_getBlockByNumber':
      return { number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: chainId === 286623 ? '0xf4240' : '0x3b9aca00', transactions: [] };
    case 'eth_getTransactionCount':
      return `0x${(w.txCount.get(chainId) ?? 0).toString(16)}`;
    case 'eth_estimateGas':
      return '0x186a0';
    case 'eth_fillTransaction':
      throw { code: -32601, message: 'the method eth_fillTransaction does not exist/is not available' };
    case 'eth_getBalance': {
      const who = String(params[0]).toLowerCase();
      if (chainId === 286623) return word(who === w.owner ? w.vcNative : 0n);
      if (chainId === 42161) return word(w.arbEth.get(who) ?? 0n);
      return '0x0';
    }
    case 'eth_getTransactionReceipt': {
      const logs = w.receipts.get(String(params[0]));
      return logs ? { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', blockNumber: '0x10', logs } : null;
    }
    case 'eth_call': {
      const { to, data } = params[0] as { to: string; data: string };
      const t = to.toLowerCase();
      if (chainId === 286623) {
        if (t === MIRROR_REGISTRY) {
          const d = decodeFunctionData({ abi: MIRROR_ABI, data: data as Hex });
          if (d.functionName === 'listRemoteNativeTokens') return encodeFunctionResult({ abi: MIRROR_ABI, functionName: 'listRemoteNativeTokens', result: [] });
          const mine = String(d.args[0]).toLowerCase() === w.owner && d.args[1] === 'ARBITRUM_ETH';
          return encodeFunctionResult({ abi: MIRROR_ABI, functionName: 'getDepositWallet', result: mine ? DEPOSIT_ADDR : '' });
        }
        if (t === DEPOSIT_WALLET_REGISTRY.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: REGISTRY_ABI, data: data as Hex });
          const mine = String(args[0]).toLowerCase() === w.owner && args[1] === 'USDC';
          return encodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'getDepositWalletList', result: mine ? [['ARBITRUM_ETH'], [[w.registryAddress]]] : [[], []] });
        }
        if (t === CALL_FOR_PERMIT_CONTRACT.toLowerCase()) {
          const d = decodeFunctionData({ abi: PERMIT_ABI, data: data as Hex });
          if (d.functionName === 'nonces') {
            assert.equal(String(d.args[0]).toLowerCase(), w.owner, 'nonces are read for the wallet');
            const lane = d.args[1] as bigint;
            return word(lane === 0n ? w.permitNonce : (lane << 64n) | w.depositNonce);
          }
          return '0x'; // execute(...) simulated with eth_call: the fake accepts what it is about to relay
        }
        if (t === QUERY_CONTRACT.toLowerCase()) {
          const d = decodeFunctionData({ abi: QUERY_ABI, data: data as Hex });
          return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [FEES[d.args[0] as string] ?? 0n, 0n, 10n ** 30n]);
        }
        if (t === WITHDRAW_TOKEN_TARGET.toLowerCase()) {
          const d = decodeFunctionData({ abi: WITHDRAWER_ABI, data: data as Hex });
          if (d.functionName === 'isBlacklistedWallet') return word(0n);
          const rec = w.withdrawals.get(d.args[0] as bigint);
          if (!rec) throw { code: 3, message: 'execution reverted', data: '0x' };
          return rec;
        }
        if (data.startsWith('0x70a08231')) return word(w.tok(t, `0x${data.slice(-40)}`));
        if (data === toFunctionSelector('name()')) return encodeAbiParameters([{ type: 'string' }], [t === VC_USDC ? 'SoDexToken: USDC' : 'SoDexToken: ETH']);
        if (data.startsWith(toFunctionSelector('nonces(address)'))) return word(w.tokenNonce);
        return '0x';
      }
      if (chainId === 42161 && t === USDC_ARB) {
        if (data === '0x95d89b41') return encodeAbiParameters([{ type: 'string' }], ['USDC']);
        if (data === '0x313ce567') return word(6n);
        if (data.startsWith('0x70a08231')) return word(w.arbUsdc.get(`0x${data.slice(-40)}`) ?? 0n);
      }
      if (data.startsWith('0x70a08231')) return word(0n);
      return '0x';
    }
    case 'eth_sendRawTransaction': {
      const raw = params[0] as Hex;
      const tx = parseTransaction(raw);
      const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
      assert.equal(from, w.owner, 'only the test wallet sends');
      assert.equal(tx.chainId, chainId, 'signed for the chain it is sent to');
      w.txCount.set(chainId, (w.txCount.get(chainId) ?? 0) + 1);
      const to = String(tx.to).toLowerCase();
      const data = (tx.data ?? '0x') as Hex;
      if (chainId === 42161) {
        assert.equal(to, USDC_ARB);
        const d = decodeFunctionData({ abi: ERC20, data });
        assert.equal(d.functionName, 'transfer');
        const [dest, amt] = d.args as readonly [string, bigint];
        w.add(w.arbUsdc, from, -amt);
        w.writes.push(`arbitrum transfer ${amt} -> ${dest.toLowerCase()}`);
        if (dest.toLowerCase() === DEPOSIT_ADDR) {
          const first = w.aid === 0;
          if (first) w.aid = 777;
          w.addSpot(0, amt - (first ? 1_000_000n : 0n));
        } else w.add(w.arbUsdc, dest, amt);
      } else if (chainId === 286623) {
        if (to === VC_USDC) {
          const d = decodeFunctionData({ abi: ERC20, data });
          const [dest, amt] = d.args as readonly [string, bigint];
          w.writes.push(`valuechain USDC.${d.functionName}(${dest.toLowerCase()}, ${amt})`);
          if (d.functionName === 'transfer') {
            w.addTok(VC_USDC, from, -amt);
            w.addTok(VC_USDC, dest, amt);
          }
        } else if (to === EXCHANGE) {
          const d = decodeFunctionData({ abi: EXCHANGE_ABI, data });
          const [token, amt] = d.args as readonly [string, bigint];
          w.addTok(token.toLowerCase(), from, -amt);
          w.addSpot(0, amt);
          w.writes.push(`valuechain depositERC20 ${amt}`);
        } else throw new Error(`unexpected ValueChain tx to ${to}`);
      } else throw new Error(`unexpected tx on chain ${chainId}`);
      const hash = keccak256(raw);
      w.receipts.set(hash, []);
      return hash;
    }
    default:
      throw { code: -32601, message: `fake node: ${method}` };
  }
}

function spotState() {
  const B = [...world.spot.entries()].map(([i, v]) => ({ i, a: COINS[i]!.asset, t: formatUnits(v, COINS[i]!.dp), l: formatUnits(world.locked.get(i) ?? 0n, COINS[i]!.dp) }));
  return { aid: world.aid, B, O: [] };
}
function perpsState() {
  const open = world.position !== '0';
  const at = world.perps;
  return { aid: world.aid, amw: formatUnits(at, 6), B: world.aid ? [{ i: 0, a: 'vUSDC', wb: formatUnits(world.perps, 6), at: formatUnits(at, 6) }] : [], P: open ? [{ s: 'BTC-USD', sz: world.position, ur: '0' }] : [], O: world.orders.filter((o) => o.engine === 'perps') };
}

function gateway(url: URL, method: string, body: any): Response {
  const w = world;
  const p = url.pathname;
  let m: RegExpExecArray | null;
  if (method === 'GET') {
    if (p === '/api/v1/asset/config') {
      const name = url.searchParams.get('name');
      return ok(name ? assetConfig.filter((a) => a.assetName === name) : assetConfig);
    }
    if (p === '/api/v1/perps/markets/coins') return ok([]);
    // Market data: the app reads it from the gateway directly now (exchange/sodexMarket.ts).
    if (p === '/api/v1/spot/markets/symbols') return ok(spotSymbols);
    if (p === '/api/v1/perps/markets/symbols') return ok(perpsSymbols);
    if (p === '/api/v1/spot/markets/tickers') return ok(spotSymbols.map((s) => ({ symbol: s.name, lastPx: ASK[s.id] })));
    if ((m = /^\/api\/v1\/(spot|perps)\/markets\/([^/]+)\/orderbook$/.exec(p))) {
      const s = spotSymbols.find((x) => x.name === m![2]);
      return ok(s ? { bids: [[BID[s.id], '100']], asks: [[ASK[s.id], '100']] } : { bids: [['84071', '1']], asks: [['84072', '1']] });
    }
    if ((m = /^\/api\/v1\/user\/(0x[0-9a-f]{40})\/subaccounts$/.exec(p))) return w.aid ? ok({ userID: w.aid, primaryAccountID: w.aid, subaccounts: [] }) : json({ code: 1, error: 'user not found' });
    if (/^\/api\/v1\/spot\/accounts\/0x[0-9a-f]{40}\/state$/.test(p)) return ok(spotState());
    if (/^\/api\/v1\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(p)) return ok(perpsState());
    if ((m = /^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/api-keys$/.exec(p))) return ok(w.keys);
    if ((m = /^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/orders$/.exec(p))) return ok({ blockTime: 1, blockHeight: 1, orders: w.orders.filter((o) => o.engine === m![1]) });
    if ((m = /^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]{40}\/orders\/history$/.exec(p))) return ok(w.history.filter((o) => o.engine === m![1]));
    if (/^\/api\/v1\/perps\/accounts\/0x[0-9a-f]{40}\/positions$/.test(p)) return ok({ positions: w.position !== '0' ? [{ symbol: 'BTC-USD', size: w.position, avgEntryPrice: '84072' }] : [] });
    if (p === '/api/v1/user/withdraw/status') return ok({ records: [{ status: 'success' }] });
    return json({ code: 404, error: `fake gateway: GET ${p}` }, 404);
  }
  w.writes.push(`${method} ${p}`);
  if ((m = /^\/api\/v1\/(spot|perps)\/exchange$/.exec(p))) {
    assert.equal(body.type, 'addAPIKey');
    if (!w.keys.some((k) => k.publicKey === body.params.publicKey)) w.keys.push({ name: body.params.name, publicKey: body.params.publicKey, expiresAt: body.params.expiresAt });
    return ok(null);
  }
  if ((m = /^\/api\/v1\/(spot|perps)\/accounts\/transfers$/.exec(p))) {
    const coin = body.coinID as number;
    const units = parseUnits(body.amount, COINS[coin]!.dp);
    if (body.type === 3) {
      w.addSpot(coin, -units);
      w.perps += units;
    } else if (body.type === 5) {
      assert.ok(w.perps >= units, 'perps overdrawn');
      w.perps -= units;
      w.addSpot(coin, units);
    } else if (body.type === 2) {
      w.addSpot(coin, -units);
      if (COINS[coin]!.token) w.addTok(COINS[coin]!.token!, w.owner, units);
      else w.vcNative += units;
    } else throw new Error(`transfer type ${body.type}`);
    return ok({ id: body.id });
  }
  if (p === '/api/v1/spot/trade/orders/batch' && method === 'POST') {
    const x = body.orders[0];
    const coin = x.symbolID as number;
    const id = w.nextId++;
    if (x.type === 1) {
      const lock = parseUnits(dMul(x.price, x.quantity), 6);
      w.locked.set(0, (w.locked.get(0) ?? 0n) + lock);
      w.orders.push({ engine: 'spot', orderID: id, clOrdID: x.clOrdID, symbol: coin === 4 ? 'WSOSO_vUSDC' : 'vETH_vUSDC', side: x.side === 1 ? 'BUY' : 'SELL', price: x.price, origQty: x.quantity, status: 'NEW', executedQty: '0' });
    } else {
      const got = unitsDown(dSub(x.quantity, dMul(x.quantity, '0.00065')), COINS[coin]!.dp);
      const paid = parseUnits(dMul(x.quantity, ASK[coin]!), 6) + 1n;
      w.addSpot(0, -paid);
      w.addSpot(coin, got);
    }
    return ok([{ code: 0, clOrdID: x.clOrdID, orderID: id }]);
  }
  if (p === '/api/v1/spot/trade/orders/batch' && method === 'DELETE') {
    const c = body.cancels[0];
    const o = w.orders.find((x) => x.orderID === c.orderID);
    assert.ok(o, 'cancel of an unknown order');
    w.orders = w.orders.filter((x) => x !== o);
    w.locked.set(0, (w.locked.get(0) ?? 0n) - parseUnits(dMul(o.price, o.origQty), 6));
    w.history.push({ ...o, status: 'CANCELED' });
    return ok([{ code: 0, orderID: c.orderID }]);
  }
  if (p === '/api/v1/perps/trade/orders' && method === 'POST') {
    const x = body.orders[0];
    const id = w.nextId++;
    if (x.type === 1) {
      w.orders.push({ engine: 'perps', orderID: id, clOrdID: x.clOrdID, symbol: 'BTC-USD', side: x.side === 1 ? 'BUY' : 'SELL', price: x.price, origQty: x.quantity, status: 'NEW', executedQty: '0' });
    } else {
      const fee = parseUnits(dMul(dMul(x.quantity, '84072'), '0.0004').replace(/(\.\d{6})\d+$/, '$1'), 6);
      w.perps -= fee;
      w.position = x.side === 1 ? x.quantity : dSub(w.position, x.quantity) === '0' ? '0' : dSub(w.position, x.quantity);
      if (x.reduceOnly) assert.equal(x.side, 2, 'the close is a sell');
    }
    return ok([{ code: 0, clOrdID: x.clOrdID, orderID: id }]);
  }
  if (p === '/api/v1/perps/trade/orders' && method === 'DELETE') {
    const c = body.cancels[0];
    const o = w.orders.find((x) => x.orderID === c.orderID);
    assert.ok(o, 'cancel of an unknown perps order');
    w.orders = w.orders.filter((x) => x !== o);
    w.history.push({ ...o, status: 'CANCELED' });
    return ok([{ code: 0, orderID: c.orderID }]);
  }
  if ((m = /^\/api\/v1\/user\/(0x[0-9a-f]{40})\/evm-withdraw$/.exec(p))) {
    const [coinSymbol, chain, receiver, amount] = decodeAbiParameters(PERMIT_CMD, body.cmdData);
    assert.equal(BigInt(body.nonce), w.permitNonce, 'the permit uses the contract nonce');
    assert.equal(chain, 'ARBITRUM_ETH');
    w.permitNonce += 1n;
    if (coinSymbol === 'USDC') {
      w.addTok(VC_USDC, w.owner, -amount);
      w.add(w.arbUsdc, receiver, amount - 1_000_000n);
    } else if (coinSymbol === 'ETH') {
      w.addTok(VC_ETH, w.owner, -amount);
      w.add(w.arbEth, receiver, amount - 500_000_000_000_000n);
    } else throw new Error(`permit for ${coinSymbol}`);
    return ok({ txHash: `0x${(w.nextId++).toString(16).padStart(64, 'a')}` });
  }
  return json({ code: 404, error: `fake gateway: ${method} ${p}` }, 404);
}

function backend(url: URL, method: string, body: any): Response {
  const w = world;
  const p = url.pathname;
  if (p === '/api/health') return json({ ok: true, network: 'mainnet', chainId: 286623, mainnetWritesAllowed: true });
  if (p === '/api/deposit/chain') return json({ chainId: 286623, chainIdHex: '0x45f9f', name: 'ValueChain', rpcUrl: 'https://rpc.valuechain.xyz', explorerUrl: 'https://main-scan.valuechain.xyz', nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 }, exchange: EXCHANGE });
  if (p === '/api/md/spot/symbols') return json({ symbols: spotSymbols });
  if (p === '/api/md/perps/symbols') return json({ symbols: perpsSymbols });
  if (p === '/api/md/spot/tickers') return json({ tickers: spotSymbols.map((s) => ({ symbol: s.name, lastPx: ASK[s.id] })) });
  if ((/^\/api\/md\/(spot|perps)\/orderbook$/.test(p))) {
    const sym = url.searchParams.get('symbol');
    const s = spotSymbols.find((x) => x.name === sym);
    return json({ book: s ? { bids: [[BID[s.id], '100']], asks: [[ASK[s.id], '100']] } : { bids: [['84071', '1']], asks: [['84072', '1']] } });
  }
  if (p === '/api/mirror/deposit-options') {
    return json({ address: w.owner, assets: [{ symbol: 'USDC', routes: [{ chain: 'ARBITRUM_ETH', label: 'Arbitrum One', address: DEPOSIT_ADDR, custodian: 'Cobo', verified: true, isEvm: true }] }], rejected: [], allVerified: true, registry: {} });
  }
  if (p === '/api/deposit/prepare' && method === 'POST') {
    w.writes.push(`backend prepare ${body.amount}`);
    const units = parseUnits(body.amount, 6);
    return json({
      asset: { coinId: 0, symbol: 'vUSDC', address: VC_USDC, decimals: 6, isNative: false, verified: true, walletBalance: null },
      amount: body.amount,
      walletBalance: formatUnits(w.tok(VC_USDC, w.owner), 6),
      sufficient: w.tok(VC_USDC, w.owner) >= units,
      blocker: null,
      transactions: [
        { kind: 'approve', to: VC_USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [EXCHANGE, units] }), value: '0x0', description: 'approve' },
        { kind: 'deposit', to: EXCHANGE, data: encodeFunctionData({ abi: EXCHANGE_ABI, functionName: 'depositERC20', args: [VC_USDC, units] }), value: '0x0', description: 'deposit' },
      ],
    });
  }
  if (p.startsWith('/api/deposit/tx/')) return json({ hash: p.split('/').pop(), status: world.receipts.has(p.split('/').pop()!) ? 'success' : 'pending', explorerUrl: null });
  if (p === '/api/deposit/assets') return json({ assets: [], warnings: [], exchange: EXCHANGE, registered: w.aid > 0, accountId: w.aid || null, registrationNote: null });
  return json({ error: `fake backend: ${method} ${p}` }, 404);
}

/** SoDEX's relayer (alpha-biz): maintenance, the address risk check, and call_for_permit executed at once. */
function relayer(url: URL, method: string, body: any): Response {
  const w = world;
  const p = url.pathname;
  if (method === 'GET' && p === '/biz/v1/ext-chain/maintenance') return json({ code: 0, data: [] });
  // Deposit options: the app reads them itself now (exchange/deposits.ts).
  if (method === 'GET' && p === '/biz/config/symbol') {
    return json({ code: 0, data: { depositWhiteList: { USDC: { ARBITRUM_ETH: { depositTime: 2 } } }, explorer: { ARBITRUM_ETH: 'https://arbiscan.io/token/' } } });
  }
  if (method === 'POST' && p === '/biz/mirror/create_deposit_addresses') {
    const mine = String(body?.account).toLowerCase() === w.owner;
    return json({ code: '0', data: { accountAddresses: mine ? [{ chain: 'ARBITRUM_ETH', address: DEPOSIT_ADDR, custodian: 'Cobo', status: 'Enabled' }] : [] } });
  }
  if (method === 'POST' && p === '/biz/mirror/deposit_address') {
    return json({ code: 0, data: { status: 'Enabled', address: String(body?.chain) === 'ARBITRUM_ETH' ? DEPOSIT_ADDR : '' } });
  }
  if (method === 'POST' && p === '/biz/mirror/analyse_address') {
    w.writes.push(`analyse_address ${body.address}`);
    return json({ code: 0, data: {} });
  }
  if (method === 'POST' && p === '/biz/mirror/call_for_permit') {
    const to = String(body.to).toLowerCase();
    w.writes.push(`call_for_permit ${body.cmdType}`);
    const hash = keccak256(`0x${(w.nextId++).toString(16).padStart(16, '0')}`);
    if (body.cmdType === 'WithdrawToken') {
      assert.equal(to, WITHDRAW_TOKEN_TARGET.toLowerCase());
      assert.equal(BigInt(body.nonce), w.permitNonce, 'the withdraw lane nonce');
      w.permitNonce += 1n;
      const [coinSymbol, chain, receiver, amount, , memo, failedBackToClob] = decodeAbiParameters(PERMIT_CMD, body.cmdData);
      assert.equal(chain, 'ARBITRUM_ETH');
      const fee = FEES[coinSymbol]!;
      const token = coinSymbol === 'USDC' ? VC_USDC : VC_ETH;
      w.addTok(token, w.owner, -amount);
      if (coinSymbol === 'USDC') w.add(w.arbUsdc, receiver, amount - fee);
      else w.add(w.arbEth, receiver, amount - fee);
      const id = BigInt(w.nextId++);
      const rec = encodeAbiParameters(WITHDRAWAL_TUPLE, [
        { withdrawId: id, chain, coinAddr: token, account: w.owner as Hex, receiver, amount, withdrawFee: fee, bridgeAddr: '', createdTimestamp: 1n, settledTimestamp: 2n, txHash: `0x${'de'.repeat(32)}`, status: 1, memo, failedBackToClob, updatedTimestamp: 2n, coinSymbol },
      ]);
      w.withdrawals.set(id, rec);
      w.receipts.set(hash, [{ address: WITHDRAW_TOKEN_TARGET, topics: [WITHDRAWAL_CREATED_TOPIC], data: rec }]);
    } else if (body.cmdType === 'DepositERC20WithPermit') {
      assert.equal(to, CLOB_GATEWAY.toLowerCase());
      assert.equal(BigInt(body.nonce), (2n << 64n) | w.depositNonce, 'the deposit lane nonce (key-packed)');
      w.depositNonce += 1n;
      w.tokenNonce += 1n;
      const [token, amount] = decodeAbiParameters(DEPOSIT_CMD, body.cmdData);
      w.addTok(token.toLowerCase(), w.owner, -amount);
      w.addSpot(0, amount);
      w.receipts.set(hash, []);
    } else throw new Error(`relayer: ${body.cmdType}`);
    return json({ code: 0, data: { txHash: hash } });
  }
  return json({ code: 404, msg: `fake relayer: ${method} ${p}` }, 404);
}

function installFake() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const text = typeof init?.body === 'string' ? init.body : null;
    const body = text ? JSON.parse(text) : null;
    const chainId = CHAINS[`${url.origin}${url.pathname}`.replace(/\/+$/, '')];
    if (chainId) {
      const one = async (c: { id: number; method: string; params?: any[] }) => {
        try {
          return { jsonrpc: '2.0', id: c.id, result: await rpc(chainId, c.method, c.params ?? []) };
        } catch (e) {
          if (e instanceof assert.AssertionError) throw e;
          const err = e as { code?: number; message?: string };
          return { jsonrpc: '2.0', id: c.id, error: { code: err.code ?? -32000, message: err.message ?? String(e) } };
        }
      };
      return json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
    }
    if (url.origin === GW) return gateway(url, method, body);
    if (url.origin === BACKEND) return backend(url, method, body);
    if (url.origin === BIZ_ORIGIN) return relayer(url, method, body);
    throw new Error(`the fake has no ${url.origin}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONFIG = {
  acknowledgeRealFunds: true,
  maxSpendUsd: 12,
  startChain: 'ARBITRUM_ETH',
  deposit: { chain: 'ARBITRUM_ETH', amount: '25' },
  receivers: { valuechain: FRIEND },
  cleanup: { enabled: true, chain: 'ARBITRUM_ETH' },
  timeouts: { depositMinutes: 1, withdrawMinutes: 1, settleSeconds: 20, orderSeconds: 20 },
};

async function run(config: object, o: { confirm?: (address: string) => string; setup?: (w: World) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vs-e2e-sim-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(config));
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address.toLowerCase();
  world = new World();
  world.owner = address;
  world.arbUsdc.set(address, 30_000_000n);
  world.arbEth.set(address, 10n ** 16n);
  o.setup?.(world);
  installFake();
  const lines: string[] = [];
  const code = await runE2E({
    mode: 'live',
    configPath: cfgPath,
    confirm: o.confirm ? o.confirm(address) : address,
    only: null,
    keyHex: key,
    throwaway: false,
    registryOnly: false,
    reportDir: dir,
    backendOverride: BACKEND,
    log: (l) => lines.push(l),
  });
  const file = readdirSync(dir).find((f) => f.endsWith('-live.json'));
  const report = file ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : null;
  return { code, lines, report, address, key };
}

test('a whole live run against the fake: every step ok, no guard or wallet refusal, the money ends where the plan says', async () => {
  const { code, lines, report, address, key } = await run(CONFIG);
  const out = lines.join('\n');
  if (process.env.VS_SIM_VERBOSE) console.log(`${out}\n--- fake writes ---\n${world.writes.join('\n')}`);
  assert.equal(code, 0, `the run failed:\n${out.split('\n').filter((l) => /FAIL|BLOCKED|REFUSED|refused|Error|error/.test(l)).join('\n')}`);
  assert.deepEqual(
    report.steps.map((s: { id: string; status: string }) => `${s.id}:${s.status}`),
    ['preflight:ok', 'deposit-external:ok', 'enable-trading:ok', 'transfers:ok', 'orders:ok', 'spot-to-evm:ok', 'evm-to-spot:ok', 'withdraw-valuechain-self:ok', 'withdraw-valuechain-other:ok', 'withdraw-external:ok', 'extra-deposits:skipped', 'extra-withdrawals:ok', 'cleanup:ok'],
  );
  assert.equal(report.network.refused.length, 0, 'the guard refused nothing the app really sent');
  assert.ok(!/the test wallet REFUSED/.test(out), 'the wallet policy refused nothing');
  // Where the money went.
  assert.equal(world.aid, 777, 'the first deposit opened the account');
  assert.equal(world.tok(VC_USDC, FRIEND), 1_000_000n, 'withdraw-valuechain-other: 1 USDC reached the other address');
  assert.equal(world.arbEth.get(address), 10n ** 16n + 10n ** 15n, 'extra-withdrawals: 0.0015 ETH - 0.0005 fee arrived on Arbitrum');
  assert.equal(world.position, '0', 'flat');
  assert.equal(world.orders.length, 0, 'no open orders');
  assert.equal(world.perps, 0n, 'cleanup emptied Perps');
  assert.equal(world.tok(VC_USDC, address), 0n, 'cleanup emptied the ValueChain wallet\'s USDC');
  assert.equal(world.spot.get(0) ?? 0n, 0n, 'cleanup withdrew all Spot USDC');
  assert.ok(world.vcNative > 0n, 'SOSO for gas stayed in the wallet');
  assert.equal(world.permitNonce, 8n, 'three relayed withdrawals: withdraw-external, ETH, cleanup');
  assert.equal(world.depositNonce, 2n, 'two gasless wallet -> Spot deposits: evm-to-spot and cleanup');
  assert.equal(world.writes.filter((w) => w.startsWith('analyse_address')).length, 3, 'the address risk check before every custody withdrawal');
  assert.ok(world.writes.filter((w) => w.startsWith('analyse_address')).every((w) => w.endsWith(address)), 'always for this wallet (every receiver here is self)');
  assert.equal(world.writes.filter((w) => w.startsWith('valuechain USDC.approve') || w.startsWith('valuechain depositERC20')).length, 0, 'no gas-paying deposit transactions any more');
  // 30 USDC funded - 25 deposited + (5 - 1) withdraw-external + cleanup (all Spot - 1 fee).
  const arb = world.arbUsdc.get(address)!;
  assert.ok(arb > 5_000_000n + 4_000_000n + 10_000_000n && arb < 30_000_000n, `Arbitrum USDC at the end: ${formatUnits(arb, 6)}`);
  // The report is complete and carries no key.
  const text = JSON.stringify(report);
  assert.ok(!text.toLowerCase().includes(key.slice(2).toLowerCase()), 'the report does not contain the key');
  assert.ok(report.steps.find((s: { id: string }) => s.id === 'deposit-external').txs.length >= 1, 'the deposit tx is recorded');
  assert.ok(report.spend.costUsd > 0 && report.spend.costUsd < CONFIG.maxSpendUsd);
  assert.equal(report.spend.sentAwayUsd, 1);
  assert.ok(world.writes.some((w) => w.startsWith('arbitrum transfer 25000000 -> ' + DEPOSIT_ADDR)), 'the deposit went to the verified address');
});

test('live refuses to start - nothing is signed or sent - when the backend and the on-chain registry disagree on the deposit address', async () => {
  const { code, lines } = await run(CONFIG, { setup: (w) => (w.registryAddress = '0x000000000000000000000000000000000000dead') });
  assert.equal(code, 2);
  // The app cross-checks the address against the registry itself now (exchange/deposits.ts), so it
  // withholds the address before the runner's own independent comparison even runs.
  assert.ok(lines.some((l) => /disagree|not this coin's registered address/.test(l)), 'says why');
  assert.deepEqual(world.writes, [], 'no write of any kind reached the fake');
});

test('live refuses without --confirm equal to the wallet address, or without acknowledgeRealFunds', async () => {
  const wrong = await run(CONFIG, { confirm: () => '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd' });
  assert.equal(wrong.code, 2);
  assert.ok(wrong.lines.some((l) => /REFUSED: --confirm/.test(l)));
  assert.deepEqual(world.writes, []);
  const noAck = await run({ ...CONFIG, acknowledgeRealFunds: false });
  assert.equal(noAck.code, 2);
  assert.ok(noAck.lines.some((l) => /acknowledgeRealFunds/.test(l)));
  assert.deepEqual(world.writes, []);
});
