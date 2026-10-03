/**
 * The offline stand-in for everything a live run talks to - for simulate.test.ts.
 * Test support, not a test: nothing here runs on its own.
 *
 *   SoDEX's gateway   both engines: every order type the runner places (limit
 *                     GTC / IOC / post-only, market by quantity and by funds,
 *                     reduce-only, stand-alone and attached TP/SL), cancels,
 *                     cancel-all, replace (new order id) and modify (same id),
 *                     leverage and margin mode, isolated margin, the dead-man
 *                     switch, transfers, key registration AND revocation, the
 *                     builder approval, fills with SoDEX's commission and the
 *                     builder fee (perps both sides, spot sells only), order
 *                     records that name the builder while OPEN and not once
 *                     finished (as on mainnet), the order history and fills,
 *                     fee rates, the builder account's balances.
 *   its account stream  accountOrderUpdate / accountTrade pushes per engine.
 *   the backend       health, ValueChain parameters, deposit options, and the
 *                     builder-terms route, signed with the TEST key of the
 *                     shared vector (seed 00..1f), its volume counted from this
 *                     fake's own fills the way docs/BUILDER-TIERS.md section 5 says.
 *   the relayer, every chain's JSON-RPC node.
 *
 * Strict where SoDEX is: every key-signed action must recover the trading key
 * registered on THAT engine under the name it sends (a revoked key cannot sign
 * anything), master-wallet actions must recover the wallet (viem - shares no
 * code with sodex-core), an order naming a builder the account has not
 * approved for that fee is rejected.
 */
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, hashTypedData, keccak256, parseAbi, parseAbiParameters, parseTransaction, recoverAddress, recoverTransactionAddress, recoverTypedDataAddress, stringToHex, toFunctionSelector, zeroAddress, type Hex } from 'viem';
import { CALL_FOR_PERMIT_CONTRACT, CLOB_GATEWAY, WITHDRAWAL_CREATED_TOPIC, WITHDRAW_TOKEN_TARGET } from '@sodex-core';
import { gateway as exchangeGateway } from '../../../src/exchange/sodexGateway';
import type { SocketLike } from '../../../src/exchange/ws/sodexSocket';
import { formatUnits, parseUnits } from '../../../src/trading/onboard';
import { BIZ_ORIGIN, QUERY_CONTRACT } from '../../../src/trading/relay';
import { DEPOSIT_WALLET_REGISTRY } from '../reads';
import { termsMessage } from '../terms';
import { cut, dAdd, dCmp, dDiv, dMul, dSub, toStep } from '../util';

export const GW = 'https://mainnet-gw.sodex.dev';
export const BACKEND = 'http://127.0.0.1:5999';
export const BUILDER_ADDRESS = '0x00000000000000000000000000000000000b1d00';
/** The shared Ed25519 TEST vector (apps/server/test/builderTerms.vector.json): seed 00 01 ... 1f. */
export const TERMS_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
export const TERMS_PUBLIC_KEY = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
export const TERMS_KEY_ID = '56475aa7';

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
export const VC_USDC = '0xcb7f80dff2727c791fa491722c428e6657f7e2c6';
const VC_ETH = '0xd76544025769c13496bf4a6c2b4e67ead3f857d8';
export const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const EXCHANGE = '0x0101010101010101010101010101010101010101';
export const DEPOSIT_ADDR = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
export const FRIEND = '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd';
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

export const COINS: Record<number, { asset: string; dp: number; token: string | null }> = {
  0: { asset: 'vUSDC', dp: 6, token: VC_USDC },
  2: { asset: 'vETH', dp: 18, token: VC_ETH },
  4: { asset: 'WSOSO', dp: 18, token: null },
};
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
export const spotSymbols = [
  { id: 4, name: 'WSOSO_vUSDC', displayName: 'SOSO/USDC', baseCoin: 'WSOSO', baseCoinID: 4, quoteCoin: 'vUSDC', quoteCoinID: 0, pricePrecision: 4, tickSize: '0.0001', quantityPrecision: 2, stepSize: '0.01', minQuantity: '0.01', marketMinQuantity: '0.01', minNotional: '1', maxNotional: '0', minPrice: '0.0001', maxPrice: '0', makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING', sellLimitDownRatio: '0.5', buyLimitUpRatio: '1' },
  { id: 2, name: 'vETH_vUSDC', displayName: 'ETH/USDC', baseCoin: 'vETH', baseCoinID: 2, quoteCoin: 'vUSDC', quoteCoinID: 0, pricePrecision: 1, tickSize: '0.1', quantityPrecision: 4, stepSize: '0.0001', minQuantity: '0.0001', marketMinQuantity: '0.0001', minNotional: '5', maxNotional: '0', minPrice: '0.1', maxPrice: '0', makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING', sellLimitDownRatio: '0.5', buyLimitUpRatio: '1' },
];
export const perpsSymbols = [
  { id: 1, name: 'BTC-USD', displayName: 'BTC-USD', baseCoin: 'BTC', quoteCoin: 'vUSDC', quoteCoinID: 0, pricePrecision: 0, tickSize: '1', quantityPrecision: 5, stepSize: '0.00001', minQuantity: '0.00001', marketMinQuantity: '0.00001', minNotional: '10', maxNotional: '4000000', minPrice: '1', maxPrice: '0', makerFee: '0.00012', takerFee: '0.0004', status: 'TRADING', sellLimitDownRatio: '0.05', buyLimitUpRatio: '0.05', initLeverage: 20, maxLeverage: 40 },
];
const BOOK: Record<string, { bid: string; ask: string }> = { WSOSO_vUSDC: { bid: '0.2996', ask: '0.3' }, vETH_vUSDC: { bid: '2689', ask: '2690' }, 'BTC-USD': { bid: '84071', ask: '84072' } };
const RATES = { spot: { maker: '0.00035', taker: '0.00065' }, perps: { maker: '0.00012', taker: '0.0004' } } as const;

type Engine = 'spot' | 'perps';
const TIF_NAME: Record<number, string> = { 1: 'GTC', 2: 'FOK', 3: 'IOC', 4: 'GTX' };

export interface FOrder {
  engine: Engine;
  orderID: number;
  clOrdID: string;
  symbolID: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  timeInForce: string;
  price: string | null;
  origQty: string | null;
  funds: string | null;
  executedQty: string;
  executedValue: string;
  status: string;
  builder: { builderID: number; feeRate: number } | null;
  reduceOnly: boolean;
  stopPrice: string | null;
  stopType: 'STOP_LOSS' | 'TAKE_PROFIT' | null;
  triggerType: string | null;
  modifier: number;
  primaryOrderID: number | null;
  createdAt: number;
  updatedAt: number;
  /** Spot: what a resting order holds back (quote for a buy, base for a sell), base units. */
  locked: bigint;
  /** The key that signed it (lower-case) and under which name. */
  signer: string;
  keyName: string;
}

export interface FTrade {
  engine: Engine;
  tradeID: number;
  orderID: number;
  clOrdID: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  quantity: string;
  fee: string;
  builderFee: string;
  feeCoin: string;
  isMaker: boolean;
  time: number;
}

interface FPosition {
  size: string;
  entry: string;
  mode: 'CROSS' | 'ISOLATED';
  lev: number;
  margin: string;
}

interface Key {
  name: string;
  publicKey: string;
  expiresAt: number;
}

/** Fake WebSockets (one per engine connection the runner's stream opens). */
export class FakeWs implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly engine: Engine;
  readonly channels = new Set<string>();
  constructor(
    readonly url: string,
    private readonly world: World,
  ) {
    this.engine = /\/ws\/spot$/.test(url) ? 'spot' : 'perps';
    world.sockets.add(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }
  send(data: string): void {
    const m = JSON.parse(data) as { op?: string; params?: { channel?: string; user?: string } };
    if (m.op === 'ping') return this.deliver({ op: 'pong' });
    if (m.op === 'subscribe' && m.params?.channel) {
      assert.equal(m.params.user, this.world.owner, 'the stream subscribes for this wallet only');
      this.channels.add(m.params.channel);
      this.deliver({ op: 'subscribe', success: true, connID: 1 });
    }
  }
  deliver(msg: unknown): void {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(msg) }));
  }
  close(): void {
    this.readyState = 3;
    this.world.sockets.delete(this);
  }
}

/** The fake SoDEX + backend + chains, with balances in exact base units. */
export class World {
  owner = '';
  aid = 0;
  spot = new Map<number, bigint>();
  locked = new Map<number, bigint>();
  /** Perps wallet balance (USDC, 6 dp, as a decimal string). */
  perpsWb = '0';
  positions = new Map<string, FPosition>();
  symbolCfg = new Map<string, { l: number; m: 'CROSS' | 'ISOLATED' }>();
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
  orders: FOrder[] = [];
  trades: FTrade[] = [];
  keys: Record<Engine, Key[]> = { spot: [], perps: [] };
  /** Builder approvals per engine (builder id -> approved rate), as GET /user/{wallet}/builders lists them. */
  builders = { spot: new Map<number, number>(), perps: new Map<number, number>() };
  /** The builder account's vUSDC per engine (decimal strings), starting at 100. */
  builderBalance: Record<Engine, string> = { spot: '100', perps: '100' };
  builderId = 0;
  /** Who each signature recovered to (viem): builder approvals, key registrations and revocations, orders. */
  signers = { approvals: [] as string[], registrations: [] as string[], revocations: [] as string[], orders: [] as string[] };
  approvalBodies: string[] = [];
  orderBodies: Array<{ engine: Engine; raw: string }> = [];
  /** Mined transactions (wallet-sent and relayed) and their logs. */
  receipts = new Map<string, Array<{ address: string; topics: string[]; data: string }>>();
  txCount = new Map<number, number>();
  nextId = 1000;
  nextTrade = 1;
  writes: string[] = [];
  schedule: Partial<Record<Engine, number>> = {};
  sockets = new Set<FakeWs>();
  /** Every read of the two rate-limited history routes: when, which. */
  historyReads: Array<{ at: number; path: string }> = [];
  /** Requests the fake refused (with why), for the test's own assertions. */
  refused: string[] = [];

  // --- switches a test sets -------------------------------------------------------------------
  registryAddress = DEPOSIT_ADDR;
  /** Does a replaced / modified order keep the original's builder? */
  replaceKeepsBuilder = false;
  modifyKeepsBuilder = true;
  /** The builder-terms route: null = the feature is off (`builderId: null`). */
  tiers: { builderId: number; tiers: Array<{ minVolumeUsd: number; perps: number; spot: number }>; policy: 'default-fee' | 'ignore'; ttl: number } | null = null;
  /** How long after a hint the verification takes (ms). */
  verifyDelayMs = 30;

  // --- the terms stand-in's books ------------------------------------------------------------------
  termsKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(TERMS_SEED_HEX, 'hex')]), format: 'der', type: 'pkcs8' });
  hintAt: number | null = null;
  verified: { perpsUsd: string; spotUsd: string; at: number; flags: string[] } | null = null;
  /** The fee the server signed, each time it changed (the fee owed over time). */
  feeRows: Array<{ at: number; perps: number; spot: number }> = [];
  termsAnswers: Array<{ at: number; hint: boolean; fee: { perps: number; spot: number } | null; flags: string[]; pending: boolean }> = [];

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
  lock(coin: number, d: bigint): void {
    const v = (this.locked.get(coin) ?? 0n) + d;
    assert.ok(v >= 0n, `negative lock of coin ${coin}`);
    this.locked.set(coin, v);
  }
  add(map: Map<string, bigint>, who: string, d: bigint): void {
    const v = (map.get(who.toLowerCase()) ?? 0n) + d;
    assert.ok(v >= 0n, 'negative balance');
    map.set(who.toLowerCase(), v);
  }
  get open(): FOrder[] {
    return this.orders.filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
  }
}

let world = new World();
export const currentWorld = (): World => world;
export function newWorld(owner: string): World {
  world = new World();
  world.owner = owner.toLowerCase();
  return world;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (data: unknown) => json({ code: 0, data, timestamp: Date.now() });
const fail = (code: number, error: string, status = 400) => {
  world.refused.push(error);
  return json({ code, error }, status);
};
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const usdcUnits = (v: string): bigint => parseUnits(cut(v, 6) || '0', 6);
const dpUnits = (v: string, dp: number): bigint => parseUnits(cut(v, dp) || '0', dp);
const abs = (v: string): string => (v.startsWith('-') ? v.slice(1) : v);
const mid = (s: string): string => dDiv(dAdd(BOOK[s]!.bid, BOOK[s]!.ask), '2');

// --- the chains --------------------------------------------------------------------------------------

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

// --- the engines: state as SoDEX lists it -----------------------------------------------------------

const orderRow = (o: FOrder, withBuilder: boolean): Record<string, unknown> => ({
  orderID: o.orderID,
  clOrdID: o.clOrdID,
  symbolID: o.symbolID,
  symbol: o.symbol,
  side: o.side,
  type: o.type,
  timeInForce: o.timeInForce,
  ...(o.price !== null ? { price: o.price } : {}),
  ...(o.origQty !== null ? { origQty: o.origQty } : {}),
  ...(o.funds !== null ? { funds: o.funds } : {}),
  executedQty: o.executedQty,
  executedValue: o.executedValue,
  status: o.status,
  // As on mainnet: an OPEN order names its builder; a finished one in the history does not.
  ...(withBuilder && o.builder ? { builder: o.builder } : {}),
  ...(o.engine === 'perps'
    ? { reduceOnly: o.reduceOnly, positionSide: 'BOTH', ...(o.stopPrice ? { stopPrice: o.stopPrice, stopType: o.stopType, triggerType: o.triggerType } : {}), ...(o.primaryOrderID ? { primaryOrderID: o.primaryOrderID } : {}) }
    : {}),
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

/** The stream's order update (schema WsSpotOrderUpdate / WsPerpsOrderUpdate). */
const orderPush = (o: FOrder): Record<string, unknown> => ({
  i: o.orderID,
  c: o.clOrdID,
  s: o.symbol,
  S: o.side,
  o: o.type,
  f: o.timeInForce,
  X: o.status,
  ...(o.price !== null ? { p: o.price } : {}),
  ...(o.origQty !== null ? { q: o.origQty } : {}),
  z: o.executedQty,
  v: o.executedValue,
  ...(o.builder ? { b: { i: o.builder.builderID, f: o.builder.feeRate } } : {}),
  ...(o.stopPrice ? { sp: o.stopPrice } : {}),
  E: Date.now(),
});

function push(engine: Engine, channel: 'accountOrderUpdate' | 'accountTrade', data: unknown[]): void {
  for (const s of world.sockets) if (s.engine === engine && s.channels.has(channel)) s.deliver({ channel, type: 'update', data });
}
const update = (o: FOrder): void => {
  o.updatedAt = Date.now();
  push(o.engine, 'accountOrderUpdate', [orderPush(o)]);
};

/** Margin a perps market ties up: positions (isolated: their margin; cross: notional / leverage) and resting orders. */
function perpsUsed(): string {
  let used = '0';
  for (const [, p] of world.positions) {
    if (dCmp(p.size, '0') === 0) continue;
    used = dAdd(used, p.mode === 'ISOLATED' ? p.margin : dDiv(dMul(abs(p.size), p.entry), String(p.lev)));
  }
  for (const o of world.open) {
    if (o.engine !== 'perps' || o.stopPrice || o.reduceOnly || !o.price || !o.origQty) continue;
    const lev = world.symbolCfg.get(o.symbol)?.l ?? 20;
    used = dAdd(used, dDiv(dMul(o.price, o.origQty), String(lev)));
  }
  return used;
}
const perpsAvailable = (): string => {
  const v = dSub(world.perpsWb, perpsUsed());
  return dCmp(v, '0') > 0 ? cut(v, 6) || '0' : '0';
};

function spotState() {
  const B = [...world.spot.entries()].map(([i, v]) => ({ i, a: COINS[i]!.asset, t: formatUnits(v, COINS[i]!.dp), l: formatUnits(world.locked.get(i) ?? 0n, COINS[i]!.dp) }));
  return { aid: world.aid, B, O: world.open.filter((o) => o.engine === 'spot').map((o) => ({ s: o.symbol, i: o.orderID, c: o.clOrdID })) };
}
function perpsState() {
  const P = [...world.positions].filter(([, p]) => dCmp(p.size, '0') !== 0).map(([s, p]) => ({ s, sz: p.size, ur: '0', ep: p.entry, m: p.mode, iw: p.mode === 'ISOLATED' ? p.margin : null, l: p.lev }));
  return {
    aid: world.aid,
    amw: perpsAvailable(),
    B: world.aid ? [{ i: 0, a: 'vUSDC', wb: cut(world.perpsWb, 6) || '0', at: perpsAvailable() }] : [],
    P,
    O: world.open.filter((o) => o.engine === 'perps').map((o) => ({ s: o.symbol, i: o.orderID, c: o.clOrdID })),
    S: [...world.symbolCfg].map(([s, c]) => ({ s, l: c.l, m: c.m })),
  };
}

/** The dead-man switch: what is due has happened before anything is answered. */
function tick(): void {
  const now = Date.now();
  for (const engine of ['spot', 'perps'] as const) {
    const at = world.schedule[engine];
    if (at === undefined || at > now) continue;
    delete world.schedule[engine];
    for (const o of world.open.filter((x) => x.engine === engine)) finish(o, 'CANCELED');
    world.writes.push(`schedule-cancel fired on ${engine}`);
  }
}

/** An order leaves the book: its lock is released, the stream is told. */
function finish(o: FOrder, status: string): void {
  if (o.engine === 'spot' && o.locked > 0n) {
    world.lock(o.side === 'BUY' ? 0 : spotSymbols.find((s) => s.name === o.symbol)!.baseCoinID, -o.locked);
    o.locked = 0n;
  }
  o.status = status;
  update(o);
}

// --- fills ----------------------------------------------------------------------------------------------

/** One fill: SoDEX's commission at the account's rate, the builder fee where it is charged, the balances, the stream. */
function fill(o: FOrder, qty: string, price: string, isMaker: boolean): void {
  const w = world;
  const notional = dMul(qty, price);
  const rate = RATES[o.engine][isMaker ? 'maker' : 'taker'];
  const builderDue = !!o.builder && o.builder.feeRate > 0 && (o.engine === 'perps' || o.side === 'SELL');
  const builderFee = builderDue ? cut(dMul(notional, dDiv(String(o.builder!.feeRate), '100000')), 6) || '0' : '0';
  let fee: string;
  let feeCoin: string;
  if (o.engine === 'spot') {
    const sym = spotSymbols.find((s) => s.name === o.symbol)!;
    const base = sym.baseCoinID;
    const bdp = COINS[base]!.dp;
    if (o.side === 'BUY') {
      const commission = cut(dMul(qty, rate), bdp) || '0';
      fee = commission;
      feeCoin = sym.baseCoin;
      const paid = usdcUnits(notional) + (dCmp(dMul(qty, price), cut(notional, 6) || '0') > 0 ? 1n : 0n);
      if (o.locked > 0n) {
        const release = paid < o.locked ? paid : o.locked;
        w.lock(0, -release);
        o.locked -= release;
      }
      w.addSpot(0, -paid);
      w.addSpot(base, dpUnits(dSub(qty, commission), bdp));
    } else {
      const commission = cut(dMul(notional, rate), 6) || '0';
      fee = dAdd(commission, builderFee);
      feeCoin = 'vUSDC';
      const units = dpUnits(qty, bdp);
      if (o.locked > 0n) {
        const release = units < o.locked ? units : o.locked;
        w.lock(base, -release);
        o.locked -= release;
      }
      w.addSpot(base, -units);
      w.addSpot(0, usdcUnits(dSub(notional, fee)));
    }
  } else {
    const commission = cut(dMul(notional, rate), 6) || '0';
    fee = dAdd(commission, builderFee);
    feeCoin = 'vUSDC';
    w.perpsWb = dSub(w.perpsWb, fee);
    // The position, with realised PnL on what it reduces.
    const p = w.positions.get(o.symbol) ?? { size: '0', entry: '0', mode: w.symbolCfg.get(o.symbol)?.m ?? 'CROSS', lev: w.symbolCfg.get(o.symbol)?.l ?? 20, margin: '0' };
    const signed = o.side === 'BUY' ? qty : `-${qty}`;
    const same = dCmp(p.size, '0') === 0 || (dCmp(p.size, '0') > 0) === (o.side === 'BUY');
    if (same) {
      const newSize = dAdd(p.size, signed);
      p.entry = dCmp(p.size, '0') === 0 ? price : dDiv(dAdd(dMul(abs(p.size), p.entry), dMul(qty, price)), abs(newSize));
      p.size = newSize;
      p.mode = w.symbolCfg.get(o.symbol)?.m ?? 'CROSS';
      p.lev = w.symbolCfg.get(o.symbol)?.l ?? 20;
      if (p.mode === 'ISOLATED') p.margin = dAdd(p.margin, cut(dDiv(notional, String(p.lev)), 6) || '0');
    } else {
      const closing = dCmp(qty, abs(p.size)) <= 0 ? qty : abs(p.size);
      const pnl = dMul(dMul(dSub(price, p.entry), closing), dCmp(p.size, '0') > 0 ? '1' : '-1');
      w.perpsWb = dAdd(w.perpsWb, cut(pnl, 6) || '0');
      const before = abs(p.size);
      p.size = dAdd(p.size, signed);
      if (p.mode === 'ISOLATED' && dCmp(before, '0') > 0) p.margin = dCmp(p.size, '0') === 0 ? '0' : dSub(p.margin, dDiv(dMul(p.margin, closing), before));
    }
    w.positions.set(o.symbol, p);
  }
  if (builderDue) w.builderBalance[o.engine] = dAdd(w.builderBalance[o.engine], builderFee);
  o.executedQty = dAdd(o.executedQty, qty);
  o.executedValue = dAdd(o.executedValue, notional);
  const t: FTrade = { engine: o.engine, tradeID: w.nextTrade++, orderID: o.orderID, clOrdID: o.clOrdID, symbol: o.symbol, side: o.side, price, quantity: qty, fee, builderFee, feeCoin, isMaker, time: Date.now() };
  w.trades.push(t);
  push(o.engine, 'accountTrade', [{ t: t.tradeID, s: t.symbol, i: t.orderID, c: t.clOrdID, S: t.side, p: t.price, q: t.quantity, f: t.fee, bf: t.builderFee, m: t.isMaker, T: t.time }]);
  // A position that went flat takes its attached exits with it.
  if (o.engine === 'perps' && dCmp(w.positions.get(o.symbol)?.size ?? '0', '0') === 0) {
    for (const x of w.open.filter((y) => y.engine === 'perps' && y.symbol === o.symbol && y.primaryOrderID !== null)) finish(x, 'CANCELED');
  }
}

/** A trigger that would fire at the current mark price (a hair of tolerance: the run places one "at the market"). */
function triggered(o: FOrder): boolean {
  if (!o.stopPrice) return false;
  const mark = mid(o.symbol);
  const up = (o.stopType === 'TAKE_PROFIT') === (o.side === 'SELL');
  return up ? dCmp(o.stopPrice, dMul(mark, '1.0005')) <= 0 : dCmp(o.stopPrice, dMul(mark, '0.9995')) >= 0;
}

/** Execute an order now as a taker, as far as the account allows. */
function execute(o: FOrder): void {
  const book = BOOK[o.symbol]!;
  const px = o.side === 'BUY' ? book.ask : book.bid;
  let qty = o.origQty;
  if (!qty && o.funds) {
    const sym = spotSymbols.find((s) => s.name === o.symbol)!;
    qty = toStep(dDiv(o.funds, px), sym.stepSize, 'floor');
  }
  if (o.engine === 'perps' && o.reduceOnly) {
    const pos = world.positions.get(o.symbol)?.size ?? '0';
    qty = dCmp(qty!, abs(pos)) <= 0 ? qty : abs(pos);
  }
  fill(o, qty!, px, false);
  o.status = 'FILLED';
  update(o);
}

// --- signatures ------------------------------------------------------------------------------------------

const UNIVERSAL = (chainId: number) => ({ name: 'universal', version: '1', chainId, verifyingContract: zeroAddress }) as const;
/** A SoDEX wire signature (type byte || r || s || v) as the 65 bytes viem recovers from. */
function rsv(wire: string, type: 1 | 2): Hex {
  assert.match(wire, /^0x[0-9a-f]{132}$/, 'a 66-byte wire signature');
  assert.equal(wire.slice(2, 4), `0${type}`, `signature type byte 0x0${type}`);
  assert.ok(wire.endsWith('00') || wire.endsWith('01'), 'v is normalised to 0/1');
  return `0x${wire.slice(4)}`;
}

/** Who signed an exchange action: ExchangeAction{keccak({type, params: <params bytes>}), nonce} under the engine's domain. */
async function exchangeSigner(engine: Engine, type: string, paramsJson: string, nonce: string, signature: string): Promise<string> {
  const hash = hashTypedData({
    domain: { name: engine === 'perps' ? 'futures' : 'spot', version: '1', chainId: 286623, verifyingContract: zeroAddress },
    types: { ExchangeAction: [{ name: 'payloadHash', type: 'bytes32' }, { name: 'nonce', type: 'uint64' }] },
    primaryType: 'ExchangeAction',
    message: { payloadHash: keccak256(stringToHex(`{"type":"${type}","params":${paramsJson}}`)), nonce: BigInt(nonce) },
  });
  return (await recoverAddress({ hash, signature: rsv(signature, 1) })).toLowerCase();
}

/**
 * A key-signed action: its signature must recover the trading key registered on THIS engine under the
 * name it sends. A revoked key is unknown: SoDEX's words for that are "API key not found".
 */
async function keyCheck(engine: Engine, type: string, raw: string, h: Record<string, string>): Promise<{ key: Key } | { refuse: Response }> {
  const key = world.keys[engine].find((k) => k.name === h['x-api-key']);
  const signer = await exchangeSigner(engine, type, raw, h['x-api-nonce']!, h['x-api-sign']!);
  if (!key || signer !== key.publicKey.toLowerCase()) return { refuse: fail(401, `${engine}: API key error: API key not found`, 401) };
  return { key };
}

// --- the terms stand-in -------------------------------------------------------------------------------------

/** The fee in force for the wallet at a moment: the last one signed, else the default. */
function feeAt(at: number): { perps: number; spot: number } {
  const d = world.tiers!.tiers[0]!;
  const row = [...world.feeRows].reverse().find((r) => r.at <= at);
  return row ? { perps: row.perps, spot: row.spot } : { perps: d.perps, spot: d.spot };
}
/** The fee owed when an order was created: the lowest in force from t - grace to t + 2 minutes (docs/BUILDER-TIERS.md section 5). */
function owedAt(engine: Engine, t: number): number {
  const grace = world.tiers!.ttl + 120_000;
  const from = t - grace;
  const to = t + 120_000;
  const fees = [feeAt(from), ...world.feeRows.filter((r) => r.at > from && r.at <= to)].map((f) => f[engine]);
  return Math.min(...fees);
}

/** Verify the wallet's volume from the fake's own fills, as the server does from SoDEX's. */
function verify(): void {
  const w = world;
  const id = w.tiers!.builderId;
  let perps = '0';
  let spot = '0';
  const flags = new Set<string>();
  const byOrder = new Map(w.orders.map((o) => [`${o.engine}:${o.orderID}`, o]));
  for (const t of w.trades) {
    const o = byOrder.get(`${t.engine}:${t.orderID}`);
    if (!o) continue;
    const owed = owedAt(o.engine, o.createdAt);
    const ours = !!o.builder && o.builder.builderID === id;
    const appKey = /^valuescan-/.test(o.keyName);
    if (ours && o.builder!.feeRate < owed) flags.add('underpaid');
    if (appKey && (!ours || o.builder!.feeRate < owed) && (o.engine === 'perps' || o.side === 'SELL')) flags.add('tampered');
    if (/^(vs|tp|sl)-/.test(o.clOrdID) && dCmp(t.builderFee, '0') === 0 && (o.engine === 'perps' || o.side === 'SELL')) flags.add('no-builder');
    if (!ours || o.builder!.feeRate < owed || dCmp(t.builderFee, '0') === 0) continue;
    const n = dMul(t.price, t.quantity);
    if (t.engine === 'perps') perps = dAdd(perps, n);
    else spot = dAdd(spot, n);
  }
  w.verified = { perpsUsd: perps, spotUsd: spot, at: Date.now(), flags: ['underpaid', 'tampered', 'override', 'no-builder'].filter((f) => flags.has(f)) };
}

function terms(url: URL): Response {
  const w = world;
  const address = url.searchParams.get('address') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';
  const hint = url.searchParams.get('hint');
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || (hint !== null && hint !== '1')) return json({ ok: false, error: 'bad request' }, 400);
  const headers = { 'cache-control': 'no-store, no-transform' };
  if (!w.tiers) return json({ ok: true, builderId: null }, 200, headers);
  const now = Date.now();
  if (address.toLowerCase() === w.owner) {
    // A hint while a verification is already queued does not push it back.
    const queued = w.hintAt !== null && (w.verified === null || w.hintAt > w.verified.at);
    if (hint === '1' && !queued) w.hintAt = now;
    if (w.hintAt !== null && (w.verified === null || w.hintAt > w.verified.at) && now - w.hintAt >= w.verifyDelayMs) verify();
  }
  const mine = address.toLowerCase() === w.owner;
  const v = mine ? w.verified : null;
  const total = v ? dAdd(v.perpsUsd, v.spotUsd) : '0';
  const tiers = w.tiers.tiers;
  let index = 0;
  for (let i = 0; i < tiers.length; i++) if (dCmp(total, String(tiers[i]!.minVolumeUsd)) >= 0) index = i;
  const flagged = !!v && w.tiers.policy === 'default-fee' && (v.flags.includes('underpaid') || v.flags.includes('tampered'));
  const t = flagged ? tiers[0]! : tiers[index]!;
  const fee = { perps: t.perps, spot: t.spot };
  if (mine) {
    const last = w.feeRows.at(-1);
    if (!last || last.perps !== fee.perps || last.spot !== fee.spot) w.feeRows.push({ at: now, ...fee });
  }
  const pending = mine && w.hintAt !== null && (v === null || w.hintAt > v.at);
  const issued = now;
  const message = termsMessage({ chain: 286623, builderId: w.tiers.builderId, address: address.toLowerCase(), perps: fee.perps, spot: fee.spot, nonce, issued, ttl: w.tiers.ttl });
  const sig = edSign(null, Buffer.from(message, 'utf8'), w.termsKey).toString('base64url');
  const next = tiers[index + 1];
  w.termsAnswers.push({ at: now, hint: hint === '1', fee, flags: v?.flags ?? [], pending });
  return json(
    {
      ok: true,
      chain: 286623,
      builderId: w.tiers.builderId,
      address: address.toLowerCase(),
      fee,
      nonce,
      issued,
      ttl: w.tiers.ttl,
      keyId: TERMS_KEY_ID,
      sig,
      default: { perps: tiers[0]!.perps, spot: tiers[0]!.spot },
      volume: { perpsUsd: Number(v?.perpsUsd ?? 0), spotUsd: Number(v?.spotUsd ?? 0), totalUsd: Number(total), verifiedAt: v?.at ?? null, pending },
      tier: { index, next: next ? { atUsd: next.minVolumeUsd, fee: { perps: next.perps, spot: next.spot } } : null },
      flags: v?.flags ?? [],
    },
    200,
    headers,
  );
}

/** The public key the fake signs with: base64url of the raw 32 bytes (must equal the vector's). */
export function termsPublicKey(): string {
  const der = createPublicKey(world.termsKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

// --- the gateway ------------------------------------------------------------------------------------------------

const symById = (engine: Engine, id: number) => (engine === 'spot' ? spotSymbols : perpsSymbols).find((s) => s.id === id);

async function placeBatch(engine: Engine, body: any, raw: string, h: Record<string, string>): Promise<Response> {
  const w = world;
  const k = await keyCheck(engine, engine === 'perps' ? 'newOrder' : 'batchNewOrder', raw, h);
  if ('refuse' in k) return k.refuse;
  w.signers.orders.push(k.key.publicKey.toLowerCase());
  w.orderBodies.push({ engine, raw });
  const b = body.builder;
  if (b !== undefined) {
    assert.equal(Object.keys(body).at(-1), 'builder', 'builder is the last field of the batch');
    assert.deepEqual(Object.keys(b), ['id', 'fee'], 'id before fee');
    const approved = w.builders[engine].get(b.id);
    if (approved === undefined || b.fee > approved) return fail(400, 'builder fee is not approved');
  }
  const answers: unknown[] = [];
  let entry: FOrder | null = null;
  for (const [i, x] of (body.orders as any[]).entries()) {
    const symbolID = engine === 'spot' ? x.symbolID : body.symbolID;
    const sym = symById(engine, symbolID);
    if (!sym) {
      answers.push({ code: 400, clOrdID: x.clOrdID, error: 'unknown symbol' });
      continue;
    }
    const o: FOrder = {
      engine,
      orderID: w.nextId++,
      clOrdID: x.clOrdID,
      symbolID,
      symbol: sym.name,
      side: x.side === 1 ? 'BUY' : 'SELL',
      type: x.type === 2 ? 'MARKET' : 'LIMIT',
      timeInForce: TIF_NAME[x.timeInForce] ?? String(x.timeInForce),
      price: x.price ?? null,
      origQty: x.quantity ?? null,
      funds: x.funds ?? null,
      executedQty: '0',
      executedValue: '0',
      status: 'NEW',
      builder: b ? { builderID: b.id, feeRate: b.fee } : null,
      reduceOnly: x.reduceOnly === true,
      stopPrice: x.stopPrice ?? null,
      stopType: x.stopType === 2 ? 'TAKE_PROFIT' : x.stopType === 1 ? 'STOP_LOSS' : null,
      triggerType: x.triggerType === 2 ? 'MARK_PRICE' : x.triggerType === 1 ? 'LAST_PRICE' : x.triggerType === 3 ? 'INDEX_PRICE' : null,
      modifier: x.modifier ?? 1,
      primaryOrderID: i > 0 && entry ? entry.orderID : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      locked: 0n,
      signer: k.key.publicKey.toLowerCase(),
      keyName: k.key.name,
    };
    const reject = (why: string) => {
      o.status = 'REJECTED';
      w.orders.push(o);
      update(o);
      w.refused.push(why);
      answers.push({ code: 400, clOrdID: o.clOrdID, orderID: o.orderID, error: why });
    };
    const book = BOOK[sym.name]!;
    const pos = engine === 'perps' ? w.positions.get(sym.name)?.size ?? '0' : '0';
    if (o.timeInForce === 'FOK') {
      reject('time in force FOK is not supported yet');
      continue;
    }
    if (o.stopPrice && o.triggerType !== 'MARK_PRICE') {
      reject('only MARK_PRICE triggers are supported');
      continue;
    }
    if (o.reduceOnly && (dCmp(pos, '0') === 0 || (dCmp(pos, '0') > 0) === (o.side === 'BUY'))) {
      reject('reduce-only order would not reduce the position');
      continue;
    }
    const refPx = o.price ?? (o.side === 'BUY' ? book.ask : book.bid);
    const notional = o.origQty ? dMul(o.origQty, refPx) : o.funds ?? '0';
    if (!o.reduceOnly && !o.stopPrice && dCmp(notional, sym.minNotional) < 0) {
      reject(`order notional ${notional} below the minimum ${sym.minNotional}`);
      continue;
    }
    w.orders.push(o);
    answers.push({ code: 0, clOrdID: o.clOrdID, orderID: o.orderID });
    if (i === 0) entry = o;
    update(o);
    // Attached exits wait for the entry; a stop waits for its trigger.
    if (i > 0) continue;
    if (o.stopPrice) {
      if (triggered(o)) execute(o);
      continue;
    }
    if (o.type === 'MARKET') {
      execute(o);
      continue;
    }
    const crosses = o.side === 'BUY' ? dCmp(o.price!, book.ask) >= 0 : dCmp(o.price!, book.bid) <= 0;
    if (crosses && o.timeInForce === 'GTX') {
      finish(o, 'EXPIRED'); // post-only: it would take liquidity
      continue;
    }
    if (crosses) {
      execute(o);
      continue;
    }
    if (o.timeInForce === 'IOC') {
      finish(o, 'EXPIRED');
      continue;
    }
    if (engine === 'spot') {
      const base = (sym as (typeof spotSymbols)[number]).baseCoinID;
      o.locked = o.side === 'BUY' ? usdcUnits(dMul(o.price!, o.origQty!)) + 1n : dpUnits(o.origQty!, COINS[base]!.dp);
      const coin = o.side === 'BUY' ? 0 : base;
      if ((w.spot.get(coin) ?? 0n) - (w.locked.get(coin) ?? 0n) < o.locked) {
        o.locked = 0n;
        o.status = 'REJECTED';
        update(o);
        answers[answers.length - 1] = { code: 400, clOrdID: o.clOrdID, orderID: o.orderID, error: 'insufficient balance' };
        continue;
      }
      w.lock(coin, o.locked);
    }
  }
  return ok(answers);
}

function cancelBatch(engine: Engine, body: any): Response {
  const w = world;
  const out: unknown[] = [];
  for (const c of body.cancels as any[]) {
    const o = w.open.find((x) => x.engine === engine && ((c.orderID !== undefined && x.orderID === c.orderID) || (engine === 'perps' && c.clOrdID !== undefined && x.clOrdID === c.clOrdID) || (c.origClOrdID !== undefined && x.clOrdID === c.origClOrdID)));
    if (!o) {
      out.push({ code: 400, orderID: c.orderID, error: 'order not found' });
      continue;
    }
    finish(o, 'CANCELED');
    out.push({ code: 0, orderID: o.orderID, clOrdID: o.clOrdID });
  }
  return ok(out);
}

function replace(engine: Engine, body: any, key: Key): Response {
  const w = world;
  const out: unknown[] = [];
  for (const r of body.orders as any[]) {
    const o = w.open.find((x) => x.engine === engine && ((r.origOrderID !== undefined && x.orderID === r.origOrderID) || (r.origClOrdID !== undefined && x.clOrdID === r.origClOrdID)));
    if (!o || o.type !== 'LIMIT' || (o.timeInForce !== 'GTC' && o.timeInForce !== 'GTX') || o.stopPrice) {
      out.push({ code: 400, clOrdID: r.clOrdID, error: 'only resting GTC / GTX limit orders can be replaced' });
      continue;
    }
    const n: FOrder = { ...o, orderID: w.nextId++, clOrdID: r.clOrdID, price: r.price ?? o.price, origQty: r.quantity ?? o.origQty, executedQty: '0', executedValue: '0', status: 'NEW', builder: w.replaceKeepsBuilder ? o.builder : null, createdAt: Date.now(), locked: 0n, signer: key.publicKey.toLowerCase(), keyName: key.name };
    finish(o, 'REPLACED');
    if (engine === 'spot') {
      const base = spotSymbols.find((s) => s.name === n.symbol)!.baseCoinID;
      n.locked = n.side === 'BUY' ? usdcUnits(dMul(n.price!, n.origQty!)) + 1n : dpUnits(n.origQty!, COINS[base]!.dp);
      w.lock(n.side === 'BUY' ? 0 : base, n.locked);
    }
    w.orders.push(n);
    update(n);
    out.push({ code: 0, clOrdID: n.clOrdID, orderID: n.orderID });
  }
  return ok(out);
}

export async function gateway(url: URL, method: string, body: any, raw: string, h: Record<string, string>): Promise<Response> {
  const w = world;
  const p = url.pathname;
  let m: RegExpExecArray | null;
  // Minutes of a real run happen here in seconds: the app's per-IP weight budget (1200 a minute) is the
  // browser's protection of a real IP - it would only make this fake wait. It starts empty on every request.
  (exchangeGateway.budget as unknown as { mem: unknown[] }).mem = [];
  tick();
  if (method === 'GET') {
    if (p === '/api/v1/asset/config') {
      const name = url.searchParams.get('name');
      return ok(name ? assetConfig.filter((a) => a.assetName === name) : assetConfig);
    }
    if (p === '/api/v1/perps/markets/coins') return ok([{ name: 'vUSDC', precision: 6 }]);
    if (p === '/api/v1/spot/markets/symbols') return ok(spotSymbols);
    if (p === '/api/v1/perps/markets/symbols') return ok(perpsSymbols);
    if (p === '/api/v1/spot/markets/tickers') return ok(spotSymbols.map((s) => ({ symbol: s.name, lastPx: BOOK[s.name]!.ask })));
    if ((m = /^\/api\/v1\/(spot|perps)\/markets\/([^/]+)\/orderbook$/.exec(p))) {
      const bk = BOOK[m[2]!] ?? BOOK['BTC-USD']!;
      return ok({ bids: [[bk.bid, '100']], asks: [[bk.ask, '100']] });
    }
    if ((m = /^\/api\/v1\/user\/(0x[0-9a-f]{40})\/subaccounts$/.exec(p))) return w.aid && m[1] === w.owner ? ok({ userID: w.aid, primaryAccountID: w.aid, subaccounts: [] }) : json({ code: 1, error: 'user not found' });
    // The builder account's balances (public, by its address and account id).
    if ((m = /^\/api\/v1\/(spot|perps)\/accounts\/(0x[0-9a-f]{40})\/balances$/.exec(p)) && m[2] === BUILDER_ADDRESS) {
      assert.equal(url.searchParams.get('accountID'), String(w.builderId), 'the builder account is read by its id');
      return ok({ balances: [{ coin: 'vUSDC', total: w.builderBalance[m[1] as Engine] }] });
    }
    if ((m = /^\/api\/v1\/(spot|perps)\/accounts\/(0x[0-9a-f]{40})\/(.+)$/.exec(p))) {
      const engine = m[1] as Engine;
      const mine = m[2] === w.owner;
      const what = m[3]!;
      if (what === 'state') return ok(mine ? (engine === 'spot' ? spotState() : perpsState()) : { aid: 0 });
      if (what === 'api-keys') return ok(mine ? w.keys[engine] : []);
      if (what === 'fee-rate') return ok({ makerFeeRate: RATES[engine].maker, takerFeeRate: RATES[engine].taker });
      if (what === 'orders') {
        const sym = url.searchParams.get('symbol');
        return ok({ blockTime: 1, blockHeight: 1, orders: mine ? w.open.filter((o) => o.engine === engine && (!sym || o.symbol === sym)).map((o) => orderRow(o, true)) : [] });
      }
      if (what === 'positions' && engine === 'perps') {
        return ok({ positions: mine ? [...w.positions].filter(([, x]) => dCmp(x.size, '0') !== 0).map(([s, x], i) => ({ id: i + 1, symbol: s, size: x.size, avgEntryPrice: x.entry, leverage: x.lev, marginMode: x.mode, initialMargin: x.mode === 'ISOLATED' ? x.margin : dDiv(dMul(abs(x.size), x.entry), String(x.lev)) })) : [] });
      }
      if (what === 'orders/history' || what === 'trades') {
        w.historyReads.push({ at: Date.now(), path: `${engine}/${what}` });
        // A real run is its own process with minutes between reads; this one shares the app's 2-a-minute drip with
        // the next simulated run, so the drip starts empty after every read (the runner's own limiter is what is tested).
        (exchangeGateway.historyDrip as unknown as { mem: unknown[] }).mem = [];
        const since = Number(url.searchParams.get('startTime') ?? 0);
        if (what === 'trades') return ok(w.trades.filter((t) => t.engine === engine && t.time >= since).map((t) => ({ tradeID: t.tradeID, orderID: t.orderID, clOrdID: t.clOrdID, symbol: t.symbol, side: t.side, price: t.price, quantity: t.quantity, fee: t.fee, ...(dCmp(t.builderFee, '0') > 0 ? { builderFee: t.builderFee } : {}), feeCoin: t.feeCoin, isMaker: t.isMaker, time: t.time })));
        return ok(w.orders.filter((o) => o.engine === engine && o.createdAt >= since && o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED').map((o) => orderRow(o, false)));
      }
    }
    if (p === '/api/v1/user/withdraw/status') return ok({ records: [{ status: 'success' }] });
    if ((m = /^\/api\/v1\/user\/(0x[0-9a-f]{40})\/builders$/.exec(p))) {
      const rows = (list: Map<number, number>) => (m![1] === w.owner ? [...list].map(([builderID, feeRate]) => ({ userID: w.aid, builderID, feeRate })) : []);
      return ok({ spot: rows(w.builders.spot), perps: rows(w.builders.perps) });
    }
    return json({ code: 404, error: `fake gateway: GET ${p}` }, 404);
  }
  w.writes.push(`${method} ${p}`);
  if ((m = /^\/api\/v1\/(spot|perps)\/exchange$/.exec(p))) {
    const engine = m[1] as Engine;
    if (body.type === 'revokeAPIKey') {
      // The master wallet, under the ENGINE's domain on the SoDEX chain: ExchangeAction{revokeAPIKey}.
      const signer = await exchangeSigner(engine, 'revokeAPIKey', JSON.stringify(body.params), String(body.nonce), body.signature);
      w.signers.revocations.push(signer);
      if (signer !== w.owner) return fail(401, 'signature does not recover the account owner', 401);
      assert.deepEqual(Object.keys(body.params), ['accountID', 'name']);
      if (body.params.accountID !== w.aid) return fail(400, 'not this account');
      w.keys[engine] = w.keys[engine].filter((k) => k.name !== body.params.name);
      return ok(null);
    }
    assert.equal(body.type, 'addAPIKey');
    // The registration sodex.com itself sends: UserSignedAddAPIKeyAction, the WALLET's chain as the domain.
    const signer = (
      await recoverTypedDataAddress({
        domain: UNIVERSAL(body.signatureChainID),
        types: {
          UserSignedAddAPIKeyAction: [
            { name: 'chainID', type: 'uint64' }, { name: 'nonce', type: 'uint64' }, { name: 'accountID', type: 'uint64' }, { name: 'name', type: 'string' },
            { name: 'keyType', type: 'uint8' }, { name: 'publicKey', type: 'bytes' }, { name: 'expiresAt', type: 'uint64' },
          ],
        },
        primaryType: 'UserSignedAddAPIKeyAction',
        message: {
          chainID: 286623n, nonce: BigInt(body.nonce), accountID: BigInt(body.params.accountID), name: body.params.name,
          keyType: body.params.type, publicKey: body.params.publicKey, expiresAt: BigInt(body.params.expiresAt),
        },
        signature: rsv(body.signature, 2),
      })
    ).toLowerCase();
    if (signer !== w.owner) return fail(401, 'API key error: API key not found', 401);
    w.signers.registrations.push(signer);
    // A name registered again REPLACES the key under it.
    w.keys[engine] = [...w.keys[engine].filter((k) => k.name !== body.params.name), { name: body.params.name, publicKey: body.params.publicKey, expiresAt: body.params.expiresAt }];
    return ok(null);
  }
  if ((m = /^\/api\/v1\/user\/(0x[0-9a-f]{40})\/builders$/.exec(p)) && method === 'POST') {
    // ApproveBuilderFeeAction: domain chainId = X-API-Chain (the wallet's chain), message chainID = the SoDEX network id.
    assert.equal(raw, JSON.stringify({ accountID: body.accountID, builderID: body.builderID, maxFeeRate: body.maxFeeRate }), 'body {accountID, builderID, maxFeeRate}');
    assert.equal(h['x-api-key'], undefined, 'signed by the master wallet: no X-API-Key');
    const signer = (
      await recoverTypedDataAddress({
        domain: UNIVERSAL(Number(h['x-api-chain'])),
        types: {
          ApproveBuilderFeeAction: [
            { name: 'chainID', type: 'uint64' }, { name: 'nonce', type: 'uint64' }, { name: 'accountID', type: 'uint64' },
            { name: 'builderID', type: 'uint64' }, { name: 'maxFeeRate', type: 'uint64' },
          ],
        },
        primaryType: 'ApproveBuilderFeeAction',
        message: { chainID: 286623n, nonce: BigInt(h['x-api-nonce']!), accountID: BigInt(body.accountID), builderID: BigInt(body.builderID), maxFeeRate: BigInt(body.maxFeeRate) },
        signature: rsv(h['x-api-sign']!, 2),
      })
    ).toLowerCase();
    w.signers.approvals.push(signer);
    w.approvalBodies.push(raw);
    if (signer !== w.owner || m[1] !== w.owner) return fail(401, 'signature does not recover the account owner', 401);
    if (body.accountID !== w.aid) return fail(400, 'accountID must be the primary account ID');
    if (!Number.isInteger(body.maxFeeRate) || body.maxFeeRate < 0 || body.maxFeeRate > 2000) return fail(400, 'maxFeeRate out of range');
    for (const engine of ['spot', 'perps'] as const) {
      if (body.maxFeeRate === 0) w.builders[engine].delete(body.builderID);
      // As on mainnet: an approval above the perps cap (200) is stored as the cap.
      else w.builders[engine].set(body.builderID, engine === 'perps' ? Math.min(body.maxFeeRate, 200) : body.maxFeeRate);
    }
    return ok(null);
  }
  if ((m = /^\/api\/v1\/user\/(0x[0-9a-f]{40})\/evm-withdraw$/.exec(p))) return fail(400, 'the fake takes withdrawals through the relayer only');

  // Everything else is signed by the trading key.
  const keyed: Array<[RegExp, string, string]> = [
    [/^\/api\/v1\/(spot|perps)\/accounts\/transfers$/, 'POST', 'transferAsset'],
    [/^\/api\/v1\/(spot)\/trade\/orders\/batch$/, 'POST', 'batchNewOrder'],
    [/^\/api\/v1\/(spot)\/trade\/orders\/batch$/, 'DELETE', 'batchCancelOrder'],
    [/^\/api\/v1\/(perps)\/trade\/orders$/, 'POST', 'newOrder'],
    [/^\/api\/v1\/(perps)\/trade\/orders$/, 'DELETE', 'cancelOrder'],
    [/^\/api\/v1\/(spot|perps)\/trade\/orders\/replace$/, 'POST', 'replaceOrder'],
    [/^\/api\/v1\/(perps)\/trade\/orders\/modify$/, 'POST', 'modifyOrder'],
    [/^\/api\/v1\/(perps)\/trade\/leverage$/, 'POST', 'updateLeverage'],
    [/^\/api\/v1\/(perps)\/trade\/margin$/, 'POST', 'updateMargin'],
    [/^\/api\/v1\/(spot|perps)\/trade\/orders\/schedule-cancel$/, 'POST', 'scheduleCancel'],
  ];
  const route = keyed.find(([re, mm]) => mm === method && re.test(p));
  if (!route) return json({ code: 404, error: `fake gateway: ${method} ${p}` }, 404);
  const engine = route[0].exec(p)![1] as Engine;
  const type = route[2];
  if (type === 'newOrder' || type === 'batchNewOrder') return placeBatch(engine, body, raw, h);
  const k = await keyCheck(engine, type, raw, h);
  if ('refuse' in k) return k.refuse;
  switch (type) {
    case 'transferAsset': {
      const coin = body.coinID as number;
      const units = parseUnits(body.amount, COINS[coin]!.dp);
      if (body.type === 3) {
        w.addSpot(coin, -units);
        w.perpsWb = dAdd(w.perpsWb, body.amount);
      } else if (body.type === 5) {
        assert.ok(dCmp(perpsAvailable(), body.amount) >= 0, `perps overdrawn: ${body.amount} of ${perpsAvailable()}`);
        w.perpsWb = dSub(w.perpsWb, body.amount);
        w.addSpot(coin, units);
      } else if (body.type === 2) {
        w.addSpot(coin, -units);
        if (COINS[coin]!.token) w.addTok(COINS[coin]!.token!, w.owner, units);
        else w.vcNative += units;
      } else throw new Error(`transfer type ${body.type}`);
      return ok({ id: body.id });
    }
    case 'batchCancelOrder':
    case 'cancelOrder':
      return cancelBatch(engine, body);
    case 'replaceOrder':
      return replace(engine, body, k.key);
    case 'modifyOrder': {
      const o = w.open.find((x) => x.engine === 'perps' && ((body.orderID !== undefined && x.orderID === body.orderID) || (body.clOrdID !== undefined && x.clOrdID === body.clOrdID)));
      if (!o) return fail(400, 'order not found');
      if (!o.stopPrice) return fail(400, 'modify is for take-profit / stop-loss orders only');
      if (body.stopPrice) o.stopPrice = body.stopPrice;
      if (body.price) o.price = body.price;
      if (body.quantity) o.origQty = body.quantity;
      if (!w.modifyKeepsBuilder) o.builder = null;
      update(o);
      return ok({ orderID: o.orderID });
    }
    case 'updateLeverage': {
      const sym = symById('perps', body.symbolID)!;
      const mode = body.marginMode === 1 ? 'ISOLATED' : 'CROSS';
      const cur = w.symbolCfg.get(sym.name) ?? { l: 20, m: 'CROSS' as const };
      const busy = dCmp(w.positions.get(sym.name)?.size ?? '0', '0') !== 0 || w.open.some((o) => o.engine === 'perps' && o.symbol === sym.name);
      if (mode !== cur.m && busy) return fail(400, 'cannot change the margin mode with an open position or open orders');
      w.symbolCfg.set(sym.name, { l: body.leverage, m: mode });
      return ok(null);
    }
    case 'updateMargin': {
      const sym = symById('perps', body.symbolID)!;
      const pos = w.positions.get(sym.name);
      if (!pos || dCmp(pos.size, '0') === 0 || pos.mode !== 'ISOLATED') return fail(400, 'no isolated position');
      const next = dAdd(pos.margin, body.amount);
      if (dCmp(next, '0') <= 0) return fail(400, 'margin would go below zero');
      if (dCmp(body.amount, '0') > 0 && dCmp(perpsAvailable(), body.amount) < 0) return fail(400, 'insufficient available margin');
      pos.margin = next;
      return ok(null);
    }
    case 'scheduleCancel': {
      if (body.scheduledTimestamp === undefined) delete w.schedule[engine];
      else w.schedule[engine] = body.scheduledTimestamp;
      return ok(null);
    }
  }
  return json({ code: 404, error: `fake gateway: ${method} ${p}` }, 404);
}

// --- the backend ----------------------------------------------------------------------------------------------

function backend(url: URL, method: string, body: any): Response {
  const w = world;
  const p = url.pathname;
  if (p === '/api/health') return json({ ok: true, network: 'mainnet', chainId: 286623, mainnetWritesAllowed: true });
  if (p === '/api/deposit/chain') return json({ chainId: 286623, chainIdHex: '0x45f9f', name: 'ValueChain', rpcUrl: 'https://rpc.valuechain.xyz', explorerUrl: 'https://main-scan.valuechain.xyz', nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 }, exchange: EXCHANGE });
  if (p === '/api/vs/builder/terms' && method === 'GET') return terms(url);
  if (p === '/api/md/spot/symbols') return json({ symbols: spotSymbols });
  if (p === '/api/md/perps/symbols') return json({ symbols: perpsSymbols });
  if (p === '/api/md/spot/tickers') return json({ tickers: spotSymbols.map((s) => ({ symbol: s.name, lastPx: BOOK[s.name]!.ask })) });
  if (/^\/api\/md\/(spot|perps)\/orderbook$/.test(p)) {
    const bk = BOOK[url.searchParams.get('symbol') ?? ''] ?? BOOK['BTC-USD']!;
    return json({ book: { bids: [[bk.bid, '100']], asks: [[bk.ask, '100']] } });
  }
  if (p === '/api/mirror/deposit-options') {
    return json({ address: w.owner, assets: [{ symbol: 'USDC', routes: [{ chain: 'ARBITRUM_ETH', label: 'Arbitrum One', address: DEPOSIT_ADDR, custodian: 'Cobo', verified: true, isEvm: true }] }], rejected: [], allVerified: true, registry: {} });
  }
  if (p === '/api/deposit/prepare' && method === 'POST') return json({ error: 'the fake deposits from the wallet through the relayer only' }, 400);
  if (p.startsWith('/api/deposit/tx/')) return json({ hash: p.split('/').pop(), status: world.receipts.has(p.split('/').pop()!) ? 'success' : 'pending', explorerUrl: null });
  if (p === '/api/deposit/assets') return json({ assets: [], warnings: [], exchange: EXCHANGE, registered: w.aid > 0, accountId: w.aid || null, registrationNote: null });
  void body;
  return json({ error: `fake backend: ${method} ${p}` }, 404);
}

/** SoDEX's relayer (alpha-biz): maintenance, the address risk check, and call_for_permit executed at once. */
function relayer(url: URL, method: string, body: any): Response {
  const w = world;
  const p = url.pathname;
  if (method === 'GET' && p === '/biz/v1/ext-chain/maintenance') return json({ code: 0, data: [] });
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

/** Put the fake under the runner's guard: everything goes here, nothing leaves the process. */
export function installFake(): () => void {
  const realFetch = globalThis.fetch;
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
    if (url.origin === GW) {
      const headers = Object.fromEntries(new Headers(init?.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined)).entries());
      return gateway(url, method, body, text ?? '', headers);
    }
    if (url.origin === BACKEND) return backend(url, method, body);
    if (url.origin === BIZ_ORIGIN) return relayer(url, method, body);
    throw new Error(`the fake has no ${url.origin}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** The account stream's sockets, for the runner's test hook. */
export const fakeSocketFactory = (url: string): SocketLike => new FakeWs(url, world);
