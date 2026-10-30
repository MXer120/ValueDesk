# UI coverage: trading, algos and copies

Every control a user can operate on the website's order ticket, algo ticket, Algos table, copy window, copy
management, the account tables' actions on them and the bell's algo and copy notices: where each one is tested, and
what cannot be tested without real money.

The inventory was taken from the code on 2026-10-30 (branch `copy-trading`, after `c4c3953`).

## Where the tests are

| Suite | What it is | Where |
|---|---|---|
| UI specs | Playwright in the installed Edge against the local dev web; ARIA selectors; a throwaway wallet (`wallet.ts`), practice algos and paper copies. Every spec runs twice: on a 1600x1000 desktop and on a phone (375x812, touch, a phone's user agent; `--viewport`). Not in CI. | `apps/web/e2e/ui/*.spec.ts`, run by `npx tsx e2e/ui/run.ts` from `apps/web` |
| Fake SoDEX account | For the UI specs: the throwaway wallet gets a SoDEX account answered inside the browser context. Every gateway write is fulfilled there and never forwarded. Reads about the wallet come from the fake account; market data comes from SoDEX. Each write's body is decoded, and its signer is recovered from the same EIP-712 digest SoDEX checks. Stateful (`stateful: true`): orders rest and fill, stops rest, leverage is kept. A fake leader (`leader`): its reads answered, its trades printed on the routed public `trade` stream, which the browser copier follows. | `apps/web/e2e/ui/sodexFake.ts`, `trade.ts` |
| UI steps | What a person does on a page, one step at a time (the ticket and its review, Cancel, Close, the copy window, Manage copies, the copy prompt, the algo ticket, the Algos table). The live browser target clicks with them for real money; `uiSteps.spec.ts` runs the same steps against the stateful fake. | `apps/web/e2e/ui/uiSteps.ts` |
| Unit | `node:test` through tsx; `deploy/ci/run-tests.mjs` suite `web-unit` | `apps/web/src/**/*.test.ts(x)` |
| Live | Real money on SoDEX mainnet, through each executor and the browser target. Every result is checked against SoDEX's own account data. | `apps/executor/tools/live-test` (`--target browser` drives `e2e/ui/bridgeSession.ts`; `scenarios/ui.ts` clicks the pages) |

**Spec files:**
- `orderTicket`: types, TIF notes, units, MAX
- `tpsl`: Gain/Loss, wrong-side notices
- `orderFlow` (new): enable trading, review, Place, the signed bodies, leverage, margin, spot
- `accountActions` (new): Close, the TP/SL sheet, Cancel
- `algoTicket`: menu, run places, practice, exits, bridge
- `algoFlow` (new): every kind's spec, refusals, the Algos table buttons, a notice, previews, phone width
- `copySetup`: run places, sign-in, terms, fee/key gates, a paper copy
- `copyFlow` (new): every rule, refusals, counter, Manage copies
- `notices`: the bell's filters
- `staleBuild`
- `uiSteps` (new): the live browser target's steps against the stateful fake: a limit and Cancel, a market buy and
  Close, TP/SL on an entry, leverage and margin mode, a copy from the copy window closed from Manage copies, "Ask before
  each trade" answered in the prompt, a bracket's exits pulled from the Algos table

**Live scenarios that click the pages** (`apps/executor/tools/live-test/scenarios/ui.ts`, browser target only, U =
$12 each, under 3 minutes, flat at the end): `ticket.limit-cancel`, `ticket.market-close`, `ticket.tpsl`,
`ticket.leverage`, `algo.ui-cancel-exits`, `copy.ui-close`, `copy.ui-confirm`. Each runs the same `uiSteps.ts` steps as
`uiSteps.spec.ts`, and checks SoDEX's own account data. They are written and pass offline and in a dry browser run;
the first real-money run is the parent session's.

**Legend for the "Tested in" column:**
- `UI` means a UI spec. `UI+fake` means a UI spec against the fake SoDEX account, which also checks the signed body.
- `unit` means a unit test.
- `live` means the real-money live suite.
- `-` means not tested. The reason is in the Notes column.

## Order ticket (`components/OrderEntry.tsx`, `ReviewPosition.tsx`)

| Control / flow | What is checked | Tested in |
|---|---|---|
| Direction Long / Short (Buy / Sell on spot) | side = 1 / 2 in the signed order; the labels on spot | UI+fake `orderFlow` |
| Order type Market / Limit / Stop (Algo) | each type's own fields; spot offers Market and Limit only | UI `orderTicket`, UI+fake `orderFlow` |
| Price, MID | the limit price on the wire is the price typed. A price typed right after a market or Futures/Spot switch is kept (bug 2). | UI `orderTicket`, UI+fake `orderFlow`, unit `priceSeed.test.ts` |
| Trigger, Kind (stop-loss / take-profit), Executes as (market / limit), Trigger on (mark) | in the order: stopPrice, stopType, triggerType = mark, type, and a stop-limit's price and TIF | UI+fake `orderFlow` |
| Amount, unit toggle (coin / USDC) | coin <-> USDC at the order price; a USDC size goes out in the coin | UI `orderTicket`, UI+fake `orderFlow` |
| MAX, % slider and box | 100 % with no balance sizes nothing; with a balance, balance x leverage / price (MAX and 25 %) | UI `orderTicket`, UI+fake `orderFlow` |
| Leverage popover (typed, slider, presets, Confirm) | clamped to the market's maximum; Confirm sends one `/trade/leverage` signed by the trading key; SoDEX shows what it sent, and it is set back the same way | UI `tpsl`, UI+fake `orderFlow`, `uiSteps`; **live** `ticket.leverage` |
| Margin mode Cross / Isolated | one leverage change with marginMode 1; the review then says "isolated" | UI+fake `orderFlow`, `uiSteps`; **live** `ticket.leverage` |
| Reduce only | sent as reduceOnly; with TP/SL it is refused on Place before anything is signed | UI+fake `orderFlow` |
| TIF GTC / IOC / GTX (post-only) | the notes; post-only that would take disables the button; IOC and GTC on the wire | UI `orderTicket`, UI+fake `orderFlow` |
| TP/SL switch, TP / SL price, Gain / Loss in $ and %, the unit swap | the arithmetic; held while entry, size and leverage change; wrong-side notices | UI `tpsl`, unit `tpsl.test.ts`, `exitEntry.test.ts` |
| TP/SL on the wire | a BRACKET entry plus two ATTACHED_STOP market legs, opposite side, reduce-only, same size, at the prices shown; on SoDEX both rest as stops at exactly those prices | UI+fake `orderFlow`, `uiSteps`; **live** `ticket.tpsl` |
| Read-out: Order value, Margin required | the exact value in the app's number format. It read "$0,00" before (bug 1). | UI+fake `orderFlow`, unit `numStyle.test.ts` |
| Read-out: Liq. price, Slippage (Max slippage pop-up), Fees | a market order's limit sits within the slippage cap (the default) | UI+fake `orderFlow` (cap only) |
| The button's gates: Connect wallet, Create account, Enable trading | each label; Enable trading signs ValueDesk's terms, the builder fee and one trading key on both engines, and nothing else | UI `orderTicket`, UI+fake `orderFlow` |
| Review: rows, sub-line, exits block, "real funds" title | Size, Entry, Order value, Margin, Est. liquidation, fees, Signs as, Exits, GTC, cross Nx, market wording | UI+fake `orderFlow` |
| Review: stop past liquidation | the warning; Place waits for "I understand liquidation would happen before this stop loss." | UI+fake `orderFlow` |
| Review: Back to ticket | nothing is sent | UI+fake `orderFlow` |
| Review: "Don't show this review again" | remembered only after Place; the next order under $10,000 has no review | UI+fake `orderFlow` |
| Place: the signed order | path, accountID, symbolID, legs, builder `{id, fee}` within the approval, X-API-Key, signer = the registered trading key | UI+fake `orderFlow` |
| Success toast "Limit long placed" (+N exit orders) | text and detail | UI+fake `orderFlow` |
| Refusals: below the minimum, post-only through the touch, reduce-only + exits, a stop with exits | the words, and nothing signed | UI+fake `orderFlow` |
| SoDEX rejecting inside an accepted batch | "SoDEX rejected the order: the order: ..." on the ticket; no "placed" toast | UI+fake `orderFlow` |
| Account mismatch ("Trading disabled: viewing ..."), Unlock to trade, Close-only here, Not available, Accept the terms | the gate logic | unit `useTradeGate`/`legalGate.test.ts`, `keyLock.test.ts`; - in UI. A second account or a region cannot be made in a test browser. |
| Unlisted market ("... is not listed on SoDEX") | the message | unit `listed.test.ts`; - in UI (every listed market is listed) |
| Spot order | `/spot/trade/orders/batch`, signed by the same key; no leverage or TP/SL | UI+fake `orderFlow` |
| Phone width | the ticket is the carousel's Trade page, named "Order entry" (bug 8); every spec of this file runs at 375x812 too | UI `algoFlow` (phone test), every spec `@phone`; unit `MobileCarousel.test.tsx` |
| **Accepted by SoDEX for real** | that SoDEX accepts the signed order (goJSON bytes, nonce window, builder cap) and that it rests or fills | **live**: a limit that rests (`ticket.limit-cancel`), a market buy that fills with the builder fee (`ticket.market-close`), an entry with TP/SL (`ticket.tpsl`), a leverage change (`ticket.leverage`). A stop order from the ticket has no live scenario. |

## Account tables on what the ticket made (`components/Account.tsx`, `TpSlSheet.tsx`)

| Control | What is checked | Tested in |
|---|---|---|
| Positions: Close (x) | asked first ("SELL market, reduce-only"); "Keep position" sends nothing; then one reduce-only market sell of the whole size; on SoDEX the account is flat and (with TP/SL) no stop is left | UI+fake `accountActions`, `uiSteps`; **live** `ticket.market-close`, `ticket.tpsl` |
| Positions: Edit TP/SL sheet | a TP on the wrong side is refused ("Above the mark."); then two reduce-only stop legs that sell, at the prices typed | UI+fake `accountActions`; unit `tpsl.test.ts` |
| Positions: margin add / remove (isolated) | - | - (needs an isolated position; the fake seeds a cross one) |
| Open orders: Cancel | one signed DELETE naming that order, and a toast; on SoDEX the order is gone, unfilled | UI+fake `accountActions`, `uiSteps`; **live** `ticket.limit-cancel` |
| Open orders: Cancel all | asked first; "Keep them" sends nothing | UI+fake `accountActions` |
| Open orders: Modify | - | - |
| Algos tab | see below | |

## Algo ticket (`components/algo/AlgoTicket.tsx`, `draft.ts`)

| Control / flow | What is checked | Tested in |
|---|---|---|
| Algo menu: all 14 kinds | order, names; each opens its settings with Order / Runs on / Summary | UI `algoTicket` |
| TWAP: Duration (+ unit), Randomize | durationMs, slices one a minute | UI `algoFlow`, unit `draft.test.ts` |
| Chase TWAP | kind twap, label "Chase TWAP", exec hybrid | UI `algoFlow` |
| VWAP: Duration | kind vwap, durationMs | UI `algoFlow` |
| POV: Speed Low / Medium / High | rate above Medium's for High | UI `algoFlow` |
| Iceberg: Price, Visible | displayQty, pegged price null; no Visible is refused | UI `algoFlow` |
| Chase: Max chase | maxChaseBps | UI `algoFlow` |
| Scale: From, To, Orders, Size curve | from, to, orders, distribution | UI `algoFlow` |
| DCA: Each buy, First at, Step, Buys | kind scale, label DCA, orders | UI `algoFlow`, unit `draft.test.ts`, `dcaCurveMath.test.ts` |
| Swarm: Clips, Randomize sizes | clips | UI `algoFlow` |
| Conditional: condition, market, price, Then | conditions[0], then.type | UI `algoFlow`, unit `draft.test.ts` |
| Trailing stop: Trail, Start at | reduce-only forced, trailPct, source mark | UI `algoFlow` |
| Fill fast: Max slippage | kind sweep, slippageBps | UI `algoFlow` |
| Bracket: Entry, Take-profit, Stop-loss | entry market, exits as fractions; a real one from the ticket's slide puts both exits on SoDEX after its entry | UI `algoFlow`, `uiSteps`; **live** `algo.ui-cancel-exits` |
| Basket: legs, side, USD, Each market | two legs (this market and ETH, opposite), each at the default $200. The old $100 default could not start (bug 4). | UI `algoFlow`, unit `draft.test.ts` |
| Direction Short | side sell | UI `algoFlow` |
| Advanced window: every kind's sections, Reset to defaults, Done | sections per kind; Reset hidden at phone width | UI `algoTicket`, `algoFlow`; unit `draft.test.ts` (advancedChanges / resetAdvanced) |
| Advanced: Slicing, Price & execution, Start & limits fields (urgency, bounds, max spread, start later / at a price, exec style, jitter) | engine parse of the drafts | unit `draft.test.ts`, `audit-algo2.test.ts`; UI not field by field |
| Runs on: ValueDesk (default), This browser, Self-hosted; Practice run | default; the button names an executor that is not set up; practice in this browser needs no wallet | UI `algoTicket` |
| Exits switch, Take-profit / Stop-loss | the fields open and close | UI `algoTicket` |
| Preview: words, pictures, Every order | every kind draws one without an error | UI `algoFlow`; unit `AlgoStory.test.tsx` |
| Summary and slide to start | a slide short of the end starts nothing; End starts it; "Started (paper). Follow it in the Algos tab." | UI `algoTicket`, `algoFlow` |
| Refusal: no amount | the button is off, titled "Enter an amount." | UI `algoFlow` |
| Refusal: a field out of range | in the field's own units ("Duration must be between 1 min and 30 d."). It was in ms and fractions before (bug 3). | UI `algoFlow`, unit `errorWords.test.ts` |
| Refusal: real run with real algos off | the Summary says why, the slide is off, "Turn on Practice run" works | UI `algoFlow` |
| Refusal: slices under SoDEX's $10 minimum, position limit, OI cap | the messages | unit `draft.test.ts` |
| Real (non-practice) start in this browser, or on an executor | - | **live** (browser target and hosted/self targets: the `twap.*`, `vwap`, `pov`, `iceberg`, `chase`, `scale`, `dca`, `swarm`, `conditional`, `trailing`, `bracket`, `basket`, `sweep` scenarios) |

## Algos table (`components/algo/AlgoTable.tsx`, `RunningWindow.tsx`)

| Control | What is checked | Tested in |
|---|---|---|
| All / Running / Ended tabs and counts | counts move with starts and cancels | UI `algoFlow` |
| Pause, Resume | the engine's status | UI `algoFlow` |
| Size (form: New size, Save, Close) | the current size is not a change ("That is the size now."); Save changes the spec's quantity, toast "Size changed." | UI `algoFlow` |
| Row details, Copy Algo ID | the full id on the clipboard, toast "Algo ID copied" | UI `algoFlow` |
| Open: the window (Live / Orders / Log, Practice badge, Close) | it opens and closes | UI `algoFlow` |
| Cancel; Cancel all | the run ends; Cancel all ends every run and leaves | UI `algoFlow` |
| Cancel exits (an ended algo whose exits still guard) | while a bracket runs after its entry the row offers Cancel: it ends, its exits stay ("Exits live"); then Cancel exits pulls them, and the row offers nothing more; on SoDEX both stops go, the position stays | UI `uiSteps` (practice); **live** `algo.ui-cancel-exits` (and `twap.exits` through the bridge) |
| Child order IDs, Copy details (IDs shown) | - | unit (`accountTables` ids helpers); - in UI |
| Executor rows (ValueDesk 24/7, self-hosted) and their signatures | - | **live** (hosted/self targets) |

## Copy window and setup (`components/copy/CopyModal.tsx`, `copy/CopySetupSheet.tsx`)

| Control / flow | What is checked | Tested in |
|---|---|---|
| Open from a trader card (Copy / Counter) | the window and its steps | UI `copySetup`, `copyFlow` |
| Open from a trader's link (`/copy?address=&venue=`, Scan's Copy) | the window for that trader, and the copy it starts follows that address | UI+fake `uiSteps`; **live** `copy.ui-close`, `copy.ui-confirm` |
| Direction Copy / Counter-trade | the title, the note, "Start paper counter-trade" | UI `copyFlow` |
| Sizing Mirror / % of their size / $ per trade | each mode's field and hint; fixedRatio 25 % -> ratio 0.25 | UI `copyFlow`, unit `setup.test.ts` |
| Max leverage, Max position, Slippage cap | in the copy's settings; validation words | UI `copyFlow`, unit `setup.test.ts` |
| Only new / Also existing, Paper copy | copyExisting, paper | UI `copySetup`, `copyFlow` |
| Risk controls: Stop loss, Take profit, Drawdown stop, Only copy, Never copy, Isolated margin, Ask before each trade | each in the settings. Ask-each-trade is offered only in this browser. A coin on both lists is refused. The engine's limits are in percent (bug 5). | UI `copyFlow`, unit `setup.test.ts` |
| Replay (7D / 30D), worked example | - in UI beyond showing | unit `setup.test.ts`, `copyScore.test.ts`, sim tests |
| Next / step 2 disabled with the first error | the title and footer text | UI `copyFlow` |
| Run places: ValueDesk executor (default), This browser, Self-hosted, and their steps | the steps per place; paper drops fee and key | UI `copySetup` |
| Sign in to the executor | one `session` signature; a rejection changes nothing | UI `copySetup` |
| Copy terms: Review, four statements, Sign and accept | ValueDesk's terms, then the copy terms: one signature each | UI `copySetup` |
| Copy fee Approve, copy key Approve (no SoDEX account) | "deposit first", nothing asked of the wallet | UI `copySetup` |
| Copy fee and key with a funded wallet | the exact typed data, rejected in the wallet | UI `copySetup --live` |
| Trade with (amount), 25 / 50 / 75 % / Max chips | allocationUsd. Under the minimum, the footer says why and the box is marked (bug 6). Chips need an equity. | UI `copyFlow`; chips - |
| Self-hosted: Copier address, Find, Pairing code, Pair; "I made an API key myself" (Key name, Private key, Use this key); Revoke | - | **live** (`setup.key-import`, self target); - in UI (needs a running copier) |
| Start paper copy (this browser) | nothing signed; the settings the copy runs with, field by field; toasts | UI `copySetup`, `copyFlow` |
| Start a live copy in this browser from the window | the copy fee and copy key approved in the window (one signature each, registered), Start copying; the rules typed are the copy's; the leader's trade is copied (an IOC signed by the copy key) | UI+fake `uiSteps`; **live** `copy.ui-close`, `copy.ui-confirm` |
| Start a live copy on an executor, its `subscribe` signature | - | **live** (`copy.*` scenarios, through the bridge) |
| Region blocks, EEA 2x, unknown location | the policy | unit (`copy-engine` policy tests, `legal/*.test.ts`); - in UI (the test browser's country is the edge's) |

## Copy management (`components/copy/CopiesDialog.tsx`, `panels.tsx`, Portfolio's My copies card)

| Control | What is checked | Tested in |
|---|---|---|
| My copies card: counts, "N paper copies running as well.", Manage copies, Find traders to copy | the card; Manage copies opens the table (bug 7) | UI `copyFlow` |
| Row: Pause, Resume | the copier's status and the row's word | UI `copyFlow` |
| Row: Activity, its tab, Export CSV | the tab and the button | UI `copyFlow` |
| Row: Stop | asked first; "Keep copying" changes nothing; then stopped, with no Pause left | UI `copyFlow` |
| Stop all, "Also close every copied position" | asked first; "Every copy is stopped." | UI `copyFlow` |
| Row: Close (stop and close positions) | offered while the copy holds a position; asked first ("Stop and close positions"); the copy stops and sends one reduce-only sell; flat | UI+fake `uiSteps` (a fake leader's trade); **live** `copy.ui-close` (and `copy.stop-close` through the bridge) |
| Changing a running copy's rules (`updateCopy`) | - | no UI exists for it (the bridge's `copier.update` only); **live** (`copy.size-change`) |
| "Copy this trade?" prompt (Skip / Copy it) | the prompt names the leader's move; Copy it sends the copy's order, Skip sends nothing (declined in the activity); a close answered Copy it is reduce-only | UI+fake `uiSteps` (a fake leader's trades); **live** `copy.ui-confirm` (clicked), `copym.confirm` (through the bridge) |

## The bell (`components/Notices.tsx`)

| Control | What is checked | Tested in |
|---|---|---|
| Unread mark, opening reads | | UI `notices` |
| View > Grade, View > About, both, Reset, kept across a reload | | UI `notices` |
| An algo notice from this browser's engine | a practice Fill fast's "... done (paper)" in the bell | UI `algoFlow` |
| Copy notices (halted, paused, stopped, not copied, liquidated...) | the titles and grades | unit (`copy-engine` notices tests); **live**. A paper copy raises them only on leader events. |
| Sign in with wallet (inbox) | - | - (a `personal_sign` the test wallet refuses by policy) |

## Needs real money (the parent session's live browser target and the live suite)

Closed by the browser target's UI scenarios (`scenarios/ui.ts`, written 2026-10-30; their logic passes offline in
`uiSteps.spec.ts` and in a dry browser run, the real-money run is pending): the order ticket's limit, market, entry
with TP/SL and leverage change, the open orders' Cancel and the positions' Close (`ticket.*`); exits that stay live
after an algo ends, pulled with "Cancel exits" (`algo.ui-cancel-exits`); "Close" on a copy with positions
(`copy.ui-close`); the copy-each-trade prompt answered by clicking (`copy.ui-confirm`).

Still open:

- **SoDEX accepting what the browser signs**, where no scenario sends it: a **stop order** from the ticket (stop-market,
  stop-limit), Modify on an open order, Cancel all, the positions' TP/SL sheet, a spot order. The fake checks their
  bodies and signers against the same digest; only SoDEX can show the gateway agrees (goJSON bytes, nonce window,
  builder fee caps, key permissions).
- **Fills and positions:**
  - positions and liquidation estimates against SoDEX's own numbers;
  - copy notices raised by leader events.
- **The fee and key steps with a SoDEX account:**
  - registered for real, not rejected;
  - an executor's `create-key` / `subscribe` signatures;
  - self-hosted pairing and key import.
- **Real algos:** real (non-practice) algos in this browser for a wallet in `VITE_LIVE_ALGOS_WALLETS`, and on the
  executors.

## Bugs found and fixed with this pass

1. **Order value "$0,00".** The ticket's Order value read "$0,00" for every order under $10,000 in the default number
   format.
   - Cause: `fmtExactQuote` patched "0.00" inside the "0,00" that format writes.
   - Fixed in `format.ts`; unit `numStyle.test.ts`, UI `orderFlow`.
2. **A typed price was replaced.** A price typed right after a market or Futures/Spot switch was replaced by the book's
   seed a moment later, so the order would have gone at a price the user never typed.
   - Fixed in `priceSeed.ts` and `App.tsx`; the tick snap does not count as the user's choice.
   - Tests: unit `priceSeed.test.ts`, UI `orderFlow` (spot).
3. **Algo errors in engine units.** Algo field errors used the engine's units: "Duration must be between 60000 and
   2592000000." under a TWAP typed in minutes, fractions under % fields.
   - Fixed in `components/algo/errorWords.ts`; unit `errorWords.test.ts`, UI `algoFlow`.
4. **The default Basket could not start.** Its $100 legs in 10 randomised clips put clips under SoDEX's $10 minimum.
   - Legs are now $200 by default; unit `draft.test.ts`, UI `algoFlow`.
5. **Copy errors as fractions.** The copy window stated the engine's limits as fractions: a 0,5 % stop loss read "Stop
   loss must be between 0.01 and 1.".
   - Fixed in `setup.ts copyErrorInWords`; unit `setup.test.ts`, UI `copyFlow`.
6. **A false "Ready to start."** Step 2 of the copy window said "Ready to start." over a disabled Start when the amount
   was under the minimum, and the box was not marked.
   - Fixed in `CopyModal.tsx`; UI `copyFlow`.
7. **A running copy could not be managed.** Nothing on the site could pause, stop or close a running copy. The copies
   table was mounted nowhere since the Copy page became the trader grid, and Portfolio's "Manage copies" led back to
   that grid.
   - Fixed in `CopiesDialog.tsx` and `MyCopies.tsx`; UI `copyFlow`.

Found by running every UI spec at a phone's 375x812 (touch, mobile user agent; `run.ts --viewport phone`, 2026-10-30):

8. **The ticket had no name on a phone.** At phone width the trade page is a carousel (Chart / Order Book / Trade)
   inside the "Order book and trades" panel; its tabs controlled nothing and its pages were unnamed, so the order
   ticket - "Order entry" on a wide screen - could not be found by name with a screen reader.
   - Fixed in `dashboard/MobileCarousel.tsx` (tabs with `aria-controls`, each page a named `tabpanel`) and
     `registry.tsx` (the Trade page is "Order entry"); unit `MobileCarousel.test.tsx`, every ticket spec `@phone`.
9. **The notifications list ran off the screen on a phone.** The bell sits mid-bar there (no rail); its list, hung
   from the bell's right edge, lay about 100px off the left of the screen, the titles cut.
   - Fixed in `styles.css` (under 761px the list spans the screen under the bar); UI `notices` (the list lies within
     the screen) `@phone`.
10. **Toasts covered a phone's header and took its taps.** Without a rail the toast stack sat 56px down, over the
    second and third rows of a phone's three-row bar: the bell, the wallet button and the page links. The indexing
    card that a wallet connection starts stays for minutes, so "Portfolio" could not be tapped.
    - Fixed in `styles.css` (under 761px the stack starts under the bar's real height, `--navbar-live`); UI `notices`
      ("toasts never lie over the bar": a page link takes a tap) `@phone`, and `copyFlow`'s Manage copies `@phone`.

## Seen, not changed (the owner's call)

- **No Futures / Spot switch on a phone.** The bar offers it only with the rail; on a phone a spot market is reached
  through the market search (`orderFlow`'s spot test does that `@phone`).
- **Cancelling a running bracket keeps its exits.** The Algos table's Cancel on a bracket whose entry filled ends it
  and leaves its take-profit and stop-loss on SoDEX ("Exits live"); a second click, Cancel exits, pulls them. By
  design (the engine keeps what protects a filled position), and said in its log, but two clicks for "cancel this
  bracket". `algo.ui-cancel-exits` checks both steps on SoDEX.
- **The ticket's leverage is not read from SoDEX.** The popover starts at the market's initial leverage, not the
  leverage SoDEX holds for the account; the margin and liquidation read-outs use the ticket's figure until the
  popover sends one. `ticket.leverage` sets and reads back SoDEX's.

- **Unreachable code.**
  - `copy/CopySetupSheet.tsx`'s sheet (`CopySetupSheet`) never opens: `useCopy.startCopy` is not called. Its steps
    live on in the copy window.
  - `components/copy/Deck.tsx` is imported by nothing.
- **A practice trailing stop starts with no position to protect.** The paper book has none. A live one is checked
  against the position by the engine.
- **No confirmation for the Algos table's Cancel and Cancel all.** The copies table and the open-orders table ask
  first.
