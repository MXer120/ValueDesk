/**
 * The gasless Funding -> Spot deposit (token Permit + CallForPermit
 * DepositERC20WithPermit) and the call-for-permit request, pinned three ways:
 *   - CONTRACT: the ValueChain CallForPermit contract's own `hashCallForPermit`
 *     returned CONTRACT_DEPOSIT_DIGEST for the fixed input below (eth_call,
 *     2026-09-26). The same day, with a throwaway key and a state override
 *     giving it 5 vUSDC, `execute` of exactly this kind of request SUCCEEDED
 *     (the tokens landed on the exchange), reverted ERC20InsufficientBalance
 *     without the override, and a WithdrawToken request below the minimum
 *     reverted WithdrawAmountLessThanMinWithdrawAmount (scratch simdeposit.mjs);
 *   - viem: an independent EIP-712 + ABI implementation agrees on every digest
 *     and on the cmdData / execute calldata;
 *   - the recovered signer must be the owner before anything leaves.
 *   npx tsx --test test/callForPermit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, hashTypedData as viemHash, parseAbi } from 'viem';
import { bytesToHex, hexToBytes, signDigest } from '../src/eip712.ts';
import { generateTradingKey } from '../src/keys.ts';
import {
  CLOB_GATEWAY,
  DEPOSIT_NONCE_KEY,
  WITHDRAWAL_CREATED_TOPIC,
  WithdrawalStatus,
  assembleCallForPermit,
  decodeWithdrawal,
  describeRevert,
  executeCallData,
  prepareDepositPermit,
  prepareTokenPermit,
  splitSignature,
  withdrawAsCallForPermit,
} from '../src/callForPermit.ts';
import { CALL_FOR_PERMIT_CONTRACT, WITHDRAW_TOKEN_TARGET, prepareWithdrawPermit } from '../src/permit.ts';
import { PK, V } from './fixtures.ts';

const VUSDC = '0xcb7F80Dff2727c791fA491722c428e6657f7e2c6';
const DEADLINE = 4102444800n;
const CONTRACT_DEPOSIT_DIGEST = '0xbe2a0a98093ffe29868db19fea04ce1e83d7a60ef1d08aa88614bc046bda5fb9';

const walletSign = (digest: string, pk: Uint8Array = PK): string => {
  const raw = signDigest(hexToBytes(digest), pk, 0).slice(1);
  raw[64] = raw[64]! + 27;
  return bytesToHex(raw);
};

const permit = () => prepareTokenPermit({ owner: V.address, token: VUSDC, tokenName: 'SoDexToken: USDC', amount: 5_000_000n, nonce: 0n, deadline: DEADLINE, chainId: 286623 });
const deposit = () => {
  const p = permit();
  return prepareDepositPermit({ owner: V.address, token: VUSDC, amount: 5_000_000n, deadline: DEADLINE, tokenPermit: { digest: p.digest, signature: walletSign(p.digest) }, nonce: DEPOSIT_NONCE_KEY << 64n, chainId: 286623 });
};

test('the deposit digest is the one the ValueChain contract computes', () => {
  assert.equal(deposit().digest, CONTRACT_DEPOSIT_DIGEST);
});

test('viem agrees: the token permit, the deposit permit, cmdData and the execute calldata', () => {
  const p = permit();
  assert.equal(p.digest, viemHash(p.typedData as never));
  assert.equal(p.typedData.message.spender, CALL_FOR_PERMIT_CONTRACT, 'the relay contract spends the tokens');
  const d = deposit();
  assert.equal(d.digest, viemHash(d.typedData as never));
  assert.equal(d.to, CLOB_GATEWAY);
  const { v, r, s } = splitSignature(walletSign(p.digest));
  assert.equal(
    d.cmdData,
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], [VUSDC, 5_000_000n, DEADLINE, v, r, s]),
  );
  const req = assembleCallForPermit(d, walletSign(d.digest));
  assert.deepEqual(Object.keys(req), ['to', 'cmdType', 'cmdData', 'nonce', 'deadline', 'signature'], 'exactly sodex.com\'s body');
  assert.equal(req.cmdType, 'DepositERC20WithPermit');
  assert.equal(req.nonce, (2n << 64n).toString(), 'the key-packed lane-2 nonce, as a decimal string');
  assert.equal(hexToBytes(req.signature).length, 65);
  assert.ok([27, 28].includes(hexToBytes(req.signature)[64]!), 'v 27/28, no prefix');
  const abi = parseAbi(['function execute(address to, string cmdType, bytes cmdData, uint256 nonce, uint256 deadline, bytes signature)']);
  assert.equal(executeCallData(req), encodeFunctionData({ abi, functionName: 'execute', args: [CLOB_GATEWAY, 'DepositERC20WithPermit', req.cmdData, 2n << 64n, DEADLINE, req.signature] }));
});

test('a withdrawal as a call-for-permit: addressed to the Withdrawer, cmdType WithdrawToken, lane 0', () => {
  const w = withdrawAsCallForPermit(prepareWithdrawPermit({ owner: V.address, coinSymbol: 'USDC', chain: 'ARBITRUM_ETH', receiver: V.address, amount: 10_000_000n, nonce: 7n, deadline: DEADLINE, chainId: 286623 }));
  const req = assembleCallForPermit(w, walletSign(w.digest));
  assert.equal(req.to, WITHDRAW_TOKEN_TARGET);
  assert.equal(req.cmdType, 'WithdrawToken');
  assert.equal(req.nonce, '7');
});

test('refused before anything leaves: a stranger\'s signature, a token permit from someone else, the wrong nonce lane, a high-s signature', () => {
  const d = deposit();
  const stranger = generateTradingKey().privateKey;
  assert.throws(() => assembleCallForPermit(d, walletSign(d.digest, stranger)), /must be signed by/);
  const p = permit();
  assert.throws(
    () => prepareDepositPermit({ owner: V.address, token: VUSDC, amount: 5_000_000n, deadline: DEADLINE, tokenPermit: { digest: p.digest, signature: walletSign(p.digest, stranger) }, nonce: 2n << 64n, chainId: 286623 }),
    /token permit/,
  );
  assert.throws(
    () => prepareDepositPermit({ owner: V.address, token: VUSDC, amount: 5_000_000n, deadline: DEADLINE, tokenPermit: { digest: p.digest, signature: walletSign(p.digest) }, nonce: 5n, chainId: 286623 }),
    /lane 2/,
  );
  const good = hexToBytes(walletSign(d.digest));
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = new Uint8Array(good);
  highS.set(hexToBytes(`0x${(n - BigInt(bytesToHex(good.slice(32, 64)))).toString(16).padStart(64, '0')}`), 32);
  assert.throws(() => splitSignature(bytesToHex(highS)), /high-s/);
});

test('WithdrawalCreated / getWithdrawal: the Withdrawal record decodes, and reverts read as reasons', () => {
  const tuple = [
    { type: 'uint256' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'string' }, { type: 'uint8' }, { type: 'string' }, { type: 'bool' },
    { type: 'uint256' }, { type: 'string' },
  ] as const;
  const values = [173523n, 'ARBITRUM_ETH', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', V.address, '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd', 40_000_000_000n, 1_000_000n, '', 1790443416n, 1790443520n, '0x97c3bfa0', 1, '', true, 1790443520n, 'USDC'] as const;
  const data = encodeAbiParameters([{ type: 'tuple', components: tuple.map((t, i) => ({ ...t, name: `f${i}` })) }], [Object.fromEntries(values.map((v, i) => [`f${i}`, v])) as never]);
  const w = decodeWithdrawal(data);
  assert.equal(w.withdrawId, 173523n);
  assert.equal(w.chain, 'ARBITRUM_ETH');
  assert.equal(w.account.toLowerCase(), V.address.toLowerCase());
  assert.equal(w.receiver, '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd');
  assert.equal(w.amount, 40_000_000_000n);
  assert.equal(w.withdrawFee, 1_000_000n);
  assert.equal(w.status, WithdrawalStatus.SUCCESS);
  assert.equal(w.txHash, '0x97c3bfa0');
  assert.equal(w.coinSymbol, 'USDC');
  assert.equal(WITHDRAWAL_CREATED_TOPIC, '0xac3a6c6ce917789a41415e603e46de277cf7bc59362a0535331410512b3a4bfd', 'the topic seen on real withdrawals');
  assert.equal(describeRevert('0x96a802db' + '0'.repeat(128))?.name, 'WithdrawAmountLessThanMinWithdrawAmount');
  assert.equal(describeRevert('0x240f724b')?.name, 'WalletIsBlacklisted');
  const errString = '0x08c379a0' + encodeAbiParameters([{ type: 'string' }], ['SoDexTokenCallForPermit: signature expired']).slice(2);
  assert.equal(describeRevert(errString)?.text, 'signature expired');
  assert.equal(describeRevert('0xdeadbeef'), null);
});
