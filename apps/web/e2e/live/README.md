# Live E2E runner - ValueDesk money flows on SoDEX mainnet

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
| `capabilities` | prints, as ONE JSON line: `steps`, `stepTitles`, `aliases`, `profiles` and `profileInfo` (each profile's title and steps), `routeKinds` (the per-route check ids and the steps that declare them), `chains` (the EVM chains the runner signs on), `flags`, every check, and the coverage table (`coverage.ts`); no key, no network |
| `--config <file>` | the run's config (`config.example.json` documents every field). Required for `live` |
| `--profile <name>` | what the run covers: `core` (default), `evm-tour`, `all-chains`, `builder-rerun` - see [Profiles](#profiles) |
| `--confirm <address>` | `live`: must equal the address `VS_E2E_KEY` controls |
| `--only a,b` | run only these steps (preflight always runs); `orders` = `orders-spot,orders-perps` |
| `--throwaway-key` | `plan` only: a random in-memory key instead of `VS_E2E_KEY` |
| `--registry-only` | `plan` only: read deposit addresses from the on-chain registry alone - does not ask the backend, which asks SoDEX to *issue* addresses for a wallet that has none |
| `--backend <origin>` | override `config.backend` |
| `--report-dir <dir>` | where the JSON report goes (default `e2e/live/reports/`) |

Exit codes: `0` done and no check failed (plan: a live run would start), `1` a step stopped the run or a
check failed (live), `2` refused to start (config, key, gates, or plan problems - nothing was signed or
sent), `130` interrupted. The last console lines are `summary  <file>.summary.md` and `report   <file>`.

Add to `.gitignore` (not done by the runner):

```
apps/web/e2e/live/reports/
apps/web/e2e/live/config.json
```

## Profiles

| Profile | Steps | What it adds |
|---|---|---|
| `core` (default) | every step but the three below | one chain (the deposit chain): deposit, transfers, every order type, every way out, the key's life, the refusals, the builder fee and its tiers, the cross-check |
| `evm-tour` | core + `evm-tour` | every EVM chain the runner signs on, out and back: the chain's native coin (withdrawn to this wallet, then sent back to the verified deposit address by a plain transfer the runner signs - DIRECT), then USDC (withdrawn, sent back with the app's `sendUsdcDeposit`) |
| `all-chains` | evm-tour + `chain-withdrawals`, `manual-deposits` | per route on a chain the runner cannot sign on (Solana, Bitcoin, XRP ...): a withdrawal to YOUR address there (`receivers.<chain key in lower case>`; skipped without it), and the deposits you opt into sending by hand (`manualDeposits`) - the run shows the verified address and waits for the credit |
| `builder-rerun` | `enable-trading`, `builder-tiers`, `cross-check`, `revoke-builder` | the builder fee test alone, again, on the funded test wallet of an earlier run (it sets `allowExistingAccount`); first `npx tsx tools/builderTiers.ts forget --address <wallet>` in `apps/server` |

`--only` still decides alone: with it, exactly the steps it names run. A profile's changes to the config
are printed (`profile ...:` lines, and `plan.profileNotes`): `evm-tour` / `all-chains` raise
`deposit.amount` by what their steps need in Spot at their busiest (working capital - it comes back, or
leaves to your own addresses). No profile creates or funds a builder account: that is the owner's own,
existing account, which the runner only reads (by `builder.address` and `builder.id`).

**Every plan, every profile** checks every route read-only (`route-<coin>-<chain>`, recorded in plan mode
too): open or closed, minimum and fee as configured and as the chain charges it (a difference, or a
minimum that does not cover the fee, is a finding), SoDEX's maintenance switch, the wallet's deposit
address there (well-formed for its format; the app's Deposit sheet and the registry agree), and the app's
own receiver check for that chain (a well-formed address accepted, every malformed one refused; XRP /
Stellar memo rules). It prints a suggested `maxSpendUsd` and the list of what **no run can test
automatically**, with why (`plan.notTestable`).

The EVM chains the app does not send from (Arc 5042, Avalanche C-Chain 43114, HyperEVM 999, Robinhood
Chain 4663) get their chain id and public RPC from `chains.ts` (each from the chain's own documentation):
the runner reads a withdrawal's arrival there and sends the native-coin deposit back. Polygon has no
native route on SoDEX: the plan asks you for a little POL for the USDC transfer back.

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
  receiver, amount, memo), deposit permits, and the evm-tour's native-coin transfer (`native-transfer`:
  the raw transaction is **decoded** and its signer recovered - exactly this chain, signer, deposit
  address and value, no calldata, once; native value into a contract is never sent, nor a transfer in a
  batch). Anything else gets a definite refusal (HTTP 403 / JSON-RPC error - never "maybe sent"). Unknown
  hosts are refused; ValueChain's explorer is read-only.
- **The wallet signs only what the step expects** (`provider.ts` policy): the exact USDC transfer to the
  verified deposit address, the key registration for this account, the builder approval with exactly
  this maximum (one), the key **revocation** - an `ExchangeAction` whose payload hash is exactly the
  revocation of this key, one per engine (a master-wallet `ExchangeAction` could carry any engine
  action, so the hash is the whole check) - the token permit + deposit command for this token and amount,
  the withdrawal permit for this coin/chain/receiver/amount, the ONE plain native-coin transfer of this
  value to the verified deposit address on this chain. With no policy it refuses every signature.
- **Orders the runner signs itself** - the two cheating orders of the builder-tiers step, the orders
  naming a builder the wallet never approved (refusals) and the order signed with a revoked key
  (key-lifecycle) - stand in for a modified client. They are built with `@sodex-core` and the trading
  key, labelled `DIRECT` in the console and the report, and leave as the guard kind `direct-order`:
  exactly their bytes, once.
- **The native-coin deposit back** (evm-tour) is the other thing the runner sends itself, because the app
  has no function for it (its Deposit sheet only shows the address): labelled `DIRECT`, only to the
  address the app's Deposit sheet offers AND the per-coin registry lists, through the app's own
  `addOrSwitchChain` / `sendTransaction`.
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
- **The deposit address** is the app's verified answer (its Deposit sheet's `depositOptions`) AND an
  independent `eth_call` of `getDepositWalletList(account, coin)` on the ValueChain registry
  `0x07E28Aa1BB34A625c94870476b24213AB4d2E7C8` (`wallets[i][0]`), decoded with viem - for USDC and for every
  coin the run deposits or asks you to deposit. If they disagree, nothing is sent (live refuses to start for
  the USDC deposit) - and the address is re-checked right before anything is sent.
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
| `preflight` (always) | `api.health`, `assetConfigs`, `usdcRoutes`, `sodexAccountId`, `balancesOf`, deposit options, `symbolFor`, `withdrawQuote`, `maintenanceFor`, `receiverBlacklisted`, `receiverProblem`, `memoProblem`, the server's fee terms | `route-<coin>-<chain>` for every route |
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
| `evm-tour` (evm-tour, all-chains) | per EVM chain: `placeOrder` (buys the native coin if Spot holds too little), `withdrawFunds` to this wallet, a DIRECT native transfer back (`addOrSwitchChain`, `sendTransaction`); then `withdrawFunds` + `sendUsdcDeposit` for USDC; sells what it bought back | `withdraw-<coin>-<chain>`, `deposit-<coin>-<chain>` per leg |
| `chain-withdrawals` (all-chains) | `withdrawQuote`, `placeOrder` (buys the coin), `withdrawFunds` to `receivers.<chain>` - the smallest amount you could send straight back | `withdraw-<coin>-<chain>` |
| `manual-deposits` (all-chains, opt-in) | the app's deposit options vs the registry; then it waits for Spot | `manual-deposit-<coin>-<chain>` |
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
is `skipped`. To test the ValueDesk builder fee (docs/BUILDER-CODES.md, docs/BUILDER-TIERS.md):

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
- **G6** (does a changed order keep its builder?): the app changes a resting limit order with SoDEX's
  replace (`REPLACE_KEEPS_BUILDER` is true - proven live on 2026-10-03) and the run checks that the
  replacement's record still names the builder. Were the constant false, the app would change the order as
  cancel + new order, and ONE replace per engine would be made with the builder OPTIONAL for exactly that
  call to observe SoDEX's own replace. Either way the verdict names the constant to flip. The same for modify.

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

Per profile (read-only plans of 2026-10-03 with a fresh wallet; `plan --profile <name>` prints the exact
figures and a suggested `maxSpendUsd`):

| Profile | Fund | Estimated cost | Suggested `maxSpendUsd` |
|---|---|---|---|
| `core` | 25 USDC + ~0.0002 ETH on Arbitrum One | ~$3.5 | 8 |
| `evm-tour` | ~83 USDC + ~0.0002 ETH on Arbitrum One (the deposit is raised to the tour's working capital, which comes back), ~0.2 POL on Polygon | ~$23: a withdrawal fee per leg (ETH 0.0005 x4, BNB 0.002, AVAX 0.12, HYPE 0.03, USDC 1 x5), gas, spreads | ~32 |
| `all-chains` | as `evm-tour`, plus what the chain withdrawals send to YOUR addresses (each the smallest you could send back: e.g. 0.042 SOL, 4.8 XRP, 0.0005 BTC) - the plan raises the deposit by it | + their fees | from the plan |
| `builder-rerun` | nothing: the funded test wallet of an earlier run (~10 USDC in Spot or Perps) | ~$1-2 | 8 |

## Coverage per chain

The deposit/withdraw mechanism is **per chain**: all coins on one chain share the wallet's deposit
address and SoDEX's custody path there. `core` covers the deposit chain (Arbitrum by default), `evm-tour`
every EVM chain the runner signs on, `all-chains` also the others as far as they can be reached from
here. `plan` prints the live **per-chain table** (USDC and the native coin per chain: deposit minimum,
withdrawal minimum and fee, what the runner can do there) and the route checks; the report's `chains` has
the same rows with what this run did on each.

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

`e2e/live/reports/<ISO time>-<mode>.summary.md` is the run in words, built from the report alone. The
builder fee comes first - every builder check in the order of `docs/BUILDER-TIERS.md` section 8, the fee
the server signed as it changed, the flags it set, and under it the fee of every fill (the section's
heading names fees, so the guided launcher shows it as the runner's fee table). Then the failed checks,
the findings (a withdrawal minimum that does not cover the fee is spelled out: what a user who tries it
runs into), the chains (deposit, withdrawal and route check per coin and chain, every chain leg, what
cannot be tested and why), the order types, the trading key, the refusals, transfers and withdrawals,
the cross-check, the cost per step against `maxSpendUsd`, and where every coin is. Plan mode writes one
too (every check that needs a live run reads "not run").

`e2e/live/reports/<ISO time>-<mode>.json`:

- `checks[]` - every check: `id`, `area`, `title`, `step`, `status`, `detail`, `evidence`, `costUsd`;
  `checkCounts` - how many of each.
- `profile`; `chains[]` - per coin and chain SoDEX lists: `deposit`, `withdraw` and `route` (its
  read-only route check) `{ status, detail }` (`not-testable` with the reason where the runner cannot act).
- `orderTypes[]` - the order checks with their engine. `feeTable[]` - one row per fill.
- `plan` - problems/warnings, funding checklist, per-chain route table, `routeChecks`, `notTestable`,
  `profileNotes`, `suggestedMaxSpendUsd`, markets, deposit-address check, `receiversNeeded`, the server's
  fee terms as judged, per-step plan lines and estimates.
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
| `profiles.ts` | the profiles: their steps and what they change in the config |
| `chains.ts` | every EVM chain the runner reads and signs on (the app's, plus Arc, Avalanche, HyperEVM, Robinhood) |
| `tour.ts`, `evmTour.ts` | the evm-tour: its legs, amounts and the native transfer's guard check and wallet policy; the step |
| `chainRoutes.ts`, `otherChains.ts` | the routes on chains the runner cannot sign on; chain-withdrawals and manual-deposits |
| `routes.ts`, `receivers.ts` | the read-only check of every route and what cannot be tested; the receiver samples |
| `summary.ts` | `<report>.summary.md`: the builder fee first, then failures, findings, chains, orders, the key, refusals, funds, cost, the coins |
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
replace keeps the builder (the run reports the constant to flip), the start-up refusals, the evm-tour
over nine EVM chains (native coins sent back by the runner, USDC with the app; 18-decimal USDC on BNB
Chain and Arc), all-chains (withdrawals to Solana, XRP without memo, Bitcoin; a manual deposit),
builder-rerun, and a read-only all-chains plan. The fake
verifies every signature with viem and rejects what SoDEX rejects (an unapproved builder, a revoked
key, FOK, a market order below the minimum notional, reduce-only with no position). It cannot prove
that SoDEX behaves like the fake. `safety.test.ts` has a refusal test for every guard kind and wallet
policy (the native transfer's included); `units.test.ts` covers checks, fees, the history limiter, the
terms verifier, the ledger, the receivers, the coverage table, the profiles, the tour's legs and amounts,
the chain withdrawals and what cannot be tested, the summary and `capabilities`.

## Notes

- The trading key is registered under the app's name for desktop browsers, `valuescan-web`; SoDEX
  replaces a key of the same name, so a browser session of the **same wallet** loses its key (enable
  again there). `key-lifecycle` revokes the runner's key and registers a new one.
- `plan` (without `--registry-only`) asks the backend for the wallet's deposit options, which asks
  SoDEX to issue deposit addresses for it - the same as opening the app's Deposit sheet; no funds move.
- Custody withdrawals send the receiver address to SoDEX's address risk check (`analyse_address`),
  exactly as the app and sodex.com do.
