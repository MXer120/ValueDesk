/**
 * The test wallet's bots go live as VIP on production (owner 2026-11-09: "just make the bots go live as vip asap").
 *
 *   node --import tsx apps/executor/tools/live-test/vip-live.ts --env <.env.live> [--symbols BTC-USD,ETH-USD] [--hours 8]
 *
 * 1. ValueDesk's standard executor: the wallet's key is registered and no bot of it runs; the product's default maker
 *    (R10, bots/presets.ts) starts on each market, small ($11 quotes, $16 cap, 2x), with an end time (endAt).
 * 2. Each quotes (orders resting), then the wallet's one signed 'vip-move' hands every bot to the VIP executor.
 * 3. The move ends 'done'; on the VIP side (/api/copy-vip/v1) every bot runs with the same book it had, the wallet's
 *    bot fee is VIP's (0.1 bp), and standard lists none of them running.
 * The bots are left running (their endAt stops them). Prints what it checked; exits 1 on the first thing that is wrong.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hexToBytes } from '../../../../packages/sodex-core/src/index.ts';
import { CopyWallet } from './executor.ts';
import { HostedTarget } from './target.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const envFile = arg('--env') ?? '';
if (!existsSync(envFile)) throw new Error('--env <path to .env.live> is needed');
const env: Record<string, string> = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !line.trim().startsWith('#')) env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
}
const hex = (env.LIVE_FOLLOWER_KEY ?? '').trim().replace(/^0x/i, '');
if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('LIVE_FOLLOWER_KEY must be a private key');
const SYMBOLS = (arg('--symbols') ?? 'BTC-USD,ETH-USD,NKE-USD,NEAR-USD,CRWV-USD,SNDK-USD,HYPE-USD').split(',').map((s) => s.trim()).filter(Boolean);
const HOURS = Number(arg('--hours') ?? 8);
/** The product's default maker (web bots/presets.ts R10 + maxSpreadBps 20). */
const PRODUCT_MM = { ref: 'binance', restMs: 10_000, offsetTicks: 0, skewTicks: 0, chaseTicks: 40, minRepriceMs: 1_000, maxSpreadBps: 20 };
const VIP_BASE = 'https://www.valuedesk.so/api/copy-vip/v1';

const t0 = Date.now();
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const fail = (s: string): never => {
  log(`FAIL ${s}`);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const wallet = new CopyWallet(hexToBytes(`0x${hex}`));
const std = new HostedTarget(wallet, 'live');
await std.start();
const info = (await std.info()) as Any;
log(`standard executor ${info.executorId}, VIP: ${JSON.stringify(info.vip)}`);
if (!info.vip?.canMove) fail('the standard executor does not offer the VIP move yet (release not live?)');

const me = (await std.me()) as Any;
log(`wallet ${wallet.address}: key ${me.key?.name ?? 'none'} (${me.key?.registered ? 'registered' : 'NOT registered'}), bot fee ${JSON.stringify(me.bots)}`);
if (!me.key?.registered) fail('no registered key: run the runner with --only setup.key first');
const running = (await std.algos()).filter((v) => v.algo.spec?.bot && ['running', 'waiting', 'scheduled'].includes(v.algo.status));
if (running.length) fail(`${running.length} bot(s) of the wallet already run on standard: ${running.map((v) => `${v.algo.spec.symbol} ${v.algo.id}`).join(', ')}`);

// 1. Start.
const endAt = Date.now() + HOURS * 3_600_000;
const ids: string[] = [];
for (const symbol of SYMBOLS) {
  const v = await std.algoStart({ kind: 'mm', symbol, paper: false, label: 'live-test vip', orderUsd: 11, maxInventoryUsd: 16, leverage: 2, ...PRODUCT_MM, maxLossUsd: 2, onStop: 'close', endAt });
  ids.push(v.algo.id);
  log(`started ${symbol} ${v.algo.id} (${v.algo.status})`);
}

// 2. Quoting, then the move.
await sleep(45_000);
const before = new Map<string, Any>();
for (const id of ids) {
  const v = (await std.algo(id)) as Any;
  const open = (v.algo.children ?? []).filter((c: Any) => c.state === 'open').length;
  before.set(id, { status: v.algo.status, inventory: v.bot?.inventory ?? 0, volume: v.bot?.volume ?? 0, open });
  log(`before the move: ${v.algo.spec.symbol} ${v.algo.status}, ${open} order(s) resting, holding ${v.bot?.inventory ?? 0}, volume $${(v.bot?.volume ?? 0).toFixed(2)}`);
}
const post = (std as unknown as { post<T>(p: string, a: string, b: unknown): Promise<T> }).post.bind(std);
const call = (std as unknown as { call<T>(m: string, p: string, b?: unknown, auth?: boolean): Promise<T> }).call.bind(std);
const moved = await post<Any>('/vip/move', 'vip-move', {});
log(`move asked: ${JSON.stringify(moved.job ?? moved).slice(0, 200)}`);
let job: Any = moved.job ?? {};
for (let i = 0; i < 60 && (!job.state || job.state === 'running'); i++) {
  await sleep(1_000);
  job = ((await call<Any>('GET', '/vip/move', undefined, true)).job ?? {}) as Any;
}
log(`move ${job.state} in ${job.endedAt && job.startedAt ? job.endedAt - job.startedAt : '?'} ms: ${JSON.stringify(job).slice(0, 300)}`);
if (job.state !== 'done') fail('the move did not finish');

// 3. On VIP.
const vip = new HostedTarget(wallet, 'live', VIP_BASE);
await vip.start();
const vinfo = (await vip.info()) as Any;
if (vinfo.vip?.tier !== 'vip') fail(`${VIP_BASE} answers tier ${vinfo.vip?.tier}`);
await sleep(10_000);
let bad = 0;
for (const id of ids) {
  const v = (await vip.algo(id)) as Any;
  const b = before.get(id)!;
  const open = (v.algo.children ?? []).filter((c: Any) => c.state === 'open').length;
  const ok = v.algo.status === 'running' && Math.abs((v.bot?.volume ?? 0) - b.volume) < 1e9;
  if (!ok) bad++;
  log(`${ok ? 'ok  ' : 'BAD '} on VIP: ${v.algo.spec.symbol} ${v.algo.status}, ${open} resting, holding ${v.bot?.inventory ?? 0} (was ${b.inventory}), volume $${(v.bot?.volume ?? 0).toFixed(2)} (was $${b.volume.toFixed(2)})`);
}
const vme = (await vip.me()) as Any;
log(`VIP bot fee: ${JSON.stringify(vme.bots)}; key ${vme.key?.name} ${vme.key?.registered ? 'registered' : 'NOT registered'}`);
if (!vme.bots?.vip || vme.bots?.feeTenths !== 1) { bad++; log('BAD the wallet is not on the VIP bot fee'); }
const left = (await std.algos()).filter((v) => ids.includes(v.algo.id) && ['running', 'waiting'].includes(v.algo.status));
if (left.length) { bad++; log(`BAD standard still runs ${left.length} of them`); }
const sme = (await std.me()) as Any;
log(`standard says the wallet moved to: ${sme.movedTo}`);
log(bad ? `${bad} problem(s)` : `all ${ids.length} bots run on VIP at the VIP fee, ${Math.round((Date.now() - t0) / 1000)} s in all; they end ${new Date(endAt).toISOString()}`);
process.exit(bad ? 1 : 0);
