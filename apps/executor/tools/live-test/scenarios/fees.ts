/**
 * The copy fee ladder on a real exchange: the builder fee an executor's orders
 * carry is the step of the follower's verified 14-day volume (policy.ts
 * COPY_FEE_LADDER: 2.5 / 2 / 1.5 / 1.2 / 1 bp from $0 / 100k / 500k / 2M / 10M),
 * read from the API server's ledger (EXECUTOR_BUILDER_URL). Here the runner
 * answers those reads itself (feeStub.ts, self target only: capability
 * localFeeStub), so the follower can be put on every step, and SoDEX's own
 * order history (the builder feeRate of each order) and fills (the builderFee
 * charged) are read for what the orders carried.
 *
 * Per step: the volume just under its boundary (the step below applies) and
 * at it (this step), each with a restart of the executor first - it keeps an
 * answer 10 minutes, a restart forgets it - and one cheap round: a market buy
 * of U and a reduce-only market sell of what it filled. And what a failing
 * ledger does: a failure after a good answer keeps the step of that answer; a
 * failure from the first read is the first (dearest) step.
 *
 * The follower's approval stays at COPY_FEE_MAX (setup.builder), which covers
 * every step. A dry run reads the fee from the executor's own paper book (what
 * it charged beyond SoDEX's taker fee); SoDEX's fields are live only.
 */
import { COPY_FEE_LADDER, type AlgoView, type CopyFeeStep } from '../../../../../packages/copy-engine/src/index.ts';
import type { VolumeStub } from '../feeStub.ts';
import { Unavailable, algoPrefix, type T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/fees.ts';
const MIN = 60_000;
/** How long the executor uses a volume answer before it asks again (apps/executor/src/service.ts VOLUME_TTL_MS). */
const EXECUTOR_VOLUME_TTL_MS = 10 * MIN;

function fee(id: string, title: string, confirms: string, o: Partial<Scenario> & Pick<Scenario, 'cost' | 'run' | 'timeoutMs'>): Scenario {
  return { id, section: 'fee', kind: 'fee', title, confirms, deps: ['algo'], source: SOURCE, dry: 'full', needs: ['localFeeStub', 'restart'], ...o };
}

function stubOf(t: T): VolumeStub {
  if (!t.env.feeStub) throw new Unavailable('the volume stub answers only an executor started here (--target self)');
  return t.env.feeStub;
}

/** The ladder the executor's /info names (what its orders are charged by). */
async function ladderOf(t: T): Promise<CopyFeeStep[]> {
  const l = (await t.exec.info()).builder?.ladder ?? [];
  if (!l.length) throw new Unavailable('the executor charges no builder fee (no ladder in its /info)');
  return l;
}

const usdText = (x: number) => `$${x.toLocaleString('en-US')}`;
const done = (v: AlgoView) => v.algo.status === 'done';

/**
 * The executor reads the follower's volume on a new session: sign in again and
 * wait for the stub to see it, asked as the API server is asked (the token, the
 * follower, the builder, 14 days). Returns the index of that read.
 */
async function volumeRead(t: T, stub: VolumeStub, what: string): Promise<number> {
  const from = stub.reads.length;
  await t.exec.signIn();
  await t.waitFor(`the executor read the follower's volume (${what})`, async () => (stub.reads.length > from ? true : null), { timeoutMs: 20_000, everyMs: 250 });
  t.check(stub.problems(from).length === 0, 'it asked for the follower\'s 14-day volume, with the internal token', stub.problems(from));
  // The answer is in the executor's memory a moment after the stub sent it.
  await t.sleep(1_000);
  return from;
}

/** What the executor's own book charged beyond SoDEX's taker fee, in tenths of a bp of the value (its estimate at the fill price). */
const builderSeen = (t: T, v: AlgoView): number => ((v.algo.fees - v.algo.filledValue * t.main.takerFee) / v.algo.filledValue) * 100_000;

/**
 * One cheap round at the volume the executor holds now: a market buy of U, then
 * a market sell of what it filled (reduce-only; on paper a plain sell, there is
 * no position on SoDEX to reduce). Both must carry `want`: in the executor's
 * book, in SoDEX's order history and in SoDEX's fills.
 */
async function round(t: T, want: number, what: string): Promise<void> {
  const when = [{ type: 'spread', symbol: t.main.name, op: 'below', bps: 50 }];
  const b0 = await t.start({ kind: 'conditional', conditions: when, holdMs: 0, then: { type: 'market', quantity: await t.qty(t.U), slippageBps: 20 } });
  const buy = await t.waitAlgo(b0.algo.id, `the buy filled (${what})`, done, { timeoutMs: 90_000 });
  const decimals = (t.main.stepSize.split('.')[1] ?? '').length;
  const s0 = await t.start({ kind: 'conditional', side: 'sell', reduceOnly: !t.dry, conditions: when, holdMs: 0, then: { type: 'market', quantity: buy.algo.filled.toFixed(decimals), slippageBps: 30 } });
  const sell = await t.waitAlgo(s0.algo.id, `the sell filled (${what})`, done, { timeoutMs: 90_000 });
  for (const v of [buy, sell]) {
    const seen = builderSeen(t, v);
    t.check(Math.abs(seen - want) < 0.5, `the executor charged ${v.algo.spec.side} ${v.algo.id} builder fee ${want} (${want / 10} bp)`, { seen: Number(seen.toFixed(2)) });
  }
  await t.live(`SoDEX's order history names builder fee ${want} on both orders, and its fills charge it`, async () => {
    // SoDEX's order history can lag the fills by some seconds (2026-10-29: 0 of 2 listed 22 s after).
    const ofRound = async () => (await t.account.history(t.main.name)).filter((o) => [buy, sell].some((v) => o.clOrdID?.startsWith(algoPrefix(v.algo.id))));
    const mine = await t.waitFor('SoDEX lists both orders of the round', async () => {
      const os = await ofRound();
      return os.length >= 2 ? os : null;
    }, { timeoutMs: 60_000, everyMs: 5_000 });
    t.check(mine.length >= 2, `SoDEX lists ${mine.length} orders of the round`);
    t.checkOrderFees(mine, want);
    await t.checkBuilderFee([...(await t.algoFills(buy.algo.id)), ...(await t.algoFills(sell.algo.id))], want);
  });
}

/** The id of a step: fee.tier-0, fee.tier-100k, fee.tier-2m... */
const tierId = (fromUsd: number): string => `fee.tier-${fromUsd >= 1e6 ? `${fromUsd / 1e6}m` : fromUsd >= 1e3 ? `${fromUsd / 1e3}k` : fromUsd}`;

/** One scenario per step of the ladder, built from this checkout's; at run time the step is read from the executor's /info. */
function tier(i: number, compiled: CopyFeeStep): Scenario {
  const first = i === 0;
  return fee(
    tierId(compiled.fromUsd),
    `Builder fee step ${i + 1}: ${compiled.fee / 10} bp from ${usdText(compiled.fromUsd)} of 14-day volume`,
    first ? `at ${usdText(0)} the orders carry ${compiled.fee / 10} bp on SoDEX (order history and fills)` : `just under ${usdText(compiled.fromUsd)} the orders carry the step below, at it ${compiled.fee / 10} bp: on SoDEX's order history and fills`,
    {
      timeoutMs: (first ? 4 : 7) * MIN,
      cost: (U) => ({ takerUsd: (first ? 2 : 4) * U, makerUsd: 0, peakUsd: U }),
      async run(t) {
        const stub = stubOf(t);
        const ladder = await ladderOf(t);
        const step = ladder[i];
        if (!step) throw new Unavailable(`the executor's ladder has no step ${i + 1}`);
        const cases = first
          ? [{ usd: step.fromUsd, want: step.fee, what: `${usdText(step.fromUsd)} of volume` }]
          : [
              { usd: step.fromUsd - 1, want: ladder[i - 1]!.fee, what: `${usdText(step.fromUsd - 1)}, just under` },
              { usd: step.fromUsd, want: step.fee, what: `${usdText(step.fromUsd)}, at the boundary` },
            ];
        for (const c of cases) {
          stub.answer = { usd: c.usd };
          // It holds the last answer 10 minutes: a restart forgets it.
          await t.restart();
          await volumeRead(t, stub, c.what);
          await round(t, c.want, c.what);
        }
      },
    },
  );
}

export const FEE_SCENARIOS: Scenario[] = [
  ...COPY_FEE_LADDER.map((s, i) => tier(i, s)),
  fee('fee.fail-first', 'The volume cannot be read from the first read on', 'a ledger that fails (HTTP 500) before any answer leaves the follower on the first step, never a lower one', {
    timeoutMs: 4 * MIN,
    cost: (U) => ({ takerUsd: 2 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const stub = stubOf(t);
      const ladder = await ladderOf(t);
      stub.answer = { status: 500 };
      await t.restart();
      const from = await volumeRead(t, stub, 'answered with HTTP 500');
      t.check(stub.reads.slice(from).every((r) => r.status === 500), 'the stub failed every read');
      await round(t, ladder[0]!.fee, 'nothing known');
    },
  }),
  fee('fee.keep-last', 'The volume read fails after a good answer', 'a ledger that fails after a good answer keeps the step of that answer (the executor asks again after 10 minutes and keeps what it had)', {
    // The executor asks again only once its answer is 10 minutes old.
    slow: true,
    timeoutMs: 18 * MIN,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: U }),
    async run(t) {
      const stub = stubOf(t);
      const ladder = await ladderOf(t);
      const step = ladder[Math.min(2, ladder.length - 1)]!;
      stub.answer = { usd: step.fromUsd };
      await t.restart();
      const good = await volumeRead(t, stub, `${usdText(step.fromUsd)} of volume`);
      await round(t, step.fee, 'the good answer');
      stub.answer = { status: 500 };
      const until = stub.reads[good]!.at + EXECUTOR_VOLUME_TTL_MS + 30_000;
      t.note(`the stub fails from now on; waiting until the executor's answer is older than 10 minutes (${new Date(until).toISOString()})`);
      await t.waitFor('the executor\'s volume answer is older than 10 minutes', async () => (Date.now() >= until ? true : null), { timeoutMs: EXECUTOR_VOLUME_TTL_MS + 60_000, everyMs: 5_000 });
      const from = await volumeRead(t, stub, 'answered with HTTP 500');
      t.check(stub.reads.slice(from).some((r) => r.status === 500), 'the executor asked again and the stub failed');
      await round(t, step.fee, 'after the failed read');
    },
  }),
];
