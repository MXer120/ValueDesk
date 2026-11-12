# Bots (2026-11-02)

Automated strategies on the **Bots** page (`/bots`), run 24/7 by the ValueDesk executor (server 2) in the
user's own SoDEX perps account. Built for the owner's brief: as much volume as possible at the least net cost,
easy to start, still configurable, for many users at once.

## The strategies, and what they cost

Every bot order is **post-only** (GTX): it rests on the book, pays SoDEX's maker fee and never the spread. The
only taker a bot ever sends is the reduce-only close when it stops with "Close" and a minute of resting did not
close what it holds.

| Strategy | Engine kind | What it does | Per $1M traded |
|---|---|---|---|
| **Volume maker** | `mm` | One post-only bid and one ask at the touch, re-priced as the touch moves (after N ticks, at most every M s). Holds at most an inventory cap either way; while it holds, the adding side steps back (skew), so the unwinding side fills first. Delta-neutral by construction. | fees $170 (SoDEX maker 1.2 bp $120 + bot fee 0.5 bp $50), minus the spread it earns, plus adverse selection on what it holds |
| **Grid** | `grid` | Post-only orders on 3-60 levels in a range: buys below the price, sells above, one level empty (the gap). A filled buy puts a sell one level up; a filled sell a buy one level down. | fees $170, minus half a step per $1M (a ±2% / 16-level grid: about $1,330 earned per $1M before price moves) |

A DCA is not a bot (owner, 2026-11-02): it is an algo order on the ticket. The engine refuses `bot: true` on a DCA;
one stored before that keeps its spec and the bot fee.

Not offered: anything that takes. A taker bot pays SoDEX 4.0 bp + the bot fee + half the spread: $450+ per $1M.
Delta-neutral across two markets or two accounts is not offered either: SoDEX perps are one-way netted per account,
so a hedge needs a second account, and a bot trading against its owner's other account is wash trading.

SoDEX tiers (docs/research/10-pooled-fee-account.md): maker 1.2 / 1.0 / 0.6 / 0.2 / 0 bp from $5M / $25M / $100M /
$500M 14-day volume. A user who reaches tier 1 through bots pays $150 per $1M; tier 3, $70.

### What the market adds

At the touch a volume maker's round trip earns one tick where the spread is one tick, so the tick's share of the
price comes back: per $1M, tick / 2. SoDEX, 2026-11-02 (tick, spread at the time): BTC 0.13 bp ($6), ETH 0.44 bp
($22), SOL 1.07 bp ($53), SUI 1.13 bp, DOGE 1.33 bp. The form shows this line for the market picked ("Spread
earned"). It is before price moves: SOL's live run (below) lost more to a falling price than its tick gave back.

### The queue guard (`queueGuard`, off by default)

SoDEX's bookTicker carries the size at the best bid and ask (`B`, `A`; the feed keeps them on the quote). With a
guard of e.g. 30%, the side that would ADD to what the bot holds is not quoted - and is pulled where it rests, no
sooner than 0.5 s after it went out - while the queue at its own best price is under 30% of both best prices: a
thin queue is about to be traded through, and that fill is the move against it. It comes back no sooner than the
re-price pause after. The side that unwinds is always quoted. A replay of 15 minutes of SoDEX's book (BTC, ETH,
SOL, XRP, HYPE) with a queue model put it at 3-5% less cost; live on BTC it was inside the baseline's range.

## The setup

The Bots page has its own setup sheet (components/bots/BotSetupSheet.tsx): the copy setup's steps
(CopySetupSteps with `bots`), worded for bots - no executor to pick, no sign-in step of its own (the terms step's
"Sign and accept" signs in to the executor as well; a returning wallet whose terms stand gets "Continue"), the
risks of a bot, the bot fee (0.5 bp at most), "the trading key". Practice: connect, terms. Real: plus the fee and the key.
The signed terms text is unchanged (it still names the DCA bot among the bots): changing it would make every
wallet sign again.

## The fee

Bots carry the **bot fee ladder** (owner 2026-11-08; `BOT_FEE_LADDER`, packages/copy-engine/src/policy.ts), tenths of
a bp by the wallet's own 14-day volume:

| 14-day volume | from $0 | $100k | $250k | $500k | $10M |
|---|---|---|---|---|---|
| Bot fee | 0.5 bp | 0.4 bp | 0.3 bp | 0.2 bp | 0.1 bp |

Lower than its step: **VIP** ($1M of its own volume in 14 days) pays the lowest step (0.1 bp); so does a **VIP
program** from server 1 - the beta's 30 days from the wallet's listing (admin/store.ts `activeFeePrograms`, "Beta
VIP") or one set on the dev page. The executor reads them with the volume (GET /api/vs/builder/volume: `vip`,
`fees.bots` with its `until`) every 2 minutes; one not read again for 6 hours stops counting. There is one source for
the beta's 30 days: server 1's (the executor no longer counts its own from the first bot). The fee a wallet pays now
is on `/me` as `bots: { feeTenths, vip, until }`. The top step (0.5 bp) is what the terms of 2026-11-02 name. Other
hosted algos keep the copy ladder (2.5 -> 1 bp). SoDEX charges each order the fee it names, up to the account's
approved ceiling, so the copy approval (25) already covers it: a user approves nothing new. Where the fee is chosen:
`ExecutorService.algoFee`/`botFee` (apps/executor/src/service.ts), used by the algo sink's builder, the approval
check and the fee estimate alike.

## The engine

Bots are algo kinds in the existing engine (packages/copy-engine/src/algo/): the same runtime, store, sink and
executor routes as every hosted algo, so they inherit its persistence (write-ahead, restored after a restart and
reconciled with SoDEX), the brake, the audit log, notices, the key and terms checks, region rules (EEA 2x on the
leverage and gross exposure, blocked regions held), the live allowlist, and the per-account and per-IP rate budget
(sodex.ts `AccountRate`, `WeightBudget`).

- `algo/bots.ts` (pure): grid levels and the gap move, the volume maker's quotes and skew, the bot book (volume,
  fees, net PnL at the mark, cost per $1M) and its series (a point every 5 min, at most 1,500, thinned).
- `runtime.ts`: `stepMm`, `stepGrid`, the bot limits (volume target, loss limit, end time), the closing phase,
  bot updates (sizes, distances, limits; never market, range or levels) and `archive` (Delete: off the list, the
  record kept).
- One **live** bot per wallet and market (`409 bot-market`): two would quote against each other and share one
  position. Many users on one market each run their own bot in their own account; the market feed is shared.
- Rate: a volume maker re-prices at most every `minRepriceMs` (≥ 1 s, default 3 s) and only past `chaseTicks`;
  a cancel+new is two writes against SoDEX's 600/min per account. A grid sends one batch a step, only when a
  level needs an order.

## Live gate

A **real** bot starts on the hosted executor when, in order (each refusal has a `code` the web maps to a button):
- the signer's wallet is on the **beta list** (server 1's admin suite, asked as GET /api/vs/builder/beta), from
  valuedesk.so or beta.valuedesk.so alike, or is one of `EXECUTOR_LIVE_ALGOS_WALLETS` (the test follower) - else
  `403 beta` ("ask on Discord"). Every answer is kept in the executor's db: when server 1 does not answer, the last
  known one stands. A running real bot is held only on an explicit "not listed", never because the list was down;
  a wallet never answered for is refused a new real bot (fails closed).
- the executor runs fewer than `EXECUTOR_MAX_LIVE_BOTS` real bots, every wallet together (default 10, ~10 bots with
  pushed fills per IP measured 2026-11-05) - else `429 bot-capacity`;
- the brake is off; the trading key is registered (`412 key`); the wallet has a SoDEX account (`412 account`);
- nothing else of the wallet's trades that market: no other real bot (`409 bot-market`), no live algo order
  (`409 market-algo`), no live copy that holds it, whose leader holds it or whose allow list names the coin
  (`409 market-copy`), no position the bot did not open (`409 market-position`, read at start);
- the margin fits: its running real bots (each at its leverage, its market's minimum order, the region's ceiling)
  plus its live copies' allocations plus this bot's margin are at most the account's equity (`409 margin`, with
  `detail` {needUsd, freeUsd, reservedUsd, equityUsd}); equity that cannot be read is `503 margin-unknown`. The same
  check runs on a signed update that makes a bot need more margin, and on a live copy subscribed or raised while real
  bots run.
- the wallet's bots are not moving to (`409 vip-moving`) or already on (`409 moved`) the VIP servers.
Practice bots run for everyone against the real book and send nothing.

The trading key: the engine reads its expiry (host `keyExpiresAt`) and pulls the quotes before it; the wallet gets a
notice about 24 h and 1 h before a key that real bots use expires (id `key-expiry:24h|1h:...`).

## Tests

- `packages/copy-engine/test/algo-bots.test.ts`: quotes, skew, cap, grid moves, book and series; the runtime
  against a fake SoDEX: post-only refusals, partial fills, re-price pause, 429s in a row, restart, brake, key
  expiry, the kill switch, volume target and loss limit, stop-and-close, pause/resume, updates.
- `apps/executor/test/bots.test.ts`: the bot fee ladder vs the copy ladder, the live gate, signed updates, archive.
- `apps/executor/test/bots-launch.test.ts`: the launch audit's fixes - margin (start, update, copies, unreadable),
  one market per bot, the real-bot cap, the beta answer kept, key-expiry notices, the fee on /me, refusal codes, the
  VIP move (pinned key, timeout asked about, all-or-nothing import, brake, restart), calendar stop.
- `apps/web/src/bots/presets.test.ts`: every preset a valid spec, read-back, patches, cost per $1M.
- `apps/web/e2e/ui/bots.spec.ts`: the page on desktop and phone, setup to delete, one signature per action.
- Live: `apps/executor/tools/live-test/scenarios/bots.ts` (`--only 'bot.*' --slow`): `bot.maker`, `bot.grid`,
  `bot.dca`, `bot.kill`, `bot.restart`. Each run appends its numbers (from SoDEX's own fills) to
  `.state/bot-numbers.jsonl`.

## Live numbers (test accounts, BTC-USD, SoDEX's minimum size, 2026-11-02)

From SoDEX's own fills (the executor's book agreed to the cent every run); the 0.5 bp builder fee checked on every
fill; every fill a maker fill. Cost per $1M = -net PnL / volume, closed flat at the end.

| Run | Settings | Time | Fills | Volume | Fees (SoDEX + 0.5 bp) | Net PnL | Cost per $1M |
|---|---|---|---|---|---|---|---|
| 1 | Volume maker at the touch, $12 quotes, cap $36 | 6.9 min | 66 | $743.78 | $0.089 + $0.037 | -$0.156 | **$210** |
| 1 | Grid +/-0.25%, 6 levels (10 bp steps) | 10 min | 0 | $0 | - | - | - (no step reached) |
| 1 | DCA bot, 2 x $12, 1 min apart | 1.1 min | 2 | $23.36 | $0.004 | -$0.003 | $119 |
| 2 | Volume maker 1.7 bp from the mid | 12 min | 10 | $116.98 | $0.020 | -$0.064 | $547 |
| 2 | Grid +/-0.1%, 6 levels (4 bp steps) | 12 min | 6 | $70.19 | $0.012 | -$0.0065 | **$93** |
| 3 | Volume maker at the touch, cap one quote, re-price 1 tick / 1 s, skew 6 | 8.1 min | 68 | $723.08 | $0.087 + $0.036 | -$0.164 | $227 |
| 3 | Grid +/-0.16%, 9 levels (4 bp steps) | 3.5 min | 6 | $69.22 | $0.012 | -$0.047 | $680 (failed: refusals, fixed) |
| 4 | Grid +/-0.16%, 9 levels (4 bp steps), with the back-off | 12 min | 8 | $88.63 | $0.015 | -$0.0044 | **$50** |
| 5 | Volume maker **SOL**, $12 quotes, cap $60, re-price 1 tick / 1 s | 12 min | 62 | $758.51 | $0.091 + $0.038 | -$0.186 | $246 (27 post-only refusals; SOL fell 93.27 → 93.13) |
| 6 | Volume maker BTC, same, **queue guard 30%** | 12 min | 66 | $758.43 | $0.091 + $0.038 | -$0.162 | $214 |
| 7 | Volume maker **ETH**, same, queue guard 30% | 12 min | 64 | $755.09 | $0.091 + $0.038 | -$0.196 | $260 (35 post-only refusals) |

What the runs say:
- **Fees are the floor: $170 per $1M** at SoDEX tier 0 (1.2 bp maker + 0.5 bp bot fee). The volume maker at the touch
  adds $40-57 of adverse selection: $210-227 per $1M, about **$6,500 of volume an hour per $12 quote**.
- Quoting away from the mid (1.7 bp) did not help: fewer fills ($580/h), and the ones it got were the price running
  through it ($547 per $1M).
- A grid with steps above the 3.4 bp round-trip fee earns them back (run 2: $93, run 4: $50 per $1M - closest to break-even) but trades only when the
  price swings across its levels; in a one-way move it holds what it sold or bought on the way (run 3).
- Run 3's grid exposed a bug: a level SoDEX refused in its answer went out again every 0.5 s until the bot hit its
  25-refusal limit. Fixed: a refused level (and a refused maker quote) waits 3 s, doubling to a minute.
- Runs 5-7 (2026-11-02, about $60 of inventory): BTC stays the cheapest market ($214), ETH $260, SOL $246 - their
  larger tick gave back less than price moves took. The queue guard changed nothing measurable on BTC. A refused
  maker quote (post-only: the touch moved under it) now waits 0.5 s, doubling, instead of 3 s.
- Break-even needs a lower fee floor, not tuning: SoDEX tier 1 ($5M/14 d) takes the maker to 1.0 bp ($150 per $1M),
  tier 2 ($25M) 0.6 bp ($110), and the maker rebate (-0.1 to -0.3 bp above 0.5-3% of SoDEX's maker volume) more.

## Getting the maker's cost down (2026-11-02, owner: "get cost for mm down", ETH / ZEC / SOL)

Every run: the test wallet, $12 quotes, $24 cap, 15 min, ETH and SOL side by side, then ZEC (scenario `bot.makers`).
Net, gross (spread earned less adverse selection) and fees per $1M from SoDEX's own fills; fees are $170 in every run.

| Version | Executor | ETH net (gross) | SOL net (gross) | ZEC net (gross) |
|---|---|---|---|---|
| v1: one quote at the touch | laptop (DE) | $229 (−59) | $272 (−102) | $136 (+34) |
| v2: ladder 2 + move guard 2 + one tick inside | laptop | $241 (−71) | $483 (−313) | $240 (−70) |
| v3: one tick back + ladder 3 (kept when the touch comes) | laptop | $239 (−69) | $261 (−91) | $326 (−156) |
| h1: v1 | **Tokyo (hosted)** | **$195 (−25)** | **$202 (−32)** | $290 (−120) |
| h2: v1 + ladder 2 | Tokyo | $290 (−120) | $317 (−147) | $219 (−49) |

Also: MCD one tick inside its 14 bp spread, 3 bp from the mark: 0 fills in 12 min (24 taker trades on the whole market).

What the recordings say (15 + 20 min of SoDEX's book and trades, `bookTicker` + `trade`): a fill while its level holds
(the front of the queue) earns +0.05 to +0.97 bp on ETH and SOL against the mid 5-30 s later; a fill that clears the
level (the back of the queue: the sweep) loses 0.2 to 1.8 bp. The bot's fills look like the second kind: it joins the
back of queues the fastest makers lead. Latency is a real part of it: SoDEX answers this laptop in 310-340 ms, and the
same settings cost $34-70 less per $1M from the Tokyo executor. Keeping queue place with a ladder did not pay: the
kept quotes are the ones a sweep reaches.

Where that leaves $100 per $1M: the fees alone are $170. Below that needs a positive gross, which only the front of the
queue or a spread of several ticks gives (ZEC's 6-tick spread was +$34 once, −$49 to −$156 the other runs). The levers
left are the fee floor (the bot fee: 0.5 bp = $50 per $1M; SoDEX's tiers 1.0 / 0.6 bp maker from $5M / $25M 14-day
volume; the maker rebate), and longer runs to tell 15-minute regimes from real differences.

## The Binance-led maker (2026-11-03, owner: "another Market Maker which quotes off of binance")

A volume maker (`kind: 'mm'`) with `ref: 'binance'`. The page shows it as its own strategy, **Binance-led maker**
(`presets.ts` strategy `lead`).

- **Fair price:** Binance USD-M's mid times the basis, the basis being SoDEX's mid / Binance's mid with a 30 s
  half-life (`copy-engine algo/reference.ts`).
- **Where it rests:**
  - `refBps` 0: the side that adds rests at SoDEX's best price, but only while that price is at least `pullBps`
    from fair.
  - `refBps` above 0: it rests `refBps` from fair: inside a wide spread, or behind a touch that is too close to fair.
  - The side that unwinds rests at a quarter of `refBps`, never through fair.
- **The fast pull:** every Binance tick checks the bot's resting quotes (`bots.ts pastFair`). A quote that fair came
  past is cancelled at once, without waiting for the next 500 ms step.
- **No fresh reference** (older than 2 s): it pulls everything and holds. Self-hosted executors have no reference,
  so it holds there too.

### The shared feed (`apps/executor/src/feed`)

The executor box (server 2) runs one process that holds the Binance sockets: **valuescan-feed**
(`deploy/server/units/valuescan-feed.service`).

**What it writes.** Every SoDEX perp Binance lists (54 on 2026-11-03), into a ring in tmpfs at
`/run/valuescan-feed/binance-l1`.

**The layout.** Byte for byte the trading box's `ARCFEED1` (apex-tokyo `arcus-peregrine/FEED_SHM.md`):
- a header, the feed and symbol tables, a latest table, and a 65,536-tick ring;
- a seqlock per 64-byte tick;
- a 100 ms heartbeat;
- a producer restart writes a new file and renames it into place.

**The sockets.**
- Two raced copies of every socket; the first arrival of an update id wins.
- 8 symbols per socket.
- Only price changes are written; a size-only update is no news for a reference price.

**The reader** (`feed/reference.ts`, in the executor):
- polls the ring every 2 ms and seeds from the latest table when it opens;
- opens its own Binance sockets while the ring is missing or silent for 0.5 s;
- goes back to the ring after it has beaten for 3 s.

`tools/feed-tap.ts` prints what the ring holds: ticks per symbol, Binance event -> feed delay, and the reader's
delay.

**Measured on server 2 (2026-11-03):**

| | Behind Binance's event time |
|---|---|
| Node's built-in WebSocket, which negotiates permessage-deflate (ETH alone) | p50 246 ms, p99 1,009 ms |
| `ws` without deflate (ETH alone) | p50 7 ms, p99 107 ms |
| `ws` with 54 symbols on one socket, busy symbols | p50 80-100 ms |
| `ws` with 8 symbols per socket | p50 5-30 ms |
| Price changes only, at busy times | p50 20-35 ms, p90 150-250 ms |

So every Binance socket here is `ws` with `perMessageDeflate: false`. On those numbers:
- The path itself is the limit: the same probe without the ring shows the same figures. The ring adds about 2 ms.
- apex-tokyo (AWS Tokyo) gets Binance at 1.6 ms p50. SoDEX's latency arbitrageurs (e.g. 0x773b, who fills about
  86 ms after a Binance move) run there and see a move well before server 2 does.

## Grid backtest and presets (2026-11-12, owner: "make the grid bots usable and as profitable as possible")

**Data.** 120 days of Binance USDT-M 1-minute candles for 17 SoDEX markets (1000PEPE AAVE ARB AVAX BNB BTC DOGE ETH
HYPE LIT NEAR SOL SUI UNI XAUT XRP ZEC), fetched and run on server 2 (`~/qrec/grid`: gfetch.py, gbt.mjs, gfeat.mjs,
gsum.py, gts.py). SoDEX keeps only ~7 days of 1m and ~35 days of 5m candles; over the same week SoDEX's own 1m
candles gave the same or slightly worse grid results than Binance's, so there is no SoDEX edge on top.

**Model.** The engine's grid exactly: geometric levels centred on the start price, buys below the gap and sells above,
a fill moves the gap, a level fills only when the price trades *through* it (no queue luck), out of range wait or
stop + taker close. Fee 1.7 bp a fill (SoDEX maker 1.2 + bot fee 0.5). Step = k x the market's hourly volatility
(sd of 5-minute returns over the past 24 h x sqrt 12, what the app reads). A grid started every day and run 7 days,
and every 6 h run 1 day.

**Result.** No grid setting earns reliably: on a price that is mostly a random walk a grid's step income is paid back
in what the price does to its holdings. The best are about break-even; narrow grids lose (fees x turnover); stopping
when the price leaves the range lost less than waiting in every setting. 7-day runs, mean over the 17 markets
(bp of the grid's notional a day, share of runs that lost, 10th percentile, daily volume / notional, $ per $1M):

| Preset | k x L | bp/day | lost | p10 | volume/day | per $1M |
|---|---|---|---|---|---|---|
| Wide grid | 4 x 10, stop | +1.1 | 38% | -33 | 0.16x | +$675 |
| Range grid (default) | 2 x 20, stop | +0.16 | 38% | -37 | 0.32x | +$51 |
| Dense grid | 1 x 40, stop | -0.47 | 38% | -38 | 0.61x | -$77 |
| (for contrast) | 0.5 x 20, wait | -3.5 | 77% | -16 | 0.71x | -$489 |

Single markets flip sign between the 1-day and 7-day runs (noise), so the app shows the pooled reading; the market's
own is in "How we know". Past-only filters (variance ratio, 24 h / 7 d trend, volatility vs the week) did not pick
better starts. The dense grid's ~$77 per $1M is the cheapest volume a grid gives - cheaper than the market maker's
~$185 in this sample, with far more variance.

**App** (bots/gridPresets.ts, gridBacktest.ts generated by gts.py, recipes gridc/grid/gridv): the preset step for grids,
the range from k x the volatility now (follows the market until the user types prices; "Follow the market" resets),
levels 10/20/40/60, the levels row says the gap and what a round trip keeps after fees (an error when it does not
cover them), the receipt shows the backtest's cost per $1M (fees, steps, price moves), how often it lost and an
average day on the chosen size, all at the wallet's own fee. Out of range defaults to stop for the presets.
