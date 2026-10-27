/**
 * A local run of the executor's algo engine against LIVE SoDEX market data,
 * in PAPER mode: nothing is signed for SoDEX and nothing is sent to it.
 *
 *   npx tsx apps/executor/tools/paper-run.ts [seconds=150]
 *
 * It boots a hosted executor on this machine (a temporary data folder, a
 * random port, SoDEX mainnet), makes a throwaway wallet that has never seen
 * SoDEX, and drives the executor exactly as the web app does: the terms, a
 * session, then one signed `algo-start` per algo type below (every spec has
 * `paper: true`; the script refuses anything else). It polls GET /algos until
 * every algo has ended or the time is up, then prints each one's status,
 * fills, average price and arrival slippage, and the end of its log.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, type AlgoView, type CopyAction } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { egress } from '../src/net.ts';
import { Secrets } from '../src/secrets.ts';
import { createExecutorServer } from '../src/server.ts';
import { ExecutorService } from '../src/service.ts';

const seconds = Number(process.argv[2] ?? 150) || 150;
const quiet = { debug() {}, info() {}, warn: (m: string, d?: object) => console.warn('  warn:', m, d ?? ''), error: (m: string, d?: object) => console.error('  error:', m, d ?? '') };

const pk = secp256k1.utils.randomPrivateKey();
const owner = privateKeyToAddress(pk).toLowerCase();
function sign(executor: string, action: CopyAction, payload: unknown) {
  const r = buildCopyRequest({ action, owner, executor, payload, chainId: 286623 });
  const sig = secp256k1.sign(hexToBytes(copyRequestDigest(r)), pk);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return { ...r, signature: bytesToHex(out) };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vd-paper-run-'));
  const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', SODEX_NETWORK: 'mainnet', EXECUTOR_ALLOWED_ORIGINS: 'http://localhost' });
  const db = new ExecutorDb(join(dir, 'executor.db'));
  const out = egress(null);
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: out.fetch, factory: out.factory, log: quiet });
  await svc.start();
  const server = createExecutorServer(svc, cfg, quiet);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1`;
  const post = async (path: string, request: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }) });
    const body = await res.json();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
    return body;
  };
  console.log(`executor ${svc.executorId} on ${base}, live SoDEX mainnet data, throwaway wallet ${owner}`);
  await post('/terms', sign(svc.executorId, 'accept-terms', { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'00'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true }));
  const { token } = (await post('/session', sign(svc.executorId, 'session', {}))) as { token: string };

  // Let the market feed fill in (quotes, marks, prints) before the algos begin.
  await new Promise((r) => setTimeout(r, 4_000));
  const marks = await svc.sodex.markPrices();
  const px = (s: string) => marks.find((m) => m.symbol === s)!.price;
  const btc = px('BTC-USD');
  const S = (x: Record<string, unknown>) => ({ symbol: 'BTC-USD', side: 'buy', paper: true, ...x });
  const specs: Record<string, unknown>[] = [
    S({ kind: 'twap', label: 'TWAP taker', quantity: '0.0006', durationMs: 60_000, slices: 3, sizeJitter: 0.2, timeJitter: 0.2, exec: { style: 'taker', slippageBps: 20 } }),
    S({ kind: 'twap', label: 'Chase TWAP + bracket', quantity: '0.0006', durationMs: 90_000, slices: 3, exec: { style: 'hybrid', makerShare: 0.5, slippageBps: 20, chaseTicks: 1 }, exits: { tpPct: 0.01, slPct: 0.005 } }),
    S({ kind: 'vwap', label: 'VWAP adaptive', quantity: '0.0006', durationMs: 15 * 60_000, slices: 15, lookbackDays: 7, exec: { style: 'taker' } }),
    S({ kind: 'pov', label: 'POV 20%', quantity: '0.0004', rate: 0.2, exec: { style: 'taker' } }),
    S({ kind: 'iceberg', label: 'Iceberg pegged', quantity: '0.0006', displayQty: '0.0002', postOnly: true }),
    S({ kind: 'chase', label: 'Chase sell', side: 'sell', quantity: '0.0003', maxChaseBps: 20, timeoutMs: 90_000, onEnd: 'take' }),
    S({ kind: 'scale', label: 'Scale', quantity: '0.0008', from: Math.round(btc * 0.9995), to: Math.round(btc * 0.997), orders: 4, distribution: 'exponential', skew: 2, spacing: 'geometric', postOnly: true }),
    S({ kind: 'dca', label: 'DCA', perOrderUsd: 15, orders: 2, intervalMs: 60_000, exec: { style: 'taker' } }),
    S({ kind: 'swarm', label: 'Swarm', side: 'sell', quantity: '0.0006', clips: 3, inFlight: 2, waveMs: 2_000, slippageBps: 20 }),
    S({ kind: 'conditional', label: 'Conditional (spread + funding) -> market', conditions: [{ type: 'spread', symbol: 'BTC-USD', op: 'below', bps: 50 }, { type: 'funding', symbol: 'BTC-USD', op: 'below', value: 1 }], holdMs: 2_000, then: { type: 'market', quantity: '0.0002', slippageBps: 20 } }),
    S({ kind: 'trailing', label: 'Trailing stop', side: 'sell', quantity: '0.0002', trailPct: 0.001 }),
    S({ kind: 'basket', label: 'Basket BTC+ETH', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 30 }, { symbol: 'ETH-USD', side: 'sell', usd: 30 }], style: 'swarm', clips: 2, inFlight: 2, waveMs: 1_000, slippageBps: 20 }),
    S({ kind: 'bracket', label: 'Bracket', quantity: '0.0002', entry: 'market', exits: { tpPct: 0.005, slPct: 0.003 } }),
  ];
  for (const spec of specs) {
    if (spec.paper !== true) throw new Error('paper only');
    await post('/algos', sign(svc.executorId, 'algo-start', { spec, seed: Math.floor(Math.random() * 2 ** 32) }));
  }
  console.log(`started ${specs.length} paper algos; watching for up to ${seconds} s...`);

  const list = async () => ((await (await fetch(`${base}/algos`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { algos: AlgoView[] }).algos;
  const until = Date.now() + seconds * 1000;
  let views = await list();
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5_000));
    views = await list();
    const live = views.filter((v) => !['done', 'cancelled', 'expired', 'failed'].includes(v.algo.status));
    process.stdout.write(`  ${Math.round((until - Date.now()) / 1000)} s left, ${live.length} running\n`);
    if (!live.length) break;
  }
  console.log('');
  for (const v of views.sort((x, y) => x.algo.createdAt - y.algo.createdAt)) {
    const a = v.algo;
    const name = a.spec.label ?? a.spec.kind;
    const bp = v.vsArrivalBps === null ? '—' : `${v.vsArrivalBps >= 0 ? '+' : ''}${v.vsArrivalBps.toFixed(2)} bp`;
    console.log(`${name.padEnd(40)} ${a.status.padEnd(9)} filled ${String(+a.filled.toFixed(6)).padEnd(9)} avg ${v.avgPrice?.toFixed(2) ?? '—'}  vs arrival ${bp}  children ${a.childCount}${v.exits?.length ? `  exits ${v.exits.map((x) => `${x.kind}@${x.price}${x.live ? '' : x.filled ? ' FILLED' : ' gone'}`).join(' ')}` : ''}`);
    const ev = ((await (await fetch(`${base}/algos/${a.id}/events?limit=4`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { events: Array<{ text: string }> }).events;
    for (const e of ev.reverse()) console.log(`    ${e.text}`);
  }
  // Cancel what still runs, then stop: a paper run leaves nothing behind.
  await post('/algos/action', sign(svc.executorId, 'algo-action', { op: 'cancel-all' })).catch(() => {});
  server.close();
  await svc.stop();
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS cleans its temp folder */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
