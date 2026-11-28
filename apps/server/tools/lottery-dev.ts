/**
 * Dev only: the Blind Box routes in-process for the web dev server, so localhost can open, merge and read a wallet's
 * boxes before they are released (apps/web/vite.config.ts devLottery loads this with ssrLoadModule). Never in a build.
 *
 *   /api/vs/sodex/lottery/u/*      the signed-in relay (src/routes/sodexLotteryUser.ts), the user's Authorization passed
 *   /api/vs/sodex/lottery/rewards  the reward history (src/routes/boxRewards.ts), its state in the OS temp folder
 *
 * The first reward read walks the whole history (tens of MB): here it is paced to the laptop's 2 MB/s download cap.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { sodexLotteryUserRoutes } from '../src/routes/sodexLotteryUser.js';
import { boxRewardsRoutes } from '../src/routes/boxRewards.js';
import { boxRewards } from '../src/valuedesk/boxRewards.js';

const CAP_BYTES_PER_S = 2 * 1024 * 1024;
let nextFree = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The chain read, paced so the laptop's download stays under its cap. */
const pacedRpc = async (method: string, params: unknown[]): Promise<unknown> => {
  const wait = nextFree - Date.now();
  if (wait > 0) await sleep(wait);
  const r = await fetch('https://rpc.valuechain.xyz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  nextFree = Math.max(nextFree, Date.now()) + (text.length / CAP_BYTES_PER_S) * 1000;
  const j = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || 'ValueChain refused the read');
  return j.result;
};

const file = join(tmpdir(), 'valuedesk-dev', 'box-rewards.json');
const app = Fastify();
const ready = app.register(sodexLotteryUserRoutes())
  .then(() => app.register(boxRewardsRoutes({ read: () => boxRewards(file, pacedRpc) })))
  .then(() => app.ready());

export async function handle(method: string, url: string, body: string, auth: string | undefined, ip: string): Promise<{ status: number; body: string; cache: string }> {
  await ready;
  const r = await app.inject({
    method: method as 'GET' | 'POST',
    url,
    ...(method === 'POST' ? { payload: body || '{}' } : {}),
    headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: auth } : {}) },
    remoteAddress: ip,
  });
  return { status: r.statusCode, body: r.body, cache: String(r.headers['cache-control'] ?? 'no-store') };
}
