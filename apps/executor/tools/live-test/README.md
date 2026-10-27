# Live test: algo orders and copy trading with real money

A test suite that runs every algo order kind and copy trading **on SoDEX mainnet with real orders**, through a
real executor process started on your computer, and checks every result against **SoDEX's own account data**
(open orders and stops, order history, fills and their fees, positions, leverage, API keys, builder approvals).
It is what the unit and audit tests (`packages/copy-engine/test/audit-*.test.ts`, `apps/executor/test/audit*.test.ts`)
cannot show: that the exchange agrees.

It costs about $1.25 in fees and spread (see `--budget`); most of the deposit is margin that comes back.

## What you prepare (once)

1. **Two dedicated wallets** that hold nothing else (fresh ones are best):
   - the **follower**: the account the algos and copies trade in;
   - the **leader**: a second wallet you control; the runner trades it itself so the follower has a real
     trade to copy. Without it, the copy scenarios are skipped.
2. **Deposit USDC on SoDEX** into both (sodex.com). How much: run `--budget` (below). With BTC-USD at the
   prices of 2026-10-27 it asks about **$70 for the follower and $35 for the leader**, of which about
   **$1.25 is spent** (fees, builder fee, spread) and the rest is margin that comes back.
3. **The env file**: copy `.env.example` to `.env.live` in this folder and fill it in. Git ignores it; never
   commit it, never paste it anywhere.

   | Name | What |
   |---|---|
   | `LIVE_FOLLOWER_KEY` | the follower wallet's private key (64 hex characters) |
   | `LIVE_LEADER_KEY` | the leader wallet's private key (empty: copy scenarios skipped) |
   | `LIVE_COUNTRY` | your country of residence, two letters, as you declare it in ValueDesk (EEA: the 2x cap applies, and the suite checks it) |
   | `LIVE_ACCEPT_TERMS` | the copy terms version you read and accept, e.g. `2026-10-27.2`: the runner signs the terms in your name with it |

   The keys are read into the runner's memory only. They are never written anywhere, never put in any
   process's environment, and never sent to the executor.

You do **not** need to register anything yourself: with the private keys it holds, the runner does what
ValueDesk's copy setup asks your wallet to sign - and nothing else:

- it registers the executor's key on the follower's SoDEX account (name `vd-copy-self`, perps only, valid
  one day) - every run, since every run starts a fresh executor;
- it approves the ValueDesk builder fee ceiling (2.5 bp, the copy ladder's top step) on the follower's account,
  only if the approval there is lower;
- it registers a key of its own on each wallet (`vd-livetest-ops`, `vd-livetest-leader`, one day) for the
  leader's trades and the cleanup;
- `setup.key-import` registers one more one-day key (`vd-livetest-imp`) to test bringing your own key.

These names replace keys of the same name on those wallets - another reason to use dedicated wallets. The
keys expire by themselves after a day; the builder approval stays on the account (revoke it on sodex.com if
you like).

## How to run

From the repository folder (`npx tsx` works too; Node 22.13 or newer):

```
node node_modules/tsx/dist/cli.mjs apps/executor/tools/live-test/run.ts --budget   # what it costs; nothing signed
node node_modules/tsx/dist/cli.mjs apps/executor/tools/live-test/run.ts --dry      # the whole suite on paper: no funds, no keys
node node_modules/tsx/dist/cli.mjs apps/executor/tools/live-test/run.ts            # the real run
```

Options:

| Option | |
|---|---|
| `--only <list>` | comma-separated scenario ids (`twap.exits`), prefixes (`scale.*`), kinds (`twap`) or sections (`algo`, `copy`); the bootstrap (`setup.terms`, `setup.key`, `setup.builder`) always runs |
| `--force` | run even what already passed on this code |
| `--slow` | include the slow scenarios (`vwap.full` 15 min) |
| `--dry` | paper: every spec goes out with `paper: true` to an executor whose real orders are off; checks read the executor's paper book |
| `--budget` | print the budget and stop |
| `--adopt` | at start, close positions / cancel orders on the test markets that this runner never recorded sending (otherwise it refuses to touch them) |
| `--env <file>` | another env file |
| `--keep-data` | keep the executor's data folder at the end (it holds the executor's sealed key) |

The full run takes about 1.5 to 2 hours (most of it waiting for schedules: TWAPs of a minute or two, a 15-minute
VWAP that is cancelled after its first fill, an iceberg waiting for the tape, a trailing stop waiting for the
price to turn). Leave the window open.

What one run does:

1. Reads SoDEX's market rules and book, picks the cheaper of BTC-USD and ETH-USD as the main market (the other
   carries the basket's second leg), prints the budget.
2. Checks the env file, the country (a blocked region stops here), that both wallets have a SoDEX account and
   hold enough, stops an executor a crashed run left behind, and registers its own keys.
3. **Start-up cleanup**: if the last run may have left orders or positions (a crash, Ctrl+C twice), it flattens
   both wallets on the test markets first. If it finds positions or orders it never recorded sending, it refuses
   to start and says what it found (`--adopt` clears them).
4. Starts a real executor (`apps/executor/src/main.ts`, self-hosted for the follower wallet, its own executor id
   `vd-livetest-live`, a random loopback port, a new data folder under `.state/`, `EXECUTOR_LIVE_ALGOS=1`).
5. Runs the scenarios in order. After **every** scenario, also a failed one, it cleans up: the executor's kill
   switch, every copy stopped and closed, then straight on SoDEX every order and stop cancelled and every
   position closed (reduce-only), on both wallets, read back flat. A cleanup that cannot read the accounts flat
   stops the run.
6. At the end: a last cleanup, the executor stopped, its data folder deleted, the results printed.

## The scenarios

53 by default, 54 with `--slow`. Sizes are in U = SoDEX's $10 minimum order value plus 20% ($12): every child
order is just big enough. Each scenario says what it confirms on the exchange (`title` and `confirms` in
`scenarios/*.ts`).

- **setup** (4): terms with the declared country; the executor's key registered and listed by SoDEX; the builder
  approval; a key you made yourself imported and trading.
- **TWAP** (10): taker buy (builder fee on every order and fill), maker sell (GTX fills are maker), cancel mid-way,
  pause/resume, time-sliced reduce-only close of a position, exits (SoDEX stops placed after the first fill,
  resized to the full fill, pulled by a cancel), minimum order size (just over SoDEX's minimum; below it: failed,
  nothing sent), limit price respected, executor killed mid-schedule (no child twice, no overfill), size change
  (lowered under a resting child: pulled and sent again at the new size; raised after the first fill: ends filled at
  the new size).
- **VWAP** (1, +1 slow), **POV** (1), **Iceberg** (2: pegged post-only clips one at a time; resting clip survives a
  restart, same order, tracked), **Chase** (2), **Scale** (4: ladder at the planned prices; the ticket's DCA ladder
  paused and resumed; a partial fill; restart with resting levels), **DCA** (2), **Swarm** (1), **Conditional**
  (4: market; post-only limit through the book refused by SoDEX; close of your own position; starting a chase with
  OCO exits), **Trailing stop** (1), **Bracket** (2: take-profit fires and the stop-loss is cancelled; limit
  entry cancelled before any exit), **Basket** (2: BTC long + ETH short; TWAP legs cancelled together), **Fill
  fast** (2), **leverage** (1: SoDEX shows the leverage and isolated margin the algo set, capped for your region),
  **reduce-only** (1: a reduce-only order larger than the position ends flat, never short), **kill switch** (1:
  a ladder, an iceberg and a bracket with exits working; one cancel-all leaves no order and no stop on SoDEX).
- **Copy trading** (12), the leader traded by the runner: fixed amount (open, add, reduce, close;
  reduce-only reductions; builder fee), fixed ratio with a flip, proportional to the leader's real equity, the
  copy's leverage cap (clamp, then skip, SoDEX at 1x), stop-loss/take-profit as SoDEX stops (placed, resized,
  cancelled), paused while the leader closes then resumed, stop-and-close, executor killed while the leader adds
  (catch-up, no order twice), counter-trade, a reduction below SoDEX's minimum (reduce-only is exempt), the copy's
  amount changed between two trades, the copy's stop firing on SoDEX (at the region's highest leverage and the
  tightest stops; inconclusive, not failed, when the market does not move far enough in 20 minutes). The fixed-amount
  scenario also times every copy: leader fill to copy fill by SoDEX's own timestamps, median under 1 s.

## Resume, and reading the results

The results are in `.state/live.json` (`.state/dry.json` for `--dry`; a practice run never marks a real one
passed). Per scenario: `status` (passed, failed, inconclusive, skipped, pending), the `hash` of the code it ran
on, times, attempts, the error, the checks that held, notes, and the fees SoDEX charged it.

- **Run it again** to resume: what **passed on the same code** is skipped; failed, inconclusive (the market did
  not do what the scenario waited for in time - a take-profit not reached, a quiet tape), interrupted and never
  run scenarios run. The hash covers the engine and executor files a scenario depends on and the harness (copy
  scenarios: the copy runtime, planner, feeds; algo scenarios: the algo engine; both: the SoDEX layer, the
  executor), so a code change re-runs exactly what it may have broken.
- `--only twap.exits --force` runs one scenario again on purpose.
- The executor's log of a run is `.state/executor-live-<time>.log`.
- On screen: each check as it holds (`ok ...`), `-- live only` for what a dry run cannot check, and a RESULTS table.
  Exit code 0 when nothing failed.

## Aborting safely

- **Ctrl+C once**: the running scenario is abandoned, the cleanup runs (kill switch, copies stopped and closed,
  every order cancelled and every position closed on SoDEX, read back flat), the state is saved, and the runner
  exits. Wait for it.
- **Ctrl+C twice** (or a crash, a power cut): the runner stops at once. The state file still says which scenario
  was running and that the account may be exposed; **the next start flattens first**. If you do not want to run
  again, close the positions and cancel the orders on sodex.com yourself (BTC-USD and ETH-USD, both wallets).
- The protective stops (exits, copy stop-losses) are held by SoDEX, not by this runner: an open position keeps
  them while nothing runs.
- The executor is a separate process; the runner stops it on every way out it can, and the next start stops one
  a crash left behind (only if it answers as this runner's executor).

## Dry run

`--dry` needs no funds and no env file. Throwaway wallets, an executor with real orders off, every spec sent with
`paper: true` (refused before signing otherwise): fills are simulated from the live book and tape by the engine
itself. It runs every scenario's actions and the checks a paper book can answer (status, filled vs target,
children, exits, resting orders, pause/resume, restart with the same data); what only SoDEX can answer is counted
as "live only". Copy scenarios run their lifecycle (start, pause, resume, change, restart, stop) without leader
trades - a dry leader has no funds. Scenarios that need a real position first (a reduce-only close, a conditional
close) only check that the executor accepts their spec.

## Files

| File | |
|---|---|
| `run.ts` | the runner (options, bootstrap, the loop, the cleanup after every scenario) |
| `scenarios/setup.ts`, `scenarios/algos.ts`, `scenarios/copy.ts` | the catalogue; `catalogue.ts` puts them in order |
| `harness.ts` | what a scenario works with (`T`): sizes, checks, the follower's account (SoDEX or paper), the leader, restarts |
| `exchange.ts` | SoDEX reads, and the harness's own writes (registration, approval, IOCs, cancels) |
| `executor.ts` | the executor process and its signed API |
| `cleanup.ts`, `state.ts`, `hash.ts`, `budget.ts` | flattening, the state file, the code hash, the budget |
| `../../test/live-test-runner.test.ts` | unit tests of the runner's rules (resume, skip, hash, crash repair, cleanup, budget) |
