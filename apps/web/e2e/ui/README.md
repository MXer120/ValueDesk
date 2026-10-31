# UI specs - ValueDesk in Microsoft Edge

Browser end-to-end tests of the web app: the order ticket, TP/SL, the algo ticket, the notifications bell, copy
setup and the stale-build note. They drive the **local dev web** in the **installed Microsoft Edge** with
`playwright-core` (no browser is ever downloaded), select everything by ARIA role and accessible name, and run
as `node:test` specs through tsx like the rest of the repo.

**Paper and practice by default.** The wallet is a throwaway random key with no funds and no SoDEX account;
algos run as practice runs, copies as paper copies. Nothing places a real order. `--live` swaps in the funded
wallet in `VS_E2E_KEY` for the few tests that need a SoDEX account (see [Live](#live)).

## Run

Start the dev servers first (`.claude/launch.json`: `valuescan-web`, plus `valuescan-server` and
`valuescan-executor` for the copy specs). Then, from `apps/web`:

```powershell
npx tsx e2e/ui/run.ts                    # every spec, headless, throwaway wallet: on a desktop, then on a phone
npx tsx e2e/ui/run.ts --only tpsl,copy   # spec files whose name contains a word
npx tsx e2e/ui/run.ts --viewport phone   # only at a phone's 375x812
npx tsx e2e/ui/run.ts --headed --slow 250
npx tsx e2e/ui/run.ts --list
```

| Flag | Meaning |
|---|---|
| `--only a,b` | only spec files whose name contains one of the words |
| `--headed`, `--slow <ms>` | show the browser; wait this long per action |
| `--web <origin>` | the dev web (else `VS_E2E_WEB`, else the first of 127.0.0.1:5180-5183 that serves ValueDesk from Vite) |
| `--jobs <n>` | spec files at a time, each in its own Edge (default 2, at most 4) |
| `--viewport <v>` | `desktop` (1600x1000), `phone` (375x812, touch, a phone's user agent: mobile emulation in the same Edge) or `both` (default: desktop, then phone) |
| `--live --confirm <address>` | the funded wallet in `VS_E2E_KEY`; `--confirm` must be its address |

Exit codes: `0` passed, `1` a test failed, `2` refused to start (no dev web, no Edge, `--live` without its key
or confirmation). A failed test leaves `e2e/ui/.out/<spec>--<test>.png` and `.log` (the page's URL, console
errors and uncaught errors). One spec file alone: `node --import tsx --test e2e/ui/tpsl.spec.ts`.

Type-check: `npx tsc --noEmit -p e2e/ui`.

**Bandwidth.** Each spec file ends with a line `ui-e2e: <spec>: N MB from the internet (host N MB, ...)`: what
its pages received from hosts other than this machine (responses and WebSocket frames, counted over CDP; Web
Workers are not counted). Measured 2026-10-29, a full run: about 16 MB in 83 s (~1.6 Mbit/s on average) - 13.7 MB
of it `copySetup` (the copy window's Hyperliquid fill replay, 1-2 MB each time it opens), the other specs
0.2-0.8 MB each (SoDEX market data). The dev web itself is local and does not count. Measured 2026-10-30, both
screens (the default since the phone pass), 11 spec files, `--jobs 3`: about 77 MB in 7.5 min (~1.4 Mbit/s), most of
it `copySetup` and `copyFlow` (12-15 MB each per screen, the same replay); `--viewport desktop` halves it.

**Not in CI.** `deploy/ci/run-tests.mjs` never runs these (they need a browser and a dev server) and refuses
`apps/web/e2e/ui/` by name, as it does `e2e/live/native`.

### Edge

`channel: 'msedge'` first. Where Edge is installed in the newer EdgeCore layout
(`C:\Program Files (x86)\Microsoft\EdgeCore\<version>\msedge.exe`, no `Edge\Application\msedge.exe`), that
channel is not found and the newest EdgeCore build is launched by path. `VS_E2E_EDGE=<path to msedge.exe>`
names one explicitly.

### The dev server under the specs

Each test gets a fresh browser context: empty storage, `en-US`, UTC, 1600x1000, and the app's default number
format pinned (`vs.numberFormat = dot-comma`: "1.234,5"; the helpers `num()` and `dec()` read and type it). The
welcome gate is accepted with "Only necessary" and the dev build's Developer dock is folded. **Vite's HMR socket
is answered by the test and never forwarded**: other sessions editing the shared tree must not hot-swap modules
or remount the app under a running test (seen: a remount mid-test threw `removeChild`). A test sees the code as
it was when its page loaded.

**On a phone** (`--viewport phone`, `harness.ts PHONE`): the context is 375x812 with `isMobile`, touch and an Android
Edge user agent, and the specs' output and failure files carry `@phone`. The helpers find each control where a phone
shows it: the order ticket is the trade page carousel's Trade page (`ticket().show()` taps that tab; the page is the
tabpanel "Order entry"), and Connect wallet is the header's button (there is no Tools rail). The specs themselves are
the same on both screens.

## The wallet (`wallet.ts`)

An EIP-1193 provider injected before the app's first script (`page.addInitScript`): `window.ethereum` with
`isMetaMask`, also announced over EIP-6963 as `io.metamask` - so the Connect dialog lists "MetaMask Installed" and
connects it over the extension route (`walletconnect.ts connectVia`). Its `request()` crosses to Node
(`page.exposeFunction`), where `e2e/live/provider.ts createKeyProvider` answers it. **The key never enters the
page.**

The policy signs exactly what the setup flows sign; everything else (any transaction, `personal_sign`, any
other typed data) is refused with 4100 and recorded:

| Kind | Typed data |
|---|---|
| `trading-key` | `UserSignedAddAPIKeyAction` (Enable trading, the copy key) |
| `builder` | `ApproveBuilderFeeAction` (the builder-fee approval) |
| `site-terms` | `CopyRequest` `accept-site-terms` (ValueDesk's terms) |
| `copy-terms` | `CopyRequest` `accept-terms` (the copy terms) |
| `copy-sign-in` | `CopyRequest` `session` (signing in to an executor) |
| `copy-key` | `CopyRequest` `create-key` (an executor makes the copy key it then registers: `copy/live.ts approveKey`) |

`wallet.log` / `wallet.since(mark)` say what was asked and how it was answered; a kind in `wallet.reject` is
answered as a user's Reject (4001), so a flow can be walked to the wallet without anything being signed.

## The fake SoDEX account (`sodexFake.ts`, `trade.ts`)

For the specs that need trading enabled without funds: `fakeSodexAccount(ctx, address)` routes SoDEX's trading
gateway (`mainnet-gw` / `testnet-gw.sodex.dev`) in the browser context. **Every request that is not a GET is answered
there (`route.fulfill`) and never forwarded**; reads about the wallet (account id, state, builder approvals, API keys,
positions, open orders) come from a small in-memory account, all other reads (markets, books) from SoDEX. Each write
is recorded with its headers and decoded body, and `signer(w)` recovers who signed it from the same EIP-712 digest
SoDEX checks. A key registration or builder approval the wallet signed is listed back, as SoDEX would. Options: a
balance, a seeded position and a resting order, `rejectNextOrder(error)`. `enableTrading(env)` connects, presses
Enable trading and answers the terms and the builder-fee dialog; `placeViaReview` presses Place. The wallet is still a
throwaway key SoDEX has never seen, so a write that got past the route would be refused there too.

**Stateful** (`stateful: true`): the account moves with the writes as SoDEX would answer them - a GTC or post-only
limit rests until a cancel, a market or IOC order fills at its own limit price into the position, a stop (or an
entry's attached TP/SL) rests as a stop, a reduce-only fill that leaves a market flat takes its stops along, a
leverage change is kept (`position()`, `resting()`, `leverage()`); SoDEX's replace and modify requests change a resting
order in place; a spot market order moves the spot coins (`spot: { vUSDC: 100 }` to start, `spotBalance()`). Any fake
can start with leverage settings SoDEX already holds (`leverage: [{ symbol, leverage, marginMode }]`). Orders name their market by id: the fake reads
SoDEX's public market list once to name them. **A fake leader** (`leader: { address }`): its account id and positions
are answered, and the gateway's websockets opened in the page are routed through the fake (SoDEX's frames pass both
ways); `leaderTrade(symbol, side, qty, price)` prints the leader's trade on the public `trade` stream as SoDEX does
(buyer and seller account ids), which the browser copier follows; the follower's own fills are printed there too, a
moment after the order is answered, so the copier books them.

## The UI steps (`uiSteps.ts`)

What a person does on a page, one step at a time, by name and with plain JSON in and out: `market.select`,
`ticket.limit`, `ticket.market` (with TP/SL as Gain and Loss in %), `ticket.leverage`, `orders.cancel`,
`positions.close`, `orders.modify`, `orders.cancelAll`, `ticket.stop`, `positions.tpsl` (the TP/SL sheet), `spot.order` (Market type Spot, a spot market), `copy.start` (the copy window from the trader's link), `copy.manage` (Portfolio > Manage copies:
Close or Stop), `copy.answer` (the "Copy this trade?" prompt), `algo.bracket` (the algo ticket's slide) and
`algo.cancelExits` (the Algos table). The live suite's browser target runs them with real money
(`bridgeSession.ts ui()`, `apps/executor/tools/live-test/scenarios/ui.ts`); `uiSteps.spec.ts` runs the same steps
against the stateful fake. Other pages are reached in the tab (history and popstate, as the nav does), so the
runners in it go on.

Coverage of every control against these suites, and what only real money shows: `docs/COVERAGE-UI.md`.

## The test bridge (`window.__vsTest`, `src/testBridge.ts`)

Dev only: `main.tsx` imports it inside `if (import.meta.env.DEV)`, which a production build drops together with
the module (`src/testBridge.test.ts` proves it, in web-unit). Version 2; every answer is plain JSON.

```ts
await page.evaluate(() => window.__vsTest!.algos.start(spec));   // follows the wallet or the paper book, as the ticket's Start does
// about():  the wallet, network, builder and its fees, brake, copy terms, region, whether real algos are on for the wallet
// algos:  role owner follow check start list pause resume cancel cancelAll update events
// copier: role owner key terms acceptTerms(country) makeKey verifyKey start(settings) list update pause resume stop stopAll events confirms answer
```

Version 2 added `about`, `copier.acceptTerms`, `terms`, `update`, `makeKey` and `verifyKey` for the live suite's
browser target (`apps/executor/tools/live-test`, `--target browser`), whose page is `bridgeSession.ts` here: these
specs' Edge, context (`newUiContext`) and wallet, driven by the live runner. Live algos and copies stay behind the
UI's own gates (`liveAlgos.ts`, the copy key): the bridge adds no way around them, and `algoTicket.spec.ts` checks
that a live spec is refused. A key `makeKey` made is kept only once SoDEX lists it under the wallet (the wallet
registered it). Real algos start on a dev server only for the wallets in `VITE_LIVE_ALGOS_WALLETS`
(`apps/web/.env.local`), never in a build for a deployment.

## What each spec covers

| Spec | Covers |
|---|---|
| `orderTicket.spec.ts` | Market / Limit / Stop fields (a stop-limit adds its price and TIF); GTC says nothing, IOC that cannot fill says it would be cancelled, post-only through the touch is refused (buy: "below the best ask", sell: "above the best bid"), IOC through the touch says nothing; the amount converts coin <-> USDC at the order price, and the toggle's name is the unit it switches to; MAX = 100 %, no size without a balance; a throwaway wallet sees "Create account" |
| `tpsl.spec.ts` | Gain/Loss are magnitudes: "Loss 100" puts a long's stop below entry; a short mirrors it; % is return on margin (entry x size / leverage); a typed Gain/Loss is held while entry, size and leverage move, a typed price is not; a wrong-side TP or SL, and a Stop order on the wrong side of the market, raise a notification and no inline line |
| `algoTicket.spec.ts` | all 14 kinds in the menu, each opens its settings (Order, Runs on, Summary); ValueDesk executor is the default run place ("not set up" without a wallet), this browser and self-hosted can be picked; practice in this browser needs no wallet, real asks for one; the exits switch; a practice TWAP started by the Summary's slide (a slide short of the end starts nothing) shows in the Algos tab, and the bridge pauses, resumes and cancels it; the bridge starts the same spec on its own and refuses it live |
| `notices.spec.ts` | the unread mark and reading it; View > Grade (all, warnings + errors, errors), View > About (algos + copies, account, other), both together, "Nothing for this view."; the View is kept across a reload and Reset clears it |
| `copySetup.spec.ts` | the copy window's rules (live until Paper is picked) and run places (ValueDesk executor by default, this browser, self-hosted) with their own steps; the executor sign-in is one `session` signature and a rejection changes nothing; the copy terms take four statements, then ValueDesk's terms and the copy terms, one signature each; without a SoDEX account the fee and key stop at "deposit first" before the wallet is asked anything; a paper copy in this browser needs no fee and no key, signs nothing to start, and the bridge sees, pauses and stops it |
| `orderFlow.spec.ts` | with trading enabled on the fake SoDEX account (below): Enable trading signs ValueDesk's terms, the builder fee and one trading key (both engines); limit, market, stop-market, stop-limit, a TP/SL bracket and a spot order go out as the review shows them - each signed body decoded, its signer the registered key, the builder within the approval; the liquidation acknowledgement, Back to ticket, "don't show again", a rejection inside an accepted batch, leverage and margin-mode changes, MAX and % from a balance, USDC sizing, the exact Order value; refusals that sign nothing |
| `accountActions.spec.ts` | the fake account seeded with a position and a resting order: Close (asked first, one reduce-only market sell), the position TP/SL sheet (wrong side refused, two reduce-only stops), Cancel and Cancel all on open orders |
| `algoFlow.spec.ts` | every kind started as a practice run from its own fields, the spec the engine got checked field by field; refusals (no amount, a field out of range in its own units, an iceberg without a visible size, a real run with real algos off); the Algos table's Pause, Resume, Size, ID chip, Open, Cancel, Cancel all and its tabs; a practice Fill fast to its end and its notice in the bell; every preview; phone width |
| `copyFlow.spec.ts` | every rule of the copy window as the copy runs with it (sizing modes, limits, behaviour, risk controls, coin lists, margin, ask-each-trade, the amount), its refusals in their own units, counter-trade; Portfolio > My copies > Manage copies: Pause, Resume, Activity, Stop (asked first), Stop all |
| `uiSteps.spec.ts` | the live browser target's steps against the stateful fake and a fake leader: a limit 2% under the bid rests and the open orders' Cancel takes it off; a market buy fills and Close sells it reduce-only; an entry with TP/SL rests two reduce-only stops at the prices the ticket shows; the leverage popover and margin mode are sent, kept and set back; a copy from the copy window follows the leader's trade and Manage copies' Close sells reduce-only; "Ask before each trade": Copy it sends, Skip sends nothing; a bracket from the algo ticket, Cancel then Cancel exits in the Algos table; a stop-market and a stop-limit rest as triggers, cancelled; Modify changes a limit's price and size; Cancel all; the TP/SL sheet set, changed, closed; a spot buy and sell back (stateful spot balances); the ticket starting at the leverage the account holds |
| `staleBuild.spec.ts` | a part missing from the build (its module answers 404): one retry, one reload, then the note "A new version of ValueDesk is out" with a Reload button, not the error boundary; a tab running an algo is not reloaded: the note at once, and the "update held" banner names what a reload would stop |

Against the dev web the "ValueDesk executor" is the local one (127.0.0.1:8799 behind Vite's `/api/copy`
proxy): a sign-in or terms signature from a throwaway wallet stays on this machine.

## Live

```powershell
$s = Read-Host 'funded test wallet private key (0x...)' -AsSecureString
$env:VS_E2E_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
npx tsx e2e/ui/run.ts --live --confirm 0xYourWalletAddress
Remove-Item Env:VS_E2E_KEY
```

With `--live` the throwaway-only tests are skipped and these run:

- `orderTicket`: MAX sizes to the funded balance.
- `tpsl`: the review sheet - Enable trading (the one `trading-key` signature, real: it registers a trading key on
  SoDEX), a limit far from the market with exits, the review lists size, entry, value, margin, liquidation, fees
  and the exits, and **Back to ticket**: nothing is signed or sent.
- `copySetup`: the fee and key steps ask the wallet for exactly `ApproveBuilderFeeAction` and
  `UserSignedAddAPIKeyAction`, and **the wallet rejects both**: nothing is registered.

No spec places a real order, live or not (`uiSteps.spec.ts` places them on the fake account). Real orders through
these pages are the live suite's: `apps/executor/tools/live-test`, `--target browser`, `scenarios/ui.ts`.
