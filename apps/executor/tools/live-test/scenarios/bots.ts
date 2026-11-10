/**
 * Bots on a real exchange (the Bots page's volume maker and grid: algo kinds 'mm' and 'grid' with
 * bot: true) at the smallest size SoDEX takes, and the numbers the owner asked for (2026-11-02): volume, the fees
 * SoDEX charged, the builder fee, net PnL and the cost per $1M - from SoDEX's own fills, not the executor's book.
 *
 * What only SoDEX can show: every quote rests (post-only, maker fills), every order carries the BOT fee (0.1 bp,
 * not the copy ladder), the executor's book agrees with SoDEX's fills, a stop closes what the bot holds and leaves
 * nothing resting, the kill switch pulls everything without trading, and a hard restart neither doubles a quote nor
 * forgets one.
 *
 * Each run's figures go to .state/bot-numbers.jsonl (one JSON line a run) and into the scenario's notes. How long a
 * strategy runs: LIVE_BOT_MINUTES (default 10); each stops sooner at its volume target.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlgoView } from '../../../../../packages/copy-engine/src/index.ts';
import type { FillInfo } from '../exchange.ts';
import { algoPrefix, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/bots.ts';
const MIN = 60_000;
const BOT_FEE = 1;
const RUN_MS = Math.max(2, Number(process.env.LIVE_BOT_MINUTES ?? 10) || 10) * MIN;
const NUMBERS = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'bot-numbers.jsonl');
/** Tuning for an iteration, without a code change: JSON merged over the scenario's own settings (and recorded with its numbers). */
const tuning = (name: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(process.env[name] ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const MM_TUNING = tuning('LIVE_BOT_MM');
/**
 * What a new bot quotes with in the product (web bots/presets.ts: strategy 'market' = R10, the best of the live tests,
 * and the setting Explore estimates every market with; maxSpreadBps 20 on by default). bot.makers runs this unless
 * LIVE_BOT_MM says otherwise (owner 2026-11-09: "default settings should be the best of live/tests" - an evening run on
 * a hand-made chase-every-second setting tested nothing the product or Explore offers).
 */
const PRODUCT_MM = { ref: 'binance', restMs: 10_000, offsetTicks: 0, skewTicks: 0, chaseTicks: 40, minRepriceMs: 1_000, maxSpreadBps: 20 } as const;
const GRID_TUNING = tuning('LIVE_BOT_GRID');

const ended = (v: AlgoView) => ['done', 'cancelled', 'expired', 'failed'].includes(v.algo.status);

function bot(id: string, kind: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run' | 'timeoutMs'>): Scenario {
  return { id, section: 'algo', kind, title, confirms, deps: ['algo'], source: SOURCE, dry: 'full', slow: true, ...o };
}

/** What SoDEX's fills say a bot did: volume, fees, net PnL at `mark`, cost per $1M. */
export function fillNumbers(fills: FillInfo[], mark: number) {
  let buyQty = 0, buyVal = 0, sellQty = 0, sellVal = 0, fees = 0, builder = 0, makerVal = 0;
  for (const f of fills) {
    const v = f.qty * f.price;
    if (f.side === 'buy') { buyQty += f.qty; buyVal += v; } else { sellQty += f.qty; sellVal += v; }
    fees += f.fee;
    builder += f.builderFee;
    if (f.maker) makerVal += v;
  }
  const volume = buyVal + sellVal;
  const inventory = buyQty - sellQty;
  const gross = sellVal - buyVal + inventory * mark;
  const net = gross - fees;
  return {
    fills: fills.length,
    volume,
    venueFees: fees - builder,
    builderFees: builder,
    gross,
    net,
    inventory,
    makerShare: volume > 0 ? makerVal / volume : 0,
    costPerMillion: volume > 0 ? (-net / volume) * 1_000_000 : null,
    feesPerMillion: volume > 0 ? (fees / volume) * 1_000_000 : null,
  };
}

const usd = (x: number) => `$${x.toFixed(x !== 0 && Math.abs(x) < 1 ? 4 : 2)}`;

/** The bot's own fills on SoDEX (paged), its numbers, written to the run's record. */
async function report(t: T, v: AlgoView, what: string, extra: Record<string, unknown> = {}, symbol = t.main.name): Promise<ReturnType<typeof fillNumbers> | null> {
  t.note(`${what} ended ${v.algo.status}: ${v.algo.statusReason ?? '-'} (rejects ${v.algo.rejects})`);
  if (v.algo.rejects > 0) {
    const errs = (await t.exec.events(v.algo.id, 300).catch(() => [])).filter((e) => e.kind === 'error').map((e) => e.text.replace(/^SoDEX (refused|rejected) [^:]*: ?/, ''));
    const counts = new Map<string, number>();
    for (const x of errs) counts.set(x, (counts.get(x) ?? 0) + 1);
    t.note(`${what} refusals: ${[...counts].map(([x, n]) => `${n}x ${x}`).join('; ') || '-'}`);
  }
  if (t.dry) {
    t.note(`${what} (paper): book volume ${usd(v.bot?.volume ?? 0)}, net ${usd(v.bot?.netPnl ?? 0)}`);
    return null;
  }
  const p = algoPrefix(v.algo.id);
  // SoDEX's trades lag the matching by tens of seconds: read until they hold what the executor booked.
  let mine: FillInfo[] = [];
  await t
    .waitFor(`${t.where}'s trades catch up with the bot's book`, async () => {
      mine = (await t.env.reads.allFills(t.env.followerAddress, symbol, t.startedAt)).filter((f) => f.clOrdID?.startsWith(p));
      const vol = mine.reduce((x, f) => x + f.qty * f.price, 0);
      return Math.abs(vol - (v.bot?.volume ?? 0)) <= Math.max(1, (v.bot?.volume ?? 0) * 0.01) ? true : null;
    }, { timeoutMs: 90_000, everyMs: 10_000 })
    .catch(() => undefined);
  const q = await t.quote(symbol);
  const mark = (q.bid + q.ask) / 2;
  const n = fillNumbers(mine, mark);
  t.check(Math.abs(n.volume - (v.bot?.volume ?? 0)) <= Math.max(1, n.volume * 0.02), `the executor's book (${usd(v.bot?.volume ?? 0)}) agrees with ${t.where}'s fills (${usd(n.volume)})`);
  const line = {
    at: new Date().toISOString(),
    scenario: t.id,
    strategy: v.algo.spec.kind,
    symbol: v.algo.spec.symbol,
    minutes: Math.round(((v.algo.endedAt ?? Date.now()) - (v.algo.startedAt ?? v.algo.createdAt)) / 6_000) / 10,
    ...n,
    // Per $1M: SoDEX's fee and ours, what the spread and the price did (gross: spread earned less adverse selection), net.
    perMillion: n.volume > 0 ? { fees: ((n.venueFees + n.builderFees) / n.volume) * 1e6, gross: (n.gross / n.volume) * 1e6, net: (-n.net / n.volume) * 1e6 } : null,
    status: v.algo.status,
    reason: v.algo.statusReason,
    rejects: v.algo.rejects,
    book: v.bot ? { volume: v.bot.volume, net: v.bot.netPnl, tradeFees: v.bot.tradeFees, builderFees: v.bot.builderFees } : null,
    ...extra,
  };
  try {
    mkdirSync(dirname(NUMBERS), { recursive: true });
    appendFileSync(NUMBERS, `${JSON.stringify(line)}\n`);
  } catch {
    /* the notes carry it too */
  }
  t.note(`${what}: ${n.fills} fills, volume ${usd(n.volume)}, SoDEX fees ${usd(n.venueFees)}, builder ${usd(n.builderFees)}, net PnL ${usd(n.net)}, ${Math.round(n.makerShare * 100)}% maker, cost per $1M ${n.costPerMillion === null ? '-' : usd(n.costPerMillion)} (fees alone ${n.feesPerMillion === null ? '-' : usd(n.feesPerMillion)})`);
  if (mine.length) await t.checkBuilderFee(mine, BOT_FEE);
  return n;
}

/** Run the bot until `until` holds or the time is up, then stop it (it closes what it holds) and wait it out. */
async function runThenStop(t: T, v0: AlgoView, until: (v: AlgoView) => boolean, runMs = RUN_MS): Promise<AlgoView> {
  await t
    .waitAlgo(v0.algo.id, 'the bot reaches its target, or the time is up', (v) => until(v) || ended(v), { timeoutMs: runMs, everyMs: 15_000 })
    .catch(() => undefined);
  const before = await t.view(v0.algo.id);
  if (!ended(before)) await t.exec.algoAct('cancel', v0.algo.id);
  return t.waitEnded(v0.algo.id, 4 * MIN);
}

async function nothingResting(t: T, id: string, symbol = t.main.name): Promise<void> {
  await t.waitFor(`nothing of ${id} rests on ${t.where}`, async () => ((await t.algoOrders(id, symbol)).length === 0 ? true : null), { timeoutMs: 30_000 });
}

/** The markets bot.makers runs on at once (LIVE_BOT_SYMBOLS, comma-separated); the runner flattens them at the end too. */
export const BOT_SYMBOLS = (process.env.LIVE_BOT_SYMBOLS ?? 'ETH-USD,ZEC-USD,SOL-USD').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

export const BOT_SCENARIOS: Scenario[] = [
  bot('bot.makers', 'mm', 'Volume makers on several markets at once (LIVE_BOT_SYMBOLS), side by side over the same minutes', 'each market\'s quotes rest (maker fills, the 0.1 bp bot fee), each book agrees with SoDEX, each stop closes and leaves nothing resting; per market: fills, volume, maker share, fees, gross and net per $1M', {
    timeoutMs: RUN_MS + 12 * MIN,
    // What each can hold is its inventory cap (LIVE_BOT_MM maxInventoryUsd, else 3 orders): all of them at once at the peak.
    cost: (U) => {
      const cap = typeof MM_TUNING.maxInventoryUsd === 'number' ? MM_TUNING.maxInventoryUsd : 3 * U;
      return { takerUsd: cap * BOT_SYMBOLS.length, makerUsd: 60 * U * BOT_SYMBOLS.length, peakUsd: cap * BOT_SYMBOLS.length };
    },
    async run(t) {
      const started: AlgoView[] = [];
      try {
        for (const symbol of BOT_SYMBOLS) {
          started.push(await t.start({ kind: 'mm', symbol, orderUsd: t.U, maxInventoryUsd: 2 * t.U, ...PRODUCT_MM, maxLossUsd: 2, volumeTargetUsd: 10_000 * t.U, onStop: 'close', ...MM_TUNING }));
        }
      } catch (e) {
        // One refused start (margin, a market conflict) must not leave the others running past the scenario.
        for (const v0 of started) await t.exec.algoAct('cancel', v0.algo.id).catch(() => undefined);
        throw e;
      }
      // LIVE_BOT_VIP=1 (owner 2026-11-09, the bots live as VIP): the wallet's one signed move hands them all to the VIP
      // executor; they run, stop and are reported there (at the VIP bot fee).
      if (process.env.LIVE_BOT_VIP === '1') {
        const target = t.exec as unknown as { moveToVip?: () => Promise<{ job: Record<string, unknown>; ms: number }>; me(): Promise<{ bots?: { feeTenths: number; vip: boolean } }> };
        if (!target.moveToVip) throw new Error('LIVE_BOT_VIP=1 needs --target hosted');
        await new Promise((r) => setTimeout(r, 45_000)); // quoting first: the move takes resting orders across
        const before = await Promise.all(started.map((x) => t.view(x.algo.id)));
        const { job, ms } = await target.moveToVip();
        t.check(job.state === 'done', `moved to VIP with one signature in ${ms} ms (job ${String(job.id ?? '')})`);
        const after = await Promise.all(started.map((x) => t.view(x.algo.id)));
        for (let i = 0; i < after.length; i++) {
          const a0 = before[i]!, a1 = after[i]!;
          t.check(a1.algo.status === 'running' || ended(a1), `${a1.algo.spec.symbol}: runs on VIP (${a1.algo.status})`);
          t.check(Math.abs((a1.bot?.inventory ?? 0) - (a0.bot?.inventory ?? 0)) < 1e-9 || (a1.bot?.volume ?? 0) > (a0.bot?.volume ?? 0), `${a1.algo.spec.symbol}: its book came along (holding ${a0.bot?.inventory ?? 0} -> ${a1.bot?.inventory ?? 0})`);
        }
        const fee = (await target.me()).bots;
        t.check(fee?.vip === true && fee.feeTenths === 1, `the wallet pays the VIP bot fee on VIP (${JSON.stringify(fee)})`);
      }
      // All run the same minutes; then each stops (closing what it holds) and is reported on its own market.
      for (const end = Date.now() + RUN_MS; Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, Math.min(30_000, Math.max(0, end - Date.now()))));
        if ((await Promise.all(started.map((x) => t.view(x.algo.id)))).every(ended)) break;
      }
      for (const v0 of started) if (!ended(await t.view(v0.algo.id))) await t.exec.algoAct('cancel', v0.algo.id);
      for (const v0 of started) {
        const v = await t.waitEnded(v0.algo.id, 4 * MIN);
        const symbol = v.algo.spec.symbol;
        await nothingResting(t, v.algo.id, symbol);
        t.check(v.algo.children.filter((c) => !c.tag.startsWith('close')).every((c) => c.tif === 'gtx'), `${symbol}: every quote went out post-only (GTX)`);
        const n = await report(t, v, `volume maker ${symbol}`, { tuning: MM_TUNING }, symbol);
        if (n) t.check(n.makerShare >= 0.8 || n.volume < 4 * t.U, `${symbol}: the volume is maker volume (${Math.round(n.makerShare * 100)}%)`);
      }
    },
  }),

  bot('bot.maker', 'mm', 'Volume maker: quotes both sides post-only, then stops and closes', 'every quote rests (maker fills only, the 0.1 bp bot fee on each), the book agrees with SoDEX, a stop closes what it holds and leaves nothing resting; the run\'s volume, fees, net PnL and cost per $1M', {
    timeoutMs: RUN_MS + 8 * MIN,
    cost: (U) => ({ takerUsd: 3 * U, makerUsd: 60 * U, peakUsd: 3 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'mm', orderUsd: t.U, maxInventoryUsd: 3 * t.U, skewTicks: 3, chaseTicks: 2, minRepriceMs: 3_000, maxLossUsd: 2, volumeTargetUsd: 60 * t.U, onStop: 'close', ...MM_TUNING });
      t.check(v0.algo.spec.bot === true, 'it runs as a bot');
      await t.waitFor('both quotes rest on the book', async () => ((await t.algoOrders(v0.algo.id)).length >= 2 ? true : null), { timeoutMs: 60_000, inconclusive: true });
      const v = await runThenStop(t, v0, (x) => (x.bot?.volume ?? 0) >= 60 * t.U);
      await nothingResting(t, v.algo.id);
      const kids = v.algo.children.filter((c) => !c.tag.startsWith('close'));
      t.check(kids.every((c) => c.tif === 'gtx'), 'every quote went out post-only (GTX)');
      const n = await report(t, v, 'volume maker', { tuning: MM_TUNING });
      if (n) t.check(n.makerShare >= 0.8 || n.volume < 4 * t.U, `the volume is maker volume (${Math.round(n.makerShare * 100)}%; only a closing taker may not be)`);
      if (!t.dry) {
        const pos = await t.account.position(t.main.name);
        t.check(Math.abs(pos) * (await t.quote()).bid < t.main.minNotional * 1.1, `what it held is closed (position ${pos})`);
      }
    },
  }),

  bot('bot.grid', 'grid', 'Grid: post-only levels around the price, a fill moves the gap', 'every level rests post-only, a filled buy puts a sell one level up (and back), the 0.1 bp bot fee on each fill; the run\'s volume, fees, net PnL and cost per $1M', {
    timeoutMs: RUN_MS + 8 * MIN,
    cost: (U) => ({ takerUsd: 3 * U, makerUsd: 30 * U, peakUsd: 4 * U }),
    async run(t) {
      const q = await t.quote();
      const mid = (q.bid + q.ask) / 2;
      // A narrow range (±0.25%) so a 10-minute run sees round trips on BTC/ETH; 6 levels, each one SoDEX minimum.
      const half = typeof GRID_TUNING.rangePct === 'number' ? GRID_TUNING.rangePct : 0.0025;
      const { rangePct: _r, ...gridRest } = GRID_TUNING;
      const v0 = await t.start({ kind: 'grid', low: t.tick(mid * (1 - half), undefined, 'up'), high: t.tick(mid * (1 + half), undefined, 'down'), levels: 6, orderUsd: t.U, spacing: 'linear', outOfRange: 'wait', maxLossUsd: 2, volumeTargetUsd: 30 * t.U, onStop: 'close', ...gridRest });
      await t.waitFor('its levels rest on the book', async () => ((await t.algoOrders(v0.algo.id)).length >= 3 ? true : null), { timeoutMs: 60_000, inconclusive: true });
      const v = await runThenStop(t, v0, (x) => (x.bot?.volume ?? 0) >= 30 * t.U);
      await nothingResting(t, v.algo.id);
      t.check(v.algo.children.filter((c) => c.tag.startsWith('grid')).every((c) => c.tif === 'gtx'), 'every level went out post-only (GTX)');
      await report(t, v, 'grid', { range: [(v.algo.spec as { low: number }).low, (v.algo.spec as { high: number }).high], tuning: GRID_TUNING });
    },
  }),

  bot('bot.kill', 'mm', 'The kill switch on a running bot', 'cancel-all ends the bot at once and pulls its quotes: no close is sent, nothing rests', {
    timeoutMs: 4 * MIN,
    slow: false,
    cost: (U) => ({ takerUsd: 0, makerUsd: 2 * U, peakUsd: 2 * U }),
    async run(t) {
      // Quotes a few ticks behind the touch: resting, unlikely to fill in the seconds it lives.
      const v0 = await t.start({ kind: 'mm', orderUsd: t.U, maxInventoryUsd: 2 * t.U, offsetTicks: 20, chaseTicks: 40, minRepriceMs: 10_000, maxLossUsd: 2, onStop: 'close' });
      await t.waitFor('both quotes rest', async () => ((await t.algoOrders(v0.algo.id)).length >= 2 ? true : null), { timeoutMs: 60_000, inconclusive: true });
      const sentBefore = (await t.view(v0.algo.id)).algo.childCount;
      await t.exec.algoAct('cancel-all');
      const v = await t.waitEnded(v0.algo.id, 60_000);
      t.check(v.algo.status === 'cancelled', `ended cancelled at once (${v.algo.status})`);
      t.check(v.algo.childCount === sentBefore, 'nothing was sent after the kill switch (no close)');
      await nothingResting(t, v.algo.id);
    },
  }),

  bot('bot.restart', 'mm', 'A volume maker with the executor killed mid-run', 'after a hard kill and restart its quotes are found again: no client order id twice, never two quotes on one side, the book keeps what filled', {
    needs: ['restart'],
    timeoutMs: 8 * MIN,
    slow: false,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 8 * U, peakUsd: 2 * U }),
    async run(t) {
      const v0 = await t.start({ kind: 'mm', orderUsd: t.U, maxInventoryUsd: 2 * t.U, chaseTicks: 2, minRepriceMs: 3_000, maxLossUsd: 2, onStop: 'close' });
      await t.waitFor('both quotes rest', async () => ((await t.algoOrders(v0.algo.id)).length >= 2 ? true : null), { timeoutMs: 60_000, inconclusive: true });
      const before = await t.view(v0.algo.id);
      await t.restart({ downMs: 10_000 });
      await t.waitAlgo(v0.algo.id, 'it quotes again after the restart', (v) => v.algo.status === 'running' && (v.bot?.orders.length ?? 0) >= 1, { timeoutMs: 2 * MIN });
      const after = await t.view(v0.algo.id);
      t.check((after.bot?.fills ?? 0) >= (before.bot?.fills ?? 0), 'the book kept what filled before the kill');
      await t.live('never two quotes resting on one side', async () => {
        const open = await t.algoOrders(v0.algo.id);
        t.check(open.filter((o) => o.side === 'buy').length <= 1 && open.filter((o) => o.side === 'sell').length <= 1, `${open.length} resting`);
      });
      await t.exec.algoAct('cancel', v0.algo.id);
      const v = await t.waitEnded(v0.algo.id, 4 * MIN);
      await t.live('SoDEX saw every client order id once', async () => {
        const ids = (await t.account.history(t.main.name)).filter((o) => o.clOrdID?.startsWith(algoPrefix(v.algo.id))).map((o) => o.clOrdID);
        t.check(new Set(ids).size === ids.length, `${ids.length} orders, all distinct`);
      });
      await nothingResting(t, v.algo.id);
    },
  }),
];
