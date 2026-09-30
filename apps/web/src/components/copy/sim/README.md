# Copy simulation engine

This is the backtest behind "what if I had copied this trader" on the Copy page.
It is also the **reference logic for the future live copy executor**. The
executor should run the same event handler on each detected leader fill. A
result from this engine is then a faithful preview of live behaviour, minus the
effects listed under [Assumptions](#assumptions-and-known-gaps).

The design follows `docs/research/03-copy-trading-design-space.md`, section C.
Nothing here signs, sends or deploys anything. The engine and its tests were
ported from the rejected web draft (`archive/web-draft/src/pages/copy/sim`); the
algorithm is unchanged, the draft's UI and styles were not reused.

| File | Role |
|---|---|
| `types.ts` | Engine input (`SimFill`), `CopyConfig`, the log entry base type. |
| `engine.ts` | The pure, deterministic engine: `runCopySimulation(fills, config, opts)`. |
| `adapt.ts` | `VsFill[]` from `/api/vs/fills` to `SimFill[]`: venue, coin, order grouping, and the position-before walk (below). |
| `index.ts` | Public entry. `simulate` (worker for 5,000+ fills), `toSimFills`, `skipReasonLabel`. |
| `client.ts` | The worker wrapper. Everything below the threshold, and any worker failure, runs synchronously. |
| `sim.worker.ts`, `protocol.ts` | The worker entry and its messages. The worker strips `leaderFill` objects the caller already holds, and the main thread re-attaches them. |
| `*.test.ts` | Hand-computed scenarios, determinism, performance and the adapter. From `apps/web`: `npx tsx --test src/components/copy/sim/*.test.ts`. |

## From the contract to the engine (`adapt.ts`)

- **Venue** comes from the request; `/api/vs/fills` answers for one venue.
- **Coin** is derived from the symbol for the allow and deny lists:
  `BTC-USD` and `vBTC_vUSDC` (SoDEX) and `BTC`, `PURR/USDC` (Hyperliquid).
- **Order grouping.** `VsFill` has no order id, so fills printed in the same
  millisecond on the same market and side get one synthetic order id and are
  merged into one copied order (step 3 below).
- **Position before each fill.** `VsFill` carries no position-before. The
  leader's *current* positions are known (`vsApi.trader`), and the fills run up
  to now, so each perp market is walked **backwards** from its current position:
  `before = after - signedSize`. That is exact whenever the fills are contiguous
  up to now, which a "most recent N fills" answer always is. The venue's
  direction labels (`Open Long`, `Close Short`, `Long > Short`, ...) check the
  walk; a market whose walk contradicts more than one label (and more than 5%
  of them) is left to the forward rebuild. Spot markets are never walked: a spot
  balance moves with deposits and transfers that are not fills.

## Algorithm

### 1. Prepare

1. **Total order.** Sort the fills by time, then symbol, then order id (numeric-aware), then fill id, then input index. The result does not depend on input order. Venues return fills newest first.
2. **Drop bad fills.**
   - A fill whose `venue:id` was already seen is a **duplicate**.
   - A fill without a finite positive price and size, or without a valid side, is **invalid**.
   - Both are logged as skipped and never touch state.
3. **Merge order fills.** Consecutive fills with the same venue, symbol, side, time and (non-null) order id become one event at the VWAP price. One order often prints as many fills. Without merging, fixed-notional copies would open on the first print and hit the cap on the rest. It would also mean dozens of sub-minimum orders. Turn it off with `mergeOrderFills: false`.
4. **Split warm-up.** Fills before `startAt` are warm-up. They only rebuild the leader's positions and are never copied or counted as copied or skipped.

### 2. Per event (one leader fill or merged order)

For market `m` at price `p`:

1. **Mark to market.**
   - `mark[m] = p`.
   - Follower equity is `cash + Σ position × mark`, with cash accounting, so no entry prices are needed for equity.
   - Prices are only observed at leader fills.
2. **Leader position.**
   - `L_before` is the fill's `startPosition` when it is known (see `adapt.ts`). Otherwise it is the position rebuilt forward from the fills.
   - A mismatch re-syncs the shadow at `p` with zero PnL impact.
   - Then `L_after = L_before ± size`, and near-zero snaps to 0.
3. **If halted,** skip the event (`halted`).
4. **Position guards** on `m`, at the new mark:
   - Stop loss triggers when `mark` crosses `entry × (1 − s × stopLossPct / posLev)`. Take profit triggers when it crosses `entry × (1 + s × takeProfitPct / posLev)`. Here `s` is +1 long / −1 short, and `posLev` is `positionLeverage`, which defaults to `config.maxLeverage`. So the thresholds are "fraction of the position's margin", as on CEX copy platforms.
   - The close executes **at the trigger price**, plus slippage and fees. See the continuous-path assumption below.
   - The market is then **detached**.
5. **Account guards:**
   - **Drawdown stop.** When `(peak − equity) / peak ≥ drawdownStopPct`, close everything at the marks and halt. Sets `stoppedBy = 'drawdownStop'`.
   - **Liquidation backstop.** When `equity ≤ maintenanceMarginRate × gross notional` (default 2.5%), close everything and halt.
     - Equity is floored at 0, because the venue absorbs the shortfall.
     - It reports `stoppedBy = 'drawdownStop'` and `haltReason = 'liquidation'`, because the shared `stoppedBy` type has no liquidation member.
6. **Pre-existing positions.** On the first in-window fill of a market with `L_before ≠ 0`:
   - With `copyExisting = false`, detach the market. The rule is `NEW_POSITIONS_ONLY`: adopt only positions opened after the start.
   - With `copyExisting = true`, **join**: open to the target for `L_after` at this price.
7. **Asset filters.** Allow and deny are case-insensitive on `coin`. If `assetAllow` is non-empty, it wins.
8. **Detached markets.**
   - Stay detached until the leader is flat. That fill is skipped and re-attaches the market.
   - If the leader flips, the new side is copied as a fresh **open**. The old side was never ours.
   - This stops a stopped-out copy from re-entering on the leader's next add.
9. **Classify and target.** `F` is the follower position. The target `T(L)` depends on the sizing mode:

   | Mode | `T(L)` |
   |---|---|
   | `proportional` | `L × followerEquity(now, mark-to-market) / leaderEquity(t)` |
   | `fixedRatio` | `ratio × L` |
   | `fixedNotional` | `sign(L) × fixedNotionalUsd / p`, where `fixedNotionalUsd` defaults to `maxPositionUsd` |

   Each leader event sets the desired follower position `D`:

   | Leader event | Desired `D` |
   |---|---|
   | open (`L_before = 0`) | `T(L_after)` |
   | increase | `T(L_after)`, but never reduce: `|D| ≤ |F|` gives `at-target`. In `fixedNotional` mode with an existing position: `F × |L_after| / |L_before|`. |
   | decrease | `F × |L_after| / |L_before|` (the **same fraction** as the leader, C.3) |
   | close | `0` |
   | flip | close `F`, then `T(L_after)` as a fresh open |

   Opens and increases are **target-based** (`Δ = T − F`, C.3). An increase that was too small to trade therefore accumulates, and the next event picks it up. This is the C.2 "residual".
10. **Execute.**
    - **Reduce legs** (decrease, close, the close leg of a flip) are reduce-only.
      - They are exempt from the minimum notional, as on SoDEX.
      - Size is floored to the lot. A reduce that rounds to zero lots is skipped as `lot-size`. A full close always closes exactly.
    - **Grow legs** are clamped, in this order:
      1. `|position| × p ≤ maxPositionUsd` (`max-position`).
      2. `gross notional ≤ maxLeverage × equity` (`max-leverage`).
      3. Then the size is floored to the lot. If `lots × lot × p < minNotional`, the leg is skipped (`min-notional`, or the cap that shrank it).
      - A leg that was executed but made smaller records `clampedBy`.
    - **Fill price** is `p × (1 ± slippageBps / 10⁴)`, always adverse.
    - **Costs** are `notional × (takerRate + builderFeeTenthsBps / 10⁵)`. With `builderFeeOnReduce: false` (the planned launch pricing, research 06: 5 bp on opens and adds, closes free) reduce legs pay the taker fee only.
    - **Realised PnL** is gross, at the executed price, with fees separate (as Hyperliquid's `closedPnl`).
    - **Entry** is a weighted average on increases and unchanged on reductions.
11. **Record.**
    - Every event produces one log entry (`SimTrade`), copied or skipped.
    - Guard closes add entries: `stop-loss`, `take-profit`, `drawdown-stop` and `liquidation`. Each one points at the fill that revealed the trigger.
    - `copiedFills + skippedFills + warmupFills === fills.length`.

### 3. Output

- **`equityCurve` and `leaderCurve`.** Both use the same timestamps and are downsampled to `maxCurvePoints` (default 2,000).
  - Each bucket keeps both curves' minimum and maximum. There is one point per timestamp, so time strictly increases, as chart libraries need.
  - `maxDrawdown` is computed on the full-resolution path.
- **`leaderCurve`.** The leader's own replayed PnL, marked at the same prices and including the leader's reported fees. It is scaled to the follower's start: each PnL increment is multiplied by `startEquity / leaderEquity(t)`, the leader's equity at that moment, and the curve is floored at 0. With a constant leader equity that is exactly `startEquity × (1 + leaderPnL / leaderEquity)`; with a series it keeps deposits and withdrawals from reading as gains or losses (engine version 2; version 1 divided by the start equity only).
- **Leader equity** (`leaderEquitySource`), in order of preference:
  1. **`series`.** `leaderEquitySeries` as a step function: the last point at or before each fill.
     - Points use `accountValue`.
     - PnL-only series (SoDEX) are anchored with `leaderEquity` as the value at the last point.
  2. **`option`.** A constant `leaderEquity`.
  3. **`estimated`.** The leader's peak gross exposure in the window, meaning 1x leverage is assumed. This is deliberately conservative: it under-sizes rather than over-sizes. It also adds a note.
- **`notes`.** Data caveats to show near the result: estimated equity, missing position-before (SoDEX), duplicates, invalid fills, liquidation.

### Skip reasons

These are stable ids. `SKIP_REASONS` maps each to a label.

- **Bad data:** `duplicate`, `invalid-fill`.
- **Filters:** `asset-not-allowed`, `asset-denied`.
- **Detached markets:** `pre-existing-position`, `after-stop-loss`, `after-take-profit`.
- **Halted:** `halted`.
- **Cannot size:** `no-leader-equity`, `no-equity`.
- **Nothing to do:** `at-target`, `no-follower-position`.
- **Caps and venue limits:** `max-position`, `max-leverage`, `min-notional`, `lot-size`.

## Assumptions and known gaps

These are what the backtest does not see. The live executor handles them, or they are open work.

- **Execution.**
  - Every follower order fills in full at the leader's fill price plus the **full** configured slippage. This is a worst case for a slippage-capped IOC (C.2).
  - Detection-to-order latency is not modelled (see D). Neither is liquidity or depth.
  - Real IOCs can partially fill. The live executor re-attempts later within the cap (C.3).
- **Prices.** Marks exist only where the leader traded that market. Stops and guards react only at those moments.
- **Stops.**
  - Stops fill at the trigger price. That assumes a continuous price path with no gap past the stop.
  - The drawdown stop and the liquidation backstop close at the observed marks.
- **Margin.**
  - The model is a cross-margin dedicated copy sub-account (C.5 isolation).
  - Stop loss and take profit use the position's initial margin, `entry notional / positionLeverage`.
  - Liquidation is an account-level backstop with one maintenance rate (default 2.5% of notional; set it with `maintenanceMarginRate`). Real rates vary per market, from 1.25% on Hyperliquid BTC to about 5% on 10x alts.
- **Leverage cap.** It is enforced when a position grows. Price moves can push leverage above the cap with no forced deleveraging, as on the venues.
- **Funding** is not modelled. It is paid hourly on both SoDEX and Hyperliquid. The leader curve omits it too, so the comparison stays like for like.
- **Fees.**
  - Taker fees apply on every follower order, including take profit.
  - Defaults are tier 0 (research 06): Hyperliquid 4.5 bp perps / 7 bp spot, SoDEX 4.0 bp / 6.5 bp. `feeRate` overrides them.
  - The builder fee is added on top.
- **Lots and minimums.**
  - Unless `lotSize` is given, the lot is the power of ten worth $0.10–$1 at the first observed price. That is close to Hyperliquid `szDecimals`.
  - The minimum notional is $10 (SoDEX spot $5), as documented for both venues. Set it per venue with `minNotionalUsd`.
- **Position reconstruction without `startPosition`.**
  - A position opened before the first fill is invisible. Its close looks like a new open in the other direction.
  - `adapt.ts` removes this for perps by walking back from the current positions. Otherwise use `startAt` and older fills as warm-up. A note is emitted.
- **Spot** markets are treated like perps (a signed position). The venues report spot position-before as the balance, so pre-existing holdings are handled like pre-existing positions.
- **Leader deposits and withdrawals** move `accountValue`. Proportional sizing then follows those moves, and C.1 suggests smoothing leader equity over a window. Pass a smoothed series if needed.

## Mapping to the live executor

| Engine | Live executor (C.3–C.6) |
|---|---|
| per-market state: `lPos`, `fLots`, `fEntry`, `detached` | Durable state per (subscription, market). Persist the last processed `(symbol, t)` with it. |
| per-run state: `peak`, `halted` | Durable state per subscription. `halted` should also set `status = 'stopped'` in the CopyRegistry. |
| steps 2–10 for each event | The fast path, one delta order per leader fill, using the same `D` computation and caps. |
| reduce legs | `reduceOnly` IOC orders, exempt from `minNotional`. |
| grow legs | IOC limit at `mark × (1 ± slippageBps)`, clipped into the venue price band. |
| stop loss / take profit | The follower's own protective TP/SL orders at the same trigger prices, placed after each fill. |
| target-based opens | The same residual semantics. C.4 reconciliation (every 15–60 s) converges `F` to `T(L)` between fills. The engine does not simulate that between fills. |
| `mergeOrderFills` | Batching of one block's prints per leader order before sizing. |
| not modelled | Nonce WAL and deterministic `clOrdID` (C.6), per-IP rate limits, partial fills, detection latency. |
