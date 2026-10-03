/**
 * Chain reads (trading/rpc.ts): a node that does not answer is followed by another node of the same chain -
 * reads only, and only for chains that list one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RPC_FALLBACKS, rpcBatch } from './rpc';

const POLYGON = 'https://polygon-bor-rpc.publicnode.com';
const answer = (result: string) => new Response(JSON.stringify([{ jsonrpc: '2.0', id: 0, result }]), { headers: { 'content-type': 'application/json' } });

async function withFetch<T>(fake: (url: string) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => fake(String(input))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('rpcBatch: Polygon\'s node answering 529 (or nothing) is followed by the next Polygon node; every fallback is in the CSP', async () => {
  const asked: string[] = [];
  const got = await withFetch(
    (url) => {
      asked.push(url);
      return url === POLYGON ? new Response('overloaded', { status: 529 }) : answer('0x2a');
    },
    () => rpcBatch(POLYGON, [{ method: 'eth_blockNumber', params: [] }]),
  );
  assert.equal(got.get(0), '0x2a');
  assert.deepEqual(asked, [POLYGON, 'https://polygon.drpc.org']);
  // Both down: the third; all down: the last error.
  const asked2: string[] = [];
  await assert.rejects(
    withFetch(
      (url) => {
        asked2.push(url);
        throw new TypeError('fetch failed');
      },
      () => rpcBatch(POLYGON, [{ method: 'eth_blockNumber', params: [] }]),
    ),
    /fetch failed/,
  );
  assert.deepEqual(asked2, [POLYGON, ...RPC_FALLBACKS[POLYGON]!]);
  // A chain without fallbacks asks its own node only.
  const asked3: string[] = [];
  await assert.rejects(withFetch((url) => (asked3.push(url), new Response('', { status: 503 })), () => rpcBatch('https://mainnet.base.org', [{ method: 'eth_blockNumber', params: [] }])), /HTTP 503/);
  assert.deepEqual(asked3, ['https://mainnet.base.org']);
  // The CSP lets the browser reach them (index.html connect-src).
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  for (const u of RPC_FALLBACKS[POLYGON]!) assert.ok(html.includes(new URL(u).origin), `${new URL(u).origin} is in connect-src`);
});
