# Algo orders (2026-10-23)

One instruction that the engine works into many child orders over time, in the trader's own SoDEX perps
account. Twelve engine kinds, thirteen menu entries (Chase TWAP is a TWAP preset), three places to run
them, one engine.

| | This browser | ValueDesk 24/7 (hosted executor) | Self-hosted |
|---|---|---|---|
| Runs | in an open ValueDesk tab (Web Lock `vd-algo-run:<wallet>`, one tab per browser) | the executor in Tokyo, 24/7 | the trader's own copier |
| Signs with | the trading key this browser holds, through `trading/actions.ts` `signAndSend` (the fee guard) | the key the trader registered for that executor (copy setup) | the copier's key |
| Builder fee per child | the trading fee owed now (1.5 bp default, lower by terms) | the copy fee ladder (2.5 bp → 1 bp) | the copy fee ladder |
| Instructions | clicks in the tab | EIP-712 `algo-start` (the spec, as the wallet shows it) and `algo-action`, kept append-only | the same |
| Books | IndexedDB `vd-algo` | SQLite `algos`, `algo_events` | SQLite |

Code: the engine is `packages/copy-engine/src/algo/` (types, spec parser, plan/preview, math, feed,
sink, runtime; tests in `packages/copy-engine/test/algo-*.test.ts`). The browser runner is
`apps/web/src/algo/` (`browserAlgos.ts`, `algoStore.ts`, `executorAlgos.ts`, `AlgoRunner.tsx`); the UI is
`apps/web/src/components/algo/` (`AlgoTicket.tsx` in the order ticket, `AlgoTable.tsx` as the account
band's Algos tab). The executor routes are in `apps/executor/src/service.ts` (`algoStart`, `algoAct`,
`algoList`, `algoEvents`) and `server.ts`; tests in `apps/executor/test/algos.test.ts`.

## The kinds and their settings

Every kind also has: side, reduce-only, leverage / margin mode (the ticket's), a **limit price** (no child
is ever sent past it), an **upper and a lower bound** on the mark with a reaction each (**hold**: pause
and pull resting children while past it; **stop**: end where it stands; **rush**: take everything left
now), a **start time** or a **start price** (it starts once the mark reaches it), a **max spread** guard
(no new child, taker or resting, while the spread is wider) and **paper** (runs against the live book and tape, sends
nothing; fills are simulated: takers at the touch, resting orders when the tape trades through them). A
paper algo in this browser needs **no wallet**: started with none connected, it runs in the browser's
paper book (owner `paper`, `algoBus.ts`) and a live one is refused there.

Every kind that opens a position can also carry **exits**: a take-profit and / or a stop-loss, each a
distance (%) from the average fill or a price. They are **SoDEX's own position stops** (a reduce-only
STOP market order triggered on the mark, the same order as a position's TP/SL from the ticket, with the
builder), placed after the first fill and **resized and re-priced as the algo fills** (every 5 s at most, and
once more when it ends). When one fills, the engine cancels the other (**OCO**); exits outlive the algo, so
the runner keeps watching them after it is done (`needsRunner`), and resizes them for a fill that lands
after the end. A placement with no answer is asked of SoDEX (open orders, then history) like a child; a
refused exit is tried again after 30 s, doubling, and given up after 5 refusals with an error in the log.
An exit cancelled on SoDEX by the trader is not placed again. **Cancel** on an algo that has ended pulls
what it still has on SoDEX (its exits, a child left resting on purpose) and keeps its final status; **Cancel
all** includes such algos. In paper they are watched against the mark. Not on reduce-only orders, a close,
a trailing stop (refused there) or a basket; a short's take-profit distance must be under 100%.

| Kind | Settings |
|---|---|
| TWAP | duration (1 min - 30 d), slices (one every ≥ 5 s), **urgency curve** (−1 back-loaded … +1 front-loaded, ~20× first/last), size jitter, time jitter, **smallest and largest slice** (what is due waits until it reaches the smallest, except at the end), execution per slice (**taker** IOC with a slippage cap / **maker** post-only re-priced after N ticks / **hybrid**: rests for a share of each slice, then takes what is behind), max participation (what it fills per interval is at most X% of that interval's volume: its own fills in the interval count against it), at the end take the rest or leave it; **close position**: a time-sliced close of X% of the position when it starts, reduce-only, on the side that reduces it |
| Chase TWAP | a TWAP preset: hybrid or maker slices only |
| VWAP | as TWAP; the weights are the **median volume of the same UTC slot** over 1-56 days (weekdays matched with weekdays and weekends with weekends from 14 days), floored at a tenth of the mean slot; **adaptive**: blends in the volume the market actually trades (faster when it is busier than usual, between half and twice the schedule) |
| POV | rate (1-50%) of what **everyone else** trades since it began (its own prints are left out), largest child, stop after, execution, at the end |
| Iceberg | visible size ± jitter, **pegged** to the best price (offset, re-price distance) or at a fixed price (not past the limit), post-only (a fixed post-only price at or through the book waits), refill delay ± jitter; a clip re-priced shows again with what it had left when SoDEX confirmed the cancel; a **rush** bound pulls the clip and takes the rest |
| Chase | rest at the touch (offset in ticks; −1 steps inside the spread) or **stalk** N bp behind it, re-price after N ticks (at most once a second), **max chase** from where it started, give up after T; when the price moves past the max chase **or** the time is up: **take / cancel / leave resting**. An order that is the best price on its side is not re-priced off its own price (no walking up over itself) |
| Scale | from / to, orders (2-100), **size curve** flat / linear / exponential / bell with a skew, **price spacing** even / even in % / denser near the first / denser near the last, size jitter, post-only; one signed batch per 50 levels; quick ranges ±0.5…10% from the price. Every level must reach SoDEX's minimum and be on the right side of the limit price, or the ladder is refused. A batch held (region cap, no key) waits; **pause** pulls the levels and **resume** puts each back for what it has not filled |
| DCA | USD per order, orders, every, **outside the limit: skip or wait** (and catch up), **dip boost** (× more when the price is X% better than the average so far), total budget, execution (a maker DCA only rests: it never takes, its last order included) |
| Swarm | clips (2-200), clips per wave (1-20, the aggression), pause between waves, irregular clips, a **slippage cap**, **retries** for what did not fill; clips under SoDEX's minimum are merged into the next one |
| Conditional | up to 5 conditions, all / any, **hold time** (no firing on a wick), expiry. Conditions: price ≥ / ≤ (mark, last, mid, index), **crosses** (must be seen on the other side first), **moves** ±X% within a window, **funding** rate, **open interest** change within a window, **spread**, **volume** traded within a window, **ratio** of two markets, **your position** on any market (long / short / flat, size ≥ / ≤, unrealised PnL ≥ / ≤), **time**. Then: market, limit, **close X% of the position**, start a **TWAP** or a **Chase** (with their exits: an OCO bracket after the trigger; a paper conditional starts a paper algo, under the same region rules). A limit SoDEX refuses ends it failed; a kept limit's fills are still followed (and its exits placed), also after a restart |
| Trailing stop | trail in % or USD, **activation price**, size: the whole position at the time it fires or an amount, mark or last, exit **market** (slippage cap) or **chase** (rests first, takes after N s) |
| Bracket | an entry at **market** (slippage cap) or as a resting **limit**, with its take-profit and stop-loss (at least one) as SoDEX position stops; one fills, the other is cancelled |
| Basket | 2-10 markets at once, each **long or short** with its own USD amount, each worked as its own **swarm** (clips, waves, slippage cap) or **TWAP** (duration, slices); started, paused, resumed and cancelled together (every leg is checked before any starts; a leg that cannot start fails the basket and stops the legs already started; a bound that stops the basket stops its legs); the Algos tab shows the legs inside the basket |

## How a child order is sent

- An ordinary SoDEX perps **limit** order: IOC to take (priced at the touch plus the slippage cap, inside
  SoDEX's band and never past the limit), GTX to rest (never takes), GTC for a ladder. It shows in open
  orders and fills like any order and can be cancelled there. Client order ids are `va-<algo>-<n>`.
- **At most one child in flight per algo** (a ladder and a swarm wave are one batch). A resting child is
  cancelled before a taker child goes out, so the two can never both fill.
- **Fills come only from SoDEX**: the `accountOrderUpdate` stream (cumulative per client order id). A write
  without an answer is **never re-sent**: the child is `unknown` until SoDEX's open orders (or, sparingly,
  the drip-limited order history) say what became of it; until then it counts as filled. After a restart
  every live child is `unknown` first.
- **Written ahead**: a child (with the algo state that goes with it, such as a ladder's progress or a
  conditional having fired) is in the store before the order leaves, its answer as soon as it is back, and
  every fill and settled order at once. A crash in between never sends it a second time.
- A pause or a cancel that lands while a step is in flight wins: nothing more is sent, an ended algo stays
  ended, and an order whose answer comes back after the cancel is cancelled again. A cancel also pulls
  children still on their way or `unknown` (by client id: harmless if they do not exist).
- No child is over SoDEX's max quantity or max order value (a larger amount goes out over several
  children); none is under its minimum at the child's own price (a sell's limit is under the bid); a
  largest slice / child under SoDEX's minimum is raised to it. Fill fast never prices a round past the
  limit price. An algo too small for SoDEX ever to send anything ends **failed**, not done.
- A size change (`update`) never leaves more working than the new size: resting children past it are
  pulled (the last placed first); a schedule spreads the change over what is still to come.
- An algo **begins only with a quote in hand**: its arrival price is the mid at that moment.
- 25 refusals in a row fail the algo, with the last reason in its log.
- **Region rules** (`policy.ts` `regionPolicy`, as for copies): a live algo of a trader in a blocked region
  (US, sanctioned) is **held**; in the EEA the leverage it sets is capped at **2x** and no child may take
  the account's gross exposure past 2x its equity (a child is shrunk to the room left, or held). The
  country is the stricter of the one declared in the signed copy terms and the one the executor sees the
  request come from (the browser uses the same two). Paper algos are not held.

## SoDEX's native orders

- **Used**: exits are SoDEX position stops (`STOP` modifier, market, mark trigger, reduce-only), so a
  stop-loss holds even while no runner is up; children are plain limit orders (IOC / GTX / GTC).
- **Not used: native TWAP** (`newTwapOrder`): it has no builder field, so the fee guard refuses it (see
  Open). The engine's TWAP does more anyway (curves, jitter, slice bounds, maker slices, exits).
- **Not used: attached bracket** (`BRACKET` + `ATTACHED_STOP`): its exits are sized once, from the entry;
  the engine's exits follow every fill of an algo instead.

## A local run against live data

`npx tsx apps/executor/tools/paper-run.ts [seconds]` boots the hosted executor on this machine against
SoDEX mainnet's live feed, signs the terms, a session and one `algo-start` per kind with a throwaway
wallet - **paper only**, the script refuses anything else - and prints each algo's status, fills, average
and log. Run on 2026-10-23: TWAP, Chase TWAP with exits, POV, iceberg, chase, DCA, swarm, conditional,
trailing stop, basket (BTC long + ETH short) and bracket all filled on paper; VWAP and scale were still
working their schedule / ladder when the run ended, as planned.

## What the trader sees

- The ticket: the Algo tab names the algo and opens a menu of all of them; each kind's settings; a **preview
  drawn from the engine's own plan with the same seed** (the slices that will go out, the ladder, or the
  levels it acts at), with the per-child value, interval, end time, average if a ladder fills, fee range
  (all resting … all taking), and every reason SoDEX would refuse part of it (minimum order value, step,
  maximum notional) with the fix in words. A review before start; real funds are marked.
- The Algos tab (next to Open Orders): per algo the progress, average fill **vs arrival** and **vs the
  market's VWAP over the same window** (bp, positive = better for the trader), resting share (maker fill
  %), fees, children and refusals, the working order, next child / end, conditions holding or waiting, and
  its whole log. Pause / resume / cancel per algo, **Cancel all** across every place it runs.

## Against Hyperdash (research, 2026-10-23)

Hyperdash (docs.hyperdash.com) has TWAP (30 s fixed sub-orders, ±20% size/time, no price limit), Chase TWAP,
Chase (no offset, timeout or fallback), Scale (even spacing, linear skew only), Swarm (IOC clips, undisclosed
slippage, no retries), VWAP (≥ 3 h, fixed curve, no edits, one per market), POV (≥ $10,000, lags a minute,
drops shortfalls, one per market), Iceberg (no post-only, never re-priced), price-only conditional
orders and a full-position trailing stop with no activation price. No DCA, no grid. The table above is the
answer: price bounds with a reaction and a start price on every kind; configurable TWAP intervals and slice
execution; urgency curves; adaptive VWAP from 15 minutes up; POV on others' volume with no floor;
post-only / pegged icebergs; chase with stalking, caps, timeouts and fallbacks; scale curves for size and
spacing; DCA with bands and dip boosts; swarm with a slippage cap and retries; conditions on price, moves,
funding, OI, spread, volume, ratios and time that can start another algo; trailing stops with activation
and a chase exit; paper mode; execution analytics; pause / resume on every kind; no one-per-market caps.

## Open (owner)

- **SoDEX's native TWAP** (`newTwapOrder`, 5-1440 min, randomize, reduce-only) exists in `@sodex-core`
  but carries **no builder field**: the fee guard refuses it in a build that requires the builder (every
  public build). The engine's TWAP is used instead (each child carries the fee). Offering the native one
  would mean trades without the fee.
- **Hosted algos use the copy terms and the copy fee ladder.** The copy terms text speaks of copying; if
  algo orders on the hosted executor need their own wording, that is a terms change
  (`COPY_TERMS_VERSION` goes up, every follower signs again).
- The region rules hold algos as they hold copies. A browser algo of a wallet that never accepted the copy
  terms has no declared country: only the country the executor saw (if any) applies to it.
- Spot algos are not offered yet (the engine and the executors' keys are perps-only).
- Not live-tested with real funds: the engine runs against the live SoDEX feed in paper mode (the local
  executor run above; in the browser, bracket, basket and TWAP with exits started from the ticket with no
  wallet), and its order path is covered by tests; a small live run per mode is the owner's.
