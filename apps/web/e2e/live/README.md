# Live E2E runner - Valuescan money flows on SoDEX mainnet

`run.ts` drives the web app's **own** trading and funds code (`src/trading/*`: `sendUsdcDeposit`,
`enableTrading`, `transferFunds`, `placeOrder`, `changeOrder`, `cancelOrder`, `cancelAll`, `setLeverage`,
`adjustMargin`, `scheduleCancel`, `withdrawFunds`, `disableTrading`, the builder approval and the signed fee
terms ...) from Node, with a real wallet backed by a private key, against SoDEX **mainnet** (ValueChain,
chain id 286623). Every assertion is a **check** with a stable id (`checks.ts`); the report lists each one as
`pass`, `fail`, `finding` (SoDEX or the app did something the owner has to decide on - never a failure),
`skipped` (with why) or `not-run` (with why).

> **`live` mode moves real money.** It deposits, trades and withdraws with the wallet you fund. Run
> `plan` first, fund a **fresh** wallet with only what the plan asks for, and keep `maxSpendUsd` low.
> The owner runs it - normally through the guided launcher (`RUN-LIVE-TESTS.cmd`, `e2e/guide/`).

## Quick start

From `apps/web` (its `tsconfig.json` maps `@sodex-core`), with the dev servers running
(web + API proxy on `http://127.0.0.1:5180`, backend behind it):

```powershell
cd apps/web
copy e2e\live\config.example.json e2e\live\config.json     # then edit it

# The key: ONLY from the environment. This prompt keeps it out of the shell history.
$s = Read-Host 'test wallet private key (0x...)' -AsSecureString
$env:VS_E2E_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))

npx tsx e2e/live/run.ts plan --config e2e/live/config.json                  # read-only
npx tsx e2e/live/run.ts live --config e2e/live/config.json --confirm 0xYourWalletAddress

Remove-Item Env:VS_E2E_KEY
```

bash: `read -rs VS_E2E_KEY && export VS_E2E_KEY`, then the same commands, then `unset VS_E2E_KEY`.

Without a funded wallet you can still see a plan: `npx tsx e2e/live/run.ts plan --throwaway-key`
(a random in-memory key; plan only).

| Flag | Meaning |
|---|---|
| `plan` / `live` | `plan` (default) is read-only; `live` moves funds |
| `capabilities` | prints, as ONE JSON line, the steps, profiles, flags, every check and the coverage table (`coverage.ts`); no key, no network |
| `--config <file>` | the run's config (`config.example.json` documents every field). Required for `live` |
| `--profile <name>` | what the run covers: `core` (today: the config's steps, every order type, the builder fee and its tiers, the key's life, the refusals, the cross-check) |
| `--confirm <address>` | `live`: must equal the address `VS_E2E_KEY` controls |
| `--only a,b` | run only these steps (preflight always runs); `orders` = `orders-spot,orders-perps` |
| `--throwaway-key` | `plan` only: a random in-memory key instead of `VS_E2E_KEY` |
| `--registry-only` | `plan` only: read deposit addresses from the on-chain registry alone - does not ask the backend, which asks SoDEX to *issue* addresses for a wallet that has none |
| `--backend <origin>` | override `config.backend` |
| `--report-dir <dir>` | where the JSON report goes (default `e2e/live/reports/`) |

Exit codes: `0` done and no check failed (plan: a live run would start), `1` a step stopped the run or a
check failed, `2` refused to start (config, key, gates, or plan problems - nothing was signed or sent),
`130` interrupted. The last console line is `report   <file>`.

Add to `.gitignore` (not done by the runner):

```
apps/web/e2e/live/reports/
apps/web/e2e/live/config.json
```

## Safety model

- **Plan is read-only, enforced three times**: the network guard (`guard.ts`) refuses every non-read
  request (SoDEX writes, the relayer's `call_for_permit`/`analyse_address`, the backend's POSTs, any
  `eth_sendRawTransaction`, and both rate-limited history routes); the wallet has no signing policy; the
  app's trading config is `writesAllowed: false, disabled: true`.
- **Live needs every gate**: `--confirm` equal to the key's address, `"acknowledgeRealFunds": true`,
  the backend reporting mainnet with writes allowed, no blocking plan problems, and - by default - a
  **brand-new wallet** (no SoDEX account; `allowExistingAccount` to resume).
- **The key** comes only from `VS_E2E_KEY` (0x + 64 hex). It is removed from `process.env` at once,
  never printed or written; the wallet keeps it inside viem's account closure, scrubs it from every
  error, and the report is scrubbed again before it is written. Only the address is shown.
- **Only expected writes leave the process.** Each action arms the network guard with exactly the writes
  its app call makes. Every kind of write has its own guard kind and an exact body check: orders (account,
  market, side, type, time in force, price, quantity or funds, reduce-only, trigger and trigger type
  - the mark price, the only one SoDEX takes - the **modifier** SoDEX documents per case: NORMAL, STOP for a
  stand-alone TP/SL, BRACKET for an entry with exits and ATTACHED_STOP for each exit - and the builder),
  cancels (exactly these orders), replace and modify (exactly this order, exactly this change), leverage
  and margin mode, isolated margin, the dead-man switch (its time), transfers, the key registration and
  revocation, the builder approval (its exact maximum), withdrawal permits (**decoded**: coin, chain,
  receiver, amount, memo), deposit permits. Anything else gets a definite refusal (HTTP 403 / JSON-RPC
  error - never "maybe sent"). Unknown hosts are refused; ValueChain's explorer is read-only.
- **The wallet signs only what the step expects** (`provider.ts` policy): the exact USDC transfer to the
  verified deposit address, the key registration for this account, the builder approval with exactly
  this maximum (one), the key **revocation** - an `ExchangeAction` whose payload hash is exactly the
  revocation of this key, one per engine (a master-wallet `ExchangeAction` could carry any engine
  action, so the hash is the whole check) - the token permit + deposit command for this token and amount,
  the withdrawal permit for this coin/chain/receiver/amount. With no policy it refuses every signature.
- **Orders the runner signs itself** - the two cheating orders of the builder-tiers step, the orders
  naming a builder the wallet never approved (refusals) and the order signed with a revoked key
  (key-lifecycle) - stand in for a modified client. They are built with `@sodex-core` and the trading
  key, labelled `DIRECT` in the console and the report, and leave as the guard kind `direct-order`:
  exactly their bytes, once.
- **History reads**: SoDEX allows `/accounts/{a}/orders/history` and `/accounts/{a}/trades` together
  about four requests a minute per IP; the fifth blocks the IP (the owner's browser too) for a minute or
  more. Every read of them goes through ONE limiter (`history.ts`): one per 35 s over both routes and
  both engines, the time of the last read kept on disk, none while the run waits for the server's fee
  verifier, and the guard refuses any read that did not come through it. Order states and fills come
  from the wallet's account stream (`stream.ts`, the app's own `SodexSocket`, subscribe only); the
  history is read once, in `cross-check`: four requests.
- **Receivers**: only the wallet itself (`"self"`, EVM chains) or an entry of `receivers`. Every
  receiver is validated with the app's `receiverProblem` / `memoProblem` for its chain, checked against
  SoDEX's on-chain blacklist, before anything is signed.
- **The deposit address** is the backend's verified answer AND an independent `eth_call` of
  `getDepositWalletList(account, "USDC")` on the ValueChain registry `0x07E28Aa1BB34A625c94870476b24213AB4d2E7C8`
  (`wallets[i][0]`), decoded with viem. If they disagree, live refuses to start - and the address is
  re-checked right before the USDC is sent.
- **Budget**: `maxSpendUsd` caps what the wallet may **lose** - fees, gas, activation, trading costs
  AND value sent to addresses other than the wallet itself. Checked before every step (plan estimate +
  what the run already spent) and again against the on-chain withdrawal fee. Actual spend is measured
  per step from priced balances.
- **Exact amounts**: every amount is a decimal string in the coin's decimals; all maths is bigint.
- **A failed check does not stop the run; an unknown state does.** A check that fails without leaving
  anything unknown (an assertion, a refusal by the app or by SoDEX, a request the guard stopped) is
  recorded, its market is put back in order (orders cancelled, position closed) and the step goes on.
  A timeout, an unanswered write, or any failure of a funds move stops the run and prints **where every
  coin is** (Spot, Perps, ValueChain wallet, every EVM chain, open orders, positions, anything in flight)
  and how to recover it in the UI.

## What to fund (default config)

A **fresh** wallet (no SoDEX account), on **Arbitrum One**:

- **25 USDC** (native USDC `0xaf88...5831`) - the deposit
- **~0.0002 ETH** - gas for that one USDC transfer (the rest stays)

Nothing on ValueChain: the spot order step buys SOSO on SoDEX, and `spot-to-evm` moves it to the
ValueChain wallet as gas; wallet -> Spot deposits are gasless. Optional: set `receivers.valuechain` to
**another address you control** to test `withdraw-valuechain-other` (1 USDC leaves this wallet). `plan`
prints the exact checklist with live gas prices and what the wallet already holds.

## The steps

| Step | App code it runs | Checks |
|---|---|---|
| `preflight` (always) | `api.health`, `assetConfigs`, `usdcRoutes`, `sodexAccountId`, `balancesOf`, deposit options, `symbolFor`, `withdrawQuote`, `maintenanceFor`, `receiverBlacklisted`, the server's fee terms | - |
| `deposit-external` | `sendUsdcDeposit` (ONE ERC-20 transfer to the verified deposit address) | `deposit-usdc-<chain>` |
| `enable-trading` | `enableTrading` (ONE `UserSignedAddAPIKeyAction`; with a builder not yet approved, ONE `ApproveBuilderFeeAction` before it) | `key-enable`, `builder-approval` |
| `transfers` | `transferFunds` Spot->Perps, Perps->Spot | `transfer-spot-to-perps`, `transfer-perps-to-spot` |
| `builder-tiers` (builder + `termsKeys`) | the app's terms module, `placeOrder`, `submitBuilderApproval`, `revokeBuilderApproval`, `approveBuilderFee` | `builder-terms-signed`, `builder-terms-tamper-rejected`, `builder-fee-default`, `builder-volume-verified`, `builder-fee-lowered`, `builder-underpaid-not-counted`, `builder-no-builder-not-counted`, `builder-no-builder-flagged`, `builder-terms-back-to-default`, `builder-approval-enforced`, `builder-reapproved-orders-resume` |
| `orders-spot` | `placeOrder`, `changeOrder`, `cancelOrder`, `scheduleCancel` | `spot-limit-rest`, `-change-price`, `-change-size`, `-cancel`, `spot-market-buy-by-funds`, `-by-quantity`, `spot-market-sell`, `spot-gtx-rest`, `-cross`, `spot-ioc-no-cross`, `-cross`, `spot-fok-not-fillable`, `-fillable`, `spot-schedule-cancel`, `spot-fees-commission`, `spot-fees-builder`, `spot-end-clean`, `builder-spot-buy-not-charged`, `builder-replace-keeps-builder` |
| `orders-perps` | `setLeverage`, `placeOrder`, `adjustMargin`, `changeOrder`, `cancelOrder`, `cancelAll`, `scheduleCancel` | `perps-leverage-cross`, `-isolated`, `perps-market-by-quantity` (`-by-funds`: skipped - the ticket sizes perps by quantity), `perps-margin-add`, `-remove`, `perps-reduce-only-close`, `perps-limit-rest`/`-change-price`/`-change-size`/`-cancel`, `perps-gtx-rest`/`-cross`, `perps-ioc-no-cross`/`-cross`, `perps-position-stop-loss`, `-take-profit`, `perps-trigger-observed`, `perps-fok-*`, `perps-entry-with-tp-sl`, `perps-cancel-all`, `perps-schedule-cancel-clear`, `-fires`, `perps-fees-commission`, `perps-fees-builder`, `perps-end-flat`, `builder-modify-keeps-builder`, `builder-replace-keeps-builder` |
| `refusals` | `placeOrder`, `transferFunds`, `withdrawFunds` (each must refuse before signing), orders SoDEX must refuse | `refuse-*` (16) |
| `spot-to-evm` | `transferFunds` Spot->EVM | `transfer-spot-to-evm-usdc`, `-soso` |
| `evm-to-spot` | `transferFunds` EVM->Spot (gasless: token permit + CallForPermit, relayed) | `transfer-evm-to-spot` |
| `withdraw-valuechain-self` | `withdrawFunds` route `VALUECHAIN`, receiver = wallet | `withdraw-valuechain-self` |
| `withdraw-valuechain-other` | `withdrawFunds` route `VALUECHAIN`, receiver = `receivers.valuechain` (skipped if unset) | `withdraw-valuechain-other` |
| `withdraw-external` | `withdrawQuote`, `withdrawFunds` with `expectedFee`, `withdrawalProgress` | `withdraw-<coin>-<chain>` |
| `extra-deposits` / `extra-withdrawals` | as above, per entry (`buyIfMissing` market-buys the coin first) | `deposit-*`, `withdraw-*` |
| `key-lifecycle` | `restoreTrading`, `keyStillRegistered`, `disableTrading({ revoke: true })`, `enableTrading` | `key-restore`, `key-still-registered`, `key-disable-revoke`, `key-old-key-rejected`, `key-reenable` |
| `cleanup` (opt-in) | `transferFunds`, `withdrawFunds` | `cleanup-sweep` |
| `cross-check` | reads only: order history and fills (four requests), the builder account's balances | `cross-orders-*`, `cross-fills-*`, `cross-stream-vs-rest`, `cross-end-state`, `builder-order-records`, `builder-income-matches` |
| `revoke-builder` (only with `builder.revokeAtEnd`) | `revokeBuilderApproval` (ONE signature, `maxFeeRate` 0) | `builder-revoke` |

`npx tsx e2e/live/run.ts capabilities` prints every check with its title and step.

Every fill of the run is judged: its commission against the account's own maker / taker rate (a spot buy
pays in the base coin), its `builderFee` against the notional x the fee the ORDER carried (both sides on
perps, spot sells only, nothing without a builder). The report's `feeTable` has one row per fill.

## The builder fee and its tiers

With `"builder": null` (the default) no builder is approved, read or attached, and every builder check
is `skipped`. To test the Valuescan builder fee (docs/BUILDER-CODES.md, docs/BUILDER-TIERS.md):

```json
"builder": { "id": 12345, "address": "0x...", "feePerps": 20, "feeSpot": 20, "maxFee": 20, "required": true, "revokeAtEnd": true,
             "termsKeys": ["<the server's terms public key, base64url of the raw 32 bytes>"] }
```

- `id` is the builder's SoDEX account id, `address` its wallet ADDRESS (public - never a key; with it the
  cross-check reconciles the builder account's income with the fills' `builderFee`s).
- `required` (default true): a build with a builder requires the approval (G1).
- `termsKeys`: the public keys the server's fee terms are signed with (`tools/builderTiers.ts status` in
  `apps/server` prints it). With them `builder-tiers` runs section 8 of the contract: the default fee on
  the first orders, more than the milestone's volume, a hint, a bounded wait (`timeouts.verifierMinutes`)
  until the server signs the lower fee, an order at the lower fee and its fill, then two **cheating
  orders** the runner signs itself (a lower fee than owed, and no builder - neither may be credited, the
  wallet must be flagged `underpaid`, and `tampered` / `no-builder` for the builder-less one), the terms
  back on the default fee, the approval lowered below the fee owed and then revoked (the app must send
  nothing), and approved again. The runner verifies every terms answer itself (`terms.ts`, node:crypto,
  against the shared vector `apps/server/test/builderTerms.vector.json`), and the guard lets an order
  carry a fee below the default only while a statement the runner has seen verify is in force.
- **Once per wallet.** The default fee can only be shown on a wallet the server has not credited yet,
  and a wallet flagged `underpaid` stays on the default fee. To run the tier test again with the same
  wallet, reset it on the server first: `npx tsx tools/builderTiers.ts forget --address <wallet>` (in
  `apps/server`). The plan warns when a wallet is already below the default or flagged.
- **G6** (does a changed order keep its builder?): the app changes a resting limit order as cancel + new
  order while `REPLACE_KEEPS_BUILDER` is false. To observe SoDEX's own replace, ONE replace per engine is
  made by the app with its builder set to OPTIONAL for exactly that call (said so in the console); the
  verdict names the constant to flip. The same for modify.

## What it costs (default config, as of the plan run)

| Item | Cost |
|---|---|
| Account activation (first deposit) | 1 USDC |
| USDC withdrawal to Arbitrum | 1 USDC (on-chain fee; the plan reads it live) |
| ETH withdrawal to Arbitrum | 0.0005 ETH (~$1.35) |
| Trading (about 10 perps fills of ~$12 at 0.04 %, a few spot fills of ~$1, spreads; with a builder: + 2 bp) | ~$0.10 |
| Gas: Arbitrum USDC transfer | ~$0.01; ValueChain: negligible |
| Optional cleanup withdrawal | +1 USDC |
| **Total** | **~$3.5** (+$1 with cleanup) + anything sent to your other address |

## Coverage policy - one run per chain

The deposit/withdraw mechanism is **per chain**: all coins on one chain share the wallet's deposit
address and SoDEX's custody path there. One run per chain you care about (Arbitrum is the default); for
another EVM chain change `deposit.chain`, `withdrawExternal.chain` and the `extraWithdrawals` entry.
`plan` prints the live **per-chain table** (USDC and the native coin per chain: deposit minimum,
withdrawal minimum and fee, what the runner can do there); the report's `chains` has the same rows with
what this run did on each.

## Resuming

The trading key lives in memory, so every run registers a fresh one (one signature, no funds) when a
step needs it. To resume after a stop, fix the cause, then e.g.
`--only withdraw-external,extra-withdrawals` with `"allowExistingAccount": true`. Each step moves its
configured amount **again** when re-run - check the report first. `cross-check` reconciles only what
the same process sent.

## If it stops

The console and the report end with **where every coin is** and anything **in flight**. Recover in the
app (connect the same wallet):

- Perps -> Spot: Transfer sheet. Spot -> a wallet on any chain: Withdraw sheet.
- ValueChain wallet -> Spot: Deposit -> "Transfer from ValueChain".
- Open orders / positions: trade page tabs.
- A deposit in flight: SoDEX credits it when custody sees it - nothing to resend.
- A withdrawal in flight: its SoDEX record decides; a failed one paid from Spot returns to Spot.

## Reading the report

`e2e/live/reports/<ISO time>-<mode>.json`:

- `checks[]` - every check: `id`, `area`, `title`, `step`, `status`, `detail`, `evidence`, `costUsd`;
  `checkCounts` - how many of each.
- `chains[]` - per coin and chain SoDEX lists: `deposit` and `withdraw` `{ status, detail }`
  (`not-testable` with the reason where the runner cannot act).
- `orderTypes[]` - the order checks with their engine. `feeTable[]` - one row per fill.
- `plan` - problems/warnings, funding checklist, per-chain route table, markets, deposit-address check,
  `receiversNeeded`, the server's fee terms as judged, per-step plan lines and estimates.
- `steps[]` - per step: `status`, timings, `subSteps[]`, `txs[]`, `amounts`, `fees`, `measured`, the
  counts of its checks.
- `orders[]` / `fills[]` - the run's book: every order that left (with what SoDEX answered and what its
  records said) and every fill; `termsSeen[]`, `historyReads[]`, `stream`.
- `spend`, `snapshots`, `whereFunds`, `inFlight`; `network.requests` / `network.refused` (bodies are
  never stored); `walletRefusals`; `appLog`.

## Files and tests

| File | |
|---|---|
| `run.ts` | CLI entry: arguments, key, gates, `capabilities`; loads `runner.ts` |
| `runner.ts` | configures the app's trading layer for Node, guard, wallet, stream, preflight, steps, report |
| `checks.ts` | every check: id, area, title, step; the run's verdicts |
| `steps.ts` | the funds steps and the table of all steps |
| `orders.ts`, `orderSteps.ts` | placing and judging orders; the spot and perps order steps |
| `tierSteps.ts`, `terms.ts` | the builder fee and its tiers; the runner's own terms verifier |
| `refusalSteps.ts`, `keySteps.ts`, `crossCheck.ts` | refusals, the key's life, the final reconciliation |
| `trading.ts` | the key registration / revocation and the builder approval, with their guard checks and wallet policies |
| `fees.ts`, `ledger.ts`, `stream.ts`, `history.ts` | fill fees, the run's book, the account stream, the history limiter |
| `app.ts` | the seam to the app's builder-fee side and its change-order function |
| `coverage.ts` | every exported function of the app's trading layer, mapped to checks |
| `provider.ts`, `guard.ts`, `plan.ts`, `reads.ts`, `context.ts`, `config.ts`, `util.ts` | wallet, network guard, preflight, reads, step context, config, exact decimals |
| `sim/world.ts` | the offline fake of SoDEX, its stream, the backend (with the terms route), the relayer and the chains |

Offline tests (no network, no keys that matter):

```
npx tsx --test e2e/live/*.test.ts
npx tsc --noEmit -p e2e/live
```

`simulate.test.ts` runs **whole live runs** against `sim/world.ts` - under the real guard, wallet and app
code: every step and check of the default config, the builder fee and its tiers end to end (the terms
route signs with the shared test key, its volume counted from the fake's own fills), a fake whose
replace keeps the builder (the run reports the constant to flip), and the start-up refusals. The fake
verifies every signature with viem and rejects what SoDEX rejects (an unapproved builder, a revoked
key, FOK, a market order below the minimum notional, reduce-only with no position). It cannot prove
that SoDEX behaves like the fake. `safety.test.ts` has a refusal test for every guard kind and wallet
policy; `units.test.ts` covers checks, fees, the history limiter, the terms verifier, the ledger, the
receivers and the coverage table.

## Notes

- The trading key is registered under the app's name for desktop browsers, `valuescan-web`; SoDEX
  replaces a key of the same name, so a browser session of the **same wallet** loses its key (enable
  again there). `key-lifecycle` revokes the runner's key and registers a new one.
- `plan` (without `--registry-only`) asks the backend for the wallet's deposit options, which asks
  SoDEX to issue deposit addresses for it - the same as opening the app's Deposit sheet; no funds move.
- Custody withdrawals send the receiver address to SoDEX's address risk check (`analyse_address`),
  exactly as the app and sodex.com do.
