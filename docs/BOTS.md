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
| **DCA bot** | `dca` + `bot: true` | A fixed amount every interval, resting only (maker exec). | fees $170 |

Not offered: anything that takes. A taker bot pays SoDEX 4.0 bp + the bot fee + half the spread: $450+ per $1M.
Delta-neutral across two markets or two accounts is not offered either: SoDEX perps are one-way netted per account,
so a hedge needs a second account, and a bot trading against its owner's other account is wash trading.

SoDEX tiers (docs/research/10-pooled-fee-account.md): maker 1.2 / 1.0 / 0.6 / 0.2 / 0 bp from $5M / $25M / $100M /
$500M 14-day volume. A user who reaches tier 1 through bots pays $150 per $1M; tier 3, $70.

## The fee

Bots carry **5 tenths of a bp (0.5 bp)** on every order (`BOT_FEE`, packages/copy-engine/src/policy.ts), whatever
the volume - not the copy ladder (2.5 → 1 bp), which other hosted algos keep. SoDEX charges each order the fee it
names, up to the account's approved ceiling, so the copy approval (25) already covers it: a user approves nothing
new. Where the fee is chosen: `ExecutorService.algoFee` (apps/executor/src/service.ts), used by the algo sink's
builder, the approval check and the fee estimate alike.

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

Real bots follow real algos: off for everyone except `EXECUTOR_LIVE_ALGOS_WALLETS` on server 2 (the test
follower), and the web's `LIVE_ALGOS` switch (apps/web/src/algo/liveAlgos.ts). Practice bots run for everyone
against the real book and send nothing.

## Tests

- `packages/copy-engine/test/algo-bots.test.ts`: quotes, skew, cap, grid moves, book and series; the runtime
  against a fake SoDEX: post-only refusals, partial fills, re-price pause, 429s in a row, restart, brake, key
  expiry, the kill switch, volume target and loss limit, stop-and-close, pause/resume, updates.
- `apps/executor/test/bots.test.ts`: the bot fee (0.5 bp) vs the ladder, the live gate, signed updates, archive.
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

What the runs say:
- **Fees are the floor: $170 per $1M** at SoDEX tier 0 (1.2 bp maker + 0.5 bp bot fee). The volume maker at the touch
  adds $40-57 of adverse selection: $210-227 per $1M, about **$6,500 of volume an hour per $12 quote**.
- Quoting away from the mid (1.7 bp) did not help: fewer fills ($580/h), and the ones it got were the price running
  through it ($547 per $1M).
- A grid with steps above the 3.4 bp round-trip fee earns them back (run 2: $93, run 4: $50 per $1M - closest to break-even) but trades only when the
  price swings across its levels; in a one-way move it holds what it sold or bought on the way (run 3).
- Run 3's grid exposed a bug: a level SoDEX refused in its answer went out again every 0.5 s until the bot hit its
  25-refusal limit. Fixed: a refused level (and a refused maker quote) waits 3 s, doubling to a minute.
- Break-even needs a lower fee floor, not tuning: SoDEX tier 1 ($5M/14 d) takes the maker to 1.0 bp ($150 per $1M),
  tier 2 ($25M) 0.6 bp ($110), and the maker rebate (-0.1 to -0.3 bp above 0.5-3% of SoDEX's maker volume) more.
