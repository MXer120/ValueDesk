# Testing Valuescan before launch

Status: 2026-10-02. One file runs everything that can be tested automatically and walks you through the
rest:

```
RUN-LIVE-TESTS.cmd          (in the repository folder - double-click it, or run it in a terminal)
```

It tells you what to do at every step ("Step 3 of 9 - ..."), waits where it needs you, and ends with one
summary on the screen and in two files.

## 1. Before you start

- Node.js 22 or newer, and `npm install` done once in the repository folder.
- The dev servers running in another terminal window: `npm run dev` (web + API on
  `http://127.0.0.1:5180`). The guide never starts, stops or restarts them; if they are not running it says
  so and waits. Stage A alone does not need them.
- For the live money run (stage D): a **brand-new wallet** and about 25 USDC plus a little ETH for gas on
  Arbitrum One. Never use a wallet that holds other funds. The guide shows the exact amounts before it asks
  for anything.
- For the builder tests (stage C): your builder account - an activated SoDEX account with at least 100 vUSDC
  in Spot and 100 vUSDC in Perps. The guide only reads it (its wallet address or account ID is all it asks
  for); it never creates or funds one.

## 2. Starting it

| Command | What it does |
|---|---|
| `RUN-LIVE-TESTS.cmd` | the full guided run: stages A, B, C, D, then the summary |
| `RUN-LIVE-TESTS.cmd --stages A,B` | only these stages (any of A, B, C, D) |
| `RUN-LIVE-TESTS.cmd --stages A,B --yes` | the same without questions: every question that does not involve money gets its default |
| `RUN-LIVE-TESTS.cmd --stages D --plan-only` | stage D stops after the read-only plan - nothing is signed or sent |
| `RUN-LIVE-TESTS.cmd --stages D --plan-only --throwaway-key` | the same without asking for a key: the runner plans with a random key it makes up in memory |
| `RUN-LIVE-TESTS.cmd --stages A --suites server` | stage A: only the suites whose id contains a word (`web-unit`, `server`, `e2e`, ...) |
| `RUN-LIVE-TESTS.cmd --stages D --only withdraw-external,cleanup` | stage D: only these runner steps (a manual resume) |
| `RUN-LIVE-TESTS.cmd --help` | every option |

More options: `--profile <name>` (stage D: the runner profile instead of choosing it), `--no-smoke` / `--smoke`
(stage B: never run / run without asking the production smoke test), `--builder <address or id>`,
`--fee-perps <n>`, `--fee-spot <n>`, `--no-revoke`, `--no-tiers` (stage C without questions), `--no-wait`,
`--wait-minutes <n>`, `--backend <origin>`, `--site-origin <origin>`, `--report-dir <dir>`, `--config <file>`
(another run config than `apps/web/e2e/live/config.json`, for instance to try stage C without touching the real
one; keep such a file out of git yourself), `--no-pause`.

`--yes` never answers for you where it matters: the key, "is that the wallet you mean", the word YES and the
typed wallet address are always asked, and questions whose safe answer is "no" (adding lines to
`.env.local`, going on with a wallet that already has a SoDEX account, entering a receiver address) get
that "no".

Exit code: 0 nothing failed, 1 something failed, 2 the arguments were refused, 130 stopped with Ctrl+C.

## 3. The stages

### Step 1 - check this computer

Node version, installed packages, that reports and the run config are ignored by git, and - when a selected
stage needs it - that the dev server answers. Nothing is changed.

### Stage A - offline test suites (no network, no key)

Every suite is found from the files, not from a list, so a test file added later is run:

| Suite | What |
|---|---|
| web typecheck | `tsc --noEmit` in `apps/web` |
| web unit tests | every `apps/web/src/**/*.test.ts(x)` (node:test through tsx - not vitest) |
| web tools tests | `apps/web/tools/*.test.mjs` |
| live runner typecheck | `tsc --noEmit -p e2e/live` |
| offline e2e (live runner) | `apps/web/e2e/live/*.test.ts` - provider, safety, and a whole simulated live run |
| test guide typecheck / self-tests | this guide's own code and tests (`apps/web/e2e/guide`) |
| server typecheck / tests | `apps/server`, `apps/server/test/*.test.ts` |
| per package: typecheck, tests | every folder under `packages/` (sodex-core, copy-contract, ...) |
| copy-contract ABI + vectors | the committed ABI and test vectors equal the contract build (skipped without `contracts/out`) |
| deploy script tests | every `deploy/**/*.test.mjs` |
| deploy templates | `python deploy/aws/validate_offline.py` (skipped without Python + PyYAML) |
| contract storage-layout guard | `contracts/tools/storage-layout.mjs selftest` and `check` |
| contracts (forge test) | `forge test` in `contracts/` - **skipped when Foundry is not installed** |

Each suite shows one live line (name, running counts, seconds) and ends PASS / FAIL / SKIPPED. Failed tests
are named under the suite; the full output is in the log folder (`A-<suite>.log`).

### Stage B - read-only live checks (no key, nothing signed)

Every request goes through one policy first (`apps/web/e2e/guide/readonly.ts`): only the hosts the app
itself talks to and the dev server; only GET / HEAD / OPTIONS, plus the two kinds of POST that are reads
(Hyperliquid's `/info` queries, JSON-RPC `eth_chainId`); never ports 5173 / 8787; and **never SoDEX's
`/accounts/*/trades` or `/orders/history`** - nor a route of our own API that would make the server read
them. Those two share a limit of about 4 requests a minute per address, and a block lasts a minute.

1. **Exchange hosts answer and let the browser call them**: SoDEX gateway (REST), the gateway's preflight for
   signed orders (an OPTIONS request - it asks permission and sends nothing), SoDEX data host, sodex.com's
   API, Hyperliquid, Lighter, Arcus, the six public RPCs, the ValueChain explorer - each with an `Origin`
   header of a site that is not localhost - and that the app's own Content-Security-Policy lists every one
   of them.
2. **SoDEX market data on mainnet**: market lists not empty, best bid below best ask (perps and spot), mark
   price present and near the book, one-minute candles continuous and current, and on both WebSockets an
   order-book snapshot followed by a trade or ticker push within the time limit.
3. **Our own API** through the dev server: `/api/health`; every route of the hosted-mode allow-list
   (`apps/server/src/hosted.ts`, read from the source so a new route is picked up) answers 200 with a sane
   shape - a board with rows for every venue, cohorts, map, screener, whales, positioning, the deep-link
   lookup, maintenance, announcements; a bad request is answered 400; compression (brotli, gzip, none);
   ETag and 304; and the indexer's status: every stream up, no failing lane, boards rebuilt recently.
4. **The production smoke test**, if `deploy/smoke/smoke.mjs` is there and you say yes: it builds the web app
   for production, serves it with the production headers and walks every page in a hidden Chrome, in the mode
   in which nothing leaves the computer (`--api=spawn --no-index --server-egress=deny --offline`).

A check that passes with something to look at is a WARN (SoDEX lists a maintenance notice, one stream still
subscribing after a restart); it does not fail the stage.

### Stage C - builder account and fee tiers

A builder account is the SoDEX account that receives the Valuescan fee: any activated account that holds at
least 100 vUSDC in Spot **and** 100 vUSDC in Perps. The money is parked, not spent. Its account ID is the
builder ID. It is **your own, existing account**: the guide and the live run only read it - nothing here
creates, funds or moves money on a builder account. Two choices:

1. *Test the builder fee with my builder account*: type its wallet address or account ID (an ID is looked
   up through our own API). It is checked read-only (`apps/web/tools/check-builder.mjs`: three public reads).
   The guide prints the ID and both balances. If it is not eligible it says exactly what is missing and
   exactly what to move - a transfer between "SoDEX Spot" and "SoDEX Futures" where one side can spare it, a
   deposit only for what neither can - and **stops**; do it in the app with the builder wallet, then run
   `RUN-LIVE-TESTS.cmd --stages C` again.
2. *Skip the builder tests.*

Then, unless `--no-tiers`:

- **Fee tiers** (`docs/BUILDER-TIERS.md`): `npx tsx tools/builderTiers.ts init --builder-id <n> --test-tiers`
  in `apps/server` writes the tier list and the terms-signing key into the server's data folder if they are
  not there, `status` confirms them, and the guide then asks the **running** server for signed terms and
  verifies the signature with the public key the tool printed - the check the app makes before it lowers a
  fee. The running server picks the files up by itself; nothing is restarted. If the tool is not in the
  checkout yet the guide says so and tests the builder fee without tiers.
- The fee of the run is the first tier (2 bp on perps with the test tiers); without tiers you are asked
  (default perps 50 = 0.05 %, spot 100 = 0.10 %; caps 200 / 2000, in tenths of a basis point).
- Whether the approval is revoked at the end of the run (default yes).

The `builder` section is written into the run config (`apps/web/e2e/live/config.json`). The lines the web app
needs for a test by hand are printed:

```
VITE_BUILDER_ID=...
VITE_BUILDER_FEE_PERPS=...
VITE_BUILDER_FEE_SPOT=...
VITE_BUILDER_MAX_FEE=...
VITE_BUILDER_TERMS_KEYS=...     (only with fee tiers)
```

There is no `VITE_BUILDER_REQUIRED` line on purpose: a build that names a builder requires the approval (only
`VITE_BUILDER_REQUIRED=0` makes it optional, for a test build). The guide offers to add the missing lines to
`apps/web/.env.local`. It never changes a line that is already there, never does it under `--yes`, and says
that saving that file makes the dev server reload. The live run itself does not need them.

The terms check is the app's own rule set: signature under the printed public key (the guide's verifier also
reproduces the fixed vector of `docs/BUILDER-TIERS.md` section 3), builder, chain, address, nonce echoed,
fees not above the default, a positive ttl, `Cache-Control: no-store`. What the app tolerates but a correct
server would not send (a ttl above 15 minutes, a `keyId` that names another key, an `issued` far from this
computer's clock) is a WARN with the reason; an unsigned answer, a missing route or `ok: false` is a FAIL.

### Stage D - the live money run

The live runner (`apps/web/e2e/live`, see its README) drives the app's own trading and funds code with a
real wallet on SoDEX mainnet. Its safety model is unchanged; the guide adds your decisions in front of it.

1. **Choose what the run tests.** When the runner has profiles, each is shown with what it needs - found by a
   read-only plan with a throwaway key - before you choose: `core` (one chain, every order type, the builder
   fee and its change), `evm-tour` (every EVM chain, out and back), `all-chains` (also chains this computer
   cannot sign on: withdrawals to addresses you supply, deposits you send by hand), `builder-rerun` (the
   builder fee test alone, again, on the funded test wallet of an earlier run - after
   `npx tsx tools/builderTiers.ts forget --address <wallet>` in `apps/server`). A profile the runner does not
   have is listed as "not available in this runner version".
2. **Receiver addresses**, if the run can use any (another address of yours on ValueChain, a wallet on a
   chain the runner cannot sign on). Each is optional. They are written to the private run config and checked
   by the runner's next plan.
3. **The test wallet's key**, into a hidden prompt (section 4). Only the address is shown.
4. **The spend cap.** When the plan's estimate is above `maxSpendUsd` (the wider profiles cost more than the
   example's $8), the guide shows the estimate and the runner's suggested cap (the estimate with about 30 %
   room) and writes exactly that into the run config - only on your typed yes; Enter and `--yes` leave it.
5. **Funding.** The plan says how much of what, on which chain, to which address. The guide re-runs the
   read-only plan every 20 seconds and goes on by itself when the funds are there (type `q` to stop waiting).
6. **The run.** One complete plan, the steps with their estimated cost and the spend cap, a reminder to close
   every other Valuescan and sodex.com tab (the run and the server's fee check need SoDEX's history reads;
   another tab can use them up and get this address blocked for a minute), then two confirmations: the word
   YES, and the wallet address typed out. Only then is `acknowledgeRealFunds` written into the config - for
   this run; it is switched off again when the run ends. The runner's output is shown live.

With fee tiers on, the fee-change test works **once per wallet**: the run places two "cheating" orders on
purpose, and afterwards the server keeps that wallet on the default fee for 30 days. For another run use a
new wallet, or `npx tsx tools/builderTiers.ts forget --address <wallet>` in `apps/server` and the
`builder-rerun` profile.

**If the run stops**, the guide prints where every coin is (as the runner read it), what is in flight, and
how to go on: start `RUN-LIVE-TESTS.cmd` again, enter the same key, and choose *Resume the earlier run* - or
the bare command it prints (`--only <the steps that are left>`). Each resumed step moves its amount again.

### Step E - the summary

On the screen, as `apps/web/e2e/live/reports/<time>-all.summary.md` and as `<time>-all.json`. It leads with
what was asked for:

1. **Builder fee**: per check PASS / FAIL / FINDING / not run for (a) the default fee on the first orders,
   (b) volume above 10 USDC verified by the server from SoDEX's records, (c) the fee changing to 1.5 bp on
   the next order, (d) the two cheating attempts not being credited, (e) whether a modified and a replaced
   order keep the builder, (f) the builder account's income matching the fills, (g) nothing being sent once
   the approval is lowered or revoked - each with the runner's evidence. *Findings* (how SoDEX behaved where
   the run only observes) have a list of their own right under it. Nothing here is guessed: a check the
   runner did not report reads "not run".
2. **Every chain**: deposit and withdrawal, tested / not run / not testable, and why.
3. **Every order type.**
4. **What it cost**: estimated, spent, sent to your other addresses, the cap.
5. Every stage and every step: result, time, cost. Then the runner's fee table if it has one, where every
   coin is, the settings for the app, and what to do next.

## 4. The key

- Asked for by the guide, hidden: nothing is echoed but one `*` per character. Paste with a right-click or
  Ctrl+V. A key without `0x` (as MetaMask exports it) is accepted.
- It is refused as a command-line argument and in the config file.
- It lives in the memory of the guide's process and is handed to the live runner only, as `VS_E2E_KEY` in
  that one child process's environment. It is never in this window's own environment, never an argument,
  never on disk. If the window already has `VS_E2E_KEY` set, the launcher and the guide drop it without
  using it.
- Every line the guide prints or logs passes a filter that knows the key; the summary files are scrubbed
  again of anything the size of a key that is not a transaction hash from a known hash field.
- A live run can only be started by a person at a console: with input from a file or a pipe the guide
  stops before the key.
- The prompt was tried on a real Windows console (a pseudo console, as Windows Terminal uses), started
  through `RUN-LIVE-TESTS.cmd` from cmd.exe and from Windows PowerShell 5.1, with a throwaway key and
  `--plan-only`: one `*` per character, Backspace, Ctrl+V, a paste that ends in a line break (it does not
  answer the next question), Ctrl+C; the key was in none of the rendered output and none of the files the
  run wrote.

## 5. Files

| | |
|---|---|
| `RUN-LIVE-TESTS.cmd` | the launcher |
| `apps/web/e2e/guide/` | the guide (`guide.ts` is the entry; its tests are the `*.test.ts` next to it) |
| `apps/web/e2e/live/config.json` | the run config the guide writes (ignored by git; never holds a key) |
| `apps/web/e2e/live/reports/` | reports (ignored by git): the runner's `<time>-plan.json` / `-live.json`, the guide's `<time>-all.summary.md`, `<time>-all.json` and the log folder `<time>-all-logs/` |

## 6. What cannot be automated, and why

| Not covered | Why | What to do instead |
|---|---|---|
| What a real wallet (MetaMask, a phone over WalletConnect) shows and asks | the runner signs with a key-backed wallet; a wallet's own screens cannot be driven from here | the manual list in `docs/BUILDER-CODES.md` section 9: connect, enable trading, read the approval message |
| How the app looks: the fee dialog, the order ticket's fee line, toasts, charts | stage B's smoke test checks that every page renders and what it talks to - not what a person sees | look at the pages after stage D with the settings the summary prints |
| Deposits from chains this computer cannot sign on (Solana, Bitcoin, XRP, ...) | there is no key for those chains here | the `all-chains` profile tells you what to send by hand and then waits for and verifies it |
| Making or funding the builder account | it is your own account; nothing here moves money on it | stage C reads it and says exactly what to move when it is short |
| SoDEX's history rate limit (about 4 a minute) and the block that follows | provoking it blocks this address - trading included - for a minute or more | nothing: the guide and the app stay below it by design |
| Behaviour over time: a trading key expiring after its lifetime, the 30 days after an underpaid order | waiting is not a test | covered by unit tests with a fake clock |
| SoDEX maintenance, a closed route, an exchange being down | cannot be switched on from here | stage B reports the state it finds (a WARN, or "not testable" in the chain table) |
| `forge test` without Foundry | not installed on this computer | install Foundry; stage A then runs it |
| The deployed site: the edge's headers, TLS, that the origin is closed | nothing is deployed when this runs | after a deploy: `node deploy/smoke/smoke.mjs --site=https://...` (`deploy/smoke/README.md`) |
| The licensed TradingView chart library | not in the repository | - |
| Legal and regional rules | not a software test | `docs/research` |

## 7. For developers

Run the guide's own tests: `npx tsx --test e2e/guide/*.test.ts` in `apps/web` (stage A does). Typecheck:
`npx tsc --noEmit -p e2e/guide`.

The guide never imports the live runner or the server: it starts the runner as a child process and reads its
output and reports, and it reads `hosted.ts` and the runner's `config.ts` as text. What it relies on, each
part optional (a missing one degrades to "not available" or "not run", never to a crash):

| From the runner | Used for |
|---|---|
| `run.ts capabilities` printing `{ steps, profiles, flags }`, exit 0 (else the usage text is read) | the step order for resuming, the profile menu |
| `plan` / `live` with `--config`, `--confirm`, `--only`, `--profile`, `--throwaway-key`, `--registry-only`, `--report-dir`; the key in `VS_E2E_KEY`; exit codes 0 / 1 / 2 / 130; a last line `report   <file>` | everything in stage D |
| report: `wallet`, `exitCode`, `selectedSteps`, `config.maxSpendUsd`, `plan.{problems, warnings, checklist, steps[], routes[], estimatedCostUsd, estimatedSentAwayUsd, suggestedMaxSpendUsd}`; funding problems start with `fund the wallet:`, a cap problem names `above maxSpendUsd` | the plan, the spend cap offer, the funding wait |
| report: `plan.receiversNeeded[] { name, chain?, why?, memo?, set?, problem? }` (else its messages naming `receivers.<name>`) | the receiver questions |
| report: `steps[] { id, title, status, ms, measured.costUsd, estimateUsd, txs[], subSteps[], error, reason }`, `spend`, `whereFunds[]`, `inFlight[]` | the step table, cost, where the funds are |
| report: `checks[] { id, title?, status, detail?, value? }` with status `pass / fail / finding / warn / skipped / not-run` and the ids in `apps/web/e2e/guide/report.ts` (`BUILDER_CHECKS`) | the builder-fee section and the findings |
| report: `chains[] { chain, label?, coin?, deposit: { status, detail? }, withdraw: { status, detail? } }`, `orderTypes[] { id, title?, engine?, status, detail? }` (else built from the route table and the recorded steps) | the chain and order tables |
| `<report>.summary.md` with a heading that names fees, or `feeTable` in the report | the fee table |
| config: `builder { id, feePerps, feeSpot, maxFee or maxFeeRate, required, revokeAtEnd, termsKeys }` - the names are read from the runner's `config.ts` | stage C's builder section |

| From the server | Used for |
|---|---|
| `tools/builderTiers.ts init --builder-id <n> --test-tiers` / `status` printing JSON (`configPath, keyPath, publicKey, keyId, builderId, tiers`, and for status `valid, problems`); never a private key | the fee tiers |
| `GET /api/vs/builder/terms?address&nonce` as in `docs/BUILDER-TIERS.md` section 3 | verifying the signed terms |
| `GET /api/vs/index/status` (`status.{at, streams, sockets, lanes, venues, lastBuildAt, lastError}`) | the indexer check |

To add a check to stage B, add a probe to `ownApi.ts` (our API) or a check to `stageB.ts`; a route added to
the hosted allow-list without a probe shows up as a warning in stage B.

## Copy trading: the live check (owner, before showing it to anyone)

Automated: `packages/copy-engine` (planner, guards, books, policy, signed requests,
the runtime against a fake SoDEX), `apps/executor` (sessions, replay refusal,
pairing, terms and regions, keys, copies, the HTTP gate), `apps/web/src/copy`.
Verified by hand on 2026-10-23 without money: the engine in paper mode followed
six live SoDEX traders for three minutes (two opened and closed; the paper copies
followed), and the site ran all three modes end to end in paper mode with a
throwaway test wallet (terms, sign-in, pairing, start, activity, stop all).

What only a real wallet can show - use a NEW wallet with about 30 USDC on SoDEX
perps, and a leader that trades often:

1. Copy setup -> This browser: accept the terms, approve the copy fee, approve the
   key (7 days). Start a copy with Fixed amount 12 USDC, max leverage 2, stop loss
   on. Keep the tab open until the leader opens and closes once: an order and a fill
   appear in Activity, the SoDEX account shows the position and a stop order, the
   builder fee on the fill is 0.025%.
2. Stop and close. The position closes; the stop order is cancelled.
3. ValueDesk executor: sign in, approve its key (7 days), start the same copy,
   close the tab, come back after the leader traded: the copy traded without you.
   Then Stop all, and Revoke in the key step (one signature on ValueChain).
4. Self-hosted: run `node valuedesk-copier.mjs` (from /copier on the site), pair,
   approve its key, start, check, stop, revoke.
5. Send Claude the activity CSVs of the three copies.
