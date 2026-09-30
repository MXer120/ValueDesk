/**
 * The cross-chain withdrawal permit (CallForPermit / WithdrawToken).
 *
 * Pinned three ways:
 *   - CONTRACT: the ValueChain permit contract's own `hashCallForPermit` view
 *     returned CONTRACT_DIGEST for the fixed input below (read 2026-09-26 with
 *     eth_call); the same day an owner-signed permit simulated `execute`
 *     successfully with a funded wallet, and reverted for a stranger's
 *     signature and for an empty wallet (ERC20InsufficientBalance).
 *   - viem: an independent EIP-712 + ABI implementation agrees on the digest,
 *     the cmdData and the nonce calldata.
 *   - the recovered signer must be the owner before anything is sent.
 *   npx tsx --test test/permit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, hashTypedData as viemHash, parseAbi } from 'viem';
import { bytesToHex, hashTypedData, hexToBytes, signDigest } from '../src/eip712.ts';
import { generateTradingKey } from '../src/keys.ts';
import {
  CALL_FOR_PERMIT_CONTRACT,
  WITHDRAW_TOKEN_TARGET,
  assembleWithdrawPermit,
  encodeWithdrawTokenCmd,
  permitNonceCall,
  prepareWithdrawPermit,
} from '../src/permit.ts';
import { PK, V } from './fixtures.ts';

const FIXED = {
  owner: V.address,
  coinSymbol: 'USDC',
  chain: 'BASE_ETH',
  receiver: '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd',
  amount: 12_500_000n,
  nonce: 3n,
  deadline: 4102444800n,
  chainId: 286623,
};
const CONTRACT_DIGEST = '0xbb2df8ac225e0fcac4a5ce7d7062d3e5506280984b0fc52908ae59053c641a05';

/** What a browser wallet returns for eth_signTypedData_v4: r || s || v with v 27/28. */
const walletSign = (digest: string, pk: Uint8Array = PK): string => {
  const raw = signDigest(hexToBytes(digest), pk, 0).slice(1);
  raw[64] = raw[64]! + 27;
  return bytesToHex(raw);
};

test('the permit digest is the one the ValueChain contract computes', () => {
  const p = prepareWithdrawPermit(FIXED);
  assert.equal(p.digest, CONTRACT_DIGEST);
  assert.equal(p.typedData.domain.name, 'SoDexTokenCallForPermit');
  assert.equal(p.typedData.domain.version, '1.0.0');
  assert.equal(p.typedData.domain.verifyingContract, CALL_FOR_PERMIT_CONTRACT);
  assert.equal((p.typedData.message as any).to, WITHDRAW_TOKEN_TARGET);
});

test('viem agrees: digest, cmdData, nonce calldata', () => {
  for (const c of [FIXED, { ...FIXED, chain: 'ARBITRUM_ETH', amount: 1n, nonce: 0n, memo: 'x', failedBackToClob: false, withdrawType: 1 }]) {
    const p = prepareWithdrawPermit(c);
    const { EIP712Domain: _d, ...types } = p.typedData.types;
    const cmd = (p.typedData.message as any).cmd;
    const v = viemHash({
      domain: p.typedData.domain as any,
      types: types as any,
      primaryType: 'CallForPermit',
      message: { to: WITHDRAW_TOKEN_TARGET, cmd: { ...cmd, amount: BigInt(cmd.amount), withdrawType: Number(cmd.withdrawType) }, nonce: c.nonce, deadline: c.deadline } as any,
    });
    assert.equal(p.digest, v.toLowerCase());
    const enc = encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'string' }, { type: 'bool' }],
      [c.coinSymbol, c.chain, c.receiver, c.amount, (c as any).withdrawType ?? 0, (c as any).memo ?? '', (c as any).failedBackToClob ?? true],
    );
    assert.equal(encodeWithdrawTokenCmd(c), enc.toLowerCase());
  }
  const owner = '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd';
  assert.equal(
    permitNonceCall(owner),
    encodeFunctionData({ abi: parseAbi(['function nonces(address owner, uint192 key) view returns (uint256)']), functionName: 'nonces', args: [owner, 0n] }).toLowerCase(),
  );
});

test('assemble: the owner signature passes as 65 bytes (v 27/28); a stranger never leaves the browser', () => {
  const p = prepareWithdrawPermit(FIXED);
  const req = assembleWithdrawPermit(p, walletSign(p.digest));
  assert.equal(req.cmdData, p.cmdData);
  assert.equal(req.nonce, '3');
  assert.equal(req.deadline, '4102444800');
  assert.equal(hexToBytes(req.signature).length, 65);
  assert.ok([27, 28].includes(hexToBytes(req.signature)[64]!));
  // Wallets that return v as 0/1 are normalised.
  const raw = hexToBytes(walletSign(p.digest));
  raw[64] = raw[64]! - 27;
  assert.equal(assembleWithdrawPermit(p, bytesToHex(raw)).signature, req.signature);
  assert.throws(() => assembleWithdrawPermit(p, walletSign(p.digest, generateTradingKey().privateKey)), /must be signed by/);
});

test('refuses the inputs that could send funds somewhere unintended', () => {
  assert.throws(() => prepareWithdrawPermit({ ...FIXED, amount: 0n }), /positive/);
  assert.throws(() => prepareWithdrawPermit({ ...FIXED, receiver: '' }), /receiver/);
  assert.throws(() => prepareWithdrawPermit({ ...FIXED, receiver: '0xabc def' }), /receiver/);
  assert.throws(() => prepareWithdrawPermit({ ...FIXED, chain: 'base eth' }), /chain/);
  assert.throws(() => prepareWithdrawPermit({ ...FIXED, deadline: 1n }), /past/);
  assert.throws(() => prepareWithdrawPermit({ ...FIXED, owner: '0x1234' }), /owner/);
});

test('hashTypedData handles nested structs exactly like the flat ones before it', () => {
  // A flat struct must still hash as before (every Go vector test covers the rest).
  const td = prepareWithdrawPermit(FIXED).typedData;
  assert.equal(bytesToHex(hashTypedData(td)), CONTRACT_DIGEST);
});
