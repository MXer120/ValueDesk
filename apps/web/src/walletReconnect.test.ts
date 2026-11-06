/**
 * The silent reconnect on load cannot hang the app.
 *   npx tsx --test src/walletReconnect.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { silentReconnect, type Eip1193Provider } from './wallet';

const wallet = (answer: (method: string) => unknown): Eip1193Provider => ({
  request: async ({ method }: { method: string }) => answer(method),
} as unknown as Eip1193Provider);

test('a wallet that never answers ends the wait: no account, not a hang', async () => {
  const hung = { request: () => new Promise(() => {}) } as unknown as Eip1193Provider;
  assert.equal(await silentReconnect(hung, 20), null);
});

test('a wallet that answers reconnects', async () => {
  const w = wallet((m) => (m === 'eth_accounts' ? ['0xabc'] : '0x45fa7'));
  assert.deepEqual(await silentReconnect(w, 1000), { address: '0xabc', chainId: 0x45fa7 });
});

test('no account, or an error, is no reconnect', async () => {
  assert.equal(await silentReconnect(wallet(() => []), 1000), null);
  assert.equal(await silentReconnect(wallet(() => { throw new Error('locked'); }), 1000), null);
});
