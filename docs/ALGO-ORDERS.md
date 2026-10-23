# Algo orders (2026-10-23)

One instruction that the engine works into many child orders over time, in the trader's own SoDEX perps
account. Ten engine kinds, eleven menu entries (Chase TWAP is a TWAP preset), three places to run them,
one engine.

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
(no taker child while the spread is wider) and **paper** (runs against the live book and tape, sends
nothing; fills are simulated: takers at the touch, resting orders when the tape trades through them).

| Kind | Settings |
|---|---|
| TWAP | duration (1 min - 30 d), slices (one every ≥ 5 s), **urgency curve** (−1 back-loaded … +1 front-loaded, ~20× first/last), size jitter, time jitter, execution per slice (**taker** IOC with a slippage cap / **maker** post-only re-priced after N ticks / **hybrid**: rests for a share of each slice, then takes what is behind), max participation (a slice takes at most X% of the last interval's volume), at the end take the rest or leave it |
| Chase TWAP | a TWAP preset: hybrid or maker slices only |
| VWAP | as TWAP; the weights are the **median volume of the same UTC slot** over 1-56 days (weekdays matched with weekdays and weekends with weekends from 14 days), floored at a tenth of the mean slot; **adaptive**: blends in the volume the market actually trades (faster when it is busier than usual, between half and twice the schedule) |
| POV | rate (1-50%) of what **everyone else** trades since it began (its own prints are left out), largest child, stop after, execution, at the end |
| Iceberg | visible size ± jitter, **pegged** to the best price (offset, re-price distance) or at a fixed price, post-only, refill delay ± jitter |
| Chase | rest at the touch (offset in ticks; −1 steps inside the spread) or **stalk** N bp behind it, re-price after N ticks (at most once a second), **max chase** from where it started, give up after T, then **take / cancel / leave resting** |
| Scale | from / to, orders (2-100), **size curve** flat / linear / exponential / bell with a skew, **price spacing** even / even in % / denser near the first / denser near the last, size jitter, post-only; one signed batch per 50 levels; quick ranges ±0.5…10% from the price |
| DCA | USD per order, orders, every, **outside the limit: skip or wait** (and catch up), **dip boost** (× more when the price is X% better than the average so far), total budget, execution |
| Swarm | clips (2-200), clips per wave (1-20, the aggression), pause between waves, irregular clips, a **slippage cap**, **retries** for what did not fill |
| Conditional | up to 5 conditions, all / any, **hold time** (no firing on a wick), expiry. Conditions: price ≥ / ≤ (mark, last, mid, index), **crosses** (must be seen on the other side first), **moves** ±X% within a window, **funding** rate, **open interest** change within a window, **spread**, **volume** traded within a window, **ratio** of two markets, **time**. Then: market, limit, **close X% of the position**, start a **TWAP** or a **Chase** |
| Trailing stop | trail in % or USD, **activation price**, size: the whole position at the time it fires or an amount, mark or last, exit **market** (slippage cap) or **chase** (rests first, takes after N s) |

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
- An algo **begins only with a quote in hand**: its arrival price is the mid at that moment.
- 25 refusals in a row fail the algo, with the last reason in its log.

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
- Algo leverage follows the ticket, like a manual order; the EEA 2x cap applies to copies only.
- Spot algos are not offered yet (the engine and the executors' keys are perps-only).
- Not live-tested with real funds: the engine runs against the live SoDEX feed in paper mode (verified in
  the browser, every kind), and its order path is covered by tests; a small live run per mode is the owner's.
