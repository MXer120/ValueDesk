import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressKindOf, addressKinds, addressProblem, base58CheckEncode, bech32Encode, convertBits, type AddressKind } from './addresses';

/** Published addresses (BIPs, genesis accounts, well-known contracts). */
const REAL: Array<[AddressKind, string]> = [
  ['evm', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
  ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  ['bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
  ['bitcoin', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
  ['bitcoin', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'],
  ['tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
  ['xrp', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
  ['ton', 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'],
  ['ton', '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8'],
  ['sui', '0x0000000000000000000000000000000000000000000000000000000000000002'],
  ['stellar', 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'],
  ['dogecoin', 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'],
  ['cardano', 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x'],
];

test('published addresses are valid, and are exactly their own kind', () => {
  for (const [kind, a] of REAL) {
    assert.equal(addressProblem(kind, a), null, `${kind} ${a}`);
    if (kind !== 'bitcoin' || !a.startsWith('3')) assert.equal(addressKindOf(a), kind, a);
  }
});

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed * 11 + 5) & 0xff);
/** One character swapped for another of the same alphabet - the typo a checksum must catch. */
const typo = (a: string, at: number, alphabet: string) => {
  const c = a[at]!;
  const repl = alphabet[(alphabet.indexOf(c) + 1) % alphabet.length]!;
  return a.slice(0, at) + repl + a.slice(at + 1);
};

test('base58check kinds round-trip, and a one-character typo is caught by the checksum', () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const cases: Array<[AddressKind, number]> = [['bitcoin', 0x00], ['bitcoin', 0x05], ['litecoin', 0x30], ['litecoin', 0x32], ['dogecoin', 0x1e], ['dogecoin', 0x16], ['tron', 0x41]];
  for (const [kind, version] of cases) {
    for (let seed = 0; seed < 5; seed++) {
      const a = base58CheckEncode(Uint8Array.from([version, ...bytes(20, seed)]));
      assert.equal(addressProblem(kind, a), null, `${kind} ${a}`);
      assert.equal(addressProblem(kind, typo(a, 10, B58)), 'checksum', `typo ${kind} ${a}`);
    }
  }
});

test('segwit: v0 bech32 20/32 bytes, taproot bech32m; the wrong variant or network is refused', () => {
  const words = (v: number, n: number) => [v, ...convertBits([...bytes(n, 3)], 8, 5, true)!];
  assert.equal(addressProblem('bitcoin', bech32Encode('bc', words(0, 20))), null);
  assert.equal(addressProblem('bitcoin', bech32Encode('bc', words(0, 32))), null);
  assert.equal(addressProblem('bitcoin', bech32Encode('bc', words(1, 32), 'bech32m')), null);
  assert.equal(addressProblem('bitcoin', bech32Encode('bc', words(1, 32), 'bech32')), 'checksum', 'taproot must be bech32m');
  assert.equal(addressProblem('bitcoin', bech32Encode('bc', words(0, 20), 'bech32m')), 'checksum', 'v0 must be bech32');
  assert.equal(addressProblem('litecoin', bech32Encode('ltc', words(0, 20))), null);
  assert.notEqual(addressProblem('bitcoin', bech32Encode('ltc', words(0, 20))), null, 'a Litecoin address is not a Bitcoin one');
  assert.equal(addressProblem('bitcoin', typo('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 12, 'qpzry9x8gf2tvdw0s3jn54khce6mua7l')), 'checksum');
});

test('XRP, Stellar, TON, Solana: typos and wrong shapes are refused', () => {
  assert.equal(addressProblem('xrp', typo('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 8, 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz')), 'checksum');
  assert.equal(addressProblem('ton', typo('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N', 20, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_')), 'checksum');
  assert.equal(addressProblem('stellar', 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN8'), 'format');
  assert.equal(addressProblem('solana', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), 'format');
  assert.equal(addressProblem('evm', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), 'checksum');
  assert.equal(addressProblem('evm', '0x0000000000000000000000000000000000000000'), 'zero');
  assert.deepEqual(addressKinds('hello'), []);
});
