/**
 * Deposits, withdrawals and transfers through trading/funds.ts, against a fake
 * wallet, a fake SoDEX gateway, a fake alpha-biz (sodex.com's relay, risk check
 * and maintenance) and a fake ValueChain whose CallForPermit checks what the
 * real one checks - the nonce lane, the deadline, BOTH signatures recovered to
 * the owner, the minimum, the balance, the blacklist, the bridge for bridged
 * coins:
 *   - EVM -> Spot for a token is gasless: two signatures, simulated, relayed
 *     through call_for_permit with exactly sodex.com's body; SOSO is one tx;
 *   - to the own ValueChain wallet: engine transfers only, no wallet prompt;
 *   - to another chain: every SoDEX refusal (maintenance, risk check, fee, reserve,
 *     blacklist) comes before anything moves; then Spot -> wallet, WAIT, ONE
 *     permit signature, simulated, relayed, tracked by the Withdrawer's record;
 *   - an unclear answer is never sent twice;
 *   - what ARRIVES against SoDEX's deposit minimum: refused for the own deposit
 *     address and for a SoDEX deposit address it would not credit (the custody
 *     contract's reverse map), a confirmation for any other address below it.
 *   npx tsx --test src/trading/funds.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector, type Hex } from 'viem';
import {
  CALL_FOR_PERMIT_CONTRACT,
  CLOB_GATEWAY,
  WITHDRAWAL_CREATED_TOPIC,
  WITHDRAW_TOKEN_TARGET,
  bytesToHex,
  generateTradingKey,
  getWithdrawalCallData,
  hashTypedData,
  hexToBytes,
  isBlacklistedCallData,
  nameCallData,
  nativeDepositCallData,
  permitNonceCall,
  prepareDepositPermit,
  prepareTokenPermit,
  prepareWithdrawPermit,
  recoverAddress,
  signTypedDataWithKey,
  tokenNoncesCallData,
  withdrawRequirementsCallData,
} from '@sodex-core';
import { MIRROR_REGISTRY } from '@sign/sodex/mirrorCore.js';
import { DEPOSIT_WALLET_REGISTRY } from '@sign/sodex/depositWalletsCore.js';
import { setTradingConfig } from './config';
import { erc20TransferData } from './onboard';
import { memoryVault } from './vault';
import { _resetTradingForTests, enableTrading } from './session';
import { QUERY_CONTRACT, _clearMaintenance } from './relay';
import {
  _clearPendingWithdrawals,
  balancesOf,
  depositFromWallet,
  memoProblem,
  planWithdraw,
  receiverProblem,
  toChecksumAddress,
  transferFunds,
  unitsDown,
  withdrawFunds,
  withdrawalProgress,
  type ChainRoute,
  type CoinConfig,
} from './funds';
import { receiverAccount, type ReceiverAccount } from '../components/funds/depositGuard';

const master = generateTradingKey();
const OWNER = master.address.toLowerCase();
const AID = 4242;
const GW = 'https://gw.test';
const BIZ = 'https://alpha-biz.sodex.dev';
const TOKEN_NAME = 'SoDexToken: USDC';
const NOW = () => BigInt(Math.floor(Date.now() / 1000));

const USDC: CoinConfig = {
  coin: 'USDC',
  asset: 'vUSDC',
  assetId: 0,
  valuechain: { token: '0xcb7F80Dff2727c791fA491722c428e6657f7e2c6', symbol: 'vUSDC', decimals: 6, native: false },
  chains: [],
};
const SOSO: CoinConfig = { ...USDC, coin: 'SOSO', asset: 'WSOSO', assetId: 4, valuechain: { token: '0x0000000000000000000000000000000000000000', symbol: 'SOSO', decimals: 18, native: true } };
const BASE: ChainRoute = {
  key: 'BASE_ETH', label: 'Base', addressKind: 'evm', memo: null, withdrawType: 0, tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', isNativeToken: false,
  deposit: { allowed: true, min: '5', etaSeconds: 120 },
  withdraw: { allowed: true, min: '5', fee: '1' },
};
const DEST = '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd';
const FRIEND = DEST;

// --- the fake world ------------------------------------------------------------------------

interface FakeWithdrawal { id: bigint; coinSymbol: string; chain: string; receiver: string; amount: bigint; memo: string; back: boolean; status: number; txHash: string }
let world = {
  spot: 0,
  perps: 0,
  /** The ValueChain wallet (whatever coin is asked for). */
  evm: 0,
  /** CallForPermit sequence numbers: lane 0 (withdrawals) and lane 2 (deposits); the token's own permit nonce. */
  nonce: 7n,
  depNonce: 0n,
  tokenNonce: 3n,
  fee: 1_000_000n,
  available: 10n ** 12n,
  blacklisted: false,
  minWithdraw: 5_000_000n,
  /** Force the next CallForPermit.execute to revert with this data (simulation and relay alike). */
  execRevert: null as string | null,
  maintenance: [] as unknown[],
  withdrawals: [] as FakeWithdrawal[],
  /** SoDexTokenCustody's reverse map: `${chain}|${exact stored string}` -> account. */
  depositAccounts: {} as Record<string, string>,
  /** The owner's own deposit addresses for USDC (registry getDepositWalletList), chain -> list. */
  ownDeposits: {} as Record<string, string[]>,
  /** The two registries do not answer. */
  registryDown: false,
};
/** What the next call_for_permit answers: normal; a 504 after it executed; a 504 without; a definite 400; accepted without a hash. */
let relayReply: 'ok' | '504' | '504-noexec' | '400' | 'nohash' = 'ok';
let analyseStatus = 200;
/** A literal perps state to answer with instead of the one built from `world`. */
let perpsState: Record<string, unknown> | null = null;
/** Requests that are not chain reads: the gateway, the backend, alpha-biz. */
let sent: Array<{ url: string; method: string; body: any }> = [];
/** Everything in order: sim:<cmd> (an eth_call of execute), relay:<cmd>, analyse, transfer:<type>, sign, tx. */
let events: string[] = [];
/** ValueChain batch reads (balances); `rpcDown` makes every ValueChain read fail. */
let rpcReads = 0;
let rpcDown = false;
/** Where each balance read fell among `sent` (the length of `sent` at that moment). */
let rpcAt: number[] = [];
/** Transactions the fake chain knows: their receipt, and a wallet tx's effect applied when it is mined. */
const txs = new Map<string, { kind: 'withdraw'; id: bigint } | { kind: 'deposit' } | { kind: 'wallet'; apply: () => void; applied: boolean }>();
let txCounter = 0;
const nextHash = () => '0x' + (++txCounter).toString(16).padStart(64, '0');

const micro = (n: number) => BigInt(Math.round(n * 1e6));
const sel = (sig: string) => toFunctionSelector(sig);
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const ERR = {
  nonce: sel('InvalidAccountNonce(address,uint256)'),
  sig: sel('ECDSAInvalidSignature()'),
  blacklisted: sel('WalletIsBlacklisted()'),
  min: sel('WithdrawAmountLessThanMinWithdrawAmount(uint256,uint256)'),
  custody: sel('CustodyDisabled()'),
  balance: sel('ERC20InsufficientBalance(address,uint256,uint256)'),
  tokenSigner: sel('ERC2612InvalidSigner(address,address)'),
};
const EXECUTE = parseAbi(['function execute(address to, string cmdType, bytes cmdData, uint256 nonce, uint256 deadline, bytes signature)']);
const CMD = [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'string' }, { type: 'bool' }] as const;
const DEP = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }] as const;
const FLASH = new Set(['MAG7.ssi', 'sMAG7.ssi', 'MEME.ssi', 'DEFI.ssi', 'USSI']);
const WTUPLE = ['uint256', 'string', 'string', 'address', 'string', 'uint256', 'uint256', 'string', 'uint256', 'uint256', 'string', 'uint8', 'string', 'bool', 'uint256', 'string'].map((type, i) => ({ type, name: `f${i}` }));
const encodeWithdrawal = (w: FakeWithdrawal): Hex =>
  encodeAbiParameters([{ type: 'tuple', components: WTUPLE }], [
    Object.fromEntries(
      [w.id, w.chain, '', OWNER, w.receiver, w.amount, world.fee, '', 1n, 0n, w.txHash, w.status, w.memo, w.back, 1n, w.coinSymbol].map((v, i) => [`f${i}`, v]),
    ) as never,
  ]);

const signedBy = (digest: string, signature: string): boolean => {
  try {
    return recoverAddress(hexToBytes(digest as Hex), hexToBytes(signature as Hex)).toLowerCase() === OWNER;
  } catch {
    return false;
  }
};

/** CallForPermit.execute as the contract runs it. `apply`: the relayer's real run (effects), else an eth_call. */
function execute(data: Hex, apply: boolean): { revert: string } | { txHash: string | null } {
  const { args } = decodeFunctionData({ abi: EXECUTE, data });
  const [to, cmdType, cmdData, nonce, deadline, signature] = args;
  if (world.execRevert) return { revert: world.execRevert };
  if (deadline <= NOW()) return { revert: ERR.sig };
  if (cmdType === 'WithdrawToken') {
    assert.equal(to.toLowerCase(), WITHDRAW_TOKEN_TARGET.toLowerCase(), 'a withdrawal is addressed to the Withdrawer');
    if (nonce !== world.nonce) return { revert: ERR.nonce + word(0n) + word(nonce) };
    const [coinSymbol, chain, receiver, amount, withdrawType, memo, back] = decodeAbiParameters(CMD, cmdData);
    const p = prepareWithdrawPermit({ owner: OWNER, coinSymbol, chain, receiver, amount, withdrawType, memo, failedBackToClob: back, nonce, deadline, chainId: 286623 });
    if (!signedBy(p.digest, signature)) return { revert: ERR.sig };
    if (world.blacklisted) return { revert: ERR.blacklisted };
    if (FLASH.has(coinSymbol) && withdrawType !== 1) return { revert: ERR.custody };
    if (amount < world.minWithdraw) return { revert: ERR.min + word(amount) + word(world.minWithdraw) };
    if (amount > micro(world.evm)) return { revert: ERR.balance + word(0n) + word(micro(world.evm)) + word(amount) };
    if (!apply) return { txHash: null };
    world.evm -= Number(amount) / 1e6;
    world.nonce += 1n;
    const id = 1000n + BigInt(world.withdrawals.length);
    world.withdrawals.push({ id, coinSymbol, chain, receiver, amount, memo, back, status: 0, txHash: '' });
    const hash = nextHash();
    txs.set(hash, { kind: 'withdraw', id });
    return { txHash: hash };
  }
  assert.equal(cmdType, 'DepositERC20WithPermit');
  assert.equal(to.toLowerCase(), CLOB_GATEWAY.toLowerCase(), 'a deposit is addressed to the exchange gateway');
  if (nonce !== ((2n << 64n) | world.depNonce)) return { revert: ERR.nonce + word(0n) + word(nonce) };
  const [token, amount, permitDeadline, v, r, s] = decodeAbiParameters(DEP, cmdData);
  assert.equal(permitDeadline, deadline, 'one deadline for both signatures, as sodex.com');
  const tp = prepareTokenPermit({ owner: OWNER, token, tokenName: TOKEN_NAME, amount, nonce: world.tokenNonce, deadline, chainId: 286623 });
  const tokenSig = bytesToHex(new Uint8Array([...hexToBytes(r), ...hexToBytes(s), v]));
  if (!signedBy(tp.digest, tokenSig)) return { revert: ERR.tokenSigner + word(0n) + word(0n) };
  const dp = prepareDepositPermit({ owner: OWNER, token, amount, deadline, tokenPermit: { digest: tp.digest, signature: tokenSig }, nonce, chainId: 286623 });
  if (!signedBy(dp.digest, signature)) return { revert: ERR.sig };
  if (amount > micro(world.evm)) return { revert: ERR.balance + word(0n) + word(micro(world.evm)) + word(amount) };
  if (!apply) return { txHash: null };
  world.evm -= Number(amount) / 1e6;
  world.spot += Number(amount) / 1e6;
  world.depNonce += 1n;
  world.tokenNonce += 1n;
  const hash = nextHash();
  txs.set(hash, { kind: 'deposit' });
  return { txHash: hash };
}

const S = {
  name: nameCallData().slice(0, 10),
  tokenNonces: tokenNoncesCallData(OWNER).slice(0, 10),
  cfpNonces: permitNonceCall(OWNER, 0n).slice(0, 10),
  requirements: withdrawRequirementsCallData('USDC', 'BASE_ETH', OWNER, 0).slice(0, 10),
  blacklist: isBlacklistedCallData('BASE_ETH', OWNER).slice(0, 10),
  getWithdrawal: getWithdrawalCallData(1n).slice(0, 10),
  execute: sel('execute(address,string,bytes,uint256,uint256,bytes)'),
  depositAccounts: sel('depositAccounts(string,string)'),
  depositWalletList: sel('getDepositWalletList(address,string)'),
};

/** One JSON-RPC call to the fake ValueChain. */
function chain(method: string, params: any[]): { result?: unknown; error?: { code: number; message: string; data?: string } } {
  if (method === 'eth_call') {
    const { to, data } = params[0] as { to: string; data: Hex };
    const s = data.slice(0, 10);
    const t = to.toLowerCase();
    if (t === USDC.valuechain.token.toLowerCase() && s === S.name) return { result: encodeAbiParameters([{ type: 'string' }], [TOKEN_NAME]) };
    if (t === USDC.valuechain.token.toLowerCase() && s === S.tokenNonces) return { result: '0x' + word(world.tokenNonce) };
    if (t === CALL_FOR_PERMIT_CONTRACT.toLowerCase() && s === S.cfpNonces) {
      const lane = BigInt('0x' + data.slice(74, 138));
      return { result: '0x' + word((lane << 64n) | (lane === 2n ? world.depNonce : lane === 0n ? world.nonce : 0n)) };
    }
    if (t === CALL_FOR_PERMIT_CONTRACT.toLowerCase() && s === S.execute) {
      const r = execute(data, false);
      events.push(`sim:${decodeFunctionData({ abi: EXECUTE, data }).args[1]}`);
      return 'revert' in r ? { error: { code: 3, message: 'execution reverted', data: r.revert } } : { result: '0x' };
    }
    if (t === QUERY_CONTRACT.toLowerCase() && s === S.requirements) {
      const REQ = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'string', 'string', 'address'].map((type) => ({ type }));
      return { result: encodeAbiParameters(REQ, [world.fee, micro(world.evm), world.available, 0n, 0n, 2n ** 256n - 1n, '', '', USDC.valuechain.token]) };
    }
    if (t === WITHDRAW_TOKEN_TARGET.toLowerCase() && s === S.blacklist) return { result: '0x' + word(world.blacklisted ? 1n : 0n) };
    if (t === WITHDRAW_TOKEN_TARGET.toLowerCase() && s === S.getWithdrawal) {
      const w = world.withdrawals.find((x) => x.id === BigInt('0x' + data.slice(10)));
      return w ? { result: encodeWithdrawal(w) } : { error: { code: 3, message: 'execution reverted' } };
    }
    if ((t === MIRROR_REGISTRY.toLowerCase() && s === S.depositAccounts) || (t === DEPOSIT_WALLET_REGISTRY.toLowerCase() && s === S.depositWalletList)) {
      if (world.registryDown) return { error: { code: -32000, message: 'header not found' } };
      if (s === S.depositAccounts) {
        // An exact string key, as the contract's mapping(string => mapping(string => address)).
        const [c, w] = decodeAbiParameters([{ type: 'string' }, { type: 'string' }], `0x${data.slice(10)}`);
        return { result: '0x' + word(BigInt(world.depositAccounts[`${c}|${w}`] ?? 0)) };
      }
      const [account, coin] = decodeAbiParameters([{ type: 'address' }, { type: 'string' }], `0x${data.slice(10)}`);
      const lists = account.toLowerCase() === OWNER && coin === 'USDC' ? Object.entries(world.ownDeposits) : [];
      return { result: encodeAbiParameters([{ type: 'string[]' }, { type: 'string[][]' }], [lists.map(([c]) => c), lists.map(([, l]) => l)]) };
    }
    throw new Error(`unexpected eth_call ${to} ${s}`);
  }
  if (method === 'eth_getTransactionReceipt') {
    const tx = txs.get(params[0]);
    if (!tx) return { result: null };
    if (tx.kind === 'wallet' && !tx.applied) {
      tx.apply();
      tx.applied = true;
    }
    const w = tx.kind === 'withdraw' ? world.withdrawals.find((x) => x.id === tx.id)! : null;
    return { result: { status: '0x1', logs: w ? [{ address: WITHDRAW_TOKEN_TARGET, topics: [WITHDRAWAL_CREATED_TOPIC], data: encodeWithdrawal(w) }] : [] } };
  }
  throw new Error(`unexpected rpc ${method}`);
}

const wallet = {
  chainId: 1,
  prompts: 0,
  typed: [] as any[],
  calls: [] as string[],
  /** Every eth_sendTransaction's params, in order. */
  txs: [] as any[],
  async request({ method, params }: { method: string; params?: any[] }) {
    this.calls.push(method);
    if (method === 'eth_chainId') return `0x${this.chainId.toString(16)}`;
    if (method === 'wallet_switchEthereumChain') {
      this.chainId = parseInt(params![0].chainId, 16);
      return null;
    }
    if (method === 'eth_sendTransaction') {
      this.prompts++;
      events.push('tx');
      const tx = params![0];
      this.txs.push(tx);
      assert.equal(this.chainId, 286623, 'sent on ValueChain');
      const hash = nextHash();
      const value = BigInt(tx.value ?? '0x0');
      txs.set(hash, {
        kind: 'wallet',
        applied: false,
        apply: () => {
          if (tx.to.toLowerCase() === CLOB_GATEWAY.toLowerCase()) {
            assert.equal(tx.data, nativeDepositCallData(value), 'depositERC20(address(0), amount) with the amount as value');
            world.evm -= Number(value / 10n ** 12n) / 1e6;
            world.spot += Number(value / 10n ** 12n) / 1e6;
          } else if (value > 0n) world.evm -= Number(value / 10n ** 12n) / 1e6;
          else world.evm -= Number(BigInt('0x' + tx.data.slice(74))) / 1e6; // transfer(to, amount)
        },
      });
      return hash;
    }
    if (method === 'eth_signTypedData_v4') {
      this.prompts++;
      const td = JSON.parse(params![1]);
      assert.equal(Number(td.domain.chainId), this.chainId, 'signed on the chain the wallet is on');
      events.push(`sign:${td.primaryType}`);
      this.typed.push(td);
      const raw = hexToBytes(signTypedDataWithKey(td, master.privateKey)).slice(1);
      raw[64] = raw[64]! + 27;
      return bytesToHex(raw);
    }
    throw new Error(`unexpected wallet call ${method}`);
  },
};

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  if (url === 'https://rpc.valuechain.xyz') {
    if (rpcDown) return new Response('bad gateway', { status: 502 });
    if (Array.isArray(body)) {
      rpcReads++;
      rpcAt.push(sent.length);
      return json(body.map((c: { id: number; method: string; params: any[] }) => {
        const m = micro(world.evm);
        return { jsonrpc: '2.0', id: c.id, result: '0x' + (c.method === 'eth_getBalance' ? m * 10n ** 12n : m).toString(16) };
      }));
    }
    return json({ jsonrpc: '2.0', id: body.id, ...chain(body.method, body.params) });
  }
  sent.push({ url, method, body });
  if (url.startsWith(`${BIZ}/biz/v1/ext-chain/maintenance`)) return json({ code: 0, data: world.maintenance });
  if (url === `${BIZ}/biz/mirror/analyse_address` && method === 'POST') {
    events.push('analyse');
    return analyseStatus === 200 ? json({ code: 0, data: { risk: 'low' } }) : json({ code: analyseStatus }, analyseStatus);
  }
  if (url === `${BIZ}/biz/mirror/call_for_permit` && method === 'POST') {
    events.push(`relay:${body.cmdType}`);
    if (relayReply === '400') return json({ code: 400, msg: 'permit rejected' }, 400);
    if (relayReply === '504-noexec') return new Response('<html>504 Gateway Time-out</html>', { status: 504 });
    // The relayer runs execute with exactly this request.
    const r = execute(encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [body.to, body.cmdType, body.cmdData, BigInt(body.nonce), BigInt(body.deadline), body.signature] }), true);
    if ('revert' in r) return json({ code: 500, msg: 'execution reverted' }, 200);
    if (relayReply === '504') return new Response('<html>504 Gateway Time-out</html>', { status: 504 });
    return json({ code: 0, msg: 'success', data: relayReply === 'nohash' ? {} : { txHash: r.txHash } });
  }
  if (url === '/api/deposit/chain') return json({ chainId: 286623, chainIdHex: '0x45f9f', name: 'ValueChain', rpcUrl: 'https://rpc.valuechain.xyz', explorerUrl: null, nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 }, exchange: CLOB_GATEWAY });
  if (url.startsWith('/api/deposit/assets')) return json({ assets: [{ coinId: 0, symbol: 'vUSDC', address: USDC.valuechain.token, decimals: 6, isNative: false, verified: true, walletBalance: String(world.evm) }], registered: true });
  // ValueChain's explorer (the wallet-balance fallback, read straight from the browser).
  if (url === `https://main-scan.valuechain.xyz/api/v2/addresses/${OWNER}/token-balances`) {
    return json([{ value: String(Math.round(world.evm * 1e6)), token: { address_hash: USDC.valuechain.token, symbol: 'vUSDC', decimals: '6' } }]);
  }
  if (url.startsWith('/api/md/')) return json({ symbols: [] });
  if (url.endsWith(`/user/${OWNER}/subaccounts`)) return json({ code: 0, data: { primaryAccountID: AID } });
  if (url.endsWith(`/spot/accounts/${OWNER}/state`)) return json({ code: 0, data: { aid: AID, B: [{ i: 0, a: 'vUSDC', t: String(world.spot), l: '0' }, { i: 4, a: 'WSOSO', t: String(world.spot), l: '0' }] } });
  if (url.endsWith(`/perps/accounts/${OWNER}/state`)) return json({ code: 0, data: perpsState ?? { aid: AID, amw: String(world.perps), B: [] } });
  if (/\/exchange$/.test(url)) return json({ code: 0, data: null });
  if (url.endsWith('/accounts/transfers') && method === 'POST') {
    const a = Number(body.amount);
    events.push(`transfer:${body.type}`);
    if (body.type === 5) { world.perps -= a; world.spot += a; }
    if (body.type === 3) { world.spot -= a; world.perps += a; }
    if (body.type === 2) { world.spot -= a; world.evm += a; } // arrives in the wallet
    return json({ code: 0, data: { id: body.id } });
  }
  return json({ code: 404, error: `unexpected ${method} ${url}` }, 404);
}) as typeof fetch;

beforeEach(async () => {
  world = { spot: 0, perps: 0, evm: 0, nonce: 7n, depNonce: 0n, tokenNonce: 3n, fee: 1_000_000n, available: 10n ** 12n, blacklisted: false, minWithdraw: 5_000_000n, execRevert: null, maintenance: [], withdrawals: [], depositAccounts: {}, ownDeposits: {}, registryDown: false };
  relayReply = 'ok';
  analyseStatus = 200;
  perpsState = null;
  rpcReads = 0;
  rpcDown = false;
  rpcAt = [];
  txs.clear();
  _clearPendingWithdrawals();
  _clearMaintenance();
  sent = [];
  events = [];
  wallet.chainId = 1;
  wallet.prompts = 0;
  wallet.typed = [];
  wallet.calls = [];
  wallet.txs = [];
  setTradingConfig({ network: 'mainnet', chainId: 286623, gateway: GW, writesAllowed: true, disabled: false, keyTtlMs: 7 * 86_400_000, builder: null });
  _resetTradingForTests(memoryVault());
  await enableTrading({ owner: OWNER, provider: wallet });
  wallet.prompts = 0;
  wallet.typed = [];
  sent = [];
  events = [];
});

const posts = (path: string) => sent.filter((s) => s.method === 'POST' && s.url.endsWith(path));
const moved = () => sent.filter((s) => s.method === 'POST' && !s.url.endsWith('/analyse_address'));
const transfers = () => posts('/accounts/transfers');
const relayed = () => posts('/call_for_permit');
const lastCmd = () => decodeAbiParameters(CMD, relayed().at(-1)!.body.cmdData);
const evmOnly = { spot: false, perps: false, evm: true };
const spotOnly = { spot: true, perps: false, evm: false };

// --- pure helpers ----------------------------------------------------------------------------

test('plan: the ValueChain wallet pays first, then Spot, then Perps; never more than selected (exact units)', () => {
  const b = { spot: 10n, perps: 20n, evm: 3n };
  assert.deepEqual(planWithdraw(12n, 'EXTERNAL', { spot: true, perps: true, evm: true }, b), { fromEvm: 3n, fromSpot: 9n, fromPerps: 0n });
  assert.deepEqual(planWithdraw(25n, 'EXTERNAL', { spot: true, perps: true, evm: true }, b), { fromEvm: 3n, fromSpot: 10n, fromPerps: 12n });
  assert.deepEqual(planWithdraw(5n, 'VALUECHAIN', { spot: true, perps: true, evm: true }, b), { fromEvm: 0n, fromSpot: 5n, fromPerps: 0n }, 'the wallet cannot pay itself');
  assert.ok('problem' in planWithdraw(12n, 'EXTERNAL', { spot: true, perps: false, evm: false }, b));
});

test('amounts: SoDEX balances are cut DOWN to the coin decimals, never rounded up (18-decimal coins too)', () => {
  assert.equal(unitsDown('84.0949996', 6), 84_094_999n, 'perps amw with PnL dust');
  assert.equal(unitsDown('0.1', 18), 10n ** 17n, 'exactly 0.1, no float');
  assert.equal(unitsDown('0.299999999999999999999', 18), 299_999_999_999_999_999n);
  assert.equal(unitsDown('-1', 6), 0n);
  assert.equal(unitsDown('', 6), 0n);
  assert.equal(unitsDown(null, 6), 0n);
});

test('receivers: the right format for the chain, nothing else', () => {
  assert.equal(receiverProblem(BASE, DEST), null);
  // EIP-55's own example: the right checksum passes, one flipped letter fails.
  const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  assert.equal(toChecksumAddress(good.toLowerCase()), good);
  assert.equal(receiverProblem(BASE, good), null);
  assert.match(receiverProblem(BASE, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD') ?? '', /checksum/);
  assert.match(receiverProblem(BASE, '0x0000000000000000000000000000000000000000') ?? '', /zero address/);
  assert.equal(receiverProblem(BASE, 'bc1qxyz'), 'Enter a valid Base address.');
  assert.equal(receiverProblem({ ...BASE, key: 'SOL', label: 'Solana', addressKind: 'solana' }, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), null);
  assert.match(receiverProblem({ ...BASE, key: 'SOL', label: 'Solana', addressKind: 'solana' }, DEST) ?? '', /Solana/);
  assert.ok(receiverProblem({ ...BASE, addressKind: 'other' }, 'x'));
});

test('receivers on every chain SoDEX pays out to: the right kind, checksummed, plus sodex.com rules', () => {
  const on = (key: string, label: string, addressKind: ChainRoute['addressKind']): ChainRoute => ({ ...BASE, key, label, addressKind });
  const ok: Array<[ChainRoute, string]> = [
    [on('BTC', 'Bitcoin', 'bitcoin'), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    [on('BTC', 'Bitcoin', 'bitcoin'), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
    [on('XRP', 'XRP Ledger', 'xrp'), 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
    [on('XLM', 'Stellar', 'stellar'), 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'],
    [on('TON', 'TON', 'ton'), 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'],
    [on('DOGE', 'Dogecoin', 'dogecoin'), 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'],
    [on('SUI', 'Sui', 'sui'), '0x0000000000000000000000000000000000000000000000000000000000000002'],
  ];
  for (const [r, a] of ok) assert.equal(receiverProblem(r, a), null, `${r.key} ${a}`);
  assert.equal(receiverProblem(on('BTC', 'Bitcoin', 'bitcoin'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), 'Enter a valid Bitcoin address.');
  assert.match(receiverProblem(on('BTC', 'Bitcoin', 'bitcoin'), 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4') ?? '', /lower case/);
  assert.match(receiverProblem(on('XRP', 'XRP Ledger', 'xrp'), 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTj') ?? '', /checksum/);
  assert.equal(receiverProblem(on('ZEC', 'Zcash', 'other'), 't1abc'), 'This network is not supported here.');
});

test('XRP / Stellar memo: required unless the address takes none; digits only; an XRP tag fits 32 bits', () => {
  const xrp: ChainRoute = { ...BASE, key: 'XRP', label: 'XRP Ledger', addressKind: 'xrp', memo: 'numeric' };
  assert.match(memoProblem(xrp, '', false) ?? '', /memo/);
  assert.equal(memoProblem(xrp, '', true), null, 'the user ticked "no memo"');
  assert.equal(memoProblem(xrp, '123456789', false), null);
  assert.match(memoProblem(xrp, '12a', false) ?? '', /digits/);
  assert.match(memoProblem(xrp, '4294967296', false) ?? '', /4294967295/);
  assert.equal(memoProblem(BASE, '', false), null, 'EVM chains take no memo');
});

// --- EVM -> Spot (the deposit from the connected wallet) ----------------------------------------

test('EVM -> Spot, a token: gasless - the token permit, then the CallForPermit, simulated, relayed with sodex.com\'s exact body', async () => {
  world.evm = 20;
  const r = await depositFromWallet({ provider: wallet, owner: OWNER, coin: USDC, amount: '5' });
  assert.equal(wallet.txs.length, 0, 'no transaction, no gas');
  assert.equal(wallet.prompts, 2, 'two signatures');
  const [tokenPermit, call] = wallet.typed;
  assert.equal(tokenPermit.primaryType, 'Permit');
  assert.equal(tokenPermit.domain.name, TOKEN_NAME, 'the token\'s own name, read from the token');
  assert.equal(tokenPermit.domain.verifyingContract, USDC.valuechain.token);
  assert.equal(tokenPermit.message.spender, CALL_FOR_PERMIT_CONTRACT, 'SoDEX\'s CallForPermit may move the tokens - nobody else');
  assert.equal(tokenPermit.message.value, '5000000');
  assert.equal(tokenPermit.message.nonce, '3', 'the token\'s own permit nonce');
  assert.equal(call.primaryType, 'CallForPermit');
  assert.equal(call.message.to, CLOB_GATEWAY);
  assert.equal(call.message.nonce, String(2n << 64n), 'lane 2, key-packed');
  assert.equal(call.message.deadline, tokenPermit.message.deadline, 'one deadline');
  const post = relayed()[0]!;
  assert.deepEqual(Object.keys(post.body), ['to', 'cmdType', 'cmdData', 'nonce', 'deadline', 'signature'], 'exactly sodex.com\'s body');
  assert.equal(post.body.cmdType, 'DepositERC20WithPermit');
  assert.equal(recoverAddress(hashTypedData(call), hexToBytes(post.body.signature)).toLowerCase(), OWNER);
  assert.deepEqual(events.filter((e) => /sim|relay/.test(e)), ['sim:DepositERC20WithPermit', 'relay:DepositERC20WithPermit'], 'run on-chain first, then sent');
  assert.match(r.hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual([world.evm, world.spot, world.depNonce, world.tokenNonce], [15, 5, 1n, 4n]);
});

test('EVM -> Spot: a request the contract would refuse is never sent', async () => {
  world.evm = 20;
  world.execRevert = ERR.nonce + word(0n) + word(0n);
  await assert.rejects(depositFromWallet({ provider: wallet, owner: OWNER, coin: USDC, amount: '5' }), /SoDEX would refuse this: the permit nonce was already used.*Nothing left your wallet/);
  assert.equal(relayed().length, 0);
  assert.deepEqual([world.evm, world.spot], [20, 0]);
});

test('EVM -> Spot: more than the wallet holds is refused before any signature', async () => {
  world.evm = 4;
  await assert.rejects(depositFromWallet({ provider: wallet, owner: OWNER, coin: USDC, amount: '5' }), /can move 4 USDC/);
  assert.equal(wallet.prompts, 0);
});

test('EVM -> Spot, an unclear answer (504 after it ran): the next deposit is told, never sent twice', async () => {
  world.evm = 20;
  relayReply = '504';
  await assert.rejects(depositFromWallet({ provider: wallet, owner: OWNER, coin: USDC, amount: '5' }), /may still land in Spot/);
  assert.equal(world.spot, 5, 'it DID run');
  relayReply = 'ok';
  wallet.prompts = 0;
  await assert.rejects(depositFromWallet({ provider: wallet, owner: OWNER, coin: USDC, amount: '5' }), /previous deposit of 5 USDC went through/);
  assert.equal(wallet.prompts, 0, 'nothing signed');
  assert.equal(world.spot, 5, 'credited once');
  // Told once: the one after that is a new deposit.
  await depositFromWallet({ provider: wallet, owner: OWNER, coin: USDC, amount: '5' });
  assert.equal(world.spot, 10);
});

test('EVM -> Spot, an unclear answer where it did NOT run: the retry takes the same nonces, so at most one can ever run', async () => {
  world.evm = 20;
  relayReply = '504-noexec';
  await assert.rejects(depositFromWallet({ provider: wallet, owner: OWNER, coin: USDC, amount: '5' }), /may still land/);
  const first = relayed()[0]!.body;
  relayReply = 'ok';
  await depositFromWallet({ provider: wallet, owner: OWNER, coin: USDC, amount: '5' });
  const second = relayed()[1]!.body;
  assert.equal(second.nonce, first.nonce, 'the same CallForPermit nonce');
  assert.deepEqual([world.evm, world.spot], [15, 5]);
});

test('EVM -> Spot, native SOSO: ONE wallet transaction, depositERC20(address(0), amount) to the gateway with the amount as value', async () => {
  world.evm = 20;
  await transferFunds({ owner: OWNER, provider: wallet, coin: SOSO, from: 'evm', to: 'spot', amount: '3' });
  assert.equal(wallet.txs.length, 1);
  assert.equal(wallet.prompts, 1);
  const tx = wallet.txs[0];
  assert.equal(tx.to.toLowerCase(), CLOB_GATEWAY.toLowerCase());
  assert.equal(BigInt(tx.value), 3n * 10n ** 18n);
  assert.equal(tx.data, nativeDepositCallData(3n * 10n ** 18n));
  assert.equal(relayed().length, 0, 'not relayed - the wallet pays its own gas');
  assert.deepEqual([world.evm, world.spot], [17, 3]);
  await assert.rejects(depositFromWallet({ provider: wallet, owner: OWNER, coin: SOSO, amount: '17' }), /0\.001 stays for gas/);
});

test('transfer EVM -> Perps: the gasless deposit into Spot, and only once SoDEX credits it does Spot -> Perps go out', async () => {
  world.evm = 20;
  await transferFunds({ owner: OWNER, provider: wallet, coin: USDC, from: 'evm', to: 'perps', amount: '5' });
  assert.equal(wallet.prompts, 2, 'the two deposit signatures');
  assert.deepEqual(transfers().map((t) => t.body.type), [3]);
  assert.ok(events.indexOf('relay:DepositERC20WithPermit') < events.indexOf('transfer:3'), 'deposited before the transfer was signed');
  assert.deepEqual([world.evm, world.spot, world.perps], [15, 0, 5]);
});

// --- withdrawals ----------------------------------------------------------------------------

test('to the own ValueChain wallet from Perps: perps -> spot -> wallet, key-signed, no wallet prompt, nothing relayed', async () => {
  world.perps = 20;
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: 'VALUECHAIN', receiver: OWNER, amount: '12.5', sources: { spot: true, perps: true, evm: true } });
  assert.deepEqual(r, { route: 'VALUECHAIN' });
  assert.deepEqual(transfers().map((x) => [x.url.includes('/perps/') ? 'perps' : 'spot', x.body.type, x.body.toAccountID, x.body.amount]), [
    ['perps', 5, 999, '12.5'],
    ['spot', 2, 999, '12.5'],
  ]);
  assert.equal(wallet.prompts, 0);
  assert.equal(relayed().length, 0);
  assert.deepEqual({ perps: world.perps, evm: world.evm }, { perps: 7.5, evm: 12.5 });
});

test('to Base from Spot: the checks, spot -> wallet, WAIT, ONE permit - simulated, relayed as sodex.com does, tracked by its record', async () => {
  world.spot = 30;
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '10', sources: { spot: true, perps: false, evm: true }, expectedFee: 1_000_000n });
  assert.ok('withdrawId' in r);
  assert.equal(r.withdrawId, '1000', 'read from the WithdrawalCreated log');
  assert.deepEqual(
    events,
    ['analyse', 'transfer:2', 'sign:CallForPermit', 'sim:WithdrawToken', 'relay:WithdrawToken'],
    'the risk check before anything moves; the simulation before it is sent',
  );
  assert.ok(sent.some((s) => s.url.startsWith(`${BIZ}/biz/v1/ext-chain/maintenance`)), 'SoDEX maintenance was read');
  assert.deepEqual(posts('/analyse_address')[0]!.body, { address: DEST });
  assert.equal(wallet.prompts, 1, 'one signature');
  assert.equal(wallet.chainId, 286623, 'switched to ValueChain for it');
  const post = relayed()[0]!;
  assert.deepEqual(Object.keys(post.body), ['to', 'cmdType', 'cmdData', 'nonce', 'deadline', 'signature'], 'exactly sodex.com\'s body');
  assert.equal(post.body.to, WITHDRAW_TOKEN_TARGET);
  assert.equal(post.body.cmdType, 'WithdrawToken');
  assert.equal(post.body.nonce, '7', 'lane 0, read from the contract');
  assert.deepEqual([...lastCmd()], ['USDC', 'BASE_ETH', toChecksumAddress(DEST), 10_000_000n, 0, '', true], 'gross amount; Spot paid, so a failure returns to Spot');
  const td = wallet.typed[0];
  assert.equal(td.message.to, WITHDRAW_TOKEN_TARGET);
  assert.equal(recoverAddress(hashTypedData(td), hexToBytes(post.body.signature)).toLowerCase(), OWNER, 'the owner signed it');
  assert.deepEqual([world.spot, world.evm], [20, 0]);
  // Followed in SoDEX's own Withdrawer until final.
  assert.equal((await withdrawalProgress(r))?.status, 'Requested');
  Object.assign(world.withdrawals[0]!, { status: 1, txHash: '0x97c3bfa0' });
  const done = await withdrawalProgress({ txHash: r.txHash });
  assert.deepEqual([done?.status, done?.done, done?.ok, done?.destinationTx, done?.withdrawId], ['Completed', true, true, '0x97c3bfa0', '1000']);
});

test('from EVM only: no engine transfer at all, one signature; a failure stays in the wallet (failedBackToClob false)', async () => {
  world.evm = 8;
  await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: OWNER, amount: '8', sources: evmOnly });
  assert.equal(transfers().length, 0);
  assert.equal(wallet.prompts, 1);
  assert.equal(lastCmd()[6], false);
});

test('XRP: the memo rides in the receiver ("address:memo") AND the memo field; the risk check gets the bare address', async () => {
  const XRP: ChainRoute = { ...BASE, key: 'XRP', label: 'XRP Ledger', addressKind: 'xrp', memo: 'numeric', withdraw: { allowed: true, min: null, fee: '1' } };
  const dest = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
  world.evm = 20;
  await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: XRP, receiver: dest, memo: '123456789', amount: '5', sources: evmOnly });
  const [coin, chain, receiver, , type, memo] = lastCmd();
  assert.deepEqual([coin, chain, receiver, type, memo], ['USDC', 'XRP', `${dest}:123456789`, 0, '123456789']);
  assert.deepEqual(posts('/analyse_address')[0]!.body, { address: dest });
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: XRP, receiver: dest, memo: 'abc', amount: '5', sources: evmOnly }), /digits/);
});

test('a bridged coin (USSI, the .ssi indexes): withdrawType 1 through the bridge, and no custody risk check - as sodex.com', async () => {
  const USSI: CoinConfig = { ...USDC, coin: 'USSI', asset: 'vUSSI' };
  const route: ChainRoute = { ...BASE, withdrawType: 1, withdraw: { allowed: true, min: null, fee: null } };
  world.evm = 20;
  await withdrawFunds({ owner: OWNER, provider: wallet, coin: USSI, route, receiver: DEST, amount: '10', sources: evmOnly });
  assert.equal(lastCmd()[4], 1);
  assert.equal(posts('/analyse_address').length, 0);
  assert.equal(world.evm, 10);
});

test('refused before anything moves: below the minimum, bad receiver, more than selected, too many decimals', async () => {
  world.spot = 30;
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: OWNER, amount: '4', sources: spotOnly }), /minimum/);
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: 'nope', amount: '10', sources: spotOnly }), /Enter a valid Base address/);
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: OWNER, amount: '31', sources: spotOnly }), /Not enough/);
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: OWNER, amount: '10.1234567', sources: spotOnly }), /6 decimal/);
  assert.equal(sent.filter((s) => s.method !== 'GET').length, 0, 'nothing was sent - not even the risk check');
  assert.equal(wallet.prompts, 0);
});

test('refused before anything moves: SoDEX maintenance, a failed risk check, a changed fee, too little reserve, a blacklisted receiver', async () => {
  world.spot = 30;
  const go = (extra: Partial<Parameters<typeof withdrawFunds>[0]> = {}) =>
    withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '10', sources: spotOnly, expectedFee: 1_000_000n, ...extra });
  world.maintenance = [{ coin: 'USDC', chain: 'BASE_ETH', affectType: 'withdraw', severity: 'maintenance', maintenanceInfo: 'Base node upgrade', estimatedDuration: '2h' }];
  await assert.rejects(go(), /paused by SoDEX: Base node upgrade/);
  world.maintenance = [];
  _clearMaintenance();
  analyseStatus = 500;
  await assert.rejects(go(), /address check failed/);
  analyseStatus = 200;
  await assert.rejects(go({ expectedFee: 500_000n }), /fee is now 1 USDC/);
  world.available = 9_000_000n;
  await assert.rejects(go(), /can pay out 9 USDC on Base right now/);
  world.available = 10n ** 12n;
  world.blacklisted = true;
  await assert.rejects(go(), /does not pay out to this address/);
  assert.equal(moved().length, 0, 'no transfer, no permit');
  assert.equal(wallet.prompts, 0);
  assert.equal(world.spot, 30);
});

test('congestion only warns (sodex.com too): the withdrawal goes ahead', async () => {
  world.evm = 20;
  world.maintenance = [{ coin: 'USDC', chain: 'BASE_ETH', affectType: 'withdraw', severity: 'congested', maintenanceInfo: 'slow', estimatedDuration: '' }];
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '5', sources: evmOnly });
  assert.ok('withdrawId' in r && r.withdrawId);
});

test('the contract refuses after Spot already paid the wallet: nothing is sent, and the user is told where the funds are', async () => {
  world.spot = 30;
  // The permit is refused on-chain (here: the fake says the signature does not verify).
  world.execRevert = ERR.sig;
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '10', sources: spotOnly }), /SoDEX would refuse this: the signature does not verify\..*Nothing was sent\. The 10 USDC moved out of Spot is safe in your ValueChain wallet \(EVM\)/);
  assert.equal(relayed().length, 0);
  assert.deepEqual([world.spot, world.evm], [20, 10]);
});

test('an unclear answer (504 after it ran) is never re-sent as a SECOND withdrawal: the retry sees the used nonce and stops', async () => {
  world.spot = 30;
  relayReply = '504';
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '10', sources: { spot: true, perps: false, evm: true } }), /may still go through/);
  assert.equal(world.nonce, 8n, 'the permit DID execute');
  const spotBefore = world.spot;
  relayReply = 'ok';
  sent = [];
  await assert.rejects(
    withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '10', sources: { spot: true, perps: false, evm: true } }),
    /previous withdrawal of 10 USDC to Base went through/,
  );
  assert.equal(sent.filter((x) => x.method === 'POST').length, 0, 'nothing moved or was sent on the retry');
  assert.equal(world.spot, spotBefore, 'spot untouched');
});

test('an unclear answer where the permit did NOT run: the retry reuses the same nonce (at most one can ever run)', async () => {
  world.evm = 20;
  relayReply = '504-noexec';
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '5', sources: evmOnly }), /may still go through/);
  relayReply = 'ok';
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '5', sources: evmOnly });
  assert.ok('withdrawId' in r);
  assert.deepEqual(relayed().map((p) => p.body.nonce), ['7', '7'], 'the same nonce as the unclear one');
  assert.equal(world.evm, 15);
});

test('a definite refusal (HTTP 400) forgets the permit: the next try starts clean', async () => {
  world.evm = 20;
  relayReply = '400';
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '5', sources: evmOnly }), /permit rejected/);
  relayReply = 'ok';
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '5', sources: evmOnly });
  assert.ok('withdrawId' in r);
});

test('accepted without a transaction hash (sodex.com treats it as pending): reported as submitted, and the nonce stays guarded', async () => {
  world.evm = 20;
  relayReply = 'nohash';
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '5', sources: evmOnly });
  assert.deepEqual(r, { route: 'BASE_ETH', txHash: '', withdrawId: null });
  relayReply = 'ok';
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '5', sources: evmOnly }), /previous withdrawal of 5 USDC to Base went through/);
});

// --- balances and transfers ----------------------------------------------------------------------

test("perps balance is the coin's own `at` (what the engine lets out), with sodex.com's 2% headroom only while something is open", async () => {
  // Shapes copied from live accounts (read-only GETs, 2026-09-26).
  perpsState = { aid: AID, amw: '60768.166264', B: [{ i: 0, a: 'vUSDC', wb: '226373.828013', aw: '60768.166264', at: '0' }], P: [{ s: 'US500-USD' }], O: [] };
  assert.equal((await balancesOf(OWNER, USDC)).perps, '0', 'account-wide amw is 60,768 but no USDC may leave');
  perpsState = { aid: AID, amw: '1554.596091', B: [{ i: 0, a: 'vUSDC', wb: '2074.944385', aw: '1554.596091', at: '1294.421944' }], P: [{ s: 'BTC-USD' }], O: [{}, {}] };
  assert.equal((await balancesOf(OWNER, USDC)).perps, '1268.533505', '98% of at, cut down, while a position and orders are open');
  perpsState = { aid: AID, amw: '3945.748754', B: [{ i: 0, a: 'vUSDC', wb: '3945.748754251', aw: '3945.748754', at: '3945.748754' }], P: [], O: [] };
  assert.equal((await balancesOf(OWNER, USDC)).perps, '3945.748754', 'nothing open: the whole amount');
  perpsState = { aid: AID, amw: '12.5', B: [] };
  assert.equal((await balancesOf(OWNER, USDC)).perps, '12.5', 'a state without `at` falls back to amw');
});

test('transfer Spot -> Perps and back: one key-signed engine transfer each, canonical amounts, no wallet prompt', async () => {
  world.spot = 10;
  await transferFunds({ owner: OWNER, provider: wallet, coin: USDC, from: 'spot', to: 'perps', amount: '4.50' });
  assert.equal(transfers().length, 1);
  assert.equal(transfers()[0]!.body.type, 3, 'PERPS_WITHDRAW on the spot engine');
  assert.equal(transfers()[0]!.body.amount, '4.5', 'no trailing zero - SoDEX refuses them');
  assert.equal(world.perps, 4.5);
  sent = [];
  await transferFunds({ owner: OWNER, provider: wallet, coin: USDC, from: 'perps', to: 'spot', amount: '1' });
  assert.equal(transfers().length, 1);
  assert.equal(transfers()[0]!.body.type, 5, 'SPOT_WITHDRAW on the perps engine');
  assert.equal(world.spot, 6.5);
  assert.equal(wallet.prompts, 0);
});

test('transfer refusals come before anything is sent: too much, a coin Perps does not take, one account twice', async () => {
  world.spot = 2;
  await assert.rejects(transferFunds({ owner: OWNER, provider: wallet, coin: USDC, from: 'spot', to: 'perps', amount: '3' }), /Spot has 2 USDC that can move/);
  const AAPL: CoinConfig = { ...USDC, coin: 'AAPL', asset: 'vAAPL', assetId: 32, marginRatio: 0 };
  await assert.rejects(transferFunds({ owner: OWNER, provider: wallet, coin: AAPL, from: 'spot', to: 'perps', amount: '1' }), /Futures does not take AAPL/);
  await assert.rejects(transferFunds({ owner: OWNER, provider: wallet, coin: USDC, from: 'spot', to: 'spot', amount: '1' }), /two different accounts/);
  await assert.rejects(transferFunds({ owner: OWNER, provider: null, coin: USDC, from: 'evm', to: 'spot', amount: '1' }), /Reconnect your wallet/);
  assert.equal(sent.filter((x) => x.method === 'POST').length, 0);
  assert.equal(wallet.prompts, 0);
});

test('the gas coin (native SOSO): the wallet keeps 0.001 for fees, never offered as movable', async () => {
  world.evm = 20;
  assert.equal((await balancesOf(OWNER, SOSO)).evm, '19.999');
  assert.equal((await balancesOf(OWNER, USDC)).evm, '20', 'a token keeps no reserve');
});

test('the wallet balance is read straight from ValueChain; the explorer answers only when the RPC does not', async () => {
  world.evm = 12.5;
  assert.equal((await balancesOf(OWNER, USDC)).evm, '12.5');
  assert.equal(rpcReads, 1);
  const explorer = () => sent.filter((x) => x.url.startsWith('https://main-scan.valuechain.xyz/')).length;
  assert.equal(explorer(), 0, 'no explorer read');
  rpcDown = true;
  assert.equal((await balancesOf(OWNER, USDC)).evm, '12.5');
  assert.equal(explorer(), 1, 'the explorer, as the fallback');
  assert.equal(sent.filter((x) => x.url.startsWith('/api/')).length, 0, 'never the Valuescan server');
});

test('transfer Perps -> wallet goes through Spot: two key-signed moves, no wallet prompt', async () => {
  world.perps = 8;
  await transferFunds({ owner: OWNER, provider: wallet, coin: USDC, from: 'perps', to: 'evm', amount: '3' });
  assert.deepEqual(transfers().map((t) => t.body.type), [5, 2], 'perps -> spot, then spot -> own wallet');
  assert.deepEqual([world.perps, world.spot, world.evm], [5, 0, 3]);
  assert.equal(wallet.prompts, 0);
});

test('withdraw to ANOTHER ValueChain address: Spot pays the own wallet, then the wallet sends one token transfer to that address', async () => {
  world.spot = 10;
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: 'VALUECHAIN', receiver: FRIEND, amount: '4', sources: spotOnly });
  assert.equal(r.route, 'VALUECHAIN');
  assert.ok('txHash' in r, 'the wallet transfer is returned to track');
  assert.deepEqual(transfers().map((t) => t.body.type), [2], 'Spot -> own ValueChain wallet (EVM_WITHDRAW)');
  assert.equal(wallet.txs.length, 1, 'one wallet transaction');
  const tx = wallet.txs[0];
  assert.equal(tx.to.toLowerCase(), USDC.valuechain.token.toLowerCase(), 'sent to the USDC contract');
  assert.equal(tx.data, erc20TransferData(FRIEND, 4_000_000n), 'transfer(friend, 4 USDC)');
  assert.equal(tx.chainId, '0x45f9f', 'on ValueChain');
  const movedAt = sent.findIndex((x) => x.url.endsWith('/accounts/transfers'));
  assert.ok(rpcAt.some((i) => i > movedAt), 'the arrival in the wallet was checked (on ValueChain) before sending on');
  assert.equal(world.evm, 0, 'and the transfer was waited for until mined');
});

test('withdraw EVM Funding to another ValueChain address: no engine move at all, one wallet transfer', async () => {
  world.evm = 20;
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: 'VALUECHAIN', receiver: FRIEND, amount: '5', sources: evmOnly });
  assert.ok('txHash' in r);
  assert.equal(transfers().length, 0, 'the trading key signs nothing');
  assert.equal(wallet.txs.length, 1);
  assert.equal(wallet.txs[0].data, erc20TransferData(FRIEND, 5_000_000n));
});

test('to the own ValueChain wallet EVM Funding cannot pay (it is already there); a bad address is refused before anything moves', async () => {
  world.evm = 20;
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: 'VALUECHAIN', receiver: OWNER, amount: '5', sources: evmOnly }), /Not enough in the selected balances/);
  await assert.rejects(
    withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: 'VALUECHAIN', receiver: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', amount: '5', sources: evmOnly }),
    /checksum/,
  );
  await assert.rejects(withdrawFunds({ owner: OWNER, provider: null, coin: USDC, route: 'VALUECHAIN', receiver: FRIEND, amount: '5', sources: evmOnly }), /Reconnect your wallet/);
  assert.equal(sent.filter((x) => x.method === 'POST').length, 0);
  assert.equal(wallet.txs.length, 0);
});

// --- the receiving end: a deposit address, and SoDEX's deposit minimum ------------------------------
// The owner's case (2026-10): 5 USDC withdrawn to Base met the 5 USDC withdrawal
// minimum, but to ANOTHER SoDEX account's deposit address 4 arrived after the
// 1 USDC fee - below the 5 USDC deposit minimum, so it was never credited.
// The sheet's verdicts themselves: components/funds/depositGuard.test.ts.

/** Another SoDEX account, its Base deposit address (stored EIP-55, as SoDEX stores them), and the owner's own. */
const OTHER = '0x2222222222222222222222222222222222222222';
const THEIRS = toChecksumAddress('0x4577c24e9e7a53aa775589c7d9fa7ae4bbc426cb');
const MINE = toChecksumAddress('0x5cc60db393c3d48b8128bc82183da57fd9fc7b01');
const UNKNOWN: ReceiverAccount = { depositOf: null, own: false };

test("the registry: the custody contract's reverse map, asked in the EIP-55 form SoDEX stores; the owner's own list; no answer is not a no", async () => {
  world.depositAccounts = { [`BASE_ETH|${THEIRS}`]: OTHER, [`BASE_ETH|${MINE}`]: OWNER };
  world.ownDeposits = { BASE_ETH: [MINE], ETH: [MINE], SOL: ['F7xtoepF6EpvHBvEuP2Aj8Jmf6Fqw4vjTqgT6ok1hDBj'] };
  assert.deepEqual(await receiverAccount(OWNER, USDC, BASE, THEIRS.toLowerCase()), { depositOf: OTHER, own: false }, 'typed in lower case: still found');
  assert.deepEqual(await receiverAccount(OWNER, USDC, BASE, MINE), { depositOf: OWNER, own: true });
  assert.deepEqual(await receiverAccount(OWNER, USDC, BASE, DEST), UNKNOWN);
  assert.deepEqual(await receiverAccount(OWNER, USDC, 'VALUECHAIN', MINE.toLowerCase()), { depositOf: null, own: true }, 'ValueChain: from the own list');
  world.registryDown = true;
  _clearPendingWithdrawals();
  await assert.rejects(receiverAccount(OWNER, USDC, BASE, THEIRS));
});

test('withdrawFunds refuses before anything moves: a SoDEX deposit address that would get less than the minimum, the own deposit address', async () => {
  world.spot = 30;
  world.depositAccounts = { [`BASE_ETH|${THEIRS}`]: OTHER, [`BASE_ETH|${MINE}`]: OWNER };
  world.ownDeposits = { BASE_ETH: [MINE] };
  const go = (receiver: string, amount: string, route: ChainRoute | 'VALUECHAIN' = BASE) =>
    withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route, receiver, amount, sources: spotOnly, expectedFee: route === 'VALUECHAIN' ? undefined : 1_000_000n });
  await assert.rejects(go(THEIRS, '5'), /That is a SoDEX deposit address\. Only 4 USDC arrives .* never be credited/);
  await assert.rejects(go(MINE, '20'), /your own SoDEX deposit address/);
  await assert.rejects(go(MINE, '5', 'VALUECHAIN'), /your own SoDEX deposit address/);
  assert.equal(moved().length, 0, 'no transfer, no permit');
  assert.equal(wallet.prompts, 0);
  assert.equal(world.spot, 30);
  const r = await go(THEIRS, '6');
  assert.ok('withdrawId' in r && r.withdrawId, 'enough to be credited: it goes');
});

test("withdrawFunds leaves an unknown address below the minimum to the sheet's confirmation, and an unanswered registry too", async () => {
  world.evm = 20;
  const r = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: DEST, amount: '5', sources: evmOnly });
  assert.ok('withdrawId' in r);
  world.depositAccounts = { [`BASE_ETH|${THEIRS}`]: OTHER };
  world.registryDown = true;
  const r2 = await withdrawFunds({ owner: OWNER, provider: wallet, coin: USDC, route: BASE, receiver: THEIRS, amount: '5', sources: evmOnly });
  assert.ok('withdrawId' in r2, 'the sheet asked for the tick; nothing here blocks it');
});
