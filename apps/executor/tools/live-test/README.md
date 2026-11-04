# Live test: algo orders and copy trading with real money

A test suite that runs every algo order kind and copy trading **on SoDEX mainnet with real orders**, through a
real executor - by default one started on your computer, or ValueDesk's own executor (`--target`, below) - and
checks every result against **SoDEX's own account data** (open orders and stops, order history, fills and their
fees, positions, leverage, API keys, builder approvals). It is what the unit and audit tests
(`packages/copy-engine/test/audit-*.test.ts`, `apps/executor/test/audit*.test.ts`) cannot show: that the exchange
agrees.

It costs about $2.80 to $3.30 in fees and spread (see `--budget`; the option matrix, `mx.*`, is $0.78 of it); most of the deposit is margin that comes back.
`--slow` adds the two liquidation scenarios, which let SoDEX liquidate a $12 position on purpose: at most $0.65
each, about $0.35 when SoDEX lets the harness take the position to the market's 40x ("Liquidations", below).

## Start here

**Prepare once** (details in "What you prepare" and "Targets" below):

- Two dedicated wallets: the follower (on SoDEX) and a leader (on SoDEX, and/or on Hyperliquid).
- Fund them as `node node_modules/tsx/dist/cli.mjs apps/executor/tools/live-test/run.ts --budget` says (with
  `LIVE_LEADER_VENUE=hyperliquid` in the environment for a Hyperliquid leader); the preflight below checks it again.
- `.env.live` in this folder, from `.env.example`: `LIVE_FOLLOWER_KEY`, `LIVE_LEADER_KEY` and/or `LIVE_HL_LEADER_KEY`,
  `LIVE_COUNTRY`, `LIVE_ACCEPT_TERMS`. `LIVE_LEADER_VENUE` may stay empty: each part sets it.
- Browser part: the dev web running from this checkout (`npm run dev` in `apps/web`, or the preview `valuescan-web`),
  and in `apps/web/.env.local` `VITE_LIVE_ALGOS_WALLETS=<the follower's address>` and the builder lines
  (`VITE_BUILDER_ID`, `VITE_BUILDER_FEE_PERPS`, ...) as `deploy/vercel/production.settings` has them; restart the dev
  web after a change.
- Hosted part: the follower's address in `EXECUTOR_LIVE_ALGOS_WALLETS` on server 2 (else its algo scenarios are
  inconclusive; copies need nothing).

**Start**: double-click `START-LIVE-TESTS.cmd` in this folder, or from the repository folder `npm run live-tests`
(`npm run live-tests -- --dry` runs it all on paper first: no funds, no keys). It runs, one after another and each in
its own process (`all.ts`):

1. `self` with the SoDEX leader: everything;
2. `self-hl` with the Hyperliquid leader, when `LIVE_HL_LEADER_KEY` is set: the copy scenarios only (nothing else
   involves the leader, and what passed in part 1 stands for it);
3. `hosted`, ValueDesk's executor;
4. `browser`, when the dev web answers.

The preflight comes first, a checklist that never prints a secret: which env names are set or empty, the country and
the terms version, both wallets' accounts and balances against what each part costs, whether ValueDesk's executor
answers (whether it lets the follower run real algos is not in its `/info` or `/me`: unknown until the first algo),
whether the dev web answers and serves this checkout. A part whose precondition fails is skipped with the reason; the
others run. A real-money run waits 10 s before it starts (`--yes` does not). Options, passed to every part: `--dry`,
`--targets self,hosted,browser`, `--leaders sodex,hyperliquid`, `--only`, `--slow`, `--force`, `--env`, `--web`,
`--headed` (`--help` lists them).

**Watch**: one line per scenario, `[self] twap.exits ... passed 41 s`, with the part's tally and the fees so far. From
a second window: `START-LIVE-TESTS.cmd --status` (or `node --import tsx apps/executor/tools/live-test/all.ts --status`
from the repository folder). `.state/progress.json` is the same, machine-readable, written after every scenario; each
part's whole output is in `.state/<part>-<time>.log`.

**Stop safely**: Ctrl+C **once**, then wait. The running part abandons its scenario and cleans up (everything
cancelled and closed on SoDEX, read back flat), no further part starts, and the summary is written. Windows then asks
"Terminate batch job (Y/N)?": either answer is fine, the run has stopped. Ctrl+C twice exits at once; the next start
flattens first.

**Re-run only what failed**: run it again. What passed on this code is not run again (per target; a copy scenario per
leader); failed, inconclusive, interrupted and never-run scenarios run. A part whose runner crashed (it ended without
its results) is started again by itself up to twice (it resumes and flattens first); after that the next part runs.

**Results**: one summary per part at the end, on screen and in `.state/report-<time>.md`: passed (of them, passed
earlier on this code), failed, inconclusive, skipped, not run, and the failing ids with their first error line.
Exit code 0 when nothing failed and no part crashed.

## What you prepare (once)

1. **Two dedicated wallets** that hold nothing else (fresh ones are best):
   - the **follower**: the account the algos and copies trade in, on SoDEX;
   - the **leader**: a second wallet you control; the runner trades it itself so the follower has a real
     trade to copy - on SoDEX (the default) or on Hyperliquid (`LIVE_LEADER_VENUE=hyperliquid`, see
     "A leader on Hyperliquid"). Without it, the copy scenarios are skipped.
2. **Deposit USDC**: the follower on SoDEX (sodex.com); the leader on SoDEX too, or - for a Hyperliquid
   leader - into its **Hyperliquid perps account** (app.hyperliquid.xyz; the runner reads that account's
   value, `clearinghouseState`). How much: run `--budget` (below), with `LIVE_LEADER_VENUE=hyperliquid` in the
   environment for a Hyperliquid leader. With BTC-USD at the prices of 2026-10-29 it asks about **$70 for the
   follower, and $35 for a SoDEX leader or $40 for a Hyperliquid one**, of which about **$3.10 (SoDEX leader)
   or $3.32 (Hyperliquid leader) is spent** (fees, builder fee, spread; a Hyperliquid leader pays $0.76 of it
   on Hyperliquid, at its 4.5 bp taker fee) and the rest is margin that comes back.
3. **The env file**: copy `.env.example` to `.env.live` in this folder and fill it in. Git ignores it; never
   commit it, never paste it anywhere.

   | Name | What |
   |---|---|
   | `LIVE_FOLLOWER_KEY` | the follower wallet's private key (64 hex characters) |
   | `LIVE_LEADER_VENUE` | where the leader trades: `sodex` (default) or `hyperliquid` (the environment may set it too) |
   | `LIVE_LEADER_KEY` | a SoDEX leader's private key (empty: copy scenarios skipped) |
   | `LIVE_HL_LEADER_KEY` | a Hyperliquid leader's private key, only with `LIVE_LEADER_VENUE=hyperliquid` (empty: copy scenarios skipped) |
   | `LIVE_COUNTRY` | your country of residence, two letters, as you declare it in ValueDesk (EEA: the 2x cap applies, and the suite checks it) |
   | `LIVE_ACCEPT_TERMS` | the copy terms version you read and accept, e.g. `2026-10-27.2`: the runner signs the terms in your name with it |

   The keys are read into the runner's memory only. They are never written anywhere, never put in any
   process's environment, and never sent to the executor. On `--target browser` the follower's key is also handed,
   in the same process, to the page's test wallet, which signs what the app asks within its policy: the page never
   sees it.

You do **not** need to register anything yourself: with the private keys it holds, the runner does what
ValueDesk's copy setup asks your wallet to sign - and nothing else:

- it registers the executor's key on the follower's SoDEX account (name `vd-copy-self`, perps only, valid
  one day; on `--target hosted` the name ValueDesk's executor gives, `vd-copy-tokyo`) - every run, since every
  run starts a fresh executor;
- it approves the ValueDesk builder fee ceiling (2.5 bp, the copy ladder's top step) on the follower's account,
  only if the approval there is lower;
- it registers a key of its own on each SoDEX wallet (`vd-livetest-ops`, `vd-livetest-leader`, one day) for
  the leader's trades and the cleanup (a Hyperliquid leader registers nothing: its own key signs its orders,
  and nothing but IOCs, cancels and leverage changes can be signed with it here);
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
| `--slow` | include the slow scenarios (`vwap.full` 15 min, `fee.keep-last` 12 min, `liq.algo-exits` and `liq.copy-follower` up to about 70 min each) |
| `--dry` | paper: every spec goes out with `paper: true` to an executor whose real orders are off; checks read the executor's paper book |
| `--budget` | print the budget and stop |
| `--target <t>` | the executor the scenarios run against: `self` (default), `hosted` or `browser` (see "Targets") |
| `--web <origin>` | browser target: the dev web to run in (default `VS_E2E_WEB`, else the first of 127.0.0.1:5180-5183 serving ValueDesk) |
| `--headed` | browser target: show the Edge window (default headless) |
| `--adopt` | at start, close positions / cancel orders on the test markets that this runner never recorded sending (otherwise it refuses to touch them) |
| `--env <file>` | another env file |
| `--keep-data` | keep the executor's data folder at the end (it holds the executor's sealed key) |

The full run takes about 2.5 to 3 hours (the option matrix about an hour of it; most of it waiting for schedules: TWAPs of a minute or two, a 15-minute
VWAP that is cancelled after its first fill, an iceberg waiting for the tape, a trailing stop waiting for the
price to turn). Leave the window open.

What one run does:

1. Reads SoDEX's market rules and book, picks the cheaper of BTC-USD and ETH-USD as the main market (the other
   carries the basket's second leg), prints the budget.
2. Checks the env file, the country (a blocked region stops here), that both wallets have an account (the
   leader's on its venue) and hold enough, stops an executor a crashed run left behind, and registers its own
   keys.
3. **Start-up cleanup**: if the last run may have left orders or positions (a crash, Ctrl+C twice), it flattens
   both wallets on the test markets first (a Hyperliquid leader: on every coin it holds). If it finds positions
   or orders it never recorded sending, it refuses to start and says what it found (`--adopt` clears them).
4. Starts a real executor (`apps/executor/src/main.ts`, self-hosted for the follower wallet, its own executor id
   `vd-livetest-live`, a random loopback port, a new data folder under `.state/`, `EXECUTOR_LIVE_ALGOS=1`, the
   follower's volume read from the runner's own stub - "The fee ladder").
5. Runs the scenarios in order. After **every** scenario, also a failed one, it cleans up: the executor's kill
   switch, every copy stopped and closed, then straight on SoDEX (and Hyperliquid, for a leader there) every
   order and stop cancelled and every position closed (reduce-only), on both wallets, read back flat. A cleanup
   that cannot read the accounts flat stops the run.
6. At the end: a last cleanup, the executor stopped, its data folder deleted, the results printed.

## The scenarios

136 by default, of which 131 run with a SoDEX leader (the 5 written for a Hyperliquid leader are skipped) and all
136 with a Hyperliquid leader; `--slow` adds 5. Fourteen run on the browser target only: `twap.tab-close`, `copym.tab-close`
and the twelve that work ValueDesk's own pages ("ValueDesk's pages", below). Sizes are in U = SoDEX's $10 minimum order value plus 20% ($12):
every child order is just big enough (and above Hyperliquid's $10 minimum for a leader there). Each scenario
says what it confirms on the exchange (`title` and `confirms` in `scenarios/*.ts`).

- **setup** (4): terms with the declared country; the executor's key registered and listed by SoDEX; the builder
  approval; a key you made yourself imported and trading.
- **TWAP** (11): taker buy (builder fee on every order and fill), maker sell (GTX fills are maker), cancel mid-way,
  pause/resume, time-sliced reduce-only close of a position, exits (SoDEX stops placed after the first fill,
  resized to the full fill, pulled by a cancel), minimum order size (just over SoDEX's minimum; below it: refused at
  the start with the minimum named, nothing sent), limit price respected, executor killed mid-schedule (no child twice, no overfill), size change
  (lowered under a resting child: pulled and sent again at the new size; raised after the first fill: ends filled at
  the new size); on the browser target only, the tab that runs it closed for 30 s (the app, opened again, stops it
  for good: cancelled, no child after the close, nothing resting, what filled stays).
- **VWAP** (1, +1 slow), **POV** (1), **Iceberg** (2: pegged post-only clips one at a time; resting clip survives a
  restart, same order, tracked), **Chase** (2), **Scale** (4: ladder at the planned prices; the ticket's DCA ladder
  paused and resumed; a partial fill; restart with resting levels), **DCA** (2), **Swarm** (1), **Conditional**
  (4: market; post-only limit through the book refused by SoDEX; close of your own position; starting a chase with
  OCO exits), **Trailing stop** (1), **Bracket** (2: take-profit fires and the stop-loss is cancelled; limit
  entry cancelled before any exit), **Basket** (2: BTC long + ETH short; TWAP legs cancelled together), **Fill
  fast** (2), **leverage** (1: SoDEX shows the leverage and isolated margin the algo set, capped for your region),
  **reduce-only** (1: a reduce-only order larger than the position ends flat, never short), **kill switch** (1:
  a ladder, an iceberg and a bracket with exits working; one cancel-all leaves no order and no stop on SoDEX).
- **The algo option matrix** (36, `scenarios/algo-matrix.ts`, ids `mx.*`: `--only mx.*` runs just them): every value
  of every option the scenarios above do not already run live, once per kind, and the pairs that act on each other -
  slippage from the mid, the mark, the index and the oracle; urgency, jitter and slice bounds; bounds that hold, stop
  and rush; start times and prices; 100x asked (SoDEX's or the region's cap set, cross); a short's exits as prices;
  VWAP and POV maker, hybrid and end times; GTC icebergs inside the spread; a chase left resting; scale curves and
  spacings, a ladder and a bracket entry resized while they rest; the API's DCA resting and hybrid; conditions on
  last, mid, index, cross, volume, ratio, funding, time, moves, OI and position size, a kept GTC limit and a started
  TWAP with its stop-loss; trailing stops on a short (USD trail, last price, chase exit) and of an amount with an
  activation; a short bracket filled by its limit; a basket paused and resumed; Fill fast from every reference; a
  practice run beside a live one. `docs/COVERAGE-ALGOS.md` maps every option to its deterministic and live tests.
- **Copy trading** (12), the leader traded by the runner: fixed amount (open, add, reduce, close;
  reduce-only reductions; builder fee), fixed ratio with a flip, proportional to the leader's real equity, the
  copy's leverage cap (clamp, then skip, SoDEX at 1x), stop-loss/take-profit as SoDEX stops (placed, resized,
  cancelled), paused while the leader closes then resumed, stop-and-close, executor killed while the leader adds
  (catch-up, no order twice), counter-trade, a reduction below SoDEX's minimum (reduce-only is exempt), the copy's
  amount changed between two trades, the copy's stop firing on SoDEX (at the region's highest leverage and the
  tightest stops; inconclusive, not failed, when the market does not move far enough in 20 minutes). The fixed-amount
  scenario also times every copy: leader fill to copy fill by the venues' own timestamps, median under 1 s with a
  SoDEX leader (one clock), under 2 s with a Hyperliquid one (two clocks; see below).
- **The copy options matrix** (24, +1 slow; `scenarios/copy-matrix.ts`, ids `copym.*`; `docs/COVERAGE-COPY.md` maps
  every copy option and event to its tests): copy existing on and off, max position, an open under SoDEX's minimum
  caught up by the next add, two markets under one leverage cap, a counter-trade flip, the coin filters changed while
  the copy holds a position, cross margin, the slippage cap on SoDEX's order record, the copy's SoDEX stops
  following a change of its rules, paused while the leader opens, stop keeping the positions, stop all over copies of
  two leaders, a paper and a live copy of one leader, "ask me each time" (held on an executor; on the browser
  answered yes, no and not at all through the page's prompt), the follower's own position on the market, a copied
  position made smaller, closed and added to by hand, too little free margin, the builder approval lowered under
  the fee (set back after), the leader closing while the executor is down or (browser) the tab is closed, the
  drawdown stop (`--slow`, inconclusive when the market does not move), and with a Hyperliquid leader a coin whose
  SoDEX market of that name is another asset.
- **Copy trading with a Hyperliquid leader only** (4): open, add, reduce, close of the leader's BTC copied on
  BTC-USD at the same notional (fixed ratio 1x: sized by notional, not units; the activity names the leader's coin
  and the SoDEX market); three slices sent back to back, each copied once (batched or not), the follower ending at
  the leader's notional; a coin SoDEX does not list (the most traded such coin on Hyperliquid, chosen at run time;
  skipped if there is none) skipped as `not-on-sodex` with nothing sent; kPEPE (a thousand PEPE a unit) copied on
  SoDEX's 1000PEPE-USD or KPEPE-USD at the leader's notional - only if SoDEX lists one at run time, else skipped.
- **Liquidations** (2, slow, live only; every target): an algo's filled position with exits, and the follower's
  copied position, brought near liquidation by the harness and liquidated by SoDEX ("Liquidations", below).
- **The fee ladder** (6, +1 slow; self target only): one scenario per step of the copy fee ladder, and two for a
  failing volume source ("The fee ladder", below).
- **ValueDesk's pages** (12, browser target only; `scenarios/ui.ts`, `needs: ['ui']`): the runner clicks the page as a
  person does, with the steps of `apps/web/e2e/ui/uiSteps.ts`, and checks SoDEX. Each is U, ends flat with nothing
  resting, and has a 3-minute timeout.
  - `ticket.limit-cancel`: a limit buy 2% under the bid through the order ticket and its review rests on SoDEX at the
    price and size typed (GTC, unfilled); the open orders table's Cancel takes it off.
  - `ticket.market-close`: a market buy of U fills into a position of that size (builder fee on its fills); the
    positions table's Close and its confirm is one reduce-only sell, flat.
  - `ticket.tpsl`: a market buy with TP and SL (Gain and Loss in %, 1% from the entry each way): both rest on SoDEX as
    reduce-only stops of the position's size at exactly the prices the ticket showed; Close leaves no stop behind
    (if SoDEX keeps them, it fails and says so: Close does not cancel them).
  - `ticket.leverage`: the ticket's leverage popover sets the market to a leverage at or under the region's 2x, other
    than SoDEX's, in SoDEX's margin mode; SoDEX shows it; set back the same way (straight on SoDEX if that fails).
  - `algo.ui-cancel-exits`: a real bracket (market entry, TP and SL 2%) from the algo ticket, run in this browser;
    after the entry both exits rest on SoDEX; the Algos table's Cancel (while it runs: it ends, its exits stay, the
    row says "Exits live") and then Cancel exits take them off SoDEX; the position stays.
  - `copy.ui-close`: a copy started in the copy window ($ per trade U, 2x, the main market, isolated, this browser;
    every step of the place done by the bootstrap; if the window cannot start it, the bridge does, noted); the
    leader's open is copied; Manage copies' Close ("Stop and close positions") stops it and closes reduce-only.
  - `copy.ui-confirm`: the same with "Ask before each trade": the page's prompt, Copy it sends the open, Skip sends
    nothing (declined), the leader's close answered Copy it closes the follower; exactly one copy buy reaches SoDEX.
  - `ticket.stop`: a stop-market buy 5% over the ask and a stop-limit buy (trigger 5.5%, limit 6%, GTC) from the
    ticket's Stop tab rest on SoDEX as triggers at the typed prices, unfired; the open orders' Cancel takes each off.
  - `ticket.modify`: a limit 3% under the bid, changed with the open orders' Modify to 4% under and 2U; SoDEX shows
    exactly the new price and size (replaced in place, or cancelled and placed again where the builder fee needs it:
    noted); Cancel.
  - `ticket.cancel-all`: limits 2% and 3% under the bid; the open orders' Cancel all (asked first) takes both off.
  - `position.tpsl-sheet`: a market buy of U; the positions table's TP/SL sheet rests a take-profit 2% over and a
    stop-loss 2% under the mark as reduce-only sells of the position at the sheet's prices; changed once (2.5%), SoDEX
    holds only the new two; after Close no stop is left (if SoDEX keeps them they are cancelled through the open
    orders, and that is noted).
  - `spot.order`: Market type Spot, the main coin's USDC market, a market buy of U and the sell back of what it bought
    (dust under one step stays). **It needs vUSDC in the follower's SoDEX spot account**, about $13; the deposit is on
    perps. Without it the scenario is skipped and says so: move $15 from perps to spot on sodex.com (Transfer) or with
    ValueDesk's transfer, then run it again. The runner's cleanup flattens perps only; this one sells back by itself.

  A dry run skips the `ticket.*`, `position.tpsl-sheet` and `spot.order` scenarios (its throwaway wallet has no SoDEX
  account; the UI specs run those steps against the fake SoDEX) and runs the other three on paper (a paper copy, a
  practice bracket) through the same clicks.

## Bots

`scenarios/bots.ts` (`--only 'bot.*' --slow`): the Bots page's strategies at SoDEX's minimum size - `bot.maker` (volume
maker), `bot.grid`, `bot.kill` (the kill switch never trades) and `bot.restart` (a hard kill mid-run). Each
checks the 0.1 bp bot fee on every fill and that the executor's book agrees with SoDEX's trades, and appends its numbers
(volume, SoDEX fees, builder fee, net PnL, cost per $1M, from SoDEX's own fills) to `.state/bot-numbers.jsonl`.

| Variable | |
|---|---|
| `LIVE_MAIN` | the main market for this run, e.g. `SOL-USD` (default: the cheapest of the candidates); the bots run there |
| `LIVE_BOT_MINUTES` | how long the maker and the grid run (default 10; each stops sooner at its volume target) |
| `LIVE_BOT_MM`, `LIVE_BOT_GRID` | JSON merged over the scenario's settings for one iteration, e.g. `{"edgeBps":1.7}` or `{"rangePct":0.001,"levels":9}`; recorded with the numbers |

## Targets

`--target` picks the executor that takes the signed requests. The catalogue, the checks against SoDEX and the
cleanup are the same on every target; what a target cannot let the runner do, the scenarios that need it are
skipped for, with why (`needs` in `scenarios/*.ts`; `target.ts`).

| Target | What runs | Covers | Skips |
|---|---|---|---|
| `self` (default) | a real executor process started here from this checkout (`apps/executor/src/main.ts`, self-hosted for the follower, `EXECUTOR_LIVE_ALGOS=1` for a live run, the follower's volume from the runner's stub) | everything but the browser's own: 117 scenarios with a SoDEX leader, 122 with a Hyperliquid one (5 more with `--slow`) | `twap.tab-close`, `copym.tab-close` (no browser tab), the twelve UI scenarios (`ticket.*`, `position.tpsl-sheet`, `spot.order`, `algo.ui-cancel-exits`, `copy.ui-*`: no page) |
| `hosted` | ValueDesk's own executor on server 2, through the site: `https://www.valuedesk.so/api/copy/v1` (Vercel's function adds the origin secret and your country, which the server needs) | every scenario that does not restart the executor or set the follower's volume | `twap.restart`, `iceberg.restart`, `scale.restart`, `copy.restart`, `copym.restart-close` (it cannot be killed from here), the `fee.*` scenarios (its volume is its ledger's), `twap.tab-close`, `copym.tab-close`, the twelve UI scenarios |
| `browser` | the web app's own runtime (`apps/web/src/algo`, `copy`, `trading`) in a tab of Microsoft Edge on the local dev web, through the web test bridge (`browserDriver.ts`) | every algo and copy scenario, the restarts as reloads of the page, `twap.tab-close` and `copym.tab-close`, and the twelve that click ValueDesk's own pages: 124 with a SoDEX leader, 129 with a Hyperliquid one (4 more with `--slow`) | the `fee.*` scenarios (a browser reads no volume: it charges fixed fees), `setup.key-import` (a browser makes its own copy key) |

**Hosted** in detail:

- The executor id and the key name come from its `/info` (`valuedesk-mainnet-tokyo`, `vd-copy-tokyo`); the run
  refuses anything that does not answer as ValueDesk's mainnet executor, or whose `/health` is not ok.
- **The region** is the stricter of `LIVE_COUNTRY` and the country its edge sees you in (as for every follower):
  from Germany the 2x EEA cap applies whatever you declare, and the checks expect it.
- **Its fee** is the step of the follower's 14-day volume, which only its own ledger knows: the checks accept any
  step of the ladder its `/info` lists, the same on every order, and note the one SoDEX showed (`self` charges the
  top step, 2.5 bp, and is checked for exactly that).
- **Its limits** (240 reads and 40 writes a minute per address, 12 key checks a minute per wallet) are shared with
  anyone behind your address, so the runner paces itself under them (200 / 30 / 10); a run takes a little longer.
- **When it cannot take something now**, that is not a failure of the code: closed to new followers or the
  operator's brake (503) is `inconclusive` (it runs again next time), a region or sanctions refusal (451) is
  `skipped` with its words.
- **Real algo orders** reach it only for wallets the owner lets (below); until then every algo scenario of a live
  run is `inconclusive` with that reason. Copies need nothing extra.
- **What it records stays.** ValueDesk's production database keeps the signed terms, the keys, the algos and copies
  of the wallets used - also a `--dry` run's throwaway wallet, which accepts the terms there; a dry run sends paper
  specs only. The kill switch and the "stop all copies" of every cleanup apply to everything the follower runs on
  ValueDesk's executor: use the dedicated wallets only.
- The hash a pass is tied to adds the version its `/info` names (and a commit, once `/info` carries one) to this
  checkout's files, so a pass on `hosted` re-runs after a local change too. A release that does not change that
  version is not seen: run with `--force` after one.

**What the owner sets up for hosted** (once, on server 2, `/etc/valuescan/executor.env`): the follower's address
in `EXECUTOR_LIVE_ALGOS_WALLETS` (comma-separated addresses; `*` would be every wallet), and restart the executor.
`EXECUTOR_LIVE_ALGOS=1` would open real algo orders to everyone - not needed for this. Taking the address out
again stops new real algos for it; running ones go on. Copy trading needs nothing.

**Browser** runs the algos and copies where a user who picks "This browser" runs them: the web app's own runtime
in a tab. What you need:

1. **The dev web running**, from this checkout - the runner never starts it: in the Claude app the preview
   `valuescan-web` (`.claude/launch.json`), or `npm run dev` in `apps/web` (http://127.0.0.1:5180). The runner
   finds it as the UI specs do (`--web <origin>`, else `VS_E2E_WEB`, else the first of 127.0.0.1:5180-5183 that
   serves ValueDesk from Vite), checks that it serves this checkout (the engine's files under this folder), and
   refuses to start otherwise, saying how to start it. Its "ValueDesk executor" is the local one
   (`valuescan-executor`, 127.0.0.1:8799 behind Vite's `/api/copy`): the copy terms signature is recorded there; with
   it not running the page retries the record later, which changes nothing here.
2. **Microsoft Edge installed** (it is on Windows): the UI specs' launcher (`apps/web/e2e/ui/browser.ts`), which
   never downloads a browser. Headless; `--headed` shows the window.
3. **For a live run**, in `apps/web/.env.local`, then restart the dev web:
   - `VITE_LIVE_ALGOS_WALLETS=<the follower's address>` (comma-separated; read on a dev server only, see
     `apps/web/src/algo/liveAlgos.ts`): real algo orders are off in the web app for everyone else. Without it every
     algo scenario of a live run is `inconclusive` with that reason; copies need nothing.
   - the builder lines as `deploy/vercel/production.settings` has them (`VITE_BUILDER_ID`, `VITE_BUILDER_FEE_PERPS`,
     ...): a dev web without a builder charges no builder fee, and a live run refuses it at the start.

```
node node_modules/tsx/dist/cli.mjs apps/executor/tools/live-test/run.ts --dry --target browser --only setup,twap
node node_modules/tsx/dist/cli.mjs apps/executor/tools/live-test/run.ts --target browser
```

How it maps (`browserDriver.ts`; the page is `apps/web/e2e/ui/bridgeSession.ts`, loaded through tsx with the web
app's own tsconfig - no browser code lives in this folder):

- **The page**: a fresh Edge profile every run, the app at `/trade`, the welcome gate accepted, the wallet connected
  through Connect > MetaMask. The wallet is the UI specs' test wallet (`apps/web/e2e/ui/wallet.ts`): it holds the
  follower's key in the runner's process (a dry run's throwaway one) and signs only what the app's setup flows sign
  (the trading key, the builder approval, ValueDesk's terms, the copy terms); the page sees addresses and signatures,
  never the key. ValueDesk's own terms popup is clicked through when a call opens it. A live run enables trading on
  the order ticket (one `trading-key` signature: a trading key on the follower's SoDEX account).
- **The calls** go to the dev-only test bridge (`window.__vsTest`, `apps/web/src/testBridge.ts`, version 2), and come
  back in the executor's shapes: the algo and copy views are the engine's own; the info and `/me` are put together
  from what the page runs with. A browser has no session (`signIn` does nothing). **The copy key** is made in the page,
  registered by the follower's wallet as the harness registers an executor's key (`vd-copy-browser`, perps, one day),
  and kept in the browser's vault once SoDEX lists it. **Its fees** are no ladder: an algo's children carry the dev web
  builder's trading fee, a copy's orders the copy ladder's top step (2.5 bp); the info lists those two and the fee
  checks accept exactly them.
- **A restart is a reload**: the page navigates away and comes back in the same profile. The web app keeps a tab's
  algos running through a reload (`apps/web/src/algo/tabLife.ts`: back within 20 s); it is not a hard kill (the
  page's own `pagehide` runs), so the target cannot be killed hard. `twap.tab-close` closes the tab instead and opens
  the app again 30 s later, when the app must stop the algo for good.
- **The page's own controls** (`t.ui(step, args)`, capability `ui`): a step of `apps/web/e2e/ui/uiSteps.ts` run in the
  page by name (`bridgeSession.ts ui`), by ARIA role and name: the market picked through the market search, the ticket
  and its review, Cancel and Close in the account tables, the copy window from the trader's link
  (`/copy?address=&venue=`), Manage copies on Portfolio, the "Copy this trade?" prompt, the algo ticket's slide and the
  Algos table. Other pages are reached in the tab (history and popstate, as the nav does): no reload, the runners go
  on. A step that fails leaves a screenshot next to the run's logs. A dry run's page refuses the ticket steps and
  any copy or algo that is not paper.
- **Skipped**: the `fee.*` scenarios (a browser reads no 14-day volume; the runner's stub is for an executor it
  starts) and `setup.key-import` (a browser makes its own copy key).
- **Bandwidth**: the page streams SoDEX's market data for as long as the run keeps it open; no browser or package is
  downloaded.

Its hash adds the web runtime's files (`apps/web/src/algo`, `copy`, `trading`); a UI scenario's also the pages it
clicks (`apps/web/src/components` with its `.tsx`, `exchange`, `api.ts`, `accountFeeds.ts`) and the steps
(`apps/web/e2e/ui/uiSteps.ts`, `ticket.ts`, `algo.ts`).

**One target at a time per wallet**: each target keeps its own state, and a live start refuses while another
target's state says it may have left orders or positions on the same follower (run that target again: its start-up
cleanup flattens them). Never run two targets at once on the same wallets.

## A leader on Hyperliquid

With `LIVE_LEADER_VENUE=hyperliquid` (env file or environment) and `LIVE_HL_LEADER_KEY`, the leader is a
Hyperliquid wallet and every copy scenario follows it there: the copy's settings name `venue: hyperliquid`, the
leader's trades go to its coin of the SoDEX market (BTC-USD -> BTC, ETH-USD -> ETH), and the copier hears of them
from Hyperliquid's `userFills` stream. `hyperliquid.ts` is the runner's own small Hyperliquid client:

- **What it signs**, with the leader's master key, Hyperliquid's "L1 action" scheme as the official Python SDK
  builds it: the action msgpack-encoded (keys in the SDK's order), the nonce (ms) as 8 bytes, `0x00` (no vault),
  keccak256 of that as the `connectionId` of an EIP-712 `Agent(string source, bytes32 connectionId)`, source `a`,
  domain `Exchange` / `1` / chain 1337 / the zero address. **Only** an IOC (reduce-only for a close), a cancel and
  a leverage change can be signed: anything else (a withdrawal, a transfer, an agent, a TWAP, another order type,
  a builder) is refused before it is signed. The unit tests pin the SDK's own published vectors.
- **What it sets**: 2x leverage on each coin before the leader's first trade there (cross where the coin allows it;
  the budget's margin is costed at 2x). Sizes are floored to the coin's `szDecimals`, prices rounded to 5
  significant figures and at most 6 - `szDecimals` decimals; every leader order is at least Hyperliquid's $10.
- **The pre-flight** reads the leader's perps account value (`clearinghouseState`); **the cleanup** cancels and
  closes on every coin the leader holds or has an order on (also one a crash left behind), reduce-only.
- **Latency over two clocks**: the leader's fill is on Hyperliquid's clock, the copy's on SoDEX's. The runner logs
  each copied order's delay and Hyperliquid's clock against this machine's (measured on the leader's own orders:
  fill time less the middle of the request, within half its round trip); SoDEX's clock is not measured. The limits
  are looser for it: median under 2 s, slowest under 5 s (SoDEX leader: 1 s / 3 s) - still far under the copier's
  60 s reconcile, so a copy that missed the stream fails.
- **What it costs**: Hyperliquid's base-tier taker fee, 4.5 bp, and half its book's spread on every leader trade
  (`--budget` reads its book); no builder fee. Fund **USDC in the leader's Hyperliquid perps account**: `--budget`
  says how much (about $40 on 2026-10-29).
- **Five more scenarios** run only with it (`copy.hl-*` and `copym.hl-different-asset`, above); with a SoDEX leader they are skipped, with why. A
  pass with one leader never stands for the other (the copy scenarios' hash names the venue).

## The fee ladder

The builder fee of an executor's orders is the copy ladder's step of the follower's verified 14-day volume
(`COPY_FEE_LADDER`: 2.5 / 2 / 1.5 / 1.2 / 1 bp from $0 / 100k / 500k / 2M / 10M), which a hosted executor reads
from the API server (`EXECUTOR_BUILDER_URL`, `GET /api/vs/builder/volume` with the internal token). On `--target
self` the runner answers those reads itself: `feeStub.ts`, a loopback stub given to the executor it starts, which
checks every read as the server would (the token, the follower, the builder, 14 days) and answers $0 (the first
step, what every other scenario is checked for) unless a fee scenario sets another volume or a failure.

- `fee.tier-0` ... `fee.tier-10m`: for each step its executor's `/info` lists, the volume just under the boundary
  (the step below) and at it, each after a restart of the executor (it keeps an answer 10 minutes) and a new
  session (which reads the volume), then one market buy of U and a reduce-only sell of it; SoDEX's order history
  must name the step's builder `feeRate` on both orders and its fills charge it (`builderFee`).
- `fee.fail-first`: the stub failing from the first read - the first (dearest) step.
- `fee.keep-last` (`--slow`, 12 min): a good answer, then the stub failing: once the answer is 10 minutes old the
  executor asks again, fails, and keeps the step it had.

The follower's approval stays at the top step (`setup.builder`), which covers every step. The cleanup after each fee
scenario sets the stub back to $0 and restarts the executor, so the next scenario starts on the first step. A dry run
reads the step from the executor's own book (what it charged beyond SoDEX's taker fee); SoDEX's fields are live only.

## Liquidations

`liq.algo-exits` and `liq.copy-follower` (`scenarios/liquidation.ts`) let SoDEX liquidate a real position of U
($12): what a stop firing (`copy.tp-fires`, `bracket.tp-fires`) does not show. Both are `--slow` and live only (a
paper book has no margin to liquidate: a dry run skips them, saying so). Run just them with
`run.ts --only liq --slow`.

- **Nothing is faked.** The position is brought near its liquidation as its owner could on sodex.com, with the
  harness's own key on the follower's account: the market's maximum leverage on the open isolated position
  (`updateLeverage`; 40x on BTC-USD and ETH-USD on 2026-10-29), then as much of its isolated margin taken out as
  SoDEX lets (`updateMargin`, negative amounts, halving after each refusal, every step read back). SoDEX's own
  liquidation price (`lp` in the account state) and the isolated margin (`iw`) are read back and the distance is
  logged; at 40x with SoDEX's 1.25% maintenance margin it is about 1.25%. While it waits, margin is taken out again
  every 5 minutes. A position SoDEX keeps further away (it refuses both, or holds more than 5% of the position's
  value as margin) is `inconclusive` at once: "cannot get near liquidation".
- **Then the market.** SoDEX gets 60 minutes to liquidate it; when the market does not move that far the scenario is
  `inconclusive`, not failed, and runs again next time. Both scenarios take up to about 70 minutes.
- **What SoDEX shows**: the follower's fills hold SoDEX's takeover fill (`clOrdID` `liquidation:<id>`, no order of
  the follower's; `docs/research/07-gaps-sodex-contract.md` G7), the account is flat (or holds what a partial
  liquidation left); `positions/history`'s `isTakenOver` is noted.
- **liq.copy-follower**: the follower copies the leader's long of U at the copy's 2x (the EEA cap, and the copy's
  own), isolated, with far stops (SoDEX holds them). After the liquidation: the copy's activity says "closed outside
  the copier", the wallet's notices hold an error notice for it (self and hosted; the browser's are its bell, not
  read here), no copy stop is left on SoDEX, nothing is opened again by itself - not on a reconcile, not on the
  leader's add (skipped, `own-position`); once the leader is flat the leader's next open is copied, at the copy's
  2x isolated again on SoDEX (the copier sets its leverage again after a position closed outside it). A partial
  liquidation: the copy holds what SoDEX left and buys nothing back by itself.
- **liq.algo-exits**: a bracket's market entry of U at 2x isolated, its take-profit and stop-loss 20% away (far past
  the liquidation once at 40x). After the liquidation it notes what SoDEX did with the position's stops (its order
  history) and what the algo and its notices say, and checks that no exit opened anything (they are reduce-only)
  and that none is left resting on SoDEX for the position that is gone. The engine does not watch for that yet
  (`packages/copy-engine/test/edge-algo.test.ts`, "FINDING liquidated, algo"): if SoDEX leaves the stops, this check
  fails, and that is the finding confirmed on the exchange.
- **What it costs**: the position's isolated margin, gone with the liquidation - the budget counts the most a
  scenario waits with (5% of U, $0.60), about $0.30 at 40x - plus the fees of the opens and the leader's trades.
  SoDEX's takeover fill itself was fee-free in the one case the repository verified; a further liquidation fee is not
  documented, so it is not costed (unknown).
- **Afterwards** each puts the market's leverage and margin mode back as it found them (once the position is
  flat), so the scenarios after it, and the copier's memory of the leverage it set, find SoDEX as before; the
  cleanup flattens both wallets as after every scenario.
- **Every target**: only SoDEX-side actions are the harness's; the copier or the algo runs where the target runs
  it (on `browser`, the dev web streams market data for the whole wait).

## Resume, and reading the results

The results are in `.state/live-<target>.json` (`.state/dry-<target>.json` for `--dry`; a practice run never marks
a real one passed, a pass on one target never stands for another). A `self` state from before targets
(`.state/live.json`, `.state/dry.json`) is renamed to its new name the first time. Per scenario: `status` (passed,
failed, inconclusive, skipped, pending), the `hash` of the code it ran on, times, attempts, the error, the checks
that held, notes, and the fees SoDEX charged it.

- **Run it again** to resume: what **passed on the same code** is skipped; failed, inconclusive (the market did
  not do what the scenario waited for in time - a take-profit not reached, a quiet tape), interrupted and never
  run scenarios run. The hash covers the engine and executor files a scenario depends on and the harness (copy
  scenarios: the copy runtime, planner, feeds, the leader's driver `leader.ts` and `hyperliquid.ts`, and the
  leader's venue; algo scenarios: the algo engine; both: the SoDEX layer, the executor), so a code change re-runs
  exactly what it may have broken.
- **Per leader**: a copy scenario run with a Hyperliquid leader is kept apart (`copy.fixed-notional@hyperliquid` in
  the state), so runs with either leader resume on their own and never overwrite each other's pass; everything else is
  the same with either leader and kept once.
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
  again, close the positions and cancel the orders on sodex.com yourself (BTC-USD and ETH-USD, both wallets; with
  a Hyperliquid leader also the follower's 1000PEPE-USD or KPEPE-USD, and the leader's every coin on
  app.hyperliquid.xyz).
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
close) only check that the executor accepts their spec. On `--target browser` the throwaway wallet is the page's
wallet too: it signs ValueDesk's terms and the copy terms (recorded by the dev web's local executor), and nothing
reaches SoDEX.

## Files

| File | |
|---|---|
| `START-LIVE-TESTS.cmd`, `all.ts` | every target one after another, each part in its own process (preflight, plan, retries, progress, summary: "Start here"); `allParts.ts` holds its logic. Not in any scenario's hash: changing them re-runs nothing |
| `run.ts` | the runner (options, bootstrap, the loop, the cleanup after every scenario) |
| `scenarios/setup.ts`, `scenarios/algos.ts`, `scenarios/algo-matrix.ts`, `scenarios/copy.ts`, `scenarios/copy-matrix.ts`, `scenarios/liquidation.ts`, `scenarios/fees.ts`, `scenarios/ui.ts` | the catalogue; `catalogue.ts` puts them in order (`ui.ts`: the browser target's clicks on ValueDesk's pages, whose steps are `apps/web/e2e/ui/uiSteps.ts`) |
| `harness.ts` | what a scenario works with (`T`): sizes, checks, the follower's account (SoDEX or paper), the leader, restarts |
| `exchange.ts` | SoDEX reads, and the harness's own writes (registration, approval, IOCs, cancels, leverage and isolated margin): what a copier sends through the engine's client, the rest (which that client refuses by design) straight to SoDEX's gateway |
| `leader.ts` | the leader on its venue (`SodexLeader`, `HyperliquidLeader`): its trades, fills, equity, and its cleanup |
| `hyperliquid.ts` | the Hyperliquid client: reads, and the leader's IOCs, cancels and leverage (msgpack, L1 signing, the guard) |
| `feeStub.ts` | the loopback stand-in for the API server's volume route (self target) |
| `executor.ts` | the executor process and its signed API |
| `target.ts` | the targets (`self`, `hosted`, `browser`): what each can do, the hosted pacing and refusals, the browser seam |
| `browserDriver.ts` | the browser target's driver: the executor's API mapped onto the web test bridge, the dev web check, the page loaded from `apps/web/e2e/ui/bridgeSession.ts` |
| `cleanup.ts`, `state.ts`, `hash.ts`, `budget.ts` | flattening, the state file, the code hash, the budget |
| `../../test/live-test-runner.test.ts` | unit tests of the runner's rules (resume, skip, hash, crash repair, cleanup, budget, targets, leader venues, the fee stub and scenarios) |
| `../../test/live-test-all.test.ts` | unit tests of the driver (`all.ts`): plan, skips, the runner's lines, retries after a crash, progress, summary, report, the per-leader result key |
| `../../test/live-test-hyperliquid.test.ts` | unit tests of the Hyperliquid client (the SDK's signing vectors, rounding, the guard, the wire) and leader |
| `../../test/live-test-browser.test.ts` | unit tests of the browser driver's mapping (a fake page: no browser) and of the browser target's reload and closed tab |
