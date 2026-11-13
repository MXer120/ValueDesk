/**
 * The grid presets live on the test wallet (owner 2026-11-12: "test the best options live"), on the VIP executor where
 * the wallet's bots run. Each preset as the app makes it (web bots/gridPresets.ts): step = k x the hourly volatility
 * (sd of SoDEX 5-minute returns over 24 h x sqrt 12), range = the price now (1 - p, 1 + p), stop out of range.
 *
 *   node --import tsx apps/executor/tools/live-test/grid-live.ts --env <.env.live> [--go] [--hours 24] [--order 11] [--loss 5]
 *   ... --status          the running grids: fills, volume, net
 *   ... --stop            cancel the running grid-live grids (their onStop closes what they hold)
 * Without --go it prints the plan (ranges, margin) and starts nothing.
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
const GO = process.argv.includes('--go');
const STATUS = process.argv.includes('--status');
const HOURS = Number(arg('--hours') ?? 24);
const ORDER = Number(arg('--order') ?? 11);
const LOSS = Number(arg('--loss') ?? 5);
const LEV = Number(arg('--lev') ?? 3);
const ONLY = arg('--only');
const VIP_BASE = 'https://www.valuedesk.so/api/copy-vip/v1';
const GW = 'https://mainnet-gw.sodex.dev/api/v1/perps/markets';
// web bots/gridPresets.ts GRID_PRESETS (owner 2026-11-12: tighter, for a day)
const RUNS = [
  { symbol: 'BTC-USD', name: 'Tight grid', k: 0.5, levels: 20, outOfRange: 'wait' },
  { symbol: 'DOGE-USD', name: 'Tight grid', k: 0.5, levels: 20, outOfRange: 'wait' },
  { symbol: 'ETH-USD', name: 'Range grid', k: 1, levels: 40, outOfRange: 'stop' },
];
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

async function volAndMark(symbol: string): Promise<{ vol: number; mark: number }> {
  const r = (await (await fetch(`${GW}/${symbol}/klines?interval=5m&limit=289`)).json()) as Any;
  const c = (r.data as Any[]).map((x) => ({ t: Number(x.t), c: Number(x.c) })).sort((a, b) => a.t - b.t).map((x) => x.c);
  let s = 0;
  for (let i = 1; i < c.length; i++) s += Math.log(c[i]! / c[i - 1]!) ** 2;
  return { vol: Math.sqrt((s / (c.length - 1)) * 12) * 1e4, mark: c[c.length - 1]! };
}
const sig = (x: number) => Number(x.toPrecision(6));

const wallet = new CopyWallet(hexToBytes(`0x${hex}`));
const vip = new HostedTarget(wallet, 'live', VIP_BASE);
await vip.start();
const info = (await vip.info()) as Any;
log(`executor ${info.executorId} ${info.location} tier ${info.vip?.tier}`);

if (STATUS) {
  for (const v of (await vip.algos()) as Any[]) {
    const a = v.algo;
    if (a.spec?.kind !== 'grid' || !String(a.spec.label ?? '').startsWith('grid-live')) continue;
    const full = (await vip.algo(a.id)) as Any;
    const b = full.bot ?? {};
    const open = (full.algo.children ?? []).filter((c: Any) => c.state === 'open').length;
    log(`${a.spec.symbol} ${a.spec.label} ${a.status}: ${open} resting, fills ${b.fills ?? '?'}, volume $${(b.volume ?? 0).toFixed(2)}, holding ${b.inventory ?? 0}, net $${(b.net ?? b.pnl ?? 0).toFixed?.(3) ?? JSON.stringify(b).slice(0, 200)} ${JSON.stringify(b).slice(0, 300)}`);
  }
  process.exit(0);
}

if (process.argv.includes('--stop-all')) {
  // every bot of the wallet (any kind or label), on the VIP and the standard executor
  const std = new HostedTarget(wallet, 'live');
  for (const [name, t] of [['vip', vip], ['standard', std]] as const) {
    try {
      if (t !== vip) await t.start();
      for (const v of (await t.algos()) as Any[]) {
        const a = v.algo;
        if (!a.spec?.bot || !['running', 'waiting', 'scheduled', 'paused'].includes(a.status)) continue;
        await t.algoAct('cancel', a.id);
        log(`${name}: stopped ${a.spec.symbol} ${a.spec.kind} ${a.spec.label ?? ''} ${a.id}`);
      }
      const left = ((await t.algos()) as Any[]).filter((v) => v.algo.spec?.bot && ['running', 'waiting', 'scheduled', 'paused'].includes(v.algo.status));
      log(`${name}: ${left.length} bots still active`);
    } catch (e) {
      log(`${name}: ${(e as Error).message}`);
    }
  }
  process.exit(0);
}

if (process.argv.includes('--stop')) {
  for (const v of (await vip.algos()) as Any[]) {
    const a = v.algo;
    if (a.spec?.kind !== 'grid' || !String(a.spec.label ?? '').startsWith('grid-live') || !['running', 'waiting', 'scheduled', 'paused'].includes(a.status)) continue;
    await vip.algoAct('cancel', a.id);
    log(`stopped ${a.spec.symbol} ${a.spec.label} ${a.id}`);
  }
  process.exit(0);
}

const me = (await vip.me()) as Any;
log(`wallet ${wallet.address.slice(0, 6)}…: key ${me.key?.registered ? 'registered' : 'NOT registered'}, bot fee ${JSON.stringify(me.bots)}`);
const running = ((await vip.algos()) as Any[]).filter((v) => v.algo.spec?.bot && ['running', 'waiting', 'scheduled'].includes(v.algo.status));
log(`bots running now: ${running.map((v) => `${v.algo.spec.symbol} ${v.algo.spec.kind}`).join(', ') || 'none'}`);
const endAt = Date.now() + HOURS * 3_600_000;
const specs: Any[] = [];
for (const r of RUNS) {
  const { vol, mark } = await volAndMark(r.symbol);
  const step = r.k * vol;
  const p = Number((Math.pow(1 + step / 1e4, (r.levels - 1) / 2) - 1).toPrecision(4));
  const spec = { kind: 'grid', symbol: r.symbol, paper: false, label: `grid-live ${r.name}`, low: sig(mark * (1 - p)), high: sig(mark * (1 + p)), levels: r.levels, orderUsd: ORDER, spacing: 'geometric', outOfRange: r.outOfRange, maxSpreadBps: 20, leverage: LEV, maxLossUsd: LOSS, onStop: 'close', volumeTargetUsd: null, endAt };
  specs.push(spec);
  log(`${r.symbol} ${r.name}: vol ${vol.toFixed(0)} bp/h, step ${step.toFixed(0)} bp, range ${spec.low}-${spec.high} (±${(p * 100).toFixed(1)}%) around ${mark}, ${r.levels} x $${ORDER} = $${r.levels * ORDER} at ${LEV}x`);
}
if (!GO) { log('plan only (add --go to start)'); process.exit(0); }
// --relev: the running grid-live bots to this leverage first (frees the margin they set aside)
if (process.argv.includes('--relev')) {
  for (const v of running.filter((x) => String(x.algo.spec.label ?? '').startsWith('grid-live'))) {
    await vip.algoUpdate(v.algo.id, { leverage: LEV });
    log(`leverage ${LEV}x on ${v.algo.spec.symbol} ${v.algo.id}`);
  }
}
for (const s of specs) {
  if (ONLY && s.symbol !== ONLY) continue;
  try {
    const v = (await vip.algoStart(s)) as Any;
    log(`started ${s.symbol} ${v.algo.id} (${v.algo.status})`);
  } catch (e) {
    log(`REFUSED ${s.symbol}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(0);
