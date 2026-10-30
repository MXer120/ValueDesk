# Copy trading: what a user can go through, and where it is tested

Written 2026-10-30 (owner: "everything a user COULD go through we went through with tests"). Every option a
follower can set, every leader and follower event, every step of a copy's life, on every place a copy runs: the
browser, the ValueDesk executor (hosted) and a self-hosted executor. Each row names its deterministic test (runs
offline in CI, `node deploy/ci/run-tests.mjs`) and its live scenario (real money on SoDEX mainnet,
`apps/executor/tools/live-test`, never run by CI), or says why it has none.

The inventory: 74 items (3 run-place items, 21 settings and values, 21 leader events, 15 follower-side events, 14
lifecycle steps) plus the 28 skip reasons. Each has a deterministic test; 61 of them also run live, and the 13 that
do not say why (their rows, and section 8).

Paths: `ce/` = `packages/copy-engine/test/`, `ex/` = `apps/executor/test/`, `web/` = `apps/web/src/`. Live ids:
`copy.*` are `scenarios/copy.ts`, `copym.*` are `scenarios/copy-matrix.ts` (new, this matrix), `liq.*`
`scenarios/liquidation.ts`, `setup.*` `scenarios/setup.ts`. New test files: `ce/matrix-planner.test.ts`,
`ce/matrix-runtime.test.ts`, `ex/copy-matrix.test.ts`.

**Where a live scenario runs.** Every copy scenario runs on all three targets (`--target self|hosted|browser`) and
with either leader (`LIVE_LEADER_VENUE=sodex|hyperliquid`, the `self-hl` part of `all.ts`), except: those that
restart the executor (`copy.restart`, `copym.restart-close`: self and browser, where a restart is a reload; not
hosted), `copym.tab-close` (browser only), the Hyperliquid-only ones (`copy.hl-*`, `copym.hl-different-asset`:
skipped without `LIVE_HL_LEADER_KEY` / with a SoDEX leader, saying why), and the slow ones (`copy.tp-fires` is not
slow but waits up to 20 min; `liq.copy-follower`, `copym.drawdown`: `--slow`). A dry run (`--dry`) runs each copy's
lifecycle on paper and counts what needs a leader's trade or SoDEX as "live only".

Run the new ones: `node node_modules/tsx/dist/cli.mjs apps/executor/tools/live-test/run.ts --only copym.* [--slow]
[--target hosted|browser] [--dry]`.

## 1. Run places

| Item | Values | Deterministic | Live | Not live, why |
|---|---|---|---|---|
| Where the copier runs | browser, hosted, self | `ce/runtime.test.ts` (one engine; `mode` is only a label); `ex/service.test.ts` (hosted, self pairing); `web/copy/copy.test.ts` (a self-hosted copier on loopback; readiness per mode); `web/copy/browserCopier.test.ts` (browser fee) | every copy scenario on `--target self`, `hosted`, `browser` | - |
| The copy key per place | `vd-copy-browser` (7 days), `vd-copy-tokyo`, `vd-copy-self` (180 days); a key the follower made | `ex/service.test.ts` "keys: created sealed, registered..."; `ex/keyimport.test.ts`; `ex/stale-reads.test.ts` | `setup.key`, `setup.key-import` (self, hosted) | - |
| Terms (accepted with a country, version bumps) | accepted / missing / stale version | `ex/service.test.ts` "terms: every statement..."; `ex/copy-matrix.test.ts` "a stale terms version ... refused" | `setup.terms` | - |

## 2. Settings (every field of `CopySettings`, `packages/copy-engine/src/settings.ts`)

Validation of every field (bounds, just past them, words, NaN, Infinity, types, defaults), the canonical signed
form and the summary: `ce/matrix-planner.test.ts` "settings: ..." (7 tests); the setup form's parsing:
`web/components/copy/setup.test.ts`; every value reaching the executor as signed: `ex/copy-matrix.test.ts` "every
rule a follower signs reaches the copy as signed".

| Setting | Values | Deterministic (beyond validation) | Live |
|---|---|---|---|
| `direction` | copy, counter | `ce/matrix-planner.test.ts` "every sizing mode x direction x leader venue..." and every pairwise test below; `ce/counter.test.ts`; `ce/not-on-sodex.test.ts` (counter of a different asset) | `copy.counter`, `copym.counter-flip`; copy everywhere else |
| `sizingMode` | proportional | `ce/planner.test.ts` "proportional open..."; `ce/matrix-planner.test.ts` (all modes alike); `ce/hyperliquid-leader.test.ts` (unified account equity) | `copy.proportional` |
| | fixedRatio | `ce/planner.test.ts` "fixed ratio and fixed amount"; `ce/matrix-planner.test.ts` | `copy.fixed-ratio-flip`, `copy.hl-follow`, `copym.max-position` (2), `copym.below-min-open` (0.5), `copym.counter-flip` (1) |
| | fixedNotional | `ce/audit-copy.test.ts` (adds and scale-outs too small to trade); `ce/matrix-planner.test.ts` | `copy.fixed-notional` and most others |
| `allocationUsd` | 10 .. 10,000,000 | proportional base and copy equity: `ce/planner.test.ts`; the drawdown peak moves with it: `ce/audit-copy.test.ts` "BUG runtime: lowering a copy's allocation..."; `ce/matrix-runtime.test.ts` "a running copy cannot change its trader... every other rule it can" | `copy.proportional` (1.2x the leader), `copym.two-markets` (1.5U as the leverage base), `copym.drawdown` ($10), `copym.free-margin` ($1,000,000) |
| `ratio` | 0.0001 .. 10 | as fixedRatio | 0.5, 1, 2, 3 (`copy.max-leverage`) |
| `fixedNotionalUsd` | 10 .. 1,000,000 | as fixedNotional; `copy.size-change`'s unit twin: `ce/matrix-runtime.test.ts` | U, 1.5U (`copy.size-change`), 2U (`copym.manual-reduce`), up to 4U (`copym.drawdown`), 1,000,000 (`copym.free-margin`) |
| `maxLeverage` | 1 .. 50, floored | `ce/matrix-planner.test.ts` "caps per mode, direction and region..."; `ce/policy.test.ts` "effective leverage"; the stops' triggers: "guards x side x leverage x status" | `copy.max-leverage` (1x, SoDEX at 1x), `copym.two-markets` (1x gross over two markets), `copy.tp-fires` (the region's highest), `copym.margin-cross` (SoDEX at 2x) |
| `maxPositionUsd` | 10 .. 10,000,000 | `ce/matrix-planner.test.ts` "caps per mode and direction: max position..."; `ce/audit-copy.test.ts` "max-position cap rounds DOWN" | `copym.max-position` |
| `stopLossPct` | off, 0.01 .. 1 | `ce/matrix-planner.test.ts` "guards x side x leverage x status"; `ce/matrix-runtime.test.ts` "BUG a change of the stop-loss ... moves the copy's SoDEX stops"; `ce/edge-liquidation.test.ts` (its stop filled vs a liquidation) | `copy.sl-tp-orders`, `copy.tp-fires`, `copym.stops-follow-rules` (SL only, then off), `copym.stop-keep` |
| `takeProfitPct` | off, 0.01 .. 100 | as above (a short's take-profit of 100% of the margin or more is no price: none placed) | `copy.sl-tp-orders`, `copy.tp-fires`, `copym.stops-follow-rules` (TP only) |
| `drawdownStopPct` | off, 0.01 .. 1 | `ce/matrix-planner.test.ts` "the drawdown stop: off never halts..."; `ce/matrix-runtime.test.ts` "the drawdown stop halts and closes ... resumed"; `ce/planner.test.ts` "guards: ..." | `copym.drawdown` (slow; inconclusive when the market does not move against the copy in 20 min) |
| `assetAllow` | empty (all) or coins | `ce/matrix-planner.test.ts` "coin filters x direction x event"; `ce/matrix-runtime.test.ts` "copy existing: on ... (a coin the allow list leaves out is skipped)" | every scenario (the main coin only), `copym.copy-existing` (the second coin left out), `copym.two-markets` (two coins), `copy.hl-not-on-sodex`, `copy.hl-k-prefix` |
| `assetDeny` | empty or coins | as above | `copym.asset-filters` (changed mid-position) |
| `copyExisting` | false, true | `ce/matrix-runtime.test.ts` "copy existing: on ... off ..." and "copy existing after a restart"; `ce/runtime.test.ts` "positions open when copying starts are left alone" | `copym.copy-existing`, `copym.pre-existing` |
| `slippageBps` | 1 .. 500 | `ce/matrix-planner.test.ts` "slippage cap x side x market band"; `ce/audit-copy.test.ts` "slippage cap" | `copym.slippage` (10 bp, checked on SoDEX's order record); 50 bp elsewhere |
| `marginMode` | isolated, cross | `ce/audit-copy.test.ts` "BUG runtime (live): a failed leverage change..."; `ce/edge-liquidation.test.ts` "isolated vs cross" | `copym.margin-cross`; isolated everywhere else (`copy.max-leverage` reads it back) |
| `approval` | auto, confirm | `ce/matrix-runtime.test.ts` "BUG ask me each time answered yes, no, with an error or not at all" and "where nobody can ask"; `ex/copy-matrix.test.ts` "ask me each time on an executor"; `ce/audit-copy.test.ts` "BUG runtime: ask me each time trades without asking..." | `copym.confirm` (executors: held; browser: yes, no and no answer through the page's prompt) |
| `paper` | false, true | `ce/runtime.test.ts` "paper copy end to end"; `ce/matrix-runtime.test.ts` "a paper and a live copy of one leader..."; `ex/service.test.ts` (paper needs no key) | every `--dry` run; `copym.paper-and-live` (a paper copy in a live run) |
| `leader.venue` | sodex, hyperliquid | `ce/matrix-planner.test.ts` (every test x venue); `ce/hyperliquid-leader.test.ts` | every copy scenario with either leader |
| `leader.address` | a 0x address | `ce/matrix-planner.test.ts` "the leader is a 0x address..."; `ex/sanctions.test.ts` "a listed leader cannot be copied" | the harness's leader; `copym.stop-all-leaders` (a second, idle one) |

## 3. Sizing modes x directions x leader venues x leader events (pairwise)

`ce/matrix-planner.test.ts` runs the full product: 3 modes x 2 directions x 2 venues x (open, add, reduce, flip,
close) to exact sizes, legs, sides and reduce-only flags; a long walk never on the wrong side; the caps (max
position; the follower's leverage; the EEA 2x, named as the binding one) per mode and direction; every status,
coin filter, detach reason, holder, same-asset verdict and slippage cap against every event.

## 4. Leader events

| Event | Deterministic | Live | Not live, why |
|---|---|---|---|
| Open, add, reduce, close | `ce/planner.test.ts`; `ce/matrix-planner.test.ts` | `copy.fixed-notional`, `copy.hl-follow` | - |
| Flip (long to short) | `ce/planner.test.ts` "flip"; `ce/edge-copy.test.ts` "leader flip whose new side is under SoDEX's minimum"; `ce/audit-copy.test.ts` (a missed flip) | `copy.fixed-ratio-flip`, `copym.counter-flip` | - |
| Partial fills / several prints of one order | `ce/audit-copy.test.ts` (a second fill before the first copy order is booked; the reconcile racing the stream) | `copy.hl-slices` (three slices back to back, each copied once) | the leader's own IOC filling in part cannot be forced |
| Several markets at once | `ce/planner.test.ts` "gross leverage counts the copy positions on other markets"; `ce/audit-copy.test.ts` "EEA 2x caps exposure across markets" | `copym.two-markets`, `copym.asset-filters`, `copym.own-position` | - |
| Open below SoDEX's minimum ($10), caught up by the next add | `ce/matrix-planner.test.ts` "a growth too small to trade is not lost"; `ce/audit-copy.test.ts` | `copym.below-min-open` | - |
| Reduction below the minimum (reduce-only is exempt) | `ce/planner.test.ts` "below the minimum order value is skipped; reductions are exempt"; `ce/audit-copy.test.ts` (scale-outs below one lot) | `copy.reduce-below-min` | - |
| Leader already holds a position when the copy starts | `ce/matrix-runtime.test.ts` "copy existing ..." | `copym.copy-existing`, `copym.pre-existing` | - |
| Leader trades while no copier runs | `ce/audit-copy.test.ts` "BUG runtime: a leader close that happened while the copier was down..."; `ce/matrix-runtime.test.ts` "copy existing after a restart" | `copy.restart` (add), `copym.restart-close` (close), `copym.tab-close` (browser) | - |
| Leader ADL (SoDEX cut the leader) | `ce/edge-copy.test.ts` "leader ADL ...", "leader ADL seen only on REST" | - | ADL cannot be provoked; to the copier it is a reduction (`copy.fixed-notional`, `copy.reduce-below-min`) |
| Leader liquidated | `ce/edge-copy.test.ts` (a cut or close seen on REST is copied, reduce-only) | - | it would cost the leader's margin and up to 70 min (as `liq.copy-follower` does for the follower); to the copier it is the leader's position going flat, which `copy.fixed-notional` and `copym.restart-close` run live |
| A size that is not a number | `ce/audit-copy.test.ts` "BUG planner: a NaN leader size..."; `ce/matrix-planner.test.ts` (bad-leader-size) | - | a malformed venue answer cannot be produced |
| The same print twice (reconnect) | `ce/audit-copy.test.ts` "the same stream print twice ... is copied once" | `copy.restart` (no order twice) | - |
| A market halted or delisted while the leader trades | `ce/edge-copy.test.ts` (3 tests); `ex/not-on-sodex.test.ts` | - | SoDEX halts and delists, not the harness |
| Proportional with the leader's equity unknown | `ce/planner.test.ts`; `ce/matrix-planner.test.ts` (no-leader-equity) | - | the leader's account always reads |

### A leader on Hyperliquid

| Event | Deterministic | Live | Not live, why |
|---|---|---|---|
| A coin SoDEX lists (BTC on BTC-USD, by notional) | `ce/planner.test.ts` "a Hyperliquid leader is sized by notional"; `ce/matrix-planner.test.ts` (every test on both venues) | `copy.hl-follow`, every copy scenario in the `self-hl` part | - |
| kPEPE-style 1000-unit coins | `ce/audit-copy.test.ts` "Hyperliquid kPEPE (1000 units) maps to 1000PEPE-USD"; `ce/same-asset.test.ts` | `copy.hl-k-prefix` (when SoDEX lists one) | - |
| `xyz:` (HIP-3) coins | `ce/hyperliquid-leader.test.ts` "a trade.xyz position the stream copied stays open across reconciles", "firehose: trade.xyz and other HIP-3 coins are followed"; `ce/same-asset.test.ts` "xyz:GOLD far from GOLD-USD" | - | the harness signs Hyperliquid IOCs on its own dex only (`hyperliquid.ts`'s guard, by design) |
| An unlisted coin | `ce/not-on-sodex.test.ts`; `web/components/copy/notCopyable.test.ts` | `copy.hl-not-on-sodex` | - |
| A different asset under the same name | `ce/same-asset.test.ts`; `ce/matrix-planner.test.ts` "a Hyperliquid leader x same-asset verdict x event" | `copym.hl-different-asset` (when one is priced over 5% apart at run time, else skipped) | - |
| Spot (`@n`) | `ce/planner.test.ts` "unlisted and spot markets are not copied" | - | the harness's leader trades perps only |
| Unified account equity | `ce/hyperliquid-leader.test.ts` | `copy.proportional` in the `self-hl` part | - |

## 5. Follower-side events

| Event | Deterministic | Live | Not live, why |
|---|---|---|---|
| The follower's own position on the leader's market | `ce/planner.test.ts`; `ce/matrix-planner.test.ts` "who holds the market x event" | `copym.own-position` | - |
| A copied position made smaller by hand | `ce/edge-liquidation.test.ts` "BUG partial liquidation...", "a reduction of the copier's own whose fill the stream missed..." | `copym.manual-reduce` | - |
| A copied position closed by hand | `ce/edge-liquidation.test.ts` (closed outside, detached until the leader is flat) | `copym.manual-close` | - |
| A copied position added to by hand (adopted) | `ce/edge-liquidation.test.ts` "stale: ... larger ... is never adopted" (only reads that agree adopt it) | `copym.manual-add` | - |
| Its stop-loss / take-profit fired on SoDEX | `ce/edge-liquidation.test.ts` "the copy's own SoDEX stop-loss filled..." | `copy.tp-fires` | - |
| Liquidated, in full or in part, isolated or cross | `ce/edge-liquidation.test.ts` (11 tests); `ex/notices.test.ts` | `liq.copy-follower` (slow) | a partial liquidation cannot be asked for: SoDEX decides |
| Follower ADL | `ce/edge-copy.test.ts` "follower ADL"; `ce/edge-liquidation.test.ts` "liquidated in part" | - | cannot be provoked |
| Too little free margin | `ce/planner.test.ts` "free margin: ..." (4 tests); `ce/runtime.test.ts`; `ex/limits-alerts.test.ts` "a live copy SoDEX refuses for margin is held" | `copym.free-margin` | - |
| Builder approval missing or under the fee | `ce/runtime.test.ts` "a live copy without a covering builder approval is blocked..."; `ce/edge-copy.test.ts` "builder approval lowered under the fee mid-run"; `ce/edge-liquidation.test.ts` "stale: ... builder approval one read misses" | `copym.builder-low` (lowered to 1 bp, then set back), `setup.builder` | - |
| Copy key missing, replaced, expired | `ex/edge-cases.test.ts` "the trading key expiring mid-run"; `ex/stale-reads.test.ts` (5 tests); `ex/limits-alerts.test.ts` "a refused key holds every copy..."; `ex/audit.test.ts` (key TTL) | - (`setup.key` registers one) | keys live a day at least, and revoking the run's key would hold every scenario after it |
| Region: EEA 2x | `ce/policy.test.ts`; `ce/matrix-planner.test.ts` (region-leverage, the stop triggers at 2x); `ce/matrix-runtime.test.ts` (the stops move with the country); `ce/edge-copy.test.ts` | every scenario reads the region's cap (`t.expectedLeverage`); `copy.max-leverage`, `copym.margin-cross` read SoDEX's leverage | - |
| Region: US, UK, Canada close-only; sanctioned countries | `ce/policy.test.ts`; `ce/runtime.test.ts`; `ce/audit-copy.test.ts` (blocked even when SoDEX's read fails); `ex/copy-matrix.test.ts` "a region that does not allow copying"; `ex/audit-algo2.test.ts` | - | declaring a country one does not live in breaks the terms; the run's own region is checked |
| A sanctioned follower or leader | `ce/sanctions.test.ts`; `ex/sanctions.test.ts` | - | needs a listed wallet |
| The operator's brake | `ce/runtime.test.ts` "brake: ..."; `ex/brake-audit.test.ts`; `ex/edge-cases.test.ts` | - (a hosted brake is `inconclusive`, not a failure) | the brake is the operator's |
| SoDEX down, reads that disagree | `ce/edge-copy.test.ts` "SoDEX down when the leader closes"; `ce/edge-liquidation.test.ts` "stale: ..." (7 tests) | - | cannot be provoked |

## 6. The lifecycle

| Step | Deterministic | Live |
|---|---|---|
| Start (every rule as signed) | `ex/copy-matrix.test.ts`; `ex/service.test.ts` | every scenario |
| Start refused: a second copy of the trader (same venue and kind), over the copies a wallet may run, the executor closed, no key, no terms, the region | `ex/copy-matrix.test.ts` "at most EXECUTOR_MAX_COPIES..."; `ex/service.test.ts`; `ex/audit.test.ts` "BUG: two live subscribes ... start two copies" | `copym.paper-and-live` (a second live copy refused on the executors) |
| Pause; the leader trades meanwhile | `ce/audit-copy.test.ts` "BUG runtime: a leader close while the copy was paused..."; `ce/matrix-runtime.test.ts` "paused while the leader opens" | `copy.pause-resume-close` (close while paused), `copym.pause-open` (open while paused) |
| Resume from paused, blocked, halted | `ce/matrix-runtime.test.ts` (halted: from the equity at the resume); `ce/runtime.test.ts` (blocked) | `copy.pause-resume-close`, `copym.builder-low` (blocked), `copym.drawdown` (halted, slow) |
| Change the rules mid-position | `ce/matrix-runtime.test.ts` "a running copy cannot change its trader...", "BUG a change of the stop-loss..."; `ex/copy-matrix.test.ts` (refused changes) | `copym.asset-filters` (filters), `copym.stops-follow-rules` (stops), `copym.confirm` (approval), `copy.size-change` (amount, between trades) |
| Stop and close | `ce/audit-copy.test.ts` "BUG runtime (live): stop and close whose close order is refused..."; `ce/edge-liquidation.test.ts` "stale: stopped with close..." | `copy.stop-close` |
| Stop and keep the positions | `ce/audit-copy.test.ts` "BUG runtime (live): stop keeping positions cancels the SoDEX stop-loss..."; `ce/matrix-runtime.test.ts` "stop keeping the positions" | `copym.stop-keep` |
| Stop all (several leaders) | `ce/runtime.test.ts` "the kill switch stops every copy"; `ce/matrix-runtime.test.ts` "stop is final; stop all ... two leaders" | `copym.stop-all-leaders` |
| A stopped copy stays stopped | `ce/runtime.test.ts`; `ce/matrix-runtime.test.ts` | `copy.stop-close`, `copym.stop-all-leaders` (the leader's next trade not copied) |
| Executor restart (hard kill) | `ce/audit-copy.test.ts`; `ce/edge-liquidation.test.ts` "liquidated in full while the copier was restarting"; `ex/audit-algo2.test.ts` | `copy.restart`, `copym.restart-close` (self) |
| Browser tab reload | `web/algo/tabLife.test.ts` (the algos' rule; copies go on through a reload) | `copy.restart`, `copym.restart-close` (browser: a reload) |
| Browser tab closed | - (the browser copier runs only while a tab is open and catches up when one opens: `ce/audit-copy.test.ts` restart tests are the same code) | `copym.tab-close` |
| Several copies of one leader | `ce/matrix-runtime.test.ts` "a paper and a live copy of one leader..."; `ex/copy-matrix.test.ts` (another venue or kind is another copy) | `copym.paper-and-live` |
| Several leaders | `ce/matrix-runtime.test.ts` (two leaders on one market: the second copy leaves it to the first; stop all) | `copym.stop-all-leaders` |

## 7. Every skip reason and notice

Every `SKIP_REASONS` entry the planner gives is produced, with nothing sent, by `ce/matrix-planner.test.ts` "every
skip reason the planner gives is reachable" (26 reasons); the runtime's two, `declined` and `confirm-timeout`, by
`ce/matrix-runtime.test.ts`. Notices: `ce/notices.test.ts`, `ce/not-on-sodex.test.ts`, `ce/same-asset.test.ts`,
`ce/edge-liquidation.test.ts`, `ex/notices.test.ts`; live, the wallet's notices are read by `copym.manual-reduce`
(reduced, warn), `copym.manual-close` (closed, error), `copym.drawdown` (halted, error), `copym.hl-different-asset`
(different-asset, warn), `liq.copy-follower` (closed, error) - on self and hosted (a browser's are its bell).

## 8. What stays untestable live

- **ADL and leader liquidation**: SoDEX decides them; the leader's would cost its margin and up to 70 min. The
  copier sees a reduction or a close, which run live.
- **A partial fill of the leader's order, a partial liquidation, a halt or delisting, SoDEX down or its reads
  disagreeing**: the exchange's, not the harness's.
- **Hyperliquid's HIP-3 (`xyz:`) coins and spot**: the harness's Hyperliquid client signs IOCs on its own dex only.
- **A blocked or sanctioned region, a sanctioned wallet**: it would mean declaring a country one does not live in
  (against the terms) or a listed wallet.
- **A key expiring**: keys live at least a day; revoking the run's key would hold every scenario after it.
- **The operator's brake**: the operator's, on the hosted executor.
- **The drawdown stop, the stop-loss / take-profit firing**: they need the market to move; `copym.drawdown` and
  `copy.tp-fires` are inconclusive, not failed, when it does not.

## 9. Bugs these tests found (fixed)

1. **A change of the stop-loss, take-profit, leverage or region left the copy's SoDEX stops as they were**
   (`runtime.ts` `update`): a stop-loss the follower turned off stayed on SoDEX and could still close the position;
   one turned on or moved waited for the copy's next fill. The stops are now placed again at once (forced
   `refreshStops`; its client ids never repeat within a millisecond). `ce/matrix-runtime.test.ts` "BUG a change of
   the stop-loss...", live `copym.stops-follow-rules`.
2. **"Ask me each time" left unanswered was logged as "You declined this trade"** (`confirm-timeout` existed but
   was never used): the host's `confirm` may now answer `'timeout'` (the browser copier does after 60 s), logged as
   "Not confirmed in time". `ce/matrix-runtime.test.ts` "BUG ask me each time answered yes, no, with an error or not
   at all", live `copym.confirm` (browser).

## 10. Findings for the owner (not changed)

1. **An unanswered "ask me each time" prompt holds the follower's whole queue** for up to 60 s in the browser:
   another copy's stop-loss, take-profit or drawdown close of the same wallet waits behind it (the SoDEX stops still
   hold). `ce/matrix-runtime.test.ts` todo "FINDING ...". A fix moves the prompt out of the queue (and re-plans after
   the answer); it touches `process()` and the guards' queueing.
2. **A fixed amount keeps its size per leader unit through a capped add**: after an add clamped by max position, a
   leader reduction takes a fixed-amount copy to (per unit set at its open) x (the leader's size), while a
   proportional or fixed-ratio copy keeps the clamped one - leader 2 to 1 BTC: fixed amount $1,000 to $800,
   proportional $1,000 to $500. Pinned as it is in `ce/matrix-planner.test.ts` "caps per mode and direction".
3. **The browser copier takes a second copy of the same trader** (the executors refuse it, 409). The engine keeps
   one copy per market (the second skips `owned-by-other-copy`), so nothing doubles; noted by `copym.paper-and-live`.
4. **Margin mode changed while the copy holds a position**: SoDEX refuses a margin-mode change under an open
   position, so the copy opens and adds nothing more on that market (`leverage-not-set`, reductions go on) until it is
   flat. By design of `ensureLeverage`; no test pins the add being held.
