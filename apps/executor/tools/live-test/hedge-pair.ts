/**
 * The hedge bot's two-wallet pair, live (owner 2026-11-27: "Run the hedge bot live on small size, 2 majors and 2
 * volatile pairs. Small size, max leverage and 20x leverage. Monitor live"). The pair the bots scenario points to
 * (scenarios/bots.ts 'bot.hedge': "a pair needs two wallets: tools/live-test/hedge-pair is the two-wallet run").
 *
 * Wallet A (LIVE_FOLLOWER_KEY) runs the main leg of every pair, wallet B (LIVE_LEADER_KEY) the partner leg, on
 * ValueDesk's own executor (both legs must be on the same one: the main drives both). The sides alternate per market,
 * so neither account holds all its risk one way.
 *
 *   node --import tsx apps/executor/tools/live-test/hedge-pair.ts --env <.env.live>            plan only: sizes, buffers, margin, costs
 *   ... --go [--hours 24]       set up what is missing (terms, executor key, builder approval) and start the pairs
 *   ... --status [--watch 60]   read-only: every hedge-live pair's legs, liquidation distances, last move, net, volume
 *   ... --stop                  cancel the hedge-live pairs (onStop close: both legs closed, a slice at a time)
 *
 * Without --go nothing is signed and nothing is sent. Buffers are the app's own (web bots/hedge.ts buffersFor,
 * 'balanced'), so the run tests what a user gets by default. Fees are SoDEX's taker fee from its symbols list plus
 * the bot fee the executor reports for the wallet (me().bots.feeTenths); orders go as signed API requests, not wallet
 * transactions, so the wallets pay no gas.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hexToBytes } from '../../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, canonicalJSON } from '../../../../packages/copy-engine/src/index.ts';
import { bytesToHex, keccak256, utf8 } from '../../../../packages/sodex-core/src/index.ts';
import { egress } from '../../src/net.ts';
import { readEnvText } from './allParts.ts';
import { SodexReads, SodexWallet } from './exchange.ts';
import { CopyWallet } from './executor.ts';
import { HostedTarget } from './target.ts';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string) => process.argv.includes(name);
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sig = (x: number) => Number(x.toPrecision(5));
const usd = (x: number) => `$${x.toFixed(2)}`;
const LABEL = 'hedge-live';
const ACTIVE = new Set(['running', 'waiting', 'scheduled', 'paused']);
const GW = 'https://mainnet-gw.sodex.dev/api/v1/perps/markets';

/**
 * The run (owner: 2 majors + 2 volatile, small, max leverage and 20x). BTC and ETH offer 40x; the volatile pairs
 * measured on 2026-11-27 (24 h of SoDEX 5-minute candles) with real volume are ZEC (140 bp/h, 18% range, $10M) and HYPE
 * (79 bp/h, $0.7M); both top out at 10x on SoDEX, so 20x runs on ETH and the volatile pairs run at their maximum.
 * `side` is the main leg's (wallet A); wallet B takes the other side.
 */
const RUNS = [
  { symbol: 'BTC-USD', leverage: 'max', side: 'buy', sizeUsd: 300, sliceUsd: 100, maxSlipBps: 15, maxLossUsd: 4 },
  { symbol: 'ETH-USD', leverage: 20, side: 'sell', sizeUsd: 150, sliceUsd: 50, maxSlipBps: 15, maxLossUsd: 3 },
  { symbol: 'ZEC-USD', leverage: 'max', side: 'buy', sizeUsd: 40, sliceUsd: 20, maxSlipBps: 30, maxLossUsd: 2 },
  { symbol: 'HYPE-USD', leverage: 'max', side: 'sell', sizeUsd: 40, sliceUsd: 20, maxSlipBps: 30, maxLossUsd: 2 },
] as const;

/** web bots/hedge.ts startDistance + buffersFor ('balanced': SAFETY_USED 0.6), the app's defaults for a leverage. */
function buffersFor(leverage: number, maxLeverage: number): { minLiqPct: number; growLiqPct: number; startPct: number } {
  const L = Math.max(1, Math.min(leverage, maxLeverage));
  const m = 1 / maxLeverage / 2;
  const d0 = Math.max(0, (1 / L - m) / (1 + m)) * 100;
  const r = (x: number) => Math.round(x * 100) / 100;
  const minLiqPct = r(Math.max(0.5, d0 * (1 - 0.6)));
  const growLiqPct = r(Math.max(1, minLiqPct + 0.25, d0 * 0.9));
  return { minLiqPct, growLiqPct, startPct: d0 };
}

/** keccak256 of the copy terms text as the web app shows it (run.ts termsHash). */
async function termsHash(): Promise<string> {
  const mod = (await import('../../../web/src/legal/copyTerms.ts')) as { COPY_TERMS: unknown };
  return bytesToHex(keccak256(utf8(canonicalJSON(mod.COPY_TERMS))));
}

const envFile = arg('--env') ?? '';
if (!existsSync(envFile)) throw new Error('--env <path to .env.live> is needed');
const env = readEnvText(readFileSync(envFile, 'utf8'));
const keyOf = (name: string): Uint8Array => {
  const hex = (env[name] ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} must be a private key in ${envFile}`);
  return hexToBytes(`0x${hex}`);
};
const pkA = keyOf('LIVE_FOLLOWER_KEY');
const pkB = keyOf('LIVE_LEADER_KEY');
const reads = new SodexReads(egress(null).fetch);
const wallets = [new SodexWallet('A', pkA, reads), new SodexWallet('B', pkB, reads)] as const;
const targets = [new HostedTarget(new CopyWallet(pkA), 'live'), new HostedTarget(new CopyWallet(pkB), 'live')] as const;
for (const t of targets) await t.start();
// A wallet whose bots moved to VIP is served there; the two legs of a pair must be on the same executor.
const onVip = [await targets[0].followVip(), await targets[1].followVip()];
const [A, B] = wallets.map((w) => w.address) as [string, string];
log(`wallet A ${A} (main legs)${onVip[0] ? ' on VIP' : ''}, wallet B ${B} (partner legs)${onVip[1] ? ' on VIP' : ''}`);
// Found 2026-11-27: A is on VIP, B on standard. With --go, the wallet still on standard moves to VIP with its own signed
// 'vip-move' (the Savings page's move); VIP refuses a wallet that is not VIP (not listed, under the volume): then the
// owner assigns it VIP in the admin suite, or the run cannot pair. Without --go the plan is printed either way.
const split = onVip[0] !== onVip[1];
if (split) {
  const low = onVip[0] ? 1 : 0;
  log(`wallet ${low ? 'B' : 'A'} runs its bots on the standard executor, the other on VIP: a pair's legs must share one executor${has('--go') ? '; moving it to VIP' : '; --go moves it to VIP first (needs it to be VIP)'}`);
  if (has('--go')) {
    try {
      const { ms } = await targets[low]!.moveToVip();
      log(`wallet ${low ? 'B' : 'A'} moved to VIP in ${ms} ms`);
    } catch (e) {
      log(`STOP: VIP refused wallet ${low ? 'B' : 'A'} (${e instanceof Error ? e.message : String(e)}). Assign it VIP in the admin suite, then run --go again.`);
      process.exit(1);
    }
  }
}
const [ta, tb] = targets;

/* ------------------------------------------------------------- status ----- */

async function pairs(): Promise<Array<{ main: Any; partner: Any | null }>> {
  const mine = ((await ta.algos()) as Any[]).filter((v) => v.algo.spec?.kind === 'hedge' && String(v.algo.spec.label ?? '').startsWith(LABEL));
  const theirs = ((await tb.algos()) as Any[]).filter((v) => v.algo.spec?.kind === 'hedge' && String(v.algo.spec.label ?? '').startsWith(LABEL));
  return mine.map((m) => ({ main: m, partner: theirs.find((p) => p.algo.spec.pairId === m.algo.spec.pairId) ?? null }));
}

async function status(): Promise<void> {
  const ps = await pairs();
  if (!ps.length) log('no hedge-live pairs');
  for (const { main, partner } of ps) {
    const full = (await ta.algo(main.algo.id)) as Any;
    const a = full.algo;
    const h = (full.bot?.hedge ?? {}) as Any;
    const legs = ((h.legs ?? []) as Any[]).map((l, i) => `${i === 0 ? 'A' : 'B'} ${sig(l.qty)} (${usd(l.usd ?? 0)}) eq ${usd(l.equity ?? 0)} liq ${l.liqDistance === null || l.liqDistance === undefined ? '-' : `${(l.liqDistance * 100).toFixed(2)}%`}`);
    log(`${a.spec.symbol} ${a.spec.leverage ?? '?'}x ${a.status}${a.statusReason ? ` (${a.statusReason})` : ''} | partner ${partner ? `${partner.algo.status}${partner.algo.statusReason ? ` (${partner.algo.statusReason})` : ''}` : 'missing'} | ${legs.join(' | ') || 'no legs read yet'} | room ${h.room === null || h.room === undefined ? '-' : sig(h.room)} | net ${usd(h.pairNet ?? 0)} vol ${usd(h.pairVolume ?? 0)}${h.last ? ` | last: ${h.last}` : ''}`);
    if (has('--events')) for (const e of ((await ta.events(a.id, 20)) as Any[]).slice(-8)) log(`    ${new Date(e.at).toISOString().slice(11, 19)} ${e.level} ${e.text}`);
  }
}

if (has('--status')) {
  const every = Number(arg('--watch') ?? 0);
  do {
    await status();
    if (every > 0) await new Promise((r) => setTimeout(r, every * 1_000));
  } while (every > 0);
  process.exit(0);
}

if (has('--stop')) {
  for (const { main } of await pairs()) {
    if (!ACTIVE.has(main.algo.status)) continue;
    await ta.algoAct('cancel', main.algo.id);
    log(`stopped ${main.algo.spec.symbol} ${main.algo.id}: both legs close`);
  }
  process.exit(0);
}

/* --------------------------------------------------------------- plan ----- */

const symbols = ((await (await fetch(`${GW}/symbols`)).json()) as Any).data as Any[];
const meA = (await ta.me()) as Any;
const meB = (await tb.me()) as Any;
const accounts = await Promise.all(wallets.map(async (w) => ((await (await fetch(`https://mainnet-gw.sodex.dev/api/v1/perps/accounts/${w.address}/state`)).json()) as Any).data as Any));
const botFee = Math.max(Number(meA.bots?.feeTenths ?? 0), Number(meB.bots?.feeTenths ?? 0)) / 10; // bp
const running = await pairs();
const endAt = Date.now() + Number(arg('--hours') ?? 24) * 3_600_000;
const plan: Array<{ main: Any; partner: Any }> = [];
let imA = 0;
let notional = 0;
let fees = 0;
for (const r of RUNS) {
  const s = symbols.find((x) => x.name === r.symbol);
  if (!s || s.status !== 'TRADING') { log(`${r.symbol}: not trading on SoDEX, left out`); continue; }
  if (running.some((p) => p.main.algo.spec.symbol === r.symbol && ACTIVE.has(p.main.algo.status))) { log(`${r.symbol}: a hedge-live pair already runs, left out`); continue; }
  const maxLev = Number(s.maxLeverage);
  const lev = r.leverage === 'max' ? maxLev : Math.min(r.leverage, maxLev);
  const b = buffersFor(lev, maxLev);
  const k = (await (await fetch(`${GW}/${r.symbol}/klines?interval=1m&limit=1`)).json()) as Any;
  const mark = Number((k.data as Any[])[0]?.c);
  const taker = Number(s.takerFee) * 1e4;
  const pairId = `pair-${Date.now().toString(36)}-${r.symbol.split('-')[0]!.toLowerCase()}`;
  const common = { kind: 'hedge', symbol: r.symbol, shape: 'pair', sizeUsd: r.sizeUsd, minLiqPct: b.minLiqPct, growLiqPct: b.growLiqPct, sliceUsd: r.sliceUsd, maxSlipBps: r.maxSlipBps, marginUsd: Math.round((r.sizeUsd / lev) * 100) / 100, leverage: lev, marginMode: 'cross', paper: false, maxLossUsd: r.maxLossUsd, onStop: 'close', endAt };
  plan.push({
    main: { ...common, side: r.side, role: 'main', pairId, partner: B, label: `${LABEL} ${r.symbol}` },
    partner: { ...common, side: r.side === 'buy' ? 'sell' : 'buy', role: 'partner', pairId, partner: A, label: `${LABEL} ${r.symbol} (2nd leg)` },
  });
  imA += r.sizeUsd / lev;
  notional += r.sizeUsd;
  fees += r.sizeUsd * 2 * 2 * ((taker + botFee) / 1e4);
  log(`${r.symbol} ${lev}x (max ${maxLev}x) at ${mark}: $${r.sizeUsd}/leg in $${r.sliceUsd} steps, A ${r.side === 'buy' ? 'long' : 'short'} / B ${r.side === 'buy' ? 'short' : 'long'}; the app's buffers at ${lev}x (a leg at full leverage starts ${b.startPct.toFixed(2)}% from its liquidation): legs shrink under ${b.minLiqPct}%, grow back above ${b.growLiqPct}%; loss limit $${r.maxLossUsd}; taker ${taker} bp + bot ${botFee} bp`);
}
for (const [i, a] of accounts.entries()) {
  const eq = Number(a?.av ?? 0);
  log(`wallet ${i ? 'B' : 'A'}: equity ${usd(eq)}, open positions ${(a?.P ?? []).length}; the plan holds ${usd(notional)} notional (${eq > 0 ? (notional / eq).toFixed(1) : '-'}x the equity), initial margin ${usd(imA)}`);
}
log(`fees in and out at full size, both wallets: ${usd(fees)} (SoDEX's taker fee + the bot fee the executor reports; each trim and grow-back adds its own); the wallets send no transactions, so no gas`);
if (!has('--go')) { log('plan only: nothing signed, nothing sent (add --go to start)'); process.exit(0); }

/* ---------------------------------------------------------------- go ----- */

if (env.LIVE_ACCEPT_TERMS !== COPY_TERMS_VERSION) throw new Error(`--go signs the copy terms ${COPY_TERMS_VERSION} for both wallets: set LIVE_ACCEPT_TERMS=${COPY_TERMS_VERSION} in ${envFile} after reading them.`);
const country = (env.LIVE_COUNTRY ?? '').trim().toUpperCase();
if (!country) throw new Error(`LIVE_COUNTRY is needed in ${envFile}`);
const th = await termsHash();
const DAY = 86_400_000;
for (const [i, t] of targets.entries()) {
  const w = wallets[i]!;
  const me = i === 0 ? meA : meB;
  if (me.terms?.termsVersion !== COPY_TERMS_VERSION) {
    await t.acceptTerms(country, th);
    log(`wallet ${w.name}: copy terms ${COPY_TERMS_VERSION} accepted`);
  }
  const key = await t.verifyKey();
  if (!key?.registered || !key.expiresAt || key.expiresAt - Date.now() < 3 * DAY) {
    if (!(await w.load())) throw new Error(`wallet ${w.name} has no SoDEX account (deposit first)`);
    const k = await t.createKey(30);
    await w.registerKey(k.name, k.address, k.days);
    for (let n = 0; n < 20; n++) {
      const x = await t.verifyKey();
      if (x?.registered && x.address.toLowerCase() === k.address.toLowerCase()) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    log(`wallet ${w.name}: executor key ${k.name} registered for ${k.days} days`);
  }
  const info = (await t.info()) as Any;
  const builderId = Number(info.builder?.id ?? 0);
  const need = Number(me.bots?.feeTenths ?? 0);
  if (builderId > 0 && need > 0) {
    const rate = await reads.builderApproval(w.address, builderId);
    if (rate === null || rate < need) {
      if (!w.accountId) await w.load();
      log(`wallet ${w.name}: builder ${builderId} approved at ${await w.approveBuilder(builderId, need)} (was ${rate ?? 'none'})`);
    }
  }
}
for (const p of plan) {
  try {
    const m = (await ta.algoStart(p.main)) as Any;
    log(`started ${p.main.symbol} main ${m.algo.id} (${m.algo.status})`);
    const q = (await tb.algoStart(p.partner)) as Any;
    log(`started ${p.main.symbol} partner ${q.algo.id} (${q.algo.status})`);
  } catch (e) {
    log(`REFUSED ${p.main.symbol}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
log('started: follow with --status --watch 60 --events');
process.exit(0);
