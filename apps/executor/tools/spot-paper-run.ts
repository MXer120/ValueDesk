/**
 * Spot bots against LIVE SoDEX spot data, in PAPER mode (owner 2026-11-19: futures or spot): a local hosted executor,
 * a throwaway wallet, and the specs the web page builds (apps/web/src/bots/presets.ts specOf) for a spot market maker
 * on vBTC_vUSDC and a spot grid on vETH_vUSDC. Nothing is signed for SoDEX, nothing is sent to it.
 *
 *   npx tsx apps/executor/tools/spot-paper-run.ts [seconds=180]
 *
 * Prints each bot's status, fills, inventory (never below 0 on spot) and the end of its log.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, type AlgoView, type CopyAction } from '../../../packages/copy-engine/src/index.ts';
import { draftFor, specOf } from '../../web/src/bots/presets.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { egress } from '../src/net.ts';
import { Secrets } from '../src/secrets.ts';
import { createExecutorServer } from '../src/server.ts';
import { ExecutorService } from '../src/service.ts';

const seconds = Number(process.argv[2] ?? 180) || 180;
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
  const dir = mkdtempSync(join(tmpdir(), 'vd-spot-paper-'));
  const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', SODEX_NETWORK: 'mainnet', EXECUTOR_ALLOWED_ORIGINS: 'http://localhost', EXECUTOR_PRACTICE_BOTS: '1' });
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
  console.log(`executor features: ${(svc.info({ viewerCountry: 'SG' }).features ?? []).filter((f) => /spot|bot/.test(f)).join(', ')}`);
  await post('/terms', sign(svc.executorId, 'accept-terms', { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'00'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true }));
  const { token } = (await post('/session', sign(svc.executorId, 'session', {}))) as { token: string };
  await new Promise((r) => setTimeout(r, 4_000));
  const mids = await svc.sodex.spotMids();
  const mid = (s: string) => (mids as Array<{ symbol: string; price: number }>).find((m) => m.symbol === s)?.price ?? null;
  const eth = mid('vETH_vUSDC');
  console.log(`spot mids: BTC/USDC ${mid('vBTC_vUSDC')}, ETH/USDC ${eth}`);

  // The web's own specs: the default market maker (a spot maker is the plain one) and a tight grid.
  const mm = specOf({ ...draftFor('market', 'balanced', 'vBTC_vUSDC'), paper: true, orderUsd: 20, maxInventoryUsd: 60, maxLossUsd: 5, label: 'Spot maker BTC/USDC' }, mid('vBTC_vUSDC'));
  const grid = specOf({ ...draftFor('grid', 'balanced', 'vETH_vUSDC'), paper: true, rangePct: 0.004, levels: 8, orderUsd: 10, maxLossUsd: 5, label: 'Spot grid ETH/USDC' }, eth);
  for (const spec of [mm, grid]) {
    console.log(`start ${String(spec.label)}: kind ${String(spec.kind)} engine ${String(spec.engine)}${spec.direction ? ` direction ${String(spec.direction)}` : ''}${'ref' in spec ? ' ref!' : ''}${'leverage' in spec ? ' leverage!' : ''}`);
    await post('/algos', sign(svc.executorId, 'algo-start', { spec, seed: Math.floor(Math.random() * 2 ** 32) }));
  }
  const list = async () => ((await (await fetch(`${base}/algos`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { algos: AlgoView[] }).algos;
  const until = Date.now() + seconds * 1000;
  let views = await list();
  let minInv = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10_000));
    views = await list();
    for (const v of views) minInv = Math.min(minInv, v.bot?.inventory ?? 0);
    process.stdout.write(`  ${Math.round((until - Date.now()) / 1000)} s left: ${views.map((v) => `${v.algo.spec.label} ${v.algo.status} fills ${v.bot?.fills ?? 0} inv ${(v.bot?.inventory ?? 0).toPrecision(3)}`).join(' | ')}\n`);
  }
  console.log(`\nlowest inventory seen: ${minInv} (spot: never below 0)`);
  for (const v of views) {
    console.log(`${String(v.algo.spec.label)}: ${v.algo.status}, fills ${v.bot?.fills ?? 0}, volume $${(v.bot?.volume ?? 0).toFixed(2)}, inventory ${v.bot?.inventory ?? 0}, fees $${((v.bot?.tradeFees ?? 0) + (v.bot?.builderFees ?? 0)).toFixed(4)} (builder $${(v.bot?.builderFees ?? 0).toFixed(4)})`);
    const ev = ((await (await fetch(`${base}/algos/${v.algo.id}/events?limit=6`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { events: Array<{ text: string }> }).events;
    for (const e of ev.reverse()) console.log(`    ${e.text}`);
  }
  await post('/algos/action', sign(svc.executorId, 'algo-action', { op: 'cancel-all' })).catch(() => {});
  server.close();
  await svc.stop();
  db.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
