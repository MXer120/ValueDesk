/**
 * The wallet-prompt counter (wallet.ts walletPrompting): up while a signature prompt is open, down when it ends -
 * approved, refused or failed - for typed data and messages alike (a "Waiting for your wallet..." must never stick).
 * Run (from apps/web): npx tsx --test src/walletPrompting.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signMessage, signTypedData, walletPrompting, type Eip1193Provider } from './wallet';

const ADDR = '0x' + '11'.repeat(20);
function provider(answer: () => Promise<unknown>): { p: Eip1193Provider; seen: boolean[] } {
  const seen: boolean[] = [];
  // The account check before a prompt (eth_accounts, wallet.ts walletAccounts) is no prompt: only the signature calls count.
  const p = { request: async ({ method }: { method: string }) => { if (method === 'eth_accounts') return []; seen.push(walletPrompting()); return answer(); } } as unknown as Eip1193Provider;
  return { p, seen };
}

test('typed data and messages: prompting while the wallet is asked, not after - signed or refused', async () => {
  const ok = provider(async () => '0x' + 'ab'.repeat(65));
  await signTypedData(ok.p, ADDR, { types: {}, domain: {}, message: {} });
  await signMessage(ok.p, ADDR, 'hello');
  assert.deepEqual(ok.seen, [true, true]);
  assert.equal(walletPrompting(), false);
  const no = provider(async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); });
  await assert.rejects(signTypedData(no.p, ADDR, {}));
  await assert.rejects(signMessage(no.p, ADDR, 'hello'));
  assert.equal(walletPrompting(), false, 'a refusal ends the prompt too');
});
