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
npx tsx e2e/ui/run.ts                    # every spec, headless, throwaway wallet
npx tsx e2e/ui/run.ts --only tpsl,copy   # spec files whose name contains a word
npx tsx e2e/ui/run.ts --headed --slow 250
npx tsx e2e/ui/run.ts --list
```

| Flag | Meaning |
|---|---|
| `--only a,b` | only spec files whose name contains one of the words |
| `--headed`, `--slow <ms>` | show the browser; wait this long per action |
| `--web <origin>` | the dev web (else `VS_E2E_WEB`, else the first of 127.0.0.1:5180-5183 that serves ValueDesk from Vite) |
| `--jobs <n>` | spec files at a time, each in its own Edge (default 2, at most 4) |
| `--live --confirm <address>` | the funded wallet in `VS_E2E_KEY`; `--confirm` must be its address |

Exit codes: `0` passed, `1` a test failed, `2` refused to start (no dev web, no Edge, `--live` without its key
or confirmation). A failed test leaves `e2e/ui/.out/<spec>--<test>.png` and `.log` (the page's URL, console
errors and uncaught errors). One spec file alone: `node --import tsx --test e2e/ui/tpsl.spec.ts`.

Type-check: `npx tsc --noEmit -p e2e/ui`.

**Bandwidth.** Each spec file ends with a line `ui-e2e: <spec>: N MB from the internet (host N MB, ...)`: what
its pages received from hosts other than this machine (responses and WebSocket frames, counted over CDP; Web
Workers are not counted). Measured 2026-10-29, a full run: about 16 MB in 83 s (~1.6 Mbit/s on average) - 13.7 MB
of it `copySetup` (the copy window's Hyperliquid fill replay, 1-2 MB each time it opens), the other specs
0.2-0.8 MB each (SoDEX market data). The dev web itself is local and does not count.

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

## The test bridge (`window.__vsTest`, `src/testBridge.ts`)

Dev only: `main.tsx` imports it inside `if (import.meta.env.DEV)`, which a production build drops together with
the module (`src/testBridge.test.ts` proves it, in web-unit). Version 1; every answer is plain JSON.

```ts
await page.evaluate(() => window.__vsTest!.algos.start(spec));   // follows the wallet or the paper book, as the ticket's Start does
// algos:  role owner follow check start list pause resume cancel cancelAll update events
// copier: role owner key start(settings) list pause resume stop stopAll events confirms answer
```

It is the seam for a later live-suite "browser target". Live algos and copies stay behind the UI's own gates
(`liveAlgos.ts`, the copy key): the bridge adds no way around them, and `algoTicket.spec.ts` checks that a live
spec is refused.

## What each spec covers

| Spec | Covers |
|---|---|
| `orderTicket.spec.ts` | Market / Limit / Stop fields (a stop-limit adds its price and TIF); GTC says nothing, IOC that cannot fill says it would be cancelled, post-only through the touch is refused (buy: "below the best ask", sell: "above the best bid"), IOC through the touch says nothing; the amount converts coin <-> USDC at the order price, and the toggle's name is the unit it switches to; MAX = 100 %, no size without a balance; a throwaway wallet sees "Create account" |
| `tpsl.spec.ts` | Gain/Loss are magnitudes: "Loss 100" puts a long's stop below entry; a short mirrors it; % is return on margin (entry x size / leverage); a typed Gain/Loss is held while entry, size and leverage move, a typed price is not; a wrong-side TP or SL, and a Stop order on the wrong side of the market, raise a notification and no inline line |
| `algoTicket.spec.ts` | all 14 kinds in the menu, each opens its settings (Order, Runs on, Summary); ValueDesk executor is the default run place ("not set up" without a wallet), this browser and self-hosted can be picked; practice in this browser needs no wallet, real asks for one; the exits switch; a practice TWAP started by the Summary's slide (a slide short of the end starts nothing) shows in the Algos tab, and the bridge pauses, resumes and cancels it; the bridge starts the same spec on its own and refuses it live |
| `notices.spec.ts` | the unread mark and reading it; View > Grade (all, warnings + errors, errors), View > About (algos + copies, account, other), both together, "Nothing for this view."; the View is kept across a reload and Reset clears it |
| `copySetup.spec.ts` | the copy window's rules (live until Paper is picked) and run places (ValueDesk executor by default, this browser, self-hosted) with their own steps; the executor sign-in is one `session` signature and a rejection changes nothing; the copy terms take four statements, then ValueDesk's terms and the copy terms, one signature each; without a SoDEX account the fee and key stop at "deposit first" before the wallet is asked anything; a paper copy in this browser needs no fee and no key, signs nothing to start, and the bridge sees, pauses and stops it |
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

No test places an order, live or not.
