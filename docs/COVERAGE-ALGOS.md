# Algo orders: what a user can do, and where each is tested (2026-10-30)

Every algo option a trader can reach (the order ticket, the signed executor API, the browser runner), every
value it takes, every lifecycle action, and every refusal, with the tests that cover it. The goal (owner,
2026-10-30): everything a user could go through, we went through with tests.

**Where.** The engine is one (`packages/copy-engine/src/algo/`), run in three places: **browser** (this tab),
**hosted** (ValueDesk's executor), **self** (a self-hosted executor). The deterministic tests run the engine
itself; the live suite (`apps/executor/tools/live-test`) runs the same scenarios on each of the three targets
(`--target self|hosted|browser`; README.md there).

**Columns.**

| Key | File |
|---|---|
| **S** | `packages/copy-engine/test/matrix-algo-spec.test.ts` - the parser: every number at both ends and past them, every choice, every default, every conflict (190 tests) |
| **R** | `packages/copy-engine/test/matrix-algo-runtime.test.ts` (+ `matrix-rig.ts`) - the runtime against a faked SoDEX, with the invariants below checked after every tick (302 tests) |
| **W** | `apps/web/src/components/algo/matrix-draft.test.ts` - every ticket field to the spec the engine reads (61 tests) |
| AR, EA, AT, AE, AS, AL, AP, SW | earlier engine tests: `algo-runtime`, `edge-algo`, `audit-timesliced`, `audit-events`, `audit-resting`, `algo-limits`, `algo-plan`, `algo-sweep` |
| D, WA, BR | earlier web tests: `components/algo/draft.test.ts`, `components/algo/audit-algo2.test.ts`, `algo/audit-browser.test.ts` + `tabLife` tests |
| X | `apps/executor/test/algos.test.ts`, `audit-algo2.test.ts` (the signed API, the gates) |
| **L** | live, `scenarios/algos.ts` (39 scenarios) |
| **M** | live, `scenarios/algo-matrix.ts` (36 scenarios, ids `mx.*`; `--only mx.*`) |

**The invariants R checks after every tick, for every algo, whatever its options:** every price on SoDEX's tick and
every size on its step; no order under SoDEX's minimum order value (and minimum quantity) at its own price, none over
its largest; no order past the limit price on the algo's side; a reduce-only algo sends only reduce-only orders; no
post-only order through the book (unless the trader set exactly that); one child working at a time for the kinds that
work one; never more filled than the size; nothing at all sent for a paper algo.

## 1. Where it runs, and practice

| Item | Values | Deterministic | UI | Live | Not live, why |
|---|---|---|---|---|---|
| Run place | browser, hosted, self | R (one engine); BR (Web Lock, standby tab, takeover); X (signed start/act, owner checks, limits per wallet, live gate) | `AlgoTicket.test.ts`, `executor.test.ts` (choice, close-only places run in the browser) | every L and M scenario on each target | - |
| Practice (paper) vs live | `paper: true/false` | R "paper, every kind" (nothing reaches SoDEX); AR "paper: nothing is sent"; X gate tests | W "practice" | `--dry` runs every scenario on paper; **M `lifecycle.practice-beside-live`** (a paper algo next to a live one on a live run: nothing of it on SoDEX) | - |
| Real algos gate | wallet allowed or not | X `EXECUTOR_LIVE_ALGOS_WALLETS`; `liveAlgos.test.ts` | - | hosted/browser: inconclusive without the wallet listed | - |

## 2. Shared options (every kind that takes them)

| Item | Values | Deterministic | UI | Live | Not live, why |
|---|---|---|---|---|---|
| Side | buy, sell | S choices; R every kind both sides where it differs (TWAP x exec, chase, scale, DCA, swarm, trailing, bracket, sweep, basket legs, exits) | W | L + M both sides per kind (M adds: TWAP taker sell, VWAP sell, POV sell, iceberg sell, chase buy-rest, scale sell, DCA sell, swarm buy, conditional sell, trailing buy, bracket sell, sweep sell) | - |
| Size | base units (canonical decimal), USD (DCA, basket legs), the position (close, trailing) | S sizes (0, negative, 1e13, '1e-3', text refused; canonical); R step-rounding test | W; D | L, M | - |
| Reduce-only | on/off | S (no exits on it; no reduce-only bracket); R "reduce-only bigger than the position" (swarm, TWAP, sweep, chase: never flips), invariant | W (no leverage, no exits sent) | L `reduce-only.no-flip`; M `trailing.amount-activation` (reduce-only amount) | - |
| Limit price | none, a price; buy never above, sell never below | S (wrong-side fixed prices refused: iceberg, scale levels, bracket entry, conditional limit); R invariant on every child; R DCA skip/wait | W; WA (not sent where hidden) | L `twap.limit-price`, `dca.limit-skip`, `sweep.limit-expire`; M `twap.maker-leave`, `lifecycle.limit-update` | - |
| Upper / lower bound x reaction | hold, stop, rush, on the mark | S; **R "bounds:" 8 kinds x 2 bounds x 3 reactions (48)** + scale (any bound ends it); AR bounds | W (hidden where the ticket hides them: WA) | M `twap.bound-hold`, `twap.bound-stop-rush`, `iceberg.fixed-rush` | A bound crossed by the market moving cannot be provoked: live, each starts with the bound already reached. |
| Start price | from below, from above | R "start price reached from below / above" | W | M `twap.start-later` (far away: nothing sent, cancelled clean) | Reaching a price on purpose: the market decides. |
| Start time | a time | R "start time"; WA (decimals) | W | M `twap.start-later` | - |
| Spread guard | 1..5000 bp | S; **R "spread guard" for TWAP, VWAP, POV, iceberg, chase, DCA, swarm, basket** | W | M `twap.sell-shaped`, `lifecycle.limit-update` (a value set, changed live) | SoDEX's spread is not ours to widen: the hold itself is only shown in R. |
| Leverage | none, 1..100; capped at the market's max and the region's | S (1..100, whole); **R leverage table** (3x, 5x, 100x on a 50x market, EEA cap, none, reduce-only sets nothing) | W | L `leverage.set` (5x isolated, region cap); **M `twap.participation-leverage` (100x cross: SoDEX shows the market's or region's max)** | - |
| Margin mode | cross, isolated, none | S; R leverage table | W | L (isolated), M (cross) | - |
| Region rules | blocked (US, sanctioned) held; close-only (UK...) closes only; EEA 2x on leverage and gross exposure | R region tests (US, IR, GB; the 2x room shrinks a child then holds; paper not held); AR; X (re-declared country) | `AlgoTicket.test.ts` | hosted from Germany: the 2x cap applies to every live scenario (`leverage.set` checks it) | A blocked region cannot be tested live by design (the run stops at the start). |
| Label | text, 40 characters | S | - | M (`twap.bound-hold` changes it live) | - |
| Exits: take-profit / stop-loss | %, price, either or both, long and short | S (both forms refused, wrong side refused, short TP < 100%, not on reduce-only / close / trailing / basket / conditional algo); **R "exits:" 9 opening kinds x 2 sides** (sized to the fill, closing side, kill switch pulls them); AR; EA | W; WA | L `twap.exits` (%), `bracket.tp-fires` (prices, OCO), `conditional.algo-bracket`; **M `twap.short-exits` (prices, short), `conditional.short-exits`, `bracket.sell-limit-filled`, `conditional.any-twap-oco` (SL only)** | A stop-loss firing: it needs the market to fall 1-3% in the scenario's minutes (`bracket.tp-fires` fires a TP 4 bp away instead). |

## 3. Execution of a slice (TWAP, VWAP, POV, DCA)

| Item | Values | Deterministic | UI | Live | Not live, why |
|---|---|---|---|---|---|
| Style | taker, maker, hybrid | **R TWAP 3 styles x 2 sides**, VWAP, POV, DCA x styles; AR | W | L taker buy, maker sell, hybrid; M TWAP taker sell, VWAP maker, POV maker + hybrid, DCA maker + hybrid | - |
| Max slippage | 1..500 bp | S; R slippage-reference tests | W | every taker scenario | - |
| Slippage from | touch, mid, mark, index, oracle mid, oracle fair | S; **R each of the six (price within the cap of that reference) + no fresh oracle holds** | W | **M `twap.sell-shaped` (mid), `twap.slip-references` (mark, index, oracle mid, oracle fair)** | - |
| Resting share (hybrid) | 0.1..0.95 | S; R | W | L `twap.cancel-midway` (0.5); M `pov.hybrid-take`, `dca.sell-hybrid` (0.3) | - |
| Re-price distance | 1..10000 ticks | S; R | W | L, M | - |
| Offset | -5..10000 ticks | S | sent as 0 by the ticket | - (the ticket never sends one for a slice) | API only. |

## 4. Per kind

| Kind | Option | Values | Deterministic | UI | Live |
|---|---|---|---|---|---|
| TWAP | duration, slices | 1 min..30 d; 1..2000, one per 5 s | S (both ends, the 5 s rule); R | W, D | L, M |
| | urgency | -1..1 | S; R (+1 > 0 > -1 first slice) | W | M `twap.sell-shaped` (0.2) |
| | size / time jitter | 0..0.5 | S; R (0.5 each: total exact, inside the window) | W, D (Randomize) | M `twap.sell-shaped` |
| | smallest / largest slice | sizes, smallest <= largest | S; R; AT | W | M `twap.sell-shaped` |
| | finish | take, leave | S; R (maker, nothing filling) | W | L take; M `twap.maker-leave` |
| | max participation | 0.01..1 | S; R (held back by the tape, the finish takes the rest) | W | M `twap.participation-leverage` |
| | close a share of the position | 0.01..1 | S; R (50% of a long, 100% of a short, no position expires, a failed read waits); AT | W | L `twap.close-reduce-only` (100%); M `twap.close-half` (50%) |
| Chase TWAP | (TWAP preset) | hybrid or maker | W | W | L (hybrid TWAPs) |
| VWAP | lookback | 1..56 d | S; R (no history: even) | W | L 7 d; M 1 d |
| | adaptive | on, off | S; R | W | L on; M off |
| | jitter, finish, participation, execution | as TWAP | S; R 4 combinations | W | M `vwap.maker-sell` |
| POV | rate | 0.01..0.5 | S; R (1%, 10%, 50%: its share of all printed, its own included) | W (presets) | L 10%; M 50%, 20% |
| | largest child, end time, finish | size; time; take, leave | S; R | W | M `pov.sell-maker-end`, `pov.hybrid-take` |
| Iceberg | pegged / fixed price | - | S; R 4 combinations | W | L pegged GTX buy, fixed GTX sell; M pegged GTC sell |
| | post-only | GTX, GTC | S; R | W | L GTX; M GTC |
| | visible size, its jitter | size <= whole, 0..0.5 | S; R | W | M |
| | peg offset, re-price distance | -5..10000, 1..10000 | S; R (re-priced at chaseTicks, a fixed post-only price through the book waits) | W | M (-1, 3) |
| | refill delay, its jitter | 0..10 min, 0..1 | S; R | W | M (1 s, 0.5) |
| | rush | - | R bounds | - | M `iceberg.fixed-rush` |
| Chase | offset ticks / stalk bp | -5..10000 / 0..2000 | S; R (0, -1, 3 ticks, 20 bp; each priced exactly) | W | L 50 bp; M 2, -1 ticks |
| | re-price distance, pause | 1..10000, 250 ms..1 min | S; R | W (pause fixed 1 s) | M |
| | max chase, time limit | 1..5000 bp, 5 s..7 d | S; R | W (% to bp) | L, M |
| | at the end | take, cancel, rest - by time and by the cap (6) | R all six | W | L take, cancel; **M rest** |
| Scale | from / to / orders | prices, 2..100 | S; R | W | L, M |
| | size curve x spacing | flat, linear, exponential, bell x linear, geometric, front, back (16) | **R all 16 pairs** | W | L flat/linear; M linear/geometric, bell/front, exponential/back |
| | skew, size jitter, post-only | 0.001..1000, 0..0.3, on/off | S; R | W | M |
| | explicit levels and sizes (the ticket's DCA) | prices, weights | S (once each, positive, as many); R | W, D | L `scale.dca-ladder-pause` |
| DCA (ticket) | first buy, steps, step scale, typed prices, sizing (linear, weighted, geometric), unit (USD, coin) | - | (a scale with explicit levels) | W, D, WA | L `scale.dca-ladder-pause` |
| DCA (engine, API only) | per order, orders, interval | $10..1M, 2..1000, 1 min..30 d | S; R | not offered by the ticket since 2026-10-26 | L `dca.taker`, `dca.limit-skip`; M `dca.maker-wait`, `dca.sell-hybrid` |
| | outside the limit | skip, wait | S; R both | - | L skip; M wait |
| | dip boost, budget | 0.01..0.9 x 1..5; >= one order | S; R | - | M (set) |
| Swarm | clips, per wave, pause | 2..200, 1..20, 0..60 s | S; R (1/0 s, 3/5 s, 20/60 s) | W | L 3 in waves of 2; M one at a time |
| | irregular clips, retries | 0..0.9, 0..5 | S; R (0, 2, 5 retries against refusals) | W | M (0.15, 1) |
| Conditional | conditions x operator | price x 4 sources x above/below; cross up/down; move up/down/either; funding above/below; OI up/down/either; spread above/below; volume; ratio above/below; position long/short/flat/size above/size below/PnL above/PnL below; time | S all; **R each (31 cases): waits while it does not hold, fires when it does** | W all | L spread, funding, position long, price; **M last, mid, index, cross, volume, ratio, funding, time, move, OI, position flat, size above** |
| | match, hold, expiry | all/any, 0..1 h, a time | S; R (any vs all, a break restarts the hold, expiry) | W | M any + hold + expiry, all |
| | action | market, limit (GTC / post-only), close a share, start a TWAP / chase / any kind | S (every kind but conditional); R each (+ paper parent starts a paper child) | W | L market, post-only refused, close 100%, chase + OCO; **M GTC limit kept, close 50%, TWAP + SL** |
| Trailing stop | trail % / $ | 0.001..0.5 / a price | S (exactly one); R 4 combinations | W | L 0.1%; M $ |
| | side | sell (a long), buy (a short) | R | W | L sell; M buy |
| | source, exit, chase time | mark/last, market/chase, 1 s..10 min | S; R | W | L mark/market; M last/chase |
| | size, activation | whole position / an amount; a price | S; R (not armed: no fire; an amount; no position expires) | W | L whole; M amount + activation |
| Bracket | entry | market, limit | S; R 4 combinations | W | L market (TP fires), limit (cancelled); M limit that fills |
| | exits | %, price, one or both | S; R | W | L, M |
| Basket | style, legs | swarm, twap; 2..10, $10..10M, each market once, long/short | S; R 4 combinations | W | L swarm long/short, twap cancelled; M twap long/short paused and resumed |
| Fill fast | reference, venues | oracle mid, oracle fair, mark, index; any subset | S; R 4 combinations; SW | W, D | L oracle mid; **M oracle fair, mark, index, oracle mid of two venues** |
| | slippage, rounds, give up | 1..1000 bp, 0.5..60 s, 5 s..1 d / never | S; R (outside the band it gives up; no oracle: SoDEX's mark) | W | L, M |

## 5. What a user does with a running algo

| Action | Deterministic | UI | Live |
|---|---|---|---|
| Start | every test above | W | every scenario |
| Pause / resume | **R lifecycle, every kind (13)**: nothing sent while paused, resting pulled, goes on after | AlgoTable | L TWAP, scale ladder; **M iceberg + chase, basket legs** |
| Cancel | **R lifecycle, every kind**: nothing resting, stays cancelled, nothing sent after | AlgoTable | L many; M most |
| Cancel an ended algo (pulls what it left) | R chase `rest`, conditional limit; AR | AlgoTable | L `twap.exits`; M `chase.buy-rest`, `conditional.all-limit-kept` |
| Kill switch (cancel all) | **R every kind at once + exits pulled, other wallets untouched**; X | AlgoTable | L `kill.switch`; M `lifecycle.practice-beside-live` |
| Size up / down | **R every sized kind (9) x up and down: ends at exactly the new size**; refused for DCA, trailing, basket, conditional, close | AlgoTable (size) | L TWAP; **M scale ladder, bracket limit entry** |
| Change limit, spread guard, label | **R every kind**; what it is (side, kind, paper, market, reduce-only, leverage) refused | (signed API) | **M `lifecycle.limit-update`, `lifecycle.pause-resting`, `twap.bound-hold`** |
| Change bounds | R (the engine and the browser runner take them) | not offered | The signed executor API (`AlgoUpdatePatch`) takes only size, limit, spread guard and label: a change of bounds is refused there (400). Docs and engine say bounds may change; owner's call which is right. |
| Restart / reload | **R lifecycle "a crash mid-way", every kind**: no client id twice, never over the size; EA; X | tabLife tests (reload vs close) | L `twap.restart`, `iceberg.restart`, `scale.restart` (browser: a reload) |
| Tab close | `tabLife`, `edge-tabLife` | - | L `twap.tab-close` (browser) |

## 6. What is refused, and edge cases

| Case | Deterministic | Live |
|---|---|---|
| A child under SoDEX's $10 minimum, every kind (14 cases) | R "start refused"; AL; WA | L `twap.min-size` |
| Step and tick: a size off the step, a price off the tick | R (worked on the step; **a typed price is put on the tick**) | every scenario (prices from `t.tick`) |
| A limit price on the wrong side (buy above, sell below) | S conflicts (iceberg, scale levels, bracket, conditional limit, buy and sell) | - (refused before anything is signed) |
| SoDEX's price band (buy > 5% over, sell > 5% under the mark) | R | - (refused before signing) |
| Reduce-only bigger than the position | R | L `reduce-only.no-flip` |
| The region's 2x cap; leverage over the market's max | R | L `leverage.set`, M `twap.participation-leverage` |
| Conflicting options (48 pairs) | S conflicts | - (refused before signing) |
| A market not listed / not trading | R | - |
| SoDEX down, a key expiring, the brake, duplicate and late updates, the clock stepping back, delisted mid-run | EA (the earlier edge tests) | - (cannot be provoked safely) |

## Gaps closed, and bugs found (2026-10-30)

Found by the new tests, fixed in `packages/copy-engine/src/algo/runtime.ts`, each test failing before its fix:

1. **A price typed off the tick was sent off it** (an iceberg's fixed price, a bracket's limit entry, a conditional's
   limit): every child price is now put on SoDEX's tick in the trader's favour (a buy down, a sell up). R "step and
   tick".
2. **A ladder (scale, the ticket's DCA) raised while it rests was never worked**: its levels kept their old sizes and it
   ended expired short. Now each level goes back for its new size (less what it filled), as after a pause. R "size change
   scale", M `scale.size-change`.
3. **A bracket's limit entry raised or lowered ended the bracket** ("the entry order is no longer on SoDEX"). Now the
   entry goes back at the new size. R "size change bracket", M `bracket.limit-resize`.
4. **Fill fast's first round went out on SoDEX's mark although the trader chose the oracle**: the oracle's first answer
   was not waited for. It now waits for it (at most 3 s; an oracle that does not answer by then is not fresh, and the
   mark is the fallback as before). R "Fill fast from oracleFair", "the book outside the band... gives up".
5. **A conditional's limit that SoDEX took off right away (a post-only price through the book) still read "it rests on
   SoDEX"**: the conditional now says SoDEX cancelled (or rejected) it and that nothing rests, in its reason and its log.
   R "Conditional actions".

Found, not changed (owner's call):

- **Bounds cannot be changed through the signed executor API** (above, section 5).
- **A rush bound on a DCA** takes what is due now but keeps its later orders on their schedule (each order stays its own;
  "take everything that is left now" is not what a DCA does). Documented by R "bounds: dca ... rush".
- **A rush bound on a fill fast** changes nothing: it already takes all it can inside its band.
- **A bell size curve** puts about 7% (3 levels) or 5% (4 levels) of the size on its outer levels: a bell ladder small
  enough for a live run is refused under SoDEX's minimum unless it has 2 levels (where it is flat). Live runs a 2-level
  bell; the curve itself is in R.
- **A DCA exec object without a style** is hybrid (the engine default), while a DCA with no exec object is taker.
  Only reachable through the API (the ticket's DCA is a ladder).

## What stays untestable live, and why

- **A blocked region** (US, sanctioned): the run itself refuses to start there. R and X cover it.
- **A stop-loss firing, a trailing stop or a start price at a chosen level, a bound crossed by the market**: live, the
  market decides; the scenarios set their levels close (trailing 0.1%, a TP 4 bp away) or start with the level already
  reached, and are inconclusive (run again) when the market does not move in time.
- **SoDEX failing** (down, 429, a stale backend, a key expiring mid-run), **the operator brake**: cannot be provoked on
  the exchange without harm; EA, X and `limits-alerts` fake each.
- **A wide spread** (the spread guard holding): SoDEX's book is not ours to widen; R holds it on a faked book, live runs
  set the guard and change it.
- **Liquidations**: the slow live scenarios (`liq.*`) let SoDEX liquidate $12 on purpose; see the live-test README.

## Dry runs of the matrix (2026-10-30, `run.ts --dry --only mx.*`)

- **self**: 36 of 36 passed (on paper, against SoDEX mainnet's live book and tape).
- **hosted** (ValueDesk's executor, the release deployed then): 34 of 36. The two that fail are bugs 2 and 3 above
  (`mx.scale.size-change`, `mx.bracket.limit-resize`): fixed here, not yet released; they pass once it is. Two
  first-run failures were the scenarios' own and are fixed (a check against the arrival price; a time check that read
  this machine's clock against the executor's, which runs a few seconds apart).
- **browser**: not run. The runner's bootstrap stops before any scenario, at the test wallet's connect step
  (`apps/web/e2e/ui/harness.ts`: the `Wallet` button in the `Tools` rail not visible within 30 s in headless Edge), on
  a dev web served from this checkout: the same for every scenario of the suite, not one of these.
